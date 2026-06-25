import assert from "node:assert/strict";
import { test } from "node:test";

import {
  NotificationCenter,
  TrayModel,
  createStaticShellCapabilityPort,
} from "../../src/desktop-sdk/index.ts";
import type {
  DesktopCapability,
  DesktopCapabilityGrant,
  DesktopUiPackageManifest,
  FilesCapabilityPort,
  FilesErrorResponse,
  FilesRequest,
  FilesResponse,
  SettingsApplyIntent,
  SettingsControlPlanePort,
  SettingsControlPlaneResult,
  SettingsManagedConfig,
  SettingsPreviewIntent,
} from "../../src/desktop-sdk/index.ts";
import {
  createClockCalendarWidgetState,
  createQuickSettingsWidgetViewModel,
  createRecentFilesWidgetViewModel,
  createStatusTrayWidgetViewModel,
} from "../../../../ui_kits/desktop/viewmodels/widgets.ts";
import type {
  FirstPartyWidgetKind,
  QuickSettingsWidgetState,
  RecentFilesWidgetState,
  StatusTrayWidgetState,
  WidgetDataInstance,
} from "../../../../ui_kits/desktop/viewmodels/widgets.ts";

const CLOCK_MS = Date.UTC(2026, 5, 25, 14, 7, 9);
const QUICK_SETTINGS_CONFIG = Object.freeze({
  categories: Object.freeze([
    Object.freeze({
      id: "network",
      settings: Object.freeze([
        Object.freeze({
          id: "network.wifi",
          kind: "toggle",
          label: "Wi-Fi",
          value: true,
        }),
        Object.freeze({
          id: "network.bluetooth",
          kind: "toggle",
          label: "Bluetooth",
          value: false,
        }),
      ]),
      title: "Network",
    }),
  ]),
  revision: "settings:r1",
}) satisfies SettingsManagedConfig;

test("clock/calendar widget is deterministic from the injected clock and marks today", () => {
  const originalDateNow = Date.now;
  let ambientClockReads = 0;

  Date.now = () => {
    ambientClockReads += 1;
    throw new Error("ambient clock must not be read");
  };

  try {
    const first = createClockCalendarWidgetState(widgetInstance("clock"), CLOCK_MS);
    const second = createClockCalendarWidgetState(widgetInstance("clock"), CLOCK_MS);

    assert.equal(JSON.stringify(second), JSON.stringify(first));
    assert.equal(first.data.clock.date, "2026-06-25");
    assert.equal(first.data.clock.time, "14:07:09");
    assert.equal(first.data.clock.timeShort, "14:07");
    assert.equal(first.data.calendar.monthLabel, "June");
    assert.equal(first.data.calendar.weeks.length, 5);
    assert.deepEqual(todayCells(first.data.calendar.weeks).map((cell) => cell.date), ["2026-06-25"]);
    assertFrozenWidgetState(first);
    assert.equal(ambientClockReads, 0);
  } finally {
    Date.now = originalDateNow;
  }
});

test("recent-files widget lists through the files port with deterministic order and cap", async () => {
  const calls: FilesRequest[] = [];
  const model = createRecentFilesWidgetViewModel({
    files: fakeFilesPort(calls, (request) => {
      assert.equal(request.op, "list");
      assert.equal(request.grant, "desktop-recents");
      assert.equal(request.path, "/recents");

      return {
        entries: [
          fileEntry("zeta.ts", "file", 100, "2026-06-24T10:00:00Z"),
          fileEntry("apps", "dir", 0, "2026-06-24T08:00:00Z"),
          fileEntry("alpha.ts", "file", 50, "2026-06-24T09:00:00Z"),
          fileEntry("notes", "dir", 0, "2026-06-24T07:00:00Z"),
        ],
      };
    }),
    filesGrant: "desktop-recents",
    instance: widgetInstance("recent-files"),
    limit: 3,
    package: packageManifest(grant("files.read", "desktop-recents")),
    path: "/recents",
  });

  const state = await model.refresh(1000);

  assert.deepEqual(calls, [
    {
      grant: "desktop-recents",
      op: "list",
      path: "/recents",
    },
  ]);
  assert.equal(state.status, "ready");
  assert.equal(state.placeholder, false);
  assert.deepEqual(state.data.entries.map((entry) => [entry.kind, entry.name, entry.path]), [
    ["dir", "apps", "/recents/apps"],
    ["dir", "notes", "/recents/notes"],
    ["file", "alpha.ts", "/recents/alpha.ts"],
  ]);
  assert.equal(model.state, state);
  assertFrozenRecentFilesState(state);
});

test("recent-files widget fails closed to empty without grant or port", async () => {
  const calls: FilesRequest[] = [];
  const withoutGrant = createRecentFilesWidgetViewModel({
    files: fakeFilesPort(calls, () => {
      throw new Error("files port must not be called without grant");
    }),
    filesGrant: "desktop-recents",
    instance: widgetInstance("recent-files", "recent-denied"),
    package: packageManifest(),
  });
  const denied = await withoutGrant.refresh(2000);

  assert.deepEqual(calls, []);
  assert.equal(denied.status, "forbidden");
  assert.equal(denied.placeholder, true);
  assert.deepEqual(denied.data.entries, []);
  assert.equal(denied.data.error?.code, "MISSING_CAPABILITY");
  assertFrozenRecentFilesState(denied);

  const withoutPort = createRecentFilesWidgetViewModel({
    filesGrant: "desktop-recents",
    instance: widgetInstance("recent-files", "recent-no-port"),
    package: packageManifest(grant("files.read", "desktop-recents")),
  });
  const placeholder = await withoutPort.refresh(3000);

  assert.equal(placeholder.status, "placeholder");
  assert.equal(placeholder.placeholder, true);
  assert.deepEqual(placeholder.data.entries, []);
  assert.equal(placeholder.data.error?.code, "FILES_PORT_UNAVAILABLE");
  assertFrozenRecentFilesState(placeholder);
});

test("quick-settings widget toggles via settings apply and reflects the applied snapshot", async () => {
  const applyCalls: SettingsApplyIntent[] = [];
  const model = createQuickSettingsWidgetViewModel({
    config: QUICK_SETTINGS_CONFIG,
    controls: Object.freeze([
      Object.freeze({
        categoryId: "network",
        iconRef: "lucide:wifi",
        id: "wifi",
        label: "Wi-Fi",
        settingId: "network.wifi",
      }),
    ]),
    instance: widgetInstance("quick-settings"),
    package: packageManifest(grant("settings.write", "network.wifi")),
    settings: fakeSettingsPort(applyCalls),
  });
  const before = model.refresh(4000);

  assert.equal(before.status, "ready");
  assert.deepEqual(before.data.controls.map((control) => [
    control.id,
    control.enabled,
    control.value,
    control.available,
    control.disabled,
  ]), [
    ["wifi", true, true, true, false],
  ]);

  const toggled = await model.toggle("wifi", 5000);

  assert.equal(toggled.ok, true);
  assert.equal(applyCalls.length, 1);
  assert.equal(applyCalls[0]?.edit.categoryId, "network");
  assert.equal(applyCalls[0]?.edit.settingId, "network.wifi");
  assert.equal(applyCalls[0]?.edit.value, false);
  assert.equal(applyCalls[0]?.desired.categories[0]?.settings[0]?.value, false);
  assert.deepEqual(toggled.state.data.controls.map((control) => [
    control.id,
    control.enabled,
    control.value,
    control.available,
    control.disabled,
  ]), [
    ["wifi", false, false, true, false],
  ]);
  assert.equal(model.state, toggled.state);
  assertFrozenQuickSettingsState(toggled.state);
});

test("quick-settings widget fails closed to disabled controls when the port is absent", () => {
  const state = createQuickSettingsWidgetViewModel({
    config: QUICK_SETTINGS_CONFIG,
    instance: widgetInstance("quick-settings", "quick-no-port"),
    package: packageManifest(grant("settings.write", "network.wifi")),
  }).refresh(6000);

  assert.notEqual(state.status, "ready");
  assert.deepEqual(state.data.controls.map((control) => [
    control.id,
    control.enabled,
    control.value,
    control.available,
    control.disabled,
  ]), [
    ["network.wifi", false, false, false, true],
    ["network.bluetooth", false, false, false, true],
  ]);
  assertFrozenQuickSettingsState(state);
});

test("status/tray widget mirrors injected tray and notification snapshots", () => {
  const capabilities = createStaticShellCapabilityPort([
    shellGrant("vita.wifi", "shell.tray.register"),
    shellGrant("vita.battery", "shell.tray.register"),
    shellGrant("vita.mail", "shell.notifications.post"),
  ]);
  const tray = new TrayModel({ capabilities });
  const notificationCenter = new NotificationCenter({
    capabilities,
    clock: Object.freeze({
      nowMs: 10_000,
    }),
    maxVisible: 1,
  });

  assertShellOk(tray.register("vita.battery", {
    iconRef: "battery",
    id: "battery",
    order: 20,
    status: "warning",
    tooltip: "Battery",
  }));
  assertShellOk(tray.register("vita.wifi", {
    iconRef: "wifi",
    id: "wifi",
    order: 10,
    status: "ok",
    tooltip: "Wi-Fi",
  }));
  assertShellOk(notificationCenter.post("vita.mail", {
    id: "mail-1",
    priority: "normal",
    title: "Mail",
  }));
  assertShellOk(notificationCenter.post("vita.mail", {
    id: "mail-2",
    priority: "high",
    title: "Calendar",
  }));

  const state = createStatusTrayWidgetViewModel({
    instance: widgetInstance("status-tray"),
    notificationCenter,
    package: packageManifest(
      grant("shell.tray.register"),
      grant("shell.notifications.post"),
    ),
    trayModel: tray,
  }).refresh(7000);

  assert.equal(state.status, "ready");
  assert.equal(state.placeholder, false);
  assert.deepEqual(state.data.statusItems.map((item) => [item.id, item.order, item.status]), [
    ["wifi", 10, "ok"],
    ["battery", 20, "warning"],
  ]);
  assert.equal(state.data.status, "warning");
  assert.equal(state.data.trayCount, 2);
  assert.equal(state.data.notificationCount, 2);
  assert.equal(state.data.unreadCount, 2);
  assert.equal(state.data.overflowCount, 1);
  assert.deepEqual(state.data.notifications.map((notification) => notification.id), ["mail-1", "mail-2"]);
  assertFrozenStatusTrayState(state);
});

function fakeFilesPort(
  calls: FilesRequest[],
  handler: (request: FilesRequest) => FilesResponse | FilesErrorResponse,
): FilesCapabilityPort {
  return Object.freeze({
    request(request: FilesRequest) {
      calls.push(request);
      return handler(request);
    },
  });
}

function fakeSettingsPort(applyCalls: SettingsApplyIntent[]): SettingsControlPlanePort {
  return Object.freeze({
    apply(intent: SettingsApplyIntent): SettingsControlPlaneResult {
      applyCalls.push(intent);
      return Object.freeze({
        ok: true,
        value: Object.freeze({
          stage: "apply",
        }),
      });
    },
    preview(_intent: SettingsPreviewIntent): SettingsControlPlaneResult {
      return Object.freeze({
        ok: true,
        value: Object.freeze({
          stage: "preview",
        }),
      });
    },
  });
}

function fileEntry(
  name: string,
  kind: NonNullable<FilesResponse["entries"]>[number]["kind"],
  size: number,
  mtime: string,
): NonNullable<FilesResponse["entries"]>[number] {
  return Object.freeze({
    kind,
    mtime,
    name,
    size,
  });
}

function widgetInstance(
  kind: FirstPartyWidgetKind,
  id = `widget:${kind}`,
): WidgetDataInstance {
  return Object.freeze({
    enabled: true,
    id,
    kind,
    paused: false,
    placement: Object.freeze({
      column: 0,
      row: 0,
      zone: "desktop",
    }),
    refreshIntervalMs: 60_000,
    sizeClass: "M",
  });
}

function packageManifest(...capabilityGrants: readonly DesktopCapabilityGrant[]): DesktopUiPackageManifest {
  return Object.freeze({
    capabilityGrants: Object.freeze([...capabilityGrants]),
    entry: "index.html",
    id: "vita.desktop.flagship.test",
    sdkVersion: "0.0.0",
    version: "0.0.0",
  });
}

function grant(capability: DesktopCapability, resourceId?: string): DesktopCapabilityGrant {
  const output: {
    capability: DesktopCapability;
    resourceId?: string;
  } = {
    capability,
  };

  if (resourceId !== undefined) output.resourceId = resourceId;
  return Object.freeze(output);
}

function shellGrant(appId: string, capability: "shell.notifications.post" | "shell.tray.register") {
  return Object.freeze({
    appId,
    capability,
  });
}

function assertShellOk<T>(result: { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: { readonly message: string } }): T {
  if (!result.ok) {
    assert.fail(result.error.message);
  }

  return result.value;
}

function todayCells(weeks: readonly { readonly cells: readonly { readonly date: string; readonly today: boolean }[] }[]) {
  const output: { readonly date: string; readonly today: boolean }[] = [];

  for (let weekIndex = 0; weekIndex < weeks.length; weekIndex += 1) {
    const week = weeks[weekIndex];

    if (week === undefined) continue;
    for (let cellIndex = 0; cellIndex < week.cells.length; cellIndex += 1) {
      const cell = week.cells[cellIndex];

      if (cell?.today === true) output.push(cell);
    }
  }

  return Object.freeze(output);
}

function assertFrozenWidgetState(state: { readonly data: unknown; readonly placement: unknown }): void {
  assert.equal(Object.isFrozen(state), true);
  assert.equal(Object.isFrozen(state.placement), true);
  assert.equal(Object.isFrozen(state.data), true);
}

function assertFrozenRecentFilesState(state: RecentFilesWidgetState): void {
  assertFrozenWidgetState(state);
  assert.equal(Object.isFrozen(state.data.entries), true);
  if (state.data.entries[0] !== undefined) assert.equal(Object.isFrozen(state.data.entries[0]), true);
  if (state.data.error !== undefined) assert.equal(Object.isFrozen(state.data.error), true);
}

function assertFrozenQuickSettingsState(state: QuickSettingsWidgetState): void {
  assertFrozenWidgetState(state);
  assert.equal(Object.isFrozen(state.data.controls), true);
  if (state.data.controls[0] !== undefined) assert.equal(Object.isFrozen(state.data.controls[0]), true);
  if (state.data.error !== undefined) assert.equal(Object.isFrozen(state.data.error), true);
}

function assertFrozenStatusTrayState(state: StatusTrayWidgetState): void {
  assertFrozenWidgetState(state);
  assert.equal(Object.isFrozen(state.data.statusItems), true);
  assert.equal(Object.isFrozen(state.data.notifications), true);
  if (state.data.statusItems[0] !== undefined) assert.equal(Object.isFrozen(state.data.statusItems[0]), true);
  if (state.data.notifications[0] !== undefined) assert.equal(Object.isFrozen(state.data.notifications[0]), true);
  if (state.data.error !== undefined) assert.equal(Object.isFrozen(state.data.error), true);
}
