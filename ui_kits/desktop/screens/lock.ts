import type {
  DesktopHost,
  DesktopMaybePromise,
} from "../../../sdk/typescript/src/desktop-sdk/index.ts";
import type {
  VitaActionContext,
} from "../runtime/binder.ts";
import type {
  ScreenModule,
} from "../runtime/screen.ts";
import {
  createLockViewModel,
} from "../viewmodels/Lock.ts";
import type {
  LockAuthPort,
  LockUser,
  LockViewModel,
  LockViewModelState,
} from "../viewmodels/Lock.ts";
import {
  datasetValue,
  optionalHostPort,
} from "./shared.ts";

export interface LockScreenPorts {
  readonly auth?: LockAuthPort;
  readonly user?: LockUser;
}

const LOCK_INITIAL_NOW_MS = Date.UTC(2024, 5, 25, 10, 24, 0);

export const lockScreen = Object.freeze({
  actions: new Map<string, (viewModel: LockViewModel, context: VitaActionContext<LockViewModelState>) => DesktopMaybePromise<void>>([
    ["lock.submit", async (viewModel, context) => {
      await viewModel.submit(datasetValue(context.target, Object.freeze(["vitaCredential"])) ?? "password");
    }],
    ["lock.cancel", (viewModel) => {
      viewModel.cancel();
    }],
    ["lock.tick", (viewModel, context) => {
      const raw = datasetValue(context.target, Object.freeze(["vitaNow"]));
      const parsed = raw === undefined ? LOCK_INITIAL_NOW_MS : Number.parseInt(raw, 10);

      viewModel.tick(parsed);
    }],
  ]),
  binds: new Map<string, (snapshot: LockViewModelState) => string | boolean>([
    ["lock.date", (snapshot) => snapshot.clock.date],
    ["lock.time", (snapshot) => snapshot.clock.time],
    ["lock.user", (snapshot) => snapshot.user.displayName],
    ["lock.initials", (snapshot) => snapshot.user.initials],
    ["lock.state", (snapshot) => snapshot.lockState],
    ["lock.canSubmit", (snapshot) => snapshot.canSubmit],
    ["lock.unlocked", (snapshot) => snapshot.lockState === "unlocked"],
    ["lock.authenticating", (snapshot) => snapshot.lockState === "authenticating"],
    ["lock.error", (snapshot) => snapshot.error?.message ?? ""],
    ["lock.remainingAttempts", (snapshot) => `${snapshot.remainingAttempts}`],
  ]),
  createViewModel(ports: LockScreenPorts): LockViewModel {
    const input: {
      auth?: LockAuthPort;
      initialNow: number;
      user?: LockUser;
    } = {
      initialNow: LOCK_INITIAL_NOW_MS,
    };

    if (ports.auth !== undefined) input.auth = ports.auth;
    if (ports.user !== undefined) input.user = ports.user;

    return createLockViewModel(input);
  },
  id: "desktop/lock",
  selectPorts(host: DesktopHost): LockScreenPorts {
    const auth = optionalHostPort(host, "lockAuth", isLockAuthPort) ??
      optionalHostPort(host, "auth", isLockAuthPort);
    const user = optionalHostPort(host, "lockUser", isLockUser);
    const output: {
      auth?: LockAuthPort;
      user?: LockUser;
    } = {};

    if (auth !== undefined) output.auth = auth;
    if (user !== undefined) output.user = user;

    return Object.freeze(output);
  },
}) satisfies ScreenModule<LockViewModelState, LockScreenPorts, LockViewModel>;

export default lockScreen;

function isLockAuthPort(value: unknown): value is LockAuthPort {
  return value !== null &&
    typeof value === "object" &&
    typeof ownData(value, "authenticate") === "function";
}

function isLockUser(value: unknown): value is LockUser {
  if (value === null || typeof value !== "object") return false;

  const id = ownData(value, "id");
  const displayName = ownData(value, "displayName");
  const initials = ownData(value, "initials");

  return typeof id === "string" &&
    id.length > 0 &&
    typeof displayName === "string" &&
    displayName.length > 0 &&
    typeof initials === "string" &&
    initials.length > 0;
}

function ownData(value: object, key: string): unknown {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);

    if (descriptor === undefined || !Object.prototype.hasOwnProperty.call(descriptor, "value")) {
      return undefined;
    }

    return descriptor.value;
  } catch {
    return undefined;
  }
}
