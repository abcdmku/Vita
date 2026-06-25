import type {
  DesktopLauncherIntent,
} from "../../../sdk/typescript/src/desktop-sdk/index.ts";

export type ContextMenuRole = string | DesktopLauncherIntent;
export type ContextMenuVisibilityPredicate<Context> = (context: Context) => boolean;
export type ContextMenuDirection = "up" | "down";
export type ContextMenuActivationNoopReason =
  | "closed"
  | "disabled"
  | "missing-focus"
  | "missing-item";

export interface ContextMenu<Context, Role = ContextMenuRole> {
  readonly sections: readonly ContextMenuSection<Context, Role>[];
}

export interface ContextMenuSection<Context, Role = ContextMenuRole> {
  readonly id?: string;
  readonly items: readonly ContextMenuEntry<Context, Role>[];
}

export type ContextMenuEntry<Context, Role = ContextMenuRole> =
  | ContextMenuItem<Context, Role>
  | ContextMenuSeparator;

export interface ContextMenuItem<Context, Role = ContextMenuRole> {
  readonly kind?: "item";
  readonly id: string;
  readonly label: string;
  readonly role: Role;
  readonly icon?: string;
  readonly disabled?: boolean;
  readonly checked?: boolean;
  readonly destructive?: boolean;
  readonly submenu?: ContextMenu<Context, Role>;
  readonly visible?: ContextMenuVisibilityPredicate<Context>;
}

export interface ContextMenuSeparator {
  readonly kind: "separator";
  readonly id?: string;
}

export interface ContextMenuSnapshot<Role = ContextMenuRole> {
  readonly sections: readonly ContextMenuSnapshotSection<Role>[];
}

export interface ContextMenuSnapshotSection<Role = ContextMenuRole> {
  readonly id?: string;
  readonly items: readonly ContextMenuSnapshotEntry<Role>[];
}

export type ContextMenuSnapshotEntry<Role = ContextMenuRole> =
  | ContextMenuSnapshotItem<Role>
  | ContextMenuSnapshotSeparator;

export interface ContextMenuSnapshotItem<Role = ContextMenuRole> {
  readonly kind: "item";
  readonly id: string;
  readonly label: string;
  readonly role: Role;
  readonly disabled: boolean;
  readonly checked: boolean;
  readonly destructive: boolean;
  readonly icon?: string;
  readonly submenu?: ContextMenuSnapshot<Role>;
}

export interface ContextMenuSnapshotSeparator {
  readonly kind: "separator";
  readonly id?: string;
}

export interface ContextMenuRenderedLevel<Role = ContextMenuRole> {
  readonly path: readonly string[];
  readonly items: readonly ContextMenuRenderedEntry<Role>[];
}

export type ContextMenuRenderedEntry<Role = ContextMenuRole> =
  | ContextMenuRenderedItem<Role>
  | ContextMenuRenderedSeparator;

export interface ContextMenuRenderedItem<Role = ContextMenuRole> {
  readonly kind: "item";
  readonly id: string;
  readonly label: string;
  readonly role: Role;
  readonly disabled: boolean;
  readonly checked: boolean;
  readonly destructive: boolean;
  readonly hasSubmenu: boolean;
  readonly path: readonly string[];
  readonly level: number;
  readonly levelPath: readonly string[];
  readonly sectionIndex: number;
  readonly itemIndex: number;
  readonly renderIndex: number;
  readonly icon?: string;
  readonly sectionId?: string;
}

export interface ContextMenuRenderedSeparator {
  readonly kind: "separator";
  readonly id: string;
  readonly path: readonly string[];
  readonly level: number;
  readonly levelPath: readonly string[];
  readonly sectionIndex: number;
  readonly itemIndex: number;
  readonly renderIndex: number;
  readonly sectionId?: string;
}

export interface ContextMenuCursor {
  readonly itemId: string;
  readonly index: number;
  readonly path: readonly string[];
  readonly levelPath: readonly string[];
}

export type ContextMenuState<Context, Role = ContextMenuRole> =
  | ContextMenuOpenState<Context, Role>
  | ContextMenuClosedState<Role>;

export interface ContextMenuOpenState<Context, Role = ContextMenuRole> {
  readonly open: true;
  readonly menu: ContextMenuSnapshot<Role>;
  readonly context: Context;
  readonly openSubmenuPath: readonly string[];
  readonly focusedCursor: ContextMenuCursor | null;
  readonly levels: readonly ContextMenuRenderedLevel<Role>[];
  readonly items: readonly ContextMenuRenderedEntry<Role>[];
}

export interface ContextMenuClosedState<Role = ContextMenuRole> {
  readonly open: false;
  readonly menu: null;
  readonly context: null;
  readonly openSubmenuPath: readonly string[];
  readonly focusedCursor: null;
  readonly levels: readonly ContextMenuRenderedLevel<Role>[];
  readonly items: readonly ContextMenuRenderedEntry<Role>[];
}

export interface ContextMenuError {
  readonly code: string;
  readonly message: string;
  readonly path: string;
}

export type ContextMenuRoleInvoker<Context, Role = ContextMenuRole, Value = unknown> = (
  role: Role,
  item: ContextMenuRenderedItem<Role>,
  context: Context,
) => Value;

export type ContextMenuActivationResult<Context, Role = ContextMenuRole, Value = unknown> =
  | {
      readonly ok: true;
      readonly activated: true;
      readonly item: ContextMenuRenderedItem<Role>;
      readonly role: Role;
      readonly state: ContextMenuState<Context, Role>;
      readonly value?: Value;
    }
  | {
      readonly ok: true;
      readonly activated: false;
      readonly reason: ContextMenuActivationNoopReason;
      readonly state: ContextMenuState<Context, Role>;
      readonly item?: ContextMenuRenderedItem<Role>;
    }
  | {
      readonly ok: false;
      readonly activated: false;
      readonly error: ContextMenuError;
      readonly state: ContextMenuState<Context, Role>;
      readonly item: ContextMenuRenderedItem<Role>;
      readonly role: Role;
    };

export type ContextMenuAction<Context, Role = ContextMenuRole> =
  | ContextMenuOpenAction<Context, Role>
  | ContextMenuCloseAction
  | ContextMenuOpenSubmenuAction
  | ContextMenuCloseSubmenuAction
  | ContextMenuMoveUpAction
  | ContextMenuMoveDownAction
  | ContextMenuActivateAction
  | ContextMenuEscapeAction;

export interface ContextMenuOpenAction<Context, Role = ContextMenuRole> {
  readonly type: "open";
  readonly menu: ContextMenu<Context, Role>;
  readonly context: Context;
}

export interface ContextMenuCloseAction {
  readonly type: "close";
}

export interface ContextMenuOpenSubmenuAction {
  readonly type: "openSubmenu";
  readonly id: string;
}

export interface ContextMenuCloseSubmenuAction {
  readonly type: "closeSubmenu";
}

export interface ContextMenuMoveUpAction {
  readonly type: "moveUp";
}

export interface ContextMenuMoveDownAction {
  readonly type: "moveDown";
}

export interface ContextMenuActivateAction {
  readonly type: "activate";
}

export interface ContextMenuEscapeAction {
  readonly type: "escape";
}

export interface ContextMenuReducerOptions<Context, Role = ContextMenuRole, Value = unknown> {
  readonly invokeRole?: ContextMenuRoleInvoker<Context, Role, Value>;
}

export interface ContextMenuTransition<Context, Role = ContextMenuRole, Value = unknown> {
  readonly state: ContextMenuState<Context, Role>;
  readonly activation?: ContextMenuActivationResult<Context, Role, Value>;
}

export interface ContextMenuViewModel<Context, Role = ContextMenuRole, Value = unknown> {
  snapshot(): ContextMenuState<Context, Role>;
  open(menu: ContextMenu<Context, Role>, context: Context): ContextMenuState<Context, Role>;
  close(): ContextMenuState<Context, Role>;
  openSubmenu(id: string): ContextMenuState<Context, Role>;
  closeSubmenu(): ContextMenuState<Context, Role>;
  moveUp(): ContextMenuState<Context, Role>;
  moveDown(): ContextMenuState<Context, Role>;
  activate(): ContextMenuActivationResult<Context, Role, Value>;
  escape(): ContextMenuState<Context, Role>;
  reduce(action: ContextMenuAction<Context, Role>): ContextMenuTransition<Context, Role, Value>;
}

export interface ContextMenuViewModelOptions<Context, Role = ContextMenuRole, Value = unknown> {
  readonly invokeRole?: ContextMenuRoleInvoker<Context, Role, Value>;
}

interface RenderedLevels<Role> {
  readonly openSubmenuPath: readonly string[];
  readonly levels: readonly ContextMenuRenderedLevel<Role>[];
}

export const contextMenuActions = Object.freeze({
  activate(): ContextMenuActivateAction {
    return Object.freeze({
      type: "activate",
    });
  },
  close(): ContextMenuCloseAction {
    return Object.freeze({
      type: "close",
    });
  },
  closeSubmenu(): ContextMenuCloseSubmenuAction {
    return Object.freeze({
      type: "closeSubmenu",
    });
  },
  escape(): ContextMenuEscapeAction {
    return Object.freeze({
      type: "escape",
    });
  },
  moveDown(): ContextMenuMoveDownAction {
    return Object.freeze({
      type: "moveDown",
    });
  },
  moveUp(): ContextMenuMoveUpAction {
    return Object.freeze({
      type: "moveUp",
    });
  },
  open<Context, Role = ContextMenuRole>(
    menu: ContextMenu<Context, Role>,
    context: Context,
  ): ContextMenuAction<Context, Role> {
    return Object.freeze({
      context,
      menu,
      type: "open",
    });
  },
  openSubmenu(id: string): ContextMenuOpenSubmenuAction {
    return Object.freeze({
      id,
      type: "openSubmenu",
    });
  },
});

export function createContextMenuState<Context, Role = ContextMenuRole>(): ContextMenuState<Context, Role> {
  return freezeState<Context, Role>({
    context: null,
    focusedCursor: null,
    items: Object.freeze([]),
    levels: Object.freeze([]),
    menu: null,
    open: false,
    openSubmenuPath: Object.freeze([]),
  });
}

export function createContextMenuViewModel<Context, Role = ContextMenuRole, Value = unknown>(
  options: ContextMenuViewModelOptions<Context, Role, Value> = Object.freeze({}),
): ContextMenuViewModel<Context, Role, Value> {
  return new DesktopContextMenuViewModel(options);
}

export function normalizeContextMenu<Context, Role = ContextMenuRole>(
  menu: ContextMenu<Context, Role>,
  context: Context,
): ContextMenuSnapshot<Role> {
  const sections: ContextMenuSnapshotSection<Role>[] = [];

  for (let sectionIndex = 0; sectionIndex < menu.sections.length; sectionIndex += 1) {
    const section = menu.sections[sectionIndex];

    if (section === undefined) continue;
    sections.push(normalizeSection(section, context));
  }

  return Object.freeze({
    sections: Object.freeze(sections),
  });
}

export function flattenContextMenu<Context, Role = ContextMenuRole>(
  menu: ContextMenu<Context, Role>,
  context: Context,
): readonly ContextMenuRenderedEntry<Role>[] {
  const snapshot = normalizeContextMenu(menu, context);
  return renderLevel(snapshot, Object.freeze([])).items;
}

export function openContextMenu<Context, Role = ContextMenuRole>(
  menu: ContextMenu<Context, Role>,
  context: Context,
): ContextMenuState<Context, Role> {
  const snapshot = normalizeContextMenu(menu, context);
  const rendered = renderOpenLevels(snapshot, Object.freeze([]));
  const activeLevel = lastLevel(rendered.levels);

  return freezeState({
    context,
    focusedCursor: activeLevel === null ? null : firstFocusableCursor(activeLevel),
    items: activeLevel === null ? Object.freeze([]) : activeLevel.items,
    levels: rendered.levels,
    menu: snapshot,
    open: true,
    openSubmenuPath: rendered.openSubmenuPath,
  });
}

export function closeContextMenu<Context, Role = ContextMenuRole>(
  _state: ContextMenuState<Context, Role>,
): ContextMenuState<Context, Role> {
  return createContextMenuState();
}

export function openContextMenuSubmenu<Context, Role = ContextMenuRole>(
  state: ContextMenuState<Context, Role>,
  id: string,
): ContextMenuState<Context, Role> {
  if (!state.open || state.menu === null) return state;

  const activeLevel = lastLevel(state.levels);
  const item = activeLevel === null ? undefined : findRenderedItemById(activeLevel.items, id);

  if (item === undefined || item.disabled || !item.hasSubmenu) return state;

  return stateFromSnapshot(
    state.menu,
    state.context,
    Object.freeze([...state.openSubmenuPath, item.id]),
    null,
  );
}

export function closeContextMenuSubmenu<Context, Role = ContextMenuRole>(
  state: ContextMenuState<Context, Role>,
): ContextMenuState<Context, Role> {
  if (!state.open || state.menu === null || state.openSubmenuPath.length === 0) return state;

  const nextPath = state.openSubmenuPath.slice(0, -1);
  const parentFocusId = state.openSubmenuPath[state.openSubmenuPath.length - 1];
  const preferredCursor = parentFocusId === undefined
    ? null
    : Object.freeze({
      itemId: parentFocusId,
      index: -1,
      levelPath: Object.freeze(nextPath),
      path: Object.freeze([...nextPath, parentFocusId]),
    });

  return stateFromSnapshot(state.menu, state.context, Object.freeze(nextPath), preferredCursor);
}

export function moveContextMenuCursor<Context, Role = ContextMenuRole>(
  state: ContextMenuState<Context, Role>,
  direction: ContextMenuDirection,
): ContextMenuState<Context, Role> {
  if (!state.open || state.menu === null) return state;

  const activeLevel = lastLevel(state.levels);

  if (activeLevel === null) return state;

  const currentIndex = state.focusedCursor !== null && samePath(state.focusedCursor.levelPath, activeLevel.path)
    ? state.focusedCursor.index
    : direction === "down" ? -1 : activeLevel.items.length;
  const nextCursor = nextFocusableCursor(activeLevel, currentIndex, direction === "down" ? 1 : -1);

  return freezeState({
    context: state.context,
    focusedCursor: nextCursor,
    items: activeLevel.items,
    levels: state.levels,
    menu: state.menu,
    open: true,
    openSubmenuPath: state.openSubmenuPath,
  });
}

export function moveContextMenuCursorUp<Context, Role = ContextMenuRole>(
  state: ContextMenuState<Context, Role>,
): ContextMenuState<Context, Role> {
  return moveContextMenuCursor(state, "up");
}

export function moveContextMenuCursorDown<Context, Role = ContextMenuRole>(
  state: ContextMenuState<Context, Role>,
): ContextMenuState<Context, Role> {
  return moveContextMenuCursor(state, "down");
}

export function activateContextMenu<Context, Role = ContextMenuRole, Value = unknown>(
  state: ContextMenuState<Context, Role>,
  invokeRole?: ContextMenuRoleInvoker<Context, Role, Value>,
): ContextMenuActivationResult<Context, Role, Value> {
  if (!state.open) {
    return noopActivation<Context, Role, Value>("closed", state);
  }

  if (state.focusedCursor === null) {
    return noopActivation<Context, Role, Value>("missing-focus", state);
  }

  const activeLevel = lastLevel(state.levels);
  const item = activeLevel === null ? undefined : findRenderedItemByCursor(activeLevel.items, state.focusedCursor);

  if (item === undefined) {
    return noopActivation<Context, Role, Value>("missing-item", state);
  }

  if (item.disabled) {
    return noopActivation<Context, Role, Value>("disabled", state, item);
  }

  try {
    const activated: {
      ok: true;
      activated: true;
      item: ContextMenuRenderedItem<Role>;
      role: Role;
      state: ContextMenuState<Context, Role>;
      value?: Value;
    } = {
      activated: true,
      item,
      ok: true,
      role: item.role,
      state,
    };

    if (invokeRole !== undefined) {
      const value = invokeRole(item.role, item, state.context);

      if (value !== undefined) activated.value = value;
    }

    return Object.freeze(activated);
  } catch (error) {
    return Object.freeze({
      activated: false,
      error: Object.freeze({
        code: "ROLE_INVOKE_FAILED",
        message: errorMessage(error, "context-menu role invocation failed closed."),
        path: `/items/${pathToken(item.id)}/role`,
      }),
      item,
      ok: false,
      role: item.role,
      state,
    });
  }
}

export function escapeContextMenu<Context, Role = ContextMenuRole>(
  state: ContextMenuState<Context, Role>,
): ContextMenuState<Context, Role> {
  if (!state.open) return state;
  if (state.openSubmenuPath.length > 0) return closeContextMenuSubmenu(state);

  return closeContextMenu(state);
}

export function findContextMenuCursor<Context, Role = ContextMenuRole>(
  state: ContextMenuState<Context, Role>,
  id: string,
): ContextMenuCursor | null {
  const activeLevel = lastLevel(state.levels);
  const item = activeLevel === null ? undefined : findRenderedItemById(activeLevel.items, id);

  return item === undefined ? null : cursorForItem(item);
}

export function reduceContextMenu<Context, Role = ContextMenuRole, Value = unknown>(
  state: ContextMenuState<Context, Role>,
  action: ContextMenuAction<Context, Role>,
  options: ContextMenuReducerOptions<Context, Role, Value> = Object.freeze({}),
): ContextMenuTransition<Context, Role, Value> {
  switch (action.type) {
    case "open":
      return transition(openContextMenu(action.menu, action.context));
    case "close":
      return transition(closeContextMenu(state));
    case "openSubmenu":
      return transition(openContextMenuSubmenu(state, action.id));
    case "closeSubmenu":
      return transition(closeContextMenuSubmenu(state));
    case "moveUp":
      return transition(moveContextMenuCursorUp(state));
    case "moveDown":
      return transition(moveContextMenuCursorDown(state));
    case "escape":
      return transition(escapeContextMenu(state));
    case "activate": {
      const activation = activateContextMenu(state, options.invokeRole);

      return Object.freeze({
        activation,
        state: activation.state,
      });
    }
    default:
      return transition(state);
  }
}

export const open = openContextMenu;
export const close = closeContextMenu;
export const openSubmenu = openContextMenuSubmenu;
export const closeSubmenu = closeContextMenuSubmenu;
export const moveUp = moveContextMenuCursorUp;
export const moveDown = moveContextMenuCursorDown;
export const activate = activateContextMenu;
export const escape = escapeContextMenu;
export const reducer = reduceContextMenu;

class DesktopContextMenuViewModel<Context, Role = ContextMenuRole, Value = unknown>
implements ContextMenuViewModel<Context, Role, Value> {
  readonly #invokeRole: ContextMenuRoleInvoker<Context, Role, Value> | undefined;
  #state: ContextMenuState<Context, Role>;

  constructor(options: ContextMenuViewModelOptions<Context, Role, Value>) {
    this.#invokeRole = options.invokeRole;
    this.#state = createContextMenuState();
  }

  snapshot(): ContextMenuState<Context, Role> {
    return this.#state;
  }

  open(menu: ContextMenu<Context, Role>, context: Context): ContextMenuState<Context, Role> {
    this.#state = openContextMenu(menu, context);
    return this.#state;
  }

  close(): ContextMenuState<Context, Role> {
    this.#state = closeContextMenu(this.#state);
    return this.#state;
  }

  openSubmenu(id: string): ContextMenuState<Context, Role> {
    this.#state = openContextMenuSubmenu(this.#state, id);
    return this.#state;
  }

  closeSubmenu(): ContextMenuState<Context, Role> {
    this.#state = closeContextMenuSubmenu(this.#state);
    return this.#state;
  }

  moveUp(): ContextMenuState<Context, Role> {
    this.#state = moveContextMenuCursorUp(this.#state);
    return this.#state;
  }

  moveDown(): ContextMenuState<Context, Role> {
    this.#state = moveContextMenuCursorDown(this.#state);
    return this.#state;
  }

  activate(): ContextMenuActivationResult<Context, Role, Value> {
    const activation = activateContextMenu(this.#state, this.#invokeRole);

    this.#state = activation.state;
    return activation;
  }

  escape(): ContextMenuState<Context, Role> {
    this.#state = escapeContextMenu(this.#state);
    return this.#state;
  }

  reduce(action: ContextMenuAction<Context, Role>): ContextMenuTransition<Context, Role, Value> {
    const options: ContextMenuReducerOptions<Context, Role, Value> = this.#invokeRole === undefined
      ? Object.freeze({})
      : Object.freeze({
        invokeRole: this.#invokeRole,
      });
    const result = reduceContextMenu(this.#state, action, options);

    this.#state = result.state;
    return result;
  }
}

function normalizeSection<Context, Role>(
  section: ContextMenuSection<Context, Role>,
  context: Context,
): ContextMenuSnapshotSection<Role> {
  const items: ContextMenuSnapshotEntry<Role>[] = [];

  for (let itemIndex = 0; itemIndex < section.items.length; itemIndex += 1) {
    const item = section.items[itemIndex];

    if (item === undefined) continue;
    if (item.kind === "separator") {
      items.push(normalizeSeparator(item));
      continue;
    }

    if (isVisible(item, context)) {
      items.push(normalizeItem(item, context));
    }
  }

  const output: {
    id?: string;
    items: readonly ContextMenuSnapshotEntry<Role>[];
  } = {
    items: Object.freeze(items),
  };

  if (section.id !== undefined) output.id = section.id;
  return Object.freeze(output);
}

function normalizeItem<Context, Role>(
  item: ContextMenuItem<Context, Role>,
  context: Context,
): ContextMenuSnapshotItem<Role> {
  const output: {
    kind: "item";
    id: string;
    label: string;
    role: Role;
    disabled: boolean;
    checked: boolean;
    destructive: boolean;
    icon?: string;
    submenu?: ContextMenuSnapshot<Role>;
  } = {
    checked: item.checked === true,
    destructive: item.destructive === true,
    disabled: item.disabled === true,
    id: item.id,
    kind: "item",
    label: item.label,
    role: item.role,
  };

  if (item.icon !== undefined) output.icon = item.icon;
  if (item.submenu !== undefined) output.submenu = normalizeContextMenu(item.submenu, context);

  return Object.freeze(output);
}

function normalizeSeparator(separator: ContextMenuSeparator): ContextMenuSnapshotSeparator {
  const output: {
    kind: "separator";
    id?: string;
  } = {
    kind: "separator",
  };

  if (separator.id !== undefined) output.id = separator.id;
  return Object.freeze(output);
}

function isVisible<Context, Role>(item: ContextMenuItem<Context, Role>, context: Context): boolean {
  if (item.visible === undefined) return true;

  try {
    return item.visible(context) === true;
  } catch {
    return false;
  }
}

function renderOpenLevels<Role>(
  menu: ContextMenuSnapshot<Role>,
  requestedPath: readonly string[],
): RenderedLevels<Role> {
  const levels: ContextMenuRenderedLevel<Role>[] = [];
  const retainedPath: string[] = [];
  let currentMenu: ContextMenuSnapshot<Role> | undefined = menu;
  let levelPath: readonly string[] = Object.freeze([]);

  for (let depth = 0; currentMenu !== undefined; depth += 1) {
    const level = renderLevel(currentMenu, levelPath);

    levels.push(level);

    const nextId = requestedPath[depth];

    if (nextId === undefined) break;

    const nextItem: ContextMenuSnapshotItem<Role> | undefined = findSnapshotItemById(currentMenu, nextId);

    if (nextItem === undefined || nextItem.disabled || nextItem.submenu === undefined) break;

    retainedPath.push(nextItem.id);
    levelPath = Object.freeze([...retainedPath]);
    currentMenu = nextItem.submenu;
  }

  return Object.freeze({
    levels: Object.freeze(levels),
    openSubmenuPath: Object.freeze(retainedPath),
  });
}

function renderLevel<Role>(
  menu: ContextMenuSnapshot<Role>,
  levelPath: readonly string[],
): ContextMenuRenderedLevel<Role> {
  const items: ContextMenuRenderedEntry<Role>[] = [];

  for (let sectionIndex = 0; sectionIndex < menu.sections.length; sectionIndex += 1) {
    const section = menu.sections[sectionIndex];

    if (section === undefined) continue;

    for (let itemIndex = 0; itemIndex < section.items.length; itemIndex += 1) {
      const item = section.items[itemIndex];

      if (item === undefined) continue;
      if (item.kind === "separator") {
        items.push(renderSeparator(item, section, levelPath, sectionIndex, itemIndex, items.length));
      } else {
        items.push(renderItem(item, section, levelPath, sectionIndex, itemIndex, items.length));
      }
    }
  }

  return Object.freeze({
    items: Object.freeze(items),
    path: Object.freeze([...levelPath]),
  });
}

function renderItem<Role>(
  item: ContextMenuSnapshotItem<Role>,
  section: ContextMenuSnapshotSection<Role>,
  levelPath: readonly string[],
  sectionIndex: number,
  itemIndex: number,
  renderIndex: number,
): ContextMenuRenderedItem<Role> {
  const output: {
    kind: "item";
    id: string;
    label: string;
    role: Role;
    disabled: boolean;
    checked: boolean;
    destructive: boolean;
    hasSubmenu: boolean;
    path: readonly string[];
    level: number;
    levelPath: readonly string[];
    sectionIndex: number;
    itemIndex: number;
    renderIndex: number;
    icon?: string;
    sectionId?: string;
  } = {
    checked: item.checked,
    destructive: item.destructive,
    disabled: item.disabled,
    hasSubmenu: item.submenu !== undefined,
    id: item.id,
    itemIndex,
    kind: "item",
    label: item.label,
    level: levelPath.length,
    levelPath: Object.freeze([...levelPath]),
    path: Object.freeze([...levelPath, item.id]),
    renderIndex,
    role: item.role,
    sectionIndex,
  };

  if (item.icon !== undefined) output.icon = item.icon;
  if (section.id !== undefined) output.sectionId = section.id;
  return Object.freeze(output);
}

function renderSeparator<Role>(
  separator: ContextMenuSnapshotSeparator,
  section: ContextMenuSnapshotSection<Role>,
  levelPath: readonly string[],
  sectionIndex: number,
  itemIndex: number,
  renderIndex: number,
): ContextMenuRenderedSeparator {
  const id = separator.id ?? `separator:${sectionIndex}:${itemIndex}`;
  const output: {
    kind: "separator";
    id: string;
    path: readonly string[];
    level: number;
    levelPath: readonly string[];
    sectionIndex: number;
    itemIndex: number;
    renderIndex: number;
    sectionId?: string;
  } = {
    id,
    itemIndex,
    kind: "separator",
    level: levelPath.length,
    levelPath: Object.freeze([...levelPath]),
    path: Object.freeze([...levelPath, id]),
    renderIndex,
    sectionIndex,
  };

  if (section.id !== undefined) output.sectionId = section.id;
  return Object.freeze(output);
}

function stateFromSnapshot<Context, Role>(
  menu: ContextMenuSnapshot<Role>,
  context: Context,
  requestedPath: readonly string[],
  preferredCursor: ContextMenuCursor | null,
): ContextMenuState<Context, Role> {
  const rendered = renderOpenLevels(menu, requestedPath);
  const activeLevel = lastLevel(rendered.levels);
  const cursor = activeLevel === null
    ? null
    : validatedCursor(activeLevel, preferredCursor) ?? firstFocusableCursor(activeLevel);

  return freezeState({
    context,
    focusedCursor: cursor,
    items: activeLevel === null ? Object.freeze([]) : activeLevel.items,
    levels: rendered.levels,
    menu,
    open: true,
    openSubmenuPath: rendered.openSubmenuPath,
  });
}

function freezeState<Context, Role>(input: ContextMenuState<Context, Role>): ContextMenuState<Context, Role> {
  return Object.freeze(input);
}

function transition<Context, Role, Value = unknown>(
  state: ContextMenuState<Context, Role>,
): ContextMenuTransition<Context, Role, Value> {
  return Object.freeze({
    state,
  });
}

function lastLevel<Role>(
  levels: readonly ContextMenuRenderedLevel<Role>[],
): ContextMenuRenderedLevel<Role> | null {
  return levels[levels.length - 1] ?? null;
}

function firstFocusableCursor<Role>(level: ContextMenuRenderedLevel<Role>): ContextMenuCursor | null {
  return nextFocusableCursor(level, -1, 1);
}

function nextFocusableCursor<Role>(
  level: ContextMenuRenderedLevel<Role>,
  currentIndex: number,
  step: 1 | -1,
): ContextMenuCursor | null {
  if (level.items.length === 0) return null;

  for (let offset = 1; offset <= level.items.length; offset += 1) {
    const index = positiveModulo(currentIndex + offset * step, level.items.length);
    const item = level.items[index];

    if (item !== undefined && item.kind === "item" && !item.disabled) {
      return cursorForItem(item);
    }
  }

  return null;
}

function cursorForItem<Role>(item: ContextMenuRenderedItem<Role>): ContextMenuCursor {
  return Object.freeze({
    index: item.renderIndex,
    itemId: item.id,
    levelPath: item.levelPath,
    path: item.path,
  });
}

function validatedCursor<Role>(
  level: ContextMenuRenderedLevel<Role>,
  cursor: ContextMenuCursor | null,
): ContextMenuCursor | null {
  if (cursor === null || !samePath(cursor.levelPath, level.path)) return null;

  const item = findRenderedItemByCursor(level.items, cursor);

  return item === undefined ? null : cursorForItem(item);
}

function findRenderedItemById<Role>(
  items: readonly ContextMenuRenderedEntry<Role>[],
  id: string,
): ContextMenuRenderedItem<Role> | undefined {
  for (let index = 0; index < items.length; index += 1) {
    const item = items[index];

    if (item !== undefined && item.kind === "item" && item.id === id) return item;
  }

  return undefined;
}

function findRenderedItemByCursor<Role>(
  items: readonly ContextMenuRenderedEntry<Role>[],
  cursor: ContextMenuCursor,
): ContextMenuRenderedItem<Role> | undefined {
  const item = items[cursor.index];

  if (
    item !== undefined &&
    item.kind === "item" &&
    item.id === cursor.itemId &&
    samePath(item.path, cursor.path)
  ) {
    return item;
  }

  return findRenderedItemById(items, cursor.itemId);
}

function findSnapshotItemById<Role>(
  menu: ContextMenuSnapshot<Role>,
  id: string,
): ContextMenuSnapshotItem<Role> | undefined {
  for (let sectionIndex = 0; sectionIndex < menu.sections.length; sectionIndex += 1) {
    const section = menu.sections[sectionIndex];

    if (section === undefined) continue;

    for (let itemIndex = 0; itemIndex < section.items.length; itemIndex += 1) {
      const item = section.items[itemIndex];

      if (item !== undefined && item.kind === "item" && item.id === id) return item;
    }
  }

  return undefined;
}

function noopActivation<Context, Role, Value>(
  reason: ContextMenuActivationNoopReason,
  state: ContextMenuState<Context, Role>,
  item?: ContextMenuRenderedItem<Role>,
): ContextMenuActivationResult<Context, Role, Value> {
  const output: {
    ok: true;
    activated: false;
    reason: ContextMenuActivationNoopReason;
    state: ContextMenuState<Context, Role>;
    item?: ContextMenuRenderedItem<Role>;
  } = {
    activated: false,
    ok: true,
    reason,
    state,
  };

  if (item !== undefined) output.item = item;
  return Object.freeze(output);
}

function samePath(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;

  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return false;
  }

  return true;
}

function positiveModulo(value: number, modulus: number): number {
  return ((value % modulus) + modulus) % modulus;
}

function errorMessage(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message.length > 0) return error.message;

  return fallback;
}

function pathToken(value: string): string {
  return value.replaceAll("~", "~0").replaceAll("/", "~1");
}
