# Vita — System Architecture (built control plane)

> Status snapshot of what the AI factory has built. The product spec is
> [typescript_personal_node_os_build_spec.md](../typescript_personal_node_os_build_spec.md); the build
> process is [ai-factory/README.md](../ai-factory/README.md). This document describes the **assembled
> system** — the portable, type-safe control plane that manages a Vita node — and what remains gated on a
> Linux build host. Decisions are recorded as ADRs under [architecture/adr/](adr/).

## 1. The model: a fail-closed control plane

Vita manages a node through a **declarative, transactional control plane** with a hard trust boundary
between an unprivileged management plane (TypeScript) and a privileged on-host agent (Go):

```
 operator ──▶ Controller (TS, unprivileged)            Agent: agentd (Go, privileged TCB)
              · author desired state                    · loopback-only HTTP transport
              · preview changes (fail-closed)           · GET /operations  /read/{cap}  /state  /audit
              · submit a validated plan ───────────────▶· POST /apply  (transactional, fail-closed)
              · read node state + audit trail ◀─────────· 13 transactional capabilities
                                                         · append-only audit log (provenance)
```

Every boundary is **fail-closed**: untrusted input is normalized through an intrinsic-safe primitive and
rejected if exotic; absent/ambiguous input is denied, never defaulted to allow. The same desired-state shape
is validated on BOTH sides (SDK model in the controller, re-validated in the agent TCB) so *preview equals
apply*.

## 2. The agent (`agent/`, Go) — privileged TCB

`cmd/agentd` constructs the capability registry + audit store and serves a **loopback-only** HTTP transport
(`transport/`). It never shells out (`no os/exec`), uses a vendored `golang.org/x/sys/unix` via an audited
`internal/sysdeps` facade, and builds offline.

- **Transactional engine** (`transaction/`): each `Apply` has a SINGLE irreversible commit point (atomic
  temp+rename via an exclusive `os.CreateTemp`); exactly two outcomes — success + a restoring `Undo`, or
  error with the live system unchanged. No third (mutated-but-failed) state.
- **13 transactional capabilities** (`capabilities/`), all wired/discoverable/applicable/readable and in
  `/state`: `nodeconfig`, `time`, `hostname`, `identity`, `network`, `storage`, `update`, `backup`,
  `pdssync`, `capsule`, `timesync`, `services`, `accounts`. Each stores a validated desired-state config to
  a fixed path; canonical persisted bytes; duplicate-JSON-key rejection; explicit-presence (`*bool` /
  pointer-slice) so *absent ≠ zero*; no inline secrets (§13.1). Security-sensitive caps add domain gates
  (e.g. `accounts` rejects uid 0 / uid < 1000 / privileged-group membership / non-allowlisted shells).
- **Transport endpoints** (`transport/server.go`): `GET /healthz`, `GET /capabilities` (hardware),
  `GET /operations` (sorted op names), `GET /read/{cap}`, `GET /state` (whole-node aggregate),
  `GET /audit` (provenance trail), `POST /apply` (pre-transaction `Validate()` gate, then the engine).
- **Provenance** (`internal/auditlog/`): an append-only, strictly-monotonic, bounded, mutex-serialized
  store with symlink-safe atomic writes. The transport records one audit event per `/apply` (post-commit;
  a record-keeping failure never rolls back a committed change but is surfaced via `auditUnrecorded`).

## 3. The controller (`controller/`, TypeScript) — management plane

An unprivileged, pure (no-I/O in evaluation) management plane that talks to the agent via an injected
transport (`agent-client/`, `api/`). It is built from composable, fail-closed units:

- **Discovery + state**: `overview/` (node overview), `state/` (one-call `/state` snapshot client),
  `audit/` (`/audit` trail client + viewer + monotonicity tamper-check), `health/` (metrics → ok/warning/
  critical), `report/` (operations report), `dashboard/` (composed node view).
- **Change previews** (validate current vs desired, surface security/privilege flags, NEVER apply): per
  section — `storage/`, `network/` (`wideningInbound`), `update/`, `backup/` (`weakensRetention`),
  `node-config/` (unified), `capsule/`, `services/` (`newlyEnabledCount`), `accounts/` (privilege deltas) —
  and the **capstone** `changeset/` (`previewNodeChangeSet`): one whole-node preview composing all four
  subsystems with every flag aggregated.
- **Apply flow** (`apply/`, `plan/`, `package/`): plan preview, app-install capability-grant preview, and
  the apply submission path.

## 4. The SDK (`sdk/typescript/`)

The shared, host-portable types + validators both planes depend on. `src/safe-normalize.ts` is the
canonical intrinsic-safe trust-boundary primitive (rejects accessors/proxies/exotic/cyclic, fail-closed,
never throws). ~19 fail-closed models (storage, backup, recovery-key N-of-M, identity, PDS, DID-doc,
network, update/RAUC, capsule-registry, node-config aggregate, node-health, audit-event, services, accounts,
and the unified node change-set), the SemVer 2.0.0 suite (`semver` + ranges + update-applicability), the
plan model/normalizer/determinism gate, and the package-contract/catalog/PDS manifests.

## 5. Security model (spec §13/§16/§17)

- **Default-deny everywhere.** The permission broker (`runtime/permission-broker/`), the package
  lockfile-policy gate, and every model reject absent/ambiguous capability requests.
- **Trust-boundary discipline.** `safeNormalize` the whole input first; never execute methods off untrusted
  objects; reject accessor properties at every level (incl. outer envelopes); key untrusted/spec-valid
  strings via null-prototype records (a model-valid `__proto__` must not pollute). Codified in
  [AGENTS.md](../AGENTS.md) and proven by regression tests.
- **No secrets in the control plane.** Secrets are references, never inline (§13.1); the dev agents never
  hold signing/recovery keys (§16).
- **Provenance.** Every privileged `/apply` is recorded to the tamper-evident, monotonic audit log.

## 6. Quality gates

- TypeScript 7 (native, RC) strict typecheck (`noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`);
  node-native test suites; a determinism gate (same inputs → byte-identical plan).
- Go agent: `go test`/`go vet` in a `golang:1.26` container (`tools/build/go-in-docker.mjs`).
- Every task contract is independently verified + (for R2+) reviewer-gated before merge; the reviewer has
  blocked 49+ real bugs. End-to-end coverage includes an agent lifecycle scenario
  (`agent/transport/lifecycle_scenario_test.go`).

## 7. What remains gated

The path to a **bootable signed image** (FR-001) — dm-verity, a real image build, signed UKI, RAUC A/B,
and a QEMU boot smoke test — is built only to the plan level and is **blocked on a privileged Linux build
host**. **Whole-node apply** (turning an authored change-set into a per-capability plan) needs a shared,
language-neutral capability/request schema both TS and Go derive from (an owner architecture decision); the
preview path and per-capability apply are complete. See `ai-factory/task-contracts/blocked/`.
