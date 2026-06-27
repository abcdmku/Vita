import {
  createCommandRegistry,
} from "./command-registry.ts";
import type {
  DesktopLauncherIntent,
  DesktopSettingsWriteRequest,
  WindowManagerIntent,
} from "../../../sdk/typescript/src/desktop-sdk/index.ts";
import type {
  CommandAction,
  CommandContext,
  CommandDefinition,
  CommandRegistryError,
  CommandRegistryViewModel,
  RegisteredCommand,
  CommandExecuteResult,
} from "./command-registry.ts";

/**
 * Global desktop menu-bar view-model.
 *
 * Pure / deterministic: no DOM, no platform internals, no ambient I/O. The
 * menu only maps items to command ids; command classification always routes
 * through the injected command-registry view-model.
 */

export type MenuBarMenuId = "file" | "edit" | "view" | "go" | "window" | "help";
export type MenuBarDenyReason = "invalid" | "forbidden" | "error";
export type MenuBarLauncherCommandAction = Extract<CommandAction, {
  readonly intent: DesktopLauncherIntent;
  readonly kind: "launcher.intent";
}>;
export type MenuBarWindowCommandAction = Extract<CommandAction, {
  readonly intent: WindowManagerIntent;
  readonly kind: "wm.intent";
}>;
export type MenuBarSettingsCommandAction = Extract<CommandAction, {
  readonly kind: "settings.write";
  readonly request: DesktopSettingsWriteRequest;
}>;
export type MenuBarCommandAction = CommandAction;

export interface MenuBarItemInput {
  readonly id: string;
  readonly label: string;
  readonly commandId?: string;
  readonly accelerator?: string;
  readonly disabled?: boolean;
  readonly submenu?: readonly MenuBarItemInput[];
}

export interface MenuBarMenuInput {
  readonly id: MenuBarMenuId | string;
  readonly label?: string;
  readonly items?: readonly MenuBarItemInput[];
}

export interface MenuBarTreeInput {
  readonly menus: readonly MenuBarMenuInput[];
}

export interface MenuBarAppTreeInput {
  readonly appId: string;
  readonly tree: MenuBarTreeInput;
}

export interface MenuBarItem {
  readonly id: string;
  readonly label: string;
  readonly disabled: boolean;
  readonly commandId?: string;
  readonly accelerator?: string;
  readonly submenu?: readonly MenuBarItem[];
}

export interface MenuBarMenu {
  readonly id: MenuBarMenuId;
  readonly label: string;
  readonly items: readonly MenuBarItem[];
}

export interface MenuBarSnapshot {
  readonly activeAppId: string;
  readonly openMenuId: MenuBarMenuId | null;
  readonly highlightedItemId: string | null;
  readonly menus: readonly MenuBarMenu[];
}

export interface MenuBarError {
  readonly code: string;
  readonly message: string;
  readonly path: string;
}

export type MenuActionResult = MenuActionSuccessResult | MenuActionDeniedResult;

export interface MenuActionSuccessResult {
  readonly ok: true;
  readonly itemId: string;
  readonly commandId: string;
  readonly command: RegisteredCommand;
  readonly action: MenuBarCommandAction;
}

export interface MenuActionDeniedResult {
  readonly ok: false;
  readonly reason: MenuBarDenyReason;
  readonly error: MenuBarError;
}

export interface MenuBarViewModel {
  snapshot(): MenuBarSnapshot;
  openMenu(menuId: string): MenuBarSnapshot;
  closeMenu(): MenuBarSnapshot;
  highlight(itemId: string): MenuBarSnapshot;
  setActiveApp(appId: string): MenuBarSnapshot;
  select(itemId: string, context?: CommandContext): MenuActionResult;
}

export interface MenuBarViewModelInput {
  readonly registry?: CommandRegistryViewModel;
  readonly commands?: readonly CommandDefinition[];
  readonly context?: CommandContext;
  readonly activeAppId?: string;
  readonly baseTree?: MenuBarTreeInput;
  readonly appTrees?: readonly MenuBarAppTreeInput[];
}

interface MenuBarItemDefinition {
  readonly id: string;
  readonly label: string;
  readonly commandId: string | null;
  readonly accelerator: string | null;
  readonly disabled: boolean;
  readonly submenu: readonly MenuBarItemDefinition[];
}

interface MenuBarMenuDefinition {
  readonly id: MenuBarMenuId;
  readonly label: string;
  readonly items: readonly MenuBarItemDefinition[];
}

interface MenuBarTreeDefinition {
  readonly menus: readonly MenuBarMenuDefinition[];
}

export const MENU_BAR_MENU_IDS = Object.freeze({
  edit: "edit",
  file: "file",
  go: "go",
  help: "help",
  view: "view",
  window: "window",
} as const satisfies Record<MenuBarMenuId, MenuBarMenuId>);

export const MENU_BAR_ITEM_IDS = Object.freeze({
  editCopy: "menubar.edit.copy",
  editCut: "menubar.edit.cut",
  editPaste: "menubar.edit.paste",
  editRedo: "menubar.edit.redo",
  editSelectAll: "menubar.edit.selectAll",
  editUndo: "menubar.edit.undo",
  fileCloseWindow: "menubar.file.closeWindow",
  fileNewWindow: "menubar.file.newWindow",
  fileOpen: "menubar.file.open",
  fileSettings: "menubar.file.settings",
  goBack: "menubar.go.back",
  goForward: "menubar.go.forward",
  goHome: "menubar.go.home",
  helpAbout: "menubar.help.about",
  helpDocumentation: "menubar.help.documentation",
  helpSearch: "menubar.help.search",
  viewActualSize: "menubar.view.actualSize",
  viewReload: "menubar.view.reload",
  viewToggleFullscreen: "menubar.view.toggleFullscreen",
  viewZoomIn: "menubar.view.zoomIn",
  viewZoomOut: "menubar.view.zoomOut",
  windowClose: "menubar.window.close",
  windowMaximize: "menubar.window.maximize",
  windowMinimize: "menubar.window.minimize",
  windowNext: "menubar.window.next",
} as const);

export const MENU_BAR_COMMAND_IDS = Object.freeze({
  about: "help.about",
  closeWindow: "window.close",
  copy: "edit.copy",
  cut: "edit.cut",
  documentation: "help.documentation",
  goBack: "go.back",
  goForward: "go.forward",
  goHome: "go.home",
  helpSearch: "help.search",
  maximizeWindow: "window.maximize",
  minimizeWindow: "window.minimize",
  newWindow: "file.newWindow",
  nextWindow: "window.next",
  open: "file.open",
  paste: "edit.paste",
  redo: "edit.redo",
  reload: "view.reload",
  selectAll: "edit.selectAll",
  settings: "file.settings",
  toggleFullscreen: "view.toggleFullscreen",
  undo: "edit.undo",
  viewActualSize: "view.actualSize",
  zoomIn: "view.zoomIn",
  zoomOut: "view.zoomOut",
} as const);

const DESKTOP_APP_ID = "desktop";
const EMPTY_CONTEXT: CommandContext = Object.freeze({});

const MENU_ORDER = Object.freeze([
  MENU_BAR_MENU_IDS.file,
  MENU_BAR_MENU_IDS.edit,
  MENU_BAR_MENU_IDS.view,
  MENU_BAR_MENU_IDS.go,
  MENU_BAR_MENU_IDS.window,
  MENU_BAR_MENU_IDS.help,
] as const satisfies readonly MenuBarMenuId[]);

const MENU_LABELS: Readonly<Record<MenuBarMenuId, string>> = Object.freeze({
  edit: "Edit",
  file: "File",
  go: "Go",
  help: "Help",
  view: "View",
  window: "Window",
});

const DEFAULT_BASE_TREE: MenuBarTreeDefinition = freezeTreeDefinition({
  menus: Object.freeze([
    menuDefinition(MENU_BAR_MENU_IDS.file, [
      itemDefinition(MENU_BAR_ITEM_IDS.fileNewWindow, "New Window", MENU_BAR_COMMAND_IDS.newWindow, "Cmd+N"),
      itemDefinition(MENU_BAR_ITEM_IDS.fileOpen, "Open...", MENU_BAR_COMMAND_IDS.open, "Cmd+O"),
      itemDefinition(MENU_BAR_ITEM_IDS.fileSettings, "Settings...", MENU_BAR_COMMAND_IDS.settings, "Cmd+,"),
      itemDefinition(MENU_BAR_ITEM_IDS.fileCloseWindow, "Close Window", MENU_BAR_COMMAND_IDS.closeWindow, "Cmd+W"),
    ]),
    menuDefinition(MENU_BAR_MENU_IDS.edit, [
      itemDefinition(MENU_BAR_ITEM_IDS.editUndo, "Undo", MENU_BAR_COMMAND_IDS.undo, "Cmd+Z"),
      itemDefinition(MENU_BAR_ITEM_IDS.editRedo, "Redo", MENU_BAR_COMMAND_IDS.redo, "Shift+Cmd+Z"),
      itemDefinition(MENU_BAR_ITEM_IDS.editCut, "Cut", MENU_BAR_COMMAND_IDS.cut, "Cmd+X"),
      itemDefinition(MENU_BAR_ITEM_IDS.editCopy, "Copy", MENU_BAR_COMMAND_IDS.copy, "Cmd+C"),
      itemDefinition(MENU_BAR_ITEM_IDS.editPaste, "Paste", MENU_BAR_COMMAND_IDS.paste, "Cmd+V"),
      itemDefinition(MENU_BAR_ITEM_IDS.editSelectAll, "Select All", MENU_BAR_COMMAND_IDS.selectAll, "Cmd+A"),
    ]),
    menuDefinition(MENU_BAR_MENU_IDS.view, [
      itemDefinition(MENU_BAR_ITEM_IDS.viewReload, "Reload", MENU_BAR_COMMAND_IDS.reload, "Cmd+R"),
      itemDefinition(MENU_BAR_ITEM_IDS.viewZoomIn, "Zoom In", MENU_BAR_COMMAND_IDS.zoomIn, "Cmd++"),
      itemDefinition(MENU_BAR_ITEM_IDS.viewZoomOut, "Zoom Out", MENU_BAR_COMMAND_IDS.zoomOut, "Cmd+-"),
      itemDefinition(MENU_BAR_ITEM_IDS.viewActualSize, "Actual Size", MENU_BAR_COMMAND_IDS.viewActualSize, "Cmd+0"),
      itemDefinition(MENU_BAR_ITEM_IDS.viewToggleFullscreen, "Toggle Full Screen", MENU_BAR_COMMAND_IDS.toggleFullscreen, "Ctrl+Cmd+F"),
    ]),
    menuDefinition(MENU_BAR_MENU_IDS.go, [
      itemDefinition(MENU_BAR_ITEM_IDS.goBack, "Back", MENU_BAR_COMMAND_IDS.goBack, "Cmd+["),
      itemDefinition(MENU_BAR_ITEM_IDS.goForward, "Forward", MENU_BAR_COMMAND_IDS.goForward, "Cmd+]"),
      itemDefinition(MENU_BAR_ITEM_IDS.goHome, "Home", MENU_BAR_COMMAND_IDS.goHome, "Shift+Cmd+H"),
    ]),
    menuDefinition(MENU_BAR_MENU_IDS.window, [
      itemDefinition(MENU_BAR_ITEM_IDS.windowMinimize, "Minimize", MENU_BAR_COMMAND_IDS.minimizeWindow, "Cmd+M"),
      itemDefinition(MENU_BAR_ITEM_IDS.windowMaximize, "Maximize", MENU_BAR_COMMAND_IDS.maximizeWindow, null),
      itemDefinition(MENU_BAR_ITEM_IDS.windowClose, "Close", MENU_BAR_COMMAND_IDS.closeWindow, "Cmd+W"),
      itemDefinition(MENU_BAR_ITEM_IDS.windowNext, "Next Window", MENU_BAR_COMMAND_IDS.nextWindow, "Cmd+`"),
    ]),
    menuDefinition(MENU_BAR_MENU_IDS.help, [
      itemDefinition(MENU_BAR_ITEM_IDS.helpSearch, "Search", MENU_BAR_COMMAND_IDS.helpSearch, null),
      itemDefinition(MENU_BAR_ITEM_IDS.helpDocumentation, "Documentation", MENU_BAR_COMMAND_IDS.documentation, null),
      itemDefinition(MENU_BAR_ITEM_IDS.helpAbout, "About Vita.ts", MENU_BAR_COMMAND_IDS.about, null),
    ]),
  ]),
});

export function createMenuBarViewModel(
  input: MenuBarViewModelInput = Object.freeze({}),
): MenuBarViewModel {
  return new DesktopMenuBarViewModel(input);
}

class DesktopMenuBarViewModel implements MenuBarViewModel {
  readonly #registry: CommandRegistryViewModel;
  readonly #context: CommandContext;
  readonly #baseTree: MenuBarTreeDefinition;
  readonly #appTrees: Map<string, MenuBarTreeDefinition>;
  #activeAppId: string;
  #openMenuId: MenuBarMenuId | null;
  #highlightedItemId: string | null;

  constructor(input: MenuBarViewModelInput) {
    this.#registry = input.registry ?? createCommandRegistry(
      input.commands === undefined ? undefined : { commands: input.commands },
    );
    this.#context = normalizeContext(input.context);
    this.#baseTree = input.baseTree === undefined
      ? DEFAULT_BASE_TREE
      : normalizeTree(input.baseTree, DEFAULT_BASE_TREE);
    this.#appTrees = new Map<string, MenuBarTreeDefinition>();
    this.#activeAppId = activeAppId(input.activeAppId);
    this.#openMenuId = null;
    this.#highlightedItemId = null;

    const appTrees = input.appTrees ?? Object.freeze([]);

    for (let index = 0; index < appTrees.length; index += 1) {
      const entry = appTrees[index];

      if (entry === undefined || typeof entry.appId !== "string" || entry.appId.length === 0) {
        continue;
      }

      this.#appTrees.set(entry.appId, normalizeTree(entry.tree, this.#baseTree));
    }
  }

  snapshot(): MenuBarSnapshot {
    return this.#snapshot();
  }

  openMenu(menuId: string): MenuBarSnapshot {
    const normalized = normalizeMenuId(menuId);

    this.#openMenuId = normalized;
    this.#highlightedItemId = null;

    return this.#snapshot();
  }

  closeMenu(): MenuBarSnapshot {
    this.#openMenuId = null;
    this.#highlightedItemId = null;

    return this.#snapshot();
  }

  highlight(itemId: string): MenuBarSnapshot {
    const tree = this.#activeTree();

    this.#highlightedItemId = findItemDefinition(tree, itemId) === null ? null : itemId;

    return this.#snapshot();
  }

  setActiveApp(appId: string): MenuBarSnapshot {
    this.#activeAppId = activeAppId(appId);
    this.#openMenuId = null;
    this.#highlightedItemId = null;

    return this.#snapshot();
  }

  select(itemId: string, context?: CommandContext): MenuActionResult {
    const tree = this.#activeTree();
    const definition = findItemDefinition(tree, itemId);

    if (definition === null) {
      return deny(
        "invalid",
        "UNKNOWN_MENU_ITEM",
        `menu item '${itemId}' is not registered.`,
        `/items/${pathToken(itemId)}`,
      );
    }

    if (definition.disabled) {
      return deny(
        "forbidden",
        "MENU_ITEM_DISABLED",
        `menu item '${definition.id}' is disabled.`,
        `/items/${pathToken(definition.id)}/disabled`,
      );
    }

    if (definition.commandId === null) {
      return deny(
        "invalid",
        "MENU_ITEM_NOT_ACTIONABLE",
        `menu item '${definition.id}' does not map to a command.`,
        `/items/${pathToken(definition.id)}/commandId`,
      );
    }

    const commandContext = context === undefined ? this.#context : normalizeContext(context);

    if (!isCommandAvailable(this.#registry, definition.commandId, commandContext)) {
      return this.#denyFromCommand(executeCommand(this.#registry, definition.commandId, commandContext), definition.commandId);
    }

    const result = executeCommand(this.#registry, definition.commandId, commandContext);

    if (!result.ok) {
      return this.#denyFromCommand(result, definition.commandId);
    }

    return Object.freeze({
      action: result.action,
      command: result.command,
      commandId: definition.commandId,
      itemId: definition.id,
      ok: true,
    });
  }

  #snapshot(): MenuBarSnapshot {
    const tree = this.#activeTree();
    const menus = materializeTree(tree, this.#registry, this.#context);
    const openMenuId = this.#openMenuId;
    const highlightedItemId = this.#highlightedItemId;
    const validHighlight = highlightedItemId === null
      ? null
      : findItem(menus, highlightedItemId) === null ? null : highlightedItemId;

    return Object.freeze({
      activeAppId: this.#activeAppId,
      highlightedItemId: validHighlight,
      menus,
      openMenuId: openMenuId === null ? null : findMenu(menus, openMenuId) === null ? null : openMenuId,
    });
  }

  #activeTree(): MenuBarTreeDefinition {
    return this.#appTrees.get(this.#activeAppId) ?? this.#baseTree;
  }

  #denyFromCommand(
    result: ReturnType<CommandRegistryViewModel["execute"]>,
    commandId: string,
  ): MenuActionDeniedResult {
    if (result.ok) {
      return deny(
        "error",
        "COMMAND_AVAILABILITY_MISMATCH",
        `command '${commandId}' availability changed while selecting a menu item.`,
        `/commands/${pathToken(commandId)}`,
      );
    }

    return denyFromCommandError(result.error);
  }
}

function normalizeTree(
  input: MenuBarTreeInput,
  fallback: MenuBarTreeDefinition,
): MenuBarTreeDefinition {
  const byId = new Map<MenuBarMenuId, MenuBarMenuInput>();
  const menus = input.menus ?? Object.freeze([]);

  for (let index = 0; index < menus.length; index += 1) {
    const menu = menus[index];

    if (menu === undefined) continue;

    const menuId = normalizeMenuId(menu.id);

    if (menuId !== null && !byId.has(menuId)) {
      byId.set(menuId, menu);
    }
  }

  const normalized: MenuBarMenuDefinition[] = [];

  for (let index = 0; index < MENU_ORDER.length; index += 1) {
    const menuId = MENU_ORDER[index];

    if (menuId === undefined) continue;

    const inputMenu = byId.get(menuId);
    const fallbackMenu = findMenuDefinition(fallback, menuId);

    normalized.push(freezeMenuDefinition({
      id: menuId,
      items: inputMenu?.items === undefined
        ? fallbackMenu?.items ?? Object.freeze([])
        : normalizeItems(inputMenu.items),
      label: labelForMenu(menuId, inputMenu?.label),
    }));
  }

  return freezeTreeDefinition({
    menus: Object.freeze(normalized),
  });
}

function normalizeItems(items: readonly MenuBarItemInput[]): readonly MenuBarItemDefinition[] {
  const output: MenuBarItemDefinition[] = [];
  const seen = new Set<string>();

  for (let index = 0; index < items.length; index += 1) {
    const item = items[index];

    if (item === undefined || typeof item.id !== "string" || item.id.length === 0 || seen.has(item.id)) {
      continue;
    }

    if (typeof item.label !== "string" || item.label.length === 0) {
      continue;
    }

    const commandId = typeof item.commandId === "string" && item.commandId.length > 0 ? item.commandId : null;
    const accelerator = typeof item.accelerator === "string" && item.accelerator.length > 0 ? item.accelerator : null;
    const submenu = item.submenu === undefined ? Object.freeze([]) : normalizeItems(item.submenu);

    seen.add(item.id);
    output.push(freezeItemDefinition({
      accelerator,
      commandId,
      disabled: item.disabled === true,
      id: item.id,
      label: item.label,
      submenu,
    }));
  }

  return Object.freeze(output);
}

function materializeTree(
  tree: MenuBarTreeDefinition,
  registry: CommandRegistryViewModel,
  context: CommandContext,
): readonly MenuBarMenu[] {
  const menus: MenuBarMenu[] = [];

  for (let index = 0; index < tree.menus.length; index += 1) {
    const menu = tree.menus[index];

    if (menu === undefined) continue;

    menus.push(Object.freeze({
      id: menu.id,
      items: materializeItems(menu.items, registry, context),
      label: menu.label,
    }));
  }

  return Object.freeze(menus);
}

function materializeItems(
  definitions: readonly MenuBarItemDefinition[],
  registry: CommandRegistryViewModel,
  context: CommandContext,
): readonly MenuBarItem[] {
  const items: MenuBarItem[] = [];

  for (let index = 0; index < definitions.length; index += 1) {
    const definition = definitions[index];

    if (definition === undefined) continue;

    const disabled = definition.disabled ||
      (definition.commandId !== null && !isCommandAvailable(registry, definition.commandId, context));
    const output: {
      id: string;
      label: string;
      disabled: boolean;
      commandId?: string;
      accelerator?: string;
      submenu?: readonly MenuBarItem[];
    } = {
      disabled,
      id: definition.id,
      label: definition.label,
    };

    if (definition.commandId !== null) output.commandId = definition.commandId;
    if (definition.accelerator !== null) output.accelerator = definition.accelerator;
    if (definition.submenu.length > 0) {
      output.submenu = materializeItems(definition.submenu, registry, context);
    }

    items.push(Object.freeze(output));
  }

  return Object.freeze(items);
}

function findMenu(
  menus: readonly MenuBarMenu[],
  id: MenuBarMenuId,
): MenuBarMenu | null {
  for (let index = 0; index < menus.length; index += 1) {
    const menu = menus[index];

    if (menu !== undefined && menu.id === id) return menu;
  }

  return null;
}

function findItem(
  menus: readonly MenuBarMenu[],
  id: string,
): MenuBarItem | null {
  for (let menuIndex = 0; menuIndex < menus.length; menuIndex += 1) {
    const menu = menus[menuIndex];

    if (menu === undefined) continue;

    const found = findMaterializedItem(menu.items, id);

    if (found !== null) return found;
  }

  return null;
}

function findMaterializedItem(
  items: readonly MenuBarItem[],
  id: string,
): MenuBarItem | null {
  for (let index = 0; index < items.length; index += 1) {
    const item = items[index];

    if (item === undefined) continue;

    if (item.id === id) return item;

    if (item.submenu !== undefined) {
      const nested = findMaterializedItem(item.submenu, id);

      if (nested !== null) return nested;
    }
  }

  return null;
}

function findItemDefinition(
  tree: MenuBarTreeDefinition,
  id: string,
): MenuBarItemDefinition | null {
  for (let menuIndex = 0; menuIndex < tree.menus.length; menuIndex += 1) {
    const menu = tree.menus[menuIndex];

    if (menu === undefined) continue;

    const item = findItemDefinitionIn(menu.items, id);

    if (item !== null) return item;
  }

  return null;
}

function findItemDefinitionIn(
  items: readonly MenuBarItemDefinition[],
  id: string,
): MenuBarItemDefinition | null {
  for (let index = 0; index < items.length; index += 1) {
    const item = items[index];

    if (item === undefined) continue;
    if (item.id === id) return item;

    const nested = findItemDefinitionIn(item.submenu, id);

    if (nested !== null) return nested;
  }

  return null;
}

function findMenuDefinition(
  tree: MenuBarTreeDefinition,
  id: MenuBarMenuId,
): MenuBarMenuDefinition | null {
  for (let index = 0; index < tree.menus.length; index += 1) {
    const menu = tree.menus[index];

    if (menu !== undefined && menu.id === id) return menu;
  }

  return null;
}

function menuDefinition(
  id: MenuBarMenuId,
  items: readonly MenuBarItemDefinition[],
): MenuBarMenuDefinition {
  return freezeMenuDefinition({
    id,
    items,
    label: MENU_LABELS[id],
  });
}

function itemDefinition(
  id: string,
  label: string,
  commandId: string | null,
  accelerator: string | null,
): MenuBarItemDefinition {
  return freezeItemDefinition({
    accelerator,
    commandId,
    disabled: false,
    id,
    label,
    submenu: Object.freeze([]),
  });
}

function freezeTreeDefinition(input: MenuBarTreeDefinition): MenuBarTreeDefinition {
  const menus: MenuBarMenuDefinition[] = [];

  for (let index = 0; index < input.menus.length; index += 1) {
    const menu = input.menus[index];

    if (menu !== undefined) menus.push(freezeMenuDefinition(menu));
  }

  return Object.freeze({
    menus: Object.freeze(menus),
  });
}

function freezeMenuDefinition(input: MenuBarMenuDefinition): MenuBarMenuDefinition {
  return Object.freeze({
    id: input.id,
    items: Object.freeze(input.items.map(freezeItemDefinition)),
    label: input.label,
  });
}

function freezeItemDefinition(input: MenuBarItemDefinition): MenuBarItemDefinition {
  return Object.freeze({
    accelerator: input.accelerator,
    commandId: input.commandId,
    disabled: input.disabled,
    id: input.id,
    label: input.label,
    submenu: Object.freeze(input.submenu.map(freezeItemDefinition)),
  });
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

function labelForMenu(menuId: MenuBarMenuId, label: string | undefined): string {
  if (typeof label === "string" && label.length > 0) return label;

  return MENU_LABELS[menuId];
}

function activeAppId(input: string | undefined): string {
  if (typeof input === "string" && input.length > 0) return input;

  return DESKTOP_APP_ID;
}

function normalizeContext(context: CommandContext | undefined): CommandContext {
  if (context === undefined || context === null || typeof context !== "object") {
    return EMPTY_CONTEXT;
  }

  return context;
}

function isCommandAvailable(
  registry: CommandRegistryViewModel,
  commandId: string,
  context: CommandContext,
): boolean {
  try {
    return registry.isAvailable(commandId, context) === true;
  } catch {
    return false;
  }
}

function executeCommand(
  registry: CommandRegistryViewModel,
  commandId: string,
  context: CommandContext,
): CommandExecuteResult {
  try {
    return registry.execute(commandId, context);
  } catch {
    return Object.freeze({
      error: commandRegistryError(
        "COMMAND_REGISTRY_FAILED",
        `command '${commandId}' registry execution failed closed.`,
        `/commands/${pathToken(commandId)}/execute`,
      ),
      ok: false,
    });
  }
}

function denyFromCommandError(errorValue: CommandRegistryError): MenuActionDeniedResult {
  return deny(
    errorValue.code === "UNKNOWN_COMMAND" ? "invalid" : "forbidden",
    errorValue.code,
    errorValue.message,
    errorValue.path,
  );
}

function commandRegistryError(code: string, message: string, path: string): CommandRegistryError {
  return Object.freeze({
    code,
    message,
    path,
  });
}

function deny(
  reason: MenuBarDenyReason,
  code: string,
  message: string,
  path: string,
): MenuActionDeniedResult {
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

/* ===========================================================================
 * Desktop menu view-model
 *
 * A higher-level controller that turns the pure menu tree above into something
 * the desktop shell's index screen can bind and act on with NO ambient I/O:
 *
 *   - tracks which top-level menu is open (one at a time),
 *   - exposes per-menu `open` flags + the flat item list of the open menu (so
 *     the binder renders a single anchored dropdown),
 *   - appends the live window list to the Window menu (focus a window),
 *   - resolves a selected item id to a typed `DesktopMenuEffect` the screen can
 *     execute against the live desktop (open palette, toggle theme, launch app,
 *     focus / close / minimize a window, surface About/Help).
 *
 * It does not touch the DOM and performs no effects itself: `select` returns the
 * effect, the screen applies it. Fail-closed: unknown items yield `{ kind: "none" }`.
 * ======================================================================== */

/** A live desktop window the Window menu can target. Discovered from the DOM by the screen. */
export interface DesktopMenuWindow {
  readonly id: string;
  readonly appId: string;
  readonly title: string;
  readonly focused: boolean;
  readonly minimized: boolean;
}

/** A typed effect the shell applies after a menu item is chosen. */
export type DesktopMenuEffect =
  | { readonly kind: "none" }
  | { readonly kind: "openPalette" }
  | { readonly kind: "openSettings" }
  | { readonly kind: "toggleTheme" }
  | { readonly kind: "launchApp"; readonly appId: string }
  | { readonly kind: "focusWindow"; readonly windowId: string }
  | { readonly kind: "closeFocusedWindow" }
  | { readonly kind: "minimizeFocusedWindow" }
  | { readonly kind: "maximizeFocusedWindow" }
  | { readonly kind: "cycleWindow" }
  | { readonly kind: "showAbout" }
  | { readonly kind: "showHelp" };

/** A rendered menu-bar dropdown item (flat). */
export interface DesktopMenuRenderItem {
  readonly id: string;
  readonly label: string;
  readonly accelerator: string;
  readonly disabled: boolean;
  readonly checked: boolean;
}

export interface DesktopMenuSnapshot {
  /** The open menu id, or null when the bar is closed. */
  readonly openMenuId: MenuBarMenuId | null;
  /** Items of the open menu (empty when closed). */
  readonly items: readonly DesktopMenuRenderItem[];
  /** Pixel x-offset for the anchored dropdown (left of the open menu title). */
  readonly dropdownLeft: number;
}

export interface DesktopMenuViewModel {
  snapshot(): DesktopMenuSnapshot;
  isOpen(menuId: string): boolean;
  anyOpen(): boolean;
  /** Open `menuId`; closes any other. */
  open(menuId: string): DesktopMenuSnapshot;
  /** Toggle `menuId` (open if closed/other, close if already open). */
  toggle(menuId: string): DesktopMenuSnapshot;
  close(): DesktopMenuSnapshot;
  /** Replace the live window list (Window menu source). */
  setWindows(windows: readonly DesktopMenuWindow[]): DesktopMenuSnapshot;
  /** Resolve a chosen item id to a typed effect (does not mutate open state). */
  resolve(itemId: string): DesktopMenuEffect;
}

const WINDOW_FOCUS_ITEM_PREFIX = "menubar.window.focus.";

// Approx pixel offset of each top-level title from the menu container's left edge. The dropdown is
// absolutely positioned within the .v-menubar row; these are deliberately coarse (the titles are
// short) and only used to anchor the single shared dropdown roughly under the chosen menu.
const MENU_TITLE_OFFSETS: Readonly<Record<MenuBarMenuId, number>> = Object.freeze({
  file: 14,
  edit: 52,
  view: 92,
  go: 132,
  window: 162,
  help: 224,
});

/** Curated desktop commands so the static File/Edit/View/Go/Window/Help items are enabled + actionable. */
export function desktopMenuCommands(): readonly CommandDefinition[] {
  const noop = (): CommandAction => Object.freeze({ kind: "noop" });

  return Object.freeze([
    command(MENU_BAR_COMMAND_IDS.newWindow, "New Window", "file", noop),
    command(MENU_BAR_COMMAND_IDS.open, "Open…", "file", noop),
    command(MENU_BAR_COMMAND_IDS.settings, "Settings…", "file", noop),
    command(MENU_BAR_COMMAND_IDS.closeWindow, "Close Window", "file", noop),
    command(MENU_BAR_COMMAND_IDS.undo, "Undo", "edit", noop),
    command(MENU_BAR_COMMAND_IDS.redo, "Redo", "edit", noop),
    command(MENU_BAR_COMMAND_IDS.cut, "Cut", "edit", noop),
    command(MENU_BAR_COMMAND_IDS.copy, "Copy", "edit", noop),
    command(MENU_BAR_COMMAND_IDS.paste, "Paste", "edit", noop),
    command(MENU_BAR_COMMAND_IDS.selectAll, "Select All", "edit", noop),
    command(MENU_BAR_COMMAND_IDS.reload, "Reload", "view", noop),
    command(MENU_BAR_COMMAND_IDS.zoomIn, "Zoom In", "view", noop),
    command(MENU_BAR_COMMAND_IDS.zoomOut, "Zoom Out", "view", noop),
    command(MENU_BAR_COMMAND_IDS.viewActualSize, "Actual Size", "view", noop),
    command(MENU_BAR_COMMAND_IDS.toggleFullscreen, "Toggle Full Screen", "view", noop),
    command(MENU_BAR_COMMAND_IDS.goBack, "Back", "go", noop),
    command(MENU_BAR_COMMAND_IDS.goForward, "Forward", "go", noop),
    command(MENU_BAR_COMMAND_IDS.goHome, "Home", "go", noop),
    command(MENU_BAR_COMMAND_IDS.minimizeWindow, "Minimize", "window", noop),
    command(MENU_BAR_COMMAND_IDS.maximizeWindow, "Maximize", "window", noop),
    command(MENU_BAR_COMMAND_IDS.nextWindow, "Next Window", "window", noop),
    command(MENU_BAR_COMMAND_IDS.helpSearch, "Search", "help", noop),
    command(MENU_BAR_COMMAND_IDS.documentation, "Documentation", "help", noop),
    command(MENU_BAR_COMMAND_IDS.about, "About Vita.ts", "help", noop),
  ]);
}

export interface DesktopMenuViewModelInput {
  readonly windows?: readonly DesktopMenuWindow[];
}

export function createDesktopMenuViewModel(
  input: DesktopMenuViewModelInput = Object.freeze({}),
): DesktopMenuViewModel {
  return new DesktopMenuController(input);
}

class DesktopMenuController implements DesktopMenuViewModel {
  readonly #menu: MenuBarViewModel;
  #openMenuId: MenuBarMenuId | null = null;
  #windows: readonly DesktopMenuWindow[];

  constructor(input: DesktopMenuViewModelInput) {
    this.#menu = createMenuBarViewModel({ commands: desktopMenuCommands() });
    this.#windows = normalizeWindows(input.windows);
  }

  snapshot(): DesktopMenuSnapshot {
    return this.#snapshot();
  }

  isOpen(menuId: string): boolean {
    return this.#openMenuId !== null && this.#openMenuId === normalizeMenuId(menuId);
  }

  anyOpen(): boolean {
    return this.#openMenuId !== null;
  }

  open(menuId: string): DesktopMenuSnapshot {
    this.#openMenuId = normalizeMenuId(menuId);

    return this.#snapshot();
  }

  toggle(menuId: string): DesktopMenuSnapshot {
    const normalized = normalizeMenuId(menuId);

    this.#openMenuId = normalized !== null && normalized === this.#openMenuId ? null : normalized;

    return this.#snapshot();
  }

  close(): DesktopMenuSnapshot {
    this.#openMenuId = null;

    return this.#snapshot();
  }

  setWindows(windows: readonly DesktopMenuWindow[]): DesktopMenuSnapshot {
    this.#windows = normalizeWindows(windows);

    return this.#snapshot();
  }

  resolve(itemId: string): DesktopMenuEffect {
    if (typeof itemId !== "string" || itemId.length === 0) return Object.freeze({ kind: "none" });

    if (itemId.startsWith(WINDOW_FOCUS_ITEM_PREFIX)) {
      const windowId = this.#windowIdForItem(itemId);

      return windowId === null
        ? Object.freeze({ kind: "none" })
        : Object.freeze({ kind: "focusWindow", windowId });
    }

    return effectForItemId(itemId);
  }

  #snapshot(): DesktopMenuSnapshot {
    const openMenuId = this.#openMenuId;

    if (openMenuId === null) {
      return Object.freeze({ dropdownLeft: MENU_TITLE_OFFSETS.file, items: Object.freeze([]), openMenuId: null });
    }

    const base = this.#menu.snapshot();
    const baseMenu = findMenu(base.menus, openMenuId);
    const items: DesktopMenuRenderItem[] = [];

    if (baseMenu !== null) {
      for (let index = 0; index < baseMenu.items.length; index += 1) {
        const item = baseMenu.items[index];

        if (item !== undefined) items.push(renderItem(item));
      }
    }

    if (openMenuId === MENU_BAR_MENU_IDS.window) {
      appendWindowItems(items, this.#windows);
    }

    return Object.freeze({
      dropdownLeft: MENU_TITLE_OFFSETS[openMenuId],
      items: Object.freeze(items),
      openMenuId,
    });
  }

  #windowIdForItem(itemId: string): string | null {
    for (let index = 0; index < this.#windows.length; index += 1) {
      const window = this.#windows[index];

      if (window !== undefined && windowFocusItemId(window.id) === itemId) return window.id;
    }

    return null;
  }
}

function command(
  id: string,
  title: string,
  category: string,
  execute: (context: CommandContext) => CommandAction,
): CommandDefinition {
  return Object.freeze({ category, execute, id, title });
}

function renderItem(item: MenuBarItem): DesktopMenuRenderItem {
  return Object.freeze({
    accelerator: item.accelerator ?? "",
    checked: false,
    disabled: item.disabled,
    id: item.id,
    label: item.label,
  });
}

function appendWindowItems(
  items: DesktopMenuRenderItem[],
  windows: readonly DesktopMenuWindow[],
): void {
  if (windows.length === 0) {
    items.push(Object.freeze({
      accelerator: "",
      checked: false,
      disabled: true,
      id: "menubar.window.none",
      label: "No Windows",
    }));

    return;
  }

  for (let index = 0; index < windows.length; index += 1) {
    const window = windows[index];

    if (window === undefined) continue;

    items.push(Object.freeze({
      accelerator: window.minimized ? "—" : "",
      checked: window.focused,
      disabled: false,
      id: windowFocusItemId(window.id),
      label: window.title,
    }));
  }
}

function effectForItemId(itemId: string): DesktopMenuEffect {
  switch (itemId) {
    case MENU_BAR_ITEM_IDS.fileNewWindow:
      return Object.freeze({ kind: "openPalette" });
    case MENU_BAR_ITEM_IDS.fileOpen:
      return Object.freeze({ kind: "openPalette" });
    case MENU_BAR_ITEM_IDS.fileSettings:
      return Object.freeze({ kind: "openSettings" });
    case MENU_BAR_ITEM_IDS.fileCloseWindow:
    case MENU_BAR_ITEM_IDS.windowClose:
      return Object.freeze({ kind: "closeFocusedWindow" });
    case MENU_BAR_ITEM_IDS.windowMinimize:
      return Object.freeze({ kind: "minimizeFocusedWindow" });
    case MENU_BAR_ITEM_IDS.windowMaximize:
      return Object.freeze({ kind: "maximizeFocusedWindow" });
    case MENU_BAR_ITEM_IDS.windowNext:
      return Object.freeze({ kind: "cycleWindow" });
    case MENU_BAR_ITEM_IDS.helpAbout:
      return Object.freeze({ kind: "showAbout" });
    case MENU_BAR_ITEM_IDS.helpDocumentation:
    case MENU_BAR_ITEM_IDS.helpSearch:
      return Object.freeze({ kind: "showHelp" });
    case MENU_BAR_ITEM_IDS.viewToggleFullscreen:
      return Object.freeze({ kind: "toggleTheme" });
    default:
      return Object.freeze({ kind: "none" });
  }
}

function windowFocusItemId(windowId: string): string {
  return `${WINDOW_FOCUS_ITEM_PREFIX}${pathToken(windowId)}`;
}

function normalizeWindows(windows: readonly DesktopMenuWindow[] | undefined): readonly DesktopMenuWindow[] {
  if (windows === undefined) return Object.freeze([]);

  const output: DesktopMenuWindow[] = [];
  const seen = new Set<string>();

  for (let index = 0; index < windows.length; index += 1) {
    const window = windows[index];

    if (
      window === undefined ||
      typeof window.id !== "string" ||
      window.id.length === 0 ||
      seen.has(window.id)
    ) {
      continue;
    }

    seen.add(window.id);
    output.push(Object.freeze({
      appId: typeof window.appId === "string" ? window.appId : "",
      focused: window.focused === true,
      id: window.id,
      minimized: window.minimized === true,
      title: typeof window.title === "string" && window.title.length > 0 ? window.title : window.id,
    }));
  }

  return Object.freeze(output);
}
