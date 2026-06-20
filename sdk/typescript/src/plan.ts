import { createHash } from "node:crypto";

export const PLAN_VERSION = 1;

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonObject | readonly JsonValue[];

export interface JsonObject {
  readonly [key: string]: JsonValue | undefined;
}

export type StorageEncryptionMode = "disabled" | "optional" | "required";
export type SnapshotCadence = "disabled" | "hourly" | "daily" | "weekly";
export type BackupSchedule = "hourly" | "daily" | "weekly" | "monthly";
export type BackupTarget = "network" | "usb";

export interface DesiredState {
  readonly identity?: DesiredIdentity;
  readonly storage?: DesiredStorage;
  readonly apps?: readonly DesiredApp[];
  readonly backups?: readonly DesiredBackup[];
}

export interface DesiredIdentity {
  readonly owner?: DesiredIdentityOwner;
  readonly passkeysRequired?: boolean;
}

export interface DesiredIdentityOwner {
  readonly id: string;
  readonly displayName?: string;
}

export interface DesiredStorage {
  readonly dataVolume?: DesiredDataVolume;
}

export interface DesiredDataVolume {
  readonly encryption?: StorageEncryptionMode;
  readonly snapshots?: SnapshotCadence;
  readonly quotaGiB?: number;
}

export interface DesiredApp {
  readonly id: string;
  readonly enabled?: boolean;
  readonly version?: string;
  readonly config?: JsonObject;
}

export interface DesiredBackup {
  readonly id: string;
  readonly target: BackupTarget;
  readonly schedule: BackupSchedule;
  readonly enabled?: boolean;
  readonly retentionDays?: number;
}

export type CanonicalJsonValue =
  | JsonPrimitive
  | CanonicalJsonObject
  | readonly CanonicalJsonValue[];

export interface CanonicalJsonObject {
  readonly [key: string]: CanonicalJsonValue;
}

export interface CanonicalPlan {
  readonly apps: readonly CanonicalApp[];
  readonly backups: readonly CanonicalBackup[];
  readonly identity: CanonicalIdentity;
  readonly storage: CanonicalStorage;
  readonly version: typeof PLAN_VERSION;
}

export interface CanonicalIdentity {
  readonly owner?: CanonicalIdentityOwner;
  readonly passkeysRequired?: boolean;
}

export interface CanonicalIdentityOwner {
  readonly displayName?: string;
  readonly id: string;
}

export interface CanonicalStorage {
  readonly dataVolume?: CanonicalDataVolume;
}

export interface CanonicalDataVolume {
  readonly encryption?: StorageEncryptionMode;
  readonly quotaGiB?: number;
  readonly snapshots?: SnapshotCadence;
}

export interface CanonicalApp {
  readonly config?: CanonicalJsonObject;
  readonly enabled?: boolean;
  readonly id: string;
  readonly version?: string;
}

export interface CanonicalBackup {
  readonly enabled?: boolean;
  readonly id: string;
  readonly retentionDays?: number;
  readonly schedule: BackupSchedule;
  readonly target: BackupTarget;
}

type JsonRecord = Readonly<Record<string, unknown>>;

const PLAN_FIELDS = new Set(["apps", "backups", "identity", "storage", "version"]);
const IDENTITY_FIELDS = new Set(["owner", "passkeysRequired"]);
const OWNER_FIELDS = new Set(["displayName", "id"]);
const STORAGE_FIELDS = new Set(["dataVolume"]);
const DATA_VOLUME_FIELDS = new Set(["encryption", "quotaGiB", "snapshots"]);
const APP_FIELDS = new Set(["config", "enabled", "id", "version"]);
const BACKUP_FIELDS = new Set(["enabled", "id", "retentionDays", "schedule", "target"]);
const STORAGE_ENCRYPTION_MODES = new Set(["disabled", "optional", "required"]);
const SNAPSHOT_CADENCES = new Set(["disabled", "hourly", "daily", "weekly"]);
const BACKUP_TARGETS = new Set(["network", "usb"]);
const BACKUP_SCHEDULES = new Set(["hourly", "daily", "weekly", "monthly"]);

export function normalize(state: DesiredState): CanonicalPlan {
  return canonicalRecord({
    apps: sortCanonicalObjects((state.apps ?? []).map(normalizeApp)),
    backups: sortCanonicalObjects((state.backups ?? []).map(normalizeBackup)),
    identity: normalizeIdentity(state.identity),
    storage: normalizeStorage(state.storage),
    version: PLAN_VERSION,
  }) as unknown as CanonicalPlan;
}

export function planHash(plan: CanonicalPlan): string {
  return createHash("sha256")
    .update(canonicalJson(plan), "utf8")
    .digest("hex");
}

export function isCanonicalPlan(value: unknown): value is CanonicalPlan {
  try {
    return isCanonicalPlanValue(value, new Set<object>());
  } catch {
    return false;
  }
}

function isCanonicalPlanValue(
  value: unknown,
  ancestors: Set<object>,
): value is CanonicalPlan {
  return (
    isRecord(value) &&
    withCycleGuard(value, ancestors, () =>
      hasOnlyFields(value, PLAN_FIELDS) &&
      value.version === PLAN_VERSION &&
      isArrayOf(value.apps, ancestors, isCanonicalApp) &&
      isArrayOf(value.backups, ancestors, isCanonicalBackup) &&
      isCanonicalIdentity(value.identity, ancestors) &&
      isCanonicalStorage(value.storage, ancestors),
    )
  );
}

function isCanonicalIdentity(value: unknown, ancestors: Set<object>): boolean {
  return (
    isRecord(value) &&
    withCycleGuard(value, ancestors, () =>
      hasOnlyFields(value, IDENTITY_FIELDS) &&
      optionalObject(value, "owner", ancestors, isCanonicalIdentityOwner) &&
      optionalType(value, "passkeysRequired", isBoolean),
    )
  );
}

function isCanonicalIdentityOwner(value: unknown, ancestors: Set<object>): boolean {
  return (
    isRecord(value) &&
    withCycleGuard(value, ancestors, () =>
      hasOnlyFields(value, OWNER_FIELDS) &&
      typeof value.id === "string" &&
      optionalType(value, "displayName", isString),
    )
  );
}

function isCanonicalStorage(value: unknown, ancestors: Set<object>): boolean {
  return (
    isRecord(value) &&
    withCycleGuard(value, ancestors, () =>
      hasOnlyFields(value, STORAGE_FIELDS) &&
      optionalObject(value, "dataVolume", ancestors, isCanonicalDataVolume),
    )
  );
}

function isCanonicalDataVolume(value: unknown, ancestors: Set<object>): boolean {
  return (
    isRecord(value) &&
    withCycleGuard(value, ancestors, () =>
      hasOnlyFields(value, DATA_VOLUME_FIELDS) &&
      optionalStringEnum(value, "encryption", STORAGE_ENCRYPTION_MODES) &&
      optionalType(value, "quotaGiB", isFiniteNumber) &&
      optionalStringEnum(value, "snapshots", SNAPSHOT_CADENCES),
    )
  );
}

function isCanonicalApp(value: unknown, ancestors: Set<object>): boolean {
  return (
    isRecord(value) &&
    withCycleGuard(value, ancestors, () =>
      hasOnlyFields(value, APP_FIELDS) &&
      typeof value.id === "string" &&
      optionalObject(value, "config", ancestors, isCanonicalJsonObject) &&
      optionalType(value, "enabled", isBoolean) &&
      optionalType(value, "version", isString),
    )
  );
}

function isCanonicalBackup(value: unknown, ancestors: Set<object>): boolean {
  return (
    isRecord(value) &&
    withCycleGuard(value, ancestors, () =>
      hasOnlyFields(value, BACKUP_FIELDS) &&
      typeof value.id === "string" &&
      stringEnum(value.target, BACKUP_TARGETS) &&
      stringEnum(value.schedule, BACKUP_SCHEDULES) &&
      optionalType(value, "enabled", isBoolean) &&
      optionalType(value, "retentionDays", isFiniteNumber),
    )
  );
}

function optionalObject(
  value: JsonRecord,
  key: string,
  ancestors: Set<object>,
  validate: (objectValue: unknown, objectAncestors: Set<object>) => boolean,
): boolean {
  if (!Object.prototype.hasOwnProperty.call(value, key)) {
    return true;
  }

  return value[key] !== undefined && validate(value[key], ancestors);
}

function optionalType(
  value: JsonRecord,
  key: string,
  validate: (propertyValue: unknown) => boolean,
): boolean {
  if (!Object.prototype.hasOwnProperty.call(value, key)) {
    return true;
  }

  return value[key] !== undefined && validate(value[key]);
}

function optionalStringEnum(
  value: JsonRecord,
  key: string,
  allowed: ReadonlySet<string>,
): boolean {
  return optionalType(value, key, (propertyValue) => stringEnum(propertyValue, allowed));
}

function isCanonicalJsonObject(
  value: unknown,
  ancestors: Set<object>,
): value is Record<string, CanonicalJsonValue> {
  if (!isRecord(value)) {
    return false;
  }

  return withCycleGuard(value, ancestors, () => {
    for (const key of Object.keys(value)) {
      if (!isCanonicalJsonValue(value[key], ancestors)) {
        return false;
      }
    }

    return true;
  });
}

function isCanonicalJsonValue(
  value: unknown,
  ancestors: Set<object>,
): value is CanonicalJsonValue {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    isFiniteNumber(value)
  ) {
    return true;
  }

  if (Array.isArray(value)) {
    return withCycleGuard(value, ancestors, () => {
      for (let index = 0; index < value.length; index += 1) {
        if (
          !Object.prototype.hasOwnProperty.call(value, index) ||
          !isCanonicalJsonValue(value[index], ancestors)
        ) {
          return false;
        }
      }

      return true;
    });
  }

  return isCanonicalJsonObject(value, ancestors);
}

function isArrayOf(
  value: unknown,
  ancestors: Set<object>,
  validate: (item: unknown, itemAncestors: Set<object>) => boolean,
): boolean {
  if (!Array.isArray(value)) {
    return false;
  }

  return withCycleGuard(value, ancestors, () => {
    for (let index = 0; index < value.length; index += 1) {
      if (
        !Object.prototype.hasOwnProperty.call(value, index) ||
        !validate(value[index], ancestors)
      ) {
        return false;
      }
    }

    return true;
  });
}

function withCycleGuard(
  value: object,
  ancestors: Set<object>,
  validate: () => boolean,
): boolean {
  if (ancestors.has(value)) {
    return false;
  }

  ancestors.add(value);

  try {
    return validate();
  } finally {
    ancestors.delete(value);
  }
}

function hasOnlyFields(value: JsonRecord, allowed: ReadonlySet<string>): boolean {
  return Object.keys(value).every((key) => allowed.has(key));
}

function isRecord(value: unknown): value is JsonRecord {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }

  const prototype = Object.getPrototypeOf(value);

  return prototype === Object.prototype || prototype === null;
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

function isBoolean(value: unknown): value is boolean {
  return typeof value === "boolean";
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function stringEnum(value: unknown, allowed: ReadonlySet<string>): boolean {
  return typeof value === "string" && allowed.has(value);
}

function normalizeIdentity(identity: DesiredIdentity | undefined): CanonicalIdentity {
  return canonicalRecord({
    owner:
      identity?.owner === undefined
        ? undefined
        : canonicalRecord({
            displayName: identity.owner.displayName,
            id: identity.owner.id,
          }),
    passkeysRequired: identity?.passkeysRequired,
  }) as unknown as CanonicalIdentity;
}

function normalizeStorage(storage: DesiredStorage | undefined): CanonicalStorage {
  return canonicalRecord({
    dataVolume:
      storage?.dataVolume === undefined
        ? undefined
        : canonicalRecord({
            encryption: storage.dataVolume.encryption,
            quotaGiB: storage.dataVolume.quotaGiB,
            snapshots: storage.dataVolume.snapshots,
          }),
  }) as unknown as CanonicalStorage;
}

function normalizeApp(app: DesiredApp): CanonicalApp {
  return canonicalRecord({
    config: app.config === undefined ? undefined : canonicalize(app.config),
    enabled: app.enabled,
    id: app.id,
    version: app.version,
  }) as unknown as CanonicalApp;
}

function normalizeBackup(backup: DesiredBackup): CanonicalBackup {
  return canonicalRecord({
    enabled: backup.enabled,
    id: backup.id,
    retentionDays: backup.retentionDays,
    schedule: backup.schedule,
    target: backup.target,
  }) as unknown as CanonicalBackup;
}

function sortCanonicalObjects<T>(items: readonly T[]): readonly T[] {
  return [...items].sort((left, right) =>
    compareCanonicalJson(canonicalJson(left), canonicalJson(right)),
  );
}

function canonicalJson(value: unknown): string {
  const canonical = canonicalize(value);

  if (canonical === undefined) {
    throw new TypeError("Canonical plan values cannot be undefined.");
  }

  return JSON.stringify(canonical);
}

function canonicalRecord(value: Record<string, unknown>): CanonicalJsonObject {
  const canonical = canonicalize(value);

  if (!isCanonicalJsonRecord(canonical)) {
    throw new TypeError("Expected a canonical object.");
  }

  return canonical;
}

function isCanonicalJsonRecord(
  value: CanonicalJsonValue | undefined,
): value is CanonicalJsonObject {
  return value !== undefined && value !== null && typeof value === "object" && !Array.isArray(value);
}

function canonicalize(value: unknown): CanonicalJsonValue | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return value;
  }

  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new TypeError("Plan numbers must be finite.");
    }

    return value;
  }

  if (Array.isArray(value)) {
    const items: CanonicalJsonValue[] = [];

    for (const item of value) {
      const canonicalItem = canonicalize(item);

      if (canonicalItem !== undefined) {
        items.push(canonicalItem);
      }
    }

    return items;
  }

  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    const output: Record<string, CanonicalJsonValue> = {};

    for (const key of Object.keys(record).sort()) {
      const canonicalValue = canonicalize(record[key]);

      if (canonicalValue !== undefined) {
        output[key] = canonicalValue;
      }
    }

    return output;
  }

  throw new TypeError(`Unsupported plan value type: ${typeof value}.`);
}

function compareCanonicalJson(left: string, right: string): number {
  if (left < right) {
    return -1;
  }

  if (left > right) {
    return 1;
  }

  return 0;
}
