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
  WindowManagerIntent,
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
  readonly #pendingCleanup = new Map<string, AppWindowHostPendingCleanup>();

  constructor(options: AppWindowHostOptions) {
    this.#appHost = options.appHost;
    this.#compositor = options.compositor;
    this.#shell = options.shell;
    this.#layoutConstraints = options.layoutConstraints ?? DEFAULT_LAYOUT_CONSTRAINTS;
  }

  async launch(app: AppDescriptor): Promise<AppWindowHostResult<AppWindowHostLaunch>> {
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

    const reconciled = await this.#reconcileCurrent(launched.value.intents);

    if (reconciled.ok) {
      return accept(Object.freeze({
        launch: launched.value,
        reconcile: reconciled.value,
      }));
    }

    const rolledBack = await this.#rollbackLaunch(launched.value, reconciled.error);

    if (!rolledBack.ok) return rolledBack;

    return {
      error: reconciled.error,
      ok: false,
    };
  }

  async stop(app: AppDescriptor | string): Promise<AppWindowHostResult<AppWindowHostStop>> {
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

    const reconciled = await this.#reconcileCurrent(stopped.value.intents);

    if (!reconciled.ok) {
      this.#rememberPendingCleanup(stopped.value, reconciled.error);
      return {
        error: reconciled.error,
        ok: false,
      };
    }

    return accept(Object.freeze({
      reconcile: reconciled.value,
      stop: stopped.value,
    }));
  }

  async observe(event: AppWindowHostObservedEvent): Promise<AppWindowHostResult<AppWindowHostReconcile>> {
    switch (event.type) {
      case "launch": {
        const reconciled = await this.#reconcileCurrent(event.launch.intents);

        if (reconciled.ok) return reconciled;

        const rolledBack = await this.#rollbackLaunch(event.launch, reconciled.error);
        if (!rolledBack.ok) return rolledBack;

        return {
          error: reconciled.error,
          ok: false,
        };
      }
      case "stop": {
        const reconciled = await this.#reconcileCurrent(event.stop.intents);

        if (!reconciled.ok) this.#rememberPendingCleanup(event.stop, reconciled.error);

        return reconciled;
      }
    }
  }

  async reconcile(): Promise<AppWindowHostResult<AppWindowHostReconcile>> {
    const reconciled = await this.#reconcileCurrent();

    if (reconciled.ok) {
      this.#pendingCleanup.clear();
    }

    return reconciled;
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

  async #rollbackLaunch(
    launch: AppLaunch,
    cause: AppWindowHostError,
  ): Promise<AppWindowHostResult<true>> {
    const stopped = await this.#callAppHostStop(launch.app.id);

    if (!stopped.ok) {
      const rollbackError = rejectError(
        "APP_LAUNCH_ROLLBACK_FAILED",
        `app launch window registration failed with ${cause.code}; rollback stop failed with ${stopped.error.code}: ${stopped.error.message}`,
        stopped.error.path,
      );
      this.#rememberPendingCleanup(launch, rollbackError);
      return {
        error: rollbackError,
        ok: false,
      };
    }

    const reconciled = await this.#reconcileCurrent(stopped.value.intents);

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

  async #reconcileCurrent(
    windowIntents: readonly WindowManagerIntent[] = Object.freeze([]),
  ): Promise<AppWindowHostResult<AppWindowHostReconcile>> {
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
    const input = buildReconcileInput(shell, windowSurfaces, windowIntents);
    let reconciled: CompositorReconcileResult;

    try {
      reconciled = await this.#compositor.reconcile(input);
    } catch {
      return reject(
        "COMPOSITOR_RECONCILE_FAILED",
        "compositor reconcile threw before committing a window snapshot.",
        "/compositor/reconcile",
      );
    }

    if (!reconciled.ok) {
      return {
        error: compositorError(reconciled.error),
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
  ): void {
    const cleanup = pendingCleanupFromLifecycle(lifecycle, reason);
    this.#pendingCleanup.set(cleanup.appId, cleanup);
  }

  #firstPendingCleanup(): AppWindowHostPendingCleanup | undefined {
    for (const cleanup of this.#pendingCleanup.values()) {
      return cleanup;
    }

    return undefined;
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
  windowIntents: readonly WindowManagerIntent[],
): CompositorReconcileInput {
  const input: {
    shell: ShellComposedLayout;
    windows: readonly CompositorWindowPlacement[];
    windowIntents?: readonly WindowManagerIntent[];
  } = {
    shell,
    windows: Object.freeze(windows.map((window) => window.placement)),
  };

  if (windowIntents.length > 0) {
    input.windowIntents = freezeIntents(windowIntents);
  }

  return Object.freeze(input);
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

function freezeIntents(intents: readonly WindowManagerIntent[]): readonly WindowManagerIntent[] {
  return Object.freeze([...intents]);
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
