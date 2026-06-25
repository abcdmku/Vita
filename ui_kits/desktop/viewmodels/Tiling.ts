import {
  collectWindowManagerIntents,
  createWindowModel,
  focusNextWindow,
  focusPreviousWindow,
  focusWindow,
  layout,
  moveWindow,
  moveWindowToWorkspace,
  setWorkspaceLayout,
} from "../../../sdk/typescript/src/desktop-sdk/index.ts";
import type {
  LayoutConstraints,
  Rect,
  TextureId,
  WindowId,
  WindowManagerIntent,
  WindowModel,
  WindowPlacement,
  WindowState,
  WorkspaceId,
  WorkspaceLayoutMode,
  WorkspaceState,
} from "../../../sdk/typescript/src/desktop-sdk/index.ts";

export const TILING_LAYOUT_ORDER = Object.freeze([
  "tile",
  "columns",
  "grid",
  "stack",
] satisfies readonly WorkspaceLayoutMode[]);

export const TILING_PANE_IDS = Object.freeze([
  "editor",
  "explorer",
  "system",
] as const);

export type TilingPaneId = typeof TILING_PANE_IDS[number];
export type TilingPaneKind = "editor" | "explorer" | "system";
export type TilingSplitDirection = "down" | "left" | "next" | "prev" | "previous" | "right" | "up";

export interface TilingPaneDefinition {
  readonly id: TilingPaneId;
  readonly kind: TilingPaneKind;
  readonly title: string;
  readonly path: string;
  readonly statusInfo: string;
  readonly windowId: WindowId;
  readonly textureId: TextureId;
}

export interface TilingPaneState extends TilingPaneDefinition {
  readonly focused: boolean;
  readonly mode: "floating" | "tiled";
  readonly rect: Rect;
  readonly visible: boolean;
  readonly workspaceId: WorkspaceId;
  readonly zIndex: number;
}

export interface TilingWorkspaceStatus {
  readonly active: boolean;
  readonly id: WorkspaceId;
  readonly label: string;
  readonly layout: WorkspaceLayoutMode;
}

export interface TilingStatusBarState {
  readonly activeWorkspaceId: WorkspaceId;
  readonly activeWorkspaceIndex: number;
  readonly branch: string;
  readonly focusedPaneId: TilingPaneId | null;
  readonly info: string;
  readonly intentCount: number;
  readonly lastIntentTypes: readonly WindowManagerIntent["type"][];
  readonly layout: WorkspaceLayoutMode;
  readonly path: string;
  readonly workspaceCount: number;
  readonly workspaceSummary: string;
  readonly workspaces: readonly TilingWorkspaceStatus[];
}

export interface TilingViewModelState {
  readonly activePaneId: TilingPaneId | null;
  readonly activeWorkspaceId: WorkspaceId;
  readonly layout: WorkspaceLayoutMode;
  readonly panes: readonly TilingPaneState[];
  readonly placements: readonly WindowPlacement[];
  readonly statusBar: TilingStatusBarState;
}

export type TilingViewModelResult =
  | {
      readonly ok: true;
      readonly intents: readonly WindowManagerIntent[];
      readonly state: TilingViewModelState;
    }
  | {
      readonly ok: false;
      readonly error: TilingViewModelError;
      readonly intents: readonly [];
      readonly state: TilingViewModelState;
    };

export interface TilingViewModelError {
  readonly code:
    | "INVALID_DIRECTION"
    | "INVALID_MOVE_INTENT"
    | "INVALID_PANE"
    | "UNKNOWN_WORKSPACE"
    | "WM_INTENT_FAILED";
  readonly message: string;
  readonly path: string;
}

export interface TilingViewModelOptions {
  readonly wm: TilingWindowManagerPort;
  readonly activeWorkspaceId?: WorkspaceId;
  readonly bounds?: Rect;
  readonly gap?: number;
  readonly initialModel?: WindowModel;
  readonly minHeight?: number;
  readonly minWidth?: number;
  readonly workspaces?: readonly WorkspaceState[];
}

export interface TilingWindowManagerPort {
  repositionTexture(textureId: TextureId, rect: Rect, windowId: WindowId): void;
  setFocus(windowId: WindowId | null): void;
  setTextureVisibility?(textureId: TextureId, visible: boolean, windowId: WindowId): void;
}

type NormalizedMoveWindowIntent =
  | {
      readonly kind: "move";
      readonly paneId?: TilingPaneId;
      readonly rect: Rect;
    }
  | {
      readonly kind: "moveToWorkspace";
      readonly paneId?: TilingPaneId;
      readonly workspaceId: WorkspaceId;
    };

type NormalizeResult<T> =
  | {
      readonly ok: true;
      readonly value: T;
    }
  | {
      readonly ok: false;
      readonly error: TilingViewModelError;
    };

const DEFAULT_BOUNDS = Object.freeze({
  height: 718,
  width: 1_216,
  x: 56,
  y: 48,
}) satisfies Rect;

const DEFAULT_GAP = 8;
const DEFAULT_BRANCH = "main";
const DEFAULT_ACTIVE_WORKSPACE_ID = "workspace-1";

const RECT_FIELDS = Object.freeze(["height", "width", "x", "y"]);
const MOVE_INTENT_FIELDS = Object.freeze(["paneId", "rect", "type", "windowId", "workspaceId"]);

export const TILING_PANES = Object.freeze([
  Object.freeze({
    id: "editor",
    kind: "editor",
    path: "~/vita/src/kernel.ts",
    statusInfo: "TS 5.9 - Ln 4, Col 18 - 10:24",
    textureId: "texture:tiling:editor",
    title: "kernel.ts",
    windowId: "window:tiling:editor",
  }) satisfies TilingPaneDefinition,
  Object.freeze({
    id: "explorer",
    kind: "explorer",
    path: "~/vita/src",
    statusInfo: "Explorer - 6 entries - 10:24",
    textureId: "texture:tiling:explorer",
    title: "EXPLORER",
    windowId: "window:tiling:explorer",
  }) satisfies TilingPaneDefinition,
  Object.freeze({
    id: "system",
    kind: "system",
    path: "~/vita/system",
    statusInfo: "CPU 38% - MEM 52% - NET 7% - 10:24",
    textureId: "texture:tiling:system",
    title: "SYSTEM",
    windowId: "window:tiling:system",
  }) satisfies TilingPaneDefinition,
] satisfies readonly TilingPaneDefinition[]);

export const TILING_WORKSPACES = Object.freeze([
  workspace("workspace-1", "tile"),
  workspace("workspace-2", "tile"),
  workspace("workspace-3", "tile"),
  workspace("workspace-4", "tile"),
  workspace("workspace-5", "tile"),
] satisfies readonly WorkspaceState[]);

export class TilingViewModel {
  readonly #wm: TilingWindowManagerPort;
  readonly #constraints: LayoutConstraints;
  #lastIntents: readonly WindowManagerIntent[] = Object.freeze([]);
  #model: WindowModel;

  constructor(options: TilingViewModelOptions) {
    this.#wm = options.wm;
    this.#constraints = layoutConstraints(options);
    this.#model = options.initialModel ?? createInitialTilingWindowModel(initialModelOptions(options));
  }

  snapshot(): TilingViewModelState {
    return snapshotTilingState(this.#model, this.#constraints, this.#lastIntents);
  }

  focusPane(paneId: unknown): TilingViewModelResult {
    const pane = normalizePaneId(paneId, "/focusPane/id");

    if (!pane.ok) {
      return this.#reject(pane.error);
    }

    return this.#commit(focusWindow(this.#model, paneWindowId(pane.value)));
  }

  cycleLayout(): TilingViewModelResult {
    return this.#commit(setWorkspaceLayout(
      this.#model,
      this.#model.activeWorkspaceId,
      nextLayout(currentWorkspaceLayout(this.#model)),
    ));
  }

  splitFocus(direction: unknown): TilingViewModelResult {
    const normalized = normalizeSplitDirection(direction);

    if (!normalized.ok) {
      return this.#reject(normalized.error);
    }

    const next = normalized.value === "previous"
      ? focusPreviousWindow(this.#model, this.#model.activeWorkspaceId)
      : focusNextWindow(this.#model, this.#model.activeWorkspaceId);

    return this.#commit(next);
  }

  moveWindow(intent: unknown): TilingViewModelResult {
    const normalized = normalizeMoveWindowIntent(intent);

    if (!normalized.ok) {
      return this.#reject(normalized.error);
    }

    const paneId = normalized.value.paneId ?? activePaneId(this.#model, this.#constraints);

    if (paneId === null) {
      return this.#reject(error("INVALID_PANE", "move intent requires a focused or explicit pane.", "/moveWindow/paneId"));
    }

    if (normalized.value.kind === "move") {
      return this.#commit(moveWindow(this.#model, paneWindowId(paneId), normalized.value.rect));
    }

    if (!hasWorkspace(this.#model, normalized.value.workspaceId)) {
      return this.#reject(error(
        "UNKNOWN_WORKSPACE",
        "move intent targets an unknown workspace.",
        "/moveWindow/workspaceId",
      ));
    }

    return this.#commit(moveWindowToWorkspace(this.#model, paneWindowId(paneId), normalized.value.workspaceId));
  }

  #commit(next: WindowModel): TilingViewModelResult {
    const intents = collectWindowManagerIntents(this.#model, next, this.#constraints);

    try {
      emitTilingWindowManagerIntents(this.#wm, intents);
    } catch (caught) {
      return this.#reject(error(
        "WM_INTENT_FAILED",
        errorMessage(caught, "window manager intent failed closed."),
        "/wm",
      ));
    }

    this.#model = next;
    this.#lastIntents = intents;

    return Object.freeze({
      intents,
      ok: true,
      state: this.snapshot(),
    });
  }

  #reject(errorValue: TilingViewModelError): TilingViewModelResult {
    return Object.freeze({
      error: errorValue,
      intents: Object.freeze([]) as readonly [],
      ok: false,
      state: this.snapshot(),
    });
  }
}

export function createTilingViewModel(options: TilingViewModelOptions): TilingViewModel {
  return new TilingViewModel(options);
}

export function createInitialTilingWindowModel(options: {
  readonly activeWorkspaceId?: WorkspaceId;
  readonly workspaces?: readonly WorkspaceState[];
} = Object.freeze({})): WindowModel {
  const activeWorkspaceId = options.activeWorkspaceId ?? DEFAULT_ACTIVE_WORKSPACE_ID;
  const workspaces = options.workspaces ?? TILING_WORKSPACES;
  const windows = TILING_PANES.map((pane, index) => paneWindow(pane, activeWorkspaceId, index));

  return createWindowModel({
    activeWorkspaceId,
    focusStack: Object.freeze([
      paneWindowId("editor"),
      paneWindowId("system"),
      paneWindowId("explorer"),
    ]),
    windows,
    workspaces,
  });
}

function snapshotTilingState(
  model: WindowModel,
  constraints: LayoutConstraints,
  lastIntents: readonly WindowManagerIntent[],
): TilingViewModelState {
  const activeConstraints = constraintsForModel(constraints, model);
  const placements = layout(model, activeConstraints);
  const active = activePaneIdFromPlacements(placements);
  const workspaceLayout = currentWorkspaceLayout(model);
  const panes = TILING_PANES.map((pane) => paneState(pane, model, placements));

  return Object.freeze({
    activePaneId: active,
    activeWorkspaceId: model.activeWorkspaceId,
    layout: workspaceLayout,
    panes: Object.freeze(panes),
    placements,
    statusBar: statusBarState(model, workspaceLayout, active, lastIntents),
  });
}

function paneState(
  pane: TilingPaneDefinition,
  model: WindowModel,
  placements: readonly WindowPlacement[],
): TilingPaneState {
  const windowState = findWindow(model, pane.windowId);
  const placement = findPlacement(placements, pane.windowId);
  const fallbackRect = windowState?.rect ?? DEFAULT_BOUNDS;

  return Object.freeze({
    ...pane,
    focused: placement?.focused ?? false,
    mode: windowState?.mode ?? "tiled",
    rect: placement?.rect ?? fallbackRect,
    visible: placement !== undefined,
    workspaceId: windowState?.workspaceId ?? model.activeWorkspaceId,
    zIndex: placement?.zIndex ?? -1,
  });
}

function statusBarState(
  model: WindowModel,
  workspaceLayout: WorkspaceLayoutMode,
  active: TilingPaneId | null,
  lastIntents: readonly WindowManagerIntent[],
): TilingStatusBarState {
  const workspaceStatuses = workspaceStatus(model);
  const activeIndex = activeWorkspaceIndex(model);
  const activePane = active === null ? undefined : paneDefinition(active);
  const path = activePane?.path ?? "~/vita";
  const info = activePane?.statusInfo ?? "No focused pane - 10:24";
  const lastIntentTypes = lastIntents.map((intent) => intent.type);
  const workspaceCount = model.workspaces.length;

  return Object.freeze({
    activeWorkspaceId: model.activeWorkspaceId,
    activeWorkspaceIndex: activeIndex,
    branch: DEFAULT_BRANCH,
    focusedPaneId: active,
    info,
    intentCount: lastIntents.length,
    lastIntentTypes: Object.freeze(lastIntentTypes),
    layout: workspaceLayout,
    path,
    workspaceCount,
    workspaceSummary: `ws ${activeIndex}/${workspaceCount}`,
    workspaces: workspaceStatuses,
  });
}

function workspaceStatus(model: WindowModel): readonly TilingWorkspaceStatus[] {
  const output: TilingWorkspaceStatus[] = [];

  for (let index = 0; index < model.workspaces.length; index += 1) {
    const current = model.workspaces[index];

    if (current === undefined) {
      continue;
    }

    output.push(Object.freeze({
      active: current.id === model.activeWorkspaceId,
      id: current.id,
      label: workspaceLabel(current.id, index),
      layout: current.layout,
    }) satisfies TilingWorkspaceStatus);
  }

  return Object.freeze(output);
}

function workspaceLabel(workspaceId: WorkspaceId, index: number): string {
  const suffix = workspaceId.slice("workspace-".length);

  if (workspaceId.startsWith("workspace-") && suffix.length > 0) {
    return suffix;
  }

  return `${index + 1}`;
}

function activeWorkspaceIndex(model: WindowModel): number {
  for (let index = 0; index < model.workspaces.length; index += 1) {
    if (model.workspaces[index]?.id === model.activeWorkspaceId) {
      return index + 1;
    }
  }

  return 0;
}

function currentWorkspaceLayout(model: WindowModel): WorkspaceLayoutMode {
  for (let index = 0; index < model.workspaces.length; index += 1) {
    const current = model.workspaces[index];

    if (current !== undefined && current.id === model.activeWorkspaceId) {
      return current.layout;
    }
  }

  return "tile";
}

function nextLayout(current: WorkspaceLayoutMode): WorkspaceLayoutMode {
  for (let index = 0; index < TILING_LAYOUT_ORDER.length; index += 1) {
    if (TILING_LAYOUT_ORDER[index] === current) {
      const nextIndex = (index + 1) % TILING_LAYOUT_ORDER.length;
      return TILING_LAYOUT_ORDER[nextIndex] ?? "tile";
    }
  }

  return TILING_LAYOUT_ORDER[0] ?? "tile";
}

function activePaneId(model: WindowModel, constraints: LayoutConstraints): TilingPaneId | null {
  return activePaneIdFromPlacements(layout(model, constraintsForModel(constraints, model)));
}

function activePaneIdFromPlacements(placements: readonly WindowPlacement[]): TilingPaneId | null {
  for (let index = 0; index < placements.length; index += 1) {
    const placement = placements[index];

    if (placement !== undefined && placement.focused) {
      return paneIdForWindowId(placement.windowId);
    }
  }

  return null;
}

function paneWindow(pane: TilingPaneDefinition, workspaceId: WorkspaceId, order: number): WindowState {
  return Object.freeze({
    id: pane.windowId,
    maximized: false,
    minimized: false,
    mode: "tiled",
    order,
    rect: DEFAULT_BOUNDS,
    textureId: pane.textureId,
    workspaceId,
  }) satisfies WindowState;
}

function paneWindowId(paneId: TilingPaneId): WindowId {
  return paneDefinition(paneId).windowId;
}

function paneDefinition(paneId: TilingPaneId): TilingPaneDefinition {
  for (let index = 0; index < TILING_PANES.length; index += 1) {
    const pane = TILING_PANES[index];

    if (pane !== undefined && pane.id === paneId) {
      return pane;
    }
  }

  return TILING_PANES[0] ?? {
    id: "editor",
    kind: "editor",
    path: "~/vita/src/kernel.ts",
    statusInfo: "TS 5.9 - Ln 4, Col 18 - 10:24",
    textureId: "texture:tiling:editor",
    title: "kernel.ts",
    windowId: "window:tiling:editor",
  };
}

function paneIdForWindowId(windowId: WindowId): TilingPaneId | null {
  for (let index = 0; index < TILING_PANES.length; index += 1) {
    const pane = TILING_PANES[index];

    if (pane !== undefined && pane.windowId === windowId) {
      return pane.id;
    }
  }

  return null;
}

function findWindow(model: WindowModel, windowId: WindowId): WindowState | undefined {
  for (let index = 0; index < model.windows.length; index += 1) {
    const current = model.windows[index];

    if (current !== undefined && current.id === windowId) {
      return current;
    }
  }

  return undefined;
}

function findPlacement(
  placements: readonly WindowPlacement[],
  windowId: WindowId,
): WindowPlacement | undefined {
  for (let index = 0; index < placements.length; index += 1) {
    const current = placements[index];

    if (current !== undefined && current.windowId === windowId) {
      return current;
    }
  }

  return undefined;
}

function hasWorkspace(model: WindowModel, workspaceId: WorkspaceId): boolean {
  for (let index = 0; index < model.workspaces.length; index += 1) {
    if (model.workspaces[index]?.id === workspaceId) {
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

function layoutConstraints(options: TilingViewModelOptions): LayoutConstraints {
  const output: {
    bounds: Rect;
    gap?: number;
    minHeight?: number;
    minWidth?: number;
  } = {
    bounds: freezeRect(options.bounds ?? DEFAULT_BOUNDS),
    gap: options.gap ?? DEFAULT_GAP,
  };

  if (options.minHeight !== undefined) {
    output.minHeight = options.minHeight;
  }
  if (options.minWidth !== undefined) {
    output.minWidth = options.minWidth;
  }

  return Object.freeze(output);
}

function initialModelOptions(options: TilingViewModelOptions): {
  readonly activeWorkspaceId?: WorkspaceId;
  readonly workspaces?: readonly WorkspaceState[];
} {
  const output: {
    activeWorkspaceId?: WorkspaceId;
    workspaces?: readonly WorkspaceState[];
  } = {};

  if (options.activeWorkspaceId !== undefined) {
    output.activeWorkspaceId = options.activeWorkspaceId;
  }
  if (options.workspaces !== undefined) {
    output.workspaces = options.workspaces;
  }

  return Object.freeze(output);
}

function constraintsForModel(
  constraints: LayoutConstraints,
  model: WindowModel,
): LayoutConstraints {
  const output: {
    bounds: Rect;
    gap?: number;
    minHeight?: number;
    minWidth?: number;
    workspaceId: WorkspaceId;
  } = {
    bounds: constraints.bounds,
    workspaceId: model.activeWorkspaceId,
  };

  if (constraints.gap !== undefined) {
    output.gap = constraints.gap;
  }
  if (constraints.minHeight !== undefined) {
    output.minHeight = constraints.minHeight;
  }
  if (constraints.minWidth !== undefined) {
    output.minWidth = constraints.minWidth;
  }

  return Object.freeze(output);
}

function freezeRect(rect: Rect): Rect {
  return Object.freeze({
    height: rect.height,
    width: rect.width,
    x: rect.x,
    y: rect.y,
  });
}

function normalizePaneId(input: unknown, path: string): NormalizeResult<TilingPaneId> {
  if (typeof input !== "string") {
    return reject(error("INVALID_PANE", "pane id must be a known tiling pane.", path));
  }

  for (let index = 0; index < TILING_PANE_IDS.length; index += 1) {
    const paneId = TILING_PANE_IDS[index];

    if (paneId !== undefined && input === paneId) {
      return accept(paneId);
    }
  }

  return reject(error("INVALID_PANE", "pane id must be a known tiling pane.", path));
}

function emitTilingWindowManagerIntents(
  port: TilingWindowManagerPort,
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

function normalizeSplitDirection(input: unknown): NormalizeResult<"next" | "previous"> {
  if (
    input === "left" ||
    input === "prev" ||
    input === "previous" ||
    input === "up"
  ) {
    return accept("previous");
  }
  if (input === "down" || input === "next" || input === "right") {
    return accept("next");
  }

  return reject(error("INVALID_DIRECTION", "split direction is not supported.", "/splitFocus/dir"));
}

function normalizeMoveWindowIntent(input: unknown): NormalizeResult<NormalizedMoveWindowIntent> {
  const object = snapshotObject(input, MOVE_INTENT_FIELDS, "/moveWindow");

  if (!object.ok) {
    return reject(object.error);
  }

  const type = object.value.get("type");

  if (typeof type !== "string") {
    return reject(error("INVALID_MOVE_INTENT", "move intent type must be a string.", "/moveWindow/type"));
  }

  const pane = normalizeOptionalMovePane(object.value);

  if (!pane.ok) {
    return reject(pane.error);
  }

  if (type === "move" || type === "moveResize" || type === "moveWindow" || type === "resize") {
    const rect = normalizeRect(object.value.get("rect"), "/moveWindow/rect");

    if (!rect.ok) {
      return reject(rect.error);
    }

    const output: {
      kind: "move";
      paneId?: TilingPaneId;
      rect: Rect;
    } = {
      kind: "move",
      rect: rect.value,
    };

    if (pane.value !== undefined) {
      output.paneId = pane.value;
    }

    return accept(Object.freeze(output));
  }

  if (type === "moveToWorkspace" || type === "move-to-workspace") {
    const workspaceId = object.value.get("workspaceId");

    if (typeof workspaceId !== "string" || workspaceId.length === 0) {
      return reject(error(
        "INVALID_MOVE_INTENT",
        "move-to-workspace intent requires a non-empty workspaceId.",
        "/moveWindow/workspaceId",
      ));
    }

    const output: {
      kind: "moveToWorkspace";
      paneId?: TilingPaneId;
      workspaceId: WorkspaceId;
    } = {
      kind: "moveToWorkspace",
      workspaceId,
    };

    if (pane.value !== undefined) {
      output.paneId = pane.value;
    }

    return accept(Object.freeze(output));
  }

  return reject(error("INVALID_MOVE_INTENT", "move intent type is not supported.", "/moveWindow/type"));
}

function normalizeOptionalMovePane(
  object: ReadonlyMap<string, unknown>,
): NormalizeResult<TilingPaneId | undefined> {
  const paneId = object.get("paneId");
  const windowId = object.get("windowId");
  let normalizedPane: TilingPaneId | undefined;

  if (paneId !== undefined) {
    const normalized = normalizePaneId(paneId, "/moveWindow/paneId");

    if (!normalized.ok) {
      return normalized;
    }

    normalizedPane = normalized.value;
  }

  if (windowId !== undefined) {
    if (typeof windowId !== "string") {
      return reject(error("INVALID_MOVE_INTENT", "windowId must identify a tiling pane.", "/moveWindow/windowId"));
    }

    const byWindow = paneIdForWindowId(windowId);

    if (byWindow === null) {
      return reject(error("INVALID_MOVE_INTENT", "windowId must identify a tiling pane.", "/moveWindow/windowId"));
    }
    if (normalizedPane !== undefined && normalizedPane !== byWindow) {
      return reject(error("INVALID_MOVE_INTENT", "paneId and windowId disagree.", "/moveWindow/windowId"));
    }

    normalizedPane = byWindow;
  }

  return accept(normalizedPane);
}

function normalizeRect(input: unknown, path: string): NormalizeResult<Rect> {
  const object = snapshotObject(input, RECT_FIELDS, path);

  if (!object.ok) {
    return reject(object.error);
  }

  const x = finiteNumber(object.value.get("x"));
  const y = finiteNumber(object.value.get("y"));
  const width = positiveFiniteNumber(object.value.get("width"));
  const height = positiveFiniteNumber(object.value.get("height"));

  if (x === null) {
    return reject(error("INVALID_MOVE_INTENT", "rect x must be finite.", `${path}/x`));
  }
  if (y === null) {
    return reject(error("INVALID_MOVE_INTENT", "rect y must be finite.", `${path}/y`));
  }
  if (width === null) {
    return reject(error("INVALID_MOVE_INTENT", "rect width must be positive and finite.", `${path}/width`));
  }
  if (height === null) {
    return reject(error("INVALID_MOVE_INTENT", "rect height must be positive and finite.", `${path}/height`));
  }

  return accept(Object.freeze({
    height,
    width,
    x,
    y,
  }));
}

function snapshotObject(
  input: unknown,
  allowedKeys: readonly string[],
  path: string,
): NormalizeResult<ReadonlyMap<string, unknown>> {
  try {
    if (input === null || typeof input !== "object" || Array.isArray(input)) {
      return reject(error("INVALID_MOVE_INTENT", "value must be a plain object.", path));
    }

    const prototype = Object.getPrototypeOf(input);

    if (prototype !== Object.prototype && prototype !== null) {
      return reject(error("INVALID_MOVE_INTENT", "value must be a plain object.", path));
    }

    const keys = Reflect.ownKeys(input);
    const output = new Map<string, unknown>();

    for (let index = 0; index < keys.length; index += 1) {
      const key = keys[index];

      if (key === undefined || typeof key === "symbol" || !contains(allowedKeys, key)) {
        return reject(error("INVALID_MOVE_INTENT", "object contains an unsupported field.", path));
      }

      const descriptor = Object.getOwnPropertyDescriptor(input, key);

      if (descriptor === undefined || !isDataDescriptor(descriptor) || descriptor.enumerable !== true) {
        return reject(error("INVALID_MOVE_INTENT", "object must contain only enumerable data fields.", path));
      }

      output.set(key, descriptor.value);
    }

    return accept(output);
  } catch {
    return reject(error("INVALID_MOVE_INTENT", "value must be a stable plain object.", path));
  }
}

function contains(values: readonly string[], value: string): boolean {
  for (let index = 0; index < values.length; index += 1) {
    if (values[index] === value) {
      return true;
    }
  }

  return false;
}

function isDataDescriptor(descriptor: PropertyDescriptor): descriptor is PropertyDescriptor & {
  readonly value: unknown;
} {
  return Object.prototype.hasOwnProperty.call(descriptor, "value");
}

function finiteNumber(input: unknown): number | null {
  return typeof input === "number" && Number.isFinite(input) ? input : null;
}

function positiveFiniteNumber(input: unknown): number | null {
  return typeof input === "number" && Number.isFinite(input) && input > 0 ? input : null;
}

function error(
  code: TilingViewModelError["code"],
  message: string,
  path: string,
): TilingViewModelError {
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

function accept<T>(value: T): NormalizeResult<T> {
  return {
    ok: true,
    value,
  };
}

function reject<T>(errorValue: TilingViewModelError): NormalizeResult<T> {
  return {
    error: errorValue,
    ok: false,
  };
}
