import { safeNormalize } from "./safe-normalize.ts";
import type { PlainJson, PlainJsonObject } from "./safe-normalize.ts";

export const STORAGE_LAYOUT_VERSION = 1;

export type StorageFilesystem = "btrfs";
export type StorageEncryption = "luks2";
export type StorageAreaRole =
  | "system-state"
  | "user-data"
  | "app-state"
  | "snapshots"
  | "local-backup-cache";
export type SnapshotCadence = "disabled" | "hourly" | "daily" | "weekly";
export type DiskHealthStatus = "healthy" | "degraded" | "critical" | "unknown";
export type SmartHealthStatus = "passed" | "warning" | "failed" | "unknown";

export interface StorageLayout {
  readonly version: typeof STORAGE_LAYOUT_VERSION;
  readonly dataVolume: DataVolume;
  readonly subvolumes: readonly Subvolume[];
  readonly snapshotPolicy: SnapshotPolicy;
  readonly diskHealth: DiskHealth;
}

export interface DataVolume {
  readonly encryption: StorageEncryption;
  readonly filesystem: StorageFilesystem;
  readonly tpmUnlock: boolean;
  readonly recoveryKeyRequired: true;
}

export interface Subvolume {
  readonly id: string;
  readonly role: StorageAreaRole;
  readonly path: string;
  readonly quotaGiB?: number;
  readonly readOnly?: boolean;
  readonly appId?: string;
}

export interface SnapshotPolicy {
  readonly cadence: SnapshotCadence;
  readonly retentionCount: number;
  readonly readOnlySnapshots: true;
  readonly minFreeBytes?: number;
}

export interface DiskHealth {
  readonly status: DiskHealthStatus;
  readonly totalBytes: number;
  readonly usedBytes: number;
  readonly freeBytes: number;
  readonly checksumErrors: number;
  readonly smart: SmartHealth;
}

export interface SmartHealth {
  readonly status: SmartHealthStatus;
  readonly reallocatedSectors: number;
  readonly temperatureC?: number;
  readonly powerOnHours?: number;
}

export interface ValidationError {
  readonly path: string;
  readonly message: string;
}

export type Result =
  | {
      readonly ok: true;
      readonly layout: StorageLayout;
    }
  | {
      readonly ok: false;
      readonly errors: readonly ValidationError[];
    };

type Path = readonly string[];
type JsonRecord = PlainJsonObject;

const STORAGE_LAYOUT_FIELDS = new Set([
  "version",
  "dataVolume",
  "subvolumes",
  "snapshotPolicy",
  "diskHealth",
]);
const DATA_VOLUME_FIELDS = new Set([
  "encryption",
  "filesystem",
  "tpmUnlock",
  "recoveryKeyRequired",
]);
const SUBVOLUME_FIELDS = new Set([
  "id",
  "role",
  "path",
  "quotaGiB",
  "readOnly",
  "appId",
]);
const SNAPSHOT_POLICY_FIELDS = new Set([
  "cadence",
  "retentionCount",
  "readOnlySnapshots",
  "minFreeBytes",
]);
const DISK_HEALTH_FIELDS = new Set([
  "status",
  "totalBytes",
  "usedBytes",
  "freeBytes",
  "checksumErrors",
  "smart",
]);
const SMART_HEALTH_FIELDS = new Set([
  "status",
  "reallocatedSectors",
  "temperatureC",
  "powerOnHours",
]);

const STORAGE_AREA_ROLES = new Set<StorageAreaRole>([
  "system-state",
  "user-data",
  "app-state",
  "snapshots",
  "local-backup-cache",
]);
const REQUIRED_STORAGE_AREA_ROLES: readonly StorageAreaRole[] = [
  "system-state",
  "user-data",
  "app-state",
  "snapshots",
  "local-backup-cache",
];
const SINGLETON_STORAGE_AREA_ROLES = new Set<StorageAreaRole>([
  "system-state",
  "user-data",
  "snapshots",
  "local-backup-cache",
]);
const SNAPSHOT_CADENCES = new Set<SnapshotCadence>([
  "disabled",
  "hourly",
  "daily",
  "weekly",
]);
const DISK_HEALTH_STATUSES = new Set<DiskHealthStatus>([
  "healthy",
  "degraded",
  "critical",
  "unknown",
]);
const SMART_HEALTH_STATUSES = new Set<SmartHealthStatus>([
  "passed",
  "warning",
  "failed",
  "unknown",
]);

const MAX_QUOTA_GIB = 1_000_000;
const MAX_SNAPSHOT_RETENTION = 10_000;
const MAX_TEMPERATURE_C = 125;
const MIN_TEMPERATURE_C = -40;

export function validateStorageLayout(input: unknown): Result {
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
  const layout = parseStorageLayout(normalized.value, [], errors);

  if (layout === undefined || errors.length > 0) {
    return reject(errors);
  }

  return {
    ok: true,
    layout,
  };
}

function parseStorageLayout(
  value: PlainJson,
  path: Path,
  errors: ValidationError[],
): StorageLayout | undefined {
  if (!isRecord(value)) {
    addError(errors, path, "Expected storage layout object.");
    return undefined;
  }

  const errorStart = errors.length;

  rejectUnknownFields(value, STORAGE_LAYOUT_FIELDS, path, errors);

  const version = readRequiredLiteral(
    value,
    "version",
    STORAGE_LAYOUT_VERSION,
    [...path, "version"],
    errors,
  );
  const dataVolume = readRequiredObject(
    value,
    "dataVolume",
    [...path, "dataVolume"],
    errors,
    parseDataVolume,
  );
  const subvolumes = readRequiredArray(
    value,
    "subvolumes",
    [...path, "subvolumes"],
    errors,
    parseSubvolume,
  );
  const snapshotPolicy = readRequiredObject(
    value,
    "snapshotPolicy",
    [...path, "snapshotPolicy"],
    errors,
    parseSnapshotPolicy,
  );
  const diskHealth = readRequiredObject(
    value,
    "diskHealth",
    [...path, "diskHealth"],
    errors,
    parseDiskHealth,
  );

  if (subvolumes !== undefined) {
    validateRequiredStorageAreas(subvolumes, [...path, "subvolumes"], errors);
  }

  if (
    errors.length > errorStart ||
    version === undefined ||
    dataVolume === undefined ||
    subvolumes === undefined ||
    snapshotPolicy === undefined ||
    diskHealth === undefined
  ) {
    return undefined;
  }

  return Object.freeze({
    version,
    dataVolume,
    subvolumes,
    snapshotPolicy,
    diskHealth,
  });
}

function parseDataVolume(
  value: JsonRecord,
  path: Path,
  errors: ValidationError[],
): DataVolume | undefined {
  const errorStart = errors.length;

  rejectUnknownFields(value, DATA_VOLUME_FIELDS, path, errors);

  const encryption = readRequiredLiteral(
    value,
    "encryption",
    "luks2",
    [...path, "encryption"],
    errors,
  );
  const filesystem = readRequiredLiteral(
    value,
    "filesystem",
    "btrfs",
    [...path, "filesystem"],
    errors,
  );
  const tpmUnlock = readRequiredBoolean(value, "tpmUnlock", [...path, "tpmUnlock"], errors);
  const recoveryKeyRequired = readRequiredLiteral(
    value,
    "recoveryKeyRequired",
    true,
    [...path, "recoveryKeyRequired"],
    errors,
  );

  if (
    errors.length > errorStart ||
    encryption === undefined ||
    filesystem === undefined ||
    tpmUnlock === undefined ||
    recoveryKeyRequired === undefined
  ) {
    return undefined;
  }

  return Object.freeze({
    encryption,
    filesystem,
    tpmUnlock,
    recoveryKeyRequired,
  });
}

function parseSubvolume(
  value: PlainJson,
  path: Path,
  errors: ValidationError[],
): Subvolume | undefined {
  if (!isRecord(value)) {
    addError(errors, path, "Expected subvolume object.");
    return undefined;
  }

  const errorStart = errors.length;

  rejectUnknownFields(value, SUBVOLUME_FIELDS, path, errors);

  const id = readRequiredNonEmptyString(value, "id", [...path, "id"], errors);
  const role = readRequiredEnum(value, "role", STORAGE_AREA_ROLES, [...path, "role"], errors);
  const subvolumePath = readRequiredCanonicalPath(value, "path", [...path, "path"], errors);
  const quotaGiB = readOptionalInteger(
    value,
    "quotaGiB",
    1,
    MAX_QUOTA_GIB,
    [...path, "quotaGiB"],
    errors,
  );
  const readOnly = readOptionalBoolean(value, "readOnly", [...path, "readOnly"], errors);
  const appId = readOptionalNonEmptyString(value, "appId", [...path, "appId"], errors);

  if (role === "app-state" && appId === undefined) {
    addError(errors, [...path, "appId"], "app-state subvolumes require appId.");
  } else if (role !== undefined && role !== "app-state" && appId !== undefined) {
    addError(errors, [...path, "appId"], "appId is only allowed for app-state subvolumes.");
  }

  if (
    errors.length > errorStart ||
    id === undefined ||
    role === undefined ||
    subvolumePath === undefined
  ) {
    return undefined;
  }

  let subvolume: Subvolume = Object.freeze({
    id,
    role,
    path: subvolumePath,
  });

  if (quotaGiB !== undefined) {
    subvolume = Object.freeze({
      ...subvolume,
      quotaGiB,
    });
  }

  if (readOnly !== undefined) {
    subvolume = Object.freeze({
      ...subvolume,
      readOnly,
    });
  }

  if (appId !== undefined) {
    subvolume = Object.freeze({
      ...subvolume,
      appId,
    });
  }

  return subvolume;
}

function parseSnapshotPolicy(
  value: JsonRecord,
  path: Path,
  errors: ValidationError[],
): SnapshotPolicy | undefined {
  const errorStart = errors.length;

  rejectUnknownFields(value, SNAPSHOT_POLICY_FIELDS, path, errors);

  const cadence = readRequiredEnum(
    value,
    "cadence",
    SNAPSHOT_CADENCES,
    [...path, "cadence"],
    errors,
  );
  const retentionCount = readRequiredInteger(
    value,
    "retentionCount",
    0,
    MAX_SNAPSHOT_RETENTION,
    [...path, "retentionCount"],
    errors,
  );
  const readOnlySnapshots = readRequiredLiteral(
    value,
    "readOnlySnapshots",
    true,
    [...path, "readOnlySnapshots"],
    errors,
  );
  const minFreeBytes = readOptionalInteger(
    value,
    "minFreeBytes",
    0,
    Number.MAX_SAFE_INTEGER,
    [...path, "minFreeBytes"],
    errors,
  );

  if (cadence === "disabled" && retentionCount !== undefined && retentionCount !== 0) {
    addError(errors, [...path, "retentionCount"], "Expected 0 when snapshots are disabled.");
  } else if (
    cadence !== undefined &&
    cadence !== "disabled" &&
    retentionCount !== undefined &&
    retentionCount < 1
  ) {
    addError(errors, [...path, "retentionCount"], "Expected at least 1 when snapshots are enabled.");
  }

  if (
    errors.length > errorStart ||
    cadence === undefined ||
    retentionCount === undefined ||
    readOnlySnapshots === undefined
  ) {
    return undefined;
  }

  if (minFreeBytes !== undefined) {
    return Object.freeze({
      cadence,
      retentionCount,
      readOnlySnapshots,
      minFreeBytes,
    });
  }

  return Object.freeze({
    cadence,
    retentionCount,
    readOnlySnapshots,
  });
}

function parseDiskHealth(
  value: JsonRecord,
  path: Path,
  errors: ValidationError[],
): DiskHealth | undefined {
  const errorStart = errors.length;

  rejectUnknownFields(value, DISK_HEALTH_FIELDS, path, errors);

  const status = readRequiredEnum(
    value,
    "status",
    DISK_HEALTH_STATUSES,
    [...path, "status"],
    errors,
  );
  const totalBytes = readRequiredInteger(
    value,
    "totalBytes",
    1,
    Number.MAX_SAFE_INTEGER,
    [...path, "totalBytes"],
    errors,
  );
  const usedBytes = readRequiredInteger(
    value,
    "usedBytes",
    0,
    Number.MAX_SAFE_INTEGER,
    [...path, "usedBytes"],
    errors,
  );
  const freeBytes = readRequiredInteger(
    value,
    "freeBytes",
    0,
    Number.MAX_SAFE_INTEGER,
    [...path, "freeBytes"],
    errors,
  );
  const checksumErrors = readRequiredInteger(
    value,
    "checksumErrors",
    0,
    Number.MAX_SAFE_INTEGER,
    [...path, "checksumErrors"],
    errors,
  );
  const smart = readRequiredObject(value, "smart", [...path, "smart"], errors, parseSmartHealth);

  if (totalBytes !== undefined && usedBytes !== undefined && usedBytes > totalBytes) {
    addError(errors, [...path, "usedBytes"], "Expected value less than or equal to totalBytes.");
  }

  if (totalBytes !== undefined && freeBytes !== undefined && freeBytes > totalBytes) {
    addError(errors, [...path, "freeBytes"], "Expected value less than or equal to totalBytes.");
  }

  if (
    totalBytes !== undefined &&
    usedBytes !== undefined &&
    freeBytes !== undefined &&
    usedBytes + freeBytes > totalBytes
  ) {
    addError(errors, [...path, "freeBytes"], "Expected usedBytes + freeBytes to fit totalBytes.");
  }

  if (
    errors.length > errorStart ||
    status === undefined ||
    totalBytes === undefined ||
    usedBytes === undefined ||
    freeBytes === undefined ||
    checksumErrors === undefined ||
    smart === undefined
  ) {
    return undefined;
  }

  return Object.freeze({
    status,
    totalBytes,
    usedBytes,
    freeBytes,
    checksumErrors,
    smart,
  });
}

function parseSmartHealth(
  value: JsonRecord,
  path: Path,
  errors: ValidationError[],
): SmartHealth | undefined {
  const errorStart = errors.length;

  rejectUnknownFields(value, SMART_HEALTH_FIELDS, path, errors);

  const status = readRequiredEnum(
    value,
    "status",
    SMART_HEALTH_STATUSES,
    [...path, "status"],
    errors,
  );
  const reallocatedSectors = readRequiredInteger(
    value,
    "reallocatedSectors",
    0,
    Number.MAX_SAFE_INTEGER,
    [...path, "reallocatedSectors"],
    errors,
  );
  const temperatureC = readOptionalFiniteNumber(
    value,
    "temperatureC",
    MIN_TEMPERATURE_C,
    MAX_TEMPERATURE_C,
    [...path, "temperatureC"],
    errors,
  );
  const powerOnHours = readOptionalInteger(
    value,
    "powerOnHours",
    0,
    Number.MAX_SAFE_INTEGER,
    [...path, "powerOnHours"],
    errors,
  );

  if (errors.length > errorStart || status === undefined || reallocatedSectors === undefined) {
    return undefined;
  }

  let smartHealth: SmartHealth = Object.freeze({
    status,
    reallocatedSectors,
  });

  if (temperatureC !== undefined) {
    smartHealth = Object.freeze({
      ...smartHealth,
      temperatureC,
    });
  }

  if (powerOnHours !== undefined) {
    smartHealth = Object.freeze({
      ...smartHealth,
      powerOnHours,
    });
  }

  return smartHealth;
}

function validateRequiredStorageAreas(
  subvolumes: readonly Subvolume[],
  path: Path,
  errors: ValidationError[],
): void {
  const seenRoles = new Map<StorageAreaRole, number>();
  const seenIds = new Map<string, number>();
  const seenAppIds = new Map<string, number>();

  for (let index = 0; index < subvolumes.length; index += 1) {
    const subvolume = subvolumes[index];

    if (subvolume === undefined) {
      continue;
    }

    const previousIdIndex = seenIds.get(subvolume.id);

    if (previousIdIndex !== undefined) {
      addError(
        errors,
        [...path, String(index), "id"],
        `Duplicate subvolume id also appears at subvolumes/${previousIdIndex}/id.`,
      );
    } else {
      seenIds.set(subvolume.id, index);
    }

    const previousRoleIndex = seenRoles.get(subvolume.role);

    if (previousRoleIndex !== undefined && SINGLETON_STORAGE_AREA_ROLES.has(subvolume.role)) {
      addError(
        errors,
        [...path, String(index), "role"],
        `Duplicate ${subvolume.role} area also appears at subvolumes/${previousRoleIndex}/role.`,
      );
    } else if (previousRoleIndex === undefined) {
      seenRoles.set(subvolume.role, index);
    }

    if (subvolume.role === "app-state") {
      if (subvolume.appId === undefined) {
        continue;
      }

      const previousAppIndex = seenAppIds.get(subvolume.appId);

      if (previousAppIndex !== undefined) {
        addError(
          errors,
          [...path, String(index), "appId"],
          `Duplicate app-state appId also appears at subvolumes/${previousAppIndex}/appId.`,
        );
      } else {
        seenAppIds.set(subvolume.appId, index);
      }
    }
  }

  for (let index = 0; index < REQUIRED_STORAGE_AREA_ROLES.length; index += 1) {
    const role = REQUIRED_STORAGE_AREA_ROLES[index];

    if (role !== undefined && !seenRoles.has(role)) {
      addError(errors, path, `Missing required ${role} storage area.`);
    }
  }
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
  parse: (item: PlainJson, itemPath: Path, itemErrors: ValidationError[]) => T | undefined,
): readonly T[] | undefined {
  const child = readRequiredProperty(value, key, path, errors);

  if (child === undefined) {
    return undefined;
  }

  if (!Array.isArray(child)) {
    addError(errors, path, "Expected array.");
    return undefined;
  }

  if (child.length === 0) {
    addError(errors, path, "Expected at least one subvolume.");
  }

  const items: T[] = [];
  const errorStart = errors.length;

  for (let index = 0; index < child.length; index += 1) {
    const item = child[index];

    if (item === undefined) {
      addError(errors, [...path, String(index)], "Expected item.");
      continue;
    }

    const parsed = parse(item, [...path, String(index)], errors);

    if (parsed !== undefined) {
      items.push(parsed);
    }
  }

  if (errors.length > errorStart) {
    return undefined;
  }

  return Object.freeze(items);
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

function readRequiredLiteral<T extends string | number | boolean>(
  value: JsonRecord,
  key: string,
  expected: T,
  path: Path,
  errors: ValidationError[],
): T | undefined {
  const child = readRequiredProperty(value, key, path, errors);

  if (child === undefined) {
    return undefined;
  }

  if (child !== expected) {
    addError(errors, path, `Expected ${String(expected)}.`);
    return undefined;
  }

  return expected;
}

function readRequiredEnum<T extends string>(
  value: JsonRecord,
  key: string,
  allowed: ReadonlySet<T>,
  path: Path,
  errors: ValidationError[],
): T | undefined {
  const child = readRequiredProperty(value, key, path, errors);

  if (child === undefined) {
    return undefined;
  }

  if (!isStringInSet(child, allowed)) {
    addError(errors, path, `Expected one of: ${[...allowed].join(", ")}.`);
    return undefined;
  }

  return child;
}

function readRequiredNonEmptyString(
  value: JsonRecord,
  key: string,
  path: Path,
  errors: ValidationError[],
): string | undefined {
  const child = readRequiredProperty(value, key, path, errors);

  if (child === undefined) {
    return undefined;
  }

  if (typeof child !== "string" || child === "") {
    addError(errors, path, "Expected non-empty string.");
    return undefined;
  }

  return child;
}

function readOptionalNonEmptyString(
  value: JsonRecord,
  key: string,
  path: Path,
  errors: ValidationError[],
): string | undefined {
  if (!hasOwn(value, key)) {
    return undefined;
  }

  const child = value[key];

  if (typeof child !== "string" || child === "") {
    addError(errors, path, "Expected non-empty string.");
    return undefined;
  }

  return child;
}

function readRequiredCanonicalPath(
  value: JsonRecord,
  key: string,
  path: Path,
  errors: ValidationError[],
): string | undefined {
  const child = readRequiredNonEmptyString(value, key, path, errors);

  if (child === undefined) {
    return undefined;
  }

  if (!isCanonicalAbsolutePath(child)) {
    addError(errors, path, "Expected canonical absolute path.");
    return undefined;
  }

  return child;
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

function readOptionalBoolean(
  value: JsonRecord,
  key: string,
  path: Path,
  errors: ValidationError[],
): boolean | undefined {
  if (!hasOwn(value, key)) {
    return undefined;
  }

  const child = value[key];

  if (typeof child !== "boolean") {
    addError(errors, path, "Expected boolean.");
    return undefined;
  }

  return child;
}

function readRequiredInteger(
  value: JsonRecord,
  key: string,
  min: number,
  max: number,
  path: Path,
  errors: ValidationError[],
): number | undefined {
  const child = readRequiredProperty(value, key, path, errors);

  if (child === undefined) {
    return undefined;
  }

  return validateInteger(child, min, max, path, errors);
}

function readOptionalInteger(
  value: JsonRecord,
  key: string,
  min: number,
  max: number,
  path: Path,
  errors: ValidationError[],
): number | undefined {
  if (!hasOwn(value, key)) {
    return undefined;
  }

  return validateInteger(value[key], min, max, path, errors);
}

function validateInteger(
  value: PlainJson | undefined,
  min: number,
  max: number,
  path: Path,
  errors: ValidationError[],
): number | undefined {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < min ||
    value > max
  ) {
    addError(errors, path, `Expected integer from ${min} through ${max}.`);
    return undefined;
  }

  return value;
}

function readOptionalFiniteNumber(
  value: JsonRecord,
  key: string,
  min: number,
  max: number,
  path: Path,
  errors: ValidationError[],
): number | undefined {
  if (!hasOwn(value, key)) {
    return undefined;
  }

  const child = value[key];

  if (typeof child !== "number" || !Number.isFinite(child) || child < min || child > max) {
    addError(errors, path, `Expected finite number from ${min} through ${max}.`);
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

function isRecord(value: PlainJson): value is JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isStringInSet<T extends string>(value: PlainJson, allowed: ReadonlySet<T>): value is T {
  return typeof value === "string" && allowed.has(value as T);
}

function isCanonicalAbsolutePath(value: string): boolean {
  if (!value.startsWith("/") || value === "/" || value.endsWith("/")) {
    return false;
  }

  const segments = value.split("/");

  for (let index = 1; index < segments.length; index += 1) {
    const segment = segments[index];

    if (
      segment === undefined ||
      segment === "" ||
      segment === "." ||
      segment === ".." ||
      segment.includes("\0")
    ) {
      return false;
    }
  }

  return true;
}

function hasOwn(value: JsonRecord, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function addError(errors: ValidationError[], path: Path, message: string): void {
  errors.push({
    path: formatPath(path),
    message,
  });
}

function reject(errors: readonly ValidationError[]): Result {
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
