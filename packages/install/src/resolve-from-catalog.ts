import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { TextDecoder, types as nodeTypes } from "node:util";
import { zstdDecompressSync } from "node:zlib";

import { verifyCatalog } from "../../catalog/src/catalog-manifest.ts";
import type {
  CatalogApp,
  CatalogAppVersion,
  CatalogPayload,
  TrustedCatalogKeys,
} from "../../catalog/src/catalog-manifest.ts";
import { validateCatalogEntry } from "../../catalog/src/catalog-entry.ts";
import type { PackageContract } from "../../../sdk/manifests/src/package-contract.ts";
import { parseSriIntegrity } from "../../../sdk/typescript/src/sri.ts";
import { safeNormalize } from "../../../sdk/typescript/src/safe-normalize.ts";
import type { PlainJson, PlainJsonObject } from "../../../sdk/typescript/src/safe-normalize.ts";
import { resolveFromMirror } from "./mirror.ts";
import type {
  MirrorResolution,
  MirrorResolutionError,
  MirrorStore,
} from "./mirror.ts";
import { resolveInstallPlan } from "./resolve.ts";
import type {
  InstallPlan,
  ResolveInstallPlanError,
} from "./resolve.ts";

export interface ResolveFromCatalogInput {
  readonly catalog: unknown;
  readonly trustedKeys: TrustedCatalogKeys;
  readonly appId: string;
  readonly version: string;
  readonly mirrorStore: MirrorStore;
}

export interface CatalogInstallPlan extends InstallPlan {
  readonly appId: string;
  readonly version: string;
  readonly packageRef: string;
  readonly integrity: string;
  readonly packageClass: PackageContract["packageClass"];
  readonly resourceLimits: PackageContract["resources"];
  readonly mirrorResolution: MirrorResolution;
}

export interface ResolveFromCatalogError {
  readonly code:
    | "CATALOG_UNVERIFIED"
    | "APP_NOT_FOUND"
    | "VERSION_NOT_FOUND"
    | "POLICY_REJECTED"
    | "NOT_IN_MIRROR"
    | "INTEGRITY_MISMATCH";
  readonly path: string;
  readonly message: string;
}

export type ResolveFromCatalogResult =
  | {
      readonly ok: true;
      readonly plan: CatalogInstallPlan;
    }
  | {
      readonly ok: false;
      readonly errors: readonly ResolveFromCatalogError[];
    };

interface NormalizedInput {
  readonly catalog: unknown;
  readonly trustedKeys: TrustedCatalogKeys;
  readonly appId: unknown;
  readonly version: unknown;
  readonly mirrorStore: unknown;
}

interface NormalizedRequest {
  readonly appId: string;
  readonly version: string;
  readonly mirrorStore: MirrorStore;
}

interface LocatedCatalogVersion {
  readonly appIndex: number;
  readonly versionIndex: number;
  readonly entry: CatalogAppVersion;
}

interface CatalogPackageArtifact {
  readonly manifest: ExecutionManifest;
}

interface ExecutionManifest {
  readonly id: string;
  readonly version: string;
  readonly integrity: string;
  readonly packageClass: PackageContract["packageClass"] | "oci-service" | "wasm-service";
}

interface CatalogInstallMetadata {
  readonly entry: PlainJsonObject;
  readonly lockfile: PlainJsonObject;
}

type Path = readonly string[];

const TEXT_DECODER = new TextDecoder("utf-8", { fatal: true });
const INPUT_FIELDS = new Set(["catalog", "trustedKeys", "appId", "version", "mirrorStore"]);
const TAR_BLOCK_BYTES = 512;
const TAR_NAME_BYTES = 100;
const TAR_SIZE_OFFSET = 124;
const TAR_SIZE_BYTES = 12;
const TAR_CHECKSUM_OFFSET = 148;
const TAR_CHECKSUM_BYTES = 8;
const TAR_TYPE_OFFSET = 156;
const TAR_PREFIX_OFFSET = 345;
const TAR_PREFIX_BYTES = 155;
const ZSTD_MAGIC = [0x28, 0xb5, 0x2f, 0xfd] as const;
const CAPSULE_MANIFEST_BASENAME = "manifest.json";
const EXECUTION_MANIFEST_FIELDS = new Set([
  "data",
  "healthChecks",
  "id",
  "integrity",
  "lifecyclePolicy",
  "network",
  "packageClass",
  "resourceLimits",
  "runtime",
  "version",
]);
const EXECUTION_PACKAGE_CLASSES = new Set(["ts-service", "oci-service", "wasm-service"]);
const EXECUTION_RUNTIME_FIELDS = new Set(["typescript", "oci", "wasm"]);
const TYPESCRIPT_RUNTIME_FIELDS = new Set(["entrypoint"]);
const RESOURCE_LIMIT_FIELDS = new Set(["cpuCores", "ramMiB", "storageMiB", "tasksMax"]);
const OPTIONAL_EXECUTION_OBJECT_FIELDS = new Set(["data", "lifecyclePolicy", "network"]);
const REVERSE_DNS_PATTERN =
  /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/u;
const OPAQUE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,159}$/u;
const EXECUTION_VERSION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9.+_-]{0,127}$/u;

export function resolveFromCatalog(input: unknown): ResolveFromCatalogResult {
  try {
    const normalized = normalizeInput(input);
    if (!normalized.ok) return reject([normalized.error]);

    const verified = verifyCatalog(normalized.value.catalog, normalized.value.trustedKeys);
    if (!verified.ok) {
      return reject(
        verified.errors.map((catalogError) =>
          error("CATALOG_UNVERIFIED", parsePath(catalogError.path), catalogError.message),
        ),
      );
    }

    const request = normalizeRequest(
      normalized.value.appId,
      normalized.value.version,
      normalized.value.mirrorStore,
    );
    if (!request.ok) return reject([request.error]);

    const located = locateCatalogVersion(verified.catalog, request.value.appId, request.value.version);
    if (!located.ok) return reject([located.error]);

    const artifactBytes = readArtifactBytes(
      request.value.mirrorStore,
      located.value.entry.packageRef,
      ["catalog", "apps", String(located.value.appIndex), "versions", String(located.value.versionIndex), "packageRef"],
    );
    if (!artifactBytes.ok) return reject([artifactBytes.error]);

    if (!verifySriBytes(artifactBytes.value, located.value.entry.integrity)) {
      return reject([
        error(
          "INTEGRITY_MISMATCH",
          ["catalog", "apps", String(located.value.appIndex), "versions", String(located.value.versionIndex), "integrity"],
          "Catalog package artifact bytes do not match the catalog entry SRI.",
        ),
      ]);
    }

    const artifact = parsePackageArtifact(artifactBytes.value);
    if (!artifact.ok) return reject([artifact.error]);

    const manifestMatch = verifySelectedManifest(
      artifact.value.manifest,
      request.value.appId,
      request.value.version,
    );
    if (!manifestMatch.ok) return reject([manifestMatch.error]);

    const metadata = readCatalogInstallMetadata(
      located.value.entry,
      ["catalog", "apps", String(located.value.appIndex), "versions", String(located.value.versionIndex)],
    );
    if (!metadata.ok) return reject([metadata.error]);

    const contract = inlinePackageContract(metadata.value.entry);
    if (!contract.ok) return reject([contract.error]);

    const contractMatch = verifySelectedContract(
      contract.value,
      request.value.appId,
      request.value.version,
    );
    if (!contractMatch.ok) return reject([contractMatch.error]);

    const mirrorResult = resolveFromMirror(metadata.value.lockfile, request.value.mirrorStore);
    if (!mirrorResult.ok) {
      return reject(mirrorResult.errors.map(mirrorResolutionError));
    }

    const installPlan = resolveInstallPlan(metadata.value.entry, metadata.value.lockfile);
    if (!installPlan.ok) {
      return reject(installPlan.errors.map(installPlanError));
    }

    return {
      ok: true,
      plan: {
        appId: request.value.appId,
        capabilityGrants: installPlan.plan.capabilityGrants,
        integrity: located.value.entry.integrity,
        mirrorResolution: mirrorResult.resolution,
        package: installPlan.plan.package,
        packageClass: contract.value.packageClass,
        packageRef: located.value.entry.packageRef,
        resourceLimits: {
          cpuCores: contract.value.resources.cpuCores,
          ramMiB: contract.value.resources.ramMiB,
          storageMiB: contract.value.resources.storageMiB,
        },
        steps: installPlan.plan.steps,
        trustTier: installPlan.plan.trustTier,
        version: located.value.entry.version,
      },
    };
  } catch {
    return reject([
      error("POLICY_REJECTED", [], "Catalog install resolution failed closed."),
    ]);
  }
}

function normalizeInput(input: unknown):
  | {
      readonly ok: true;
      readonly value: NormalizedInput;
    }
  | {
      readonly ok: false;
      readonly error: ResolveFromCatalogError;
    } {
  const snapshot = snapshotInputObject(input);
  if (!snapshot.ok) {
    return {
      error: error("POLICY_REJECTED", [], snapshot.reason),
      ok: false,
    };
  }

  const keys = sortedKeys(snapshot.value);
  for (let index = 0; index < keys.length; index += 1) {
    const key = keys[index];
    if (key !== undefined && !INPUT_FIELDS.has(key)) {
      return {
        error: error("POLICY_REJECTED", [key], "Unknown resolveFromCatalog input field."),
        ok: false,
      };
    }
  }

  const catalog = snapshot.value.catalog;
  const trustedKeys = normalizeTrustedKeys(snapshot.value.trustedKeys);
  if (!trustedKeys.ok) {
    return {
      error: trustedKeys.error,
      ok: false,
    };
  }

  return {
    ok: true,
    value: {
      appId: snapshot.value.appId,
      catalog,
      mirrorStore: snapshot.value.mirrorStore,
      trustedKeys: trustedKeys.value,
      version: snapshot.value.version,
    },
  };
}

function normalizeRequest(
  appIdValue: unknown,
  versionValue: unknown,
  mirrorStoreValue: unknown,
):
  | {
      readonly ok: true;
      readonly value: NormalizedRequest;
    }
  | {
      readonly ok: false;
      readonly error: ResolveFromCatalogError;
    } {
  const appId = appIdValue;
  if (typeof appId !== "string" || appId === "") {
    return {
      error: error("POLICY_REJECTED", ["appId"], "Expected non-empty app id string."),
      ok: false,
    };
  }

  const version = versionValue;
  if (typeof version !== "string" || version === "") {
    return {
      error: error("POLICY_REJECTED", ["version"], "Expected non-empty version string."),
      ok: false,
    };
  }

  const mirrorStore = normalizeMirrorStore(mirrorStoreValue);
  if (!mirrorStore.ok) {
    return {
      error: mirrorStore.error,
      ok: false,
    };
  }

  return {
    ok: true,
    value: {
      appId,
      mirrorStore: mirrorStore.value,
      version,
    },
  };
}

function normalizeTrustedKeys(value: unknown):
  | {
      readonly ok: true;
      readonly value: TrustedCatalogKeys;
    }
  | {
      readonly ok: false;
      readonly error: ResolveFromCatalogError;
    } {
  const normalized = safeNormalize(value, { maxDepth: 8, maxNodes: 10_000 });
  if (!normalized.ok) {
    return {
      error: error(
        "CATALOG_UNVERIFIED",
        ["trustedKeys"],
        `Trusted catalog keys could not be safely normalized: ${normalized.reason}`,
      ),
      ok: false,
    };
  }

  if (!plainObject(normalized.value)) {
    return {
      error: error("CATALOG_UNVERIFIED", ["trustedKeys"], "Expected trusted catalog keys object."),
      ok: false,
    };
  }

  const out = Object.create(null) as Record<string, string>;
  const keys = sortedKeys(normalized.value);
  for (let index = 0; index < keys.length; index += 1) {
    const key = keys[index];
    if (key === undefined) continue;

    const publicKey = normalized.value[key];
    if (typeof publicKey !== "string" || publicKey === "") {
      return {
        error: error("CATALOG_UNVERIFIED", ["trustedKeys", key], "Expected non-empty public key string."),
        ok: false,
      };
    }

    Object.defineProperty(out, key, {
      configurable: true,
      enumerable: true,
      value: publicKey,
      writable: true,
    });
  }

  return {
    ok: true,
    value: Object.freeze(out),
  };
}

function normalizeMirrorStore(value: unknown):
  | {
      readonly ok: true;
      readonly value: MirrorStore;
    }
  | {
      readonly ok: false;
      readonly error: ResolveFromCatalogError;
    } {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return {
      error: error("POLICY_REJECTED", ["mirrorStore"], "Expected mirror store object."),
      ok: false,
    };
  }

  if (nodeTypes.isProxy(value)) {
    return {
      error: error("POLICY_REJECTED", ["mirrorStore"], "Expected plain mirror store object."),
      ok: false,
    };
  }

  if (value instanceof Map) {
    return {
      ok: true,
      value: {
        get(key: string): Uint8Array | undefined {
          const item = Map.prototype.get.call(value, key) as unknown;
          return item instanceof Uint8Array ? item : undefined;
        },
      },
    };
  }

  const getValue = ownDataValue(value, "get");
  if (typeof getValue !== "function") {
    return {
      error: error("POLICY_REJECTED", ["mirrorStore", "get"], "Expected mirror store get function."),
      ok: false,
    };
  }

  return {
    ok: true,
    value: {
      get(key: string): Uint8Array | undefined {
        const item: unknown = Reflect.apply(getValue, value, [key]);
        return item instanceof Uint8Array ? item : undefined;
      },
    },
  };
}

function locateCatalogVersion(
  catalog: CatalogPayload,
  appId: string,
  version: string,
):
  | {
      readonly ok: true;
      readonly value: LocatedCatalogVersion;
    }
  | {
      readonly ok: false;
      readonly error: ResolveFromCatalogError;
    } {
  let matchingApp: CatalogApp | undefined;
  let appIndex = -1;

  for (let index = 0; index < catalog.apps.length; index += 1) {
    const app = catalog.apps[index];
    if (app === undefined || app.id !== appId) continue;

    if (matchingApp !== undefined) {
      return {
        error: error("APP_NOT_FOUND", ["catalog", "apps"], `Ambiguous catalog app id ${appId}.`),
        ok: false,
      };
    }

    matchingApp = app;
    appIndex = index;
  }

  if (matchingApp === undefined) {
    return {
      error: error("APP_NOT_FOUND", ["appId"], `Catalog app ${appId} was not found.`),
      ok: false,
    };
  }

  let matchingVersion: CatalogAppVersion | undefined;
  let versionIndex = -1;
  for (let index = 0; index < matchingApp.versions.length; index += 1) {
    const candidate = matchingApp.versions[index];
    if (candidate === undefined || candidate.version !== version) continue;

    if (matchingVersion !== undefined) {
      return {
        error: error(
          "VERSION_NOT_FOUND",
          ["catalog", "apps", String(appIndex), "versions"],
          `Ambiguous catalog version ${version} for app ${appId}.`,
        ),
        ok: false,
      };
    }

    matchingVersion = candidate;
    versionIndex = index;
  }

  if (matchingVersion === undefined) {
    return {
      error: error("VERSION_NOT_FOUND", ["version"], `Catalog version ${version} was not found for app ${appId}.`),
      ok: false,
    };
  }

  return {
    ok: true,
    value: {
      appIndex,
      entry: matchingVersion,
      versionIndex,
    },
  };
}

function readArtifactBytes(
  mirrorStore: MirrorStore,
  packageRef: string,
  path: Path,
):
  | {
      readonly ok: true;
      readonly value: Uint8Array;
    }
  | {
      readonly ok: false;
      readonly error: ResolveFromCatalogError;
    } {
  try {
    const bytes = mirrorStore.get(packageRef);
    if (bytes === undefined) {
      return {
        error: error("NOT_IN_MIRROR", path, `Catalog package ${packageRef} is not present in the mirror store.`),
        ok: false,
      };
    }

    if (!(bytes instanceof Uint8Array)) {
      return {
        error: error("POLICY_REJECTED", path, `Mirror store returned non-byte package artifact for ${packageRef}.`),
        ok: false,
      };
    }

    return {
      ok: true,
      value: new Uint8Array(bytes),
    };
  } catch {
    return {
      error: error("POLICY_REJECTED", path, "Could not read catalog package artifact from mirror store."),
      ok: false,
    };
  }
}

function parsePackageArtifact(bytes: Uint8Array):
  | {
      readonly ok: true;
      readonly value: CatalogPackageArtifact;
    }
  | {
      readonly ok: false;
      readonly error: ResolveFromCatalogError;
    } {
  const tarBytes = capsuleTarBytes(bytes);
  if (!tarBytes.ok) return { error: tarBytes.error, ok: false };

  const files = readCapsuleFiles(tarBytes.value);
  if (!files.ok) return { error: files.error, ok: false };

  const manifest = parseArtifactJson(files.value.manifest, [CAPSULE_MANIFEST_BASENAME]);
  if (!manifest.ok) return { error: manifest.error, ok: false };

  const executionManifest = readExecutionManifest(manifest.value, [CAPSULE_MANIFEST_BASENAME]);
  if (!executionManifest.ok) return { error: executionManifest.error, ok: false };

  return {
    ok: true,
    value: {
      manifest: executionManifest.value,
    },
  };
}

function capsuleTarBytes(bytes: Uint8Array):
  | {
      readonly ok: true;
      readonly value: Uint8Array;
    }
  | {
      readonly ok: false;
      readonly error: ResolveFromCatalogError;
    } {
  if (!hasZstdMagic(bytes)) {
    return {
      ok: true,
      value: bytes,
    };
  }

  try {
    return {
      ok: true,
      value: zstdDecompressSync(bytes),
    };
  } catch {
    return {
      error: error("POLICY_REJECTED", [], "Catalog package artifact zstd decompression failed."),
      ok: false,
    };
  }
}

function readCapsuleFiles(bytes: Uint8Array):
  | {
      readonly ok: true;
      readonly value: {
        readonly manifest: Uint8Array;
      };
    }
  | {
      readonly ok: false;
      readonly error: ResolveFromCatalogError;
    } {
  let offset = 0;
  let manifest: Uint8Array | undefined;

  while (offset < bytes.length) {
    if (offset + TAR_BLOCK_BYTES > bytes.length) {
      return {
        error: error("POLICY_REJECTED", [], "Capsule artifact tar header is truncated."),
        ok: false,
      };
    }

    const header = bytes.subarray(offset, offset + TAR_BLOCK_BYTES);
    if (isZeroBlock(header)) {
      return readCapsuleFilesResult(manifest);
    }

    if (!validTarChecksum(header)) {
      return {
        error: error("POLICY_REJECTED", [], "Capsule artifact tar header checksum is invalid."),
        ok: false,
      };
    }

    const size = parseTarOctal(header, TAR_SIZE_OFFSET, TAR_SIZE_BYTES);
    if (size === undefined) {
      return {
        error: error("POLICY_REJECTED", [], "Capsule artifact tar entry size is invalid."),
        ok: false,
      };
    }

    const dataStart = offset + TAR_BLOCK_BYTES;
    const dataEnd = dataStart + size;
    const nextOffset = dataStart + roundUpToTarBlock(size);
    if (dataEnd > bytes.length || nextOffset > bytes.length) {
      return {
        error: error("POLICY_REJECTED", [], "Capsule artifact tar entry is truncated."),
        ok: false,
      };
    }

    if (isRegularTarEntry(header)) {
      const path = readTarPath(header);
      if (path === undefined) {
        return {
          error: error("POLICY_REJECTED", [], "Capsule artifact tar path is invalid."),
          ok: false,
        };
      }

      const basename = basenameFromPath(path);
      if (basename === CAPSULE_MANIFEST_BASENAME) {
        if (manifest !== undefined) {
          return {
            error: error("POLICY_REJECTED", [CAPSULE_MANIFEST_BASENAME], "Capsule artifact contains ambiguous manifests."),
            ok: false,
          };
        }

        manifest = bytes.slice(dataStart, dataEnd);
      }
    }

    offset = nextOffset;
  }

  return readCapsuleFilesResult(manifest);
}

function readCapsuleFilesResult(
  manifest: Uint8Array | undefined,
):
  | {
      readonly ok: true;
      readonly value: {
        readonly manifest: Uint8Array;
      };
    }
  | {
      readonly ok: false;
      readonly error: ResolveFromCatalogError;
    } {
  if (manifest === undefined) {
    return {
      error: error("POLICY_REJECTED", [CAPSULE_MANIFEST_BASENAME], "Capsule artifact manifest.json is required."),
      ok: false,
    };
  }

  return {
    ok: true,
    value: {
      manifest,
    },
  };
}

function parseArtifactJson(bytes: Uint8Array, path: Path):
  | {
      readonly ok: true;
      readonly value: PlainJson;
    }
  | {
      readonly ok: false;
      readonly error: ResolveFromCatalogError;
    } {
  let parsed: unknown;
  let text: string;

  try {
    text = TEXT_DECODER.decode(bytes);
  } catch {
    return {
      error: error("POLICY_REJECTED", path, "Capsule artifact JSON file is invalid."),
      ok: false,
    };
  }

  const duplicateKey = findDuplicateJsonObjectKey(text);
  if (duplicateKey !== undefined) {
    return {
      error: error("POLICY_REJECTED", path, `Capsule artifact JSON file contains duplicate object key ${duplicateKey}.`),
      ok: false,
    };
  }

  try {
    parsed = JSON.parse(text);
  } catch {
    return {
      error: error("POLICY_REJECTED", path, "Capsule artifact JSON file is invalid."),
      ok: false,
    };
  }

  const normalized = safeNormalize(parsed, { maxDepth: 128, maxNodes: 100_000 });
  if (!normalized.ok) {
    return {
      error: error("POLICY_REJECTED", path, `Capsule artifact JSON file could not be safely normalized: ${normalized.reason}`),
      ok: false,
    };
  }

  return {
    ok: true,
    value: normalized.value,
  };
}

interface JsonKeyCursor {
  readonly text: string;
  index: number;
  duplicate: string | undefined;
  failed: boolean;
}

function findDuplicateJsonObjectKey(text: string): string | undefined {
  const cursor: JsonKeyCursor = {
    duplicate: undefined,
    failed: false,
    index: 0,
    text,
  };

  parseJsonValue(cursor);
  return cursor.duplicate;
}

function parseJsonValue(cursor: JsonKeyCursor): void {
  if (cursor.duplicate !== undefined || cursor.failed) return;

  skipJsonWhitespace(cursor);
  const char = cursor.text[cursor.index];

  if (char === "{") {
    parseJsonObject(cursor);
  } else if (char === "[") {
    parseJsonArray(cursor);
  } else if (char === "\"") {
    parseJsonString(cursor);
  } else if (char === "t") {
    consumeJsonLiteral(cursor, "true");
  } else if (char === "f") {
    consumeJsonLiteral(cursor, "false");
  } else if (char === "n") {
    consumeJsonLiteral(cursor, "null");
  } else {
    consumeJsonNumber(cursor);
  }
}

function parseJsonObject(cursor: JsonKeyCursor): void {
  cursor.index += 1;
  skipJsonWhitespace(cursor);

  if (cursor.text[cursor.index] === "}") {
    cursor.index += 1;
    return;
  }

  const keys = new Set<string>();
  while (cursor.index < cursor.text.length) {
    const key = parseJsonString(cursor);
    if (key === undefined) return;

    if (keys.has(key)) {
      cursor.duplicate = key;
      return;
    }
    keys.add(key);

    skipJsonWhitespace(cursor);
    if (cursor.text[cursor.index] !== ":") {
      cursor.failed = true;
      return;
    }
    cursor.index += 1;

    parseJsonValue(cursor);
    if (cursor.duplicate !== undefined || cursor.failed) return;

    skipJsonWhitespace(cursor);
    const delimiter = cursor.text[cursor.index];
    if (delimiter === "}") {
      cursor.index += 1;
      return;
    }
    if (delimiter !== ",") {
      cursor.failed = true;
      return;
    }
    cursor.index += 1;
    skipJsonWhitespace(cursor);
  }

  cursor.failed = true;
}

function parseJsonArray(cursor: JsonKeyCursor): void {
  cursor.index += 1;
  skipJsonWhitespace(cursor);

  if (cursor.text[cursor.index] === "]") {
    cursor.index += 1;
    return;
  }

  while (cursor.index < cursor.text.length) {
    parseJsonValue(cursor);
    if (cursor.duplicate !== undefined || cursor.failed) return;

    skipJsonWhitespace(cursor);
    const delimiter = cursor.text[cursor.index];
    if (delimiter === "]") {
      cursor.index += 1;
      return;
    }
    if (delimiter !== ",") {
      cursor.failed = true;
      return;
    }
    cursor.index += 1;
  }

  cursor.failed = true;
}

function parseJsonString(cursor: JsonKeyCursor): string | undefined {
  if (cursor.text[cursor.index] !== "\"") {
    cursor.failed = true;
    return undefined;
  }

  cursor.index += 1;
  let value = "";

  while (cursor.index < cursor.text.length) {
    const code = cursor.text.charCodeAt(cursor.index);
    cursor.index += 1;

    if (code === 0x22) {
      return value;
    }

    if (code === 0x5c) {
      const escaped = readJsonEscape(cursor);
      if (escaped === undefined) return undefined;
      value += escaped;
      continue;
    }

    if (code <= 0x1f) {
      cursor.failed = true;
      return undefined;
    }

    value += String.fromCharCode(code);
  }

  cursor.failed = true;
  return undefined;
}

function readJsonEscape(cursor: JsonKeyCursor): string | undefined {
  const char = cursor.text[cursor.index];
  cursor.index += 1;

  if (char === "\"" || char === "\\" || char === "/") return char;
  if (char === "b") return "\b";
  if (char === "f") return "\f";
  if (char === "n") return "\n";
  if (char === "r") return "\r";
  if (char === "t") return "\t";

  if (char !== "u") {
    cursor.failed = true;
    return undefined;
  }

  const hex = cursor.text.slice(cursor.index, cursor.index + 4);
  if (!/^[0-9A-Fa-f]{4}$/u.test(hex)) {
    cursor.failed = true;
    return undefined;
  }

  cursor.index += 4;
  return String.fromCharCode(Number.parseInt(hex, 16));
}

function consumeJsonLiteral(cursor: JsonKeyCursor, literal: string): void {
  if (cursor.text.startsWith(literal, cursor.index)) {
    cursor.index += literal.length;
    return;
  }

  cursor.failed = true;
}

function consumeJsonNumber(cursor: JsonKeyCursor): void {
  const start = cursor.index;
  while (cursor.index < cursor.text.length) {
    const char = cursor.text[cursor.index];
    if (
      char === undefined ||
      char === "," ||
      char === "]" ||
      char === "}" ||
      jsonWhitespace(char)
    ) {
      break;
    }
    cursor.index += 1;
  }

  if (cursor.index === start) {
    cursor.failed = true;
  }
}

function skipJsonWhitespace(cursor: JsonKeyCursor): void {
  while (cursor.index < cursor.text.length) {
    const char = cursor.text[cursor.index];
    if (char === undefined || !jsonWhitespace(char)) return;
    cursor.index += 1;
  }
}

function jsonWhitespace(char: string): boolean {
  return char === " " || char === "\n" || char === "\r" || char === "\t";
}

function readExecutionManifest(
  value: PlainJson,
  path: Path,
):
  | {
      readonly ok: true;
      readonly value: ExecutionManifest;
    }
  | {
      readonly ok: false;
      readonly error: ResolveFromCatalogError;
    } {
  if (!plainObject(value)) {
    return {
      error: error("POLICY_REJECTED", path, "Expected capsule ExecutionManifest object."),
      ok: false,
    };
  }

  const unsafeKey = findUnsafeObjectKey(value, path);
  if (unsafeKey !== undefined) {
    return {
      error: error("POLICY_REJECTED", unsafeKey, "Capsule ExecutionManifest contains an unsafe object key."),
      ok: false,
    };
  }

  const unknown = unknownField(value, EXECUTION_MANIFEST_FIELDS, path);
  if (unknown !== undefined) {
    return {
      error: unknown,
      ok: false,
    };
  }

  const id = requiredString(value, "id", path);
  if (!id.ok) return { error: id.error, ok: false };
  if (!validExecutionID(id.value)) {
    return {
      error: error("POLICY_REJECTED", [...path, "id"], "ExecutionManifest id is not a valid capsule id."),
      ok: false,
    };
  }

  const version = requiredString(value, "version", path);
  if (!version.ok) return { error: version.error, ok: false };
  if (!validExecutionVersion(version.value)) {
    return {
      error: error("POLICY_REJECTED", [...path, "version"], "ExecutionManifest version is not valid."),
      ok: false,
    };
  }

  const integrity = requiredString(value, "integrity", path);
  if (!integrity.ok) return { error: integrity.error, ok: false };
  if (!parseSriIntegrity(integrity.value).ok) {
    return {
      error: error("POLICY_REJECTED", [...path, "integrity"], "ExecutionManifest integrity is not valid SRI."),
      ok: false,
    };
  }

  const packageClass = requiredString(value, "packageClass", path);
  if (!packageClass.ok) return { error: packageClass.error, ok: false };
  if (!EXECUTION_PACKAGE_CLASSES.has(packageClass.value)) {
    return {
      error: error("POLICY_REJECTED", [...path, "packageClass"], "ExecutionManifest packageClass is not supported."),
      ok: false,
    };
  }

  const runtime = readExecutionRuntime(value.runtime, packageClass.value, [...path, "runtime"]);
  if (!runtime.ok) return { error: runtime.error, ok: false };

  const limits = readExecutionResourceLimits(value.resourceLimits, [...path, "resourceLimits"]);
  if (!limits.ok) return { error: limits.error, ok: false };

  const optionalObjects = validateOptionalExecutionObjects(value, path);
  if (!optionalObjects.ok) return { error: optionalObjects.error, ok: false };

  return {
    ok: true,
    value: {
      id: id.value,
      integrity: integrity.value,
      packageClass: packageClass.value as ExecutionManifest["packageClass"],
      version: version.value,
    },
  };
}

function readExecutionRuntime(
  value: PlainJson | undefined,
  packageClass: string,
  path: Path,
):
  | {
      readonly ok: true;
    }
  | {
      readonly ok: false;
      readonly error: ResolveFromCatalogError;
    } {
  if (!plainObject(value)) {
    return {
      error: error("POLICY_REJECTED", path, "ExecutionManifest runtime is required."),
      ok: false,
    };
  }

  const unknown = unknownField(value, EXECUTION_RUNTIME_FIELDS, path);
  if (unknown !== undefined) {
    return {
      error: unknown,
      ok: false,
    };
  }

  const keys = sortedKeys(value);
  if (keys.length !== 1) {
    return {
      error: error("POLICY_REJECTED", path, "ExecutionManifest runtime must declare exactly one runtime."),
      ok: false,
    };
  }

  const runtimeKind = keys[0];
  if (runtimeKind === undefined) {
    return {
      error: error("POLICY_REJECTED", path, "ExecutionManifest runtime must declare exactly one runtime."),
      ok: false,
    };
  }

  if (
    (packageClass === "ts-service" && runtimeKind !== "typescript") ||
    (packageClass === "oci-service" && runtimeKind !== "oci") ||
    (packageClass === "wasm-service" && runtimeKind !== "wasm")
  ) {
    return {
      error: error("POLICY_REJECTED", [...path, runtimeKind], "ExecutionManifest runtime does not match packageClass."),
      ok: false,
    };
  }

  const runtimeValue = value[runtimeKind];
  if (!plainObject(runtimeValue)) {
    return {
      error: error("POLICY_REJECTED", [...path, runtimeKind], "ExecutionManifest runtime descriptor must be an object."),
      ok: false,
    };
  }

  if (runtimeKind !== "typescript") {
    return { ok: true };
  }

  const runtimeUnknown = unknownField(runtimeValue, TYPESCRIPT_RUNTIME_FIELDS, [...path, runtimeKind]);
  if (runtimeUnknown !== undefined) {
    return {
      error: runtimeUnknown,
      ok: false,
    };
  }

  const entrypoint = requiredString(runtimeValue, "entrypoint", [...path, runtimeKind]);
  if (!entrypoint.ok) return { error: entrypoint.error, ok: false };
  if (entrypoint.value !== "main.ts") {
    return {
      error: error("POLICY_REJECTED", [...path, runtimeKind, "entrypoint"], "TypeScript capsule entrypoint must be main.ts."),
      ok: false,
    };
  }

  return { ok: true };
}

function readExecutionResourceLimits(
  value: PlainJson | undefined,
  path: Path,
):
  | {
      readonly ok: true;
    }
  | {
      readonly ok: false;
      readonly error: ResolveFromCatalogError;
    } {
  if (!plainObject(value)) {
    return {
      error: error("POLICY_REJECTED", path, "ExecutionManifest resourceLimits object is required."),
      ok: false,
    };
  }

  const unknown = unknownField(value, RESOURCE_LIMIT_FIELDS, path);
  if (unknown !== undefined) {
    return {
      error: unknown,
      ok: false,
    };
  }

  const cpu = requiredNumber(value, "cpuCores", path);
  if (!cpu.ok) return { error: cpu.error, ok: false };
  if (!Number.isFinite(cpu.value) || cpu.value <= 0) {
    return {
      error: error("POLICY_REJECTED", [...path, "cpuCores"], "ExecutionManifest cpuCores must be positive."),
      ok: false,
    };
  }

  const intFields = ["ramMiB", "storageMiB", "tasksMax"] as const;
  for (let index = 0; index < intFields.length; index += 1) {
    const field = intFields[index];
    if (field === undefined) continue;

    const valueResult = requiredNumber(value, field, path);
    if (!valueResult.ok) return { error: valueResult.error, ok: false };
    if (!Number.isSafeInteger(valueResult.value) || valueResult.value <= 0) {
      return {
        error: error("POLICY_REJECTED", [...path, field], "ExecutionManifest resource limit must be a positive integer."),
        ok: false,
      };
    }
  }

  return { ok: true };
}

function validateOptionalExecutionObjects(
  value: PlainJsonObject,
  path: Path,
):
  | {
      readonly ok: true;
    }
  | {
      readonly ok: false;
      readonly error: ResolveFromCatalogError;
    } {
  const keys = sortedKeys(value);
  for (let index = 0; index < keys.length; index += 1) {
    const key = keys[index];
    if (key === undefined) continue;

    const child = value[key];
    if (key === "healthChecks") {
      if (!Array.isArray(child)) {
        return {
          error: error("POLICY_REJECTED", [...path, key], "ExecutionManifest healthChecks must be an array when present."),
          ok: false,
        };
      }
    } else if (OPTIONAL_EXECUTION_OBJECT_FIELDS.has(key) && !plainObject(child)) {
      return {
        error: error("POLICY_REJECTED", [...path, key], "ExecutionManifest optional field must be an object when present."),
        ok: false,
      };
    }
  }

  return { ok: true };
}

function readCatalogInstallMetadata(
  entry: CatalogAppVersion,
  path: Path,
):
  | {
      readonly ok: true;
      readonly value: CatalogInstallMetadata;
    }
  | {
      readonly ok: false;
      readonly error: ResolveFromCatalogError;
    } {
  if (entry.entry === undefined) {
    return {
      error: error("POLICY_REJECTED", [...path, "entry"], "Catalog install entry metadata is required."),
      ok: false,
    };
  }

  if (entry.lockfile === undefined) {
    return {
      error: error("POLICY_REJECTED", [...path, "lockfile"], "Catalog lockfile metadata is required."),
      ok: false,
    };
  }

  return {
    ok: true,
    value: {
      entry: entry.entry,
      lockfile: entry.lockfile,
    },
  };
}

function verifySelectedManifest(
  manifest: ExecutionManifest,
  appId: string,
  version: string,
):
  | {
      readonly ok: true;
    }
  | {
      readonly ok: false;
      readonly error: ResolveFromCatalogError;
    } {
  if (manifest.id !== appId) {
    return {
      error: error(
        "POLICY_REJECTED",
        [CAPSULE_MANIFEST_BASENAME, "id"],
        "Resolved capsule manifest id does not match the selected catalog app.",
      ),
      ok: false,
    };
  }

  if (manifest.version !== version) {
    return {
      error: error(
        "POLICY_REJECTED",
        [CAPSULE_MANIFEST_BASENAME, "version"],
        "Resolved capsule manifest version does not match the selected catalog version.",
      ),
      ok: false,
    };
  }

  return { ok: true };
}

function requiredString(
  value: PlainJsonObject,
  key: string,
  path: Path,
):
  | {
      readonly ok: true;
      readonly value: string;
    }
  | {
      readonly ok: false;
      readonly error: ResolveFromCatalogError;
    } {
  if (!Object.hasOwn(value, key)) {
    return {
      error: error("POLICY_REJECTED", [...path, key], "Required field is missing."),
      ok: false,
    };
  }

  const child = value[key];
  if (typeof child !== "string" || child === "") {
    return {
      error: error("POLICY_REJECTED", [...path, key], "Expected non-empty string."),
      ok: false,
    };
  }

  return {
    ok: true,
    value: child,
  };
}

function requiredNumber(
  value: PlainJsonObject,
  key: string,
  path: Path,
):
  | {
      readonly ok: true;
      readonly value: number;
    }
  | {
      readonly ok: false;
      readonly error: ResolveFromCatalogError;
    } {
  if (!Object.hasOwn(value, key)) {
    return {
      error: error("POLICY_REJECTED", [...path, key], "Required field is missing."),
      ok: false,
    };
  }

  const child = value[key];
  if (typeof child !== "number") {
    return {
      error: error("POLICY_REJECTED", [...path, key], "Expected number."),
      ok: false,
    };
  }

  return {
    ok: true,
    value: child,
  };
}

function unknownField(
  value: PlainJsonObject,
  allowed: ReadonlySet<string>,
  path: Path,
): ResolveFromCatalogError | undefined {
  const keys = sortedKeys(value);
  for (let index = 0; index < keys.length; index += 1) {
    const key = keys[index];
    if (key !== undefined && !allowed.has(key)) {
      return error("POLICY_REJECTED", [...path, key], "Unknown field.");
    }
  }

  return undefined;
}

function findUnsafeObjectKey(value: PlainJson, path: Path): Path | undefined {
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      const child = value[index];
      if (child === undefined) continue;

      const found = findUnsafeObjectKey(child, [...path, String(index)]);
      if (found !== undefined) return found;
    }

    return undefined;
  }

  if (!plainObject(value)) {
    return undefined;
  }

  const keys = sortedKeys(value);
  for (let index = 0; index < keys.length; index += 1) {
    const key = keys[index];
    if (key === undefined) continue;

    if (key === "__proto__" || key === "constructor") {
      return [...path, key];
    }

    const child = value[key];
    if (child !== undefined) {
      const found = findUnsafeObjectKey(child, [...path, key]);
      if (found !== undefined) return found;
    }
  }

  return undefined;
}

function validExecutionID(value: string): boolean {
  return value.length <= 160 &&
    value === value.trim() &&
    !/[\u0000-\u001f\u007f]/u.test(value) &&
    (REVERSE_DNS_PATTERN.test(value) || OPAQUE_ID_PATTERN.test(value));
}

function validExecutionVersion(value: string): boolean {
  return value.length <= 128 &&
    value === value.trim() &&
    !/[\u0000-\u001f\u007f]/u.test(value) &&
    EXECUTION_VERSION_PATTERN.test(value);
}

function hasZstdMagic(bytes: Uint8Array): boolean {
  if (bytes.length < ZSTD_MAGIC.length) return false;

  for (let index = 0; index < ZSTD_MAGIC.length; index += 1) {
    if (bytes[index] !== ZSTD_MAGIC[index]) return false;
  }

  return true;
}

function isZeroBlock(bytes: Uint8Array): boolean {
  for (let index = 0; index < bytes.length; index += 1) {
    if (bytes[index] !== 0) return false;
  }

  return true;
}

function validTarChecksum(header: Uint8Array): boolean {
  const expected = parseTarOctal(header, TAR_CHECKSUM_OFFSET, TAR_CHECKSUM_BYTES);
  if (expected === undefined) return false;

  let actual = 0;
  for (let index = 0; index < header.length; index += 1) {
    actual += index >= TAR_CHECKSUM_OFFSET && index < TAR_CHECKSUM_OFFSET + TAR_CHECKSUM_BYTES
      ? 0x20
      : header[index] ?? 0;
  }

  return actual === expected;
}

function parseTarOctal(bytes: Uint8Array, offset: number, length: number): number | undefined {
  let value = 0;
  let seenDigit = false;

  for (let index = offset; index < offset + length; index += 1) {
    const byte = bytes[index];
    if (byte === undefined) return undefined;

    if (byte === 0 || byte === 0x20) {
      if (seenDigit) continue;
      continue;
    }

    if (byte < 0x30 || byte > 0x37) {
      return undefined;
    }

    seenDigit = true;
    value = value * 8 + (byte - 0x30);
    if (!Number.isSafeInteger(value)) {
      return undefined;
    }
  }

  return seenDigit ? value : undefined;
}

function roundUpToTarBlock(size: number): number {
  return Math.ceil(size / TAR_BLOCK_BYTES) * TAR_BLOCK_BYTES;
}

function isRegularTarEntry(header: Uint8Array): boolean {
  const type = header[TAR_TYPE_OFFSET];
  return type === 0 || type === 0x30;
}

function readTarPath(header: Uint8Array): string | undefined {
  const name = readTarString(header, 0, TAR_NAME_BYTES);
  if (name === undefined || name === "") return undefined;

  const prefix = readTarString(header, TAR_PREFIX_OFFSET, TAR_PREFIX_BYTES);
  const path = prefix === undefined || prefix === "" ? name : `${prefix}/${name}`;
  return normalizeTarPath(path);
}

function readTarString(bytes: Uint8Array, offset: number, length: number): string | undefined {
  let end = offset;
  const limit = offset + length;

  while (end < limit) {
    const byte = bytes[end];
    if (byte === undefined) return undefined;
    if (byte === 0) break;
    end += 1;
  }

  try {
    return TEXT_DECODER.decode(bytes.subarray(offset, end));
  } catch {
    return undefined;
  }
}

function normalizeTarPath(path: string): string | undefined {
  if (path === "" || path.includes("\\") || path.startsWith("/")) return undefined;

  const parts = path.split("/");
  const normalized: string[] = [];
  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index];
    if (part === undefined || part === "" || part === "..") return undefined;
    if (part !== ".") normalized[normalized.length] = part;
  }

  return normalized.length > 0 ? normalized.join("/") : undefined;
}

function basenameFromPath(path: string): string {
  const separator = path.lastIndexOf("/");
  return separator === -1 ? path : path.slice(separator + 1);
}

function inlinePackageContract(entry: PlainJson):
  | {
      readonly ok: true;
      readonly value: PackageContract;
    }
  | {
      readonly ok: false;
      readonly error: ResolveFromCatalogError;
    } {
  if (!plainObject(entry)) {
    return {
      error: error("POLICY_REJECTED", ["entry"], "Expected catalog install entry object."),
      ok: false,
    };
  }

  const candidate = catalogEntryCandidate(entry);
  const result = validateCatalogEntry(candidate);
  if (!result.ok) {
    return {
      error: error("POLICY_REJECTED", ["entry"], "Catalog install entry validation failed."),
      ok: false,
    };
  }

  if (typeof result.entry.package === "string" || "ref" in result.entry.package) {
    return {
      error: error("POLICY_REJECTED", ["entry", "package"], "Expected embedded package contract."),
      ok: false,
    };
  }

  return {
    ok: true,
    value: result.entry.package,
  };
}

function verifySelectedContract(
  contract: PackageContract,
  appId: string,
  version: string,
):
  | {
      readonly ok: true;
    }
  | {
      readonly ok: false;
      readonly error: ResolveFromCatalogError;
    } {
  if (contract.identity.id !== appId) {
    return {
      error: error(
        "POLICY_REJECTED",
        ["entry", "package", "identity", "id"],
        "Catalog install entry package id does not match the selected catalog app.",
      ),
      ok: false,
    };
  }

  if (contract.version !== version) {
    return {
      error: error(
        "POLICY_REJECTED",
        ["entry", "package", "version"],
        "Catalog install entry package version does not match the selected catalog version.",
      ),
      ok: false,
    };
  }

  return { ok: true };
}

function catalogEntryCandidate(value: PlainJsonObject): PlainJsonObject {
  const candidate = Object.create(null) as Record<string, PlainJson>;
  const keys = sortedKeys(value);

  for (let index = 0; index < keys.length; index += 1) {
    const key = keys[index];
    if (key === undefined || key === "requestedCapabilities") continue;

    const child = value[key];
    if (child !== undefined) {
      Object.defineProperty(candidate, key, {
        configurable: true,
        enumerable: true,
        value: child,
        writable: true,
      });
    }
  }

  return candidate;
}

function verifySriBytes(bytes: Uint8Array, integrity: string): boolean {
  const parsed = parseSriIntegrity(integrity);
  if (!parsed.ok) return false;

  const expected = Buffer.from(parsed.integrity.digest, "base64");
  if (expected.length !== parsed.integrity.byteLength) return false;

  const actual = createHash(parsed.integrity.algorithm).update(bytes).digest();
  return actual.length === expected.length && Buffer.compare(actual, expected) === 0;
}

function mirrorResolutionError(value: MirrorResolutionError): ResolveFromCatalogError {
  return {
    code: value.code,
    message: value.message,
    path: value.path,
  };
}

function installPlanError(value: ResolveInstallPlanError): ResolveFromCatalogError {
  return {
    code: "POLICY_REJECTED",
    message: `${value.code}: ${value.message}`,
    path: value.path,
  };
}

function snapshotInputObject(input: unknown):
  | {
      readonly ok: true;
      readonly value: Record<string, unknown>;
    }
  | {
      readonly ok: false;
      readonly reason: string;
    } {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    return {
      ok: false,
      reason: "Expected resolveFromCatalog input object.",
    };
  }

  try {
    if (nodeTypes.isProxy(input)) {
      return {
        ok: false,
        reason: "Expected plain resolveFromCatalog input object.",
      };
    }

    const prototype = Object.getPrototypeOf(input);
    if (prototype !== Object.prototype && prototype !== null) {
      return {
        ok: false,
        reason: "Expected plain resolveFromCatalog input object.",
      };
    }

    const firstKeys = Reflect.ownKeys(input);
    const secondKeys = Reflect.ownKeys(input);
    if (!sameKeys(firstKeys, secondKeys)) {
      return {
        ok: false,
        reason: "Could not safely inspect resolveFromCatalog input.",
      };
    }

    const out = Object.create(null) as Record<string, unknown>;
    for (let index = 0; index < firstKeys.length; index += 1) {
      const key = firstKeys[index];
      if (key === undefined || typeof key !== "string") {
        return {
          ok: false,
          reason: "ResolveFromCatalog input must contain only string data properties.",
        };
      }

      const value = stableData(input, key);
      if (!value.ok) {
        return {
          ok: false,
          reason: "ResolveFromCatalog input must contain only stable data properties.",
        };
      }

      Object.defineProperty(out, key, {
        configurable: true,
        enumerable: true,
        value: value.value,
        writable: true,
      });
    }

    return {
      ok: true,
      value: out,
    };
  } catch {
    return {
      ok: false,
      reason: "Could not safely inspect resolveFromCatalog input.",
    };
  }
}

function ownDataValue(value: object, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (descriptor === undefined || !Object.prototype.hasOwnProperty.call(descriptor, "value")) {
    return undefined;
  }

  return descriptor.value;
}

function stableData(value: object, key: PropertyKey):
  | {
      readonly ok: true;
      readonly value: unknown;
    }
  | {
      readonly ok: false;
    } {
  try {
    const first = Object.getOwnPropertyDescriptor(value, key);
    const second = Object.getOwnPropertyDescriptor(value, key);

    if (first === undefined || second === undefined || !("value" in first) || !("value" in second)) {
      return { ok: false };
    }

    if (!Object.is(first.value, second.value)) {
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

function sameKeys(left: readonly PropertyKey[], right: readonly PropertyKey[]): boolean {
  if (left.length !== right.length) return false;

  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return false;
  }

  return true;
}

function plainObject(value: PlainJson | undefined): value is PlainJsonObject {
  return value !== undefined && value !== null && typeof value === "object" && !Array.isArray(value);
}

function sortedKeys(value: { readonly [key: string]: unknown }): string[] {
  return Object.keys(value).sort(compareStrings);
}

function parsePath(path: string): Path {
  if (path === "") return [];

  const parts = path.split("/");
  const out: string[] = [];
  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index];
    if (part !== undefined) {
      out[out.length] = part.replaceAll("~1", "/").replaceAll("~0", "~");
    }
  }

  return out;
}

function error(
  code: ResolveFromCatalogError["code"],
  path: Path,
  message: string,
): ResolveFromCatalogError {
  return {
    code,
    message,
    path: formatPath(path),
  };
}

function reject(errors: readonly ResolveFromCatalogError[]): {
  readonly ok: false;
  readonly errors: readonly ResolveFromCatalogError[];
} {
  return {
    errors,
    ok: false,
  };
}

function formatPath(path: Path): string {
  return path.map(escapePathToken).join("/");
}

function escapePathToken(token: string): string {
  return token.replaceAll("~", "~0").replaceAll("/", "~1");
}

function compareStrings(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}
