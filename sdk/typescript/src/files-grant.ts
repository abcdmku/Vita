import type { Role } from "./roles.ts";

export type FilesGrantAccess = "read-only" | "read-write";

// FilesRole is the closed six-role household set (spec §11), re-exported from the
// single role source (roles.ts) so the literals are never duplicated here. A
// role ABSENT from a shared grant's roles map has NO access (the least-privilege
// default); denial is represented by omission, not by a third access value.
export type FilesRole = Role;
export type { Role };

export type FilesRoleAccess = FilesGrantAccess;

// A shared grant's roles map is PARTIAL over the six roles: a role may be listed
// (read-only / read-write) or simply ABSENT (no access at all, the
// least-privilege default). At least one role must be present (an empty map is
// rejected by agentd), but no specific role is required and there is NO implicit
// hierarchy - each listed role's access is exactly its entry.
export type FilesGrantRoles = Readonly<Partial<Record<FilesRole, FilesRoleAccess>>>;

export interface FilesFlatGrant {
  readonly name: string;
  readonly root: string;
  readonly access: FilesGrantAccess;
  readonly shared?: never;
  readonly roles?: never;
}

export interface FilesSharedGrant {
  readonly name: string;
  readonly root: string;
  readonly access?: never;
  readonly shared?: true;
  readonly roles: FilesGrantRoles;
}

export type FilesGrant = FilesFlatGrant | FilesSharedGrant;

export type FilesOperation = "list" | "read" | "write" | "stat";

export interface FilesRequest {
  readonly op: FilesOperation;
  readonly grant: string;
  readonly path: string;
  readonly data?: string;
}

export type FilesEntryKind = "file" | "dir" | "symlink-skipped";

export interface FilesEntry {
  readonly name: string;
  readonly kind: FilesEntryKind;
  readonly size: number;
  readonly mtime: string;
}

export interface FilesResponse {
  readonly entries?: readonly FilesEntry[];
  readonly data?: string;
  readonly kind?: FilesEntryKind;
  readonly size?: number;
  readonly mtime?: string;
}

export interface FilesErrorResponse {
  readonly error: {
    readonly code: string;
    readonly message: string;
  };
}

const FILES_RESPONSE_FIELDS = Object.freeze(["entries", "data", "kind", "size", "mtime"]);
const FILES_LIST_FIELDS = Object.freeze(["entries"]);
const FILES_READ_FIELDS = Object.freeze(["data", "size", "mtime"]);
const FILES_WRITE_FIELDS = Object.freeze(["kind", "size"]);
const FILES_STAT_FIELDS = Object.freeze(["kind", "size", "mtime"]);

export function isFilesResponse(value: unknown): value is FilesResponse {
  const response = snapshotDataObject(value);

  if (response === undefined || !hasOnlyKnownFields(response, FILES_RESPONSE_FIELDS)) return false;

  if (Object.hasOwn(response, "entries")) {
    return hasExactlyFields(response, FILES_LIST_FIELDS) && isFilesEntryArray(response["entries"]);
  }

  if (Object.hasOwn(response, "data")) {
    return (
      hasExactlyFields(response, FILES_READ_FIELDS) &&
      typeof response["data"] === "string" &&
      isFileSize(response["size"]) &&
      typeof response["mtime"] === "string"
    );
  }

  if (Object.hasOwn(response, "kind")) {
    const kind = response["kind"];

    if (!isFilesEntryKind(kind) || !isFileSize(response["size"])) return false;
    if (Object.hasOwn(response, "mtime")) {
      return hasExactlyFields(response, FILES_STAT_FIELDS) && typeof response["mtime"] === "string";
    }

    return hasExactlyFields(response, FILES_WRITE_FIELDS) && kind === "file";
  }

  return false;
}

function isFilesEntryArray(value: unknown): value is readonly FilesEntry[] {
  const entries = snapshotDenseArray(value);

  if (entries === undefined) return false;

  for (let index = 0; index < entries.length; index += 1) {
    if (!isFilesEntry(entries[index])) return false;
  }

  return true;
}

function isFilesEntry(value: unknown): value is FilesEntry {
  const entry = snapshotDataObject(value);

  return entry !== undefined &&
    hasExactlyFields(entry, Object.freeze(["name", "kind", "size", "mtime"])) &&
    typeof entry["name"] === "string" &&
    isFilesEntryKind(entry["kind"]) &&
    isFileSize(entry["size"]) &&
    typeof entry["mtime"] === "string";
}

function isFilesEntryKind(value: unknown): value is FilesEntryKind {
  return value === "file" || value === "dir" || value === "symlink-skipped";
}

function isFileSize(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
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
