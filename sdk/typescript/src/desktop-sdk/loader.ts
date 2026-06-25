import { types as nodeTypes } from "node:util";

import {
  knownGoodFallbackShellConfig,
} from "../shell/index.ts";
import type {
  RegisteredShellComponent,
  ShellComponentDefinition,
  ShellConfigDefinition,
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
const INSTANCE_FIELDS = Object.freeze(["packageId", "unmount"]);
const MANIFEST_FIELDS = Object.freeze(["capabilityGrants", "entry", "id", "sdkVersion", "version"]);
const GRANT_FIELDS = Object.freeze(["capability", "resourceId"]);
const SDK_RANGE_FIELDS = Object.freeze(["max", "maxInclusive", "min", "minInclusive"]);
const READ_FILE_OPS = Object.freeze(["list", "read", "stat"]);

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

    const fallback = await mountSnapshot(fallbackSnapshot.value, this.#host, "fallback");

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
): DesktopHost {
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
      return host.applyShell(definition);
    },
    launchApp(app) {
      if (!hasDesktopCapabilityGrant(manifest, "apps.launch", app.id)) {
        return hostReject("MISSING_CAPABILITY", "package cannot launch this app.", "/capabilityGrants/apps.launch");
      }

      return host.launchApp(app);
    },
    package: manifest,
    postNotification(input) {
      if (!hasDesktopCapabilityGrant(manifest, "shell.notifications.post", input.id)) {
        return shellReject(
          "MISSING_CAPABILITY",
          "package cannot post this notification.",
          "/capabilityGrants/shell.notifications.post",
        );
      }

      return host.postNotification(input);
    },
    previewShell(definition) {
      return host.previewShell(definition);
    },
    readTheme() {
      return host.readTheme();
    },
    registerComponent(definition) {
      return host.registerComponent(definition);
    },
    registerTrayItem(input) {
      if (!hasDesktopCapabilityGrant(manifest, "shell.tray.register", input.id)) {
        return shellReject(
          "MISSING_CAPABILITY",
          "package cannot register this tray item.",
          "/capabilityGrants/shell.tray.register",
        );
      }

      return host.registerTrayItem(input);
    },
    rollbackShell() {
      return host.rollbackShell();
    },
    stopApp(appId) {
      return host.stopApp(appId);
    },
  };

  if (host.currentShell !== undefined) {
    scoped.currentShell = () => host.currentShell?.() ?? hostCurrentMissing();
  }
  if (host.requestFile !== undefined) {
    scoped.requestFile = (request) => {
      const capability = fileCapabilityForRequest(request);

      if (capability === null || !hasDesktopCapabilityGrant(manifest, capability, request.grant)) {
        return Object.freeze({
          error: Object.freeze({
            code: "MISSING_CAPABILITY",
            message: "package cannot use this file grant.",
          }),
        });
      }

      return host.requestFile?.(request) ?? Object.freeze({
        error: Object.freeze({
          code: "FILES_PORT_UNAVAILABLE",
          message: "files port is unavailable.",
        }),
      });
    };
  }
  if (host.readSetting !== undefined) {
    scoped.readSetting = (request) => {
      if (!hasDesktopCapabilityGrant(manifest, "settings.read", request.key)) {
        return hostReject("MISSING_CAPABILITY", "package cannot read this setting.", "/capabilityGrants/settings.read");
      }

      return host.readSetting?.(request) ?? hostReject("SETTINGS_PORT_UNAVAILABLE", "settings port is unavailable.", "/settings");
    };
  }
  if (host.previewSetting !== undefined) {
    scoped.previewSetting = (request) => {
      if (!hasDesktopCapabilityGrant(manifest, "settings.write", request.key)) {
        return hostReject("MISSING_CAPABILITY", "package cannot preview this setting.", "/capabilityGrants/settings.write");
      }

      return host.previewSetting?.(request) ?? hostReject("SETTINGS_PORT_UNAVAILABLE", "settings port is unavailable.", "/settings");
    };
  }
  if (host.applySetting !== undefined) {
    scoped.applySetting = (request) => {
      if (!hasDesktopCapabilityGrant(manifest, "settings.write", request.key)) {
        return hostReject("MISSING_CAPABILITY", "package cannot apply this setting.", "/capabilityGrants/settings.write");
      }

      return host.applySetting?.(request) ?? hostReject("SETTINGS_PORT_UNAVAILABLE", "settings port is unavailable.", "/settings");
    };
  }
  if (host.emitLauncherIntent !== undefined) {
    scoped.emitLauncherIntent = (intent) => {
      if (!hasDesktopCapabilityGrant(manifest, "launcher.launch", intent.appId)) {
        return hostReject(
          "MISSING_CAPABILITY",
          "package cannot emit this launcher intent.",
          "/capabilityGrants/launcher.launch",
        );
      }

      return host.emitLauncherIntent?.(intent) ?? hostReject("LAUNCHER_PORT_UNAVAILABLE", "launcher port is unavailable.", "/launcher");
    };
  }

  return Object.freeze(scoped);
}

function snapshotDesktopUiPackage(input: unknown, currentSdkVersion: string): DesktopUiValidationResult<SnapshotUiPackage> {
  const object = snapshotCallableObject(input, PACKAGE_FIELDS, "/package");

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
  const object = snapshotCallableObject(input, INSTANCE_FIELDS, path);

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
): Promise<DesktopUiValidationResult<DesktopUiLoadedPackage>> {
  let rawInstance: unknown;

  try {
    rawInstance = await snapshot.mount(createDesktopHostForPackage(host, snapshot.manifest));
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
  allowedFields: readonly string[],
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
      if (!contains(allowedFields, key)) {
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

    for (let index = 0; index < allowedFields.length; index += 1) {
      const key = allowedFields[index];

      if (key !== undefined && key !== "packageId" && !Object.hasOwn(output, key)) {
        return reject("MISSING_FIELD", "value is missing a required field.", `${path}/${key}`);
      }
    }

    return accept(Object.freeze(output));
  } catch {
    return reject("INVALID_OBJECT", "value must be a plain object.", path);
  }
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
