import type {
  NotificationCenter,
  NotificationPriority,
  ShellNotification,
  ShellResult,
  TrayIntent,
  TrayItem,
  TrayItemInput,
  TrayModel,
  TrayStatus,
} from "../../../sdk/typescript/src/desktop-sdk/index.ts";

export const DEFAULT_NOTIFICATION_CONTROL_APP_ID = "vita.desktop.notifications";
export const CONTROL_TOGGLE_MENU_ITEM_ID = "toggle";

export interface NotificationsControlDefinition {
  readonly id: string;
  readonly label: string;
  readonly iconRef: string;
  readonly appId?: string;
  readonly initialEnabled?: boolean;
  readonly order?: number;
  readonly statusWhenEnabled?: TrayStatus;
  readonly statusWhenDisabled?: TrayStatus;
  readonly tooltip?: string;
}

export interface NotificationsViewModelOptions {
  readonly notificationCenter: NotificationsNotificationPort;
  readonly trayModel: NotificationsTrayPort;
  readonly controlAppId?: string;
  readonly controls?: readonly NotificationsControlDefinition[];
}

export type NotificationsNotificationPort = Pick<NotificationCenter, "dismiss" | "snapshot">;
export type NotificationsTrayPort = Pick<TrayModel, "register" | "selectMenuItem" | "snapshot">;

export interface NotificationsViewNotification {
  readonly appId: string;
  readonly id: string;
  readonly title: string;
  readonly priority: NotificationPriority;
  readonly createdAtMs: number;
  readonly read: boolean;
  readonly actions: ShellNotification["actions"];
  readonly body?: string;
  readonly expiresAtMs?: number;
}

export interface NotificationsViewGroup {
  readonly appId: string;
  readonly count: number;
  readonly unreadCount: number;
  readonly latestCreatedAtMs: number;
  readonly notifications: readonly NotificationsViewNotification[];
}

export interface NotificationsControlState {
  readonly id: string;
  readonly appId: string;
  readonly label: string;
  readonly iconRef: string;
  readonly enabled: boolean;
  readonly available: boolean;
  readonly order: number;
  readonly tooltip: string;
  readonly status?: TrayStatus;
}

export interface NotificationsViewModelError {
  readonly code: string;
  readonly message: string;
  readonly path: string;
}

export interface NotificationsViewState {
  readonly notifications: readonly NotificationsViewNotification[];
  readonly groups: readonly NotificationsViewGroup[];
  readonly controls: readonly NotificationsControlState[];
  readonly unreadCount: number;
  readonly totalCount: number;
  readonly errors: readonly NotificationsViewModelError[];
}

export type NotificationsActionResult =
  | {
      readonly ok: true;
      readonly state: NotificationsViewState;
      readonly intent?: TrayIntent;
    }
  | {
      readonly ok: false;
      readonly error: NotificationsViewModelError;
      readonly state: NotificationsViewState;
      readonly intent?: TrayIntent;
    };

interface NormalizedControlDefinition {
  readonly id: string;
  readonly appId: string;
  readonly label: string;
  readonly iconRef: string;
  readonly initialEnabled: boolean;
  readonly order: number;
  readonly tooltip: string;
  readonly statusWhenEnabled?: TrayStatus;
  readonly statusWhenDisabled?: TrayStatus;
}

type PortCallResult<T> =
  | {
      readonly ok: true;
      readonly value: T;
    }
  | {
      readonly ok: false;
      readonly error: NotificationsViewModelError;
    };

export const DEFAULT_NOTIFICATION_CONTROLS = Object.freeze([
  Object.freeze({
    iconRef: "lucide:wifi",
    id: "wifi",
    initialEnabled: true,
    label: "Wi-Fi",
    order: 10,
    statusWhenEnabled: "ok",
    tooltip: "Wi-Fi",
  }),
  Object.freeze({
    iconRef: "lucide:bluetooth",
    id: "bluetooth",
    initialEnabled: false,
    label: "Bluetooth",
    order: 20,
    tooltip: "Bluetooth",
  }),
  Object.freeze({
    iconRef: "lucide:moon",
    id: "dnd",
    initialEnabled: false,
    label: "Do Not Disturb",
    order: 30,
    tooltip: "Do Not Disturb",
  }),
]) satisfies readonly NotificationsControlDefinition[];

const EMPTY_NOTIFICATIONS = Object.freeze([]) satisfies readonly NotificationsViewNotification[];
const EMPTY_GROUPS = Object.freeze([]) satisfies readonly NotificationsViewGroup[];
const EMPTY_CONTROLS = Object.freeze([]) satisfies readonly NotificationsControlState[];
const EMPTY_ERRORS = Object.freeze([]) satisfies readonly NotificationsViewModelError[];

export class NotificationsViewModel {
  readonly #notifications: NotificationsNotificationPort;
  readonly #tray: NotificationsTrayPort;
  readonly #controls: readonly NormalizedControlDefinition[];
  readonly #readKeys = new Set<string>();

  constructor(options: NotificationsViewModelOptions) {
    this.#notifications = options.notificationCenter;
    this.#tray = options.trayModel;
    this.#controls = normalizeControls(
      options.controls ?? DEFAULT_NOTIFICATION_CONTROLS,
      options.controlAppId ?? DEFAULT_NOTIFICATION_CONTROL_APP_ID,
    );

    this.#registerInitialControls();
  }

  state(): NotificationsViewState {
    return this.#stateWithErrors(EMPTY_ERRORS);
  }

  dismiss(notificationId: string): NotificationsActionResult {
    if (notificationId.length === 0) {
      return this.#failure(invalidInput("notification id must be a non-empty string.", "/notificationId"));
    }

    const dismissed = callPort(
      () => this.#notifications.dismiss(notificationId),
      "NOTIFICATION_PORT_FAILED",
      "notification dismiss failed closed.",
      "/notifications/dismiss",
    );

    if (!dismissed.ok) return this.#failure(dismissed.error);
    if (!dismissed.value.ok) return this.#failure(fromShellError(dismissed.value.error));

    this.#forgetReadNotifications(dismissed.value.value);
    return this.#success();
  }

  dismissAll(): NotificationsActionResult {
    const current = this.#readNotifications();

    if (!current.ok) return this.#failure(current.error);

    const notifications = current.value;

    for (let index = 0; index < notifications.length; index += 1) {
      const notification = notifications[index];

      if (notification === undefined) continue;

      const dismissed = callPort(
        () => this.#notifications.dismiss(notification.appId, notification.id),
        "NOTIFICATION_PORT_FAILED",
        "notification dismiss failed closed.",
        "/notifications/dismissAll",
      );

      if (!dismissed.ok) return this.#failure(dismissed.error);
      if (!dismissed.value.ok) return this.#failure(fromShellError(dismissed.value.error));
      this.#forgetReadNotifications(dismissed.value.value);
    }

    return this.#success();
  }

  markRead(notificationId: string): NotificationsActionResult {
    if (notificationId.length === 0) {
      return this.#failure(invalidInput("notification id must be a non-empty string.", "/notificationId"));
    }

    const current = this.#readNotifications();

    if (!current.ok) return this.#failure(current.error);

    let matched = false;

    for (let index = 0; index < current.value.length; index += 1) {
      const notification = current.value[index];

      if (notification === undefined || notification.id !== notificationId) continue;

      matched = true;
      this.#readKeys.add(notificationReadKey(notification));
    }

    if (!matched) {
      return this.#failure(Object.freeze({
        code: "UNKNOWN_NOTIFICATION",
        message: "notification is not present.",
        path: "/notificationId",
      }));
    }

    return this.#success();
  }

  toggle(controlId: string): NotificationsActionResult {
    if (controlId.length === 0) {
      return this.#failure(invalidInput("control id must be a non-empty string.", "/controlId"));
    }

    const control = this.#findControl(controlId);

    if (control === undefined) {
      return this.#failure(Object.freeze({
        code: "UNKNOWN_CONTROL",
        message: "control is not registered with this view-model.",
        path: "/controlId",
      }));
    }

    const trayItems = this.#readTrayItems();

    if (!trayItems.ok) return this.#failure(trayItems.error);

    const current = controlStateFromTrayItems(control, trayItems.value);
    let intent: TrayIntent | undefined;

    if (current.available) {
      const selected = callPort(
        () => this.#tray.selectMenuItem(control.id, CONTROL_TOGGLE_MENU_ITEM_ID),
        "TRAY_PORT_FAILED",
        "tray menu selection failed closed.",
        `/controls/${pathToken(control.id)}/toggle`,
      );

      if (!selected.ok) return this.#failure(selected.error);
      if (!selected.value.ok) return this.#failure(fromShellError(selected.value.error));
      intent = selected.value.value;
    }

    const registered = this.#registerControl(control, !current.enabled);

    if (!registered.ok) return this.#failure(registered.error, intent);
    if (!registered.value.ok) return this.#failure(fromShellError(registered.value.error), intent);

    return this.#success(intent);
  }

  #success(intent?: TrayIntent): NotificationsActionResult {
    const result: {
      ok: true;
      state: NotificationsViewState;
      intent?: TrayIntent;
    } = {
      ok: true,
      state: this.#stateWithErrors(EMPTY_ERRORS),
    };

    if (intent !== undefined) result.intent = intent;
    return Object.freeze(result);
  }

  #failure(error: NotificationsViewModelError, intent?: TrayIntent): NotificationsActionResult {
    const result: {
      ok: false;
      error: NotificationsViewModelError;
      state: NotificationsViewState;
      intent?: TrayIntent;
    } = {
      error,
      ok: false,
      state: this.#stateWithErrors(Object.freeze([error])),
    };

    if (intent !== undefined) result.intent = intent;
    return Object.freeze(result);
  }

  #stateWithErrors(extraErrors: readonly NotificationsViewModelError[]): NotificationsViewState {
    const notifications = this.#readNotifications();
    const trayItems = this.#readTrayItems();
    const errors: NotificationsViewModelError[] = [];

    appendErrors(errors, extraErrors);

    const notificationList = notifications.ok
      ? buildNotificationItems(notifications.value, this.#readKeys)
      : EMPTY_NOTIFICATIONS;

    if (!notifications.ok) errors.push(notifications.error);

    const controls = trayItems.ok
      ? buildControlStates(this.#controls, trayItems.value)
      : buildUnavailableControlStates(this.#controls);

    if (!trayItems.ok) errors.push(trayItems.error);

    const groups = notificationList.length === 0 ? EMPTY_GROUPS : groupNotificationItems(notificationList);

    return Object.freeze({
      controls,
      errors: errors.length === 0 ? EMPTY_ERRORS : Object.freeze(errors),
      groups,
      notifications: notificationList,
      totalCount: notificationList.length,
      unreadCount: countUnread(notificationList),
    });
  }

  #readNotifications(): PortCallResult<readonly ShellNotification[]> {
    const snapshot = callPort(
      () => this.#notifications.snapshot(),
      "NOTIFICATION_PORT_FAILED",
      "notification snapshot failed closed.",
      "/notifications/snapshot",
    );

    if (!snapshot.ok) return snapshot;
    return Object.freeze({
      ok: true,
      value: snapshot.value.notifications,
    });
  }

  #readTrayItems(): PortCallResult<readonly TrayItem[]> {
    const snapshot = callPort(
      () => this.#tray.snapshot(),
      "TRAY_PORT_FAILED",
      "tray snapshot failed closed.",
      "/tray/snapshot",
    );

    if (!snapshot.ok) return snapshot;
    return Object.freeze({
      ok: true,
      value: snapshot.value.items,
    });
  }

  #registerInitialControls(): void {
    for (let index = 0; index < this.#controls.length; index += 1) {
      const control = this.#controls[index];

      if (control !== undefined) {
        this.#registerControl(control, control.initialEnabled);
      }
    }
  }

  #registerControl(
    control: NormalizedControlDefinition,
    enabled: boolean,
  ): PortCallResult<ShellResult<TrayItem>> {
    return callPort(
      () => this.#tray.register(control.appId, trayInputForControl(control, enabled)),
      "TRAY_PORT_FAILED",
      "tray control registration failed closed.",
      `/controls/${pathToken(control.id)}`,
    );
  }

  #findControl(controlId: string): NormalizedControlDefinition | undefined {
    for (let index = 0; index < this.#controls.length; index += 1) {
      const control = this.#controls[index];

      if (control !== undefined && control.id === controlId) return control;
    }

    return undefined;
  }

  #forgetReadNotifications(notifications: readonly ShellNotification[]): void {
    for (let index = 0; index < notifications.length; index += 1) {
      const notification = notifications[index];

      if (notification !== undefined) {
        this.#readKeys.delete(notificationReadKey(notification));
      }
    }
  }
}

function normalizeControls(
  controls: readonly NotificationsControlDefinition[],
  defaultAppId: string,
): readonly NormalizedControlDefinition[] {
  const output: NormalizedControlDefinition[] = [];
  const seen = new Set<string>();

  for (let index = 0; index < controls.length; index += 1) {
    const control = controls[index];

    if (control === undefined || control.id.length === 0 || seen.has(control.id)) continue;
    seen.add(control.id);

    const normalized: {
      id: string;
      appId: string;
      label: string;
      iconRef: string;
      initialEnabled: boolean;
      order: number;
      tooltip: string;
      statusWhenEnabled?: TrayStatus;
      statusWhenDisabled?: TrayStatus;
    } = {
      appId: control.appId ?? defaultAppId,
      iconRef: control.iconRef,
      id: control.id,
      initialEnabled: control.initialEnabled === true,
      label: control.label,
      order: control.order ?? index,
      tooltip: control.tooltip ?? control.label,
    };

    if (control.statusWhenEnabled !== undefined) normalized.statusWhenEnabled = control.statusWhenEnabled;
    if (control.statusWhenDisabled !== undefined) normalized.statusWhenDisabled = control.statusWhenDisabled;
    output.push(Object.freeze(normalized));
  }

  output.sort(compareControls);
  return Object.freeze(output);
}

function buildNotificationItems(
  notifications: readonly ShellNotification[],
  readKeys: ReadonlySet<string>,
): readonly NotificationsViewNotification[] {
  if (notifications.length === 0) return EMPTY_NOTIFICATIONS;

  const output: NotificationsViewNotification[] = [];

  for (let index = 0; index < notifications.length; index += 1) {
    const notification = notifications[index];

    if (notification === undefined) continue;

    const item: {
      appId: string;
      id: string;
      title: string;
      priority: NotificationPriority;
      createdAtMs: number;
      read: boolean;
      actions: ShellNotification["actions"];
      body?: string;
      expiresAtMs?: number;
    } = {
      actions: notification.actions,
      appId: notification.appId,
      createdAtMs: notification.createdAtMs,
      id: notification.id,
      priority: notification.priority,
      read: readKeys.has(notificationReadKey(notification)),
      title: notification.title,
    };

    if (notification.body !== undefined) item.body = notification.body;
    if (notification.expiresAtMs !== undefined) item.expiresAtMs = notification.expiresAtMs;
    output.push(Object.freeze(item));
  }

  output.sort(compareNotificationItems);
  return Object.freeze(output);
}

function groupNotificationItems(
  notifications: readonly NotificationsViewNotification[],
): readonly NotificationsViewGroup[] {
  const appIds: string[] = [];
  const grouped = new Map<string, NotificationsViewNotification[]>();

  for (let index = 0; index < notifications.length; index += 1) {
    const notification = notifications[index];

    if (notification === undefined) continue;

    let group = grouped.get(notification.appId);

    if (group === undefined) {
      group = [];
      grouped.set(notification.appId, group);
      appIds.push(notification.appId);
    }

    group.push(notification);
  }

  const output: NotificationsViewGroup[] = [];

  for (let index = 0; index < appIds.length; index += 1) {
    const appId = appIds[index];

    if (appId === undefined) continue;

    const items = grouped.get(appId);

    if (items === undefined || items.length === 0) continue;

    items.sort(compareNotificationItems);
    const first = items[0];

    if (first === undefined) continue;

    output.push(Object.freeze({
      appId,
      count: items.length,
      latestCreatedAtMs: first.createdAtMs,
      notifications: Object.freeze([...items]),
      unreadCount: countUnread(items),
    }));
  }

  output.sort(compareGroups);
  return Object.freeze(output);
}

function buildControlStates(
  controls: readonly NormalizedControlDefinition[],
  trayItems: readonly TrayItem[],
): readonly NotificationsControlState[] {
  if (controls.length === 0) return EMPTY_CONTROLS;

  const output: NotificationsControlState[] = [];

  for (let index = 0; index < controls.length; index += 1) {
    const control = controls[index];

    if (control !== undefined) {
      output.push(controlStateFromTrayItems(control, trayItems));
    }
  }

  return Object.freeze(output);
}

function buildUnavailableControlStates(
  controls: readonly NormalizedControlDefinition[],
): readonly NotificationsControlState[] {
  if (controls.length === 0) return EMPTY_CONTROLS;

  const output: NotificationsControlState[] = [];

  for (let index = 0; index < controls.length; index += 1) {
    const control = controls[index];

    if (control !== undefined) {
      output.push(unavailableControlState(control));
    }
  }

  return Object.freeze(output);
}

function controlStateFromTrayItems(
  control: NormalizedControlDefinition,
  trayItems: readonly TrayItem[],
): NotificationsControlState {
  const item = findTrayItem(trayItems, control);
  const toggle = item === undefined ? undefined : findToggleMenuItem(item);

  if (item === undefined || toggle === undefined) return unavailableControlState(control);

  const output: {
    id: string;
    appId: string;
    label: string;
    iconRef: string;
    enabled: boolean;
    available: boolean;
    order: number;
    tooltip: string;
    status?: TrayStatus;
  } = {
    appId: control.appId,
    available: true,
    enabled: toggle.checked === true,
    iconRef: item.iconRef,
    id: control.id,
    label: control.label,
    order: item.order,
    tooltip: item.tooltip,
  };

  if (item.status !== undefined) output.status = item.status;
  return Object.freeze(output);
}

function unavailableControlState(control: NormalizedControlDefinition): NotificationsControlState {
  return Object.freeze({
    appId: control.appId,
    available: false,
    enabled: false,
    iconRef: control.iconRef,
    id: control.id,
    label: control.label,
    order: control.order,
    tooltip: control.tooltip,
  });
}

function trayInputForControl(control: NormalizedControlDefinition, enabled: boolean): TrayItemInput {
  const status = enabled ? control.statusWhenEnabled : control.statusWhenDisabled;
  const input: {
    id: string;
    iconRef: string;
    tooltip: string;
    order: number;
    menu: NonNullable<TrayItemInput["menu"]>;
    status?: TrayStatus;
  } = {
    iconRef: control.iconRef,
    id: control.id,
    menu: Object.freeze([
      Object.freeze({
        checked: enabled,
        enabled: true,
        id: CONTROL_TOGGLE_MENU_ITEM_ID,
        label: control.label,
      }),
    ]),
    order: control.order,
    tooltip: control.tooltip,
  };

  if (status !== undefined) input.status = status;
  return Object.freeze(input);
}

function findTrayItem(
  trayItems: readonly TrayItem[],
  control: NormalizedControlDefinition,
): TrayItem | undefined {
  for (let index = 0; index < trayItems.length; index += 1) {
    const item = trayItems[index];

    if (item !== undefined && item.id === control.id && item.appId === control.appId) {
      return item;
    }
  }

  return undefined;
}

function findToggleMenuItem(item: TrayItem): TrayItem["menu"][number] | undefined {
  for (let index = 0; index < item.menu.length; index += 1) {
    const menuItem = item.menu[index];

    if (menuItem !== undefined && menuItem.id === CONTROL_TOGGLE_MENU_ITEM_ID) {
      return menuItem;
    }
  }

  return undefined;
}

function countUnread(notifications: readonly NotificationsViewNotification[]): number {
  let count = 0;

  for (let index = 0; index < notifications.length; index += 1) {
    if (notifications[index]?.read === false) count += 1;
  }

  return count;
}

function appendErrors(
  output: NotificationsViewModelError[],
  errors: readonly NotificationsViewModelError[],
): void {
  for (let index = 0; index < errors.length; index += 1) {
    const error = errors[index];

    if (error !== undefined) output.push(error);
  }
}

function notificationReadKey(notification: ShellNotification): string {
  return `${notification.appId}\u0000${notification.id}\u0000${notification.createdAtMs}`;
}

function compareNotificationItems(
  left: NotificationsViewNotification,
  right: NotificationsViewNotification,
): number {
  const created = right.createdAtMs - left.createdAtMs;

  if (created !== 0) return created;

  const app = compareStrings(left.appId, right.appId);

  if (app !== 0) return app;

  return compareStrings(left.id, right.id);
}

function compareGroups(left: NotificationsViewGroup, right: NotificationsViewGroup): number {
  const created = right.latestCreatedAtMs - left.latestCreatedAtMs;

  if (created !== 0) return created;

  return compareStrings(left.appId, right.appId);
}

function compareControls(left: NormalizedControlDefinition, right: NormalizedControlDefinition): number {
  const order = left.order - right.order;

  if (order !== 0) return order;

  return compareStrings(left.id, right.id);
}

function compareStrings(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function callPort<T>(
  call: () => T,
  code: string,
  message: string,
  path: string,
): PortCallResult<T> {
  try {
    return Object.freeze({
      ok: true,
      value: call(),
    });
  } catch (error) {
    return Object.freeze({
      error: Object.freeze({
        code,
        message: errorMessage(error, message),
        path,
      }),
      ok: false,
    });
  }
}

function fromShellError(error: NotificationsViewModelError): NotificationsViewModelError {
  return Object.freeze({
    code: error.code,
    message: error.message,
    path: error.path,
  });
}

function invalidInput(message: string, path: string): NotificationsViewModelError {
  return Object.freeze({
    code: "INVALID_INPUT",
    message,
    path,
  });
}

function errorMessage(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message.length > 0) return error.message;

  return fallback;
}

function pathToken(value: string): string {
  return value.replaceAll("~", "~0").replaceAll("/", "~1");
}
