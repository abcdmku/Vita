import { isAgentClientError } from "./agent-client.ts";
import { applyNodeConfig } from "./apply-node-config.ts";
import { safeNormalize } from "./safe-normalize.ts";
import type {
  AgentApplyPlan,
  AgentApplyResult,
  AgentClient,
} from "./agent-client.ts";
import type {
  ApplyNodeApplyResult,
  ApplyNodeResultError,
  ApplyNodeConfigResult,
  ApplyNodeTransport,
  ApplyNodeTransportResponse,
} from "./apply-node-config.ts";
import type { CapabilityObject } from "./capability-manifest.ts";
import type {
  CapabilityManifestRegistry,
  TransactionPlan,
} from "./evaluate.ts";
import type { CanonicalJsonObject } from "./plan.ts";
import type {
  PlainJson,
  PlainJsonObject,
} from "./safe-normalize.ts";

export interface PdsRepoRecord {
  readonly collection: string;
  readonly rkey: string;
  readonly valueDigest: string;
}

export interface PdsRepoCreateDesired {
  readonly repo: string;
  readonly commit: {
    readonly cursor: number;
  };
  readonly records: readonly PdsRepoRecord[];
}

export interface PdsRepoCreateConfig {
  readonly "pds.repo": {
    readonly desired: PdsRepoCreateDesired;
  };
}

export interface PdsRepoStateSummary {
  readonly repo: string | null;
  readonly records: number;
  readonly commitCursor: number;
  readonly log: number;
}

export type PdsRepoResult =
  | {
      readonly ok: true;
      readonly outcome: "committed";
      readonly state: PdsRepoStateSummary;
    }
  | {
      readonly ok: true;
      readonly outcome: "rejected";
      readonly reason: string;
    }
  | {
      readonly ok: false;
      readonly reason: string;
    };

type PdsRepoApplyResult =
  | {
      readonly ok: true;
      readonly outcome: "committed";
    }
  | {
      readonly ok: true;
      readonly outcome: "rejected";
      readonly reason: string;
    }
  | {
      readonly ok: false;
      readonly reason: string;
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

export const PDS_REPO_CAPABILITY = "pds.repo";
export const PDS_REPO_TEST_REPO = "did:plc:ewvi7nxzyoun6zhxrhs64oiz";
export const PDS_REPO_COMMIT_CURSOR = 43;
export const PDS_REPO_RECORDS = Object.freeze([
  Object.freeze({
    collection: "app.bsky.actor.profile",
    rkey: "self",
    valueDigest: "2222222222222222222222222222222222222222222222222222222222222222",
  }),
  Object.freeze({
    collection: "app.bsky.feed.post",
    rkey: "p1-067-post",
    valueDigest: "1111111111111111111111111111111111111111111111111111111111111111",
  }),
]) satisfies readonly PdsRepoRecord[];

export const PDS_REPO_CREATE_DESIRED = Object.freeze({
  commit: Object.freeze({
    cursor: PDS_REPO_COMMIT_CURSOR,
  }),
  records: PDS_REPO_RECORDS,
  repo: PDS_REPO_TEST_REPO,
}) satisfies PdsRepoCreateDesired;

const READ_RESPONSE_FIELDS = Object.freeze([
  "commitCursor",
  "exists",
  "log",
  "records",
  "repo",
]);
const RECORD_FIELDS = Object.freeze(["collection", "rkey", "valueDigest"]);
const LOG_FIELDS = Object.freeze(["collection", "cursor", "op", "rkey"]);
const TRANSPORT_RESPONSE_FIELDS = Object.freeze(["status", "body"]);
const APPLY_RESULT_REQUIRED_FIELDS = Object.freeze([
  "outcome",
  "applied",
  "rolledBack",
  "rollbackErrors",
]);
const APPLY_RESULT_OPTIONAL_FIELDS = Object.freeze(["error", "auditUnrecorded"]);
const RESULT_ERROR_REQUIRED_FIELDS = Object.freeze(["code", "message"]);
const RESULT_ERROR_OPTIONAL_FIELDS = Object.freeze(["index", "capability"]);
const OPERATION_RESULT_FIELDS = Object.freeze(["index", "capability"]);
const APPLY_OUTCOMES = Object.freeze(["committed", "rolledBack", "rejected"]);
const EMPTY_REPO_STATE = Object.freeze({
  commitCursor: 0,
  log: 0,
  records: 0,
  repo: null,
}) satisfies PdsRepoStateSummary;

export function buildPdsRepoCreateConfig(
  desired: PdsRepoCreateDesired = PDS_REPO_CREATE_DESIRED,
): PdsRepoCreateConfig {
  return Object.freeze({
    "pds.repo": Object.freeze({
      desired: freezeDesired(desired),
    }),
  });
}

export function buildPdsRepoCreatePlan(
  desired: PdsRepoCreateDesired = PDS_REPO_CREATE_DESIRED,
): TransactionPlan {
  return Object.freeze({
    operations: Object.freeze([
      Object.freeze({
        capability: PDS_REPO_CAPABILITY,
        request: pdsRepoCapabilityRequest(desired),
      }),
    ]),
  }) satisfies TransactionPlan;
}

export function buildInvalidPdsRepoCreatePlan(): AgentApplyPlan {
  return Object.freeze({
    operations: Object.freeze([
      Object.freeze({
        capability: PDS_REPO_CAPABILITY,
        request: pdsRepoAgentRequest({
          ...PDS_REPO_CREATE_DESIRED,
          commit: Object.freeze({
            cursor: PDS_REPO_COMMIT_CURSOR - 1,
          }),
        }),
      }),
    ]),
  }) satisfies AgentApplyPlan;
}

function pdsRepoCapabilityRequest(desired: PdsRepoCreateDesired): CapabilityObject {
  return Object.freeze({
    desired: desiredToCapabilityObject(desired),
  });
}

function pdsRepoAgentRequest(desired: PdsRepoCreateDesired): CanonicalJsonObject {
  return Object.freeze({
    desired: desiredToCapabilityObject(desired),
  });
}

function desiredToCapabilityObject(desired: PdsRepoCreateDesired): CapabilityObject {
  const records: CapabilityObject[] = [];

  for (let index = 0; index < desired.records.length; index += 1) {
    const record = desired.records[index];
    if (record !== undefined) {
      records[records.length] = Object.freeze({
        collection: record.collection,
        rkey: record.rkey,
        valueDigest: record.valueDigest,
      });
    }
  }

  return Object.freeze({
    commit: Object.freeze({
      cursor: desired.commit.cursor,
    }),
    records: Object.freeze(records),
    repo: desired.repo,
  });
}

export async function applyAndReadPdsRepoCreate(
  registry: CapabilityManifestRegistry,
  transport: ApplyNodeTransport,
  client: Pick<AgentClient, "getState">,
  desired: PdsRepoCreateDesired = PDS_REPO_CREATE_DESIRED,
): Promise<PdsRepoResult> {
  const applied = await applyPdsRepoCreate(registry, transport, desired);

  if (!applied.ok || applied.outcome === "rejected") {
    return applied;
  }

  const read = await readPdsRepoStateSummary(client);

  if (!read.ok) {
    return failedRepo("read");
  }

  if (read.state.repo === null) {
    return failedRepo("empty_readback");
  }

  return {
    ok: true,
    outcome: "committed",
    state: read.state,
  };
}

export async function rejectInvalidPdsRepoCreate(
  client: Pick<AgentClient, "apply">,
): Promise<PdsRepoResult> {
  try {
    const result = await client.apply(buildInvalidPdsRepoCreatePlan());

    if (result.outcome === "rejected" || result.outcome === "rolledBack") {
      return rejectedRepo(agentApplyResultReason(result));
    }
  } catch (cause) {
    if (
      isAgentClientError(cause) &&
      cause.agentError !== undefined &&
      cause.status !== undefined &&
      cause.status >= 400 &&
      cause.status <= 499
    ) {
      return rejectedRepo(cause.agentError.code);
    }
  }

  return failedRepo("invalid PDS repo request was not rejected by agentd");
}

export async function readPdsRepoStateSummary(
  client: Pick<AgentClient, "getState">,
): Promise<
  | {
      readonly ok: true;
      readonly state: PdsRepoStateSummary;
    }
  | {
      readonly ok: false;
      readonly reason: string;
    }
> {
  try {
    return parsePdsRepoReadResponse(await client.getState(PDS_REPO_CAPABILITY));
  } catch (cause) {
    return rejectRead(describeError(cause));
  }
}

export function parsePdsRepoReadResponse(response: unknown): ReturnType<typeof readPdsRepoStateSummary> extends Promise<infer T> ? T : never {
  try {
    const normalized = safeNormalize(response);

    if (!normalized.ok) {
      return rejectRead(normalized.reason);
    }
    if (!isRecord(normalized.value)) {
      return rejectRead("PDS repo read response must be an object.");
    }

    const fields = expectFields(normalized.value, READ_RESPONSE_FIELDS);
    if (!fields.ok) return fields;

    const exists = field(normalized.value, "exists");
    if (typeof exists !== "boolean") {
      return rejectRead("PDS repo read exists must be a boolean.");
    }

    const repo = field(normalized.value, "repo");
    const commitCursor = field(normalized.value, "commitCursor");
    const records = validateRecordArray(field(normalized.value, "records"));
    const log = validateLogArray(field(normalized.value, "log"));

    if (!records.ok) return records;
    if (!log.ok) return log;

    if (!exists) {
      return {
        ok: true,
        state: EMPTY_REPO_STATE,
      };
    }

    if (typeof repo !== "string" || repo.length === 0) {
      return rejectRead("PDS repo read repo must be a non-empty string.");
    }
    if (!isNonNegativeSafeInteger(commitCursor)) {
      return rejectRead("PDS repo read commitCursor must be a non-negative integer.");
    }

    return {
      ok: true,
      state: {
        commitCursor,
        log: log.value,
        records: records.value,
        repo,
      },
    };
  } catch {
    return rejectRead("PDS repo read response validation failed.");
  }
}

export function formatPdsRepoMarker(result: PdsRepoResult): string {
  if (!result.ok) {
    return "VITA-PDS-REPO-ERROR: status=FAILSAFE";
  }

  if (result.outcome === "rejected") {
    return `VITA-PDS-REPO: outcome=rejected reason=${result.reason} status=OK`;
  }

  return (
    "VITA-PDS-REPO: " +
    `records=${result.state.records} ` +
    `committed cursor=${result.state.commitCursor} ` +
    "status=OK"
  );
}

async function applyPdsRepoCreate(
  registry: CapabilityManifestRegistry,
  transport: ApplyNodeTransport,
  desired: PdsRepoCreateDesired,
): Promise<PdsRepoApplyResult> {
  if (registry.has(PDS_REPO_CAPABILITY)) {
    return pdsRepoApplyResultFromApplyNodeConfigResult(
      await applyNodeConfig(buildPdsRepoCreateConfig(desired), registry, transport),
    );
  }

  return applyPdsRepoPlanDirectly(transport, buildPdsRepoCreatePlan(desired));
}

async function applyPdsRepoPlanDirectly(
  transport: ApplyNodeTransport,
  plan: TransactionPlan,
): Promise<PdsRepoApplyResult> {
  let rawResponse: ApplyNodeTransportResponse;

  try {
    rawResponse = await transport("POST", "/apply", plan);
  } catch {
    return failedRepo("transport");
  }

  const response = readTransportResponse(rawResponse);
  if (!response.ok) {
    return failedRepo("apply");
  }
  if (response.value.status < 200 || response.value.status >= 300) {
    return failedRepo("apply");
  }

  const applyResult = readApplyResult(response.value.body);
  if (!applyResult.ok) {
    return failedRepo("apply");
  }
  if (applyResult.value.outcome === "committed") {
    return {
      ok: true,
      outcome: "committed",
    };
  }
  if (applyResult.value.outcome === "rejected" || applyResult.value.outcome === "rolledBack") {
    return rejectedRepo(applyResultReason(applyResult.value, "transaction_rejected"));
  }

  return failedRepo("apply");
}

function pdsRepoApplyResultFromApplyNodeConfigResult(
  result: ApplyNodeConfigResult,
): PdsRepoApplyResult {
  if (result.ok) {
    return {
      ok: true,
      outcome: "committed",
    };
  }

  if (
    result.stage === "apply" &&
    result.applyResult !== undefined &&
    (result.applyResult.outcome === "rejected" || result.applyResult.outcome === "rolledBack")
  ) {
    return rejectedRepo(applyResultReason(result.applyResult, result.reason));
  }

  return failedRepo(result.stage);
}

function readTransportResponse(value: unknown): ValidationResult<ApplyNodeTransportResponse> {
  const normalized = safeNormalize(value);

  if (!normalized.ok) {
    return reject(`Transport response is malformed: ${normalized.reason}`);
  }
  if (!isRecord(normalized.value)) {
    return reject("Transport response must be an object.");
  }

  const fields = expectValidationFields(normalized.value, TRANSPORT_RESPONSE_FIELDS);
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

  const fields = expectValidationFields(
    normalized.value,
    APPLY_RESULT_REQUIRED_FIELDS,
    APPLY_RESULT_OPTIONAL_FIELDS,
  );
  if (!fields.ok) return fields;

  const outcome = field(normalized.value, "outcome");
  const applied = validateOperationArray(field(normalized.value, "applied"), "applied");
  const rolledBack = validateOperationArray(field(normalized.value, "rolledBack"), "rolledBack");
  const rollbackErrors = validateResultErrorArray(field(normalized.value, "rollbackErrors"), "rollbackErrors");
  const errorValue = optionalField(normalized.value, "error");
  const auditUnrecorded = optionalField(normalized.value, "auditUnrecorded");

  if (!isApplyOutcome(outcome)) {
    return reject("outcome must be committed, rolledBack, or rejected.");
  }
  if (!applied.ok) return applied;
  if (!rolledBack.ok) return rolledBack;
  if (!rollbackErrors.ok) return rollbackErrors;

  const output: {
    outcome: "committed" | "rolledBack" | "rejected";
    applied: ApplyNodeApplyResult["applied"];
    rolledBack: ApplyNodeApplyResult["rolledBack"];
    rollbackErrors: ApplyNodeApplyResult["rollbackErrors"];
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

function validateOperationArray(
  value: PlainJson | undefined,
  path: string,
): ValidationResult<ApplyNodeApplyResult["applied"]> {
  return validateArray(value, path, validateOperationResult);
}

function validateOperationResult(
  value: PlainJson | undefined,
  path: string,
): ValidationResult<ApplyNodeApplyResult["applied"][number]> {
  if (!isRecord(value)) return reject(`${path} must be an object.`);

  const fields = expectValidationFields(value, OPERATION_RESULT_FIELDS);
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

function validateResultErrorArray(
  value: PlainJson | undefined,
  path: string,
): ValidationResult<ApplyNodeApplyResult["rollbackErrors"]> {
  return validateArray(value, path, validateResultError);
}

function validateResultError(
  value: PlainJson | undefined,
  path: string,
): ValidationResult<NonNullable<ApplyNodeApplyResult["error"]>> {
  if (!isRecord(value)) return reject(`${path} must be an object.`);

  const fields = expectValidationFields(value, RESULT_ERROR_REQUIRED_FIELDS, RESULT_ERROR_OPTIONAL_FIELDS, path);
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

function validateRecordArray(value: PlainJson | undefined): ValidationResult<number> {
  if (!Array.isArray(value)) return rejectRead("PDS repo records must be an array.");

  for (let index = 0; index < value.length; index += 1) {
    const item = value[index];
    if (!isRecord(item)) {
      return rejectRead(`PDS repo records[${index}] must be an object.`);
    }
    const fields = expectFields(item, RECORD_FIELDS);
    if (!fields.ok) return fields;
    if (
      typeof field(item, "collection") !== "string" ||
      typeof field(item, "rkey") !== "string" ||
      typeof field(item, "valueDigest") !== "string"
    ) {
      return rejectRead(`PDS repo records[${index}] contains malformed fields.`);
    }
  }

  return accept(value.length);
}

function validateLogArray(value: PlainJson | undefined): ValidationResult<number> {
  if (!Array.isArray(value)) return rejectRead("PDS repo log must be an array.");

  for (let index = 0; index < value.length; index += 1) {
    const item = value[index];
    if (!isRecord(item)) {
      return rejectRead(`PDS repo log[${index}] must be an object.`);
    }
    const fields = expectFields(item, LOG_FIELDS);
    if (!fields.ok) return fields;
    if (
      !isNonNegativeSafeInteger(field(item, "cursor")) ||
      typeof field(item, "op") !== "string" ||
      typeof field(item, "collection") !== "string" ||
      typeof field(item, "rkey") !== "string"
    ) {
      return rejectRead(`PDS repo log[${index}] contains malformed fields.`);
    }
  }

  return accept(value.length);
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
  allowed: readonly string[],
): ReturnType<typeof readPdsRepoStateSummary> extends Promise<infer T> ? T | { readonly ok: true } : never {
  const keys = Object.keys(value);

  for (let index = 0; index < keys.length; index += 1) {
    const key = keys[index];
    if (key === undefined || !contains(allowed, key)) {
      return rejectRead("PDS repo read response contains an unexpected field.");
    }
  }

  for (let index = 0; index < allowed.length; index += 1) {
    const key = allowed[index];
    if (key === undefined || !Object.hasOwn(value, key)) {
      return rejectRead("PDS repo read response is missing a required field.");
    }
  }

  return { ok: true };
}

function expectValidationFields(
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

function freezeDesired(desired: PdsRepoCreateDesired): PdsRepoCreateDesired {
  const records: PdsRepoRecord[] = [];

  for (let index = 0; index < desired.records.length; index += 1) {
    const record = desired.records[index];
    if (record !== undefined) {
      records[records.length] = Object.freeze({
        collection: record.collection,
        rkey: record.rkey,
        valueDigest: record.valueDigest,
      });
    }
  }

  return Object.freeze({
    commit: Object.freeze({
      cursor: desired.commit.cursor,
    }),
    records: Object.freeze(records),
    repo: desired.repo,
  });
}

function applyResultReason(result: ApplyNodeApplyResult, fallback: string): string {
  return markerToken(result.error?.code ?? fallback);
}

function agentApplyResultReason(result: AgentApplyResult): string {
  return markerToken(result.error?.code ?? "transaction_rejected");
}

function rejectedRepo(reason: string): Extract<PdsRepoResult, { readonly outcome: "rejected" }> {
  return {
    ok: true,
    outcome: "rejected",
    reason: markerToken(reason),
  };
}

function failedRepo(reason: string): Extract<PdsRepoResult, { readonly ok: false }> {
  return {
    ok: false,
    reason,
  };
}

function rejectRead(reason: string): {
  readonly ok: false;
  readonly reason: string;
} {
  return {
    ok: false,
    reason,
  };
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

function isHttpStatus(value: PlainJson | undefined): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 100 && value <= 599;
}

function isNonNegativeSafeInteger(value: PlainJson | undefined): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isApplyOutcome(value: PlainJson | undefined): value is "committed" | "rolledBack" | "rejected" {
  return typeof value === "string" && contains(APPLY_OUTCOMES, value);
}

function contains(values: readonly string[], value: string): boolean {
  for (let index = 0; index < values.length; index += 1) {
    if (values[index] === value) {
      return true;
    }
  }

  return false;
}

function prefix(path: string): string {
  return path === "" ? "" : `${path}.`;
}

function describeError(cause: unknown): string {
  return cause instanceof Error && cause.message.length > 0
    ? cause.message
    : "PDS repo read failed.";
}

function markerToken(value: string): string {
  const token = value.replace(/[^A-Za-z0-9_.-]+/gu, "_");
  return token.length === 0 ? "unknown" : token;
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
