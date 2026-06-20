import { safeNormalize } from "../../../sdk/typescript/src/safe-normalize.ts";
import type { PlainJson, PlainJsonObject } from "../../../sdk/typescript/src/safe-normalize.ts";

export interface LockfilePolicyViolation {
  readonly path: string;
  readonly message: string;
}

export type LockfilePolicyResult =
  | {
      readonly ok: true;
    }
  | {
      readonly ok: false;
      readonly violations: readonly LockfilePolicyViolation[];
      readonly errors: readonly LockfilePolicyViolation[];
    };

type Path = readonly string[];

interface DependencyEdge {
  readonly name: string;
  readonly version: string;
  readonly path: Path;
}

interface PackageRecord {
  readonly name: string;
  readonly version: string;
  readonly hasValidIntegrity: boolean;
}

interface PackageReference {
  readonly name: string;
  readonly version: string;
}

const NPM_TOP_LEVEL_FIELDS = new Set([
  "lockfileVersion",
  "name",
  "packageManager",
  "packages",
  "requires",
  "version",
]);

const JSR_TOP_LEVEL_FIELDS = new Set(["resolved", "specifiers", "version"]);

const PACKAGE_ENTRY_FIELDS = new Set([
  "dependencies",
  "devDependencies",
  "hasInstallScript",
  "integrity",
  "name",
  "optionalDependencies",
  "peerDependencies",
  "requiresBuild",
  "resolved",
  "source",
  "sourceUrl",
  "url",
  "version",
]);

const DEPENDENCY_FIELDS = new Set([
  "dependencies",
  "devDependencies",
  "optionalDependencies",
  "peerDependencies",
]);

const SOURCE_FIELDS = new Set(["resolved", "source", "sourceUrl", "url"]);
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

const LOCAL_MIRROR_PREFIXES = ["local-mirror://", "vita-mirror://"];

const EXACT_VERSION_PATTERN =
  /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u;
const PACKAGE_NAME_PATTERN = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/u;
const SRI_PATTERN = /^(sha256|sha384|sha512)-([A-Za-z0-9+/]+={0,2})$/u;

export function validateLockfilePolicy(input: unknown): LockfilePolicyResult {
  const violations: LockfilePolicyViolation[] = [];

  try {
    const normalized = safeNormalize(input, { maxDepth: 128, maxNodes: 100_000 });

    if (!normalized.ok) {
      addViolation(
        violations,
        [],
        `Lockfile could not be safely normalized: ${normalized.reason}`,
      );
      return reject(violations);
    }

    if (!plainObject(normalized.value)) {
      addViolation(violations, [], "Expected lockfile object.");
      return reject(violations);
    }

    if (hasOwn(normalized.value, "lockfileVersion")) {
      validateNpmLockfile(normalized.value, violations);
    } else if (hasOwn(normalized.value, "specifiers") || hasOwn(normalized.value, "resolved")) {
      validateJsrLockfile(normalized.value, violations);
    } else {
      addViolation(
        violations,
        [],
        "Expected npm lockfileVersion 3 or JSR/Deno specifiers plus resolved lockfile.",
      );
    }

    if (violations.length > 0) {
      return reject(violations);
    }

    return { ok: true };
  } catch {
    return reject([
      {
        path: "",
        message: "Lockfile policy validation failed closed.",
      },
    ]);
  }
}

function validateNpmLockfile(value: PlainJsonObject, violations: LockfilePolicyViolation[]): void {
  rejectUnknownFields(value, NPM_TOP_LEVEL_FIELDS, [], violations);

  const lockfileVersion = value.lockfileVersion;
  if (lockfileVersion !== 3) {
    addViolation(violations, ["lockfileVersion"], "Expected npm lockfileVersion 3.");
  }

  validateOptionalPackageName(value, "name", ["name"], violations);
  validateOptionalExactVersion(value, "version", ["version"], violations);
  validateOptionalPackageReference(value, "packageManager", ["packageManager"], violations);

  if (hasOwn(value, "requires") && typeof value.requires !== "boolean") {
    addViolation(violations, ["requires"], "Expected boolean.");
  }

  const packages = value.packages;
  if (!plainObject(packages)) {
    addViolation(violations, ["packages"], "Expected packages map object.");
    return;
  }

  const edges: DependencyEdge[] = [];
  const records = new Map<string, PackageRecord>();
  const keys = sortedKeys(packages);

  for (let index = 0; index < keys.length; index += 1) {
    const packagePath = keys[index];

    if (packagePath === undefined) {
      continue;
    }

    const packageValue = packages[packagePath];
    const path = ["packages", packagePath];

    if (!plainObject(packageValue)) {
      addViolation(violations, path, "Expected package entry object.");
      continue;
    }

    const packageName =
      packagePath === "" ? optionalString(packageValue.name) : packageNameFromNpmPath(packagePath);

    if (packagePath !== "" && packageName === undefined) {
      addViolation(violations, path, "Expected npm node_modules package path.");
      continue;
    }

    const record = validatePackageEntry(
      packageValue,
      path,
      packageName,
      packagePath === "",
      violations,
      edges,
    );

    if (record !== undefined) {
      records.set(packageKey(record.name, record.version), record);
    }
  }

  validateResolvedEdges(edges, records, violations);
}

function validateJsrLockfile(value: PlainJsonObject, violations: LockfilePolicyViolation[]): void {
  rejectUnknownFields(value, JSR_TOP_LEVEL_FIELDS, [], violations);

  if (hasOwn(value, "version")) {
    const version = value.version;
    if (
      typeof version !== "string" &&
      !(typeof version === "number" && Number.isSafeInteger(version) && version > 0)
    ) {
      addViolation(violations, ["version"], "Expected lockfile version string or positive integer.");
    }
  }

  const specifiers = value.specifiers;
  const resolved = value.resolved;

  if (!plainObject(specifiers)) {
    addViolation(violations, ["specifiers"], "Expected specifiers map object.");
    return;
  }

  if (!plainObject(resolved)) {
    addViolation(violations, ["resolved"], "Expected resolved package map object.");
    return;
  }

  const edges: DependencyEdge[] = [];
  const records = new Map<string, PackageRecord>();
  const specifierKeys = sortedKeys(specifiers);

  for (let index = 0; index < specifierKeys.length; index += 1) {
    const specifier = specifierKeys[index];

    if (specifier === undefined) {
      continue;
    }

    const specifierPath = ["specifiers", specifier];
    const parsedSpecifier = parseSpecifierReference(specifier);

    if (parsedSpecifier === undefined) {
      addViolation(
        violations,
        specifierPath,
        "Expected exact jsr:/npm: package specifier.",
      );
    }

    const target = specifiers[specifier];
    if (typeof target !== "string") {
      addViolation(violations, specifierPath, "Expected resolved package reference string.");
      continue;
    }

    const parsedTarget = parseSpecifierTarget(target, parsedSpecifier);
    if (parsedTarget === undefined) {
      addViolation(
        violations,
        specifierPath,
        "Expected exact version or bare package@exactversion resolved reference.",
      );
      continue;
    }

    if (
      parsedSpecifier !== undefined &&
      (parsedSpecifier.name !== parsedTarget.name || parsedSpecifier.version !== parsedTarget.version)
    ) {
      addViolation(violations, specifierPath, "Specifier resolves to a different package reference.");
    }

    edges.push({
      name: parsedTarget.name,
      path: specifierPath,
      version: parsedTarget.version,
    });
  }

  const resolvedKeys = sortedKeys(resolved);
  for (let index = 0; index < resolvedKeys.length; index += 1) {
    const resolvedKey = resolvedKeys[index];

    if (resolvedKey === undefined) {
      continue;
    }

    const path = ["resolved", resolvedKey];
    const parsedKey = parseBarePackageReference(resolvedKey);

    if (parsedKey === undefined) {
      addViolation(violations, path, "Expected bare package@exactversion resolved key.");
      continue;
    }

    const entry = resolved[resolvedKey];
    if (!plainObject(entry)) {
      addViolation(violations, path, "Expected resolved package entry object.");
      continue;
    }

    const record = validatePackageEntry(
      entry,
      path,
      parsedKey.name,
      false,
      violations,
      edges,
      parsedKey.version,
    );

    if (record !== undefined) {
      records.set(packageKey(record.name, record.version), record);
    }
  }

  validateResolvedEdges(edges, records, violations);
}

function validatePackageEntry(
  value: PlainJsonObject,
  path: Path,
  expectedName: string | undefined,
  isRoot: boolean,
  violations: LockfilePolicyViolation[],
  edges: DependencyEdge[],
  expectedVersion?: string,
): PackageRecord | undefined {
  rejectUnknownPackageEntryFields(value, path, violations);

  validateOptionalPackageName(value, "name", [...path, "name"], violations);
  validateLifecycleIndicators(value, path, violations);

  const name = optionalString(value.name) ?? expectedName;
  if (expectedName !== undefined && optionalString(value.name) !== undefined && value.name !== expectedName) {
    addViolation(violations, [...path, "name"], "Package entry name does not match its key.");
  }

  validatePackageVersion(value, path, isRoot, expectedVersion, violations);
  validateIntegrity(value, path, isRoot, violations);
  validateSourceFields(value, path, name, optionalString(value.version) ?? expectedVersion, violations);
  collectDependencyEdges(value, path, violations, edges);

  if (isRoot || name === undefined) {
    return undefined;
  }

  const version = optionalString(value.version) ?? expectedVersion;
  if (version === undefined || !isExactVersion(version)) {
    return undefined;
  }

  return {
    hasValidIntegrity: typeof value.integrity === "string" && isValidSri(value.integrity),
    name,
    version,
  };
}

function validatePackageVersion(
  value: PlainJsonObject,
  path: Path,
  isRoot: boolean,
  expectedVersion: string | undefined,
  violations: LockfilePolicyViolation[],
): void {
  if (!hasOwn(value, "version")) {
    if (!isRoot && expectedVersion === undefined) {
      addViolation(violations, [...path, "version"], "Required exact version is missing.");
    }
    return;
  }

  const version = value.version;
  if (typeof version !== "string" || !isExactVersion(version)) {
    addViolation(violations, [...path, "version"], "Expected exact semantic version.");
    return;
  }

  if (expectedVersion !== undefined && version !== expectedVersion) {
    addViolation(violations, [...path, "version"], "Package entry version does not match its key.");
  }
}

function validateIntegrity(
  value: PlainJsonObject,
  path: Path,
  isRoot: boolean,
  violations: LockfilePolicyViolation[],
): void {
  if (!hasOwn(value, "integrity")) {
    if (!isRoot) {
      addViolation(violations, [...path, "integrity"], "Required SRI integrity hash is missing.");
    }
    return;
  }

  const integrity = value.integrity;
  if (typeof integrity !== "string" || !isValidSri(integrity)) {
    addViolation(violations, [...path, "integrity"], "Expected valid SRI integrity hash.");
  }
}

function validateSourceFields(
  value: PlainJsonObject,
  path: Path,
  expectedName: string | undefined,
  expectedVersion: string | undefined,
  violations: LockfilePolicyViolation[],
): void {
  const keys = sortedKeys(value);

  for (let index = 0; index < keys.length; index += 1) {
    const key = keys[index];

    if (key === undefined || !SOURCE_FIELDS.has(key)) {
      continue;
    }

    const sourceValue = value[key];
    const sourcePath = [...path, key];

    if (typeof sourceValue !== "string") {
      addViolation(violations, sourcePath, "Expected source reference string.");
      continue;
    }

    const reference = parseBarePackageReference(sourceValue);
    if (reference !== undefined) {
      if (
        expectedName !== undefined &&
        expectedVersion !== undefined &&
        (reference.name !== expectedName || reference.version !== expectedVersion)
      ) {
        addViolation(violations, sourcePath, "Source reference does not match package entry.");
      }
      continue;
    }

    if (!hasAllowedLocalMirrorPrefix(sourceValue)) {
      addViolation(
        violations,
        sourcePath,
        "Expected bare package@exactversion or configured local mirror source.",
      );
    }
  }
}

function collectDependencyEdges(
  value: PlainJsonObject,
  path: Path,
  violations: LockfilePolicyViolation[],
  edges: DependencyEdge[],
): void {
  const dependencyFields = sortedKeys(value);

  for (let index = 0; index < dependencyFields.length; index += 1) {
    const field = dependencyFields[index];

    if (field === undefined || !DEPENDENCY_FIELDS.has(field)) {
      continue;
    }

    const dependencies = value[field];
    const dependenciesPath = [...path, field];

    if (!plainObject(dependencies)) {
      addViolation(violations, dependenciesPath, "Expected dependency map object.");
      continue;
    }

    const dependencyNames = sortedKeys(dependencies);
    for (let dependencyIndex = 0; dependencyIndex < dependencyNames.length; dependencyIndex += 1) {
      const dependencyName = dependencyNames[dependencyIndex];

      if (dependencyName === undefined) {
        continue;
      }

      const dependencyPath = [...dependenciesPath, dependencyName];
      if (!isPackageName(dependencyName)) {
        addViolation(violations, dependencyPath, "Expected package dependency name.");
        continue;
      }

      const dependencyValue = dependencies[dependencyName];
      if (typeof dependencyValue !== "string") {
        addViolation(violations, dependencyPath, "Expected exact dependency version string.");
        continue;
      }

      const reference = parseDependencyValue(dependencyName, dependencyValue);
      if (reference === undefined) {
        addViolation(
          violations,
          dependencyPath,
          "Expected exact dependency version with no range or URL.",
        );
        continue;
      }

      edges.push({
        name: reference.name,
        path: dependencyPath,
        version: reference.version,
      });
    }
  }
}

function validateResolvedEdges(
  edges: readonly DependencyEdge[],
  records: ReadonlyMap<string, PackageRecord>,
  violations: LockfilePolicyViolation[],
): void {
  for (let index = 0; index < edges.length; index += 1) {
    const edge = edges[index];

    if (edge === undefined) {
      continue;
    }

    const record = records.get(packageKey(edge.name, edge.version));
    if (record === undefined || !record.hasValidIntegrity) {
      addViolation(
        violations,
        edge.path,
        "Dependency does not resolve to a pinned package entry with integrity.",
      );
    }
  }
}

function rejectUnknownFields(
  value: PlainJsonObject,
  allowed: ReadonlySet<string>,
  path: Path,
  violations: LockfilePolicyViolation[],
): void {
  const keys = sortedKeys(value);

  for (let index = 0; index < keys.length; index += 1) {
    const key = keys[index];

    if (key !== undefined && !allowed.has(key)) {
      addViolation(violations, [...path, key], "Unknown lockfile field.");
    }
  }
}

function rejectUnknownPackageEntryFields(
  value: PlainJsonObject,
  path: Path,
  violations: LockfilePolicyViolation[],
): void {
  const keys = sortedKeys(value);

  for (let index = 0; index < keys.length; index += 1) {
    const key = keys[index];

    if (key === undefined) {
      continue;
    }

    const childPath = [...path, key];

    if (DIRECT_LIFECYCLE_FIELDS.has(key)) {
      addViolation(violations, childPath, "Lifecycle script field is not allowed.");
      continue;
    }

    if (SCRIPT_CONTAINER_FIELDS.has(key)) {
      const scriptContainer = value[key];

      if (scriptContainer === undefined) {
        addViolation(violations, childPath, "Script containers are not allowed in lockfile entries.");
      } else {
        rejectScriptContainer(scriptContainer, childPath, violations);
      }
      continue;
    }

    if (!PACKAGE_ENTRY_FIELDS.has(key)) {
      addViolation(violations, childPath, "Unknown package entry field.");
    }
  }
}

function rejectScriptContainer(
  value: PlainJson,
  path: Path,
  violations: LockfilePolicyViolation[],
): void {
  if (!plainObject(value)) {
    addViolation(violations, path, "Script containers are not allowed in lockfile entries.");
    return;
  }

  const keys = sortedKeys(value);
  let lifecycleScriptFound = false;

  for (let index = 0; index < keys.length; index += 1) {
    const key = keys[index];

    if (key !== undefined && SCRIPT_OBJECT_LIFECYCLE_FIELDS.has(key)) {
      lifecycleScriptFound = true;
      addViolation(violations, [...path, key], "Lifecycle script is not allowed.");
    }
  }

  if (!lifecycleScriptFound) {
    addViolation(violations, path, "Script containers are not allowed in lockfile entries.");
  }
}

function validateLifecycleIndicators(
  value: PlainJsonObject,
  path: Path,
  violations: LockfilePolicyViolation[],
): void {
  const keys = sortedKeys(value);

  for (let index = 0; index < keys.length; index += 1) {
    const key = keys[index];

    if (key === undefined || !SCRIPT_INDICATOR_FIELDS.has(key)) {
      continue;
    }

    if (value[key] !== false) {
      addViolation(
        violations,
        [...path, key],
        "Lifecycle script indicator must be absent or exactly false.",
      );
    }
  }
}

function validateOptionalPackageName(
  value: PlainJsonObject,
  key: string,
  path: Path,
  violations: LockfilePolicyViolation[],
): void {
  if (!hasOwn(value, key)) {
    return;
  }

  const fieldValue = value[key];
  if (typeof fieldValue !== "string" || !isPackageName(fieldValue)) {
    addViolation(violations, path, "Expected package name.");
  }
}

function validateOptionalExactVersion(
  value: PlainJsonObject,
  key: string,
  path: Path,
  violations: LockfilePolicyViolation[],
): void {
  if (!hasOwn(value, key)) {
    return;
  }

  const fieldValue = value[key];
  if (typeof fieldValue !== "string" || !isExactVersion(fieldValue)) {
    addViolation(violations, path, "Expected exact semantic version.");
  }
}

function validateOptionalPackageReference(
  value: PlainJsonObject,
  key: string,
  path: Path,
  violations: LockfilePolicyViolation[],
): void {
  if (!hasOwn(value, key)) {
    return;
  }

  const fieldValue = value[key];
  if (typeof fieldValue !== "string" || parseBarePackageReference(fieldValue) === undefined) {
    addViolation(violations, path, "Expected package@exactversion reference.");
  }
}

function parseDependencyValue(
  dependencyName: string,
  dependencyValue: string,
): PackageReference | undefined {
  if (isExactVersion(dependencyValue)) {
    return {
      name: dependencyName,
      version: dependencyValue,
    };
  }

  const reference = parseBarePackageReference(dependencyValue);
  if (reference !== undefined && reference.name === dependencyName) {
    return reference;
  }

  return undefined;
}

function parseSpecifierReference(value: string): PackageReference | undefined {
  if (value.startsWith("jsr:")) {
    return parseBarePackageReference(value.slice("jsr:".length));
  }

  if (value.startsWith("npm:")) {
    return parseBarePackageReference(value.slice("npm:".length));
  }

  return parseBarePackageReference(value);
}

function parseSpecifierTarget(
  value: string,
  specifier: PackageReference | undefined,
): PackageReference | undefined {
  const bareReference = parseBarePackageReference(value);

  if (bareReference !== undefined) {
    return bareReference;
  }

  if (specifier !== undefined && isExactVersion(value)) {
    return {
      name: specifier.name,
      version: value,
    };
  }

  return undefined;
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

function isExactVersion(value: string): boolean {
  return EXACT_VERSION_PATTERN.test(value);
}

function isPackageName(value: string): boolean {
  return PACKAGE_NAME_PATTERN.test(value);
}

function isValidSri(value: string): boolean {
  const match = SRI_PATTERN.exec(value);

  if (match === null) {
    return false;
  }

  const algorithm = match[1];
  const digest = match[2];

  if (algorithm === undefined || digest === undefined) {
    return false;
  }

  const expectedLength = sriByteLength(algorithm);

  if (expectedLength === undefined || digest.length % 4 !== 0) {
    return false;
  }

  const bytes = Buffer.from(digest, "base64");

  return bytes.length === expectedLength && bytes.toString("base64") === digest;
}

function sriByteLength(algorithm: string): number | undefined {
  if (algorithm === "sha256") {
    return 32;
  }

  if (algorithm === "sha384") {
    return 48;
  }

  if (algorithm === "sha512") {
    return 64;
  }

  return undefined;
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

function reject(violations: readonly LockfilePolicyViolation[]): LockfilePolicyResult {
  return {
    errors: violations,
    ok: false,
    violations,
  };
}

function addViolation(
  violations: LockfilePolicyViolation[],
  path: Path,
  message: string,
): void {
  violations[violations.length] = {
    message,
    path: formatPath(path),
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
