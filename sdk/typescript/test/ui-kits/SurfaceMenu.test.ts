import assert from "node:assert/strict";
import { test } from "node:test";

import {
  SURFACE_DISPLAY_SETTINGS_INTENT,
  SURFACE_MENU_ITEM_IDS,
  SURFACE_SETTINGS_SETTING_IDS,
  createSurfaceMenuViewModel,
} from "../../../../ui_kits/desktop/viewmodels/SurfaceMenu.ts";
import type {
  SurfaceContextMenu,
  SurfaceContextMenuItem,
  SurfaceMenuFilesPort,
  SurfaceMenuFilesRequest,
} from "../../../../ui_kits/desktop/viewmodels/SurfaceMenu.ts";
import type {
  DesktopCapability,
  DesktopCapabilityGrant,
  DesktopHostResult,
  DesktopLauncherIntent,
  DesktopUiPackageManifest,
  FilesErrorResponse,
  FilesResponse,
  SettingsApplyIntent,
  SettingsControlPlaneIntent,
  SettingsControlPlanePort,
  SettingsPreviewIntent,
} from "../../src/desktop-sdk/index.ts";

test("surface menu gates missing capability-backed items and hides Paste without clipboard payload", () => {
  const vm = createSurfaceMenuViewModel({
    package: manifest([]),
    surface: {
      showDesktopIcons: false,
    },
  });
  const menu = vm.menu();

  assert.equal(Object.isFrozen(menu), true);
  assert.equal(Object.isFrozen(menu.sections), true);
  assert.equal(item(menu, SURFACE_MENU_ITEM_IDS.newFolder)?.disabled, true);
  assert.equal(item(menu, SURFACE_MENU_ITEM_IDS.paste), undefined);
  assert.equal(item(menu, SURFACE_MENU_ITEM_IDS.changeWallpaper)?.disabled, true);
  assert.equal(item(menu, SURFACE_MENU_ITEM_IDS.sortBy)?.disabled, true);
  assert.equal(item(menu, SURFACE_MENU_ITEM_IDS.sortByName)?.disabled, true);
  assert.equal(item(menu, SURFACE_MENU_ITEM_IDS.showDesktopIcons)?.disabled, true);
  assert.equal(item(menu, SURFACE_MENU_ITEM_IDS.showDesktopIcons)?.checked, false);
  assert.equal(item(menu, SURFACE_MENU_ITEM_IDS.displaySettings)?.disabled, true);
  assert.equal(item(menu, SURFACE_MENU_ITEM_IDS.refresh)?.disabled, false);
  assert.deepEqual(topLevelLabels(menu), [
    "New Folder",
    "Change Wallpaper…",
    "Sort by",
    "Show desktop icons",
    "Display Settings",
    "Refresh",
  ]);
});

test("New Folder resolves to a files mkdir request at the desktop path", async () => {
  const calls: SurfaceMenuFilesRequest[] = [];
  const vm = createSurfaceMenuViewModel({
    files: fakeFilesPort(calls, () => Object.freeze({})),
    filesGrant: "desktop",
    package: manifest([
      grant("files.write", "desktop"),
    ]),
    surface: {
      desktopPath: "/Users/borg/Desktop",
    },
  });

  const result = await vm.resolve(SURFACE_MENU_ITEM_IDS.newFolder, {
    folderName: "Projects",
  });

  assert.equal(result.ok, true);
  if (!result.ok) {
    assert.fail("expected New Folder to resolve");
  }
  if (result.dispatch !== "files") {
    assert.fail("expected New Folder to dispatch to files");
  }
  assert.deepEqual(calls, [
    {
      grant: "desktop",
      op: "mkdir",
      path: "/Users/borg/Desktop/Projects",
    },
  ]);
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result.request), true);
});

test("Paste is present with clipboard payload and resolves to a frozen files paste request", async () => {
  const calls: SurfaceMenuFilesRequest[] = [];
  const vm = createSurfaceMenuViewModel({
    clipboard: {
      mode: "copy",
      paths: Object.freeze([
        "/Documents/report.txt",
        "/Pictures/shot.png",
      ]),
    },
    files: fakeFilesPort(calls, () => Object.freeze({})),
    filesGrant: "desktop",
    package: manifest([
      grant("files.write", "desktop"),
    ]),
    surface: {
      desktopPath: "/Desktop",
    },
  });

  assert.equal(item(vm.menu(), SURFACE_MENU_ITEM_IDS.paste)?.disabled, false);

  const result = await vm.resolve("paste");

  assert.equal(result.ok, true);
  if (!result.ok) {
    assert.fail("expected Paste to resolve");
  }
  if (result.dispatch !== "files") {
    assert.fail("expected Paste to dispatch to files");
  }
  assert.deepEqual(calls, [
    {
      data: JSON.stringify({
        mode: "copy",
        paths: [
          "/Documents/report.txt",
          "/Pictures/shot.png",
        ],
      }),
      grant: "desktop",
      op: "paste",
      path: "/Desktop",
    },
  ]);
  assert.equal(Object.isFrozen(result.request), true);
});

test("settings-backed wallpaper, sort, and icon visibility actions preview then apply edits", async () => {
  const calls: SettingsControlPlaneIntent[] = [];
  const vm = createSurfaceMenuViewModel({
    package: manifest([
      grant("settings.write"),
    ]),
    settings: fakeSettingsPort(calls),
    surface: {
      showDesktopIcons: true,
      sortBy: "name",
      wallpaper: "default",
    },
  });

  const wallpaper = await vm.resolve(SURFACE_MENU_ITEM_IDS.changeWallpaper, {
    wallpaper: "aurora",
  });
  const sort = await vm.resolve(SURFACE_MENU_ITEM_IDS.sortBy, {
    sortBy: "modified",
  });
  const icons = await vm.resolve(SURFACE_MENU_ITEM_IDS.showDesktopIcons, {
    showDesktopIcons: false,
  });

  assert.equal(wallpaper.ok, true);
  assert.equal(sort.ok, true);
  assert.equal(icons.ok, true);
  if (!wallpaper.ok || !sort.ok || !icons.ok) {
    assert.fail("expected settings actions to resolve");
  }
  if (wallpaper.dispatch !== "settings" || sort.dispatch !== "settings" || icons.dispatch !== "settings") {
    assert.fail("expected settings actions to dispatch to settings");
  }

  assert.deepEqual(calls.map(projectSettingsCall), [
    ["control-plane.preview", SURFACE_SETTINGS_SETTING_IDS.wallpaper, "aurora"],
    ["control-plane.apply", SURFACE_SETTINGS_SETTING_IDS.wallpaper, "aurora"],
    ["control-plane.preview", SURFACE_SETTINGS_SETTING_IDS.sortBy, "modified"],
    ["control-plane.apply", SURFACE_SETTINGS_SETTING_IDS.sortBy, "modified"],
    ["control-plane.preview", SURFACE_SETTINGS_SETTING_IDS.showDesktopIcons, false],
    ["control-plane.apply", SURFACE_SETTINGS_SETTING_IDS.showDesktopIcons, false],
  ]);
  assert.equal(vm.state.wallpaper, "aurora");
  assert.equal(vm.state.sortBy, "modified");
  assert.equal(vm.state.showDesktopIcons, false);
  assert.equal(Object.isFrozen(wallpaper), true);
  assert.equal(Object.isFrozen(wallpaper.previewIntent), true);
  assert.equal(Object.isFrozen(wallpaper.applyIntent), true);
  assert.equal(Object.isFrozen(wallpaper.previewResult), true);
  assert.equal(Object.isFrozen(wallpaper.applyResult), true);
});

test("Display Settings emits a frozen launcher intent without mutating surface config", async () => {
  const intents: DesktopLauncherIntent[] = [];
  const vm = createSurfaceMenuViewModel({
    emitLauncherIntent(intent) {
      intents.push(intent);

      return Object.freeze({
        ok: true,
        value: true,
      });
    },
    package: manifest([
      grant("launcher.launch", SURFACE_DISPLAY_SETTINGS_INTENT.appId),
    ]),
    surface: {
      sortBy: "kind",
      wallpaper: "city",
    },
  });
  const before = vm.state;

  const result = await vm.resolve("display-settings");

  assert.equal(result.ok, true);
  if (!result.ok) {
    assert.fail("expected Display Settings to resolve");
  }
  if (result.dispatch !== "launcherIntent") {
    assert.fail("expected Display Settings to dispatch to launcher");
  }
  assert.deepEqual(intents, [
    SURFACE_DISPLAY_SETTINGS_INTENT,
  ]);
  assert.equal(Object.isFrozen(intents[0]), true);
  assert.equal(result.intent, intents[0]);
  assert.equal(vm.state, before);
});

test("undefined backing ports fail closed with frozen denied results", async () => {
  const vm = createSurfaceMenuViewModel({
    filesGrant: "desktop",
    package: manifest([
      grant("files.write", "desktop"),
    ]),
  });

  const result = await vm.resolve(SURFACE_MENU_ITEM_IDS.newFolder);

  assert.equal(result.ok, false);
  if (result.ok) {
    assert.fail("expected undefined files port to be denied");
  }
  assert.equal(result.reason, "forbidden");
  assert.equal(result.error.code, "FORBIDDEN");
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result.error), true);
});

test("Refresh is local and re-emits current frozen surface state without host calls", async () => {
  const filesCalls: SurfaceMenuFilesRequest[] = [];
  const settingsCalls: SettingsControlPlaneIntent[] = [];
  const launcherIntents: DesktopLauncherIntent[] = [];
  const vm = createSurfaceMenuViewModel({
    emitLauncherIntent(intent) {
      launcherIntents.push(intent);

      return hostAccept(true);
    },
    files: fakeFilesPort(filesCalls, () => Object.freeze({})),
    filesGrant: "desktop",
    package: manifest([
      grant("files.write", "desktop"),
      grant("settings.write"),
      grant("launcher.launch", SURFACE_DISPLAY_SETTINGS_INTENT.appId),
    ]),
    settings: fakeSettingsPort(settingsCalls),
    surface: {
      desktopPath: "/Desktop",
      showDesktopIcons: true,
      sortBy: "kind",
      wallpaper: "city",
    },
  });

  const result = await vm.resolve(SURFACE_MENU_ITEM_IDS.refresh);

  assert.equal(result.ok, true);
  if (!result.ok) {
    assert.fail("expected Refresh to resolve");
  }
  if (result.dispatch !== "local") {
    assert.fail("expected Refresh to dispatch locally");
  }
  assert.equal(result.state, vm.state);
  assert.equal(result.value, vm.state);
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result.state), true);
  assert.deepEqual(filesCalls, []);
  assert.deepEqual(settingsCalls, []);
  assert.deepEqual(launcherIntents, []);
});

function fakeFilesPort(
  calls: SurfaceMenuFilesRequest[],
  handler: (request: SurfaceMenuFilesRequest) => FilesResponse | FilesErrorResponse,
): SurfaceMenuFilesPort {
  return {
    request(request) {
      calls.push(request);
      return handler(request);
    },
  };
}

function fakeSettingsPort(calls: SettingsControlPlaneIntent[]): SettingsControlPlanePort {
  return {
    apply(intent: SettingsApplyIntent) {
      calls.push(intent);

      return Object.freeze({
        ok: true,
        value: Object.freeze({
          stage: "apply",
        }),
      });
    },
    preview(intent: SettingsPreviewIntent) {
      calls.push(intent);

      return Object.freeze({
        ok: true,
        value: Object.freeze({
          stage: "preview",
        }),
      });
    },
  };
}

function item(menu: SurfaceContextMenu, id: string): SurfaceContextMenuItem | undefined {
  for (let sectionIndex = 0; sectionIndex < menu.sections.length; sectionIndex += 1) {
    const section = menu.sections[sectionIndex];

    if (section === undefined) continue;

    for (let itemIndex = 0; itemIndex < section.items.length; itemIndex += 1) {
      const current = section.items[itemIndex];

      if (current === undefined || current.kind === "separator") continue;
      if (current.id === id) return current;
      if (current.submenu !== undefined) {
        const nested = item(current.submenu, id);

        if (nested !== undefined) return nested;
      }
    }
  }

  return undefined;
}

function topLevelLabels(menu: SurfaceContextMenu): readonly string[] {
  const output: string[] = [];
  const firstSection = menu.sections[0];

  if (firstSection === undefined) return Object.freeze(output);

  for (let index = 0; index < firstSection.items.length; index += 1) {
    const current = firstSection.items[index];

    if (current !== undefined && current.kind === "item") {
      output.push(current.label);
    }
  }

  return Object.freeze(output);
}

function projectSettingsCall(intent: SettingsControlPlaneIntent): readonly [string, string, string | number | boolean] {
  return [
    intent.type,
    intent.edit.settingId,
    intent.edit.value,
  ];
}

function manifest(grants: readonly DesktopCapabilityGrant[]): DesktopUiPackageManifest {
  return Object.freeze({
    capabilityGrants: Object.freeze([...grants]),
    entry: "./SurfaceMenu.test.ts",
    id: "ui.surface-menu.test",
    sdkVersion: "1.0.0",
    version: "1.0.0",
  });
}

function grant(capability: DesktopCapability, resourceId?: string): DesktopCapabilityGrant {
  const output: {
    capability: DesktopCapability;
    resourceId?: string;
  } = {
    capability,
  };

  if (resourceId !== undefined) output.resourceId = resourceId;

  return Object.freeze(output);
}

function hostAccept<T>(value: T): DesktopHostResult<T> {
  return Object.freeze({
    ok: true,
    value,
  });
}
