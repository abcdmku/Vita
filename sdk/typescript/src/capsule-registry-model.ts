import { safeNormalize } from "./safe-normalize.ts";
import type { PlainJson, PlainJsonObject } from "./safe-normalize.ts";

export type CapsuleEntryState = "installed" | "disabled";
export type CapsuleId = string;
export type CapsuleIntegrity =
  | `sha256-${string}`
  | `sha384-${string}`
  | `sha512-${string}`;

export interface CapsuleEntry {
  readonly id: CapsuleId;
  readonly version: string;
  readonly integrity: CapsuleIntegrity;
  readonly state: CapsuleEntryState;
}

export type CapsuleRegistry = readonly CapsuleEntry[];

export interface CapsuleRegistryValidationError {
  readonly path: string;
  readonly message: string;
}

export type CapsuleRegistryValidationResult =
  | {
      readonly ok: true;
      readonly registry: CapsuleRegistry;
      readonly value: CapsuleRegistry;
    }
  | {
      readonly ok: false;
      readonly errors: readonly CapsuleRegistryValidationError[];
    };

type JsonRecord = PlainJsonObject;
type Path = readonly string[];
type SriAlgorithm = "sha256" | "sha384" | "sha512";

const CAPSULE_ENTRY_FIELDS = new Set(["id", "integrity", "state", "version"]);
const CAPSULE_ENTRY_STATES = new Set<CapsuleEntryState>(["disabled", "installed"]);
const EMBEDDED_CAPSULE_FIELD_NAMES = new Set([
  "archive",
  "blob",
  "bundle",
  "bytes",
  "capsule",
  "capsulebytes",
  "content",
  "data",
  "file",
  "payload",
  "raw",
  "source",
  "tarball",
]);

const MAX_CAPSULE_ID_LENGTH = 256;
const MAX_VERSION_LENGTH = 256;
const MAX_NSID_LENGTH = 317;
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f]/u;
const INLINE_CAPSULE_SCHEME_PATTERN = /^(?:data|inline|literal):/iu;
const PEM_BLOCK_PATTERN = /-----BEGIN\b/iu;
const NSID_LABEL_PATTERN = /^[A-Za-z](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/u;
const OPAQUE_ID_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9]|[._:@-](?=[A-Za-z0-9])){0,255}$/u;
const SRI_PATTERN = /^(sha256|sha384|sha512)-([A-Za-z0-9+/]+={0,2})$/u;
const BASE64_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

const SRI_DIGEST_BYTES: Readonly<Record<SriAlgorithm, number>> = Object.freeze({
  sha256: 32,
  sha384: 48,
  sha512: 64,
});

export function validateCapsuleRegistry(input: unknown): CapsuleRegistryValidationResult {
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

    const errors: CapsuleRegistryValidationError[] = [];
    const registry = parseCapsuleRegistry(normalized.value, [], errors);

    if (registry === undefined || errors.length > 0) {
      return reject(errors);
    }

    return {
      ok: true,
      registry,
      value: registry,
    };
  } catch {
    return reject([{ path: "", message: "Capsule registry validation failed." }]);
  }
}

function parseCapsuleRegistry(
  value: PlainJson,
  path: Path,
  errors: CapsuleRegistryValidationError[],
): CapsuleRegistry | undefined {
  if (!Array.isArray(value)) {
    addError(errors, path, "Expected capsule registry array.");
    return undefined;
  }

  const entries: CapsuleEntry[] = [];
  const seenIds = new Map<CapsuleId, number>();
  const errorStart = errors.length;

  for (let index = 0; index < value.length; index += 1) {
    const item = value[index];

    if (item === undefined) {
      addError(errors, [...path, String(index)], "Expected capsule registry entry object.");
      continue;
    }

    const entry = parseCapsuleEntry(item, [...path, String(index)], errors);

    if (entry === undefined) {
      continue;
    }

    const previousIndex = seenIds.get(entry.id);

    if (previousIndex !== undefined) {
      addError(
        errors,
        [...path, String(index), "id"],
        `Duplicate capsule id also appears at ${formatPath([...path, String(previousIndex), "id"])}.`,
      );
    } else {
      seenIds.set(entry.id, index);
    }

    entries.push(entry);
  }

  if (errors.length > errorStart) {
    return undefined;
  }

  return Object.freeze(entries);
}

function parseCapsuleEntry(
  value: PlainJson,
  path: Path,
  errors: CapsuleRegistryValidationError[],
): CapsuleEntry | undefined {
  if (!isRecord(value)) {
    addError(errors, path, "Expected capsule registry entry object.");
    return undefined;
  }

  const errorStart = errors.length;

  rejectUnknownFields(value, CAPSULE_ENTRY_FIELDS, path, errors);

  const id = validateRequiredCapsuleId(value, "id", [...path, "id"], errors);
  const version = validateRequiredVersion(value, "version", [...path, "version"], errors);
  const integrity = validateRequiredIntegrity(value, "integrity", [...path, "integrity"], errors);
  const state = validateRequiredState(value, "state", [...path, "state"], errors);

  if (
    errors.length > errorStart ||
    id === undefined ||
    version === undefined ||
    integrity === undefined ||
    state === undefined
  ) {
    return undefined;
  }

  return Object.freeze({
    id,
    integrity,
    state,
    version,
  });
}

function validateRequiredCapsuleId(
  value: JsonRecord,
  key: string,
  path: Path,
  errors: CapsuleRegistryValidationError[],
): CapsuleId | undefined {
  const child = readRequiredProperty(value, key, path, errors);

  if (child === undefined) {
    return undefined;
  }

  if (typeof child !== "string" || !isCapsuleId(child)) {
    addError(errors, path, "Expected reverse-DNS NSID or opaque capsule id.");
    return undefined;
  }

  return child;
}

function validateRequiredVersion(
  value: JsonRecord,
  key: string,
  path: Path,
  errors: CapsuleRegistryValidationError[],
): string | undefined {
  const child = readRequiredProperty(value, key, path, errors);

  if (child === undefined) {
    return undefined;
  }

  if (typeof child !== "string" || !isNonEmptyRegistryString(child, MAX_VERSION_LENGTH)) {
    addError(errors, path, "Expected non-empty capsule version.");
    return undefined;
  }

  return child;
}

function validateRequiredIntegrity(
  value: JsonRecord,
  key: string,
  path: Path,
  errors: CapsuleRegistryValidationError[],
): CapsuleIntegrity | undefined {
  const child = readRequiredProperty(value, key, path, errors);

  if (child === undefined) {
    return undefined;
  }

  if (typeof child !== "string" || !isSubresourceIntegrity(child)) {
    addError(errors, path, "Expected sha256, sha384, or sha512 SRI digest.");
    return undefined;
  }

  return child;
}

function validateRequiredState(
  value: JsonRecord,
  key: string,
  path: Path,
  errors: CapsuleRegistryValidationError[],
): CapsuleEntryState | undefined {
  const child = readRequiredProperty(value, key, path, errors);

  if (child === undefined) {
    return undefined;
  }

  if (!isStringInSet(child, CAPSULE_ENTRY_STATES)) {
    addError(errors, path, "Expected one of: disabled, installed.");
    return undefined;
  }

  return child;
}

function readRequiredProperty(
  value: JsonRecord,
  key: string,
  path: Path,
  errors: CapsuleRegistryValidationError[],
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

function rejectUnknownFields(
  value: JsonRecord,
  allowed: ReadonlySet<string>,
  path: Path,
  errors: CapsuleRegistryValidationError[],
): void {
  const keys = Object.keys(value).sort(compareStrings);

  for (let index = 0; index < keys.length; index += 1) {
    const key = keys[index];

    if (key === undefined || allowed.has(key)) {
      continue;
    }

    addError(
      errors,
      [...path, key],
      isEmbeddedCapsuleFieldName(key)
        ? "Embedded capsule bytes are not allowed."
        : "Unknown field.",
    );
  }
}

function isCapsuleId(value: string): value is CapsuleId {
  if (
    !isNonEmptyRegistryString(value, MAX_CAPSULE_ID_LENGTH) ||
    looksEmbeddedCapsuleMaterial(value)
  ) {
    return false;
  }

  return isReverseDnsNsid(value) || OPAQUE_ID_PATTERN.test(value);
}

function isNonEmptyRegistryString(value: string, maxLength: number): boolean {
  return (
    value.length > 0 &&
    value.length <= maxLength &&
    value === value.trim() &&
    !CONTROL_CHARACTER_PATTERN.test(value) &&
    !looksEmbeddedCapsuleMaterial(value)
  );
}

function isReverseDnsNsid(value: string): boolean {
  if (
    value.length === 0 ||
    value.length > MAX_NSID_LENGTH ||
    value !== value.trim() ||
    CONTROL_CHARACTER_PATTERN.test(value) ||
    value.includes("://") ||
    value.includes("/") ||
    value.endsWith(".")
  ) {
    return false;
  }

  const segments = value.split(".");

  if (segments.length < 3) {
    return false;
  }

  const topLevelSegment = segments[0];

  if (
    topLevelSegment === undefined ||
    topLevelSegment.length < 2 ||
    !/^[A-Za-z]+$/u.test(topLevelSegment)
  ) {
    return false;
  }

  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index];

    if (segment === undefined || !NSID_LABEL_PATTERN.test(segment)) {
      return false;
    }
  }

  return true;
}

function isSubresourceIntegrity(value: string): value is CapsuleIntegrity {
  const match = SRI_PATTERN.exec(value);

  if (match === null) {
    return false;
  }

  const algorithm = match[1];
  const encodedDigest = match[2];

  if (!isSriAlgorithm(algorithm) || encodedDigest === undefined) {
    return false;
  }

  const decoded = decodeBase64(encodedDigest);

  return decoded !== undefined && decoded.length === SRI_DIGEST_BYTES[algorithm];
}

function decodeBase64(value: string): readonly number[] | undefined {
  if (value.length === 0 || value.length % 4 !== 0) {
    return undefined;
  }

  const bytes: number[] = [];

  for (let index = 0; index < value.length; index += 4) {
    const first = base64Digit(value[index]);
    const second = base64Digit(value[index + 1]);
    const thirdCharacter = value[index + 2];
    const fourthCharacter = value[index + 3];

    if (
      first === undefined ||
      second === undefined ||
      thirdCharacter === undefined ||
      fourthCharacter === undefined
    ) {
      return undefined;
    }

    const finalChunk = index + 4 === value.length;

    if (thirdCharacter === "=") {
      if (!finalChunk || fourthCharacter !== "=" || (second & 0x0f) !== 0) {
        return undefined;
      }

      bytes.push((first << 2) | (second >> 4));
      continue;
    }

    const third = base64Digit(thirdCharacter);

    if (third === undefined) {
      return undefined;
    }

    if (fourthCharacter === "=") {
      if (!finalChunk || (third & 0x03) !== 0) {
        return undefined;
      }

      bytes.push((first << 2) | (second >> 4));
      bytes.push(((second & 0x0f) << 4) | (third >> 2));
      continue;
    }

    const fourth = base64Digit(fourthCharacter);

    if (fourth === undefined) {
      return undefined;
    }

    bytes.push((first << 2) | (second >> 4));
    bytes.push(((second & 0x0f) << 4) | (third >> 2));
    bytes.push(((third & 0x03) << 6) | fourth);
  }

  return Object.freeze(bytes);
}

function base64Digit(value: string | undefined): number | undefined {
  if (value === undefined || value === "=") {
    return undefined;
  }

  const digit = BASE64_ALPHABET.indexOf(value);

  return digit < 0 ? undefined : digit;
}

function looksEmbeddedCapsuleMaterial(value: string): boolean {
  return (
    INLINE_CAPSULE_SCHEME_PATTERN.test(value) ||
    PEM_BLOCK_PATTERN.test(value) ||
    value.includes("://")
  );
}

function isEmbeddedCapsuleFieldName(value: string): boolean {
  return EMBEDDED_CAPSULE_FIELD_NAMES.has(value.replace(/[-_]/gu, "").toLowerCase());
}

function isSriAlgorithm(value: string | undefined): value is SriAlgorithm {
  return value === "sha256" || value === "sha384" || value === "sha512";
}

function isRecord(value: PlainJson | undefined): value is JsonRecord {
  return value !== undefined && value !== null && typeof value === "object" && !Array.isArray(value);
}

function isStringInSet<T extends string>(
  value: PlainJson,
  allowed: ReadonlySet<T>,
): value is T {
  return typeof value === "string" && allowed.has(value as T);
}

function hasOwn(value: JsonRecord, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function reject(
  errors: readonly CapsuleRegistryValidationError[],
): Extract<CapsuleRegistryValidationResult, { readonly ok: false }> {
  return {
    ok: false,
    errors,
  };
}

function addError(
  errors: CapsuleRegistryValidationError[],
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
