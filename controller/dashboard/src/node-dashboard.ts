import { safeNormalize } from "../../../sdk/typescript/src/safe-normalize.ts";
import type {
  PlainJson,
  PlainJsonObject,
} from "../../../sdk/typescript/src/safe-normalize.ts";
import {
  isAgentClientError,
} from "../../agent-client/src/agent-client.ts";
import type {
  AgentClient,
  AgentClientErrorCode,
} from "../../agent-client/src/agent-client.ts";
import { buildNodeOverview } from "../../overview/src/node-overview.ts";
import type { NodeOverview } from "../../overview/src/node-overview.ts";
import { buildNodeState } from "../../state/src/node-state.ts";
import type {
  NodeCapabilityStateResult,
  NodeState,
} from "../../state/src/node-state.ts";

export type NodeDashboardClient = Pick<
  AgentClient,
  "getHealth" | "getCapabilities" | "getOperations" | "getState"
>;

export type NodeDashboardSectionStatus = "ready" | "degraded" | "unreachable";

export type NodeDashboardErrorCode =
  | "AGENT_UNREACHABLE"
  | "MALFORMED_AGENT_RESULT"
  | "OPERATION_DISCOVERY_FAILED"
  | "STATE_READ_FAILED"
  | "MALFORMED_STATE";

export interface NodeDashboardError {
  readonly code: NodeDashboardErrorCode;
  readonly message: string;
  readonly clientCode?: AgentClientErrorCode;
  readonly status?: number;
  readonly agentCode?: string;
}

export interface NodeDashboardOperations {
  readonly status: NodeDashboardSectionStatus;
  readonly operations: readonly string[];
  readonly error?: NodeDashboardError;
}

export interface NodeDashboardStates {
  readonly status: NodeDashboardSectionStatus;
  readonly states: Readonly<Record<string, NodeCapabilityStateResult>>;
  readonly error?: NodeDashboardError;
}

export interface NodeDashboard {
  readonly overview: NodeOverview;
  readonly operations: NodeDashboardOperations;
  readonly states: NodeDashboardStates;
  readonly reachable: boolean;
}

type ValidationResult<T> =
  | {
      readonly ok: true;
      readonly value: T;
    }
  | {
      readonly ok: false;
      readonly reason: string;
    };

interface SectionRead<T> {
  readonly value: T;
  readonly reached: boolean;
}

const EMPTY_OPERATIONS: readonly string[] = Object.freeze([]);
const EMPTY_STATES: Readonly<Record<string, NodeCapabilityStateResult>> =
  Object.freeze({});
const ERROR_MESSAGE_FALLBACK = "Client operation failed.";

export async function buildNodeDashboard(
  client: NodeDashboardClient,
  capabilities: readonly string[],
): Promise<NodeDashboard> {
  const [overview, operations, states] = await Promise.all([
    readOverview(client),
    readOperations(client),
    readStates(client, capabilities),
  ]);

  return {
    overview: overview.value,
    operations: operations.value,
    reachable: overview.reached || operations.reached || states.reached,
    states: states.value,
  };
}

async function readOverview(
  client: NodeDashboardClient,
): Promise<SectionRead<NodeOverview>> {
  let overview: NodeOverview;

  try {
    overview = await buildNodeOverview(client);
  } catch (error) {
    return {
      reached: false,
      value: fallbackOverview(error),
    };
  }

  return {
    reached: overview.status !== "unreachable",
    value: overview,
  };
}

async function readOperations(
  client: NodeDashboardClient,
): Promise<SectionRead<NodeDashboardOperations>> {
  let rawOperations: unknown;

  try {
    rawOperations = await client.getOperations();
  } catch (error) {
    return {
      reached: false,
      value: failedOperations(error),
    };
  }

  const operations = normalizeStringArray(rawOperations, "operations");

  if (!operations.ok) {
    return {
      reached: false,
      value: {
        error: {
          code: "MALFORMED_AGENT_RESULT",
          message: `Agent operations result is malformed: ${operations.reason}`,
        },
        operations: EMPTY_OPERATIONS,
        status: "degraded",
      },
    };
  }

  return {
    reached: true,
    value: {
      operations: operations.value,
      status: "ready",
    },
  };
}

async function readStates(
  client: NodeDashboardClient,
  capabilities: readonly string[],
): Promise<SectionRead<NodeDashboardStates>> {
  const normalizedCapabilities = normalizeStringArray(capabilities, "capabilities");

  if (!normalizedCapabilities.ok) {
    return {
      reached: false,
      value: {
        error: {
          code: "MALFORMED_STATE",
          message: `State capabilities are malformed: ${normalizedCapabilities.reason}`,
        },
        states: EMPTY_STATES,
        status: "degraded",
      },
    };
  }

  let nodeState: NodeState;

  try {
    nodeState = await buildNodeState(client, normalizedCapabilities.value);
  } catch (error) {
    return {
      reached: false,
      value: {
        error: sectionError(
          stateFailureStatus(error),
          "STATE_READ_FAILED",
          "State aggregation failed.",
          error,
        ),
        states: EMPTY_STATES,
        status: stateFailureStatus(error),
      },
    };
  }

  const status = stateStatus(nodeState, normalizedCapabilities.value.length);
  const stateError = firstStateError(nodeState);
  const base = {
    states: nodeState.states,
    status,
  };

  return {
    reached: hasSuccessfulState(nodeState),
    value: stateError === undefined || status === "ready"
      ? base
      : {
          ...base,
          error: stateError,
        },
  };
}

function failedOperations(error: unknown): NodeDashboardOperations {
  const details = clientErrorDetails(error);
  const status = operationsFailureStatus(details);

  return {
    error: sectionError(
      status,
      "OPERATION_DISCOVERY_FAILED",
      "Operation discovery failed.",
      error,
    ),
    operations: EMPTY_OPERATIONS,
    status,
  };
}

function operationsFailureStatus(
  details:
    | {
        readonly code: AgentClientErrorCode;
      }
    | undefined,
): NodeDashboardSectionStatus {
  if (details === undefined || details.code === "TRANSPORT_ERROR") {
    return "unreachable";
  }
  if (details.code === "MALFORMED_RESPONSE") {
    return "degraded";
  }

  return "degraded";
}

function stateFailureStatus(error: unknown): NodeDashboardSectionStatus {
  const details = clientErrorDetails(error);

  return details === undefined || details.code === "TRANSPORT_ERROR"
    ? "unreachable"
    : "degraded";
}

function stateStatus(
  nodeState: NodeState,
  capabilityCount: number,
): NodeDashboardSectionStatus {
  if (capabilityCount === 0) {
    return "ready";
  }

  let failures = 0;
  let unreachableFailures = 0;

  const keys = Object.keys(nodeState.states);

  for (let index = 0; index < keys.length; index += 1) {
    const key = keys[index];

    if (key === undefined) {
      continue;
    }

    const result = nodeState.states[key];

    if (result === undefined || result.ok) {
      continue;
    }

    failures += 1;

    if (stateResultIsUnreachable(result)) {
      unreachableFailures += 1;
    }
  }

  if (failures === 0) {
    return "ready";
  }
  if (failures === capabilityCount && unreachableFailures === failures) {
    return "unreachable";
  }

  return "degraded";
}

function fallbackOverview(error: unknown): NodeOverview {
  const overviewError = {
    code: "AGENT_UNREACHABLE" as const,
    message: `Agent overview aggregation failed. ${errorMessage(error, ERROR_MESSAGE_FALLBACK)}`,
    source: "health" as const,
  };

  return {
    capabilities: [],
    error: overviewError,
    hardwareCapabilities: null,
    healthy: false,
    readiness: {
      checks: [
        {
          message: overviewError.message,
          name: "agent-health",
          status: "fail",
        },
        {
          message: overviewError.message,
          name: "agent-capabilities",
          status: "fail",
        },
      ],
      ready: false,
      reasons: [overviewError.message],
      status: "unreachable",
    },
    status: "unreachable",
    uptimeSeconds: 0,
  };
}

function hasSuccessfulState(nodeState: NodeState): boolean {
  const keys = Object.keys(nodeState.states);

  for (let index = 0; index < keys.length; index += 1) {
    const key = keys[index];

    if (key !== undefined && nodeState.states[key]?.ok === true) {
      return true;
    }
  }

  return false;
}

function stateResultIsUnreachable(
  result: Extract<NodeCapabilityStateResult, { readonly ok: false }>,
): boolean {
  return (
    result.error.code === "STATE_READ_FAILED" &&
    (result.error.clientCode === undefined ||
      result.error.clientCode === "TRANSPORT_ERROR")
  );
}

function firstStateError(nodeState: NodeState): NodeDashboardError | undefined {
  const keys = Object.keys(nodeState.states);

  for (let index = 0; index < keys.length; index += 1) {
    const key = keys[index];

    if (key === undefined) {
      continue;
    }

    const result = nodeState.states[key];

    if (result !== undefined && !result.ok) {
      const output: {
        code: "STATE_READ_FAILED" | "MALFORMED_STATE";
        message: string;
        clientCode?: AgentClientErrorCode;
        status?: number;
        agentCode?: string;
      } = {
        code: result.error.code,
        message: result.error.message,
      };

      if (result.error.clientCode !== undefined) {
        output.clientCode = result.error.clientCode;
      }
      if (result.error.status !== undefined) {
        output.status = result.error.status;
      }
      if (result.error.agentCode !== undefined) {
        output.agentCode = result.error.agentCode;
      }

      return output;
    }
  }

  return undefined;
}

function sectionError(
  status: NodeDashboardSectionStatus,
  code: "OPERATION_DISCOVERY_FAILED" | "STATE_READ_FAILED",
  message: string,
  error: unknown,
): NodeDashboardError {
  const output: {
    code: NodeDashboardErrorCode;
    message: string;
    clientCode?: AgentClientErrorCode;
    status?: number;
    agentCode?: string;
  } = {
    code: status === "unreachable" ? "AGENT_UNREACHABLE" : code,
    message: `${message} ${errorMessage(error, ERROR_MESSAGE_FALLBACK)}`,
  };
  const details = clientErrorDetails(error);

  if (details !== undefined) {
    output.clientCode = details.code;

    if (details.status !== undefined) {
      output.status = details.status;
    }
    if (details.agentCode !== undefined) {
      output.agentCode = details.agentCode;
    }
  }

  return output;
}

function clientErrorDetails(
  error: unknown,
):
  | {
      readonly code: AgentClientErrorCode;
      readonly status?: number;
      readonly agentCode?: string;
    }
  | undefined {
  try {
    if (!isSafeAgentClientError(error)) return undefined;

    const code = dataProperty(error, "code");

    if (!isAgentClientErrorCode(code)) return undefined;

    const status = dataProperty(error, "status");
    const agentError = dataProperty(error, "agentError");
    const agentCode = agentErrorCode(agentError);
    const output: {
      code: AgentClientErrorCode;
      status?: number;
      agentCode?: string;
    } = { code };

    if (typeof status === "number") {
      output.status = status;
    }
    if (agentCode !== undefined) {
      output.agentCode = agentCode;
    }

    return output;
  } catch {
    return undefined;
  }
}

function agentErrorCode(agentError: unknown): string | undefined {
  try {
    const normalized = safeNormalize(agentError);

    if (!normalized.ok || !isPlainObject(normalized.value)) {
      return undefined;
    }

    const code = field(normalized.value, "code");

    return typeof code === "string" && code !== "" ? code : undefined;
  } catch {
    return undefined;
  }
}

function isSafeAgentClientError(error: unknown): boolean {
  try {
    return isAgentClientError(error);
  } catch {
    return false;
  }
}

function errorMessage(error: unknown, fallback: string): string {
  const message = dataProperty(error, "message");

  if (typeof message === "string" && message !== "") {
    return message;
  }
  if (typeof error === "string" && error !== "") {
    return error;
  }

  return fallback;
}

function dataProperty(value: unknown, key: string): unknown {
  if (value === null || (typeof value !== "object" && typeof value !== "function")) {
    return undefined;
  }

  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);

    if (descriptor === undefined || !Object.hasOwn(descriptor, "value")) {
      return undefined;
    }

    return descriptor.value;
  } catch {
    return undefined;
  }
}

function normalizeStringArray(
  value: unknown,
  path: string,
): ValidationResult<readonly string[]> {
  const normalized = safeNormalize(value);

  if (!normalized.ok) return reject(normalized.reason);

  return validateStringArray(normalized.value, path);
}

function validateStringArray(
  value: PlainJson | undefined,
  path: string,
): ValidationResult<readonly string[]> {
  if (!Array.isArray(value)) return reject(`${path} must be an array.`);

  const output: string[] = [];

  for (let index = 0; index < value.length; index += 1) {
    const item = value[index];

    if (typeof item !== "string" || item === "") {
      return reject(`${path}[${index}] must be a non-empty string.`);
    }

    output[index] = item;
  }

  return accept(Object.freeze(output));
}

function field(value: PlainJsonObject, key: string): PlainJson | undefined {
  if (!Object.hasOwn(value, key)) return undefined;

  return value[key];
}

function isPlainObject(value: PlainJson | undefined): value is PlainJsonObject {
  return value !== undefined && value !== null && typeof value === "object" && !Array.isArray(value);
}

function isAgentClientErrorCode(value: unknown): value is AgentClientErrorCode {
  return (
    value === "AGENT_ERROR" ||
    value === "INVALID_PLAN" ||
    value === "MALFORMED_RESPONSE" ||
    value === "TRANSPORT_ERROR"
  );
}

function accept<T>(value: T): ValidationResult<T> {
  return {
    ok: true,
    value,
  };
}

function reject<T>(reason: string): ValidationResult<T> {
  return {
    ok: false,
    reason,
  };
}
