import assert from "node:assert/strict";
import { test } from "node:test";

import {
  createShellNotificationsHost,
  createStaticShellCapabilityPort,
} from "../../src/desktop-sdk/index.ts";
import type {
  NotificationClock,
  NotificationIntent,
  ShellCapabilityGrant,
  ShellNotification,
  ShellNotificationsHost,
  ShellResult,
  TrayIntent,
  TrayItem,
} from "../../src/desktop-sdk/index.ts";
import {
  CONTROL_TOGGLE_MENU_ITEM_ID,
  NotificationsViewModel,
} from "../../../../ui_kits/desktop/viewmodels/Notifications.ts";

const APP_ID = "vita.test.mail";
const CONTROL_ID = "sync";

test("postNotification stores and returns a guard-passing ShellNotification", () => {
  const host = createBackend([
    {
      appId: APP_ID,
      capability: "shell.notifications.post",
    },
  ]);

  const posted = assertOk(host.postNotification(APP_ID, {
    actions: Object.freeze([
      Object.freeze({
        id: "open",
        label: "Open",
        style: "primary",
      }),
    ]),
    body: "Message body",
    id: "message-1",
    priority: "high",
    title: "New message",
  }), "postNotification");

  assert.equal(isShellNotificationWire(posted), true);
  assert.deepEqual(posted, {
    actions: [
      {
        id: "open",
        label: "Open",
        style: "primary",
      },
    ],
    appId: APP_ID,
    body: "Message body",
    createdAtMs: 1_000,
    id: "message-1",
    priority: "high",
    title: "New message",
  });

  const snapshot = host.snapshot();

  assert.equal(snapshot.notifications.totalCount, 1);
  assert.deepEqual(snapshot.notifications.notifications, [posted]);
});

test("registerTrayItem stores and returns a guard-passing TrayItem", () => {
  const host = createBackend([
    {
      appId: APP_ID,
      capability: "shell.tray.register",
    },
  ]);

  const registered = assertOk(host.registerTrayItem(APP_ID, {
    iconRef: "lucide:mail",
    id: "mail-tray",
    menu: Object.freeze([
      Object.freeze({
        id: "open",
        label: "Open",
      }),
    ]),
    order: 10,
    status: "ok",
    tooltip: "Mail",
  }), "registerTrayItem");

  assert.equal(isTrayItemWire(registered), true);
  assert.deepEqual(registered, {
    appId: APP_ID,
    iconRef: "lucide:mail",
    id: "mail-tray",
    menu: [
      {
        enabled: true,
        id: "open",
        items: [],
        label: "Open",
      },
    ],
    order: 10,
    status: "ok",
    tooltip: "Mail",
  });

  const snapshot = host.snapshot();

  assert.equal(snapshot.tray.totalCount, 1);
  assert.deepEqual(snapshot.tray.items, [registered]);
});

test("NotificationsViewModel reads back backend notifications and tray controls", () => {
  const host = createBackend([
    {
      appId: APP_ID,
      capability: "shell.notifications.post",
    },
    {
      appId: APP_ID,
      capability: "shell.tray.register",
    },
  ], () => 2_000);
  const viewModel = new NotificationsViewModel({
    controlAppId: APP_ID,
    controls: Object.freeze([
      Object.freeze({
        iconRef: "lucide:refresh-cw",
        id: CONTROL_ID,
        initialEnabled: false,
        label: "Sync",
        order: 20,
        statusWhenEnabled: "ok",
        tooltip: "Sync status",
      }),
    ]),
    notificationCenter: host.notificationCenter,
    trayModel: host.trayModel,
  });

  assertOk(host.postNotification(APP_ID, {
    body: "Sync finished",
    id: "sync-complete",
    priority: "normal",
    title: "Sync complete",
  }), "postNotification");
  assertOk(host.registerTrayItem(APP_ID, {
    iconRef: "lucide:refresh-cw",
    id: CONTROL_ID,
    menu: Object.freeze([
      Object.freeze({
        checked: true,
        id: CONTROL_TOGGLE_MENU_ITEM_ID,
        label: "Sync",
      }),
    ]),
    order: 20,
    status: "ok",
    tooltip: "Sync status",
  }), "registerTrayItem");

  const state = viewModel.state();
  const control = requireControl(state.controls, CONTROL_ID);

  assert.deepEqual(state.notifications.map((notification) => notification.id), ["sync-complete"]);
  assert.equal(state.notifications[0]?.appId, APP_ID);
  assert.equal(control.available, true);
  assert.equal(control.enabled, true);
  assert.equal(control.status, "ok");
});

test("missing grants fail closed and store nothing", () => {
  const host = createBackend([]);
  const posted = host.postNotification(APP_ID, {
    id: "denied-notification",
    title: "Denied",
  });
  const registered = host.registerTrayItem(APP_ID, {
    iconRef: "lucide:x",
    id: "denied-tray",
    tooltip: "Denied",
  });
  const snapshot = host.snapshot();

  assertMissingCapability(posted);
  assertMissingCapability(registered);
  assert.equal(snapshot.notifications.totalCount, 0);
  assert.equal(snapshot.tray.totalCount, 0);
});

test("notification and tray intents route back to the originating app", () => {
  const host = createBackend([
    {
      appId: APP_ID,
      capability: "shell.notifications.post",
    },
    {
      appId: APP_ID,
      capability: "shell.tray.register",
    },
  ]);

  assertOk(host.postNotification(APP_ID, {
    actions: Object.freeze([
      Object.freeze({
        id: "open",
        label: "Open",
      }),
    ]),
    id: "route-notification",
    title: "Route me",
  }), "postNotification");
  assertOk(host.registerTrayItem(APP_ID, {
    iconRef: "lucide:bell",
    id: "route-tray",
    menu: Object.freeze([
      Object.freeze({
        id: "settings",
        label: "Settings",
      }),
    ]),
    tooltip: "Routes",
  }), "registerTrayItem");

  const notificationAction = assertOk(
    host.createActionIntent("route-notification", "open"),
    "createActionIntent",
  );
  const notificationDismiss = assertOk(
    host.createDismissIntent("route-notification"),
    "createDismissIntent",
  );
  const traySelect = assertOk(host.selectMenuItem("route-tray", "settings"), "selectMenuItem");
  const trayClick = assertOk(host.click("route-tray"), "click");
  const trayOpen = assertOk(host.openMenu("route-tray"), "openMenu");
  const dismissed = assertOk(host.dismiss(APP_ID, "route-notification"), "dismiss");

  assertNotificationIntent(notificationAction, {
    actionId: "open",
    appId: APP_ID,
    notificationId: "route-notification",
    type: "notification.action",
  });
  assertNotificationIntent(notificationDismiss, {
    appId: APP_ID,
    notificationId: "route-notification",
    type: "notification.dismiss",
  });
  assertTrayIntent(traySelect, {
    appId: APP_ID,
    itemId: "route-tray",
    menuItemId: "settings",
    path: ["settings"],
    type: "tray.menu.select",
  });
  assertTrayIntent(trayClick, {
    appId: APP_ID,
    itemId: "route-tray",
    type: "tray.click",
  });
  assertTrayIntent(trayOpen, {
    appId: APP_ID,
    itemId: "route-tray",
    type: "tray.menu.open",
  });
  assert.deepEqual(dismissed.map((notification) => notification.id), ["route-notification"]);
  assert.equal(host.snapshot().notifications.totalCount, 0);
});

function createBackend(
  grants: readonly ShellCapabilityGrant[],
  nowMs: () => number = () => 1_000,
): ShellNotificationsHost {
  return createShellNotificationsHost({
    capabilities: createStaticShellCapabilityPort(grants),
    clock: manualClock(nowMs),
  });
}

function manualClock(nowMs: () => number): NotificationClock {
  return Object.freeze({
    nowMs,
  });
}

function assertOk<T>(result: ShellResult<T>, label: string): T {
  if (!result.ok) {
    assert.fail(`expected ${label} to succeed: ${result.error.code}`);
  }

  return result.value;
}

function assertMissingCapability(result: ShellResult<unknown>): void {
  assert.equal(result.ok, false);
  if (result.ok) {
    assert.fail("expected missing capability to fail closed");
  }
  assert.equal(result.error.code, "MISSING_CAPABILITY");
}

function requireControl<T extends { readonly id: string }>(
  controls: readonly T[],
  id: string,
): T {
  for (let index = 0; index < controls.length; index += 1) {
    const control = controls[index];

    if (control !== undefined && control.id === id) return control;
  }

  assert.fail(`missing control ${id}`);
}

function assertNotificationIntent(actual: NotificationIntent, expected: NotificationIntent): void {
  assert.deepEqual(actual, expected);
}

function assertTrayIntent(actual: TrayIntent, expected: TrayIntent): void {
  assert.deepEqual(actual, expected);
}

function isShellNotificationWire(value: unknown): value is ShellNotification {
  const notification = jsonObject(value);

  return notification !== undefined &&
    typeof notification["appId"] === "string" &&
    typeof notification["id"] === "string" &&
    typeof notification["title"] === "string" &&
    isNotificationPriority(notification["priority"]) &&
    isFiniteNumber(notification["createdAtMs"]) &&
    isNotificationActionArray(notification["actions"]) &&
    optionalString(notification["body"]) &&
    (notification["expiresAtMs"] === undefined || isFiniteNumber(notification["expiresAtMs"]));
}

function isNotificationActionArray(value: unknown): boolean {
  if (!Array.isArray(value)) return false;

  for (let index = 0; index < value.length; index += 1) {
    const action = jsonObject(value[index]);

    if (
      action === undefined ||
      typeof action["id"] !== "string" ||
      typeof action["label"] !== "string" ||
      !isActionStyle(action["style"])
    ) {
      return false;
    }
  }

  return true;
}

function isTrayItemWire(value: unknown): value is TrayItem {
  const item = jsonObject(value);

  return item !== undefined &&
    typeof item["appId"] === "string" &&
    typeof item["id"] === "string" &&
    typeof item["iconRef"] === "string" &&
    typeof item["tooltip"] === "string" &&
    isFiniteNumber(item["order"]) &&
    isTrayMenuItemArray(item["menu"]) &&
    (
      item["status"] === undefined ||
      item["status"] === "ok" ||
      item["status"] === "warning" ||
      item["status"] === "critical" ||
      item["status"] === "offline"
    );
}

function isTrayMenuItemArray(value: unknown): boolean {
  if (!Array.isArray(value)) return false;

  for (let index = 0; index < value.length; index += 1) {
    const item = jsonObject(value[index]);

    if (
      item === undefined ||
      typeof item["id"] !== "string" ||
      typeof item["label"] !== "string" ||
      typeof item["enabled"] !== "boolean" ||
      !isTrayMenuItemArray(item["items"]) ||
      (item["checked"] !== undefined && typeof item["checked"] !== "boolean")
    ) {
      return false;
    }
  }

  return true;
}

function jsonObject(value: unknown): Readonly<Record<string, unknown>> | undefined {
  if (value === undefined || value === null || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }

  return value as Readonly<Record<string, unknown>>;
}

function optionalString(value: unknown): boolean {
  return value === undefined || typeof value === "string";
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isNotificationPriority(value: unknown): boolean {
  return value === "low" || value === "normal" || value === "high" || value === "urgent" || value === "critical";
}

function isActionStyle(value: unknown): boolean {
  return value === "default" || value === "primary" || value === "destructive";
}
