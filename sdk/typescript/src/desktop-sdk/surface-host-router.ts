import type {
  HostBridgeJson,
  HostBridgeJsonObject,
  SurfaceAppHostPorts,
  SurfaceFilesHostPorts,
  SurfaceHostMethod,
  SurfaceHostRequest,
  SurfaceLauncherHostPorts,
  SurfaceNotificationHostPorts,
  SurfaceSettingsHostPorts,
  SurfaceShellHostPorts,
  SurfaceThemeHostPorts,
} from "../../../../ui_kits/desktop/runtime/host-bridge.ts";
import type {
  DesktopAppLaunch,
  DesktopAppStop,
  DesktopHostError,
  DesktopHostResult,
  DesktopLaunchableApp,
  DesktopMaybePromise,
  DesktopTheme,
  DesktopUiPackageManifest,
  FilesEntry,
  FilesErrorResponse,
  FilesRequest,
  FilesResponse,
  NotificationAction,
  RegisteredShellComponent,
  ShellApplyResult,
  ShellConfigDefinition,
  ShellLayoutDiff,
  ShellManagedSnapshot,
  ShellPlacement,
  ShellPreviewResult,
  ShellResult,
  ShellRollbackResult,
  ShellComponentDefinition,
  ShellNotification,
  TrayItem,
  TrayMenuItem,
  WindowManagerIntent,
} from "./index.ts";

export type SurfaceHostBackend =
  Required<SurfaceShellHostPorts> &
  Required<SurfaceAppHostPorts> &
  Required<SurfaceNotificationHostPorts> &
  Required<SurfaceFilesHostPorts> &
  Required<SurfaceSettingsHostPorts> &
  Required<SurfaceLauncherHostPorts> &
  Required<SurfaceThemeHostPorts>;

export type SurfaceHostRouterErrorCode =
  | "HOST_ROUTER_UNKNOWN_METHOD"
  | "HOST_ROUTER_BAD_ARITY"
  | "HOST_ROUTER_NON_JSON"
  | "HOST_ROUTER_BACKEND_FAILED";

export type SurfaceHostRouter = (request: unknown) => DesktopMaybePromise<HostBridgeJson>;

type JsonNormalizeResult =
  | {
      readonly ok: true;
      readonly value: HostBridgeJson;
    }
  | {
      readonly ok: false;
      readonly error: DesktopHostError;
    };

type RequestNormalizeResult =
  | {
      readonly ok: true;
      readonly method: SurfaceHostMethod;
      readonly args: readonly HostBridgeJson[];
    }
  | {
      readonly ok: false;
      readonly error: DesktopHostError;
    };

type InMemoryShellLayout = ShellManagedSnapshot["layout"];

interface InMemoryFile {
  readonly kind: "file";
  data: string;
  mtime: string;
}

interface InMemoryDirectory {
  readonly kind: "dir";
  mtime: string;
}

type InMemoryNode = InMemoryFile | InMemoryDirectory;

const MAX_JSON_DEPTH = 80;
const EMPTY_INTENTS = Object.freeze([]) satisfies readonly WindowManagerIntent[];
const EMPTY_DIFF = Object.freeze({
  added: Object.freeze([]),
  changed: Object.freeze([]),
  removed: Object.freeze([]),
}) satisfies ShellLayoutDiff;
const DEFAULT_PACKAGE_GRANTS = Object.freeze([
  Object.freeze({ capability: "apps.launch" }),
  Object.freeze({ capability: "apps.stop" }),
  Object.freeze({ capability: "files.read" }),
  Object.freeze({ capability: "files.write" }),
  Object.freeze({ capability: "launcher.launch" }),
  Object.freeze({ capability: "settings.read" }),
  Object.freeze({ capability: "settings.write" }),
  Object.freeze({ capability: "shell.notifications.post" }),
  Object.freeze({ capability: "shell.tray.register" }),
]);
const DEFAULT_PACKAGE = Object.freeze({
  capabilityGrants: DEFAULT_PACKAGE_GRANTS,
  entry: "index.html",
  id: "vita.desktop.surface.in-memory",
  sdkVersion: "0.0.0",
  version: "0.0.0",
}) satisfies DesktopUiPackageManifest;
const DEFAULT_THEME = Object.freeze({
  id: "vita.in-memory.theme",
  tokens: Object.freeze({
    colors: Object.freeze({
      accent: "#3178c6",
      background: "#ffffff",
      foreground: "#101418",
    }),
    radii: Object.freeze({
      md: 8,
      sm: 4,
    }),
    spacing: Object.freeze({
      md: 16,
      sm: 8,
    }),
    typography: Object.freeze({
      body: "system-ui",
      mono: "ui-monospace",
    }),
  }),
  version: "1.0.0",
}) satisfies DesktopTheme;
const DEFAULT_FILE_MTIME = "2026-06-25T00:00:00.000Z";

export function createSurfaceHostRouter(backend: SurfaceHostBackend): SurfaceHostRouter {
  return (request) => routeSurfaceHostRequest(backend, request);
}

export function routeSurfaceHostRequest(
  backend: SurfaceHostBackend,
  request: unknown,
): DesktopMaybePromise<HostBridgeJson> {
  const normalized = normalizeRequest(request);

  if (!normalized.ok) return rejectJson(normalized.error);

  const response = dispatchSurfaceHostRequest(backend, normalized.method, normalized.args);

  return finalizeBackendResponse(response, normalized.method);
}

export function createInMemorySurfaceBackend(): SurfaceHostBackend {
  const launchedApps = new Map<string, DesktopAppLaunch>();
  const settings = new Map<string, HostBridgeJson>([
    ["appearance.theme", "light"],
    ["desktop.theme", DEFAULT_THEME.id],
    ["surface.motion", false],
  ]);
  const files = createInitialFiles();
  let notificationCounter = 0;
  let shellLayout = createShellLayout("vita.in-memory.shell", "0");
  let previousShellLayout: InMemoryShellLayout | undefined;

  const backend: SurfaceHostBackend = {
    applySetting(request) {
      const input = jsonObject(request);
      const key = stringField(input, "key") ?? "unknown";
      const value = field(input, "value") ?? null;

      settings.set(key, value);

      return hostAccept(Object.freeze({
        applied: Object.freeze({
          key,
          value,
        }),
        revision: `settings:${key}:${stableJson(value)}`,
      }));
    },
    applyShell(definition) {
      const next = shellLayoutFromDefinition(definition);
      const diff = diffForLayouts(shellLayout, next);

      previousShellLayout = shellLayout;
      shellLayout = next;

      return Object.freeze({
        diff,
        layout: shellLayout,
        ok: true,
        outcome: "committed",
      }) satisfies ShellApplyResult;
    },
    currentShell() {
      return Object.freeze({
        layout: shellLayout,
        source: "configured",
      }) satisfies ShellManagedSnapshot;
    },
    emitLauncherIntent() {
      return hostAccept(true);
    },
    launchApp(app) {
      const appId = launchableAppId(app);
      const launch = Object.freeze({
        app,
        intents: EMPTY_INTENTS,
        surfaceId: `surface:${pathToken(appId)}`,
        textureId: `texture:${pathToken(appId)}`,
        windowId: `window:${pathToken(appId)}`,
      }) satisfies DesktopAppLaunch;

      launchedApps.set(appId, launch);

      return hostAccept(launch);
    },
    package: DEFAULT_PACKAGE,
    postNotification(input) {
      notificationCounter += 1;

      return shellAccept(notificationFromInput(input, notificationCounter));
    },
    previewSetting(request) {
      const input = jsonObject(request);
      const key = stringField(input, "key") ?? "unknown";
      const value = field(input, "value") ?? null;
      const previous = settings.get(key) ?? null;

      return hostAccept(Object.freeze({
        diff: Object.freeze({
          key,
          previous,
          value,
        }),
        revision: `preview:${key}:${stableJson(value)}`,
      }));
    },
    previewShell(definition) {
      const layout = shellLayoutFromDefinition(definition);

      return Object.freeze({
        diff: diffForLayouts(shellLayout, layout),
        layout,
        ok: true,
      }) satisfies ShellPreviewResult;
    },
    readSetting(request) {
      const input = jsonObject(request);
      const key = stringField(input, "key") ?? "unknown";

      return hostAccept(settings.get(key) ?? null);
    },
    readTheme() {
      return DEFAULT_THEME;
    },
    registerComponent(definition) {
      const input = jsonObject(definition);
      const id = stringField(input, "id") ?? "vita.in-memory.component";
      const role = stringField(input, "role") ?? "component";

      return shellAccept(Object.freeze({
        defaultPlacement: placementFromField(field(input, "defaultPlacement")),
        id,
        role,
      }) as unknown as RegisteredShellComponent);
    },
    registerTrayItem(input) {
      return shellAccept(trayItemFromInput(input));
    },
    requestFile(request) {
      return handleFileRequest(files, request);
    },
    rollbackShell() {
      const next = previousShellLayout ?? createShellLayout("vita.in-memory.shell.rollback", "rollback");

      shellLayout = next;
      previousShellLayout = undefined;

      return Object.freeze({
        layout: shellLayout,
        ok: true,
        outcome: "rolledBack",
      }) satisfies ShellRollbackResult;
    },
    stopApp(appId) {
      const id = typeof appId === "string" ? appId : "unknown";
      const launch = launchedApps.get(id);
      const stop: {
        appId: string;
        intents: readonly WindowManagerIntent[];
        surfaceId?: string;
        textureId?: string;
        windowId?: string;
      } = {
        appId: id,
        intents: EMPTY_INTENTS,
      };

      if (launch !== undefined) {
        stop.surfaceId = launch.surfaceId;
        stop.textureId = launch.textureId;
        stop.windowId = launch.windowId;
        launchedApps.delete(id);
      }

      return hostAccept(Object.freeze(stop) satisfies DesktopAppStop);
    },
  };

  return Object.freeze(backend);
}

function dispatchSurfaceHostRequest(
  backend: SurfaceHostBackend,
  method: SurfaceHostMethod,
  args: readonly HostBridgeJson[],
): DesktopMaybePromise<unknown> {
  try {
    switch (method) {
      case "registerComponent":
        return backend.registerComponent(argAt<Parameters<SurfaceHostBackend["registerComponent"]>[0]>(args, 0));
      case "previewShell":
        return backend.previewShell(argAt<Parameters<SurfaceHostBackend["previewShell"]>[0]>(args, 0));
      case "applyShell":
        return backend.applyShell(argAt<Parameters<SurfaceHostBackend["applyShell"]>[0]>(args, 0));
      case "rollbackShell":
        return backend.rollbackShell();
      case "currentShell":
        return backend.currentShell();
      case "launchApp":
        return backend.launchApp(argAt<Parameters<SurfaceHostBackend["launchApp"]>[0]>(args, 0));
      case "stopApp":
        return backend.stopApp(argAt<Parameters<SurfaceHostBackend["stopApp"]>[0]>(args, 0));
      case "postNotification":
        return backend.postNotification(argAt<Parameters<SurfaceHostBackend["postNotification"]>[0]>(args, 0));
      case "registerTrayItem":
        return backend.registerTrayItem(argAt<Parameters<SurfaceHostBackend["registerTrayItem"]>[0]>(args, 0));
      case "requestFile":
        return backend.requestFile(argAt<Parameters<SurfaceHostBackend["requestFile"]>[0]>(args, 0));
      case "readSetting":
        return backend.readSetting(argAt<Parameters<SurfaceHostBackend["readSetting"]>[0]>(args, 0));
      case "previewSetting":
        return backend.previewSetting(argAt<Parameters<SurfaceHostBackend["previewSetting"]>[0]>(args, 0));
      case "applySetting":
        return backend.applySetting(argAt<Parameters<SurfaceHostBackend["applySetting"]>[0]>(args, 0));
      case "emitLauncherIntent":
        return backend.emitLauncherIntent(argAt<Parameters<SurfaceHostBackend["emitLauncherIntent"]>[0]>(args, 0));
      case "readTheme":
        return backend.readTheme();
    }
  } catch {
    return rejectJson(routerError("HOST_ROUTER_BACKEND_FAILED", "surface host backend failed closed.", `/${method}`));
  }
}

function finalizeBackendResponse(
  response: DesktopMaybePromise<unknown>,
  method: SurfaceHostMethod,
): DesktopMaybePromise<HostBridgeJson> {
  if (isPromiseLike(response)) {
    return Promise.resolve(response)
      .then((value) => snapshotResponse(value, method))
      .catch(() => rejectJson(routerError("HOST_ROUTER_BACKEND_FAILED", "surface host backend failed closed.", `/${method}`)));
  }

  return snapshotResponse(response, method);
}

function snapshotResponse(value: unknown, method: SurfaceHostMethod): HostBridgeJson {
  const snapshot = snapshotJson(value, `/${method}/response`);

  return snapshot.ok ? snapshot.value : rejectJson(snapshot.error);
}

function normalizeRequest(request: unknown): RequestNormalizeResult {
  const snapshot = snapshotJson(request, "/request");

  if (!snapshot.ok) return rejectNormalize(snapshot.error);

  const envelope = jsonObject(snapshot.value);

  if (envelope === undefined || !hasOnlyRequestFields(envelope)) {
    return rejectNormalize(routerError(
      "HOST_ROUTER_NON_JSON",
      "surface host request must be the plain { method, args } wire shape.",
      "/request",
    ));
  }

  const method = envelope["method"];

  if (!isSurfaceHostMethod(method)) {
    return rejectNormalize(routerError(
      "HOST_ROUTER_UNKNOWN_METHOD",
      "surface host method is not supported.",
      "/request/method",
    ));
  }

  const args = envelope["args"];

  if (!Array.isArray(args)) {
    return rejectNormalize(routerError(
      "HOST_ROUTER_BAD_ARITY",
      "surface host request args must be an array.",
      `/${method}/args`,
    ));
  }

  const arity = methodArity(method);

  if (args.length !== arity) {
    return rejectNormalize(routerError(
      "HOST_ROUTER_BAD_ARITY",
      `surface host method '${method}' expects ${arity} args.`,
      `/${method}/args`,
    ));
  }

  return {
    args,
    method,
    ok: true,
  };
}

function methodArity(method: SurfaceHostMethod): number {
  switch (method) {
    case "registerComponent":
    case "previewShell":
    case "applyShell":
    case "launchApp":
    case "stopApp":
    case "postNotification":
    case "registerTrayItem":
    case "requestFile":
    case "readSetting":
    case "previewSetting":
    case "applySetting":
    case "emitLauncherIntent":
      return 1;
    case "rollbackShell":
    case "currentShell":
    case "readTheme":
      return 0;
  }
}

function isSurfaceHostMethod(value: unknown): value is SurfaceHostMethod {
  return (
    value === "registerComponent" ||
    value === "previewShell" ||
    value === "applyShell" ||
    value === "rollbackShell" ||
    value === "currentShell" ||
    value === "launchApp" ||
    value === "stopApp" ||
    value === "postNotification" ||
    value === "registerTrayItem" ||
    value === "requestFile" ||
    value === "readSetting" ||
    value === "previewSetting" ||
    value === "applySetting" ||
    value === "emitLauncherIntent" ||
    value === "readTheme"
  );
}

function snapshotJson(input: unknown, path: string): JsonNormalizeResult {
  return snapshotJsonValue(input, path, 0, new WeakSet<object>());
}

function snapshotJsonValue(
  input: unknown,
  path: string,
  depth: number,
  seen: WeakSet<object>,
): JsonNormalizeResult {
  if (depth > MAX_JSON_DEPTH) {
    return rejectNormalize(routerError("HOST_ROUTER_NON_JSON", "value exceeds the host router JSON depth limit.", path));
  }

  if (input === null || typeof input === "string" || typeof input === "boolean") {
    return acceptJson(input);
  }
  if (typeof input === "number") {
    return Number.isFinite(input)
      ? acceptJson(input)
      : rejectNormalize(routerError("HOST_ROUTER_NON_JSON", "number must be finite JSON.", path));
  }
  if (typeof input !== "object") {
    return rejectNormalize(routerError("HOST_ROUTER_NON_JSON", "value must be plain JSON.", path));
  }

  try {
    if (seen.has(input)) {
      return rejectNormalize(routerError("HOST_ROUTER_NON_JSON", "cyclic values are not JSON.", path));
    }

    seen.add(input);

    if (Array.isArray(input)) {
      return snapshotJsonArray(input, path, depth, seen);
    }

    const prototype = Object.getPrototypeOf(input);

    if (prototype !== Object.prototype && prototype !== null) {
      return rejectNormalize(routerError("HOST_ROUTER_NON_JSON", "object must be a plain JSON object.", path));
    }

    const output: { [key: string]: HostBridgeJson } = Object.create(null) as { [key: string]: HostBridgeJson };
    const keys = Reflect.ownKeys(input);

    for (let index = 0; index < keys.length; index += 1) {
      const key = keys[index];

      if (key === undefined || typeof key === "symbol") {
        return rejectNormalize(routerError("HOST_ROUTER_NON_JSON", "JSON object keys must be strings.", path));
      }

      const descriptor = Object.getOwnPropertyDescriptor(input, key);

      if (descriptor === undefined || !isDataDescriptor(descriptor) || descriptor.enumerable !== true) {
        return rejectNormalize(routerError("HOST_ROUTER_NON_JSON", "JSON object fields must be enumerable data fields.", `${path}/${pathToken(key)}`));
      }

      const normalized = snapshotJsonValue(descriptor.value, `${path}/${pathToken(key)}`, depth + 1, seen);

      if (!normalized.ok) return normalized;
      Object.defineProperty(output, key, {
        configurable: false,
        enumerable: true,
        value: normalized.value,
        writable: false,
      });
    }

    return acceptJson(Object.freeze(output));
  } catch {
    return rejectNormalize(routerError("HOST_ROUTER_NON_JSON", "value must be stable plain JSON.", path));
  } finally {
    seen.delete(input);
  }
}

function snapshotJsonArray(
  input: readonly unknown[],
  path: string,
  depth: number,
  seen: WeakSet<object>,
): JsonNormalizeResult {
  try {
    if (Object.getPrototypeOf(input) !== Array.prototype) {
      return rejectNormalize(routerError("HOST_ROUTER_NON_JSON", "array must be a plain JSON array.", path));
    }

    const keys = Reflect.ownKeys(input);

    for (let index = 0; index < keys.length; index += 1) {
      const key = keys[index];

      if (key === "length") continue;
      if (key === undefined || typeof key === "symbol" || !isDenseArrayIndexKey(key, input.length)) {
        return rejectNormalize(routerError("HOST_ROUTER_NON_JSON", "array contains a non-JSON field.", path));
      }

      const descriptor = Object.getOwnPropertyDescriptor(input, key);

      if (descriptor === undefined || !isDataDescriptor(descriptor) || descriptor.enumerable !== true) {
        return rejectNormalize(routerError("HOST_ROUTER_NON_JSON", "array entries must be enumerable data fields.", `${path}/${key}`));
      }
    }

    const output: HostBridgeJson[] = [];

    for (let index = 0; index < input.length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(input, `${index}`);

      if (descriptor === undefined || !isDataDescriptor(descriptor) || descriptor.enumerable !== true) {
        return rejectNormalize(routerError("HOST_ROUTER_NON_JSON", "array must be dense JSON.", `${path}/${index}`));
      }

      const normalized = snapshotJsonValue(descriptor.value, `${path}/${index}`, depth + 1, seen);

      if (!normalized.ok) return normalized;
      output.push(normalized.value);
    }

    return acceptJson(Object.freeze(output));
  } catch {
    return rejectNormalize(routerError("HOST_ROUTER_NON_JSON", "array must be stable plain JSON.", path));
  }
}

function createInitialFiles(): Map<string, InMemoryNode> {
  return new Map<string, InMemoryNode>([
    ["/workspace", {
      kind: "dir",
      mtime: DEFAULT_FILE_MTIME,
    }],
    ["/workspace/README.md", {
      data: "Vita in-memory file backend\n",
      kind: "file",
      mtime: DEFAULT_FILE_MTIME,
    }],
    ["/workspace/src", {
      kind: "dir",
      mtime: DEFAULT_FILE_MTIME,
    }],
    ["/workspace/src/app.ts", {
      data: "export const app = 'vita';\n",
      kind: "file",
      mtime: DEFAULT_FILE_MTIME,
    }],
  ]);
}

function handleFileRequest(files: Map<string, InMemoryNode>, request: FilesRequest): FilesResponse | FilesErrorResponse {
  const input = jsonObject(request);
  const op = stringField(input, "op");
  const requestPath = stringField(input, "path");

  if (op === undefined || requestPath === undefined) {
    return fileReject("INVALID_FILE_REQUEST", "file request requires op and path.");
  }

  if (op === "list") return listFiles(files, requestPath);
  if (op === "read") return readFile(files, requestPath);
  if (op === "stat") return statFile(files, requestPath);
  if (op === "write") {
    const data = stringField(input, "data") ?? "";

    files.set(requestPath, {
      data,
      kind: "file",
      mtime: DEFAULT_FILE_MTIME,
    });

    return statFile(files, requestPath);
  }

  return fileReject("INVALID_FILE_OPERATION", "file operation is not supported.");
}

function listFiles(files: ReadonlyMap<string, InMemoryNode>, requestPath: string): FilesResponse | FilesErrorResponse {
  const node = files.get(requestPath);

  if (node?.kind !== "dir") return fileReject("NOT_A_DIRECTORY", "path is not an in-memory directory.");

  const prefix = requestPath === "/" ? "/" : `${requestPath}/`;
  const entries: FilesEntry[] = [];

  for (const [path, child] of files) {
    if (path === requestPath || !path.startsWith(prefix)) continue;

    const remainder = path.slice(prefix.length);

    if (remainder.length === 0 || remainder.includes("/")) continue;
    entries.push(Object.freeze({
      kind: child.kind,
      mtime: child.mtime,
      name: remainder,
      size: child.kind === "file" ? child.data.length : 0,
    }));
  }

  entries.sort((left, right) => compareFilesEntry(left, right));

  return Object.freeze({
    entries: Object.freeze(entries),
    kind: "dir",
    mtime: node.mtime,
    size: 0,
  });
}

function readFile(files: ReadonlyMap<string, InMemoryNode>, requestPath: string): FilesResponse | FilesErrorResponse {
  const node = files.get(requestPath);

  if (node?.kind !== "file") return fileReject("NOT_A_FILE", "path is not an in-memory file.");

  return Object.freeze({
    data: node.data,
    kind: "file",
    mtime: node.mtime,
    size: node.data.length,
  });
}

function statFile(files: ReadonlyMap<string, InMemoryNode>, requestPath: string): FilesResponse | FilesErrorResponse {
  const node = files.get(requestPath);

  if (node === undefined) return fileReject("NOT_FOUND", "path is not present in the in-memory file backend.");

  return Object.freeze({
    kind: node.kind,
    mtime: node.mtime,
    size: node.kind === "file" ? node.data.length : 0,
  });
}

function notificationFromInput(input: unknown, counter: number): ShellNotification {
  const object = jsonObject(input);
  const createdAtMs = 1_779_840_000_000 + counter;
  const notification: {
    actions: readonly NotificationAction[];
    appId: string;
    createdAtMs: number;
    id: string;
    priority: ShellNotification["priority"];
    title: string;
    body?: string;
    expiresAtMs?: number;
  } = {
    actions: actionsFromField(field(object, "actions")),
    appId: DEFAULT_PACKAGE.id,
    createdAtMs,
    id: stringField(object, "id") ?? `notification:${counter}`,
    priority: notificationPriority(field(object, "priority")),
    title: stringField(object, "title") ?? "Notification",
  };
  const body = stringField(object, "body");
  const expiresAtMs = numberField(object, "expiresAtMs");

  if (body !== undefined) notification.body = body;
  if (expiresAtMs !== undefined) notification.expiresAtMs = expiresAtMs;

  return Object.freeze(notification);
}

function actionsFromField(value: HostBridgeJson | undefined): readonly NotificationAction[] {
  if (!Array.isArray(value)) return Object.freeze([]);

  const actions: NotificationAction[] = [];

  for (let index = 0; index < value.length; index += 1) {
    const input = jsonObject(value[index]);
    const id = stringField(input, "id");
    const label = stringField(input, "label");

    if (id !== undefined && label !== undefined) {
      actions.push(Object.freeze({
        id,
        label,
        style: actionStyle(field(input, "style")),
      }));
    }
  }

  return Object.freeze(actions);
}

function trayItemFromInput(input: unknown): TrayItem {
  const object = jsonObject(input);
  const item: {
    appId: string;
    iconRef: string;
    id: string;
    menu: readonly TrayMenuItem[];
    order: number;
    tooltip: string;
    status?: NonNullable<TrayItem["status"]>;
  } = {
    appId: DEFAULT_PACKAGE.id,
    iconRef: stringField(object, "iconRef") ?? "memory://tray",
    id: stringField(object, "id") ?? "tray:item",
    menu: trayMenuFromField(field(object, "menu")),
    order: numberField(object, "order") ?? 0,
    tooltip: stringField(object, "tooltip") ?? "In-memory tray item",
  };
  const status = trayStatus(field(object, "status"));

  if (status !== undefined) item.status = status;

  return Object.freeze(item);
}

function trayMenuFromField(value: HostBridgeJson | undefined): readonly TrayMenuItem[] {
  if (!Array.isArray(value)) return Object.freeze([]);

  const items: TrayMenuItem[] = [];

  for (let index = 0; index < value.length; index += 1) {
    const object = jsonObject(value[index]);
    const id = stringField(object, "id");
    const label = stringField(object, "label");

    if (id !== undefined && label !== undefined) {
      const item: {
        enabled: boolean;
        id: string;
        items: readonly TrayMenuItem[];
        label: string;
        checked?: boolean;
      } = {
        enabled: booleanField(object, "enabled") ?? true,
        id,
        items: trayMenuFromField(field(object, "items")),
        label,
      };
      const checked = booleanField(object, "checked");

      if (checked !== undefined) item.checked = checked;
      items.push(Object.freeze(item));
    }
  }

  return Object.freeze(items);
}

function shellLayoutFromDefinition(definition: unknown): InMemoryShellLayout {
  const input = jsonObject(definition);
  const configId = stringField(input, "id") ?? "vita.in-memory.shell";
  const revision = stringField(input, "revision") ?? `revision:${configId}`;

  return createShellLayout(configId, revision);
}

function createShellLayout(configId: string, revision: string): InMemoryShellLayout {
  const root = Object.freeze({
    children: Object.freeze([]),
    componentId: `${configId}.root`,
    id: `surface:${pathToken(configId)}:root`,
    path: "/",
    payload: Object.freeze({
      source: "in-memory",
    }),
    placement: Object.freeze({
      layer: "desktop",
      order: 0,
      zone: "root",
    }),
    role: "desktop",
    substrate: Object.freeze({
      kind: "virtual",
    }),
  });

  return Object.freeze({
    configId,
    css: Object.freeze({
      rules: Object.freeze([]),
      text: "",
    }),
    revision,
    root,
    surfaces: Object.freeze([]),
  });
}

function diffForLayouts(current: InMemoryShellLayout, next: InMemoryShellLayout): ShellLayoutDiff {
  if (current.configId === next.configId && current.revision === next.revision) return EMPTY_DIFF;

  return Object.freeze({
    added: Object.freeze([next.root.id]),
    changed: Object.freeze([]),
    removed: Object.freeze([current.root.id]),
  });
}

function placementFromField(value: HostBridgeJson | undefined): ShellPlacement {
  const input = jsonObject(value);

  return Object.freeze({
    layer: stringField(input, "layer") ?? "desktop",
    order: numberField(input, "order") ?? 0,
    zone: stringField(input, "zone") ?? "center",
  });
}

function fileReject(code: string, message: string): FilesErrorResponse {
  return Object.freeze({
    error: Object.freeze({
      code,
      message,
    }),
  });
}

function hostAccept<T>(value: T): DesktopHostResult<T> {
  return Object.freeze({
    ok: true,
    value,
  });
}

function shellAccept<T>(value: T): ShellResult<T> {
  return Object.freeze({
    ok: true,
    value,
  });
}

function rejectJson(error: DesktopHostError): HostBridgeJsonObject {
  return Object.freeze({
    error: Object.freeze({
      code: error.code,
      message: error.message,
      path: error.path,
    }),
    ok: false,
  });
}

function acceptJson(value: HostBridgeJson): JsonNormalizeResult {
  return {
    ok: true,
    value,
  };
}

function rejectNormalize<T>(error: DesktopHostError): {
  readonly ok: false;
  readonly error: DesktopHostError;
} {
  return {
    error,
    ok: false,
  };
}

function routerError(code: SurfaceHostRouterErrorCode, message: string, path: string): DesktopHostError {
  return Object.freeze({
    code,
    message,
    path,
  });
}

function argAt<T>(args: readonly HostBridgeJson[], index: number): T {
  return args[index] as unknown as T;
}

function jsonObject(value: unknown): HostBridgeJsonObject | undefined {
  if (value === undefined || value === null || typeof value !== "object" || Array.isArray(value)) return undefined;

  return value as HostBridgeJsonObject;
}

function hasOnlyRequestFields(value: HostBridgeJsonObject): boolean {
  const keys = Object.keys(value);

  return keys.length === 2 && hasOwn(value, "method") && hasOwn(value, "args");
}

function field(value: HostBridgeJsonObject | undefined, key: string): HostBridgeJson | undefined {
  if (value === undefined || !hasOwn(value, key)) return undefined;

  return value[key];
}

function stringField(value: HostBridgeJsonObject | undefined, key: string): string | undefined {
  const item = field(value, key);

  return typeof item === "string" ? item : undefined;
}

function numberField(value: HostBridgeJsonObject | undefined, key: string): number | undefined {
  const item = field(value, key);

  return typeof item === "number" && Number.isFinite(item) ? item : undefined;
}

function booleanField(value: HostBridgeJsonObject | undefined, key: string): boolean | undefined {
  const item = field(value, key);

  return typeof item === "boolean" ? item : undefined;
}

function launchableAppId(app: DesktopLaunchableApp): string {
  const input = jsonObject(app);

  return stringField(input, "id") ?? "unknown";
}

function notificationPriority(value: HostBridgeJson | undefined): ShellNotification["priority"] {
  if (
    value === "low" ||
    value === "normal" ||
    value === "high" ||
    value === "urgent" ||
    value === "critical"
  ) {
    return value;
  }

  return "normal";
}

function actionStyle(value: HostBridgeJson | undefined): NotificationAction["style"] {
  if (value === "primary" || value === "destructive" || value === "default") return value;

  return "default";
}

function trayStatus(value: HostBridgeJson | undefined): TrayItem["status"] | undefined {
  if (value === "ok" || value === "warning" || value === "critical" || value === "offline") return value;

  return undefined;
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  if ((typeof value !== "object" && typeof value !== "function") || value === null) return false;

  try {
    return typeof Reflect.get(value, "then") === "function";
  } catch {
    return false;
  }
}

function isDataDescriptor(descriptor: PropertyDescriptor): descriptor is PropertyDescriptor & {
  readonly value: unknown;
} {
  return Object.prototype.hasOwnProperty.call(descriptor, "value");
}

function isDenseArrayIndexKey(key: string, length: number): boolean {
  if (key.length === 0) return false;

  const numeric = Number(key);

  return Number.isSafeInteger(numeric) && numeric >= 0 && numeric < length && String(numeric) === key;
}

function hasOwn(value: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function compareFilesEntry(left: FilesEntry, right: FilesEntry): number {
  if (left.kind === "dir" && right.kind !== "dir") return -1;
  if (left.kind !== "dir" && right.kind === "dir") return 1;
  if (left.name < right.name) return -1;
  if (left.name > right.name) return 1;

  return 0;
}

function stableJson(value: HostBridgeJson): string {
  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    const entries: string[] = [];

    for (let index = 0; index < value.length; index += 1) {
      const item = value[index];

      if (item !== undefined) entries.push(stableJson(item));
    }

    return `[${entries.join(",")}]`;
  }

  const object = jsonObject(value);

  if (object === undefined) return "null";

  const keys = Object.keys(object).sort();
  const entries: string[] = [];

  for (let index = 0; index < keys.length; index += 1) {
    const key = keys[index];

    if (key !== undefined) entries.push(`${JSON.stringify(key)}:${stableJson(object[key] ?? null)}`);
  }

  return `{${entries.join(",")}}`;
}

function pathToken(value: string): string {
  return value.replaceAll("~", "~0").replaceAll("/", "~1");
}
