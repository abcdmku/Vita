import {
  createWindowModel,
  focusWindow as sdkFocusWindow,
} from "../../../sdk/typescript/src/desktop-sdk/index.ts";
import type {
  WindowId,
  WindowManagerEvent,
  WindowModel,
  WindowState,
  WorkspaceId,
} from "../../../sdk/typescript/src/desktop-sdk/index.ts";

export interface AppSwitcherEntry {
  readonly focused: boolean;
  readonly highlighted: boolean;
  readonly index: number;
  readonly windowId: WindowId;
  readonly workspaceId: WorkspaceId;
}

export interface AppSwitcherViewModelState {
  readonly entries: readonly AppSwitcherEntry[];
  readonly highlightedIndex: number | null;
  readonly highlightedWindowId: WindowId | null;
  readonly mru: readonly AppSwitcherEntry[];
  readonly mruWindowIds: readonly WindowId[];
  readonly open: boolean;
  readonly originalWindowId: WindowId | null;
}

export type AppSwitcherWindowManagerIntent = Extract<WindowManagerEvent, { readonly type: "focus" }>;

export interface AppSwitcherViewModelError {
  readonly code:
    | "EMPTY_WINDOW_MODEL"
    | "INVALID_WINDOW"
    | "NO_ACTIVE_SESSION"
    | "SESSION_ACTIVE"
    | "WM_INTENT_FAILED"
    | "WM_READ_FAILED";
  readonly message: string;
  readonly path: string;
}

export type AppSwitcherViewModelResult =
  | {
      readonly intents: readonly AppSwitcherWindowManagerIntent[];
      readonly ok: true;
      readonly state: AppSwitcherViewModelState;
    }
  | {
      readonly error: AppSwitcherViewModelError;
      readonly intents: readonly [];
      readonly ok: false;
      readonly state: AppSwitcherViewModelState;
    };

export interface AppSwitcherWindowManagerPortError {
  readonly code: string;
  readonly message: string;
  readonly path: string;
}

export type AppSwitcherWindowManagerPortResult<T> =
  | {
      readonly ok: true;
      readonly value: T;
    }
  | {
      readonly error: AppSwitcherWindowManagerPortError;
      readonly ok: false;
    };

export interface AppSwitcherWindowManagerPort {
  applyWindowManagerIntents(
    intents: readonly AppSwitcherWindowManagerIntent[],
  ): AppSwitcherWindowManagerPortResult<WindowModel>;
  readWindowModel(): AppSwitcherWindowManagerPortResult<WindowModel>;
}

export interface AppSwitcherViewModelOptions {
  readonly initialModel?: WindowModel;
  readonly wm: AppSwitcherWindowManagerPort;
}

type NormalizeResult<T> =
  | {
      readonly ok: true;
      readonly value: T;
    }
  | {
      readonly error: AppSwitcherViewModelError;
      readonly ok: false;
    };

interface AppSwitcherSession {
  readonly highlightedIndex: number;
  readonly originalWindowId: WindowId;
  readonly windowIds: readonly WindowId[];
}

const EMPTY_APP_SWITCHER_INTENTS: readonly [] = Object.freeze([]);

export class AppSwitcherViewModel {
  readonly #wm: AppSwitcherWindowManagerPort;
  #lastKnownModel: WindowModel;
  #session: AppSwitcherSession | null = null;

  constructor(options: AppSwitcherViewModelOptions) {
    this.#wm = options.wm;

    const initial = readWindowModel(options.wm);

    this.#lastKnownModel = initial.ok
      ? initial.value
      : options.initialModel ?? createWindowModel();
  }

  snapshot(): AppSwitcherViewModelState {
    const read = readWindowModel(this.#wm);

    if (read.ok) {
      this.#lastKnownModel = read.value;
    }

    return this.#buildState(this.#lastKnownModel);
  }

  begin(): AppSwitcherViewModelResult {
    if (this.#session !== null) {
      return this.#reject(error(
        "SESSION_ACTIVE",
        "application switcher session is already active.",
        "/begin",
      ));
    }

    const read = this.#readForAction();

    if (!read.ok) {
      return this.#reject(read.error);
    }

    const windowIds = buildAppSwitcherMruWindowIds(read.value);
    const originalWindowId = windowIds[0];

    if (originalWindowId === undefined) {
      return this.#reject(error(
        "EMPTY_WINDOW_MODEL",
        "application switcher requires at least one window.",
        "/begin",
      ));
    }

    this.#session = freezeSession(
      originalWindowId,
      windowIds.length > 1 ? 1 : 0,
      windowIds,
    );

    return acceptAction(EMPTY_APP_SWITCHER_INTENTS, this.#buildState(this.#lastKnownModel));
  }

  cycleForward(): AppSwitcherViewModelResult {
    return this.#cycle(1, "/cycleForward");
  }

  cycleBack(): AppSwitcherViewModelResult {
    return this.#cycle(-1, "/cycleBack");
  }

  commit(): AppSwitcherViewModelResult {
    const session = this.#session;

    if (session === null) {
      return this.#reject(error(
        "NO_ACTIVE_SESSION",
        "application switcher session is not active.",
        "/commit",
      ));
    }

    const targetWindowId = session.windowIds[session.highlightedIndex];

    if (targetWindowId === undefined) {
      return this.#reject(error(
        "INVALID_WINDOW",
        "highlighted window is not present in the switcher session.",
        "/commit/windowId",
      ));
    }

    const read = this.#readForAction();

    if (!read.ok) {
      return this.#reject(read.error);
    }

    if (!hasWindow(read.value, targetWindowId)) {
      return this.#reject(error(
        "INVALID_WINDOW",
        "highlighted window is not present in the window model.",
        "/commit/windowId",
      ));
    }

    if (targetWindowId === session.originalWindowId) {
      this.#session = null;

      return acceptAction(EMPTY_APP_SWITCHER_INTENTS, this.#buildState(this.#lastKnownModel));
    }

    const intents = Object.freeze([
      Object.freeze({
        type: "focus",
        windowId: targetWindowId,
      }) satisfies AppSwitcherWindowManagerIntent,
    ]);
    const applied = applyWindowManagerIntents(this.#wm, intents);

    if (!applied.ok) {
      return this.#reject(error("WM_INTENT_FAILED", applied.error.message, applied.error.path));
    }

    this.#lastKnownModel = applied.value;
    this.#session = null;

    return acceptAction(intents, this.#buildState(this.#lastKnownModel));
  }

  cancel(): AppSwitcherViewModelResult {
    if (this.#session === null) {
      return this.#reject(error(
        "NO_ACTIVE_SESSION",
        "application switcher session is not active.",
        "/cancel",
      ));
    }

    this.#session = null;

    return acceptAction(EMPTY_APP_SWITCHER_INTENTS, this.#buildState(this.#lastKnownModel));
  }

  #cycle(direction: 1 | -1, path: string): AppSwitcherViewModelResult {
    const session = this.#session;

    if (session === null) {
      return this.#reject(error(
        "NO_ACTIVE_SESSION",
        "application switcher session is not active.",
        path,
      ));
    }

    this.#session = freezeSession(
      session.originalWindowId,
      modulo(session.highlightedIndex + direction, session.windowIds.length),
      session.windowIds,
    );

    return acceptAction(EMPTY_APP_SWITCHER_INTENTS, this.#buildState(this.#lastKnownModel));
  }

  #readForAction(): NormalizeResult<WindowModel> {
    const read = readWindowModel(this.#wm);

    if (!read.ok) {
      return reject(error("WM_READ_FAILED", read.error.message, read.error.path));
    }

    this.#lastKnownModel = read.value;

    return accept(read.value);
  }

  #buildState(model: WindowModel): AppSwitcherViewModelState {
    const currentMruWindowIds = buildAppSwitcherMruWindowIds(model);
    const session = this.#session;
    const open = session !== null;
    const orderedWindowIds = open ? session.windowIds : currentMruWindowIds;
    const highlightedWindowId = open
      ? session.windowIds[session.highlightedIndex] ?? null
      : null;
    const entries = buildEntries(model, orderedWindowIds, highlightedWindowId);
    const highlightedIndex = highlightedWindowId === null
      ? null
      : indexOfWindowId(entries, highlightedWindowId);
    const normalizedHighlightedIndex = highlightedIndex === -1 ? null : highlightedIndex;

    return Object.freeze({
      entries,
      highlightedIndex: normalizedHighlightedIndex,
      highlightedWindowId,
      mru: entries,
      mruWindowIds: Object.freeze(orderedWindowIds.filter((windowId) => hasWindow(model, windowId))),
      open,
      originalWindowId: session?.originalWindowId ?? null,
    });
  }

  #reject(errorValue: AppSwitcherViewModelError): AppSwitcherViewModelResult {
    return Object.freeze({
      error: errorValue,
      intents: EMPTY_APP_SWITCHER_INTENTS,
      ok: false,
      state: this.#buildState(this.#lastKnownModel),
    });
  }
}

export function createAppSwitcherViewModel(options: AppSwitcherViewModelOptions): AppSwitcherViewModel {
  return new AppSwitcherViewModel(options);
}

export function applyAppSwitcherWindowManagerIntents(
  model: WindowModel,
  intents: readonly AppSwitcherWindowManagerIntent[],
): WindowModel {
  let next = model;

  for (let index = 0; index < intents.length; index += 1) {
    const intent = intents[index];

    if (intent === undefined) {
      continue;
    }

    next = sdkFocusWindow(next, intent.windowId);
  }

  return next;
}

export function buildAppSwitcherMruWindowIds(model: WindowModel): readonly WindowId[] {
  const windowsById = windowsByWindowId(model.windows);
  const output: WindowId[] = [];
  const seen = new Set<WindowId>();

  for (let index = 0; index < model.focusStack.length; index += 1) {
    const windowId = model.focusStack[index];

    if (windowId !== undefined && !seen.has(windowId) && windowsById.has(windowId)) {
      output.push(windowId);
      seen.add(windowId);
    }
  }

  const windows = [...windowsById.values()];

  windows.sort(compareWindowsByStableKey);

  for (let index = 0; index < windows.length; index += 1) {
    const window = windows[index];

    if (window !== undefined && !seen.has(window.id)) {
      output.push(window.id);
      seen.add(window.id);
    }
  }

  return Object.freeze(output);
}

function buildEntries(
  model: WindowModel,
  windowIds: readonly WindowId[],
  highlightedWindowId: WindowId | null,
): readonly AppSwitcherEntry[] {
  const windowsById = windowsByWindowId(model.windows);
  const focusedWindowId = buildAppSwitcherMruWindowIds(model)[0] ?? null;
  const entries: AppSwitcherEntry[] = [];

  for (let index = 0; index < windowIds.length; index += 1) {
    const windowId = windowIds[index];

    if (windowId === undefined) {
      continue;
    }

    const window = windowsById.get(windowId);

    if (window === undefined) {
      continue;
    }

    entries.push(Object.freeze({
      focused: window.id === focusedWindowId,
      highlighted: window.id === highlightedWindowId,
      index: entries.length,
      windowId: window.id,
      workspaceId: window.workspaceId,
    }) satisfies AppSwitcherEntry);
  }

  return Object.freeze(entries);
}

function windowsByWindowId(windows: readonly WindowState[]): ReadonlyMap<WindowId, WindowState> {
  const output = new Map<WindowId, WindowState>();

  for (let index = 0; index < windows.length; index += 1) {
    const window = windows[index];

    if (window !== undefined && !output.has(window.id)) {
      output.set(window.id, window);
    }
  }

  return output;
}

function freezeSession(
  originalWindowId: WindowId,
  highlightedIndex: number,
  windowIds: readonly WindowId[],
): AppSwitcherSession {
  return Object.freeze({
    highlightedIndex,
    originalWindowId,
    windowIds: Object.freeze([...windowIds]),
  });
}

function hasWindow(model: WindowModel, windowId: WindowId): boolean {
  for (let index = 0; index < model.windows.length; index += 1) {
    if (model.windows[index]?.id === windowId) {
      return true;
    }
  }

  return false;
}

function indexOfWindowId(entries: readonly AppSwitcherEntry[], windowId: WindowId): number {
  for (let index = 0; index < entries.length; index += 1) {
    if (entries[index]?.windowId === windowId) {
      return index;
    }
  }

  return -1;
}

function readWindowModel(
  port: AppSwitcherWindowManagerPort,
): AppSwitcherWindowManagerPortResult<WindowModel> {
  try {
    return port.readWindowModel();
  } catch (caught) {
    return rejectPort("WM_READ_THROWN", errorMessage(caught, "window model read failed closed."), "/wm/read");
  }
}

function applyWindowManagerIntents(
  port: AppSwitcherWindowManagerPort,
  intents: readonly AppSwitcherWindowManagerIntent[],
): AppSwitcherWindowManagerPortResult<WindowModel> {
  try {
    return port.applyWindowManagerIntents(intents);
  } catch (caught) {
    return rejectPort("WM_INTENT_THROWN", errorMessage(caught, "window manager intent failed closed."), "/wm/intents");
  }
}

function error(
  code: AppSwitcherViewModelError["code"],
  message: string,
  path: string,
): AppSwitcherViewModelError {
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
  intents: readonly AppSwitcherWindowManagerIntent[],
  state: AppSwitcherViewModelState,
): AppSwitcherViewModelResult {
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

function reject<T>(errorValue: AppSwitcherViewModelError): NormalizeResult<T> {
  return {
    error: errorValue,
    ok: false,
  };
}

function rejectPort<T>(
  code: string,
  message: string,
  path: string,
): AppSwitcherWindowManagerPortResult<T> {
  return Object.freeze({
    error: Object.freeze({
      code,
      message,
      path,
    }),
    ok: false,
  });
}

function modulo(value: number, modulus: number): number {
  if (modulus <= 0) {
    return 0;
  }

  return ((value % modulus) + modulus) % modulus;
}

function compareWindowsByStableKey(left: WindowState, right: WindowState): number {
  return compareStrings(left.id, right.id);
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
