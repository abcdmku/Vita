import type {
  DesktopHost,
  NotificationCenterSnapshot,
  ShellNotification,
  ShellResult,
  TrayIntent,
  TrayItem,
  TrayItemInput,
  TrayMenuItem,
  TrayMenuItemInput,
  TrayModel,
  TraySnapshot,
} from "../../../sdk/typescript/src/desktop-sdk/index.ts";
import type {
  VitaActionContext,
  VitaListItem,
} from "../runtime/binder.ts";
import type {
  ScreenModule,
} from "../runtime/screen.ts";
import {
  NotificationsViewModel,
} from "../viewmodels/Notifications.ts";
import type {
  NotificationsNotificationPort,
  NotificationsTrayPort,
  NotificationsViewNotification,
  NotificationsViewState,
} from "../viewmodels/Notifications.ts";
import {
  datasetValue,
  optionalHostPort,
  shellAccept,
  shellReject,
  textListItem,
} from "./shared.ts";

export interface NotificationsScreenPorts {
  readonly notificationCenter: NotificationsNotificationPort;
  readonly trayModel: NotificationsTrayPort;
}

class NotificationsScreenViewModel {
  readonly #model: NotificationsViewModel;

  constructor(ports: NotificationsScreenPorts) {
    this.#model = new NotificationsViewModel({
      notificationCenter: ports.notificationCenter,
      trayModel: ports.trayModel,
    });
  }

  snapshot(): NotificationsViewState {
    return this.#model.state();
  }

  dismiss(id: string): void {
    this.#model.dismiss(id);
  }

  dismissAll(): void {
    this.#model.dismissAll();
  }

  markRead(id: string): void {
    this.#model.markRead(id);
  }

  toggle(id: string): void {
    this.#model.toggle(id);
  }
}

export const notificationsScreen = Object.freeze({
  actions: new Map<string, (viewModel: NotificationsScreenViewModel, context: VitaActionContext<NotificationsViewState>) => void>([
    ["notifications.dismiss", (viewModel, context) => {
      const id = datasetValue(context.target, Object.freeze(["vitaNotificationId"]));

      if (id !== undefined) viewModel.dismiss(id);
    }],
    ["notifications.dismissAll", (viewModel) => {
      viewModel.dismissAll();
    }],
    ["notifications.markRead", (viewModel, context) => {
      const id = datasetValue(context.target, Object.freeze(["vitaNotificationId"]));

      if (id !== undefined) viewModel.markRead(id);
    }],
    ["notifications.toggle", (viewModel, context) => {
      const id = datasetValue(context.target, Object.freeze(["vitaControlId"]));

      if (id !== undefined) viewModel.toggle(id);
    }],
  ]),
  binds: new Map<string, (snapshot: NotificationsViewState) => string | boolean | readonly VitaListItem[]>([
    ["notifications.unreadCount", (snapshot) => `${snapshot.unreadCount}`],
    ["notifications.totalCount", (snapshot) => `${snapshot.totalCount}`],
    ["notifications.hasNotifications", (snapshot) => snapshot.totalCount > 0],
    ["notifications.errors", (snapshot) => snapshot.errors.map((error, index) => textListItem({
      key: `error:${index}`,
      text: error.message,
    }))],
    ["notifications.controls", (snapshot) => snapshot.controls.map((control) => textListItem({
      action: "notifications.toggle",
      classes: Object.freeze([
        Object.freeze({
          className: "on",
          enabled: control.enabled,
        }),
        Object.freeze({
          className: "is-unavailable",
          enabled: !control.available,
        }),
      ]),
      data: Object.freeze([
        Object.freeze({
          name: "data-vita-control-id",
          value: control.id,
        }),
      ]),
      key: `control:${control.id}`,
      text: `${control.label} ${control.enabled ? "On" : "Off"}`,
    }))],
    ["notifications.items", (snapshot) => snapshot.notifications.map(notificationItem)],
  ]),
  createViewModel(ports: NotificationsScreenPorts): NotificationsScreenViewModel {
    return new NotificationsScreenViewModel(ports);
  },
  id: "desktop/notifications",
  selectPorts(host: DesktopHost): NotificationsScreenPorts {
    return Object.freeze({
      notificationCenter: optionalHostPort(host, "notificationCenter", isNotificationPort) ?? emptyNotificationCenter(),
      trayModel: optionalHostPort(host, "trayModel", isTrayPort) ?? new LocalTrayModel(),
    });
  },
}) satisfies ScreenModule<NotificationsViewState, NotificationsScreenPorts, NotificationsScreenViewModel>;

export default notificationsScreen;

class LocalTrayModel implements NotificationsTrayPort {
  readonly #items = new Map<string, TrayItem>();

  register(appId: string, input: TrayItemInput): ShellResult<TrayItem> {
    if (appId.length === 0 || input.id.length === 0) {
      return shellReject("INVALID_TRAY_ITEM", "tray item id is required.", "/tray/register");
    }

    const itemInput: {
      appId: string;
      iconRef: string;
      id: string;
      menu: readonly TrayMenuItem[];
      order: number;
      tooltip: string;
      status?: NonNullable<TrayItem["status"]>;
    } = {
      appId,
      iconRef: input.iconRef,
      id: input.id,
      menu: normalizeMenu(input.menu ?? Object.freeze([])),
      order: input.order ?? 0,
      tooltip: input.tooltip,
    };

    if (input.status !== undefined) itemInput.status = input.status;

    const item: TrayItem = Object.freeze(itemInput);

    this.#items.set(item.id, item);
    return shellAccept(item);
  }

  selectMenuItem(itemId: string, menuItemId: string): ShellResult<TrayIntent> {
    const item = this.#items.get(itemId);

    if (item === undefined) {
      return shellReject("UNKNOWN_TRAY_ITEM", "tray item is not registered.", "/tray/itemId");
    }

    const menuItem = findMenuItem(item.menu, menuItemId, Object.freeze([]));

    if (menuItem === undefined) {
      return shellReject("UNKNOWN_TRAY_MENU_ITEM", "tray menu item is not registered.", "/tray/menuItemId");
    }
    if (!menuItem.item.enabled) {
      return shellReject("DISABLED_TRAY_MENU_ITEM", "tray menu item is disabled.", "/tray/menuItemId");
    }

    return shellAccept(Object.freeze({
      appId: item.appId,
      itemId: item.id,
      menuItemId: menuItem.item.id,
      path: menuItem.path,
      type: "tray.menu.select",
    }));
  }

  snapshot(): TraySnapshot {
    return Object.freeze({
      items: Object.freeze([...this.#items.values()].sort(compareTrayItems)),
      totalCount: this.#items.size,
    });
  }
}

function notificationItem(notification: NotificationsViewNotification): VitaListItem {
  return textListItem({
    action: "notifications.markRead",
    classes: Object.freeze([
      Object.freeze({
        className: "is-read",
        enabled: notification.read,
      }),
    ]),
    data: Object.freeze([
      Object.freeze({
        name: "data-vita-notification-id",
        value: notification.id,
      }),
    ]),
    key: `notification:${notification.appId}:${notification.id}`,
    text: `${notification.appId}  ${notification.title}${notification.body === undefined ? "" : `  ${notification.body}`}`,
  });
}

function isNotificationPort(value: unknown): value is NotificationsNotificationPort {
  return value !== null &&
    typeof value === "object" &&
    typeof ownData(value, "dismiss") === "function" &&
    typeof ownData(value, "snapshot") === "function";
}

function isTrayPort(value: unknown): value is Pick<TrayModel, "register" | "selectMenuItem" | "snapshot"> {
  return value !== null &&
    typeof value === "object" &&
    typeof ownData(value, "register") === "function" &&
    typeof ownData(value, "selectMenuItem") === "function" &&
    typeof ownData(value, "snapshot") === "function";
}

function emptyNotificationCenter(): NotificationsNotificationPort {
  return Object.freeze({
    dismiss(): ShellResult<readonly ShellNotification[]> {
      return shellAccept(Object.freeze([]));
    },
    snapshot(): NotificationCenterSnapshot {
      return Object.freeze({
        groups: Object.freeze([]),
        maxVisible: 0,
        notifications: Object.freeze([]),
        overflow: Object.freeze([]),
        overflowCount: 0,
        totalCount: 0,
        visible: Object.freeze([]),
      });
    },
  });
}

function normalizeMenu(input: readonly TrayMenuItemInput[]): readonly TrayMenuItem[] {
  const output: TrayMenuItem[] = [];

  for (let index = 0; index < input.length; index += 1) {
    const item = input[index];

    if (item === undefined || item.id.length === 0) continue;

    const normalized: {
      id: string;
      label: string;
      enabled: boolean;
      items: readonly TrayMenuItem[];
      checked?: boolean;
    } = {
      enabled: item.enabled ?? true,
      id: item.id,
      items: normalizeMenu(item.items ?? Object.freeze([])),
      label: item.label,
    };

    if (item.checked !== undefined) normalized.checked = item.checked;
    output.push(Object.freeze(normalized));
  }

  return Object.freeze(output);
}

function findMenuItem(
  items: readonly TrayMenuItem[],
  id: string,
  path: readonly string[],
): {
  readonly item: TrayMenuItem;
  readonly path: readonly string[];
} | undefined {
  for (let index = 0; index < items.length; index += 1) {
    const item = items[index];

    if (item === undefined) continue;

    const nextPath = Object.freeze([...path, item.id]);

    if (item.id === id) {
      return Object.freeze({
        item,
        path: nextPath,
      });
    }

    const child = findMenuItem(item.items, id, nextPath);

    if (child !== undefined) return child;
  }

  return undefined;
}

function compareTrayItems(left: TrayItem, right: TrayItem): number {
  const order = left.order - right.order;

  if (order !== 0) return order;
  if (left.id < right.id) return -1;
  if (left.id > right.id) return 1;

  return 0;
}

function ownData(value: object, key: string): unknown {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);

    if (descriptor === undefined || !Object.prototype.hasOwnProperty.call(descriptor, "value")) {
      return undefined;
    }

    return descriptor.value;
  } catch {
    return undefined;
  }
}
