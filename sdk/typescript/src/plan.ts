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

  if (
    canonical === undefined ||
    canonical === null ||
    typeof canonical !== "object" ||
    Array.isArray(canonical)
  ) {
    throw new TypeError("Expected a canonical object.");
  }

  return canonical;
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
