# Factory State (live cursor)

> The orchestrator updates this every tick — the single source of "where are we". Keep it CURRENT,
> not a log (git history + the Done list below are the log).

## Current phase
**Phase 1 — Bootable immutable foundation** (spec §21), actively building via Docker/Go (host Go + the
golang:1.26 container lane both working; `golang.org/x/sys` vendored for offline syscalls). Phase 0
complete. Control-plane (SDK/controller/broker/capsules/catalog) built in Phase 0/portable work.

## Status: RUNNING — Codex restored (~00:30 UTC); switched back from the Opus stopgap. Build green.
Owner 2026-06-20: **"continue, don't ask again"** + **"more Opus subagents"** + **"build with TS 7 RC"** +
**"use opus in the meantime then back to codex after reset"** — run continuously; only stop on "stop" / §24.
**93 contracts merged.**
- **Codex usage-limit window (~23:57–00:30 UTC):** per the owner, the loop did NOT idle — it switched the
  worker substrate to **Opus 4.8 subagents** (builders) with **independent Opus reviewers** as the R2/R3
  gate substitute (Codex `npm run review` was also down), + orchestrator independent verification. Landed
  during the window: P0-025 (semver, R1 orchestrator-direct), P0-026 (semver-range, R1), P7-005 (audit-log
  store, R3 — recovered round-2 from a dangling commit after a failed re-dispatch reset the branch; round-3
  symlink/atomic-write fix), P7-006 (transport audit emission + /audit, R3), P0-027 (update-applicability,
  R1), P2-023 (audit-trail client, R2), P2-024 (node-snapshot client, R2 — in final gate). The Opus
  build+independent-review+verify pipeline held the quality floor (see [[vita-opus-during-codex-outage]]).
- **Codex restored:** new work resumed on the normal Codex dispatch + `npm run review` gate.
- **Post-restore (Codex):** **services** subsystem (P7-007 cap + P0-028 model + P2-026 preview + P7-008
  wiring) and **accounts** subsystem (P0-029 security-gated model + P7-009 cap + P7-010 wiring + P2-027
  preview) — the agent now has **13 transactional capabilities** (… + timesync, services, accounts), all
  wired/discoverable/applicable/readable/in-/state. Reviewer gate has now blocked **49 real bugs** (latest:
  a model-valid `__proto__` username polluting a plain-`{}` diff record → AGENTS.md null-prototype-keying
  rule; a nodeConfig-add/remove passing `undefined` to a preview that rejects it; a concurrent-append
  lost-write; a symlink/TOCTOU atomic-write).
- **Change-set thread (capstone):** P0-030 unified change-set model + P2-028 whole-node change-set preview
  (composes all 4 subsystem previews into one operator view with aggregated security/privilege flags).
- **Integration + docs:** P7-011 (agent end-to-end lifecycle scenario) + P2-029 (controller operator-session
  workflow) — BOTH planes integration-tested end-to-end. `architecture/ARCHITECTURE.md` consolidates the
  built system.
- **Frontier-unblock proposal:** `architecture/adr/0007-shared-capability-schema.md` (PROPOSED, owner
  decision) — a shared language-neutral capability manifest both planes derive from, which unblocks the
  closed config→plan evaluator (P9-001) + whole-node apply. Next: a low-risk ADDITIVE proof-of-concept
  (manifest dialect + a manifest-driven TS validator + a conformance test vs. the existing validators) that
  does NOT touch the TCB — de-risks the owner decision before any migration.
- **ADR 0007 ACCEPTED (owner 2026-06-21) + IMPLEMENTED end-to-end → the config→plan evaluator is UNBLOCKED:**
  P9-003 (shared JSON manifest `schema/capabilities/` + codegen single-source), P9-005 (Go
  `capmanifest` validator + named-FORMAT dialect — raw regex dropped because it can't be JS↔Go-equal; 5
  rounds surfaced real parity bugs: regex non-portability, JSON number underflow, two Unicode case-fold
  bypasses), P9-006 (cross-language conformance gate — TS≡Go on a shared corpus, drift fails CI), and
  **P9-001 (the §8.2 config→plan evaluator) — manifest-driven, CLOSED, deterministic — RESOLVED** (was
  blocked 3 rounds on the feasibility wall). `blocked/` now holds ONLY the boot chain (P1-017, build-host).
  **ADR 0007 implemented; config-evaluator resolved; whole-node apply demonstrated end-to-end** (P9-001
  evaluator → P2-030 apply orchestration). **Migration:** P9-007 (hostname) + P9-008 (the FOUNDATIONAL
  full-request/object-dialect correction + node.config; 9 rounds — surfaced the full-request model, a
  Go/TS verification gap, and an unbounded-dup-key-scan DoS now bounded) faithfully migrated; default
  registry = {hostname.set, node.config}. **timesync + services + time.set MIGRATED.** Registry now = 5 caps
  {hostname.set, node.config, services.config, time.set, time.sync}. P9-013 landed the widely-shared
  `uniqueBy:[field]` primitive + `export *`'d the generated manifests (future caps auto-register). **P9-014
  (WAVE 0a) DONE: `rfc3339Instant` mirrors `time.Parse(time.RFC3339)` EXACTLY — incl. precise digit-width
  (rejects `1x:02:03`), offset bound hr≤24/min≤60 (ground-truth Go), and RAW-TOKEN validation matching
  `time.Time.UnmarshalJSON`'s no-unescape (Go issue 47353; escaped timestamps reject). 4 rounds, all
  ground-truth-verified.** **P9-015 (WAVE 1 string substrate) DONE:** reusable composable string options
  `noInlineMaterial`(SERVICE variant)/`noControlChars`/`trimmed`/`maxBytes`(UTF-8)/`minLength`, byte-faithful
  to `services.go:containsInlineServiceMaterial` (ground-truth-verified across the battery incl. `[-_\s]?`
  one-optional-separator), harness oracle = VENDORED services.go regexes (no longer self-referential), weak
  `noInlineSecrets` aliased to strong. **KEY: there are TWO agent scanners** — services
  `containsInlineServiceMaterial` (no word-run) vs backup/identity `containsInlineSecretMaterial` (+seedWords
  + `openssh\s+`/literal age); the SECRET variant is deferred to WAVE 4 (AGENTS trap 1+8). Next: migrate a cap
  end-to-end (capsule — uses uniqueBy+substrate, needs sriIntegrity/capsuleId/capsuleVersion/forbiddenSchemePrefix).
  **P9-016 (capsule.registry) MIGRATED — 6th cap** (registry = 6: capsule.registry, hostname.set, node.config,
  services.config, time.set, time.sync). Built REUSABLE `sriIntegrity` (sha256/384/512 + base64 std/raw) +
  `forbiddenSchemePrefix` + `capsuleId`/`capsuleVersion` + the CAPSULE secret scanner (==backup; identity
  differs), validated by the real `DecodeJSONRequest[capsule.ApplyRequest]` conformance. Next: update.plan or
  backup (both now have sriIntegrity + forbiddenSchemePrefix).
  **PROBE RELIABILITY (verification meta-lesson):** the adversarial `migration-probe` is RELIABLE for
  STRUCTURAL findings (it caught the self-referential harness, services dup-name LOOSER, the
  `[-_\s]?`-whitespace scanner gap — all real) but UNRELIABLE for TOOLCHAIN-BEHAVIOR claims (it has no Go): it
  FALSELY claimed Go bounds the RFC3339 offset (real Go rejects `+25:00` — actually it does, probe wrong other
  way) and that Go rejects non-canonical SRI base64 `B=` (real Go `StdEncoding` is LENIENT — both accept). RULE:
  treat any probe claim about what a stdlib/toolchain DOES as a HYPOTHESIS → confirm with a ground-truth
  Go-in-Docker run; trust its CODE-STRUCTURE findings. (2 real, 2 false toolchain claims so far.)
  **P9-017 (update.plan) MIGRATED — 7th cap** (registry = 7; +update.plan). REUSED sriIntegrity +
  forbiddenSchemePrefix from capsule (proving cross-cap reuse); built bundleRefString + bundleVersionString;
  ground-truth cross-checked (manifest ≡ update.go validateBundleRef on all REF edges incl. 256/257 length,
  forbidden schemes, NO-secret-scanner-on-ref). **7/13 caps migrated** (hostname, node.config, time.sync,
  services, time.set, capsule, update). **Remaining 6 (roadmap's hardest):** accounts (posixAccount/GroupName
  + notInEnum + dedupItems + multi-key-uniqueBy + shellAllowlistPath), identity (didPlc/Web + atprotoHandle +
  keyReference + anyOfFormats + SECRET scanner variant), backup (exactlyOneOf cron-XOR-interval + opaqueRef +
  cron5OrMacro + SECRET scanner), storage (4 enum-domain array invariants + canonicalAbsolutePath — HARDEST),
  network (cidrLiteral + networkInterfaceName + integer-sentinel + item-level-forbid-unless), pdssync
  (cidV1Multibase + did/handle + secretKeyNameDenylist). identity+pdssync share did/handle+anyOfFormats.
  **P9-018 (accounts.config) MIGRATED — 8th cap** (registry = 8; +accounts.config). Built REUSABLE `notInEnum`
  (privileged-group blocklist) + `dedupItems` (keep-first) + multi-key `uniqueBy[name,uid]` + posixAccountName/
  groupName + shell-allowlist enum + uid bounds. **Round-2 fixed the shared INTEGER primitive** (rejects
  `1000.0`/`1e3` float/exponent tokens to match Go `json.Decode`-into-int; AGENTS trap 9) — hardens
  storage.quotaGiB/network.port. The PROBE caught this (Codex r1 missed it) — dual-gate value. **8/13 migrated**
  (… +capsule, update, accounts). **Remaining 5:** identity (didPlc/Web+atprotoHandle+keyReference+anyOfFormats+
  identity SECRET scanner; did/handle REUSED by pdssync — do identity FIRST), backup (exactlyOneOf
  cron-XOR-interval + cron5OrMacro + opaqueRef + SECRET scanner), storage (4 enum-domain array invariants +
  canonicalAbsolutePath — HARDEST; now has notInEnum/dedupItems/uniqueBy/integer-fix), network (cidrLiteral
  [extends ipLiteral] + networkInterfaceName + integer-sentinel + item-level-forbid-unless), pdssync
  (cidV1Multibase heaviest + did/handle from identity + secretKeyNameDenylist).
  **P9-019 (identity.attestation) MIGRATED — 9th cap** (registry = 9; +identity.attestation). Built
  didPlcOrWeb + atprotoHandle + keyReference + anyOfFormats + the identity SECRET scanner — did/handle REUSED
  by pdssync. **4 rounds of Unicode case-folding subtleties (all ground-truth adjudicated):** (r1) "scanner
  looser" = FALSE POSITIVE (Go RE2 `(?i)` does NOT fold non-ASCII — `(?i)secret`≠`ſecret` — so ASCII-lowercase
  is CORRECT for a `(?i)` scanner); (r3) SCHEME lowercasing needs Go `strings.ToLower` UNICODE
  (Kelvin U+212A->k accepted by agent); (r4) U+0130 needs SIMPLE fold ->`i` (JS full-fold gives `i̇`). **AGENTS
  trap 5b: match the agent's lowercasing PER CHECK — `strings.ToLower`=Unicode-simple vs `(?i)`=no-non-ASCII-fold.**
  **9/13 migrated.** Remaining 4: pdssync (cidV1Multibase heaviest + did/handle REUSE from identity +
  secretKeyNameDenylist), network (cidrLiteral [extends ipLiteral] + networkInterfaceName + integer-sentinel +
  item-level-forbid-unless), backup (exactlyOneOf cron-XOR-interval + cron5OrMacro + opaqueRef + secret
  scanner), storage (4 enum-domain array invariants + canonicalAbsolutePath — HARDEST).
  **PROBE vs CODEX: neither is infallible; GROUND-TRUTH Go-in-Docker is the tiebreaker.** Probe caught: services
  dup-name, self-ref harness, whitespace-scanner, integer-float (Codex missed it). Codex caught: identity
  scheme-lowercase (probe's scanner-fuzz missed it). Probe FALSE on: offset-bound, SRI-base64, identity-scanner
  (toolchain claims w/o Go). Run BOTH + verify toolchain claims against real Go.
  **P9-020 (network.policy) MIGRATED — 10th cap** (registry = 10; +network.policy). Built REUSABLE cidrLiteral
  (net/netip ParsePrefix+Masked) + networkInterfaceName + port integer-sentinel(-1=PortAll) + the item-level
  wide-open-guard cross-field. SECURITY-verified (Opus probe, exhaustive empirical: 33 vectors + 18 adversarial
  inputs): the guard CANONICALIZES (masks) BEFORE the covers-all test, so host-bit-smuggled `0.0.0.1/0`, v6
  `::/0`, IPv4-mapped `::ffff:0.0.0.0/0` all REJECT when unsafeWideOpen absent/false — NO firewall hole. Gated
  by the OPUS PROBE (Codex usage-limited) + my ground-truth. **10/13 migrated.** Remaining 3: backup
  (exactlyOneOf cron-XOR-interval + cron5OrMacro + opaqueRef + secret scanner), storage (4 enum-domain array
  invariants + canonicalAbsolutePath — HARDEST; has notInEnum/dedupItems/uniqueBy/integer-fix), pdssync
  (cidV1Multibase heaviest decoder + did/handle REUSE from identity + secretKeyNameDenylist). These build via
  **Opus subagents** (Codex dispatch down until Jun 24).
  **P9-021 (backup.policy) MIGRATED — 11th cap** (registry = 11; +backup.policy), OPUS-BUILT + OPUS-GATED
  (Codex outage). Built exactlyOneOf(cron|interval) + cron5OrMacro + the opt-in `nullAsAbsent` per-field option
  (explicit JSON `null` on the agent's `*string`/`*int64` omitempty fields = ABSENT, matching Go pointer
  decode — verified via the dual oracle + ground-truth; default OFF so opt-in/no other-cap regression — ALSO
  unblocks storage's appId/quotaGiB). Opus gate found 2: the null one (REAL, fixed) + a scanner one (FALSE
  POSITIVE — Go RE2 `(?i)` does NOT fold long-s; the probe used JS `/iu`; my ground-truth refuted). **The
  Opus-builder flow WORKS** (Agent isolation:worktree → commits task/<id> → I verify+gate+merge from shared
  refs; it also caught + I fixed a pre-existing regression: P9-019's scheme-fuzz shelled out to native `go`,
  ENOENT-failing the host TS suite → now t.skip()s). **11/13 migrated.** Remaining 2: storage (4 enum-domain
  array invariants: enum-conditional appId-presence + singleton-roles + required-role-coverage +
  filtered-uniqueBy[appId among app-state] + canonicalAbsolutePath + quotaGiB>0 — prereqs notInEnum/dedupItems/
  uniqueBy/integer-fix/nullAsAbsent now ALL built), pdssync (cidV1Multibase heaviest decoder + did/handle REUSE
  from identity + secretKeyNameDenylist).
  **127 contracts merged. Reviewer gate has blocked 74 real bugs.** Recent: P9-009 (ipLiteral/hostnameOrIp
  via the netip-authoritative + structured-TS + conformance-corpus template — cracked IP in 1 round),
  P9-010 (systemic bounded JSON dup-key scanner `jsonsafe` + DecodeStrict across 14 caps — the DoS audit,
  MERGED), P9-012 (structured formats: posixUsername/groupName/systemdUnitName/absolutePath, MERGED). In
  flight: P9-011 (timesync faithful migration + nested-cross-field dialect ext), P9-013 (services migration,
  dialect-disjoint).
  **STRATEGY (owner: "build parity-safe formats, then continue migration"):** the dialect
  (`agent/internal/capmanifest/capmanifest.go` + `sdk/typescript/src/capability-manifest.ts`) is a HARD
  serialization point — almost every remaining cap needs a new FORMAT or a cross-field PRIMITIVE there, so
  format/dialect work canNOT parallelize. Safe max ≈ 2 streams: one dialect-touching + one disjoint-cap
  (only `services` uses purely-existing primitives). Map of remaining dialect needs: storage =
  enum-conditional field presence (appId⟺app-state); accounts = notEnum/disallowedValues (privileged groups)
  + nested; backup = mutually-exclusive one-of (cron XOR interval) + a cron format; network = CIDR format;
  identity = DID/handle; pdssync = CID/URL; capsule = SRI/version; time = datetime. PLAN: front-load the
  dialect primitives + formats (sequential through the dialect), THEN fan out all 9 remaining cap migrations
  in parallel (they become dialect-disjoint). (a) bootable image still → Linux build host (owner-gated).
- **AUTHORITATIVE MIGRATION ROADMAP: [migration-roadmap.md](migration-roadmap.md)** (from an exhaustive
  9-cap validator map via the `map-cap-dialect-needs` workflow). 5 WAVES: W0 parity-safe formats
  (rfc3339Instant+time.set [P9-014], cidrLiteral, sriIntegrity) → W1 shared string substrate
  (stringScreenBundle, noInlineMaterial-strong [replaces the LOOSE existing noInlineSecrets],
  forbiddenSchemePrefix, rawPattern) + update.plan → W2 uniqueBy family + capsule → W3 FAN OUT accounts ∥
  identity → W4 backup ∥ storage ∥ network ∥ pdssync (hardest, last). The 7 parity traps are in AGENTS.md.
  **VERIFICATION (ultracode): run the reusable adversarial probe `ai-factory/workflows/migration-probe.js`
  (3 lenses: stricter/looser/conformance-integrity, confirmed + synthesized) on each R3 migration BEFORE the
  Codex gate — it already caught the services dup-name LOOSER bug the green corpus hid (64th finding).**
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


## 🔧 BOOT CHAIN UN-BLOCKED (2026-06-21): owner gave a Linux host (Borg51) + a runnable build path.
The OS build is now reachable: `os/BUILD-AND-BOOT.md` + the one-script executor `os/x86_64/build-and-boot.mjs`
(`--mode=smoke|full --dry-run`) derive mkosi/ukify commands from the planners + fill host steps (pull → cached
privileged build → verity → UKI → A/B repart → sbsign → rauc → qemu). Smoke (rootfs→unsigned disk→QEMU) runs on
Borg51 today; the user is iterating real builds. **P1-017 (dm-verity scaffold) UN-BLOCKED + in flight** (Codex)
— deterministic `planVerity()` per the documented correct design (veritysetup over image artifacts → root hash
→ systemd `roothash=` on the UKI cmdline, `root=`→verity-mapped device, `safeNormalize`); after merge, WIRE it
into build-and-boot step-2 + validate `--mode=full` on Borg51. Signing keys remain owner-supplied (§16).

## 🎉 ADR-0007 MIGRATION COMPLETE (2026-06-21): ALL 13 CAPABILITIES MIGRATED.
The config→plan→apply evaluator now covers the ENTIRE capability surface — whole-node apply is fully
manifest-driven. Registry (13): hostname.set, node.config, time.sync, services.config, time.set,
capsule.registry, update.plan, accounts.config, identity.attestation, network.policy, backup.policy,
storage.layout, pds.sync-state. Each is a language-neutral JSON manifest (`schema/capabilities/*.json`) +
its conformance corpus proven BYTE-FAITHFUL to the Go agent validator via the cross-language dual oracle
(`*_conformance_test.go` runs every vector through BOTH the manifest AND the real
`transport.DecodeJSONRequest[<cap>.ApplyRequest]+Validate()`, fatal on disagreement). **76 real bugs gated.**
The dialect now has ~22 formats (ipLiteral, hostnameOrIp, posix/group/systemd/absolutePath, rfc3339Instant,
cidrLiteral, sriIntegrity, didPlcOrWeb, atprotoHandle, keyReference, networkInterfaceName, capsuleId/Version,
bundleRef/Version, cron5OrMacro, cidV1Multibase) + ~14 primitives (uniqueBy/multi-key/filtered, notInEnum,
dedupItems, exactlyOneOf, nullAsAbsent, the string substrate, integer-literal+sentinel+float64-Trunc modes,
cross-field rules incl. enum-conditional-presence/singleton/required-coverage/wide-open-guard). The hardest
parity work (the §8.2 feasibility wall) is DONE. **NEXT FRONTIER: the bootable signed image (P1-017 + real
mkosi/dm-verity/RAUC build) — BLOCKED on a privileged Linux build host (owner-gated).**

## ✅ CODEX RESTORED (owner 2026-06-21: "codex is reset you can use it again") — outage was ~21:24 UTC.
Back to Codex: `npm run dispatch` (builder) + `npm run review` (R3 gate). The Opus-builder + Opus-probe flow
held the floor during the gap (network P9-020, backup P9-021 both Opus-built/gated; storage P9-022
Opus-BUILT, now CODEX-gated). **The Opus-builder flow is PROVEN** (Agent isolation:worktree → commits
task/<id> on shared refs → orchestrator verifies + gates + merges) — keep it as the outage fallback
([[vita-opus-during-codex-outage]]). pdssync (last cap) → Codex dispatch.

## Lessons (most recent first)
- **NEVER prefix a contract-revision commit with `git reset --hard main` — it reverts the just-made edit
  before `git add`.** P9-014 rounds 2-3: my commit command began with `git reset -q --hard main` (habit, to
  clean the verify tree), which discarded the uncommitted contract edit, so the worker rebuilt from the CLEAN
  contract and never saw the raw-token/digit-width findings (round-2 fixed digit-width only by luck on a
  fresh build). `dispatch` passes NO prior-review feedback to the worker — the CONTRACT is the only channel,
  so a reverted edit = a lost finding. RULE: commit contract edits with `git add <contract> && git commit`
  and NO preceding reset; do verification-tree cleanup with `git checkout main -- agent sdk schema && git
  clean -fdq agent sdk schema` (scoped — never `reset --hard` while an uncommitted ai-factory edit is
  pending). Confirm post-commit with `git show main:<contract> | grep <finding-keyword>`.
- **NEVER run two dialect-touching contracts in parallel — serialize them.** P9-011 (timesync + nested
  cross-field) and P9-012 (structured formats) BOTH modified the dialect (`capmanifest.go` +
  `capability-manifest.ts`) from the same pre-base. P9-012 merged first; P9-011's branch was then STALE
  (its dialect lacked the structured formats), so checking it out reverted them → 41 false Go FAILs +
  TS7=1 on the *structured-formats* conformance (not a timesync bug — P9-011's own 12 tests passed). A
  hand-merge of two intricate dialect diffs is exactly the "hand-parity unreliable" trap. FIX: `dispatch`
  branches from current main HEAD (`worktree add -B task/<id> <wt> HEAD`), so RE-DISPATCH the staler
  contract after the other merges — it rebases cleanly onto the new dialect, conformance-guaranteed. RULE:
  only ONE dialect-touching contract in flight at a time; fill the parallel lane with dialect-DISJOINT
  cap migrations (services-class) only.
- **Verifying a branch's NEW files via `git checkout <branch> -- <file>` STAGES them; they leak onto main.** During parallel-stream verification I checked out in-flight P9-010/P9-012 NEW files into the main working tree to run the container; `git checkout <branch> -- <newfile>` stages the file, and a `git checkout main -- .` cleanup does NOT remove files absent from main, so they stayed staged and a later `git commit` swept 5 of them onto main — the P9-012 structured-formats TEST (without its format impl) broke the capmanifest build. FIX: clean up with `git reset --hard main && git clean -fdq <dirs>` (removes staged + untracked), NEVER commit between a verification-checkout and that cleanup, and prefer `git show <branch>:<file>` (no staging) or a dedicated `git worktree` for inspecting in-flight branches. Removed the 5 leaked files (90b914f); they re-add cleanly on merge.
- **A contract RE-SCOPE must go in the main body (Objective/acceptance), NOT a `## Reviewer revision` section. (RECURRED 3× — P9-002, P9-005, P9-008; treat as a HARD RULE.)** `tools/dispatch/review-task.mjs` STRIPS `## Reviewer revision` sections before showing the contract to the reviewer (the fix for the P3-001 false-negative). That is right for incremental *patch* instructions (worker applies, reviewer judges the code), but WRONG for a *re-scope* that changes what the reviewer should CHECK: the reviewer judges the new code against the STALE Objective and (correctly) flags the re-scoped work as out-of-scope drift / weakened tests. Cost multi-round bounces on P9-002 (hostname-only), P9-005 (named formats), P9-008 (object dialect + full-request + timesync re-model). RULE: a *patch* → revision section; any *scope/design change* (new dialect primitive, new field shape, touching another module, dropping a requirement) → REWRITE the Objective + acceptance in the body. (Future tooling option: stop stripping revisions; instead instruct the reviewer "a finding is BLOCKING only if it points to a line in the CURRENT diff" — keeps re-scopes visible without the echo false-negative.)
- **ADR-0007 evidence — hand-written cross-language validator parity is unreliable.** The P9-002 manifest PoC tried to hand-match the agent's Go `netip` IP handling and drifted across THREE rounds (IPv4-mapped `::ffff:…`, canonical-dedup of zero-padded forms, compressed dotted-tail). Per "decompose past 3 rounds" the PoC was re-scoped to RFC-1123 hostnames (hand-conformant) with IP-format deferred to ADR 0007's generated/shared primitive. The struggle is the strongest argument FOR the ADR (codegen, not hand-written parity) — captured in ADR 0007 "Empirical evidence".
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
