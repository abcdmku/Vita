import { safeNormalize } from "../../../sdk/typescript/src/safe-normalize.ts";
import { isAgentClientError } from "../../agent-client/src/agent-client.ts";
import type {
  AgentAcceleratorCapability,
  AgentAcceleratorKind,
  AgentCapabilities,
  AgentClient,
  AgentCpuCapabilities,
  AgentDetectedDevice,
  AgentHealth,
  AgentMemoryCapabilities,
  AgentNetworkInterface,
  AgentNetworkingCapabilities,
  AgentStorageDevice,
  AgentTpmCapabilities,
  AgentVirtualizationCapabilities,
} from "../../agent-client/src/agent-client.ts";
import type {
  PlainJson,
  PlainJsonObject,
} from "../../../sdk/typescript/src/safe-normalize.ts";

export type NodeOverviewStatus = "ready" | "degraded" | "unreachable";
export type NodeOverviewClient = Pick<AgentClient, "getHealth" | "getCapabilities">;
export type NodeOverviewErrorCode =
  | "AGENT_UNREACHABLE"
  | "MALFORMED_AGENT_RESULT";
export type NodeOverviewErrorSource = "health" | "capabilities";
export type NodeReadinessCheckName = "agent-health" | "agent-capabilities";
export type NodeReadinessCheckStatus = "pass" | "fail";

export interface NodeOverviewError {
  readonly code: NodeOverviewErrorCode;
  readonly source: NodeOverviewErrorSource;
  readonly message: string;
}

export interface NodeReadinessCheck {
  readonly name: NodeReadinessCheckName;
  readonly status: NodeReadinessCheckStatus;
  readonly message: string;
}

export interface NodeReadinessSummary {
  readonly status: NodeOverviewStatus;
  readonly ready: boolean;
  readonly checks: readonly NodeReadinessCheck[];
  readonly reasons: readonly string[];
}

export interface NodeOverview {
  readonly status: NodeOverviewStatus;
  readonly uptimeSeconds: number;
  readonly healthy: boolean;
  readonly capabilities: readonly string[];
  readonly hardwareCapabilities: AgentCapabilities | null;
  readonly readiness: NodeReadinessSummary;
  readonly error?: NodeOverviewError;
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

type ClientReadResult<T> =
  | {
      readonly ok: true;
      readonly value: T;
    }
  | {
      readonly ok: false;
      readonly kind: "unreachable" | "malformed";
      readonly error: NodeOverviewError;
    };

const HEALTH_FIELDS = Object.freeze([
  "version",
  "startedAt",
  "uptimeSeconds",
  "capabilities",
  "healthy",
]);
const CAPABILITIES_REQUIRED_FIELDS = Object.freeze([
  "cpu",
  "memory",
  "storage",
  "networking",
  "tpm",
  "virtualization",
  "accelerators",
]);
const CPU_FIELDS = Object.freeze(["arch", "cores", "model"]);
const MEMORY_FIELDS = Object.freeze(["totalMiB"]);
const STORAGE_FIELDS = Object.freeze(["name", "sizeMiB", "rotational", "nvme"]);
const NETWORKING_FIELDS = Object.freeze(["interfaces"]);
const NETWORK_INTERFACE_FIELDS = Object.freeze(["name", "kind"]);
const TPM_REQUIRED_FIELDS = Object.freeze(["present"]);
const VIRTUALIZATION_FIELDS = Object.freeze(["hardware"]);
const ACCELERATOR_REQUIRED_FIELDS = Object.freeze(["kind"]);
const ACCELERATOR_OPTIONAL_FIELDS = Object.freeze([
  "memoryGB",
  "compute",
  "generation",
  "memoryModel",
  "architecture",
]);
const DETECTED_DEVICE_FIELDS = Object.freeze(["class", "vendorID", "deviceID"]);
const AGENT_ACCELERATOR_KINDS = [
  "nvidia.cuda",
  "intel.npu",
  "amd.npu",
  "amd.rocm",
  "intel.gpu",
  "cpu",
] as const;

export async function buildNodeOverview(
  client: NodeOverviewClient,
): Promise<NodeOverview> {
  try {
    const healthPromise = readHealth(client);
    const capabilitiesPromise = readCapabilities(client);
    const [healthResult, capabilitiesResult] = await Promise.all([
      healthPromise,
      capabilitiesPromise,
    ]);

    return overviewFromResults(healthResult, capabilitiesResult);
  } catch (error) {
    return unreachableOverview(
      clientReadError("health", "Agent overview aggregation failed.", error),
    );
  }
}

async function readHealth(
  client: NodeOverviewClient,
): Promise<ClientReadResult<AgentHealth>> {
  return readClientValue("health", () => client.getHealth(), validateHealthResult);
}

async function readCapabilities(
  client: NodeOverviewClient,
): Promise<ClientReadResult<AgentCapabilities>> {
  return readClientValue(
    "capabilities",
    () => client.getCapabilities(),
    validateCapabilitiesResult,
  );
}

async function readClientValue<T>(
  source: NodeOverviewErrorSource,
  read: () => Promise<T>,
  validate: (value: unknown) => ValidationResult<T>,
): Promise<ClientReadResult<T>> {
  let value: T;

  try {
    value = await read();
  } catch (error) {
    return {
      error: clientReadError(source, `Agent ${source} request failed.`, error),
      kind: "unreachable",
      ok: false,
    };
  }

  const result = validate(value);

  if (!result.ok) {
    return {
      error: {
        code: "MALFORMED_AGENT_RESULT",
        message: `Agent ${source} result is malformed: ${result.reason}`,
        source,
      },
      kind: "malformed",
      ok: false,
    };
  }

  return {
    ok: true,
    value: result.value,
  };
}

function overviewFromResults(
  healthResult: ClientReadResult<AgentHealth>,
  capabilitiesResult: ClientReadResult<AgentCapabilities>,
): NodeOverview {
  const unreachable =
    firstFailureOfKind(healthResult, "unreachable") ??
    firstFailureOfKind(capabilitiesResult, "unreachable");

  if (unreachable !== undefined) {
    return {
      capabilities: [],
      error: unreachable,
      hardwareCapabilities: null,
      healthy: false,
      readiness: buildReadiness("unreachable", healthResult, capabilitiesResult),
      status: "unreachable",
      uptimeSeconds: 0,
    };
  }

  const health = healthResult.ok ? healthResult.value : undefined;
  const hardwareCapabilities = capabilitiesResult.ok
    ? capabilitiesResult.value
    : null;
  const malformed =
    firstFailureOfKind(healthResult, "malformed") ??
    firstFailureOfKind(capabilitiesResult, "malformed");
  const status: NodeOverviewStatus =
    malformed !== undefined || health?.healthy !== true ? "degraded" : "ready";
  const readiness = buildReadiness(status, healthResult, capabilitiesResult);
  const base = {
    capabilities: health?.capabilities ?? [],
    hardwareCapabilities,
    healthy: health?.healthy ?? false,
    readiness,
    status,
    uptimeSeconds: health?.uptimeSeconds ?? 0,
  };

  if (malformed === undefined) {
    return base;
  }

  return {
    ...base,
    error: malformed,
  };
}

function unreachableOverview(error: NodeOverviewError): NodeOverview {
  const readiness = buildReadiness(
    "unreachable",
    failRead("health", error),
    failRead("capabilities", error),
  );

  return {
    capabilities: [],
    error,
    hardwareCapabilities: null,
    healthy: false,
    readiness,
    status: "unreachable",
    uptimeSeconds: 0,
  };
}

function failRead<T>(
  source: NodeOverviewErrorSource,
  error: NodeOverviewError,
): ClientReadResult<T> {
  return {
    error: {
      ...error,
      source,
    },
    kind: error.code === "AGENT_UNREACHABLE" ? "unreachable" : "malformed",
    ok: false,
  };
}

function buildReadiness(
  status: NodeOverviewStatus,
  healthResult: ClientReadResult<AgentHealth>,
  capabilitiesResult: ClientReadResult<AgentCapabilities>,
): NodeReadinessSummary {
  const checks = [
    readinessHealthCheck(healthResult),
    readinessCapabilitiesCheck(capabilitiesResult),
  ];
  const reasons: string[] = [];

  for (let index = 0; index < checks.length; index += 1) {
    const check = checks[index];

    if (check !== undefined && check.status === "fail") {
      reasons[reasons.length] = check.message;
    }
  }

  return {
    checks,
    ready: status === "ready",
    reasons,
    status,
  };
}

function readinessHealthCheck(
  result: ClientReadResult<AgentHealth>,
): NodeReadinessCheck {
  if (!result.ok) {
    return {
      message: result.error.message,
      name: "agent-health",
      status: "fail",
    };
  }

  if (!result.value.healthy) {
    return {
      message: "Agent health endpoint reports unhealthy.",
      name: "agent-health",
      status: "fail",
    };
  }

  return {
    message: "Agent health endpoint reports healthy.",
    name: "agent-health",
    status: "pass",
  };
}

function readinessCapabilitiesCheck(
  result: ClientReadResult<AgentCapabilities>,
): NodeReadinessCheck {
  if (!result.ok) {
    return {
      message: result.error.message,
      name: "agent-capabilities",
      status: "fail",
    };
  }

  return {
    message: "Agent capabilities are available.",
    name: "agent-capabilities",
    status: "pass",
  };
}

function firstFailureOfKind<T>(
  result: ClientReadResult<T>,
  kind: "unreachable" | "malformed",
): NodeOverviewError | undefined {
  if (result.ok || result.kind !== kind) {
    return undefined;
  }

  return result.error;
}

function clientReadError(
  source: NodeOverviewErrorSource,
  message: string,
  error: unknown,
): NodeOverviewError {
  return {
    code: "AGENT_UNREACHABLE",
    message: `${message} ${describeError(error)}`,
    source,
  };
}

function describeError(error: unknown): string {
  try {
    if (isAgentClientError(error)) {
      return `${error.code}: ${error.message}`;
    }

    if (error instanceof Error && typeof error.message === "string" && error.message !== "") {
      return error.message;
    }

    if (typeof error === "string" && error !== "") {
      return error;
    }
  } catch {
    return "Unknown client error.";
  }

  return "Unknown client error.";
}

function validateHealthResult(value: unknown): ValidationResult<AgentHealth> {
  const payload = normalizeObject(value);

  if (!payload.ok) return payload;

  return validateHealth(payload.value);
}

function validateCapabilitiesResult(
  value: unknown,
): ValidationResult<AgentCapabilities> {
  const payload = normalizeObject(value);

  if (!payload.ok) return payload;

  return validateCapabilities(payload.value);
}

function normalizeObject(value: unknown): ValidationResult<PlainJsonObject> {
  const normalized = safeNormalize(value);

  if (!normalized.ok) return reject(normalized.reason);
  if (!isPlainObject(normalized.value)) return reject("result must be an object.");

  return accept(normalized.value);
}

function validateHealth(payload: PlainJsonObject): ValidationResult<AgentHealth> {
  const fields = expectFields(payload, HEALTH_FIELDS);

  if (!fields.ok) return fields;

  const version = field(payload, "version");
  const startedAt = field(payload, "startedAt");
  const uptimeSeconds = field(payload, "uptimeSeconds");
  const capabilities = validateStringArray(field(payload, "capabilities"), "capabilities");
  const healthy = field(payload, "healthy");

  if (typeof version !== "string") return reject("version must be a string.");
  if (typeof startedAt !== "string" || !isTimestamp(startedAt)) {
    return reject("startedAt must be a timestamp string.");
  }
  if (!isNonNegativeSafeInteger(uptimeSeconds)) {
    return reject("uptimeSeconds must be a non-negative integer.");
  }
  if (!capabilities.ok) return capabilities;
  if (typeof healthy !== "boolean") return reject("healthy must be a boolean.");

  return accept({
    capabilities: capabilities.value,
    healthy,
    startedAt,
    uptimeSeconds,
    version,
  });
}

function validateCapabilities(
  payload: PlainJsonObject,
): ValidationResult<AgentCapabilities> {
  const fields = expectFields(payload, CAPABILITIES_REQUIRED_FIELDS, ["detectedDevices"]);

  if (!fields.ok) return fields;

  const cpu = validateCpu(field(payload, "cpu"), "cpu");
  if (!cpu.ok) return cpu;

  const memory = validateMemory(field(payload, "memory"), "memory");
  if (!memory.ok) return memory;

  const storage = validateNullableArray(
    field(payload, "storage"),
    "storage",
    validateStorageDevice,
  );
  if (!storage.ok) return storage;

  const networking = validateNetworking(field(payload, "networking"), "networking");
  if (!networking.ok) return networking;

  const tpm = validateTpm(field(payload, "tpm"), "tpm");
  if (!tpm.ok) return tpm;

  const virtualization = validateVirtualization(
    field(payload, "virtualization"),
    "virtualization",
  );
  if (!virtualization.ok) return virtualization;

  const accelerators = validateNullableArray(
    field(payload, "accelerators"),
    "accelerators",
    validateAccelerator,
  );
  if (!accelerators.ok) return accelerators;

  const detectedValue = optionalField(payload, "detectedDevices");
  const base = {
    accelerators: accelerators.value,
    cpu: cpu.value,
    memory: memory.value,
    networking: networking.value,
    storage: storage.value,
    tpm: tpm.value,
    virtualization: virtualization.value,
  };

  if (detectedValue === undefined) {
    return accept(base);
  }

  const detectedDevices = validateArray(
    detectedValue,
    "detectedDevices",
    validateDetectedDevice,
  );

  if (!detectedDevices.ok) return detectedDevices;

  return accept({
    ...base,
    detectedDevices: detectedDevices.value,
  });
}

function validateCpu(
  value: PlainJson | undefined,
  path: string,
): ValidationResult<AgentCpuCapabilities> {
  if (!isPlainObject(value)) return reject(`${path} must be an object.`);

  const fields = expectFields(value, CPU_FIELDS, [], path);

  if (!fields.ok) return fields;

  const arch = field(value, "arch");
  const cores = field(value, "cores");
  const model = field(value, "model");

  if (typeof arch !== "string") return reject(`${path}.arch must be a string.`);
  if (!isNonNegativeSafeInteger(cores)) {
    return reject(`${path}.cores must be a non-negative integer.`);
  }
  if (typeof model !== "string") return reject(`${path}.model must be a string.`);

  return accept({ arch, cores, model });
}

function validateMemory(
  value: PlainJson | undefined,
  path: string,
): ValidationResult<AgentMemoryCapabilities> {
  if (!isPlainObject(value)) return reject(`${path} must be an object.`);

  const fields = expectFields(value, MEMORY_FIELDS, [], path);

  if (!fields.ok) return fields;

  const totalMiB = field(value, "totalMiB");

  if (!isNonNegativeSafeInteger(totalMiB)) {
    return reject(`${path}.totalMiB must be a non-negative integer.`);
  }

  return accept({ totalMiB });
}

function validateStorageDevice(
  value: PlainJson | undefined,
  path: string,
): ValidationResult<AgentStorageDevice> {
  if (!isPlainObject(value)) return reject(`${path} must be an object.`);

  const fields = expectFields(value, STORAGE_FIELDS, [], path);

  if (!fields.ok) return fields;

  const name = field(value, "name");
  const sizeMiB = field(value, "sizeMiB");
  const rotational = field(value, "rotational");
  const nvme = field(value, "nvme");

  if (typeof name !== "string") return reject(`${path}.name must be a string.`);
  if (!isNonNegativeSafeInteger(sizeMiB)) {
    return reject(`${path}.sizeMiB must be a non-negative integer.`);
  }
  if (typeof rotational !== "boolean") return reject(`${path}.rotational must be a boolean.`);
  if (typeof nvme !== "boolean") return reject(`${path}.nvme must be a boolean.`);

  return accept({ name, nvme, rotational, sizeMiB });
}

function validateNetworking(
  value: PlainJson | undefined,
  path: string,
): ValidationResult<AgentNetworkingCapabilities> {
  if (!isPlainObject(value)) return reject(`${path} must be an object.`);

  const fields = expectFields(value, NETWORKING_FIELDS, [], path);

  if (!fields.ok) return fields;

  const interfaces = validateNullableArray(
    field(value, "interfaces"),
    `${path}.interfaces`,
    validateNetworkInterface,
  );

  if (!interfaces.ok) return interfaces;

  return accept({ interfaces: interfaces.value });
}

function validateNetworkInterface(
  value: PlainJson | undefined,
  path: string,
): ValidationResult<AgentNetworkInterface> {
  if (!isPlainObject(value)) return reject(`${path} must be an object.`);

  const fields = expectFields(value, NETWORK_INTERFACE_FIELDS, [], path);

  if (!fields.ok) return fields;

  const name = field(value, "name");
  const kind = field(value, "kind");

  if (typeof name !== "string") return reject(`${path}.name must be a string.`);
  if (typeof kind !== "string") return reject(`${path}.kind must be a string.`);

  return accept({ kind, name });
}

function validateTpm(
  value: PlainJson | undefined,
  path: string,
): ValidationResult<AgentTpmCapabilities> {
  if (!isPlainObject(value)) return reject(`${path} must be an object.`);

  const fields = expectFields(value, TPM_REQUIRED_FIELDS, ["version"], path);

  if (!fields.ok) return fields;

  const present = field(value, "present");
  const version = optionalField(value, "version");

  if (typeof present !== "boolean") return reject(`${path}.present must be a boolean.`);

  if (version === undefined) {
    return accept({ present });
  }

  if (typeof version !== "string") return reject(`${path}.version must be a string.`);

  return accept({ present, version });
}

function validateVirtualization(
  value: PlainJson | undefined,
  path: string,
): ValidationResult<AgentVirtualizationCapabilities> {
  if (!isPlainObject(value)) return reject(`${path} must be an object.`);

  const fields = expectFields(value, VIRTUALIZATION_FIELDS, [], path);

  if (!fields.ok) return fields;

  const hardware = field(value, "hardware");

  if (typeof hardware !== "boolean") return reject(`${path}.hardware must be a boolean.`);

  return accept({ hardware });
}

function validateAccelerator(
  value: PlainJson | undefined,
  path: string,
): ValidationResult<AgentAcceleratorCapability> {
  if (!isPlainObject(value)) return reject(`${path} must be an object.`);

  const fields = expectFields(
    value,
    ACCELERATOR_REQUIRED_FIELDS,
    ACCELERATOR_OPTIONAL_FIELDS,
    path,
  );

  if (!fields.ok) return fields;

  const kind = field(value, "kind");

  if (!isStringMember(kind, AGENT_ACCELERATOR_KINDS)) {
    return reject(`${path}.kind must be a known accelerator kind.`);
  }

  const memoryGB = optionalField(value, "memoryGB");
  const compute = optionalField(value, "compute");
  const generation = optionalField(value, "generation");
  const memoryModel = optionalField(value, "memoryModel");
  const architecture = optionalField(value, "architecture");
  const output: {
    kind: AgentAcceleratorKind;
    memoryGB?: number;
    compute?: string;
    generation?: string;
    memoryModel?: string;
    architecture?: string;
  } = { kind };

  if (memoryGB !== undefined) {
    if (!isNonNegativeSafeInteger(memoryGB)) {
      return reject(`${path}.memoryGB must be a non-negative integer.`);
    }
    output.memoryGB = memoryGB;
  }
  if (compute !== undefined) {
    if (typeof compute !== "string") return reject(`${path}.compute must be a string.`);
    output.compute = compute;
  }
  if (generation !== undefined) {
    if (typeof generation !== "string") return reject(`${path}.generation must be a string.`);
    output.generation = generation;
  }
  if (memoryModel !== undefined) {
    if (typeof memoryModel !== "string") return reject(`${path}.memoryModel must be a string.`);
    output.memoryModel = memoryModel;
  }
  if (architecture !== undefined) {
    if (typeof architecture !== "string") return reject(`${path}.architecture must be a string.`);
    output.architecture = architecture;
  }

  return accept(output);
}

function validateDetectedDevice(
  value: PlainJson | undefined,
  path: string,
): ValidationResult<AgentDetectedDevice> {
  if (!isPlainObject(value)) return reject(`${path} must be an object.`);

  const fields = expectFields(value, DETECTED_DEVICE_FIELDS, [], path);

  if (!fields.ok) return fields;

  const deviceClass = field(value, "class");
  const vendorID = field(value, "vendorID");
  const deviceID = field(value, "deviceID");

  if (typeof deviceClass !== "string") return reject(`${path}.class must be a string.`);
  if (typeof vendorID !== "string") return reject(`${path}.vendorID must be a string.`);
  if (typeof deviceID !== "string") return reject(`${path}.deviceID must be a string.`);

  return accept({
    class: deviceClass,
    deviceID,
    vendorID,
  });
}

function validateStringArray(
  value: PlainJson | undefined,
  path: string,
): ValidationResult<readonly string[]> {
  return validateArray(value, path, (item, itemPath) => {
    if (typeof item !== "string") return reject(`${itemPath} must be a string.`);

    return accept(item);
  });
}

function validateNullableArray<T>(
  value: PlainJson | undefined,
  path: string,
  validate: (item: PlainJson | undefined, itemPath: string) => ValidationResult<T>,
): ValidationResult<readonly T[] | null> {
  if (value === null) return accept(null);

  return validateArray(value, path, validate);
}

function validateArray<T>(
  value: PlainJson | undefined,
  path: string,
  validate: (item: PlainJson | undefined, itemPath: string) => ValidationResult<T>,
): ValidationResult<readonly T[]> {
  if (!Array.isArray(value)) return reject(`${path} must be an array.`);

  const output: T[] = [];

  for (let index = 0; index < value.length; index += 1) {
    const item = value[index];

    if (item === undefined) {
      return reject(`${path}[${index}] is missing.`);
    }

    const result = validate(item, `${path}[${index}]`);

    if (!result.ok) return result;

    output[index] = result.value;
  }

  return accept(output);
}

function expectFields(
  value: PlainJsonObject,
  required: readonly string[],
  optional: readonly string[] = [],
  path = "",
): ValidationResult<true> {
  const keys = Object.keys(value);

  for (let index = 0; index < keys.length; index += 1) {
    const key = keys[index];

    if (key === undefined) {
      return reject("object contains an unreadable field.");
    }
    if (!contains(required, key) && !contains(optional, key)) {
      return reject(`${prefix(path)}${key} is not an expected field.`);
    }
  }

  for (let index = 0; index < required.length; index += 1) {
    const key = required[index];

    if (key === undefined || !Object.hasOwn(value, key)) {
      return reject(`${prefix(path)}${key ?? "field"} is required.`);
    }
  }

  return accept(true);
}

function field(value: PlainJsonObject, key: string): PlainJson | undefined {
  if (!Object.hasOwn(value, key)) return undefined;

  return value[key];
}

function optionalField(value: PlainJsonObject, key: string): PlainJson | undefined {
  return field(value, key);
}

function prefix(path: string): string {
  return path === "" ? "" : `${path}.`;
}

function isPlainObject(value: PlainJson | undefined): value is PlainJsonObject {
  return value !== undefined && value !== null && typeof value === "object" && !Array.isArray(value);
}

function isTimestamp(value: string): boolean {
  return Number.isFinite(Date.parse(value));
}

function isNonNegativeSafeInteger(value: PlainJson | undefined): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isStringMember<T extends string>(
  value: PlainJson | undefined,
  members: readonly T[],
): value is T {
  if (typeof value !== "string") return false;

  return contains(members, value);
}

function contains<T extends string>(values: readonly T[], value: string): value is T {
  for (let index = 0; index < values.length; index += 1) {
    if (values[index] === value) return true;
  }

  return false;
}

function accept<T>(value: T): ValidationResult<T> {
  return {
    ok: true,
    value,
  };
}

function reject<T>(reason: string): ValidationResult<T> {
  return {
    ok: false,
    reason,
  };
}
