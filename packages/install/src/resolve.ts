import { validateCatalogEntry } from "../../catalog/src/catalog-entry.ts";
import type { CatalogEntry, TrustTier } from "../../catalog/src/catalog-entry.ts";
import { validateLockfilePolicy } from "../../catalog/src/lockfile-policy.ts";
import type { LockfilePolicyViolation } from "../../catalog/src/lockfile-policy.ts";
import { decideGrants } from "../../../runtime/permission-broker/src/decide.ts";
import type {
  BrokerPolicy,
  CapabilityDenial,
  CapabilityGrant,
  DataGrantPolicy,
  RequestedCapability,
} from "../../../runtime/permission-broker/src/grants.ts";
import type {
  DataClass,
  DataVolumeRequirement,
  ImmutableDigest,
  NetworkEgressRule,
  NetworkIngressRule,
  NetworkProtocol,
  PackageContract,
} from "../../../sdk/manifests/src/package-contract.ts";
import { safeNormalize } from "../../../sdk/typescript/src/safe-normalize.ts";
import type { PlainJson, PlainJsonObject } from "../../../sdk/typescript/src/safe-normalize.ts";

export interface InstallPlanPackage {
  readonly id: string;
  readonly name: string;
  readonly version: string;
  readonly digest: ImmutableDigest;
}

export interface InstallPlanDependency {
  readonly name: string;
  readonly version: string;
}

export interface InstallStep {
  readonly name: string;
  readonly version: string;
  readonly integrity: string;
  readonly source?: string;
  readonly dependencies: readonly InstallPlanDependency[];
}

export interface InstallPlan {
  readonly package: InstallPlanPackage;
  readonly trustTier: TrustTier;
  readonly steps: readonly InstallStep[];
  readonly capabilityGrants: readonly CapabilityGrant[];
}

export interface ResolveInstallPlanError {
  readonly code:
    | "NORMALIZATION_FAILED"
    | "INVALID_ENTRY"
    | "MISSING_REQUESTED_CAPABILITIES"
    | "INVALID_LOCKFILE_POLICY"
    | "INVALID_LOCKFILE_GRAPH"
    | "CAPABILITY_DENIED";
  readonly path: string;
  readonly message: string;
}

export type ResolveInstallPlanResult =
  | {
      readonly ok: true;
      readonly plan: InstallPlan;
    }
  | {
      readonly ok: false;
      readonly errors: readonly ResolveInstallPlanError[];
    };

interface PackageReference {
  readonly name: string;
  readonly version: string;
}

interface PackageRecord {
  readonly name: string;
  readonly version: string;
  readonly integrity: string;
  readonly source?: string;
  readonly dependencies: readonly PackageReference[];
  readonly path: string;
}

type GraphResult =
  | {
      readonly ok: true;
      readonly steps: readonly InstallStep[];
    }
  | {
      readonly ok: false;
      readonly errors: readonly ResolveInstallPlanError[];
    };

type Path = readonly string[];

const CATALOG_EXTRA_FIELD = "requestedCapabilities";
const INSTALL_DEPENDENCY_FIELD = "dependencies";
const SOURCE_FIELDS = ["resolved", "source", "sourceUrl", "url"] as const;

const DATA_CLASSES = new Set<string>([
  "user-content",
  "app-state",
  "cache",
  "logs",
  "telemetry",
  "configuration",
]);
const ACCESS_MODES = new Set<string>(["read-only", "read-write"]);
const NETWORK_PROTOCOLS = new Set<string>(["http", "https", "tcp", "udp", "ws", "wss"]);

const EXACT_VERSION_PATTERN =
  /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u;
const PACKAGE_NAME_PATTERN = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/u;

export function resolveInstallPlan(entryInput: unknown, lockfileInput: unknown): ResolveInstallPlanResult {
  try {
    const entry = normalizeBoundary(entryInput, "entry");
    if (!entry.ok) return reject([entry.error]);

    if (!plainObject(entry.value)) {
      return reject([
        error("INVALID_ENTRY", [], "Expected catalog entry object with requestedCapabilities."),
      ]);
    }

    const entryResult = parseEntry(entry.value);
    if (!entryResult.ok) return reject(entryResult.errors);

    const lockfile = normalizeBoundary(lockfileInput, "lockfile");
    if (!lockfile.ok) return reject([lockfile.error]);

    if (!plainObject(lockfile.value)) {
      return reject([error("INVALID_LOCKFILE_POLICY", [], "Expected lockfile object.")]);
    }

    const policyResult = validateLockfilePolicy(lockfile.value);
    if (!policyResult.ok) {
      return reject(policyResult.violations.map(lockfilePolicyError));
    }

    const graphResult = buildInstallSteps(lockfile.value);
    if (!graphResult.ok) return reject(graphResult.errors);

    const grantDecision = decideGrants(
      {
        packageContract: entryResult.contract,
        capabilities: entryResult.requestedCapabilities,
      },
      policyForTrustTier(entryResult.catalogEntry.trustTier, entryResult.contract),
    );

    if (grantDecision.denied.length > 0) {
      return reject(grantDecision.denied.map(capabilityError));
    }

    return {
      ok: true,
      plan: {
        capabilityGrants: grantDecision.granted,
        package: {
          digest: entryResult.contract.digest,
          id: entryResult.contract.identity.id,
          name: entryResult.contract.identity.name,
          version: entryResult.contract.version,
        },
        steps: graphResult.steps,
        trustTier: entryResult.catalogEntry.trustTier,
      },
    };
  } catch {
    return reject([
      error("NORMALIZATION_FAILED", [], "Install plan resolution failed closed."),
    ]);
  }
}

function normalizeBoundary(
  value: unknown,
  label: "entry" | "lockfile",
):
  | {
      readonly ok: true;
      readonly value: PlainJson;
    }
  | {
      readonly ok: false;
      readonly error: ResolveInstallPlanError;
    } {
  const normalized = safeNormalize(value, { maxDepth: 128, maxNodes: 100_000 });

  if (normalized.ok) {
    return normalized;
  }

  return {
    error: error(
      "NORMALIZATION_FAILED",
      [],
      `Could not safely normalize ${label}: ${normalized.reason}`,
    ),
    ok: false,
  };
}

function parseEntry(value: PlainJsonObject):
  | {
      readonly ok: true;
      readonly catalogEntry: CatalogEntry;
      readonly contract: PackageContract;
      readonly requestedCapabilities: readonly RequestedCapability[];
    }
  | {
      readonly ok: false;
      readonly errors: readonly ResolveInstallPlanError[];
    } {
  if (!Object.hasOwn(value, CATALOG_EXTRA_FIELD)) {
    return reject([
      error(
        "MISSING_REQUESTED_CAPABILITIES",
        [CATALOG_EXTRA_FIELD],
        "Catalog entry must explicitly request capabilities.",
      ),
    ]);
  }

  const requested = value[CATALOG_EXTRA_FIELD];
  if (!Array.isArray(requested)) {
    return reject([
      error(
        "INVALID_ENTRY",
        [CATALOG_EXTRA_FIELD],
        "Expected requestedCapabilities array.",
      ),
    ]);
  }

  const catalogCandidate = catalogEntryCandidate(value);
  const catalogResult = validateCatalogEntry(catalogCandidate);
  if (!catalogResult.ok) {
    return reject(
      catalogResult.errors.map((entryError) =>
        error("INVALID_ENTRY", parsePath(entryError.path), entryError.message),
      ),
    );
  }

  const contract = inlineContract(catalogResult.entry);
  if (contract === undefined) {
    return reject([
      error(
        "INVALID_ENTRY",
        ["package"],
        "Catalog entry package must be an embedded package contract for install planning.",
      ),
    ]);
  }

  return {
    catalogEntry: catalogResult.entry,
    contract,
    ok: true,
    requestedCapabilities: readRequestedCapabilities(requested),
  };
}

function catalogEntryCandidate(value: PlainJsonObject): PlainJsonObject {
  const candidate: Record<string, PlainJson> = {};
  const keys = sortedKeys(value);

  for (let index = 0; index < keys.length; index += 1) {
    const key = keys[index];
    if (key === undefined || key === CATALOG_EXTRA_FIELD) continue;

    const child = value[key];
    if (child !== undefined) {
      candidate[key] = child;
    }
  }

  return candidate;
}

function inlineContract(entry: CatalogEntry): PackageContract | undefined {
  if (typeof entry.package === "string") return undefined;
  if ("ref" in entry.package) return undefined;
  return entry.package;
}

function readRequestedCapabilities(values: readonly PlainJson[]): readonly RequestedCapability[] {
  const out: RequestedCapability[] = [];

  for (let index = 0; index < values.length; index += 1) {
    const item = values[index];
    out[index] = readCapability(item);
  }

  return out;
}

function readCapability(value: PlainJson | undefined): RequestedCapability {
  if (!plainObject(value) || typeof value.kind !== "string") {
    return unknownCapability("capability");
  }

  if (value.kind === "data") {
    return readDataCapability(value);
  }

  if (value.kind === "network") {
    return readNetworkCapability(value);
  }

  return unknownCapability(value.kind);
}

function readDataCapability(value: PlainJsonObject): RequestedCapability {
  return exactKeys(value, ["kind", "class", "access", "scope"]) &&
    dataClass(value.class) &&
    accessMode(value.access) &&
    nonEmptyString(value.scope)
    ? {
        access: value.access,
        class: value.class,
        kind: "data",
        scope: value.scope,
      }
    : unknownCapability("data");
}

function readNetworkCapability(value: PlainJsonObject): RequestedCapability {
  if (value.direction === "ingress") {
    return exactKeys(value, ["kind", "direction", "protocol", "port", "public"]) &&
      protocol(value.protocol) &&
      port(value.port) &&
      typeof value.public === "boolean"
      ? {
          direction: "ingress",
          kind: "network",
          port: value.port,
          protocol: value.protocol,
          public: value.public,
        }
      : unknownCapability("network");
  }

  if (value.direction === "egress") {
    return exactKeys(value, ["kind", "direction", "protocol", "destination", "port"]) &&
      protocol(value.protocol) &&
      port(value.port) &&
      nonEmptyString(value.destination)
      ? {
          destination: value.destination,
          direction: "egress",
          kind: "network",
          port: value.port,
          protocol: value.protocol,
        }
      : unknownCapability("network");
  }

  return unknownCapability("network");
}

function buildInstallSteps(lockfile: PlainJsonObject): GraphResult {
  if (Object.hasOwn(lockfile, "lockfileVersion")) {
    return buildNpmInstallSteps(lockfile);
  }

  if (Object.hasOwn(lockfile, "specifiers") || Object.hasOwn(lockfile, "resolved")) {
    return buildJsrInstallSteps(lockfile);
  }

  return reject([
    error(
      "INVALID_LOCKFILE_GRAPH",
      [],
      "Expected npm lockfileVersion 3 or JSR/Deno specifiers lockfile.",
    ),
  ]);
}

function buildNpmInstallSteps(lockfile: PlainJsonObject): GraphResult {
  const packages = lockfile.packages;
  if (!plainObject(packages)) {
    return reject([error("INVALID_LOCKFILE_GRAPH", ["packages"], "Expected packages map object.")]);
  }

  const root = packages[""];
  if (!plainObject(root)) {
    return reject([
      error("INVALID_LOCKFILE_GRAPH", ["packages", ""], "Expected root package entry object."),
    ]);
  }

  const errors: ResolveInstallPlanError[] = [];
  const records = new Map<string, PackageRecord>();
  const packagePaths = sortedKeys(packages);

  for (let index = 0; index < packagePaths.length; index += 1) {
    const packagePath = packagePaths[index];
    if (packagePath === undefined || packagePath === "") continue;

    const entry = packages[packagePath];
    if (!plainObject(entry)) {
      addGraphError(errors, ["packages", packagePath], "Expected package entry object.");
      continue;
    }

    const record = readNpmPackageRecord(packagePath, entry, errors);
    if (record !== undefined) {
      upsertRecord(records, record, errors);
    }
  }

  const roots = dependencyReferencesFrom(root, ["packages", ""], errors);

  if (errors.length > 0) {
    return reject(errors);
  }

  return orderInstallSteps(roots, records);
}

function readNpmPackageRecord(
  packagePath: string,
  entry: PlainJsonObject,
  errors: ResolveInstallPlanError[],
): PackageRecord | undefined {
  const name = packageNameFromNpmPath(packagePath);
  const path = ["packages", packagePath];

  if (name === undefined) {
    addGraphError(errors, path, "Expected npm node_modules package path.");
    return undefined;
  }

  return readPackageRecord(name, optionalString(entry.version), entry, path, errors);
}

function buildJsrInstallSteps(lockfile: PlainJsonObject): GraphResult {
  const specifiers = lockfile.specifiers;
  const resolved = lockfile.resolved;

  if (!plainObject(specifiers)) {
    return reject([
      error("INVALID_LOCKFILE_GRAPH", ["specifiers"], "Expected specifiers map object."),
    ]);
  }

  if (!plainObject(resolved)) {
    return reject([error("INVALID_LOCKFILE_GRAPH", ["resolved"], "Expected resolved map object.")]);
  }

  const errors: ResolveInstallPlanError[] = [];
  const records = new Map<string, PackageRecord>();
  const resolvedKeys = sortedKeys(resolved);

  for (let index = 0; index < resolvedKeys.length; index += 1) {
    const resolvedKey = resolvedKeys[index];
    if (resolvedKey === undefined) continue;

    const reference = parseBarePackageReference(resolvedKey);
    if (reference === undefined) {
      addGraphError(errors, ["resolved", resolvedKey], "Expected package@exactversion key.");
      continue;
    }

    const entry = resolved[resolvedKey];
    if (!plainObject(entry)) {
      addGraphError(errors, ["resolved", resolvedKey], "Expected resolved package entry object.");
      continue;
    }

    const record = readPackageRecord(
      reference.name,
      optionalString(entry.version) ?? reference.version,
      entry,
      ["resolved", resolvedKey],
      errors,
    );
    if (record !== undefined) {
      upsertRecord(records, record, errors);
    }
  }

  const roots: PackageReference[] = [];
  const specifierKeys = sortedKeys(specifiers);

  for (let index = 0; index < specifierKeys.length; index += 1) {
    const specifier = specifierKeys[index];
    if (specifier === undefined) continue;

    const value = specifiers[specifier];
    if (typeof value !== "string") {
      addGraphError(errors, ["specifiers", specifier], "Expected resolved package reference string.");
      continue;
    }

    const reference = parseSpecifierTarget(value, parseSpecifierReference(specifier));
    if (reference === undefined) {
      addGraphError(errors, ["specifiers", specifier], "Expected exact resolved package reference.");
      continue;
    }

    roots[roots.length] = reference;
  }

  if (errors.length > 0) {
    return reject(errors);
  }

  return orderInstallSteps(roots, records);
}

function readPackageRecord(
  name: string,
  version: string | undefined,
  entry: PlainJsonObject,
  path: Path,
  errors: ResolveInstallPlanError[],
): PackageRecord | undefined {
  const integrity = optionalString(entry.integrity);
  if (version === undefined || !isExactVersion(version)) {
    addGraphError(errors, [...path, "version"], "Expected exact package version.");
    return undefined;
  }

  if (integrity === undefined || integrity === "") {
    addGraphError(errors, [...path, "integrity"], "Expected package integrity.");
    return undefined;
  }

  const dependencies = dependencyReferencesFrom(entry, path, errors);
  const source = sourceFrom(entry);
  const pointer = formatPath(path);

  if (source === undefined) {
    return {
      dependencies,
      integrity,
      name,
      path: pointer,
      version,
    };
  }

  return {
    dependencies,
    integrity,
    name,
    path: pointer,
    source,
    version,
  };
}

function dependencyReferencesFrom(
  entry: PlainJsonObject,
  path: Path,
  errors: ResolveInstallPlanError[],
): readonly PackageReference[] {
  const dependencies = entry[INSTALL_DEPENDENCY_FIELD];
  if (dependencies === undefined) {
    return [];
  }

  if (!plainObject(dependencies)) {
    addGraphError(
      errors,
      [...path, INSTALL_DEPENDENCY_FIELD],
      "Expected dependency map object.",
    );
    return [];
  }

  const references: PackageReference[] = [];
  const dependencyNames = sortedKeys(dependencies);

  for (let index = 0; index < dependencyNames.length; index += 1) {
    const dependencyName = dependencyNames[index];
    if (dependencyName === undefined) continue;

    const value = dependencies[dependencyName];
    if (typeof value !== "string") {
      addGraphError(
        errors,
        [...path, INSTALL_DEPENDENCY_FIELD, dependencyName],
        "Expected dependency version string.",
      );
      continue;
    }

    const reference = parseDependencyValue(dependencyName, value);
    if (reference === undefined) {
      addGraphError(
        errors,
        [...path, INSTALL_DEPENDENCY_FIELD, dependencyName],
        "Expected exact dependency reference.",
      );
      continue;
    }

    references[references.length] = reference;
  }

  return references;
}

function upsertRecord(
  records: Map<string, PackageRecord>,
  record: PackageRecord,
  errors: ResolveInstallPlanError[],
): void {
  const key = packageKey(record);
  const existing = records.get(key);

  if (existing === undefined) {
    records.set(key, record);
    return;
  }

  if (sameRecord(existing, record)) {
    return;
  }

  addGraphError(
    errors,
    parsePath(record.path),
    `Conflicting duplicate package record for ${key}.`,
  );
}

function sameRecord(left: PackageRecord, right: PackageRecord): boolean {
  if (
    left.integrity !== right.integrity ||
    left.source !== right.source ||
    left.dependencies.length !== right.dependencies.length
  ) {
    return false;
  }

  for (let index = 0; index < left.dependencies.length; index += 1) {
    const leftDependency = left.dependencies[index];
    const rightDependency = right.dependencies[index];
    if (
      leftDependency === undefined ||
      rightDependency === undefined ||
      leftDependency.name !== rightDependency.name ||
      leftDependency.version !== rightDependency.version
    ) {
      return false;
    }
  }

  return true;
}

function orderInstallSteps(
  roots: readonly PackageReference[],
  records: ReadonlyMap<string, PackageRecord>,
): GraphResult {
  const errors: ResolveInstallPlanError[] = [];
  const states = new Map<string, "visiting" | "visited">();
  const steps: InstallStep[] = [];
  const sortedRoots = sortedReferences(roots);

  for (let index = 0; index < sortedRoots.length; index += 1) {
    const root = sortedRoots[index];
    if (root !== undefined) {
      visitRecord(root, records, states, steps, errors);
    }
  }

  if (errors.length > 0) {
    return reject(errors);
  }

  return {
    ok: true,
    steps,
  };
}

function visitRecord(
  reference: PackageReference,
  records: ReadonlyMap<string, PackageRecord>,
  states: Map<string, "visiting" | "visited">,
  steps: InstallStep[],
  errors: ResolveInstallPlanError[],
): void {
  const key = packageKey(reference);
  const state = states.get(key);

  if (state === "visited") return;
  if (state === "visiting") {
    addGraphError(errors, [], `Dependency cycle includes ${key}.`);
    return;
  }

  const record = records.get(key);
  if (record === undefined) {
    addGraphError(errors, [], `Dependency ${key} does not resolve to a package record.`);
    return;
  }

  states.set(key, "visiting");

  const dependencies = sortedReferences(record.dependencies);
  for (let index = 0; index < dependencies.length; index += 1) {
    const dependency = dependencies[index];
    if (dependency !== undefined) {
      visitRecord(dependency, records, states, steps, errors);
    }
  }

  states.set(key, "visited");
  steps[steps.length] = installStepFromRecord(record);
}

function installStepFromRecord(record: PackageRecord): InstallStep {
  const dependencies = sortedReferences(record.dependencies);

  if (record.source === undefined) {
    return {
      dependencies,
      integrity: record.integrity,
      name: record.name,
      version: record.version,
    };
  }

  return {
    dependencies,
    integrity: record.integrity,
    name: record.name,
    source: record.source,
    version: record.version,
  };
}

function policyForTrustTier(trustTier: TrustTier, contract: PackageContract): BrokerPolicy {
  if (trustTier === "verified") {
    return {
      data: dataPolicyFromVolumes(contract.data.volumes),
      network: {
        egress: copyEgress(contract.network.egress),
        ingress: copyIngress(contract.network.ingress),
      },
    };
  }

  return {
    data: dataPolicyFromVolumes(contract.data.volumes),
    network: {
      egress: [],
      ingress: privateIngress(contract.network.ingress),
    },
  };
}

function dataPolicyFromVolumes(volumes: readonly DataVolumeRequirement[]): readonly DataGrantPolicy[] {
  const policies: DataGrantPolicy[] = [];

  for (let index = 0; index < volumes.length; index += 1) {
    const volume = volumes[index];
    if (volume === undefined) continue;

    policies[policies.length] = {
      access: volume.access,
      class: volume.class,
      scope: volume.name,
    };
  }

  return policies;
}

function privateIngress(rules: readonly NetworkIngressRule[]): readonly NetworkIngressRule[] {
  const allowed: NetworkIngressRule[] = [];

  for (let index = 0; index < rules.length; index += 1) {
    const rule = rules[index];
    if (rule !== undefined && !rule.public) {
      allowed[allowed.length] = rule;
    }
  }

  return allowed;
}

function copyIngress(rules: readonly NetworkIngressRule[]): readonly NetworkIngressRule[] {
  const out: NetworkIngressRule[] = [];

  for (let index = 0; index < rules.length; index += 1) {
    const rule = rules[index];
    if (rule !== undefined) out[out.length] = rule;
  }

  return out;
}

function copyEgress(rules: readonly NetworkEgressRule[]): readonly NetworkEgressRule[] {
  const out: NetworkEgressRule[] = [];

  for (let index = 0; index < rules.length; index += 1) {
    const rule = rules[index];
    if (rule !== undefined) out[out.length] = rule;
  }

  return out;
}

function sourceFrom(entry: PlainJsonObject): string | undefined {
  for (let index = 0; index < SOURCE_FIELDS.length; index += 1) {
    const field = SOURCE_FIELDS[index];
    if (field === undefined) continue;

    const value = entry[field];
    if (typeof value === "string") return value;
  }

  return undefined;
}

function parseDependencyValue(
  dependencyName: string,
  dependencyValue: string,
): PackageReference | undefined {
  if (isExactVersion(dependencyValue) && isPackageName(dependencyName)) {
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
  if (value.startsWith("jsr:")) return parseBarePackageReference(value.slice("jsr:".length));
  if (value.startsWith("npm:")) return parseBarePackageReference(value.slice("npm:".length));
  return parseBarePackageReference(value);
}

function parseSpecifierTarget(
  value: string,
  specifier: PackageReference | undefined,
): PackageReference | undefined {
  const bareReference = parseBarePackageReference(value);
  if (bareReference !== undefined) return bareReference;

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
  if (separator <= 0 || separator === value.length - 1) return undefined;

  const name = value.slice(0, separator);
  const version = value.slice(separator + 1);

  if (!isPackageName(name) || !isExactVersion(version)) return undefined;

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
    if (parts[index] !== "node_modules") return undefined;

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

    if (!isPackageName(packageName)) return undefined;
  }

  return packageName;
}

function sortedReferences(references: readonly PackageReference[]): PackageReference[] {
  const out: PackageReference[] = [];

  for (let index = 0; index < references.length; index += 1) {
    const reference = references[index];
    if (reference !== undefined) {
      out[out.length] = reference;
    }
  }

  out.sort(compareReferences);
  return out;
}

function compareReferences(left: PackageReference, right: PackageReference): number {
  const nameComparison = compareStrings(left.name, right.name);
  if (nameComparison !== 0) return nameComparison;
  return compareStrings(left.version, right.version);
}

function lockfilePolicyError(violation: LockfilePolicyViolation): ResolveInstallPlanError {
  return {
    code: "INVALID_LOCKFILE_POLICY",
    message: violation.message,
    path: violation.path,
  };
}

function capabilityError(denial: CapabilityDenial): ResolveInstallPlanError {
  return {
    code: "CAPABILITY_DENIED",
    message: `${denial.code}: ${denial.reason}`,
    path: "requestedCapabilities",
  };
}

function addGraphError(
  errors: ResolveInstallPlanError[],
  path: Path,
  message: string,
): void {
  errors[errors.length] = error("INVALID_LOCKFILE_GRAPH", path, message);
}

function error(
  code: ResolveInstallPlanError["code"],
  path: Path,
  message: string,
): ResolveInstallPlanError {
  return {
    code,
    message,
    path: formatPath(path),
  };
}

function reject(value: readonly ResolveInstallPlanError[]): {
  readonly ok: false;
  readonly errors: readonly ResolveInstallPlanError[];
} {
  return {
    errors: value,
    ok: false,
  };
}

function exactKeys(value: PlainJsonObject, allowed: readonly string[]): boolean {
  const keys = Object.keys(value);
  if (keys.length !== allowed.length) return false;

  for (let index = 0; index < allowed.length; index += 1) {
    const key = allowed[index];
    if (key === undefined || !Object.hasOwn(value, key)) return false;
  }

  for (let index = 0; index < keys.length; index += 1) {
    const key = keys[index];
    if (key === undefined || !hasString(allowed, key)) return false;
  }

  return true;
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

function formatPath(path: Path): string {
  return path.map(escapePathToken).join("/");
}

function escapePathToken(token: string): string {
  return token.replaceAll("~", "~0").replaceAll("/", "~1");
}

function plainObject(value: PlainJson | undefined): value is PlainJsonObject {
  return value !== undefined && value !== null && typeof value === "object" && !Array.isArray(value);
}

function optionalString(value: PlainJson | undefined): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function nonEmptyString(value: PlainJson | undefined): value is string {
  return typeof value === "string" && value !== "";
}

function dataClass(value: PlainJson | undefined): value is DataClass {
  return typeof value === "string" && DATA_CLASSES.has(value);
}

function accessMode(value: PlainJson | undefined): value is DataGrantPolicy["access"] {
  return typeof value === "string" && ACCESS_MODES.has(value);
}

function protocol(value: PlainJson | undefined): value is NetworkProtocol {
  return typeof value === "string" && NETWORK_PROTOCOLS.has(value);
}

function port(value: PlainJson | undefined): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 65_535;
}

function unknownCapability(name: string): RequestedCapability {
  return {
    kind: "unknown",
    name,
  };
}

function sortedKeys(value: PlainJsonObject): string[] {
  return Object.keys(value).sort(compareStrings);
}

function isExactVersion(value: string): boolean {
  return EXACT_VERSION_PATTERN.test(value);
}

function isPackageName(value: string): boolean {
  return PACKAGE_NAME_PATTERN.test(value);
}

function packageKey(reference: PackageReference): string {
  return `${reference.name}@${reference.version}`;
}

function hasString(values: readonly string[], target: string): boolean {
  for (let index = 0; index < values.length; index += 1) {
    if (values[index] === target) return true;
  }

  return false;
}

function compareStrings(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}
