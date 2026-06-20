import { validateRecoveryKeyEnrollment as validateBackupRecoveryKeyEnrollment } from "./backup-model.ts";
import { safeNormalize } from "./safe-normalize.ts";
import type {
  BackupModelValidationError,
  RecoveryKeyEnrollment,
  RecoveryKeyRef,
} from "./backup-model.ts";
import type { PlainJson, PlainJsonObject } from "./safe-normalize.ts";

export interface RecoveryQuorum {
  readonly threshold: number;
  readonly shares: readonly RecoveryKeyRef[];
}

export interface RecoveryEnrollment extends RecoveryKeyEnrollment {
  readonly quorum: RecoveryQuorum;
}

export interface RecoveryRotation {
  readonly oldEnrollment: RecoveryEnrollment;
  readonly newEnrollment: RecoveryEnrollment;
  readonly ownerApprovedThresholdChange?: boolean;
}

export interface RecoveryAttempt {
  readonly quorum: RecoveryQuorum;
  readonly presentedShareRefs: readonly RecoveryKeyRef[];
}

export interface RecoveryKeyValidationError {
  readonly path: string;
  readonly message: string;
}

type Rejection = {
  readonly ok: false;
  readonly errors: readonly RecoveryKeyValidationError[];
};

export type RecoveryEnrollmentValidationResult =
  | {
      readonly ok: true;
      readonly enrollment: RecoveryEnrollment;
      readonly value: RecoveryEnrollment;
    }
  | Rejection;

export type RecoveryRotationValidationResult =
  | {
      readonly ok: true;
      readonly rotation: RecoveryRotation;
      readonly value: RecoveryRotation;
    }
  | Rejection;

export type RecoveryAttemptValidationResult =
  | {
      readonly ok: true;
      readonly attempt: RecoveryAttempt;
      readonly value: RecoveryAttempt;
    }
  | Rejection;

type JsonRecord = PlainJsonObject;
type Path = readonly string[];

const RECOVERY_ENROLLMENT_FIELDS = new Set([
  "credentialRef",
  "enrolledAt",
  "expiresAt",
  "id",
  "quorum",
  "recoveryKeyRef",
  "status",
  "subjectRef",
]);
const RECOVERY_QUORUM_FIELDS = new Set(["shares", "threshold"]);
const RECOVERY_ROTATION_FIELDS = new Set([
  "newEnrollment",
  "oldEnrollment",
  "ownerApprovedThresholdChange",
]);
const RECOVERY_ATTEMPT_FIELDS = new Set(["presentedShareRefs", "quorum"]);

const SECRET_FIELD_NAME_TOKENS = new Set([
  "apikey",
  "key",
  "keymaterial",
  "mnemonic",
  "passphrase",
  "pem",
  "privatekey",
  "recoverykey",
  "seed",
  "seedphrase",
  "secret",
]);

const SYNTHETIC_REF_ENROLLMENT = Object.freeze({
  credentialRef: "credential:recovery-key-validator",
  enrolledAt: "2026-06-20T00:00:00Z",
  id: "enrollment:recovery-key-validator",
  subjectRef: "identity:recovery-key-validator",
});
const RECOVERY_KEY_REF_ERROR_PREFIX = "recoveryKeyRef";

export function validateEnrollment(input: unknown): RecoveryEnrollmentValidationResult {
  try {
    const normalized = safeNormalize(input);

    if (!normalized.ok) {
      return reject([{ path: "", message: `Invalid untrusted input: ${normalized.reason}` }]);
    }

    const errors: RecoveryKeyValidationError[] = [];
    const enrollment = parseRecoveryEnrollment(normalized.value, [], errors);

    if (enrollment === undefined || errors.length > 0) {
      return reject(errors);
    }

    return {
      enrollment,
      ok: true,
      value: enrollment,
    };
  } catch {
    return reject([{ path: "", message: "Recovery enrollment validation failed." }]);
  }
}

export function validateRotation(input: unknown): RecoveryRotationValidationResult {
  try {
    const normalized = safeNormalize(input);

    if (!normalized.ok) {
      return reject([{ path: "", message: `Invalid untrusted input: ${normalized.reason}` }]);
    }

    const errors: RecoveryKeyValidationError[] = [];
    const rotation = parseRecoveryRotation(normalized.value, [], errors);

    if (rotation === undefined || errors.length > 0) {
      return reject(errors);
    }

    return {
      ok: true,
      rotation,
      value: rotation,
    };
  } catch {
    return reject([{ path: "", message: "Recovery rotation validation failed." }]);
  }
}

export function validateRecoveryAttempt(input: unknown): RecoveryAttemptValidationResult {
  try {
    const normalized = safeNormalize(input);

    if (!normalized.ok) {
      return reject([{ path: "", message: `Invalid untrusted input: ${normalized.reason}` }]);
    }

    const errors: RecoveryKeyValidationError[] = [];
    const attempt = parseRecoveryAttempt(normalized.value, [], errors);

    if (attempt === undefined || errors.length > 0) {
      return reject(errors);
    }

    return {
      attempt,
      ok: true,
      value: attempt,
    };
  } catch {
    return reject([{ path: "", message: "Recovery attempt validation failed." }]);
  }
}

function parseRecoveryEnrollment(
  value: PlainJson,
  path: Path,
  errors: RecoveryKeyValidationError[],
): RecoveryEnrollment | undefined {
  if (!isRecord(value)) {
    addError(errors, path, "Expected recovery enrollment object.");
    return undefined;
  }

  const errorStart = errors.length;

  rejectUnknownFields(value, RECOVERY_ENROLLMENT_FIELDS, path, errors);

  const quorum = readRequiredQuorum(value, "quorum", [...path, "quorum"], errors);
  const backupEnrollmentResult = validateBackupRecoveryKeyEnrollment(
    projectBackupEnrollment(value),
  );

  if (!backupEnrollmentResult.ok) {
    appendBackupErrors(errors, path, backupEnrollmentResult.errors);
  }

  if (
    errors.length > errorStart ||
    !backupEnrollmentResult.ok ||
    quorum === undefined
  ) {
    return undefined;
  }

  return cloneRecoveryEnrollment(backupEnrollmentResult.enrollment, quorum);
}

function parseRecoveryRotation(
  value: PlainJson,
  path: Path,
  errors: RecoveryKeyValidationError[],
): RecoveryRotation | undefined {
  if (!isRecord(value)) {
    addError(errors, path, "Expected recovery rotation object.");
    return undefined;
  }

  const errorStart = errors.length;

  rejectUnknownFields(value, RECOVERY_ROTATION_FIELDS, path, errors);

  const oldEnrollment = readRequiredRecoveryEnrollment(
    value,
    "oldEnrollment",
    [...path, "oldEnrollment"],
    errors,
  );
  const newEnrollment = readRequiredRecoveryEnrollment(
    value,
    "newEnrollment",
    [...path, "newEnrollment"],
    errors,
  );
  const ownerApprovedThresholdChange = readOptionalBoolean(
    value,
    "ownerApprovedThresholdChange",
    [...path, "ownerApprovedThresholdChange"],
    errors,
  );

  if (
    oldEnrollment !== undefined &&
    newEnrollment !== undefined &&
    oldEnrollment.quorum.threshold !== newEnrollment.quorum.threshold &&
    ownerApprovedThresholdChange !== true
  ) {
    addError(
      errors,
      [...path, "ownerApprovedThresholdChange"],
      "Recovery quorum threshold changes require owner approval.",
    );
  }

  if (errors.length > errorStart || oldEnrollment === undefined || newEnrollment === undefined) {
    return undefined;
  }

  return Object.freeze({
    newEnrollment,
    oldEnrollment,
    ...(ownerApprovedThresholdChange === undefined ? {} : { ownerApprovedThresholdChange }),
  });
}

function parseRecoveryAttempt(
  value: PlainJson,
  path: Path,
  errors: RecoveryKeyValidationError[],
): RecoveryAttempt | undefined {
  if (!isRecord(value)) {
    addError(errors, path, "Expected recovery attempt object.");
    return undefined;
  }

  const errorStart = errors.length;

  rejectUnknownFields(value, RECOVERY_ATTEMPT_FIELDS, path, errors);

  const quorum = readRequiredQuorum(value, "quorum", [...path, "quorum"], errors);
  const presentedShareRefs = readRequiredRecoveryKeyRefArray(
    value,
    "presentedShareRefs",
    [...path, "presentedShareRefs"],
    errors,
  );

  if (quorum !== undefined && presentedShareRefs !== undefined) {
    validatePresentedSharesSatisfyQuorum(
      quorum,
      presentedShareRefs,
      [...path, "presentedShareRefs"],
      errors,
    );
  }

  if (
    errors.length > errorStart ||
    quorum === undefined ||
    presentedShareRefs === undefined
  ) {
    return undefined;
  }

  return Object.freeze({
    presentedShareRefs,
    quorum,
  });
}

function readRequiredRecoveryEnrollment(
  value: JsonRecord,
  key: string,
  path: Path,
  errors: RecoveryKeyValidationError[],
): RecoveryEnrollment | undefined {
  const child = readRequiredProperty(value, key, path, errors);

  if (child === undefined) {
    return undefined;
  }

  return parseRecoveryEnrollment(child, path, errors);
}

function readRequiredQuorum(
  value: JsonRecord,
  key: string,
  path: Path,
  errors: RecoveryKeyValidationError[],
): RecoveryQuorum | undefined {
  const child = readRequiredProperty(value, key, path, errors);

  if (child === undefined) {
    return undefined;
  }

  return parseRecoveryQuorum(child, path, errors);
}

function parseRecoveryQuorum(
  value: PlainJson,
  path: Path,
  errors: RecoveryKeyValidationError[],
): RecoveryQuorum | undefined {
  if (!isRecord(value)) {
    addError(errors, path, "Expected recovery quorum object.");
    return undefined;
  }

  const errorStart = errors.length;

  rejectUnknownFields(value, RECOVERY_QUORUM_FIELDS, path, errors);

  const threshold = readRequiredInteger(
    value,
    "threshold",
    1,
    Number.MAX_SAFE_INTEGER,
    [...path, "threshold"],
    errors,
  );
  const shares = readRequiredRecoveryKeyRefArray(value, "shares", [...path, "shares"], errors);

  if (shares !== undefined) {
    validateUniqueRecoveryKeyRefs(shares, [...path, "shares"], errors);
  }

  if (threshold !== undefined && shares !== undefined && threshold > shares.length) {
    addError(errors, [...path, "threshold"], "Threshold must be less than or equal to shares.");
  }

  if (errors.length > errorStart || threshold === undefined || shares === undefined) {
    return undefined;
  }

  return Object.freeze({
    shares,
    threshold,
  });
}

function readRequiredRecoveryKeyRefArray(
  value: JsonRecord,
  key: string,
  path: Path,
  errors: RecoveryKeyValidationError[],
): readonly RecoveryKeyRef[] | undefined {
  const child = readRequiredProperty(value, key, path, errors);

  if (child === undefined) {
    return undefined;
  }

  if (!Array.isArray(child)) {
    addError(errors, path, "Expected recovery key reference array.");
    return undefined;
  }

  const errorStart = errors.length;

  if (child.length < 1) {
    addError(errors, path, "Expected at least one recovery key reference.");
  }

  const refs: RecoveryKeyRef[] = [];

  for (let index = 0; index < child.length; index += 1) {
    const item = child[index];

    if (item === undefined) {
      addError(errors, [...path, String(index)], "Expected recovery key reference object.");
      continue;
    }

    const parsed = parseRecoveryKeyRef(item, [...path, String(index)], errors);

    if (parsed !== undefined) {
      refs.push(parsed);
    }
  }

  if (errors.length > errorStart) {
    return undefined;
  }

  return Object.freeze(refs);
}

function parseRecoveryKeyRef(
  value: PlainJson,
  path: Path,
  errors: RecoveryKeyValidationError[],
): RecoveryKeyRef | undefined {
  const result = validateBackupRecoveryKeyEnrollment({
    ...SYNTHETIC_REF_ENROLLMENT,
    recoveryKeyRef: value,
  });

  if (!result.ok) {
    appendBackupErrors(errors, path, result.errors, RECOVERY_KEY_REF_ERROR_PREFIX);
    return undefined;
  }

  return cloneRecoveryKeyRef(result.enrollment.recoveryKeyRef);
}

function validateUniqueRecoveryKeyRefs(
  refs: readonly RecoveryKeyRef[],
  path: Path,
  errors: RecoveryKeyValidationError[],
): void {
  const seenIds = new Map<string, number>();
  const seenHandles = new Map<string, number>();

  for (let index = 0; index < refs.length; index += 1) {
    const ref = refs[index];

    if (ref === undefined) {
      continue;
    }

    const previousIdIndex = seenIds.get(ref.id);

    if (previousIdIndex !== undefined) {
      addError(
        errors,
        [...path, String(index), "id"],
        `Duplicate recovery share id also appears at ${formatPath([
          ...path,
          String(previousIdIndex),
          "id",
        ])}.`,
      );
    } else {
      seenIds.set(ref.id, index);
    }

    const previousHandleIndex = seenHandles.get(ref.handle);

    if (previousHandleIndex !== undefined) {
      addError(
        errors,
        [...path, String(index), "handle"],
        `Duplicate recovery share handle also appears at ${formatPath([
          ...path,
          String(previousHandleIndex),
          "handle",
        ])}.`,
      );
    } else {
      seenHandles.set(ref.handle, index);
    }
  }
}

function validatePresentedSharesSatisfyQuorum(
  quorum: RecoveryQuorum,
  presentedShareRefs: readonly RecoveryKeyRef[],
  path: Path,
  errors: RecoveryKeyValidationError[],
): void {
  const allowed = new Set<string>();
  const presented = new Set<string>();
  let matchingShares = 0;

  for (let index = 0; index < quorum.shares.length; index += 1) {
    const share = quorum.shares[index];

    if (share !== undefined) {
      allowed.add(recoveryKeyRefKey(share));
    }
  }

  for (let index = 0; index < presentedShareRefs.length; index += 1) {
    const presentedShare = presentedShareRefs[index];

    if (presentedShare === undefined) {
      continue;
    }

    const key = recoveryKeyRefKey(presentedShare);

    if (presented.has(key)) {
      addError(errors, [...path, String(index)], "Duplicate presented recovery share.");
      continue;
    }

    presented.add(key);

    if (!allowed.has(key)) {
      addError(errors, [...path, String(index)], "Presented share is not part of the quorum.");
      continue;
    }

    matchingShares += 1;
  }

  if (matchingShares < quorum.threshold) {
    addError(
      errors,
      path,
      `Expected at least ${quorum.threshold} distinct quorum share references.`,
    );
  }
}

function readRequiredProperty(
  value: JsonRecord,
  key: string,
  path: Path,
  errors: RecoveryKeyValidationError[],
): PlainJson | undefined {
  if (!hasOwn(value, key)) {
    addError(errors, path, "Required field is missing.");
    return undefined;
  }

  return value[key];
}

function readRequiredInteger(
  value: JsonRecord,
  key: string,
  min: number,
  max: number,
  path: Path,
  errors: RecoveryKeyValidationError[],
): number | undefined {
  const child = readRequiredProperty(value, key, path, errors);

  if (child === undefined) {
    return undefined;
  }

  if (
    typeof child !== "number" ||
    !Number.isSafeInteger(child) ||
    child < min ||
    child > max
  ) {
    addError(errors, path, `Expected integer from ${min} through ${max}.`);
    return undefined;
  }

  return child;
}

function readOptionalBoolean(
  value: JsonRecord,
  key: string,
  path: Path,
  errors: RecoveryKeyValidationError[],
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

function rejectUnknownFields(
  value: JsonRecord,
  allowed: ReadonlySet<string>,
  path: Path,
  errors: RecoveryKeyValidationError[],
): void {
  const keys = Object.keys(value).sort(compareStrings);

  for (let index = 0; index < keys.length; index += 1) {
    const key = keys[index];

    if (key === undefined) {
      continue;
    }

    if (isSecretFieldName(key)) {
      addError(errors, [...path, key], "Inline key material is not allowed.");
    } else if (!allowed.has(key)) {
      addError(errors, [...path, key], "Unknown field.");
    }
  }
}

function appendBackupErrors(
  errors: RecoveryKeyValidationError[],
  path: Path,
  backupErrors: readonly BackupModelValidationError[],
  stripPrefix?: string,
): void {
  const formattedPath = formatPath(path);

  for (let index = 0; index < backupErrors.length; index += 1) {
    const error = backupErrors[index];

    if (error === undefined) {
      continue;
    }

    errors.push({
      message: error.message,
      path: joinFormattedPath(formattedPath, stripErrorPrefix(error.path, stripPrefix)),
    });
  }
}

function stripErrorPrefix(path: string, prefix: string | undefined): string {
  if (prefix === undefined) {
    return path;
  }

  if (path === prefix) {
    return "";
  }

  const nestedPrefix = `${prefix}/`;

  if (path.startsWith(nestedPrefix)) {
    return path.slice(nestedPrefix.length);
  }

  return path;
}

function projectBackupEnrollment(value: JsonRecord): Readonly<Record<string, PlainJson>> {
  const output: Record<string, PlainJson> = {};

  copyProperty(value, output, "credentialRef");
  copyProperty(value, output, "enrolledAt");
  copyProperty(value, output, "expiresAt");
  copyProperty(value, output, "id");
  copyProperty(value, output, "recoveryKeyRef");
  copyProperty(value, output, "status");
  copyProperty(value, output, "subjectRef");

  return Object.freeze(output);
}

function copyProperty(
  source: JsonRecord,
  target: Record<string, PlainJson>,
  key: string,
): void {
  if (!hasOwn(source, key)) {
    return;
  }

  const value = source[key];

  if (value !== undefined) {
    target[key] = value;
  }
}

function cloneRecoveryEnrollment(
  source: RecoveryKeyEnrollment,
  quorum: RecoveryQuorum,
): RecoveryEnrollment {
  return Object.freeze({
    credentialRef: source.credentialRef,
    enrolledAt: source.enrolledAt,
    id: source.id,
    quorum,
    recoveryKeyRef: cloneRecoveryKeyRef(source.recoveryKeyRef),
    subjectRef: source.subjectRef,
    ...(source.expiresAt === undefined ? {} : { expiresAt: source.expiresAt }),
    ...(source.status === undefined ? {} : { status: source.status }),
  });
}

function cloneRecoveryKeyRef(source: RecoveryKeyRef): RecoveryKeyRef {
  return Object.freeze({
    handle: source.handle,
    id: source.id,
    ...(source.keyStoreRef === undefined ? {} : { keyStoreRef: source.keyStoreRef }),
  });
}

function recoveryKeyRefKey(ref: RecoveryKeyRef): string {
  return `${ref.id}\0${ref.handle}\0${ref.keyStoreRef ?? ""}`;
}

function isSecretFieldName(value: string): boolean {
  return SECRET_FIELD_NAME_TOKENS.has(value.replace(/[-_]/gu, "").toLowerCase());
}

function isRecord(value: PlainJson | undefined): value is JsonRecord {
  return value !== undefined && value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasOwn(value: JsonRecord, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function reject(errors: readonly RecoveryKeyValidationError[]): Rejection {
  return {
    errors,
    ok: false,
  };
}

function addError(
  errors: RecoveryKeyValidationError[],
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

function joinFormattedPath(left: string, right: string): string {
  if (left === "") {
    return right;
  }

  if (right === "") {
    return left;
  }

  return `${left}/${right}`;
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
