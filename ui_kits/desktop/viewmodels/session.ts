import type {
  DesktopHostError,
} from "../../../sdk/typescript/src/desktop-sdk/index.ts";
import {
  createLockViewModel,
} from "./Lock.ts";
import type {
  LockAuthPort,
  LockUser,
  LockViewModel,
  LockViewModelActionResult,
  LockViewModelError,
  LockViewModelErrorCode,
  LockViewModelState,
} from "./Lock.ts";

export type {
  LockAuthPort,
  LockAuthenticateRequest,
  LockAuthSession,
  LockUser,
} from "./Lock.ts";

export type SessionStateKind =
  | "cold-boot"
  | "locked"
  | "authenticating"
  | "unlocked"
  | "shutdown";

export type SessionLockReason = "manual" | "idle";
export type SessionLockedReason = "boot" | SessionLockReason | "auth-rejected";
export type SessionShutdownReason = "logout" | "shutdown";

export type SessionTransitionAction =
  | "boot"
  | "submit"
  | "lock"
  | "requestShutdown"
  | "tick";

export type SessionTransitionReason =
  | SessionLockedReason
  | "auth-accepted"
  | SessionShutdownReason;

export type SessionViewModelErrorCode =
  | LockViewModelErrorCode
  | "INVALID_LOCK_REASON"
  | "INVALID_SHUTDOWN_REASON"
  | "INVALID_TRANSITION";

export interface SessionColdBootState {
  readonly kind: "cold-boot";
}

export interface SessionLockedState {
  readonly kind: "locked";
  readonly reason: SessionLockedReason;
  readonly lock: LockViewModelState;
}

export interface SessionAuthenticatingState {
  readonly kind: "authenticating";
  readonly startedAtMs: number;
  readonly lock: LockViewModelState;
}

export interface SessionUnlockedState {
  readonly kind: "unlocked";
  readonly user: LockUser;
  readonly lock: LockViewModelState;
  readonly unlockedAtMs: number;
  readonly lastActivityAtMs: number;
  readonly idleTimeoutMs: number;
  readonly idleDeadlineMs: number;
}

export interface SessionShutdownState {
  readonly kind: "shutdown";
  readonly reason: SessionShutdownReason;
  readonly requestedAtMs: number;
  readonly previousKind: SessionStateKind;
}

export type SessionState =
  | SessionColdBootState
  | SessionLockedState
  | SessionAuthenticatingState
  | SessionUnlockedState
  | SessionShutdownState;

export interface SessionTransition {
  readonly action: SessionTransitionAction;
  readonly from: SessionStateKind;
  readonly to: SessionStateKind;
  readonly reason?: SessionTransitionReason;
}

export interface SessionViewModelError extends DesktopHostError {
  readonly code: SessionViewModelErrorCode;
}

export type SessionViewModelActionResult =
  | {
      readonly ok: true;
      readonly state: SessionState;
      readonly transition: SessionTransition;
    }
  | {
      readonly ok: false;
      readonly state: SessionState;
      readonly transition?: SessionTransition;
      readonly error: SessionViewModelError;
    };

export interface SessionViewModelOptions {
  readonly auth?: LockAuthPort;
  readonly idleTimeoutMs?: number;
  readonly initialNow?: Date | number;
  readonly maxAttempts?: number;
  readonly user?: LockUser;
}

export interface SessionViewModel {
  readonly state: SessionState;
  snapshot(): SessionState;
  boot(): SessionViewModelActionResult;
  submit(credential: unknown): Promise<SessionViewModelActionResult>;
  lock(reason: unknown): SessionViewModelActionResult;
  requestShutdown(reason: unknown): SessionViewModelActionResult;
  tick(now: unknown): SessionViewModelActionResult;
}

type NormalizeResult<T> =
  | {
      readonly ok: true;
      readonly value: T;
    }
  | {
      readonly ok: false;
      readonly error: SessionViewModelError;
    };

const DEFAULT_IDLE_TIMEOUT_MS = 5 * 60 * 1_000;

export function createSessionViewModel(
  options: SessionViewModelOptions = Object.freeze({}),
): SessionViewModel {
  return new DesktopSessionViewModel(options);
}

class DesktopSessionViewModel implements SessionViewModel {
  readonly #auth: LockAuthPort | undefined;
  readonly #idleTimeoutMs: number;
  readonly #initialNow: Date | number | undefined;
  readonly #maxAttempts: number | undefined;
  readonly #user: LockUser | undefined;
  #authEpoch = 0;
  #lockModel: LockViewModel | undefined;
  #state: SessionState;

  constructor(options: SessionViewModelOptions) {
    this.#auth = options.auth;
    this.#idleTimeoutMs = normalizeIdleTimeout(options.idleTimeoutMs);
    this.#initialNow = options.initialNow;
    this.#maxAttempts = options.maxAttempts;
    this.#user = options.user;
    this.#state = coldBootState();
  }

  get state(): SessionState {
    return this.#state;
  }

  snapshot(): SessionState {
    return this.#state;
  }

  boot(): SessionViewModelActionResult {
    const from = this.#state.kind;

    if (from !== "cold-boot") {
      return actionReject(invalidTransition("boot", from), this.#state);
    }

    this.#authEpoch += 1;
    this.#lockModel = this.#createLockModel(this.#user, this.#initialNow);

    const next = lockedState(this.#lockModel.snapshot(), "boot");
    const bootTransition = transition("boot", "cold-boot", "locked", "boot");

    this.#state = next;

    return actionAccept(next, bootTransition);
  }

  async submit(credential: unknown): Promise<SessionViewModelActionResult> {
    const from = this.#state.kind;

    if (from === "unlocked") {
      return actionReject(error(
        "ALREADY_UNLOCKED",
        "session is already unlocked.",
        "/kind",
      ), this.#state);
    }

    if (from === "authenticating") {
      return actionReject(error(
        "AUTHENTICATION_IN_PROGRESS",
        "session authentication is already in progress.",
        "/kind",
      ), this.#state);
    }

    if (from !== "locked") {
      return actionReject(invalidTransition("submit", from), this.#state);
    }

    const lockModel = this.#lockModel;

    if (lockModel === undefined) {
      return actionReject(invalidTransition("submit", from), this.#state);
    }

    const epoch = this.#authEpoch + 1;
    this.#authEpoch = epoch;

    const submitted = lockModel.submit(credential);
    const pendingLockState = lockModel.snapshot();
    const enteredAuthenticating = pendingLockState.lockState === "authenticating";

    if (enteredAuthenticating) {
      this.#state = authenticatingState(pendingLockState, pendingLockState.clock.epochMs);
    }

    let lockResult: LockViewModelActionResult;

    try {
      lockResult = await submitted;
    } catch {
      if (this.#authEpoch !== epoch) {
        return actionReject(cancelledAuthentication(), this.#state);
      }

      return actionReject(error(
        "AUTH_PORT_FAILED",
        "lock authentication failed closed.",
        "/auth",
      ), this.#state);
    }

    if (this.#authEpoch !== epoch || (enteredAuthenticating && this.#state.kind !== "authenticating")) {
      return actionReject(cancelledAuthentication(), this.#state);
    }

    if (!enteredAuthenticating && this.#state.kind !== "locked") {
      return actionReject(cancelledAuthentication(), this.#state);
    }

    if (lockResult.ok) {
      const unlockedAtMs = lockResult.state.clock.epochMs;
      const next = unlockedState(lockResult.state, this.#idleTimeoutMs, unlockedAtMs);
      const accepted = transition("submit", "locked", "unlocked", "auth-accepted");

      this.#state = next;

      return actionAccept(next, accepted);
    }

    const next = lockedState(lockResult.state, "auth-rejected");
    const rejected = transition("submit", "locked", "locked", "auth-rejected");
    const errorValue = fromLockError(lockResult.error);

    this.#state = next;

    return actionReject(errorValue, next, rejected);
  }

  lock(reason: unknown): SessionViewModelActionResult {
    const normalized = normalizeLockReason(reason);

    if (!normalized.ok) {
      return actionReject(normalized.error, this.#state);
    }

    if (this.#state.kind !== "unlocked") {
      return actionReject(invalidTransition("lock", this.#state.kind), this.#state);
    }

    return this.#lockUnlocked(normalized.value, "lock");
  }

  requestShutdown(reason: unknown): SessionViewModelActionResult {
    const normalized = normalizeShutdownReason(reason);

    if (!normalized.ok) {
      return actionReject(normalized.error, this.#state);
    }

    const from = this.#state.kind;

    if (from === "shutdown") {
      return actionReject(invalidTransition("requestShutdown", from), this.#state);
    }

    this.#authEpoch += 1;

    const next = shutdownState(normalized.value, stateEpochMs(this.#state), from);
    const shutdownTransition = transition("requestShutdown", from, "shutdown", normalized.value);

    this.#state = next;

    return actionAccept(next, shutdownTransition);
  }

  tick(now: unknown): SessionViewModelActionResult {
    const fromState = this.#state;
    const lockModel = this.#lockModel;

    if (
      lockModel === undefined ||
      fromState.kind === "cold-boot" ||
      fromState.kind === "shutdown"
    ) {
      return actionReject(invalidTransition("tick", fromState.kind), this.#state);
    }

    const lockTick = lockModel.tick(now);

    if (!lockTick.ok) {
      return actionReject(fromLockError(lockTick.error), this.#state);
    }

    if (fromState.kind === "locked") {
      const next = lockedState(lockTick.state, fromState.reason);
      const tickTransition = transition("tick", "locked", "locked");

      this.#state = next;

      return actionAccept(next, tickTransition);
    }

    if (fromState.kind === "authenticating") {
      const next = authenticatingState(lockTick.state, fromState.startedAtMs);
      const tickTransition = transition("tick", "authenticating", "authenticating");

      this.#state = next;

      return actionAccept(next, tickTransition);
    }

    if (lockTick.state.clock.epochMs >= fromState.idleDeadlineMs) {
      return this.#lockUnlocked("idle", "tick", lockTick.state.clock.epochMs);
    }

    const next = unlockedState(lockTick.state, this.#idleTimeoutMs, fromState.lastActivityAtMs);
    const tickTransition = transition("tick", "unlocked", "unlocked");

    this.#state = next;

    return actionAccept(next, tickTransition);
  }

  #lockUnlocked(
    reason: SessionLockReason,
    action: "lock" | "tick",
    lockNow?: number,
  ): SessionViewModelActionResult {
    if (this.#state.kind !== "unlocked") {
      return actionReject(invalidTransition(action, this.#state.kind), this.#state);
    }

    this.#authEpoch += 1;

    const lockAtMs = lockNow ?? this.#state.lock.clock.epochMs;
    const nextUser = this.#state.user;
    this.#lockModel = this.#createLockModel(nextUser, lockAtMs);

    const next = lockedState(this.#lockModel.snapshot(), reason);
    const lockTransition = transition(action, "unlocked", "locked", reason);

    this.#state = next;

    return actionAccept(next, lockTransition);
  }

  #createLockModel(user: LockUser | undefined, initialNow: Date | number | undefined): LockViewModel {
    const options: {
      auth?: LockAuthPort;
      initialNow?: Date | number;
      maxAttempts?: number;
      user?: LockUser;
    } = {};

    if (this.#auth !== undefined) options.auth = this.#auth;
    if (initialNow !== undefined) options.initialNow = initialNow;
    if (this.#maxAttempts !== undefined) options.maxAttempts = this.#maxAttempts;
    if (user !== undefined) options.user = user;

    return createLockViewModel(Object.freeze(options));
  }
}

function coldBootState(): SessionColdBootState {
  return Object.freeze({
    kind: "cold-boot",
  });
}

function lockedState(lock: LockViewModelState, reason: SessionLockedReason): SessionLockedState {
  return Object.freeze({
    kind: "locked",
    reason,
    lock,
  });
}

function authenticatingState(
  lock: LockViewModelState,
  startedAtMs: number,
): SessionAuthenticatingState {
  return Object.freeze({
    kind: "authenticating",
    startedAtMs,
    lock,
  });
}

function unlockedState(
  lock: LockViewModelState,
  idleTimeoutMs: number,
  lastActivityAtMs: number,
): SessionUnlockedState {
  return Object.freeze({
    kind: "unlocked",
    user: lock.user,
    lock,
    unlockedAtMs: lastActivityAtMs,
    lastActivityAtMs,
    idleTimeoutMs,
    idleDeadlineMs: lastActivityAtMs + idleTimeoutMs,
  });
}

function shutdownState(
  reason: SessionShutdownReason,
  requestedAtMs: number,
  previousKind: SessionStateKind,
): SessionShutdownState {
  return Object.freeze({
    kind: "shutdown",
    reason,
    requestedAtMs,
    previousKind,
  });
}

function transition(
  action: SessionTransitionAction,
  from: SessionStateKind,
  to: SessionStateKind,
  reason?: SessionTransitionReason,
): SessionTransition {
  const output: {
    action: SessionTransitionAction;
    from: SessionStateKind;
    to: SessionStateKind;
    reason?: SessionTransitionReason;
  } = {
    action,
    from,
    to,
  };

  if (reason !== undefined) output.reason = reason;

  return Object.freeze(output);
}

function actionAccept(
  state: SessionState,
  transitionValue: SessionTransition,
): SessionViewModelActionResult {
  return Object.freeze({
    ok: true,
    state,
    transition: transitionValue,
  });
}

function actionReject(
  errorValue: SessionViewModelError,
  state: SessionState,
  transitionValue?: SessionTransition,
): SessionViewModelActionResult {
  const output: {
    ok: false;
    state: SessionState;
    transition?: SessionTransition;
    error: SessionViewModelError;
  } = {
    ok: false,
    state,
    error: errorValue,
  };

  if (transitionValue !== undefined) output.transition = transitionValue;

  return Object.freeze(output);
}

function normalizeIdleTimeout(input: number | undefined): number {
  if (input === undefined) return DEFAULT_IDLE_TIMEOUT_MS;
  if (!Number.isInteger(input) || input <= 0 || !Number.isFinite(input)) {
    return DEFAULT_IDLE_TIMEOUT_MS;
  }

  return input;
}

function normalizeLockReason(input: unknown): NormalizeResult<SessionLockReason> {
  if (input === "manual" || input === "idle") {
    return accept(input);
  }

  return reject(error(
    "INVALID_LOCK_REASON",
    "lock reason must be manual or idle.",
    "/reason",
  ));
}

function normalizeShutdownReason(input: unknown): NormalizeResult<SessionShutdownReason> {
  if (input === "logout" || input === "shutdown") {
    return accept(input);
  }

  return reject(error(
    "INVALID_SHUTDOWN_REASON",
    "shutdown reason must be logout or shutdown.",
    "/reason",
  ));
}

function stateEpochMs(state: SessionState): number {
  switch (state.kind) {
    case "cold-boot":
      return 0;
    case "locked":
    case "authenticating":
    case "unlocked":
      return state.lock.clock.epochMs;
    case "shutdown":
      return state.requestedAtMs;
  }
}

function fromLockError(errorValue: LockViewModelError): SessionViewModelError {
  return error(errorValue.code, errorValue.message, errorValue.path);
}

function invalidTransition(
  action: SessionTransitionAction,
  from: SessionStateKind,
): SessionViewModelError {
  return error(
    "INVALID_TRANSITION",
    `cannot ${action} from ${from}.`,
    "/kind",
  );
}

function cancelledAuthentication(): SessionViewModelError {
  return error(
    "AUTHENTICATION_CANCELLED",
    "session authentication was cancelled.",
    "/kind",
  );
}

function error(
  code: SessionViewModelErrorCode,
  message: string,
  path: string,
): SessionViewModelError {
  return Object.freeze({
    code,
    message,
    path,
  });
}

function accept<T>(value: T): NormalizeResult<T> {
  return Object.freeze({
    ok: true,
    value,
  });
}

function reject<T>(errorValue: SessionViewModelError): NormalizeResult<T> {
  return Object.freeze({
    error: errorValue,
    ok: false,
  });
}
