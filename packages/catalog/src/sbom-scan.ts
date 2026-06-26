import { createHash, timingSafeEqual } from "node:crypto";
import { TextDecoder, types as nodeTypes } from "node:util";

import { safeNormalize } from "../../../sdk/typescript/src/safe-normalize.ts";
import type { PlainJson, PlainJsonObject } from "../../../sdk/typescript/src/safe-normalize.ts";
import type { CatalogSbomReference } from "./catalog-entry.ts";
import type {
  ImmutableDigest,
  VulnerabilityStatus,
} from "../../../sdk/manifests/src/package-contract.ts";

export interface SbomScanInput {
  readonly sbom: unknown;
  readonly vulnerabilityStatus: unknown;
  readonly sbomBytes: Uint8Array;
  readonly maxStalenessMs: number;
  readonly now: string;
}

export interface SbomScanBinding {
  readonly sbom: CatalogSbomReference;
  readonly vulnerabilityStatus: VulnerabilityStatus;
}

export interface SbomScanValidationError {
  readonly path: string;
  readonly message: string;
}

export type SbomScanValidationResult =
  | {
      readonly ok: true;
      readonly value: SbomScanBinding;
    }
  | {
      readonly ok: false;
      readonly errors: readonly SbomScanValidationError[];
    };

type Path = readonly string[];

type FieldValue =
  | {
      readonly present: true;
      readonly value: unknown;
    }
  | {
      readonly present: false;
    };

interface EnvelopeSnapshot {
  readonly sbom: FieldValue;
  readonly vulnerabilityStatus: FieldValue;
  readonly sbomBytes: FieldValue;
  readonly maxStalenessMs: FieldValue;
  readonly now: FieldValue;
}

interface ParsedDateTime {
  readonly text: string;
  readonly epochMs: number;
}

const TEXT_DECODER = new TextDecoder("utf-8", { fatal: true });

const TOP_LEVEL_FIELDS = new Set([
  "sbom",
  "vulnerabilityStatus",
  "sbomBytes",
  "maxStalenessMs",
  "now",
]);
const SBOM_FIELDS = new Set(["format", "ref", "digest", "generatedAt"]);
const DIGEST_FIELDS = new Set(["algorithm", "value"]);
const VULNERABILITY_FIELDS = new Set(["status", "scannedAt", "critical", "high", "medium", "low"]);
const INLINE_REFERENCE_SCHEMES = new Set(["data", "inline", "literal"]);
const DANGEROUS_KEYS = new Set(["__proto__", "constructor"]);

const RFC3339_DATE_TIME =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(\.\d+)?(Z|[+-]\d{2}:\d{2})$/u;
const SPDX_VERSION_PATTERN = /^SPDX-\d+\.\d+$/u;
const CYCLONEDX_VERSION_PATTERN = /^\d+\.\d+$/u;
const HEX_PATTERN = /^[a-f0-9]+$/u;

const MAX_REFERENCE_LENGTH = 2_048;
const MAX_STRING_LENGTH = 16_384;
const MAX_DATE_TIME_LENGTH = 128;
const MAX_DIGEST_VALUE_LENGTH = 128;

const MISSING_FIELD: FieldValue = Object.freeze({ present: false });

export function validateSbomScan(input: unknown): SbomScanValidationResult {
  const errors: SbomScanValidationError[] = [];

  try {
    const envelope = snapshotEnvelope(input, errors);

    if (envelope === undefined) {
      return reject(errors);
    }

    const now = parseEnvelopeDateTime(envelope.now, ["now"], errors);
    const maxStalenessMs = parseMaxStaleness(envelope.maxStalenessMs, ["maxStalenessMs"], errors);
    const sbomBytes = snapshotBytes(envelope.sbomBytes, ["sbomBytes"], errors);

    const sbomValue = parseSbomReference(
      envelope.sbom,
      sbomBytes,
      now?.epochMs,
      maxStalenessMs,
      errors,
    );
    const vulnerabilityStatus = parseVulnerabilityStatus(
      envelope.vulnerabilityStatus,
      now?.epochMs,
      maxStalenessMs,
      errors,
    );

    if (errors.length > 0 || sbomValue === undefined || vulnerabilityStatus === undefined) {
      return reject(errors);
    }

    return {
      ok: true,
      value: {
        sbom: sbomValue,
        vulnerabilityStatus,
      },
    };
  } catch {
    return reject([
      {
        path: "",
        message: "SBOM scan validation failed closed.",
      },
    ]);
  }
}

function snapshotEnvelope(
  input: unknown,
  errors: SbomScanValidationError[],
): EnvelopeSnapshot | undefined {
  if (!plainEnvelopeObject(input)) {
    addError(errors, [], "Expected SBOM scan input object.");
    return undefined;
  }

  const keys = ownKeys(input, [], errors);

  if (keys === undefined) {
    return undefined;
  }

  let sbom: FieldValue = MISSING_FIELD;
  let vulnerabilityStatus: FieldValue = MISSING_FIELD;
  let sbomBytes: FieldValue = MISSING_FIELD;
  let maxStalenessMs: FieldValue = MISSING_FIELD;
  let now: FieldValue = MISSING_FIELD;

  for (let index = 0; index < keys.length; index += 1) {
    const key = keys[index];

    if (key === undefined) {
      continue;
    }

    if (typeof key !== "string") {
      addError(errors, [String(key)], "Symbol fields are not allowed.");
      continue;
    }

    const path = [key];
    const descriptor = ownDataDescriptor(input, key, path, errors);

    if (descriptor === undefined) {
      continue;
    }

    if (!TOP_LEVEL_FIELDS.has(key)) {
      addError(errors, path, "Unknown field.");
      continue;
    }

    const field: FieldValue = {
      present: true,
      value: descriptor.value,
    };

    if (key === "sbom") {
      sbom = field;
    } else if (key === "vulnerabilityStatus") {
      vulnerabilityStatus = field;
    } else if (key === "sbomBytes") {
      sbomBytes = field;
    } else if (key === "maxStalenessMs") {
      maxStalenessMs = field;
    } else {
      now = field;
    }
  }

  requireField(sbom, ["sbom"], errors);
  requireField(vulnerabilityStatus, ["vulnerabilityStatus"], errors);
  requireField(sbomBytes, ["sbomBytes"], errors);
  requireField(maxStalenessMs, ["maxStalenessMs"], errors);
  requireField(now, ["now"], errors);

  return {
    maxStalenessMs,
    now,
    sbom,
    sbomBytes,
    vulnerabilityStatus,
  };
}

function parseSbomReference(
  field: FieldValue,
  sbomBytes: Uint8Array | undefined,
  nowMs: number | undefined,
  maxStalenessMs: number | undefined,
  errors: SbomScanValidationError[],
): CatalogSbomReference | undefined {
  if (!field.present) {
    return undefined;
  }

  const value = normalizeObject(field.value, ["sbom"], errors);

  if (value === undefined) {
    return undefined;
  }

  rejectUnknownFields(value, SBOM_FIELDS, ["sbom"], errors);

  const format = readSbomFormat(value, "format", ["sbom", "format"], errors);
  const ref = readRequiredReference(value, "ref", ["sbom", "ref"], errors);
  const digest = readRequiredDigest(value, "digest", ["sbom", "digest"], errors);
  const generatedAt = readRequiredDateTime(value, "generatedAt", ["sbom", "generatedAt"], errors);

  if (generatedAt !== undefined && nowMs !== undefined && maxStalenessMs !== undefined) {
    validateFreshness(generatedAt.epochMs, nowMs, maxStalenessMs, ["sbom", "generatedAt"], errors);
  }

  if (format !== undefined && sbomBytes !== undefined) {
    validateSbomDocument(format, sbomBytes, errors);
  }

  if (digest !== undefined && sbomBytes !== undefined && !digestMatchesBytes(digest, sbomBytes)) {
    addError(errors, ["sbom", "digest"], "SBOM digest does not match supplied SBOM bytes.");
  }

  if (format === undefined || ref === undefined || digest === undefined || generatedAt === undefined) {
    return undefined;
  }

  return {
    digest,
    format,
    generatedAt: generatedAt.text,
    ref,
  };
}

function parseVulnerabilityStatus(
  field: FieldValue,
  nowMs: number | undefined,
  maxStalenessMs: number | undefined,
  errors: SbomScanValidationError[],
): VulnerabilityStatus | undefined {
  if (!field.present) {
    return undefined;
  }

  const value = normalizeObject(field.value, ["vulnerabilityStatus"], errors);

  if (value === undefined) {
    return undefined;
  }

  rejectUnknownFields(value, VULNERABILITY_FIELDS, ["vulnerabilityStatus"], errors);

  const status = readVulnerabilityStatusEnum(value, "status", ["vulnerabilityStatus", "status"], errors);
  const scannedAt = readRequiredDateTime(
    value,
    "scannedAt",
    ["vulnerabilityStatus", "scannedAt"],
    errors,
  );
  const critical = readRequiredNonNegativeInteger(
    value,
    "critical",
    ["vulnerabilityStatus", "critical"],
    errors,
  );
  const high = readRequiredNonNegativeInteger(value, "high", ["vulnerabilityStatus", "high"], errors);
  const medium = readRequiredNonNegativeInteger(
    value,
    "medium",
    ["vulnerabilityStatus", "medium"],
    errors,
  );
  const low = readRequiredNonNegativeInteger(value, "low", ["vulnerabilityStatus", "low"], errors);

  if (status === "scan-pending" || status === "scan-unavailable") {
    addError(errors, ["vulnerabilityStatus", "status"], "Scan status is not bindable.");
  }

  if (
    status === "clean" &&
    ((critical !== undefined && critical !== 0) ||
      (high !== undefined && high !== 0) ||
      (medium !== undefined && medium !== 0) ||
      (low !== undefined && low !== 0))
  ) {
    addError(errors, ["vulnerabilityStatus", "status"], "Clean status requires zero vulnerability counts.");
  }

  if (scannedAt !== undefined && nowMs !== undefined && maxStalenessMs !== undefined) {
    validateFreshness(
      scannedAt.epochMs,
      nowMs,
      maxStalenessMs,
      ["vulnerabilityStatus", "scannedAt"],
      errors,
    );
  }

  if (
    status === undefined ||
    scannedAt === undefined ||
    critical === undefined ||
    high === undefined ||
    medium === undefined ||
    low === undefined
  ) {
    return undefined;
  }

  return {
    critical,
    high,
    low,
    medium,
    scannedAt: scannedAt.text,
    status,
  };
}

function normalizeObject(
  input: unknown,
  path: Path,
  errors: SbomScanValidationError[],
): PlainJsonObject | undefined {
  const normalized = safeNormalize(input, { maxDepth: 128, maxNodes: 100_000 });

  if (!normalized.ok) {
    addError(errors, path, `Could not safely normalize value: ${normalized.reason}`);
    return undefined;
  }

  if (!plainJsonObject(normalized.value)) {
    addError(errors, path, "Expected object.");
    return undefined;
  }

  return normalized.value;
}

function validateSbomDocument(
  format: CatalogSbomReference["format"],
  sbomBytes: Uint8Array,
  errors: SbomScanValidationError[],
): void {
  let text: string;

  try {
    text = TEXT_DECODER.decode(sbomBytes);
  } catch {
    addError(errors, ["sbomBytes"], "Expected UTF-8 encoded SBOM JSON bytes.");
    return;
  }

  let parsed: unknown;

  try {
    parsed = JSON.parse(text);
  } catch {
    addError(errors, ["sbomBytes"], "Expected SBOM bytes to contain JSON.");
    return;
  }

  const normalized = safeNormalize(parsed, { maxDepth: 128, maxNodes: 100_000 });

  if (!normalized.ok) {
    addError(errors, ["sbomBytes"], `SBOM document is not safe JSON: ${normalized.reason}`);
    return;
  }

  rejectDangerousKeys(normalized.value, ["sbomBytes"], errors);
  rejectOversizedStrings(normalized.value, ["sbomBytes"], errors);

  if (!plainJsonObject(normalized.value)) {
    addError(errors, ["sbomBytes"], "Expected SBOM document object.");
    return;
  }

  if (format === "spdx-json") {
    validateSpdxDocument(normalized.value, errors);
  } else {
    validateCycloneDxDocument(normalized.value, errors);
  }
}

function validateSpdxDocument(
  value: PlainJsonObject,
  errors: SbomScanValidationError[],
): void {
  const spdxVersion = value.spdxVersion;
  if (typeof spdxVersion !== "string" || !SPDX_VERSION_PATTERN.test(spdxVersion)) {
    addError(errors, ["sbomBytes", "spdxVersion"], "Expected SPDX JSON document.");
  }

  const spdxId = value.SPDXID;
  if (typeof spdxId !== "string" || spdxId === "" || spdxId.length > MAX_STRING_LENGTH) {
    addError(errors, ["sbomBytes", "SPDXID"], "Expected SPDX document identifier.");
  }
}

function validateCycloneDxDocument(
  value: PlainJsonObject,
  errors: SbomScanValidationError[],
): void {
  if (value.bomFormat !== "CycloneDX") {
    addError(errors, ["sbomBytes", "bomFormat"], "Expected CycloneDX JSON document.");
  }

  const specVersion = value.specVersion;
  if (
    typeof specVersion !== "string" ||
    !CYCLONEDX_VERSION_PATTERN.test(specVersion) ||
    specVersion.length > MAX_STRING_LENGTH
  ) {
    addError(errors, ["sbomBytes", "specVersion"], "Expected CycloneDX spec version.");
  }
}

function parseEnvelopeDateTime(
  field: FieldValue,
  path: Path,
  errors: SbomScanValidationError[],
): ParsedDateTime | undefined {
  if (!field.present) {
    return undefined;
  }

  if (typeof field.value !== "string" || field.value === "" || field.value.length > MAX_DATE_TIME_LENGTH) {
    addError(errors, path, "Expected RFC3339 date-time string.");
    return undefined;
  }

  const epochMs = parseRfc3339DateTime(field.value);

  if (epochMs === undefined) {
    addError(errors, path, "Expected RFC3339 date-time string.");
    return undefined;
  }

  return {
    epochMs,
    text: field.value,
  };
}

function parseMaxStaleness(
  field: FieldValue,
  path: Path,
  errors: SbomScanValidationError[],
): number | undefined {
  if (!field.present) {
    return undefined;
  }

  if (typeof field.value !== "number" || !Number.isSafeInteger(field.value) || field.value < 0) {
    addError(errors, path, "Expected non-negative safe integer milliseconds.");
    return undefined;
  }

  return field.value;
}

function snapshotBytes(
  field: FieldValue,
  path: Path,
  errors: SbomScanValidationError[],
): Uint8Array | undefined {
  if (!field.present) {
    return undefined;
  }

  const value = field.value;

  try {
    if (
      typeof value !== "object" ||
      value === null ||
      nodeTypes.isProxy(value) ||
      (!(value instanceof Uint8Array) && !Buffer.isBuffer(value))
    ) {
      addError(errors, path, "Expected Uint8Array SBOM bytes.");
      return undefined;
    }

    if (!Buffer.isBuffer(value) && Object.getPrototypeOf(value) !== Uint8Array.prototype) {
      addError(errors, path, "Expected plain Uint8Array SBOM bytes.");
      return undefined;
    }

    return Buffer.from(value);
  } catch {
    addError(errors, path, "Could not safely read SBOM bytes.");
    return undefined;
  }
}

function readSbomFormat(
  value: PlainJsonObject,
  key: string,
  path: Path,
  errors: SbomScanValidationError[],
): CatalogSbomReference["format"] | undefined {
  if (!hasOwn(value, key)) {
    addError(errors, path, "Required field is missing.");
    return undefined;
  }

  const fieldValue = value[key];
  if (fieldValue === "spdx-json" || fieldValue === "cyclonedx-json") {
    return fieldValue;
  }

  addError(errors, path, "Expected one of: cyclonedx-json, spdx-json.");
  return undefined;
}

function readVulnerabilityStatusEnum(
  value: PlainJsonObject,
  key: string,
  path: Path,
  errors: SbomScanValidationError[],
): VulnerabilityStatus["status"] | undefined {
  if (!hasOwn(value, key)) {
    addError(errors, path, "Required field is missing.");
    return undefined;
  }

  const fieldValue = value[key];

  if (
    fieldValue === "clean" ||
    fieldValue === "known-vulnerabilities" ||
    fieldValue === "scan-pending" ||
    fieldValue === "scan-unavailable"
  ) {
    return fieldValue;
  }

  addError(
    errors,
    path,
    "Expected one of: clean, known-vulnerabilities, scan-pending, scan-unavailable.",
  );
  return undefined;
}

function readRequiredReference(
  value: PlainJsonObject,
  key: string,
  path: Path,
  errors: SbomScanValidationError[],
): string | undefined {
  if (!hasOwn(value, key)) {
    addError(errors, path, "Required field is missing.");
    return undefined;
  }

  const fieldValue = value[key];

  if (typeof fieldValue !== "string" || fieldValue === "") {
    addError(errors, path, "Expected non-empty reference string.");
    return undefined;
  }

  if (looksEmbeddedMaterial(fieldValue)) {
    addError(errors, path, "Secret or content material must be referenced, not embedded.");
    return undefined;
  }

  if (!isReferenceSyntax(fieldValue)) {
    addError(errors, path, "Expected reference URI.");
    return undefined;
  }

  return fieldValue;
}

function readRequiredDigest(
  value: PlainJsonObject,
  key: string,
  path: Path,
  errors: SbomScanValidationError[],
): ImmutableDigest | undefined {
  if (!hasOwn(value, key)) {
    addError(errors, path, "Required field is missing.");
    return undefined;
  }

  const fieldValue = value[key];

  if (!plainJsonObject(fieldValue)) {
    addError(errors, path, "Expected object.");
    return undefined;
  }

  rejectUnknownFields(fieldValue, DIGEST_FIELDS, path, errors);

  const algorithm = readDigestAlgorithm(fieldValue, "algorithm", [...path, "algorithm"], errors);
  const digestValue = readRequiredString(
    fieldValue,
    "value",
    [...path, "value"],
    MAX_DIGEST_VALUE_LENGTH,
    errors,
  );

  if (algorithm !== undefined && digestValue !== undefined && !isExpectedHexDigest(algorithm, digestValue)) {
    addError(errors, [...path, "value"], "Expected lowercase hex digest value for the selected algorithm.");
    return undefined;
  }

  if (algorithm === undefined || digestValue === undefined) {
    return undefined;
  }

  return {
    algorithm,
    value: digestValue,
  };
}

function readDigestAlgorithm(
  value: PlainJsonObject,
  key: string,
  path: Path,
  errors: SbomScanValidationError[],
): ImmutableDigest["algorithm"] | undefined {
  if (!hasOwn(value, key)) {
    addError(errors, path, "Required field is missing.");
    return undefined;
  }

  const fieldValue = value[key];
  if (fieldValue === "sha256" || fieldValue === "sha384" || fieldValue === "sha512") {
    return fieldValue;
  }

  addError(errors, path, "Expected one of: sha256, sha384, sha512.");
  return undefined;
}

function readRequiredString(
  value: PlainJsonObject,
  key: string,
  path: Path,
  maxLength: number,
  errors: SbomScanValidationError[],
): string | undefined {
  if (!hasOwn(value, key)) {
    addError(errors, path, "Required field is missing.");
    return undefined;
  }

  const fieldValue = value[key];

  if (typeof fieldValue !== "string" || fieldValue === "") {
    addError(errors, path, "Expected non-empty string.");
    return undefined;
  }

  if (fieldValue.length > maxLength) {
    addError(errors, path, "String is too large.");
    return undefined;
  }

  return fieldValue;
}

function readRequiredDateTime(
  value: PlainJsonObject,
  key: string,
  path: Path,
  errors: SbomScanValidationError[],
): ParsedDateTime | undefined {
  const text = readRequiredString(value, key, path, MAX_DATE_TIME_LENGTH, errors);

  if (text === undefined) {
    return undefined;
  }

  const epochMs = parseRfc3339DateTime(text);

  if (epochMs === undefined) {
    addError(errors, path, "Expected RFC3339 date-time string.");
    return undefined;
  }

  return {
    epochMs,
    text,
  };
}

function readRequiredNonNegativeInteger(
  value: PlainJsonObject,
  key: string,
  path: Path,
  errors: SbomScanValidationError[],
): number | undefined {
  if (!hasOwn(value, key)) {
    addError(errors, path, "Required field is missing.");
    return undefined;
  }

  const fieldValue = value[key];

  if (typeof fieldValue !== "number" || !Number.isSafeInteger(fieldValue) || fieldValue < 0) {
    addError(errors, path, "Expected non-negative safe integer.");
    return undefined;
  }

  return fieldValue;
}

function parseRfc3339DateTime(value: string): number | undefined {
  const match = RFC3339_DATE_TIME.exec(value);

  if (match === null) {
    return undefined;
  }

  const year = parseFixedInteger(match[1]);
  const month = parseFixedInteger(match[2]);
  const day = parseFixedInteger(match[3]);
  const hour = parseFixedInteger(match[4]);
  const minute = parseFixedInteger(match[5]);
  const second = parseFixedInteger(match[6]);
  const fraction = match[7];
  const offset = match[8];

  if (
    year === undefined ||
    month === undefined ||
    day === undefined ||
    hour === undefined ||
    minute === undefined ||
    second === undefined ||
    offset === undefined ||
    month < 1 ||
    month > 12 ||
    hour > 23 ||
    minute > 59 ||
    second > 59
  ) {
    return undefined;
  }

  const millisecond = parseFractionMillisecond(fraction);
  const local = new Date(0);
  local.setUTCFullYear(year, month - 1, day);
  local.setUTCHours(hour, minute, second, millisecond);

  if (
    local.getUTCFullYear() !== year ||
    local.getUTCMonth() !== month - 1 ||
    local.getUTCDate() !== day ||
    local.getUTCHours() !== hour ||
    local.getUTCMinutes() !== minute ||
    local.getUTCSeconds() !== second ||
    local.getUTCMilliseconds() !== millisecond
  ) {
    return undefined;
  }

  const offsetMs = parseOffsetMilliseconds(offset);

  if (offsetMs === undefined) {
    return undefined;
  }

  const epochMs = local.getTime() - offsetMs;

  return Number.isFinite(epochMs) ? epochMs : undefined;
}

function parseFixedInteger(value: string | undefined): number | undefined {
  if (value === undefined || !/^\d+$/u.test(value)) {
    return undefined;
  }

  return Number.parseInt(value, 10);
}

function parseFractionMillisecond(value: string | undefined): number {
  if (value === undefined) {
    return 0;
  }

  const digits = value.slice(1, 4).padEnd(3, "0");
  return Number.parseInt(digits, 10);
}

function parseOffsetMilliseconds(value: string): number | undefined {
  if (value === "Z") {
    return 0;
  }

  const sign = value[0];
  const hours = parseFixedInteger(value.slice(1, 3));
  const minutes = parseFixedInteger(value.slice(4, 6));

  if (
    (sign !== "+" && sign !== "-") ||
    value[3] !== ":" ||
    hours === undefined ||
    minutes === undefined ||
    hours > 23 ||
    minutes > 59
  ) {
    return undefined;
  }

  const offset = (hours * 60 + minutes) * 60_000;
  return sign === "+" ? offset : -offset;
}

function validateFreshness(
  timestampMs: number,
  nowMs: number,
  maxStalenessMs: number,
  path: Path,
  errors: SbomScanValidationError[],
): void {
  if (timestampMs > nowMs) {
    addError(errors, path, "Timestamp must not be in the future.");
    return;
  }

  if (nowMs - timestampMs > maxStalenessMs) {
    addError(errors, path, "Timestamp is older than the max staleness window.");
  }
}

function digestMatchesBytes(digest: ImmutableDigest, bytes: Uint8Array): boolean {
  const computed = createHash(digest.algorithm).update(bytes).digest("hex");

  return constantTimeStringEqual(`${digest.algorithm}:${digest.value}`, `${digest.algorithm}:${computed}`);
}

function constantTimeStringEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left, "utf8");
  const rightBytes = Buffer.from(right, "utf8");

  if (leftBytes.length === rightBytes.length) {
    return timingSafeEqual(leftBytes, rightBytes);
  }

  const length = Math.max(leftBytes.length, rightBytes.length);
  const paddedLeft = Buffer.alloc(length);
  const paddedRight = Buffer.alloc(length);

  leftBytes.copy(paddedLeft);
  rightBytes.copy(paddedRight);
  timingSafeEqual(paddedLeft, paddedRight);
  return false;
}

function isExpectedHexDigest(
  algorithm: ImmutableDigest["algorithm"],
  value: string,
): boolean {
  const expectedLength = digestHexLength(algorithm);

  return value.length === expectedLength && HEX_PATTERN.test(value);
}

function digestHexLength(algorithm: ImmutableDigest["algorithm"]): number {
  if (algorithm === "sha256") {
    return 64;
  }

  if (algorithm === "sha384") {
    return 96;
  }

  return 128;
}

function rejectDangerousKeys(
  value: PlainJson,
  path: Path,
  errors: SbomScanValidationError[],
): void {
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      const item = value[index];

      if (item !== undefined) {
        rejectDangerousKeys(item, [...path, String(index)], errors);
      }
    }
    return;
  }

  if (!plainJsonObject(value)) {
    return;
  }

  const keys = sortedKeys(value);
  for (let index = 0; index < keys.length; index += 1) {
    const key = keys[index];

    if (key === undefined) {
      continue;
    }

    if (DANGEROUS_KEYS.has(key)) {
      addError(errors, [...path, key], "Prototype-pollution key is not allowed.");
      continue;
    }

    const child = value[key];
    if (child !== undefined) {
      rejectDangerousKeys(child, [...path, key], errors);
    }
  }
}

function rejectOversizedStrings(
  value: PlainJson,
  path: Path,
  errors: SbomScanValidationError[],
): void {
  if (typeof value === "string") {
    if (value.length > MAX_STRING_LENGTH) {
      addError(errors, path, "String is too large.");
    }
    return;
  }

  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      const item = value[index];

      if (item !== undefined) {
        rejectOversizedStrings(item, [...path, String(index)], errors);
      }
    }
    return;
  }

  if (!plainJsonObject(value)) {
    return;
  }

  const keys = sortedKeys(value);
  for (let index = 0; index < keys.length; index += 1) {
    const key = keys[index];

    if (key !== undefined) {
      const child = value[key];

      if (child !== undefined) {
        rejectOversizedStrings(child, [...path, key], errors);
      }
    }
  }
}

function rejectUnknownFields(
  value: PlainJsonObject,
  allowed: ReadonlySet<string>,
  path: Path,
  errors: SbomScanValidationError[],
): void {
  const keys = sortedKeys(value);

  for (let index = 0; index < keys.length; index += 1) {
    const key = keys[index];

    if (key !== undefined && !allowed.has(key)) {
      addError(errors, [...path, key], "Unknown field.");
    }
  }
}

function requireField(
  field: FieldValue,
  path: Path,
  errors: SbomScanValidationError[],
): void {
  if (!field.present) {
    addError(errors, path, "Required field is missing.");
  }
}

function plainEnvelopeObject(value: unknown): value is object {
  try {
    if (value === null || typeof value !== "object" || Array.isArray(value) || nodeTypes.isProxy(value)) {
      return false;
    }

    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
  } catch {
    return false;
  }
}

function ownKeys(
  value: object,
  path: Path,
  errors: SbomScanValidationError[],
): readonly PropertyKey[] | undefined {
  try {
    return Reflect.ownKeys(value);
  } catch {
    addError(errors, path, "Could not inspect object fields.");
    return undefined;
  }
}

function ownDataDescriptor(
  value: object,
  key: PropertyKey,
  path: Path,
  errors: SbomScanValidationError[],
): (PropertyDescriptor & { readonly value: unknown }) | undefined {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);

    if (
      descriptor === undefined ||
      !isDataDescriptor(descriptor) ||
      descriptor.enumerable !== true
    ) {
      addError(errors, path, "Expected enumerable data field.");
      return undefined;
    }

    return descriptor;
  } catch {
    addError(errors, path, "Could not inspect field.");
    return undefined;
  }
}

function isDataDescriptor(
  descriptor: PropertyDescriptor,
): descriptor is PropertyDescriptor & { readonly value: unknown } {
  return Object.prototype.hasOwnProperty.call(descriptor, "value");
}

function looksEmbeddedMaterial(value: string): boolean {
  const lower = value.toLowerCase();

  return (
    value.length > MAX_REFERENCE_LENGTH ||
    /[\u0000-\u001f\u007f]/u.test(value) ||
    /-----begin [^-]*(private|secret|key|certificate)[^-]*-----/iu.test(value) ||
    /\b(private[-_\s]?key|api[-_\s]?key|access[-_\s]?token|refresh[-_\s]?token|password|secret)\s*(?:=|:(?!\/\/))/iu.test(
      value,
    ) ||
    lower.includes("openssh private key")
  );
}

function isReferenceSyntax(value: string): boolean {
  if (value !== value.trim()) {
    return false;
  }

  if (/[\s<>{}`"']/u.test(value)) {
    return false;
  }

  const separator = value.indexOf("://");

  if (separator <= 0 || separator === value.length - 3) {
    return false;
  }

  const scheme = value.slice(0, separator).toLowerCase();
  const body = value.slice(separator + 3);

  return /^[a-z][a-z0-9+.-]*$/u.test(scheme) && !INLINE_REFERENCE_SCHEMES.has(scheme) && body !== "";
}

function plainJsonObject(value: PlainJson | undefined): value is PlainJsonObject {
  return value !== undefined && value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasOwn(value: PlainJsonObject, key: string): boolean {
  return Object.hasOwn(value, key);
}

function sortedKeys(value: PlainJsonObject): string[] {
  return Object.keys(value).sort(compareStrings);
}

function reject(errors: readonly SbomScanValidationError[]): SbomScanValidationResult {
  return {
    errors,
    ok: false,
  };
}

function addError(
  errors: SbomScanValidationError[],
  path: Path,
  message: string,
): void {
  errors[errors.length] = {
    message,
    path: formatPath(path),
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
