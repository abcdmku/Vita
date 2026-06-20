# Factory State (live cursor)

> The orchestrator updates this every tick — the single source of "where are we". Keep it CURRENT,
> not a log (git history + the Done list below are the log).

## Current phase
**Phase 1 — Bootable immutable foundation** (spec §21), actively building via Docker/Go (host Go + the
golang:1.26 container lane both working; `golang.org/x/sys` vendored for offline syscalls). Phase 0
complete. Control-plane (SDK/controller/broker/capsules/catalog) built in Phase 0/portable work.

## Status: RUNNING — wide parallel OS build (autonomous to completion)
Owner 2026-06-20: **"continue, don't ask again"** + **"more Opus subagents to go faster"** — run the
loop continuously with a WIDE parallel fan-out; only stop on "stop" / a §24 stop condition.
**35 contracts merged.** Parallel mode: Opus 4.8 subagents each drive one independent contract
(dispatch GPT-5.5 → verify → reviewer gate) concurrently; orchestrator serial-merges with a typecheck
gate. Agent TCB merged: registry/health (P1-004), discovery (P1-005), transaction engine (P1-006),
nodeconfig cap (P1-007), **time cap (P1-009)**, + the audited **sysdeps** syscall facade. OS/SDK merged:
**Debian root-image scaffold (P1-011)**, **storage model (P0-019)**, **backup/recovery model (P0-020)**,
first-party manifests (P4-001). In round-2/3 gate: P1-008 transport, P1-010 hostname, P4-002 lockfile.
Reviewer gate has blocked **18 buggy merges (all real)** incl. a faked dependency + commit-point
mutations. typecheck=0, agent container green. Next waves: UKI/Secure-Boot→RAUC→dm-verity→QEMU boot,
identity/PDS, controller↔agent bridge, WASM loader.

**Operating mode (still in effect): AUTO-MERGE ALL (R0–R4)** + **R2/R3/R4 (and cross-cutting/
test-modifying R1) reviewer gate** (`npm run review` must approve). Quality floor: independent verify
+ `npm run typecheck` + rubric + stop-conditions. Owner overrides 2026-06-20.

## Phase 0 exit gates (spec §21) — met
- [x] One task passes spec → test → implement → review → evaluate → merge (proven 26×, incl. dual
      rounds on TCB code).
- [x] Agent sessions auditable — `task/<id>` branch + commit + worker report + review per task.
- [x] Protected policies/tests unchangeable by agents — dispatch refuses protected paths; verified.
- [x] Build inputs pinned — `tsconfig.base.json` + **`package-lock.json` (tsc 6.0.3 pinned)** +
      determinism gate + strict typecheck lane. (Full Nix/repro-image pinning still needs a Linux host.)

## What's built (portable, all verified + type-safe)
- **SDK** (`sdk/typescript`, 52 tests): plan model + normalizer · authoring API · capabilities +
  accelerators · diff · validation · envelope · determinism gate · explain · **`safeNormalize`**
  (the canonical intrinsic-safe trust-boundary primitive).
- **Manifests/protocols**: package-contract schema (§9.2) · package catalog entry (§9.3) · AT Protocol
  PDS manifest (FR-018).
- **Controller** (`controller/api`, 17 tests): `previewPlan`, `previewAppInstall` (shows granted/denied
  caps), storage/backup/identity overview (protection-state model), `previewCapsuleImport`.
- **Security TCB**: permission broker (default-deny, fail-closed, intrinsic-safe) — 3 reviewer rounds.
- **Portability**: capsule format (§13) · simulation profile types (§13/§20.1).
- **CI lanes**: `npm run typecheck` (strict tsc 6.0.3) + node-native test suites + determinism gate.
- **Governance**: Week-1 ADRs · an AI factory that hardened itself — AGENTS.md absorbed every security
  + type-safety lesson the reviewer taught.

## Reviewer gate — load-bearing (blocked 8 buggy merges that passed local tests)
determinism collision · cyclic-throw DoS · partial-malformed grants · method-shadowing TCB bypass ·
controller-boundary throw/accept · §13.1 secret-leak · incomplete-roles/exotic-params ·
TOCTOU-via-getters — plus exposing the **type-check gap** (48 latent errors). None reached `main`.

## Open follow-ups (deferred, minor; do when next touching the area)
- Spec markdown §8.3 example still shows the old shape (owner decides — spec is out of agent scope).
- Migrate broker/capsule/catalog/controller validators to use the new `safeNormalize` primitive (DRY;
  should prevent the recurring boundary-bug class).
- Broker `decide.ts` size + duplicated enum sets → shared constants module.

## Done (28)
P0-001..P0-016 (SDK core + audit cleanup + ADRs + safeNormalize + typecheck cleanup),
P1-001..P1-003 (package contract, PDS manifest, catalog), P2-001..P2-005 (controller skeleton, app
endpoints, overview, capsule-import), P6-001/P6-002 (capsule, simulation profiles). Audit:
`ai-factory/evaluation/audits/sdk-core-2026-06-20.md`. Reviews: `ai-factory/evaluation/reviews/`.


## Lessons (most recent first)
- **strip-types acceptance does NOT type-check.** node --experimental-strip-types erases types; 48
  strict-TS errors slipped through. Fix: `npm run typecheck` lane, required by AGENTS + factory-tick.
  Independent verification also caught a dispatch FALSE-NEGATIVE (escaped-quote acceptance typo) —
  never trust a status alone.
- **TOCTOU via accessor getters; snapshot once, reject accessors at every level** → `safeNormalize`.
- **TCB guards must not execute methods off untrusted objects; normalize-then-decide.**
- **Fail-closed must reject PARTIAL/exotic input, not just garbage.**
- **Pre-specifying the fail-closed checklist + domain semantics in the contract → first-round approve**
  (P1-003 vs P6-001's 2 rounds) — §18.5 process improvement.
- **Name the single owning module when a concept spans contracts** (avoid divergent re-invention).
- **Workers isolated in `.vita-worktrees/<id>`; never `&`-background a dispatch; never run foreground
  git on main during a worktree teardown. Windows: launch `codex.cmd` via shell, prompt over stdin.**
