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
//   Each PuterCapability is modeled as a `data` capability over the app's own scope `apps/<appId>`:
//     fs.read  → { kind:'data', class:'user-content', access:'read-only',  scope:'apps/<id>' }
//     fs.write → { kind:'data', class:'user-content', access:'read-write', scope:'apps/<id>' }
//     kv.read  → { kind:'data', class:'app-state',    access:'read-only',  scope:'apps/<id>' }
//     kv.write → { kind:'data', class:'app-state',    access:'read-write', scope:'apps/<id>' }
//     auth     → { kind:'data', class:'configuration',access:'read-only',  scope:'apps/<id>' }
//     ui       → { kind:'data', class:'configuration',access:'read-only',  scope:'apps/<id>' }  (control plane)
//
//   The app's DECLARED grants (what its registration allows) become BOTH the package-contract data
//   volumes (the "declared" check) AND the destination broker policy (the "allowed" check). The broker
//   grants a capability only when it is declared AND within policy — so an app gets exactly the puter
//   capabilities its registration granted, and nothing more. Fail-closed by construction (decide.ts
//   denies on any malformation).
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
}

// puter capability → (data class, access). The scope is per-app (`apps/<id>/<class>`). One table, used
// both to build the requested capability and to build the declared/policy entries for the app's grants.
// Distinct scope-per-class keeps fs (user-content) and kv (app-state) independently grantable.
const CAP_MAP: Readonly<Record<PuterCapability, CapMapping>> = Object.freeze({
  auth: { access: "read-only", class: "configuration" },
  "fs.read": { access: "read-only", class: "user-content" },
  "fs.write": { access: "read-write", class: "user-content" },
  "kv.read": { access: "read-only", class: "app-state" },
  "kv.write": { access: "read-write", class: "app-state" },
  ui: { access: "read-only", class: "configuration" },
});

// Per-app, per-class scope. The broker matches scope EXACTLY, so a class gets one scope and the
// access is the max the app was granted for that class (read-write covers read-only).
function scopeFor(appId: string, dataClass: DataClass): string {
  return `apps/${appId}/${dataClass}`;
}

// Collapse the app's granted puter capabilities into one (class → max-access) entry per touched class.
function classAccessMap(grants: ReadonlySet<PuterCapability>): Map<DataClass, "read-only" | "read-write"> {
  const out = new Map<DataClass, "read-only" | "read-write">();

  for (const cap of grants) {
    const m = CAP_MAP[cap];
    const prior = out.get(m.class);

    // read-write wins over read-only.
    out.set(m.class, prior === "read-write" || m.access === "read-write" ? "read-write" : "read-only");
  }

  return out;
}

// Build a valid PackageContract whose data.volumes DECLARE exactly the app's granted data classes (one
// volume per class, scoped per-app, access = the max the app holds). Shape mirrors the manifest
// validator's accepted contract (see runtime/permission-broker/test/decide.test.ts::validContract).
function contractForGrants(appId: string, grants: ReadonlySet<PuterCapability>): PackageContract {
  const classAccess = classAccessMap(grants);
  const classes = [...classAccess.keys()];
  const volumes = classes.map((dataClass) => ({
    name: scopeFor(appId, dataClass),
    mountPath: `/var/lib/vita/apps/${appId}/${dataClass}`,
    class: dataClass,
    access: classAccess.get(dataClass)!,
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

// Build the broker DESTINATION POLICY allowing exactly the app's granted data scopes/access.
function policyForGrants(appId: string, grants: ReadonlySet<PuterCapability>): BrokerPolicy {
  const classAccess = classAccessMap(grants);
  const data: DataGrantPolicy[] = [];

  for (const [dataClass, access] of classAccess) {
    data.push({ class: dataClass, access, scope: scopeFor(appId, dataClass) });
  }

  return { data, network: { ingress: [], egress: [] } };
}

function requestFor(appId: string, capability: PuterCapability, contract: PackageContract): CapabilityRequest {
  const m = CAP_MAP[capability];
  const requested: RequestedCapability = {
    kind: "data",
    class: m.class,
    access: m.access,
    scope: scopeFor(appId, m.class),
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

      const contract = contractForGrants(input.appId, declared);
      const policy = policyForGrants(input.appId, declared);
      const decision = decideGrants(requestFor(input.appId, input.capability, contract), policy);

      // ALLOW only if the broker GRANTED this exact data capability (and denied nothing for it).
      return decision.granted.length === 1 && decision.denied.length === 0;
    },
  });
}
