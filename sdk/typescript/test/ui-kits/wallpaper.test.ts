import assert from "node:assert/strict";
import { test } from "node:test";

import {
  WALLPAPER_SETTING_KEYS,
  WALLPAPER_SETTINGS_CATEGORY_ID,
  createWallpaperViewModel,
} from "../../../../ui_kits/desktop/viewmodels/wallpaper.ts";
import type {
  WallpaperFit,
  WallpaperSourceRef,
  WallpaperViewModel,
  WallpaperViewModelState,
  WallpaperWorkspaceOverride,
} from "../../../../ui_kits/desktop/viewmodels/wallpaper.ts";
import {
  createSettingsAppState,
} from "../../src/desktop-sdk/index.ts";
import type {
  DesktopCapability,
  DesktopCapabilityGrant,
  DesktopUiPackageManifest,
  SettingsAppState,
  SettingsControlPlaneIntent,
  SettingsControlPlanePort,
  SettingsManagedConfig,
  SettingsValue,
  SettingsWidgetKind,
} from "../../src/desktop-sdk/index.ts";

test("wallpaper view-model reads current source, fit, slideshow, and solid fallback from settings", () => {
  const fixture = wallpaperFixture({
    sourceRef: "wallpaper:mountain",
    fit: "fit",
    solidColor: "#112233",
    slideshowSources: ["wallpaper:mountain", "wallpaper:forest"],
    slideshowIntervalMs: 30_000,
  });

  const loaded = createWallpaperViewModel(fixture.options);

  assert.equal(loaded.ok, true);
  if (!loaded.ok) {
    assert.fail("expected wallpaper view-model to load");
  }

  assert.equal(loaded.value.state.sourceRef, "wallpaper:mountain");
  assert.equal(loaded.value.state.fit, "fit");
  assert.equal(loaded.value.state.solidColor, "#112233");
  assert.equal(loaded.value.state.resolved.kind, "source");
  assert.equal(loaded.value.state.resolved.sourceRef, "wallpaper:mountain");
  assert.equal(loaded.value.state.resolved.fit, "fit");
  assert.deepEqual(loaded.value.state.slideshow.sources, ["wallpaper:mountain", "wallpaper:forest"]);
  assert.equal(loaded.value.state.slideshow.index, 0);
  assert.equal(loaded.value.state.slideshow.intervalMs, 30_000);
  assert.equal(Object.isFrozen(loaded.value.state), true);
  assert.equal(Object.isFrozen(loaded.value.state.workspaceOverrides), true);
  assert.equal(Object.isFrozen(loaded.value.state.slideshow.sources), true);
  assert.deepEqual(fixture.port.events, []);

  const fallback = createWallpaperViewModel(wallpaperFixture({
    sourceRef: null,
    solidColor: "#0f172a",
    slideshowSources: [],
  }).options);

  assert.equal(fallback.ok, true);
  if (!fallback.ok) {
    assert.fail("expected fallback wallpaper view-model to load");
  }
  assert.equal(fallback.value.state.sourceRef, null);
  assert.equal(fallback.value.state.resolved.kind, "solidColor");
  assert.equal(fallback.value.state.resolved.sourceRef, null);
  assert.equal(fallback.value.state.resolved.solidColor, "#0f172a");
});

test("setFit emits preview then apply and commits local state only after apply settles", async () => {
  const fixture = wallpaperFixture({
    fit: "fill",
  });
  let viewModel: WallpaperViewModel | null = null;
  let fitObservedDuringApply: WallpaperFit | null = null;

  fixture.port.onApply = () => {
    if (viewModel === null) {
      assert.fail("view-model should be assigned before apply");
    }
    fitObservedDuringApply = viewModel.state.fit;
  };

  const loaded = createWallpaperViewModel(fixture.options);

  assert.equal(loaded.ok, true);
  if (!loaded.ok) {
    assert.fail("expected wallpaper view-model to load");
  }

  viewModel = loaded.value;

  const before = viewModel.state;
  const changed = await viewModel.setFit("center");

  assert.equal(changed.ok, true);
  assert.equal(fitObservedDuringApply, "fill");
  assert.equal(before.fit, "fill");
  assert.equal(viewModel.state.fit, "center");
  assert.equal(changed.state, viewModel.state);
  assert.deepEqual(fixture.port.events, [
    `preview:${WALLPAPER_SETTING_KEYS.fit}=center`,
    `apply:${WALLPAPER_SETTING_KEYS.fit}=center`,
  ]);
});

test("setForWorkspace stores ordered overrides and active workspace override wins over global wallpaper", async () => {
  const fixture = wallpaperFixture({
    activeWorkspaceId: "workspace-2",
    sourceRef: "wallpaper:global",
    fit: "fill",
  });
  const loaded = createWallpaperViewModel(fixture.options);

  assert.equal(loaded.ok, true);
  if (!loaded.ok) {
    assert.fail("expected wallpaper view-model to load");
  }

  const first = await loaded.value.setForWorkspace("workspace-1", "wallpaper:one", "fit");
  const second = await loaded.value.setForWorkspace("workspace-2", {
    fit: "center",
    sourceRef: "wallpaper:two",
  });

  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  assert.deepEqual(loaded.value.state.workspaceOverrides.map((override) => override.workspaceId), [
    "workspace-1",
    "workspace-2",
  ]);
  assert.deepEqual(projectOverrides(loaded.value.state.workspaceOverrides), [
    ["workspace-1", "wallpaper:one", "fit"],
    ["workspace-2", "wallpaper:two", "center"],
  ]);
  assert.equal(loaded.value.state.sourceRef, "wallpaper:global");
  assert.equal(loaded.value.state.fit, "fill");
  assert.equal(loaded.value.state.resolved.workspaceId, "workspace-2");
  assert.equal(loaded.value.state.resolved.sourceRef, "wallpaper:two");
  assert.equal(loaded.value.state.resolved.fit, "center");
  assert.deepEqual(fixture.port.events, [
    `preview:${WALLPAPER_SETTING_KEYS.workspaceOverrides}=${encodeOverrides([
      override("workspace-1", "wallpaper:one", "fit"),
    ])}`,
    `apply:${WALLPAPER_SETTING_KEYS.workspaceOverrides}=${encodeOverrides([
      override("workspace-1", "wallpaper:one", "fit"),
    ])}`,
    `preview:${WALLPAPER_SETTING_KEYS.workspaceOverrides}=${encodeOverrides([
      override("workspace-1", "wallpaper:one", "fit"),
      override("workspace-2", "wallpaper:two", "center"),
    ])}`,
    `apply:${WALLPAPER_SETTING_KEYS.workspaceOverrides}=${encodeOverrides([
      override("workspace-1", "wallpaper:one", "fit"),
      override("workspace-2", "wallpaper:two", "center"),
    ])}`,
  ]);
});

test("advance rotates slideshow source deterministically from the injected clock", async () => {
  const fixtureA = wallpaperFixture({
    sourceRef: "wallpaper:a",
    slideshowSources: ["wallpaper:a", "wallpaper:b", "wallpaper:c"],
    slideshowIntervalMs: 1_000,
  });
  const fixtureB = wallpaperFixture({
    sourceRef: "wallpaper:a",
    slideshowSources: ["wallpaper:a", "wallpaper:b", "wallpaper:c"],
    slideshowIntervalMs: 1_000,
  });
  const loadedA = createWallpaperViewModel(fixtureA.options);
  const loadedB = createWallpaperViewModel(fixtureB.options);

  assert.equal(loadedA.ok, true);
  assert.equal(loadedB.ok, true);
  if (!loadedA.ok || !loadedB.ok) {
    assert.fail("expected wallpaper view-models to load");
  }

  const clock = manualClock(2_500);
  const advancedA = await loadedA.value.advance(clock);
  const advancedB = await loadedB.value.advance(clock);

  assert.equal(advancedA.ok, true);
  assert.equal(advancedB.ok, true);
  assert.equal(loadedA.value.state.sourceRef, "wallpaper:c");
  assert.equal(loadedA.value.state.slideshow.index, 2);
  assert.equal(loadedA.value.state.slideshow.sourceRef, "wallpaper:c");
  assert.equal(loadedA.value.state.resolved.sourceRef, "wallpaper:c");
  assert.deepEqual(projectSlideshow(advancedA.state), projectSlideshow(advancedB.state));
  assert.deepEqual(fixtureA.port.events, [
    `preview:${WALLPAPER_SETTING_KEYS.sourceRef}=wallpaper:c`,
    `apply:${WALLPAPER_SETTING_KEYS.sourceRef}=wallpaper:c`,
  ]);
});

test("missing settings.write grant makes mutating wallpaper actions no-ops", async () => {
  const fixture = wallpaperFixture({
    grants: [],
    sourceRef: "wallpaper:locked",
    fit: "fill",
    slideshowSources: ["wallpaper:locked", "wallpaper:next"],
    slideshowIntervalMs: 1_000,
  });
  const loaded = createWallpaperViewModel(fixture.options);

  assert.equal(loaded.ok, true);
  if (!loaded.ok) {
    assert.fail("expected wallpaper view-model to load without write grant");
  }

  const beforeState = loaded.value.state;
  const beforeBytes = JSON.stringify(loaded.value.snapshot());

  const wallpaper = await loaded.value.setWallpaper("wallpaper:changed");
  const fit = await loaded.value.setFit("tile");
  const workspace = await loaded.value.setForWorkspace("workspace-1", "wallpaper:workspace", "center");
  const advanced = await loaded.value.advance(manualClock(1_500));

  assert.equal(wallpaper.ok, false);
  assert.equal(fit.ok, false);
  assert.equal(workspace.ok, false);
  assert.equal(advanced.ok, false);
  assert.deepEqual([
    wallpaper.ok ? "" : wallpaper.error.code,
    fit.ok ? "" : fit.error.code,
    workspace.ok ? "" : workspace.error.code,
    advanced.ok ? "" : advanced.error.code,
  ], [
    "MISSING_CAPABILITY",
    "MISSING_CAPABILITY",
    "MISSING_CAPABILITY",
    "MISSING_CAPABILITY",
  ]);
  assert.equal(loaded.value.state, beforeState);
  assert.equal(JSON.stringify(loaded.value.snapshot()), beforeBytes);
  assert.deepEqual(fixture.port.events, []);
});

interface WallpaperFixture {
  readonly options: {
    readonly package: DesktopUiPackageManifest;
    readonly settings: SettingsControlPlanePort;
    readonly settingsState: SettingsAppState;
    readonly activeWorkspaceId?: string;
  };
  readonly port: FakeSettingsControlPlanePort;
}

interface WallpaperSeed {
  readonly activeWorkspaceId?: string;
  readonly fit?: WallpaperFit;
  readonly grants?: readonly DesktopCapabilityGrant[];
  readonly slideshowIntervalMs?: number;
  readonly slideshowSources?: readonly WallpaperSourceRef[];
  readonly solidColor?: string;
  readonly sourceRef?: WallpaperSourceRef | null;
  readonly workspaceOverrides?: readonly WallpaperWorkspaceOverride[];
}

function wallpaperFixture(seed: WallpaperSeed): WallpaperFixture {
  const port = new FakeSettingsControlPlanePort();
  const options: {
    package: DesktopUiPackageManifest;
    settings: SettingsControlPlanePort;
    settingsState: SettingsAppState;
    activeWorkspaceId?: string;
  } = {
    package: manifest(seed.grants ?? wallpaperWriteGrants()),
    settings: port,
    settingsState: settingsState(seed),
  };

  if (seed.activeWorkspaceId !== undefined) {
    options.activeWorkspaceId = seed.activeWorkspaceId;
  }

  return Object.freeze({
    options: Object.freeze(options),
    port,
  });
}

function settingsState(seed: WallpaperSeed): SettingsAppState {
  return createSettingsAppState(wallpaperConfig(seed), WALLPAPER_SETTINGS_CATEGORY_ID);
}

function wallpaperConfig(seed: WallpaperSeed): SettingsManagedConfig {
  return Object.freeze({
    categories: Object.freeze([
      Object.freeze({
        id: WALLPAPER_SETTINGS_CATEGORY_ID,
        settings: Object.freeze([
          setting(WALLPAPER_SETTING_KEYS.sourceRef, "text", sourceSettingValue(seed.sourceRef)),
          setting(WALLPAPER_SETTING_KEYS.fit, "text", seed.fit ?? "fill"),
          setting(WALLPAPER_SETTING_KEYS.solidColor, "text", seed.solidColor ?? "#0f172a"),
          setting(WALLPAPER_SETTING_KEYS.workspaceOverrides, "text", encodeOverrides(seed.workspaceOverrides ?? [])),
          setting(WALLPAPER_SETTING_KEYS.slideshowSources, "text", JSON.stringify(seed.slideshowSources ?? [])),
          setting(WALLPAPER_SETTING_KEYS.slideshowIntervalMs, "number", seed.slideshowIntervalMs ?? 60_000),
        ]),
        title: "Appearance",
      }),
    ]),
    revision: "rev-wallpaper-test",
  });
}

function setting(
  id: string,
  kind: SettingsWidgetKind,
  value: SettingsValue,
) {
  return Object.freeze({
    id,
    kind,
    label: id,
    value,
  });
}

function sourceSettingValue(sourceRef: WallpaperSourceRef | null | undefined): string {
  if (sourceRef === null) return "";

  return sourceRef ?? "wallpaper:default";
}

function wallpaperWriteGrants(): readonly DesktopCapabilityGrant[] {
  return Object.freeze([
    grant("settings.write", WALLPAPER_SETTING_KEYS.sourceRef),
    grant("settings.write", WALLPAPER_SETTING_KEYS.fit),
    grant("settings.write", WALLPAPER_SETTING_KEYS.workspaceOverrides),
  ]);
}

function manifest(grants: readonly DesktopCapabilityGrant[]): DesktopUiPackageManifest {
  return Object.freeze({
    capabilityGrants: Object.freeze([...grants]),
    entry: "./wallpaper.ts",
    id: "ui.wallpaper.test",
    sdkVersion: "1.0.0",
    version: "1.0.0",
  });
}

function grant(
  capability: DesktopCapability,
  resourceId?: string,
): DesktopCapabilityGrant {
  const output: {
    capability: DesktopCapability;
    resourceId?: string;
  } = {
    capability,
  };

  if (resourceId !== undefined) output.resourceId = resourceId;

  return Object.freeze(output);
}

function override(
  workspaceId: string,
  sourceRef: WallpaperSourceRef,
  fit: WallpaperFit,
): WallpaperWorkspaceOverride {
  return Object.freeze({
    fit,
    sourceRef,
    workspaceId,
  });
}

function encodeOverrides(overrides: readonly WallpaperWorkspaceOverride[]): string {
  const output: Array<{
    readonly workspaceId: string;
    readonly sourceRef: string;
    readonly fit: WallpaperFit;
  }> = [];

  for (let index = 0; index < overrides.length; index += 1) {
    const item = overrides[index];

    if (item !== undefined) {
      output.push(Object.freeze({
        fit: item.fit,
        sourceRef: item.sourceRef,
        workspaceId: item.workspaceId,
      }));
    }
  }

  return JSON.stringify(output);
}

function projectOverrides(overrides: readonly WallpaperWorkspaceOverride[]): Array<[string, string, WallpaperFit]> {
  return overrides.map((item) => [item.workspaceId, item.sourceRef, item.fit]);
}

function projectSlideshow(state: WallpaperViewModelState) {
  return {
    index: state.slideshow.index,
    resolvedSourceRef: state.resolved.sourceRef,
    sourceRef: state.sourceRef,
    slideshowSourceRef: state.slideshow.sourceRef,
  };
}

function manualClock(nowMs: number) {
  return Object.freeze({
    nowMs(): number {
      return nowMs;
    },
  });
}

class FakeSettingsControlPlanePort implements SettingsControlPlanePort {
  readonly events: string[] = [];
  onApply?: () => void;

  apply(intent: Extract<SettingsControlPlaneIntent, { readonly type: "control-plane.apply" }>) {
    this.events.push(intentEvent(intent));
    this.onApply?.();

    return Object.freeze({
      ok: true,
      value: Object.freeze({
        stage: "apply" as const,
      }),
    });
  }

  preview(intent: Extract<SettingsControlPlaneIntent, { readonly type: "control-plane.preview" }>) {
    this.events.push(intentEvent(intent));

    return Object.freeze({
      ok: true,
      value: Object.freeze({
        stage: "preview" as const,
      }),
    });
  }
}

function intentEvent(intent: SettingsControlPlaneIntent): string {
  const stage = intent.type === "control-plane.preview" ? "preview" : "apply";

  return `${stage}:${intent.edit.settingId}=${String(intent.edit.value)}`;
}
