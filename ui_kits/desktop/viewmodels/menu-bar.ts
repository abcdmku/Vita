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
