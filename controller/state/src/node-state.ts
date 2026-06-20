import { safeNormalize } from "../../../sdk/typescript/src/safe-normalize.ts";
import { isAgentClientError } from "../../agent-client/src/agent-client.ts";
import type {
  AgentCapabilityState,
  AgentClientErrorCode,
} from "../../agent-client/src/agent-client.ts";
import type {
  PlainJson,
  PlainJsonObject,
} from "../../../sdk/typescript/src/safe-normalize.ts";

export interface NodeStateClient {
  getState(capability: string): Promise<unknown>;
}
export type NodeStateErrorCode = "STATE_READ_FAILED" | "MALFORMED_STATE";

export interface NodeStateError {
  readonly code: NodeStateErrorCode;
  readonly message: string;
  readonly clientCode?: AgentClientErrorCode;
  readonly status?: number;
  readonly agentCode?: string;
}

export type NodeCapabilityStateResult =
  | {
      readonly ok: true;
      readonly state: AgentCapabilityState;
    }
  | {
      readonly ok: false;
      readonly error: NodeStateError;
    };

export interface NodeState {
  readonly states: Readonly<Record<string, NodeCapabilityStateResult>>;
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

const ERROR_MESSAGE_FALLBACK = "Capability state read failed.";

export async function buildNodeState(
  client: NodeStateClient,
  capabilities: readonly string[],
): Promise<NodeState> {
  const states: Record<string, NodeCapabilityStateResult> = {};

  for (let index = 0; index < capabilities.length; index += 1) {
    const capability = capabilities[index];

    if (typeof capability !== "string" || capability === "") {
      defineState(states, `capability[${index}]`, {
        error: {
          code: "MALFORMED_STATE",
          message: `Capability name at index ${index} must be a non-empty string.`,
        },
        ok: false,
      });
      continue;
    }

    defineState(states, capability, await readCapabilityState(client, capability));
  }

  return {
    states: Object.freeze(states),
  };
}

async function readCapabilityState(
  client: NodeStateClient,
  capability: string,
): Promise<NodeCapabilityStateResult> {
  let rawState: unknown;

  try {
    rawState = await client.getState(capability);
  } catch (error) {
    return {
      error: readFailedError(capability, error),
      ok: false,
    };
  }

  const state = normalizeState(rawState);

  if (!state.ok) {
    return {
      error: {
        code: "MALFORMED_STATE",
        message: `Capability "${capability}" returned malformed state: ${state.reason}`,
      },
      ok: false,
    };
  }

  return {
    ok: true,
    state: state.value,
  };
}

function normalizeState(value: unknown): ValidationResult<AgentCapabilityState> {
  const normalized = safeNormalize(value);

  if (!normalized.ok) return reject(normalized.reason);
  if (!isPlainObject(normalized.value)) return reject("state must be an object.");

  return accept(normalized.value);
}

function readFailedError(capability: string, error: unknown): NodeStateError {
  const output: {
    code: "STATE_READ_FAILED";
    message: string;
    clientCode?: AgentClientErrorCode;
    status?: number;
    agentCode?: string;
  } = {
    code: "STATE_READ_FAILED",
    message: `Capability "${capability}" state read failed: ${errorMessage(error, ERROR_MESSAGE_FALLBACK)}`,
  };
  const clientError = clientErrorDetails(error);

  if (clientError !== undefined) {
    output.clientCode = clientError.code;

    if (clientError.status !== undefined) {
      output.status = clientError.status;
    }
    if (clientError.agentCode !== undefined) {
      output.agentCode = clientError.agentCode;
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
  if (!isSafeAgentClientError(error)) return undefined;

  const code = dataProperty(error, "code");

  if (!isAgentClientErrorCode(code)) return undefined;

  const status = dataProperty(error, "status");
  const agentError = dataProperty(error, "agentError");
  const agentCode = isRecord(agentError) ? dataProperty(agentError, "code") : undefined;
  const output: {
    code: AgentClientErrorCode;
    status?: number;
    agentCode?: string;
  } = { code };

  if (typeof status === "number") {
    output.status = status;
  }
  if (typeof agentCode === "string" && agentCode !== "") {
    output.agentCode = agentCode;
  }

  return output;
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

function defineState(
  states: Record<string, NodeCapabilityStateResult>,
  capability: string,
  result: NodeCapabilityStateResult,
): void {
  Object.defineProperty(states, capability, {
    configurable: true,
    enumerable: true,
    value: result,
    writable: true,
  });
}

function isPlainObject(value: PlainJson | undefined): value is PlainJsonObject {
  return value !== undefined && value !== null && typeof value === "object" && !Array.isArray(value);
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
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
