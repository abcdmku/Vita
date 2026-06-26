import assert from "node:assert/strict";
import { test } from "node:test";

import {
  createDesktopShellA11yKeyboardAuditCases,
  createPointerOnlyWindowSnapA11yKeyboardAuditCase,
  runA11yKeyboardAudit,
  serializeA11yKeyboardAuditReport,
} from "../../../../ui_kits/desktop/viewmodels/a11y-keyboard-audit.ts";
import {
  INDEX_DOCK_APP_IDS,
  createIndexDockViewModel,
} from "../../../../ui_kits/desktop/viewmodels/dock.ts";
import type {
  IndexDockPorts,
} from "../../../../ui_kits/desktop/viewmodels/dock.ts";
import {
  INDEX_PALETTE_APP_IDS,
  INDEX_PALETTE_COMMAND_IDS,
  createIndexPaletteViewModel,
} from "../../../../ui_kits/desktop/viewmodels/index.ts";
import type {
  IndexPalettePorts,
} from "../../../../ui_kits/desktop/viewmodels/index.ts";
import {
  createSearchViewModel,
} from "../../../../ui_kits/desktop/viewmodels/search.ts";
import type {
  SearchAppInput,
  SearchCommandInput,
  SearchFileScope,
  SearchSettingInput,
  SearchViewModel,
  SearchViewModelPorts,
} from "../../../../ui_kits/desktop/viewmodels/search.ts";
import {
  createFilesViewModel,
} from "../../../../ui_kits/desktop/viewmodels/files.ts";
import type {
  FilesFavoriteInput,
} from "../../../../ui_kits/desktop/viewmodels/files.ts";
import {
  SETTINGS_APPEARANCE_KEYS,
  createSettingsViewModel,
} from "../../../../ui_kits/desktop/viewmodels/Settings.ts";
import type {
  SettingsViewModel,
} from "../../../../ui_kits/desktop/viewmodels/Settings.ts";
import {
  createTilingViewModel,
} from "../../../../ui_kits/desktop/viewmodels/Tiling.ts";
import {
  createInitialWindowSnapModel,
  createWindowSnapViewModel,
} from "../../../../ui_kits/desktop/viewmodels/window-snap.ts";
import {
  DEFAULT_NOTIFICATION_CONTROL_APP_ID,
  NotificationsViewModel,
} from "../../../../ui_kits/desktop/viewmodels/Notifications.ts";
import {
  NotificationCenter,
  TrayModel,
  createDesktopHostForPackage,
  createStaticShellCapabilityPort,
} from "../../src/desktop-sdk/index.ts";
import type {
  DesktopAppLaunch,
  DesktopAppStop,
  DesktopCapability,
  DesktopCapabilityGrant,
  DesktopHost,
  DesktopHostResult,
  DesktopLaunchableApp,
  DesktopSettingsApply,
  DesktopTheme,
  DesktopUiPackageManifest,
  FilesCapabilityPort,
  FilesEntry,
  FilesErrorResponse,
  FilesRequest,
  FilesResponse,
  NotificationClock,
  NotificationPostInput,
  Rect,
  RegisteredShellComponent,
  ShellApplyResult,
  ShellComponentDefinition,
  ShellNotification,
  ShellPreviewResult,
  ShellResult,
  ShellRollbackResult,
  TrayItem,
  TrayItemInput,
  WindowManagerIntent,
} from "../../src/desktop-sdk/index.ts";

const SEARCH_APP_ID = "vita.audit.alpha";
const SEARCH_COMMAND_ID = "vita.audit.command.alpha";
const SEARCH_SETTINGS_APP_ID = "vita.app.settings";
const FILE_GRANT = "workspace";
const SNAP_WINDOW_ID = "window:a11y:snap";
const SNAP_TEXTURE_ID = "texture:a11y:snap";
const SNAP_WORK_AREA = Object.freeze({
  height: 800,
  width: 1_200,
  x: 0,
  y: 0,
}) satisfies Rect;
const SNAP_INITIAL_RECT = Object.freeze({
  height: 300,
  width: 500,
  x: 100,
  y: 120,
}) satisfies Rect;

const FILES_FAVORITES = Object.freeze([
  Object.freeze({
    id: "home",
    label: "Home",
    path: "/workspace",
  }),
  Object.freeze({
    id: "src",
    label: "src",
    path: "/workspace/src",
  }),
  Object.freeze({
    id: "apps",
    label: "apps",
    path: "/workspace/src/apps",
  }),
] satisfies readonly FilesFavoriteInput[]);

const SEARCH_FILE_SCOPE = Object.freeze({
  grant: FILE_GRANT,
  label: "Workspace",
  maxDepth: 1,
  path: "/workspace",
} satisfies SearchFileScope);

test("desktop shell primary actions are keyboard reachable through view-model APIs", async () => {
  const report = await runA11yKeyboardAudit(createDesktopShellA11yKeyboardAuditCases(fixture()));

  assert.equal(report.passed, true, failedEntries(report));
  assert.deepEqual([...new Set(report.entries.map((entry) => entry.screen))], [
    "dock",
    "palette",
    "search",
    "files",
    "tiling",
    "window-snap",
    "settings",
    "notifications",
  ]);
  assert.deepEqual(report.entries.map((entry) => entry.actionId), [
    "dock.launch.terminal",
    "dock.launch.code",
    "dock.launch.files",
    "dock.launch.mail",
    "dock.launch.browser",
    "dock.launch.activity",
    "dock.launch.settings",
    "dock.focus.running-terminal",
    "palette.command.run-kernel",
    "palette.app.files",
    "palette.command.toggle-dark-mode",
    "palette.app.terminal",
    "palette.app.code",
    "palette.app.mail",
    "palette.app.browser",
    "palette.app.settings",
    "search.open-app",
    "search.open-file",
    "search.run-command",
    "search.open-setting",
    "files.refresh",
    "files.navigate-directory",
    "files.select-file",
    "files.navigate-up",
    "files.favorite.home",
    "files.favorite.apps",
    "tiling.focus-explorer",
    "tiling.focus-system",
    "tiling.cycle-layout",
    "tiling.split-next",
    "tiling.split-previous",
    "tiling.move-focused-pane",
    "tiling.move-to-workspace",
    "window-snap.left-half",
    "window-snap.right-half",
    "window-snap.top-half",
    "window-snap.bottom-half",
    "window-snap.top-left",
    "window-snap.top-right",
    "window-snap.bottom-left",
    "window-snap.bottom-right",
    "window-snap.center",
    "window-snap.maximize",
    "window-snap.restore",
    "settings.select-network",
    "settings.set-theme",
    "settings.set-accent",
    "settings.set-layout",
    "notifications.mark-read",
    "notifications.dismiss",
    "notifications.dismiss-all",
    "notifications.toggle-wifi",
    "notifications.toggle-bluetooth",
    "notifications.toggle-dnd",
  ]);
});

test("desktop shell keyboard audit report is deterministic byte-for-byte", async () => {
  const first = await runA11yKeyboardAudit(createDesktopShellA11yKeyboardAuditCases(fixture()));
  const second = await runA11yKeyboardAudit(createDesktopShellA11yKeyboardAuditCases(fixture()));

  assert.equal(serializeA11yKeyboardAuditReport(first), serializeA11yKeyboardAuditReport(second));
});

test("pointer-only action fails the keyboard-operability audit", async () => {
  const report = await runA11yKeyboardAudit([
    createPointerOnlyWindowSnapA11yKeyboardAuditCase(createAuditWindowSnap),
  ]);

  assert.equal(report.passed, false);
  assert.deepEqual(report.entries.map((entry) => [
    entry.actionId,
    entry.status,
    entry.reached,
    entry.detail,
  ]), [
    [
      "window-snap.pointer-only.bottom-right",
      "failed",
      false,
      "no keyboard mapping for snapAtPoint",
    ],
  ]);
});

function fixture(): Parameters<typeof createDesktopShellA11yKeyboardAuditCases>[0] {
  return Object.freeze({
    createDock: createAuditDock,
    createFiles: createAuditFiles,
    createNotifications: createAuditNotifications,
    createPalette: createAuditPalette,
    createSearch: createAuditSearch,
    createSettings: createAuditSettings,
    createTiling: createAuditTiling,
    createWindowSnap: createAuditWindowSnap,
  });
}

function createAuditDock() {
  return createIndexDockViewModel(dockPorts([
    grant("apps.launch", INDEX_DOCK_APP_IDS.terminal),
    grant("apps.launch", INDEX_DOCK_APP_IDS.code),
    grant("apps.launch", INDEX_DOCK_APP_IDS.files),
    grant("apps.launch", INDEX_DOCK_APP_IDS.mail),
    grant("apps.launch", INDEX_DOCK_APP_IDS.browser),
    grant("apps.launch", INDEX_DOCK_APP_IDS.activity),
    grant("apps.launch", INDEX_DOCK_APP_IDS.settings),
  ]));
}

function createAuditPalette() {
  return createIndexPaletteViewModel(palettePorts([
    grant("launcher.launch", "vita.command.run-kernel"),
    grant("launcher.launch", "vita.command.toggle-dark-mode"),
    grant("apps.launch", INDEX_PALETTE_APP_IDS.files),
    grant("apps.launch", INDEX_PALETTE_APP_IDS.terminal),
    grant("apps.launch", INDEX_PALETTE_APP_IDS.code),
    grant("apps.launch", INDEX_PALETTE_APP_IDS.mail),
    grant("apps.launch", INDEX_PALETTE_APP_IDS.browser),
    grant("apps.launch", INDEX_PALETTE_APP_IDS.settings),
  ]));
}

function createAuditSearch(): SearchViewModel {
  return createSearchViewModel({
    apps: searchApps(),
    commands: searchCommands(),
    fileScopes: [SEARCH_FILE_SCOPE],
    ports: searchPorts([
      grant("apps.launch", SEARCH_APP_ID),
      grant("launcher.launch", SEARCH_COMMAND_ID),
      grant("launcher.launch", SEARCH_SETTINGS_APP_ID),
      grant("files.read", FILE_GRANT),
    ]),
    settings: searchSettings(),
  });
}

function createAuditFiles() {
  return createFilesViewModel({
    favorites: FILES_FAVORITES,
    files: filesPort(filesHandler),
    grant: FILE_GRANT,
    initialPath: "/workspace/src",
  });
}

function createAuditTiling() {
  const calls: WindowManagerIntent[] = [];

  return createTilingViewModel({
    wm: wmPort(calls),
  });
}

function createAuditWindowSnap() {
  const calls: WindowManagerIntent[] = [];

  return createWindowSnapViewModel({
    initialModel: createInitialWindowSnapModel({
      rect: SNAP_INITIAL_RECT,
      textureId: SNAP_TEXTURE_ID,
      windowId: SNAP_WINDOW_ID,
    }),
    wm: wmPort(calls),
    workArea: SNAP_WORK_AREA,
  });
}

async function createAuditSettings(): Promise<SettingsViewModel> {
  const host = settingsHost(initialSettings());
  const scoped = createDesktopHostForPackage(host, manifest("ui.a11y.settings", [
    grant("settings.read", SETTINGS_APPEARANCE_KEYS.activeSection),
    grant("settings.read", SETTINGS_APPEARANCE_KEYS.theme),
    grant("settings.read", SETTINGS_APPEARANCE_KEYS.accent),
    grant("settings.read", SETTINGS_APPEARANCE_KEYS.layout),
    grant("settings.write", SETTINGS_APPEARANCE_KEYS.activeSection),
    grant("settings.write", SETTINGS_APPEARANCE_KEYS.theme),
    grant("settings.write", SETTINGS_APPEARANCE_KEYS.accent),
    grant("settings.write", SETTINGS_APPEARANCE_KEYS.layout),
  ]));
  const loaded = await createSettingsViewModel(scoped);

  assert.equal(loaded.ok, true);
  if (!loaded.ok) {
    assert.fail("expected settings fixture to load");
  }

  return loaded.value;
}

function createAuditNotifications() {
  let nowMs = 1_000;
  const capabilities = createStaticShellCapabilityPort([
    {
      appId: "mail",
      capability: "shell.notifications.post",
    },
    {
      appId: "backup",
      capability: "shell.notifications.post",
    },
    {
      appId: DEFAULT_NOTIFICATION_CONTROL_APP_ID,
      capability: "shell.tray.register",
    },
  ]);
  const center = new NotificationCenter({
    capabilities,
    clock: manualClock(() => nowMs),
  });
  const tray = new TrayModel({
    capabilities,
  });

  assertPosted(center.post("mail", {
    id: "mail-old",
    priority: "normal",
    title: "Older mail",
  }));
  nowMs = 1_010;
  assertPosted(center.post("mail", {
    id: "mail-new",
    priority: "normal",
    title: "New mail",
  }));

  return new NotificationsViewModel({
    notificationCenter: center,
    trayModel: tray,
  });
}

function dockPorts(grants: readonly DesktopCapabilityGrant[]): IndexDockPorts {
  const ports: IndexDockPorts = {
    launchApp(app: DesktopLaunchableApp) {
      return launchApp(app);
    },
    package: manifest("ui.a11y.dock", grants),
  };

  return Object.freeze(ports);
}

function palettePorts(grants: readonly DesktopCapabilityGrant[]): IndexPalettePorts {
  const ports: IndexPalettePorts = {
    emitLauncherIntent(): DesktopHostResult<true> {
      return {
        ok: true,
        value: true,
      };
    },
    launchApp(app: DesktopLaunchableApp) {
      return launchApp(app);
    },
    package: manifest("ui.a11y.palette", grants),
  };

  return Object.freeze(ports);
}

function searchPorts(grants: readonly DesktopCapabilityGrant[]): SearchViewModelPorts {
  const ports: SearchViewModelPorts = {
    emitLauncherIntent(): DesktopHostResult<true> {
      return {
        ok: true,
        value: true,
      };
    },
    files: filesPort(searchFilesHandler),
    launchApp(app: DesktopLaunchableApp) {
      return launchApp(app);
    },
    package: manifest("ui.a11y.search", grants),
  };

  return Object.freeze(ports);
}

function searchApps(): readonly SearchAppInput[] {
  return Object.freeze([
    Object.freeze({
      app: tsxApp(SEARCH_APP_ID, "Alpha App"),
      id: "app.alpha",
      subtitle: "Application",
      title: "Alpha App",
    }),
  ]);
}

function searchCommands(): readonly SearchCommandInput[] {
  return Object.freeze([
    Object.freeze({
      id: "command.alpha",
      intent: Object.freeze({
        appId: SEARCH_COMMAND_ID,
        query: "alpha command",
        type: "launcher.launch",
      }),
      subtitle: "Command",
      title: "Alpha Command",
    }),
  ]);
}

function searchSettings(): readonly SearchSettingInput[] {
  return Object.freeze([
    Object.freeze({
      appId: SEARCH_SETTINGS_APP_ID,
      id: "setting.alpha",
      sectionId: "alpha",
      subtitle: "system settings",
      title: "Alpha Setting",
    }),
  ]);
}

function filesPort(handler: (request: FilesRequest) => FilesResponse | FilesErrorResponse): FilesCapabilityPort {
  return Object.freeze({
    request(request: FilesRequest) {
      return handler(request);
    },
  });
}

function filesHandler(request: FilesRequest): FilesResponse | FilesErrorResponse {
  if (request.op === "list" && request.path === "/workspace/src") {
    return Object.freeze({
      entries: Object.freeze([
        entry("apps", "dir", 0, "2026-06-24T09:00:00Z"),
        entry("kernel.ts", "file", 8_400, "2026-06-24T10:18:00Z"),
      ]),
    });
  }
  if (request.op === "list" && request.path === "/workspace/src/apps") {
    return Object.freeze({
      entries: Object.freeze([
        entry("main.ts", "file", 1_200, "2026-06-24T10:20:00Z"),
      ]),
    });
  }
  if (request.op === "list" && request.path === "/workspace") {
    return Object.freeze({
      entries: Object.freeze([
        entry("src", "dir", 0, "2026-06-24T09:00:00Z"),
      ]),
    });
  }

  return forbidden();
}

function searchFilesHandler(request: FilesRequest): FilesResponse | FilesErrorResponse {
  if (request.op === "list" && request.path === "/workspace") {
    return Object.freeze({
      entries: Object.freeze([
        entry("alpha.txt", "file", 25, "2026-06-24T10:00:00Z"),
        entry("projects", "dir", 0, "2026-06-24T09:00:00Z"),
      ]),
    });
  }
  if (request.op === "list" && request.path === "/workspace/projects") {
    return Object.freeze({
      entries: Object.freeze([
        entry("readme.md", "file", 40, "2026-06-24T12:00:00Z"),
      ]),
    });
  }
  if (request.op === "read" && request.path === "/workspace/alpha.txt") {
    return Object.freeze({
      data: "alpha contents",
      kind: "file",
      mtime: "2026-06-24T10:00:00Z",
      size: 25,
    });
  }

  return forbidden();
}

function wmPort(calls: WindowManagerIntent[]) {
  return Object.freeze({
    repositionTexture(textureId: string, rect: Rect, windowId: string): void {
      calls.push(Object.freeze({
        rect,
        textureId,
        type: "repositionTexture",
        windowId,
      }));
    },
    setFocus(windowId: string | null): void {
      calls.push(Object.freeze({
        type: "setFocus",
        windowId,
      }));
    },
    setTextureVisibility(textureId: string, visible: boolean, windowId: string): void {
      calls.push(Object.freeze({
        textureId,
        type: "setTextureVisibility",
        visible,
        windowId,
      }));
    },
  });
}

function settingsHost(input: Readonly<Record<string, string>>): DesktopHost {
  const settings = new Map(Object.entries(input));
  const host: DesktopHost = {
    applySetting(request: Parameters<NonNullable<DesktopHost["applySetting"]>>[0]): DesktopHostResult<DesktopSettingsApply> {
      if (typeof request.value !== "string") {
        return hostReject("MALFORMED_WRITE", "settings audit fixture only accepts string values.", "/settings/apply/value");
      }

      settings.set(request.key, request.value);
      return {
        ok: true,
        value: Object.freeze({
          applied: Object.freeze({
            key: request.key,
            value: request.value,
          }),
          revision: `rev:${request.key}:${request.value}`,
        }),
      };
    },
    applyShell(): ShellApplyResult {
      throw new Error("unused");
    },
    launchApp(app: DesktopLaunchableApp): DesktopHostResult<DesktopAppLaunch> {
      return launchApp(app);
    },
    package: manifest("host.a11y.settings", []),
    postNotification(inputNotification: NotificationPostInput): ShellResult<ShellNotification> {
      return shellAccept(Object.freeze({
        actions: Object.freeze([]),
        appId: "ui.a11y.settings",
        createdAtMs: 0,
        id: inputNotification.id,
        priority: inputNotification.priority ?? "normal",
        title: inputNotification.title,
      }));
    },
    previewShell(): ShellPreviewResult {
      throw new Error("unused");
    },
    readSetting(request: Parameters<NonNullable<DesktopHost["readSetting"]>>[0]): DesktopHostResult<string> {
      const value = settings.get(request.key);

      if (value === undefined) {
        return hostReject("SETTING_NOT_FOUND", "setting is not available.", `/settings/${request.key}`);
      }

      return {
        ok: true,
        value,
      };
    },
    readTheme(): DesktopTheme {
      return theme();
    },
    registerComponent(definition: ShellComponentDefinition): ShellResult<RegisteredShellComponent> {
      return shellAccept(Object.freeze({
        defaultPlacement: Object.freeze({
          layer: definition.defaultPlacement.layer ?? "desktop",
          order: definition.defaultPlacement.order ?? 0,
          zone: definition.defaultPlacement.zone ?? "center",
        }),
        id: definition.id,
        render: definition.render,
        role: definition.role,
      }));
    },
    registerTrayItem(inputTray: TrayItemInput): ShellResult<TrayItem> {
      return shellAccept(Object.freeze({
        appId: "ui.a11y.settings",
        iconRef: inputTray.iconRef,
        id: inputTray.id,
        menu: Object.freeze([]),
        order: inputTray.order ?? 0,
        tooltip: inputTray.tooltip,
      }));
    },
    rollbackShell(): ShellRollbackResult {
      throw new Error("unused");
    },
    stopApp(appId: string): DesktopHostResult<DesktopAppStop> {
      return {
        ok: true,
        value: Object.freeze({
          appId,
          intents: Object.freeze([]),
        }),
      };
    },
  };

  return Object.freeze(host);
}

function initialSettings(): Readonly<Record<string, string>> {
  return Object.freeze({
    [SETTINGS_APPEARANCE_KEYS.accent]: "blue",
    [SETTINGS_APPEARANCE_KEYS.activeSection]: "general",
    [SETTINGS_APPEARANCE_KEYS.layout]: "comfortable",
    [SETTINGS_APPEARANCE_KEYS.theme]: "light",
  });
}

function launchApp(app: DesktopLaunchableApp): DesktopHostResult<DesktopAppLaunch> {
  return {
    ok: true,
    value: Object.freeze({
      app,
      intents: Object.freeze([]),
      surfaceId: `surface:${app.id}`,
      textureId: `texture:${app.id}`,
      windowId: `window:${app.id}`,
    }),
  };
}

function tsxApp(id: string, title: string): DesktopLaunchableApp {
  return Object.freeze({
    id,
    runtime: Object.freeze({
      componentId: id,
    }),
    surfaceKind: "tsx",
    title,
  });
}

function manifest(id: string, grants: readonly DesktopCapabilityGrant[]): DesktopUiPackageManifest {
  return Object.freeze({
    capabilityGrants: Object.freeze(grants.map((item) => Object.freeze(item))),
    entry: `./${id}.ts`,
    id,
    sdkVersion: "1.0.0",
    version: "1.0.0",
  });
}

function grant(
  capability: DesktopCapability,
  resourceId?: string,
): DesktopCapabilityGrant {
  const output: {
    capability: DesktopCapability;
    resourceId?: string;
  } = {
    capability,
  };

  if (resourceId !== undefined) output.resourceId = resourceId;
  return Object.freeze(output);
}

function theme(): DesktopTheme {
  return Object.freeze({
    id: "vita.a11y.theme",
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
  });
}

function entry(
  name: string,
  kind: FilesEntry["kind"],
  size: number,
  mtime: string,
): FilesEntry {
  return Object.freeze({
    kind,
    mtime,
    name,
    size,
  });
}

function forbidden(): FilesErrorResponse {
  return Object.freeze({
    error: Object.freeze({
      code: "AccessForbidden",
      message: "path is outside the grant",
    }),
  });
}

function manualClock(nowMs: () => number): NotificationClock {
  return Object.freeze({
    nowMs,
  });
}

function assertPosted(result: ReturnType<NotificationCenter["post"]>): ShellNotification {
  if (!result.ok) {
    assert.fail(`expected notification post to succeed: ${result.error.code}`);
  }

  return result.value;
}

function hostReject<T>(code: string, message: string, path: string): DesktopHostResult<T> {
  return {
    error: {
      code,
      message,
      path,
    },
    ok: false,
  };
}

function shellAccept<T>(value: T): ShellResult<T> {
  return {
    ok: true,
    value,
  };
}

function failedEntries(report: Awaited<ReturnType<typeof runA11yKeyboardAudit>>): string {
  return JSON.stringify(report.entries.filter((entry) => entry.status === "failed"), null, 2);
}
