import {
  themeTokens,
} from "../../../sdk/typescript/src/desktop-sdk/index.ts";
import type {
  DesktopHost,
  DesktopHostError,
  VitaThemeTokenGroups,
  VitaThemeTokenMap,
  VitaThemeVariant,
} from "../../../sdk/typescript/src/desktop-sdk/index.ts";

export const THEME_APPEARANCE_SETTING_KEYS = Object.freeze({
  accent: "appearance.accent",
  layout: "appearance.layout",
  theme: "appearance.theme",
});

export const THEME_SETTING_KEYS = THEME_APPEARANCE_SETTING_KEYS;

export const THEME_VARIANTS = Object.freeze([
  "light",
  "dark",
  "graphite",
] as const satisfies readonly VitaThemeVariant[]);

const BLUE_ACCENT = Object.freeze({
  active: "#23568c",
  color: "#3178c6",
  focusRing: "rgba(49,120,198,.45)",
  hover: "#2a68ac",
  id: "blue",
  label: "Blue",
  subtle: "rgba(49,120,198,.10)",
});

export const THEME_ACCENT_OPTIONS = Object.freeze([
  BLUE_ACCENT,
  Object.freeze({
    active: "#0f766e",
    color: "#14b8a6",
    focusRing: "rgba(20,184,166,.45)",
    hover: "#0d9488",
    id: "teal",
    label: "Teal",
    subtle: "rgba(20,184,166,.12)",
  }),
  Object.freeze({
    active: "#6d28d9",
    color: "#8b5cf6",
    focusRing: "rgba(139,92,246,.45)",
    hover: "#7c3aed",
    id: "violet",
    label: "Violet",
    subtle: "rgba(139,92,246,.12)",
  }),
  Object.freeze({
    active: "#c2410c",
    color: "#f97316",
    focusRing: "rgba(249,115,22,.45)",
    hover: "#ea580c",
    id: "orange",
    label: "Orange",
    subtle: "rgba(249,115,22,.13)",
  }),
  Object.freeze({
    active: "#047857",
    color: "#10b981",
    focusRing: "rgba(16,185,129,.45)",
    hover: "#059669",
    id: "green",
    label: "Green",
    subtle: "rgba(16,185,129,.12)",
  }),
] as const);

export const THEME_LAYOUTS = Object.freeze([
  "comfortable",
  "compact",
  "floating",
  "tiling",
] as const);

const EMPTY_TOKEN_MAP: VitaThemeTokenMap = Object.freeze({});

export type ThemeVariant = typeof THEME_VARIANTS[number];
export type ThemeAccent = typeof THEME_ACCENT_OPTIONS[number]["id"];
export type ThemeLayout = typeof THEME_LAYOUTS[number];
export type ThemeLayoutDensity = "comfortable" | "compact";
export type ThemeScreenClass = "mode-tiling" | "theme-dark" | "v-screen";

export interface ThemeAppearanceState {
  readonly theme: ThemeVariant;
  readonly accent: ThemeAccent;
  readonly accentColor: string;
  readonly layout: ThemeLayout;
  readonly density: ThemeLayoutDensity;
  readonly tiling: boolean;
}

export interface ThemeViewModelState extends ThemeAppearanceState {
  readonly appearance: ThemeAppearanceState;
  readonly tokenVariant: ThemeVariant;
  readonly tokens: VitaThemeTokenGroups;
  readonly tokenOverrides: VitaThemeTokenGroups;
  readonly screenClasses: readonly ThemeScreenClass[];
  readonly screenClassName: string;
}

export interface ThemeViewModelError {
  readonly code: string;
  readonly message: string;
  readonly path: string;
}

export type ThemeViewModelResult<T> =
  | {
      readonly ok: true;
      readonly value: T;
    }
  | {
      readonly ok: false;
      readonly error: ThemeViewModelError;
    };

export type ThemeViewModelActionResult =
  | {
      readonly ok: true;
      readonly state: ThemeViewModelState;
    }
  | {
      readonly ok: false;
      readonly error: ThemeViewModelError;
      readonly state: ThemeViewModelState;
    };

export interface ThemeViewModelPorts {
  readonly readSetting?: NonNullable<DesktopHost["readSetting"]>;
  readonly applySetting?: NonNullable<DesktopHost["applySetting"]>;
}

export interface ThemeViewModel {
  readonly state: ThemeViewModelState;
  snapshot(): ThemeViewModelState;
  setTheme(theme: unknown): Promise<ThemeViewModelActionResult>;
  setAccent(accent: unknown): Promise<ThemeViewModelActionResult>;
  setLayout(layout: unknown): Promise<ThemeViewModelActionResult>;
}

export async function createThemeViewModel(
  ports: ThemeViewModelPorts,
): Promise<ThemeViewModelResult<ThemeViewModel>> {
  const theme = await readAppearanceSetting(
    ports,
    THEME_APPEARANCE_SETTING_KEYS.theme,
    "/appearance/theme",
    "UNKNOWN_THEME",
    "appearance theme is not supported.",
    isThemeVariant,
  );

  if (!theme.ok) return theme;

  const accent = await readAppearanceSetting(
    ports,
    THEME_APPEARANCE_SETTING_KEYS.accent,
    "/appearance/accent",
    "UNKNOWN_ACCENT",
    "accent color is not supported.",
    isThemeAccent,
  );

  if (!accent.ok) return accent;

  const layout = await readAppearanceSetting(
    ports,
    THEME_APPEARANCE_SETTING_KEYS.layout,
    "/appearance/layout",
    "UNKNOWN_LAYOUT",
    "layout mode is not supported.",
    isThemeLayout,
  );

  if (!layout.ok) return layout;

  return accept(new DesktopThemeViewModel(ports, freezeState({
    accent: accent.value,
    layout: layout.value,
    theme: theme.value,
  })));
}

class DesktopThemeViewModel implements ThemeViewModel {
  readonly #ports: ThemeViewModelPorts;
  #state: ThemeViewModelState;

  constructor(ports: ThemeViewModelPorts, state: ThemeViewModelState) {
    this.#ports = ports;
    this.#state = state;
  }

  get state(): ThemeViewModelState {
    return this.#state;
  }

  snapshot(): ThemeViewModelState {
    return this.#state;
  }

  async setTheme(theme: unknown): Promise<ThemeViewModelActionResult> {
    if (typeof theme !== "string" || !isThemeVariant(theme)) {
      return actionReject("UNKNOWN_THEME", "appearance theme is not supported.", "/appearance/theme", this.#state);
    }

    return await this.#setAppearanceValue(THEME_APPEARANCE_SETTING_KEYS.theme, theme, "/appearance/theme", {
      accent: this.#state.accent,
      layout: this.#state.layout,
      theme,
    });
  }

  async setAccent(accent: unknown): Promise<ThemeViewModelActionResult> {
    if (typeof accent !== "string" || !isThemeAccent(accent)) {
      return actionReject("UNKNOWN_ACCENT", "accent color is not supported.", "/appearance/accent", this.#state);
    }

    return await this.#setAppearanceValue(THEME_APPEARANCE_SETTING_KEYS.accent, accent, "/appearance/accent", {
      accent,
      layout: this.#state.layout,
      theme: this.#state.theme,
    });
  }

  async setLayout(layout: unknown): Promise<ThemeViewModelActionResult> {
    if (typeof layout !== "string" || !isThemeLayout(layout)) {
      return actionReject("UNKNOWN_LAYOUT", "layout mode is not supported.", "/appearance/layout", this.#state);
    }

    return await this.#setAppearanceValue(THEME_APPEARANCE_SETTING_KEYS.layout, layout, "/appearance/layout", {
      accent: this.#state.accent,
      layout,
      theme: this.#state.theme,
    });
  }

  async #setAppearanceValue(
    key: string,
    value: ThemeVariant | ThemeAccent | ThemeLayout,
    path: string,
    next: {
      readonly accent: ThemeAccent;
      readonly layout: ThemeLayout;
      readonly theme: ThemeVariant;
    },
  ): Promise<ThemeViewModelActionResult> {
    const written = await writeAppearanceSetting(this.#ports, key, value, path);

    if (!written.ok) return actionRejectFromError(written.error, this.#state);

    this.#state = freezeState(next);

    return actionAccept(this.#state);
  }
}

async function readAppearanceSetting<T extends string>(
  ports: ThemeViewModelPorts,
  key: string,
  path: string,
  code: string,
  message: string,
  guard: (value: string) => value is T,
): Promise<ThemeViewModelResult<T>> {
  const readSetting = ports.readSetting;

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

async function writeAppearanceSetting(
  ports: ThemeViewModelPorts,
  key: string,
  value: ThemeVariant | ThemeAccent | ThemeLayout,
  path: string,
): Promise<ThemeViewModelResult<true>> {
  const applySetting = ports.applySetting;

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

function freezeState(input: {
  readonly accent: ThemeAccent;
  readonly layout: ThemeLayout;
  readonly theme: ThemeVariant;
}): ThemeViewModelState {
  const appearance = freezeAppearance(input.theme, input.accent, input.layout);
  const tokenVariant = input.theme;
  const tokenOverrides = accentTokenOverrides(input.accent);
  const tokens = mergeTokenGroups(themeTokens.variants[tokenVariant], tokenOverrides);
  const screenClasses = screenClassesFor(input.theme, input.layout);

  return Object.freeze({
    accent: appearance.accent,
    accentColor: appearance.accentColor,
    appearance,
    density: appearance.density,
    layout: appearance.layout,
    screenClasses,
    screenClassName: screenClasses.join(" "),
    theme: appearance.theme,
    tiling: appearance.tiling,
    tokenOverrides,
    tokens,
    tokenVariant,
  });
}

function freezeAppearance(
  theme: ThemeVariant,
  accent: ThemeAccent,
  layout: ThemeLayout,
): ThemeAppearanceState {
  return Object.freeze({
    accent,
    accentColor: accentDefinition(accent).color,
    density: densityForLayout(layout),
    layout,
    theme,
    tiling: layout === "tiling",
  });
}

function densityForLayout(layout: ThemeLayout): ThemeLayoutDensity {
  return layout === "compact" || layout === "tiling" ? "compact" : "comfortable";
}

function screenClassesFor(theme: ThemeVariant, layout: ThemeLayout): readonly ThemeScreenClass[] {
  const classes: ThemeScreenClass[] = ["v-screen"];

  if (theme === "dark" || theme === "graphite") {
    classes.push("theme-dark");
  }
  if (theme === "graphite" || layout === "tiling") {
    classes.push("mode-tiling");
  }

  return Object.freeze(classes);
}

function accentTokenOverrides(accent: ThemeAccent): VitaThemeTokenGroups {
  const definition = accentDefinition(accent);

  return Object.freeze({
    color: Object.freeze({
      accent: definition.color,
      "accent-active": definition.active,
      "accent-hover": definition.hover,
      "accent-subtle": definition.subtle,
      "focus-ring": definition.focusRing,
      info: definition.color,
    }),
    elevation: EMPTY_TOKEN_MAP,
    font: EMPTY_TOKEN_MAP,
    motion: EMPTY_TOKEN_MAP,
    space: EMPTY_TOKEN_MAP,
    type: EMPTY_TOKEN_MAP,
  });
}

function mergeTokenGroups(base: VitaThemeTokenGroups, overrides: VitaThemeTokenGroups): VitaThemeTokenGroups {
  return Object.freeze({
    color: mergeTokenMap(base.color, overrides.color),
    elevation: mergeTokenMap(base.elevation, overrides.elevation),
    font: mergeTokenMap(base.font, overrides.font),
    motion: mergeTokenMap(base.motion, overrides.motion),
    space: mergeTokenMap(base.space, overrides.space),
    type: mergeTokenMap(base.type, overrides.type),
  });
}

function mergeTokenMap(base: VitaThemeTokenMap, overrides: VitaThemeTokenMap): VitaThemeTokenMap {
  const output: Record<string, string> = {};

  copyTokenMap(base, output);
  copyTokenMap(overrides, output);

  return Object.freeze(output);
}

function copyTokenMap(source: VitaThemeTokenMap, target: Record<string, string>): void {
  const keys = Object.keys(source);

  for (let index = 0; index < keys.length; index += 1) {
    const key = keys[index];

    if (key === undefined) continue;

    const value = source[key];

    if (value !== undefined) {
      Object.defineProperty(target, key, {
        configurable: true,
        enumerable: true,
        value,
        writable: true,
      });
    }
  }
}

function accentDefinition(accent: ThemeAccent): typeof THEME_ACCENT_OPTIONS[number] {
  for (let index = 0; index < THEME_ACCENT_OPTIONS.length; index += 1) {
    const option = THEME_ACCENT_OPTIONS[index];

    if (option !== undefined && option.id === accent) return option;
  }

  return BLUE_ACCENT;
}

function isThemeVariant(value: string): value is ThemeVariant {
  return contains(THEME_VARIANTS, value);
}

function isThemeAccent(value: string): value is ThemeAccent {
  for (let index = 0; index < THEME_ACCENT_OPTIONS.length; index += 1) {
    if (THEME_ACCENT_OPTIONS[index]?.id === value) return true;
  }

  return false;
}

function isThemeLayout(value: string): value is ThemeLayout {
  return contains(THEME_LAYOUTS, value);
}

function contains<T extends string>(values: readonly T[], value: string): value is T {
  for (let index = 0; index < values.length; index += 1) {
    if (values[index] === value) return true;
  }

  return false;
}

function actionAccept(state: ThemeViewModelState): ThemeViewModelActionResult {
  return Object.freeze({
    ok: true,
    state,
  });
}

function actionReject(
  code: string,
  message: string,
  path: string,
  state: ThemeViewModelState,
): ThemeViewModelActionResult {
  return Object.freeze({
    error: Object.freeze({ code, message, path }),
    ok: false,
    state,
  });
}

function actionRejectFromError(
  error: ThemeViewModelError,
  state: ThemeViewModelState,
): ThemeViewModelActionResult {
  return Object.freeze({
    error,
    ok: false,
    state,
  });
}

function accept<T>(value: T): ThemeViewModelResult<T> {
  return Object.freeze({
    ok: true,
    value,
  });
}

function reject<T>(code: string, message: string, path: string): ThemeViewModelResult<T> {
  return Object.freeze({
    error: Object.freeze({
      code,
      message,
      path,
    }),
    ok: false,
  });
}

function rejectFromHost<T>(error: DesktopHostError): ThemeViewModelResult<T> {
  return reject(error.code, error.message, error.path);
}
