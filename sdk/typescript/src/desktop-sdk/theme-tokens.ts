export type VitaThemeVariant = "light" | "dark" | "graphite";
export type VitaThemeTokenGroup = "color" | "space" | "type" | "elevation" | "motion" | "font";
export type VitaThemeTokenMap = Readonly<Record<string, string>>;

export interface VitaThemeTokenGroups {
  readonly color: VitaThemeTokenMap;
  readonly space: VitaThemeTokenMap;
  readonly type: VitaThemeTokenMap;
  readonly elevation: VitaThemeTokenMap;
  readonly motion: VitaThemeTokenMap;
  readonly font: VitaThemeTokenMap;
}

export interface VitaThemeTokens extends VitaThemeTokenGroups {
  readonly variants: {
    readonly light: VitaThemeTokenGroups;
    readonly dark: VitaThemeTokenGroups;
    readonly graphite: VitaThemeTokenGroups;
  };
}

export interface VitaThemeTokenCssSources {
  readonly colors: string;
  readonly spacing: string;
  readonly typography: string;
  readonly elevation: string;
  readonly motion: string;
  readonly fonts: string;
}

type VitaThemeTokenCssFile = keyof VitaThemeTokenCssSources;

type MutableTokenGroups = Record<VitaThemeTokenGroup, Record<string, string>>;

const TOKEN_GROUPS = Object.freeze([
  "color",
  "space",
  "type",
  "elevation",
  "motion",
  "font",
] satisfies readonly VitaThemeTokenGroup[]);

const TOKEN_FILES = Object.freeze([
  "colors",
  "spacing",
  "typography",
  "elevation",
  "motion",
  "fonts",
] satisfies readonly VitaThemeTokenCssFile[]);

const LIGHT_TOKENS = Object.freeze({
  color: tokenMap({
    "blue-50": "#eef4fb",
    "blue-100": "#d6e6f7",
    "blue-200": "#aecbef",
    "blue-300": "#7faae2",
    "blue-400": "#4f9dff",
    "blue-500": "#3178c6",
    "blue-600": "#2a68ac",
    "blue-700": "#23568c",
    "blue-800": "#1d456f",
    "blue-900": "#163350",
    "ink-0": "#ffffff",
    "ink-25": "#f9fafb",
    "ink-50": "#eef1f6",
    "ink-100": "#e1e5ea",
    "ink-150": "#cdd5e0",
    "ink-200": "#aeb8c6",
    "ink-300": "#8a94a3",
    "ink-400": "#6b7787",
    "ink-500": "#4b5563",
    "ink-600": "#2f3744",
    "ink-700": "#1f242c",
    "ink-800": "#15191f",
    "ink-900": "#0f1217",
    "ink-950": "#0a0d12",
    "green-500": "#1f8a5b",
    "green-bright": "#5bbf86",
    "amber-500": "#b5772b",
    "amber-bright": "#e0a86b",
    "red-500": "#c44a4a",
    "red-bright": "#f08a8a",
    "surface-base": "#eef1f6",
    "surface": "#ffffff",
    "surface-raised": "#ffffff",
    "surface-sunken": "#f7f8fa",
    "surface-inset": "#f4f6f8",
    "surface-translucent": "rgba(255,255,255,.72)",
    "surface-overlay": "rgba(255,255,255,.82)",
    "border": "#e6e8ec",
    "border-strong": "#d4d8de",
    "hairline": "rgba(20,24,31,.08)",
    "text": "#14171c",
    "text-secondary": "#4b5563",
    "text-muted": "#8a94a3",
    "text-faint": "#aeb6c2",
    "accent": "#3178c6",
    "accent-hover": "#2a68ac",
    "accent-active": "#23568c",
    "accent-subtle": "rgba(49,120,198,.10)",
    "accent-fg": "#ffffff",
    "success": "#1f8a5b",
    "success-subtle": "rgba(31,138,91,.12)",
    "warning": "#b5772b",
    "warning-subtle": "rgba(181,119,43,.12)",
    "danger": "#c44a4a",
    "danger-subtle": "rgba(196,74,74,.12)",
    "info": "#3178c6",
    "focus-ring": "rgba(49,120,198,.45)",
    "syn-comment": "#8a94a3",
    "syn-keyword": "#8250df",
    "syn-string": "#2f8f5b",
    "syn-number": "#b5532b",
    "syn-fn": "#3178c6",
    "syn-ident": "#1b1f24",
    "syn-punct": "#5a6573",
  }),
  space: tokenMap({
    "space-0": "0",
    "space-0-5": "2px",
    "space-1": "4px",
    "space-2": "8px",
    "space-3": "12px",
    "space-4": "16px",
    "space-5": "20px",
    "space-6": "24px",
    "space-8": "32px",
    "space-10": "40px",
    "space-12": "48px",
    "space-16": "64px",
    "space-20": "80px",
    "radius-xs": "4px",
    "radius-sm": "6px",
    "radius-md": "8px",
    "radius-lg": "12px",
    "radius-xl": "16px",
    "radius-2xl": "20px",
    "radius-pill": "999px",
    "radius-window": "13px",
    "radius-tile": "13px",
    "radius-control": "8px",
    "stroke": "1px",
    "stroke-2": "1.5px",
    "size-control-sm": "28px",
    "size-control": "34px",
    "size-control-lg": "40px",
    "size-dock-tile": "48px",
    "size-app-tile": "52px",
    "size-touch": "44px",
    "menubar-h": "34px",
    "statusbar-h": "26px",
  }),
  type: tokenMap({
    "fs-display": "48px",
    "lh-display": "1.05",
    "tr-display": "-0.025em",
    "fs-h1": "32px",
    "lh-h1": "1.15",
    "tr-h1": "-0.02em",
    "fs-h2": "24px",
    "lh-h2": "1.2",
    "tr-h2": "-0.015em",
    "fs-h3": "19px",
    "lh-h3": "1.3",
    "tr-h3": "-0.01em",
    "fs-title": "16px",
    "lh-title": "1.35",
    "fs-body-lg": "16px",
    "fs-body": "14px",
    "fs-body-sm": "13px",
    "lh-body": "1.55",
    "fs-label": "12px",
    "lh-label": "1.3",
    "fs-caption": "11px",
    "fs-code": "12.5px",
    "lh-code": "1.7",
    "fs-code-sm": "11.5px",
    "fs-overline": "10.5px",
    "tr-overline": "0.12em",
    "fw-light": "300",
    "fw-regular": "400",
    "fw-medium": "500",
    "fw-semibold": "600",
    "fw-bold": "700",
  }),
  elevation: tokenMap({
    "blur-thin": "blur(12px)",
    "blur": "blur(20px)",
    "blur-thick": "blur(30px) saturate(1.4)",
    "shadow-0": "none",
    "shadow-1": "0 1px 2px rgba(20,30,50,.06),0 1px 1px rgba(20,30,50,.04)",
    "shadow-2": "0 2px 6px rgba(20,30,50,.08)",
    "shadow-3": "0 8px 22px -8px rgba(20,30,50,.16)",
    "shadow-4": "0 20px 44px -16px rgba(20,30,50,.22)",
    "shadow-window": "0 30px 60px -22px rgba(20,30,50,.30),0 8px 18px -10px rgba(20,30,50,.14)",
    "shadow-popover": "0 40px 80px -24px rgba(20,30,50,.34)",
    "glow-accent": "none",
  }),
  motion: tokenMap({
    "dur-instant": "80ms",
    "dur-fast": "120ms",
    "dur-base": "200ms",
    "dur-slow": "320ms",
    "dur-slower": "480ms",
    "ease-standard": "cubic-bezier(.2,0,0,1)",
    "ease-decelerate": "cubic-bezier(0,0,0,1)",
    "ease-accelerate": "cubic-bezier(.3,0,1,1)",
    "ease-spring": "cubic-bezier(.5,1.4,.4,1)",
  }),
  font: tokenMap({
    "font-sans": "'Geist','SF Pro Display',system-ui,-apple-system,sans-serif",
    "font-mono": "'Geist Mono','SF Mono',ui-monospace,'JetBrains Mono',monospace",
  }),
}) satisfies VitaThemeTokenGroups;

const DARK_TOKEN_OVERRIDES = Object.freeze({
  color: tokenMap({
    "surface-base": "#0e1116",
    "surface": "#161a21",
    "surface-raised": "#1c222b",
    "surface-sunken": "#11151b",
    "surface-inset": "#1b212b",
    "surface-translucent": "rgba(16,20,27,.55)",
    "surface-overlay": "rgba(28,34,43,.80)",
    "border": "rgba(255,255,255,.07)",
    "border-strong": "rgba(255,255,255,.12)",
    "hairline": "rgba(255,255,255,.06)",
    "text": "#e6e9ef",
    "text-secondary": "#aeb8c6",
    "text-muted": "#8b97a6",
    "text-faint": "#6b7787",
    "accent": "#4f9dff",
    "accent-hover": "#6fb0ff",
    "accent-active": "#3f8de8",
    "accent-subtle": "rgba(79,157,255,.14)",
    "accent-fg": "#07101c",
    "success": "#5bbf86",
    "success-subtle": "rgba(91,191,134,.16)",
    "warning": "#e0a86b",
    "warning-subtle": "rgba(224,168,107,.16)",
    "danger": "#f08a8a",
    "danger-subtle": "rgba(240,138,138,.16)",
    "info": "#4f9dff",
    "focus-ring": "rgba(79,157,255,.50)",
    "syn-comment": "#5d6877",
    "syn-keyword": "#c08bff",
    "syn-string": "#5bbf86",
    "syn-number": "#e0a86b",
    "syn-fn": "#7fd99a",
    "syn-ident": "#cdd5e0",
    "syn-punct": "#6b7787",
  }),
  space: tokenMap({}),
  type: tokenMap({}),
  elevation: tokenMap({
    "shadow-1": "0 1px 2px rgba(0,0,0,.40)",
    "shadow-2": "0 2px 8px rgba(0,0,0,.40)",
    "shadow-3": "0 10px 24px -10px rgba(0,0,0,.50)",
    "shadow-4": "0 20px 48px -18px rgba(0,0,0,.60)",
    "shadow-window": "0 40px 80px -28px rgba(0,0,0,.70),0 10px 24px -12px rgba(0,0,0,.50)",
    "shadow-popover": "0 40px 80px -24px rgba(0,0,0,.60)",
    "glow-accent": "0 0 18px -2px rgba(79,157,255,.50)",
  }),
  motion: tokenMap({}),
  font: tokenMap({}),
}) satisfies VitaThemeTokenGroups;

const GRAPHITE_TOKEN_OVERRIDES = Object.freeze({
  color: tokenMap({
    "surface-base": "#0f1217",
    "surface": "#13171d",
    "surface-raised": "#171c23",
  }),
  space: tokenMap({
    "radius-window": "var(--radius-xs)",
    "radius-tile": "var(--radius-xs)",
  }),
  type: tokenMap({}),
  elevation: tokenMap({}),
  motion: tokenMap({}),
  font: tokenMap({}),
}) satisfies VitaThemeTokenGroups;

export const themeTokens = Object.freeze({
  ...LIGHT_TOKENS,
  variants: Object.freeze({
    light: LIGHT_TOKENS,
    dark: mergeTokenGroups(LIGHT_TOKENS, DARK_TOKEN_OVERRIDES),
    graphite: mergeTokenGroups(LIGHT_TOKENS, DARK_TOKEN_OVERRIDES, GRAPHITE_TOKEN_OVERRIDES),
  }),
}) satisfies VitaThemeTokens;

type TokenNamesIn<T extends VitaThemeTokenGroups> =
  | keyof T["color"]
  | keyof T["space"]
  | keyof T["type"]
  | keyof T["elevation"]
  | keyof T["motion"]
  | keyof T["font"];

export type VitaThemeTokenName = Extract<TokenNamesIn<typeof LIGHT_TOKENS>, string>;
export type VitaThemeCssVariableName = `--${VitaThemeTokenName}`;
export type VitaThemeVarReference<Name extends string = VitaThemeTokenName> = `var(--${Name})`;

export function themeVar(name: VitaThemeTokenName | VitaThemeCssVariableName): string {
  const tokenName = name.startsWith("--") ? name.slice(2) : name;

  return `var(--${tokenName})`;
}

export function parseVitaThemeTokensCss(sources: VitaThemeTokenCssSources): VitaThemeTokens {
  const light = createMutableTokenGroups();
  const darkOverrides = createMutableTokenGroups();
  const graphiteOverrides = createMutableTokenGroups();

  for (const file of TOKEN_FILES) {
    parseCssTokenFile(file, sources[file], light, darkOverrides, graphiteOverrides);
  }

  const lightTokens = freezeTokenGroups(light);
  const darkTokens = mergeTokenGroups(lightTokens, freezeTokenGroups(darkOverrides));
  const graphiteTokens = mergeTokenGroups(lightTokens, freezeTokenGroups(darkOverrides), freezeTokenGroups(graphiteOverrides));

  return Object.freeze({
    ...lightTokens,
    variants: Object.freeze({
      light: lightTokens,
      dark: darkTokens,
      graphite: graphiteTokens,
    }),
  });
}

function tokenMap<const T extends Record<string, string>>(tokens: T): Readonly<T> {
  return Object.freeze(tokens);
}

function parseCssTokenFile(
  file: VitaThemeTokenCssFile,
  css: string,
  light: MutableTokenGroups,
  darkOverrides: MutableTokenGroups,
  graphiteOverrides: MutableTokenGroups,
): void {
  const strippedCss = css.replace(/\/\*[\s\S]*?\*\//gu, "");
  const blockPattern = /([^{}]+)\{([^{}]*)\}/gu;

  for (const blockMatch of strippedCss.matchAll(blockPattern)) {
    const rawSelector = blockMatch[1];
    const body = blockMatch[2];

    if (rawSelector === undefined || body === undefined) continue;

    const selector = rawSelector.trim();
    const target = targetForSelector(selector, light, darkOverrides, graphiteOverrides);

    if (target === null) continue;

    const declarationPattern = /(--[-A-Za-z0-9_]+)\s*:\s*([^;]+);/gu;

    for (const declarationMatch of body.matchAll(declarationPattern)) {
      const rawName = declarationMatch[1];
      const rawValue = declarationMatch[2];

      if (rawName === undefined || rawValue === undefined) continue;

      const name = rawName.slice(2);
      defineToken(target[groupForToken(file, name)], name, rawValue.trim());
    }
  }
}

function targetForSelector(
  selector: string,
  light: MutableTokenGroups,
  darkOverrides: MutableTokenGroups,
  graphiteOverrides: MutableTokenGroups,
): MutableTokenGroups | null {
  if (selector === ":root") return light;
  if (selector === ".theme-dark") return darkOverrides;
  if (selector === ".mode-tiling") return graphiteOverrides;

  return null;
}

function groupForToken(file: VitaThemeTokenCssFile, name: string): VitaThemeTokenGroup {
  if (name.startsWith("font-")) return "font";

  if (file === "colors") {
    if (
      name.startsWith("radius-")
      || name.startsWith("space-")
      || name === "stroke"
      || name.startsWith("stroke-")
      || name.startsWith("size-")
      || name.endsWith("-h")
    ) {
      return "space";
    }

    return "color";
  }

  if (file === "spacing") return "space";
  if (file === "typography") return "type";
  if (file === "elevation") return "elevation";
  if (file === "motion") return "motion";

  return "font";
}

function createMutableTokenGroups(): MutableTokenGroups {
  return {
    color: {},
    space: {},
    type: {},
    elevation: {},
    motion: {},
    font: {},
  };
}

function mergeTokenGroups(...groups: readonly VitaThemeTokenGroups[]): VitaThemeTokenGroups {
  const merged = createMutableTokenGroups();

  for (const group of groups) {
    for (const tokenGroup of TOKEN_GROUPS) {
      copyTokens(group[tokenGroup], merged[tokenGroup]);
    }
  }

  return freezeTokenGroups(merged);
}

function freezeTokenGroups(groups: MutableTokenGroups): VitaThemeTokenGroups {
  return Object.freeze({
    color: freezeTokenMap(groups.color),
    space: freezeTokenMap(groups.space),
    type: freezeTokenMap(groups.type),
    elevation: freezeTokenMap(groups.elevation),
    motion: freezeTokenMap(groups.motion),
    font: freezeTokenMap(groups.font),
  });
}

function copyTokens(source: VitaThemeTokenMap, target: Record<string, string>): void {
  for (const name of Object.keys(source)) {
    const value = source[name];

    if (value !== undefined) defineToken(target, name, value);
  }
}

function freezeTokenMap(source: Record<string, string>): VitaThemeTokenMap {
  const output: Record<string, string> = {};

  copyTokens(source, output);

  return Object.freeze(output);
}

function defineToken(target: Record<string, string>, name: string, value: string): void {
  Object.defineProperty(target, name, {
    configurable: true,
    enumerable: true,
    value,
    writable: true,
  });
}
