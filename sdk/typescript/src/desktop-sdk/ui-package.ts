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
import type { PlainJson, PlainJsonObject } from "../safe-normalize.ts";
import type { TsxAppDescriptor, WebAppDescriptor } from "../appshell/index.ts";
import type { WindowId, WindowManagerIntent } from "../wm/policy.ts";

export type DesktopMaybePromise<T> = T | Promise<T>;

export type DesktopCapability =
  | "apps.launch"
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
