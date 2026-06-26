import type {
  DesktopAppLaunch,
  DesktopHost,
  DesktopLaunchableApp,
  DesktopUiPackageManifest,
} from "../../../sdk/typescript/src/desktop-sdk/index.ts";
import type {
  VitaActionContext,
  VitaBindValue,
  VitaListAttributePatch,
  VitaListClassPatch,
  VitaListItem,
} from "../runtime/binder.ts";
import type {
  ScreenActionHandler,
  ScreenBindResolver,
  ScreenModule,
  ScreenViewModel,
} from "../runtime/screen.ts";
import {
  DEFAULT_INDEX_DOCK_APPS,
  createIndexDockViewModel,
} from "../viewmodels/dock.ts";
import type {
  IndexDockActionResult,
  IndexDockAppId,
  IndexDockItem,
  IndexDockPorts,
  IndexDockState,
  IndexDockViewModel,
} from "../viewmodels/dock.ts";
import {
  createIndexPaletteViewModel,
} from "../viewmodels/index.ts";
import type {
  IndexPaletteCommand,
  IndexPaletteExecuteResult,
  IndexPalettePorts,
  IndexPaletteState,
  IndexPaletteViewModel,
} from "../viewmodels/index.ts";
import {
  MENU_BAR_MENU_IDS,
  createDesktopMenuViewModel,
} from "../viewmodels/menu-bar.ts";
import type {
  DesktopMenuEffect,
  DesktopMenuRenderItem,
  DesktopMenuSnapshot,
  DesktopMenuViewModel,
  DesktopMenuWindow,
} from "../viewmodels/menu-bar.ts";

// PSD-501: the index screen also receives an app-window host. After a dock tile's NATIVE binder
// action launches an app via the real host bridge, the index view-model asks the window host to
// open a real surface for it (populated with live data from the host bridge). Optional so the
// screen still hydrates headless / in a plain browser without a window host.
export interface IndexAppWindowPort {
  open(appId: string, launch: DesktopAppLaunch): Promise<void>;
  // Phase A2: right-click on a dock tile opens the reusable app context menu (Properties / Close)
  // anchored at the pointer. Optional so older hosts still satisfy the port.
  openContextMenu?(appId: string, x: number, y: number): boolean;
}

export type IndexScreenPorts =
  & Pick<DesktopHost, "package" | "launchApp" | "emitLauncherIntent">
  & { readonly appWindow?: IndexAppWindowPort };

export interface IndexScreenError {
  readonly surface: "palette" | "dock";
  readonly code: string;
  readonly message: string;
  readonly path: string;
  readonly commandId?: string;
  readonly appId?: string;
}

export interface IndexScreenRootState {
  readonly scope: "index.screen";
  readonly palette: IndexPaletteState;
  readonly dock: IndexDockState;
  readonly error: IndexScreenError | null;
  readonly paletteOpen: boolean;
  readonly menu: DesktopMenuSnapshot;
}

export interface IndexMenuItemRowState {
  readonly scope: "index.menu.item";
  readonly id: string;
  readonly label: string;
  readonly accelerator: string;
  readonly disabled: boolean;
  readonly checked: boolean;
}

export interface IndexPaletteResultRowState {
  readonly scope: "index.palette.result";
  readonly commandId: string;
  readonly commandKind: IndexPaletteCommand["kind"];
  readonly index: number;
  readonly title: string;
  readonly subtitle: string;
  readonly highlighted: boolean;
}

export interface IndexDockRowState {
  readonly scope: "index.dock.item";
  readonly appId: IndexDockAppId;
  readonly title: string;
  readonly icon: IndexDockItem["icon"];
  readonly running: boolean;
  readonly focused: boolean;
  readonly active: boolean;
}

export type IndexScreenState =
  | IndexScreenRootState
  | IndexPaletteResultRowState
  | IndexDockRowState
  | IndexMenuItemRowState;

export interface IndexScreenViewModel extends ScreenViewModel<IndexScreenState> {
  readonly palette: IndexPaletteViewModel;
  readonly dock: IndexDockViewModel;
  readonly menu: DesktopMenuViewModel;
  snapshot(): IndexScreenRootState;
  setPaletteQuery(query: string): void;
  movePaletteSelection(delta: number): void;
  executePalette(index?: number): Promise<void>;
  launchOrFocusDock(appId: string): Promise<void>;
  openPalette(): void;
  closePalette(): void;
  togglePalette(): void;
  toggleMenu(menuId: string): void;
  closeMenu(): void;
  setWindows(windows: readonly DesktopMenuWindow[]): void;
  selectMenuItem(itemId: string): DesktopMenuEffect;
  dismissOverlays(): void;
  // Phase A2: open the app context menu for a dock tile (right-click). No-op when no app-window port.
  showDockContextMenu(appId: string, x: number, y: number): void;
}

const INDEX_SCREEN_ID = "desktop";
const INDEX_SCREEN_EVENTS = Object.freeze(["click", "input", "keydown", "contextmenu"] as const);
const PALETTE_EXECUTE_ACTION = "palette.execute";
const DOCK_LAUNCH_ACTION = "dock.launchOrFocus";
// Right-click on a dock tile routes here (declared on the tile as a second data-vita-event).
const DOCK_CONTEXT_ACTION = "dock.contextmenu";
const MENU_ITEM_SELECT_ACTION = "menu.select";

// Per-menu open-flag bind ids consumed by the static menu-title spans in index.html.
const MENU_OPEN_BIND_IDS: readonly { readonly bindId: string; readonly menuId: string }[] = Object.freeze([
  Object.freeze({ bindId: "menu.file.open", menuId: MENU_BAR_MENU_IDS.file }),
  Object.freeze({ bindId: "menu.edit.open", menuId: MENU_BAR_MENU_IDS.edit }),
  Object.freeze({ bindId: "menu.view.open", menuId: MENU_BAR_MENU_IDS.view }),
  Object.freeze({ bindId: "menu.go.open", menuId: MENU_BAR_MENU_IDS.go }),
  Object.freeze({ bindId: "menu.window.open", menuId: MENU_BAR_MENU_IDS.window }),
  Object.freeze({ bindId: "menu.help.open", menuId: MENU_BAR_MENU_IDS.help }),
]);

// CSS selectors for the live managed windows (window-manager.ts contract). Used by the Window menu
// to enumerate / focus / close / minimize real windows. The screen treats these read-only.
const LIVE_WINDOW_SELECTOR = ".v-win[data-vita-window]";
const ACTIVE_WINDOW_DOM_ID = "vita-app-window";

export function createIndexScreenViewModel(ports: IndexScreenPorts): IndexScreenViewModel {
  return new IndexScreenModel(ports);
}

export const indexScreenActions: ReadonlyMap<string, ScreenActionHandler<IndexScreenViewModel, IndexScreenState>> =
  new Map<string, ScreenActionHandler<IndexScreenViewModel, IndexScreenState>>([
    ["palette.query", (viewModel, context) => {
      viewModel.setPaletteQuery(queryFromContext(context));
    }],
    ["palette.nav", (viewModel, context) => {
      const key = readEventKey(context.event);

      if (key === "Escape") {
        viewModel.closePalette();
        return;
      }
      if (isPaletteToggleChord(context.event)) {
        viewModel.closePalette();
        return;
      }

      viewModel.movePaletteSelection(navDeltaFromContext(context));
    }],
    ["shell.key", (viewModel, context) => {
      const key = readEventKey(context.event);

      if (isPaletteToggleChord(context.event)) {
        viewModel.togglePalette();
        return;
      }
      if (key === "Escape") {
        viewModel.dismissOverlays();
      }
    }],
    [PALETTE_EXECUTE_ACTION, async (viewModel, context) => {
      await viewModel.executePalette(paletteIndexFromContext(viewModel, context));
    }],
    [DOCK_LAUNCH_ACTION, async (viewModel, context) => {
      const appId = dockAppIdFromContext(context);

      if (appId !== undefined) {
        viewModel.closeMenu();
        await viewModel.launchOrFocusDock(appId);
      }
    }],
    [DOCK_CONTEXT_ACTION, (viewModel, context) => {
      const appId = dockAppIdFromContext(context);

      if (appId === undefined) return;

      // Suppress the native browser menu and show the desktop's own app context menu.
      preventEventDefault(context.event);
      viewModel.closeMenu();

      const { x, y } = pointerCoordinates(context.event);

      viewModel.showDockContextMenu(appId, x, y);
    }],
    ["menu.toggle", (viewModel, context) => {
      const menuId = menuIdFromContext(context);

      if (menuId === undefined) return;

      viewModel.setWindows(readLiveWindows(context.target));
      viewModel.toggleMenu(menuId);
    }],
    [MENU_ITEM_SELECT_ACTION, (viewModel, context) => {
      const itemId = menuItemIdFromContext(context);

      if (itemId === undefined) return;

      const effect = viewModel.selectMenuItem(itemId);

      viewModel.closeMenu();
      applyMenuEffect(effect, viewModel, context.target);
    }],
    ["palette.toggle", (viewModel) => {
      viewModel.togglePalette();
    }],
    ["palette.open", (viewModel) => {
      viewModel.openPalette();
    }],
    ["palette.close", (viewModel) => {
      viewModel.closePalette();
    }],
    ["overlay.dismiss", (viewModel) => {
      viewModel.dismissOverlays();
    }],
  ]);

export const indexScreenBinds: ReadonlyMap<string, ScreenBindResolver<IndexScreenState>> = createIndexScreenBinds();

export const indexScreenModule: ScreenModule<IndexScreenState, IndexScreenPorts, IndexScreenViewModel> = Object.freeze({
  actions: indexScreenActions,
  binds: indexScreenBinds,
  createViewModel(ports: IndexScreenPorts) {
    return createIndexScreenViewModel(ports);
  },
  eventTypes: INDEX_SCREEN_EVENTS,
  id: INDEX_SCREEN_ID,
  selectPorts(host: DesktopHost) {
    return selectIndexScreenPorts(host);
  },
});

export default indexScreenModule;

class IndexScreenModel implements IndexScreenViewModel {
  readonly palette: IndexPaletteViewModel;
  readonly dock: IndexDockViewModel;
  readonly menu: DesktopMenuViewModel;
  readonly #appWindow: IndexAppWindowPort | undefined;
  #error: IndexScreenError | null = null;
  #paletteOpen = false;
  #menuSnapshot: DesktopMenuSnapshot;

  constructor(ports: IndexScreenPorts) {
    this.palette = createIndexPaletteViewModel(ports satisfies IndexPalettePorts);
    this.dock = createIndexDockViewModel(ports satisfies IndexDockPorts);
    this.menu = createDesktopMenuViewModel();
    this.#menuSnapshot = this.menu.snapshot();
    this.#appWindow = ports.appWindow;
  }

  snapshot(): IndexScreenRootState {
    return freezeRootState(this.palette.snapshot(), this.dock.snapshot(), this.#error, this.#paletteOpen, this.#menuSnapshot);
  }

  setPaletteQuery(query: string): void {
    this.#error = null;
    this.palette.setQuery(query);
  }

  movePaletteSelection(delta: number): void {
    this.#error = null;
    this.palette.moveSelection(delta);
  }

  openPalette(): void {
    this.#paletteOpen = true;
    this.#menuSnapshot = this.menu.close();
  }

  closePalette(): void {
    this.#paletteOpen = false;
  }

  togglePalette(): void {
    this.#paletteOpen = !this.#paletteOpen;
    if (this.#paletteOpen) this.#menuSnapshot = this.menu.close();
  }

  toggleMenu(menuId: string): void {
    this.#paletteOpen = false;
    this.#menuSnapshot = this.menu.toggle(menuId);
  }

  closeMenu(): void {
    this.#menuSnapshot = this.menu.close();
  }

  setWindows(windows: readonly DesktopMenuWindow[]): void {
    this.#menuSnapshot = this.menu.setWindows(windows);
  }

  selectMenuItem(itemId: string): DesktopMenuEffect {
    const effect = this.menu.resolve(itemId);

    if (effect.kind === "openPalette") this.#paletteOpen = true;

    return effect;
  }

  dismissOverlays(): void {
    this.#paletteOpen = false;
    this.#menuSnapshot = this.menu.close();
  }

  showDockContextMenu(appId: string, x: number, y: number): void {
    const port = this.#appWindow;

    if (port === undefined || port.openContextMenu === undefined) return;

    try {
      port.openContextMenu(appId, x, y);
    } catch {
      // a context-menu failure must not break the dock.
    }
  }

  async executePalette(index?: number): Promise<void> {
    let result: IndexPaletteExecuteResult;

    try {
      result = await this.palette.execute(index);
    } catch {
      this.#error = screenError("palette", "PALETTE_EXECUTE_FAILED", "palette execution failed closed.", "/palette/execute");
      return;
    }

    if (result.ok) {
      this.#error = null;
      this.#paletteOpen = false;
      return;
    }

    this.#error = paletteError(result);
  }

  async launchOrFocusDock(appId: string): Promise<void> {
    let result: IndexDockActionResult;

    try {
      result = await this.dock.launchOrFocus(appId);
    } catch {
      this.#error = screenError("dock", "DOCK_LAUNCH_FAILED", "dock launch failed closed.", `/dock/${pathToken(appId)}`);
      return;
    }

    if (result.ok) {
      this.#error = null;

      indexDiag(`launchOrFocusDock ${appId} ok dispatch=${result.dispatch} appWindow=${this.#appWindow !== undefined}`);

      // Native binder path: a real dock click launched (or focused) the app via the real host
      // bridge; now open its window with REAL data. `focus` re-opens the same surface; both carry
      // the launch value on the "launchApp" dispatch (focus reuses the existing window).
      if (this.#appWindow !== undefined && result.dispatch === "launchApp") {
        try {
          await this.#appWindow.open(result.appId, result.value);
          indexDiag(`appWindow.open ${appId} returned`);
        } catch (openError) {
          indexDiag(`appWindow.open ${appId} THREW ${openError instanceof Error ? openError.message : String(openError)}`);
          // window host failures must not break the dock lifecycle.
        }
      }

      return;
    }

    this.#error = dockError(result);
  }
}

function selectIndexScreenPorts(host: DesktopHost): IndexScreenPorts {
  const ports: {
    package: DesktopUiPackageManifest;
    launchApp(app: DesktopLaunchableApp): ReturnType<DesktopHost["launchApp"]>;
    emitLauncherIntent?: NonNullable<DesktopHost["emitLauncherIntent"]>;
    appWindow?: IndexAppWindowPort;
  } = {
    launchApp(app) {
      return host.launchApp(app);
    },
    package: host.package,
  };

  const appWindow = readAppWindowPort(host);

  if (appWindow !== undefined) ports.appWindow = appWindow;

  if (host.emitLauncherIntent !== undefined) {
    ports.emitLauncherIntent = (intent) => host.emitLauncherIntent?.(intent) ?? {
      error: Object.freeze({
        code: "LAUNCHER_PORT_UNAVAILABLE",
        message: "launcher intent port is unavailable.",
        path: "/launcher",
      }),
      ok: false,
    };
  }

  return Object.freeze(ports);
}

function createIndexScreenBinds(): ReadonlyMap<string, ScreenBindResolver<IndexScreenState>> {
  const binds = new Map<string, ScreenBindResolver<IndexScreenState>>([
    ["results", (snapshot) => isRootState(snapshot) ? paletteResultItems(snapshot) : Object.freeze([])],
    ["dock", (snapshot) => isRootState(snapshot) ? dockListItems(snapshot) : Object.freeze([])],
    ["highlightedIndex", (snapshot) => isRootState(snapshot) ? snapshot.palette.highlightedIndex : -1],
    ["query", (snapshot) => isRootState(snapshot) ? snapshot.palette.query : ""],
    ["error", (snapshot) => isRootState(snapshot) && snapshot.error !== null ? snapshot.error.message : ""],
    ["errorCode", (snapshot) => isRootState(snapshot) && snapshot.error !== null ? snapshot.error.code : ""],
    ["result.title", (snapshot) => isPaletteRowState(snapshot) ? snapshot.title : ""],
    ["result.subtitle", (snapshot) => isPaletteRowState(snapshot) ? snapshot.subtitle : ""],
    ["result.commandId", (snapshot) => isPaletteRowState(snapshot) ? snapshot.commandId : ""],
    ["result.index", (snapshot) => isPaletteRowState(snapshot) ? snapshot.index : -1],
    ["result.highlighted", (snapshot) => isPaletteRowState(snapshot) ? snapshot.highlighted : false],
    ["dock.title", (snapshot) => isDockRowState(snapshot) ? snapshot.title : ""],
    ["dock.appId", (snapshot) => isDockRowState(snapshot) ? snapshot.appId : ""],
    ["dock.running", (snapshot) => isDockRowState(snapshot) ? snapshot.running : false],
    ["dock.focused", (snapshot) => isDockRowState(snapshot) ? snapshot.focused : false],
    ["dock.active", (snapshot) => isDockRowState(snapshot) ? snapshot.active : false],
    // Palette + dismiss-overlay visibility (hidden by default; shown via ⌘K / menu).
    ["palette.open", (snapshot) => isRootState(snapshot) ? snapshot.paletteOpen : false],
    ["overlay.open", (snapshot) => isRootState(snapshot) ? snapshot.paletteOpen || snapshot.menu.openMenuId !== null : false],
    // Menu bar — per-menu open flags, the open menu's item list, and the anchored dropdown.
    ["menu.anyOpen", (snapshot) => isRootState(snapshot) ? snapshot.menu.openMenuId !== null : false],
    ["menu.dropdownStyle", (snapshot) => isRootState(snapshot) ? dropdownStyle(snapshot.menu) : ""],
    ["menuItems", (snapshot) => isRootState(snapshot) ? menuItemRows(snapshot.menu) : Object.freeze([])],
    ["item.label", (snapshot) => isMenuItemRowState(snapshot) ? snapshot.label : ""],
    ["item.accelerator", (snapshot) => isMenuItemRowState(snapshot) ? snapshot.accelerator : ""],
    ["item.disabled", (snapshot) => isMenuItemRowState(snapshot) ? snapshot.disabled : false],
    ["item.checked", (snapshot) => isMenuItemRowState(snapshot) ? snapshot.checked : false],
  ]);

  for (let index = 0; index < MENU_OPEN_BIND_IDS.length; index += 1) {
    const entry = MENU_OPEN_BIND_IDS[index];

    if (entry !== undefined) {
      binds.set(entry.bindId, (snapshot) => isRootState(snapshot) && snapshot.menu.openMenuId === entry.menuId);
    }
  }

  for (let index = 0; index < DEFAULT_INDEX_DOCK_APPS.length; index += 1) {
    const app = DEFAULT_INDEX_DOCK_APPS[index];

    if (app !== undefined) {
      binds.set(`dock.${app.appId}.active`, (snapshot) => isRootState(snapshot) && dockItemActive(snapshot.dock, app.appId));
    }
  }

  return binds;
}

function paletteResultItems(snapshot: IndexScreenRootState): readonly VitaListItem[] {
  const output: VitaListItem[] = [];

  for (let index = 0; index < snapshot.palette.results.length; index += 1) {
    const command = snapshot.palette.results[index];

    if (command === undefined) continue;

    const highlighted = index === snapshot.palette.highlightedIndex;
    const rowSnapshot = paletteRowSnapshot(command, index, highlighted);

    output.push(Object.freeze({
      attrs: Object.freeze([
        attr("data-vita-action", PALETTE_EXECUTE_ACTION),
        attr("data-vita-event", "click"),
        attr("data-vita-command-id", command.id),
        attr("data-vita-palette-index", `${index}`),
        attr("data-vita-command-kind", command.kind),
        attr("aria-selected", highlighted ? "true" : "false"),
      ]),
      classes: Object.freeze([
        classPatch("is-highlighted", highlighted),
      ]),
      key: command.id,
      snapshot: rowSnapshot,
    }));
  }

  return Object.freeze(output);
}

function dockListItems(snapshot: IndexScreenRootState): readonly VitaListItem[] {
  const output: VitaListItem[] = [];

  for (let index = 0; index < snapshot.dock.items.length; index += 1) {
    const item = snapshot.dock.items[index];

    if (item === undefined) continue;

    const rowSnapshot = dockRowSnapshot(item);

    output.push(Object.freeze({
      attrs: Object.freeze([
        attr("data-vita-action", DOCK_LAUNCH_ACTION),
        attr("data-vita-event", "click"),
        // Right-click on the tile routes to the context-menu action (Properties / Close).
        attr("data-vita-action-contextmenu", DOCK_CONTEXT_ACTION),
        attr("data-vita-dock-app-id", item.appId),
        attr("aria-pressed", rowSnapshot.active ? "true" : "false"),
        attr("title", item.title),
      ]),
      classes: Object.freeze([
        classPatch("on", rowSnapshot.active),
      ]),
      key: item.appId,
      snapshot: rowSnapshot,
    }));
  }

  return Object.freeze(output);
}

function menuItemRows(menu: DesktopMenuSnapshot): readonly VitaListItem[] {
  const output: VitaListItem[] = [];

  for (let index = 0; index < menu.items.length; index += 1) {
    const item = menu.items[index];

    if (item === undefined) continue;

    output.push(Object.freeze({
      attrs: Object.freeze([
        attr("data-vita-action", MENU_ITEM_SELECT_ACTION),
        attr("data-vita-event", "click"),
        attr("data-vita-item-id", item.id),
        attr("aria-disabled", item.disabled ? "true" : "false"),
      ]),
      classes: Object.freeze([
        classPatch("disabled", item.disabled),
        classPatch("is-checked", item.checked),
      ]),
      key: item.id,
      snapshot: menuItemRowSnapshot(item),
    }));
  }

  return Object.freeze(output);
}

function menuItemRowSnapshot(item: DesktopMenuRenderItem): IndexMenuItemRowState {
  return Object.freeze({
    accelerator: item.accelerator,
    checked: item.checked,
    disabled: item.disabled,
    id: item.id,
    label: item.label,
    scope: "index.menu.item",
  });
}

function dropdownStyle(menu: DesktopMenuSnapshot): string {
  return `left:${menu.dropdownLeft}px`;
}

function paletteRowSnapshot(
  command: IndexPaletteCommand,
  index: number,
  highlighted: boolean,
): IndexPaletteResultRowState {
  return Object.freeze({
    commandId: command.id,
    commandKind: command.kind,
    highlighted,
    index,
    scope: "index.palette.result",
    subtitle: command.subtitle,
    title: command.title,
  });
}

function dockRowSnapshot(item: IndexDockItem): IndexDockRowState {
  return Object.freeze({
    active: item.running || item.focused,
    appId: item.appId,
    focused: item.focused,
    icon: item.icon,
    running: item.running,
    scope: "index.dock.item",
    title: item.title,
  });
}

function queryFromContext(context: VitaActionContext<IndexScreenState>): string {
  return readDataset(context.target, Object.freeze(["vitaQuery", "vitaValue"])) ??
    readOwnString(context.event.target, "value") ??
    readOwnString(context.target, "value") ??
    readTextContent(context.target) ??
    rootSnapshotFromContext(context)?.palette.query ??
    "";
}

function navDeltaFromContext(context: VitaActionContext<IndexScreenState>): number {
  const declared = readDataset(context.target, Object.freeze(["vitaDelta", "vitaNavDelta"]));
  const delta = declared === undefined ? undefined : finiteInteger(declared);

  if (delta !== undefined) return delta;

  const key = readEventKey(context.event);

  if (key === "ArrowUp") return -1;
  if (key === "ArrowDown") return 1;

  return 1;
}

function paletteIndexFromContext(
  viewModel: IndexScreenViewModel,
  context: VitaActionContext<IndexScreenState>,
): number | undefined {
  const declared = readDataset(context.target, Object.freeze(["vitaPaletteIndex", "vitaIndex"]));
  const index = declared === undefined ? undefined : finiteInteger(declared);

  if (index !== undefined) return index;

  const commandId = readDataset(context.target, Object.freeze(["vitaCommandId"]));

  if (commandId === undefined) return undefined;

  return findPaletteResultIndex(rootSnapshotFromContext(context) ?? viewModel.snapshot(), commandId);
}

function dockAppIdFromContext(context: VitaActionContext<IndexScreenState>): string | undefined {
  return readDataset(context.target, Object.freeze(["vitaDockAppId", "vitaAppId"]));
}

// Suppress the native browser context menu so the desktop's themed app menu shows instead.
function preventEventDefault(event: unknown): void {
  if (!isObjectLike(event)) return;

  try {
    const fn = (event as { preventDefault?: unknown }).preventDefault;

    if (typeof fn === "function") Reflect.apply(fn, event, []);
  } catch {
    // ignore
  }
}

// Read viewport pointer coordinates (clientX/clientY) off a contextmenu event; default to 0.
function pointerCoordinates(event: unknown): { x: number; y: number } {
  const x = readEventNumber(event, "clientX");
  const y = readEventNumber(event, "clientY");

  return { x: x ?? 0, y: y ?? 0 };
}

function readEventNumber(source: unknown, key: string): number | undefined {
  const value = readOwnOrAccessor(source, key);

  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function menuIdFromContext(context: VitaActionContext<IndexScreenState>): string | undefined {
  return readDataset(context.target, Object.freeze(["vitaMenuId"]));
}

function menuItemIdFromContext(context: VitaActionContext<IndexScreenState>): string | undefined {
  return readDataset(context.target, Object.freeze(["vitaItemId"]));
}

// Cmd/Ctrl-K toggles the command palette (the global shell shortcut).
function isPaletteToggleChord(event: VitaActionContext<IndexScreenState>["event"]): boolean {
  const key = readEventKey(event);

  if (key !== "k" && key !== "K") return false;

  return readEventBoolean(event, "metaKey") || readEventBoolean(event, "ctrlKey");
}

// A keyboard event's `key`/`ctrlKey`/`metaKey` are OWN data props on the binder's plain test events
// but INHERITED accessors on a real DOM KeyboardEvent. Resolve both so the chord works live AND in
// tests (mirrors bootstrap.ts's own-or-getter reader; still no prototype WALK beyond the getter).
function readEventKey(event: unknown): string | undefined {
  return readObjectString(event, "key") ?? readObjectString(event, "code");
}

function readObjectString(source: unknown, key: string): string | undefined {
  const value = readOwnOrAccessor(source, key);

  return typeof value === "string" ? value : undefined;
}

function readEventBoolean(source: unknown, key: string): boolean {
  return readOwnOrAccessor(source, key) === true;
}

function readOwnOrAccessor(source: unknown, key: string): unknown {
  if (!isObjectLike(source)) return undefined;

  try {
    let current: object | null = source;

    for (let depth = 0; depth < 4 && current !== null; depth += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(current, key);

      if (descriptor !== undefined) {
        if (Object.prototype.hasOwnProperty.call(descriptor, "value")) return descriptor.value;

        const getter = descriptor.get;

        return typeof getter === "function" ? Reflect.apply(getter, source, []) : undefined;
      }

      current = Object.getPrototypeOf(current) as object | null;
    }
  } catch {
    return undefined;
  }

  return undefined;
}

function rootSnapshotFromContext(context: VitaActionContext<IndexScreenState>): IndexScreenRootState | undefined {
  const snapshot = context.snapshot;

  return snapshot !== undefined && isRootState(snapshot) ? snapshot : undefined;
}

function findPaletteResultIndex(snapshot: IndexScreenRootState, commandId: string): number | undefined {
  for (let index = 0; index < snapshot.palette.results.length; index += 1) {
    const command = snapshot.palette.results[index];

    if (command !== undefined && command.id === commandId) return index;
  }

  return undefined;
}

function dockItemActive(state: IndexDockState, appId: IndexDockAppId): boolean {
  for (let index = 0; index < state.items.length; index += 1) {
    const item = state.items[index];

    if (item !== undefined && item.appId === appId) {
      return item.running || item.focused;
    }
  }

  return false;
}

function freezeRootState(
  palette: IndexPaletteState,
  dock: IndexDockState,
  errorValue: IndexScreenError | null,
  paletteOpen: boolean,
  menu: DesktopMenuSnapshot,
): IndexScreenRootState {
  return Object.freeze({
    dock,
    error: errorValue,
    menu,
    palette,
    paletteOpen,
    scope: "index.screen",
  });
}

function paletteError(result: Extract<IndexPaletteExecuteResult, { readonly ok: false }>): IndexScreenError {
  const command = result.command;
  const output = screenError("palette", result.error.code, result.error.message, result.error.path);

  if (command === undefined) return output;

  return Object.freeze({
    ...output,
    commandId: command.id,
  });
}

function dockError(result: Extract<IndexDockActionResult, { readonly ok: false }>): IndexScreenError {
  const output = screenError("dock", result.error.code, result.error.message, result.error.path);

  if (result.appId === undefined) return output;

  return Object.freeze({
    ...output,
    appId: result.appId,
  });
}

function screenError(
  surface: IndexScreenError["surface"],
  code: string,
  message: string,
  path: string,
): IndexScreenError {
  return Object.freeze({
    code,
    message,
    path,
    surface,
  });
}

function attr(name: string, value: VitaListAttributePatch["value"]): VitaListAttributePatch {
  return Object.freeze({
    name,
    value,
  });
}

function classPatch(className: string, enabled: boolean): VitaListClassPatch {
  return Object.freeze({
    className,
    enabled,
  });
}

// ---------------------------------------------------------------------------------------------
// Live-window adapter + menu effects.
//
// The Window menu and a handful of menu items act on the REAL desktop. We reach the live managed
// windows (window-manager.ts) through the action target's DOM root and operate on them via the
// standard browser API (querySelector / dispatchEvent / click), feature-detected so the headless
// test stub (a narrow VitaElement) simply no-ops. We never import window-manager.ts (owned by the
// app-window parallel agent) — only its stable `.v-win[data-vita-window]` DOM contract.
// ---------------------------------------------------------------------------------------------

interface LiveDomNode {
  readonly id?: string;
  readonly dataset?: Readonly<Record<string, string | undefined>>;
  getAttribute?(name: string): string | null;
  querySelector?(selector: string): LiveDomNode | null;
  querySelectorAll?(selector: string): ArrayLike<LiveDomNode>;
  closest?(selector: string): LiveDomNode | null;
  click?(): void;
  focus?(): void;
}

interface LiveWindowNode extends DesktopMenuWindow {
  readonly node: LiveDomNode;
}

function liveDomNode(value: unknown): LiveDomNode | null {
  return value !== null && typeof value === "object" ? (value as LiveDomNode) : null;
}

function screenRootFrom(target: unknown): LiveDomNode | null {
  const node = liveDomNode(target);

  if (node === null || typeof node.closest !== "function") return null;

  try {
    return node.closest("[data-vita-screen]");
  } catch {
    return null;
  }
}

function liveWindowNodes(target: unknown): readonly LiveWindowNode[] {
  const root = screenRootFrom(target);

  if (root === null || typeof root.querySelectorAll !== "function") return Object.freeze([]);

  let list: ArrayLike<LiveDomNode>;

  try {
    list = root.querySelectorAll(LIVE_WINDOW_SELECTOR);
  } catch {
    return Object.freeze([]);
  }

  const output: LiveWindowNode[] = [];

  for (let index = 0; index < list.length; index += 1) {
    const node = list[index];

    if (node === null || node === undefined) continue;

    const appId = liveWindowAttr(node, "data-vita-window") ?? "";
    const domId = typeof node.id === "string" && node.id.length > 0 ? node.id : `window:${index}`;
    const focused = node.id === ACTIVE_WINDOW_DOM_ID;
    const title = liveWindowTitle(node) ?? appId ?? domId;

    output.push(Object.freeze({
      appId,
      focused,
      id: domId,
      minimized: false,
      node,
      title,
    }));
  }

  return Object.freeze(output);
}

function readLiveWindows(target: unknown): readonly DesktopMenuWindow[] {
  const nodes = liveWindowNodes(target);
  const output: DesktopMenuWindow[] = [];

  for (let index = 0; index < nodes.length; index += 1) {
    const node = nodes[index];

    if (node !== undefined) {
      output.push(Object.freeze({
        appId: node.appId,
        focused: node.focused,
        id: node.id,
        minimized: node.minimized,
        title: node.title,
      }));
    }
  }

  return Object.freeze(output);
}

function liveWindowAttr(node: LiveDomNode, name: string): string | undefined {
  if (typeof node.getAttribute !== "function") return undefined;

  try {
    const value = node.getAttribute(name);

    return typeof value === "string" && value.length > 0 ? value : undefined;
  } catch {
    return undefined;
  }
}

function liveWindowTitle(node: LiveDomNode): string | undefined {
  if (typeof node.querySelector !== "function") return undefined;

  try {
    const el = node.querySelector("[data-vita-window-title]");
    const text = el === null ? undefined : (el as { textContent?: string | null }).textContent;

    return typeof text === "string" && text.trim().length > 0 ? text.trim() : undefined;
  } catch {
    return undefined;
  }
}

function focusedWindowNode(target: unknown): LiveWindowNode | undefined {
  const nodes = liveWindowNodes(target);

  for (let index = 0; index < nodes.length; index += 1) {
    const node = nodes[index];

    if (node !== undefined && node.focused) return node;
  }

  return nodes[0];
}

function clickWindowControl(node: LiveDomNode | undefined, selector: string): void {
  if (node === undefined || typeof node.querySelector !== "function") return;

  try {
    const control = node.querySelector(selector);

    if (control !== null && typeof control.click === "function") control.click();
  } catch {
    // a missing/closed control must not break the shell.
  }
}

function focusWindowNode(node: LiveDomNode | undefined): void {
  if (node === undefined) return;

  // Bringing a window forward: prefer the WM's own focus path (clicking the title bar fires the
  // pointerdown that raises it); fall back to element.focus().
  try {
    if (typeof node.querySelector === "function") {
      const titlebar = node.querySelector("[data-vita-window-titlebar]");

      if (titlebar !== null && typeof titlebar.click === "function") {
        titlebar.click();
        return;
      }
    }

    if (typeof node.focus === "function") node.focus();
    else if (typeof node.click === "function") node.click();
  } catch {
    // ignore
  }
}

function findLiveWindowById(target: unknown, windowId: string): LiveDomNode | undefined {
  const nodes = liveWindowNodes(target);

  for (let index = 0; index < nodes.length; index += 1) {
    const node = nodes[index];

    if (node !== undefined && node.id === windowId) return node.node;
  }

  return undefined;
}

function nextWindowNode(target: unknown): LiveDomNode | undefined {
  const nodes = liveWindowNodes(target);

  if (nodes.length === 0) return undefined;

  let focusedIndex = -1;

  for (let index = 0; index < nodes.length; index += 1) {
    if (nodes[index]?.focused) {
      focusedIndex = index;
      break;
    }
  }

  const next = nodes[(focusedIndex + 1) % nodes.length];

  return next?.node;
}

function toggleScreenTheme(target: unknown): void {
  const root = screenRootFrom(target);
  const classList = root === null ? undefined : (root as { classList?: { toggle(token: string, force?: boolean): boolean } }).classList;

  if (classList === undefined || typeof classList.toggle !== "function") return;

  try {
    const isDark = liveWindowAttr(root as LiveDomNode, "class")?.includes("theme-dark") ?? true;

    classList.toggle("theme-dark", !isDark);
    classList.toggle("theme-light", isDark);
    classList.toggle("v-wall-dark", !isDark);
    classList.toggle("v-wall-light", isDark);
  } catch {
    // ignore
  }
}

function applyMenuEffect(
  effect: DesktopMenuEffect,
  viewModel: IndexScreenViewModel,
  target: unknown,
): void {
  switch (effect.kind) {
    case "openSettings":
      void viewModel.launchOrFocusDock("vita.app.settings");
      return;
    case "launchApp":
      void viewModel.launchOrFocusDock(effect.appId);
      return;
    case "toggleTheme":
      toggleScreenTheme(target);
      return;
    case "focusWindow":
      focusWindowNode(findLiveWindowById(target, effect.windowId));
      return;
    case "closeFocusedWindow":
      clickWindowControl(focusedWindowNode(target)?.node, "[data-vita-window-close]");
      return;
    case "minimizeFocusedWindow":
      clickWindowControl(focusedWindowNode(target)?.node, "[data-vita-window-min]");
      return;
    case "maximizeFocusedWindow":
      clickWindowControl(focusedWindowNode(target)?.node, "[data-vita-window-zoom]");
      return;
    case "cycleWindow":
      focusWindowNode(nextWindowNode(target));
      return;
    case "openPalette":
    case "showAbout":
    case "showHelp":
    case "none":
    default:
      return;
  }
}

function readDataset(element: Pick<VitaActionContext<IndexScreenState>, "target">["target"], keys: readonly string[]): string | undefined {
  try {
    for (let index = 0; index < keys.length; index += 1) {
      const key = keys[index];
      const value = key === undefined ? undefined : element.dataset[key];

      if (typeof value === "string" && value.length > 0) return value;
    }
  } catch {
    return undefined;
  }

  return undefined;
}

function indexDiag(line: string): void {
  try {
    const log = (globalThis as Record<string, unknown>)["__vitaLog"];

    if (typeof log === "function") (log as (s: string) => void)(`VITA-INDEX ${line}`);
  } catch {
    // ignore
  }
}

function readAppWindowPort(host: DesktopHost): IndexAppWindowPort | undefined {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(host, "appWindow");
    const value = descriptor?.value;

    if (value !== null && typeof value === "object" && typeof (value as { open?: unknown }).open === "function") {
      return value as IndexAppWindowPort;
    }
  } catch {
    return undefined;
  }

  return undefined;
}

function readOwnString(source: unknown, key: string): string | undefined {
  if (!isObjectLike(source)) return undefined;

  try {
    const descriptor = Object.getOwnPropertyDescriptor(source, key);

    if (descriptor === undefined || !Object.prototype.hasOwnProperty.call(descriptor, "value")) {
      return undefined;
    }

    return typeof descriptor.value === "string" ? descriptor.value : undefined;
  } catch {
    return undefined;
  }
}

function readTextContent(target: VitaActionContext<IndexScreenState>["target"]): string | undefined {
  try {
    return target.textContent ?? undefined;
  } catch {
    return undefined;
  }
}

function finiteInteger(value: string): number | undefined {
  const numeric = Number(value);

  if (!Number.isFinite(numeric)) return undefined;

  return Math.trunc(numeric);
}

function isRootState(snapshot: IndexScreenState): snapshot is IndexScreenRootState {
  return snapshot.scope === "index.screen";
}

function isPaletteRowState(snapshot: IndexScreenState): snapshot is IndexPaletteResultRowState {
  return snapshot.scope === "index.palette.result";
}

function isDockRowState(snapshot: IndexScreenState): snapshot is IndexDockRowState {
  return snapshot.scope === "index.dock.item";
}

function isMenuItemRowState(snapshot: IndexScreenState): snapshot is IndexMenuItemRowState {
  return snapshot.scope === "index.menu.item";
}

function isObjectLike(value: unknown): value is object {
  return value !== null && typeof value === "object";
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
