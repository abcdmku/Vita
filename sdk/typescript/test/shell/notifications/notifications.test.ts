import assert from "node:assert/strict";
import { test } from "node:test";

import {
  composeShellLayout,
  defineShellConfig,
} from "../../../src/shell/index.ts";
import {
  NOTIFICATION_PANEL_COMPONENT_ID,
  NOTIFICATION_TOAST_STACK_COMPONENT_ID,
  NotificationCenter,
  TRAY_PANEL_COMPONENT_ID,
  TrayModel,
  createShellNotificationsRegistry,
  createStaticShellCapabilityPort,
} from "../../../src/shell/notifications/index.ts";
import type {
  NotificationClock,
  ShellNotification,
  TrayItem,
} from "../../../src/shell/notifications/index.ts";

test("notification center posts through grants, orders by priority, groups by app, and emits shell surfaces", () => {
  let nowMs = 1_000;
  const center = new NotificationCenter({
    capabilities: createStaticShellCapabilityPort([
      {
        appId: "mail",
        capability: "shell.notifications.post",
      },
      {
        appId: "backup",
        capability: "shell.notifications.post",
      },
      {
        appId: "notes",
        capability: "shell.notifications.post",
      },
    ]),
    clock: manualClock(() => nowMs),
    maxVisible: 2,
  });

  assertPosted(center.post("mail", {
    actions: [
      {
        id: "open",
        label: "Open",
        style: "primary",
      },
      {
        id: "archive",
        label: "Archive",
      },
    ],
    body: "Older low-priority message",
    id: "mail-low",
    priority: "low",
    title: "Mail waiting",
  }));

  nowMs = 1_010;
  assertPosted(center.post("backup", {
    id: "backup-high",
    priority: "high",
    title: "Backup finished",
  }));

  nowMs = 1_020;
  assertPosted(center.post("mail", {
    id: "mail-urgent",
    priority: "urgent",
    title: "Urgent mail",
  }));

  nowMs = 1_030;
  assertPosted(center.post("notes", {
    id: "notes-normal",
    title: "Note synced",
  }));

  const snapshot = center.snapshot();

  assert.deepEqual(snapshot.notifications.map((notification) => notification.id), [
    "mail-urgent",
    "backup-high",
    "notes-normal",
    "mail-low",
  ]);
  assert.deepEqual(snapshot.visible.map((notification) => notification.id), [
    "mail-urgent",
    "backup-high",
  ]);
  assert.deepEqual(snapshot.overflow.map((notification) => notification.id), [
    "notes-normal",
    "mail-low",
  ]);
  assert.equal(snapshot.overflowCount, 2);
  assert.deepEqual(snapshot.groups.map((group) => ({
    appId: group.appId,
    count: group.count,
    topPriority: group.topPriority,
  })), [
    {
      appId: "mail",
      count: 2,
      topPriority: "urgent",
    },
    {
      appId: "backup",
      count: 1,
      topPriority: "high",
    },
    {
      appId: "notes",
      count: 1,
      topPriority: "normal",
    },
  ]);

  const mailLow = requireNotification(snapshot.notifications, "mail-low");

  assert.deepEqual(mailLow.actions, [
    {
      id: "open",
      label: "Open",
      style: "primary",
    },
    {
      id: "archive",
      label: "Archive",
      style: "default",
    },
  ]);

  const actionIntent = center.createActionIntent("mail-low", "open", "mail");

  assert.equal(actionIntent.ok, true);
  if (!actionIntent.ok) {
    assert.fail("expected notification action intent");
  }
  assert.deepEqual(actionIntent.value, {
    actionId: "open",
    appId: "mail",
    notificationId: "mail-low",
    type: "notification.action",
  });

  const registryResult = createShellNotificationsRegistry();

  assert.equal(registryResult.ok, true);
  if (!registryResult.ok) {
    assert.fail("expected shell notifications registry");
  }

  const layout = composeShellLayout(registryResult.value, defineShellConfig({
    id: "test.notifications.shell",
    render: () => center.panelElement({
      children: [
        center.toastStackElement({
          key: "toasts",
        }),
      ],
      key: "panel",
    }),
  }));

  assert.equal(layout.ok, true);
  if (!layout.ok) {
    assert.fail("expected notification shell layout");
  }

  assert.equal(layout.value.root.componentId, NOTIFICATION_PANEL_COMPONENT_ID);
  assert.equal(layout.value.root.payload["kind"], "shell.notifications.panel");
  assert.equal(layout.value.root.payload["totalCount"], 4);
  assert.equal(layout.value.root.payload["overflowCount"], 2);
  assert.deepEqual(jsonArrayIds(layout.value.root.payload["groups"], "appId"), [
    "mail",
    "backup",
    "notes",
  ]);
  assert.equal(layout.value.root.children[0]?.componentId, NOTIFICATION_TOAST_STACK_COMPONENT_ID);
  assert.deepEqual(jsonArrayIds(layout.value.root.children[0]?.payload["toasts"], "id"), [
    "mail-urgent",
    "backup-high",
  ]);
  assert.deepEqual(layout.value.surfaces.map((surface) => surface.id).sort(), [
    "surface:vita.shell.notifications.panel:0",
    "surface:vita.shell.notifications.toastStack:0.0-toasts",
  ]);
});

test("notification dismiss and expiry are deterministic through the injected clock", () => {
  let nowMs = 2_000;
  const center = new NotificationCenter({
    capabilities: createStaticShellCapabilityPort([
      {
        appId: "sync",
        capability: "shell.notifications.post",
      },
    ]),
    clock: manualClock(() => nowMs),
    maxVisible: 3,
  });

  assertPosted(center.post("sync", {
    id: "transient",
    title: "Transient",
    ttlMs: 500,
  }));

  nowMs = 2_100;
  assertPosted(center.post("sync", {
    id: "persistent",
    title: "Persistent",
  }));

  nowMs = 2_499;
  const beforeExpiry = center.expire();

  assert.equal(beforeExpiry.ok, true);
  if (!beforeExpiry.ok) {
    assert.fail("expected expiry check to succeed");
  }
  assert.deepEqual(beforeExpiry.value, []);
  assert.deepEqual(center.snapshot().notifications.map((notification) => notification.id), [
    "persistent",
    "transient",
  ]);

  nowMs = 2_500;
  const expired = center.expire();

  assert.equal(expired.ok, true);
  if (!expired.ok) {
    assert.fail("expected expiry to succeed");
  }
  assert.deepEqual(expired.value.map((notification) => notification.id), ["transient"]);
  assert.deepEqual(center.snapshot().notifications.map((notification) => notification.id), ["persistent"]);

  const dismissed = center.dismiss("sync", "persistent");

  assert.equal(dismissed.ok, true);
  if (!dismissed.ok) {
    assert.fail("expected dismiss to succeed");
  }
  assert.deepEqual(dismissed.value.map((notification) => notification.id), ["persistent"]);
  assert.equal(center.snapshot().totalCount, 0);
});

test("notification posting and tray registration fail closed without grants", () => {
  let clockReads = 0;
  const deniedNotifications = new NotificationCenter({
    capabilities: createStaticShellCapabilityPort([]),
    clock: {
      nowMs(): number {
        clockReads += 1;
        throw new Error("clock must not be read without a grant");
      },
    },
  });

  const deniedPost = deniedNotifications.post("mail", {
    id: "blocked",
    title: "Blocked",
  });

  assert.equal(deniedPost.ok, false);
  if (deniedPost.ok) {
    assert.fail("expected post to fail without grant");
  }
  assert.equal(deniedPost.error.code, "MISSING_CAPABILITY");
  assert.equal(deniedNotifications.snapshot().totalCount, 0);
  assert.equal(clockReads, 0);

  const deniedTray = new TrayModel();
  const deniedRegister = deniedTray.register("net", {
    iconRef: "wifi",
    id: "network",
    tooltip: "Network",
  });

  assert.equal(deniedRegister.ok, false);
  if (deniedRegister.ok) {
    assert.fail("expected tray registration to fail without grant");
  }
  assert.equal(deniedRegister.error.code, "MISSING_CAPABILITY");
  assert.deepEqual(deniedTray.snapshot().items, []);
});

test("tray model registers through grants, orders deterministically, and emits menu intents", () => {
  const tray = new TrayModel({
    capabilities: createStaticShellCapabilityPort([
      {
        appId: "net",
        capability: "shell.tray.register",
      },
      {
        appId: "power",
        capability: "shell.tray.register",
      },
      {
        appId: "sync",
        capability: "shell.tray.register",
      },
    ]),
  });

  assertRegistered(tray.register("sync", {
    iconRef: "sync.svg",
    id: "sync",
    menu: [
      {
        id: "pause",
        label: "Pause",
      },
      {
        enabled: false,
        id: "quit",
        label: "Quit",
      },
      {
        id: "settings",
        items: [
          {
            id: "advanced",
            label: "Advanced",
          },
        ],
        label: "Settings",
      },
    ],
    order: 20,
    status: "ok",
    tooltip: "Sync is current",
  }));
  assertRegistered(tray.register("power", {
    iconRef: "battery.svg",
    id: "battery",
    order: 10,
    status: "warning",
    tooltip: "Battery 42%",
  }));
  assertRegistered(tray.register("net", {
    iconRef: "wifi.svg",
    id: "network",
    menu: [
      {
        id: "network-settings",
        label: "Network settings",
      },
    ],
    order: 10,
    status: "ok",
    tooltip: "Online",
  }));

  assert.deepEqual(tray.snapshot().items.map((item) => item.id), [
    "network",
    "battery",
    "sync",
  ]);

  const click = tray.click("network");

  assert.equal(click.ok, true);
  if (!click.ok) {
    assert.fail("expected tray click intent");
  }
  assert.deepEqual(click.value, {
    appId: "net",
    itemId: "network",
    type: "tray.click",
  });

  const open = tray.openMenu("sync");

  assert.equal(open.ok, true);
  if (!open.ok) {
    assert.fail("expected tray menu open intent");
  }
  assert.deepEqual(open.value, {
    appId: "sync",
    itemId: "sync",
    type: "tray.menu.open",
  });

  const selectNested = tray.selectMenuItem("sync", "advanced");

  assert.equal(selectNested.ok, true);
  if (!selectNested.ok) {
    assert.fail("expected nested tray menu selection");
  }
  assert.deepEqual(selectNested.value, {
    appId: "sync",
    itemId: "sync",
    menuItemId: "advanced",
    path: ["settings", "advanced"],
    type: "tray.menu.select",
  });

  const disabled = tray.selectMenuItem("sync", "quit");

  assert.equal(disabled.ok, false);
  if (disabled.ok) {
    assert.fail("expected disabled tray menu item rejection");
  }
  assert.equal(disabled.error.code, "DISABLED_TRAY_MENU_ITEM");

  const registryResult = createShellNotificationsRegistry();

  assert.equal(registryResult.ok, true);
  if (!registryResult.ok) {
    assert.fail("expected shell notifications registry");
  }

  const layout = composeShellLayout(registryResult.value, defineShellConfig({
    id: "test.tray.shell",
    render: () => tray.panelElement({
      key: "tray",
    }),
  }));

  assert.equal(layout.ok, true);
  if (!layout.ok) {
    assert.fail("expected tray shell layout");
  }

  assert.equal(layout.value.root.componentId, TRAY_PANEL_COMPONENT_ID);
  assert.equal(layout.value.root.payload["kind"], "shell.tray.panel");
  assert.deepEqual(jsonArrayIds(layout.value.root.payload["items"], "id"), [
    "network",
    "battery",
    "sync",
  ]);

  const syncItem = jsonArrayItem(layout.value.root.payload["items"], "sync");
  const syncMenu = jsonArrayField(syncItem, "menu");

  assert.deepEqual(jsonArrayIds(syncMenu, "id"), ["pause", "quit", "settings"]);
  assert.equal(jsonObjectField(jsonArrayItem(syncMenu, "quit"), "selectIntent"), undefined);
});

test("model input boundaries reject malformed data without invoking accessors or iterators", () => {
  const center = new NotificationCenter({
    capabilities: createStaticShellCapabilityPort([
      {
        appId: "mail",
        capability: "shell.notifications.post",
      },
    ]),
    clock: manualClock(() => 3_000),
  });
  let getterReads = 0;
  const maliciousNotification: Record<string, unknown> = {
    title: "Accessor",
  };

  Object.defineProperty(maliciousNotification, "id", {
    enumerable: true,
    get(): never {
      getterReads += 1;
      throw new Error("getter must not run");
    },
  });

  const accessorRejected = center.post("mail", maliciousNotification);

  assert.equal(accessorRejected.ok, false);
  assert.equal(getterReads, 0);
  assert.equal(center.snapshot().totalCount, 0);

  const cyclicNotification: Record<string, unknown> = {
    id: "cyclic",
    title: "Cyclic",
  };

  cyclicNotification["self"] = cyclicNotification;

  const cyclicRejected = center.post("mail", cyclicNotification);

  assert.equal(cyclicRejected.ok, false);
  assert.equal(center.snapshot().totalCount, 0);

  const actionArray: unknown[] = [
    {
      id: "open",
      label: "Open",
    },
  ];

  Object.defineProperty(actionArray, "includes", {
    enumerable: true,
    value: () => true,
  });

  const methodShadowRejected = center.post("mail", {
    actions: actionArray,
    id: "shadow",
    title: "Shadowed methods",
  });

  assert.equal(methodShadowRejected.ok, false);
  assert.equal(center.snapshot().totalCount, 0);

  const tray = new TrayModel({
    capabilities: createStaticShellCapabilityPort([
      {
        appId: "net",
        capability: "shell.tray.register",
      },
    ]),
  });
  const cyclicTray: Record<string, unknown> = {
    iconRef: "wifi.svg",
    id: "network",
    tooltip: "Network",
  };

  cyclicTray["menu"] = [cyclicTray];

  const trayRejected = tray.register("net", cyclicTray);

  assert.equal(trayRejected.ok, false);
  assert.equal(tray.snapshot().totalCount, 0);
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

function assertRegistered(result: ReturnType<TrayModel["register"]>): TrayItem {
  if (!result.ok) {
    assert.fail(`expected tray registration to succeed: ${result.error.code}`);
  }

  assert.equal(result.ok, true);
  return result.value;
}

function requireNotification(
  notifications: readonly ShellNotification[],
  id: string,
): ShellNotification {
  for (let index = 0; index < notifications.length; index += 1) {
    const notification = notifications[index];

    if (notification !== undefined && notification.id === id) {
      return notification;
    }
  }

  assert.fail(`missing notification ${id}`);
}

function jsonArrayIds(value: unknown, key: string): readonly string[] {
  const items = jsonArrayFieldValue(value);
  const ids: string[] = [];

  for (let index = 0; index < items.length; index += 1) {
    const item = items[index];

    ids.push(jsonStringField(item, key));
  }

  return Object.freeze(ids);
}

function jsonArrayItem(value: unknown, id: string): Readonly<Record<string, unknown>> {
  const items = jsonArrayFieldValue(value);

  for (let index = 0; index < items.length; index += 1) {
    const item = items[index];

    if (jsonStringField(item, "id") === id) {
      return jsonObject(item);
    }
  }

  assert.fail(`missing item ${id}`);
}

function jsonArrayField(value: unknown, key: string): readonly unknown[] {
  return jsonArrayFieldValue(jsonObjectField(value, key));
}

function jsonObjectField(value: unknown, key: string): unknown {
  const object = jsonObject(value);

  return object[key];
}

function jsonStringField(value: unknown, key: string): string {
  const raw = jsonObjectField(value, key);

  if (typeof raw !== "string") {
    assert.fail(`expected string field ${key}`);
  }

  return raw;
}

function jsonArrayFieldValue(value: unknown): readonly unknown[] {
  assert.equal(Array.isArray(value), true);
  if (!Array.isArray(value)) {
    assert.fail("expected array");
  }

  return value;
}

function jsonObject(value: unknown): Readonly<Record<string, unknown>> {
  assert.equal(value !== null && typeof value === "object" && !Array.isArray(value), true);
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    assert.fail("expected object");
  }

  return value as Readonly<Record<string, unknown>>;
}
