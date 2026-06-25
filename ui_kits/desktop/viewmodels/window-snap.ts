import {
  collectWindowManagerIntents,
  createWindowModel,
  focusedWindowId,
  layout,
  maximizeWindow,
  moveResizeWindow,
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
  WorkspaceState,
} from "../../../sdk/typescript/src/desktop-sdk/index.ts";

export type WindowSnapZone =
  | "left-half"
  | "right-half"
  | "top-half"
  | "bottom-half"
  | "top-left"
  | "top-right"
  | "bottom-left"
  | "bottom-right";

export const WINDOW_SNAP_ZONES: readonly WindowSnapZone[] = Object.freeze([
  "left-half",
  "right-half",
  "top-half",
  "bottom-half",
  "top-left",
  "top-right",
  "bottom-left",
  "bottom-right",
] satisfies readonly WindowSnapZone[]);

export type WindowSnapCommand = WindowSnapZone | "center" | "maximize" | "restore";

export interface WindowSnapDisplayPort {
  activeWorkArea(): Rect;
}

export interface WindowSnapWindowManagerPort {
  repositionTexture(textureId: TextureId, rect: Rect, windowId: WindowId): void;
  setFocus(windowId: WindowId | null): void;
  setTextureVisibility?(textureId: TextureId, visible: boolean, windowId: WindowId): void;
}

export interface WindowSnapViewModelOptions {
  readonly wm: WindowSnapWindowManagerPort;
  readonly display?: WindowSnapDisplayPort;
  readonly edgeThreshold?: number;
  readonly initialModel?: WindowModel;
  readonly minHeight?: number;
  readonly minWidth?: number;
  readonly workArea?: Rect;
}

export interface WindowSnapZoneState {
  readonly id: WindowSnapZone;
  readonly kind: "corner" | "edge";
  readonly rect: Rect;
  readonly triggerRect: Rect;
}

export interface WindowSnapViewModelState {
  readonly activeWindowId: WindowId | null;
  readonly error: WindowSnapViewModelError | null;
  readonly focusedPlacement: WindowPlacement | null;
  readonly intentCount: number;
  readonly lastCommand: WindowSnapCommand | null;
  readonly lastIntentTypes: readonly WindowManagerIntent["type"][];
  readonly placements: readonly WindowPlacement[];
  readonly ready: boolean;
  readonly restoreAvailable: boolean;
  readonly workArea: Rect | null;
  readonly zones: readonly WindowSnapZoneState[];
}

export type WindowSnapViewModelResult =
  | {
      readonly ok: true;
      readonly command: WindowSnapCommand;
      readonly intents: readonly WindowManagerIntent[];
      readonly placement: WindowPlacement | null;
      readonly state: WindowSnapViewModelState;
    }
  | {
      readonly ok: false;
      readonly error: WindowSnapViewModelError;
      readonly intents: readonly [];
      readonly placement: null;
      readonly state: WindowSnapViewModelState;
    };

export type WindowSnapZoneHitResult =
  | {
      readonly ok: true;
      readonly state: WindowSnapViewModelState;
      readonly zone: WindowSnapZone | null;
    }
  | {
      readonly ok: false;
      readonly error: WindowSnapViewModelError;
      readonly state: WindowSnapViewModelState;
      readonly zone: null;
    };

export interface WindowSnapViewModelError {
  readonly code:
    | "DISPLAY_UNAVAILABLE"
    | "INVALID_KEYBOARD_CHORD"
    | "INVALID_POINTER"
    | "INVALID_SNAP_COMMAND"
    | "NO_FOCUSED_WINDOW"
    | "WM_INTENT_FAILED";
  readonly message: string;
  readonly path: string;
}

type NormalizeResult<T> =
  | {
      readonly ok: true;
      readonly value: T;
    }
  | {
      readonly ok: false;
      readonly error: WindowSnapViewModelError;
    };

interface FocusedWindowSnapshot {
  readonly placement: WindowPlacement;
  readonly window: WindowState;
  readonly windowId: WindowId;
}

const DEFAULT_WORKSPACE_ID = "workspace-1";
const DEFAULT_WINDOW_ID = "window:snap:main";
const DEFAULT_TEXTURE_ID = "texture:snap:main";
const DEFAULT_EDGE_THRESHOLD = 32;

const DEFAULT_WORK_AREA = Object.freeze({
  height: 900,
  width: 1_440,
  x: 0,
  y: 0,
}) satisfies Rect;

const DEFAULT_WINDOW_RECT = Object.freeze({
  height: 520,
  width: 760,
  x: 340,
  y: 190,
}) satisfies Rect;

const RECT_FIELDS = Object.freeze(["height", "width", "x", "y"]);
const POINT_FIELDS = Object.freeze(["x", "y"]);

export class WindowSnapViewModel {
  readonly #display: WindowSnapDisplayPort;
  readonly #edgeThreshold: number;
  readonly #minHeight: number | undefined;
  readonly #minWidth: number | undefined;
  readonly #wm: WindowSnapWindowManagerPort;
  #lastCommand: WindowSnapCommand | null = null;
  #lastIntents: readonly WindowManagerIntent[] = Object.freeze([]);
  #model: WindowModel;
  #restoreRects: ReadonlyMap<WindowId, Rect> = new Map<WindowId, Rect>();

  constructor(options: WindowSnapViewModelOptions) {
    this.#display = options.display ?? createStaticWindowSnapDisplayPort(options.workArea ?? DEFAULT_WORK_AREA);
    this.#edgeThreshold = normalizePositiveInteger(options.edgeThreshold, DEFAULT_EDGE_THRESHOLD);
    this.#minHeight = normalizeOptionalPositiveInteger(options.minHeight);
    this.#minWidth = normalizeOptionalPositiveInteger(options.minWidth);
    this.#model = options.initialModel ?? createInitialWindowSnapModel();
    this.#wm = options.wm;
  }

  snapshot(): WindowSnapViewModelState {
    const workArea = readActiveWorkArea(this.#display);

    if (!workArea.ok) {
      return this.#stateForDisplayError(workArea.error);
    }

    return this.#stateForWorkArea(workArea.value, null);
  }

  snapToZone(command: unknown): WindowSnapViewModelResult {
    const normalized = normalizeSnapCommand(command, "/snap/command");

    if (!normalized.ok) {
      return this.#reject(normalized.error, this.snapshot());
    }

    return this.#applyCommand(normalized.value);
  }

  snapZone(command: unknown): WindowSnapViewModelResult {
    return this.snapToZone(command);
  }

  snapFocused(command: unknown): WindowSnapViewModelResult {
    return this.snapToZone(command);
  }

  centerFocused(): WindowSnapViewModelResult {
    return this.#applyCommand("center");
  }

  maximizeFocused(): WindowSnapViewModelResult {
    return this.#applyCommand("maximize");
  }

  restoreFocused(): WindowSnapViewModelResult {
    return this.#applyCommand("restore");
  }

  handleKeyboardChord(chord: unknown): WindowSnapViewModelResult {
    const normalized = normalizeKeyboardChord(chord);

    if (!normalized.ok) {
      return this.#reject(normalized.error, this.snapshot());
    }

    return this.#applyCommand(normalized.value);
  }

  handleKeyChord(chord: unknown): WindowSnapViewModelResult {
    return this.handleKeyboardChord(chord);
  }

  keyboardChord(chord: unknown): WindowSnapViewModelResult {
    return this.handleKeyboardChord(chord);
  }

  zoneAtPoint(point: unknown): WindowSnapZoneHitResult {
    const normalized = normalizePoint(point);

    if (!normalized.ok) {
      return Object.freeze({
        error: normalized.error,
        ok: false,
        state: this.snapshot(),
        zone: null,
      });
    }

    const workArea = readActiveWorkArea(this.#display);

    if (!workArea.ok) {
      return Object.freeze({
        error: workArea.error,
        ok: false,
        state: this.#stateForDisplayError(workArea.error),
        zone: null,
      });
    }

    return Object.freeze({
      ok: true,
      state: this.#stateForWorkArea(workArea.value, null),
      zone: zoneForPoint(normalized.value, workArea.value, this.#edgeThreshold),
    });
  }

  snapAtPoint(point: unknown): WindowSnapViewModelResult {
    const normalized = normalizePoint(point);

    if (!normalized.ok) {
      return this.#reject(normalized.error, this.snapshot());
    }

    const workArea = readActiveWorkArea(this.#display);

    if (!workArea.ok) {
      return this.#reject(workArea.error, this.#stateForDisplayError(workArea.error));
    }

    const zone = zoneForPoint(normalized.value, workArea.value, this.#edgeThreshold);
    const state = this.#stateForWorkArea(workArea.value, null);

    if (zone === null) {
      return this.#reject(error(
        "INVALID_POINTER",
        "pointer is not inside a snap zone.",
        "/snap/pointer",
      ), state);
    }

    return this.#applyCommandWithWorkArea(zone, workArea.value);
  }

  #applyCommand(command: WindowSnapCommand): WindowSnapViewModelResult {
    const workArea = readActiveWorkArea(this.#display);

    if (!workArea.ok) {
      return this.#reject(workArea.error, this.#stateForDisplayError(workArea.error));
    }

    return this.#applyCommandWithWorkArea(command, workArea.value);
  }

  #applyCommandWithWorkArea(command: WindowSnapCommand, workArea: Rect): WindowSnapViewModelResult {
    const focused = focusedWindow(this.#model, this.#constraints(workArea));
    const state = this.#stateForWorkArea(workArea, null);

    if (!focused.ok) {
      return this.#reject(focused.error, state);
    }

    const nextRestore = new Map<WindowId, Rect>(this.#restoreRects);
    let nextModel: WindowModel;

    if (command === "restore") {
      nextModel = restoreWindow(this.#model, focused.value.windowId, nextRestore);
    } else if (command === "maximize") {
      rememberRestoreRect(nextRestore, focused.value);
      nextModel = maximizeWindow(this.#model, focused.value.windowId, true);
    } else {
      rememberRestoreRect(nextRestore, focused.value);
      nextModel = moveResizeWindow(
        this.#model,
        focused.value.windowId,
        targetRectForCommand(command, workArea, focused.value.placement.rect),
      );
    }

    return this.#commit(nextModel, nextRestore, command, workArea);
  }

  #commit(
    nextModel: WindowModel,
    nextRestore: ReadonlyMap<WindowId, Rect>,
    command: WindowSnapCommand,
    workArea: Rect,
  ): WindowSnapViewModelResult {
    const constraints = this.#constraints(workArea);
    const intents = collectWindowManagerIntents(this.#model, nextModel, constraints);

    try {
      emitWindowSnapIntents(this.#wm, intents);
    } catch (caught) {
      return this.#reject(error(
        "WM_INTENT_FAILED",
        errorMessage(caught, "window manager intent failed closed."),
        "/wm",
      ), this.#stateForWorkArea(workArea, null));
    }

    this.#model = nextModel;
    this.#restoreRects = nextRestore;
    this.#lastCommand = command;
    this.#lastIntents = intents;

    const state = this.#stateForWorkArea(workArea, null);

    return Object.freeze({
      command,
      intents,
      ok: true,
      placement: state.focusedPlacement,
      state,
    });
  }

  #constraints(workArea: Rect): LayoutConstraints {
    const output: {
      bounds: Rect;
      minHeight?: number;
      minWidth?: number;
      workspaceId: WorkspaceId;
    } = {
      bounds: workArea,
      workspaceId: this.#model.activeWorkspaceId,
    };

    if (this.#minHeight !== undefined) {
      output.minHeight = this.#minHeight;
    }
    if (this.#minWidth !== undefined) {
      output.minWidth = this.#minWidth;
    }

    return Object.freeze(output);
  }

  #stateForDisplayError(errorValue: WindowSnapViewModelError): WindowSnapViewModelState {
    return Object.freeze({
      activeWindowId: focusedWindowId(this.#model),
      error: errorValue,
      focusedPlacement: null,
      intentCount: this.#lastIntents.length,
      lastCommand: this.#lastCommand,
      lastIntentTypes: lastIntentTypes(this.#lastIntents),
      placements: Object.freeze([]),
      ready: false,
      restoreAvailable: false,
      workArea: null,
      zones: Object.freeze([]),
    });
  }

  #stateForWorkArea(
    workArea: Rect,
    errorValue: WindowSnapViewModelError | null,
  ): WindowSnapViewModelState {
    const constraints = this.#constraints(workArea);
    const placements = layout(this.#model, constraints);
    const activeWindowId = focusedWindowId(this.#model);
    const activePlacement = activeWindowId === null ? undefined : findPlacement(placements, activeWindowId);
    const activeWindow = activeWindowId === null ? undefined : findWindow(this.#model, activeWindowId);
    const restoreAvailable = activeWindowId !== null &&
      (this.#restoreRects.has(activeWindowId) || activeWindow?.maximized === true);

    return Object.freeze({
      activeWindowId,
      error: errorValue,
      focusedPlacement: activePlacement ?? null,
      intentCount: this.#lastIntents.length,
      lastCommand: this.#lastCommand,
      lastIntentTypes: lastIntentTypes(this.#lastIntents),
      placements,
      ready: errorValue === null && activePlacement !== undefined,
      restoreAvailable,
      workArea,
      zones: snapZones(workArea, this.#edgeThreshold),
    });
  }

  #reject(
    errorValue: WindowSnapViewModelError,
    state: WindowSnapViewModelState,
  ): WindowSnapViewModelResult {
    return Object.freeze({
      error: errorValue,
      intents: Object.freeze([]) as readonly [],
      ok: false,
      placement: null,
      state,
    });
  }
}

export function createWindowSnapViewModel(options: WindowSnapViewModelOptions): WindowSnapViewModel {
  return new WindowSnapViewModel(options);
}

export function createStaticWindowSnapDisplayPort(workArea: Rect): WindowSnapDisplayPort {
  return Object.freeze({
    activeWorkArea(): Rect {
      return workArea;
    },
  });
}

export function createInitialWindowSnapModel(options: {
  readonly activeWorkspaceId?: WorkspaceId;
  readonly rect?: Rect;
  readonly textureId?: TextureId;
  readonly windowId?: WindowId;
  readonly workspaces?: readonly WorkspaceState[];
} = Object.freeze({})): WindowModel {
  const workspaceId = options.activeWorkspaceId ?? DEFAULT_WORKSPACE_ID;
  const windowId = options.windowId ?? DEFAULT_WINDOW_ID;
  const textureId = options.textureId ?? DEFAULT_TEXTURE_ID;
  const workspaces = options.workspaces ?? Object.freeze([
    Object.freeze({
      id: workspaceId,
      layout: "floating",
    }) satisfies WorkspaceState,
  ]);

  return createWindowModel({
    activeWorkspaceId: workspaceId,
    focusStack: Object.freeze([windowId]),
    windows: Object.freeze([
      Object.freeze({
        id: windowId,
        maximized: false,
        minimized: false,
        mode: "floating",
        order: 0,
        rect: freezeRect(options.rect ?? DEFAULT_WINDOW_RECT),
        textureId,
        workspaceId,
      }) satisfies WindowState,
    ]),
    workspaces,
  });
}

function focusedWindow(
  model: WindowModel,
  constraints: LayoutConstraints,
): NormalizeResult<FocusedWindowSnapshot> {
  const windowId = focusedWindowId(model);

  if (windowId === null) {
    return reject(error("NO_FOCUSED_WINDOW", "snap command requires a focused window.", "/window/focus"));
  }

  const placement = findPlacement(layout(model, constraints), windowId);
  const window = findWindow(model, windowId);

  if (placement === undefined || window === undefined) {
    return reject(error("NO_FOCUSED_WINDOW", "focused window is not visible in the active workspace.", "/window/focus"));
  }

  return accept(Object.freeze({
    placement,
    window,
    windowId,
  }));
}

function restoreWindow(
  model: WindowModel,
  windowId: WindowId,
  restoreRects: Map<WindowId, Rect>,
): WindowModel {
  const restoreRect = restoreRects.get(windowId);

  if (restoreRect !== undefined) {
    restoreRects.delete(windowId);
    return moveResizeWindow(model, windowId, restoreRect);
  }

  const window = findWindow(model, windowId);

  if (window?.maximized === true) {
    return maximizeWindow(model, windowId, false);
  }

  return model;
}

function rememberRestoreRect(
  restoreRects: Map<WindowId, Rect>,
  focused: FocusedWindowSnapshot,
): void {
  if (restoreRects.has(focused.windowId)) {
    return;
  }

  restoreRects.set(focused.windowId, freezeRect(
    focused.window.maximized ? focused.window.rect : focused.placement.rect,
  ));
}

function readActiveWorkArea(display: WindowSnapDisplayPort): NormalizeResult<Rect> {
  try {
    return normalizeRect(display.activeWorkArea(), "/display/workArea", "DISPLAY_UNAVAILABLE");
  } catch {
    return reject(error("DISPLAY_UNAVAILABLE", "active display work area is unavailable.", "/display/workArea"));
  }
}

function normalizeSnapCommand(input: unknown, path: string): NormalizeResult<WindowSnapCommand> {
  if (typeof input !== "string") {
    return reject(error("INVALID_SNAP_COMMAND", "snap command must be a string.", path));
  }

  const normalized = canonicalToken(input);

  switch (normalized) {
    case "left":
    case "left-half":
    case "half-left":
    case "west":
      return accept("left-half");
    case "right":
    case "right-half":
    case "half-right":
    case "east":
      return accept("right-half");
    case "top":
    case "top-half":
    case "half-top":
    case "north":
      return accept("top-half");
    case "bottom":
    case "bottom-half":
    case "half-bottom":
    case "south":
      return accept("bottom-half");
    case "top-left":
    case "topleft":
    case "north-west":
    case "northwest":
      return accept("top-left");
    case "top-right":
    case "topright":
    case "north-east":
    case "northeast":
      return accept("top-right");
    case "bottom-left":
    case "bottomleft":
    case "south-west":
    case "southwest":
      return accept("bottom-left");
    case "bottom-right":
    case "bottomright":
    case "south-east":
    case "southeast":
      return accept("bottom-right");
    case "center":
    case "centre":
      return accept("center");
    case "max":
    case "maximize":
    case "maximise":
    case "fullscreen":
      return accept("maximize");
    case "restore":
    case "unsnap":
    case "unmaximize":
    case "unmaximise":
      return accept("restore");
  }

  return reject(error("INVALID_SNAP_COMMAND", "snap command is not supported.", path));
}

function normalizeKeyboardChord(input: unknown): NormalizeResult<WindowSnapCommand> {
  if (typeof input !== "string") {
    return reject(error("INVALID_KEYBOARD_CHORD", "keyboard chord must be a string.", "/keyboard/chord"));
  }

  const tokens = input.split("+");
  let hasSuper = false;
  let hasShift = false;
  let hasAlt = false;
  let hasCtrl = false;
  let left = false;
  let right = false;
  let up = false;
  let down = false;
  let center = false;
  let maximize = false;
  let restore = false;

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];

    if (token === undefined) {
      continue;
    }

    switch (canonicalToken(token)) {
      case "super":
      case "meta":
      case "cmd":
      case "command":
      case "win":
      case "windows":
        hasSuper = true;
        break;
      case "shift":
        hasShift = true;
        break;
      case "alt":
      case "option":
        hasAlt = true;
        break;
      case "ctrl":
      case "control":
        hasCtrl = true;
        break;
      case "left":
      case "arrowleft":
        left = true;
        break;
      case "right":
      case "arrowright":
        right = true;
        break;
      case "up":
      case "arrowup":
        up = true;
        break;
      case "down":
      case "arrowdown":
        down = true;
        break;
      case "enter":
      case "return":
      case "space":
      case "c":
      case "center":
      case "centre":
        center = true;
        break;
      case "max":
      case "maximize":
      case "maximise":
        maximize = true;
        break;
      case "restore":
      case "unsnap":
        restore = true;
        break;
      case "":
        return reject(error("INVALID_KEYBOARD_CHORD", "keyboard chord contains an empty key.", "/keyboard/chord"));
      default:
        return reject(error("INVALID_KEYBOARD_CHORD", "keyboard chord contains an unsupported key.", "/keyboard/chord"));
    }
  }

  if (!hasSuper) {
    return reject(error("INVALID_KEYBOARD_CHORD", "keyboard chord must include the super modifier.", "/keyboard/chord"));
  }
  if ((left && right) || (up && down)) {
    return reject(error("INVALID_KEYBOARD_CHORD", "keyboard chord has conflicting directions.", "/keyboard/chord"));
  }
  if (center) return accept("center");
  if (maximize) return accept("maximize");
  if (restore) return accept("restore");
  if (left && up) return accept("top-left");
  if (right && up) return accept("top-right");
  if (left && down) return accept("bottom-left");
  if (right && down) return accept("bottom-right");
  if (left) return accept("left-half");
  if (right) return accept("right-half");
  if (up && (hasShift || hasAlt)) return accept("top-half");
  if (down && (hasShift || hasAlt)) return accept("bottom-half");
  if (up && hasCtrl) return accept("center");
  if (down && hasCtrl) return accept("restore");
  if (up) return accept("maximize");
  if (down) return accept("restore");

  return reject(error("INVALID_KEYBOARD_CHORD", "keyboard chord does not map to a snap command.", "/keyboard/chord"));
}

function normalizePoint(input: unknown): NormalizeResult<Readonly<{ x: number; y: number }>> {
  const object = snapshotObject(input, POINT_FIELDS, "/snap/pointer", "INVALID_POINTER");

  if (!object.ok) {
    return object;
  }

  const x = finiteNumber(object.value.get("x"));
  const y = finiteNumber(object.value.get("y"));

  if (x === null) {
    return reject(error("INVALID_POINTER", "pointer x must be finite.", "/snap/pointer/x"));
  }
  if (y === null) {
    return reject(error("INVALID_POINTER", "pointer y must be finite.", "/snap/pointer/y"));
  }

  return accept(Object.freeze({
    x: Math.trunc(x),
    y: Math.trunc(y),
  }));
}

function normalizeRect(
  input: unknown,
  path: string,
  code: WindowSnapViewModelError["code"],
): NormalizeResult<Rect> {
  const object = snapshotObject(input, RECT_FIELDS, path, code);

  if (!object.ok) {
    return object;
  }

  const x = finiteNumber(object.value.get("x"));
  const y = finiteNumber(object.value.get("y"));
  const width = positiveFiniteNumber(object.value.get("width"));
  const height = positiveFiniteNumber(object.value.get("height"));

  if (x === null) {
    return reject(error(code, "rect x must be finite.", `${path}/x`));
  }
  if (y === null) {
    return reject(error(code, "rect y must be finite.", `${path}/y`));
  }
  if (width === null) {
    return reject(error(code, "rect width must be positive and finite.", `${path}/width`));
  }
  if (height === null) {
    return reject(error(code, "rect height must be positive and finite.", `${path}/height`));
  }

  return accept(Object.freeze({
    height: Math.trunc(height),
    width: Math.trunc(width),
    x: Math.trunc(x),
    y: Math.trunc(y),
  }));
}

function snapshotObject(
  input: unknown,
  allowedKeys: readonly string[],
  path: string,
  code: WindowSnapViewModelError["code"],
): NormalizeResult<ReadonlyMap<string, unknown>> {
  try {
    if (input === null || typeof input !== "object" || Array.isArray(input)) {
      return reject(error(code, "value must be a plain object.", path));
    }

    const prototype = Object.getPrototypeOf(input);

    if (prototype !== Object.prototype && prototype !== null) {
      return reject(error(code, "value must be a plain object.", path));
    }

    const keys = Reflect.ownKeys(input);
    const output = new Map<string, unknown>();

    for (let index = 0; index < keys.length; index += 1) {
      const key = keys[index];

      if (key === undefined || typeof key === "symbol" || !contains(allowedKeys, key)) {
        return reject(error(code, "object contains an unsupported field.", path));
      }

      const descriptor = Object.getOwnPropertyDescriptor(input, key);

      if (descriptor === undefined || !isDataDescriptor(descriptor) || descriptor.enumerable !== true) {
        return reject(error(code, "object must contain only enumerable data fields.", path));
      }

      output.set(key, descriptor.value);
    }

    return accept(output);
  } catch {
    return reject(error(code, "value must be a stable plain object.", path));
  }
}

function targetRectForCommand(command: Exclude<WindowSnapCommand, "maximize" | "restore">, workArea: Rect, current: Rect): Rect {
  if (command === "center") {
    return centerRect(current, workArea);
  }

  return targetRectForZone(command, workArea);
}

function targetRectForZone(zone: WindowSnapZone, workArea: Rect): Rect {
  const split = splitWorkArea(workArea);

  switch (zone) {
    case "left-half":
      return freezeRect({
        height: workArea.height,
        width: split.leftWidth,
        x: workArea.x,
        y: workArea.y,
      });
    case "right-half":
      return freezeRect({
        height: workArea.height,
        width: split.rightWidth,
        x: split.rightX,
        y: workArea.y,
      });
    case "top-half":
      return freezeRect({
        height: split.topHeight,
        width: workArea.width,
        x: workArea.x,
        y: workArea.y,
      });
    case "bottom-half":
      return freezeRect({
        height: split.bottomHeight,
        width: workArea.width,
        x: workArea.x,
        y: split.bottomY,
      });
    case "top-left":
      return freezeRect({
        height: split.topHeight,
        width: split.leftWidth,
        x: workArea.x,
        y: workArea.y,
      });
    case "top-right":
      return freezeRect({
        height: split.topHeight,
        width: split.rightWidth,
        x: split.rightX,
        y: workArea.y,
      });
    case "bottom-left":
      return freezeRect({
        height: split.bottomHeight,
        width: split.leftWidth,
        x: workArea.x,
        y: split.bottomY,
      });
    case "bottom-right":
      return freezeRect({
        height: split.bottomHeight,
        width: split.rightWidth,
        x: split.rightX,
        y: split.bottomY,
      });
  }

  return unreachableZone(zone);
}

function centerRect(current: Rect, workArea: Rect): Rect {
  const width = Math.min(Math.max(1, Math.trunc(current.width)), workArea.width);
  const height = Math.min(Math.max(1, Math.trunc(current.height)), workArea.height);

  return freezeRect({
    height,
    width,
    x: workArea.x + Math.floor((workArea.width - width) / 2),
    y: workArea.y + Math.floor((workArea.height - height) / 2),
  });
}

function splitWorkArea(workArea: Rect): {
  readonly bottomHeight: number;
  readonly bottomY: number;
  readonly leftWidth: number;
  readonly rightWidth: number;
  readonly rightX: number;
  readonly topHeight: number;
} {
  const leftWidth = Math.max(1, Math.floor(workArea.width / 2));
  const rightWidth = Math.max(1, workArea.width - leftWidth);
  const topHeight = Math.max(1, Math.floor(workArea.height / 2));
  const bottomHeight = Math.max(1, workArea.height - topHeight);

  return Object.freeze({
    bottomHeight,
    bottomY: workArea.y + Math.max(0, workArea.height - bottomHeight),
    leftWidth,
    rightWidth,
    rightX: workArea.x + Math.max(0, workArea.width - rightWidth),
    topHeight,
  });
}

function zoneForPoint(
  point: Readonly<{ x: number; y: number }>,
  workArea: Rect,
  threshold: number,
): WindowSnapZone | null {
  if (!pointInside(point, workArea)) {
    return null;
  }

  const left = point.x - workArea.x <= threshold;
  const right = workArea.x + workArea.width - point.x <= threshold;
  const top = point.y - workArea.y <= threshold;
  const bottom = workArea.y + workArea.height - point.y <= threshold;

  if (left && top) return "top-left";
  if (right && top) return "top-right";
  if (left && bottom) return "bottom-left";
  if (right && bottom) return "bottom-right";
  if (left) return "left-half";
  if (right) return "right-half";
  if (top) return "top-half";
  if (bottom) return "bottom-half";

  return null;
}

function pointInside(point: Readonly<{ x: number; y: number }>, rect: Rect): boolean {
  return point.x >= rect.x &&
    point.y >= rect.y &&
    point.x <= rect.x + rect.width &&
    point.y <= rect.y + rect.height;
}

function snapZones(workArea: Rect, edgeThreshold: number): readonly WindowSnapZoneState[] {
  const zones = WINDOW_SNAP_ZONES.map((zone) => Object.freeze({
    id: zone,
    kind: zoneKind(zone),
    rect: targetRectForZone(zone, workArea),
    triggerRect: triggerRectForZone(zone, workArea, edgeThreshold),
  }) satisfies WindowSnapZoneState);

  return Object.freeze(zones);
}

function zoneKind(zone: WindowSnapZone): "corner" | "edge" {
  switch (zone) {
    case "bottom-left":
    case "bottom-right":
    case "top-left":
    case "top-right":
      return "corner";
    case "bottom-half":
    case "left-half":
    case "right-half":
    case "top-half":
      return "edge";
  }

  return unreachableZone(zone);
}

function triggerRectForZone(zone: WindowSnapZone, workArea: Rect, edgeThreshold: number): Rect {
  const threshold = Math.min(edgeThreshold, Math.max(workArea.width, workArea.height));
  const rightX = workArea.x + Math.max(0, workArea.width - threshold);
  const bottomY = workArea.y + Math.max(0, workArea.height - threshold);

  switch (zone) {
    case "left-half":
      return freezeRect({
        height: workArea.height,
        width: threshold,
        x: workArea.x,
        y: workArea.y,
      });
    case "right-half":
      return freezeRect({
        height: workArea.height,
        width: threshold,
        x: rightX,
        y: workArea.y,
      });
    case "top-half":
      return freezeRect({
        height: threshold,
        width: workArea.width,
        x: workArea.x,
        y: workArea.y,
      });
    case "bottom-half":
      return freezeRect({
        height: threshold,
        width: workArea.width,
        x: workArea.x,
        y: bottomY,
      });
    case "top-left":
      return freezeRect({
        height: threshold,
        width: threshold,
        x: workArea.x,
        y: workArea.y,
      });
    case "top-right":
      return freezeRect({
        height: threshold,
        width: threshold,
        x: rightX,
        y: workArea.y,
      });
    case "bottom-left":
      return freezeRect({
        height: threshold,
        width: threshold,
        x: workArea.x,
        y: bottomY,
      });
    case "bottom-right":
      return freezeRect({
        height: threshold,
        width: threshold,
        x: rightX,
        y: bottomY,
      });
  }

  return unreachableZone(zone);
}

function emitWindowSnapIntents(
  port: WindowSnapWindowManagerPort,
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
      default: {
        const unsupported: never = intent;
        throw new Error(`unsupported window manager intent: ${JSON.stringify(unsupported)}`);
      }
    }
  }
}

function findPlacement(
  placements: readonly WindowPlacement[],
  windowId: WindowId,
): WindowPlacement | undefined {
  for (let index = 0; index < placements.length; index += 1) {
    const placement = placements[index];

    if (placement !== undefined && placement.windowId === windowId) {
      return placement;
    }
  }

  return undefined;
}

function findWindow(model: WindowModel, windowId: WindowId): WindowState | undefined {
  for (let index = 0; index < model.windows.length; index += 1) {
    const window = model.windows[index];

    if (window !== undefined && window.id === windowId) {
      return window;
    }
  }

  return undefined;
}

function lastIntentTypes(intents: readonly WindowManagerIntent[]): readonly WindowManagerIntent["type"][] {
  return Object.freeze(intents.map((intent) => intent.type));
}

function freezeRect(rect: Rect): Rect {
  return Object.freeze({
    height: Math.max(0, Math.trunc(rect.height)),
    width: Math.max(0, Math.trunc(rect.width)),
    x: Math.trunc(rect.x),
    y: Math.trunc(rect.y),
  });
}

function canonicalToken(value: string): string {
  return value.trim().toLowerCase().replaceAll("_", "-").replaceAll(" ", "-");
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

function normalizePositiveInteger(input: number | undefined, fallback: number): number {
  if (input === undefined || !Number.isFinite(input) || input <= 0) {
    return fallback;
  }

  return Math.trunc(input);
}

function normalizeOptionalPositiveInteger(input: number | undefined): number | undefined {
  if (input === undefined || !Number.isFinite(input) || input <= 0) {
    return undefined;
  }

  return Math.trunc(input);
}

function error(
  code: WindowSnapViewModelError["code"],
  message: string,
  path: string,
): WindowSnapViewModelError {
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
  return Object.freeze({
    ok: true,
    value,
  });
}

function reject<T>(errorValue: WindowSnapViewModelError): NormalizeResult<T> {
  return Object.freeze({
    error: errorValue,
    ok: false,
  });
}

function unreachableZone(zone: never): never {
  throw new Error(`unsupported snap zone: ${String(zone)}`);
}
