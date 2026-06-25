import {
  closeWindow as sdkCloseWindow,
  createWindowModel,
  focusWindow as sdkFocusWindow,
  moveWindowToWorkspace as sdkMoveWindowToWorkspace,
} from "../../../sdk/typescript/src/desktop-sdk/index.ts";
import type {
  Rect,
  TextureId,
  WindowId,
  WindowManagerEvent,
  WindowModel,
  WindowState,
  WorkspaceId,
  WorkspaceState,
} from "../../../sdk/typescript/src/desktop-sdk/index.ts";

export interface StageCellRect {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

export interface StageSourceSize {
  readonly width: number;
  readonly height: number;
}

export interface StageWindowDescription {
  readonly appId: string;
  readonly title: string;
}

export interface StageCell {
  readonly appId: string;
  readonly rect: StageCellRect;
  readonly sourceRect: Rect;
  readonly title: string;
  readonly windowId: WindowId;
}

export interface StageWorkspaceGroup {
  readonly cells: readonly StageCell[];
  readonly label: string;
  readonly workspaceId: WorkspaceId;
}

export interface StageFocusedCell {
  readonly workspaceId: WorkspaceId;
  readonly windowId: WindowId;
}

export interface StageCompositorTexture {
  readonly textureId: TextureId;
  readonly sourceW: number;
  readonly sourceH: number;
}

export interface StageCompositorPort {
  resolveWindowTexture(windowId: WindowId): StageCompositorTexture | null | undefined;
}

export interface StageRenderPlanEntry {
  readonly cellRect: StageCellRect;
  readonly placeholder: boolean;
  readonly sourceSize: StageSourceSize | null;
  readonly textureId: TextureId | null;
  readonly windowId: WindowId;
}

export interface StageRenderPlanUpdate {
  readonly after: StageRenderPlanEntry;
  readonly before: StageRenderPlanEntry;
}

export interface StageRenderPlanDiff {
  readonly added: readonly StageRenderPlanEntry[];
  readonly removed: readonly StageRenderPlanEntry[];
  readonly updated: readonly StageRenderPlanUpdate[];
}

export interface StageViewModelState {
  readonly focusedCell: StageFocusedCell | null;
  readonly overviewOpen: boolean;
  readonly renderPlan: readonly StageRenderPlanEntry[];
  readonly workspaces: readonly StageWorkspaceGroup[];
}

export type StageWindowManagerIntent =
  | Extract<WindowManagerEvent, { readonly type: "close" | "focus" | "moveToWorkspace" }>
  | {
      readonly type: "activate";
      readonly windowId: WindowId;
    };

export interface StageViewModelError {
  readonly code:
    | "INVALID_DIRECTION"
    | "INVALID_WINDOW"
    | "INVALID_WORKSPACE"
    | "WM_INTENT_FAILED"
    | "WM_READ_FAILED";
  readonly message: string;
  readonly path: string;
}

export type StageViewModelResult =
  | {
      readonly intents: readonly StageWindowManagerIntent[];
      readonly ok: true;
      readonly state: StageViewModelState;
    }
  | {
      readonly error: StageViewModelError;
      readonly intents: readonly [];
      readonly ok: false;
      readonly state: StageViewModelState;
    };

export interface StageWindowManagerPortError {
  readonly code: string;
  readonly message: string;
  readonly path: string;
}

export type StageWindowManagerPortResult<T> =
  | {
      readonly ok: true;
      readonly value: T;
    }
  | {
      readonly error: StageWindowManagerPortError;
      readonly ok: false;
    };

export interface StageWindowManagerPort {
  applyWindowManagerIntents(
    intents: readonly StageWindowManagerIntent[],
  ): StageWindowManagerPortResult<WindowModel>;
  readWindowModel(): StageWindowManagerPortResult<WindowModel>;
}

export type StageWindowDescriber = (
  window: WindowState,
) => StageWindowDescription | null | undefined;

export type StageWorkspaceLabeler = (
  workspace: WorkspaceState,
  index: number,
) => string | null | undefined;

export interface StageViewModelOptions {
  readonly bounds?: StageCellRect;
  readonly cellGap?: number;
  readonly cellHeight?: number;
  readonly cellWidth?: number;
  readonly columns?: number;
  readonly compositorPort?: StageCompositorPort;
  readonly describeWindow?: StageWindowDescriber;
  readonly initialModel?: WindowModel;
  readonly labelWorkspace?: StageWorkspaceLabeler;
  readonly labelHeight?: number;
  readonly wm: StageWindowManagerPort;
  readonly workspaceGap?: number;
}

type NormalizeResult<T> =
  | {
      readonly ok: true;
      readonly value: T;
    }
  | {
      readonly error: StageViewModelError;
      readonly ok: false;
    };

type StageNavigationDirection = "down" | "left" | "right" | "up";

interface StageLayoutConfig {
  readonly bounds: StageCellRect;
  readonly cellGap: number;
  readonly cellHeight: number;
  readonly cellWidth: number;
  readonly columns: number;
  readonly labelHeight: number;
  readonly workspaceGap: number;
}

interface StageLayoutBuild {
  readonly cellsByWindowId: ReadonlyMap<WindowId, StageCell>;
  readonly orderedCells: readonly StageCell[];
  readonly workspaces: readonly StageWorkspaceGroup[];
}

interface StageRenderPlanBuild {
  readonly entriesByWindowId: ReadonlyMap<WindowId, StageRenderPlanEntry>;
  readonly renderPlan: readonly StageRenderPlanEntry[];
}

const DEFAULT_BOUNDS = Object.freeze({
  h: 720,
  w: 1_080,
  x: 0,
  y: 0,
}) satisfies StageCellRect;
const DEFAULT_CELL_WIDTH = 220;
const DEFAULT_CELL_HEIGHT = 140;
const DEFAULT_CELL_GAP = 16;
const DEFAULT_COLUMNS = 3;
const DEFAULT_LABEL_HEIGHT = 32;
const DEFAULT_WORKSPACE_GAP = 40;
const EMPTY_STAGE_INTENTS: readonly [] = Object.freeze([]);

export class StageViewModel {
  readonly #compositorPort: StageCompositorPort | undefined;
  readonly #config: StageLayoutConfig;
  readonly #describeWindow: StageWindowDescriber | undefined;
  readonly #labelWorkspace: StageWorkspaceLabeler | undefined;
  readonly #wm: StageWindowManagerPort;
  #cellsByWindowId: ReadonlyMap<WindowId, StageCell> = new Map();
  #focusedOverride: StageFocusedCell | null = null;
  #lastKnownModel: WindowModel;
  #overviewOpen = true;
  #renderEntriesByWindowId: ReadonlyMap<WindowId, StageRenderPlanEntry> = new Map();

  constructor(options: StageViewModelOptions) {
    this.#wm = options.wm;
    this.#compositorPort = options.compositorPort;
    this.#describeWindow = options.describeWindow;
    this.#labelWorkspace = options.labelWorkspace;
    this.#config = layoutConfig(options);

    const initial = readWindowModel(options.wm);

    this.#lastKnownModel = initial.ok
      ? initial.value
      : options.initialModel ?? createWindowModel();
  }

  snapshot(): StageViewModelState {
    const read = readWindowModel(this.#wm);

    if (read.ok) {
      this.#lastKnownModel = read.value;
    }

    return this.#buildState(this.#lastKnownModel);
  }

  focusCell(workspaceId: unknown, windowId: unknown): StageViewModelResult {
    const target = this.#normalizeCellTarget(workspaceId, windowId, "/focusCell");

    if (!target.ok) {
      return this.#reject(target.error);
    }

    this.#focusedOverride = freezeFocusedCell(target.value.workspaceId, target.value.windowId);

    return acceptAction(EMPTY_STAGE_INTENTS, this.#buildState(this.#lastKnownModel));
  }

  navigate(direction: unknown): StageViewModelResult {
    const normalized = normalizeDirection(direction);

    if (!normalized.ok) {
      return this.#reject(normalized.error);
    }

    const current = this.snapshot();
    const cells = orderedCellsFromState(current);

    if (current.focusedCell === null) {
      const first = cells[0];

      this.#focusedOverride = first === undefined
        ? null
        : freezeFocusedCell(workspaceIdForCell(current.workspaces, first.windowId), first.windowId);

      return acceptAction(EMPTY_STAGE_INTENTS, this.#buildState(this.#lastKnownModel));
    }

    const focused = findCell(current.workspaces, current.focusedCell.workspaceId, current.focusedCell.windowId);

    if (focused === undefined) {
      this.#focusedOverride = null;
      return acceptAction(EMPTY_STAGE_INTENTS, this.#buildState(this.#lastKnownModel));
    }

    const next = adjacentCell(focused, cells, normalized.value);
    const nextWorkspaceId = next === undefined
      ? current.focusedCell.workspaceId
      : workspaceIdForCell(current.workspaces, next.windowId);

    this.#focusedOverride = next === undefined
      ? current.focusedCell
      : freezeFocusedCell(nextWorkspaceId, next.windowId);

    return acceptAction(EMPTY_STAGE_INTENTS, this.#buildState(this.#lastKnownModel));
  }

  pick(workspaceId: unknown, windowId: unknown): StageViewModelResult {
    const target = this.#normalizeCellTarget(workspaceId, windowId, "/pick");

    if (!target.ok) {
      return this.#reject(target.error);
    }

    const intents = Object.freeze([
      Object.freeze({
        type: "focus",
        windowId: target.value.windowId,
      }) satisfies StageWindowManagerIntent,
      Object.freeze({
        type: "activate",
        windowId: target.value.windowId,
      }) satisfies StageWindowManagerIntent,
    ]);
    const committed = this.#commit(intents);

    if (committed.ok) {
      this.#overviewOpen = false;
      this.#focusedOverride = freezeFocusedCell(target.value.workspaceId, target.value.windowId);

      return acceptAction(intents, this.#buildState(this.#lastKnownModel));
    }

    return committed;
  }

  closeWindow(workspaceId: unknown, windowId: unknown): StageViewModelResult {
    const target = this.#normalizeCellTarget(workspaceId, windowId, "/closeWindow");

    if (!target.ok) {
      return this.#reject(target.error);
    }

    const intents = Object.freeze([
      Object.freeze({
        type: "close",
        windowId: target.value.windowId,
      }) satisfies StageWindowManagerIntent,
    ]);
    const committed = this.#commit(intents);

    if (committed.ok && this.#focusedOverride?.windowId === target.value.windowId) {
      this.#focusedOverride = null;

      return acceptAction(intents, this.#buildState(this.#lastKnownModel));
    }

    return committed;
  }

  moveToWorkspace(windowId: unknown, targetWorkspaceId: unknown): StageViewModelResult {
    const normalizedWindowId = normalizeWindowId(windowId, "/moveToWorkspace/windowId");

    if (!normalizedWindowId.ok) {
      return this.#reject(normalizedWindowId.error);
    }

    const normalizedWorkspaceId = normalizeWorkspaceId(targetWorkspaceId, "/moveToWorkspace/targetWorkspaceId");

    if (!normalizedWorkspaceId.ok) {
      return this.#reject(normalizedWorkspaceId.error);
    }

    const read = this.#readForAction();

    if (!read.ok) {
      return this.#reject(read.error);
    }
    if (!hasWindow(read.value, normalizedWindowId.value)) {
      return this.#reject(error(
        "INVALID_WINDOW",
        "window id is not present in the stage layout.",
        "/moveToWorkspace/windowId",
      ));
    }
    if (!hasWorkspace(read.value, normalizedWorkspaceId.value)) {
      return this.#reject(error(
        "INVALID_WORKSPACE",
        "target workspace id is not present in the window model.",
        "/moveToWorkspace/targetWorkspaceId",
      ));
    }

    const intents = Object.freeze([
      Object.freeze({
        type: "moveToWorkspace",
        windowId: normalizedWindowId.value,
        workspaceId: normalizedWorkspaceId.value,
      }) satisfies StageWindowManagerIntent,
    ]);
    const committed = this.#commit(intents);

    if (committed.ok) {
      this.#focusedOverride = freezeFocusedCell(normalizedWorkspaceId.value, normalizedWindowId.value);

      return acceptAction(intents, this.#buildState(this.#lastKnownModel));
    }

    return committed;
  }

  #commit(intents: readonly StageWindowManagerIntent[]): StageViewModelResult {
    const applied = applyWindowManagerIntents(this.#wm, intents);

    if (!applied.ok) {
      return this.#reject(error("WM_INTENT_FAILED", applied.error.message, applied.error.path));
    }

    this.#lastKnownModel = applied.value;

    return acceptAction(intents, this.#buildState(applied.value));
  }

  #normalizeCellTarget(
    workspaceId: unknown,
    windowId: unknown,
    path: string,
  ): NormalizeResult<StageFocusedCell> {
    const normalizedWorkspaceId = normalizeWorkspaceId(workspaceId, `${path}/workspaceId`);

    if (!normalizedWorkspaceId.ok) {
      return normalizedWorkspaceId;
    }

    const normalizedWindowId = normalizeWindowId(windowId, `${path}/windowId`);

    if (!normalizedWindowId.ok) {
      return normalizedWindowId;
    }

    const read = this.#readForAction();

    if (!read.ok) {
      return read;
    }

    const state = this.#buildState(read.value);

    if (findWorkspaceGroup(state.workspaces, normalizedWorkspaceId.value) === undefined) {
      return reject(error(
        "INVALID_WORKSPACE",
        "workspace id is not present in the stage layout.",
        `${path}/workspaceId`,
      ));
    }
    if (findCell(state.workspaces, normalizedWorkspaceId.value, normalizedWindowId.value) === undefined) {
      return reject(error(
        "INVALID_WINDOW",
        "window id is not present in the requested workspace.",
        `${path}/windowId`,
      ));
    }

    return accept(freezeFocusedCell(normalizedWorkspaceId.value, normalizedWindowId.value));
  }

  #readForAction(): NormalizeResult<WindowModel> {
    const read = readWindowModel(this.#wm);

    if (!read.ok) {
      return reject(error("WM_READ_FAILED", read.error.message, read.error.path));
    }

    this.#lastKnownModel = read.value;

    return accept(read.value);
  }

  #buildState(model: WindowModel): StageViewModelState {
    const layoutBuild = buildStageLayout(
      model,
      this.#config,
      this.#cellsByWindowId,
      this.#describeWindow,
      this.#labelWorkspace,
    );
    const focusedCell = resolveFocusedCell(layoutBuild.workspaces, model, this.#focusedOverride);
    const renderPlanBuild = buildRenderPlan(
      layoutBuild.orderedCells,
      this.#compositorPort,
      this.#renderEntriesByWindowId,
    );

    this.#cellsByWindowId = layoutBuild.cellsByWindowId;
    this.#focusedOverride = focusedCell;
    this.#renderEntriesByWindowId = renderPlanBuild.entriesByWindowId;

    return Object.freeze({
      focusedCell,
      overviewOpen: this.#overviewOpen,
      renderPlan: renderPlanBuild.renderPlan,
      workspaces: layoutBuild.workspaces,
    });
  }

  #reject(errorValue: StageViewModelError): StageViewModelResult {
    return Object.freeze({
      error: errorValue,
      intents: EMPTY_STAGE_INTENTS,
      ok: false,
      state: this.#buildState(this.#lastKnownModel),
    });
  }
}

export function createStageViewModel(options: StageViewModelOptions): StageViewModel {
  return new StageViewModel(options);
}

export function applyStageWindowManagerIntents(
  model: WindowModel,
  intents: readonly StageWindowManagerIntent[],
): WindowModel {
  let next = model;

  for (let index = 0; index < intents.length; index += 1) {
    const intent = intents[index];

    if (intent === undefined) {
      continue;
    }

    switch (intent.type) {
      case "activate":
        break;
      case "close":
        next = sdkCloseWindow(next, intent.windowId);
        break;
      case "focus":
        next = sdkFocusWindow(next, intent.windowId);
        break;
      case "moveToWorkspace":
        next = sdkMoveWindowToWorkspace(next, intent.windowId, intent.workspaceId);
        break;
    }
  }

  return next;
}

export function diffStageRenderPlans(
  previous: readonly StageRenderPlanEntry[],
  next: readonly StageRenderPlanEntry[],
): StageRenderPlanDiff {
  const previousByWindowId = renderEntriesByWindowId(previous);
  const nextByWindowId = renderEntriesByWindowId(next);
  const added: StageRenderPlanEntry[] = [];
  const removed: StageRenderPlanEntry[] = [];
  const updated: StageRenderPlanUpdate[] = [];

  for (let index = 0; index < previous.length; index += 1) {
    const entry = previous[index];

    if (entry !== undefined && !nextByWindowId.has(entry.windowId)) {
      removed.push(entry);
    }
  }

  for (let index = 0; index < next.length; index += 1) {
    const entry = next[index];

    if (entry === undefined) {
      continue;
    }

    const previousEntry = previousByWindowId.get(entry.windowId);

    if (previousEntry === undefined) {
      added.push(entry);
    } else if (!sameRenderPlanEntry(previousEntry, entry)) {
      updated.push(Object.freeze({
        after: entry,
        before: previousEntry,
      }) satisfies StageRenderPlanUpdate);
    }
  }

  return Object.freeze({
    added: Object.freeze(added),
    removed: Object.freeze(removed),
    updated: Object.freeze(updated),
  });
}

function buildStageLayout(
  model: WindowModel,
  config: StageLayoutConfig,
  previousCells: ReadonlyMap<WindowId, StageCell>,
  describeWindow: StageWindowDescriber | undefined,
  labelWorkspace: StageWorkspaceLabeler | undefined,
): StageLayoutBuild {
  const workspaces: StageWorkspaceGroup[] = [];
  const orderedCells: StageCell[] = [];
  const cellsByWindowId = new Map<WindowId, StageCell>();
  let groupY = config.bounds.y;

  for (let workspaceIndex = 0; workspaceIndex < model.workspaces.length; workspaceIndex += 1) {
    const workspace = model.workspaces[workspaceIndex];

    if (workspace === undefined) {
      continue;
    }

    const windows = windowsForWorkspace(model.windows, workspace.id);
    const cells: StageCell[] = [];

    for (let cellIndex = 0; cellIndex < windows.length; cellIndex += 1) {
      const window = windows[cellIndex];

      if (window === undefined) {
        continue;
      }

      const cell = stageCell(
        window,
        cellIndex,
        groupY,
        config,
        previousCells.get(window.id),
        describeWindow,
      );

      cells.push(cell);
      orderedCells.push(cell);
      cellsByWindowId.set(cell.windowId, cell);
    }

    workspaces.push(Object.freeze({
      cells: Object.freeze(cells),
      label: workspaceLabel(workspace, workspaceIndex, labelWorkspace),
      workspaceId: workspace.id,
    }) satisfies StageWorkspaceGroup);

    groupY += groupHeight(cells.length, config) + config.workspaceGap;
  }

  return Object.freeze({
    cellsByWindowId,
    orderedCells: Object.freeze(orderedCells),
    workspaces: Object.freeze(workspaces),
  });
}

function stageCell(
  window: WindowState,
  cellIndex: number,
  groupY: number,
  config: StageLayoutConfig,
  previous: StageCell | undefined,
  describeWindow: StageWindowDescriber | undefined,
): StageCell {
  const description = windowDescription(window, describeWindow);
  const sourceRect = freezeSourceRect(window.rect);
  const rect = cellRectForIndex(cellIndex, groupY, config);
  const next = Object.freeze({
    appId: description.appId,
    rect,
    sourceRect,
    title: description.title,
    windowId: window.id,
  }) satisfies StageCell;

  if (previous !== undefined && sameStageCell(previous, next)) {
    return previous;
  }

  return next;
}

function buildRenderPlan(
  cells: readonly StageCell[],
  compositorPort: StageCompositorPort | undefined,
  previousEntries: ReadonlyMap<WindowId, StageRenderPlanEntry>,
): StageRenderPlanBuild {
  const textures = resolveTextures(cells, compositorPort);
  const renderPlan: StageRenderPlanEntry[] = [];
  const entriesByWindowId = new Map<WindowId, StageRenderPlanEntry>();

  for (let index = 0; index < cells.length; index += 1) {
    const cell = cells[index];

    if (cell === undefined) {
      continue;
    }

    const texture = textures.allPlaceholder ? null : textures.byWindowId.get(cell.windowId) ?? null;
    const next = renderPlanEntry(cell, texture);
    const previous = previousEntries.get(cell.windowId);
    const entry = previous !== undefined && sameRenderPlanEntry(previous, next) ? previous : next;

    renderPlan.push(entry);
    entriesByWindowId.set(entry.windowId, entry);
  }

  return Object.freeze({
    entriesByWindowId,
    renderPlan: Object.freeze(renderPlan),
  });
}

function renderPlanEntry(
  cell: StageCell,
  texture: StageCompositorTexture | null,
): StageRenderPlanEntry {
  if (texture === null) {
    return Object.freeze({
      cellRect: cell.rect,
      placeholder: true,
      sourceSize: null,
      textureId: null,
      windowId: cell.windowId,
    }) satisfies StageRenderPlanEntry;
  }

  return Object.freeze({
    cellRect: cell.rect,
    placeholder: false,
    sourceSize: Object.freeze({
      height: texture.sourceH,
      width: texture.sourceW,
    }),
    textureId: texture.textureId,
    windowId: cell.windowId,
  }) satisfies StageRenderPlanEntry;
}

function resolveTextures(
  cells: readonly StageCell[],
  compositorPort: StageCompositorPort | undefined,
): {
  readonly allPlaceholder: boolean;
  readonly byWindowId: ReadonlyMap<WindowId, StageCompositorTexture>;
} {
  const byWindowId = new Map<WindowId, StageCompositorTexture>();

  if (compositorPort === undefined) {
    return Object.freeze({
      allPlaceholder: true,
      byWindowId,
    });
  }

  try {
    for (let index = 0; index < cells.length; index += 1) {
      const cell = cells[index];

      if (cell === undefined) {
        continue;
      }

      const texture = normalizeTexture(compositorPort.resolveWindowTexture(cell.windowId));

      if (texture !== null) {
        byWindowId.set(cell.windowId, texture);
      }
    }
  } catch {
    return Object.freeze({
      allPlaceholder: true,
      byWindowId: new Map(),
    });
  }

  return Object.freeze({
    allPlaceholder: false,
    byWindowId,
  });
}

function normalizeTexture(input: StageCompositorTexture | null | undefined): StageCompositorTexture | null {
  if (input === null || input === undefined) {
    return null;
  }

  const sourceW = positiveInteger(input.sourceW);
  const sourceH = positiveInteger(input.sourceH);

  if (typeof input.textureId !== "string" || input.textureId.length === 0 || sourceW === null || sourceH === null) {
    return null;
  }

  return Object.freeze({
    sourceH,
    sourceW,
    textureId: input.textureId,
  });
}

function layoutConfig(options: StageViewModelOptions): StageLayoutConfig {
  return Object.freeze({
    bounds: freezeStageRect(options.bounds ?? DEFAULT_BOUNDS),
    cellGap: normalizeInteger(options.cellGap, DEFAULT_CELL_GAP, 0),
    cellHeight: normalizeInteger(options.cellHeight, DEFAULT_CELL_HEIGHT, 1),
    cellWidth: normalizeInteger(options.cellWidth, DEFAULT_CELL_WIDTH, 1),
    columns: normalizeInteger(options.columns, DEFAULT_COLUMNS, 1),
    labelHeight: normalizeInteger(options.labelHeight, DEFAULT_LABEL_HEIGHT, 0),
    workspaceGap: normalizeInteger(options.workspaceGap, DEFAULT_WORKSPACE_GAP, 0),
  });
}

function cellRectForIndex(
  cellIndex: number,
  groupY: number,
  config: StageLayoutConfig,
): StageCellRect {
  const column = cellIndex % config.columns;
  const row = Math.floor(cellIndex / config.columns);

  return Object.freeze({
    h: config.cellHeight,
    w: config.cellWidth,
    x: config.bounds.x + column * (config.cellWidth + config.cellGap),
    y: groupY + config.labelHeight + row * (config.cellHeight + config.cellGap),
  });
}

function groupHeight(cellCount: number, config: StageLayoutConfig): number {
  if (cellCount <= 0) {
    return config.labelHeight;
  }

  const rows = Math.ceil(cellCount / config.columns);

  return config.labelHeight +
    rows * config.cellHeight +
    Math.max(0, rows - 1) * config.cellGap;
}

function windowsForWorkspace(
  windows: readonly WindowState[],
  workspaceId: WorkspaceId,
): readonly WindowState[] {
  const output: WindowState[] = [];

  for (let index = 0; index < windows.length; index += 1) {
    const window = windows[index];

    if (window !== undefined && window.workspaceId === workspaceId) {
      output.push(window);
    }
  }

  output.sort(compareWindowsByStageKey);
  return Object.freeze(output);
}

function compareWindowsByStageKey(left: WindowState, right: WindowState): number {
  const id = compareStrings(left.id, right.id);

  if (id !== 0) {
    return id;
  }

  return left.order - right.order;
}

function workspaceLabel(
  workspace: WorkspaceState,
  index: number,
  labelWorkspace: StageWorkspaceLabeler | undefined,
): string {
  if (labelWorkspace !== undefined) {
    try {
      const label = labelWorkspace(workspace, index);

      if (typeof label === "string" && label.length > 0) {
        return label;
      }
    } catch {
      return defaultWorkspaceLabel(workspace.id, index);
    }
  }

  return defaultWorkspaceLabel(workspace.id, index);
}

function defaultWorkspaceLabel(workspaceId: WorkspaceId, index: number): string {
  const suffix = numericSuffix(workspaceId, "workspace-");

  return suffix === null ? `Workspace ${index + 1}` : `Workspace ${suffix}`;
}

function windowDescription(
  window: WindowState,
  describeWindow: StageWindowDescriber | undefined,
): StageWindowDescription {
  if (describeWindow !== undefined) {
    try {
      const described = describeWindow(window);

      if (
        described !== null &&
        described !== undefined &&
        typeof described.appId === "string" &&
        described.appId.length > 0 &&
        typeof described.title === "string" &&
        described.title.length > 0
      ) {
        return Object.freeze({
          appId: described.appId,
          title: described.title,
        });
      }
    } catch {
      return defaultWindowDescription(window);
    }
  }

  return defaultWindowDescription(window);
}

function defaultWindowDescription(window: WindowState): StageWindowDescription {
  return Object.freeze({
    appId: windowAppId(window.id),
    title: windowTitle(window.id),
  });
}

function windowAppId(windowId: WindowId): string {
  const firstSeparator = windowId.indexOf(":");

  if (firstSeparator < 0 || firstSeparator === windowId.length - 1) {
    return windowId;
  }

  const secondSeparator = windowId.indexOf(":", firstSeparator + 1);

  return secondSeparator < 0
    ? windowId.slice(firstSeparator + 1)
    : windowId.slice(firstSeparator + 1, secondSeparator);
}

function windowTitle(windowId: WindowId): string {
  const separator = windowId.lastIndexOf(":");

  if (separator < 0 || separator === windowId.length - 1) {
    return windowId;
  }

  return windowId.slice(separator + 1);
}

function resolveFocusedCell(
  workspaces: readonly StageWorkspaceGroup[],
  model: WindowModel,
  override: StageFocusedCell | null,
): StageFocusedCell | null {
  if (override !== null && findCell(workspaces, override.workspaceId, override.windowId) !== undefined) {
    return freezeFocusedCell(override.workspaceId, override.windowId);
  }

  for (let index = 0; index < model.focusStack.length; index += 1) {
    const windowId = model.focusStack[index];

    if (windowId === undefined) {
      continue;
    }

    const workspaceId = workspaceIdForWindow(workspaces, windowId);

    if (workspaceId !== null) {
      return freezeFocusedCell(workspaceId, windowId);
    }
  }

  const firstWorkspace = workspaces[0];
  const firstCell = firstWorkspace?.cells[0];

  return firstWorkspace !== undefined && firstCell !== undefined
    ? freezeFocusedCell(firstWorkspace.workspaceId, firstCell.windowId)
    : null;
}

function orderedCellsFromState(state: StageViewModelState): readonly StageCell[] {
  const output: StageCell[] = [];

  for (let workspaceIndex = 0; workspaceIndex < state.workspaces.length; workspaceIndex += 1) {
    const workspace = state.workspaces[workspaceIndex];

    if (workspace === undefined) {
      continue;
    }

    for (let cellIndex = 0; cellIndex < workspace.cells.length; cellIndex += 1) {
      const cell = workspace.cells[cellIndex];

      if (cell !== undefined) {
        output.push(cell);
      }
    }
  }

  return Object.freeze(output);
}

function adjacentCell(
  current: StageCell,
  cells: readonly StageCell[],
  direction: StageNavigationDirection,
): StageCell | undefined {
  let best: StageCell | undefined;
  let bestPrimary = Number.POSITIVE_INFINITY;
  let bestSecondary = Number.POSITIVE_INFINITY;

  for (let index = 0; index < cells.length; index += 1) {
    const candidate = cells[index];

    if (candidate === undefined || candidate.windowId === current.windowId) {
      continue;
    }

    const score = navigationScore(current.rect, candidate.rect, direction);

    if (score === null) {
      continue;
    }

    const better = score.primary < bestPrimary ||
      (score.primary === bestPrimary && score.secondary < bestSecondary) ||
      (
        score.primary === bestPrimary &&
        score.secondary === bestSecondary &&
        best !== undefined &&
        compareStrings(candidate.windowId, best.windowId) < 0
      );

    if (best === undefined || better) {
      best = candidate;
      bestPrimary = score.primary;
      bestSecondary = score.secondary;
    }
  }

  return best;
}

function navigationScore(
  current: StageCellRect,
  candidate: StageCellRect,
  direction: StageNavigationDirection,
): {
  readonly primary: number;
  readonly secondary: number;
} | null {
  const currentCenterX = current.x + Math.floor(current.w / 2);
  const currentCenterY = current.y + Math.floor(current.h / 2);
  const candidateCenterX = candidate.x + Math.floor(candidate.w / 2);
  const candidateCenterY = candidate.y + Math.floor(candidate.h / 2);

  switch (direction) {
    case "left":
      if (candidateCenterX >= currentCenterX || !rangesOverlap(current.y, current.y + current.h, candidate.y, candidate.y + candidate.h)) {
        return null;
      }
      return Object.freeze({
        primary: currentCenterX - candidateCenterX,
        secondary: Math.abs(currentCenterY - candidateCenterY),
      });
    case "right":
      if (candidateCenterX <= currentCenterX || !rangesOverlap(current.y, current.y + current.h, candidate.y, candidate.y + candidate.h)) {
        return null;
      }
      return Object.freeze({
        primary: candidateCenterX - currentCenterX,
        secondary: Math.abs(currentCenterY - candidateCenterY),
      });
    case "up":
      if (candidateCenterY >= currentCenterY || !rangesOverlap(current.x, current.x + current.w, candidate.x, candidate.x + candidate.w)) {
        return null;
      }
      return Object.freeze({
        primary: currentCenterY - candidateCenterY,
        secondary: Math.abs(currentCenterX - candidateCenterX),
      });
    case "down":
      if (candidateCenterY <= currentCenterY || !rangesOverlap(current.x, current.x + current.w, candidate.x, candidate.x + candidate.w)) {
        return null;
      }
      return Object.freeze({
        primary: candidateCenterY - currentCenterY,
        secondary: Math.abs(currentCenterX - candidateCenterX),
      });
  }
}

function rangesOverlap(leftStart: number, leftEnd: number, rightStart: number, rightEnd: number): boolean {
  return leftStart < rightEnd && rightStart < leftEnd;
}

function findWorkspaceGroup(
  workspaces: readonly StageWorkspaceGroup[],
  workspaceId: WorkspaceId,
): StageWorkspaceGroup | undefined {
  for (let index = 0; index < workspaces.length; index += 1) {
    const workspace = workspaces[index];

    if (workspace !== undefined && workspace.workspaceId === workspaceId) {
      return workspace;
    }
  }

  return undefined;
}

function findCell(
  workspaces: readonly StageWorkspaceGroup[],
  workspaceId: WorkspaceId,
  windowId: WindowId,
): StageCell | undefined {
  const workspace = findWorkspaceGroup(workspaces, workspaceId);

  if (workspace === undefined) {
    return undefined;
  }

  for (let index = 0; index < workspace.cells.length; index += 1) {
    const cell = workspace.cells[index];

    if (cell !== undefined && cell.windowId === windowId) {
      return cell;
    }
  }

  return undefined;
}

function workspaceIdForCell(
  workspaces: readonly StageWorkspaceGroup[],
  windowId: WindowId,
): WorkspaceId {
  return workspaceIdForWindow(workspaces, windowId) ?? "";
}

function workspaceIdForWindow(
  workspaces: readonly StageWorkspaceGroup[],
  windowId: WindowId,
): WorkspaceId | null {
  for (let workspaceIndex = 0; workspaceIndex < workspaces.length; workspaceIndex += 1) {
    const workspace = workspaces[workspaceIndex];

    if (workspace === undefined) {
      continue;
    }

    for (let cellIndex = 0; cellIndex < workspace.cells.length; cellIndex += 1) {
      const cell = workspace.cells[cellIndex];

      if (cell !== undefined && cell.windowId === windowId) {
        return workspace.workspaceId;
      }
    }
  }

  return null;
}

function hasWorkspace(model: WindowModel, workspaceId: WorkspaceId): boolean {
  for (let index = 0; index < model.workspaces.length; index += 1) {
    if (model.workspaces[index]?.id === workspaceId) {
      return true;
    }
  }

  return false;
}

function hasWindow(model: WindowModel, windowId: WindowId): boolean {
  for (let index = 0; index < model.windows.length; index += 1) {
    if (model.windows[index]?.id === windowId) {
      return true;
    }
  }

  return false;
}

function renderEntriesByWindowId(
  entries: readonly StageRenderPlanEntry[],
): ReadonlyMap<WindowId, StageRenderPlanEntry> {
  const output = new Map<WindowId, StageRenderPlanEntry>();

  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];

    if (entry !== undefined) {
      output.set(entry.windowId, entry);
    }
  }

  return output;
}

function sameStageCell(left: StageCell, right: StageCell): boolean {
  return left.windowId === right.windowId &&
    left.appId === right.appId &&
    left.title === right.title &&
    sameSourceRect(left.sourceRect, right.sourceRect) &&
    sameCellRect(left.rect, right.rect);
}

function sameRenderPlanEntry(left: StageRenderPlanEntry, right: StageRenderPlanEntry): boolean {
  return left.windowId === right.windowId &&
    left.placeholder === right.placeholder &&
    left.textureId === right.textureId &&
    sameNullableSourceSize(left.sourceSize, right.sourceSize) &&
    sameCellRect(left.cellRect, right.cellRect);
}

function sameNullableSourceSize(left: StageSourceSize | null, right: StageSourceSize | null): boolean {
  if (left === null || right === null) {
    return left === right;
  }

  return left.width === right.width && left.height === right.height;
}

function sameSourceRect(left: Rect, right: Rect): boolean {
  return left.x === right.x &&
    left.y === right.y &&
    left.width === right.width &&
    left.height === right.height;
}

function sameCellRect(left: StageCellRect, right: StageCellRect): boolean {
  return left.x === right.x &&
    left.y === right.y &&
    left.w === right.w &&
    left.h === right.h;
}

function freezeFocusedCell(workspaceId: WorkspaceId, windowId: WindowId): StageFocusedCell {
  return Object.freeze({
    windowId,
    workspaceId,
  });
}

function freezeSourceRect(rect: Rect): Rect {
  return Object.freeze({
    height: normalizeNumber(rect.height),
    width: normalizeNumber(rect.width),
    x: normalizeNumber(rect.x),
    y: normalizeNumber(rect.y),
  });
}

function freezeStageRect(rect: StageCellRect): StageCellRect {
  return Object.freeze({
    h: normalizeInteger(rect.h, DEFAULT_BOUNDS.h, 0),
    w: normalizeInteger(rect.w, DEFAULT_BOUNDS.w, 0),
    x: normalizeNumber(rect.x),
    y: normalizeNumber(rect.y),
  });
}

function normalizeDirection(input: unknown): NormalizeResult<StageNavigationDirection> {
  if (input === "down" || input === "left" || input === "right" || input === "up") {
    return accept(input);
  }

  return reject(error("INVALID_DIRECTION", "stage navigation direction is not supported.", "/navigate/direction"));
}

function normalizeWorkspaceId(input: unknown, path: string): NormalizeResult<WorkspaceId> {
  if (typeof input !== "string" || input.length === 0) {
    return reject(error("INVALID_WORKSPACE", "workspace id must be a non-empty string.", path));
  }

  return accept(input);
}

function normalizeWindowId(input: unknown, path: string): NormalizeResult<WindowId> {
  if (typeof input !== "string" || input.length === 0) {
    return reject(error("INVALID_WINDOW", "window id must be a non-empty string.", path));
  }

  return accept(input);
}

function readWindowModel(
  port: StageWindowManagerPort,
): StageWindowManagerPortResult<WindowModel> {
  try {
    return port.readWindowModel();
  } catch (caught) {
    return rejectPort("WM_READ_THROWN", errorMessage(caught, "window model read failed closed."), "/wm/read");
  }
}

function applyWindowManagerIntents(
  port: StageWindowManagerPort,
  intents: readonly StageWindowManagerIntent[],
): StageWindowManagerPortResult<WindowModel> {
  try {
    return port.applyWindowManagerIntents(intents);
  } catch (caught) {
    return rejectPort("WM_INTENT_THROWN", errorMessage(caught, "window manager intent failed closed."), "/wm/intents");
  }
}

function error(
  code: StageViewModelError["code"],
  message: string,
  path: string,
): StageViewModelError {
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

function acceptAction(
  intents: readonly StageWindowManagerIntent[],
  state: StageViewModelState,
): StageViewModelResult {
  return Object.freeze({
    intents,
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

function reject<T>(errorValue: StageViewModelError): NormalizeResult<T> {
  return {
    error: errorValue,
    ok: false,
  };
}

function rejectPort<T>(
  code: string,
  message: string,
  path: string,
): StageWindowManagerPortResult<T> {
  return Object.freeze({
    error: Object.freeze({
      code,
      message,
      path,
    }),
    ok: false,
  });
}

function normalizeInteger(value: number | undefined, fallback: number, min: number): number {
  if (value === undefined || !Number.isFinite(value)) {
    return fallback;
  }

  return Math.max(min, Math.trunc(value));
}

function normalizeNumber(value: number): number {
  return Number.isFinite(value) ? Math.trunc(value) : 0;
}

function positiveInteger(value: number): number | null {
  if (!Number.isFinite(value)) {
    return null;
  }

  const normalized = Math.trunc(value);

  return normalized > 0 ? normalized : null;
}

function numericSuffix(value: string, prefix: string): number | null {
  if (!value.startsWith(prefix)) {
    return null;
  }

  const suffix = value.slice(prefix.length);

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

function compareStrings(left: string, right: string): number {
  if (left < right) {
    return -1;
  }
  if (left > right) {
    return 1;
  }

  return 0;
}
