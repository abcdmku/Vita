import assert from "node:assert/strict";
import { test } from "node:test";

import {
  DEFAULT_INPUT_ACCESSIBILITY_SETTINGS,
  INPUT_ACCESSIBILITY_SETTING_KEY,
  createInputAccessibilityViewModel,
} from "../../../../ui_kits/desktop/viewmodels/input-accessibility.ts";
import type {
  InputAccessibilityActionResult,
  InputAccessibilityBounceKeysSettings,
  InputAccessibilityClock,
  InputAccessibilityKeyRepeatSettings,
  InputAccessibilityPorts,
  InputAccessibilityRawKeyEvent,
  InputAccessibilitySettings,
  InputAccessibilitySlowKeysSettings,
  InputAccessibilityStickyKeysSettings,
  InputAccessibilityViewModel,
} from "../../../../ui_kits/desktop/viewmodels/input-accessibility.ts";
import type {
  DesktopCapabilityGrant,
  DesktopHostResult,
  DesktopSettingsApply,
  DesktopUiPackageManifest,
} from "../../src/desktop-sdk/index.ts";

type FakeSettingValue = Parameters<NonNullable<InputAccessibilityPorts["applySetting"]>>[0]["value"];

test("input accessibility sticky keys latch modifiers across separate strokes", async () => {
  const fixture = fakePorts({
    grants: readWriteGrants(),
    settings: policy({
      keyRepeat: { enabled: false },
      stickyKeys: { enabled: true },
    }),
  });
  const vm = await loadViewModel(fixture);

  const result = vm.process([
    key("down", "Control", "ControlLeft", 0),
    key("up", "Control", "ControlLeft", 10),
    key("down", "a", "KeyA", 20),
    key("up", "a", "KeyA", 30),
    key("down", "b", "KeyB", 40),
    key("up", "b", "KeyB", 50),
  ]);

  assert.equal(result.ok, true);
  if (!result.ok) assert.fail("expected sticky-key stream to process");
  assert.deepEqual(chordSummary(result), [
    [20, "Control+A", "physical", false],
    [40, "B", "physical", false],
  ]);
  assert.deepEqual(result.state.latchedModifiers, []);
  assert.deepEqual(fixture.events, [`read:${INPUT_ACCESSIBILITY_SETTING_KEY}`]);
});

test("input accessibility slow keys register at threshold and drop early release via injected clock", async () => {
  const clock = new FakeClock(0);
  const fixture = fakePorts({
    grants: readWriteGrants(),
    settings: policy({
      keyRepeat: { enabled: false },
      slowKeys: {
        enabled: true,
        holdThresholdMs: 100,
      },
    }),
  });
  const vm = await loadViewModel(fixture, clock);

  assert.deepEqual(chordSummary(vm.handleKeyEvent({ code: "KeyA", key: "a", type: "down" })), []);

  clock.current = 99;
  assert.deepEqual(chordSummary(vm.handleKeyEvent({ code: "KeyA", key: "a", type: "up" })), []);

  clock.current = 200;
  assert.deepEqual(chordSummary(vm.handleKeyEvent({ code: "KeyB", key: "b", type: "down" })), []);

  clock.current = 299;
  assert.deepEqual(chordSummary(vm.flush()), []);

  clock.current = 300;
  assert.deepEqual(chordSummary(vm.flush()), [
    [300, "B", "slow", false],
  ]);

  clock.current = 310;
  assert.deepEqual(chordSummary(vm.handleKeyEvent({ code: "KeyB", key: "b", type: "up" })), []);
});

test("input accessibility bounce keys debounce repeated same-key presses inside the window", async () => {
  const fixture = fakePorts({
    grants: readWriteGrants(),
    settings: policy({
      bounceKeys: {
        debounceWindowMs: 100,
        enabled: true,
      },
      keyRepeat: { enabled: false },
    }),
  });
  const vm = await loadViewModel(fixture);

  const result = vm.process([
    key("down", "a", "KeyA", 0),
    key("up", "a", "KeyA", 10),
    key("down", "a", "KeyA", 50),
    key("up", "a", "KeyA", 60),
    key("down", "a", "KeyA", 100),
    key("up", "a", "KeyA", 110),
  ]);

  assert.equal(result.ok, true);
  if (!result.ok) assert.fail("expected bounce-key stream to process");
  assert.deepEqual(chordSummary(result), [
    [0, "A", "physical", false],
    [100, "A", "physical", false],
  ]);
});

test("input accessibility key-repeat synthesizes down chords after delay at the configured rate", async () => {
  const fixture = fakePorts({
    grants: readWriteGrants(),
    settings: policy({
      keyRepeat: {
        enabled: true,
        repeatDelayMs: 200,
        repeatRateMs: 100,
      },
    }),
  });
  const vm = await loadViewModel(fixture);

  const result = vm.process([
    key("down", "a", "KeyA", 0),
    key("up", "a", "KeyA", 450),
  ]);

  assert.equal(result.ok, true);
  if (!result.ok) assert.fail("expected repeat stream to process");
  assert.deepEqual(chordSummary(result), [
    [0, "A", "physical", false],
    [200, "A", "repeat", true],
    [300, "A", "repeat", true],
    [400, "A", "repeat", true],
  ]);
});

test("input accessibility output is byte-identical for the same stream and clock", async () => {
  const settings = policy({
    bounceKeys: {
      debounceWindowMs: 80,
      enabled: true,
    },
    keyRepeat: {
      enabled: true,
      repeatDelayMs: 100,
      repeatRateMs: 100,
    },
    slowKeys: {
      enabled: true,
      holdThresholdMs: 50,
    },
    stickyKeys: {
      enabled: true,
      lockOnDoublePress: true,
    },
  });
  const first = await runDeterministicScenario(settings);
  const second = await runDeterministicScenario(settings);

  assert.equal(JSON.stringify(first), JSON.stringify(second));
  assert.deepEqual(first, [
    [120, "Control+A", "slow", false],
    [220, "Control+A", "repeat", true],
  ]);
});

test("input accessibility settings load fails closed when the settings grant is absent", async () => {
  const fixture = fakePorts({
    grants: [],
    settings: policy(),
  });

  const loaded = await createInputAccessibilityViewModel(fixture.ports, new FakeClock(0));

  assert.equal(loaded.ok, false);
  if (loaded.ok) assert.fail("expected settings load to fail closed");
  assert.equal(loaded.error.code, "MISSING_CAPABILITY");
  assert.deepEqual(fixture.events, []);
});

test("input accessibility settings save writes through the SDK settings port", async () => {
  const fixture = fakePorts({
    grants: readWriteGrants(),
    settings: policy(),
  });
  const vm = await loadViewModel(fixture);
  const next = policy({
    keyRepeat: {
      enabled: true,
      repeatDelayMs: 300,
      repeatRateMs: 75,
    },
    stickyKeys: {
      enabled: true,
      lockOnDoublePress: true,
    },
  });

  fixture.events.length = 0;
  const written = await vm.setSettings(next);

  assert.equal(written.ok, true);
  if (!written.ok) assert.fail("expected settings write to succeed");
  assert.deepEqual(fixture.events, [`apply:${INPUT_ACCESSIBILITY_SETTING_KEY}`]);
  assert.equal(vm.state.settings.keyRepeat.repeatDelayMs, 300);
  assert.equal(vm.state.settings.stickyKeys.lockOnDoublePress, true);
  assert.deepEqual(fixture.settings.get(INPUT_ACCESSIBILITY_SETTING_KEY), policyValue(next));
});

test("input accessibility rejects malformed streams without reading accessors", async () => {
  const fixture = fakePorts({
    grants: readWriteGrants(),
    settings: policy(),
  });
  const vm = await loadViewModel(fixture);
  let reads = 0;
  const hostile: Record<string, unknown> = {
    at: 0,
    code: "KeyA",
    type: "down",
  };

  Object.defineProperty(hostile, "key", {
    enumerable: true,
    get() {
      reads += 1;
      return "a";
    },
  });

  const result = vm.process([hostile]);

  assert.equal(result.ok, false);
  if (result.ok) assert.fail("expected accessor event to fail closed");
  assert.equal(result.error.code, "INVALID_KEY_EVENT");
  assert.equal(reads, 0);
  assert.deepEqual(vm.state.chords, []);
});

async function runDeterministicScenario(settings: InputAccessibilitySettings): Promise<readonly ChordSummary[]> {
  const fixture = fakePorts({
    grants: readWriteGrants(),
    settings,
  });
  const vm = await loadViewModel(fixture);
  const result = vm.process([
    key("down", "Control", "ControlLeft", 0),
    key("up", "Control", "ControlLeft", 60),
    key("down", "a", "KeyA", 70),
    key("up", "a", "KeyA", 250),
    key("down", "a", "KeyA", 260),
    key("up", "a", "KeyA", 270),
  ]);

  assert.equal(result.ok, true);
  if (!result.ok) assert.fail("expected deterministic scenario to process");

  return chordSummary(result);
}

class FakeClock implements InputAccessibilityClock {
  current: number;

  constructor(current: number) {
    this.current = current;
  }

  now(): number {
    return this.current;
  }
}

interface FakePortsFixture {
  readonly events: string[];
  readonly ports: InputAccessibilityPorts;
  readonly settings: Map<string, FakeSettingValue>;
}

interface PolicyOverrides {
  readonly bounceKeys?: Readonly<Partial<InputAccessibilityBounceKeysSettings>>;
  readonly keyRepeat?: Readonly<Partial<InputAccessibilityKeyRepeatSettings>>;
  readonly slowKeys?: Readonly<Partial<InputAccessibilitySlowKeysSettings>>;
  readonly stickyKeys?: Readonly<Partial<InputAccessibilityStickyKeysSettings>>;
}

type ChordSummary = readonly [number, string, string, boolean];

async function loadViewModel(
  fixture: FakePortsFixture,
  clock: InputAccessibilityClock = new FakeClock(0),
): Promise<InputAccessibilityViewModel> {
  const loaded = await createInputAccessibilityViewModel(fixture.ports, clock);

  assert.equal(loaded.ok, true);
  if (!loaded.ok) assert.fail("expected input accessibility VM to load");

  return loaded.value;
}

function fakePorts(options: {
  readonly grants: readonly DesktopCapabilityGrant[];
  readonly settings: InputAccessibilitySettings;
}): FakePortsFixture {
  const events: string[] = [];
  const settings = new Map<string, FakeSettingValue>([
    [INPUT_ACCESSIBILITY_SETTING_KEY, policyValue(options.settings)],
  ]);
  const ports: InputAccessibilityPorts = {
    applySetting(
      request: Parameters<NonNullable<InputAccessibilityPorts["applySetting"]>>[0],
    ): DesktopHostResult<DesktopSettingsApply> {
      events.push(`apply:${request.key}`);
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
    },
    package: manifest(options.grants),
    readSetting(request: Parameters<NonNullable<InputAccessibilityPorts["readSetting"]>>[0]) {
      events.push(`read:${request.key}`);
      const value = settings.get(request.key);

      if (value === undefined) {
        return hostReject("SETTING_NOT_FOUND", "setting is not available.", `/settings/${request.key}`);
      }

      return {
        ok: true,
        value,
      };
    },
  };

  return {
    events,
    ports: Object.freeze(ports),
    settings,
  };
}

function policy(overrides: PolicyOverrides = Object.freeze({})): InputAccessibilitySettings {
  return Object.freeze({
    bounceKeys: Object.freeze({
      ...DEFAULT_INPUT_ACCESSIBILITY_SETTINGS.bounceKeys,
      ...overrides.bounceKeys,
    }),
    keyRepeat: Object.freeze({
      ...DEFAULT_INPUT_ACCESSIBILITY_SETTINGS.keyRepeat,
      ...overrides.keyRepeat,
    }),
    slowKeys: Object.freeze({
      ...DEFAULT_INPUT_ACCESSIBILITY_SETTINGS.slowKeys,
      ...overrides.slowKeys,
    }),
    stickyKeys: Object.freeze({
      ...DEFAULT_INPUT_ACCESSIBILITY_SETTINGS.stickyKeys,
      ...overrides.stickyKeys,
    }),
  });
}

function policyValue(settings: InputAccessibilitySettings): FakeSettingValue {
  const value: FakeSettingValue = Object.freeze({
    bounceKeys: Object.freeze({
      debounceWindowMs: settings.bounceKeys.debounceWindowMs,
      enabled: settings.bounceKeys.enabled,
    }),
    keyRepeat: Object.freeze({
      enabled: settings.keyRepeat.enabled,
      repeatDelayMs: settings.keyRepeat.repeatDelayMs,
      repeatRateMs: settings.keyRepeat.repeatRateMs,
    }),
    slowKeys: Object.freeze({
      enabled: settings.slowKeys.enabled,
      holdThresholdMs: settings.slowKeys.holdThresholdMs,
    }),
    stickyKeys: Object.freeze({
      enabled: settings.stickyKeys.enabled,
      lockOnDoublePress: settings.stickyKeys.lockOnDoublePress,
    }),
  });

  return value;
}

function key(
  type: InputAccessibilityRawKeyEvent["type"],
  keyValue: string,
  code: string,
  at: number,
): InputAccessibilityRawKeyEvent {
  return Object.freeze({
    at,
    code,
    key: keyValue,
    type,
  });
}

function chordSummary(result: InputAccessibilityActionResult): readonly ChordSummary[] {
  if (!result.ok) return Object.freeze([]);

  return Object.freeze(result.chords.map((event) => Object.freeze([
    event.at,
    event.chord,
    event.source,
    event.repeat,
  ] as const)));
}

function readWriteGrants(): readonly DesktopCapabilityGrant[] {
  return Object.freeze([
    Object.freeze({
      capability: "settings.read",
      resourceId: INPUT_ACCESSIBILITY_SETTING_KEY,
    }),
    Object.freeze({
      capability: "settings.write",
      resourceId: INPUT_ACCESSIBILITY_SETTING_KEY,
    }),
  ]);
}

function manifest(grants: readonly DesktopCapabilityGrant[]): DesktopUiPackageManifest {
  return Object.freeze({
    capabilityGrants: Object.freeze(grants.map((grant) => Object.freeze(grant))),
    entry: "./input-accessibility.test.ts",
    id: "ui.input-accessibility.test",
    sdkVersion: "1.0.0",
    version: "1.0.0",
  });
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
