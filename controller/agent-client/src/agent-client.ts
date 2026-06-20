import { safeNormalize } from "../../../sdk/typescript/src/safe-normalize.ts";
import type {
  PlainJson,
  PlainJsonObject,
} from "../../../sdk/typescript/src/safe-normalize.ts";
import type { CanonicalJsonObject } from "../../../sdk/typescript/src/plan.ts";

export interface AgentTransportInit {
  readonly method: "GET" | "POST";
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: string;
}

export interface AgentTransportResponse {
  readonly ok: boolean;
  readonly status: number;
  text(): Promise<string>;
}

export type AgentTransport = (
  url: string,
  init: AgentTransportInit,
) => Promise<AgentTransportResponse>;

export interface AgentClientOptions {
  readonly transport: AgentTransport;
  readonly baseUrl?: string | URL;
}

export interface AgentClient {
  getHealth(): Promise<AgentHealth>;
  getCapabilities(): Promise<AgentCapabilities>;
  getOperations(): Promise<readonly string[]>;
  getState(capability: string): Promise<AgentCapabilityState>;
  apply(plan: AgentApplyPlan): Promise<AgentApplyResult>;
}

export interface AgentHealth {
  readonly version: string;
  readonly startedAt: string;
  readonly uptimeSeconds: number;
  readonly capabilities: readonly string[];
  readonly healthy: boolean;
}

export interface AgentCapabilities {
  readonly cpu: AgentCpuCapabilities;
  readonly memory: AgentMemoryCapabilities;
  readonly storage: readonly AgentStorageDevice[] | null;
  readonly networking: AgentNetworkingCapabilities;
  readonly tpm: AgentTpmCapabilities;
  readonly virtualization: AgentVirtualizationCapabilities;
  readonly accelerators: readonly AgentAcceleratorCapability[] | null;
  readonly detectedDevices?: readonly AgentDetectedDevice[];
}

export interface AgentCpuCapabilities {
  readonly arch: string;
  readonly cores: number;
  readonly model: string;
}

export interface AgentMemoryCapabilities {
  readonly totalMiB: number;
}

export interface AgentStorageDevice {
  readonly name: string;
  readonly sizeMiB: number;
  readonly rotational: boolean;
  readonly nvme: boolean;
}

export interface AgentNetworkingCapabilities {
  readonly interfaces: readonly AgentNetworkInterface[] | null;
}

export interface AgentNetworkInterface {
  readonly name: string;
  readonly kind: string;
}

export interface AgentTpmCapabilities {
  readonly present: boolean;
  readonly version?: string;
}

export interface AgentVirtualizationCapabilities {
  readonly hardware: boolean;
}

export type AgentAcceleratorKind =
  | "nvidia.cuda"
  | "intel.npu"
  | "amd.npu"
  | "amd.rocm"
  | "intel.gpu"
  | "cpu";

export interface AgentAcceleratorCapability {
  readonly kind: AgentAcceleratorKind;
  readonly memoryGB?: number;
  readonly compute?: string;
  readonly generation?: string;
  readonly memoryModel?: string;
  readonly architecture?: string;
}

export interface AgentDetectedDevice {
  readonly class: string;
  readonly vendorID: string;
  readonly deviceID: string;
}

export type AgentCapabilityRequest = CanonicalJsonObject;
export type AgentCapabilityState = PlainJsonObject;

export interface AgentApplyOperation<
  TRequest extends AgentCapabilityRequest = AgentCapabilityRequest,
> {
  readonly capability: string;
  readonly request: TRequest;
}

export interface AgentApplyPlan {
  readonly operations: readonly AgentApplyOperation[];
}

export type AgentApplyOutcome = "committed" | "rolledBack" | "rejected";

export interface AgentApplyResult {
  readonly outcome: AgentApplyOutcome;
  readonly applied: readonly AgentOperationResult[];
  readonly rolledBack: readonly AgentOperationResult[];
  readonly error?: AgentResultError;
  readonly rollbackErrors: readonly AgentResultError[];
}

export interface AgentOperationResult {
  readonly index: number;
  readonly capability: string;
}

export interface AgentResultError {
  readonly code: string;
  readonly message: string;
  readonly index?: number;
  readonly capability?: string;
}

export interface AgentErrorDetail {
  readonly code: string;
  readonly message: string;
}

export type AgentClientErrorCode =
  | "AGENT_ERROR"
  | "INVALID_PLAN"
  | "MALFORMED_RESPONSE"
  | "TRANSPORT_ERROR";

export interface AgentClientErrorOptions {
  readonly status?: number;
  readonly agentError?: AgentErrorDetail;
  readonly cause?: unknown;
}

export class AgentClientError extends Error {
  readonly code: AgentClientErrorCode;
  readonly status?: number;
  readonly agentError?: AgentErrorDetail;

  constructor(
    code: AgentClientErrorCode,
    message: string,
    options: AgentClientErrorOptions = {},
  ) {
    super(message);
    this.name = "AgentClientError";
    this.code = code;

    if (options.status !== undefined) {
      this.status = options.status;
    }
    if (options.agentError !== undefined) {
      this.agentError = options.agentError;
    }
    if (options.cause !== undefined) {
      Object.defineProperty(this, "cause", {
        configurable: true,
        enumerable: false,
        value: options.cause,
        writable: true,
      });
    }
  }
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

interface AgentApplyWirePlan {
  readonly operations: readonly AgentApplyWireOperation[];
}

interface AgentApplyWireOperation {
  readonly capability: string;
  readonly request: PlainJsonObject;
}

const DEFAULT_AGENT_BASE_URL = "http://127.0.0.1:8786";
const JSON_GET_HEADERS = Object.freeze({
  Accept: "application/json",
});
const JSON_POST_HEADERS = Object.freeze({
  Accept: "application/json",
  "Content-Type": "application/json",
});
const HEALTH_FIELDS = Object.freeze(["version", "startedAt", "uptimeSeconds", "capabilities", "healthy"]);
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
const OPERATIONS_RESPONSE_FIELDS = Object.freeze(["operations"]);
const APPLY_RESULT_REQUIRED_FIELDS = Object.freeze([
  "outcome",
  "applied",
  "rolledBack",
  "rollbackErrors",
]);
const OPERATION_RESULT_FIELDS = Object.freeze(["index", "capability"]);
const RESULT_ERROR_REQUIRED_FIELDS = Object.freeze(["code", "message"]);
const RESULT_ERROR_OPTIONAL_FIELDS = Object.freeze(["index", "capability"]);
const ERROR_RESPONSE_FIELDS = Object.freeze(["error"]);
const ERROR_DETAIL_FIELDS = Object.freeze(["code", "message"]);
const APPLY_PLAN_FIELDS = Object.freeze(["operations"]);
const APPLY_OPERATION_FIELDS = Object.freeze(["capability", "request"]);
const AGENT_ACCELERATOR_KINDS = [
  "nvidia.cuda",
  "intel.npu",
  "amd.npu",
  "amd.rocm",
  "intel.gpu",
  "cpu",
] as const;
const AGENT_APPLY_OUTCOMES = ["committed", "rolledBack", "rejected"] as const;

export function createAgentClient(options: AgentClientOptions): AgentClient {
  return new LoopbackAgentClient(options);
}

export function isAgentClientError(error: unknown): error is AgentClientError {
  return error instanceof AgentClientError;
}

export function serializeApplyPlan(plan: AgentApplyPlan): string {
  const normalized = safeNormalize(plan);

  if (!normalized.ok) {
    throw new AgentClientError(
      "INVALID_PLAN",
      `Agent apply plan is malformed: ${normalized.reason}`,
    );
  }

  const wirePlan = validateApplyPlan(normalized.value);

  if (!wirePlan.ok) {
    throw new AgentClientError(
      "INVALID_PLAN",
      `Agent apply plan is invalid: ${wirePlan.reason}`,
    );
  }

  return JSON.stringify(wirePlan.value);
}

export class LoopbackAgentClient implements AgentClient {
  readonly #transport: AgentTransport;
  readonly #baseUrl: URL;

  constructor(options: AgentClientOptions) {
    this.#transport = options.transport;
    this.#baseUrl = new URL(options.baseUrl ?? DEFAULT_AGENT_BASE_URL);
  }

  getHealth(): Promise<AgentHealth> {
    return this.#request("/healthz", "GET", validateHealth);
  }

  getCapabilities(): Promise<AgentCapabilities> {
    return this.#request("/capabilities", "GET", validateCapabilities);
  }

  getOperations(): Promise<readonly string[]> {
    return this.#request("/operations", "GET", validateOperations);
  }

  getState(capability: string): Promise<AgentCapabilityState> {
    return this.#request(
      `/read/${encodeURIComponent(capability)}`,
      "GET",
      validateCapabilityState,
    );
  }

  apply(plan: AgentApplyPlan): Promise<AgentApplyResult> {
    return this.#request("/apply", "POST", validateApplyResult, serializeApplyPlan(plan));
  }

  async #request<T>(
    path: string,
    method: "GET" | "POST",
    validate: (payload: PlainJsonObject) => ValidationResult<T>,
    body?: string,
  ): Promise<T> {
    const init: AgentTransportInit =
      body === undefined
        ? {
            headers: JSON_GET_HEADERS,
            method,
          }
        : {
            body,
            headers: JSON_POST_HEADERS,
            method,
          };

    let response: AgentTransportResponse;

    try {
      response = await this.#transport(new URL(path, this.#baseUrl).toString(), init);
    } catch (error) {
      throw new AgentClientError("TRANSPORT_ERROR", "Agent transport request failed.", {
        cause: error,
      });
    }

    if (!response.ok) {
      await throwAgentError(response);
    }

    const payload = await readResponseObject(response);
    const result = validate(payload);

    if (!result.ok) {
      throw new AgentClientError(
        "MALFORMED_RESPONSE",
        `Agent response did not match the expected wire shape: ${result.reason}`,
        { status: response.status },
      );
    }

    return result.value;
  }
}

async function throwAgentError(response: AgentTransportResponse): Promise<never> {
  const payload = await readResponseObject(response);
  const result = validateErrorResponse(payload);

  if (!result.ok) {
    throw new AgentClientError(
      "MALFORMED_RESPONSE",
      `Agent error response did not match the expected wire shape: ${result.reason}`,
      { status: response.status },
    );
  }

  throw new AgentClientError(
    "AGENT_ERROR",
    `Agent request failed with ${result.value.code}: ${result.value.message}`,
    {
      agentError: result.value,
      status: response.status,
    },
  );
}

async function readResponseObject(response: AgentTransportResponse): Promise<PlainJsonObject> {
  let text: string;

  try {
    text = await response.text();
  } catch (error) {
    throw new AgentClientError("TRANSPORT_ERROR", "Agent response body could not be read.", {
      cause: error,
      status: response.status,
    });
  }

  let parsed: unknown;

  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new AgentClientError("MALFORMED_RESPONSE", "Agent response body is not JSON.", {
      cause: error,
      status: response.status,
    });
  }

  const normalized = safeNormalize(parsed);

  if (!normalized.ok) {
    throw new AgentClientError(
      "MALFORMED_RESPONSE",
      `Agent response body is malformed: ${normalized.reason}`,
      { status: response.status },
    );
  }

  if (!isPlainObject(normalized.value)) {
    throw new AgentClientError(
      "MALFORMED_RESPONSE",
      "Agent response body must be a JSON object.",
      { status: response.status },
    );
  }

  return normalized.value;
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

function validateCapabilities(payload: PlainJsonObject): ValidationResult<AgentCapabilities> {
  const fields = expectFields(payload, CAPABILITIES_REQUIRED_FIELDS, ["detectedDevices"]);

  if (!fields.ok) return fields;

  const cpu = validateCpu(field(payload, "cpu"), "cpu");
  if (!cpu.ok) return cpu;

  const memory = validateMemory(field(payload, "memory"), "memory");
  if (!memory.ok) return memory;

  const storage = validateNullableArray(field(payload, "storage"), "storage", validateStorageDevice);
  if (!storage.ok) return storage;

  const networking = validateNetworking(field(payload, "networking"), "networking");
  if (!networking.ok) return networking;

  const tpm = validateTpm(field(payload, "tpm"), "tpm");
  if (!tpm.ok) return tpm;

  const virtualization = validateVirtualization(field(payload, "virtualization"), "virtualization");
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

function validateOperations(payload: PlainJsonObject): ValidationResult<readonly string[]> {
  const fields = expectFields(payload, OPERATIONS_RESPONSE_FIELDS);

  if (!fields.ok) return fields;

  return validateOperationNameArray(field(payload, "operations"), "operations");
}

function validateCapabilityState(
  payload: PlainJsonObject,
): ValidationResult<AgentCapabilityState> {
  return accept(payload);
}

function validateOperationNameArray(
  value: PlainJson | undefined,
  path: string,
): ValidationResult<readonly string[]> {
  return validateArray(value, path, (item, itemPath) => {
    if (typeof item !== "string" || item === "") {
      return reject(`${itemPath} must be a non-empty string.`);
    }

    return accept(item);
  });
}

function validateCpu(value: PlainJson | undefined, path: string): ValidationResult<AgentCpuCapabilities> {
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

function validateTpm(value: PlainJson | undefined, path: string): ValidationResult<AgentTpmCapabilities> {
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

function validateApplyResult(payload: PlainJsonObject): ValidationResult<AgentApplyResult> {
  const fields = expectFields(payload, APPLY_RESULT_REQUIRED_FIELDS, ["error"]);

  if (!fields.ok) return fields;

  const outcome = field(payload, "outcome");
  const applied = validateArray(field(payload, "applied"), "applied", validateOperationResult);
  const rolledBack = validateArray(
    field(payload, "rolledBack"),
    "rolledBack",
    validateOperationResult,
  );
  const rollbackErrors = validateArray(
    field(payload, "rollbackErrors"),
    "rollbackErrors",
    validateResultError,
  );
  const errorValue = optionalField(payload, "error");

  if (!isStringMember(outcome, AGENT_APPLY_OUTCOMES)) {
    return reject("outcome must be committed, rolledBack, or rejected.");
  }
  if (!applied.ok) return applied;
  if (!rolledBack.ok) return rolledBack;
  if (!rollbackErrors.ok) return rollbackErrors;

  const base = {
    applied: applied.value,
    outcome,
    rolledBack: rolledBack.value,
    rollbackErrors: rollbackErrors.value,
  };

  if (errorValue === undefined) {
    return accept(base);
  }

  const resultError = validateResultError(errorValue, "error");

  if (!resultError.ok) return resultError;

  return accept({
    ...base,
    error: resultError.value,
  });
}

function validateOperationResult(
  value: PlainJson | undefined,
  path: string,
): ValidationResult<AgentOperationResult> {
  if (!isPlainObject(value)) return reject(`${path} must be an object.`);

  const fields = expectFields(value, OPERATION_RESULT_FIELDS, [], path);

  if (!fields.ok) return fields;

  const index = field(value, "index");
  const capability = field(value, "capability");

  if (!isNonNegativeSafeInteger(index)) {
    return reject(`${path}.index must be a non-negative integer.`);
  }
  if (typeof capability !== "string" || capability === "") {
    return reject(`${path}.capability must be a non-empty string.`);
  }

  return accept({ capability, index });
}

function validateResultError(
  value: PlainJson | undefined,
  path: string,
): ValidationResult<AgentResultError> {
  if (!isPlainObject(value)) return reject(`${path} must be an object.`);

  const fields = expectFields(value, RESULT_ERROR_REQUIRED_FIELDS, RESULT_ERROR_OPTIONAL_FIELDS, path);

  if (!fields.ok) return fields;

  const code = field(value, "code");
  const message = field(value, "message");
  const index = optionalField(value, "index");
  const capability = optionalField(value, "capability");
  const output: {
    code: string;
    message: string;
    index?: number;
    capability?: string;
  } = {
    code: "",
    message: "",
  };

  if (typeof code !== "string" || code === "") {
    return reject(`${path}.code must be a non-empty string.`);
  }
  output.code = code;

  if (typeof message !== "string") return reject(`${path}.message must be a string.`);
  output.message = message;

  if (index !== undefined) {
    if (!isNonNegativeSafeInteger(index)) {
      return reject(`${path}.index must be a non-negative integer.`);
    }
    output.index = index;
  }

  if (capability !== undefined) {
    if (typeof capability !== "string") return reject(`${path}.capability must be a string.`);
    output.capability = capability;
  }

  return accept(output);
}

function validateErrorResponse(payload: PlainJsonObject): ValidationResult<AgentErrorDetail> {
  const fields = expectFields(payload, ERROR_RESPONSE_FIELDS);

  if (!fields.ok) return fields;

  const detail = field(payload, "error");

  if (!isPlainObject(detail)) return reject("error must be an object.");

  const detailFields = expectFields(detail, ERROR_DETAIL_FIELDS, [], "error");

  if (!detailFields.ok) return detailFields;

  const code = field(detail, "code");
  const message = field(detail, "message");

  if (typeof code !== "string" || code === "") {
    return reject("error.code must be a non-empty string.");
  }
  if (typeof message !== "string") return reject("error.message must be a string.");

  return accept({ code, message });
}

function validateApplyPlan(value: PlainJson): ValidationResult<AgentApplyWirePlan> {
  if (!isPlainObject(value)) return reject("plan must be an object.");

  const fields = expectFields(value, APPLY_PLAN_FIELDS);

  if (!fields.ok) return fields;

  const operations = validateArray(
    field(value, "operations"),
    "operations",
    validateApplyOperation,
  );

  if (!operations.ok) return operations;

  return accept({ operations: operations.value });
}

function validateApplyOperation(
  value: PlainJson | undefined,
  path: string,
): ValidationResult<AgentApplyWireOperation> {
  if (!isPlainObject(value)) return reject(`${path} must be an object.`);

  const fields = expectFields(value, APPLY_OPERATION_FIELDS, [], path);

  if (!fields.ok) return fields;

  const capability = field(value, "capability");
  const request = field(value, "request");

  if (typeof capability !== "string" || capability === "") {
    return reject(`${path}.capability must be a non-empty string.`);
  }
  if (!isPlainObject(request)) {
    return reject(`${path}.request must be an object.`);
  }

  return accept({ capability, request });
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
