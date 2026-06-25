import assert from "node:assert/strict";
import { test } from "node:test";

import {
  NotificationCenter,
  TrayModel,
  createStaticShellCapabilityPort,
} from "../../src/desktop-sdk/index.ts";
import type {
  NotificationCenterSnapshot,
  NotificationClock,
  ShellNotification,
  ShellResult,
  TrayIntent,
  TrayItem,
  TraySnapshot,
} from "../../src/desktop-sdk/index.ts";
import {
  CONTROL_TOGGLE_MENU_ITEM_ID,
  DEFAULT_NOTIFICATION_CONTROL_APP_ID,
  NotificationsViewModel,
} from "../../../../ui_kits/desktop/viewmodels/Notifications.ts";
import type {
  NotificationsNotificationPort,
  NotificationsTrayPort,
} from "../../../../ui_kits/desktop/viewmodels/Notifications.ts";

test("notifications view-model groups notifications by app newest first and tracks read state", () => {
  let nowMs = 1_000;
  const capabilities = createStaticShellCapabilityPort([
    {
      appId: "backup",
      capability: "shell.notifications.post",
    },
    {
      appId: "mail",
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

  assertPosted(center.post("backup", {
    id: "backup-critical",
    priority: "critical",
    title: "Backup requires attention",
  }));

  nowMs = 1_010;
  assertPosted(center.post("mail", {
    body: "Earlier message",
    id: "mail-old",
    priority: "normal",
    title: "Mail waiting",
  }));

  nowMs = 1_020;
  assertPosted(center.post("mail", {
    body: "Newest low-priority message",
    id: "mail-new",
    priority: "low",
    title: "New mail",
  }));

  const viewModel = new NotificationsViewModel({
    notificationCenter: center,
    trayModel: tray,
  });
  const state = viewModel.state();

  assert.deepEqual(state.notifications.map((notification) => notification.id), [
    "mail-new",
    "mail-old",
    "backup-critical",
  ]);
  assert.equal(state.totalCount, 3);
  assert.equal(state.unreadCount, 3);
  assert.deepEqual(state.groups.map((group) => ({
    appId: group.appId,
    ids: group.notifications.map((notification) => notification.id),
    unreadCount: group.unreadCount,
  })), [
    {
      appId: "mail",
      ids: ["mail-new", "mail-old"],
      unreadCount: 2,
    },
    {
      appId: "backup",
      ids: ["backup-critical"],
      unreadCount: 1,
    },
  ]);

  const marked = viewModel.markRead("mail-new");

  assert.equal(marked.ok, true);
  assert.equal(marked.state.unreadCount, 2);
  assert.equal(requireNotification(marked.state.notifications, "mail-new").read, true);
  assert.equal(requireGroup(marked.state.groups, "mail").unreadCount, 1);

  const dismissed = viewModel.dismiss("mail-new");

  assert.equal(dismissed.ok, true);
  assert.deepEqual(dismissed.state.notifications.map((notification) => notification.id), [
    "mail-old",
    "backup-critical",
  ]);
  assert.equal(dismissed.state.unreadCount, 2);

  const cleared = viewModel.dismissAll();

  assert.equal(cleared.ok, true);
  assert.deepEqual(cleared.state.notifications, []);
  assert.deepEqual(cleared.state.groups, []);
  assert.equal(cleared.state.unreadCount, 0);
});

test("control-center toggles are backed by tray items and emit tray menu intents", () => {
  const capabilities = createStaticShellCapabilityPort([
    {
      appId: DEFAULT_NOTIFICATION_CONTROL_APP_ID,
      capability: "shell.tray.register",
    },
  ]);
  const viewModel = new NotificationsViewModel({
    notificationCenter: new NotificationCenter({
      capabilities,
      clock: manualClock(() => 2_000),
    }),
    trayModel: new TrayModel({
      capabilities,
    }),
  });

  const initial = viewModel.state();

  assert.deepEqual(initial.controls.map((control) => ({
    available: control.available,
    enabled: control.enabled,
    id: control.id,
  })), [
    {
      available: true,
      enabled: true,
      id: "wifi",
    },
    {
      available: true,
      enabled: false,
      id: "bluetooth",
    },
    {
      available: true,
      enabled: false,
      id: "dnd",
    },
  ]);

  const toggled = viewModel.toggle("bluetooth");

  assert.equal(toggled.ok, true);
  assert.deepEqual(toggled.intent, {
    appId: DEFAULT_NOTIFICATION_CONTROL_APP_ID,
    itemId: "bluetooth",
    menuItemId: CONTROL_TOGGLE_MENU_ITEM_ID,
    path: [CONTROL_TOGGLE_MENU_ITEM_ID],
    type: "tray.menu.select",
  });
  assert.equal(requireControl(toggled.state, "bluetooth").enabled, true);

  const wifiOff = viewModel.toggle("wifi");

  assert.equal(wifiOff.ok, true);
  assert.equal(requireControl(wifiOff.state, "wifi").enabled, false);
  assert.equal(requireControl(wifiOff.state, "wifi").status, undefined);

  const unknown = viewModel.toggle("airdrop");

  assert.equal(unknown.ok, false);
  if (unknown.ok) {
    assert.fail("expected unknown control to fail closed");
  }
  assert.equal(unknown.error.code, "UNKNOWN_CONTROL");
});

test("notifications view-model fails closed when notification and tray grants are absent", () => {
  const deniedCapabilities = createStaticShellCapabilityPort([]);
  const center = new NotificationCenter({
    capabilities: deniedCapabilities,
    clock: manualClock(() => 3_000),
  });
  const deniedPost = center.post("mail", {
    id: "mail-denied",
    title: "Denied",
  });

  assert.equal(deniedPost.ok, false);

  const tray = new TrayModel({
    capabilities: deniedCapabilities,
  });
  const viewModel = new NotificationsViewModel({
    notificationCenter: center,
    trayModel: tray,
  });
  const state = viewModel.state();

  assert.deepEqual(state.notifications, []);
  assert.equal(state.unreadCount, 0);
  assert.deepEqual(state.controls.map((control) => ({
    available: control.available,
    enabled: control.enabled,
    id: control.id,
  })), [
    {
      available: false,
      enabled: false,
      id: "wifi",
    },
    {
      available: false,
      enabled: false,
      id: "bluetooth",
    },
    {
      available: false,
      enabled: false,
      id: "dnd",
    },
  ]);
  assert.equal(tray.snapshot().totalCount, 0);

  const toggled = viewModel.toggle("wifi");

  assert.equal(toggled.ok, false);
  if (toggled.ok) {
    assert.fail("expected missing tray grant to fail closed");
  }
  assert.equal(toggled.error.code, "MISSING_CAPABILITY");
  assert.equal(requireControl(toggled.state, "wifi").available, false);
  assert.equal(requireControl(toggled.state, "wifi").enabled, false);
  assert.equal(tray.snapshot().totalCount, 0);

  const marked = viewModel.markRead("mail-denied");

  assert.equal(marked.ok, false);
  if (marked.ok) {
    assert.fail("expected missing notification to fail closed");
  }
  assert.equal(marked.error.code, "UNKNOWN_NOTIFICATION");
});

test("notifications view-model catches throwing fake ports and returns empty failed-closed state", () => {
  const viewModel = new NotificationsViewModel({
    notificationCenter: new ThrowingNotificationPort(),
    trayModel: new ThrowingTrayPort(),
  });

  assert.doesNotThrow(() => viewModel.state());

  const state = viewModel.state();

  assert.deepEqual(state.notifications, []);
  assert.deepEqual(state.controls.map((control) => ({
    available: control.available,
    enabled: control.enabled,
    id: control.id,
  })), [
    {
      available: false,
      enabled: false,
      id: "wifi",
    },
    {
      available: false,
      enabled: false,
      id: "bluetooth",
    },
    {
      available: false,
      enabled: false,
      id: "dnd",
    },
  ]);
  assert.deepEqual(state.errors.map((error) => error.code), [
    "NOTIFICATION_PORT_FAILED",
    "TRAY_PORT_FAILED",
  ]);

  const dismissed = viewModel.dismiss("anything");

  assert.equal(dismissed.ok, false);
  if (dismissed.ok) {
    assert.fail("expected throwing dismiss to fail closed");
  }
  assert.equal(dismissed.error.code, "NOTIFICATION_PORT_FAILED");
});

function manualClock(nowMs: () => number): NotificationClock {
  return Object.freeze({
    nowMs,
  });
}

function assertPosted(result: ReturnType<NotificationCenter["post"]>): ShellNotification {
  if (!result.ok) {
    assert.fail(`expected notification post to succeed: ${result.error.code}`);
  }

  assert.equal(result.ok, true);
  return result.value;
}

function requireNotification(
  notifications: readonly { readonly id: string; readonly read: boolean }[],
  id: string,
): { readonly id: string; readonly read: boolean } {
  for (let index = 0; index < notifications.length; index += 1) {
    const notification = notifications[index];

    if (notification !== undefined && notification.id === id) return notification;
  }

  assert.fail(`missing notification ${id}`);
}

function requireGroup<T extends { readonly appId: string }>(
  groups: readonly T[],
  appId: string,
): T {
  for (let index = 0; index < groups.length; index += 1) {
    const group = groups[index];

    if (group !== undefined && group.appId === appId) return group;
  }

  assert.fail(`missing group ${appId}`);
}

function requireControl(
  state: ReturnType<NotificationsViewModel["state"]>,
  id: string,
): ReturnType<NotificationsViewModel["state"]>["controls"][number] {
  for (let index = 0; index < state.controls.length; index += 1) {
    const control = state.controls[index];

    if (control !== undefined && control.id === id) return control;
  }

  assert.fail(`missing control ${id}`);
}

class ThrowingNotificationPort implements NotificationsNotificationPort {
  dismiss(notificationId: string): ShellResult<readonly ShellNotification[]>;
  dismiss(appId: string, notificationId: string): ShellResult<readonly ShellNotification[]>;
  dismiss(_first: string, _second?: string): ShellResult<readonly ShellNotification[]> {
    throw new Error("dismiss unavailable");
  }

  snapshot(): NotificationCenterSnapshot {
    throw new Error("snapshot unavailable");
  }
}

class ThrowingTrayPort implements NotificationsTrayPort {
  register(_appId: string, _input: unknown): ShellResult<TrayItem> {
    throw new Error("register unavailable");
  }

  selectMenuItem(_itemId: string, _menuItemId: string): ShellResult<TrayIntent> {
    throw new Error("select unavailable");
  }

  snapshot(): TraySnapshot {
    throw new Error("tray snapshot unavailable");
  }
}
