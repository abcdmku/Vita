import { validatePackageContract } from "../../../sdk/manifests/src/package-contract.ts";
import type {
  ImmutableDigest,
  PackageContract,
  SigningPublisher,
  VulnerabilityStatus,
} from "../../../sdk/manifests/src/package-contract.ts";

export interface CatalogEntryValidationError {
  readonly path: string;
  readonly message: string;
}

export type CatalogEntryValidationResult =
  | {
      readonly ok: true;
      readonly entry: CatalogEntry;
    }
  | {
      readonly ok: false;
      readonly errors: readonly CatalogEntryValidationError[];
    };

export type TrustTier = "verified" | "community";

export interface CatalogEntry {
  readonly package: PackageContract | PackageContractReference;
  readonly signingPublisher: SigningPublisher;
  readonly signatures: readonly CatalogSignatureReference[];
  readonly sbom: CatalogSbomReference;
  readonly vulnerabilityStatus: VulnerabilityStatus;
  readonly endOfSupport: string;
  readonly digest: ImmutableDigest;
  readonly trustTier: TrustTier;
}

export type PackageContractReference = string | PackageContractReferenceDescriptor;

export interface PackageContractReferenceDescriptor {
  readonly ref: string;
  readonly digest?: ImmutableDigest;
  readonly version?: string;
}

export type CatalogSignatureReference = string | CatalogSignatureReferenceDescriptor;

export interface CatalogSignatureReferenceDescriptor {
  readonly ref: string;
  readonly keyRef?: string;
  readonly algorithm?: string;
  readonly digest?: ImmutableDigest;
  readonly signedAt?: string;
}

export interface CatalogSbomReference {
  readonly format: "spdx-json" | "cyclonedx-json";
  readonly ref: string;
  readonly digest: ImmutableDigest;
  readonly generatedAt: string;
}

type Plain = null | boolean | number | string | Plain[] | { [key: string]: Plain };
type PlainObject = { [key: string]: Plain };
type Path = readonly string[];

interface NormalizationContext {
  readonly errors: CatalogEntryValidationError[];
  readonly seen: WeakSet<object>;
}

type ReadResult = { readonly ok: true; readonly value: unknown } | { readonly ok: false };

const MAX_DEPTH = 64;
const MAX_ITEMS = 10_000;
const MAX_REFERENCE_LENGTH = 2_048;

const TOP_LEVEL_FIELDS = new Set([
  "package",
  "signingPublisher",
  "signatures",
  "sbom",
  "vulnerabilityStatus",
  "endOfSupport",
  "digest",
  "trustTier",
]);
const PACKAGE_REFERENCE_FIELDS = new Set(["ref", "digest", "version"]);
const SIGNING_PUBLISHER_FIELDS = new Set(["id", "signingKeyRef"]);
const SIGNATURE_FIELDS = new Set(["ref", "keyRef", "algorithm", "digest", "signedAt"]);
const SBOM_FIELDS = new Set(["format", "ref", "digest", "generatedAt"]);
const VULNERABILITY_FIELDS = new Set(["status", "scannedAt", "critical", "high", "medium", "low"]);
const DIGEST_FIELDS = new Set(["algorithm", "value"]);

const TRUST_TIERS = new Set(["verified", "community"]);
const DIGEST_ALGORITHMS = new Set(["sha256", "sha384", "sha512"]);
const SBOM_FORMATS = new Set(["spdx-json", "cyclonedx-json"]);
const VULNERABILITY_STATUSES = new Set([
  "clean",
  "known-vulnerabilities",
  "scan-pending",
  "scan-unavailable",
]);
const INLINE_REFERENCE_SCHEMES = new Set(["data", "inline", "literal"]);
const SHADOWABLE_ARRAY_METHODS = new Set(["some", "includes", "find", "forEach"]);

export function validateCatalogEntry(value: unknown): CatalogEntryValidationResult {
  const errors: CatalogEntryValidationError[] = [];

  try {
    const normalized = normalizePlain(value, [], {
      errors,
      seen: new WeakSet<object>(),
    });

    if (errors.length > 0) {
      return { ok: false, errors };
    }

    if (!record(normalized)) {
      addError(errors, [], "Expected catalog entry object.");
      return { ok: false, errors };
    }

    if (!validateCatalogEntryShape(normalized, [], errors)) {
      return { ok: false, errors };
    }

    return {
      ok: true,
      entry: normalized,
    };
  } catch {
    return {
      ok: false,
      errors: [
        {
          path: "",
          message: "Catalog entry validation failed closed.",
        },
      ],
    };
  }
}

function validateCatalogEntryShape(
  value: PlainObject,
  path: Path,
  errors: CatalogEntryValidationError[],
): value is PlainObject & CatalogEntry {
  const errorStart = errors.length;

  rejectUnknownFields(value, TOP_LEVEL_FIELDS, path, errors);
  validatePackage(value, "package", [...path, "package"], errors);
  validateRequiredObject(
    value,
    "signingPublisher",
    [...path, "signingPublisher"],
    errors,
    validateSigningPublisher,
  );
  validateRequiredNonEmptyArray(value, "signatures", [...path, "signatures"], errors, validateSignature);
  validateRequiredObject(value, "sbom", [...path, "sbom"], errors, validateSbom);
  validateRequiredObject(
    value,
    "vulnerabilityStatus",
    [...path, "vulnerabilityStatus"],
    errors,
    validateVulnerabilityStatus,
  );
  validateRequiredDate(value, "endOfSupport", [...path, "endOfSupport"], errors);
  validateRequiredObject(value, "digest", [...path, "digest"], errors, validateDigest);
  validateRequiredStringEnum(value, "trustTier", TRUST_TIERS, [...path, "trustTier"], errors);

  return errors.length === errorStart;
}

function validatePackage(
  value: PlainObject,
  key: string,
  path: Path,
  errors: CatalogEntryValidationError[],
): void {
  if (!hasOwn(value, key)) {
    addError(errors, path, "Required field is missing.");
    return;
  }

  const child = value[key];

  if (typeof child === "string") {
    validateReferenceValue(child, path, errors);
    return;
  }

  if (!record(child)) {
    addError(errors, path, "Expected package contract object or reference.");
    return;
  }

  if (hasOwn(child, "ref")) {
    validatePackageReference(child, path, errors);
    return;
  }

  const result = validatePackageContract(child);

  if (!result.ok) {
    appendPrefixedErrors(errors, path, result.errors);
    return;
  }

  validatePackageReferenceFields(result.contract, path, errors);
}

function validatePackageReference(
  value: PlainObject,
  path: Path,
  errors: CatalogEntryValidationError[],
): void {
  rejectUnknownFields(value, PACKAGE_REFERENCE_FIELDS, path, errors);
  validateRequiredReference(value, "ref", [...path, "ref"], errors);
  validateOptionalObject(value, "digest", [...path, "digest"], errors, validateDigest);
  validateOptionalString(value, "version", [...path, "version"], errors);
}

function validatePackageReferenceFields(
  contract: PackageContract,
  path: Path,
  errors: CatalogEntryValidationError[],
): void {
  validateReferenceValue(
    contract.signingPublisher.signingKeyRef,
    [...path, "signingPublisher", "signingKeyRef"],
    errors,
  );

  for (let index = 0; index < contract.secrets.length; index += 1) {
    const secret = contract.secrets[index];
    if (secret !== undefined) {
      validateReferenceValue(secret.ref, [...path, "secrets", String(index), "ref"], errors);
    }
  }
}

function validateSigningPublisher(
  value: PlainObject,
  path: Path,
  errors: CatalogEntryValidationError[],
): void {
  rejectUnknownFields(value, SIGNING_PUBLISHER_FIELDS, path, errors);
  validateRequiredString(value, "id", [...path, "id"], errors);
  validateRequiredReference(value, "signingKeyRef", [...path, "signingKeyRef"], errors);
}

function validateSignature(
  value: Plain | undefined,
  path: Path,
  errors: CatalogEntryValidationError[],
): void {
  if (typeof value === "string") {
    validateReferenceValue(value, path, errors);
    return;
  }

  if (!record(value)) {
    addError(errors, path, "Expected signature reference object.");
    return;
  }

  rejectUnknownFields(value, SIGNATURE_FIELDS, path, errors);
  validateRequiredReference(value, "ref", [...path, "ref"], errors);
  validateOptionalReference(value, "keyRef", [...path, "keyRef"], errors);
  validateOptionalString(value, "algorithm", [...path, "algorithm"], errors);
  validateOptionalObject(value, "digest", [...path, "digest"], errors, validateDigest);
  validateOptionalDateTime(value, "signedAt", [...path, "signedAt"], errors);
}

function validateSbom(
  value: PlainObject,
  path: Path,
  errors: CatalogEntryValidationError[],
): void {
  rejectUnknownFields(value, SBOM_FIELDS, path, errors);
  validateRequiredStringEnum(value, "format", SBOM_FORMATS, [...path, "format"], errors);
  validateRequiredReference(value, "ref", [...path, "ref"], errors);
  validateRequiredObject(value, "digest", [...path, "digest"], errors, validateDigest);
  validateRequiredDateTime(value, "generatedAt", [...path, "generatedAt"], errors);
}

function validateVulnerabilityStatus(
  value: PlainObject,
  path: Path,
  errors: CatalogEntryValidationError[],
): void {
  rejectUnknownFields(value, VULNERABILITY_FIELDS, path, errors);
  validateRequiredStringEnum(value, "status", VULNERABILITY_STATUSES, [...path, "status"], errors);
  validateOptionalDateTime(value, "scannedAt", [...path, "scannedAt"], errors);
  validateRequiredNonNegativeInteger(value, "critical", [...path, "critical"], errors);
  validateRequiredNonNegativeInteger(value, "high", [...path, "high"], errors);
  validateRequiredNonNegativeInteger(value, "medium", [...path, "medium"], errors);
  validateRequiredNonNegativeInteger(value, "low", [...path, "low"], errors);
}

function validateDigest(
  value: PlainObject,
  path: Path,
  errors: CatalogEntryValidationError[],
): void {
  rejectUnknownFields(value, DIGEST_FIELDS, path, errors);
  validateRequiredStringEnum(value, "algorithm", DIGEST_ALGORITHMS, [...path, "algorithm"], errors);
  validateRequiredString(value, "value", [...path, "value"], errors);
}

function validateRequiredObject(
  value: PlainObject,
  key: string,
  path: Path,
  errors: CatalogEntryValidationError[],
  validate: (
    objectValue: PlainObject,
    objectPath: Path,
    objectErrors: CatalogEntryValidationError[],
  ) => void,
): void {
  if (!hasOwn(value, key)) {
    addError(errors, path, "Required field is missing.");
    return;
  }

  const child = value[key];

  if (!record(child)) {
    addError(errors, path, "Expected object.");
    return;
  }

  validate(child, path, errors);
}

function validateOptionalObject(
  value: PlainObject,
  key: string,
  path: Path,
  errors: CatalogEntryValidationError[],
  validate: (
    objectValue: PlainObject,
    objectPath: Path,
    objectErrors: CatalogEntryValidationError[],
  ) => void,
): void {
  if (!hasOwn(value, key)) {
    return;
  }

  const child = value[key];

  if (!record(child)) {
    addError(errors, path, "Expected object.");
    return;
  }

  validate(child, path, errors);
}

function validateRequiredNonEmptyArray(
  value: PlainObject,
  key: string,
  path: Path,
  errors: CatalogEntryValidationError[],
  validate: (
    item: Plain | undefined,
    itemPath: Path,
    itemErrors: CatalogEntryValidationError[],
  ) => void,
): void {
  if (!hasOwn(value, key)) {
    addError(errors, path, "Required field is missing.");
    return;
  }

  const child = value[key];

  if (!Array.isArray(child)) {
    addError(errors, path, "Expected array.");
    return;
  }

  if (child.length === 0) {
    addError(errors, path, "Expected at least one entry.");
    return;
  }

  for (let index = 0; index < child.length; index += 1) {
    validate(child[index], [...path, String(index)], errors);
  }
}

function validateRequiredString(
  value: PlainObject,
  key: string,
  path: Path,
  errors: CatalogEntryValidationError[],
): void {
  if (!hasOwn(value, key)) {
    addError(errors, path, "Required field is missing.");
    return;
  }

  if (typeof value[key] !== "string" || value[key] === "") {
    addError(errors, path, "Expected non-empty string.");
  }
}

function validateOptionalString(
  value: PlainObject,
  key: string,
  path: Path,
  errors: CatalogEntryValidationError[],
): void {
  if (!hasOwn(value, key)) {
    return;
  }

  if (typeof value[key] !== "string" || value[key] === "") {
    addError(errors, path, "Expected non-empty string.");
  }
}

function validateRequiredReference(
  value: PlainObject,
  key: string,
  path: Path,
  errors: CatalogEntryValidationError[],
): void {
  if (!hasOwn(value, key)) {
    addError(errors, path, "Required field is missing.");
    return;
  }

  validateReferenceValue(value[key], path, errors);
}

function validateOptionalReference(
  value: PlainObject,
  key: string,
  path: Path,
  errors: CatalogEntryValidationError[],
): void {
  if (!hasOwn(value, key)) {
    return;
  }

  validateReferenceValue(value[key], path, errors);
}

function validateReferenceValue(
  value: Plain | undefined,
  path: Path,
  errors: CatalogEntryValidationError[],
): void {
  if (typeof value !== "string" || value === "") {
    addError(errors, path, "Expected non-empty reference string.");
    return;
  }

  if (looksEmbeddedMaterial(value)) {
    addError(errors, path, "Secret or content material must be referenced, not embedded.");
    return;
  }

  if (!isReferenceSyntax(value)) {
    addError(errors, path, "Expected reference URI.");
  }
}

function validateRequiredStringEnum(
  value: PlainObject,
  key: string,
  allowed: ReadonlySet<string>,
  path: Path,
  errors: CatalogEntryValidationError[],
): void {
  if (!hasOwn(value, key)) {
    addError(errors, path, "Required field is missing.");
    return;
  }

  if (typeof value[key] !== "string" || !allowed.has(value[key])) {
    addError(errors, path, `Expected one of: ${setValues(allowed)}.`);
  }
}

function validateRequiredNonNegativeInteger(
  value: PlainObject,
  key: string,
  path: Path,
  errors: CatalogEntryValidationError[],
): void {
  if (!hasOwn(value, key)) {
    addError(errors, path, "Required field is missing.");
    return;
  }

  if (!isNonNegativeInteger(value[key])) {
    addError(errors, path, "Expected non-negative integer.");
  }
}

function validateRequiredDate(
  value: PlainObject,
  key: string,
  path: Path,
  errors: CatalogEntryValidationError[],
): void {
  if (!hasOwn(value, key)) {
    addError(errors, path, "Required field is missing.");
    return;
  }

  if (typeof value[key] !== "string" || !isDateOnly(value[key])) {
    addError(errors, path, "Expected ISO date in YYYY-MM-DD format.");
  }
}

function validateRequiredDateTime(
  value: PlainObject,
  key: string,
  path: Path,
  errors: CatalogEntryValidationError[],
): void {
  if (!hasOwn(value, key)) {
    addError(errors, path, "Required field is missing.");
    return;
  }

  if (typeof value[key] !== "string" || !Number.isFinite(Date.parse(value[key]))) {
    addError(errors, path, "Expected ISO timestamp string.");
  }
}

function validateOptionalDateTime(
  value: PlainObject,
  key: string,
  path: Path,
  errors: CatalogEntryValidationError[],
): void {
  if (!hasOwn(value, key)) {
    return;
  }

  if (typeof value[key] !== "string" || !Number.isFinite(Date.parse(value[key]))) {
    addError(errors, path, "Expected ISO timestamp string.");
  }
}

function rejectUnknownFields(
  value: PlainObject,
  allowed: ReadonlySet<string>,
  path: Path,
  errors: CatalogEntryValidationError[],
): void {
  const keys = Object.keys(value).sort(compareStrings);

  for (let index = 0; index < keys.length; index += 1) {
    const key = keys[index];
    if (key !== undefined && !allowed.has(key)) {
      addError(errors, [...path, key], "Unknown field.");
    }
  }
}

function normalizePlain(
  value: unknown,
  path: Path,
  context: NormalizationContext,
): Plain | undefined {
  if (path.length > MAX_DEPTH) {
    addError(context.errors, path, "Maximum validation depth exceeded.");
    return undefined;
  }

  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return value;
  }

  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      addError(context.errors, path, "Expected finite number.");
      return undefined;
    }

    return value;
  }

  if (typeof value !== "object") {
    addError(context.errors, path, "Expected JSON-compatible value.");
    return undefined;
  }

  if (context.seen.has(value)) {
    addError(context.errors, path, "Cyclic object is not allowed.");
    return undefined;
  }

  const isArray = Array.isArray(value);
  const prototype = stablePrototype(value);

  if (
    prototype === undefined ||
    (isArray && prototype !== Array.prototype) ||
    (!isArray && prototype !== Object.prototype && prototype !== null)
  ) {
    addError(context.errors, path, "Expected plain object or array.");
    return undefined;
  }

  const keys = stableKeys(value);

  if (keys === undefined) {
    addError(context.errors, path, "Could not safely inspect value.");
    return undefined;
  }

  if (keys.length > MAX_ITEMS + 1) {
    addError(context.errors, path, "Too many fields.");
    return undefined;
  }

  context.seen.add(value);
  try {
    if (isArray) {
      return normalizeArray(value as readonly unknown[], keys, path, context);
    }

    return normalizeObject(value, keys, path, context);
  } finally {
    context.seen.delete(value);
  }
}

function normalizeArray(
  value: readonly unknown[],
  keys: readonly PropertyKey[],
  path: Path,
  context: NormalizationContext,
): Plain[] | undefined {
  const length = stableLength(value);

  if (length === undefined || length > MAX_ITEMS) {
    addError(context.errors, path, "Could not safely inspect array.");
    return undefined;
  }

  for (let index = 0; index < keys.length; index += 1) {
    const key = keys[index];

    if (key === "length") {
      continue;
    }

    if (typeof key !== "string") {
      addError(context.errors, [...path, String(key)], "Symbol properties are not allowed.");
      return undefined;
    }

    if (SHADOWABLE_ARRAY_METHODS.has(key)) {
      addError(context.errors, [...path, key], "Array method shadowing is not allowed.");
      return undefined;
    }

    if (!arrayIndexKey(key)) {
      addError(context.errors, [...path, key], "Array extra properties are not allowed.");
      return undefined;
    }
  }

  const clone: Plain[] = [];

  for (let index = 0; index < length; index += 1) {
    const key = String(index);

    if (stableOwn(value, key) !== true) {
      addError(context.errors, [...path, key], "Sparse arrays are not allowed.");
      return undefined;
    }

    const child = stableData(value, key);

    if (!child.ok) {
      addError(context.errors, [...path, key], "Could not safely read value.");
      return undefined;
    }

    const childClone = normalizePlain(child.value, [...path, key], context);

    if (childClone === undefined) {
      return undefined;
    }

    clone[index] = childClone;
  }

  return clone;
}

function normalizeObject(
  value: object,
  keys: readonly PropertyKey[],
  path: Path,
  context: NormalizationContext,
): PlainObject | undefined {
  if (keys.length > MAX_ITEMS) {
    addError(context.errors, path, "Too many fields.");
    return undefined;
  }

  const clone = Object.create(null) as PlainObject;

  for (let index = 0; index < keys.length; index += 1) {
    const key = keys[index];

    if (typeof key !== "string") {
      addError(context.errors, [...path, String(key)], "Symbol properties are not allowed.");
      return undefined;
    }

    const child = stableData(value, key);

    if (!child.ok) {
      addError(context.errors, [...path, key], "Could not safely read value.");
      return undefined;
    }

    const childClone = normalizePlain(child.value, [...path, key], context);

    if (childClone === undefined) {
      return undefined;
    }

    clone[key] = childClone;
  }

  return clone;
}

function stablePrototype(value: object): object | null | undefined {
  try {
    const first = Object.getPrototypeOf(value);
    const second = Object.getPrototypeOf(value);

    return first === second ? first : undefined;
  } catch {
    return undefined;
  }
}

function stableKeys(value: object): readonly PropertyKey[] | undefined {
  try {
    const first = Reflect.ownKeys(value);
    const second = Reflect.ownKeys(value);

    if (first.length !== second.length) {
      return undefined;
    }

    for (let index = 0; index < first.length; index += 1) {
      if (first[index] !== second[index]) {
        return undefined;
      }
    }

    return first;
  } catch {
    return undefined;
  }
}

function stableLength(value: readonly unknown[]): number | undefined {
  try {
    const first = value.length;
    const second = value.length;

    return Number.isInteger(first) && first >= 0 && first === second ? first : undefined;
  } catch {
    return undefined;
  }
}

function stableOwn(value: object, key: PropertyKey): boolean | undefined {
  try {
    const first = Object.hasOwn(value, key);
    const second = Object.hasOwn(value, key);

    return first === second ? first : undefined;
  } catch {
    return undefined;
  }
}

function stableData(value: object, key: PropertyKey): ReadResult {
  try {
    const first = Object.getOwnPropertyDescriptor(value, key);
    const second = Object.getOwnPropertyDescriptor(value, key);

    if (first === undefined || second === undefined || !("value" in first) || !("value" in second)) {
      return { ok: false };
    }

    const indexed = (value as Record<PropertyKey, unknown>)[key];
    const indexedAgain = (value as Record<PropertyKey, unknown>)[key];

    if (
      !Object.is(first.value, second.value) ||
      !Object.is(indexed, first.value) ||
      !Object.is(indexedAgain, first.value)
    ) {
      return { ok: false };
    }

    return {
      ok: true,
      value: first.value,
    };
  } catch {
    return { ok: false };
  }
}

function appendPrefixedErrors(
  errors: CatalogEntryValidationError[],
  path: Path,
  childErrors: readonly { readonly path: string; readonly message: string }[],
): void {
  const prefix = formatPath(path);

  for (let index = 0; index < childErrors.length; index += 1) {
    const error = childErrors[index];
    if (error !== undefined) {
      errors[errors.length] = {
        path: error.path === "" ? prefix : `${prefix}/${error.path}`,
        message: error.message,
      };
    }
  }
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

function record(value: Plain | undefined): value is PlainObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasOwn(value: PlainObject, key: string): boolean {
  return Object.hasOwn(value, key);
}

function isNonNegativeInteger(value: Plain | undefined): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function isDateOnly(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return false;
  }

  const parsed = Date.parse(`${value}T00:00:00.000Z`);

  return Number.isFinite(parsed) && new Date(parsed).toISOString().startsWith(value);
}

function arrayIndexKey(key: string): boolean {
  const parsed = Number(key);

  return Number.isInteger(parsed) && parsed >= 0 && parsed < 4_294_967_295 && String(parsed) === key;
}

function setValues(values: ReadonlySet<string>): string {
  return Array.from(values).sort(compareStrings).join(", ");
}

function addError(errors: CatalogEntryValidationError[], path: Path, message: string): void {
  errors[errors.length] = {
    path: formatPath(path),
    message,
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
