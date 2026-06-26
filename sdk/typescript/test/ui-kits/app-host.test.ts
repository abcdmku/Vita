import assert from "node:assert/strict";
import { test } from "node:test";

import {
  createAppHost,
  type AppHostAppStatus,
  type AppHostPorts,
  type AppHostState,
  type DesktopRegistryApp,
} from "../../../../ui_kits/desktop/viewmodels/index.ts";
import {
  SDK_VERSION,
  hasDesktopCapabilityGrant,
} from "../../src/desktop-sdk/index.ts";
import type {
  DesktopAppLaunch,
  DesktopAppStop,
  DesktopCapability,
  DesktopCapabilityGrant,
  DesktopHostResult,
  DesktopLaunchableApp,
  DesktopUiPackageManifest,
} from "../../src/desktop-sdk/index.ts";

const TERMINAL_ID = "vita.app.terminal";
const CODE_ID = "vita.app.code";
const FILES_ID = "vita.app.file-manager";
const DEFAULT_APPS = Object.freeze([
  registryApp(TERMINAL_ID, "Terminal"),
  registryApp(CODE_ID, "Code"),
  registryApp(FILES_ID, "Files"),
]);

test("app host launches a palette launcher intent through the launchApp port", async () => {
  const events: string[] = [];
  const ports = fakePorts(events, {
    grants: Object.freeze([
      grant("apps.launch", TERMINAL_ID),
    ]),
  });
  const host = createAppHost(ports, DEFAULT_APPS);

  assert.equal(hasDesktopCapabilityGrant(ports.package, "apps.launch", TERMINAL_ID), true);

  const result = await host.applyLauncherIntent({
    appId: TERMINAL_ID,
    type: "launcher.launch",
  });

  assert.equal(result.ok, true);
  if (!result.ok) {
    assert.fail("expected Terminal launch to succeed");
  }
  assert.equal(result.dispatch, "launchApp");
  assert.equal(result.appId, TERMINAL_ID);
  assert.deepEqual(events, [
    `launch:${TERMINAL_ID}`,
  ]);
  assert.equal(host.isRunning(TERMINAL_ID), true);
  assert.equal(result.state, host.snapshot());
  assert.equal(result.state.focusedAppId, TERMINAL_ID);
  assert.deepEqual(projectStatus(result.state, TERMINAL_ID), {
    focused: true,
    running: true,
    surfaceId: `surface:${TERMINAL_ID}`,
    textureId: `texture:${TERMINAL_ID}`,
    windowId: `window:${TERMINAL_ID}`,
  });
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result.value), true);
  assert.equal(Object.isFrozen(result.state), true);
  assert.equal(Object.isFrozen(result.state.apps), true);
  assert.equal(Object.isFrozen(findStatus(result.state, TERMINAL_ID)), true);
});

test("app host focuses a running app without relaunching it", async () => {
  const events: string[] = [];
  const host = createAppHost(fakePorts(events), DEFAULT_APPS);

  const launched = await host.launchOrFocus(TERMINAL_ID);

  assert.equal(launched.ok, true);

  const focused = await host.launchOrFocus(TERMINAL_ID);

  assert.equal(focused.ok, true);
  if (!focused.ok) {
    assert.fail("expected Terminal focus to succeed");
  }
  assert.equal(focused.dispatch, "focus");
  assert.equal(focused.appId, TERMINAL_ID);
  assert.equal(host.focusedAppId, TERMINAL_ID);
  assert.deepEqual(events, [
    `launch:${TERMINAL_ID}`,
  ]);
  assert.deepEqual(projectStatus(focused.state, TERMINAL_ID), {
    focused: true,
    running: true,
    surfaceId: `surface:${TERMINAL_ID}`,
    textureId: `texture:${TERMINAL_ID}`,
    windowId: `window:${TERMINAL_ID}`,
  });
});

test("app host snapshot gives dock and palette one running/focused lifecycle view", async () => {
  const events: string[] = [];
  const host = createAppHost(fakePorts(events), DEFAULT_APPS);

  assert.equal((await host.launchOrFocus(TERMINAL_ID)).ok, true);
  assert.equal((await host.launchOrFocus(CODE_ID)).ok, true);

  const snapshot = host.snapshot();
  const focused = focusedStatuses(snapshot);

  assert.deepEqual(snapshot.apps.map((app) => [
    app.appId,
    app.title,
    app.running,
    app.focused,
  ]), [
    [TERMINAL_ID, "Terminal", true, false],
    [CODE_ID, "Code", true, true],
    [FILES_ID, "Files", false, false],
  ]);
  assert.equal(snapshot.focusedAppId, CODE_ID);
  assert.equal(focused.length, 1);
  assert.equal(focused[0]?.appId, CODE_ID);
  assert.equal(host.isRunning(TERMINAL_ID), true);
  assert.equal(host.isRunning(CODE_ID), true);
  assert.deepEqual(events, [
    `launch:${TERMINAL_ID}`,
    `launch:${CODE_ID}`,
  ]);
});

test("app host close stops running apps and clears lifecycle state", async () => {
  const events: string[] = [];
  const host = createAppHost(fakePorts(events), DEFAULT_APPS);

  assert.equal((await host.launchOrFocus(TERMINAL_ID)).ok, true);
  events.length = 0;

  const stopped = await host.close(TERMINAL_ID);

  assert.equal(stopped.ok, true);
  if (!stopped.ok) {
    assert.fail("expected Terminal stop to succeed");
  }
  assert.equal(stopped.dispatch, "stop");
  assert.equal(stopped.appId, TERMINAL_ID);
  assert.equal(stopped.value.appId, TERMINAL_ID);
  assert.deepEqual(events, [
    `stop:${TERMINAL_ID}`,
  ]);
  assert.equal(host.focusedAppId, null);
  assert.equal(host.isRunning(TERMINAL_ID), false);
  assert.deepEqual(projectStatus(stopped.state, TERMINAL_ID), {
    focused: false,
    running: false,
    surfaceId: undefined,
    textureId: undefined,
    windowId: undefined,
  });
  assert.equal(Object.hasOwn(findStatus(stopped.state, TERMINAL_ID), "launch"), false);

  const beforeNotRunning = host.snapshot();
  const notRunning = await host.close(TERMINAL_ID);

  assert.equal(notRunning.ok, false);
  if (notRunning.ok) {
    assert.fail("expected not-running close to fail");
  }
  assert.equal(notRunning.error.code, "APP_NOT_RUNNING");
  assert.equal(notRunning.state, beforeNotRunning);
  assert.equal(host.snapshot(), beforeNotRunning);

  assert.equal((await host.launchOrFocus(CODE_ID)).ok, true);
  events.length = 0;

  const intentStopped = await host.applyLauncherIntent({
    appId: CODE_ID,
    type: "launcher.close",
  });

  assert.equal(intentStopped.ok, true);
  if (!intentStopped.ok) {
    assert.fail("expected launcher.close to stop Code");
  }
  assert.equal(intentStopped.dispatch, "stop");
  assert.deepEqual(events, [
    `stop:${CODE_ID}`,
  ]);
});

test("app host rejects launcher intents that do not resolve to app lifecycle actions", async () => {
  const events: string[] = [];
  const host = createAppHost(fakePorts(events), DEFAULT_APPS);
  const before = host.snapshot();

  const open = await host.applyLauncherIntent({
    appId: TERMINAL_ID,
    type: "launcher.open",
  });
  const missing = await host.applyLauncherIntent({
    type: "launcher.launch",
  });
  const unlisted = await host.applyLauncherIntent({
    appId: "vita.app.unknown",
    type: "launcher.launch",
  });

  for (const result of [open, missing, unlisted]) {
    assert.equal(result.ok, false);
    if (result.ok) {
      assert.fail("expected launcher intent rejection");
    }
    assert.equal(result.error.code, "UNKNOWN_LAUNCHER_INTENT");
    assert.equal(result.state, before);
  }
  assert.equal(host.snapshot(), before);
  assert.deepEqual(events, []);
});

test("app host launch failures fail closed without changing lifecycle state", async () => {
  const missingGrantEvents: string[] = [];
  const missingGrantHost = createAppHost(fakePorts(missingGrantEvents, {
    grants: Object.freeze([]),
  }), DEFAULT_APPS);
  const beforeMissingGrant = missingGrantHost.snapshot();

  const missingGrant = await missingGrantHost.launchOrFocus(TERMINAL_ID);

  assert.equal(missingGrant.ok, false);
  if (missingGrant.ok) {
    assert.fail("expected missing launch grant to fail");
  }
  assert.equal(missingGrant.error.code, "MISSING_CAPABILITY");
  assert.equal(missingGrant.state, beforeMissingGrant);
  assert.equal(missingGrantHost.snapshot(), beforeMissingGrant);
  assert.deepEqual(missingGrantEvents, []);

  const thrownEvents: string[] = [];
  const thrownHost = createAppHost(fakePorts(thrownEvents, {
    throwLaunchIds: new Set([TERMINAL_ID]),
  }), DEFAULT_APPS);
  const beforeThrown = thrownHost.snapshot();
  const thrown = await thrownHost.launchOrFocus(TERMINAL_ID);

  assert.equal(thrown.ok, false);
  if (thrown.ok) {
    assert.fail("expected throwing launch port to fail");
  }
  assert.equal(thrown.error.code, "APP_LAUNCH_PORT_FAILED");
  assert.equal(thrown.state, beforeThrown);
  assert.equal(thrownHost.snapshot(), beforeThrown);
  assert.deepEqual(thrownEvents, [
    `launch:${TERMINAL_ID}`,
  ]);

  const mismatchEvents: string[] = [];
  const mismatchHost = createAppHost(fakePorts(mismatchEvents, {
    mismatchLaunchIds: new Set([TERMINAL_ID]),
  }), DEFAULT_APPS);
  const beforeMismatch = mismatchHost.snapshot();
  const mismatch = await mismatchHost.launchOrFocus(TERMINAL_ID);

  assert.equal(mismatch.ok, false);
  if (mismatch.ok) {
    assert.fail("expected mismatched launch result to fail");
  }
  assert.equal(mismatch.error.code, "APP_LAUNCH_MISMATCH");
  assert.equal(mismatch.state, beforeMismatch);
  assert.equal(mismatchHost.snapshot(), beforeMismatch);
  assert.equal(mismatchHost.isRunning(TERMINAL_ID), false);
  assert.deepEqual(mismatchEvents, [
    `launch:${TERMINAL_ID}`,
  ]);
});

interface FakePortOptions {
  readonly grants?: readonly DesktopCapabilityGrant[];
  readonly rejectLaunchIds?: ReadonlySet<string>;
  readonly throwLaunchIds?: ReadonlySet<string>;
  readonly mismatchLaunchIds?: ReadonlySet<string>;
  readonly rejectStopIds?: ReadonlySet<string>;
  readonly throwStopIds?: ReadonlySet<string>;
  readonly mismatchStopIds?: ReadonlySet<string>;
}

interface ProjectedStatus {
  readonly running: boolean;
  readonly focused: boolean;
  readonly surfaceId: string | undefined;
  readonly windowId: string | undefined;
  readonly textureId: string | undefined;
}

function registryApp(id: string, title: string): DesktopRegistryApp {
  return Object.freeze({
    app: launchableApp(id, title),
    requiredGrants: Object.freeze([
      grant("apps.launch", id),
    ]),
    title,
  });
}

function launchableApp(id: string, title: string): DesktopLaunchableApp {
  return Object.freeze({
    id,
    runtime: Object.freeze({
      componentId: id,
    }),
    surfaceKind: "tsx",
    title,
  });
}

function fakePorts(
  events: string[],
  options: FakePortOptions = Object.freeze({}),
): AppHostPorts {
  return Object.freeze({
    launchApp(app: DesktopLaunchableApp): DesktopHostResult<DesktopAppLaunch> {
      events.push(`launch:${app.id}`);

      if (options.throwLaunchIds?.has(app.id) === true) {
        throw new Error(`configured launch throw for ${app.id}`);
      }
      if (options.rejectLaunchIds?.has(app.id) === true) {
        return hostReject("APP_REJECTED", "launch rejected by fake app port.", `/apps/${app.id}`);
      }

      const launchedApp = options.mismatchLaunchIds?.has(app.id) === true
        ? launchableApp("vita.app.other", "Other")
        : app;

      return hostAccept(Object.freeze({
        app: launchedApp,
        intents: Object.freeze([]),
        surfaceId: `surface:${launchedApp.id}`,
        textureId: `texture:${launchedApp.id}`,
        windowId: `window:${launchedApp.id}`,
      }));
    },
    package: manifest(options.grants ?? Object.freeze([
      grant("apps.launch"),
      grant("apps.stop"),
    ])),
    stopApp(appId: string): DesktopHostResult<DesktopAppStop> {
      events.push(`stop:${appId}`);

      if (options.throwStopIds?.has(appId) === true) {
        throw new Error(`configured stop throw for ${appId}`);
      }
      if (options.rejectStopIds?.has(appId) === true) {
        return hostReject("APP_STOP_REJECTED", "stop rejected by fake app port.", `/apps/${appId}`);
      }

      const stoppedAppId = options.mismatchStopIds?.has(appId) === true ? "vita.app.other" : appId;

      return hostAccept(Object.freeze({
        appId: stoppedAppId,
        intents: Object.freeze([]),
        surfaceId: `surface:${appId}`,
        textureId: `texture:${appId}`,
        windowId: `window:${appId}`,
      }));
    },
  });
}

function manifest(grants: readonly DesktopCapabilityGrant[]): DesktopUiPackageManifest {
  return Object.freeze({
    capabilityGrants: Object.freeze([...grants]),
    entry: "./app-host.test.ts",
    id: "ui.app-host.test",
    sdkVersion: SDK_VERSION,
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

function projectStatus(state: AppHostState, appId: string): ProjectedStatus {
  const status = findStatus(state, appId);

  return {
    focused: status.focused,
    running: status.running,
    surfaceId: status.launch?.surfaceId,
    textureId: status.launch?.textureId,
    windowId: status.launch?.windowId,
  };
}

function findStatus(state: AppHostState, appId: string): AppHostAppStatus {
  for (let index = 0; index < state.apps.length; index += 1) {
    const status = state.apps[index];

    if (status !== undefined && status.appId === appId) return status;
  }

  assert.fail(`missing app status ${appId}`);
}

function focusedStatuses(state: AppHostState): readonly AppHostAppStatus[] {
  const output: AppHostAppStatus[] = [];

  for (let index = 0; index < state.apps.length; index += 1) {
    const status = state.apps[index];

    if (status !== undefined && status.focused) output.push(status);
  }

  return output;
}

function hostAccept<T>(value: T): DesktopHostResult<T> {
  return Object.freeze({
    ok: true,
    value,
  });
}

function hostReject<T>(code: string, message: string, path: string): DesktopHostResult<T> {
  return Object.freeze({
    error: Object.freeze({
      code,
      message,
      path,
    }),
    ok: false,
  });
}
