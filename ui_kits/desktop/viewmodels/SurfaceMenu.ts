import {
  createSettingsAppState,
  hasDesktopCapabilityGrant,
  joinCapabilityPath,
  requestSettingsApply,
  requestSettingsPreview,
  settleSettingsControlPlaneResult,
} from "../../../sdk/typescript/src/desktop-sdk/index.ts";
import type {
  AppError,
  DesktopHost,
  DesktopHostError,
  DesktopHostResult,
  DesktopLauncherIntent,
  DesktopUiPackageManifest,
  FilesEntry,
  FilesErrorResponse,
  FilesRequest,
  FilesResponse,
  SettingsAppState,
  SettingsApplyIntent,
  SettingsControlPlaneAccepted,
  SettingsControlPlaneIntent,
  SettingsControlPlanePort,
  SettingsEdit,
  SettingsManagedConfig,
  SettingsPreviewIntent,
  SettingsValue,
} from "../../../sdk/typescript/src/desktop-sdk/index.ts";

export type SurfaceMenuSortBy = "name" | "kind" | "modified";
export type SurfaceMenuItemRole = "menuitem" | "menuitemcheckbox" | "submenu";
export type SurfaceMenuDenyReason = "forbidden" | "invalid" | "error";

export interface SurfaceContextMenu {
  readonly sections: readonly SurfaceContextMenuSection[];
}

export interface SurfaceContextMenuSection {
  readonly id: string;
  readonly items: readonly SurfaceContextMenuEntry[];
}

export type SurfaceContextMenuEntry = SurfaceContextMenuItem | SurfaceContextMenuSeparator;

export interface SurfaceContextMenuItem {
  readonly kind: "item";
  readonly id: string;
  readonly label: string;
  readonly role: SurfaceMenuItemRole;
  readonly disabled: boolean;
  readonly icon?: string;
  readonly checked?: boolean;
  readonly submenu?: SurfaceContextMenu;
}

export interface SurfaceContextMenuSeparator {
  readonly kind: "separator";
  readonly id: string;
  readonly role: "separator";
}

export type SurfaceMenuFilesRequest =
  | FilesRequest
  | {
      readonly op: "mkdir";
      readonly grant: string;
      readonly path: string;
    }
  | {
      readonly op: "paste";
      readonly grant: string;
      readonly path: string;
      readonly data: string;
    };

export interface SurfaceMenuFilesPort {
  request(
    request: SurfaceMenuFilesRequest,
  ): FilesResponse | FilesErrorResponse | Promise<FilesResponse | FilesErrorResponse>;
}

export interface SurfaceMenuClipboardPayload {
  readonly mode: "copy" | "cut";
  readonly paths: readonly string[];
}

export interface SurfaceMenuSurfaceInput {
  readonly desktopPath?: string;
  readonly wallpaper?: string;
  readonly sortBy?: SurfaceMenuSortBy;
  readonly showDesktopIcons?: boolean;
}

export interface SurfaceMenuSurfaceState {
  readonly desktopPath: string;
  readonly wallpaper: string;
  readonly sortBy: SurfaceMenuSortBy;
  readonly showDesktopIcons: boolean;
}

export interface SurfaceMenuResolveOptions {
  readonly folderName?: string;
  readonly wallpaper?: string;
  readonly sortBy?: SurfaceMenuSortBy;
  readonly showDesktopIcons?: boolean;
  readonly value?: SettingsValue;
}

export interface SurfaceMenuViewModelInput {
  readonly package: DesktopUiPackageManifest;
  readonly files?: SurfaceMenuFilesPort;
  readonly filesGrant?: string;
  readonly settings?: SettingsControlPlanePort;
  readonly settingsState?: SettingsAppState;
  readonly emitLauncherIntent?: DesktopHost["emitLauncherIntent"];
  readonly clipboard?: SurfaceMenuClipboardPayload;
  readonly surface?: SurfaceMenuSurfaceInput;
}

export interface SurfaceMenuSnapshot {
  readonly menu: SurfaceContextMenu;
  readonly state: SurfaceMenuSurfaceState;
}

export interface SurfaceMenuError {
  readonly code: string;
  readonly message: string;
  readonly path: string;
}

export type SurfaceMenuFileActionId =
  | typeof SURFACE_MENU_ITEM_IDS.newFolder
  | typeof SURFACE_MENU_ITEM_IDS.paste;

export type SurfaceMenuSettingsActionId =
  | typeof SURFACE_MENU_ITEM_IDS.changeWallpaper
  | typeof SURFACE_MENU_ITEM_IDS.sortBy
  | typeof SURFACE_MENU_ITEM_IDS.sortByName
  | typeof SURFACE_MENU_ITEM_IDS.sortByKind
  | typeof SURFACE_MENU_ITEM_IDS.sortByModified
  | typeof SURFACE_MENU_ITEM_IDS.showDesktopIcons;

export type SurfaceMenuLauncherActionId = typeof SURFACE_MENU_ITEM_IDS.displaySettings;
export type SurfaceMenuLocalActionId = typeof SURFACE_MENU_ITEM_IDS.refresh;
export type SurfaceMenuActionId =
  | SurfaceMenuFileActionId
  | SurfaceMenuSettingsActionId
  | SurfaceMenuLauncherActionId
  | SurfaceMenuLocalActionId;

export type SurfaceMenuResolveResult =
  | SurfaceMenuFilesResult
  | SurfaceMenuSettingsResult
  | SurfaceMenuLauncherResult
  | SurfaceMenuRefreshResult
  | SurfaceMenuDeniedResult;

export interface SurfaceMenuFilesResult {
  readonly ok: true;
  readonly dispatch: "files";
  readonly verb: SurfaceMenuFileActionId;
  readonly request: SurfaceMenuFilesRequest;
  readonly response: FilesResponse;
  readonly state: SurfaceMenuSurfaceState;
}

export interface SurfaceMenuSettingsResult {
  readonly ok: true;
  readonly dispatch: "settings";
  readonly verb: SurfaceMenuSettingsActionId;
  readonly previewIntent: SettingsPreviewIntent;
  readonly previewResult: SettingsControlPlaneAccepted;
  readonly applyIntent: SettingsApplyIntent;
  readonly applyResult: SettingsControlPlaneAccepted;
  readonly state: SurfaceMenuSurfaceState;
}

export interface SurfaceMenuLauncherResult {
  readonly ok: true;
  readonly dispatch: "launcherIntent";
  readonly verb: SurfaceMenuLauncherActionId;
  readonly intent: DesktopLauncherIntent;
  readonly value: true;
  readonly state: SurfaceMenuSurfaceState;
}

export interface SurfaceMenuRefreshResult {
  readonly ok: true;
  readonly dispatch: "local";
  readonly verb: SurfaceMenuLocalActionId;
  readonly state: SurfaceMenuSurfaceState;
  readonly value: SurfaceMenuSurfaceState;
}

export interface SurfaceMenuDeniedResult {
  readonly ok: false;
  readonly reason: SurfaceMenuDenyReason;
  readonly error: SurfaceMenuError;
  readonly state: SurfaceMenuSurfaceState;
  readonly verb?: string;
}

export interface SurfaceMenuViewModel {
  readonly state: SurfaceMenuSurfaceState;
  snapshot(): SurfaceMenuSnapshot;
  menu(): SurfaceContextMenu;
  resolve(verb: string, options?: SurfaceMenuResolveOptions): Promise<SurfaceMenuResolveResult>;
}

export interface SurfaceMenuCapabilities {
  readonly filesWrite: boolean;
  readonly wallpaperWrite: boolean;
  readonly sortWrite: boolean;
  readonly iconVisibilityWrite: boolean;
  readonly displaySettings: boolean;
}

type SurfaceSettingsPatch =
  | {
      readonly wallpaper: string;
    }
  | {
      readonly sortBy: SurfaceMenuSortBy;
    }
  | {
      readonly showDesktopIcons: boolean;
    };

type NormalizeOptionsResult =
  | {
      readonly ok: true;
      readonly value: ReadonlyMap<string, unknown>;
    }
  | {
      readonly ok: false;
      readonly error: SurfaceMenuError;
    };

export const SURFACE_MENU_ITEM_IDS = Object.freeze({
  changeWallpaper: "surface.changeWallpaper",
  displaySettings: "surface.displaySettings",
  newFolder: "surface.newFolder",
  paste: "surface.paste",
  refresh: "surface.refresh",
  showDesktopIcons: "surface.showDesktopIcons",
  sortBy: "surface.sortBy",
  sortByKind: "surface.sortBy.kind",
  sortByModified: "surface.sortBy.modified",
  sortByName: "surface.sortBy.name",
} as const);

export const SURFACE_SETTINGS_CATEGORY_ID = "desktop";
export const SURFACE_SETTINGS_SETTING_IDS = Object.freeze({
  showDesktopIcons: "showDesktopIcons",
  sortBy: "sortBy",
  wallpaper: "wallpaper",
} as const);
export const SURFACE_SETTINGS_RESOURCE_IDS = Object.freeze({
  showDesktopIcons: "desktop.showDesktopIcons",
  sortBy: "desktop.sortBy",
  wallpaper: "desktop.wallpaper",
} as const);

export const SURFACE_DISPLAY_SETTINGS_INTENT: DesktopLauncherIntent = Object.freeze({
  appId: "vita.app.settings",
  query: "display-settings",
  type: "launcher.launch",
});

const DEFAULT_DESKTOP_PATH = "/Desktop";
const DEFAULT_FILES_GRANT = "desktop";
const DEFAULT_FOLDER_NAME = "New Folder";
const DEFAULT_WALLPAPER = "default";
const SORT_OPTIONS = Object.freeze([
  Object.freeze({ id: SURFACE_MENU_ITEM_IDS.sortByName, label: "Name", value: "name" }),
  Object.freeze({ id: SURFACE_MENU_ITEM_IDS.sortByKind, label: "Kind", value: "kind" }),
  Object.freeze({ id: SURFACE_MENU_ITEM_IDS.sortByModified, label: "Modified", value: "modified" }),
] as const);
const RESOLVE_OPTION_KEYS = Object.freeze([
  "folderName",
  "showDesktopIcons",
  "sortBy",
  "value",
  "wallpaper",
]);

export function createSurfaceMenuViewModel(input: SurfaceMenuViewModelInput): SurfaceMenuViewModel {
  return new DesktopSurfaceMenuViewModel(input);
}

export function buildSurfaceMenu(input: {
  readonly capabilities: SurfaceMenuCapabilities;
  readonly clipboard?: SurfaceMenuClipboardPayload;
  readonly state: SurfaceMenuSurfaceState;
}): SurfaceContextMenu {
  const systemItems: SurfaceContextMenuEntry[] = [
    menuItem({
      disabled: !input.capabilities.filesWrite,
      icon: "folder-plus",
      id: SURFACE_MENU_ITEM_IDS.newFolder,
      label: "New Folder",
    }),
  ];

  if (clipboardHasPayload(input.clipboard)) {
    systemItems.push(menuItem({
      disabled: !input.capabilities.filesWrite,
      icon: "clipboard",
      id: SURFACE_MENU_ITEM_IDS.paste,
      label: "Paste",
    }));
  }

  systemItems.push(separator("surface.files.separator"));
  systemItems.push(menuItem({
    disabled: !input.capabilities.wallpaperWrite,
    icon: "image",
    id: SURFACE_MENU_ITEM_IDS.changeWallpaper,
    label: "Change Wallpaper…",
  }));
  systemItems.push(sortByItem(input.state.sortBy, !input.capabilities.sortWrite));
  systemItems.push(menuItem({
    checked: input.state.showDesktopIcons,
    disabled: !input.capabilities.iconVisibilityWrite,
    icon: "monitor-dot",
    id: SURFACE_MENU_ITEM_IDS.showDesktopIcons,
    label: "Show desktop icons",
    role: "menuitemcheckbox",
  }));
  systemItems.push(separator("surface.settings.separator"));
  systemItems.push(menuItem({
    disabled: !input.capabilities.displaySettings,
    icon: "monitor-cog",
    id: SURFACE_MENU_ITEM_IDS.displaySettings,
    label: "Display Settings",
  }));
  systemItems.push(menuItem({
    disabled: false,
    icon: "refresh-cw",
    id: SURFACE_MENU_ITEM_IDS.refresh,
    label: "Refresh",
  }));

  return freezeMenu({
    sections: Object.freeze([
      freezeSection({
        id: "surface",
        items: Object.freeze(systemItems),
      }),
    ]),
  });
}

class DesktopSurfaceMenuViewModel implements SurfaceMenuViewModel {
  readonly #files: SurfaceMenuFilesPort | undefined;
  readonly #filesGrant: string;
  readonly #package: DesktopUiPackageManifest;
  readonly #settings: SettingsControlPlanePort | undefined;
  readonly #emitLauncherIntent: DesktopHost["emitLauncherIntent"] | undefined;
  #clipboard: SurfaceMenuClipboardPayload | undefined;
  #settingsState: SettingsAppState;
  #state: SurfaceMenuSurfaceState;

  constructor(input: SurfaceMenuViewModelInput) {
    const derived = deriveSurfaceState(input.surface, input.settingsState);

    this.#files = input.files;
    this.#filesGrant = input.filesGrant ?? DEFAULT_FILES_GRANT;
    this.#package = input.package;
    this.#settings = input.settings;
    this.#emitLauncherIntent = input.emitLauncherIntent;
    this.#clipboard = normalizeClipboard(input.clipboard);
    this.#state = freezeSurfaceState(derived);
    this.#settingsState = input.settingsState ?? createSettingsAppState(surfaceSettingsConfig(this.#state));
  }

  get state(): SurfaceMenuSurfaceState {
    return this.#state;
  }

  snapshot(): SurfaceMenuSnapshot {
    return Object.freeze({
      menu: this.menu(),
      state: this.#state,
    });
  }

  menu(): SurfaceContextMenu {
    const input: {
      capabilities: SurfaceMenuCapabilities;
      state: SurfaceMenuSurfaceState;
      clipboard?: SurfaceMenuClipboardPayload;
    } = {
      capabilities: this.#capabilities(),
      state: this.#state,
    };

    if (this.#clipboard !== undefined) input.clipboard = this.#clipboard;

    return buildSurfaceMenu(input);
  }

  async resolve(verb: string, options?: SurfaceMenuResolveOptions): Promise<SurfaceMenuResolveResult> {
    const action = normalizeSurfaceMenuActionId(verb);

    if (action === null) {
      return deny("invalid", "UNKNOWN_SURFACE_MENU_ACTION", "surface menu action is not registered.", "/verb", this.#state, verb);
    }

    const normalizedOptions = snapshotOptions(options);

    if (!normalizedOptions.ok) {
      return denyFromError("invalid", normalizedOptions.error, this.#state, action);
    }

    switch (action) {
      case SURFACE_MENU_ITEM_IDS.newFolder:
        return await this.#newFolder(action, normalizedOptions.value);
      case SURFACE_MENU_ITEM_IDS.paste:
        return await this.#paste(action);
      case SURFACE_MENU_ITEM_IDS.changeWallpaper:
        return await this.#changeWallpaper(action, normalizedOptions.value);
      case SURFACE_MENU_ITEM_IDS.sortBy:
      case SURFACE_MENU_ITEM_IDS.sortByName:
      case SURFACE_MENU_ITEM_IDS.sortByKind:
      case SURFACE_MENU_ITEM_IDS.sortByModified:
        return await this.#sortBy(action, normalizedOptions.value);
      case SURFACE_MENU_ITEM_IDS.showDesktopIcons:
        return await this.#showDesktopIcons(action, normalizedOptions.value);
      case SURFACE_MENU_ITEM_IDS.displaySettings:
        return await this.#displaySettings(action);
      case SURFACE_MENU_ITEM_IDS.refresh:
        return refreshResult(this.#state);
      default:
        return deny("invalid", "UNKNOWN_SURFACE_MENU_ACTION", "surface menu action is not registered.", "/verb", this.#state, action);
    }
  }

  async #newFolder(
    action: typeof SURFACE_MENU_ITEM_IDS.newFolder,
    options: ReadonlyMap<string, unknown>,
  ): Promise<SurfaceMenuResolveResult> {
    const port = this.#requireFiles(action);

    if (port === undefined) return forbidden(action, this.#state, "/files");

    const name = stringOption(options, "folderName", DEFAULT_FOLDER_NAME);

    if (!name.ok) return denyFromError("invalid", name.error, this.#state, action);
    if (!isValidEntryName(name.value)) {
      return deny("invalid", "INVALID_FOLDER_NAME", "new folder name must not contain path separators.", "/folderName", this.#state, action);
    }

    const request = freezeSurfaceFilesRequest({
      grant: this.#filesGrant,
      op: "mkdir",
      path: joinCapabilityPath(this.#state.desktopPath, name.value),
    });

    return await this.#callFiles(action, request, port);
  }

  async #paste(action: typeof SURFACE_MENU_ITEM_IDS.paste): Promise<SurfaceMenuResolveResult> {
    const port = this.#requireFiles(action);

    if (port === undefined) return forbidden(action, this.#state, "/files");
    if (!clipboardHasPayload(this.#clipboard)) {
      return forbidden(action, this.#state, "/clipboard");
    }

    const request = freezeSurfaceFilesRequest({
      data: JSON.stringify({
        mode: this.#clipboard.mode,
        paths: this.#clipboard.paths,
      }),
      grant: this.#filesGrant,
      op: "paste",
      path: this.#state.desktopPath,
    });

    return await this.#callFiles(action, request, port);
  }

  async #changeWallpaper(
    action: typeof SURFACE_MENU_ITEM_IDS.changeWallpaper,
    options: ReadonlyMap<string, unknown>,
  ): Promise<SurfaceMenuResolveResult> {
    const nextWallpaper = stringOption(options, "wallpaper", valueStringOption(options, this.#state.wallpaper));

    if (!nextWallpaper.ok) return denyFromError("invalid", nextWallpaper.error, this.#state, action);

    return await this.#applySettingsEdit(
      action,
      {
        categoryId: SURFACE_SETTINGS_CATEGORY_ID,
        settingId: SURFACE_SETTINGS_SETTING_IDS.wallpaper,
        value: nextWallpaper.value,
      },
      {
        wallpaper: nextWallpaper.value,
      },
      SURFACE_SETTINGS_RESOURCE_IDS.wallpaper,
    );
  }

  async #sortBy(
    action: SurfaceMenuSettingsActionId,
    options: ReadonlyMap<string, unknown>,
  ): Promise<SurfaceMenuResolveResult> {
    const optionSort = sortValueForAction(action, options);

    if (!optionSort.ok) return denyFromError("invalid", optionSort.error, this.#state, action);

    return await this.#applySettingsEdit(
      action,
      {
        categoryId: SURFACE_SETTINGS_CATEGORY_ID,
        settingId: SURFACE_SETTINGS_SETTING_IDS.sortBy,
        value: optionSort.value,
      },
      {
        sortBy: optionSort.value,
      },
      SURFACE_SETTINGS_RESOURCE_IDS.sortBy,
    );
  }

  async #showDesktopIcons(
    action: typeof SURFACE_MENU_ITEM_IDS.showDesktopIcons,
    options: ReadonlyMap<string, unknown>,
  ): Promise<SurfaceMenuResolveResult> {
    const nextVisible = booleanOption(options, "showDesktopIcons", valueBooleanOption(options, !this.#state.showDesktopIcons));

    if (!nextVisible.ok) return denyFromError("invalid", nextVisible.error, this.#state, action);

    return await this.#applySettingsEdit(
      action,
      {
        categoryId: SURFACE_SETTINGS_CATEGORY_ID,
        settingId: SURFACE_SETTINGS_SETTING_IDS.showDesktopIcons,
        value: nextVisible.value,
      },
      {
        showDesktopIcons: nextVisible.value,
      },
      SURFACE_SETTINGS_RESOURCE_IDS.showDesktopIcons,
    );
  }

  async #displaySettings(
    action: typeof SURFACE_MENU_ITEM_IDS.displaySettings,
  ): Promise<SurfaceMenuResolveResult> {
    const emitLauncherIntent = this.#emitLauncherIntent;

    if (
      emitLauncherIntent === undefined ||
      !hasDesktopCapabilityGrant(this.#package, "launcher.launch", SURFACE_DISPLAY_SETTINGS_INTENT.appId)
    ) {
      return forbidden(action, this.#state, "/launcher");
    }

    const intent = freezeLauncherIntent(SURFACE_DISPLAY_SETTINGS_INTENT);
    let result: DesktopHostResult<true>;

    try {
      result = await emitLauncherIntent(intent);
    } catch {
      return deny("error", "LAUNCHER_PORT_FAILED", "launcher intent port failed closed.", "/launcher", this.#state, action);
    }

    if (!result.ok) {
      return denyFromHostError("error", result.error, this.#state, action);
    }

    return Object.freeze({
      dispatch: "launcherIntent",
      intent,
      ok: true,
      state: this.#state,
      value: result.value,
      verb: action,
    });
  }

  async #applySettingsEdit(
    action: SurfaceMenuSettingsActionId,
    editInput: SettingsEdit,
    patch: SurfaceSettingsPatch,
    resourceId: string,
  ): Promise<SurfaceMenuResolveResult> {
    const settings = this.#settings;

    if (settings === undefined || !hasDesktopCapabilityGrant(this.#package, "settings.write", resourceId)) {
      return forbidden(action, this.#state, `/settings/${resourceId}`);
    }

    const edit = freezeSettingsEdit(editInput);
    const preview = requestSettingsPreview(this.#settingsState, edit);

    if (!preview.ok) {
      return denyFromAppError("error", preview.error, this.#state, action);
    }

    const previewIntent = freezeSettingsIntent(preview.value.intent);

    if (previewIntent.type !== "control-plane.preview") {
      return deny("error", "SETTINGS_PREVIEW_MISMATCH", "settings preview produced an unexpected intent.", "/settings/preview", this.#state, action);
    }

    let previewResult: Awaited<ReturnType<SettingsControlPlanePort["preview"]>>;

    try {
      previewResult = await settings.preview(previewIntent);
    } catch {
      return deny("error", "SETTINGS_PREVIEW_FAILED", "settings preview port failed closed.", "/settings/preview", this.#state, action);
    }

    if (!previewResult.ok) {
      return denyFromAppError("error", previewResult.error, this.#state, action);
    }

    const apply = requestSettingsApply(preview.value.state, edit);

    if (!apply.ok) {
      return denyFromAppError("error", apply.error, this.#state, action);
    }

    const applyIntent = freezeSettingsIntent(apply.value.intent);

    if (applyIntent.type !== "control-plane.apply") {
      return deny("error", "SETTINGS_APPLY_MISMATCH", "settings apply produced an unexpected intent.", "/settings/apply", this.#state, action);
    }

    let applyResult: Awaited<ReturnType<SettingsControlPlanePort["apply"]>>;

    try {
      applyResult = await settings.apply(applyIntent);
    } catch {
      return deny("error", "SETTINGS_APPLY_FAILED", "settings apply port failed closed.", "/settings/apply", this.#state, action);
    }

    if (!applyResult.ok) {
      return denyFromAppError("error", applyResult.error, this.#state, action);
    }

    this.#settingsState = settleSettingsControlPlaneResult(apply.value.state, applyIntent, applyResult);
    this.#state = stateWithPatch(this.#state, patch);

    return Object.freeze({
      applyIntent,
      applyResult: freezeSettingsAccepted(applyResult.value),
      dispatch: "settings",
      ok: true,
      previewIntent,
      previewResult: freezeSettingsAccepted(previewResult.value),
      state: this.#state,
      verb: action,
    });
  }

  async #callFiles(
    action: SurfaceMenuFileActionId,
    request: SurfaceMenuFilesRequest,
    port: SurfaceMenuFilesPort,
  ): Promise<SurfaceMenuResolveResult> {
    let response: FilesResponse | FilesErrorResponse;

    try {
      response = await port.request(request);
    } catch {
      return deny("error", "FILES_PORT_FAILED", "files capability port failed closed.", "/files", this.#state, action);
    }

    if (isFilesErrorResponse(response)) {
      return deny("error", response.error.code, response.error.message, "/files", this.#state, action);
    }

    return Object.freeze({
      dispatch: "files",
      ok: true,
      request,
      response: freezeFilesResponse(response),
      state: this.#state,
      verb: action,
    });
  }

  #requireFiles(action: SurfaceMenuFileActionId): SurfaceMenuFilesPort | undefined {
    if (
      this.#files === undefined ||
      this.#filesGrant.length === 0 ||
      !hasDesktopCapabilityGrant(this.#package, "files.write", this.#filesGrant)
    ) {
      return undefined;
    }

    if (action === SURFACE_MENU_ITEM_IDS.paste && !clipboardHasPayload(this.#clipboard)) {
      return undefined;
    }

    return this.#files;
  }

  #capabilities(): SurfaceMenuCapabilities {
    const hasFilesGrant = this.#filesGrant.length > 0 && hasDesktopCapabilityGrant(this.#package, "files.write", this.#filesGrant);

    return Object.freeze({
      displaySettings: this.#emitLauncherIntent !== undefined &&
        hasDesktopCapabilityGrant(this.#package, "launcher.launch", SURFACE_DISPLAY_SETTINGS_INTENT.appId),
      filesWrite: this.#files !== undefined && hasFilesGrant,
      iconVisibilityWrite: this.#settings !== undefined &&
        hasDesktopCapabilityGrant(this.#package, "settings.write", SURFACE_SETTINGS_RESOURCE_IDS.showDesktopIcons),
      sortWrite: this.#settings !== undefined &&
        hasDesktopCapabilityGrant(this.#package, "settings.write", SURFACE_SETTINGS_RESOURCE_IDS.sortBy),
      wallpaperWrite: this.#settings !== undefined &&
        hasDesktopCapabilityGrant(this.#package, "settings.write", SURFACE_SETTINGS_RESOURCE_IDS.wallpaper),
    });
  }
}

function deriveSurfaceState(
  surface: SurfaceMenuSurfaceInput | undefined,
  settingsState: SettingsAppState | undefined,
): SurfaceMenuSurfaceState {
  const settingsSurface = settingsState === undefined ? undefined : surfaceStateFromSettings(settingsState);
  const sortBy = surface?.sortBy ?? settingsSurface?.sortBy ?? "name";

  return freezeSurfaceState({
    desktopPath: normalizeCapabilityPath(surface?.desktopPath ?? settingsSurface?.desktopPath ?? DEFAULT_DESKTOP_PATH),
    showDesktopIcons: surface?.showDesktopIcons ?? settingsSurface?.showDesktopIcons ?? true,
    sortBy: isSurfaceSortBy(sortBy) ? sortBy : "name",
    wallpaper: surface?.wallpaper ?? settingsSurface?.wallpaper ?? DEFAULT_WALLPAPER,
  });
}

function surfaceStateFromSettings(state: SettingsAppState): Partial<SurfaceMenuSurfaceState> {
  const wallpaper = findSettingValue(state.config, SURFACE_SETTINGS_CATEGORY_ID, SURFACE_SETTINGS_SETTING_IDS.wallpaper);
  const sortBy = findSettingValue(state.config, SURFACE_SETTINGS_CATEGORY_ID, SURFACE_SETTINGS_SETTING_IDS.sortBy);
  const showDesktopIcons = findSettingValue(state.config, SURFACE_SETTINGS_CATEGORY_ID, SURFACE_SETTINGS_SETTING_IDS.showDesktopIcons);
  const output: {
    desktopPath?: string;
    wallpaper?: string;
    sortBy?: SurfaceMenuSortBy;
    showDesktopIcons?: boolean;
  } = {};

  if (typeof wallpaper === "string") output.wallpaper = wallpaper;
  if (typeof sortBy === "string" && isSurfaceSortBy(sortBy)) output.sortBy = sortBy;
  if (typeof showDesktopIcons === "boolean") output.showDesktopIcons = showDesktopIcons;

  return Object.freeze(output);
}

function surfaceSettingsConfig(state: SurfaceMenuSurfaceState): SettingsManagedConfig {
  return Object.freeze({
    categories: Object.freeze([
      Object.freeze({
        id: SURFACE_SETTINGS_CATEGORY_ID,
        settings: Object.freeze([
          Object.freeze({
            id: SURFACE_SETTINGS_SETTING_IDS.wallpaper,
            kind: "text",
            label: "Wallpaper",
            value: state.wallpaper,
          }),
          Object.freeze({
            id: SURFACE_SETTINGS_SETTING_IDS.sortBy,
            kind: "text",
            label: "Sort by",
            value: state.sortBy,
          }),
          Object.freeze({
            id: SURFACE_SETTINGS_SETTING_IDS.showDesktopIcons,
            kind: "toggle",
            label: "Show desktop icons",
            value: state.showDesktopIcons,
          }),
        ]),
        title: "Desktop",
      }),
    ]),
    revision: "surface-menu",
  });
}

function findSettingValue(
  config: SettingsManagedConfig,
  categoryId: string,
  settingId: string,
): SettingsValue | undefined {
  for (let categoryIndex = 0; categoryIndex < config.categories.length; categoryIndex += 1) {
    const category = config.categories[categoryIndex];

    if (category === undefined || category.id !== categoryId) continue;

    for (let settingIndex = 0; settingIndex < category.settings.length; settingIndex += 1) {
      const setting = category.settings[settingIndex];

      if (setting !== undefined && setting.id === settingId) return setting.value;
    }
  }

  return undefined;
}

function stateWithPatch(state: SurfaceMenuSurfaceState, patch: SurfaceSettingsPatch): SurfaceMenuSurfaceState {
  const next: {
    desktopPath: string;
    wallpaper: string;
    sortBy: SurfaceMenuSortBy;
    showDesktopIcons: boolean;
  } = {
    desktopPath: state.desktopPath,
    showDesktopIcons: state.showDesktopIcons,
    sortBy: state.sortBy,
    wallpaper: state.wallpaper,
  };

  if ("wallpaper" in patch) next.wallpaper = patch.wallpaper;
  if ("sortBy" in patch) next.sortBy = patch.sortBy;
  if ("showDesktopIcons" in patch) next.showDesktopIcons = patch.showDesktopIcons;

  return freezeSurfaceState(next);
}

function sortByItem(currentSort: SurfaceMenuSortBy, disabled: boolean): SurfaceContextMenuItem {
  const items: SurfaceContextMenuEntry[] = [];

  for (let index = 0; index < SORT_OPTIONS.length; index += 1) {
    const option = SORT_OPTIONS[index];

    if (option === undefined) continue;
    items.push(menuItem({
      checked: currentSort === option.value,
      disabled,
      id: option.id,
      label: option.label,
      role: "menuitemcheckbox",
    }));
  }

  return menuItem({
    disabled,
    icon: "arrow-up-down",
    id: SURFACE_MENU_ITEM_IDS.sortBy,
    label: "Sort by",
    role: "submenu",
    submenu: freezeMenu({
      sections: Object.freeze([
        freezeSection({
          id: "surface.sort",
          items: Object.freeze(items),
        }),
      ]),
    }),
  });
}

function sortValueForAction(
  action: SurfaceMenuSettingsActionId,
  options: ReadonlyMap<string, unknown>,
): {
  readonly ok: true;
  readonly value: SurfaceMenuSortBy;
} | {
  readonly ok: false;
  readonly error: SurfaceMenuError;
} {
  if (action === SURFACE_MENU_ITEM_IDS.sortByName) return acceptOption("name");
  if (action === SURFACE_MENU_ITEM_IDS.sortByKind) return acceptOption("kind");
  if (action === SURFACE_MENU_ITEM_IDS.sortByModified) return acceptOption("modified");

  const sortBy = options.get("sortBy") ?? options.get("value");

  if (typeof sortBy !== "string" || !isSurfaceSortBy(sortBy)) {
    return rejectOption("INVALID_SORT", "surface sort must be name, kind, or modified.", "/sortBy");
  }

  return acceptOption(sortBy);
}

function snapshotOptions(options: SurfaceMenuResolveOptions | undefined): NormalizeOptionsResult {
  if (options === undefined) {
    return Object.freeze({
      ok: true,
      value: new Map<string, unknown>(),
    });
  }

  try {
    if (options === null || typeof options !== "object" || Array.isArray(options)) {
      return rejectNormalize("INVALID_OPTIONS", "surface menu options must be a plain object.", "/options");
    }

    const prototype = Object.getPrototypeOf(options);

    if (prototype !== Object.prototype && prototype !== null) {
      return rejectNormalize("INVALID_OPTIONS", "surface menu options must be a plain object.", "/options");
    }

    const keys = Reflect.ownKeys(options);
    const output = new Map<string, unknown>();

    for (let index = 0; index < keys.length; index += 1) {
      const key = keys[index];

      if (key === undefined || typeof key === "symbol" || !contains(RESOLVE_OPTION_KEYS, key)) {
        return rejectNormalize("INVALID_OPTIONS", "surface menu options contain an unsupported field.", "/options");
      }

      const descriptor = Object.getOwnPropertyDescriptor(options, key);

      if (descriptor === undefined || !isDataDescriptor(descriptor) || descriptor.enumerable !== true) {
        return rejectNormalize("INVALID_OPTIONS", "surface menu options must contain only enumerable data fields.", "/options");
      }

      output.set(key, descriptor.value);
    }

    return Object.freeze({
      ok: true,
      value: output,
    });
  } catch {
    return rejectNormalize("INVALID_OPTIONS", "surface menu options must be stable.", "/options");
  }
}

function stringOption(
  options: ReadonlyMap<string, unknown>,
  key: string,
  fallback: string,
): {
  readonly ok: true;
  readonly value: string;
} | {
  readonly ok: false;
  readonly error: SurfaceMenuError;
} {
  const value = options.get(key);

  if (value === undefined) return acceptOption(fallback);
  if (typeof value !== "string" || value.length === 0) {
    return rejectOption("INVALID_STRING_OPTION", `surface menu option '${key}' must be a non-empty string.`, `/${key}`);
  }

  return acceptOption(value);
}

function booleanOption(
  options: ReadonlyMap<string, unknown>,
  key: string,
  fallback: boolean,
): {
  readonly ok: true;
  readonly value: boolean;
} | {
  readonly ok: false;
  readonly error: SurfaceMenuError;
} {
  const value = options.get(key);

  if (value === undefined) return acceptOption(fallback);
  if (typeof value !== "boolean") {
    return rejectOption("INVALID_BOOLEAN_OPTION", `surface menu option '${key}' must be boolean.`, `/${key}`);
  }

  return acceptOption(value);
}

function valueStringOption(options: ReadonlyMap<string, unknown>, fallback: string): string {
  const value = options.get("value");

  return typeof value === "string" ? value : fallback;
}

function valueBooleanOption(options: ReadonlyMap<string, unknown>, fallback: boolean): boolean {
  const value = options.get("value");

  return typeof value === "boolean" ? value : fallback;
}

function normalizeSurfaceMenuActionId(input: string): SurfaceMenuActionId | null {
  switch (input) {
    case SURFACE_MENU_ITEM_IDS.newFolder:
    case SURFACE_MENU_ITEM_IDS.paste:
    case SURFACE_MENU_ITEM_IDS.changeWallpaper:
    case SURFACE_MENU_ITEM_IDS.sortBy:
    case SURFACE_MENU_ITEM_IDS.sortByName:
    case SURFACE_MENU_ITEM_IDS.sortByKind:
    case SURFACE_MENU_ITEM_IDS.sortByModified:
    case SURFACE_MENU_ITEM_IDS.showDesktopIcons:
    case SURFACE_MENU_ITEM_IDS.displaySettings:
    case SURFACE_MENU_ITEM_IDS.refresh:
      return input;
    default:
      break;
  }

  switch (input.trim().toLocaleLowerCase("en-US")) {
    case "new folder":
    case "new-folder":
      return SURFACE_MENU_ITEM_IDS.newFolder;
    case "paste":
      return SURFACE_MENU_ITEM_IDS.paste;
    case "change wallpaper":
    case "change wallpaper…":
    case "change-wallpaper":
      return SURFACE_MENU_ITEM_IDS.changeWallpaper;
    case "sort by":
    case "sort-by":
      return SURFACE_MENU_ITEM_IDS.sortBy;
    case "sort-by-name":
      return SURFACE_MENU_ITEM_IDS.sortByName;
    case "sort-by-kind":
      return SURFACE_MENU_ITEM_IDS.sortByKind;
    case "sort-by-modified":
      return SURFACE_MENU_ITEM_IDS.sortByModified;
    case "show desktop icons":
    case "show-desktop-icons":
      return SURFACE_MENU_ITEM_IDS.showDesktopIcons;
    case "display settings":
    case "display-settings":
      return SURFACE_MENU_ITEM_IDS.displaySettings;
    case "refresh":
      return SURFACE_MENU_ITEM_IDS.refresh;
    default:
      return null;
  }
}

function normalizeClipboard(input: SurfaceMenuClipboardPayload | undefined): SurfaceMenuClipboardPayload | undefined {
  if (input === undefined || !Array.isArray(input.paths)) return undefined;
  if (input.mode !== "copy" && input.mode !== "cut") return undefined;

  const paths: string[] = [];

  for (let index = 0; index < input.paths.length; index += 1) {
    const path = input.paths[index];

    if (typeof path === "string" && path.length > 0) {
      paths.push(normalizeCapabilityPath(path));
    }
  }

  if (paths.length === 0) return undefined;

  return Object.freeze({
    mode: input.mode,
    paths: Object.freeze(paths),
  });
}

function clipboardHasPayload(input: SurfaceMenuClipboardPayload | undefined): input is SurfaceMenuClipboardPayload {
  return input !== undefined && input.paths.length > 0;
}

function menuItem(input: {
  readonly id: string;
  readonly label: string;
  readonly disabled: boolean;
  readonly icon?: string;
  readonly role?: SurfaceMenuItemRole;
  readonly checked?: boolean;
  readonly submenu?: SurfaceContextMenu;
}): SurfaceContextMenuItem {
  const output: {
    kind: "item";
    id: string;
    label: string;
    role: SurfaceMenuItemRole;
    disabled: boolean;
    icon?: string;
    checked?: boolean;
    submenu?: SurfaceContextMenu;
  } = {
    disabled: input.disabled,
    id: input.id,
    kind: "item",
    label: input.label,
    role: input.role ?? "menuitem",
  };

  if (input.icon !== undefined) output.icon = input.icon;
  if (input.checked !== undefined) output.checked = input.checked;
  if (input.submenu !== undefined) output.submenu = input.submenu;

  return Object.freeze(output);
}

function separator(id: string): SurfaceContextMenuSeparator {
  return Object.freeze({
    id,
    kind: "separator",
    role: "separator",
  });
}

function freezeMenu(menu: SurfaceContextMenu): SurfaceContextMenu {
  return Object.freeze({
    sections: Object.freeze(menu.sections.map(freezeSection)),
  });
}

function freezeSection(section: SurfaceContextMenuSection): SurfaceContextMenuSection {
  return Object.freeze({
    id: section.id,
    items: Object.freeze(section.items.map(freezeEntry)),
  });
}

function freezeEntry(entry: SurfaceContextMenuEntry): SurfaceContextMenuEntry {
  if (entry.kind === "separator") return separator(entry.id);

  const output: {
    kind: "item";
    id: string;
    label: string;
    role: SurfaceMenuItemRole;
    disabled: boolean;
    icon?: string;
    checked?: boolean;
    submenu?: SurfaceContextMenu;
  } = {
    disabled: entry.disabled,
    id: entry.id,
    kind: "item",
    label: entry.label,
    role: entry.role,
  };

  if (entry.icon !== undefined) output.icon = entry.icon;
  if (entry.checked !== undefined) output.checked = entry.checked;
  if (entry.submenu !== undefined) output.submenu = freezeMenu(entry.submenu);

  return Object.freeze(output);
}

function freezeSurfaceState(input: SurfaceMenuSurfaceState): SurfaceMenuSurfaceState {
  return Object.freeze({
    desktopPath: normalizeCapabilityPath(input.desktopPath),
    showDesktopIcons: input.showDesktopIcons,
    sortBy: input.sortBy,
    wallpaper: input.wallpaper,
  });
}

function freezeSurfaceFilesRequest(request: SurfaceMenuFilesRequest): SurfaceMenuFilesRequest {
  if (request.op === "mkdir") {
    return Object.freeze({
      grant: request.grant,
      op: request.op,
      path: normalizeCapabilityPath(request.path),
    });
  }
  if (request.op === "paste") {
    return Object.freeze({
      data: request.data,
      grant: request.grant,
      op: request.op,
      path: normalizeCapabilityPath(request.path),
    });
  }

  const output: {
    op: FilesRequest["op"];
    grant: string;
    path: string;
    data?: string;
  } = {
    grant: request.grant,
    op: request.op,
    path: normalizeCapabilityPath(request.path),
  };

  if (request.data !== undefined) output.data = request.data;

  return Object.freeze(output);
}

function freezeFilesResponse(response: FilesResponse): FilesResponse {
  const output: {
    entries?: readonly FilesEntry[];
    data?: string;
    kind?: FilesEntry["kind"];
    size?: number;
    mtime?: string;
  } = {};

  if (response.entries !== undefined) output.entries = Object.freeze(response.entries.map(freezeFilesEntry));
  if (response.data !== undefined) output.data = response.data;
  if (response.kind !== undefined) output.kind = response.kind;
  if (response.size !== undefined) output.size = response.size;
  if (response.mtime !== undefined) output.mtime = response.mtime;

  return Object.freeze(output);
}

function freezeFilesEntry(entry: FilesEntry): FilesEntry {
  return Object.freeze({
    kind: entry.kind,
    mtime: entry.mtime,
    name: entry.name,
    size: entry.size,
  });
}

function freezeSettingsEdit(edit: SettingsEdit): SettingsEdit {
  return Object.freeze({
    categoryId: edit.categoryId,
    settingId: edit.settingId,
    value: edit.value,
  });
}

function freezeSettingsIntent(intent: SettingsControlPlaneIntent): SettingsControlPlaneIntent {
  if (intent.type === "control-plane.preview") {
    return Object.freeze({
      appId: intent.appId,
      desired: intent.desired,
      edit: intent.edit,
      type: intent.type,
    });
  }

  return Object.freeze({
    appId: intent.appId,
    desired: intent.desired,
    edit: intent.edit,
    type: intent.type,
  });
}

function freezeSettingsAccepted(input: SettingsControlPlaneAccepted): SettingsControlPlaneAccepted {
  const output: {
    stage: SettingsControlPlaneAccepted["stage"];
    detail?: NonNullable<SettingsControlPlaneAccepted["detail"]>;
  } = {
    stage: input.stage,
  };

  if (input.detail !== undefined) output.detail = Object.freeze({ ...input.detail });

  return Object.freeze(output);
}

function freezeLauncherIntent(intent: DesktopLauncherIntent): DesktopLauncherIntent {
  const output: {
    type: DesktopLauncherIntent["type"];
    appId?: string;
    query?: string;
  } = {
    type: intent.type,
  };

  if (intent.appId !== undefined) output.appId = intent.appId;
  if (intent.query !== undefined) output.query = intent.query;

  return Object.freeze(output);
}

function isFilesErrorResponse(response: FilesResponse | FilesErrorResponse): response is FilesErrorResponse {
  return "error" in response;
}

function isSurfaceSortBy(value: string): value is SurfaceMenuSortBy {
  return value === "name" || value === "kind" || value === "modified";
}

function isValidEntryName(value: string): boolean {
  return value.length > 0 && value !== "." && value !== ".." && !value.includes("/") && !value.includes("\\");
}

function normalizeCapabilityPath(path: string): string {
  if (path.length === 0) return "/";

  const absolute = path.startsWith("/");
  const parts = path.split("/");
  const normalized: string[] = [];

  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index];

    if (part === undefined || part.length === 0 || part === ".") continue;
    if (part === "..") {
      normalized.pop();
      continue;
    }
    normalized.push(part);
  }

  if (absolute) {
    if (normalized.length === 0) return "/";

    return `/${normalized.join("/")}`;
  }

  if (normalized.length === 0) return ".";

  return normalized.join("/");
}

function refreshResult(state: SurfaceMenuSurfaceState): SurfaceMenuRefreshResult {
  return Object.freeze({
    dispatch: "local",
    ok: true,
    state,
    value: state,
    verb: SURFACE_MENU_ITEM_IDS.refresh,
  });
}

function forbidden(verb: string, state: SurfaceMenuSurfaceState, path: string): SurfaceMenuDeniedResult {
  return deny("forbidden", "FORBIDDEN", "surface menu action is not permitted.", path, state, verb);
}

function deny(
  reason: SurfaceMenuDenyReason,
  code: string,
  message: string,
  path: string,
  state: SurfaceMenuSurfaceState,
  verb?: string,
): SurfaceMenuDeniedResult {
  const output: {
    ok: false;
    reason: SurfaceMenuDenyReason;
    error: SurfaceMenuError;
    state: SurfaceMenuSurfaceState;
    verb?: string;
  } = {
    error: Object.freeze({
      code,
      message,
      path,
    }),
    ok: false,
    reason,
    state,
  };

  if (verb !== undefined) output.verb = verb;

  return Object.freeze(output);
}

function denyFromError(
  reason: SurfaceMenuDenyReason,
  error: SurfaceMenuError,
  state: SurfaceMenuSurfaceState,
  verb?: string,
): SurfaceMenuDeniedResult {
  return deny(reason, error.code, error.message, error.path, state, verb);
}

function denyFromAppError(
  reason: SurfaceMenuDenyReason,
  error: AppError,
  state: SurfaceMenuSurfaceState,
  verb: string,
): SurfaceMenuDeniedResult {
  return deny(reason, error.code, error.message, error.path, state, verb);
}

function denyFromHostError(
  reason: SurfaceMenuDenyReason,
  error: DesktopHostError,
  state: SurfaceMenuSurfaceState,
  verb: string,
): SurfaceMenuDeniedResult {
  return deny(reason, error.code, error.message, error.path, state, verb);
}

function acceptOption<T>(value: T): {
  readonly ok: true;
  readonly value: T;
} {
  return Object.freeze({
    ok: true,
    value,
  });
}

function rejectOption<T>(code: string, message: string, path: string): {
  readonly ok: false;
  readonly error: SurfaceMenuError;
} {
  return Object.freeze({
    error: Object.freeze({
      code,
      message,
      path,
    }),
    ok: false,
  });
}

function rejectNormalize(code: string, message: string, path: string): NormalizeOptionsResult {
  return Object.freeze({
    error: Object.freeze({
      code,
      message,
      path,
    }),
    ok: false,
  });
}

function contains(values: readonly string[], value: string): boolean {
  for (let index = 0; index < values.length; index += 1) {
    if (values[index] === value) return true;
  }

  return false;
}

function isDataDescriptor(descriptor: PropertyDescriptor): descriptor is PropertyDescriptor & {
  readonly value: unknown;
} {
  return Object.prototype.hasOwnProperty.call(descriptor, "value");
}
