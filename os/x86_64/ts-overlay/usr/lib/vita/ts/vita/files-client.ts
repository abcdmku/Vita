import { safeNormalize } from "./safe-normalize.ts";
import type { AgentTransport } from "./agent-client.ts";
import type {
  PlainJson,
  PlainJsonObject,
} from "./safe-normalize.ts";
import type {
  FilesEntry,
  FilesEntryKind,
  FilesOperation,
  FilesRequest,
  FilesResponse,
} from "../../../../../../../../sdk/typescript/src/files-grant.ts";

export interface FilesClientOptions {
  readonly transport: AgentTransport;
  readonly baseUrl?: string | URL;
}

export interface FilesClient {
  write(grant: string, path: string, data: Uint8Array): Promise<FilesWriteResult>;
  read(grant: string, path: string): Promise<FilesReadResult>;
  list(grant: string, path: string): Promise<readonly FilesEntry[]>;
  stat(grant: string, path: string): Promise<FilesStatResult>;
}

export interface FilesWriteResult {
  readonly size: number;
}

export interface FilesReadResult {
  readonly data: Uint8Array;
  readonly size: number;
  readonly mtime: string;
}

export interface FilesStatResult {
  readonly kind: FilesEntryKind;
  readonly size: number;
  readonly mtime: string;
}

export class FilesClientError extends Error {
  readonly reason: string;
  readonly status?: number;

  constructor(reason: string, message: string, status?: number) {
    super(message);
    this.name = "FilesClientError";
    this.reason = reason;
    if (status !== undefined) {
      this.status = status;
    }
  }
}

type ValidationResult<T> =
  | {
      readonly ok: true;
      readonly value: T;
    }
  | {
      readonly ok: false;
      readonly reason: string;
    };

const DEFAULT_AGENTD_BASE_URL = "http://agentd";
const JSON_POST_HEADERS = Object.freeze({
  Accept: "application/json",
  "Content-Type": "application/json",
});
const FILES_RESPONSE_OPTIONAL_FIELDS = Object.freeze(["entries", "data", "kind", "size", "mtime"]);
const FILES_ENTRY_FIELDS = Object.freeze(["name", "kind", "size", "mtime"]);
const ERROR_RESPONSE_FIELDS = Object.freeze(["error"]);
const ERROR_DETAIL_FIELDS = Object.freeze(["code", "message"]);
const FILES_ENTRY_KINDS = ["file", "dir", "symlink-skipped"] as const;
const BASE64_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const BASE64_LOOKUP = buildBase64Lookup();

export function createFilesClient(options: FilesClientOptions): FilesClient {
  return new AgentdFilesClient(options);
}

export function isFilesClientError(error: unknown): error is FilesClientError {
  return error instanceof FilesClientError;
}

class AgentdFilesClient implements FilesClient {
  readonly #transport: AgentTransport;
  readonly #baseUrl: URL;

  constructor(options: FilesClientOptions) {
    this.#transport = options.transport;
    this.#baseUrl = new URL(options.baseUrl ?? DEFAULT_AGENTD_BASE_URL);
  }

  async write(grant: string, path: string, data: Uint8Array): Promise<FilesWriteResult> {
    const response = await this.#request({
      data: encodeBase64(data),
      grant,
      op: "write",
      path,
    });
    const result = validateWriteResponse(response);
    if (!result.ok) {
      throw new FilesClientError("malformed_response", result.reason);
    }
    return result.value;
  }

  async read(grant: string, path: string): Promise<FilesReadResult> {
    const response = await this.#request({ grant, op: "read", path });
    const result = validateReadResponse(response);
    if (!result.ok) {
      throw new FilesClientError("malformed_response", result.reason);
    }
    return result.value;
  }

  async list(grant: string, path: string): Promise<readonly FilesEntry[]> {
    const response = await this.#request({ grant, op: "list", path });
    const result = validateListResponse(response);
    if (!result.ok) {
      throw new FilesClientError("malformed_response", result.reason);
    }
    return result.value;
  }

  async stat(grant: string, path: string): Promise<FilesStatResult> {
    const response = await this.#request({ grant, op: "stat", path });
    const result = validateStatResponse(response);
    if (!result.ok) {
      throw new FilesClientError("malformed_response", result.reason);
    }
    return result.value;
  }

  async #request(request: FilesRequest): Promise<PlainJsonObject> {
    let response;
    try {
      response = await this.#transport(new URL("/files", this.#baseUrl).toString(), {
        body: JSON.stringify(request),
        headers: JSON_POST_HEADERS,
        method: "POST",
      });
    } catch {
      throw new FilesClientError("transport_error", "Files transport request failed.");
    }

    const text = await response.text();
    if (!response.ok) {
      throwFilesError(response.status, text);
    }

    return readResponseObject(response.status, text);
  }
}

function readResponseObject(status: number, text: string): PlainJsonObject {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new FilesClientError("malformed_response", "Files response body is not JSON.", status);
  }

  const normalized = safeNormalize(parsed);
  if (!normalized.ok || !isPlainObject(normalized.value)) {
    throw new FilesClientError("malformed_response", "Files response body is malformed.", status);
  }
  return normalized.value;
}

function throwFilesError(status: number, text: string): never {
  const payload = readResponseObject(status, text);
  const result = validateErrorResponse(payload);
  if (!result.ok) {
    throw new FilesClientError("malformed_error", "Files error response is malformed.", status);
  }
  throw new FilesClientError(result.value.code, result.value.message, status);
}

function validateWriteResponse(payload: PlainJsonObject): ValidationResult<FilesWriteResult> {
  const fields = expectFields(payload, [], FILES_RESPONSE_OPTIONAL_FIELDS);
  if (!fields.ok) return fields;

  const size = field(payload, "size");
  if (!isNonNegativeSafeInteger(size)) {
    return reject("write response size must be a non-negative integer.");
  }
  return accept({ size });
}

function validateReadResponse(payload: PlainJsonObject): ValidationResult<FilesReadResult> {
  const fields = expectFields(payload, [], FILES_RESPONSE_OPTIONAL_FIELDS);
  if (!fields.ok) return fields;

  const data = field(payload, "data");
  const size = field(payload, "size");
  const mtime = field(payload, "mtime");
  if (typeof data !== "string") return reject("read response data must be a string.");
  if (!isNonNegativeSafeInteger(size)) {
    return reject("read response size must be a non-negative integer.");
  }
  if (typeof mtime !== "string" || mtime.length === 0) {
    return reject("read response mtime must be a string.");
  }

  const decoded = decodeBase64(data);
  if (!decoded.ok) return decoded;
  if (decoded.value.byteLength !== size) {
    return reject("read response size does not match data length.");
  }
  return accept({
    data: decoded.value,
    mtime,
    size,
  });
}

function validateListResponse(payload: PlainJsonObject): ValidationResult<readonly FilesEntry[]> {
  const fields = expectFields(payload, [], FILES_RESPONSE_OPTIONAL_FIELDS);
  if (!fields.ok) return fields;

  const entries = field(payload, "entries");
  return validateArray(entries, "entries", validateEntry);
}

function validateStatResponse(payload: PlainJsonObject): ValidationResult<FilesStatResult> {
  const fields = expectFields(payload, [], FILES_RESPONSE_OPTIONAL_FIELDS);
  if (!fields.ok) return fields;

  const kind = field(payload, "kind");
  const size = field(payload, "size");
  const mtime = field(payload, "mtime");
  if (!isStringMember(kind, FILES_ENTRY_KINDS)) {
    return reject("stat response kind must be a known files kind.");
  }
  if (!isNonNegativeSafeInteger(size)) {
    return reject("stat response size must be a non-negative integer.");
  }
  if (typeof mtime !== "string" || mtime.length === 0) {
    return reject("stat response mtime must be a string.");
  }
  return accept({ kind, mtime, size });
}

function validateEntry(value: PlainJson | undefined, path: string): ValidationResult<FilesEntry> {
  if (!isPlainObject(value)) return reject(`${path} must be an object.`);

  const fields = expectFields(value, FILES_ENTRY_FIELDS, [], path);
  if (!fields.ok) return fields;

  const name = field(value, "name");
  const kind = field(value, "kind");
  const size = field(value, "size");
  const mtime = field(value, "mtime");

  if (typeof name !== "string" || name.length === 0) {
    return reject(`${path}.name must be a non-empty string.`);
  }
  if (!isStringMember(kind, FILES_ENTRY_KINDS)) {
    return reject(`${path}.kind must be a known files kind.`);
  }
  if (!isNonNegativeSafeInteger(size)) {
    return reject(`${path}.size must be a non-negative integer.`);
  }
  if (typeof mtime !== "string" || mtime.length === 0) {
    return reject(`${path}.mtime must be a non-empty string.`);
  }
  return accept({ kind, mtime, name, size });
}

function validateErrorResponse(payload: PlainJsonObject): ValidationResult<{ readonly code: string; readonly message: string }> {
  const fields = expectFields(payload, ERROR_RESPONSE_FIELDS);
  if (!fields.ok) return fields;

  const error = field(payload, "error");
  if (!isPlainObject(error)) return reject("error must be an object.");

  const detailFields = expectFields(error, ERROR_DETAIL_FIELDS, [], "error");
  if (!detailFields.ok) return detailFields;

  const code = field(error, "code");
  const message = field(error, "message");
  if (typeof code !== "string" || code.length === 0) {
    return reject("error.code must be a non-empty string.");
  }
  if (typeof message !== "string") {
    return reject("error.message must be a string.");
  }
  return accept({ code, message });
}

function validateArray<T>(
  value: PlainJson | undefined,
  path: string,
  validate: (item: PlainJson | undefined, itemPath: string) => ValidationResult<T>,
): ValidationResult<readonly T[]> {
  if (!Array.isArray(value)) return reject(`${path} must be an array.`);

  const output: T[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const item = value[index];
    if (item === undefined) {
      return reject(`${path}[${index}] is missing.`);
    }
    const result = validate(item, `${path}[${index}]`);
    if (!result.ok) return result;
    output[index] = result.value;
  }
  return accept(Object.freeze(output));
}

function expectFields(
  value: PlainJsonObject,
  required: readonly string[],
  optional: readonly string[] = [],
  path = "",
): ValidationResult<true> {
  const keys = Object.keys(value);
  for (let index = 0; index < keys.length; index += 1) {
    const key = keys[index];
    if (key === undefined || (!contains(required, key) && !contains(optional, key))) {
      return reject(`${prefix(path)}${key ?? "field"} is not an expected field.`);
    }
  }
  for (let index = 0; index < required.length; index += 1) {
    const key = required[index];
    if (key === undefined || !Object.hasOwn(value, key)) {
      return reject(`${prefix(path)}${key ?? "field"} is required.`);
    }
  }
  return accept(true);
}

function encodeBase64(data: Uint8Array): string {
  let output = "";
  for (let index = 0; index < data.byteLength; index += 3) {
    const first = data[index] ?? 0;
    const second = data[index + 1] ?? 0;
    const third = data[index + 2] ?? 0;
    const hasSecond = index + 1 < data.byteLength;
    const hasThird = index + 2 < data.byteLength;

    output += BASE64_ALPHABET[first >> 2] ?? "";
    output += BASE64_ALPHABET[((first & 0x03) << 4) | (second >> 4)] ?? "";
    output += hasSecond ? (BASE64_ALPHABET[((second & 0x0f) << 2) | (third >> 6)] ?? "") : "=";
    output += hasThird ? (BASE64_ALPHABET[third & 0x3f] ?? "") : "=";
  }
  return output;
}

function decodeBase64(value: string): ValidationResult<Uint8Array> {
  if (value.length % 4 !== 0) {
    return reject("base64 data length must be a multiple of 4.");
  }

  let padding = 0;
  if (value.endsWith("==")) {
    padding = 2;
  } else if (value.endsWith("=")) {
    padding = 1;
  }
  const output = new Uint8Array((value.length / 4) * 3 - padding);
  let offset = 0;

  for (let index = 0; index < value.length; index += 4) {
    const a = base64Value(value[index]);
    const b = base64Value(value[index + 1]);
    const c = value[index + 2] === "=" ? 0 : base64Value(value[index + 2]);
    const d = value[index + 3] === "=" ? 0 : base64Value(value[index + 3]);
    if (a < 0 || b < 0 || c < 0 || d < 0) {
      return reject("base64 data contains invalid characters.");
    }
    if ((value[index + 2] === "=" || value[index + 3] === "=") && index + 4 !== value.length) {
      return reject("base64 padding is only allowed at the end.");
    }

    if (offset < output.byteLength) output[offset] = (a << 2) | (b >> 4);
    offset += 1;
    if (offset < output.byteLength) output[offset] = ((b & 0x0f) << 4) | (c >> 2);
    offset += 1;
    if (offset < output.byteLength) output[offset] = ((c & 0x03) << 6) | d;
    offset += 1;
  }
  return accept(output);
}

function buildBase64Lookup(): Readonly<Record<string, number>> {
  const lookup: Record<string, number> = {};
  for (let index = 0; index < BASE64_ALPHABET.length; index += 1) {
    const char = BASE64_ALPHABET[index];
    if (char !== undefined) {
      lookup[char] = index;
    }
  }
  return Object.freeze(lookup);
}

function base64Value(value: string | undefined): number {
  if (value === undefined) return -1;
  return BASE64_LOOKUP[value] ?? -1;
}

function field(value: PlainJsonObject, key: string): PlainJson | undefined {
  if (!Object.hasOwn(value, key)) return undefined;
  return value[key];
}

function prefix(path: string): string {
  return path === "" ? "" : `${path}.`;
}

function isPlainObject(value: PlainJson | undefined): value is PlainJsonObject {
  return value !== undefined && value !== null && typeof value === "object" && !Array.isArray(value);
}

function isNonNegativeSafeInteger(value: PlainJson | undefined): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isStringMember<T extends string>(
  value: PlainJson | undefined,
  members: readonly T[],
): value is T {
  if (typeof value !== "string") return false;
  return contains(members, value);
}

function contains<T extends string>(values: readonly T[], value: string): value is T {
  for (let index = 0; index < values.length; index += 1) {
    if (values[index] === value) return true;
  }
  return false;
}

function accept<T>(value: T): ValidationResult<T> {
  return {
    ok: true,
    value,
  };
}

function reject<T>(reason: string): ValidationResult<T> {
  return {
    ok: false,
    reason,
  };
}

export type { FilesEntry, FilesOperation, FilesRequest, FilesResponse };
