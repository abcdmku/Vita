export interface SimulationProfileValidationError {
  readonly path: string;
  readonly message: string;
}

export type SimulationProfilesValidationResult =
  | {
      readonly ok: true;
      readonly profiles: readonly SimulationProfile[];
    }
  | {
      readonly ok: false;
      readonly errors: readonly SimulationProfileValidationError[];
    };

export type SimulationProfileKind =
  | "low-memory"
  | "offline"
  | "no-accelerator"
  | "architecture-migration"
  | "power-loss"
  | "network-partition";

export type SimulationArchitecture = "x86_64" | "arm64";
export type SimulationAcceleratorKind = "gpu" | "npu";
export type SimulationHealthCheckType = "http" | "tcp" | "lifecycle";

export interface SimulationHealthCheck {
  readonly name: string;
  readonly type: SimulationHealthCheckType;
  readonly target: string;
  readonly intervalSeconds?: number;
  readonly timeoutSeconds?: number;
}

export interface SimulationFailureTest {
  readonly name: string;
  readonly fault: string;
  readonly expectedHealth: string;
  readonly timeoutSeconds?: number;
}

interface SimulationProfileBase<Kind extends SimulationProfileKind> {
  readonly kind: Kind;
  readonly expectedHealthChecks: readonly SimulationHealthCheck[];
  readonly failureTests: readonly SimulationFailureTest[];
}

export interface LowMemorySimulationProfile extends SimulationProfileBase<"low-memory"> {
  readonly memoryMiB: number;
}

export interface OfflineSimulationProfile extends SimulationProfileBase<"offline"> {
  readonly durationSeconds: number;
}

export interface NoAcceleratorSimulationProfile
  extends SimulationProfileBase<"no-accelerator"> {
  readonly accelerators: readonly SimulationAcceleratorKind[];
}

export interface ArchitectureMigrationSimulationProfile
  extends SimulationProfileBase<"architecture-migration"> {
  readonly from: SimulationArchitecture;
  readonly to: SimulationArchitecture;
}

export interface PowerLossSimulationProfile extends SimulationProfileBase<"power-loss"> {
  readonly cycles: number;
  readonly outageSeconds: number;
}

export interface NetworkPartitionSimulationProfile
  extends SimulationProfileBase<"network-partition"> {
  readonly partitionCount: number;
  readonly durationSeconds: number;
}

export type SimulationProfile =
  | LowMemorySimulationProfile
  | OfflineSimulationProfile
  | NoAcceleratorSimulationProfile
  | ArchitectureMigrationSimulationProfile
  | PowerLossSimulationProfile
  | NetworkPartitionSimulationProfile;

export const SIMULATION_PROFILE_KINDS = [
  "low-memory",
  "offline",
  "no-accelerator",
  "architecture-migration",
  "power-loss",
  "network-partition",
] as const satisfies readonly SimulationProfileKind[];

export const REQUIRED_PROFILES = [
  "low-memory",
  "offline",
  "no-accelerator",
  "architecture-migration",
  "power-loss",
  "network-partition",
] as const satisfies readonly SimulationProfileKind[];

export interface RequiredProfileCoverage {
  readonly ok: boolean;
  readonly missing: readonly SimulationProfileKind[];
}

type Plain = null | boolean | number | string | Plain[] | { [key: string]: Plain };
type PlainObject = { [key: string]: Plain };
type Path = readonly string[];

interface NormalizationContext {
  readonly errors: SimulationProfileValidationError[];
  readonly seen: WeakSet<object>;
}

type ReadResult = { readonly ok: true; readonly value: unknown } | { readonly ok: false };

const MAX_DEPTH = 64;
const MAX_ITEMS = 10_000;

const PROFILE_KIND_SET = new Set<string>(SIMULATION_PROFILE_KINDS);
const ARCHITECTURES = new Set<string>(["x86_64", "arm64"]);
const ACCELERATORS = new Set<string>(["gpu", "npu"]);
const HEALTH_CHECK_TYPES = new Set<string>(["http", "tcp", "lifecycle"]);

const BASE_PROFILE_FIELDS = ["kind", "expectedHealthChecks", "failureTests"] as const;
const LOW_MEMORY_FIELDS = fieldSet([...BASE_PROFILE_FIELDS, "memoryMiB"]);
const OFFLINE_FIELDS = fieldSet([...BASE_PROFILE_FIELDS, "durationSeconds"]);
const NO_ACCELERATOR_FIELDS = fieldSet([...BASE_PROFILE_FIELDS, "accelerators"]);
const ARCHITECTURE_MIGRATION_FIELDS = fieldSet([...BASE_PROFILE_FIELDS, "from", "to"]);
const POWER_LOSS_FIELDS = fieldSet([...BASE_PROFILE_FIELDS, "cycles", "outageSeconds"]);
const NETWORK_PARTITION_FIELDS = fieldSet([
  ...BASE_PROFILE_FIELDS,
  "partitionCount",
  "durationSeconds",
]);
const HEALTH_CHECK_FIELDS = fieldSet([
  "name",
  "type",
  "target",
  "intervalSeconds",
  "timeoutSeconds",
]);
const FAILURE_TEST_FIELDS = fieldSet(["name", "fault", "expectedHealth", "timeoutSeconds"]);

const SHADOWABLE_ARRAY_METHODS = new Set<string>([
  "some",
  "includes",
  "find",
  "forEach",
  "map",
  "filter",
  "every",
  "reduce",
]);

export function coversRequiredProfiles(
  declared: readonly SimulationProfileKind[] | readonly SimulationProfile[],
): RequiredProfileCoverage {
  const present = new Set<string>();

  try {
    if (Array.isArray(declared)) {
      const length = stableLength(declared);

      if (length !== undefined) {
        for (let index = 0; index < length; index += 1) {
          const entry = stableData(declared, String(index));

          if (!entry.ok) {
            continue;
          }

          const kind = profileKindFromDeclaredEntry(entry.value);

          if (kind !== undefined) {
            present.add(kind);
          }
        }
      }
    }
  } catch {
    present.clear();
  }

  const missing: SimulationProfileKind[] = [];

  for (let index = 0; index < REQUIRED_PROFILES.length; index += 1) {
    const required = REQUIRED_PROFILES[index];

    if (required !== undefined && !present.has(required)) {
      missing[missing.length] = required;
    }
  }

  return {
    ok: missing.length === 0,
    missing,
  };
}

export function validateSimulationProfiles(value: unknown): SimulationProfilesValidationResult {
  const errors: SimulationProfileValidationError[] = [];

  try {
    const normalized = normalizePlain(value, [], {
      errors,
      seen: new WeakSet<object>(),
    });

    if (errors.length > 0) {
      return { ok: false, errors };
    }

    if (!Array.isArray(normalized)) {
      addError(errors, [], "Expected simulation profile array.");
      return { ok: false, errors };
    }

    if (!validateProfileArray(normalized, [], errors)) {
      return { ok: false, errors };
    }

    return {
      ok: true,
      profiles: normalized,
    };
  } catch {
    return {
      ok: false,
      errors: [
        {
          path: "",
          message: "Simulation profile validation failed closed.",
        },
      ],
    };
  }
}

function validateProfileArray(
  value: readonly Plain[],
  path: Path,
  errors: SimulationProfileValidationError[],
): value is readonly (Plain & SimulationProfile)[] {
  const errorStart = errors.length;

  for (let index = 0; index < value.length; index += 1) {
    validateProfile(value[index], [...path, String(index)], errors);
  }

  return errors.length === errorStart;
}

function validateProfile(
  value: Plain | undefined,
  path: Path,
  errors: SimulationProfileValidationError[],
): void {
  if (!record(value)) {
    addError(errors, path, "Expected simulation profile object.");
    return;
  }

  const kind = validateRequiredStringEnum(value, "kind", PROFILE_KIND_SET, [...path, "kind"], errors);

  if (kind === undefined) {
    return;
  }

  switch (kind) {
    case "low-memory":
      rejectUnknownFields(value, LOW_MEMORY_FIELDS, path, errors);
      validateCommonProfileFields(value, path, errors);
      validateRequiredPositiveInteger(value, "memoryMiB", [...path, "memoryMiB"], errors);
      return;

    case "offline":
      rejectUnknownFields(value, OFFLINE_FIELDS, path, errors);
      validateCommonProfileFields(value, path, errors);
      validateRequiredPositiveInteger(value, "durationSeconds", [...path, "durationSeconds"], errors);
      return;

    case "no-accelerator":
      rejectUnknownFields(value, NO_ACCELERATOR_FIELDS, path, errors);
      validateCommonProfileFields(value, path, errors);
      validateRequiredStringEnumArray(
        value,
        "accelerators",
        ACCELERATORS,
        [...path, "accelerators"],
        errors,
      );
      return;

    case "architecture-migration":
      rejectUnknownFields(value, ARCHITECTURE_MIGRATION_FIELDS, path, errors);
      validateCommonProfileFields(value, path, errors);
      validateArchitectureMigration(value, path, errors);
      return;

    case "power-loss":
      rejectUnknownFields(value, POWER_LOSS_FIELDS, path, errors);
      validateCommonProfileFields(value, path, errors);
      validateRequiredPositiveInteger(value, "cycles", [...path, "cycles"], errors);
      validateRequiredPositiveInteger(value, "outageSeconds", [...path, "outageSeconds"], errors);
      return;

    case "network-partition":
      rejectUnknownFields(value, NETWORK_PARTITION_FIELDS, path, errors);
      validateCommonProfileFields(value, path, errors);
      validateRequiredPositiveInteger(value, "partitionCount", [...path, "partitionCount"], errors);
      validateRequiredPositiveInteger(value, "durationSeconds", [...path, "durationSeconds"], errors);
      return;
  }
}

function validateCommonProfileFields(
  value: PlainObject,
  path: Path,
  errors: SimulationProfileValidationError[],
): void {
  validateRequiredArray(
    value,
    "expectedHealthChecks",
    [...path, "expectedHealthChecks"],
    errors,
    validateHealthCheck,
  );
  validateRequiredArray(value, "failureTests", [...path, "failureTests"], errors, validateFailureTest);
}

function validateArchitectureMigration(
  value: PlainObject,
  path: Path,
  errors: SimulationProfileValidationError[],
): void {
  const from = validateRequiredStringEnum(value, "from", ARCHITECTURES, [...path, "from"], errors);
  const to = validateRequiredStringEnum(value, "to", ARCHITECTURES, [...path, "to"], errors);

  if (from !== undefined && to !== undefined && from === to) {
    addError(errors, [...path, "to"], "Architecture migration must change architecture.");
  }
}

function validateHealthCheck(
  value: Plain | undefined,
  path: Path,
  errors: SimulationProfileValidationError[],
): void {
  if (!record(value)) {
    addError(errors, path, "Expected health check object.");
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
  errors: SimulationProfileValidationError[],
): void {
  if (!record(value)) {
    addError(errors, path, "Expected failure test object.");
    return;
  }

  rejectUnknownFields(value, FAILURE_TEST_FIELDS, path, errors);
  validateRequiredString(value, "name", [...path, "name"], errors);
  validateRequiredString(value, "fault", [...path, "fault"], errors);
  validateRequiredString(value, "expectedHealth", [...path, "expectedHealth"], errors);
  validateOptionalPositiveInteger(value, "timeoutSeconds", [...path, "timeoutSeconds"], errors);
}

function validateRequiredArray(
  value: PlainObject,
  key: string,
  path: Path,
  errors: SimulationProfileValidationError[],
  validate: (
    item: Plain | undefined,
    itemPath: Path,
    itemErrors: SimulationProfileValidationError[],
  ) => void,
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

function validateRequiredStringEnumArray(
  value: PlainObject,
  key: string,
  allowed: ReadonlySet<string>,
  path: Path,
  errors: SimulationProfileValidationError[],
): void {
  validateRequiredArray(value, key, path, errors, (item, itemPath, itemErrors) => {
    if (typeof item !== "string" || !allowed.has(item)) {
      addError(
        itemErrors,
        itemPath,
        `Expected one of: ${setValues(allowed)}.`,
      );
    }
  });
}

function validateRequiredString(
  value: PlainObject,
  key: string,
  path: Path,
  errors: SimulationProfileValidationError[],
): string | undefined {
  if (!hasOwn(value, key)) {
    addError(errors, path, "Required field is missing.");
    return undefined;
  }

  const child = value[key];

  if (typeof child !== "string" || child.length === 0) {
    addError(errors, path, "Expected non-empty string.");
    return undefined;
  }

  return child;
}

function validateRequiredStringEnum(
  value: PlainObject,
  key: string,
  allowed: ReadonlySet<string>,
  path: Path,
  errors: SimulationProfileValidationError[],
): string | undefined {
  const child = validateRequiredString(value, key, path, errors);

  if (child === undefined) {
    return undefined;
  }

  if (!allowed.has(child)) {
    addError(errors, path, `Expected one of: ${setValues(allowed)}.`);
    return undefined;
  }

  return child;
}

function validateRequiredPositiveInteger(
  value: PlainObject,
  key: string,
  path: Path,
  errors: SimulationProfileValidationError[],
): number | undefined {
  if (!hasOwn(value, key)) {
    addError(errors, path, "Required field is missing.");
    return undefined;
  }

  const child = value[key];

  if (!positiveInteger(child)) {
    addError(errors, path, "Expected positive integer.");
    return undefined;
  }

  return child;
}

function validateOptionalPositiveInteger(
  value: PlainObject,
  key: string,
  path: Path,
  errors: SimulationProfileValidationError[],
): void {
  if (!hasOwn(value, key)) {
    return;
  }

  const child = value[key];

  if (!positiveInteger(child)) {
    addError(errors, path, "Expected positive integer.");
  }
}

function rejectUnknownFields(
  value: PlainObject,
  allowed: ReadonlySet<string>,
  path: Path,
  errors: SimulationProfileValidationError[],
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

function profileKindFromDeclaredEntry(value: unknown): SimulationProfileKind | undefined {
  if (isProfileKind(value)) {
    return value;
  }

  if (value === null || typeof value !== "object") {
    return undefined;
  }

  const kind = stableData(value, "kind");

  if (!kind.ok || !isProfileKind(kind.value)) {
    return undefined;
  }

  return kind.value;
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

function fieldSet(fields: readonly string[]): ReadonlySet<string> {
  return new Set<string>(fields);
}

function hasOwn(value: PlainObject, key: string): boolean {
  return Object.hasOwn(value, key);
}

function record(value: Plain | undefined): value is PlainObject {
  return value !== null && value !== undefined && typeof value === "object" && !Array.isArray(value);
}

function positiveInteger(value: Plain | undefined): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

function isProfileKind(value: unknown): value is SimulationProfileKind {
  return typeof value === "string" && PROFILE_KIND_SET.has(value);
}

function arrayIndexKey(key: string): boolean {
  if (key.length === 0) {
    return false;
  }

  const parsed = Number(key);

  return Number.isInteger(parsed) && parsed >= 0 && parsed < 4_294_967_295 && String(parsed) === key;
}

function setValues(values: ReadonlySet<string>): string {
  return Array.from(values).sort(compareStrings).join(", ");
}

function addError(
  errors: SimulationProfileValidationError[],
  path: Path,
  message: string,
): void {
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
