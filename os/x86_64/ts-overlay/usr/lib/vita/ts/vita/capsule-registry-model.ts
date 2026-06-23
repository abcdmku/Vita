// Vendored from sdk/typescript/src/capsule-registry-model.ts
import {
  CAPSULE_MANIFEST,
  compileCapabilityValidator,
} from "./capability-manifest.ts";
import type {
  CapabilityObject,
  CapabilityRecord,
  CapabilityValidationResult,
  CapabilityValue,
} from "./capability-manifest.ts";

export type CapsuleEntryState = "installed" | "disabled";
export type CapsuleId = string;
export type CapsuleIntegrity =
  | `sha256-${string}`
  | `sha384-${string}`
  | `sha512-${string}`;

export interface CapsuleEntry {
  readonly id: CapsuleId;
  readonly version: string;
  readonly integrity: CapsuleIntegrity;
  readonly state: CapsuleEntryState;
}

export type CapsuleRegistry = readonly CapsuleEntry[];

export interface CapsuleRegistryDesired {
  readonly capsules: CapsuleRegistry;
}

export interface CapsuleRegistryApplyRequest {
  readonly desired: CapsuleRegistryDesired;
}

export interface CapsuleRegistryConfig {
  readonly "capsule.registry": CapsuleRegistryApplyRequest;
}

export interface CapsuleRegistryValidationError {
  readonly path: string;
  readonly message: string;
}

export type CapsuleRegistryValidationResult =
  | {
      readonly ok: true;
      readonly registry: CapsuleRegistry;
      readonly value: CapsuleRegistry;
    }
  | {
      readonly ok: false;
      readonly errors: readonly CapsuleRegistryValidationError[];
    };

export type CapsuleRegistryApplyRequestValidationResult =
  | {
      readonly ok: true;
      readonly request: CapsuleRegistryApplyRequest;
      readonly registry: CapsuleRegistry;
      readonly value: CapsuleRegistryApplyRequest;
    }
  | {
      readonly ok: false;
      readonly errors: readonly CapsuleRegistryValidationError[];
    };

export type CapsuleRegistryConfigBuildResult =
  | {
      readonly ok: true;
      readonly config: CapsuleRegistryConfig;
      readonly request: CapsuleRegistryApplyRequest;
      readonly registry: CapsuleRegistry;
      readonly value: CapsuleRegistryConfig;
    }
  | {
      readonly ok: false;
      readonly errors: readonly CapsuleRegistryValidationError[];
    };

const validateCapsuleRegistryRequestShape = compileCapabilityValidator(CAPSULE_MANIFEST);
const REGISTRY_PATH_PREFIX = "desired/capsules";

export function validateCapsuleRegistry(input: unknown): CapsuleRegistryValidationResult {
  const request = validateCapsuleRegistryApplyRequest({
    desired: {
      capsules: input,
    },
  });

  if (!request.ok) {
    return rejectRegistry(rebaseRegistryErrors(request.errors));
  }

  return {
    ok: true,
    registry: request.registry,
    value: request.registry,
  };
}

export function validateCapsuleRegistryApplyRequest(
  input: unknown,
): CapsuleRegistryApplyRequestValidationResult {
  const validation = validateCapsuleRegistryRequestShape(input);

  if (!validation.ok) {
    return rejectApplyRequest(mapCapabilityRejections(validation));
  }

  const request = readValidatedRequest(validation.value);

  if (request === undefined) {
    return rejectApplyRequest([
      {
        message: "Capsule registry request validation failed.",
        path: "",
      },
    ]);
  }

  return {
    ok: true,
    registry: request.desired.capsules,
    request,
    value: request,
  };
}

export function buildCapsuleRegistryApplyRequest(
  capsules: unknown,
): CapsuleRegistryApplyRequestValidationResult {
  return validateCapsuleRegistryApplyRequest({
    desired: {
      capsules,
    },
  });
}

export function buildCapsuleRegistryConfig(
  capsules: unknown,
): CapsuleRegistryConfigBuildResult {
  const request = buildCapsuleRegistryApplyRequest(capsules);

  if (!request.ok) {
    return rejectConfig(request.errors);
  }

  const config = Object.freeze({
    "capsule.registry": request.request,
  });

  return {
    config,
    ok: true,
    registry: request.registry,
    request: request.request,
    value: config,
  };
}

function readValidatedRequest(
  value: CapabilityRecord,
): CapsuleRegistryApplyRequest | undefined {
  const desiredValue = value["desired"];

  if (!isCapabilityObject(desiredValue)) {
    return undefined;
  }

  const capsulesValue = desiredValue["capsules"];

  if (!Array.isArray(capsulesValue)) {
    return undefined;
  }

  const capsules = readValidatedRegistry(capsulesValue);

  if (capsules === undefined) {
    return undefined;
  }

  return Object.freeze({
    desired: Object.freeze({
      capsules,
    }),
  });
}

function readValidatedRegistry(
  value: readonly CapabilityValue[],
): CapsuleRegistry | undefined {
  const capsules: CapsuleEntry[] = [];

  for (let index = 0; index < value.length; index += 1) {
    const item = value[index];

    if (!isCapabilityObject(item)) {
      return undefined;
    }

    const entry = readValidatedEntry(item);

    if (entry === undefined) {
      return undefined;
    }

    capsules[index] = entry;
  }

  return Object.freeze(capsules);
}

function readValidatedEntry(value: CapabilityObject): CapsuleEntry | undefined {
  const id = readString(value, "id");
  const version = readString(value, "version");
  const integrity = readString(value, "integrity");
  const state = readString(value, "state");

  if (
    id === undefined ||
    version === undefined ||
    !isCapsuleIntegrity(integrity) ||
    !isCapsuleEntryState(state)
  ) {
    return undefined;
  }

  return Object.freeze({
    id,
    integrity,
    state,
    version,
  });
}

function readString(
  value: CapabilityObject,
  key: string,
): string | undefined {
  const child = value[key];

  return typeof child === "string" ? child : undefined;
}

function isCapsuleIntegrity(value: string | undefined): value is CapsuleIntegrity {
  return (
    value !== undefined &&
    (value.startsWith("sha256-") ||
      value.startsWith("sha384-") ||
      value.startsWith("sha512-"))
  );
}

function isCapsuleEntryState(value: string | undefined): value is CapsuleEntryState {
  return value === "installed" || value === "disabled";
}

function isCapabilityObject(
  value: CapabilityValue | undefined,
): value is CapabilityObject {
  return value !== undefined && value !== null && typeof value === "object" && !Array.isArray(value);
}

function mapCapabilityRejections(
  result: Extract<CapabilityValidationResult, { readonly ok: false }>,
): readonly CapsuleRegistryValidationError[] {
  const errors: CapsuleRegistryValidationError[] = [];

  for (let index = 0; index < result.rejections.length; index += 1) {
    const rejection = result.rejections[index];

    if (rejection !== undefined) {
      errors[errors.length] = {
        message: rejection.message,
        path: rejection.path,
      };
    }
  }

  return Object.freeze(errors);
}

function rebaseRegistryErrors(
  errors: readonly CapsuleRegistryValidationError[],
): readonly CapsuleRegistryValidationError[] {
  const rebased: CapsuleRegistryValidationError[] = [];

  for (let index = 0; index < errors.length; index += 1) {
    const error = errors[index];

    if (error !== undefined) {
      rebased[rebased.length] = {
        message: error.message,
        path: stripRegistryPrefix(error.path),
      };
    }
  }

  return Object.freeze(rebased);
}

function stripRegistryPrefix(path: string): string {
  if (path === REGISTRY_PATH_PREFIX) {
    return "";
  }

  if (path.startsWith(`${REGISTRY_PATH_PREFIX}/`)) {
    return path.slice(REGISTRY_PATH_PREFIX.length + 1);
  }

  return path;
}

function rejectRegistry(
  errors: readonly CapsuleRegistryValidationError[],
): Extract<CapsuleRegistryValidationResult, { readonly ok: false }> {
  return {
    errors,
    ok: false,
  };
}

function rejectApplyRequest(
  errors: readonly CapsuleRegistryValidationError[],
): Extract<CapsuleRegistryApplyRequestValidationResult, { readonly ok: false }> {
  return {
    errors,
    ok: false,
  };
}

function rejectConfig(
  errors: readonly CapsuleRegistryValidationError[],
): Extract<CapsuleRegistryConfigBuildResult, { readonly ok: false }> {
  return {
    errors,
    ok: false,
  };
}
