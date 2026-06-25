import {
  createWindowModel,
  moveWindowToWorkspace as sdkMoveWindowToWorkspace,
  switchWorkspace as sdkSwitchWorkspace,
} from "../../../sdk/typescript/src/desktop-sdk/index.ts";
import type {
  WindowId,
  WindowModel,
  WindowMode,
  WindowState,
  TextureId,
  WorkspaceId,
  WorkspaceLayoutMode,
  WorkspaceState,
} from "../../../sdk/typescript/src/desktop-sdk/index.ts";

export interface WorkspacesWindowSummary {
  readonly id: WindowId;
  readonly textureId: TextureId;
  readonly mode: WindowMode;
  readonly minimized: boolean;
  readonly maximized: boolean;
  readonly order: number;
}

export interface WorkspacesWorkspaceState {
  readonly active: boolean;
  readonly id: WorkspaceId;
  readonly index: number;
  readonly layout: WorkspaceLayoutMode;
  readonly name: string;
  readonly position: number;
  readonly windowCount: number;
  readonly windowIds: readonly WindowId[];
  readonly windows: readonly WorkspacesWindowSummary[];
}

export interface WorkspacesViewModelState {
  readonly activeWorkspaceId: WorkspaceId;
  readonly activeWorkspaceIndex: number;
  readonly activeWorkspacePosition: number;
  readonly workspaceCount: number;
  readonly windowCount: number;
  readonly workspaces: readonly WorkspacesWorkspaceState[];
}

export interface WorkspacesViewModelError {
  readonly code:
    | "CANNOT_REMOVE_LAST_WORKSPACE"
    | "INVALID_WINDOW_ID"
    | "INVALID_WORKSPACE_ID"
    | "INVALID_WORKSPACE_NAME"
    | "UNKNOWN_WINDOW"
    | "UNKNOWN_WORKSPACE"
    | "WM_COMMIT_FAILED"
    | "WM_READ_FAILED";
  readonly message: string;
  readonly path: string;
}

export type WorkspacesViewModelResult =
  | {
      readonly ok: true;
      readonly state: WorkspacesViewModelState;
    }
  | {
      readonly ok: false;
      readonly error: WorkspacesViewModelError;
      readonly state: WorkspacesViewModelState;
    };

export interface WorkspacesWindowManagerPortError {
  readonly code: string;
  readonly message: string;
  readonly path: string;
}

export type WorkspacesWindowManagerPortResult<T> =
  | {
      readonly ok: true;
      readonly value: T;
    }
  | {
      readonly ok: false;
      readonly error: WorkspacesWindowManagerPortError;
    };

export interface WorkspacesWindowManagerPort {
  readWindowModel(): WorkspacesWindowManagerPortResult<WindowModel>;
  applyWindowModel(model: WindowModel): WorkspacesWindowManagerPortResult<WindowModel>;
}

export interface WorkspacesViewModelOptions {
  readonly wm: WorkspacesWindowManagerPort;
  readonly defaultLayout?: WorkspaceLayoutMode;
}

type NormalizeResult<T> =
  | {
      readonly ok: true;
      readonly value: T;
    }
  | {
      readonly ok: false;
      readonly error: WorkspacesViewModelError;
    };

const DEFAULT_LAYOUT = "tile" satisfies WorkspaceLayoutMode;
const WORKSPACE_ID_PREFIX = "workspace-";

export class WorkspacesViewModel {
  readonly #wm: WorkspacesWindowManagerPort;
  readonly #defaultLayout: WorkspaceLayoutMode;
  #lastKnownModel: WindowModel;
  #names = new Map<WorkspaceId, string>();

  constructor(options: WorkspacesViewModelOptions) {
    this.#wm = options.wm;
    this.#defaultLayout = options.defaultLayout ?? DEFAULT_LAYOUT;

    const initial = readWindowModel(options.wm);

    this.#lastKnownModel = initial.ok ? initial.value : createWindowModel();
  }

  snapshot(): WorkspacesViewModelState {
    const read = readWindowModel(this.#wm);

    if (read.ok) {
      this.#lastKnownModel = read.value;
    }

    return workspacesState(this.#lastKnownModel, this.#names);
  }

  create(): WorkspacesViewModelResult {
    const current = this.#readForAction();

    if (!current.ok) {
      return this.#reject(current.error);
    }

    const newWorkspaceId = nextWorkspaceId(current.value);
    const nextWorkspaces: WorkspaceState[] = [];

    for (let index = 0; index < current.value.workspaces.length; index += 1) {
      const workspace = current.value.workspaces[index];

      if (workspace !== undefined) {
        nextWorkspaces.push(workspace);
      }
    }

    nextWorkspaces.push(workspace(newWorkspaceId, this.#defaultLayout));

    const next = createWindowModel({
      activeWorkspaceId: newWorkspaceId,
      focusStack: current.value.focusStack,
      windows: current.value.windows,
      workspaces: Object.freeze(nextWorkspaces),
    });
    const names = new Map(this.#names);

    names.set(newWorkspaceId, defaultWorkspaceName(newWorkspaceId, nextWorkspaces.length - 1));

    return this.#commit(next, names);
  }

  remove(id: unknown): WorkspacesViewModelResult {
    const workspaceId = normalizeWorkspaceId(id, "/remove/id");

    if (!workspaceId.ok) {
      return this.#reject(workspaceId.error);
    }

    const current = this.#readForAction();

    if (!current.ok) {
      return this.#reject(current.error);
    }

    const removeIndex = workspaceIndex(current.value, workspaceId.value);

    if (removeIndex < 0) {
      return this.#reject(error(
        "UNKNOWN_WORKSPACE",
        "workspace id is not managed by the window manager.",
        "/remove/id",
      ), current.value);
    }
    if (current.value.workspaces.length <= 1) {
      return this.#reject(error(
        "CANNOT_REMOVE_LAST_WORKSPACE",
        "at least one workspace must remain.",
        "/remove/id",
      ), current.value);
    }

    const fallbackWorkspaceId = fallbackWorkspace(current.value, removeIndex);

    if (fallbackWorkspaceId === null) {
      return this.#reject(error(
        "CANNOT_REMOVE_LAST_WORKSPACE",
        "at least one workspace must remain.",
        "/remove/id",
      ), current.value);
    }

    const next = removeWorkspace(current.value, workspaceId.value, fallbackWorkspaceId);
    const names = new Map(this.#names);

    names.delete(workspaceId.value);

    return this.#commit(next, names);
  }

  switch(id: unknown): WorkspacesViewModelResult {
    const workspaceId = normalizeWorkspaceId(id, "/switch/id");

    if (!workspaceId.ok) {
      return this.#reject(workspaceId.error);
    }

    const current = this.#readForAction();

    if (!current.ok) {
      return this.#reject(current.error);
    }
    if (!hasWorkspace(current.value, workspaceId.value)) {
      return this.#reject(error(
        "UNKNOWN_WORKSPACE",
        "workspace id is not managed by the window manager.",
        "/switch/id",
      ), current.value);
    }

    return this.#commit(sdkSwitchWorkspace(current.value, workspaceId.value));
  }

  rename(id: unknown, name: unknown): WorkspacesViewModelResult {
    const workspaceId = normalizeWorkspaceId(id, "/rename/id");

    if (!workspaceId.ok) {
      return this.#reject(workspaceId.error);
    }

    const normalizedName = normalizeWorkspaceName(name, "/rename/name");

    if (!normalizedName.ok) {
      return this.#reject(normalizedName.error);
    }

    const current = this.#readForAction();

    if (!current.ok) {
      return this.#reject(current.error);
    }
    if (!hasWorkspace(current.value, workspaceId.value)) {
      return this.#reject(error(
        "UNKNOWN_WORKSPACE",
        "workspace id is not managed by the window manager.",
        "/rename/id",
      ), current.value);
    }

    this.#names.set(workspaceId.value, normalizedName.value);
    this.#lastKnownModel = current.value;

    return acceptAction(workspacesState(current.value, this.#names));
  }

  moveWindowToWorkspace(windowId: unknown, id: unknown): WorkspacesViewModelResult {
    const normalizedWindowId = normalizeWindowId(windowId, "/moveWindowToWorkspace/windowId");

    if (!normalizedWindowId.ok) {
      return this.#reject(normalizedWindowId.error);
    }

    const workspaceId = normalizeWorkspaceId(id, "/moveWindowToWorkspace/id");

    if (!workspaceId.ok) {
      return this.#reject(workspaceId.error);
    }

    const current = this.#readForAction();

    if (!current.ok) {
      return this.#reject(current.error);
    }
    if (!hasWorkspace(current.value, workspaceId.value)) {
      return this.#reject(error(
        "UNKNOWN_WORKSPACE",
        "workspace id is not managed by the window manager.",
        "/moveWindowToWorkspace/id",
      ), current.value);
    }
    if (!hasWindow(current.value, normalizedWindowId.value)) {
      return this.#reject(error(
        "UNKNOWN_WINDOW",
        "window id is not managed by the window manager.",
        "/moveWindowToWorkspace/windowId",
      ), current.value);
    }

    return this.#commit(sdkMoveWindowToWorkspace(current.value, normalizedWindowId.value, workspaceId.value));
  }

  #readForAction(): NormalizeResult<WindowModel> {
    const read = readWindowModel(this.#wm);

    if (!read.ok) {
      return reject(error("WM_READ_FAILED", read.error.message, read.error.path));
    }

    this.#lastKnownModel = read.value;

    return accept(read.value);
  }

  #commit(next: WindowModel, names?: ReadonlyMap<WorkspaceId, string>): WorkspacesViewModelResult {
    const applied = applyWindowModel(this.#wm, next);

    if (!applied.ok) {
      return this.#reject(error("WM_COMMIT_FAILED", applied.error.message, applied.error.path));
    }

    if (names !== undefined) {
      this.#names = new Map(names);
    }

    this.#lastKnownModel = applied.value;

    return acceptAction(workspacesState(applied.value, this.#names));
  }

  #reject(errorValue: WorkspacesViewModelError, model = this.#lastKnownModel): WorkspacesViewModelResult {
    return Object.freeze({
      error: errorValue,
      ok: false,
      state: workspacesState(model, this.#names),
    });
  }
}

export function createWorkspacesViewModel(options: WorkspacesViewModelOptions): WorkspacesViewModel {
  return new WorkspacesViewModel(options);
}

function workspacesState(
  model: WindowModel,
  names: ReadonlyMap<WorkspaceId, string>,
): WorkspacesViewModelState {
  const workspaces: WorkspacesWorkspaceState[] = [];
  let activeWorkspaceIndex = -1;
  let windowCount = 0;

  for (let index = 0; index < model.workspaces.length; index += 1) {
    const current = model.workspaces[index];

    if (current === undefined) {
      continue;
    }

    const active = current.id === model.activeWorkspaceId;
    const windows = windowsForWorkspace(model.windows, current.id);
    const windowIds = windowIdsFor(windows);

    if (active) {
      activeWorkspaceIndex = workspaces.length;
    }

    windowCount += windows.length;
    workspaces.push(Object.freeze({
      active,
      id: current.id,
      index: workspaces.length,
      layout: current.layout,
      name: names.get(current.id) ?? defaultWorkspaceName(current.id, workspaces.length),
      position: workspaces.length + 1,
      windowCount: windows.length,
      windowIds,
      windows,
    }));
  }

  return Object.freeze({
    activeWorkspaceId: model.activeWorkspaceId,
    activeWorkspaceIndex,
    activeWorkspacePosition: activeWorkspaceIndex < 0 ? 0 : activeWorkspaceIndex + 1,
    windowCount,
    workspaceCount: workspaces.length,
    workspaces: Object.freeze(workspaces),
  });
}

function windowsForWorkspace(
  windows: readonly WindowState[],
  workspaceId: WorkspaceId,
): readonly WorkspacesWindowSummary[] {
  const output: WorkspacesWindowSummary[] = [];

  for (let index = 0; index < windows.length; index += 1) {
    const current = windows[index];

    if (current !== undefined && current.workspaceId === workspaceId) {
      output.push(Object.freeze({
        id: current.id,
        maximized: current.maximized,
        minimized: current.minimized,
        mode: current.mode,
        order: current.order,
        textureId: current.textureId,
      }));
    }
  }

  output.sort(compareWindowSummaries);

  return Object.freeze(output);
}

function windowIdsFor(windows: readonly WorkspacesWindowSummary[]): readonly WindowId[] {
  const output: WindowId[] = [];

  for (let index = 0; index < windows.length; index += 1) {
    const window = windows[index];

    if (window !== undefined) {
      output.push(window.id);
    }
  }

  return Object.freeze(output);
}

function removeWorkspace(
  model: WindowModel,
  removedWorkspaceId: WorkspaceId,
  fallbackWorkspaceId: WorkspaceId,
): WindowModel {
  const nextWorkspaces: WorkspaceState[] = [];
  const nextWindows: WindowState[] = [];

  for (let index = 0; index < model.workspaces.length; index += 1) {
    const current = model.workspaces[index];

    if (current !== undefined && current.id !== removedWorkspaceId) {
      nextWorkspaces.push(current);
    }
  }

  for (let index = 0; index < model.windows.length; index += 1) {
    const current = model.windows[index];

    if (current === undefined) {
      continue;
    }

    if (current.workspaceId === removedWorkspaceId) {
      nextWindows.push(Object.freeze({
        ...current,
        workspaceId: fallbackWorkspaceId,
      }));
    } else {
      nextWindows.push(current);
    }
  }

  return createWindowModel({
    activeWorkspaceId: model.activeWorkspaceId === removedWorkspaceId
      ? fallbackWorkspaceId
      : model.activeWorkspaceId,
    focusStack: model.focusStack,
    windows: Object.freeze(nextWindows),
    workspaces: Object.freeze(nextWorkspaces),
  });
}

function fallbackWorkspace(model: WindowModel, removeIndex: number): WorkspaceId | null {
  for (let index = removeIndex + 1; index < model.workspaces.length; index += 1) {
    const workspaceState = model.workspaces[index];

    if (workspaceState !== undefined) {
      return workspaceState.id;
    }
  }

  for (let index = removeIndex - 1; index >= 0; index -= 1) {
    const workspaceState = model.workspaces[index];

    if (workspaceState !== undefined) {
      return workspaceState.id;
    }
  }

  return null;
}

function nextWorkspaceId(model: WindowModel): WorkspaceId {
  let nextNumber = 1;

  for (let index = 0; index < model.workspaces.length; index += 1) {
    const current = model.workspaces[index];

    if (current === undefined) {
      continue;
    }

    const suffix = workspaceNumericSuffix(current.id);

    if (suffix !== null && suffix >= nextNumber) {
      nextNumber = suffix + 1;
    }
  }

  let candidate = `${WORKSPACE_ID_PREFIX}${nextNumber}`;

  while (hasWorkspace(model, candidate)) {
    nextNumber += 1;
    candidate = `${WORKSPACE_ID_PREFIX}${nextNumber}`;
  }

  return candidate;
}

function workspaceNumericSuffix(id: WorkspaceId): number | null {
  if (!id.startsWith(WORKSPACE_ID_PREFIX)) {
    return null;
  }

  const suffix = id.slice(WORKSPACE_ID_PREFIX.length);

  if (suffix.length === 0) {
    return null;
  }

  for (let index = 0; index < suffix.length; index += 1) {
    const code = suffix.charCodeAt(index);

    if (code < 48 || code > 57) {
      return null;
    }
  }

  const parsed = Number(suffix);

  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function defaultWorkspaceName(id: WorkspaceId, index: number): string {
  const suffix = workspaceNumericSuffix(id);

  return suffix === null ? `Workspace ${index + 1}` : `Workspace ${suffix}`;
}

function hasWorkspace(model: WindowModel, workspaceId: WorkspaceId): boolean {
  return workspaceIndex(model, workspaceId) >= 0;
}

function workspaceIndex(model: WindowModel, workspaceId: WorkspaceId): number {
  for (let index = 0; index < model.workspaces.length; index += 1) {
    if (model.workspaces[index]?.id === workspaceId) {
      return index;
    }
  }

  return -1;
}

function hasWindow(model: WindowModel, windowId: WindowId): boolean {
  for (let index = 0; index < model.windows.length; index += 1) {
    if (model.windows[index]?.id === windowId) {
      return true;
    }
  }

  return false;
}

function workspace(id: WorkspaceId, layoutMode: WorkspaceLayoutMode): WorkspaceState {
  return Object.freeze({
    id,
    layout: layoutMode,
  });
}

function normalizeWorkspaceId(input: unknown, path: string): NormalizeResult<WorkspaceId> {
  if (typeof input !== "string" || input.length === 0) {
    return reject(error("INVALID_WORKSPACE_ID", "workspace id must be a non-empty string.", path));
  }

  return accept(input);
}

function normalizeWindowId(input: unknown, path: string): NormalizeResult<WindowId> {
  if (typeof input !== "string" || input.length === 0) {
    return reject(error("INVALID_WINDOW_ID", "window id must be a non-empty string.", path));
  }

  return accept(input);
}

function normalizeWorkspaceName(input: unknown, path: string): NormalizeResult<string> {
  if (typeof input !== "string") {
    return reject(error("INVALID_WORKSPACE_NAME", "workspace name must be a non-empty string.", path));
  }

  const trimmed = input.trim();

  if (trimmed.length === 0) {
    return reject(error("INVALID_WORKSPACE_NAME", "workspace name must be a non-empty string.", path));
  }

  return accept(trimmed);
}

function readWindowModel(
  port: WorkspacesWindowManagerPort,
): WorkspacesWindowManagerPortResult<WindowModel> {
  try {
    return port.readWindowModel();
  } catch (caught) {
    return rejectPort("WM_READ_THROWN", errorMessage(caught, "window manager read failed closed."), "/wm/read");
  }
}

function applyWindowModel(
  port: WorkspacesWindowManagerPort,
  model: WindowModel,
): WorkspacesWindowManagerPortResult<WindowModel> {
  try {
    return port.applyWindowModel(model);
  } catch (caught) {
    return rejectPort("WM_COMMIT_THROWN", errorMessage(caught, "window manager commit failed closed."), "/wm/apply");
  }
}

function compareWindowSummaries(left: WorkspacesWindowSummary, right: WorkspacesWindowSummary): number {
  const order = left.order - right.order;

  if (order !== 0) {
    return order;
  }

  return compareStrings(left.id, right.id);
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function error(
  code: WorkspacesViewModelError["code"],
  message: string,
  path: string,
): WorkspacesViewModelError {
  return Object.freeze({
    code,
    message,
    path,
  });
}

function errorMessage(caught: unknown, fallback: string): string {
  if (caught instanceof Error && caught.message.length > 0) {
    return caught.message;
  }

  return fallback;
}

function acceptAction(state: WorkspacesViewModelState): WorkspacesViewModelResult {
  return Object.freeze({
    ok: true,
    state,
  });
}

function accept<T>(value: T): NormalizeResult<T> {
  return {
    ok: true,
    value,
  };
}

function reject<T>(errorValue: WorkspacesViewModelError): NormalizeResult<T> {
  return {
    error: errorValue,
    ok: false,
  };
}

function rejectPort<T>(
  code: string,
  message: string,
  path: string,
): WorkspacesWindowManagerPortResult<T> {
  return {
    error: Object.freeze({
      code,
      message,
      path,
    }),
    ok: false,
  };
}
