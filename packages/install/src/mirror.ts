import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";

import { validateLockfilePolicy } from "../../catalog/src/lockfile-policy.ts";
import type { LockfilePolicyViolation } from "../../catalog/src/lockfile-policy.ts";
import { safeNormalize } from "../../../sdk/typescript/src/safe-normalize.ts";
import type { PlainJson, PlainJsonObject } from "../../../sdk/typescript/src/safe-normalize.ts";

export interface MirrorStore {
  readonly get: (key: string) => Uint8Array | undefined;
}

export interface MirrorResolvedPackage {
  readonly name: string;
  readonly version: string;
  readonly integrity: string;
  readonly key: string;
}

export interface MirrorResolution {
  readonly packages: readonly MirrorResolvedPackage[];
}

export interface MirrorResolutionError {
  readonly code: "POLICY_REJECTED" | "NOT_IN_MIRROR" | "INTEGRITY_MISMATCH";
  readonly path: string;
  readonly message: string;
}

export type MirrorResolutionResult =
  | {
      readonly ok: true;
      readonly resolution: MirrorResolution;
    }
  | {
      readonly ok: false;
      readonly errors: readonly MirrorResolutionError[];
    };

interface PackageReference {
  readonly name: string;
  readonly version: string;
}

type Path = readonly string[];
type SriAlgorithm = "sha256" | "sha384" | "sha512";

interface ParsedSri {
  readonly algorithm: SriAlgorithm;
  readonly digests: readonly string[];
}

const SOURCE_FIELDS = ["resolved", "source", "sourceUrl", "url"] as const;
const SCRIPT_CONTAINER_FIELDS = new Set(["lifecycle", "scripts"]);
const SCRIPT_INDICATOR_FIELDS = new Set(["hasInstallScript", "requiresBuild"]);
const DIRECT_LIFECYCLE_FIELDS = new Set([
  "install",
  "postinstall",
  "postpack",
  "postprepare",
  "postpublish",
  "postrestart",
  "poststart",
  "poststop",
  "posttest",
  "postuninstall",
  "postversion",
  "preinstall",
  "prepack",
  "prepare",
  "preprepare",
  "prepublish",
  "prepublishOnly",
  "prepublishonly",
  "prerestart",
  "prestart",
  "prestop",
  "pretest",
  "preuninstall",
  "preversion",
  "publish",
  "rebuild",
  "restart",
  "start",
  "stop",
  "uninstall",
]);
const SCRIPT_OBJECT_LIFECYCLE_FIELDS = new Set([
  ...DIRECT_LIFECYCLE_FIELDS,
  "version",
]);
const LOCAL_MIRROR_PREFIXES = ["local-mirror://", "vita-mirror://"] as const;

const EXACT_VERSION_PATTERN =
  /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u;
const PACKAGE_NAME_PATTERN = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/u;
const SRI_PATTERN = /^(sha256|sha384|sha512)-([A-Za-z0-9+/]+={0,2})$/u;

export function resolveFromMirror(
  lockfileInput: unknown,
  store: MirrorStore,
): MirrorResolutionResult {
  try {
    const normalized = safeNormalize(lockfileInput, { maxDepth: 128, maxNodes: 100_000 });

    if (!normalized.ok) {
      return reject([
        error(
          "POLICY_REJECTED",
          [],
          `Lockfile could not be safely normalized: ${normalized.reason}`,
        ),
      ]);
    }

    const policyResult = validateLockfilePolicy(normalized.value);
    if (!policyResult.ok) {
      return reject(policyResult.violations.map(lockfilePolicyError));
    }

    if (!plainObject(normalized.value)) {
      return reject([error("POLICY_REJECTED", [], "Expected lockfile object.")]);
    }

    const resolved = resolveNormalizedLockfile(normalized.value, store);
    if (!resolved.ok) {
      return reject(resolved.errors);
    }

    return {
      ok: true,
      resolution: {
        packages: sortedPackages(resolved.packages),
      },
    };
  } catch {
    return reject([
      error("POLICY_REJECTED", [], "Mirror resolution failed closed."),
    ]);
  }
}

function resolveNormalizedLockfile(
  lockfile: PlainJsonObject,
  store: MirrorStore,
):
  | {
      readonly ok: true;
      readonly packages: ReadonlyMap<string, MirrorResolvedPackage>;
    }
  | {
      readonly ok: false;
      readonly errors: readonly MirrorResolutionError[];
    } {
  const errors: MirrorResolutionError[] = [];
  const packages = new Map<string, MirrorResolvedPackage>();

  if (hasOwn(lockfile, "lockfileVersion")) {
    collectNpmPackages(lockfile, store, packages, errors);
  } else if (hasOwn(lockfile, "specifiers") || hasOwn(lockfile, "resolved")) {
    collectJsrPackages(lockfile, store, packages, errors);
  } else {
    errors[errors.length] = error(
      "POLICY_REJECTED",
      [],
      "Expected npm lockfileVersion 3 or JSR/Deno specifiers plus resolved lockfile.",
    );
  }

  if (errors.length > 0) {
    return {
      errors,
      ok: false,
    };
  }

  return {
    ok: true,
    packages,
  };
}

function collectNpmPackages(
  lockfile: PlainJsonObject,
  store: MirrorStore,
  packages: Map<string, MirrorResolvedPackage>,
  errors: MirrorResolutionError[],
): void {
  const packageMap = lockfile.packages;

  if (!plainObject(packageMap)) {
    errors[errors.length] = error("POLICY_REJECTED", ["packages"], "Expected packages map object.");
    return;
  }

  const packagePaths = sortedKeys(packageMap);
  for (let index = 0; index < packagePaths.length; index += 1) {
    const packagePath = packagePaths[index];
    if (packagePath === undefined || packagePath === "") {
      continue;
    }

    const entry = packageMap[packagePath];
    const path = ["packages", packagePath];

    if (!plainObject(entry)) {
      errors[errors.length] = error("POLICY_REJECTED", path, "Expected package entry object.");
      continue;
    }

    const name = packageNameFromNpmPath(packagePath);
    if (name === undefined) {
      errors[errors.length] = error("POLICY_REJECTED", path, "Expected npm node_modules package path.");
      continue;
    }

    verifyPackageEntry(name, undefined, entry, path, store, packages, errors);
  }
}

function collectJsrPackages(
  lockfile: PlainJsonObject,
  store: MirrorStore,
  packages: Map<string, MirrorResolvedPackage>,
  errors: MirrorResolutionError[],
): void {
  const resolved = lockfile.resolved;

  if (!plainObject(resolved)) {
    errors[errors.length] = error("POLICY_REJECTED", ["resolved"], "Expected resolved package map object.");
    return;
  }

  const resolvedKeys = sortedKeys(resolved);
  for (let index = 0; index < resolvedKeys.length; index += 1) {
    const resolvedKey = resolvedKeys[index];
    if (resolvedKey === undefined) {
      continue;
    }

    const path = ["resolved", resolvedKey];
    const reference = parseBarePackageReference(resolvedKey);

    if (reference === undefined) {
      errors[errors.length] = error("POLICY_REJECTED", path, "Expected bare package@exactversion resolved key.");
      continue;
    }

    const entry = resolved[resolvedKey];
    if (!plainObject(entry)) {
      errors[errors.length] = error("POLICY_REJECTED", path, "Expected resolved package entry object.");
      continue;
    }

    verifyPackageEntry(reference.name, reference.version, entry, path, store, packages, errors);
  }
}

function verifyPackageEntry(
  expectedName: string,
  expectedVersion: string | undefined,
  entry: PlainJsonObject,
  path: Path,
  store: MirrorStore,
  packages: Map<string, MirrorResolvedPackage>,
  errors: MirrorResolutionError[],
): void {
  const details = readPackageDetails(expectedName, expectedVersion, entry, path, errors);
  if (details === undefined) {
    return;
  }

  const key = packageKey(details.name, details.version);
  const bytes = store.get(key);

  if (bytes === undefined) {
    errors[errors.length] = error(
      "NOT_IN_MIRROR",
      path,
      `Package ${key} is not present in the mirror store.`,
    );
    return;
  }

  if (!(bytes instanceof Uint8Array)) {
    errors[errors.length] = error(
      "POLICY_REJECTED",
      path,
      `Mirror store returned non-byte artifact for ${key}.`,
    );
    return;
  }

  const actualDigest = createHash(details.sri.algorithm).update(bytes).digest("base64");
  if (!hasString(details.sri.digests, actualDigest)) {
    errors[errors.length] = error(
      "INTEGRITY_MISMATCH",
      [...path, "integrity"],
      `Mirror artifact ${key} does not match lockfile ${details.sri.algorithm} integrity.`,
    );
    return;
  }

  upsertPackage(packages, {
    integrity: details.integrity,
    key,
    name: details.name,
    version: details.version,
  });
}

function readPackageDetails(
  expectedName: string,
  expectedVersion: string | undefined,
  entry: PlainJsonObject,
  path: Path,
  errors: MirrorResolutionError[],
):
  | {
      readonly name: string;
      readonly version: string;
      readonly integrity: string;
      readonly sri: ParsedSri;
    }
  | undefined {
  if (!isPackageName(expectedName)) {
    errors[errors.length] = error("POLICY_REJECTED", path, "Expected package name.");
    return undefined;
  }

  const initialErrorCount = errors.length;

  rejectLifecycleIndicators(entry, path, errors);

  if (optionalString(entry.name) !== undefined && entry.name !== expectedName) {
    errors[errors.length] = error("POLICY_REJECTED", [...path, "name"], "Package entry name does not match its key.");
    return undefined;
  }

  const versionValue = optionalString(entry.version) ?? expectedVersion;
  if (versionValue === undefined || !isExactVersion(versionValue)) {
    errors[errors.length] = error("POLICY_REJECTED", [...path, "version"], "Expected exact semantic version.");
    return undefined;
  }

  if (expectedVersion !== undefined && optionalString(entry.version) !== undefined && entry.version !== expectedVersion) {
    errors[errors.length] = error("POLICY_REJECTED", [...path, "version"], "Package entry version does not match its key.");
    return undefined;
  }

  validateSourceFields(entry, path, expectedName, versionValue, errors);
  if (errors.length > initialErrorCount) {
    return undefined;
  }

  const integrity = optionalString(entry.integrity);
  if (integrity === undefined) {
    errors[errors.length] = error("POLICY_REJECTED", [...path, "integrity"], "Required SRI integrity hash is missing.");
    return undefined;
  }

  const sri = parseStrongestSri(integrity);
  if (sri === undefined) {
    errors[errors.length] = error("POLICY_REJECTED", [...path, "integrity"], "Expected valid SRI integrity hash.");
    return undefined;
  }

  return {
    integrity,
    name: expectedName,
    sri,
    version: versionValue,
  };
}

function validateSourceFields(
  entry: PlainJsonObject,
  path: Path,
  expectedName: string,
  expectedVersion: string | undefined,
  errors: MirrorResolutionError[],
): void {
  for (let index = 0; index < SOURCE_FIELDS.length; index += 1) {
    const field = SOURCE_FIELDS[index];
    if (field === undefined || !hasOwn(entry, field)) {
      continue;
    }

    const sourceValue = entry[field];
    const sourcePath = [...path, field];

    if (typeof sourceValue !== "string") {
      errors[errors.length] = error("POLICY_REJECTED", sourcePath, "Expected source reference string.");
      continue;
    }

    const reference = parseBarePackageReference(sourceValue);
    if (reference !== undefined) {
      if (
        expectedVersion !== undefined &&
        (reference.name !== expectedName || reference.version !== expectedVersion)
      ) {
        errors[errors.length] = error("POLICY_REJECTED", sourcePath, "Source reference does not match package entry.");
      }
      continue;
    }

    if (!hasAllowedLocalMirrorPrefix(sourceValue)) {
      errors[errors.length] = error(
        "POLICY_REJECTED",
        sourcePath,
        "Expected bare package@exactversion or configured local mirror source.",
      );
    }
  }
}

function rejectLifecycleIndicators(
  entry: PlainJsonObject,
  path: Path,
  errors: MirrorResolutionError[],
): void {
  const keys = sortedKeys(entry);
  for (let index = 0; index < keys.length; index += 1) {
    const key = keys[index];
    if (key === undefined) {
      continue;
    }

    const childPath = [...path, key];

    if (DIRECT_LIFECYCLE_FIELDS.has(key)) {
      errors[errors.length] = error("POLICY_REJECTED", childPath, "Lifecycle script field is not allowed.");
      continue;
    }

    if (SCRIPT_CONTAINER_FIELDS.has(key)) {
      rejectScriptContainer(entry[key], childPath, errors);
      continue;
    }

    if (SCRIPT_INDICATOR_FIELDS.has(key) && entry[key] !== false) {
      errors[errors.length] = error(
        "POLICY_REJECTED",
        childPath,
        "Lifecycle script indicator must be absent or exactly false.",
      );
    }
  }
}

function rejectScriptContainer(
  value: PlainJson | undefined,
  path: Path,
  errors: MirrorResolutionError[],
): void {
  if (!plainObject(value)) {
    errors[errors.length] = error("POLICY_REJECTED", path, "Script containers are not allowed in lockfile entries.");
    return;
  }

  const keys = sortedKeys(value);
  let lifecycleScriptFound = false;

  for (let index = 0; index < keys.length; index += 1) {
    const key = keys[index];
    if (key !== undefined && SCRIPT_OBJECT_LIFECYCLE_FIELDS.has(key)) {
      lifecycleScriptFound = true;
      errors[errors.length] = error("POLICY_REJECTED", [...path, key], "Lifecycle script is not allowed.");
    }
  }

  if (!lifecycleScriptFound) {
    errors[errors.length] = error("POLICY_REJECTED", path, "Script containers are not allowed in lockfile entries.");
  }
}

function parseStrongestSri(integrity: string): ParsedSri | undefined {
  const tokens = integrity.trim().split(/\s+/u);
  let strongest: SriAlgorithm | undefined;
  const digests: string[] = [];

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token === undefined || token === "") {
      return undefined;
    }

    const match = SRI_PATTERN.exec(token);
    if (match === null) {
      return undefined;
    }

    const algorithm = match[1];
    const digest = match[2];
    if (!isSriAlgorithm(algorithm) || digest === undefined || !isValidSriDigest(algorithm, digest)) {
      return undefined;
    }

    if (strongest === undefined || sriStrength(algorithm) > sriStrength(strongest)) {
      strongest = algorithm;
      digests.length = 0;
      digests[digests.length] = digest;
    } else if (algorithm === strongest) {
      digests[digests.length] = digest;
    }
  }

  if (strongest === undefined || digests.length === 0) {
    return undefined;
  }

  return {
    algorithm: strongest,
    digests,
  };
}

function isValidSriDigest(algorithm: SriAlgorithm, digest: string): boolean {
  const expectedLength = sriByteLength(algorithm);
  if (digest.length % 4 !== 0) {
    return false;
  }

  const bytes = Buffer.from(digest, "base64");
  return bytes.length === expectedLength && bytes.toString("base64") === digest;
}

function sriByteLength(algorithm: SriAlgorithm): number {
  if (algorithm === "sha256") {
    return 32;
  }

  if (algorithm === "sha384") {
    return 48;
  }

  return 64;
}

function sriStrength(algorithm: SriAlgorithm): number {
  if (algorithm === "sha256") {
    return 1;
  }

  if (algorithm === "sha384") {
    return 2;
  }

  return 3;
}

function isSriAlgorithm(value: string | undefined): value is SriAlgorithm {
  return value === "sha256" || value === "sha384" || value === "sha512";
}

function upsertPackage(
  packages: Map<string, MirrorResolvedPackage>,
  value: MirrorResolvedPackage,
): void {
  const existing = packages.get(value.key);
  if (existing === undefined || compareIntegrity(value.integrity, existing.integrity) < 0) {
    packages.set(value.key, value);
  }
}

function sortedPackages(
  packages: ReadonlyMap<string, MirrorResolvedPackage>,
): readonly MirrorResolvedPackage[] {
  const out: MirrorResolvedPackage[] = [];

  for (const value of packages.values()) {
    out[out.length] = value;
  }

  out.sort(comparePackages);
  return out;
}

function comparePackages(left: MirrorResolvedPackage, right: MirrorResolvedPackage): number {
  return compareStrings(left.key, right.key);
}

function compareIntegrity(left: string, right: string): number {
  const leftSri = parseStrongestSri(left);
  const rightSri = parseStrongestSri(right);

  if (leftSri !== undefined && rightSri !== undefined) {
    const strengthComparison = sriStrength(rightSri.algorithm) - sriStrength(leftSri.algorithm);
    if (strengthComparison !== 0) {
      return strengthComparison;
    }
  }

  return compareStrings(left, right);
}

function parseBarePackageReference(value: string): PackageReference | undefined {
  const separator = value.lastIndexOf("@");
  if (separator <= 0 || separator === value.length - 1) {
    return undefined;
  }

  const name = value.slice(0, separator);
  const version = value.slice(separator + 1);

  if (!isPackageName(name) || !isExactVersion(version)) {
    return undefined;
  }

  return {
    name,
    version,
  };
}

function packageNameFromNpmPath(value: string): string | undefined {
  const parts = value.split("/");
  let index = 0;
  let packageName: string | undefined;

  while (index < parts.length) {
    if (parts[index] !== "node_modules") {
      return undefined;
    }

    index += 1;
    const firstNamePart = parts[index];
    if (firstNamePart === undefined || firstNamePart === "." || firstNamePart === "..") {
      return undefined;
    }

    if (firstNamePart.startsWith("@")) {
      const secondNamePart = parts[index + 1];
      if (
        secondNamePart === undefined ||
        secondNamePart === "" ||
        secondNamePart === "." ||
        secondNamePart === ".."
      ) {
        return undefined;
      }

      packageName = `${firstNamePart}/${secondNamePart}`;
      index += 2;
    } else {
      packageName = firstNamePart;
      index += 1;
    }

    if (!isPackageName(packageName)) {
      return undefined;
    }
  }

  return packageName;
}

function hasAllowedLocalMirrorPrefix(value: string): boolean {
  for (let index = 0; index < LOCAL_MIRROR_PREFIXES.length; index += 1) {
    const prefix = LOCAL_MIRROR_PREFIXES[index];
    if (prefix !== undefined && value.startsWith(prefix)) {
      return true;
    }
  }

  return false;
}

function isExactVersion(value: string): boolean {
  return EXACT_VERSION_PATTERN.test(value);
}

function isPackageName(value: string): boolean {
  return PACKAGE_NAME_PATTERN.test(value);
}

function optionalString(value: PlainJson | undefined): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function plainObject(value: PlainJson | undefined): value is PlainJsonObject {
  return value !== undefined && value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasOwn(value: PlainJsonObject, key: string): boolean {
  return Object.hasOwn(value, key);
}

function sortedKeys(value: PlainJsonObject): string[] {
  return Object.keys(value).sort(compareStrings);
}

function packageKey(name: string, version: string): string {
  return `${name}@${version}`;
}

function lockfilePolicyError(violation: LockfilePolicyViolation): MirrorResolutionError {
  return {
    code: "POLICY_REJECTED",
    message: violation.message,
    path: violation.path,
  };
}

function error(
  code: MirrorResolutionError["code"],
  path: Path,
  message: string,
): MirrorResolutionError {
  return {
    code,
    message,
    path: formatPath(path),
  };
}

function reject(errors: readonly MirrorResolutionError[]): {
  readonly ok: false;
  readonly errors: readonly MirrorResolutionError[];
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

function hasString(values: readonly string[], target: string): boolean {
  for (let index = 0; index < values.length; index += 1) {
    if (values[index] === target) {
      return true;
    }
  }

  return false;
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
