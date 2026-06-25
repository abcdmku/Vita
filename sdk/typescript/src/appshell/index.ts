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
  emitWindowManagerIntents,
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
}

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

export class AppHost {
  readonly #ports: AppHostPorts;
  readonly #layoutConstraints: LayoutConstraints;
  readonly #launches = new Map<string, AppLaunch>();
  readonly #pendingCleanups = new Map<string, PendingAppCleanup>();
  #windowModel: WindowModel;

  constructor(options: AppHostOptions) {
    this.#ports = options.ports;
    this.#layoutConstraints = options.layoutConstraints ?? DEFAULT_LAYOUT_CONSTRAINTS;
    this.#windowModel = options.initialWindowModel ?? createWindowModel();
  }

  launch(app: AppDescriptor): AppHostResult<AppLaunch> {
    if (this.#launches.has(app.id)) {
      return reject(
        "APP_ALREADY_RUNNING",
        `app '${app.id}' is already running.`,
        `/apps/${pathToken(app.id)}`,
      );
    }

    if (this.#pendingCleanups.has(app.id)) {
      return reject(
        "APP_LAUNCH_CLEANUP_PENDING",
        `app '${app.id}' has a failed launch awaiting cleanup.`,
        `/apps/${pathToken(app.id)}`,
      );
    }

    const surfaceId = appSurfaceId(app.id);
    const windowId = appWindowId(app.id);
    const runtime = this.#bindRuntime(app, surfaceId, windowId);

    if (!runtime.ok) return runtime;

    const surfaceRequest = buildSurfaceCreateRequest(app, runtime.value, surfaceId);
    const createdSurface = this.#createSurface(surfaceRequest);

    if (!createdSurface.ok) {
      const rolledBack = this.#rollbackFailedLaunchResources(
        app.id,
        runtime.value,
        surfaceId,
        windowId,
        false,
      );

      if (!rolledBack.ok) {
        return rejectRollbackFailure(createdSurface.error, rolledBack.error);
      }

      return createdSurface;
    }

    const previousWindowModel = this.#windowModel;
    const nextWindowModel = openWindow(
      previousWindowModel,
      buildWindowOpenRequest(app, surfaceId, windowId),
    );
    const intents = collectWindowManagerIntents(
      previousWindowModel,
      nextWindowModel,
      this.#layoutConstraints,
    );
    const emitted = this.#emitWindowManagerIntents(intents, `/apps/${pathToken(app.id)}/wm`);

    if (!emitted.ok) {
      const rolledBack = this.#rollbackFailedLaunchResources(
        app.id,
        runtime.value,
        surfaceId,
        windowId,
        true,
      );

      if (!rolledBack.ok) return rejectRollbackFailure(emitted.error, rolledBack.error);

      return emitted;
    }

    this.#windowModel = nextWindowModel;

    const launch = freezeLaunch({
      app,
      binding: runtime.value,
      intents,
      surfaceId,
      surfaceRequest,
      textureId: surfaceId,
      windowId,
    });
    this.#launches.set(app.id, launch);

    return accept(launch);
  }

  stop(app: AppDescriptor | string): AppHostResult<AppStop> {
    const appId = typeof app === "string" ? app : app.id;
    const launch = this.#launches.get(appId);

    if (launch === undefined) {
      const pendingCleanup = this.#pendingCleanups.get(appId);

      if (pendingCleanup !== undefined) return this.#cleanupPendingApp(pendingCleanup);

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
    const stopped = this.#unbindRuntime(launch.binding);

    if (!stopped.ok) return stopped;

    const removed = this.#removeSurface(launch.surfaceId);

    if (!removed.ok) {
      this.#launches.delete(appId);
      this.#rememberPendingCleanup(appId, undefined, launch.surfaceId, launch.windowId, true, true);
      return removed;
    }

    const emitted = this.#emitWindowManagerIntents(intents, `/apps/${pathToken(appId)}/wm`);

    this.#windowModel = nextWindowModel;
    this.#launches.delete(appId);
    if (!emitted.ok) return emitted;

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
  ): AppHostResult<true> {
    try {
      emitWindowManagerIntents(this.#ports.wm, intents);
    } catch {
      return reject("WM_INTENT_FAILED", "window-manager intent port failed closed.", path);
    }

    return accept(true);
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
  ): AppHostResult<true> {
    const runtimeRolledBack = this.#rollbackRuntime(binding);
    const surfaceRolledBack: AppHostResult<true> = surfaceLive
      ? this.#rollbackSurface(surfaceId)
      : accept(true);

    if (runtimeRolledBack.ok && surfaceRolledBack.ok) return accept(true);

    this.#rememberPendingCleanup(
      appId,
      runtimeRolledBack.ok ? undefined : binding,
      surfaceId,
      windowId,
      surfaceRolledBack.ok ? false : surfaceLive,
      false,
    );

    return rejectRollbackCleanupFailure(runtimeRolledBack, surfaceRolledBack);
  }

  #rememberPendingCleanup(
    appId: string,
    binding: AppRuntimeBinding | undefined,
    surfaceId: string,
    windowId: string,
    surfaceLive: boolean,
    windowOpen: boolean,
  ): void {
    const cleanup: {
      appId: string;
      binding?: AppRuntimeBinding;
      surfaceLive: boolean;
      surfaceId: string;
      textureId: string;
      windowId: string;
      windowOpen: boolean;
    } = {
      appId,
      surfaceId,
      surfaceLive,
      textureId: surfaceId,
      windowId,
      windowOpen,
    };

    if (binding !== undefined) cleanup.binding = binding;

    this.#pendingCleanups.set(appId, Object.freeze(cleanup));
  }

  #cleanupPendingApp(cleanup: PendingAppCleanup): AppHostResult<AppStop> {
    const binding = cleanup.binding;

    if (binding !== undefined) {
      const stopped = this.#unbindRuntime(binding);

      if (!stopped.ok) return stopped;
    }

    const removed = cleanup.surfaceLive ? this.#removeSurface(cleanup.surfaceId) : accept(true);

    if (!removed.ok) {
      this.#rememberPendingCleanup(
        cleanup.appId,
        undefined,
        cleanup.surfaceId,
        cleanup.windowId,
        true,
        cleanup.windowOpen,
      );

      return removed;
    }

    let intents: readonly WindowManagerIntent[] = Object.freeze([]);
    let emitted: AppHostResult<true> = accept(true);

    if (cleanup.windowOpen) {
      const previousWindowModel = this.#windowModel;
      const nextWindowModel = closeWindow(previousWindowModel, cleanup.windowId);
      intents = collectWindowManagerIntents(
        previousWindowModel,
        nextWindowModel,
        this.#layoutConstraints,
      );
      emitted = this.#emitWindowManagerIntents(intents, `/apps/${pathToken(cleanup.appId)}/wm`);
      this.#windowModel = nextWindowModel;
    }

    this.#pendingCleanups.delete(cleanup.appId);

    if (!emitted.ok) return emitted;

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

    if (isAlphaNumeric || code === 45 || code === 46 || code === 95) {
      token += value[index] ?? "";
    } else {
      token += `_${code.toString(16).padStart(4, "0")}`;
    }
  }

  return token.length === 0 ? "app" : token;
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
): AppHostResult<true> {
  const failures: AppHostError[] = [];

  if (!runtimeRolledBack.ok) failures.push(runtimeRolledBack.error);
  if (!surfaceRolledBack.ok) failures.push(surfaceRolledBack.error);

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
