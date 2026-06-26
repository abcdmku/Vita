import {
  createWindowModel,
  focusedWindowId as sdkFocusedWindowId,
} from "../../../sdk/typescript/src/desktop-sdk/index.ts";
import type {
  WindowId,
  WindowManagerIntent,
  WindowModel,
  WindowState,
} from "../../../sdk/typescript/src/desktop-sdk/index.ts";
import {
  createCommandRegistry,
} from "./command-registry.ts";
import type {
  CommandAction,
  CommandContext,
  CommandContextValue,
  CommandDefinition,
  CommandRegistrySnapshot,
  CommandRegistryViewModel,
  RegisteredCommand,
} from "./command-registry.ts";
import {
  MENU_BAR_MENU_IDS,
  createMenuBarViewModel,
} from "./menu-bar.ts";
import type {
  MenuActionResult,
  MenuBarItem,
  MenuBarMenu,
  MenuBarMenuId,
  MenuBarSnapshot,
  MenuBarTreeInput,
} from "./menu-bar.ts";

const DESKTOP_APP_ID = "desktop";
const EMPTY_COMMANDS: readonly RegisteredCommand[] = Object.freeze([]);
const EMPTY_GROUPS: readonly [] = Object.freeze([]);
const MENU_ORDER = Object.freeze([
  MENU_BAR_MENU_IDS.file,
  MENU_BAR_MENU_IDS.edit,
  MENU_BAR_MENU_IDS.view,
  MENU_BAR_MENU_IDS.go,
  MENU_BAR_MENU_IDS.window,
  MENU_BAR_MENU_IDS.help,
] as const satisfies readonly MenuBarMenuId[]);

export type MenuBarBindingFocusIntent = Extract<WindowManagerIntent, { readonly type: "setFocus" }>;
export type MenuBarBindingCommandAction = CommandAction;

export interface MenuBarBindingWindowDescription {
  readonly appId: string;
  readonly title: string;
}

export type MenuBarBindingWindowDescriber = (
  window: WindowState,
) => MenuBarBindingWindowDescription | null | undefined;

export interface MenuBarBindingOptions {
  readonly baseContext?: CommandContext;
  readonly commandCatalog?: readonly RegisteredCommand[];
  readonly commands?: readonly CommandDefinition[];
  readonly describeWindow?: MenuBarBindingWindowDescriber;
  readonly initialModel?: WindowModel;
  readonly model?: WindowModel;
  readonly registry?: CommandRegistryViewModel;
  readonly windowModel?: WindowModel;
}

export interface MenuBarBindingWindowEntry {
  readonly appId: string;
  readonly focused: boolean;
  readonly itemId: string;
  readonly label: string;
  readonly marked: boolean;
  readonly title: string;
  readonly windowId: WindowId;
  readonly workspaceId: string;
}

export interface MenuBarBindingItem {
  readonly disabled: boolean;
  readonly id: string;
  readonly label: string;
  readonly marked: boolean;
  readonly accelerator?: string;
  readonly appId?: string;
  readonly commandId?: string;
  readonly focused?: boolean;
  readonly submenu?: readonly MenuBarBindingItem[];
  readonly title?: string;
  readonly windowId?: WindowId;
}

export interface MenuBarBindingMenu {
  readonly id: MenuBarMenuId;
  readonly items: readonly MenuBarBindingItem[];
  readonly label: string;
}

export interface MenuBarBindingSnapshot {
  readonly activeAppId: string;
  readonly availableCommands: readonly RegisteredCommand[];
  readonly context: CommandContext;
  readonly focusedAppId: string | null;
  readonly focusedWindowId: WindowId | null;
  readonly focusedWindowTitle: string | null;
  readonly highlightedItemId: string | null;
  readonly menuBar: MenuBarSnapshot;
  readonly menus: readonly MenuBarBindingMenu[];
  readonly openMenuId: MenuBarMenuId | null;
  readonly registry: CommandRegistrySnapshot;
  readonly windowEntries: readonly MenuBarBindingWindowEntry[];
}

export interface MenuBarBindingError {
  readonly code: string;
  readonly message: string;
  readonly path: string;
}

export type MenuBarBindingSelectResult =
  | MenuBarBindingCommandSelectSuccess
  | MenuBarBindingWindowSelectSuccess
  | MenuBarBindingSelectDenied;

export interface MenuBarBindingCommandSelectSuccess {
  readonly action: CommandAction;
  readonly command: RegisteredCommand;
  readonly commandId: string;
  readonly itemId: string;
  readonly ok: true;
  readonly selection: "command";
}

export interface MenuBarBindingWindowSelectSuccess {
  readonly action: {
    readonly kind: "wm.intent";
    readonly intent: MenuBarBindingFocusIntent;
  };
  readonly intent: MenuBarBindingFocusIntent;
  readonly itemId: string;
  readonly ok: true;
  readonly selection: "window";
  readonly windowId: WindowId;
}

export interface MenuBarBindingSelectDenied {
  readonly error: MenuBarBindingError;
  readonly ok: false;
  readonly reason: "error" | "forbidden" | "invalid";
}

interface MaterializedBinding {
  readonly availableIds: ReadonlySet<string>;
  readonly context: CommandContext;
  readonly focusedDescription: MenuBarBindingWindowDescription | null;
  readonly focusedWindowId: WindowId | null;
  readonly menuBarSnapshot: MenuBarSnapshot;
  readonly registrySnapshot: CommandRegistrySnapshot;
  readonly windowEntries: readonly MenuBarBindingWindowEntry[];
}

export class MenuBarBindingViewModel {
  readonly #baseContext: CommandContext;
  readonly #catalog: readonly RegisteredCommand[];
  readonly #describeWindow: MenuBarBindingWindowDescriber | undefined;
  readonly #registry: CommandRegistryViewModel;
  #highlightedItemId: string | null = null;
  #model: WindowModel;
  #openMenuId: MenuBarMenuId | null = null;

  constructor(options: MenuBarBindingOptions = Object.freeze({})) {
    this.#registry = options.registry ?? createCommandRegistry(
      options.commands === undefined ? undefined : { commands: options.commands },
    );
    this.#catalog = normalizeCommandCatalog(options.commands, options.commandCatalog);
    this.#baseContext = freezeContext(options.baseContext ?? Object.freeze({}));
    this.#describeWindow = options.describeWindow;
    this.#model = options.windowModel ?? options.model ?? options.initialModel ?? createWindowModel();
  }

  snapshot(): MenuBarBindingSnapshot {
    return this.#snapshotFor(this.#model);
  }

  setWindowModel(model: WindowModel): MenuBarBindingSnapshot {
    this.#model = model;

    return this.snapshot();
  }

  openMenu(menuId: string): MenuBarBindingSnapshot {
    this.#openMenuId = normalizeMenuId(menuId);
    this.#highlightedItemId = null;

    return this.snapshot();
  }

  closeMenu(): MenuBarBindingSnapshot {
    this.#openMenuId = null;
    this.#highlightedItemId = null;

    return this.snapshot();
  }

  highlight(itemId: string): MenuBarBindingSnapshot {
    this.#highlightedItemId = typeof itemId === "string" && itemId.length > 0 ? itemId : null;

    return this.snapshot();
  }

  select(itemId: unknown): MenuBarBindingSelectResult {
    if (typeof itemId !== "string" || itemId.length === 0) {
      return deny(
        "invalid",
        "INVALID_MENU_ITEM",
        "menu item id must be a non-empty string.",
        "/select/itemId",
      );
    }

    const materialized = this.#materialize(this.#model);
    const windowEntry = findWindowEntryByItemId(materialized.windowEntries, itemId);

    if (windowEntry !== undefined) {
      return this.#selectWindowEntry(windowEntry.windowId, windowEntry.itemId);
    }

    const menuBar = this.#createMenuBar(materialized.context, materialized.windowEntries, materialized.registrySnapshot);
    const result = menuBar.select(itemId, materialized.context);

    return fromMenuActionResult(result);
  }

  selectWindow(windowId: unknown): MenuBarBindingSelectResult {
    if (typeof windowId !== "string" || windowId.length === 0) {
      return deny(
        "invalid",
        "INVALID_WINDOW",
        "window id must be a non-empty string.",
        "/selectWindow/windowId",
      );
    }

    return this.#selectWindowEntry(windowId, windowItemId(windowId));
  }

  selectCommand(commandId: unknown): MenuBarBindingSelectResult {
    if (typeof commandId !== "string" || commandId.length === 0) {
      return deny(
        "invalid",
        "INVALID_COMMAND",
        "command id must be a non-empty string.",
        "/selectCommand/commandId",
      );
    }

    const materialized = this.#materialize(this.#model);

    if (!materialized.availableIds.has(commandId)) {
      return deny(
        "forbidden",
        "COMMAND_UNAVAILABLE",
        `command '${commandId}' is not available in this context.`,
        `/commands/${pathToken(commandId)}/when`,
      );
    }

    let result: ReturnType<CommandRegistryViewModel["execute"]>;

    try {
      result = this.#registry.execute(commandId, materialized.context);
    } catch {
      return deny(
        "error",
        "COMMAND_REGISTRY_FAILED",
        `command '${commandId}' registry execution failed closed.`,
        `/commands/${pathToken(commandId)}/execute`,
      );
    }

    if (!result.ok) {
      return deny(
        result.error.code === "UNKNOWN_COMMAND" ? "invalid" : "forbidden",
        result.error.code,
        result.error.message,
        result.error.path,
      );
    }

    return Object.freeze({
      action: result.action,
      command: result.command,
      commandId,
      itemId: commandItemId(commandId),
      ok: true,
      selection: "command",
    }) satisfies MenuBarBindingCommandSelectSuccess;
  }

  #selectWindowEntry(windowId: WindowId, itemId: string): MenuBarBindingSelectResult {
    if (!hasWindow(this.#model, windowId)) {
      return deny(
        "invalid",
        "UNKNOWN_WINDOW",
        `window '${windowId}' is not present in the bound window model.`,
        `/windows/${pathToken(windowId)}`,
      );
    }

    const intent = Object.freeze({
      type: "setFocus",
      windowId,
    }) satisfies MenuBarBindingFocusIntent;
    const action = Object.freeze({
      intent,
      kind: "wm.intent",
    } as const);

    return Object.freeze({
      action,
      intent,
      itemId,
      ok: true,
      selection: "window",
      windowId,
    }) satisfies MenuBarBindingWindowSelectSuccess;
  }

  #snapshotFor(model: WindowModel): MenuBarBindingSnapshot {
    const materialized = this.#materialize(model);
    const menuBarSnapshot = materialized.menuBarSnapshot;
    const menus = bindMenus(menuBarSnapshot.menus, materialized.windowEntries, materialized.availableIds);
    const focusedDescription = materialized.focusedDescription;
    const activeAppId = focusedDescription?.appId ?? DESKTOP_APP_ID;

    return Object.freeze({
      activeAppId,
      availableCommands: materialized.registrySnapshot.commands,
      context: materialized.context,
      focusedAppId: focusedDescription?.appId ?? null,
      focusedWindowId: materialized.focusedWindowId,
      focusedWindowTitle: focusedDescription?.title ?? null,
      highlightedItemId: menuBarSnapshot.highlightedItemId,
      menuBar: menuBarSnapshot,
      menus,
      openMenuId: menuBarSnapshot.openMenuId,
      registry: materialized.registrySnapshot,
      windowEntries: materialized.windowEntries,
    }) satisfies MenuBarBindingSnapshot;
  }

  #materialize(model: WindowModel): MaterializedBinding {
    const focusedId = safeFocusedWindowId(model);
    const focusedWindow = focusedId === null ? null : findWindow(model, focusedId) ?? null;
    const focusedDescription = focusedWindow === null
      ? null
      : describeWindow(focusedWindow, this.#describeWindow);
    const context = contextForWindowModel(model, focusedId, focusedDescription, this.#baseContext);
    const registrySnapshot = safeRegistrySnapshot(this.#registry, context);
    const available = safeAvailable(this.#registry, context);
    const availableIds = commandIdSet(available);
    const windowEntries = buildMenuBarBindingWindowEntries(model, this.#describeWindow, focusedId);
    const menuBarSnapshot = this.#createMenuBar(context, windowEntries, registrySnapshot).snapshot();

    return Object.freeze({
      availableIds,
      context,
      focusedDescription,
      focusedWindowId: focusedId,
      menuBarSnapshot,
      registrySnapshot,
      windowEntries,
    }) satisfies MaterializedBinding;
  }

  #createMenuBar(
    context: CommandContext,
    windowEntries: readonly MenuBarBindingWindowEntry[],
    registrySnapshot: CommandRegistrySnapshot,
  ) {
    const activeAppId = context.focusedAppId === null || typeof context.focusedAppId !== "string"
      ? DESKTOP_APP_ID
      : context.focusedAppId;
    const catalog = this.#catalog.length === 0 ? registrySnapshot.commands : this.#catalog;
    const menuBar = createMenuBarViewModel({
      activeAppId,
      baseTree: buildMenuTree(catalog, windowEntries),
      context,
      registry: this.#registry,
    });

    if (this.#openMenuId !== null) {
      menuBar.openMenu(this.#openMenuId);
    }
    if (this.#highlightedItemId !== null) {
      menuBar.highlight(this.#highlightedItemId);
    }

    return menuBar;
  }
}

export function createMenuBarBindingViewModel(
  options: MenuBarBindingOptions = Object.freeze({}),
): MenuBarBindingViewModel {
  return new MenuBarBindingViewModel(options);
}

export function buildMenuBarCommandContext(
  model: WindowModel,
  baseContext: CommandContext = Object.freeze({}),
  describeWindowFn?: MenuBarBindingWindowDescriber,
): CommandContext {
  const focusedId = safeFocusedWindowId(model);
  const window = focusedId === null ? null : findWindow(model, focusedId) ?? null;
  const description = window === null ? null : describeWindow(window, describeWindowFn);

  return contextForWindowModel(model, focusedId, description, baseContext);
}

export function buildMenuBarBindingWindowEntries(
  model: WindowModel,
  describeWindowFn?: MenuBarBindingWindowDescriber,
  focusedId: WindowId | null = safeFocusedWindowId(model),
): readonly MenuBarBindingWindowEntry[] {
  const windowsById = windowsByWindowId(model.windows);
  const orderedWindowIds = orderedWindowIdsForWindowMenu(model, focusedId, windowsById);
  const entries: MenuBarBindingWindowEntry[] = [];

  for (let index = 0; index < orderedWindowIds.length; index += 1) {
    const windowId = orderedWindowIds[index];

    if (windowId === undefined) continue;

    const window = windowsById.get(windowId);

    if (window === undefined) continue;

    const description = describeWindow(window, describeWindowFn);
    const focused = focusedId !== null && window.id === focusedId;

    entries.push(Object.freeze({
      appId: description.appId,
      focused,
      itemId: windowItemId(window.id),
      label: description.title,
      marked: focused,
      title: description.title,
      windowId: window.id,
      workspaceId: window.workspaceId,
    }) satisfies MenuBarBindingWindowEntry);
  }

  return Object.freeze(entries);
}

function contextForWindowModel(
  model: WindowModel,
  focusedId: WindowId | null,
  focusedDescription: MenuBarBindingWindowDescription | null,
  baseContext: CommandContext,
): CommandContext {
  const context: Record<string, CommandContextValue> = {};
  const keys = Object.keys(baseContext);

  for (let index = 0; index < keys.length; index += 1) {
    const key = keys[index];

    if (key === undefined) continue;

    const value = baseContext[key];

    if (isCommandContextValue(value)) {
      context[key] = value;
    }
  }

  context.activeWorkspaceId = model.activeWorkspaceId;
  context.focusedWindowId = focusedId;
  context.focusedAppId = focusedDescription?.appId ?? null;
  context.focusedWindowTitle = focusedDescription?.title ?? null;
  context.focusedTitle = focusedDescription?.title ?? null;
  context.hasFocusedWindow = focusedId !== null;
  context.windowCount = model.windows.length;

  return Object.freeze(context);
}

function buildMenuTree(
  commands: readonly RegisteredCommand[],
  windowEntries: readonly MenuBarBindingWindowEntry[],
): MenuBarTreeInput {
  const itemsByMenu = new Map<MenuBarMenuId, MenuBarTreeItem[]>();

  for (let index = 0; index < MENU_ORDER.length; index += 1) {
    const menuId = MENU_ORDER[index];

    if (menuId !== undefined) {
      itemsByMenu.set(menuId, []);
    }
  }

  const sorted = sortRegisteredCommands(commands);

  for (let index = 0; index < sorted.length; index += 1) {
    const command = sorted[index];

    if (command === undefined) continue;

    const menuId = menuIdForCategory(command.category);
    const items = itemsByMenu.get(menuId);

    if (items !== undefined) {
      items.push(Object.freeze({
        commandId: command.id,
        id: commandItemId(command.id),
        label: command.title,
      }) satisfies MenuBarTreeItem);
    }
  }

  const windowItems = itemsByMenu.get(MENU_BAR_MENU_IDS.window);

  if (windowItems !== undefined) {
    for (let index = 0; index < windowEntries.length; index += 1) {
      const entry = windowEntries[index];

      if (entry !== undefined) {
        windowItems.push(Object.freeze({
          id: entry.itemId,
          label: entry.label,
        }) satisfies MenuBarTreeItem);
      }
    }
  }

  const menus: MenuBarTreeMenu[] = [];

  for (let index = 0; index < MENU_ORDER.length; index += 1) {
    const menuId = MENU_ORDER[index];

    if (menuId === undefined) continue;

    menus.push(Object.freeze({
      id: menuId,
      items: Object.freeze([...(itemsByMenu.get(menuId) ?? [])]),
    }) satisfies MenuBarTreeMenu);
  }

  return Object.freeze({
    menus: Object.freeze(menus),
  }) satisfies MenuBarTreeInput;
}

interface MenuBarTreeItem {
  readonly id: string;
  readonly label: string;
  readonly commandId?: string;
}

interface MenuBarTreeMenu {
  readonly id: MenuBarMenuId;
  readonly items: readonly MenuBarTreeItem[];
}

function bindMenus(
  menus: readonly MenuBarMenu[],
  windowEntries: readonly MenuBarBindingWindowEntry[],
  availableIds: ReadonlySet<string>,
): readonly MenuBarBindingMenu[] {
  const bound: MenuBarBindingMenu[] = [];

  for (let index = 0; index < menus.length; index += 1) {
    const menu = menus[index];

    if (menu === undefined) continue;

    bound.push(Object.freeze({
      id: menu.id,
      items: bindItems(menu.items, windowEntries, availableIds),
      label: menu.label,
    }) satisfies MenuBarBindingMenu);
  }

  return Object.freeze(bound);
}

function bindItems(
  items: readonly MenuBarItem[],
  windowEntries: readonly MenuBarBindingWindowEntry[],
  availableIds: ReadonlySet<string>,
): readonly MenuBarBindingItem[] {
  const bound: MenuBarBindingItem[] = [];

  for (let index = 0; index < items.length; index += 1) {
    const item = items[index];

    if (item === undefined) continue;

    const windowEntry = findWindowEntryByItemId(windowEntries, item.id);
    const output: {
      disabled: boolean;
      id: string;
      label: string;
      marked: boolean;
      accelerator?: string;
      appId?: string;
      commandId?: string;
      focused?: boolean;
      submenu?: readonly MenuBarBindingItem[];
      title?: string;
      windowId?: WindowId;
    } = {
      disabled: item.commandId === undefined ? item.disabled : item.disabled || !availableIds.has(item.commandId),
      id: item.id,
      label: item.label,
      marked: windowEntry?.marked ?? false,
    };

    if (item.accelerator !== undefined) output.accelerator = item.accelerator;
    if (item.commandId !== undefined) output.commandId = item.commandId;
    if (item.submenu !== undefined) output.submenu = bindItems(item.submenu, windowEntries, availableIds);
    if (windowEntry !== undefined) {
      output.appId = windowEntry.appId;
      output.focused = windowEntry.focused;
      output.title = windowEntry.title;
      output.windowId = windowEntry.windowId;
    }

    bound.push(Object.freeze(output) satisfies MenuBarBindingItem);
  }

  return Object.freeze(bound);
}

function fromMenuActionResult(result: MenuActionResult): MenuBarBindingSelectResult {
  if (!result.ok) {
    return deny(
      result.reason,
      result.error.code,
      result.error.message,
      result.error.path,
    );
  }

  return Object.freeze({
    action: result.action,
    command: result.command,
    commandId: result.commandId,
    itemId: result.itemId,
    ok: true,
    selection: "command",
  }) satisfies MenuBarBindingCommandSelectSuccess;
}

function normalizeCommandCatalog(
  commands: readonly CommandDefinition[] | undefined,
  catalog: readonly RegisteredCommand[] | undefined,
): readonly RegisteredCommand[] {
  if (catalog !== undefined) {
    return freezeRegisteredCommands(catalog);
  }
  if (commands === undefined) {
    return EMPTY_COMMANDS;
  }

  const output: RegisteredCommand[] = [];
  const seen = new Set<string>();

  for (let index = 0; index < commands.length; index += 1) {
    const command = commands[index];

    if (command === undefined) continue;
    if (
      typeof command.id !== "string" ||
      command.id.length === 0 ||
      typeof command.title !== "string" ||
      command.title.length === 0 ||
      typeof command.category !== "string" ||
      command.category.length === 0 ||
      seen.has(command.id)
    ) {
      continue;
    }

    seen.add(command.id);
    output.push(Object.freeze({
      category: command.category,
      id: command.id,
      title: command.title,
    }) satisfies RegisteredCommand);
  }

  return Object.freeze(sortRegisteredCommands(output));
}

function freezeRegisteredCommands(commands: readonly RegisteredCommand[]): readonly RegisteredCommand[] {
  const output: RegisteredCommand[] = [];
  const seen = new Set<string>();

  for (let index = 0; index < commands.length; index += 1) {
    const command = commands[index];

    if (command === undefined) continue;
    if (
      typeof command.id !== "string" ||
      command.id.length === 0 ||
      typeof command.title !== "string" ||
      command.title.length === 0 ||
      typeof command.category !== "string" ||
      command.category.length === 0 ||
      seen.has(command.id)
    ) {
      continue;
    }

    seen.add(command.id);
    output.push(Object.freeze({
      category: command.category,
      id: command.id,
      title: command.title,
    }) satisfies RegisteredCommand);
  }

  return Object.freeze(sortRegisteredCommands(output));
}

function sortRegisteredCommands(commands: readonly RegisteredCommand[]): readonly RegisteredCommand[] {
  const sorted = [...commands];

  sorted.sort((left, right) => {
    if (left.category !== right.category) return compareStrings(left.category, right.category);
    if (left.title !== right.title) return compareStrings(left.title, right.title);

    return compareStrings(left.id, right.id);
  });

  return Object.freeze(sorted);
}

function safeRegistrySnapshot(
  registry: CommandRegistryViewModel,
  context: CommandContext,
): CommandRegistrySnapshot {
  try {
    return registry.snapshot(context);
  } catch {
    return Object.freeze({
      commands: EMPTY_COMMANDS,
      groups: EMPTY_GROUPS,
    }) satisfies CommandRegistrySnapshot;
  }
}

function safeAvailable(
  registry: CommandRegistryViewModel,
  context: CommandContext,
): readonly RegisteredCommand[] {
  try {
    return registry.available(context);
  } catch {
    return EMPTY_COMMANDS;
  }
}

function commandIdSet(commands: readonly RegisteredCommand[]): ReadonlySet<string> {
  const ids = new Set<string>();

  for (let index = 0; index < commands.length; index += 1) {
    const command = commands[index];

    if (command !== undefined) {
      ids.add(command.id);
    }
  }

  return ids;
}

function menuIdForCategory(category: string): MenuBarMenuId {
  const normalized = category.trim().toLocaleLowerCase("en-US");

  switch (normalized) {
    case "edit":
      return MENU_BAR_MENU_IDS.edit;
    case "view":
      return MENU_BAR_MENU_IDS.view;
    case "go":
      return MENU_BAR_MENU_IDS.go;
    case "window":
    case "windows":
      return MENU_BAR_MENU_IDS.window;
    case "help":
      return MENU_BAR_MENU_IDS.help;
    case "file":
    default:
      return MENU_BAR_MENU_IDS.file;
  }
}

function orderedWindowIdsForWindowMenu(
  model: WindowModel,
  focusedId: WindowId | null,
  windowsById: ReadonlyMap<WindowId, WindowState>,
): readonly WindowId[] {
  const ordered: WindowId[] = [];
  const seen = new Set<WindowId>();

  if (focusedId !== null && windowsById.has(focusedId)) {
    ordered.push(focusedId);
    seen.add(focusedId);
  }

  for (let index = 0; index < model.focusStack.length; index += 1) {
    const windowId = model.focusStack[index];

    if (windowId !== undefined && windowsById.has(windowId) && !seen.has(windowId)) {
      ordered.push(windowId);
      seen.add(windowId);
    }
  }

  const rest = [...windowsById.values()].filter((window) => !seen.has(window.id));

  rest.sort((left, right) => {
    const order = left.order - right.order;

    return order === 0 ? compareStrings(left.id, right.id) : order;
  });

  for (let index = 0; index < rest.length; index += 1) {
    const window = rest[index];

    if (window !== undefined) {
      ordered.push(window.id);
    }
  }

  return Object.freeze(ordered);
}

function describeWindow(
  window: WindowState,
  describeWindowFn: MenuBarBindingWindowDescriber | undefined,
): MenuBarBindingWindowDescription {
  if (describeWindowFn !== undefined) {
    try {
      const described = describeWindowFn(window);

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
        }) satisfies MenuBarBindingWindowDescription;
      }
    } catch {
      return defaultWindowDescription(window);
    }
  }

  return defaultWindowDescription(window);
}

function defaultWindowDescription(window: WindowState): MenuBarBindingWindowDescription {
  const metadata = window as WindowState & {
    readonly appId?: unknown;
    readonly title?: unknown;
  };
  const appId = typeof metadata.appId === "string" && metadata.appId.length > 0
    ? metadata.appId
    : appIdFromWindowId(window.id);
  const title = typeof metadata.title === "string" && metadata.title.length > 0
    ? metadata.title
    : titleFromWindowId(window.id);

  return Object.freeze({
    appId,
    title,
  }) satisfies MenuBarBindingWindowDescription;
}

function appIdFromWindowId(windowId: WindowId): string {
  const firstSeparator = windowId.indexOf(":");

  if (firstSeparator < 0 || firstSeparator === windowId.length - 1) {
    return windowId;
  }

  const secondSeparator = windowId.indexOf(":", firstSeparator + 1);

  return secondSeparator < 0
    ? windowId.slice(firstSeparator + 1)
    : windowId.slice(firstSeparator + 1, secondSeparator);
}

function titleFromWindowId(windowId: WindowId): string {
  const separator = windowId.lastIndexOf(":");

  if (separator < 0 || separator === windowId.length - 1) {
    return windowId;
  }

  return windowId.slice(separator + 1);
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

function findWindow(model: WindowModel, windowId: WindowId): WindowState | undefined {
  for (let index = 0; index < model.windows.length; index += 1) {
    const window = model.windows[index];

    if (window !== undefined && window.id === windowId) {
      return window;
    }
  }

  return undefined;
}

function hasWindow(model: WindowModel, windowId: WindowId): boolean {
  return findWindow(model, windowId) !== undefined;
}

function findWindowEntryByItemId(
  entries: readonly MenuBarBindingWindowEntry[],
  itemId: string,
): MenuBarBindingWindowEntry | undefined {
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];

    if (entry !== undefined && entry.itemId === itemId) {
      return entry;
    }
  }

  return undefined;
}

function safeFocusedWindowId(model: WindowModel): WindowId | null {
  try {
    return sdkFocusedWindowId(model);
  } catch {
    return null;
  }
}

function freezeContext(context: CommandContext): CommandContext {
  const output: Record<string, CommandContextValue> = {};
  const keys = Object.keys(context);

  for (let index = 0; index < keys.length; index += 1) {
    const key = keys[index];

    if (key === undefined) continue;

    const value = context[key];

    if (isCommandContextValue(value)) {
      output[key] = value;
    }
  }

  return Object.freeze(output);
}

function isCommandContextValue(value: unknown): value is CommandContextValue {
  return value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean";
}

function normalizeMenuId(value: string): MenuBarMenuId | null {
  switch (value) {
    case MENU_BAR_MENU_IDS.file:
    case MENU_BAR_MENU_IDS.edit:
    case MENU_BAR_MENU_IDS.view:
    case MENU_BAR_MENU_IDS.go:
    case MENU_BAR_MENU_IDS.window:
    case MENU_BAR_MENU_IDS.help:
      return value;
    default:
      return null;
  }
}

function commandItemId(commandId: string): string {
  return `menubar.command.${pathToken(commandId)}`;
}

function windowItemId(windowId: WindowId): string {
  return `menubar.window.focus.${pathToken(windowId)}`;
}

function deny(
  reason: MenuBarBindingSelectDenied["reason"],
  code: string,
  message: string,
  path: string,
): MenuBarBindingSelectDenied {
  return Object.freeze({
    error: Object.freeze({
      code,
      message,
      path,
    }),
    ok: false,
    reason,
  });
}

function pathToken(value: string): string {
  let token = "";

  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];

    if (char === undefined) continue;

    const code = char.charCodeAt(0);
    const alphaNumeric =
      (code >= 48 && code <= 57) ||
      (code >= 65 && code <= 90) ||
      (code >= 97 && code <= 122);

    token += alphaNumeric || code === 45 || code === 46
      ? char
      : `_${code.toString(16).padStart(4, "0")}`;
  }

  return token;
}

function compareStrings(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;

  return 0;
}
