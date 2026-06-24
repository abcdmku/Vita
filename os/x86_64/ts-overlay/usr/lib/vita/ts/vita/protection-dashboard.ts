import { summarizeDashboard } from "./protection-dashboard-model.ts";
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
export const CAPSULE_EXECUTE_CAPABILITY = "capsule.execute";

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

  const dashboardInput = buildDashboardInput(
    storageState.state,
    backupPolicyState.state,
    backupArchiveState.state,
    networkState.state,
    registryState.state,
    await readOptionalCapsuleExecuteState(client),
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

function buildDashboardInput(
  storageState: AgentCapabilityState,
  backupPolicyState: AgentCapabilityState,
  backupArchiveState: AgentCapabilityState,
  networkState: AgentCapabilityState,
  registryState: AgentCapabilityState,
  executeState: AgentCapabilityState | undefined,
):
  | {
      readonly ok: true;
      readonly input: DashboardInput;
    }
  | {
      readonly ok: false;
      readonly reason: string;
    } {
  const storage = unwrapObjectReadState(storageState, "layout", "storage_layout_state_invalid");
  if (!storage.ok) return storage;

  const backupPolicy = unwrapObjectReadState(backupPolicyState, "policy", "backup_policy_state_invalid");
  if (!backupPolicy.ok) return backupPolicy;

  const networkPolicy = unwrapObjectReadState(networkState, "policy", "network_policy_state_invalid");
  if (!networkPolicy.ok) return networkPolicy;

  const registry = unwrapRegistryReadState(registryState);
  if (!registry.ok) return registry;

  const input: DashboardInput = {
    backupArchive: backupArchiveState,
    capsuleNetworkGrants: buildCapsuleNetworkGrants(registry.value, executeState),
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

async function readOptionalCapsuleExecuteState(
  client: Pick<AgentClient, "getState">,
): Promise<AgentCapabilityState | undefined> {
  try {
    return await client.getState(CAPSULE_EXECUTE_CAPABILITY);
  } catch {
    return undefined;
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

function buildCapsuleNetworkGrants(
  registry: readonly PlainJson[] | undefined,
  executeState: AgentCapabilityState | undefined,
): readonly PlainJsonObject[] {
  const grant = readCapsuleExecuteGrant(executeState);

  if (grant === undefined || !registryContainsCapsule(registry, grant.capsuleId)) {
    return Object.freeze([]);
  }

  return Object.freeze([
    Object.freeze({
      capsuleId: grant.capsuleId,
      egressGrants: grant.egressGrants,
      ingressGrants: grant.ingressGrants,
    }),
  ]);
}

function readCapsuleExecuteGrant(
  state: AgentCapabilityState | undefined,
):
  | {
      readonly capsuleId: string;
      readonly egressGrants: number;
      readonly ingressGrants: number;
    }
  | undefined {
  if (state === undefined) {
    return undefined;
  }

  const last = field(state, "last");
  if (!isPlainObject(last)) {
    return undefined;
  }

  const capsuleId = field(last, "id");
  const network = field(last, "network");

  if (typeof capsuleId !== "string" || !isPlainObject(network)) {
    return undefined;
  }

  const egressGrants = field(network, "egress");
  const ingressGrants = field(network, "ingress");

  if (!isNonNegativeSafeInteger(egressGrants) || !isNonNegativeSafeInteger(ingressGrants)) {
    return undefined;
  }

  return {
    capsuleId,
    egressGrants,
    ingressGrants,
  };
}

function registryContainsCapsule(
  registry: readonly PlainJson[] | undefined,
  capsuleId: string,
): boolean {
  if (registry === undefined) {
    return false;
  }

  for (let index = 0; index < registry.length; index += 1) {
    const entry = registry[index];

    if (!isPlainObject(entry)) {
      continue;
    }

    if (field(entry, "id") === capsuleId) {
      return true;
    }
  }

  return false;
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

function isNonNegativeSafeInteger(value: PlainJson | undefined): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function markerToken(value: string): string {
  const token = value.replace(/[^A-Za-z0-9_.-]+/gu, "_");
  return token.length === 0 ? "unknown" : token;
}
