# ADR-0010 — OCI capsule runtime (PROPOSED — pending OWNER sign-off)

Status: **ACCEPTED** — OWNER signed off 2026-06-23 ("do them all and parallelize what you can with codex"): the
arbitrary-native-code attack surface is ACCEPTED, and ALL THREE runtime approaches are greenlit to build in parallel —
(A) `RootDirectory=` OCI [this ADR's primary path, slices 1-5], (B) crun-as-executor [full OCI fidelity, slice 6 now
promoted to active], (C) a microVM/strong-isolation class [`microvm-service`]. The cgroup-enforcement-vs-hostile-image
proof (slice 5) remains the gate before any UNTRUSTED OCI capsule runs. Date: 2026-06-23.

## Context
Today (ADR-0009) only `ts-service` capsules run — as hardened systemd transient units whose ONLY workload is the
PINNED, audited Deno. Wave 5 extends the runtime to OCI container images. This is the first time the node would run
**arbitrary attacker-supplied native binaries**, so the threat model changes materially.

## Decision (recommended)
Run `oci-service` capsules as an **unpacked OCI rootfs mounted into the SAME ADR-0009 hardened transient `.service`
unit via systemd's native `RootDirectory=`** — NO separate OCI runtime binary (crun/runc/youki) on the node. agentd
(privileged) assembles a verified read-only rootfs from the image layers (extending `fetch.go`), then composes a unit
**byte-for-byte the ADR-0009 hardening profile** except:
- `RootDirectory=<agentd-managed RO rootfs>` replaces the host-rooted `ProtectSystem=strict` view (workload sees the
  image as `/`, read-only).
- `ExecStart=` is the image entrypoint (agentd-resolved from the OCI config: absolute in-rootfs path, argv allowlisted,
  never shell), replacing the pinned Deno argv.
- DynamicUser, zero caps, NoNewPrivileges, seccomp `@system-service`, RestrictAddressFamilies, cgroup caps, and
  `StateDirectory` volumes are otherwise identical.

Systemd remains the sole jailer; the image is just a different filesystem + ExecStart. This mirrors ADR-0009's "reuse
the proven profile, don't build a bespoke supervisor."

**Deliberate non-goal (state plainly):** this does NOT implement the full OCI Runtime Spec — image-declared mounts,
capabilities, userns maps, rlimits, and hooks from `config.json` are IGNORED. An OCI image is treated as "a rootfs +
an entrypoint + env + workdir," with OUR manifest policy over everything else. Most server software runs fine; images
needing Docker/podman semantics fail closed (§7.1 untrusted-by-default). crun-as-executor is the documented escalation
if fidelity is later required — it slots into the same hardened unit's `ExecStart` without re-opening this decision.

### Why `RootDirectory=` (not `RootImage=`, not crun, not nspawn)
- `RootImage=` needs a mountable FS image (squashfs/erofs/GPT); OCI images are layer-tars → extract to a dir →
  `RootDirectory=` reuses `fetch.go`'s existing traversal-safe extractor. (`RootImage=`/dm-verity-per-capsule is a
  future hardening.)
- **crun/runc/youki rejected for slice 1:** net-new privileged-capable binary to vendor/pin/SBOM/review on an
  immutable node; their own namespaces+cgroup+seccomp OVERLAP and can conflict with systemd's hardening (two-jailer
  reasoning); cgo/Rust/C toolchain conflicts. Kept as the documented escalation.
- **systemd-nspawn rejected:** full OS-container with its own PID1, heavier, different hardening surface — the right
  tool for a future `microvm-service` strong-isolation class, not the common OCI service.

## Image acquisition (extends fetch.go, preserves the P1-045/P1-051 trust order)
SRI-verify the full artifact bytes BEFORE decode; nothing staged until an atomic rename. Local `oci-image` layout
tar (offline, no registry pull). TWO-level verification: outer SRI + the OCI content-addressing graph (index → manifest
→ each layer/config `sha256` matches filename + the manifest digest pinned in `runtime.ociImageIndexes[].digest`).
Layer assembly reuses `safeArchiveName`/`safeExtractPath` + **P1-051's extraction caps applied across the WHOLE layer
stack** (explicit coordination), plus OCI whiteout handling (dedicated tests). Rootfs lives RO under
`/var/lib/vita-agent/capsule-storage/<id>/<version>/rootfs/` (agentd-owned 0700). No layer sharing in v1.

## Attack-surface delta (the OWNER-sign-off line)
1. **Workload is arbitrary native code, not pinned Deno** — containment rests ENTIRELY on the systemd profile holding
   against an active adversary; no second line (Deno's permission model) behind it. MUST be re-verified against a
   deliberately HOSTILE test image, not a cooperative one.
2. **cgroup ENFORCEMENT becomes a BLOCKING precondition** (was an ADR-0009 follow-up): an arbitrary binary will
   fork-bomb/OOM/spin with intent. `MemoryMax`/`TasksMax`/`CPUQuota` must be confirmed to THROTTLE a hostile workload
   on a real verity boot before ANY untrusted OCI capsule runs.
3. **New privileged parse surface** (image index/manifest/config JSON) — reuse `jsonsafe` strict allowlists; the
   derived `ExecStart` is highest-risk (absolute in-rootfs path, argv control-char/metachar rejection, never shell).
4. **`RootDirectory=` + DynamicUser + /var-RO-tree** interplay — boot-confirm the DynamicUser can read/execute the
   agentd-owned rootfs.
5. **Unauthenticated control channel** — SO_PEERCRED already done (P1-048); "start an arbitrary container" makes it
   even more load-bearing.

## Manifest (manifest-only composition preserved)
`packageClass="oci-service"` is the discriminator (widen `ExecutionManifest.Validate`, today ts-service-only).
`ExecutionRuntime` gains a mutually-exclusive `oci` arm `{image:{digest, entrypoint?}}`, validated like the TS arm.
agentd composes the unit ONLY from the re-validated on-disk manifest (runtime supplies `{id,version,integrity}` only);
`resources`→cgroup, `data.volumes`→StateDirectory, `healthChecks`→supervisor, `network`→RestrictAddressFamilies all
map identically to ts-service.

## OWNER sign-off flags
1. First path running ARBITRARY native binaries (R3, R4-adjacent) — removes the pinned-executor backstop. OWNER MAY
   REDIRECT toward crun (full fidelity) or defer OCI behind microVM-grade isolation.
2. cgroup enforcement is a hard precondition (slice 5), not a follow-up.
3. Confirm "OCI image = rootfs + entrypoint under our policy" is the accepted durable `oci-service` semantics.

## Slices (smallest-first, each QEMU boot-verifiable; `VITA-CAPSULE-OCI-*` markers)
1. **Run a trivial BAKED first-party OCI rootfs via `RootDirectory=` under the full hardening** (no fetch). Proves the
   launcher + the profile holds with `RootDirectory=`+DynamicUser. `VITA-CAPSULE-OCI-EXECUTED … root=ro health=OK` +
   fail-closed reject. (R3, FIRST-PARTY image only — low escalation.)
2. **OCI image-layout fetch + two-level digest verify + capped/traversal-safe/whiteout layer assembly** (extends
   fetch.go, coordinates with P1-051). `VITA-CAPSULE-OCI-FETCH … verified=OK` + reject. (R3)
3. **Wire fetch→launcher end-to-end** (`oci-service` accepted, `ExecutionRuntime.oci` parsed). (R3)
4. **StateDirectory volumes under `RootDirectory=`.** (R3)
5. **cgroup enforcement vs a HOSTILE image on a real verity boot** — the gate before ANY untrusted OCI capsule.
   `VITA-CAPSULE-OCI-LIMITS: mem=enforced tasks=enforced cpu=enforced`. (R3, OWNER-gated)
6. (deferred) crun-as-executor escape hatch if RootDirectory fidelity proves insufficient.

## Spec compliance
No FFI in TS (§9.3) — all new code is privileged Go; TS only proposes. Immutable rootfs (RO `RootDirectory=`, writable
state only via StateDirectory). Content-addressed/digest-pinned acquisition (§16), vendored/offline. FR-013 rootless =
DynamicUser; x86_64-only for now.
