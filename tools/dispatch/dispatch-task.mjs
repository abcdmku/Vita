#!/usr/bin/env node
// Dispatch ONE task contract to a GPT-5.5 (xhigh) grunt worker via the Codex CLI.
// Usage: npm run dispatch -- <task-id>
//
// The worker runs in an ISOLATED git worktree (.vita-worktrees/<id>) on branch task/<id>, so a
// background dispatch never touches main's working tree — no branch-checkout races with foreground
// git. It does NOT integrate: it commits the worker's diff to task/<id>, runs the acceptance
// command, writes <id>.result.json, and tears the worktree down (the branch persists). The
// orchestrator (Claude) verifies and integrates by risk class from the main tree.
import { spawnSync } from "node:child_process";
import { writeFileSync, existsSync, copyFileSync } from "node:fs";
import { join } from "node:path";
import os from "node:os";
import { REPO, QUEUE, TASK_DIR, listContracts, isProtected } from "../lib/contracts.mjs";
import { workerAuth, AUTH_HELP } from "./check-auth.mjs";

const MODEL = process.env.VITA_WORKER_MODEL || "gpt-5.5";
const EFFORT = process.env.VITA_WORKER_EFFORT || "xhigh";

const id = process.argv[2];
if (!id) {
  console.error("usage: npm run dispatch -- <task-id>");
  process.exit(2);
}

const c = listContracts(QUEUE).find((x) => x.id === id);
if (!c) {
  console.error(`No contract "${id}" in ai-factory/task-contracts/queue/`);
  process.exit(2);
}
if (c.status !== "ready") {
  console.error(`Contract ${id} status is "${c.status}", not "ready". Mark it ready first.`);
  process.exit(2);
}

const offending = (c.target_paths || []).filter(isProtected);
if (offending.length) {
  console.error(`Refusing: target_paths intersect protected paths: ${offending.join(", ")}`);
  process.exit(3);
}

const auth = workerAuth();
if (!auth.ok) {
  console.error(AUTH_HELP + `\nThen re-run: npm run dispatch -- ${id}`);
  process.exit(4);
}

const git = (args, opts = {}) => spawnSync("git", args, { cwd: REPO, encoding: "utf8", ...opts });
const branch = `task/${id}`;
const wt = join(REPO, ".vita-worktrees", id);

// Fresh isolated worktree branched from current main HEAD (so the worker sees prior merged work).
git(["worktree", "remove", "--force", wt]); // ignore failure if absent
git(["worktree", "prune"]);
const add = git(["worktree", "add", "--force", "-B", branch, wt, "HEAD"], { stdio: "inherit" });
if (add.status !== 0) {
  console.error(`Could not create worktree at ${wt} for ${branch}.`);
  process.exit(5);
}
const gitWt = (args, opts = {}) => spawnSync("git", args, { cwd: wt, encoding: "utf8", ...opts });

const prompt = [
  "You are a Vita grunt worker. Read AGENTS.md in this repo and follow it strictly.",
  "Implement EXACTLY the task contract below. Make its acceptance command pass.",
  "Stay within the contract's target_paths. Touch NO protected paths. Do not weaken tests.",
  "",
  `=== TASK CONTRACT ${c.id} ===`,
  c.raw,
  "=== END CONTRACT ===",
  "",
  `When finished, this must pass:  ${c.acceptance_command}`,
  "Then emit the structured final report described in AGENTS.md §5.",
].join("\n");

// Worker report -> a sandbox-writable temp file (codex workspace-write allows workdir + $TMPDIR),
// copied back into the (gitignored) task-contracts dir afterward for the record.
const reportTmp = join(os.tmpdir(), `vita-${id}.worker.md`);
const workerReport = join(TASK_DIR, `${id}.worker.md`);
console.log(`\nDispatching ${id} → ${MODEL} (effort=${EFFORT}) in worktree ${wt} …\n`);

// Codex CLI is an npm-installed shim. On Windows it is `codex.cmd`, which Node can only launch via
// the shell; elsewhere `codex` is directly executable. The prompt is passed on STDIN (not as a
// positional arg) so the command line contains no untrusted content — safe under shell:true. The
// `-c` values are bare (no inner quotes): Codex treats unparseable TOML as a literal string.
const isWin = process.platform === "win32";
const run = spawnSync(
  isWin ? "codex.cmd" : "codex",
  [
    "exec",
    "-m", MODEL,
    "-c", `model_reasoning_effort=${EFFORT}`,
    "-c", "approval_policy=never",
    "-s", "workspace-write",
    "-C", wt,
    "--skip-git-repo-check",
    "-o", reportTmp,
  ],
  {
    cwd: wt,
    input: prompt,
    encoding: "utf8",
    stdio: ["pipe", "inherit", "inherit"],
    shell: isWin,
    maxBuffer: 64 * 1024 * 1024,
  },
);
if (run.error) console.error(`codex spawn error: ${run.error.message}`);

let reportPath = null;
if (existsSync(reportTmp)) {
  try {
    copyFileSync(reportTmp, workerReport);
    reportPath = workerReport;
  } catch {
    /* report is best-effort */
  }
}

// Commit the worker's diff to the task branch (inside the worktree).
gitWt(["add", "-A"]);
const hasChanges = gitWt(["diff", "--cached", "--quiet"]).status !== 0;
if (hasChanges) {
  gitWt([
    "commit",
    "-m",
    `task(${id}): ${c.title}\n\nWorker: ${MODEL} effort=${EFFORT}\nContract: ai-factory/task-contracts/queue/${id}.md`,
  ]);
}

console.log(`\nRunning acceptance:  ${c.acceptance_command}\n`);
const acc = spawnSync(c.acceptance_command, {
  cwd: wt,
  shell: true,
  encoding: "utf8",
  stdio: "inherit",
});
const passed = acc.status === 0;

// Tear down the worktree; the branch task/<id> persists as the audit trail + integration source.
git(["worktree", "remove", "--force", wt]);
git(["worktree", "prune"]);

const result = {
  id,
  title: c.title,
  risk_class: c.risk_class,
  branch,
  model: MODEL,
  effort: EFFORT,
  has_changes: hasChanges,
  codex_status: run.status,
  codex_error: run.error ? run.error.message : null,
  acceptance_command: c.acceptance_command,
  acceptance_status: acc.status,
  passed,
  worker_report: reportPath,
};
writeFileSync(join(TASK_DIR, `${id}.result.json`), JSON.stringify(result, null, 2) + "\n");

console.log(
  `\n${passed ? "PASS" : "FAIL"} — ${id}. ` +
    `Result: ai-factory/task-contracts/${id}.result.json (branch ${branch})\n` +
    `Orchestrator: verify independently from main, then integrate by risk class (${c.risk_class}).`,
);
process.exit(passed ? 0 : 1);
