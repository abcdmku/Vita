import { validatePackageContract } from "../../../sdk/manifests/src/package-contract.ts";
import type {
  DataClass,
  ExportFormat,
  ImmutableDigest,
  NetworkProtocol,
  PackageContract,
} from "../../../sdk/manifests/src/package-contract.ts";

export interface CapsuleValidationError {
  readonly path: string;
  readonly message: string;
}

export type CapsuleValidationResult =
  | {
      readonly ok: true;
      readonly capsule: Capsule;
    }
  | {
      readonly ok: false;
      readonly errors: readonly CapsuleValidationError[];
    };

export interface Capsule {
  readonly manifest: CapsuleManifest;
  readonly runtime: CapsuleRuntime;
  readonly state: CapsuleState;
  readonly policy: CapsulePolicy;
  readonly simulation: CapsuleSimulation;
}

export interface CapsuleManifest {
  readonly package: PackageContract;
  readonly versions: CapsuleVersions;
  readonly signatures: readonly SignatureReference[];
  readonly sbom: CapsuleSbomDescriptor;
}

export interface CapsuleVersions {
  readonly capsule: string;
  readonly package: string;
  readonly runtime: string;
  readonly state: string;
  readonly policy: string;
  readonly simulation: string;
}

export type SignatureReference = string | SignatureReferenceDescriptor;

export interface SignatureReferenceDescriptor {
  readonly ref: string;
  readonly keyRef?: string;
  readonly algorithm?: string;
  readonly digest?: ImmutableDigest;
  readonly signedAt?: string;
}

export interface CapsuleSbomDescriptor {
  readonly format: "spdx-json" | "cyclonedx-json";
  readonly ref: string;
  readonly digest: ImmutableDigest;
  readonly generatedAt: string;
}

export interface CapsuleRuntime {
  readonly ociImageIndexes: readonly OciImageIndexDescriptor[];
  readonly wasmComponents: readonly WasmComponentDescriptor[];
  readonly typescript: TypeScriptRuntimeArtifacts;
}

export interface OciImageIndexDescriptor {
  readonly ref: string;
  readonly name?: string;
  readonly digest?: ImmutableDigest;
  readonly mediaType?: string;
  readonly platforms?: readonly RuntimePlatform[];
}

export interface RuntimePlatform {
  readonly os: string;
  readonly architecture: "x86_64" | "arm64";
  readonly variant?: string;
}

export interface WasmComponentDescriptor {
  readonly ref: string;
  readonly name?: string;
  readonly digest?: ImmutableDigest;
  readonly mediaType?: string;
  readonly componentId?: string;
}

export type TypeScriptRuntimeArtifacts =
  | {
      readonly source: TypeScriptArtifactDescriptor;
      readonly compiled?: TypeScriptArtifactDescriptor;
    }
  | {
      readonly source?: undefined;
      readonly compiled: TypeScriptArtifactDescriptor;
    };

export interface TypeScriptArtifactDescriptor {
  readonly ref: string;
  readonly digest?: ImmutableDigest;
  readonly mediaType?: string;
  readonly entrypoint?: string;
}

export interface CapsuleState {
  readonly snapshot: StateSnapshotDescriptor;
  readonly exports: readonly StateExportDescriptor[];
  readonly migrationMetadata: StateMigrationMetadata;
}

export interface StateSnapshotDescriptor {
  readonly ref: string;
  readonly architectureNeutral: boolean;
  readonly consistency: "application-consistent";
  readonly digest?: ImmutableDigest;
  readonly createdAt?: string;
}

export interface StateExportDescriptor {
  readonly name: string;
  readonly format: ExportFormat;
  readonly ref: string;
  readonly digest?: ImmutableDigest;
  readonly dataClass?: DataClass;
  readonly rebuildable?: boolean;
}

export interface StateMigrationMetadata {
  readonly currentVersion: string;
  readonly minimumSupportedVersion: string;
  readonly migrations: readonly StateMigrationDescriptor[];
}

export interface StateMigrationDescriptor {
  readonly id: string;
  readonly fromVersion: string;
  readonly toVersion: string;
  readonly reversible: boolean;
  readonly hookRef?: string;
}

export interface CapsulePolicy {
  readonly dataGrants: readonly CapsuleDataGrant[];
  readonly networkGrants: readonly CapsuleNetworkGrant[];
  readonly resourceLimits: CapsuleResourceLimits;
  readonly identityBindings: readonly IdentityBinding[];
}

export interface CapsuleDataGrant {
  readonly class: DataClass;
  readonly access: "read-only" | "read-write";
  readonly scope: string;
  readonly name?: string;
}

export interface CapsuleNetworkGrant {
  readonly direction: "ingress" | "egress";
  readonly protocol: NetworkProtocol;
  readonly ports: readonly number[];
  readonly name?: string;
  readonly destination?: string;
  readonly public?: boolean;
}

export interface CapsuleResourceLimits {
  readonly cpuCores: number;
  readonly ramMiB: number;
  readonly storageMiB: number;
}

export interface IdentityBinding {
  readonly name: string;
  readonly identityRef: string;
  readonly role: string;
}

export interface CapsuleSimulation {
  readonly requiredProfiles: readonly string[];
  readonly expectedHealthChecks: readonly CapsuleHealthCheckExpectation[];
  readonly failureTests: readonly FailureTestDescriptor[];
}

export interface CapsuleHealthCheckExpectation {
  readonly name: string;
  readonly type: "http" | "tcp" | "lifecycle";
  readonly target: string;
  readonly intervalSeconds?: number;
  readonly timeoutSeconds?: number;
}

export interface FailureTestDescriptor {
  readonly name: string;
  readonly profile: string;
  readonly fault: string;
  readonly expectedHealth: string;
  readonly timeoutSeconds?: number;
}

type Plain = null | boolean | number | string | Plain[] | { [key: string]: Plain };
type PlainObject = { [key: string]: Plain };
type Path = readonly string[];

interface NormalizationContext {
  readonly errors: CapsuleValidationError[];
  readonly seen: WeakSet<object>;
}

type ReadResult = { readonly ok: true; readonly value: unknown } | { readonly ok: false };

const MAX_DEPTH = 64;
const MAX_ITEMS = 10_000;
const MAX_REFERENCE_LENGTH = 2_048;

const TOP_LEVEL_FIELDS = new Set(["manifest", "runtime", "state", "policy", "simulation"]);
const MANIFEST_FIELDS = new Set(["package", "versions", "signatures", "sbom"]);
const VERSION_FIELDS = new Set(["capsule", "package", "runtime", "state", "policy", "simulation"]);
const SIGNATURE_FIELDS = new Set(["ref", "keyRef", "algorithm", "digest", "signedAt"]);
const SBOM_FIELDS = new Set(["format", "ref", "digest", "generatedAt"]);
const RUNTIME_FIELDS = new Set(["ociImageIndexes", "wasmComponents", "typescript"]);
const OCI_IMAGE_INDEX_FIELDS = new Set(["ref", "name", "digest", "mediaType", "platforms"]);
const RUNTIME_PLATFORM_FIELDS = new Set(["os", "architecture", "variant"]);
const WASM_COMPONENT_FIELDS = new Set(["ref", "name", "digest", "mediaType", "componentId"]);
const TYPESCRIPT_FIELDS = new Set(["source", "compiled"]);
const TYPESCRIPT_ARTIFACT_FIELDS = new Set(["ref", "digest", "mediaType", "entrypoint"]);
const STATE_FIELDS = new Set(["snapshot", "exports", "migrationMetadata"]);
const SNAPSHOT_FIELDS = new Set([
  "ref",
  "architectureNeutral",
  "consistency",
  "digest",
  "createdAt",
]);
const STATE_EXPORT_FIELDS = new Set(["name", "format", "ref", "digest", "dataClass", "rebuildable"]);
const MIGRATION_METADATA_FIELDS = new Set([
  "currentVersion",
  "minimumSupportedVersion",
  "migrations",
]);
const MIGRATION_FIELDS = new Set(["id", "fromVersion", "toVersion", "reversible", "hookRef"]);
const POLICY_FIELDS = new Set([
  "dataGrants",
  "networkGrants",
  "resourceLimits",
  "identityBindings",
]);
const DATA_GRANT_FIELDS = new Set(["class", "access", "scope", "name"]);
const NETWORK_GRANT_FIELDS = new Set([
  "direction",
  "protocol",
  "ports",
  "name",
  "destination",
  "public",
]);
const RESOURCE_LIMIT_FIELDS = new Set(["cpuCores", "ramMiB", "storageMiB"]);
const IDENTITY_BINDING_FIELDS = new Set(["name", "identityRef", "role"]);
const SIMULATION_FIELDS = new Set(["requiredProfiles", "expectedHealthChecks", "failureTests"]);
const HEALTH_CHECK_FIELDS = new Set([
  "name",
  "type",
  "target",
  "intervalSeconds",
  "timeoutSeconds",
]);
const FAILURE_TEST_FIELDS = new Set([
  "name",
  "profile",
  "fault",
  "expectedHealth",
  "timeoutSeconds",
]);
const DIGEST_FIELDS = new Set(["algorithm", "value"]);

const DIGEST_ALGORITHMS = new Set(["sha256", "sha384", "sha512"]);
const SBOM_FORMATS = new Set(["spdx-json", "cyclonedx-json"]);
const ARCHITECTURES = new Set(["x86_64", "arm64"]);
const DATA_CLASSES = new Set([
  "user-content",
  "app-state",
  "cache",
  "logs",
  "telemetry",
  "configuration",
]);
const DATA_ACCESS_MODES = new Set(["read-only", "read-write"]);
const NETWORK_DIRECTIONS = new Set(["ingress", "egress"]);
const NETWORK_PROTOCOLS = new Set(["http", "https", "tcp", "udp", "ws", "wss"]);
const EXPORT_FORMATS = new Set(["vita-capsule", "oci-image", "tar.zst", "json", "sqlite-dump"]);
const HEALTH_CHECK_TYPES = new Set(["http", "tcp", "lifecycle"]);
const INLINE_REFERENCE_SCHEMES = new Set(["data", "inline", "literal"]);
const SHADOWABLE_ARRAY_METHODS = new Set(["some", "includes", "find", "forEach"]);

export function validateCapsule(value: unknown): CapsuleValidationResult {
  const errors: CapsuleValidationError[] = [];

  try {
    const normalized = normalizePlain(value, [], {
      errors,
      seen: new WeakSet<object>(),
    });

    if (errors.length > 0) {
      return { ok: false, errors };
    }

    if (!record(normalized)) {
      addError(errors, [], "Expected capsule object.");
      return { ok: false, errors };
    }

    validateCapsuleShape(normalized, [], errors);

    if (errors.length > 0) {
      return { ok: false, errors };
    }

    return {
      ok: true,
      capsule: normalized as Capsule,
    };
  } catch {
    return {
      ok: false,
      errors: [
        {
          path: "",
          message: "Capsule validation failed closed.",
        },
      ],
    };
  }
}

function validateCapsuleShape(value: PlainObject, path: Path, errors: CapsuleValidationError[]): void {
  rejectUnknownFields(value, TOP_LEVEL_FIELDS, path, errors);
  validateRequiredObject(value, "manifest", [...path, "manifest"], errors, validateManifest);
  validateRequiredObject(value, "runtime", [...path, "runtime"], errors, validateRuntime);
  validateRequiredObject(value, "state", [...path, "state"], errors, validateState);
  validateRequiredObject(value, "policy", [...path, "policy"], errors, validatePolicy);
  validateRequiredObject(value, "simulation", [...path, "simulation"], errors, validateSimulation);
}

function validateManifest(value: PlainObject, path: Path, errors: CapsuleValidationError[]): void {
  rejectUnknownFields(value, MANIFEST_FIELDS, path, errors);
  validatePackage(value, "package", [...path, "package"], errors);
  validateRequiredObject(value, "versions", [...path, "versions"], errors, validateVersions);
  validateRequiredNonEmptyArray(value, "signatures", [...path, "signatures"], errors, validateSignature);
  validateRequiredObject(value, "sbom", [...path, "sbom"], errors, validateSbom);
}

function validatePackage(
  value: PlainObject,
  key: string,
  path: Path,
  errors: CapsuleValidationError[],
): void {
  if (!hasOwn(value, key)) {
    addError(errors, path, "Required field is missing.");
    return;
  }

  const child = value[key];

  if (!record(child)) {
    addError(errors, path, "Expected object.");
    return;
  }

  const result = validatePackageContract(child);

  if (!result.ok) {
    for (let index = 0; index < result.errors.length; index += 1) {
      const error = result.errors[index];
      if (error !== undefined) {
        errors[errors.length] = {
          path: error.path === "" ? formatPath(path) : `${formatPath(path)}/${error.path}`,
          message: error.message,
        };
      }
    }
    return;
  }

  validatePackageReferenceFields(result.contract, path, errors);
}

function validatePackageReferenceFields(
  contract: PackageContract,
  path: Path,
  errors: CapsuleValidationError[],
): void {
  validateReferenceValue(
    contract.signingPublisher.signingKeyRef,
    [...path, "signingPublisher", "signingKeyRef"],
    errors,
  );

  for (let index = 0; index < contract.secrets.length; index += 1) {
    const secret = contract.secrets[index];
    if (secret !== undefined) {
      validateReferenceValue(secret.ref, [...path, "secrets", String(index), "ref"], errors);
    }
  }
}

function validateVersions(value: PlainObject, path: Path, errors: CapsuleValidationError[]): void {
  rejectUnknownFields(value, VERSION_FIELDS, path, errors);
  validateRequiredString(value, "capsule", [...path, "capsule"], errors);
  validateRequiredString(value, "package", [...path, "package"], errors);
  validateRequiredString(value, "runtime", [...path, "runtime"], errors);
  validateRequiredString(value, "state", [...path, "state"], errors);
  validateRequiredString(value, "policy", [...path, "policy"], errors);
  validateRequiredString(value, "simulation", [...path, "simulation"], errors);
}

function validateSignature(value: Plain | undefined, path: Path, errors: CapsuleValidationError[]): void {
  if (typeof value === "string") {
    validateReferenceValue(value, path, errors);
    return;
  }

  if (!record(value)) {
    addError(errors, path, "Expected signature reference object.");
    return;
  }

  rejectUnknownFields(value, SIGNATURE_FIELDS, path, errors);
  validateRequiredReference(value, "ref", [...path, "ref"], errors);
  validateOptionalReference(value, "keyRef", [...path, "keyRef"], errors);
  validateOptionalString(value, "algorithm", [...path, "algorithm"], errors);
  validateOptionalObject(value, "digest", [...path, "digest"], errors, validateDigest);
  validateOptionalDateTime(value, "signedAt", [...path, "signedAt"], errors);
}

function validateSbom(value: PlainObject, path: Path, errors: CapsuleValidationError[]): void {
  rejectUnknownFields(value, SBOM_FIELDS, path, errors);
  validateRequiredStringEnum(value, "format", SBOM_FORMATS, [...path, "format"], errors);
  validateRequiredReference(value, "ref", [...path, "ref"], errors);
  validateRequiredObject(value, "digest", [...path, "digest"], errors, validateDigest);
  validateRequiredDateTime(value, "generatedAt", [...path, "generatedAt"], errors);
}

function validateRuntime(value: PlainObject, path: Path, errors: CapsuleValidationError[]): void {
  rejectUnknownFields(value, RUNTIME_FIELDS, path, errors);
  validateRequiredArray(
    value,
    "ociImageIndexes",
    [...path, "ociImageIndexes"],
    errors,
    validateOciImageIndex,
  );
  validateRequiredArray(
    value,
    "wasmComponents",
    [...path, "wasmComponents"],
    errors,
    validateWasmComponent,
  );
  validateRequiredObject(value, "typescript", [...path, "typescript"], errors, validateTypescript);
}

function validateOciImageIndex(
  value: Plain | undefined,
  path: Path,
  errors: CapsuleValidationError[],
): void {
  if (!record(value)) {
    addError(errors, path, "Expected OCI image index descriptor object.");
    return;
  }

  rejectUnknownFields(value, OCI_IMAGE_INDEX_FIELDS, path, errors);
  validateRequiredReference(value, "ref", [...path, "ref"], errors);
  validateOptionalString(value, "name", [...path, "name"], errors);
  validateOptionalObject(value, "digest", [...path, "digest"], errors, validateDigest);
  validateOptionalString(value, "mediaType", [...path, "mediaType"], errors);
  validateOptionalArray(value, "platforms", [...path, "platforms"], errors, validateRuntimePlatform);
}

function validateRuntimePlatform(
  value: Plain | undefined,
  path: Path,
  errors: CapsuleValidationError[],
): void {
  if (!record(value)) {
    addError(errors, path, "Expected runtime platform object.");
    return;
  }

  rejectUnknownFields(value, RUNTIME_PLATFORM_FIELDS, path, errors);
  validateRequiredString(value, "os", [...path, "os"], errors);
  validateRequiredStringEnum(value, "architecture", ARCHITECTURES, [...path, "architecture"], errors);
  validateOptionalString(value, "variant", [...path, "variant"], errors);
}

function validateWasmComponent(
  value: Plain | undefined,
  path: Path,
  errors: CapsuleValidationError[],
): void {
  if (!record(value)) {
    addError(errors, path, "Expected WASM component descriptor object.");
    return;
  }

  rejectUnknownFields(value, WASM_COMPONENT_FIELDS, path, errors);
  validateRequiredReference(value, "ref", [...path, "ref"], errors);
  validateOptionalString(value, "name", [...path, "name"], errors);
  validateOptionalObject(value, "digest", [...path, "digest"], errors, validateDigest);
  validateOptionalString(value, "mediaType", [...path, "mediaType"], errors);
  validateOptionalString(value, "componentId", [...path, "componentId"], errors);
}

function validateTypescript(value: PlainObject, path: Path, errors: CapsuleValidationError[]): void {
  rejectUnknownFields(value, TYPESCRIPT_FIELDS, path, errors);

  const hasSource = hasOwn(value, "source");
  const hasCompiled = hasOwn(value, "compiled");

  if (!hasSource && !hasCompiled) {
    addError(errors, path, "Expected at least one of source or compiled.");
    return;
  }

  validateOptionalObject(value, "source", [...path, "source"], errors, validateTypescriptArtifact);
  validateOptionalObject(value, "compiled", [...path, "compiled"], errors, validateTypescriptArtifact);
}

function validateTypescriptArtifact(
  value: PlainObject,
  path: Path,
  errors: CapsuleValidationError[],
): void {
  rejectUnknownFields(value, TYPESCRIPT_ARTIFACT_FIELDS, path, errors);
  validateRequiredReference(value, "ref", [...path, "ref"], errors);
  validateOptionalObject(value, "digest", [...path, "digest"], errors, validateDigest);
  validateOptionalString(value, "mediaType", [...path, "mediaType"], errors);
  validateOptionalString(value, "entrypoint", [...path, "entrypoint"], errors);
}

function validateState(value: PlainObject, path: Path, errors: CapsuleValidationError[]): void {
  rejectUnknownFields(value, STATE_FIELDS, path, errors);
  validateRequiredObject(value, "snapshot", [...path, "snapshot"], errors, validateSnapshot);
  validateRequiredArray(value, "exports", [...path, "exports"], errors, validateStateExport);
  validateRequiredObject(
    value,
    "migrationMetadata",
    [...path, "migrationMetadata"],
    errors,
    validateMigrationMetadata,
  );
}

function validateSnapshot(value: PlainObject, path: Path, errors: CapsuleValidationError[]): void {
  rejectUnknownFields(value, SNAPSHOT_FIELDS, path, errors);
  validateRequiredReference(value, "ref", [...path, "ref"], errors);
  validateRequiredBoolean(value, "architectureNeutral", [...path, "architectureNeutral"], errors);
  validateRequiredLiteral(
    value,
    "consistency",
    "application-consistent",
    [...path, "consistency"],
    errors,
  );
  validateOptionalObject(value, "digest", [...path, "digest"], errors, validateDigest);
  validateOptionalDateTime(value, "createdAt", [...path, "createdAt"], errors);
}

function validateStateExport(
  value: Plain | undefined,
  path: Path,
  errors: CapsuleValidationError[],
): void {
  if (!record(value)) {
    addError(errors, path, "Expected state export descriptor object.");
    return;
  }

  rejectUnknownFields(value, STATE_EXPORT_FIELDS, path, errors);
  validateRequiredString(value, "name", [...path, "name"], errors);
  validateRequiredStringEnum(value, "format", EXPORT_FORMATS, [...path, "format"], errors);
  validateRequiredReference(value, "ref", [...path, "ref"], errors);
  validateOptionalObject(value, "digest", [...path, "digest"], errors, validateDigest);
  validateOptionalStringEnum(value, "dataClass", DATA_CLASSES, [...path, "dataClass"], errors);
  validateOptionalBoolean(value, "rebuildable", [...path, "rebuildable"], errors);
}

function validateMigrationMetadata(
  value: PlainObject,
  path: Path,
  errors: CapsuleValidationError[],
): void {
  rejectUnknownFields(value, MIGRATION_METADATA_FIELDS, path, errors);
  validateRequiredString(value, "currentVersion", [...path, "currentVersion"], errors);
  validateRequiredString(
    value,
    "minimumSupportedVersion",
    [...path, "minimumSupportedVersion"],
    errors,
  );
  validateRequiredArray(value, "migrations", [...path, "migrations"], errors, validateMigration);
}

function validateMigration(
  value: Plain | undefined,
  path: Path,
  errors: CapsuleValidationError[],
): void {
  if (!record(value)) {
    addError(errors, path, "Expected state migration descriptor object.");
    return;
  }

  rejectUnknownFields(value, MIGRATION_FIELDS, path, errors);
  validateRequiredString(value, "id", [...path, "id"], errors);
  validateRequiredString(value, "fromVersion", [...path, "fromVersion"], errors);
  validateRequiredString(value, "toVersion", [...path, "toVersion"], errors);
  validateRequiredBoolean(value, "reversible", [...path, "reversible"], errors);
  validateOptionalReference(value, "hookRef", [...path, "hookRef"], errors);
}

function validatePolicy(value: PlainObject, path: Path, errors: CapsuleValidationError[]): void {
  rejectUnknownFields(value, POLICY_FIELDS, path, errors);
  validateRequiredArray(value, "dataGrants", [...path, "dataGrants"], errors, validateDataGrant);
  validateRequiredArray(
    value,
    "networkGrants",
    [...path, "networkGrants"],
    errors,
    validateNetworkGrant,
  );
  validateRequiredObject(
    value,
    "resourceLimits",
    [...path, "resourceLimits"],
    errors,
    validateResourceLimits,
  );
  validateRequiredArray(
    value,
    "identityBindings",
    [...path, "identityBindings"],
    errors,
    validateIdentityBinding,
  );
}

function validateDataGrant(
  value: Plain | undefined,
  path: Path,
  errors: CapsuleValidationError[],
): void {
  if (!record(value)) {
    addError(errors, path, "Expected data grant object.");
    return;
  }

  rejectUnknownFields(value, DATA_GRANT_FIELDS, path, errors);
  validateRequiredStringEnum(value, "class", DATA_CLASSES, [...path, "class"], errors);
  validateRequiredStringEnum(value, "access", DATA_ACCESS_MODES, [...path, "access"], errors);
  validateRequiredString(value, "scope", [...path, "scope"], errors);
  validateOptionalString(value, "name", [...path, "name"], errors);
}

function validateNetworkGrant(
  value: Plain | undefined,
  path: Path,
  errors: CapsuleValidationError[],
): void {
  if (!record(value)) {
    addError(errors, path, "Expected network grant object.");
    return;
  }

  rejectUnknownFields(value, NETWORK_GRANT_FIELDS, path, errors);
  validateRequiredStringEnum(value, "direction", NETWORK_DIRECTIONS, [...path, "direction"], errors);
  validateRequiredStringEnum(value, "protocol", NETWORK_PROTOCOLS, [...path, "protocol"], errors);
  validateRequiredPortArray(value, "ports", [...path, "ports"], errors);
  validateOptionalString(value, "name", [...path, "name"], errors);
  validateOptionalString(value, "destination", [...path, "destination"], errors);
  validateOptionalBoolean(value, "public", [...path, "public"], errors);

  if (value.direction === "ingress" && !hasOwn(value, "public")) {
    addError(errors, [...path, "public"], "Required field is missing for ingress grants.");
  }

  if (value.direction === "egress" && !hasOwn(value, "destination")) {
    addError(errors, [...path, "destination"], "Required field is missing for egress grants.");
  }
}

function validateResourceLimits(
  value: PlainObject,
  path: Path,
  errors: CapsuleValidationError[],
): void {
  rejectUnknownFields(value, RESOURCE_LIMIT_FIELDS, path, errors);
  validateRequiredPositiveNumber(value, "cpuCores", [...path, "cpuCores"], errors);
  validateRequiredPositiveInteger(value, "ramMiB", [...path, "ramMiB"], errors);
  validateRequiredPositiveInteger(value, "storageMiB", [...path, "storageMiB"], errors);
}

function validateIdentityBinding(
  value: Plain | undefined,
  path: Path,
  errors: CapsuleValidationError[],
): void {
  if (!record(value)) {
    addError(errors, path, "Expected identity binding object.");
    return;
  }

  rejectUnknownFields(value, IDENTITY_BINDING_FIELDS, path, errors);
  validateRequiredString(value, "name", [...path, "name"], errors);
  validateRequiredReference(value, "identityRef", [...path, "identityRef"], errors);
  validateRequiredString(value, "role", [...path, "role"], errors);
}

function validateSimulation(value: PlainObject, path: Path, errors: CapsuleValidationError[]): void {
  rejectUnknownFields(value, SIMULATION_FIELDS, path, errors);
  validateRequiredStringArray(value, "requiredProfiles", [...path, "requiredProfiles"], errors);
  validateRequiredArray(
    value,
    "expectedHealthChecks",
    [...path, "expectedHealthChecks"],
    errors,
    validateHealthCheck,
  );
  validateRequiredArray(value, "failureTests", [...path, "failureTests"], errors, validateFailureTest);
}

function validateHealthCheck(
  value: Plain | undefined,
  path: Path,
  errors: CapsuleValidationError[],
): void {
  if (!record(value)) {
    addError(errors, path, "Expected health check expectation object.");
    return;
  }

  rejectUnknownFields(value, HEALTH_CHECK_FIELDS, path, errors);
  validateRequiredString(value, "name", [...path, "name"], errors);
  validateRequiredStringEnum(value, "type", HEALTH_CHECK_TYPES, [...path, "type"], errors);
  validateRequiredString(value, "target", [...path, "target"], errors);
  validateOptionalPositiveInteger(value, "intervalSeconds", [...path, "intervalSeconds"], errors);
  validateOptionalPositiveInteger(value, "timeoutSeconds", [...path, "timeoutSeconds"], errors);
}

function validateFailureTest(
  value: Plain | undefined,
  path: Path,
  errors: CapsuleValidationError[],
): void {
  if (!record(value)) {
    addError(errors, path, "Expected failure test descriptor object.");
    return;
  }

  rejectUnknownFields(value, FAILURE_TEST_FIELDS, path, errors);
  validateRequiredString(value, "name", [...path, "name"], errors);
  validateRequiredString(value, "profile", [...path, "profile"], errors);
  validateRequiredString(value, "fault", [...path, "fault"], errors);
  validateRequiredString(value, "expectedHealth", [...path, "expectedHealth"], errors);
  validateOptionalPositiveInteger(value, "timeoutSeconds", [...path, "timeoutSeconds"], errors);
}

function validateDigest(value: PlainObject, path: Path, errors: CapsuleValidationError[]): void {
  rejectUnknownFields(value, DIGEST_FIELDS, path, errors);
  validateRequiredStringEnum(value, "algorithm", DIGEST_ALGORITHMS, [...path, "algorithm"], errors);
  validateRequiredString(value, "value", [...path, "value"], errors);
}

function validateRequiredObject(
  value: PlainObject,
  key: string,
  path: Path,
  errors: CapsuleValidationError[],
  validate: (objectValue: PlainObject, objectPath: Path, objectErrors: CapsuleValidationError[]) => void,
): void {
  if (!hasOwn(value, key)) {
    addError(errors, path, "Required field is missing.");
    return;
  }

  const child = value[key];

  if (!record(child)) {
    addError(errors, path, "Expected object.");
    return;
  }

  validate(child, path, errors);
}

function validateOptionalObject(
  value: PlainObject,
  key: string,
  path: Path,
  errors: CapsuleValidationError[],
  validate: (objectValue: PlainObject, objectPath: Path, objectErrors: CapsuleValidationError[]) => void,
): void {
  if (!hasOwn(value, key)) {
    return;
  }

  const child = value[key];

  if (!record(child)) {
    addError(errors, path, "Expected object.");
    return;
  }

  validate(child, path, errors);
}

function validateRequiredArray(
  value: PlainObject,
  key: string,
  path: Path,
  errors: CapsuleValidationError[],
  validate: (item: Plain | undefined, itemPath: Path, itemErrors: CapsuleValidationError[]) => void,
): void {
  if (!hasOwn(value, key)) {
    addError(errors, path, "Required field is missing.");
    return;
  }

  const child = value[key];

  if (!Array.isArray(child)) {
    addError(errors, path, "Expected array.");
    return;
  }

  for (let index = 0; index < child.length; index += 1) {
    validate(child[index], [...path, String(index)], errors);
  }
}

function validateRequiredNonEmptyArray(
  value: PlainObject,
  key: string,
  path: Path,
  errors: CapsuleValidationError[],
  validate: (item: Plain | undefined, itemPath: Path, itemErrors: CapsuleValidationError[]) => void,
): void {
  if (!hasOwn(value, key)) {
    addError(errors, path, "Required field is missing.");
    return;
  }

  const child = value[key];

  if (!Array.isArray(child)) {
    addError(errors, path, "Expected array.");
    return;
  }

  if (child.length === 0) {
    addError(errors, path, "Expected at least one entry.");
    return;
  }

  for (let index = 0; index < child.length; index += 1) {
    validate(child[index], [...path, String(index)], errors);
  }
}

function validateOptionalArray(
  value: PlainObject,
  key: string,
  path: Path,
  errors: CapsuleValidationError[],
  validate: (item: Plain | undefined, itemPath: Path, itemErrors: CapsuleValidationError[]) => void,
): void {
  if (!hasOwn(value, key)) {
    return;
  }

  const child = value[key];

  if (!Array.isArray(child)) {
    addError(errors, path, "Expected array.");
    return;
  }

  for (let index = 0; index < child.length; index += 1) {
    validate(child[index], [...path, String(index)], errors);
  }
}

function validateRequiredString(
  value: PlainObject,
  key: string,
  path: Path,
  errors: CapsuleValidationError[],
): void {
  if (!hasOwn(value, key)) {
    addError(errors, path, "Required field is missing.");
    return;
  }

  if (typeof value[key] !== "string" || value[key] === "") {
    addError(errors, path, "Expected non-empty string.");
  }
}

function validateOptionalString(
  value: PlainObject,
  key: string,
  path: Path,
  errors: CapsuleValidationError[],
): void {
  if (!hasOwn(value, key)) {
    return;
  }

  if (typeof value[key] !== "string") {
    addError(errors, path, "Expected string.");
  }
}

function validateRequiredReference(
  value: PlainObject,
  key: string,
  path: Path,
  errors: CapsuleValidationError[],
): void {
  if (!hasOwn(value, key)) {
    addError(errors, path, "Required field is missing.");
    return;
  }

  validateReferenceValue(value[key], path, errors);
}

function validateOptionalReference(
  value: PlainObject,
  key: string,
  path: Path,
  errors: CapsuleValidationError[],
): void {
  if (!hasOwn(value, key)) {
    return;
  }

  validateReferenceValue(value[key], path, errors);
}

function validateReferenceValue(
  value: unknown,
  path: Path,
  errors: CapsuleValidationError[],
): void {
  if (typeof value !== "string" || value === "") {
    addError(errors, path, "Expected non-empty reference string.");
    return;
  }

  if (looksEmbeddedMaterial(value)) {
    addError(errors, path, "Secret or content material must be referenced, not embedded.");
    return;
  }

  if (!isReferenceSyntax(value)) {
    addError(errors, path, "Expected reference URI.");
  }
}

function validateRequiredBoolean(
  value: PlainObject,
  key: string,
  path: Path,
  errors: CapsuleValidationError[],
): void {
  if (!hasOwn(value, key)) {
    addError(errors, path, "Required field is missing.");
    return;
  }

  if (typeof value[key] !== "boolean") {
    addError(errors, path, "Expected boolean.");
  }
}

function validateOptionalBoolean(
  value: PlainObject,
  key: string,
  path: Path,
  errors: CapsuleValidationError[],
): void {
  if (!hasOwn(value, key)) {
    return;
  }

  if (typeof value[key] !== "boolean") {
    addError(errors, path, "Expected boolean.");
  }
}

function validateRequiredStringEnum(
  value: PlainObject,
  key: string,
  allowed: ReadonlySet<string>,
  path: Path,
  errors: CapsuleValidationError[],
): void {
  if (!hasOwn(value, key)) {
    addError(errors, path, "Required field is missing.");
    return;
  }

  if (typeof value[key] !== "string" || !allowed.has(value[key])) {
    addError(errors, path, `Expected one of: ${setValues(allowed)}.`);
  }
}

function validateOptionalStringEnum(
  value: PlainObject,
  key: string,
  allowed: ReadonlySet<string>,
  path: Path,
  errors: CapsuleValidationError[],
): void {
  if (!hasOwn(value, key)) {
    return;
  }

  if (typeof value[key] !== "string" || !allowed.has(value[key])) {
    addError(errors, path, `Expected one of: ${setValues(allowed)}.`);
  }
}

function validateRequiredLiteral(
  value: PlainObject,
  key: string,
  expected: string,
  path: Path,
  errors: CapsuleValidationError[],
): void {
  if (!hasOwn(value, key)) {
    addError(errors, path, "Required field is missing.");
    return;
  }

  if (value[key] !== expected) {
    addError(errors, path, `Expected ${expected}.`);
  }
}

function validateRequiredStringArray(
  value: PlainObject,
  key: string,
  path: Path,
  errors: CapsuleValidationError[],
): void {
  validateRequiredArray(value, key, path, errors, (item, itemPath, itemErrors) => {
    if (typeof item !== "string" || item === "") {
      addError(itemErrors, itemPath, "Expected non-empty string.");
    }
  });
}

function validateRequiredPortArray(
  value: PlainObject,
  key: string,
  path: Path,
  errors: CapsuleValidationError[],
): void {
  validateRequiredArray(value, key, path, errors, (item, itemPath, itemErrors) => {
    if (!isPort(item)) {
      addError(itemErrors, itemPath, "Expected TCP/UDP port 1-65535.");
    }
  });
}

function validateRequiredPositiveNumber(
  value: PlainObject,
  key: string,
  path: Path,
  errors: CapsuleValidationError[],
): void {
  if (!hasOwn(value, key)) {
    addError(errors, path, "Required field is missing.");
    return;
  }

  if (typeof value[key] !== "number" || !Number.isFinite(value[key]) || value[key] <= 0) {
    addError(errors, path, "Expected positive finite number.");
  }
}

function validateRequiredPositiveInteger(
  value: PlainObject,
  key: string,
  path: Path,
  errors: CapsuleValidationError[],
): void {
  if (!hasOwn(value, key)) {
    addError(errors, path, "Required field is missing.");
    return;
  }

  if (!isPositiveInteger(value[key])) {
    addError(errors, path, "Expected positive integer.");
  }
}

function validateOptionalPositiveInteger(
  value: PlainObject,
  key: string,
  path: Path,
  errors: CapsuleValidationError[],
): void {
  if (!hasOwn(value, key)) {
    return;
  }

  if (!isPositiveInteger(value[key])) {
    addError(errors, path, "Expected positive integer.");
  }
}

function validateRequiredDateTime(
  value: PlainObject,
  key: string,
  path: Path,
  errors: CapsuleValidationError[],
): void {
  if (!hasOwn(value, key)) {
    addError(errors, path, "Required field is missing.");
    return;
  }

  if (typeof value[key] !== "string" || !Number.isFinite(Date.parse(value[key]))) {
    addError(errors, path, "Expected ISO timestamp string.");
  }
}

function validateOptionalDateTime(
  value: PlainObject,
  key: string,
  path: Path,
  errors: CapsuleValidationError[],
): void {
  if (!hasOwn(value, key)) {
    return;
  }

  if (typeof value[key] !== "string" || !Number.isFinite(Date.parse(value[key]))) {
    addError(errors, path, "Expected ISO timestamp string.");
  }
}

function rejectUnknownFields(
  value: PlainObject,
  allowed: ReadonlySet<string>,
  path: Path,
  errors: CapsuleValidationError[],
): void {
  const keys = Object.keys(value).sort(compareStrings);

  for (let index = 0; index < keys.length; index += 1) {
    const key = keys[index];
    if (key !== undefined && !allowed.has(key)) {
      addError(errors, [...path, key], "Unknown field.");
    }
  }
}

function normalizePlain(
  value: unknown,
  path: Path,
  context: NormalizationContext,
): Plain | undefined {
  if (path.length > MAX_DEPTH) {
    addError(context.errors, path, "Maximum validation depth exceeded.");
    return undefined;
  }

  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return value;
  }

  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      addError(context.errors, path, "Expected finite number.");
      return undefined;
    }

    return value;
  }

  if (typeof value !== "object") {
    addError(context.errors, path, "Expected JSON-compatible value.");
    return undefined;
  }

  if (context.seen.has(value)) {
    addError(context.errors, path, "Cyclic object is not allowed.");
    return undefined;
  }

  const isArray = Array.isArray(value);
  const prototype = stablePrototype(value);

  if (
    prototype === undefined ||
    (isArray && prototype !== Array.prototype) ||
    (!isArray && prototype !== Object.prototype && prototype !== null)
  ) {
    addError(context.errors, path, "Expected plain object or array.");
    return undefined;
  }

  const keys = stableKeys(value);

  if (keys === undefined) {
    addError(context.errors, path, "Could not safely inspect value.");
    return undefined;
  }

  if (keys.length > MAX_ITEMS + 1) {
    addError(context.errors, path, "Too many fields.");
    return undefined;
  }

  context.seen.add(value);
  try {
    if (isArray) {
      return normalizeArray(value as readonly unknown[], keys, path, context);
    }

    return normalizeObject(value, keys, path, context);
  } finally {
    context.seen.delete(value);
  }
}

function normalizeArray(
  value: readonly unknown[],
  keys: readonly PropertyKey[],
  path: Path,
  context: NormalizationContext,
): Plain[] | undefined {
  const length = stableLength(value);

  if (length === undefined || length > MAX_ITEMS) {
    addError(context.errors, path, "Could not safely inspect array.");
    return undefined;
  }

  for (let index = 0; index < keys.length; index += 1) {
    const key = keys[index];

    if (key === "length") {
      continue;
    }

    if (typeof key !== "string") {
      addError(context.errors, [...path, String(key)], "Symbol properties are not allowed.");
      return undefined;
    }

    if (SHADOWABLE_ARRAY_METHODS.has(key)) {
      addError(context.errors, [...path, key], "Array method shadowing is not allowed.");
      return undefined;
    }

    if (!arrayIndexKey(key)) {
      addError(context.errors, [...path, key], "Array extra properties are not allowed.");
      return undefined;
    }
  }

  const clone: Plain[] = [];

  for (let index = 0; index < length; index += 1) {
    const key = String(index);

    if (stableOwn(value, key) !== true) {
      addError(context.errors, [...path, key], "Sparse arrays are not allowed.");
      return undefined;
    }

    const child = stableData(value, key);

    if (!child.ok) {
      addError(context.errors, [...path, key], "Could not safely read value.");
      return undefined;
    }

    const childClone = normalizePlain(child.value, [...path, key], context);

    if (childClone === undefined) {
      return undefined;
    }

    clone[index] = childClone;
  }

  return clone;
}

function normalizeObject(
  value: object,
  keys: readonly PropertyKey[],
  path: Path,
  context: NormalizationContext,
): PlainObject | undefined {
  if (keys.length > MAX_ITEMS) {
    addError(context.errors, path, "Too many fields.");
    return undefined;
  }

  const clone = Object.create(null) as PlainObject;

  for (let index = 0; index < keys.length; index += 1) {
    const key = keys[index];

    if (typeof key !== "string") {
      addError(context.errors, [...path, String(key)], "Symbol properties are not allowed.");
      return undefined;
    }

    const child = stableData(value, key);

    if (!child.ok) {
      addError(context.errors, [...path, key], "Could not safely read value.");
      return undefined;
    }

    const childClone = normalizePlain(child.value, [...path, key], context);

    if (childClone === undefined) {
      return undefined;
    }

    clone[key] = childClone;
  }

  return clone;
}

function stablePrototype(value: object): object | null | undefined {
  try {
    const first = Object.getPrototypeOf(value);
    const second = Object.getPrototypeOf(value);

    return first === second ? first : undefined;
  } catch {
    return undefined;
  }
}

function stableKeys(value: object): readonly PropertyKey[] | undefined {
  try {
    const first = Reflect.ownKeys(value);
    const second = Reflect.ownKeys(value);

    if (first.length !== second.length) {
      return undefined;
    }

    for (let index = 0; index < first.length; index += 1) {
      if (first[index] !== second[index]) {
        return undefined;
      }
    }

    return first;
  } catch {
    return undefined;
  }
}

function stableLength(value: readonly unknown[]): number | undefined {
  try {
    const first = value.length;
    const second = value.length;

    return Number.isInteger(first) && first >= 0 && first === second ? first : undefined;
  } catch {
    return undefined;
  }
}

function stableOwn(value: object, key: PropertyKey): boolean | undefined {
  try {
    const first = Object.hasOwn(value, key);
    const second = Object.hasOwn(value, key);

    return first === second ? first : undefined;
  } catch {
    return undefined;
  }
}

function stableData(value: object, key: PropertyKey): ReadResult {
  try {
    const first = Object.getOwnPropertyDescriptor(value, key);
    const second = Object.getOwnPropertyDescriptor(value, key);

    if (first === undefined || second === undefined || !("value" in first) || !("value" in second)) {
      return { ok: false };
    }

    const indexed = (value as Record<PropertyKey, unknown>)[key];
    const indexedAgain = (value as Record<PropertyKey, unknown>)[key];

    if (
      !Object.is(first.value, second.value) ||
      !Object.is(indexed, first.value) ||
      !Object.is(indexedAgain, first.value)
    ) {
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

function looksEmbeddedMaterial(value: string): boolean {
  const lower = value.toLowerCase();

  return (
    value.length > MAX_REFERENCE_LENGTH ||
    /[\u0000-\u001f\u007f]/u.test(value) ||
    /-----begin [^-]*(private|secret|key|certificate)[^-]*-----/iu.test(value) ||
    /\b(private[-_\s]?key|api[-_\s]?key|access[-_\s]?token|refresh[-_\s]?token|password|secret)\s*(?:=|:(?!\/\/))/iu.test(
      value,
    ) ||
    lower.includes("openssh private key")
  );
}

function isReferenceSyntax(value: string): boolean {
  if (value !== value.trim()) {
    return false;
  }

  if (/[\s<>{}`"']/u.test(value)) {
    return false;
  }

  const separator = value.indexOf("://");

  if (separator <= 0 || separator === value.length - 3) {
    return false;
  }

  const scheme = value.slice(0, separator).toLowerCase();
  const body = value.slice(separator + 3);

  return /^[a-z][a-z0-9+.-]*$/u.test(scheme) && !INLINE_REFERENCE_SCHEMES.has(scheme) && body !== "";
}

function record(value: Plain | undefined): value is PlainObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasOwn(value: PlainObject, key: string): boolean {
  return Object.hasOwn(value, key);
}

function isPositiveInteger(value: Plain | undefined): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

function isPort(value: Plain | undefined): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 65_535;
}

function arrayIndexKey(key: string): boolean {
  const parsed = Number(key);

  return Number.isInteger(parsed) && parsed >= 0 && parsed < 4_294_967_295 && String(parsed) === key;
}

function setValues(values: ReadonlySet<string>): string {
  return Array.from(values).sort(compareStrings).join(", ");
}

function addError(errors: CapsuleValidationError[], path: Path, message: string): void {
  errors[errors.length] = {
    path: formatPath(path),
    message,
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
