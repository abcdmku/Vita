# Factory State (live cursor)

> The orchestrator updates this every tick — the single source of "where are we". Keep it CURRENT,
> not a log (git history + the Done list below are the log).

## Current phase
**Phase 0 — Charter and AI factory** (spec §21) — exit gates nearly met; portable Phase 1/2 work
proceeding in parallel.

## Status: RUNNING — autonomous loop active
Workers: GPT-5.5 xhigh via Codex (`codex login`). 20 contracts merged; suites green (sdk 45, controller 10, manifests 4, atproto 4, broker 10, capsules 10). Test totals grow per tick.

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
- P6-001 **round 2** building. Round 1: pre-hardening eliminated ALL fail-closed findings (✓ the
  checklist works), but the reviewer caught §13.1 SEMANTIC gaps — embedded material allowed in `ref`
  fields (secrets-as-references not enforced) + empty signatures accepted. Re-dispatched. (6th block.)

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
- (P2-002) broker `decide.ts` is sizable and duplicates runtime enum sets (data classes/access/protocols)
  — extract a single shared enum/constants module for auditability/drift.

## Reviewer gate — validated & load-bearing
`npm run review` (GPT-5.5 xhigh) is in active use. It has **blocked four buggy merges** that passed
local tests: P0-012 (determinism sentinel collision), P0-014 (guard threw on cyclic input — DoS),
and P2-002 ×2 (partial-malformed grants + alias; then method-shadowing bypass). All fixed-forward and
merged. AGENTS.md now mandates fail-closed-never-throw + intrinsic-safe trust-boundary guards.

## Done (20)
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
- **P2-002** permission-broker decision core — **TCB R2** ✓rev (3 rounds; default-deny, fail-closed, intrinsic-safe).
- **P2-003** controller app endpoints — install-preview shows granted/denied caps via broker (FR-010, §28.5) ✓rev r2.
- **P1-002** PDS manifest · **P6-001** capsule manifest types + fail-closed validator (§13) ✓rev r2.

Full audit: `ai-factory/evaluation/audits/sdk-core-2026-06-20.md`. (✓rev = reviewer-approved.)

## Lessons (most recent first)
- **Fail-closed probes must include EXOTIC objects too (P2-004 r1).** A param guard accepted
  `new Date()`/`new Map()`/prototype-bearing objects as "valid empty params". My probe used a plain
  `{}` and missed it. **Standard probe set now:** garbage, partial, cyclic, method-shadowed, hostile
  iterator, throwing/flipping proxy, AND exotic prototype-bearing objects (Date/Map/Proxy). Accept
  only true plain objects at a boundary. (7th reviewer block.)
- **Pre-hardening pre-empts fail-closed, not domain semantics (P6-001).** Loading the full
  fail-closed checklist into the contract made the worker nail every adversarial-input class first try,
  but the reviewer still caught spec-§13.1 correctness gaps (embedded secrets in ref fields; empty
  signatures). **Takeaway:** pre-harden the mechanical class (fail-closed/intrinsic-safe) up front;
  the gate stays essential for domain/spec-semantic correctness which can't be fully pre-listed.
- **Trust-boundary fail-closed has many shapes (P2-003 r1).** Beyond garbage/partial/method-shadowing:
  a throwing PROXY getter (`.length`) crashes an unguarded reader, and "no denials" wrongly reads as
  success for a zero-capability app under a malformed policy. **Takeaway:** wrap the WHOLE boundary
  method so any throw → typed error; validate the policy shape too; success needs positive evidence,
  not just absence of denials. (5th reviewer block — gate remains load-bearing.)
- **TCB guards must not execute methods off untrusted objects (P2-002 r2).** A shape-valid contract
  with a shadowed array method (`egress.some = () => true`) or hostile iterator bypasses grant checks
  that call `.some`/`.includes`/`.find` on the untrusted object. **Fix pattern:** normalize untrusted
  input to plain trusted data with intrinsic-safe reads first, reject exotic shapes, then decide.
  (Now in AGENTS.md.) The broker has needed 3 rounds — a hard adversarial-input problem; if serial
  fix-forward stalls, decompose or run spec §18.4 dual-candidate.
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
