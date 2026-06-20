import { safeNormalize } from "../../../sdk/typescript/src/safe-normalize.ts";
import type { PlainJson } from "../../../sdk/typescript/src/safe-normalize.ts";
import { isAgentClientError, serializeApplyPlan } from "../../agent-client/src/agent-client.ts";
import type {
  AgentApplyPlan,
  AgentClient,
  AgentClientErrorCode,
} from "../../agent-client/src/agent-client.ts";

export type OperationDiscoveryClient = Pick<AgentClient, "getOperations">;

export type PlanPreviewErrorCode =
  | "INVALID_PLAN"
  | "OPERATION_DISCOVERY_FAILED"
  | "UNKNOWN_OPERATION";

export interface PlanPreviewOperation {
  readonly index: number;
  readonly capability: string;
  readonly known: boolean;
}

export interface PlanPreviewRejection {
  readonly code: "UNKNOWN_OPERATION";
  readonly index: number;
  readonly capability: string;
  readonly message: string;
}

export interface PlanPreviewError {
  readonly code: PlanPreviewErrorCode;
  readonly message: string;
  readonly clientCode?: AgentClientErrorCode;
  readonly status?: number;
}

export type PlanPreview =
  | {
      readonly ok: true;
      readonly operations: readonly PlanPreviewOperation[];
      readonly rejections: readonly [];
    }
  | {
      readonly ok: false;
      readonly operations: readonly PlanPreviewOperation[];
      readonly rejections: readonly PlanPreviewRejection[];
      readonly error: PlanPreviewError;
    };

type ValidationResult<T> =
  | {
      readonly ok: true;
      readonly value: T;
    }
  | {
      readonly ok: false;
      readonly reason: string;
    };

interface SerializedPlanOperation {
  readonly index: number;
  readonly capability: string;
}

const NO_REJECTIONS: readonly [] = Object.freeze([]);

export async function previewPlan(
  client: OperationDiscoveryClient,
  plan: AgentApplyPlan,
): Promise<PlanPreview> {
  const planOperations = normalizePlanOperations(plan);

  if (!planOperations.ok) {
    return invalidPlan(planOperations.reason);
  }

  const discovered = await discoverOperations(client);

  if (!discovered.ok) {
    return discoveryFailed(discovered.reason, discovered.error);
  }

  const operations: PlanPreviewOperation[] = [];
  const rejections: PlanPreviewRejection[] = [];

  for (let index = 0; index < planOperations.value.length; index += 1) {
    const operation = planOperations.value[index];

    if (operation === undefined) {
      return invalidPlan(`operation ${index} is missing.`);
    }

    const known = contains(discovered.value, operation.capability);

    operations[index] = {
      capability: operation.capability,
      index: operation.index,
      known,
    };

    if (!known) {
      rejections[rejections.length] = {
        capability: operation.capability,
        code: "UNKNOWN_OPERATION",
        index: operation.index,
        message: `operation ${operation.index} names unknown capability "${operation.capability}"`,
      };
    }
  }

  const previewOperations = Object.freeze(operations);

  if (rejections.length > 0) {
    const previewRejections = Object.freeze(rejections);

    return {
      error: {
        code: "UNKNOWN_OPERATION",
        message: unknownOperationMessage(previewRejections.length),
      },
      ok: false,
      operations: previewOperations,
      rejections: previewRejections,
    };
  }

  return {
    ok: true,
    operations: previewOperations,
    rejections: NO_REJECTIONS,
  };
}

function normalizePlanOperations(
  plan: AgentApplyPlan,
): ValidationResult<readonly SerializedPlanOperation[]> {
  let serialized: string;

  try {
    serialized = serializeApplyPlan(plan);
  } catch (error) {
    if (isAgentClientError(error)) {
      return reject(error.message);
    }

    return reject("Plan could not be normalized.");
  }

  let parsed: unknown;

  try {
    parsed = JSON.parse(serialized);
  } catch {
    return reject("Serialized plan could not be parsed.");
  }

  return readSerializedPlanOperations(parsed);
}

function readSerializedPlanOperations(
  value: unknown,
): ValidationResult<readonly SerializedPlanOperation[]> {
  if (!isRecord(value)) return reject("plan must be an object.");

  const operations = field(value, "operations");

  if (!Array.isArray(operations)) return reject("operations must be an array.");

  const output: SerializedPlanOperation[] = [];

  for (let index = 0; index < operations.length; index += 1) {
    const operation = operations[index];

    if (!isRecord(operation)) {
      return reject(`operations[${index}] must be an object.`);
    }

    const capability = field(operation, "capability");

    if (typeof capability !== "string" || capability === "") {
      return reject(`operations[${index}].capability must be a non-empty string.`);
    }

    output[index] = {
      capability,
      index,
    };
  }

  return accept(Object.freeze(output));
}

async function discoverOperations(
  client: OperationDiscoveryClient,
): Promise<
  | {
      readonly ok: true;
      readonly value: readonly string[];
    }
  | {
      readonly ok: false;
      readonly reason: string;
      readonly error?: unknown;
    }
> {
  let rawOperations: unknown;

  try {
    rawOperations = await client.getOperations();
  } catch (error) {
    return {
      error,
      ok: false,
      reason: "Operation discovery failed.",
    };
  }

  const operations = normalizeDiscoveredOperations(rawOperations);

  if (!operations.ok) {
    return {
      ok: false,
      reason: `Operation discovery returned malformed operations: ${operations.reason}`,
    };
  }

  return operations;
}

function normalizeDiscoveredOperations(value: unknown): ValidationResult<readonly string[]> {
  const normalized = safeNormalize(value);

  if (!normalized.ok) {
    return reject(normalized.reason);
  }

  return validateStringArray(normalized.value, "operations");
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

function invalidPlan(reason: string): PlanPreview {
  return {
    error: {
      code: "INVALID_PLAN",
      message: `Plan is invalid: ${reason}`,
    },
    ok: false,
    operations: Object.freeze([]),
    rejections: NO_REJECTIONS,
  };
}

function discoveryFailed(reason: string, error: unknown): PlanPreview {
  const previewError: {
    code: "OPERATION_DISCOVERY_FAILED";
    message: string;
    clientCode?: AgentClientErrorCode;
    status?: number;
  } = {
    code: "OPERATION_DISCOVERY_FAILED",
    message: reason,
  };

  if (isAgentClientError(error)) {
    previewError.clientCode = error.code;

    if (error.status !== undefined) {
      previewError.status = error.status;
    }
  }

  return {
    error: previewError,
    ok: false,
    operations: Object.freeze([]),
    rejections: NO_REJECTIONS,
  };
}

function unknownOperationMessage(count: number): string {
  if (count === 1) {
    return "Plan names 1 unknown operation.";
  }

  return `Plan names ${count} unknown operations.`;
}

function contains(values: readonly string[], value: string): boolean {
  for (let index = 0; index < values.length; index += 1) {
    if (values[index] === value) return true;
  }

  return false;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }

  const prototype = Object.getPrototypeOf(value);

  return prototype === Object.prototype || prototype === null;
}

function field(value: Readonly<Record<string, unknown>>, key: string): unknown {
  if (!Object.hasOwn(value, key)) return undefined;

  return value[key];
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
