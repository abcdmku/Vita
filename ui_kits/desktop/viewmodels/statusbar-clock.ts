import type {
  DesktopHostError,
} from "../../../sdk/typescript/src/desktop-sdk/index.ts";
import {
  formatLockClockDisplay,
} from "./Lock.ts";
import type {
  LockClockDisplay,
} from "./Lock.ts";

export type StatusbarClockErrorCode = "INVALID_TIME";

export type StatusbarClockDisplay = LockClockDisplay;

export interface StatusbarClockError extends DesktopHostError {
  readonly code: StatusbarClockErrorCode;
}

export interface StatusbarClockViewModelOptions {
  readonly initialNow?: Date | number;
}

export type StatusbarClockTickResult =
  | StatusbarClockDisplay
  | StatusbarClockTickRejected;

export interface StatusbarClockTickRejected {
  readonly ok: false;
  readonly error: StatusbarClockError;
  readonly display: StatusbarClockDisplay;
}

export interface StatusbarClockViewModel {
  snapshot(): StatusbarClockDisplay;
  tick(now: unknown): StatusbarClockTickResult;
}

type NormalizeResult<T> =
  | {
      readonly ok: true;
      readonly value: T;
    }
  | {
      readonly ok: false;
      readonly error: StatusbarClockError;
    };

const DEFAULT_STATUSBAR_NOW_MS = 0;

export function createStatusbarClockViewModel(
  options: StatusbarClockViewModelOptions = Object.freeze({}),
): StatusbarClockViewModel {
  return new DesktopStatusbarClockViewModel(options);
}

class DesktopStatusbarClockViewModel implements StatusbarClockViewModel {
  #display: StatusbarClockDisplay;

  constructor(options: StatusbarClockViewModelOptions) {
    this.#display = formatLockClockDisplay(normalizeInitialNow(options.initialNow));
  }

  snapshot(): StatusbarClockDisplay {
    return this.#display;
  }

  tick(now: unknown): StatusbarClockTickResult {
    const normalized = normalizeInstant(now);

    if (!normalized.ok) {
      return actionReject(normalized.error, this.#display);
    }

    this.#display = formatLockClockDisplay(normalized.value);
    return this.#display;
  }
}

function normalizeInstant(input: unknown): NormalizeResult<number> {
  if (typeof input === "number") {
    return Number.isFinite(input)
      ? accept(input)
      : reject(error("INVALID_TIME", "statusbar clock tick requires a finite timestamp.", "/statusbar/time"));
  }

  try {
    if (Object.getPrototypeOf(input) !== Date.prototype) {
      return reject(error(
        "INVALID_TIME",
        "statusbar clock tick requires a Date or finite timestamp.",
        "/statusbar/time",
      ));
    }

    const epochMs = Date.prototype.getTime.call(input);

    return Number.isFinite(epochMs)
      ? accept(epochMs)
      : reject(error("INVALID_TIME", "statusbar clock tick requires a valid Date.", "/statusbar/time"));
  } catch {
    return reject(error(
      "INVALID_TIME",
      "statusbar clock tick requires a stable Date or timestamp.",
      "/statusbar/time",
    ));
  }
}

function normalizeInitialNow(input: Date | number | undefined): number {
  if (input === undefined) return DEFAULT_STATUSBAR_NOW_MS;

  const normalized = normalizeInstant(input);

  return normalized.ok ? normalized.value : DEFAULT_STATUSBAR_NOW_MS;
}

function error(
  code: StatusbarClockErrorCode,
  message: string,
  path: string,
): StatusbarClockError {
  return Object.freeze({
    code,
    message,
    path,
  });
}

function actionReject(
  errorValue: StatusbarClockError,
  display: StatusbarClockDisplay,
): StatusbarClockTickRejected {
  return Object.freeze({
    display,
    error: errorValue,
    ok: false,
  });
}

function accept<T>(value: T): NormalizeResult<T> {
  return Object.freeze({
    ok: true,
    value,
  });
}

function reject<T>(errorValue: StatusbarClockError): NormalizeResult<T> {
  return Object.freeze({
    error: errorValue,
    ok: false,
  });
}
