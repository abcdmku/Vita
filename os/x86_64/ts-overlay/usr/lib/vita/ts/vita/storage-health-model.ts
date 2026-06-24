// Vendored from sdk/typescript/src/storage-health-model.ts
import { safeNormalize } from "./safe-normalize.ts";
import type { PlainJson, PlainJsonObject } from "./safe-normalize.ts";

export type StorageHealthStatus = "ok" | "degraded" | "unknown";

export interface StorageMountHealth {
  readonly device: string;
  readonly mountPoint: string;
  readonly fsType: string;
  readonly totalBytes: number;
  readonly usedBytes: number;
  readonly availableBytes: number;
  readonly usedPercent: number;
  readonly rotational: boolean;
  readonly nvme: boolean;
  readonly readOnly: boolean;
  readonly status: StorageHealthStatus;
}

export type StorageHealth = readonly StorageMountHealth[];

export interface HardwareDiskInventory {
  readonly name: string;
  readonly sizeBytes: number;
  readonly rotational: boolean;
  readonly nvme: boolean;
}

export interface HardwareInventory {
  readonly arch: string;
  readonly cpuCores: number;
  readonly cpuModel: string;
  readonly memTotalBytes: number;
  readonly disks: readonly HardwareDiskInventory[];
}

export interface StorageHealthState {
  readonly storageHealth: StorageHealth;
  readonly hardwareInventory: HardwareInventory;
}

export interface ValidationError {
  readonly path: string;
  readonly message: string;
}

export type StorageHealthStateValidationResult =
  | {
      readonly ok: true;
      readonly state: StorageHealthState;
      readonly value: StorageHealthState;
    }
  | {
      readonly ok: false;
      readonly errors: readonly ValidationError[];
    };

type JsonRecord = PlainJsonObject;
type Path = readonly string[];

const STATE_FIELDS = new Set([
  "capabilities",
  "capsuleWorkloads",
  "hardwareInventory",
  "storageHealth",
]);
const MOUNT_FIELDS = new Set([
  "availableBytes",
  "device",
  "fsType",
  "mountPoint",
  "nvme",
  "readOnly",
  "rotational",
  "status",
  "totalBytes",
  "usedBytes",
  "usedPercent",
]);
const HARDWARE_FIELDS = new Set([
  "arch",
  "cpuCores",
  "cpuModel",
  "disks",
  "memTotalBytes",
]);
const DISK_FIELDS = new Set(["name", "nvme", "rotational", "sizeBytes"]);

const MAX_MOUNTS = 2048;
const MAX_DISKS = 1024;
const MAX_TEXT_BYTES = 4096;
const MAX_ARCH_BYTES = 128;
const MAX_CPU_MODEL_BYTES = 512;
const MAX_DISK_NAME_BYTES = 128;

const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f]/u;
const PEM_BLOCK_PATTERN = /-----BEGIN\b/iu;
const PRIVATE_KEY_PATTERN =
  /\b(?:private[-_\s]?key|openssh\s+private\s+key|age-secret-key|xprv|seed[-_\s]?phrase|mnemonic|recovery[-_\s]?phrase)\b/iu;
const SECRET_ASSIGNMENT_PATTERN =
  /\b(?:private[-_\s]?key|api[-_\s]?key|access[-_\s]?token|refresh[-_\s]?token|password|secret)\s*(?:=|:(?!\/\/))/iu;
const SEED_WORDS_PATTERN = /\b[a-z]{3,12}(?:\s+[a-z]{3,12}){11,23}\b/iu;
const LONG_HEX_PATTERN = /(?:0x)?[A-Fa-f0-9]{32,}/u;
const LONG_BASE64_PATTERN = /[A-Za-z0-9+/]{48,}={0,2}|[A-Za-z0-9_-]{48,}/u;

export function validateStorageHealthState(input: unknown): StorageHealthStateValidationResult {
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
    const state = parseStorageHealthState(normalized.value, [], errors);

    if (state === undefined || errors.length > 0) {
      return reject(errors);
    }

    return {
      ok: true,
      state,
      value: state,
    };
  } catch {
    return reject([{ path: "", message: "Storage health validation failed." }]);
  }
}

function parseStorageHealthState(
  value: PlainJson,
  path: Path,
  errors: ValidationError[],
): StorageHealthState | undefined {
  if (!isRecord(value)) {
    addError(errors, path, "Expected state object.");
    return undefined;
  }

  const errorStart = errors.length;
  rejectUnknownFields(value, STATE_FIELDS, path, errors);
  validateOptionalStateExtras(value, path, errors);

  const storageHealth = readRequiredArray(
    value,
    "storageHealth",
    [...path, "storageHealth"],
    errors,
    MAX_MOUNTS,
    parseMountHealth,
  );
  const hardwareInventory = readRequiredObject(
    value,
    "hardwareInventory",
    [...path, "hardwareInventory"],
    errors,
    parseHardwareInventory,
  );

  if (
    errors.length > errorStart ||
    storageHealth === undefined ||
    hardwareInventory === undefined
  ) {
    return undefined;
  }

  return Object.freeze({
    hardwareInventory,
    storageHealth,
  });
}

function validateOptionalStateExtras(value: JsonRecord, path: Path, errors: ValidationError[]): void {
  if (hasOwn(value, "capabilities") && !isRecord(value["capabilities"])) {
    addError(errors, [...path, "capabilities"], "Expected capabilities object.");
  }

  if (hasOwn(value, "capsuleWorkloads") && !Array.isArray(value["capsuleWorkloads"])) {
    addError(errors, [...path, "capsuleWorkloads"], "Expected capsuleWorkloads array.");
  }
}

function parseMountHealth(
  value: PlainJson | undefined,
  path: Path,
  errors: ValidationError[],
): StorageMountHealth | undefined {
  if (!isRecord(value)) {
    addError(errors, path, "Expected storage mount object.");
    return undefined;
  }

  const errorStart = errors.length;
  rejectUnknownFields(value, MOUNT_FIELDS, path, errors);

  const device = readRequiredString(value, "device", [...path, "device"], errors, MAX_TEXT_BYTES);
  const mountPoint = readRequiredString(
    value,
    "mountPoint",
    [...path, "mountPoint"],
    errors,
    MAX_TEXT_BYTES,
  );
  const fsType = readRequiredString(value, "fsType", [...path, "fsType"], errors, MAX_TEXT_BYTES);
  const totalBytes = readRequiredInteger(
    value,
    "totalBytes",
    [...path, "totalBytes"],
    errors,
    0,
    Number.MAX_SAFE_INTEGER,
  );
  const usedBytes = readRequiredInteger(
    value,
    "usedBytes",
    [...path, "usedBytes"],
    errors,
    0,
    Number.MAX_SAFE_INTEGER,
  );
  const availableBytes = readRequiredInteger(
    value,
    "availableBytes",
    [...path, "availableBytes"],
    errors,
    0,
    Number.MAX_SAFE_INTEGER,
  );
  const usedPercent = readRequiredInteger(
    value,
    "usedPercent",
    [...path, "usedPercent"],
    errors,
    0,
    100,
  );
  const rotational = readRequiredBoolean(value, "rotational", [...path, "rotational"], errors);
  const nvme = readRequiredBoolean(value, "nvme", [...path, "nvme"], errors);
  const readOnly = readRequiredBoolean(value, "readOnly", [...path, "readOnly"], errors);
  const status = readRequiredStatus(value, "status", [...path, "status"], errors);

  if (usedBytes !== undefined && totalBytes !== undefined && usedBytes > totalBytes) {
    addError(errors, [...path, "usedBytes"], "Expected usedBytes to be less than or equal to totalBytes.");
  }
  if (availableBytes !== undefined && totalBytes !== undefined && availableBytes > totalBytes) {
    addError(
      errors,
      [...path, "availableBytes"],
      "Expected availableBytes to be less than or equal to totalBytes.",
    );
  }

  if (
    errors.length > errorStart ||
    device === undefined ||
    mountPoint === undefined ||
    fsType === undefined ||
    totalBytes === undefined ||
    usedBytes === undefined ||
    availableBytes === undefined ||
    usedPercent === undefined ||
    rotational === undefined ||
    nvme === undefined ||
    readOnly === undefined ||
    status === undefined
  ) {
    return undefined;
  }

  return Object.freeze({
    availableBytes,
    device,
    fsType,
    mountPoint,
    nvme,
    readOnly,
    rotational,
    status,
    totalBytes,
    usedBytes,
    usedPercent,
  });
}

function parseHardwareInventory(
  value: JsonRecord,
  path: Path,
  errors: ValidationError[],
): HardwareInventory | undefined {
  const errorStart = errors.length;
  rejectUnknownFields(value, HARDWARE_FIELDS, path, errors);

  const arch = readRequiredString(value, "arch", [...path, "arch"], errors, MAX_ARCH_BYTES);
  const cpuCores = readRequiredInteger(value, "cpuCores", [...path, "cpuCores"], errors, 1, 4096);
  const cpuModel = readRequiredString(
    value,
    "cpuModel",
    [...path, "cpuModel"],
    errors,
    MAX_CPU_MODEL_BYTES,
  );
  const memTotalBytes = readRequiredInteger(
    value,
    "memTotalBytes",
    [...path, "memTotalBytes"],
    errors,
    1,
    Number.MAX_SAFE_INTEGER,
  );
  const disks = readRequiredArray(
    value,
    "disks",
    [...path, "disks"],
    errors,
    MAX_DISKS,
    parseDiskInventory,
  );

  if (
    errors.length > errorStart ||
    arch === undefined ||
    cpuCores === undefined ||
    cpuModel === undefined ||
    memTotalBytes === undefined ||
    disks === undefined
  ) {
    return undefined;
  }

  return Object.freeze({
    arch,
    cpuCores,
    cpuModel,
    disks,
    memTotalBytes,
  });
}

function parseDiskInventory(
  value: PlainJson | undefined,
  path: Path,
  errors: ValidationError[],
): HardwareDiskInventory | undefined {
  if (!isRecord(value)) {
    addError(errors, path, "Expected disk inventory object.");
    return undefined;
  }

  const errorStart = errors.length;
  rejectUnknownFields(value, DISK_FIELDS, path, errors);

  const name = readRequiredString(value, "name", [...path, "name"], errors, MAX_DISK_NAME_BYTES);
  const sizeBytes = readRequiredInteger(
    value,
    "sizeBytes",
    [...path, "sizeBytes"],
    errors,
    1,
    Number.MAX_SAFE_INTEGER,
  );
  const rotational = readRequiredBoolean(value, "rotational", [...path, "rotational"], errors);
  const nvme = readRequiredBoolean(value, "nvme", [...path, "nvme"], errors);

  if (
    errors.length > errorStart ||
    name === undefined ||
    sizeBytes === undefined ||
    rotational === undefined ||
    nvme === undefined
  ) {
    return undefined;
  }

  return Object.freeze({
    name,
    nvme,
    rotational,
    sizeBytes,
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

function readRequiredArray<T>(
  value: JsonRecord,
  key: string,
  path: Path,
  errors: ValidationError[],
  maxLength: number,
  parse: (item: PlainJson | undefined, itemPath: Path, itemErrors: ValidationError[]) => T | undefined,
): readonly T[] | undefined {
  const child = readRequiredProperty(value, key, path, errors);

  if (child === undefined) {
    return undefined;
  }

  if (!Array.isArray(child)) {
    addError(errors, path, "Expected array.");
    return undefined;
  }

  if (child.length > maxLength) {
    addError(errors, path, "Too many entries.");
    return undefined;
  }

  const out: T[] = [];
  const errorStart = errors.length;
  for (let index = 0; index < child.length; index += 1) {
    const item = child[index];
    const parsed = parse(item, [...path, String(index)], errors);

    if (parsed !== undefined) {
      out.push(parsed);
    }
  }

  if (errors.length > errorStart) {
    return undefined;
  }

  return Object.freeze(out);
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
  min: number,
  max: number,
): number | undefined {
  const child = readRequiredProperty(value, key, path, errors);

  if (child === undefined) {
    return undefined;
  }

  if (typeof child !== "number" || !Number.isSafeInteger(child) || child < min || child > max) {
    addError(errors, path, "Expected bounded integer.");
    return undefined;
  }

  return child;
}

function readRequiredString(
  value: JsonRecord,
  key: string,
  path: Path,
  errors: ValidationError[],
  maxBytes: number,
): string | undefined {
  const child = readRequiredProperty(value, key, path, errors);

  if (child === undefined) {
    return undefined;
  }

  if (typeof child !== "string" || !isSafeText(child, maxBytes)) {
    addError(errors, path, "Expected bounded string without inline key material.");
    return undefined;
  }

  return child;
}

function readRequiredStatus(
  value: JsonRecord,
  key: string,
  path: Path,
  errors: ValidationError[],
): StorageHealthStatus | undefined {
  const child = readRequiredProperty(value, key, path, errors);

  if (child === undefined) {
    return undefined;
  }

  if (!isStorageHealthStatus(child)) {
    addError(errors, path, "Expected one of: ok, degraded, unknown.");
    return undefined;
  }

  return child;
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

function isSafeText(value: string, maxBytes: number): boolean {
  return (
    value.length > 0 &&
    utf8ByteLength(value) <= maxBytes &&
    !containsInlineKeyMaterial(value)
  );
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

function utf8ByteLength(value: string): number {
  let bytes = 0;
  for (const rune of value) {
    const codePoint = rune.codePointAt(0);

    if (codePoint === undefined) {
      continue;
    }
    if (codePoint <= 0x7f) {
      bytes += 1;
    } else if (codePoint <= 0x7ff) {
      bytes += 2;
    } else if (codePoint <= 0xffff) {
      bytes += 3;
    } else {
      bytes += 4;
    }
  }
  return bytes;
}

function isStorageHealthStatus(value: PlainJson | undefined): value is StorageHealthStatus {
  return value === "ok" || value === "degraded" || value === "unknown";
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
): Extract<StorageHealthStateValidationResult, { readonly ok: false }> {
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
