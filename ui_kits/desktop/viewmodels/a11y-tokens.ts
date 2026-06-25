import {
  themeTokens,
  themeVar,
} from "../../../sdk/typescript/src/desktop-sdk/index.ts";
import type {
  VitaThemeTokenName,
} from "../../../sdk/typescript/src/desktop-sdk/index.ts";

import {
  A11Y_CONTRASTS,
  A11Y_NUMERIC_PREFS,
} from "./a11y-prefs.ts";
import type {
  A11yContrast,
  A11yPrefsState,
} from "./a11y-prefs.ts";

export interface A11yTokenDerivation {
  readonly cssVars: Readonly<Record<string, string>>;
  readonly screenClasses: readonly string[];
  readonly tokenOverrides: Readonly<Record<string, string>>;
}

export const DEFAULT_A11Y_TOKEN_PREFS = Object.freeze({
  contrast: "normal",
  cursorSize: 1,
  focusRingThickness: 2,
  reduceMotion: false,
  reduceTransparency: false,
  textScale: 1,
  uiZoom: 1,
}) satisfies A11yPrefsState;

const HIGH_CONTRAST_OVERRIDES = Object.freeze([
  token("blue-50", "#ffffff"),
  token("blue-100", "#e6f1ff"),
  token("blue-200", "#b8d8ff"),
  token("blue-300", "#7fb7ff"),
  token("blue-400", "#006fd6"),
  token("blue-500", "#005a9c"),
  token("blue-600", "#004b82"),
  token("blue-700", "#003a66"),
  token("blue-800", "#002b4d"),
  token("blue-900", "#001c33"),
  token("ink-0", "#ffffff"),
  token("ink-25", "#ffffff"),
  token("ink-50", "#f7f7f7"),
  token("ink-100", "#e6e6e6"),
  token("ink-150", "#c8c8c8"),
  token("ink-200", "#a0a0a0"),
  token("ink-300", "#707070"),
  token("ink-400", "#505050"),
  token("ink-500", "#333333"),
  token("ink-600", "#1f1f1f"),
  token("ink-700", "#141414"),
  token("ink-800", "#0a0a0a"),
  token("ink-900", "#000000"),
  token("ink-950", "#000000"),
  token("green-500", "#0f6f43"),
  token("green-bright", "#0f6f43"),
  token("amber-500", "#8a4f00"),
  token("amber-bright", "#8a4f00"),
  token("red-500", "#a40000"),
  token("red-bright", "#a40000"),
  token("surface-base", "#ffffff"),
  token("surface", "#ffffff"),
  token("surface-raised", "#ffffff"),
  token("surface-sunken", "#f7f7f7"),
  token("surface-inset", "#f7f7f7"),
  token("surface-translucent", "#ffffff"),
  token("surface-overlay", "#ffffff"),
  token("border", "#000000"),
  token("border-strong", "#000000"),
  token("hairline", "#000000"),
  token("text", "#000000"),
  token("text-secondary", "#000000"),
  token("text-muted", "#1f1f1f"),
  token("text-faint", "#333333"),
  token("accent", "#005a9c"),
  token("accent-hover", "#004b82"),
  token("accent-active", "#003a66"),
  token("accent-subtle", "#e6f1ff"),
  token("accent-fg", "#ffffff"),
  token("success", "#0f6f43"),
  token("success-subtle", "#e0f2e8"),
  token("warning", "#8a4f00"),
  token("warning-subtle", "#fff1d6"),
  token("danger", "#a40000"),
  token("danger-subtle", "#ffe1e1"),
  token("info", "#005a9c"),
  token("focus-ring", "#005fcc"),
  token("syn-comment", "#333333"),
  token("syn-keyword", "#4a148c"),
  token("syn-string", "#0f6f43"),
  token("syn-number", "#8a4f00"),
  token("syn-fn", "#005a9c"),
  token("syn-ident", "#000000"),
  token("syn-punct", "#333333"),
]);

const HIGHER_CONTRAST_OVERRIDES = Object.freeze([
  token("blue-50", "#ffffff"),
  token("blue-100", "#ffffff"),
  token("blue-200", "#ffffff"),
  token("blue-300", "#005fcc"),
  token("blue-400", "#005fcc"),
  token("blue-500", "#005fcc"),
  token("blue-600", "#004080"),
  token("blue-700", "#003366"),
  token("blue-800", "#001f40"),
  token("blue-900", "#000000"),
  token("ink-0", "#ffffff"),
  token("ink-25", "#ffffff"),
  token("ink-50", "#ffffff"),
  token("ink-100", "#ffffff"),
  token("ink-150", "#c0c0c0"),
  token("ink-200", "#a0a0a0"),
  token("ink-300", "#707070"),
  token("ink-400", "#505050"),
  token("ink-500", "#303030"),
  token("ink-600", "#202020"),
  token("ink-700", "#101010"),
  token("ink-800", "#000000"),
  token("ink-900", "#000000"),
  token("ink-950", "#000000"),
  token("green-500", "#005a00"),
  token("green-bright", "#005a00"),
  token("amber-500", "#704000"),
  token("amber-bright", "#704000"),
  token("red-500", "#8b0000"),
  token("red-bright", "#8b0000"),
  token("surface-base", "#ffffff"),
  token("surface", "#ffffff"),
  token("surface-raised", "#ffffff"),
  token("surface-sunken", "#ffffff"),
  token("surface-inset", "#ffffff"),
  token("surface-translucent", "#ffffff"),
  token("surface-overlay", "#ffffff"),
  token("border", "#000000"),
  token("border-strong", "#000000"),
  token("hairline", "#000000"),
  token("text", "#000000"),
  token("text-secondary", "#000000"),
  token("text-muted", "#000000"),
  token("text-faint", "#000000"),
  token("accent", "#005fcc"),
  token("accent-hover", "#004080"),
  token("accent-active", "#003366"),
  token("accent-subtle", "#ffffff"),
  token("accent-fg", "#ffffff"),
  token("success", "#005a00"),
  token("success-subtle", "#ffffff"),
  token("warning", "#704000"),
  token("warning-subtle", "#ffffff"),
  token("danger", "#8b0000"),
  token("danger-subtle", "#ffffff"),
  token("info", "#005fcc"),
  token("focus-ring", "#005fcc"),
  token("syn-comment", "#000000"),
  token("syn-keyword", "#4a148c"),
  token("syn-string", "#005a00"),
  token("syn-number", "#704000"),
  token("syn-fn", "#005fcc"),
  token("syn-ident", "#000000"),
  token("syn-punct", "#000000"),
]);

export const A11Y_HIGH_CONTRAST_TOKEN_OVERRIDES = freezeTokenEntries(HIGH_CONTRAST_OVERRIDES);
export const A11Y_HIGHER_CONTRAST_TOKEN_OVERRIDES = freezeTokenEntries(HIGHER_CONTRAST_OVERRIDES);
export const A11Y_HIGH_CONTRAST_TOKEN_NAMES = Object.freeze(Object.keys(A11Y_HIGH_CONTRAST_TOKEN_OVERRIDES));
export const A11Y_REDUCE_TRANSPARENCY_TOKEN_NAMES = Object.freeze([
  "surface-translucent",
  "surface-overlay",
  "blur-thin",
  "blur",
  "blur-thick",
] as const);
export const A11Y_REDUCE_MOTION_TOKEN_NAMES = Object.freeze(durationTokenNames());

export function deriveA11yTokens(input: unknown = DEFAULT_A11Y_TOKEN_PREFS): A11yTokenDerivation {
  const prefs = normalizePrefs(input);

  return Object.freeze({
    cssVars: cssVarsFor(prefs),
    screenClasses: screenClassesFor(prefs),
    tokenOverrides: tokenOverridesFor(prefs),
  });
}

export const createA11yTokens = deriveA11yTokens;

function cssVarsFor(prefs: A11yPrefsState): Readonly<Record<string, string>> {
  return Object.freeze({
    "--ui-zoom": formatScale(prefs.uiZoom),
    "--text-scale": formatScale(prefs.textScale),
    "--focus-ring-width": `${formatScale(prefs.focusRingThickness)}px`,
    "--cursor-size": formatScale(prefs.cursorSize),
  });
}

function screenClassesFor(prefs: A11yPrefsState): readonly string[] {
  const classes: string[] = [];

  if (prefs.contrast === "high" || prefs.contrast === "higher") classes.push("contrast-high");
  if (prefs.reduceMotion) classes.push("reduce-motion");
  if (prefs.reduceTransparency) classes.push("reduce-transparency");

  return Object.freeze(classes);
}

function tokenOverridesFor(prefs: A11yPrefsState): Readonly<Record<string, string>> {
  const output: Record<string, string> = {};

  if (prefs.contrast === "high") {
    copyTokenMap(A11Y_HIGH_CONTRAST_TOKEN_OVERRIDES, output);
  } else if (prefs.contrast === "higher") {
    copyTokenMap(A11Y_HIGHER_CONTRAST_TOKEN_OVERRIDES, output);
  }
  if (prefs.reduceMotion) {
    addReducedMotionOverrides(output);
  }
  if (prefs.reduceTransparency) {
    addReducedTransparencyOverrides(output);
  }

  return Object.freeze(output);
}

function addReducedMotionOverrides(output: Record<string, string>): void {
  for (let index = 0; index < A11Y_REDUCE_MOTION_TOKEN_NAMES.length; index += 1) {
    const name = A11Y_REDUCE_MOTION_TOKEN_NAMES[index];

    if (name !== undefined) defineToken(output, name, "0ms");
  }
}

function addReducedTransparencyOverrides(output: Record<string, string>): void {
  defineToken(output, "surface-translucent", themeVar("surface"));
  defineToken(output, "surface-overlay", themeVar("surface-raised"));
  defineToken(output, "blur-thin", "none");
  defineToken(output, "blur", "none");
  defineToken(output, "blur-thick", "none");
}

function normalizePrefs(input: unknown): A11yPrefsState {
  return Object.freeze({
    contrast: normalizeContrast(dataProperty(input, "contrast")),
    cursorSize: normalizeSteppedNumber(dataProperty(input, "cursorSize"), A11Y_NUMERIC_PREFS.cursorSize, 1),
    focusRingThickness: normalizeSteppedNumber(
      dataProperty(input, "focusRingThickness"),
      A11Y_NUMERIC_PREFS.focusRingThickness,
      2,
    ),
    reduceMotion: dataProperty(input, "reduceMotion") === true,
    reduceTransparency: dataProperty(input, "reduceTransparency") === true,
    textScale: normalizeSteppedNumber(dataProperty(input, "textScale"), A11Y_NUMERIC_PREFS.textScale, 1),
    uiZoom: normalizeSteppedNumber(dataProperty(input, "uiZoom"), A11Y_NUMERIC_PREFS.uiZoom, 1),
  });
}

function normalizeContrast(value: unknown): A11yContrast {
  if (typeof value === "string" && contains(A11Y_CONTRASTS, value)) return value;

  return DEFAULT_A11Y_TOKEN_PREFS.contrast;
}

function normalizeSteppedNumber(
  value: unknown,
  spec: {
    readonly max: number;
    readonly min: number;
    readonly step: number;
  },
  fallback: number,
): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < spec.min || value > spec.max) {
    return fallback;
  }

  const steps = Math.round((value - spec.min) / spec.step);
  const snapped = spec.min + steps * spec.step;

  return normalizeDecimal(Math.min(spec.max, Math.max(spec.min, snapped)));
}

function dataProperty(input: unknown, key: string): unknown {
  if (typeof input !== "object" || input === null) return undefined;

  let descriptor: PropertyDescriptor | undefined;

  try {
    descriptor = Object.getOwnPropertyDescriptor(input, key);
  } catch {
    return undefined;
  }

  if (descriptor === undefined || !("value" in descriptor)) return undefined;

  return descriptor.value;
}

function durationTokenNames(): readonly string[] {
  const keys = Object.keys(themeTokens.motion);
  const output: string[] = [];

  for (let index = 0; index < keys.length; index += 1) {
    const key = keys[index];

    if (key !== undefined && key.startsWith("dur-")) {
      output.push(key);
    }
  }

  return Object.freeze(output);
}

interface TokenEntry {
  readonly name: VitaThemeTokenName;
  readonly value: string;
}

function token(name: VitaThemeTokenName, value: string): TokenEntry {
  return Object.freeze({ name, value });
}

function copyTokenEntries(entries: readonly TokenEntry[], target: Record<string, string>): void {
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];

    if (entry !== undefined) defineToken(target, entry.name, entry.value);
  }
}

function freezeTokenEntries(entries: readonly TokenEntry[]): Readonly<Record<string, string>> {
  const output: Record<string, string> = {};

  copyTokenEntries(entries, output);

  return Object.freeze(output);
}

function copyTokenMap(source: Readonly<Record<string, string>>, target: Record<string, string>): void {
  const keys = Object.keys(source);

  for (let index = 0; index < keys.length; index += 1) {
    const key = keys[index];

    if (key === undefined) continue;

    const value = source[key];

    if (value !== undefined) defineToken(target, key, value);
  }
}

function defineToken(target: Record<string, string>, name: string, value: string): void {
  Object.defineProperty(target, name, {
    configurable: true,
    enumerable: true,
    value,
    writable: true,
  });
}

function formatScale(value: number): string {
  return String(normalizeDecimal(value));
}

function normalizeDecimal(value: number): number {
  return Number(value.toFixed(10));
}

function contains<T extends string>(values: readonly T[], value: string): value is T {
  for (let index = 0; index < values.length; index += 1) {
    if (values[index] === value) return true;
  }

  return false;
}
