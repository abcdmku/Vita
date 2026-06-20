#!/usr/bin/env node
// Consult a GPT-5.5 (xhigh) INDEPENDENT reviewer on a completed task branch before merging.
// Required for R2/R3/R4 (owner directive 2026-06-20). Usage: npm run review -- <task-id>
//
// Embeds the branch's diff (vs merge-base) + the task contract into a READ-ONLY `codex exec` prompt
// (the reviewer cannot modify the repo), captures the reviewer's final message to <id>.review.md,
// extracts the VERDICT line, and writes <id>.review.json {decision}. The orchestrator gates the
// merge on the verdict (approve required) in addition to its own independent verification.
import { spawnSync } from "node:child_process";
import { writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import os from "node:os";
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

const git = (args) => spawnSync("git", args, { cwd: REPO, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
const branch = `task/${id}`;
const sha = git(["rev-parse", "--verify", branch]).stdout.trim();
if (!sha) {
  console.error(`Branch ${branch} not found — dispatch the task first.`);
  process.exit(2);
}
const base = git(["merge-base", "main", branch]).stdout.trim() || "main";
const diff = git(["diff", `${base}..${branch}`]).stdout || "";
const files = git(["diff", "--name-only", `${base}..${branch}`]).stdout.trim();

// Run the contract's acceptance on the branch artifact so the reviewer has REAL pass/fail evidence —
// its read-only workspace cannot run tests, and the worker's sandbox may have blocked the Go container
// lane. Throwaway detached worktree so main is untouched.
let acceptanceEvidence = "(orchestrator did not run it)";
if (c.acceptance_command) {
  const revWt = join(REPO, ".vita-worktrees", `review-${id}`);
  git(["worktree", "remove", "--force", revWt]);
  git(["worktree", "prune"]);
  const add = git(["worktree", "add", "--detach", "--force", revWt, branch]);
  if (add.status === 0) {
    const acc = spawnSync(c.acceptance_command, { cwd: revWt, shell: true, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
    const out = ((acc.stdout || "") + "\n" + (acc.stderr || "")).split(/\r?\n/).filter(Boolean).slice(-14).join("\n");
    acceptanceEvidence = `${acc.status === 0 ? "PASS (exit 0)" : `FAIL (exit ${acc.status})`}\n${out}`;
    git(["worktree", "remove", "--force", revWt]);
    git(["worktree", "prune"]);
  }
}

// Strip the contract's "## Reviewer revision (round N)" history — it QUOTES prior (often already-fixed)
// findings, which the reviewer can regurgitate as a CURRENT finding even when the code now fixes it.
// The reviewer must judge only the current diff against the contract's requirements.
const contractForReview = c.raw.replace(/\n## Reviewer revision[\s\S]*?(?=\n## )/g, "\n");

const instructions = [
  "You are an INDEPENDENT senior reviewer for the Vita project (a TypeScript-first personal Node OS).",
  "Review the diff below (treat it as a higher-risk R2+ change) for merge into main. You did NOT write it.",
  "Judge against the task contract, AGENTS.md, ai-factory/evaluation/rubric.md, and the product spec",
  "(typescript_personal_node_os_build_spec.md — you may read repo files read-only). Hold a high bar.",
  "CRITICAL: assess ONLY the CURRENT code in the diff below. A finding is BLOCKING only if you can point",
  "to the offending line IN THIS DIFF. Do NOT re-report a prior-round finding unless it is still present.",
  "Be adversarial about: correctness; scope creep beyond the contract's target_paths; security and",
  "privileged surface (Go agent, boot, storage, identity, signing, permission broker);",
  "determinism/reproducibility; and TEST INTEGRITY — flag any weakened, deleted, skipped, or gamed test.",
  "",
  "Output two sections — BLOCKING (must fix before merge) and NOTES (non-blocking) — then end with",
  "EXACTLY one final line and nothing after it:",
  "  VERDICT: approve   (no blocking findings — safe to merge)",
  "  VERDICT: revise    (mergeable only after the blocking findings are fixed)",
  "  VERDICT: reject    (fundamentally wrong approach)",
  "",
  `Changed files:\n${files}`,
  "",
  `=== ORCHESTRATOR-RUN ACCEPTANCE on this branch (\`${c.acceptance_command}\`) ===`,
  acceptanceEvidence,
  "(This is the exact acceptance command, run by the orchestrator on the branch artifact — for Go it is",
  "the pinned golang Linux container. Treat a PASS as the verified test/build/container result; do NOT",
  "block solely because the worker report says it could not run the lane. Judge code correctness and",
  "security from the diff.)",
  "=== END ACCEPTANCE ===",
  "",
  `=== TASK CONTRACT ${id} (requirements; prior-round revision history stripped) ===`,
  contractForReview,
  "=== END CONTRACT ===",
  "",
  `=== DIFF (${base.slice(0, 9)}..${branch}) ===`,
  diff,
  "=== END DIFF ===",
].join("\n");

const reviewOut = join(os.tmpdir(), `vita-${id}.review.md`);
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
    "-o", reviewOut,
  ],
  {
    cwd: REPO,
    input: instructions,
    encoding: "utf8",
    stdio: ["pipe", "inherit", "inherit"],
    shell: isWin,
    maxBuffer: 64 * 1024 * 1024,
  },
);
if (run.error) console.error(`codex spawn error: ${run.error.message}`);

const reviewText = existsSync(reviewOut) ? readFileSync(reviewOut, "utf8") : "";
const reviewFile = join(TASK_DIR, `${id}.review.md`);
writeFileSync(reviewFile, reviewText);

const m = reviewText.match(/VERDICT:\s*(approve|revise|reject)/i);
// Fail safe: no explicit approval => do NOT merge.
const decision = m ? m[1].toLowerCase() : "revise";
writeFileSync(
  join(TASK_DIR, `${id}.review.json`),
  JSON.stringify({ id, branch, sha, base, model: MODEL, effort: EFFORT, decision, review_file: reviewFile, codex_status: run.status }, null, 2) + "\n",
);

console.log(`\nVERDICT: ${decision.toUpperCase()} — ${id}. Review: ai-factory/task-contracts/${id}.review.md`);
console.log(
  decision === "approve"
    ? "Reviewer approves; orchestrator may merge IF its own independent verification also passes."
    : "Reviewer did NOT approve; do not merge — address blocking findings or re-dispatch the builder.",
);
process.exit(decision === "approve" ? 0 : 1);
