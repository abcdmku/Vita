import {
  appSurfaceId,
  appWindowId,
} from "../appshell/index.ts";
import type {
  AppWindowHints,
} from "../appshell/index.ts";
import {
  safeNormalize,
} from "../safe-normalize.ts";
import type {
  PlainJson,
  PlainJsonObject,
} from "../safe-normalize.ts";
import {
  closeWindow,
  collectWindowManagerIntents,
  computeWindowManagerIntents,
  createWindowModel,
  openWindow,
} from "../wm/policy.ts";
import type {
  LayoutConstraints,
  Rect,
  WindowManagerIntent,
  WindowModel,
  WindowOpenRequest,
} from "../wm/policy.ts";
import type {
  AgentdHostClient,
  AgentdHostResult,
} from "./agentd-host-client.ts";
import {
  hasDesktopCapabilityGrant,
} from "./loader.ts";
import type {
  DesktopAppLaunch,
  DesktopAppStop,
  DesktopCapabilityGrant,
  DesktopHostError,
  DesktopHostResult,
  DesktopLaunchableApp,
  DesktopUiPackageManifest,
} from "./ui-package.ts";

export interface DesktopAppCapsuleDescriptor {
  readonly id: string;
  readonly version: string;
  readonly integrity: string;
}

export interface DesktopAppCapsuleDescriptors {
  readonly tsx?: DesktopAppCapsuleDescriptor;
  readonly web?: DesktopAppCapsuleDescriptor;
}

export interface DesktopAppsBackendOptions {
  readonly package: DesktopUiPackageManifest;
  readonly agentd?: AgentdHostClient | null;
  readonly capsuleDescriptors?: DesktopAppCapsuleDescriptors;
  readonly initialWindowModel?: WindowModel;
  readonly layoutConstraints?: LayoutConstraints;
  readonly emitLaunch?: (launch: DesktopAppLaunch) => void;
  readonly emitStop?: (stop: DesktopAppStop) => void;
}

export interface DesktopAppsBackendSnapshot {
  readonly launched: readonly DesktopAppLaunch[];
  readonly windowModel: WindowModel;
}

export interface DesktopAppsBackend {
  readonly package: DesktopUiPackageManifest;
  launchApp(app: DesktopLaunchableApp): Promise<DesktopHostResult<DesktopAppLaunch>>;
  stopApp(appId: string): Promise<DesktopHostResult<DesktopAppStop>>;
  snapshot(): DesktopAppsBackendSnapshot;
}

interface RunningApp {
  readonly capsule: DesktopAppCapsuleDescriptor;
  readonly launch: DesktopAppLaunch;
}

type AgentdCallResult =
  | {
      readonly ok: true;
    }
  | {
      readonly ok: false;
      readonly error: DesktopHostError;
    };

const CAPSULE_EXECUTE_CAPABILITY = "capsule.execute";
const CAPSULE_LIFECYCLE_CAPABILITY = "capsule.lifecycle";
const DEFAULT_LAYOUT_CONSTRAINTS = Object.freeze({
  bounds: Object.freeze({
    height: 800,
    width: 1280,
    x: 0,
    y: 0,
  }),
  gap: 0,
}) satisfies LayoutConstraints;
const DEFAULT_WINDOW_RECT = Object.freeze({
  height: 480,
  width: 640,
  x: 0,
  y: 0,
}) satisfies Rect;
const DEFAULT_CAPSULE_INTEGRITY = "sha256-47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU=";
const DEFAULT_CAPSULE_DESCRIPTORS = Object.freeze({
  tsx: Object.freeze({
    id: "vita.desktop.tsx",
    integrity: DEFAULT_CAPSULE_INTEGRITY,
    version: "1.0.0",
  }),
  web: Object.freeze({
    id: "vita.desktop.web",
    integrity: DEFAULT_CAPSULE_INTEGRITY,
    version: "1.0.0",
  }),
}) satisfies Required<DesktopAppCapsuleDescriptors>;
const APP_DESCRIPTOR_FIELDS = Object.freeze(["defaultWindow", "id", "runtime", "surfaceKind", "title"]);
const TSX_RUNTIME_FIELDS = Object.freeze(["componentId", "props"]);
const WEB_RUNTIME_FIELDS = Object.freeze(["partition", "url"]);
const APP_WINDOW_FIELDS = Object.freeze(["anchor", "className", "layer", "mode", "order", "rect", "workspaceId", "zone"]);
const RECT_FIELDS = Object.freeze(["height", "width", "x", "y"]);

export function createDesktopAppsBackend(options: DesktopAppsBackendOptions): DesktopAppsBackend {
  return new StatefulDesktopAppsBackend(options);
}

class StatefulDesktopAppsBackend implements DesktopAppsBackend {
  readonly #agentd: AgentdHostClient | undefined;
  readonly #capsules: Required<DesktopAppCapsuleDescriptors>;
  readonly #emitLaunch: ((launch: DesktopAppLaunch) => void) | undefined;
  readonly #emitStop: ((stop: DesktopAppStop) => void) | undefined;
  readonly #launched = new Map<string, RunningApp>();
  readonly #layoutConstraints: LayoutConstraints;
  readonly #package: DesktopUiPackageManifest;
  #windowModel: WindowModel;

  constructor(options: DesktopAppsBackendOptions) {
    this.#agentd = options.agentd ?? undefined;
    this.#capsules = freezeCapsuleDescriptors(options.capsuleDescriptors);
    this.#emitLaunch = options.emitLaunch;
    this.#emitStop = options.emitStop;
    this.#layoutConstraints = freezeLayoutConstraints(options.layoutConstraints ?? DEFAULT_LAYOUT_CONSTRAINTS);
    this.#package = snapshotPackage(options.package);
    this.#windowModel = options.initialWindowModel ?? createWindowModel();
  }

  get package(): DesktopUiPackageManifest {
    return this.#package;
  }

  async launchApp(app: DesktopLaunchableApp): Promise<DesktopHostResult<DesktopAppLaunch>> {
    const snapshot = snapshotLaunchableApp(app);

    if (!snapshot.ok) return snapshot;

    const appSnapshot = snapshot.value;

    if (!hasDesktopCapabilityGrant(this.#package, "apps.launch", appSnapshot.id)) {
      return hostReject(
        "APP_LAUNCH_CAPABILITY_DENIED",
        "host package is missing the apps.launch grant for this app.",
        `/apps/${pathToken(appSnapshot.id)}/launch`,
      );
    }

    if (this.#agentd === undefined) {
      return hostReject(
        "APP_AGENTD_UNAVAILABLE",
        "agentd host transport is unavailable.",
        "/agentd",
      );
    }

    if (this.#launched.has(appSnapshot.id)) {
      return hostReject(
        "APP_ALREADY_RUNNING",
        "app is already running.",
        `/apps/${pathToken(appSnapshot.id)}`,
      );
    }

    const capsule = this.#capsules[appSnapshot.surfaceKind];
    const started = await callAgentd(
      this.#agentd,
      CAPSULE_EXECUTE_CAPABILITY,
      capsuleExecuteRequest(capsule),
      "APP_CAPSULE_EXECUTE_FAILED",
      `/apps/${pathToken(appSnapshot.id)}/capsule.execute`,
    );

    if (!started.ok) return hostRejectFromError(started.error);

    const surfaceId = appSurfaceId(appSnapshot.id);
    const windowId = appWindowId(appSnapshot.id);
    const textureId = appTextureId(appSnapshot.id);
    const previousWindowModel = this.#windowModel;
    const nextWindowModel = openWindow(
      previousWindowModel,
      buildWindowOpenRequest(appSnapshot.defaultWindow, windowId, textureId),
    );
    const intents = computeWindowManagerIntents(
      previousWindowModel,
      nextWindowModel,
      this.#layoutConstraints,
    );
    const launch = freezeLaunch(appSnapshot, surfaceId, windowId, textureId, intents);

    this.#windowModel = nextWindowModel;
    this.#launched.set(appSnapshot.id, Object.freeze({
      capsule,
      launch,
    }));
    emitLaunch(this.#emitLaunch, launch);

    return hostAccept(launch);
  }

  async stopApp(appId: string): Promise<DesktopHostResult<DesktopAppStop>> {
    if (typeof appId !== "string" || appId.length === 0) {
      return hostReject(
        "APP_ID_INVALID",
        "stopApp requires a non-empty app id.",
        "/stopApp/appId",
      );
    }

    if (!hasDesktopCapabilityGrant(this.#package, "apps.stop", appId)) {
      return hostReject(
        "APP_STOP_CAPABILITY_DENIED",
        "host package is missing the apps.stop grant for this app.",
        `/apps/${pathToken(appId)}/stop`,
      );
    }

    if (this.#agentd === undefined) {
      return hostReject(
        "APP_AGENTD_UNAVAILABLE",
        "agentd host transport is unavailable.",
        "/agentd",
      );
    }

    const running = this.#launched.get(appId);

    if (running === undefined) {
      return hostAccept(freezeStop({
        appId,
        intents: Object.freeze([]),
      }));
    }

    const stopped = await callAgentd(
      this.#agentd,
      CAPSULE_LIFECYCLE_CAPABILITY,
      capsuleStopRequest(running.capsule),
      "APP_CAPSULE_STOP_FAILED",
      `/apps/${pathToken(appId)}/capsule.lifecycle`,
    );

    if (!stopped.ok) return hostRejectFromError(stopped.error);

    const previousWindowModel = this.#windowModel;
    const nextWindowModel = closeWindow(previousWindowModel, running.launch.windowId);
    const intents = collectWindowManagerIntents(
      previousWindowModel,
      nextWindowModel,
      this.#layoutConstraints,
    );
    const stop = freezeStop({
      appId,
      intents,
      surfaceId: running.launch.surfaceId,
      textureId: running.launch.textureId,
      windowId: running.launch.windowId,
    });

    this.#windowModel = nextWindowModel;
    this.#launched.delete(appId);
    emitStop(this.#emitStop, stop);

    return hostAccept(stop);
  }

  snapshot(): DesktopAppsBackendSnapshot {
    const launched: DesktopAppLaunch[] = [];

    for (const running of this.#launched.values()) {
      launched.push(running.launch);
    }

    return Object.freeze({
      launched: Object.freeze(launched),
      windowModel: this.#windowModel,
    });
  }
}

function freezeCapsuleDescriptors(
  input: DesktopAppCapsuleDescriptors | undefined,
): Required<DesktopAppCapsuleDescriptors> {
  return Object.freeze({
    tsx: freezeCapsuleDescriptor(input?.tsx ?? DEFAULT_CAPSULE_DESCRIPTORS.tsx),
    web: freezeCapsuleDescriptor(input?.web ?? DEFAULT_CAPSULE_DESCRIPTORS.web),
  });
}

function freezeCapsuleDescriptor(input: DesktopAppCapsuleDescriptor): DesktopAppCapsuleDescriptor {
  return Object.freeze({
    id: input.id,
    integrity: input.integrity,
    version: input.version,
  });
}

function snapshotLaunchableApp(input: unknown): DesktopHostResult<DesktopLaunchableApp> {
  const normalized = safeNormalize(input);

  if (!normalized.ok) {
    return hostReject(
      "APP_DESCRIPTOR_INVALID",
      "launchApp requires a stable plain desktop launchable app.",
      "/launchApp/app",
    );
  }

  const app = jsonObject(normalized.value);

  if (app === undefined) {
    return hostReject(
      "APP_DESCRIPTOR_INVALID",
      "launchApp requires a desktop launchable app object.",
      "/launchApp/app",
    );
  }

  const appFields = expectFields(app, APP_DESCRIPTOR_FIELDS, "/launchApp/app");

  if (!appFields.ok) return appFields;

  const id = stringField(app, "id");
  const title = stringField(app, "title");
  const surfaceKind = field(app, "surfaceKind");
  const defaultWindow = snapshotWindowHints(field(app, "defaultWindow"));

  if (id === undefined || id.length === 0 || title === undefined || !defaultWindow.ok) {
    return hostReject(
      "APP_DESCRIPTOR_INVALID",
      "launchApp app descriptor is malformed.",
      "/launchApp/app",
    );
  }

  if (surfaceKind === "tsx") {
    const runtime = snapshotTsxRuntime(field(app, "runtime"));

    if (!runtime.ok) return runtime;

    const output: {
      id: string;
      runtime: Extract<DesktopLaunchableApp, { readonly surfaceKind: "tsx" }>["runtime"];
      surfaceKind: "tsx";
      title: string;
      defaultWindow?: AppWindowHints;
    } = {
      id,
      runtime: runtime.value,
      surfaceKind,
      title,
    };

    if (defaultWindow.value !== undefined) output.defaultWindow = defaultWindow.value;

    return hostAccept(Object.freeze(output));
  }

  if (surfaceKind === "web") {
    const runtime = snapshotWebRuntime(field(app, "runtime"));

    if (!runtime.ok) return runtime;

    const output: {
      id: string;
      runtime: Extract<DesktopLaunchableApp, { readonly surfaceKind: "web" }>["runtime"];
      surfaceKind: "web";
      title: string;
      defaultWindow?: AppWindowHints;
    } = {
      id,
      runtime: runtime.value,
      surfaceKind,
      title,
    };

    if (defaultWindow.value !== undefined) output.defaultWindow = defaultWindow.value;

    return hostAccept(Object.freeze(output));
  }

  return hostReject(
    "APP_DESCRIPTOR_INVALID",
    "launchApp app surfaceKind must be web or tsx.",
    "/launchApp/app/surfaceKind",
  );
}

function snapshotTsxRuntime(
  input: PlainJson | undefined,
): DesktopHostResult<Extract<DesktopLaunchableApp, { readonly surfaceKind: "tsx" }>["runtime"]> {
  const runtime = jsonObject(input);
  const fields = expectFields(runtime, TSX_RUNTIME_FIELDS, "/launchApp/app/runtime");
  const componentId = stringField(runtime, "componentId");
  const props = field(runtime, "props");
  const propsObject = jsonObject(props);

  if (!fields.ok) return fields;
  if (runtime === undefined || componentId === undefined) {
    return hostReject(
      "APP_DESCRIPTOR_INVALID",
      "tsx app runtime requires componentId.",
      "/launchApp/app/runtime",
    );
  }
  if (props !== undefined && propsObject === undefined) {
    return hostReject(
      "APP_DESCRIPTOR_INVALID",
      "tsx app runtime props must be a plain object when present.",
      "/launchApp/app/runtime/props",
    );
  }

  const output: {
    componentId: string;
    props?: PlainJsonObject;
  } = {
    componentId,
  };

  if (propsObject !== undefined) output.props = propsObject;

  return hostAccept(Object.freeze(output));
}

function snapshotWebRuntime(
  input: PlainJson | undefined,
): DesktopHostResult<Extract<DesktopLaunchableApp, { readonly surfaceKind: "web" }>["runtime"]> {
  const runtime = jsonObject(input);
  const fields = expectFields(runtime, WEB_RUNTIME_FIELDS, "/launchApp/app/runtime");
  const url = stringField(runtime, "url");
  const partition = optionalStringField(runtime, "partition", "/launchApp/app/runtime/partition");

  if (!fields.ok) return fields;
  if (runtime === undefined || url === undefined) {
    return hostReject(
      "APP_DESCRIPTOR_INVALID",
      "web app runtime requires url.",
      "/launchApp/app/runtime",
    );
  }
  if (!partition.ok) return partition;

  const output: {
    url: string;
    partition?: string;
  } = {
    url,
  };

  if (partition.value !== undefined) output.partition = partition.value;

  return hostAccept(Object.freeze(output));
}

function snapshotWindowHints(input: PlainJson | undefined): DesktopHostResult<AppWindowHints | undefined> {
  if (input === undefined) return hostAccept(undefined);

  const hints = jsonObject(input);

  if (hints === undefined) {
    return hostReject(
      "APP_DESCRIPTOR_INVALID",
      "defaultWindow must be a plain object when present.",
      "/launchApp/app/defaultWindow",
    );
  }

  const rect = snapshotOptionalRect(field(hints, "rect"));
  const mode = field(hints, "mode");
  const fields = expectFields(hints, APP_WINDOW_FIELDS, "/launchApp/app/defaultWindow");
  const workspaceId = optionalStringField(hints, "workspaceId", "/launchApp/app/defaultWindow/workspaceId");
  const zone = optionalStringField(hints, "zone", "/launchApp/app/defaultWindow/zone");
  const layer = optionalStringField(hints, "layer", "/launchApp/app/defaultWindow/layer");
  const order = optionalNumberField(hints, "order", "/launchApp/app/defaultWindow/order");
  const anchor = optionalStringField(hints, "anchor", "/launchApp/app/defaultWindow/anchor");
  const className = optionalStringField(hints, "className", "/launchApp/app/defaultWindow/className");

  if (!fields.ok) return fields;
  if (!rect.ok) return rect;
  if (!workspaceId.ok) return workspaceId;
  if (!zone.ok) return zone;
  if (!layer.ok) return layer;
  if (!order.ok) return order;
  if (!anchor.ok) return anchor;
  if (!className.ok) return className;
  if (mode !== undefined && mode !== "floating" && mode !== "tiled") {
    return hostReject(
      "APP_DESCRIPTOR_INVALID",
      "defaultWindow mode must be floating or tiled when present.",
      "/launchApp/app/defaultWindow/mode",
    );
  }

  const output: {
    anchor?: string;
    className?: string;
    layer?: string;
    mode?: NonNullable<AppWindowHints["mode"]>;
    order?: number;
    rect?: Rect;
    workspaceId?: string;
    zone?: string;
  } = {};

  if (anchor.value !== undefined) output.anchor = anchor.value;
  if (className.value !== undefined) output.className = className.value;
  if (layer.value !== undefined) output.layer = layer.value;
  if (mode === "floating" || mode === "tiled") output.mode = mode;
  if (order.value !== undefined) output.order = order.value;
  if (rect.value !== undefined) output.rect = rect.value;
  if (workspaceId.value !== undefined) output.workspaceId = workspaceId.value;
  if (zone.value !== undefined) output.zone = zone.value;

  return hostAccept(Object.freeze(output));
}

function snapshotOptionalRect(input: PlainJson | undefined): DesktopHostResult<Rect | undefined> {
  if (input === undefined) return hostAccept(undefined);

  const rect = jsonObject(input);
  const fields = expectFields(rect, RECT_FIELDS, "/launchApp/app/defaultWindow/rect");
  const x = numberField(rect, "x");
  const y = numberField(rect, "y");
  const width = numberField(rect, "width");
  const height = numberField(rect, "height");

  if (!fields.ok) return fields;
  if (rect === undefined || x === undefined || y === undefined || width === undefined || height === undefined) {
    return hostReject(
      "APP_DESCRIPTOR_INVALID",
      "defaultWindow rect must contain finite x, y, width, and height.",
      "/launchApp/app/defaultWindow/rect",
    );
  }

  return hostAccept(freezeRect({
    height,
    width,
    x,
    y,
  }));
}

function freezeLayoutConstraints(input: LayoutConstraints): LayoutConstraints {
  const output: {
    bounds: Rect;
    gap?: number;
    minHeight?: number;
    minWidth?: number;
    workspaceId?: string;
  } = {
    bounds: freezeRect(input.bounds),
  };

  if (input.gap !== undefined) output.gap = input.gap;
  if (input.minHeight !== undefined) output.minHeight = input.minHeight;
  if (input.minWidth !== undefined) output.minWidth = input.minWidth;
  if (input.workspaceId !== undefined) output.workspaceId = input.workspaceId;

  return Object.freeze(output);
}

function freezeRect(input: Rect): Rect {
  return Object.freeze({
    height: input.height,
    width: input.width,
    x: input.x,
    y: input.y,
  });
}

function snapshotPackage(manifest: DesktopUiPackageManifest): DesktopUiPackageManifest {
  const grants: DesktopCapabilityGrant[] = [];

  for (let index = 0; index < manifest.capabilityGrants.length; index += 1) {
    const grant = manifest.capabilityGrants[index];

    if (grant === undefined) continue;
    grants.push(Object.freeze({
      ...(grant.resourceId === undefined ? {} : { resourceId: grant.resourceId }),
      capability: grant.capability,
    }));
  }

  return Object.freeze({
    capabilityGrants: Object.freeze(grants),
    entry: manifest.entry,
    id: manifest.id,
    sdkVersion: manifest.sdkVersion,
    version: manifest.version,
  });
}

function buildWindowOpenRequest(
  hints: AppWindowHints | undefined,
  windowId: string,
  textureId: string,
): WindowOpenRequest {
  const request: {
    id: string;
    mode: NonNullable<AppWindowHints["mode"]>;
    rect: Rect;
    textureId: string;
    workspaceId?: string;
  } = {
    id: windowId,
    mode: hints?.mode ?? "floating",
    rect: freezeRect(hints?.rect ?? DEFAULT_WINDOW_RECT),
    textureId,
  };

  if (hints?.workspaceId !== undefined) request.workspaceId = hints.workspaceId;

  return Object.freeze(request);
}

function freezeLaunch(
  app: DesktopLaunchableApp,
  surfaceId: string,
  windowId: string,
  textureId: string,
  intents: readonly WindowManagerIntent[],
): DesktopAppLaunch {
  return Object.freeze({
    app,
    intents: Object.freeze([...intents]),
    surfaceId,
    textureId,
    windowId,
  });
}

function freezeStop(input: {
  readonly appId: string;
  readonly intents: readonly WindowManagerIntent[];
  readonly surfaceId?: string;
  readonly textureId?: string;
  readonly windowId?: string;
}): DesktopAppStop {
  const stop: {
    appId: string;
    intents: readonly WindowManagerIntent[];
    surfaceId?: string;
    textureId?: string;
    windowId?: string;
  } = {
    appId: input.appId,
    intents: Object.freeze([...input.intents]),
  };

  if (input.surfaceId !== undefined) stop.surfaceId = input.surfaceId;
  if (input.textureId !== undefined) stop.textureId = input.textureId;
  if (input.windowId !== undefined) stop.windowId = input.windowId;

  return Object.freeze(stop);
}

function capsuleExecuteRequest(descriptor: DesktopAppCapsuleDescriptor): PlainJsonObject {
  return Object.freeze({
    desired: Object.freeze({
      id: descriptor.id,
      integrity: descriptor.integrity,
      version: descriptor.version,
    }),
  });
}

function capsuleStopRequest(descriptor: DesktopAppCapsuleDescriptor): PlainJsonObject {
  return Object.freeze({
    desired: Object.freeze({
      id: descriptor.id,
      op: "stop",
    }),
  });
}

async function callAgentd(
  agentd: AgentdHostClient,
  capability: string,
  request: PlainJsonObject,
  code: string,
  path: string,
): Promise<AgentdCallResult> {
  let result: AgentdHostResult;

  try {
    result = await agentd.call(capability, request);
  } catch {
    return rejectAgentd(code, "agentd host transport failed closed.", path);
  }

  if (!result.ok) {
    return rejectAgentd(
      code,
      result.error.message.length > 0 ? result.error.message : "agentd capability request failed closed.",
      path,
    );
  }

  return Object.freeze({
    ok: true,
  });
}

function appTextureId(appId: string): string {
  return `texture:vita.app:${pathToken(appId)}`;
}

function emitLaunch(
  emit: ((launch: DesktopAppLaunch) => void) | undefined,
  launch: DesktopAppLaunch,
): void {
  if (emit === undefined) return;

  try {
    emit(launch);
  } catch {
    return;
  }
}

function emitStop(
  emit: ((stop: DesktopAppStop) => void) | undefined,
  stop: DesktopAppStop,
): void {
  if (emit === undefined) return;

  try {
    emit(stop);
  } catch {
    return;
  }
}

function rejectAgentd(code: string, message: string, path: string): AgentdCallResult {
  return Object.freeze({
    error: hostError(code, message, path),
    ok: false,
  });
}

function hostAccept<T>(value: T): DesktopHostResult<T> {
  return Object.freeze({
    ok: true,
    value,
  });
}

function hostReject<T>(code: string, message: string, path: string): DesktopHostResult<T> {
  return Object.freeze({
    error: hostError(code, message, path),
    ok: false,
  });
}

function hostRejectFromError<T>(error: DesktopHostError): DesktopHostResult<T> {
  return Object.freeze({
    error,
    ok: false,
  });
}

function hostError(code: string, message: string, path: string): DesktopHostError {
  return Object.freeze({
    code,
    message,
    path,
  });
}

function field(value: PlainJsonObject | undefined, key: string): PlainJson | undefined {
  if (value === undefined || !Object.hasOwn(value, key)) return undefined;

  return value[key];
}

function expectFields(
  value: PlainJsonObject | undefined,
  allowed: readonly string[],
  path: string,
): DesktopHostResult<true> {
  if (value === undefined) {
    return hostReject(
      "APP_DESCRIPTOR_INVALID",
      "object is required.",
      path,
    );
  }

  const keys = Object.keys(value);

  for (let index = 0; index < keys.length; index += 1) {
    const key = keys[index];

    if (key !== undefined && !contains(allowed, key)) {
      return hostReject(
        "APP_DESCRIPTOR_INVALID",
        "object contains an unsupported field.",
        `${path}/${pathToken(key)}`,
      );
    }
  }

  return hostAccept(true);
}

function stringField(value: PlainJsonObject | undefined, key: string): string | undefined {
  const item = field(value, key);

  return typeof item === "string" ? item : undefined;
}

function optionalStringField(
  value: PlainJsonObject | undefined,
  key: string,
  path: string,
): DesktopHostResult<string | undefined> {
  const item = field(value, key);

  if (item === undefined) return hostAccept(undefined);
  if (typeof item !== "string") {
    return hostReject(
      "APP_DESCRIPTOR_INVALID",
      "field must be a string when present.",
      path,
    );
  }

  return hostAccept(item);
}

function numberField(value: PlainJsonObject | undefined, key: string): number | undefined {
  const item = field(value, key);

  return typeof item === "number" && Number.isFinite(item) ? item : undefined;
}

function optionalNumberField(
  value: PlainJsonObject | undefined,
  key: string,
  path: string,
): DesktopHostResult<number | undefined> {
  const item = field(value, key);

  if (item === undefined) return hostAccept(undefined);
  if (typeof item !== "number" || !Number.isFinite(item)) {
    return hostReject(
      "APP_DESCRIPTOR_INVALID",
      "field must be a finite number when present.",
      path,
    );
  }

  return hostAccept(item);
}

function jsonObject(value: PlainJson | undefined): PlainJsonObject | undefined {
  if (!isPlainJsonObject(value)) return undefined;

  return value;
}

function isPlainJsonObject(value: PlainJson | undefined): value is PlainJsonObject {
  return value !== undefined && value !== null && typeof value === "object" && !Array.isArray(value);
}

function contains(values: readonly string[], value: string): boolean {
  for (let index = 0; index < values.length; index += 1) {
    if (values[index] === value) return true;
  }

  return false;
}

function pathToken(value: string): string {
  return value.replaceAll("~", "~0").replaceAll("/", "~1");
}
