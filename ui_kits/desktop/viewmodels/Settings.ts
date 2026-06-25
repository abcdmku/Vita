import type {
  DesktopHost,
  DesktopHostError,
  DesktopTheme,
} from "../../../sdk/typescript/src/desktop-sdk/index.ts";

export const SETTINGS_APPEARANCE_KEYS = Object.freeze({
  accent: "appearance.accent",
  activeSection: "settings.activeSection",
  layout: "appearance.layout",
  theme: "appearance.theme",
});

export const SETTINGS_SECTIONS = Object.freeze([
  Object.freeze({ group: "system", icon: "settings-2", id: "general", label: "General" }),
  Object.freeze({ group: "system", icon: "sun-moon", id: "appearance", label: "Appearance" }),
  Object.freeze({ group: "system", icon: "wifi", id: "network", label: "Network" }),
  Object.freeze({ group: "system", icon: "volume-2", id: "sound", label: "Sound" }),
  Object.freeze({ group: "system", icon: "monitor", id: "display", label: "Display" }),
  Object.freeze({ group: "account", icon: "circle-user", id: "accounts", label: "Accounts" }),
  Object.freeze({ group: "account", icon: "shield-check", id: "privacy", label: "Privacy" }),
  Object.freeze({ group: "advanced", icon: "terminal", id: "developer", label: "Developer" }),
] as const);

export const SETTINGS_THEMES = Object.freeze(["light", "dark", "graphite"] as const);
export const SETTINGS_LAYOUTS = Object.freeze(["comfortable", "compact", "floating", "tiling"] as const);

export const SETTINGS_ACCENT_OPTIONS = Object.freeze([
  Object.freeze({ color: "#3178c6", id: "blue", label: "Blue" }),
  Object.freeze({ color: "#14b8a6", id: "teal", label: "Teal" }),
  Object.freeze({ color: "#8b5cf6", id: "violet", label: "Violet" }),
  Object.freeze({ color: "#f97316", id: "orange", label: "Orange" }),
  Object.freeze({ color: "#10b981", id: "green", label: "Green" }),
] as const);

export type SettingsSectionId = typeof SETTINGS_SECTIONS[number]["id"];
export type SettingsSectionGroup = typeof SETTINGS_SECTIONS[number]["group"];
export type SettingsTheme = typeof SETTINGS_THEMES[number];
export type SettingsAccent = typeof SETTINGS_ACCENT_OPTIONS[number]["id"];
export type SettingsLayout = typeof SETTINGS_LAYOUTS[number];

export interface SettingsSidebarSection {
  readonly group: SettingsSectionGroup;
  readonly icon: string;
  readonly id: SettingsSectionId;
  readonly label: string;
  readonly active: boolean;
}

export interface SettingsAccentOption {
  readonly color: string;
  readonly id: SettingsAccent;
  readonly label: string;
  readonly active: boolean;
}

export interface SettingsAppearanceState {
  readonly theme: SettingsTheme;
  readonly accent: SettingsAccent;
  readonly accentColor: string;
  readonly layout: SettingsLayout;
  readonly tiling: boolean;
  readonly density: "comfortable" | "compact";
}

export interface SettingsThemeSnapshot {
  readonly id: string;
  readonly version: string;
  readonly tokens: DesktopTheme["tokens"];
}

export interface SettingsViewModelPorts {
  readonly readSetting?: DesktopHost["readSetting"];
  readonly applySetting?: DesktopHost["applySetting"];
  readTheme: DesktopHost["readTheme"];
}

export interface SettingsViewModelState {
  readonly sections: readonly SettingsSidebarSection[];
  readonly activeSection: SettingsSectionId;
  readonly appearance: SettingsAppearanceState;
  readonly accentOptions: readonly SettingsAccentOption[];
  readonly theme: SettingsThemeSnapshot;
}

export interface SettingsViewModelError {
  readonly code: string;
  readonly message: string;
  readonly path: string;
}

export type SettingsViewModelResult<T> =
  | {
      readonly ok: true;
      readonly value: T;
    }
  | {
      readonly ok: false;
      readonly error: SettingsViewModelError;
    };

export type SettingsViewModelActionResult =
  | {
      readonly ok: true;
      readonly state: SettingsViewModelState;
    }
  | {
      readonly ok: false;
      readonly error: SettingsViewModelError;
      readonly state: SettingsViewModelState;
    };

export interface SettingsViewModel {
  readonly state: SettingsViewModelState;
  select(section: string): Promise<SettingsViewModelActionResult>;
  setTheme(theme: string): Promise<SettingsViewModelActionResult>;
  setAccent(accent: string): Promise<SettingsViewModelActionResult>;
  setLayout(layout: string): Promise<SettingsViewModelActionResult>;
}

export async function createSettingsViewModel(
  host: SettingsViewModelPorts,
): Promise<SettingsViewModelResult<SettingsViewModel>> {
  const theme = readThemeSnapshot(host);

  if (!theme.ok) return theme;

  const activeSection = await readEnumSetting(
    host,
    SETTINGS_APPEARANCE_KEYS.activeSection,
    "/activeSection",
    "UNKNOWN_SETTINGS_SECTION",
    "settings section is not supported.",
    isSettingsSectionId,
  );

  if (!activeSection.ok) return activeSection;

  const appearanceTheme = await readEnumSetting(
    host,
    SETTINGS_APPEARANCE_KEYS.theme,
    "/appearance/theme",
    "UNKNOWN_THEME",
    "appearance theme is not supported.",
    isSettingsTheme,
  );

  if (!appearanceTheme.ok) return appearanceTheme;

  const accent = await readEnumSetting(
    host,
    SETTINGS_APPEARANCE_KEYS.accent,
    "/appearance/accent",
    "UNKNOWN_ACCENT",
    "accent color is not supported.",
    isSettingsAccent,
  );

  if (!accent.ok) return accent;

  const layout = await readEnumSetting(
    host,
    SETTINGS_APPEARANCE_KEYS.layout,
    "/appearance/layout",
    "UNKNOWN_LAYOUT",
    "layout mode is not supported.",
    isSettingsLayout,
  );

  if (!layout.ok) return layout;

  return accept(new DesktopSettingsViewModel(host, freezeState({
    accent: accent.value,
    activeSection: activeSection.value,
    layout: layout.value,
    theme: appearanceTheme.value,
    themeSnapshot: theme.value,
  })));
}

class DesktopSettingsViewModel implements SettingsViewModel {
  readonly #host: SettingsViewModelPorts;
  #state: SettingsViewModelState;

  constructor(host: SettingsViewModelPorts, state: SettingsViewModelState) {
    this.#host = host;
    this.#state = state;
  }

  get state(): SettingsViewModelState {
    return this.#state;
  }

  async select(section: string): Promise<SettingsViewModelActionResult> {
    if (!isSettingsSectionId(section)) {
      return actionReject("UNKNOWN_SETTINGS_SECTION", "settings section is not supported.", "/activeSection", this.#state);
    }

    const written = await writeSetting(this.#host, SETTINGS_APPEARANCE_KEYS.activeSection, section, "/activeSection");

    if (!written.ok) return actionRejectFromError(written.error, this.#state);

    this.#state = freezeState({
      accent: this.#state.appearance.accent,
      activeSection: section,
      layout: this.#state.appearance.layout,
      theme: this.#state.appearance.theme,
      themeSnapshot: this.#state.theme,
    });

    return actionAccept(this.#state);
  }

  async setTheme(theme: string): Promise<SettingsViewModelActionResult> {
    if (!isSettingsTheme(theme)) {
      return actionReject("UNKNOWN_THEME", "appearance theme is not supported.", "/appearance/theme", this.#state);
    }

    return this.#setAppearanceValue(SETTINGS_APPEARANCE_KEYS.theme, theme, "/appearance/theme", {
      accent: this.#state.appearance.accent,
      layout: this.#state.appearance.layout,
      theme,
    });
  }

  async setAccent(accent: string): Promise<SettingsViewModelActionResult> {
    if (!isSettingsAccent(accent)) {
      return actionReject("UNKNOWN_ACCENT", "accent color is not supported.", "/appearance/accent", this.#state);
    }

    return this.#setAppearanceValue(SETTINGS_APPEARANCE_KEYS.accent, accent, "/appearance/accent", {
      accent,
      layout: this.#state.appearance.layout,
      theme: this.#state.appearance.theme,
    });
  }

  async setLayout(layout: string): Promise<SettingsViewModelActionResult> {
    if (!isSettingsLayout(layout)) {
      return actionReject("UNKNOWN_LAYOUT", "layout mode is not supported.", "/appearance/layout", this.#state);
    }

    return this.#setAppearanceValue(SETTINGS_APPEARANCE_KEYS.layout, layout, "/appearance/layout", {
      accent: this.#state.appearance.accent,
      layout,
      theme: this.#state.appearance.theme,
    });
  }

  async #setAppearanceValue(
    key: string,
    value: SettingsTheme | SettingsAccent | SettingsLayout,
    path: string,
    next: {
      readonly accent: SettingsAccent;
      readonly layout: SettingsLayout;
      readonly theme: SettingsTheme;
    },
  ): Promise<SettingsViewModelActionResult> {
    const written = await writeSetting(this.#host, key, value, path);

    if (!written.ok) return actionRejectFromError(written.error, this.#state);

    this.#state = freezeState({
      accent: next.accent,
      activeSection: this.#state.activeSection,
      layout: next.layout,
      theme: next.theme,
      themeSnapshot: this.#state.theme,
    });

    return actionAccept(this.#state);
  }
}

async function readEnumSetting<T extends string>(
  host: SettingsViewModelPorts,
  key: string,
  path: string,
  code: string,
  message: string,
  guard: (value: string) => value is T,
): Promise<SettingsViewModelResult<T>> {
  const readSetting = host.readSetting;

  if (readSetting === undefined) {
    return reject("SETTINGS_PORT_UNAVAILABLE", "settings read port is unavailable.", path);
  }

  let result: Awaited<ReturnType<NonNullable<DesktopHost["readSetting"]>>>;

  try {
    result = await readSetting(Object.freeze({ key }));
  } catch {
    return reject("SETTINGS_READ_FAILED", "settings read failed closed.", path);
  }

  if (!result.ok) return rejectFromHost(result.error);
  if (typeof result.value !== "string" || !guard(result.value)) {
    return reject(code, message, path);
  }

  return accept(result.value);
}

async function writeSetting(
  host: SettingsViewModelPorts,
  key: string,
  value: SettingsTheme | SettingsAccent | SettingsLayout | SettingsSectionId,
  path: string,
): Promise<SettingsViewModelResult<true>> {
  const applySetting = host.applySetting;

  if (applySetting === undefined) {
    return reject("SETTINGS_PORT_UNAVAILABLE", "settings write port is unavailable.", path);
  }

  let result: Awaited<ReturnType<NonNullable<DesktopHost["applySetting"]>>>;

  try {
    result = await applySetting(Object.freeze({ key, value }));
  } catch {
    return reject("SETTINGS_WRITE_FAILED", "settings write failed closed.", path);
  }

  if (!result.ok) return rejectFromHost(result.error);

  return accept(true);
}

function readThemeSnapshot(host: SettingsViewModelPorts): SettingsViewModelResult<SettingsThemeSnapshot> {
  try {
    const theme = host.readTheme();

    if (!isThemeLike(theme)) {
      return reject("THEME_PORT_MALFORMED", "theme port returned malformed tokens.", "/theme");
    }

    return accept(Object.freeze({
      id: theme.id,
      tokens: freezeThemeTokens(theme.tokens),
      version: theme.version,
    }));
  } catch {
    return reject("THEME_PORT_FAILED", "theme port failed closed.", "/theme");
  }
}

function freezeState(input: {
  readonly activeSection: SettingsSectionId;
  readonly accent: SettingsAccent;
  readonly layout: SettingsLayout;
  readonly theme: SettingsTheme;
  readonly themeSnapshot: SettingsThemeSnapshot;
}): SettingsViewModelState {
  const appearance = freezeAppearance(input.theme, input.accent, input.layout);

  return Object.freeze({
    accentOptions: freezeAccentOptions(input.accent),
    activeSection: input.activeSection,
    appearance,
    sections: freezeSections(input.activeSection),
    theme: input.themeSnapshot,
  });
}

function freezeAppearance(theme: SettingsTheme, accent: SettingsAccent, layout: SettingsLayout): SettingsAppearanceState {
  return Object.freeze({
    accent,
    accentColor: accentColor(accent),
    density: layout === "compact" || layout === "tiling" ? "compact" : "comfortable",
    layout,
    theme,
    tiling: layout === "tiling",
  });
}

function freezeSections(activeSection: SettingsSectionId): readonly SettingsSidebarSection[] {
  const sections: SettingsSidebarSection[] = [];

  for (let index = 0; index < SETTINGS_SECTIONS.length; index += 1) {
    const section = SETTINGS_SECTIONS[index];

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

function freezeAccentOptions(activeAccent: SettingsAccent): readonly SettingsAccentOption[] {
  const options: SettingsAccentOption[] = [];

  for (let index = 0; index < SETTINGS_ACCENT_OPTIONS.length; index += 1) {
    const option = SETTINGS_ACCENT_OPTIONS[index];

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

function isThemeLike(value: unknown): value is DesktopTheme {
  if (value === null || typeof value !== "object") return false;

  const theme = value as {
    readonly id?: unknown;
    readonly tokens?: unknown;
    readonly version?: unknown;
  };

  if (typeof theme.id !== "string" || theme.id.length === 0) return false;
  if (typeof theme.version !== "string" || theme.version.length === 0) return false;

  return isThemeTokensLike(theme.tokens);
}

function isThemeTokensLike(value: unknown): value is DesktopTheme["tokens"] {
  if (value === null || typeof value !== "object") return false;

  const tokens = value as {
    readonly colors?: unknown;
    readonly radii?: unknown;
    readonly spacing?: unknown;
    readonly typography?: unknown;
  };

  return (
    isRecord(tokens.colors) &&
    isRecord(tokens.radii) &&
    isRecord(tokens.spacing) &&
    isRecord(tokens.typography)
  );
}

function freezeThemeTokens(tokens: DesktopTheme["tokens"]): DesktopTheme["tokens"] {
  return Object.freeze({
    colors: Object.freeze({ ...tokens.colors }),
    radii: Object.freeze({ ...tokens.radii }),
    spacing: Object.freeze({ ...tokens.spacing }),
    typography: Object.freeze({ ...tokens.typography }),
  });
}

function isRecord(value: unknown): value is Readonly<Record<string, string | number>> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isSettingsSectionId(value: string): value is SettingsSectionId {
  for (let index = 0; index < SETTINGS_SECTIONS.length; index += 1) {
    if (SETTINGS_SECTIONS[index]?.id === value) return true;
  }

  return false;
}

function isSettingsTheme(value: string): value is SettingsTheme {
  return contains(SETTINGS_THEMES, value);
}

function isSettingsAccent(value: string): value is SettingsAccent {
  for (let index = 0; index < SETTINGS_ACCENT_OPTIONS.length; index += 1) {
    if (SETTINGS_ACCENT_OPTIONS[index]?.id === value) return true;
  }

  return false;
}

function isSettingsLayout(value: string): value is SettingsLayout {
  return contains(SETTINGS_LAYOUTS, value);
}

function contains<T extends string>(values: readonly T[], value: string): value is T {
  for (let index = 0; index < values.length; index += 1) {
    if (values[index] === value) return true;
  }

  return false;
}

function accentColor(accent: SettingsAccent): string {
  for (let index = 0; index < SETTINGS_ACCENT_OPTIONS.length; index += 1) {
    const option = SETTINGS_ACCENT_OPTIONS[index];

    if (option !== undefined && option.id === accent) return option.color;
  }

  return "#3178c6";
}

function actionAccept(state: SettingsViewModelState): SettingsViewModelActionResult {
  return Object.freeze({
    ok: true,
    state,
  });
}

function actionReject(
  code: string,
  message: string,
  path: string,
  state: SettingsViewModelState,
): SettingsViewModelActionResult {
  return Object.freeze({
    error: Object.freeze({ code, message, path }),
    ok: false,
    state,
  });
}

function actionRejectFromError(
  error: SettingsViewModelError,
  state: SettingsViewModelState,
): SettingsViewModelActionResult {
  return Object.freeze({
    error,
    ok: false,
    state,
  });
}

function accept<T>(value: T): SettingsViewModelResult<T> {
  return Object.freeze({
    ok: true,
    value,
  });
}

function reject<T>(code: string, message: string, path: string): SettingsViewModelResult<T> {
  return Object.freeze({
    error: Object.freeze({
      code,
      message,
      path,
    }),
    ok: false,
  });
}

function rejectFromHost<T>(error: DesktopHostError): SettingsViewModelResult<T> {
  return reject(error.code, error.message, error.path);
}
