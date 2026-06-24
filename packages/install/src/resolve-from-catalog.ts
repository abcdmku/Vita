import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { TextDecoder } from "node:util";

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
  readonly entry: PlainJson;
  readonly lockfile: PlainJson;
}

type Path = readonly string[];

const TEXT_DECODER = new TextDecoder("utf-8", { fatal: true });
const INPUT_FIELDS = new Set(["catalog", "trustedKeys", "appId", "version", "mirrorStore"]);
const ARTIFACT_FIELDS = new Set(["entry", "lockfile"]);

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

    const mirrorResult = resolveFromMirror(artifact.value.lockfile, request.value.mirrorStore);
    if (!mirrorResult.ok) {
      return reject(mirrorResult.errors.map(mirrorResolutionError));
    }

    const installPlan = resolveInstallPlan(artifact.value.entry, artifact.value.lockfile);
    if (!installPlan.ok) {
      return reject(installPlan.errors.map(installPlanError));
    }

    const contract = inlinePackageContract(artifact.value.entry);
    if (!contract.ok) return reject([contract.error]);

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

  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return {
      error: error("POLICY_REJECTED", ["mirrorStore"], "Expected mirror store object."),
      ok: false,
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
  let parsed: unknown;

  try {
    parsed = JSON.parse(TEXT_DECODER.decode(bytes));
  } catch {
    return {
      error: error("POLICY_REJECTED", [], "Catalog package artifact must be UTF-8 JSON."),
      ok: false,
    };
  }

  const normalized = safeNormalize(parsed, { maxDepth: 128, maxNodes: 100_000 });
  if (!normalized.ok) {
    return {
      error: error("POLICY_REJECTED", [], `Catalog package artifact could not be safely normalized: ${normalized.reason}`),
      ok: false,
    };
  }

  if (!plainObject(normalized.value)) {
    return {
      error: error("POLICY_REJECTED", [], "Expected catalog package artifact object."),
      ok: false,
    };
  }

  const keys = sortedKeys(normalized.value);
  for (let index = 0; index < keys.length; index += 1) {
    const key = keys[index];
    if (key !== undefined && !ARTIFACT_FIELDS.has(key)) {
      return {
        error: error("POLICY_REJECTED", [key], "Unknown catalog package artifact field."),
        ok: false,
      };
    }
  }

  if (!Object.hasOwn(normalized.value, "entry")) {
    return {
      error: error("POLICY_REJECTED", ["entry"], "Catalog package artifact entry is required."),
      ok: false,
    };
  }

  if (!Object.hasOwn(normalized.value, "lockfile")) {
    return {
      error: error("POLICY_REJECTED", ["lockfile"], "Catalog package artifact lockfile is required."),
      ok: false,
    };
  }

  const entry = normalized.value.entry;
  const lockfile = normalized.value.lockfile;

  if (entry === undefined || lockfile === undefined) {
    return {
      error: error("POLICY_REJECTED", [], "Catalog package artifact validation failed closed."),
      ok: false,
    };
  }

  return {
    ok: true,
    value: {
      entry,
      lockfile,
    },
  };
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
      error: error("POLICY_REJECTED", ["entry"], "Expected catalog entry object."),
      ok: false,
    };
  }

  const candidate = catalogEntryCandidate(entry);
  const result = validateCatalogEntry(candidate);
  if (!result.ok) {
    return {
      error: error("POLICY_REJECTED", ["entry"], "Catalog entry validation failed after install plan resolution."),
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

function catalogEntryCandidate(value: PlainJsonObject): PlainJsonObject {
  const candidate: Record<string, PlainJson> = {};
  const keys = sortedKeys(value);

  for (let index = 0; index < keys.length; index += 1) {
    const key = keys[index];
    if (key === undefined || key === "requestedCapabilities") continue;

    const child = value[key];
    if (child !== undefined) {
      candidate[key] = child;
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
