export type AcceleratorCapability =
  | { kind: "nvidia.cuda"; memoryGB: number; compute: string }
  | { kind: "intel.npu"; generation: string }
  | { kind: "amd.npu"; generation: string }
  | { kind: "amd.rocm"; memoryGB: number }
  | { kind: "intel.gpu"; memoryModel: "shared" | "dedicated" }
  | { kind: "cpu"; architecture: "x86_64" | "arm64" };

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

export interface BestAvailableRequest extends AcceleratorRequest {
  readonly snapshot: DeviceSnapshot;
}

export type AcceleratorSelectionResult = AcceleratorSelection | AcceleratorRefusal;

export interface AcceleratorSelection {
  readonly type: "accelerator-selection";
  readonly selected: AcceleratorCapability;
  readonly selectedPreference: AcceleratorPreference;
  readonly fallback: boolean;
  readonly prefer: readonly AcceleratorPreference[];
  readonly requireFallback: AcceleratorFallback;
}

export interface AcceleratorRefusal {
  readonly type: "accelerator-refusal";
  readonly code: "ACCELERATOR_UNAVAILABLE";
  readonly reason: string;
  readonly prefer: readonly AcceleratorPreference[];
  readonly requireFallback: false;
  readonly available: readonly AcceleratorCapability[];
}

export function bestAvailable(request: BestAvailableRequest): AcceleratorSelectionResult;
export function bestAvailable(
  snapshot: DeviceSnapshot,
  request: AcceleratorRequest,
): AcceleratorSelectionResult;
export function bestAvailable(
  first: BestAvailableRequest | DeviceSnapshot,
  second?: AcceleratorRequest,
): AcceleratorSelectionResult {
  const request =
    second === undefined
      ? (first as BestAvailableRequest)
      : {
          ...second,
          snapshot: first as DeviceSnapshot,
        };
  const available = availableAccelerators(request.snapshot);

  for (const preference of request.prefer) {
    const selected = firstMatchingAccelerator(available, preference);

    if (selected !== undefined) {
      return {
        type: "accelerator-selection",
        selected,
        selectedPreference: preference,
        fallback: selected.kind === "cpu" && request.requireFallback === "cpu",
        prefer: [...request.prefer],
        requireFallback: request.requireFallback,
      };
    }
  }

  if (request.requireFallback === "cpu") {
    return {
      type: "accelerator-selection",
      selected: cpuFallback(request.snapshot),
      selectedPreference: "cpu",
      fallback: true,
      prefer: [...request.prefer],
      requireFallback: request.requireFallback,
    };
  }

  return {
    type: "accelerator-refusal",
    code: "ACCELERATOR_UNAVAILABLE",
    reason: "No preferred accelerator is available and CPU fallback was not allowed.",
    prefer: [...request.prefer],
    requireFallback: false,
    available,
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
