import { safeNormalize } from "../safe-normalize.ts";
import type { PlainJson, PlainJsonObject } from "../safe-normalize.ts";
import type {
  ShellPlacement,
  ShellSubstratePort,
  ShellSurfaceCreateRequest,
} from "../shell/index.ts";
import {
  closeWindow,
  collectWindowManagerIntents,
  createWindowModel,
  openWindow,
} from "../wm/policy.ts";
import type {
  LayoutConstraints,
  Rect,
  WindowManagerIntent,
  WindowManagerSubstratePort,
  WindowMode,
  WindowModel,
  WindowOpenRequest,
} from "../wm/policy.ts";

export const VITA_WINDOWED_APP_COMPONENT_ID = "vita.appshell.windowed-app";

export type AppSurfaceKind = "tsx" | "wasm" | "container" | "web";
export type CapsuleAppSurfaceKind = "wasm" | "container";

export type AppHostResult<T> =
  | {
      readonly ok: true;
      readonly value: T;
    }
  | {
      readonly ok: false;
      readonly error: AppHostError;
    };

export interface AppHostError {
  readonly code: string;
  readonly message: string;
  readonly path: string;
}

export interface AppWindowHints {
  readonly workspaceId?: string;
  readonly rect?: Rect;
  readonly mode?: WindowMode;
  readonly zone?: string;
  readonly layer?: string;
  readonly order?: number;
  readonly anchor?: string;
  readonly className?: string;
}

export interface TsxComponentRef {
  readonly componentId: string;
  readonly props?: PlainJsonObject;
}

export interface CapsuleRuntimeRef {
  readonly id: string;
  readonly version: string;
  readonly integrity: string;
  readonly ref: string;
  readonly entrypoint?: string;
}

export interface WebviewRuntimeRef {
  readonly url: string;
  readonly partition?: string;
}

interface AppDescriptorBase<Kind extends AppSurfaceKind, RuntimeRef> {
  readonly id: string;
  readonly title: string;
  readonly surfaceKind: Kind;
  readonly runtime: RuntimeRef;
  readonly defaultWindow?: AppWindowHints;
}

export type TsxAppDescriptor = AppDescriptorBase<"tsx", TsxComponentRef>;
export type WasmAppDescriptor = AppDescriptorBase<"wasm", CapsuleRuntimeRef>;
export type ContainerAppDescriptor = AppDescriptorBase<"container", CapsuleRuntimeRef>;
export type WebAppDescriptor = AppDescriptorBase<"web", WebviewRuntimeRef>;

export type AppDescriptor =
  | TsxAppDescriptor
  | WasmAppDescriptor
  | ContainerAppDescriptor
  | WebAppDescriptor;

export interface RuntimeLaunchBase<Kind extends AppSurfaceKind> {
  readonly appId: string;
  readonly title: string;
  readonly surfaceKind: Kind;
  readonly surfaceId: string;
  readonly windowId: string;
}

export interface TsxRenderRequest extends RuntimeLaunchBase<"tsx"> {
  readonly runtime: TsxComponentRef;
}

export interface CapsuleRuntimeLaunchRequest<Kind extends CapsuleAppSurfaceKind>
  extends RuntimeLaunchBase<Kind> {
  readonly runtime: CapsuleRuntimeRef;
}

export interface WebviewLaunchRequest extends RuntimeLaunchBase<"web"> {
  readonly runtime: WebviewRuntimeRef;
}

export interface RuntimeBindingBase<Kind extends AppSurfaceKind> {
  readonly appId: string;
  readonly bindingId: string;
  readonly runtimeId: string;
  readonly surfaceKind: Kind;
  readonly surfaceId: string;
  readonly windowId: string;
  readonly metadata?: PlainJsonObject;
}

export interface TsxRenderBinding extends RuntimeBindingBase<"tsx"> {
  readonly componentId: string;
}

export interface CapsuleRuntimeBinding<Kind extends CapsuleAppSurfaceKind>
  extends RuntimeBindingBase<Kind> {
  readonly capsuleId: string;
}

export interface WebviewBinding extends RuntimeBindingBase<"web"> {
  readonly url: string;
}

export type AppRuntimeBinding =
  | TsxRenderBinding
  | CapsuleRuntimeBinding<"wasm">
  | CapsuleRuntimeBinding<"container">
  | WebviewBinding;

export interface TsxRenderPort {
  readonly mount: (request: TsxRenderRequest) => AppHostResult<TsxRenderBinding>;
  readonly unmount: (binding: TsxRenderBinding) => AppHostResult<true>;
}

export interface CapsuleRuntimePort<Kind extends CapsuleAppSurfaceKind> {
  readonly launch: (
    request: CapsuleRuntimeLaunchRequest<Kind>,
  ) => AppHostResult<CapsuleRuntimeBinding<Kind>>;
  readonly stop: (binding: CapsuleRuntimeBinding<Kind>) => AppHostResult<true>;
}

export interface WebviewPort {
  readonly open: (request: WebviewLaunchRequest) => AppHostResult<WebviewBinding>;
  readonly close: (binding: WebviewBinding) => AppHostResult<true>;
}

export interface AppHostPorts {
  readonly shell: ShellSubstratePort;
  readonly wm: WindowManagerSubstratePort;
  readonly tsx?: TsxRenderPort;
  readonly wasm?: CapsuleRuntimePort<"wasm">;
  readonly container?: CapsuleRuntimePort<"container">;
  readonly webview?: WebviewPort;
}

export interface AppHostOptions {
  readonly ports: AppHostPorts;
  readonly layoutConstraints?: LayoutConstraints;
  readonly initialWindowModel?: WindowModel;
}

export interface AppLaunch {
  readonly app: AppDescriptor;
  readonly binding: AppRuntimeBinding;
  readonly surfaceId: string;
  readonly windowId: string;
  readonly textureId: string;
  readonly surfaceRequest: ShellSurfaceCreateRequest;
  readonly intents: readonly WindowManagerIntent[];
}

export interface AppStop {
  readonly appId: string;
  readonly surfaceId: string;
  readonly windowId: string;
  readonly textureId: string;
  readonly intents: readonly WindowManagerIntent[];
}

export interface AppHostSnapshot {
  readonly apps: readonly AppLaunch[];
  readonly windowModel: WindowModel;
}

interface PendingAppCleanup {
  readonly appId: string;
  readonly binding?: AppRuntimeBinding;
  readonly surfaceLive: boolean;
  readonly surfaceId: string;
  readonly textureId: string;
  readonly windowId: string;
  readonly windowOpen: boolean;
  readonly windowCleanupIntents?: readonly WindowManagerIntent[];
  readonly windowMaybeLandedIntents?: readonly WindowManagerIntent[];
}

interface WindowManagerEmitProgress {
  readonly requestedIntents: readonly WindowManagerIntent[];
  readonly completedIntents: readonly WindowManagerIntent[];
  readonly maybeLandedIntents: readonly WindowManagerIntent[];
  readonly failedIntent?: WindowManagerIntent;
}

type WindowManagerEmitResult =
  | {
      readonly ok: true;
      readonly value: WindowManagerEmitProgress;
    }
  | {
      readonly ok: false;
      readonly error: AppHostError;
      readonly progress: WindowManagerEmitProgress;
    };

const DEFAULT_RECT = Object.freeze({
  height: 480,
  width: 720,
  x: 96,
  y: 72,
}) satisfies Rect;

const DEFAULT_LAYOUT_CONSTRAINTS = Object.freeze({
  bounds: Object.freeze({
    height: 720,
    width: 1_280,
    x: 0,
    y: 0,
  }) satisfies Rect,
}) satisfies LayoutConstraints;

const DEFAULT_SHELL_PLACEMENT = Object.freeze({
  layer: "desktop",
  order: 0,
  zone: "center",
}) satisfies ShellPlacement;

const APP_DESCRIPTOR_FIELDS = new Set<string>([
  "defaultWindow",
  "id",
  "runtime",
  "surfaceKind",
  "title",
]);
const APP_WINDOW_HINT_FIELDS = new Set<string>([
  "anchor",
  "className",
  "layer",
  "mode",
  "order",
  "rect",
  "workspaceId",
  "zone",
]);
const RECT_FIELDS = new Set<string>(["height", "width", "x", "y"]);
const TSX_RUNTIME_FIELDS = new Set<string>(["componentId", "props"]);
const CAPSULE_RUNTIME_FIELDS = new Set<string>([
  "entrypoint",
  "id",
  "integrity",
  "ref",
  "version",
]);
const WEBVIEW_RUNTIME_FIELDS = new Set<string>(["partition", "url"]);

export class AppHost {
  readonly #ports: AppHostPorts;
  readonly #layoutConstraints: LayoutConstraints;
  readonly #launches = new Map<string, AppLaunch>();
  readonly #pendingCleanup = new Map<string, PendingAppCleanup>();
  readonly #descriptorLaunchIds = new WeakMap<object, string>();
  #windowModel: WindowModel;

  constructor(options: AppHostOptions) {
    this.#ports = options.ports;
    this.#layoutConstraints = options.layoutConstraints ?? DEFAULT_LAYOUT_CONSTRAINTS;
    this.#windowModel = options.initialWindowModel ?? createWindowModel();
  }

  launch(app: AppDescriptor): AppHostResult<AppLaunch> {
    const snapshot = snapshotAppDescriptor(app);

    if (!snapshot.ok) return snapshot;

    const appSnapshot = snapshot.value;
    const appId = appSnapshot.id;

    const pendingCleanup = this.#firstPendingCleanup();

    if (pendingCleanup !== undefined) {
      return reject(
        "APP_LAUNCH_CLEANUP_PENDING",
        `app '${pendingCleanup.appId}' has a failed lifecycle awaiting cleanup before '${appId}' can launch.`,
        `/apps/${pathToken(pendingCleanup.appId)}/cleanup`,
      );
    }

    if (this.#launches.has(appId)) {
      return reject(
        "APP_ALREADY_RUNNING",
        `app '${appId}' is already running.`,
        `/apps/${pathToken(appId)}`,
      );
    }

    const surfaceId = appSurfaceId(appId);
    const windowId = appWindowId(appId);
    const runtime = this.#bindRuntime(appSnapshot, surfaceId, windowId);

    if (!runtime.ok) return runtime;

    this.#descriptorLaunchIds.set(app, appId);

    const surfaceRequest = buildSurfaceCreateRequest(appSnapshot, runtime.value, surfaceId);
    const createdSurface = this.#createSurface(surfaceRequest);

    if (!createdSurface.ok) {
      const rolledBack = this.#rollbackFailedLaunchResources(
        appId,
        runtime.value,
        surfaceId,
        windowId,
        true,
        undefined,
        undefined,
      );

      if (!rolledBack.ok) {
        return rejectRollbackFailure(createdSurface.error, rolledBack.error);
      }

      this.#descriptorLaunchIds.delete(app);
      return createdSurface;
    }

    const previousWindowModel = this.#windowModel;
    const nextWindowModel = openWindow(
      previousWindowModel,
      buildWindowOpenRequest(appSnapshot, surfaceId, windowId),
    );
    const intents = collectWindowManagerIntents(
      previousWindowModel,
      nextWindowModel,
      this.#layoutConstraints,
    );
    const emitted = this.#emitWindowManagerIntents(intents, `/apps/${pathToken(appId)}/wm`);

    if (!emitted.ok) {
      const windowCleanupIntents = collectWindowManagerIntents(
        nextWindowModel,
        previousWindowModel,
        this.#layoutConstraints,
      );
      const rolledBack = this.#rollbackFailedLaunchResources(
        appId,
        runtime.value,
        surfaceId,
        windowId,
        true,
        windowCleanupIntents,
        emitted.progress.maybeLandedIntents,
      );

      if (!rolledBack.ok) return rejectRollbackFailure(emitted.error, rolledBack.error);

      this.#descriptorLaunchIds.delete(app);
      return reject(emitted.error.code, emitted.error.message, emitted.error.path);
    }

    this.#windowModel = nextWindowModel;

    const launch = freezeLaunch({
      app: appSnapshot,
      binding: runtime.value,
      intents,
      surfaceId,
      surfaceRequest,
      textureId: surfaceId,
      windowId,
    });
    this.#launches.set(appId, launch);

    return accept(launch);
  }

  stop(app: AppDescriptor | string): AppHostResult<AppStop> {
    const stopAppId = this.#resolveStopAppId(app);

    if (!stopAppId.ok) return stopAppId;

    const appId = stopAppId.value;
    const pendingCleanup = this.#pendingCleanup.get(appId);

    if (pendingCleanup !== undefined) {
      const cleaned = this.#cleanupPendingApp(pendingCleanup);

      if (cleaned.ok && typeof app !== "string") this.#descriptorLaunchIds.delete(app);

      return cleaned;
    }

    const blockingCleanup = this.#firstPendingCleanup();

    if (blockingCleanup !== undefined) {
      return reject(
        "APP_STOP_CLEANUP_PENDING",
        `app '${blockingCleanup.appId}' has a failed lifecycle awaiting cleanup before '${appId}' can stop.`,
        `/apps/${pathToken(blockingCleanup.appId)}/cleanup`,
      );
    }

    const launch = this.#launches.get(appId);

    if (launch === undefined) {
      return reject(
        "APP_NOT_RUNNING",
        `app '${appId}' is not running.`,
        `/apps/${pathToken(appId)}`,
      );
    }

    const previousWindowModel = this.#windowModel;
    const nextWindowModel = closeWindow(previousWindowModel, launch.windowId);
    const intents = collectWindowManagerIntents(
      previousWindowModel,
      nextWindowModel,
      this.#layoutConstraints,
    );
    const removed = this.#removeSurface(launch.surfaceId);
    const stopped = this.#unbindRuntime(launch.binding);

    if (!removed.ok || !stopped.ok) {
      if (removed.ok || stopped.ok) {
        this.#rememberPendingCleanup(
          appId,
          stopped.ok ? undefined : launch.binding,
          launch.surfaceId,
          launch.windowId,
          !removed.ok,
          true,
          intents,
          undefined,
        );
        this.#launches.delete(appId);
      }

      return rejectStopCleanupFailure(stopped, removed);
    }

    const emitted = this.#emitWindowManagerIntents(intents, `/apps/${pathToken(appId)}/wm`);

    if (!emitted.ok) {
      this.#rememberPendingCleanup(
        appId,
        undefined,
        launch.surfaceId,
        launch.windowId,
        false,
        true,
        intents,
        emitted.progress.maybeLandedIntents,
      );
      this.#launches.delete(appId);
      return reject(emitted.error.code, emitted.error.message, emitted.error.path);
    }

    this.#windowModel = nextWindowModel;
    this.#launches.delete(appId);
    if (typeof app !== "string") this.#descriptorLaunchIds.delete(app);

    return accept(Object.freeze({
      appId,
      intents,
      surfaceId: launch.surfaceId,
      textureId: launch.textureId,
      windowId: launch.windowId,
    }));
  }

  snapshot(): AppHostSnapshot {
    return Object.freeze({
      apps: Object.freeze([...this.#launches.values()].sort(compareLaunches)),
      windowModel: this.#windowModel,
    });
  }

  #resolveStopAppId(app: AppDescriptor | string): AppHostResult<string> {
    if (typeof app === "string") return accept(app);

    const trackedId = this.#descriptorLaunchIds.get(app);

    if (trackedId !== undefined) return accept(trackedId);

    const snapshot = snapshotAppDescriptor(app);

    if (!snapshot.ok) return snapshot;

    return accept(snapshot.value.id);
  }

  #firstPendingCleanup(): PendingAppCleanup | undefined {
    for (const cleanup of this.#pendingCleanup.values()) {
      return cleanup;
    }

    return undefined;
  }

  #bindRuntime(
    app: AppDescriptor,
    surfaceId: string,
    windowId: string,
  ): AppHostResult<AppRuntimeBinding> {
    switch (app.surfaceKind) {
      case "tsx": {
        const port = this.#ports.tsx;

        if (port === undefined) {
          return reject("RUNTIME_PORT_UNAVAILABLE", "TSX render port is not available.", "/ports/tsx");
        }

        return callPortResult(
          () => port.mount(Object.freeze({
            appId: app.id,
            runtime: app.runtime,
            surfaceId,
            surfaceKind: "tsx",
            title: app.title,
            windowId,
          })),
          "RUNTIME_BIND_FAILED",
          "TSX render port failed closed.",
          `/apps/${pathToken(app.id)}/runtime`,
        );
      }
      case "wasm": {
        const port = this.#ports.wasm;

        if (port === undefined) {
          return reject("RUNTIME_PORT_UNAVAILABLE", "WASM capsule runtime port is not available.", "/ports/wasm");
        }

        return callPortResult(
          () => port.launch(Object.freeze({
            appId: app.id,
            runtime: app.runtime,
            surfaceId,
            surfaceKind: "wasm",
            title: app.title,
            windowId,
          })),
          "RUNTIME_BIND_FAILED",
          "WASM capsule runtime port failed closed.",
          `/apps/${pathToken(app.id)}/runtime`,
        );
      }
      case "container": {
        const port = this.#ports.container;

        if (port === undefined) {
          return reject(
            "RUNTIME_PORT_UNAVAILABLE",
            "container capsule runtime port is not available.",
            "/ports/container",
          );
        }

        return callPortResult(
          () => port.launch(Object.freeze({
            appId: app.id,
            runtime: app.runtime,
            surfaceId,
            surfaceKind: "container",
            title: app.title,
            windowId,
          })),
          "RUNTIME_BIND_FAILED",
          "container capsule runtime port failed closed.",
          `/apps/${pathToken(app.id)}/runtime`,
        );
      }
      case "web": {
        const port = this.#ports.webview;

        if (port === undefined) {
          return reject("WEBVIEW_PORT_UNAVAILABLE", "webview port is not available.", "/ports/webview");
        }

        return callPortResult(
          () => port.open(Object.freeze({
            appId: app.id,
            runtime: app.runtime,
            surfaceId,
            surfaceKind: "web",
            title: app.title,
            windowId,
          })),
          "RUNTIME_BIND_FAILED",
          "webview port failed closed.",
          `/apps/${pathToken(app.id)}/runtime`,
        );
      }
    }
  }

  #unbindRuntime(binding: AppRuntimeBinding): AppHostResult<true> {
    switch (binding.surfaceKind) {
      case "tsx": {
        const port = this.#ports.tsx;

        if (port === undefined) {
          return reject("RUNTIME_PORT_UNAVAILABLE", "TSX render port is not available.", "/ports/tsx");
        }

        return callPortResult(
          () => port.unmount(binding),
          "RUNTIME_STOP_FAILED",
          "TSX render port failed closed during stop.",
          `/apps/${pathToken(binding.appId)}/runtime`,
        );
      }
      case "wasm": {
        const port = this.#ports.wasm;

        if (port === undefined) {
          return reject("RUNTIME_PORT_UNAVAILABLE", "WASM capsule runtime port is not available.", "/ports/wasm");
        }

        return callPortResult(
          () => port.stop(binding),
          "RUNTIME_STOP_FAILED",
          "WASM capsule runtime port failed closed during stop.",
          `/apps/${pathToken(binding.appId)}/runtime`,
        );
      }
      case "container": {
        const port = this.#ports.container;

        if (port === undefined) {
          return reject(
            "RUNTIME_PORT_UNAVAILABLE",
            "container capsule runtime port is not available.",
            "/ports/container",
          );
        }

        return callPortResult(
          () => port.stop(binding),
          "RUNTIME_STOP_FAILED",
          "container capsule runtime port failed closed during stop.",
          `/apps/${pathToken(binding.appId)}/runtime`,
        );
      }
      case "web": {
        const port = this.#ports.webview;

        if (port === undefined) {
          return reject("WEBVIEW_PORT_UNAVAILABLE", "webview port is not available.", "/ports/webview");
        }

        return callPortResult(
          () => port.close(binding),
          "RUNTIME_STOP_FAILED",
          "webview port failed closed during stop.",
          `/apps/${pathToken(binding.appId)}/runtime`,
        );
      }
    }
  }

  #createSurface(request: ShellSurfaceCreateRequest): AppHostResult<true> {
    try {
      this.#ports.shell.createSurface(request);
    } catch {
      return reject("SHELL_SURFACE_CREATE_FAILED", "shell surface creation failed closed.", "/shell/surface");
    }

    return accept(true);
  }

  #removeSurface(surfaceId: string): AppHostResult<true> {
    try {
      this.#ports.shell.removeSurface(surfaceId);
    } catch {
      return reject("SHELL_SURFACE_REMOVE_FAILED", "shell surface removal failed closed.", "/shell/surface");
    }

    return accept(true);
  }

  #emitWindowManagerIntents(
    intents: readonly WindowManagerIntent[],
    path: string,
  ): WindowManagerEmitResult {
    const completed: WindowManagerIntent[] = [];
    const requested = freezeIntents(intents);

    for (let index = 0; index < requested.length; index += 1) {
      const intent = requested[index];

      if (intent === undefined) continue;

      try {
        emitWindowManagerIntent(this.#ports.wm, intent);
      } catch {
        const progress = freezeWindowManagerEmitProgress({
          completedIntents: completed,
          failedIntent: intent,
          maybeLandedIntents: [...completed, intent],
          requestedIntents: requested,
        });

        return {
          error: {
            code: "WM_INTENT_FAILED",
            message: "window-manager intent port failed closed.",
            path,
          },
          ok: false,
          progress,
        };
      }

      completed.push(intent);
    }

    return {
      ok: true,
      value: freezeWindowManagerEmitProgress({
        completedIntents: completed,
        maybeLandedIntents: completed,
        requestedIntents: requested,
      }),
    };
  }

  #rollbackSurface(surfaceId: string): AppHostResult<true> {
    return this.#removeSurface(surfaceId);
  }

  #rollbackRuntime(binding: AppRuntimeBinding): AppHostResult<true> {
    return this.#unbindRuntime(binding);
  }

  #rollbackFailedLaunchResources(
    appId: string,
    binding: AppRuntimeBinding,
    surfaceId: string,
    windowId: string,
    surfaceLive: boolean,
    windowCleanupIntents: readonly WindowManagerIntent[] | undefined,
    windowMaybeLandedIntents: readonly WindowManagerIntent[] | undefined,
  ): AppHostResult<true> {
    const runtimeRolledBack = this.#rollbackRuntime(binding);
    const surfaceRolledBack: AppHostResult<true> = surfaceLive
      ? this.#rollbackSurface(surfaceId)
      : accept(true);
    const windowRollbackEmit = windowCleanupIntents === undefined
      ? undefined
      : this.#emitWindowManagerIntents(windowCleanupIntents, `/apps/${pathToken(appId)}/wm-rollback`);
    const windowRolledBack: AppHostResult<true> = windowRollbackEmit === undefined
      ? accept(true)
      : emitResultToAppHostResult(windowRollbackEmit);

    if (runtimeRolledBack.ok && surfaceRolledBack.ok && windowRolledBack.ok) return accept(true);
    const maybeLandedWindowIntents = windowRollbackEmit !== undefined && !windowRollbackEmit.ok
      ? windowRollbackEmit.progress.maybeLandedIntents
      : windowMaybeLandedIntents;

    this.#rememberPendingCleanup(
      appId,
      runtimeRolledBack.ok ? undefined : binding,
      surfaceId,
      windowId,
      surfaceRolledBack.ok ? false : surfaceLive,
      !windowRolledBack.ok,
      windowCleanupIntents,
      maybeLandedWindowIntents,
    );

    return rejectRollbackCleanupFailure(runtimeRolledBack, surfaceRolledBack, windowRolledBack);
  }

  #rememberPendingCleanup(
    appId: string,
    binding: AppRuntimeBinding | undefined,
    surfaceId: string,
    windowId: string,
    surfaceLive: boolean,
    windowOpen: boolean,
    windowCleanupIntents: readonly WindowManagerIntent[] | undefined,
    windowMaybeLandedIntents: readonly WindowManagerIntent[] | undefined,
  ): void {
    const cleanup: {
      appId: string;
      binding?: AppRuntimeBinding;
      surfaceLive: boolean;
      surfaceId: string;
      textureId: string;
      windowId: string;
      windowOpen: boolean;
      windowCleanupIntents?: readonly WindowManagerIntent[];
      windowMaybeLandedIntents?: readonly WindowManagerIntent[];
    } = {
      appId,
      surfaceId,
      surfaceLive,
      textureId: surfaceId,
      windowId,
      windowOpen,
    };

    if (binding !== undefined) cleanup.binding = binding;
    if (windowCleanupIntents !== undefined) {
      cleanup.windowCleanupIntents = freezeIntents(windowCleanupIntents);
    }
    if (windowMaybeLandedIntents !== undefined) {
      cleanup.windowMaybeLandedIntents = freezeIntents(windowMaybeLandedIntents);
    }

    this.#pendingCleanup.set(appId, Object.freeze(cleanup));
  }

  #cleanupPendingApp(cleanup: PendingAppCleanup): AppHostResult<AppStop> {
    const binding = cleanup.binding;
    const stopped: AppHostResult<true> = binding === undefined
      ? accept(true)
      : this.#unbindRuntime(binding);
    const removed: AppHostResult<true> = cleanup.surfaceLive
      ? this.#removeSurface(cleanup.surfaceId)
      : accept(true);

    if (!stopped.ok || !removed.ok) {
      this.#rememberPendingCleanup(
        cleanup.appId,
        stopped.ok ? undefined : binding,
        cleanup.surfaceId,
        cleanup.windowId,
        removed.ok ? false : cleanup.surfaceLive,
        cleanup.windowOpen,
        cleanup.windowCleanupIntents,
        cleanup.windowMaybeLandedIntents,
      );

      return rejectStopCleanupFailure(stopped, removed);
    }

    let intents: readonly WindowManagerIntent[] = Object.freeze([]);

    if (cleanup.windowOpen) {
      const previousWindowModel = this.#windowModel;
      const nextWindowModel = closeWindow(previousWindowModel, cleanup.windowId);
      intents = cleanup.windowCleanupIntents ?? collectWindowManagerIntents(
        previousWindowModel,
        nextWindowModel,
        this.#layoutConstraints,
      );
      const emitted = this.#emitWindowManagerIntents(intents, `/apps/${pathToken(cleanup.appId)}/wm`);
      if (!emitted.ok) {
        this.#rememberPendingCleanup(
          cleanup.appId,
          undefined,
          cleanup.surfaceId,
          cleanup.windowId,
          false,
          true,
          intents,
          emitted.progress.maybeLandedIntents,
        );
        return reject(emitted.error.code, emitted.error.message, emitted.error.path);
      }

      this.#windowModel = nextWindowModel;
    }

    this.#pendingCleanup.delete(cleanup.appId);

    return accept(Object.freeze({
      appId: cleanup.appId,
      intents,
      surfaceId: cleanup.surfaceId,
      textureId: cleanup.textureId,
      windowId: cleanup.windowId,
    }));
  }
}

export function appSurfaceId(appId: string): string {
  return `surface:vita.app:${pathToken(appId)}`;
}

export function appWindowId(appId: string): string {
  return `window:${appId}`;
}

function snapshotAppDescriptor(value: unknown): AppHostResult<AppDescriptor> {
  const normalized = safeNormalize(value);

  if (!normalized.ok || !isPlainJsonObject(normalized.value)) {
    return invalidAppDescriptor("app descriptor must be a plain data object.", "/apps");
  }

  const descriptor = normalized.value;
  const fields = expectOnlyFields(descriptor, APP_DESCRIPTOR_FIELDS, "/apps");

  if (!fields.ok) return fields;

  const id = requiredStringField(descriptor, "id", "/apps/id");

  if (!id.ok) return id;
  if (id.value.length === 0) {
    return reject(
      "APP_ID_INVALID",
      "app id must not be empty.",
      "/apps",
    );
  }

  const title = requiredStringField(descriptor, "title", "/apps/title");

  if (!title.ok) return title;

  const surfaceKind = requiredStringField(descriptor, "surfaceKind", "/apps/surfaceKind");

  if (!surfaceKind.ok) return surfaceKind;

  const defaultWindow = optionalWindowHintsField(descriptor, "defaultWindow", "/apps/defaultWindow");

  if (!defaultWindow.ok) return defaultWindow;

  const runtimeValue = field(descriptor, "runtime");

  switch (surfaceKind.value) {
    case "tsx": {
      const runtime = snapshotTsxRuntime(runtimeValue, "/apps/runtime");

      if (!runtime.ok) return runtime;

      const output: {
        id: string;
        title: string;
        surfaceKind: "tsx";
        runtime: TsxComponentRef;
        defaultWindow?: AppWindowHints;
      } = {
        id: id.value,
        runtime: runtime.value,
        surfaceKind: "tsx",
        title: title.value,
      };

      if (defaultWindow.value !== undefined) output.defaultWindow = defaultWindow.value;

      return accept(Object.freeze(output));
    }
    case "wasm": {
      const runtime = snapshotCapsuleRuntime(runtimeValue, "/apps/runtime");

      if (!runtime.ok) return runtime;

      const output: {
        id: string;
        title: string;
        surfaceKind: "wasm";
        runtime: CapsuleRuntimeRef;
        defaultWindow?: AppWindowHints;
      } = {
        id: id.value,
        runtime: runtime.value,
        surfaceKind: "wasm",
        title: title.value,
      };

      if (defaultWindow.value !== undefined) output.defaultWindow = defaultWindow.value;

      return accept(Object.freeze(output));
    }
    case "container": {
      const runtime = snapshotCapsuleRuntime(runtimeValue, "/apps/runtime");

      if (!runtime.ok) return runtime;

      const output: {
        id: string;
        title: string;
        surfaceKind: "container";
        runtime: CapsuleRuntimeRef;
        defaultWindow?: AppWindowHints;
      } = {
        id: id.value,
        runtime: runtime.value,
        surfaceKind: "container",
        title: title.value,
      };

      if (defaultWindow.value !== undefined) output.defaultWindow = defaultWindow.value;

      return accept(Object.freeze(output));
    }
    case "web": {
      const runtime = snapshotWebviewRuntime(runtimeValue, "/apps/runtime");

      if (!runtime.ok) return runtime;

      const output: {
        id: string;
        title: string;
        surfaceKind: "web";
        runtime: WebviewRuntimeRef;
        defaultWindow?: AppWindowHints;
      } = {
        id: id.value,
        runtime: runtime.value,
        surfaceKind: "web",
        title: title.value,
      };

      if (defaultWindow.value !== undefined) output.defaultWindow = defaultWindow.value;

      return accept(Object.freeze(output));
    }
    default:
      return invalidAppDescriptor(
        "app surfaceKind must be one of tsx, wasm, container, or web.",
        "/apps/surfaceKind",
      );
  }
}

function snapshotTsxRuntime(
  value: PlainJson | undefined,
  path: string,
): AppHostResult<TsxComponentRef> {
  if (!isPlainJsonObject(value)) {
    return invalidAppDescriptor("tsx runtime must be a plain data object.", path);
  }

  const fields = expectOnlyFields(value, TSX_RUNTIME_FIELDS, path);

  if (!fields.ok) return fields;

  const componentId = requiredStringField(value, "componentId", `${path}/componentId`);

  if (!componentId.ok) return componentId;

  const propsValue = field(value, "props");
  const output: {
    componentId: string;
    props?: PlainJsonObject;
  } = {
    componentId: componentId.value,
  };

  if (propsValue !== undefined) {
    if (!isPlainJsonObject(propsValue)) {
      return invalidAppDescriptor("tsx runtime props must be a plain data object.", `${path}/props`);
    }

    output.props = propsValue;
  }

  return accept(Object.freeze(output));
}

function snapshotCapsuleRuntime(
  value: PlainJson | undefined,
  path: string,
): AppHostResult<CapsuleRuntimeRef> {
  if (!isPlainJsonObject(value)) {
    return invalidAppDescriptor("capsule runtime must be a plain data object.", path);
  }

  const fields = expectOnlyFields(value, CAPSULE_RUNTIME_FIELDS, path);

  if (!fields.ok) return fields;

  const id = requiredStringField(value, "id", `${path}/id`);
  const version = requiredStringField(value, "version", `${path}/version`);
  const integrity = requiredStringField(value, "integrity", `${path}/integrity`);
  const ref = requiredStringField(value, "ref", `${path}/ref`);
  const entrypoint = optionalStringField(value, "entrypoint", `${path}/entrypoint`);

  if (!id.ok) return id;
  if (!version.ok) return version;
  if (!integrity.ok) return integrity;
  if (!ref.ok) return ref;
  if (!entrypoint.ok) return entrypoint;

  const output: {
    id: string;
    version: string;
    integrity: string;
    ref: string;
    entrypoint?: string;
  } = {
    id: id.value,
    integrity: integrity.value,
    ref: ref.value,
    version: version.value,
  };

  if (entrypoint.value !== undefined) output.entrypoint = entrypoint.value;

  return accept(Object.freeze(output));
}

function snapshotWebviewRuntime(
  value: PlainJson | undefined,
  path: string,
): AppHostResult<WebviewRuntimeRef> {
  if (!isPlainJsonObject(value)) {
    return invalidAppDescriptor("webview runtime must be a plain data object.", path);
  }

  const fields = expectOnlyFields(value, WEBVIEW_RUNTIME_FIELDS, path);

  if (!fields.ok) return fields;

  const url = requiredStringField(value, "url", `${path}/url`);
  const partition = optionalStringField(value, "partition", `${path}/partition`);

  if (!url.ok) return url;
  if (!partition.ok) return partition;

  const output: {
    url: string;
    partition?: string;
  } = {
    url: url.value,
  };

  if (partition.value !== undefined) output.partition = partition.value;

  return accept(Object.freeze(output));
}

function optionalWindowHintsField(
  value: PlainJsonObject,
  key: string,
  path: string,
): AppHostResult<AppWindowHints | undefined> {
  const hints = field(value, key);

  if (hints === undefined) return accept(undefined);
  if (!isPlainJsonObject(hints)) {
    return invalidAppDescriptor("defaultWindow must be a plain data object.", path);
  }

  const fields = expectOnlyFields(hints, APP_WINDOW_HINT_FIELDS, path);

  if (!fields.ok) return fields;

  const workspaceId = optionalStringField(hints, "workspaceId", `${path}/workspaceId`);
  const mode = optionalWindowModeField(hints, "mode", `${path}/mode`);
  const zone = optionalStringField(hints, "zone", `${path}/zone`);
  const layer = optionalStringField(hints, "layer", `${path}/layer`);
  const order = optionalNumberField(hints, "order", `${path}/order`);
  const anchor = optionalStringField(hints, "anchor", `${path}/anchor`);
  const className = optionalStringField(hints, "className", `${path}/className`);
  const rect = optionalRectField(hints, "rect", `${path}/rect`);

  if (!workspaceId.ok) return workspaceId;
  if (!mode.ok) return mode;
  if (!zone.ok) return zone;
  if (!layer.ok) return layer;
  if (!order.ok) return order;
  if (!anchor.ok) return anchor;
  if (!className.ok) return className;
  if (!rect.ok) return rect;

  const output: {
    workspaceId?: string;
    rect?: Rect;
    mode?: WindowMode;
    zone?: string;
    layer?: string;
    order?: number;
    anchor?: string;
    className?: string;
  } = {};

  if (workspaceId.value !== undefined) output.workspaceId = workspaceId.value;
  if (rect.value !== undefined) output.rect = rect.value;
  if (mode.value !== undefined) output.mode = mode.value;
  if (zone.value !== undefined) output.zone = zone.value;
  if (layer.value !== undefined) output.layer = layer.value;
  if (order.value !== undefined) output.order = order.value;
  if (anchor.value !== undefined) output.anchor = anchor.value;
  if (className.value !== undefined) output.className = className.value;

  return accept(Object.freeze(output));
}

function optionalRectField(
  value: PlainJsonObject,
  key: string,
  path: string,
): AppHostResult<Rect | undefined> {
  const rect = field(value, key);

  if (rect === undefined) return accept(undefined);
  if (!isPlainJsonObject(rect)) {
    return invalidAppDescriptor("window rect must be a plain data object.", path);
  }

  const fields = expectOnlyFields(rect, RECT_FIELDS, path);

  if (!fields.ok) return fields;

  const x = requiredNumberField(rect, "x", `${path}/x`);
  const y = requiredNumberField(rect, "y", `${path}/y`);
  const width = requiredNumberField(rect, "width", `${path}/width`);
  const height = requiredNumberField(rect, "height", `${path}/height`);

  if (!x.ok) return x;
  if (!y.ok) return y;
  if (!width.ok) return width;
  if (!height.ok) return height;

  return accept(freezeRect({
    height: height.value,
    width: width.value,
    x: x.value,
    y: y.value,
  }));
}

function requiredStringField(
  value: PlainJsonObject,
  key: string,
  path: string,
): AppHostResult<string> {
  const current = field(value, key);

  if (typeof current !== "string") {
    return invalidAppDescriptor(`${key} must be a string.`, path);
  }

  return accept(current);
}

function optionalStringField(
  value: PlainJsonObject,
  key: string,
  path: string,
): AppHostResult<string | undefined> {
  const current = field(value, key);

  if (current === undefined) return accept(undefined);
  if (typeof current !== "string") {
    return invalidAppDescriptor(`${key} must be a string when present.`, path);
  }

  return accept(current);
}

function requiredNumberField(
  value: PlainJsonObject,
  key: string,
  path: string,
): AppHostResult<number> {
  const current = field(value, key);

  if (typeof current !== "number") {
    return invalidAppDescriptor(`${key} must be a number.`, path);
  }

  return accept(current);
}

function optionalNumberField(
  value: PlainJsonObject,
  key: string,
  path: string,
): AppHostResult<number | undefined> {
  const current = field(value, key);

  if (current === undefined) return accept(undefined);
  if (typeof current !== "number") {
    return invalidAppDescriptor(`${key} must be a number when present.`, path);
  }

  return accept(current);
}

function optionalWindowModeField(
  value: PlainJsonObject,
  key: string,
  path: string,
): AppHostResult<WindowMode | undefined> {
  const current = field(value, key);

  if (current === undefined) return accept(undefined);
  if (current !== "floating" && current !== "tiled") {
    return invalidAppDescriptor("window mode must be floating or tiled when present.", path);
  }

  return accept(current);
}

function expectOnlyFields(
  value: PlainJsonObject,
  allowed: ReadonlySet<string>,
  path: string,
): AppHostResult<true> {
  const keys = Reflect.ownKeys(value);

  for (let index = 0; index < keys.length; index += 1) {
    const key = keys[index];

    if (key === undefined || typeof key === "symbol" || !allowed.has(key)) {
      return invalidAppDescriptor("app descriptor contains an unsupported field.", path);
    }
  }

  return accept(true);
}

function field(value: PlainJsonObject, key: string): PlainJson | undefined {
  if (!Object.prototype.hasOwnProperty.call(value, key)) return undefined;

  return value[key];
}

function isPlainJsonObject(value: PlainJson | undefined): value is PlainJsonObject {
  return value !== undefined && value !== null && typeof value === "object" && !Array.isArray(value);
}

function invalidAppDescriptor<T>(message: string, path: string): AppHostResult<T> {
  return reject("APP_DESCRIPTOR_INVALID", message, path);
}

function buildWindowOpenRequest(
  app: AppDescriptor,
  surfaceId: string,
  windowId: string,
): WindowOpenRequest {
  const hints = app.defaultWindow;
  const request: {
    id: string;
    textureId: string;
    rect: Rect;
    mode: WindowMode;
    workspaceId?: string;
  } = {
    id: windowId,
    mode: hints?.mode ?? "floating",
    rect: freezeRect(hints?.rect ?? DEFAULT_RECT),
    textureId: surfaceId,
  };

  if (hints?.workspaceId !== undefined) request.workspaceId = hints.workspaceId;

  return Object.freeze(request);
}

function buildSurfaceCreateRequest(
  app: AppDescriptor,
  binding: AppRuntimeBinding,
  surfaceId: string,
): ShellSurfaceCreateRequest {
  return Object.freeze({
    className: app.defaultWindow?.className ?? `vita-windowed-app vita-app-${app.surfaceKind}`,
    componentId: VITA_WINDOWED_APP_COMPONENT_ID,
    path: `apps.${pathToken(app.id)}`,
    payload: buildSurfacePayload(app, binding),
    placement: resolveShellPlacement(app.defaultWindow),
    role: "window",
    surfaceId,
  });
}

function buildSurfacePayload(
  app: AppDescriptor,
  binding: AppRuntimeBinding,
): PlainJsonObject {
  const output: Record<string, PlainJson> = {
    appId: app.id,
    bindingId: binding.bindingId,
    kind: "windowed-app",
    runtimeId: binding.runtimeId,
    surfaceKind: app.surfaceKind,
    title: app.title,
    windowed: true,
  };

  if (binding.metadata !== undefined) output["metadata"] = binding.metadata;

  switch (app.surfaceKind) {
    case "tsx":
      output["componentId"] = app.runtime.componentId;
      if (app.runtime.props !== undefined) output["props"] = app.runtime.props;
      break;
    case "wasm":
    case "container":
      output["capsuleId"] = app.runtime.id;
      output["capsuleVersion"] = app.runtime.version;
      break;
    case "web":
      output["url"] = app.runtime.url;
      break;
  }

  return Object.freeze(output);
}

function resolveShellPlacement(hints: AppWindowHints | undefined): ShellPlacement {
  const placement: {
    zone: string;
    layer: string;
    order: number;
    anchor?: string;
    workspace?: string;
    rect?: Rect;
  } = {
    layer: hints?.layer ?? DEFAULT_SHELL_PLACEMENT.layer,
    order: hints?.order ?? DEFAULT_SHELL_PLACEMENT.order,
    zone: hints?.zone ?? DEFAULT_SHELL_PLACEMENT.zone,
  };

  if (hints?.anchor !== undefined) placement.anchor = hints.anchor;
  if (hints?.workspaceId !== undefined) placement.workspace = hints.workspaceId;
  if (hints?.rect !== undefined) placement.rect = freezeRect(hints.rect);

  return Object.freeze(placement);
}

function freezeLaunch(input: {
  readonly app: AppDescriptor;
  readonly binding: AppRuntimeBinding;
  readonly surfaceId: string;
  readonly windowId: string;
  readonly textureId: string;
  readonly surfaceRequest: ShellSurfaceCreateRequest;
  readonly intents: readonly WindowManagerIntent[];
}): AppLaunch {
  return Object.freeze({
    app: input.app,
    binding: input.binding,
    intents: Object.freeze([...input.intents]),
    surfaceId: input.surfaceId,
    surfaceRequest: input.surfaceRequest,
    textureId: input.textureId,
    windowId: input.windowId,
  });
}

function emitWindowManagerIntent(
  port: WindowManagerSubstratePort,
  intent: WindowManagerIntent,
): void {
  switch (intent.type) {
    case "repositionTexture":
      port.repositionTexture(intent.textureId, intent.rect, intent.windowId);
      break;
    case "setFocus":
      port.setFocus(intent.windowId);
      break;
    case "setTextureVisibility":
      if (port.setTextureVisibility !== undefined) {
        port.setTextureVisibility(intent.textureId, intent.visible, intent.windowId);
      }
      break;
  }
}

function freezeWindowManagerEmitProgress(input: {
  readonly requestedIntents: readonly WindowManagerIntent[];
  readonly completedIntents: readonly WindowManagerIntent[];
  readonly maybeLandedIntents: readonly WindowManagerIntent[];
  readonly failedIntent?: WindowManagerIntent;
}): WindowManagerEmitProgress {
  const output: {
    requestedIntents: readonly WindowManagerIntent[];
    completedIntents: readonly WindowManagerIntent[];
    maybeLandedIntents: readonly WindowManagerIntent[];
    failedIntent?: WindowManagerIntent;
  } = {
    completedIntents: freezeIntents(input.completedIntents),
    maybeLandedIntents: freezeIntents(input.maybeLandedIntents),
    requestedIntents: freezeIntents(input.requestedIntents),
  };

  if (input.failedIntent !== undefined) output.failedIntent = input.failedIntent;

  return Object.freeze(output);
}

function emitResultToAppHostResult(result: WindowManagerEmitResult): AppHostResult<true> {
  if (result.ok) return accept(true);

  return reject(result.error.code, result.error.message, result.error.path);
}

function freezeIntents(intents: readonly WindowManagerIntent[]): readonly WindowManagerIntent[] {
  return Object.freeze([...intents]);
}

function freezeRect(rect: Rect): Rect {
  return Object.freeze({
    height: normalizeDimension(rect.height),
    width: normalizeDimension(rect.width),
    x: normalizeNumber(rect.x),
    y: normalizeNumber(rect.y),
  });
}

function normalizeDimension(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0;
}

function normalizeNumber(value: number): number {
  return Number.isFinite(value) ? Math.trunc(value) : 0;
}

function callPortResult<T>(
  operation: () => AppHostResult<T>,
  code: string,
  message: string,
  path: string,
): AppHostResult<T> {
  try {
    return operation();
  } catch {
    return reject(code, message, path);
  }
}

function pathToken(value: string): string {
  let token = "";

  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    const isAlphaNumeric =
      (code >= 48 && code <= 57) ||
      (code >= 65 && code <= 90) ||
      (code >= 97 && code <= 122);

    if (isAlphaNumeric || code === 45 || code === 46) {
      token += value[index] ?? "";
    } else {
      token += `_${code.toString(16).padStart(4, "0")}`;
    }
  }

  return token;
}

function compareLaunches(left: AppLaunch, right: AppLaunch): number {
  if (left.app.id < right.app.id) return -1;
  if (left.app.id > right.app.id) return 1;

  return 0;
}

function accept<T>(value: T): AppHostResult<T> {
  return {
    ok: true,
    value,
  };
}

function reject<T>(code: string, message: string, path: string): AppHostResult<T> {
  return {
    error: {
      code,
      message,
      path,
    },
    ok: false,
  };
}

function rejectRollbackFailure<T>(
  cause: AppHostError,
  rollback: AppHostError,
): AppHostResult<T> {
  return reject(
    "LAUNCH_ROLLBACK_FAILED",
    `launch failed with ${cause.code}; rollback failed with ${rollback.code}: ${rollback.message}`,
    rollback.path,
  );
}

function rejectRollbackCleanupFailure(
  runtimeRolledBack: AppHostResult<true>,
  surfaceRolledBack: AppHostResult<true>,
  windowRolledBack: AppHostResult<true> = accept(true),
): AppHostResult<true> {
  const failures: AppHostError[] = [];

  if (!runtimeRolledBack.ok) failures.push(runtimeRolledBack.error);
  if (!surfaceRolledBack.ok) failures.push(surfaceRolledBack.error);
  if (!windowRolledBack.ok) failures.push(windowRolledBack.error);

  const first = failures[0];

  if (first === undefined) return accept(true);

  return reject(
    "ROLLBACK_CLEANUP_FAILED",
    `rollback cleanup failed: ${failures
      .map((failure) => `${failure.code}: ${failure.message}`)
      .join("; ")}`,
    first.path,
  );
}

function rejectStopCleanupFailure<T>(
  runtimeStopped: AppHostResult<true>,
  surfaceRemoved: AppHostResult<true>,
): AppHostResult<T> {
  const failures: AppHostError[] = [];

  if (!surfaceRemoved.ok) failures.push(surfaceRemoved.error);
  if (!runtimeStopped.ok) failures.push(runtimeStopped.error);

  const first = failures[0];

  if (first === undefined) {
    return reject(
      "STOP_CLEANUP_FAILED",
      "stop cleanup failed without a recorded failure.",
      "/apps",
    );
  }
  if (failures.length === 1) return reject(first.code, first.message, first.path);

  return reject(
    "STOP_CLEANUP_FAILED",
    `stop cleanup failed: ${failures
      .map((failure) => `${failure.code}: ${failure.message}`)
      .join("; ")}`,
    first.path,
  );
}
