import { createAgentClient } from "./agent-client.ts";
import { compileCapabilityValidator, PDSSYNC_MANIFEST } from "./capability-manifest.ts";
import { safeNormalize } from "./safe-normalize.ts";
import { createDenoUnixSocketAgentTransport } from "./unix-socket-transport.ts";
import type { AgentClient } from "./agent-client.ts";
import type { CapabilityObject } from "./capability-manifest.ts";
import type { PlainJson, PlainJsonObject } from "./safe-normalize.ts";

export interface PdsSyncStateSummary {
  readonly repo: string | null;
  readonly cursor: number;
  readonly head: string | null;
}

export type PdsSyncStateReadResult =
  | {
      readonly ok: true;
      readonly state: PdsSyncStateSummary;
    }
  | {
      readonly ok: false;
      readonly reason: string;
    };

export interface PdsAgentdReadOptions {
  readonly socketPath: string;
  readonly baseUrl?: string | URL;
}

const PDS_SYNC_STATE_CAPABILITY = "pds.sync-state";
const DEFAULT_AGENTD_BASE_URL = "http://agentd";
const READ_RESPONSE_FIELDS = Object.freeze(["exists", "state", "raw"]);
const EMPTY_PDS_STATE = Object.freeze({
  cursor: 0,
  head: null,
  repo: null,
}) satisfies PdsSyncStateSummary;
const PDS_SYNC_STATE_VALIDATOR = compileCapabilityValidator(PDSSYNC_MANIFEST);

export async function readPdsSyncStateSummary(
  client: Pick<AgentClient, "getState">,
): Promise<PdsSyncStateReadResult> {
  try {
    return parsePdsSyncStateReadResponse(
      await client.getState(PDS_SYNC_STATE_CAPABILITY),
    );
  } catch (cause) {
    return rejectRead(describeError(cause));
  }
}

export function readPdsSyncStateSummaryFromAgentd(
  options: PdsAgentdReadOptions,
): Promise<PdsSyncStateReadResult> {
  const client = createAgentClient({
    baseUrl: options.baseUrl ?? DEFAULT_AGENTD_BASE_URL,
    transport: createDenoUnixSocketAgentTransport({
      socketPath: options.socketPath,
    }),
  });

  return readPdsSyncStateSummary(client);
}

export function parsePdsSyncStateReadResponse(response: unknown): PdsSyncStateReadResult {
  try {
    const normalized = safeNormalize(response);

    if (!normalized.ok) {
      return rejectRead(normalized.reason);
    }
    if (!isPlainObject(normalized.value)) {
      return rejectRead("PDS read response must be an object.");
    }

    const fields = expectFields(normalized.value, READ_RESPONSE_FIELDS);
    if (!fields.ok) {
      return fields;
    }

    const raw = field(normalized.value, "raw");
    if (raw !== undefined && raw !== null && typeof raw !== "string") {
      return rejectRead("PDS read raw must be a string or null.");
    }

    const exists = field(normalized.value, "exists");
    if (typeof exists !== "boolean") {
      return rejectRead("PDS read exists must be a boolean.");
    }

    const state = field(normalized.value, "state");
    if (!exists) {
      if (state !== undefined && !isPlainObject(state)) {
        return rejectRead("PDS read state must be an object when present.");
      }

      return {
        ok: true,
        state: EMPTY_PDS_STATE,
      };
    }

    if (!isPlainObject(state)) {
      return rejectRead("PDS read state must be an object.");
    }

    return readExistingPdsState(state);
  } catch {
    return rejectRead("PDS read response validation failed.");
  }
}

export function formatPdsSyncStateReadMarker(result: PdsSyncStateReadResult): string {
  if (!result.ok) {
    return "VITA-PDS-ERROR: status=FAILSAFE";
  }

  return (
    "VITA-PDS: " +
    `repo=${result.state.repo ?? "none"} ` +
    `cursor=${result.state.cursor} ` +
    `head=${result.state.head ?? "none"} ` +
    "status=OK"
  );
}

function readExistingPdsState(state: PlainJsonObject): PdsSyncStateReadResult {
  const validated = PDS_SYNC_STATE_VALIDATOR({
    desired: state,
  });

  if (!validated.ok) {
    return rejectRead("PDS sync state failed validation.");
  }

  const desired = validated.value["desired"];
  if (!isCapabilityObject(desired)) {
    return rejectRead("PDS sync state validator returned malformed data.");
  }

  const repo = desired["repo"];
  const cursor = desired["cursor"];
  const head = desired["repoHead"];

  if (
    typeof repo !== "string" ||
    typeof cursor !== "number" ||
    typeof head !== "string"
  ) {
    return rejectRead("PDS sync state validator returned malformed fields.");
  }

  return {
    ok: true,
    state: {
      cursor,
      head,
      repo,
    },
  };
}

function expectFields(
  value: PlainJsonObject,
  allowed: readonly string[],
): PdsSyncStateReadResult | { readonly ok: true } {
  const keys = Object.keys(value);

  for (let index = 0; index < keys.length; index += 1) {
    const key = keys[index];

    if (key === undefined || !contains(allowed, key)) {
      return rejectRead("PDS read response contains an unexpected field.");
    }
  }

  if (!Object.hasOwn(value, "exists")) {
    return rejectRead("PDS read response is missing exists.");
  }

  return { ok: true };
}

function field(value: PlainJsonObject, key: string): PlainJson | undefined {
  if (!Object.hasOwn(value, key)) {
    return undefined;
  }

  return value[key];
}

function isPlainObject(value: PlainJson | undefined): value is PlainJsonObject {
  return value !== undefined && value !== null && typeof value === "object" && !Array.isArray(value);
}

function isCapabilityObject(value: unknown): value is CapabilityObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function contains(values: readonly string[], value: string): boolean {
  for (let index = 0; index < values.length; index += 1) {
    if (values[index] === value) {
      return true;
    }
  }

  return false;
}

function describeError(cause: unknown): string {
  return cause instanceof Error && cause.message.length > 0
    ? cause.message
    : "PDS sync state read failed.";
}

function rejectRead(reason: string): Extract<PdsSyncStateReadResult, { readonly ok: false }> {
  return {
    ok: false,
    reason,
  };
}
