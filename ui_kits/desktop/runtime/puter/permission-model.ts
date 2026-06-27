// Puter compat — the REAL enforcement model: delegate the api_origin capability gate to the platform
// `runtime/permission-broker` (`decideGrants`).
//
// The spike minted a grant-all session token and the gate just checked set-membership. That is NOT real
// enforcement — it trusts whatever the launcher baked in. This model replaces that: the decision for a
// Puter capability is computed by the SAME broker the rest of the OS uses, against a PER-APP declared
// grant policy held in an app-grant registry. An app that was not granted `fs.write` is DENIED by the
// broker (NOT_DECLARED / POLICY_DENIED), which the capability registry maps to CAP_DENIED / 403.
//
// Mapping (puter capability → broker capability request):
//   Each PuterCapability is modeled as a `data` capability over a DISTINCT per-app scope:
//     fs.read  → { kind:'data', class:'user-content', access:'read-only',  scope:'apps/<id>/user-content' }
//     fs.write → { kind:'data', class:'user-content', access:'read-write', scope:'apps/<id>/user-content' }
//     kv.read  → { kind:'data', class:'app-state',    access:'read-only',  scope:'apps/<id>/app-state' }
//     kv.write → { kind:'data', class:'app-state',    access:'read-write', scope:'apps/<id>/app-state' }
//     auth     → { kind:'data', class:'configuration',access:'read-only',  scope:'apps/<id>/configuration/auth' }
//     ui       → { kind:'data', class:'configuration',access:'read-only',  scope:'apps/<id>/configuration/ui' }
//     control  → { kind:'data', class:'configuration',access:'read-write', scope:'apps/<id>/configuration/control' }
//     exec     → { kind:'data', class:'configuration',access:'read-write', scope:'apps/<id>/configuration/exec' }
//     meta     → { kind:'data', class:'configuration',access:'read-write', scope:'apps/<id>/configuration/meta' }
//
//   The app's DECLARED grants (what its registration allows) become BOTH the package-contract data
//   volumes (the "declared" check) AND the destination broker policy (the "allowed" check). The broker
//   grants a capability only when it is declared AND within policy — so an app gets exactly the puter
//   capabilities its registration granted, and nothing more. Fail-closed by construction (decide.ts
//   denies on any malformation).
//
//   CRITICAL (capability separation): the broker matches a data capability by an EXACT (class, scope)
//   tuple. Several puter capabilities share the `configuration` class (auth/ui/control/exec/meta), so if
//   they ALSO shared a scope they would be INTERCHANGEABLE — a control-only grant would satisfy an exec
//   or meta request. To keep the privileged planes genuinely distinct we give EACH capability its OWN
//   broker scope (see CAP_MAP.scopeSuffix): the configuration-class caps map to
//   `apps/<id>/configuration/auth`, `/ui`, `/control`, `/exec`, `/meta` — distinct strings the broker
//   compares exactly. So a policy that grants only `control` CANNOT satisfy an `exec` or `meta` request,
//   and vice-versa. fs/kv keep their per-class scopes (`apps/<id>/user-content`, `apps/<id>/app-state`)
//   so they stay independently grantable.
//
// Pure: no I/O, no node import. The grant registry is an in-memory map for the harness; on-device it is
// fed from the app-registry / install record.

import { decideGrants } from "../../../../runtime/permission-broker/src/decide.ts";
import type {
  BrokerPolicy,
  CapabilityRequest,
  DataGrantPolicy,
  RequestedCapability,
} from "../../../../runtime/permission-broker/src/grants.ts";
import type {
  DataClass,
  PackageContract,
} from "../../../../sdk/manifests/src/package-contract.ts";

import type {
  PermissionDecisionInput,
  PuterCapability,
  PuterPermissionModel,
} from "./capability.ts";

// The per-app declared grant set (what the app's registration allows). Keyed by appId. This is the
// SOURCE OF TRUTH the broker enforces against — NOT the session token.
export interface AppGrantRegistry {
  // Declare the capabilities `appId` is granted. Replaces any prior declaration. Empty = grant nothing.
  declare(appId: string, grants: readonly PuterCapability[]): void;
  // The declared grants for `appId` (empty set if unknown — fail-closed: unknown app gets nothing).
  grantsFor(appId: string): ReadonlySet<PuterCapability>;
  has(appId: string): boolean;
  revoke(appId: string): void;
}

export function createAppGrantRegistry(seed?: Readonly<Record<string, readonly PuterCapability[]>>): AppGrantRegistry {
  const byApp = new Map<string, ReadonlySet<PuterCapability>>();

  if (seed !== undefined) {
    for (const [appId, grants] of Object.entries(seed)) byApp.set(appId, Object.freeze(new Set(grants)));
  }

  return Object.freeze({
    declare(appId: string, grants: readonly PuterCapability[]): void {
      byApp.set(appId, Object.freeze(new Set(grants)));
    },
    grantsFor(appId: string): ReadonlySet<PuterCapability> {
      return byApp.get(appId) ?? EMPTY;
    },
    has(appId: string): boolean {
      return byApp.has(appId);
    },
    revoke(appId: string): void {
      byApp.delete(appId);
    },
  });
}

const EMPTY: ReadonlySet<PuterCapability> = Object.freeze(new Set<PuterCapability>());

interface CapMapping {
  readonly class: DataClass;
  readonly access: "read-only" | "read-write";
  // The scope SUFFIX appended after the data class in the per-app scope. Empty string = the bare
  // per-class scope (`apps/<id>/<class>`, used by fs/kv so they stay independently grantable). A
  // non-empty suffix gives a configuration-class capability its OWN distinct scope
  // (`apps/<id>/configuration/<suffix>`), so the broker — which matches scope EXACTLY — can NEVER let a
  // control grant satisfy an exec/meta request (or vice-versa). This is the capability-separation fix.
  readonly scopeSuffix: string;
}

// puter capability → (data class, access, scope suffix). One table, used both to build the requested
// capability and to build the declared/policy entries for the app's grants. fs/kv use the bare per-class
// scope; each privileged configuration-class cap (auth/ui/control/exec/meta) carries a DISTINCT suffix so
// it gets its own exact broker scope — they are NOT interchangeable.
const CAP_MAP: Readonly<Record<PuterCapability, CapMapping>> = Object.freeze({
  auth: { access: "read-only", class: "configuration", scopeSuffix: "auth" },
  // The control plane (list/start/stop/status/logs) MUTATES node configuration (it applies capsule
  // lifecycle ops), so it is a read-write configuration-class capability. Distinct scope `.../control`:
  // only the management console is ever granted it, and a control grant can satisfy ONLY a control
  // request (never exec/meta).
  control: { access: "read-write", class: "configuration", scopeSuffix: "control" },
  // EXEC runs a real process inside a hardened capsule on the node — the most privileged compat
  // capability. Read-write configuration-class with its OWN scope `.../exec` (it spawns + mutates a node
  // sandbox). Only an explicitly exec-granted app (the Terminal) ever holds it; a control- or meta-only
  // grant can NEVER satisfy an exec request. Default-deny everywhere else.
  exec: { access: "read-write", class: "configuration", scopeSuffix: "exec" },
  "fs.read": { access: "read-only", class: "user-content", scopeSuffix: "" },
  "fs.write": { access: "read-write", class: "user-content", scopeSuffix: "" },
  "kv.read": { access: "read-only", class: "app-state", scopeSuffix: "" },
  "kv.write": { access: "read-write", class: "app-state", scopeSuffix: "" },
  // The PACKAGE-MANAGER meta plane MUTATES per-package grant policy (it alters which capabilities other
  // packages hold) and reads their source — a read-write configuration-class capability with its OWN
  // scope `.../meta`. Only the Package Manager app is ever granted it; a control- or exec-only grant can
  // NEVER satisfy a meta request. Default-deny for everyone else.
  meta: { access: "read-write", class: "configuration", scopeSuffix: "meta" },
  ui: { access: "read-only", class: "configuration", scopeSuffix: "ui" },
});

// The DISTINCT broker scope for one capability: `apps/<id>/<class>` for fs/kv (bare per-class), or
// `apps/<id>/<class>/<suffix>` for the privileged configuration-class caps. The broker matches this
// string EXACTLY, so two caps with different suffixes are never interchangeable.
function scopeForCap(appId: string, cap: PuterCapability): string {
  const m = CAP_MAP[cap];
  const base = `apps/${appId}/${m.class}`;

  return m.scopeSuffix === "" ? base : `${base}/${m.scopeSuffix}`;
}

// One broker grant entry the app holds: the exact (class, scope, access) tuple a request is matched
// against. Two caps that share a class but differ in scope (control vs exec vs meta) each get their OWN
// entry — never merged — which is what makes the privileged planes non-fungible.
interface BrokerGrantEntry {
  readonly class: DataClass;
  readonly scope: string;
  readonly access: "read-only" | "read-write";
}

// Collapse the app's granted puter capabilities into one broker grant entry per DISTINCT scope. fs.read+
// fs.write collapse to a single user-content entry (max access wins); control/exec/meta stay SEPARATE
// entries because their scopes differ. Scopes are fully resolved for `appId`.
function brokerGrantEntries(appId: string, grants: ReadonlySet<PuterCapability>): BrokerGrantEntry[] {
  const byScope = new Map<string, BrokerGrantEntry>();

  for (const cap of grants) {
    const m = CAP_MAP[cap];
    const scope = scopeForCap(appId, cap);
    const prior = byScope.get(scope);
    const access: "read-only" | "read-write" =
      prior?.access === "read-write" || m.access === "read-write" ? "read-write" : "read-only";

    byScope.set(scope, { access, class: m.class, scope });
  }

  return [...byScope.values()];
}

// Build a valid PackageContract whose data.volumes DECLARE exactly the app's granted (class, scope)
// tuples (one volume per distinct broker grant entry, access = the max the app holds). The broker reads
// `volume.name` AS the declared scope (decide.ts::declarationsFrom), so each volume's name IS its scope.
// Shape mirrors the manifest validator's accepted contract (see runtime/permission-broker/test/decide.test.ts).
function contractForGrants(appId: string, grants: ReadonlySet<PuterCapability>): PackageContract {
  const entries = brokerGrantEntries(appId, grants);
  // The package-contract `data.classes` list must include every class a volume references; dedupe.
  const classes = [...new Set(entries.map((e) => e.class))];
  const volumes = entries.map((entry, index) => ({
    name: entry.scope,
    mountPath: `/var/lib/vita/apps/${appId}/vol-${index}`,
    class: entry.class,
    access: entry.access,
    persistence: "persistent" as const,
    backup: false,
    sizeMiB: 64,
  }));

  return {
    packageClass: "ui-extension",
    identity: { id: appId, name: appId },
    signingPublisher: { id: "vita.first-party", signingKeyRef: "publisher-key://vita/first-party/stable" },
    version: "0.0.0",
    digest: { algorithm: "sha256", value: "0".repeat(64) },
    architectures: ["x86_64"],
    resources: { cpuCores: 1, ramMiB: 64, storageMiB: 64 },
    accelerators: { required: [], optional: [], preference: ["cpu"] },
    network: { ingress: [], egress: [] },
    data: { classes, volumes },
    secrets: [],
    backup: { strategy: "none", includeVolumes: [], quiesceHooks: [], backupHooks: [] },
    restore: { requireCleanVerification: false, verificationHooks: [] },
    healthChecks: [],
    updates: { channel: "stable", strategy: "replace", schemaMigrations: [] },
    rollback: { maxRollbackVersions: 1, maxRollbackAgeDays: 1, requiresFreshBackup: false },
    exportFormats: ["json"],
    endOfSupportDate: "2099-12-31",
    sbom: {
      format: "spdx-json",
      digest: { algorithm: "sha256", value: "0".repeat(64) },
      generatedAt: "2026-06-01T12:00:00.000Z",
    },
    vulnerabilityStatus: { status: "clean", scannedAt: "2026-06-01T12:00:00.000Z", critical: 0, high: 0, medium: 0, low: 0 },
    requiredSimulationProfiles: [],
  };
}

// Build the broker DESTINATION POLICY allowing exactly the app's granted (class, scope) tuples. One
// policy entry per distinct broker grant entry — so the policy grants `control` ONLY at the control
// scope, never at the exec/meta scope (the capability-separation fix on the policy side).
function policyForGrants(appId: string, grants: ReadonlySet<PuterCapability>): BrokerPolicy {
  const data: DataGrantPolicy[] = brokerGrantEntries(appId, grants).map((entry) => ({
    class: entry.class,
    access: entry.access,
    scope: entry.scope,
  }));

  return { data, network: { ingress: [], egress: [] } };
}

// Build the single requested capability for `capability` against `appId`, using that capability's OWN
// distinct (class, scope). The broker grants it only if BOTH the contract declares that exact scope AND
// the policy allows it — and since control/exec/meta carry different scopes, a control grant can never
// satisfy an exec or meta request.
function requestFor(appId: string, capability: PuterCapability, contract: PackageContract): CapabilityRequest {
  const m = CAP_MAP[capability];
  const requested: RequestedCapability = {
    kind: "data",
    class: m.class,
    access: m.access,
    scope: scopeForCap(appId, capability),
  };

  return { packageContract: contract, capabilities: [requested] };
}

export interface BrokerPermissionModelDeps {
  readonly grants: AppGrantRegistry;
}

// The REAL enforcement model. Delegates each decision to `decideGrants` against the app's declared
// grants. ALLOW iff the broker returns the capability in `granted` (i.e. declared AND within policy).
export function createBrokerPermissionModel(deps: BrokerPermissionModelDeps): PuterPermissionModel {
  return Object.freeze({
    decide(input: PermissionDecisionInput): boolean {
      const declared = deps.grants.grantsFor(input.appId);

      // An app the registry never declared has no grants — DENY (fail-closed) without even asking the
      // broker (a contract with zero volumes would fail validation anyway).
      if (declared.size === 0) return false;

      // An app that does not hold THIS capability is denied before touching the broker: requesting a
      // scope the contract never declares would be NOT_DECLARED anyway, but short-circuiting keeps the
      // separation explicit (a control-only app asking for exec never even builds an exec request that
      // could accidentally match a shared scope).
      if (!declared.has(input.capability)) return false;

      const contract = contractForGrants(input.appId, declared);
      const policy = policyForGrants(input.appId, declared);
      const decision = decideGrants(requestFor(input.appId, input.capability, contract), policy);

      // ALLOW only if the broker GRANTED this exact data capability (and denied nothing for it).
      return decision.granted.length === 1 && decision.denied.length === 0;
    },
  });
}
