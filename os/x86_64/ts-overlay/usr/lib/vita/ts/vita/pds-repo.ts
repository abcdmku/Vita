import { isAgentClientError } from "./agent-client.ts";
import { applyNodeConfig } from "./apply-node-config.ts";
import { safeNormalize } from "./safe-normalize.ts";
import type {
  AgentApplyPlan,
  AgentApplyResult,
  AgentClient,
  AgentTransport,
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

export interface PdsRepoDeleteRecord {
  readonly collection: string;
  readonly rkey: string;
}

export interface PdsRepoDeleteDesired {
  readonly repo: string;
  readonly commit: {
    readonly cursor: number;
  };
  readonly records: readonly PdsRepoRecord[];
  readonly deletes: readonly PdsRepoDeleteRecord[];
}

export interface PdsRepoQueryRequest {
  readonly capability: typeof PDS_REPO_CAPABILITY;
  readonly request: {
    readonly query: {
      readonly collection: string;
      readonly limit: number;
      readonly cursor?: number;
    };
  };
}

export type PdsRepoReadTransport = (
  method: "GET",
  path: "/state",
  body: PdsRepoQueryRequest,
) => Promise<ApplyNodeTransportResponse>;

export interface PdsRepoStateSummary {
  readonly repo: string | null;
  readonly records: number;
  readonly commitCursor: number;
  readonly log: number;
}

export interface PdsRepoQueryPageSummary {
  readonly collection: string;
  readonly page: number;
  readonly records: number;
}

export interface PdsRepoQueryPage {
  readonly exists: boolean;
  readonly collection: string;
  readonly records: readonly PdsRepoRecord[];
  readonly total: number;
  readonly nextCursor: number | null;
}

export interface PdsRepoFullState {
  readonly repo: string | null;
  readonly records: readonly PdsRepoRecord[];
  readonly commitCursor: number;
  readonly log: readonly PdsRepoLogEntry[];
}

export interface PdsRepoLogEntry {
  readonly cursor: number;
  readonly op: "create-record" | "delete-record";
  readonly collection: string;
  readonly rkey: string;
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

export type PdsRepoQueryResult =
  | {
      readonly ok: true;
      readonly pages: readonly PdsRepoQueryPageSummary[];
    }
  | {
      readonly ok: false;
      readonly reason: string;
    };

export type PdsRepoDeleteResult =
  | {
      readonly ok: true;
      readonly outcome: "committed";
      readonly removed: string;
      readonly tombstoneCursor: number;
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
export const PDS_REPO_DELETE_CURSOR = PDS_REPO_COMMIT_CURSOR + 1;
export const PDS_REPO_QUERY_COLLECTION = "app.bsky.feed.post";
export const PDS_REPO_QUERY_LIMIT = 2;
export const PDS_REPO_DELETE_RECORD = Object.freeze({
  collection: PDS_REPO_QUERY_COLLECTION,
  rkey: "p1-067-post",
}) satisfies PdsRepoDeleteRecord;
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

export const PDS_REPO_DELETE_DESIRED = Object.freeze({
  commit: Object.freeze({
    cursor: PDS_REPO_DELETE_CURSOR,
  }),
  deletes: Object.freeze([PDS_REPO_DELETE_RECORD]),
  records: Object.freeze([]),
  repo: PDS_REPO_TEST_REPO,
}) satisfies PdsRepoDeleteDesired;

const READ_RESPONSE_FIELDS = Object.freeze([
  "commitCursor",
  "exists",
  "log",
  "records",
  "repo",
]);
const RECORD_FIELDS = Object.freeze(["collection", "rkey", "valueDigest"]);
const LOG_FIELDS = Object.freeze(["collection", "cursor", "op", "rkey"]);
const QUERY_READ_REQUEST_FIELDS = Object.freeze(["capability", "request"]);
const QUERY_READ_REQUEST_BODY_FIELDS = Object.freeze(["query"]);
const QUERY_FIELDS = Object.freeze(["collection", "cursor", "limit"]);
const QUERY_RESPONSE_FIELDS = Object.freeze([
  "collection",
  "exists",
  "nextCursor",
  "records",
  "total",
]);
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
const NSID_SEGMENT_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/u;
const RECORD_KEY_PATTERN = /^[A-Za-z0-9._~:-]+$/u;
const SHA256_HEX_PATTERN = /^[0-9a-f]{64}$/u;
const DEFAULT_AGENTD_BASE_URL = "http://agentd";
const JSON_GET_HEADERS = Object.freeze({
  Accept: "application/json",
});
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

export function buildPdsRepoQueryRequest(
  collection: string = PDS_REPO_QUERY_COLLECTION,
  cursor?: number,
  limit: number = PDS_REPO_QUERY_LIMIT,
): PdsRepoQueryRequest {
  const query: {
    collection: string;
    limit: number;
    cursor?: number;
  } = {
    collection,
    limit,
  };

  if (cursor !== undefined) {
    query.cursor = cursor;
  }

  return Object.freeze({
    capability: PDS_REPO_CAPABILITY,
    request: Object.freeze({
      query: Object.freeze(query),
    }),
  }) satisfies PdsRepoQueryRequest;
}

export function buildPdsRepoDeletePlan(
  desired: PdsRepoDeleteDesired = PDS_REPO_DELETE_DESIRED,
): AgentApplyPlan {
  return Object.freeze({
    operations: Object.freeze([
      Object.freeze({
        capability: PDS_REPO_CAPABILITY,
        request: pdsRepoDeleteAgentRequest(desired),
      }),
    ]),
  }) satisfies AgentApplyPlan;
}

export function createPdsRepoReadTransport(
  agentTransport: AgentTransport,
  baseUrl: string | URL = DEFAULT_AGENTD_BASE_URL,
): PdsRepoReadTransport {
  return async (method, path, body) => {
    if (method !== "GET" || path !== "/state") {
      throw new Error("PDS repo read transport only supports GET /state");
    }

    const query = body.request.query;
    const params = new URLSearchParams();
    params.set("collection", query.collection);
    params.set("limit", String(query.limit));
    if (query.cursor !== undefined) {
      params.set("cursor", String(query.cursor));
    }

    const response = await agentTransport(
      new URL(`/read/${encodeURIComponent(PDS_REPO_CAPABILITY)}?${params.toString()}`, baseUrl).toString(),
      {
        headers: JSON_GET_HEADERS,
        method: "GET",
      },
    );
    const text = await response.text();

    return {
      body: JSON.parse(text),
      status: response.status,
    };
  };
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

export function buildInvalidPdsRepoDeletePlan(): AgentApplyPlan {
  return Object.freeze({
    operations: Object.freeze([
      Object.freeze({
        capability: PDS_REPO_CAPABILITY,
        request: pdsRepoDeleteAgentRequest({
          ...PDS_REPO_DELETE_DESIRED,
          commit: Object.freeze({
            cursor: PDS_REPO_DELETE_CURSOR + 1,
          }),
          deletes: Object.freeze([
            Object.freeze({
              collection: PDS_REPO_QUERY_COLLECTION,
              rkey: "missing-p1-081-delete",
            }),
          ]),
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

function pdsRepoDeleteAgentRequest(desired: PdsRepoDeleteDesired): CanonicalJsonObject {
  return Object.freeze({
    desired: deleteDesiredToCapabilityObject(desired),
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

function deleteDesiredToCapabilityObject(desired: PdsRepoDeleteDesired): CapabilityObject {
  const records: CapabilityObject[] = [];
  const deletes: CapabilityObject[] = [];

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
  for (let index = 0; index < desired.deletes.length; index += 1) {
    const record = desired.deletes[index];
    if (record !== undefined) {
      deletes[deletes.length] = Object.freeze({
        collection: record.collection,
        rkey: record.rkey,
      });
    }
  }

  return Object.freeze({
    commit: Object.freeze({
      cursor: desired.commit.cursor,
    }),
    deletes: Object.freeze(deletes),
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

export async function queryPdsRepoCollection(
  readTransport: PdsRepoReadTransport,
  collection: string = PDS_REPO_QUERY_COLLECTION,
  limit: number = PDS_REPO_QUERY_LIMIT,
): Promise<PdsRepoQueryResult> {
  const pages: PdsRepoQueryPageSummary[] = [];
  let cursor: number | undefined;

  for (let page = 1; page <= 64; page += 1) {
    const result = await readPdsRepoQueryPage(readTransport, collection, limit, cursor);

    if (!result.ok) {
      return failedQuery(result.reason);
    }

    pages[pages.length] = Object.freeze({
      collection: result.page.collection,
      page,
      records: result.page.records.length,
    });

    if (result.page.nextCursor === null) {
      return {
        ok: true,
        pages: Object.freeze(pages),
      };
    }
    if (cursor !== undefined && result.page.nextCursor <= cursor) {
      return failedQuery("cursor");
    }

    cursor = result.page.nextCursor;
  }

  return failedQuery("pagination");
}

export async function deleteAndReadBackPdsRepoRecord(
  client: Pick<AgentClient, "apply" | "getState">,
  desired: PdsRepoDeleteDesired = PDS_REPO_DELETE_DESIRED,
): Promise<PdsRepoDeleteResult> {
  const applied = await applyPdsRepoDelete(client, desired);

  if (!applied.ok || applied.outcome === "rejected") {
    return applied;
  }

  const read = await readPdsRepoFullState(client);

  if (!read.ok) {
    return failedDelete("read");
  }

  const deleted = desired.deletes[0];
  if (deleted === undefined) {
    return failedDelete("delete_request");
  }

  if (containsRecord(read.state.records, deleted.collection, deleted.rkey)) {
    return failedDelete("record_present");
  }
  if (read.state.commitCursor !== desired.commit.cursor) {
    return failedDelete("cursor");
  }
  if (!containsTombstone(read.state.log, desired.commit.cursor, deleted.collection, deleted.rkey)) {
    return failedDelete("tombstone");
  }

  return {
    ok: true,
    outcome: "committed",
    removed: deleted.rkey,
    tombstoneCursor: desired.commit.cursor,
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

export async function rejectInvalidPdsRepoDelete(
  client: Pick<AgentClient, "apply">,
): Promise<PdsRepoDeleteResult> {
  try {
    const result = await client.apply(buildInvalidPdsRepoDeletePlan());

    if (result.outcome === "rejected" || result.outcome === "rolledBack") {
      return rejectedDelete(agentApplyResultReason(result));
    }
  } catch (cause) {
    if (
      isAgentClientError(cause) &&
      cause.agentError !== undefined &&
      cause.status !== undefined &&
      cause.status >= 400 &&
      cause.status <= 499
    ) {
      return rejectedDelete(cause.agentError.code);
    }
  }

  return failedDelete("invalid PDS repo delete request was not rejected by agentd");
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

export async function readPdsRepoFullState(
  client: Pick<AgentClient, "getState">,
): Promise<
  | {
      readonly ok: true;
      readonly state: PdsRepoFullState;
    }
  | {
      readonly ok: false;
      readonly reason: string;
    }
> {
  try {
    return parsePdsRepoFullReadResponse(await client.getState(PDS_REPO_CAPABILITY));
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

export function parsePdsRepoFullReadResponse(response: unknown): ReturnType<typeof readPdsRepoFullState> extends Promise<infer T> ? T : never {
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

    const records = readRecordEntriesArray(field(normalized.value, "records"), "records");
    const log = readLogEntriesArray(field(normalized.value, "log"), "log");

    if (!records.ok) return records;
    if (!log.ok) return log;

    if (!exists) {
      return {
        ok: true,
        state: {
          commitCursor: 0,
          log: Object.freeze([]),
          records: Object.freeze([]),
          repo: null,
        },
      };
    }

    const repo = field(normalized.value, "repo");
    const commitCursor = field(normalized.value, "commitCursor");

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

export function parsePdsRepoQueryResponse(response: unknown): ValidationResult<PdsRepoQueryPage> {
  try {
    const normalized = safeNormalize(response);

    if (!normalized.ok) {
      return reject(`PDS repo query response is malformed: ${normalized.reason}`);
    }
    if (!isRecord(normalized.value)) {
      return reject("PDS repo query response must be an object.");
    }

    const fields = expectValidationFields(normalized.value, QUERY_RESPONSE_FIELDS);
    if (!fields.ok) return fields;

    const exists = field(normalized.value, "exists");
    const collection = field(normalized.value, "collection");
    const records = readRecordEntriesArray(field(normalized.value, "records"), "records");
    const total = field(normalized.value, "total");
    const nextCursor = field(normalized.value, "nextCursor");

    if (typeof exists !== "boolean") {
      return reject("PDS repo query exists must be a boolean.");
    }
    if (typeof collection !== "string" || !isNsidLike(collection)) {
      return reject("PDS repo query collection must be an NSID-shaped string.");
    }
    if (!records.ok) return records;
    if (!isNonNegativeSafeInteger(total)) {
      return reject("PDS repo query total must be a non-negative integer.");
    }
    if (nextCursor !== null && !isNonNegativeSafeInteger(nextCursor)) {
      return reject("PDS repo query nextCursor must be a non-negative integer or null.");
    }
    if (records.value.length > total) {
      return reject("PDS repo query records cannot exceed total.");
    }

    return accept({
      collection,
      exists,
      nextCursor,
      records: records.value,
      total,
    });
  } catch {
    return reject("PDS repo query response validation failed.");
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

export function formatPdsRepoQueryMarkers(result: PdsRepoQueryResult): readonly string[] {
  if (!result.ok) {
    return Object.freeze(["VITA-PDS-QUERY-ERROR: status=FAILSAFE"]);
  }

  const markers: string[] = [];
  for (let index = 0; index < result.pages.length; index += 1) {
    const page = result.pages[index];

    if (page !== undefined) {
      markers[markers.length] = (
        "VITA-PDS-QUERY: " +
        `collection=${page.collection} ` +
        `page=${page.page} ` +
        `records=${page.records} ` +
        "status=OK"
      );
    }
  }

  return Object.freeze(markers);
}

export function formatPdsRepoDeleteMarker(result: PdsRepoDeleteResult): string {
  if (!result.ok) {
    return "VITA-PDS-DELETE-ERROR: status=FAILSAFE";
  }

  if (result.outcome === "rejected") {
    return `VITA-PDS-DELETE: outcome=rejected reason=${result.reason} status=OK`;
  }

  return (
    "VITA-PDS-DELETE: " +
    `removed=${result.removed} ` +
    `tombstone cursor=${result.tombstoneCursor} ` +
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

async function applyPdsRepoDelete(
  client: Pick<AgentClient, "apply">,
  desired: PdsRepoDeleteDesired,
): Promise<PdsRepoDeleteResult> {
  try {
    const result = await client.apply(buildPdsRepoDeletePlan(desired));

    if (result.outcome === "committed") {
      return {
        ok: true,
        outcome: "committed",
        removed: desired.deletes[0]?.rkey ?? "",
        tombstoneCursor: desired.commit.cursor,
      };
    }
    if (result.outcome === "rejected" || result.outcome === "rolledBack") {
      return rejectedDelete(agentApplyResultReason(result));
    }
  } catch (cause) {
    if (
      isAgentClientError(cause) &&
      cause.agentError !== undefined &&
      cause.status !== undefined &&
      cause.status >= 400 &&
      cause.status <= 499
    ) {
      return rejectedDelete(cause.agentError.code);
    }
  }

  return failedDelete("apply");
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

async function readPdsRepoQueryPage(
  readTransport: PdsRepoReadTransport,
  collection: string,
  limit: number,
  cursor: number | undefined,
): Promise<
  | {
      readonly ok: true;
      readonly page: PdsRepoQueryPage;
    }
  | {
      readonly ok: false;
      readonly reason: string;
    }
> {
  let rawResponse: ApplyNodeTransportResponse;

  try {
    rawResponse = await readTransport(
      "GET",
      "/state",
      buildPdsRepoQueryRequest(collection, cursor, limit),
    );
  } catch {
    return failedQuery("transport");
  }

  const response = readTransportResponse(rawResponse);
  if (!response.ok) {
    return failedQuery("read");
  }
  if (response.value.status < 200 || response.value.status >= 300) {
    return failedQuery("read");
  }

  const page = parsePdsRepoQueryResponse(response.value.body);
  if (!page.ok) {
    return failedQuery(page.reason);
  }

  return {
    ok: true,
    page: page.value,
  };
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

function readRecordEntriesArray(
  value: PlainJson | undefined,
  path: string,
): ValidationResult<readonly PdsRepoRecord[]> {
  if (!Array.isArray(value)) return reject(`${path} must be an array.`);

  const records: PdsRepoRecord[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const item = value[index];
    const record = readRecordEntry(item, `${path}[${index}]`);
    if (!record.ok) return record;
    records[index] = record.value;
  }

  return accept(Object.freeze(records));
}

function readRecordEntry(
  value: PlainJson | undefined,
  path: string,
): ValidationResult<PdsRepoRecord> {
  if (!isRecord(value)) return reject(`${path} must be an object.`);

  const fields = expectValidationFields(value, RECORD_FIELDS, [], path);
  if (!fields.ok) return fields;

  const collection = field(value, "collection");
  const rkey = field(value, "rkey");
  const valueDigest = field(value, "valueDigest");

  if (typeof collection !== "string" || !isNsidLike(collection)) {
    return reject(`${path}.collection must be an NSID-shaped string.`);
  }
  if (typeof rkey !== "string" || !isRecordKey(rkey)) {
    return reject(`${path}.rkey must be a bounded AT Protocol record key.`);
  }
  if (typeof valueDigest !== "string" || !isSha256Hex(valueDigest)) {
    return reject(`${path}.valueDigest must be a lowercase SHA-256 hex digest.`);
  }

  return accept({
    collection,
    rkey,
    valueDigest,
  });
}

function readLogEntriesArray(
  value: PlainJson | undefined,
  path: string,
): ValidationResult<readonly PdsRepoLogEntry[]> {
  if (!Array.isArray(value)) return reject(`${path} must be an array.`);

  const log: PdsRepoLogEntry[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const item = value[index];
    const entry = readLogEntry(item, `${path}[${index}]`);
    if (!entry.ok) return entry;
    log[index] = entry.value;
  }

  return accept(Object.freeze(log));
}

function readLogEntry(
  value: PlainJson | undefined,
  path: string,
): ValidationResult<PdsRepoLogEntry> {
  if (!isRecord(value)) return reject(`${path} must be an object.`);

  const fields = expectValidationFields(value, LOG_FIELDS, [], path);
  if (!fields.ok) return fields;

  const cursor = field(value, "cursor");
  const op = field(value, "op");
  const collection = field(value, "collection");
  const rkey = field(value, "rkey");

  if (!isNonNegativeSafeInteger(cursor)) {
    return reject(`${path}.cursor must be a non-negative integer.`);
  }
  if (op !== "create-record" && op !== "delete-record") {
    return reject(`${path}.op must be create-record or delete-record.`);
  }
  if (typeof collection !== "string" || !isNsidLike(collection)) {
    return reject(`${path}.collection must be an NSID-shaped string.`);
  }
  if (typeof rkey !== "string" || !isRecordKey(rkey)) {
    return reject(`${path}.rkey must be a bounded AT Protocol record key.`);
  }

  return accept({
    collection,
    cursor,
    op,
    rkey,
  });
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

function failedQuery(reason: string): Extract<PdsRepoQueryResult, { readonly ok: false }> {
  return {
    ok: false,
    reason,
  };
}

function rejectedDelete(reason: string): Extract<PdsRepoDeleteResult, { readonly outcome: "rejected" }> {
  return {
    ok: true,
    outcome: "rejected",
    reason: markerToken(reason),
  };
}

function failedDelete(reason: string): Extract<PdsRepoDeleteResult, { readonly ok: false }> {
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

function isNsidLike(value: string): boolean {
  if (
    value.length === 0 ||
    value.length > 317 ||
    value !== value.trim() ||
    value.includes("/") ||
    value.includes("?") ||
    value.includes("#")
  ) {
    return false;
  }

  const segments = value.split(".");
  if (segments.length < 3) {
    return false;
  }

  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index];
    if (segment === undefined || !NSID_SEGMENT_PATTERN.test(segment)) {
      return false;
    }
  }

  return true;
}

function isRecordKey(value: string): boolean {
  return (
    value.length > 0 &&
    value.length <= 512 &&
    value === value.trim() &&
    RECORD_KEY_PATTERN.test(value)
  );
}

function isSha256Hex(value: string): boolean {
  return SHA256_HEX_PATTERN.test(value);
}

function containsRecord(
  records: readonly PdsRepoRecord[],
  collection: string,
  rkey: string,
): boolean {
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    if (record !== undefined && record.collection === collection && record.rkey === rkey) {
      return true;
    }
  }

  return false;
}

function containsTombstone(
  log: readonly PdsRepoLogEntry[],
  cursor: number,
  collection: string,
  rkey: string,
): boolean {
  for (let index = 0; index < log.length; index += 1) {
    const entry = log[index];
    if (
      entry !== undefined &&
      entry.cursor === cursor &&
      entry.op === "delete-record" &&
      entry.collection === collection &&
      entry.rkey === rkey
    ) {
      return true;
    }
  }

  return false;
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
