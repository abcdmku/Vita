import {
  defineShellComponent,
  defineShellConfig,
  shellSurface,
} from "../shell/index.ts";
import type {
  ShellComponentDefinition,
  ShellConfigDefinition,
} from "../shell/index.ts";
import { shellComponent } from "../shell/index.ts";
import { safeNormalize } from "../safe-normalize.ts";
import type { FilesEntry, FilesErrorResponse, FilesRequest, FilesResponse } from "../files-grant.ts";
import type { PlainJson, PlainJsonObject } from "../safe-normalize.ts";
import type { WindowOpenRequest } from "../wm/policy.ts";

export const VITA_APPS_DESKTOP_COMPONENT_ID = "vita.apps.desktop";
export const VITA_SETTINGS_APP_COMPONENT_ID = "vita.app.settings";
export const VITA_FILE_MANAGER_APP_COMPONENT_ID = "vita.app.file-manager";
export const VITA_SETTINGS_WINDOW_ID = "window:vita.app.settings";
export const VITA_FILE_MANAGER_WINDOW_ID = "window:vita.app.file-manager";

export type AppResult<T> =
  | {
      readonly ok: true;
      readonly value: T;
    }
  | {
      readonly ok: false;
      readonly error: AppError;
    };

export interface AppError {
  readonly code: string;
  readonly message: string;
  readonly path: string;
}

export type SettingsValue = string | number | boolean;
export type SettingsWidgetKind = "toggle" | "text" | "number";

export interface SettingsWidget {
  readonly id: string;
  readonly label: string;
  readonly kind: SettingsWidgetKind;
  readonly value: SettingsValue;
}

export interface SettingsCategory {
  readonly id: string;
  readonly title: string;
  readonly settings: readonly SettingsWidget[];
}

export interface SettingsManagedConfig {
  readonly revision: string;
  readonly categories: readonly SettingsCategory[];
}

export interface SettingsEdit {
  readonly categoryId: string;
  readonly settingId: string;
  readonly value: SettingsValue;
}

export interface SettingsPendingEdit {
  readonly phase: "preview" | "apply";
  readonly edit: SettingsEdit;
  readonly desired: SettingsManagedConfig;
}

export interface SettingsAppState {
  readonly config: SettingsManagedConfig;
  readonly selectedCategoryId: string;
  readonly pending?: SettingsPendingEdit;
}

export interface SettingsPreviewIntent {
  readonly type: "control-plane.preview";
  readonly appId: typeof VITA_SETTINGS_APP_COMPONENT_ID;
  readonly edit: SettingsEdit;
  readonly desired: SettingsManagedConfig;
}

export interface SettingsApplyIntent {
  readonly type: "control-plane.apply";
  readonly appId: typeof VITA_SETTINGS_APP_COMPONENT_ID;
  readonly edit: SettingsEdit;
  readonly desired: SettingsManagedConfig;
}

export type SettingsControlPlaneIntent = SettingsPreviewIntent | SettingsApplyIntent;

export interface SettingsControlPlaneAccepted {
  readonly stage: "preview" | "apply";
  readonly detail?: PlainJsonObject;
}

export type SettingsControlPlaneResult = AppResult<SettingsControlPlaneAccepted>;

export interface SettingsControlPlanePort {
  preview(intent: SettingsPreviewIntent): SettingsControlPlaneResult | Promise<SettingsControlPlaneResult>;
  apply(intent: SettingsApplyIntent): SettingsControlPlaneResult | Promise<SettingsControlPlaneResult>;
}

export interface SettingsIntentTransition {
  readonly state: SettingsAppState;
  readonly intent: SettingsControlPlaneIntent;
}

export interface FileManagerSelectedFile {
  readonly path: string;
  readonly kind: FilesEntry["kind"];
  readonly size?: number;
  readonly mtime?: string;
  readonly data?: string;
}

export type FileManagerStatus = "idle" | "ready" | "preview" | "forbidden" | "error";

export interface FileManagerState {
  readonly grant: string;
  readonly path: string;
  readonly status: FileManagerStatus;
  readonly entries: readonly FilesEntry[];
  readonly selected?: FileManagerSelectedFile;
  readonly error?: AppError;
}

export interface FileManagerStateInput {
  readonly grant: string;
  readonly path?: string;
  readonly status?: FileManagerStatus;
  readonly entries?: readonly FilesEntry[];
  readonly selected?: FileManagerSelectedFile;
  readonly error?: AppError;
}

export interface FilesCapabilityPort {
  request(request: FilesRequest): FilesResponse | FilesErrorResponse | Promise<FilesResponse | FilesErrorResponse>;
}

export interface FileManagerTransition {
  readonly state: FileManagerState;
  readonly request: FilesRequest;
}

const SETTINGS_WINDOW_CLASS = "vita-app-window vita-settings-app";
const FILE_MANAGER_WINDOW_CLASS = "vita-app-window vita-file-manager-app";
const DESKTOP_HOST_CLASS = "vita-apps-desktop";
const EMPTY_ENTRIES: readonly FilesEntry[] = Object.freeze([]);

export const vitaAppsDesktopComponent: ShellComponentDefinition<PlainJsonObject> = defineShellComponent({
  defaultPlacement: {
    layer: "desktop",
    order: 0,
    zone: "center",
  },
  id: VITA_APPS_DESKTOP_COMPONENT_ID,
  render: (_props, context) => shellSurface({
    appId: VITA_APPS_DESKTOP_COMPONENT_ID,
    kind: "desktop-host",
    title: "Vita Desktop",
    windowCount: context.children.length,
  }, {
    className: DESKTOP_HOST_CLASS,
  }),
  role: "desktop",
});

export const settingsAppWindowComponent: ShellComponentDefinition<PlainJsonObject> = defineShellComponent({
  defaultPlacement: {
    layer: "desktop",
    order: 10,
    rect: {
      height: 520,
      width: 760,
      x: 80,
      y: 64,
    },
    zone: "center",
  },
  id: VITA_SETTINGS_APP_COMPONENT_ID,
  render: (props) => shellSurface(windowPayload(props, VITA_SETTINGS_APP_COMPONENT_ID, "Settings"), {
    className: SETTINGS_WINDOW_CLASS,
  }),
  role: "window",
});

export const fileManagerAppWindowComponent: ShellComponentDefinition<PlainJsonObject> = defineShellComponent({
  defaultPlacement: {
    layer: "desktop",
    order: 20,
    rect: {
      height: 560,
      width: 820,
      x: 180,
      y: 96,
    },
    zone: "center",
  },
  id: VITA_FILE_MANAGER_APP_COMPONENT_ID,
  render: (props) => shellSurface(windowPayload(props, VITA_FILE_MANAGER_APP_COMPONENT_ID, "Files"), {
    className: FILE_MANAGER_WINDOW_CLASS,
  }),
  role: "window",
});

export const firstPartyAppComponents: readonly ShellComponentDefinition<PlainJsonObject>[] = Object.freeze([
  vitaAppsDesktopComponent,
  settingsAppWindowComponent,
  fileManagerAppWindowComponent,
]);

export function createSettingsAppState(
  config: SettingsManagedConfig,
  selectedCategoryId?: string,
): SettingsAppState {
  const frozenConfig = freezeSettingsConfig(config);

  return freezeSettingsState({
    config: frozenConfig,
    selectedCategoryId: selectedCategoryId ?? firstCategoryId(frozenConfig),
  });
}

export function renderSettingsAppSurface(state: SettingsAppState): PlainJsonObject {
  const selectedCategory = findCategory(state.config, state.selectedCategoryId) ?? state.config.categories[0];
  const categories: PlainJson[] = [];
  const widgets: PlainJson[] = [];

  for (let index = 0; index < state.config.categories.length; index += 1) {
    const category = state.config.categories[index];

    if (category === undefined) continue;
    categories.push(Object.freeze({
      id: category.id,
      selected: category.id === state.selectedCategoryId,
      title: category.title,
    }) satisfies PlainJsonObject);
  }

  if (selectedCategory !== undefined) {
    for (let index = 0; index < selectedCategory.settings.length; index += 1) {
      const setting = selectedCategory.settings[index];

      if (setting === undefined) continue;
      widgets.push(Object.freeze({
        id: setting.id,
        kind: setting.kind,
        label: setting.label,
        value: setting.value,
      }) satisfies PlainJsonObject);
    }
  }

  const output: Record<string, PlainJson> = {
    appId: VITA_SETTINGS_APP_COMPONENT_ID,
    categories: Object.freeze(categories),
    kind: "settings-window",
    revision: state.config.revision,
    selectedCategoryId: state.selectedCategoryId,
    title: "Settings",
    widgets: Object.freeze(widgets),
    windowed: true,
  };

  if (state.pending !== undefined) {
    output["pending"] = settingsPendingToJson(state.pending);
  }

  return Object.freeze(output);
}

export function settingsAppProps(state: SettingsAppState): PlainJsonObject {
  return renderSettingsAppSurface(state);
}

export function requestSettingsPreview(
  state: SettingsAppState,
  edit: SettingsEdit,
): AppResult<SettingsIntentTransition> {
  return buildSettingsIntent(state, edit, "preview");
}

export function requestSettingsApply(
  state: SettingsAppState,
  edit: SettingsEdit,
): AppResult<SettingsIntentTransition> {
  return buildSettingsIntent(state, edit, "apply");
}

export async function emitSettingsControlPlaneIntent(
  port: SettingsControlPlanePort,
  intent: SettingsControlPlaneIntent,
): Promise<SettingsControlPlaneResult> {
  try {
    if (intent.type === "control-plane.preview") {
      return await port.preview(intent);
    }

    return await port.apply(intent);
  } catch {
    return reject("CONTROL_PLANE_FAILED", "Control-plane intent failed closed.", "/controlPlane");
  }
}

export function settleSettingsControlPlaneResult(
  state: SettingsAppState,
  intent: SettingsControlPlaneIntent,
  result: SettingsControlPlaneResult,
): SettingsAppState {
  if (!result.ok) {
    return state;
  }

  if (intent.type === "control-plane.apply") {
    return freezeSettingsState({
      config: intent.desired,
      selectedCategoryId: intent.edit.categoryId,
    });
  }

  return freezeSettingsState({
    config: state.config,
    pending: {
      desired: intent.desired,
      edit: intent.edit,
      phase: "preview",
    },
    selectedCategoryId: intent.edit.categoryId,
  });
}

export function createFileManagerState(input: FileManagerStateInput): FileManagerState {
  const stateInput: {
    grant: string;
    path: string;
    status: FileManagerStatus;
    entries: readonly FilesEntry[];
    selected?: FileManagerSelectedFile;
    error?: AppError;
  } = {
    entries: input.entries ?? EMPTY_ENTRIES,
    grant: input.grant,
    path: input.path ?? "/",
    status: input.status ?? "idle",
  };

  if (input.selected !== undefined) stateInput.selected = input.selected;
  if (input.error !== undefined) stateInput.error = input.error;

  return freezeFileManagerState(stateInput);
}

export function renderFileManagerAppSurface(state: FileManagerState): PlainJsonObject {
  const entries: PlainJson[] = [];

  for (let index = 0; index < state.entries.length; index += 1) {
    const entry = state.entries[index];

    if (entry === undefined) continue;
    entries.push(Object.freeze({
      kind: entry.kind,
      mtime: entry.mtime,
      name: entry.name,
      path: joinCapabilityPath(state.path, entry.name),
      size: entry.size,
    }) satisfies PlainJsonObject);
  }

  const output: Record<string, PlainJson> = {
    appId: VITA_FILE_MANAGER_APP_COMPONENT_ID,
    entries: Object.freeze(entries),
    grant: state.grant,
    kind: "file-manager-window",
    path: state.path,
    status: state.status,
    title: "Files",
    windowed: true,
  };

  if (state.selected !== undefined) {
    output["selected"] = selectedFileToJson(state.selected);
  }
  if (state.error !== undefined) {
    output["error"] = appErrorToJson(state.error);
  }

  return Object.freeze(output);
}

export function fileManagerAppProps(state: FileManagerState): PlainJsonObject {
  return renderFileManagerAppSurface(state);
}

export function settingsAppWindowRequest(workspaceId?: string): WindowOpenRequest {
  const request: {
    height: number;
    id: string;
    textureId: string;
    width: number;
    x: number;
    y: number;
    workspaceId?: string;
  } = {
    height: 520,
    id: VITA_SETTINGS_WINDOW_ID,
    textureId: VITA_SETTINGS_APP_COMPONENT_ID,
    width: 760,
    x: 80,
    y: 64,
  };

  if (workspaceId !== undefined) request.workspaceId = workspaceId;

  return appWindowRequest(request);
}

export function fileManagerAppWindowRequest(workspaceId?: string): WindowOpenRequest {
  const request: {
    height: number;
    id: string;
    textureId: string;
    width: number;
    x: number;
    y: number;
    workspaceId?: string;
  } = {
    height: 560,
    id: VITA_FILE_MANAGER_WINDOW_ID,
    textureId: VITA_FILE_MANAGER_APP_COMPONENT_ID,
    width: 820,
    x: 180,
    y: 96,
  };

  if (workspaceId !== undefined) request.workspaceId = workspaceId;

  return appWindowRequest(request);
}

export function firstPartyAppWindowRequests(workspaceId?: string): readonly WindowOpenRequest[] {
  return Object.freeze([
    settingsAppWindowRequest(workspaceId),
    fileManagerAppWindowRequest(workspaceId),
  ]);
}

export async function loadFileManagerDirectory(
  port: FilesCapabilityPort,
  state: FileManagerState,
  path: string = state.path,
): Promise<FileManagerTransition> {
  const request = freezeFilesRequest({
    grant: state.grant,
    op: "list",
    path,
  });
  const response = await callFilesPort(port, request, "/files/list");

  if (!response.ok) {
    return Object.freeze({
      request,
      state: fileManagerErrorState(state, path, response.error),
    });
  }

  const entries = response.value.entries;

  if (entries === undefined) {
    return Object.freeze({
      request,
      state: fileManagerErrorState(state, path, {
        code: "MALFORMED_FILES_RESPONSE",
        message: "list response did not include entries.",
        path: "/files/list/entries",
      }),
    });
  }

  return Object.freeze({
    request,
    state: freezeFileManagerState({
      entries: sortEntries(entries),
      grant: state.grant,
      path,
      status: "ready",
    }),
  });
}

export async function navigateFileManager(
  port: FilesCapabilityPort,
  state: FileManagerState,
  entryName: string,
): Promise<readonly FileManagerTransition[]> {
  const targetPath = joinCapabilityPath(state.path, entryName);
  const statRequest = freezeFilesRequest({
    grant: state.grant,
    op: "stat",
    path: targetPath,
  });
  const stat = await callFilesPort(port, statRequest, "/files/stat");

  if (!stat.ok) {
    return Object.freeze([
      Object.freeze({
        request: statRequest,
        state: fileManagerErrorState(state, targetPath, stat.error),
      }),
    ]);
  }

  const kind = stat.value.kind;

  if (kind === undefined) {
    return Object.freeze([
      Object.freeze({
        request: statRequest,
        state: fileManagerErrorState(state, targetPath, {
          code: "MALFORMED_FILES_RESPONSE",
          message: "stat response did not include kind.",
          path: "/files/stat/kind",
        }),
      }),
    ]);
  }

  if (kind === "dir") {
    const listed = await loadFileManagerDirectory(port, state, targetPath);

    return Object.freeze([
      Object.freeze({
        request: statRequest,
        state: stateWithSelectedStat(state, targetPath, stat.value),
      }),
      listed,
    ]);
  }

  if (kind === "file") {
    const read = await readFileManagerFile(port, state, targetPath, stat.value);

    return Object.freeze([
      Object.freeze({
        request: statRequest,
        state: stateWithSelectedStat(state, targetPath, stat.value),
      }),
      read,
    ]);
  }

  return Object.freeze([
    Object.freeze({
      request: statRequest,
      state: stateWithSelectedStat(state, targetPath, stat.value),
    }),
  ]);
}

export async function readFileManagerFile(
  port: FilesCapabilityPort,
  state: FileManagerState,
  path: string,
  stat: FilesResponse = Object.freeze({}),
): Promise<FileManagerTransition> {
  const request = freezeFilesRequest({
    grant: state.grant,
    op: "read",
    path,
  });
  const response = await callFilesPort(port, request, "/files/read");

  if (!response.ok) {
    return Object.freeze({
      request,
      state: fileManagerErrorState(state, path, response.error),
    });
  }

  if (typeof response.value.data !== "string") {
    return Object.freeze({
      request,
      state: fileManagerErrorState(state, path, {
        code: "MALFORMED_FILES_RESPONSE",
        message: "read response did not include data.",
        path: "/files/read/data",
      }),
    });
  }

  const selected: {
    data: string;
    kind: "file";
    path: string;
    mtime?: string;
    size?: number;
  } = {
    data: response.value.data,
    kind: "file",
    path,
  };
  const mtime = response.value.mtime ?? stat.mtime;
  const size = response.value.size ?? stat.size;

  if (mtime !== undefined) selected.mtime = mtime;
  if (size !== undefined) selected.size = size;

  return Object.freeze({
    request,
    state: freezeFileManagerState({
      entries: state.entries,
      grant: state.grant,
      path: state.path,
      selected,
      status: "preview",
    }),
  });
}

export function firstPartyAppsShellConfig(input: {
  readonly settings: SettingsAppState;
  readonly files: FileManagerState;
  readonly revision?: string;
}): ShellConfigDefinition {
  return defineShellConfig({
    id: "vita.apps.shell",
    render: ({ component }) => component(VITA_APPS_DESKTOP_COMPONENT_ID, {
      children: [
        component(VITA_SETTINGS_APP_COMPONENT_ID, {
          key: "settings",
          props: settingsAppProps(input.settings),
        }),
        component(VITA_FILE_MANAGER_APP_COMPONENT_ID, {
          key: "files",
          props: fileManagerAppProps(input.files),
        }),
      ],
    }),
    revision: input.revision ?? "apps",
  });
}

function appWindowRequest(input: {
  readonly id: string;
  readonly textureId: string;
  readonly workspaceId?: string;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}): WindowOpenRequest {
  const output: {
    id: string;
    textureId: string;
    mode: "floating";
    rect: {
      readonly x: number;
      readonly y: number;
      readonly width: number;
      readonly height: number;
    };
    workspaceId?: string;
  } = {
    id: input.id,
    mode: "floating",
    rect: Object.freeze({
      height: input.height,
      width: input.width,
      x: input.x,
      y: input.y,
    }),
    textureId: input.textureId,
  };

  if (input.workspaceId !== undefined) output.workspaceId = input.workspaceId;

  return Object.freeze(output);
}

function buildSettingsIntent(
  state: SettingsAppState,
  edit: SettingsEdit,
  phase: "preview" | "apply",
): AppResult<SettingsIntentTransition> {
  const desired = applySettingsEdit(state.config, edit);

  if (!desired.ok) return desired;

  const pending: SettingsPendingEdit = Object.freeze({
    desired: desired.value,
    edit: freezeSettingsEdit(edit),
    phase,
  });
  const nextState = freezeSettingsState({
    config: state.config,
    pending,
    selectedCategoryId: edit.categoryId,
  });

  if (phase === "preview") {
    return accept(Object.freeze({
      intent: Object.freeze({
        appId: VITA_SETTINGS_APP_COMPONENT_ID,
        desired: desired.value,
        edit: pending.edit,
        type: "control-plane.preview",
      }),
      state: nextState,
    }));
  }

  return accept(Object.freeze({
    intent: Object.freeze({
      appId: VITA_SETTINGS_APP_COMPONENT_ID,
      desired: desired.value,
      edit: pending.edit,
      type: "control-plane.apply",
    }),
    state: nextState,
  }));
}

function applySettingsEdit(
  config: SettingsManagedConfig,
  edit: SettingsEdit,
): AppResult<SettingsManagedConfig> {
  const categories: SettingsCategory[] = [];
  let foundCategory = false;
  let foundSetting = false;

  for (let categoryIndex = 0; categoryIndex < config.categories.length; categoryIndex += 1) {
    const category = config.categories[categoryIndex];

    if (category === undefined) continue;
    if (category.id !== edit.categoryId) {
      categories.push(category);
      continue;
    }

    foundCategory = true;
    const settings: SettingsWidget[] = [];

    for (let settingIndex = 0; settingIndex < category.settings.length; settingIndex += 1) {
      const setting = category.settings[settingIndex];

      if (setting === undefined) continue;
      if (setting.id !== edit.settingId) {
        settings.push(setting);
        continue;
      }

      foundSetting = true;
      if (!settingAcceptsValue(setting.kind, edit.value)) {
        return reject(
          "INVALID_SETTING_VALUE",
          `setting '${edit.settingId}' does not accept the supplied value.`,
          `/categories/${categoryIndex}/settings/${settingIndex}/value`,
        );
      }

      settings.push(freezeSettingsWidget({
        id: setting.id,
        kind: setting.kind,
        label: setting.label,
        value: edit.value,
      }));
    }

    categories.push(freezeSettingsCategory({
      id: category.id,
      settings: Object.freeze(settings),
      title: category.title,
    }));
  }

  if (!foundCategory) {
    return reject("UNKNOWN_SETTING_CATEGORY", `settings category '${edit.categoryId}' is not available.`, "/categoryId");
  }
  if (!foundSetting) {
    return reject("UNKNOWN_SETTING", `setting '${edit.settingId}' is not available.`, "/settingId");
  }

  return accept(freezeSettingsConfig({
    categories: Object.freeze(categories),
    revision: config.revision,
  }));
}

function settingAcceptsValue(kind: SettingsWidgetKind, value: SettingsValue): boolean {
  if (kind === "toggle") return typeof value === "boolean";
  if (kind === "number") return typeof value === "number" && Number.isFinite(value);

  return typeof value === "string";
}

function freezeSettingsState(input: {
  readonly config: SettingsManagedConfig;
  readonly selectedCategoryId: string;
  readonly pending?: SettingsPendingEdit;
}): SettingsAppState {
  const output: {
    config: SettingsManagedConfig;
    selectedCategoryId: string;
    pending?: SettingsPendingEdit;
  } = {
    config: freezeSettingsConfig(input.config),
    selectedCategoryId: input.selectedCategoryId,
  };

  if (input.pending !== undefined) output.pending = freezeSettingsPending(input.pending);

  return Object.freeze(output);
}

function freezeSettingsPending(input: SettingsPendingEdit): SettingsPendingEdit {
  return Object.freeze({
    desired: freezeSettingsConfig(input.desired),
    edit: freezeSettingsEdit(input.edit),
    phase: input.phase,
  });
}

function freezeSettingsEdit(input: SettingsEdit): SettingsEdit {
  return Object.freeze({
    categoryId: input.categoryId,
    settingId: input.settingId,
    value: input.value,
  });
}

function freezeSettingsConfig(input: SettingsManagedConfig): SettingsManagedConfig {
  return Object.freeze({
    categories: Object.freeze(input.categories.map(freezeSettingsCategory)),
    revision: input.revision,
  });
}

function freezeSettingsCategory(input: SettingsCategory): SettingsCategory {
  return Object.freeze({
    id: input.id,
    settings: Object.freeze(input.settings.map(freezeSettingsWidget)),
    title: input.title,
  });
}

function freezeSettingsWidget(input: SettingsWidget): SettingsWidget {
  return Object.freeze({
    id: input.id,
    kind: input.kind,
    label: input.label,
    value: input.value,
  });
}

function firstCategoryId(config: SettingsManagedConfig): string {
  return config.categories[0]?.id ?? "";
}

function findCategory(config: SettingsManagedConfig, categoryId: string): SettingsCategory | undefined {
  for (let index = 0; index < config.categories.length; index += 1) {
    const category = config.categories[index];

    if (category !== undefined && category.id === categoryId) return category;
  }

  return undefined;
}

function settingsPendingToJson(pending: SettingsPendingEdit): PlainJsonObject {
  return Object.freeze({
    categoryId: pending.edit.categoryId,
    phase: pending.phase,
    settingId: pending.edit.settingId,
    value: pending.edit.value,
  });
}

function freezeFileManagerState(input: {
  readonly grant: string;
  readonly path: string;
  readonly status: FileManagerStatus;
  readonly entries: readonly FilesEntry[];
  readonly selected?: FileManagerSelectedFile;
  readonly error?: AppError;
}): FileManagerState {
  const output: {
    grant: string;
    path: string;
    status: FileManagerStatus;
    entries: readonly FilesEntry[];
    selected?: FileManagerSelectedFile;
    error?: AppError;
  } = {
    entries: sortEntries(input.entries),
    grant: input.grant,
    path: input.path,
    status: input.status,
  };

  if (input.selected !== undefined) output.selected = freezeSelectedFile(input.selected);
  if (input.error !== undefined) output.error = freezeAppError(input.error);

  return Object.freeze(output);
}

function freezeSelectedFile(input: FileManagerSelectedFile): FileManagerSelectedFile {
  const output: {
    path: string;
    kind: FilesEntry["kind"];
    size?: number;
    mtime?: string;
    data?: string;
  } = {
    kind: input.kind,
    path: input.path,
  };

  if (input.size !== undefined) output.size = input.size;
  if (input.mtime !== undefined) output.mtime = input.mtime;
  if (input.data !== undefined) output.data = input.data;

  return Object.freeze(output);
}

function freezeAppError(input: AppError): AppError {
  return Object.freeze({
    code: input.code,
    message: input.message,
    path: input.path,
  });
}

function freezeFilesEntry(input: FilesEntry): FilesEntry {
  return Object.freeze({
    kind: input.kind,
    mtime: input.mtime,
    name: input.name,
    size: input.size,
  });
}

function sortEntries(entries: readonly FilesEntry[]): readonly FilesEntry[] {
  const output = entries.map(freezeFilesEntry);

  output.sort(compareFilesEntries);
  return Object.freeze(output);
}

function compareFilesEntries(left: FilesEntry, right: FilesEntry): number {
  const kind = kindOrder(left.kind) - kindOrder(right.kind);

  if (kind !== 0) return kind;
  if (left.name < right.name) return -1;
  if (left.name > right.name) return 1;

  return 0;
}

function kindOrder(kind: FilesEntry["kind"]): number {
  if (kind === "dir") return 0;
  if (kind === "file") return 1;

  return 2;
}

function freezeFilesRequest(request: FilesRequest): FilesRequest {
  const output: {
    op: FilesRequest["op"];
    grant: string;
    path: string;
    data?: string;
  } = {
    grant: request.grant,
    op: request.op,
    path: request.path,
  };

  if (request.data !== undefined) output.data = request.data;

  return Object.freeze(output);
}

async function callFilesPort(
  port: FilesCapabilityPort,
  request: FilesRequest,
  path: string,
): Promise<AppResult<FilesResponse>> {
  let raw: unknown;

  try {
    raw = await port.request(request);
  } catch {
    return reject("FILES_PORT_FAILED", "files capability port failed closed.", path);
  }

  return normalizeFilesPortResponse(raw, path);
}

function normalizeFilesPortResponse(raw: unknown, path: string): AppResult<FilesResponse> {
  const normalized = safeNormalize(raw);

  if (!normalized.ok) {
    return reject("MALFORMED_FILES_RESPONSE", normalized.reason, path);
  }
  if (!isPlainObject(normalized.value)) {
    return reject("MALFORMED_FILES_RESPONSE", "files response must be an object.", path);
  }

  const error = field(normalized.value, "error");

  if (error !== undefined) {
    return normalizeFilesError(error, `${path}/error`);
  }

  return normalizeFilesSuccess(normalized.value, path);
}

function normalizeFilesError(error: PlainJson, path: string): AppResult<FilesResponse> {
  if (!isPlainObject(error)) {
    return reject("MALFORMED_FILES_RESPONSE", "files error must be an object.", path);
  }

  const code = field(error, "code");
  const message = field(error, "message");

  if (typeof code !== "string" || code.length === 0 || typeof message !== "string") {
    return reject("MALFORMED_FILES_RESPONSE", "files error must include code and message.", path);
  }

  return reject(code, message, path);
}

function normalizeFilesSuccess(response: PlainJsonObject, path: string): AppResult<FilesResponse> {
  const entriesValue = field(response, "entries");
  const dataValue = field(response, "data");
  const kindValue = field(response, "kind");
  const sizeValue = field(response, "size");
  const mtimeValue = field(response, "mtime");
  const output: {
    entries?: readonly FilesEntry[];
    data?: string;
    kind?: FilesEntry["kind"];
    size?: number;
    mtime?: string;
  } = {};

  if (entriesValue !== undefined) {
    const entries = normalizeFilesEntries(entriesValue, `${path}/entries`);

    if (!entries.ok) return entries;
    output.entries = entries.value;
  }
  if (dataValue !== undefined) {
    if (typeof dataValue !== "string") {
      return reject("MALFORMED_FILES_RESPONSE", "files data must be a string.", `${path}/data`);
    }
    output.data = dataValue;
  }
  if (kindValue !== undefined) {
    if (!isFilesEntryKind(kindValue)) {
      return reject("MALFORMED_FILES_RESPONSE", "files kind is not supported.", `${path}/kind`);
    }
    output.kind = kindValue;
  }
  if (sizeValue !== undefined) {
    if (!isNonNegativeInteger(sizeValue)) {
      return reject("MALFORMED_FILES_RESPONSE", "files size must be a non-negative integer.", `${path}/size`);
    }
    output.size = sizeValue;
  }
  if (mtimeValue !== undefined) {
    if (typeof mtimeValue !== "string") {
      return reject("MALFORMED_FILES_RESPONSE", "files mtime must be a string.", `${path}/mtime`);
    }
    output.mtime = mtimeValue;
  }

  return accept(Object.freeze(output));
}

function normalizeFilesEntries(value: PlainJson, path: string): AppResult<readonly FilesEntry[]> {
  if (!Array.isArray(value)) {
    return reject("MALFORMED_FILES_RESPONSE", "files entries must be an array.", path);
  }

  const entries: FilesEntry[] = [];

  for (let index = 0; index < value.length; index += 1) {
    const entry = value[index];

    if (entry === undefined || !isPlainObject(entry)) {
      return reject("MALFORMED_FILES_RESPONSE", `files entry ${index} must be an object.`, `${path}/${index}`);
    }

    const normalized = normalizeFilesEntry(entry, `${path}/${index}`);

    if (!normalized.ok) return normalized;
    entries.push(normalized.value);
  }

  return accept(Object.freeze(entries));
}

function normalizeFilesEntry(value: PlainJsonObject, path: string): AppResult<FilesEntry> {
  const name = field(value, "name");
  const kind = field(value, "kind");
  const size = field(value, "size");
  const mtime = field(value, "mtime");

  if (typeof name !== "string" || name.length === 0) {
    return reject("MALFORMED_FILES_RESPONSE", "files entry name must be a non-empty string.", `${path}/name`);
  }
  if (!isFilesEntryKind(kind)) {
    return reject("MALFORMED_FILES_RESPONSE", "files entry kind is not supported.", `${path}/kind`);
  }
  if (!isNonNegativeInteger(size)) {
    return reject("MALFORMED_FILES_RESPONSE", "files entry size must be a non-negative integer.", `${path}/size`);
  }
  if (typeof mtime !== "string") {
    return reject("MALFORMED_FILES_RESPONSE", "files entry mtime must be a string.", `${path}/mtime`);
  }

  return accept(freezeFilesEntry({
    kind,
    mtime,
    name,
    size,
  }));
}

function stateWithSelectedStat(
  state: FileManagerState,
  path: string,
  response: FilesResponse,
): FileManagerState {
  const selected: {
    path: string;
    kind: FilesEntry["kind"];
    size?: number;
    mtime?: string;
  } = {
    kind: response.kind ?? "symlink-skipped",
    path,
  };

  if (response.size !== undefined) selected.size = response.size;
  if (response.mtime !== undefined) selected.mtime = response.mtime;

  return freezeFileManagerState({
    entries: state.entries,
    grant: state.grant,
    path: state.path,
    selected,
    status: "preview",
  });
}

function fileManagerErrorState(
  state: FileManagerState,
  path: string,
  error: AppError,
): FileManagerState {
  return freezeFileManagerState({
    entries: EMPTY_ENTRIES,
    error,
    grant: state.grant,
    path,
    status: error.code === "AccessForbidden" ? "forbidden" : "error",
  });
}

function selectedFileToJson(selected: FileManagerSelectedFile): PlainJsonObject {
  const output: Record<string, PlainJson> = {
    kind: selected.kind,
    path: selected.path,
  };

  if (selected.size !== undefined) output["size"] = selected.size;
  if (selected.mtime !== undefined) output["mtime"] = selected.mtime;
  if (selected.data !== undefined) output["data"] = selected.data;

  return Object.freeze(output);
}

function appErrorToJson(error: AppError): PlainJsonObject {
  return Object.freeze({
    code: error.code,
    message: error.message,
    path: error.path,
  });
}

function windowPayload(
  props: PlainJsonObject,
  appId: string,
  fallbackTitle: string,
): PlainJsonObject {
  const output: Record<string, PlainJson> = {
    appId,
    title: fallbackTitle,
    windowed: true,
  };
  const keys = Object.keys(props).sort(compareStrings);

  for (let index = 0; index < keys.length; index += 1) {
    const key = keys[index];

    if (key !== undefined) output[key] = props[key] ?? null;
  }

  return Object.freeze(output);
}

export function joinCapabilityPath(basePath: string, entryName: string): string {
  if (entryName === "..") return parentCapabilityPath(basePath);
  if (basePath.length === 0 || basePath === ".") return entryName;
  if (basePath === "/") return `/${entryName}`;

  return `${basePath.replace(/\/+$/u, "")}/${entryName}`;
}

export function parentCapabilityPath(path: string): string {
  const trimmed = path.replace(/\/+$/u, "");

  if (trimmed.length === 0 || trimmed === "/") return "/";

  const separator = trimmed.lastIndexOf("/");

  if (separator < 0) return ".";
  if (separator === 0) return "/";

  return trimmed.slice(0, separator);
}

function isPlainObject(value: PlainJson | undefined): value is PlainJsonObject {
  return value !== undefined && value !== null && typeof value === "object" && !Array.isArray(value);
}

function field(value: PlainJsonObject, key: string): PlainJson | undefined {
  if (!Object.hasOwn(value, key)) return undefined;

  return value[key];
}

function isFilesEntryKind(value: PlainJson | undefined): value is FilesEntry["kind"] {
  return value === "dir" || value === "file" || value === "symlink-skipped";
}

function isNonNegativeInteger(value: PlainJson | undefined): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function compareStrings(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;

  return 0;
}

function accept<T>(value: T): AppResult<T> {
  return {
    ok: true,
    value,
  };
}

function reject<T>(code: string, message: string, path: string): AppResult<T> {
  return {
    error: {
      code,
      message,
      path,
    },
    ok: false,
  };
}
