// Vendored from sdk/typescript/src/controller-shell.ts
import { safeNormalize } from "./safe-normalize.ts";
import type { PlainJson, PlainJsonObject } from "./safe-normalize.ts";

export interface ControllerShellRequest {
  readonly method: string;
  readonly path: string;
  readonly body?: unknown;
}

export interface ControllerShellResponse {
  readonly status: number;
  readonly contentType: "application/json; charset=utf-8" | "text/html; charset=utf-8";
  readonly body: string;
}

export interface ControllerShellAgent {
  getHealth(): Promise<unknown>;
  getOperations(): Promise<unknown>;
  getState(capability: string): Promise<unknown>;
}

export interface ControllerShellPlanOperation {
  readonly capability: string;
  readonly request: PlainJsonObject;
}

export interface ControllerShellTransactionPlan {
  readonly operations: readonly ControllerShellPlanOperation[];
}

export interface ControllerShellEvaluationRejection {
  readonly code: string;
  readonly path: string;
  readonly message: string;
  readonly capability?: string;
}

export type ControllerShellEvaluationResult =
  | {
      readonly ok: true;
      readonly plan: ControllerShellTransactionPlan;
    }
  | {
      readonly ok: false;
      readonly rejections: readonly ControllerShellEvaluationRejection[];
    };

export interface ControllerShellPlanDiff {
  readonly added: readonly string[];
  readonly removed: readonly string[];
  readonly changed: readonly string[];
}

export interface ControllerShellApplyTransportResponse {
  readonly status: number;
  readonly body: unknown;
}

export type ControllerShellApplyCaller = (
  method: "POST",
  path: "/apply",
  body: ControllerShellTransactionPlan,
) => Promise<ControllerShellApplyTransportResponse>;

export interface ControllerShellPorts {
  readonly agent: ControllerShellAgent;
  readonly evaluate: (config: unknown) => ControllerShellEvaluationResult | Promise<ControllerShellEvaluationResult>;
  readonly diff: (
    current: ControllerShellTransactionPlan,
    desired: ControllerShellTransactionPlan,
  ) => ControllerShellPlanDiff;
  readonly apply: ControllerShellApplyCaller;
}

export interface ControllerShellStatus {
  readonly ok: boolean;
  readonly reachable: boolean;
  readonly healthy: boolean;
  readonly hostname: string;
  readonly caps: number;
  readonly operations: readonly string[];
  readonly version: string;
  readonly errors: readonly ControllerShellStatusError[];
}

export interface ControllerShellStatusError {
  readonly source: "health" | "operations" | "hostname";
  readonly message: string;
}

export type ControllerShellPreviewResult =
  | {
      readonly ok: true;
      readonly added: readonly string[];
      readonly removed: readonly string[];
      readonly changed: readonly string[];
      readonly rejections: readonly [];
    }
  | {
      readonly ok: false;
      readonly added: readonly string[];
      readonly removed: readonly string[];
      readonly changed: readonly string[];
      readonly rejections: readonly ControllerShellEvaluationRejection[];
      readonly error: ControllerShellRouteError;
    };

export type ControllerShellApplyOutcome = "committed" | "rolledBack" | "rejected";

export interface ControllerShellApplyOperationResult {
  readonly index: number;
  readonly capability: string;
}

export interface ControllerShellApplyResultError {
  readonly code: string;
  readonly message: string;
  readonly index?: number;
  readonly capability?: string;
}

export interface ControllerShellAgentApplyResult {
  readonly outcome: ControllerShellApplyOutcome;
  readonly applied: readonly ControllerShellApplyOperationResult[];
  readonly rolledBack: readonly ControllerShellApplyOperationResult[];
  readonly rollbackErrors: readonly ControllerShellApplyResultError[];
  readonly error?: ControllerShellApplyResultError;
  readonly auditUnrecorded?: boolean;
}

export type ControllerShellApplyRouteResult =
  | {
      readonly ok: true;
      readonly outcome: "committed";
      readonly status: number;
      readonly plan: ControllerShellTransactionPlan;
      readonly applyResult: ControllerShellAgentApplyResult;
    }
  | {
      readonly ok: false;
      readonly stage: "evaluate";
      readonly rejections: readonly ControllerShellEvaluationRejection[];
      readonly error: ControllerShellRouteError;
    }
  | {
      readonly ok: false;
      readonly stage: "apply";
      readonly outcome: "rejected" | "rolledBack" | "malformed";
      readonly reason: string;
      readonly status?: number;
      readonly applyResult?: ControllerShellAgentApplyResult;
      readonly error?: ControllerShellApplyResultError;
    }
  | {
      readonly ok: false;
      readonly stage: "transport";
      readonly reason: string;
    };

export interface ControllerShellRouteError {
  readonly code: string;
  readonly message: string;
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

type EvaluationReadResult =
  | {
      readonly ok: true;
      readonly plan: ControllerShellTransactionPlan;
    }
  | {
      readonly ok: false;
      readonly rejections: readonly ControllerShellEvaluationRejection[];
    };

interface AgentHealth {
  readonly version: string;
  readonly healthy: boolean;
}

const JSON_CONTENT_TYPE = "application/json; charset=utf-8";
const HTML_CONTENT_TYPE = "text/html; charset=utf-8";
const HOSTNAME_CAPABILITY = "hostname.set";
const NO_REJECTIONS: readonly [] = Object.freeze([]);
const EMPTY_DIFF = Object.freeze({
  added: Object.freeze([]),
  changed: Object.freeze([]),
  removed: Object.freeze([]),
}) satisfies ControllerShellPlanDiff;
const HEALTH_FIELDS = Object.freeze([
  "version",
  "startedAt",
  "uptimeSeconds",
  "capabilities",
  "healthy",
]);
const APPLY_RESPONSE_FIELDS = Object.freeze(["status", "body"]);
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
const ERROR_RESPONSE_FIELDS = Object.freeze(["error"]);
const APPLY_OUTCOMES = ["committed", "rolledBack", "rejected"] as const;
const CURRENT_STATE_METADATA_FIELDS = Object.freeze(["exists", "raw"]);

export async function handleControllerShellRequest(
  ports: ControllerShellPorts,
  request: unknown,
): Promise<ControllerShellResponse> {
  try {
    const normalizedRequest = normalizeRequest(request);

    if (!normalizedRequest.ok) {
      return jsonResponse(400, routeError("MALFORMED_REQUEST", normalizedRequest.reason));
    }

    return routeControllerShellRequest(ports, normalizedRequest.value);
  } catch {
    return jsonResponse(500, routeError("INTERNAL_ERROR", "Controller shell failed closed."));
  }
}

export function formatControllerShellStatusMarker(
  status: ControllerShellStatus,
  preview: ControllerShellPreviewResult,
  apply: ControllerShellApplyRouteResult,
): string {
  if (
    status.ok &&
    status.hostname.length > 0 &&
    status.caps > 0 &&
    preview.ok &&
    apply.ok &&
    apply.outcome === "committed"
  ) {
    return (
      "VITA-UI: " +
      "status=OK " +
      "route=status " +
      `hostname=${markerToken(status.hostname)} ` +
      `caps=${status.caps} ` +
      `preview=added=${preview.added.length},removed=${preview.removed.length},changed=${preview.changed.length} ` +
      "apply=committed " +
      "status=OK"
    );
  }

  return formatControllerShellErrorMarker();
}

export function formatControllerShellRejectMarker(
  apply: ControllerShellApplyRouteResult,
): string {
  if (!apply.ok && apply.stage === "apply" && apply.outcome === "rejected") {
    const reason = apply.error?.code ?? apply.reason;
    return `VITA-UI-REJECT: route=apply reason=${markerToken(reason)} status=OK`;
  }

  return formatControllerShellErrorMarker();
}

export function formatControllerShellErrorMarker(): string {
  return "VITA-UI-ERROR: status=FAILSAFE";
}

export function markerToken(value: string): string {
  const token = value.replace(/[^A-Za-z0-9_.-]+/gu, "_");
  return token.length === 0 ? "unknown" : token;
}

async function routeControllerShellRequest(
  ports: ControllerShellPorts,
  request: ControllerShellRequest,
): Promise<ControllerShellResponse> {
  const method = request.method;
  const path = request.path;

  if (path === "/") {
    if (method !== "GET") return methodNotAllowed();

    const status = await buildStatus(ports.agent);
    return htmlResponse(200, renderStatusHtml(status));
  }

  if (path === "/api/status") {
    if (method !== "GET") return methodNotAllowed();

    return jsonResponse(200, await buildStatus(ports.agent));
  }

  if (path === "/api/preview") {
    if (method !== "POST") return methodNotAllowed();

    return jsonResponse(200, await previewControllerShellPlan(ports, request.body));
  }

  if (path === "/api/apply") {
    if (method !== "POST") return methodNotAllowed();

    return jsonResponse(200, await applyControllerShellPlan(ports, request.body));
  }

  return jsonResponse(404, routeError("NOT_FOUND", "Route is not available."));
}

async function buildStatus(agent: ControllerShellAgent): Promise<ControllerShellStatus> {
  const [health, operations, hostname] = await Promise.all([
    readHealth(agent),
    readOperations(agent),
    readHostname(agent),
  ]);
  const errors: ControllerShellStatusError[] = [];

  if (!health.ok) {
    errors.push({
      message: health.reason,
      source: "health",
    });
  }
  if (!operations.ok) {
    errors.push({
      message: operations.reason,
      source: "operations",
    });
  }
  if (!hostname.ok) {
    errors.push({
      message: hostname.reason,
      source: "hostname",
    });
  }

  return Object.freeze({
    caps: operations.ok ? operations.value.length : 0,
    errors: Object.freeze(errors),
    healthy: health.ok ? health.value.healthy : false,
    hostname: hostname.ok ? hostname.value : "",
    ok: errors.length === 0,
    operations: operations.ok ? operations.value : Object.freeze([]),
    reachable: health.ok,
    version: health.ok ? health.value.version : "",
  });
}

async function previewControllerShellPlan(
  ports: ControllerShellPorts,
  body: unknown,
): Promise<ControllerShellPreviewResult> {
  const config = normalizeBodyConfig(body);

  if (!config.ok) {
    return previewFailure("MALFORMED_BODY", config.reason, []);
  }

  const desired = await safeEvaluate(ports.evaluate, config.value);

  if (!desired.ok) {
    return {
      ...EMPTY_DIFF,
      error: {
        code: "EVALUATION_REJECTED",
        message: "Proposed config was rejected by evaluation.",
      },
      ok: false,
      rejections: desired.rejections,
    };
  }

  const current = await readCurrentPlan(ports);

  if (!current.ok) {
    return previewFailure("CURRENT_STATE_UNAVAILABLE", current.reason, []);
  }

  try {
    const change = ports.diff(current.value, desired.plan);
    const normalizedChange = normalizePlanDiff(change);

    if (!normalizedChange.ok) {
      return previewFailure("MALFORMED_DIFF", normalizedChange.reason, []);
    }

    return {
      added: normalizedChange.value.added,
      changed: normalizedChange.value.changed,
      ok: true,
      rejections: NO_REJECTIONS,
      removed: normalizedChange.value.removed,
    };
  } catch {
    return previewFailure("PREVIEW_FAILED", "Plan preview diff failed closed.", []);
  }
}

async function applyControllerShellPlan(
  ports: ControllerShellPorts,
  body: unknown,
): Promise<ControllerShellApplyRouteResult> {
  const config = normalizeBodyConfig(body);

  if (!config.ok) {
    return {
      error: {
        code: "MALFORMED_BODY",
        message: config.reason,
      },
      ok: false,
      rejections: malformedRejections(config.reason),
      stage: "evaluate",
    };
  }

  const evaluated = await safeEvaluate(ports.evaluate, config.value);

  if (!evaluated.ok) {
    return {
      error: {
        code: "EVALUATION_REJECTED",
        message: "Proposed config was rejected by evaluation.",
      },
      ok: false,
      rejections: evaluated.rejections,
      stage: "evaluate",
    };
  }

  let rawResponse: unknown;

  try {
    rawResponse = await ports.apply("POST", "/apply", evaluated.plan);
  } catch {
    return {
      ok: false,
      reason: "Apply transport failed.",
      stage: "transport",
    };
  }

  const response = readApplyTransportResponse(rawResponse);

  if (!response.ok) {
    return {
      ok: false,
      outcome: "malformed",
      reason: response.reason,
      stage: "apply",
    };
  }

  const applyResult = readApplyResult(response.value.body);

  if (!isSuccessStatus(response.value.status)) {
    if (applyResult.ok) {
      return rejectedApplyFailure(response.value.status, applyResult.value, "Apply request was rejected.");
    }

    const agentError = readAgentError(response.value.body);
    if (agentError.ok) {
      return {
        error: agentError.value,
        ok: false,
        outcome: "rejected",
        reason: agentError.value.code,
        stage: "apply",
        status: response.value.status,
      };
    }

    return {
      ok: false,
      outcome: "malformed",
      reason: `Apply request returned non-2xx status ${response.value.status}.`,
      stage: "apply",
      status: response.value.status,
    };
  }

  if (!applyResult.ok) {
    return {
      ok: false,
      outcome: "malformed",
      reason: applyResult.reason,
      stage: "apply",
      status: response.value.status,
    };
  }

  if (applyResult.value.outcome !== "committed") {
    return rejectedApplyFailure(
      response.value.status,
      applyResult.value,
      `Apply outcome was ${applyResult.value.outcome}.`,
    );
  }

  return {
    applyResult: applyResult.value,
    ok: true,
    outcome: "committed",
    plan: evaluated.plan,
    status: response.value.status,
  };
}

async function readCurrentPlan(
  ports: ControllerShellPorts,
): Promise<ValidationResult<ControllerShellTransactionPlan>> {
  const agent = ports.agent;
  const currentCapabilities = await readOperations(agent);

  if (!currentCapabilities.ok) {
    return reject(currentCapabilities.reason);
  }

  const operations: ControllerShellPlanOperation[] = [];

  for (let index = 0; index < currentCapabilities.value.length; index += 1) {
    const capability = currentCapabilities.value[index];

    if (capability === undefined) {
      return reject(`current capability ${index} is missing.`);
    }

    const state = await readCapabilityState(agent, capability);

    if (!state.ok) {
      return reject(state.reason);
    }

    const request = await projectCurrentStateToRequest(
      ports.evaluate,
      state.value,
      capability,
    );

    if (!request.ok) {
      return request;
    }
    if (request.value === null) {
      continue;
    }

    operations.push(Object.freeze({
      capability,
      request: request.value,
    }));
  }

  return accept(Object.freeze({
    operations: Object.freeze(operations),
  }));
}

async function readHealth(agent: ControllerShellAgent): Promise<ValidationResult<AgentHealth>> {
  try {
    const normalized = normalizeJsonLike(await agent.getHealth());

    if (!normalized.ok) return reject(normalized.reason);
    if (!isPlainObject(normalized.value)) return reject("health must be an object.");

    const fields = expectFields(normalized.value, HEALTH_FIELDS);
    if (!fields.ok) return fields;

    const version = field(normalized.value, "version");
    const healthy = field(normalized.value, "healthy");
    const uptimeSeconds = field(normalized.value, "uptimeSeconds");
    const capabilities = validateStringArray(field(normalized.value, "capabilities"), "capabilities");

    if (typeof version !== "string" || version.length === 0) {
      return reject("health.version must be a non-empty string.");
    }
    if (typeof healthy !== "boolean") {
      return reject("health.healthy must be a boolean.");
    }
    if (!isNonNegativeSafeInteger(uptimeSeconds)) {
      return reject("health.uptimeSeconds must be a non-negative integer.");
    }
    if (!capabilities.ok) {
      return capabilities;
    }

    return accept({
      healthy,
      version,
    });
  } catch {
    return reject("health request failed.");
  }
}

async function readOperations(agent: ControllerShellAgent): Promise<ValidationResult<readonly string[]>> {
  try {
    const normalized = normalizeJsonLike(await agent.getOperations());

    if (!normalized.ok) return reject(normalized.reason);

    if (Array.isArray(normalized.value)) {
      return validateStringArray(normalized.value, "operations");
    }

    if (!isPlainObject(normalized.value)) {
      return reject("operations must be an array or object.");
    }

    const fields = expectFields(normalized.value, ["operations"]);
    if (!fields.ok) return fields;

    return validateStringArray(field(normalized.value, "operations"), "operations");
  } catch {
    return reject("operations request failed.");
  }
}

async function readHostname(agent: ControllerShellAgent): Promise<ValidationResult<string>> {
  const state = await readCapabilityState(agent, HOSTNAME_CAPABILITY);

  if (!state.ok) return state;

  const current = field(state.value, "current");

  if (typeof current !== "string" || current.length === 0) {
    return reject("hostname state is missing current hostname.");
  }

  return accept(current);
}

async function readCapabilityState(
  agent: ControllerShellAgent,
  capability: string,
): Promise<ValidationResult<PlainJsonObject>> {
  try {
    const normalized = normalizeJsonLike(await agent.getState(capability));

    if (!normalized.ok) return reject(normalized.reason);
    if (!isPlainObject(normalized.value)) {
      return reject(`state for ${capability} must be an object.`);
    }

    return accept(normalized.value);
  } catch {
    return reject(`state for ${capability} could not be read.`);
  }
}

async function projectCurrentStateToRequest(
  evaluate: ControllerShellPorts["evaluate"],
  state: PlainJsonObject,
  capability: string,
): Promise<ValidationResult<PlainJsonObject | null>> {
  const candidates = projectCurrentStateRequestCandidates(state, capability);

  if (!candidates.ok) {
    return reject(candidates.reason);
  }
  if (candidates.value === null) {
    return accept(null);
  }

  for (let index = 0; index < candidates.value.length; index += 1) {
    const candidate = candidates.value[index];

    if (candidate === undefined) {
      continue;
    }

    const evaluated = await safeEvaluate(
      evaluate,
      singleCapabilityConfig(capability, candidate),
    );

    if (!evaluated.ok) {
      continue;
    }

    const operation = readSingleCapabilityOperation(evaluated.plan, capability);

    if (operation.ok) {
      return accept(operation.value.request);
    }
  }

  const fallback = candidates.value[0];

  return fallback === undefined
    ? reject(`state for ${capability} is missing current desired payload.`)
    : accept(fallback);
}

function projectCurrentStateRequestCandidates(
  state: PlainJsonObject,
  capability: string,
): ValidationResult<readonly PlainJsonObject[] | null> {
  const current = field(state, "current");

  if (current !== undefined) {
    return accept(Object.freeze([desiredRequest(current)]));
  }

  const exists = field(state, "exists");

  if (exists === undefined) {
    const direct = currentStatePayloadCandidates(state);

    return direct.length === 0
      ? accept(null)
      : accept(Object.freeze(direct.map(desiredRequest)));
  }
  if (typeof exists !== "boolean") {
    return reject(`state for ${capability} has malformed exists.`);
  }
  if (!exists) {
    return accept(null);
  }

  const payloads = currentStatePayloadCandidates(state);

  if (payloads.length === 0) {
    return reject(`state for ${capability} is missing current desired payload.`);
  }

  return accept(Object.freeze(payloads.map(desiredRequest)));
}

function currentStatePayloadCandidates(state: PlainJsonObject): PlainJson[] {
  const payloads: PlainJson[] = [];
  const desired = field(state, "desired");

  if (desired !== undefined) {
    payloads[payloads.length] = desired;
  }

  const payloadKeys = currentStatePayloadKeys(state);

  if (payloadKeys.length === 1) {
    const key = payloadKeys[0];

    if (key !== undefined && key !== "desired") {
      const single = field(state, key);

      if (single !== undefined) {
        payloads[payloads.length] = single;
      }
    }
  }

  if (payloadKeys.length > 0) {
    payloads[payloads.length] = copyCurrentStatePayload(state, payloadKeys);
  }

  return payloads;
}

function currentStatePayloadKeys(state: PlainJsonObject): readonly string[] {
  const keys = Object.keys(state).sort(compareStrings);
  const payloadKeys: string[] = [];

  for (let index = 0; index < keys.length; index += 1) {
    const key = keys[index];

    if (key === undefined) {
      continue;
    }
    if (contains(CURRENT_STATE_METADATA_FIELDS, key)) {
      continue;
    }

    payloadKeys[payloadKeys.length] = key;
  }

  return Object.freeze(payloadKeys);
}

function copyCurrentStatePayload(
  state: PlainJsonObject,
  keys: readonly string[],
): PlainJsonObject {
  const payload: Record<string, PlainJson> = Object.create(null) as Record<string, PlainJson>;

  for (let index = 0; index < keys.length; index += 1) {
    const key = keys[index];

    if (key === undefined) {
      continue;
    }

    const value = field(state, key);

    if (value !== undefined) {
      Object.defineProperty(payload, key, {
        configurable: true,
        enumerable: true,
        value,
        writable: false,
      });
    }
  }

  return Object.freeze(payload);
}

function desiredRequest(desired: PlainJson): PlainJsonObject {
  const request: Record<string, PlainJson> = Object.create(null) as Record<string, PlainJson>;
  Object.defineProperty(request, "desired", {
    configurable: true,
    enumerable: true,
    value: desired,
    writable: false,
  });

  return Object.freeze(request);
}

function singleCapabilityConfig(
  capability: string,
  request: PlainJsonObject,
): PlainJsonObject {
  const config: Record<string, PlainJson> = Object.create(null) as Record<string, PlainJson>;

  Object.defineProperty(config, capability, {
    configurable: true,
    enumerable: true,
    value: request,
    writable: false,
  });

  return Object.freeze(config);
}

function readSingleCapabilityOperation(
  plan: ControllerShellTransactionPlan,
  capability: string,
): ValidationResult<ControllerShellPlanOperation> {
  if (plan.operations.length !== 1) {
    return reject(`current plan for ${capability} must contain exactly one operation.`);
  }

  const operation = plan.operations[0];

  if (operation === undefined || operation.capability !== capability) {
    return reject(`current plan for ${capability} returned a mismatched operation.`);
  }

  return accept(operation);
}

async function safeEvaluate(
  evaluate: ControllerShellPorts["evaluate"],
  config: PlainJsonObject,
): Promise<EvaluationReadResult> {
  let rawResult: unknown;

  try {
    rawResult = await evaluate(config);
  } catch {
    return {
      ok: false,
      rejections: malformedRejections("Config evaluation failed closed."),
    };
  }

  return normalizeEvaluationResult(rawResult);
}

function normalizeEvaluationResult(value: unknown): EvaluationReadResult {
  const normalized = safeNormalize(value);

  if (!normalized.ok) {
    return {
      ok: false,
      rejections: malformedRejections(`Evaluator result is malformed: ${normalized.reason}`),
    };
  }

  if (!isPlainObject(normalized.value)) {
    return {
      ok: false,
      rejections: malformedRejections("Evaluator result must be an object."),
    };
  }

  const ok = field(normalized.value, "ok");

  if (ok === true) {
    const fields = expectFields(normalized.value, ["ok", "plan"]);
    if (!fields.ok) {
      return {
        ok: false,
        rejections: malformedRejections(fields.reason),
      };
    }

    const plan = normalizePlan(field(normalized.value, "plan"));
    if (!plan.ok) {
      return {
        ok: false,
        rejections: malformedRejections(plan.reason),
      };
    }

    return {
      ok: true,
      plan: plan.value,
    };
  }

  if (ok === false) {
    const fields = expectFields(normalized.value, ["ok", "rejections"]);
    if (!fields.ok) {
      return {
        ok: false,
        rejections: malformedRejections(fields.reason),
      };
    }

    const rejections = validateEvaluationRejections(field(normalized.value, "rejections"));

    return {
      ok: false,
      rejections: rejections.ok ? rejections.value : malformedRejections(rejections.reason),
    };
  }

  return {
    ok: false,
    rejections: malformedRejections("Evaluator result ok must be boolean."),
  };
}

function normalizePlan(value: PlainJson | undefined): ValidationResult<ControllerShellTransactionPlan> {
  if (!isPlainObject(value)) return reject("plan must be an object.");

  const fields = expectFields(value, ["operations"]);
  if (!fields.ok) return fields;

  const operationsValue = field(value, "operations");
  if (!Array.isArray(operationsValue)) return reject("plan.operations must be an array.");

  const operations: ControllerShellPlanOperation[] = [];

  for (let index = 0; index < operationsValue.length; index += 1) {
    const operation = operationsValue[index];

    if (!isPlainObject(operation)) {
      return reject(`plan.operations[${index}] must be an object.`);
    }

    const operationFields = expectFields(operation, ["capability", "request"]);
    if (!operationFields.ok) return operationFields;

    const capability = field(operation, "capability");
    const request = field(operation, "request");

    if (typeof capability !== "string" || capability.length === 0) {
      return reject(`plan.operations[${index}].capability must be a non-empty string.`);
    }
    if (!isPlainObject(request)) {
      return reject(`plan.operations[${index}].request must be an object.`);
    }

    operations.push(Object.freeze({
      capability,
      request,
    }));
  }

  return accept(Object.freeze({
    operations: Object.freeze(operations),
  }));
}

function validateEvaluationRejections(
  value: PlainJson | undefined,
): ValidationResult<readonly ControllerShellEvaluationRejection[]> {
  if (!Array.isArray(value)) return reject("rejections must be an array.");

  const rejections: ControllerShellEvaluationRejection[] = [];

  for (let index = 0; index < value.length; index += 1) {
    const rejection = value[index];

    if (!isPlainObject(rejection)) {
      return reject(`rejections[${index}] must be an object.`);
    }

    const fields = expectFields(rejection, ["code", "path", "message"], ["capability"]);
    if (!fields.ok) return fields;

    const code = field(rejection, "code");
    const path = field(rejection, "path");
    const message = field(rejection, "message");
    const capability = field(rejection, "capability");
    const output: {
      code: string;
      path: string;
      message: string;
      capability?: string;
    } = {
      code: "",
      message: "",
      path: "",
    };

    if (typeof code !== "string" || code.length === 0) {
      return reject(`rejections[${index}].code must be a non-empty string.`);
    }
    output.code = code;

    if (typeof path !== "string") {
      return reject(`rejections[${index}].path must be a string.`);
    }
    output.path = path;

    if (typeof message !== "string") {
      return reject(`rejections[${index}].message must be a string.`);
    }
    output.message = message;

    if (capability !== undefined) {
      if (typeof capability !== "string") {
        return reject(`rejections[${index}].capability must be a string.`);
      }
      output.capability = capability;
    }

    rejections.push(Object.freeze(output));
  }

  return accept(Object.freeze(rejections));
}

function normalizePlanDiff(value: unknown): ValidationResult<ControllerShellPlanDiff> {
  const normalized = safeNormalize(value);

  if (!normalized.ok) return reject(normalized.reason);
  if (!isPlainObject(normalized.value)) return reject("diff must be an object.");

  const fields = expectFields(normalized.value, ["added", "removed", "changed"]);
  if (!fields.ok) return fields;

  const added = validateStringArray(field(normalized.value, "added"), "added");
  if (!added.ok) return added;

  const removed = validateStringArray(field(normalized.value, "removed"), "removed");
  if (!removed.ok) return removed;

  const changed = validateStringArray(field(normalized.value, "changed"), "changed");
  if (!changed.ok) return changed;

  return accept(Object.freeze({
    added: added.value,
    changed: changed.value,
    removed: removed.value,
  }));
}

function readApplyTransportResponse(
  value: unknown,
): ValidationResult<ControllerShellApplyTransportResponse> {
  const normalized = safeNormalize(value);

  if (!normalized.ok) return reject(`Apply response is malformed: ${normalized.reason}`);
  if (!isPlainObject(normalized.value)) return reject("Apply response must be an object.");

  const fields = expectFields(normalized.value, APPLY_RESPONSE_FIELDS);
  if (!fields.ok) return fields;

  const status = field(normalized.value, "status");
  const body = field(normalized.value, "body");

  if (!isHttpStatus(status)) {
    return reject("Apply response status must be an HTTP status code.");
  }
  if (body === undefined) {
    return reject("Apply response body is required.");
  }

  return accept({
    body,
    status,
  });
}

function readApplyResult(value: unknown): ValidationResult<ControllerShellAgentApplyResult> {
  const normalized = normalizeJsonLike(value);

  if (!normalized.ok) return reject(`Apply result body is malformed: ${normalized.reason}`);
  if (!isPlainObject(normalized.value)) return reject("Apply result body must be an object.");

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
  const errorValue = field(normalized.value, "error");
  const auditUnrecorded = field(normalized.value, "auditUnrecorded");

  if (!isApplyOutcome(outcome)) {
    return reject("outcome must be committed, rolledBack, or rejected.");
  }
  if (!applied.ok) return applied;
  if (!rolledBack.ok) return rolledBack;
  if (!rollbackErrors.ok) return rollbackErrors;

  const output: {
    outcome: ControllerShellApplyOutcome;
    applied: readonly ControllerShellApplyOperationResult[];
    rolledBack: readonly ControllerShellApplyOperationResult[];
    rollbackErrors: readonly ControllerShellApplyResultError[];
    error?: ControllerShellApplyResultError;
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

function readAgentError(value: unknown): ValidationResult<ControllerShellApplyResultError> {
  const normalized = normalizeJsonLike(value);

  if (!normalized.ok) return reject(normalized.reason);
  if (!isPlainObject(normalized.value)) return reject("agent error body must be an object.");

  const fields = expectFields(normalized.value, ERROR_RESPONSE_FIELDS);
  if (!fields.ok) return fields;

  return validateResultError(field(normalized.value, "error"), "error");
}

function validateOperationResult(
  value: PlainJson | undefined,
  path: string,
): ValidationResult<ControllerShellApplyOperationResult> {
  if (!isPlainObject(value)) return reject(`${path} must be an object.`);

  const fields = expectFields(value, OPERATION_RESULT_FIELDS);
  if (!fields.ok) return fields;

  const index = field(value, "index");
  const capability = field(value, "capability");

  if (!isNonNegativeSafeInteger(index)) {
    return reject(`${path}.index must be a non-negative integer.`);
  }
  if (typeof capability !== "string" || capability.length === 0) {
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
): ValidationResult<ControllerShellApplyResultError> {
  if (!isPlainObject(value)) return reject(`${path} must be an object.`);

  const fields = expectFields(value, RESULT_ERROR_REQUIRED_FIELDS, RESULT_ERROR_OPTIONAL_FIELDS, path);
  if (!fields.ok) return fields;

  const code = field(value, "code");
  const message = field(value, "message");
  const index = field(value, "index");
  const capability = field(value, "capability");
  const output: {
    code: string;
    message: string;
    index?: number;
    capability?: string;
  } = {
    code: "",
    message: "",
  };

  if (typeof code !== "string" || code.length === 0) {
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

function rejectedApplyFailure(
  status: number,
  applyResult: ControllerShellAgentApplyResult,
  reason: string,
): Extract<ControllerShellApplyRouteResult, { readonly ok: false; readonly stage: "apply" }> {
  const output: {
    ok: false;
    stage: "apply";
    outcome: "rejected" | "rolledBack";
    reason: string;
    status: number;
    applyResult: ControllerShellAgentApplyResult;
    error?: ControllerShellApplyResultError;
  } = {
    applyResult,
    ok: false,
    outcome: applyResult.outcome === "rolledBack" ? "rolledBack" : "rejected",
    reason,
    stage: "apply",
    status,
  };

  if (applyResult.error !== undefined) {
    output.error = applyResult.error;
  }

  return output;
}

function normalizeRequest(value: unknown): ValidationResult<ControllerShellRequest> {
  const normalized = safeNormalize(value);

  if (!normalized.ok) return reject(normalized.reason);
  if (!isPlainObject(normalized.value)) return reject("request must be an object.");

  const fields = expectFields(normalized.value, ["method", "path"], ["body"]);
  if (!fields.ok) return fields;

  const method = field(normalized.value, "method");
  const path = field(normalized.value, "path");

  if (typeof method !== "string" || method.length === 0) {
    return reject("request.method must be a non-empty string.");
  }
  if (typeof path !== "string" || path.length === 0) {
    return reject("request.path must be a non-empty string.");
  }
  if (!isKnownMethod(method)) {
    return reject("request.method is not supported.");
  }

  const body = field(normalized.value, "body");
  const output: {
    method: string;
    path: string;
    body?: unknown;
  } = {
    method,
    path,
  };

  if (body !== undefined) {
    output.body = body;
  }

  return accept(Object.freeze(output));
}

function normalizeBodyConfig(value: unknown): ValidationResult<PlainJsonObject> {
  if (value === undefined) {
    return reject("request body is required.");
  }

  const normalized = normalizeJsonLike(value);

  if (!normalized.ok) return reject(normalized.reason);
  if (!isPlainObject(normalized.value)) return reject("request body must be an object.");

  return accept(normalized.value);
}

function normalizeJsonLike(value: unknown): ValidationResult<PlainJson> {
  if (typeof value === "string") {
    const duplicateCheck = rejectDuplicateJsonObjectKeys(value);

    if (!duplicateCheck.ok) return duplicateCheck;

    try {
      return normalizeParsedJson(JSON.parse(value));
    } catch {
      return reject("body must be valid JSON.");
    }
  }

  return normalizeParsedJson(value);
}

function normalizeParsedJson(value: unknown): ValidationResult<PlainJson> {
  const normalized = safeNormalize(value);

  if (!normalized.ok) return reject(normalized.reason);

  return accept(normalized.value);
}

function rejectDuplicateJsonObjectKeys(text: string): ValidationResult<true> {
  try {
    const scanner: JsonDuplicateScanner = {
      index: 0,
      text,
    };

    skipJsonWhitespace(scanner);
    if (!scanJsonValue(scanner)) {
      return reject("body must be valid JSON.");
    }
    skipJsonWhitespace(scanner);

    return scanner.index === scanner.text.length
      ? accept(true)
      : reject("body must be valid JSON.");
  } catch {
    return reject("body must be valid JSON.");
  }
}

interface JsonDuplicateScanner {
  readonly text: string;
  index: number;
}

function scanJsonValue(scanner: JsonDuplicateScanner): boolean {
  skipJsonWhitespace(scanner);

  const code = scanner.text.charCodeAt(scanner.index);

  if (code === 123) return scanJsonObject(scanner);
  if (code === 91) return scanJsonArray(scanner);
  if (code === 34) return scanJsonString(scanner) !== undefined;
  if (code === 45 || isAsciiDigitCode(code)) return scanJsonNumber(scanner);

  return (
    scanJsonLiteral(scanner, "true") ||
    scanJsonLiteral(scanner, "false") ||
    scanJsonLiteral(scanner, "null")
  );
}

function scanJsonObject(scanner: JsonDuplicateScanner): boolean {
  scanner.index += 1;
  skipJsonWhitespace(scanner);

  const keys = new Set<string>();
  if (scanner.text.charCodeAt(scanner.index) === 125) {
    scanner.index += 1;
    return true;
  }

  while (scanner.index < scanner.text.length) {
    const key = scanJsonString(scanner);
    if (key === undefined || keys.has(key)) return false;
    keys.add(key);

    skipJsonWhitespace(scanner);
    if (scanner.text.charCodeAt(scanner.index) !== 58) return false;
    scanner.index += 1;

    if (!scanJsonValue(scanner)) return false;

    skipJsonWhitespace(scanner);
    const separator = scanner.text.charCodeAt(scanner.index);
    if (separator === 125) {
      scanner.index += 1;
      return true;
    }
    if (separator !== 44) return false;
    scanner.index += 1;
    skipJsonWhitespace(scanner);
  }

  return false;
}

function scanJsonArray(scanner: JsonDuplicateScanner): boolean {
  scanner.index += 1;
  skipJsonWhitespace(scanner);

  if (scanner.text.charCodeAt(scanner.index) === 93) {
    scanner.index += 1;
    return true;
  }

  while (scanner.index < scanner.text.length) {
    if (!scanJsonValue(scanner)) return false;

    skipJsonWhitespace(scanner);
    const separator = scanner.text.charCodeAt(scanner.index);
    if (separator === 93) {
      scanner.index += 1;
      return true;
    }
    if (separator !== 44) return false;
    scanner.index += 1;
  }

  return false;
}

function scanJsonString(scanner: JsonDuplicateScanner): string | undefined {
  if (scanner.text.charCodeAt(scanner.index) !== 34) {
    return undefined;
  }

  const start = scanner.index;
  scanner.index += 1;

  while (scanner.index < scanner.text.length) {
    const code = scanner.text.charCodeAt(scanner.index);

    if (code === 34) {
      scanner.index += 1;
      try {
        const decoded = JSON.parse(scanner.text.slice(start, scanner.index));
        return typeof decoded === "string" ? decoded : undefined;
      } catch {
        return undefined;
      }
    }

    if (code <= 0x1f) return undefined;

    if (code === 92) {
      scanner.index += 1;
      const escape = scanner.text.charCodeAt(scanner.index);
      if (
        escape === 34 ||
        escape === 47 ||
        escape === 92 ||
        escape === 98 ||
        escape === 102 ||
        escape === 110 ||
        escape === 114 ||
        escape === 116
      ) {
        scanner.index += 1;
        continue;
      }
      if (escape !== 117) return undefined;

      scanner.index += 1;
      for (let count = 0; count < 4; count += 1) {
        if (!isAsciiHexCode(scanner.text.charCodeAt(scanner.index))) {
          return undefined;
        }
        scanner.index += 1;
      }
      continue;
    }

    scanner.index += 1;
  }

  return undefined;
}

function scanJsonNumber(scanner: JsonDuplicateScanner): boolean {
  const start = scanner.index;

  if (scanner.text.charCodeAt(scanner.index) === 45) {
    scanner.index += 1;
  }

  const first = scanner.text.charCodeAt(scanner.index);
  if (first === 48) {
    scanner.index += 1;
  } else if (first >= 49 && first <= 57) {
    scanner.index += 1;
    while (isAsciiDigitCode(scanner.text.charCodeAt(scanner.index))) {
      scanner.index += 1;
    }
  } else {
    return false;
  }

  if (scanner.text.charCodeAt(scanner.index) === 46) {
    scanner.index += 1;
    if (!isAsciiDigitCode(scanner.text.charCodeAt(scanner.index))) return false;
    while (isAsciiDigitCode(scanner.text.charCodeAt(scanner.index))) {
      scanner.index += 1;
    }
  }

  const exponent = scanner.text.charCodeAt(scanner.index);
  if (exponent === 69 || exponent === 101) {
    scanner.index += 1;
    const sign = scanner.text.charCodeAt(scanner.index);
    if (sign === 43 || sign === 45) {
      scanner.index += 1;
    }
    if (!isAsciiDigitCode(scanner.text.charCodeAt(scanner.index))) return false;
    while (isAsciiDigitCode(scanner.text.charCodeAt(scanner.index))) {
      scanner.index += 1;
    }
  }

  return scanner.index > start;
}

function scanJsonLiteral(scanner: JsonDuplicateScanner, literal: string): boolean {
  if (scanner.text.slice(scanner.index, scanner.index + literal.length) !== literal) {
    return false;
  }

  scanner.index += literal.length;
  return true;
}

function skipJsonWhitespace(scanner: JsonDuplicateScanner): void {
  while (scanner.index < scanner.text.length) {
    const code = scanner.text.charCodeAt(scanner.index);
    if (code !== 9 && code !== 10 && code !== 13 && code !== 32) return;
    scanner.index += 1;
  }
}

function validateStringArray(
  value: PlainJson | undefined,
  path: string,
): ValidationResult<readonly string[]> {
  return validateArray(value, path, (item, itemPath) => {
    if (typeof item !== "string" || item.length === 0) {
      return reject(`${itemPath} must be a non-empty string.`);
    }

    return accept(item);
  });
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

function previewFailure(
  code: string,
  message: string,
  rejections: readonly ControllerShellEvaluationRejection[],
): Extract<ControllerShellPreviewResult, { readonly ok: false }> {
  return {
    ...EMPTY_DIFF,
    error: {
      code,
      message,
    },
    ok: false,
    rejections,
  };
}

function malformedRejections(reason: string): readonly ControllerShellEvaluationRejection[] {
  return Object.freeze([
    Object.freeze({
      code: "INVALID_CONFIG",
      message: reason,
      path: "",
    }),
  ]);
}

function methodNotAllowed(): ControllerShellResponse {
  return jsonResponse(405, routeError("METHOD_NOT_ALLOWED", "Method is not available for this route."));
}

function routeError(code: string, message: string): { readonly ok: false; readonly error: ControllerShellRouteError } {
  return {
    error: {
      code,
      message,
    },
    ok: false,
  };
}

function htmlResponse(status: number, body: string): ControllerShellResponse {
  return {
    body,
    contentType: HTML_CONTENT_TYPE,
    status,
  };
}

function jsonResponse(status: number, value: unknown): ControllerShellResponse {
  return {
    body: stableStringify(value),
    contentType: JSON_CONTENT_TYPE,
    status,
  };
}

function renderStatusHtml(status: ControllerShellStatus): string {
  const errorItems = status.errors.length === 0
    ? "<li>none</li>"
    : status.errors
      .map((error) => `<li>${escapeHtml(error.source)}: ${escapeHtml(error.message)}</li>`)
      .join("");

  return (
    "<!doctype html>" +
    '<html lang="en">' +
    "<head>" +
    '<meta charset="utf-8">' +
    "<title>Vita Controller</title>" +
    "</head>" +
    "<body>" +
    "<main>" +
    "<h1>Vita Controller</h1>" +
    "<dl>" +
    `<dt>Reachable</dt><dd>${escapeHtml(status.reachable ? "yes" : "no")}</dd>` +
    `<dt>Healthy</dt><dd>${escapeHtml(status.healthy ? "yes" : "no")}</dd>` +
    `<dt>Hostname</dt><dd>${escapeHtml(status.hostname)}</dd>` +
    `<dt>Capabilities</dt><dd>${status.caps}</dd>` +
    `<dt>Version</dt><dd>${escapeHtml(status.version)}</dd>` +
    "</dl>" +
    "<h2>Operations</h2>" +
    `<p>${escapeHtml(status.operations.join(", "))}</p>` +
    "<h2>Status Errors</h2>" +
    `<ul>${errorItems}</ul>` +
    "</main>" +
    "</body>" +
    "</html>"
  );
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    const items: string[] = [];

    for (let index = 0; index < value.length; index += 1) {
      const item = value[index];
      items.push(item === undefined ? "null" : stableStringify(item));
    }

    return `[${items.join(",")}]`;
  }

  if (value !== null && typeof value === "object") {
    const record = value as Readonly<Record<string, unknown>>;
    const keys = Object.keys(record).sort(compareStrings);
    const entries: string[] = [];

    for (let index = 0; index < keys.length; index += 1) {
      const key = keys[index];

      if (key !== undefined) {
        entries.push(`${JSON.stringify(key)}:${stableStringify(record[key])}`);
      }
    }

    return `{${entries.join(",")}}`;
  }

  return "null";
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function field(value: PlainJsonObject, key: string): PlainJson | undefined {
  if (!Object.hasOwn(value, key)) return undefined;

  return value[key];
}

function isPlainObject(value: PlainJson | undefined): value is PlainJsonObject {
  return value !== undefined && value !== null && typeof value === "object" && !Array.isArray(value);
}

function isKnownMethod(value: string): boolean {
  return (
    value === "GET" ||
    value === "POST" ||
    value === "PUT" ||
    value === "PATCH" ||
    value === "DELETE" ||
    value === "OPTIONS" ||
    value === "HEAD"
  );
}

function isHttpStatus(value: PlainJson | undefined): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 100 && value <= 599;
}

function isSuccessStatus(status: number): boolean {
  return status >= 200 && status <= 299;
}

function isNonNegativeSafeInteger(value: PlainJson | undefined): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isApplyOutcome(value: PlainJson | undefined): value is ControllerShellApplyOutcome {
  return typeof value === "string" && contains(APPLY_OUTCOMES, value);
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

function isAsciiDigitCode(code: number): boolean {
  return code >= 48 && code <= 57;
}

function isAsciiHexCode(code: number): boolean {
  return (
    (code >= 48 && code <= 57) ||
    (code >= 65 && code <= 70) ||
    (code >= 97 && code <= 102)
  );
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
