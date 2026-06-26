import type {
  RegisteredShellComponent,
  ShellApplyResult,
  ShellComponentDefinition,
  ShellConfigDefinition,
  ShellManagedSnapshot,
  ShellPreviewResult,
  ShellResult,
  ShellRollbackResult,
} from "../shell/index.ts";
import type {
  NotificationPostInput,
  ShellNotification,
  TrayItem,
  TrayItemInput,
} from "../shell/notifications/index.ts";
import type { FilesErrorResponse, FilesRequest, FilesResponse } from "../files-grant.ts";
import type { SemverRange } from "../semver-range.ts";
import { safeNormalize } from "../safe-normalize.ts";
import type { PlainJson, PlainJsonObject } from "../safe-normalize.ts";
import type { TsxAppDescriptor, WebAppDescriptor } from "../appshell/index.ts";
import type { WindowId, WindowManagerIntent } from "../wm/policy.ts";

export type DesktopMaybePromise<T> = T | Promise<T>;

export type DesktopCapability =
  | "apps.launch"
  | "apps.stop"
  | "files.read"
  | "files.write"
  | "launcher.launch"
  | "settings.read"
  | "settings.write"
  | "shell.notifications.post"
  | "shell.tray.register";

export interface DesktopCapabilityGrant {
  readonly capability: DesktopCapability;
  readonly resourceId?: string;
}

export type DesktopSdkCompatibility = string | SemverRange;

export interface DesktopUiPackageManifest {
  readonly id: string;
  readonly version: string;
  readonly sdkVersion: DesktopSdkCompatibility;
  readonly entry: string;
  readonly capabilityGrants: readonly DesktopCapabilityGrant[];
}

export type DesktopLaunchableApp = TsxAppDescriptor | WebAppDescriptor;

export interface DesktopAppLaunch {
  readonly app: DesktopLaunchableApp;
  readonly surfaceId: string;
  readonly windowId: string;
  readonly textureId: string;
  readonly intents: readonly WindowManagerIntent[];
}

export interface DesktopAppStop {
  readonly appId: string;
  readonly surfaceId?: string;
  readonly windowId?: WindowId;
  readonly textureId?: string;
  readonly intents: readonly WindowManagerIntent[];
}

export type DesktopHostResult<T> =
  | {
      readonly ok: true;
      readonly value: T;
    }
  | {
      readonly ok: false;
      readonly error: DesktopHostError;
    };

export interface DesktopHostError {
  readonly code: string;
  readonly message: string;
  readonly path: string;
}

export interface DesktopThemeTokens {
  readonly colors: Readonly<Record<string, string>>;
  readonly spacing: Readonly<Record<string, number>>;
  readonly radii: Readonly<Record<string, number>>;
  readonly typography: Readonly<Record<string, string | number>>;
}

export interface DesktopTheme {
  readonly id: string;
  readonly version: string;
  readonly tokens: DesktopThemeTokens;
}

export interface DesktopSettingsReadRequest {
  readonly key: string;
}

export interface DesktopSettingsWriteRequest {
  readonly key: string;
  readonly value: PlainJson;
}

export interface DesktopSettingsPreview {
  readonly revision: string;
  readonly diff: PlainJsonObject;
}

export interface DesktopSettingsApply {
  readonly revision: string;
  readonly applied: PlainJsonObject;
}

export interface DesktopLauncherIntent {
  readonly type: "launcher.open" | "launcher.close" | "launcher.launch";
  readonly appId?: string;
  readonly query?: string;
}

export interface DesktopHost {
  readonly package: DesktopUiPackageManifest;
  registerComponent(definition: ShellComponentDefinition): ShellResult<RegisteredShellComponent>;
  previewShell(definition: ShellConfigDefinition): ShellPreviewResult;
  applyShell(definition: ShellConfigDefinition): ShellApplyResult;
  rollbackShell(): ShellRollbackResult;
  currentShell?(): ShellManagedSnapshot;
  launchApp(app: DesktopLaunchableApp): DesktopMaybePromise<DesktopHostResult<DesktopAppLaunch>>;
  stopApp(appId: string): DesktopMaybePromise<DesktopHostResult<DesktopAppStop>>;
  postNotification(input: NotificationPostInput): ShellResult<ShellNotification>;
  registerTrayItem(input: TrayItemInput): ShellResult<TrayItem>;
  requestFile?(request: FilesRequest): DesktopMaybePromise<FilesResponse | FilesErrorResponse>;
  readSetting?(request: DesktopSettingsReadRequest): DesktopMaybePromise<DesktopHostResult<PlainJson>>;
  previewSetting?(request: DesktopSettingsWriteRequest): DesktopMaybePromise<DesktopHostResult<DesktopSettingsPreview>>;
  applySetting?(request: DesktopSettingsWriteRequest): DesktopMaybePromise<DesktopHostResult<DesktopSettingsApply>>;
  emitLauncherIntent?(intent: DesktopLauncherIntent): DesktopMaybePromise<DesktopHostResult<true>>;
  readTheme(): DesktopTheme;
}

export interface DesktopUiInstance {
  readonly packageId?: string;
  unmount(): DesktopMaybePromise<void>;
}

export interface DesktopUiPackage {
  readonly manifest: DesktopUiPackageManifest;
  mount(host: DesktopHost): DesktopMaybePromise<DesktopUiInstance>;
}

export function isDesktopAppLaunch(value: unknown): value is DesktopAppLaunch {
  const normalized = safeNormalize(value);

  if (!normalized.ok) return false;

  const launch = jsonObject(normalized.value);

  return launch !== undefined &&
    isDesktopLaunchableApp(launch["app"]) &&
    typeof launch["surfaceId"] === "string" &&
    typeof launch["windowId"] === "string" &&
    typeof launch["textureId"] === "string" &&
    isWindowManagerIntentArray(launch["intents"]);
}

export function isDesktopAppStop(value: unknown): value is DesktopAppStop {
  const normalized = safeNormalize(value);

  if (!normalized.ok) return false;

  const stop = jsonObject(normalized.value);

  return stop !== undefined &&
    typeof stop["appId"] === "string" &&
    optionalString(stop["surfaceId"]) &&
    optionalString(stop["windowId"]) &&
    optionalString(stop["textureId"]) &&
    isWindowManagerIntentArray(stop["intents"]);
}

export function isDesktopLaunchableApp(value: unknown): value is DesktopLaunchableApp {
  const normalized = safeNormalize(value);

  if (!normalized.ok) return false;

  return isNormalizedDesktopLaunchableApp(normalized.value);
}

function isNormalizedDesktopLaunchableApp(value: PlainJson | undefined): boolean {
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

function isWindowHintsOrAbsent(value: PlainJson | undefined): boolean {
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

function isRect(value: PlainJson | undefined): boolean {
  const rect = jsonObject(value);

  return rect !== undefined &&
    isFiniteNumber(rect["x"]) &&
    isFiniteNumber(rect["y"]) &&
    isFiniteNumber(rect["width"]) &&
    isFiniteNumber(rect["height"]);
}

function isWindowManagerIntentArray(value: PlainJson | undefined): boolean {
  if (!Array.isArray(value)) return false;

  for (let index = 0; index < value.length; index += 1) {
    const intent = jsonObject(value[index]);

    if (intent === undefined || typeof intent["type"] !== "string") return false;
  }

  return true;
}

function jsonObject(value: PlainJson | undefined): PlainJsonObject | undefined {
  if (!isPlainJsonObject(value)) return undefined;

  return value;
}

function isPlainJsonObject(value: PlainJson | undefined): value is PlainJsonObject {
  return value !== undefined && value !== null && typeof value === "object" && !Array.isArray(value);
}

function optionalString(value: PlainJson | undefined): boolean {
  return value === undefined || typeof value === "string";
}

function isFiniteNumber(value: PlainJson | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value);
}
