import assert from "node:assert/strict";
import { test } from "node:test";

import {
  A11Y_NUMERIC_PREFS,
  A11Y_PREFS_SETTING_KEYS,
  createA11yPrefsViewModel,
} from "../../../../ui_kits/desktop/viewmodels/a11y-prefs.ts";
import type {
  A11yPrefsSettingKey,
  A11yPrefsState,
  A11yPrefsViewModelActionResult,
  A11yPrefsViewModelPorts,
} from "../../../../ui_kits/desktop/viewmodels/a11y-prefs.ts";
import type {
  DesktopHostResult,
} from "../../src/desktop-sdk/index.ts";

test("a11y preferences view-model reads all accessibility settings into a frozen snapshot", async () => {
  const fixture = fakeA11yPrefsPorts({
    settings: initialSettings({
      [A11Y_PREFS_SETTING_KEYS.contrast]: "high",
      [A11Y_PREFS_SETTING_KEYS.cursorSize]: 1.5,
      [A11Y_PREFS_SETTING_KEYS.focusRingThickness]: 3,
      [A11Y_PREFS_SETTING_KEYS.reduceMotion]: true,
      [A11Y_PREFS_SETTING_KEYS.reduceTransparency]: true,
      [A11Y_PREFS_SETTING_KEYS.textScale]: 1.25,
      [A11Y_PREFS_SETTING_KEYS.uiZoom]: 1.5,
    }),
  });

  const loaded = await createA11yPrefsViewModel(fixture.ports);

  assert.equal(loaded.ok, true);
  if (!loaded.ok) {
    assert.fail("expected a11y preferences view-model to load");
  }

  assert.deepEqual(fixture.events, expectedReadEvents());
  assert.deepEqual(loaded.value.state, {
    contrast: "high",
    cursorSize: 1.5,
    focusRingThickness: 3,
    reduceMotion: true,
    reduceTransparency: true,
    textScale: 1.25,
    uiZoom: 1.5,
  });
  assert.equal(loaded.value.snapshot(), loaded.value.state);
  assert.equal(Object.isFrozen(loaded.value.state), true);
  assert.throws(() => {
    (loaded.value.state as { uiZoom: number }).uiZoom = 2;
  }, TypeError);
});

test("a11y numeric actions snap accepted values and clamp snapped boundary results", async () => {
  const fixture = fakeA11yPrefsPorts({
    settings: initialSettings(),
  });
  const loaded = await createA11yPrefsViewModel(fixture.ports);

  assert.equal(loaded.ok, true);
  if (!loaded.ok) {
    assert.fail("expected a11y preferences view-model to load");
  }

  fixture.events.length = 0;

  const uiZoom = await loaded.value.setUiZoom(1.234);
  const textScale = await loaded.value.setTextScale(1.026);
  const cursorSize = await loaded.value.setCursorSize(1.62);
  const focusRingThickness = await loaded.value.setFocusRingThickness(2.62);

  assertAccepted(uiZoom);
  assertAccepted(textScale);
  assertAccepted(cursorSize);
  assertAccepted(focusRingThickness);
  assert.equal(loaded.value.state.uiZoom, 1.25);
  assert.equal(loaded.value.state.textScale, 1.05);
  assert.equal(loaded.value.state.cursorSize, 1.5);
  assert.equal(loaded.value.state.focusRingThickness, 2.5);
  assert.deepEqual(fixture.events, [
    `apply:${A11Y_PREFS_SETTING_KEYS.uiZoom}=1.25`,
    `apply:${A11Y_PREFS_SETTING_KEYS.textScale}=1.05`,
    `apply:${A11Y_PREFS_SETTING_KEYS.cursorSize}=1.5`,
    `apply:${A11Y_PREFS_SETTING_KEYS.focusRingThickness}=2.5`,
  ]);
  assert.equal(fixture.settings.get(A11Y_PREFS_SETTING_KEYS.uiZoom), 1.25);
  assert.equal(fixture.settings.get(A11Y_PREFS_SETTING_KEYS.textScale), 1.05);
  assert.equal(fixture.settings.get(A11Y_PREFS_SETTING_KEYS.cursorSize), 1.5);
  assert.equal(fixture.settings.get(A11Y_PREFS_SETTING_KEYS.focusRingThickness), 2.5);

  fixture.events.length = 0;

  const uiZoomBoundary = await loaded.value.setUiZoom(2.99);
  const textScaleBoundary = await loaded.value.setTextScale(0.81);
  const cursorSizeBoundary = await loaded.value.setCursorSize(3.93);
  const focusRingBoundary = await loaded.value.setFocusRingThickness(7.9);

  assertAccepted(uiZoomBoundary);
  assertAccepted(textScaleBoundary);
  assertAccepted(cursorSizeBoundary);
  assertAccepted(focusRingBoundary);
  assert.equal(loaded.value.state.uiZoom, A11Y_NUMERIC_PREFS.uiZoom.max);
  assert.equal(loaded.value.state.textScale, A11Y_NUMERIC_PREFS.textScale.min);
  assert.equal(loaded.value.state.cursorSize, A11Y_NUMERIC_PREFS.cursorSize.max);
  assert.equal(loaded.value.state.focusRingThickness, A11Y_NUMERIC_PREFS.focusRingThickness.max);
});

test("a11y enum and boolean actions persist accepted values", async () => {
  const fixture = fakeA11yPrefsPorts({
    settings: initialSettings(),
  });
  const loaded = await createA11yPrefsViewModel(fixture.ports);

  assert.equal(loaded.ok, true);
  if (!loaded.ok) {
    assert.fail("expected a11y preferences view-model to load");
  }

  fixture.events.length = 0;

  const contrast = await loaded.value.setContrast("higher");
  const reduceMotion = await loaded.value.setReduceMotion(true);
  const reduceTransparency = await loaded.value.setReduceTransparency(true);

  assertAccepted(contrast);
  assertAccepted(reduceMotion);
  assertAccepted(reduceTransparency);
  assert.deepEqual(fixture.events, [
    `apply:${A11Y_PREFS_SETTING_KEYS.contrast}=higher`,
    `apply:${A11Y_PREFS_SETTING_KEYS.reduceMotion}=true`,
    `apply:${A11Y_PREFS_SETTING_KEYS.reduceTransparency}=true`,
  ]);
  assert.equal(loaded.value.state.contrast, "higher");
  assert.equal(loaded.value.state.reduceMotion, true);
  assert.equal(loaded.value.state.reduceTransparency, true);
  assert.equal(fixture.settings.get(A11Y_PREFS_SETTING_KEYS.contrast), "higher");
  assert.equal(fixture.settings.get(A11Y_PREFS_SETTING_KEYS.reduceMotion), true);
  assert.equal(fixture.settings.get(A11Y_PREFS_SETTING_KEYS.reduceTransparency), true);
});

test("a11y actions reject out-of-range and malformed values without touching settings", async () => {
  const fixture = fakeA11yPrefsPorts({
    settings: initialSettings(),
  });
  const loaded = await createA11yPrefsViewModel(fixture.ports);

  assert.equal(loaded.ok, true);
  if (!loaded.ok) {
    assert.fail("expected a11y preferences view-model to load");
  }

  const before = loaded.value.state;
  const cyclic: { readonly label: string; self?: unknown } = {
    label: "cyclic",
  };

  cyclic.self = cyclic;
  fixture.events.length = 0;

  const cases: readonly InvalidActionCase[] = Object.freeze([
    Object.freeze({
      code: "INVALID_UI_ZOOM",
      run: async () => await loaded.value.setUiZoom(A11Y_NUMERIC_PREFS.uiZoom.min - 0.01),
    }),
    Object.freeze({
      code: "INVALID_UI_ZOOM",
      run: async () => await loaded.value.setUiZoom("1"),
    }),
    Object.freeze({
      code: "INVALID_TEXT_SCALE",
      run: async () => await loaded.value.setTextScale(A11Y_NUMERIC_PREFS.textScale.max + 0.01),
    }),
    Object.freeze({
      code: "INVALID_TEXT_SCALE",
      run: async () => await loaded.value.setTextScale(Number.NaN),
    }),
    Object.freeze({
      code: "INVALID_CURSOR_SIZE",
      run: async () => await loaded.value.setCursorSize(A11Y_NUMERIC_PREFS.cursorSize.min - 0.01),
    }),
    Object.freeze({
      code: "INVALID_CURSOR_SIZE",
      run: async () => await loaded.value.setCursorSize(cyclic),
    }),
    Object.freeze({
      code: "INVALID_FOCUS_RING_THICKNESS",
      run: async () => await loaded.value.setFocusRingThickness(A11Y_NUMERIC_PREFS.focusRingThickness.max + 0.01),
    }),
    Object.freeze({
      code: "INVALID_FOCUS_RING_THICKNESS",
      run: async () => await loaded.value.setFocusRingThickness(false),
    }),
    Object.freeze({
      code: "UNKNOWN_CONTRAST",
      run: async () => await loaded.value.setContrast("maximum"),
    }),
    Object.freeze({
      code: "UNKNOWN_CONTRAST",
      run: async () => await loaded.value.setContrast(1),
    }),
    Object.freeze({
      code: "INVALID_REDUCE_MOTION",
      run: async () => await loaded.value.setReduceMotion("true"),
    }),
    Object.freeze({
      code: "INVALID_REDUCE_TRANSPARENCY",
      run: async () => await loaded.value.setReduceTransparency(0),
    }),
  ]);

  for (let index = 0; index < cases.length; index += 1) {
    const entry = cases[index];

    if (entry === undefined) continue;

    const result = await entry.run();

    assertRejected(result, entry.code, before);
  }

  assert.equal(loaded.value.state, before);
  assert.deepEqual(fixture.events, []);
});

test("a11y view-model rejects malformed initial accessibility settings fail-closed", async () => {
  const invalidInitialSettings: readonly InvalidInitialSettingCase[] = Object.freeze([
    Object.freeze({
      code: "INVALID_UI_ZOOM",
      key: A11Y_PREFS_SETTING_KEYS.uiZoom,
      value: A11Y_NUMERIC_PREFS.uiZoom.max + 0.01,
    }),
    Object.freeze({
      code: "UNKNOWN_CONTRAST",
      key: A11Y_PREFS_SETTING_KEYS.contrast,
      value: "maximum",
    }),
    Object.freeze({
      code: "INVALID_REDUCE_MOTION",
      key: A11Y_PREFS_SETTING_KEYS.reduceMotion,
      value: "false",
    }),
  ]);

  for (let index = 0; index < invalidInitialSettings.length; index += 1) {
    const entry = invalidInitialSettings[index];

    if (entry === undefined) continue;

    const fixture = fakeA11yPrefsPorts({
      settings: initialSettings({
        [entry.key]: entry.value,
      }),
    });
    const loaded = await createA11yPrefsViewModel(fixture.ports);

    assert.equal(loaded.ok, false);
    if (loaded.ok) {
      assert.fail("expected malformed setting to fail closed");
    }

    assert.equal(loaded.error.code, entry.code);
  }
});

test("a11y view-model fails closed when settings ports are unavailable", async () => {
  const missingRead = await createA11yPrefsViewModel({});

  assert.equal(missingRead.ok, false);
  if (missingRead.ok) {
    assert.fail("expected missing read port to fail closed");
  }
  assert.equal(missingRead.error.code, "SETTINGS_PORT_UNAVAILABLE");

  const fixture = fakeA11yPrefsPorts({
    applyPort: false,
    settings: initialSettings(),
  });
  const loaded = await createA11yPrefsViewModel(fixture.ports);

  assert.equal(loaded.ok, true);
  if (!loaded.ok) {
    assert.fail("expected a11y preferences view-model to load");
  }

  const before = loaded.value.state;
  fixture.events.length = 0;

  const changed = await loaded.value.setReduceMotion(true);

  assertRejected(changed, "SETTINGS_PORT_UNAVAILABLE", before);
  assert.equal(loaded.value.state, before);
  assert.deepEqual(fixture.events, []);
});

test("a11y settings read and write throws fail closed", async () => {
  const readThrows = fakeA11yPrefsPorts({
    readThrows: new Set([A11Y_PREFS_SETTING_KEYS.uiZoom]),
    settings: initialSettings(),
  });
  const missing = await createA11yPrefsViewModel(readThrows.ports);

  assert.equal(missing.ok, false);
  if (missing.ok) {
    assert.fail("expected throwing read port to fail closed");
  }
  assert.equal(missing.error.code, "SETTINGS_READ_FAILED");

  const writeThrows = fakeA11yPrefsPorts({
    settings: initialSettings(),
    writeThrows: new Set([A11Y_PREFS_SETTING_KEYS.textScale]),
  });
  const loaded = await createA11yPrefsViewModel(writeThrows.ports);

  assert.equal(loaded.ok, true);
  if (!loaded.ok) {
    assert.fail("expected a11y preferences view-model to load");
  }

  const before = loaded.value.state;
  writeThrows.events.length = 0;

  const changed = await loaded.value.setTextScale(1.2);

  assertRejected(changed, "SETTINGS_WRITE_FAILED", before);
  assert.equal(loaded.value.state, before);
  assert.deepEqual(writeThrows.events, [
    `apply:${A11Y_PREFS_SETTING_KEYS.textScale}=1.2`,
  ]);
});

test("a11y host-denied settings results are returned without changing state", async () => {
  const readDenied = fakeA11yPrefsPorts({
    failReads: new Set([A11Y_PREFS_SETTING_KEYS.contrast]),
    settings: initialSettings(),
  });
  const rejectedRead = await createA11yPrefsViewModel(readDenied.ports);

  assert.equal(rejectedRead.ok, false);
  if (rejectedRead.ok) {
    assert.fail("expected host-denied read to fail closed");
  }
  assert.equal(rejectedRead.error.code, "READ_REJECTED");

  const writeDenied = fakeA11yPrefsPorts({
    failWrites: new Set([A11Y_PREFS_SETTING_KEYS.cursorSize]),
    settings: initialSettings(),
  });
  const loaded = await createA11yPrefsViewModel(writeDenied.ports);

  assert.equal(loaded.ok, true);
  if (!loaded.ok) {
    assert.fail("expected a11y preferences view-model to load");
  }

  const before = loaded.value.state;
  writeDenied.events.length = 0;

  const changed = await loaded.value.setCursorSize(1.75);

  assertRejected(changed, "WRITE_REJECTED", before);
  assert.equal(loaded.value.state, before);
  assert.equal(writeDenied.settings.get(A11Y_PREFS_SETTING_KEYS.cursorSize), 1);
  assert.deepEqual(writeDenied.events, [
    `apply:${A11Y_PREFS_SETTING_KEYS.cursorSize}=1.75`,
  ]);
});

type FakeSettingValue = string | number | boolean | null;

interface FakeA11yPrefsFixture {
  readonly ports: A11yPrefsViewModelPorts;
  readonly settings: Map<string, FakeSettingValue>;
  readonly events: string[];
}

interface InvalidActionCase {
  readonly code: string;
  run(): Promise<A11yPrefsViewModelActionResult>;
}

interface InvalidInitialSettingCase {
  readonly code: string;
  readonly key: A11yPrefsSettingKey;
  readonly value: FakeSettingValue;
}

function initialSettings(
  overrides: Readonly<Partial<Record<A11yPrefsSettingKey, FakeSettingValue>>> = Object.freeze({}),
): Readonly<Record<A11yPrefsSettingKey, FakeSettingValue>> {
  return Object.freeze({
    [A11Y_PREFS_SETTING_KEYS.contrast]: overrides[A11Y_PREFS_SETTING_KEYS.contrast] ?? "normal",
    [A11Y_PREFS_SETTING_KEYS.cursorSize]: overrides[A11Y_PREFS_SETTING_KEYS.cursorSize] ?? 1,
    [A11Y_PREFS_SETTING_KEYS.focusRingThickness]: overrides[A11Y_PREFS_SETTING_KEYS.focusRingThickness] ?? 2,
    [A11Y_PREFS_SETTING_KEYS.reduceMotion]: overrides[A11Y_PREFS_SETTING_KEYS.reduceMotion] ?? false,
    [A11Y_PREFS_SETTING_KEYS.reduceTransparency]: overrides[A11Y_PREFS_SETTING_KEYS.reduceTransparency] ?? false,
    [A11Y_PREFS_SETTING_KEYS.textScale]: overrides[A11Y_PREFS_SETTING_KEYS.textScale] ?? 1,
    [A11Y_PREFS_SETTING_KEYS.uiZoom]: overrides[A11Y_PREFS_SETTING_KEYS.uiZoom] ?? 1,
  });
}

function fakeA11yPrefsPorts(options: {
  readonly applyPort?: boolean;
  readonly failReads?: ReadonlySet<string>;
  readonly failWrites?: ReadonlySet<string>;
  readonly readPort?: boolean;
  readonly readThrows?: ReadonlySet<string>;
  readonly settings: Readonly<Record<string, FakeSettingValue>>;
  readonly writeThrows?: ReadonlySet<string>;
}): FakeA11yPrefsFixture {
  const events: string[] = [];
  const settings = new Map<string, FakeSettingValue>(Object.entries(options.settings));
  const ports: {
    readSetting?: NonNullable<A11yPrefsViewModelPorts["readSetting"]>;
    applySetting?: NonNullable<A11yPrefsViewModelPorts["applySetting"]>;
  } = {};

  if (options.readPort !== false) {
    ports.readSetting = (request) => {
      events.push(`read:${request.key}`);

      if (options.readThrows?.has(request.key) === true) {
        throw new Error("read failed");
      }
      if (options.failReads?.has(request.key) === true) {
        return hostReject("READ_REJECTED", "read rejected by fake settings port.", "/settings/read");
      }

      const value = settings.get(request.key);

      if (value === undefined) {
        return hostReject("SETTING_NOT_FOUND", "setting is not available.", `/settings/${request.key}`);
      }

      return {
        ok: true,
        value,
      };
    };
  }

  if (options.applyPort !== false) {
    ports.applySetting = (request) => {
      events.push(`apply:${request.key}=${String(request.value)}`);

      if (options.writeThrows?.has(request.key) === true) {
        throw new Error("write failed");
      }
      if (options.failWrites?.has(request.key) === true) {
        return hostReject("WRITE_REJECTED", "write rejected by fake settings port.", "/settings/apply");
      }
      if (!isFakeSettingValue(request.value)) {
        return hostReject("MALFORMED_WRITE", "fake settings port only accepts scalar values.", "/settings/apply/value");
      }

      settings.set(request.key, request.value);

      return {
        ok: true,
        value: Object.freeze({
          applied: Object.freeze({
            key: request.key,
            value: request.value,
          }),
          revision: `rev-${events.length}`,
        }),
      };
    };
  }

  return Object.freeze({
    events,
    ports: Object.freeze(ports),
    settings,
  });
}

function expectedReadEvents(): readonly string[] {
  return Object.freeze([
    `read:${A11Y_PREFS_SETTING_KEYS.uiZoom}`,
    `read:${A11Y_PREFS_SETTING_KEYS.contrast}`,
    `read:${A11Y_PREFS_SETTING_KEYS.reduceMotion}`,
    `read:${A11Y_PREFS_SETTING_KEYS.reduceTransparency}`,
    `read:${A11Y_PREFS_SETTING_KEYS.textScale}`,
    `read:${A11Y_PREFS_SETTING_KEYS.cursorSize}`,
    `read:${A11Y_PREFS_SETTING_KEYS.focusRingThickness}`,
  ]);
}

function assertAccepted(result: A11yPrefsViewModelActionResult): asserts result is {
  readonly ok: true;
  readonly state: A11yPrefsState;
} {
  assert.equal(result.ok, true);
}

function assertRejected(
  result: A11yPrefsViewModelActionResult,
  code: string,
  state: A11yPrefsState,
): void {
  assert.equal(result.ok, false);
  if (result.ok) {
    assert.fail("expected a11y preference action to fail closed");
  }

  assert.equal(result.error.code, code);
  assert.equal(result.state, state);
}

function isFakeSettingValue(value: unknown): value is FakeSettingValue {
  return (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  );
}

function hostReject<T>(code: string, message: string, path: string): DesktopHostResult<T> {
  return {
    error: {
      code,
      message,
      path,
    },
    ok: false,
  };
}
