import type {
  DesktopAppLaunch,
  DesktopAppStop,
  DesktopCapabilityGrant,
  DesktopHost,
  DesktopHostError,
  DesktopHostResult,
  DesktopLaunchableApp,
  DesktopMaybePromise,
  DesktopSettingsApply,
  DesktopSettingsPreview,
  DesktopTheme,
  DesktopUiPackageManifest,
  FilesErrorResponse,
  FilesResponse,
  NotificationPostInput,
  RegisteredShellComponent,
  ShellApplyResult,
  ShellConfigDefinition,
  ShellManagedSnapshot,
  ShellPreviewResult,
  ShellResult,
  ShellRollbackResult,
  ShellComponentDefinition,
  ShellLayoutDiff,
  ShellNotification,
  TrayItem,
  TrayItemInput,
  WindowManagerIntent,
} from "../../../sdk/typescript/src/desktop-sdk/index.ts";
import {
  A11Y_CONTRASTS,
  A11Y_NUMERIC_PREFS,
  A11Y_PREFS_SETTING_KEYS,
} from "../viewmodels/a11y-prefs.ts";
import {
  INPUT_ACCESSIBILITY_SETTING_KEY,
} from "../viewmodels/input-accessibility.ts";
import {
  DEFAULT_KEYMAP_PROFILES,
  KEYBOARD_SETTINGS_KEYS,
} from "../viewmodels/keyboard-settings.ts";
import {
  SETTINGS_ACCENT_OPTIONS,
  SETTINGS_APPEARANCE_KEYS,
  SETTINGS_LAYOUTS,
  SETTINGS_SECTIONS,
  SETTINGS_THEMES,
} from "../viewmodels/Settings.ts";
import {
  WALLPAPER_FIT_MODES,
  WALLPAPER_SETTING_KEYS,
} from "../viewmodels/wallpaper.ts";
import type {
  LockAuthenticateRequest,
  LockAuthPort,
  LockAuthSession,
  LockUser,
} from "../viewmodels/Lock.ts";

export type HostBridgeJson =
  | null
  | boolean
  | number
  | string
  | readonly HostBridgeJson[]
  | HostBridgeJsonObject;

export interface HostBridgeJsonObject {
  readonly [key: string]: HostBridgeJson;
}

export type SurfaceHostMethod =
  | "registerComponent"
  | "previewShell"
  | "applyShell"
  | "rollbackShell"
  | "currentShell"
  | "launchApp"
  | "stopApp"
  | "postNotification"
  | "registerTrayItem"
  | "requestFile"
  | "readSetting"
  | "previewSetting"
  | "applySetting"
  | "emitLauncherIntent"
  | "readTheme";

export type SurfaceHostAuthMethod = "authenticateOwner";
export type SurfaceHostBridgeMethod = SurfaceHostMethod | SurfaceHostAuthMethod;

export interface SurfaceHostRequest {
  readonly method: SurfaceHostBridgeMethod;
  readonly args: readonly HostBridgeJson[];
}

export interface SurfaceHostTransport {
  readonly package?: DesktopUiPackageManifest;
  readonly methods?: readonly SurfaceHostBridgeMethod[];
  request(request: SurfaceHostRequest): DesktopMaybePromise<unknown>;
}

export type SurfaceHostTransportLike =
  | SurfaceHostTransport
  | ((request: SurfaceHostRequest) => DesktopMaybePromise<unknown>)
  | null
  | undefined;

export interface SurfaceHostOptions {
  readonly package?: DesktopUiPackageManifest;
}

export type SurfaceShellHostPorts = Pick<
  DesktopHost,
  "registerComponent" | "previewShell" | "applyShell" | "rollbackShell" | "currentShell"
>;
export type SurfaceAppHostPorts = Pick<DesktopHost, "package" | "launchApp" | "stopApp">;
export type SurfaceNotificationHostPorts = Pick<DesktopHost, "postNotification" | "registerTrayItem">;
export type SurfaceFilesHostPorts = Pick<DesktopHost, "requestFile">;
export type SurfaceSettingsHostPorts = Pick<
  DesktopHost,
  "readSetting" | "previewSetting" | "applySetting" | "readTheme"
>;
export type SurfaceLauncherHostPorts = Pick<DesktopHost, "package" | "emitLauncherIntent">;
export type SurfaceThemeHostPorts = Pick<DesktopHost, "readTheme">;

type RequestTransport = (request: SurfaceHostRequest) => DesktopMaybePromise<unknown>;
type HostBridgeShellLayout = ShellManagedSnapshot["layout"];

type JsonNormalizeResult =
  | {
      readonly ok: true;
      readonly value: HostBridgeJson;
    }
  | {
      readonly ok: false;
      readonly error: DesktopHostError;
    };

const MAX_JSON_DEPTH = 80;

const DESKTOP_SETTING_KEYS = Object.freeze([
  SETTINGS_APPEARANCE_KEYS.accent,
  SETTINGS_APPEARANCE_KEYS.activeSection,
  SETTINGS_APPEARANCE_KEYS.layout,
  SETTINGS_APPEARANCE_KEYS.theme,
  A11Y_PREFS_SETTING_KEYS.contrast,
  A11Y_PREFS_SETTING_KEYS.cursorSize,
  A11Y_PREFS_SETTING_KEYS.focusRingThickness,
  A11Y_PREFS_SETTING_KEYS.reduceMotion,
  A11Y_PREFS_SETTING_KEYS.reduceTransparency,
  A11Y_PREFS_SETTING_KEYS.textScale,
  A11Y_PREFS_SETTING_KEYS.uiZoom,
  INPUT_ACCESSIBILITY_SETTING_KEY,
  WALLPAPER_SETTING_KEYS.fit,
  WALLPAPER_SETTING_KEYS.slideshowIntervalMs,
  WALLPAPER_SETTING_KEYS.slideshowSources,
  WALLPAPER_SETTING_KEYS.solidColor,
  WALLPAPER_SETTING_KEYS.sourceRef,
  WALLPAPER_SETTING_KEYS.workspaceOverrides,
  KEYBOARD_SETTINGS_KEYS.overrides,
  KEYBOARD_SETTINGS_KEYS.profile,
] as const);

const INPUT_ACCESSIBILITY_POLICY_FIELDS = Object.freeze(["bounceKeys", "keyRepeat", "slowKeys", "stickyKeys"] as const);
const INPUT_ACCESSIBILITY_KEY_REPEAT_FIELDS = Object.freeze(["enabled", "repeatDelayMs", "repeatRateMs"] as const);
const INPUT_ACCESSIBILITY_STICKY_KEYS_FIELDS = Object.freeze(["enabled", "lockOnDoublePress"] as const);
const INPUT_ACCESSIBILITY_SLOW_KEYS_FIELDS = Object.freeze(["enabled", "holdThresholdMs"] as const);
const INPUT_ACCESSIBILITY_BOUNCE_KEYS_FIELDS = Object.freeze(["debounceWindowMs", "enabled"] as const);
const WALLPAPER_WORKSPACE_OVERRIDE_FIELDS = Object.freeze(["fit", "sourceRef", "workspaceId"] as const);
const KEYBOARD_OVERRIDE_FIELDS = Object.freeze(["chord", "commandId"] as const);
const READ_SETTING_REQUEST_FIELDS = Object.freeze(["key"] as const);

type DesktopSettingKey = typeof DESKTOP_SETTING_KEYS[number];

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
]) satisfies readonly DesktopCapabilityGrant[];

const DEFAULT_PACKAGE = Object.freeze({
  capabilityGrants: DEFAULT_PACKAGE_GRANTS,
  entry: "index.html",
  id: "vita.desktop.surface",
  sdkVersion: "0.0.0",
  version: "0.0.0",
}) satisfies DesktopUiPackageManifest;

const EMPTY_DIFF = Object.freeze({
  added: Object.freeze([]),
  changed: Object.freeze([]),
  removed: Object.freeze([]),
}) satisfies ShellLayoutDiff;

const FALLBACK_LAYOUT = Object.freeze({
  configId: "vita.host-bridge.degraded",
  css: Object.freeze({
    rules: Object.freeze([]),
    text: "",
  }),
  root: Object.freeze({
    children: Object.freeze([]),
    componentId: "vita.host-bridge.degraded",
    id: "surface:vita.host-bridge.degraded",
    path: "/",
    payload: Object.freeze({}),
    placement: Object.freeze({
      layer: "desktop",
      order: 0,
      zone: "degraded",
    }),
    role: "degraded",
    substrate: Object.freeze({}),
  }),
  revision: "0",
  surfaces: Object.freeze([]),
}) satisfies HostBridgeShellLayout;

const DEGRADED_THEME = Object.freeze({
  id: "vita.host-bridge.degraded",
  tokens: Object.freeze({
    colors: Object.freeze({
      background: "#000000",
      foreground: "#ffffff",
    }),
    radii: Object.freeze({
      sm: 0,
    }),
    spacing: Object.freeze({
      sm: 0,
    }),
    typography: Object.freeze({
      body: "system-ui",
    }),
  }),
  version: "0",
}) satisfies DesktopTheme;

export function createSurfaceHost(
  transport: SurfaceHostTransportLike,
  options: SurfaceHostOptions = Object.freeze({}),
): DesktopHost {
  const request = resolveTransport(transport);
  const hostPackage = resolvePackage(transport, options);
  const host: {
    package: DesktopUiPackageManifest;
    registerComponent(definition: ShellComponentDefinition): ShellResult<RegisteredShellComponent>;
    previewShell(definition: ShellConfigDefinition): ShellPreviewResult;
    applyShell(definition: ShellConfigDefinition): ShellApplyResult;
    rollbackShell(): ShellRollbackResult;
    currentShell?: NonNullable<DesktopHost["currentShell"]>;
    launchApp(app: DesktopLaunchableApp): Promise<DesktopHostResult<DesktopAppLaunch>>;
    stopApp(appId: string): Promise<DesktopHostResult<DesktopAppStop>>;
    postNotification(input: NotificationPostInput): ShellResult<ShellNotification>;
    registerTrayItem(input: TrayItemInput): ShellResult<TrayItem>;
    requestFile?: NonNullable<DesktopHost["requestFile"]>;
    readSetting?: NonNullable<DesktopHost["readSetting"]>;
    previewSetting?: NonNullable<DesktopHost["previewSetting"]>;
    applySetting?: NonNullable<DesktopHost["applySetting"]>;
    emitLauncherIntent?: NonNullable<DesktopHost["emitLauncherIntent"]>;
    readTheme(): DesktopTheme;
    lockAuth?: LockAuthPort;
  } = {
    applyShell(definition) {
      return forwardShellApply(request, "applyShell", [definition]);
    },
    async launchApp(app) {
      return await forwardHostResult(request, "launchApp", [app], isDesktopAppLaunch);
    },
    package: hostPackage,
    postNotification(input) {
      return forwardShellResult(request, "postNotification", [input], isShellNotification);
    },
    previewShell(definition) {
      return forwardShellPreview(request, "previewShell", [definition]);
    },
    readTheme() {
      return forwardTheme(request);
    },
    registerComponent(definition) {
      return forwardShellResult(request, "registerComponent", [definition], isRegisteredShellComponent);
    },
    registerTrayItem(input) {
      return forwardShellResult(request, "registerTrayItem", [input], isTrayItem);
    },
    rollbackShell() {
      return forwardShellRollback(request, "rollbackShell", []);
    },
    async stopApp(appId) {
      return await forwardHostResult(request, "stopApp", [appId], isDesktopAppStop);
    },
  };

  if (request !== undefined) {
    host.currentShell = () => forwardCurrentShell(request);
    host.requestFile = async (fileRequest) => await forwardPlainResponse(
      request,
      "requestFile",
      [fileRequest],
      isFilesResponse,
      filesReject,
    );
    host.readSetting = async (readRequest) => await forwardReadSetting(
      request,
      readRequest,
    );
    host.previewSetting = async (writeRequest) => await forwardHostResult(
      request,
      "previewSetting",
      [writeRequest],
      isDesktopSettingsPreview,
    );
    host.applySetting = async (writeRequest) => await forwardHostResult(
      request,
      "applySetting",
      [writeRequest],
      isDesktopSettingsApply,
    );
    host.emitLauncherIntent = async (intent) => await forwardHostResult(
      request,
      "emitLauncherIntent",
      [intent],
      isTrue,
    );

    if (transportAdvertisesMethod(transport, "authenticateOwner")) {
      host.lockAuth = Object.freeze({
        authenticate: async (authRequest: LockAuthenticateRequest) => await forwardLockAuth(request, authRequest),
      });
    }
  }

  return Object.freeze(host);
}

function resolveTransport(transport: SurfaceHostTransportLike): RequestTransport | undefined {
  if (typeof transport === "function") return transport;
  if (transport === null || transport === undefined || typeof transport !== "object") return undefined;

  try {
    const descriptor = Object.getOwnPropertyDescriptor(transport, "request");

    if (descriptor === undefined || !isDataDescriptor(descriptor) || typeof descriptor.value !== "function") {
      return undefined;
    }

    return (request) => descriptor.value.call(transport, request) as DesktopMaybePromise<unknown>;
  } catch {
    return undefined;
  }
}

function transportAdvertisesMethod(
  transport: SurfaceHostTransportLike,
  method: SurfaceHostAuthMethod,
): boolean {
  if (transport === null || transport === undefined) return false;
  if (typeof transport !== "object" && typeof transport !== "function") return false;

  try {
    const descriptor = Object.getOwnPropertyDescriptor(transport, "methods");

    if (descriptor === undefined || !isDataDescriptor(descriptor) || !Array.isArray(descriptor.value)) {
      return false;
    }
    if (Object.getPrototypeOf(descriptor.value) !== Array.prototype) return false;

    let found = false;

    for (let index = 0; index < descriptor.value.length; index += 1) {
      const item = descriptor.value[index];

      if (typeof item !== "string") return false;
      if (item === method) found = true;
    }

    return found;
  } catch {
    return false;
  }
}

function resolvePackage(
  transport: SurfaceHostTransportLike,
  options: SurfaceHostOptions,
): DesktopUiPackageManifest {
  const optionPackage = normalizePackage(options.package);

  if (optionPackage !== undefined) return optionPackage;

  if (transport !== null && transport !== undefined && typeof transport === "object") {
    try {
      const descriptor = Object.getOwnPropertyDescriptor(transport, "package");

      if (descriptor !== undefined && isDataDescriptor(descriptor)) {
        const transportPackage = normalizePackage(descriptor.value);

        if (transportPackage !== undefined) return transportPackage;
      }
    } catch {
      return DEFAULT_PACKAGE;
    }
  }

  return DEFAULT_PACKAGE;
}

async function forwardHostResult<T>(
  request: RequestTransport | undefined,
  method: SurfaceHostMethod,
  args: readonly unknown[],
  valueGuard: (value: unknown) => value is T,
): Promise<DesktopHostResult<T>> {
  const response = await forwardAsync(request, method, args);

  if (!response.ok) return hostReject(response.error);

  const result = normalizeHostResult(response.value, valueGuard, method);

  return result.ok ? result.value : hostReject(result.error);
}

async function forwardReadSetting(
  request: RequestTransport | undefined,
  readRequest: unknown,
): Promise<DesktopHostResult<HostBridgeJson>> {
  const outbound = buildRequest("readSetting", [readRequest]);

  if (!outbound.ok) return hostReject(outbound.error);

  const key = readSettingKeyFromRequest(outbound.value);

  if (key === undefined) {
    return hostReject(bridgeError("HOST_BRIDGE_MALFORMED_REQUEST", "readSetting request key must be a non-empty string.", "/readSetting/args/0/key"));
  }
  if (request === undefined) {
    return hostReject(bridgeError("HOST_BRIDGE_UNAVAILABLE", "host bridge transport is unavailable.", "/readSetting"));
  }

  let rawResponse: unknown;

  try {
    rawResponse = await request(outbound.value);
  } catch {
    return hostReject(bridgeError("HOST_BRIDGE_FAILED", "host bridge transport failed closed.", "/readSetting"));
  }

  const response = snapshotJson(rawResponse, "/readSetting/response");

  if (!response.ok) return hostReject(response.error);

  const result = normalizeHostResult(
    response.value,
    (value): value is HostBridgeJson => isDesktopSettingValue(key, value),
    "readSetting",
  );

  return result.ok ? result.value : hostReject(result.error);
}

async function forwardLockAuth(
  request: RequestTransport,
  authRequest: LockAuthenticateRequest,
): Promise<unknown> {
  const response = await forwardAsync(request, "authenticateOwner", [authRequest]);

  if (!response.ok) return hostReject(response.error);

  const result = normalizeHostResult(response.value, isLockAuthSession, "authenticateOwner");

  return result.ok ? result.value : hostReject(result.error);
}

async function forwardPlainResponse<T>(
  request: RequestTransport | undefined,
  method: SurfaceHostMethod,
  args: readonly unknown[],
  valueGuard: (value: unknown) => value is T,
  fallback: (error: DesktopHostError) => T,
): Promise<T> {
  const response = await forwardAsync(request, method, args);

  if (!response.ok) return fallback(response.error);
  if (!valueGuard(response.value)) {
    return fallback(bridgeError("HOST_BRIDGE_MALFORMED_RESPONSE", "host bridge returned malformed JSON.", `/${method}`));
  }

  return response.value;
}

function forwardShellResult<T>(
  request: RequestTransport | undefined,
  method: SurfaceHostMethod,
  args: readonly unknown[],
  valueGuard: (value: unknown) => value is T,
): ShellResult<T> {
  const response = forwardSync(request, method, args);

  if (!response.ok) return shellReject(response.error);

  const result = normalizeHostResult(response.value, valueGuard, method);

  return result.ok ? result.value : shellReject(result.error);
}

function forwardShellPreview(
  request: RequestTransport | undefined,
  method: SurfaceHostMethod,
  args: readonly unknown[],
): ShellPreviewResult {
  const response = forwardSync(request, method, args);

  if (!response.ok) return shellPreviewReject(response.error);
  if (!isShellPreviewResult(response.value)) {
    return shellPreviewReject(bridgeError("HOST_BRIDGE_MALFORMED_RESPONSE", "host bridge returned malformed shell preview.", `/${method}`));
  }

  return response.value;
}

function forwardShellApply(
  request: RequestTransport | undefined,
  method: SurfaceHostMethod,
  args: readonly unknown[],
): ShellApplyResult {
  const response = forwardSync(request, method, args);

  if (!response.ok) return shellApplyReject(response.error);
  if (!isShellApplyResult(response.value)) {
    return shellApplyReject(bridgeError("HOST_BRIDGE_MALFORMED_RESPONSE", "host bridge returned malformed shell apply.", `/${method}`));
  }

  return response.value;
}

function forwardShellRollback(
  request: RequestTransport | undefined,
  method: SurfaceHostMethod,
  args: readonly unknown[],
): ShellRollbackResult {
  const response = forwardSync(request, method, args);

  if (!response.ok) return shellRollbackReject(response.error);
  if (!isShellRollbackResult(response.value)) {
    return shellRollbackReject(bridgeError("HOST_BRIDGE_MALFORMED_RESPONSE", "host bridge returned malformed shell rollback.", `/${method}`));
  }

  return response.value;
}

function forwardTheme(request: RequestTransport | undefined): DesktopTheme {
  const response = forwardSync(request, "readTheme", []);

  if (!response.ok) return DEGRADED_THEME;
  if (!isDesktopTheme(response.value)) return DEGRADED_THEME;

  return response.value;
}

function forwardCurrentShell(request: RequestTransport): ShellManagedSnapshot {
  const response = forwardSync(request, "currentShell", []);

  if (!response.ok) return shellSnapshotReject(response.error);
  if (!isShellManagedSnapshot(response.value)) {
    return shellSnapshotReject(bridgeError("HOST_BRIDGE_MALFORMED_RESPONSE", "host bridge returned malformed shell snapshot.", "/currentShell"));
  }

  return response.value;
}

async function forwardAsync(
  request: RequestTransport | undefined,
  method: SurfaceHostBridgeMethod,
  args: readonly unknown[],
): Promise<JsonNormalizeResult> {
  const outbound = buildRequest(method, args);

  if (!outbound.ok) return outbound;
  if (request === undefined) {
    return rejectJson(bridgeError("HOST_BRIDGE_UNAVAILABLE", "host bridge transport is unavailable.", `/${method}`));
  }

  let rawResponse: unknown;

  try {
    rawResponse = await request(outbound.value);
  } catch {
    return rejectJson(bridgeError("HOST_BRIDGE_FAILED", "host bridge transport failed closed.", `/${method}`));
  }

  return snapshotJson(rawResponse, `/${method}/response`);
}

function forwardSync(
  request: RequestTransport | undefined,
  method: SurfaceHostMethod,
  args: readonly unknown[],
): JsonNormalizeResult {
  const outbound = buildRequest(method, args);

  if (!outbound.ok) return outbound;
  if (request === undefined) {
    return rejectJson(bridgeError("HOST_BRIDGE_UNAVAILABLE", "host bridge transport is unavailable.", `/${method}`));
  }

  let rawResponse: unknown;

  try {
    rawResponse = request(outbound.value);
  } catch {
    return rejectJson(bridgeError("HOST_BRIDGE_FAILED", "host bridge transport failed closed.", `/${method}`));
  }

  return snapshotJson(rawResponse, `/${method}/response`);
}

function buildRequest(method: SurfaceHostBridgeMethod, args: readonly unknown[]): JsonNormalizeResult & {
  readonly value?: SurfaceHostRequest;
} {
  const normalizedArgs: HostBridgeJson[] = [];

  for (let index = 0; index < args.length; index += 1) {
    const value = args[index];
    const normalized = snapshotJson(value, `/${method}/args/${index}`);

    if (!normalized.ok) return normalized;
    normalizedArgs.push(normalized.value);
  }

  return {
    ok: true,
    value: Object.freeze({
      args: Object.freeze(normalizedArgs),
      method,
    }),
  };
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
    return rejectJson(bridgeError("HOST_BRIDGE_NON_JSON", "value exceeds the host bridge JSON depth limit.", path));
  }

  if (input === null || typeof input === "string" || typeof input === "boolean") {
    return acceptJson(input);
  }
  if (typeof input === "number") {
    return Number.isFinite(input)
      ? acceptJson(input)
      : rejectJson(bridgeError("HOST_BRIDGE_NON_JSON", "number must be finite JSON.", path));
  }
  if (typeof input !== "object") {
    return rejectJson(bridgeError("HOST_BRIDGE_NON_JSON", "value must be plain JSON.", path));
  }

  try {
    if (seen.has(input)) {
      return rejectJson(bridgeError("HOST_BRIDGE_NON_JSON", "cyclic values are not JSON.", path));
    }

    seen.add(input);

    if (Array.isArray(input)) {
      return snapshotJsonArray(input, path, depth, seen);
    }

    const prototype = Object.getPrototypeOf(input);

    if (prototype !== Object.prototype && prototype !== null) {
      return rejectJson(bridgeError("HOST_BRIDGE_NON_JSON", "object must be a plain JSON object.", path));
    }

    const output: { [key: string]: HostBridgeJson } = {};
    const keys = Reflect.ownKeys(input);

    for (let index = 0; index < keys.length; index += 1) {
      const key = keys[index];

      if (key === undefined || typeof key === "symbol") {
        return rejectJson(bridgeError("HOST_BRIDGE_NON_JSON", "JSON object keys must be strings.", path));
      }

      const descriptor = Object.getOwnPropertyDescriptor(input, key);

      if (descriptor === undefined || !isDataDescriptor(descriptor) || descriptor.enumerable !== true) {
        return rejectJson(bridgeError("HOST_BRIDGE_NON_JSON", "JSON object fields must be enumerable data fields.", `${path}/${pathToken(key)}`));
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
    return rejectJson(bridgeError("HOST_BRIDGE_NON_JSON", "value must be stable plain JSON.", path));
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
      return rejectJson(bridgeError("HOST_BRIDGE_NON_JSON", "array must be a plain JSON array.", path));
    }

    const keys = Reflect.ownKeys(input);

    for (let index = 0; index < keys.length; index += 1) {
      const key = keys[index];

      if (key === "length") continue;
      if (key === undefined || typeof key === "symbol" || !isDenseArrayIndexKey(key, input.length)) {
        return rejectJson(bridgeError("HOST_BRIDGE_NON_JSON", "array contains a non-JSON field.", path));
      }

      const descriptor = Object.getOwnPropertyDescriptor(input, key);

      if (descriptor === undefined || !isDataDescriptor(descriptor) || descriptor.enumerable !== true) {
        return rejectJson(bridgeError("HOST_BRIDGE_NON_JSON", "array entries must be enumerable data fields.", `${path}/${key}`));
      }
    }

    const output: HostBridgeJson[] = [];

    for (let index = 0; index < input.length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(input, `${index}`);

      if (descriptor === undefined || !isDataDescriptor(descriptor) || descriptor.enumerable !== true) {
        return rejectJson(bridgeError("HOST_BRIDGE_NON_JSON", "array must be dense JSON.", `${path}/${index}`));
      }

      const normalized = snapshotJsonValue(descriptor.value, `${path}/${index}`, depth + 1, seen);

      if (!normalized.ok) return normalized;
      output.push(normalized.value);
    }

    return acceptJson(Object.freeze(output));
  } catch {
    return rejectJson(bridgeError("HOST_BRIDGE_NON_JSON", "array must be stable plain JSON.", path));
  }
}

function normalizeHostResult<T>(
  input: HostBridgeJson,
  valueGuard: (value: unknown) => value is T,
  method: SurfaceHostBridgeMethod,
): {
  readonly ok: true;
  readonly value: DesktopHostResult<T>;
} | {
  readonly ok: false;
  readonly error: DesktopHostError;
} {
  const result = jsonObject(input);

  if (result === undefined) {
    return rejectNormalize(bridgeError("HOST_BRIDGE_MALFORMED_RESPONSE", "host bridge result must be an object.", `/${method}`));
  }

  const ok = result["ok"];
  const hasValue = hasJsonField(result, "value");
  const hasError = hasJsonField(result, "error");

  if (ok === true) {
    const value = result["value"];

    if (!hasValue || hasError || value === undefined || !valueGuard(value)) {
      return rejectNormalize(bridgeError("HOST_BRIDGE_MALFORMED_RESPONSE", "host bridge success result is malformed.", `/${method}/value`));
    }

    return acceptNormalize(Object.freeze({
      ok: true,
      value,
    }));
  }

  if (ok === false) {
    const errorValue = result["error"];

    if (!hasError || hasValue || !isHostError(errorValue)) {
      return rejectNormalize(bridgeError("HOST_BRIDGE_MALFORMED_RESPONSE", "host bridge failure result is malformed.", `/${method}/error`));
    }

    return acceptNormalize(Object.freeze({
      error: errorValue,
      ok: false,
    }));
  }

  return rejectNormalize(bridgeError("HOST_BRIDGE_MALFORMED_RESPONSE", "host bridge result ok field must be boolean.", `/${method}/ok`));
}

function normalizePackage(input: unknown): DesktopUiPackageManifest | undefined {
  const normalized = snapshotJson(input, "/package");

  if (!normalized.ok || !isDesktopUiPackageManifest(normalized.value)) return undefined;

  return normalized.value;
}

function isDesktopUiPackageManifest(value: unknown): value is DesktopUiPackageManifest {
  const manifest = jsonObject(value);

  if (manifest === undefined) return false;

  return (
    typeof manifest["id"] === "string" &&
    typeof manifest["version"] === "string" &&
    typeof manifest["sdkVersion"] === "string" &&
    typeof manifest["entry"] === "string" &&
    isCapabilityGrantArray(manifest["capabilityGrants"])
  );
}

function isCapabilityGrantArray(value: unknown): value is readonly DesktopCapabilityGrant[] {
  if (!Array.isArray(value)) return false;

  for (let index = 0; index < value.length; index += 1) {
    const grant = jsonObject(value[index]);

    if (
      grant === undefined ||
      typeof grant["capability"] !== "string" ||
      (grant["resourceId"] !== undefined && typeof grant["resourceId"] !== "string")
    ) {
      return false;
    }
  }

  return true;
}

function isDesktopAppLaunch(value: unknown): value is DesktopAppLaunch {
  const launch = jsonObject(value);

  return launch !== undefined &&
    isDesktopLaunchableApp(launch["app"]) &&
    typeof launch["surfaceId"] === "string" &&
    typeof launch["windowId"] === "string" &&
    typeof launch["textureId"] === "string" &&
    isWindowManagerIntentArray(launch["intents"]);
}

function isDesktopAppStop(value: unknown): value is DesktopAppStop {
  const stop = jsonObject(value);

  return stop !== undefined &&
    typeof stop["appId"] === "string" &&
    optionalString(stop["surfaceId"]) &&
    optionalString(stop["windowId"]) &&
    optionalString(stop["textureId"]) &&
    isWindowManagerIntentArray(stop["intents"]);
}

function isDesktopLaunchableApp(value: unknown): value is DesktopLaunchableApp {
  const app = jsonObject(value);

  if (app === undefined) return false;
  if (typeof app["id"] !== "string" || typeof app["title"] !== "string") return false;
  if (!isWindowHintsOrAbsent(app["defaultWindow"])) return false;

  const surfaceKind = app["surfaceKind"];
  const runtime = jsonObject(app["runtime"]);

  if (surfaceKind === "tsx") {
    return runtime !== undefined &&
      typeof runtime["componentId"] === "string" &&
      (runtime["props"] === undefined || jsonObject(runtime["props"]) !== undefined);
  }
  if (surfaceKind === "web") {
    return runtime !== undefined &&
      typeof runtime["url"] === "string" &&
      optionalString(runtime["partition"]);
  }

  return false;
}

function isWindowHintsOrAbsent(value: unknown): boolean {
  if (value === undefined) return true;

  const hints = jsonObject(value);

  return hints !== undefined &&
    optionalString(hints["workspaceId"]) &&
    optionalString(hints["zone"]) &&
    optionalString(hints["layer"]) &&
    optionalString(hints["anchor"]) &&
    optionalString(hints["className"]) &&
    (hints["order"] === undefined || isFiniteNumber(hints["order"])) &&
    (hints["rect"] === undefined || isRect(hints["rect"])) &&
    (hints["mode"] === undefined || hints["mode"] === "tiled" || hints["mode"] === "floating");
}

function isWindowManagerIntentArray(value: unknown): value is readonly WindowManagerIntent[] {
  if (!Array.isArray(value)) return false;

  for (let index = 0; index < value.length; index += 1) {
    const intent = jsonObject(value[index]);

    if (intent === undefined || typeof intent["type"] !== "string") return false;

    if (intent["type"] === "repositionTexture") {
      if (
        typeof intent["windowId"] !== "string" ||
        typeof intent["textureId"] !== "string" ||
        !isRect(intent["rect"])
      ) {
        return false;
      }
    } else if (intent["type"] === "setFocus") {
      if (!(intent["windowId"] === null || typeof intent["windowId"] === "string")) return false;
    } else if (intent["type"] === "setTextureVisibility") {
      if (
        typeof intent["windowId"] !== "string" ||
        typeof intent["textureId"] !== "string" ||
        typeof intent["visible"] !== "boolean"
      ) {
        return false;
      }
    } else {
      return false;
    }
  }

  return true;
}

function readSettingKeyFromRequest(request: SurfaceHostRequest): string | undefined {
  const readRequest = jsonObject(request.args[0]);

  if (readRequest === undefined || !hasOnlyJsonKeys(readRequest, READ_SETTING_REQUEST_FIELDS)) return undefined;

  const key = readRequest["key"];

  return typeof key === "string" && key.length > 0 ? key : undefined;
}

function isDesktopSettingValue(key: string, value: unknown): value is HostBridgeJson {
  if (!isDesktopSettingKey(key)) return false;

  switch (key) {
    case SETTINGS_APPEARANCE_KEYS.theme:
      return isStringEnum(value, SETTINGS_THEMES);
    case SETTINGS_APPEARANCE_KEYS.accent:
      return isSettingsAccent(value);
    case SETTINGS_APPEARANCE_KEYS.layout:
      return isStringEnum(value, SETTINGS_LAYOUTS);
    case SETTINGS_APPEARANCE_KEYS.activeSection:
      return isSettingsSection(value);
    case A11Y_PREFS_SETTING_KEYS.contrast:
      return isStringEnum(value, A11Y_CONTRASTS);
    case A11Y_PREFS_SETTING_KEYS.reduceMotion:
    case A11Y_PREFS_SETTING_KEYS.reduceTransparency:
      return typeof value === "boolean";
    case A11Y_PREFS_SETTING_KEYS.cursorSize:
      return isNumberInRange(value, A11Y_NUMERIC_PREFS.cursorSize.min, A11Y_NUMERIC_PREFS.cursorSize.max);
    case A11Y_PREFS_SETTING_KEYS.focusRingThickness:
      return isNumberInRange(
        value,
        A11Y_NUMERIC_PREFS.focusRingThickness.min,
        A11Y_NUMERIC_PREFS.focusRingThickness.max,
      );
    case A11Y_PREFS_SETTING_KEYS.textScale:
      return isNumberInRange(value, A11Y_NUMERIC_PREFS.textScale.min, A11Y_NUMERIC_PREFS.textScale.max);
    case A11Y_PREFS_SETTING_KEYS.uiZoom:
      return isNumberInRange(value, A11Y_NUMERIC_PREFS.uiZoom.min, A11Y_NUMERIC_PREFS.uiZoom.max);
    case INPUT_ACCESSIBILITY_SETTING_KEY:
      return isInputAccessibilityPolicy(value);
    case WALLPAPER_SETTING_KEYS.fit:
      return isStringEnum(value, WALLPAPER_FIT_MODES);
    case WALLPAPER_SETTING_KEYS.sourceRef:
      return isSupportedString(value, false);
    case WALLPAPER_SETTING_KEYS.solidColor:
      return isSupportedString(value, true);
    case WALLPAPER_SETTING_KEYS.slideshowIntervalMs:
      return isSafeIntegerAtLeast(value, 1);
    case WALLPAPER_SETTING_KEYS.slideshowSources:
      return isEncodedStringArray(value);
    case WALLPAPER_SETTING_KEYS.workspaceOverrides:
      return isEncodedWorkspaceOverrides(value);
    case KEYBOARD_SETTINGS_KEYS.overrides:
      return isEncodedKeyboardOverrides(value);
    case KEYBOARD_SETTINGS_KEYS.profile:
      return isKeyboardProfile(value);
    default:
      return false;
  }
}

function isDesktopSettingKey(value: string): value is DesktopSettingKey {
  return containsString(DESKTOP_SETTING_KEYS, value);
}

function isSettingsAccent(value: unknown): boolean {
  if (typeof value !== "string") return false;

  for (let index = 0; index < SETTINGS_ACCENT_OPTIONS.length; index += 1) {
    if (SETTINGS_ACCENT_OPTIONS[index]?.id === value) return true;
  }

  return false;
}

function isSettingsSection(value: unknown): boolean {
  if (typeof value !== "string") return false;

  for (let index = 0; index < SETTINGS_SECTIONS.length; index += 1) {
    if (SETTINGS_SECTIONS[index]?.id === value) return true;
  }

  return false;
}

function isKeyboardProfile(value: unknown): boolean {
  if (typeof value !== "string") return false;

  for (let index = 0; index < DEFAULT_KEYMAP_PROFILES.length; index += 1) {
    if (DEFAULT_KEYMAP_PROFILES[index]?.id === value) return true;
  }

  return false;
}

function isInputAccessibilityPolicy(value: unknown): boolean {
  const policy = jsonObject(value);

  if (policy === undefined || !hasOnlyJsonKeys(policy, INPUT_ACCESSIBILITY_POLICY_FIELDS)) return false;

  return (
    isInputKeyRepeatPolicy(policy["keyRepeat"]) &&
    isInputStickyKeysPolicy(policy["stickyKeys"]) &&
    isInputSlowKeysPolicy(policy["slowKeys"]) &&
    isInputBounceKeysPolicy(policy["bounceKeys"])
  );
}

function isInputKeyRepeatPolicy(value: unknown): boolean {
  const policy = jsonObject(value);

  return policy !== undefined &&
    hasOnlyJsonKeys(policy, INPUT_ACCESSIBILITY_KEY_REPEAT_FIELDS) &&
    typeof policy["enabled"] === "boolean" &&
    isSafeIntegerAtLeast(policy["repeatDelayMs"], 0) &&
    isSafeIntegerAtLeast(policy["repeatRateMs"], 1);
}

function isInputStickyKeysPolicy(value: unknown): boolean {
  const policy = jsonObject(value);

  return policy !== undefined &&
    hasOnlyJsonKeys(policy, INPUT_ACCESSIBILITY_STICKY_KEYS_FIELDS) &&
    typeof policy["enabled"] === "boolean" &&
    typeof policy["lockOnDoublePress"] === "boolean";
}

function isInputSlowKeysPolicy(value: unknown): boolean {
  const policy = jsonObject(value);

  return policy !== undefined &&
    hasOnlyJsonKeys(policy, INPUT_ACCESSIBILITY_SLOW_KEYS_FIELDS) &&
    typeof policy["enabled"] === "boolean" &&
    isSafeIntegerAtLeast(policy["holdThresholdMs"], 0);
}

function isInputBounceKeysPolicy(value: unknown): boolean {
  const policy = jsonObject(value);

  return policy !== undefined &&
    hasOnlyJsonKeys(policy, INPUT_ACCESSIBILITY_BOUNCE_KEYS_FIELDS) &&
    isSafeIntegerAtLeast(policy["debounceWindowMs"], 0) &&
    typeof policy["enabled"] === "boolean";
}

function isEncodedStringArray(value: unknown): boolean {
  const parsed = parseEncodedArray(value);

  if (parsed === undefined) return false;

  for (let index = 0; index < parsed.length; index += 1) {
    const item = parsed[index];

    if (typeof item !== "string" || item.length === 0) return false;
  }

  return true;
}

function isEncodedWorkspaceOverrides(value: unknown): boolean {
  const parsed = parseEncodedArray(value);

  if (parsed === undefined) return false;

  for (let index = 0; index < parsed.length; index += 1) {
    const item = jsonObject(parsed[index]);

    if (item === undefined || !hasOnlyJsonKeys(item, WALLPAPER_WORKSPACE_OVERRIDE_FIELDS)) return false;
    if (!isSupportedString(item["workspaceId"], true)) return false;
    if (!isSupportedString(item["sourceRef"], true)) return false;
    if (!isStringEnum(item["fit"], WALLPAPER_FIT_MODES)) return false;
  }

  return true;
}

function isEncodedKeyboardOverrides(value: unknown): boolean {
  const parsed = parseEncodedArray(value);

  if (parsed === undefined) return false;

  for (let index = 0; index < parsed.length; index += 1) {
    const item = jsonObject(parsed[index]);

    if (item === undefined || !hasOnlyJsonKeys(item, KEYBOARD_OVERRIDE_FIELDS)) return false;
    if (!isSupportedString(item["chord"], true)) return false;
    if (!isSupportedString(item["commandId"], true)) return false;
  }

  return true;
}

function parseEncodedArray(value: unknown): readonly HostBridgeJson[] | undefined {
  if (typeof value !== "string") return undefined;
  if (value.trim().length === 0) return Object.freeze([]);

  let parsed: unknown;

  try {
    parsed = JSON.parse(value);
  } catch {
    return undefined;
  }

  const normalized = snapshotJson(parsed, "/readSetting/value");

  if (!normalized.ok || !Array.isArray(normalized.value)) return undefined;

  return normalized.value;
}

function isStringEnum<T extends string>(value: unknown, options: readonly T[]): value is T {
  return typeof value === "string" && containsString(options, value);
}

function isSupportedString(value: unknown, nonEmpty: boolean): value is string {
  return typeof value === "string" && (!nonEmpty || value.length > 0);
}

function isNumberInRange(value: unknown, min: number, max: number): value is number {
  return isFiniteNumber(value) && value >= min && value <= max;
}

function isSafeIntegerAtLeast(value: unknown, min: number): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= min;
}

function isDesktopSettingsPreview(value: unknown): value is DesktopSettingsPreview {
  const preview = jsonObject(value);

  return preview !== undefined &&
    typeof preview["revision"] === "string" &&
    jsonObject(preview["diff"]) !== undefined;
}

function isDesktopSettingsApply(value: unknown): value is DesktopSettingsApply {
  const apply = jsonObject(value);

  return apply !== undefined &&
    typeof apply["revision"] === "string" &&
    jsonObject(apply["applied"]) !== undefined;
}

function isLockAuthSession(value: unknown): value is LockAuthSession {
  const session = jsonObject(value);

  if (session === undefined || !isLockUser(session["user"])) return false;

  const sessionId = session["sessionId"];
  const authenticatedAtMs = session["authenticatedAtMs"];

  return (
    (sessionId === undefined || (typeof sessionId === "string" && sessionId.length > 0)) &&
    (authenticatedAtMs === undefined || isFiniteNumber(authenticatedAtMs))
  );
}

function isLockUser(value: unknown): value is LockUser {
  const user = jsonObject(value);

  return user !== undefined &&
    typeof user["id"] === "string" &&
    user["id"].length > 0 &&
    typeof user["displayName"] === "string" &&
    user["displayName"].length > 0 &&
    typeof user["initials"] === "string" &&
    user["initials"].length > 0;
}

function isFilesResponse(value: unknown): value is FilesResponse | FilesErrorResponse {
  const response = jsonObject(value);

  if (response === undefined) return false;

  const errorValue = response["error"];

  if (errorValue !== undefined) {
    const fileError = jsonObject(errorValue);

    return fileError !== undefined &&
      typeof fileError["code"] === "string" &&
      typeof fileError["message"] === "string";
  }

  return (
    (response["entries"] === undefined || isFilesEntryArray(response["entries"])) &&
    optionalString(response["data"]) &&
    (response["kind"] === undefined || response["kind"] === "file" || response["kind"] === "dir" || response["kind"] === "symlink-skipped") &&
    (response["size"] === undefined || isFiniteNumber(response["size"])) &&
    optionalString(response["mtime"])
  );
}

function isFilesEntryArray(value: unknown): boolean {
  if (!Array.isArray(value)) return false;

  for (let index = 0; index < value.length; index += 1) {
    const entry = jsonObject(value[index]);

    if (
      entry === undefined ||
      typeof entry["name"] !== "string" ||
      !(entry["kind"] === "file" || entry["kind"] === "dir" || entry["kind"] === "symlink-skipped") ||
      !isFiniteNumber(entry["size"]) ||
      typeof entry["mtime"] !== "string"
    ) {
      return false;
    }
  }

  return true;
}

function isShellNotification(value: unknown): value is ShellNotification {
  const notification = jsonObject(value);

  return notification !== undefined &&
    typeof notification["appId"] === "string" &&
    typeof notification["id"] === "string" &&
    typeof notification["title"] === "string" &&
    isNotificationPriority(notification["priority"]) &&
    isFiniteNumber(notification["createdAtMs"]) &&
    isNotificationActionArray(notification["actions"]) &&
    optionalString(notification["body"]) &&
    (notification["expiresAtMs"] === undefined || isFiniteNumber(notification["expiresAtMs"]));
}

function isNotificationActionArray(value: unknown): boolean {
  if (!Array.isArray(value)) return false;

  for (let index = 0; index < value.length; index += 1) {
    const action = jsonObject(value[index]);

    if (
      action === undefined ||
      typeof action["id"] !== "string" ||
      typeof action["label"] !== "string" ||
      !isActionStyle(action["style"])
    ) {
      return false;
    }
  }

  return true;
}

function isTrayItem(value: unknown): value is TrayItem {
  const item = jsonObject(value);

  return item !== undefined &&
    typeof item["appId"] === "string" &&
    typeof item["id"] === "string" &&
    typeof item["iconRef"] === "string" &&
    typeof item["tooltip"] === "string" &&
    isFiniteNumber(item["order"]) &&
    isTrayMenuItemArray(item["menu"]) &&
    (item["status"] === undefined || item["status"] === "ok" || item["status"] === "warning" || item["status"] === "critical" || item["status"] === "offline");
}

function isTrayMenuItemArray(value: unknown): boolean {
  if (!Array.isArray(value)) return false;

  for (let index = 0; index < value.length; index += 1) {
    const item = jsonObject(value[index]);

    if (
      item === undefined ||
      typeof item["id"] !== "string" ||
      typeof item["label"] !== "string" ||
      typeof item["enabled"] !== "boolean" ||
      !isTrayMenuItemArray(item["items"]) ||
      (item["checked"] !== undefined && typeof item["checked"] !== "boolean")
    ) {
      return false;
    }
  }

  return true;
}

function isRegisteredShellComponent(_value: unknown): _value is RegisteredShellComponent {
  return false;
}

function isShellPreviewResult(value: unknown): value is ShellPreviewResult {
  const result = jsonObject(value);

  if (result === undefined) return false;
  if (result["ok"] === true) {
    return isShellLayout(result["layout"]) && isShellDiff(result["diff"]);
  }

  return result["ok"] === false &&
    isHostError(result["error"]) &&
    isShellLayout(result["fallbackLayout"]) &&
    isShellDiff(result["diff"]);
}

function isShellApplyResult(value: unknown): value is ShellApplyResult {
  const result = jsonObject(value);

  if (result === undefined) return false;
  if (result["ok"] === true) {
    return result["outcome"] === "committed" &&
      isShellLayout(result["layout"]) &&
      isShellDiff(result["diff"]);
  }

  return result["ok"] === false &&
    (result["outcome"] === "fallback" || result["outcome"] === "failsafe") &&
    isHostError(result["error"]) &&
    isShellLayout(result["layout"]) &&
    isShellLayout(result["fallbackLayout"]) &&
    (result["status"] === undefined || result["status"] === "FAILSAFE");
}

function isShellRollbackResult(value: unknown): value is ShellRollbackResult {
  const result = jsonObject(value);

  if (result === undefined) return false;
  if (result["ok"] === true) {
    return (result["outcome"] === "rolledBack" || result["outcome"] === "fallback") &&
      isShellLayout(result["layout"]);
  }

  return result["ok"] === false &&
    (result["outcome"] === "fallback" || result["outcome"] === "failsafe") &&
    isHostError(result["error"]) &&
    isShellLayout(result["layout"]) &&
    (result["status"] === undefined || result["status"] === "FAILSAFE");
}

function isShellManagedSnapshot(value: unknown): value is ShellManagedSnapshot {
  const snapshot = jsonObject(value);

  return snapshot !== undefined &&
    (snapshot["source"] === "configured" || snapshot["source"] === "fallback") &&
    isShellLayout(snapshot["layout"]) &&
    (snapshot["error"] === undefined || isHostError(snapshot["error"]));
}

function isShellLayout(value: unknown): value is HostBridgeShellLayout {
  const layout = jsonObject(value);

  return layout !== undefined &&
    typeof layout["configId"] === "string" &&
    typeof layout["revision"] === "string" &&
    isShellStyleSheet(layout["css"]) &&
    isShellResolvedSurface(layout["root"]) &&
    isShellSurfaceArray(layout["surfaces"]);
}

function isShellStyleSheet(value: unknown): boolean {
  const styleSheet = jsonObject(value);

  return styleSheet !== undefined &&
    typeof styleSheet["text"] === "string" &&
    Array.isArray(styleSheet["rules"]);
}

function isShellResolvedSurface(value: unknown): boolean {
  const surface = jsonObject(value);

  return surface !== undefined &&
    typeof surface["id"] === "string" &&
    typeof surface["componentId"] === "string" &&
    typeof surface["role"] === "string" &&
    typeof surface["path"] === "string" &&
    isPlacement(surface["placement"]) &&
    jsonObject(surface["payload"]) !== undefined &&
    jsonObject(surface["substrate"]) !== undefined &&
    isShellSurfaceArray(surface["children"]) &&
    optionalString(surface["key"]) &&
    optionalString(surface["className"]) &&
    optionalString(surface["parentSurfaceId"]);
}

function isShellSurfaceArray(value: unknown): boolean {
  if (!Array.isArray(value)) return false;

  for (let index = 0; index < value.length; index += 1) {
    if (!isShellResolvedSurface(value[index])) return false;
  }

  return true;
}

function isShellDiff(value: unknown): value is ShellLayoutDiff {
  const diff = jsonObject(value);

  return diff !== undefined &&
    isStringArray(diff["added"]) &&
    isStringArray(diff["removed"]) &&
    isStringArray(diff["changed"]);
}

function isDesktopTheme(value: unknown): value is DesktopTheme {
  const theme = jsonObject(value);
  const tokens = jsonObject(theme?.["tokens"]);

  return theme !== undefined &&
    typeof theme["id"] === "string" &&
    typeof theme["version"] === "string" &&
    tokens !== undefined &&
    isStringRecord(tokens["colors"]) &&
    isNumberRecord(tokens["spacing"]) &&
    isNumberRecord(tokens["radii"]) &&
    isStringOrNumberRecord(tokens["typography"]);
}

function isHostError(value: unknown): value is DesktopHostError {
  const errorValue = jsonObject(value);

  return errorValue !== undefined &&
    typeof errorValue["code"] === "string" &&
    typeof errorValue["message"] === "string" &&
    typeof errorValue["path"] === "string";
}

function isPlacement(value: unknown): boolean {
  const placement = jsonObject(value);

  return placement !== undefined &&
    typeof placement["zone"] === "string" &&
    typeof placement["layer"] === "string" &&
    isFiniteNumber(placement["order"]) &&
    optionalString(placement["anchor"]) &&
    optionalString(placement["workspace"]) &&
    (placement["rect"] === undefined || isRect(placement["rect"]));
}

function isRect(value: unknown): boolean {
  const rect = jsonObject(value);

  return rect !== undefined &&
    isFiniteNumber(rect["x"]) &&
    isFiniteNumber(rect["y"]) &&
    isFiniteNumber(rect["width"]) &&
    isFiniteNumber(rect["height"]);
}

function isStringArray(value: unknown): value is readonly string[] {
  if (!Array.isArray(value)) return false;

  for (let index = 0; index < value.length; index += 1) {
    if (typeof value[index] !== "string") return false;
  }

  return true;
}

function isStringRecord(value: unknown): boolean {
  const record = jsonObject(value);

  if (record === undefined) return false;

  return jsonRecordValues(record, (item) => typeof item === "string");
}

function isNumberRecord(value: unknown): boolean {
  const record = jsonObject(value);

  if (record === undefined) return false;

  return jsonRecordValues(record, isFiniteNumber);
}

function isStringOrNumberRecord(value: unknown): boolean {
  const record = jsonObject(value);

  if (record === undefined) return false;

  return jsonRecordValues(record, (item) => typeof item === "string" || isFiniteNumber(item));
}

function jsonRecordValues(
  record: Readonly<Record<string, unknown>>,
  guard: (value: unknown) => boolean,
): boolean {
  const keys = Object.keys(record);

  for (let index = 0; index < keys.length; index += 1) {
    const key = keys[index];

    if (key === undefined) return false;
    const value = record[key];

    if (value === undefined || !guard(value)) return false;
  }

  return true;
}

function isNotificationPriority(value: unknown): boolean {
  return value === "low" || value === "normal" || value === "high" || value === "urgent" || value === "critical";
}

function isActionStyle(value: unknown): boolean {
  return value === "default" || value === "primary" || value === "destructive";
}

function isTrue(value: unknown): value is true {
  return value === true;
}

function jsonObject(value: unknown): Readonly<Record<string, unknown>> | undefined {
  if (value === undefined || value === null || typeof value !== "object" || Array.isArray(value)) return undefined;

  return value as Readonly<Record<string, unknown>>;
}

function hasJsonField(value: Readonly<Record<string, unknown>>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function hasOnlyJsonKeys(value: Readonly<Record<string, unknown>>, expected: readonly string[]): boolean {
  const keys = Object.keys(value);

  if (keys.length !== expected.length) return false;

  for (let index = 0; index < keys.length; index += 1) {
    const key = keys[index];

    if (key === undefined || !containsString(expected, key)) return false;
  }

  return true;
}

function containsString<T extends string>(values: readonly T[], value: string): value is T {
  for (let index = 0; index < values.length; index += 1) {
    if (values[index] === value) return true;
  }

  return false;
}

function optionalString(value: unknown): boolean {
  return value === undefined || typeof value === "string";
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function filesReject(errorValue: DesktopHostError): FilesErrorResponse {
  return Object.freeze({
    error: Object.freeze({
      code: errorValue.code,
      message: errorValue.message,
    }),
  });
}

function hostReject<T>(errorValue: DesktopHostError): DesktopHostResult<T> {
  return Object.freeze({
    error: errorValue,
    ok: false,
  });
}

function shellReject<T>(errorValue: DesktopHostError): ShellResult<T> {
  return Object.freeze({
    error: errorValue,
    ok: false,
  });
}

function shellPreviewReject(errorValue: DesktopHostError): ShellPreviewResult {
  return Object.freeze({
    diff: EMPTY_DIFF,
    error: errorValue,
    fallbackLayout: FALLBACK_LAYOUT,
    ok: false,
  });
}

function shellApplyReject(errorValue: DesktopHostError): ShellApplyResult {
  return Object.freeze({
    error: errorValue,
    fallbackLayout: FALLBACK_LAYOUT,
    layout: FALLBACK_LAYOUT,
    ok: false,
    outcome: "fallback",
  });
}

function shellRollbackReject(errorValue: DesktopHostError): ShellRollbackResult {
  return Object.freeze({
    error: errorValue,
    layout: FALLBACK_LAYOUT,
    ok: false,
    outcome: "fallback",
  });
}

function shellSnapshotReject(errorValue: DesktopHostError): ShellManagedSnapshot {
  return Object.freeze({
    error: errorValue,
    layout: FALLBACK_LAYOUT,
    source: "fallback",
  });
}

function bridgeError(code: string, message: string, path: string): DesktopHostError {
  return Object.freeze({
    code,
    message,
    path,
  });
}

function acceptJson(value: HostBridgeJson): JsonNormalizeResult {
  return Object.freeze({
    ok: true,
    value,
  });
}

function rejectJson(error: DesktopHostError): JsonNormalizeResult {
  return Object.freeze({
    error,
    ok: false,
  });
}

function acceptNormalize<T>(value: T): {
  readonly ok: true;
  readonly value: T;
} {
  return Object.freeze({
    ok: true,
    value,
  });
}

function rejectNormalize<T>(error: DesktopHostError): {
  readonly ok: false;
  readonly error: DesktopHostError;
} {
  return Object.freeze({
    error,
    ok: false,
  });
}

function isDenseArrayIndexKey(key: string, length: number): boolean {
  if (key.length === 0) return false;

  const numeric = Number(key);

  return Number.isSafeInteger(numeric) && numeric >= 0 && numeric < length && String(numeric) === key;
}

function isDataDescriptor(descriptor: PropertyDescriptor): descriptor is PropertyDescriptor & {
  readonly value: unknown;
} {
  return Object.prototype.hasOwnProperty.call(descriptor, "value");
}

function pathToken(value: string): string {
  return value.replaceAll("~", "~0").replaceAll("/", "~1");
}
