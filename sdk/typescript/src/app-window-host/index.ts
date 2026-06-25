import type {
  AppDescriptor,
  AppHostError,
  AppHostResult,
  AppHostSnapshot,
  AppLaunch,
  AppStop,
  AppSurfaceKind,
} from "../appshell/index.ts";
import {
  compositorWindowPlacement,
} from "../compositor-bridge/index.ts";
import type {
  CompositorCommand,
  CompositorDriverError,
  CompositorReconcileInput,
  CompositorReconcileResult,
  CompositorSurfaceSnapshot,
  CompositorWindowPlacement,
} from "../compositor-bridge/index.ts";
import type { ShellComposedLayout } from "../shell/index.ts";
import {
  layout,
} from "../wm/policy.ts";
import type {
  LayoutConstraints,
} from "../wm/policy.ts";

type MaybePromise<T> = T | Promise<T>;

export type AppWindowHostResult<T> =
  | {
      readonly ok: true;
      readonly value: T;
    }
  | {
      readonly ok: false;
      readonly error: AppWindowHostError;
    };

export interface AppWindowHostError {
  readonly code: string;
  readonly message: string;
  readonly path: string;
}

export interface AppWindowHostAppHostPort {
  readonly launch: (app: AppDescriptor) => MaybePromise<AppHostResult<AppLaunch>>;
  readonly stop: (app: AppDescriptor | string) => MaybePromise<AppHostResult<AppStop>>;
  readonly snapshot: () => AppHostSnapshot;
}

export interface AppWindowHostCompositorDriverPort {
  readonly reconcile: (input: CompositorReconcileInput) => MaybePromise<CompositorReconcileResult>;
  readonly removeSurface?: (surfaceId: string) => MaybePromise<void>;
  readonly snapshot?: () => readonly CompositorSurfaceSnapshot[];
}

export interface AppWindowHostShellLayoutPort {
  readonly snapshot: () => ShellComposedLayout;
}

export type AppWindowHostShellLayoutSource =
  | ShellComposedLayout
  | AppWindowHostShellLayoutPort
  | (() => ShellComposedLayout);

export interface AppWindowHostOptions {
  readonly appHost: AppWindowHostAppHostPort;
  readonly appHostEvents?: AppWindowHostAppHostEventsPort;
  readonly compositor: AppWindowHostCompositorDriverPort;
  readonly shell: AppWindowHostShellLayoutSource;
  readonly layoutConstraints?: LayoutConstraints;
}

export interface AppWindowSurface {
  readonly appId: string;
  readonly title: string;
  readonly surfaceKind: AppSurfaceKind;
  readonly surfaceId: string;
  readonly textureId: string;
  readonly windowId: string;
  readonly placement: CompositorWindowPlacement;
}

export type AppWindowHostObservedEvent =
  | {
      readonly type: "launch";
      readonly launch: AppLaunch;
    }
  | {
      readonly type: "stop";
      readonly stop: AppStop;
    };

export type AppWindowHostEventListener = (
  event: AppWindowHostObservedEvent,
) => MaybePromise<AppWindowHostResult<AppWindowHostReconcile>>;

export type AppWindowHostUnsubscribe = () => void;

export interface AppWindowHostAppHostEventsPort {
  readonly subscribe: (listener: AppWindowHostEventListener) => AppWindowHostUnsubscribe;
}

export type AppWindowHostSuccessfulReconcile = Extract<
  CompositorReconcileResult,
  { readonly ok: true }
>;

export interface AppWindowHostReconcile {
  readonly compositor: AppWindowHostSuccessfulReconcile;
  readonly windows: readonly AppWindowSurface[];
}

export interface AppWindowHostLaunch {
  readonly launch: AppLaunch;
  readonly reconcile: AppWindowHostReconcile;
}

export interface AppWindowHostStop {
  readonly stop: AppStop;
  readonly reconcile: AppWindowHostReconcile;
}

export interface AppWindowHostPendingCleanup {
  readonly appId: string;
  readonly surfaceId: string;
  readonly textureId: string;
  readonly windowId: string;
  readonly reason: AppWindowHostError;
}

export interface AppWindowHostSnapshot {
  readonly apps: readonly AppLaunch[];
  readonly windows: readonly AppWindowSurface[];
  readonly pendingCleanup: readonly AppWindowHostPendingCleanup[];
  readonly compositor: readonly CompositorSurfaceSnapshot[];
}

type AppWindowHostQueuedOperation<T> = () => MaybePromise<AppWindowHostResult<T>>;

const DEFAULT_LAYOUT_CONSTRAINTS = Object.freeze({
  bounds: Object.freeze({
    height: 720,
    width: 1_280,
    x: 0,
    y: 0,
  }),
}) satisfies LayoutConstraints;

export class AppWindowHost {
  readonly #appHost: AppWindowHostAppHostPort;
  readonly #compositor: AppWindowHostCompositorDriverPort;
  readonly #shell: AppWindowHostShellLayoutSource;
  readonly #layoutConstraints: LayoutConstraints;
  readonly #maybeLiveWindowsByError = new WeakMap<AppWindowHostError, readonly AppWindowSurface[]>();
  readonly #pendingCleanup = new Map<string, AppWindowHostPendingCleanup>();
  readonly #pendingRollbackStops = new Set<string>();
  readonly #processedObservedEvents = new Map<string, AppWindowHostResult<AppWindowHostReconcile>>();
  readonly #untrackedPendingCleanup = new Set<string>();
  #eventQueue: Promise<void> = Promise.resolve();
  #unsubscribe: AppWindowHostUnsubscribe | undefined;

  constructor(options: AppWindowHostOptions) {
    this.#appHost = options.appHost;
    this.#compositor = options.compositor;
    this.#shell = options.shell;
    this.#layoutConstraints = options.layoutConstraints ?? DEFAULT_LAYOUT_CONSTRAINTS;
    this.#unsubscribe = options.appHostEvents?.subscribe((event) => this.#observeSubscribedEvent(event));
  }

  async launch(app: AppDescriptor): Promise<AppWindowHostResult<AppWindowHostLaunch>> {
    return this.#enqueueLifecycle(() => this.#launchQueued(app));
  }

  async stop(app: AppDescriptor | string): Promise<AppWindowHostResult<AppWindowHostStop>> {
    return this.#enqueueLifecycle(() => this.#stopQueued(app));
  }

  async observe(event: AppWindowHostObservedEvent): Promise<AppWindowHostResult<AppWindowHostReconcile>> {
    return this.#enqueueLifecycle(() => this.#observeQueued(event));
  }

  dispose(): void {
    const unsubscribe = this.#unsubscribe;

    this.#unsubscribe = undefined;
    if (unsubscribe !== undefined) unsubscribe();
  }

  async reconcile(): Promise<AppWindowHostResult<AppWindowHostReconcile>> {
    return this.#enqueueLifecycle(() => this.#reconcileQueued());
  }

  snapshot(): AppWindowHostSnapshot {
    const appSnapshot = this.#appHost.snapshot();

    return Object.freeze({
      apps: freezeLaunches(appSnapshot.apps),
      compositor: this.#compositor.snapshot?.() ?? Object.freeze([]),
      pendingCleanup: freezePendingCleanup([...this.#pendingCleanup.values()]),
      windows: appWindowSurfaces(appSnapshot, this.#layoutConstraints),
    });
  }

  async #launchQueued(app: AppDescriptor): Promise<AppWindowHostResult<AppWindowHostLaunch>> {
    const pendingCleanup = this.#firstPendingCleanup();

    if (pendingCleanup !== undefined) {
      return reject(
        "APP_WINDOW_CLEANUP_PENDING",
        `app '${pendingCleanup.appId}' has compositor cleanup pending before another app can launch.`,
        `/apps/${pathToken(pendingCleanup.appId)}/window-cleanup`,
      );
    }

    const launched = await this.#callAppHostLaunch(app);

    if (!launched.ok) return fromAppHostError(launched.error);

    const reconciled = await this.#reconcileCurrent();

    if (reconciled.ok) {
      this.#rememberProcessedObservedEvent({
        launch: launched.value,
        type: "launch",
      }, accept(reconciled.value));

      return accept(Object.freeze({
        launch: launched.value,
        reconcile: reconciled.value,
      }));
    }

    const rolledBack = await this.#rollbackLaunch(launched.value, reconciled.error);

    if (!rolledBack.ok) {
      this.#rememberProcessedObservedEvent({
        launch: launched.value,
        type: "launch",
      }, {
        error: rolledBack.error,
        ok: false,
      });
      return rolledBack;
    }

    const failed = {
      error: reconciled.error,
      ok: false,
    } satisfies AppWindowHostResult<AppWindowHostReconcile>;

    this.#rememberProcessedObservedEvent({
      launch: launched.value,
      type: "launch",
    }, failed);

    return failed;
  }

  async #stopQueued(app: AppDescriptor | string): Promise<AppWindowHostResult<AppWindowHostStop>> {
    const pendingCleanup = this.#firstPendingCleanup();

    if (pendingCleanup !== undefined) {
      return reject(
        "APP_WINDOW_CLEANUP_PENDING",
        `app '${pendingCleanup.appId}' has compositor cleanup pending before another app can stop.`,
        `/apps/${pathToken(pendingCleanup.appId)}/window-cleanup`,
      );
    }

    const stopped = await this.#callAppHostStop(app);

    if (!stopped.ok) return fromAppHostError(stopped.error);

    const reconciled = await this.#reconcileCurrent();

    if (!reconciled.ok) {
      this.#rememberPendingCleanup(stopped.value, reconciled.error);
      this.#rememberProcessedObservedEvent({
        stop: stopped.value,
        type: "stop",
      }, reconciled);
      return {
        error: reconciled.error,
        ok: false,
      };
    }

    this.#rememberProcessedObservedEvent({
      stop: stopped.value,
      type: "stop",
    }, reconciled);

    return accept(Object.freeze({
      reconcile: reconciled.value,
      stop: stopped.value,
    }));
  }

  async #observeQueued(event: AppWindowHostObservedEvent): Promise<AppWindowHostResult<AppWindowHostReconcile>> {
    const eventKey = observedEventKey(event);
    const processed = this.#processedObservedEvents.get(eventKey);

    if (processed !== undefined) {
      this.#processedObservedEvents.delete(eventKey);
      return processed;
    }

    return this.#processObservedEvent(event);
  }

  async #processObservedEvent(
    event: AppWindowHostObservedEvent,
  ): Promise<AppWindowHostResult<AppWindowHostReconcile>> {
    switch (event.type) {
      case "launch": {
        const reconciled = await this.#reconcileCurrent();

        if (reconciled.ok) return reconciled;

        const running = this.#appIsRunning(event.launch.app.id);
        if (!running.ok || !running.value) return reconciled;

        const rolledBack = await this.#rollbackLaunch(event.launch, reconciled.error);
        if (!rolledBack.ok) return rolledBack;

        return {
          error: reconciled.error,
          ok: false,
        };
      }
      case "stop": {
        const reconciled = await this.#reconcileCurrent();

        if (!reconciled.ok) {
          const running = this.#appIsRunning(event.stop.appId);

          if (!running.ok || !running.value) {
            this.#rememberPendingCleanup(event.stop, reconciled.error);
          }
        }

        return reconciled;
      }
    }
  }

  async #reconcileQueued(): Promise<AppWindowHostResult<AppWindowHostReconcile>> {
    const untrackedCleanup = await this.#retryUntrackedPendingCleanup();

    if (!untrackedCleanup.ok) return untrackedCleanup;

    const reconciled = await this.#reconcileCurrent();

    if (!reconciled.ok) return reconciled;

    if (this.#untrackedPendingCleanup.size === 0) {
      this.#clearPendingCleanup();
    }

    return reconciled;
  }

  async #rollbackLaunch(
    launch: AppLaunch,
    cause: AppWindowHostError,
  ): Promise<AppWindowHostResult<true>> {
    const maybeLiveWindows = maybeLiveWindowsForLaunch(
      this.#maybeLiveWindowsByError.get(cause) ?? Object.freeze([]),
      launch,
    );
    const stopped = await this.#callAppHostStop(launch.app.id);

    if (!stopped.ok) {
      const rollbackError = rejectError(
        "APP_LAUNCH_ROLLBACK_FAILED",
        `app launch window registration failed with ${cause.code}; rollback stop failed with ${stopped.error.code}: ${stopped.error.message}`,
        stopped.error.path,
      );

      const running = this.#appIsRunning(launch.app.id);
      let untrackedSurface = maybeLiveWindows.length > 0;

      if (running.ok && !running.value) {
        await this.#cleanupMaybeLiveWindows(launch, maybeLiveWindows);
        untrackedSurface = this.#untrackedPendingCleanup.has(launch.app.id);
      }

      this.#rememberPendingCleanup(launch, rollbackError, {
        retryStop: true,
        untrackedSurface,
      });
      return {
        error: rollbackError,
        ok: false,
      };
    }

    await this.#cleanupMaybeLiveWindows(stopped.value, maybeLiveWindows);

    const reconciled = await this.#reconcileCurrent();
    this.#rememberProcessedObservedEvent({
      stop: stopped.value,
      type: "stop",
    }, reconciled);

    if (!reconciled.ok) {
      const rollbackError = rejectError(
        "APP_LAUNCH_ROLLBACK_FAILED",
        `app launch window registration failed with ${cause.code}; rollback compositor cleanup failed with ${reconciled.error.code}: ${reconciled.error.message}`,
        reconciled.error.path,
      );
      this.#rememberPendingCleanup(stopped.value, rollbackError);
      return {
        error: rollbackError,
        ok: false,
      };
    }

    return accept(true);
  }

  #observeSubscribedEvent(
    event: AppWindowHostObservedEvent,
  ): Promise<AppWindowHostResult<AppWindowHostReconcile>> {
    return this.#enqueueLifecycle(() => this.#observeQueued(event));
  }

  #enqueueLifecycle<T>(
    operation: AppWindowHostQueuedOperation<T>,
  ): Promise<AppWindowHostResult<T>> {
    const queued = this.#eventQueue.then(
      () => operation(),
      () => operation(),
    );

    this.#eventQueue = queued.then(
      () => undefined,
      () => undefined,
    );

    return queued;
  }

  #rememberProcessedObservedEvent(
    event: AppWindowHostObservedEvent,
    result: AppWindowHostResult<AppWindowHostReconcile>,
  ): void {
    this.#processedObservedEvents.set(observedEventKey(event), result);
  }

  async #reconcileCurrent(): Promise<AppWindowHostResult<AppWindowHostReconcile>> {
    let appSnapshot: AppHostSnapshot;
    let shell: ShellComposedLayout;

    try {
      appSnapshot = this.#appHost.snapshot();
      shell = shellLayout(this.#shell);
    } catch {
      return reject(
        "APP_WINDOW_SNAPSHOT_FAILED",
        "app window host could not read the injected app or shell snapshot.",
        "/snapshot",
      );
    }

    const windowSurfaces = appWindowSurfaces(appSnapshot, this.#layoutConstraints);
    const input = buildReconcileInput(shell, windowSurfaces);
    let reconciled: CompositorReconcileResult;

    try {
      reconciled = await this.#compositor.reconcile(input);
    } catch {
      const error = rejectError(
        "COMPOSITOR_RECONCILE_FAILED",
        "compositor reconcile threw before committing a window snapshot.",
        "/compositor/reconcile",
      );

      if (windowSurfaces.length > 0) {
        this.#maybeLiveWindowsByError.set(error, windowSurfaces);
      }

      return {
        error,
        ok: false,
      };
    }

    if (!reconciled.ok) {
      const error = compositorError(reconciled.error);
      const maybeLiveWindows = maybeLiveWindowSurfaces(windowSurfaces, reconciled);

      if (maybeLiveWindows.length > 0) {
        this.#maybeLiveWindowsByError.set(error, maybeLiveWindows);
      }

      return {
        error,
        ok: false,
      };
    }

    return accept(Object.freeze({
      compositor: reconciled,
      windows: windowSurfaces,
    }));
  }

  async #callAppHostLaunch(app: AppDescriptor): Promise<AppHostResult<AppLaunch>> {
    try {
      return await this.#appHost.launch(app);
    } catch {
      return appHostReject(
        "APP_HOST_LAUNCH_FAILED",
        "injected app host launch port threw.",
        "/apps/launch",
      );
    }
  }

  async #callAppHostStop(app: AppDescriptor | string): Promise<AppHostResult<AppStop>> {
    try {
      return await this.#appHost.stop(app);
    } catch {
      return appHostReject(
        "APP_HOST_STOP_FAILED",
        "injected app host stop port threw.",
        "/apps/stop",
      );
    }
  }

  #rememberPendingCleanup(
    lifecycle: AppLaunch | AppStop,
    reason: AppWindowHostError,
    options: {
      readonly retryStop?: boolean;
      readonly untrackedSurface?: boolean;
    } = {},
  ): void {
    const cleanup = pendingCleanupFromLifecycle(lifecycle, reason);
    this.#pendingCleanup.set(cleanup.appId, cleanup);

    if (options.untrackedSurface === true) {
      this.#untrackedPendingCleanup.add(cleanup.appId);
    }

    if (options.retryStop === true) {
      this.#pendingRollbackStops.add(cleanup.appId);
    }
  }

  #firstPendingCleanup(): AppWindowHostPendingCleanup | undefined {
    for (const cleanup of this.#pendingCleanup.values()) {
      return cleanup;
    }

    return undefined;
  }

  async #cleanupMaybeLiveWindows(
    lifecycle: AppLaunch | AppStop,
    windows: readonly AppWindowSurface[],
  ): Promise<void> {
    const seen = new Set<string>();

    for (let index = 0; index < windows.length; index += 1) {
      const window = windows[index];

      if (window === undefined || seen.has(window.textureId)) {
        continue;
      }

      seen.add(window.textureId);

      const removed = await this.#removeMaybeLiveSurface(window.textureId);

      if (!removed.ok) {
        this.#rememberPendingCleanup(lifecycle, removed.error, {
          untrackedSurface: true,
        });
      }
    }
  }

  async #removeMaybeLiveSurface(surfaceId: string): Promise<AppWindowHostResult<true>> {
    if (this.#compositor.removeSurface === undefined) {
      return reject(
        "APP_WINDOW_CLEANUP_PENDING",
        `compositor surface '${surfaceId}' may have landed, but no injected cleanup port is available.`,
        `/surfaces/${pathToken(surfaceId)}/cleanup`,
      );
    }

    try {
      await this.#compositor.removeSurface(surfaceId);
    } catch {
      return reject(
        "COMPOSITOR_SURFACE_CLEANUP_FAILED",
        `compositor surface '${surfaceId}' may have landed and cleanup failed closed.`,
        `/surfaces/${pathToken(surfaceId)}/cleanup`,
      );
    }

    return accept(true);
  }

  async #retryUntrackedPendingCleanup(): Promise<AppWindowHostResult<true>> {
    const pending = freezePendingCleanup([...this.#pendingCleanup.values()])
      .filter((cleanup) =>
        this.#pendingRollbackStops.has(cleanup.appId) ||
        this.#untrackedPendingCleanup.has(cleanup.appId)
      );
    const first = pending[0];

    if (first === undefined) return accept(true);

    for (let index = 0; index < pending.length; index += 1) {
      const cleanup = pending[index];

      if (cleanup === undefined) continue;

      const stopped = await this.#stopRunningPendingCleanupApp(cleanup);

      if (!stopped.ok) {
        this.#pendingCleanup.set(cleanup.appId, Object.freeze({
          ...cleanup,
          reason: stopped.error,
        }));
        return stopped;
      }

      const cleanupAfterStop = stopped.value;

      if (this.#untrackedPendingCleanup.has(cleanupAfterStop.appId)) {
        const removed = await this.#removeMaybeLiveSurface(cleanupAfterStop.textureId);

        if (!removed.ok) {
          this.#pendingCleanup.set(cleanupAfterStop.appId, Object.freeze({
            ...cleanupAfterStop,
            reason: removed.error,
          }));
          return removed;
        }

        this.#untrackedPendingCleanup.delete(cleanupAfterStop.appId);
      }

      this.#pendingRollbackStops.delete(cleanupAfterStop.appId);
    }

    return accept(true);
  }

  async #stopRunningPendingCleanupApp(
    cleanup: AppWindowHostPendingCleanup,
  ): Promise<AppWindowHostResult<AppWindowHostPendingCleanup>> {
    const running = this.#appIsRunning(cleanup.appId);

    if (!running.ok) return running;

    if (!running.value) return accept(cleanup);

    const stopped = await this.#callAppHostStop(cleanup.appId);

    if (!stopped.ok) return fromAppHostError(stopped.error);

    const next = pendingCleanupFromLifecycle(stopped.value, cleanup.reason);
    this.#pendingCleanup.set(next.appId, next);

    return accept(next);
  }

  #clearPendingCleanup(): void {
    this.#pendingCleanup.clear();
    this.#pendingRollbackStops.clear();
    this.#untrackedPendingCleanup.clear();
  }

  #appIsRunning(appId: string): AppWindowHostResult<boolean> {
    let snapshot: AppHostSnapshot;

    try {
      snapshot = this.#appHost.snapshot();
    } catch {
      return reject(
        "APP_WINDOW_SNAPSHOT_FAILED",
        "app window host could not read the injected app snapshot during cleanup.",
        `/apps/${pathToken(appId)}/cleanup`,
      );
    }

    for (let index = 0; index < snapshot.apps.length; index += 1) {
      const launch = snapshot.apps[index];

      if (launch !== undefined && launch.app.id === appId) return accept(true);
    }

    return accept(false);
  }
}

function appWindowSurfaces(
  snapshot: AppHostSnapshot,
  constraints: LayoutConstraints,
): readonly AppWindowSurface[] {
  const launchesByWindowId = launchesByWindowIdMap(snapshot.apps);
  const placements = layout(snapshot.windowModel, constraints);
  const surfaces: AppWindowSurface[] = [];

  for (let index = 0; index < placements.length; index += 1) {
    const placement = placements[index];

    if (placement === undefined) continue;

    const launch = launchesByWindowId.get(placement.windowId);

    if (launch === undefined) continue;

    surfaces.push(Object.freeze({
      appId: launch.app.id,
      placement: compositorWindowPlacement(placement),
      surfaceId: launch.surfaceId,
      surfaceKind: launch.app.surfaceKind,
      textureId: launch.textureId,
      title: launch.app.title,
      windowId: launch.windowId,
    }));
  }

  return Object.freeze(surfaces);
}

function buildReconcileInput(
  shell: ShellComposedLayout,
  windows: readonly AppWindowSurface[],
): CompositorReconcileInput {
  return Object.freeze({
    shell,
    windows: Object.freeze(windows.map((window) => window.placement)),
  });
}

function launchesByWindowIdMap(launches: readonly AppLaunch[]): ReadonlyMap<string, AppLaunch> {
  const output = new Map<string, AppLaunch>();

  for (let index = 0; index < launches.length; index += 1) {
    const launch = launches[index];

    if (launch !== undefined && !output.has(launch.windowId)) {
      output.set(launch.windowId, launch);
    }
  }

  return output;
}

function maybeLiveWindowSurfaces(
  windows: readonly AppWindowSurface[],
  reconciled: Extract<CompositorReconcileResult, { readonly ok: false }>,
): readonly AppWindowSurface[] {
  const windowsByTextureId = windowsByTextureIdMap(windows);
  const maybeLiveTextureIds = new Set<string>();

  collectMaybeLiveWindowRegisterCommands(
    reconciled.commands,
    windowsByTextureId,
    maybeLiveTextureIds,
  );

  if (reconciled.error.command !== undefined) {
    collectMaybeLiveWindowRegisterCommand(
      reconciled.error.command,
      windowsByTextureId,
      maybeLiveTextureIds,
    );
  }

  if (maybeLiveTextureIds.size === 0) return Object.freeze([]);

  const output: AppWindowSurface[] = [];

  for (let index = 0; index < windows.length; index += 1) {
    const window = windows[index];

    if (window !== undefined && maybeLiveTextureIds.has(window.textureId)) {
      output.push(window);
    }
  }

  return Object.freeze(output);
}

function windowsByTextureIdMap(
  windows: readonly AppWindowSurface[],
): ReadonlyMap<string, AppWindowSurface> {
  const output = new Map<string, AppWindowSurface>();

  for (let index = 0; index < windows.length; index += 1) {
    const window = windows[index];

    if (window !== undefined && !output.has(window.textureId)) {
      output.set(window.textureId, window);
    }
  }

  return output;
}

function collectMaybeLiveWindowRegisterCommands(
  commands: readonly CompositorCommand[],
  windowsByTextureId: ReadonlyMap<string, AppWindowSurface>,
  output: Set<string>,
): void {
  for (let index = 0; index < commands.length; index += 1) {
    const command = commands[index];

    if (command !== undefined) {
      collectMaybeLiveWindowRegisterCommand(command, windowsByTextureId, output);
    }
  }
}

function collectMaybeLiveWindowRegisterCommand(
  command: CompositorCommand,
  windowsByTextureId: ReadonlyMap<string, AppWindowSurface>,
  output: Set<string>,
): void {
  if (
    command.type === "registerSurface" &&
    command.kind === "window" &&
    windowsByTextureId.has(command.id)
  ) {
    output.add(command.id);
  }
}

function shellLayout(source: AppWindowHostShellLayoutSource): ShellComposedLayout {
  if (typeof source === "function") {
    return source();
  }

  if ("snapshot" in source) {
    return source.snapshot();
  }

  return source;
}

function pendingCleanupFromLifecycle(
  lifecycle: AppLaunch | AppStop,
  reason: AppWindowHostError,
): AppWindowHostPendingCleanup {
  const appId = "app" in lifecycle ? lifecycle.app.id : lifecycle.appId;

  return Object.freeze({
    appId,
    reason,
    surfaceId: lifecycle.surfaceId,
    textureId: lifecycle.textureId,
    windowId: lifecycle.windowId,
  });
}

function observedEventKey(event: AppWindowHostObservedEvent): string {
  switch (event.type) {
    case "launch":
      return launchEventKeyForLaunch(event.launch);
    case "stop":
      return stopEventKeyForStop(event.stop);
  }
}

function launchEventKeyForLaunch(launch: AppLaunch): string {
  return lifecycleEventKey(
    "launch",
    launch.app.id,
    launch.surfaceId,
    launch.textureId,
    launch.windowId,
  );
}

function stopEventKeyForStop(stop: AppStop): string {
  return lifecycleEventKey(
    "stop",
    stop.appId,
    stop.surfaceId,
    stop.textureId,
    stop.windowId,
  );
}

function lifecycleEventKey(
  type: "launch" | "stop",
  appId: string,
  surfaceId: string,
  textureId: string,
  windowId: string,
): string {
  return [
    type,
    keyPart(appId),
    keyPart(surfaceId),
    keyPart(textureId),
    keyPart(windowId),
  ].join("|");
}

function keyPart(value: string): string {
  return `${value.length}:${value}`;
}

function maybeLiveWindowsForLaunch(
  windows: readonly AppWindowSurface[],
  launch: AppLaunch,
): readonly AppWindowSurface[] {
  const output: AppWindowSurface[] = [];

  for (let index = 0; index < windows.length; index += 1) {
    const window = windows[index];

    if (
      window !== undefined &&
      window.appId === launch.app.id &&
      window.surfaceId === launch.surfaceId &&
      window.textureId === launch.textureId &&
      window.windowId === launch.windowId
    ) {
      output.push(window);
    }
  }

  return Object.freeze(output);
}

function freezePendingCleanup(
  pending: readonly AppWindowHostPendingCleanup[],
): readonly AppWindowHostPendingCleanup[] {
  const output = [...pending];
  output.sort((left, right) => compareStrings(left.appId, right.appId));
  return Object.freeze(output);
}

function freezeLaunches(launches: readonly AppLaunch[]): readonly AppLaunch[] {
  const output = [...launches];
  output.sort((left, right) => compareStrings(left.app.id, right.app.id));
  return Object.freeze(output);
}

function compositorError(error: CompositorDriverError): AppWindowHostError {
  return rejectError(
    "COMPOSITOR_RECONCILE_FAILED",
    `compositor reconcile failed with ${error.code}: ${error.message}`,
    error.path,
  );
}

function fromAppHostError<T>(error: AppHostError): AppWindowHostResult<T> {
  return {
    error: rejectError(error.code, error.message, error.path),
    ok: false,
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

function accept<T>(value: T): AppWindowHostResult<T> {
  return {
    ok: true,
    value,
  };
}

function reject<T>(code: string, message: string, path: string): AppWindowHostResult<T> {
  return {
    error: rejectError(code, message, path),
    ok: false,
  };
}

function rejectError(code: string, message: string, path: string): AppWindowHostError {
  return Object.freeze({
    code,
    message,
    path,
  });
}

function pathToken(value: string): string {
  return value.replaceAll("~", "~0").replaceAll("/", "~1");
}

function compareStrings(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;

  return 0;
}
