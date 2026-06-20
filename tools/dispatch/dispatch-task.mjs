#!/usr/bin/env node
// Dispatch ONE task contract to a GPT-5.5 (xhigh) grunt worker via the Codex CLI.
// Usage: npm run dispatch -- <task-id>
//
// It does NOT integrate. It runs the worker on branch task/<id>, runs the acceptance
// command, commits the worker's diff to that branch, writes <id>.result.json, and returns
// to the original branch. The orchestrator (Claude) verifies and integrates by risk class.
import { spawnSync } from "node:child_process";
import { writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
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

const git = (args, opts = {}) =>
  spawnSync("git", args, { cwd: REPO, encoding: "utf8", ...opts });

const original = git(["rev-parse", "--abbrev-ref", "HEAD"]).stdout.trim() || "main";
const branch = `task/${id}`;
git(["branch", "-f", branch]); // (re)point branch at current HEAD
const co = git(["checkout", branch], { stdio: "inherit" });
if (co.status !== 0) {
  console.error(`Could not checkout ${branch}.`);
  process.exit(5);
}

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

const workerReport = join(TASK_DIR, `${id}.worker.md`);
console.log(`\nDispatching ${id} → ${MODEL} (effort=${EFFORT}) on ${branch} …\n`);

// Codex CLI is an npm-installed shim. On Windows it is `codex.cmd`, which Node can only launch
// via the shell; elsewhere `codex` is directly executable. The prompt is passed on STDIN (not as a
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
    "-C", REPO,
    "--skip-git-repo-check",
    "-o", workerReport,
  ],
  {
    cwd: REPO,
    input: prompt,
    encoding: "utf8",
    stdio: ["pipe", "inherit", "inherit"],
    shell: isWin,
    maxBuffer: 64 * 1024 * 1024,
  },
);
if (run.error) console.error(`codex spawn error: ${run.error.message}`);

// Capture whatever the worker produced onto the task branch.
git(["add", "-A"]);
const hasChanges = git(["diff", "--cached", "--quiet"]).status !== 0;
if (hasChanges) {
  git([
    "commit",
    "-m",
    `task(${id}): ${c.title}\n\nWorker: ${MODEL} effort=${EFFORT}\nContract: ai-factory/task-contracts/queue/${id}.md`,
  ]);
}

console.log(`\nRunning acceptance:  ${c.acceptance_command}\n`);
const acc = spawnSync(c.acceptance_command, {
  cwd: REPO,
  shell: true,
  encoding: "utf8",
  stdio: "inherit",
});
const passed = acc.status === 0;

git(["checkout", original], { stdio: "inherit" });

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
  worker_report: existsSync(workerReport) ? workerReport : null,
};
writeFileSync(join(TASK_DIR, `${id}.result.json`), JSON.stringify(result, null, 2) + "\n");

console.log(
  `\n${passed ? "PASS" : "FAIL"} — ${id}. ` +
    `Result: ai-factory/task-contracts/${id}.result.json\n` +
    `Orchestrator: verify independently, then integrate by risk class (${c.risk_class}).`,
);
process.exit(passed ? 0 : 1);
