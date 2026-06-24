import { summarizeDashboard } from "./protection-dashboard-model.ts";
import { safeNormalize } from "./safe-normalize.ts";
import type { AgentCapabilityState, AgentClient } from "./agent-client.ts";
import type { PlainJson, PlainJsonObject } from "./safe-normalize.ts";
import type {
  DashboardValidationError,
  ProtectionDashboardSummary,
} from "./protection-dashboard-model.ts";

export const STORAGE_LAYOUT_CAPABILITY = "storage.layout";
export const BACKUP_POLICY_CAPABILITY = "backup.policy";
export const BACKUP_ARCHIVE_CAPABILITY = "backup.archive";
export const NETWORK_POLICY_CAPABILITY = "network.policy";
export const CAPSULE_REGISTRY_CAPABILITY = "capsule.registry";

export type ProtectionDashboardReadResult =
  | {
      readonly ok: true;
      readonly dashboard: ProtectionDashboardSummary;
    }
  | {
      readonly ok: false;
      readonly kind: "error" | "reject";
      readonly reason: string;
    };

type DashboardInput = {
  storageLayout?: PlainJsonObject;
  backupPolicy?: PlainJsonObject;
  backupArchive?: PlainJsonObject;
  networkPolicy?: PlainJsonObject;
  capsuleRegistry?: readonly PlainJson[];
  capsuleNetworkGrants?: readonly PlainJsonObject[];
};

type UnwrapObjectResult =
  | {
      readonly ok: true;
      readonly value?: PlainJsonObject;
    }
  | {
      readonly ok: false;
      readonly reason: string;
    };

type UnwrapRegistryResult =
  | {
      readonly ok: true;
      readonly value?: readonly PlainJson[];
    }
  | {
      readonly ok: false;
      readonly reason: string;
    };

interface CapsuleRegistryEntryForDashboard {
  readonly id: string;
  readonly version: string;
  readonly integrity: string;
  readonly state: string;
}

interface CapsuleNetworkGrantSummary {
  readonly capsuleId: string;
  readonly egressGrants: number;
  readonly ingressGrants: number;
}

type CapsuleGrantBuildResult =
  | {
      readonly ok: true;
      readonly grants: readonly PlainJsonObject[];
    }
  | {
      readonly ok: false;
      readonly reason: string;
    };

const CAPSULE_MANIFEST_BASE_URL = "file:///usr/lib/vita/capsules/";
const MANIFEST_NETWORK_FIELDS = Object.freeze(["egress", "ingress"]);
const MANIFEST_INGRESS_FIELDS = Object.freeze([
  "direction",
  "interface",
  "name",
  "port",
  "protocol",
  "public",
  "sourceCidr",
  "unsafeWideOpen",
]);
const MANIFEST_EGRESS_FIELDS = Object.freeze([
  "destinations",
  "direction",
  "interface",
  "name",
  "ports",
  "protocol",
  "unsafeWideOpen",
]);
const PROTOCOLS = Object.freeze(["tcp", "udp"]);

export async function readProtectionDashboard(
  client: Pick<AgentClient, "getState">,
): Promise<ProtectionDashboardReadResult> {
  const storageState = await readState(client, STORAGE_LAYOUT_CAPABILITY, "read_storage_layout_failed");
  if (!storageState.ok) return storageState;

  const backupPolicyState = await readState(client, BACKUP_POLICY_CAPABILITY, "read_backup_policy_failed");
  if (!backupPolicyState.ok) return backupPolicyState;

  const backupArchiveState = await readState(client, BACKUP_ARCHIVE_CAPABILITY, "read_backup_archive_failed");
  if (!backupArchiveState.ok) return backupArchiveState;

  const networkState = await readState(client, NETWORK_POLICY_CAPABILITY, "read_network_policy_failed");
  if (!networkState.ok) return networkState;

  const registryState = await readState(client, CAPSULE_REGISTRY_CAPABILITY, "read_capsule_registry_failed");
  if (!registryState.ok) return registryState;

  const dashboardInput = await buildDashboardInput(
    storageState.state,
    backupPolicyState.state,
    backupArchiveState.state,
    networkState.state,
    registryState.state,
  );

  if (!dashboardInput.ok) {
    return {
      kind: "reject",
      ok: false,
      reason: dashboardInput.reason,
    };
  }

  const dashboard = summarizeDashboard(dashboardInput.input);

  if (!dashboard.ok) {
    return {
      kind: "reject",
      ok: false,
      reason: reasonFromErrors(dashboard.errors),
    };
  }

  return {
    dashboard: dashboard.dashboard,
    ok: true,
  };
}

export async function readProtectionDashboardMarkers(
  client: Pick<AgentClient, "getState">,
): Promise<readonly string[]> {
  const result = await readProtectionDashboard(client);
  const markers = [formatProtectionDashboardMarker(result)];

  if (result.ok) {
    markers.push(formatProtectionDashboardForcedRejectMarker());
  }

  return Object.freeze(markers);
}

export function formatProtectionDashboardMarker(result: ProtectionDashboardReadResult): string {
  if (!result.ok) {
    if (result.kind === "reject") {
      return `VITA-PROTECT-DASH-REJECT: reason=${markerToken(result.reason)} status=OK`;
    }

    return `VITA-PROTECT-DASH-ERROR: reason=${markerToken(result.reason)} status=FAILSAFE`;
  }

  const { protection, exposure } = result.dashboard;

  return (
    "VITA-PROTECT-DASH: " +
    `snapshots=${protection.snapshots.status} ` +
    `mirror=${protection.mirror.status} ` +
    `localBackup=${protection.localBackup.status} ` +
    `offSite=${protection.offSite.status} ` +
    `exposed=${exposure.counts.exposedIngress} ` +
    `mute=${exposure.counts.networkMute} ` +
    `wideOpen=${exposure.host.wideOpen ? "yes" : "no"} ` +
    "status=OK"
  );
}

export function formatProtectionDashboardErrorMarker(reason: string): string {
  return `VITA-PROTECT-DASH-ERROR: reason=${markerToken(reason)} status=FAILSAFE`;
}

async function buildDashboardInput(
  storageState: AgentCapabilityState,
  backupPolicyState: AgentCapabilityState,
  backupArchiveState: AgentCapabilityState,
  networkState: AgentCapabilityState,
  registryState: AgentCapabilityState,
): Promise<
  | {
      readonly ok: true;
      readonly input: DashboardInput;
    }
  | {
      readonly ok: false;
      readonly reason: string;
    }
> {
  const storage = unwrapObjectReadState(storageState, "layout", "storage_layout_state_invalid");
  if (!storage.ok) return storage;

  const backupPolicy = unwrapObjectReadState(backupPolicyState, "policy", "backup_policy_state_invalid");
  if (!backupPolicy.ok) return backupPolicy;

  const networkPolicy = unwrapObjectReadState(networkState, "policy", "network_policy_state_invalid");
  if (!networkPolicy.ok) return networkPolicy;

  const registry = unwrapRegistryReadState(registryState);
  if (!registry.ok) return registry;

  const capsuleNetworkGrants = await buildCapsuleNetworkGrants(registry.value);
  if (!capsuleNetworkGrants.ok) {
    return {
      ok: false,
      reason: capsuleNetworkGrants.reason,
    };
  }

  const input: DashboardInput = {
    backupArchive: backupArchiveState,
    capsuleNetworkGrants: capsuleNetworkGrants.grants,
    capsuleRegistry: registry.value ?? Object.freeze([]),
  };

  if (storage.value !== undefined) input.storageLayout = storage.value;
  if (backupPolicy.value !== undefined) input.backupPolicy = backupPolicy.value;
  if (networkPolicy.value !== undefined) input.networkPolicy = networkPolicy.value;

  return {
    input: Object.freeze(input),
    ok: true,
  };
}

async function readState(
  client: Pick<AgentClient, "getState">,
  capability: string,
  reason: string,
): Promise<
  | {
      readonly ok: true;
      readonly state: AgentCapabilityState;
    }
  | {
      readonly ok: false;
      readonly kind: "error";
      readonly reason: string;
    }
> {
  try {
    return {
      ok: true,
      state: await client.getState(capability),
    };
  } catch {
    return {
      kind: "error",
      ok: false,
      reason,
    };
  }
}

function unwrapObjectReadState(
  state: AgentCapabilityState,
  fieldName: string,
  invalidReason: string,
): UnwrapObjectResult {
  const exists = field(state, "exists");

  if (exists === false) {
    return {
      ok: true,
    };
  }

  if (exists === true) {
    const value = field(state, fieldName);

    if (!isPlainObject(value)) {
      return {
        ok: false,
        reason: invalidReason,
      };
    }

    return {
      ok: true,
      value,
    };
  }

  if (exists !== undefined) {
    return {
      ok: false,
      reason: invalidReason,
    };
  }

  return {
    ok: true,
    value: state,
  };
}

function unwrapRegistryReadState(state: AgentCapabilityState): UnwrapRegistryResult {
  const exists = field(state, "exists");

  if (exists === false) {
    return {
      ok: true,
      value: Object.freeze([]),
    };
  }

  if (exists === true) {
    const registry = field(state, "registry");

    if (!isPlainObject(registry)) {
      return {
        ok: false,
        reason: "capsule_registry_state_invalid",
      };
    }

    const capsules = field(registry, "capsules");
    if (!Array.isArray(capsules)) {
      return {
        ok: false,
        reason: "capsule_registry_state_invalid",
      };
    }

    return {
      ok: true,
      value: capsules,
    };
  }

  if (exists !== undefined) {
    return {
      ok: false,
      reason: "capsule_registry_state_invalid",
    };
  }

  if (Array.isArray(state)) {
    return {
      ok: true,
      value: state,
    };
  }

  return {
    ok: false,
    reason: "capsule_registry_state_invalid",
  };
}

async function buildCapsuleNetworkGrants(
  registry: readonly PlainJson[] | undefined,
): Promise<CapsuleGrantBuildResult> {
  if (registry === undefined) {
    return {
      grants: Object.freeze([]),
      ok: true,
    };
  }

  const grants: PlainJsonObject[] = [];

  for (let index = 0; index < registry.length; index += 1) {
    const entry = readCapsuleRegistryEntry(registry[index]);

    if (entry === undefined || entry.state !== "installed") {
      continue;
    }

    const grant = await readCapsuleNetworkGrant(entry);

    if (!grant.ok) {
      return grant;
    }

    if (grant.grant.egressGrants === 0 && grant.grant.ingressGrants === 0) {
      continue;
    }

    grants.push(Object.freeze({
      capsuleId: entry.id,
      egressGrants: grant.grant.egressGrants,
      ingressGrants: grant.grant.ingressGrants,
    }));
  }

  return {
    grants: Object.freeze(grants),
    ok: true,
  };
}

function readCapsuleRegistryEntry(value: PlainJson | undefined): CapsuleRegistryEntryForDashboard | undefined {
  if (!isPlainObject(value)) {
    return undefined;
  }

  const id = field(value, "id");
  const version = field(value, "version");
  const integrity = field(value, "integrity");
  const state = field(value, "state");

  if (
    typeof id !== "string" ||
    typeof version !== "string" ||
    typeof integrity !== "string" ||
    typeof state !== "string"
  ) {
    return undefined;
  }

  return {
    id,
    integrity,
    state,
    version,
  };
}

async function readCapsuleNetworkGrant(
  entry: CapsuleRegistryEntryForDashboard,
): Promise<
  | {
      readonly ok: true;
      readonly grant: CapsuleNetworkGrantSummary;
    }
  | {
      readonly ok: false;
      readonly reason: string;
    }
> {
  const manifest = await importCapsuleManifest(entry.id);

  if (!manifest.ok) {
    return manifest;
  }

  return readManifestNetworkGrant(entry, manifest.manifest);
}

async function importCapsuleManifest(id: string): Promise<
  | {
      readonly ok: true;
      readonly manifest: PlainJsonObject;
    }
  | {
      readonly ok: false;
      readonly reason: string;
    }
> {
  if (!isSafeCapsulePathSegment(id)) {
    return {
      ok: false,
      reason: "capsule_manifest_id_invalid",
    };
  }

  const manifestUrl = new URL(`${encodeURIComponent(id)}/manifest.json`, CAPSULE_MANIFEST_BASE_URL);
  let loaded: unknown;

  try {
    loaded = await import(manifestUrl.href, { with: { type: "json" } });
  } catch {
    return {
      ok: false,
      reason: "capsule_manifest_unreadable",
    };
  }

  const manifestValue = moduleDefault(loaded);
  const normalized = safeNormalize(manifestValue);

  if (!normalized.ok || !isPlainObject(normalized.value)) {
    return {
      ok: false,
      reason: "capsule_manifest_invalid",
    };
  }

  return {
    manifest: normalized.value,
    ok: true,
  };
}

function readManifestNetworkGrant(
  entry: CapsuleRegistryEntryForDashboard,
  manifest: PlainJsonObject,
):
  | {
      readonly ok: true;
      readonly grant: CapsuleNetworkGrantSummary;
    }
  | {
      readonly ok: false;
      readonly reason: string;
    } {
  if (
    field(manifest, "id") !== entry.id ||
    field(manifest, "version") !== entry.version ||
    field(manifest, "integrity") !== entry.integrity
  ) {
    return {
      ok: false,
      reason: "capsule_manifest_mismatch",
    };
  }

  const network = field(manifest, "network");
  if (network === undefined) {
    return {
      grant: {
        capsuleId: entry.id,
        egressGrants: 0,
        ingressGrants: 0,
      },
      ok: true,
    };
  }

  if (!isPlainObject(network)) {
    return {
      ok: false,
      reason: "capsule_manifest_network_invalid",
    };
  }

  const networkFields = expectOnlyFields(network, MANIFEST_NETWORK_FIELDS);
  if (!networkFields.ok) return networkFields;

  const ingress = validateNetworkGrantArray(
    field(network, "ingress"),
    "ingress",
    validateIngressGrant,
  );
  if (!ingress.ok) return ingress;

  const egress = validateNetworkGrantArray(
    field(network, "egress"),
    "egress",
    validateEgressGrant,
  );
  if (!egress.ok) return egress;

  return {
    grant: {
      capsuleId: entry.id,
      egressGrants: egress.count,
      ingressGrants: ingress.count,
    },
    ok: true,
  };
}

function validateNetworkGrantArray(
  value: PlainJson | undefined,
  label: "egress" | "ingress",
  validate: (grant: PlainJsonObject) => boolean,
):
  | {
      readonly ok: true;
      readonly count: number;
    }
  | {
      readonly ok: false;
      readonly reason: string;
    } {
  if (!Array.isArray(value)) {
    return {
      ok: false,
      reason: `capsule_manifest_${label}_invalid`,
    };
  }

  for (let index = 0; index < value.length; index += 1) {
    const grant = value[index];
    if (!isPlainObject(grant) || !validate(grant)) {
      return {
        ok: false,
        reason: `capsule_manifest_${label}_invalid`,
      };
    }
  }

  return {
    count: value.length,
    ok: true,
  };
}

function validateIngressGrant(grant: PlainJsonObject): boolean {
  if (!expectOnlyFields(grant, MANIFEST_INGRESS_FIELDS).ok) return false;

  const direction = field(grant, "direction");
  const name = field(grant, "name");
  const protocol = field(grant, "protocol");
  const port = field(grant, "port");
  const sourceCidr = field(grant, "sourceCidr");
  const iface = field(grant, "interface");
  const publicValue = field(grant, "public");
  const unsafeWideOpen = field(grant, "unsafeWideOpen");

  return (
    (direction === undefined || direction === "ingress") &&
    (name === undefined || isNonEmptyString(name)) &&
    isProtocol(protocol) &&
    isPort(port) &&
    typeof sourceCidr === "string" &&
    isValidCidr(sourceCidr) &&
    isNonEmptyString(iface) &&
    typeof publicValue === "boolean" &&
    (unsafeWideOpen === undefined || typeof unsafeWideOpen === "boolean")
  );
}

function validateEgressGrant(grant: PlainJsonObject): boolean {
  if (!expectOnlyFields(grant, MANIFEST_EGRESS_FIELDS).ok) return false;

  const direction = field(grant, "direction");
  const name = field(grant, "name");
  const protocol = field(grant, "protocol");
  const destinations = field(grant, "destinations");
  const ports = field(grant, "ports");
  const iface = field(grant, "interface");
  const unsafeWideOpen = field(grant, "unsafeWideOpen");

  return (
    (direction === undefined || direction === "egress") &&
    (name === undefined || isNonEmptyString(name)) &&
    isProtocol(protocol) &&
    isDestinationArray(destinations) &&
    isPortArray(ports) &&
    isNonEmptyString(iface) &&
    (unsafeWideOpen === undefined || typeof unsafeWideOpen === "boolean")
  );
}

function formatProtectionDashboardForcedRejectMarker(): string {
  const rejected = summarizeDashboard({
    networkPolicy: {
      allow: "malformed",
    },
  });

  if (rejected.ok) {
    return "VITA-PROTECT-DASH-ERROR: reason=forced_reject_not_rejected status=FAILSAFE";
  }

  return `VITA-PROTECT-DASH-REJECT: reason=${markerToken(reasonFromErrors(rejected.errors))} status=OK`;
}

function reasonFromErrors(errors: readonly DashboardValidationError[]): string {
  const first = errors[0];

  if (first === undefined) {
    return "dashboard_rejected";
  }

  if (first.path.length === 0) {
    return first.message;
  }

  return `${first.path}_${first.message}`;
}

function field(value: PlainJsonObject, key: string): PlainJson | undefined {
  if (!Object.hasOwn(value, key)) {
    return undefined;
  }

  return value[key];
}

function isPlainObject(value: PlainJson | undefined): value is PlainJsonObject {
  return value !== undefined && value !== null && typeof value === "object" && !Array.isArray(value);
}

function moduleDefault(value: unknown): unknown {
  if (value === null || typeof value !== "object") {
    return undefined;
  }

  const descriptor = Object.getOwnPropertyDescriptor(value, "default");
  if (descriptor === undefined || !Object.hasOwn(descriptor, "value")) {
    return undefined;
  }

  return descriptor.value;
}

function expectOnlyFields(
  value: PlainJsonObject,
  allowed: readonly string[],
):
  | {
      readonly ok: true;
    }
  | {
      readonly ok: false;
      readonly reason: string;
    } {
  const keys = Object.keys(value);

  for (let index = 0; index < keys.length; index += 1) {
    const key = keys[index];

    if (key === undefined || !contains(allowed, key)) {
      return {
        ok: false,
        reason: "capsule_manifest_network_invalid",
      };
    }
  }

  return {
    ok: true,
  };
}

function contains(values: readonly string[], value: string): boolean {
  for (let index = 0; index < values.length; index += 1) {
    if (values[index] === value) {
      return true;
    }
  }

  return false;
}

function isSafeCapsulePathSegment(value: string): boolean {
  return value.length > 0 &&
    value.length <= 255 &&
    value === value.trim() &&
    !value.includes("/") &&
    !value.includes("\\") &&
    !value.includes("\0") &&
    value !== "." &&
    value !== "..";
}

function isProtocol(value: PlainJson | undefined): boolean {
  return typeof value === "string" && contains(PROTOCOLS, value);
}

function isNonEmptyString(value: PlainJson | undefined): value is string {
  return typeof value === "string" && value.length > 0 && value === value.trim();
}

function isPort(value: PlainJson | undefined): boolean {
  return typeof value === "number" &&
    Number.isSafeInteger(value) &&
    (value === -1 || (value >= 1 && value <= 65535));
}

function isPortArray(value: PlainJson | undefined): boolean {
  if (!Array.isArray(value) || value.length === 0) {
    return false;
  }

  for (let index = 0; index < value.length; index += 1) {
    if (!isPort(value[index])) {
      return false;
    }
  }

  return true;
}

function isDestinationArray(value: PlainJson | undefined): boolean {
  if (!Array.isArray(value) || value.length === 0) {
    return false;
  }

  for (let index = 0; index < value.length; index += 1) {
    const destination = value[index];

    if (typeof destination !== "string" || !isValidDestination(destination)) {
      return false;
    }
  }

  return true;
}

function isValidDestination(value: string): boolean {
  if (value.includes("/")) {
    return isValidCidr(value);
  }

  if (value.includes(":")) {
    return isIpv6(value);
  }

  return isIpv4(value);
}

function isValidCidr(value: string): boolean {
  if (value !== value.trim()) {
    return false;
  }

  const slash = value.indexOf("/");
  if (slash <= 0 || slash === value.length - 1) {
    return false;
  }

  const address = value.slice(0, slash);
  const prefixText = value.slice(slash + 1);
  if (!/^[0-9]{1,3}$/u.test(prefixText)) {
    return false;
  }

  const prefix = Number(prefixText);

  if (address.includes(":")) {
    return Number.isInteger(prefix) && prefix >= 0 && prefix <= 128 && isIpv6(address);
  }

  return Number.isInteger(prefix) && prefix >= 0 && prefix <= 32 && isIpv4(address);
}

function isIpv4(value: string): boolean {
  const octets = value.split(".");
  if (octets.length !== 4) {
    return false;
  }

  for (let index = 0; index < octets.length; index += 1) {
    const octet = octets[index];

    if (octet === undefined || !/^[0-9]{1,3}$/u.test(octet)) {
      return false;
    }

    const parsed = Number(octet);
    if (parsed < 0 || parsed > 255) {
      return false;
    }

    if (octet.length > 1 && octet.startsWith("0")) {
      return false;
    }
  }

  return true;
}

function isIpv6(value: string): boolean {
  if (value.length === 0 || /[^0-9A-Fa-f:]/u.test(value)) {
    return false;
  }

  const doubleColon = value.split("::");
  if (doubleColon.length > 2) {
    return false;
  }

  const groups = value.replace("::", ":").split(":").filter((group) => group.length > 0);
  if (groups.length > 8) {
    return false;
  }

  for (let index = 0; index < groups.length; index += 1) {
    const group = groups[index];

    if (group === undefined || group.length > 4) {
      return false;
    }
  }

  return doubleColon.length === 2 || groups.length === 8;
}

function markerToken(value: string): string {
  const token = value.replace(/[^A-Za-z0-9_.-]+/gu, "_");
  return token.length === 0 ? "unknown" : token;
}
