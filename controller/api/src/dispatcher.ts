import { diffPlans } from "../../../sdk/typescript/src/diff.ts";
import { explainPlan } from "../../../sdk/typescript/src/explain.ts";
import { normalize } from "../../../sdk/typescript/src/plan.ts";
import { validatePlan } from "../../../sdk/typescript/src/validate.ts";
import type { DeviceSnapshot } from "../../../sdk/typescript/src/capabilities.ts";
import type { CanonicalPlan, DesiredState } from "../../../sdk/typescript/src/plan.ts";
import type {
  ControllerApi,
  ControllerApiDispatchRequest,
  ControllerApiDispatchResult,
  ControllerApiError,
  EmptyParams,
  GetOverviewRequest,
  HealthSummary,
  NodeCapabilitySummary,
  NodeHealthRequest,
  NodeHealthResponse,
  NodeHealthStatus,
  OverviewResponse,
  PlanPreviewRequest,
  PlanPreviewResponse,
  ProtectionSummary,
} from "./contracts.ts";

type JsonRecord = Readonly<Record<string, unknown>>;
type ProtectionState = "protected" | "warning" | "unprotected";

interface InMemoryNode {
  readonly nodeId: string;
  readonly status: NodeHealthStatus;
  readonly uptimeSeconds: number;
  readonly protection: ProtectionState;
  readonly publicServices: number;
  readonly privateServices: number;
  readonly blockedRequests24h: number;
  readonly device: DeviceSnapshot;
}

export interface InMemoryControllerOptions {
  readonly currentPlan?: CanonicalPlan;
  readonly deviceSnapshot?: DeviceSnapshot;
}

const EMPTY_PARAMS: EmptyParams = Object.freeze({});

const DEFAULT_DEVICE_SNAPSHOT: DeviceSnapshot = Object.freeze({
  memoryGB: 32,
  architecture: "x86_64",
  accelerators: Object.freeze([
    Object.freeze({
      kind: "intel.npu",
      generation: "core-ultra",
    }),
    Object.freeze({
      kind: "nvidia.cuda",
      memoryGB: 12,
      compute: "8.6",
    }),
  ]),
  tpm: Object.freeze({
    present: true,
    version: "2.0",
    sealedKeyUnlock: true,
  }),
  virtualization: Object.freeze({
    hardware: true,
    nested: false,
  }),
  storage: Object.freeze({
    bootGB: 128,
    dataGB: 2048,
  }),
  networking: Object.freeze({
    ethernet: true,
    wifi: true,
  }),
});

const DEFAULT_NODE_ID = "node-1";

export function createInMemoryControllerApi(
  options: InMemoryControllerOptions = {},
): ControllerApi {
  const deviceSnapshot = options.deviceSnapshot ?? DEFAULT_DEVICE_SNAPSHOT;
  const nodes = [defaultNode(deviceSnapshot)];
  const fallbackCurrentPlan = options.currentPlan ?? normalize({});

  return {
    getOverview: () => overviewFromNodes(nodes),
    getNodeHealth: (params) => nodeHealthFromNodes(params, nodes, deviceSnapshot),
    previewPlan: (params) => previewPlan(params, deviceSnapshot, fallbackCurrentPlan),
  };
}

export function dispatchControllerRequest(
  api: ControllerApi,
  request: ControllerApiDispatchRequest,
): ControllerApiDispatchResult {
  try {
    switch (request.method) {
      case "getOverview":
        readOverviewParams(request.params);
        return {
          ok: true,
          method: "getOverview",
          response: api.getOverview(),
        };
      case "getNodeHealth":
        return {
          ok: true,
          method: "getNodeHealth",
          response: api.getNodeHealth(readNodeHealthParams(request.params)),
        };
      case "previewPlan":
        return {
          ok: true,
          method: "previewPlan",
          response: api.previewPlan(readPlanPreviewParams(request.params)),
        };
      default:
        return dispatchError("UNKNOWN_METHOD", `Unknown controller API method: ${request.method}`);
    }
  } catch (error) {
    return dispatchError(
      "INVALID_PARAMS",
      error instanceof Error ? error.message : "Invalid controller API request parameters.",
    );
  }
}

function previewPlan(
  params: PlanPreviewRequest,
  deviceSnapshot: DeviceSnapshot,
  fallbackCurrentPlan: CanonicalPlan,
): PlanPreviewResponse {
  const validation = validatePlan(params.desiredState, deviceSnapshot);

  if (!validation.ok) {
    return {
      ok: false,
      validation,
      error: {
        code: "VALIDATION_FAILED",
        message: "Desired state failed plan validation.",
      },
    };
  }

  try {
    const desiredPlan = normalize(params.desiredState);
    const currentPlan = params.currentPlan ?? fallbackCurrentPlan;
    const diff = diffPlans(currentPlan, desiredPlan);
    const explanation = explainPlan(desiredPlan);

    return {
      ok: true,
      validation,
      diff,
      explanation,
    };
  } catch (error) {
    return {
      ok: false,
      validation: {
        ok: false,
        errors: [
          {
            path: "",
            message: error instanceof Error ? error.message : "Plan preview failed.",
          },
        ],
      },
      error: {
        code: "VALIDATION_FAILED",
        message: "Plan preview failed.",
      },
    };
  }
}

function overviewFromNodes(nodes: readonly InMemoryNode[]): OverviewResponse {
  return {
    nodeCount: nodes.length,
    health: summarizeHealth(nodes),
    protection: summarizeProtection(nodes),
    exposure: summarizeExposure(nodes),
  };
}

function nodeHealthFromNodes(
  params: NodeHealthRequest,
  nodes: readonly InMemoryNode[],
  fallbackDevice: DeviceSnapshot,
): NodeHealthResponse {
  const node = nodes.find((candidate) => candidate.nodeId === params.nodeId);

  if (node === undefined) {
    return {
      nodeId: params.nodeId,
      status: "offline",
      uptimeSeconds: 0,
      capabilities: capabilitySummary(fallbackDevice),
    };
  }

  return {
    nodeId: node.nodeId,
    status: node.status,
    uptimeSeconds: node.uptimeSeconds,
    capabilities: capabilitySummary(node.device),
  };
}

function summarizeHealth(nodes: readonly InMemoryNode[]): HealthSummary {
  const summary = { healthy: 0, degraded: 0, offline: 0 };

  for (const node of nodes) {
    summary[node.status] += 1;
  }

  return summary;
}

function summarizeProtection(nodes: readonly InMemoryNode[]): ProtectionSummary {
  const summary = { protected: 0, warnings: 0, unprotected: 0 };

  for (const node of nodes) {
    switch (node.protection) {
      case "protected":
        summary.protected += 1;
        break;
      case "warning":
        summary.warnings += 1;
        break;
      case "unprotected":
        summary.unprotected += 1;
        break;
    }
  }

  return summary;
}

function summarizeExposure(nodes: readonly InMemoryNode[]): OverviewResponse["exposure"] {
  const summary = { publicServices: 0, privateServices: 0, blockedRequests24h: 0 };

  for (const node of nodes) {
    summary.publicServices += node.publicServices;
    summary.privateServices += node.privateServices;
    summary.blockedRequests24h += node.blockedRequests24h;
  }

  return summary;
}

function capabilitySummary(device: DeviceSnapshot): NodeCapabilitySummary {
  return {
    memoryGB: device.memoryGB,
    architecture: device.architecture,
    accelerators: device.accelerators,
    tpm: optionalTpmSummary(device),
    virtualization: optionalVirtualizationSummary(device),
  };
}

function optionalTpmSummary(device: DeviceSnapshot): NodeCapabilitySummary["tpm"] {
  return {
    present: device.tpm.present,
    ...(device.tpm.version === undefined ? {} : { version: device.tpm.version }),
    ...(device.tpm.sealedKeyUnlock === undefined
      ? {}
      : { sealedKeyUnlock: device.tpm.sealedKeyUnlock }),
  };
}

function optionalVirtualizationSummary(
  device: DeviceSnapshot,
): NodeCapabilitySummary["virtualization"] {
  return {
    hardware: device.virtualization.hardware,
    ...(device.virtualization.nested === undefined ? {} : { nested: device.virtualization.nested }),
  };
}

function defaultNode(device: DeviceSnapshot): InMemoryNode {
  return {
    nodeId: DEFAULT_NODE_ID,
    status: "healthy",
    uptimeSeconds: 86_400,
    protection: "protected",
    publicServices: 1,
    privateServices: 3,
    blockedRequests24h: 12,
    device,
  };
}

function readOverviewParams(params: unknown): GetOverviewRequest {
  if (params === undefined) {
    return EMPTY_PARAMS;
  }

  if (!isRecord(params)) {
    throw new TypeError("getOverview params must be an object when provided.");
  }

  rejectUnknownParams(params, new Set<string>(), "getOverview");
  return EMPTY_PARAMS;
}

function readNodeHealthParams(params: unknown): NodeHealthRequest {
  if (!isRecord(params)) {
    throw new TypeError("getNodeHealth params must be an object.");
  }

  rejectUnknownParams(params, new Set(["nodeId"]), "getNodeHealth");

  if (typeof params.nodeId !== "string" || params.nodeId === "") {
    throw new TypeError("getNodeHealth params.nodeId must be a non-empty string.");
  }

  return {
    nodeId: params.nodeId,
  };
}

function readPlanPreviewParams(params: unknown): PlanPreviewRequest {
  if (!isRecord(params)) {
    throw new TypeError("previewPlan params must be an object.");
  }

  rejectUnknownParams(params, new Set(["desiredState", "currentPlan"]), "previewPlan");

  if (!Object.prototype.hasOwnProperty.call(params, "desiredState")) {
    throw new TypeError("previewPlan params.desiredState is required.");
  }

  const desiredState = params.desiredState as DesiredState;
  const currentPlan = params.currentPlan;

  if (currentPlan === undefined) {
    return { desiredState };
  }

  return {
    desiredState,
    currentPlan: currentPlan as CanonicalPlan,
  };
}

function rejectUnknownParams(
  params: JsonRecord,
  allowed: ReadonlySet<string>,
  method: string,
): void {
  for (const key of Object.keys(params)) {
    if (!allowed.has(key)) {
      throw new TypeError(`${method} params.${key} is not a known field.`);
    }
  }
}

function dispatchError(
  code: ControllerApiError["code"],
  message: string,
): ControllerApiDispatchResult {
  return {
    ok: false,
    error: {
      code,
      message,
    },
  };
}

function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
