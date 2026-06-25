import type {
  Rect,
} from "../../../sdk/typescript/src/desktop-sdk/index.ts";
import {
  INDEX_DOCK_APP_IDS,
} from "./dock.ts";
import type {
  IndexDockActionResult,
  IndexDockAppId,
  IndexDockItem,
  IndexDockState,
  IndexDockViewModel,
} from "./dock.ts";
import {
  INDEX_PALETTE_APP_IDS,
  INDEX_PALETTE_COMMAND_IDS,
} from "./index.ts";
import type {
  IndexPaletteExecuteResult,
  IndexPaletteViewModel,
} from "./index.ts";
import type {
  FilesViewEntry,
  FilesViewModel,
  FilesViewState,
} from "./files.ts";
import type {
  SearchExecuteResult,
  SearchViewModel,
} from "./search.ts";
import {
  SETTINGS_ACCENT_OPTIONS,
  SETTINGS_LAYOUTS,
  SETTINGS_SECTIONS,
  SETTINGS_THEMES,
} from "./Settings.ts";
import type {
  SettingsViewModel,
  SettingsViewModelActionResult,
} from "./Settings.ts";
import {
  TILING_PANE_IDS,
} from "./Tiling.ts";
import type {
  TilingPaneId,
  TilingViewModel,
  TilingViewModelResult,
  TilingViewModelState,
} from "./Tiling.ts";
import type {
  NotificationsActionResult,
  NotificationsViewModel,
  NotificationsViewState,
} from "./Notifications.ts";
import type {
  WindowSnapCommand,
  WindowSnapViewModel,
  WindowSnapViewModelResult,
  WindowSnapViewModelState,
} from "./window-snap.ts";

export type A11yKeyboardAuditScreen =
  | "dock"
  | "palette"
  | "search"
  | "files"
  | "tiling"
  | "window-snap"
  | "settings"
  | "notifications";

export interface A11yKeyboardEvent {
  readonly key: string;
  readonly altKey?: true;
  readonly ctrlKey?: true;
  readonly metaKey?: true;
  readonly shiftKey?: true;
}

export interface A11yKeyboardAuditOutcome {
  readonly reached: boolean;
  readonly before: string;
  readonly after: string;
  readonly detail: string;
}

export interface A11yKeyboardAuditCase {
  readonly screen: A11yKeyboardAuditScreen;
  readonly actionId: string;
  readonly label: string;
  readonly keySequence: readonly A11yKeyboardEvent[];
  run(): Promise<A11yKeyboardAuditOutcome>;
}

export interface A11yKeyboardAuditEntry {
  readonly screen: A11yKeyboardAuditScreen;
  readonly actionId: string;
  readonly label: string;
  readonly keySequence: readonly A11yKeyboardEvent[];
  readonly reached: boolean;
  readonly status: "passed" | "failed";
  readonly before: string;
  readonly after: string;
  readonly detail: string;
}

export interface A11yKeyboardAuditReport {
  readonly passed: boolean;
  readonly entries: readonly A11yKeyboardAuditEntry[];
}

export interface DesktopShellA11yKeyboardAuditFixture {
  readonly createDock: () => IndexDockViewModel;
  readonly createPalette: () => IndexPaletteViewModel;
  readonly createSearch: () => SearchViewModel;
  readonly createFiles: () => FilesViewModel;
  readonly createTiling: () => TilingViewModel;
  readonly createWindowSnap: () => WindowSnapViewModel;
  readonly createSettings: () => Promise<SettingsViewModel>;
  readonly createNotifications: () => NotificationsViewModel;
}

type SettingsKeyboardFocusGroup = "sections" | "themes" | "accents" | "layouts";
type NotificationsKeyboardFocusGroup = "notifications" | "controls";

const TILING_KEYBOARD_MOVE_RECT = Object.freeze({
  height: 240,
  width: 360,
  x: 120,
  y: 144,
}) satisfies Rect;

const SETTINGS_FOCUS_ORDER = Object.freeze([
  "sections",
  "themes",
  "accents",
  "layouts",
] as const);

export async function runA11yKeyboardAudit(
  cases: readonly A11yKeyboardAuditCase[],
): Promise<A11yKeyboardAuditReport> {
  const entries: A11yKeyboardAuditEntry[] = [];
  let passed = true;

  for (let index = 0; index < cases.length; index += 1) {
    const testCase = cases[index];

    if (testCase === undefined) continue;

    const outcome = await safelyRunAuditCase(testCase);
    const status = outcome.reached ? "passed" : "failed";

    if (status === "failed") passed = false;
    entries.push(Object.freeze({
      actionId: testCase.actionId,
      after: outcome.after,
      before: outcome.before,
      detail: outcome.detail,
      keySequence: freezeKeySequence(testCase.keySequence),
      label: testCase.label,
      reached: outcome.reached,
      screen: testCase.screen,
      status,
    }));
  }

  return Object.freeze({
    entries: Object.freeze(entries),
    passed,
  });
}

export function serializeA11yKeyboardAuditReport(report: A11yKeyboardAuditReport): string {
  return JSON.stringify(report);
}

export function createDesktopShellA11yKeyboardAuditCases(
  fixture: DesktopShellA11yKeyboardAuditFixture,
): readonly A11yKeyboardAuditCase[] {
  return Object.freeze([
    ...createDockAuditCases(fixture.createDock),
    ...createPaletteAuditCases(fixture.createPalette),
    ...createSearchAuditCases(fixture.createSearch),
    ...createFilesAuditCases(fixture.createFiles),
    ...createTilingAuditCases(fixture.createTiling),
    ...createWindowSnapAuditCases(fixture.createWindowSnap),
    ...createSettingsAuditCases(fixture.createSettings),
    ...createNotificationsAuditCases(fixture.createNotifications),
  ]);
}

export function createPointerOnlyWindowSnapA11yKeyboardAuditCase(
  createWindowSnap: () => WindowSnapViewModel,
): A11yKeyboardAuditCase {
  return auditCase({
    actionId: "window-snap.pointer-only.bottom-right",
    keySequence: Object.freeze([]),
    label: "Pointer-only bottom-right snap is not keyboard reachable",
    run: () => runPointerOnlyWindowSnapAudit(createWindowSnap),
    screen: "window-snap",
  });
}

function createDockAuditCases(
  createDock: () => IndexDockViewModel,
): readonly A11yKeyboardAuditCase[] {
  const targets = Object.freeze([
    Object.freeze({
      actionId: "dock.launch.terminal",
      appId: INDEX_DOCK_APP_IDS.terminal,
      index: 0,
      label: "Launch Terminal from dock",
    }),
    Object.freeze({
      actionId: "dock.launch.code",
      appId: INDEX_DOCK_APP_IDS.code,
      index: 1,
      label: "Launch Code from dock",
    }),
    Object.freeze({
      actionId: "dock.launch.files",
      appId: INDEX_DOCK_APP_IDS.files,
      index: 2,
      label: "Launch Files from dock",
    }),
    Object.freeze({
      actionId: "dock.launch.mail",
      appId: INDEX_DOCK_APP_IDS.mail,
      index: 3,
      label: "Launch Mail from dock",
    }),
    Object.freeze({
      actionId: "dock.launch.browser",
      appId: INDEX_DOCK_APP_IDS.browser,
      index: 4,
      label: "Launch Browser from dock",
    }),
    Object.freeze({
      actionId: "dock.launch.settings",
      appId: INDEX_DOCK_APP_IDS.settings,
      index: 5,
      label: "Launch Settings from dock",
    }),
  ]);
  const cases: A11yKeyboardAuditCase[] = [];

  for (let index = 0; index < targets.length; index += 1) {
    const target = targets[index];

    if (target === undefined) continue;
    cases.push(dockLaunchCase(createDock, target.actionId, target.label, target.appId, target.index));
  }

  cases.push(auditCase({
    actionId: "dock.focus.running-terminal",
    keySequence: keySequence(
      keyStroke("Enter"),
      keyStroke("ArrowRight"),
      keyStroke("Enter"),
      keyStroke("ArrowLeft"),
      keyStroke("Enter"),
    ),
    label: "Focus a running Terminal dock item",
    run: () => runDockFocusAudit(createDock),
    screen: "dock",
  }));

  return Object.freeze(cases);
}

function createPaletteAuditCases(
  createPalette: () => IndexPaletteViewModel,
): readonly A11yKeyboardAuditCase[] {
  return Object.freeze([
    paletteCase(createPalette, "palette.command.run-kernel", "Run kernel.ts command", "kernel", INDEX_PALETTE_COMMAND_IDS.runKernel, "launcherIntent"),
    paletteCase(createPalette, "palette.app.files", "Open Files command", "files", "app.files", "launchApp"),
    paletteCase(createPalette, "palette.command.toggle-dark-mode", "Toggle Dark Mode command", "dark", INDEX_PALETTE_COMMAND_IDS.toggleDarkMode, "launcherIntent"),
    paletteCase(createPalette, "palette.app.terminal", "Open Terminal command", "terminal", "app.terminal", "launchApp"),
    paletteCase(createPalette, "palette.app.code", "Open Code command", "code", "app.code", "launchApp"),
    paletteCase(createPalette, "palette.app.mail", "Open Mail command", "mail", "app.mail", "launchApp"),
    paletteCase(createPalette, "palette.app.browser", "Open Browser command", "browser", "app.browser", "launchApp"),
    paletteCase(createPalette, "palette.app.settings", "Open Settings command", "settings", "app.settings", "launchApp"),
  ]);
}

function createSearchAuditCases(
  createSearch: () => SearchViewModel,
): readonly A11yKeyboardAuditCase[] {
  return Object.freeze([
    searchCase(createSearch, "search.open-app", "Open an app search result", "Alpha App", "launchApp"),
    searchCase(createSearch, "search.open-file", "Open a file search result", "alpha.txt", "openFile"),
    searchCase(createSearch, "search.run-command", "Run a command search result", "Alpha Command", "launcherIntent"),
    searchCase(createSearch, "search.open-setting", "Open a setting search result", "Alpha Setting", "openSetting"),
  ]);
}

function createFilesAuditCases(
  createFiles: () => FilesViewModel,
): readonly A11yKeyboardAuditCase[] {
  return Object.freeze([
    filesCase(createFiles, "files.refresh", "Refresh the current directory", keySequence(keyStroke("F5")), (state) => (
      state.status === "ready" && state.path === "/workspace/src" && state.entries.length > 0
    )),
    filesCase(createFiles, "files.navigate-directory", "Open a selected directory", keySequence(
      keyStroke("F5"),
      keyStroke("ArrowDown"),
      keyStroke("Enter"),
    ), (state) => state.status === "ready" && state.path === "/workspace/src/apps"),
    filesCase(createFiles, "files.select-file", "Select a file entry", keySequence(
      keyStroke("F5"),
      keyStroke("ArrowDown"),
      keyStroke("ArrowDown"),
    ), (state) => state.selected?.name === "kernel.ts"),
    filesCase(createFiles, "files.navigate-up", "Navigate to the parent directory", keySequence(
      keyStroke("F5"),
      keyStroke("ArrowDown"),
      keyStroke("Enter"),
      keyStroke("ArrowUp", { altKey: true }),
    ), (state) => state.status === "ready" && state.path === "/workspace/src"),
    filesCase(createFiles, "files.favorite.home", "Open the Home favorite", keySequence(
      keyStroke("1", { ctrlKey: true }),
    ), (state) => state.status === "ready" && state.path === "/workspace"),
    filesCase(createFiles, "files.favorite.apps", "Open the apps favorite", keySequence(
      keyStroke("3", { ctrlKey: true }),
    ), (state) => state.status === "ready" && state.path === "/workspace/src/apps"),
  ]);
}

function createTilingAuditCases(
  createTiling: () => TilingViewModel,
): readonly A11yKeyboardAuditCase[] {
  return Object.freeze([
    tilingCase(createTiling, "tiling.focus-explorer", "Focus the explorer pane", keySequence(
      keyStroke("2", { ctrlKey: true }),
    ), (state) => state.activePaneId === "explorer"),
    tilingCase(createTiling, "tiling.focus-system", "Focus the system pane", keySequence(
      keyStroke("3", { ctrlKey: true }),
    ), (state) => state.activePaneId === "system"),
    tilingCase(createTiling, "tiling.cycle-layout", "Cycle the workspace layout", keySequence(
      keyStroke("Space", { ctrlKey: true }),
    ), (state) => state.layout === "columns"),
    tilingCase(createTiling, "tiling.split-next", "Move focus to the next pane", keySequence(
      keyStroke("ArrowRight", { altKey: true }),
    ), (state) => state.activePaneId === "explorer"),
    tilingCase(createTiling, "tiling.split-previous", "Move focus to the previous pane", keySequence(
      keyStroke("ArrowRight", { altKey: true }),
      keyStroke("ArrowLeft", { altKey: true }),
    ), (state) => state.activePaneId === "editor"),
    tilingCase(createTiling, "tiling.move-focused-pane", "Move the focused pane", keySequence(
      keyStroke("ArrowRight", { ctrlKey: true, shiftKey: true }),
    ), (state) => paneHasRect(state, "editor", TILING_KEYBOARD_MOVE_RECT)),
    tilingCase(createTiling, "tiling.move-to-workspace", "Move the focused pane to workspace 2", keySequence(
      keyStroke("2", { altKey: true, ctrlKey: true }),
    ), (state) => paneWorkspace(state, "editor") === "workspace-2"),
  ]);
}

function createWindowSnapAuditCases(
  createWindowSnap: () => WindowSnapViewModel,
): readonly A11yKeyboardAuditCase[] {
  return Object.freeze([
    windowSnapCase(createWindowSnap, "window-snap.left-half", "Snap focused window left", keySequence(
      keyStroke("ArrowLeft", { metaKey: true }),
    ), "left-half"),
    windowSnapCase(createWindowSnap, "window-snap.right-half", "Snap focused window right", keySequence(
      keyStroke("ArrowRight", { metaKey: true }),
    ), "right-half"),
    windowSnapCase(createWindowSnap, "window-snap.top-half", "Snap focused window top", keySequence(
      keyStroke("ArrowUp", { metaKey: true, shiftKey: true }),
    ), "top-half"),
    windowSnapCase(createWindowSnap, "window-snap.bottom-half", "Snap focused window bottom", keySequence(
      keyStroke("ArrowDown", { metaKey: true, shiftKey: true }),
    ), "bottom-half"),
    windowSnapCase(createWindowSnap, "window-snap.top-left", "Snap focused window top-left", keySequence(
      keyStroke("ArrowLeft+ArrowUp", { metaKey: true }),
    ), "top-left"),
    windowSnapCase(createWindowSnap, "window-snap.top-right", "Snap focused window top-right", keySequence(
      keyStroke("ArrowRight+ArrowUp", { metaKey: true }),
    ), "top-right"),
    windowSnapCase(createWindowSnap, "window-snap.bottom-left", "Snap focused window bottom-left", keySequence(
      keyStroke("ArrowLeft+ArrowDown", { metaKey: true }),
    ), "bottom-left"),
    windowSnapCase(createWindowSnap, "window-snap.bottom-right", "Snap focused window bottom-right", keySequence(
      keyStroke("ArrowRight+ArrowDown", { metaKey: true }),
    ), "bottom-right"),
    windowSnapCase(createWindowSnap, "window-snap.center", "Center the focused window", keySequence(
      keyStroke("Enter", { metaKey: true }),
    ), "center"),
    windowSnapCase(createWindowSnap, "window-snap.maximize", "Maximize the focused window", keySequence(
      keyStroke("ArrowUp", { metaKey: true }),
    ), "maximize"),
    windowSnapCase(createWindowSnap, "window-snap.restore", "Restore the focused window", keySequence(
      keyStroke("ArrowLeft", { metaKey: true }),
      keyStroke("ArrowDown", { metaKey: true }),
    ), "restore"),
  ]);
}

function createSettingsAuditCases(
  createSettings: () => Promise<SettingsViewModel>,
): readonly A11yKeyboardAuditCase[] {
  return Object.freeze([
    settingsCase(createSettings, "settings.select-network", "Select the Network settings section", keySequence(
      keyStroke("ArrowDown"),
      keyStroke("ArrowDown"),
      keyStroke("Enter"),
    ), (state) => state.activeSection === "network"),
    settingsCase(createSettings, "settings.set-theme", "Set the appearance theme", keySequence(
      keyStroke("Tab"),
      keyStroke("ArrowRight"),
      keyStroke("Enter"),
    ), (state) => state.appearance.theme === "dark"),
    settingsCase(createSettings, "settings.set-accent", "Set the accent color", keySequence(
      keyStroke("Tab"),
      keyStroke("Tab"),
      keyStroke("ArrowRight"),
      keyStroke("Enter"),
    ), (state) => state.appearance.accent === "teal"),
    settingsCase(createSettings, "settings.set-layout", "Set the layout mode", keySequence(
      keyStroke("Tab"),
      keyStroke("Tab"),
      keyStroke("Tab"),
      keyStroke("ArrowRight"),
      keyStroke("ArrowRight"),
      keyStroke("ArrowRight"),
      keyStroke("Enter"),
    ), (state) => state.appearance.layout === "tiling"),
  ]);
}

function createNotificationsAuditCases(
  createNotifications: () => NotificationsViewModel,
): readonly A11yKeyboardAuditCase[] {
  return Object.freeze([
    notificationsCase(createNotifications, "notifications.mark-read", "Mark the focused notification read", keySequence(
      keyStroke("Enter"),
    ), (state) => state.unreadCount === 1 && notificationRead(state, "mail-new") === true),
    notificationsCase(createNotifications, "notifications.dismiss", "Dismiss the focused notification", keySequence(
      keyStroke("Delete"),
    ), (state) => state.totalCount === 1 && !hasNotification(state, "mail-new")),
    notificationsCase(createNotifications, "notifications.dismiss-all", "Dismiss all notifications", keySequence(
      keyStroke("Backspace", { ctrlKey: true }),
    ), (state) => state.totalCount === 0 && state.unreadCount === 0),
    notificationsCase(createNotifications, "notifications.toggle-wifi", "Toggle Wi-Fi control", keySequence(
      keyStroke("Tab"),
      keyStroke("Space"),
    ), (state) => controlEnabled(state, "wifi") === false),
    notificationsCase(createNotifications, "notifications.toggle-bluetooth", "Toggle Bluetooth control", keySequence(
      keyStroke("Tab"),
      keyStroke("ArrowRight"),
      keyStroke("Space"),
    ), (state) => controlEnabled(state, "bluetooth") === true),
    notificationsCase(createNotifications, "notifications.toggle-dnd", "Toggle Do Not Disturb control", keySequence(
      keyStroke("Tab"),
      keyStroke("ArrowRight"),
      keyStroke("ArrowRight"),
      keyStroke("Space"),
    ), (state) => controlEnabled(state, "dnd") === true),
  ]);
}

function dockLaunchCase(
  createDock: () => IndexDockViewModel,
  actionId: string,
  label: string,
  appId: IndexDockAppId,
  index: number,
): A11yKeyboardAuditCase {
  const sequence = dockLaunchSequence(index);

  return auditCase({
    actionId,
    keySequence: sequence,
    label,
    run: () => runDockLaunchAudit(createDock, sequence, appId),
    screen: "dock",
  });
}

function paletteCase(
  createPalette: () => IndexPaletteViewModel,
  actionId: string,
  label: string,
  query: string,
  commandId: string,
  dispatch: "launchApp" | "launcherIntent",
): A11yKeyboardAuditCase {
  const sequence = querySubmitSequence(query);

  return auditCase({
    actionId,
    keySequence: sequence,
    label,
    run: () => runPaletteAudit(createPalette, sequence, commandId, dispatch),
    screen: "palette",
  });
}

function searchCase(
  createSearch: () => SearchViewModel,
  actionId: string,
  label: string,
  query: string,
  dispatch: "launchApp" | "launcherIntent" | "openFile" | "openSetting",
): A11yKeyboardAuditCase {
  const sequence = querySubmitSequence(query);

  return auditCase({
    actionId,
    keySequence: sequence,
    label,
    run: () => runSearchAudit(createSearch, sequence, dispatch),
    screen: "search",
  });
}

function filesCase(
  createFiles: () => FilesViewModel,
  actionId: string,
  label: string,
  sequence: readonly A11yKeyboardEvent[],
  reached: (state: FilesViewState) => boolean,
): A11yKeyboardAuditCase {
  return auditCase({
    actionId,
    keySequence: sequence,
    label,
    run: () => runFilesAudit(createFiles, sequence, reached),
    screen: "files",
  });
}

function tilingCase(
  createTiling: () => TilingViewModel,
  actionId: string,
  label: string,
  sequence: readonly A11yKeyboardEvent[],
  reached: (state: TilingViewModelState) => boolean,
): A11yKeyboardAuditCase {
  return auditCase({
    actionId,
    keySequence: sequence,
    label,
    run: () => runTilingAudit(createTiling, sequence, reached),
    screen: "tiling",
  });
}

function windowSnapCase(
  createWindowSnap: () => WindowSnapViewModel,
  actionId: string,
  label: string,
  sequence: readonly A11yKeyboardEvent[],
  command: WindowSnapCommand,
): A11yKeyboardAuditCase {
  return auditCase({
    actionId,
    keySequence: sequence,
    label,
    run: () => runWindowSnapAudit(createWindowSnap, sequence, command),
    screen: "window-snap",
  });
}

function settingsCase(
  createSettings: () => Promise<SettingsViewModel>,
  actionId: string,
  label: string,
  sequence: readonly A11yKeyboardEvent[],
  reached: (state: SettingsViewModel["state"]) => boolean,
): A11yKeyboardAuditCase {
  return auditCase({
    actionId,
    keySequence: sequence,
    label,
    run: () => runSettingsAudit(createSettings, sequence, reached),
    screen: "settings",
  });
}

function notificationsCase(
  createNotifications: () => NotificationsViewModel,
  actionId: string,
  label: string,
  sequence: readonly A11yKeyboardEvent[],
  reached: (state: NotificationsViewState) => boolean,
): A11yKeyboardAuditCase {
  return auditCase({
    actionId,
    keySequence: sequence,
    label,
    run: () => runNotificationsAudit(createNotifications, sequence, reached),
    screen: "notifications",
  });
}

async function runDockLaunchAudit(
  createDock: () => IndexDockViewModel,
  sequence: readonly A11yKeyboardEvent[],
  appId: IndexDockAppId,
): Promise<A11yKeyboardAuditOutcome> {
  const viewModel = createDock();
  const before = dockProjection(viewModel.snapshot());
  const result = await driveDockKeyboard(viewModel, sequence);
  const state = viewModel.snapshot();
  const item = findDockItem(state, appId);
  const reached = result?.ok === true &&
    result.dispatch === "launchApp" &&
    result.appId === appId &&
    item?.running === true &&
    item.focused === true &&
    state.focusedAppId === appId;

  return outcome(reached, before, dockProjection(state), dockDetail(result));
}

async function runDockFocusAudit(
  createDock: () => IndexDockViewModel,
): Promise<A11yKeyboardAuditOutcome> {
  const viewModel = createDock();
  const before = dockProjection(viewModel.snapshot());
  const result = await driveDockKeyboard(viewModel, keySequence(
    keyStroke("Enter"),
    keyStroke("ArrowRight"),
    keyStroke("Enter"),
    keyStroke("ArrowLeft"),
    keyStroke("Enter"),
  ));
  const state = viewModel.snapshot();
  const item = findDockItem(state, INDEX_DOCK_APP_IDS.terminal);
  const reached = result?.ok === true &&
    result.dispatch === "focus" &&
    result.appId === INDEX_DOCK_APP_IDS.terminal &&
    item?.running === true &&
    item.focused === true &&
    state.focusedAppId === INDEX_DOCK_APP_IDS.terminal;

  return outcome(reached, before, dockProjection(state), dockDetail(result));
}

async function runPaletteAudit(
  createPalette: () => IndexPaletteViewModel,
  sequence: readonly A11yKeyboardEvent[],
  commandId: string,
  dispatch: "launchApp" | "launcherIntent",
): Promise<A11yKeyboardAuditOutcome> {
  const viewModel = createPalette();
  const before = paletteProjection(viewModel.snapshot());
  const result = await drivePaletteKeyboard(viewModel, sequence);
  const reached = result?.ok === true &&
    result.dispatch === dispatch &&
    result.command.id === commandId;

  return outcome(reached, before, paletteProjection(viewModel.snapshot()), paletteDetail(result));
}

async function runSearchAudit(
  createSearch: () => SearchViewModel,
  sequence: readonly A11yKeyboardEvent[],
  dispatch: "launchApp" | "launcherIntent" | "openFile" | "openSetting",
): Promise<A11yKeyboardAuditOutcome> {
  const viewModel = createSearch();
  const before = searchProjection(viewModel.snapshot());
  const result = await driveSearchKeyboard(viewModel, sequence);
  const reached = result?.ok === true && result.dispatch === dispatch;

  return outcome(reached, before, searchProjection(viewModel.snapshot()), searchDetail(result));
}

async function runFilesAudit(
  createFiles: () => FilesViewModel,
  sequence: readonly A11yKeyboardEvent[],
  reached: (state: FilesViewState) => boolean,
): Promise<A11yKeyboardAuditOutcome> {
  const viewModel = createFiles();
  const before = filesProjection(viewModel.state);
  const state = await driveFilesKeyboard(viewModel, sequence);

  return outcome(reached(state), before, filesProjection(state), `status:${state.status}:path:${state.path}`);
}

async function runTilingAudit(
  createTiling: () => TilingViewModel,
  sequence: readonly A11yKeyboardEvent[],
  reached: (state: TilingViewModelState) => boolean,
): Promise<A11yKeyboardAuditOutcome> {
  const viewModel = createTiling();
  const before = tilingProjection(viewModel.snapshot());
  const result = driveTilingKeyboard(viewModel, sequence);
  const state = viewModel.snapshot();
  const didReach = result?.ok === true && reached(state);

  return outcome(didReach, before, tilingProjection(state), tilingDetail(result));
}

async function runWindowSnapAudit(
  createWindowSnap: () => WindowSnapViewModel,
  sequence: readonly A11yKeyboardEvent[],
  command: WindowSnapCommand,
): Promise<A11yKeyboardAuditOutcome> {
  const viewModel = createWindowSnap();
  const before = windowSnapProjection(viewModel.snapshot());
  const result = driveWindowSnapKeyboard(viewModel, sequence);
  const state = viewModel.snapshot();
  const reached = result?.ok === true &&
    result.command === command &&
    state.lastCommand === command;

  return outcome(reached, before, windowSnapProjection(state), windowSnapDetail(result));
}

async function runPointerOnlyWindowSnapAudit(
  createWindowSnap: () => WindowSnapViewModel,
): Promise<A11yKeyboardAuditOutcome> {
  const viewModel = createWindowSnap();
  const before = windowSnapProjection(viewModel.snapshot());
  const result = driveWindowSnapKeyboard(viewModel, Object.freeze([]));
  const after = windowSnapProjection(viewModel.snapshot());

  return outcome(result?.ok === true, before, after, "no keyboard mapping for snapAtPoint");
}

async function runSettingsAudit(
  createSettings: () => Promise<SettingsViewModel>,
  sequence: readonly A11yKeyboardEvent[],
  reached: (state: SettingsViewModel["state"]) => boolean,
): Promise<A11yKeyboardAuditOutcome> {
  const viewModel = await createSettings();
  const before = settingsProjection(viewModel.state);
  const result = await driveSettingsKeyboard(viewModel, sequence);
  const state = viewModel.state;
  const didReach = result?.ok === true && reached(state);

  return outcome(didReach, before, settingsProjection(state), settingsDetail(result));
}

async function runNotificationsAudit(
  createNotifications: () => NotificationsViewModel,
  sequence: readonly A11yKeyboardEvent[],
  reached: (state: NotificationsViewState) => boolean,
): Promise<A11yKeyboardAuditOutcome> {
  const viewModel = createNotifications();
  const before = notificationsProjection(viewModel.state());
  const result = driveNotificationsKeyboard(viewModel, sequence);
  const state = result?.state ?? viewModel.state();
  const didReach = result?.ok === true && reached(state);

  return outcome(didReach, before, notificationsProjection(state), notificationsDetail(result));
}

async function driveDockKeyboard(
  viewModel: IndexDockViewModel,
  sequence: readonly A11yKeyboardEvent[],
): Promise<IndexDockActionResult | undefined> {
  let focusedIndex = 0;
  let lastResult: IndexDockActionResult | undefined;

  for (let index = 0; index < sequence.length; index += 1) {
    const event = sequence[index];

    if (event === undefined) continue;

    const state = viewModel.snapshot();
    const itemCount = state.items.length;

    if (itemCount === 0) continue;
    if ((isPlainKey(event, "Tab") && event.shiftKey !== true) || isPlainKey(event, "ArrowRight")) {
      focusedIndex = positiveModulo(focusedIndex + 1, itemCount);
      continue;
    }
    if ((isPlainKey(event, "Tab") && event.shiftKey === true) || isPlainKey(event, "ArrowLeft")) {
      focusedIndex = positiveModulo(focusedIndex - 1, itemCount);
      continue;
    }
    if (isPlainKey(event, "Home")) {
      focusedIndex = 0;
      continue;
    }
    if (isPlainKey(event, "End")) {
      focusedIndex = itemCount - 1;
      continue;
    }
    if (isPlainActivation(event)) {
      const item = state.items[focusedIndex];

      if (item !== undefined) {
        lastResult = await viewModel.launchOrFocus(item.appId);
      }
    }
  }

  return lastResult;
}

async function drivePaletteKeyboard(
  viewModel: IndexPaletteViewModel,
  sequence: readonly A11yKeyboardEvent[],
): Promise<IndexPaletteExecuteResult | undefined> {
  let query = viewModel.snapshot().query;
  let lastResult: IndexPaletteExecuteResult | undefined;

  for (let index = 0; index < sequence.length; index += 1) {
    const event = sequence[index];

    if (event === undefined) continue;

    const text = keyText(event);
    if (text !== null) {
      query += text;
      viewModel.setQuery(query);
      continue;
    }
    if (isPlainKey(event, "Backspace")) {
      query = query.slice(0, Math.max(0, query.length - 1));
      viewModel.setQuery(query);
      continue;
    }
    if (isPlainKey(event, "ArrowDown")) {
      viewModel.moveSelection(1);
      continue;
    }
    if (isPlainKey(event, "ArrowUp")) {
      viewModel.moveSelection(-1);
      continue;
    }
    if (isPlainKey(event, "Enter")) {
      lastResult = await viewModel.execute();
    }
  }

  return lastResult;
}

async function driveSearchKeyboard(
  viewModel: SearchViewModel,
  sequence: readonly A11yKeyboardEvent[],
): Promise<SearchExecuteResult | undefined> {
  let query = viewModel.snapshot().query;
  let lastResult: SearchExecuteResult | undefined;

  for (let index = 0; index < sequence.length; index += 1) {
    const event = sequence[index];

    if (event === undefined) continue;

    const text = keyText(event);
    if (text !== null) {
      query += text;
      await viewModel.setQuery(query);
      continue;
    }
    if (isPlainKey(event, "Backspace")) {
      query = query.slice(0, Math.max(0, query.length - 1));
      await viewModel.setQuery(query);
      continue;
    }
    if (isPlainKey(event, "ArrowDown")) {
      viewModel.moveSelection(1);
      continue;
    }
    if (isPlainKey(event, "ArrowUp")) {
      viewModel.moveSelection(-1);
      continue;
    }
    if (isPlainKey(event, "Enter")) {
      lastResult = await viewModel.execute();
    }
  }

  return lastResult;
}

async function driveFilesKeyboard(
  viewModel: FilesViewModel,
  sequence: readonly A11yKeyboardEvent[],
): Promise<FilesViewState> {
  let state = viewModel.state;
  let selectedIndex = selectedEntryIndex(state);

  for (let index = 0; index < sequence.length; index += 1) {
    const event = sequence[index];

    if (event === undefined) continue;

    if (isPlainKey(event, "F5")) {
      state = await viewModel.refresh();
      selectedIndex = selectedEntryIndex(state);
      continue;
    }
    if (event.altKey === true && event.key === "ArrowUp") {
      state = await viewModel.up();
      selectedIndex = selectedEntryIndex(state);
      continue;
    }

    const favoriteIndex = ctrlDigitIndex(event);
    if (favoriteIndex !== null) {
      const favorite = state.favorites[favoriteIndex];

      if (favorite !== undefined) {
        state = await viewModel.openFavorite(favorite.id);
        selectedIndex = selectedEntryIndex(state);
      }
      continue;
    }
    if (isPlainKey(event, "ArrowDown") || isPlainKey(event, "ArrowUp")) {
      const count = state.entries.length;

      if (count === 0) {
        selectedIndex = -1;
        continue;
      }

      const delta = event.key === "ArrowDown" ? 1 : -1;
      const current = selectedIndex >= 0 ? selectedIndex : delta < 0 ? count : -1;

      selectedIndex = positiveModulo(current + delta, count);
      state = selectFilesEntry(viewModel, state, selectedIndex);
      continue;
    }
    if (isPlainActivation(event)) {
      const selected = state.selected;

      if (selected?.kind === "dir") {
        state = await viewModel.navigate(selected.name);
        selectedIndex = selectedEntryIndex(state);
      }
    }
  }

  return state;
}

function driveTilingKeyboard(
  viewModel: TilingViewModel,
  sequence: readonly A11yKeyboardEvent[],
): TilingViewModelResult | undefined {
  let lastResult: TilingViewModelResult | undefined;

  for (let index = 0; index < sequence.length; index += 1) {
    const event = sequence[index];

    if (event === undefined) continue;

    const digitIndex = ctrlDigitIndex(event);
    if (event.altKey === true && digitIndex !== null) {
      lastResult = viewModel.moveWindow(Object.freeze({
        type: "moveToWorkspace",
        workspaceId: `workspace-${digitIndex + 1}`,
      }));
      continue;
    }
    if (digitIndex !== null) {
      const paneId = TILING_PANE_IDS[digitIndex];

      if (paneId !== undefined) {
        lastResult = viewModel.focusPane(paneId);
      }
      continue;
    }
    if (event.ctrlKey === true && event.shiftKey === true && event.key === "ArrowRight") {
      lastResult = viewModel.moveWindow(Object.freeze({
        rect: TILING_KEYBOARD_MOVE_RECT,
        type: "move",
      }));
      continue;
    }
    if (event.ctrlKey === true && event.key === "Space") {
      lastResult = viewModel.cycleLayout();
      continue;
    }
    if (event.altKey === true && event.key === "ArrowRight") {
      lastResult = viewModel.splitFocus("right");
      continue;
    }
    if (event.altKey === true && event.key === "ArrowLeft") {
      lastResult = viewModel.splitFocus("left");
    }
  }

  return lastResult;
}

function driveWindowSnapKeyboard(
  viewModel: WindowSnapViewModel,
  sequence: readonly A11yKeyboardEvent[],
): WindowSnapViewModelResult | undefined {
  let lastResult: WindowSnapViewModelResult | undefined;

  for (let index = 0; index < sequence.length; index += 1) {
    const event = sequence[index];

    if (event === undefined) continue;

    const chord = snapChordForKeyboardEvent(event);

    if (chord !== null) {
      lastResult = viewModel.handleKeyboardChord(chord);
    }
  }

  return lastResult;
}

async function driveSettingsKeyboard(
  viewModel: SettingsViewModel,
  sequence: readonly A11yKeyboardEvent[],
): Promise<SettingsViewModelActionResult | undefined> {
  let focusGroup: SettingsKeyboardFocusGroup = "sections";
  let sectionIndex = settingsSectionIndex(viewModel.state.activeSection);
  let themeIndex = stringIndex(SETTINGS_THEMES, viewModel.state.appearance.theme);
  let accentIndex = settingsAccentIndex(viewModel.state.appearance.accent);
  let layoutIndex = stringIndex(SETTINGS_LAYOUTS, viewModel.state.appearance.layout);
  let lastResult: SettingsViewModelActionResult | undefined;

  for (let index = 0; index < sequence.length; index += 1) {
    const event = sequence[index];

    if (event === undefined) continue;

    if (event.key === "Tab") {
      focusGroup = nextSettingsFocusGroup(focusGroup, event.shiftKey === true ? -1 : 1);
      continue;
    }
    if (focusGroup === "sections" && (event.key === "ArrowDown" || event.key === "ArrowUp")) {
      const delta = event.key === "ArrowDown" ? 1 : -1;
      sectionIndex = positiveModulo(sectionIndex + delta, SETTINGS_SECTIONS.length);
      continue;
    }
    if (focusGroup === "themes" && (event.key === "ArrowRight" || event.key === "ArrowLeft")) {
      const delta = event.key === "ArrowRight" ? 1 : -1;
      themeIndex = positiveModulo(themeIndex + delta, SETTINGS_THEMES.length);
      continue;
    }
    if (focusGroup === "accents" && (event.key === "ArrowRight" || event.key === "ArrowLeft")) {
      const delta = event.key === "ArrowRight" ? 1 : -1;
      accentIndex = positiveModulo(accentIndex + delta, SETTINGS_ACCENT_OPTIONS.length);
      continue;
    }
    if (focusGroup === "layouts" && (event.key === "ArrowRight" || event.key === "ArrowLeft")) {
      const delta = event.key === "ArrowRight" ? 1 : -1;
      layoutIndex = positiveModulo(layoutIndex + delta, SETTINGS_LAYOUTS.length);
      continue;
    }
    if (isPlainActivation(event)) {
      if (focusGroup === "sections") {
        const section = SETTINGS_SECTIONS[sectionIndex];

        if (section !== undefined) lastResult = await viewModel.select(section.id);
      } else if (focusGroup === "themes") {
        const theme = SETTINGS_THEMES[themeIndex];

        if (theme !== undefined) lastResult = await viewModel.setTheme(theme);
      } else if (focusGroup === "accents") {
        const accent = SETTINGS_ACCENT_OPTIONS[accentIndex];

        if (accent !== undefined) lastResult = await viewModel.setAccent(accent.id);
      } else {
        const layout = SETTINGS_LAYOUTS[layoutIndex];

        if (layout !== undefined) lastResult = await viewModel.setLayout(layout);
      }
    }
  }

  return lastResult;
}

function driveNotificationsKeyboard(
  viewModel: NotificationsViewModel,
  sequence: readonly A11yKeyboardEvent[],
): NotificationsActionResult | undefined {
  let focusGroup: NotificationsKeyboardFocusGroup = "notifications";
  let notificationIndex = 0;
  let controlIndex = 0;
  let lastResult: NotificationsActionResult | undefined;

  for (let index = 0; index < sequence.length; index += 1) {
    const event = sequence[index];

    if (event === undefined) continue;

    const state = lastResult?.state ?? viewModel.state();

    if (event.key === "Tab") {
      focusGroup = focusGroup === "notifications" ? "controls" : "notifications";
      continue;
    }
    if (event.ctrlKey === true && event.key === "Backspace") {
      lastResult = viewModel.dismissAll();
      notificationIndex = 0;
      continue;
    }
    if (focusGroup === "notifications") {
      if (isPlainKey(event, "ArrowDown") || isPlainKey(event, "ArrowUp")) {
        const count = state.notifications.length;

        if (count === 0) {
          notificationIndex = 0;
        } else {
          const delta = event.key === "ArrowDown" ? 1 : -1;
          notificationIndex = positiveModulo(notificationIndex + delta, count);
        }
        continue;
      }
      if (isPlainActivation(event)) {
        const notification = state.notifications[notificationIndex];

        if (notification !== undefined) lastResult = viewModel.markRead(notification.id);
        continue;
      }
      if (isPlainKey(event, "Delete") || isPlainKey(event, "Backspace")) {
        const notification = state.notifications[notificationIndex];

        if (notification !== undefined) {
          lastResult = viewModel.dismiss(notification.id);
          notificationIndex = 0;
        }
      }
    } else {
      if (isPlainKey(event, "ArrowRight") || isPlainKey(event, "ArrowLeft")) {
        const count = state.controls.length;

        if (count === 0) {
          controlIndex = 0;
        } else {
          const delta = event.key === "ArrowRight" ? 1 : -1;
          controlIndex = positiveModulo(controlIndex + delta, count);
        }
        continue;
      }
      if (isPlainActivation(event)) {
        const control = state.controls[controlIndex];

        if (control !== undefined) lastResult = viewModel.toggle(control.id);
      }
    }
  }

  return lastResult;
}

function auditCase(input: {
  readonly screen: A11yKeyboardAuditScreen;
  readonly actionId: string;
  readonly label: string;
  readonly keySequence: readonly A11yKeyboardEvent[];
  readonly run: () => Promise<A11yKeyboardAuditOutcome>;
}): A11yKeyboardAuditCase {
  return Object.freeze({
    actionId: input.actionId,
    keySequence: freezeKeySequence(input.keySequence),
    label: input.label,
    run: input.run,
    screen: input.screen,
  });
}

async function safelyRunAuditCase(testCase: A11yKeyboardAuditCase): Promise<A11yKeyboardAuditOutcome> {
  try {
    return await testCase.run();
  } catch (caught) {
    return outcome(false, "unavailable", "unavailable", `AUDIT_DRIVER_THROW:${errorMessage(caught)}`);
  }
}

function outcome(
  reached: boolean,
  before: string,
  after: string,
  detail: string,
): A11yKeyboardAuditOutcome {
  return Object.freeze({
    after,
    before,
    detail,
    reached,
  });
}

function keyStroke(
  key: string,
  modifiers: {
    readonly altKey?: true;
    readonly ctrlKey?: true;
    readonly metaKey?: true;
    readonly shiftKey?: true;
  } = Object.freeze({}),
): A11yKeyboardEvent {
  const output: {
    key: string;
    altKey?: true;
    ctrlKey?: true;
    metaKey?: true;
    shiftKey?: true;
  } = {
    key,
  };

  if (modifiers.altKey === true) output.altKey = true;
  if (modifiers.ctrlKey === true) output.ctrlKey = true;
  if (modifiers.metaKey === true) output.metaKey = true;
  if (modifiers.shiftKey === true) output.shiftKey = true;

  return Object.freeze(output);
}

function keySequence(...events: readonly A11yKeyboardEvent[]): readonly A11yKeyboardEvent[] {
  return freezeKeySequence(events);
}

function freezeKeySequence(sequence: readonly A11yKeyboardEvent[]): readonly A11yKeyboardEvent[] {
  const output: A11yKeyboardEvent[] = [];

  for (let index = 0; index < sequence.length; index += 1) {
    const event = sequence[index];

    if (event !== undefined) output.push(freezeKeyStroke(event));
  }

  return Object.freeze(output);
}

function freezeKeyStroke(event: A11yKeyboardEvent): A11yKeyboardEvent {
  const modifiers: {
    altKey?: true;
    ctrlKey?: true;
    metaKey?: true;
    shiftKey?: true;
  } = {};

  if (event.altKey === true) modifiers.altKey = true;
  if (event.ctrlKey === true) modifiers.ctrlKey = true;
  if (event.metaKey === true) modifiers.metaKey = true;
  if (event.shiftKey === true) modifiers.shiftKey = true;

  return keyStroke(event.key, modifiers);
}

function typeText(value: string): readonly A11yKeyboardEvent[] {
  const output: A11yKeyboardEvent[] = [];

  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];

    if (char === undefined) continue;
    output.push(keyStroke(char === " " ? "Space" : char));
  }

  return Object.freeze(output);
}

function querySubmitSequence(query: string): readonly A11yKeyboardEvent[] {
  return Object.freeze([
    ...typeText(query),
    keyStroke("Enter"),
  ]);
}

function dockLaunchSequence(index: number): readonly A11yKeyboardEvent[] {
  const output: A11yKeyboardEvent[] = [];

  for (let count = 0; count < index; count += 1) {
    output.push(keyStroke("ArrowRight"));
  }

  output.push(keyStroke("Enter"));
  return Object.freeze(output);
}

function keyText(event: A11yKeyboardEvent): string | null {
  if (hasModifier(event)) return null;
  if (event.key === "Space") return " ";
  if (event.key.length === 1) return event.key;

  return null;
}

function isPlainActivation(event: A11yKeyboardEvent): boolean {
  return isPlainKey(event, "Enter") || isPlainKey(event, "Space");
}

function isPlainKey(event: A11yKeyboardEvent, key: string): boolean {
  return event.key === key && !hasModifier(event);
}

function hasModifier(event: A11yKeyboardEvent): boolean {
  return event.altKey === true || event.ctrlKey === true || event.metaKey === true || event.shiftKey === true;
}

function ctrlDigitIndex(event: A11yKeyboardEvent): number | null {
  if (event.ctrlKey !== true) return null;
  if (event.key.length !== 1) return null;

  const digit = event.key.charCodeAt(0) - 48;

  if (digit < 1 || digit > 9) return null;
  return digit - 1;
}

function selectFilesEntry(
  viewModel: FilesViewModel,
  state: FilesViewState,
  index: number,
): FilesViewState {
  const entry = state.entries[index];

  if (entry === undefined) return state;
  return viewModel.select(entry);
}

function selectedEntryIndex(state: FilesViewState): number {
  const selected = state.selected;

  if (selected === undefined) return -1;

  for (let index = 0; index < state.entries.length; index += 1) {
    const entry = state.entries[index];

    if (entry !== undefined && entry.name === selected.name) return index;
  }

  return -1;
}

function snapChordForKeyboardEvent(event: A11yKeyboardEvent): string | null {
  if (event.key.length === 0) return null;
  if (!event.key.startsWith("Arrow") && event.key.includes("Pointer")) return null;

  const parts: string[] = [];

  if (event.metaKey === true) parts.push("super");
  if (event.ctrlKey === true) parts.push("ctrl");
  if (event.altKey === true) parts.push("alt");
  if (event.shiftKey === true) parts.push("shift");

  const keys = event.key.split("+");

  for (let index = 0; index < keys.length; index += 1) {
    const key = keys[index];

    if (key !== undefined && key.length > 0) parts.push(key);
  }

  if (parts.length === 0) return null;
  return parts.join("+");
}

function nextSettingsFocusGroup(
  current: SettingsKeyboardFocusGroup,
  delta: number,
): SettingsKeyboardFocusGroup {
  const currentIndex = stringIndex(SETTINGS_FOCUS_ORDER, current);
  const nextIndex = positiveModulo(currentIndex + delta, SETTINGS_FOCUS_ORDER.length);

  return SETTINGS_FOCUS_ORDER[nextIndex] ?? "sections";
}

function settingsSectionIndex(sectionId: string): number {
  for (let index = 0; index < SETTINGS_SECTIONS.length; index += 1) {
    if (SETTINGS_SECTIONS[index]?.id === sectionId) return index;
  }

  return 0;
}

function settingsAccentIndex(accentId: string): number {
  for (let index = 0; index < SETTINGS_ACCENT_OPTIONS.length; index += 1) {
    if (SETTINGS_ACCENT_OPTIONS[index]?.id === accentId) return index;
  }

  return 0;
}

function stringIndex(values: readonly string[], value: string): number {
  for (let index = 0; index < values.length; index += 1) {
    if (values[index] === value) return index;
  }

  return 0;
}

function findDockItem(state: IndexDockState, appId: IndexDockAppId): IndexDockItem | undefined {
  for (let index = 0; index < state.items.length; index += 1) {
    const item = state.items[index];

    if (item !== undefined && item.appId === appId) return item;
  }

  return undefined;
}

function paneWorkspace(state: TilingViewModelState, paneId: TilingPaneId): string | null {
  for (let index = 0; index < state.panes.length; index += 1) {
    const pane = state.panes[index];

    if (pane !== undefined && pane.id === paneId) return pane.workspaceId;
  }

  return null;
}

function paneHasRect(state: TilingViewModelState, paneId: TilingPaneId, rect: Rect): boolean {
  for (let index = 0; index < state.panes.length; index += 1) {
    const pane = state.panes[index];

    if (pane !== undefined && pane.id === paneId) {
      return rectEquals(pane.rect, rect);
    }
  }

  return false;
}

function notificationRead(state: NotificationsViewState, id: string): boolean | null {
  for (let index = 0; index < state.notifications.length; index += 1) {
    const notification = state.notifications[index];

    if (notification !== undefined && notification.id === id) return notification.read;
  }

  return null;
}

function hasNotification(state: NotificationsViewState, id: string): boolean {
  return notificationRead(state, id) !== null;
}

function controlEnabled(state: NotificationsViewState, id: string): boolean | null {
  for (let index = 0; index < state.controls.length; index += 1) {
    const control = state.controls[index];

    if (control !== undefined && control.id === id) return control.enabled;
  }

  return null;
}

function dockProjection(state: IndexDockState): string {
  return JSON.stringify({
    focusedAppId: state.focusedAppId,
    items: state.items.map((item) => ({
      appId: item.appId,
      focused: item.focused,
      running: item.running,
    })),
  });
}

function paletteProjection(state: ReturnType<IndexPaletteViewModel["snapshot"]>): string {
  return JSON.stringify({
    highlightedIndex: state.highlightedIndex,
    query: state.query,
    results: state.results.map((command) => command.id),
  });
}

function searchProjection(state: ReturnType<SearchViewModel["snapshot"]>): string {
  return JSON.stringify({
    query: state.query,
    results: state.results.map((result) => ({
      id: result.id,
      source: result.source,
    })),
    selectedIndex: state.selectedIndex,
  });
}

function filesProjection(state: FilesViewState): string {
  return JSON.stringify({
    entries: state.entries.map((entry) => ({
      kind: entry.kind,
      name: entry.name,
    })),
    path: state.path,
    selected: state.selected?.name ?? null,
    status: state.status,
  });
}

function tilingProjection(state: TilingViewModelState): string {
  return JSON.stringify({
    activePaneId: state.activePaneId,
    activeWorkspaceId: state.activeWorkspaceId,
    layout: state.layout,
    panes: state.panes.map((pane) => ({
      id: pane.id,
      mode: pane.mode,
      rect: rectProjection(pane.rect),
      visible: pane.visible,
      workspaceId: pane.workspaceId,
    })),
  });
}

function windowSnapProjection(state: WindowSnapViewModelState): string {
  return JSON.stringify({
    activeWindowId: state.activeWindowId,
    focusedRect: state.focusedPlacement === null ? null : rectProjection(state.focusedPlacement.rect),
    lastCommand: state.lastCommand,
    ready: state.ready,
    restoreAvailable: state.restoreAvailable,
  });
}

function settingsProjection(state: SettingsViewModel["state"]): string {
  return JSON.stringify({
    accent: state.appearance.accent,
    activeSection: state.activeSection,
    layout: state.appearance.layout,
    theme: state.appearance.theme,
  });
}

function notificationsProjection(state: NotificationsViewState): string {
  return JSON.stringify({
    controls: state.controls.map((control) => ({
      available: control.available,
      enabled: control.enabled,
      id: control.id,
    })),
    notifications: state.notifications.map((notification) => ({
      id: notification.id,
      read: notification.read,
    })),
    totalCount: state.totalCount,
    unreadCount: state.unreadCount,
  });
}

function rectProjection(rect: Rect): {
  readonly height: number;
  readonly width: number;
  readonly x: number;
  readonly y: number;
} {
  return {
    height: rect.height,
    width: rect.width,
    x: rect.x,
    y: rect.y,
  };
}

function dockDetail(result: IndexDockActionResult | undefined): string {
  if (result === undefined) return "no-dispatch";
  if (!result.ok) return `error:${result.error.code}`;

  return `${result.dispatch}:${result.appId}`;
}

function paletteDetail(result: IndexPaletteExecuteResult | undefined): string {
  if (result === undefined) return "no-dispatch";
  if (!result.ok) return `error:${result.error.code}`;

  return `${result.dispatch}:${result.command.id}`;
}

function searchDetail(result: SearchExecuteResult | undefined): string {
  if (result === undefined) return "no-dispatch";
  if (!result.ok) return `error:${result.error.code}`;

  return `${result.dispatch}:${result.result.id}`;
}

function tilingDetail(result: TilingViewModelResult | undefined): string {
  if (result === undefined) return "no-dispatch";
  if (!result.ok) return `error:${result.error.code}`;

  return `intents:${result.intents.map((intent) => intent.type).join(",")}`;
}

function windowSnapDetail(result: WindowSnapViewModelResult | undefined): string {
  if (result === undefined) return "no-dispatch";
  if (!result.ok) return `error:${result.error.code}`;

  return `command:${result.command}`;
}

function settingsDetail(result: SettingsViewModelActionResult | undefined): string {
  if (result === undefined) return "no-dispatch";
  if (!result.ok) return `error:${result.error.code}`;

  return "settings:applied";
}

function notificationsDetail(result: NotificationsActionResult | undefined): string {
  if (result === undefined) return "no-dispatch";
  if (!result.ok) return `error:${result.error.code}`;

  return result.intent === undefined ? "notifications:updated" : `tray:${result.intent.type}`;
}

function rectEquals(left: Rect, right: Rect): boolean {
  return left.height === right.height &&
    left.width === right.width &&
    left.x === right.x &&
    left.y === right.y;
}

function positiveModulo(value: number, modulus: number): number {
  return ((value % modulus) + modulus) % modulus;
}

function errorMessage(caught: unknown): string {
  if (caught instanceof Error && caught.message.length > 0) return caught.message;

  return "unknown";
}
