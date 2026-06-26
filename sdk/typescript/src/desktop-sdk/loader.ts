import { types as nodeTypes } from "node:util";

import {
  composeKnownGoodFallbackShell,
  defineShellComponent,
  knownGoodFallbackShellConfig,
  shellSurface,
} from "../shell/index.ts";
import type {
  RegisteredShellComponent,
  ShellApplyResult,
  ShellCssDefinition,
  ShellComponentDefinition,
  ShellConfigDefinition,
  ShellLayoutDiff,
  ShellPlacementInput,
  ShellPreviewResult,
  ShellResult,
} from "../shell/index.ts";
import type {
  NotificationPostInput,
  ShellNotification,
  TrayItem,
  TrayItemInput,
} from "../shell/notifications/index.ts";
import { parseSemver, compareSemver } from "../semver.ts";
import type { Semver } from "../semver.ts";
import { parseRange, satisfies } from "../semver-range.ts";
import type { SemverRange } from "../semver-range.ts";
import { safeNormalize } from "../safe-normalize.ts";
import type { PlainJson, PlainJsonObject } from "../safe-normalize.ts";
import type { AppWindowHints, TsxComponentRef, WebviewRuntimeRef } from "../appshell/index.ts";
import type { FilesErrorResponse, FilesRequest, FilesResponse } from "../files-grant.ts";
import { SDK_VERSION } from "./version.ts";
import type {
  DesktopAppLaunch,
  DesktopAppStop,
  DesktopCapability,
  DesktopCapabilityGrant,
  DesktopHost,
  DesktopHostError,
  DesktopHostResult,
  DesktopLaunchableApp,
  DesktopMaybePromise,
  DesktopSdkCompatibility,
  DesktopSettingsApply,
  DesktopSettingsPreview,
  DesktopSettingsReadRequest,
  DesktopSettingsWriteRequest,
  DesktopTheme,
  DesktopUiInstance,
  DesktopUiPackage,
  DesktopUiPackageManifest,
  DesktopLauncherIntent,
} from "./ui-package.ts";

export const KNOWN_GOOD_DESKTOP_UI_PACKAGE_ID = "vita.desktop-ui.known-good";

export interface DesktopUiValidationError {
  readonly code: string;
  readonly message: string;
  readonly path: string;
}

export type DesktopUiValidationResult<T> =
  | {
      readonly ok: true;
      readonly value: T;
    }
  | {
      readonly ok: false;
      readonly error: DesktopUiValidationError;
    };

export interface DesktopUiLoaderOptions {
  readonly sdkVersion?: string;
  readonly fallbackPackage?: DesktopUiPackage;
}

export interface DesktopUiLoadedPackage {
  readonly manifest: DesktopUiPackageManifest;
  readonly instance: DesktopUiInstance;
  readonly source: "requested" | "fallback";
}

export type DesktopUiLoadResult =
  | {
      readonly ok: true;
      readonly loaded: DesktopUiLoadedPackage;
      readonly recoveredFrom?: DesktopUiValidationError;
    }
  | {
      readonly ok: false;
      readonly error: DesktopUiValidationError;
      readonly fallbackError?: DesktopUiValidationError;
    };

interface SnapshotUiPackage {
  readonly manifest: DesktopUiPackageManifest;
  readonly mount: (host: DesktopHost) => DesktopMaybePromise<DesktopUiInstance>;
}

interface SnapshotUiInstance {
  readonly instance: DesktopUiInstance;
  readonly unmount: () => DesktopMaybePromise<void>;
}

const SDK_VERSION_COMPATIBILITY: SemverRange = Object.freeze({
  max: "2.0.0",
  min: SDK_VERSION,
});

const PACKAGE_FIELDS = Object.freeze(["manifest", "mount"]);
const MANIFEST_FIELDS = Object.freeze(["capabilityGrants", "entry", "id", "sdkVersion", "version"]);
const GRANT_FIELDS = Object.freeze(["capability", "resourceId"]);
const SDK_RANGE_FIELDS = Object.freeze(["max", "maxInclusive", "min", "minInclusive"]);
const READ_FILE_OPS = Object.freeze(["list", "read", "stat"]);
const RESERVED_COMPONENT_ID_PREFIX = "vita.";
const SHELL_COMPONENT_FIELDS = Object.freeze(["defaultPlacement", "id", "render", "role"]);
const SHELL_CONFIG_REQUIRED_FIELDS = Object.freeze(["id", "render"]);
const SHELL_CONFIG_OPTIONAL_FIELDS = Object.freeze(["css", "revision"]);
const SHELL_CSS_FIELDS = Object.freeze(["rules", "text"]);
const SHELL_CSS_RULE_FIELDS = Object.freeze(["declarations", "selector"]);
const PLACEMENT_FIELDS = Object.freeze(["anchor", "layer", "order", "rect", "workspace", "zone"]);
const RECT_FIELDS = Object.freeze(["height", "width", "x", "y"]);
const APP_DESCRIPTOR_REQUIRED_FIELDS = Object.freeze(["id", "runtime", "surfaceKind", "title"]);
const APP_DESCRIPTOR_OPTIONAL_FIELDS = Object.freeze(["defaultWindow"]);
const TSX_RUNTIME_REQUIRED_FIELDS = Object.freeze(["componentId"]);
const TSX_RUNTIME_OPTIONAL_FIELDS = Object.freeze(["props"]);
const WEB_RUNTIME_REQUIRED_FIELDS = Object.freeze(["url"]);
const WEB_RUNTIME_OPTIONAL_FIELDS = Object.freeze(["partition"]);
const APP_WINDOW_FIELDS = Object.freeze(["anchor", "className", "layer", "mode", "order", "rect", "workspaceId", "zone"]);
const NOTIFICATION_REQUIRED_FIELDS = Object.freeze(["id", "title"]);
const NOTIFICATION_OPTIONAL_FIELDS = Object.freeze(["actions", "body", "expiresAtMs", "priority", "ttlMs"]);
const NOTIFICATION_ACTION_REQUIRED_FIELDS = Object.freeze(["id", "label"]);
const NOTIFICATION_ACTION_OPTIONAL_FIELDS = Object.freeze(["style"]);
const TRAY_ITEM_REQUIRED_FIELDS = Object.freeze(["iconRef", "id", "tooltip"]);
const TRAY_ITEM_OPTIONAL_FIELDS = Object.freeze(["menu", "order", "status"]);
const TRAY_MENU_ITEM_REQUIRED_FIELDS = Object.freeze(["id", "label"]);
const TRAY_MENU_ITEM_OPTIONAL_FIELDS = Object.freeze(["checked", "enabled", "items"]);
const FILE_REQUEST_REQUIRED_FIELDS = Object.freeze(["grant", "op", "path"]);
const FILE_REQUEST_OPTIONAL_FIELDS = Object.freeze(["data"]);
const SETTINGS_READ_FIELDS = Object.freeze(["key"]);
const SETTINGS_WRITE_FIELDS = Object.freeze(["key", "value"]);
const LAUNCHER_INTENT_REQUIRED_FIELDS = Object.freeze(["type"]);
const LAUNCHER_INTENT_OPTIONAL_FIELDS = Object.freeze(["appId", "query"]);
const CAPABILITY_DENIED_CODE = "CAP_DENIED";

export const knownGoodDesktopUiPackage: DesktopUiPackage = Object.freeze({
  manifest: Object.freeze({
    capabilityGrants: Object.freeze([]),
    entry: "builtin:known-good",
    id: KNOWN_GOOD_DESKTOP_UI_PACKAGE_ID,
    sdkVersion: SDK_VERSION_COMPATIBILITY,
    version: "1.0.0",
  }),
  mount(host: DesktopHost): DesktopUiInstance {
    const config = knownGoodFallbackShellConfig();
    const registered = host.registerComponent(defineShellComponent({
      defaultPlacement: {
        layer: "overlay",
        order: 0,
        zone: "center",
      },
      id: config.id,
      render: () => shellSurface({
        message: "Shell edit failed closed to the known-good fallback.",
        safeMode: true,
        title: "Vita Fallback Shell",
      }),
      role: "fallback",
    }));

    if (!registered.ok && registered.error.code !== "DUPLICATE_COMPONENT") {
      throw new DesktopUiPackageLoadError("FALLBACK_REGISTER_FAILED", registered.error.message, registered.error.path);
    }

    const preview = host.previewShell(config);

    if (!preview.ok) {
      throw new DesktopUiPackageLoadError("FALLBACK_PREVIEW_FAILED", preview.error.message, preview.error.path);
    }

    const applied = host.applyShell(config);

    if (!applied.ok) {
      throw new DesktopUiPackageLoadError("FALLBACK_APPLY_FAILED", applied.error.message, applied.error.path);
    }

    return Object.freeze({
      packageId: KNOWN_GOOD_DESKTOP_UI_PACKAGE_ID,
      unmount() {
        host.rollbackShell();
      },
    });
  },
});

class DesktopUiPackageLoadError extends Error {
  readonly code: string;
  readonly path: string;

  constructor(code: string, message: string, path: string) {
    super(message);
    this.name = "DesktopUiPackageLoadError";
    this.code = code;
    this.path = path;
  }
}

export class DesktopUiPackageLoader {
  readonly #host: DesktopHost;
  readonly #sdkVersion: string;
  readonly #fallbackPackage: DesktopUiPackage;
  #current: DesktopUiLoadedPackage | null = null;

  constructor(host: DesktopHost, options: DesktopUiLoaderOptions = Object.freeze({})) {
    this.#host = host;
    this.#sdkVersion = options.sdkVersion ?? SDK_VERSION;
    this.#fallbackPackage = options.fallbackPackage ?? knownGoodDesktopUiPackage;
  }

  current(): DesktopUiLoadedPackage | null {
    return this.#current;
  }

  async load(uiPackage: unknown): Promise<DesktopUiLoadResult> {
    return this.swap(uiPackage);
  }

  async swap(uiPackage: unknown): Promise<DesktopUiLoadResult> {
    const snapshot = snapshotDesktopUiPackage(uiPackage, this.#sdkVersion);

    if (!snapshot.ok) {
      return await this.#recoverWithFallback(snapshot.error);
    }

    const unmounted = await this.#unmountCurrent();

    if (!unmounted.ok) {
      const rolledBack = callRollback(this.#host);
      const cause = rolledBack.ok ? unmounted.error : rolledBack.error;

      return await this.#recoverWithFallback(cause);
    }

    const mounted = await mountSnapshot(snapshot.value, this.#host, "requested");

    if (mounted.ok) {
      this.#current = mounted.value;
      return Object.freeze({
        loaded: mounted.value,
        ok: true,
      });
    }

    const rolledBack = callRollback(this.#host);
    const cause = rolledBack.ok ? mounted.error : rolledBack.error;

    return await this.#recoverWithFallback(cause);
  }

  async unmount(): Promise<DesktopUiValidationResult<true>> {
    const unmounted = await this.#unmountCurrent();

    if (!unmounted.ok) return unmounted;
    this.#current = null;
    return accept(true);
  }

  async #recoverWithFallback(cause: DesktopUiValidationError): Promise<DesktopUiLoadResult> {
    const unmounted = await this.#unmountCurrent();

    if (!unmounted.ok) {
      return Object.freeze({
        error: cause,
        fallbackError: unmounted.error,
        ok: false,
      });
    }

    const fallbackSnapshot = snapshotDesktopUiPackage(this.#fallbackPackage, this.#sdkVersion);

    if (!fallbackSnapshot.ok) {
      return Object.freeze({
        error: cause,
        fallbackError: fallbackSnapshot.error,
        ok: false,
      });
    }

    const fallback = await mountSnapshot(
      fallbackSnapshot.value,
      this.#host,
      "fallback",
      this.#fallbackPackage === knownGoodDesktopUiPackage,
    );

    if (!fallback.ok) {
      return Object.freeze({
        error: cause,
        fallbackError: fallback.error,
        ok: false,
      });
    }

    this.#current = fallback.value;
    return Object.freeze({
      loaded: fallback.value,
      ok: true,
      recoveredFrom: cause,
    });
  }

  async #unmountCurrent(): Promise<DesktopUiValidationResult<true>> {
    const current = this.#current;

    if (current === null) return accept(true);

    const instance = snapshotDesktopUiInstance(current.instance, `/packages/${pathToken(current.manifest.id)}/instance`);

    if (!instance.ok) return instance;

    try {
      await instance.value.unmount();
    } catch (error) {
      return reject(
        "UI_PACKAGE_UNMOUNT_FAILED",
        loadErrorMessage(error, "UI package unmount failed closed."),
        `/packages/${pathToken(current.manifest.id)}/unmount`,
      );
    }

    this.#current = null;
    return accept(true);
  }
}

export function loadUiPackage(
  uiPackage: unknown,
  host: DesktopHost,
  options: DesktopUiLoaderOptions = Object.freeze({}),
): Promise<DesktopUiLoadResult> {
  return new DesktopUiPackageLoader(host, options).load(uiPackage);
}

export function validateDesktopUiPackageManifest(
  input: unknown,
  currentSdkVersion = SDK_VERSION,
): DesktopUiValidationResult<DesktopUiPackageManifest> {
  const normalized = safeNormalize(input);

  if (!normalized.ok) {
    return reject("INVALID_UI_PACKAGE_MANIFEST", normalized.reason, "/manifest");
  }
  if (!isPlainObject(normalized.value)) {
    return reject("INVALID_UI_PACKAGE_MANIFEST", "manifest must be a plain object.", "/manifest");
  }

  const fields = expectFields(normalized.value, MANIFEST_FIELDS, Object.freeze([]), "/manifest");

  if (!fields.ok) return fields;

  const id = requiredString(normalized.value, "id", "/manifest/id");
  const version = requiredString(normalized.value, "version", "/manifest/version");
  const entry = requiredString(normalized.value, "entry", "/manifest/entry");
  const sdkVersion = normalizeSdkCompatibility(field(normalized.value, "sdkVersion"), "/manifest/sdkVersion");
  const grants = normalizeCapabilityGrants(field(normalized.value, "capabilityGrants"), "/manifest/capabilityGrants");

  if (!id.ok) return id;
  if (!version.ok) return version;
  if (!entry.ok) return entry;
  if (!sdkVersion.ok) return sdkVersion;
  if (!grants.ok) return grants;

  const parsedVersion = parseSemver(version.value);

  if (!parsedVersion.ok) {
    return reject("INVALID_UI_PACKAGE_VERSION", parsedVersion.reason, "/manifest/version");
  }
  if (!isSdkVersionCompatible(sdkVersion.value, currentSdkVersion)) {
    return reject(
      "SDK_VERSION_INCOMPATIBLE",
      `UI package requires an SDK version incompatible with ${currentSdkVersion}.`,
      "/manifest/sdkVersion",
    );
  }

  return accept(Object.freeze({
    capabilityGrants: grants.value,
    entry: entry.value,
    id: id.value,
    sdkVersion: sdkVersion.value,
    version: version.value,
  }));
}

export function isSdkVersionCompatible(
  compatibility: unknown,
  currentSdkVersion = SDK_VERSION,
): boolean {
  if (typeof compatibility === "string") {
    return isSemverCompatible(compatibility, currentSdkVersion);
  }

  return satisfies(currentSdkVersion, compatibility);
}

export function hasDesktopCapabilityGrant(
  manifest: DesktopUiPackageManifest,
  capability: DesktopCapability,
  resourceId?: string,
): boolean {
  for (let index = 0; index < manifest.capabilityGrants.length; index += 1) {
    const grant = manifest.capabilityGrants[index];

    if (grant === undefined || grant.capability !== capability) continue;
    if (grant.resourceId === undefined) return true;
    if (resourceId !== undefined && grant.resourceId === resourceId) return true;
  }

  return false;
}

export function createDesktopHostForPackage(
  host: DesktopHost,
  manifest: DesktopUiPackageManifest,
  options: {
    readonly builtIn?: boolean;
  } = Object.freeze({}),
): DesktopHost {
  const canRegisterReservedComponents = options.builtIn === true;
  const packageManifest = snapshotDesktopCapabilityManifest(manifest);
  const scoped: {
    package: DesktopUiPackageManifest;
    registerComponent: (definition: ShellComponentDefinition) => ShellResult<RegisteredShellComponent>;
    previewShell: (definition: ShellConfigDefinition) => ReturnType<DesktopHost["previewShell"]>;
    applyShell: (definition: ShellConfigDefinition) => ReturnType<DesktopHost["applyShell"]>;
    rollbackShell: () => ReturnType<DesktopHost["rollbackShell"]>;
    currentShell?: () => NonNullable<ReturnType<NonNullable<DesktopHost["currentShell"]>>>;
    launchApp: (app: DesktopLaunchableApp) => DesktopMaybePromise<DesktopHostResult<DesktopAppLaunch>>;
    stopApp: (appId: string) => DesktopMaybePromise<DesktopHostResult<DesktopAppStop>>;
    postNotification: (input: NotificationPostInput) => ShellResult<ShellNotification>;
    registerTrayItem: (input: TrayItemInput) => ShellResult<TrayItem>;
    requestFile?: (request: FilesRequest) => DesktopMaybePromise<FilesResponse | FilesErrorResponse>;
    readSetting?: (request: DesktopSettingsReadRequest) => DesktopMaybePromise<DesktopHostResult<PlainJson>>;
    previewSetting?: (request: DesktopSettingsWriteRequest) => DesktopMaybePromise<DesktopHostResult<DesktopSettingsPreview>>;
    applySetting?: (request: DesktopSettingsWriteRequest) => DesktopMaybePromise<DesktopHostResult<DesktopSettingsApply>>;
    emitLauncherIntent?: (intent: DesktopLauncherIntent) => DesktopMaybePromise<DesktopHostResult<true>>;
    readTheme: () => DesktopTheme;
  } = {
    applyShell(definition) {
      const config = snapshotShellConfigDefinition(definition, "/applyShell");

      if (!config.ok) return shellApplyFailure(config.error);

      return host.applyShell(config.value);
    },
    launchApp(app) {
      const snapshot = normalizeDesktopLaunchableApp(app, "/launchApp/app");

      if (!snapshot.ok) return hostRejectFromValidation(snapshot.error);
      const grant = requireDesktopCapabilityGrant(packageManifest, "launchApp", snapshot.value.id);

      if (!grant.ok) return hostRejectFromValidation(grant.error);

      return host.launchApp(snapshot.value);
    },
    package: packageManifest,
    postNotification(input) {
      const snapshot = normalizeNotificationPostInput(input, "/postNotification");

      if (!snapshot.ok) return shellRejectFromValidation(snapshot.error);
      const grant = requireDesktopCapabilityGrant(packageManifest, "postNotification", snapshot.value.id);

      if (!grant.ok) return shellRejectFromValidation(grant.error);

      return host.postNotification(snapshot.value);
    },
    previewShell(definition) {
      const config = snapshotShellConfigDefinition(definition, "/previewShell");

      if (!config.ok) return shellPreviewFailure(config.error);

      return host.previewShell(config.value);
    },
    readTheme() {
      return host.readTheme();
    },
    registerComponent(definition) {
      const component = snapshotShellComponentDefinition(definition, "/registerComponent");

      if (!component.ok) return shellRejectFromValidation(component.error);
      if (!canRegisterReservedComponents && isReservedComponentId(component.value.id)) {
        return shellReject(
          "RESERVED_COMPONENT_ID",
          "package cannot register a reserved Vita shell component.",
          "/registerComponent/id",
        );
      }

      return host.registerComponent(component.value);
    },
    registerTrayItem(input) {
      const snapshot = normalizeTrayItemInput(input, "/registerTrayItem");

      if (!snapshot.ok) return shellRejectFromValidation(snapshot.error);
      const grant = requireDesktopCapabilityGrant(packageManifest, "registerTrayItem", snapshot.value.id);

      if (!grant.ok) return shellRejectFromValidation(grant.error);

      return host.registerTrayItem(snapshot.value);
    },
    rollbackShell() {
      return host.rollbackShell();
    },
    stopApp(appId) {
      const snapshot = normalizeStringInput(appId, "/stopApp/appId");

      if (!snapshot.ok) return hostRejectFromValidation(snapshot.error);
      const grant = requireDesktopCapabilityGrant(packageManifest, "stopApp", snapshot.value);

      if (!grant.ok) return hostRejectFromValidation(grant.error);

      return host.stopApp(snapshot.value);
    },
  };

  if (host.currentShell !== undefined) {
    scoped.currentShell = () => host.currentShell?.() ?? hostCurrentMissing();
  }
  if (host.requestFile !== undefined) {
    scoped.requestFile = (request) => {
      const snapshot = normalizeFilesRequest(request, "/requestFile");

      if (!snapshot.ok) return filesRejectFromValidation(snapshot.error);

      const grant = requireDesktopCapabilityGrant(packageManifest, "requestFile", snapshot.value.grant, snapshot.value);

      if (!grant.ok) return filesRejectCapabilityDenied(grant.error);

      return host.requestFile?.(snapshot.value) ?? Object.freeze({
        error: Object.freeze({
          code: "FILES_PORT_UNAVAILABLE",
          message: "files port is unavailable.",
        }),
      });
    };
  }
  if (host.readSetting !== undefined) {
    scoped.readSetting = (request) => {
      const snapshot = normalizeSettingsReadRequest(request, "/readSetting");

      if (!snapshot.ok) return hostRejectFromValidation(snapshot.error);
      const grant = requireDesktopCapabilityGrant(packageManifest, "readSetting", snapshot.value.key);

      if (!grant.ok) return hostRejectFromValidation(grant.error);

      return host.readSetting?.(snapshot.value) ?? hostReject("SETTINGS_PORT_UNAVAILABLE", "settings port is unavailable.", "/settings");
    };
  }
  if (host.previewSetting !== undefined) {
    scoped.previewSetting = (request) => {
      const snapshot = normalizeSettingsWriteRequest(request, "/previewSetting");

      if (!snapshot.ok) return hostRejectFromValidation(snapshot.error);
      const grant = requireDesktopCapabilityGrant(packageManifest, "previewSetting", snapshot.value.key);

      if (!grant.ok) return hostRejectFromValidation(grant.error);

      return host.previewSetting?.(snapshot.value) ?? hostReject("SETTINGS_PORT_UNAVAILABLE", "settings port is unavailable.", "/settings");
    };
  }
  if (host.applySetting !== undefined) {
    scoped.applySetting = (request) => {
      const snapshot = normalizeSettingsWriteRequest(request, "/applySetting");

      if (!snapshot.ok) return hostRejectFromValidation(snapshot.error);
      const grant = requireDesktopCapabilityGrant(packageManifest, "applySetting", snapshot.value.key);

      if (!grant.ok) return hostRejectFromValidation(grant.error);

      return host.applySetting?.(snapshot.value) ?? hostReject("SETTINGS_PORT_UNAVAILABLE", "settings port is unavailable.", "/settings");
    };
  }
  if (host.emitLauncherIntent !== undefined) {
    scoped.emitLauncherIntent = (intent) => {
      const snapshot = normalizeLauncherIntent(intent, "/emitLauncherIntent");

      if (!snapshot.ok) return hostRejectFromValidation(snapshot.error);
      const grant = requireDesktopCapabilityGrant(packageManifest, "emitLauncherIntent", snapshot.value.appId);

      if (!grant.ok) return hostRejectFromValidation(grant.error);

      return host.emitLauncherIntent?.(snapshot.value) ?? hostReject("LAUNCHER_PORT_UNAVAILABLE", "launcher port is unavailable.", "/launcher");
    };
  }

  return Object.freeze(scoped);
}

function snapshotDesktopCapabilityManifest(manifest: DesktopUiPackageManifest): DesktopUiPackageManifest {
  return Object.freeze({
    capabilityGrants: snapshotDesktopCapabilityGrants(manifest.capabilityGrants),
    entry: manifest.entry,
    id: manifest.id,
    sdkVersion: manifest.sdkVersion,
    version: manifest.version,
  });
}

function snapshotDesktopCapabilityGrants(
  capabilityGrants: readonly DesktopCapabilityGrant[],
): readonly DesktopCapabilityGrant[] {
  const snapshot: DesktopCapabilityGrant[] = [];

  for (let index = 0; index < capabilityGrants.length; index += 1) {
    const grant = capabilityGrants[index];

    if (grant === undefined) continue;

    const normalized: {
      capability: DesktopCapability;
      resourceId?: string;
    } = {
      capability: grant.capability,
    };

    if (grant.resourceId !== undefined) normalized.resourceId = grant.resourceId;
    snapshot.push(Object.freeze(normalized));
  }

  return Object.freeze(snapshot);
}

function requireDesktopCapabilityGrant(
  manifest: DesktopUiPackageManifest,
  method: string,
  resourceId?: string,
  fileRequest?: FilesRequest,
): DesktopUiValidationResult<DesktopCapability> {
  const capability = desktopCapabilityForRoute(method, fileRequest);

  if (capability === null || !hasDesktopCapabilityGrant(manifest, capability, resourceId)) {
    return reject(
      CAPABILITY_DENIED_CODE,
      capabilityDeniedMessage(method),
      capabilityDeniedPath(capability),
    );
  }

  return accept(capability);
}

function desktopCapabilityForRoute(method: string, fileRequest?: FilesRequest): DesktopCapability | null {
  switch (method) {
    case "launchApp":
      return "apps.launch";
    case "stopApp":
      return "apps.stop";
    case "requestFile":
      return fileRequest === undefined ? null : fileCapabilityForRequest(fileRequest);
    case "readSetting":
      return "settings.read";
    case "previewSetting":
    case "applySetting":
      return "settings.write";
    case "emitLauncherIntent":
      return "launcher.launch";
    case "postNotification":
      return "shell.notifications.post";
    case "registerTrayItem":
      return "shell.tray.register";
    default:
      return null;
  }
}

function capabilityDeniedMessage(method: string): string {
  switch (method) {
    case "launchApp":
      return "package cannot launch this app.";
    case "stopApp":
      return "package cannot stop this app.";
    case "requestFile":
      return "package cannot use this file grant.";
    case "readSetting":
      return "package cannot read this setting.";
    case "previewSetting":
      return "package cannot preview this setting.";
    case "applySetting":
      return "package cannot apply this setting.";
    case "emitLauncherIntent":
      return "package cannot emit this launcher intent.";
    case "postNotification":
      return "package cannot post this notification.";
    case "registerTrayItem":
      return "package cannot register this tray item.";
    default:
      return "package cannot use this host route.";
  }
}

function capabilityDeniedPath(capability: DesktopCapability | null): string {
  if (capability === null) return "/capabilityGrants";

  return `/capabilityGrants/${capability}`;
}

function snapshotDesktopUiPackage(input: unknown, currentSdkVersion: string): DesktopUiValidationResult<SnapshotUiPackage> {
  const object = snapshotCallableObject(input, PACKAGE_FIELDS, Object.freeze([]), "/package");

  if (!object.ok) return object;

  const manifest = validateDesktopUiPackageManifest(object.value["manifest"], currentSdkVersion);

  if (!manifest.ok) return manifest;

  const mount = object.value["mount"];

  if (typeof mount !== "function") {
    return reject("INVALID_UI_PACKAGE", "package mount must be a function.", "/package/mount");
  }

  return accept(Object.freeze({
    manifest: manifest.value,
    mount: mount as (host: DesktopHost) => DesktopMaybePromise<DesktopUiInstance>,
  }));
}

function snapshotDesktopUiInstance(input: unknown, path: string): DesktopUiValidationResult<SnapshotUiInstance> {
  const object = snapshotCallableObject(input, Object.freeze(["unmount"]), Object.freeze(["packageId"]), path);

  if (!object.ok) return object;

  const packageId = object.value["packageId"];
  const unmount = object.value["unmount"];

  if (packageId !== undefined && typeof packageId !== "string") {
    return reject("INVALID_UI_INSTANCE", "instance packageId must be a string when present.", `${path}/packageId`);
  }
  if (typeof unmount !== "function") {
    return reject("INVALID_UI_INSTANCE", "instance unmount must be a function.", `${path}/unmount`);
  }

  const instance: {
    packageId?: string;
    unmount: () => DesktopMaybePromise<void>;
  } = {
    unmount: unmount as () => DesktopMaybePromise<void>,
  };

  if (packageId !== undefined) instance.packageId = packageId;

  return accept(Object.freeze({
    instance: Object.freeze(instance),
    unmount: instance.unmount,
  }));
}

async function mountSnapshot(
  snapshot: SnapshotUiPackage,
  host: DesktopHost,
  source: "requested" | "fallback",
  builtIn = false,
): Promise<DesktopUiValidationResult<DesktopUiLoadedPackage>> {
  let rawInstance: unknown;

  try {
    rawInstance = await snapshot.mount(createDesktopHostForPackage(host, snapshot.manifest, {
      builtIn,
    }));
  } catch (error) {
    return reject(
      "UI_PACKAGE_MOUNT_FAILED",
      loadErrorMessage(error, "UI package mount failed closed."),
      `/packages/${pathToken(snapshot.manifest.id)}/mount`,
    );
  }

  const instance = snapshotDesktopUiInstance(rawInstance, `/packages/${pathToken(snapshot.manifest.id)}/instance`);

  if (!instance.ok) return instance;

  return accept(Object.freeze({
    instance: instance.value.instance,
    manifest: snapshot.manifest,
    source,
  }));
}

function snapshotCallableObject(
  input: unknown,
  requiredFields: readonly string[],
  optionalFields: readonly string[],
  path: string,
): DesktopUiValidationResult<Readonly<Record<string, unknown>>> {
  try {
    if (input === null || typeof input !== "object" || Array.isArray(input) || nodeTypes.isProxy(input)) {
      return reject("INVALID_OBJECT", "value must be a plain object.", path);
    }

    const prototype = Object.getPrototypeOf(input);

    if (prototype !== Object.prototype && prototype !== null) {
      return reject("INVALID_OBJECT", "value must be a plain object.", path);
    }

    const keys = Reflect.ownKeys(input);
    const output: Record<string, unknown> = Object.create(null) as Record<string, unknown>;

    for (let index = 0; index < keys.length; index += 1) {
      const key = keys[index];

      if (key === undefined || typeof key === "symbol") {
        return reject("INVALID_OBJECT", "value must contain only supported data properties.", path);
      }
      if (!contains(requiredFields, key) && !contains(optionalFields, key)) {
        return reject("UNEXPECTED_FIELD", "value contains an unsupported field.", `${path}/${pathToken(key)}`);
      }

      const descriptor = Object.getOwnPropertyDescriptor(input, key);

      if (
        descriptor === undefined ||
        !Object.prototype.hasOwnProperty.call(descriptor, "value") ||
        descriptor.enumerable !== true
      ) {
        return reject("INVALID_OBJECT", "value must contain only enumerable data properties.", `${path}/${pathToken(key)}`);
      }

      Object.defineProperty(output, key, {
        configurable: true,
        enumerable: true,
        value: descriptor.value,
        writable: true,
      });
    }

    for (let index = 0; index < requiredFields.length; index += 1) {
      const key = requiredFields[index];

      if (key !== undefined && !Object.hasOwn(output, key)) {
        return reject("MISSING_FIELD", "value is missing a required field.", `${path}/${key}`);
      }
    }

    return accept(Object.freeze(output));
  } catch {
    return reject("INVALID_OBJECT", "value must be a plain object.", path);
  }
}

function snapshotShellComponentDefinition(
  input: unknown,
  path: string,
): DesktopUiValidationResult<ShellComponentDefinition> {
  const object = snapshotCallableObject(input, SHELL_COMPONENT_FIELDS, Object.freeze([]), path);

  if (!object.ok) return object;

  const id = normalizeUnknownString(object.value["id"], `${path}/id`, true);
  const role = normalizeUnknownString(object.value["role"], `${path}/role`, true);
  const placement = normalizeShellPlacementInput(object.value["defaultPlacement"], `${path}/defaultPlacement`);
  const render = object.value["render"];

  if (!id.ok) return id;
  if (!role.ok) return role;
  if (!placement.ok) return placement;
  if (typeof render !== "function") {
    return reject("INVALID_HOST_REQUEST", "component render must be a function.", `${path}/render`);
  }

  return accept(Object.freeze({
    defaultPlacement: placement.value,
    id: id.value,
    render: render as ShellComponentDefinition["render"],
    role: role.value,
  }));
}

function snapshotShellConfigDefinition(
  input: unknown,
  path: string,
): DesktopUiValidationResult<ShellConfigDefinition> {
  const object = snapshotCallableObject(input, SHELL_CONFIG_REQUIRED_FIELDS, SHELL_CONFIG_OPTIONAL_FIELDS, path);

  if (!object.ok) return object;

  const id = normalizeUnknownString(object.value["id"], `${path}/id`, true);
  const revision = normalizeOptionalUnknownString(object.value["revision"], `${path}/revision`, true);
  const css = normalizeShellCssDefinition(object.value["css"], `${path}/css`);
  const render = object.value["render"];

  if (!id.ok) return id;
  if (!revision.ok) return revision;
  if (!css.ok) return css;
  if (typeof render !== "function") {
    return reject("INVALID_HOST_REQUEST", "shell config render must be a function.", `${path}/render`);
  }

  const output: {
    id: string;
    render: ShellConfigDefinition["render"];
    css?: ShellCssDefinition;
    revision?: string;
  } = {
    id: id.value,
    render: render as ShellConfigDefinition["render"],
  };

  if (css.value !== undefined) output.css = css.value;
  if (revision.value !== undefined) output.revision = revision.value;

  return accept(Object.freeze(output));
}

function normalizeDesktopLaunchableApp(
  input: unknown,
  path: string,
): DesktopUiValidationResult<DesktopLaunchableApp> {
  const object = normalizeHostRequestObject(input, APP_DESCRIPTOR_REQUIRED_FIELDS, APP_DESCRIPTOR_OPTIONAL_FIELDS, path);

  if (!object.ok) return object;

  const id = normalizePlainString(field(object.value, "id"), `${path}/id`, true);
  const title = normalizePlainString(field(object.value, "title"), `${path}/title`, false);
  const defaultWindow = normalizeAppWindowHints(field(object.value, "defaultWindow"), `${path}/defaultWindow`);
  const surfaceKind = field(object.value, "surfaceKind");

  if (!id.ok) return id;
  if (!title.ok) return title;
  if (!defaultWindow.ok) return defaultWindow;

  if (surfaceKind === "tsx") {
    const runtime = normalizeTsxRuntime(field(object.value, "runtime"), `${path}/runtime`);

    if (!runtime.ok) return runtime;

    const app: {
      id: string;
      title: string;
      surfaceKind: "tsx";
      runtime: TsxComponentRef;
      defaultWindow?: AppWindowHints;
    } = {
      id: id.value,
      runtime: runtime.value,
      surfaceKind,
      title: title.value,
    };

    if (defaultWindow.value !== undefined) app.defaultWindow = defaultWindow.value;

    return accept(Object.freeze(app));
  }

  if (surfaceKind === "web") {
    const runtime = normalizeWebRuntime(field(object.value, "runtime"), `${path}/runtime`);

    if (!runtime.ok) return runtime;

    const app: {
      id: string;
      title: string;
      surfaceKind: "web";
      runtime: WebviewRuntimeRef;
      defaultWindow?: AppWindowHints;
    } = {
      id: id.value,
      runtime: runtime.value,
      surfaceKind,
      title: title.value,
    };

    if (defaultWindow.value !== undefined) app.defaultWindow = defaultWindow.value;

    return accept(Object.freeze(app));
  }

  return reject("INVALID_HOST_REQUEST", "app surfaceKind must be tsx or web.", `${path}/surfaceKind`);
}

function normalizeNotificationPostInput(
  input: unknown,
  path: string,
): DesktopUiValidationResult<NotificationPostInput> {
  const object = normalizeHostRequestObject(input, NOTIFICATION_REQUIRED_FIELDS, NOTIFICATION_OPTIONAL_FIELDS, path);

  if (!object.ok) return object;

  const id = normalizePlainString(field(object.value, "id"), `${path}/id`, true);
  const title = normalizePlainString(field(object.value, "title"), `${path}/title`, true);
  const body = normalizeOptionalPlainString(field(object.value, "body"), `${path}/body`, false);
  const priority = normalizeNotificationPriority(field(object.value, "priority"), `${path}/priority`);
  const ttlMs = normalizeOptionalFiniteNumber(field(object.value, "ttlMs"), `${path}/ttlMs`);
  const expiresAtMs = normalizeOptionalFiniteNumber(field(object.value, "expiresAtMs"), `${path}/expiresAtMs`);
  const actions = normalizeNotificationActions(field(object.value, "actions"), `${path}/actions`);

  if (!id.ok) return id;
  if (!title.ok) return title;
  if (!body.ok) return body;
  if (!priority.ok) return priority;
  if (!ttlMs.ok) return ttlMs;
  if (!expiresAtMs.ok) return expiresAtMs;
  if (!actions.ok) return actions;

  const output: {
    id: string;
    title: string;
    actions?: NonNullable<NotificationPostInput["actions"]>;
    body?: string;
    expiresAtMs?: number;
    priority?: NonNullable<NotificationPostInput["priority"]>;
    ttlMs?: number;
  } = {
    id: id.value,
    title: title.value,
  };

  if (actions.value !== undefined) output.actions = actions.value;
  if (body.value !== undefined) output.body = body.value;
  if (expiresAtMs.value !== undefined) output.expiresAtMs = expiresAtMs.value;
  if (priority.value !== undefined) output.priority = priority.value;
  if (ttlMs.value !== undefined) output.ttlMs = ttlMs.value;

  return accept(Object.freeze(output));
}

function normalizeTrayItemInput(input: unknown, path: string): DesktopUiValidationResult<TrayItemInput> {
  const object = normalizeHostRequestObject(input, TRAY_ITEM_REQUIRED_FIELDS, TRAY_ITEM_OPTIONAL_FIELDS, path);

  if (!object.ok) return object;

  const id = normalizePlainString(field(object.value, "id"), `${path}/id`, true);
  const iconRef = normalizePlainString(field(object.value, "iconRef"), `${path}/iconRef`, false);
  const tooltip = normalizePlainString(field(object.value, "tooltip"), `${path}/tooltip`, false);
  const order = normalizeOptionalFiniteNumber(field(object.value, "order"), `${path}/order`);
  const status = normalizeTrayStatus(field(object.value, "status"), `${path}/status`);
  const menu = normalizeTrayMenuItems(field(object.value, "menu"), `${path}/menu`);

  if (!id.ok) return id;
  if (!iconRef.ok) return iconRef;
  if (!tooltip.ok) return tooltip;
  if (!order.ok) return order;
  if (!status.ok) return status;
  if (!menu.ok) return menu;

  const output: {
    id: string;
    iconRef: string;
    tooltip: string;
    menu?: NonNullable<TrayItemInput["menu"]>;
    order?: number;
    status?: NonNullable<TrayItemInput["status"]>;
  } = {
    iconRef: iconRef.value,
    id: id.value,
    tooltip: tooltip.value,
  };

  if (menu.value !== undefined) output.menu = menu.value;
  if (order.value !== undefined) output.order = order.value;
  if (status.value !== undefined) output.status = status.value;

  return accept(Object.freeze(output));
}

function normalizeFilesRequest(input: unknown, path: string): DesktopUiValidationResult<FilesRequest> {
  const object = normalizeHostRequestObject(input, FILE_REQUEST_REQUIRED_FIELDS, FILE_REQUEST_OPTIONAL_FIELDS, path);

  if (!object.ok) return object;

  const grant = normalizePlainString(field(object.value, "grant"), `${path}/grant`, true);
  const op = normalizeFilesOperation(field(object.value, "op"), `${path}/op`);
  const requestPath = normalizePlainString(field(object.value, "path"), `${path}/path`, false);
  const data = normalizeOptionalPlainString(field(object.value, "data"), `${path}/data`, false);

  if (!grant.ok) return grant;
  if (!op.ok) return op;
  if (!requestPath.ok) return requestPath;
  if (!data.ok) return data;

  const output: {
    grant: string;
    op: FilesRequest["op"];
    path: string;
    data?: string;
  } = {
    grant: grant.value,
    op: op.value,
    path: requestPath.value,
  };

  if (data.value !== undefined) output.data = data.value;

  return accept(Object.freeze(output));
}

function normalizeSettingsReadRequest(
  input: unknown,
  path: string,
): DesktopUiValidationResult<DesktopSettingsReadRequest> {
  const object = normalizeHostRequestObject(input, SETTINGS_READ_FIELDS, Object.freeze([]), path);

  if (!object.ok) return object;

  const key = normalizePlainString(field(object.value, "key"), `${path}/key`, true);

  if (!key.ok) return key;

  return accept(Object.freeze({
    key: key.value,
  }));
}

function normalizeSettingsWriteRequest(
  input: unknown,
  path: string,
): DesktopUiValidationResult<DesktopSettingsWriteRequest> {
  const object = normalizeHostRequestObject(input, SETTINGS_WRITE_FIELDS, Object.freeze([]), path);

  if (!object.ok) return object;

  const key = normalizePlainString(field(object.value, "key"), `${path}/key`, true);
  const value = field(object.value, "value");

  if (!key.ok) return key;
  if (value === undefined) {
    return reject("INVALID_HOST_REQUEST", "settings value is required.", `${path}/value`);
  }

  return accept(Object.freeze({
    key: key.value,
    value,
  }));
}

function normalizeLauncherIntent(input: unknown, path: string): DesktopUiValidationResult<DesktopLauncherIntent> {
  const object = normalizeHostRequestObject(input, LAUNCHER_INTENT_REQUIRED_FIELDS, LAUNCHER_INTENT_OPTIONAL_FIELDS, path);

  if (!object.ok) return object;

  const type = normalizeLauncherIntentType(field(object.value, "type"), `${path}/type`);
  const appId = normalizeOptionalPlainString(field(object.value, "appId"), `${path}/appId`, true);
  const query = normalizeOptionalPlainString(field(object.value, "query"), `${path}/query`, false);

  if (!type.ok) return type;
  if (!appId.ok) return appId;
  if (!query.ok) return query;

  const output: {
    type: DesktopLauncherIntent["type"];
    appId?: string;
    query?: string;
  } = {
    type: type.value,
  };

  if (appId.value !== undefined) output.appId = appId.value;
  if (query.value !== undefined) output.query = query.value;

  return accept(Object.freeze(output));
}

function normalizeHostRequestObject(
  input: unknown,
  requiredFields: readonly string[],
  optionalFields: readonly string[],
  path: string,
): DesktopUiValidationResult<PlainJsonObject> {
  const object = normalizePlainObjectInput(input, path);

  if (!object.ok) return object;

  const fields = expectFields(object.value, requiredFields, optionalFields, path);

  if (!fields.ok) return fields;

  return object;
}

function normalizePlainObjectInput(input: unknown, path: string): DesktopUiValidationResult<PlainJsonObject> {
  const normalized = safeNormalize(input);

  if (!normalized.ok) {
    return reject("INVALID_HOST_REQUEST", normalized.reason, path);
  }
  if (!isPlainObject(normalized.value)) {
    return reject("INVALID_HOST_REQUEST", "request must be a plain object.", path);
  }

  return accept(normalized.value);
}

function normalizeShellPlacementInput(input: unknown, path: string): DesktopUiValidationResult<ShellPlacementInput> {
  const object = normalizeHostRequestObject(input, Object.freeze([]), PLACEMENT_FIELDS, path);

  if (!object.ok) return object;

  const zone = normalizeOptionalPlainString(field(object.value, "zone"), `${path}/zone`, true);
  const layer = normalizeOptionalPlainString(field(object.value, "layer"), `${path}/layer`, true);
  const order = normalizeOptionalSafeInteger(field(object.value, "order"), `${path}/order`);
  const anchor = normalizeOptionalPlainString(field(object.value, "anchor"), `${path}/anchor`, true);
  const workspace = normalizeOptionalPlainString(field(object.value, "workspace"), `${path}/workspace`, true);
  const rect = normalizeOptionalRect(field(object.value, "rect"), `${path}/rect`, true);

  if (!zone.ok) return zone;
  if (!layer.ok) return layer;
  if (!order.ok) return order;
  if (!anchor.ok) return anchor;
  if (!workspace.ok) return workspace;
  if (!rect.ok) return rect;

  const output: {
    zone?: string;
    layer?: string;
    order?: number;
    anchor?: string;
    workspace?: string;
    rect?: NonNullable<ShellPlacementInput["rect"]>;
  } = {};

  if (zone.value !== undefined) output.zone = zone.value;
  if (layer.value !== undefined) output.layer = layer.value;
  if (order.value !== undefined) output.order = order.value;
  if (anchor.value !== undefined) output.anchor = anchor.value;
  if (workspace.value !== undefined) output.workspace = workspace.value;
  if (rect.value !== undefined) output.rect = rect.value;

  return accept(Object.freeze(output));
}

function normalizeShellCssDefinition(
  input: unknown,
  path: string,
): DesktopUiValidationResult<ShellCssDefinition | undefined> {
  if (input === undefined) return accept(undefined);
  if (typeof input === "string") return accept(input);

  const object = normalizeHostRequestObject(input, Object.freeze([]), SHELL_CSS_FIELDS, path);

  if (!object.ok) return object;

  const text = normalizeOptionalPlainString(field(object.value, "text"), `${path}/text`, false);
  const rules = normalizeShellCssRules(field(object.value, "rules"), `${path}/rules`);

  if (!text.ok) return text;
  if (!rules.ok) return rules;

  const output: {
    text?: string;
    rules?: readonly {
      readonly selector: string;
      readonly declarations: Readonly<Record<string, string>>;
    }[];
  } = {};

  if (text.value !== undefined) output.text = text.value;
  if (rules.value !== undefined) output.rules = rules.value;

  return accept(Object.freeze(output));
}

function normalizeShellCssRules(
  input: PlainJson | undefined,
  path: string,
): DesktopUiValidationResult<readonly {
  readonly selector: string;
  readonly declarations: Readonly<Record<string, string>>;
}[] | undefined> {
  if (input === undefined) return accept(undefined);
  if (!Array.isArray(input)) {
    return reject("INVALID_HOST_REQUEST", "css rules must be an array.", path);
  }

  const output: {
    readonly selector: string;
    readonly declarations: Readonly<Record<string, string>>;
  }[] = [];

  for (let index = 0; index < input.length; index += 1) {
    const rule = normalizeShellCssRule(input[index], `${path}/${index}`);

    if (!rule.ok) return rule;
    output.push(rule.value);
  }

  return accept(Object.freeze(output));
}

function normalizeShellCssRule(
  input: PlainJson | undefined,
  path: string,
): DesktopUiValidationResult<{
  readonly selector: string;
  readonly declarations: Readonly<Record<string, string>>;
}> {
  if (!isPlainObject(input)) {
    return reject("INVALID_HOST_REQUEST", "css rule must be an object.", path);
  }

  const fields = expectFields(input, SHELL_CSS_RULE_FIELDS, Object.freeze([]), path);

  if (!fields.ok) return fields;

  const selector = normalizePlainString(field(input, "selector"), `${path}/selector`, true);
  const declarations = normalizeStringRecord(field(input, "declarations"), `${path}/declarations`);

  if (!selector.ok) return selector;
  if (!declarations.ok) return declarations;

  return accept(Object.freeze({
    declarations: declarations.value,
    selector: selector.value,
  }));
}

function normalizeStringRecord(
  input: PlainJson | undefined,
  path: string,
): DesktopUiValidationResult<Readonly<Record<string, string>>> {
  if (!isPlainObject(input)) {
    return reject("INVALID_HOST_REQUEST", "value must be an object.", path);
  }

  const output = Object.create(null) as Record<string, string>;
  const keys = Object.keys(input);

  for (let index = 0; index < keys.length; index += 1) {
    const key = keys[index];

    if (key === undefined) continue;

    const value = field(input, key);

    if (typeof value !== "string") {
      return reject("INVALID_HOST_REQUEST", "record values must be strings.", `${path}/${pathToken(key)}`);
    }

    Object.defineProperty(output, key, {
      configurable: true,
      enumerable: true,
      value,
      writable: true,
    });
  }

  return accept(Object.freeze(output));
}

function normalizeTsxRuntime(input: PlainJson | undefined, path: string): DesktopUiValidationResult<TsxComponentRef> {
  const object = normalizeHostRequestObject(input, TSX_RUNTIME_REQUIRED_FIELDS, TSX_RUNTIME_OPTIONAL_FIELDS, path);

  if (!object.ok) return object;

  const componentId = normalizePlainString(field(object.value, "componentId"), `${path}/componentId`, false);
  const props = field(object.value, "props");

  if (!componentId.ok) return componentId;
  if (props !== undefined && !isPlainObject(props)) {
    return reject("INVALID_HOST_REQUEST", "tsx props must be an object.", `${path}/props`);
  }

  const output: {
    componentId: string;
    props?: PlainJsonObject;
  } = {
    componentId: componentId.value,
  };

  if (props !== undefined) output.props = props;

  return accept(Object.freeze(output));
}

function normalizeWebRuntime(input: PlainJson | undefined, path: string): DesktopUiValidationResult<WebviewRuntimeRef> {
  const object = normalizeHostRequestObject(input, WEB_RUNTIME_REQUIRED_FIELDS, WEB_RUNTIME_OPTIONAL_FIELDS, path);

  if (!object.ok) return object;

  const url = normalizePlainString(field(object.value, "url"), `${path}/url`, false);
  const partition = normalizeOptionalPlainString(field(object.value, "partition"), `${path}/partition`, false);

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

function normalizeAppWindowHints(
  input: PlainJson | undefined,
  path: string,
): DesktopUiValidationResult<AppWindowHints | undefined> {
  if (input === undefined) return accept(undefined);

  const object = normalizeHostRequestObject(input, Object.freeze([]), APP_WINDOW_FIELDS, path);

  if (!object.ok) return object;

  const workspaceId = normalizeOptionalPlainString(field(object.value, "workspaceId"), `${path}/workspaceId`, false);
  const mode = normalizeWindowMode(field(object.value, "mode"), `${path}/mode`);
  const zone = normalizeOptionalPlainString(field(object.value, "zone"), `${path}/zone`, false);
  const layer = normalizeOptionalPlainString(field(object.value, "layer"), `${path}/layer`, false);
  const order = normalizeOptionalFiniteNumber(field(object.value, "order"), `${path}/order`);
  const anchor = normalizeOptionalPlainString(field(object.value, "anchor"), `${path}/anchor`, false);
  const className = normalizeOptionalPlainString(field(object.value, "className"), `${path}/className`, false);
  const rect = normalizeOptionalRect(field(object.value, "rect"), `${path}/rect`, false);

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
    rect?: NonNullable<AppWindowHints["rect"]>;
    mode?: NonNullable<AppWindowHints["mode"]>;
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

function normalizeNotificationActions(
  input: PlainJson | undefined,
  path: string,
): DesktopUiValidationResult<NotificationPostInput["actions"] | undefined> {
  if (input === undefined) return accept(undefined);
  if (!Array.isArray(input)) {
    return reject("INVALID_HOST_REQUEST", "notification actions must be an array.", path);
  }

  const output: NonNullable<NotificationPostInput["actions"]>[number][] = [];

  for (let index = 0; index < input.length; index += 1) {
    const action = normalizeNotificationAction(input[index], `${path}/${index}`);

    if (!action.ok) return action;
    output.push(action.value);
  }

  return accept(Object.freeze(output));
}

function normalizeNotificationAction(
  input: PlainJson | undefined,
  path: string,
): DesktopUiValidationResult<NonNullable<NotificationPostInput["actions"]>[number]> {
  if (!isPlainObject(input)) {
    return reject("INVALID_HOST_REQUEST", "notification action must be an object.", path);
  }

  const fields = expectFields(input, NOTIFICATION_ACTION_REQUIRED_FIELDS, NOTIFICATION_ACTION_OPTIONAL_FIELDS, path);

  if (!fields.ok) return fields;

  const id = normalizePlainString(field(input, "id"), `${path}/id`, true);
  const label = normalizePlainString(field(input, "label"), `${path}/label`, true);
  const style = normalizeNotificationActionStyle(field(input, "style"), `${path}/style`);

  if (!id.ok) return id;
  if (!label.ok) return label;
  if (!style.ok) return style;

  const output: {
    id: string;
    label: string;
    style?: NonNullable<NonNullable<NotificationPostInput["actions"]>[number]["style"]>;
  } = {
    id: id.value,
    label: label.value,
  };

  if (style.value !== undefined) output.style = style.value;

  return accept(Object.freeze(output));
}

function normalizeTrayMenuItems(
  input: PlainJson | undefined,
  path: string,
): DesktopUiValidationResult<TrayItemInput["menu"] | undefined> {
  if (input === undefined) return accept(undefined);
  if (!Array.isArray(input)) {
    return reject("INVALID_HOST_REQUEST", "tray menu must be an array.", path);
  }

  const output: NonNullable<TrayItemInput["menu"]>[number][] = [];

  for (let index = 0; index < input.length; index += 1) {
    const item = normalizeTrayMenuItem(input[index], `${path}/${index}`);

    if (!item.ok) return item;
    output.push(item.value);
  }

  return accept(Object.freeze(output));
}

function normalizeTrayMenuItem(
  input: PlainJson | undefined,
  path: string,
): DesktopUiValidationResult<NonNullable<TrayItemInput["menu"]>[number]> {
  if (!isPlainObject(input)) {
    return reject("INVALID_HOST_REQUEST", "tray menu item must be an object.", path);
  }

  const fields = expectFields(input, TRAY_MENU_ITEM_REQUIRED_FIELDS, TRAY_MENU_ITEM_OPTIONAL_FIELDS, path);

  if (!fields.ok) return fields;

  const id = normalizePlainString(field(input, "id"), `${path}/id`, true);
  const label = normalizePlainString(field(input, "label"), `${path}/label`, true);
  const enabled = normalizeOptionalBoolean(field(input, "enabled"), `${path}/enabled`);
  const checked = normalizeOptionalBoolean(field(input, "checked"), `${path}/checked`);
  const items = normalizeTrayMenuItems(field(input, "items"), `${path}/items`);

  if (!id.ok) return id;
  if (!label.ok) return label;
  if (!enabled.ok) return enabled;
  if (!checked.ok) return checked;
  if (!items.ok) return items;

  const output: {
    id: string;
    label: string;
    checked?: boolean;
    enabled?: boolean;
    items?: NonNullable<TrayItemInput["menu"]>;
  } = {
    id: id.value,
    label: label.value,
  };

  if (checked.value !== undefined) output.checked = checked.value;
  if (enabled.value !== undefined) output.enabled = enabled.value;
  if (items.value !== undefined) output.items = items.value;

  return accept(Object.freeze(output));
}

function normalizeOptionalRect(
  input: PlainJson | undefined,
  path: string,
  requirePositiveSize: boolean,
): DesktopUiValidationResult<NonNullable<AppWindowHints["rect"]> | undefined> {
  if (input === undefined) return accept(undefined);
  if (!isPlainObject(input)) {
    return reject("INVALID_HOST_REQUEST", "rect must be an object.", path);
  }

  const fields = expectFields(input, RECT_FIELDS, Object.freeze([]), path);

  if (!fields.ok) return fields;

  const x = normalizeFiniteNumber(field(input, "x"), `${path}/x`);
  const y = normalizeFiniteNumber(field(input, "y"), `${path}/y`);
  const width = normalizeFiniteNumber(field(input, "width"), `${path}/width`);
  const height = normalizeFiniteNumber(field(input, "height"), `${path}/height`);

  if (!x.ok) return x;
  if (!y.ok) return y;
  if (!width.ok) return width;
  if (!height.ok) return height;
  if (requirePositiveSize && width.value <= 0) {
    return reject("INVALID_HOST_REQUEST", "rect width must be positive.", `${path}/width`);
  }
  if (requirePositiveSize && height.value <= 0) {
    return reject("INVALID_HOST_REQUEST", "rect height must be positive.", `${path}/height`);
  }

  return accept(Object.freeze({
    height: height.value,
    width: width.value,
    x: x.value,
    y: y.value,
  }));
}

function normalizePlainString(
  input: PlainJson | undefined,
  path: string,
  nonEmpty: boolean,
): DesktopUiValidationResult<string> {
  if (typeof input !== "string") {
    return reject("INVALID_HOST_REQUEST", "field must be a string.", path);
  }
  if (nonEmpty && input.length === 0) {
    return reject("INVALID_HOST_REQUEST", "field must be a non-empty string.", path);
  }

  return accept(input);
}

function normalizeUnknownString(
  input: unknown,
  path: string,
  nonEmpty: boolean,
): DesktopUiValidationResult<string> {
  if (typeof input !== "string") {
    return reject("INVALID_HOST_REQUEST", "field must be a string.", path);
  }
  if (nonEmpty && input.length === 0) {
    return reject("INVALID_HOST_REQUEST", "field must be a non-empty string.", path);
  }

  return accept(input);
}

function normalizeStringInput(input: unknown, path: string): DesktopUiValidationResult<string> {
  return normalizeUnknownString(input, path, true);
}

function normalizeOptionalPlainString(
  input: PlainJson | undefined,
  path: string,
  nonEmpty: boolean,
): DesktopUiValidationResult<string | undefined> {
  if (input === undefined) return accept(undefined);

  return normalizePlainString(input, path, nonEmpty);
}

function normalizeOptionalUnknownString(
  input: unknown,
  path: string,
  nonEmpty: boolean,
): DesktopUiValidationResult<string | undefined> {
  if (input === undefined) return accept(undefined);

  return normalizeUnknownString(input, path, nonEmpty);
}

function normalizeFiniteNumber(input: PlainJson | undefined, path: string): DesktopUiValidationResult<number> {
  if (typeof input !== "number" || !Number.isFinite(input)) {
    return reject("INVALID_HOST_REQUEST", "field must be a finite number.", path);
  }

  return accept(input);
}

function normalizeOptionalFiniteNumber(
  input: PlainJson | undefined,
  path: string,
): DesktopUiValidationResult<number | undefined> {
  if (input === undefined) return accept(undefined);

  return normalizeFiniteNumber(input, path);
}

function normalizeOptionalSafeInteger(
  input: PlainJson | undefined,
  path: string,
): DesktopUiValidationResult<number | undefined> {
  if (input === undefined) return accept(undefined);
  if (typeof input !== "number" || !Number.isSafeInteger(input)) {
    return reject("INVALID_HOST_REQUEST", "field must be a safe integer.", path);
  }

  return accept(input);
}

function normalizeOptionalBoolean(
  input: PlainJson | undefined,
  path: string,
): DesktopUiValidationResult<boolean | undefined> {
  if (input === undefined) return accept(undefined);
  if (typeof input !== "boolean") {
    return reject("INVALID_HOST_REQUEST", "field must be a boolean.", path);
  }

  return accept(input);
}

function normalizeWindowMode(
  input: PlainJson | undefined,
  path: string,
): DesktopUiValidationResult<NonNullable<AppWindowHints["mode"]> | undefined> {
  if (input === undefined) return accept(undefined);
  if (input === "floating" || input === "tiled") return accept(input);

  return reject("INVALID_HOST_REQUEST", "window mode is not supported.", path);
}

function normalizeNotificationPriority(
  input: PlainJson | undefined,
  path: string,
): DesktopUiValidationResult<NonNullable<NotificationPostInput["priority"]> | undefined> {
  if (input === undefined) return accept(undefined);
  if (input === "critical" || input === "high" || input === "low" || input === "normal" || input === "urgent") {
    return accept(input);
  }

  return reject("INVALID_HOST_REQUEST", "notification priority is not supported.", path);
}

function normalizeNotificationActionStyle(
  input: PlainJson | undefined,
  path: string,
): DesktopUiValidationResult<NonNullable<NonNullable<NotificationPostInput["actions"]>[number]["style"]> | undefined> {
  if (input === undefined) return accept(undefined);
  if (input === "default" || input === "destructive" || input === "primary") return accept(input);

  return reject("INVALID_HOST_REQUEST", "notification action style is not supported.", path);
}

function normalizeTrayStatus(
  input: PlainJson | undefined,
  path: string,
): DesktopUiValidationResult<NonNullable<TrayItemInput["status"]> | undefined> {
  if (input === undefined) return accept(undefined);
  if (input === "critical" || input === "offline" || input === "ok" || input === "warning") return accept(input);

  return reject("INVALID_HOST_REQUEST", "tray status is not supported.", path);
}

function normalizeFilesOperation(
  input: PlainJson | undefined,
  path: string,
): DesktopUiValidationResult<FilesRequest["op"]> {
  if (input === "list" || input === "read" || input === "stat" || input === "write") return accept(input);

  return reject("INVALID_HOST_REQUEST", "file operation is not supported.", path);
}

function normalizeLauncherIntentType(
  input: PlainJson | undefined,
  path: string,
): DesktopUiValidationResult<DesktopLauncherIntent["type"]> {
  if (input === "launcher.close" || input === "launcher.launch" || input === "launcher.open") return accept(input);

  return reject("INVALID_HOST_REQUEST", "launcher intent type is not supported.", path);
}

function isReservedComponentId(id: string): boolean {
  return id.startsWith(RESERVED_COMPONENT_ID_PREFIX);
}

function normalizeSdkCompatibility(
  value: PlainJson | undefined,
  path: string,
): DesktopUiValidationResult<DesktopSdkCompatibility> {
  if (typeof value === "string") {
    const parsed = parseSemver(value);

    if (!parsed.ok) return reject("INVALID_SDK_VERSION", parsed.reason, path);

    return accept(value);
  }
  if (!isPlainObject(value)) {
    return reject("INVALID_SDK_VERSION", "sdkVersion must be a semver string or explicit range.", path);
  }

  const fields = expectFields(value, Object.freeze([]), SDK_RANGE_FIELDS, path);

  if (!fields.ok) return fields;

  const parsed = parseRange(value);

  if (!parsed.ok) return reject("INVALID_SDK_VERSION", parsed.reason, path);

  const output: {
    min?: string;
    minInclusive?: boolean;
    max?: string;
    maxInclusive?: boolean;
  } = {};
  const min = field(value, "min");
  const minInclusive = field(value, "minInclusive");
  const max = field(value, "max");
  const maxInclusive = field(value, "maxInclusive");

  if (typeof min === "string") output.min = min;
  if (typeof minInclusive === "boolean") output.minInclusive = minInclusive;
  if (typeof max === "string") output.max = max;
  if (typeof maxInclusive === "boolean") output.maxInclusive = maxInclusive;

  return accept(Object.freeze(output));
}

function normalizeCapabilityGrants(
  value: PlainJson | undefined,
  path: string,
): DesktopUiValidationResult<readonly DesktopCapabilityGrant[]> {
  if (!Array.isArray(value)) {
    return reject("INVALID_CAPABILITY_GRANTS", "capabilityGrants must be an array.", path);
  }

  const output: DesktopCapabilityGrant[] = [];
  const seen = new Set<string>();

  for (let index = 0; index < value.length; index += 1) {
    const grant = value[index];

    if (!isPlainObject(grant)) {
      return reject("INVALID_CAPABILITY_GRANT", "capability grant must be an object.", `${path}/${index}`);
    }

    const fields = expectFields(
      grant,
      Object.freeze(["capability"]),
      Object.freeze(["resourceId"]),
      `${path}/${index}`,
    );

    if (!fields.ok) return fields;

    const capabilityValue = field(grant, "capability");
    const resourceIdValue = field(grant, "resourceId");

    if (!isDesktopCapability(capabilityValue)) {
      return reject("INVALID_CAPABILITY_GRANT", "capability is not supported.", `${path}/${index}/capability`);
    }
    if (resourceIdValue !== undefined && (typeof resourceIdValue !== "string" || resourceIdValue.length === 0)) {
      return reject("INVALID_CAPABILITY_GRANT", "resourceId must be a non-empty string.", `${path}/${index}/resourceId`);
    }

    const seenKey = `${capabilityValue}\u0000${resourceIdValue ?? "*"}`;

    if (seen.has(seenKey)) {
      return reject("INVALID_CAPABILITY_GRANT", "capability grants must be unique.", `${path}/${index}`);
    }

    seen.add(seenKey);

    const normalized: {
      capability: DesktopCapability;
      resourceId?: string;
    } = {
      capability: capabilityValue,
    };

    if (resourceIdValue !== undefined) normalized.resourceId = resourceIdValue;
    output.push(Object.freeze(normalized));
  }

  return accept(Object.freeze(output));
}

function isSemverCompatible(required: string, current: string): boolean {
  const requiredSemver = parseSemver(required);
  const currentSemver = parseSemver(current);

  if (!requiredSemver.ok || !currentSemver.ok) return false;

  if (!sameCompatibleLine(requiredSemver.value, currentSemver.value)) return false;

  return compareSemver(currentSemver.value, requiredSemver.value) >= 0;
}

function sameCompatibleLine(required: Semver, current: Semver): boolean {
  if (required.major !== current.major) return false;
  if (required.major === 0 && required.minor !== current.minor) return false;

  return true;
}

function callRollback(host: DesktopHost): DesktopUiValidationResult<true> {
  try {
    const rollback = host.rollbackShell();

    if (!rollback.ok) {
      return reject("UI_PACKAGE_ROLLBACK_FAILED", rollback.error.message, rollback.error.path);
    }

    return accept(true);
  } catch (error) {
    return reject("UI_PACKAGE_ROLLBACK_FAILED", loadErrorMessage(error, "UI package rollback failed closed."), "/rollback");
  }
}

function fileCapabilityForRequest(request: FilesRequest): DesktopCapability | null {
  if (request.op === "write") return "files.write";

  for (let index = 0; index < READ_FILE_OPS.length; index += 1) {
    if (READ_FILE_OPS[index] === request.op) return "files.read";
  }

  return null;
}

function expectFields(
  value: PlainJsonObject,
  requiredFields: readonly string[],
  optionalFields: readonly string[],
  path: string,
): DesktopUiValidationResult<true> {
  const keys = Object.keys(value);

  for (let index = 0; index < keys.length; index += 1) {
    const key = keys[index];

    if (key !== undefined && !contains(requiredFields, key) && !contains(optionalFields, key)) {
      return reject("UNEXPECTED_FIELD", "object contains an unsupported field.", `${path}/${pathToken(key)}`);
    }
  }

  for (let index = 0; index < requiredFields.length; index += 1) {
    const key = requiredFields[index];

    if (key !== undefined && !Object.hasOwn(value, key)) {
      return reject("MISSING_FIELD", "object is missing a required field.", `${path}/${key}`);
    }
  }

  return accept(true);
}

function requiredString(
  value: PlainJsonObject,
  key: string,
  path: string,
): DesktopUiValidationResult<string> {
  const current = field(value, key);

  if (typeof current !== "string" || current.length === 0) {
    return reject("INVALID_STRING", "field must be a non-empty string.", path);
  }

  return accept(current);
}

function isDesktopCapability(value: PlainJson | undefined): value is DesktopCapability {
  return (
    value === "apps.launch" ||
    value === "apps.stop" ||
    value === "files.read" ||
    value === "files.write" ||
    value === "launcher.launch" ||
    value === "settings.read" ||
    value === "settings.write" ||
    value === "shell.notifications.post" ||
    value === "shell.tray.register"
  );
}

function hostCurrentMissing(): never {
  throw new Error("currentShell returned undefined");
}

function loadErrorMessage(error: unknown, fallback: string): string {
  if (error instanceof DesktopUiPackageLoadError) return error.message;
  if (error instanceof Error && error.message.length > 0) return error.message;

  return fallback;
}

function field(value: PlainJsonObject, key: string): PlainJson | undefined {
  if (!Object.hasOwn(value, key)) return undefined;

  return value[key];
}

function isPlainObject(value: PlainJson | undefined): value is PlainJsonObject {
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

function accept<T>(value: T): DesktopUiValidationResult<T> {
  return {
    ok: true,
    value,
  };
}

function reject<T>(code: string, message: string, path: string): DesktopUiValidationResult<T> {
  return {
    error: {
      code,
      message,
      path,
    },
    ok: false,
  };
}

function hostRejectFromValidation<T>(error: DesktopUiValidationError): DesktopHostResult<T> {
  return hostReject(error.code, error.message, error.path);
}

function hostReject<T>(code: string, message: string, path: string): DesktopHostResult<T> {
  return {
    error: {
      code,
      message,
      path,
    },
    ok: false,
  };
}

function shellRejectFromValidation<T>(error: DesktopUiValidationError): ShellResult<T> {
  return shellReject(error.code, error.message, error.path);
}

function shellPreviewFailure(error: DesktopUiValidationError): ShellPreviewResult {
  return {
    diff: emptyShellLayoutDiff(),
    error,
    fallbackLayout: composeKnownGoodFallbackShell(),
    ok: false,
  };
}

function shellApplyFailure(error: DesktopUiValidationError): ShellApplyResult {
  const fallbackLayout = composeKnownGoodFallbackShell();

  return {
    error,
    fallbackLayout,
    layout: fallbackLayout,
    ok: false,
    outcome: "failsafe",
    status: "FAILSAFE",
  };
}

function emptyShellLayoutDiff(): ShellLayoutDiff {
  return Object.freeze({
    added: Object.freeze([]),
    changed: Object.freeze([]),
    removed: Object.freeze([]),
  });
}

function shellReject<T>(code: string, message: string, path: string): ShellResult<T> {
  return {
    error: {
      code,
      message,
      path,
    },
    ok: false,
  };
}

function filesRejectFromValidation(error: DesktopUiValidationError): FilesErrorResponse {
  return Object.freeze({
    error: Object.freeze({
      code: error.code,
      message: error.message,
    }),
  });
}

function filesRejectCapabilityDenied(error: DesktopUiValidationError): FilesErrorResponse {
  return Object.freeze({
    error: Object.freeze({
      code: CAPABILITY_DENIED_CODE,
      message: error.message,
    }),
  });
}
