# Factory State (live cursor)

> The orchestrator updates this every tick — the single source of "where are we". Keep it CURRENT,
> not a log (git history + the Done list below are the log).

## Current phase
**Phase 1 — Bootable immutable foundation** (spec §21), actively building via Docker/Go (host Go + the
golang:1.26 container lane both working; `golang.org/x/sys` vendored for offline syscalls). Phase 0
complete. Control-plane (SDK/controller/broker/capsules/catalog) built in Phase 0/portable work.

## Status: PAUSED (Codex usage limit) — resume dispatch/gate ~7:32 PM local (2026-06-20). Build green.
Owner 2026-06-20: **"continue, don't ask again"** + **"more Opus subagents"** + **"build with TS 7 RC"** —
run the loop continuously; only stop on "stop" / a §24 stop condition. (A usage-limit window is an external
blocker, NOT a §24 stop — do R0/R1 directly, resume R2+ when credits return.)
**88 contracts merged.** Codex worker substrate hit its USAGE LIMIT again (~23:57 UTC, "try again at 7:32
PM"); this halts BOTH dispatch (GPT-5.5 workers) AND the reviewer gate (also Codex). During the window the
orchestrator did **P0-025 (semver utility, R1) DIRECTLY** (CLAUDE.md §1.1) — TS7 clean, 7/7. **P7-005**
(audit-log store, R3) is PAUSED mid-fix: round-2 landed (mutex + concurrency) but round-3 (the symlink/
predictable-temp atomic-write fix) is NOT merged — `task/P7-005` stays at round-2, do NOT merge it; re-dispatch
round-3 when credits return. P2-022 was integrated on independent verification (a reviewer false-negative).
- **Agent — functional end-to-end, 11 transactional capabilities all wired/discoverable/applicable/readable:**
  registry/health (P1-004), hw discovery (P1-005), transaction engine (P1-006), loopback transport w/
  fail-closed /apply (P1-008), `/operations` discovery (P1-015), `/read/{cap}` (P1-023), `sysdeps` syscall
  facade (vendored x/sys), full wiring (P1-013/016/020/022, P6-006, P7-003). Caps: nodeconfig, time,
  hostname, identity, network, storage, update, backup, pdssync, capsule, timesync.
- **Controller↔agent:** typed client (P2-006), node-overview (P2-007), operation/plan-preview (P2-008),
  change-previews — update (P2-010), storage (P2-011), network (P2-012), backup (P2-014), capsule (P2-018),
  node-config unified (P2-020, in gate); apply-flow (P2-013), node-state reader (P2-015), dashboard (P2-016),
  package-runtime preview (P2-017), health monitor (P2-019).
- **OS image (plan-level only):** root (P1-011) → UKI/Secure-Boot (P1-012) → A/B disk layout + RAUC bundle
  (P1-014). dm-verity (P1-017) + real build/QEMU boot are BLOCKED on a Linux build host (see Lessons/blocked/).
- **SDK/models (12):** storage (P0-019), backup/recovery (P0-020), recovery-key N-of-M (P0-021), node-config
  aggregate (P0-022), node-health (P0-023), identity (P5-001), PDS (P5-003), DID-doc/caps (P5-005/006),
  network (P8-001), update/RAUC (P8-002), capsule-registry (P6-005).
- **Packages:** catalog (P1-003), lockfile-policy default-deny gate (P4-002), first-party manifests
  (P4-001), install resolver (P3-001), Deno sandbox policy (P3-002). **Simulation harness** (P6-003).
- **Capsules:** format (P6-001), agent cap (P6-004), registry model (P6-005), wiring (P6-006), preview (P2-018).
Reviewer gate has blocked **41 buggy merges (all real)** incl. a faked dependency, commit-point
mutations, supply-chain bypasses, path traversal, prototype pollution, dup-JSON-key smuggling, an
INEFFECTIVE test (swallowed by a catch), and a section-preview fail-closed BYPASS. typecheck=0 (TS7),
agent container green (17 pkgs). Factory self-hardening: workers now apply AGENTS.md lessons proactively
(P7-002 timesync landed R3-clean, zero revise rounds).
Next (buildable): incremental breadth (more caps/previews/wiring). The high-value frontier — a BOOTABLE
signed image (FR-001) + whole-NodeConfig→plan apply — is gated on the Linux build host + the shared
config→plan schema (blocked/). Owner has the honest comprehensive-completion signal.

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

## Done (70) — full authoritative list in ai-factory/task-contracts/done/
P0-001..P0-016 (SDK core + audit + ADRs + safeNormalize + typecheck), P0-019/020/021 (storage, backup/
recovery, recovery-key flow), P1-001..P1-003 (package contract, PDS manifest, catalog), P1-004..P1-013
(Go agent: skeleton→discovery→engine→nodeconfig/time/hostname caps→transport→registration + sysdeps +
x/sys vendor), P2-001..P2-007 (controller skeleton, app endpoints, overview, capsule-import, agent
client, node-overview), P4-001/002 (first-party manifests, lockfile policy), P5-001 (identity model),
P6-001/002 (capsule, simulation). Reviews: `ai-factory/evaluation/reviews/`. Failed/dropped: P0-017/018
(safeNormalize retrofit — see Lessons).


## Lessons (most recent first)
- **A contract can author the bug: when a task stalls 2+ review rounds on the SAME bug CLASS, suspect the CONTRACT's design guidance, not just the worker.** P2-020 (node-config preview) failed 3 rounds on added/removed-section handling. Rounds 2–3 patched instances (storage validation, then network flag), but the reviewer kept finding more (backup boundary flag at retentionDays:1; synthetic `lo`/`/absent/…` resources polluting the diff). Root cause was MY contract wording — "compose the section change-preview against a typed absent baseline" — which FORCED synthetic baselines that leak fake resources + miscompute boundary flags. Fix wasn't another re-prompt: I rewrote the contract's design to explicit per-section rules (changed ⇒ run previewXChange; added ⇒ validate desired + diff=all-added + flags computed directly; removed ⇒ weakensRetention ALWAYS true, diff=all-removed; no synthetic baseline ever). Heuristic: if successive reviews report the same shape of defect in new spots, stop patching spots — re-read what the contract told the worker to BUILD and fix the design there.
- **Config evaluator (P9-001) deferred — TS/Go schema split is a feasibility wall.** A closed, drift-free, /apply-ready config->plan evaluator needs the authoritative capability vocabulary + per-capability request schemas, which live in the Go agent with no shared source TS can reuse. Re-implementing in TS drifts (reviewer caught :::/0, Go zero-time); an open structural evaluator is rejected as not-closed. PREREQUISITE: a shared language-neutral capability/request schema both TS + Go derive from (owner-architecture decision). NOTE: config->plan+validation is already covered by SDK authoring -> controller preview (P2-008, rejects unknown ops vs live /operations) -> agent /apply Validate. Moved to blocked/. (Per CLAUDE.md: decompose/defer when a TCB contract stalls past ~3 rounds; here decomposition surfaced a missing prerequisite.)
- **Worker substrate billing blocker (2026-06-20 ~19:18 UTC): ChatGPT/Codex USAGE LIMIT hit** ("try again at 2:32 PM" / buy credits). Halts BOTH dispatch (GPT-5.5 workers) AND the reviewer gate (also Codex). P1-018+P6-003 dispatches failed with no files; note a dispatch can show passed=true on a no-op (go test ./... passes the UNCHANGED tree) so ALSO require has_changes=true + codex_status=0. Build paused for R2+ (needs the gate); the orchestrator may do R0/R1 directly (CLAUDE.md 1.1). Resume dispatch/review when credits return. P1-018/P6-003 remain ready in queue/.
- **Reviewer FALSE-NEGATIVE from contract revision-history.** P3-001 round 3 was blocked by a reviewer finding (capabilitiesFromContract grant-all) that had 0 occurrences in the round-3 code, repeated verbatim across 2 runs. Cause: the contract embeds Reviewer revision (round N) sections that QUOTE prior (fixed) findings, and the reviewer echoed the quote as current. Independent verification (8/8 tests, no grant-all path, MISSING_REQUESTED_CAPABILITIES present) is the arbiter -> integrated P3-001 on verification, documented. FIX: review-task.mjs now strips ## Reviewer revision sections before embedding the contract + instructs the reviewer that a finding is BLOCKING only if it points to a line IN THE CURRENT DIFF. (Independent verification over a status remains the rule, both directions: false-positives AND false-negatives.)
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
