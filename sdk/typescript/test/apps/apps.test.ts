import assert from "node:assert/strict";
import { test } from "node:test";

import {
  VITA_FILE_MANAGER_WINDOW_ID,
  VITA_FILE_MANAGER_APP_COMPONENT_ID,
  VITA_SETTINGS_WINDOW_ID,
  VITA_SETTINGS_APP_COMPONENT_ID,
  createFileManagerState,
  createSettingsAppState,
  emitSettingsControlPlaneIntent,
  fileManagerAppProps,
  firstPartyAppWindowRequests,
  firstPartyAppComponents,
  firstPartyAppsShellConfig,
  loadFileManagerDirectory,
  navigateFileManager,
  renderSettingsAppSurface,
  requestSettingsApply,
  requestSettingsPreview,
  settleSettingsControlPlaneResult,
} from "../../src/apps/index.ts";
import type {
  FileManagerState,
  FilesCapabilityPort,
  SettingsControlPlaneIntent,
  SettingsControlPlanePort,
  SettingsManagedConfig,
  SettingsValue,
} from "../../src/apps/index.ts";
import {
  composeShellLayout,
  createShellComponentRegistry,
} from "../../src/shell/index.ts";
import type {
  ShellWindowManagerPlacementRequest,
} from "../../src/shell/index.ts";
import type {
  FilesErrorResponse,
  FilesRequest,
  FilesResponse,
} from "../../src/files-grant.ts";
import {
  createWindowModel,
  layout,
  openWindow,
} from "../../src/wm/policy.ts";

const SETTINGS_CONFIG = Object.freeze({
  categories: Object.freeze([
    Object.freeze({
      id: "display",
      settings: Object.freeze([
        Object.freeze({
          id: "dark-mode",
          kind: "toggle",
          label: "Dark mode",
          value: false,
        }),
        Object.freeze({
          id: "scale",
          kind: "number",
          label: "Scale",
          value: 1,
        }),
      ]),
      title: "Display",
    }),
    Object.freeze({
      id: "system",
      settings: Object.freeze([
        Object.freeze({
          id: "hostname",
          kind: "text",
          label: "Hostname",
          value: "vita",
        }),
      ]),
      title: "System",
    }),
  ]),
  revision: "rev-settings-a",
}) satisfies SettingsManagedConfig;

const ROOT_ENTRIES = Object.freeze([
  Object.freeze({
    kind: "file",
    mtime: "2026-06-24T00:00:00Z",
    name: "z.txt",
    size: 10,
  }),
  Object.freeze({
    kind: "dir",
    mtime: "2026-06-24T00:00:00Z",
    name: "docs",
    size: 0,
  }),
]) satisfies readonly FilesResponseEntry[];

test("settings edits emit control-plane preview and apply intents without mutating current config", async () => {
  const state = createSettingsAppState(SETTINGS_CONFIG, "display");
  const preview = requestSettingsPreview(state, {
    categoryId: "display",
    settingId: "dark-mode",
    value: true,
  });

  assert.equal(preview.ok, true);
  if (!preview.ok) {
    assert.fail("expected preview intent");
  }

  assert.equal(settingValue(state.config, "display", "dark-mode"), false);
  assert.equal(settingValue(preview.value.intent.desired, "display", "dark-mode"), true);
  assert.equal(preview.value.intent.type, "control-plane.preview");

  const calls: SettingsControlPlaneIntent[] = [];
  const port = fakeSettingsPort(calls);
  const previewResult = await emitSettingsControlPlaneIntent(port, preview.value.intent);

  assert.equal(previewResult.ok, true);
  assert.deepEqual(calls.map((call) => call.type), ["control-plane.preview"]);

  const apply = requestSettingsApply(state, {
    categoryId: "display",
    settingId: "dark-mode",
    value: true,
  });

  assert.equal(apply.ok, true);
  if (!apply.ok) {
    assert.fail("expected apply intent");
  }

  const applyResult = await emitSettingsControlPlaneIntent(port, apply.value.intent);
  const committed = settleSettingsControlPlaneResult(apply.value.state, apply.value.intent, applyResult);

  assert.equal(applyResult.ok, true);
  assert.deepEqual(calls.map((call) => call.type), ["control-plane.preview", "control-plane.apply"]);
  assert.equal(settingValue(state.config, "display", "dark-mode"), false);
  assert.equal(settingValue(committed.config, "display", "dark-mode"), true);
});

test("settings and file-manager compose deterministically as windowed shell surfaces", () => {
  const settings = createSettingsAppState(SETTINGS_CONFIG, "system");
  const files = createFileManagerState({
    entries: ROOT_ENTRIES,
    grant: "home",
    path: "/home",
    status: "ready",
  });
  const registry = createShellComponentRegistry(firstPartyAppComponents);

  assert.equal(registry.ok, true);
  if (!registry.ok) {
    assert.fail("expected app registry");
  }

  const wmCalls: ShellWindowManagerPlacementRequest[] = [];
  const config = firstPartyAppsShellConfig({
    files,
    revision: "rev-apps",
    settings,
  });
  const first = composeShellLayout(registry.value, config, {
    wm: {
      placeSurface(request) {
        wmCalls.push(request);
        return request.requestedPlacement;
      },
    },
  });
  const second = composeShellLayout(registry.value, config, {
    wm: {
      placeSurface(request) {
        return request.requestedPlacement;
      },
    },
  });

  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  if (!first.ok || !second.ok) {
    assert.fail("expected deterministic app composition");
  }

  assert.deepEqual(second.value, first.value);
  assert.deepEqual(first.value.root.children.map((surface) => surface.componentId), [
    VITA_SETTINGS_APP_COMPONENT_ID,
    VITA_FILE_MANAGER_APP_COMPONENT_ID,
  ]);
  assert.deepEqual(wmCalls.map((call) => call.componentId), [
    "vita.apps.desktop",
    VITA_SETTINGS_APP_COMPONENT_ID,
    VITA_FILE_MANAGER_APP_COMPONENT_ID,
  ]);
  assert.equal(first.value.root.children[0]?.role, "window");
  assert.equal(first.value.root.children[0]?.payload["title"], "Settings");
  assert.equal(first.value.root.children[1]?.payload["path"], "/home");
  assert.match(first.value.root.children[1]?.className ?? "", /vita-file-manager-app/u);
});

test("first-party app window requests reduce through the WM policy", () => {
  let model = createWindowModel({
    activeWorkspaceId: "main",
  });
  const requests = firstPartyAppWindowRequests("main");

  for (let index = 0; index < requests.length; index += 1) {
    const request = requests[index];

    if (request !== undefined) {
      model = openWindow(model, request);
    }
  }

  const placements = layout(model, {
    bounds: {
      height: 900,
      width: 1_200,
      x: 0,
      y: 0,
    },
  });

  assert.deepEqual(placements.map((placement) => ({
    focused: placement.focused,
    rect: placement.rect,
    textureId: placement.textureId,
    windowId: placement.windowId,
  })), [
    {
      focused: false,
      rect: {
        height: 520,
        width: 760,
        x: 80,
        y: 64,
      },
      textureId: VITA_SETTINGS_APP_COMPONENT_ID,
      windowId: VITA_SETTINGS_WINDOW_ID,
    },
    {
      focused: true,
      rect: {
        height: 560,
        width: 820,
        x: 180,
        y: 96,
      },
      textureId: VITA_FILE_MANAGER_APP_COMPONENT_ID,
      windowId: VITA_FILE_MANAGER_WINDOW_ID,
    },
  ]);
});

test("file-manager lists through only the injected files capability port", async () => {
  const calls: FilesRequest[] = [];
  const port = fakeFilesPort(calls, (request) => {
    assert.equal(request.op, "list");
    assert.equal(request.grant, "home");
    assert.equal(request.path, "/home");

    return {
      entries: ROOT_ENTRIES,
    };
  });
  const state = createFileManagerState({
    grant: "home",
    path: "/home",
  });
  const listed = await loadFileManagerDirectory(port, state);

  assert.deepEqual(calls, [
    {
      grant: "home",
      op: "list",
      path: "/home",
    },
  ]);
  assert.equal(listed.state.status, "ready");
  assert.deepEqual(listed.state.entries.map((entry) => entry.name), ["docs", "z.txt"]);
  assert.deepEqual(fileManagerAppProps(listed.state)["entries"], [
    {
      kind: "dir",
      mtime: "2026-06-24T00:00:00Z",
      name: "docs",
      path: "/home/docs",
      size: 0,
    },
    {
      kind: "file",
      mtime: "2026-06-24T00:00:00Z",
      name: "z.txt",
      path: "/home/z.txt",
      size: 10,
    },
  ]);
});

test("file-manager navigation uses stat before list or read", async () => {
  const calls: FilesRequest[] = [];
  const state = createFileManagerState({
    grant: "home",
    path: "/home",
    status: "ready",
  });
  const port = fakeFilesPort(calls, (request) => {
    if (request.op === "stat" && request.path === "/home/docs") {
      return {
        kind: "dir",
        mtime: "2026-06-24T00:00:00Z",
        size: 0,
      };
    }
    if (request.op === "list" && request.path === "/home/docs") {
      return {
        entries: [
          {
            kind: "file",
            mtime: "2026-06-24T00:00:00Z",
            name: "note.txt",
            size: 4,
          },
        ],
      };
    }
    if (request.op === "stat" && request.path === "/home/readme.txt") {
      return {
        kind: "file",
        mtime: "2026-06-24T01:00:00Z",
        size: 5,
      };
    }
    if (request.op === "read" && request.path === "/home/readme.txt") {
      return {
        data: "hello",
        kind: "file",
        mtime: "2026-06-24T01:00:00Z",
        size: 5,
      };
    }

    return forbidden();
  });

  const directory = await navigateFileManager(port, state, "docs");

  assert.deepEqual(calls.map((request) => request.op), ["stat", "list"]);
  assert.equal(directory[0]?.state.status, "preview");
  assert.equal(directory[1]?.state.path, "/home/docs");
  assert.deepEqual(directory[1]?.state.entries.map((entry) => entry.name), ["note.txt"]);

  calls.length = 0;

  const file = await navigateFileManager(port, state, "readme.txt");

  assert.deepEqual(calls.map((request) => request.op), ["stat", "read"]);
  assert.equal(file[0]?.state.selected?.kind, "file");
  assert.equal(file[1]?.state.selected?.data, "hello");
  assert.equal(file[1]?.state.path, "/home");
});

test("file-manager fails closed on AccessForbidden and clears stale listing state", async () => {
  const calls: FilesRequest[] = [];
  const state = createFileManagerState({
    entries: ROOT_ENTRIES,
    grant: "home",
    path: "/home",
    selected: {
      data: "stale",
      kind: "file",
      path: "/home/z.txt",
    },
    status: "ready",
  });
  const port = fakeFilesPort(calls, () => forbidden());
  const listed = await loadFileManagerDirectory(port, state, "/secret");

  assert.deepEqual(calls, [
    {
      grant: "home",
      op: "list",
      path: "/secret",
    },
  ]);
  assert.equal(listed.state.status, "forbidden");
  assert.equal(listed.state.path, "/secret");
  assert.deepEqual(listed.state.entries, []);
  assert.equal(listed.state.selected, undefined);
  assert.equal(listed.state.error?.code, "AccessForbidden");
  assert.equal(renderSettingsAppSurface(createSettingsAppState(SETTINGS_CONFIG))["title"], "Settings");
});

interface FilesResponseEntry {
  readonly name: string;
  readonly kind: "file" | "dir" | "symlink-skipped";
  readonly size: number;
  readonly mtime: string;
}

function fakeSettingsPort(calls: SettingsControlPlaneIntent[]): SettingsControlPlanePort {
  return {
    apply(intent) {
      calls.push(intent);
      return {
        ok: true,
        value: {
          stage: "apply",
        },
      };
    },
    preview(intent) {
      calls.push(intent);
      return {
        ok: true,
        value: {
          stage: "preview",
        },
      };
    },
  };
}

function fakeFilesPort(
  calls: FilesRequest[],
  handler: (request: FilesRequest) => FilesResponse | FilesErrorResponse,
): FilesCapabilityPort {
  return {
    request(request) {
      calls.push(request);
      return handler(request);
    },
  };
}

function forbidden(): FilesErrorResponse {
  return {
    error: {
      code: "AccessForbidden",
      message: "path is outside the grant",
    },
  };
}

function settingValue(
  config: SettingsManagedConfig,
  categoryId: string,
  settingId: string,
): SettingsValue | undefined {
  for (let categoryIndex = 0; categoryIndex < config.categories.length; categoryIndex += 1) {
    const category = config.categories[categoryIndex];

    if (category === undefined || category.id !== categoryId) continue;

    for (let settingIndex = 0; settingIndex < category.settings.length; settingIndex += 1) {
      const setting = category.settings[settingIndex];

      if (setting !== undefined && setting.id === settingId) {
        return setting.value;
      }
    }
  }

  return undefined;
}
