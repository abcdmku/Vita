import type {
  DesktopHostError,
  DesktopUiInstance,
} from "../../../sdk/typescript/src/desktop-sdk/index.ts";
import type {
  SessionLockReason,
  SessionState,
  SessionStateKind,
  SessionTransition,
  SessionViewModelActionResult,
} from "./session.ts";

export type IdleLockAction = "activity" | "tick" | "lockCommand" | "dispose";

export type IdleLockErrorCode =
  | "HOST_UNMOUNT_FAILED"
  | "INVALID_TIME"
  | "SESSION_LOCK_FAILED"
  | "SESSION_LOCK_PORT_FAILED"
  | "TIME_REGRESSED";

export interface IdleLockState {
  readonly lastActivityMs: number;
  readonly idleBudgetMs: number;
  readonly remainingMs: number;
  readonly armed: boolean;
}

export interface IdleLockTransition {
  readonly action: IdleLockAction;
  readonly from: SessionStateKind;
  readonly to: SessionStateKind;
  readonly reason?: SessionLockReason | "activity" | "dispose";
}

export interface IdleLockError extends DesktopHostError {
  readonly code: IdleLockErrorCode;
}

export type IdleLockActionResult =
  | {
      readonly ok: true;
      readonly state: IdleLockState;
      readonly transition?: IdleLockTransition;
    }
  | {
      readonly ok: false;
      readonly state: IdleLockState;
      readonly transition?: IdleLockTransition;
      readonly error: IdleLockError;
    };

export type IdleLockSessionLockResult =
  | SessionViewModelActionResult
  | {
      readonly ok: true;
      readonly state?: SessionState;
      readonly transition?: SessionTransition;
    }
  | {
      readonly ok: false;
      readonly state?: SessionState;
      readonly transition?: SessionTransition;
      readonly error?: DesktopHostError;
    };

export interface IdleLockSessionPort {
  readonly kind?: SessionStateKind;
  readonly state?: {
    readonly kind: SessionStateKind;
  };
  snapshot?(): {
    readonly kind: SessionStateKind;
  };
  lock(reason: SessionLockReason): IdleLockSessionLockResult;
}

export type IdleLockHostPort = Pick<DesktopUiInstance, "unmount">;

export interface IdleLockViewModelOptions {
  readonly session: IdleLockSessionPort;
  readonly host: IdleLockHostPort;
  readonly idleBudgetMs: number;
}

export interface IdleLockViewModel {
  readonly state: IdleLockState;
  snapshot(): IdleLockState;
  activity(now: unknown): IdleLockActionResult;
  tick(now: unknown): IdleLockActionResult;
  lockCommand(): IdleLockActionResult;
  dispose(): IdleLockActionResult;
}

type TimeNormalizeResult =
  | {
      readonly ok: true;
      readonly value: number;
    }
  | {
      readonly ok: false;
      readonly error: IdleLockError;
    };

export function createIdleLockViewModel(options: IdleLockViewModelOptions): IdleLockViewModel {
  return new DesktopIdleLockViewModel(options);
}

class DesktopIdleLockViewModel implements IdleLockViewModel {
  readonly #host: IdleLockHostPort;
  readonly #session: IdleLockSessionPort;
  readonly #idleBudgetMs: number;
  #ended = false;
  #lastActivityMs = 0;
  #remainingMs: number;
  #state: IdleLockState;

  constructor(options: IdleLockViewModelOptions) {
    this.#host = options.host;
    this.#session = options.session;
    this.#idleBudgetMs = normalizeIdleBudget(options.idleBudgetMs);
    this.#remainingMs = this.#idleBudgetMs;
    this.#state = this.#stateFor(this.#lastActivityMs, this.#remainingMs, this.#isUnlocked());
  }

  get state(): IdleLockState {
    return this.#state;
  }

  snapshot(): IdleLockState {
    return this.#state;
  }

  activity(now: unknown): IdleLockActionResult {
    const normalized = normalizeNow(now);

    if (!normalized.ok) {
      return reject(normalized.error, this.#state);
    }

    if (normalized.value < this.#lastActivityMs) {
      return reject(timeRegressed(), this.#state);
    }

    const from = this.#sessionKind();

    if (this.#ended || from !== "unlocked") {
      this.#state = this.#stateFor(this.#lastActivityMs, this.#remainingMs, false);
      return accept(this.#state);
    }

    this.#lastActivityMs = normalized.value;
    this.#remainingMs = this.#idleBudgetMs;
    this.#state = this.#stateFor(this.#lastActivityMs, this.#remainingMs, true);

    return accept(this.#state, transition("activity", from, from, "activity"));
  }

  tick(now: unknown): IdleLockActionResult {
    const normalized = normalizeNow(now);

    if (!normalized.ok) {
      return reject(normalized.error, this.#state);
    }

    if (normalized.value < this.#lastActivityMs) {
      return reject(timeRegressed(), this.#state);
    }

    const from = this.#sessionKind();

    if (this.#ended || from !== "unlocked") {
      this.#state = this.#stateFor(this.#lastActivityMs, this.#remainingMs, false);
      return accept(this.#state);
    }

    const elapsedMs = normalized.value - this.#lastActivityMs;

    if (elapsedMs < this.#idleBudgetMs) {
      this.#remainingMs = this.#idleBudgetMs - elapsedMs;
      this.#state = this.#stateFor(this.#lastActivityMs, this.#remainingMs, true);

      return accept(this.#state);
    }

    return this.#lockAndUnmount("idle", "tick", from);
  }

  lockCommand(): IdleLockActionResult {
    const from = this.#sessionKind();

    if (this.#ended || from !== "unlocked") {
      this.#state = this.#stateFor(this.#lastActivityMs, this.#remainingMs, false);
      return accept(this.#state);
    }

    return this.#lockAndUnmount("manual", "lockCommand", from);
  }

  dispose(): IdleLockActionResult {
    const from = this.#sessionKind();

    if (this.#ended) {
      this.#state = this.#stateFor(this.#lastActivityMs, this.#remainingMs, false);
      return accept(this.#state);
    }

    const teardown = this.#unmountOnce();
    this.#state = this.#stateFor(this.#lastActivityMs, this.#remainingMs, false);

    if (!teardown.ok) {
      return reject(teardown.error, this.#state, transition("dispose", from, from, "dispose"));
    }

    return accept(this.#state, transition("dispose", from, from, "dispose"));
  }

  #lockAndUnmount(
    reason: SessionLockReason,
    action: "lockCommand" | "tick",
    from: SessionStateKind,
  ): IdleLockActionResult {
    let locked: IdleLockSessionLockResult;

    try {
      locked = this.#session.lock(reason);
    } catch {
      return reject(error(
        "SESSION_LOCK_PORT_FAILED",
        "session lock port failed closed.",
        "/session/lock",
      ), this.#state);
    }

    if (!locked.ok) {
      return reject(sessionLockFailed(locked.error), this.#state);
    }

    const teardown = this.#unmountOnce();
    const to = this.#sessionKind();

    this.#state = this.#stateFor(this.#lastActivityMs, 0, false);

    const transitionValue = transition(action, from, to, reason);

    if (!teardown.ok) {
      return reject(teardown.error, this.#state, transitionValue);
    }

    return accept(this.#state, transitionValue);
  }

  #unmountOnce(): TimeNormalizeResult {
    if (this.#ended) {
      return acceptValue(0);
    }

    this.#ended = true;

    try {
      void this.#host.unmount();
    } catch {
      return rejectValue(error(
        "HOST_UNMOUNT_FAILED",
        "desktop surface unmount failed closed.",
        "/host/unmount",
      ));
    }

    return acceptValue(0);
  }

  #isUnlocked(): boolean {
    return !this.#ended && this.#sessionKind() === "unlocked";
  }

  #sessionKind(): SessionStateKind {
    try {
      const directKind = this.#session.kind;

      if (directKind !== undefined) {
        return directKind;
      }

      const stateKind = this.#session.state?.kind;

      if (stateKind !== undefined) {
        return stateKind;
      }

      const snapshot = this.#session.snapshot?.();

      if (snapshot !== undefined) {
        return snapshot.kind;
      }
    } catch {
      return "shutdown";
    }

    return "shutdown";
  }

  #stateFor(lastActivityMs: number, remainingMs: number, armed: boolean): IdleLockState {
    return Object.freeze({
      armed,
      idleBudgetMs: this.#idleBudgetMs,
      lastActivityMs,
      remainingMs: armed ? Math.max(0, remainingMs) : 0,
    });
  }
}

function normalizeIdleBudget(input: number): number {
  if (Number.isFinite(input) && input > 0) {
    return input;
  }

  return 1;
}

function normalizeNow(input: unknown): TimeNormalizeResult {
  if (typeof input !== "number" || !Number.isFinite(input) || input < 0) {
    return rejectValue(error(
      "INVALID_TIME",
      "idle lock time must be a finite non-negative epoch millisecond value.",
      "/now",
    ));
  }

  return acceptValue(input);
}

function sessionLockFailed(input: DesktopHostError | undefined): IdleLockError {
  if (input === undefined) {
    return error(
      "SESSION_LOCK_FAILED",
      "session lock failed closed.",
      "/session/lock",
    );
  }

  return error(
    "SESSION_LOCK_FAILED",
    input.message,
    input.path,
  );
}

function timeRegressed(): IdleLockError {
  return error(
    "TIME_REGRESSED",
    "idle lock time must not move backwards.",
    "/now",
  );
}

function transition(
  action: IdleLockAction,
  from: SessionStateKind,
  to: SessionStateKind,
  reason?: SessionLockReason | "activity" | "dispose",
): IdleLockTransition {
  const output: {
    action: IdleLockAction;
    from: SessionStateKind;
    to: SessionStateKind;
    reason?: SessionLockReason | "activity" | "dispose";
  } = {
    action,
    from,
    to,
  };

  if (reason !== undefined) output.reason = reason;

  return Object.freeze(output);
}

function accept(
  state: IdleLockState,
  transitionValue?: IdleLockTransition,
): IdleLockActionResult {
  const output: {
    ok: true;
    state: IdleLockState;
    transition?: IdleLockTransition;
  } = {
    ok: true,
    state,
  };

  if (transitionValue !== undefined) output.transition = transitionValue;

  return Object.freeze(output);
}

function reject(
  errorValue: IdleLockError,
  state: IdleLockState,
  transitionValue?: IdleLockTransition,
): IdleLockActionResult {
  const output: {
    ok: false;
    state: IdleLockState;
    transition?: IdleLockTransition;
    error: IdleLockError;
  } = {
    error: errorValue,
    ok: false,
    state,
  };

  if (transitionValue !== undefined) output.transition = transitionValue;

  return Object.freeze(output);
}

function error(code: IdleLockErrorCode, message: string, path: string): IdleLockError {
  return Object.freeze({
    code,
    message,
    path,
  });
}

function acceptValue(value: number): TimeNormalizeResult {
  return Object.freeze({
    ok: true,
    value,
  });
}

function rejectValue(errorValue: IdleLockError): TimeNormalizeResult {
  return Object.freeze({
    error: errorValue,
    ok: false,
  });
}
