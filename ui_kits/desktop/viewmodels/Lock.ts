import type {
  DesktopHostError,
  DesktopHostResult,
  DesktopMaybePromise,
} from "../../../sdk/typescript/src/desktop-sdk/index.ts";

export type LockStateKind = "locked" | "authenticating" | "unlocked";

export type LockViewModelErrorCode =
  | "ALREADY_UNLOCKED"
  | "AUTH_PORT_FAILED"
  | "AUTH_PORT_MALFORMED"
  | "AUTH_PORT_UNAVAILABLE"
  | "AUTHENTICATION_CANCELLED"
  | "AUTHENTICATION_IN_PROGRESS"
  | "AUTHENTICATION_REJECTED"
  | "INVALID_CREDENTIAL"
  | "INVALID_TIME"
  | "RATE_LIMITED";

export interface LockUser {
  readonly id: string;
  readonly displayName: string;
  readonly initials: string;
}

export interface LockClockDisplay {
  readonly date: string;
  readonly time: string;
  readonly epochMs: number;
  readonly iso: string;
}

export interface LockViewModelError extends DesktopHostError {
  readonly code: LockViewModelErrorCode;
}

export interface LockViewModelState {
  readonly lockState: LockStateKind;
  readonly user: LockUser;
  readonly clock: LockClockDisplay;
  readonly attemptCount: number;
  readonly maxAttempts: number;
  readonly remainingAttempts: number;
  readonly canSubmit: boolean;
  readonly error?: LockViewModelError;
}

export interface LockAuthSession {
  readonly user: LockUser;
  readonly authenticatedAtMs?: number;
  readonly sessionId?: string;
}

export type LockAuthResult = DesktopHostResult<LockAuthSession>;

export interface LockAuthenticateRequest {
  readonly credential: string;
  readonly userId: string;
  readonly attemptNumber: number;
}

export interface LockAuthPort {
  authenticate(request: LockAuthenticateRequest): DesktopMaybePromise<unknown>;
}

export interface LockViewModelOptions {
  readonly auth?: LockAuthPort;
  readonly initialNow?: Date | number;
  readonly maxAttempts?: number;
  readonly user?: LockUser;
}

export type LockViewModelActionResult =
  | {
      readonly ok: true;
      readonly state: LockViewModelState;
    }
  | {
      readonly ok: false;
      readonly error: LockViewModelError;
      readonly state: LockViewModelState;
    };

export interface LockViewModel {
  readonly state: LockViewModelState;
  snapshot(): LockViewModelState;
  submit(credential: unknown): Promise<LockViewModelActionResult>;
  cancel(): LockViewModelActionResult;
  tick(now: unknown): LockViewModelActionResult;
}

type NormalizeResult<T> =
  | {
      readonly ok: true;
      readonly value: T;
    }
  | {
      readonly ok: false;
      readonly error: LockViewModelError;
    };

interface LockStateInput {
  readonly lockState: LockStateKind;
  readonly user: LockUser;
  readonly clock: LockClockDisplay;
  readonly attemptCount: number;
  readonly maxAttempts: number;
  readonly error?: LockViewModelError;
}

const DEFAULT_LOCK_NOW_MS = Date.UTC(2024, 5, 25, 10, 24, 0);
const DEFAULT_MAX_ATTEMPTS = 5;

const DEFAULT_LOCK_USER = Object.freeze({
  displayName: "Vita User",
  id: "vita-user",
  initials: "V",
}) satisfies LockUser;

const RESULT_FIELDS = Object.freeze(["error", "ok", "value"] as const);
const ERROR_FIELDS = Object.freeze(["code", "message", "path"] as const);
const SESSION_FIELDS = Object.freeze(["authenticatedAtMs", "sessionId", "user"] as const);
const USER_FIELDS = Object.freeze(["displayName", "id", "initials"] as const);

const WEEKDAYS = Object.freeze([
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
] as const);

const MONTHS = Object.freeze([
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
] as const);

export function createLockViewModel(
  options: LockViewModelOptions = Object.freeze({}),
): LockViewModel {
  return new DesktopLockViewModel(options);
}

class DesktopLockViewModel implements LockViewModel {
  readonly #auth: LockAuthPort | undefined;
  readonly #maxAttempts: number;
  #authEpoch = 0;
  #state: LockViewModelState;

  constructor(options: LockViewModelOptions) {
    this.#auth = options.auth;
    this.#maxAttempts = normalizeMaxAttempts(options.maxAttempts);
    this.#state = freezeState({
      attemptCount: 0,
      clock: clockDisplay(normalizeInitialNow(options.initialNow)),
      lockState: "locked",
      maxAttempts: this.#maxAttempts,
      user: freezeUser(options.user ?? DEFAULT_LOCK_USER),
    });
  }

  get state(): LockViewModelState {
    return this.#state;
  }

  snapshot(): LockViewModelState {
    return this.#state;
  }

  async submit(credential: unknown): Promise<LockViewModelActionResult> {
    if (this.#state.lockState === "unlocked") {
      return this.#reject(error("ALREADY_UNLOCKED", "lock screen is already unlocked.", "/lockState"));
    }
    if (this.#state.lockState === "authenticating") {
      return this.#reject(error(
        "AUTHENTICATION_IN_PROGRESS",
        "authentication is already in progress.",
        "/lockState",
      ));
    }
    if (this.#state.attemptCount >= this.#maxAttempts) {
      return this.#failWithoutAttempt(rateLimitedError());
    }

    const normalizedCredential = normalizeCredential(credential);

    if (!normalizedCredential.ok) {
      return this.#recordFailedAttempt(normalizedCredential.error);
    }

    const auth = this.#auth;

    if (auth === undefined) {
      return this.#failWithoutAttempt(error(
        "AUTH_PORT_UNAVAILABLE",
        "auth port is unavailable.",
        "/auth",
      ));
    }

    const epoch = this.#beginAuthentication();
    const request = Object.freeze({
      attemptNumber: this.#state.attemptCount + 1,
      credential: normalizedCredential.value,
      userId: this.#state.user.id,
    }) satisfies LockAuthenticateRequest;

    let authResult: unknown;

    try {
      authResult = await auth.authenticate(request);
    } catch {
      return this.#completeFailedAuthentication(epoch, error(
        "AUTH_PORT_FAILED",
        "auth port failed closed.",
        "/auth",
      ));
    }

    if (!this.#isCurrentAuthentication(epoch)) {
      return actionReject(error(
        "AUTHENTICATION_CANCELLED",
        "authentication was cancelled.",
        "/lockState",
      ), this.#state);
    }

    const normalizedResult = normalizeAuthResult(authResult);

    if (!normalizedResult.ok) {
      return this.#completeFailedAuthentication(epoch, normalizedResult.error);
    }

    this.#state = freezeState({
      attemptCount: this.#state.attemptCount,
      clock: this.#state.clock,
      lockState: "unlocked",
      maxAttempts: this.#maxAttempts,
      user: normalizedResult.value.user,
    });

    return actionAccept(this.#state);
  }

  cancel(): LockViewModelActionResult {
    this.#authEpoch += 1;

    if (this.#state.lockState === "unlocked") {
      return actionAccept(this.#state);
    }

    const input: LockStateInput = {
      attemptCount: this.#state.attemptCount,
      clock: this.#state.clock,
      lockState: "locked",
      maxAttempts: this.#maxAttempts,
      user: this.#state.user,
    };

    if (this.#state.attemptCount >= this.#maxAttempts) {
      this.#state = freezeState({
        ...input,
        error: rateLimitedError(),
      });
    } else {
      this.#state = freezeState(input);
    }

    return actionAccept(this.#state);
  }

  tick(now: unknown): LockViewModelActionResult {
    const normalized = normalizeInstant(now);

    if (!normalized.ok) {
      return this.#reject(normalized.error);
    }

    const input: LockStateInput = {
      attemptCount: this.#state.attemptCount,
      clock: clockDisplay(normalized.value),
      lockState: this.#state.lockState,
      maxAttempts: this.#maxAttempts,
      user: this.#state.user,
    };

    if (this.#state.error !== undefined) {
      this.#state = freezeState({
        ...input,
        error: this.#state.error,
      });
    } else {
      this.#state = freezeState(input);
    }

    return actionAccept(this.#state);
  }

  #beginAuthentication(): number {
    this.#authEpoch += 1;
    this.#state = freezeState({
      attemptCount: this.#state.attemptCount,
      clock: this.#state.clock,
      lockState: "authenticating",
      maxAttempts: this.#maxAttempts,
      user: this.#state.user,
    });

    return this.#authEpoch;
  }

  #isCurrentAuthentication(epoch: number): boolean {
    return epoch === this.#authEpoch && this.#state.lockState === "authenticating";
  }

  #completeFailedAuthentication(
    epoch: number,
    errorValue: LockViewModelError,
  ): LockViewModelActionResult {
    if (!this.#isCurrentAuthentication(epoch)) {
      return actionReject(error(
        "AUTHENTICATION_CANCELLED",
        "authentication was cancelled.",
        "/lockState",
      ), this.#state);
    }

    return this.#recordFailedAttempt(errorValue);
  }

  #recordFailedAttempt(errorValue: LockViewModelError): LockViewModelActionResult {
    const attemptCount = Math.min(this.#state.attemptCount + 1, this.#maxAttempts);

    this.#state = freezeState({
      attemptCount,
      clock: this.#state.clock,
      error: errorValue,
      lockState: "locked",
      maxAttempts: this.#maxAttempts,
      user: this.#state.user,
    });

    return actionReject(errorValue, this.#state);
  }

  #failWithoutAttempt(errorValue: LockViewModelError): LockViewModelActionResult {
    this.#state = freezeState({
      attemptCount: this.#state.attemptCount,
      clock: this.#state.clock,
      error: errorValue,
      lockState: "locked",
      maxAttempts: this.#maxAttempts,
      user: this.#state.user,
    });

    return actionReject(errorValue, this.#state);
  }

  #reject(errorValue: LockViewModelError): LockViewModelActionResult {
    return actionReject(errorValue, this.#state);
  }
}

function normalizeCredential(input: unknown): NormalizeResult<string> {
  if (typeof input !== "string" || input.length === 0) {
    return reject(error(
      "INVALID_CREDENTIAL",
      "credential must be a non-empty string.",
      "/credential",
    ));
  }

  return accept(input);
}

function normalizeAuthResult(input: unknown): NormalizeResult<LockAuthSession> {
  const result = snapshotObject(input, RESULT_FIELDS, "/auth/result", "AUTH_PORT_MALFORMED");

  if (!result.ok) return result;

  const ok = result.value.get("ok");

  if (ok === true) {
    if (result.value.has("error")) {
      return reject(malformedAuthResult());
    }

    return normalizeAuthSession(result.value.get("value"));
  }

  if (ok === false) {
    if (result.value.has("value") || !normalizePortError(result.value.get("error"))) {
      return reject(malformedAuthResult());
    }

    return reject(error(
      "AUTHENTICATION_REJECTED",
      "credential was not accepted.",
      "/credential",
    ));
  }

  return reject(malformedAuthResult());
}

function normalizeAuthSession(input: unknown): NormalizeResult<LockAuthSession> {
  const session = snapshotObject(input, SESSION_FIELDS, "/auth/result/value", "AUTH_PORT_MALFORMED");

  if (!session.ok) return session;

  const user = normalizeUser(session.value.get("user"));

  if (!user.ok) return user;

  const sessionId = session.value.get("sessionId");
  const authenticatedAtMs = session.value.get("authenticatedAtMs");
  const output: {
    user: LockUser;
    authenticatedAtMs?: number;
    sessionId?: string;
  } = {
    user: user.value,
  };

  if (sessionId !== undefined) {
    if (typeof sessionId !== "string" || sessionId.length === 0) {
      return reject(malformedAuthResult());
    }
    output.sessionId = sessionId;
  }

  if (authenticatedAtMs !== undefined) {
    if (typeof authenticatedAtMs !== "number" || !Number.isFinite(authenticatedAtMs)) {
      return reject(malformedAuthResult());
    }
    output.authenticatedAtMs = authenticatedAtMs;
  }

  return accept(Object.freeze(output));
}

function normalizeUser(input: unknown): NormalizeResult<LockUser> {
  const user = snapshotObject(input, USER_FIELDS, "/auth/result/value/user", "AUTH_PORT_MALFORMED");

  if (!user.ok) return user;

  const id = user.value.get("id");
  const displayName = user.value.get("displayName");
  const initials = user.value.get("initials");

  if (
    typeof id !== "string" ||
    id.length === 0 ||
    typeof displayName !== "string" ||
    displayName.length === 0 ||
    typeof initials !== "string" ||
    initials.length === 0
  ) {
    return reject(malformedAuthResult());
  }

  return accept(Object.freeze({
    displayName,
    id,
    initials,
  }));
}

function normalizePortError(input: unknown): boolean {
  const portError = snapshotObject(input, ERROR_FIELDS, "/auth/result/error", "AUTH_PORT_MALFORMED");

  if (!portError.ok) return false;

  return (
    typeof portError.value.get("code") === "string" &&
    typeof portError.value.get("message") === "string" &&
    typeof portError.value.get("path") === "string"
  );
}

function snapshotObject(
  input: unknown,
  allowedKeys: readonly string[],
  path: string,
  code: LockViewModelErrorCode,
): NormalizeResult<ReadonlyMap<string, unknown>> {
  try {
    if (input === null || typeof input !== "object" || Array.isArray(input)) {
      return reject(error(code, "value must be a plain object.", path));
    }

    const prototype = Object.getPrototypeOf(input);

    if (prototype !== Object.prototype && prototype !== null) {
      return reject(error(code, "value must be a plain object.", path));
    }

    const keys = Reflect.ownKeys(input);
    const output = new Map<string, unknown>();

    for (let index = 0; index < keys.length; index += 1) {
      const key = keys[index];

      if (key === undefined || typeof key === "symbol" || !contains(allowedKeys, key)) {
        return reject(error(code, "object contains an unsupported field.", path));
      }

      const descriptor = Object.getOwnPropertyDescriptor(input, key);

      if (descriptor === undefined || !isDataDescriptor(descriptor) || descriptor.enumerable !== true) {
        return reject(error(code, "object must contain only enumerable data fields.", path));
      }

      output.set(key, descriptor.value);
    }

    return accept(output);
  } catch {
    return reject(error(code, "value must be a stable plain object.", path));
  }
}

function normalizeInstant(input: unknown): NormalizeResult<number> {
  if (typeof input === "number") {
    return Number.isFinite(input)
      ? accept(input)
      : reject(error("INVALID_TIME", "clock tick requires a finite timestamp.", "/clock"));
  }

  try {
    if (Object.getPrototypeOf(input) !== Date.prototype) {
      return reject(error("INVALID_TIME", "clock tick requires a Date or finite timestamp.", "/clock"));
    }

    const epochMs = Date.prototype.getTime.call(input);

    return Number.isFinite(epochMs)
      ? accept(epochMs)
      : reject(error("INVALID_TIME", "clock tick requires a valid Date.", "/clock"));
  } catch {
    return reject(error("INVALID_TIME", "clock tick requires a stable Date or timestamp.", "/clock"));
  }
}

function normalizeInitialNow(input: Date | number | undefined): number {
  if (input === undefined) return DEFAULT_LOCK_NOW_MS;

  const normalized = normalizeInstant(input);

  return normalized.ok ? normalized.value : DEFAULT_LOCK_NOW_MS;
}

function normalizeMaxAttempts(input: number | undefined): number {
  if (input === undefined) return DEFAULT_MAX_ATTEMPTS;
  if (!Number.isInteger(input) || input <= 0) return DEFAULT_MAX_ATTEMPTS;

  return input;
}

function freezeState(input: LockStateInput): LockViewModelState {
  const remainingAttempts = Math.max(0, input.maxAttempts - input.attemptCount);
  const output: {
    lockState: LockStateKind;
    user: LockUser;
    clock: LockClockDisplay;
    attemptCount: number;
    maxAttempts: number;
    remainingAttempts: number;
    canSubmit: boolean;
    error?: LockViewModelError;
  } = {
    attemptCount: input.attemptCount,
    canSubmit: input.lockState === "locked" && remainingAttempts > 0,
    clock: input.clock,
    lockState: input.lockState,
    maxAttempts: input.maxAttempts,
    remainingAttempts,
    user: input.user,
  };

  if (input.error !== undefined) {
    output.error = input.error;
  }

  return Object.freeze(output);
}

function freezeUser(user: LockUser): LockUser {
  if (user.id.length === 0 || user.displayName.length === 0 || user.initials.length === 0) {
    return DEFAULT_LOCK_USER;
  }

  return Object.freeze({
    displayName: user.displayName,
    id: user.id,
    initials: user.initials,
  });
}

export function formatLockClockDisplay(epochMs: number): LockClockDisplay {
  const date = new Date(epochMs);
  const weekday = WEEKDAYS[date.getUTCDay()] ?? "Sunday";
  const month = MONTHS[date.getUTCMonth()] ?? "January";
  const day = date.getUTCDate();
  const hours = `${date.getUTCHours()}`.padStart(2, "0");
  const minutes = `${date.getUTCMinutes()}`.padStart(2, "0");

  return Object.freeze({
    date: `${weekday}, ${month} ${day}`,
    epochMs,
    iso: date.toISOString(),
    time: `${hours}:${minutes}`,
  });
}

const clockDisplay = formatLockClockDisplay;

function contains(values: readonly string[], value: string): boolean {
  for (let index = 0; index < values.length; index += 1) {
    if (values[index] === value) return true;
  }

  return false;
}

function isDataDescriptor(descriptor: PropertyDescriptor): descriptor is PropertyDescriptor & {
  readonly value: unknown;
} {
  return Object.prototype.hasOwnProperty.call(descriptor, "value");
}

function malformedAuthResult(): LockViewModelError {
  return error(
    "AUTH_PORT_MALFORMED",
    "auth port returned malformed authentication result.",
    "/auth/result",
  );
}

function rateLimitedError(): LockViewModelError {
  return error("RATE_LIMITED", "too many failed unlock attempts.", "/attempts");
}

function error(
  code: LockViewModelErrorCode,
  message: string,
  path: string,
): LockViewModelError {
  return Object.freeze({
    code,
    message,
    path,
  });
}

function actionAccept(state: LockViewModelState): LockViewModelActionResult {
  return Object.freeze({
    ok: true,
    state,
  });
}

function actionReject(
  errorValue: LockViewModelError,
  state: LockViewModelState,
): LockViewModelActionResult {
  return Object.freeze({
    error: errorValue,
    ok: false,
    state,
  });
}

function accept<T>(value: T): NormalizeResult<T> {
  return Object.freeze({
    ok: true,
    value,
  });
}

function reject<T>(errorValue: LockViewModelError): NormalizeResult<T> {
  return Object.freeze({
    error: errorValue,
    ok: false,
  });
}
