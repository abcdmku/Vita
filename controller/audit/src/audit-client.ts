import {
  isMonotonic,
  validateAuditEvent,
} from "../../../sdk/typescript/src/audit-event-model.ts";
import { safeNormalize } from "../../../sdk/typescript/src/safe-normalize.ts";
import type {
  AuditEvent,
  AuditEventValidationError,
} from "../../../sdk/typescript/src/audit-event-model.ts";
import type {
  PlainJson,
  PlainJsonObject,
} from "../../../sdk/typescript/src/safe-normalize.ts";

/**
 * Injected HTTP transport. A function `(path) => Promise<{ status, body }>` that
 * abstracts the wire (mirrors the controller/api P2-006 pattern — no real socket
 * is opened here; tests inject a fake). `body` is `unknown` and untrusted: it is
 * `safeNormalize`d before any field is read.
 */
export type AuditTransport = (
  path: string,
) => Promise<AuditTransportResponse>;

export interface AuditTransportResponse {
  readonly status: number;
  readonly body: unknown;
}

export type AuditTrailRejectionReason =
  | "audit_unavailable"
  | "transport_error"
  | "unexpected_status"
  | "invalid_response"
  | "invalid_event";

export interface AuditTrailRejection {
  readonly path: string;
  readonly message: string;
}

export type FetchAuditTrailResult =
  | {
      readonly ok: true;
      readonly events: readonly AuditEvent[];
      readonly tampered: boolean;
    }
  | {
      readonly ok: false;
      readonly reason: AuditTrailRejectionReason;
      readonly status?: number;
      readonly rejections?: readonly AuditTrailRejection[];
    };

const AUDIT_PATH = "/audit";
const AUDIT_ENVELOPE_FIELDS = new Set(["events"]);
const MAX_AUDIT_EVENTS = 100_000;

/**
 * Fetch the agent's tamper-evident audit trail via the injected transport,
 * validate it fail-closed, and return a result shaped to feed `summarizeAuditLog`
 * (P2-021). Behaviour (FR-008/FR-017):
 *  - `transport("/audit")` is called once.
 *  - status 503 => `{ ok:false, reason:"audit_unavailable" }` (audit subsystem down).
 *  - any other non-200 => `{ ok:false, reason:"unexpected_status", status }`.
 *  - a transport that throws/rejects => `{ ok:false, reason:"transport_error" }`.
 *  - on 200: `safeNormalize` the body (rejects accessors / proxies / exotic shapes /
 *    bare scalars), require the exact `{ events: [...] }` envelope (no unknown keys),
 *    validate EVERY event via `validateAuditEvent` — any invalid event fails the whole
 *    trail (no partial trail). Check `isMonotonic`; if not monotonic the events are
 *    STILL returned, but flagged `tampered:true` (never silently reordered).
 *
 * Never throws.
 */
export async function fetchAuditTrail(
  transport: AuditTransport,
): Promise<FetchAuditTrailResult> {
  let response: AuditTransportResponse;

  try {
    response = await transport(AUDIT_PATH);
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
          message: "Audit response could not be processed safely.",
        },
      ],
    };
  }
}

function evaluateResponse(
  response: AuditTransportResponse,
): FetchAuditTrailResult {
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
      reason: "audit_unavailable",
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

  return parseAuditBody(readBody(response));
}

function parseAuditBody(body: unknown): FetchAuditTrailResult {
  const normalized = safeNormalize(body);

  if (!normalized.ok) {
    return {
      ok: false,
      reason: "invalid_response",
      rejections: [
        {
          path: "",
          message: `Invalid audit response body: ${normalized.reason}`,
        },
      ],
    };
  }

  if (!isPlainObject(normalized.value)) {
    return {
      ok: false,
      reason: "invalid_response",
      rejections: [
        {
          path: "",
          message: "Audit response body must be an object.",
        },
      ],
    };
  }

  const envelope = normalized.value;
  const rejections: AuditTrailRejection[] = [];

  rejectUnknownEnvelopeFields(envelope, rejections);

  const rawEvents = readEnvelopeEvents(envelope, rejections);

  if (rejections.length > 0 || rawEvents === undefined) {
    return {
      ok: false,
      reason: "invalid_response",
      rejections: Object.freeze(rejections),
    };
  }

  if (rawEvents.length > MAX_AUDIT_EVENTS) {
    return {
      ok: false,
      reason: "invalid_response",
      rejections: [
        {
          path: "events",
          message: "Audit event count exceeds the supported limit.",
        },
      ],
    };
  }

  return validateEvents(rawEvents);
}

function validateEvents(
  rawEvents: readonly PlainJson[],
): FetchAuditTrailResult {
  const events: AuditEvent[] = [];
  const rejections: AuditTrailRejection[] = [];

  for (let index = 0; index < rawEvents.length; index += 1) {
    const result = validateAuditEvent(rawEvents[index]);

    if (!result.ok) {
      appendEventRejections(rejections, index, result.errors);
      continue;
    }

    events[events.length] = result.event;
  }

  // Fail-closed: any invalid event rejects the whole trail (no partial trail).
  if (rejections.length > 0) {
    return {
      ok: false,
      reason: "invalid_event",
      rejections: Object.freeze(rejections),
    };
  }

  const frozenEvents = Object.freeze(events);

  // Tamper-evidence: surface non-monotonic ordering but NEVER reorder.
  return {
    ok: true,
    events: frozenEvents,
    tampered: !isMonotonic(frozenEvents),
  };
}

function readEnvelopeEvents(
  envelope: PlainJsonObject,
  rejections: AuditTrailRejection[],
): readonly PlainJson[] | undefined {
  if (!Object.hasOwn(envelope, "events")) {
    rejections[rejections.length] = {
      path: "events",
      message: "Audit response is missing the events array.",
    };
    return undefined;
  }

  const events = envelope["events"];

  if (!Array.isArray(events)) {
    rejections[rejections.length] = {
      path: "events",
      message: "Audit response events must be an array.",
    };
    return undefined;
  }

  return events;
}

function rejectUnknownEnvelopeFields(
  envelope: PlainJsonObject,
  rejections: AuditTrailRejection[],
): void {
  const keys = Object.keys(envelope).sort(compareStrings);

  for (let index = 0; index < keys.length; index += 1) {
    const key = keys[index];

    if (key !== undefined && !AUDIT_ENVELOPE_FIELDS.has(key)) {
      rejections[rejections.length] = {
        path: escapePathToken(key),
        message: "Unknown audit response field.",
      };
    }
  }
}

function appendEventRejections(
  rejections: AuditTrailRejection[],
  index: number,
  errors: readonly AuditEventValidationError[],
): void {
  for (let errorIndex = 0; errorIndex < errors.length; errorIndex += 1) {
    const error = errors[errorIndex];

    if (error === undefined) {
      continue;
    }

    rejections[rejections.length] = {
      path: eventErrorPath(index, error.path),
      message: error.message,
    };
  }
}

function readStatus(response: AuditTransportResponse): number | undefined {
  const status = response.status;

  if (
    typeof status !== "number" ||
    !Number.isSafeInteger(status)
  ) {
    return undefined;
  }

  return status;
}

function readBody(response: AuditTransportResponse): unknown {
  return response.body;
}

function eventErrorPath(index: number, path: string): string {
  const prefix = `events/${index}`;

  return path === "" ? prefix : `${prefix}/${path}`;
}

function isPlainObject(value: PlainJson): value is PlainJsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
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
