import assert from "node:assert/strict";
import { test } from "node:test";

import {
  A11Y_HIGHER_CONTRAST_TOKEN_OVERRIDES,
  A11Y_HIGH_CONTRAST_TOKEN_NAMES,
  A11Y_HIGH_CONTRAST_TOKEN_OVERRIDES,
  A11Y_REDUCE_MOTION_TOKEN_NAMES,
  DEFAULT_A11Y_TOKEN_PREFS,
  deriveA11yTokens,
} from "../../../../ui_kits/desktop/viewmodels/a11y-tokens.ts";
import type {
  A11yTokenDerivation,
} from "../../../../ui_kits/desktop/viewmodels/a11y-tokens.ts";
import type {
  A11yPrefsState,
} from "../../../../ui_kits/desktop/viewmodels/a11y-prefs.ts";
import {
  themeTokens,
} from "../../src/desktop-sdk/index.ts";

test("a11y token derivation returns exact frozen defaults for normal preferences", () => {
  const derived = deriveA11yTokens(DEFAULT_A11Y_TOKEN_PREFS);

  assert.deepEqual(derived, {
    cssVars: {
      "--cursor-size": "1",
      "--focus-ring-width": "2px",
      "--text-scale": "1",
      "--ui-zoom": "1",
    },
    screenClasses: [],
    tokenOverrides: {},
  });
  assertFrozenDerivation(derived);
  assert.equal(JSON.stringify(deriveA11yTokens(DEFAULT_A11Y_TOKEN_PREFS)), JSON.stringify(derived));
});

test("a11y token derivation maps high and higher contrast to exact token overrides", () => {
  const high = deriveA11yTokens(prefs({
    contrast: "high",
    cursorSize: 2,
    focusRingThickness: 3,
    textScale: 1.5,
    uiZoom: 1.25,
  }));
  const higher = deriveA11yTokens(prefs({
    contrast: "higher",
  }));

  assert.deepEqual(high.cssVars, {
    "--cursor-size": "2",
    "--focus-ring-width": "3px",
    "--text-scale": "1.5",
    "--ui-zoom": "1.25",
  });
  assert.deepEqual(high.screenClasses, ["contrast-high"]);
  assert.deepEqual(high.tokenOverrides, A11Y_HIGH_CONTRAST_TOKEN_OVERRIDES);
  assert.deepEqual(higher.screenClasses, ["contrast-high"]);
  assert.deepEqual(higher.tokenOverrides, A11Y_HIGHER_CONTRAST_TOKEN_OVERRIDES);
  assert.equal(high.tokenOverrides["surface"], "#ffffff");
  assert.equal(high.tokenOverrides["text"], "#000000");
  assert.equal(high.tokenOverrides["accent"], "#005a9c");
  assert.equal(higher.tokenOverrides["text-muted"], "#000000");
  assertFrozenDerivation(high);
  assertFrozenDerivation(higher);
});

test("high contrast remaps every SDK color token in deterministic token order", () => {
  const sdkColorTokens = Object.keys(themeTokens.color);
  const high = deriveA11yTokens(prefs({ contrast: "high" }));

  assert.deepEqual(A11Y_HIGH_CONTRAST_TOKEN_NAMES, sdkColorTokens);
  assert.deepEqual(Object.keys(high.tokenOverrides), sdkColorTokens);

  for (let index = 0; index < sdkColorTokens.length; index += 1) {
    const key = sdkColorTokens[index];

    if (key === undefined) continue;

    assert.equal(typeof high.tokenOverrides[key], "string");
    assert.notEqual(high.tokenOverrides[key], "");
  }
});

test("reduce motion zeroes every SDK motion duration token", () => {
  const reduced = deriveA11yTokens(prefs({
    reduceMotion: true,
  }));
  const expected: Record<string, string> = {};

  for (let index = 0; index < A11Y_REDUCE_MOTION_TOKEN_NAMES.length; index += 1) {
    const name = A11Y_REDUCE_MOTION_TOKEN_NAMES[index];

    if (name !== undefined) {
      Object.defineProperty(expected, name, {
        configurable: true,
        enumerable: true,
        value: "0ms",
        writable: true,
      });
    }
  }

  assert.deepEqual(A11Y_REDUCE_MOTION_TOKEN_NAMES, [
    "dur-instant",
    "dur-fast",
    "dur-base",
    "dur-slow",
    "dur-slower",
  ]);
  assert.deepEqual(reduced.screenClasses, ["reduce-motion"]);
  assert.deepEqual(reduced.tokenOverrides, expected);
  assertFrozenDerivation(reduced);
});

test("reduce transparency emits stable classes and token fallbacks", () => {
  const reduced = deriveA11yTokens(prefs({
    reduceTransparency: true,
  }));

  assert.deepEqual(reduced.screenClasses, ["reduce-transparency"]);
  assert.deepEqual(reduced.tokenOverrides, {
    "surface-translucent": "var(--surface)",
    "surface-overlay": "var(--surface-raised)",
    "blur-thin": "none",
    "blur": "none",
    "blur-thick": "none",
  });
});

test("combined a11y token states preserve stable class and override order", () => {
  const combined = deriveA11yTokens(prefs({
    contrast: "high",
    reduceMotion: true,
    reduceTransparency: true,
  }));

  assert.deepEqual(combined.screenClasses, [
    "contrast-high",
    "reduce-motion",
    "reduce-transparency",
  ]);
  assert.equal(combined.tokenOverrides["text"], "#000000");
  assert.equal(combined.tokenOverrides["dur-fast"], "0ms");
  assert.equal(combined.tokenOverrides["surface-translucent"], "var(--surface)");
  assert.equal(combined.tokenOverrides["blur"], "none");
  assert.deepEqual(Object.keys(combined.tokenOverrides).slice(0, A11Y_HIGH_CONTRAST_TOKEN_NAMES.length), [
    ...A11Y_HIGH_CONTRAST_TOKEN_NAMES,
  ]);
  assert.equal(JSON.stringify(deriveA11yTokens(prefs({
    contrast: "high",
    reduceMotion: true,
    reduceTransparency: true,
  }))), JSON.stringify(combined));
});

test("malformed missing and out-of-range a11y inputs resolve to safe defaults", () => {
  const accessorInput = Object.defineProperty({}, "uiZoom", {
    enumerable: true,
    get() {
      throw new Error("should not read accessor value");
    },
  });
  const malformed = deriveA11yTokens({
    contrast: "maximum",
    cursorSize: 10,
    focusRingThickness: 0,
    reduceMotion: "true",
    reduceTransparency: 1,
    textScale: Number.NaN,
    uiZoom: 4,
  });

  assert.deepEqual(malformed, deriveA11yTokens());
  assert.deepEqual(deriveA11yTokens(accessorInput), deriveA11yTokens());
  assert.deepEqual(deriveA11yTokens(null), deriveA11yTokens());
});

function prefs(overrides: Partial<A11yPrefsState> = Object.freeze({})): A11yPrefsState {
  return Object.freeze({
    contrast: overrides.contrast ?? DEFAULT_A11Y_TOKEN_PREFS.contrast,
    cursorSize: overrides.cursorSize ?? DEFAULT_A11Y_TOKEN_PREFS.cursorSize,
    focusRingThickness: overrides.focusRingThickness ?? DEFAULT_A11Y_TOKEN_PREFS.focusRingThickness,
    reduceMotion: overrides.reduceMotion ?? DEFAULT_A11Y_TOKEN_PREFS.reduceMotion,
    reduceTransparency: overrides.reduceTransparency ?? DEFAULT_A11Y_TOKEN_PREFS.reduceTransparency,
    textScale: overrides.textScale ?? DEFAULT_A11Y_TOKEN_PREFS.textScale,
    uiZoom: overrides.uiZoom ?? DEFAULT_A11Y_TOKEN_PREFS.uiZoom,
  });
}

function assertFrozenDerivation(derived: A11yTokenDerivation): void {
  assert.equal(Object.isFrozen(derived), true);
  assert.equal(Object.isFrozen(derived.cssVars), true);
  assert.equal(Object.isFrozen(derived.screenClasses), true);
  assert.equal(Object.isFrozen(derived.tokenOverrides), true);
  assert.throws(() => {
    (derived.cssVars as Record<string, string>)["--ui-zoom"] = "2";
  }, TypeError);
}
