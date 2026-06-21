import { safeNormalize } from "../../../sdk/typescript/src/safe-normalize.ts";
import type {
  PlainJson,
  PlainJsonObject,
} from "../../../sdk/typescript/src/safe-normalize.ts";

/**
 * Injected HTTP transport. A function `(path) => Promise<{ status, body }>` that
 * abstracts the wire (mirrors the controller/api P2-006 + controller/audit P2-023
 * pattern — no real socket is opened here; tests inject a fake). `body` is
 * `unknown` and untrusted: it is `safeNormalize`d before any field is read.
 */
export type SnapshotTransport = (
  path: string,
) => Promise<SnapshotTransportResponse>;

export interface SnapshotTransportResponse {
  readonly status: number;
  readonly body: unknown;
}

export type NodeSnapshotRejectionReason =
  | "state_unavailable"
  | "transport_error"
  | "unexpected_status"
  | "invalid_response";

export interface NodeSnapshotRejection {
  readonly path: string;
  readonly message: string;
}

/**
 * A per-capability read error surfaced by the agent (`{ error: ... }`). The
 * client does NOT interpret the error payload — it carries the normalized plain
 * data through for callers to inspect.
 */
export interface CapabilityReadError {
  readonly error: PlainJson;
}

export type FetchNodeSnapshotResult =
  | {
      readonly ok: true;
      /** Per-capability current config, as normalized plain data (schema not validated here). */
      readonly configs: Readonly<Record<string, PlainJson>>;
      /** Per-capability read errors, keyed by capability name. */
      readonly errors: Readonly<Record<string, CapabilityReadError>>;
      /** Sorted list of every capability name in the snapshot. */
      readonly capabilityNames: readonly string[];
    }
  | {
      readonly ok: false;
      readonly reason: NodeSnapshotRejectionReason;
      readonly status?: number;
      readonly rejections?: readonly NodeSnapshotRejection[];
    };

const STATE_PATH = "/state";
const ENVELOPE_FIELDS = new Set(["capabilities"]);

/**
 * Fetch the agent's aggregate whole-node snapshot via the injected transport,
 * validate it fail-closed, and return every capability's current config (or a
 * typed per-capability read error). Behaviour (FR-004/FR-008):
 *  - `transport("/state")` is called once.
 *  - status 503 => `{ ok:false, reason:"state_unavailable" }` (state subsystem down).
 *  - any other non-200 => `{ ok:false, reason:"unexpected_status", status }`.
 *  - a transport that throws/rejects => `{ ok:false, reason:"transport_error" }`.
 *  - on 200: `safeNormalize` the body (rejects accessors / proxies / exotic shapes /
 *    bare scalars), require the exact `{ capabilities: {...} }` envelope (no unknown
 *    keys, capabilities must be a plain object). For each capability entry: an entry
 *    shaped `{ error: ... }` is recorded in `errors[name]`; any other entry's
 *    normalized plain-data config is carried in `configs[name]`. This client does
 *    NOT know each capability's schema and NEVER executes a method off a config value
 *    — it returns the per-capability JSON as normalized plain data.
 *
 * Never throws.
 */
export async function fetchNodeSnapshot(
  transport: SnapshotTransport,
): Promise<FetchNodeSnapshotResult> {
  let response: SnapshotTransportResponse;

  try {
    response = await transport(STATE_PATH);
  } catch {
    return {
      ok: false,
      reason: "transport_error",
    };
  }

  try {
    return evaluateResponse(response);
  } catch {
    // A throw anywhere in validation is a fail-closed rejection, never a crash.
    return {
      ok: false,
      reason: "invalid_response",
      rejections: [
        {
          path: "",
          message: "Snapshot response could not be processed safely.",
        },
      ],
    };
  }
}

function evaluateResponse(
  response: SnapshotTransportResponse,
): FetchNodeSnapshotResult {
  const status = readStatus(response);

  if (status === undefined) {
    return {
      ok: false,
      reason: "invalid_response",
      rejections: [
        {
          path: "status",
          message: "Transport response status must be a finite integer.",
        },
      ],
    };
  }

  if (status === 503) {
    return {
      ok: false,
      reason: "state_unavailable",
      status,
    };
  }

  if (status !== 200) {
    return {
      ok: false,
      reason: "unexpected_status",
      status,
    };
  }

  return parseSnapshotBody(response.body);
}

function parseSnapshotBody(body: unknown): FetchNodeSnapshotResult {
  const normalized = safeNormalize(body);

  if (!normalized.ok) {
    return invalidResponse("", `Invalid snapshot response body: ${normalized.reason}`);
  }

  if (!isPlainObject(normalized.value)) {
    return invalidResponse("", "Snapshot response body must be an object.");
  }

  const envelope = normalized.value;
  const rejections: NodeSnapshotRejection[] = [];

  rejectUnknownEnvelopeFields(envelope, rejections);

  const capabilities = readEnvelopeCapabilities(envelope, rejections);

  if (rejections.length > 0 || capabilities === undefined) {
    return {
      ok: false,
      reason: "invalid_response",
      rejections: Object.freeze(rejections),
    };
  }

  return classifyCapabilities(capabilities);
}

function classifyCapabilities(
  capabilities: PlainJsonObject,
): FetchNodeSnapshotResult {
  const configs: Record<string, PlainJson> = {};
  const errors: Record<string, CapabilityReadError> = {};
  // `capabilities` is already normalized plain data (no accessors survive
  // safeNormalize), so reading entries here never invokes a getter.
  const names = Object.keys(capabilities).sort(compareStrings);

  for (let index = 0; index < names.length; index += 1) {
    const name = names[index];

    if (name === undefined) {
      continue;
    }

    const entry = capabilities[name];

    if (entry === undefined) {
      continue;
    }

    if (isCapabilityError(entry)) {
      // A `{ error: ... }` entry is a per-capability read failure. The error
      // payload is plain data; we never interpret or execute anything off it.
      // `error` is the sole own key (verified above), so it is present.
      const errorPayload = entry["error"] ?? null;
      defineEntry(errors, name, { error: errorPayload });
      continue;
    }

    // Otherwise carry the config through as normalized plain data. The client
    // does not validate per-capability schema and NEVER calls a method off it.
    defineEntry(configs, name, entry);
  }

  return {
    ok: true,
    configs: Object.freeze(configs),
    errors: Object.freeze(errors),
    capabilityNames: Object.freeze(names),
  };
}

function readEnvelopeCapabilities(
  envelope: PlainJsonObject,
  rejections: NodeSnapshotRejection[],
): PlainJsonObject | undefined {
  if (!Object.hasOwn(envelope, "capabilities")) {
    rejections[rejections.length] = {
      path: "capabilities",
      message: "Snapshot response is missing the capabilities map.",
    };
    return undefined;
  }

  const capabilities = envelope["capabilities"];

  if (!isPlainObject(capabilities)) {
    rejections[rejections.length] = {
      path: "capabilities",
      message: "Snapshot response capabilities must be an object.",
    };
    return undefined;
  }

  return capabilities;
}

function rejectUnknownEnvelopeFields(
  envelope: PlainJsonObject,
  rejections: NodeSnapshotRejection[],
): void {
  const keys = Object.keys(envelope).sort(compareStrings);

  for (let index = 0; index < keys.length; index += 1) {
    const key = keys[index];

    if (key !== undefined && !ENVELOPE_FIELDS.has(key)) {
      rejections[rejections.length] = {
        path: escapePathToken(key),
        message: "Unknown snapshot response field.",
      };
    }
  }
}

/**
 * An entry is a per-capability read error iff it is a plain object whose ONLY
 * own key is `error`. Anything else is treated as a config value. Because the
 * entry is already normalized plain data, every read below is data-only.
 */
function isCapabilityError(entry: PlainJson | undefined): entry is PlainJsonObject {
  if (!isPlainObject(entry)) {
    return false;
  }

  const keys = Object.keys(entry);

  return keys.length === 1 && keys[0] === "error";
}

function readStatus(response: SnapshotTransportResponse): number | undefined {
  const status = response.status;

  if (typeof status !== "number" || !Number.isSafeInteger(status)) {
    return undefined;
  }

  return status;
}

function invalidResponse(path: string, message: string): FetchNodeSnapshotResult {
  return {
    ok: false,
    reason: "invalid_response",
    rejections: [
      {
        path,
        message,
      },
    ],
  };
}

function defineEntry<T>(
  target: Record<string, T>,
  key: string,
  value: T,
): void {
  Object.defineProperty(target, key, {
    configurable: true,
    enumerable: true,
    value,
    writable: true,
  });
}

function isPlainObject(value: PlainJson | undefined): value is PlainJsonObject {
  return (
    value !== undefined &&
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value)
  );
}

function escapePathToken(token: string): string {
  return token.replaceAll("~", "~0").replaceAll("/", "~1");
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
