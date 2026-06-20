import { safeNormalize } from "./safe-normalize.ts";
import type { PlainJson } from "./safe-normalize.ts";

export type BackupTargetKind =
  | "local-snapshot"
  | "attached-disk"
  | "peer-node"
  | "remote-object"
  | "sftp"
  | "vendor-managed";

export type BackupCadence = "hourly" | "daily" | "weekly" | "monthly";
export type RestoreMode = "full-node" | "file" | "app" | "system-state";
export type RecoveryKeyEnrollmentStatus = "active" | "rotating" | "revoked";

export type OpaqueRef = string;

export interface RecoveryKeyRef {
  readonly id: OpaqueRef;
  readonly handle: OpaqueRef;
  readonly keyStoreRef?: OpaqueRef;
}

export interface BackupSchedule {
  readonly cadence: BackupCadence;
  readonly interval: number;
  readonly startAt: string;
}

export type BackupTarget =
  | {
      readonly kind: "local-snapshot";
    }
  | {
      readonly kind: "attached-disk";
      readonly deviceRef: OpaqueRef;
    }
  | {
      readonly kind: "peer-node";
      readonly nodeRef: OpaqueRef;
    }
  | {
      readonly kind: "remote-object";
      readonly bucketRef: OpaqueRef;
      readonly credentialRef: OpaqueRef;
    }
  | {
      readonly kind: "sftp";
      readonly endpointRef: OpaqueRef;
      readonly credentialRef: OpaqueRef;
    }
  | {
      readonly kind: "vendor-managed";
      readonly serviceRef: OpaqueRef;
      readonly accountRef: OpaqueRef;
    };

export interface BackupPolicy {
  readonly id: OpaqueRef;
  readonly target: BackupTarget;
  readonly schedule: BackupSchedule;
  readonly retentionDays: number;
  readonly createdAt: string;
  readonly enabled?: boolean;
  readonly recoveryKeyRef?: RecoveryKeyRef;
}

export interface RestorePlan {
  readonly id: OpaqueRef;
  readonly mode: RestoreMode;
  readonly backupPolicyRef: OpaqueRef;
  readonly targetNodeRef: OpaqueRef;
  readonly requestedAt: string;
  readonly backupSnapshotRef?: OpaqueRef;
  readonly recoveryKeyRef?: RecoveryKeyRef;
}

export interface RecoveryKeyEnrollment {
  readonly id: OpaqueRef;
  readonly subjectRef: OpaqueRef;
  readonly recoveryKeyRef: RecoveryKeyRef;
  readonly credentialRef: OpaqueRef;
  readonly enrolledAt: string;
  readonly expiresAt?: string;
  readonly status?: RecoveryKeyEnrollmentStatus;
}

export interface BackupModelValidationError {
  readonly path: string;
  readonly message: string;
}

export type BackupPolicyValidationResult =
  | {
      readonly ok: true;
      readonly policy: BackupPolicy;
      readonly value: BackupPolicy;
    }
  | {
      readonly ok: false;
      readonly errors: readonly BackupModelValidationError[];
    };

export type RecoveryKeyEnrollmentValidationResult =
  | {
      readonly ok: true;
      readonly enrollment: RecoveryKeyEnrollment;
      readonly value: RecoveryKeyEnrollment;
    }
  | {
      readonly ok: false;
      readonly errors: readonly BackupModelValidationError[];
    };

type JsonRecord = Readonly<Record<string, PlainJson>>;
type Path = readonly string[];

const BACKUP_POLICY_FIELDS = new Set([
  "createdAt",
  "enabled",
  "id",
  "recoveryKeyRef",
  "retentionDays",
  "schedule",
  "target",
]);
const BACKUP_SCHEDULE_FIELDS = new Set(["cadence", "interval", "startAt"]);
const RECOVERY_KEY_REF_FIELDS = new Set(["handle", "id", "keyStoreRef"]);
const RECOVERY_KEY_ENROLLMENT_FIELDS = new Set([
  "credentialRef",
  "enrolledAt",
  "expiresAt",
  "id",
  "recoveryKeyRef",
  "status",
  "subjectRef",
]);

const LOCAL_SNAPSHOT_TARGET_FIELDS = new Set(["kind"]);
const ATTACHED_DISK_TARGET_FIELDS = new Set(["deviceRef", "kind"]);
const PEER_NODE_TARGET_FIELDS = new Set(["kind", "nodeRef"]);
const REMOTE_OBJECT_TARGET_FIELDS = new Set(["bucketRef", "credentialRef", "kind"]);
const SFTP_TARGET_FIELDS = new Set(["credentialRef", "endpointRef", "kind"]);
const VENDOR_MANAGED_TARGET_FIELDS = new Set(["accountRef", "kind", "serviceRef"]);

const BACKUP_CADENCES = new Set<BackupCadence>(["hourly", "daily", "weekly", "monthly"]);
const BACKUP_TARGET_KINDS = new Set<BackupTargetKind>([
  "attached-disk",
  "local-snapshot",
  "peer-node",
  "remote-object",
  "sftp",
  "vendor-managed",
]);
const RECOVERY_KEY_ENROLLMENT_STATUSES = new Set<RecoveryKeyEnrollmentStatus>([
  "active",
  "revoked",
  "rotating",
]);

const MAX_RETENTION_DAYS = 3650;
const MAX_REF_LENGTH = 2048;
const OPAQUE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@-]{2,159}$/;
const ISO_DATE_TIME_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})T([01]\d|2[0-3]):([0-5]\d):([0-5]\d)(?:\.\d{1,9})?(Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/;

const SECRET_FIELD_NAMES = new Set([
  "key",
  "keyMaterial",
  "mnemonic",
  "passphrase",
  "privateKey",
  "recoveryKey",
  "seed",
  "seedPhrase",
  "secret",
]);
const INLINE_REFERENCE_SCHEMES = new Set(["data", "inline", "literal"]);

const PEM_BLOCK_PATTERN = /-----BEGIN\b/i;
const PRIVATE_KEY_PATTERN =
  /\b(?:private[-_\s]?key|openssh\s+private\s+key|age-secret-key|xprv|seed[-_\s]?phrase|mnemonic|recovery[-_\s]?phrase)\b/i;
const SECRET_ASSIGNMENT_PATTERN =
  /\b(?:private[-_\s]?key|api[-_\s]?key|access[-_\s]?token|refresh[-_\s]?token|password|secret)\s*(?:=|:(?!\/\/))/i;
const SEED_WORDS_PATTERN = /\b[a-z]{3,12}(?:\s+[a-z]{3,12}){11,23}\b/i;
const LONG_HEX_PATTERN = /(?:0x)?[A-Fa-f0-9]{32,}/;
const LONG_BASE64_PATTERN = /[A-Za-z0-9+/]{48,}={0,2}|[A-Za-z0-9_-]{48,}/;

export function validateBackupPolicy(input: unknown): BackupPolicyValidationResult {
  try {
    const normalized = safeNormalize(input);

    if (!normalized.ok) {
      return reject([{ path: "", message: normalized.reason }]);
    }

    const errors: BackupModelValidationError[] = [];
    const policy = parseBackupPolicy(normalized.value, [], errors);

    if (policy === undefined || errors.length > 0) {
      return reject(errors);
    }

    return {
      ok: true,
      policy,
      value: policy,
    };
  } catch {
    return reject([{ path: "", message: "Backup policy validation failed." }]);
  }
}

export function validateRecoveryKeyEnrollment(
  input: unknown,
): RecoveryKeyEnrollmentValidationResult {
  try {
    const normalized = safeNormalize(input);

    if (!normalized.ok) {
      return reject([{ path: "", message: normalized.reason }]);
    }

    const errors: BackupModelValidationError[] = [];
    const enrollment = parseRecoveryKeyEnrollment(normalized.value, [], errors);

    if (enrollment === undefined || errors.length > 0) {
      return reject(errors);
    }

    return {
      ok: true,
      enrollment,
      value: enrollment,
    };
  } catch {
    return reject([{ path: "", message: "Recovery-key enrollment validation failed." }]);
  }
}

function parseBackupPolicy(
  value: PlainJson,
  path: Path,
  errors: BackupModelValidationError[],
): BackupPolicy | undefined {
  const errorStart = errors.length;

  if (!isRecord(value)) {
    addError(errors, path, "Expected backup policy object.");
    return undefined;
  }

  rejectUnknownFields(value, BACKUP_POLICY_FIELDS, path, errors);
  rejectSecretFieldNames(value, path, errors);

  const id = validateRequiredOpaqueRef(value, "id", [...path, "id"], errors);
  const target = parseBackupTarget(value.target, [...path, "target"], errors);
  const schedule = parseBackupSchedule(value.schedule, [...path, "schedule"], errors);
  const retentionDays = validateRequiredInteger(
    value,
    "retentionDays",
    [...path, "retentionDays"],
    1,
    MAX_RETENTION_DAYS,
    errors,
  );
  const createdAt = validateRequiredDateTime(value, "createdAt", [...path, "createdAt"], errors);
  const enabled = validateOptionalBoolean(value, "enabled", [...path, "enabled"], errors);
  const recoveryKeyRef = hasDefinedProperty(value, "recoveryKeyRef")
    ? parseRecoveryKeyRef(value.recoveryKeyRef, [...path, "recoveryKeyRef"], errors)
    : undefined;

  if (
    errors.length > errorStart ||
    id === undefined ||
    target === undefined ||
    schedule === undefined ||
    retentionDays === undefined ||
    createdAt === undefined
  ) {
    return undefined;
  }

  return {
    createdAt,
    id,
    retentionDays,
    schedule,
    target,
    ...(enabled === undefined ? {} : { enabled }),
    ...(recoveryKeyRef === undefined ? {} : { recoveryKeyRef }),
  };
}

function parseRecoveryKeyEnrollment(
  value: PlainJson,
  path: Path,
  errors: BackupModelValidationError[],
): RecoveryKeyEnrollment | undefined {
  const errorStart = errors.length;

  if (!isRecord(value)) {
    addError(errors, path, "Expected recovery-key enrollment object.");
    return undefined;
  }

  rejectUnknownFields(value, RECOVERY_KEY_ENROLLMENT_FIELDS, path, errors);
  rejectSecretFieldNames(value, path, errors);

  const id = validateRequiredOpaqueRef(value, "id", [...path, "id"], errors);
  const subjectRef = validateRequiredOpaqueRef(value, "subjectRef", [...path, "subjectRef"], errors);
  const recoveryKeyRef = parseRecoveryKeyRef(
    value.recoveryKeyRef,
    [...path, "recoveryKeyRef"],
    errors,
  );
  const credentialRef = validateRequiredOpaqueRef(
    value,
    "credentialRef",
    [...path, "credentialRef"],
    errors,
  );
  const enrolledAt = validateRequiredDateTime(value, "enrolledAt", [...path, "enrolledAt"], errors);
  const expiresAt = validateOptionalDateTime(value, "expiresAt", [...path, "expiresAt"], errors);
  const status = validateOptionalStringEnum(
    value,
    "status",
    RECOVERY_KEY_ENROLLMENT_STATUSES,
    [...path, "status"],
    errors,
  );

  if (
    errors.length > errorStart ||
    id === undefined ||
    subjectRef === undefined ||
    recoveryKeyRef === undefined ||
    credentialRef === undefined ||
    enrolledAt === undefined
  ) {
    return undefined;
  }

  return {
    credentialRef,
    enrolledAt,
    id,
    recoveryKeyRef,
    subjectRef,
    ...(expiresAt === undefined ? {} : { expiresAt }),
    ...(status === undefined ? {} : { status }),
  };
}

function parseBackupTarget(
  value: PlainJson | undefined,
  path: Path,
  errors: BackupModelValidationError[],
): BackupTarget | undefined {
  const errorStart = errors.length;

  if (value === undefined) {
    addError(errors, path, "Required field is missing.");
    return undefined;
  }

  if (!isRecord(value)) {
    addError(errors, path, "Expected backup target object.");
    return undefined;
  }

  rejectSecretFieldNames(value, path, errors);

  if (!hasDefinedProperty(value, "kind")) {
    addError(errors, [...path, "kind"], "Required field is missing.");
    return undefined;
  }

  if (!isStringInSet(value.kind, BACKUP_TARGET_KINDS)) {
    addError(errors, [...path, "kind"], "Expected a supported backup target kind.");
    return undefined;
  }

  switch (value.kind) {
    case "local-snapshot":
      rejectUnknownFields(value, LOCAL_SNAPSHOT_TARGET_FIELDS, path, errors);

      if (errors.length > errorStart) {
        return undefined;
      }

      return {
        kind: "local-snapshot",
      };
    case "attached-disk": {
      rejectUnknownFields(value, ATTACHED_DISK_TARGET_FIELDS, path, errors);
      const deviceRef = validateRequiredOpaqueRef(value, "deviceRef", [...path, "deviceRef"], errors);

      if (errors.length > errorStart || deviceRef === undefined) {
        return undefined;
      }

      return {
        deviceRef,
        kind: "attached-disk",
      };
    }
    case "peer-node": {
      rejectUnknownFields(value, PEER_NODE_TARGET_FIELDS, path, errors);
      const nodeRef = validateRequiredOpaqueRef(value, "nodeRef", [...path, "nodeRef"], errors);

      if (errors.length > errorStart || nodeRef === undefined) {
        return undefined;
      }

      return {
        kind: "peer-node",
        nodeRef,
      };
    }
    case "remote-object": {
      rejectUnknownFields(value, REMOTE_OBJECT_TARGET_FIELDS, path, errors);
      const bucketRef = validateRequiredOpaqueRef(value, "bucketRef", [...path, "bucketRef"], errors);
      const credentialRef = validateRequiredOpaqueRef(
        value,
        "credentialRef",
        [...path, "credentialRef"],
        errors,
      );

      if (errors.length > errorStart || bucketRef === undefined || credentialRef === undefined) {
        return undefined;
      }

      return {
        bucketRef,
        credentialRef,
        kind: "remote-object",
      };
    }
    case "sftp": {
      rejectUnknownFields(value, SFTP_TARGET_FIELDS, path, errors);
      const endpointRef = validateRequiredOpaqueRef(
        value,
        "endpointRef",
        [...path, "endpointRef"],
        errors,
      );
      const credentialRef = validateRequiredOpaqueRef(
        value,
        "credentialRef",
        [...path, "credentialRef"],
        errors,
      );

      if (errors.length > errorStart || endpointRef === undefined || credentialRef === undefined) {
        return undefined;
      }

      return {
        credentialRef,
        endpointRef,
        kind: "sftp",
      };
    }
    case "vendor-managed": {
      rejectUnknownFields(value, VENDOR_MANAGED_TARGET_FIELDS, path, errors);
      const accountRef = validateRequiredOpaqueRef(value, "accountRef", [...path, "accountRef"], errors);
      const serviceRef = validateRequiredOpaqueRef(value, "serviceRef", [...path, "serviceRef"], errors);

      if (errors.length > errorStart || accountRef === undefined || serviceRef === undefined) {
        return undefined;
      }

      return {
        accountRef,
        kind: "vendor-managed",
        serviceRef,
      };
    }
  }
}

function parseBackupSchedule(
  value: PlainJson | undefined,
  path: Path,
  errors: BackupModelValidationError[],
): BackupSchedule | undefined {
  const errorStart = errors.length;

  if (value === undefined) {
    addError(errors, path, "Required field is missing.");
    return undefined;
  }

  if (!isRecord(value)) {
    addError(errors, path, "Expected backup schedule object.");
    return undefined;
  }

  rejectUnknownFields(value, BACKUP_SCHEDULE_FIELDS, path, errors);
  rejectSecretFieldNames(value, path, errors);

  const cadence = validateRequiredStringEnum(
    value,
    "cadence",
    BACKUP_CADENCES,
    [...path, "cadence"],
    errors,
  );
  const interval = validateRequiredInteger(
    value,
    "interval",
    [...path, "interval"],
    1,
    maxIntervalForCadence(cadence),
    errors,
  );
  const startAt = validateRequiredDateTime(value, "startAt", [...path, "startAt"], errors);

  if (
    errors.length > errorStart ||
    cadence === undefined ||
    interval === undefined ||
    startAt === undefined
  ) {
    return undefined;
  }

  return {
    cadence,
    interval,
    startAt,
  };
}

function parseRecoveryKeyRef(
  value: PlainJson | undefined,
  path: Path,
  errors: BackupModelValidationError[],
): RecoveryKeyRef | undefined {
  const errorStart = errors.length;

  if (value === undefined) {
    addError(errors, path, "Required field is missing.");
    return undefined;
  }

  if (!isRecord(value)) {
    addError(errors, path, "Expected recovery key reference object.");
    return undefined;
  }

  rejectUnknownFields(value, RECOVERY_KEY_REF_FIELDS, path, errors);
  rejectSecretFieldNames(value, path, errors);

  const id = validateRequiredOpaqueRef(value, "id", [...path, "id"], errors);
  const handle = validateRequiredOpaqueRef(value, "handle", [...path, "handle"], errors);
  const keyStoreRef = validateOptionalOpaqueRef(
    value,
    "keyStoreRef",
    [...path, "keyStoreRef"],
    errors,
  );

  if (errors.length > errorStart || id === undefined || handle === undefined) {
    return undefined;
  }

  return {
    handle,
    id,
    ...(keyStoreRef === undefined ? {} : { keyStoreRef }),
  };
}

function validateRequiredOpaqueRef(
  value: JsonRecord,
  key: string,
  path: Path,
  errors: BackupModelValidationError[],
): OpaqueRef | undefined {
  if (!hasDefinedProperty(value, key)) {
    addError(errors, path, "Required field is missing.");
    return undefined;
  }

  const refValue = value[key];

  if (refValue === undefined) {
    addError(errors, path, "Required field is missing.");
    return undefined;
  }

  return validateOpaqueRefValue(refValue, path, errors);
}

function validateOptionalOpaqueRef(
  value: JsonRecord,
  key: string,
  path: Path,
  errors: BackupModelValidationError[],
): OpaqueRef | undefined {
  if (!hasDefinedProperty(value, key)) {
    return undefined;
  }

  const refValue = value[key];

  if (refValue === undefined) {
    return undefined;
  }

  return validateOpaqueRefValue(refValue, path, errors);
}

function validateOpaqueRefValue(
  value: PlainJson,
  path: Path,
  errors: BackupModelValidationError[],
): OpaqueRef | undefined {
  if (typeof value !== "string" || value.length === 0) {
    addError(errors, path, "Expected opaque reference string.");
    return undefined;
  }

  if (containsInlineSecretMaterial(value)) {
    addError(errors, path, "Reference must not contain inline key material.");
    return undefined;
  }

  if (value.length > MAX_REF_LENGTH || !isReferenceSyntax(value)) {
    addError(errors, path, "Expected opaque reference syntax.");
    return undefined;
  }

  return value;
}

function validateRequiredDateTime(
  value: JsonRecord,
  key: string,
  path: Path,
  errors: BackupModelValidationError[],
): string | undefined {
  if (!hasDefinedProperty(value, key)) {
    addError(errors, path, "Required field is missing.");
    return undefined;
  }

  const dateTimeValue = value[key];

  if (dateTimeValue === undefined) {
    addError(errors, path, "Required field is missing.");
    return undefined;
  }

  return validateDateTimeValue(dateTimeValue, path, errors);
}

function validateOptionalDateTime(
  value: JsonRecord,
  key: string,
  path: Path,
  errors: BackupModelValidationError[],
): string | undefined {
  if (!hasDefinedProperty(value, key)) {
    return undefined;
  }

  const dateTimeValue = value[key];

  if (dateTimeValue === undefined) {
    return undefined;
  }

  return validateDateTimeValue(dateTimeValue, path, errors);
}

function validateDateTimeValue(
  value: PlainJson,
  path: Path,
  errors: BackupModelValidationError[],
): string | undefined {
  if (typeof value !== "string" || !isIsoDateTime(value)) {
    addError(errors, path, "Expected ISO-8601 date-time with timezone.");
    return undefined;
  }

  return value;
}

function validateRequiredStringEnum<T extends string>(
  value: JsonRecord,
  key: string,
  allowed: ReadonlySet<T>,
  path: Path,
  errors: BackupModelValidationError[],
): T | undefined {
  if (!hasDefinedProperty(value, key)) {
    addError(errors, path, "Required field is missing.");
    return undefined;
  }

  if (!isStringInSet(value[key], allowed)) {
    addError(errors, path, `Expected one of: ${[...allowed].join(", ")}.`);
    return undefined;
  }

  return value[key];
}

function validateOptionalStringEnum<T extends string>(
  value: JsonRecord,
  key: string,
  allowed: ReadonlySet<T>,
  path: Path,
  errors: BackupModelValidationError[],
): T | undefined {
  if (!hasDefinedProperty(value, key)) {
    return undefined;
  }

  if (!isStringInSet(value[key], allowed)) {
    addError(errors, path, `Expected one of: ${[...allowed].join(", ")}.`);
    return undefined;
  }

  return value[key];
}

function validateRequiredInteger(
  value: JsonRecord,
  key: string,
  path: Path,
  min: number,
  max: number,
  errors: BackupModelValidationError[],
): number | undefined {
  if (!hasDefinedProperty(value, key)) {
    addError(errors, path, "Required field is missing.");
    return undefined;
  }

  if (!isIntegerInRange(value[key], min, max)) {
    addError(errors, path, `Expected integer from ${min} to ${max}.`);
    return undefined;
  }

  return value[key];
}

function validateOptionalBoolean(
  value: JsonRecord,
  key: string,
  path: Path,
  errors: BackupModelValidationError[],
): boolean | undefined {
  if (!hasDefinedProperty(value, key)) {
    return undefined;
  }

  if (typeof value[key] !== "boolean") {
    addError(errors, path, "Expected boolean.");
    return undefined;
  }

  return value[key];
}

function rejectUnknownFields(
  value: JsonRecord,
  allowed: ReadonlySet<string>,
  path: Path,
  errors: BackupModelValidationError[],
): void {
  const keys = Object.keys(value).sort(compareStrings);

  for (let index = 0; index < keys.length; index += 1) {
    const key = keys[index];

    if (key !== undefined && !allowed.has(key)) {
      addError(errors, [...path, key], "Unknown field.");
    }
  }
}

function rejectSecretFieldNames(
  value: JsonRecord,
  path: Path,
  errors: BackupModelValidationError[],
): void {
  const keys = Object.keys(value).sort(compareStrings);

  for (let index = 0; index < keys.length; index += 1) {
    const key = keys[index];

    if (key !== undefined && SECRET_FIELD_NAMES.has(key)) {
      addError(errors, [...path, key], "Inline key material is not allowed.");
    }
  }
}

function containsInlineSecretMaterial(value: string): boolean {
  if (
    /[\u0000-\u001f\u007f]/u.test(value) ||
    PEM_BLOCK_PATTERN.test(value) ||
    PRIVATE_KEY_PATTERN.test(value) ||
    SECRET_ASSIGNMENT_PATTERN.test(value) ||
    SEED_WORDS_PATTERN.test(value)
  ) {
    return true;
  }

  return LONG_HEX_PATTERN.test(value) || LONG_BASE64_PATTERN.test(value);
}

function isReferenceSyntax(value: string): boolean {
  if (value !== value.trim() || /[\s<>{}`"']/u.test(value)) {
    return false;
  }

  const separator = value.indexOf("://");

  if (separator === -1) {
    return OPAQUE_ID_PATTERN.test(value);
  }

  if (separator <= 0 || separator === value.length - 3) {
    return false;
  }

  const scheme = value.slice(0, separator).toLowerCase();
  const body = value.slice(separator + 3);

  return /^[a-z][a-z0-9+.-]*$/u.test(scheme) && !INLINE_REFERENCE_SCHEMES.has(scheme) && body !== "";
}

function isIsoDateTime(value: string): boolean {
  const match = ISO_DATE_TIME_PATTERN.exec(value);

  if (match === null) {
    return false;
  }

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);

  if (
    !Number.isSafeInteger(year) ||
    !Number.isSafeInteger(month) ||
    !Number.isSafeInteger(day) ||
    month < 1 ||
    month > 12
  ) {
    return false;
  }

  return day >= 1 && day <= daysInMonth(year, month);
}

function daysInMonth(year: number, month: number): number {
  switch (month) {
    case 2:
      return isLeapYear(year) ? 29 : 28;
    case 4:
    case 6:
    case 9:
    case 11:
      return 30;
    default:
      return 31;
  }
}

function isLeapYear(year: number): boolean {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

function maxIntervalForCadence(cadence: BackupCadence | undefined): number {
  switch (cadence) {
    case "hourly":
      return 24;
    case "daily":
      return 31;
    case "weekly":
      return 52;
    case "monthly":
      return 12;
    default:
      return 1;
  }
}

function isRecord(value: PlainJson | undefined): value is JsonRecord {
  return value !== undefined && value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasDefinedProperty(value: JsonRecord, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key) && value[key] !== undefined;
}

function isStringInSet<T extends string>(value: PlainJson | undefined, allowed: ReadonlySet<T>): value is T {
  return typeof value === "string" && allowed.has(value as T);
}

function isIntegerInRange(value: PlainJson | undefined, min: number, max: number): value is number {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= min &&
    value <= max
  );
}

function reject(
  errors: readonly BackupModelValidationError[],
): Extract<BackupPolicyValidationResult, { readonly ok: false }> {
  return {
    ok: false,
    errors,
  };
}

function addError(
  errors: BackupModelValidationError[],
  path: Path,
  message: string,
): void {
  errors.push({
    message,
    path: formatPath(path),
  });
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
