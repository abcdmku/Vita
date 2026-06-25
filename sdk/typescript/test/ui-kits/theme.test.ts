import assert from "node:assert/strict";
import { test } from "node:test";

import {
  THEME_APPEARANCE_SETTING_KEYS,
  createThemeViewModel,
} from "../../../../ui_kits/desktop/viewmodels/theme.ts";
import type {
  ThemeAccent,
  ThemeLayout,
  ThemeVariant,
  ThemeViewModelPorts,
} from "../../../../ui_kits/desktop/viewmodels/theme.ts";
import {
  themeTokens,
} from "../../src/desktop-sdk/index.ts";
import type {
  DesktopHostResult,
} from "../../src/desktop-sdk/index.ts";

test("theme view-model reads appearance settings and resolves SDK tokens and screen classes", async () => {
  const fixture = fakeThemePorts({
    settings: initialSettings({
      accent: "teal",
      layout: "compact",
      theme: "dark",
    }),
  });

  const loaded = await createThemeViewModel(fixture.ports);

  assert.equal(loaded.ok, true);
  if (!loaded.ok) {
    assert.fail("expected Theme view-model to load");
  }

  assert.deepEqual(fixture.events, [
    `read:${THEME_APPEARANCE_SETTING_KEYS.theme}`,
    `read:${THEME_APPEARANCE_SETTING_KEYS.accent}`,
    `read:${THEME_APPEARANCE_SETTING_KEYS.layout}`,
  ]);
  assert.equal(loaded.value.state.theme, "dark");
  assert.equal(loaded.value.state.appearance.theme, "dark");
  assert.equal(loaded.value.state.accent, "teal");
  assert.equal(loaded.value.state.accentColor, "#14b8a6");
  assert.equal(loaded.value.state.layout, "compact");
  assert.equal(loaded.value.state.density, "compact");
  assert.equal(loaded.value.state.tiling, false);
  assert.equal(loaded.value.state.tokenVariant, "dark");
  assert.deepEqual(loaded.value.state.screenClasses, ["v-screen", "theme-dark"]);
  assert.equal(loaded.value.state.screenClassName, "v-screen theme-dark");
  assert.equal(loaded.value.state.tokens.color["surface-base"], themeTokens.variants.dark.color["surface-base"]);
  assert.equal(loaded.value.state.tokens.color["accent"], "#14b8a6");
  assert.equal(loaded.value.state.tokens.color["accent-hover"], "#0d9488");
  assert.equal(loaded.value.state.tokens.space["space-2"], themeTokens.variants.dark.space["space-2"]);
  assert.equal(Object.isFrozen(loaded.value.state), true);
  assert.equal(Object.isFrozen(loaded.value.state.appearance), true);
  assert.equal(Object.isFrozen(loaded.value.state.screenClasses), true);
  assert.equal(Object.isFrozen(loaded.value.state.tokens.color), true);
});

test("theme actions persist through the settings port and expose the next frozen state", async () => {
  const fixture = fakeThemePorts({
    settings: initialSettings(),
  });
  const loaded = await createThemeViewModel(fixture.ports);

  assert.equal(loaded.ok, true);
  if (!loaded.ok) {
    assert.fail("expected Theme view-model to load");
  }

  fixture.events.length = 0;

  const theme = await loaded.value.setTheme("graphite");
  const accent = await loaded.value.setAccent("orange");
  const layout = await loaded.value.setLayout("tiling");

  assert.equal(theme.ok, true);
  assert.equal(accent.ok, true);
  assert.equal(layout.ok, true);
  assert.deepEqual(fixture.events, [
    `apply:${THEME_APPEARANCE_SETTING_KEYS.theme}=graphite`,
    `apply:${THEME_APPEARANCE_SETTING_KEYS.accent}=orange`,
    `apply:${THEME_APPEARANCE_SETTING_KEYS.layout}=tiling`,
  ]);
  assert.equal(loaded.value.state.theme, "graphite");
  assert.equal(loaded.value.state.accent, "orange");
  assert.equal(loaded.value.state.accentColor, "#f97316");
  assert.equal(loaded.value.state.layout, "tiling");
  assert.equal(loaded.value.state.density, "compact");
  assert.equal(loaded.value.state.tiling, true);
  assert.equal(loaded.value.state.tokenVariant, "graphite");
  assert.deepEqual(loaded.value.state.screenClasses, ["v-screen", "theme-dark", "mode-tiling"]);
  assert.equal(loaded.value.state.tokens.color["surface-base"], themeTokens.variants.graphite.color["surface-base"]);
  assert.equal(loaded.value.state.tokens.color["accent-active"], "#c2410c");
  assert.equal(fixture.settings.get(THEME_APPEARANCE_SETTING_KEYS.theme), "graphite");
  assert.equal(fixture.settings.get(THEME_APPEARANCE_SETTING_KEYS.accent), "orange");
  assert.equal(fixture.settings.get(THEME_APPEARANCE_SETTING_KEYS.layout), "tiling");
});

test("tiling layout toggles mode-tiling class while preserving the selected theme variant", async () => {
  const fixture = fakeThemePorts({
    settings: initialSettings({
      accent: "green",
      layout: "floating",
      theme: "light",
    }),
  });
  const loaded = await createThemeViewModel(fixture.ports);

  assert.equal(loaded.ok, true);
  if (!loaded.ok) {
    assert.fail("expected Theme view-model to load");
  }

  fixture.events.length = 0;
  const changed = await loaded.value.setLayout("tiling");

  assert.equal(changed.ok, true);
  assert.equal(changed.state.theme, "light");
  assert.equal(changed.state.tokenVariant, "light");
  assert.deepEqual(changed.state.screenClasses, ["v-screen", "mode-tiling"]);
  assert.equal(changed.state.tokens.color["surface-base"], themeTokens.variants.light.color["surface-base"]);
  assert.equal(changed.state.tokens.color["accent"], "#10b981");
  assert.deepEqual(fixture.events, [
    `apply:${THEME_APPEARANCE_SETTING_KEYS.layout}=tiling`,
  ]);
});

test("theme actions reject unknown and malformed values without touching settings", async () => {
  const fixture = fakeThemePorts({
    settings: initialSettings(),
  });
  const loaded = await createThemeViewModel(fixture.ports);

  assert.equal(loaded.ok, true);
  if (!loaded.ok) {
    assert.fail("expected Theme view-model to load");
  }

  const before = loaded.value.state;
  const cyclic: { self?: unknown } = {};

  cyclic.self = cyclic;
  fixture.events.length = 0;

  const theme = await loaded.value.setTheme("auto");
  const accent = await loaded.value.setAccent(cyclic);
  const layout = await loaded.value.setLayout("masonry");

  assert.equal(theme.ok, false);
  assert.equal(accent.ok, false);
  assert.equal(layout.ok, false);
  assert.deepEqual([
    theme.ok ? "" : theme.error.code,
    accent.ok ? "" : accent.error.code,
    layout.ok ? "" : layout.error.code,
  ], [
    "UNKNOWN_THEME",
    "UNKNOWN_ACCENT",
    "UNKNOWN_LAYOUT",
  ]);
  assert.equal(loaded.value.state, before);
  assert.deepEqual(fixture.events, []);
});

test("theme view-model rejects malformed initial settings fail-closed", async () => {
  const fixture = fakeThemePorts({
    settings: {
      ...initialSettings(),
      [THEME_APPEARANCE_SETTING_KEYS.accent]: "magenta",
    },
  });

  const loaded = await createThemeViewModel(fixture.ports);

  assert.equal(loaded.ok, false);
  if (loaded.ok) {
    assert.fail("expected malformed setting to fail closed");
  }
  assert.equal(loaded.error.code, "UNKNOWN_ACCENT");
  assert.deepEqual(fixture.events, [
    `read:${THEME_APPEARANCE_SETTING_KEYS.theme}`,
    `read:${THEME_APPEARANCE_SETTING_KEYS.accent}`,
  ]);
});

test("theme view-model fails closed when settings ports are unavailable", async () => {
  const missingRead = await createThemeViewModel({});

  assert.equal(missingRead.ok, false);
  if (missingRead.ok) {
    assert.fail("expected missing read port to fail closed");
  }
  assert.equal(missingRead.error.code, "SETTINGS_PORT_UNAVAILABLE");

  const fixture = fakeThemePorts({
    applyPort: false,
    settings: initialSettings(),
  });
  const loaded = await createThemeViewModel(fixture.ports);

  assert.equal(loaded.ok, true);
  if (!loaded.ok) {
    assert.fail("expected Theme view-model to load");
  }

  const before = loaded.value.state;
  fixture.events.length = 0;

  const changed = await loaded.value.setTheme("dark");

  assert.equal(changed.ok, false);
  if (changed.ok) {
    assert.fail("expected missing write port to fail closed");
  }
  assert.equal(changed.error.code, "SETTINGS_PORT_UNAVAILABLE");
  assert.equal(changed.state, before);
  assert.deepEqual(fixture.events, []);
});

test("settings write failures preserve the previous theme state", async () => {
  const fixture = fakeThemePorts({
    failWrites: new Set([THEME_APPEARANCE_SETTING_KEYS.layout]),
    settings: initialSettings(),
  });
  const loaded = await createThemeViewModel(fixture.ports);

  assert.equal(loaded.ok, true);
  if (!loaded.ok) {
    assert.fail("expected Theme view-model to load");
  }

  const before = loaded.value.state;
  fixture.events.length = 0;

  const changed = await loaded.value.setLayout("tiling");

  assert.equal(changed.ok, false);
  if (changed.ok) {
    assert.fail("expected write failure to fail closed");
  }
  assert.equal(changed.error.code, "WRITE_REJECTED");
  assert.equal(changed.state, before);
  assert.equal(loaded.value.state, before);
  assert.equal(fixture.settings.get(THEME_APPEARANCE_SETTING_KEYS.layout), "comfortable");
  assert.deepEqual(fixture.events, [
    `apply:${THEME_APPEARANCE_SETTING_KEYS.layout}=tiling`,
  ]);
});

type FakeSettingValue = string | number | boolean | null;

interface FakeThemeFixture {
  readonly ports: ThemeViewModelPorts;
  readonly settings: Map<string, FakeSettingValue>;
  readonly events: string[];
}

function initialSettings(overrides: {
  readonly accent?: ThemeAccent;
  readonly layout?: ThemeLayout;
  readonly theme?: ThemeVariant;
} = Object.freeze({})): Readonly<Record<string, string>> {
  return Object.freeze({
    [THEME_APPEARANCE_SETTING_KEYS.accent]: overrides.accent ?? "blue",
    [THEME_APPEARANCE_SETTING_KEYS.layout]: overrides.layout ?? "comfortable",
    [THEME_APPEARANCE_SETTING_KEYS.theme]: overrides.theme ?? "light",
  });
}

function fakeThemePorts(options: {
  readonly applyPort?: boolean;
  readonly failWrites?: ReadonlySet<string>;
  readonly readPort?: boolean;
  readonly settings: Readonly<Record<string, FakeSettingValue>>;
}): FakeThemeFixture {
  const events: string[] = [];
  const settings = new Map<string, FakeSettingValue>(Object.entries(options.settings));
  const ports: {
    readSetting?: NonNullable<ThemeViewModelPorts["readSetting"]>;
    applySetting?: NonNullable<ThemeViewModelPorts["applySetting"]>;
  } = {};

  if (options.readPort !== false) {
    ports.readSetting = (request) => {
      events.push(`read:${request.key}`);

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

      if (options.failWrites?.has(request.key) === true) {
        return hostReject("WRITE_REJECTED", "write rejected by fake settings port.", "/settings/apply");
      }
      if (typeof request.value !== "string") {
        return hostReject("MALFORMED_WRITE", "fake settings port only accepts string values.", "/settings/apply/value");
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
