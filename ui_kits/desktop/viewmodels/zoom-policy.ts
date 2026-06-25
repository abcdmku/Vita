import {
  themeTokens,
} from "../../../sdk/typescript/src/desktop-sdk/index.ts";

import {
  A11Y_NUMERIC_PREFS,
} from "./a11y-prefs.ts";

export type ZoomPolicyDensity = "compact" | "comfortable";

export interface ZoomPolicyInput {
  readonly uiZoom?: number;
  readonly textScale?: number;
}

export interface ZoomPolicy {
  readonly rootScale: number;
  readonly controlMin: number;
  readonly density: ZoomPolicyDensity;
}

export const DEFAULT_ZOOM_POLICY_INPUT = Object.freeze({
  textScale: 1,
  uiZoom: 1,
}) satisfies Required<ZoomPolicyInput>;

export const ZOOM_POLICY_LIMITS = Object.freeze({
  controlFloor: parsePixelToken(themeTokens.space["size-touch"], 44),
  rootScale: Object.freeze({
    max: A11Y_NUMERIC_PREFS.uiZoom.max * A11Y_NUMERIC_PREFS.textScale.max,
    min: A11Y_NUMERIC_PREFS.uiZoom.min * A11Y_NUMERIC_PREFS.textScale.min,
  }),
  textScale: A11Y_NUMERIC_PREFS.textScale,
  uiZoom: A11Y_NUMERIC_PREFS.uiZoom,
});

export function deriveZoomPolicy(input: unknown = DEFAULT_ZOOM_POLICY_INPUT): ZoomPolicy {
  const uiZoom = clampFiniteNumber(
    dataProperty(input, "uiZoom"),
    ZOOM_POLICY_LIMITS.uiZoom.min,
    ZOOM_POLICY_LIMITS.uiZoom.max,
    1,
  );
  const textScale = clampFiniteNumber(
    dataProperty(input, "textScale"),
    ZOOM_POLICY_LIMITS.textScale.min,
    ZOOM_POLICY_LIMITS.textScale.max,
    1,
  );
  const rootScale = normalizeDecimal(uiZoom * textScale);
  const controlMin = controlFloorFor(rootScale);

  return Object.freeze({
    controlMin,
    density: densityFor(rootScale),
    rootScale,
  });
}

export const createZoomPolicy = deriveZoomPolicy;

function controlFloorFor(rootScale: number): number {
  if (rootScale < 1) {
    return normalizeDecimal(ZOOM_POLICY_LIMITS.controlFloor / rootScale);
  }

  return ZOOM_POLICY_LIMITS.controlFloor;
}

function densityFor(rootScale: number): ZoomPolicyDensity {
  if (rootScale < 0.9) return "compact";

  return "comfortable";
}

function clampFiniteNumber(value: unknown, min: number, max: number, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  if (value < min) return min;
  if (value > max) return max;

  return value;
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

function parsePixelToken(value: string | undefined, fallback: number): number {
  if (value === undefined || !value.endsWith("px")) return fallback;

  const parsed = Number(value.slice(0, -2));

  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function normalizeDecimal(value: number): number {
  return Number(value.toFixed(10));
}
