import { normalize } from "./plan.ts";
import type {
  BackupSchedule,
  CanonicalPlan,
  DesiredApp,
  DesiredBackup,
  DesiredState,
  JsonObject,
} from "./plan.ts";

export type DeepReadonly<T> = T extends (...args: infer Args) => infer Return
  ? (...args: Args) => Return
  : T extends readonly (infer Item)[]
    ? readonly DeepReadonly<Item>[]
    : T extends object
      ? { readonly [Key in keyof T]: DeepReadonly<T[Key]> }
      : T;

export type AcceleratorKind = "npu" | "gpu" | "cpu" | (string & {});

export interface AcceleratorRequest extends JsonObject {
  readonly prefer: readonly AcceleratorKind[];
  readonly requireFallback: AcceleratorKind;
}

export interface AcceleratorSelection extends JsonObject {
  readonly type: "accelerator-selection";
  readonly prefer: readonly AcceleratorKind[];
  readonly requireFallback: AcceleratorKind;
  readonly selected?: AcceleratorKind;
}

export interface DeviceAiSnapshot {
  readonly available?: readonly AcceleratorKind[];
  readonly bestAvailable: (request: AcceleratorRequest) => AcceleratorSelection;
}

export interface DeviceSnapshot {
  readonly memoryGB: number;
  readonly ai: DeviceAiSnapshot;
}

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
  TDevice extends object = DeviceSnapshot,
  TData extends object = DataSnapshot,
> {
  readonly device: TDevice;
  readonly data: TData;
}

export type SystemSnapshot<
  TDevice extends object = DeviceSnapshot,
  TData extends object = DataSnapshot,
> = DeepReadonly<SystemSnapshotInput<TDevice, TData>>;

export type SystemAuthor<
  TDevice extends object = DeviceSnapshot,
  TData extends object = DataSnapshot,
> = (snapshot: SystemSnapshot<TDevice, TData>) => DesiredState;

export interface DefinedSystem<
  TDevice extends object = DeviceSnapshot,
  TData extends object = DataSnapshot,
> {
  (snapshot: SystemSnapshotInput<TDevice, TData>): CanonicalPlan;
  readonly evaluate: (snapshot: SystemSnapshotInput<TDevice, TData>) => CanonicalPlan;
}

export interface AppOptions extends JsonObject {
  readonly publicAccess?: boolean;
  readonly memory?: string;
  readonly accelerator?: AcceleratorSelection;
  readonly dataAccess?: readonly DataAccessGrant[];
}

export interface UsbBackupOptions {
  readonly id?: string;
  readonly schedule: BackupSchedule;
  readonly enabled?: boolean;
  readonly retentionDays?: number;
}

export function defineSystem<
  TDevice extends object = DeviceSnapshot,
  TData extends object = DataSnapshot,
>(fn: SystemAuthor<TDevice, TData>): DefinedSystem<TDevice, TData> {
  const evaluate = (snapshot: SystemSnapshotInput<TDevice, TData>): CanonicalPlan => {
    const desiredState = fn(deepFreeze(snapshot));

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
