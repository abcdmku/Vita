import {
  isAgentClientError,
  serializeApplyPlan,
} from "../../agent-client/src/agent-client.ts";
import type {
  AgentApplyPlan,
  AgentApplyResult,
  AgentClient,
  AgentClientErrorCode,
} from "../../agent-client/src/agent-client.ts";
import { previewPlan } from "../../plan/src/plan-preview.ts";
import type {
  PlanPreviewErrorCode,
  PlanPreviewRejection,
} from "../../plan/src/plan-preview.ts";
import type {
  CanonicalJsonObject,
  CanonicalJsonValue,
} from "../../../sdk/typescript/src/plan.ts";

export type ApplyFlowClient = Pick<AgentClient, "getOperations" | "apply">;

export type ApplyFlowErrorStage = "preview" | "apply";
export type ApplyFlowErrorCode = PlanPreviewErrorCode | "APPLY_FAILED";

export interface ApplyFlowError {
  readonly stage: ApplyFlowErrorStage;
  readonly code: ApplyFlowErrorCode;
  readonly message: string;
  readonly clientCode?: AgentClientErrorCode;
  readonly status?: number;
}

export type ApplyFlowResult =
  | {
      readonly previewed: true;
      readonly applied: AgentApplyResult;
    }
  | {
      readonly previewed: true;
      readonly error: ApplyFlowError;
    }
  | {
      readonly previewed: false;
      readonly rejections: readonly PlanPreviewRejection[];
      readonly error?: ApplyFlowError;
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

const EMPTY_REJECTIONS: readonly PlanPreviewRejection[] = Object.freeze([]);
const APPLY_PLAN_FIELDS = Object.freeze(["operations"]);
const APPLY_OPERATION_FIELDS = Object.freeze(["capability", "request"]);
const ERROR_MESSAGE_FALLBACK = "Client operation failed.";
const INVALID_PLAN_FALLBACK = "Plan could not be normalized.";

export async function applyConfig(
  client: ApplyFlowClient,
  plan: AgentApplyPlan,
): Promise<ApplyFlowResult> {
  const snapshot = snapshotApplyPlan(plan);

  if (!snapshot.ok) {
    return {
      error: snapshot.error,
      previewed: false,
      rejections: EMPTY_REJECTIONS,
    };
  }

  let preview;

  try {
    preview = await previewPlan(client, snapshot.value);
  } catch (error) {
    return {
      error: flowError("preview", "OPERATION_DISCOVERY_FAILED", error, "Preview failed."),
      previewed: false,
      rejections: EMPTY_REJECTIONS,
    };
  }

  if (!preview.ok) {
    if (preview.rejections.length > 0) {
      return {
        previewed: false,
        rejections: preview.rejections,
      };
    }

    return {
      error: previewError(preview.error),
      previewed: false,
      rejections: EMPTY_REJECTIONS,
    };
  }

  try {
    return {
      applied: await client.apply(snapshot.value),
      previewed: true,
    };
  } catch (error) {
    return {
      error: flowError("apply", "APPLY_FAILED", error, "Apply failed."),
      previewed: true,
    };
  }
}

function snapshotApplyPlan(
  plan: AgentApplyPlan,
):
  | {
      readonly ok: true;
      readonly value: AgentApplyPlan;
    }
  | {
      readonly ok: false;
      readonly error: ApplyFlowError;
    } {
  let serialized: string;

  try {
    serialized = serializeApplyPlan(plan);
  } catch (error) {
    return {
      error: flowError("preview", "INVALID_PLAN", error, INVALID_PLAN_FALLBACK),
      ok: false,
    };
  }

  let parsed: unknown;

  try {
    parsed = JSON.parse(serialized);
  } catch {
    return {
      error: {
        code: "INVALID_PLAN",
        message: "Serialized plan could not be parsed.",
        stage: "preview",
      },
      ok: false,
    };
  }

  const snapshot = readSerializedApplyPlan(parsed);

  if (!snapshot.ok) {
    return {
      error: {
        code: "INVALID_PLAN",
        message: `Serialized plan is invalid: ${snapshot.reason}`,
        stage: "preview",
      },
      ok: false,
    };
  }

  return snapshot;
}

function readSerializedApplyPlan(value: unknown): ValidationResult<AgentApplyPlan> {
  if (!isRecord(value)) return reject("plan must be an object.");

  const fields = expectFields(value, APPLY_PLAN_FIELDS);
  if (!fields.ok) return fields;

  const operationsValue = field(value, "operations");
  if (!Array.isArray(operationsValue)) return reject("operations must be an array.");

  const operations = readOperations(operationsValue);
  if (!operations.ok) return operations;

  return accept({
    operations: operations.value,
  });
}

function readOperations(
  values: readonly unknown[],
): ValidationResult<AgentApplyPlan["operations"]> {
  const operations: AgentApplyPlan["operations"][number][] = [];

  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];

    if (!isRecord(value)) {
      return reject(`operations[${index}] must be an object.`);
    }

    const fields = expectFields(value, APPLY_OPERATION_FIELDS, `operations[${index}]`);
    if (!fields.ok) return fields;

    const capability = field(value, "capability");
    const request = field(value, "request");

    if (typeof capability !== "string" || capability === "") {
      return reject(`operations[${index}].capability must be a non-empty string.`);
    }
    if (!isCanonicalJsonObject(request)) {
      return reject(`operations[${index}].request must be an object.`);
    }

    operations[index] = {
      capability,
      request,
    };
  }

  return accept(Object.freeze(operations));
}

function previewError(error: {
  readonly code: PlanPreviewErrorCode;
  readonly message: string;
  readonly clientCode?: AgentClientErrorCode;
  readonly status?: number;
}): ApplyFlowError {
  const output: {
    stage: "preview";
    code: PlanPreviewErrorCode;
    message: string;
    clientCode?: AgentClientErrorCode;
    status?: number;
  } = {
    code: error.code,
    message: error.message,
    stage: "preview",
  };

  if (error.clientCode !== undefined) {
    output.clientCode = error.clientCode;
  }
  if (error.status !== undefined) {
    output.status = error.status;
  }

  return output;
}

function flowError(
  stage: ApplyFlowErrorStage,
  code: ApplyFlowErrorCode,
  error: unknown,
  fallbackMessage: string,
): ApplyFlowError {
  const output: {
    stage: ApplyFlowErrorStage;
    code: ApplyFlowErrorCode;
    message: string;
    clientCode?: AgentClientErrorCode;
    status?: number;
  } = {
    code,
    message: errorMessage(error, fallbackMessage),
    stage,
  };

  const clientError = clientErrorDetails(error);

  if (clientError !== undefined) {
    output.clientCode = clientError.code;

    if (clientError.status !== undefined) {
      output.status = clientError.status;
    }
  }

  return output;
}

function clientErrorDetails(
  error: unknown,
): { readonly code: AgentClientErrorCode; readonly status?: number } | undefined {
  if (!isSafeAgentClientError(error)) return undefined;

  const code = dataProperty(error, "code");

  if (!isAgentClientErrorCode(code)) return undefined;

  const status = dataProperty(error, "status");

  if (status === undefined) {
    return { code };
  }
  if (typeof status === "number") {
    return { code, status };
  }

  return { code };
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

  if (fallback !== "") {
    return fallback;
  }

  return ERROR_MESSAGE_FALLBACK;
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

function expectFields(
  value: Readonly<Record<string, unknown>>,
  allowed: readonly string[],
  path = "",
): ValidationResult<true> {
  const keys = Object.keys(value);

  for (let index = 0; index < keys.length; index += 1) {
    const key = keys[index];

    if (key === undefined || !contains(allowed, key)) {
      return reject(`${prefix(path)}${key ?? "field"} is not an expected field.`);
    }
  }

  for (let index = 0; index < allowed.length; index += 1) {
    const key = allowed[index];

    if (key === undefined || !Object.hasOwn(value, key)) {
      return reject(`${prefix(path)}${key ?? "field"} is required.`);
    }
  }

  return accept(true);
}

function isCanonicalJsonObject(value: unknown): value is CanonicalJsonObject {
  if (!isRecord(value)) return false;

  return isCanonicalJsonValue(value);
}

function isCanonicalJsonValue(value: unknown): value is CanonicalJsonValue {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  ) {
    return true;
  }

  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      if (!isCanonicalJsonValue(value[index])) return false;
    }

    return true;
  }

  if (!isRecord(value)) return false;

  const keys = Object.keys(value);

  for (let index = 0; index < keys.length; index += 1) {
    const key = keys[index];

    if (key === undefined || !isCanonicalJsonValue(value[key])) {
      return false;
    }
  }

  return true;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function field(value: Readonly<Record<string, unknown>>, key: string): unknown {
  if (!Object.hasOwn(value, key)) return undefined;

  return value[key];
}

function contains(values: readonly string[], value: string): boolean {
  for (let index = 0; index < values.length; index += 1) {
    if (values[index] === value) return true;
  }

  return false;
}

function isAgentClientErrorCode(value: unknown): value is AgentClientErrorCode {
  return (
    value === "AGENT_ERROR" ||
    value === "INVALID_PLAN" ||
    value === "MALFORMED_RESPONSE" ||
    value === "TRANSPORT_ERROR"
  );
}

function prefix(path: string): string {
  return path === "" ? "" : `${path}.`;
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
