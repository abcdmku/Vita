import assert from "node:assert/strict";
import { test } from "node:test";

import {
  AppHost,
  VITA_WINDOWED_APP_COMPONENT_ID,
  appSurfaceId,
} from "../../src/appshell/index.ts";
import type {
  AppDescriptor,
  AppHostResult,
  CapsuleAppSurfaceKind,
  CapsuleRuntimeBinding,
  CapsuleRuntimeLaunchRequest,
  CapsuleRuntimePort,
  TsxRenderBinding,
  TsxRenderPort,
  TsxRenderRequest,
  WebviewBinding,
  WebviewLaunchRequest,
  WebviewPort,
} from "../../src/appshell/index.ts";
import type {
  ShellSubstratePort,
  ShellSurfaceCreateRequest,
} from "../../src/shell/index.ts";
import {
  createWindowModel,
} from "../../src/wm/policy.ts";
import type {
  Rect,
  WindowManagerIntent,
  WindowManagerSubstratePort,
} from "../../src/wm/policy.ts";

const SCREEN = Object.freeze({
  height: 900,
  width: 1_200,
  x: 0,
  y: 0,
}) satisfies Rect;

const TSX_RECT = Object.freeze({
  height: 520,
  width: 760,
  x: 80,
  y: 64,
}) satisfies Rect;

test("tsx app launches as a windowed shell surface placed by WM intents and stops cleanly", () => {
  const created: ShellSurfaceCreateRequest[] = [];
  const removed: string[] = [];
  const wmCalls: WindowManagerIntent[] = [];
  const mounts: TsxRenderRequest[] = [];
  const unmounts: TsxRenderBinding[] = [];
  const app = tsxApp();
  const host = new AppHost({
    initialWindowModel: createWindowModel({
      activeWorkspaceId: "main",
    }),
    layoutConstraints: {
      bounds: SCREEN,
    },
    ports: {
      shell: fakeShell(created, removed),
      tsx: fakeTsxPort(mounts, unmounts),
      wm: fakeWm(wmCalls),
    },
  });

  const launched = host.launch(app);

  assert.equal(launched.ok, true);
  if (!launched.ok) {
    assert.fail("expected TSX launch to succeed");
  }

  assert.equal(mounts.length, 1);
  assert.equal(mounts[0]?.runtime.componentId, "com.vita.notes.component");
  assert.equal(created.length, 1);
  assert.equal(created[0]?.componentId, VITA_WINDOWED_APP_COMPONENT_ID);
  assert.equal(created[0]?.role, "window");
  assert.equal(created[0]?.payload["kind"], "windowed-app");
  assert.equal(created[0]?.payload["surfaceKind"], "tsx");
  assert.equal(created[0]?.payload["componentId"], "com.vita.notes.component");
  assert.equal(created[0]?.payload["windowed"], true);
  assert.deepEqual(created[0]?.placement.rect, TSX_RECT);
  assert.deepEqual(wmCalls.map((call) => call.type), [
    "setTextureVisibility",
    "repositionTexture",
    "setFocus",
  ]);
  assert.deepEqual(
    wmCalls.find((call) => call.type === "repositionTexture"),
    {
      rect: TSX_RECT,
      textureId: appSurfaceId(app.id),
      type: "repositionTexture",
      windowId: "window:com.vita.notes",
    },
  );
  assert.equal(host.snapshot().apps.length, 1);
  assert.equal(host.snapshot().windowModel.windows.length, 1);

  wmCalls.length = 0;
  const stopped = host.stop(app);

  assert.equal(stopped.ok, true);
  if (!stopped.ok) {
    assert.fail("expected TSX stop to succeed");
  }
  assert.deepEqual(removed, [appSurfaceId(app.id)]);
  assert.deepEqual(unmounts.map((binding) => binding.bindingId), ["tsx:com.vita.notes.component"]);
  assert.deepEqual(wmCalls.map((call) => call.type), [
    "setTextureVisibility",
    "setFocus",
  ]);
  assert.deepEqual(wmCalls[0], {
    textureId: appSurfaceId(app.id),
    type: "setTextureVisibility",
    visible: false,
    windowId: "window:com.vita.notes",
  });
  assert.deepEqual(wmCalls[1], {
    type: "setFocus",
    windowId: null,
  });
  assert.equal(host.snapshot().apps.length, 0);
  assert.equal(host.snapshot().windowModel.windows.length, 0);
});

test("wasm and container apps share the same windowed surface class over capsule runtime ports", () => {
  const created: ShellSurfaceCreateRequest[] = [];
  const removed: string[] = [];
  const wmCalls: WindowManagerIntent[] = [];
  const wasmLaunches: CapsuleRuntimeLaunchRequest<"wasm">[] = [];
  const containerLaunches: CapsuleRuntimeLaunchRequest<"container">[] = [];
  const wasmStops: CapsuleRuntimeBinding<"wasm">[] = [];
  const containerStops: CapsuleRuntimeBinding<"container">[] = [];
  const wasm = wasmApp();
  const container = containerApp();
  const host = new AppHost({
    layoutConstraints: {
      bounds: SCREEN,
    },
    ports: {
      container: fakeCapsulePort("container", containerLaunches, containerStops),
      shell: fakeShell(created, removed),
      wasm: fakeCapsulePort("wasm", wasmLaunches, wasmStops),
      wm: fakeWm(wmCalls),
    },
  });

  const wasmLaunch = host.launch(wasm);
  const containerLaunch = host.launch(container);

  assert.equal(wasmLaunch.ok, true);
  assert.equal(containerLaunch.ok, true);
  if (!wasmLaunch.ok || !containerLaunch.ok) {
    assert.fail("expected capsule apps to launch");
  }

  assert.deepEqual(created.map((request) => request.componentId), [
    VITA_WINDOWED_APP_COMPONENT_ID,
    VITA_WINDOWED_APP_COMPONENT_ID,
  ]);
  assert.deepEqual(created.map((request) => request.payload["surfaceKind"]), ["wasm", "container"]);
  assert.deepEqual(created.map((request) => request.payload["capsuleId"]), [
    "capsule.notes-wasm",
    "capsule.editor-oci",
  ]);
  assert.deepEqual(wasmLaunches.map((request) => request.runtime.id), ["capsule.notes-wasm"]);
  assert.deepEqual(containerLaunches.map((request) => request.runtime.id), ["capsule.editor-oci"]);
  assert.deepEqual(host.snapshot().apps.map((launch) => launch.app.id), [
    "com.vita.editor",
    "com.vita.notes.wasm",
  ]);

  assert.equal(host.stop(wasm).ok, true);
  assert.equal(host.stop(container).ok, true);
  assert.deepEqual(removed.sort(), [
    appSurfaceId(container.id),
    appSurfaceId(wasm.id),
  ].sort());
  assert.deepEqual(wasmStops.map((binding) => binding.capsuleId), ["capsule.notes-wasm"]);
  assert.deepEqual(containerStops.map((binding) => binding.capsuleId), ["capsule.editor-oci"]);
});

test("web app is lifecycle-wired through the stubbed webview port", () => {
  const created: ShellSurfaceCreateRequest[] = [];
  const removed: string[] = [];
  const wmCalls: WindowManagerIntent[] = [];
  const opens: WebviewLaunchRequest[] = [];
  const closes: WebviewBinding[] = [];
  const app = webApp();
  const host = new AppHost({
    layoutConstraints: {
      bounds: SCREEN,
    },
    ports: {
      shell: fakeShell(created, removed),
      webview: fakeWebviewPort(opens, closes),
      wm: fakeWm(wmCalls),
    },
  });

  const launched = host.launch(app);

  assert.equal(launched.ok, true);
  if (!launched.ok) {
    assert.fail("expected web launch to succeed with a webview port");
  }
  assert.deepEqual(opens.map((request) => request.runtime.url), ["https://app.example.test/"]);
  assert.equal(created[0]?.payload["surfaceKind"], "web");
  assert.equal(created[0]?.payload["url"], "https://app.example.test/");

  const stopped = host.stop(app);

  assert.equal(stopped.ok, true);
  assert.deepEqual(removed, [appSurfaceId(app.id)]);
  assert.deepEqual(closes.map((binding) => binding.url), ["https://app.example.test/"]);
});

test("web app fails closed before shell or WM work when no webview port is provided", () => {
  const created: ShellSurfaceCreateRequest[] = [];
  const removed: string[] = [];
  const wmCalls: WindowManagerIntent[] = [];
  const host = new AppHost({
    ports: {
      shell: fakeShell(created, removed),
      wm: fakeWm(wmCalls),
    },
  });

  const launched = host.launch(webApp());

  assert.equal(launched.ok, false);
  if (launched.ok) {
    assert.fail("expected missing webview port rejection");
  }
  assert.equal(launched.error.code, "WEBVIEW_PORT_UNAVAILABLE");
  assert.deepEqual(created, []);
  assert.deepEqual(removed, []);
  assert.equal(wmCalls.length, 0);
  assert.equal(host.snapshot().apps.length, 0);
  assert.equal(host.snapshot().windowModel.windows.length, 0);
});

test("unavailable capsule runtime fails closed without registering a surface", () => {
  const created: ShellSurfaceCreateRequest[] = [];
  const removed: string[] = [];
  const wmCalls: WindowManagerIntent[] = [];
  const launches: CapsuleRuntimeLaunchRequest<"wasm">[] = [];
  const stops: CapsuleRuntimeBinding<"wasm">[] = [];
  const host = new AppHost({
    ports: {
      shell: fakeShell(created, removed),
      wasm: unavailableCapsulePort("wasm", launches, stops),
      wm: fakeWm(wmCalls),
    },
  });

  const launched = host.launch(wasmApp());

  assert.equal(launched.ok, false);
  if (launched.ok) {
    assert.fail("expected unavailable runtime rejection");
  }
  assert.equal(launched.error.code, "RUNTIME_UNAVAILABLE");
  assert.equal(launches.length, 1);
  assert.deepEqual(stops, []);
  assert.deepEqual(created, []);
  assert.deepEqual(removed, []);
  assert.deepEqual(wmCalls, []);
  assert.equal(host.snapshot().apps.length, 0);
});

test("runtime stop failure records pending cleanup for retry after surface teardown", () => {
  const created: ShellSurfaceCreateRequest[] = [];
  const removed: string[] = [];
  const wmCalls: WindowManagerIntent[] = [];
  const mounts: TsxRenderRequest[] = [];
  const unmounts: TsxRenderBinding[] = [];
  let failUnmount = false;
  const app = tsxApp();
  const host = new AppHost({
    layoutConstraints: {
      bounds: SCREEN,
    },
    ports: {
      shell: fakeShell(created, removed),
      tsx: fakeTsxPortWithUnmountFailure(mounts, unmounts, () => failUnmount),
      wm: fakeWm(wmCalls),
    },
  });

  const launched = host.launch(app);

  assert.equal(launched.ok, true);
  wmCalls.length = 0;
  failUnmount = true;

  const failedStop = host.stop(app);

  assert.equal(failedStop.ok, false);
  if (failedStop.ok) {
    assert.fail("expected runtime stop rejection");
  }
  assert.equal(failedStop.error.code, "RUNTIME_STOP_FAILED");
  assert.deepEqual(removed, [appSurfaceId(app.id)]);
  assert.deepEqual(wmCalls, []);
  assert.deepEqual(unmounts.map((binding) => binding.bindingId), ["tsx:com.vita.notes.component"]);
  assert.equal(host.snapshot().apps.length, 0);
  assert.equal(host.snapshot().windowModel.windows.length, 1);

  const duplicateLaunch = host.launch(app);

  assert.equal(duplicateLaunch.ok, false);
  if (duplicateLaunch.ok) {
    assert.fail("expected cleanup-pending launch rejection");
  }
  assert.equal(duplicateLaunch.error.code, "APP_LAUNCH_CLEANUP_PENDING");

  failUnmount = false;

  const retryStop = host.stop(app);

  assert.equal(retryStop.ok, true);
  assert.deepEqual(removed, [appSurfaceId(app.id)]);
  assert.deepEqual(unmounts.map((binding) => binding.bindingId), [
    "tsx:com.vita.notes.component",
    "tsx:com.vita.notes.component",
  ]);
  assert.equal(host.snapshot().apps.length, 0);
  assert.equal(host.snapshot().windowModel.windows.length, 0);
});

test("surface removal failure records pending cleanup without retrying a stopped runtime", () => {
  const created: ShellSurfaceCreateRequest[] = [];
  const removed: string[] = [];
  const removeAttempts: string[] = [];
  const wmCalls: WindowManagerIntent[] = [];
  const mounts: TsxRenderRequest[] = [];
  const unmounts: TsxRenderBinding[] = [];
  let failRemove = false;
  const app = tsxApp();
  const host = new AppHost({
    initialWindowModel: createWindowModel({
      activeWorkspaceId: "main",
    }),
    layoutConstraints: {
      bounds: SCREEN,
    },
    ports: {
      shell: fakeShellWithRemoveFailure(created, removed, removeAttempts, () => failRemove),
      tsx: fakeTsxPort(mounts, unmounts),
      wm: fakeWm(wmCalls),
    },
  });

  const launched = host.launch(app);

  assert.equal(launched.ok, true);
  wmCalls.length = 0;
  failRemove = true;

  const failedStop = host.stop(app);

  assert.equal(failedStop.ok, false);
  if (failedStop.ok) {
    assert.fail("expected surface removal rejection");
  }
  assert.equal(failedStop.error.code, "SHELL_SURFACE_REMOVE_FAILED");
  assert.deepEqual(removeAttempts, [appSurfaceId(app.id)]);
  assert.deepEqual(removed, []);
  assert.equal(wmCalls.length, 0);
  assert.deepEqual(unmounts.map((binding) => binding.bindingId), ["tsx:com.vita.notes.component"]);
  assert.equal(host.snapshot().apps.length, 0);
  assert.equal(host.snapshot().windowModel.windows.length, 1);

  const duplicateLaunch = host.launch(app);

  assert.equal(duplicateLaunch.ok, false);
  if (duplicateLaunch.ok) {
    assert.fail("expected cleanup-pending launch rejection");
  }
  assert.equal(duplicateLaunch.error.code, "APP_LAUNCH_CLEANUP_PENDING");

  failRemove = false;

  const retryStop = host.stop(app);

  assert.equal(retryStop.ok, true);
  assert.deepEqual(removeAttempts, [appSurfaceId(app.id), appSurfaceId(app.id)]);
  assert.deepEqual(removed, [appSurfaceId(app.id)]);
  assert.deepEqual(unmounts.map((binding) => binding.bindingId), ["tsx:com.vita.notes.component"]);
  assert.deepEqual(wmCalls.map((call) => call.type), [
    "setTextureVisibility",
    "setFocus",
  ]);
  assert.equal(host.snapshot().apps.length, 0);
  assert.equal(host.snapshot().windowModel.windows.length, 0);
});

test("failed launch reports rollback runtime stop failure instead of silently leaking it", () => {
  const created: ShellSurfaceCreateRequest[] = [];
  const removed: string[] = [];
  const wmCalls: WindowManagerIntent[] = [];
  const mounts: TsxRenderRequest[] = [];
  const unmounts: TsxRenderBinding[] = [];
  let failUnmount = true;
  let failWm = true;
  const app = tsxApp();
  const host = new AppHost({
    initialWindowModel: createWindowModel({
      activeWorkspaceId: "main",
    }),
    layoutConstraints: {
      bounds: SCREEN,
    },
    ports: {
      shell: fakeShell(created, removed),
      tsx: fakeTsxPortWithUnmountFailure(mounts, unmounts, () => failUnmount),
      wm: conditionalThrowingWm(wmCalls, () => failWm),
    },
  });

  const launched = host.launch(app);

  assert.equal(launched.ok, false);
  if (launched.ok) {
    assert.fail("expected launch rollback rejection");
  }
  assert.equal(launched.error.code, "LAUNCH_ROLLBACK_FAILED");
  assert.match(launched.error.message, /WM_INTENT_FAILED/);
  assert.match(launched.error.message, /RUNTIME_STOP_FAILED/);
  assert.equal(mounts.length, 1);
  assert.deepEqual(unmounts.map((binding) => binding.bindingId), ["tsx:com.vita.notes.component"]);
  assert.equal(created.length, 1);
  assert.deepEqual(removed, [appSurfaceId(app.id)]);
  assert.equal(host.snapshot().apps.length, 0);
  assert.equal(host.snapshot().windowModel.windows.length, 0);

  const duplicateLaunch = host.launch(app);

  assert.equal(duplicateLaunch.ok, false);
  if (duplicateLaunch.ok) {
    assert.fail("expected cleanup-pending launch rejection");
  }
  assert.equal(duplicateLaunch.error.code, "APP_LAUNCH_CLEANUP_PENDING");
  assert.equal(mounts.length, 1);

  failUnmount = false;
  failWm = false;
  wmCalls.length = 0;

  const cleanupStop = host.stop(app);

  assert.equal(cleanupStop.ok, true);
  assert.deepEqual(unmounts.map((binding) => binding.bindingId), [
    "tsx:com.vita.notes.component",
    "tsx:com.vita.notes.component",
  ]);
  assert.deepEqual(removed, [appSurfaceId(app.id)]);
  assert.equal(host.snapshot().apps.length, 0);
  assert.equal(host.snapshot().windowModel.windows.length, 0);
});

test("failed launch records rollback surface removal failure for retry without remounting runtime", () => {
  const created: ShellSurfaceCreateRequest[] = [];
  const removed: string[] = [];
  const removeAttempts: string[] = [];
  const wmCalls: WindowManagerIntent[] = [];
  const mounts: TsxRenderRequest[] = [];
  const unmounts: TsxRenderBinding[] = [];
  let failRemove = true;
  let failWm = true;
  const app = tsxApp();
  const host = new AppHost({
    initialWindowModel: createWindowModel({
      activeWorkspaceId: "main",
    }),
    layoutConstraints: {
      bounds: SCREEN,
    },
    ports: {
      shell: fakeShellWithRemoveFailure(created, removed, removeAttempts, () => failRemove),
      tsx: fakeTsxPort(mounts, unmounts),
      wm: conditionalThrowingWm(wmCalls, () => failWm),
    },
  });

  const launched = host.launch(app);

  assert.equal(launched.ok, false);
  if (launched.ok) {
    assert.fail("expected launch rollback rejection");
  }
  assert.equal(launched.error.code, "LAUNCH_ROLLBACK_FAILED");
  assert.match(launched.error.message, /WM_INTENT_FAILED/);
  assert.match(launched.error.message, /SHELL_SURFACE_REMOVE_FAILED/);
  assert.equal(mounts.length, 1);
  assert.deepEqual(unmounts.map((binding) => binding.bindingId), ["tsx:com.vita.notes.component"]);
  assert.equal(created.length, 1);
  assert.deepEqual(removeAttempts, [appSurfaceId(app.id)]);
  assert.deepEqual(removed, []);
  assert.equal(host.snapshot().apps.length, 0);
  assert.equal(host.snapshot().windowModel.windows.length, 0);

  const duplicateLaunch = host.launch(app);

  assert.equal(duplicateLaunch.ok, false);
  if (duplicateLaunch.ok) {
    assert.fail("expected cleanup-pending launch rejection");
  }
  assert.equal(duplicateLaunch.error.code, "APP_LAUNCH_CLEANUP_PENDING");

  failRemove = false;
  failWm = false;
  wmCalls.length = 0;

  const cleanupStop = host.stop(app);

  assert.equal(cleanupStop.ok, true);
  assert.deepEqual(removeAttempts, [appSurfaceId(app.id), appSurfaceId(app.id)]);
  assert.deepEqual(removed, [appSurfaceId(app.id)]);
  assert.deepEqual(unmounts.map((binding) => binding.bindingId), ["tsx:com.vita.notes.component"]);
  assert.equal(host.snapshot().apps.length, 0);
  assert.equal(host.snapshot().windowModel.windows.length, 0);
});

test("createSurface throw after registration is removed or tracked for pending cleanup", () => {
  const created: ShellSurfaceCreateRequest[] = [];
  const removed: string[] = [];
  const removeAttempts: string[] = [];
  const wmCalls: WindowManagerIntent[] = [];
  const mounts: TsxRenderRequest[] = [];
  const unmounts: TsxRenderBinding[] = [];
  let failRemove = true;
  const app = tsxApp();
  const host = new AppHost({
    layoutConstraints: {
      bounds: SCREEN,
    },
    ports: {
      shell: fakeShellWithCreateSideEffectThrow(
        created,
        removed,
        removeAttempts,
        () => failRemove,
      ),
      tsx: fakeTsxPort(mounts, unmounts),
      wm: fakeWm(wmCalls),
    },
  });

  const launched = host.launch(app);

  assert.equal(launched.ok, false);
  if (launched.ok) {
    assert.fail("expected createSurface rollback rejection");
  }
  assert.equal(launched.error.code, "LAUNCH_ROLLBACK_FAILED");
  assert.match(launched.error.message, /SHELL_SURFACE_CREATE_FAILED/);
  assert.match(launched.error.message, /SHELL_SURFACE_REMOVE_FAILED/);
  assert.equal(created.length, 1);
  assert.deepEqual(removeAttempts, [appSurfaceId(app.id)]);
  assert.deepEqual(removed, []);
  assert.deepEqual(unmounts.map((binding) => binding.bindingId), ["tsx:com.vita.notes.component"]);
  assert.equal(wmCalls.length, 0);
  assert.equal(host.snapshot().apps.length, 0);
  assert.equal(host.snapshot().windowModel.windows.length, 0);

  const duplicateLaunch = host.launch(app);

  assert.equal(duplicateLaunch.ok, false);
  if (duplicateLaunch.ok) {
    assert.fail("expected cleanup-pending launch rejection");
  }
  assert.equal(duplicateLaunch.error.code, "APP_LAUNCH_CLEANUP_PENDING");
  assert.equal(mounts.length, 1);

  failRemove = false;

  const cleanupStop = host.stop(app);

  assert.equal(cleanupStop.ok, true);
  assert.deepEqual(removeAttempts, [appSurfaceId(app.id), appSurfaceId(app.id)]);
  assert.deepEqual(removed, [appSurfaceId(app.id)]);
  assert.deepEqual(unmounts.map((binding) => binding.bindingId), ["tsx:com.vita.notes.component"]);
  assert.equal(host.snapshot().apps.length, 0);
  assert.equal(host.snapshot().windowModel.windows.length, 0);
});

test("stop records pending cleanup when WM close intents fail before advancing the window model", () => {
  const created: ShellSurfaceCreateRequest[] = [];
  const removed: string[] = [];
  const wmCalls: WindowManagerIntent[] = [];
  const mounts: TsxRenderRequest[] = [];
  const unmounts: TsxRenderBinding[] = [];
  let failWm = false;
  const app = tsxApp();
  const host = new AppHost({
    initialWindowModel: createWindowModel({
      activeWorkspaceId: "main",
    }),
    layoutConstraints: {
      bounds: SCREEN,
    },
    ports: {
      shell: fakeShell(created, removed),
      tsx: fakeTsxPort(mounts, unmounts),
      wm: conditionalThrowingWm(wmCalls, () => failWm),
    },
  });

  const launched = host.launch(app);

  assert.equal(launched.ok, true);
  wmCalls.length = 0;
  failWm = true;

  const failedStop = host.stop(app);

  assert.equal(failedStop.ok, false);
  if (failedStop.ok) {
    assert.fail("expected WM close intent rejection");
  }
  assert.equal(failedStop.error.code, "WM_INTENT_FAILED");
  assert.deepEqual(removed, [appSurfaceId(app.id)]);
  assert.deepEqual(unmounts.map((binding) => binding.bindingId), ["tsx:com.vita.notes.component"]);
  assert.deepEqual(wmCalls.map((call) => call.type), ["setTextureVisibility"]);
  assert.equal(host.snapshot().apps.length, 0);
  assert.equal(host.snapshot().windowModel.windows.length, 1);

  const duplicateLaunch = host.launch(app);

  assert.equal(duplicateLaunch.ok, false);
  if (duplicateLaunch.ok) {
    assert.fail("expected cleanup-pending launch rejection");
  }
  assert.equal(duplicateLaunch.error.code, "APP_LAUNCH_CLEANUP_PENDING");

  failWm = false;
  wmCalls.length = 0;

  const retryStop = host.stop(app);

  assert.equal(retryStop.ok, true);
  assert.deepEqual(removed, [appSurfaceId(app.id)]);
  assert.deepEqual(unmounts.map((binding) => binding.bindingId), ["tsx:com.vita.notes.component"]);
  assert.deepEqual(wmCalls.map((call) => call.type), [
    "setTextureVisibility",
    "setFocus",
  ]);
  assert.equal(host.snapshot().apps.length, 0);
  assert.equal(host.snapshot().windowModel.windows.length, 0);
});

test("pending cleanup retry keeps the window model open when WM close intents fail again", () => {
  const created: ShellSurfaceCreateRequest[] = [];
  const removed: string[] = [];
  const wmCalls: WindowManagerIntent[] = [];
  const mounts: TsxRenderRequest[] = [];
  const unmounts: TsxRenderBinding[] = [];
  let failWm = false;
  const app = tsxApp();
  const host = new AppHost({
    initialWindowModel: createWindowModel({
      activeWorkspaceId: "main",
    }),
    layoutConstraints: {
      bounds: SCREEN,
    },
    ports: {
      shell: fakeShell(created, removed),
      tsx: fakeTsxPort(mounts, unmounts),
      wm: conditionalThrowingWm(wmCalls, () => failWm),
    },
  });

  assert.equal(host.launch(app).ok, true);
  wmCalls.length = 0;
  failWm = true;

  const failedStop = host.stop(app);

  assert.equal(failedStop.ok, false);
  assert.equal(host.snapshot().apps.length, 0);
  assert.equal(host.snapshot().windowModel.windows.length, 1);
  wmCalls.length = 0;

  const failedRetry = host.stop(app);

  assert.equal(failedRetry.ok, false);
  if (failedRetry.ok) {
    assert.fail("expected pending cleanup WM retry rejection");
  }
  assert.equal(failedRetry.error.code, "WM_INTENT_FAILED");
  assert.deepEqual(removed, [appSurfaceId(app.id)]);
  assert.deepEqual(unmounts.map((binding) => binding.bindingId), ["tsx:com.vita.notes.component"]);
  assert.deepEqual(wmCalls.map((call) => call.type), ["setTextureVisibility"]);
  assert.equal(host.snapshot().apps.length, 0);
  assert.equal(host.snapshot().windowModel.windows.length, 1);

  const duplicateLaunch = host.launch(app);

  assert.equal(duplicateLaunch.ok, false);
  if (duplicateLaunch.ok) {
    assert.fail("expected cleanup-pending launch rejection after failed retry");
  }
  assert.equal(duplicateLaunch.error.code, "APP_LAUNCH_CLEANUP_PENDING");

  failWm = false;
  wmCalls.length = 0;

  const cleanupStop = host.stop(app);

  assert.equal(cleanupStop.ok, true);
  assert.deepEqual(removed, [appSurfaceId(app.id)]);
  assert.deepEqual(unmounts.map((binding) => binding.bindingId), ["tsx:com.vita.notes.component"]);
  assert.deepEqual(wmCalls.map((call) => call.type), [
    "setTextureVisibility",
    "setFocus",
  ]);
  assert.equal(host.snapshot().apps.length, 0);
  assert.equal(host.snapshot().windowModel.windows.length, 0);
});

test("pending cleanup blocks unrelated launch and stop until retry clears it", () => {
  const created: ShellSurfaceCreateRequest[] = [];
  const removed: string[] = [];
  const wmCalls: WindowManagerIntent[] = [];
  const mounts: TsxRenderRequest[] = [];
  const unmounts: TsxRenderBinding[] = [];
  let failWm = false;
  const first = tiledTsxApp("com.vita.pending-one", "com.vita.pending-one.component");
  const second = tiledTsxApp("com.vita.pending-two", "com.vita.pending-two.component");
  const third = tiledTsxApp("com.vita.pending-three", "com.vita.pending-three.component");
  const host = new AppHost({
    initialWindowModel: createWindowModel({
      activeWorkspaceId: "main",
    }),
    layoutConstraints: {
      bounds: SCREEN,
    },
    ports: {
      shell: fakeShell(created, removed),
      tsx: fakeTsxPort(mounts, unmounts),
      wm: conditionalThrowingWm(wmCalls, () => failWm),
    },
  });

  assertLaunchSucceeded(host.launch(first), "expected first app launch to succeed");
  assertLaunchSucceeded(host.launch(second), "expected second app launch to succeed");
  wmCalls.length = 0;
  failWm = true;

  const failedStop = host.stop(second);

  assert.equal(failedStop.ok, false);
  if (failedStop.ok) {
    assert.fail("expected stop to leave pending cleanup");
  }
  assert.equal(failedStop.error.code, "WM_INTENT_FAILED");
  assert.deepEqual(removed, [appSurfaceId(second.id)]);
  assert.deepEqual(unmounts.map((binding) => binding.bindingId), [
    "tsx:com.vita.pending-two.component",
  ]);
  assert.equal(host.snapshot().apps.length, 1);
  assert.equal(host.snapshot().windowModel.windows.length, 2);

  const createdAfterPending = created.length;
  const removedAfterPending = removed.length;
  const mountsAfterPending = mounts.length;
  const unmountsAfterPending = unmounts.length;
  const wmCallsAfterPending = wmCalls.length;

  const blockedLaunch = host.launch(third);

  assert.equal(blockedLaunch.ok, false);
  if (blockedLaunch.ok) {
    assert.fail("expected unrelated launch to be blocked by pending cleanup");
  }
  assert.equal(blockedLaunch.error.code, "APP_LAUNCH_CLEANUP_PENDING");
  assert.equal(created.length, createdAfterPending);
  assert.equal(mounts.length, mountsAfterPending);
  assert.equal(wmCalls.length, wmCallsAfterPending);

  const blockedStop = host.stop(first);

  assert.equal(blockedStop.ok, false);
  if (blockedStop.ok) {
    assert.fail("expected unrelated stop to be blocked by pending cleanup");
  }
  assert.equal(blockedStop.error.code, "APP_STOP_CLEANUP_PENDING");
  assert.equal(removed.length, removedAfterPending);
  assert.equal(unmounts.length, unmountsAfterPending);
  assert.equal(wmCalls.length, wmCallsAfterPending);
  assert.equal(host.snapshot().apps.length, 1);
  assert.equal(host.snapshot().windowModel.windows.length, 2);

  failWm = false;
  wmCalls.length = 0;

  const cleanupStop = host.stop(second);

  assert.equal(cleanupStop.ok, true);
  assert.equal(host.snapshot().apps.length, 1);
  assert.equal(host.snapshot().windowModel.windows.length, 1);

  assertLaunchSucceeded(host.launch(third), "expected launch to resume after cleanup");
  assert.equal(created.length, createdAfterPending + 1);
  assert.equal(mounts.length, mountsAfterPending + 1);

  const stopFirst = host.stop(first);

  assert.equal(stopFirst.ok, true);
  assert.deepEqual(removed, [
    appSurfaceId(second.id),
    appSurfaceId(first.id),
  ]);
  assert.deepEqual(unmounts.map((binding) => binding.bindingId), [
    "tsx:com.vita.pending-two.component",
    "tsx:com.vita.pending-one.component",
  ]);
});

const WM_FAILURE_POSITIONS = Object.freeze([
  Object.freeze({
    index: 0,
    name: "first",
  }),
  Object.freeze({
    index: 1,
    name: "middle",
  }),
  Object.freeze({
    index: 2,
    name: "last",
  }),
] satisfies readonly {
  readonly index: number;
  readonly name: string;
}[]);

for (const position of WM_FAILURE_POSITIONS) {
  test(`launch rollback remains retryable when launch WM emit fails at the ${position.name} intent`, () => {
    const created: ShellSurfaceCreateRequest[] = [];
    const removed: string[] = [];
    const wmCalls: WindowManagerIntent[] = [];
    const mounts: TsxRenderRequest[] = [];
    const unmounts: TsxRenderBinding[] = [];
    const wmState: IndexedWmFailureState = {
      callIndex: 0,
      failAt: new Set<number>(),
    };
    const app = tsxApp();
    const host = new AppHost({
      initialWindowModel: createWindowModel({
        activeWorkspaceId: "main",
      }),
      layoutConstraints: {
        bounds: SCREEN,
      },
      ports: {
        shell: fakeShell(created, removed),
        tsx: fakeTsxPort(mounts, unmounts),
        wm: indexedThrowingWm(wmCalls, wmState),
      },
    });
    wmState.failAt = new Set([position.index, position.index + 1]);

    const failedLaunch = host.launch(app);

    assert.equal(failedLaunch.ok, false);
    if (failedLaunch.ok) {
      assert.fail("expected launch rollback rejection");
    }
    assert.equal(failedLaunch.error.code, "LAUNCH_ROLLBACK_FAILED");
    assert.match(failedLaunch.error.message, /WM_INTENT_FAILED/);
    assert.deepEqual(removed, [appSurfaceId(app.id)]);
    assert.deepEqual(unmounts.map((binding) => binding.bindingId), [
      "tsx:com.vita.notes.component",
    ]);
    assert.equal(host.snapshot().apps.length, 0);
    assert.equal(host.snapshot().windowModel.windows.length, 0);

    const duplicateLaunch = host.launch(app);

    assert.equal(duplicateLaunch.ok, false);
    if (duplicateLaunch.ok) {
      assert.fail("expected cleanup-pending launch rejection");
    }
    assert.equal(duplicateLaunch.error.code, "APP_LAUNCH_CLEANUP_PENDING");

    wmCalls.length = 0;
    wmState.callIndex = 0;
    wmState.failAt = new Set<number>();

    const cleanupStop = host.stop(app);

    assert.equal(cleanupStop.ok, true);
    assert.deepEqual(wmCalls.map((call) => call.type), singleWindowCloseIntentTypes());
    assert.equal(host.snapshot().apps.length, 0);
    assert.equal(host.snapshot().windowModel.windows.length, 0);
  });

  test(`launch rollback remains retryable when WM rollback close fails at the ${position.name} intent`, () => {
    const created: ShellSurfaceCreateRequest[] = [];
    const removed: string[] = [];
    const wmCalls: WindowManagerIntent[] = [];
    const mounts: TsxRenderRequest[] = [];
    const unmounts: TsxRenderBinding[] = [];
    const wmState: IndexedWmFailureState = {
      callIndex: 0,
      failAt: new Set<number>(),
    };
    const first = tiledTsxApp("com.vita.tiled-one", "com.vita.tiled-one.component");
    const second = tiledTsxApp("com.vita.tiled-two", "com.vita.tiled-two.component");
    const host = new AppHost({
      initialWindowModel: createWindowModel({
        activeWorkspaceId: "main",
      }),
      layoutConstraints: {
        bounds: SCREEN,
      },
      ports: {
        shell: fakeShell(created, removed),
        tsx: fakeTsxPort(mounts, unmounts),
        wm: indexedThrowingWm(wmCalls, wmState),
      },
    });

    assertLaunchSucceeded(host.launch(first), "expected first tiled app launch to succeed");
    wmCalls.length = 0;
    wmState.callIndex = 0;
    wmState.failAt = new Set([0, 1 + position.index]);

    const failedLaunch = host.launch(second);

    assert.equal(failedLaunch.ok, false);
    if (failedLaunch.ok) {
      assert.fail("expected second tiled app launch rollback rejection");
    }
    assert.equal(failedLaunch.error.code, "LAUNCH_ROLLBACK_FAILED");
    assert.match(failedLaunch.error.message, /WM_INTENT_FAILED/);
    assert.equal(host.snapshot().apps.length, 1);
    assert.equal(host.snapshot().windowModel.windows.length, 1);
    assert.deepEqual(removed, [appSurfaceId(second.id)]);
    assert.deepEqual(unmounts.map((binding) => binding.bindingId), [
      "tsx:com.vita.tiled-two.component",
    ]);

    const duplicateLaunch = host.launch(second);

    assert.equal(duplicateLaunch.ok, false);
    if (duplicateLaunch.ok) {
      assert.fail("expected cleanup-pending launch rejection");
    }
    assert.equal(duplicateLaunch.error.code, "APP_LAUNCH_CLEANUP_PENDING");

    wmCalls.length = 0;
    wmState.callIndex = 0;
    wmState.failAt = new Set<number>();

    const cleanupStop = host.stop(second);

    assert.equal(cleanupStop.ok, true);
    assert.deepEqual(wmCalls.map((call) => call.type), tiledSecondCloseIntentTypes());
    assert.equal(host.snapshot().apps.length, 1);
    assert.equal(host.snapshot().windowModel.windows.length, 1);
  });

  test(`stop keeps pending cleanup when WM close fails at the ${position.name} intent`, () => {
    const created: ShellSurfaceCreateRequest[] = [];
    const removed: string[] = [];
    const wmCalls: WindowManagerIntent[] = [];
    const mounts: TsxRenderRequest[] = [];
    const unmounts: TsxRenderBinding[] = [];
    const wmState: IndexedWmFailureState = {
      callIndex: 0,
      failAt: new Set<number>(),
    };
    const first = tiledTsxApp("com.vita.stop-one", "com.vita.stop-one.component");
    const second = tiledTsxApp("com.vita.stop-two", "com.vita.stop-two.component");
    const host = new AppHost({
      initialWindowModel: createWindowModel({
        activeWorkspaceId: "main",
      }),
      layoutConstraints: {
        bounds: SCREEN,
      },
      ports: {
        shell: fakeShell(created, removed),
        tsx: fakeTsxPort(mounts, unmounts),
        wm: indexedThrowingWm(wmCalls, wmState),
      },
    });

    assertLaunchSucceeded(host.launch(first), "expected first tiled app launch to succeed");
    assertLaunchSucceeded(host.launch(second), "expected second tiled app launch to succeed");
    wmCalls.length = 0;
    wmState.callIndex = 0;
    wmState.failAt = new Set([position.index]);

    const failedStop = host.stop(second);

    assert.equal(failedStop.ok, false);
    if (failedStop.ok) {
      assert.fail("expected WM close rejection");
    }
    assert.equal(failedStop.error.code, "WM_INTENT_FAILED");
    assert.deepEqual(
      wmCalls.map((call) => call.type),
      tiledSecondCloseIntentTypes().slice(0, position.index + 1),
    );
    assert.deepEqual(removed, [appSurfaceId(second.id)]);
    assert.deepEqual(unmounts.map((binding) => binding.bindingId), [
      "tsx:com.vita.stop-two.component",
    ]);
    assert.equal(host.snapshot().apps.length, 1);
    assert.equal(host.snapshot().windowModel.windows.length, 2);

    const duplicateLaunch = host.launch(second);

    assert.equal(duplicateLaunch.ok, false);
    if (duplicateLaunch.ok) {
      assert.fail("expected cleanup-pending launch rejection");
    }
    assert.equal(duplicateLaunch.error.code, "APP_LAUNCH_CLEANUP_PENDING");

    wmCalls.length = 0;
    wmState.callIndex = 0;
    wmState.failAt = new Set<number>();

    const retryStop = host.stop(second);

    assert.equal(retryStop.ok, true);
    assert.deepEqual(wmCalls.map((call) => call.type), tiledSecondCloseIntentTypes());
    assert.equal(host.snapshot().apps.length, 1);
    assert.equal(host.snapshot().windowModel.windows.length, 1);
  });

  test(`pending cleanup retry remains pending when WM close fails at the ${position.name} intent`, () => {
    const created: ShellSurfaceCreateRequest[] = [];
    const removed: string[] = [];
    const wmCalls: WindowManagerIntent[] = [];
    const mounts: TsxRenderRequest[] = [];
    const unmounts: TsxRenderBinding[] = [];
    const wmState: IndexedWmFailureState = {
      callIndex: 0,
      failAt: new Set<number>(),
    };
    const first = tiledTsxApp("com.vita.retry-one", "com.vita.retry-one.component");
    const second = tiledTsxApp("com.vita.retry-two", "com.vita.retry-two.component");
    const host = new AppHost({
      initialWindowModel: createWindowModel({
        activeWorkspaceId: "main",
      }),
      layoutConstraints: {
        bounds: SCREEN,
      },
      ports: {
        shell: fakeShell(created, removed),
        tsx: fakeTsxPort(mounts, unmounts),
        wm: indexedThrowingWm(wmCalls, wmState),
      },
    });

    assertLaunchSucceeded(host.launch(first), "expected first tiled app launch to succeed");
    assertLaunchSucceeded(host.launch(second), "expected second tiled app launch to succeed");
    wmCalls.length = 0;
    wmState.callIndex = 0;
    wmState.failAt = new Set([0]);

    const failedStop = host.stop(second);

    assert.equal(failedStop.ok, false);
    assert.equal(host.snapshot().apps.length, 1);
    assert.equal(host.snapshot().windowModel.windows.length, 2);
    wmCalls.length = 0;
    wmState.callIndex = 0;
    wmState.failAt = new Set([position.index]);

    const failedRetry = host.stop(second);

    assert.equal(failedRetry.ok, false);
    if (failedRetry.ok) {
      assert.fail("expected pending cleanup WM retry rejection");
    }
    assert.equal(failedRetry.error.code, "WM_INTENT_FAILED");
    assert.deepEqual(
      wmCalls.map((call) => call.type),
      tiledSecondCloseIntentTypes().slice(0, position.index + 1),
    );
    assert.deepEqual(removed, [appSurfaceId(second.id)]);
    assert.deepEqual(unmounts.map((binding) => binding.bindingId), [
      "tsx:com.vita.retry-two.component",
    ]);
    assert.equal(host.snapshot().apps.length, 1);
    assert.equal(host.snapshot().windowModel.windows.length, 2);

    const duplicateLaunch = host.launch(second);

    assert.equal(duplicateLaunch.ok, false);
    if (duplicateLaunch.ok) {
      assert.fail("expected cleanup-pending launch rejection after failed retry");
    }
    assert.equal(duplicateLaunch.error.code, "APP_LAUNCH_CLEANUP_PENDING");

    wmCalls.length = 0;
    wmState.callIndex = 0;
    wmState.failAt = new Set<number>();

    const cleanupStop = host.stop(second);

    assert.equal(cleanupStop.ok, true);
    assert.deepEqual(wmCalls.map((call) => call.type), tiledSecondCloseIntentTypes());
    assert.equal(host.snapshot().apps.length, 1);
    assert.equal(host.snapshot().windowModel.windows.length, 1);
  });
}

test("app surface ids escape underscores injectively", () => {
  assert.notEqual(appSurfaceId("/"), appSurfaceId("_002f"));
  assert.equal(appSurfaceId("_002f"), "surface:vita.app:_005f002f");
});

test("empty app id fails closed before allocating resources", () => {
  const created: ShellSurfaceCreateRequest[] = [];
  const removed: string[] = [];
  const wmCalls: WindowManagerIntent[] = [];
  const mounts: TsxRenderRequest[] = [];
  const unmounts: TsxRenderBinding[] = [];
  const app = tiledTsxApp("", "com.vita.empty.component");
  const host = new AppHost({
    ports: {
      shell: fakeShell(created, removed),
      tsx: fakeTsxPort(mounts, unmounts),
      wm: fakeWm(wmCalls),
    },
  });

  const launched = host.launch(app);

  assert.equal(launched.ok, false);
  if (launched.ok) {
    assert.fail("expected empty app id launch to fail closed");
  }

  assert.equal(launched.error.code, "APP_ID_INVALID");
  assert.deepEqual(mounts, []);
  assert.deepEqual(created, []);
  assert.deepEqual(wmCalls, []);
  assert.deepEqual(unmounts, []);
  assert.deepEqual(removed, []);
  assert.equal(host.snapshot().apps.length, 0);
  assert.equal(host.snapshot().windowModel.windows.length, 0);
});

test("empty and app ids have distinct surface identities", () => {
  assert.equal(appSurfaceId(""), "surface:vita.app:");
  assert.notEqual(appSurfaceId(""), appSurfaceId("app"));
});

test("distinct representative app ids do not share surface identities", () => {
  const ids = Object.freeze([
    "",
    "app",
    "/",
    "_002f",
    "_",
    "_005f",
    "a_b",
    "a_005fb",
    "com.vita.notes",
  ]);
  const seen = new Set<string>();

  for (const id of ids) {
    const surfaceId = appSurfaceId(id);

    assert.equal(seen.has(surfaceId), false, `duplicate surface id for '${id}'`);
    seen.add(surfaceId);
  }

  assert.equal(seen.size, ids.length);
});

function tsxApp(): AppDescriptor {
  return Object.freeze({
    defaultWindow: {
      order: 10,
      rect: TSX_RECT,
      workspaceId: "main",
    },
    id: "com.vita.notes",
    runtime: {
      componentId: "com.vita.notes.component",
      props: {
        documentId: "welcome",
      },
    },
    surfaceKind: "tsx",
    title: "Notes",
  });
}

function wasmApp(): AppDescriptor {
  return Object.freeze({
    defaultWindow: {
      rect: {
        height: 500,
        width: 700,
        x: 40,
        y: 50,
      },
    },
    id: "com.vita.notes.wasm",
    runtime: {
      entrypoint: "main.wasm",
      id: "capsule.notes-wasm",
      integrity: "sha256-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
      ref: "capsule://local/notes-wasm",
      version: "1.0.0",
    },
    surfaceKind: "wasm",
    title: "Notes WASM",
  });
}

function containerApp(): AppDescriptor {
  return Object.freeze({
    defaultWindow: {
      rect: {
        height: 560,
        width: 820,
        x: 120,
        y: 90,
      },
    },
    id: "com.vita.editor",
    runtime: {
      entrypoint: "/app/start",
      id: "capsule.editor-oci",
      integrity: "sha256-BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB=",
      ref: "oci://local/editor",
      version: "2.0.0",
    },
    surfaceKind: "container",
    title: "Editor",
  });
}

function webApp(): AppDescriptor {
  return Object.freeze({
    defaultWindow: {
      rect: {
        height: 620,
        width: 920,
        x: 30,
        y: 36,
      },
    },
    id: "com.vita.webmail",
    runtime: {
      partition: "default",
      url: "https://app.example.test/",
    },
    surfaceKind: "web",
    title: "Webmail",
  });
}

function tiledTsxApp(id: string, componentId: string): AppDescriptor {
  return Object.freeze({
    defaultWindow: {
      mode: "tiled" as const,
      workspaceId: "main",
    },
    id,
    runtime: {
      componentId,
    },
    surfaceKind: "tsx",
    title: id,
  });
}

function tiledSecondCloseIntentTypes(): readonly WindowManagerIntent["type"][] {
  return Object.freeze([
    "setTextureVisibility",
    "repositionTexture",
    "setFocus",
  ]);
}

function singleWindowCloseIntentTypes(): readonly WindowManagerIntent["type"][] {
  return Object.freeze([
    "setTextureVisibility",
    "setFocus",
  ]);
}

function assertLaunchSucceeded(result: AppHostResult<unknown>, message: string): void {
  assert.equal(result.ok, true);

  if (!result.ok) {
    assert.fail(message);
  }
}

function fakeShell(
  created: ShellSurfaceCreateRequest[],
  removed: string[],
): ShellSubstratePort {
  return {
    createSurface(request) {
      created.push(request);
      return {
        kind: "fake-shell-surface",
        surfaceId: request.surfaceId,
      };
    },
    removeSurface(surfaceId) {
      removed.push(surfaceId);
      return {
        removed: true,
        surfaceId,
      };
    },
  };
}

function fakeShellWithRemoveFailure(
  created: ShellSurfaceCreateRequest[],
  removed: string[],
  removeAttempts: string[],
  shouldFailRemove: () => boolean,
): ShellSubstratePort {
  return {
    createSurface(request) {
      created.push(request);
      return {
        kind: "fake-shell-surface",
        surfaceId: request.surfaceId,
      };
    },
    removeSurface(surfaceId) {
      removeAttempts.push(surfaceId);

      if (shouldFailRemove()) {
        throw new Error("shell surface removal unavailable");
      }

      removed.push(surfaceId);
      return {
        removed: true,
        surfaceId,
      };
    },
  };
}

function fakeShellWithCreateSideEffectThrow(
  created: ShellSurfaceCreateRequest[],
  removed: string[],
  removeAttempts: string[],
  shouldFailRemove: () => boolean,
): ShellSubstratePort {
  return {
    createSurface(request) {
      created.push(request);
      throw new Error("shell surface create registered before failure");
    },
    removeSurface(surfaceId) {
      removeAttempts.push(surfaceId);

      if (shouldFailRemove()) {
        throw new Error("shell surface removal unavailable");
      }

      removed.push(surfaceId);
      return {
        removed: true,
        surfaceId,
      };
    },
  };
}

function fakeWm(calls: WindowManagerIntent[]): WindowManagerSubstratePort {
  return {
    repositionTexture(textureId, rect, windowId): void {
      calls.push(Object.freeze({
        rect,
        textureId,
        type: "repositionTexture",
        windowId,
      }));
    },
    setFocus(windowId): void {
      calls.push(Object.freeze({
        type: "setFocus",
        windowId,
      }));
    },
    setTextureVisibility(textureId, visible, windowId): void {
      calls.push(Object.freeze({
        textureId,
        type: "setTextureVisibility",
        visible,
        windowId,
      }));
    },
  };
}

function throwingWm(calls: WindowManagerIntent[]): WindowManagerSubstratePort {
  return {
    repositionTexture(textureId, rect, windowId): void {
      calls.push(Object.freeze({
        rect,
        textureId,
        type: "repositionTexture",
        windowId,
      }));
      throw new Error("WM unavailable");
    },
    setFocus(windowId): void {
      calls.push(Object.freeze({
        type: "setFocus",
        windowId,
      }));
      throw new Error("WM unavailable");
    },
    setTextureVisibility(textureId, visible, windowId): void {
      calls.push(Object.freeze({
        textureId,
        type: "setTextureVisibility",
        visible,
        windowId,
      }));
      throw new Error("WM unavailable");
    },
  };
}

function conditionalThrowingWm(
  calls: WindowManagerIntent[],
  shouldThrow: () => boolean,
): WindowManagerSubstratePort {
  return {
    repositionTexture(textureId, rect, windowId): void {
      calls.push(Object.freeze({
        rect,
        textureId,
        type: "repositionTexture",
        windowId,
      }));

      if (shouldThrow()) {
        throw new Error("WM unavailable");
      }
    },
    setFocus(windowId): void {
      calls.push(Object.freeze({
        type: "setFocus",
        windowId,
      }));

      if (shouldThrow()) {
        throw new Error("WM unavailable");
      }
    },
    setTextureVisibility(textureId, visible, windowId): void {
      calls.push(Object.freeze({
        textureId,
        type: "setTextureVisibility",
        visible,
        windowId,
      }));

      if (shouldThrow()) {
        throw new Error("WM unavailable");
      }
    },
  };
}

interface IndexedWmFailureState {
  callIndex: number;
  failAt: ReadonlySet<number>;
}

function indexedThrowingWm(
  calls: WindowManagerIntent[],
  state: IndexedWmFailureState,
): WindowManagerSubstratePort {
  function record(intent: WindowManagerIntent): void {
    const callIndex = state.callIndex;
    state.callIndex += 1;
    calls.push(intent);

    if (state.failAt.has(callIndex)) {
      throw new Error("WM unavailable");
    }
  }

  return {
    repositionTexture(textureId, rect, windowId): void {
      record(Object.freeze({
        rect,
        textureId,
        type: "repositionTexture",
        windowId,
      }));
    },
    setFocus(windowId): void {
      record(Object.freeze({
        type: "setFocus",
        windowId,
      }));
    },
    setTextureVisibility(textureId, visible, windowId): void {
      record(Object.freeze({
        textureId,
        type: "setTextureVisibility",
        visible,
        windowId,
      }));
    },
  };
}

function fakeTsxPort(
  mounts: TsxRenderRequest[],
  unmounts: TsxRenderBinding[],
): TsxRenderPort {
  return {
    mount(request) {
      mounts.push(request);
      return ok(Object.freeze({
        appId: request.appId,
        bindingId: `tsx:${request.runtime.componentId}`,
        componentId: request.runtime.componentId,
        runtimeId: request.runtime.componentId,
        surfaceId: request.surfaceId,
        surfaceKind: "tsx",
        windowId: request.windowId,
      }));
    },
    unmount(binding) {
      unmounts.push(binding);
      return ok(true);
    },
  };
}

function fakeTsxPortWithUnmountFailure(
  mounts: TsxRenderRequest[],
  unmounts: TsxRenderBinding[],
  shouldFailUnmount: () => boolean,
): TsxRenderPort {
  return {
    mount(request) {
      mounts.push(request);
      return ok(Object.freeze({
        appId: request.appId,
        bindingId: `tsx:${request.runtime.componentId}`,
        componentId: request.runtime.componentId,
        runtimeId: request.runtime.componentId,
        surfaceId: request.surfaceId,
        surfaceKind: "tsx",
        windowId: request.windowId,
      }));
    },
    unmount(binding) {
      unmounts.push(binding);

      if (shouldFailUnmount()) {
        return {
          error: {
            code: "RUNTIME_STOP_FAILED",
            message: "TSX runtime refused to stop.",
            path: "/runtime/tsx",
          },
          ok: false,
        };
      }

      return ok(true);
    },
  };
}

function fakeCapsulePort<Kind extends CapsuleAppSurfaceKind>(
  kind: Kind,
  launches: CapsuleRuntimeLaunchRequest<Kind>[],
  stops: CapsuleRuntimeBinding<Kind>[],
): CapsuleRuntimePort<Kind> {
  return {
    launch(request) {
      launches.push(request);
      return ok(Object.freeze({
        appId: request.appId,
        bindingId: `${kind}:${request.runtime.id}`,
        capsuleId: request.runtime.id,
        runtimeId: request.runtime.id,
        surfaceId: request.surfaceId,
        surfaceKind: kind,
        windowId: request.windowId,
      }));
    },
    stop(binding) {
      stops.push(binding);
      return ok(true);
    },
  };
}

function unavailableCapsulePort<Kind extends CapsuleAppSurfaceKind>(
  kind: Kind,
  launches: CapsuleRuntimeLaunchRequest<Kind>[],
  stops: CapsuleRuntimeBinding<Kind>[],
): CapsuleRuntimePort<Kind> {
  return {
    launch(request) {
      launches.push(request);
      return {
        error: {
          code: "RUNTIME_UNAVAILABLE",
          message: `${kind} runtime is offline.`,
          path: "/runtime",
        },
        ok: false,
      };
    },
    stop(binding) {
      stops.push(binding);
      return ok(true);
    },
  };
}

function fakeWebviewPort(
  opens: WebviewLaunchRequest[],
  closes: WebviewBinding[],
): WebviewPort {
  return {
    close(binding) {
      closes.push(binding);
      return ok(true);
    },
    open(request) {
      opens.push(request);
      return ok(Object.freeze({
        appId: request.appId,
        bindingId: `web:${request.runtime.url}`,
        runtimeId: request.runtime.url,
        surfaceId: request.surfaceId,
        surfaceKind: "web",
        url: request.runtime.url,
        windowId: request.windowId,
      }));
    },
  };
}

function ok<T>(value: T): AppHostResult<T> {
  return {
    ok: true,
    value,
  };
}
