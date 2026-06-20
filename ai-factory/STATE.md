# Factory State (live cursor)

> The orchestrator updates this every tick. It is the single source of "where are we".

## Current phase
**Phase 0 — Charter and AI factory** (spec §21, weeks 0–3, release v0.0).

## Status: RUNNING — Phase 0 loop active
Worker execution is live (GPT-5.5 xhigh via Codex `codex login`). The end-to-end loop is proven:
**P0-001 merged to `main`** (spec → contract → GPT-5.5 worker → independent verify → rubric → merge).

**Operating mode: AUTO-MERGE ALL (R0–R4)** — owner override 2026-06-20 ("auto merge everything until
I say not to"). No human-approval pause; quality floor (verify + rubric + stop-conditions) still
applies. Reverts when owner says "stop auto-merging".
**R2/R3/R4 reviewer gate** — owner 2026-06-20: those classes also require an independent GPT-5.5
xhigh review (`npm run review -- <id>`) to return `approve` before merge. R0/R1 unaffected.

## Phase 0 exit gates (spec §21)
- [x] One task can pass through spec → test → implementation → review → evaluation → merge.
      *(Demonstrated R1 single-impl via P0-001. Dual-candidate (§18.4) still to be exercised on the
      first R2+ task.)*
- [x] Agent sessions are auditable — provenance: `task/<id>` branch + commit + worker self-report.
- [x] Protected policies/tests can't be changed by ordinary agents — dispatch refuses protected
      `target_paths`; integration verifies no protected file changed (checked on P0-001).
- [ ] Build inputs are pinned — TS baseline pinned in `tsconfig.base.json`; lockfile/reproducible
      build lane still TODO.

## In flight
- (none) — queue drained; authoring the next Phase-0 slice.

## Blocked
- (none)

## Done
- **P0-001** — SDK plan model + canonical normalizer (`sdk/typescript`). 4/4 tests. Commit 56d3d48.
- **P0-002** — defineSystem/app/backup authoring API + example `system.ts`. 5/5 tests; P0-001
  regression 4/4. Commit 2f23bfa.
- **P0-003** — capability snapshot + accelerator selection (CPU fallback). 4/4 tests; full SDK
  regression 13/13 green.

## Next up
- Reproducible-build / lockfile lane (closes the last Phase-0 exit gate — build inputs pinned).
- Week-1 ADRs (Debian, Go, Deno, Btrfs, RAUC, package isolation).
- Go agent skeleton + health endpoint — needs Go (Docker path); queue as `draft` until set up.
- Validate the R2-R4 reviewer tool (`npm run review`) before the first R2+ task.

## Lessons (most recent first)
- **Dispatch/foreground git race (caused a scare, no data lost):** while a background `dispatch` had
  `task/P0-002` checked out in the shared working tree, a foreground commit (the auto-merge override)
  landed on that branch instead of `main`, then dispatch's final `git checkout main` made it look
  reverted. Recovered by ff-merging `task/P0-002`. **Fix:** dispatch now runs the worker in an
  isolated `git worktree` (`.vita-worktrees/<id>`), so background workers never touch the main
  working tree. Discipline still: don't run git on `main` while a dispatch is mid-flight.
- **Windows codex spawn:** Node `spawnSync('codex')` can't launch the `.cmd` shim → status null.
  Fixed: `codex.cmd` + `shell` on win32, prompt via stdin (keeps untrusted content off the cmdline).
- **Worker report artifact:** Codex `-o <id>.worker.md` lands in the task tree; gitignored
  `*.worker.md` and now integrate **only** product files via `git checkout <branch> -- <paths>`
  rather than merging the whole branch (keeps factory artifacts out of product history).
- **Codex noise:** non-fatal `rmcp::transport` MCP errors (cloudflare/localhost bb-mcp) come from
  the user's codex MCP config, not our repo — ignore.
