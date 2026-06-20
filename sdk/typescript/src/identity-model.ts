import { safeNormalize } from "./safe-normalize.ts";
import type { PlainJson, PlainJsonObject } from "./safe-normalize.ts";

export type Did = `did:plc:${string}` | `did:web:${string}`;
export type Handle = string;
export type PdsEndpoint = string;
export type KeyReference = string;

export interface SigningKeyRef {
  readonly id: KeyReference;
  readonly handle: KeyReference;
}

export type RotationKeyRef = SigningKeyRef;

export interface PdsConfig {
  readonly endpoint: PdsEndpoint;
}

export interface IdentityConfig {
  readonly did: Did;
  readonly handle: Handle;
  readonly pds: PdsConfig;
  readonly signingKeyRef: SigningKeyRef;
  readonly rotationKeyRefs: readonly RotationKeyRef[];
}

export interface ValidationError {
  readonly path: string;
  readonly message: string;
}

export type Result =
  | {
      readonly ok: true;
      readonly config: IdentityConfig;
      readonly value: IdentityConfig;
    }
  | {
      readonly ok: false;
      readonly errors: readonly ValidationError[];
    };

type JsonRecord = PlainJsonObject;
type Path = readonly string[];

const IDENTITY_CONFIG_FIELDS = new Set([
  "did",
  "handle",
  "pds",
  "rotationKeyRefs",
  "signingKeyRef",
]);
const PDS_CONFIG_FIELDS = new Set(["endpoint"]);
const KEY_REF_FIELDS = new Set(["handle", "id"]);

const DID_PLC_PREFIX = "did:plc:";
const DID_WEB_PREFIX = "did:web:";
const DID_PLC_IDENTIFIER_PATTERN = /^[a-z2-7]{24}$/u;
const DID_WEB_PATH_SEGMENT_PATTERN = /^(?:[A-Za-z0-9._~-]|%[0-9A-Fa-f]{2})+$/u;
const HANDLE_LABEL_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u;
const OPAQUE_REF_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,255}$/u;
const SCHEME_PATTERN = /^[a-z][a-z0-9+.-]*$/u;

const MAX_HANDLE_LENGTH = 253;
const MAX_DID_LENGTH = 2048;
const MAX_ENDPOINT_LENGTH = 2048;
const MAX_KEY_REF_LENGTH = 2048;

const SECRET_FIELD_NAME_TOKENS = new Set([
  "apikey",
  "key",
  "keymaterial",
  "mnemonic",
  "passphrase",
  "pem",
  "privatekey",
  "recoverykey",
  "rotationkey",
  "seed",
  "seedphrase",
  "secret",
  "signingkey",
]);
const INLINE_REFERENCE_SCHEMES = new Set(["data", "inline", "literal"]);

const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f]/u;
const PEM_BLOCK_PATTERN = /-----BEGIN\b/i;
const PRIVATE_KEY_PATTERN =
  /\b(?:private[-_\s]?key|openssh\s+private\s+key|age-secret-key|xprv|seed[-_\s]?phrase|mnemonic|recovery[-_\s]?phrase)\b/i;
const SECRET_ASSIGNMENT_PATTERN =
  /\b(?:private[-_\s]?key|api[-_\s]?key|access[-_\s]?token|refresh[-_\s]?token|password|secret)\s*(?:=|:(?!\/\/))/i;
const SEED_WORDS_PATTERN = /\b[a-z]{3,12}(?:\s+[a-z]{3,12}){11,23}\b/i;
const LONG_HEX_PATTERN = /(?:0x)?[A-Fa-f0-9]{32,}/u;
const LONG_BASE64_PATTERN = /[A-Za-z0-9+/]{48,}={0,2}|[A-Za-z0-9_-]{48,}/u;

export function validateIdentityConfig(input: unknown): Result {
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
    const config = parseIdentityConfig(normalized.value, [], errors);

    if (config === undefined || errors.length > 0) {
      return reject(errors);
    }

    return {
      ok: true,
      config,
      value: config,
    };
  } catch {
    return reject([{ path: "", message: "Identity config validation failed." }]);
  }
}

function parseIdentityConfig(
  value: PlainJson,
  path: Path,
  errors: ValidationError[],
): IdentityConfig | undefined {
  if (!isRecord(value)) {
    addError(errors, path, "Expected identity config object.");
    return undefined;
  }

  const errorStart = errors.length;

  rejectUnknownFields(value, IDENTITY_CONFIG_FIELDS, path, errors);
  rejectSecretFieldNames(value, path, errors);

  const did = validateRequiredDid(value, "did", [...path, "did"], errors);
  const handle = validateRequiredHandle(value, "handle", [...path, "handle"], errors);
  const pds = parseRequiredObject(value, "pds", [...path, "pds"], errors, parsePdsConfig);
  const signingKeyRef = parseRequiredKeyRef(
    value,
    "signingKeyRef",
    [...path, "signingKeyRef"],
    errors,
  );
  const rotationKeyRefs = parseRequiredKeyRefArray(
    value,
    "rotationKeyRefs",
    [...path, "rotationKeyRefs"],
    errors,
  );

  if (
    errors.length > errorStart ||
    did === undefined ||
    handle === undefined ||
    pds === undefined ||
    signingKeyRef === undefined ||
    rotationKeyRefs === undefined
  ) {
    return undefined;
  }

  return Object.freeze({
    did,
    handle,
    pds,
    rotationKeyRefs,
    signingKeyRef,
  });
}

function parsePdsConfig(
  value: JsonRecord,
  path: Path,
  errors: ValidationError[],
): PdsConfig | undefined {
  const errorStart = errors.length;

  rejectUnknownFields(value, PDS_CONFIG_FIELDS, path, errors);
  rejectSecretFieldNames(value, path, errors);

  const endpoint = validateRequiredPdsEndpoint(value, "endpoint", [...path, "endpoint"], errors);

  if (errors.length > errorStart || endpoint === undefined) {
    return undefined;
  }

  return Object.freeze({
    endpoint,
  });
}

function parseRequiredKeyRef(
  value: JsonRecord,
  key: string,
  path: Path,
  errors: ValidationError[],
): SigningKeyRef | undefined {
  const child = readRequiredProperty(value, key, path, errors);

  if (child === undefined) {
    return undefined;
  }

  if (!isRecord(child)) {
    addError(errors, path, "Expected key reference object.");
    return undefined;
  }

  return parseKeyRef(child, path, errors);
}

function parseRequiredKeyRefArray(
  value: JsonRecord,
  key: string,
  path: Path,
  errors: ValidationError[],
): readonly RotationKeyRef[] | undefined {
  const child = readRequiredProperty(value, key, path, errors);

  if (child === undefined) {
    return undefined;
  }

  if (!Array.isArray(child)) {
    addError(errors, path, "Expected key reference array.");
    return undefined;
  }

  if (child.length === 0) {
    addError(errors, path, "Expected at least one rotation key reference.");
    return undefined;
  }

  const refs: RotationKeyRef[] = [];
  const errorStart = errors.length;

  for (let index = 0; index < child.length; index += 1) {
    const item = child[index];

    if (item === undefined) {
      addError(errors, [...path, String(index)], "Expected key reference object.");
      continue;
    }

    if (!isRecord(item)) {
      addError(errors, [...path, String(index)], "Expected key reference object.");
      continue;
    }

    const parsed = parseKeyRef(item, [...path, String(index)], errors);

    if (parsed !== undefined) {
      refs.push(parsed);
    }
  }

  if (errors.length > errorStart) {
    return undefined;
  }

  return Object.freeze(refs);
}

function parseKeyRef(
  value: JsonRecord,
  path: Path,
  errors: ValidationError[],
): SigningKeyRef | undefined {
  const errorStart = errors.length;

  rejectUnknownFields(value, KEY_REF_FIELDS, path, errors);
  rejectSecretFieldNames(value, path, errors);

  const id = validateRequiredKeyReference(value, "id", [...path, "id"], errors);
  const handle = validateRequiredKeyReference(value, "handle", [...path, "handle"], errors);

  if (errors.length > errorStart || id === undefined || handle === undefined) {
    return undefined;
  }

  return Object.freeze({
    handle,
    id,
  });
}

function parseRequiredObject<T>(
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

function validateRequiredDid(
  value: JsonRecord,
  key: string,
  path: Path,
  errors: ValidationError[],
): Did | undefined {
  const child = readRequiredProperty(value, key, path, errors);

  if (child === undefined) {
    return undefined;
  }

  if (typeof child !== "string" || !isSupportedDid(child)) {
    addError(errors, path, "Expected supported did:plc or did:web identifier.");
    return undefined;
  }

  return child;
}

function validateRequiredHandle(
  value: JsonRecord,
  key: string,
  path: Path,
  errors: ValidationError[],
): Handle | undefined {
  const child = readRequiredProperty(value, key, path, errors);

  if (child === undefined) {
    return undefined;
  }

  if (typeof child !== "string" || !isDomainHandle(child)) {
    addError(errors, path, "Expected domain-style handle.");
    return undefined;
  }

  return child;
}

function validateRequiredPdsEndpoint(
  value: JsonRecord,
  key: string,
  path: Path,
  errors: ValidationError[],
): PdsEndpoint | undefined {
  const child = readRequiredProperty(value, key, path, errors);

  if (child === undefined) {
    return undefined;
  }

  if (typeof child !== "string" || !isHttpsBaseEndpoint(child)) {
    addError(errors, path, "Expected HTTPS PDS base endpoint.");
    return undefined;
  }

  return child;
}

function validateRequiredKeyReference(
  value: JsonRecord,
  key: string,
  path: Path,
  errors: ValidationError[],
): KeyReference | undefined {
  const child = readRequiredProperty(value, key, path, errors);

  if (child === undefined) {
    return undefined;
  }

  if (typeof child !== "string" || child.length === 0) {
    addError(errors, path, "Expected key reference string.");
    return undefined;
  }

  if (containsInlineSecretMaterial(child)) {
    addError(errors, path, "Reference must not contain inline key material.");
    return undefined;
  }

  if (child.length > MAX_KEY_REF_LENGTH || !isReferenceSyntax(child)) {
    addError(errors, path, "Expected key reference syntax.");
    return undefined;
  }

  return child;
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
  errors: ValidationError[],
): void {
  const keys = Object.keys(value).sort(compareStrings);

  for (let index = 0; index < keys.length; index += 1) {
    const key = keys[index];

    if (key !== undefined && !allowed.has(key) && !isSecretFieldName(key)) {
      addError(errors, [...path, key], "Unknown field.");
    }
  }
}

function rejectSecretFieldNames(
  value: JsonRecord,
  path: Path,
  errors: ValidationError[],
): void {
  const keys = Object.keys(value).sort(compareStrings);

  for (let index = 0; index < keys.length; index += 1) {
    const key = keys[index];

    if (key !== undefined && isSecretFieldName(key)) {
      addError(errors, [...path, key], "Inline key material is not allowed.");
    }
  }
}

function isSupportedDid(value: string): value is Did {
  if (value.length > MAX_DID_LENGTH || value !== value.trim()) {
    return false;
  }

  return isDidPlc(value) || isDidWeb(value);
}

function isDidPlc(value: string): value is `did:plc:${string}` {
  if (!value.startsWith(DID_PLC_PREFIX)) {
    return false;
  }

  return DID_PLC_IDENTIFIER_PATTERN.test(value.slice(DID_PLC_PREFIX.length));
}

function isDidWeb(value: string): value is `did:web:${string}` {
  if (!value.startsWith(DID_WEB_PREFIX)) {
    return false;
  }

  const identifier = value.slice(DID_WEB_PREFIX.length);

  if (
    identifier === "" ||
    identifier.includes("/") ||
    identifier.includes("?") ||
    identifier.includes("#") ||
    CONTROL_CHARACTER_PATTERN.test(identifier)
  ) {
    return false;
  }

  const segments = identifier.split(":");
  const host = segments[0];

  if (host === undefined || !isDomainHandle(host)) {
    return false;
  }

  for (let index = 1; index < segments.length; index += 1) {
    const segment = segments[index];

    if (
      segment === undefined ||
      segment === "" ||
      segment === "." ||
      segment === ".." ||
      !DID_WEB_PATH_SEGMENT_PATTERN.test(segment)
    ) {
      return false;
    }
  }

  return true;
}

function isDomainHandle(value: string): value is Handle {
  if (
    value.length < 3 ||
    value.length > MAX_HANDLE_LENGTH ||
    value !== value.trim() ||
    value !== value.toLowerCase() ||
    value.includes("://") ||
    value.includes("/") ||
    value.includes(":") ||
    value.endsWith(".")
  ) {
    return false;
  }

  const labels = value.split(".");

  if (labels.length < 2) {
    return false;
  }

  for (let index = 0; index < labels.length; index += 1) {
    const label = labels[index];

    if (
      label === undefined ||
      label.length === 0 ||
      label.length > 63 ||
      !HANDLE_LABEL_PATTERN.test(label)
    ) {
      return false;
    }
  }

  const topLevelLabel = labels[labels.length - 1];

  return topLevelLabel !== undefined && topLevelLabel.length >= 2 && !/^\d+$/u.test(topLevelLabel);
}

function isHttpsBaseEndpoint(value: string): boolean {
  if (
    value.length === 0 ||
    value.length > MAX_ENDPOINT_LENGTH ||
    value !== value.trim() ||
    value !== value.toLowerCase() ||
    containsInlineSecretMaterial(value)
  ) {
    return false;
  }

  let parsed: URL;

  try {
    parsed = new URL(value);
  } catch {
    return false;
  }

  return (
    parsed.protocol === "https:" &&
    parsed.username === "" &&
    parsed.password === "" &&
    parsed.search === "" &&
    parsed.hash === "" &&
    (parsed.pathname === "" || parsed.pathname === "/") &&
    isDomainHandle(parsed.hostname)
  );
}

function isReferenceSyntax(value: string): boolean {
  if (value !== value.trim() || /[\s<>{}`"']/u.test(value) || CONTROL_CHARACTER_PATTERN.test(value)) {
    return false;
  }

  const separator = value.indexOf("://");

  if (separator === -1) {
    return OPAQUE_REF_PATTERN.test(value);
  }

  if (separator <= 0 || separator === value.length - 3) {
    return false;
  }

  const scheme = value.slice(0, separator).toLowerCase();
  const body = value.slice(separator + 3);

  return SCHEME_PATTERN.test(scheme) && !INLINE_REFERENCE_SCHEMES.has(scheme) && body !== "";
}

function containsInlineSecretMaterial(value: string): boolean {
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

function isSecretFieldName(value: string): boolean {
  return SECRET_FIELD_NAME_TOKENS.has(value.replace(/[-_]/gu, "").toLowerCase());
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

function reject(errors: readonly ValidationError[]): Extract<Result, { readonly ok: false }> {
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
