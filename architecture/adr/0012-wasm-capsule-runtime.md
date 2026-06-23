# ADR-0012 — WASM capsule runtime: wasm-service via wasmtime in the hardened transient unit

Status: **ACCEPTED** — owner "do them all" (2026-06-23). (See ADR-0010 for the crun-as-executor outcome: DEFERRED —
crun can't run rootless under Vita's strict hardening without re-granting privilege; RootDirectory is the OCI path.) Builds on ADR-0009 (systemd transient unit = universal
jailer) + ADR-0010 (per-class executor inside ExecStart). Spec §21 Phase 4 "WASM component execution"; baseline
Wasmtime 36 LTS. x86_64.

## Decision
Run a `wasm-service` capsule as the BYTE-FOR-BYTE ADR-0009 hardened transient unit with `ExecStart=/usr/lib/vita/bin/
wasmtime run <WASI flags from manifest> /usr/lib/vita/capsules/<id>/component.wasm`. NO `RootDirectory=` (a host process
reading one staged `.wasm` under ProtectSystem=strict). The full hardening profile applies verbatim (DynamicUser, zero
caps, NoNewPrivileges, seccomp @system-service, cgroup caps, StateDirectory volumes) — `hardenedTransientUnitProperties
(manifest, false)` (no Deno pkey). Third executor on the proven model; no new isolation primitive, no bespoke supervisor.

**Runtime = wasmtime** (the spec baseline + WASI reference; single static CLI, pinnable+sha256-verifiable like Deno/crun;
@system-service-compatible syscalls). WASI **preview1 first**; the component model (preview2) is deferred behind a
future `runtime.wasm.mode` discriminator (the OCI→crun escalation pattern applied to WASI level — explicit non-goal v1).
Rejected: WasmEdge/Wasmer (diverge from the spec pin for no gain); **wazero/in-agentd engine — REJECTED HARD** (runs
untrusted bytecode in the privileged agentd address space, violates the ADR-0002/0009 privilege split + §9.3); a
WASM-specific sandbox (redundant — WASM is already sandboxed bytecode under the systemd jail).

WASI capabilities derived ONLY from the validated manifest (default-deny): `data.volumes[]` → `--dir host::guest`
preopens (RW/RO from `access`, via the existing `SetupVolumes`); no `--env`/`--inherit-env` (empty env + a fixed
agentd allowlist); WASI sockets OFF in v1 (AF_UNIX-only at the kernel; gated on a future networkGrant). Executor path
pinned-absolute; module name a fixed literal (`component.wasm`, like `main.ts`); all strings pass the
controlCharacter/validCapsuleID/isValidSRI guards. agentd composes the unit ONLY from the re-validated on-disk
manifest; runtime proposes only `{id,version,integrity}`.

## Attack-surface delta vs OCI — STRICTLY SMALLER (a security improvement)
The workload is sandboxed bytecode, not arbitrary native code → containment = systemd (seccomp/caps/cgroups) AND the
WASI capability boundary (agentd-gated) AND WASM memory-safety — THREE layers vs OCI's one. No RootDirectory, no image
layer-graph parse/extraction (just SRI-verify one `.wasm` as bytes, same trust order as the TS entrypoint). cgroup
enforcement still required (a hostile guest can DoS) but wasmtime adds a guest linear-memory cap inside the cgroup
bound; reuse `ConfirmOCILimits`/`readOCILimitsStatus` verbatim for the limits slice. Inherited unchanged: SO_PEERCRED
(P1-048), manifest-only composition.

## Staging
Pin wasmtime 36-LTS (version+URL+sha256 from the bytecodealliance release; orchestrator resolves the exact patch +
upstream checksum, re-confirmed on Borg51) in a `Wasmtime` block (agent-image.conf) + a fetch+verify+stage step
(mirror ts-image.mjs's Deno staging) → `/usr/lib/vita/bin/wasmtime` (0755). Offline override `VITA_WASMTIME_TARBALL`.
Not committed (build artifact); fetch at build time only.

## Slices (smallest-first; QEMU-boot-verifiable; VITA-CAPSULE-WASM-* markers MEASURED via real agent-reported health, the P1-055 lesson)
- **S1 (P1-058):** baked first-party `wasm32-wasip1` module under the full hardening (no fetch). `wasm-service`
  packageClass branch + `WasmExecution` arm (3-way ExecutionRuntime union) + `composeWasmTransientUnit` + `wasmtimeArgv`.
  `VITA-CAPSULE-WASM-EXECUTED: … runtime=wasmtime health=OK` + reject + FAILSAFE.
- **S2:** manifest-derived WASI preopen volume (`--dir host::guest` from SetupVolumes); module writes a sentinel,
  marker gated on read-back. `VITA-CAPSULE-WASM-VOLUME`.
- **S3:** `.wasm` artifact fetch + SRI-verify (single file, no extraction) wired end-to-end. `VITA-CAPSULE-WASM-FETCH`.
- **S4 (OWNER-gated GATE):** cgroup enforcement vs a HOSTILE WASM capsule on a real verity boot (reuse ConfirmOCILimits)
  — precondition before untrusted WASM. `VITA-CAPSULE-WASM-LIMITS: mem/tasks/cpu=enforced`.
- **S5 (deferred):** WASI component model / preview2 host interfaces (mode discriminator).

## Owner sign-off flags
(1) `wasm-service` (execution class) vs `wasm-component` (SDK artifact kind) two-name split (parallels oci-service/oci-image);
(2) WASI preview1-first, component model deferred; (3) wasmtime 36-LTS pin + /usr/lib/vita/bin staging; (4) the S4
hostile-WASM cgroup gate before untrusted WASM.

## Critical files
`agent/capabilities/capsule/execute.go` (wasm-service branch, 3-arm ExecutionRuntime union, WASMTIME_BIN); new
`agent/capabilities/capsule/wasm.go` (composeWasmTransientUnit, modeled on oci.go); `os/x86_64/ts-image.mjs` +
`agent-image.conf` (wasmtime pin+staging); `os/x86_64/ts-overlay/.../ts/main.ts` (VITA-CAPSULE-WASM-* emitters gated on
real health); `agent/storage/capsules/volumes.go` (reused for WASI preopen). SDK unchanged (wasm-component already modeled).
