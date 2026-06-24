# TypeScript-First Personal Node OS
## Product and AI-Native Build Specification

**Working name:** Project Node  
**Document status:** Draft v0.1  
**Date:** 2026-06-20  
**Purpose:** Define a phased build plan for a TypeScript-first personal-data and self-hosting operating environment, delivered across x86-64 PCs, Raspberry Pi 5, and AI systems through a coordinated human/AI engineering organization.

---

## 1. Executive decision

Build a **TypeScript-first operating environment on a hardened Linux substrate**.

Users and application developers experience the system as TypeScript:

- System configuration is stored in typed `.ts` files.
- Apps, policies, automations, dashboards, and device integrations are defined in TypeScript.
- TypeScript files produce a declarative desired-state plan.
- A small privileged Go agent validates and applies that plan.
- Untrusted TypeScript runs in Deno sandboxes, WASM sandboxes, containers, or microVMs.
- Linux remains responsible for boot, drivers, memory, storage, networking, process isolation, and virtualization.

The product is a **UniFi-like control plane for personal data infrastructure**, covering:

- Nodes and hardware capabilities
- Storage and encryption
- Local identity and permissions
- Applications and services
- Backups and recovery
- Networking and remote access
- PDS modules
- Runtime and data portability
- GPU/NPU/AI workloads
- Device health and updates

The initial product is not a custom kernel, mobile replacement OS, general-purpose Linux distribution, or unrestricted npm server.

---

## 2. Terms

| Term | Meaning |
|---|---|
| **Node** | A physical or virtual machine managed by the product |
| **Controller** | The UniFi-like local control plane for one or more nodes |
| **TypeScript system model** | Typed `.ts` files that declare desired system state |
| **System agent** | Narrow privileged Go service that performs approved host operations |
| **Capsule** | Portable bundle of application contract, runtime artifacts, data, policies, and migrations |
| **PDS module** | A Personal Data Server implementation such as an AT Protocol PDS |
| **App package** | A signed TS, WASM, or OCI workload that conforms to the product contract |
| **Host edition** | Product runtime installed on an OEM/vendor OS without replacing its kernel |
| **Native edition** | Complete signed OS image supplied by the project |
| **AI loop** | Repeated specification, implementation, testing, review, measurement, and process-improvement cycle performed by coordinated agents under human governance |

“Node” refers to a managed machine. Node.js is separately called **Node.js**.

---

## 3. Product principles

1. **TypeScript is the product surface.** Ordinary customization should require TypeScript, not shell scripts, YAML, systemd units, or direct root access.
2. **Linux is an implementation detail.** Users should not administer the base distribution.
3. **Desired state is declarative.** TypeScript code returns a plan; it does not directly mutate the host.
4. **The privileged core is small.** The Go agent exposes narrow typed capabilities and rejects arbitrary commands.
5. **Local operation is primary.** Core functions continue without the vendor cloud.
6. **Data outlives apps and devices.** Backups, exports, and capsules must remain usable after hardware or application replacement.
7. **Portability is tested, not claimed.** Every supported package declares architectures, resources, permissions, accelerators, backup hooks, and migration behavior.
8. **Hardware support is certified.** “Boots” and “supported” are not treated as equivalent.
9. **CPU fallback is mandatory.** GPU/NPU acceleration is optional unless an application is explicitly classified as accelerator-only.
10. **Agents produce work; humans retain intent and authority.** Humans own product direction, security boundaries, budgets, release approval, and irreversible decisions.

---

## 4. Scope

### 4.1 Version 1 scope

- Native image for UEFI x86-64 Intel and AMD PCs
- Native image for Raspberry Pi 5
- Host edition for NVIDIA DGX Spark and other vendor-managed AI systems
- Local web controller
- Optional remote controller access
- Multi-node inventory and health
- TypeScript system configuration
- TypeScript automation runtime
- Deno and npm package compatibility
- WASM extension runtime
- Rootless OCI application runtime
- Storage pools, encryption, snapshots, and backups
- Local identity, passkeys, roles, and application permissions
- Signed updates with automatic rollback
- Files, shared folders, and general data services
- AT Protocol PDS as the first PDS module
- Portable application/data capsules
- Runtime simulation for x86-64, ARM64, offline, low-memory, and no-accelerator profiles
- GPU/NPU capability detection and workload routing
- Developer CLI and SDK

### 4.2 Explicit non-goals for Version 1

- A new kernel
- A new physical filesystem
- A full iOS replacement
- A universal Android replacement
- Support for arbitrary Linux hardware
- Direct execution of arbitrary npm packages with host privileges
- Kubernetes
- Email hosting
- A universal personal-data ontology
- Model training or modification of the AI agents themselves
- Fully autonomous release to production

---

## 5. Platform and version baseline

This is the initial engineering baseline, not a promise to freeze every dependency indefinitely. Each release ships a signed bill of materials and exact lockfile.

| Layer | Initial baseline | Policy |
|---|---|---|
| Base userland | Debian 13.5 “trixie” | Security-patched, rebuilt as immutable product images |
| Generic kernel | Linux 6.18.y LTS | x86-64 and generic ARM64 certification line |
| Raspberry Pi kernel | Raspberry Pi downstream 6.12.y initially | Move to 6.18.y only after hardware qualification; current upstream/downstream regressions make immediate adoption unsuitable |
| AI vendor systems | Vendor-supported kernel and drivers | Host edition first; native image only after vendor stack qualification |
| Init/service manager | systemd from Debian 13 | No alternate init support in v1 |
| Privileged agent | Go 1.26.4 | Static builds where practical; patch updates through release train |
| TypeScript language | TypeScript 6.0 stable at bootstrap | Code must pass TypeScript 7 compatibility CI; switch production compiler after TypeScript 7 GA and soak period |
| TypeScript runtime | Deno 2.8 | Primary first-party TS runtime and permission broker client |
| Node.js compatibility | Node.js 24 LTS | Compatibility target for packages and OCI apps |
| Bun | Bun 1.3.14 | Optional developer/test runner; not trusted privileged runtime |
| WASM runtime | Wasmtime 36 LTS | Isolated extensions and portable logic |
| Containers | Rootless Podman/OCI | Version pinned by OS image; multi-architecture image indexes required |
| Storage | LUKS2 + Btrfs | Separate immutable OS and encrypted mutable data |
| Update framework | RAUC A/B bundles | Signed, transactional, offline-capable updates |
| Boot, x86 | UEFI, Secure Boot, signed UKI | TPM measurement and automatic boot assessment |
| Boot, Raspberry Pi | Raspberry Pi firmware plus signed boot artifacts | A/B root slots and recovery partition |
| Host sandboxing | AppArmor, seccomp, namespaces, cgroup v2 | Mandatory for all non-core workloads |
| API schema | Protobuf plus Connect-compatible RPC | Generated Go and TypeScript clients |
| UI | TypeScript web application | Exact framework version pinned per release |
| Build reproducibility | Nix-pinned toolchains plus deterministic image pipeline | Nix is internal; users do not configure the OS with Nix |

### 5.1 TypeScript 7 transition rule

The product may be marketed as TypeScript-first, but release stability takes precedence over a version label.

- `main` must compile with the stable TypeScript release.
- A protected CI lane must compile with the TypeScript 7 release candidate.
- No new code may use behavior known to be removed in TypeScript 7.
- Production switches to TypeScript 7 only after GA, dependency compatibility, reproducible-build confirmation, and a minimum 14-day soak.
- Compiler changes are treated as platform migrations, not routine package updates.

---

## 6. Hardware support model

### 6.1 Support tiers

| Tier | Definition |
|---|---|
| **Certified** | Full install, boot, suspend where applicable, storage, networking, updates, rollback, backup, accelerators, and thermal testing |
| **Compatible** | Hardware capability scan passes; best-effort support |
| **Experimental** | Builds are published, but no reliability or update guarantee |
| **Host-only** | Product runs on the vendor OS and does not replace its kernel or driver stack |

### 6.2 Initial hardware matrix

| Platform | Initial status | Notes |
|---|---|---|
| UEFI x86-64 mini-PC, Intel iGPU | Certified reference target | Primary development appliance |
| UEFI x86-64 mini-PC, AMD Ryzen/Radeon | Certified reference target | Includes modern GPU/NPU capability discovery |
| General modern Intel/AMD PC | Compatible beta | Requires UEFI, 8 GB RAM, supported storage/networking |
| Raspberry Pi 5, 8 GB | Certified reference target | NVMe recommended; SD card is not authoritative data storage |
| Raspberry Pi 5, 4 GB | Compatible constrained target | Reduced app and AI workload limits |
| Raspberry Pi 4 | Experimental | Not a v1 performance baseline |
| NVIDIA DGX Spark | Host-only, then certified | Preserve DGX OS, NVIDIA drivers, firmware, and support path |
| Intel Core Ultra AI PC | Compatible AI target | OpenVINO/NPU adapter |
| AMD Ryzen AI PC | Compatible AI target | Ryzen AI/ROCm adapter where vendor support is available |
| NVIDIA discrete GPU PC | Compatible AI target | NVIDIA container toolkit adapter |

### 6.3 Minimum node requirements

**General x86-64:**

- UEFI
- 64-bit CPU
- 8 GB RAM; 16 GB recommended
- 64 GB boot device; 256 GB or more data storage recommended
- Ethernet
- Hardware virtualization recommended
- TPM 2.0 recommended and required for automatic sealed-key unlock in certified systems

**Raspberry Pi 5:**

- 4 GB RAM minimum; 8 GB recommended
- Official or qualified power supply
- NVMe storage for the data partition
- Active cooling for sustained workloads
- Ethernet for initial certification

---

## 7. System architecture

```text
Hardware
  |
  +-- Firmware / UEFI / Raspberry Pi firmware
  +-- Signed boot artifacts and recovery environment
  +-- Linux kernel and hardware drivers
  +-- Immutable Debian-based root filesystem
         |
         +-- Go system agent
         |     +-- storage capability
         |     +-- network capability
         |     +-- update capability
         |     +-- workload capability
         |     +-- identity capability
         |     +-- hardware/accelerator capability
         |
         +-- TypeScript control plane on Deno
         |     +-- desired-state evaluator
         |     +-- controller API
         |     +-- events and automation
         |     +-- package catalog
         |     +-- PDS module manager
         |
         +-- Workload isolation
         |     +-- Deno permission sandbox
         |     +-- Wasmtime/WASI
         |     +-- rootless OCI containers
         |     +-- optional microVMs
         |
         +-- Encrypted data plane
               +-- system database
               +-- user data
               +-- app data
               +-- snapshots
               +-- backups
               +-- capsules
```

### 7.1 Trust boundaries

**Trusted computing base:**

- Firmware trust and boot verification
- Linux kernel
- initramfs/recovery
- Go system agent
- update verifier
- key and identity services
- policy decision engine

**Semi-trusted:**

- First-party TypeScript controller
- First-party services
- Verified app packages

**Untrusted by default:**

- Community npm packages
- User scripts
- Imported containers
- Third-party apps
- AI-generated code
- Development environments
- Data parsers and importers

No untrusted workload may access the system-agent socket directly.

---

## 8. TypeScript system model

### 8.1 User-visible files

```text
/system/
  system.ts
  users.ts
  network.ts
  storage.ts
  backups.ts
  policies.ts
  apps/
    photos.ts
    atproto-pds.ts
    dev-environment.ts
  automations/
    backup-warning.ts
    move-ai-workload.ts
```

### 8.2 Execution model

A TypeScript configuration file:

1. Executes in a deterministic, no-I/O planning sandbox.
2. Receives an immutable typed snapshot of discovered capabilities and current state.
3. Returns a desired-state object.
4. Is type-checked and schema-validated.
5. Is converted into a canonical signed plan.
6. Produces a human-readable diff.
7. Is evaluated against policy.
8. Is applied transactionally through the Go agent.
9. Is rolled back if health checks fail.

It may not directly:

- Run a shell
- Open arbitrary files
- Access the network
- Read secrets
- Modify the host
- Load unpinned remote code
- Invoke native addons or FFI

### 8.3 Example

```ts
import { defineSystem, app, backup } from "@project/sdk";

export default defineSystem(({ device, data }) => ({
  identity: {
    passkeysRequired: true,
  },

  storage: {
    dataVolume: {
      encryption: "required",
      snapshots: "hourly",
    },
  },

  apps: [
    app("atproto-pds", {
      publicAccess: true,
      memory: device.memoryGB >= 16 ? "2GiB" : "1GiB",
    }),

    app("local-search", {
      accelerator: device.ai.bestAvailable({
        prefer: ["npu", "gpu", "cpu"],
        requireFallback: "cpu",
      }),
      dataAccess: [data.files.readOnly()],
    }),
  ],

  backups: [
    backup.usb({ schedule: "daily" }),
  ],
}));
```

### 8.4 Configuration invariants

- Same inputs must produce the same plan.
- All external state must be passed explicitly.
- The plan is inspectable before application.
- Plans are versioned and migratable.
- The system database records both source and normalized plan.
- Manual host changes are detected as drift.
- Drift is either reverted or explicitly adopted into TypeScript state.

---

## 9. Workload and package model

### 9.1 Package classes

| Class | Runtime | Typical use |
|---|---|---|
| `ts-service` | Deno | First-party services, APIs, automations |
| `ts-extension` | Deno worker | Controller plugins with narrow permissions |
| `wasm-component` | Wasmtime | Portable, strongly sandboxed extensions |
| `oci-service` | Rootless Podman | Existing self-hosted applications |
| `microvm-service` | MicroVM | Untrusted dev environments and high-risk code |
| `ui-extension` | Sandboxed browser module | Dashboard views and widgets |
| `native-extension` | Host package | Project-maintained drivers only; never community-installed |

### 9.2 Package contract

Every package declares:

- Package identity and signing publisher
- Version and immutable digest
- Architectures
- Minimum CPU/RAM/storage
- Required and optional GPU/NPU capabilities
- Network ingress and egress
- Data classes and volumes
- Secret requirements
- Backup and quiesce hooks
- Restore verification
- Health checks
- Update and schema migrations
- Rollback limits
- Export formats
- End-of-support date
- SBOM and vulnerability status
- Required simulation profiles

### 9.3 npm and JSR policy

- Lockfiles are mandatory.
- Remote imports are forbidden in production artifacts.
- Package lifecycle scripts are denied by default.
- Native Node-API addons are denied in TS sandboxes.
- FFI and unrestricted subprocess permissions are denied.
- Dependencies are mirrored, hashed, scanned, and retained for reproducibility.
- A package may use npm compatibility without receiving Node.js-style unrestricted host access.
- Community packages run in a lower trust tier than verified packages.

---

## 10. Data, storage, and backup

### 10.1 Disk layout

```text
EFI / boot
Recovery
Root A: immutable, dm-verity
Root B: immutable, dm-verity
Encrypted data:
  system state
  user data
  app state
  snapshots
  local backup cache
```

### 10.2 Storage requirements

- LUKS2 encryption for authoritative data
- TPM-assisted unlock on supported systems
- Offline recovery key
- Btrfs checksums, subvolumes, quotas, and read-only snapshots
- App-specific subvolumes
- No application can delete platform-controlled snapshots
- Disk-health monitoring
- Disk-full emergency mode
- Export to ordinary files and documented structured formats
- No custom physical filesystem in v1

### 10.3 Backup levels

- Local snapshot
- Independent attached-disk backup
- Peer-node encrypted backup
- Customer-selected remote object/SFTP target
- Optional vendor-managed encrypted backup

A mirror is never displayed as a backup.

### 10.4 Recovery requirements

The system must recover from:

- Deleted file
- Failed app update
- Failed OS update
- Corrupt system state
- Single disk failure
- Complete node loss
- Migration from x86-64 to ARM64 when the package has compatible artifacts
- Vendor-control-plane outage
- Vendor disappearance using public recovery tools

---

## 11. Identity and permissions

- Local identity authority
- Passkeys as the primary user authentication method
- Offline recovery mechanism
- Owner, administrator, member, restricted member, guest, and service roles
- Per-application data capabilities
- Per-application network capabilities
- Device pairing with physical confirmation
- No vendor account required for local use
- Optional external OIDC federation
- User-visible audit log
- Time-limited support access, explicitly approved and logged
- No universal or shared factory password

---

## 12. Networking

### 12.1 Default behavior

- LAN operation without cloud dependency
- Local discovery
- No public port exposure by default
- Private remote access through an outbound-established encrypted mesh
- Direct peer connection when available
- Replaceable encrypted relay fallback
- Public ingress enabled per application only
- Automated certificates
- Rate limiting and exposure reporting

### 12.2 Network policy

Every workload receives a generated policy:

- Default-deny inbound
- Default-deny or declared outbound
- Scoped service discovery
- No access to host management network
- No access to unrelated application networks
- Public exposure requires explicit user confirmation

---

## 13. Runtime portability and capsules

A capsule contains:

```text
manifest/
  package contract
  versions
  signatures
  SBOM

runtime/
  OCI image indexes
  WASM components
  TypeScript source or compiled artifact

state/
  application-consistent snapshot
  canonical exports
  migration metadata

policy/
  data grants
  network grants
  resource limits
  identity bindings

simulation/
  required profiles
  expected health checks
  failure tests
```

### 13.1 Portability rules

- Architecture-neutral logic should use TypeScript or WASM.
- Existing server software should use multi-architecture OCI images.
- Hardware-specific artifacts are selected through capabilities.
- App state must declare whether it is architecture-neutral.
- Derived AI indexes must be rebuildable or exportable.
- Secrets are referenced, not embedded.
- Capsules are encrypted and signed.
- Import never grants more permissions than the destination policy permits.

---

## 14. AI and accelerator support

### 14.1 Typed capabilities

```ts
type AcceleratorCapability =
  | { kind: "nvidia.cuda"; memoryGB: number; compute: string }
  | { kind: "intel.npu"; generation: string }
  | { kind: "amd.npu"; generation: string }
  | { kind: "amd.rocm"; memoryGB: number }
  | { kind: "intel.gpu"; memoryModel: "shared" | "dedicated" }
  | { kind: "cpu"; architecture: "x86_64" | "arm64" };
```

### 14.2 Adapter strategy

- NVIDIA: vendor driver, container toolkit, CUDA/TensorRT adapters
- Intel: OpenVINO adapter
- AMD: ROCm and Ryzen AI adapter where officially supported
- Generic: ONNX Runtime CPU execution
- Media: VA-API or vendor equivalent
- Scheduling: capability-based placement, not hard-coded device models

### 14.3 DGX Spark policy

The initial DGX Spark release is a **host edition** running on DGX OS. The project must not replace the vendor kernel, firmware, or driver update path until a full native image is validated and does not break NVIDIA’s supported stack.

---

## 15. Functional requirements

| ID | Requirement | Version gate |
|---|---|---|
| FR-001 | Install a signed native image on certified x86-64 hardware | v0.1 |
| FR-002 | Boot a signed native image on Raspberry Pi 5 | v0.2 |
| FR-003 | Install host edition on DGX Spark | v0.5 |
| FR-004 | Discover CPU, RAM, storage, networking, GPU, NPU, TPM, and virtualization capabilities | v0.2 |
| FR-005 | Evaluate deterministic TypeScript system configuration | v0.1 |
| FR-006 | Show plan diff before applying system changes | v0.1 |
| FR-007 | Apply plans transactionally and roll back failed changes | v0.2 |
| FR-008 | Display UniFi-style overview and node health | v0.1 |
| FR-009 | Manage multiple nodes from one controller | v0.5 |
| FR-010 | Install, update, stop, start, remove, and restore apps | v0.3 |
| FR-011 | Run Deno TS services with permission brokering | v0.3 |
| FR-012 | Run WASM components | v0.3 |
| FR-013 | Run rootless multi-architecture OCI services | v0.3 |
| FR-014 | Encrypt data and create snapshots | v0.2 |
| FR-015 | Back up and restore a complete node | v0.4 |
| FR-016 | Manage local identities, passkeys, roles, and grants | v0.3 |
| FR-017 | Provide private remote access without router configuration | v0.4 |
| FR-018 | Install and manage an AT Protocol PDS module | v0.4 |
| FR-019 | Export all first-party user data without active subscription | v0.4 |
| FR-020 | Move a capsule between x86-64 and ARM64 | v0.5 |
| FR-021 | Simulate low-memory, offline, no-accelerator, and migration profiles | v0.5 |
| FR-022 | Route compatible AI workloads to GPU/NPU with CPU fallback | v0.6 |
| FR-023 | Apply signed A/B OS updates and automatically revert failed boots | v0.2 |
| FR-024 | Generate a sanitized support bundle | v0.4 |
| FR-025 | Operate core functions with vendor services blocked | v0.9 |

---

## 16. Non-functional requirements

### Reliability

- At least 99.5% unattended OS-update success in beta; 99.9% target for v1
- Automatic rollback after failed boot or failed post-update health check
- No unrecoverable data loss across 10,000 automated power-failure simulations
- Quarterly full restore tests for every certified release train
- Every verified app passes backup, restore, upgrade, and export tests

### Performance

- Controller first meaningful LAN view under 2 seconds on certified x86 hardware
- Idle platform memory below 1.5 GB on x86 and below 1.0 GB on Raspberry Pi 5
- Boot to healthy controller under 60 seconds on x86 and under 90 seconds on Raspberry Pi 5
- Less than 5% platform overhead for ordinary containerized services, excluding security isolation overhead for high-risk workloads

### Portability

- First-party TS services support x86-64 and ARM64
- WASM extensions are architecture-neutral unless explicitly declared otherwise
- Verified OCI apps publish required architecture variants
- All first-party data types have documented export formats

### Security

- No default shared credentials
- Secure Boot on certified x86 hardware
- Signed OS and application artifacts
- Read-only verified system image
- Least-privilege runtime policies
- Reproducible build evidence
- SBOM for every release
- Critical vulnerability response procedure
- External security review before v0.9
- Release signing keys unavailable to development agents

### Privacy and sovereignty

- Local core operation without vendor login
- Vendor cannot decrypt local disks or backups
- Remote relay cannot inspect content
- Telemetry is opt-in and content-free
- Account cancellation does not disable local access
- Public recovery tooling exists before v1

---

## 17. Human and AI organization

### 17.1 Human leadership

A small human group owns judgment-heavy decisions:

- Product director
- Chief architect
- Security lead
- Platform/release lead
- Runtime/SDK lead
- UX lead
- Reliability/QA lead
- Legal/compliance advisor as needed

Humans approve:

- Product goals and priority
- Trust boundaries
- Architecture changes
- Protected test changes
- Security exceptions
- Release keys and production releases
- Data-loss risk
- Budget and compute limits
- Agent policy changes

### 17.2 Agent pods

Each workstream is a persistent pod with specialized subagents.

| Pod | Responsibilities |
|---|---|
| Product/specification | PRDs, user stories, acceptance criteria, terminology |
| Architecture | ADRs, interfaces, dependency boundaries |
| x86 platform | UEFI, UKI, kernel, installer, hardware matrix |
| Raspberry Pi platform | firmware, kernel, boot, thermal, NVMe |
| AI platform | DGX host edition, GPU/NPU adapters, capability detection |
| Image/update | immutable images, RAUC, rollback, recovery |
| Go agent | privileged capability service and transaction engine |
| TypeScript runtime | config evaluator, Deno runtime, SDK |
| Package platform | catalog, signatures, npm/JSR policy, OCI/WASM packages |
| Controller UI | dashboard, node, storage, identity, app, backup, AI views |
| Storage/recovery | encryption, Btrfs, snapshots, backups, restores |
| Identity/security | passkeys, roles, grants, audit, key management |
| Networking | discovery, mesh, relay, ingress, certificates |
| PDS/protocols | AT Protocol module and later protocol adapters |
| Portability/simulation | capsules, architecture migration, failure profiles |
| QA/reliability | integration tests, hardware labs, fault injection |
| Security red team | threat modeling, fuzzing, exploit testing |
| Documentation/SDK | docs, examples, migration guides, API references |
| Release/compliance | SBOM, provenance, signing, support policy |

Each pod should include at minimum:

- Research agent
- Specification agent
- Test-author agent
- Builder agent A
- Builder agent B for high-risk work
- Reviewer agent
- Documentation agent

---

## 18. AI engineering loop

The loop adopts the practical pattern described in Anthropic’s “When AI builds itself”: humans provide goals and judgment while agents implement, test, evaluate, review, share findings, and improve the development system. It does **not** permit uncontrolled model self-modification.

### 18.1 Task loop

```text
Human-approved objective
        |
Specification agent creates task contract
        |
Test agent creates acceptance tests
        |
Research agents gather constraints and prior art
        |
Builder agents implement in isolated worktrees
        |
Automated build, test, simulation, security scans
        |
Reviewer and adversarial agents inspect results
        |
Evaluator scores candidates against fixed rubric
        |
Integration agent prepares merge
        |
Human or policy gate approves based on risk class
        |
Results, failures, and lessons enter project memory
```

### 18.2 Work-item contract

Every task must contain:

- Objective
- User value
- Non-goals
- Dependencies
- Target component
- Risk class
- Exact acceptance tests
- Performance and security constraints
- Hardware profiles
- Allowed tools and network access
- Compute/time budget
- Required artifacts
- Rollback plan
- Definition of done

Agents may not start implementation until the task reaches “ready” status.

### 18.3 Risk classes

| Class | Examples | Merge authority |
|---|---|---|
| R0 | Documentation, formatting, generated SDK examples | Automated after tests |
| R1 | Isolated UI, non-privileged TS modules | Automated reviewer plus owner approval |
| R2 | Controller API, package manager, networking logic | Human component-owner approval |
| R3 | Go agent, storage, identity, boot, updater | Two human approvals including security/platform |
| R4 | Release signing, recovery keys, trust policy, destructive migrations | Human-only execution; agents provide proposals and evidence |

### 18.4 Parallel candidate strategy

For R2–R4 tasks:

- At least two builders attempt independent solutions.
- Test agents do not disclose hidden evaluation cases.
- A judge agent compares behavior, maintainability, security, and cost.
- The winning approach may combine parts only after interface review.
- Failure reports are retained, not discarded, to prevent repeated dead ends.

### 18.5 Recursive process-improvement loop

At a fixed cadence, a meta-agent examines:

- Agent task failure rate
- Human corrections
- Review defects
- Escaped regressions
- Cost per accepted change
- Time from ready task to merge
- Flaky tests
- Repeated architecture violations
- Missing tools
- Documentation gaps

It may propose changes to:

- Agent prompts
- Task templates
- Tooling
- Test harnesses
- Repository structure
- CI ordering
- Static checks
- Simulation profiles
- Knowledge retrieval
- Agent decomposition strategy

A proposed improvement is evaluated by running the old and new process on held-out tasks. It is adopted only when it improves agreed metrics without degrading security, reproducibility, or human comprehension.

### 18.6 Protected boundaries

Agents cannot:

- Change their own budget limits
- Change protected safety or release policies
- Edit hidden evaluation suites
- Access production keys
- Merge R3/R4 changes
- Deploy directly to customer systems
- Disable logging or provenance
- Add unrestricted network access to themselves
- Train or replace the underlying foundation model
- Declare their own output correct without independent evaluation

### 18.7 Cadence

- **Per task:** build/evaluate loop
- **Daily:** integration and blocked-task triage
- **Weekly:** quality, cost, and bottleneck review
- **Biweekly:** agent prompt/tool A/B evaluation
- **Monthly:** architecture and security review
- **Per release:** full hardware, recovery, and vendor-disappearance simulation
- **After incident:** root cause, new regression test, and agent-process adjustment

---

## 19. Repository and delivery structure

```text
/
  product/
    requirements/
    roadmaps/
    decisions/
  architecture/
    adr/
    schemas/
    threat-models/
  os/
    common/
    x86_64/
    rpi5/
    recovery/
    updates/
  agent/
    cmd/
    capabilities/
    policy/
    transactions/
  runtime/
    typescript/
    permission-broker/
    wasm/
    containers/
    microvm/
  controller/
    api/
    web/
    design-system/
  sdk/
    typescript/
    manifests/
    examples/
  packages/
    first-party/
    catalog/
  storage/
    backup/
    capsules/
    migration/
  protocols/
    atproto/
    solid-lws/
  accelerators/
    nvidia/
    intel/
    amd/
    onnx/
  simulation/
    profiles/
    fault-injection/
    hardware/
  tests/
    unit/
    integration/
    end-to-end/
    security/
    recovery/
  ai-factory/
    roles/
    prompts/
    task-contracts/
    evaluation/
    protected-policy/
  release/
    sbom/
    provenance/
    signing/
    support/
```

### 19.1 Branching

- Trunk-based development
- Short-lived agent worktrees
- One task per branch
- Signed commits or machine provenance
- Merge queue
- No direct pushes to protected branches
- Every generated artifact linked to task, agent session, tool versions, and source revision

---

## 20. CI and evaluation matrix

### 20.1 Required lanes

- TypeScript stable compile
- TypeScript 7 compatibility compile
- Deno test/lint/format
- Go build, test, vet, static analysis
- x86-64 build
- ARM64 build
- Reproducible-build comparison
- Unit tests
- Integration tests
- API compatibility tests
- Package-contract tests
- Dependency and secret scans
- SBOM generation
- Container and WASM validation
- QEMU x86 boot
- QEMU ARM64 boot
- A/B update and rollback
- Backup and restore
- Power-loss fault injection
- Network-partition simulation
- Low-memory simulation
- Architecture migration
- No-GPU/NPU fallback
- Vendor-services-blocked test

### 20.2 Physical lab

Minimum lab:

- Two Intel x86 systems from different generations
- Two AMD Ryzen systems, including one AI-capable model
- Two Raspberry Pi 5 systems
- One NVIDIA discrete-GPU x86 system
- One Intel NPU system
- One AMD NPU system
- One DGX Spark
- Managed power switches for forced power interruption
- Multiple NVMe and SATA devices
- Slow/failing storage emulation
- Routers supporting IPv4, IPv6, CGNAT simulation, and packet loss

---

## 21. Phased build plan

The phases overlap. Hardware, security, and recovery work cannot be compressed simply by adding more agents.

### Phase 0 — Charter and AI factory
**Weeks 0–3; release v0.0**

Deliverables:

- Product charter and non-goals
- Threat model v1
- Architecture decision records
- Version and dependency policy
- Risk-class policy
- Agent roles and task-contract schema
- Protected evaluation framework
- Monorepo and merge queue
- Reproducible developer environment
- QEMU smoke-test CI
- Initial hardware lab inventory

Exit gates:

- One task can pass through spec, test, dual implementation, review, evaluation, and merge.
- Agent sessions are auditable.
- Protected policies and tests cannot be changed by ordinary agents.
- Build inputs are pinned.

### Phase 1 — Bootable immutable foundation
**Weeks 2–9; release v0.1-bootstrap**

Pods: x86 platform, image/update, Go agent, QA, security.

Deliverables:

- Debian-based x86 image
- UEFI boot and signed UKI
- Root A/B partitions
- dm-verity root
- Recovery environment
- RAUC signed updates
- First-boot ownership claim
- Go agent skeleton
- Local status endpoint
- QEMU installer and rollback tests

Exit gates:

- Clean install on reference Intel and AMD systems.
- Failed update automatically returns to last known-good slot.
- Root filesystem modification is detected.
- Recovery image can export logs without exposing user secrets.

### Phase 2 — TypeScript system control
**Weeks 6–15; release v0.1-developer**

Pods: TypeScript runtime, Go agent, architecture, controller UI, identity.

Deliverables:

- Deno-based deterministic config evaluator
- TypeScript SDK
- Canonical plan schema
- Plan diff and transaction engine
- System capability API
- Controller shell
- `system.ts`, `network.ts`, and `apps/*.ts`
- Local owner identity and passkey enrollment
- Drift detection
- Developer CLI

Exit gates:

- A TypeScript plan can configure a service without shell access.
- Invalid or overprivileged plans are rejected.
- Failed apply rolls back.
- The same inputs yield byte-identical normalized plans.

### Phase 3 — Raspberry Pi and storage
**Weeks 10–22; release v0.2**

Pods: Raspberry Pi, storage/recovery, image/update, QA.

Deliverables:

- Raspberry Pi 5 native image
- A/B updates and recovery
- NVMe-first storage flow
- LUKS2 data volume
- TPM key sealing on x86
- Recovery-key flow
- Btrfs snapshots and quotas
- Storage health dashboard
- Hardware capability inventory
- Disk-full and power-loss handling

Exit gates:

- 1,000 forced power cycles without unrecoverable system state.
- Full data restore to replacement x86 and Pi nodes.
- SD card failure does not destroy authoritative data on supported Pi configuration.
- Pi kernel branch is explicitly recorded and separately certified.

### Phase 4 — Application platform
**Weeks 16–29; release v0.3**

Pods: package platform, TypeScript runtime, WASM, containers, security.

Deliverables:

- Signed application catalog
- Deno permission broker integration
- WASM component execution
- Rootless Podman execution
- Multi-architecture OCI resolution
- App lifecycle and health checks
- Resource quotas
- Network and data grants
- Package backup/update hooks
- npm/JSR mirror and lockfile policy
- First SDK templates

Exit gates:

- Untrusted TS package cannot access undeclared file, network, environment, subprocess, or FFI resources.
- Verified app update can be restored to pre-update state.
- Same app package runs on x86 and Pi when compatible artifacts exist.
- Community app failure cannot disable the controller.

### Phase 5 — Personal data product
**Weeks 22–37; release v0.4**

Pods: storage, identity, networking, PDS, UI.

Deliverables:

- Files and shared folders
- User and household roles
- Independent backup targets
- Restore UI
- Private remote-access mesh
- Optional relay
- Public ingress per app
- AT Protocol PDS module
- Export center
- Sanitized diagnostics
- UniFi-style overview for data protection and exposure

Exit gates:

- Core local operation works with vendor domains blocked.
- Complete node restore succeeds from independent backup.
- PDS can update, back up, restore, and export.
- Dashboard accurately distinguishes snapshots, mirrors, local backup, and off-site backup.

### Phase 6 — Capsules, simulation, and multi-node
**Weeks 30–45; release v0.5**

Pods: portability/simulation, controller, package platform, QA.

Deliverables:

- Capsule format v1
- Capsule signing and encryption
- x86/ARM migration
- Multi-node controller
- Workload placement
- Simulation profiles
- Failure injection
- Dev-environment capsule
- Branch/snapshot workflow for test state
- Peer-node encrypted backup

Exit gates:

- A supported dev capsule moves x86 → ARM64 → x86 with verified state.
- Required simulations run automatically before verified package publication.
- Controller remains useful when one managed node is offline.
- Secrets do not appear in capsule exports.

### Phase 7 — AI hardware
**Weeks 36–50; release v0.6**

Pods: AI platform, simulation, package platform, controller.

Deliverables:

- NVIDIA capability adapter
- Intel GPU/NPU adapter
- AMD GPU/NPU adapter
- ONNX CPU fallback
- AI workload declarations
- Device-aware scheduling
- Model and cache management
- DGX Spark host edition
- Accelerator health and utilization UI

Exit gates:

- AI package selects the best valid device.
- Missing accelerator triggers declared fallback or a clear refusal.
- Derived indexes are rebuildable.
- DGX Spark retains vendor update and recovery compatibility.

### Phase 8 — Security and public beta
**Weeks 42–59; release v0.9**

Pods: all, led by security and QA.

Deliverables:

- External penetration test
- Fuzzing and chaos program
- Supply-chain provenance
- Release-key ceremony
- Vulnerability disclosure program
- Support bundle and safe mode
- Upgrade tests from every previous public version
- 100–500 node beta
- Legal/compliance readiness
- Vendor-disappearance package draft

Exit gates:

- No unresolved critical security finding.
- Update and restore success meet beta targets.
- No known data-loss defect.
- Support cost and incident volume are measurable.
- Release can operate without the project control plane.

### Phase 9 — Version 1
**Weeks 56–70; release v1.0**

Deliverables:

- Certified hardware list
- Stable x86 and Raspberry Pi images
- DGX/AI host editions
- Public recovery tools
- Signed package catalog
- Published support lifecycle
- SDK and developer documentation
- Full data export documentation
- Optional commercial relay/backup services
- Launch telemetry limited to opt-in operational metrics

Exit gates:

- 99.9% update-success target demonstrated on certified fleet or statistically justified test volume.
- Quarterly restore drill passes.
- Vendor-disappearance test passes.
- Human security and product council approves release.

### Phase 10 — Post-v1

- Native images for selected AI OEM systems
- Mobile client
- Android host mode
- OEM mobile partnership
- Solid/Linked Web Storage adapter
- More PDS protocols
- MicroVM runtime
- Community package ecosystem
- Advanced local-first synchronization
- Personal search and AI agents
- Multi-site family clusters

---

## 22. Release gates

A release cannot advance merely because features are complete.

| Gate | Evidence |
|---|---|
| Product | Requirements and non-goals satisfied |
| Architecture | ADRs current; no undocumented privileged path |
| Functional | Acceptance tests pass |
| Hardware | Required certified devices pass |
| Security | Scans, threat-model delta, and reviews pass |
| Recovery | Backup, restore, rollback, and vendor-block tests pass |
| Portability | Required architecture and simulation profiles pass |
| Supply chain | SBOM, signatures, provenance, and dependency locks present |
| Operations | Upgrade, telemetry, support, and incident procedures tested |
| Human approval | Required owners approve by risk class |

---

## 23. Agent performance metrics

Agents are optimized for accepted outcomes, not output volume.

- Accepted changes per compute unit
- First-pass test success
- Human correction rate
- Defects found before merge
- Escaped defect rate
- Security findings per accepted change
- Documentation completeness
- Repeated-failure rate
- Mean time to reproduce a failure
- Mean time from task-ready to merge
- Percentage of changes with deterministic reproduction
- Reviewer disagreement rate
- Agent-generated code removed within 30 days
- Human comprehension score for R2/R3 changes

Lines of code is not a success metric.

---

## 24. Stop conditions for the AI loop

Pause or reduce agent autonomy when:

- Agents repeatedly game or overfit evaluation tests.
- Human comprehension falls below the defined threshold.
- Security review defect rates rise.
- Unexplained behavior enters privileged components.
- Cost rises without accepted-quality improvement.
- Agents change scope or goals without authorization.
- The protected policy boundary is bypassed.
- Reproducibility drops.
- A production or customer-data incident is linked to agent behavior.
- Two successive process-improvement experiments degrade safety or quality.

The response is to constrain scope, strengthen evaluation, improve task definition, or return the affected workstream to direct human implementation.

---

## 25. First 30 days

### Week 1

- Finalize name, product charter, terminology, and non-goals.
- Create monorepo and protected branch policy.
- Define agent task contract and risk classes.
- Select two x86 reference machines and two Raspberry Pi 5 units.
- Write ADRs for Debian, Go, Deno, Btrfs, RAUC, and package isolation.

### Week 2

- Produce QEMU x86 image.
- Boot minimal Debian root.
- Add Go agent health endpoint.
- Add Deno controller “hello node.”
- Establish reproducible build lane.
- Implement first end-to-end agent task loop.

### Week 3

- Add A/B disk layout and signed update prototype.
- Add capability discovery for CPU, RAM, storage, and network.
- Define first TypeScript `system.ts` schema.
- Build controller overview mock.
- Run independent builder-agent comparison on one real component.

### Week 4

- Install on physical Intel and AMD hardware.
- Demonstrate TypeScript plan → validated diff → Go transaction.
- Force a failed update and verify rollback.
- Publish v0.0 architecture demo and failure report.
- Run the first meta-loop experiment comparing old and revised agent task templates.

---

## 26. Primary risks

| Risk | Mitigation |
|---|---|
| “Everything is TypeScript” becomes arbitrary root code | Deterministic declarative planning plus narrow Go capabilities |
| npm supply-chain compromise | Locked mirrored dependencies, no lifecycle scripts, signatures, sandboxing |
| Supporting too much hardware | Certified matrix and host editions |
| AI agents generate unreviewable code | Risk tiers, dual implementations, protected tests, comprehension metric |
| Agents optimize tests instead of product quality | Hidden/rotating evaluations and real hardware/recovery gates |
| Raspberry Pi kernel instability | Separate vendor-kernel certification and conservative pinning |
| AI vendor stack breaks on custom image | Preserve OEM OS through host edition |
| Update corrupts app data | App-aware snapshot, migration, and restore contracts |
| User perceives mirror as backup | Explicit protection-state model |
| TypeScript runtime vulnerability affects control plane | Minimal permissions, OS sandbox, rapid update, Go enforcement layer |
| Too many runtimes create complexity | Clear workload classes and one default runtime per class |
| Control plane becomes mandatory cloud dependency | Local controller and vendor-disappearance testing |
| Recursive loop exceeds human oversight | Hard authority boundaries, budgets, audit, and stop conditions |

---

## 27. Definition of the product

> A TypeScript-first personal infrastructure operating environment that makes storage, identity, applications, backups, PDS services, AI compute, and device health manageable through one local control plane across x86, ARM, and AI nodes.

## 28. Definition of success

A user can:

1. Install the product on a certified x86 PC or Raspberry Pi 5.
2. Claim it without creating a vendor account.
3. Configure the system through understandable TypeScript files or the UI that generates them.
4. Install a verified self-hosted app.
5. Understand exactly what data, network, and compute capabilities the app receives.
6. Back up and restore the node.
7. Move a supported app and its state to another architecture.
8. Use GPU/NPU acceleration without binding data to one vendor.
9. Continue using and exporting data when project cloud services are unavailable.
10. Inspect a complete history of what human and AI agents changed in the product.

---

## 29. Source and version notes

Version snapshot used for this draft, current on 2026-06-20:

- Linux kernel.org listed Linux 6.18 as a maintained long-term branch.
- Debian listed Debian 13.5 “trixie” as the current stable release.
- Go listed 1.26.4 as a stable release.
- Microsoft had released TypeScript 6.0; TypeScript 7.0 was at release-candidate stage.
- Node.js listed 24.17.0 as the latest LTS line.
- Deno had released 2.8 and documents default-deny permissions, Node/npm compatibility, and a permission-broker interface.
- Bun had released 1.3.14.
- Wasmtime 36 is an LTS train with a 24-month support policy.
- RAUC documents signed update bundles and robust boot integration.
- Linux dm-verity provides read-only block integrity verification.
- OCI image indexes support platform-specific manifests.
- Raspberry Pi documents a downstream LTS kernel integration model.
- NVIDIA documents DGX Spark as running Ubuntu-based DGX OS with a vendor-optimized update path.
- Anthropic’s “When AI builds itself” describes the growing use of agents to implement, run, test, review, and iterate on engineering and research work, while highlighting that human judgment and direction remain important and that stronger recursive systems require stronger oversight and verification.

Primary references:

- Anthropic Institute, “When AI builds itself”
- kernel.org release index
- Debian 13 “trixie” release information
- Go downloads
- Microsoft TypeScript release announcements
- Node.js releases
- Deno 2.8 and Deno security documentation
- Bun release blog
- Wasmtime release process
- RAUC documentation
- Linux kernel dm-verity documentation
- OCI image index specification
- Raspberry Pi Linux kernel documentation
- NVIDIA DGX Spark software and update documentation

---

## Phase 6 — Desktop environment (separable first-class package)  [owner intent, 2026-06-24]

> Authoritative addendum capturing owner direction (2026-06-24). The desktop is the DEFAULT user
> experience, **not** the foundation.

### 6.0 Boundary principle (hard)
- The OS — boot, recovery, update, identity, storage, data management, control plane, and the
  application platform (capsule runtimes) — MUST be fully functional **headless, with no desktop
  installed**. The OS must boot, recover, update, and manage data without the desktop.
- The desktop is shipped/installed as a **first-class, separable PACKAGE** (via the existing
  package/capsule mechanism), never baked into the OS image. The OS exposes a stable
  compositor-substrate interface; desktop packages consume it.
- Multiple desktop packages — the flagship "PSD desktop", lighter-weight variants, or **none**
  (headless) — MUST be supported **without changing the OS**.

### 6.1 Flagship: PSD desktop
- The desktop is a **composite TSX/CSS layout** the user customizes by **registering new components**
  and **editing the desktop's own TSX** to rearrange the shell. Full TSX/CSS support.
- Editing the live desktop MUST be safe: shell layout is a managed configuration with
  preview/apply/**rollback** (the control plane) and a known-good **fallback shell** — a broken edit
  cannot brick the GUI or lock the owner out.
- **Full modern web app support** via an embedded web engine (recommended: CEF/Chromium; WPE WebKit
  as the lighter fallback; Servo as a strategic future engine).
- **App model:** TSX, web, WASM, and container apps are **one class** of windowed surface, built on
  the existing capsule runtimes.

### 6.2 Rendering architecture (the render/composite split)
- The web engine renders each surface's content **offscreen into a GPU texture/surface, once per
  content change**. A **thin native compositor core** (DRM/KMS, libinput, GPU compositing, damage
  tracking) composites those textures. Window move/resize/animate = the compositor repositions a
  texture on the GPU — **web content is NOT repainted**.
- WM behavior (layout, focus, workspaces, animation) is **TypeScript policy** over the native core's
  mechanism. The native compositor substrate is not OS-coupled (package choice is flexible).

### 6.3 Performance requirements (hard, testable)
- **PSD desktop MUST use accelerated OSR with shared GPU textures/surfaces.** CPU bitmap readback is
  allowed **only** for tests, screenshots, or fallback mode.
- De-risking spike (before factory decomposition): prove CEF accelerated-OSR -> shared GPU texture
  -> composited by the native core -> drag/animate a heavy web app at frame budget (>=60 fps) with the
  web content NOT repainting. If CEF-OSR misses budget, fall back to WPE and re-measure.

### 6.4 Sequencing
- Phase 6 starts **after** the node foundation (Phases 2-5) is complete and boot-verified. Decompose
  into thin slices: compositor core -> texture/surface bridge -> WM policy -> shell + component
  registry -> panel/launcher/notifications -> settings & file-manager as TSX apps -> webview app class.
