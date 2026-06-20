import { safeNormalize } from "../../../sdk/typescript/src/safe-normalize.ts";
import type { PlainJson, PlainJsonObject } from "../../../sdk/typescript/src/safe-normalize.ts";
import { validateStorageLayout } from "../../../sdk/typescript/src/storage-model.ts";
import type { StorageLayout } from "../../../sdk/typescript/src/storage-model.ts";
import { validateSimulationProfiles } from "../../profiles/src/profiles.ts";
import type {
  SimulationAcceleratorKind,
  SimulationArchitecture,
  SimulationProfile,
} from "../../profiles/src/profiles.ts";

export interface SimulationResourceVector {
  readonly cpuCores: number;
  readonly memoryMiB: number;
  readonly storageMiB: number;
}

export interface SimulationResourceOverage {
  readonly operationIndex: number;
  readonly resource: keyof SimulationResourceVector;
  readonly requested: number;
  readonly limit: number;
  readonly excess: number;
}

export interface SimulationResourceProjection {
  readonly limits: SimulationResourceVector;
  readonly projected: SimulationResourceVector;
  readonly overBudget: readonly SimulationResourceOverage[];
}

export type SimulationRejectionCode =
  | "INVALID_PROFILE"
  | "INVALID_PLAN"
  | "INVALID_STORAGE_LAYOUT"
  | "MISSING_CAPABILITY"
  | "RESOURCE_LIMIT_EXCEEDED"
  | "STORAGE_LIMIT_EXCEEDED"
  | "UNHEALTHY_STORAGE"
  | "UNSUPPORTED_OPERATION";

export interface SimulationRejection {
  readonly code: SimulationRejectionCode;
  readonly path: string;
  readonly message: string;
  readonly operationIndex?: number;
  readonly operationId?: string;
}

export interface SimulatedOperation {
  readonly index: number;
  readonly kind: string;
  readonly ok: boolean;
  readonly status: "ok" | "rejected";
  readonly resources: {
    readonly requested: SimulationResourceVector;
    readonly projected: SimulationResourceVector;
  };
  readonly rejections: readonly SimulationRejection[];
  readonly id?: string;
}

export interface SimulationResult {
  readonly ok: boolean;
  readonly feasible: boolean;
  readonly operations: readonly SimulatedOperation[];
  readonly rejections: readonly SimulationRejection[];
  readonly resources: SimulationResourceProjection;
}

interface ParsedProfile {
  readonly resources: SimulationResourceVector;
  readonly capabilities: ProfileCapabilities;
  readonly profiles: readonly SimulationProfile[];
  readonly storageLayout?: StorageLayout;
}

interface ProfileCapabilities {
  readonly network: boolean;
  readonly storage: boolean;
  readonly tpm: boolean;
  readonly virtualization: boolean;
  readonly architectures: readonly SimulationArchitecture[];
  readonly accelerators: readonly string[];
  readonly deniedAccelerators: readonly SimulationAcceleratorKind[];
}

interface ParsedPlan {
  readonly operations: readonly ParsedOperation[];
}

interface ParsedOperation {
  readonly index: number;
  readonly kind: string;
  readonly resources: SimulationResourceVector;
  readonly requirements: readonly string[];
  readonly id?: string;
  readonly layout?: StorageLayout;
  readonly storageBytes?: number;
}

type ValidationResult<T> =
  | {
      readonly ok: true;
      readonly value: T;
    }
  | {
      readonly ok: false;
      readonly errors: readonly SimulationRejection[];
    };

type Path = readonly string[];
type ResourceKey = keyof SimulationResourceVector;

const RESOURCE_KEYS = ["cpuCores", "memoryMiB", "storageMiB"] as const satisfies readonly ResourceKey[];
const PROFILE_FIELDS = new Set([
  "id",
  "profiles",
  "simulationProfiles",
  "resources",
  "capabilities",
  "storageLayout",
]);
const PLAN_FIELDS = new Set(["id", "operations"]);
const OPERATION_FIELDS = new Set([
  "id",
  "kind",
  "resources",
  "requires",
  "layout",
  "storageMiB",
  "storageBytes",
]);
const RESOURCE_FIELDS = new Set(RESOURCE_KEYS);
const CAPABILITY_FIELDS = new Set([
  "network",
  "storage",
  "tpm",
  "virtualization",
  "architectures",
  "accelerators",
]);
const REQUIREMENT_FIELDS = new Set([
  "capabilities",
  "network",
  "storage",
  "tpm",
  "virtualization",
  "architecture",
  "accelerator",
  "accelerators",
]);
const KNOWN_OPERATION_KINDS = new Set([
  "architecture",
  "capability",
  "network",
  "resource",
  "storage",
  "workload",
]);
const ARCHITECTURES = new Set<SimulationArchitecture>(["x86_64", "arm64"]);
const MIB = 1_048_576;

const ZERO_RESOURCES: SimulationResourceVector = Object.freeze({
  cpuCores: 0,
  memoryMiB: 0,
  storageMiB: 0,
});

const EMPTY_PROJECTION: SimulationResourceProjection = Object.freeze({
  limits: ZERO_RESOURCES,
  overBudget: Object.freeze([]),
  projected: ZERO_RESOURCES,
});

export function simulate(profile: unknown, plan: unknown): SimulationResult {
  const normalizedProfile = safeNormalize(profile);

  if (!normalizedProfile.ok) {
    return invalidResult("INVALID_PROFILE", [], `Invalid profile input: ${normalizedProfile.reason}`);
  }

  const normalizedPlan = safeNormalize(plan);

  if (!normalizedPlan.ok) {
    return invalidResult("INVALID_PLAN", [], `Invalid plan input: ${normalizedPlan.reason}`);
  }

  const parsedProfile = parseProfile(normalizedProfile.value);

  if (!parsedProfile.ok) {
    return invalidFromErrors(parsedProfile.errors);
  }

  const parsedPlan = parsePlan(normalizedPlan.value);

  if (!parsedPlan.ok) {
    return invalidFromErrors(parsedPlan.errors);
  }

  return evaluatePlan(parsedProfile.value, parsedPlan.value);
}

function parseProfile(value: PlainJson): ValidationResult<ParsedProfile> {
  const errors: SimulationRejection[] = [];

  if (Array.isArray(value)) {
    const profiles = parseSimulationProfileArray(value, [], errors);

    if (profiles === undefined) {
      return reject(errors);
    }

    return accept(projectProfile(ZERO_RESOURCES, defaultCapabilities(), profiles));
  }

  if (!isRecord(value)) {
    addRejection(errors, {
      code: "INVALID_PROFILE",
      message: "Profile must be an object or simulation-profile array.",
      path: "",
    });
    return reject(errors);
  }

  if (hasOwn(value, "kind")) {
    const profiles = parseSimulationProfileArray([value], [], errors);

    if (profiles === undefined) {
      return reject(errors);
    }

    return accept(projectProfile(ZERO_RESOURCES, defaultCapabilities(), profiles));
  }

  rejectUnknownFields(value, PROFILE_FIELDS, [], "INVALID_PROFILE", errors);

  const resources = hasOwn(value, "resources")
    ? readRequiredResourceVector(value["resources"], ["resources"], errors)
    : ZERO_RESOURCES;

  const profiles = readProfileSet(value, errors);
  const storageLayout = hasOwn(value, "storageLayout")
    ? readStorageLayout(value["storageLayout"], ["storageLayout"], "INVALID_PROFILE", errors)
    : undefined;
  const capabilities = hasOwn(value, "capabilities")
    ? readProfileCapabilities(value["capabilities"], ["capabilities"], errors)
    : defaultCapabilities();

  if (errors.length > 0 || resources === undefined || profiles === undefined || capabilities === undefined) {
    return reject(errors);
  }

  const projected = projectProfile(resources, capabilities, profiles, storageLayout);
  return accept(projected);
}

function readProfileSet(
  value: PlainJsonObject,
  errors: SimulationRejection[],
): readonly SimulationProfile[] | undefined {
  const hasProfiles = hasOwn(value, "profiles");
  const hasSimulationProfiles = hasOwn(value, "simulationProfiles");

  if (hasProfiles && hasSimulationProfiles) {
    addRejection(errors, {
      code: "INVALID_PROFILE",
      message: "Profile must declare either profiles or simulationProfiles, not both.",
      path: "profiles",
    });
    return undefined;
  }

  if (hasProfiles) {
    const profiles = value["profiles"];

    if (profiles === undefined) {
      addRejection(errors, {
        code: "INVALID_PROFILE",
        message: "Required field is missing.",
        path: "profiles",
      });
      return undefined;
    }

    return parseSimulationProfileArray(profiles, ["profiles"], errors);
  }

  if (hasSimulationProfiles) {
    const simulationProfiles = value["simulationProfiles"];

    if (simulationProfiles === undefined) {
      addRejection(errors, {
        code: "INVALID_PROFILE",
        message: "Required field is missing.",
        path: "simulationProfiles",
      });
      return undefined;
    }

    return parseSimulationProfileArray(simulationProfiles, ["simulationProfiles"], errors);
  }

  return Object.freeze([]);
}

function parseSimulationProfileArray(
  value: PlainJson,
  path: Path,
  errors: SimulationRejection[],
): readonly SimulationProfile[] | undefined {
  const result = validateSimulationProfiles(value);

  if (result.ok) {
    return Object.freeze([...result.profiles]);
  }

  for (let index = 0; index < result.errors.length; index += 1) {
    const error = result.errors[index];

    if (error !== undefined) {
      addRejection(errors, {
        code: "INVALID_PROFILE",
        message: error.message,
        path: joinPath(path, error.path),
      });
    }
  }

  return undefined;
}

function readRequiredResourceVector(
  value: PlainJson | undefined,
  path: Path,
  errors: SimulationRejection[],
): SimulationResourceVector | undefined {
  if (!isRecord(value)) {
    addRejection(errors, {
      code: "INVALID_PROFILE",
      message: "Expected resource limits object.",
      path: formatPath(path),
    });
    return undefined;
  }

  rejectUnknownFields(value, RESOURCE_FIELDS, path, "INVALID_PROFILE", errors);

  const cpuCores = readNumber(value, "cpuCores", [...path, "cpuCores"], true, "INVALID_PROFILE", errors);
  const memoryMiB = readInteger(value, "memoryMiB", [...path, "memoryMiB"], true, "INVALID_PROFILE", errors);
  const storageMiB = readInteger(value, "storageMiB", [...path, "storageMiB"], true, "INVALID_PROFILE", errors);

  if (cpuCores === undefined || memoryMiB === undefined || storageMiB === undefined) {
    return undefined;
  }

  return freezeResources({
    cpuCores,
    memoryMiB,
    storageMiB,
  });
}

function readOperationResources(
  value: PlainJson | undefined,
  path: Path,
  errors: SimulationRejection[],
): SimulationResourceVector | undefined {
  if (!isRecord(value)) {
    addRejection(errors, {
      code: "INVALID_PLAN",
      message: "Expected operation resources object.",
      path: formatPath(path),
    });
    return undefined;
  }

  rejectUnknownFields(value, RESOURCE_FIELDS, path, "INVALID_PLAN", errors);

  const cpuCores = hasOwn(value, "cpuCores")
    ? readNumber(value, "cpuCores", [...path, "cpuCores"], false, "INVALID_PLAN", errors)
    : 0;
  const memoryMiB = hasOwn(value, "memoryMiB")
    ? readInteger(value, "memoryMiB", [...path, "memoryMiB"], false, "INVALID_PLAN", errors)
    : 0;
  const storageMiB = hasOwn(value, "storageMiB")
    ? readInteger(value, "storageMiB", [...path, "storageMiB"], false, "INVALID_PLAN", errors)
    : 0;

  if (cpuCores === undefined || memoryMiB === undefined || storageMiB === undefined) {
    return undefined;
  }

  return freezeResources({
    cpuCores,
    memoryMiB,
    storageMiB,
  });
}

function readProfileCapabilities(
  value: PlainJson | undefined,
  path: Path,
  errors: SimulationRejection[],
): ProfileCapabilities | undefined {
  if (!isRecord(value)) {
    addRejection(errors, {
      code: "INVALID_PROFILE",
      message: "Expected capabilities object.",
      path: formatPath(path),
    });
    return undefined;
  }

  rejectUnknownFields(value, CAPABILITY_FIELDS, path, "INVALID_PROFILE", errors);

  const network = hasOwn(value, "network")
    ? readBoolean(value, "network", [...path, "network"], "INVALID_PROFILE", errors)
    : false;
  const storage = hasOwn(value, "storage")
    ? readBoolean(value, "storage", [...path, "storage"], "INVALID_PROFILE", errors)
    : false;
  const tpm = hasOwn(value, "tpm")
    ? readBoolean(value, "tpm", [...path, "tpm"], "INVALID_PROFILE", errors)
    : false;
  const virtualization = hasOwn(value, "virtualization")
    ? readBoolean(value, "virtualization", [...path, "virtualization"], "INVALID_PROFILE", errors)
    : false;
  const architectures = hasOwn(value, "architectures")
    ? readArchitectureArray(value["architectures"], [...path, "architectures"], "INVALID_PROFILE", errors)
    : Object.freeze([]);
  const accelerators = hasOwn(value, "accelerators")
    ? readAcceleratorArray(value["accelerators"], [...path, "accelerators"], errors)
    : Object.freeze([]);

  if (
    network === undefined ||
    storage === undefined ||
    tpm === undefined ||
    virtualization === undefined ||
    architectures === undefined ||
    accelerators === undefined
  ) {
    return undefined;
  }

  return freezeCapabilities({
    accelerators,
    architectures,
    deniedAccelerators: Object.freeze([]),
    network,
    storage,
    tpm,
    virtualization,
  });
}

function readArchitectureArray(
  value: PlainJson | undefined,
  path: Path,
  code: SimulationRejectionCode,
  errors: SimulationRejection[],
): readonly SimulationArchitecture[] | undefined {
  if (!Array.isArray(value)) {
    addRejection(errors, {
      code,
      message: "Expected architecture array.",
      path: formatPath(path),
    });
    return undefined;
  }

  const architectures: SimulationArchitecture[] = [];

  for (let index = 0; index < value.length; index += 1) {
    const item = value[index];

    if (!isArchitecture(item)) {
      addRejection(errors, {
        code,
        message: "Expected architecture x86_64 or arm64.",
        path: formatPath([...path, String(index)]),
      });
      continue;
    }

    pushUnique(architectures, item);
  }

  return errorsForPath(errors, path, code) ? undefined : Object.freeze(architectures);
}

function readAcceleratorArray(
  value: PlainJson | undefined,
  path: Path,
  errors: SimulationRejection[],
): readonly string[] | undefined {
  if (!Array.isArray(value)) {
    addRejection(errors, {
      code: "INVALID_PROFILE",
      message: "Expected accelerator array.",
      path: formatPath(path),
    });
    return undefined;
  }

  const accelerators: string[] = [];

  for (let index = 0; index < value.length; index += 1) {
    const item = value[index];
    const itemPath = [...path, String(index)];

    if (typeof item === "string" && item !== "") {
      pushUnique(accelerators, normalizeAcceleratorName(item));
      continue;
    }

    if (isRecord(item)) {
      const kind = item["kind"];

      if (typeof kind === "string" && kind !== "") {
        pushUnique(accelerators, normalizeAcceleratorName(kind));
        continue;
      }
    }

    addRejection(errors, {
      code: "INVALID_PROFILE",
      message: "Expected accelerator string or capability object with kind.",
      path: formatPath(itemPath),
    });
  }

  return errorsForPath(errors, path, "INVALID_PROFILE") ? undefined : Object.freeze(accelerators);
}

function readStorageLayout(
  value: PlainJson | undefined,
  path: Path,
  code: "INVALID_PROFILE" | "INVALID_STORAGE_LAYOUT",
  errors: SimulationRejection[],
): StorageLayout | undefined {
  const result = validateStorageLayout(value);

  if (result.ok) {
    return result.layout;
  }

  for (let index = 0; index < result.errors.length; index += 1) {
    const error = result.errors[index];

    if (error !== undefined) {
      addRejection(errors, {
        code,
        message: error.message,
        path: joinPath(path, error.path),
      });
    }
  }

  return undefined;
}

function projectProfile(
  resources: SimulationResourceVector,
  capabilities: ProfileCapabilities,
  profiles: readonly SimulationProfile[],
  storageLayout?: StorageLayout,
): ParsedProfile {
  let projectedResources = resources;
  let projectedCapabilities = capabilities;

  for (let index = 0; index < profiles.length; index += 1) {
    const profile = profiles[index];

    if (profile === undefined) {
      continue;
    }

    if (profile.kind === "low-memory") {
      projectedResources = freezeResources({
        ...projectedResources,
        memoryMiB:
          projectedResources.memoryMiB === 0
            ? profile.memoryMiB
            : Math.min(projectedResources.memoryMiB, profile.memoryMiB),
      });
    } else if (profile.kind === "offline" || profile.kind === "network-partition") {
      projectedCapabilities = freezeCapabilities({
        ...projectedCapabilities,
        network: false,
      });
    } else if (profile.kind === "no-accelerator") {
      projectedCapabilities = freezeCapabilities({
        ...projectedCapabilities,
        deniedAccelerators: mergeAcceleratorKinds(
          projectedCapabilities.deniedAccelerators,
          profile.accelerators,
        ),
      });
    } else if (profile.kind === "architecture-migration") {
      projectedCapabilities = freezeCapabilities({
        ...projectedCapabilities,
        architectures: mergeArchitectures(projectedCapabilities.architectures, [
          profile.from,
          profile.to,
        ]),
      });
    }
  }

  if (storageLayout !== undefined) {
    const freeMiB = bytesToMiB(storageLayout.diskHealth.freeBytes);
    const storageMiB =
      projectedResources.storageMiB === 0 ? freeMiB : Math.min(projectedResources.storageMiB, freeMiB);

    projectedResources = freezeResources({
      ...projectedResources,
      storageMiB,
    });

    if (!projectedCapabilities.storage) {
      projectedCapabilities = freezeCapabilities({
        ...projectedCapabilities,
        storage: true,
      });
    }
  }

  const output: {
    readonly resources: SimulationResourceVector;
    readonly capabilities: ProfileCapabilities;
    readonly profiles: readonly SimulationProfile[];
    readonly storageLayout?: StorageLayout;
  } = storageLayout === undefined
    ? {
        capabilities: projectedCapabilities,
        profiles,
        resources: projectedResources,
      }
    : {
        capabilities: projectedCapabilities,
        profiles,
        resources: projectedResources,
        storageLayout,
      };

  return Object.freeze(output);
}

function parsePlan(value: PlainJson): ValidationResult<ParsedPlan> {
  const errors: SimulationRejection[] = [];

  if (!isRecord(value)) {
    addRejection(errors, {
      code: "INVALID_PLAN",
      message: "Plan must be an object.",
      path: "",
    });
    return reject(errors);
  }

  rejectUnknownFields(value, PLAN_FIELDS, [], "INVALID_PLAN", errors);

  if (!hasOwn(value, "operations")) {
    addRejection(errors, {
      code: "INVALID_PLAN",
      message: "Plan operations are required.",
      path: "operations",
    });
    return reject(errors);
  }

  const operations = value["operations"];

  if (!Array.isArray(operations)) {
    addRejection(errors, {
      code: "INVALID_PLAN",
      message: "Plan operations must be an array.",
      path: "operations",
    });
    return reject(errors);
  }

  const parsed: ParsedOperation[] = [];

  for (let index = 0; index < operations.length; index += 1) {
    const operation = parseOperation(operations[index], index, ["operations", String(index)], errors);

    if (operation !== undefined) {
      parsed[index] = operation;
    }
  }

  if (errors.length > 0) {
    return reject(errors);
  }

  return accept({
    operations: Object.freeze(parsed),
  });
}

function parseOperation(
  value: PlainJson | undefined,
  index: number,
  path: Path,
  errors: SimulationRejection[],
): ParsedOperation | undefined {
  if (!isRecord(value)) {
    addRejection(errors, {
      code: "INVALID_PLAN",
      message: "Operation must be an object.",
      path: formatPath(path),
      operationIndex: index,
    });
    return undefined;
  }

  rejectUnknownFields(value, OPERATION_FIELDS, path, "INVALID_PLAN", errors);

  const kind = readRequiredString(value, "kind", [...path, "kind"], "INVALID_PLAN", errors);
  const id = hasOwn(value, "id")
    ? readRequiredString(value, "id", [...path, "id"], "INVALID_PLAN", errors)
    : undefined;
  const baseResources = hasOwn(value, "resources")
    ? readOperationResources(value["resources"], [...path, "resources"], errors)
    : ZERO_RESOURCES;
  const requirements = hasOwn(value, "requires")
    ? readRequirements(value["requires"], [...path, "requires"], errors)
    : Object.freeze([]);
  const storageMiB = hasOwn(value, "storageMiB")
    ? readInteger(value, "storageMiB", [...path, "storageMiB"], false, "INVALID_PLAN", errors)
    : 0;
  const storageBytes = hasOwn(value, "storageBytes")
    ? readInteger(value, "storageBytes", [...path, "storageBytes"], false, "INVALID_PLAN", errors)
    : undefined;
  const layout = hasOwn(value, "layout")
    ? readStorageLayout(value["layout"], [...path, "layout"], "INVALID_STORAGE_LAYOUT", errors)
    : undefined;

  if (kind === undefined || baseResources === undefined || requirements === undefined || storageMiB === undefined) {
    return undefined;
  }

  const resources = freezeResources({
    ...baseResources,
    storageMiB: baseResources.storageMiB + storageMiB,
  });
  const output: {
    readonly index: number;
    readonly kind: string;
    readonly resources: SimulationResourceVector;
    readonly requirements: readonly string[];
    readonly id?: string;
    readonly layout?: StorageLayout;
    readonly storageBytes?: number;
  } = buildParsedOperation(index, kind, resources, requirements, id, layout, storageBytes);

  return Object.freeze(output);
}

function buildParsedOperation(
  index: number,
  kind: string,
  resources: SimulationResourceVector,
  requirements: readonly string[],
  id: string | undefined,
  layout: StorageLayout | undefined,
  storageBytes: number | undefined,
): ParsedOperation {
  let operation: ParsedOperation = Object.freeze({
    index,
    kind,
    requirements,
    resources,
  });

  if (id !== undefined) {
    operation = Object.freeze({
      ...operation,
      id,
    });
  }

  if (layout !== undefined) {
    operation = Object.freeze({
      ...operation,
      layout,
    });
  }

  if (storageBytes !== undefined) {
    operation = Object.freeze({
      ...operation,
      storageBytes,
    });
  }

  return operation;
}

function readRequirements(
  value: PlainJson | undefined,
  path: Path,
  errors: SimulationRejection[],
): readonly string[] | undefined {
  if (!isRecord(value)) {
    addRejection(errors, {
      code: "INVALID_PLAN",
      message: "Expected requirements object.",
      path: formatPath(path),
    });
    return undefined;
  }

  rejectUnknownFields(value, REQUIREMENT_FIELDS, path, "INVALID_PLAN", errors);

  const requirements: string[] = [];

  if (hasOwn(value, "capabilities")) {
    readRequirementStringArray(value["capabilities"], [...path, "capabilities"], requirements, errors);
  }

  readBooleanRequirement(value, "network", "network", path, requirements, errors);
  readBooleanRequirement(value, "storage", "storage", path, requirements, errors);
  readBooleanRequirement(value, "tpm", "tpm", path, requirements, errors);
  readBooleanRequirement(value, "virtualization", "virtualization", path, requirements, errors);

  if (hasOwn(value, "architecture")) {
    const architecture = readRequiredString(
      value,
      "architecture",
      [...path, "architecture"],
      "INVALID_PLAN",
      errors,
    );

    if (architecture !== undefined) {
      pushUnique(requirements, `architecture:${architecture}`);
    }
  }

  if (hasOwn(value, "accelerator")) {
    const accelerator = readRequiredString(
      value,
      "accelerator",
      [...path, "accelerator"],
      "INVALID_PLAN",
      errors,
    );

    if (accelerator !== undefined) {
      pushUnique(requirements, `accelerator:${normalizeAcceleratorName(accelerator)}`);
    }
  }

  if (hasOwn(value, "accelerators")) {
    const accelerators = readStringArray(value["accelerators"], [...path, "accelerators"], "INVALID_PLAN", errors);

    if (accelerators !== undefined) {
      for (let index = 0; index < accelerators.length; index += 1) {
        const accelerator = accelerators[index];

        if (accelerator !== undefined) {
          pushUnique(requirements, `accelerator:${normalizeAcceleratorName(accelerator)}`);
        }
      }
    }
  }

  return errorsForPath(errors, path, "INVALID_PLAN") ? undefined : Object.freeze(requirements);
}

function readRequirementStringArray(
  value: PlainJson | undefined,
  path: Path,
  output: string[],
  errors: SimulationRejection[],
): void {
  const capabilities = readStringArray(value, path, "INVALID_PLAN", errors);

  if (capabilities === undefined) {
    return;
  }

  for (let index = 0; index < capabilities.length; index += 1) {
    const capability = capabilities[index];

    if (capability !== undefined) {
      pushUnique(output, normalizeCapabilityName(capability));
    }
  }
}

function readBooleanRequirement(
  value: PlainJsonObject,
  key: string,
  capability: string,
  path: Path,
  output: string[],
  errors: SimulationRejection[],
): void {
  if (!hasOwn(value, key)) {
    return;
  }

  const required = readBoolean(value, key, [...path, key], "INVALID_PLAN", errors);

  if (required === true) {
    pushUnique(output, capability);
  }
}

function evaluatePlan(profile: ParsedProfile, plan: ParsedPlan): SimulationResult {
  const operations: SimulatedOperation[] = [];
  const allRejections: SimulationRejection[] = [];
  const overBudget: SimulationResourceOverage[] = [];
  let projected = ZERO_RESOURCES;

  for (let index = 0; index < plan.operations.length; index += 1) {
    const operation = plan.operations[index];

    if (operation === undefined) {
      continue;
    }

    const requested = operationResources(operation);
    const nextProjected = addResources(projected, requested);
    const operationRejections: SimulationRejection[] = [];

    rejectUnsupportedOperation(operation, operationRejections);
    rejectMissingCapabilities(profile, operation, operationRejections);
    rejectResourceOverages(profile, operation, nextProjected, operationRejections, overBudget);
    rejectStorageIssues(profile, operation, requested, operationRejections);

    const frozenRejections = Object.freeze(operationRejections);

    for (let rejectionIndex = 0; rejectionIndex < frozenRejections.length; rejectionIndex += 1) {
      const rejection = frozenRejections[rejectionIndex];

      if (rejection !== undefined) {
        allRejections[allRejections.length] = rejection;
      }
    }

    operations[operations.length] = freezeOperation({
      index: operation.index,
      kind: operation.kind,
      ok: frozenRejections.length === 0,
      rejections: frozenRejections,
      resources: Object.freeze({
        projected: nextProjected,
        requested,
      }),
      status: frozenRejections.length === 0 ? "ok" : "rejected",
    }, operation.id);

    projected = nextProjected;
  }

  const frozenOperations = Object.freeze(operations);
  const frozenRejections = Object.freeze(allRejections);

  return Object.freeze({
    feasible: frozenRejections.length === 0,
    ok: true,
    operations: frozenOperations,
    rejections: frozenRejections,
    resources: Object.freeze({
      limits: profile.resources,
      overBudget: Object.freeze(overBudget),
      projected,
    }),
  });
}

function rejectUnsupportedOperation(
  operation: ParsedOperation,
  rejections: SimulationRejection[],
): void {
  if (KNOWN_OPERATION_KINDS.has(operation.kind)) {
    return;
  }

  addOperationRejection(rejections, operation, {
    code: "UNSUPPORTED_OPERATION",
    message: `Operation kind "${operation.kind}" cannot be evaluated.`,
    path: operationPath(operation, "kind"),
  });
}

function rejectMissingCapabilities(
  profile: ParsedProfile,
  operation: ParsedOperation,
  rejections: SimulationRejection[],
): void {
  for (let index = 0; index < operation.requirements.length; index += 1) {
    const requirement = operation.requirements[index];

    if (requirement !== undefined && !hasCapability(profile, requirement)) {
      addOperationRejection(rejections, operation, {
        code: "MISSING_CAPABILITY",
        message: `Profile does not provide required capability "${requirement}".`,
        path: operationPath(operation, "requires"),
      });
    }
  }
}

function rejectResourceOverages(
  profile: ParsedProfile,
  operation: ParsedOperation,
  projected: SimulationResourceVector,
  rejections: SimulationRejection[],
  overBudget: SimulationResourceOverage[],
): void {
  for (let index = 0; index < RESOURCE_KEYS.length; index += 1) {
    const resource = RESOURCE_KEYS[index];

    if (resource === undefined) {
      continue;
    }

    const requested = projected[resource];
    const limit = profile.resources[resource];

    if (requested > limit) {
      const overage = Object.freeze({
        excess: requested - limit,
        limit,
        operationIndex: operation.index,
        requested,
        resource,
      });

      overBudget[overBudget.length] = overage;
      addOperationRejection(rejections, operation, {
        code: "RESOURCE_LIMIT_EXCEEDED",
        message: `${resource} projection ${requested} exceeds profile limit ${limit}.`,
        path: operationPath(operation, `resources/${resource}`),
      });
    }
  }
}

function rejectStorageIssues(
  profile: ParsedProfile,
  operation: ParsedOperation,
  requested: SimulationResourceVector,
  rejections: SimulationRejection[],
): void {
  if (operation.kind !== "storage") {
    return;
  }

  if (!profile.capabilities.storage) {
    addOperationRejection(rejections, operation, {
      code: "MISSING_CAPABILITY",
      message: "Profile does not provide storage capability.",
      path: operationPath(operation, "requires/storage"),
    });
  }

  if (operation.layout === undefined) {
    addOperationRejection(rejections, operation, {
      code: "UNSUPPORTED_OPERATION",
      message: "Storage operation requires a validated layout.",
      path: operationPath(operation, "layout"),
    });
  } else {
    rejectUnhealthyLayout(
      operation.layout,
      operation,
      "Operation storage layout",
      operationPath(operation, "layout"),
      rejections,
    );
  }

  if (profile.storageLayout === undefined) {
    addOperationRejection(rejections, operation, {
      code: "UNSUPPORTED_OPERATION",
      message: "Storage operation cannot be evaluated without profile storageLayout.",
      path: "storageLayout",
    });
    return;
  }

  rejectUnhealthyLayout(
    profile.storageLayout,
    operation,
    "Profile storage layout",
    "storageLayout",
    rejections,
  );

  const requestedBytes = operationStorageBytes(operation, requested);

  if (requestedBytes > profile.storageLayout.diskHealth.freeBytes) {
    addOperationRejection(rejections, operation, {
      code: "STORAGE_LIMIT_EXCEEDED",
      message:
        `Storage operation requests ${requestedBytes} bytes but profile has ` +
        `${profile.storageLayout.diskHealth.freeBytes} free bytes.`,
      path: operationPath(operation, "layout/diskHealth/usedBytes"),
    });
  }
}

function rejectUnhealthyLayout(
  layout: StorageLayout,
  operation: ParsedOperation,
  label: string,
  pathPrefix: string,
  rejections: SimulationRejection[],
): void {
  if (layout.diskHealth.status === "critical") {
    addOperationRejection(rejections, operation, {
      code: "UNHEALTHY_STORAGE",
      message: `${label} is critical.`,
      path: `${pathPrefix}/diskHealth/status`,
    });
  }

  if (layout.diskHealth.smart.status === "failed") {
    addOperationRejection(rejections, operation, {
      code: "UNHEALTHY_STORAGE",
      message: `${label} SMART status failed.`,
      path: `${pathPrefix}/diskHealth/smart/status`,
    });
  }
}

function operationResources(operation: ParsedOperation): SimulationResourceVector {
  let storageMiB = operation.resources.storageMiB;

  if (operation.storageBytes !== undefined) {
    storageMiB += bytesToMiB(operation.storageBytes);
  }

  if (operation.kind === "storage" && operation.layout !== undefined && storageMiB === 0) {
    storageMiB = bytesToMiB(operation.layout.diskHealth.usedBytes);
  }

  return freezeResources({
    cpuCores: operation.resources.cpuCores,
    memoryMiB: operation.resources.memoryMiB,
    storageMiB,
  });
}

function operationStorageBytes(operation: ParsedOperation, requested: SimulationResourceVector): number {
  if (operation.storageBytes !== undefined) {
    return operation.storageBytes;
  }

  if (operation.layout !== undefined && operation.resources.storageMiB === 0) {
    return operation.layout.diskHealth.usedBytes;
  }

  return requested.storageMiB * MIB;
}

function hasCapability(profile: ParsedProfile, capability: string): boolean {
  const normalized = normalizeCapabilityName(capability);

  if (normalized === "network") {
    return profile.capabilities.network;
  }

  if (normalized === "storage") {
    return profile.capabilities.storage;
  }

  if (normalized === "tpm") {
    return profile.capabilities.tpm;
  }

  if (normalized === "virtualization") {
    return profile.capabilities.virtualization;
  }

  if (normalized.startsWith("architecture:")) {
    const architecture = normalized.slice("architecture:".length);
    return includesString(profile.capabilities.architectures, architecture);
  }

  if (normalized.startsWith("accelerator:")) {
    const accelerator = normalized.slice("accelerator:".length);

    if (isDeniedAccelerator(profile.capabilities.deniedAccelerators, accelerator)) {
      return false;
    }

    return includesAccelerator(profile.capabilities.accelerators, accelerator);
  }

  return false;
}

function isDeniedAccelerator(
  denied: readonly SimulationAcceleratorKind[],
  accelerator: string,
): boolean {
  if (accelerator === "gpu" || accelerator === "npu") {
    return includesString(denied, accelerator);
  }

  if (isGpuAccelerator(accelerator) && includesString(denied, "gpu")) {
    return true;
  }

  if (isNpuAccelerator(accelerator) && includesString(denied, "npu")) {
    return true;
  }

  return false;
}

function includesAccelerator(available: readonly string[], accelerator: string): boolean {
  if (includesString(available, accelerator)) {
    return true;
  }

  if (accelerator === "gpu") {
    return hasSomeGpu(available);
  }

  if (accelerator === "npu") {
    return hasSomeNpu(available);
  }

  if (isGpuAccelerator(accelerator)) {
    return includesString(available, "gpu");
  }

  if (isNpuAccelerator(accelerator)) {
    return includesString(available, "npu");
  }

  return false;
}

function hasSomeGpu(available: readonly string[]): boolean {
  for (let index = 0; index < available.length; index += 1) {
    const accelerator = available[index];

    if (accelerator !== undefined && isGpuAccelerator(accelerator)) {
      return true;
    }
  }

  return false;
}

function hasSomeNpu(available: readonly string[]): boolean {
  for (let index = 0; index < available.length; index += 1) {
    const accelerator = available[index];

    if (accelerator !== undefined && isNpuAccelerator(accelerator)) {
      return true;
    }
  }

  return false;
}

function isGpuAccelerator(value: string): boolean {
  return value === "gpu" || value === "nvidia.cuda" || value === "amd.rocm" || value === "intel.gpu";
}

function isNpuAccelerator(value: string): boolean {
  return value === "npu" || value === "intel.npu" || value === "amd.npu";
}

function invalidResult(
  code: "INVALID_PROFILE" | "INVALID_PLAN",
  path: Path,
  message: string,
): SimulationResult {
  return invalidFromErrors([
    Object.freeze({
      code,
      message,
      path: formatPath(path),
    }),
  ]);
}

function invalidFromErrors(errors: readonly SimulationRejection[]): SimulationResult {
  return Object.freeze({
    feasible: false,
    ok: false,
    operations: Object.freeze([]),
    rejections: Object.freeze([...errors]),
    resources: EMPTY_PROJECTION,
  });
}

function accept<T>(value: T): ValidationResult<T> {
  return {
    ok: true,
    value,
  };
}

function reject<T>(errors: readonly SimulationRejection[]): ValidationResult<T> {
  return {
    errors,
    ok: false,
  };
}

function freezeOperation(
  operation: Omit<SimulatedOperation, "id">,
  id: string | undefined,
): SimulatedOperation {
  if (id === undefined) {
    return Object.freeze(operation);
  }

  return Object.freeze({
    ...operation,
    id,
  });
}

function addOperationRejection(
  rejections: SimulationRejection[],
  operation: ParsedOperation,
  rejection: Omit<SimulationRejection, "operationIndex" | "operationId">,
): void {
  const withIndex: SimulationRejection = operation.id === undefined
    ? Object.freeze({
        ...rejection,
        operationIndex: operation.index,
      })
    : Object.freeze({
        ...rejection,
        operationId: operation.id,
        operationIndex: operation.index,
      });

  rejections[rejections.length] = withIndex;
}

function addRejection(
  errors: SimulationRejection[],
  rejection: SimulationRejection,
): void {
  errors[errors.length] = Object.freeze(rejection);
}

function rejectUnknownFields(
  value: PlainJsonObject,
  allowed: ReadonlySet<string>,
  path: Path,
  code: "INVALID_PROFILE" | "INVALID_PLAN",
  errors: SimulationRejection[],
): void {
  const keys = Object.keys(value).sort(compareStrings);

  for (let index = 0; index < keys.length; index += 1) {
    const key = keys[index];

    if (key !== undefined && !allowed.has(key)) {
      addRejection(errors, {
        code,
        message: "Unknown field.",
        path: formatPath([...path, key]),
      });
    }
  }
}

function readRequiredString(
  value: PlainJsonObject,
  key: string,
  path: Path,
  code: "INVALID_PLAN",
  errors: SimulationRejection[],
): string | undefined {
  if (!hasOwn(value, key)) {
    addRejection(errors, {
      code,
      message: "Required field is missing.",
      path: formatPath(path),
    });
    return undefined;
  }

  const child = value[key];

  if (typeof child !== "string" || child === "") {
    addRejection(errors, {
      code,
      message: "Expected non-empty string.",
      path: formatPath(path),
    });
    return undefined;
  }

  return child;
}

function readStringArray(
  value: PlainJson | undefined,
  path: Path,
  code: "INVALID_PLAN",
  errors: SimulationRejection[],
): readonly string[] | undefined {
  if (!Array.isArray(value)) {
    addRejection(errors, {
      code,
      message: "Expected string array.",
      path: formatPath(path),
    });
    return undefined;
  }

  const output: string[] = [];

  for (let index = 0; index < value.length; index += 1) {
    const item = value[index];

    if (typeof item !== "string" || item === "") {
      addRejection(errors, {
        code,
        message: "Expected non-empty string.",
        path: formatPath([...path, String(index)]),
      });
      continue;
    }

    output[output.length] = item;
  }

  return errorsForPath(errors, path, code) ? undefined : Object.freeze(output);
}

function readBoolean(
  value: PlainJsonObject,
  key: string,
  path: Path,
  code: "INVALID_PROFILE" | "INVALID_PLAN",
  errors: SimulationRejection[],
): boolean | undefined {
  const child = value[key];

  if (typeof child !== "boolean") {
    addRejection(errors, {
      code,
      message: "Expected boolean.",
      path: formatPath(path),
    });
    return undefined;
  }

  return child;
}

function readNumber(
  value: PlainJsonObject,
  key: ResourceKey,
  path: Path,
  required: boolean,
  code: "INVALID_PROFILE" | "INVALID_PLAN",
  errors: SimulationRejection[],
): number | undefined {
  if (!hasOwn(value, key)) {
    if (required) {
      addRejection(errors, {
        code,
        message: "Required field is missing.",
        path: formatPath(path),
      });
    }

    return undefined;
  }

  const child = value[key];

  if (typeof child !== "number" || !Number.isFinite(child) || child < 0) {
    addRejection(errors, {
      code,
      message: "Expected non-negative finite number.",
      path: formatPath(path),
    });
    return undefined;
  }

  return child;
}

function readInteger(
  value: PlainJsonObject,
  key: string,
  path: Path,
  required: boolean,
  code: "INVALID_PROFILE" | "INVALID_PLAN",
  errors: SimulationRejection[],
): number | undefined {
  if (!hasOwn(value, key)) {
    if (required) {
      addRejection(errors, {
        code,
        message: "Required field is missing.",
        path: formatPath(path),
      });
    }

    return undefined;
  }

  const child = value[key];

  if (
    typeof child !== "number" ||
    !Number.isSafeInteger(child) ||
    child < 0
  ) {
    addRejection(errors, {
      code,
      message: "Expected non-negative safe integer.",
      path: formatPath(path),
    });
    return undefined;
  }

  return child;
}

function defaultCapabilities(): ProfileCapabilities {
  return Object.freeze({
    accelerators: Object.freeze([]),
    architectures: Object.freeze([]),
    deniedAccelerators: Object.freeze([]),
    network: false,
    storage: false,
    tpm: false,
    virtualization: false,
  });
}

function freezeCapabilities(capabilities: ProfileCapabilities): ProfileCapabilities {
  return Object.freeze({
    accelerators: Object.freeze([...capabilities.accelerators].sort(compareStrings)),
    architectures: Object.freeze([...capabilities.architectures].sort(compareStrings)),
    deniedAccelerators: Object.freeze([...capabilities.deniedAccelerators].sort(compareStrings)),
    network: capabilities.network,
    storage: capabilities.storage,
    tpm: capabilities.tpm,
    virtualization: capabilities.virtualization,
  });
}

function freezeResources(resources: SimulationResourceVector): SimulationResourceVector {
  return Object.freeze({
    cpuCores: resources.cpuCores,
    memoryMiB: resources.memoryMiB,
    storageMiB: resources.storageMiB,
  });
}

function addResources(
  left: SimulationResourceVector,
  right: SimulationResourceVector,
): SimulationResourceVector {
  return freezeResources({
    cpuCores: left.cpuCores + right.cpuCores,
    memoryMiB: left.memoryMiB + right.memoryMiB,
    storageMiB: left.storageMiB + right.storageMiB,
  });
}

function mergeArchitectures(
  left: readonly SimulationArchitecture[],
  right: readonly SimulationArchitecture[],
): readonly SimulationArchitecture[] {
  const merged: SimulationArchitecture[] = [...left];

  for (let index = 0; index < right.length; index += 1) {
    const architecture = right[index];

    if (architecture !== undefined) {
      pushUnique(merged, architecture);
    }
  }

  return Object.freeze(merged.sort(compareStrings));
}

function mergeAcceleratorKinds(
  left: readonly SimulationAcceleratorKind[],
  right: readonly SimulationAcceleratorKind[],
): readonly SimulationAcceleratorKind[] {
  const merged: SimulationAcceleratorKind[] = [...left];

  for (let index = 0; index < right.length; index += 1) {
    const accelerator = right[index];

    if (accelerator !== undefined) {
      pushUnique(merged, accelerator);
    }
  }

  return Object.freeze(merged.sort(compareStrings));
}

function normalizeCapabilityName(value: string): string {
  if (value === "gpu" || value === "npu") {
    return `accelerator:${value}`;
  }

  if (isGpuAccelerator(value) || isNpuAccelerator(value)) {
    return `accelerator:${normalizeAcceleratorName(value)}`;
  }

  return value;
}

function normalizeAcceleratorName(value: string): string {
  return value.startsWith("accelerator:") ? value.slice("accelerator:".length) : value;
}

function isArchitecture(value: PlainJson | undefined): value is SimulationArchitecture {
  return typeof value === "string" && ARCHITECTURES.has(value as SimulationArchitecture);
}

function bytesToMiB(value: number): number {
  return Math.ceil(value / MIB);
}

function errorsForPath(
  errors: readonly SimulationRejection[],
  path: Path,
  code: SimulationRejectionCode,
): boolean {
  const formatted = formatPath(path);

  for (let index = 0; index < errors.length; index += 1) {
    const error = errors[index];

    if (error !== undefined && error.code === code && pathStartsWith(error.path, formatted)) {
      return true;
    }
  }

  return false;
}

function pathStartsWith(path: string, prefix: string): boolean {
  return prefix === "" || path === prefix || path.startsWith(`${prefix}/`);
}

function includesString(values: readonly string[], value: string): boolean {
  for (let index = 0; index < values.length; index += 1) {
    if (values[index] === value) {
      return true;
    }
  }

  return false;
}

function pushUnique<T extends string>(values: T[], value: T): void {
  if (!includesString(values, value)) {
    values[values.length] = value;
  }
}

function isRecord(value: PlainJson | undefined): value is PlainJsonObject {
  return value !== null && value !== undefined && typeof value === "object" && !Array.isArray(value);
}

function hasOwn(value: PlainJsonObject, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function operationPath(operation: ParsedOperation, suffix: string): string {
  return `operations/${operation.index}/${suffix}`;
}

function joinPath(prefix: Path, suffix: string): string {
  const formattedPrefix = formatPath(prefix);

  if (formattedPrefix === "") {
    return suffix;
  }

  if (suffix === "") {
    return formattedPrefix;
  }

  return `${formattedPrefix}/${suffix}`;
}

function formatPath(path: Path): string {
  const tokens: string[] = [];

  for (let index = 0; index < path.length; index += 1) {
    const token = path[index];

    if (token !== undefined) {
      tokens[tokens.length] = escapePathToken(token);
    }
  }

  return tokens.join("/");
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
