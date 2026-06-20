import type {
  AcceleratorCapability,
  AcceleratorPreference,
} from "../../typescript/src/capabilities.ts";

export interface ValidationError {
  path: string;
  message: string;
}

export type PackageContractValidationResult =
  | {
      ok: true;
      contract: PackageContract;
    }
  | {
      ok: false;
      errors: ValidationError[];
    };

export type PackageClass =
  | "ts-service"
  | "ts-extension"
  | "wasm-component"
  | "oci-service"
  | "microvm-service"
  | "ui-extension"
  | "native-extension";

export type PackageArchitecture = "x86_64" | "arm64";
export type DigestAlgorithm = "sha256" | "sha384" | "sha512";

export interface PackageContract {
  readonly packageClass: PackageClass;
  readonly identity: PackageIdentity;
  readonly signingPublisher: SigningPublisher;
  readonly version: string;
  readonly digest: ImmutableDigest;
  readonly architectures: readonly PackageArchitecture[];
  readonly resources: ResourceMinimums;
  readonly accelerators: AcceleratorRequirements;
  readonly network: NetworkPolicy;
  readonly data: DataRequirements;
  readonly secrets: readonly SecretRequirement[];
  readonly backup: BackupContract;
  readonly restore: RestoreContract;
  readonly healthChecks: readonly HealthCheck[];
  readonly updates: UpdateContract;
  readonly rollback: RollbackLimits;
  readonly exportFormats: readonly ExportFormat[];
  readonly endOfSupportDate: string;
  readonly sbom: SbomStatus;
  readonly vulnerabilityStatus: VulnerabilityStatus;
  readonly requiredSimulationProfiles: readonly string[];
}

export interface PackageIdentity {
  readonly id: string;
  readonly name: string;
  readonly description?: string;
}

export interface SigningPublisher {
  readonly id: string;
  readonly signingKeyRef: string;
}

export interface ImmutableDigest {
  readonly algorithm: DigestAlgorithm;
  readonly value: string;
}

export interface ResourceMinimums {
  readonly cpuCores: number;
  readonly ramMiB: number;
  readonly storageMiB: number;
}

export type PackageAcceleratorCapability = Exclude<
  AcceleratorCapability,
  { readonly kind: "cpu"; readonly architecture: PackageArchitecture }
>;

export interface AcceleratorRequirements {
  readonly required: readonly PackageAcceleratorCapability[];
  readonly optional: readonly PackageAcceleratorCapability[];
  readonly preference: readonly AcceleratorPreference[];
}

export type NetworkProtocol = "http" | "https" | "tcp" | "udp" | "ws" | "wss";

export interface NetworkPolicy {
  readonly ingress: readonly NetworkIngressRule[];
  readonly egress: readonly NetworkEgressRule[];
}

export interface NetworkIngressRule {
  readonly name: string;
  readonly protocol: NetworkProtocol;
  readonly port: number;
  readonly public: boolean;
}

export interface NetworkEgressRule {
  readonly name: string;
  readonly protocol: NetworkProtocol;
  readonly destinations: readonly string[];
  readonly ports: readonly number[];
}

export type DataClass =
  | "user-content"
  | "app-state"
  | "cache"
  | "logs"
  | "telemetry"
  | "configuration";

export interface DataRequirements {
  readonly classes: readonly DataClass[];
  readonly volumes: readonly DataVolumeRequirement[];
}

export interface DataVolumeRequirement {
  readonly name: string;
  readonly mountPath: string;
  readonly class: DataClass;
  readonly access: "read-only" | "read-write";
  readonly persistence: "ephemeral" | "persistent";
  readonly backup: boolean;
  readonly sizeMiB: number;
}

export interface SecretRequirement {
  readonly name: string;
  readonly ref: string;
  readonly purpose: string;
  readonly optional?: boolean;
}

export interface PackageHook {
  readonly name: string;
  readonly entrypoint: string;
  readonly timeoutSeconds: number;
}

export type BackupStrategy = "none" | "filesystem-snapshot" | "application-consistent";

export interface BackupContract {
  readonly strategy: BackupStrategy;
  readonly includeVolumes: readonly string[];
  readonly quiesceHooks: readonly PackageHook[];
  readonly backupHooks: readonly PackageHook[];
}

export interface RestoreContract {
  readonly requireCleanVerification: boolean;
  readonly verificationHooks: readonly PackageHook[];
}

export interface HealthCheck {
  readonly name: string;
  readonly type: "http" | "tcp" | "lifecycle";
  readonly target: string;
  readonly intervalSeconds: number;
  readonly timeoutSeconds: number;
}

export interface UpdateContract {
  readonly channel: "stable" | "beta" | "dev";
  readonly strategy: "replace" | "rolling" | "manual";
  readonly schemaMigrations: readonly SchemaMigration[];
}

export interface SchemaMigration {
  readonly id: string;
  readonly fromVersion: string;
  readonly toVersion: string;
  readonly hook: PackageHook;
  readonly reversible: boolean;
}

export interface RollbackLimits {
  readonly maxRollbackVersions: number;
  readonly maxRollbackAgeDays: number;
  readonly requiresFreshBackup: boolean;
}

export type ExportFormat = "vita-capsule" | "oci-image" | "tar.zst" | "json" | "sqlite-dump";

export interface SbomStatus {
  readonly format: "spdx-json" | "cyclonedx-json";
  readonly digest: ImmutableDigest;
  readonly generatedAt: string;
}

export interface VulnerabilityStatus {
  readonly status: "clean" | "known-vulnerabilities" | "scan-pending" | "scan-unavailable";
  readonly scannedAt?: string;
  readonly critical: number;
  readonly high: number;
  readonly medium: number;
  readonly low: number;
}

type JsonRecord = Readonly<Record<string, unknown>>;
type Path = readonly string[];

interface ValidationContext {
  readonly errors: ValidationError[];
  readonly seen: WeakSet<object>;
}

const MAX_PATH_DEPTH = 40;

const TOP_LEVEL_FIELDS = new Set([
  "packageClass",
  "identity",
  "signingPublisher",
  "version",
  "digest",
  "architectures",
  "resources",
  "accelerators",
  "network",
  "data",
  "secrets",
  "backup",
  "restore",
  "healthChecks",
  "updates",
  "rollback",
  "exportFormats",
  "endOfSupportDate",
  "sbom",
  "vulnerabilityStatus",
  "requiredSimulationProfiles",
]);
const IDENTITY_FIELDS = new Set(["id", "name", "description"]);
const SIGNING_PUBLISHER_FIELDS = new Set(["id", "signingKeyRef"]);
const DIGEST_FIELDS = new Set(["algorithm", "value"]);
const RESOURCE_FIELDS = new Set(["cpuCores", "ramMiB", "storageMiB"]);
const ACCELERATOR_FIELDS = new Set(["required", "optional", "preference"]);
const NETWORK_FIELDS = new Set(["ingress", "egress"]);
const INGRESS_FIELDS = new Set(["name", "protocol", "port", "public"]);
const EGRESS_FIELDS = new Set(["name", "protocol", "destinations", "ports"]);
const DATA_FIELDS = new Set(["classes", "volumes"]);
const DATA_VOLUME_FIELDS = new Set([
  "name",
  "mountPath",
  "class",
  "access",
  "persistence",
  "backup",
  "sizeMiB",
]);
const SECRET_FIELDS = new Set(["name", "ref", "purpose", "optional"]);
const INLINE_SECRET_FIELDS = new Set([
  "value",
  "plaintext",
  "secret",
  "token",
  "password",
  "privateKey",
  "data",
]);
const HOOK_FIELDS = new Set(["name", "entrypoint", "timeoutSeconds"]);
const BACKUP_FIELDS = new Set(["strategy", "includeVolumes", "quiesceHooks", "backupHooks"]);
const RESTORE_FIELDS = new Set(["requireCleanVerification", "verificationHooks"]);
const HEALTH_CHECK_FIELDS = new Set([
  "name",
  "type",
  "target",
  "intervalSeconds",
  "timeoutSeconds",
]);
const UPDATE_FIELDS = new Set(["channel", "strategy", "schemaMigrations"]);
const MIGRATION_FIELDS = new Set(["id", "fromVersion", "toVersion", "hook", "reversible"]);
const ROLLBACK_FIELDS = new Set([
  "maxRollbackVersions",
  "maxRollbackAgeDays",
  "requiresFreshBackup",
]);
const SBOM_FIELDS = new Set(["format", "digest", "generatedAt"]);
const VULNERABILITY_FIELDS = new Set(["status", "scannedAt", "critical", "high", "medium", "low"]);

const PACKAGE_CLASSES = new Set([
  "ts-service",
  "ts-extension",
  "wasm-component",
  "oci-service",
  "microvm-service",
  "ui-extension",
  "native-extension",
]);
const ARCHITECTURES = new Set(["x86_64", "arm64"]);
const DIGEST_ALGORITHMS = new Set(["sha256", "sha384", "sha512"]);
const ACCELERATOR_PREFERENCES = new Set(["npu", "gpu", "cpu"]);
const NETWORK_PROTOCOLS = new Set(["http", "https", "tcp", "udp", "ws", "wss"]);
const DATA_CLASSES = new Set([
  "user-content",
  "app-state",
  "cache",
  "logs",
  "telemetry",
  "configuration",
]);
const DATA_ACCESS_MODES = new Set(["read-only", "read-write"]);
const DATA_PERSISTENCE_MODES = new Set(["ephemeral", "persistent"]);
const BACKUP_STRATEGIES = new Set(["none", "filesystem-snapshot", "application-consistent"]);
const HEALTH_CHECK_TYPES = new Set(["http", "tcp", "lifecycle"]);
const UPDATE_CHANNELS = new Set(["stable", "beta", "dev"]);
const UPDATE_STRATEGIES = new Set(["replace", "rolling", "manual"]);
const EXPORT_FORMATS = new Set(["vita-capsule", "oci-image", "tar.zst", "json", "sqlite-dump"]);
const SBOM_FORMATS = new Set(["spdx-json", "cyclonedx-json"]);
const VULNERABILITY_STATUSES = new Set([
  "clean",
  "known-vulnerabilities",
  "scan-pending",
  "scan-unavailable",
]);

export function validatePackageContract(c: unknown): PackageContractValidationResult {
  const errors: ValidationError[] = [];
  const context: ValidationContext = {
    errors,
    seen: new WeakSet<object>(),
  };

  try {
    validateContract(c, [], context);
  } catch (error) {
    addError(
      errors,
      [],
      error instanceof Error && error.message !== ""
        ? `Validation failed: ${error.message}`
        : "Validation failed.",
    );
  }

  if (errors.length > 0) {
    return {
      ok: false,
      errors,
    };
  }

  return {
    ok: true,
    contract: c as PackageContract,
  };
}

function validateContract(value: unknown, path: Path, context: ValidationContext): void {
  if (!isRecord(value)) {
    addError(context.errors, path, "Expected package contract object.");
    return;
  }

  if (!enterObject(value, path, context)) {
    return;
  }

  try {
    rejectUnknownFields(value, TOP_LEVEL_FIELDS, path, context);
    validateRequiredStringEnum(
      value,
      "packageClass",
      PACKAGE_CLASSES,
      [...path, "packageClass"],
      context,
    );
    validateRequiredObject(value, "identity", [...path, "identity"], context, validateIdentity);
    validateRequiredObject(
      value,
      "signingPublisher",
      [...path, "signingPublisher"],
      context,
      validateSigningPublisher,
    );
    validateRequiredString(value, "version", [...path, "version"], context);
    validateRequiredObject(value, "digest", [...path, "digest"], context, validateDigest);
    validateRequiredStringEnumArray(
      value,
      "architectures",
      ARCHITECTURES,
      [...path, "architectures"],
      context,
    );
    validateRequiredObject(value, "resources", [...path, "resources"], context, validateResources);
    validateRequiredObject(
      value,
      "accelerators",
      [...path, "accelerators"],
      context,
      validateAccelerators,
    );
    validateRequiredObject(value, "network", [...path, "network"], context, validateNetwork);
    validateRequiredObject(value, "data", [...path, "data"], context, validateData);
    validateRequiredArray(value, "secrets", [...path, "secrets"], context, validateSecret);
    validateRequiredObject(value, "backup", [...path, "backup"], context, validateBackup);
    validateRequiredObject(value, "restore", [...path, "restore"], context, validateRestore);
    validateRequiredArray(
      value,
      "healthChecks",
      [...path, "healthChecks"],
      context,
      validateHealthCheck,
    );
    validateRequiredObject(value, "updates", [...path, "updates"], context, validateUpdates);
    validateRequiredObject(value, "rollback", [...path, "rollback"], context, validateRollback);
    validateRequiredStringEnumArray(
      value,
      "exportFormats",
      EXPORT_FORMATS,
      [...path, "exportFormats"],
      context,
    );
    validateRequiredDate(value, "endOfSupportDate", [...path, "endOfSupportDate"], context);
    validateRequiredObject(value, "sbom", [...path, "sbom"], context, validateSbom);
    validateRequiredObject(
      value,
      "vulnerabilityStatus",
      [...path, "vulnerabilityStatus"],
      context,
      validateVulnerabilityStatus,
    );
    validateRequiredStringArray(
      value,
      "requiredSimulationProfiles",
      [...path, "requiredSimulationProfiles"],
      context,
    );
  } finally {
    context.seen.delete(value);
  }
}

function validateIdentity(
  value: JsonRecord,
  path: Path,
  context: ValidationContext,
): void {
  if (!enterObject(value, path, context)) {
    return;
  }

  try {
    rejectUnknownFields(value, IDENTITY_FIELDS, path, context);
    validateRequiredString(value, "id", [...path, "id"], context);
    validateRequiredString(value, "name", [...path, "name"], context);
    validateOptionalString(value, "description", [...path, "description"], context);
  } finally {
    context.seen.delete(value);
  }
}

function validateSigningPublisher(
  value: JsonRecord,
  path: Path,
  context: ValidationContext,
): void {
  if (!enterObject(value, path, context)) {
    return;
  }

  try {
    rejectUnknownFields(value, SIGNING_PUBLISHER_FIELDS, path, context);
    validateRequiredString(value, "id", [...path, "id"], context);
    validateRequiredString(value, "signingKeyRef", [...path, "signingKeyRef"], context);
  } finally {
    context.seen.delete(value);
  }
}

function validateDigest(value: JsonRecord, path: Path, context: ValidationContext): void {
  if (!enterObject(value, path, context)) {
    return;
  }

  try {
    rejectUnknownFields(value, DIGEST_FIELDS, path, context);
    validateRequiredStringEnum(
      value,
      "algorithm",
      DIGEST_ALGORITHMS,
      [...path, "algorithm"],
      context,
    );
    validateRequiredString(value, "value", [...path, "value"], context);
  } finally {
    context.seen.delete(value);
  }
}

function validateResources(value: JsonRecord, path: Path, context: ValidationContext): void {
  if (!enterObject(value, path, context)) {
    return;
  }

  try {
    rejectUnknownFields(value, RESOURCE_FIELDS, path, context);
    validateRequiredPositiveNumber(value, "cpuCores", [...path, "cpuCores"], context);
    validateRequiredPositiveInteger(value, "ramMiB", [...path, "ramMiB"], context);
    validateRequiredPositiveInteger(value, "storageMiB", [...path, "storageMiB"], context);
  } finally {
    context.seen.delete(value);
  }
}

function validateAccelerators(
  value: JsonRecord,
  path: Path,
  context: ValidationContext,
): void {
  if (!enterObject(value, path, context)) {
    return;
  }

  try {
    rejectUnknownFields(value, ACCELERATOR_FIELDS, path, context);
    validateRequiredArray(
      value,
      "required",
      [...path, "required"],
      context,
      validateAcceleratorCapability,
    );
    validateRequiredArray(
      value,
      "optional",
      [...path, "optional"],
      context,
      validateAcceleratorCapability,
    );
    validateRequiredStringEnumArray(
      value,
      "preference",
      ACCELERATOR_PREFERENCES,
      [...path, "preference"],
      context,
    );
  } finally {
    context.seen.delete(value);
  }
}

function validateAcceleratorCapability(
  value: unknown,
  path: Path,
  context: ValidationContext,
): void {
  if (!isRecord(value)) {
    addError(context.errors, path, "Expected accelerator capability object.");
    return;
  }

  if (!enterObject(value, path, context)) {
    return;
  }

  try {
    const kind = readProperty(value, "kind", [...path, "kind"], context);

    switch (kind.present ? kind.value : undefined) {
      case "nvidia.cuda":
        rejectUnknownFields(value, new Set(["kind", "memoryGB", "compute"]), path, context);
        validateRequiredPositiveNumber(value, "memoryGB", [...path, "memoryGB"], context);
        validateRequiredString(value, "compute", [...path, "compute"], context);
        return;
      case "intel.npu":
      case "amd.npu":
        rejectUnknownFields(value, new Set(["kind", "generation"]), path, context);
        validateRequiredString(value, "generation", [...path, "generation"], context);
        return;
      case "amd.rocm":
        rejectUnknownFields(value, new Set(["kind", "memoryGB"]), path, context);
        validateRequiredPositiveNumber(value, "memoryGB", [...path, "memoryGB"], context);
        return;
      case "intel.gpu":
        rejectUnknownFields(value, new Set(["kind", "memoryModel"]), path, context);
        validateRequiredStringEnum(
          value,
          "memoryModel",
          new Set(["shared", "dedicated"]),
          [...path, "memoryModel"],
          context,
        );
        return;
      case "cpu":
        rejectUnknownFields(value, new Set(["kind", "architecture"]), path, context);
        addError(context.errors, [...path, "kind"], "Expected GPU or NPU capability, not CPU.");
        return;
      case undefined:
        addError(context.errors, [...path, "kind"], "Required field is missing.");
        return;
      default:
        addError(context.errors, [...path, "kind"], "Expected a known accelerator kind.");
    }
  } finally {
    context.seen.delete(value);
  }
}

function validateNetwork(value: JsonRecord, path: Path, context: ValidationContext): void {
  if (!enterObject(value, path, context)) {
    return;
  }

  try {
    rejectUnknownFields(value, NETWORK_FIELDS, path, context);
    validateRequiredArray(value, "ingress", [...path, "ingress"], context, validateIngress);
    validateRequiredArray(value, "egress", [...path, "egress"], context, validateEgress);
  } finally {
    context.seen.delete(value);
  }
}

function validateIngress(value: unknown, path: Path, context: ValidationContext): void {
  if (!isRecord(value)) {
    addError(context.errors, path, "Expected network ingress rule object.");
    return;
  }

  if (!enterObject(value, path, context)) {
    return;
  }

  try {
    rejectUnknownFields(value, INGRESS_FIELDS, path, context);
    validateRequiredString(value, "name", [...path, "name"], context);
    validateRequiredStringEnum(value, "protocol", NETWORK_PROTOCOLS, [...path, "protocol"], context);
    validateRequiredPort(value, "port", [...path, "port"], context);
    validateRequiredBoolean(value, "public", [...path, "public"], context);
  } finally {
    context.seen.delete(value);
  }
}

function validateEgress(value: unknown, path: Path, context: ValidationContext): void {
  if (!isRecord(value)) {
    addError(context.errors, path, "Expected network egress rule object.");
    return;
  }

  if (!enterObject(value, path, context)) {
    return;
  }

  try {
    rejectUnknownFields(value, EGRESS_FIELDS, path, context);
    validateRequiredString(value, "name", [...path, "name"], context);
    validateRequiredStringEnum(value, "protocol", NETWORK_PROTOCOLS, [...path, "protocol"], context);
    validateRequiredStringArray(value, "destinations", [...path, "destinations"], context);
    validateRequiredPortArray(value, "ports", [...path, "ports"], context);
  } finally {
    context.seen.delete(value);
  }
}

function validateData(value: JsonRecord, path: Path, context: ValidationContext): void {
  if (!enterObject(value, path, context)) {
    return;
  }

  try {
    rejectUnknownFields(value, DATA_FIELDS, path, context);
    validateRequiredStringEnumArray(value, "classes", DATA_CLASSES, [...path, "classes"], context);
    validateRequiredArray(value, "volumes", [...path, "volumes"], context, validateDataVolume);
  } finally {
    context.seen.delete(value);
  }
}

function validateDataVolume(value: unknown, path: Path, context: ValidationContext): void {
  if (!isRecord(value)) {
    addError(context.errors, path, "Expected data volume object.");
    return;
  }

  if (!enterObject(value, path, context)) {
    return;
  }

  try {
    rejectUnknownFields(value, DATA_VOLUME_FIELDS, path, context);
    validateRequiredString(value, "name", [...path, "name"], context);
    validateRequiredString(value, "mountPath", [...path, "mountPath"], context);
    validateRequiredStringEnum(value, "class", DATA_CLASSES, [...path, "class"], context);
    validateRequiredStringEnum(value, "access", DATA_ACCESS_MODES, [...path, "access"], context);
    validateRequiredStringEnum(
      value,
      "persistence",
      DATA_PERSISTENCE_MODES,
      [...path, "persistence"],
      context,
    );
    validateRequiredBoolean(value, "backup", [...path, "backup"], context);
    validateRequiredPositiveInteger(value, "sizeMiB", [...path, "sizeMiB"], context);
  } finally {
    context.seen.delete(value);
  }
}

function validateSecret(value: unknown, path: Path, context: ValidationContext): void {
  if (!isRecord(value)) {
    addError(context.errors, path, "Expected secret requirement object.");
    return;
  }

  if (!enterObject(value, path, context)) {
    return;
  }

  try {
    rejectUnknownFields(value, unionFields(SECRET_FIELDS, INLINE_SECRET_FIELDS), path, context);
    rejectInlineSecretFields(value, path, context);
    validateRequiredString(value, "name", [...path, "name"], context);
    validateRequiredString(value, "ref", [...path, "ref"], context);
    validateRequiredString(value, "purpose", [...path, "purpose"], context);
    validateOptionalBoolean(value, "optional", [...path, "optional"], context);
  } finally {
    context.seen.delete(value);
  }
}

function validateBackup(value: JsonRecord, path: Path, context: ValidationContext): void {
  if (!enterObject(value, path, context)) {
    return;
  }

  try {
    rejectUnknownFields(value, BACKUP_FIELDS, path, context);
    validateRequiredStringEnum(value, "strategy", BACKUP_STRATEGIES, [...path, "strategy"], context);
    validateRequiredStringArray(value, "includeVolumes", [...path, "includeVolumes"], context);
    validateRequiredArray(value, "quiesceHooks", [...path, "quiesceHooks"], context, validateHook);
    validateRequiredArray(value, "backupHooks", [...path, "backupHooks"], context, validateHook);
  } finally {
    context.seen.delete(value);
  }
}

function validateRestore(value: JsonRecord, path: Path, context: ValidationContext): void {
  if (!enterObject(value, path, context)) {
    return;
  }

  try {
    rejectUnknownFields(value, RESTORE_FIELDS, path, context);
    validateRequiredBoolean(
      value,
      "requireCleanVerification",
      [...path, "requireCleanVerification"],
      context,
    );
    validateRequiredArray(
      value,
      "verificationHooks",
      [...path, "verificationHooks"],
      context,
      validateHook,
    );
  } finally {
    context.seen.delete(value);
  }
}

function validateHook(value: unknown, path: Path, context: ValidationContext): void {
  if (!isRecord(value)) {
    addError(context.errors, path, "Expected hook object.");
    return;
  }

  if (!enterObject(value, path, context)) {
    return;
  }

  try {
    rejectUnknownFields(value, HOOK_FIELDS, path, context);
    validateRequiredString(value, "name", [...path, "name"], context);
    validateRequiredString(value, "entrypoint", [...path, "entrypoint"], context);
    validateRequiredPositiveInteger(
      value,
      "timeoutSeconds",
      [...path, "timeoutSeconds"],
      context,
    );
  } finally {
    context.seen.delete(value);
  }
}

function validateHealthCheck(value: unknown, path: Path, context: ValidationContext): void {
  if (!isRecord(value)) {
    addError(context.errors, path, "Expected health check object.");
    return;
  }

  if (!enterObject(value, path, context)) {
    return;
  }

  try {
    rejectUnknownFields(value, HEALTH_CHECK_FIELDS, path, context);
    validateRequiredString(value, "name", [...path, "name"], context);
    validateRequiredStringEnum(value, "type", HEALTH_CHECK_TYPES, [...path, "type"], context);
    validateRequiredString(value, "target", [...path, "target"], context);
    validateRequiredPositiveInteger(
      value,
      "intervalSeconds",
      [...path, "intervalSeconds"],
      context,
    );
    validateRequiredPositiveInteger(
      value,
      "timeoutSeconds",
      [...path, "timeoutSeconds"],
      context,
    );
  } finally {
    context.seen.delete(value);
  }
}

function validateUpdates(value: JsonRecord, path: Path, context: ValidationContext): void {
  if (!enterObject(value, path, context)) {
    return;
  }

  try {
    rejectUnknownFields(value, UPDATE_FIELDS, path, context);
    validateRequiredStringEnum(value, "channel", UPDATE_CHANNELS, [...path, "channel"], context);
    validateRequiredStringEnum(value, "strategy", UPDATE_STRATEGIES, [...path, "strategy"], context);
    validateRequiredArray(
      value,
      "schemaMigrations",
      [...path, "schemaMigrations"],
      context,
      validateMigration,
    );
  } finally {
    context.seen.delete(value);
  }
}

function validateMigration(value: unknown, path: Path, context: ValidationContext): void {
  if (!isRecord(value)) {
    addError(context.errors, path, "Expected schema migration object.");
    return;
  }

  if (!enterObject(value, path, context)) {
    return;
  }

  try {
    rejectUnknownFields(value, MIGRATION_FIELDS, path, context);
    validateRequiredString(value, "id", [...path, "id"], context);
    validateRequiredString(value, "fromVersion", [...path, "fromVersion"], context);
    validateRequiredString(value, "toVersion", [...path, "toVersion"], context);
    validateRequiredObject(value, "hook", [...path, "hook"], context, validateHook);
    validateRequiredBoolean(value, "reversible", [...path, "reversible"], context);
  } finally {
    context.seen.delete(value);
  }
}

function validateRollback(value: JsonRecord, path: Path, context: ValidationContext): void {
  if (!enterObject(value, path, context)) {
    return;
  }

  try {
    rejectUnknownFields(value, ROLLBACK_FIELDS, path, context);
    validateRequiredNonNegativeInteger(
      value,
      "maxRollbackVersions",
      [...path, "maxRollbackVersions"],
      context,
    );
    validateRequiredNonNegativeInteger(
      value,
      "maxRollbackAgeDays",
      [...path, "maxRollbackAgeDays"],
      context,
    );
    validateRequiredBoolean(value, "requiresFreshBackup", [...path, "requiresFreshBackup"], context);
  } finally {
    context.seen.delete(value);
  }
}

function validateSbom(value: JsonRecord, path: Path, context: ValidationContext): void {
  if (!enterObject(value, path, context)) {
    return;
  }

  try {
    rejectUnknownFields(value, SBOM_FIELDS, path, context);
    validateRequiredStringEnum(value, "format", SBOM_FORMATS, [...path, "format"], context);
    validateRequiredObject(value, "digest", [...path, "digest"], context, validateDigest);
    validateRequiredDateTime(value, "generatedAt", [...path, "generatedAt"], context);
  } finally {
    context.seen.delete(value);
  }
}

function validateVulnerabilityStatus(
  value: JsonRecord,
  path: Path,
  context: ValidationContext,
): void {
  if (!enterObject(value, path, context)) {
    return;
  }

  try {
    rejectUnknownFields(value, VULNERABILITY_FIELDS, path, context);
    validateRequiredStringEnum(value, "status", VULNERABILITY_STATUSES, [...path, "status"], context);
    validateOptionalDateTime(value, "scannedAt", [...path, "scannedAt"], context);
    validateRequiredNonNegativeInteger(value, "critical", [...path, "critical"], context);
    validateRequiredNonNegativeInteger(value, "high", [...path, "high"], context);
    validateRequiredNonNegativeInteger(value, "medium", [...path, "medium"], context);
    validateRequiredNonNegativeInteger(value, "low", [...path, "low"], context);
  } finally {
    context.seen.delete(value);
  }
}

function validateRequiredObject(
  value: JsonRecord,
  key: string,
  path: Path,
  context: ValidationContext,
  validate: (objectValue: JsonRecord, objectPath: Path, objectContext: ValidationContext) => void,
): void {
  const property = readProperty(value, key, path, context);

  if (!property.present) {
    addError(context.errors, path, "Required field is missing.");
    return;
  }

  if (!isRecord(property.value)) {
    addError(context.errors, path, "Expected object.");
    return;
  }

  validate(property.value, path, context);
}

function validateRequiredArray(
  value: JsonRecord,
  key: string,
  path: Path,
  context: ValidationContext,
  validate: (item: unknown, itemPath: Path, itemContext: ValidationContext) => void,
): void {
  const property = readProperty(value, key, path, context);

  if (!property.present) {
    addError(context.errors, path, "Required field is missing.");
    return;
  }

  if (!Array.isArray(property.value)) {
    addError(context.errors, path, "Expected array.");
    return;
  }

  if (!enterArray(property.value, path, context)) {
    return;
  }

  try {
    property.value.forEach((item, index) => {
      validate(item, [...path, String(index)], context);
    });
  } finally {
    context.seen.delete(property.value);
  }
}

function validateRequiredString(
  value: JsonRecord,
  key: string,
  path: Path,
  context: ValidationContext,
): void {
  const property = readProperty(value, key, path, context);

  if (!property.present) {
    addError(context.errors, path, "Required field is missing.");
    return;
  }

  if (typeof property.value !== "string" || property.value === "") {
    addError(context.errors, path, "Expected non-empty string.");
  }
}

function validateOptionalString(
  value: JsonRecord,
  key: string,
  path: Path,
  context: ValidationContext,
): void {
  const property = readProperty(value, key, path, context);

  if (!property.present) {
    return;
  }

  if (typeof property.value !== "string") {
    addError(context.errors, path, "Expected string.");
  }
}

function validateRequiredBoolean(
  value: JsonRecord,
  key: string,
  path: Path,
  context: ValidationContext,
): void {
  const property = readProperty(value, key, path, context);

  if (!property.present) {
    addError(context.errors, path, "Required field is missing.");
    return;
  }

  if (typeof property.value !== "boolean") {
    addError(context.errors, path, "Expected boolean.");
  }
}

function validateOptionalBoolean(
  value: JsonRecord,
  key: string,
  path: Path,
  context: ValidationContext,
): void {
  const property = readProperty(value, key, path, context);

  if (!property.present) {
    return;
  }

  if (typeof property.value !== "boolean") {
    addError(context.errors, path, "Expected boolean.");
  }
}

function validateRequiredStringEnum(
  value: JsonRecord,
  key: string,
  allowed: ReadonlySet<string>,
  path: Path,
  context: ValidationContext,
): void {
  const property = readProperty(value, key, path, context);

  if (!property.present) {
    addError(context.errors, path, "Required field is missing.");
    return;
  }

  if (!isStringInSet(property.value, allowed)) {
    addError(context.errors, path, `Expected one of: ${[...allowed].join(", ")}.`);
  }
}

function validateRequiredStringEnumArray(
  value: JsonRecord,
  key: string,
  allowed: ReadonlySet<string>,
  path: Path,
  context: ValidationContext,
): void {
  validateRequiredArray(value, key, path, context, (item, itemPath, itemContext) => {
    if (!isStringInSet(item, allowed)) {
      addError(itemContext.errors, itemPath, `Expected one of: ${[...allowed].join(", ")}.`);
    }
  });
}

function validateRequiredStringArray(
  value: JsonRecord,
  key: string,
  path: Path,
  context: ValidationContext,
): void {
  validateRequiredArray(value, key, path, context, (item, itemPath, itemContext) => {
    if (typeof item !== "string" || item === "") {
      addError(itemContext.errors, itemPath, "Expected non-empty string.");
    }
  });
}

function validateRequiredPositiveNumber(
  value: JsonRecord,
  key: string,
  path: Path,
  context: ValidationContext,
): void {
  const property = readProperty(value, key, path, context);

  if (!property.present) {
    addError(context.errors, path, "Required field is missing.");
    return;
  }

  if (typeof property.value !== "number" || !Number.isFinite(property.value) || property.value <= 0) {
    addError(context.errors, path, "Expected positive finite number.");
  }
}

function validateRequiredPositiveInteger(
  value: JsonRecord,
  key: string,
  path: Path,
  context: ValidationContext,
): void {
  const property = readProperty(value, key, path, context);

  if (!property.present) {
    addError(context.errors, path, "Required field is missing.");
    return;
  }

  if (
    typeof property.value !== "number" ||
    !Number.isFinite(property.value) ||
    !Number.isInteger(property.value) ||
    property.value <= 0
  ) {
    addError(context.errors, path, "Expected positive integer.");
  }
}

function validateRequiredNonNegativeInteger(
  value: JsonRecord,
  key: string,
  path: Path,
  context: ValidationContext,
): void {
  const property = readProperty(value, key, path, context);

  if (!property.present) {
    addError(context.errors, path, "Required field is missing.");
    return;
  }

  if (
    typeof property.value !== "number" ||
    !Number.isFinite(property.value) ||
    !Number.isInteger(property.value) ||
    property.value < 0
  ) {
    addError(context.errors, path, "Expected non-negative integer.");
  }
}

function validateRequiredPort(
  value: JsonRecord,
  key: string,
  path: Path,
  context: ValidationContext,
): void {
  const property = readProperty(value, key, path, context);

  if (!property.present) {
    addError(context.errors, path, "Required field is missing.");
    return;
  }

  if (!isPort(property.value)) {
    addError(context.errors, path, "Expected TCP/UDP port 1-65535.");
  }
}

function validateRequiredPortArray(
  value: JsonRecord,
  key: string,
  path: Path,
  context: ValidationContext,
): void {
  validateRequiredArray(value, key, path, context, (item, itemPath, itemContext) => {
    if (!isPort(item)) {
      addError(itemContext.errors, itemPath, "Expected TCP/UDP port 1-65535.");
    }
  });
}

function validateRequiredDate(
  value: JsonRecord,
  key: string,
  path: Path,
  context: ValidationContext,
): void {
  const property = readProperty(value, key, path, context);

  if (!property.present) {
    addError(context.errors, path, "Required field is missing.");
    return;
  }

  if (typeof property.value !== "string" || !isDateOnly(property.value)) {
    addError(context.errors, path, "Expected ISO date in YYYY-MM-DD format.");
  }
}

function validateRequiredDateTime(
  value: JsonRecord,
  key: string,
  path: Path,
  context: ValidationContext,
): void {
  const property = readProperty(value, key, path, context);

  if (!property.present) {
    addError(context.errors, path, "Required field is missing.");
    return;
  }

  if (typeof property.value !== "string" || !Number.isFinite(Date.parse(property.value))) {
    addError(context.errors, path, "Expected ISO timestamp string.");
  }
}

function validateOptionalDateTime(
  value: JsonRecord,
  key: string,
  path: Path,
  context: ValidationContext,
): void {
  const property = readProperty(value, key, path, context);

  if (!property.present) {
    return;
  }

  if (typeof property.value !== "string" || !Number.isFinite(Date.parse(property.value))) {
    addError(context.errors, path, "Expected ISO timestamp string.");
  }
}

function rejectUnknownFields(
  value: JsonRecord,
  allowed: ReadonlySet<string>,
  path: Path,
  context: ValidationContext,
): void {
  for (const key of safeKeys(value, path, context).sort(compareStrings)) {
    if (!allowed.has(key)) {
      addError(context.errors, [...path, key], "Unknown field.");
    }
  }
}

function rejectInlineSecretFields(
  value: JsonRecord,
  path: Path,
  context: ValidationContext,
): void {
  for (const key of safeKeys(value, path, context).sort(compareStrings)) {
    if (INLINE_SECRET_FIELDS.has(key)) {
      addError(context.errors, [...path, key], "Secret material must be referenced, not embedded.");
    }
  }
}

function enterObject(
  value: JsonRecord,
  path: Path,
  context: ValidationContext,
): boolean {
  return enterContainer(value, path, context);
}

function enterArray(value: readonly unknown[], path: Path, context: ValidationContext): boolean {
  return enterContainer(value, path, context);
}

function enterContainer(value: object, path: Path, context: ValidationContext): boolean {
  if (path.length > MAX_PATH_DEPTH) {
    addError(context.errors, path, "Maximum validation depth exceeded.");
    return false;
  }

  if (context.seen.has(value)) {
    addError(context.errors, path, "Cyclic object is not allowed.");
    return false;
  }

  context.seen.add(value);
  return true;
}

function readProperty(
  value: JsonRecord,
  key: string,
  path: Path,
  context: ValidationContext,
): { readonly present: true; readonly value: unknown } | { readonly present: false } {
  try {
    if (!Object.prototype.hasOwnProperty.call(value, key)) {
      return { present: false };
    }

    const propertyValue = value[key];

    if (propertyValue === undefined) {
      return { present: false };
    }

    return {
      present: true,
      value: propertyValue,
    };
  } catch {
    addError(context.errors, path, "Could not read field.");
    return { present: false };
  }
}

function safeKeys(value: JsonRecord, path: Path, context: ValidationContext): string[] {
  try {
    return Object.keys(value);
  } catch {
    addError(context.errors, path, "Could not inspect object fields.");
    return [];
  }
}

function isRecord(value: unknown): value is JsonRecord {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }

  try {
    const prototype = Object.getPrototypeOf(value);

    return prototype === Object.prototype || prototype === null;
  } catch {
    return false;
  }
}

function isStringInSet(value: unknown, allowed: ReadonlySet<string>): value is string {
  return typeof value === "string" && allowed.has(value);
}

function isPort(value: unknown): boolean {
  return Number.isInteger(value) && typeof value === "number" && value >= 1 && value <= 65535;
}

function isDateOnly(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return false;
  }

  const parsed = Date.parse(`${value}T00:00:00.000Z`);

  return Number.isFinite(parsed) && new Date(parsed).toISOString().startsWith(value);
}

function unionFields(
  left: ReadonlySet<string>,
  right: ReadonlySet<string>,
): ReadonlySet<string> {
  return new Set([...left, ...right]);
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
