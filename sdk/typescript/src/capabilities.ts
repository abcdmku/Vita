import type { JsonObject } from "./plan.ts";

export type AcceleratorCapability =
  | {
      readonly kind: "nvidia.cuda";
      readonly memoryGB: number;
      readonly compute: string;
    }
  | {
      readonly kind: "intel.npu";
      readonly generation: string;
    }
  | {
      readonly kind: "amd.npu";
      readonly generation: string;
    }
  | {
      readonly kind: "amd.rocm";
      readonly memoryGB: number;
    }
  | {
      readonly kind: "intel.gpu";
      readonly memoryModel: "shared" | "dedicated";
    }
  | {
      readonly kind: "cpu";
      readonly architecture: "x86_64" | "arm64";
    };

export type DeepReadonly<T> = T extends (...args: infer Args) => infer Return
  ? (...args: Args) => Return
  : T extends readonly (infer Item)[]
    ? readonly DeepReadonly<Item>[]
    : T extends object
      ? { readonly [Key in keyof T]: DeepReadonly<T[Key]> }
      : T;

export type DeviceArchitecture = "x86_64" | "arm64";
export type AcceleratorPreference = "npu" | "gpu" | "cpu";
export type AcceleratorFallback = "cpu" | false;
export type ReadonlyAcceleratorCapability = DeepReadonly<AcceleratorCapability>;

export interface TpmCapability {
  readonly present: boolean;
  readonly version?: "2.0" | (string & {});
  readonly sealedKeyUnlock?: boolean;
}

export interface VirtualizationCapability {
  readonly hardware: boolean;
  readonly nested?: boolean;
}

export interface StorageCapability {
  readonly bootGB?: number;
  readonly dataGB?: number;
}

export interface NetworkingCapability {
  readonly ethernet?: boolean;
  readonly wifi?: boolean;
}

interface DeviceSnapshotShape {
  readonly memoryGB: number;
  readonly architecture: DeviceArchitecture;
  readonly accelerators: readonly AcceleratorCapability[];
  readonly tpm: TpmCapability;
  readonly virtualization: VirtualizationCapability;
  readonly storage?: StorageCapability;
  readonly networking?: NetworkingCapability;
}

export type DeviceSnapshot = DeepReadonly<DeviceSnapshotShape>;

export interface AcceleratorRequest {
  readonly prefer: readonly AcceleratorPreference[];
  readonly requireFallback: AcceleratorFallback;
}

export type AcceleratorSelectionResult = AcceleratorSelection | AcceleratorRefusal;

export interface AcceleratorSelection extends JsonObject {
  readonly type: "accelerator-selection";
  readonly selected: ReadonlyAcceleratorCapability;
  readonly selectedPreference: AcceleratorPreference;
  readonly fallback: boolean;
  readonly prefer: readonly AcceleratorPreference[];
  readonly requireFallback: AcceleratorFallback;
}

export interface AcceleratorRefusal extends JsonObject {
  readonly type: "accelerator-refusal";
  readonly code: "ACCELERATOR_UNAVAILABLE";
  readonly reason: string;
  readonly prefer: readonly AcceleratorPreference[];
  readonly requireFallback: false;
  readonly available: readonly ReadonlyAcceleratorCapability[];
}

export function bestAvailable(
  snapshot: DeviceSnapshot,
  request: AcceleratorRequest,
): AcceleratorSelectionResult {
  const available = availableAccelerators(snapshot);

  for (const preference of request.prefer) {
    const selected = firstMatchingAccelerator(available, preference);

    if (selected !== undefined) {
      return {
        type: "accelerator-selection",
        selected: freezeCapability(selected),
        selectedPreference: preference,
        fallback: false,
        prefer: freezePreferences(request.prefer),
        requireFallback: request.requireFallback,
      };
    }
  }

  if (request.requireFallback === "cpu") {
    return {
      type: "accelerator-selection",
      selected: freezeCapability(cpuFallback(snapshot)),
      selectedPreference: "cpu",
      fallback: true,
      prefer: freezePreferences(request.prefer),
      requireFallback: request.requireFallback,
    };
  }

  return {
    type: "accelerator-refusal",
    code: "ACCELERATOR_UNAVAILABLE",
    reason: "No preferred accelerator is available and CPU fallback was not allowed.",
    prefer: freezePreferences(request.prefer),
    requireFallback: false,
    available: freezeCapabilities(available),
  };
}

function availableAccelerators(snapshot: DeviceSnapshot): readonly AcceleratorCapability[] {
  if (snapshot.accelerators.some((capability) => capability.kind === "cpu")) {
    return snapshot.accelerators;
  }

  return [...snapshot.accelerators, cpuFallback(snapshot)];
}

function firstMatchingAccelerator(
  available: readonly AcceleratorCapability[],
  preference: AcceleratorPreference,
): AcceleratorCapability | undefined {
  return available.find((capability) => matchesPreference(capability, preference));
}

function matchesPreference(
  capability: AcceleratorCapability,
  preference: AcceleratorPreference,
): boolean {
  switch (preference) {
    case "npu":
      return capability.kind === "intel.npu" || capability.kind === "amd.npu";
    case "gpu":
      return (
        capability.kind === "nvidia.cuda" ||
        capability.kind === "amd.rocm" ||
        capability.kind === "intel.gpu"
      );
    case "cpu":
      return capability.kind === "cpu";
  }
}

function cpuFallback(snapshot: DeviceSnapshot): AcceleratorCapability {
  return {
    kind: "cpu",
    architecture: snapshot.architecture,
  };
}

function freezeCapability(capability: AcceleratorCapability): ReadonlyAcceleratorCapability {
  return Object.freeze({ ...capability }) as ReadonlyAcceleratorCapability;
}

function freezeCapabilities(
  capabilities: readonly AcceleratorCapability[],
): readonly ReadonlyAcceleratorCapability[] {
  return Object.freeze(capabilities.map(freezeCapability));
}

function freezePreferences(
  preferences: readonly AcceleratorPreference[],
): readonly AcceleratorPreference[] {
  return Object.freeze([...preferences]);
}
