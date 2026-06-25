import assert from "node:assert/strict";
import { test } from "node:test";

import {
  AppWindowHost,
} from "../../src/app-window-host/index.ts";
import type {
  AppWindowHostAppHostEventsPort,
  AppWindowHostAppHostPort,
  AppWindowHostCompositorDriverPort,
  AppWindowHostEventListener,
  AppWindowHostObservedEvent,
} from "../../src/app-window-host/index.ts";
import {
  appSurfaceId,
  appWindowId,
} from "../../src/appshell/index.ts";
import type {
  AppDescriptor,
  AppHostResult,
  AppHostSnapshot,
  AppLaunch,
  AppRuntimeBinding,
  AppStop,
} from "../../src/appshell/index.ts";
import {
  CompositorDriver,
} from "../../src/compositor-bridge/index.ts";
import type {
  CompositorCommand,
  CompositorPort,
  CompositorRect,
  CompositorReconcileInput,
  CompositorReconcileResult,
  CompositorSurfaceKind,
  CompositorSurfaceSnapshot,
  CompositorSurfaceSize,
} from "../../src/compositor-bridge/index.ts";
import type {
  ShellComposedLayout,
  ShellPlacement,
  ShellResolvedSurface,
  ShellSurfaceCreateRequest,
} from "../../src/shell/index.ts";
import {
  closeWindow,
  collectWindowManagerIntents,
  createWindowModel,
  openWindow,
} from "../../src/wm/policy.ts";
import type {
  LayoutConstraints,
  Rect,
  WindowManagerIntent,
  WindowModel,
  WindowOpenRequest,
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

const DEFAULT_APP_RECT = Object.freeze({
  height: 480,
  width: 720,
  x: 96,
  y: 72,
}) satisfies Rect;

test("launching an app registers and places a compositor window surface", async () => {
  const calls: CompositorCommand[] = [];
  const appHost = new FakeAppHost({
    bounds: SCREEN,
  });
  const compositor = new CompositorDriver(recordingPort(calls));
  const host = new AppWindowHost({
    appHost,
    compositor,
    layoutConstraints: {
      bounds: SCREEN,
    },
    shell: desktopShell(),
  });
  const app = tsxApp();

  const launched = await host.launch(app);

  assert.equal(launched.ok, true);
  if (!launched.ok) {
    assert.fail("expected app launch to reconcile");
  }

  assert.equal(launched.value.launch.app.surfaceKind, "tsx");
  assert.equal(launched.value.reconcile.windows[0]?.surfaceKind, "tsx");
  assert.equal(launched.value.reconcile.windows[0]?.textureId, appSurfaceId(app.id));
  assert.deepEqual(launched.value.reconcile.windows[0]?.placement.rect, TSX_RECT);
  assert.deepEqual(projectCommands(calls), [
    {
      id: "surface:desktop",
      kind: "shell:desktop",
      size: size(1_200, 900),
      type: "registerSurface",
    },
    {
      id: "surface:desktop",
      rect: rect(0, 0, 1_200, 900),
      type: "updatePlacement",
      visible: true,
      z: 10_000,
    },
    {
      id: appSurfaceId(app.id),
      kind: "window",
      size: size(TSX_RECT.width, TSX_RECT.height),
      type: "registerSurface",
    },
    {
      id: appSurfaceId(app.id),
      rect: TSX_RECT,
      type: "updatePlacement",
      visible: true,
      z: 20_000,
    },
    {
      type: "present",
    },
  ]);
  assert.equal(appHost.snapshot().apps.length, 1);
  assert.equal(host.snapshot().windows.length, 1);

  calls.length = 0;

  const idempotent = await host.reconcile();

  assert.equal(idempotent.ok, true);
  assert.deepEqual(calls, []);
});

test("stopping an app removes the compositor window surface", async () => {
  const calls: CompositorCommand[] = [];
  const appHost = new FakeAppHost({
    bounds: SCREEN,
  });
  const compositor = new CompositorDriver(recordingPort(calls));
  const host = new AppWindowHost({
    appHost,
    compositor,
    layoutConstraints: {
      bounds: SCREEN,
    },
    shell: desktopShell(),
  });
  const app = tsxApp();

  assert.equal((await host.launch(app)).ok, true);
  calls.length = 0;

  const stopped = await host.stop(app.id);

  assert.equal(stopped.ok, true);
  if (!stopped.ok) {
    assert.fail("expected app stop to reconcile");
  }
  assert.deepEqual(projectCommands(calls), [
    {
      id: appSurfaceId(app.id),
      type: "removeSurface",
    },
    {
      type: "present",
    },
  ]);
  assert.equal(appHost.snapshot().apps.length, 0);
  assert.equal(host.snapshot().windows.length, 0);
  assert.equal(host.snapshot().compositor.some((surface) => surface.id === appSurfaceId(app.id)), false);
});

test("surfaceKind metadata is carried for tsx, wasm, container, and web app windows", async () => {
  const appHost = new FakeAppHost({
    bounds: SCREEN,
  });
  const compositor = new RecordingCompositorDriver();
  const host = new AppWindowHost({
    appHost,
    compositor,
    layoutConstraints: {
      bounds: SCREEN,
    },
    shell: desktopShell(),
  });

  assert.equal((await host.launch(tsxApp())).ok, true);
  assert.equal((await host.launch(wasmApp())).ok, true);
  assert.equal((await host.launch(containerApp())).ok, true);
  assert.equal((await host.launch(webApp())).ok, true);

  assert.deepEqual(
    host.snapshot().windows.map((window) => window.surfaceKind).sort(),
    ["container", "tsx", "wasm", "web"],
  );
  assert.equal(compositor.inputs.length, 4);
  assert.equal(compositor.inputs[3]?.windows?.length, 4);
});

test("failed compositor window registration rolls back the app launch and records pending cleanup", async () => {
  const calls: CompositorCommand[] = [];
  const appHost = new FakeAppHost({
    bounds: SCREEN,
  });
  const compositor = new CompositorDriver(recordingPort(calls, {
    failWhen(command) {
      return (
        command.type === "registerSurface" &&
        command.id === appSurfaceId(tsxApp().id)
      );
    },
  }));
  const host = new AppWindowHost({
    appHost,
    compositor,
    layoutConstraints: {
      bounds: SCREEN,
    },
    shell: desktopShell(),
  });

  const launched = await host.launch(tsxApp());

  assert.equal(launched.ok, false);
  if (launched.ok) {
    assert.fail("expected compositor registration failure");
  }
  assert.equal(launched.error.code, "COMPOSITOR_RECONCILE_FAILED");
  assert.deepEqual(appHost.stops, ["com.vita.notes"]);
  assert.equal(appHost.snapshot().apps.length, 0);
  assert.equal(appHost.snapshot().windowModel.windows.length, 0);
  assert.equal(host.snapshot().windows.length, 0);
  assert.equal(host.snapshot().pendingCleanup[0]?.appId, "com.vita.notes");
  assert.equal(host.snapshot().pendingCleanup[0]?.textureId, appSurfaceId("com.vita.notes"));
  assert.equal(host.snapshot().pendingCleanup[0]?.reason.code, "APP_WINDOW_CLEANUP_PENDING");

  calls.length = 0;

  const blocked = await host.launch(tsxApp());

  assert.equal(blocked.ok, false);
  if (blocked.ok) {
    assert.fail("expected untracked cleanup to block relaunch");
  }
  assert.equal(blocked.error.code, "APP_WINDOW_CLEANUP_PENDING");
  assert.deepEqual(calls, []);
});

test("failed maybe-landed window registration uses injected cleanup before allowing retry", async () => {
  const calls: CompositorCommand[] = [];
  let failWindowRegister = true;
  const appHost = new FakeAppHost({
    bounds: SCREEN,
  });
  const compositor = new CleanupCapableCompositorDriver(recordingPort(calls, {
    failWhen(command) {
      return (
        failWindowRegister &&
        command.type === "registerSurface" &&
        command.id === appSurfaceId(tsxApp().id)
      );
    },
  }));
  const host = new AppWindowHost({
    appHost,
    compositor,
    layoutConstraints: {
      bounds: SCREEN,
    },
    shell: desktopShell(),
  });

  const launched = await host.launch(tsxApp());

  assert.equal(launched.ok, false);
  if (launched.ok) {
    assert.fail("expected compositor registration failure");
  }
  assert.deepEqual(compositor.removedSurfaces, [
    appSurfaceId("com.vita.notes"),
  ]);
  assert.equal(host.snapshot().pendingCleanup.length, 0);
  assert.equal(appHost.snapshot().apps.length, 0);

  calls.length = 0;
  failWindowRegister = false;

  const retried = await host.launch(tsxApp());

  assert.equal(retried.ok, true);
  assert.equal(host.snapshot().windows[0]?.surfaceKind, "tsx");
  assert.equal(
    calls.some((command) =>
      command.type === "registerSurface" &&
      command.id === appSurfaceId("com.vita.notes")
    ),
    true,
  );
});

test("thrown maybe-landed reconcile removes the compositor window during rollback", async () => {
  const appHost = new FakeAppHost({
    bounds: SCREEN,
  });
  const compositor = new ThrowingMaybeLandedCompositorDriver();
  const host = new AppWindowHost({
    appHost,
    compositor,
    layoutConstraints: {
      bounds: SCREEN,
    },
    shell: desktopShell(),
  });

  const launched = await host.launch(tsxApp());

  assert.equal(launched.ok, false);
  if (launched.ok) {
    assert.fail("expected thrown compositor reconcile");
  }
  assert.equal(launched.error.code, "COMPOSITOR_RECONCILE_FAILED");
  assert.deepEqual(compositor.removedSurfaces, [
    appSurfaceId("com.vita.notes"),
  ]);
  assert.equal(
    compositor.snapshot().some((surface) => surface.id === appSurfaceId("com.vita.notes")),
    false,
  );
  assert.equal(appHost.snapshot().apps.length, 0);
  assert.equal(host.snapshot().windows.length, 0);
  assert.equal(host.snapshot().pendingCleanup.length, 0);
});

test("partial thrown launch rollback leaves existing app window intact", async () => {
  const appHost = new FakeAppHost({
    bounds: SCREEN,
  });
  const compositor = new ThrowingMaybeLandedCompositorDriver({
    throwOnWindowReconcile: 2,
  });
  const host = new AppWindowHost({
    appHost,
    compositor,
    layoutConstraints: {
      bounds: SCREEN,
    },
    shell: desktopShell(),
  });
  const runningApp = tsxApp();
  const failedApp = webApp();

  const runningLaunch = await host.launch(runningApp);

  assert.equal(runningLaunch.ok, true);
  assert.equal(
    compositor.snapshot().some((surface) => surface.id === appSurfaceId(runningApp.id)),
    true,
  );

  const failedLaunch = await host.launch(failedApp);

  assert.equal(failedLaunch.ok, false);
  if (failedLaunch.ok) {
    assert.fail("expected thrown compositor reconcile");
  }
  assert.equal(failedLaunch.error.code, "COMPOSITOR_RECONCILE_FAILED");
  assert.deepEqual(compositor.removedSurfaces, [
    appSurfaceId(failedApp.id),
  ]);
  assert.equal(
    compositor.snapshot().some((surface) => surface.id === appSurfaceId(runningApp.id)),
    true,
  );
  assert.equal(
    compositor.snapshot().some((surface) => surface.id === appSurfaceId(failedApp.id)),
    false,
  );
  assert.deepEqual(appHost.snapshot().apps.map((launch) => launch.app.id), [
    runningApp.id,
  ]);
  assert.deepEqual(host.snapshot().windows.map((window) => window.appId), [
    runningApp.id,
  ]);
  assert.equal(host.snapshot().pendingCleanup.length, 0);
});

test("compositor teardown failure records pending cleanup and retries idempotently", async () => {
  const calls: CompositorCommand[] = [];
  let failWindowRemove = false;
  const appHost = new FakeAppHost({
    bounds: SCREEN,
  });
  const compositor = new CompositorDriver(recordingPort(calls, {
    failWhen(command) {
      return (
        failWindowRemove &&
        command.type === "removeSurface" &&
        command.id === appSurfaceId("com.vita.notes")
      );
    },
  }));
  const host = new AppWindowHost({
    appHost,
    compositor,
    layoutConstraints: {
      bounds: SCREEN,
    },
    shell: desktopShell(),
  });

  assert.equal((await host.launch(tsxApp())).ok, true);
  calls.length = 0;
  failWindowRemove = true;

  const stopped = await host.stop("com.vita.notes");

  assert.equal(stopped.ok, false);
  if (stopped.ok) {
    assert.fail("expected compositor remove failure");
  }
  assert.equal(stopped.error.code, "COMPOSITOR_RECONCILE_FAILED");
  assert.equal(appHost.snapshot().apps.length, 0);
  assert.equal(host.snapshot().pendingCleanup[0]?.appId, "com.vita.notes");
  assert.equal(host.snapshot().compositor.some((surface) => surface.id === appSurfaceId("com.vita.notes")), true);

  const blockedLaunch = await host.launch(webApp());

  assert.equal(blockedLaunch.ok, false);
  if (blockedLaunch.ok) {
    assert.fail("expected pending cleanup to block launches");
  }
  assert.equal(blockedLaunch.error.code, "APP_WINDOW_CLEANUP_PENDING");

  calls.length = 0;
  failWindowRemove = false;

  const cleaned = await host.reconcile();

  assert.equal(cleaned.ok, true);
  assert.deepEqual(projectCommands(calls), [
    {
      id: appSurfaceId("com.vita.notes"),
      type: "removeSurface",
    },
    {
      type: "present",
    },
  ]);
  assert.equal(host.snapshot().pendingCleanup.length, 0);

  const nextLaunch = await host.launch(webApp());

  assert.equal(nextLaunch.ok, true);
});

test("subscribed AppHost launch and stop events reconcile through the injected compositor port", async () => {
  const events = new FakeAppHostEvents();
  const appHost = new FakeAppHost({
    bounds: SCREEN,
    events,
  });
  const compositor = new RecordingCompositorDriver();
  const host = new AppWindowHost({
    appHost,
    appHostEvents: events,
    compositor,
    layoutConstraints: {
      bounds: SCREEN,
    },
    shell: desktopShell(),
  });
  const app = tsxApp();
  const launched = appHost.launch(app);

  assert.equal(launched.ok, true);
  if (!launched.ok) {
    assert.fail("expected fake app launch");
  }

  await events.drain();

  assert.equal(compositor.inputs.length, 1);
  assert.deepEqual(
    compositor.inputs[0]?.windowIntents?.map((intent) => intent.type),
    launched.value.intents.map((intent) => intent.type),
  );
  assert.equal(compositor.inputs[0]?.windows?.[0]?.textureId, appSurfaceId(app.id));

  const stopped = appHost.stop(app.id);

  assert.equal(stopped.ok, true);
  if (!stopped.ok) {
    assert.fail("expected fake app stop");
  }

  await events.drain();

  assert.equal(compositor.inputs.length, 2);
  assert.equal(compositor.inputs[1]?.windows?.length, 0);
  assert.deepEqual(
    compositor.inputs[1]?.windowIntents?.map((intent) => intent.type),
    stopped.value.intents.map((intent) => intent.type),
  );
  assert.equal(host.snapshot().windows.length, 0);
});

interface FakeAppHostOptions extends LayoutConstraints {
  readonly events?: FakeAppHostEvents;
}

class FakeAppHost implements AppWindowHostAppHostPort {
  readonly #constraints: LayoutConstraints;
  readonly #events: FakeAppHostEvents | undefined;
  readonly #launches = new Map<string, AppLaunch>();
  readonly stops: string[] = [];
  #windowModel: WindowModel;

  constructor(options: FakeAppHostOptions) {
    this.#constraints = options;
    this.#events = options.events;
    this.#windowModel = createWindowModel({
      activeWorkspaceId: "main",
    });
  }

  launch(app: AppDescriptor): AppHostResult<AppLaunch> {
    if (this.#launches.has(app.id)) {
      return appHostReject("APP_ALREADY_RUNNING", `app '${app.id}' is already running.`, `/apps/${app.id}`);
    }

    const surfaceId = appSurfaceId(app.id);
    const windowId = appWindowId(app.id);
    const previous = this.#windowModel;
    const next = openWindow(previous, windowOpenRequest(app, surfaceId, windowId));
    const intents = collectWindowManagerIntents(previous, next, this.#constraints);
    const launch = Object.freeze({
      app,
      binding: bindingForApp(app, surfaceId, windowId),
      intents,
      surfaceId,
      surfaceRequest: surfaceRequestForApp(app, surfaceId),
      textureId: surfaceId,
      windowId,
    }) satisfies AppLaunch;

    this.#windowModel = next;
    this.#launches.set(app.id, launch);
    this.#events?.emit(Object.freeze({
      launch,
      type: "launch",
    }));

    return ok(launch);
  }

  stop(app: AppDescriptor | string): AppHostResult<AppStop> {
    const appId = typeof app === "string" ? app : app.id;
    const launch = this.#launches.get(appId);

    if (launch === undefined) {
      return appHostReject("APP_NOT_RUNNING", `app '${appId}' is not running.`, `/apps/${appId}`);
    }

    this.stops.push(appId);

    const previous = this.#windowModel;
    const next = closeWindow(previous, launch.windowId);
    const intents = collectWindowManagerIntents(previous, next, this.#constraints);
    this.#windowModel = next;
    this.#launches.delete(appId);
    const stop = Object.freeze({
      appId,
      intents,
      surfaceId: launch.surfaceId,
      textureId: launch.textureId,
      windowId: launch.windowId,
    }) satisfies AppStop;

    this.#events?.emit(Object.freeze({
      stop,
      type: "stop",
    }));

    return ok(stop);
  }

  snapshot(): AppHostSnapshot {
    const apps = [...this.#launches.values()];
    apps.sort((left, right) => compareStrings(left.app.id, right.app.id));

    return Object.freeze({
      apps: Object.freeze(apps),
      windowModel: this.#windowModel,
    });
  }
}

class FakeAppHostEvents implements AppWindowHostAppHostEventsPort {
  readonly #listeners = new Set<AppWindowHostEventListener>();
  readonly #pending: Promise<AppWindowHostResultPlaceholder>[] = [];

  subscribe(listener: AppWindowHostEventListener): () => void {
    this.#listeners.add(listener);

    return () => {
      this.#listeners.delete(listener);
    };
  }

  emit(event: AppWindowHostObservedEvent): void {
    const listeners = [...this.#listeners];

    for (let index = 0; index < listeners.length; index += 1) {
      const listener = listeners[index];

      if (listener !== undefined) {
        this.#pending.push(Promise.resolve(listener(event)));
      }
    }
  }

  async drain(): Promise<void> {
    while (this.#pending.length > 0) {
      const pending = this.#pending.splice(0);
      await Promise.all(pending);
    }
  }
}

type AppWindowHostResultPlaceholder = Awaited<ReturnType<AppWindowHostEventListener>>;

class RecordingCompositorDriver implements AppWindowHostCompositorDriverPort {
  readonly inputs: CompositorReconcileInput[] = [];
  readonly state: readonly CompositorSurfaceSnapshot[] = Object.freeze([]);

  reconcile(input: CompositorReconcileInput): CompositorReconcileResult {
    this.inputs.push(input);

    return {
      commands: Object.freeze([]),
      ok: true,
      state: this.state,
    };
  }

  snapshot(): readonly CompositorSurfaceSnapshot[] {
    return this.state;
  }
}

class CleanupCapableCompositorDriver implements AppWindowHostCompositorDriverPort {
  readonly #driver: CompositorDriver;
  readonly removedSurfaces: string[] = [];

  constructor(port: CompositorPort) {
    this.#driver = new CompositorDriver(port);
  }

  reconcile(input: CompositorReconcileInput): Promise<CompositorReconcileResult> {
    return this.#driver.reconcile(input);
  }

  removeSurface(surfaceId: string): void {
    this.removedSurfaces.push(surfaceId);
  }

  snapshot(): readonly CompositorSurfaceSnapshot[] {
    return this.#driver.snapshot();
  }
}

class ThrowingMaybeLandedCompositorDriver implements AppWindowHostCompositorDriverPort {
  readonly #surfaces = new Map<string, CompositorSurfaceSnapshot>();
  readonly #throwOnWindowReconcile: number;
  readonly removedSurfaces: string[] = [];
  #windowReconcileCount = 0;

  constructor(options: {
    readonly throwOnWindowReconcile?: number;
  } = {}) {
    this.#throwOnWindowReconcile = options.throwOnWindowReconcile ?? 1;
  }

  reconcile(input: CompositorReconcileInput): CompositorReconcileResult {
    const windows = input.windows ?? Object.freeze([]);

    for (let index = 0; index < windows.length; index += 1) {
      const window = windows[index];

      if (window !== undefined) {
        this.#surfaces.set(window.textureId, Object.freeze({
          id: window.textureId,
          kind: "window",
          rect: window.rect,
          size: Object.freeze({
            height: window.rect.height,
            width: window.rect.width,
          }),
          visible: window.visible,
          z: window.zIndex,
        }));
      }
    }

    if (windows.length > 0) {
      this.#windowReconcileCount += 1;
    }

    if (
      windows.length > 0 &&
      this.#windowReconcileCount === this.#throwOnWindowReconcile
    ) {
      throw new Error("partial compositor register");
    }

    return {
      commands: Object.freeze([]),
      ok: true,
      state: this.snapshot(),
    };
  }

  removeSurface(surfaceId: string): void {
    this.removedSurfaces.push(surfaceId);
    this.#surfaces.delete(surfaceId);
  }

  snapshot(): readonly CompositorSurfaceSnapshot[] {
    return Object.freeze([...this.#surfaces.values()]);
  }
}

interface RecordingPortOptions {
  readonly failWhen?: (command: CompositorCommand) => boolean;
}

function recordingPort(
  calls: CompositorCommand[],
  options: RecordingPortOptions = {},
): CompositorPort {
  return {
    present(): void {
      const command = Object.freeze({
        type: "present" as const,
      });
      calls.push(command);
      maybeFail(options, command);
    },
    registerSurface(id, kind, surfaceSize): void {
      const command = Object.freeze({
        id,
        kind,
        size: surfaceSize,
        type: "registerSurface" as const,
      });
      calls.push(command);
      maybeFail(options, command);
    },
    removeSurface(id): void {
      const command = Object.freeze({
        id,
        type: "removeSurface" as const,
      });
      calls.push(command);
      maybeFail(options, command);
    },
    updatePlacement(id, placementRect, z, visible): void {
      const command = Object.freeze({
        id,
        rect: placementRect,
        type: "updatePlacement" as const,
        visible,
        z,
      });
      calls.push(command);
      maybeFail(options, command);
    },
  };
}

function maybeFail(options: RecordingPortOptions, command: CompositorCommand): void {
  if (options.failWhen?.(command) === true) {
    throw new Error(`configured compositor failure: ${command.type}`);
  }
}

function windowOpenRequest(
  app: AppDescriptor,
  surfaceId: string,
  windowId: string,
): WindowOpenRequest {
  const request: {
    id: string;
    textureId: string;
    rect: Rect;
    mode: "floating" | "tiled";
    workspaceId?: string;
  } = {
    id: windowId,
    mode: app.defaultWindow?.mode ?? "floating",
    rect: app.defaultWindow?.rect ?? DEFAULT_APP_RECT,
    textureId: surfaceId,
  };

  if (app.defaultWindow?.workspaceId !== undefined) {
    request.workspaceId = app.defaultWindow.workspaceId;
  }

  return Object.freeze(request);
}

function bindingForApp(
  app: AppDescriptor,
  surfaceId: string,
  windowId: string,
): AppRuntimeBinding {
  switch (app.surfaceKind) {
    case "tsx":
      return Object.freeze({
        appId: app.id,
        bindingId: `tsx:${app.runtime.componentId}`,
        componentId: app.runtime.componentId,
        runtimeId: app.runtime.componentId,
        surfaceId,
        surfaceKind: "tsx",
        windowId,
      });
    case "wasm":
      return Object.freeze({
        appId: app.id,
        bindingId: `wasm:${app.runtime.id}`,
        capsuleId: app.runtime.id,
        runtimeId: app.runtime.id,
        surfaceId,
        surfaceKind: "wasm",
        windowId,
      });
    case "container":
      return Object.freeze({
        appId: app.id,
        bindingId: `container:${app.runtime.id}`,
        capsuleId: app.runtime.id,
        runtimeId: app.runtime.id,
        surfaceId,
        surfaceKind: "container",
        windowId,
      });
    case "web":
      return Object.freeze({
        appId: app.id,
        bindingId: `web:${app.runtime.url}`,
        runtimeId: app.runtime.url,
        surfaceId,
        surfaceKind: "web",
        url: app.runtime.url,
        windowId,
      });
  }
}

function surfaceRequestForApp(
  app: AppDescriptor,
  surfaceId: string,
): ShellSurfaceCreateRequest {
  return Object.freeze({
    componentId: "fake.windowed-app",
    path: `apps.${app.id}`,
    payload: Object.freeze({
      appId: app.id,
      surfaceKind: app.surfaceKind,
      title: app.title,
      windowed: true,
    }),
    placement: shellPlacementForApp(app),
    role: "window",
    surfaceId,
  });
}

function shellPlacementForApp(app: AppDescriptor): ShellPlacement {
  const placement: {
    zone: string;
    layer: string;
    order: number;
    rect?: Rect;
    workspace?: string;
  } = {
    layer: app.defaultWindow?.layer ?? "desktop",
    order: app.defaultWindow?.order ?? 0,
    zone: app.defaultWindow?.zone ?? "center",
  };

  if (app.defaultWindow?.rect !== undefined) placement.rect = app.defaultWindow.rect;
  if (app.defaultWindow?.workspaceId !== undefined) placement.workspace = app.defaultWindow.workspaceId;

  return Object.freeze(placement);
}

function tsxApp(): AppDescriptor {
  return Object.freeze({
    defaultWindow: {
      rect: TSX_RECT,
      workspaceId: "main",
    },
    id: "com.vita.notes",
    runtime: {
      componentId: "com.vita.notes.component",
    },
    surfaceKind: "tsx",
    title: "Notes",
  });
}

function wasmApp(): AppDescriptor {
  return Object.freeze({
    defaultWindow: {
      rect: rect(120, 96, 640, 420),
      workspaceId: "main",
    },
    id: "com.vita.notes.wasm",
    runtime: {
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
      rect: rect(140, 120, 680, 440),
      workspaceId: "main",
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
      rect: rect(160, 144, 700, 460),
      workspaceId: "main",
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

type ProjectedCommand =
  | {
      readonly type: "registerSurface";
      readonly id: string;
      readonly kind: CompositorSurfaceKind;
      readonly size: CompositorSurfaceSize;
    }
  | {
      readonly type: "updatePlacement";
      readonly id: string;
      readonly rect: CompositorRect;
      readonly z: number;
      readonly visible: boolean;
    }
  | {
      readonly type: "removeSurface";
      readonly id: string;
    }
  | {
      readonly type: "present";
    };

function projectCommands(commands: readonly CompositorCommand[]): readonly ProjectedCommand[] {
  return commands.map((command) => {
    switch (command.type) {
      case "registerSurface":
        return {
          id: command.id,
          kind: command.kind,
          size: command.size,
          type: command.type,
        };
      case "updatePlacement":
        return {
          id: command.id,
          rect: command.rect,
          type: command.type,
          visible: command.visible,
          z: command.z,
        };
      case "removeSurface":
        return {
          id: command.id,
          type: command.type,
        };
      case "present":
        return {
          type: command.type,
        };
    }
  });
}

function desktopShell(): ShellComposedLayout {
  const desktop = surface({
    id: "surface:desktop",
    layer: "desktop",
    order: 0,
    rect: rect(0, 0, SCREEN.width, SCREEN.height),
    role: "desktop",
  });

  return Object.freeze({
    configId: "test.shell",
    css: Object.freeze({
      rules: Object.freeze([]),
      text: "",
    }),
    revision: "test",
    root: desktop,
    surfaces: Object.freeze([
      desktop,
    ]),
  });
}

function surface(input: {
  readonly id: string;
  readonly role: string;
  readonly layer: string;
  readonly order: number;
  readonly rect: Rect;
}): ShellResolvedSurface {
  return Object.freeze({
    children: Object.freeze([]),
    componentId: `component:${input.role}`,
    id: input.id,
    path: input.id,
    payload: Object.freeze({}),
    placement: Object.freeze({
      layer: input.layer,
      order: input.order,
      rect: input.rect,
      zone: "center",
    }),
    role: input.role,
    substrate: Object.freeze({}),
  });
}

function rect(x: number, y: number, width: number, height: number): Rect {
  return Object.freeze({
    height,
    width,
    x,
    y,
  });
}

function size(width: number, height: number): CompositorSurfaceSize {
  return Object.freeze({
    height,
    width,
  });
}

function ok<T>(value: T): AppHostResult<T> {
  return {
    ok: true,
    value,
  };
}

function appHostReject<T>(code: string, message: string, path: string): AppHostResult<T> {
  return {
    error: {
      code,
      message,
      path,
    },
    ok: false,
  };
}

function compareStrings(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;

  return 0;
}
