# ADR-0009 — On-device capsule execution: systemd transient units as the launcher

- Status: ACCEPTED (2026-06-23, orchestrator) — wave-4 design gate. Accepted under the owner's standing
  "continue, don't ask / build to completion" directive + the R0–R4 autonomy override, because the recommendation
  is the CONSERVATIVE reuse path (no new sandbox primitive: the FIRST slice runs a `ts-service` capsule under the
  SAME systemd-hardened Deno profile already host-verified) and it is implemented behind the cross-review +
  host-verify quality floor. **OWNER MAY REDIRECT** — this defines the node's untrusted-workload-execution + attack-
  surface model; the orchestrator surfaced it transparently rather than blocking. Conditions on acceptance (below).
- Deciders: orchestrator (architecture), conservatively, per standing autonomy. R3-class surface: this wires the
  first privileged code path that *spawns workloads*. Recorded in `ai-factory/STATE.md`.
- ACCEPTANCE CONDITIONS (orchestrator): (1) wave 4 ships `ts-service` ONLY first (no OCI/WASM runtime staged until a
  dedicated, separately-reviewed slice); (2) cgroup-limit ENFORCEMENT (not just acceptance) must be confirmed on a
  REAL verity-node boot before any slice relies on resource caps (the WSL spike only proved properties are recorded);
  (3) the volume user/group isolation model is resolved before the volumes slice (S3); (4) `SO_PEERCRED` peer-cred
  auth on the ADR-0008 socket is filed as a hardening to land alongside/soon-after `capsule.execute` (the spawn
  capability raises the impact of the currently-unauthenticated channel); (5) agentd composes the transient unit ONLY
  from a manifest it re-validates — never from raw runtime-supplied unit properties.
- Related: ADR-0002 (privileged Go agent), ADR-0003 (Deno TS runtime), ADR-0006 (package-isolation
  baseline: Deno/Wasmtime/rootless-OCI/microVM + AppArmor/seccomp/namespaces/cgroup v2), ADR-0008
  (TS↔agentd unix-socket transport). Spec §5 (mandatory seccomp/namespaces/cgroup v2), §7.1
  (untrusted-by-default workloads), §9.3 (TS sandbox: no FFI/native/lifecycle/unrestricted
  subprocess), §3.10/§16 (privilege split; signing keys withheld). Wave-4 map in `ai-factory/STATE.md`.

## Context

The node can **install** capsules but cannot **run** them. Today:

- The capsule registry (`agent/capabilities/capsule/capsule.go`) records installed capsules as
  `CapsuleEntry{id, version, integrity, state}` and applies a desired registry transactionally over
  the agentd `/apply` boundary. That is *bookkeeping* — nothing is launched.
- The manifest (`storage/capsules/src/capsule.ts`) models four runtime descriptor kinds:
  `runtime.ociImageIndexes[]`, `runtime.wasmComponents[]`, `runtime.typescript`
  (source/compiled), plus policy (`dataGrants`, `networkGrants`, `resourceLimits{cpuCores, ramMiB,
  storageMiB}`, `identityBindings`), and `simulation.expectedHealthChecks` (`http`/`tcp`/`lifecycle`).
- The package contract (`sdk/manifests/src/package-contract.ts`) carries `packageClass`
  (`ts-service` | `ts-extension` | `wasm-component` | `oci-service` | `microvm-service` |
  `ui-extension` | `native-extension`), `healthChecks`, `resources`, `network`, and
  `data.volumes[]{name, mountPath, class, access, persistence, backup, sizeMiB}`.
- The privilege split is established and host-verified (ADR-0002/0008): **agentd is the only
  privileged component**; the **TS runtime is unprivileged** (`DynamicUser`, empty capability set,
  `RestrictAddressFamilies=AF_UNIX`) and may only *propose* over the unix socket — agentd
  re-validates every plan and fails closed.
- The unprivileged Deno sandbox already maps broker grants to a deny-by-default permission set and
  expects workload data under `VOLUME_MOUNT_ROOT=/var/lib/vita/runtime/volumes/<scope>`
  (`packages/runtime/src/sandbox.ts`).

So the unanswered question is purely: **what process actually carries a capsule workload, and who
launches it under what isolation?** That is this ADR.

### Spike findings (build host, 2026-06-23)

Host: Ubuntu 26.04 LTS under WSL2 (kernel 6.6.87.2-microsoft-standard-WSL2), **systemd 259**. This is
the same WSL build/boot-verify host used for the boot chain; the production target is the
verity-booted node where systemd is PID 1 with full cgroup v2 delegation.

| Probe | Result |
|---|---|
| `systemd-run` present + supports transient `--property` (`-p`) | **YES** (`/usr/bin/systemd-run`, systemd 259) |
| `systemd-nspawn` present | YES (`/usr/bin/systemd-nspawn`) |
| cgroup v2 unified, with controllers | **YES** — `cpuset cpu io memory hugetlb pids rdma` at `/sys/fs/cgroup` |
| `runc` / `crun` / `podman` / `docker` / `nerdctl` / `youki` | **ALL ABSENT** — no OCI runtime is installed/staged |
| Transient unit accepts the full hardening + resource property set | **YES** — `DynamicUser`, `PrivateTmp`, `PrivateDevices`, `ProtectSystem=strict`, `NoNewPrivileges`, `RestrictNamespaces`, `RestrictAddressFamilies=AF_UNIX`, `SystemCallFilter=@system-service`, `CapabilityBoundingSet=`, `MemoryMax`, `CPUQuota`, `TasksMax` — unit ran, exit OK |
| `DynamicUser=yes` allocates a real transient unprivileged identity | **YES** — observed `uid=61408(vita-du2) gid=61408(vita-du2)` (no static account) |
| Mount/data isolation primitives enforce | **YES** — `TemporaryFileSystem=/data` (ephemeral writable), `BindReadOnlyPaths=src:dst` (RO bind), `ProtectSystem=strict` (rootfs RO: write to `/usr` refused) all observed |
| systemd records the props (authoritative, WSL-independent) via `systemctl show` | **YES** — `MemoryMax=50331648`, `CPUQuotaPerSecUSec=250ms`, `TasksMax=16`, `DynamicUser=yes`, `RestrictAddressFamilies=AF_UNIX`, `SystemCallFilter=<expanded @system-service allowlist>`, `NoNewPrivileges=yes`, `ProtectSystem=strict`, `BindReadOnlyPaths=…:rbind` |
| Unprivileged user namespaces available | `user.max_user_namespaces=62817` (non-zero → available; `unprivileged_userns_clone` unset on this kernel) |

**Honest caveat:** under WSL, per-unit cgroup *readback* from inside the spawned process
(`/proc/self/cgroup` → `/init.scope`, and `/sys/fs/cgroup<cg>/memory.max` empty) is **not
observable** — WSL2 runs systemd PID-namespaced under `init.scope` without full per-unit cgroup
exposure to leaf processes. This is a WSL limitation, **not** a systemd one: `systemctl show` proves
the controller values are *recorded on the unit*, and the node's real target (verity boot, systemd as
PID 1) has full cgroup v2 delegation already proven by the boot chain. The cgroup-*enforcement*
readback must be re-confirmed on a real node boot (see Unknowns) but the property surface is
confirmed accepted today.

**Bottom line of the spike:** a `systemd-run`-style transient unit on the target accepts *every*
isolation knob a capsule workload needs — the same hardening already battle-tested in
`vita-ts.service` — including per-capsule `DynamicUser` identity and cgroup resource caps that map
1:1 onto `CapsuleResourceLimits`. No OCI runtime exists on the node yet; standing one up is a
separate, larger slice.

## The launcher decision (the core fork)

Three candidates for "what launches and supervises a capsule workload":

### Option A — systemd transient unit (`systemd-run`-equivalent), agentd-driven  *(RECOMMENDED)*

agentd, as the privileged component, asks systemd (PID 1) to start a **transient `.service` unit**
per capsule, applying isolation via unit properties — the *exact* mechanism, spike-confirmed, that
already hardens `vita-ts.service`.

- **Pros:**
  - **Reuses the proven, host-verified hardening surface.** Every knob in `vita-ts.service`
    (`DynamicUser`, `CapabilityBoundingSet=`, `NoNewPrivileges`, `ProtectSystem=strict`,
    `RestrictAddressFamilies`, `SystemCallFilter=@system-service`, `ProtectKernel*`,
    `RestrictNamespaces`, …) applies verbatim to a transient unit. Spec §5's mandatory
    seccomp/namespaces/cgroup v2 are satisfied by systemd's own implementation, not bespoke code.
  - **cgroup v2 resource caps map 1:1 to the manifest.** `resourceLimits.ramMiB→MemoryMax`,
    `cpuCores→CPUQuota`, `storageMiB→` (quota via volume sizing / `TasksMax` etc.). The controllers
    we need (`cpu memory pids io`) are present.
  - **Per-capsule user isolation for free.** `DynamicUser=yes` yields a transient unprivileged
    UID/GID per workload (spike: `uid=61408`) — no static accounts, no UID bookkeeping.
  - **Supervision, restart, lifecycle, journald logging, and `systemctl show`-based state are
    already there.** agentd does not reimplement a process supervisor, a restart policy, or a log
    pipe — it delegates to PID 1, the most-tested supervisor on the box.
  - **Smallest privileged code surface.** agentd's new job is "compose a vetted property set + ask
    systemd to start/stop a unit," not "fork/exec + drop privileges + set up namespaces + install a
    seccomp BPF program + manage a cgroup tree" by hand. Less novel privileged C-equivalent code =
    less attack surface (spec §18.6 spirit).
  - **Mirrors the existing `services.go` pattern.** That capability already models systemd units
    declaratively and validates unit names; a capsule-execution capability is the same shape one
    level up (it *starts transient* units instead of *enabling installed* ones).
- **Cons:**
  - Couples capsule execution to systemd (already a hard dependency of the whole OS — acceptable).
  - A transient unit alone runs a **host process**, not an OCI container or a microVM. For OCI/WASM
    workloads the unit's `ExecStart` must invoke a runtime *inside* the hardened unit (see Runtime
    types) — i.e. systemd is the *supervisor/jailer*, and a per-class runtime is the *executor*.
  - Transient-unit property composition from an untrusted manifest is a **new injection surface**
    that agentd must validate as strictly as `services.go` validates unit names (see Sandbox surface).

### Option B — agentd direct process supervision (bespoke supervisor)

agentd forks/execs the workload itself, sets up namespaces (`clone`), drops capabilities, installs a
seccomp BPF filter, and manages a cgroup subtree directly.

- **Pros:** zero systemd coupling for the workload; full control of every step.
- **Cons:** **Reimplements, in privileged Go, everything systemd already does and we have already
  hardened and host-verified.** This is exactly the "bespoke supervisor" the team-lead heuristics and
  this ADR's mandate tell us to avoid "if reuse is viable" — and the spike shows reuse *is* viable.
  Every line of namespace/seccomp/cgroup setup is new privileged code = new R3/R4 attack surface,
  new failure modes, new audit burden. Restart policy, log capture, and state tracking all become our
  code. **Rejected** unless a concrete workload need cannot be expressed as systemd unit properties.

### Option C — `systemd-nspawn` container

agentd launches each capsule in an `systemd-nspawn` container (a full OS-container with its own init).

- **Pros:** strong filesystem/PID/network isolation; present on the host; integrates with systemd.
- **Cons:** heavier than a single hardened service for the common case (a `ts-service` or a single
  OCI image is not a full OS tree); image/rootfs management is a bigger lift than the first slice
  needs; overlaps with the OCI-runtime story without being OCI-standard. Better revisited for the
  `microvm-service` / strong-isolation class in **wave 4b**, not the first slice.

### Recommendation

**Adopt Option A: agentd launches each capsule as a hardened systemd transient unit, reusing the
`vita-ts.service` hardening profile as the baseline.** It maximizes reuse of a proven, host-verified
isolation surface; keeps the new privileged code surface minimal; maps the manifest's
resource/health/volume model onto mechanisms systemd already enforces; and mirrors the existing
`services.go` capability shape. Options B and C are not chosen now (B reimplements what we trust; C is
heavier than the first slice warrants) — C is explicitly **revisited in wave 4b** for the
strong-isolation/microVM class.

> **Owner/orchestrator to confirm:** that coupling capsule execution to systemd (already a hard OS
> dependency) is acceptable as the durable model, and that agentd composing transient-unit properties
> from a (validated) manifest is the accepted privileged path. This is the load-bearing decision.

## Runtime types — mapping the four runtimes onto the launcher

The launcher (a hardened transient unit) is the **jailer**; what runs *inside* it is the per-class
**executor**:

| `packageClass` | Executor inside the hardened unit | Wave |
|---|---|---|
| **`ts-service`** | The pinned vendored Deno (`/usr/lib/vita/deno`) with broker-derived `--allow-*` — *identical* to `vita-ts.service`, just `Type` and `ExecStart` differ. | **Wave 4 FIRST** |
| `wasm-component` | A pinned WASM runtime (Wasmtime/WASI per ADR-0006) invoked as `ExecStart`, component from `runtime.wasmComponents[].ref`. | Wave 4b (needs a staged Wasmtime) |
| `oci-service` | A rootless OCI runtime (`crun`/`runc`) invoked as `ExecStart` against an unpacked OCI image. **Requires staging an OCI runtime — absent today (spike).** | Wave 4b |
| `microvm-service` | A microVM monitor (e.g. cloud-hypervisor/firecracker) — strongest isolation; likely Option C/nspawn or a VMM. | **Deferred** (wave 4b+) |

**Wave 4 targets `ts-service` FIRST.** Rationale: it requires *no new runtime on the node* — the
pinned Deno is already staged, hardened, and host-verified end-to-end; the broker→Deno-permission
mapping (`packages/runtime/src/sandbox.ts`) already exists; and it exercises the entire
launch→isolate→health→supervise→audit path with the *fewest* novel moving parts. OCI is the natural
second (most capsules will be OCI), but it is gated on staging + verifying an OCI runtime — a real
slice of its own (it also re-opens the "verify-by-SRI of fetched image layers" work). WASM follows
OCI. microVM is deferred until the strong-isolation class is actually needed.

## Privilege split + sandbox surface

Unchanged in shape from ADR-0002/0008 — extended by one capability:

- **The TS runtime only proposes.** A new `capsule.execute` capability is requested by the
  unprivileged TS runtime over the existing `/apply` unix-socket boundary (ADR-0008). It carries the
  *desired execution state* of an already-installed, registry-known capsule (by id+version+integrity)
  — never a workload payload, never raw unit text. Same posture as `capsule.registry` /
  `services.config`: the runtime proposes, agentd disposes.
- **agentd launches (privileged).** agentd alone: resolves the capsule from the registry, derives the
  hardened transient-unit property set from the manifest, asks systemd to start/stop the unit, and
  records the result + undo in its transaction engine and audit log. It re-validates every field and
  **fails closed** on anything it cannot prove safe (the established pattern: see `services.go`
  `validServiceName`, `containsInlineServiceMaterial`, and capsule.go's SRI/inline-material guards).
- **The workload sandbox** (per launched unit) is the `vita-ts.service` profile as the baseline:
  `DynamicUser=yes` (per-capsule transient UID/GID), `CapabilityBoundingSet=` + `AmbientCapabilities=`
  (zero capabilities), `NoNewPrivileges=yes`, `ProtectSystem=strict`, `PrivateTmp/PrivateDevices`,
  `ProtectKernel*`, `RestrictNamespaces`, `RestrictRealtime`, `LockPersonality`,
  `SystemCallArchitectures=native`, `SystemCallFilter=@system-service` (+ the minimal pkey add Deno
  needs), and `RestrictAddressFamilies=AF_UNIX` *unless* a `networkGrant` widens it.
- **Data isolation = VOLUME_MOUNT_ROOT via bind mounts.** The manifest's `data.volumes[]` /
  `dataGrants` map to systemd `BindPaths`/`BindReadOnlyPaths` rooting each granted volume at
  `/var/lib/vita/runtime/volumes/<scope>` inside the unit — the exact path the Deno sandbox already
  expects (`packages/runtime/src/sandbox.ts`). `read-only` grants → `BindReadOnlyPaths`; `read-write`
  → `BindPaths`; `ephemeral` persistence → `TemporaryFileSystem`. All three primitives are
  spike-confirmed to enforce. The workload sees *only* its granted volumes; the rest of the host FS is
  RO/invisible.
- **Resource caps** from `resourceLimits` → `MemoryMax` / `CPUQuota` / `TasksMax` (cgroup v2),
  spike-confirmed as recorded properties.

### New attack surface (stated honestly)

1. **agentd now spawns workloads.** This is the first privileged path that *executes attacker-influenced
   payloads*. The whole security rests on (a) agentd composing the unit from a *validated* manifest, never
   from runtime-supplied free text, and (b) the hardening profile being applied with no gaps. A missing
   or misapplied property (e.g. forgetting `CapabilityBoundingSet=` on one code path) is a privilege
   leak. Mitigation: a *single* hardened-profile builder in agentd, default-deny, with the profile
   asserted in tests (parallel to how `vita-ts.service` is fixed in the image).
2. **Transient-unit property injection.** Any manifest-derived string that reaches a unit property
   (unit name, `ExecStart` args, bind-mount paths, env) is an injection vector — exactly the class
   `services.go`/`capsule.go` already defend against (control chars, inline secrets, `..`, path
   separators, reference schemes). The execute capability MUST reuse/extend those validators and reject
   anything not matching a strict allowlist. Bind-mount sources must be confined under
   `VOLUME_MOUNT_ROOT`; `ExecStart` must be the pinned executor binary by absolute path, never a
   manifest-supplied command.
3. **Unauthenticated control channel (inherited from ADR-0008).** `capsule.execute` rides the same
   unix socket with *no peer-credential auth yet*. Filed there; calling it out again because "start an
   arbitrary installed workload" is higher-impact than "write a config file." The future `SO_PEERCRED`
   hardening becomes more urgent once execute lands.
4. **cgroup-enforcement not yet observed on a real node** (WSL caveat) — a resource cap that is
   *recorded* but not *enforced* would be a DoS/escape risk for a hostile workload. Must be confirmed on
   a node boot before any untrusted capsule runs (Unknowns).

## First slice + proof marker

**Smallest end-to-end: run one trivial *first-party* `ts-service` capsule as a hardened transient
unit and observe it healthy.**

1. agentd gains a minimal `capsule.execute` capability (R3): given an installed, registry-known
   capsule id+version, it composes the `vita-ts.service` hardening profile into a **transient
   `.service`** whose `ExecStart` is the pinned Deno running the capsule's TS entrypoint, applies
   `MemoryMax`/`CPUQuota`/`TasksMax` from `resourceLimits`, starts it, and records start+undo (stop) in
   the transaction engine + audit log. Fails closed on any validation miss (mirrors `services.go`).
2. The capsule's trivial workload (a fixed, in-image first-party TS service for the proof) binds a
   `lifecycle`/`http` health target the manifest declares; agentd (or the wave-4 S4 health poller)
   confirms it.
3. The TS runtime, at boot, *proposes* `capsule.execute` for that capsule over the unix socket; agentd
   launches it.

**Proof marker (serial / journald, grep-able, in the `VITA-CAPSULE-*` family):**

```
VITA-CAPSULE-EXECUTED: id=<capsule-id> unit=<transient-unit> uid=<dynamic-uid> mem=<MemoryMax> health=OK status=OK
```

plus a fail-closed counterpart proving the guard works (e.g. an unknown capsule id or an
unsatisfiable grant):

```
VITA-CAPSULE-EXECUTE-REJECT: reason=<sanitized-reason>
```

Host-verified via `wsl-verify` (same harness that guards the VITA-TS→…→CAPSULE chain), and re-confirmed
on a real verity node boot for the cgroup-enforcement check.

## Honest unknowns / spikes still needed

- **cgroup v2 enforcement on a real node** (not just recorded). WSL hides per-unit cgroup readback;
  confirm `MemoryMax`/`CPUQuota`/`TasksMax` actually throttle a hostile workload on a verity boot.
- **Transient unit + verity-RO root interplay.** `vita-ts.service` already runs under verity-RO with
  `DENO_DIR` on tmpfs and `RuntimeDirectory`; confirm transient units created by agentd at runtime get
  the same writable-runtime story (RuntimeDirectory/StateDirectory ownership for the DynamicUser).
- **How agentd talks to systemd.** Via the D-Bus manager API (`StartTransientUnit`) vs shelling
  `systemd-run`. D-Bus is the cleaner, auditable, no-string-parsing path and avoids a subprocess (spec
  §9.3 spirit), but adds a dependency; `systemd-run` is simpler but is "privileged subprocess with
  composed args." **Spike both; lean D-Bus.** (Decide in the S6 execute-capability slice.)
- **User/group isolation model — confirm the policy.** Default is `DynamicUser=yes` (ephemeral
  per-launch UID, no persistent ownership). This is ideal for stateless `ts-service` but complicates
  **persistent volumes** (a new ephemeral UID each start won't own last run's files). Options:
  (a) per-capsule *stable* allocated UID/GID with `StateDirectory` ownership, or (b) `DynamicUser` +
  a per-capsule supplementary group that owns the volume (the `vita-agent`-group pattern from ADR-0008,
  generalized). **Recommend (b) for the first stateless slice; resolve persistent-volume ownership
  before the volumes slice (S3).** Owner to confirm the durable identity model.
- **Health-check execution** (`http`/`tcp`/`lifecycle`) is the separate S4 poller; this ADR only
  requires the first slice *observe* health, not build the general poller.

## Deferred to wave 4b (explicitly out of scope here)

- **OCI runtime** staging + rootless launch + image fetch/unpack/**verify-by-SRI** (`oci-service`).
  No runtime is on the node today (spike). This is the natural *second* runtime and a large slice.
- **WASM runtime** staging + WASI launch (`wasm-component`).
- **microVM** execution (`microvm-service`) and the strong-isolation class (revisit Option C/nspawn or
  a VMM).
- **General health poller** (S4), **workload state + audit surface** (S5), and the **full
  `capsule.execute` orchestrator** (S6) beyond the trivial first slice.
- **`SO_PEERCRED` auth** on the unix socket (inherited from ADR-0008; more urgent once execute lands).
