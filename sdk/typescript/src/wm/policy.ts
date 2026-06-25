export type WindowId = string;
export type WorkspaceId = string;
export type TextureId = string;

export type WorkspaceLayoutMode = "tile" | "stack";
export type WindowMode = "tiled" | "floating";

export interface Rect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface WorkspaceState {
  readonly id: WorkspaceId;
  readonly layout: WorkspaceLayoutMode;
}

export interface WindowState {
  readonly id: WindowId;
  readonly textureId: TextureId;
  readonly workspaceId: WorkspaceId;
  readonly rect: Rect;
  readonly mode: WindowMode;
  readonly minimized: boolean;
  readonly maximized: boolean;
  readonly order: number;
}

export interface WindowModel {
  readonly windows: readonly WindowState[];
  readonly workspaces: readonly WorkspaceState[];
  readonly activeWorkspaceId: WorkspaceId;
  /**
   * Most-recent focus first. Layout filters this stack by workspace and
   * visibility, so moving a focused window to another workspace does not leak
   * focus into the currently active workspace.
   */
  readonly focusStack: readonly WindowId[];
}

export interface CreateWindowModelOptions {
  readonly workspaces?: readonly WorkspaceState[];
  readonly activeWorkspaceId?: WorkspaceId;
  readonly windows?: readonly WindowState[];
  readonly focusStack?: readonly WindowId[];
}

export interface WindowOpenRequest {
  readonly id: WindowId;
  readonly textureId?: TextureId;
  readonly workspaceId?: WorkspaceId;
  readonly rect?: Rect;
  readonly mode?: WindowMode;
  readonly minimized?: boolean;
  readonly maximized?: boolean;
}

export interface LayoutConstraints {
  readonly bounds: Rect;
  readonly workspaceId?: WorkspaceId;
  readonly gap?: number;
  readonly minWidth?: number;
  readonly minHeight?: number;
}

export interface WindowPlacement {
  readonly windowId: WindowId;
  readonly textureId: TextureId;
  readonly workspaceId: WorkspaceId;
  readonly rect: Rect;
  readonly focused: boolean;
  readonly visible: true;
  readonly zIndex: number;
}

export type WindowManagerIntent =
  | {
      readonly type: "repositionTexture";
      readonly windowId: WindowId;
      readonly textureId: TextureId;
      readonly rect: Rect;
    }
  | {
      readonly type: "setFocus";
      readonly windowId: WindowId | null;
    }
  | {
      readonly type: "setTextureVisibility";
      readonly windowId: WindowId;
      readonly textureId: TextureId;
      readonly visible: boolean;
    };

export interface WindowManagerSubstratePort {
  repositionTexture(textureId: TextureId, rect: Rect, windowId: WindowId): void;
  setFocus(windowId: WindowId | null): void;
  setTextureVisibility?(textureId: TextureId, visible: boolean, windowId: WindowId): void;
}

export type WindowManagerEvent =
  | {
      readonly type: "open";
      readonly window: WindowOpenRequest;
    }
  | {
      readonly type: "close";
      readonly windowId: WindowId;
    }
  | {
      readonly type: "focus";
      readonly windowId: WindowId;
    }
  | {
      readonly type: "moveResize";
      readonly windowId: WindowId;
      readonly rect: Rect;
    }
  | {
      readonly type: "move";
      readonly windowId: WindowId;
      readonly rect: Rect;
    }
  | {
      readonly type: "resize";
      readonly windowId: WindowId;
      readonly rect: Rect;
    }
  | {
      readonly type: "switchWorkspace";
      readonly workspaceId: WorkspaceId;
    }
  | {
      readonly type: "moveToWorkspace";
      readonly windowId: WindowId;
      readonly workspaceId: WorkspaceId;
    }
  | {
      readonly type: "setWorkspaceLayout";
      readonly workspaceId?: WorkspaceId;
      readonly layout: WorkspaceLayoutMode;
    }
  | {
      readonly type: "setLayout";
      readonly workspaceId?: WorkspaceId;
      readonly layout: WorkspaceLayoutMode;
    }
  | {
      readonly type: "tile";
      readonly workspaceId?: WorkspaceId;
    }
  | {
      readonly type: "stack";
      readonly workspaceId?: WorkspaceId;
    }
  | {
      readonly type: "minimize";
      readonly windowId: WindowId;
      readonly minimized?: boolean;
    }
  | {
      readonly type: "maximize";
      readonly windowId: WindowId;
      readonly maximized?: boolean;
    };

const DEFAULT_WORKSPACE_ID = "workspace-1";
const DEFAULT_RECT = Object.freeze({
  height: 480,
  width: 640,
  x: 0,
  y: 0,
}) satisfies Rect;

export function createWindowModel(options: CreateWindowModelOptions = {}): WindowModel {
  const workspaces = normalizeWorkspaces(options.workspaces);
  const firstWorkspace = workspaces[0];
  const requestedActive = options.activeWorkspaceId;
  const activeWorkspaceId = requestedActive !== undefined
    ? requestedActive
    : firstWorkspace?.id ?? DEFAULT_WORKSPACE_ID;
  const withActive = hasWorkspace(workspaces, activeWorkspaceId)
    ? workspaces
    : freezeWorkspaces([
      ...workspaces,
      freezeWorkspace({
        id: activeWorkspaceId,
        layout: "tile",
      }),
    ]);
  const windows = normalizeWindows(options.windows, activeWorkspaceId);

  return freezeModel({
    activeWorkspaceId,
    focusStack: normalizeFocusStack(windows, options.focusStack),
    windows,
    workspaces: withActive,
  });
}

export function reduceWindowModel(
  model: WindowModel,
  event: WindowManagerEvent,
): WindowModel {
  switch (event.type) {
    case "open":
      return openWindow(model, event.window);
    case "close":
      return closeWindow(model, event.windowId);
    case "focus":
      return focusWindow(model, event.windowId);
    case "move":
    case "moveResize":
    case "resize":
      return requestMoveResize(model, event.windowId, event.rect);
    case "switchWorkspace":
      return switchWorkspace(model, event.workspaceId);
    case "moveToWorkspace":
      return moveWindowToWorkspace(model, event.windowId, event.workspaceId);
    case "setLayout":
    case "setWorkspaceLayout":
      return setWorkspaceLayout(model, event.workspaceId ?? model.activeWorkspaceId, event.layout);
    case "tile":
      return setWorkspaceLayout(model, event.workspaceId ?? model.activeWorkspaceId, "tile");
    case "stack":
      return setWorkspaceLayout(model, event.workspaceId ?? model.activeWorkspaceId, "stack");
    case "minimize":
      return minimizeWindow(model, event.windowId, event.minimized ?? true);
    case "maximize":
      return maximizeWindow(model, event.windowId, event.maximized ?? true);
  }
}

export const reduceWindowManagerEvent = reduceWindowModel;

export function openWindow(model: WindowModel, request: WindowOpenRequest): WindowModel {
  const workspaceId = request.workspaceId ?? model.activeWorkspaceId;
  const workspaces = ensureWorkspace(model.workspaces, workspaceId);
  const existing = findWindow(model.windows, request.id);
  const rect = freezeRect(request.rect ?? existing?.rect ?? DEFAULT_RECT);
  const mode = request.mode ?? existing?.mode ?? "tiled";
  const minimized = request.minimized ?? false;
  const maximized = request.maximized ?? false;
  const opened: WindowState = freezeWindow({
    id: request.id,
    maximized,
    minimized,
    mode,
    order: existing?.order ?? nextWindowOrder(model.windows),
    rect,
    textureId: request.textureId ?? existing?.textureId ?? request.id,
    workspaceId,
  });
  const windows = replaceWindow(model.windows, opened);
  const focusStack = minimized
    ? normalizeFocusStack(windows, model.focusStack)
    : focusFirst(windows, model.focusStack, opened.id);

  return freezeModel({
    activeWorkspaceId: model.activeWorkspaceId,
    focusStack,
    windows,
    workspaces,
  });
}

export function closeWindow(model: WindowModel, windowId: WindowId): WindowModel {
  if (findWindow(model.windows, windowId) === undefined) {
    return model;
  }

  const windows = model.windows.filter((window) => window.id !== windowId);

  return freezeModel({
    activeWorkspaceId: model.activeWorkspaceId,
    focusStack: normalizeFocusStack(windows, model.focusStack.filter((id) => id !== windowId)),
    windows: freezeWindows(windows),
    workspaces: model.workspaces,
  });
}

export function focusWindow(model: WindowModel, windowId: WindowId): WindowModel {
  const target = findWindow(model.windows, windowId);

  if (target === undefined) {
    return model;
  }

  const windows = replaceWindow(model.windows, freezeWindow({
    ...target,
    minimized: false,
  }));

  return freezeModel({
    activeWorkspaceId: target.workspaceId,
    focusStack: focusFirst(windows, model.focusStack, windowId),
    windows,
    workspaces: ensureWorkspace(model.workspaces, target.workspaceId),
  });
}

export function requestMoveResize(
  model: WindowModel,
  windowId: WindowId,
  rect: Rect,
): WindowModel {
  const target = findWindow(model.windows, windowId);

  if (target === undefined) {
    return model;
  }

  const windows = replaceWindow(model.windows, freezeWindow({
    ...target,
    maximized: false,
    mode: "floating",
    rect: freezeRect(rect),
  }));

  return freezeModel({
    activeWorkspaceId: model.activeWorkspaceId,
    focusStack: focusFirst(windows, model.focusStack, windowId),
    windows,
    workspaces: model.workspaces,
  });
}

export const moveResizeWindow = requestMoveResize;
export const moveWindow = requestMoveResize;
export const resizeWindow = requestMoveResize;

export function switchWorkspace(
  model: WindowModel,
  workspaceId: WorkspaceId,
): WindowModel {
  return freezeModel({
    activeWorkspaceId: workspaceId,
    focusStack: normalizeFocusStack(model.windows, model.focusStack),
    windows: model.windows,
    workspaces: ensureWorkspace(model.workspaces, workspaceId),
  });
}

export function moveWindowToWorkspace(
  model: WindowModel,
  windowId: WindowId,
  workspaceId: WorkspaceId,
): WindowModel {
  const target = findWindow(model.windows, windowId);

  if (target === undefined) {
    return model;
  }

  const windows = replaceWindow(model.windows, freezeWindow({
    ...target,
    workspaceId,
  }));

  return freezeModel({
    activeWorkspaceId: model.activeWorkspaceId,
    focusStack: focusFirst(windows, model.focusStack, windowId),
    windows,
    workspaces: ensureWorkspace(model.workspaces, workspaceId),
  });
}

export function setWorkspaceLayout(
  model: WindowModel,
  workspaceId: WorkspaceId,
  layoutMode: WorkspaceLayoutMode,
): WindowModel {
  const workspaces = ensureWorkspace(model.workspaces, workspaceId).map((workspace) => {
    if (workspace.id !== workspaceId) {
      return workspace;
    }

    return freezeWorkspace({
      ...workspace,
      layout: layoutMode,
    });
  });

  return freezeModel({
    activeWorkspaceId: model.activeWorkspaceId,
    focusStack: model.focusStack,
    windows: model.windows,
    workspaces: freezeWorkspaces(workspaces),
  });
}

export function tileWorkspace(model: WindowModel, workspaceId = model.activeWorkspaceId): WindowModel {
  return setWorkspaceLayout(model, workspaceId, "tile");
}

export function stackWorkspace(model: WindowModel, workspaceId = model.activeWorkspaceId): WindowModel {
  return setWorkspaceLayout(model, workspaceId, "stack");
}

export function minimizeWindow(
  model: WindowModel,
  windowId: WindowId,
  minimized = true,
): WindowModel {
  const target = findWindow(model.windows, windowId);

  if (target === undefined) {
    return model;
  }

  const windows = replaceWindow(model.windows, freezeWindow({
    ...target,
    minimized,
  }));

  return freezeModel({
    activeWorkspaceId: model.activeWorkspaceId,
    focusStack: minimized
      ? normalizeFocusStack(windows, model.focusStack)
      : focusFirst(windows, model.focusStack, windowId),
    windows,
    workspaces: model.workspaces,
  });
}

export function maximizeWindow(
  model: WindowModel,
  windowId: WindowId,
  maximized = true,
): WindowModel {
  const target = findWindow(model.windows, windowId);

  if (target === undefined) {
    return model;
  }

  const windows = model.windows.map((window) => {
    if (window.id === windowId) {
      return freezeWindow({
        ...window,
        maximized,
        minimized: false,
      });
    }
    if (maximized && window.workspaceId === target.workspaceId && window.maximized) {
      return freezeWindow({
        ...window,
        maximized: false,
      });
    }

    return window;
  });

  return freezeModel({
    activeWorkspaceId: model.activeWorkspaceId,
    focusStack: maximized
      ? focusFirst(windows, model.focusStack, windowId)
      : normalizeFocusStack(windows, model.focusStack),
    windows: freezeWindows(windows),
    workspaces: model.workspaces,
  });
}

export function layout(
  model: WindowModel,
  constraints: LayoutConstraints,
): readonly WindowPlacement[] {
  const workspaceId = constraints.workspaceId ?? model.activeWorkspaceId;
  const workspace = findWorkspace(model.workspaces, workspaceId);

  if (workspace === undefined) {
    return Object.freeze([]);
  }

  const bounds = freezeRect(constraints.bounds);
  const gap = normalizeDimension(constraints.gap ?? 0);
  const visible = windowsForWorkspace(model.windows, workspaceId, true);
  const focusedId = focusedWindowIdForWorkspace(model, workspaceId);
  const zIndexes = zIndexByWindowId(model, visible);
  const rects = layoutRects(visible, workspace.layout, bounds, gap, constraints);
  const placements: WindowPlacement[] = [];

  for (let index = 0; index < visible.length; index += 1) {
    const window = visible[index];

    if (window === undefined) {
      continue;
    }

    const rect = rects.get(window.id);
    const zIndex = zIndexes.get(window.id);

    if (rect === undefined || zIndex === undefined) {
      continue;
    }

    placements.push(Object.freeze({
      focused: window.id === focusedId,
      rect,
      textureId: window.textureId,
      visible: true,
      windowId: window.id,
      workspaceId: window.workspaceId,
      zIndex,
    }) satisfies WindowPlacement);
  }

  placements.sort(comparePlacements);
  return Object.freeze(placements);
}

export function focusedWindowId(model: WindowModel): WindowId | null {
  return focusedWindowIdForWorkspace(model, model.activeWorkspaceId);
}

export function collectWindowManagerIntents(
  previous: WindowModel,
  next: WindowModel,
  constraints: LayoutConstraints,
): readonly WindowManagerIntent[] {
  const previousPlacements = layout(previous, constraints);
  const nextPlacements = layout(next, constraints);
  const previousByWindowId = placementsByWindowId(previousPlacements);
  const nextByWindowId = placementsByWindowId(nextPlacements);
  const intents: WindowManagerIntent[] = [];

  for (let index = 0; index < previousPlacements.length; index += 1) {
    const placement = previousPlacements[index];

    if (placement !== undefined && !nextByWindowId.has(placement.windowId)) {
      intents.push(Object.freeze({
        textureId: placement.textureId,
        type: "setTextureVisibility",
        visible: false,
        windowId: placement.windowId,
      }) satisfies WindowManagerIntent);
    }
  }

  for (let index = 0; index < nextPlacements.length; index += 1) {
    const placement = nextPlacements[index];

    if (placement === undefined) {
      continue;
    }

    const previousPlacement = previousByWindowId.get(placement.windowId);

    if (previousPlacement === undefined) {
      intents.push(Object.freeze({
        textureId: placement.textureId,
        type: "setTextureVisibility",
        visible: true,
        windowId: placement.windowId,
      }) satisfies WindowManagerIntent);
      intents.push(repositionIntent(placement));
      continue;
    }

    if (!sameRect(previousPlacement.rect, placement.rect)) {
      intents.push(repositionIntent(placement));
    }
  }

  const previousFocus = focusedWindowId(previous);
  const nextFocus = focusedWindowId(next);

  if (previousFocus !== nextFocus) {
    intents.push(Object.freeze({
      type: "setFocus",
      windowId: nextFocus,
    }) satisfies WindowManagerIntent);
  }

  return Object.freeze(intents);
}

export const computeWindowManagerIntents = collectWindowManagerIntents;

export function emitWindowManagerIntents(
  port: WindowManagerSubstratePort,
  intents: readonly WindowManagerIntent[],
): void {
  for (let index = 0; index < intents.length; index += 1) {
    const intent = intents[index];

    if (intent === undefined) {
      continue;
    }

    switch (intent.type) {
      case "repositionTexture":
        port.repositionTexture(intent.textureId, intent.rect, intent.windowId);
        break;
      case "setFocus":
        port.setFocus(intent.windowId);
        break;
      case "setTextureVisibility":
        if (port.setTextureVisibility !== undefined) {
          port.setTextureVisibility(intent.textureId, intent.visible, intent.windowId);
        }
        break;
    }
  }
}

export function applyWindowManagerEvent(
  port: WindowManagerSubstratePort,
  model: WindowModel,
  event: WindowManagerEvent,
  constraints: LayoutConstraints,
): {
  readonly model: WindowModel;
  readonly intents: readonly WindowManagerIntent[];
} {
  const next = reduceWindowModel(model, event);
  const intents = collectWindowManagerIntents(model, next, constraints);
  emitWindowManagerIntents(port, intents);

  return Object.freeze({
    intents,
    model: next,
  });
}

function layoutRects(
  windows: readonly WindowState[],
  layoutMode: WorkspaceLayoutMode,
  bounds: Rect,
  gap: number,
  constraints: LayoutConstraints,
): ReadonlyMap<WindowId, Rect> {
  const rects = new Map<WindowId, Rect>();
  const maximized = windows.filter((window) => window.maximized);
  const rest = windows.filter((window) => !window.maximized);
  const tiled = rest.filter((window) => window.mode === "tiled");
  const floating = rest.filter((window) => window.mode === "floating");
  const tiledRects = layoutMode === "stack"
    ? stackRects(tiled, bounds, gap)
    : tileRects(tiled, bounds, gap);

  for (const [windowId, rect] of tiledRects) {
    rects.set(windowId, rect);
  }

  for (let index = 0; index < floating.length; index += 1) {
    const window = floating[index];

    if (window !== undefined) {
      rects.set(window.id, fitRect(window.rect, bounds, constraints));
    }
  }

  for (let index = 0; index < maximized.length; index += 1) {
    const window = maximized[index];

    if (window !== undefined) {
      rects.set(window.id, bounds);
    }
  }

  return rects;
}

function tileRects(
  windows: readonly WindowState[],
  bounds: Rect,
  gap: number,
): ReadonlyMap<WindowId, Rect> {
  const rects = new Map<WindowId, Rect>();

  if (windows.length === 0) {
    return rects;
  }

  const content = insetRect(bounds, gap);
  const first = windows[0];

  if (first === undefined) {
    return rects;
  }

  if (windows.length === 1) {
    rects.set(first.id, content);
    return rects;
  }

  const splitGap = Math.min(gap, content.width);
  const masterWidth = Math.floor((content.width - splitGap) / 2);
  const stackWidth = Math.max(0, content.width - splitGap - masterWidth);
  rects.set(first.id, freezeRect({
    height: content.height,
    width: masterWidth,
    x: content.x,
    y: content.y,
  }));

  const stackWindows = windows.slice(1);
  const stackRects = verticalSplitRects(
    freezeRect({
      height: content.height,
      width: stackWidth,
      x: content.x + masterWidth + splitGap,
      y: content.y,
    }),
    stackWindows.length,
    gap,
  );

  for (let index = 0; index < stackWindows.length; index += 1) {
    const window = stackWindows[index];
    const rect = stackRects[index];

    if (window !== undefined && rect !== undefined) {
      rects.set(window.id, rect);
    }
  }

  return rects;
}

function stackRects(
  windows: readonly WindowState[],
  bounds: Rect,
  gap: number,
): ReadonlyMap<WindowId, Rect> {
  const rects = new Map<WindowId, Rect>();
  const content = insetRect(bounds, gap);

  for (let index = 0; index < windows.length; index += 1) {
    const window = windows[index];

    if (window !== undefined) {
      rects.set(window.id, content);
    }
  }

  return rects;
}

function verticalSplitRects(bounds: Rect, count: number, gap: number): readonly Rect[] {
  if (count <= 0) {
    return Object.freeze([]);
  }

  const splitGap = count === 1 ? 0 : Math.min(gap, Math.floor(bounds.height / (count - 1)));
  const available = Math.max(0, bounds.height - splitGap * (count - 1));
  const base = Math.floor(available / count);
  const extra = available - base * count;
  const rects: Rect[] = [];
  let y = bounds.y;

  for (let index = 0; index < count; index += 1) {
    const height = base + (index < extra ? 1 : 0);
    rects.push(freezeRect({
      height,
      width: bounds.width,
      x: bounds.x,
      y,
    }));
    y += height + splitGap;
  }

  return Object.freeze(rects);
}

function zIndexByWindowId(
  model: WindowModel,
  windows: readonly WindowState[],
): ReadonlyMap<WindowId, number> {
  const visibleIds = new Set<WindowId>();

  for (let index = 0; index < windows.length; index += 1) {
    const window = windows[index];

    if (window !== undefined) {
      visibleIds.add(window.id);
    }
  }

  const ordered: WindowId[] = [];
  const seen = new Set<WindowId>();

  for (let index = 0; index < windows.length; index += 1) {
    const window = windows[index];

    if (window !== undefined && !seen.has(window.id) && !model.focusStack.includes(window.id)) {
      ordered.push(window.id);
      seen.add(window.id);
    }
  }

  for (let index = model.focusStack.length - 1; index >= 0; index -= 1) {
    const windowId = model.focusStack[index];

    if (windowId !== undefined && visibleIds.has(windowId) && !seen.has(windowId)) {
      ordered.push(windowId);
      seen.add(windowId);
    }
  }

  const zIndexes = new Map<WindowId, number>();

  for (let index = 0; index < ordered.length; index += 1) {
    const windowId = ordered[index];

    if (windowId !== undefined) {
      zIndexes.set(windowId, index);
    }
  }

  return zIndexes;
}

function focusedWindowIdForWorkspace(
  model: WindowModel,
  workspaceId: WorkspaceId,
): WindowId | null {
  for (let index = 0; index < model.focusStack.length; index += 1) {
    const windowId = model.focusStack[index];

    if (windowId === undefined) {
      continue;
    }

    const window = findWindow(model.windows, windowId);

    if (window !== undefined && isVisibleOnWorkspace(window, workspaceId)) {
      return window.id;
    }
  }

  const windows = windowsForWorkspace(model.windows, workspaceId, true);
  const last = windows[windows.length - 1];

  return last?.id ?? null;
}

function windowsForWorkspace(
  windows: readonly WindowState[],
  workspaceId: WorkspaceId,
  visibleOnly: boolean,
): readonly WindowState[] {
  const output = windows.filter((window) => {
    if (window.workspaceId !== workspaceId) {
      return false;
    }

    return !visibleOnly || !window.minimized;
  });

  output.sort(compareWindows);
  return Object.freeze(output);
}

function normalizeWorkspaces(workspaces: readonly WorkspaceState[] | undefined): readonly WorkspaceState[] {
  if (workspaces === undefined || workspaces.length === 0) {
    return freezeWorkspaces([
      freezeWorkspace({
        id: DEFAULT_WORKSPACE_ID,
        layout: "tile",
      }),
    ]);
  }

  const output: WorkspaceState[] = [];

  for (let index = 0; index < workspaces.length; index += 1) {
    const workspace = workspaces[index];

    if (workspace !== undefined && !hasWorkspace(output, workspace.id)) {
      output.push(freezeWorkspace(workspace));
    }
  }

  return output.length === 0
    ? normalizeWorkspaces(undefined)
    : freezeWorkspaces(output);
}

function normalizeWindows(
  windows: readonly WindowState[] | undefined,
  fallbackWorkspaceId: WorkspaceId,
): readonly WindowState[] {
  if (windows === undefined) {
    return Object.freeze([]);
  }

  const output: WindowState[] = [];

  for (let index = 0; index < windows.length; index += 1) {
    const window = windows[index];

    if (window === undefined || findWindow(output, window.id) !== undefined) {
      continue;
    }

    output.push(freezeWindow({
      ...window,
      order: Number.isSafeInteger(window.order) ? window.order : index,
      rect: freezeRect(window.rect),
      workspaceId: window.workspaceId.length === 0 ? fallbackWorkspaceId : window.workspaceId,
    }));
  }

  output.sort(compareWindows);
  return freezeWindows(output);
}

function normalizeFocusStack(
  windows: readonly WindowState[],
  focusStack: readonly WindowId[] | undefined,
): readonly WindowId[] {
  const output: WindowId[] = [];
  const seen = new Set<WindowId>();

  if (focusStack !== undefined) {
    for (let index = 0; index < focusStack.length; index += 1) {
      const windowId = focusStack[index];

      if (windowId !== undefined && !seen.has(windowId) && findWindow(windows, windowId) !== undefined) {
        output.push(windowId);
        seen.add(windowId);
      }
    }
  }

  const byRecentOpen = [...windows].sort((left, right) => compareWindows(right, left));

  for (let index = 0; index < byRecentOpen.length; index += 1) {
    const window = byRecentOpen[index];

    if (window !== undefined && !seen.has(window.id)) {
      output.push(window.id);
      seen.add(window.id);
    }
  }

  return Object.freeze(output);
}

function focusFirst(
  windows: readonly WindowState[],
  current: readonly WindowId[],
  windowId: WindowId,
): readonly WindowId[] {
  return normalizeFocusStack(windows, [
    windowId,
    ...current.filter((id) => id !== windowId),
  ]);
}

function ensureWorkspace(
  workspaces: readonly WorkspaceState[],
  workspaceId: WorkspaceId,
): readonly WorkspaceState[] {
  if (hasWorkspace(workspaces, workspaceId)) {
    return workspaces;
  }

  return freezeWorkspaces([
    ...workspaces,
    freezeWorkspace({
      id: workspaceId,
      layout: "tile",
    }),
  ]);
}

function hasWorkspace(
  workspaces: readonly WorkspaceState[],
  workspaceId: WorkspaceId,
): boolean {
  for (let index = 0; index < workspaces.length; index += 1) {
    if (workspaces[index]?.id === workspaceId) {
      return true;
    }
  }

  return false;
}

function findWorkspace(
  workspaces: readonly WorkspaceState[],
  workspaceId: WorkspaceId,
): WorkspaceState | undefined {
  for (let index = 0; index < workspaces.length; index += 1) {
    const workspace = workspaces[index];

    if (workspace !== undefined && workspace.id === workspaceId) {
      return workspace;
    }
  }

  return undefined;
}

function findWindow(
  windows: readonly WindowState[],
  windowId: WindowId,
): WindowState | undefined {
  for (let index = 0; index < windows.length; index += 1) {
    const window = windows[index];

    if (window !== undefined && window.id === windowId) {
      return window;
    }
  }

  return undefined;
}

function replaceWindow(
  windows: readonly WindowState[],
  nextWindow: WindowState,
): readonly WindowState[] {
  let replaced = false;
  const next = windows.map((window) => {
    if (window.id !== nextWindow.id) {
      return window;
    }

    replaced = true;
    return nextWindow;
  });

  if (!replaced) {
    next.push(nextWindow);
  }

  next.sort(compareWindows);
  return freezeWindows(next);
}

function nextWindowOrder(windows: readonly WindowState[]): number {
  let next = 0;

  for (let index = 0; index < windows.length; index += 1) {
    const order = windows[index]?.order;

    if (order !== undefined && order >= next) {
      next = order + 1;
    }
  }

  return next;
}

function placementsByWindowId(
  placements: readonly WindowPlacement[],
): ReadonlyMap<WindowId, WindowPlacement> {
  const output = new Map<WindowId, WindowPlacement>();

  for (let index = 0; index < placements.length; index += 1) {
    const placement = placements[index];

    if (placement !== undefined) {
      output.set(placement.windowId, placement);
    }
  }

  return output;
}

function repositionIntent(placement: WindowPlacement): WindowManagerIntent {
  return Object.freeze({
    rect: placement.rect,
    textureId: placement.textureId,
    type: "repositionTexture",
    windowId: placement.windowId,
  }) satisfies WindowManagerIntent;
}

function isVisibleOnWorkspace(window: WindowState, workspaceId: WorkspaceId): boolean {
  return window.workspaceId === workspaceId && !window.minimized;
}

function fitRect(rect: Rect, bounds: Rect, constraints: LayoutConstraints): Rect {
  const minWidth = normalizeDimension(constraints.minWidth ?? 1);
  const minHeight = normalizeDimension(constraints.minHeight ?? 1);
  const width = Math.min(Math.max(normalizeDimension(rect.width), minWidth), bounds.width);
  const height = Math.min(Math.max(normalizeDimension(rect.height), minHeight), bounds.height);
  const maxX = bounds.x + bounds.width - width;
  const maxY = bounds.y + bounds.height - height;

  return freezeRect({
    height,
    width,
    x: clamp(normalizeNumber(rect.x), bounds.x, maxX),
    y: clamp(normalizeNumber(rect.y), bounds.y, maxY),
  });
}

function insetRect(rect: Rect, inset: number): Rect {
  const safeInset = Math.min(
    Math.max(0, inset),
    Math.floor(Math.min(rect.width, rect.height) / 2),
  );

  return freezeRect({
    height: Math.max(0, rect.height - safeInset * 2),
    width: Math.max(0, rect.width - safeInset * 2),
    x: rect.x + safeInset,
    y: rect.y + safeInset,
  });
}

function sameRect(left: Rect, right: Rect): boolean {
  return (
    left.x === right.x &&
    left.y === right.y &&
    left.width === right.width &&
    left.height === right.height
  );
}

function freezeModel(model: WindowModel): WindowModel {
  return Object.freeze({
    activeWorkspaceId: model.activeWorkspaceId,
    focusStack: Object.freeze([...model.focusStack]),
    windows: freezeWindows(model.windows),
    workspaces: freezeWorkspaces(model.workspaces),
  });
}

function freezeWindows(windows: readonly WindowState[]): readonly WindowState[] {
  return Object.freeze(windows.map(freezeWindow));
}

function freezeWindow(window: WindowState): WindowState {
  return Object.freeze({
    id: window.id,
    maximized: window.maximized,
    minimized: window.minimized,
    mode: window.mode,
    order: normalizeDimension(window.order),
    rect: freezeRect(window.rect),
    textureId: window.textureId,
    workspaceId: window.workspaceId,
  });
}

function freezeWorkspaces(workspaces: readonly WorkspaceState[]): readonly WorkspaceState[] {
  return Object.freeze(workspaces.map(freezeWorkspace));
}

function freezeWorkspace(workspace: WorkspaceState): WorkspaceState {
  return Object.freeze({
    id: workspace.id,
    layout: workspace.layout,
  });
}

function freezeRect(rect: Rect): Rect {
  return Object.freeze({
    height: normalizeDimension(rect.height),
    width: normalizeDimension(rect.width),
    x: normalizeNumber(rect.x),
    y: normalizeNumber(rect.y),
  });
}

function normalizeDimension(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0;
}

function normalizeNumber(value: number): number {
  return Number.isFinite(value) ? Math.trunc(value) : 0;
}

function clamp(value: number, min: number, max: number): number {
  if (max < min) {
    return min;
  }
  if (value < min) {
    return min;
  }
  if (value > max) {
    return max;
  }

  return value;
}

function compareWindows(left: WindowState, right: WindowState): number {
  const order = left.order - right.order;

  if (order !== 0) {
    return order;
  }

  return compareStrings(left.id, right.id);
}

function comparePlacements(left: WindowPlacement, right: WindowPlacement): number {
  const zIndex = left.zIndex - right.zIndex;

  if (zIndex !== 0) {
    return zIndex;
  }

  return compareStrings(left.windowId, right.windowId);
}

function compareStrings(left: string, right: string): number {
  if (left < right) {
    return -1;
  }
  if (left > right) {
    return 1;
  }

  return 0;
}
