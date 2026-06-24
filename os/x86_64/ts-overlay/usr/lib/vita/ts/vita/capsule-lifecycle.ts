import { isAgentClientError } from "./agent-client.ts";
import type {
  AgentApplyPlan,
  AgentApplyResult,
  AgentCapabilityState,
  AgentClient,
} from "./agent-client.ts";
import type { PlainJson } from "./safe-normalize.ts";

export const CAPSULE_LIFECYCLE_CAPABILITY = "capsule.lifecycle";

const CAPSULE_ID = "local.test.capsule";
const CAPSULE_INTEGRITY = "sha256-47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU=";
const CAPSULE_VOLUME_PATH = "/var/lib/vita/runtime/volumes/local.test.capsule/state";
const VERSION_V2 = "2.0.0";
const VERSION_UNHEALTHY = "2.0.1-unhealthy";

export type CapsuleLifecycleProofResult =
  | {
      readonly ok: true;
      readonly update: CapsuleLifecycleStatus;
      readonly rollback: CapsuleLifecycleStatus;
      readonly rejectReason: string;
    }
  | {
      readonly ok: false;
      readonly reason: string;
      readonly rejectReason?: string;
    };

export interface CapsuleLifecycleStatus {
  readonly op: string;
  readonly id: string;
  readonly status: string;
  readonly backupId?: string;
  readonly restoredBackupId?: string;
  readonly fromVersion?: string;
  readonly toVersion?: string;
  readonly health?: string;
  readonly rollbackOnUnhealthyOk?: boolean;
}

type LifecycleStatusReadResult =
  | {
      readonly ok: true;
      readonly status: CapsuleLifecycleStatus;
    }
  | {
      readonly ok: false;
      readonly reason: string;
    };

type LifecycleRejectResult =
  | {
      readonly ok: true;
      readonly reason: string;
    }
  | {
      readonly ok: false;
      readonly reason: string;
    };

export async function runCapsuleLifecycleProof(
  client: Pick<AgentClient, "apply" | "getState">,
): Promise<CapsuleLifecycleProofResult> {
  const updateResult = await applyLifecyclePlan(client, buildUpdatePlan(VERSION_V2, lifecycleManifest(VERSION_V2)));
  if (!updateResult.ok) return updateResult;
  if (updateResult.result.outcome !== "committed") {
    return failed(`update_${agentApplyResultReason(updateResult.result)}`);
  }

  const updateStatus = await readLifecycleStatus(client);
  if (!updateStatus.ok) return failed(`update_${updateStatus.reason}`);
  if (
    updateStatus.status.op !== "update" ||
    updateStatus.status.id !== CAPSULE_ID ||
    updateStatus.status.fromVersion !== "1.0.0" ||
    updateStatus.status.toVersion !== VERSION_V2 ||
    updateStatus.status.backupId === undefined ||
    updateStatus.status.health !== "OK" ||
    updateStatus.status.status !== "OK"
  ) {
    return failed("update_not_measured");
  }

  const rollbackApply = await applyLifecyclePlan(
    client,
    buildUpdatePlan(VERSION_UNHEALTHY, unhealthyLifecycleManifest()),
  );
  if (!rollbackApply.ok) return rollbackApply;
  if (rollbackApply.result.outcome === "committed") {
    return failed("rollback_update_committed");
  }

  const rollbackStatus = await readLifecycleStatus(client);
  if (!rollbackStatus.ok) return failed(`rollback_${rollbackStatus.reason}`);
  if (
    rollbackStatus.status.op !== "update" ||
    rollbackStatus.status.id !== CAPSULE_ID ||
    rollbackStatus.status.rollbackOnUnhealthyOk !== true ||
    rollbackStatus.status.restoredBackupId === undefined ||
    rollbackStatus.status.status !== "OK"
  ) {
    return failed("rollback_not_measured");
  }

  const rejected = await rejectInvalidLifecycle(client);
  if (!rejected.ok) {
    return {
      ok: false,
      reason: rejected.reason,
    };
  }

  return {
    ok: true,
    rejectReason: rejected.reason,
    rollback: rollbackStatus.status,
    update: updateStatus.status,
  };
}

export function formatCapsuleLifecycleUpdateMarker(result: CapsuleLifecycleProofResult): string {
  if (!result.ok) {
    return formatCapsuleLifecycleErrorMarker(result.reason);
  }
  return (
    "VITA-CAPSULE-LIFECYCLE: " +
    `op=update id=${result.update.id} ` +
    `from=${result.update.fromVersion ?? "unknown"} ` +
    `to=${result.update.toVersion ?? "unknown"} ` +
    `backup=${markerToken(result.update.backupId ?? "missing")} ` +
    "health=OK status=OK"
  );
}

export function formatCapsuleLifecycleRollbackMarker(result: CapsuleLifecycleProofResult): string {
  if (!result.ok) {
    return formatCapsuleLifecycleErrorMarker(result.reason);
  }
  return (
    "VITA-CAPSULE-LIFECYCLE: " +
    `op=update id=${result.rollback.id} ` +
    "rollback-on-unhealthy=OK " +
    `restored=${markerToken(result.rollback.restoredBackupId ?? "missing")} ` +
    "status=OK"
  );
}

export function formatCapsuleLifecycleRejectMarker(result: CapsuleLifecycleProofResult): string {
  if (!result.ok) {
    const reason = result.rejectReason ?? result.reason;
    return `VITA-CAPSULE-LIFECYCLE-REJECT: op=invalid reason=${markerToken(reason)} status=FAILSAFE`;
  }
  return `VITA-CAPSULE-LIFECYCLE-REJECT: op=invalid reason=${markerToken(result.rejectReason)} status=OK`;
}

export function formatCapsuleLifecycleSummaryMarker(result: CapsuleLifecycleProofResult): string {
  if (!result.ok) {
    return formatCapsuleLifecycleErrorMarker(result.reason);
  }
  return "VITA-CAPSULE-LIFECYCLE: update=OK rollback-on-unhealthy=OK";
}

export function formatCapsuleLifecycleErrorMarker(reason = "transport_failed"): string {
  return `VITA-CAPSULE-LIFECYCLE-ERROR: status=FAILSAFE reason=${markerToken(reason)}`;
}

function buildUpdatePlan(version: string, manifest: PlainJson): AgentApplyPlan {
  return Object.freeze({
    operations: Object.freeze([
      Object.freeze({
        capability: CAPSULE_LIFECYCLE_CAPABILITY,
        request: Object.freeze({
          desired: Object.freeze({
            id: CAPSULE_ID,
            op: "update",
            target: Object.freeze({
              entry: Object.freeze({
                id: CAPSULE_ID,
                integrity: CAPSULE_INTEGRITY,
                state: "installed",
                version,
              }),
              manifest,
            }),
          }),
        }),
      }),
    ]),
  }) satisfies AgentApplyPlan;
}

function buildInvalidPlan(): AgentApplyPlan {
  return Object.freeze({
    operations: Object.freeze([
      Object.freeze({
        capability: CAPSULE_LIFECYCLE_CAPABILITY,
        request: Object.freeze({
          desired: Object.freeze({
            id: CAPSULE_ID,
            op: "delete",
          }),
        }),
      }),
    ]),
  }) satisfies AgentApplyPlan;
}

function lifecycleManifest(version: string) {
  return Object.freeze({
    data: Object.freeze({
      classes: Object.freeze(["app-state"]),
      volumes: Object.freeze([
        Object.freeze({
          access: "read-write",
          backup: false,
          class: "app-state",
          mountPath: CAPSULE_VOLUME_PATH,
          name: "state",
          persistence: "persistent",
          sizeMiB: 8,
        }),
      ]),
    }),
    healthChecks: Object.freeze([
      Object.freeze({
        intervalSeconds: 5,
        name: "lifecycle",
        target: "self",
        timeoutSeconds: 2,
        type: "lifecycle",
      }),
    ]),
    id: CAPSULE_ID,
    integrity: CAPSULE_INTEGRITY,
    lifecyclePolicy: Object.freeze({
      onUnhealthy: "fail",
    }),
    packageClass: "ts-service",
    resourceLimits: Object.freeze({
      cpuCores: 0.25,
      ramMiB: 64,
      storageMiB: 16,
      tasksMax: 32,
    }),
    runtime: Object.freeze({
      typescript: Object.freeze({
        entrypoint: "main.ts",
      }),
    }),
    version,
  });
}

function unhealthyLifecycleManifest() {
  return Object.freeze({
    ...lifecycleManifest(VERSION_UNHEALTHY),
    healthChecks: Object.freeze([
      Object.freeze({
        intervalSeconds: 1,
        name: "forced-down",
        target: "127.0.0.1:9",
        timeoutSeconds: 1,
        type: "tcp",
      }),
    ]),
  });
}

async function applyLifecyclePlan(
  client: Pick<AgentClient, "apply">,
  plan: AgentApplyPlan,
): Promise<
  | {
      readonly ok: true;
      readonly result: AgentApplyResult;
    }
  | {
      readonly ok: false;
      readonly reason: string;
    }
> {
  try {
    return {
      ok: true,
      result: await client.apply(plan),
    };
  } catch (cause) {
    if (
      isAgentClientError(cause) &&
      cause.agentError !== undefined &&
      cause.status !== undefined &&
      cause.status >= 400 &&
      cause.status <= 499
    ) {
      return failed(agentClientErrorReason(cause));
    }
    return failed("transport_failed");
  }
}

async function rejectInvalidLifecycle(
  client: Pick<AgentClient, "apply">,
): Promise<LifecycleRejectResult> {
  try {
    const result = await client.apply(buildInvalidPlan());
    if (result.outcome !== "committed") {
      return {
        ok: true,
        reason: agentApplyResultReason(result),
      };
    }
  } catch (cause) {
    if (
      isAgentClientError(cause) &&
      cause.agentError !== undefined &&
      cause.status !== undefined &&
      cause.status >= 400 &&
      cause.status <= 499
    ) {
      return {
        ok: true,
        reason: agentClientErrorReason(cause),
      };
    }
    return {
      ok: false,
      reason: "reject_transport_failed",
    };
  }

  return {
    ok: false,
    reason: "invalid_lifecycle_committed",
  };
}

async function readLifecycleStatus(
  client: Pick<AgentClient, "getState">,
): Promise<LifecycleStatusReadResult> {
  try {
    return parseLifecycleStatus(await client.getState(CAPSULE_LIFECYCLE_CAPABILITY));
  } catch {
    return {
      ok: false,
      reason: "state_unreadable",
    };
  }
}

function parseLifecycleStatus(state: AgentCapabilityState): LifecycleStatusReadResult {
  const last = state["last"];
  if (!isRecord(last)) return rejectStatus("last_missing");

  const op = readString(last, "op");
  const id = readString(last, "id");
  const status = readString(last, "status");
  const backupId = readOptionalString(last, "backupId");
  const restoredBackupId = readOptionalString(last, "restoredBackupId");
  const fromVersion = readOptionalString(last, "fromVersion");
  const toVersion = readOptionalString(last, "toVersion");
  const health = readOptionalString(last, "health");
  const rollbackOnUnhealthyOk = readOptionalBoolean(last, "rollbackOnUnhealthyOk");

  if (op === undefined || id === undefined || status === undefined) {
    return rejectStatus("required_field_missing");
  }

  return {
    ok: true,
    status: {
      id,
      op,
      status,
      ...(backupId === undefined ? {} : { backupId }),
      ...(restoredBackupId === undefined ? {} : { restoredBackupId }),
      ...(fromVersion === undefined ? {} : { fromVersion }),
      ...(toVersion === undefined ? {} : { toVersion }),
      ...(health === undefined ? {} : { health }),
      ...(rollbackOnUnhealthyOk === undefined ? {} : { rollbackOnUnhealthyOk }),
    },
  };
}

function rejectStatus(reason: string): LifecycleStatusReadResult {
  return {
    ok: false,
    reason,
  };
}

function failed(reason: string): Extract<CapsuleLifecycleProofResult, { readonly ok: false }> {
  return {
    ok: false,
    reason: markerToken(reason),
  };
}

// agentApplyResultReason builds the serial-marker reason from a rejected apply.
// The agent surfaces TWO fields on a failed operation: a stable `code` (e.g.
// capsule_lifecycle_stop_failed) AND a free-form `message` that carries the
// UNDERLYING cause (the systemd `stop`/`reset-failed` stderr, the netns teardown
// step + errno, "unit not found", etc.). Prior revisions dropped the message, so
// the boot marker only ever showed the WRAPPED code — which is why two blind
// fixes could not be confirmed against a real cause. Thread a bounded, safe token
// of the underlying detail through so the marker becomes
//   ...reason=<code>:<underlying-cause>
// revealing the true teardown/stop failure on the next boot. No secrets/PII: the
// detail is the operation error text (systemd unit names, errno, netns step
// labels), passed through markerToken (which strips everything outside
// [A-Za-z0-9_.:-]) and length-bounded.
function agentApplyResultReason(result: AgentApplyResult): string {
  const error = result.error;
  if (error === undefined) {
    return markerToken("transaction_rejected");
  }
  const code = markerToken(error.code.length > 0 ? error.code : "transaction_rejected");
  const detail = underlyingErrorDetail(error.message);
  if (detail === undefined) {
    return code;
  }
  return `${code}:${detail}`;
}

// underlyingErrorDetail extracts the meaningful underlying cause from the agent's
// operation error message, dropping the redundant transaction framing
// (`apply operation <n> capability "<cap>": `) that only repeats what the code
// already conveys. Returns a bounded, marker-safe token, or undefined when there
// is no detail beyond the framing.
const APPLY_OP_PREFIX = /^apply operation \d+ capability "[^"]*":\s*/u;
const MAX_UNDERLYING_DETAIL = 160;

function underlyingErrorDetail(message: string | undefined): string | undefined {
  if (message === undefined) {
    return undefined;
  }
  const stripped = message.replace(APPLY_OP_PREFIX, "").trim();
  if (stripped.length === 0) {
    return undefined;
  }
  const bounded = stripped.length > MAX_UNDERLYING_DETAIL ? stripped.slice(0, MAX_UNDERLYING_DETAIL) : stripped;
  const token = markerToken(bounded);
  return token === "unknown" ? undefined : token;
}

function agentClientErrorReason(cause: unknown): string {
  if (isAgentClientError(cause)) {
    if (cause.agentError !== undefined) {
      return markerToken(cause.agentError.code);
    }
    return markerToken(cause.code.toLowerCase());
  }
  return "transport_failed";
}

function isRecord(value: PlainJson | undefined): value is Readonly<Record<string, PlainJson>> {
  return value !== undefined && value !== null && typeof value === "object" && !Array.isArray(value);
}

function readString(value: Readonly<Record<string, PlainJson>>, key: string): string | undefined {
  const child = value[key];
  return typeof child === "string" && child.length > 0 ? child : undefined;
}

function readOptionalString(value: Readonly<Record<string, PlainJson>>, key: string): string | undefined {
  const child = value[key];
  if (child === undefined) return undefined;
  return typeof child === "string" && child.length > 0 ? child : undefined;
}

function readOptionalBoolean(value: Readonly<Record<string, PlainJson>>, key: string): boolean | undefined {
  const child = value[key];
  if (child === undefined) return undefined;
  return typeof child === "boolean" ? child : undefined;
}

function markerToken(value: string): string {
  const token = value.replace(/[^A-Za-z0-9_.:-]+/gu, "_");
  return token.length === 0 ? "unknown" : token;
}
