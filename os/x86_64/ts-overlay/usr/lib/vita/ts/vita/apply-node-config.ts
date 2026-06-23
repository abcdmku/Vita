// Vendored from controller/apply-node/src/apply-node-config.ts
import { evaluateNodeConfig } from "./evaluate.ts";
import { safeNormalize } from "./safe-normalize.ts";
import type {
  CapabilityManifestRegistry,
  EvaluationRejection,
  TransactionPlan,
} from "./evaluate.ts";
import type {
  PlainJson,
  PlainJsonObject,
} from "./safe-normalize.ts";

export type ApplyNodeTransport = (
  method: "POST",
  path: "/apply",
  body: TransactionPlan,
) => Promise<ApplyNodeTransportResponse>;

export interface ApplyNodeTransportResponse {
  readonly status: number;
  readonly body: unknown;
}

export type ApplyNodeApplyOutcome = "committed" | "rolledBack" | "rejected";

export interface ApplyNodeOperationResult {
  readonly index: number;
  readonly capability: string;
}

export interface ApplyNodeResultError {
  readonly code: string;
  readonly message: string;
  readonly index?: number;
  readonly capability?: string;
}

export interface ApplyNodeApplyResult {
  readonly outcome: ApplyNodeApplyOutcome;
  readonly applied: readonly ApplyNodeOperationResult[];
  readonly rolledBack: readonly ApplyNodeOperationResult[];
  readonly rollbackErrors: readonly ApplyNodeResultError[];
  readonly error?: ApplyNodeResultError;
  readonly auditUnrecorded?: boolean;
}

export type ApplyNodeConfigResult =
  | {
      readonly ok: true;
      readonly plan: TransactionPlan;
      readonly applyResult: ApplyNodeApplyResult;
    }
  | {
      readonly ok: false;
      readonly stage: "evaluate";
      readonly rejections: readonly EvaluationRejection[];
    }
  | {
      readonly ok: false;
      readonly stage: "apply";
      readonly status?: number;
      readonly reason: string;
      readonly applyResult?: ApplyNodeApplyResult;
    }
  | {
      readonly ok: false;
      readonly stage: "transport";
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

const APPLY_RESULT_REQUIRED_FIELDS = Object.freeze([
  "outcome",
  "applied",
  "rolledBack",
  "rollbackErrors",
]);
const APPLY_RESULT_OPTIONAL_FIELDS = Object.freeze(["error", "auditUnrecorded"]);
const OPERATION_RESULT_FIELDS = Object.freeze(["index", "capability"]);
const RESULT_ERROR_REQUIRED_FIELDS = Object.freeze(["code", "message"]);
const RESULT_ERROR_OPTIONAL_FIELDS = Object.freeze(["index", "capability"]);
const TRANSPORT_RESPONSE_FIELDS = Object.freeze(["status", "body"]);
const APPLY_OUTCOMES = ["committed", "rolledBack", "rejected"] as const;

export async function applyNodeConfig(
  config: unknown,
  registry: CapabilityManifestRegistry,
  transport: ApplyNodeTransport,
): Promise<ApplyNodeConfigResult> {
  const evaluation = safeEvaluate(config, registry);

  if (!evaluation.ok) {
    return {
      ok: false,
      rejections: evaluation.rejections,
      stage: "evaluate",
    };
  }

  const plan = evaluation.plan;
  let rawResponse: unknown;

  try {
    rawResponse = await transport("POST", "/apply", plan);
  } catch {
    return {
      ok: false,
      stage: "transport",
    };
  }

  const response = readTransportResponse(rawResponse);

  if (!response.ok) {
    return applyFailure(undefined, response.reason);
  }

  if (!isSuccessStatus(response.value.status)) {
    return applyFailure(
      response.value.status,
      `Apply request returned non-2xx status ${response.value.status}.`,
    );
  }

  const applyResult = readApplyResult(response.value.body);

  if (!applyResult.ok) {
    return applyFailure(response.value.status, applyResult.reason);
  }

  if (applyResult.value.outcome !== "committed") {
    return applyFailure(
      response.value.status,
      `Apply outcome was ${applyResult.value.outcome}.`,
      applyResult.value,
    );
  }

  return {
    applyResult: applyResult.value,
    ok: true,
    plan,
  };
}

function safeEvaluate(
  config: unknown,
  registry: CapabilityManifestRegistry,
): ReturnType<typeof evaluateNodeConfig> {
  try {
    return evaluateNodeConfig(config, registry);
  } catch {
    return {
      ok: false,
      rejections: Object.freeze([
        {
          code: "INVALID_CONFIG",
          message: "Config evaluation failed closed.",
          path: "",
        },
      ]),
    };
  }
}

function readTransportResponse(value: unknown): ValidationResult<ApplyNodeTransportResponse> {
  const normalized = safeNormalize(value);

  if (!normalized.ok) {
    return reject(`Transport response is malformed: ${normalized.reason}`);
  }

  if (!isRecord(normalized.value)) {
    return reject("Transport response must be an object.");
  }

  const fields = expectFields(normalized.value, TRANSPORT_RESPONSE_FIELDS);

  if (!fields.ok) return fields;

  const status = field(normalized.value, "status");
  const body = field(normalized.value, "body");

  if (!isHttpStatus(status)) {
    return reject("Transport response status must be an HTTP status code.");
  }
  if (body === undefined) {
    return reject("Transport response body is required.");
  }

  return accept({
    body,
    status,
  });
}

function readApplyResult(value: unknown): ValidationResult<ApplyNodeApplyResult> {
  const normalized = safeNormalize(value);

  if (!normalized.ok) {
    return reject(`Apply result body is malformed: ${normalized.reason}`);
  }

  if (!isRecord(normalized.value)) {
    return reject("Apply result body must be an object.");
  }

  const fields = expectFields(
    normalized.value,
    APPLY_RESULT_REQUIRED_FIELDS,
    APPLY_RESULT_OPTIONAL_FIELDS,
  );

  if (!fields.ok) return fields;

  const outcome = field(normalized.value, "outcome");
  const applied = validateArray(
    field(normalized.value, "applied"),
    "applied",
    validateOperationResult,
  );
  const rolledBack = validateArray(
    field(normalized.value, "rolledBack"),
    "rolledBack",
    validateOperationResult,
  );
  const rollbackErrors = validateArray(
    field(normalized.value, "rollbackErrors"),
    "rollbackErrors",
    validateResultError,
  );
  const errorValue = optionalField(normalized.value, "error");
  const auditUnrecorded = optionalField(normalized.value, "auditUnrecorded");

  if (!isApplyOutcome(outcome)) {
    return reject("outcome must be committed, rolledBack, or rejected.");
  }
  if (!applied.ok) return applied;
  if (!rolledBack.ok) return rolledBack;
  if (!rollbackErrors.ok) return rollbackErrors;

  const output: {
    outcome: ApplyNodeApplyOutcome;
    applied: readonly ApplyNodeOperationResult[];
    rolledBack: readonly ApplyNodeOperationResult[];
    rollbackErrors: readonly ApplyNodeResultError[];
    error?: ApplyNodeResultError;
    auditUnrecorded?: boolean;
  } = {
    applied: applied.value,
    outcome,
    rollbackErrors: rollbackErrors.value,
    rolledBack: rolledBack.value,
  };

  if (errorValue !== undefined) {
    const error = validateResultError(errorValue, "error");

    if (!error.ok) return error;

    output.error = error.value;
  }

  if (auditUnrecorded !== undefined) {
    if (typeof auditUnrecorded !== "boolean") {
      return reject("auditUnrecorded must be a boolean.");
    }

    output.auditUnrecorded = auditUnrecorded;
  }

  return accept(Object.freeze(output));
}

function validateOperationResult(
  value: PlainJson | undefined,
  path: string,
): ValidationResult<ApplyNodeOperationResult> {
  if (!isRecord(value)) return reject(`${path} must be an object.`);

  const fields = expectFields(value, OPERATION_RESULT_FIELDS);
  if (!fields.ok) return fields;

  const index = field(value, "index");
  const capability = field(value, "capability");

  if (!isNonNegativeSafeInteger(index)) {
    return reject(`${path}.index must be a non-negative integer.`);
  }
  if (typeof capability !== "string" || capability === "") {
    return reject(`${path}.capability must be a non-empty string.`);
  }

  return accept({
    capability,
    index,
  });
}

function validateResultError(
  value: PlainJson | undefined,
  path: string,
): ValidationResult<ApplyNodeResultError> {
  if (!isRecord(value)) return reject(`${path} must be an object.`);

  const fields = expectFields(value, RESULT_ERROR_REQUIRED_FIELDS, RESULT_ERROR_OPTIONAL_FIELDS, path);
  if (!fields.ok) return fields;

  const code = field(value, "code");
  const message = field(value, "message");
  const index = optionalField(value, "index");
  const capability = optionalField(value, "capability");
  const output: {
    code: string;
    message: string;
    index?: number;
    capability?: string;
  } = {
    code: "",
    message: "",
  };

  if (typeof code !== "string" || code === "") {
    return reject(`${path}.code must be a non-empty string.`);
  }
  output.code = code;

  if (typeof message !== "string") {
    return reject(`${path}.message must be a string.`);
  }
  output.message = message;

  if (index !== undefined) {
    if (!isNonNegativeSafeInteger(index)) {
      return reject(`${path}.index must be a non-negative integer.`);
    }

    output.index = index;
  }

  if (capability !== undefined) {
    if (typeof capability !== "string") {
      return reject(`${path}.capability must be a string.`);
    }

    output.capability = capability;
  }

  return accept(Object.freeze(output));
}

function validateArray<T>(
  value: PlainJson | undefined,
  path: string,
  validate: (item: PlainJson | undefined, itemPath: string) => ValidationResult<T>,
): ValidationResult<readonly T[]> {
  if (!Array.isArray(value)) return reject(`${path} must be an array.`);

  const output: T[] = [];

  for (let index = 0; index < value.length; index += 1) {
    const item = value[index];

    if (item === undefined) {
      return reject(`${path}[${index}] is missing.`);
    }

    const result = validate(item, `${path}[${index}]`);

    if (!result.ok) return result;

    output[index] = result.value;
  }

  return accept(Object.freeze(output));
}

function expectFields(
  value: PlainJsonObject,
  required: readonly string[],
  optional: readonly string[] = [],
  path = "",
): ValidationResult<true> {
  const keys = Object.keys(value);

  for (let index = 0; index < keys.length; index += 1) {
    const key = keys[index];

    if (key === undefined || (!contains(required, key) && !contains(optional, key))) {
      return reject(`${prefix(path)}${key ?? "field"} is not an expected field.`);
    }
  }

  for (let index = 0; index < required.length; index += 1) {
    const key = required[index];

    if (key === undefined || !Object.hasOwn(value, key)) {
      return reject(`${prefix(path)}${key ?? "field"} is required.`);
    }
  }

  return accept(true);
}

function applyFailure(
  status: number | undefined,
  reason: string,
  applyResult?: ApplyNodeApplyResult,
): Extract<ApplyNodeConfigResult, { readonly ok: false; readonly stage: "apply" }> {
  const output: {
    ok: false;
    stage: "apply";
    reason: string;
    status?: number;
    applyResult?: ApplyNodeApplyResult;
  } = {
    ok: false,
    reason,
    stage: "apply",
  };

  if (status !== undefined) {
    output.status = status;
  }
  if (applyResult !== undefined) {
    output.applyResult = applyResult;
  }

  return output;
}

function field(value: PlainJsonObject, key: string): PlainJson | undefined {
  if (!Object.hasOwn(value, key)) return undefined;

  return value[key];
}

function optionalField(value: PlainJsonObject, key: string): PlainJson | undefined {
  return field(value, key);
}

function isRecord(value: PlainJson | undefined): value is PlainJsonObject {
  return value !== undefined && value !== null && typeof value === "object" && !Array.isArray(value);
}

function isHttpStatus(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 100 && value <= 599;
}

function isSuccessStatus(status: number): boolean {
  return status >= 200 && status <= 299;
}

function isNonNegativeSafeInteger(value: PlainJson | undefined): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isApplyOutcome(value: PlainJson | undefined): value is ApplyNodeApplyOutcome {
  if (typeof value !== "string") return false;

  return contains(APPLY_OUTCOMES, value);
}

function contains<T extends string>(values: readonly T[], value: string): value is T {
  for (let index = 0; index < values.length; index += 1) {
    if (values[index] === value) return true;
  }

  return false;
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
