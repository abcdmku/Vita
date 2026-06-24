import { safeNormalize } from "./safe-normalize.ts";
import { readAgentStateSummary } from "./agent-state.ts";
import { readPdsSyncStateSummary } from "./pds-read.ts";
import {
  buildExportBundle,
  EXPORT_MANIFEST_PATH,
  verifyExportBundle,
} from "./export-bundle.ts";
import type { AgentClient, AgentTransport } from "./agent-client.ts";
import type { FilesClient, FilesEntry } from "./files-client.ts";
import type { ExportBundleRejectReason } from "./export-bundle.ts";
import type { PlainJson, PlainJsonObject } from "./safe-normalize.ts";

export interface ExportRoundTripOptions {
  readonly agentClient: Pick<AgentClient, "getOperations" | "getState">;
  readonly stateTransport: AgentTransport;
  readonly filesClient: FilesClient;
  readonly verifyTransport: AgentTransport;
  readonly sourceGrant: string;
  readonly sourcePath: string;
  readonly exportGrant: string;
  readonly baseUrl?: string | URL;
}

export interface ExportRejectOptions {
  readonly filesClient: FilesClient;
  readonly verifyTransport: AgentTransport;
  readonly exportGrant: string;
  readonly baseUrl?: string | URL;
}

export type ExportRoundTripResult =
  | {
      readonly ok: true;
      readonly entries: number;
      readonly bytes: number;
      readonly rootDigest: `sha256-${string}`;
    }
  | {
      readonly ok: false;
      readonly reason: string;
    };

export type ExportRejectResult =
  | {
      readonly ok: true;
      readonly reason: string;
    }
  | {
      readonly ok: false;
      readonly reason: string;
    };

interface AgentVerifyResult {
  readonly entries: number;
  readonly bytes: number;
  readonly rootDigest: `sha256-${string}`;
  readonly verified: boolean;
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
const EXPORT_MARKER = "VITA-EXPORT";
const EXPORT_REJECT_MARKER = "VITA-EXPORT-REJECT";
const EXPORT_ERROR_MARKER = "VITA-EXPORT-ERROR";
const JSON_GET_HEADERS = Object.freeze({
  Accept: "application/json",
});
const JSON_POST_HEADERS = Object.freeze({
  Accept: "application/json",
  "Content-Type": "application/json",
});
const VERIFY_RESPONSE_FIELDS = Object.freeze(["bytes", "entries", "rootDigest", "verified"]);
const ERROR_RESPONSE_FIELDS = Object.freeze(["error"]);
const ERROR_DETAIL_FIELDS = Object.freeze(["code", "message"]);
const TEXT_ENCODER = new TextEncoder();

export async function runExportRoundTrip(options: ExportRoundTripOptions): Promise<ExportRoundTripResult> {
  try {
    const stateSummary = await readAgentStateSummary(options.agentClient);
    if (!stateSummary.ok) return rejectRoundTrip("state_unreadable");

    const stateSnapshot = await readAgentStateSnapshot(options.stateTransport, options.baseUrl);
    if (!stateSnapshot.ok) return rejectRoundTrip(stateSnapshot.reason);

    const pds = await readPdsSyncStateSummary(options.agentClient);
    if (!pds.ok) return rejectRoundTrip("pds_unreadable");

    const sourceFiles = await collectSourceFiles(options.filesClient, options.sourceGrant, options.sourcePath);
    if (!sourceFiles.ok) return rejectRoundTrip(sourceFiles.reason);

    const built = await buildExportBundle({
      files: sourceFiles.value,
      pdsSyncState: pds.state,
      stateSnapshot: stateSnapshot.value,
    });
    if (!built.ok) return rejectRoundTrip(built.reason);

    for (let index = 0; index < built.blobs.length; index += 1) {
      const blob = built.blobs[index];
      if (blob === undefined) return rejectRoundTrip("invalid_bundle");
      await options.filesClient.write(options.exportGrant, blob.path, blob.data);
    }
    await options.filesClient.write(options.exportGrant, EXPORT_MANIFEST_PATH, built.manifestBytes);

    const agentVerify = await verifyWithAgent(
      options.verifyTransport,
      options.exportGrant,
      EXPORT_MANIFEST_PATH,
      options.baseUrl,
    );
    if (!agentVerify.ok) return rejectRoundTrip(agentVerify.reason);

    const readManifest = await options.filesClient.read(options.exportGrant, EXPORT_MANIFEST_PATH);
    const localVerify = await verifyExportBundle(readManifest.data, async (path) => {
      const read = await options.filesClient.read(options.exportGrant, path);
      return read.data;
    });
    if (!localVerify.ok) return rejectRoundTrip(localVerify.reason);
    if (
      localVerify.rootDigest !== built.manifest.rootDigest ||
      agentVerify.value.rootDigest !== built.manifest.rootDigest ||
      agentVerify.value.entries !== localVerify.entries ||
      agentVerify.value.bytes !== localVerify.totalBytes
    ) {
      return rejectRoundTrip("integrity_mismatch");
    }

    if (built.blobs[0] !== undefined) {
      const first = built.blobs[0];
      const read = await options.filesClient.read(options.exportGrant, first.path);
      if (!bytesEqual(read.data, first.data)) {
        return rejectRoundTrip("integrity_mismatch");
      }
    }

    return {
      bytes: localVerify.totalBytes,
      entries: localVerify.entries,
      ok: true,
      rootDigest: localVerify.rootDigest,
    };
  } catch (cause) {
    return rejectRoundTrip(errorReason(cause, "export_failed"));
  }
}

export async function rejectTamperedExportBundle(options: ExportRejectOptions): Promise<ExportRejectResult> {
  try {
    const built = await buildExportBundle({
      files: [{ data: bytes("untampered"), relPath: "tamper.txt" }],
    });
    if (!built.ok) return rejectReject(built.reason);

    await options.filesClient.write(options.exportGrant, "tamper.txt", bytes("tampered"));
    await options.filesClient.write(options.exportGrant, "tampered-export-manifest.json", built.manifestBytes);

    const verified = await verifyWithAgent(
      options.verifyTransport,
      options.exportGrant,
      "tampered-export-manifest.json",
      options.baseUrl,
    );
    if (verified.ok) return rejectReject("not_rejected");
    return {
      ok: true,
      reason: markerToken(verified.reason),
    };
  } catch (cause) {
    return rejectReject(errorReason(cause, "export_reject_failed"));
  }
}

export async function rejectInlineSecretExportMetadata(options: ExportRejectOptions): Promise<ExportRejectResult> {
  try {
    const built = await buildExportBundle({});
    if (!built.ok) return rejectReject(built.reason);

    const parsedManifest: unknown = JSON.parse(new TextDecoder().decode(built.manifestBytes));
    const normalizedManifest = safeNormalize(parsedManifest);
    if (!normalizedManifest.ok || !isPlainObject(normalizedManifest.value)) {
      return rejectReject("invalid_manifest");
    }
    const secretManifest = {
      ...normalizedManifest.value,
      createdMarker: "api_key=test-only-not-a-real-secret",
    };
    const manifestBytes = bytes(`${JSON.stringify(secretManifest)}\n`);
    await options.filesClient.write(options.exportGrant, "inline-secret-export-manifest.json", manifestBytes);

    const verified = await verifyWithAgent(
      options.verifyTransport,
      options.exportGrant,
      "inline-secret-export-manifest.json",
      options.baseUrl,
    );
    if (verified.ok) return rejectReject("not_rejected");
    return {
      ok: true,
      reason: markerToken(verified.reason),
    };
  } catch (cause) {
    return rejectReject(errorReason(cause, "export_reject_failed"));
  }
}

export function formatExportMarker(result: ExportRoundTripResult): string {
  if (!result.ok) {
    return `${EXPORT_ERROR_MARKER}: status=FAILSAFE`;
  }
  return (
    `${EXPORT_MARKER}: ` +
    `entries=${result.entries} ` +
    `bytes=${result.bytes} ` +
    `root=${shortSRI(result.rootDigest)} ` +
    "verify=OK " +
    "status=OK"
  );
}

export function formatExportRejectMarker(result: ExportRejectResult): string {
  if (!result.ok) {
    return `${EXPORT_ERROR_MARKER}: status=FAILSAFE`;
  }
  return `${EXPORT_REJECT_MARKER}: reason=${markerToken(result.reason)} status=OK`;
}

async function readAgentStateSnapshot(
  transport: AgentTransport,
  baseUrl: string | URL | undefined,
): Promise<ValidationResult<PlainJsonObject>> {
  try {
    const response = await transport(new URL("/state", baseUrl ?? DEFAULT_AGENTD_BASE_URL).toString(), {
      headers: JSON_GET_HEADERS,
      method: "GET",
    });
    const text = await response.text();
    if (!response.ok) return rejectValidation(errorCodeFromText(text) ?? "state_unreadable");

    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return rejectValidation("malformed_state");
    }
    const normalized = safeNormalize(parsed);
    if (!normalized.ok || !isPlainObject(normalized.value)) {
      return rejectValidation("malformed_state");
    }
    return acceptValidation(normalized.value);
  } catch {
    return rejectValidation("state_unreadable");
  }
}

async function collectSourceFiles(
  filesClient: FilesClient,
  grant: string,
  path: string,
): Promise<ValidationResult<readonly { readonly relPath: string; readonly data: Uint8Array }[]>> {
  try {
    const entries = await filesClient.list(grant, path);
    const files: { readonly relPath: string; readonly data: Uint8Array }[] = [];

    if (isSingleFileListing(entries, path)) {
      const read = await filesClient.read(grant, path);
      files[0] = {
        data: read.data,
        relPath: entries[0].name,
      };
      return acceptValidation(Object.freeze(files));
    }

    for (let index = 0; index < entries.length; index += 1) {
      const entry = entries[index];
      if (entry === undefined || entry.kind !== "file") continue;
      const childPath = joinRelativePath(path, entry.name);
      const read = await filesClient.read(grant, childPath);
      files[files.length] = {
        data: read.data,
        relPath: entry.name,
      };
    }
    return acceptValidation(Object.freeze(files));
  } catch (cause) {
    return rejectValidation(errorReason(cause, "files_unreadable"));
  }
}

function isSingleFileListing(entries: readonly FilesEntry[], path: string): entries is readonly [FilesEntry] {
  return entries.length === 1 && entries[0]?.kind === "file" && entries[0]?.name === basename(path);
}

async function verifyWithAgent(
  transport: AgentTransport,
  grant: string,
  manifestPath: string,
  baseUrl: string | URL | undefined,
): Promise<ValidationResult<AgentVerifyResult>> {
  let response;
  try {
    response = await transport(new URL("/export", baseUrl ?? DEFAULT_AGENTD_BASE_URL).toString(), {
      body: JSON.stringify({
        grant,
        manifestPath,
        op: "verify",
      }),
      headers: JSON_POST_HEADERS,
      method: "POST",
    });
  } catch {
    return rejectValidation("transport_error");
  }

  const text = await response.text();
  if (!response.ok) return rejectValidation(errorCodeFromText(text) ?? "export_verify_failed");

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return rejectValidation("malformed_response");
  }
  const normalized = safeNormalize(parsed);
  if (!normalized.ok || !isPlainObject(normalized.value)) {
    return rejectValidation("malformed_response");
  }
  return validateVerifyResponse(normalized.value);
}

function validateVerifyResponse(payload: PlainJsonObject): ValidationResult<AgentVerifyResult> {
  const fields = expectFields(payload, VERIFY_RESPONSE_FIELDS);
  if (!fields.ok) return fields;

  const entries = field(payload, "entries");
  const byteCount = field(payload, "bytes");
  const rootDigest = field(payload, "rootDigest");
  const verified = field(payload, "verified");
  if (!isNonNegativeSafeInteger(entries)) return rejectValidation("malformed_response");
  if (!isNonNegativeSafeInteger(byteCount)) return rejectValidation("malformed_response");
  if (typeof rootDigest !== "string" || !isSha256Integrity(rootDigest)) {
    return rejectValidation("malformed_response");
  }
  if (verified !== true) return rejectValidation("malformed_response");

  return acceptValidation({
    bytes: byteCount,
    entries,
    rootDigest,
    verified,
  });
}

function errorCodeFromText(text: string): string | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  const normalized = safeNormalize(parsed);
  if (!normalized.ok || !isPlainObject(normalized.value)) return undefined;
  const fields = expectFields(normalized.value, ERROR_RESPONSE_FIELDS);
  if (!fields.ok) return undefined;
  const error = field(normalized.value, "error");
  if (!isPlainObject(error)) return undefined;
  const detailFields = expectFields(error, ERROR_DETAIL_FIELDS);
  if (!detailFields.ok) return undefined;
  const code = field(error, "code");
  return typeof code === "string" && code.length > 0 ? code : undefined;
}

function expectFields(value: PlainJsonObject, allowed: readonly string[]): ValidationResult<true> {
  const keys = Object.keys(value);
  for (let index = 0; index < keys.length; index += 1) {
    const key = keys[index];
    if (key === undefined || !contains(allowed, key)) {
      return rejectValidation("malformed_response");
    }
  }
  for (let index = 0; index < allowed.length; index += 1) {
    const key = allowed[index];
    if (key === undefined || !Object.hasOwn(value, key)) {
      return rejectValidation("malformed_response");
    }
  }
  return acceptValidation(true);
}

function field(value: PlainJsonObject, key: string): PlainJson | undefined {
  if (!Object.hasOwn(value, key)) return undefined;
  return value[key];
}

function joinRelativePath(parent: string, child: string): string {
  if (parent === "." || parent === "") return child;
  return `${parent.replace(/\/+$/u, "")}/${child}`;
}

function basename(path: string): string {
  const trimmed = path.replace(/\/+$/u, "");
  const separator = trimmed.lastIndexOf("/");
  return separator < 0 ? trimmed : trimmed.slice(separator + 1);
}

function isPlainObject(value: PlainJson | undefined): value is PlainJsonObject {
  return value !== undefined && value !== null && typeof value === "object" && !Array.isArray(value);
}

function isNonNegativeSafeInteger(value: PlainJson | undefined): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isSha256Integrity(value: string): value is `sha256-${string}` {
  if (!value.startsWith("sha256-")) return false;
  return /^[A-Za-z0-9+/]+={0,2}$/u.test(value.slice("sha256-".length));
}

function bytes(value: string): Uint8Array {
  return TEXT_ENCODER.encode(value);
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  for (let index = 0; index < left.byteLength; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

function errorReason(cause: unknown, fallback: string): string {
  if (cause !== null && typeof cause === "object" && Object.hasOwn(cause, "reason")) {
    const reason = (cause as { readonly reason?: unknown }).reason;
    if (typeof reason === "string" && reason.length > 0) return markerToken(reason);
  }
  return fallback;
}

function shortSRI(integrity: string): string {
  const separator = integrity.indexOf("-");
  if (separator <= 0) return markerToken(integrity);
  const algorithm = integrity.slice(0, separator);
  const token = integrity.slice(separator + 1, separator + 13);
  return `${algorithm}-${token}`;
}

function markerToken(value: string): string {
  const token = value.replace(/[^A-Za-z0-9_.-]+/gu, "_");
  return token.length === 0 ? "unknown" : token;
}

function contains(values: readonly string[], value: string): boolean {
  for (let index = 0; index < values.length; index += 1) {
    if (values[index] === value) return true;
  }
  return false;
}

function acceptValidation<T>(value: T): ValidationResult<T> {
  return {
    ok: true,
    value,
  };
}

function rejectValidation<T>(reason: string): ValidationResult<T> {
  return {
    ok: false,
    reason,
  };
}

function rejectRoundTrip(reason: ExportBundleRejectReason | string): Extract<ExportRoundTripResult, { readonly ok: false }> {
  return {
    ok: false,
    reason: markerToken(reason),
  };
}

function rejectReject(reason: ExportBundleRejectReason | string): Extract<ExportRejectResult, { readonly ok: false }> {
  return {
    ok: false,
    reason: markerToken(reason),
  };
}
