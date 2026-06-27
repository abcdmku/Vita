import assert from "node:assert/strict";
import { test } from "node:test";

import {
  SETTINGS_APPEARANCE_KEYS,
  createSettingsViewModel,
} from "../../../../ui_kits/desktop/viewmodels/Settings.ts";
import {
  createDesktopHostForPackage,
} from "../../src/desktop-sdk/index.ts";
import type {
  DesktopAppLaunch,
  DesktopAppStop,
  DesktopCapabilityGrant,
  DesktopHost,
  DesktopHostResult,
  DesktopLaunchableApp,
  DesktopSettingsApply,
  DesktopTheme,
  DesktopUiPackageManifest,
  NotificationPostInput,
  RegisteredShellComponent,
  ShellApplyResult,
  ShellComponentDefinition,
  ShellNotification,
  ShellPreviewResult,
  ShellResult,
  ShellRollbackResult,
  TrayItem,
  TrayItemInput,
} from "../../src/desktop-sdk/index.ts";

test("settings view-model reads initial Appearance state from settings and theme ports", async () => {
  const fixture = fakeHost({
    settings: {
      [SETTINGS_APPEARANCE_KEYS.accent]: "blue",
      [SETTINGS_APPEARANCE_KEYS.activeSection]: "appearance",
      [SETTINGS_APPEARANCE_KEYS.layout]: "compact",
      [SETTINGS_APPEARANCE_KEYS.theme]: "dark",
    },
  });

  const loaded = await createSettingsViewModel(fixture.host);

  assert.equal(loaded.ok, true);
  if (!loaded.ok) {
    assert.fail("expected Settings view-model to load");
  }

  assert.deepEqual(fixture.events, [
    "theme:read",
    `read:${SETTINGS_APPEARANCE_KEYS.activeSection}`,
    `read:${SETTINGS_APPEARANCE_KEYS.theme}`,
    `read:${SETTINGS_APPEARANCE_KEYS.accent}`,
    `read:${SETTINGS_APPEARANCE_KEYS.layout}`,
  ]);
  assert.equal(loaded.value.state.activeSection, "appearance");
  assert.equal(loaded.value.state.appearance.theme, "dark");
  assert.equal(loaded.value.state.appearance.accent, "blue");
  assert.equal(loaded.value.state.appearance.accentColor, "#3178c6");
  assert.equal(loaded.value.state.appearance.layout, "compact");
  assert.equal(loaded.value.state.appearance.density, "compact");
  assert.equal(loaded.value.state.appearance.tiling, false);
  assert.equal(loaded.value.state.theme.id, "vita.test.theme");
  assert.equal(loaded.value.state.theme.tokens.colors["background"], "#101418");
  assert.deepEqual(loaded.value.state.sections.map((section) => [section.id, section.active]), [
    ["general", false],
    ["appearance", true],
    ["network", false],
    ["sound", false],
    ["display", false],
    ["accounts", false],
    ["privacy", false],
    ["developer", false],
  ]);
  assert.equal(Object.isFrozen(loaded.value.state), true);
  assert.equal(Object.isFrozen(loaded.value.state.sections), true);
});

test("settings actions write through the settings port and reflect accepted values", async () => {
  const fixture = fakeHost({
    settings: initialSettings(),
  });
  const loaded = await createSettingsViewModel(fixture.host);

  assert.equal(loaded.ok, true);
  if (!loaded.ok) {
    assert.fail("expected Settings view-model to load");
  }

  fixture.events.length = 0;

  const theme = await loaded.value.setTheme("graphite");
  const accent = await loaded.value.setAccent("teal");
  const layout = await loaded.value.setLayout("tiling");
  const section = await loaded.value.select("network");

  assert.equal(theme.ok, true);
  assert.equal(accent.ok, true);
  assert.equal(layout.ok, true);
  assert.equal(section.ok, true);
  assert.deepEqual(fixture.events, [
    `apply:${SETTINGS_APPEARANCE_KEYS.theme}=graphite`,
    `apply:${SETTINGS_APPEARANCE_KEYS.accent}=teal`,
    `apply:${SETTINGS_APPEARANCE_KEYS.layout}=tiling`,
    `apply:${SETTINGS_APPEARANCE_KEYS.activeSection}=network`,
  ]);
  assert.equal(loaded.value.state.appearance.theme, "graphite");
  assert.equal(loaded.value.state.appearance.accent, "teal");
  assert.equal(loaded.value.state.appearance.accentColor, "#14b8a6");
  assert.equal(loaded.value.state.appearance.layout, "tiling");
  assert.equal(loaded.value.state.appearance.tiling, true);
  assert.equal(loaded.value.state.appearance.density, "compact");
  assert.equal(loaded.value.state.activeSection, "network");
  assert.equal(loaded.value.state.sections.find((entry) => entry.id === "network")?.active, true);
  assert.equal(fixture.settings.get(SETTINGS_APPEARANCE_KEYS.theme), "graphite");
  assert.equal(fixture.settings.get(SETTINGS_APPEARANCE_KEYS.accent), "teal");
  assert.equal(fixture.settings.get(SETTINGS_APPEARANCE_KEYS.layout), "tiling");
  assert.equal(fixture.settings.get(SETTINGS_APPEARANCE_KEYS.activeSection), "network");
});

test("settings actions reject unknown enum values without touching the settings port", async () => {
  const fixture = fakeHost({
    settings: initialSettings(),
  });
  const loaded = await createSettingsViewModel(fixture.host);

  assert.equal(loaded.ok, true);
  if (!loaded.ok) {
    assert.fail("expected Settings view-model to load");
  }

  const before = loaded.value.state;
  fixture.events.length = 0;

  const theme = await loaded.value.setTheme("auto");
  const accent = await loaded.value.setAccent("magenta");
  const layout = await loaded.value.setLayout("masonry");
  const section = await loaded.value.select("missing");

  assert.equal(theme.ok, false);
  assert.equal(accent.ok, false);
  assert.equal(layout.ok, false);
  assert.equal(section.ok, false);
  assert.deepEqual([
    theme.ok ? "" : theme.error.code,
    accent.ok ? "" : accent.error.code,
    layout.ok ? "" : layout.error.code,
    section.ok ? "" : section.error.code,
  ], [
    "UNKNOWN_THEME",
    "UNKNOWN_ACCENT",
    "UNKNOWN_LAYOUT",
    "UNKNOWN_SETTINGS_SECTION",
  ]);
  assert.deepEqual(fixture.events, []);
  assert.equal(loaded.value.state, before);
});

test("settings view-model fails closed without settings read grants", async () => {
  const fixture = fakeHost({
    settings: initialSettings(),
  });
  const scoped = createDesktopHostForPackage(fixture.host, manifest("ui.no-settings", []));
  const loaded = await createSettingsViewModel(scoped);

  assert.equal(loaded.ok, false);
  if (loaded.ok) {
    assert.fail("expected Settings view-model to fail closed");
  }

  // Host-boundary denial: a package with no settings grant is refused by the SDK
  // host boundary (createDesktopHostForPackage) with CAP_DENIED before the view-model's
  // own MISSING_CAPABILITY self-check runs. Both codes are intentional (see memory
  // vita-capability-denial-codes); the boundary code is the one observed here.
  assert.equal(loaded.error.code, "CAP_DENIED");
  assert.deepEqual(fixture.events, ["theme:read"]);
});

test("settings writes fail closed without write grants and preserve state", async () => {
  const fixture = fakeHost({
    settings: initialSettings(),
  });
  const scoped = createDesktopHostForPackage(fixture.host, manifest("ui.read-only-settings", [
    { capability: "settings.read", resourceId: SETTINGS_APPEARANCE_KEYS.activeSection },
    { capability: "settings.read", resourceId: SETTINGS_APPEARANCE_KEYS.theme },
    { capability: "settings.read", resourceId: SETTINGS_APPEARANCE_KEYS.accent },
    { capability: "settings.read", resourceId: SETTINGS_APPEARANCE_KEYS.layout },
  ]));
  const loaded = await createSettingsViewModel(scoped);

  assert.equal(loaded.ok, true);
  if (!loaded.ok) {
    assert.fail("expected Settings view-model to load");
  }

  const before = loaded.value.state;
  fixture.events.length = 0;

  const changed = await loaded.value.setTheme("graphite");

  assert.equal(changed.ok, false);
  if (changed.ok) {
    assert.fail("expected write to fail closed");
  }
  // Write without a settings.write grant is refused at the SDK host boundary (CAP_DENIED)
  // before the view-model's own MISSING_CAPABILITY self-check; see vita-capability-denial-codes.
  assert.equal(changed.error.code, "CAP_DENIED");
  assert.equal(changed.state, before);
  assert.equal(loaded.value.state, before);
  assert.deepEqual(fixture.events, []);
});

test("settings view-model rejects malformed initial values from the settings port", async () => {
  const fixture = fakeHost({
    settings: {
      ...initialSettings(),
      [SETTINGS_APPEARANCE_KEYS.theme]: "auto",
    },
  });

  const loaded = await createSettingsViewModel(fixture.host);

  assert.equal(loaded.ok, false);
  if (loaded.ok) {
    assert.fail("expected malformed setting to fail closed");
  }
  assert.equal(loaded.error.code, "UNKNOWN_THEME");
  assert.deepEqual(fixture.events, [
    "theme:read",
    `read:${SETTINGS_APPEARANCE_KEYS.activeSection}`,
    `read:${SETTINGS_APPEARANCE_KEYS.theme}`,
  ]);
});

test("settings write failures preserve the previous view-model state", async () => {
  const fixture = fakeHost({
    failWrites: new Set([SETTINGS_APPEARANCE_KEYS.layout]),
    settings: initialSettings(),
  });
  const loaded = await createSettingsViewModel(fixture.host);

  assert.equal(loaded.ok, true);
  if (!loaded.ok) {
    assert.fail("expected Settings view-model to load");
  }

  const before = loaded.value.state;
  fixture.events.length = 0;

  const changed = await loaded.value.setLayout("tiling");

  assert.equal(changed.ok, false);
  if (changed.ok) {
    assert.fail("expected write failure");
  }
  assert.equal(changed.error.code, "WRITE_REJECTED");
  assert.equal(changed.state, before);
  assert.equal(loaded.value.state, before);
  assert.deepEqual(fixture.events, [
    `apply:${SETTINGS_APPEARANCE_KEYS.layout}=tiling`,
  ]);
});

interface FakeHostFixture {
  readonly host: DesktopHost;
  readonly settings: Map<string, string>;
  readonly events: string[];
}

function initialSettings(): Readonly<Record<string, string>> {
  return Object.freeze({
    [SETTINGS_APPEARANCE_KEYS.accent]: "blue",
    [SETTINGS_APPEARANCE_KEYS.activeSection]: "appearance",
    [SETTINGS_APPEARANCE_KEYS.layout]: "comfortable",
    [SETTINGS_APPEARANCE_KEYS.theme]: "light",
  });
}

function fakeHost(options: {
  readonly failWrites?: ReadonlySet<string>;
  readonly settings: Readonly<Record<string, string>>;
}): FakeHostFixture {
  const events: string[] = [];
  const settings = new Map(Object.entries(options.settings));
  const host: DesktopHost = Object.freeze({
    applySetting(request: Parameters<NonNullable<DesktopHost["applySetting"]>>[0]): DesktopHostResult<DesktopSettingsApply> {
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
    },
    applyShell(): ShellApplyResult {
      throw new Error("unused");
    },
    launchApp(app: DesktopLaunchableApp): DesktopHostResult<DesktopAppLaunch> {
      return {
        ok: true,
        value: Object.freeze({
          app,
          intents: Object.freeze([]),
          surfaceId: `surface:${app.id}`,
          textureId: `texture:${app.id}`,
          windowId: `window:${app.id}`,
        }),
      };
    },
    package: manifest("host", []),
    postNotification(input: NotificationPostInput): ShellResult<ShellNotification> {
      return shellAccept(Object.freeze({
        actions: Object.freeze([]),
        appId: "ui.test",
        createdAtMs: 0,
        id: input.id,
        priority: input.priority ?? "normal",
        title: input.title,
      }));
    },
    previewShell(): ShellPreviewResult {
      throw new Error("unused");
    },
    readSetting(request: Parameters<NonNullable<DesktopHost["readSetting"]>>[0]): DesktopHostResult<string> {
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
    readTheme(): DesktopTheme {
      events.push("theme:read");
      return theme();
    },
    registerComponent(definition: ShellComponentDefinition): ShellResult<RegisteredShellComponent> {
      return shellAccept(Object.freeze({
        defaultPlacement: Object.freeze({
          layer: definition.defaultPlacement.layer ?? "desktop",
          order: definition.defaultPlacement.order ?? 0,
          zone: definition.defaultPlacement.zone ?? "center",
        }),
        id: definition.id,
        render: definition.render,
        role: definition.role,
      }));
    },
    registerTrayItem(input: TrayItemInput): ShellResult<TrayItem> {
      return shellAccept(Object.freeze({
        appId: "ui.test",
        iconRef: input.iconRef,
        id: input.id,
        menu: Object.freeze([]),
        order: input.order ?? 0,
        tooltip: input.tooltip,
      }));
    },
    rollbackShell(): ShellRollbackResult {
      throw new Error("unused");
    },
    stopApp(appId: string): DesktopHostResult<DesktopAppStop> {
      return {
        ok: true,
        value: Object.freeze({
          appId,
          intents: Object.freeze([]),
        }),
      };
    },
  });

  return {
    events,
    host,
    settings,
  };
}

function manifest(id: string, grants: readonly DesktopCapabilityGrant[]): DesktopUiPackageManifest {
  return Object.freeze({
    capabilityGrants: Object.freeze(grants.map((grant) => Object.freeze(grant))),
    entry: `./${id}.ts`,
    id,
    sdkVersion: "1.0.0",
    version: "1.0.0",
  });
}

function theme(): DesktopTheme {
  return Object.freeze({
    id: "vita.test.theme",
    tokens: Object.freeze({
      colors: Object.freeze({
        background: "#101418",
      }),
      radii: Object.freeze({
        sm: 4,
      }),
      spacing: Object.freeze({
        sm: 8,
      }),
      typography: Object.freeze({
        body: "system-ui",
      }),
    }),
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

function shellAccept<T>(value: T): ShellResult<T> {
  return {
    ok: true,
    value,
  };
}
