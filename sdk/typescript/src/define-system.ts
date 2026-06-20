import { bestAvailable as selectBestAvailable } from "./capabilities.ts";
import { normalize } from "./plan.ts";
import type {
  AcceleratorRequest,
  AcceleratorSelectionResult,
  DeepReadonly,
  DeviceSnapshot,
} from "./capabilities.ts";
import type {
  BackupSchedule,
  CanonicalPlan,
  DesiredApp,
  DesiredBackup,
  DesiredState,
  JsonObject,
} from "./plan.ts";
import type { AllowedCapability } from "./validate.ts";

export type {
  AcceleratorCapability,
  AcceleratorFallback,
  AcceleratorPreference,
  AcceleratorRequest,
  AcceleratorRefusal,
  AcceleratorSelection,
  AcceleratorSelectionResult,
  DeepReadonly,
  DeviceSnapshot,
  ReadonlyAcceleratorCapability,
} from "./capabilities.ts";

export interface DeviceAiSnapshot {
  readonly bestAvailable: (request: AcceleratorRequest) => AcceleratorSelectionResult;
}

export type DeviceSnapshotInput = DeviceSnapshot & {
  readonly ai?: Partial<DeviceAiSnapshot>;
};

type AuthorDevice<TDevice extends object> = TDevice extends DeviceSnapshot
  ? Omit<TDevice, "ai"> & { readonly ai: DeviceAiSnapshot }
  : TDevice;

export interface DataAccessGrant extends JsonObject {
  readonly type: "data-access";
  readonly scope: "files";
  readonly mode: "read-only";
}

export interface FileDataSnapshot {
  readonly readOnly: () => DataAccessGrant;
}

export interface DataSnapshot {
  readonly files: FileDataSnapshot;
}

export interface SystemSnapshotInput<
  TDevice extends object = DeviceSnapshotInput,
  TData extends object = DataSnapshot,
> {
  readonly device: TDevice;
  readonly data: TData;
}

export type SystemSnapshot<
  TDevice extends object = DeviceSnapshotInput,
  TData extends object = DataSnapshot,
> = DeepReadonly<{
  readonly device: AuthorDevice<TDevice>;
  readonly data: TData;
}>;

export type SystemAuthor<
  TDevice extends object = DeviceSnapshotInput,
  TData extends object = DataSnapshot,
> = (snapshot: SystemSnapshot<TDevice, TData>) => DesiredState;

export interface DefinedSystem<
  TDevice extends object = DeviceSnapshotInput,
  TData extends object = DataSnapshot,
> {
  (snapshot: SystemSnapshotInput<TDevice, TData>): CanonicalPlan;
  readonly evaluate: (snapshot: SystemSnapshotInput<TDevice, TData>) => CanonicalPlan;
}

export interface AppOptions extends JsonObject {
  readonly allowedCapabilities?: readonly AllowedCapability[];
  readonly capabilities?: readonly AllowedCapability[];
  readonly publicAccess?: boolean;
  readonly memory?: string;
  readonly accelerator?: AcceleratorSelectionResult;
  readonly dataAccess?: readonly DataAccessGrant[];
}

export interface UsbBackupOptions {
  readonly id?: string;
  readonly schedule: BackupSchedule;
  readonly enabled?: boolean;
  readonly retentionDays?: number;
}

export function defineSystem<
  TDevice extends object = DeviceSnapshotInput,
  TData extends object = DataSnapshot,
>(fn: SystemAuthor<TDevice, TData>): DefinedSystem<TDevice, TData> {
  const evaluate = (snapshot: SystemSnapshotInput<TDevice, TData>): CanonicalPlan => {
    const desiredState = fn(deepFreeze(authorSnapshot(snapshot)));

    if (isThenable(desiredState)) {
      throw new TypeError("defineSystem author functions must return DesiredState synchronously.");
    }

    return normalize(desiredState);
  };

  return Object.freeze(Object.assign(evaluate, { evaluate }));
}

export function app(id: string, opts?: AppOptions): DesiredApp {
  if (opts === undefined) {
    return { id };
  }

  return {
    id,
    config: opts,
  };
}

export const backup = Object.freeze({
  usb(opts: UsbBackupOptions): DesiredBackup {
    const base: DesiredBackup = {
      id: opts.id ?? "usb",
      target: "usb",
      schedule: opts.schedule,
    };

    return {
      ...base,
      ...(opts.enabled === undefined ? {} : { enabled: opts.enabled }),
      ...(opts.retentionDays === undefined ? {} : { retentionDays: opts.retentionDays }),
    };
  },
});

function deepFreeze<T>(value: T, seen = new WeakSet<object>()): DeepReadonly<T> {
  if (value === null || (typeof value !== "object" && typeof value !== "function")) {
    return value as DeepReadonly<T>;
  }

  const objectValue = value as object;

  if (seen.has(objectValue)) {
    return value as DeepReadonly<T>;
  }

  seen.add(objectValue);

  for (const key of Reflect.ownKeys(objectValue)) {
    const descriptor = Object.getOwnPropertyDescriptor(objectValue, key);

    if (descriptor !== undefined && "value" in descriptor) {
      deepFreeze(descriptor.value, seen);
    }
  }

  Object.freeze(objectValue);

  return value as DeepReadonly<T>;
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
  if (value === null || (typeof value !== "object" && typeof value !== "function")) {
    return false;
  }

  return typeof (value as { readonly then?: unknown }).then === "function";
}

function authorSnapshot<TDevice extends object, TData extends object>(
  snapshot: SystemSnapshotInput<TDevice, TData>,
): { readonly device: AuthorDevice<TDevice>; readonly data: TData } {
  return {
    ...snapshot,
    device: authorDevice(snapshot.device),
  };
}

function authorDevice<TDevice extends object>(device: TDevice): AuthorDevice<TDevice> {
  if (!isAcceleratorDeviceSnapshot(device)) {
    return device as AuthorDevice<TDevice>;
  }

  const existingAi = objectProperty(device, "ai");
  const aiBase = isObject(existingAi) ? existingAi : {};
  let snapshotForSelection: DeviceSnapshot = device;
  const ai: DeviceAiSnapshot = {
    ...aiBase,
    bestAvailable(request: AcceleratorRequest): AcceleratorSelectionResult {
      return selectBestAvailable(snapshotForSelection, request);
    },
  };
  const deviceWithAi = {
    ...device,
    ai,
  };

  snapshotForSelection = deviceWithAi as DeviceSnapshot;

  return deviceWithAi as AuthorDevice<TDevice>;
}

function isAcceleratorDeviceSnapshot(device: object): device is DeviceSnapshot {
  const memoryGB = objectProperty(device, "memoryGB");
  const architecture = objectProperty(device, "architecture");
  const accelerators = objectProperty(device, "accelerators");
  const tpm = objectProperty(device, "tpm");
  const virtualization = objectProperty(device, "virtualization");

  return (
    typeof memoryGB === "number" &&
    (architecture === "x86_64" || architecture === "arm64") &&
    Array.isArray(accelerators) &&
    isObject(tpm) &&
    isObject(virtualization)
  );
}

function objectProperty(object: object, key: PropertyKey): unknown {
  return Object.prototype.hasOwnProperty.call(object, key)
    ? (object as Record<PropertyKey, unknown>)[key]
    : undefined;
}

function isObject(value: unknown): value is object {
  return value !== null && typeof value === "object";
}
