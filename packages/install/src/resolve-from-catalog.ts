import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { isIP } from "node:net";
import { posix as posixPath } from "node:path";
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
const OCI_RUNTIME_FIELDS = new Set(["image"]);
const OCI_IMAGE_FIELDS = new Set(["digest", "entrypoint"]);
const WASM_RUNTIME_FIELDS = new Set(["module"]);
const RESOURCE_LIMIT_FIELDS = new Set(["cpuCores", "ramMiB", "storageMiB", "tasksMax"]);
const EXECUTION_DATA_FIELDS = new Set(["classes", "volumes"]);
const EXECUTION_NETWORK_FIELDS = new Set(["egress", "ingress"]);
const EXECUTION_NETWORK_INGRESS_FIELDS = new Set([
  "direction",
  "interface",
  "name",
  "port",
  "protocol",
  "public",
  "sourceCidr",
  "unsafeWideOpen",
]);
const EXECUTION_NETWORK_EGRESS_FIELDS = new Set([
  "destinations",
  "direction",
  "interface",
  "name",
  "ports",
  "protocol",
  "unsafeWideOpen",
]);
const HEALTH_CHECK_FIELDS = new Set(["intervalSeconds", "name", "target", "timeoutSeconds", "type"]);
const LIFECYCLE_POLICY_FIELDS = new Set(["onUnhealthy"]);
const VOLUME_FIELDS = new Set(["access", "backup", "class", "mountPath", "name", "persistence", "sizeMiB"]);
const EXECUTION_DATA_CLASSES = new Set([
  "app-state",
  "cache",
  "configuration",
  "logs",
  "telemetry",
  "user-content",
]);
const VOLUME_ACCESS = new Set(["read-only", "read-write"]);
const VOLUME_PERSISTENCE = new Set(["persistent"]);
const MAX_CPU_QUOTA_CORES = 64;
const MAX_MEMORY_MIB = 1024 * 1024;
const MAX_STORAGE_MIB = 1024 * 1024;
const MAX_TASKS = 16_384;
const PORT_ALL = -1;
const REVERSE_DNS_PATTERN =
  /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/u;
const OPAQUE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,159}$/u;
const EXECUTION_VERSION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9.+_-]{0,127}$/u;
const PRIVATE_KEY_PATTERN =
  /\b(?:private[-_\s]?key|openssh\s+private\s+key|age-secret-key|xprv|seed[-_\s]?phrase|mnemonic|recovery[-_\s]?phrase)\b/i;
const SECRET_ASSIGNMENT_PATTERN =
  /\b(?:private[-_\s]?key|api[-_\s]?key|access[-_\s]?token|refresh[-_\s]?token|password|secret)\s*[:=]/i;
const SEED_WORDS_PATTERN = /\b[a-z]{3,12}(?:\s+[a-z]{3,12}){11,23}\b/i;
const LONG_HEX_PATTERN = /(?:0x)?[A-Fa-f0-9]{32,}/u;
const LONG_BASE64_PATTERN = /[A-Za-z0-9+/]{48,}={0,2}|[A-Za-z0-9_-]{48,}/u;
const INLINE_REFERENCE_SCHEMES = new Set(["data", "inline", "literal"]);
const NETWORK_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/u;
const NETWORK_META_CHARACTER = /[\\'"`$;&|<>()[\]{}!*?%]/u;
const INTERFACE_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]*$/u;
const VOLUME_NAME_PATTERN = /^[a-z0-9][a-z0-9._-]{0,127}$/u;
const OCI_DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/u;
const INTEGER_LITERAL_PATTERN = /^-?(?:0|[1-9][0-9]*)$/u;

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

    const manifestMatch = verifySelectedManifest(
      artifact.value.manifest,
      request.value.appId,
      request.value.version,
      contract.value.packageClass,
    );
    if (!manifestMatch.ok) return reject([manifestMatch.error]);

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
      error: error("POLICY_REJECTED", [], "Catalog package artifact must be a zstd-compressed capsule tar."),
      ok: false,
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

      if (path === CAPSULE_MANIFEST_BASENAME) {
        if (manifest !== undefined) {
          return {
            error: error("POLICY_REJECTED", [CAPSULE_MANIFEST_BASENAME], "Capsule artifact contains ambiguous manifests."),
            ok: false,
          };
        }

        manifest = bytes.slice(dataStart, dataEnd);
      } else if (path.endsWith(`/${CAPSULE_MANIFEST_BASENAME}`)) {
        return {
          error: error("POLICY_REJECTED", [path], "Capsule artifact manifest.json must be at the capsule root."),
          ok: false,
        };
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

  const structure = scanArtifactJsonStructure(text);
  if (structure.duplicateKey !== undefined) {
    return {
      error: error("POLICY_REJECTED", path, `Capsule artifact JSON file contains duplicate object key ${structure.duplicateKey}.`),
      ok: false,
    };
  }

  if (structure.invalidIntegerPath !== undefined) {
    return {
      error: error("POLICY_REJECTED", [...path, ...structure.invalidIntegerPath], "Capsule artifact JSON integer field must use an integer literal."),
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
  invalidIntegerPath: Path | undefined;
}

function scanArtifactJsonStructure(text: string): {
  readonly duplicateKey: string | undefined;
  readonly invalidIntegerPath: Path | undefined;
} {
  const cursor: JsonKeyCursor = {
    duplicate: undefined,
    failed: false,
    index: 0,
    invalidIntegerPath: undefined,
    text,
  };

  parseJsonValue(cursor, []);
  return {
    duplicateKey: cursor.duplicate,
    invalidIntegerPath: cursor.invalidIntegerPath,
  };
}

function parseJsonValue(cursor: JsonKeyCursor, path: Path): void {
  if (cursor.duplicate !== undefined || cursor.invalidIntegerPath !== undefined || cursor.failed) return;

  skipJsonWhitespace(cursor);
  const char = cursor.text[cursor.index];

  if (char === "{") {
    parseJsonObject(cursor, path);
  } else if (char === "[") {
    parseJsonArray(cursor, path);
  } else if (char === "\"") {
    parseJsonString(cursor);
  } else if (char === "t") {
    consumeJsonLiteral(cursor, "true");
  } else if (char === "f") {
    consumeJsonLiteral(cursor, "false");
  } else if (char === "n") {
    consumeJsonLiteral(cursor, "null");
  } else {
    consumeJsonNumber(cursor, path);
  }
}

function parseJsonObject(cursor: JsonKeyCursor, path: Path): void {
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

    parseJsonValue(cursor, [...path, key]);
    if (cursor.duplicate !== undefined || cursor.invalidIntegerPath !== undefined || cursor.failed) return;

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

function parseJsonArray(cursor: JsonKeyCursor, path: Path): void {
  cursor.index += 1;
  skipJsonWhitespace(cursor);

  if (cursor.text[cursor.index] === "]") {
    cursor.index += 1;
    return;
  }

  let itemIndex = 0;
  while (cursor.index < cursor.text.length) {
    parseJsonValue(cursor, [...path, String(itemIndex)]);
    if (cursor.duplicate !== undefined || cursor.invalidIntegerPath !== undefined || cursor.failed) return;

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
    itemIndex += 1;
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

function consumeJsonNumber(cursor: JsonKeyCursor, path: Path): void {
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
    return;
  }

  const token = cursor.text.slice(start, cursor.index);
  if (integerNumberPath(path) && !INTEGER_LITERAL_PATTERN.test(token)) {
    cursor.invalidIntegerPath = path;
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

function integerNumberPath(path: Path): boolean {
  const last = path[path.length - 1];
  if (
    last === "ramMiB" ||
    last === "storageMiB" ||
    last === "tasksMax" ||
    last === "intervalSeconds" ||
    last === "timeoutSeconds" ||
    last === "sizeMiB" ||
    last === "port"
  ) {
    return true;
  }

  const parent = path[path.length - 2];
  return parent === "ports";
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

  if (runtimeKind === "typescript") {
    return readTypeScriptRuntime(runtimeValue, [...path, runtimeKind]);
  }

  if (runtimeKind === "oci") {
    return readOciRuntime(runtimeValue, [...path, runtimeKind]);
  }

  return readWasmRuntime(runtimeValue, [...path, runtimeKind]);
}

function readTypeScriptRuntime(
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
  const runtimeUnknown = unknownField(value, TYPESCRIPT_RUNTIME_FIELDS, path);
  if (runtimeUnknown !== undefined) {
    return {
      error: runtimeUnknown,
      ok: false,
    };
  }

  const entrypoint = requiredString(value, "entrypoint", path);
  if (!entrypoint.ok) return { error: entrypoint.error, ok: false };
  if (entrypoint.value !== "main.ts") {
    return {
      error: error("POLICY_REJECTED", [...path, "entrypoint"], "TypeScript capsule entrypoint must be main.ts."),
      ok: false,
    };
  }

  return { ok: true };
}

function readOciRuntime(
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
  const runtimeUnknown = unknownField(value, OCI_RUNTIME_FIELDS, path);
  if (runtimeUnknown !== undefined) {
    return {
      error: runtimeUnknown,
      ok: false,
    };
  }

  const image = value.image;
  if (!plainObject(image)) {
    return {
      error: error("POLICY_REJECTED", [...path, "image"], "OCI capsule image runtime is required."),
      ok: false,
    };
  }

  const imageUnknown = unknownField(image, OCI_IMAGE_FIELDS, [...path, "image"]);
  if (imageUnknown !== undefined) {
    return {
      error: imageUnknown,
      ok: false,
    };
  }

  const digest = requiredString(image, "digest", [...path, "image"]);
  if (!digest.ok) return { error: digest.error, ok: false };
  if (!OCI_DIGEST_PATTERN.test(digest.value)) {
    return {
      error: error("POLICY_REJECTED", [...path, "image", "digest"], "OCI capsule image digest must be sha256 lowercase hex."),
      ok: false,
    };
  }

  const entrypoint = image.entrypoint;
  if (!Array.isArray(entrypoint) || entrypoint.length === 0) {
    return {
      error: error("POLICY_REJECTED", [...path, "image", "entrypoint"], "OCI capsule image entrypoint is required."),
      ok: false,
    };
  }

  for (let index = 0; index < entrypoint.length; index += 1) {
    const item = entrypoint[index];
    if (typeof item !== "string" || !validOciArgvElement(item, index === 0)) {
      return {
        error: error("POLICY_REJECTED", [...path, "image", "entrypoint", String(index)], "OCI capsule image entrypoint item is invalid."),
        ok: false,
      };
    }
  }

  return { ok: true };
}

function readWasmRuntime(
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
  const runtimeUnknown = unknownField(value, WASM_RUNTIME_FIELDS, path);
  if (runtimeUnknown !== undefined) {
    return {
      error: runtimeUnknown,
      ok: false,
    };
  }

  const module = requiredString(value, "module", path);
  if (!module.ok) return { error: module.error, ok: false };
  if (module.value !== "component.wasm") {
    return {
      error: error("POLICY_REJECTED", [...path, "module"], "WASM capsule module must be component.wasm."),
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
  if (!Number.isFinite(cpu.value) || cpu.value <= 0 || cpu.value > MAX_CPU_QUOTA_CORES) {
    return {
      error: error("POLICY_REJECTED", [...path, "cpuCores"], "ExecutionManifest cpuCores must be positive and bounded."),
      ok: false,
    };
  }

  const intFields = ["ramMiB", "storageMiB", "tasksMax"] as const;
  for (let index = 0; index < intFields.length; index += 1) {
    const field = intFields[index];
    if (field === undefined) continue;

    const valueResult = requiredNumber(value, field, path);
    if (!valueResult.ok) return { error: valueResult.error, ok: false };
    const max = field === "tasksMax" ? MAX_TASKS : field === "ramMiB" ? MAX_MEMORY_MIB : MAX_STORAGE_MIB;
    if (!Number.isSafeInteger(valueResult.value) || valueResult.value <= 0 || valueResult.value > max) {
      return {
        error: error("POLICY_REJECTED", [...path, field], "ExecutionManifest resource limit must be a positive bounded integer."),
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
  const data = readExecutionData(value.data, [...path, "data"]);
  if (!data.ok) return { error: data.error, ok: false };

  const healthChecks = readExecutionHealthChecks(value.healthChecks, [...path, "healthChecks"]);
  if (!healthChecks.ok) return { error: healthChecks.error, ok: false };

  const network = readExecutionNetwork(value.network, [...path, "network"]);
  if (!network.ok) return { error: network.error, ok: false };

  const lifecyclePolicy = readLifecyclePolicy(value.lifecyclePolicy, [...path, "lifecyclePolicy"]);
  if (!lifecyclePolicy.ok) return { error: lifecyclePolicy.error, ok: false };

  return { ok: true };
}

function readExecutionData(
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
  if (value === undefined || value === null) {
    return { ok: true };
  }

  if (!plainObject(value)) {
    return {
      error: error("POLICY_REJECTED", path, "ExecutionManifest data must be an object when present."),
      ok: false,
    };
  }

  const unknown = unknownField(value, EXECUTION_DATA_FIELDS, path);
  if (unknown !== undefined) {
    return {
      error: unknown,
      ok: false,
    };
  }

  const classes = value.classes;
  if (!Array.isArray(classes)) {
    return {
      error: error("POLICY_REJECTED", [...path, "classes"], "ExecutionManifest data.classes is required."),
      ok: false,
    };
  }

  const seenClasses = new Map<string, number>();
  for (let index = 0; index < classes.length; index += 1) {
    const item = classes[index];
    if (typeof item !== "string" || !EXECUTION_DATA_CLASSES.has(item)) {
      return {
        error: error("POLICY_REJECTED", [...path, "classes", String(index)], "ExecutionManifest data class is unsupported."),
        ok: false,
      };
    }
    if (seenClasses.has(item)) {
      return {
        error: error("POLICY_REJECTED", [...path, "classes", String(index)], "ExecutionManifest data class is duplicated."),
        ok: false,
      };
    }
    seenClasses.set(item, index);
  }

  const volumes = value.volumes;
  if (!Array.isArray(volumes)) {
    return {
      error: error("POLICY_REJECTED", [...path, "volumes"], "ExecutionManifest data.volumes is required."),
      ok: false,
    };
  }

  if (volumes.length > 0 && seenClasses.size === 0) {
    return {
      error: error("POLICY_REJECTED", [...path, "classes"], "ExecutionManifest data.classes must declare volume classes."),
      ok: false,
    };
  }

  const seenVolumes = new Map<string, number>();
  for (let index = 0; index < volumes.length; index += 1) {
    const volume = readVolumeSpec(volumes[index], [...path, "volumes", String(index)], seenClasses);
    if (!volume.ok) return { error: volume.error, ok: false };

    if (seenVolumes.has(volume.name)) {
      return {
        error: error("POLICY_REJECTED", [...path, "volumes", String(index), "name"], "ExecutionManifest data volume name is duplicated."),
        ok: false,
      };
    }
    seenVolumes.set(volume.name, index);
  }

  return { ok: true };
}

function readVolumeSpec(
  value: PlainJson | undefined,
  path: Path,
  declaredClasses: ReadonlyMap<string, number>,
):
  | {
      readonly ok: true;
      readonly name: string;
    }
  | {
      readonly ok: false;
      readonly error: ResolveFromCatalogError;
    } {
  if (!plainObject(value)) {
    return {
      error: error("POLICY_REJECTED", path, "ExecutionManifest data volume must be an object."),
      ok: false,
    };
  }

  const unknown = unknownField(value, VOLUME_FIELDS, path);
  if (unknown !== undefined) {
    return {
      error: unknown,
      ok: false,
    };
  }

  const name = requiredString(value, "name", path);
  if (!name.ok) return { error: name.error, ok: false };
  if (!VOLUME_NAME_PATTERN.test(name.value)) {
    return {
      error: error("POLICY_REJECTED", [...path, "name"], "ExecutionManifest data volume name is invalid."),
      ok: false,
    };
  }

  const mountPath = requiredString(value, "mountPath", path);
  if (!mountPath.ok) return { error: mountPath.error, ok: false };
  if (!validAbsoluteVolumePath(mountPath.value)) {
    return {
      error: error("POLICY_REJECTED", [...path, "mountPath"], "ExecutionManifest data volume mountPath is invalid."),
      ok: false,
    };
  }

  const classValue = requiredString(value, "class", path);
  if (!classValue.ok) return { error: classValue.error, ok: false };
  if (!EXECUTION_DATA_CLASSES.has(classValue.value)) {
    return {
      error: error("POLICY_REJECTED", [...path, "class"], "ExecutionManifest data volume class is unsupported."),
      ok: false,
    };
  }
  if (declaredClasses.size > 0 && !declaredClasses.has(classValue.value)) {
    return {
      error: error("POLICY_REJECTED", [...path, "class"], "ExecutionManifest data volume class is not declared."),
      ok: false,
    };
  }

  const access = requiredString(value, "access", path);
  if (!access.ok) return { error: access.error, ok: false };
  if (!VOLUME_ACCESS.has(access.value)) {
    return {
      error: error("POLICY_REJECTED", [...path, "access"], "ExecutionManifest data volume access is unsupported."),
      ok: false,
    };
  }

  const persistence = requiredString(value, "persistence", path);
  if (!persistence.ok) return { error: persistence.error, ok: false };
  if (!VOLUME_PERSISTENCE.has(persistence.value)) {
    return {
      error: error("POLICY_REJECTED", [...path, "persistence"], "ExecutionManifest data volume persistence is unsupported."),
      ok: false,
    };
  }

  const backup = requiredBoolean(value, "backup", path);
  if (!backup.ok) return { error: backup.error, ok: false };

  const sizeMiB = requiredNumber(value, "sizeMiB", path);
  if (!sizeMiB.ok) return { error: sizeMiB.error, ok: false };
  if (!Number.isSafeInteger(sizeMiB.value) || sizeMiB.value <= 0) {
    return {
      error: error("POLICY_REJECTED", [...path, "sizeMiB"], "ExecutionManifest data volume sizeMiB must be positive."),
      ok: false,
    };
  }

  return {
    name: name.value,
    ok: true,
  };
}

function readExecutionHealthChecks(
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
  if (value === undefined || value === null) {
    return { ok: true };
  }

  if (!Array.isArray(value)) {
    return {
      error: error("POLICY_REJECTED", path, "ExecutionManifest healthChecks must be an array when present."),
      ok: false,
    };
  }

  for (let index = 0; index < value.length; index += 1) {
    const check = readHealthCheck(value[index], [...path, String(index)]);
    if (!check.ok) return { error: check.error, ok: false };
  }

  return { ok: true };
}

function readHealthCheck(
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
      error: error("POLICY_REJECTED", path, "ExecutionManifest health check must be an object."),
      ok: false,
    };
  }

  const unknown = unknownField(value, HEALTH_CHECK_FIELDS, path);
  if (unknown !== undefined) {
    return {
      error: unknown,
      ok: false,
    };
  }

  const name = requiredString(value, "name", path);
  if (!name.ok) return { error: name.error, ok: false };
  if (!validCheckName(name.value)) {
    return {
      error: error("POLICY_REJECTED", [...path, "name"], "ExecutionManifest health check name is invalid."),
      ok: false,
    };
  }

  const type = requiredString(value, "type", path);
  if (!type.ok) return { error: type.error, ok: false };

  const target = requiredString(value, "target", path);
  if (!target.ok) return { error: target.error, ok: false };

  if (!validHealthTarget(type.value, target.value)) {
    return {
      error: error("POLICY_REJECTED", [...path, "target"], "ExecutionManifest health check target is invalid."),
      ok: false,
    };
  }

  const interval = requiredNumber(value, "intervalSeconds", path);
  if (!interval.ok) return { error: interval.error, ok: false };
  if (!Number.isSafeInteger(interval.value) || interval.value <= 0) {
    return {
      error: error("POLICY_REJECTED", [...path, "intervalSeconds"], "ExecutionManifest health check intervalSeconds must be positive."),
      ok: false,
    };
  }

  const timeout = requiredNumber(value, "timeoutSeconds", path);
  if (!timeout.ok) return { error: timeout.error, ok: false };
  if (!Number.isSafeInteger(timeout.value) || timeout.value <= 0) {
    return {
      error: error("POLICY_REJECTED", [...path, "timeoutSeconds"], "ExecutionManifest health check timeoutSeconds must be positive."),
      ok: false,
    };
  }

  return { ok: true };
}

function readExecutionNetwork(
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
  if (value === undefined || value === null) {
    return { ok: true };
  }

  if (!plainObject(value)) {
    return {
      error: error("POLICY_REJECTED", path, "ExecutionManifest network must be an object when present."),
      ok: false,
    };
  }

  const unknown = unknownField(value, EXECUTION_NETWORK_FIELDS, path);
  if (unknown !== undefined) {
    return {
      error: unknown,
      ok: false,
    };
  }

  const ingress = value.ingress;
  if (!Array.isArray(ingress)) {
    return {
      error: error("POLICY_REJECTED", [...path, "ingress"], "ExecutionManifest network.ingress is required."),
      ok: false,
    };
  }

  for (let index = 0; index < ingress.length; index += 1) {
    const rule = readNetworkIngressRule(ingress[index], [...path, "ingress", String(index)]);
    if (!rule.ok) return { error: rule.error, ok: false };
  }

  const egress = value.egress;
  if (!Array.isArray(egress)) {
    return {
      error: error("POLICY_REJECTED", [...path, "egress"], "ExecutionManifest network.egress is required."),
      ok: false,
    };
  }

  for (let index = 0; index < egress.length; index += 1) {
    const rule = readNetworkEgressRule(egress[index], [...path, "egress", String(index)]);
    if (!rule.ok) return { error: rule.error, ok: false };
  }

  return { ok: true };
}

function readNetworkIngressRule(
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
      error: error("POLICY_REJECTED", path, "ExecutionManifest network ingress rule must be an object."),
      ok: false,
    };
  }

  const unknown = unknownField(value, EXECUTION_NETWORK_INGRESS_FIELDS, path);
  if (unknown !== undefined) {
    return {
      error: unknown,
      ok: false,
    };
  }

  const direction = optionalString(value, "direction");
  if (direction !== undefined && direction !== "ingress") {
    return {
      error: error("POLICY_REJECTED", [...path, "direction"], "ExecutionManifest network ingress direction must be ingress."),
      ok: false,
    };
  }

  const name = optionalString(value, "name");
  if (name !== undefined && !validExecutionNetworkName(name)) {
    return {
      error: error("POLICY_REJECTED", [...path, "name"], "ExecutionManifest network ingress name is invalid."),
      ok: false,
    };
  }

  const protocol = requiredString(value, "protocol", path);
  if (!protocol.ok) return { error: protocol.error, ok: false };
  if (!validNetworkProtocol(protocol.value)) {
    return {
      error: error("POLICY_REJECTED", [...path, "protocol"], "ExecutionManifest network protocol must be tcp or udp."),
      ok: false,
    };
  }

  const port = requiredNumber(value, "port", path);
  if (!port.ok) return { error: port.error, ok: false };
  if (!Number.isSafeInteger(port.value) || !validNetworkPort(port.value)) {
    return {
      error: error("POLICY_REJECTED", [...path, "port"], "ExecutionManifest network port is invalid."),
      ok: false,
    };
  }

  const source = requiredString(value, "sourceCidr", path);
  if (!source.ok) return { error: source.error, ok: false };
  const sourcePrefix = parseCidrPrefix(source.value);
  if (sourcePrefix === undefined) {
    return {
      error: error("POLICY_REJECTED", [...path, "sourceCidr"], "ExecutionManifest network sourceCidr is invalid."),
      ok: false,
    };
  }

  const iface = requiredString(value, "interface", path);
  if (!iface.ok) return { error: iface.error, ok: false };
  if (!validExecutionNetworkInterface(iface.value)) {
    return {
      error: error("POLICY_REJECTED", [...path, "interface"], "ExecutionManifest network interface is invalid."),
      ok: false,
    };
  }

  const publicValue = requiredBoolean(value, "public", path);
  if (!publicValue.ok) return { error: publicValue.error, ok: false };

  const unsafeWideOpen = optionalBoolean(value, "unsafeWideOpen", path);
  if (!unsafeWideOpen.ok) return { error: unsafeWideOpen.error, ok: false };

  if (sourceCoversAll(sourcePrefix) && !unsafeWideOpen.value) {
    return {
      error: error("POLICY_REJECTED", [...path, "sourceCidr"], "ExecutionManifest network ingress opens all sources without unsafeWideOpen."),
      ok: false,
    };
  }

  return { ok: true };
}

function readNetworkEgressRule(
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
      error: error("POLICY_REJECTED", path, "ExecutionManifest network egress rule must be an object."),
      ok: false,
    };
  }

  const unknown = unknownField(value, EXECUTION_NETWORK_EGRESS_FIELDS, path);
  if (unknown !== undefined) {
    return {
      error: unknown,
      ok: false,
    };
  }

  const direction = optionalString(value, "direction");
  if (direction !== undefined && direction !== "egress") {
    return {
      error: error("POLICY_REJECTED", [...path, "direction"], "ExecutionManifest network egress direction must be egress."),
      ok: false,
    };
  }

  const name = optionalString(value, "name");
  if (name !== undefined && !validExecutionNetworkName(name)) {
    return {
      error: error("POLICY_REJECTED", [...path, "name"], "ExecutionManifest network egress name is invalid."),
      ok: false,
    };
  }

  const protocol = requiredString(value, "protocol", path);
  if (!protocol.ok) return { error: protocol.error, ok: false };
  if (!validNetworkProtocol(protocol.value)) {
    return {
      error: error("POLICY_REJECTED", [...path, "protocol"], "ExecutionManifest network protocol must be tcp or udp."),
      ok: false,
    };
  }

  const destinations = value.destinations;
  if (!Array.isArray(destinations) || destinations.length === 0) {
    return {
      error: error("POLICY_REJECTED", [...path, "destinations"], "ExecutionManifest network egress destinations must not be empty."),
      ok: false,
    };
  }

  const unsafeWideOpen = optionalBoolean(value, "unsafeWideOpen", path);
  if (!unsafeWideOpen.ok) return { error: unsafeWideOpen.error, ok: false };

  for (let index = 0; index < destinations.length; index += 1) {
    const destination = destinations[index];
    if (typeof destination !== "string") {
      return {
        error: error("POLICY_REJECTED", [...path, "destinations", String(index)], "ExecutionManifest network destination must be a string."),
        ok: false,
      };
    }

    const prefix = parseNetworkDestination(destination);
    if (prefix === undefined) {
      return {
        error: error("POLICY_REJECTED", [...path, "destinations", String(index)], "ExecutionManifest network destination is invalid."),
        ok: false,
      };
    }

    if (sourceCoversAll(prefix) && !unsafeWideOpen.value) {
      return {
        error: error("POLICY_REJECTED", [...path, "destinations", String(index)], "ExecutionManifest network egress opens all destinations without unsafeWideOpen."),
        ok: false,
      };
    }
  }

  const ports = value.ports;
  if (!Array.isArray(ports) || ports.length === 0) {
    return {
      error: error("POLICY_REJECTED", [...path, "ports"], "ExecutionManifest network egress ports must not be empty."),
      ok: false,
    };
  }

  for (let index = 0; index < ports.length; index += 1) {
    const port = ports[index];
    if (typeof port !== "number" || !Number.isSafeInteger(port) || !validNetworkPort(port)) {
      return {
        error: error("POLICY_REJECTED", [...path, "ports", String(index)], "ExecutionManifest network egress port is invalid."),
        ok: false,
      };
    }
  }

  const iface = requiredString(value, "interface", path);
  if (!iface.ok) return { error: iface.error, ok: false };
  if (!validExecutionNetworkInterface(iface.value)) {
    return {
      error: error("POLICY_REJECTED", [...path, "interface"], "ExecutionManifest network interface is invalid."),
      ok: false,
    };
  }

  return { ok: true };
}

function readLifecyclePolicy(
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
  if (value === undefined || value === null) {
    return { ok: true };
  }

  if (!plainObject(value)) {
    return {
      error: error("POLICY_REJECTED", path, "ExecutionManifest lifecyclePolicy must be an object when present."),
      ok: false,
    };
  }

  const unknown = unknownField(value, LIFECYCLE_POLICY_FIELDS, path);
  if (unknown !== undefined) {
    return {
      error: unknown,
      ok: false,
    };
  }

  if (!Object.hasOwn(value, "onUnhealthy")) {
    return { ok: true };
  }

  const onUnhealthy = value.onUnhealthy;
  if (onUnhealthy !== "fail" && onUnhealthy !== "restart") {
    return {
      error: error("POLICY_REJECTED", [...path, "onUnhealthy"], "ExecutionManifest lifecyclePolicy.onUnhealthy must be restart or fail."),
      ok: false,
    };
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
  packageClass: PackageContract["packageClass"],
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

  if (manifest.packageClass !== packageClass) {
    return {
      error: error(
        "POLICY_REJECTED",
        [CAPSULE_MANIFEST_BASENAME, "packageClass"],
        "Resolved capsule manifest packageClass does not match the selected catalog package contract.",
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

function requiredBoolean(
  value: PlainJsonObject,
  key: string,
  path: Path,
):
  | {
      readonly ok: true;
      readonly value: boolean;
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
  if (typeof child !== "boolean") {
    return {
      error: error("POLICY_REJECTED", [...path, key], "Expected boolean."),
      ok: false,
    };
  }

  return {
    ok: true,
    value: child,
  };
}

function optionalString(value: PlainJsonObject, key: string): string | undefined {
  const child = value[key];
  return typeof child === "string" ? child : undefined;
}

function optionalBoolean(
  value: PlainJsonObject,
  key: string,
  path: Path,
):
  | {
      readonly ok: true;
      readonly value: boolean;
    }
  | {
      readonly ok: false;
      readonly error: ResolveFromCatalogError;
    } {
  if (!Object.hasOwn(value, key)) {
    return {
      ok: true,
      value: false,
    };
  }

  const child = value[key];
  if (typeof child !== "boolean") {
    return {
      error: error("POLICY_REJECTED", [...path, key], "Expected boolean."),
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

function validOciArgvElement(value: string, entrypoint: boolean): boolean {
  if (value === "" || /[\u0000-\u001f\u007f]/u.test(value) || !safeOciArgvToken(value)) {
    return false;
  }

  if (!entrypoint) {
    return true;
  }

  return posixPath.isAbsolute(value) && value !== "/" && posixPath.normalize(value) === value;
}

function safeOciArgvToken(value: string): boolean {
  for (const char of value) {
    if (
      (char >= "A" && char <= "Z") ||
      (char >= "a" && char <= "z") ||
      (char >= "0" && char <= "9") ||
      "/._-:=+,".includes(char)
    ) {
      continue;
    }

    return false;
  }

  return true;
}

function validAbsoluteVolumePath(value: string): boolean {
  return value !== "" &&
    value.startsWith("/") &&
    !value.includes("\0") &&
    !value.includes("\\") &&
    value !== "/" &&
    posixPath.normalize(value) === value &&
    !value.includes("/../") &&
    !value.endsWith("/..");
}

function validCheckName(value: string): boolean {
  if (value === "" || value.length > 128 || value !== value.trim() || /[\u0000-\u001f\u007f]/u.test(value)) {
    return false;
  }

  for (const char of value) {
    if (
      (char >= "A" && char <= "Z") ||
      (char >= "a" && char <= "z") ||
      (char >= "0" && char <= "9") ||
      char === "." ||
      char === "_" ||
      char === "-"
    ) {
      continue;
    }

    return false;
  }

  return true;
}

function validHealthTarget(type: string, target: string): boolean {
  if (type === "http") {
    return validHttpHealthTarget(target);
  }

  if (type === "tcp") {
    return validTcpHealthTarget(target);
  }

  if (type === "lifecycle") {
    return target === "self" || target === "unit" || validLifecycleTarget(target);
  }

  return false;
}

function validHttpHealthTarget(target: string): boolean {
  if (!validTargetString(target)) return false;

  try {
    const parsed = new URL(target);
    return (parsed.protocol === "http:" || parsed.protocol === "https:") &&
      parsed.host !== "" &&
      isLoopbackHost(parsed.hostname);
  } catch {
    return false;
  }
}

function validTcpHealthTarget(target: string): boolean {
  if (!validTargetString(target)) return false;

  try {
    const parsed = new URL(`tcp://${target}`);
    return parsed.hostname !== "" && parsed.port !== "" && isLoopbackHost(parsed.hostname);
  } catch {
    return false;
  }
}

function validLifecycleTarget(target: string): boolean {
  if (
    !validTargetString(target) ||
    target.includes("/") ||
    target.includes("\\") ||
    target.startsWith(".") ||
    target.includes("..") ||
    !target.endsWith(".service")
  ) {
    return false;
  }

  for (const char of target) {
    if (
      (char >= "A" && char <= "Z") ||
      (char >= "a" && char <= "z") ||
      (char >= "0" && char <= "9") ||
      char === ":" ||
      char === "." ||
      char === "_" ||
      char === "@" ||
      char === "-"
    ) {
      continue;
    }

    return false;
  }

  return true;
}

function validTargetString(value: string): boolean {
  return value !== "" &&
    value.length <= 2048 &&
    value === value.trim() &&
    !/[\u0000-\u001f\u007f]/u.test(value);
}

function validNetworkProtocol(value: string): boolean {
  return value === "tcp" || value === "udp";
}

function validNetworkPort(value: number): boolean {
  return value === PORT_ALL || (value > 0 && value <= 65_535);
}

function validExecutionNetworkName(value: string): boolean {
  return safeExecutionNetworkString(value) && NETWORK_NAME_PATTERN.test(value);
}

function validExecutionNetworkInterface(value: string): boolean {
  return safeExecutionNetworkString(value) &&
    value.length <= 15 &&
    INTERFACE_NAME_PATTERN.test(value);
}

function safeExecutionNetworkString(value: string): boolean {
  return value !== "" &&
    value === value.trim() &&
    !/[\u0000-\u001f\u007f]/u.test(value) &&
    !NETWORK_META_CHARACTER.test(value) &&
    !containsInlineCapsuleMaterial(value) &&
    !hasInlineReferenceScheme(value);
}

interface ParsedNetworkPrefix {
  readonly family: 4 | 6;
  readonly address: string;
  readonly bits: number;
  readonly ipv4: number | undefined;
}

function parseNetworkDestination(value: string): ParsedNetworkPrefix | undefined {
  if (!safeExecutionNetworkString(value)) return undefined;
  if (value.includes("/")) return parseCidrPrefix(value);

  const address = parseIpAddress(value);
  if (address === undefined) return undefined;

  return {
    address: value,
    bits: address.family === 4 ? 32 : 128,
    family: address.family,
    ipv4: address.ipv4,
  };
}

function parseCidrPrefix(value: string): ParsedNetworkPrefix | undefined {
  if (!safeExecutionNetworkString(value)) return undefined;

  const slash = value.indexOf("/");
  if (slash <= 0 || value.indexOf("/", slash + 1) !== -1) return undefined;

  const addressValue = value.slice(0, slash);
  const bitsValue = value.slice(slash + 1);
  if (!/^(?:0|[1-9][0-9]*)$/u.test(bitsValue)) return undefined;

  const address = parseIpAddress(addressValue);
  if (address === undefined) return undefined;

  const bits = Number(bitsValue);
  const maxBits = address.family === 4 ? 32 : 128;
  if (!Number.isSafeInteger(bits) || bits < 0 || bits > maxBits) return undefined;

  if (address.family === 4 && address.ipv4 !== undefined) {
    const hostBits = 32 - bits;
    const mask = hostBits === 32 ? 0 : (0xffffffff << hostBits) >>> 0;
    if (((address.ipv4 & mask) >>> 0) !== address.ipv4) return undefined;
  }

  return {
    address: addressValue,
    bits,
    family: address.family,
    ipv4: address.ipv4,
  };
}

function parseIpAddress(value: string): ParsedNetworkPrefix | undefined {
  const family = isIP(value);
  if (family === 4) {
    const parsed = parseIpv4(value);
    if (parsed === undefined) return undefined;
    return {
      address: value,
      bits: 32,
      family,
      ipv4: parsed,
    };
  }

  if (family === 6) {
    return {
      address: value,
      bits: 128,
      family,
      ipv4: undefined,
    };
  }

  return undefined;
}

function parseIpv4(value: string): number | undefined {
  const parts = value.split(".");
  if (parts.length !== 4) return undefined;

  let out = 0;
  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index];
    if (part === undefined || !/^(?:0|[1-9][0-9]{0,2})$/u.test(part)) return undefined;

    const octet = Number(part);
    if (!Number.isInteger(octet) || octet < 0 || octet > 255) return undefined;
    out = (out << 8) | octet;
  }

  return out >>> 0;
}

function sourceCoversAll(prefix: ParsedNetworkPrefix): boolean {
  if (prefix.bits !== 0) return false;
  if (prefix.family === 4) return prefix.ipv4 === 0;
  return prefix.address === "::" || prefix.address === "0:0:0:0:0:0:0:0";
}

function isLoopbackHost(host: string): boolean {
  const normalized = host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
  if (normalized === "localhost") return false;

  const parsed = parseIpAddress(normalized);
  if (parsed === undefined) return false;

  if (parsed.family === 4 && parsed.ipv4 !== undefined) {
    return (parsed.ipv4 & 0xff000000) === 0x7f000000;
  }

  return normalized === "::1" || normalized === "0:0:0:0:0:0:0:1";
}

function validExecutionID(value: string): boolean {
  return value.length <= 255 &&
    value === value.trim() &&
    !/[\u0000-\u001f\u007f]/u.test(value) &&
    !containsInlineCapsuleMaterial(value) &&
    !hasInlineReferenceScheme(value) &&
    (REVERSE_DNS_PATTERN.test(value) || OPAQUE_ID_PATTERN.test(value));
}

function validExecutionVersion(value: string): boolean {
  return value.length <= 128 &&
    value === value.trim() &&
    !/[\u0000-\u001f\u007f]/u.test(value) &&
    !containsInlineCapsuleMaterial(value) &&
    !hasInlineReferenceScheme(value) &&
    EXECUTION_VERSION_PATTERN.test(value);
}

function hasInlineReferenceScheme(value: string): boolean {
  const colon = value.indexOf(":");
  if (colon <= 0) return false;

  return INLINE_REFERENCE_SCHEMES.has(value.slice(0, colon).toLowerCase());
}

function containsInlineCapsuleMaterial(value: string): boolean {
  if (
    value.toUpperCase().includes("-----BEGIN") ||
    PRIVATE_KEY_PATTERN.test(value) ||
    SECRET_ASSIGNMENT_PATTERN.test(value) ||
    SEED_WORDS_PATTERN.test(value)
  ) {
    return true;
  }

  return LONG_HEX_PATTERN.test(value) || LONG_BASE64_PATTERN.test(value);
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
