# Factory State (live cursor)

> The orchestrator updates this every tick — the single source of "where are we". Keep it CURRENT,
> not a log (git history + the Done list below are the log).

## Current phase
**Phase 0 — Charter and AI factory** (spec §21) — exit gates nearly met; portable Phase 1/2 work
proceeding in parallel.

## Status: RUNNING — autonomous loop active
Workers: GPT-5.5 xhigh via Codex (`codex login`). 17 contracts merged; suites green
(sdk 45, controller 5, manifests 4, atproto 4). Test totals grow per tick.

**Operating mode: AUTO-MERGE ALL (R0–R4)** — owner override 2026-06-20. No human-approval pause;
quality floor (independent verify + rubric + stop-conditions) still applies. Reverts on "stop
auto-merging".
**R2/R3/R4 reviewer gate** — owner 2026-06-20: those classes (and any cross-cutting / test-modifying
R1) require an independent GPT-5.5 review (`npm run review -- <id>`) returning `approve` before merge.

## Phase 0 exit gates (spec §21)
- [x] One task passes spec → test → implement → review → evaluate → merge (proven many times).
- [x] Agent sessions auditable — `task/<id>` branch + commit + worker report per task.
- [x] Protected policies/tests unchangeable by agents — dispatch refuses protected `target_paths`;
      integration verifies no protected file changed.
- [ ] Build inputs pinned — TS baseline pinned (`tsconfig.base.json`) + determinism gate; full
      dependency lockfile/Nix lane still needs a toolchain host.

## In flight
- P2-002 **round 2** building. Round 1 reviewer-BLOCKED (not merged): 4 security holes in the TCB
  broker — **partial-but-typed** malformed data/network inputs could still grant (my garbage-only
  probe missed it); an undocumented `package` alias widened the trust boundary. Re-dispatched with
  strict shape validation (reuse the P1 validator) + adversarial tests. Queue empties after → author next.

## Owner steering welcome
Portable surface is broad. Areas the loop can deepen: **controller** (more endpoints),
**permission-broker** (P2-002), **packages/catalog**, **PDS/atproto** (P1-002), **storage/capsules**,
**simulation profiles**. Say "focus on <area>" to prioritize, or "set up Docker" to open the
Go-agent / OS-image / lockfile path. Absent steering, the loop proceeds in id order.

## Open follow-ups (deferred, minor)
- (P0-012) the **spec markdown** §8.3 example still shows the old shape that fails the validator —
  owner decides whether to update the spec (product/spec is out of agent scope).
- (P0-012) an inline `defineSystem` example in `define-system.test.ts` lacks `allowedCapabilities` —
  tidy when next touching that file.
- (P2-001) `previewPlan` re-normalizes instead of reusing `validation.plan` — minor simplification.

## Reviewer gate — validated & load-bearing
`npm run review` (GPT-5.5 xhigh) is in active use. It has **blocked two buggy merges** that passed
local tests: P0-012 round 1 (determinism sentinel collision) and P0-014 round 1 (guard threw on
cyclic input — DoS at the controller boundary). Both fixed-forward and merged on round 2. AGENTS.md
now mandates fail-closed-never-throw validators to pre-empt the latter class.

## Done (17)
- **P0-001** plan model + canonical normalizer · **P0-002** authoring API + §8.3 example ·
  **P0-003** capabilities + accelerator selection · **P0-004** plan diff (FR-006) ·
  **P0-005** plan validation (fail-closed) · **P0-006** plan envelope (tamper-evident) ·
  **P0-007** reconcile accelerator model (first reviewer-gate cycle) · **P0-008** determinism gate ·
  **P0-009** plan explain.
- **P0-010** type unification (audit) ✓rev · **P0-011** envelope honesty (audit) ✓rev ·
  **P0-012** §8.3 example validates + coverage (audit) ✓rev r2.
- **P0-013** Week-1 ADRs (adr-check) · **P0-014** shared fail-closed `isCanonicalPlan` ✓rev r2.
- **P1-001** package contract schema (§9.2) · **P1-002** AT Protocol PDS manifest (FR-018).
- **P2-001** controller API skeleton — **first R2** ✓rev (getOverview/getNodeHealth/previewPlan).

Full audit: `ai-factory/evaluation/audits/sdk-core-2026-06-20.md`. (✓rev = reviewer-approved.)

## Lessons (most recent first)
- **Fail-closed must reject PARTIAL malformed input, not just garbage (P2-002 r1).** The broker
  granted on typed-but-incomplete data/network declarations; my "wholly-garbage → denied" probe gave
  false confidence. **Takeaway:** verify validators against partial/missing-required-field inputs;
  validate the FULL required shape (reuse the canonical validator, not a looser local re-check); read
  ALL fields a decision reads (no undocumented aliases at a trust boundary). 3rd reviewer-block, most
  security-significant — strong proof the R2 gate is load-bearing.
- **Never `&`-background a dispatch** — orphans it (no completion notification); use the tool's
  run_in_background param. (Recovered an orphaned worktree this session.)
- **Reviewer catches fail-closed/edge-case bugs the suite misses** (P0-014 cyclic-throw, P0-012
  sentinel collision). Keep gating cross-cutting/validator R1s; require fail-closed-never-throw +
  malformed/cyclic regression tests up front (now in AGENTS.md).
- **Multi-task integration gaps** (P0-002/P0-003 divergent accel types) — name the single owning
  module when a concept spans contracts so workers import, not re-invent.
- **Dispatch/foreground-git race** — workers run in isolated `.vita-worktrees/<id>`; never run
  foreground git on main while a dispatch's worktree teardown may be happening.
- **Windows codex spawn** — launch `codex.cmd` via shell + prompt over stdin (Node can't exec the
  `.cmd` shim directly).
