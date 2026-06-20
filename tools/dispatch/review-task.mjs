#!/usr/bin/env node
// Consult a GPT-5.5 (xhigh) INDEPENDENT reviewer on a completed task branch before merging.
// Required for R2/R3/R4 (owner directive 2026-06-20). Usage: npm run review -- <task-id>
//
// Reviews the changes introduced by branch task/<id> via `codex exec review --commit <sha>`
// (read-only — the reviewer cannot modify the repo), captures the review to <id>.review.md, extracts
// the final VERDICT line, and writes <id>.review.json {decision}. The orchestrator gates the merge
// on the verdict (approve required) in addition to its own independent verification.
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { REPO, QUEUE, DONE, TASK_DIR, listContracts } from "../lib/contracts.mjs";
import { workerAuth, AUTH_HELP } from "./check-auth.mjs";

const MODEL = process.env.VITA_WORKER_MODEL || "gpt-5.5";
const EFFORT = process.env.VITA_WORKER_EFFORT || "xhigh";

const id = process.argv[2];
if (!id) {
  console.error("usage: npm run review -- <task-id>");
  process.exit(2);
}

const c = [...listContracts(QUEUE), ...listContracts(DONE)].find((x) => x.id === id);
if (!c) {
  console.error(`No contract "${id}" in queue/ or done/.`);
  process.exit(2);
}

const auth = workerAuth();
if (!auth.ok) {
  console.error(AUTH_HELP);
  process.exit(4);
}

const branch = `task/${id}`;
const sha = spawnSync("git", ["rev-parse", "--verify", branch], { cwd: REPO, encoding: "utf8" }).stdout.trim();
if (!sha) {
  console.error(`Branch ${branch} not found — dispatch the task first.`);
  process.exit(2);
}

const instructions = [
  "You are an INDEPENDENT senior reviewer for the Vita project (a TypeScript-first personal Node OS).",
  "Review ONLY the changes in the target commit, for merge into main. You did not write this code.",
  "Judge against: the task contract below, AGENTS.md, ai-factory/evaluation/rubric.md, and the product",
  "spec (typescript_personal_node_os_build_spec.md). This is a higher-risk (R2+) change — hold a high bar.",
  "Be adversarial about: correctness; scope creep beyond the contract's target_paths; security and",
  "privileged surface (Go agent, boot, storage, identity, signing, permission broker); determinism and",
  "reproducibility; and TEST INTEGRITY — reject any weakened, deleted, skipped, or gamed test.",
  "",
  "Output a concise review with two sections: BLOCKING (must fix before merge) and NOTES (non-blocking).",
  "Then end with EXACTLY one final line and nothing after it:",
  "  VERDICT: approve   (no blocking findings — safe to merge)",
  "  VERDICT: revise    (mergeable only after the blocking findings are fixed)",
  "  VERDICT: reject    (fundamentally wrong approach)",
  "",
  `=== TASK CONTRACT ${id} ===`,
  c.raw,
  "=== END CONTRACT ===",
].join("\n");

console.log(`\nConsulting reviewer ${MODEL} (effort=${EFFORT}) on ${branch} (${sha.slice(0, 9)}) …\n`);
const isWin = process.platform === "win32";
const run = spawnSync(
  isWin ? "codex.cmd" : "codex",
  [
    "exec",
    "-m", MODEL,
    "-c", `model_reasoning_effort=${EFFORT}`,
    "-c", "approval_policy=never",
    "-s", "read-only",
    "-C", REPO,
    "--skip-git-repo-check",
    "review",
    "--commit", sha,
    "-",
  ],
  {
    cwd: REPO,
    input: instructions,
    encoding: "utf8",
    stdio: ["pipe", "pipe", "inherit"],
    shell: isWin,
    maxBuffer: 64 * 1024 * 1024,
  },
);
if (run.error) console.error(`codex spawn error: ${run.error.message}`);

const reviewText = run.stdout || "";
const reviewFile = join(TASK_DIR, `${id}.review.md`);
writeFileSync(reviewFile, reviewText);

const m = reviewText.match(/VERDICT:\s*(approve|revise|reject)/i);
// Fail safe: no explicit approval => do NOT merge.
const decision = m ? m[1].toLowerCase() : "revise";
writeFileSync(
  join(TASK_DIR, `${id}.review.json`),
  JSON.stringify({ id, branch, sha, model: MODEL, effort: EFFORT, decision, review_file: reviewFile, codex_status: run.status }, null, 2) + "\n",
);

console.log(reviewText.slice(-1400));
console.log(`\nVERDICT: ${decision.toUpperCase()} — ${id}. Review: ai-factory/task-contracts/${id}.review.md`);
console.log(
  decision === "approve"
    ? "Reviewer approves; orchestrator may merge IF its own independent verification also passes."
    : "Reviewer did NOT approve; do not merge — address blocking findings or re-dispatch the builder.",
);
process.exit(decision === "approve" ? 0 : 1);
