import type {
  DesktopHost,
  DesktopHostError,
  DesktopSettingsApply,
  DesktopSettingsPreview,
  DesktopSettingsWriteRequest,
} from "../../../../sdk/typescript/src/desktop-sdk/index.ts";

export const SETTINGS_APP_SETTING_KEYS = Object.freeze({
  accent: "appearance.accent",
  layout: "appearance.layout",
  theme: "appearance.theme",
});

export const SETTINGS_APP_SECTIONS = Object.freeze([
  Object.freeze({ group: "system", icon: "settings-2", id: "general", label: "General" }),
  Object.freeze({ group: "system", icon: "sun-moon", id: "appearance", label: "Appearance" }),
  Object.freeze({ group: "system", icon: "wifi", id: "network", label: "Network" }),
  Object.freeze({ group: "system", icon: "volume-2", id: "sound", label: "Sound" }),
  Object.freeze({ group: "system", icon: "monitor", id: "display", label: "Display" }),
  Object.freeze({ group: "account", icon: "circle-user", id: "accounts", label: "Accounts" }),
  Object.freeze({ group: "account", icon: "shield-check", id: "privacy", label: "Privacy" }),
  Object.freeze({ group: "advanced", icon: "terminal", id: "developer", label: "Developer" }),
] as const);

export const SETTINGS_APP_THEMES = Object.freeze(["light", "dark", "graphite"] as const);
export const SETTINGS_APP_LAYOUTS = Object.freeze(["comfortable", "compact", "floating", "tiling"] as const);

export const SETTINGS_APP_ACCENT_OPTIONS = Object.freeze([
  Object.freeze({ color: "#3178c6", id: "blue", label: "Blue" }),
  Object.freeze({ color: "#14b8a6", id: "teal", label: "Teal" }),
  Object.freeze({ color: "#8b5cf6", id: "violet", label: "Violet" }),
  Object.freeze({ color: "#f97316", id: "orange", label: "Orange" }),
  Object.freeze({ color: "#10b981", id: "green", label: "Green" }),
] as const);

export type SettingsAppSectionId = typeof SETTINGS_APP_SECTIONS[number]["id"];
export type SettingsAppSectionGroup = typeof SETTINGS_APP_SECTIONS[number]["group"];
export type SettingsAppTheme = typeof SETTINGS_APP_THEMES[number];
export type SettingsAppAccent = typeof SETTINGS_APP_ACCENT_OPTIONS[number]["id"];
export type SettingsAppLayout = typeof SETTINGS_APP_LAYOUTS[number];
export type SettingsAppSettingValue = DesktopSettingsWriteRequest["value"];

export interface SettingsAppSidebarSection {
  readonly group: SettingsAppSectionGroup;
  readonly icon: string;
  readonly id: SettingsAppSectionId;
  readonly label: string;
  readonly active: boolean;
}

export interface SettingsAppAccentOption {
  readonly color: string;
  readonly id: SettingsAppAccent;
  readonly label: string;
  readonly active: boolean;
}

export interface SettingsAppAppearanceState {
  readonly theme: SettingsAppTheme;
  readonly accent: SettingsAppAccent;
  readonly accentColor: string;
  readonly layout: SettingsAppLayout;
  readonly tiling: boolean;
  readonly density: "comfortable" | "compact";
}

export interface SettingsAppPendingPreview {
  readonly key: string;
  readonly value: SettingsAppSettingValue;
  readonly revision: string;
  readonly diff: DesktopSettingsPreview["diff"];
}

export interface SettingsAppState {
  readonly sections: readonly SettingsAppSidebarSection[];
  readonly activeSection: SettingsAppSectionId;
  readonly appearance: SettingsAppAppearanceState;
  readonly accentOptions: readonly SettingsAppAccentOption[];
  readonly pendingPreview: SettingsAppPendingPreview | null;
}

export interface SettingsAppViewModelPorts {
  readonly readSetting?: NonNullable<DesktopHost["readSetting"]>;
  readonly previewSetting?: NonNullable<DesktopHost["previewSetting"]>;
  readonly applySetting?: NonNullable<DesktopHost["applySetting"]>;
}

export interface SettingsAppError {
  readonly code: string;
  readonly message: string;
  readonly path: string;
}

export type SettingsAppViewModelResult<T> =
  | {
      readonly ok: true;
      readonly value: T;
    }
  | {
      readonly ok: false;
      readonly error: SettingsAppError;
    };

export type SettingsAppActionResult =
  | {
      readonly ok: true;
      readonly state: SettingsAppState;
    }
  | {
      readonly ok: false;
      readonly error: SettingsAppError;
      readonly state: SettingsAppState;
    };

export type SettingsAppValueActionResult<T> =
  | {
      readonly ok: true;
      readonly value: T;
      readonly state: SettingsAppState;
    }
  | {
      readonly ok: false;
      readonly error: SettingsAppError;
      readonly state: SettingsAppState;
    };

export interface SettingsAppViewModel {
  readonly state: SettingsAppState;
  snapshot(): SettingsAppState;
  selectSection(sectionId: unknown): SettingsAppActionResult;
  readSetting(key: unknown): Promise<SettingsAppValueActionResult<SettingsAppSettingValue>>;
  previewSetting(
    key: unknown,
    value: unknown,
  ): Promise<SettingsAppValueActionResult<DesktopSettingsPreview>>;
  applySetting(
    key: unknown,
    value: unknown,
  ): Promise<SettingsAppValueActionResult<DesktopSettingsApply>>;
}

interface StateInput {
  readonly activeSection: SettingsAppSectionId;
  readonly accent: SettingsAppAccent;
  readonly layout: SettingsAppLayout;
  readonly pendingPreview: SettingsAppPendingPreview | null;
  readonly theme: SettingsAppTheme;
}

const DEFAULT_STATE_INPUT: StateInput = Object.freeze({
  accent: "blue",
  activeSection: "appearance",
  layout: "comfortable",
  pendingPreview: null,
  theme: "light",
});

const MAX_JSON_DEPTH = 64;
const MAX_JSON_NODES = 10_000;
const ARRAY_LENGTH_KEY = "length";

export function createSettingsAppViewModel(
  ports: SettingsAppViewModelPorts,
): SettingsAppViewModelResult<SettingsAppViewModel> {
  return accept(new DesktopSettingsAppViewModel(ports, freezeState(DEFAULT_STATE_INPUT)));
}

class DesktopSettingsAppViewModel implements SettingsAppViewModel {
  readonly #ports: SettingsAppViewModelPorts;
  #state: SettingsAppState;

  constructor(ports: SettingsAppViewModelPorts, state: SettingsAppState) {
    this.#ports = ports;
    this.#state = state;
  }

  get state(): SettingsAppState {
    return this.#state;
  }

  snapshot(): SettingsAppState {
    return this.#state;
  }

  selectSection(sectionId: unknown): SettingsAppActionResult {
    if (typeof sectionId !== "string" || !isSettingsAppSectionId(sectionId)) {
      return actionReject(
        error("UNKNOWN_SETTINGS_SECTION", "settings section is not supported.", "/activeSection"),
        this.#state,
      );
    }

    this.#state = freezeState({
      accent: this.#state.appearance.accent,
      activeSection: sectionId,
      layout: this.#state.appearance.layout,
      pendingPreview: this.#state.pendingPreview,
      theme: this.#state.appearance.theme,
    });

    return actionAccept(this.#state);
  }

  async readSetting(keyInput: unknown): Promise<SettingsAppValueActionResult<SettingsAppSettingValue>> {
    const key = normalizeSettingKey(keyInput, "/readSetting/key");

    if (!key.ok) return valueReject(key.error, this.#state);

    const readSetting = this.#ports.readSetting;

    if (readSetting === undefined) {
      return valueReject(
        error("SETTINGS_PORT_UNAVAILABLE", "settings read port is unavailable.", "/readSetting"),
        this.#state,
      );
    }

    let result: Awaited<ReturnType<NonNullable<DesktopHost["readSetting"]>>>;

    try {
      result = await readSetting(Object.freeze({ key: key.value }));
    } catch {
      return valueReject(
        error("SETTINGS_READ_FAILED", "settings read failed closed.", `/readSetting/${pathToken(key.value)}`),
        this.#state,
      );
    }

    if (!result.ok) return valueReject(hostError(result.error), this.#state);

    const value = normalizeJsonValue(result.value, `/readSetting/${pathToken(key.value)}/value`);

    if (!value.ok) return valueReject(value.error, this.#state);

    const next = stateInputForSetting(this.#state, key.value, value.value, null, "/readSetting/value");

    if (!next.ok) return valueReject(next.error, this.#state);

    this.#state = freezeState(next.value);

    return valueAccept(value.value, this.#state);
  }

  async previewSetting(
    keyInput: unknown,
    valueInput: unknown,
  ): Promise<SettingsAppValueActionResult<DesktopSettingsPreview>> {
    const request = normalizeWriteRequest(keyInput, valueInput, "/previewSetting");

    if (!request.ok) return valueReject(request.error, this.#state);

    const validated = stateInputForSetting(
      this.#state,
      request.value.key,
      request.value.value,
      this.#state.pendingPreview,
      "/previewSetting/value",
    );

    if (!validated.ok) return valueReject(validated.error, this.#state);

    const previewSetting = this.#ports.previewSetting;

    if (previewSetting === undefined) {
      return valueReject(
        error("SETTINGS_PORT_UNAVAILABLE", "settings preview port is unavailable.", "/previewSetting"),
        this.#state,
      );
    }

    let result: Awaited<ReturnType<NonNullable<DesktopHost["previewSetting"]>>>;

    try {
      result = await previewSetting(Object.freeze({
        key: request.value.key,
        value: request.value.value,
      }));
    } catch {
      return valueReject(
        error("SETTINGS_PREVIEW_FAILED", "settings preview failed closed.", `/previewSetting/${pathToken(request.value.key)}`),
        this.#state,
      );
    }

    if (!result.ok) return valueReject(hostError(result.error), this.#state);

    const preview = normalizePreview(result.value, `/previewSetting/${pathToken(request.value.key)}`);

    if (!preview.ok) return valueReject(preview.error, this.#state);

    const pendingPreview = freezePendingPreview({
      diff: preview.value.diff,
      key: request.value.key,
      revision: preview.value.revision,
      value: request.value.value,
    });
    const next = stateInputForSetting(
      this.#state,
      request.value.key,
      request.value.value,
      pendingPreview,
      "/previewSetting/value",
    );

    if (!next.ok) return valueReject(next.error, this.#state);

    this.#state = freezeState(next.value);

    return valueAccept(preview.value, this.#state);
  }

  async applySetting(
    keyInput: unknown,
    valueInput: unknown,
  ): Promise<SettingsAppValueActionResult<DesktopSettingsApply>> {
    const request = normalizeWriteRequest(keyInput, valueInput, "/applySetting");

    if (!request.ok) return valueReject(request.error, this.#state);

    const validated = stateInputForSetting(
      this.#state,
      request.value.key,
      request.value.value,
      this.#state.pendingPreview,
      "/applySetting/value",
    );

    if (!validated.ok) return valueReject(validated.error, this.#state);

    const applySetting = this.#ports.applySetting;

    if (applySetting === undefined) {
      return valueReject(
        error("SETTINGS_PORT_UNAVAILABLE", "settings apply port is unavailable.", "/applySetting"),
        this.#state,
      );
    }

    let result: Awaited<ReturnType<NonNullable<DesktopHost["applySetting"]>>>;

    try {
      result = await applySetting(Object.freeze({
        key: request.value.key,
        value: request.value.value,
      }));
    } catch {
      return valueReject(
        error("SETTINGS_APPLY_FAILED", "settings apply failed closed.", `/applySetting/${pathToken(request.value.key)}`),
        this.#state,
      );
    }

    if (!result.ok) return valueReject(hostError(result.error), this.#state);

    const applied = normalizeApply(result.value, `/applySetting/${pathToken(request.value.key)}`);

    if (!applied.ok) return valueReject(applied.error, this.#state);

    const next = stateInputForSetting(
      this.#state,
      request.value.key,
      request.value.value,
      null,
      "/applySetting/value",
    );

    if (!next.ok) return valueReject(next.error, this.#state);

    this.#state = freezeState(next.value);

    return valueAccept(applied.value, this.#state);
  }
}

function normalizeWriteRequest(
  keyInput: unknown,
  valueInput: unknown,
  path: string,
): SettingsAppViewModelResult<{
  readonly key: string;
  readonly value: SettingsAppSettingValue;
}> {
  const key = normalizeSettingKey(keyInput, `${path}/key`);

  if (!key.ok) return key;

  const value = normalizeJsonValue(valueInput, `${path}/value`);

  if (!value.ok) return value;

  return accept(Object.freeze({
    key: key.value,
    value: value.value,
  }));
}

function normalizeSettingKey(input: unknown, path: string): SettingsAppViewModelResult<string> {
  if (typeof input !== "string" || input.length === 0) {
    return reject("INVALID_SETTING_KEY", "setting key must be non-empty text.", path);
  }

  return accept(input);
}

function stateInputForSetting(
  state: SettingsAppState,
  key: string,
  value: SettingsAppSettingValue,
  pendingPreview: SettingsAppPendingPreview | null,
  path: string,
): SettingsAppViewModelResult<StateInput> {
  switch (key) {
    case SETTINGS_APP_SETTING_KEYS.theme:
      if (typeof value !== "string" || !isSettingsAppTheme(value)) {
        return reject("UNKNOWN_THEME", "appearance theme is not supported.", path);
      }

      return accept(Object.freeze({
        accent: state.appearance.accent,
        activeSection: state.activeSection,
        layout: state.appearance.layout,
        pendingPreview,
        theme: value,
      }));
    case SETTINGS_APP_SETTING_KEYS.accent:
      if (typeof value !== "string" || !isSettingsAppAccent(value)) {
        return reject("UNKNOWN_ACCENT", "accent color is not supported.", path);
      }

      return accept(Object.freeze({
        accent: value,
        activeSection: state.activeSection,
        layout: state.appearance.layout,
        pendingPreview,
        theme: state.appearance.theme,
      }));
    case SETTINGS_APP_SETTING_KEYS.layout:
      if (typeof value !== "string" || !isSettingsAppLayout(value)) {
        return reject("UNKNOWN_LAYOUT", "layout mode is not supported.", path);
      }

      return accept(Object.freeze({
        accent: state.appearance.accent,
        activeSection: state.activeSection,
        layout: value,
        pendingPreview,
        theme: state.appearance.theme,
      }));
    default:
      return accept(Object.freeze({
        accent: state.appearance.accent,
        activeSection: state.activeSection,
        layout: state.appearance.layout,
        pendingPreview,
        theme: state.appearance.theme,
      }));
  }
}

function normalizePreview(
  input: DesktopSettingsPreview,
  path: string,
): SettingsAppViewModelResult<DesktopSettingsPreview> {
  if (typeof input.revision !== "string" || input.revision.length === 0) {
    return reject("MALFORMED_SETTINGS_PREVIEW", "settings preview revision is malformed.", `${path}/revision`);
  }

  const diff = normalizeJsonObject(input.diff, `${path}/diff`);

  if (!diff.ok) return diff;

  return accept(Object.freeze({
    diff: diff.value,
    revision: input.revision,
  }));
}

function normalizeApply(
  input: DesktopSettingsApply,
  path: string,
): SettingsAppViewModelResult<DesktopSettingsApply> {
  if (typeof input.revision !== "string" || input.revision.length === 0) {
    return reject("MALFORMED_SETTINGS_APPLY", "settings apply revision is malformed.", `${path}/revision`);
  }

  const applied = normalizeJsonObject(input.applied, `${path}/applied`);

  if (!applied.ok) return applied;

  return accept(Object.freeze({
    applied: applied.value,
    revision: input.revision,
  }));
}

function normalizeJsonObject(
  input: unknown,
  path: string,
): SettingsAppViewModelResult<DesktopSettingsPreview["diff"]> {
  const value = normalizeJsonValue(input, path);

  if (!value.ok) return value;
  if (!isSettingsJsonObject(value.value)) {
    return reject("INVALID_SETTING_VALUE", "setting value must be a JSON object.", path);
  }

  return accept(value.value);
}

function normalizeJsonValue(
  input: unknown,
  path: string,
): SettingsAppViewModelResult<SettingsAppSettingValue> {
  try {
    return normalizeJsonNode(input, {
      ancestors: new Set<object>(),
      nodes: 0,
    }, 0, path);
  } catch {
    return reject("INVALID_SETTING_VALUE", "setting value must be JSON data.", path);
  }
}

function normalizeJsonNode(
  input: unknown,
  state: {
    ancestors: Set<object>;
    nodes: number;
  },
  depth: number,
  path: string,
): SettingsAppViewModelResult<SettingsAppSettingValue> {
  if (state.nodes >= MAX_JSON_NODES) {
    return reject("INVALID_SETTING_VALUE", "setting value exceeds the JSON node budget.", path);
  }
  if (depth > MAX_JSON_DEPTH) {
    return reject("INVALID_SETTING_VALUE", "setting value exceeds the JSON depth budget.", path);
  }

  state.nodes += 1;

  if (input === null || typeof input === "string" || typeof input === "boolean") {
    return accept(input);
  }
  if (typeof input === "number") {
    return Number.isFinite(input)
      ? accept(input)
      : reject("INVALID_SETTING_VALUE", "setting value number must be finite.", path);
  }
  if (typeof input !== "object") {
    return reject("INVALID_SETTING_VALUE", "setting value must be JSON data.", path);
  }
  if (Array.isArray(input)) {
    return normalizeJsonArray(input, state, depth, path);
  }

  return normalizeJsonRecord(input, state, depth, path);
}

function normalizeJsonArray(
  input: readonly unknown[],
  state: {
    ancestors: Set<object>;
    nodes: number;
  },
  depth: number,
  path: string,
): SettingsAppViewModelResult<SettingsAppSettingValue> {
  if (Object.getPrototypeOf(input) !== Array.prototype) {
    return reject("INVALID_SETTING_VALUE", "setting value arrays must be plain.", path);
  }
  if (state.ancestors.has(input)) {
    return reject("INVALID_SETTING_VALUE", "setting value must not contain cycles.", path);
  }

  const lengthDescriptor = Object.getOwnPropertyDescriptor(input, ARRAY_LENGTH_KEY);

  if (lengthDescriptor === undefined || !isDataDescriptor(lengthDescriptor)) {
    return reject("INVALID_SETTING_VALUE", "setting value arrays must be dense data.", path);
  }

  const length = lengthDescriptor.value;

  if (!isSafeLength(length)) {
    return reject("INVALID_SETTING_VALUE", "setting value arrays must be dense data.", path);
  }

  const keys = Reflect.ownKeys(input);

  for (let keyIndex = 0; keyIndex < keys.length; keyIndex += 1) {
    const key = keys[keyIndex];

    if (key === undefined || !isAllowedArrayOwnKey(key, length)) {
      return reject("INVALID_SETTING_VALUE", "setting value arrays must be dense data.", path);
    }
  }

  const output: SettingsAppSettingValue[] = [];
  state.ancestors.add(input);

  try {
    for (let index = 0; index < length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(input, String(index));

      if (descriptor === undefined || !isDataDescriptor(descriptor) || descriptor.enumerable !== true) {
        return reject("INVALID_SETTING_VALUE", "setting value arrays must be dense data.", `${path}/${index}`);
      }

      const child = normalizeJsonNode(descriptor.value, state, depth + 1, `${path}/${index}`);

      if (!child.ok) return child;
      output.push(child.value);
    }
  } finally {
    state.ancestors.delete(input);
  }

  return accept(Object.freeze(output));
}

function normalizeJsonRecord(
  input: object,
  state: {
    ancestors: Set<object>;
    nodes: number;
  },
  depth: number,
  path: string,
): SettingsAppViewModelResult<SettingsAppSettingValue> {
  const prototype = Object.getPrototypeOf(input);

  if (prototype !== Object.prototype && prototype !== null) {
    return reject("INVALID_SETTING_VALUE", "setting value objects must be plain.", path);
  }
  if (state.ancestors.has(input)) {
    return reject("INVALID_SETTING_VALUE", "setting value must not contain cycles.", path);
  }

  const keys = Reflect.ownKeys(input);
  const output: Record<string, SettingsAppSettingValue> = {};

  state.ancestors.add(input);

  try {
    for (let keyIndex = 0; keyIndex < keys.length; keyIndex += 1) {
      const key = keys[keyIndex];

      if (key === undefined || typeof key === "symbol") {
        return reject("INVALID_SETTING_VALUE", "setting value objects must contain only string data properties.", path);
      }

      const descriptor = Object.getOwnPropertyDescriptor(input, key);

      if (descriptor === undefined || !isDataDescriptor(descriptor) || descriptor.enumerable !== true) {
        return reject(
          "INVALID_SETTING_VALUE",
          "setting value objects must contain only string data properties.",
          `${path}/${pathToken(key)}`,
        );
      }

      const child = normalizeJsonNode(descriptor.value, state, depth + 1, `${path}/${pathToken(key)}`);

      if (!child.ok) return child;

      Object.defineProperty(output, key, {
        configurable: true,
        enumerable: true,
        value: child.value,
        writable: true,
      });
    }
  } finally {
    state.ancestors.delete(input);
  }

  return accept(Object.freeze(output));
}

function freezeState(input: StateInput): SettingsAppState {
  return Object.freeze({
    accentOptions: freezeAccentOptions(input.accent),
    activeSection: input.activeSection,
    appearance: freezeAppearance(input.theme, input.accent, input.layout),
    pendingPreview: input.pendingPreview,
    sections: freezeSections(input.activeSection),
  });
}

function freezeAppearance(
  theme: SettingsAppTheme,
  accent: SettingsAppAccent,
  layout: SettingsAppLayout,
): SettingsAppAppearanceState {
  return Object.freeze({
    accent,
    accentColor: accentColor(accent),
    density: layout === "compact" || layout === "tiling" ? "compact" : "comfortable",
    layout,
    theme,
    tiling: layout === "tiling",
  });
}

function freezeSections(activeSection: SettingsAppSectionId): readonly SettingsAppSidebarSection[] {
  const sections: SettingsAppSidebarSection[] = [];

  for (let index = 0; index < SETTINGS_APP_SECTIONS.length; index += 1) {
    const section = SETTINGS_APP_SECTIONS[index];

    if (section === undefined) continue;
    sections.push(Object.freeze({
      active: section.id === activeSection,
      group: section.group,
      icon: section.icon,
      id: section.id,
      label: section.label,
    }));
  }

  return Object.freeze(sections);
}

function freezeAccentOptions(activeAccent: SettingsAppAccent): readonly SettingsAppAccentOption[] {
  const options: SettingsAppAccentOption[] = [];

  for (let index = 0; index < SETTINGS_APP_ACCENT_OPTIONS.length; index += 1) {
    const option = SETTINGS_APP_ACCENT_OPTIONS[index];

    if (option === undefined) continue;
    options.push(Object.freeze({
      active: option.id === activeAccent,
      color: option.color,
      id: option.id,
      label: option.label,
    }));
  }

  return Object.freeze(options);
}

function freezePendingPreview(input: SettingsAppPendingPreview): SettingsAppPendingPreview {
  return Object.freeze({
    diff: input.diff,
    key: input.key,
    revision: input.revision,
    value: input.value,
  });
}

function isSettingsAppSectionId(value: string): value is SettingsAppSectionId {
  for (let index = 0; index < SETTINGS_APP_SECTIONS.length; index += 1) {
    if (SETTINGS_APP_SECTIONS[index]?.id === value) return true;
  }

  return false;
}

function isSettingsAppTheme(value: string): value is SettingsAppTheme {
  return contains(SETTINGS_APP_THEMES, value);
}

function isSettingsAppAccent(value: string): value is SettingsAppAccent {
  for (let index = 0; index < SETTINGS_APP_ACCENT_OPTIONS.length; index += 1) {
    if (SETTINGS_APP_ACCENT_OPTIONS[index]?.id === value) return true;
  }

  return false;
}

function isSettingsAppLayout(value: string): value is SettingsAppLayout {
  return contains(SETTINGS_APP_LAYOUTS, value);
}

function contains<T extends string>(values: readonly T[], value: string): value is T {
  for (let index = 0; index < values.length; index += 1) {
    if (values[index] === value) return true;
  }

  return false;
}

function accentColor(accent: SettingsAppAccent): string {
  for (let index = 0; index < SETTINGS_APP_ACCENT_OPTIONS.length; index += 1) {
    const option = SETTINGS_APP_ACCENT_OPTIONS[index];

    if (option !== undefined && option.id === accent) return option.color;
  }

  return "#3178c6";
}

function isDataDescriptor(descriptor: PropertyDescriptor): descriptor is PropertyDescriptor & {
  readonly value: unknown;
} {
  return Object.prototype.hasOwnProperty.call(descriptor, "value");
}

function isSafeLength(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isSettingsJsonObject(value: SettingsAppSettingValue): value is DesktopSettingsPreview["diff"] {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isAllowedArrayOwnKey(key: string | symbol, length: number): boolean {
  if (typeof key === "symbol") return false;
  if (key === ARRAY_LENGTH_KEY) return true;

  const index = Number(key);

  return Number.isInteger(index) && index >= 0 && index < length && String(index) === key;
}

function actionAccept(state: SettingsAppState): SettingsAppActionResult {
  return Object.freeze({
    ok: true,
    state,
  });
}

function actionReject(errorValue: SettingsAppError, state: SettingsAppState): SettingsAppActionResult {
  return Object.freeze({
    error: errorValue,
    ok: false,
    state,
  });
}

function valueAccept<T>(value: T, state: SettingsAppState): SettingsAppValueActionResult<T> {
  return Object.freeze({
    ok: true,
    state,
    value,
  });
}

function valueReject<T>(errorValue: SettingsAppError, state: SettingsAppState): SettingsAppValueActionResult<T> {
  return Object.freeze({
    error: errorValue,
    ok: false,
    state,
  });
}

function accept<T>(value: T): SettingsAppViewModelResult<T> {
  return Object.freeze({
    ok: true,
    value,
  });
}

function reject<T>(code: string, message: string, path: string): SettingsAppViewModelResult<T> {
  return Object.freeze({
    error: error(code, message, path),
    ok: false,
  });
}

function hostError(errorValue: DesktopHostError): SettingsAppError {
  return error(errorValue.code, errorValue.message, errorValue.path);
}

function error(code: string, message: string, path: string): SettingsAppError {
  return Object.freeze({
    code,
    message,
    path,
  });
}

function pathToken(value: string): string {
  return value.replaceAll("~", "~0").replaceAll("/", "~1");
}
