export type FocusRingOrientation = "horizontal" | "vertical" | "grid";
export type FocusRingTabIndex = -1 | 0;

export interface FocusRingOptions {
  readonly activeId?: string;
  readonly columns?: number;
  readonly disabledIds?: readonly string[];
  readonly ids?: readonly string[];
  readonly orientation?: FocusRingOrientation;
  readonly wrap?: boolean;
}

export type FocusRingSetItemsOptions = Omit<FocusRingOptions, "ids">;

export interface FocusRingItemState {
  readonly disabled: boolean;
  readonly id: string;
  readonly tabindex: FocusRingTabIndex;
}

export interface FocusRingState {
  readonly activeId: string | null;
  readonly columns: number;
  readonly items: readonly FocusRingItemState[];
  readonly orientation: FocusRingOrientation;
  readonly wrap: boolean;
}

export interface FocusRingViewModel {
  activeId(): string | null;
  moveFirst(): FocusRingState;
  moveLast(): FocusRingState;
  moveNext(): FocusRingState;
  movePrev(): FocusRingState;
  onKey(key: unknown): FocusRingState;
  setItems(ids: unknown, opts?: unknown): FocusRingState;
  snapshot(): FocusRingState;
}

interface FocusRingKeyEvent {
  readonly key: string;
  readonly shiftKey: boolean;
}

interface FocusRingConfig {
  readonly activeId?: string;
  readonly columns: number;
  readonly disabledIds: readonly string[];
  readonly ids: readonly string[];
  readonly orientation: FocusRingOrientation;
  readonly wrap: boolean;
}

type NormalizeResult<T> =
  | {
      readonly ok: true;
      readonly value: T;
    }
  | {
      readonly ok: false;
    };

const DEFAULT_ORIENTATION: FocusRingOrientation = "horizontal";
const DEFAULT_COLUMNS = 1;
const DEFAULT_WRAP = true;
const OPTION_FIELDS = Object.freeze(["activeId", "columns", "disabledIds", "ids", "orientation", "wrap"]);
const SET_OPTION_FIELDS = Object.freeze(["activeId", "columns", "disabledIds", "orientation", "wrap"]);
const KEY_EVENT_FIELDS = Object.freeze(["key", "shiftKey"]);

const EMPTY_FOCUS_RING_STATE: FocusRingState = Object.freeze({
  activeId: null,
  columns: DEFAULT_COLUMNS,
  items: Object.freeze([]),
  orientation: DEFAULT_ORIENTATION,
  wrap: DEFAULT_WRAP,
});

export function createFocusRingViewModel(options?: FocusRingOptions): FocusRingViewModel;
export function createFocusRingViewModel(
  ids: readonly string[],
  options?: FocusRingSetItemsOptions,
): FocusRingViewModel;
export function createFocusRingViewModel(input?: unknown, options?: unknown): FocusRingViewModel;
export function createFocusRingViewModel(
  input: unknown = Object.freeze({}),
  options: unknown = Object.freeze({}),
): FocusRingViewModel {
  return new DesktopFocusRingViewModel(input, options);
}

export const createRovingFocusViewModel = createFocusRingViewModel;

class DesktopFocusRingViewModel implements FocusRingViewModel {
  #state: FocusRingState;

  constructor(input: unknown, options: unknown) {
    const normalized = Array.isArray(input)
      ? normalizeConfigFromParts(input, options, OPTION_FIELDS)
      : normalizeConfigFromOptions(input, OPTION_FIELDS);

    this.#state = normalized.ok ? stateForConfig(normalized.value, null) : EMPTY_FOCUS_RING_STATE;
  }

  activeId(): string | null {
    return this.#state.activeId;
  }

  snapshot(): FocusRingState {
    return this.#state;
  }

  setItems(ids: unknown, opts: unknown = Object.freeze({})): FocusRingState {
    const normalized = normalizeConfigFromParts(ids, opts, SET_OPTION_FIELDS);

    if (!normalized.ok) {
      return this.#state;
    }

    this.#state = stateForConfig(normalized.value, this.#state.activeId);

    return this.#state;
  }

  moveNext(): FocusRingState {
    this.#state = moveLinear(this.#state, 1);

    return this.#state;
  }

  movePrev(): FocusRingState {
    this.#state = moveLinear(this.#state, -1);

    return this.#state;
  }

  moveFirst(): FocusRingState {
    this.#state = moveToBoundary(this.#state, 1);

    return this.#state;
  }

  moveLast(): FocusRingState {
    this.#state = moveToBoundary(this.#state, -1);

    return this.#state;
  }

  onKey(key: unknown): FocusRingState {
    const normalized = normalizeKeyEvent(key);

    if (!normalized.ok) {
      return this.#state;
    }

    switch (normalized.value.key) {
      case "ArrowDown":
        this.#state = this.#state.orientation === "grid"
          ? moveGridVertical(this.#state, 1)
          : this.#state.orientation === "vertical"
            ? moveLinear(this.#state, 1)
            : this.#state;
        break;
      case "ArrowLeft":
        this.#state = this.#state.orientation === "grid" || this.#state.orientation === "horizontal"
          ? moveLinear(this.#state, -1)
          : this.#state;
        break;
      case "ArrowRight":
        this.#state = this.#state.orientation === "grid" || this.#state.orientation === "horizontal"
          ? moveLinear(this.#state, 1)
          : this.#state;
        break;
      case "ArrowUp":
        this.#state = this.#state.orientation === "grid"
          ? moveGridVertical(this.#state, -1)
          : this.#state.orientation === "vertical"
            ? moveLinear(this.#state, -1)
            : this.#state;
        break;
      case "End":
        this.#state = moveToBoundary(this.#state, -1);
        break;
      case "Home":
        this.#state = moveToBoundary(this.#state, 1);
        break;
      case "PageDown":
        this.#state = moveLinear(this.#state, 1);
        break;
      case "PageUp":
        this.#state = moveLinear(this.#state, -1);
        break;
      case "Tab":
        this.#state = moveLinear(this.#state, normalized.value.shiftKey ? -1 : 1);
        break;
    }

    return this.#state;
  }
}

function normalizeConfigFromOptions(
  input: unknown,
  allowedFields: readonly string[],
): NormalizeResult<FocusRingConfig> {
  const object = snapshotObject(input, allowedFields);

  if (!object.ok) {
    return reject();
  }

  return normalizeConfigFields(object.value);
}

function normalizeConfigFromParts(
  idsInput: unknown,
  optsInput: unknown,
  allowedFields: readonly string[],
): NormalizeResult<FocusRingConfig> {
  const ids = snapshotStringArray(idsInput);

  if (!ids.ok) {
    return reject();
  }

  const options = snapshotObject(optsInput, allowedFields);

  if (!options.ok) {
    return reject();
  }

  const fields = new Map<string, unknown>(options.value);
  fields.set("ids", ids.value);

  return normalizeConfigFields(fields);
}

function normalizeConfigFields(fields: ReadonlyMap<string, unknown>): NormalizeResult<FocusRingConfig> {
  const idsValue = fields.get("ids");
  const ids = idsValue === undefined ? accept(Object.freeze([]) as readonly string[]) : snapshotStringArray(idsValue);

  if (!ids.ok || hasDuplicate(ids.value)) {
    return reject();
  }

  const orientation = orientationField(fields.get("orientation"));

  if (orientation === null) {
    return reject();
  }

  const columns = columnsField(fields.get("columns"), orientation);

  if (columns === null) {
    return reject();
  }

  const wrap = wrapField(fields.get("wrap"));

  if (wrap === null) {
    return reject();
  }

  const disabledIds = disabledIdsField(fields.get("disabledIds"), ids.value);

  if (disabledIds === null) {
    return reject();
  }

  const activeIdValue = fields.get("activeId");
  let activeId: string | undefined;

  if (activeIdValue !== undefined) {
    const normalizedActiveId = stringId(activeIdValue);

    if (
      normalizedActiveId === null ||
      !contains(ids.value, normalizedActiveId) ||
      contains(disabledIds, normalizedActiveId)
    ) {
      return reject();
    }

    activeId = normalizedActiveId;
  }

  const output: {
    activeId?: string;
    columns: number;
    disabledIds: readonly string[];
    ids: readonly string[];
    orientation: FocusRingOrientation;
    wrap: boolean;
  } = {
    columns,
    disabledIds,
    ids: ids.value,
    orientation,
    wrap,
  };

  if (activeId !== undefined) {
    output.activeId = activeId;
  }

  return accept(Object.freeze(output));
}

function stateForConfig(config: FocusRingConfig, fallbackActiveId: string | null): FocusRingState {
  const activeId = activeIdForConfig(config, fallbackActiveId);

  return stateFromIds(config.ids, config.disabledIds, config.orientation, config.columns, config.wrap, activeId);
}

function activeIdForConfig(config: FocusRingConfig, fallbackActiveId: string | null): string | null {
  if (config.activeId !== undefined) {
    return config.activeId;
  }

  if (
    fallbackActiveId !== null &&
    contains(config.ids, fallbackActiveId) &&
    !contains(config.disabledIds, fallbackActiveId)
  ) {
    return fallbackActiveId;
  }

  for (let index = 0; index < config.ids.length; index += 1) {
    const id = config.ids[index];

    if (id !== undefined && !contains(config.disabledIds, id)) {
      return id;
    }
  }

  return null;
}

function stateFromIds(
  ids: readonly string[],
  disabledIds: readonly string[],
  orientation: FocusRingOrientation,
  columns: number,
  wrap: boolean,
  activeId: string | null,
): FocusRingState {
  const items: FocusRingItemState[] = [];
  let resolvedActiveId = activeId;

  if (resolvedActiveId !== null && (!contains(ids, resolvedActiveId) || contains(disabledIds, resolvedActiveId))) {
    resolvedActiveId = null;
  }

  for (let index = 0; index < ids.length; index += 1) {
    const id = ids[index];

    if (id === undefined) {
      continue;
    }

    const disabled = contains(disabledIds, id);

    items.push(Object.freeze({
      disabled,
      id,
      tabindex: !disabled && id === resolvedActiveId ? 0 : -1,
    }));
  }

  return Object.freeze({
    activeId: resolvedActiveId,
    columns,
    items: Object.freeze(items),
    orientation,
    wrap,
  });
}

function moveLinear(state: FocusRingState, delta: 1 | -1): FocusRingState {
  const target = nextLinearIndex(state, delta);

  if (target === null) {
    return state;
  }

  return focusIndex(state, target);
}

function nextLinearIndex(state: FocusRingState, delta: 1 | -1): number | null {
  const length = state.items.length;

  if (length === 0) {
    return null;
  }

  const activeIndex = activeIndexForState(state);

  if (activeIndex < 0) {
    return boundaryIndex(state, delta);
  }

  let index = activeIndex;

  for (let attempt = 0; attempt < length; attempt += 1) {
    index += delta;

    if (index < 0 || index >= length) {
      if (!state.wrap) {
        return activeIndex;
      }

      index = positiveModulo(index, length);
    }

    if (isEnabledAt(state, index)) {
      return index;
    }
  }

  return activeIndex;
}

function moveGridVertical(state: FocusRingState, direction: 1 | -1): FocusRingState {
  const length = state.items.length;

  if (length === 0) {
    return state;
  }

  const activeIndex = activeIndexForState(state);

  if (activeIndex < 0) {
    const target = boundaryIndex(state, direction);

    return target === null ? state : focusIndex(state, target);
  }

  const column = activeIndex % state.columns;
  const rows = Math.ceil(length / state.columns);
  let index = activeIndex;

  for (let attempt = 0; attempt < rows; attempt += 1) {
    index += direction * state.columns;

    if (index < 0 || index >= length) {
      if (!state.wrap) {
        return state;
      }

      index = direction > 0 ? column : lastIndexInColumn(length, state.columns, column);
    }

    if (isEnabledAt(state, index)) {
      return focusIndex(state, index);
    }
  }

  return state;
}

function moveToBoundary(state: FocusRingState, direction: 1 | -1): FocusRingState {
  const target = boundaryIndex(state, direction);

  if (target === null) {
    return state;
  }

  return focusIndex(state, target);
}

function boundaryIndex(state: FocusRingState, direction: 1 | -1): number | null {
  if (direction > 0) {
    for (let index = 0; index < state.items.length; index += 1) {
      if (isEnabledAt(state, index)) {
        return index;
      }
    }

    return null;
  }

  for (let index = state.items.length - 1; index >= 0; index -= 1) {
    if (isEnabledAt(state, index)) {
      return index;
    }
  }

  return null;
}

function focusIndex(state: FocusRingState, index: number): FocusRingState {
  const item = state.items[index];

  if (item === undefined || item.disabled) {
    return state;
  }

  const ids = itemIds(state.items);
  const disabledIds = disabledItemIds(state.items);

  return stateFromIds(ids, disabledIds, state.orientation, state.columns, state.wrap, item.id);
}

function activeIndexForState(state: FocusRingState): number {
  if (state.activeId === null) {
    return -1;
  }

  for (let index = 0; index < state.items.length; index += 1) {
    const item = state.items[index];

    if (item !== undefined && item.id === state.activeId) {
      return index;
    }
  }

  return -1;
}

function isEnabledAt(state: FocusRingState, index: number): boolean {
  const item = state.items[index];

  return item !== undefined && !item.disabled;
}

function itemIds(items: readonly FocusRingItemState[]): readonly string[] {
  const ids: string[] = [];

  for (let index = 0; index < items.length; index += 1) {
    const item = items[index];

    if (item !== undefined) {
      ids.push(item.id);
    }
  }

  return Object.freeze(ids);
}

function disabledItemIds(items: readonly FocusRingItemState[]): readonly string[] {
  const ids: string[] = [];

  for (let index = 0; index < items.length; index += 1) {
    const item = items[index];

    if (item !== undefined && item.disabled) {
      ids.push(item.id);
    }
  }

  return Object.freeze(ids);
}

function lastIndexInColumn(length: number, columns: number, column: number): number {
  let index = column;

  while (index + columns < length) {
    index += columns;
  }

  return index;
}

function normalizeKeyEvent(input: unknown): NormalizeResult<FocusRingKeyEvent> {
  if (typeof input === "string") {
    return normalizeKeyString(input);
  }

  const object = snapshotObject(input, KEY_EVENT_FIELDS);

  if (!object.ok) {
    return reject();
  }

  const key = object.value.get("key");
  const shiftKey = object.value.get("shiftKey");

  if (typeof key !== "string") {
    return reject();
  }
  if (shiftKey !== undefined && typeof shiftKey !== "boolean") {
    return reject();
  }

  const normalized = normalizeKeyName(key);

  if (normalized === null) {
    return reject();
  }

  return accept(Object.freeze({
    key: normalized,
    shiftKey: shiftKey === true,
  }));
}

function normalizeKeyString(input: string): NormalizeResult<FocusRingKeyEvent> {
  const trimmed = input.trim();

  if (trimmed.length === 0) {
    return reject();
  }

  const parts = trimmed.split("+");
  let shiftKey = false;
  let key: string | null = null;

  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index];

    if (part === undefined) {
      return reject();
    }

    const token = part.trim();

    if (token.length === 0) {
      return reject();
    }

    if (token.toLocaleLowerCase("en-US") === "shift") {
      shiftKey = true;
      continue;
    }

    if (key !== null) {
      return reject();
    }

    key = token;
  }

  if (key === null) {
    return reject();
  }

  const normalized = normalizeKeyName(key);

  if (normalized === null) {
    return reject();
  }

  return accept(Object.freeze({
    key: normalized,
    shiftKey,
  }));
}

function normalizeKeyName(input: string): FocusRingKeyEvent["key"] | null {
  switch (input.trim().toLocaleLowerCase("en-US")) {
    case "arrowdown":
    case "down":
      return "ArrowDown";
    case "arrowleft":
    case "left":
      return "ArrowLeft";
    case "arrowright":
    case "right":
      return "ArrowRight";
    case "arrowup":
    case "up":
      return "ArrowUp";
    case "end":
      return "End";
    case "home":
      return "Home";
    case "pagedown":
    case "page-down":
      return "PageDown";
    case "pageup":
    case "page-up":
      return "PageUp";
    case "tab":
      return "Tab";
    default:
      return null;
  }
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

function orientationField(input: unknown): FocusRingOrientation | null {
  if (input === undefined) {
    return DEFAULT_ORIENTATION;
  }
  if (input !== "horizontal" && input !== "vertical" && input !== "grid") {
    return null;
  }

  return input;
}

function columnsField(input: unknown, orientation: FocusRingOrientation): number | null {
  if (input === undefined) {
    return orientation === "grid" ? null : DEFAULT_COLUMNS;
  }
  if (typeof input !== "number" || !Number.isSafeInteger(input) || input <= 0) {
    return null;
  }

  return input;
}

function wrapField(input: unknown): boolean | null {
  if (input === undefined) {
    return DEFAULT_WRAP;
  }

  return typeof input === "boolean" ? input : null;
}

function disabledIdsField(input: unknown, ids: readonly string[]): readonly string[] | null {
  if (input === undefined) {
    return Object.freeze([]);
  }

  const disabledIds = snapshotStringArray(input);

  if (!disabledIds.ok) {
    return null;
  }

  for (let index = 0; index < disabledIds.value.length; index += 1) {
    const id = disabledIds.value[index];

    if (id === undefined || !contains(ids, id)) {
      return null;
    }
  }

  return disabledIds.value;
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
