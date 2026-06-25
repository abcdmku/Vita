import type {
  DesktopHost,
  DesktopHostError,
} from "../../../sdk/typescript/src/desktop-sdk/index.ts";

export const A11Y_PREFS_SETTING_KEYS = Object.freeze({
  contrast: "accessibility.contrast",
  cursorSize: "accessibility.cursorSize",
  focusRingThickness: "accessibility.focusRingThickness",
  reduceMotion: "accessibility.reduceMotion",
  reduceTransparency: "accessibility.reduceTransparency",
  textScale: "accessibility.textScale",
  uiZoom: "accessibility.uiZoom",
});

export const A11Y_CONTRASTS = Object.freeze([
  "normal",
  "high",
  "higher",
] as const);

export const A11Y_NUMERIC_PREFS = Object.freeze({
  cursorSize: Object.freeze({
    max: 4,
    min: 0.5,
    step: 0.25,
  }),
  focusRingThickness: Object.freeze({
    max: 8,
    min: 1,
    step: 0.25,
  }),
  textScale: Object.freeze({
    max: 2,
    min: 0.8,
    step: 0.05,
  }),
  uiZoom: Object.freeze({
    max: 3,
    min: 0.5,
    step: 0.05,
  }),
});

export type A11yPrefsSettingKey = typeof A11Y_PREFS_SETTING_KEYS[keyof typeof A11Y_PREFS_SETTING_KEYS];
export type A11yContrast = typeof A11Y_CONTRASTS[number];

export interface A11yPrefsState {
  readonly uiZoom: number;
  readonly contrast: A11yContrast;
  readonly reduceMotion: boolean;
  readonly reduceTransparency: boolean;
  readonly textScale: number;
  readonly cursorSize: number;
  readonly focusRingThickness: number;
}

export interface A11yPrefsViewModelError {
  readonly code: string;
  readonly message: string;
  readonly path: string;
}

export type A11yPrefsViewModelResult<T> =
  | {
      readonly ok: true;
      readonly value: T;
    }
  | {
      readonly ok: false;
      readonly error: A11yPrefsViewModelError;
    };

export type A11yPrefsViewModelActionResult =
  | {
      readonly ok: true;
      readonly state: A11yPrefsState;
    }
  | {
      readonly ok: false;
      readonly error: A11yPrefsViewModelError;
      readonly state: A11yPrefsState;
    };

export interface A11yPrefsViewModelPorts {
  readonly readSetting?: NonNullable<DesktopHost["readSetting"]>;
  readonly applySetting?: NonNullable<DesktopHost["applySetting"]>;
}

export interface A11yPrefsViewModel {
  readonly state: A11yPrefsState;
  snapshot(): A11yPrefsState;
  setUiZoom(uiZoom: unknown): Promise<A11yPrefsViewModelActionResult>;
  setContrast(contrast: unknown): Promise<A11yPrefsViewModelActionResult>;
  setReduceMotion(reduceMotion: unknown): Promise<A11yPrefsViewModelActionResult>;
  setReduceTransparency(reduceTransparency: unknown): Promise<A11yPrefsViewModelActionResult>;
  setTextScale(textScale: unknown): Promise<A11yPrefsViewModelActionResult>;
  setCursorSize(cursorSize: unknown): Promise<A11yPrefsViewModelActionResult>;
  setFocusRingThickness(focusRingThickness: unknown): Promise<A11yPrefsViewModelActionResult>;
}

interface NumericPreferenceSpec {
  readonly code: string;
  readonly max: number;
  readonly message: string;
  readonly min: number;
  readonly path: string;
  readonly step: number;
}

type A11yPrefsSettingValue = A11yContrast | boolean | number;

const UI_ZOOM_SPEC: NumericPreferenceSpec = Object.freeze({
  ...A11Y_NUMERIC_PREFS.uiZoom,
  code: "INVALID_UI_ZOOM",
  message: "accessibility UI zoom is not supported.",
  path: "/accessibility/uiZoom",
});

const TEXT_SCALE_SPEC: NumericPreferenceSpec = Object.freeze({
  ...A11Y_NUMERIC_PREFS.textScale,
  code: "INVALID_TEXT_SCALE",
  message: "accessibility text scale is not supported.",
  path: "/accessibility/textScale",
});

const CURSOR_SIZE_SPEC: NumericPreferenceSpec = Object.freeze({
  ...A11Y_NUMERIC_PREFS.cursorSize,
  code: "INVALID_CURSOR_SIZE",
  message: "accessibility cursor size is not supported.",
  path: "/accessibility/cursorSize",
});

const FOCUS_RING_THICKNESS_SPEC: NumericPreferenceSpec = Object.freeze({
  ...A11Y_NUMERIC_PREFS.focusRingThickness,
  code: "INVALID_FOCUS_RING_THICKNESS",
  message: "accessibility focus ring thickness is not supported.",
  path: "/accessibility/focusRingThickness",
});

export async function createA11yPrefsViewModel(
  ports: A11yPrefsViewModelPorts,
): Promise<A11yPrefsViewModelResult<A11yPrefsViewModel>> {
  const uiZoom = await readNumericSetting(ports, A11Y_PREFS_SETTING_KEYS.uiZoom, UI_ZOOM_SPEC);

  if (!uiZoom.ok) return uiZoom;

  const contrast = await readContrastSetting(
    ports,
    A11Y_PREFS_SETTING_KEYS.contrast,
    "/accessibility/contrast",
    "UNKNOWN_CONTRAST",
    "accessibility contrast is not supported.",
  );

  if (!contrast.ok) return contrast;

  const reduceMotion = await readBooleanSetting(
    ports,
    A11Y_PREFS_SETTING_KEYS.reduceMotion,
    "/accessibility/reduceMotion",
    "INVALID_REDUCE_MOTION",
    "reduce motion preference is not supported.",
  );

  if (!reduceMotion.ok) return reduceMotion;

  const reduceTransparency = await readBooleanSetting(
    ports,
    A11Y_PREFS_SETTING_KEYS.reduceTransparency,
    "/accessibility/reduceTransparency",
    "INVALID_REDUCE_TRANSPARENCY",
    "reduce transparency preference is not supported.",
  );

  if (!reduceTransparency.ok) return reduceTransparency;

  const textScale = await readNumericSetting(ports, A11Y_PREFS_SETTING_KEYS.textScale, TEXT_SCALE_SPEC);

  if (!textScale.ok) return textScale;

  const cursorSize = await readNumericSetting(ports, A11Y_PREFS_SETTING_KEYS.cursorSize, CURSOR_SIZE_SPEC);

  if (!cursorSize.ok) return cursorSize;

  const focusRingThickness = await readNumericSetting(
    ports,
    A11Y_PREFS_SETTING_KEYS.focusRingThickness,
    FOCUS_RING_THICKNESS_SPEC,
  );

  if (!focusRingThickness.ok) return focusRingThickness;

  return accept(new DesktopA11yPrefsViewModel(ports, freezeState({
    contrast: contrast.value,
    cursorSize: cursorSize.value,
    focusRingThickness: focusRingThickness.value,
    reduceMotion: reduceMotion.value,
    reduceTransparency: reduceTransparency.value,
    textScale: textScale.value,
    uiZoom: uiZoom.value,
  })));
}

class DesktopA11yPrefsViewModel implements A11yPrefsViewModel {
  readonly #ports: A11yPrefsViewModelPorts;
  #state: A11yPrefsState;

  constructor(ports: A11yPrefsViewModelPorts, state: A11yPrefsState) {
    this.#ports = ports;
    this.#state = state;
  }

  get state(): A11yPrefsState {
    return this.#state;
  }

  snapshot(): A11yPrefsState {
    return this.#state;
  }

  async setUiZoom(uiZoom: unknown): Promise<A11yPrefsViewModelActionResult> {
    const next = normalizeNumericValue(uiZoom, UI_ZOOM_SPEC);

    if (!next.ok) {
      return actionReject(UI_ZOOM_SPEC.code, UI_ZOOM_SPEC.message, UI_ZOOM_SPEC.path, this.#state);
    }

    return await this.#setAccessibilityValue(A11Y_PREFS_SETTING_KEYS.uiZoom, next.value, UI_ZOOM_SPEC.path, {
      ...this.#state,
      uiZoom: next.value,
    });
  }

  async setContrast(contrast: unknown): Promise<A11yPrefsViewModelActionResult> {
    if (typeof contrast !== "string" || !isA11yContrast(contrast)) {
      return actionReject(
        "UNKNOWN_CONTRAST",
        "accessibility contrast is not supported.",
        "/accessibility/contrast",
        this.#state,
      );
    }

    return await this.#setAccessibilityValue(A11Y_PREFS_SETTING_KEYS.contrast, contrast, "/accessibility/contrast", {
      ...this.#state,
      contrast,
    });
  }

  async setReduceMotion(reduceMotion: unknown): Promise<A11yPrefsViewModelActionResult> {
    if (typeof reduceMotion !== "boolean") {
      return actionReject(
        "INVALID_REDUCE_MOTION",
        "reduce motion preference is not supported.",
        "/accessibility/reduceMotion",
        this.#state,
      );
    }

    return await this.#setAccessibilityValue(
      A11Y_PREFS_SETTING_KEYS.reduceMotion,
      reduceMotion,
      "/accessibility/reduceMotion",
      {
        ...this.#state,
        reduceMotion,
      },
    );
  }

  async setReduceTransparency(reduceTransparency: unknown): Promise<A11yPrefsViewModelActionResult> {
    if (typeof reduceTransparency !== "boolean") {
      return actionReject(
        "INVALID_REDUCE_TRANSPARENCY",
        "reduce transparency preference is not supported.",
        "/accessibility/reduceTransparency",
        this.#state,
      );
    }

    return await this.#setAccessibilityValue(
      A11Y_PREFS_SETTING_KEYS.reduceTransparency,
      reduceTransparency,
      "/accessibility/reduceTransparency",
      {
        ...this.#state,
        reduceTransparency,
      },
    );
  }

  async setTextScale(textScale: unknown): Promise<A11yPrefsViewModelActionResult> {
    const next = normalizeNumericValue(textScale, TEXT_SCALE_SPEC);

    if (!next.ok) {
      return actionReject(TEXT_SCALE_SPEC.code, TEXT_SCALE_SPEC.message, TEXT_SCALE_SPEC.path, this.#state);
    }

    return await this.#setAccessibilityValue(A11Y_PREFS_SETTING_KEYS.textScale, next.value, TEXT_SCALE_SPEC.path, {
      ...this.#state,
      textScale: next.value,
    });
  }

  async setCursorSize(cursorSize: unknown): Promise<A11yPrefsViewModelActionResult> {
    const next = normalizeNumericValue(cursorSize, CURSOR_SIZE_SPEC);

    if (!next.ok) {
      return actionReject(CURSOR_SIZE_SPEC.code, CURSOR_SIZE_SPEC.message, CURSOR_SIZE_SPEC.path, this.#state);
    }

    return await this.#setAccessibilityValue(A11Y_PREFS_SETTING_KEYS.cursorSize, next.value, CURSOR_SIZE_SPEC.path, {
      ...this.#state,
      cursorSize: next.value,
    });
  }

  async setFocusRingThickness(focusRingThickness: unknown): Promise<A11yPrefsViewModelActionResult> {
    const next = normalizeNumericValue(focusRingThickness, FOCUS_RING_THICKNESS_SPEC);

    if (!next.ok) {
      return actionReject(
        FOCUS_RING_THICKNESS_SPEC.code,
        FOCUS_RING_THICKNESS_SPEC.message,
        FOCUS_RING_THICKNESS_SPEC.path,
        this.#state,
      );
    }

    return await this.#setAccessibilityValue(
      A11Y_PREFS_SETTING_KEYS.focusRingThickness,
      next.value,
      FOCUS_RING_THICKNESS_SPEC.path,
      {
        ...this.#state,
        focusRingThickness: next.value,
      },
    );
  }

  async #setAccessibilityValue(
    key: string,
    value: A11yPrefsSettingValue,
    path: string,
    next: A11yPrefsState,
  ): Promise<A11yPrefsViewModelActionResult> {
    const written = await writeAccessibilitySetting(this.#ports, key, value, path);

    if (!written.ok) return actionRejectFromError(written.error, this.#state);

    this.#state = freezeState(next);

    return actionAccept(this.#state);
  }
}

async function readNumericSetting(
  ports: A11yPrefsViewModelPorts,
  key: string,
  spec: NumericPreferenceSpec,
): Promise<A11yPrefsViewModelResult<number>> {
  const read = await readAccessibilitySetting(ports, key, spec.path);

  if (!read.ok) return read;

  const normalized = normalizeNumericValue(read.value, spec);

  if (!normalized.ok) return reject(spec.code, spec.message, spec.path);

  return accept(normalized.value);
}

async function readContrastSetting(
  ports: A11yPrefsViewModelPorts,
  key: string,
  path: string,
  code: string,
  message: string,
): Promise<A11yPrefsViewModelResult<A11yContrast>> {
  const read = await readAccessibilitySetting(ports, key, path);

  if (!read.ok) return read;
  if (typeof read.value !== "string" || !isA11yContrast(read.value)) {
    return reject(code, message, path);
  }

  return accept(read.value);
}

async function readBooleanSetting(
  ports: A11yPrefsViewModelPorts,
  key: string,
  path: string,
  code: string,
  message: string,
): Promise<A11yPrefsViewModelResult<boolean>> {
  const read = await readAccessibilitySetting(ports, key, path);

  if (!read.ok) return read;
  if (typeof read.value !== "boolean") return reject(code, message, path);

  return accept(read.value);
}

async function readAccessibilitySetting(
  ports: A11yPrefsViewModelPorts,
  key: string,
  path: string,
): Promise<A11yPrefsViewModelResult<unknown>> {
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

  return accept(result.value);
}

async function writeAccessibilitySetting(
  ports: A11yPrefsViewModelPorts,
  key: string,
  value: A11yPrefsSettingValue,
  path: string,
): Promise<A11yPrefsViewModelResult<true>> {
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

function freezeState(input: A11yPrefsState): A11yPrefsState {
  return Object.freeze({
    contrast: input.contrast,
    cursorSize: input.cursorSize,
    focusRingThickness: input.focusRingThickness,
    reduceMotion: input.reduceMotion,
    reduceTransparency: input.reduceTransparency,
    textScale: input.textScale,
    uiZoom: input.uiZoom,
  });
}

function normalizeNumericValue(
  value: unknown,
  spec: NumericPreferenceSpec,
): A11yPrefsViewModelResult<number> {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return reject(spec.code, spec.message, spec.path);
  }
  if (value < spec.min || value > spec.max) {
    return reject(spec.code, spec.message, spec.path);
  }

  return accept(snapNumericValue(value, spec));
}

function snapNumericValue(value: number, spec: NumericPreferenceSpec): number {
  const steps = Math.round((value - spec.min) / spec.step);
  const snapped = spec.min + steps * spec.step;

  return normalizeDecimal(clampNumber(snapped, spec.min, spec.max));
}

function clampNumber(value: number, min: number, max: number): number {
  if (value < min) return min;
  if (value > max) return max;

  return value;
}

function normalizeDecimal(value: number): number {
  return Number(value.toFixed(10));
}

function isA11yContrast(value: string): value is A11yContrast {
  return contains(A11Y_CONTRASTS, value);
}

function contains<T extends string>(values: readonly T[], value: string): value is T {
  for (let index = 0; index < values.length; index += 1) {
    if (values[index] === value) return true;
  }

  return false;
}

function actionAccept(state: A11yPrefsState): A11yPrefsViewModelActionResult {
  return Object.freeze({
    ok: true,
    state,
  });
}

function actionReject(
  code: string,
  message: string,
  path: string,
  state: A11yPrefsState,
): A11yPrefsViewModelActionResult {
  return Object.freeze({
    error: Object.freeze({ code, message, path }),
    ok: false,
    state,
  });
}

function actionRejectFromError(
  error: A11yPrefsViewModelError,
  state: A11yPrefsState,
): A11yPrefsViewModelActionResult {
  return Object.freeze({
    error,
    ok: false,
    state,
  });
}

function accept<T>(value: T): A11yPrefsViewModelResult<T> {
  return Object.freeze({
    ok: true,
    value,
  });
}

function reject<T>(code: string, message: string, path: string): A11yPrefsViewModelResult<T> {
  return Object.freeze({
    error: Object.freeze({
      code,
      message,
      path,
    }),
    ok: false,
  });
}

function rejectFromHost<T>(error: DesktopHostError): A11yPrefsViewModelResult<T> {
  return reject(error.code, error.message, error.path);
}
