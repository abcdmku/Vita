import { safeNormalize } from "./safe-normalize.ts";
import type { PlainJson, PlainJsonObject } from "./safe-normalize.ts";

export type CapabilityHealthStatus = "healthy" | "degraded" | "failed";

export interface ResourceMetric {
  readonly used: number;
  readonly total: number;
}

export interface CapabilityHealth {
  readonly name: string;
  readonly status: CapabilityHealthStatus;
  readonly message?: string;
}

export interface NodeHealth {
  readonly healthy: boolean;
  readonly uptimeSeconds: number;
  readonly cpu: ResourceMetric;
  readonly memory: ResourceMetric;
  readonly storage: ResourceMetric;
  readonly capabilities: readonly CapabilityHealth[];
}

export interface ValidationError {
  readonly path: string;
  readonly message: string;
}

export type NodeHealthValidationError = ValidationError;

export type NodeHealthValidationResult =
  | {
      readonly ok: true;
      readonly health: NodeHealth;
      readonly value: NodeHealth;
    }
  | {
      readonly ok: false;
      readonly errors: readonly ValidationError[];
    };

export type Result = NodeHealthValidationResult;

type JsonRecord = PlainJsonObject;
type Path = readonly string[];

const NODE_HEALTH_FIELDS = new Set([
  "capabilities",
  "cpu",
  "healthy",
  "memory",
  "storage",
  "uptimeSeconds",
]);
const RESOURCE_METRIC_FIELDS = new Set(["total", "used"]);
const CAPABILITY_HEALTH_FIELDS = new Set(["message", "name", "status"]);
const CAPABILITY_HEALTH_STATUSES = new Set<CapabilityHealthStatus>([
  "degraded",
  "failed",
  "healthy",
]);

const SECRET_FIELD_NAMES = new Set([
  "apikey",
  "accesstoken",
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

const MAX_CAPABILITIES = 1024;
const MAX_CAPABILITY_NAME_LENGTH = 128;
const MAX_MESSAGE_LENGTH = 2048;

const CAPABILITY_NAME_PATTERN =
  /^[A-Za-z0-9](?:[A-Za-z0-9]|[._:@-](?=[A-Za-z0-9])){0,127}$/u;
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f]/u;
const PEM_BLOCK_PATTERN = /-----BEGIN\b/iu;
const PRIVATE_KEY_PATTERN =
  /\b(?:private[-_\s]?key|openssh\s+private\s+key|age-secret-key|xprv|seed[-_\s]?phrase|mnemonic|recovery[-_\s]?phrase)\b/iu;
const SECRET_ASSIGNMENT_PATTERN =
  /\b(?:private[-_\s]?key|api[-_\s]?key|access[-_\s]?token|refresh[-_\s]?token|password|secret)\s*(?:=|:(?!\/\/))/iu;
const SEED_WORDS_PATTERN = /\b[a-z]{3,12}(?:\s+[a-z]{3,12}){11,23}\b/iu;
const LONG_HEX_PATTERN = /(?:0x)?[A-Fa-f0-9]{32,}/u;
const LONG_BASE64_PATTERN = /[A-Za-z0-9+/]{48,}={0,2}|[A-Za-z0-9_-]{48,}/u;

export function validateNodeHealth(input: unknown): NodeHealthValidationResult {
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

    const health = parseNodeHealth(normalized.value, [], errors);

    if (health === undefined || errors.length > 0) {
      return reject(errors);
    }

    return {
      ok: true,
      health,
      value: health,
    };
  } catch {
    return reject([{ path: "", message: "Node health validation failed." }]);
  }
}

function parseNodeHealth(
  value: PlainJson,
  path: Path,
  errors: ValidationError[],
): NodeHealth | undefined {
  if (!isRecord(value)) {
    addError(errors, path, "Expected node health object.");
    return undefined;
  }

  const errorStart = errors.length;

  rejectUnknownFields(value, NODE_HEALTH_FIELDS, path, errors);

  const healthy = readRequiredBoolean(value, "healthy", [...path, "healthy"], errors);
  const uptimeSeconds = readRequiredInteger(
    value,
    "uptimeSeconds",
    [...path, "uptimeSeconds"],
    errors,
  );
  const cpu = readRequiredObject(value, "cpu", [...path, "cpu"], errors, parseResourceMetric);
  const memory = readRequiredObject(
    value,
    "memory",
    [...path, "memory"],
    errors,
    parseResourceMetric,
  );
  const storage = readRequiredObject(
    value,
    "storage",
    [...path, "storage"],
    errors,
    parseResourceMetric,
  );
  const capabilities = readRequiredCapabilities(value, [...path, "capabilities"], errors);

  if (
    errors.length > errorStart ||
    healthy === undefined ||
    uptimeSeconds === undefined ||
    cpu === undefined ||
    memory === undefined ||
    storage === undefined ||
    capabilities === undefined
  ) {
    return undefined;
  }

  return Object.freeze({
    capabilities,
    cpu,
    healthy,
    memory,
    storage,
    uptimeSeconds,
  });
}

function parseResourceMetric(
  value: JsonRecord,
  path: Path,
  errors: ValidationError[],
): ResourceMetric | undefined {
  const errorStart = errors.length;

  rejectUnknownFields(value, RESOURCE_METRIC_FIELDS, path, errors);

  const used = readRequiredInteger(value, "used", [...path, "used"], errors);
  const total = readRequiredInteger(value, "total", [...path, "total"], errors);

  if (used !== undefined && total !== undefined && used > total) {
    addError(errors, [...path, "used"], "Expected used to be less than or equal to total.");
  }

  if (errors.length > errorStart || used === undefined || total === undefined) {
    return undefined;
  }

  return Object.freeze({
    total,
    used,
  });
}

function readRequiredCapabilities(
  value: JsonRecord,
  path: Path,
  errors: ValidationError[],
): readonly CapabilityHealth[] | undefined {
  const child = readRequiredProperty(value, "capabilities", path, errors);

  if (child === undefined) {
    return undefined;
  }

  if (!Array.isArray(child)) {
    addError(errors, path, "Expected capabilities array.");
    return undefined;
  }

  if (child.length > MAX_CAPABILITIES) {
    addError(errors, path, "Too many capabilities.");
    return undefined;
  }

  const capabilities: CapabilityHealth[] = [];
  const seenNames = new Map<string, number>();
  const errorStart = errors.length;

  for (let index = 0; index < child.length; index += 1) {
    const item = child[index];
    const itemPath = [...path, String(index)];
    const capability = parseCapabilityHealth(item, itemPath, errors);

    if (capability === undefined) {
      continue;
    }

    const previousIndex = seenNames.get(capability.name);

    if (previousIndex !== undefined) {
      addError(
        errors,
        [...itemPath, "name"],
        `Duplicate capability name also appears at ${formatPath([
          ...path,
          String(previousIndex),
          "name",
        ])}.`,
      );
    } else {
      seenNames.set(capability.name, index);
    }

    capabilities.push(capability);
  }

  if (errors.length > errorStart) {
    return undefined;
  }

  return Object.freeze(capabilities);
}

function parseCapabilityHealth(
  value: PlainJson | undefined,
  path: Path,
  errors: ValidationError[],
): CapabilityHealth | undefined {
  if (!isRecord(value)) {
    addError(errors, path, "Expected capability health object.");
    return undefined;
  }

  const errorStart = errors.length;

  rejectUnknownFields(value, CAPABILITY_HEALTH_FIELDS, path, errors);

  const name = readRequiredString(value, "name", [...path, "name"], errors);
  const status = readRequiredStatus(value, "status", [...path, "status"], errors);
  const message = readOptionalMessage(value, "message", [...path, "message"], errors);

  if (name !== undefined && !isCapabilityName(name)) {
    addError(errors, [...path, "name"], "Expected well-formed capability name.");
  }

  if (errors.length > errorStart || name === undefined || status === undefined) {
    return undefined;
  }

  return Object.freeze({
    ...(message === undefined ? {} : { message }),
    name,
    status,
  });
}

function readRequiredObject<T>(
  value: JsonRecord,
  key: string,
  path: Path,
  errors: ValidationError[],
  parse: (objectValue: JsonRecord, objectPath: Path, objectErrors: ValidationError[]) => T | undefined,
): T | undefined {
  const child = readRequiredProperty(value, key, path, errors);

  if (child === undefined) {
    return undefined;
  }

  if (!isRecord(child)) {
    addError(errors, path, "Expected object.");
    return undefined;
  }

  return parse(child, path, errors);
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

  return value[key];
}

function readRequiredBoolean(
  value: JsonRecord,
  key: string,
  path: Path,
  errors: ValidationError[],
): boolean | undefined {
  const child = readRequiredProperty(value, key, path, errors);

  if (child === undefined) {
    return undefined;
  }

  if (typeof child !== "boolean") {
    addError(errors, path, "Expected boolean.");
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

  if (typeof child !== "number" || !Number.isSafeInteger(child) || child < 0) {
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

function readRequiredStatus(
  value: JsonRecord,
  key: string,
  path: Path,
  errors: ValidationError[],
): CapabilityHealthStatus | undefined {
  const child = readRequiredProperty(value, key, path, errors);

  if (child === undefined) {
    return undefined;
  }

  if (!isCapabilityHealthStatus(child)) {
    addError(errors, path, "Expected one of: healthy, degraded, failed.");
    return undefined;
  }

  return child;
}

function readOptionalMessage(
  value: JsonRecord,
  key: string,
  path: Path,
  errors: ValidationError[],
): string | undefined {
  if (!hasOwn(value, key)) {
    return undefined;
  }

  const child = value[key];

  if (typeof child !== "string" || child.length > MAX_MESSAGE_LENGTH) {
    addError(errors, path, "Expected message string.");
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

function isCapabilityHealthStatus(value: PlainJson | undefined): value is CapabilityHealthStatus {
  return (
    value === "healthy" ||
    value === "degraded" ||
    value === "failed"
  );
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
): Extract<NodeHealthValidationResult, { readonly ok: false }> {
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
