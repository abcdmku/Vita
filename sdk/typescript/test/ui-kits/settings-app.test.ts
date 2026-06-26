import assert from "node:assert/strict";
import { test } from "node:test";

import {
  SETTINGS_APP_ENTRY,
  SETTINGS_APP_PACKAGE_ID,
  settingsAppPackage,
} from "../../../../apps/settings/manifest.ts";
import {
  SETTINGS_APP_SETTING_KEYS,
  createSettingsAppViewModel,
} from "../../../../ui_kits/desktop/viewmodels/apps/settings-app.ts";
import type {
  SettingsAppSettingValue,
  SettingsAppViewModel,
  SettingsAppViewModelPorts,
} from "../../../../ui_kits/desktop/viewmodels/apps/settings-app.ts";
import {
  SDK_VERSION,
  createDesktopHostForPackage,
  defineAppPackage,
  hasAppCapabilityGrant,
} from "../../src/desktop-sdk/index.ts";
import type {
  DesktopAppLaunch,
  DesktopAppStop,
  DesktopCapabilityGrant,
  DesktopHost,
  DesktopHostResult,
  DesktopLaunchableApp,
  DesktopSettingsApply,
  DesktopSettingsPreview,
  DesktopTheme,
  DesktopUiPackageManifest,
} from "../../src/desktop-sdk/index.ts";

test("settings app package manifest is valid and minimally granted", () => {
  const app = defineAppPackage(settingsAppPackage);

  assert.equal(app.manifest.id, SETTINGS_APP_PACKAGE_ID);
  assert.equal(app.manifest.version, "1.0.0");
  assert.equal(app.manifest.sdkVersion, SDK_VERSION);
  assert.equal(app.manifest.entry, SETTINGS_APP_ENTRY);
  assert.equal(app.descriptor.id, app.manifest.id);
  assert.equal(app.descriptor.surfaceKind, "web");
  assert.equal(app.descriptor.runtime.url, app.manifest.entry);
  assert.equal(app.descriptor.runtime.partition, "vita-app-settings");
  assert.equal(app.descriptor.title, "Settings");
  assert.deepEqual(app.manifest.capabilityGrants.map((grant) => grant.capability), [
    "settings.read",
    "settings.write",
  ]);
  assert.equal(hasAppCapabilityGrant(app.manifest, "settings.read", "appearance.theme"), true);
  assert.equal(hasAppCapabilityGrant(app.manifest, "settings.write", "appearance.theme"), true);
  assert.equal(hasAppCapabilityGrant(app.manifest, "files.read"), false);
  assert.equal(hasAppCapabilityGrant(app.manifest, "launcher.launch"), false);
  assert.equal(Object.isFrozen(app), true);
  assert.equal(Object.isFrozen(app.manifest.capabilityGrants[0]), true);
  assert.equal(Object.isFrozen(app.descriptor.runtime), true);
});

test("settings app view-model snapshots deterministic sections and selects sections locally", () => {
  const viewModel = loadViewModel(Object.freeze({}));
  const first = viewModel.snapshot();

  assert.equal(first, viewModel.state);
  assert.equal(first.activeSection, "appearance");
  assert.equal(first.appearance.theme, "light");
  assert.equal(first.appearance.accent, "blue");
  assert.equal(first.appearance.layout, "comfortable");
  assert.equal(first.pendingPreview, null);
  assert.deepEqual(first.sections.map((section) => [section.id, section.active]), [
    ["general", false],
    ["appearance", true],
    ["network", false],
    ["sound", false],
    ["display", false],
    ["accounts", false],
    ["privacy", false],
    ["developer", false],
  ]);
  assert.equal(Object.isFrozen(first), true);
  assert.equal(Object.isFrozen(first.sections), true);
  assert.equal(Object.isFrozen(first.sections[0]), true);
  assert.equal(Object.isFrozen(first.appearance), true);

  const selected = viewModel.selectSection("network");

  assert.equal(selected.ok, true);
  if (!selected.ok) assert.fail("expected section selection");
  assert.equal(selected.state, viewModel.snapshot());
  assert.equal(selected.state.activeSection, "network");
  assert.equal(selected.state.sections.find((section) => section.id === "network")?.active, true);

  const beforeUnknown = viewModel.snapshot();
  const unknown = viewModel.selectSection("missing");

  assert.equal(unknown.ok, false);
  if (unknown.ok) assert.fail("expected unknown section to fail closed");
  assert.equal(unknown.error.code, "UNKNOWN_SETTINGS_SECTION");
  assert.equal(unknown.state, beforeUnknown);
  assert.equal(viewModel.snapshot(), beforeUnknown);
});

test("settings app view-model reads, previews, and applies through scoped settings ports", async () => {
  const fixture = fakeDesktopHost(initialSettings());
  const scoped = createDesktopHostForPackage(fixture.host, settingsAppPackage.manifest);
  const viewModel = loadViewModel(settingsPorts(scoped));

  const read = await viewModel.readSetting(SETTINGS_APP_SETTING_KEYS.theme);

  assert.equal(read.ok, true);
  if (!read.ok) assert.fail("expected settings read");
  assert.equal(read.value, "light");
  assert.equal(read.state.appearance.theme, "light");

  const preview = await viewModel.previewSetting(SETTINGS_APP_SETTING_KEYS.theme, "dark");

  assert.equal(preview.ok, true);
  if (!preview.ok) assert.fail("expected settings preview");
  assert.equal(preview.value.revision, "preview-2");
  assert.deepEqual(preview.value.diff, {
    key: SETTINGS_APP_SETTING_KEYS.theme,
    next: "dark",
    previous: "light",
  });
  assert.equal(preview.state.appearance.theme, "dark");
  assert.deepEqual(preview.state.pendingPreview, {
    diff: {
      key: SETTINGS_APP_SETTING_KEYS.theme,
      next: "dark",
      previous: "light",
    },
    key: SETTINGS_APP_SETTING_KEYS.theme,
    revision: "preview-2",
    value: "dark",
  });
  assert.equal(Object.isFrozen(preview.state.pendingPreview), true);
  assert.equal(Object.isFrozen(preview.state.pendingPreview?.diff), true);

  const applied = await viewModel.applySetting(SETTINGS_APP_SETTING_KEYS.theme, "dark");

  assert.equal(applied.ok, true);
  if (!applied.ok) assert.fail("expected settings apply");
  assert.deepEqual(applied.value.applied, {
    key: SETTINGS_APP_SETTING_KEYS.theme,
    value: "dark",
  });
  assert.equal(applied.value.revision, "apply-3");
  assert.equal(applied.state.pendingPreview, null);
  assert.equal(applied.state.appearance.theme, "dark");
  assert.equal(fixture.settings.get(SETTINGS_APP_SETTING_KEYS.theme), "dark");
  assert.deepEqual(fixture.events, [
    `read:${SETTINGS_APP_SETTING_KEYS.theme}`,
    `preview:${SETTINGS_APP_SETTING_KEYS.theme}=dark`,
    `apply:${SETTINGS_APP_SETTING_KEYS.theme}=dark`,
  ]);
});

test("settings app view-model updates appearance for accent and layout deterministically", async () => {
  const fixture = fakeDesktopHost(initialSettings());
  const scoped = createDesktopHostForPackage(fixture.host, settingsAppPackage.manifest);
  const viewModel = loadViewModel(settingsPorts(scoped));

  const accent = await viewModel.readSetting(SETTINGS_APP_SETTING_KEYS.accent);
  const layoutPreview = await viewModel.previewSetting(SETTINGS_APP_SETTING_KEYS.layout, "tiling");
  const layoutApply = await viewModel.applySetting(SETTINGS_APP_SETTING_KEYS.layout, "tiling");

  assert.equal(accent.ok, true);
  assert.equal(layoutPreview.ok, true);
  assert.equal(layoutApply.ok, true);
  assert.equal(viewModel.snapshot().appearance.accent, "blue");
  assert.equal(viewModel.snapshot().appearance.accentColor, "#3178c6");
  assert.equal(viewModel.snapshot().appearance.layout, "tiling");
  assert.equal(viewModel.snapshot().appearance.tiling, true);
  assert.equal(viewModel.snapshot().appearance.density, "compact");
  assert.deepEqual(viewModel.snapshot().sections.map((section) => section.id), [
    "general",
    "appearance",
    "network",
    "sound",
    "display",
    "accounts",
    "privacy",
    "developer",
  ]);
});

test("settings app view-model fails closed when grants or ports are missing", async () => {
  const fixture = fakeDesktopHost(initialSettings());
  const denied = createDesktopHostForPackage(fixture.host, packageManifest("ui.no-settings", []));
  const deniedViewModel = loadViewModel(settingsPorts(denied));
  const beforeDenied = deniedViewModel.snapshot();

  const deniedRead = await deniedViewModel.readSetting(SETTINGS_APP_SETTING_KEYS.theme);
  const deniedPreview = await deniedViewModel.previewSetting(SETTINGS_APP_SETTING_KEYS.theme, "dark");
  const deniedApply = await deniedViewModel.applySetting(SETTINGS_APP_SETTING_KEYS.theme, "dark");

  assert.equal(deniedRead.ok, false);
  assert.equal(deniedPreview.ok, false);
  assert.equal(deniedApply.ok, false);
  if (deniedRead.ok || deniedPreview.ok || deniedApply.ok) {
    assert.fail("expected denied settings calls");
  }
  assert.equal(deniedRead.error.code, "CAP_DENIED");
  assert.equal(deniedPreview.error.code, "CAP_DENIED");
  assert.equal(deniedApply.error.code, "CAP_DENIED");
  assert.equal(deniedViewModel.snapshot(), beforeDenied);
  assert.deepEqual(fixture.events, []);

  const missingPorts = loadViewModel(Object.freeze({}));

  assert.equal((await missingPorts.readSetting(SETTINGS_APP_SETTING_KEYS.theme)).ok, false);
  assert.equal((await missingPorts.previewSetting(SETTINGS_APP_SETTING_KEYS.theme, "dark")).ok, false);
  assert.equal((await missingPorts.applySetting(SETTINGS_APP_SETTING_KEYS.theme, "dark")).ok, false);
});

test("settings app view-model rejects malformed write inputs before touching ports", async () => {
  const fixture = fakeDesktopHost(initialSettings());
  const scoped = createDesktopHostForPackage(fixture.host, settingsAppPackage.manifest);
  const viewModel = loadViewModel(settingsPorts(scoped));

  const invalidTheme = await viewModel.previewSetting(SETTINGS_APP_SETTING_KEYS.theme, "auto");

  assert.equal(invalidTheme.ok, false);
  if (invalidTheme.ok) assert.fail("expected invalid theme rejection");
  assert.equal(invalidTheme.error.code, "UNKNOWN_THEME");
  assert.deepEqual(fixture.events, []);

  const cycle: Record<string, unknown> = {};

  cycle["self"] = cycle;

  const cyclic = await viewModel.previewSetting("custom.json", cycle);

  assert.equal(cyclic.ok, false);
  if (cyclic.ok) assert.fail("expected cyclic value rejection");
  assert.equal(cyclic.error.code, "INVALID_SETTING_VALUE");
  assert.deepEqual(fixture.events, []);

  let reads = 0;
  const accessor: Record<string, unknown> = {};

  Object.defineProperty(accessor, "value", {
    enumerable: true,
    get() {
      reads += 1;
      return "dark";
    },
  });

  const hostile = await viewModel.applySetting("custom.json", accessor);

  assert.equal(hostile.ok, false);
  if (hostile.ok) assert.fail("expected accessor value rejection");
  assert.equal(hostile.error.code, "INVALID_SETTING_VALUE");
  assert.equal(reads, 0);
  assert.deepEqual(fixture.events, []);
});

interface FakeHostFixture {
  readonly host: DesktopHost;
  readonly settings: Map<string, SettingsAppSettingValue>;
  readonly events: string[];
}

function loadViewModel(ports: SettingsAppViewModelPorts): SettingsAppViewModel {
  const loaded = createSettingsAppViewModel(ports);

  assert.equal(loaded.ok, true);
  if (!loaded.ok) assert.fail("expected settings app view-model");

  return loaded.value;
}

function initialSettings(): Readonly<Record<string, SettingsAppSettingValue>> {
  return Object.freeze({
    [SETTINGS_APP_SETTING_KEYS.accent]: "blue",
    [SETTINGS_APP_SETTING_KEYS.layout]: "comfortable",
    [SETTINGS_APP_SETTING_KEYS.theme]: "light",
  });
}

function fakeDesktopHost(input: Readonly<Record<string, SettingsAppSettingValue>>): FakeHostFixture {
  const events: string[] = [];
  const settings = new Map<string, SettingsAppSettingValue>(Object.entries(input));
  const host: DesktopHost = Object.freeze({
    applySetting(
      request: Parameters<NonNullable<DesktopHost["applySetting"]>>[0],
    ): DesktopHostResult<DesktopSettingsApply> {
      events.push(`apply:${request.key}=${formatValue(request.value)}`);
      settings.set(request.key, request.value);

      return hostAccept(Object.freeze({
        applied: Object.freeze({
          key: request.key,
          value: request.value,
        }),
        revision: `apply-${events.length}`,
      }));
    },
    applyShell(): never {
      throw new Error("applyShell is unused");
    },
    launchApp(app: DesktopLaunchableApp): DesktopHostResult<DesktopAppLaunch> {
      return hostAccept(Object.freeze({
        app,
        intents: Object.freeze([]),
        surfaceId: `surface:${app.id}`,
        textureId: `texture:${app.id}`,
        windowId: `window:${app.id}`,
      }));
    },
    package: packageManifest("host", []),
    postNotification(): never {
      throw new Error("postNotification is unused");
    },
    previewSetting(
      request: Parameters<NonNullable<DesktopHost["previewSetting"]>>[0],
    ): DesktopHostResult<DesktopSettingsPreview> {
      events.push(`preview:${request.key}=${formatValue(request.value)}`);
      const previous = settings.get(request.key) ?? null;

      return hostAccept(Object.freeze({
        diff: Object.freeze({
          key: request.key,
          next: request.value,
          previous,
        }),
        revision: `preview-${events.length}`,
      }));
    },
    previewShell(): never {
      throw new Error("previewShell is unused");
    },
    readSetting(
      request: Parameters<NonNullable<DesktopHost["readSetting"]>>[0],
    ): DesktopHostResult<SettingsAppSettingValue> {
      events.push(`read:${request.key}`);
      const value = settings.get(request.key);

      if (value === undefined) {
        return hostReject("SETTING_NOT_FOUND", "setting is unavailable.", `/settings/${request.key}`);
      }

      return hostAccept(value);
    },
    readTheme(): DesktopTheme {
      return Object.freeze({
        id: "test",
        tokens: Object.freeze({
          colors: Object.freeze({ background: "#fff" }),
          radii: Object.freeze({ sm: 4 }),
          spacing: Object.freeze({ sm: 8 }),
          typography: Object.freeze({ body: "system-ui" }),
        }),
        version: "1.0.0",
      });
    },
    registerComponent(): never {
      throw new Error("registerComponent is unused");
    },
    registerTrayItem(): never {
      throw new Error("registerTrayItem is unused");
    },
    rollbackShell(): never {
      throw new Error("rollbackShell is unused");
    },
    stopApp(appId: string): DesktopHostResult<DesktopAppStop> {
      return hostAccept(Object.freeze({
        appId,
        intents: Object.freeze([]),
      }));
    },
  });

  return Object.freeze({
    events,
    host,
    settings,
  });
}

function settingsPorts(host: DesktopHost): SettingsAppViewModelPorts {
  const output: {
    readSetting?: NonNullable<DesktopHost["readSetting"]>;
    previewSetting?: NonNullable<DesktopHost["previewSetting"]>;
    applySetting?: NonNullable<DesktopHost["applySetting"]>;
  } = {};

  if (host.readSetting !== undefined) output.readSetting = host.readSetting;
  if (host.previewSetting !== undefined) output.previewSetting = host.previewSetting;
  if (host.applySetting !== undefined) output.applySetting = host.applySetting;

  return Object.freeze(output);
}

function packageManifest(id: string, grants: readonly DesktopCapabilityGrant[]): DesktopUiPackageManifest {
  return Object.freeze({
    capabilityGrants: Object.freeze(grants.map((grantValue) => Object.freeze(grantValue))),
    entry: "index.html",
    id,
    sdkVersion: SDK_VERSION,
    version: "1.0.0",
  });
}

function hostAccept<T>(value: T): DesktopHostResult<T> {
  return {
    ok: true,
    value,
  };
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

function formatValue(value: SettingsAppSettingValue): string {
  return typeof value === "string" ? value : JSON.stringify(value);
}
