import { hasDesktopCapabilityGrant } from "../index.ts";
import { isFilesResponse } from "../../files-grant.ts";
import type {
  DesktopCapability,
  DesktopMaybePromise,
  DesktopUiPackageManifest,
  FilesEntry,
  FilesErrorResponse,
  FilesRequest,
  FilesResponse,
} from "../index.ts";

export const FILES_MAX_FILE_BYTES = 8 * 1024 * 1024;

export type RequestFilePort = (request: FilesRequest) => DesktopMaybePromise<FilesResponse | FilesErrorResponse>;

export interface AgentdFilesTransport {
  request(request: FilesRequest): DesktopMaybePromise<unknown>;
}

export type AgentdFilesTransportLike =
  | AgentdFilesTransport
  | ((request: FilesRequest) => DesktopMaybePromise<unknown>);

export interface RequestFilePortOptions {
  readonly package: Pick<DesktopUiPackageManifest, "capabilityGrants">;
  readonly transport: AgentdFilesTransportLike;
}

type NormalizeResult<T> =
  | {
      readonly ok: true;
      readonly value: T;
    }
  | {
      readonly ok: false;
      readonly error: FilesErrorResponse;
    };

const FILES_RESPONSE_FIELDS = Object.freeze(["entries", "data", "kind", "size", "mtime"]);
const FILES_ENTRY_FIELDS = Object.freeze(["name", "kind", "size", "mtime"]);
const FILES_REQUEST_FIELDS = Object.freeze(["op", "grant", "path", "data"]);

export function createRequestFilePort(options: RequestFilePortOptions): RequestFilePort {
  const responder = resolveResponder(options.transport);
  const hostPackage = options.package;

  return async (input) => {
    const request = normalizeFilesRequest(input);

    if (!request.ok) return request.error;

    const grants = enforceFilesGrants(hostPackage, request.value);

    if (!grants.ok) return grants.error;

    const writable = enforceWriteLimit(request.value);

    if (!writable.ok) return writable.error;

    let rawResponse: unknown;

    try {
      rawResponse = await responder(request.value);
    } catch (error) {
      return requestErrorResponse(error, "files_unavailable", "files responder failed closed.");
    }

    return normalizeAgentdFilesResponse(rawResponse, request.value.op);
  };
}

function resolveResponder(transport: AgentdFilesTransportLike): (request: FilesRequest) => DesktopMaybePromise<unknown> {
  if (typeof transport === "function") return transport;

  return (request) => transport.request(request);
}

function normalizeFilesRequest(input: unknown): NormalizeResult<FilesRequest> {
  const request = snapshotDataObject(input);

  if (request === undefined || !hasOnlyKnownFields(request, FILES_REQUEST_FIELDS)) {
    return reject("invalid_request", "files request must be a plain object.");
  }

  const op = request["op"];
  const grant = request["grant"];
  const requestPath = request["path"];
  const data = request["data"];

  if (!isFilesOperation(op)) return reject("unknown_op", "unknown files op");
  if (typeof grant !== "string" || grant.length === 0) {
    return reject("invalid_request", "grant is required");
  }
  if (typeof requestPath !== "string" || requestPath.length === 0) {
    return reject("path_traversal", "path is outside the grant scope");
  }
  if (op === "write") {
    if (typeof data !== "string") return reject("invalid_request", "data is required for write");

    return accept(Object.freeze({
      data,
      grant,
      op,
      path: requestPath,
    }));
  }
  if (Object.hasOwn(request, "data")) {
    return reject("invalid_request", "data is only allowed for write");
  }

  return accept(Object.freeze({
    grant,
    op,
    path: requestPath,
  }));
}

function enforceFilesGrants(
  hostPackage: Pick<DesktopUiPackageManifest, "capabilityGrants">,
  request: FilesRequest,
): NormalizeResult<true> {
  if (request.op === "write") {
    if (
      !hasPackageCapability(hostPackage, "files.read", request.grant) ||
      !hasPackageCapability(hostPackage, "files.write", request.grant)
    ) {
      return reject("MISSING_CAPABILITY", "package must hold files.read and files.write for this file grant.");
    }

    return accept(true);
  }

  if (!hasPackageCapability(hostPackage, "files.read", request.grant)) {
    return reject("MISSING_CAPABILITY", "package cannot read this file grant.");
  }

  return accept(true);
}

function hasPackageCapability(
  hostPackage: Pick<DesktopUiPackageManifest, "capabilityGrants">,
  capability: DesktopCapability,
  grant: string,
): boolean {
  try {
    const manifest = Object.freeze({
      capabilityGrants: hostPackage.capabilityGrants,
      entry: "",
      id: "",
      sdkVersion: "",
      version: "",
    }) satisfies DesktopUiPackageManifest;

    return hasDesktopCapabilityGrant(manifest, capability, grant);
  } catch {
    return false;
  }
}

function enforceWriteLimit(request: FilesRequest): NormalizeResult<true> {
  if (request.op !== "write") return accept(true);

  const decodedLength = strictBase64DecodedLength(request.data);

  if (!decodedLength.ok) return reject("invalid_data", "write data must be base64");
  if (decodedLength.value > FILES_MAX_FILE_BYTES) {
    return reject("file_too_large", "file exceeds files size cap");
  }

  return accept(true);
}

function normalizeAgentdFilesResponse(rawResponse: unknown, op: FilesRequest["op"]): FilesResponse | FilesErrorResponse {
  const errorResponse = filesErrorFromResponse(rawResponse);

  if (errorResponse !== undefined) return errorResponse;

  const response = snapshotDataObject(rawResponse);

  if (response === undefined || !hasOnlyKnownFields(response, FILES_RESPONSE_FIELDS)) {
    return rejectResponse("malformed_response", "files responder returned malformed response.");
  }

  switch (op) {
    case "list":
      return normalizeListResponse(response);
    case "read":
      return normalizeReadResponse(response);
    case "write":
      return normalizeWriteResponse(response);
    case "stat":
      return normalizeStatResponse(response);
  }
}

function normalizeListResponse(response: Readonly<Record<string, unknown>>): FilesResponse | FilesErrorResponse {
  if (!hasExactlyFields(response, Object.freeze(["entries"]))) {
    return rejectResponse("malformed_response", "files list response is malformed.");
  }

  const entries = normalizeEntries(response["entries"]);

  if (!entries.ok) return entries.error;

  const output = Object.freeze({
    entries: entries.value,
  }) satisfies FilesResponse;

  return isFilesResponse(output) ? output : rejectResponse("malformed_response", "files list response is malformed.");
}

function normalizeReadResponse(response: Readonly<Record<string, unknown>>): FilesResponse | FilesErrorResponse {
  if (!hasExactlyFields(response, Object.freeze(["data", "size", "mtime"]))) {
    return rejectResponse("malformed_response", "files read response is malformed.");
  }

  const data = response["data"];
  const size = response["size"];
  const mtime = response["mtime"];

  if (typeof data !== "string" || !isFileSize(size) || typeof mtime !== "string") {
    return rejectResponse("malformed_response", "files read response is malformed.");
  }
  if (size > FILES_MAX_FILE_BYTES) {
    return rejectResponse("file_too_large", "file exceeds files size cap");
  }

  const decodedLength = strictBase64DecodedLength(data);

  if (!decodedLength.ok || decodedLength.value !== size) {
    return rejectResponse("malformed_response", "files read response is malformed.");
  }
  if (decodedLength.value > FILES_MAX_FILE_BYTES) {
    return rejectResponse("file_too_large", "file exceeds files size cap");
  }

  const output = Object.freeze({
    data,
    mtime,
    size,
  }) satisfies FilesResponse;

  return isFilesResponse(output) ? output : rejectResponse("malformed_response", "files read response is malformed.");
}

function normalizeWriteResponse(response: Readonly<Record<string, unknown>>): FilesResponse | FilesErrorResponse {
  if (!hasExactlyFields(response, Object.freeze(["kind", "size"]))) {
    return rejectResponse("malformed_response", "files write response is malformed.");
  }

  const kind = response["kind"];
  const size = response["size"];

  if (kind !== "file" || !isFileSize(size) || size > FILES_MAX_FILE_BYTES) {
    return rejectResponse("malformed_response", "files write response is malformed.");
  }

  const output = Object.freeze({
    kind,
    size,
  }) satisfies FilesResponse;

  return isFilesResponse(output) ? output : rejectResponse("malformed_response", "files write response is malformed.");
}

function normalizeStatResponse(response: Readonly<Record<string, unknown>>): FilesResponse | FilesErrorResponse {
  if (!hasExactlyFields(response, Object.freeze(["kind", "size", "mtime"]))) {
    return rejectResponse("malformed_response", "files stat response is malformed.");
  }

  const kind = response["kind"];
  const size = response["size"];
  const mtime = response["mtime"];

  if (!isFilesEntryKind(kind) || !isFileSize(size) || typeof mtime !== "string") {
    return rejectResponse("malformed_response", "files stat response is malformed.");
  }

  const output = Object.freeze({
    kind,
    mtime,
    size,
  }) satisfies FilesResponse;

  return isFilesResponse(output) ? output : rejectResponse("malformed_response", "files stat response is malformed.");
}

function normalizeEntries(value: unknown): NormalizeResult<readonly FilesEntry[]> {
  const entries = snapshotDenseArray(value);

  if (entries === undefined) return reject("malformed_response", "files list response is malformed.");

  const output: FilesEntry[] = [];

  for (let index = 0; index < entries.length; index += 1) {
    const entry = normalizeEntry(entries[index]);

    if (!entry.ok) return entry;
    output.push(entry.value);
  }

  return accept(Object.freeze(output));
}

function normalizeEntry(value: unknown): NormalizeResult<FilesEntry> {
  const entry = snapshotDataObject(value);

  if (entry === undefined || !hasExactlyFields(entry, FILES_ENTRY_FIELDS)) {
    return reject("malformed_response", "files entry is malformed.");
  }

  const name = entry["name"];
  const kind = entry["kind"];
  const size = entry["size"];
  const mtime = entry["mtime"];

  if (typeof name !== "string" || !isFilesEntryKind(kind) || !isFileSize(size) || typeof mtime !== "string") {
    return reject("malformed_response", "files entry is malformed.");
  }

  return accept(Object.freeze({
    kind,
    mtime,
    name,
    size,
  }));
}

function filesErrorFromResponse(value: unknown): FilesErrorResponse | undefined {
  const response = snapshotDataObject(value);

  if (response === undefined || !Object.hasOwn(response, "error")) return undefined;

  const errorValue = requestErrorParts(response["error"]);

  if (errorValue === undefined) {
    return rejectResponse("malformed_response", "files responder returned malformed error.");
  }

  return filesError(errorValue.code, errorValue.message);
}

function requestErrorResponse(error: unknown, fallbackCode: string, fallbackMessage: string): FilesErrorResponse {
  const requestError = requestErrorParts(error);

  if (requestError !== undefined) return filesError(requestError.code, requestError.message);

  return filesError(fallbackCode, fallbackMessage);
}

function requestErrorParts(value: unknown): { readonly code: string; readonly message: string } | undefined {
  const errorValue = snapshotDataObject(value);

  if (errorValue === undefined) return undefined;

  const code = stringField(errorValue, "code") ?? stringField(errorValue, "Code");
  const message = stringField(errorValue, "message") ?? stringField(errorValue, "Message");

  if (code === undefined || code.length === 0 || message === undefined || message.length === 0) return undefined;

  return Object.freeze({ code, message });
}

function strictBase64DecodedLength(value: string | undefined): NormalizeResult<number> {
  if (value === undefined || value.length % 4 !== 0) {
    return reject("invalid_data", "write data must be base64");
  }

  let padding = 0;

  if (value.length > 0 && value[value.length - 1] === "=") padding += 1;
  if (value.length > 1 && value[value.length - 2] === "=") padding += 1;

  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];

    if (char === undefined) return reject("invalid_data", "write data must be base64");
    if (char === "=") {
      if (index < value.length - padding) {
        return reject("invalid_data", "write data must be base64");
      }
      continue;
    }
    if (base64Value(char) < 0) {
      return reject("invalid_data", "write data must be base64");
    }
  }

  if (padding === 1) {
    const final = value[value.length - 2];

    if (final === undefined || (base64Value(final) & 0b00000011) !== 0) {
      return reject("invalid_data", "write data must be base64");
    }
  } else if (padding === 2) {
    const final = value[value.length - 3];

    if (final === undefined || (base64Value(final) & 0b00001111) !== 0) {
      return reject("invalid_data", "write data must be base64");
    }
  }

  return accept((value.length / 4) * 3 - padding);
}

function base64Value(char: string): number {
  const code = char.charCodeAt(0);

  if (code >= 65 && code <= 90) return code - 65;
  if (code >= 97 && code <= 122) return code - 71;
  if (code >= 48 && code <= 57) return code + 4;
  if (char === "+") return 62;
  if (char === "/") return 63;

  return -1;
}

function isFilesOperation(value: unknown): value is FilesRequest["op"] {
  return value === "list" || value === "read" || value === "write" || value === "stat";
}

function isFilesEntryKind(value: unknown): value is FilesEntry["kind"] {
  return value === "file" || value === "dir" || value === "symlink-skipped";
}

function isFileSize(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function snapshotDataObject(value: unknown): Readonly<Record<string, unknown>> | undefined {
  if (value === undefined || value === null || typeof value !== "object" || Array.isArray(value)) return undefined;

  try {
    const prototype = Object.getPrototypeOf(value);

    if (prototype !== Object.prototype && prototype !== null) return undefined;

    const output: Record<string, unknown> = {};
    const keys = Reflect.ownKeys(value);

    for (let index = 0; index < keys.length; index += 1) {
      const key = keys[index];

      if (key === undefined || typeof key === "symbol") return undefined;

      const descriptor = Object.getOwnPropertyDescriptor(value, key);

      if (descriptor === undefined || !isDataDescriptor(descriptor) || descriptor.enumerable !== true) {
        return undefined;
      }

      Object.defineProperty(output, key, {
        configurable: false,
        enumerable: true,
        value: descriptor.value,
        writable: false,
      });
    }

    return Object.freeze(output);
  } catch {
    return undefined;
  }
}

function snapshotDenseArray(value: unknown): readonly unknown[] | undefined {
  if (!Array.isArray(value)) return undefined;

  try {
    if (Object.getPrototypeOf(value) !== Array.prototype) return undefined;

    const lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");

    if (lengthDescriptor === undefined || !isDataDescriptor(lengthDescriptor)) return undefined;
    if (!Number.isSafeInteger(lengthDescriptor.value) || lengthDescriptor.value < 0) return undefined;

    const length = lengthDescriptor.value;
    const keys = Reflect.ownKeys(value);

    for (let index = 0; index < keys.length; index += 1) {
      const key = keys[index];

      if (key === "length") continue;
      if (key === undefined || typeof key === "symbol" || !isDenseArrayIndexKey(key, length)) {
        return undefined;
      }

      const descriptor = Object.getOwnPropertyDescriptor(value, key);

      if (descriptor === undefined || !isDataDescriptor(descriptor) || descriptor.enumerable !== true) {
        return undefined;
      }
    }

    const output: unknown[] = [];

    for (let index = 0; index < length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, `${index}`);

      if (descriptor === undefined || !isDataDescriptor(descriptor) || descriptor.enumerable !== true) {
        return undefined;
      }

      output.push(descriptor.value);
    }

    return Object.freeze(output);
  } catch {
    return undefined;
  }
}

function hasOnlyKnownFields(
  value: Readonly<Record<string, unknown>>,
  allowed: readonly string[],
): boolean {
  const keys = Object.keys(value);

  for (let index = 0; index < keys.length; index += 1) {
    const key = keys[index];

    if (key === undefined || !contains(allowed, key)) return false;
  }

  return true;
}

function hasExactlyFields(
  value: Readonly<Record<string, unknown>>,
  expected: readonly string[],
): boolean {
  const keys = Object.keys(value);

  if (keys.length !== expected.length) return false;

  for (let index = 0; index < expected.length; index += 1) {
    const key = expected[index];

    if (key === undefined || !Object.hasOwn(value, key)) return false;
  }

  return true;
}

function stringField(value: Readonly<Record<string, unknown>>, key: string): string | undefined {
  const field = value[key];

  return typeof field === "string" ? field : undefined;
}

function isDenseArrayIndexKey(key: string, length: number): boolean {
  if (key.length === 0) return false;

  const numeric = Number(key);

  return Number.isSafeInteger(numeric) && numeric >= 0 && numeric < length && String(numeric) === key;
}

function isDataDescriptor(descriptor: PropertyDescriptor): descriptor is PropertyDescriptor & {
  readonly value: unknown;
} {
  return Object.prototype.hasOwnProperty.call(descriptor, "value");
}

function contains(values: readonly string[], value: string): boolean {
  for (let index = 0; index < values.length; index += 1) {
    if (values[index] === value) return true;
  }

  return false;
}

function accept<T>(value: T): NormalizeResult<T> {
  return Object.freeze({
    ok: true,
    value,
  });
}

function reject<T>(code: string, message: string): NormalizeResult<T> {
  return Object.freeze({
    error: filesError(code, message),
    ok: false,
  });
}

function rejectResponse(code: string, message: string): FilesErrorResponse {
  return filesError(code, message);
}

function filesError(code: string, message: string): FilesErrorResponse {
  return Object.freeze({
    error: Object.freeze({
      code,
      message,
    }),
  });
}
