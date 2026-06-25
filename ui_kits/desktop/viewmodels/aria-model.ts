import {
  SETTINGS_ACCENT_OPTIONS,
  SETTINGS_LAYOUTS,
  SETTINGS_THEMES,
} from "./Settings.ts";
import type {
  ActivitySortColumn,
  ActivityViewState,
} from "./Activity.ts";
import type {
  IndexDockState,
} from "./dock.ts";
import type {
  FilesOpsState,
} from "./files-ops.ts";
import type {
  FilesViewState,
} from "./files.ts";
import type {
  IndexPaletteState,
} from "./index.ts";
import type {
  LockViewModelState,
} from "./Lock.ts";
import type {
  NotificationsViewGroup,
  NotificationsViewState,
} from "./Notifications.ts";
import type {
  SettingsViewModelState,
} from "./Settings.ts";
import type {
  ShellViewModelState,
} from "./Shell.ts";
import type {
  TilingViewModelState,
} from "./Tiling.ts";

export type DesktopAriaScreenId =
  | "desktop"
  | "desktop/activity"
  | "desktop/files"
  | "desktop/lock"
  | "desktop/notifications"
  | "desktop/settings"
  | "desktop/shell"
  | "desktop/tiling";

export type AriaRole =
  | "application"
  | "button"
  | "complementary"
  | "dialog"
  | "group"
  | "list"
  | "listbox"
  | "log"
  | "main"
  | "menu"
  | "menuitem"
  | "menuitemcheckbox"
  | "option"
  | "searchbox"
  | "status"
  | "tab"
  | "tablist"
  | "tabpanel"
  | "textbox";

export type AriaCheckedToken = "false" | "mixed" | "true";
export type AriaCurrentToken = "date" | "false" | "location" | "page" | "step" | "time" | "true";

export type AriaDescriptorBindField =
  | "activedescendant"
  | "checked"
  | "controls"
  | "current"
  | "disabled"
  | "expanded"
  | "hidden"
  | "label"
  | "labelledby"
  | "pressed"
  | "role"
  | "selected";

export type AriaDescriptorValue = boolean | string;

export interface AriaDescriptor {
  readonly id: string;
  readonly role: AriaRole;
  readonly ariaLabel?: string;
  readonly ariaLabelledBy?: string;
  readonly ariaActivedescendant?: string;
  readonly ariaControls?: string;
  readonly ariaChecked?: AriaCheckedToken;
  readonly ariaCurrent?: AriaCurrentToken;
  readonly ariaDisabled?: boolean;
  readonly ariaExpanded?: boolean;
  readonly ariaHidden?: boolean;
  readonly ariaPressed?: boolean;
  readonly ariaSelected?: boolean;
  readonly ownedIds?: readonly string[];
  readonly parentId?: string;
}

export interface AriaDescriptorSet {
  readonly screenId: DesktopAriaScreenId;
  readonly descriptors: readonly AriaDescriptor[];
  readonly values: Readonly<Record<string, AriaDescriptorValue>>;
}

export interface IndexAriaState {
  readonly palette: IndexPaletteState;
  readonly dock: IndexDockState;
  readonly error?: {
    readonly message: string;
  } | null;
}

export interface FilesAriaState {
  readonly view: FilesViewState;
  readonly ops: FilesOpsState;
}

export type DesktopAriaModelInput =
  | {
      readonly screenId: "desktop";
      readonly state: IndexAriaState;
    }
  | {
      readonly screenId: "desktop/activity";
      readonly state: ActivityViewState;
    }
  | {
      readonly screenId: "desktop/files";
      readonly state: FilesAriaState;
    }
  | {
      readonly screenId: "desktop/lock";
      readonly state: LockViewModelState;
    }
  | {
      readonly screenId: "desktop/notifications";
      readonly state: NotificationsViewState;
    }
  | {
      readonly screenId: "desktop/settings";
      readonly state: SettingsViewModelState;
    }
  | {
      readonly screenId: "desktop/shell";
      readonly state: ShellViewModelState;
    }
  | {
      readonly screenId: "desktop/tiling";
      readonly state: TilingViewModelState;
    };

export function createDesktopAriaDescriptorSet(input: DesktopAriaModelInput): AriaDescriptorSet {
  switch (input.screenId) {
    case "desktop":
      return createIndexAriaDescriptorSet(input.state);
    case "desktop/activity":
      return createActivityAriaDescriptorSet(input.state);
    case "desktop/files":
      return createFilesAriaDescriptorSet(input.state);
    case "desktop/lock":
      return createLockAriaDescriptorSet(input.state);
    case "desktop/notifications":
      return createNotificationsAriaDescriptorSet(input.state);
    case "desktop/settings":
      return createSettingsAriaDescriptorSet(input.state);
    case "desktop/shell":
      return createShellAriaDescriptorSet(input.state);
    case "desktop/tiling":
      return createTilingAriaDescriptorSet(input.state);
  }
}

export function createIndexAriaDescriptorSet(state: IndexAriaState): AriaDescriptorSet {
  const descriptors: AriaDescriptor[] = [];
  const paletteResultIds = state.palette.results.map((command) => ariaElementId("desktop-palette-result", command.id));
  const activePaletteId = itemAt(paletteResultIds, state.palette.highlightedIndex);
  const dockItemIds = state.dock.items.map((item) => ariaElementId("desktop-dock-item", item.appId));
  const activeDockId = state.dock.focusedAppId === null
    ? undefined
    : ariaElementId("desktop-dock-item", state.dock.focusedAppId);

  descriptors.push(descriptor({
    ariaLabel: "Vita desktop",
    id: "desktop-root",
    ownedIds: Object.freeze(["desktop-palette-group", "desktop-dock-menu"]),
    role: "application",
  }));
  descriptors.push(descriptor({
    ariaLabel: "Command palette",
    id: "desktop-palette-group",
    ownedIds: Object.freeze(["desktop-palette-query", "desktop-palette-results"]),
    parentId: "desktop-root",
    role: "group",
  }));
  descriptors.push(descriptor({
    ariaControls: "desktop-palette-results",
    ariaLabel: "Search apps and commands",
    id: "desktop-palette-query",
    parentId: "desktop-palette-group",
    role: "searchbox",
  }));

  const paletteList: {
    id: string;
    role: "listbox";
    ariaLabel: string;
    ownedIds: readonly string[];
    parentId: string;
    ariaActivedescendant?: string;
  } = {
    ariaLabel: "Command results",
    id: "desktop-palette-results",
    ownedIds: Object.freeze([...paletteResultIds]),
    parentId: "desktop-palette-group",
    role: "listbox",
  };

  if (activePaletteId !== undefined) paletteList.ariaActivedescendant = activePaletteId;
  descriptors.push(descriptor(paletteList));

  for (let index = 0; index < state.palette.results.length; index += 1) {
    const command = state.palette.results[index];
    const id = paletteResultIds[index];

    if (command !== undefined && id !== undefined) {
      descriptors.push(descriptor({
        ariaLabel: `${command.title}, ${command.subtitle}`,
        ariaSelected: index === state.palette.highlightedIndex,
        id,
        parentId: "desktop-palette-results",
        role: "option",
      }));
    }
  }

  const dockMenu: {
    id: string;
    role: "menu";
    ariaLabel: string;
    ownedIds: readonly string[];
    parentId: string;
    ariaActivedescendant?: string;
  } = {
    ariaLabel: "Dock",
    id: "desktop-dock-menu",
    ownedIds: Object.freeze([...dockItemIds]),
    parentId: "desktop-root",
    role: "menu",
  };

  if (activeDockId !== undefined) dockMenu.ariaActivedescendant = activeDockId;
  descriptors.push(descriptor(dockMenu));

  for (let index = 0; index < state.dock.items.length; index += 1) {
    const item = state.dock.items[index];
    const id = dockItemIds[index];

    if (item !== undefined && id !== undefined) {
      descriptors.push(descriptor({
        ariaCurrent: item.focused ? "page" : "false",
        ariaLabel: item.title,
        ariaPressed: item.running || item.focused,
        id,
        parentId: "desktop-dock-menu",
        role: "menuitem",
      }));
    }
  }

  if (state.error !== undefined && state.error !== null) {
    descriptors.push(descriptor({
      ariaLabel: state.error.message,
      id: "desktop-error",
      parentId: "desktop-root",
      role: "status",
    }));
  }

  return descriptorSet("desktop", descriptors);
}

export function createSettingsAriaDescriptorSet(state: SettingsViewModelState): AriaDescriptorSet {
  const descriptors: AriaDescriptor[] = [];
  const sectionIds = state.sections.map((section) => ariaElementId("settings-section", section.id));
  const activeSectionId = ariaElementId("settings-section", state.activeSection);
  const themeIds = SETTINGS_THEMES.map((theme) => ariaElementId("settings-theme", theme));
  const accentIds = SETTINGS_ACCENT_OPTIONS.map((accent) => ariaElementId("settings-accent", accent.id));
  const layoutIds = SETTINGS_LAYOUTS.map((layout) => ariaElementId("settings-layout", layout));

  descriptors.push(descriptor({
    ariaLabel: "Settings",
    id: "settings-root",
    ownedIds: Object.freeze(["settings-sections", "settings-appearance-group"]),
    role: "main",
  }));
  descriptors.push(descriptor({
    ariaActivedescendant: activeSectionId,
    ariaLabel: "Settings sections",
    id: "settings-sections",
    ownedIds: Object.freeze([...sectionIds]),
    parentId: "settings-root",
    role: "listbox",
  }));

  for (let index = 0; index < state.sections.length; index += 1) {
    const section = state.sections[index];
    const id = sectionIds[index];

    if (section !== undefined && id !== undefined) {
      descriptors.push(descriptor({
        ariaLabel: section.label,
        ariaSelected: section.active,
        id,
        parentId: "settings-sections",
        role: "option",
      }));
    }
  }

  descriptors.push(descriptor({
    ariaLabel: "Appearance",
    id: "settings-appearance-group",
    ownedIds: Object.freeze(["settings-theme-group", "settings-accent-group", "settings-layout-group"]),
    parentId: "settings-root",
    role: "group",
  }));
  descriptors.push(descriptor({
    ariaLabel: "Theme",
    id: "settings-theme-group",
    ownedIds: Object.freeze([...themeIds]),
    parentId: "settings-appearance-group",
    role: "group",
  }));

  for (let index = 0; index < SETTINGS_THEMES.length; index += 1) {
    const theme = SETTINGS_THEMES[index];
    const id = themeIds[index];

    if (theme !== undefined && id !== undefined) {
      descriptors.push(descriptor({
        ariaLabel: titleCase(theme),
        ariaPressed: state.appearance.theme === theme,
        id,
        parentId: "settings-theme-group",
        role: "button",
      }));
    }
  }

  descriptors.push(descriptor({
    ariaLabel: "Accent color",
    id: "settings-accent-group",
    ownedIds: Object.freeze([...accentIds]),
    parentId: "settings-appearance-group",
    role: "group",
  }));

  for (let index = 0; index < SETTINGS_ACCENT_OPTIONS.length; index += 1) {
    const accent = SETTINGS_ACCENT_OPTIONS[index];
    const id = accentIds[index];

    if (accent !== undefined && id !== undefined) {
      descriptors.push(descriptor({
        ariaLabel: accent.label,
        ariaPressed: state.appearance.accent === accent.id,
        id,
        parentId: "settings-accent-group",
        role: "button",
      }));
    }
  }

  descriptors.push(descriptor({
    ariaLabel: "Window layout",
    id: "settings-layout-group",
    ownedIds: Object.freeze([...layoutIds]),
    parentId: "settings-appearance-group",
    role: "group",
  }));

  for (let index = 0; index < SETTINGS_LAYOUTS.length; index += 1) {
    const layout = SETTINGS_LAYOUTS[index];
    const id = layoutIds[index];

    if (layout !== undefined && id !== undefined) {
      descriptors.push(descriptor({
        ariaLabel: titleCase(layout),
        ariaPressed: state.appearance.layout === layout,
        id,
        parentId: "settings-layout-group",
        role: "button",
      }));
    }
  }

  return descriptorSet("desktop/settings", descriptors);
}

export function createFilesAriaDescriptorSet(state: FilesAriaState): AriaDescriptorSet {
  const descriptors: AriaDescriptor[] = [];
  const breadcrumbIds = state.view.breadcrumbs.map((segment) => ariaElementId("files-breadcrumb", segment.path));
  const activeBreadcrumbId = lastItem(breadcrumbIds);
  const favoriteIds = state.view.favorites.map((favorite) => ariaElementId("files-favorite", favorite.id));
  const selectedFavorite = findSelectedFavoriteId(state.view);
  const entryIds = state.view.entries.map((entry) => ariaElementId("files-entry", entry.name));
  const selectedEntryId = state.view.selected === undefined
    ? undefined
    : ariaElementId("files-entry", state.view.selected.name);

  descriptors.push(descriptor({
    ariaLabel: "Files",
    id: "files-root",
    ownedIds: Object.freeze(["files-breadcrumbs", "files-favorites", "files-entries", "files-actions"]),
    role: "main",
  }));
  descriptors.push(descriptor({
    ariaLabel: `Current folder ${state.view.path}`,
    id: "files-location",
    parentId: "files-root",
    role: "group",
  }));
  const breadcrumbsList: {
    id: string;
    role: "listbox";
    ariaLabel: string;
    ownedIds: readonly string[];
    parentId: string;
    ariaActivedescendant?: string;
  } = {
    ariaLabel: "Breadcrumbs",
    id: "files-breadcrumbs",
    ownedIds: Object.freeze([...breadcrumbIds]),
    parentId: "files-root",
    role: "listbox",
  };

  if (activeBreadcrumbId !== undefined) breadcrumbsList.ariaActivedescendant = activeBreadcrumbId;
  descriptors.push(descriptor(breadcrumbsList));

  for (let index = 0; index < state.view.breadcrumbs.length; index += 1) {
    const segment = state.view.breadcrumbs[index];
    const id = breadcrumbIds[index];

    if (segment !== undefined && id !== undefined) {
      descriptors.push(descriptor({
        ariaLabel: segment.label,
        ariaSelected: index === state.view.breadcrumbs.length - 1,
        id,
        parentId: "files-breadcrumbs",
        role: "option",
      }));
    }
  }

  const favoritesList: {
    id: string;
    role: "listbox";
    ariaLabel: string;
    ownedIds: readonly string[];
    parentId: string;
    ariaActivedescendant?: string;
  } = {
    ariaLabel: "Favorites",
    id: "files-favorites",
    ownedIds: Object.freeze([...favoriteIds]),
    parentId: "files-root",
    role: "listbox",
  };

  if (selectedFavorite !== undefined) favoritesList.ariaActivedescendant = selectedFavorite;
  descriptors.push(descriptor(favoritesList));

  for (let index = 0; index < state.view.favorites.length; index += 1) {
    const favorite = state.view.favorites[index];
    const id = favoriteIds[index];

    if (favorite !== undefined && id !== undefined) {
      descriptors.push(descriptor({
        ariaLabel: favorite.label,
        ariaSelected: favorite.selected,
        id,
        parentId: "files-favorites",
        role: "option",
      }));
    }
  }

  const entriesList: {
    id: string;
    role: "listbox";
    ariaLabel: string;
    ownedIds: readonly string[];
    parentId: string;
    ariaActivedescendant?: string;
  } = {
    ariaLabel: `Files in ${state.view.path}`,
    id: "files-entries",
    ownedIds: Object.freeze([...entryIds]),
    parentId: "files-root",
    role: "listbox",
  };

  if (selectedEntryId !== undefined) entriesList.ariaActivedescendant = selectedEntryId;
  descriptors.push(descriptor(entriesList));

  for (let index = 0; index < state.view.entries.length; index += 1) {
    const entry = state.view.entries[index];
    const id = entryIds[index];

    if (entry !== undefined && id !== undefined) {
      descriptors.push(descriptor({
        ariaLabel: `${entry.name}, ${entry.kind}`,
        ariaSelected: state.view.selected?.name === entry.name,
        id,
        parentId: "files-entries",
        role: "option",
      }));
    }
  }

  descriptors.push(descriptor({
    ariaLabel: clipboardLabel(state.ops),
    id: "files-actions",
    parentId: "files-root",
    role: "group",
  }));

  return descriptorSet("desktop/files", descriptors);
}

export function createShellAriaDescriptorSet(state: ShellViewModelState): AriaDescriptorSet {
  const descriptors: AriaDescriptor[] = [];
  const tabIds = state.tabs.map((tab) => ariaElementId("shell-tab", tab.id));
  const activeTabId = ariaElementId("shell-tab", state.activeTabId);

  descriptors.push(descriptor({
    ariaLabel: "Shell",
    id: "shell-root",
    ownedIds: Object.freeze(["shell-tabs", "shell-active-panel"]),
    role: "application",
  }));
  descriptors.push(descriptor({
    ariaActivedescendant: activeTabId,
    ariaLabel: "Shell tabs",
    id: "shell-tabs",
    ownedIds: Object.freeze([...tabIds]),
    parentId: "shell-root",
    role: "tablist",
  }));

  for (let index = 0; index < state.tabs.length; index += 1) {
    const tab = state.tabs[index];
    const id = tabIds[index];

    if (tab !== undefined && id !== undefined) {
      descriptors.push(descriptor({
        ariaControls: "shell-active-panel",
        ariaLabel: tab.title,
        ariaSelected: tab.id === state.activeTabId,
        id,
        parentId: "shell-tabs",
        role: "tab",
      }));
    }
  }

  descriptors.push(descriptor({
    ariaLabel: state.activeTab.title,
    id: "shell-active-panel",
    ownedIds: Object.freeze(["shell-output", "shell-command-input"]),
    parentId: "shell-root",
    role: "tabpanel",
  }));
  descriptors.push(descriptor({
    ariaLabel: `${state.activeTab.title} output`,
    id: "shell-output",
    parentId: "shell-active-panel",
    role: "log",
  }));
  descriptors.push(descriptor({
    ariaDisabled: state.activeTab.running,
    ariaLabel: `Command in ${state.activeTab.cwd}`,
    id: "shell-command-input",
    parentId: "shell-active-panel",
    role: "textbox",
  }));

  return descriptorSet("desktop/shell", descriptors);
}

export function createActivityAriaDescriptorSet(state: ActivityViewState): AriaDescriptorSet {
  const descriptors: AriaDescriptor[] = [];
  const processIds = state.processes.map((process) => ariaElementId("activity-process", process.pid));
  const selectedProcessId = state.selectedPid === null
    ? undefined
    : ariaElementId("activity-process", state.selectedPid);
  const sortIds = (Object.freeze(["cpu", "memory", "name", "pid"] as const)).map((column) => ariaElementId("activity-sort", column));
  const activeSortId = ariaElementId("activity-sort", state.sort.column);

  descriptors.push(descriptor({
    ariaLabel: "Activity Monitor",
    id: "activity-root",
    ownedIds: Object.freeze(["activity-metrics", "activity-sort-menu", "activity-processes"]),
    role: "main",
  }));
  descriptors.push(descriptor({
    ariaLabel: `${Math.round(state.cpuPercent)} percent CPU, ${Math.round(state.memory.percent)} percent memory`,
    id: "activity-metrics",
    parentId: "activity-root",
    role: "group",
  }));
  descriptors.push(descriptor({
    ariaActivedescendant: activeSortId,
    ariaLabel: "Sort processes",
    id: "activity-sort-menu",
    ownedIds: Object.freeze([...sortIds]),
    parentId: "activity-root",
    role: "menu",
  }));

  const sortColumns = Object.freeze(["cpu", "memory", "name", "pid"] as const);

  for (let index = 0; index < sortColumns.length; index += 1) {
    const column = sortColumns[index];
    const id = sortIds[index];

    if (column !== undefined && id !== undefined) {
      descriptors.push(descriptor({
        ariaChecked: state.sort.column === column ? "true" : "false",
        ariaLabel: sortLabel(column),
        id,
        parentId: "activity-sort-menu",
        role: "menuitemcheckbox",
      }));
    }
  }

  const processList: {
    id: string;
    role: "listbox";
    ariaLabel: string;
    ownedIds: readonly string[];
    parentId: string;
    ariaActivedescendant?: string;
  } = {
    ariaLabel: "Processes",
    id: "activity-processes",
    ownedIds: Object.freeze([...processIds]),
    parentId: "activity-root",
    role: "listbox",
  };

  if (selectedProcessId !== undefined) processList.ariaActivedescendant = selectedProcessId;
  descriptors.push(descriptor(processList));

  for (let index = 0; index < state.processes.length; index += 1) {
    const process = state.processes[index];
    const id = processIds[index];

    if (process !== undefined && id !== undefined) {
      descriptors.push(descriptor({
        ariaLabel: `${process.name}, ${Math.round(process.cpuPercent)} percent CPU`,
        ariaSelected: process.selected,
        id,
        parentId: "activity-processes",
        role: "option",
      }));
    }
  }

  return descriptorSet("desktop/activity", descriptors);
}

export function createNotificationsAriaDescriptorSet(state: NotificationsViewState): AriaDescriptorSet {
  const descriptors: AriaDescriptor[] = [];
  const controlIds = state.controls.map((control) => ariaElementId("notifications-control", control.id));
  const notificationIds = state.notifications.map((notification) => ariaElementId("notifications-item", `${notification.appId}:${notification.id}`));
  const groupIds = state.groups.map((group) => ariaElementId("notifications-group", group.appId));

  descriptors.push(descriptor({
    ariaLabel: "Notifications",
    id: "notifications-root",
    ownedIds: Object.freeze(["notifications-controls", "notifications-list"]),
    role: "complementary",
  }));
  descriptors.push(descriptor({
    ariaLabel: "Quick settings",
    id: "notifications-controls",
    ownedIds: Object.freeze([...controlIds]),
    parentId: "notifications-root",
    role: "menu",
  }));

  for (let index = 0; index < state.controls.length; index += 1) {
    const control = state.controls[index];
    const id = controlIds[index];

    if (control !== undefined && id !== undefined) {
      descriptors.push(descriptor({
        ariaChecked: control.enabled ? "true" : "false",
        ariaDisabled: !control.available,
        ariaLabel: control.label,
        id,
        parentId: "notifications-controls",
        role: "menuitemcheckbox",
      }));
    }
  }

  descriptors.push(descriptor({
    ariaLabel: `${state.totalCount} notifications, ${state.unreadCount} unread`,
    id: "notifications-list",
    ownedIds: Object.freeze([...notificationIds, ...groupIds]),
    parentId: "notifications-root",
    role: "list",
  }));

  appendNotificationGroups(descriptors, state.groups, groupIds);

  for (let index = 0; index < state.notifications.length; index += 1) {
    const notification = state.notifications[index];
    const id = notificationIds[index];

    if (notification !== undefined && id !== undefined) {
      descriptors.push(descriptor({
        ariaLabel: notification.body === undefined
          ? `${notification.appId}, ${notification.title}`
          : `${notification.appId}, ${notification.title}, ${notification.body}`,
        ariaCurrent: notification.read ? "false" : "true",
        id,
        parentId: "notifications-list",
        role: "group",
      }));
    }
  }

  return descriptorSet("desktop/notifications", descriptors);
}

export function createLockAriaDescriptorSet(state: LockViewModelState): AriaDescriptorSet {
  const descriptors: AriaDescriptor[] = [];

  descriptors.push(descriptor({
    ariaLabel: `Lock screen for ${state.user.displayName}`,
    id: "lock-root",
    ownedIds: Object.freeze(["lock-clock", "lock-auth"]),
    role: "dialog",
  }));
  descriptors.push(descriptor({
    ariaLabel: `${state.clock.time}, ${state.clock.date}`,
    id: "lock-clock",
    parentId: "lock-root",
    role: "status",
  }));
  descriptors.push(descriptor({
    ariaLabel: `Authentication ${state.lockState}`,
    id: "lock-auth",
    ownedIds: Object.freeze(["lock-submit"]),
    parentId: "lock-root",
    role: "group",
  }));
  descriptors.push(descriptor({
    ariaDisabled: !state.canSubmit,
    ariaLabel: "Unlock",
    ariaPressed: state.lockState === "authenticating",
    id: "lock-submit",
    parentId: "lock-auth",
    role: "button",
  }));

  if (state.error !== undefined) {
    descriptors.push(descriptor({
      ariaLabel: state.error.message,
      id: "lock-error",
      parentId: "lock-auth",
      role: "status",
    }));
  }

  return descriptorSet("desktop/lock", descriptors);
}

export function createTilingAriaDescriptorSet(state: TilingViewModelState): AriaDescriptorSet {
  const descriptors: AriaDescriptor[] = [];
  const paneIds = state.panes.map((pane) => ariaElementId("tiling-pane", pane.id));
  const activePaneId = state.activePaneId === null
    ? undefined
    : ariaElementId("tiling-pane", state.activePaneId);
  const workspaceIds = state.statusBar.workspaces.map((workspace) => ariaElementId("tiling-workspace", workspace.id));
  const activeWorkspaceId = ariaElementId("tiling-workspace", state.activeWorkspaceId);

  descriptors.push(descriptor({
    ariaLabel: "Tiling workspaces",
    id: "tiling-root",
    ownedIds: Object.freeze(["tiling-panes", "tiling-workspaces", "tiling-status"]),
    role: "application",
  }));

  const panesList: {
    id: string;
    role: "listbox";
    ariaLabel: string;
    ownedIds: readonly string[];
    parentId: string;
    ariaActivedescendant?: string;
  } = {
    ariaLabel: "Panes",
    id: "tiling-panes",
    ownedIds: Object.freeze([...paneIds]),
    parentId: "tiling-root",
    role: "listbox",
  };

  if (activePaneId !== undefined) panesList.ariaActivedescendant = activePaneId;
  descriptors.push(descriptor(panesList));

  for (let index = 0; index < state.panes.length; index += 1) {
    const pane = state.panes[index];
    const id = paneIds[index];

    if (pane !== undefined && id !== undefined) {
      descriptors.push(descriptor({
        ariaHidden: !pane.visible,
        ariaLabel: `${pane.title}, ${pane.path}`,
        ariaSelected: pane.focused,
        id,
        parentId: "tiling-panes",
        role: "option",
      }));
    }
  }

  descriptors.push(descriptor({
    ariaActivedescendant: activeWorkspaceId,
    ariaLabel: "Workspaces",
    id: "tiling-workspaces",
    ownedIds: Object.freeze([...workspaceIds]),
    parentId: "tiling-root",
    role: "listbox",
  }));

  for (let index = 0; index < state.statusBar.workspaces.length; index += 1) {
    const workspace = state.statusBar.workspaces[index];
    const id = workspaceIds[index];

    if (workspace !== undefined && id !== undefined) {
      descriptors.push(descriptor({
        ariaCurrent: workspace.active ? "page" : "false",
        ariaLabel: `${workspace.label}, ${workspace.layout}`,
        ariaSelected: workspace.active,
        id,
        parentId: "tiling-workspaces",
        role: "option",
      }));
    }
  }

  descriptors.push(descriptor({
    ariaLabel: state.statusBar.workspaceSummary,
    id: "tiling-status",
    parentId: "tiling-root",
    role: "status",
  }));

  return descriptorSet("desktop/tiling", descriptors);
}

export const indexAriaModel = createIndexAriaDescriptorSet;
export const settingsAriaModel = createSettingsAriaDescriptorSet;
export const filesAriaModel = createFilesAriaDescriptorSet;
export const shellAriaModel = createShellAriaDescriptorSet;
export const activityAriaModel = createActivityAriaDescriptorSet;
export const notificationsAriaModel = createNotificationsAriaDescriptorSet;
export const lockAriaModel = createLockAriaDescriptorSet;
export const tilingAriaModel = createTilingAriaDescriptorSet;

export function ariaBindId(id: string, field: AriaDescriptorBindField): string {
  return `aria.${id}.${field}`;
}

export function ariaElementId(prefix: string, value?: number | string): string {
  if (value === undefined) return prefix;

  return `${prefix}-${idToken(`${value}`)}`;
}

function descriptor(input: AriaDescriptor): AriaDescriptor {
  const output: {
    id: string;
    role: AriaRole;
    ariaLabel?: string;
    ariaLabelledBy?: string;
    ariaActivedescendant?: string;
    ariaControls?: string;
    ariaChecked?: AriaCheckedToken;
    ariaCurrent?: AriaCurrentToken;
    ariaDisabled?: boolean;
    ariaExpanded?: boolean;
    ariaHidden?: boolean;
    ariaPressed?: boolean;
    ariaSelected?: boolean;
    ownedIds?: readonly string[];
    parentId?: string;
  } = {
    id: input.id,
    role: input.role,
  };

  if (input.ariaLabel !== undefined) output.ariaLabel = input.ariaLabel;
  if (input.ariaLabelledBy !== undefined) output.ariaLabelledBy = input.ariaLabelledBy;
  if (input.ariaActivedescendant !== undefined) output.ariaActivedescendant = input.ariaActivedescendant;
  if (input.ariaControls !== undefined) output.ariaControls = input.ariaControls;
  if (input.ariaChecked !== undefined) output.ariaChecked = input.ariaChecked;
  if (input.ariaCurrent !== undefined) output.ariaCurrent = input.ariaCurrent;
  if (input.ariaDisabled !== undefined) output.ariaDisabled = input.ariaDisabled;
  if (input.ariaExpanded !== undefined) output.ariaExpanded = input.ariaExpanded;
  if (input.ariaHidden !== undefined) output.ariaHidden = input.ariaHidden;
  if (input.ariaPressed !== undefined) output.ariaPressed = input.ariaPressed;
  if (input.ariaSelected !== undefined) output.ariaSelected = input.ariaSelected;
  if (input.ownedIds !== undefined) output.ownedIds = Object.freeze([...input.ownedIds]);
  if (input.parentId !== undefined) output.parentId = input.parentId;

  return Object.freeze(output);
}

function descriptorSet(screenId: DesktopAriaScreenId, input: readonly AriaDescriptor[]): AriaDescriptorSet {
  const descriptors = Object.freeze(input.map(descriptor));

  return Object.freeze({
    descriptors,
    screenId,
    values: descriptorValues(descriptors),
  });
}

function descriptorValues(descriptors: readonly AriaDescriptor[]): Readonly<Record<string, AriaDescriptorValue>> {
  const output: Record<string, AriaDescriptorValue> = {};

  for (let index = 0; index < descriptors.length; index += 1) {
    const item = descriptors[index];

    if (item === undefined) continue;

    output[ariaBindId(item.id, "role")] = item.role;
    if (item.ariaLabel !== undefined) output[ariaBindId(item.id, "label")] = item.ariaLabel;
    if (item.ariaLabelledBy !== undefined) output[ariaBindId(item.id, "labelledby")] = item.ariaLabelledBy;
    if (item.ariaActivedescendant !== undefined) output[ariaBindId(item.id, "activedescendant")] = item.ariaActivedescendant;
    if (item.ariaControls !== undefined) output[ariaBindId(item.id, "controls")] = item.ariaControls;
    if (item.ariaChecked !== undefined) output[ariaBindId(item.id, "checked")] = item.ariaChecked;
    if (item.ariaCurrent !== undefined) output[ariaBindId(item.id, "current")] = item.ariaCurrent;
    if (item.ariaDisabled !== undefined) output[ariaBindId(item.id, "disabled")] = item.ariaDisabled;
    if (item.ariaExpanded !== undefined) output[ariaBindId(item.id, "expanded")] = item.ariaExpanded;
    if (item.ariaHidden !== undefined) output[ariaBindId(item.id, "hidden")] = item.ariaHidden;
    if (item.ariaPressed !== undefined) output[ariaBindId(item.id, "pressed")] = item.ariaPressed;
    if (item.ariaSelected !== undefined) output[ariaBindId(item.id, "selected")] = item.ariaSelected;
  }

  return Object.freeze(output);
}

function findSelectedFavoriteId(state: FilesViewState): string | undefined {
  for (let index = 0; index < state.favorites.length; index += 1) {
    const favorite = state.favorites[index];

    if (favorite !== undefined && favorite.selected) return ariaElementId("files-favorite", favorite.id);
  }

  return undefined;
}

function clipboardLabel(state: FilesOpsState): string {
  if (state.clipboard.mode === null || state.clipboard.targets.length === 0) return "Clipboard empty";

  return `${state.clipboard.mode} ${state.clipboard.targets.length}`;
}

function appendNotificationGroups(
  descriptors: AriaDescriptor[],
  groups: readonly NotificationsViewGroup[],
  groupIds: readonly string[],
): void {
  for (let index = 0; index < groups.length; index += 1) {
    const group = groups[index];
    const id = groupIds[index];

    if (group !== undefined && id !== undefined) {
      descriptors.push(descriptor({
        ariaLabel: `${group.appId}, ${group.count} notifications, ${group.unreadCount} unread`,
        id,
        parentId: "notifications-list",
        role: "group",
      }));
    }
  }
}

function itemAt(items: readonly string[], index: number): string | undefined {
  return Number.isInteger(index) && index >= 0 ? items[index] : undefined;
}

function lastItem(items: readonly string[]): string | undefined {
  return items.length === 0 ? undefined : items[items.length - 1];
}

function sortLabel(column: ActivitySortColumn): string {
  if (column === "cpu") return "CPU";
  if (column === "memory") return "Memory";
  if (column === "pid") return "PID";

  return "Name";
}

function titleCase(value: string): string {
  if (value.length === 0) return value;

  return `${value[0]?.toUpperCase() ?? ""}${value.slice(1)}`;
}

function idToken(value: string): string {
  let output = "";

  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];

    if (char === undefined) continue;

    const code = char.charCodeAt(0);
    const safe =
      (code >= 48 && code <= 57) ||
      (code >= 65 && code <= 90) ||
      (code >= 97 && code <= 122) ||
      code === 45 ||
      code === 95;

    output += safe ? char : `_${code.toString(16).padStart(4, "0")}`;
  }

  return output.length === 0 ? "empty" : output;
}
