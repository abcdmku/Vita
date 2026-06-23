// Vita on-device TypeScript entrypoint (P1-033).
//
// Runs under the pinned, vendored Deno runtime as the vita-ts.service oneshot at boot.
// It keeps the original VITA-TS proof marker, then exercises the real deterministic
// config -> TransactionPlan evaluator vendored under ./vita/.
//
// Determinism / supply chain:
//   - NO remote imports. Every import is a relative path to a vendored file under this overlay.
//   - NO broad filesystem or network access. The only I/O is a scoped AF_UNIX health probe to agentd
//     after the pure evaluator/preview markers have run.
//   - The representative configs below are fixed literals, so the emitted plan hash is stable.

import { evaluateNodeConfig } from "./vita/evaluate.ts";
import { diffTransactionPlans, TransactionPlanDiffError } from "./vita/transaction-plan-diff.ts";
import { explainTransactionPlanChange } from "./vita/transaction-plan-explain.ts";
import { DEFAULT_CAPABILITY_MANIFESTS } from "./vita/generated/capability-manifests.generated.ts";
import { createAgentClient, isAgentClientError } from "./vita/agent-client.ts";
import { applyNodeConfig } from "./vita/apply-node-config.ts";
import { buildCapsuleRegistryConfig } from "./vita/capsule-registry-model.ts";
import {
  formatCapsuleRegistryPreviewMarker,
  ON_DEVICE_CAPSULE_ENTRY,
  ON_DEVICE_CAPSULE_REGISTRY,
  readCapsuleRegistryPreview,
} from "./vita/capsule-preview.ts";
import { formatAgentStateMarker, readAgentStateSummary } from "./vita/agent-state.ts";
import { formatPdsSyncStateReadMarker, readPdsSyncStateSummary } from "./vita/pds-read.ts";
import {
  applyPdsSyncStateWrite,
  formatPdsSyncStateWriteMarker,
  rejectInvalidPdsSyncStateWrite,
} from "./vita/pds-write.ts";
import {
  createDenoUnixSocketAgentTransport,
  createDenoUnixSocketApplyAgentTransport,
} from "./vita/unix-socket-transport.ts";
import type { AgentApplyPlan, AgentApplyResult, AgentClient, AgentTransport } from "./vita/agent-client.ts";
import type {
  ApplyNodeApplyResult,
  ApplyNodeConfigResult,
  ApplyNodeTransport,
} from "./vita/apply-node-config.ts";
import type { CapsuleEntry } from "./vita/capsule-registry-model.ts";
import type { CapabilityManifest } from "./vita/capability-manifest.ts";

const TS_MARKER = "VITA-TS";
const EVAL_MARKER = "VITA-EVAL";
const REJECT_MARKER = "VITA-EVAL-REJECT";
const PREVIEW_MARKER = "VITA-PREVIEW";
const PREVIEW_NOOP_MARKER = "VITA-PREVIEW-NOOP";
const PREVIEW_ERROR_MARKER = "VITA-PREVIEW-ERROR";
const EXPLAIN_MARKER = "VITA-EXPLAIN";
const CONNECT_MARKER = "VITA-CONNECT";
const CONNECT_ERROR_MARKER = "VITA-CONNECT-ERROR";
const STATE_ERROR_MARKER = "VITA-STATE-ERROR";
const APPLY_MARKER = "VITA-APPLY";
const APPLY_ERROR_MARKER = "VITA-APPLY-ERROR";
const CAPSULE_MARKER = "VITA-CAPSULE";
const CAPSULE_ERROR_MARKER = "VITA-CAPSULE-ERROR";
const CAPSULE_PREVIEW_ERROR_MARKER = "VITA-CAPSULE-PREVIEW-ERROR";
const CAPSULE_EXECUTED_MARKER = "VITA-CAPSULE-EXECUTED";
const CAPSULE_EXECUTE_REJECT_MARKER = "VITA-CAPSULE-EXECUTE-REJECT";
const CAPSULE_EXECUTE_ERROR_MARKER = "VITA-CAPSULE-EXECUTE-ERROR";
const CAPSULE_VOLUME_MARKER = "VITA-CAPSULE-VOLUME";
const CAPSULE_VOLUME_ERROR_MARKER = "VITA-CAPSULE-VOLUME-ERROR";
const AGENTD_SOCKET_PATH = "/run/vita-agent/agentd.sock";
const AGENTD_BASE_URL = "http://agentd";
const CAPSULE_EXECUTE_CAPABILITY = "capsule.execute";
const APPLY_JSON_HEADERS = Object.freeze({
  Accept: "application/json",
  "Content-Type": "application/json",
});

const CAPABILITY_REGISTRY = new Map<string, CapabilityManifest>(
  Object.entries(DEFAULT_CAPABILITY_MANIFESTS),
);

const VALID_CONFIG = Object.freeze({
  "hostname.set": Object.freeze({
    desired: "vita-node-7",
  }),
  "node.config": Object.freeze({
    desired: Object.freeze({
      mode: "normal",
      remoteAccess: "disabled",
    }),
  }),
  "time.sync": Object.freeze({
    desired: Object.freeze({
      enabled: true,
      servers: Object.freeze(["Pool.NTP.Org", "2001:0db8::1"]),
    }),
  }),
});

const INVALID_CONFIG = Object.freeze({
  "time.sync": Object.freeze({
    desired: Object.freeze({
      enabled: true,
      servers: Object.freeze([]),
    }),
  }),
});

const FORCED_REJECT_PLAN = Object.freeze({
  operations: Object.freeze([
    Object.freeze({
      capability: "vita.invalid.capability",
      request: Object.freeze({
        desired: true,
      }),
    }),
  ]),
}) satisfies AgentApplyPlan;

const FORCED_INVALID_CAPSULE_PLAN = Object.freeze({
  operations: Object.freeze([
    Object.freeze({
      capability: "capsule.registry",
      request: Object.freeze({
        desired: Object.freeze({
          capsules: Object.freeze([
            Object.freeze({
              id: ON_DEVICE_CAPSULE_ENTRY.id,
              integrity: "sha256-AAAA",
              state: ON_DEVICE_CAPSULE_ENTRY.state,
              version: ON_DEVICE_CAPSULE_ENTRY.version,
            }),
          ]),
        }),
      }),
    }),
  ]),
}) satisfies AgentApplyPlan;

const CAPSULE_EXECUTE_PLAN = Object.freeze({
  operations: Object.freeze([
    Object.freeze({
      capability: CAPSULE_EXECUTE_CAPABILITY,
      request: Object.freeze({
        desired: Object.freeze({
          id: ON_DEVICE_CAPSULE_ENTRY.id,
          integrity: ON_DEVICE_CAPSULE_ENTRY.integrity,
          version: ON_DEVICE_CAPSULE_ENTRY.version,
        }),
      }),
    }),
  ]),
}) satisfies AgentApplyPlan;

const FORCED_INVALID_CAPSULE_EXECUTE_PLAN = Object.freeze({
  operations: Object.freeze([
    Object.freeze({
      capability: CAPSULE_EXECUTE_CAPABILITY,
      request: Object.freeze({
        desired: Object.freeze({
          id: "local.missing.capsule",
          integrity: ON_DEVICE_CAPSULE_ENTRY.integrity,
          version: ON_DEVICE_CAPSULE_ENTRY.version,
        }),
      }),
    }),
  ]),
}) satisfies AgentApplyPlan;

// Config-change PREVIEW (P1-034): evaluate a CURRENT and a DESIRED config via the
// real evaluator, then diff the two TransactionPlans by capability. The CURRENT
// config is the same valid baseline as VALID_CONFIG; the DESIRED config differs in
// exactly three ways so the preview demonstrates add + remove + change:
//   - ADD     "network.policy"   (present in DESIRED, absent from CURRENT)
//   - REMOVE  "time.sync"        (present in CURRENT, absent from DESIRED)
//   - CHANGE  "node.config"      (request differs: mode normal -> maintenance)
//   - keep    "hostname.set"     (identical in both -> not reported)
const PREVIEW_CURRENT_CONFIG = VALID_CONFIG;

const PREVIEW_DESIRED_CONFIG = Object.freeze({
  "hostname.set": Object.freeze({
    desired: "vita-node-7",
  }),
  "node.config": Object.freeze({
    desired: Object.freeze({
      mode: "maintenance",
      remoteAccess: "disabled",
    }),
  }),
  "network.policy": Object.freeze({
    desired: Object.freeze({
      allow: Object.freeze([
        Object.freeze({
          proto: "tcp",
          port: 443,
          sourceCidr: "10.0.0.5/24",
          interface: "eth0",
        }),
      ]),
    }),
  }),
});

function emit(line: string): void {
  console.log(line);
}

async function main(): Promise<number> {
  emit(`${TS_MARKER}: hello from Deno ${Deno.version.deno} status=OK`);

  const valid = evaluateNodeConfig(VALID_CONFIG, CAPABILITY_REGISTRY);

  if (!valid.ok) {
    const first = valid.rejections[0];
    const code = first?.code ?? "NO_REJECTION";
    emit(`${EVAL_MARKER}: caps=${CAPABILITY_REGISTRY.size} ops=0 planHash=0 status=FAIL code=${code}`);
    return 1;
  }

  const canonicalPlan = stableStringify(valid.plan);
  emit(
    `${EVAL_MARKER}: caps=${CAPABILITY_REGISTRY.size} ` +
      `ops=${valid.plan.operations.length} ` +
      `planHash=${fnv1a64Hex(canonicalPlan)} ` +
      "status=OK",
  );

  const invalid = evaluateNodeConfig(INVALID_CONFIG, CAPABILITY_REGISTRY);

  if (invalid.ok) {
    emit(`${REJECT_MARKER}: code=NOT_REJECTED status=FAIL`);
    return 1;
  }

  const firstRejection = invalid.rejections[0];
  const rejectionCode = firstRejection?.code ?? "NO_REJECTION";
  emit(`${REJECT_MARKER}: code=${rejectionCode} status=OK`);

  if (firstRejection === undefined) {
    return 1;
  }

  const previewStatus = runPreview();
  if (previewStatus !== 0) {
    return previewStatus;
  }

  await emitAgentdConnectMarker();
  return 0;
}

// Evaluate CURRENT + DESIRED configs and diff their TransactionPlans, emitting the
// grep-able preview markers. Returns 0 on success, non-zero on any failure.
function runPreview(): number {
  // Real change: CURRENT -> DESIRED adds/removes/changes one capability each.
  const current = evaluateNodeConfig(PREVIEW_CURRENT_CONFIG, CAPABILITY_REGISTRY);
  const desired = evaluateNodeConfig(PREVIEW_DESIRED_CONFIG, CAPABILITY_REGISTRY);

  if (!current.ok) {
    const code = current.rejections[0]?.code ?? "NO_REJECTION";
    emit(`${PREVIEW_MARKER}: added=0 removed=0 changed=0 status=FAIL code=${code}`);
    return 1;
  }

  if (!desired.ok) {
    const code = desired.rejections[0]?.code ?? "NO_REJECTION";
    emit(`${PREVIEW_MARKER}: added=0 removed=0 changed=0 status=FAIL code=${code}`);
    return 1;
  }

  // The diff is fail-CLOSED-by-throwing: a malformed/exotic plan throws
  // TransactionPlanDiffError rather than returning a benign "no changes". The
  // evaluator's own output is always clean, so the normal path never throws — but
  // we catch and emit an explicit fail-safe marker (NOT a bogus added=0/removed=0/
  // changed=0) so the fail-closed wiring is provably in place end to end.
  let change;
  let noopChange;
  try {
    // Real change: CURRENT -> DESIRED adds/removes/changes one capability each.
    change = diffTransactionPlans(current.plan, desired.plan);
    // No-op change: CURRENT diffed against itself yields an empty diff.
    noopChange = diffTransactionPlans(current.plan, current.plan);
  } catch (cause) {
    if (cause instanceof TransactionPlanDiffError) {
      emit(`${PREVIEW_ERROR_MARKER}: status=FAILSAFE`);
      return 1;
    }

    throw cause;
  }

  emit(
    `${PREVIEW_MARKER}: ` +
      `added=${change.added.length} ` +
      `removed=${change.removed.length} ` +
      `changed=${change.changed.length} ` +
      "status=OK",
  );

  const explainLines = explainTransactionPlanChange(change);
  emit(`${EXPLAIN_MARKER}: lines=${explainLines.length} status=OK`);

  for (let index = 0; index < explainLines.length; index += 1) {
    const line = explainLines[index];

    if (line !== undefined) {
      emit(`${EXPLAIN_MARKER}| ${line}`);
    }
  }

  if (
    noopChange.added.length !== 0 ||
    noopChange.removed.length !== 0 ||
    noopChange.changed.length !== 0
  ) {
    emit(`${PREVIEW_NOOP_MARKER}: status=FAIL`);
    return 1;
  }

  emit(`${PREVIEW_NOOP_MARKER}: status=OK`);
  return 0;
}

async function emitAgentdConnectMarker(): Promise<void> {
  const transport = createDenoUnixSocketAgentTransport({
    socketPath: AGENTD_SOCKET_PATH,
  });
  const client = createAgentClient({
    baseUrl: AGENTD_BASE_URL,
    transport,
  });

  try {
    const health = await client.getHealth();

    if (!health.healthy || health.version.length === 0) {
      throw new Error("agentd healthz was not healthy");
    }

    emit(`${CONNECT_MARKER}: transport=unix peer=agentd healthz=OK status=OK`);
  } catch {
    emit(`${CONNECT_ERROR_MARKER}: status=FAILSAFE`);
    emit(`${STATE_ERROR_MARKER}: status=FAILSAFE`);
    emit(`${APPLY_ERROR_MARKER}: status=FAILSAFE`);
    emit(formatPdsSyncStateReadMarker({ ok: false, reason: "agentd connect failed" }));
    emit(formatPdsSyncStateWriteMarker({ ok: false, reason: "agentd connect failed" }));
    emit(`${CAPSULE_PREVIEW_ERROR_MARKER}: status=FAILSAFE`);
    emit(`${CAPSULE_ERROR_MARKER}: status=FAILSAFE`);
    emit(`${CAPSULE_EXECUTE_ERROR_MARKER}: status=FAILSAFE`);
    emit(`${CAPSULE_VOLUME_ERROR_MARKER}: status=FAILSAFE`);
    return;
  }

  const agentTransport = createDenoUnixSocketApplyAgentTransport({
    socketPath: AGENTD_SOCKET_PATH,
  });
  const state = await readAgentStateSummary(client);
  if (state.ok) {
    emit(formatAgentStateMarker(state.state));
    await emitApplyMarkers(state.state.hostname, agentTransport);
    if (await emitCapsulePreviewMarker(client)) {
      await emitCapsuleMarkers(agentTransport);
    } else {
      emit(`${CAPSULE_ERROR_MARKER}: status=FAILSAFE`);
      emit(`${CAPSULE_EXECUTE_ERROR_MARKER}: status=FAILSAFE`);
      emit(`${CAPSULE_VOLUME_ERROR_MARKER}: status=FAILSAFE`);
    }
  } else {
    emit(`${STATE_ERROR_MARKER}: status=FAILSAFE`);
    emit(`${APPLY_ERROR_MARKER}: status=FAILSAFE`);
    emit(`${CAPSULE_PREVIEW_ERROR_MARKER}: status=FAILSAFE`);
    emit(`${CAPSULE_ERROR_MARKER}: status=FAILSAFE`);
    emit(`${CAPSULE_EXECUTE_ERROR_MARKER}: status=FAILSAFE`);
    emit(`${CAPSULE_VOLUME_ERROR_MARKER}: status=FAILSAFE`);
  }

  await emitPdsReadMarker(client);
  if (await emitPdsWriteMarkers(agentTransport)) {
    await emitPdsReadMarker(client);
  }
}

async function emitApplyMarkers(
  currentHostname: string,
  agentTransport: AgentTransport,
): Promise<void> {
  const result = await applyNodeConfig(
    hostnameConfig(currentHostname),
    CAPABILITY_REGISTRY,
    createApplyNodeTransport(agentTransport),
  );

  emit(formatApplyConfigMarker(result));

  if (!result.ok && result.stage === "transport") {
    return;
  }

  await emitForcedRejectMarker(agentTransport);
}

async function emitCapsuleMarkers(agentTransport: AgentTransport): Promise<void> {
  const config = buildCapsuleRegistryConfig(ON_DEVICE_CAPSULE_REGISTRY);

  if (!config.ok) {
    emit(`${CAPSULE_ERROR_MARKER}: status=FAILSAFE`);
    emit(`${CAPSULE_EXECUTE_ERROR_MARKER}: status=FAILSAFE`);
    emit(`${CAPSULE_VOLUME_ERROR_MARKER}: status=FAILSAFE`);
    return;
  }

  const result = await applyNodeConfig(
    config.config,
    CAPABILITY_REGISTRY,
    createApplyNodeTransport(agentTransport),
  );

  if (!result.ok) {
    emit(`${CAPSULE_ERROR_MARKER}: status=FAILSAFE`);
    emit(`${CAPSULE_EXECUTE_ERROR_MARKER}: status=FAILSAFE`);
    emit(`${CAPSULE_VOLUME_ERROR_MARKER}: status=FAILSAFE`);
    return;
  }

  emit(formatCommittedCapsuleMarker(ON_DEVICE_CAPSULE_ENTRY, result.applyResult));
  await emitCapsuleExecuteMarkers(agentTransport);
  await emitForcedCapsuleRejectMarker(agentTransport);
}

async function emitCapsulePreviewMarker(
  client: Pick<AgentClient, "getState">,
): Promise<boolean> {
  const result = await readCapsuleRegistryPreview(client);
  emit(formatCapsuleRegistryPreviewMarker(result));
  return result.ok;
}

function hostnameConfig(currentHostname: string): unknown {
  return {
    "hostname.set": {
      desired: currentHostname,
    },
  };
}

function createApplyNodeTransport(agentTransport: AgentTransport): ApplyNodeTransport {
  return async (method, path, body) => {
    const response = await agentTransport(new URL(path, AGENTD_BASE_URL).toString(), {
      body: JSON.stringify(body),
      headers: APPLY_JSON_HEADERS,
      method,
    });

    return {
      body: parseJsonOrText(await response.text()),
      status: response.status,
    };
  };
}

function parseJsonOrText(text: string): unknown {
  if (text.length === 0) {
    return {};
  }

  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function formatApplyConfigMarker(result: ApplyNodeConfigResult): string {
  if (result.ok) {
    return formatCommittedApplyMarker(result.applyResult);
  }

  if (result.stage === "apply" && result.applyResult?.outcome === "rejected") {
    return `${APPLY_MARKER}: outcome=rejected reason=${applyResultReason(result.applyResult, result.reason)} status=OK`;
  }

  return `${APPLY_ERROR_MARKER}: status=FAILSAFE`;
}

function formatCommittedApplyMarker(result: ApplyNodeApplyResult): string {
  return (
    `${APPLY_MARKER}: ` +
    `outcome=${result.outcome} ` +
    `applied=${result.applied.length} ` +
    `rolledBack=${result.rolledBack.length} ` +
    `audit=${result.auditUnrecorded === true ? "unrecorded" : "recorded"} ` +
    "status=OK"
  );
}

function formatCommittedCapsuleMarker(
  entry: CapsuleEntry,
  result: ApplyNodeApplyResult,
): string {
  return (
    `${CAPSULE_MARKER}: ` +
    `id=${entry.id} ` +
    `ver=${entry.version} ` +
    `state=${entry.state} ` +
    `outcome=${result.outcome} ` +
    "status=OK"
  );
}

async function emitForcedRejectMarker(agentTransport: AgentTransport): Promise<void> {
  const client = createAgentClient({
    baseUrl: AGENTD_BASE_URL,
    transport: agentTransport,
  });

  try {
    const result = await client.apply(FORCED_REJECT_PLAN);

    if (result.outcome === "rejected") {
      emit(`${APPLY_MARKER}: outcome=rejected reason=${agentApplyResultReason(result)} status=OK`);
      return;
    }
  } catch (cause) {
    if (
      isAgentClientError(cause) &&
      cause.agentError !== undefined &&
      cause.status !== undefined &&
      cause.status >= 400 &&
      cause.status <= 499
    ) {
      emit(`${APPLY_MARKER}: outcome=rejected reason=${markerToken(cause.agentError.code)} status=OK`);
      return;
    }
  }

  emit(`${APPLY_ERROR_MARKER}: status=FAILSAFE`);
}

async function emitPdsReadMarker(client: Pick<AgentClient, "getState">): Promise<void> {
  emit(formatPdsSyncStateReadMarker(await readPdsSyncStateSummary(client)));
}

async function emitPdsWriteMarkers(agentTransport: AgentTransport): Promise<boolean> {
  const result = await applyPdsSyncStateWrite(
    CAPABILITY_REGISTRY,
    createApplyNodeTransport(agentTransport),
  );

  emit(formatPdsSyncStateWriteMarker(result));

  if (!result.ok || result.outcome !== "committed") {
    return false;
  }

  const client = createAgentClient({
    baseUrl: AGENTD_BASE_URL,
    transport: agentTransport,
  });
  const rejected = await rejectInvalidPdsSyncStateWrite(client);
  emit(formatPdsSyncStateWriteMarker(rejected));
  return true;
}

async function emitForcedCapsuleRejectMarker(agentTransport: AgentTransport): Promise<void> {
  const client = createAgentClient({
    baseUrl: AGENTD_BASE_URL,
    transport: agentTransport,
  });

  try {
    const result = await client.apply(FORCED_INVALID_CAPSULE_PLAN);

    if (result.outcome === "rejected") {
      emit(`${CAPSULE_MARKER}: outcome=rejected reason=${agentApplyResultReason(result)} status=OK`);
      return;
    }
  } catch (cause) {
    if (
      isAgentClientError(cause) &&
      cause.agentError !== undefined &&
      cause.status !== undefined &&
      cause.status >= 400 &&
      cause.status <= 499
    ) {
      emit(`${CAPSULE_MARKER}: outcome=rejected reason=${markerToken(cause.agentError.code)} status=OK`);
      return;
    }
  }

  emit(`${CAPSULE_ERROR_MARKER}: status=FAILSAFE`);
}

async function emitCapsuleExecuteMarkers(agentTransport: AgentTransport): Promise<void> {
  const client = createAgentClient({
    baseUrl: AGENTD_BASE_URL,
    transport: agentTransport,
  });

  try {
    const result = await client.apply(CAPSULE_EXECUTE_PLAN);

    if (result.outcome !== "committed") {
      emit(`${CAPSULE_EXECUTE_ERROR_MARKER}: status=FAILSAFE`);
      emit(`${CAPSULE_VOLUME_ERROR_MARKER}: status=FAILSAFE`);
      await emitForcedCapsuleExecuteRejectMarker(client);
      return;
    }

    const state = parseCapsuleExecuteState(await client.getState(CAPSULE_EXECUTE_CAPABILITY));

    if (!state.ok) {
      emit(`${CAPSULE_EXECUTE_ERROR_MARKER}: status=FAILSAFE`);
      emit(`${CAPSULE_VOLUME_ERROR_MARKER}: status=FAILSAFE`);
      await emitForcedCapsuleExecuteRejectMarker(client);
      return;
    }

    emit(formatCapsuleExecutedMarker(state.status));
    emit(formatCapsuleVolumeMarker(state.status));
  } catch {
    emit(`${CAPSULE_EXECUTE_ERROR_MARKER}: status=FAILSAFE`);
    emit(`${CAPSULE_VOLUME_ERROR_MARKER}: status=FAILSAFE`);
    return;
  }

  await emitForcedCapsuleExecuteRejectMarker(client);
}

async function emitForcedCapsuleExecuteRejectMarker(
  client: Pick<AgentClient, "apply">,
): Promise<void> {
  try {
    const result = await client.apply(FORCED_INVALID_CAPSULE_EXECUTE_PLAN);

    if (result.outcome !== "committed") {
      emit(`${CAPSULE_EXECUTE_REJECT_MARKER}: reason=${agentApplyResultReason(result)} status=OK`);
      return;
    }
  } catch (cause) {
    if (
      isAgentClientError(cause) &&
      cause.agentError !== undefined &&
      cause.status !== undefined &&
      cause.status >= 400 &&
      cause.status <= 499
    ) {
      emit(`${CAPSULE_EXECUTE_REJECT_MARKER}: reason=${markerToken(cause.agentError.code)} status=OK`);
      return;
    }
  }

  emit(`${CAPSULE_EXECUTE_ERROR_MARKER}: status=FAILSAFE`);
}

type CapsuleExecuteReadResult =
  | {
      readonly ok: true;
      readonly status: CapsuleExecuteStatus;
    }
  | {
      readonly ok: false;
    };

interface CapsuleExecuteStatus {
  readonly id: string;
  readonly unit: string;
  readonly dynamicUid: string;
  readonly health: "OK";
  readonly status: "OK";
  readonly volumes: readonly CapsuleVolumeStatus[];
}

interface CapsuleVolumeStatus {
  readonly name: string;
  readonly path: string;
  readonly mounted: "OK";
  readonly status: "OK";
}

function parseCapsuleExecuteState(value: unknown): CapsuleExecuteReadResult {
  if (!isJsonObject(value)) {
    return { ok: false };
  }

  const last = value["last"];

  if (!isJsonObject(last)) {
    return { ok: false };
  }

  const id = readStringField(last, "id");
  const unit = readStringField(last, "unit");
  const dynamicUid = readStringField(last, "dynamicUid");
  const health = readStringField(last, "health");
  const status = readStringField(last, "status");
  const volumes = readCapsuleVolumeStatuses(last["volumes"]);

  if (
    id === undefined ||
    unit === undefined ||
    dynamicUid === undefined ||
    health !== "OK" ||
    status !== "OK" ||
    volumes === undefined
  ) {
    return { ok: false };
  }

  return {
    ok: true,
    status: {
      dynamicUid,
      health,
      id,
      status,
      unit,
      volumes,
    },
  };
}

function formatCapsuleExecutedMarker(status: CapsuleExecuteStatus): string {
  return (
    `${CAPSULE_EXECUTED_MARKER}: ` +
    `id=${status.id} ` +
    `unit=${status.unit} ` +
    `uid=${status.dynamicUid} ` +
    `health=${status.health} ` +
    "status=OK"
  );
}

function formatCapsuleVolumeMarker(status: CapsuleExecuteStatus): string {
  const volume = status.volumes[0];

  if (volume === undefined) {
    return `${CAPSULE_VOLUME_ERROR_MARKER}: status=FAILSAFE`;
  }

  return (
    `${CAPSULE_VOLUME_MARKER}: ` +
    `id=${status.id} ` +
    `vol=${volume.name} ` +
    `path=${volume.path} ` +
    `mounted=${volume.mounted} ` +
    "status=OK"
  );
}

function readCapsuleVolumeStatuses(value: unknown): readonly CapsuleVolumeStatus[] | undefined {
  if (!Array.isArray(value) || value.length === 0) {
    return undefined;
  }

  const volumes: CapsuleVolumeStatus[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const item = value[index];

    if (!isJsonObject(item)) {
      return undefined;
    }

    const name = readStringField(item, "name");
    const path = readStringField(item, "path");
    const mounted = readStringField(item, "mounted");
    const status = readStringField(item, "status");

    if (
      name === undefined ||
      path === undefined ||
      mounted !== "OK" ||
      status !== "OK"
    ) {
      return undefined;
    }

    volumes[volumes.length] = {
      mounted,
      name,
      path,
      status,
    };
  }

  return Object.freeze(volumes);
}

function readStringField(
  value: Readonly<Record<string, unknown>>,
  key: string,
): string | undefined {
  const child = value[key];

  if (typeof child !== "string" || child.length === 0) {
    return undefined;
  }

  return child;
}

function applyResultReason(result: ApplyNodeApplyResult, fallback: string): string {
  return markerToken(result.error?.code ?? fallback);
}

function agentApplyResultReason(result: AgentApplyResult): string {
  return markerToken(result.error?.code ?? "transaction_rejected");
}

function markerToken(value: string): string {
  const token = value.replace(/[^A-Za-z0-9_.-]+/gu, "_");
  return token.length === 0 ? "unknown" : token;
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    const items: string[] = [];

    for (let index = 0; index < value.length; index += 1) {
      const item = value[index];

      if (item !== undefined) {
        items.push(stableStringify(item));
      }
    }

    return `[${items.join(",")}]`;
  }

  if (!isJsonObject(value)) {
    return JSON.stringify(null);
  }

  const keys = Object.keys(value).sort(compareStrings);
  const entries: string[] = [];

  for (let index = 0; index < keys.length; index += 1) {
    const key = keys[index];

    if (key !== undefined) {
      entries.push(`${JSON.stringify(key)}:${stableStringify(value[key])}`);
    }
  }

  return `{${entries.join(",")}}`;
}

function fnv1a64Hex(input: string): string {
  let hash = 0xcbf29ce484222325n;

  for (let index = 0; index < input.length; index += 1) {
    const codePoint = input.codePointAt(index);

    if (codePoint === undefined) {
      continue;
    }

    if (codePoint > 0xffff) {
      index += 1;
    }

    hash = writeUtf8Byte(hash, codePoint);
  }

  return hash.toString(16).padStart(16, "0");
}

function writeUtf8Byte(hash: bigint, codePoint: number): bigint {
  if (codePoint <= 0x7f) {
    return fnvStep(hash, codePoint);
  }

  if (codePoint <= 0x7ff) {
    return fnvStep(fnvStep(hash, 0xc0 | (codePoint >> 6)), 0x80 | (codePoint & 0x3f));
  }

  if (codePoint <= 0xffff) {
    return fnvStep(
      fnvStep(fnvStep(hash, 0xe0 | (codePoint >> 12)), 0x80 | ((codePoint >> 6) & 0x3f)),
      0x80 | (codePoint & 0x3f),
    );
  }

  return fnvStep(
    fnvStep(
      fnvStep(fnvStep(hash, 0xf0 | (codePoint >> 18)), 0x80 | ((codePoint >> 12) & 0x3f)),
      0x80 | ((codePoint >> 6) & 0x3f),
    ),
    0x80 | (codePoint & 0x3f),
  );
}

function fnvStep(hash: bigint, byte: number): bigint {
  return ((hash ^ BigInt(byte)) * 0x100000001b3n) & 0xffffffffffffffffn;
}

function compareStrings(left: string, right: string): number {
  if (left < right) {
    return -1;
  }

  if (left > right) {
    return 1;
  }

  return 0;
}

function isJsonObject(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

main().then((code) => {
  Deno.exit(code);
}).catch((err) => {
  // Ported from S1 candidate B: a stray rejection must not fail the oneshot silently — fail-safe + exit nonzero.
  console.error("VITA-MAIN-ERROR: status=FAILSAFE", err);
  Deno.exit(1);
});
