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

## Milestone: SDK Phase-0 core COMPLETE
9 contracts merged (P0-001..P0-009), `sdk/typescript` = 8 modules, 33 tests green: plan model +
canonical normalizer, authoring API (defineSystem/app/backup), capabilities + accelerator selection
(unified), plan diff, plan validation (fail-closed), plan envelope (tamper-evident), determinism
gate, plan explain. All verified; the cross-cutting reconcile (P0-007) reviewer-approved.

## Milestone: SDK Phase-0 core + audit cleanup COMPLETE
12 contracts merged; `sdk/typescript` = 8 modules, **42 tests**, audit-clean (all 15 findings fixed,
the cross-cutting ones reviewer-approved; one reviewer-blocked a buggy merge → fixed round 2). Solid
foundation to build the controller on.

## In flight
- P2-001 (controller API skeleton — **first real R2**) building → reviewer-gated. P0-013 ADRs merged.
- Queue empties after P2-001 → author portable work next: permission-broker stubs (R2),
  package-contract schema (packages/, R1/R2), atproto manifest types (R1), isCanonicalPlan DRY (R1).

## Reviewer-gate follow-ups (deferred)
- (P0-011) `verifyEnvelope` structural check duplicates plan-shape knowledge from plan.ts/validate.ts
  → fold into a shared `isCanonicalPlan`.
- (P0-012) the SPEC markdown §8.3 example still shows the old shape that fails validation — owner
  decision whether to update the spec example (product/spec is out of agent scope).
- (P0-012) an inline `defineSystem` example in define-system.test.ts lacks `allowedCapabilities`
  (teaching the old pattern) — tidy when next touching that file.

## SDK core audit — DONE (2026-06-20)
Multi-agent workflow (23 agents, 6 dimensions × adversarial verify) → **15 confirmed findings**
(`ai-factory/evaluation/audits/sdk-core-2026-06-20.md`). Notable: the spec §8.3 example fails the
SDK's own `validatePlan`; `verifyEnvelope` is a recomputable hash (not authenticity); residual
type-divergence (DeepReadonly/DeviceSnapshot dup, §14.1 union widened). → cleanup contracts
P0-010/011/012.

## Blocked
- P0-012 (blocked on P0-010).

## Ready queue
- P0-010 (type unification), P0-011 (envelope honesty). P0-012 unblocks after P0-010.
- Then: Week-1 ADRs (author tools/checks/adr-structure.mjs first), first R2 controller-API skeleton.
  OS image / Go agent / lockfile lane need a Linux/Go/Docker host — owner decision point.

## Done
- **P0-001** — SDK plan model + canonical normalizer. 4/4 tests. Commit 56d3d48.
- **P0-002** — defineSystem/app/backup authoring API + example `system.ts`. 5/5 tests. Commit 2f23bfa.
- **P0-003** — capability snapshot + accelerator selection. 4/4 tests. (Reviewer flagged divergence
  + readonly leak → fixed by P0-007.)
- **P0-004** — plan diff engine (FR-006). 4/4; SDK regression 17/17. Commit d23f2e7.
- **P0-005** — plan validation (reject invalid + overprivileged, fail-closed). 4/4; suite 24/24.
  Commit 1b8fa60.
- **P0-006** — canonical plan envelope (seal/verify/encode, tamper-evident). 3/3; suite 27/27.
  Commit 9542444.
- **P0-008** — determinism/reproducibility gate (assertDeterministic). 3/3; suite 30/30. Commit 220b191.
- **P0-009** — human-readable plan explanation (inspect before apply). 3/3; suite 33/33. Commit 13e7a40.
- **P0-010** — unify shared types + §14.1 fidelity (audit cleanup). 35/35. Reviewer-approved. Commit c702404.
- **P0-011** — envelope integrity honesty + structural validation + bind metadata. 37/37.
  Reviewer-approved. Commit e4531be.
- **P0-012** — fix §8.3 example to validate + coverage gaps + collision-free repro. 42/42.
  Reviewer-approved (round 2; round 1 reviewer-blocked a determinism bug). Commit c75a2d8.
- **P0-007** — reconcile accelerator model + close readonly leak. 20/20 SDK tests. **First full
  reviewer-gate cycle on a real merge: review → VERDICT approve → integrate.** Commit 2b8fda7.

## Reviewer gate — VALIDATED & in use
`npm run review` (GPT-5.5 xhigh) works end-to-end. P0-003 review → `revise` (2 correct findings,
fixed by P0-007). P0-007 review → `approve` (cross-cutting + modified a test, so gated before merge).
R2+ merges require `approve`; R1 may be reviewed at orchestrator discretion (cross-cutting/test edits).
Non-blocking notes to revisit: (a) `AcceleratorCapability` is widened with `JsonObject &` beyond the
closed spec §14.1 union — confirm intended; (b) add a direct assertion that `refusal.available` is
frozen.

## Next up
- P0-005 (plan validation) → P0-006 (plan envelope).
- Reproducible-build / lockfile lane (closes last Phase-0 exit gate — build inputs pinned).
- Week-1 ADRs (Debian, Go, Deno, Btrfs, RAUC, package isolation); Go agent skeleton via Docker (draft).

## Lessons (most recent first)
- **Reviewer gate blocked a real merge (P0-012 round 1):** "tests pass + no test weakened" is NOT
  sufficient — the determinism gate's undefined/bigint sentinels collided with real object returns,
  a false positive that the passing tests didn't probe. My verify caught scope/weakening but not the
  logic flaw; the GPT-5.5 reviewer did. **Takeaway:** keep gating cross-cutting/logic-heavy R1 on the
  reviewer, and prefer collision-free encodings over magic-key sentinels. A multi-agent audit also
  surfaces this class (the audit had flagged the undefined-handling gap; the fix introduced the bug).
- **Reviewer caught a multi-task integration gap:** independent builders P0-002 and P0-003 each
  defined their own accelerator types → two divergent models. The per-file verify missed it; the
  GPT-5.5 reviewer caught it. **Process fix:** when contracts share a concept (e.g. accelerators in
  both define-system and capabilities), name the single owning module in the contract so workers
  import rather than re-invent. P0-007 reconciles the existing split.
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
