# Factory State (live cursor)

> The orchestrator updates this every tick. It is the single source of "where are we".

## Current phase
**Phase 0 — Charter and AI factory** (spec §21, weeks 0–3, release v0.0).

## Status: RUNNING — Phase 0 loop active
Worker execution is live (GPT-5.5 xhigh via Codex `codex login`). The end-to-end loop is proven:
**P0-001 merged to `main`** (spec → contract → GPT-5.5 worker → independent verify → rubric → merge).

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
- P0-002 (authoring API + example) dispatching to a worker; P0-003 (capabilities) ready next.

## Blocked
- (none)

## Done
- **P0-001** — SDK plan model + canonical normalizer (`sdk/typescript`). 4/4 tests. Commit 56d3d48.

## Next up
- P0-003 capabilities/accelerator selection.
- Reproducible-build / lockfile lane (closes the last Phase-0 exit gate).
- Week-1 ADRs (Debian, Go, Deno, Btrfs, RAUC, package isolation).
- Go agent skeleton + health endpoint — needs Go (Docker path); queue as `draft` until set up.

## Lessons (most recent first)
- **Windows codex spawn:** Node `spawnSync('codex')` can't launch the `.cmd` shim → status null.
  Fixed: `codex.cmd` + `shell` on win32, prompt via stdin (keeps untrusted content off the cmdline).
- **Worker report artifact:** Codex `-o <id>.worker.md` lands in the task tree; gitignored
  `*.worker.md` and now integrate **only** product files via `git checkout <branch> -- <paths>`
  rather than merging the whole branch (keeps factory artifacts out of product history).
- **Codex noise:** non-fatal `rmcp::transport` MCP errors (cloudflare/localhost bb-mcp) come from
  the user's codex MCP config, not our repo — ignore.
