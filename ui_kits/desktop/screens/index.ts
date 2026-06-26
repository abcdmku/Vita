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

// PSD-501: the index screen also receives an app-window host. After a dock tile's NATIVE binder
// action launches an app via the real host bridge, the index view-model asks the window host to
// open a real surface for it (populated with live data from the host bridge). Optional so the
// screen still hydrates headless / in a plain browser without a window host.
export interface IndexAppWindowPort {
  open(appId: string, launch: DesktopAppLaunch): Promise<void>;
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
  | IndexDockRowState;

export interface IndexScreenViewModel extends ScreenViewModel<IndexScreenState> {
  readonly palette: IndexPaletteViewModel;
  readonly dock: IndexDockViewModel;
  snapshot(): IndexScreenRootState;
  setPaletteQuery(query: string): void;
  movePaletteSelection(delta: number): void;
  executePalette(index?: number): Promise<void>;
  launchOrFocusDock(appId: string): Promise<void>;
}

const INDEX_SCREEN_ID = "desktop";
const INDEX_SCREEN_EVENTS = Object.freeze(["click", "input", "keydown"] as const);
const PALETTE_EXECUTE_ACTION = "palette.execute";
const DOCK_LAUNCH_ACTION = "dock.launchOrFocus";

export function createIndexScreenViewModel(ports: IndexScreenPorts): IndexScreenViewModel {
  return new IndexScreenModel(ports);
}

export const indexScreenActions: ReadonlyMap<string, ScreenActionHandler<IndexScreenViewModel, IndexScreenState>> =
  new Map<string, ScreenActionHandler<IndexScreenViewModel, IndexScreenState>>([
    ["palette.query", (viewModel, context) => {
      viewModel.setPaletteQuery(queryFromContext(context));
    }],
    ["palette.nav", (viewModel, context) => {
      viewModel.movePaletteSelection(navDeltaFromContext(context));
    }],
    [PALETTE_EXECUTE_ACTION, async (viewModel, context) => {
      await viewModel.executePalette(paletteIndexFromContext(viewModel, context));
    }],
    [DOCK_LAUNCH_ACTION, async (viewModel, context) => {
      const appId = dockAppIdFromContext(context);

      if (appId !== undefined) {
        await viewModel.launchOrFocusDock(appId);
      }
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
  readonly #appWindow: IndexAppWindowPort | undefined;
  #error: IndexScreenError | null = null;

  constructor(ports: IndexScreenPorts) {
    this.palette = createIndexPaletteViewModel(ports satisfies IndexPalettePorts);
    this.dock = createIndexDockViewModel(ports satisfies IndexDockPorts);
    this.#appWindow = ports.appWindow;
  }

  snapshot(): IndexScreenRootState {
    return freezeRootState(this.palette.snapshot(), this.dock.snapshot(), this.#error);
  }

  setPaletteQuery(query: string): void {
    this.#error = null;
    this.palette.setQuery(query);
  }

  movePaletteSelection(delta: number): void {
    this.#error = null;
    this.palette.moveSelection(delta);
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
  ]);

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

  const key = readOwnString(context.event, "key");

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
): IndexScreenRootState {
  return Object.freeze({
    dock,
    error: errorValue,
    palette,
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
