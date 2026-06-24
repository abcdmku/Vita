import { createPublicKey, verify as verifyEd25519 } from "node:crypto";

import { isSriIntegrity } from "../../../sdk/typescript/src/sri.ts";
import { safeNormalize } from "../../../sdk/typescript/src/safe-normalize.ts";
import type { PlainJson, PlainJsonObject } from "../../../sdk/typescript/src/safe-normalize.ts";
import { canonicalizeCatalogBytes } from "./catalog-canonical.ts";
import { validateCatalogEntry } from "./catalog-entry.ts";

export type CatalogRiskClass = "R0" | "R1" | "R2" | "R3" | "R4";

export interface CatalogAppVersion {
  readonly version: string;
  readonly packageRef: string;
  readonly integrity: string;
  readonly riskSummary: CatalogRiskClass;
  readonly grantsSummary: readonly string[];
}

export interface CatalogApp {
  readonly id: string;
  readonly versions: readonly CatalogAppVersion[];
}

export interface CatalogPayload {
  readonly schemaVersion: string;
  readonly catalogVersion: string;
  readonly generatedAt: string;
  readonly apps: readonly CatalogApp[];
}

export interface CatalogSignature {
  readonly algorithm: "ed25519";
  readonly keyId: string;
  readonly value: string;
}

export interface SignedCatalogManifest {
  readonly catalog: CatalogPayload;
  readonly signature: CatalogSignature;
}

export interface CatalogVerificationError {
  readonly path: string;
  readonly message: string;
}

export type CatalogVerificationResult =
  | {
      readonly ok: true;
      readonly catalog: CatalogPayload;
    }
  | {
      readonly ok: false;
      readonly errors: readonly CatalogVerificationError[];
    };

export type TrustedCatalogKeys = Readonly<Record<string, string>>;

type Path = readonly string[];

const TOP_LEVEL_FIELDS = new Set(["catalog", "signature"]);
const CATALOG_FIELDS = new Set(["schemaVersion", "catalogVersion", "generatedAt", "apps"]);
const SIGNATURE_FIELDS = new Set(["algorithm", "keyId", "value"]);
const APP_FIELDS = new Set(["id", "versions"]);
const VERSION_FIELDS = new Set([
  "version",
  "packageRef",
  "integrity",
  "riskSummary",
  "grantsSummary",
]);
const RISK_CLASSES = new Set(["R0", "R1", "R2", "R3", "R4"]);

const REFERENCE_PROBE_ENTRY = Object.freeze({
  digest: Object.freeze({
    algorithm: "sha256",
    value: "0000000000000000000000000000000000000000000000000000000000000000",
  }),
  endOfSupport: "2099-12-31",
  sbom: Object.freeze({
    digest: Object.freeze({
      algorithm: "sha256",
      value: "1111111111111111111111111111111111111111111111111111111111111111",
    }),
    format: "spdx-json",
    generatedAt: "2099-01-01T00:00:00.000Z",
    ref: "sbom://vita/catalog-reference-probe/spdx",
  }),
  signatures: Object.freeze([
    Object.freeze({
      algorithm: "ed25519",
      ref: "signature://vita/catalog-reference-probe",
    }),
  ]),
  signingPublisher: Object.freeze({
    id: "vita.catalog-reference-probe",
    signingKeyRef: "publisher-key://vita/catalog-reference-probe",
  }),
  trustTier: "community",
  vulnerabilityStatus: Object.freeze({
    critical: 0,
    high: 0,
    low: 0,
    medium: 0,
    scannedAt: "2099-01-01T00:00:00.000Z",
    status: "scan-pending",
  }),
});

export function verifyCatalog(
  value: unknown,
  trustedKeys: TrustedCatalogKeys,
): CatalogVerificationResult {
  const errors: CatalogVerificationError[] = [];

  try {
    const normalizedKeys = normalizeTrustedKeys(trustedKeys, errors);
    const normalizedManifest = normalizeManifest(value, errors);

    if (normalizedKeys === undefined || normalizedManifest === undefined) {
      return reject(errors);
    }

    const manifest = readSignedCatalog(normalizedManifest, errors);

    if (manifest === undefined) {
      return reject(errors);
    }

    const catalogBytes = canonicalizeCatalogBytes(manifest.catalog);
    const publicKey = readTrustedPublicKey(normalizedKeys, manifest.signature.keyId);

    if (publicKey === undefined) {
      addError(errors, ["signature", "keyId"], "Catalog signing key is not trusted.");
      return reject(errors);
    }

    if (!verifySignature(catalogBytes, publicKey, manifest.signature.value)) {
      addError(errors, ["signature", "value"], "Catalog signature verification failed.");
      return reject(errors);
    }

    validateCatalogIntegrities(manifest.catalog, errors);

    if (errors.length > 0) {
      return reject(errors);
    }

    return {
      catalog: manifest.catalog,
      ok: true,
    };
  } catch {
    return reject([
      {
        message: "Catalog verification failed closed.",
        path: "",
      },
    ]);
  }
}

function normalizeManifest(
  value: unknown,
  errors: CatalogVerificationError[],
): PlainJsonObject | undefined {
  const normalized = safeNormalize(value, { maxDepth: 128, maxNodes: 100_000 });

  if (!normalized.ok) {
    addError(errors, [], `Catalog could not be safely normalized: ${normalized.reason}`);
    return undefined;
  }

  if (!plainObject(normalized.value)) {
    addError(errors, [], "Expected signed catalog object.");
    return undefined;
  }

  return normalized.value;
}

function normalizeTrustedKeys(
  value: TrustedCatalogKeys,
  errors: CatalogVerificationError[],
): Readonly<Record<string, string>> | undefined {
  const normalized = safeNormalize(value, { maxDepth: 8, maxNodes: 10_000 });

  if (!normalized.ok) {
    addError(errors, ["trustedKeys"], `Trusted keys could not be safely normalized: ${normalized.reason}`);
    return undefined;
  }

  if (!plainObject(normalized.value)) {
    addError(errors, ["trustedKeys"], "Expected trusted keys object.");
    return undefined;
  }

  const keys = Object.create(null) as Record<string, string>;
  const trustedKeyIds = sortedKeys(normalized.value);

  for (let index = 0; index < trustedKeyIds.length; index += 1) {
    const keyId = trustedKeyIds[index];

    if (keyId === undefined) {
      continue;
    }

    const publicKey = normalized.value[keyId];

    if (typeof publicKey !== "string" || publicKey === "") {
      addError(errors, ["trustedKeys", keyId], "Expected non-empty public key string.");
      continue;
    }

    Object.defineProperty(keys, keyId, {
      configurable: true,
      enumerable: true,
      value: publicKey,
      writable: true,
    });
  }

  if (errors.length > 0) {
    return undefined;
  }

  return Object.freeze(keys);
}

function readSignedCatalog(
  value: PlainJsonObject,
  errors: CatalogVerificationError[],
): SignedCatalogManifest | undefined {
  const errorStart = errors.length;

  rejectUnknownFields(value, TOP_LEVEL_FIELDS, [], errors);

  const catalogValue = value.catalog;
  const signatureValue = value.signature;
  let catalogObject: PlainJsonObject | undefined;
  let signatureObject: PlainJsonObject | undefined;

  if (!plainObject(catalogValue)) {
    addError(errors, ["catalog"], "Expected catalog object.");
  } else {
    catalogObject = catalogValue;
  }

  if (!plainObject(signatureValue)) {
    addError(errors, ["signature"], "Expected catalog signature object.");
  } else {
    signatureObject = signatureValue;
  }

  if (errors.length !== errorStart) {
    return undefined;
  }

  const catalog = readCatalogPayload(catalogObject, ["catalog"], errors);
  const signature = readCatalogSignature(signatureObject, ["signature"], errors);

  if (errors.length !== errorStart || catalog === undefined || signature === undefined) {
    return undefined;
  }

  return Object.freeze({
    catalog,
    signature,
  });
}

function readCatalogPayload(
  value: PlainJsonObject | undefined,
  path: Path,
  errors: CatalogVerificationError[],
): CatalogPayload | undefined {
  if (value === undefined) {
    return undefined;
  }

  const errorStart = errors.length;

  rejectUnknownFields(value, CATALOG_FIELDS, path, errors);
  const schemaVersion = readRequiredString(value, "schemaVersion", [...path, "schemaVersion"], errors);
  const catalogVersion = readRequiredString(value, "catalogVersion", [...path, "catalogVersion"], errors);
  const generatedAt = readRequiredDateTime(value, "generatedAt", [...path, "generatedAt"], errors);
  const apps = readCatalogApps(value.apps, [...path, "apps"], errors);

  if (
    errors.length !== errorStart ||
    schemaVersion === undefined ||
    catalogVersion === undefined ||
    generatedAt === undefined ||
    apps === undefined
  ) {
    return undefined;
  }

  return Object.freeze({
    apps,
    catalogVersion,
    generatedAt,
    schemaVersion,
  });
}

function readCatalogSignature(
  value: PlainJsonObject | undefined,
  path: Path,
  errors: CatalogVerificationError[],
): CatalogSignature | undefined {
  if (value === undefined) {
    return undefined;
  }

  const errorStart = errors.length;

  rejectUnknownFields(value, SIGNATURE_FIELDS, path, errors);
  const algorithm = readRequiredString(value, "algorithm", [...path, "algorithm"], errors);
  const keyId = readRequiredString(value, "keyId", [...path, "keyId"], errors);
  const signatureValue = readRequiredString(value, "value", [...path, "value"], errors);

  if (algorithm !== undefined && algorithm !== "ed25519") {
    addError(errors, [...path, "algorithm"], "Expected ed25519 signature algorithm.");
  }

  if (errors.length !== errorStart || keyId === undefined || signatureValue === undefined) {
    return undefined;
  }

  return Object.freeze({
    algorithm: "ed25519",
    keyId,
    value: signatureValue,
  });
}

function readCatalogApps(
  value: PlainJson | undefined,
  path: Path,
  errors: CatalogVerificationError[],
): readonly CatalogApp[] | undefined {
  if (!Array.isArray(value)) {
    addError(errors, path, "Expected apps array.");
    return undefined;
  }

  const apps: CatalogApp[] = [];

  for (let index = 0; index < value.length; index += 1) {
    const item = value[index];

    if (!plainObject(item)) {
      addError(errors, [...path, String(index)], "Expected app object.");
      continue;
    }

    const app = readCatalogApp(item, [...path, String(index)], errors);

    if (app !== undefined) {
      apps[apps.length] = app;
    }
  }

  if (errors.length > 0) {
    return undefined;
  }

  return Object.freeze(apps);
}

function readCatalogApp(
  value: PlainJsonObject,
  path: Path,
  errors: CatalogVerificationError[],
): CatalogApp | undefined {
  const errorStart = errors.length;

  rejectUnknownFields(value, APP_FIELDS, path, errors);
  const id = readRequiredString(value, "id", [...path, "id"], errors);
  const versions = readCatalogAppVersions(value.versions, [...path, "versions"], errors);

  if (errors.length !== errorStart || id === undefined || versions === undefined) {
    return undefined;
  }

  return Object.freeze({
    id,
    versions,
  });
}

function readCatalogAppVersions(
  value: PlainJson | undefined,
  path: Path,
  errors: CatalogVerificationError[],
): readonly CatalogAppVersion[] | undefined {
  if (!Array.isArray(value)) {
    addError(errors, path, "Expected versions array.");
    return undefined;
  }

  if (value.length === 0) {
    addError(errors, path, "Expected at least one app version.");
    return undefined;
  }

  const versions: CatalogAppVersion[] = [];

  for (let index = 0; index < value.length; index += 1) {
    const item = value[index];

    if (!plainObject(item)) {
      addError(errors, [...path, String(index)], "Expected app version object.");
      continue;
    }

    const version = readCatalogAppVersion(item, [...path, String(index)], errors);

    if (version !== undefined) {
      versions[versions.length] = version;
    }
  }

  if (errors.length > 0) {
    return undefined;
  }

  return Object.freeze(versions);
}

function readCatalogAppVersion(
  value: PlainJsonObject,
  path: Path,
  errors: CatalogVerificationError[],
): CatalogAppVersion | undefined {
  const errorStart = errors.length;

  rejectUnknownFields(value, VERSION_FIELDS, path, errors);
  const version = readRequiredString(value, "version", [...path, "version"], errors);
  const packageRef = readRequiredString(value, "packageRef", [...path, "packageRef"], errors);
  const integrity = readRequiredString(value, "integrity", [...path, "integrity"], errors);
  const riskSummary = readRequiredString(value, "riskSummary", [...path, "riskSummary"], errors);
  const grantsSummary = readGrantsSummary(value.grantsSummary, [...path, "grantsSummary"], errors);

  if (packageRef !== undefined) {
    validatePackageReference(packageRef, [...path, "packageRef"], errors);
  }

  if (riskSummary !== undefined && !RISK_CLASSES.has(riskSummary)) {
    addError(errors, [...path, "riskSummary"], "Expected risk class R0, R1, R2, R3, or R4.");
  }

  if (
    errors.length !== errorStart ||
    version === undefined ||
    packageRef === undefined ||
    integrity === undefined ||
    grantsSummary === undefined ||
    !isCatalogRiskClass(riskSummary)
  ) {
    return undefined;
  }

  return Object.freeze({
    grantsSummary,
    integrity,
    packageRef,
    riskSummary,
    version,
  });
}

function readGrantsSummary(
  value: PlainJson | undefined,
  path: Path,
  errors: CatalogVerificationError[],
): readonly string[] | undefined {
  if (!Array.isArray(value)) {
    addError(errors, path, "Expected grants summary array.");
    return undefined;
  }

  const grants: string[] = [];
  let previous: string | undefined;

  for (let index = 0; index < value.length; index += 1) {
    const item = value[index];
    const itemPath = [...path, String(index)];

    if (typeof item !== "string" || item === "") {
      addError(errors, itemPath, "Expected non-empty grant id string.");
      continue;
    }

    if (previous !== undefined && compareStrings(item, previous) <= 0) {
      addError(errors, itemPath, "Expected sorted unique grant ids.");
    }

    grants[grants.length] = item;
    previous = item;
  }

  return Object.freeze(grants);
}

function validatePackageReference(
  value: string,
  path: Path,
  errors: CatalogVerificationError[],
): void {
  const validation = validateCatalogEntry({
    ...REFERENCE_PROBE_ENTRY,
    package: value,
  });

  if (validation.ok) {
    return;
  }

  for (let index = 0; index < validation.errors.length; index += 1) {
    const error = validation.errors[index];

    if (error === undefined || (error.path !== "package" && !error.path.startsWith("package/"))) {
      continue;
    }

    addError(errors, path, error.message);
    return;
  }

  addError(errors, path, "Expected package reference URI.");
}

function validateCatalogIntegrities(
  catalog: CatalogPayload,
  errors: CatalogVerificationError[],
): void {
  for (let appIndex = 0; appIndex < catalog.apps.length; appIndex += 1) {
    const app = catalog.apps[appIndex];

    if (app === undefined) {
      continue;
    }

    for (let versionIndex = 0; versionIndex < app.versions.length; versionIndex += 1) {
      const version = app.versions[versionIndex];

      if (version === undefined) {
        continue;
      }

      if (!isSriIntegrity(version.integrity)) {
        addError(
          errors,
          ["catalog", "apps", String(appIndex), "versions", String(versionIndex), "integrity"],
          "Expected sha256, sha384, or sha512 SRI integrity.",
        );
      }
    }
  }
}

function verifySignature(
  catalogBytes: Uint8Array,
  publicKeyPem: string,
  signatureValue: string,
): boolean {
  const signature = decodeBase64Signature(signatureValue);

  if (signature === undefined) {
    return false;
  }

  try {
    const publicKey = createPublicKey(publicKeyPem);

    return verifyEd25519(null, catalogBytes, publicKey, signature);
  } catch {
    return false;
  }
}

function decodeBase64Signature(value: string): Buffer | undefined {
  if (value.length === 0 || value.length % 4 !== 0) {
    return undefined;
  }

  if (!/^[A-Za-z0-9+/]+={0,2}$/u.test(value)) {
    return undefined;
  }

  try {
    const signature = Buffer.from(value, "base64");

    if (signature.length !== 64 || signature.toString("base64") !== value) {
      return undefined;
    }

    return signature;
  } catch {
    return undefined;
  }
}

function readTrustedPublicKey(
  trustedKeys: Readonly<Record<string, string>>,
  keyId: string,
): string | undefined {
  if (!Object.hasOwn(trustedKeys, keyId)) {
    return undefined;
  }

  return trustedKeys[keyId];
}

function rejectUnknownFields(
  value: PlainJsonObject,
  allowed: ReadonlySet<string>,
  path: Path,
  errors: CatalogVerificationError[],
): void {
  const keys = sortedKeys(value);

  for (let index = 0; index < keys.length; index += 1) {
    const key = keys[index];

    if (key !== undefined && !allowed.has(key)) {
      addError(errors, [...path, key], "Unknown field.");
    }
  }
}

function readRequiredString(
  value: PlainJsonObject,
  key: string,
  path: Path,
  errors: CatalogVerificationError[],
): string | undefined {
  if (!Object.hasOwn(value, key)) {
    addError(errors, path, "Required field is missing.");
    return undefined;
  }

  const child = value[key];

  if (typeof child !== "string" || child === "") {
    addError(errors, path, "Expected non-empty string.");
    return undefined;
  }

  return child;
}

function readRequiredDateTime(
  value: PlainJsonObject,
  key: string,
  path: Path,
  errors: CatalogVerificationError[],
): string | undefined {
  const child = readRequiredString(value, key, path, errors);

  if (child !== undefined && !Number.isFinite(Date.parse(child))) {
    addError(errors, path, "Expected ISO timestamp string.");
    return undefined;
  }

  return child;
}

function plainObject(value: PlainJson | undefined): value is PlainJsonObject {
  return value !== undefined && value !== null && typeof value === "object" && !Array.isArray(value);
}

function sortedKeys(value: PlainJsonObject): string[] {
  return Object.keys(value).sort(compareStrings);
}

function isCatalogRiskClass(value: string | undefined): value is CatalogRiskClass {
  return value !== undefined && RISK_CLASSES.has(value);
}

function addError(errors: CatalogVerificationError[], path: Path, message: string): void {
  errors[errors.length] = {
    message,
    path: formatPath(path),
  };
}

function reject(
  errors: readonly CatalogVerificationError[],
): Extract<CatalogVerificationResult, { readonly ok: false }> {
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
  if (left < right) {
    return -1;
  }

  if (left > right) {
    return 1;
  }

  return 0;
}
