import { safeNormalize } from "./safe-normalize.ts";
import type { Did } from "./identity-model.ts";
import type { PlainJson, PlainJsonObject } from "./safe-normalize.ts";

export type RecordKey = string;
export type SyncCursor = number;

export interface RecordRef {
  readonly collection: string;
  readonly rkey: RecordKey;
  readonly cid: string;
}

export interface RepoCommit {
  readonly rev: string;
  readonly cid: string;
  readonly prev: string | null;
}

export interface SyncState {
  readonly repo: Did;
  readonly cursor: SyncCursor;
  readonly repoHead: RepoCommit;
}

export interface PdsRepoRecord {
  readonly collection: string;
  readonly rkey: RecordKey;
  readonly valueDigest: string;
}

export type PdsRepoCommitLogOp = "create-record" | "delete-record";

export interface PdsRepoCommitLogEntry {
  readonly cursor: SyncCursor;
  readonly op: PdsRepoCommitLogOp;
  readonly collection: string;
  readonly rkey: RecordKey;
}

export interface PdsQueryResponse {
  readonly exists: boolean;
  readonly collection: string;
  readonly records: readonly PdsRepoRecord[];
  readonly total: SyncCursor;
  readonly nextCursor: SyncCursor | null;
}

export interface PdsModelValidationError {
  readonly path: string;
  readonly message: string;
}

type ValidationFailure = {
  readonly ok: false;
  readonly errors: readonly PdsModelValidationError[];
};

export type RecordRefValidationResult =
  | {
      readonly ok: true;
      readonly recordRef: RecordRef;
      readonly value: RecordRef;
    }
  | ValidationFailure;

export type RepoCommitValidationResult =
  | {
      readonly ok: true;
      readonly commit: RepoCommit;
      readonly value: RepoCommit;
    }
  | ValidationFailure;

export type SyncStateValidationResult =
  | {
      readonly ok: true;
      readonly state: SyncState;
      readonly value: SyncState;
    }
  | ValidationFailure;

export type PdsQueryResponseValidationResult =
  | {
      readonly ok: true;
      readonly response: PdsQueryResponse;
      readonly value: PdsQueryResponse;
    }
  | ValidationFailure;

export type PdsCommitLogEntryValidationResult =
  | {
      readonly ok: true;
      readonly entry: PdsRepoCommitLogEntry;
      readonly value: PdsRepoCommitLogEntry;
    }
  | ValidationFailure;

type JsonRecord = PlainJsonObject;
type Path = readonly string[];

const RECORD_REF_FIELDS = new Set(["cid", "collection", "rkey"]);
const REPO_COMMIT_FIELDS = new Set(["cid", "prev", "rev"]);
const SYNC_STATE_FIELDS = new Set(["cursor", "repo", "repoHead"]);
const PDS_REPO_RECORD_FIELDS = new Set(["collection", "rkey", "valueDigest"]);
const PDS_COMMIT_LOG_ENTRY_FIELDS = new Set(["collection", "cursor", "op", "rkey"]);
const PDS_QUERY_RESPONSE_FIELDS = new Set([
  "collection",
  "exists",
  "nextCursor",
  "records",
  "total",
]);

const MAX_NSID_LENGTH = 317;
const MAX_RECORD_KEY_LENGTH = 512;
const MAX_CID_LENGTH = 512;
const MAX_DID_LENGTH = 2048;
const MAX_CURSOR = Number.MAX_SAFE_INTEGER;

const DID_PLC_PREFIX = "did:plc:";
const DID_WEB_PREFIX = "did:web:";
const DID_PLC_IDENTIFIER_PATTERN = /^[a-z2-7]{24}$/u;
const DID_WEB_PATH_SEGMENT_PATTERN = /^(?:[A-Za-z0-9._~-]|%[0-9A-Fa-f]{2})+$/u;
const DID_WEB_HOST_LABEL_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u;

const NSID_LABEL_PATTERN = /^[A-Za-z](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/u;
const RECORD_KEY_PATTERN = /^[A-Za-z0-9_~.:-]+$/u;
const TID_PATTERN = /^[2-7a-z]{13}$/u;
const SHA256_HEX_PATTERN = /^[0-9a-f]{64}$/u;
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f]/u;

const BASE32_LOWER_ALPHABET = "abcdefghijklmnopqrstuvwxyz234567";
const BASE58BTC_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const CID_VERSION = 1;
const MAX_MULTIHASH_DIGEST_BYTES = 128;

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

const PDS_COMMIT_LOG_OPS = new Set(["create-record", "delete-record"]);

export function validateRecordRef(input: unknown): RecordRefValidationResult {
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

    const errors: PdsModelValidationError[] = [];
    const recordRef = parseRecordRef(normalized.value, [], errors);

    if (recordRef === undefined || errors.length > 0) {
      return reject(errors);
    }

    return {
      ok: true,
      recordRef,
      value: recordRef,
    };
  } catch {
    return reject([{ path: "", message: "Record reference validation failed." }]);
  }
}

export function validateRepoCommit(input: unknown): RepoCommitValidationResult {
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

    const errors: PdsModelValidationError[] = [];
    const commit = parseRepoCommit(normalized.value, [], errors);

    if (commit === undefined || errors.length > 0) {
      return reject(errors);
    }

    return {
      ok: true,
      commit,
      value: commit,
    };
  } catch {
    return reject([{ path: "", message: "Repo commit validation failed." }]);
  }
}

export function validateSyncState(input: unknown): SyncStateValidationResult {
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

    const errors: PdsModelValidationError[] = [];
    const state = parseSyncState(normalized.value, [], errors);

    if (state === undefined || errors.length > 0) {
      return reject(errors);
    }

    return {
      ok: true,
      state,
      value: state,
    };
  } catch {
    return reject([{ path: "", message: "Sync state validation failed." }]);
  }
}

export function validatePdsQueryResponse(input: unknown): PdsQueryResponseValidationResult {
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

    const errors: PdsModelValidationError[] = [];
    const response = parsePdsQueryResponse(normalized.value, [], errors);

    if (response === undefined || errors.length > 0) {
      return reject(errors);
    }

    return {
      ok: true,
      response,
      value: response,
    };
  } catch {
    return reject([{ path: "", message: "PDS query response validation failed." }]);
  }
}

export function validatePdsCommitLogEntry(input: unknown): PdsCommitLogEntryValidationResult {
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

    const errors: PdsModelValidationError[] = [];
    const entry = parsePdsCommitLogEntry(normalized.value, [], errors);

    if (entry === undefined || errors.length > 0) {
      return reject(errors);
    }

    return {
      entry,
      ok: true,
      value: entry,
    };
  } catch {
    return reject([{ path: "", message: "PDS commit log entry validation failed." }]);
  }
}

function parseRecordRef(
  value: PlainJson,
  path: Path,
  errors: PdsModelValidationError[],
): RecordRef | undefined {
  if (!isRecord(value)) {
    addError(errors, path, "Expected record reference object.");
    return undefined;
  }

  const errorStart = errors.length;

  rejectUnknownFields(value, RECORD_REF_FIELDS, path, errors);
  rejectSecretFieldNames(value, path, errors);

  const collection = validateRequiredNsid(value, "collection", [...path, "collection"], errors);
  const rkey = validateRequiredRecordKey(value, "rkey", [...path, "rkey"], errors);
  const cid = validateRequiredCid(value, "cid", [...path, "cid"], errors);

  if (
    errors.length > errorStart ||
    collection === undefined ||
    rkey === undefined ||
    cid === undefined
  ) {
    return undefined;
  }

  return Object.freeze({
    cid,
    collection,
    rkey,
  });
}

function parseRepoCommit(
  value: PlainJson,
  path: Path,
  errors: PdsModelValidationError[],
): RepoCommit | undefined {
  if (!isRecord(value)) {
    addError(errors, path, "Expected repo commit object.");
    return undefined;
  }

  return parseRepoCommitRecord(value, path, errors);
}

function parseRepoCommitRecord(
  value: JsonRecord,
  path: Path,
  errors: PdsModelValidationError[],
): RepoCommit | undefined {
  const errorStart = errors.length;

  rejectUnknownFields(value, REPO_COMMIT_FIELDS, path, errors);
  rejectSecretFieldNames(value, path, errors);

  const rev = validateRequiredRepoRev(value, "rev", [...path, "rev"], errors);
  const cid = validateRequiredCid(value, "cid", [...path, "cid"], errors);
  const prev = validateRequiredPrevCid(value, "prev", [...path, "prev"], errors);

  if (
    errors.length > errorStart ||
    rev === undefined ||
    cid === undefined ||
    prev === undefined
  ) {
    return undefined;
  }

  return Object.freeze({
    cid,
    prev,
    rev,
  });
}

function parseSyncState(
  value: PlainJson,
  path: Path,
  errors: PdsModelValidationError[],
): SyncState | undefined {
  if (!isRecord(value)) {
    addError(errors, path, "Expected sync state object.");
    return undefined;
  }

  const errorStart = errors.length;

  rejectUnknownFields(value, SYNC_STATE_FIELDS, path, errors);
  rejectSecretFieldNames(value, path, errors);

  const repo = validateRequiredDid(value, "repo", [...path, "repo"], errors);
  const cursor = validateRequiredCursor(value, "cursor", [...path, "cursor"], errors);
  const repoHead = parseRequiredRepoCommit(value, "repoHead", [...path, "repoHead"], errors);

  if (
    errors.length > errorStart ||
    repo === undefined ||
    cursor === undefined ||
    repoHead === undefined
  ) {
    return undefined;
  }

  return Object.freeze({
    cursor,
    repo,
    repoHead,
  });
}

function parsePdsQueryResponse(
  value: PlainJson,
  path: Path,
  errors: PdsModelValidationError[],
): PdsQueryResponse | undefined {
  if (!isRecord(value)) {
    addError(errors, path, "Expected PDS query response object.");
    return undefined;
  }

  const errorStart = errors.length;

  rejectUnknownFields(value, PDS_QUERY_RESPONSE_FIELDS, path, errors);
  rejectSecretFieldNames(value, path, errors);

  const exists = validateRequiredBoolean(value, "exists", [...path, "exists"], errors);
  const collection = validateRequiredNsid(value, "collection", [...path, "collection"], errors);
  const records = parseRequiredPdsRepoRecords(value, "records", [...path, "records"], errors);
  const total = validateRequiredCursor(value, "total", [...path, "total"], errors);
  const nextCursor = validateRequiredNullableCursor(
    value,
    "nextCursor",
    [...path, "nextCursor"],
    errors,
  );

  if (
    errors.length > errorStart ||
    exists === undefined ||
    collection === undefined ||
    records === undefined ||
    total === undefined ||
    nextCursor === undefined
  ) {
    return undefined;
  }

  if (records.length > total) {
    addError(errors, [...path, "records"], "Record page length cannot exceed total.");
    return undefined;
  }

  return Object.freeze({
    collection,
    exists,
    nextCursor,
    records,
    total,
  });
}

function parsePdsRepoRecord(
  value: PlainJson,
  path: Path,
  errors: PdsModelValidationError[],
): PdsRepoRecord | undefined {
  if (!isRecord(value)) {
    addError(errors, path, "Expected PDS repo record object.");
    return undefined;
  }

  const errorStart = errors.length;

  rejectUnknownFields(value, PDS_REPO_RECORD_FIELDS, path, errors);
  rejectSecretFieldNames(value, path, errors);

  const collection = validateRequiredNsid(value, "collection", [...path, "collection"], errors);
  const rkey = validateRequiredRecordKey(value, "rkey", [...path, "rkey"], errors);
  const valueDigest = validateRequiredSha256Digest(
    value,
    "valueDigest",
    [...path, "valueDigest"],
    errors,
  );

  if (
    errors.length > errorStart ||
    collection === undefined ||
    rkey === undefined ||
    valueDigest === undefined
  ) {
    return undefined;
  }

  return Object.freeze({
    collection,
    rkey,
    valueDigest,
  });
}

function parsePdsCommitLogEntry(
  value: PlainJson,
  path: Path,
  errors: PdsModelValidationError[],
): PdsRepoCommitLogEntry | undefined {
  if (!isRecord(value)) {
    addError(errors, path, "Expected PDS commit log entry object.");
    return undefined;
  }

  const errorStart = errors.length;

  rejectUnknownFields(value, PDS_COMMIT_LOG_ENTRY_FIELDS, path, errors);
  rejectSecretFieldNames(value, path, errors);

  const cursor = validateRequiredCursor(value, "cursor", [...path, "cursor"], errors);
  const op = validateRequiredCommitLogOp(value, "op", [...path, "op"], errors);
  const collection = validateRequiredNsid(value, "collection", [...path, "collection"], errors);
  const rkey = validateRequiredRecordKey(value, "rkey", [...path, "rkey"], errors);

  if (
    errors.length > errorStart ||
    cursor === undefined ||
    op === undefined ||
    collection === undefined ||
    rkey === undefined
  ) {
    return undefined;
  }

  return Object.freeze({
    collection,
    cursor,
    op,
    rkey,
  });
}

function parseRequiredRepoCommit(
  value: JsonRecord,
  key: string,
  path: Path,
  errors: PdsModelValidationError[],
): RepoCommit | undefined {
  const child = readRequiredProperty(value, key, path, errors);

  if (child === undefined) {
    return undefined;
  }

  if (!isRecord(child)) {
    addError(errors, path, "Expected repo commit object.");
    return undefined;
  }

  return parseRepoCommitRecord(child, path, errors);
}

function parseRequiredPdsRepoRecords(
  value: JsonRecord,
  key: string,
  path: Path,
  errors: PdsModelValidationError[],
): readonly PdsRepoRecord[] | undefined {
  const child = readRequiredProperty(value, key, path, errors);

  if (child === undefined) {
    return undefined;
  }

  if (!Array.isArray(child)) {
    addError(errors, path, "Expected PDS repo records array.");
    return undefined;
  }

  const records: PdsRepoRecord[] = [];
  const errorStart = errors.length;

  for (let index = 0; index < child.length; index += 1) {
    const item = child[index];

    if (item === undefined) {
      addError(errors, [...path, String(index)], "Expected PDS repo record object.");
      continue;
    }

    const record = parsePdsRepoRecord(item, [...path, String(index)], errors);
    if (record !== undefined) {
      records[index] = record;
    }
  }

  if (errors.length > errorStart) {
    return undefined;
  }

  return Object.freeze(records);
}

function validateRequiredBoolean(
  value: JsonRecord,
  key: string,
  path: Path,
  errors: PdsModelValidationError[],
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

function validateRequiredNsid(
  value: JsonRecord,
  key: string,
  path: Path,
  errors: PdsModelValidationError[],
): string | undefined {
  const child = readRequiredProperty(value, key, path, errors);

  if (child === undefined) {
    return undefined;
  }

  if (typeof child !== "string" || !isReverseDnsNsid(child)) {
    addError(errors, path, "Expected reverse-DNS NSID collection.");
    return undefined;
  }

  return child;
}

function validateRequiredRecordKey(
  value: JsonRecord,
  key: string,
  path: Path,
  errors: PdsModelValidationError[],
): RecordKey | undefined {
  const child = readRequiredProperty(value, key, path, errors);

  if (child === undefined) {
    return undefined;
  }

  if (typeof child !== "string" || !isRecordKey(child)) {
    addError(errors, path, "Expected AT Protocol record key.");
    return undefined;
  }

  return child;
}

function validateRequiredCommitLogOp(
  value: JsonRecord,
  key: string,
  path: Path,
  errors: PdsModelValidationError[],
): PdsRepoCommitLogOp | undefined {
  const child = readRequiredProperty(value, key, path, errors);

  if (child === undefined) {
    return undefined;
  }

  if (typeof child !== "string" || !isPdsCommitLogOp(child)) {
    addError(errors, path, "Expected create-record or delete-record commit log op.");
    return undefined;
  }

  return child;
}

function validateRequiredCid(
  value: JsonRecord,
  key: string,
  path: Path,
  errors: PdsModelValidationError[],
): string | undefined {
  const child = readRequiredProperty(value, key, path, errors);

  if (child === undefined) {
    return undefined;
  }

  return validateCidValue(child, path, errors);
}

function validateRequiredPrevCid(
  value: JsonRecord,
  key: string,
  path: Path,
  errors: PdsModelValidationError[],
): string | null | undefined {
  const child = readRequiredProperty(value, key, path, errors);

  if (child === undefined) {
    return undefined;
  }

  if (child === null) {
    return null;
  }

  return validateCidValue(child, path, errors);
}

function validateCidValue(
  value: PlainJson,
  path: Path,
  errors: PdsModelValidationError[],
): string | undefined {
  if (typeof value !== "string" || !isCidV1(value)) {
    addError(errors, path, "Expected well-formed CIDv1 string.");
    return undefined;
  }

  return value;
}

function validateRequiredNullableCursor(
  value: JsonRecord,
  key: string,
  path: Path,
  errors: PdsModelValidationError[],
): SyncCursor | null | undefined {
  const child = readRequiredProperty(value, key, path, errors);

  if (child === undefined) {
    return undefined;
  }

  if (child === null) {
    return null;
  }

  if (!isMonotonicCursor(child)) {
    addError(errors, path, `Expected monotonic cursor integer from 0 through ${MAX_CURSOR}, or null.`);
    return undefined;
  }

  return child;
}

function validateRequiredSha256Digest(
  value: JsonRecord,
  key: string,
  path: Path,
  errors: PdsModelValidationError[],
): string | undefined {
  const child = readRequiredProperty(value, key, path, errors);

  if (child === undefined) {
    return undefined;
  }

  if (typeof child !== "string" || !SHA256_HEX_PATTERN.test(child)) {
    addError(errors, path, "Expected lowercase SHA-256 hex digest.");
    return undefined;
  }

  return child;
}

function validateRequiredRepoRev(
  value: JsonRecord,
  key: string,
  path: Path,
  errors: PdsModelValidationError[],
): string | undefined {
  const child = readRequiredProperty(value, key, path, errors);

  if (child === undefined) {
    return undefined;
  }

  if (typeof child !== "string" || !TID_PATTERN.test(child)) {
    addError(errors, path, "Expected AT Protocol repo rev TID.");
    return undefined;
  }

  return child;
}

function validateRequiredDid(
  value: JsonRecord,
  key: string,
  path: Path,
  errors: PdsModelValidationError[],
): Did | undefined {
  const child = readRequiredProperty(value, key, path, errors);

  if (child === undefined) {
    return undefined;
  }

  if (typeof child !== "string" || !isSupportedDid(child)) {
    addError(errors, path, "Expected supported did:plc or did:web repo identifier.");
    return undefined;
  }

  return child;
}

function validateRequiredCursor(
  value: JsonRecord,
  key: string,
  path: Path,
  errors: PdsModelValidationError[],
): SyncCursor | undefined {
  const child = readRequiredProperty(value, key, path, errors);

  if (child === undefined) {
    return undefined;
  }

  if (!isMonotonicCursor(child)) {
    addError(errors, path, `Expected monotonic cursor integer from 0 through ${MAX_CURSOR}.`);
    return undefined;
  }

  return child;
}

function readRequiredProperty(
  value: JsonRecord,
  key: string,
  path: Path,
  errors: PdsModelValidationError[],
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
  errors: PdsModelValidationError[],
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
  errors: PdsModelValidationError[],
): void {
  const keys = Object.keys(value).sort(compareStrings);

  for (let index = 0; index < keys.length; index += 1) {
    const key = keys[index];

    if (key !== undefined && isSecretFieldName(key)) {
      addError(errors, [...path, key], "Inline key material is not allowed.");
    }
  }
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

function isRecordKey(value: string): value is RecordKey {
  if (
    value.length === 0 ||
    value.length > MAX_RECORD_KEY_LENGTH ||
    value === "." ||
    value === ".." ||
    value !== value.trim() ||
    CONTROL_CHARACTER_PATTERN.test(value)
  ) {
    return false;
  }

  return TID_PATTERN.test(value) || RECORD_KEY_PATTERN.test(value);
}

function isMonotonicCursor(value: PlainJson): value is SyncCursor {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 0 &&
    value <= MAX_CURSOR
  );
}

function isPdsCommitLogOp(value: string): value is PdsRepoCommitLogOp {
  return PDS_COMMIT_LOG_OPS.has(value);
}

function isCidV1(value: string): boolean {
  if (
    value.length === 0 ||
    value.length > MAX_CID_LENGTH ||
    value !== value.trim() ||
    CONTROL_CHARACTER_PATTERN.test(value)
  ) {
    return false;
  }

  const bytes = decodeMultibase(value);

  if (bytes === undefined) {
    return false;
  }

  return isCidV1Bytes(bytes);
}

function decodeMultibase(value: string): readonly number[] | undefined {
  const prefix = value[0];
  const encoded = value.slice(1);

  if (encoded.length === 0) {
    return undefined;
  }

  if (prefix === "b") {
    if (encoded !== encoded.toLowerCase()) {
      return undefined;
    }

    return decodeBase32(encoded);
  }

  if (prefix === "B") {
    if (encoded !== encoded.toUpperCase()) {
      return undefined;
    }

    return decodeBase32(encoded.toLowerCase());
  }

  if (prefix === "z") {
    return decodeBase58Btc(encoded);
  }

  return undefined;
}

function decodeBase32(value: string): readonly number[] | undefined {
  let buffer = 0;
  let bits = 0;
  const bytes: number[] = [];

  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];

    if (character === undefined) {
      return undefined;
    }

    const digit = BASE32_LOWER_ALPHABET.indexOf(character);

    if (digit < 0) {
      return undefined;
    }

    buffer = (buffer << 5) | digit;
    bits += 5;

    while (bits >= 8) {
      bits -= 8;
      bytes.push((buffer >> bits) & 0xff);
    }
  }

  if (bits > 0 && (buffer & ((1 << bits) - 1)) !== 0) {
    return undefined;
  }

  return Object.freeze(bytes);
}

function decodeBase58Btc(value: string): readonly number[] | undefined {
  let decoded = 0n;

  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];

    if (character === undefined) {
      return undefined;
    }

    const digit = BASE58BTC_ALPHABET.indexOf(character);

    if (digit < 0) {
      return undefined;
    }

    decoded = decoded * 58n + BigInt(digit);
  }

  const bytes: number[] = [];

  while (decoded > 0n) {
    bytes.unshift(Number(decoded & 0xffn));
    decoded >>= 8n;
  }

  for (let index = 0; index < value.length && value[index] === "1"; index += 1) {
    bytes.unshift(0);
  }

  return Object.freeze(bytes);
}

function isCidV1Bytes(bytes: readonly number[]): boolean {
  const version = readVarint(bytes, 0);

  if (version === undefined || version.value !== CID_VERSION) {
    return false;
  }

  const codec = readVarint(bytes, version.next);

  if (codec === undefined || codec.value <= 0) {
    return false;
  }

  const hashCode = readVarint(bytes, codec.next);

  if (hashCode === undefined || hashCode.value <= 0) {
    return false;
  }

  const digestSize = readVarint(bytes, hashCode.next);

  return (
    digestSize !== undefined &&
    digestSize.value > 0 &&
    digestSize.value <= MAX_MULTIHASH_DIGEST_BYTES &&
    digestSize.next + digestSize.value === bytes.length
  );
}

function readVarint(
  bytes: readonly number[],
  offset: number,
): { readonly value: number; readonly next: number } | undefined {
  let value = 0;
  let shift = 0;

  for (let index = offset; index < bytes.length; index += 1) {
    const byte = bytes[index];

    if (byte === undefined) {
      return undefined;
    }

    value += (byte & 0x7f) * 2 ** shift;

    if (!Number.isSafeInteger(value)) {
      return undefined;
    }

    if (byte < 0x80) {
      const size = index - offset + 1;

      if (size > 1 && value < 2 ** (7 * (size - 1))) {
        return undefined;
      }

      return {
        next: index + 1,
        value,
      };
    }

    shift += 7;

    if (shift > 49) {
      return undefined;
    }
  }

  return undefined;
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

  if (host === undefined || !isDidWebHost(host)) {
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

function isDidWebHost(value: string): boolean {
  if (
    value.length < 3 ||
    value.length > 253 ||
    value !== value.toLowerCase() ||
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
      !DID_WEB_HOST_LABEL_PATTERN.test(label)
    ) {
      return false;
    }
  }

  const topLevelLabel = labels[labels.length - 1];

  return topLevelLabel !== undefined && topLevelLabel.length >= 2 && !/^\d+$/u.test(topLevelLabel);
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

function addError(errors: PdsModelValidationError[], path: Path, message: string): void {
  errors.push({
    message,
    path: formatPath(path),
  });
}

function reject(errors: readonly PdsModelValidationError[]): ValidationFailure {
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
