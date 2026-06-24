import { safeNormalize } from "./safe-normalize.ts";
import type { PlainJson, PlainJsonObject } from "./safe-normalize.ts";

export const EXPORT_BUNDLE_FORMAT_VERSION = 1;
export const EXPORT_MANIFEST_PATH = "export-manifest.json";
export const EXPORT_CONFIG_PATH = "state.json";
export const EXPORT_PDS_PATH = "pds-sync-state.json";
export const EXPORT_FILES_PREFIX = "";

export type ExportEntryKind = "file" | "config" | "pds";
export type ExportBundleRejectReason =
  | "duplicate_path"
  | "inline_secret_metadata"
  | "integrity_mismatch"
  | "invalid_manifest"
  | "invalid_metadata"
  | "invalid_input"
  | "path_traversal"
  | "size_limit";

export interface ExportBundleEntry {
  readonly path: string;
  readonly kind: ExportEntryKind;
  readonly bytes: number;
  readonly integrity: `sha256-${string}`;
}

export interface ExportManifest {
  readonly formatVersion: typeof EXPORT_BUNDLE_FORMAT_VERSION;
  readonly createdMarker?: string;
  readonly entries: readonly ExportBundleEntry[];
  readonly rootDigest: `sha256-${string}`;
}

export interface ExportSourceFile {
  readonly relPath: string;
  readonly data: Uint8Array;
}

export interface BuildExportBundleInput {
  readonly files?: readonly ExportSourceFile[];
  readonly stateSnapshot?: unknown;
  readonly pdsSyncState?: unknown;
  readonly createdMarker?: string;
}

export interface ExportBundleBlob {
  readonly path: string;
  readonly kind: ExportEntryKind;
  readonly data: Uint8Array;
}

export type BuildExportBundleResult =
  | {
      readonly ok: true;
      readonly manifest: ExportManifest;
      readonly manifestBytes: Uint8Array;
      readonly blobs: readonly ExportBundleBlob[];
      readonly totalBytes: number;
    }
  | {
      readonly ok: false;
      readonly reason: ExportBundleRejectReason;
    };

export type VerifyExportBundleResult =
  | {
      readonly ok: true;
      readonly entries: number;
      readonly totalBytes: number;
      readonly rootDigest: `sha256-${string}`;
    }
  | {
      readonly ok: false;
      readonly reason: ExportBundleRejectReason;
    };

type EntryContent = ExportBundleBlob & {
  readonly data: Uint8Array;
};

const MAX_ENTRY_BYTES = 8 * 1024 * 1024;
const MAX_TOTAL_BYTES = 64 * 1024 * 1024;
const MAX_ENTRIES = 8192;
const TEXT_ENCODER = new TextEncoder();
const TEXT_DECODER = new TextDecoder();

const ENTRY_KINDS = Object.freeze(["config", "file", "pds"] as const);
const MANIFEST_FIELDS = Object.freeze(["createdMarker", "entries", "formatVersion", "rootDigest"]);
const ENTRY_FIELDS = Object.freeze(["bytes", "integrity", "kind", "path"]);

const PRIVATE_KEY_PATTERN =
  /\b(?:private[-_\s]?key|openssh\s+private\s+key|age-secret-key|xprv|seed[-_\s]?phrase|mnemonic|recovery[-_\s]?phrase)\b/i;
const SECRET_ASSIGNMENT_PATTERN =
  /\b(?:private[-_\s]?key|api[-_\s]?key|access[-_\s]?token|refresh[-_\s]?token|password|secret)\s*[:=]/i;
const SEED_WORDS_PATTERN = /\b[a-z]{3,12}(?:\s+[a-z]{3,12}){11,23}\b/i;
const LONG_HEX_PATTERN = /(?:0x)?[A-Fa-f0-9]{32,}/;
const LONG_BASE64_PATTERN = /[A-Za-z0-9+/]{48,}={0,2}|[A-Za-z0-9_-]{48,}/;

export async function buildExportBundle(input: BuildExportBundleInput): Promise<BuildExportBundleResult> {
  try {
    const contents = normalizeInput(input);
    if (!contents.ok) return contents;

    const entries: ExportBundleEntry[] = [];
    for (let index = 0; index < contents.value.length; index += 1) {
      const content = contents.value[index];
      if (content === undefined) return reject("invalid_input");
      const integrity = await sha256Integrity(content.data);
      entries[entries.length] = {
        bytes: content.data.byteLength,
        integrity,
        kind: content.kind,
        path: content.path,
      };
    }

    entries.sort(compareEntries);
    const sortedContents = [...contents.value].sort(compareContent);
    const duplicate = firstDuplicatePath(entries);
    if (duplicate !== undefined) return reject("duplicate_path");

    const rootDigest = await rootDigestForEntries(entries);
    const manifestBase: Omit<ExportManifest, "createdMarker"> = {
      entries: Object.freeze(entries),
      formatVersion: EXPORT_BUNDLE_FORMAT_VERSION,
      rootDigest,
    };
    const manifest: ExportManifest =
      input.createdMarker === undefined
        ? manifestBase
        : {
            ...manifestBase,
            createdMarker: input.createdMarker,
          };

    if (manifestHasInlineMaterial(manifest)) return reject("inline_secret_metadata");

    const totalBytes = sumBytes(sortedContents);
    if (totalBytes === undefined) return reject("size_limit");

    return {
      blobs: Object.freeze(sortedContents),
      manifest,
      manifestBytes: utf8Bytes(`${canonicalJson(manifest)}\n`),
      ok: true,
      totalBytes,
    };
  } catch {
    return reject("invalid_input");
  }
}

export async function verifyExportBundle(
  manifestBytes: Uint8Array,
  lookup: (path: string) => Promise<Uint8Array> | Uint8Array,
): Promise<VerifyExportBundleResult> {
  try {
    const parsed = await parseExportManifest(manifestBytes);
    if (!parsed.ok) return parsed;

    const computedRoot = await rootDigestForEntries(parsed.manifest.entries);
    if (computedRoot !== parsed.manifest.rootDigest) return reject("integrity_mismatch");

    let totalBytes = 0;
    for (let index = 0; index < parsed.manifest.entries.length; index += 1) {
      const entry = parsed.manifest.entries[index];
      if (entry === undefined) return reject("invalid_manifest");

      let content: Uint8Array;
      try {
        content = await lookup(entry.path);
      } catch {
        return reject("integrity_mismatch");
      }

      if (!(content instanceof Uint8Array)) return reject("integrity_mismatch");
      if (content.byteLength !== entry.bytes) return reject("integrity_mismatch");
      if ((await sha256Integrity(content)) !== entry.integrity) return reject("integrity_mismatch");

      if (totalBytes > MAX_TOTAL_BYTES - content.byteLength) return reject("size_limit");
      totalBytes += content.byteLength;
    }

    return {
      entries: parsed.manifest.entries.length,
      ok: true,
      rootDigest: parsed.manifest.rootDigest,
      totalBytes,
    };
  } catch {
    return reject("invalid_manifest");
  }
}

export async function parseExportManifest(
  manifestBytes: Uint8Array,
): Promise<
  | {
      readonly ok: true;
      readonly manifest: ExportManifest;
    }
  | {
      readonly ok: false;
      readonly reason: ExportBundleRejectReason;
    }
> {
  try {
    const parsed: unknown = JSON.parse(TEXT_DECODER.decode(manifestBytes));
    const normalized = safeNormalize(parsed);
    if (!normalized.ok || !isPlainObject(normalized.value)) return reject("invalid_manifest");

    const manifest = readManifest(normalized.value);
    if (!manifest.ok) return manifest;
    if (manifestHasInlineMaterial(manifest.manifest)) return reject("inline_secret_metadata");

    return manifest;
  } catch {
    return reject("invalid_manifest");
  }
}

function normalizeInput(
  input: BuildExportBundleInput,
):
  | {
      readonly ok: true;
      readonly value: readonly EntryContent[];
    }
  | {
      readonly ok: false;
      readonly reason: ExportBundleRejectReason;
    } {
  const output: EntryContent[] = [];

  if (input.createdMarker !== undefined) {
    if (typeof input.createdMarker !== "string" || input.createdMarker.length === 0) {
      return reject("invalid_metadata");
    }
    if (containsInlineSecretMaterial(input.createdMarker)) return reject("inline_secret_metadata");
  }

  if (input.stateSnapshot !== undefined) {
    const state = jsonEntry(EXPORT_CONFIG_PATH, "config", input.stateSnapshot);
    if (!state.ok) return state;
    output[output.length] = state.value;
  }

  if (input.pdsSyncState !== undefined) {
    const pds = jsonEntry(EXPORT_PDS_PATH, "pds", input.pdsSyncState);
    if (!pds.ok) return pds;
    output[output.length] = pds.value;
  }

  if (input.files !== undefined) {
    if (!Array.isArray(input.files)) return reject("invalid_input");
    if (input.files.length > MAX_ENTRIES) return reject("size_limit");

    for (let index = 0; index < input.files.length; index += 1) {
      const item = input.files[index];
      if (item === undefined) return reject("invalid_input");
      const normalized = fileEntry(item);
      if (!normalized.ok) return normalized;
      output[output.length] = normalized.value;
    }
  }

  if (output.length > MAX_ENTRIES) return reject("size_limit");

  const totalBytes = sumBytes(output);
  if (totalBytes === undefined) return reject("size_limit");

  return {
    ok: true,
    value: Object.freeze(output),
  };
}

function jsonEntry(
  path: string,
  kind: "config" | "pds",
  value: unknown,
):
  | {
      readonly ok: true;
      readonly value: EntryContent;
    }
  | {
      readonly ok: false;
      readonly reason: ExportBundleRejectReason;
    } {
  const normalized = safeNormalize(value);
  if (!normalized.ok) return reject("invalid_input");

  const data = utf8Bytes(`${canonicalJson(normalized.value)}\n`);
  if (data.byteLength > MAX_ENTRY_BYTES) return reject("size_limit");

  return {
    ok: true,
    value: {
      data,
      kind,
      path,
    },
  };
}

function fileEntry(
  file: ExportSourceFile,
):
  | {
      readonly ok: true;
      readonly value: EntryContent;
    }
  | {
      readonly ok: false;
      readonly reason: ExportBundleRejectReason;
    } {
  if (file === null || typeof file !== "object") return reject("invalid_input");
  if (typeof file.relPath !== "string") return reject("invalid_input");
  if (!isSafeRelativePath(file.relPath)) return reject("path_traversal");
  if (containsInlineSecretMaterial(file.relPath)) return reject("inline_secret_metadata");
  if (!(file.data instanceof Uint8Array)) return reject("invalid_input");
  if (file.data.byteLength > MAX_ENTRY_BYTES) return reject("size_limit");

  const data = new Uint8Array(file.data.byteLength);
  data.set(file.data);
  return {
    ok: true,
    value: {
      data,
      kind: "file",
      path: `${EXPORT_FILES_PREFIX}${file.relPath}`,
    },
  };
}

function readManifest(
  value: PlainJsonObject,
):
  | {
      readonly ok: true;
      readonly manifest: ExportManifest;
    }
  | {
      readonly ok: false;
      readonly reason: ExportBundleRejectReason;
    } {
  if (!hasOnlyFields(value, MANIFEST_FIELDS)) return reject("invalid_manifest");
  if (value.formatVersion !== EXPORT_BUNDLE_FORMAT_VERSION) return reject("invalid_manifest");
  if (!Array.isArray(value.entries)) return reject("invalid_manifest");
  if (value.entries.length > MAX_ENTRIES) return reject("size_limit");
  if (typeof value.rootDigest !== "string" || !isSha256Integrity(value.rootDigest)) {
    return reject("invalid_manifest");
  }

  const entries: ExportBundleEntry[] = [];
  for (let index = 0; index < value.entries.length; index += 1) {
    const parsed = readEntry(value.entries[index]);
    if (!parsed.ok) return parsed;
    entries[entries.length] = parsed.entry;
  }
  if (!entriesSorted(entries)) return reject("invalid_manifest");
  if (firstDuplicatePath(entries) !== undefined) return reject("duplicate_path");

  const total = sumEntryBytes(entries);
  if (total === undefined) return reject("size_limit");

  const createdMarker = value.createdMarker;
  if (createdMarker !== undefined) {
    if (typeof createdMarker !== "string" || createdMarker.length === 0) {
      return reject("invalid_manifest");
    }
    return {
      manifest: {
        createdMarker,
        entries: Object.freeze(entries),
        formatVersion: EXPORT_BUNDLE_FORMAT_VERSION,
        rootDigest: value.rootDigest,
      },
      ok: true,
    };
  }

  return {
    manifest: {
      entries: Object.freeze(entries),
      formatVersion: EXPORT_BUNDLE_FORMAT_VERSION,
      rootDigest: value.rootDigest,
    },
    ok: true,
  };
}

function readEntry(
  value: PlainJson | undefined,
):
  | {
      readonly ok: true;
      readonly entry: ExportBundleEntry;
    }
  | {
      readonly ok: false;
      readonly reason: ExportBundleRejectReason;
    } {
  if (!isPlainObject(value)) return reject("invalid_manifest");
  if (!hasOnlyFields(value, ENTRY_FIELDS)) return reject("invalid_manifest");

  const path = value.path;
  const kind = value.kind;
  const bytes = value.bytes;
  const integrity = value.integrity;

  if (typeof path !== "string" || !isSafeRelativePath(path)) return reject("path_traversal");
  if (!isEntryKind(kind)) return reject("invalid_manifest");
  if (!isNonNegativeSafeInteger(bytes) || bytes > MAX_ENTRY_BYTES) return reject("size_limit");
  if (typeof integrity !== "string" || !isSha256Integrity(integrity)) return reject("invalid_manifest");

  return {
    entry: {
      bytes,
      integrity,
      kind,
      path,
    },
    ok: true,
  };
}

function manifestHasInlineMaterial(manifest: ExportManifest): boolean {
  if (manifest.createdMarker !== undefined && containsInlineSecretMaterial(manifest.createdMarker)) {
    return true;
  }

  for (let index = 0; index < manifest.entries.length; index += 1) {
    const entry = manifest.entries[index];
    if (entry === undefined) return true;
    if (
      containsInlineSecretMaterial(entry.path) ||
      containsInlineSecretMaterial(entry.kind)
    ) {
      return true;
    }
  }

  return false;
}

async function rootDigestForEntries(entries: readonly ExportBundleEntry[]): Promise<`sha256-${string}`> {
  const sorted = [...entries].sort(compareEntries);
  return sha256Integrity(utf8Bytes(canonicalJson(sorted)));
}

async function sha256Integrity(data: Uint8Array): Promise<`sha256-${string}`> {
  const digest = await globalThis.crypto.subtle.digest("SHA-256", arrayBufferCopy(data));
  return `sha256-${base64Encode(new Uint8Array(digest))}`;
}

function arrayBufferCopy(data: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(data.byteLength);
  copy.set(data);
  return copy.buffer;
}

function canonicalJson(value: unknown): string {
  const canonical = canonicalize(value);
  if (canonical === undefined) throw new TypeError("Unsupported JSON value.");
  return JSON.stringify(canonical);
}

function canonicalize(value: unknown): PlainJson | undefined {
  if (value === undefined) return undefined;
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("JSON numbers must be finite.");
    return value;
  }
  if (Array.isArray(value)) {
    const out: PlainJson[] = [];
    for (let index = 0; index < value.length; index += 1) {
      const item = canonicalize(value[index]);
      if (item !== undefined) out[out.length] = item;
    }
    return Object.freeze(out);
  }
  if (isPlainObject(value)) {
    const out: Record<string, PlainJson> = {};
    const keys = Object.keys(value).sort(compareStrings);
    for (let index = 0; index < keys.length; index += 1) {
      const key = keys[index];
      if (key !== undefined) {
        const item = canonicalize(value[key]);
        if (item !== undefined) {
          Object.defineProperty(out, key, {
            configurable: true,
            enumerable: true,
            value: item,
            writable: true,
          });
        }
      }
    }
    return Object.freeze(out);
  }
  throw new TypeError("Unsupported JSON value.");
}

function isSafeRelativePath(value: string): boolean {
  if (value === "" || value === "." || value === "..") return false;
  if (value.startsWith("/") || value.includes("\\") || value.includes("\u0000")) return false;

  const segments = value.split("/");
  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index];
    if (segment === undefined || segment === "" || segment === "." || segment === "..") {
      return false;
    }
  }
  return true;
}

function isSha256Integrity(value: string): value is `sha256-${string}` {
  if (!value.startsWith("sha256-")) return false;
  const digest = value.slice("sha256-".length);
  return decodedBase64Length(digest) === 32;
}

function decodedBase64Length(value: string): number | undefined {
  if (value.length === 0 || value.length % 4 !== 0) return undefined;
  let padding = 0;
  if (value.endsWith("==")) {
    padding = 2;
  } else if (value.endsWith("=")) {
    padding = 1;
  }
  for (let index = 0; index < value.length - padding; index += 1) {
    if (base64Value(value.charCodeAt(index)) === undefined) return undefined;
  }
  for (let index = value.length - padding; index < value.length; index += 1) {
    if (value.charCodeAt(index) !== 61) return undefined;
  }
  return (value.length / 4) * 3 - padding;
}

function base64Encode(data: Uint8Array): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  let out = "";
  for (let index = 0; index < data.byteLength; index += 3) {
    const first = data[index] ?? 0;
    const second = data[index + 1] ?? 0;
    const third = data[index + 2] ?? 0;
    const hasSecond = index + 1 < data.byteLength;
    const hasThird = index + 2 < data.byteLength;
    out += alphabet[first >> 2] ?? "";
    out += alphabet[((first & 0x03) << 4) | (second >> 4)] ?? "";
    out += hasSecond ? (alphabet[((second & 0x0f) << 2) | (third >> 6)] ?? "") : "=";
    out += hasThird ? (alphabet[third & 0x3f] ?? "") : "=";
  }
  return out;
}

function base64Value(code: number): number | undefined {
  if (code >= 65 && code <= 90) return code - 65;
  if (code >= 97 && code <= 122) return code - 71;
  if (code >= 48 && code <= 57) return code + 4;
  if (code === 43) return 62;
  if (code === 47) return 63;
  return undefined;
}

function containsInlineSecretMaterial(value: string): boolean {
  if (
    /[\u0000-\u001f\u007f]/u.test(value) ||
    value.toUpperCase().includes("-----BEGIN") ||
    PRIVATE_KEY_PATTERN.test(value) ||
    SECRET_ASSIGNMENT_PATTERN.test(value) ||
    SEED_WORDS_PATTERN.test(value)
  ) {
    return true;
  }
  return LONG_HEX_PATTERN.test(value) || LONG_BASE64_PATTERN.test(value);
}

function sumBytes(contents: readonly EntryContent[]): number | undefined {
  let total = 0;
  for (let index = 0; index < contents.length; index += 1) {
    const content = contents[index];
    if (content === undefined) return undefined;
    if (total > MAX_TOTAL_BYTES - content.data.byteLength) return undefined;
    total += content.data.byteLength;
  }
  return total;
}

function sumEntryBytes(entries: readonly ExportBundleEntry[]): number | undefined {
  let total = 0;
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    if (entry === undefined) return undefined;
    if (total > MAX_TOTAL_BYTES - entry.bytes) return undefined;
    total += entry.bytes;
  }
  return total;
}

function firstDuplicatePath(entries: readonly ExportBundleEntry[]): string | undefined {
  for (let index = 1; index < entries.length; index += 1) {
    const current = entries[index];
    const previous = entries[index - 1];
    if (current !== undefined && previous !== undefined && current.path === previous.path) {
      return current.path;
    }
  }
  return undefined;
}

function entriesSorted(entries: readonly ExportBundleEntry[]): boolean {
  for (let index = 1; index < entries.length; index += 1) {
    const current = entries[index];
    const previous = entries[index - 1];
    if (current === undefined || previous === undefined || compareEntries(previous, current) >= 0) {
      return false;
    }
  }
  return true;
}

function compareEntries(left: ExportBundleEntry, right: ExportBundleEntry): number {
  const path = compareStrings(left.path, right.path);
  if (path !== 0) return path;
  return compareStrings(left.kind, right.kind);
}

function compareContent(left: EntryContent, right: EntryContent): number {
  const path = compareStrings(left.path, right.path);
  if (path !== 0) return path;
  return compareStrings(left.kind, right.kind);
}

function compareStrings(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function hasOnlyFields(value: PlainJsonObject, allowed: readonly string[]): boolean {
  const keys = Object.keys(value);
  for (let index = 0; index < keys.length; index += 1) {
    const key = keys[index];
    if (key === undefined || !contains(allowed, key)) return false;
  }
  return true;
}

function isEntryKind(value: PlainJson | undefined): value is ExportEntryKind {
  return typeof value === "string" && contains(ENTRY_KINDS, value);
}

function contains<T extends string>(values: readonly T[], value: string): value is T {
  for (let index = 0; index < values.length; index += 1) {
    if (values[index] === value) return true;
  }
  return false;
}

function isPlainObject(value: unknown): value is PlainJsonObject {
  return value !== undefined && value !== null && typeof value === "object" && !Array.isArray(value);
}

function isNonNegativeSafeInteger(value: PlainJson | undefined): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function utf8Bytes(value: string): Uint8Array {
  return TEXT_ENCODER.encode(value);
}

function reject<T extends BuildExportBundleResult | VerifyExportBundleResult | Awaited<ReturnType<typeof parseExportManifest>>>(
  reason: ExportBundleRejectReason,
): Extract<T, { readonly ok: false }> {
  return {
    ok: false,
    reason,
  } as Extract<T, { readonly ok: false }>;
}
