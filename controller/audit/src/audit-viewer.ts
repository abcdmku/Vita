import { types as nodeTypes } from "node:util";

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

export type AuditLogSummaryRejectionCode =
  | "INVALID_AUDIT_LOG"
  | "INVALID_AUDIT_EVENT"
  | "INVALID_RECENT_FAILURE_LIMIT"
  | "SUMMARY_FAILED";

export interface AuditLogSummaryRejection {
  readonly code: AuditLogSummaryRejectionCode;
  readonly path: string;
  readonly message: string;
}

export interface AuditOutcomeTotals {
  readonly committed: number;
  readonly rejected: number;
  readonly rolled_back: number;
  readonly failed: number;
}

export interface AuditActorTotals {
  readonly human: number;
  readonly agent: number;
  readonly system: number;
}

export interface AuditLogSummaryOptions {
  readonly recentFailureLimit?: number;
}

export type AuditLogSummaryResult =
  | {
      readonly ok: true;
      readonly monotonic: boolean;
      readonly totalsByOutcome: AuditOutcomeTotals;
      readonly totalsByActor: AuditActorTotals;
      readonly recentFailures: readonly AuditEvent[];
    }
  | {
      readonly ok: false;
      readonly rejections: readonly AuditLogSummaryRejection[];
    };

type EventValidationResult =
  | {
      readonly ok: true;
      readonly events: readonly AuditEvent[];
    }
  | {
      readonly ok: false;
      readonly rejections: readonly AuditLogSummaryRejection[];
    };

type EventInputSnapshotResult =
  | {
      readonly ok: true;
      readonly values: readonly unknown[];
    }
  | {
      readonly ok: false;
      readonly rejections: readonly AuditLogSummaryRejection[];
    };

type OptionsValidationResult =
  | {
      readonly ok: true;
      readonly recentFailureLimit: number;
    }
  | {
      readonly ok: false;
      readonly rejections: readonly AuditLogSummaryRejection[];
    };

export const DEFAULT_RECENT_FAILURE_LIMIT = 10;

const MAX_AUDIT_EVENTS = 100_000;

export function summarizeAuditLog(
  events: unknown,
  options?: unknown,
): AuditLogSummaryResult {
  try {
    const optionResult = validateOptions(options);

    if (!optionResult.ok) {
      return reject(optionResult.rejections);
    }

    const eventResult = validateEvents(events);

    if (!eventResult.ok) {
      return reject(eventResult.rejections);
    }

    return summarizeValidatedEvents(
      eventResult.events,
      optionResult.recentFailureLimit,
    );
  } catch {
    return reject([
      {
        code: "SUMMARY_FAILED",
        message: "Audit log summary failed.",
        path: "",
      },
    ]);
  }
}

function validateEvents(input: unknown): EventValidationResult {
  const snapshot = snapshotEventInputs(input);

  if (!snapshot.ok) {
    return rejectEvents(snapshot.rejections);
  }

  const rejections: AuditLogSummaryRejection[] = [];
  const events: AuditEvent[] = [];

  for (let index = 0; index < snapshot.values.length; index += 1) {
    const rawEvent = snapshot.values[index];
    const result = validateAuditEvent(rawEvent);

    if (!result.ok) {
      appendEventValidationRejections(rejections, index, result.errors);
      continue;
    }

    events[events.length] = result.event;
  }

  if (rejections.length > 0) {
    return rejectEvents(rejections);
  }

  return {
    events: Object.freeze(events),
    ok: true,
  };
}

function snapshotEventInputs(input: unknown): EventInputSnapshotResult {
  try {
    if (input === null || typeof input !== "object") {
      return rejectEventInputs([
        {
          code: "INVALID_AUDIT_LOG",
          message: "Expected audit log events array.",
          path: "events",
        },
      ]);
    }

    if (nodeTypes.isProxy(input)) {
      return rejectEventInputs([
        {
          code: "INVALID_AUDIT_LOG",
          message: "Proxy audit log arrays are not accepted.",
          path: "events",
        },
      ]);
    }

    if (!Array.isArray(input)) {
      return rejectEventInputs([
        {
          code: "INVALID_AUDIT_LOG",
          message: "Expected audit log events array.",
          path: "events",
        },
      ]);
    }

    if (Object.getPrototypeOf(input) !== Array.prototype) {
      return rejectEventInputs([
        {
          code: "INVALID_AUDIT_LOG",
          message: "Expected plain audit log events array.",
          path: "events",
        },
      ]);
    }

    const lengthDescriptor = Object.getOwnPropertyDescriptor(input, "length");

    if (
      !isDataDescriptor(lengthDescriptor) ||
      !isAllowedArrayLength(lengthDescriptor.value)
    ) {
      return rejectEventInputs([
        {
          code: "INVALID_AUDIT_LOG",
          message: "Expected dense audit log events array.",
          path: "events",
        },
      ]);
    }

    const length = lengthDescriptor.value;

    if (length > MAX_AUDIT_EVENTS) {
      return rejectEventInputs([
        {
          code: "INVALID_AUDIT_LOG",
          message: "Audit log event count exceeds the supported limit.",
          path: "events",
        },
      ]);
    }

    const keyRejection = validateArrayOwnKeys(input, length);

    if (keyRejection !== undefined) {
      return rejectEventInputs([keyRejection]);
    }

    const values: unknown[] = [];
    const rejections: AuditLogSummaryRejection[] = [];

    for (let index = 0; index < length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(input, String(index));

      if (!isDataDescriptor(descriptor) || descriptor.enumerable !== true) {
        rejections[rejections.length] = {
          code: "INVALID_AUDIT_EVENT",
          message: "Audit event must be a dense data element.",
          path: `events/${index}`,
        };
        continue;
      }

      values[index] = descriptor.value;
    }

    if (rejections.length > 0) {
      return rejectEventInputs(rejections);
    }

    return {
      ok: true,
      values: Object.freeze(values),
    };
  } catch {
    return rejectEventInputs([
      {
        code: "INVALID_AUDIT_LOG",
        message: "Audit log input could not be read safely.",
        path: "events",
      },
    ]);
  }
}

function validateOptions(input: unknown): OptionsValidationResult {
  if (input === undefined) {
    return {
      ok: true,
      recentFailureLimit: DEFAULT_RECENT_FAILURE_LIMIT,
    };
  }

  if (typeof input === "number") {
    return validateRecentFailureLimit(input, "recentFailureLimit");
  }

  const normalized = safeNormalize(input);

  if (!normalized.ok) {
    return rejectOptions([
      {
        code: "INVALID_RECENT_FAILURE_LIMIT",
        message: `Invalid options input: ${normalized.reason}`,
        path: "options",
      },
    ]);
  }

  if (!isPlainObject(normalized.value)) {
    return rejectOptions([
      {
        code: "INVALID_RECENT_FAILURE_LIMIT",
        message: "Expected audit summary options object.",
        path: "options",
      },
    ]);
  }

  const rejections: AuditLogSummaryRejection[] = [];
  const keys = Object.keys(normalized.value).sort(compareStrings);

  for (let index = 0; index < keys.length; index += 1) {
    const key = keys[index];

    if (key !== undefined && key !== "recentFailureLimit") {
      rejections[rejections.length] = {
        code: "INVALID_RECENT_FAILURE_LIMIT",
        message: "Unknown audit summary option.",
        path: `options/${escapePathToken(key)}`,
      };
    }
  }

  if (!Object.hasOwn(normalized.value, "recentFailureLimit")) {
    if (rejections.length > 0) {
      return rejectOptions(rejections);
    }

    return {
      ok: true,
      recentFailureLimit: DEFAULT_RECENT_FAILURE_LIMIT,
    };
  }

  const limitResult = validateRecentFailureLimit(
    normalized.value["recentFailureLimit"],
    "options/recentFailureLimit",
  );

  if (!limitResult.ok) {
    appendRejections(rejections, limitResult.rejections);
  }

  if (rejections.length > 0) {
    return rejectOptions(rejections);
  }

  return limitResult;
}

function validateRecentFailureLimit(
  value: PlainJson | undefined,
  path: string,
): OptionsValidationResult {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    return rejectOptions([
      {
        code: "INVALID_RECENT_FAILURE_LIMIT",
        message: "Expected non-negative integer recent failure limit.",
        path,
      },
    ]);
  }

  return {
    ok: true,
    recentFailureLimit: value,
  };
}

function summarizeValidatedEvents(
  events: readonly AuditEvent[],
  recentFailureLimit: number,
): Extract<AuditLogSummaryResult, { readonly ok: true }> {
  const totalsByOutcome: AuditOutcomeTotals = {
    committed: 0,
    failed: 0,
    rejected: 0,
    rolled_back: 0,
  };
  const totalsByActor: AuditActorTotals = {
    agent: 0,
    human: 0,
    system: 0,
  };

  for (let index = 0; index < events.length; index += 1) {
    const event = events[index];

    if (event === undefined) {
      continue;
    }

    incrementOutcome(totalsByOutcome, event.outcome);
    incrementActor(totalsByActor, event.actor.kind);
  }

  return Object.freeze({
    monotonic: isMonotonic(events),
    ok: true,
    recentFailures: collectRecentFailures(events, recentFailureLimit),
    totalsByActor: Object.freeze(totalsByActor),
    totalsByOutcome: Object.freeze(totalsByOutcome),
  });
}

function collectRecentFailures(
  events: readonly AuditEvent[],
  limit: number,
): readonly AuditEvent[] {
  const recentFailures: AuditEvent[] = [];

  for (
    let index = events.length - 1;
    index >= 0 && recentFailures.length < limit;
    index -= 1
  ) {
    const event = events[index];

    if (event !== undefined && isFailureOutcome(event.outcome)) {
      recentFailures[recentFailures.length] = event;
    }
  }

  return Object.freeze(recentFailures);
}

function incrementOutcome(
  totals: {
    committed: number;
    rejected: number;
    rolled_back: number;
    failed: number;
  },
  outcome: AuditEvent["outcome"],
): void {
  switch (outcome) {
    case "committed":
      totals.committed += 1;
      return;
    case "failed":
      totals.failed += 1;
      return;
    case "rejected":
      totals.rejected += 1;
      return;
    case "rolled_back":
      totals.rolled_back += 1;
      return;
  }
}

function incrementActor(
  totals: {
    human: number;
    agent: number;
    system: number;
  },
  actor: AuditEvent["actor"]["kind"],
): void {
  switch (actor) {
    case "agent":
      totals.agent += 1;
      return;
    case "human":
      totals.human += 1;
      return;
    case "system":
      totals.system += 1;
      return;
  }
}

function isFailureOutcome(outcome: AuditEvent["outcome"]): boolean {
  return outcome === "failed" || outcome === "rolled_back";
}

function appendEventValidationRejections(
  rejections: AuditLogSummaryRejection[],
  index: number,
  errors: readonly AuditEventValidationError[],
): void {
  for (let errorIndex = 0; errorIndex < errors.length; errorIndex += 1) {
    const error = errors[errorIndex];

    if (error === undefined) {
      continue;
    }

    rejections[rejections.length] = {
      code: "INVALID_AUDIT_EVENT",
      message: error.message,
      path: eventErrorPath(index, error.path),
    };
  }
}

function appendRejections(
  rejections: AuditLogSummaryRejection[],
  additions: readonly AuditLogSummaryRejection[],
): void {
  for (let index = 0; index < additions.length; index += 1) {
    const rejection = additions[index];

    if (rejection !== undefined) {
      rejections[rejections.length] = rejection;
    }
  }
}

function eventErrorPath(index: number, path: string): string {
  const prefix = `events/${index}`;

  return path === "" ? prefix : `${prefix}/${path}`;
}

function isPlainObject(value: PlainJson): value is PlainJsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function validateArrayOwnKeys(
  value: readonly unknown[],
  length: number,
): AuditLogSummaryRejection | undefined {
  const keys = Reflect.ownKeys(value);

  if (keys.length !== length + 1) {
    return {
      code: "INVALID_AUDIT_LOG",
      message: "Audit log array must contain only dense indexed events.",
      path: "events",
    };
  }

  for (let index = 0; index < keys.length; index += 1) {
    const key = keys[index];

    if (key === undefined || !isAllowedArrayOwnKey(key, length)) {
      return {
        code: "INVALID_AUDIT_LOG",
        message: "Audit log array must contain only dense indexed events.",
        path: "events",
      };
    }
  }

  return undefined;
}

function isAllowedArrayOwnKey(key: string | symbol, length: number): boolean {
  if (typeof key === "symbol") {
    return false;
  }

  if (key === "length") {
    return true;
  }

  const index = Number(key);

  return (
    Number.isInteger(index) &&
    index >= 0 &&
    index < length &&
    String(index) === key
  );
}

function isAllowedArrayLength(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isDataDescriptor(
  descriptor: PropertyDescriptor | undefined,
): descriptor is PropertyDescriptor & { readonly value: unknown } {
  return descriptor !== undefined && Object.hasOwn(descriptor, "value");
}

function reject(
  rejections: readonly AuditLogSummaryRejection[],
): Extract<AuditLogSummaryResult, { readonly ok: false }> {
  return {
    ok: false,
    rejections: Object.freeze([...rejections]),
  };
}

function rejectEvents(
  rejections: readonly AuditLogSummaryRejection[],
): Extract<EventValidationResult, { readonly ok: false }> {
  return {
    ok: false,
    rejections: Object.freeze([...rejections]),
  };
}

function rejectEventInputs(
  rejections: readonly AuditLogSummaryRejection[],
): Extract<EventInputSnapshotResult, { readonly ok: false }> {
  return {
    ok: false,
    rejections: Object.freeze([...rejections]),
  };
}

function rejectOptions(
  rejections: readonly AuditLogSummaryRejection[],
): Extract<OptionsValidationResult, { readonly ok: false }> {
  return {
    ok: false,
    rejections: Object.freeze([...rejections]),
  };
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
