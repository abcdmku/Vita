import assert from "node:assert/strict";
import { test } from "node:test";

import {
  INDEX_DOCK_APP_IDS,
} from "../../../../ui_kits/desktop/viewmodels/dock.ts";
import {
  SETTINGS_ACCENT_OPTIONS,
  SETTINGS_SECTIONS,
} from "../../../../ui_kits/desktop/viewmodels/Settings.ts";
import {
  ariaBindId,
  ariaElementId,
  createActivityAriaDescriptorSet,
  createDesktopAriaDescriptorSet,
  createFilesAriaDescriptorSet,
  createIndexAriaDescriptorSet,
  createLockAriaDescriptorSet,
  createNotificationsAriaDescriptorSet,
  createSettingsAriaDescriptorSet,
  createShellAriaDescriptorSet,
  createTilingAriaDescriptorSet,
} from "../../../../ui_kits/desktop/viewmodels/aria-model.ts";
import type {
  AriaDescriptor,
  AriaDescriptorSet,
  FilesAriaState,
  IndexAriaState,
} from "../../../../ui_kits/desktop/viewmodels/aria-model.ts";
import type {
  ActivityViewState,
} from "../../../../ui_kits/desktop/viewmodels/Activity.ts";
import type {
  LockViewModelState,
} from "../../../../ui_kits/desktop/viewmodels/Lock.ts";
import type {
  NotificationsViewState,
} from "../../../../ui_kits/desktop/viewmodels/Notifications.ts";
import type {
  SettingsViewModelState,
} from "../../../../ui_kits/desktop/viewmodels/Settings.ts";
import type {
  ShellViewModelState,
} from "../../../../ui_kits/desktop/viewmodels/Shell.ts";
import type {
  TilingViewModelState,
} from "../../../../ui_kits/desktop/viewmodels/Tiling.ts";

test("index aria descriptors model the palette listbox and dock menu relationships", () => {
  const set = createIndexAriaDescriptorSet(indexState());
  const terminalResultId = ariaElementId("desktop-palette-result", "app.terminal");
  const terminalDockId = ariaElementId("desktop-dock-item", INDEX_DOCK_APP_IDS.terminal);

  assert.equal(set.screenId, "desktop");
  assert.equal(Object.isFrozen(set), true);
  assert.equal(descriptor(set, "desktop-root").role, "application");
  assert.equal(descriptor(set, "desktop-palette-results").role, "listbox");
  assert.equal(descriptor(set, "desktop-palette-results").ariaActivedescendant, terminalResultId);
  assert.equal(descriptor(set, terminalResultId).ariaSelected, true);
  assert.equal(descriptor(set, terminalResultId).parentId, "desktop-palette-results");
  assert.equal(descriptor(set, "desktop-dock-menu").role, "menu");
  assert.equal(descriptor(set, "desktop-dock-menu").ariaActivedescendant, terminalDockId);
  assert.equal(descriptor(set, terminalDockId).ariaPressed, true);
  assert.equal(set.values[ariaBindId(terminalDockId, "pressed")], true);
});

test("settings aria descriptors derive active section and appearance control names", () => {
  const set = createSettingsAriaDescriptorSet(settingsState());
  const networkId = ariaElementId("settings-section", "network");
  const graphiteId = ariaElementId("settings-theme", "graphite");
  const tealId = ariaElementId("settings-accent", "teal");

  assert.equal(descriptor(set, "settings-root").role, "main");
  assert.equal(descriptor(set, "settings-sections").role, "listbox");
  assert.equal(descriptor(set, "settings-sections").ariaActivedescendant, networkId);
  assert.equal(descriptor(set, networkId).ariaSelected, true);
  assert.equal(descriptor(set, "settings-theme-group").role, "group");
  assert.equal(descriptor(set, graphiteId).ariaLabel, "Graphite");
  assert.equal(descriptor(set, graphiteId).ariaPressed, true);
  assert.equal(descriptor(set, tealId).ariaPressed, true);
  assert.equal(set.values[ariaBindId(networkId, "selected")], true);
  assert.equal(set.values[ariaBindId(graphiteId, "label")], "Graphite");
});

test("files, shell, activity, notifications, lock, and tiling descriptors cover roles and active descendants", () => {
  const files = createFilesAriaDescriptorSet(filesState());
  const selectedEntryId = ariaElementId("files-entry", "kernel.ts");

  assert.equal(descriptor(files, "files-entries").role, "listbox");
  assert.equal(descriptor(files, "files-entries").ariaActivedescendant, selectedEntryId);
  assert.equal(descriptor(files, selectedEntryId).ariaSelected, true);
  assert.equal(descriptor(files, "files-actions").ariaLabel, "copy 1");

  const shell = createShellAriaDescriptorSet(shellState());
  const activeTabId = ariaElementId("shell-tab", "build");

  assert.equal(descriptor(shell, "shell-tabs").role, "tablist");
  assert.equal(descriptor(shell, "shell-tabs").ariaActivedescendant, activeTabId);
  assert.equal(descriptor(shell, activeTabId).ariaSelected, true);
  assert.equal(descriptor(shell, "shell-command-input").ariaDisabled, false);

  const activity = createActivityAriaDescriptorSet(activityState());
  const processId = ariaElementId("activity-process", 31);
  const sortId = ariaElementId("activity-sort", "memory");

  assert.equal(descriptor(activity, "activity-sort-menu").role, "menu");
  assert.equal(descriptor(activity, "activity-sort-menu").ariaActivedescendant, sortId);
  assert.equal(descriptor(activity, sortId).ariaChecked, "true");
  assert.equal(descriptor(activity, "activity-processes").ariaActivedescendant, processId);
  assert.equal(descriptor(activity, processId).ariaSelected, true);

  const notifications = createNotificationsAriaDescriptorSet(notificationsState());
  const controlId = ariaElementId("notifications-control", "wifi");

  assert.equal(descriptor(notifications, "notifications-controls").role, "menu");
  assert.equal(descriptor(notifications, controlId).ariaChecked, "false");
  assert.equal(descriptor(notifications, controlId).ariaDisabled, true);

  const lock = createLockAriaDescriptorSet(lockState());

  assert.equal(descriptor(lock, "lock-root").role, "dialog");
  assert.equal(descriptor(lock, "lock-submit").ariaDisabled, true);
  assert.equal(descriptor(lock, "lock-submit").ariaPressed, false);

  const tiling = createTilingAriaDescriptorSet(tilingState());
  const paneId = ariaElementId("tiling-pane", "editor");
  const workspaceId = ariaElementId("tiling-workspace", "main");

  assert.equal(descriptor(tiling, "tiling-panes").role, "listbox");
  assert.equal(descriptor(tiling, "tiling-panes").ariaActivedescendant, paneId);
  assert.equal(descriptor(tiling, paneId).ariaHidden, false);
  assert.equal(descriptor(tiling, "tiling-workspaces").ariaActivedescendant, workspaceId);
  assert.equal(descriptor(tiling, workspaceId).ariaCurrent, "page");
});

test("desktop aria dispatcher returns the per-screen descriptor set", () => {
  const set = createDesktopAriaDescriptorSet({
    screenId: "desktop/lock",
    state: lockState(),
  });

  assert.equal(set.screenId, "desktop/lock");
  assert.equal(descriptor(set, "lock-root").ariaLabel, "Lock screen for Vita User");
});

function descriptor(set: AriaDescriptorSet, id: string): AriaDescriptor {
  for (let index = 0; index < set.descriptors.length; index += 1) {
    const item = set.descriptors[index];

    if (item?.id === id) return item;
  }

  assert.fail(`missing descriptor ${id}`);
}

function indexState(): IndexAriaState {
  return Object.freeze({
    dock: Object.freeze({
      focusedAppId: INDEX_DOCK_APP_IDS.terminal,
      items: Object.freeze([
        dockItem(INDEX_DOCK_APP_IDS.files, "Files", false, false),
        dockItem(INDEX_DOCK_APP_IDS.terminal, "Terminal", true, true),
      ]),
    }),
    error: null,
    palette: Object.freeze({
      highlightedIndex: 1,
      query: "",
      results: Object.freeze([
        command("app.files", "Open Files", "Application"),
        command("app.terminal", "Terminal", "Application"),
      ]),
    }),
  });
}

function command(id: string, title: string, subtitle: string): IndexAriaState["palette"]["results"][number] {
  return Object.freeze({
    action: Object.freeze({
      app: Object.freeze({
        id,
        runtime: Object.freeze({
          componentId: id,
        }),
        surfaceKind: "tsx",
        title,
      }),
      type: "launchApp",
    }),
    id,
    kind: "app",
    subtitle,
    title,
  });
}

function dockItem(
  appId: typeof INDEX_DOCK_APP_IDS[keyof typeof INDEX_DOCK_APP_IDS],
  title: string,
  running: boolean,
  focused: boolean,
): IndexAriaState["dock"]["items"][number] {
  return Object.freeze({
    appId,
    focused,
    icon: appId === INDEX_DOCK_APP_IDS.files ? "folder" : "terminal",
    pinned: true,
    running,
    title,
  });
}

function settingsState(): SettingsViewModelState {
  return Object.freeze({
    accentOptions: Object.freeze(SETTINGS_ACCENT_OPTIONS.map((option) => Object.freeze({
      active: option.id === "teal",
      color: option.color,
      id: option.id,
      label: option.label,
    }))),
    activeSection: "network",
    appearance: Object.freeze({
      accent: "teal",
      accentColor: "#14b8a6",
      density: "compact",
      layout: "tiling",
      theme: "graphite",
      tiling: true,
    }),
    sections: Object.freeze(SETTINGS_SECTIONS.map((section) => Object.freeze({
      active: section.id === "network",
      group: section.group,
      icon: section.icon,
      id: section.id,
      label: section.label,
    }))),
    theme: Object.freeze({
      id: "vita.test.theme",
      tokens: Object.freeze({
        colors: Object.freeze({
          background: "#101418",
        }),
        radii: Object.freeze({
          sm: 4,
        }),
        spacing: Object.freeze({
          sm: 8,
        }),
        typography: Object.freeze({
          body: "system-ui",
        }),
      }),
      version: "1.0.0",
    }),
  });
}

function filesState(): FilesAriaState {
  return Object.freeze({
    ops: Object.freeze({
      clipboard: Object.freeze({
        mode: "copy",
        targets: Object.freeze([
          Object.freeze({
            kind: "file",
            path: "/src/kernel.ts",
          }),
        ]),
      }),
      pendingOps: Object.freeze([]),
      status: "ready",
      trash: Object.freeze([]),
    }),
    view: Object.freeze({
      breadcrumbs: Object.freeze([
        Object.freeze({
          label: "src",
          path: "/src",
        }),
      ]),
      entries: Object.freeze([
        Object.freeze({
          kind: "dir",
          modified: "2026-06-24T09:00:00Z",
          name: "apps",
          size: 0,
        }),
        Object.freeze({
          kind: "file",
          modified: "2026-06-24T10:18:00Z",
          name: "kernel.ts",
          size: 8400,
        }),
      ]),
      favorites: Object.freeze([
        Object.freeze({
          id: "src",
          label: "src",
          path: "/src",
          selected: true,
        }),
      ]),
      path: "/src",
      selected: Object.freeze({
        kind: "file",
        modified: "2026-06-24T10:18:00Z",
        name: "kernel.ts",
        size: 8400,
      }),
      status: "ready",
    }),
  });
}

function shellState(): ShellViewModelState {
  const tabs = Object.freeze([
    shellTab("kernel", "kernel", false),
    shellTab("build", "build", false),
  ]);

  return Object.freeze({
    activeTab: tabs[1] ?? shellTab("build", "build", false),
    activeTabId: "build",
    tabs,
  });
}

function shellTab(id: string, title: string, running: boolean): ShellViewModelState["tabs"][number] {
  return Object.freeze({
    cwd: "~/vita",
    draftInput: "",
    history: Object.freeze([]),
    historyIndex: null,
    id,
    lastExitCode: null,
    outputBuffer: Object.freeze([]),
    running,
    title,
  });
}

function activityState(): ActivityViewState {
  return Object.freeze({
    cpuAveragePercent: 48,
    cpuHistory: Object.freeze([]),
    cpuPercent: 64,
    memory: Object.freeze({
      averagePercent: 50,
      history: Object.freeze([]),
      percent: 50,
      totalBytes: 16,
      usedBytes: 8,
    }),
    processCount: 2,
    processes: Object.freeze([
      Object.freeze({
        cpuAveragePercent: 10,
        cpuPercent: 12,
        memoryAverageBytes: 80,
        memoryBytes: 88,
        name: "Shell",
        pid: 31,
        selected: true,
      }),
      Object.freeze({
        cpuAveragePercent: 40,
        cpuPercent: 46,
        memoryAverageBytes: 600,
        memoryBytes: 612,
        name: "Studio",
        pid: 14,
        selected: false,
      }),
    ]),
    sampleCount: 1,
    sampledAtMs: 1000,
    selectedPid: 31,
    sort: Object.freeze({
      column: "memory",
      direction: "desc",
    }),
    status: "ready",
  });
}

function notificationsState(): NotificationsViewState {
  return Object.freeze({
    controls: Object.freeze([
      Object.freeze({
        appId: "vita.desktop.notifications",
        available: false,
        enabled: false,
        iconRef: "lucide:wifi",
        id: "wifi",
        label: "Wi-Fi",
        order: 10,
        tooltip: "Wi-Fi",
      }),
    ]),
    errors: Object.freeze([]),
    groups: Object.freeze([
      Object.freeze({
        appId: "mail",
        count: 1,
        latestCreatedAtMs: 1,
        notifications: Object.freeze([]),
        unreadCount: 1,
      }),
    ]),
    notifications: Object.freeze([
      Object.freeze({
        actions: Object.freeze([]),
        appId: "mail",
        body: "Hello",
        createdAtMs: 1,
        id: "n1",
        priority: "normal",
        read: false,
        title: "Inbox",
      }),
    ]),
    totalCount: 1,
    unreadCount: 1,
  });
}

function lockState(): LockViewModelState {
  return Object.freeze({
    attemptCount: 1,
    canSubmit: false,
    clock: Object.freeze({
      date: "Jun 25",
      epochMs: 0,
      iso: "2026-06-25T00:00:00.000Z",
      time: "10:24",
    }),
    lockState: "locked",
    maxAttempts: 5,
    remainingAttempts: 4,
    user: Object.freeze({
      displayName: "Vita User",
      id: "vita-user",
      initials: "V",
    }),
  });
}

function tilingState(): TilingViewModelState {
  return Object.freeze({
    activePaneId: "editor",
    activeWorkspaceId: "main",
    layout: "tile",
    panes: Object.freeze([
      Object.freeze({
        focused: true,
        id: "editor",
        kind: "editor",
        mode: "tiled",
        path: "/src/kernel.ts",
        rect: rect(),
        statusInfo: "ready",
        textureId: "texture:editor",
        title: "Editor",
        visible: true,
        windowId: "window:editor",
        workspaceId: "main",
        zIndex: 1,
      }),
    ]),
    placements: Object.freeze([]),
    statusBar: Object.freeze({
      activeWorkspaceId: "main",
      activeWorkspaceIndex: 0,
      branch: "main",
      focusedPaneId: "editor",
      info: "ready",
      intentCount: 0,
      lastIntentTypes: Object.freeze([]),
      layout: "tile",
      path: "/src/kernel.ts",
      workspaceCount: 1,
      workspaceSummary: "main workspace",
      workspaces: Object.freeze([
        Object.freeze({
          active: true,
          id: "main",
          label: "Main",
          layout: "tile",
        }),
      ]),
    }),
  });
}

function rect(): TilingViewModelState["panes"][number]["rect"] {
  return Object.freeze({
    height: 600,
    width: 800,
    x: 0,
    y: 0,
  });
}
