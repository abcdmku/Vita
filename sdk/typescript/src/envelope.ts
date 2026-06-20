import { createHash } from "node:crypto";

import { PLAN_VERSION } from "./plan.ts";
import type { CanonicalJsonValue, CanonicalPlan } from "./plan.ts";

export const PLAN_ENVELOPE_SCHEMA_VERSION = 1;

export interface PlanEnvelope {
  readonly schemaVersion: number;
  /**
   * Legacy field name for the envelope digest. This is an unkeyed SHA-256
   * corruption check over schemaVersion, createdAtRef, and plan; it is not a
   * signature or authenticity boundary.
   */
  readonly planHash: string;
  readonly plan: CanonicalPlan;
  readonly createdAtRef: string;
}

export interface PlanEnvelopeMeta {
  readonly createdAtRef: string;
}

/**
 * Adds an unkeyed recomputable digest for deterministic corruption detection.
 * Authenticity/signing belongs to the trusted Go agent, not this SDK helper.
 */
export function sealEnvelope(plan: CanonicalPlan, meta: PlanEnvelopeMeta): PlanEnvelope {
  const schemaVersion = PLAN_ENVELOPE_SCHEMA_VERSION;
  const createdAtRef = meta.createdAtRef;

  return {
    schemaVersion,
    planHash: envelopeHash(schemaVersion, createdAtRef, plan),
    plan,
    createdAtRef,
  };
}

/**
 * Checks the unkeyed envelope digest and canonical plan structure.
 * A true result detects accidental corruption only; it is not tamper-proof.
 */
export function verifyEnvelope(env: unknown): boolean {
  try {
    if (!isRecord(env) || !hasOnlyFields(env, ENVELOPE_FIELDS)) {
      return false;
    }

    const { schemaVersion, planHash, plan, createdAtRef } = env;

    if (
      schemaVersion !== PLAN_ENVELOPE_SCHEMA_VERSION ||
      typeof planHash !== "string" ||
      typeof createdAtRef !== "string" ||
      !isCanonicalPlan(plan)
    ) {
      return false;
    }

    return (
      planHash === envelopeHash(schemaVersion, createdAtRef, plan)
    );
  } catch {
    return false;
  }
}

export function encodeEnvelope(env: PlanEnvelope): string {
  return canonicalJson(env);
}

function envelopeHash(
  schemaVersion: number,
  createdAtRef: string,
  plan: CanonicalPlan,
): string {
  return createHash("sha256")
    .update(canonicalJson({ createdAtRef, plan, schemaVersion }), "utf8")
    .digest("hex");
}

function canonicalJson(value: unknown): string {
  const canonical = canonicalize(value);

  if (canonical === undefined) {
    throw new TypeError("Canonical envelope values cannot be undefined.");
  }

  return JSON.stringify(canonical);
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
      throw new TypeError("Envelope numbers must be finite.");
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

  throw new TypeError(`Unsupported envelope value type: ${typeof value}.`);
}

type JsonRecord = Readonly<Record<string, unknown>>;

const ENVELOPE_FIELDS = new Set(["createdAtRef", "plan", "planHash", "schemaVersion"]);
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

function isCanonicalPlan(value: unknown): value is CanonicalPlan {
  return (
    isRecord(value) &&
    hasOnlyFields(value, PLAN_FIELDS) &&
    value.version === PLAN_VERSION &&
    Array.isArray(value.apps) &&
    value.apps.every(isCanonicalApp) &&
    Array.isArray(value.backups) &&
    value.backups.every(isCanonicalBackup) &&
    isCanonicalIdentity(value.identity) &&
    isCanonicalStorage(value.storage)
  );
}

function isCanonicalIdentity(value: unknown): boolean {
  return (
    isRecord(value) &&
    hasOnlyFields(value, IDENTITY_FIELDS) &&
    optionalObject(value, "owner", isCanonicalIdentityOwner) &&
    optionalType(value, "passkeysRequired", isBoolean)
  );
}

function isCanonicalIdentityOwner(value: unknown): boolean {
  return (
    isRecord(value) &&
    hasOnlyFields(value, OWNER_FIELDS) &&
    typeof value.id === "string" &&
    optionalType(value, "displayName", isString)
  );
}

function isCanonicalStorage(value: unknown): boolean {
  return (
    isRecord(value) &&
    hasOnlyFields(value, STORAGE_FIELDS) &&
    optionalObject(value, "dataVolume", isCanonicalDataVolume)
  );
}

function isCanonicalDataVolume(value: unknown): boolean {
  return (
    isRecord(value) &&
    hasOnlyFields(value, DATA_VOLUME_FIELDS) &&
    optionalStringEnum(value, "encryption", STORAGE_ENCRYPTION_MODES) &&
    optionalType(value, "quotaGiB", isFiniteNumber) &&
    optionalStringEnum(value, "snapshots", SNAPSHOT_CADENCES)
  );
}

function isCanonicalApp(value: unknown): boolean {
  return (
    isRecord(value) &&
    hasOnlyFields(value, APP_FIELDS) &&
    typeof value.id === "string" &&
    optionalObject(value, "config", isCanonicalJsonObject) &&
    optionalType(value, "enabled", isBoolean) &&
    optionalType(value, "version", isString)
  );
}

function isCanonicalBackup(value: unknown): boolean {
  return (
    isRecord(value) &&
    hasOnlyFields(value, BACKUP_FIELDS) &&
    typeof value.id === "string" &&
    stringEnum(value.target, BACKUP_TARGETS) &&
    stringEnum(value.schedule, BACKUP_SCHEDULES) &&
    optionalType(value, "enabled", isBoolean) &&
    optionalType(value, "retentionDays", isFiniteNumber)
  );
}

function optionalObject(
  value: JsonRecord,
  key: string,
  validate: (objectValue: unknown) => boolean,
): boolean {
  if (!Object.prototype.hasOwnProperty.call(value, key)) {
    return true;
  }

  return value[key] !== undefined && validate(value[key]);
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

function isCanonicalJsonObject(value: unknown): value is Record<string, CanonicalJsonValue> {
  return isRecord(value) && Object.values(value).every(isCanonicalJsonValue);
}

function isCanonicalJsonValue(value: unknown): value is CanonicalJsonValue {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    isFiniteNumber(value)
  ) {
    return true;
  }

  if (Array.isArray(value)) {
    return value.every(isCanonicalJsonValue);
  }

  return isCanonicalJsonObject(value);
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
