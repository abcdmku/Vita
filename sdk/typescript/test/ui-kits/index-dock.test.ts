import assert from "node:assert/strict";
import { test } from "node:test";

import {
  DEFAULT_INDEX_DOCK_APPS,
  INDEX_DOCK_APP_IDS,
  createIndexDockViewModel,
} from "../../../../ui_kits/desktop/viewmodels/dock.ts";
import type {
  IndexDockAppId,
  IndexDockItem,
  IndexDockPorts,
  IndexDockState,
} from "../../../../ui_kits/desktop/viewmodels/dock.ts";
import type {
  DesktopAppLaunch,
  DesktopCapability,
  DesktopCapabilityGrant,
  DesktopHostResult,
  DesktopLaunchableApp,
  DesktopUiPackageManifest,
} from "../../src/desktop-sdk/index.ts";

test("index dock seeds pinned design apps deterministically", () => {
  const viewModel = createIndexDockViewModel(fakePorts([]));
  const snapshot = viewModel.snapshot();

  assert.deepEqual(viewModel.apps.map((app) => [
    app.appId,
    app.title,
    app.icon,
    app.app.id,
    app.app.surfaceKind,
  ]), [
    [INDEX_DOCK_APP_IDS.terminal, "Terminal", "terminal", INDEX_DOCK_APP_IDS.terminal, "tsx"],
    [INDEX_DOCK_APP_IDS.code, "Code", "code", INDEX_DOCK_APP_IDS.code, "tsx"],
    [INDEX_DOCK_APP_IDS.files, "Files", "folder", INDEX_DOCK_APP_IDS.files, "tsx"],
    [INDEX_DOCK_APP_IDS.mail, "Mail", "mail", INDEX_DOCK_APP_IDS.mail, "tsx"],
    [INDEX_DOCK_APP_IDS.browser, "Browser", "globe", INDEX_DOCK_APP_IDS.browser, "tsx"],
    [INDEX_DOCK_APP_IDS.settings, "Settings", "settings", INDEX_DOCK_APP_IDS.settings, "tsx"],
  ]);
  assert.deepEqual(snapshot.items.map((item) => [
    item.appId,
    item.title,
    item.icon,
    item.pinned,
    item.running,
    item.focused,
  ]), [
    [INDEX_DOCK_APP_IDS.terminal, "Terminal", "terminal", true, false, false],
    [INDEX_DOCK_APP_IDS.code, "Code", "code", true, false, false],
    [INDEX_DOCK_APP_IDS.files, "Files", "folder", true, false, false],
    [INDEX_DOCK_APP_IDS.mail, "Mail", "mail", true, false, false],
    [INDEX_DOCK_APP_IDS.browser, "Browser", "globe", true, false, false],
    [INDEX_DOCK_APP_IDS.settings, "Settings", "settings", true, false, false],
  ]);
  assert.equal(snapshot.focusedAppId, null);
  assert.equal(viewModel.isRunning(INDEX_DOCK_APP_IDS.terminal), false);
  assert.equal(viewModel.isRunning("missing"), false);
  assert.equal(Object.isFrozen(DEFAULT_INDEX_DOCK_APPS), true);
  assert.equal(Object.isFrozen(snapshot), true);
  assert.equal(Object.isFrozen(snapshot.items), true);
});

test("index dock launchOrFocus launches a pinned app through the app-launch port", async () => {
  const events: string[] = [];
  const viewModel = createIndexDockViewModel(fakePorts(events, [
    grant("apps.launch", INDEX_DOCK_APP_IDS.terminal),
  ]));

  const result = await viewModel.launchOrFocus(INDEX_DOCK_APP_IDS.terminal);

  assert.equal(result.ok, true);
  if (!result.ok) {
    assert.fail("expected Terminal launch to succeed");
  }
  assert.equal(result.dispatch, "launchApp");
  assert.equal(result.appId, INDEX_DOCK_APP_IDS.terminal);
  assert.equal(result.value.app.id, INDEX_DOCK_APP_IDS.terminal);
  assert.deepEqual(events, [
    `launch:${INDEX_DOCK_APP_IDS.terminal}`,
  ]);
  assert.equal(viewModel.isRunning(INDEX_DOCK_APP_IDS.terminal), true);
  assert.equal(result.state.focusedAppId, INDEX_DOCK_APP_IDS.terminal);
  assert.deepEqual(projectItem(result.state, INDEX_DOCK_APP_IDS.terminal), {
    focused: true,
    running: true,
  });
  assert.deepEqual(projectItem(result.state, INDEX_DOCK_APP_IDS.code), {
    focused: false,
    running: false,
  });
});

test("index dock launchOrFocus focuses a running app without relaunching it", async () => {
  const events: string[] = [];
  const viewModel = createIndexDockViewModel(fakePorts(events, [
    grant("apps.launch"),
  ]));

  const terminal = await viewModel.launchOrFocus(INDEX_DOCK_APP_IDS.terminal);
  const code = await viewModel.launchOrFocus(INDEX_DOCK_APP_IDS.code);

  assert.equal(terminal.ok, true);
  assert.equal(code.ok, true);
  assert.deepEqual(events, [
    `launch:${INDEX_DOCK_APP_IDS.terminal}`,
    `launch:${INDEX_DOCK_APP_IDS.code}`,
  ]);

  const focused = await viewModel.launchOrFocus(INDEX_DOCK_APP_IDS.terminal);

  assert.equal(focused.ok, true);
  if (!focused.ok) {
    assert.fail("expected Terminal focus to succeed");
  }
  assert.equal(focused.dispatch, "focus");
  assert.equal(focused.appId, INDEX_DOCK_APP_IDS.terminal);
  assert.deepEqual(events, [
    `launch:${INDEX_DOCK_APP_IDS.terminal}`,
    `launch:${INDEX_DOCK_APP_IDS.code}`,
  ]);
  assert.equal(focused.state.focusedAppId, INDEX_DOCK_APP_IDS.terminal);
  assert.deepEqual(projectItem(focused.state, INDEX_DOCK_APP_IDS.terminal), {
    focused: true,
    running: true,
  });
  assert.deepEqual(projectItem(focused.state, INDEX_DOCK_APP_IDS.code), {
    focused: false,
    running: true,
  });
});

test("index dock launchOrFocus fails closed without the launch grant", async () => {
  const events: string[] = [];
  const viewModel = createIndexDockViewModel(fakePorts(events));
  const before = viewModel.snapshot();

  const result = await viewModel.launchOrFocus(INDEX_DOCK_APP_IDS.terminal);

  assert.equal(result.ok, false);
  if (result.ok) {
    assert.fail("expected missing launch grant to fail");
  }
  assert.equal(result.error.code, "MISSING_CAPABILITY");
  assert.equal(result.appId, INDEX_DOCK_APP_IDS.terminal);
  assert.equal(result.state, before);
  assert.equal(viewModel.snapshot(), before);
  assert.equal(viewModel.isRunning(INDEX_DOCK_APP_IDS.terminal), false);
  assert.deepEqual(events, []);
});

test("index dock launchOrFocus rejects unknown dock apps without dispatch", async () => {
  const events: string[] = [];
  const viewModel = createIndexDockViewModel(fakePorts(events, [
    grant("apps.launch"),
  ]));
  const before = viewModel.snapshot();

  const result = await viewModel.launchOrFocus("vita.app.unknown");

  assert.equal(result.ok, false);
  if (result.ok) {
    assert.fail("expected unknown dock app to fail");
  }
  assert.equal(result.error.code, "UNKNOWN_DOCK_APP");
  assert.equal(result.appId, "vita.app.unknown");
  assert.equal(result.state, before);
  assert.equal(viewModel.snapshot(), before);
  assert.deepEqual(events, []);
});

test("index dock launch failures preserve prior lifecycle state", async () => {
  const events: string[] = [];
  const viewModel = createIndexDockViewModel(fakePorts(events, [
    grant("apps.launch"),
  ], {
    rejectAppIds: new Set([INDEX_DOCK_APP_IDS.code]),
    throwAppIds: new Set([INDEX_DOCK_APP_IDS.mail]),
  }));

  const launched = await viewModel.launchOrFocus(INDEX_DOCK_APP_IDS.terminal);

  assert.equal(launched.ok, true);
  const before = viewModel.snapshot();
  events.length = 0;

  const rejected = await viewModel.launchOrFocus(INDEX_DOCK_APP_IDS.code);
  const thrown = await viewModel.launchOrFocus(INDEX_DOCK_APP_IDS.mail);

  assert.equal(rejected.ok, false);
  assert.equal(thrown.ok, false);
  if (rejected.ok || thrown.ok) {
    assert.fail("expected configured launch failures");
  }
  assert.equal(rejected.error.code, "APP_REJECTED");
  assert.equal(thrown.error.code, "APP_LAUNCH_PORT_FAILED");
  assert.equal(rejected.state, before);
  assert.equal(thrown.state, before);
  assert.equal(viewModel.snapshot(), before);
  assert.equal(viewModel.isRunning(INDEX_DOCK_APP_IDS.terminal), true);
  assert.equal(viewModel.isRunning(INDEX_DOCK_APP_IDS.code), false);
  assert.equal(viewModel.isRunning(INDEX_DOCK_APP_IDS.mail), false);
  assert.deepEqual(events, [
    `launch:${INDEX_DOCK_APP_IDS.code}`,
    `launch:${INDEX_DOCK_APP_IDS.mail}`,
  ]);
});

function projectItem(
  state: IndexDockState,
  appId: IndexDockAppId,
): Pick<IndexDockItem, "focused" | "running"> {
  const item = findItem(state, appId);

  return {
    focused: item.focused,
    running: item.running,
  };
}

function findItem(state: IndexDockState, appId: IndexDockAppId): IndexDockItem {
  for (let index = 0; index < state.items.length; index += 1) {
    const item = state.items[index];

    if (item !== undefined && item.appId === appId) {
      return item;
    }
  }

  assert.fail(`missing dock item ${appId}`);
}

function fakePorts(
  events: string[],
  grants: readonly DesktopCapabilityGrant[] = Object.freeze([]),
  options: {
    readonly rejectAppIds?: ReadonlySet<string>;
    readonly throwAppIds?: ReadonlySet<string>;
  } = Object.freeze({}),
): IndexDockPorts {
  return Object.freeze({
    launchApp(app: DesktopLaunchableApp): DesktopHostResult<DesktopAppLaunch> {
      events.push(`launch:${app.id}`);

      if (options.throwAppIds?.has(app.id) === true) {
        throw new Error(`configured launch throw for ${app.id}`);
      }
      if (options.rejectAppIds?.has(app.id) === true) {
        return hostReject("APP_REJECTED", "launch rejected by fake app port.", `/apps/${app.id}`);
      }

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
    package: manifest(grants),
  });
}

function manifest(grants: readonly DesktopCapabilityGrant[]): DesktopUiPackageManifest {
  return Object.freeze({
    capabilityGrants: Object.freeze([...grants]),
    entry: "./index-dock.ts",
    id: "ui.index-dock.test",
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
