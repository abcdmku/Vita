# Factory State (live cursor)

> The orchestrator updates this every tick — the single source of "where are we". Keep it CURRENT,
> not a log (git history + the Done list below are the log).

## Current phase
**Phase 1 — Bootable immutable foundation** (spec §21), actively building via Docker/Go (host Go + the
golang:1.26 container lane both working; `golang.org/x/sys` vendored for offline syscalls). Phase 0
complete. Control-plane (SDK/controller/broker/capsules/catalog) built in Phase 0/portable work.

## Status: RUNNING — wide parallel OS build (autonomous to completion)
Owner 2026-06-20: **"continue, don't ask again"** + **"more Opus subagents"** + **"build with TS 7 RC"** —
run the loop continuously with a WIDE parallel fan-out; only stop on "stop" / a §24 stop condition.
**44 contracts merged.** Parallel mode: Opus 4.8 subagents each drive one independent contract
(dispatch GPT-5.5 → verify → reviewer gate) concurrently; orchestrator serial-merges with a typecheck
gate (now **native TS 7.0.1-rc**).
- **Agent — functional end-to-end:** registry/health (P1-004), hw discovery (P1-005), transaction
  engine (P1-006), loopback transport w/ fail-closed /apply (P1-008), capability registration (P1-013),
  **sysdeps** syscall facade (vendored x/sys); transactional caps nodeconfig (P1-007), time (P1-009),
  hostname (P1-010), identity (P5-002, in gate). All wired caps applicable over /apply (fixed a latent
  gap where time/hostname were rejected — see Lessons).
- **Controller↔agent:** typed client (P2-006) + UniFi-style node-overview (P2-007).
- **OS image (plan-level only):** Debian root scaffold (P1-011) + UKI/Secure-Boot scaffold (P1-012, TEST
  keys only). Real privileged builds (disk layout, RAUC, dm-verity, QEMU boot) need a Linux build host.
- **SDK/models:** storage (P0-019), backup/recovery (P0-020), recovery-key N-of-M flow (P0-021),
  identity (P5-001), lockfile-policy default-deny supply-chain gate (P4-002), first-party manifests (P4-001).
Reviewer gate has blocked **24 buggy merges (all real)** incl. a faked dependency, commit-point
mutations, supply-chain bypasses, path traversal. typecheck=0 (TS7), agent container green.
Next: disk-image layout → RAUC → dm-verity → QEMU boot (needs build host); more agent caps; identity/PDS;
controller UI; agent operation-name discovery (the /capabilities-vs-operations follow-up).

**Operating mode (still in effect): AUTO-MERGE ALL (R0–R4)** + **R2/R3/R4 (and cross-cutting/
test-modifying R1) reviewer gate** (`npm run review` must approve). Quality floor: independent verify
+ `npm run typecheck` + rubric + stop-conditions. Owner overrides 2026-06-20.

## Phase 0 exit gates (spec §21) — met
- [x] One task passes spec → test → implement → review → evaluate → merge (proven 26×, incl. dual
      rounds on TCB code).
- [x] Agent sessions auditable — `task/<id>` branch + commit + worker report + review per task.
- [x] Protected policies/tests unchangeable by agents — dispatch refuses protected paths; verified.
- [x] Build inputs pinned — `tsconfig.base.json` + **`package-lock.json` (tsc 7.0.1-rc pinned — native TS 7)** +
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
- **CI lanes**: `npm run typecheck` (strict tsc 7.0.1-rc, native TS 7) + node-native test suites + determinism gate.
- **Governance**: Week-1 ADRs · an AI factory that hardened itself — AGENTS.md absorbed every security
  + type-safety lesson the reviewer taught.

## Reviewer gate — load-bearing (blocked 8 buggy merges that passed local tests)
determinism collision · cyclic-throw DoS · partial-malformed grants · method-shadowing TCB bypass ·
controller-boundary throw/accept · §13.1 secret-leak · incomplete-roles/exotic-params ·
TOCTOU-via-getters — plus exposing the **type-check gap** (48 latent errors). None reached `main`.

## Open follow-ups (deferred, minor; do when next touching the area)
- Spec markdown §8.3 example still shows the old shape (owner decides — spec is out of agent scope).
- safeNormalize retrofit into EXISTING validators dropped (P0-017/018) — changes hostile-path/size
  semantics; use it in NEW validators only (see Lessons).
- Agent operation-name discovery over the API (for controller plan-building) — `/capabilities` is
  hardware; the registered operation names are a separate endpoint/field to add + wire to P2-006.
- Hostname/identity persistence across reboot (P1-010 is kernel-only; persist via the atomic-file pattern).
- Broker `decide.ts` size + duplicated enum sets → shared constants module.

## Done (44)
P0-001..P0-016 (SDK core + audit + ADRs + safeNormalize + typecheck), P0-019/020/021 (storage, backup/
recovery, recovery-key flow), P1-001..P1-003 (package contract, PDS manifest, catalog), P1-004..P1-013
(Go agent: skeleton→discovery→engine→nodeconfig/time/hostname caps→transport→registration + sysdeps +
x/sys vendor), P2-001..P2-007 (controller skeleton, app endpoints, overview, capsule-import, agent
client, node-overview), P4-001/002 (first-party manifests, lockfile policy), P5-001 (identity model),
P6-001/002 (capsule, simulation). Reviews: `ai-factory/evaluation/reviews/`. Failed/dropped: P0-017/018
(safeNormalize retrofit — see Lessons).


## Lessons (most recent first)
- **OS boot-integrity chain (dm-verity, real image build, real signing, QEMU boot, first-boot) is BLOCKED on a privileged Linux build host.** Plan-level scaffolds were valuable for root/UKI/disk-layout (pinned, reproducible structure), but dm-verity (P1-017) is where offline plans stop being validatable: correct veritysetup/systemd-veritysetup/kernel-cmdline semantics must match real tooling, and the reviewer (correctly) rejects speculative modeling. P1-017 deferred to blocked/ with the correct design captured. Resume the boot chain when a build host is available; until then build the abundant correctly-verifiable non-OS work.
- **Latent integration bug: 2 of 3 agent capabilities were unusable over /apply** (time.set/hostname.set). The transport pre-transaction gate (P1-008) requires every request type to implement Validate(), and a per-capability decoder must be registered in DefaultRequestDecoders — but nodetime/hostname had neither, and P1-013 added an integration test that ALSO mis-asserted /capabilities returns operation names (it returns hardware). It reached main because I verified that merge by counting grep ^ok lines (8) instead of checking the exit code / grepping FAIL. FIX: drift stays in Apply (runtime), static Validate() added to time+hostname requests, hostname decoder registered, test corrected. VERIFICATION RULE: a Go/test gate passes only on EXIT 0 (or an explicit no-FAIL check) — never infer pass from an ok-line count.
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
