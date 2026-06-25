export interface FocusTrapOptions {
  readonly ids?: readonly string[];
  readonly initialId?: string;
}

export type FocusTrapSetOptions = Omit<FocusTrapOptions, "ids">;

export interface FocusTrapActivateOptions {
  readonly currentFocusId?: string;
  readonly initialId?: string;
  readonly restoreId?: string;
}

export interface FocusTrapState {
  readonly active: boolean;
  readonly focusedId: string | null;
  readonly ids: readonly string[];
  readonly restoreId: string | null;
}

export interface FocusTrapViewModel {
  activate(opts?: unknown): FocusTrapState;
  deactivate(): string | null;
  onKey(key: unknown): FocusTrapState;
  snapshot(): FocusTrapState;
}

interface FocusTrapConfig {
  readonly ids: readonly string[];
  readonly initialId?: string;
}

interface FocusTrapActivation {
  readonly focusId: string;
  readonly restoreId: string | null;
}

interface TrapKeyEvent {
  readonly key: "Tab";
  readonly shiftKey: boolean;
}

type NormalizeResult<T> =
  | {
      readonly ok: true;
      readonly value: T;
    }
  | {
      readonly ok: false;
    };

const OPTION_FIELDS = Object.freeze(["ids", "initialId"]);
const SET_OPTION_FIELDS = Object.freeze(["initialId"]);
const ACTIVATE_FIELDS = Object.freeze(["currentFocusId", "initialId", "restoreId"]);
const KEY_EVENT_FIELDS = Object.freeze(["key", "shiftKey"]);

const EMPTY_FOCUS_TRAP_STATE: FocusTrapState = Object.freeze({
  active: false,
  focusedId: null,
  ids: Object.freeze([]),
  restoreId: null,
});

export function createFocusTrapViewModel(options?: FocusTrapOptions): FocusTrapViewModel;
export function createFocusTrapViewModel(ids: readonly string[], options?: FocusTrapSetOptions): FocusTrapViewModel;
export function createFocusTrapViewModel(input?: unknown, options?: unknown): FocusTrapViewModel;
export function createFocusTrapViewModel(
  input: unknown = Object.freeze({}),
  options: unknown = Object.freeze({}),
): FocusTrapViewModel {
  return new DesktopFocusTrapViewModel(input, options);
}

class DesktopFocusTrapViewModel implements FocusTrapViewModel {
  readonly #configuredInitialId: string | null;
  readonly #ids: readonly string[];
  #state: FocusTrapState;

  constructor(input: unknown, options: unknown) {
    const normalized = Array.isArray(input)
      ? normalizeConfigFromParts(input, options)
      : normalizeConfigFromOptions(input);

    if (!normalized.ok) {
      this.#configuredInitialId = null;
      this.#ids = Object.freeze([]);
      this.#state = EMPTY_FOCUS_TRAP_STATE;
      return;
    }

    this.#configuredInitialId = normalized.value.initialId ?? null;
    this.#ids = normalized.value.ids;
    this.#state = stateFor(this.#ids, false, null, null);
  }

  snapshot(): FocusTrapState {
    return this.#state;
  }

  activate(opts: unknown = Object.freeze({})): FocusTrapState {
    const normalized = normalizeActivation(opts, this.#ids, this.#configuredInitialId);

    if (!normalized.ok) {
      return this.#state;
    }

    this.#state = stateFor(this.#ids, true, normalized.value.focusId, normalized.value.restoreId);

    return this.#state;
  }

  deactivate(): string | null {
    const restoreId = this.#state.active ? this.#state.restoreId : null;

    if (this.#state.active) {
      this.#state = stateFor(this.#ids, false, null, null);
    }

    return restoreId;
  }

  onKey(key: unknown): FocusTrapState {
    const normalized = normalizeTrapKeyEvent(key);

    if (!normalized.ok || !this.#state.active || this.#state.ids.length === 0) {
      return this.#state;
    }

    const target = nextIndex(this.#state.ids, this.#state.focusedId, normalized.value.shiftKey ? -1 : 1);

    if (target === null) {
      return this.#state;
    }

    const id = this.#state.ids[target];

    if (id === undefined) {
      return this.#state;
    }

    this.#state = stateFor(this.#ids, true, id, this.#state.restoreId);

    return this.#state;
  }
}

function normalizeConfigFromOptions(input: unknown): NormalizeResult<FocusTrapConfig> {
  const object = snapshotObject(input, OPTION_FIELDS);

  if (!object.ok) {
    return reject();
  }

  return normalizeConfigFields(object.value);
}

function normalizeConfigFromParts(idsInput: unknown, optsInput: unknown): NormalizeResult<FocusTrapConfig> {
  const ids = snapshotStringArray(idsInput);

  if (!ids.ok) {
    return reject();
  }

  const options = snapshotObject(optsInput, SET_OPTION_FIELDS);

  if (!options.ok) {
    return reject();
  }

  const fields = new Map<string, unknown>(options.value);
  fields.set("ids", ids.value);

  return normalizeConfigFields(fields);
}

function normalizeConfigFields(fields: ReadonlyMap<string, unknown>): NormalizeResult<FocusTrapConfig> {
  const idsValue = fields.get("ids");
  const ids = idsValue === undefined ? accept(Object.freeze([]) as readonly string[]) : snapshotStringArray(idsValue);

  if (!ids.ok || hasDuplicate(ids.value)) {
    return reject();
  }

  const initialIdValue = fields.get("initialId");
  let initialId: string | undefined;

  if (initialIdValue !== undefined) {
    const normalizedInitialId = stringId(initialIdValue);

    if (normalizedInitialId === null || !contains(ids.value, normalizedInitialId)) {
      return reject();
    }

    initialId = normalizedInitialId;
  }

  const output: {
    ids: readonly string[];
    initialId?: string;
  } = {
    ids: ids.value,
  };

  if (initialId !== undefined) {
    output.initialId = initialId;
  }

  return accept(Object.freeze(output));
}

function normalizeActivation(
  input: unknown,
  ids: readonly string[],
  configuredInitialId: string | null,
): NormalizeResult<FocusTrapActivation> {
  if (ids.length === 0) {
    return reject();
  }

  const object = snapshotObject(input, ACTIVATE_FIELDS);

  if (!object.ok) {
    return reject();
  }

  const initialIdValue = object.value.get("initialId");
  const initialId = initialIdValue === undefined ? configuredInitialId : stringId(initialIdValue);

  if (initialIdValue !== undefined && (initialId === null || !contains(ids, initialId))) {
    return reject();
  }
  if (initialId !== null && !contains(ids, initialId)) {
    return reject();
  }

  const restoreId = restoreIdForActivation(object.value);

  if (!restoreId.ok) {
    return reject();
  }

  const firstId = ids[0];

  if (firstId === undefined) {
    return reject();
  }

  return accept(Object.freeze({
    focusId: initialId ?? firstId,
    restoreId: restoreId.value,
  }));
}

function restoreIdForActivation(fields: ReadonlyMap<string, unknown>): NormalizeResult<string | null> {
  const restoreValue = fields.get("restoreId");
  const currentFocusValue = fields.get("currentFocusId");
  const restoreId = restoreValue === undefined ? null : stringId(restoreValue);
  const currentFocusId = currentFocusValue === undefined ? null : stringId(currentFocusValue);

  if (restoreValue !== undefined && restoreId === null) {
    return reject();
  }
  if (currentFocusValue !== undefined && currentFocusId === null) {
    return reject();
  }
  if (restoreId !== null && currentFocusId !== null && restoreId !== currentFocusId) {
    return reject();
  }

  return accept(restoreId ?? currentFocusId);
}

function stateFor(
  ids: readonly string[],
  active: boolean,
  focusedId: string | null,
  restoreId: string | null,
): FocusTrapState {
  return Object.freeze({
    active,
    focusedId,
    ids: Object.freeze([...ids]),
    restoreId,
  });
}

function nextIndex(ids: readonly string[], activeId: string | null, delta: 1 | -1): number | null {
  if (ids.length === 0) {
    return null;
  }

  const activeIndex = activeId === null ? -1 : indexOf(ids, activeId);

  if (activeIndex < 0) {
    return delta > 0 ? 0 : ids.length - 1;
  }

  return positiveModulo(activeIndex + delta, ids.length);
}

function normalizeTrapKeyEvent(input: unknown): NormalizeResult<TrapKeyEvent> {
  if (typeof input === "string") {
    return normalizeTrapKeyString(input);
  }

  const object = snapshotObject(input, KEY_EVENT_FIELDS);

  if (!object.ok) {
    return reject();
  }

  const key = object.value.get("key");
  const shiftKey = object.value.get("shiftKey");

  if (typeof key !== "string" || key.trim().toLocaleLowerCase("en-US") !== "tab") {
    return reject();
  }
  if (shiftKey !== undefined && typeof shiftKey !== "boolean") {
    return reject();
  }

  return accept(Object.freeze({
    key: "Tab",
    shiftKey: shiftKey === true,
  }));
}

function normalizeTrapKeyString(input: string): NormalizeResult<TrapKeyEvent> {
  const trimmed = input.trim();

  if (trimmed.length === 0) {
    return reject();
  }

  const parts = trimmed.split("+");
  let key: string | null = null;
  let shiftKey = false;

  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index];

    if (part === undefined) {
      return reject();
    }

    const token = part.trim();
    const folded = token.toLocaleLowerCase("en-US");

    if (folded === "shift") {
      shiftKey = true;
      continue;
    }
    if (folded === "tab" && key === null) {
      key = "Tab";
      continue;
    }

    return reject();
  }

  if (key !== "Tab") {
    return reject();
  }

  return accept(Object.freeze({
    key,
    shiftKey,
  }));
}

function snapshotObject(
  input: unknown,
  allowedKeys: readonly string[],
): NormalizeResult<ReadonlyMap<string, unknown>> {
  try {
    if (input === null || typeof input !== "object" || Array.isArray(input)) {
      return reject();
    }

    const prototype = Object.getPrototypeOf(input);

    if (prototype !== Object.prototype && prototype !== null) {
      return reject();
    }

    const keys = Reflect.ownKeys(input);
    const output = new Map<string, unknown>();

    for (let index = 0; index < keys.length; index += 1) {
      const key = keys[index];

      if (key === undefined || typeof key === "symbol" || !contains(allowedKeys, key)) {
        return reject();
      }

      const descriptor = Object.getOwnPropertyDescriptor(input, key);

      if (descriptor === undefined || !isDataDescriptor(descriptor) || descriptor.enumerable !== true) {
        return reject();
      }

      output.set(key, descriptor.value);
    }

    return accept(output);
  } catch {
    return reject();
  }
}

function snapshotStringArray(input: unknown): NormalizeResult<readonly string[]> {
  try {
    if (!Array.isArray(input)) {
      return reject();
    }

    const lengthDescriptor = Object.getOwnPropertyDescriptor(input, "length");

    if (
      lengthDescriptor === undefined ||
      !isDataDescriptor(lengthDescriptor) ||
      typeof lengthDescriptor.value !== "number" ||
      !Number.isSafeInteger(lengthDescriptor.value) ||
      lengthDescriptor.value < 0
    ) {
      return reject();
    }

    const length = lengthDescriptor.value;
    const keys = Reflect.ownKeys(input);

    for (let index = 0; index < keys.length; index += 1) {
      const key = keys[index];

      if (key === "length") {
        continue;
      }
      if (key === undefined || typeof key === "symbol" || !isArrayIndexKey(key, length)) {
        return reject();
      }
    }

    const output: string[] = [];

    for (let index = 0; index < length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(input, String(index));

      if (descriptor === undefined || !isDataDescriptor(descriptor) || descriptor.enumerable !== true) {
        return reject();
      }

      const value = stringId(descriptor.value);

      if (value === null) {
        return reject();
      }

      output.push(value);
    }

    return accept(Object.freeze(output));
  } catch {
    return reject();
  }
}

function stringId(input: unknown): string | null {
  return typeof input === "string" && input.length > 0 ? input : null;
}

function hasDuplicate(values: readonly string[]): boolean {
  const seen = new Set<string>();

  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];

    if (value === undefined) {
      return true;
    }
    if (seen.has(value)) {
      return true;
    }

    seen.add(value);
  }

  return false;
}

function contains(values: readonly string[], value: string): boolean {
  for (let index = 0; index < values.length; index += 1) {
    if (values[index] === value) {
      return true;
    }
  }

  return false;
}

function indexOf(values: readonly string[], value: string): number {
  for (let index = 0; index < values.length; index += 1) {
    if (values[index] === value) {
      return index;
    }
  }

  return -1;
}

function isArrayIndexKey(key: string, length: number): boolean {
  if (key.length === 0) {
    return false;
  }

  const index = Number(key);

  return Number.isSafeInteger(index) && index >= 0 && index < length && String(index) === key;
}

function isDataDescriptor(descriptor: PropertyDescriptor): descriptor is PropertyDescriptor & {
  readonly value: unknown;
} {
  return Object.prototype.hasOwnProperty.call(descriptor, "value");
}

function positiveModulo(value: number, modulus: number): number {
  return ((value % modulus) + modulus) % modulus;
}

function accept<T>(value: T): NormalizeResult<T> {
  return Object.freeze({
    ok: true,
    value,
  });
}

function reject<T>(): NormalizeResult<T> {
  return Object.freeze({
    ok: false,
  });
}
