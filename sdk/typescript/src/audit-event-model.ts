import { safeNormalize } from "./safe-normalize.ts";
import type { PlainJson, PlainJsonObject } from "./safe-normalize.ts";

export type AuditActorKind = "human" | "agent" | "system";
export type AuditOperation = "apply" | "read";
export type AuditOutcome = "committed" | "rejected" | "rolled_back" | "failed";

export interface AuditActorRef {
  readonly kind: AuditActorKind;
  readonly id: string;
}

export interface AuditEvent {
  readonly sequence: number;
  readonly timestampMillis: number;
  readonly actor: AuditActorRef;
  readonly capability: string;
  readonly operation: AuditOperation;
  readonly outcome: AuditOutcome;
  readonly reason?: string;
}

export interface ValidationError {
  readonly path: string;
  readonly message: string;
}

export type AuditEventValidationError = ValidationError;

export type AuditEventValidationResult =
  | {
      readonly ok: true;
      readonly event: AuditEvent;
      readonly value: AuditEvent;
    }
  | {
      readonly ok: false;
      readonly errors: readonly ValidationError[];
    };

export type Result = AuditEventValidationResult;

type JsonRecord = PlainJsonObject;
type Path = readonly string[];

const AUDIT_EVENT_FIELDS = new Set([
  "actor",
  "capability",
  "operation",
  "outcome",
  "reason",
  "sequence",
  "timestampMillis",
]);
const ACTOR_FIELDS = new Set(["id", "kind"]);

const MAX_CAPABILITY_NAME_LENGTH = 128;
const MAX_REASON_LENGTH = 512;

const CAPABILITY_NAME_PATTERN =
  /^[A-Za-z0-9](?:[A-Za-z0-9]|[._:@-](?=[A-Za-z0-9])){0,127}$/u;
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f]/u;
const DATA_URL_PATTERN = /\bdata:/iu;
const PEM_BLOCK_PATTERN = /-----BEGIN\b/iu;
const PRIVATE_KEY_PATTERN =
  /\b(?:private[-_\s]?key|openssh\s+private\s+key|age-secret-key|xprv|seed[-_\s]?phrase|mnemonic|recovery[-_\s]?phrase)\b/iu;
const SECRET_ASSIGNMENT_PATTERN =
  /\b(?:private[-_\s]?key|api[-_\s]?key|access[-_\s]?token|refresh[-_\s]?token|password|secret)\s*(?:=|:(?!\/\/))/iu;
const SEED_WORDS_PATTERN = /\b[a-z]{3,12}(?:\s+[a-z]{3,12}){11,23}\b/iu;
const LONG_HEX_PATTERN = /(?:0x)?[A-Fa-f0-9]{32,}/u;
const LONG_BASE64_PATTERN = /[A-Za-z0-9+/]{48,}={0,2}|[A-Za-z0-9_-]{48,}/u;

const SECRET_FIELD_NAMES = new Set([
  "apikey",
  "accesstoken",
  "credential",
  "key",
  "keymaterial",
  "mnemonic",
  "passphrase",
  "password",
  "privatekey",
  "recoverykey",
  "refreshtoken",
  "secret",
  "seed",
  "seedphrase",
  "token",
]);

export function validateAuditEvent(input: unknown): AuditEventValidationResult {
  try {
    const normalized = safeNormalize(input);

    if (!normalized.ok) {
      return reject([
        {
          path: "",
          message: `Invalid untrusted input: ${normalized.reason}`,
        },
      ]);
    }

    const errors: ValidationError[] = [];

    rejectInlineKeyMaterial(normalized.value, [], errors);

    const event = parseAuditEvent(normalized.value, [], errors);

    if (event === undefined || errors.length > 0) {
      return reject(errors);
    }

    return {
      ok: true,
      event,
      value: event,
    };
  } catch {
    return reject([{ path: "", message: "Audit event validation failed." }]);
  }
}

export function isMonotonic(events: readonly { readonly sequence: number }[]): boolean {
  let previous: number | undefined;

  for (let index = 0; index < events.length; index += 1) {
    const event = events[index];

    if (event === undefined || !isNonNegativeInteger(event.sequence)) {
      return false;
    }

    if (previous !== undefined && event.sequence <= previous) {
      return false;
    }

    previous = event.sequence;
  }

  return true;
}

function parseAuditEvent(
  value: PlainJson,
  path: Path,
  errors: ValidationError[],
): AuditEvent | undefined {
  if (!isRecord(value)) {
    addError(errors, path, "Expected audit event object.");
    return undefined;
  }

  const errorStart = errors.length;

  rejectUnknownFields(value, AUDIT_EVENT_FIELDS, path, errors);

  const sequence = readRequiredInteger(value, "sequence", [...path, "sequence"], errors);
  const timestampMillis = readRequiredInteger(
    value,
    "timestampMillis",
    [...path, "timestampMillis"],
    errors,
  );
  const actor = readRequiredActor(value, "actor", [...path, "actor"], errors);
  const capability = readRequiredCapability(value, "capability", [...path, "capability"], errors);
  const operation = readRequiredOperation(value, "operation", [...path, "operation"], errors);
  const outcome = readRequiredOutcome(value, "outcome", [...path, "outcome"], errors);
  const reason = readOptionalReason(value, "reason", [...path, "reason"], errors);

  if (
    errors.length > errorStart ||
    sequence === undefined ||
    timestampMillis === undefined ||
    actor === undefined ||
    capability === undefined ||
    operation === undefined ||
    outcome === undefined
  ) {
    return undefined;
  }

  return Object.freeze({
    actor,
    capability,
    operation,
    outcome,
    ...(reason === undefined ? {} : { reason }),
    sequence,
    timestampMillis,
  });
}

function parseActor(
  value: PlainJson,
  path: Path,
  errors: ValidationError[],
): AuditActorRef | undefined {
  if (!isRecord(value)) {
    addError(errors, path, "Expected actor reference object.");
    return undefined;
  }

  const errorStart = errors.length;

  rejectUnknownFields(value, ACTOR_FIELDS, path, errors);

  const kind = readRequiredActorKind(value, "kind", [...path, "kind"], errors);
  const id = readRequiredActorId(value, "id", [...path, "id"], errors);

  if (errors.length > errorStart || kind === undefined || id === undefined) {
    return undefined;
  }

  return Object.freeze({
    id,
    kind,
  });
}

function readRequiredActor(
  value: JsonRecord,
  key: string,
  path: Path,
  errors: ValidationError[],
): AuditActorRef | undefined {
  const child = readRequiredProperty(value, key, path, errors);

  if (child === undefined) {
    return undefined;
  }

  return parseActor(child, path, errors);
}

function readRequiredActorKind(
  value: JsonRecord,
  key: string,
  path: Path,
  errors: ValidationError[],
): AuditActorKind | undefined {
  const child = readRequiredProperty(value, key, path, errors);

  if (child === undefined) {
    return undefined;
  }

  if (!isActorKind(child)) {
    addError(errors, path, "Expected actor kind human, agent, or system.");
    return undefined;
  }

  return child;
}

function readRequiredActorId(
  value: JsonRecord,
  key: string,
  path: Path,
  errors: ValidationError[],
): string | undefined {
  const child = readRequiredString(value, key, path, errors);

  if (child === undefined) {
    return undefined;
  }

  if (child.length === 0 || child !== child.trim()) {
    addError(errors, path, "Expected non-empty actor id string.");
    return undefined;
  }

  return child;
}

function readRequiredCapability(
  value: JsonRecord,
  key: string,
  path: Path,
  errors: ValidationError[],
): string | undefined {
  const child = readRequiredString(value, key, path, errors);

  if (child === undefined) {
    return undefined;
  }

  if (!isCapabilityName(child)) {
    addError(errors, path, "Expected well-formed capability name.");
    return undefined;
  }

  return child;
}

function readRequiredOperation(
  value: JsonRecord,
  key: string,
  path: Path,
  errors: ValidationError[],
): AuditOperation | undefined {
  const child = readRequiredProperty(value, key, path, errors);

  if (child === undefined) {
    return undefined;
  }

  if (!isAuditOperation(child)) {
    addError(errors, path, "Expected operation apply or read.");
    return undefined;
  }

  return child;
}

function readRequiredOutcome(
  value: JsonRecord,
  key: string,
  path: Path,
  errors: ValidationError[],
): AuditOutcome | undefined {
  const child = readRequiredProperty(value, key, path, errors);

  if (child === undefined) {
    return undefined;
  }

  if (!isAuditOutcome(child)) {
    addError(errors, path, "Expected supported audit outcome.");
    return undefined;
  }

  return child;
}

function readRequiredInteger(
  value: JsonRecord,
  key: string,
  path: Path,
  errors: ValidationError[],
): number | undefined {
  const child = readRequiredProperty(value, key, path, errors);

  if (child === undefined) {
    return undefined;
  }

  if (!isNonNegativeInteger(child)) {
    addError(errors, path, "Expected non-negative integer.");
    return undefined;
  }

  return child;
}

function readRequiredString(
  value: JsonRecord,
  key: string,
  path: Path,
  errors: ValidationError[],
): string | undefined {
  const child = readRequiredProperty(value, key, path, errors);

  if (child === undefined) {
    return undefined;
  }

  if (typeof child !== "string") {
    addError(errors, path, "Expected string.");
    return undefined;
  }

  return child;
}

function readOptionalReason(
  value: JsonRecord,
  key: string,
  path: Path,
  errors: ValidationError[],
): string | undefined {
  if (!hasOwn(value, key)) {
    return undefined;
  }

  const child = value[key];

  if (typeof child !== "string" || child.length > MAX_REASON_LENGTH) {
    addError(errors, path, "Expected short reason string.");
    return undefined;
  }

  return child;
}

function readRequiredProperty(
  value: JsonRecord,
  key: string,
  path: Path,
  errors: ValidationError[],
): PlainJson | undefined {
  if (!hasOwn(value, key)) {
    addError(errors, path, "Required field is missing.");
    return undefined;
  }

  const child = value[key];

  if (child === undefined) {
    addError(errors, path, "Required field is missing.");
    return undefined;
  }

  return child;
}

function rejectInlineKeyMaterial(
  value: PlainJson,
  path: Path,
  errors: ValidationError[],
): void {
  if (typeof value === "string") {
    if (containsInlineKeyMaterial(value)) {
      addError(errors, path, "Inline key material is not allowed.");
    }

    return;
  }

  if (value === null || typeof value !== "object") {
    return;
  }

  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      const item = value[index];

      if (item !== undefined) {
        rejectInlineKeyMaterial(item, [...path, String(index)], errors);
      }
    }

    return;
  }

  if (!isRecord(value)) {
    return;
  }

  const keys = Object.keys(value).sort(compareStrings);

  for (let index = 0; index < keys.length; index += 1) {
    const key = keys[index];

    if (key === undefined) {
      continue;
    }

    if (isSecretFieldName(key)) {
      addError(errors, [...path, key], "Inline key material is not allowed.");
    }

    const child = value[key];

    if (child !== undefined) {
      rejectInlineKeyMaterial(child, [...path, key], errors);
    }
  }
}

function rejectUnknownFields(
  value: JsonRecord,
  allowed: ReadonlySet<string>,
  path: Path,
  errors: ValidationError[],
): void {
  const keys = Object.keys(value).sort(compareStrings);

  for (let index = 0; index < keys.length; index += 1) {
    const key = keys[index];

    if (key !== undefined && !allowed.has(key)) {
      addError(errors, [...path, key], "Unknown field.");
    }
  }
}

function containsInlineKeyMaterial(value: string): boolean {
  if (
    CONTROL_CHARACTER_PATTERN.test(value) ||
    DATA_URL_PATTERN.test(value) ||
    PEM_BLOCK_PATTERN.test(value) ||
    PRIVATE_KEY_PATTERN.test(value) ||
    SECRET_ASSIGNMENT_PATTERN.test(value) ||
    SEED_WORDS_PATTERN.test(value)
  ) {
    return true;
  }

  return LONG_HEX_PATTERN.test(value) || LONG_BASE64_PATTERN.test(value);
}

function isSecretFieldName(value: string): boolean {
  return SECRET_FIELD_NAMES.has(value.replace(/[-_\s]/gu, "").toLowerCase());
}

function isCapabilityName(value: string): boolean {
  return (
    value.length > 0 &&
    value.length <= MAX_CAPABILITY_NAME_LENGTH &&
    value === value.trim() &&
    CAPABILITY_NAME_PATTERN.test(value) &&
    !containsInlineKeyMaterial(value)
  );
}

function isActorKind(value: PlainJson | undefined): value is AuditActorKind {
  return value === "human" || value === "agent" || value === "system";
}

function isAuditOperation(value: PlainJson | undefined): value is AuditOperation {
  return value === "apply" || value === "read";
}

function isAuditOutcome(value: PlainJson | undefined): value is AuditOutcome {
  return (
    value === "committed" ||
    value === "rejected" ||
    value === "rolled_back" ||
    value === "failed"
  );
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isRecord(value: PlainJson | undefined): value is JsonRecord {
  return value !== undefined && value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasOwn(value: JsonRecord, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function addError(errors: ValidationError[], path: Path, message: string): void {
  errors.push({
    message,
    path: formatPath(path),
  });
}

function reject(
  errors: readonly ValidationError[],
): Extract<AuditEventValidationResult, { readonly ok: false }> {
  return {
    ok: false,
    errors,
  };
}

function formatPath(path: Path): string {
  return path.map(escapePathToken).join("/");
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
