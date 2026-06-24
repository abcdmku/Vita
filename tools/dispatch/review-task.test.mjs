#!/usr/bin/env node
// Regression test for the two review-task.mjs reliability bugs observed 2026-06-24 on P1-066:
//   #1 stale same-commit cache — a FAILED codex run silently re-saved the prior run's byte-identical
//      review.md (codex `-o` only overwrites on success; the per-id tmp file was never cleared).
//   #2 wrong line references — findings cited main's (older/already-merged) line numbers, not the
//      branch tip (review fed only `git diff`, whose @@ headers number both sides).
//
// Strategy: build a synthetic UNMERGED branch that shifts a distinctive line away from main (so its
// tip line number provably differs from main's), then drive the REAL script through its default-off
// VITA_REVIEW_SIMULATE seam (no GPT-5.5 call) and assert the prompt + outputs. No external deps; runs
// on Windows/Git-Bash. Self-cleans (branch, contract, worktree, artifacts) on success or failure.
import { spawnSync } from "node:child_process";
import { writeFileSync, readFileSync, existsSync, rmSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const REPO = fileURLToPath(new URL("../../", import.meta.url));
const SCRIPT = join(REPO, "tools", "dispatch", "review-task.mjs");
const ID = "ZTEST-lineref";
const BRANCH = `task/${ID}`;
const TARGET = "agent/capabilities/backup/archive.go";
const MARKER = "os.Chmod(stage, archiveDirMode)";
const SHIFT = 60;
const CONTRACT = join(REPO, "ai-factory", "task-contracts", "queue", `${ID}.md`);
const REVIEW_MD = join(REPO, "ai-factory", "task-contracts", `${ID}.review.md`);
const REVIEW_JSON = join(REPO, "ai-factory", "task-contracts", `${ID}.review.json`);
const TMP_REVIEWOUT = join(tmpdir(), `vita-${ID}.review.md`);
const TMP_PROMPT = join(tmpdir(), `vita-${ID}.review.prompt.txt`);

const git = (args, opts = {}) => spawnSync("git", args, { cwd: REPO, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, ...opts });
let failures = 0;
const ok = (cond, msg) => { console.log(`${cond ? "  PASS" : "  FAIL"}  ${msg}`); if (!cond) failures++; };
const lineOf = (text, needle) => text.split("\n").findIndex((l) => l.includes(needle)) + 1; // 1-based, 0 if absent

function cleanup() {
  git(["worktree", "remove", "--force", WT]);
  git(["worktree", "prune"]);
  git(["branch", "-D", BRANCH]);
  for (const f of [CONTRACT, REVIEW_MD, REVIEW_JSON, TMP_REVIEWOUT, TMP_PROMPT]) rmSync(f, { force: true });
}

let WT = "";
let exitCode = 1;
try {
  // --- setup: synthetic branch where MARKER sits at a different line than on main ---
  WT = mkdtempSync(join(tmpdir(), "vita-ztest-wt-"));
  git(["worktree", "remove", "--force", WT]); // in case a prior run left it
  git(["branch", "-D", BRANCH]);
  const add = git(["worktree", "add", "-b", BRANCH, WT, "main"]);
  if (add.status !== 0) throw new Error(`worktree add failed: ${add.stderr}`);

  const tgtPath = join(WT, ...TARGET.split("/"));
  const mainContent = readFileSync(tgtPath, "utf8");
  const mainLine = lineOf(mainContent, MARKER);
  if (!mainLine) throw new Error(`marker ${MARKER} not found on main copy of ${TARGET}`);
  writeFileSync(tgtPath, `${"// ztest-shift\n".repeat(SHIFT)}${mainContent}`);
  git(["add", "-A"], { cwd: WT });
  const commit = git(["commit", "-m", `test(${ID}): shift ${MARKER} down ${SHIFT} lines`], { cwd: WT });
  if (commit.status !== 0) throw new Error(`commit failed: ${commit.stderr}${commit.stdout}`);
  git(["worktree", "remove", "--force", WT]);

  const tipSha = git(["rev-parse", "--verify", BRANCH]).stdout.trim();
  const tipContent = git(["show", `${BRANCH}:${TARGET}`]).stdout;
  const tipLine = lineOf(tipContent, MARKER);
  console.log(`\nsetup: ${MARKER} is main:${mainLine} → tip:${tipLine} (shifted ${SHIFT}); tip ${tipSha.slice(0, 9)}`);
  ok(tipLine === mainLine + SHIFT && tipLine !== mainLine, `flagged line provably differs from main (${mainLine} → ${tipLine})`);

  writeFileSync(CONTRACT, [
    "---", `id: ${ID}`, "status: ready", "risk_class: R3", "title: ztest line-ref",
    "---", "", "Synthetic contract for review-task.test.mjs. Not a real task.", "",
  ].join("\n"));

  const runReview = (simulate, extra = {}) =>
    spawnSync(process.execPath, [SCRIPT, ID], {
      cwd: REPO, encoding: "utf8", maxBuffer: 64 * 1024 * 1024,
      env: { ...process.env, OPENAI_API_KEY: "test-stub", VITA_REVIEW_SIMULATE: simulate, ...extra },
    });

  // A successful reviewer message that CORRECTLY cites the branch-tip line + quotes it.
  const goodReview = join(tmpdir(), `vita-${ID}.good.md`);
  writeFileSync(goodReview, [
    "**BLOCKING**", "",
    `- \`${TARGET}:${tipLine}\` — \`${MARKER}\` runs on the staging dir.`, "",
    "**NOTES**", "- none", "", "VERDICT: revise", "",
  ].join("\n"));

  // === Scenario A: bug #2 — the reviewer is fed AUTHORITATIVE tip line numbers + verify directive ===
  console.log("\n[A] bug #2: prompt carries branch-tip numbering & quote directive");
  const a = runReview(goodReview);
  ok(a.status === 1, "exit 1 (revise → non-zero), script ran");
  const prompt = existsSync(TMP_PROMPT) ? readFileSync(TMP_PROMPT, "utf8") : "";
  const tipCiteRe = new RegExp(`(^|\\n)\\s*${tipLine}\\t.*${MARKER.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`);
  ok(tipCiteRe.test(prompt), `BRANCH-TIP listing shows ${MARKER} at tip line ${tipLine}`);
  const mainCiteRe = new RegExp(`(^|\\n)\\s*${mainLine}\\t.*${MARKER.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`);
  ok(!mainCiteRe.test(prompt), `listing does NOT place ${MARKER} at the stale main line ${mainLine}`);
  ok(/AUTHORITATIVE line numbers/.test(prompt), "prompt: declares branch-tip numbers AUTHORITATIVE");
  ok(/QUOTE the exact source line/.test(prompt) && /INVALID/.test(prompt), "prompt: requires quoting + marks mismatches INVALID");
  ok(prompt.includes("=== BRANCH-TIP FILES"), "prompt: has a BRANCH-TIP FILES section");

  // === Scenario A': header records the EXACT reviewed commit (verifiability / anti-stale key) ===
  const reviewA = readFileSync(REVIEW_MD, "utf8");
  ok(reviewA.includes(`reviewed-commit: ${tipSha}`), "review.md header records the exact reviewed commit");
  ok(reviewA.includes(`${TARGET}:${tipLine}`), "review.md body cites the tip line");
  const jsonA = JSON.parse(readFileSync(REVIEW_JSON, "utf8"));
  ok(jsonA.decision === "revise" && jsonA.fresh === true && jsonA.sha === tipSha, "review.json: fresh revise, keyed by tip sha");

  // === Scenario B: re-run on the SAME commit is NOT byte-identical & is reported as a prior review ===
  console.log("\n[B] same-commit re-run: fresh (not byte-identical) + clearly reported");
  const bytesA = readFileSync(REVIEW_MD);
  const b = runReview(goodReview);
  const bytesB = readFileSync(REVIEW_MD);
  ok(!bytesA.equals(bytesB), "re-review of the same tip is NOT byte-identical (genuinely re-ran)");
  ok(readFileSync(REVIEW_MD, "utf8").includes(`reviewed-commit: ${tipSha}`), "re-run still keyed to the same reviewed commit");
  ok(/prior review of .* exists/i.test(b.stdout), "re-run clearly reports a prior review for this exact commit");

  // === Scenario C: bug #1 — a FAILED codex run must NOT resurrect stale content ===
  console.log("\n[C] bug #1: failed run emits fail-safe, never reuses stale cache");
  const STALE = "STALE-MARKER-DO-NOT-REUSE-APPROVE";
  writeFileSync(REVIEW_MD, `legacy review\nVERDICT: approve\n${STALE}\n`);
  writeFileSync(TMP_REVIEWOUT, `legacy tmp\nVERDICT: approve\n${STALE}\n`); // the exact stale-cache vector
  const c = runReview("empty");
  const reviewC = readFileSync(REVIEW_MD, "utf8");
  ok(!reviewC.includes(STALE), "stale prior content is NOT reused");
  ok(reviewC.includes("REVIEW DID NOT COMPLETE"), "explicit fail-safe report written");
  ok(reviewC.includes(`reviewed-commit: ${tipSha}`), "fail-safe report still records the reviewed commit");
  const jsonC = JSON.parse(readFileSync(REVIEW_JSON, "utf8"));
  ok(jsonC.decision === "revise" && jsonC.fresh === false, "failed run → fail-safe revise, fresh:false (won't merge)");
  ok(c.status === 1, "failed run exits non-zero (blocks merge)");
  rmSync(goodReview, { force: true });

  exitCode = failures === 0 ? 0 : 1;
  console.log(`\n${failures === 0 ? "ALL PASS" : `${failures} FAILURE(S)`}`);
} catch (e) {
  console.error(`\nTEST ERROR: ${e.stack || e.message}`);
  exitCode = 1;
} finally {
  cleanup();
}
process.exit(exitCode);
