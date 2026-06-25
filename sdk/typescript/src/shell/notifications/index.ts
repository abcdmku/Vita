import {
  ShellComponentRegistry,
  defineShellComponent,
  shellComponent,
  shellSurface,
} from "../index.ts";
import type {
  RegisteredShellComponent,
  ShellComponentDefinition,
  ShellElement,
  ShellPlacementInput,
  ShellResult,
} from "../index.ts";
import { safeNormalize } from "../../safe-normalize.ts";
import type { PlainJson, PlainJsonObject } from "../../safe-normalize.ts";

export const NOTIFICATION_PANEL_COMPONENT_ID = "vita.shell.notifications.panel";
export const NOTIFICATION_TOAST_STACK_COMPONENT_ID = "vita.shell.notifications.toastStack";
export const TRAY_PANEL_COMPONENT_ID = "vita.shell.tray.panel";

export const DEFAULT_NOTIFICATION_MAX_VISIBLE = 4;

export type ShellGrantCapability = "shell.notifications.post" | "shell.tray.register";
export type NotificationPriority = "low" | "normal" | "high" | "urgent" | "critical";
export type NotificationActionStyle = "default" | "primary" | "destructive";
export type TrayStatus = "ok" | "warning" | "critical" | "offline";

export interface ShellCapabilityRequest {
  readonly appId: string;
  readonly capability: ShellGrantCapability;
  readonly resourceId: string;
}

export interface ShellCapabilityPort {
  readonly hasGrant: (request: ShellCapabilityRequest) => boolean;
}

export interface ShellCapabilityGrant {
  readonly appId: string;
  readonly capability: ShellGrantCapability;
  readonly resourceId?: string;
}

export interface NotificationClock {
  readonly nowMs: number | (() => number);
}

export interface NotificationCenterOptions {
  readonly clock: NotificationClock;
  readonly capabilities?: ShellCapabilityPort;
  readonly maxVisible?: number;
}

export interface NotificationActionInput {
  readonly id: string;
  readonly label: string;
  readonly style?: NotificationActionStyle;
}

export interface NotificationAction {
  readonly id: string;
  readonly label: string;
  readonly style: NotificationActionStyle;
}

export interface NotificationPostInput {
  readonly id: string;
  readonly title: string;
  readonly body?: string;
  readonly priority?: NotificationPriority;
  readonly ttlMs?: number;
  readonly expiresAtMs?: number;
  readonly actions?: readonly NotificationActionInput[];
}

export interface ShellNotification {
  readonly appId: string;
  readonly id: string;
  readonly title: string;
  readonly priority: NotificationPriority;
  readonly createdAtMs: number;
  readonly actions: readonly NotificationAction[];
  readonly body?: string;
  readonly expiresAtMs?: number;
}

export interface NotificationGroup {
  readonly appId: string;
  readonly count: number;
  readonly topPriority: NotificationPriority;
  readonly latestCreatedAtMs: number;
  readonly notifications: readonly ShellNotification[];
}

export interface NotificationCenterSnapshot {
  readonly notifications: readonly ShellNotification[];
  readonly visible: readonly ShellNotification[];
  readonly overflow: readonly ShellNotification[];
  readonly groups: readonly NotificationGroup[];
  readonly overflowCount: number;
  readonly totalCount: number;
  readonly maxVisible: number;
}

export type NotificationIntent =
  | {
      readonly type: "notification.action";
      readonly appId: string;
      readonly notificationId: string;
      readonly actionId: string;
    }
  | {
      readonly type: "notification.dismiss";
      readonly appId: string;
      readonly notificationId: string;
    };

export interface TrayModelOptions {
  readonly capabilities?: ShellCapabilityPort;
}

export interface TrayMenuItemInput {
  readonly id: string;
  readonly label: string;
  readonly enabled?: boolean;
  readonly checked?: boolean;
  readonly items?: readonly TrayMenuItemInput[];
}

export interface TrayMenuItem {
  readonly id: string;
  readonly label: string;
  readonly enabled: boolean;
  readonly items: readonly TrayMenuItem[];
  readonly checked?: boolean;
}

export interface TrayItemInput {
  readonly id: string;
  readonly iconRef: string;
  readonly tooltip: string;
  readonly order?: number;
  readonly status?: TrayStatus;
  readonly menu?: readonly TrayMenuItemInput[];
}

export interface TrayItem {
  readonly appId: string;
  readonly id: string;
  readonly iconRef: string;
  readonly tooltip: string;
  readonly order: number;
  readonly menu: readonly TrayMenuItem[];
  readonly status?: TrayStatus;
}

export interface TraySnapshot {
  readonly items: readonly TrayItem[];
  readonly totalCount: number;
}

export type TrayIntent =
  | {
      readonly type: "tray.click";
      readonly appId: string;
      readonly itemId: string;
    }
  | {
      readonly type: "tray.menu.open";
      readonly appId: string;
      readonly itemId: string;
    }
  | {
      readonly type: "tray.menu.select";
      readonly appId: string;
      readonly itemId: string;
      readonly menuItemId: string;
      readonly path: readonly string[];
    };

export interface ShellNotificationsElementOptions {
  readonly key?: string;
  readonly role?: string;
  readonly className?: string;
  readonly placement?: ShellPlacementInput;
  readonly children?: readonly ShellElement[];
}

interface NormalizedNotificationPostInput {
  readonly id: string;
  readonly title: string;
  readonly priority: NotificationPriority;
  readonly actions: readonly NotificationAction[];
  readonly body?: string;
  readonly ttlMs?: number;
  readonly expiresAtMs?: number;
}

interface FoundMenuItem {
  readonly item: TrayMenuItem;
  readonly path: readonly string[];
}

const EMPTY_CHILDREN: readonly ShellElement[] = Object.freeze([]);
const EMPTY_ACTIONS: readonly NotificationAction[] = Object.freeze([]);
const EMPTY_NOTIFICATIONS: readonly ShellNotification[] = Object.freeze([]);
const EMPTY_GROUPS: readonly NotificationGroup[] = Object.freeze([]);
const EMPTY_TRAY_MENU: readonly TrayMenuItem[] = Object.freeze([]);
const EMPTY_TRAY_ITEMS: readonly TrayItem[] = Object.freeze([]);

export const notificationPanelComponent = defineShellComponent<PlainJsonObject>({
  defaultPlacement: {
    layer: "panel",
    order: 30,
    zone: "right",
  },
  id: NOTIFICATION_PANEL_COMPONENT_ID,
  render: (props) => shellSurface(notificationPanelPayloadFromProps(props), {
    className: "vita-notification-panel",
  }),
  role: "notification-panel",
});

export const notificationToastStackComponent = defineShellComponent<PlainJsonObject>({
  defaultPlacement: {
    layer: "overlay",
    order: 30,
    zone: "right",
  },
  id: NOTIFICATION_TOAST_STACK_COMPONENT_ID,
  render: (props) => shellSurface(notificationToastStackPayloadFromProps(props), {
    className: "vita-notification-toast-stack",
  }),
  role: "notification-toasts",
});

export const trayPanelComponent = defineShellComponent<PlainJsonObject>({
  defaultPlacement: {
    layer: "panel",
    order: 40,
    zone: "right",
  },
  id: TRAY_PANEL_COMPONENT_ID,
  render: (props) => shellSurface(trayPanelPayloadFromProps(props), {
    className: "vita-tray-panel",
  }),
  role: "tray",
});

export const shellNotificationsComponents = Object.freeze([
  notificationPanelComponent,
  notificationToastStackComponent,
  trayPanelComponent,
]) satisfies readonly ShellComponentDefinition<PlainJsonObject>[];

export class NotificationCenter {
  readonly #clock: NotificationClock;
  readonly #capabilities: ShellCapabilityPort | undefined;
  readonly #maxVisible: number;
  readonly #notifications = new Map<string, ShellNotification>();

  constructor(options: NotificationCenterOptions) {
    this.#clock = options.clock;
    this.#capabilities = options.capabilities;
    this.#maxVisible = normalizeMaxVisible(options.maxVisible);
  }

  post(appId: string, input: unknown): ShellResult<ShellNotification> {
    const normalized = normalizeNotificationPostInput(input);

    if (!normalized.ok) return normalized;

    const app = normalizeAppId(appId);

    if (!app.ok) return app;

    const authorized = authorizeCapability(this.#capabilities, {
      appId: app.value,
      capability: "shell.notifications.post",
      resourceId: normalized.value.id,
    });

    if (!authorized.ok) return authorized;

    const now = readClockMs(this.#clock);

    if (!now.ok) return now;

    const notification = buildNotification(app.value, normalized.value, now.value);

    this.#notifications.set(notificationStorageKey(notification.appId, notification.id), notification);
    return accept(notification);
  }

  dismiss(notificationId: string): ShellResult<readonly ShellNotification[]>;
  dismiss(appId: string, notificationId: string): ShellResult<readonly ShellNotification[]>;
  dismiss(first: string, second?: string): ShellResult<readonly ShellNotification[]> {
    const notificationId = second ?? first;
    const appId = second === undefined ? undefined : first;
    const id = normalizeId(notificationId, "/notificationId");

    if (!id.ok) return id;

    if (appId !== undefined) {
      const app = normalizeAppId(appId);

      if (!app.ok) return app;

      const key = notificationStorageKey(app.value, id.value);
      const existing = this.#notifications.get(key);

      if (existing === undefined) {
        return accept(EMPTY_NOTIFICATIONS);
      }

      this.#notifications.delete(key);
      return accept(Object.freeze([existing]));
    }

    const removed: ShellNotification[] = [];
    const keys = [...this.#notifications.keys()].sort(compareStrings);

    for (let index = 0; index < keys.length; index += 1) {
      const key = keys[index];

      if (key === undefined) continue;

      const notification = this.#notifications.get(key);

      if (notification !== undefined && notification.id === id.value) {
        removed.push(notification);
        this.#notifications.delete(key);
      }
    }

    removed.sort(compareNotifications);
    return accept(Object.freeze(removed));
  }

  expire(): ShellResult<readonly ShellNotification[]> {
    const now = readClockMs(this.#clock);

    if (!now.ok) return now;

    const expired: ShellNotification[] = [];
    const keys = [...this.#notifications.keys()].sort(compareStrings);

    for (let index = 0; index < keys.length; index += 1) {
      const key = keys[index];

      if (key === undefined) continue;

      const notification = this.#notifications.get(key);

      if (notification !== undefined && isExpired(notification, now.value)) {
        expired.push(notification);
        this.#notifications.delete(key);
      }
    }

    expired.sort(compareNotifications);
    return accept(Object.freeze(expired));
  }

  createActionIntent(notificationId: string, actionId: string, appId?: string): ShellResult<NotificationIntent> {
    const notification = this.findNotification(notificationId, appId);

    if (!notification.ok) return notification;

    const action = findNotificationAction(notification.value, actionId);

    if (action === undefined) {
      return reject("UNKNOWN_NOTIFICATION_ACTION", "notification action is not registered.", "/actionId");
    }

    return accept(Object.freeze({
      actionId: action.id,
      appId: notification.value.appId,
      notificationId: notification.value.id,
      type: "notification.action",
    }));
  }

  createDismissIntent(notificationId: string, appId?: string): ShellResult<NotificationIntent> {
    const notification = this.findNotification(notificationId, appId);

    if (!notification.ok) return notification;

    return accept(Object.freeze({
      appId: notification.value.appId,
      notificationId: notification.value.id,
      type: "notification.dismiss",
    }));
  }

  snapshot(): NotificationCenterSnapshot {
    return snapshotNotifications([...this.#notifications.values()], this.#maxVisible);
  }

  panelElement(options: ShellNotificationsElementOptions = Object.freeze({})): ShellElement {
    return notificationPanelElement(this.snapshot(), options);
  }

  toastStackElement(options: ShellNotificationsElementOptions = Object.freeze({})): ShellElement {
    return notificationToastStackElement(this.snapshot(), options);
  }

  surfaceElements(options: {
    readonly panel?: ShellNotificationsElementOptions;
    readonly toastStack?: ShellNotificationsElementOptions;
  } = Object.freeze({})): {
    readonly panel: ShellElement;
    readonly toastStack: ShellElement;
  } {
    const snapshot = this.snapshot();

    return Object.freeze({
      panel: notificationPanelElement(snapshot, options.panel),
      toastStack: notificationToastStackElement(snapshot, options.toastStack),
    });
  }

  private findNotification(notificationId: string, appId: string | undefined): ShellResult<ShellNotification> {
    const id = normalizeId(notificationId, "/notificationId");

    if (!id.ok) return id;

    if (appId !== undefined) {
      const app = normalizeAppId(appId);

      if (!app.ok) return app;

      const notification = this.#notifications.get(notificationStorageKey(app.value, id.value));

      if (notification !== undefined) return accept(notification);
      return reject("UNKNOWN_NOTIFICATION", "notification is not registered.", "/notificationId");
    }

    const notifications = this.snapshot().notifications;

    for (let index = 0; index < notifications.length; index += 1) {
      const notification = notifications[index];

      if (notification !== undefined && notification.id === id.value) {
        return accept(notification);
      }
    }

    return reject("UNKNOWN_NOTIFICATION", "notification is not registered.", "/notificationId");
  }
}

export class TrayModel {
  readonly #capabilities: ShellCapabilityPort | undefined;
  readonly #items = new Map<string, TrayItem>();

  constructor(options: TrayModelOptions = Object.freeze({})) {
    this.#capabilities = options.capabilities;
  }

  register(appId: string, input: unknown): ShellResult<TrayItem> {
    const normalized = normalizeTrayItemInput(input);

    if (!normalized.ok) return normalized;

    const app = normalizeAppId(appId);

    if (!app.ok) return app;

    const authorized = authorizeCapability(this.#capabilities, {
      appId: app.value,
      capability: "shell.tray.register",
      resourceId: normalized.value.id,
    });

    if (!authorized.ok) return authorized;

    const existing = this.#items.get(normalized.value.id);

    if (existing !== undefined && existing.appId !== app.value) {
      return reject("TRAY_ITEM_OWNED", "tray item id is already registered by another app.", "/id");
    }

    const itemInput: {
      appId: string;
      iconRef: string;
      id: string;
      menu: readonly TrayMenuItem[];
      order: number;
      tooltip: string;
      status?: TrayStatus;
    } = {
      appId: app.value,
      iconRef: normalized.value.iconRef,
      id: normalized.value.id,
      menu: normalized.value.menu,
      order: normalized.value.order,
      tooltip: normalized.value.tooltip,
    };

    if (normalized.value.status !== undefined) itemInput.status = normalized.value.status;

    const item = freezeTrayItem(itemInput);

    this.#items.set(item.id, item);
    return accept(item);
  }

  unregister(appId: string, itemId: string): ShellResult<TrayItem | null> {
    const app = normalizeAppId(appId);

    if (!app.ok) return app;

    const id = normalizeId(itemId, "/itemId");

    if (!id.ok) return id;

    const existing = this.#items.get(id.value);

    if (existing === undefined || existing.appId !== app.value) {
      return accept(null);
    }

    this.#items.delete(id.value);
    return accept(existing);
  }

  click(itemId: string): ShellResult<TrayIntent> {
    const item = this.findItem(itemId);

    if (!item.ok) return item;

    return accept(trayClickIntent(item.value));
  }

  openMenu(itemId: string): ShellResult<TrayIntent> {
    const item = this.findItem(itemId);

    if (!item.ok) return item;

    return accept(trayOpenMenuIntent(item.value));
  }

  selectMenuItem(itemId: string, menuItemId: string): ShellResult<TrayIntent> {
    const item = this.findItem(itemId);

    if (!item.ok) return item;

    const id = normalizeId(menuItemId, "/menuItemId");

    if (!id.ok) return id;

    const found = findTrayMenuItem(item.value.menu, id.value, Object.freeze([]));

    if (found === undefined) {
      return reject("UNKNOWN_TRAY_MENU_ITEM", "tray menu item is not registered.", "/menuItemId");
    }

    if (!found.item.enabled) {
      return reject("DISABLED_TRAY_MENU_ITEM", "tray menu item is disabled.", "/menuItemId");
    }

    return accept(Object.freeze({
      appId: item.value.appId,
      itemId: item.value.id,
      menuItemId: found.item.id,
      path: found.path,
      type: "tray.menu.select",
    }));
  }

  snapshot(): TraySnapshot {
    const items = [...this.#items.values()].map(freezeTrayItem).sort(compareTrayItems);

    return Object.freeze({
      items: Object.freeze(items),
      totalCount: items.length,
    });
  }

  panelElement(options: ShellNotificationsElementOptions = Object.freeze({})): ShellElement {
    return trayPanelElement(this.snapshot(), options);
  }

  private findItem(itemId: string): ShellResult<TrayItem> {
    const id = normalizeId(itemId, "/itemId");

    if (!id.ok) return id;

    const item = this.#items.get(id.value);

    if (item === undefined) {
      return reject("UNKNOWN_TRAY_ITEM", "tray item is not registered.", "/itemId");
    }

    return accept(item);
  }
}

export function createStaticShellCapabilityPort(
  grants: readonly ShellCapabilityGrant[],
): ShellCapabilityPort {
  const granted = new Set<string>();

  for (let index = 0; index < grants.length; index += 1) {
    const grant = grants[index];

    if (grant === undefined || grant.appId.length === 0) continue;

    granted.add(grantKey(grant.appId, grant.capability, grant.resourceId));
  }

  return Object.freeze({
    hasGrant(request: ShellCapabilityRequest): boolean {
      return (
        granted.has(grantKey(request.appId, request.capability, request.resourceId)) ||
        granted.has(grantKey(request.appId, request.capability, undefined))
      );
    },
  });
}

export function registerShellNotificationsComponents(
  registry: ShellComponentRegistry,
): ShellResult<readonly RegisteredShellComponent[]> {
  const existing = registry.list();

  for (let index = 0; index < shellNotificationsComponents.length; index += 1) {
    const definition = shellNotificationsComponents[index];

    if (definition !== undefined && hasRegisteredComponent(existing, definition.id)) {
      return reject(
        "DUPLICATE_COMPONENT",
        `Shell component '${definition.id}' is already registered.`,
        "/id",
      );
    }
  }

  const registered: RegisteredShellComponent[] = [];

  for (let index = 0; index < shellNotificationsComponents.length; index += 1) {
    const definition = shellNotificationsComponents[index];

    if (definition === undefined) {
      return reject("INVALID_COMPONENT", `component definition ${index} is missing.`, `/components/${index}`);
    }

    const result = registry.register(definition);

    if (!result.ok) return result;
    registered.push(result.value);
  }

  return accept(Object.freeze(registered));
}

export function createShellNotificationsRegistry(): ShellResult<ShellComponentRegistry> {
  const registry = new ShellComponentRegistry();
  const registered = registerShellNotificationsComponents(registry);

  if (!registered.ok) return registered;
  return accept(registry);
}

export function notificationPanelElement(
  state: NotificationCenterSnapshot,
  options: ShellNotificationsElementOptions = Object.freeze({}),
): ShellElement {
  return shellComponent(NOTIFICATION_PANEL_COMPONENT_ID, shellElementOptions({
    children: options.children,
    className: options.className,
    key: options.key,
    placement: options.placement,
    props: notificationPanelProps(state),
    role: options.role,
  }));
}

export function notificationToastStackElement(
  state: NotificationCenterSnapshot,
  options: ShellNotificationsElementOptions = Object.freeze({}),
): ShellElement {
  return shellComponent(NOTIFICATION_TOAST_STACK_COMPONENT_ID, shellElementOptions({
    children: options.children,
    className: options.className,
    key: options.key,
    placement: options.placement,
    props: notificationToastStackProps(state),
    role: options.role,
  }));
}

export function trayPanelElement(
  state: TraySnapshot,
  options: ShellNotificationsElementOptions = Object.freeze({}),
): ShellElement {
  return shellComponent(TRAY_PANEL_COMPONENT_ID, shellElementOptions({
    children: options.children,
    className: options.className,
    key: options.key,
    placement: options.placement,
    props: trayPanelProps(state),
    role: options.role,
  }));
}

export function notificationPanelProps(state: NotificationCenterSnapshot): PlainJsonObject {
  return Object.freeze({
    groups: notificationGroupsPayload(state.groups),
    maxVisible: state.maxVisible,
    overflowCount: state.overflowCount,
    totalCount: state.totalCount,
  });
}

export function notificationToastStackProps(state: NotificationCenterSnapshot): PlainJsonObject {
  return Object.freeze({
    maxVisible: state.maxVisible,
    overflowCount: state.overflowCount,
    toasts: notificationsPayload(state.visible),
    totalCount: state.totalCount,
  });
}

export function trayPanelProps(state: TraySnapshot): PlainJsonObject {
  return Object.freeze({
    items: trayItemsPayload(state.items),
    totalCount: state.totalCount,
  });
}

function notificationPanelPayloadFromProps(props: PlainJsonObject): PlainJsonObject {
  return Object.freeze({
    groups: readJsonArray(props["groups"]),
    kind: "shell.notifications.panel",
    maxVisible: normalizeCount(props["maxVisible"]),
    overflowCount: normalizeCount(props["overflowCount"]),
    totalCount: normalizeCount(props["totalCount"]),
  });
}

function notificationToastStackPayloadFromProps(props: PlainJsonObject): PlainJsonObject {
  return Object.freeze({
    kind: "shell.notifications.toastStack",
    maxVisible: normalizeCount(props["maxVisible"]),
    overflowCount: normalizeCount(props["overflowCount"]),
    toasts: readJsonArray(props["toasts"]),
    totalCount: normalizeCount(props["totalCount"]),
  });
}

function trayPanelPayloadFromProps(props: PlainJsonObject): PlainJsonObject {
  return Object.freeze({
    items: readJsonArray(props["items"]),
    kind: "shell.tray.panel",
    totalCount: normalizeCount(props["totalCount"]),
  });
}

function shellElementOptions(input: {
  readonly props: PlainJsonObject;
  readonly key?: string | undefined;
  readonly role?: string | undefined;
  readonly className?: string | undefined;
  readonly placement?: ShellPlacementInput | undefined;
  readonly children?: readonly ShellElement[] | undefined;
}): {
  readonly props: PlainJsonObject;
  readonly key?: string;
  readonly role?: string;
  readonly className?: string;
  readonly placement?: ShellPlacementInput;
  readonly children: readonly ShellElement[];
} {
  const output: {
    props: PlainJsonObject;
    children: readonly ShellElement[];
    key?: string;
    role?: string;
    className?: string;
    placement?: ShellPlacementInput;
  } = {
    children: input.children ?? EMPTY_CHILDREN,
    props: input.props,
  };

  if (input.key !== undefined) output.key = input.key;
  if (input.role !== undefined) output.role = input.role;
  if (input.className !== undefined) output.className = input.className;
  if (input.placement !== undefined) output.placement = input.placement;

  return Object.freeze(output);
}

function normalizeNotificationPostInput(input: unknown): ShellResult<NormalizedNotificationPostInput> {
  const normalized = normalizePlainObject(input, "/notification");

  if (!normalized.ok) return normalized;

  const fields = expectFields(
    normalized.value,
    Object.freeze(["id", "title"]),
    Object.freeze(["body", "priority", "ttlMs", "expiresAtMs", "actions"]),
    "/notification",
  );

  if (!fields.ok) return fields;

  const id = requiredString(normalized.value, "id", "/notification/id");

  if (!id.ok) return id;

  const title = requiredString(normalized.value, "title", "/notification/title");

  if (!title.ok) return title;

  const priority = normalizePriority(field(normalized.value, "priority"), "/notification/priority");

  if (!priority.ok) return priority;

  const actions = normalizeNotificationActions(field(normalized.value, "actions"));

  if (!actions.ok) return actions;

  const output: {
    id: string;
    title: string;
    priority: NotificationPriority;
    actions: readonly NotificationAction[];
    body?: string;
    ttlMs?: number;
    expiresAtMs?: number;
  } = {
    actions: actions.value,
    id: id.value,
    priority: priority.value,
    title: title.value,
  };

  const body = optionalString(field(normalized.value, "body"), "/notification/body");

  if (!body.ok) return body;
  if (body.value !== undefined) output.body = body.value;

  const ttlMs = optionalPositiveInteger(field(normalized.value, "ttlMs"), "/notification/ttlMs");

  if (!ttlMs.ok) return ttlMs;
  if (ttlMs.value !== undefined) output.ttlMs = ttlMs.value;

  const expiresAtMs = optionalTimestamp(field(normalized.value, "expiresAtMs"), "/notification/expiresAtMs");

  if (!expiresAtMs.ok) return expiresAtMs;
  if (expiresAtMs.value !== undefined) output.expiresAtMs = expiresAtMs.value;

  return accept(Object.freeze(output));
}

function normalizeNotificationActions(value: PlainJson | undefined): ShellResult<readonly NotificationAction[]> {
  if (value === undefined) return accept(EMPTY_ACTIONS);
  if (!Array.isArray(value)) {
    return reject("INVALID_NOTIFICATION_ACTIONS", "notification actions must be an array.", "/notification/actions");
  }

  const actions: NotificationAction[] = [];
  const seen = new Set<string>();

  for (let index = 0; index < value.length; index += 1) {
    const item = value[index];

    if (!isPlainJsonObject(item)) {
      return reject("INVALID_NOTIFICATION_ACTION", "notification action must be an object.", `/notification/actions/${index}`);
    }

    const fields = expectFields(
      item,
      Object.freeze(["id", "label"]),
      Object.freeze(["style"]),
      `/notification/actions/${index}`,
    );

    if (!fields.ok) return fields;

    const id = requiredString(item, "id", `/notification/actions/${index}/id`);

    if (!id.ok) return id;

    if (seen.has(id.value)) {
      return reject("DUPLICATE_NOTIFICATION_ACTION", "notification action ids must be unique.", `/notification/actions/${index}/id`);
    }

    seen.add(id.value);

    const label = requiredString(item, "label", `/notification/actions/${index}/label`);

    if (!label.ok) return label;

    const style = normalizeActionStyle(field(item, "style"), `/notification/actions/${index}/style`);

    if (!style.ok) return style;

    actions.push(Object.freeze({
      id: id.value,
      label: label.value,
      style: style.value,
    }));
  }

  return accept(Object.freeze(actions));
}

function buildNotification(
  appId: string,
  input: NormalizedNotificationPostInput,
  nowMs: number,
): ShellNotification {
  const output: {
    appId: string;
    id: string;
    title: string;
    priority: NotificationPriority;
    createdAtMs: number;
    actions: readonly NotificationAction[];
    body?: string;
    expiresAtMs?: number;
  } = {
    actions: input.actions,
    appId,
    createdAtMs: nowMs,
    id: input.id,
    priority: input.priority,
    title: input.title,
  };

  if (input.body !== undefined) output.body = input.body;
  if (input.expiresAtMs !== undefined) {
    output.expiresAtMs = input.expiresAtMs;
  } else if (input.ttlMs !== undefined) {
    output.expiresAtMs = nowMs + input.ttlMs;
  }

  return freezeNotification(output);
}

function snapshotNotifications(
  input: readonly ShellNotification[],
  maxVisible: number,
): NotificationCenterSnapshot {
  const notifications = [...input].map(freezeNotification).sort(compareNotifications);
  const visible = Object.freeze(notifications.slice(0, maxVisible));
  const overflow = Object.freeze(notifications.slice(maxVisible));

  return Object.freeze({
    groups: groupNotifications(notifications),
    maxVisible,
    notifications: Object.freeze(notifications),
    overflow,
    overflowCount: overflow.length,
    totalCount: notifications.length,
    visible,
  });
}

function groupNotifications(notifications: readonly ShellNotification[]): readonly NotificationGroup[] {
  if (notifications.length === 0) return EMPTY_GROUPS;

  const appIds: string[] = [];
  const grouped = new Map<string, ShellNotification[]>();

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

  const groups: NotificationGroup[] = [];

  for (let index = 0; index < appIds.length; index += 1) {
    const appId = appIds[index];

    if (appId === undefined) continue;

    const groupNotificationsForApp = grouped.get(appId);

    if (groupNotificationsForApp === undefined || groupNotificationsForApp.length === 0) continue;

    const sorted = Object.freeze([...groupNotificationsForApp].sort(compareNotifications));
    const top = sorted[0];

    if (top === undefined) continue;

    groups.push(Object.freeze({
      appId,
      count: sorted.length,
      latestCreatedAtMs: latestNotificationCreatedAt(sorted),
      notifications: sorted,
      topPriority: top.priority,
    }));
  }

  return Object.freeze(groups);
}

function latestNotificationCreatedAt(notifications: readonly ShellNotification[]): number {
  let latest = 0;

  for (let index = 0; index < notifications.length; index += 1) {
    const notification = notifications[index];

    if (notification !== undefined && notification.createdAtMs > latest) {
      latest = notification.createdAtMs;
    }
  }

  return latest;
}

function normalizeTrayItemInput(input: unknown): ShellResult<TrayItem> {
  const normalized = normalizePlainObject(input, "/trayItem");

  if (!normalized.ok) return normalized;

  const fields = expectFields(
    normalized.value,
    Object.freeze(["id", "iconRef", "tooltip"]),
    Object.freeze(["order", "status", "menu"]),
    "/trayItem",
  );

  if (!fields.ok) return fields;

  const id = requiredString(normalized.value, "id", "/trayItem/id");

  if (!id.ok) return id;

  const iconRef = requiredString(normalized.value, "iconRef", "/trayItem/iconRef");

  if (!iconRef.ok) return iconRef;

  const tooltip = requiredString(normalized.value, "tooltip", "/trayItem/tooltip");

  if (!tooltip.ok) return tooltip;

  const order = optionalInteger(field(normalized.value, "order"), "/trayItem/order");

  if (!order.ok) return order;

  const status = normalizeTrayStatus(field(normalized.value, "status"), "/trayItem/status");

  if (!status.ok) return status;

  const menu = normalizeTrayMenu(field(normalized.value, "menu"));

  if (!menu.ok) return menu;

  const output: {
    appId: string;
    id: string;
    iconRef: string;
    tooltip: string;
    order: number;
    menu: readonly TrayMenuItem[];
    status?: TrayStatus;
  } = {
    appId: "",
    iconRef: iconRef.value,
    id: id.value,
    menu: menu.value,
    order: order.value ?? 0,
    tooltip: tooltip.value,
  };

  if (status.value !== undefined) output.status = status.value;

  return accept(freezeTrayItem(output));
}

function normalizeTrayMenu(value: PlainJson | undefined): ShellResult<readonly TrayMenuItem[]> {
  if (value === undefined) return accept(EMPTY_TRAY_MENU);
  if (!Array.isArray(value)) {
    return reject("INVALID_TRAY_MENU", "tray menu must be an array.", "/trayItem/menu");
  }

  return normalizeTrayMenuItems(value, "/trayItem/menu", new Set<string>());
}

function normalizeTrayMenuItems(
  values: readonly PlainJson[],
  path: string,
  seen: Set<string>,
): ShellResult<readonly TrayMenuItem[]> {
  const output: TrayMenuItem[] = [];

  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];

    if (!isPlainJsonObject(value)) {
      return reject("INVALID_TRAY_MENU_ITEM", "tray menu item must be an object.", `${path}/${index}`);
    }

    const fields = expectFields(
      value,
      Object.freeze(["id", "label"]),
      Object.freeze(["enabled", "checked", "items"]),
      `${path}/${index}`,
    );

    if (!fields.ok) return fields;

    const id = requiredString(value, "id", `${path}/${index}/id`);

    if (!id.ok) return id;

    if (seen.has(id.value)) {
      return reject("DUPLICATE_TRAY_MENU_ITEM", "tray menu item ids must be unique.", `${path}/${index}/id`);
    }

    seen.add(id.value);

    const label = requiredString(value, "label", `${path}/${index}/label`);

    if (!label.ok) return label;

    const enabled = optionalBoolean(field(value, "enabled"), true, `${path}/${index}/enabled`);

    if (!enabled.ok) return enabled;

    const checked = optionalBooleanValue(field(value, "checked"), `${path}/${index}/checked`);

    if (!checked.ok) return checked;

    const childrenValue = field(value, "items");
    let children: readonly TrayMenuItem[] = EMPTY_TRAY_MENU;

    if (childrenValue !== undefined) {
      if (!Array.isArray(childrenValue)) {
        return reject("INVALID_TRAY_MENU_ITEM", "tray menu item children must be an array.", `${path}/${index}/items`);
      }

      const childResult = normalizeTrayMenuItems(childrenValue, `${path}/${index}/items`, seen);

      if (!childResult.ok) return childResult;
      children = childResult.value;
    }

    const item: {
      id: string;
      label: string;
      enabled: boolean;
      items: readonly TrayMenuItem[];
      checked?: boolean;
    } = {
      enabled: enabled.value,
      id: id.value,
      items: children,
      label: label.value,
    };

    if (checked.value !== undefined) item.checked = checked.value;
    output.push(Object.freeze(item));
  }

  return accept(Object.freeze(output));
}

function findTrayMenuItem(
  items: readonly TrayMenuItem[],
  menuItemId: string,
  path: readonly string[],
): FoundMenuItem | undefined {
  for (let index = 0; index < items.length; index += 1) {
    const item = items[index];

    if (item === undefined) continue;

    const nextPath = Object.freeze([...path, item.id]);

    if (item.id === menuItemId) {
      return Object.freeze({
        item,
        path: nextPath,
      });
    }

    const child = findTrayMenuItem(item.items, menuItemId, nextPath);

    if (child !== undefined) return child;
  }

  return undefined;
}

function normalizePlainObject(input: unknown, path: string): ShellResult<PlainJsonObject> {
  const normalized = safeNormalize(input);

  if (!normalized.ok) {
    return reject("INVALID_JSON_SHAPE", normalized.reason, path);
  }

  if (!isPlainJsonObject(normalized.value)) {
    return reject("INVALID_OBJECT", "value must be a plain object.", path);
  }

  return accept(normalized.value);
}

function expectFields(
  value: PlainJsonObject,
  required: readonly string[],
  optional: readonly string[],
  path: string,
): ShellResult<true> {
  const keys = Object.keys(value);

  for (let index = 0; index < keys.length; index += 1) {
    const key = keys[index];

    if (key === undefined || (!contains(required, key) && !contains(optional, key))) {
      return reject("UNEXPECTED_FIELD", `${key ?? "field"} is not an expected field.`, path);
    }
  }

  for (let index = 0; index < required.length; index += 1) {
    const key = required[index];

    if (key === undefined || !Object.hasOwn(value, key)) {
      return reject("MISSING_FIELD", `${key ?? "field"} is required.`, path);
    }
  }

  return accept(true);
}

function requiredString(value: PlainJsonObject, key: string, path: string): ShellResult<string> {
  const raw = field(value, key);

  if (typeof raw !== "string" || raw.length === 0) {
    return reject("INVALID_STRING", "field must be a non-empty string.", path);
  }

  return accept(raw);
}

function normalizeId(value: string, path: string): ShellResult<string> {
  if (value.length === 0) {
    return reject("INVALID_ID", "id must be a non-empty string.", path);
  }

  return accept(value);
}

function normalizeAppId(appId: string): ShellResult<string> {
  if (appId.length === 0) {
    return reject("INVALID_APP_ID", "app id must be a non-empty string.", "/appId");
  }

  return accept(appId);
}

function optionalString(value: PlainJson | undefined, path: string): ShellResult<string | undefined> {
  if (value === undefined) return accept(undefined);
  if (typeof value !== "string") {
    return reject("INVALID_STRING", "field must be a string.", path);
  }

  return accept(value);
}

function optionalInteger(value: PlainJson | undefined, path: string): ShellResult<number | undefined> {
  if (value === undefined) return accept(undefined);
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    return reject("INVALID_INTEGER", "field must be a safe integer.", path);
  }

  return accept(value);
}

function optionalPositiveInteger(value: PlainJson | undefined, path: string): ShellResult<number | undefined> {
  if (value === undefined) return accept(undefined);
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    return reject("INVALID_DURATION", "field must be a positive safe integer.", path);
  }

  return accept(value);
}

function optionalTimestamp(value: PlainJson | undefined, path: string): ShellResult<number | undefined> {
  if (value === undefined) return accept(undefined);
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    return reject("INVALID_TIMESTAMP", "field must be a safe integer timestamp.", path);
  }

  return accept(value);
}

function optionalBoolean(
  value: PlainJson | undefined,
  defaultValue: boolean,
  path: string,
): ShellResult<boolean> {
  if (value === undefined) return accept(defaultValue);
  if (typeof value !== "boolean") {
    return reject("INVALID_BOOLEAN", "field must be a boolean.", path);
  }

  return accept(value);
}

function optionalBooleanValue(value: PlainJson | undefined, path: string): ShellResult<boolean | undefined> {
  if (value === undefined) return accept(undefined);
  if (typeof value !== "boolean") {
    return reject("INVALID_BOOLEAN", "field must be a boolean.", path);
  }

  return accept(value);
}

function normalizePriority(value: PlainJson | undefined, path: string): ShellResult<NotificationPriority> {
  if (value === undefined) return accept("normal");
  if (value === "low" || value === "normal" || value === "high" || value === "urgent" || value === "critical") {
    return accept(value);
  }

  return reject("INVALID_NOTIFICATION_PRIORITY", "notification priority is not supported.", path);
}

function normalizeActionStyle(value: PlainJson | undefined, path: string): ShellResult<NotificationActionStyle> {
  if (value === undefined) return accept("default");
  if (value === "default" || value === "primary" || value === "destructive") {
    return accept(value);
  }

  return reject("INVALID_NOTIFICATION_ACTION_STYLE", "notification action style is not supported.", path);
}

function normalizeTrayStatus(value: PlainJson | undefined, path: string): ShellResult<TrayStatus | undefined> {
  if (value === undefined) return accept(undefined);
  if (value === "ok" || value === "warning" || value === "critical" || value === "offline") {
    return accept(value);
  }

  return reject("INVALID_TRAY_STATUS", "tray status is not supported.", path);
}

function readClockMs(clock: NotificationClock): ShellResult<number> {
  try {
    const raw = typeof clock.nowMs === "function" ? clock.nowMs() : clock.nowMs;

    if (typeof raw !== "number" || !Number.isSafeInteger(raw)) {
      return reject("INVALID_CLOCK", "clock must return a safe integer timestamp.", "/clock");
    }

    return accept(raw);
  } catch {
    return reject("INVALID_CLOCK", "clock must return a safe integer timestamp.", "/clock");
  }
}

function authorizeCapability(
  port: ShellCapabilityPort | undefined,
  request: ShellCapabilityRequest,
): ShellResult<true> {
  if (port === undefined) {
    return reject("MISSING_CAPABILITY", "app does not hold the required shell capability.", "/capabilities");
  }

  try {
    if (port.hasGrant(request) === true) {
      return accept(true);
    }
  } catch {
    return reject("MISSING_CAPABILITY", "app does not hold the required shell capability.", "/capabilities");
  }

  return reject("MISSING_CAPABILITY", "app does not hold the required shell capability.", "/capabilities");
}

function freezeNotification(notification: ShellNotification): ShellNotification {
  const output: {
    appId: string;
    id: string;
    title: string;
    priority: NotificationPriority;
    createdAtMs: number;
    actions: readonly NotificationAction[];
    body?: string;
    expiresAtMs?: number;
  } = {
    actions: Object.freeze([...notification.actions].map(freezeNotificationAction)),
    appId: notification.appId,
    createdAtMs: notification.createdAtMs,
    id: notification.id,
    priority: notification.priority,
    title: notification.title,
  };

  if (notification.body !== undefined) output.body = notification.body;
  if (notification.expiresAtMs !== undefined) output.expiresAtMs = notification.expiresAtMs;

  return Object.freeze(output);
}

function freezeNotificationAction(action: NotificationAction): NotificationAction {
  return Object.freeze({
    id: action.id,
    label: action.label,
    style: action.style,
  });
}

function freezeTrayItem(item: TrayItem): TrayItem {
  const output: {
    appId: string;
    id: string;
    iconRef: string;
    tooltip: string;
    order: number;
    menu: readonly TrayMenuItem[];
    status?: TrayStatus;
  } = {
    appId: item.appId,
    iconRef: item.iconRef,
    id: item.id,
    menu: Object.freeze([...item.menu].map(freezeTrayMenuItem)),
    order: item.order,
    tooltip: item.tooltip,
  };

  if (item.status !== undefined) output.status = item.status;

  return Object.freeze(output);
}

function freezeTrayMenuItem(item: TrayMenuItem): TrayMenuItem {
  const output: {
    id: string;
    label: string;
    enabled: boolean;
    items: readonly TrayMenuItem[];
    checked?: boolean;
  } = {
    enabled: item.enabled,
    id: item.id,
    items: Object.freeze([...item.items].map(freezeTrayMenuItem)),
    label: item.label,
  };

  if (item.checked !== undefined) output.checked = item.checked;

  return Object.freeze(output);
}

function findNotificationAction(
  notification: ShellNotification,
  actionId: string,
): NotificationAction | undefined {
  for (let index = 0; index < notification.actions.length; index += 1) {
    const action = notification.actions[index];

    if (action !== undefined && action.id === actionId) {
      return action;
    }
  }

  return undefined;
}

function isExpired(notification: ShellNotification, nowMs: number): boolean {
  return notification.expiresAtMs !== undefined && notification.expiresAtMs <= nowMs;
}

function compareNotifications(left: ShellNotification, right: ShellNotification): number {
  const priority = priorityRank(right.priority) - priorityRank(left.priority);

  if (priority !== 0) return priority;

  const created = right.createdAtMs - left.createdAtMs;

  if (created !== 0) return created;

  const app = compareStrings(left.appId, right.appId);

  if (app !== 0) return app;

  return compareStrings(left.id, right.id);
}

function priorityRank(priority: NotificationPriority): number {
  switch (priority) {
    case "critical":
      return 4;
    case "urgent":
      return 3;
    case "high":
      return 2;
    case "normal":
      return 1;
    case "low":
      return 0;
  }
}

function compareTrayItems(left: TrayItem, right: TrayItem): number {
  const order = left.order - right.order;

  if (order !== 0) return order;

  const app = compareStrings(left.appId, right.appId);

  if (app !== 0) return app;

  return compareStrings(left.id, right.id);
}

function notificationStorageKey(appId: string, notificationId: string): string {
  return `${appId}\u0000${notificationId}`;
}

function grantKey(
  appId: string,
  capability: ShellGrantCapability,
  resourceId: string | undefined,
): string {
  return `${appId}\u0000${capability}\u0000${resourceId ?? "*"}`;
}

function trayClickIntent(item: TrayItem): TrayIntent {
  return Object.freeze({
    appId: item.appId,
    itemId: item.id,
    type: "tray.click",
  });
}

function trayOpenMenuIntent(item: TrayItem): TrayIntent {
  return Object.freeze({
    appId: item.appId,
    itemId: item.id,
    type: "tray.menu.open",
  });
}

function notificationGroupsPayload(groups: readonly NotificationGroup[]): readonly PlainJson[] {
  const output: PlainJson[] = [];

  for (let index = 0; index < groups.length; index += 1) {
    const group = groups[index];

    if (group !== undefined) {
      output.push(notificationGroupPayload(group));
    }
  }

  return Object.freeze(output);
}

function notificationGroupPayload(group: NotificationGroup): PlainJsonObject {
  return Object.freeze({
    appId: group.appId,
    count: group.count,
    latestCreatedAtMs: group.latestCreatedAtMs,
    notifications: notificationsPayload(group.notifications),
    topPriority: group.topPriority,
  });
}

function notificationsPayload(notifications: readonly ShellNotification[]): readonly PlainJson[] {
  const output: PlainJson[] = [];

  for (let index = 0; index < notifications.length; index += 1) {
    const notification = notifications[index];

    if (notification !== undefined) {
      output.push(notificationPayload(notification));
    }
  }

  return Object.freeze(output);
}

function notificationPayload(notification: ShellNotification): PlainJsonObject {
  const output: Record<string, PlainJson> = {
    actions: notificationActionsPayload(notification),
    appId: notification.appId,
    createdAtMs: notification.createdAtMs,
    dismissIntent: notificationDismissIntentPayload(notification),
    id: notification.id,
    priority: notification.priority,
    title: notification.title,
  };

  if (notification.body !== undefined) output["body"] = notification.body;
  if (notification.expiresAtMs !== undefined) output["expiresAtMs"] = notification.expiresAtMs;

  return Object.freeze(output);
}

function notificationActionsPayload(notification: ShellNotification): readonly PlainJson[] {
  const output: PlainJson[] = [];

  for (let index = 0; index < notification.actions.length; index += 1) {
    const action = notification.actions[index];

    if (action !== undefined) {
      output.push(Object.freeze({
        id: action.id,
        intent: Object.freeze({
          actionId: action.id,
          appId: notification.appId,
          notificationId: notification.id,
          type: "notification.action",
        }),
        label: action.label,
        style: action.style,
      }));
    }
  }

  return Object.freeze(output);
}

function notificationDismissIntentPayload(notification: ShellNotification): PlainJsonObject {
  return Object.freeze({
    appId: notification.appId,
    notificationId: notification.id,
    type: "notification.dismiss",
  });
}

function trayItemsPayload(items: readonly TrayItem[]): readonly PlainJson[] {
  const output: PlainJson[] = [];

  for (let index = 0; index < items.length; index += 1) {
    const item = items[index];

    if (item !== undefined) {
      output.push(trayItemPayload(item));
    }
  }

  return Object.freeze(output);
}

function trayItemPayload(item: TrayItem): PlainJsonObject {
  const output: Record<string, PlainJson> = {
    appId: item.appId,
    clickIntent: trayClickIntentPayload(item),
    iconRef: item.iconRef,
    id: item.id,
    menu: trayMenuPayload(item, item.menu),
    menuIntent: trayOpenMenuIntentPayload(item),
    order: item.order,
    tooltip: item.tooltip,
  };

  if (item.status !== undefined) output["status"] = item.status;

  return Object.freeze(output);
}

function trayMenuPayload(item: TrayItem, menu: readonly TrayMenuItem[]): readonly PlainJson[] {
  const output: PlainJson[] = [];

  for (let index = 0; index < menu.length; index += 1) {
    const menuItem = menu[index];

    if (menuItem !== undefined) {
      output.push(trayMenuItemPayload(item, menuItem, Object.freeze([menuItem.id])));
    }
  }

  return Object.freeze(output);
}

function trayMenuItemPayload(
  item: TrayItem,
  menuItem: TrayMenuItem,
  path: readonly string[],
): PlainJsonObject {
  const output: Record<string, PlainJson> = {
    enabled: menuItem.enabled,
    id: menuItem.id,
    items: traySubmenuPayload(item, menuItem.items, path),
    label: menuItem.label,
  };

  if (menuItem.checked !== undefined) output["checked"] = menuItem.checked;
  if (menuItem.enabled) {
    output["selectIntent"] = Object.freeze({
      appId: item.appId,
      itemId: item.id,
      menuItemId: menuItem.id,
      path: Object.freeze([...path]),
      type: "tray.menu.select",
    });
  }

  return Object.freeze(output);
}

function traySubmenuPayload(
  item: TrayItem,
  menu: readonly TrayMenuItem[],
  path: readonly string[],
): readonly PlainJson[] {
  const output: PlainJson[] = [];

  for (let index = 0; index < menu.length; index += 1) {
    const menuItem = menu[index];

    if (menuItem !== undefined) {
      output.push(trayMenuItemPayload(item, menuItem, Object.freeze([...path, menuItem.id])));
    }
  }

  return Object.freeze(output);
}

function trayClickIntentPayload(item: TrayItem): PlainJsonObject {
  return Object.freeze({
    appId: item.appId,
    itemId: item.id,
    type: "tray.click",
  });
}

function trayOpenMenuIntentPayload(item: TrayItem): PlainJsonObject {
  return Object.freeze({
    appId: item.appId,
    itemId: item.id,
    type: "tray.menu.open",
  });
}

function readJsonArray(value: PlainJson | undefined): readonly PlainJson[] {
  return Array.isArray(value) ? Object.freeze([...value]) : Object.freeze([]);
}

function normalizeCount(value: PlainJson | undefined): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(0, Math.trunc(value))
    : 0;
}

function normalizeMaxVisible(value: number | undefined): number {
  if (value === undefined || !Number.isSafeInteger(value) || value <= 0) {
    return DEFAULT_NOTIFICATION_MAX_VISIBLE;
  }

  return value;
}

function isPlainJsonObject(value: PlainJson | undefined): value is PlainJsonObject {
  return value !== undefined && value !== null && typeof value === "object" && !Array.isArray(value);
}

function field(value: PlainJsonObject, key: string): PlainJson | undefined {
  if (!Object.hasOwn(value, key)) return undefined;

  return value[key];
}

function contains(values: readonly string[], value: string): boolean {
  for (let index = 0; index < values.length; index += 1) {
    if (values[index] === value) return true;
  }

  return false;
}

function hasRegisteredComponent(
  components: readonly RegisteredShellComponent[],
  componentId: string,
): boolean {
  for (let index = 0; index < components.length; index += 1) {
    if (components[index]?.id === componentId) {
      return true;
    }
  }

  return false;
}

function compareStrings(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;

  return 0;
}

function accept<T>(value: T): ShellResult<T> {
  return {
    ok: true,
    value,
  };
}

function reject<T>(code: string, message: string, path: string): ShellResult<T> {
  return {
    error: {
      code,
      message,
      path,
    },
    ok: false,
  };
}
