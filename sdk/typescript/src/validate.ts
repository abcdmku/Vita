import { bestAvailable } from "./capabilities.ts";
import { normalize } from "./plan.ts";
import type {
  AcceleratorFallback,
  AcceleratorPreference,
  AcceleratorRequest,
  DeviceSnapshot,
} from "./capabilities.ts";
import type { CanonicalPlan, DesiredState } from "./plan.ts";

export interface ValidationError {
  readonly path: string;
  readonly message: string;
}

export type ValidationResult =
  | {
      readonly ok: true;
      readonly plan: CanonicalPlan;
    }
  | {
      readonly ok: false;
      readonly errors: readonly ValidationError[];
    };

export type AllowedCapability = "network.public" | "data.files.read-only";

type JsonRecord = Readonly<Record<string, unknown>>;
type Path = readonly string[];

const TOP_LEVEL_FIELDS = new Set(["identity", "storage", "apps", "backups"]);
const IDENTITY_FIELDS = new Set(["owner", "passkeysRequired"]);
const OWNER_FIELDS = new Set(["id", "displayName"]);
const STORAGE_FIELDS = new Set(["dataVolume"]);
const DATA_VOLUME_FIELDS = new Set(["encryption", "snapshots", "quotaGiB"]);
const APP_FIELDS = new Set(["id", "enabled", "version", "config"]);
const BACKUP_FIELDS = new Set(["id", "target", "schedule", "enabled", "retentionDays"]);
const DATA_ACCESS_FIELDS = new Set(["type", "scope", "mode"]);
const ACCELERATOR_REQUEST_FIELDS = new Set(["prefer", "requireFallback"]);
const ACCELERATOR_SELECTION_FIELDS = new Set([
  "type",
  "selected",
  "selectedPreference",
  "fallback",
  "prefer",
  "requireFallback",
]);
const ACCELERATOR_REFUSAL_FIELDS = new Set([
  "type",
  "code",
  "reason",
  "prefer",
  "requireFallback",
  "available",
]);
const DEVICE_FIELDS = new Set([
  "memoryGB",
  "architecture",
  "accelerators",
  "tpm",
  "virtualization",
  "storage",
  "networking",
]);
const TPM_FIELDS = new Set(["present", "version", "sealedKeyUnlock"]);
const VIRTUALIZATION_FIELDS = new Set(["hardware", "nested"]);
const DEVICE_STORAGE_FIELDS = new Set(["bootGB", "dataGB"]);
const NETWORKING_FIELDS = new Set(["ethernet", "wifi"]);

const STORAGE_ENCRYPTION_MODES = new Set(["disabled", "optional", "required"]);
const SNAPSHOT_CADENCES = new Set(["disabled", "hourly", "daily", "weekly"]);
const BACKUP_TARGETS = new Set(["network", "usb"]);
const BACKUP_SCHEDULES = new Set(["hourly", "daily", "weekly", "monthly"]);
const DEVICE_ARCHITECTURES = new Set(["x86_64", "arm64"]);
const ACCELERATOR_PREFERENCES = new Set<AcceleratorPreference>(["npu", "gpu", "cpu"]);
const APP_ALLOWED_CAPABILITIES = new Set<AllowedCapability>([
  "network.public",
  "data.files.read-only",
]);

export function validatePlan(state: DesiredState, snapshot: DeviceSnapshot): ValidationResult {
  const errors: ValidationError[] = [];
  const deviceErrorStart = errors.length;

  validateDeviceSnapshot(snapshot as unknown, ["snapshot"], errors);
  validateDesiredState(
    state as unknown,
    [],
    errors,
    errors.length === deviceErrorStart ? snapshot : undefined,
  );

  if (errors.length > 0) {
    return {
      ok: false,
      errors,
    };
  }

  try {
    return {
      ok: true,
      plan: normalize(state),
    };
  } catch (error) {
    return {
      ok: false,
      errors: [
        {
          path: "",
          message: error instanceof Error ? error.message : "Plan normalization failed.",
        },
      ],
    };
  }
}

function validateDesiredState(
  value: unknown,
  path: Path,
  errors: ValidationError[],
  device: DeviceSnapshot | undefined,
): void {
  if (!isRecord(value)) {
    addError(errors, path, "Expected desired state object.");
    return;
  }

  rejectUnknownFields(value, TOP_LEVEL_FIELDS, path, errors);
  validateOptionalObject(value, "identity", [...path, "identity"], errors, validateIdentity);
  validateOptionalObject(value, "storage", [...path, "storage"], errors, validateStorage);
  validateOptionalArray(value, "apps", [...path, "apps"], errors, (app, appPath) => {
    validateApp(app, appPath, errors, device);
  });
  validateOptionalArray(value, "backups", [...path, "backups"], errors, (backup, backupPath) => {
    validateBackup(backup, backupPath, errors);
  });
  validateUniqueIds(value.apps, [...path, "apps"], errors);
  validateUniqueIds(value.backups, [...path, "backups"], errors);
}

function validateIdentity(value: JsonRecord, path: Path, errors: ValidationError[]): void {
  rejectUnknownFields(value, IDENTITY_FIELDS, path, errors);
  validateOptionalObject(value, "owner", [...path, "owner"], errors, validateOwner);
  validateOptionalBoolean(value, "passkeysRequired", [...path, "passkeysRequired"], errors);
}

function validateOwner(value: JsonRecord, path: Path, errors: ValidationError[]): void {
  rejectUnknownFields(value, OWNER_FIELDS, path, errors);
  validateRequiredString(value, "id", [...path, "id"], errors);
  validateOptionalString(value, "displayName", [...path, "displayName"], errors);
}

function validateStorage(value: JsonRecord, path: Path, errors: ValidationError[]): void {
  rejectUnknownFields(value, STORAGE_FIELDS, path, errors);
  validateOptionalObject(value, "dataVolume", [...path, "dataVolume"], errors, validateDataVolume);
}

function validateDataVolume(value: JsonRecord, path: Path, errors: ValidationError[]): void {
  rejectUnknownFields(value, DATA_VOLUME_FIELDS, path, errors);
  validateOptionalStringEnum(
    value,
    "encryption",
    STORAGE_ENCRYPTION_MODES,
    [...path, "encryption"],
    errors,
  );
  validateOptionalStringEnum(
    value,
    "snapshots",
    SNAPSHOT_CADENCES,
    [...path, "snapshots"],
    errors,
  );
  validateOptionalPositiveInteger(value, "quotaGiB", [...path, "quotaGiB"], errors);
}

function validateApp(
  value: unknown,
  path: Path,
  errors: ValidationError[],
  device: DeviceSnapshot | undefined,
): void {
  if (!isRecord(value)) {
    addError(errors, path, "Expected app object.");
    return;
  }

  rejectUnknownFields(value, APP_FIELDS, path, errors);
  validateRequiredString(value, "id", [...path, "id"], errors);
  validateOptionalBoolean(value, "enabled", [...path, "enabled"], errors);
  validateOptionalString(value, "version", [...path, "version"], errors);

  if (hasDefinedProperty(value, "config")) {
    validateAppConfig(value.config, [...path, "config"], errors, device);
  }
}

function validateAppConfig(
  value: unknown,
  path: Path,
  errors: ValidationError[],
  device: DeviceSnapshot | undefined,
): void {
  if (!isRecord(value)) {
    addError(errors, path, "Expected app config object.");
    return;
  }

  validateJsonValue(value, path, errors);

  const allowedCapabilities = readAllowedCapabilities(value, [...path, "allowedCapabilities"], errors);

  if (hasDefinedProperty(value, "publicAccess")) {
    if (typeof value.publicAccess !== "boolean") {
      addError(errors, [...path, "publicAccess"], "Expected boolean.");
    } else if (value.publicAccess) {
      requireAllowedCapability(
        "network.public",
        allowedCapabilities,
        [...path, "publicAccess"],
        errors,
      );
    }
  }

  if (hasDefinedProperty(value, "memory") && typeof value.memory !== "string") {
    addError(errors, [...path, "memory"], "Expected string.");
  }

  if (hasDefinedProperty(value, "capabilities")) {
    validateRequestedCapabilities(
      value.capabilities,
      [...path, "capabilities"],
      allowedCapabilities,
      errors,
    );
  }

  if (hasDefinedProperty(value, "dataAccess")) {
    validateDataAccess(value.dataAccess, [...path, "dataAccess"], allowedCapabilities, errors);
  }

  if (hasDefinedProperty(value, "accelerator")) {
    if (device === undefined) {
      addError(
        errors,
        [...path, "accelerator"],
        "Cannot validate accelerator request against an invalid device snapshot.",
      );
    } else {
      validateAcceleratorConfig(value.accelerator, [...path, "accelerator"], device, errors);
    }
  }
}

function validateBackup(value: unknown, path: Path, errors: ValidationError[]): void {
  if (!isRecord(value)) {
    addError(errors, path, "Expected backup object.");
    return;
  }

  rejectUnknownFields(value, BACKUP_FIELDS, path, errors);
  validateRequiredString(value, "id", [...path, "id"], errors);
  validateRequiredStringEnum(value, "target", BACKUP_TARGETS, [...path, "target"], errors);
  validateRequiredStringEnum(value, "schedule", BACKUP_SCHEDULES, [...path, "schedule"], errors);
  validateOptionalBoolean(value, "enabled", [...path, "enabled"], errors);
  validateOptionalPositiveInteger(value, "retentionDays", [...path, "retentionDays"], errors);
}

function validateDeviceSnapshot(value: unknown, path: Path, errors: ValidationError[]): void {
  if (!isRecord(value)) {
    addError(errors, path, "Expected device snapshot object.");
    return;
  }

  rejectUnknownFields(value, DEVICE_FIELDS, path, errors);
  validateRequiredPositiveNumber(value, "memoryGB", [...path, "memoryGB"], errors);
  validateRequiredStringEnum(value, "architecture", DEVICE_ARCHITECTURES, [...path, "architecture"], errors);

  if (!hasDefinedProperty(value, "accelerators")) {
    addError(errors, [...path, "accelerators"], "Required field is missing.");
  } else if (!Array.isArray(value.accelerators)) {
    addError(errors, [...path, "accelerators"], "Expected array.");
  } else {
    value.accelerators.forEach((accelerator, index) => {
      validateAcceleratorCapability(accelerator, [...path, "accelerators", String(index)], errors);
    });
  }

  validateRequiredObject(value, "tpm", [...path, "tpm"], errors, validateTpm);
  validateRequiredObject(
    value,
    "virtualization",
    [...path, "virtualization"],
    errors,
    validateVirtualization,
  );
  validateOptionalObject(value, "storage", [...path, "storage"], errors, validateDeviceStorage);
  validateOptionalObject(value, "networking", [...path, "networking"], errors, validateNetworking);
}

function validateTpm(value: JsonRecord, path: Path, errors: ValidationError[]): void {
  rejectUnknownFields(value, TPM_FIELDS, path, errors);
  validateRequiredBoolean(value, "present", [...path, "present"], errors);
  validateOptionalString(value, "version", [...path, "version"], errors);
  validateOptionalBoolean(value, "sealedKeyUnlock", [...path, "sealedKeyUnlock"], errors);
}

function validateVirtualization(value: JsonRecord, path: Path, errors: ValidationError[]): void {
  rejectUnknownFields(value, VIRTUALIZATION_FIELDS, path, errors);
  validateRequiredBoolean(value, "hardware", [...path, "hardware"], errors);
  validateOptionalBoolean(value, "nested", [...path, "nested"], errors);
}

function validateDeviceStorage(value: JsonRecord, path: Path, errors: ValidationError[]): void {
  rejectUnknownFields(value, DEVICE_STORAGE_FIELDS, path, errors);
  validateOptionalPositiveNumber(value, "bootGB", [...path, "bootGB"], errors);
  validateOptionalPositiveNumber(value, "dataGB", [...path, "dataGB"], errors);
}

function validateNetworking(value: JsonRecord, path: Path, errors: ValidationError[]): void {
  rejectUnknownFields(value, NETWORKING_FIELDS, path, errors);
  validateOptionalBoolean(value, "ethernet", [...path, "ethernet"], errors);
  validateOptionalBoolean(value, "wifi", [...path, "wifi"], errors);
}

function validateAcceleratorConfig(
  value: unknown,
  path: Path,
  device: DeviceSnapshot,
  errors: ValidationError[],
): void {
  if (!isRecord(value)) {
    addError(errors, path, "Expected accelerator request object.");
    return;
  }

  if (value.type === "accelerator-selection") {
    validateAcceleratorSelection(value, path, device, errors);
    return;
  }

  if (value.type === "accelerator-refusal") {
    validateAcceleratorRefusal(value, path, errors);
    addError(
      errors,
      path,
      "Accelerator request was refused; no matching accelerator is available without CPU fallback.",
    );
    return;
  }

  const request = parseAcceleratorRequest(value, path, ACCELERATOR_REQUEST_FIELDS, errors);

  if (request === undefined) {
    return;
  }

  const result = bestAvailable(device, request);

  if (result.type === "accelerator-refusal") {
    addError(
      errors,
      path,
      "No preferred accelerator is available and CPU fallback was not allowed.",
    );
  }
}

function validateAcceleratorSelection(
  value: JsonRecord,
  path: Path,
  device: DeviceSnapshot,
  errors: ValidationError[],
): void {
  const errorStart = errors.length;

  rejectUnknownFields(value, ACCELERATOR_SELECTION_FIELDS, path, errors);
  validateRequiredLiteral(
    value,
    "type",
    "accelerator-selection",
    [...path, "type"],
    errors,
  );
  validateRequiredPreference(value, "selectedPreference", [...path, "selectedPreference"], errors);
  validateRequiredBoolean(value, "fallback", [...path, "fallback"], errors);

  if (!hasDefinedProperty(value, "selected")) {
    addError(errors, [...path, "selected"], "Required field is missing.");
  } else {
    validateAcceleratorCapability(value.selected, [...path, "selected"], errors);
  }

  const request = parseAcceleratorRequest(value, path, ACCELERATOR_SELECTION_FIELDS, errors);

  if (request === undefined || errors.length > errorStart) {
    return;
  }

  const result = bestAvailable(device, request);

  if (result.type !== "accelerator-selection") {
    addError(
      errors,
      path,
      "No preferred accelerator is available and CPU fallback was not allowed.",
    );
    return;
  }

  if (value.selectedPreference !== result.selectedPreference) {
    addError(errors, [...path, "selectedPreference"], "Selected preference does not match device snapshot.");
  }

  if (value.fallback !== result.fallback) {
    addError(errors, [...path, "fallback"], "Fallback flag does not match device snapshot.");
  }

  if (stableJson(value.selected) !== stableJson(result.selected)) {
    addError(errors, [...path, "selected"], "Selected accelerator is not available on this device.");
  }
}

function validateAcceleratorRefusal(
  value: JsonRecord,
  path: Path,
  errors: ValidationError[],
): void {
  rejectUnknownFields(value, ACCELERATOR_REFUSAL_FIELDS, path, errors);
  validateRequiredLiteral(value, "type", "accelerator-refusal", [...path, "type"], errors);
  validateRequiredLiteral(value, "code", "ACCELERATOR_UNAVAILABLE", [...path, "code"], errors);
  validateRequiredString(value, "reason", [...path, "reason"], errors);

  if (!hasDefinedProperty(value, "requireFallback")) {
    addError(errors, [...path, "requireFallback"], "Required field is missing.");
  } else if (value.requireFallback !== false) {
    addError(errors, [...path, "requireFallback"], "Expected false.");
  }

  parsePreferenceArray(value.prefer, [...path, "prefer"], errors);

  if (!hasDefinedProperty(value, "available")) {
    addError(errors, [...path, "available"], "Required field is missing.");
  } else if (!Array.isArray(value.available)) {
    addError(errors, [...path, "available"], "Expected array.");
  } else {
    value.available.forEach((accelerator, index) => {
      validateAcceleratorCapability(accelerator, [...path, "available", String(index)], errors);
    });
  }
}

function parseAcceleratorRequest(
  value: JsonRecord,
  path: Path,
  fields: ReadonlySet<string>,
  errors: ValidationError[],
): AcceleratorRequest | undefined {
  const errorStart = errors.length;

  rejectUnknownFields(value, fields, path, errors);
  const prefer = parsePreferenceArray(value.prefer, [...path, "prefer"], errors);
  const requireFallback = parseFallback(value.requireFallback, [...path, "requireFallback"], errors);

  if (prefer === undefined || requireFallback === undefined || errors.length > errorStart) {
    return undefined;
  }

  return {
    prefer,
    requireFallback,
  };
}

function parsePreferenceArray(
  value: unknown,
  path: Path,
  errors: ValidationError[],
): readonly AcceleratorPreference[] | undefined {
  const errorStart = errors.length;

  if (value === undefined) {
    addError(errors, path, "Required field is missing.");
    return undefined;
  }

  if (!Array.isArray(value)) {
    addError(errors, path, "Expected array.");
    return undefined;
  }

  if (value.length === 0) {
    addError(errors, path, "Expected at least one accelerator preference.");
  }

  const preferences: AcceleratorPreference[] = [];

  value.forEach((preference, index) => {
    if (!isStringInSet(preference, ACCELERATOR_PREFERENCES)) {
      addError(errors, [...path, String(index)], "Expected one of: npu, gpu, cpu.");
      return;
    }

    preferences.push(preference);
  });

  return errors.length === errorStart ? preferences : undefined;
}

function parseFallback(
  value: unknown,
  path: Path,
  errors: ValidationError[],
): AcceleratorFallback | undefined {
  if (value === undefined) {
    addError(errors, path, "Required field is missing.");
    return undefined;
  }

  if (value === false || value === "cpu") {
    return value;
  }

  addError(errors, path, "Expected false or cpu.");
  return undefined;
}

function validateAcceleratorCapability(
  value: unknown,
  path: Path,
  errors: ValidationError[],
): void {
  if (!isRecord(value)) {
    addError(errors, path, "Expected accelerator capability object.");
    return;
  }

  switch (value.kind) {
    case "nvidia.cuda":
      rejectUnknownFields(value, new Set(["kind", "memoryGB", "compute"]), path, errors);
      validateRequiredPositiveNumber(value, "memoryGB", [...path, "memoryGB"], errors);
      validateRequiredString(value, "compute", [...path, "compute"], errors);
      return;
    case "intel.npu":
    case "amd.npu":
      rejectUnknownFields(value, new Set(["kind", "generation"]), path, errors);
      validateRequiredString(value, "generation", [...path, "generation"], errors);
      return;
    case "amd.rocm":
      rejectUnknownFields(value, new Set(["kind", "memoryGB"]), path, errors);
      validateRequiredPositiveNumber(value, "memoryGB", [...path, "memoryGB"], errors);
      return;
    case "intel.gpu":
      rejectUnknownFields(value, new Set(["kind", "memoryModel"]), path, errors);
      validateRequiredStringEnum(
        value,
        "memoryModel",
        new Set(["shared", "dedicated"]),
        [...path, "memoryModel"],
        errors,
      );
      return;
    case "cpu":
      rejectUnknownFields(value, new Set(["kind", "architecture"]), path, errors);
      validateRequiredStringEnum(
        value,
        "architecture",
        DEVICE_ARCHITECTURES,
        [...path, "architecture"],
        errors,
      );
      return;
    default:
      addError(errors, [...path, "kind"], "Expected a known accelerator kind.");
  }
}

function readAllowedCapabilities(
  value: JsonRecord,
  path: Path,
  errors: ValidationError[],
): ReadonlySet<AllowedCapability> {
  const allowed = new Set<AllowedCapability>();

  if (!hasDefinedProperty(value, "allowedCapabilities")) {
    return allowed;
  }

  if (!Array.isArray(value.allowedCapabilities)) {
    addError(errors, path, "Expected array.");
    return allowed;
  }

  value.allowedCapabilities.forEach((capability, index) => {
    if (!isAllowedCapability(capability)) {
      addError(errors, [...path, String(index)], "Expected a known allowed capability.");
      return;
    }

    allowed.add(capability);
  });

  return allowed;
}

function validateRequestedCapabilities(
  value: unknown,
  path: Path,
  allowed: ReadonlySet<AllowedCapability>,
  errors: ValidationError[],
): void {
  if (!Array.isArray(value)) {
    addError(errors, path, "Expected array.");
    return;
  }

  value.forEach((capability, index) => {
    const capabilityPath = [...path, String(index)];

    if (!isAllowedCapability(capability)) {
      addError(errors, capabilityPath, "Expected a known allowed capability.");
      return;
    }

    requireAllowedCapability(capability, allowed, capabilityPath, errors);
  });
}

function validateDataAccess(
  value: unknown,
  path: Path,
  allowed: ReadonlySet<AllowedCapability>,
  errors: ValidationError[],
): void {
  if (!Array.isArray(value)) {
    addError(errors, path, "Expected array.");
    return;
  }

  value.forEach((grant, index) => {
    const grantPath = [...path, String(index)];
    const errorStart = errors.length;

    if (!isRecord(grant)) {
      addError(errors, grantPath, "Expected data access grant object.");
      return;
    }

    rejectUnknownFields(grant, DATA_ACCESS_FIELDS, grantPath, errors);
    validateRequiredLiteral(grant, "type", "data-access", [...grantPath, "type"], errors);
    validateRequiredLiteral(grant, "scope", "files", [...grantPath, "scope"], errors);
    validateRequiredLiteral(grant, "mode", "read-only", [...grantPath, "mode"], errors);

    if (errors.length === errorStart) {
      requireAllowedCapability("data.files.read-only", allowed, grantPath, errors);
    }
  });
}

function requireAllowedCapability(
  capability: AllowedCapability,
  allowed: ReadonlySet<AllowedCapability>,
  path: Path,
  errors: ValidationError[],
): void {
  if (!allowed.has(capability)) {
    addError(
      errors,
      path,
      `Requested capability ${capability} is not declared in allowedCapabilities.`,
    );
  }
}

function validateJsonValue(value: unknown, path: Path, errors: ValidationError[]): void {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    Number.isFinite(value)
  ) {
    return;
  }

  if (typeof value === "number") {
    addError(errors, path, "Expected finite number.");
    return;
  }

  if (Array.isArray(value)) {
    value.forEach((item, index) => {
      validateJsonValue(item, [...path, String(index)], errors);
    });
    return;
  }

  if (isRecord(value)) {
    for (const key of Object.keys(value).sort(compareStrings)) {
      validateJsonValue(value[key], [...path, key], errors);
    }
    return;
  }

  if (value === undefined) {
    addError(errors, path, "Undefined values are not allowed.");
    return;
  }

  addError(errors, path, "Expected JSON value.");
}

function validateUniqueIds(
  value: unknown,
  path: Path,
  errors: ValidationError[],
): void {
  if (!Array.isArray(value)) {
    return;
  }

  const seen = new Set<string>();

  value.forEach((item, index) => {
    if (!isRecord(item) || typeof item.id !== "string") {
      return;
    }

    if (seen.has(item.id)) {
      addError(errors, [...path, String(index), "id"], "Duplicate id.");
      return;
    }

    seen.add(item.id);
  });
}

function validateOptionalObject(
  value: JsonRecord,
  key: string,
  path: Path,
  errors: ValidationError[],
  validate: (objectValue: JsonRecord, objectPath: Path, objectErrors: ValidationError[]) => void,
): void {
  if (!hasDefinedProperty(value, key)) {
    return;
  }

  const child = value[key];

  if (!isRecord(child)) {
    addError(errors, path, "Expected object.");
    return;
  }

  validate(child, path, errors);
}

function validateRequiredObject(
  value: JsonRecord,
  key: string,
  path: Path,
  errors: ValidationError[],
  validate: (objectValue: JsonRecord, objectPath: Path, objectErrors: ValidationError[]) => void,
): void {
  if (!hasDefinedProperty(value, key)) {
    addError(errors, path, "Required field is missing.");
    return;
  }

  const child = value[key];

  if (!isRecord(child)) {
    addError(errors, path, "Expected object.");
    return;
  }

  validate(child, path, errors);
}

function validateOptionalArray(
  value: JsonRecord,
  key: string,
  path: Path,
  errors: ValidationError[],
  validate: (item: unknown, itemPath: Path) => void,
): void {
  if (!hasDefinedProperty(value, key)) {
    return;
  }

  const child = value[key];

  if (!Array.isArray(child)) {
    addError(errors, path, "Expected array.");
    return;
  }

  child.forEach((item, index) => {
    validate(item, [...path, String(index)]);
  });
}

function validateRequiredString(
  value: JsonRecord,
  key: string,
  path: Path,
  errors: ValidationError[],
): void {
  if (!hasDefinedProperty(value, key)) {
    addError(errors, path, "Required field is missing.");
    return;
  }

  if (typeof value[key] !== "string" || value[key] === "") {
    addError(errors, path, "Expected non-empty string.");
  }
}

function validateOptionalString(
  value: JsonRecord,
  key: string,
  path: Path,
  errors: ValidationError[],
): void {
  if (!hasDefinedProperty(value, key)) {
    return;
  }

  if (typeof value[key] !== "string") {
    addError(errors, path, "Expected string.");
  }
}

function validateRequiredBoolean(
  value: JsonRecord,
  key: string,
  path: Path,
  errors: ValidationError[],
): void {
  if (!hasDefinedProperty(value, key)) {
    addError(errors, path, "Required field is missing.");
    return;
  }

  if (typeof value[key] !== "boolean") {
    addError(errors, path, "Expected boolean.");
  }
}

function validateOptionalBoolean(
  value: JsonRecord,
  key: string,
  path: Path,
  errors: ValidationError[],
): void {
  if (!hasDefinedProperty(value, key)) {
    return;
  }

  if (typeof value[key] !== "boolean") {
    addError(errors, path, "Expected boolean.");
  }
}

function validateRequiredLiteral(
  value: JsonRecord,
  key: string,
  expected: string,
  path: Path,
  errors: ValidationError[],
): void {
  if (!hasDefinedProperty(value, key)) {
    addError(errors, path, "Required field is missing.");
    return;
  }

  if (value[key] !== expected) {
    addError(errors, path, `Expected ${expected}.`);
  }
}

function validateRequiredPreference(
  value: JsonRecord,
  key: string,
  path: Path,
  errors: ValidationError[],
): void {
  if (!hasDefinedProperty(value, key)) {
    addError(errors, path, "Required field is missing.");
    return;
  }

  if (!isStringInSet(value[key], ACCELERATOR_PREFERENCES)) {
    addError(errors, path, "Expected one of: npu, gpu, cpu.");
  }
}

function validateRequiredStringEnum(
  value: JsonRecord,
  key: string,
  allowed: ReadonlySet<string>,
  path: Path,
  errors: ValidationError[],
): void {
  if (!hasDefinedProperty(value, key)) {
    addError(errors, path, "Required field is missing.");
    return;
  }

  if (!isStringInSet(value[key], allowed)) {
    addError(errors, path, `Expected one of: ${[...allowed].join(", ")}.`);
  }
}

function validateOptionalStringEnum(
  value: JsonRecord,
  key: string,
  allowed: ReadonlySet<string>,
  path: Path,
  errors: ValidationError[],
): void {
  if (!hasDefinedProperty(value, key)) {
    return;
  }

  if (!isStringInSet(value[key], allowed)) {
    addError(errors, path, `Expected one of: ${[...allowed].join(", ")}.`);
  }
}

function validateRequiredPositiveNumber(
  value: JsonRecord,
  key: string,
  path: Path,
  errors: ValidationError[],
): void {
  if (!hasDefinedProperty(value, key)) {
    addError(errors, path, "Required field is missing.");
    return;
  }

  if (typeof value[key] !== "number" || !Number.isFinite(value[key]) || value[key] <= 0) {
    addError(errors, path, "Expected positive finite number.");
  }
}

function validateOptionalPositiveNumber(
  value: JsonRecord,
  key: string,
  path: Path,
  errors: ValidationError[],
): void {
  if (!hasDefinedProperty(value, key)) {
    return;
  }

  if (typeof value[key] !== "number" || !Number.isFinite(value[key]) || value[key] <= 0) {
    addError(errors, path, "Expected positive finite number.");
  }
}

function validateOptionalPositiveInteger(
  value: JsonRecord,
  key: string,
  path: Path,
  errors: ValidationError[],
): void {
  if (!hasDefinedProperty(value, key)) {
    return;
  }

  if (
    typeof value[key] !== "number" ||
    !Number.isFinite(value[key]) ||
    !Number.isInteger(value[key]) ||
    value[key] <= 0
  ) {
    addError(errors, path, "Expected positive integer.");
  }
}

function rejectUnknownFields(
  value: JsonRecord,
  allowed: ReadonlySet<string>,
  path: Path,
  errors: ValidationError[],
): void {
  for (const key of Object.keys(value).sort(compareStrings)) {
    if (!allowed.has(key)) {
      addError(errors, [...path, key], "Unknown field.");
    }
  }
}

function isRecord(value: unknown): value is JsonRecord {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }

  const prototype = Object.getPrototypeOf(value);

  return prototype === Object.prototype || prototype === null;
}

function hasDefinedProperty(value: JsonRecord, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key) && value[key] !== undefined;
}

function isAllowedCapability(value: unknown): value is AllowedCapability {
  return typeof value === "string" && APP_ALLOWED_CAPABILITIES.has(value as AllowedCapability);
}

function isStringInSet<T extends string>(value: unknown, allowed: ReadonlySet<T>): value is T {
  return typeof value === "string" && allowed.has(value as T);
}

function stableJson(value: unknown): string {
  return JSON.stringify(stableValue(value));
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(stableValue);
  }

  if (isRecord(value)) {
    const output: Record<string, unknown> = {};

    for (const key of Object.keys(value).sort(compareStrings)) {
      output[key] = stableValue(value[key]);
    }

    return output;
  }

  return value;
}

function addError(errors: ValidationError[], path: Path, message: string): void {
  errors.push({
    path: formatPath(path),
    message,
  });
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
