import {
  ShellComponentRegistry,
  defineShellComponent,
  defineShellConfig,
  shellComponent,
  shellSurface,
} from "../index.ts";
import type {
  RegisteredShellComponent,
  ShellComponentDefinition,
  ShellConfigDefinition,
  ShellElement,
  ShellElementOptions,
  ShellPlacementInput,
  ShellResult,
} from "../index.ts";
import type { PlainJson, PlainJsonObject } from "../../safe-normalize.ts";
import type { WindowId, WindowManagerIntent } from "../../wm/policy.ts";

export const CHROME_PANEL_COMPONENT_ID = "vita.shell.chrome.panel";
export const CHROME_LAUNCHER_COMPONENT_ID = "vita.shell.chrome.launcher";
export const CHROME_NOTIFICATIONS_COMPONENT_ID = "vita.shell.chrome.notifications";
export const DEFAULT_CHROME_SHELL_ID = "vita.shell.chrome";

export type ChromePanelEdge = "top" | "bottom";
export type ChromeTrayStatus = "ok" | "warning" | "critical" | "offline";
export type ChromeNotificationSeverity = "info" | "success" | "warning" | "critical";

export interface ChromeFocusedWindow {
  readonly id: WindowId;
  readonly title: string;
}

export interface ChromeTrayItem {
  readonly id: string;
  readonly label: string;
  readonly status?: ChromeTrayStatus;
}

export interface ChromePanelState {
  readonly clockLabel: string;
  readonly edge?: ChromePanelEdge;
  readonly focusedWindow?: ChromeFocusedWindow;
  readonly trayItems?: readonly ChromeTrayItem[];
  readonly notificationCount?: number;
}

export interface ChromeLauncherApp {
  readonly id: string;
  readonly name: string;
  readonly subtitle?: string;
  readonly keywords?: readonly string[];
  readonly icon?: string;
}

export interface ChromeLauncherState {
  readonly apps: readonly ChromeLauncherApp[];
  readonly query?: string;
  readonly open?: boolean;
  readonly selectedAppId?: string;
}

export interface ChromeNotification {
  readonly id: string;
  readonly title: string;
  readonly severity: ChromeNotificationSeverity;
  readonly createdAtMs: number;
  readonly body?: string;
  readonly source?: string;
  readonly expiresAtMs?: number;
}

export interface ChromeNotificationInput {
  readonly id: string;
  readonly title: string;
  readonly body?: string;
  readonly source?: string;
  readonly severity?: ChromeNotificationSeverity;
  readonly ttlMs?: number;
  readonly expiresAtMs?: number;
}

export interface ChromeNotificationState {
  readonly notifications: readonly ChromeNotification[];
}

export interface ChromeNotificationClock {
  readonly nowMs: number;
}

export type ChromeNotificationEvent =
  | {
      readonly type: "add";
      readonly notification: ChromeNotificationInput;
    }
  | {
      readonly type: "dismiss";
      readonly notificationId: string;
    }
  | {
      readonly type: "expire";
    };

export interface ChromeLaunchAppIntent {
  readonly type: "launchApp";
  readonly appId: string;
}

export type ChromeFocusWindowIntent = Extract<WindowManagerIntent, { readonly type: "setFocus" }>;
export type ChromeShellIntent = ChromeLaunchAppIntent | ChromeFocusWindowIntent;

export interface ChromeShellIntentPort {
  readonly emitIntent: (intent: ChromeShellIntent) => unknown;
}

export interface ChromeElementOptions {
  readonly key?: string;
  readonly role?: string;
  readonly className?: string;
  readonly placement?: ShellPlacementInput;
  readonly children?: readonly ShellElement[];
}

export interface ChromeShellConfigOptions {
  readonly id?: string;
  readonly revision?: string;
}

const EMPTY_CHILDREN: readonly ShellElement[] = Object.freeze([]);
const EMPTY_APPS: readonly ChromeLauncherApp[] = Object.freeze([]);
const EMPTY_NOTIFICATIONS: readonly ChromeNotification[] = Object.freeze([]);
const EMPTY_TRAY_ITEMS: readonly ChromeTrayItem[] = Object.freeze([]);
const DEFAULT_PANEL_EDGE: ChromePanelEdge = "top";

export const CHROME_SHELL_CSS = Object.freeze({
  rules: Object.freeze([
    Object.freeze({
      declarations: Object.freeze({
        "align-items": "center",
        display: "flex",
        gap: "12px",
      }),
      selector: ".vita-chrome-panel",
    }),
    Object.freeze({
      declarations: Object.freeze({
        display: "grid",
        gap: "6px",
      }),
      selector: ".vita-chrome-launcher",
    }),
    Object.freeze({
      declarations: Object.freeze({
        display: "grid",
        gap: "8px",
      }),
      selector: ".vita-chrome-notifications",
    }),
  ]),
}) satisfies ShellConfigDefinition["css"];

export const chromePanelComponent = defineShellComponent<PlainJsonObject>({
  defaultPlacement: {
    layer: "panel",
    order: 0,
    zone: DEFAULT_PANEL_EDGE,
  },
  id: CHROME_PANEL_COMPONENT_ID,
  render: (props) => shellSurface(panelPayloadFromProps(props), {
    className: "vita-chrome-panel",
  }),
  role: "panel",
});

export const chromeLauncherComponent = defineShellComponent<PlainJsonObject>({
  defaultPlacement: {
    layer: "overlay",
    order: 10,
    zone: "left",
  },
  id: CHROME_LAUNCHER_COMPONENT_ID,
  render: (props) => shellSurface(launcherPayloadFromProps(props), {
    className: "vita-chrome-launcher",
  }),
  role: "launcher",
});

export const chromeNotificationsComponent = defineShellComponent<PlainJsonObject>({
  defaultPlacement: {
    layer: "overlay",
    order: 20,
    zone: "right",
  },
  id: CHROME_NOTIFICATIONS_COMPONENT_ID,
  render: (props) => shellSurface(notificationPayloadFromProps(props), {
    className: "vita-chrome-notifications",
  }),
  role: "notifications",
});

export const chromeShellComponents = Object.freeze([
  chromePanelComponent,
  chromeLauncherComponent,
  chromeNotificationsComponent,
]) satisfies readonly ShellComponentDefinition<PlainJsonObject>[];

export function registerChromeShellComponents(
  registry: ShellComponentRegistry,
): ShellResult<readonly RegisteredShellComponent[]> {
  const existing = registry.list();

  for (let index = 0; index < chromeShellComponents.length; index += 1) {
    const definition = chromeShellComponents[index];

    if (definition !== undefined && hasRegisteredComponent(existing, definition.id)) {
      return reject(
        "DUPLICATE_COMPONENT",
        `Shell component '${definition.id}' is already registered.`,
        "/id",
      );
    }
  }

  const registered: RegisteredShellComponent[] = [];

  for (let index = 0; index < chromeShellComponents.length; index += 1) {
    const definition = chromeShellComponents[index];

    if (definition === undefined) {
      return reject("INVALID_COMPONENT", `component definition ${index} is missing.`, `/components/${index}`);
    }

    const result = registry.register(definition);

    if (!result.ok) return result;
    registered.push(result.value);
  }

  return accept(Object.freeze(registered));
}

export function createChromeShellRegistry(): ShellResult<ShellComponentRegistry> {
  const registry = new ShellComponentRegistry();
  const registered = registerChromeShellComponents(registry);

  if (!registered.ok) return registered;
  return accept(registry);
}

export function chromeShellConfig(
  input: {
    readonly panel: ChromePanelState;
    readonly launcher: ChromeLauncherState;
    readonly notifications: ChromeNotificationState;
  },
  options: ChromeShellConfigOptions = Object.freeze({}),
): ShellConfigDefinition {
  return defineShellConfig({
    css: CHROME_SHELL_CSS,
    id: options.id ?? DEFAULT_CHROME_SHELL_ID,
    render: () => chromePanelElement(input.panel, {
      children: [
        chromeLauncherElement(input.launcher, {
          key: "launcher",
        }),
        chromeNotificationCenterElement(input.notifications, {
          key: "notifications",
        }),
      ],
      key: "panel",
    }),
    revision: options.revision ?? "chrome",
  });
}

export function chromePanelElement(
  state: ChromePanelState,
  options: ChromeElementOptions = Object.freeze({}),
): ShellElement {
  const placement = options.placement ?? panelPlacement(state.edge ?? DEFAULT_PANEL_EDGE);
  return shellComponent(CHROME_PANEL_COMPONENT_ID, shellElementOptions({
    children: options.children,
    className: options.className,
    key: options.key,
    placement,
    props: panelProps(state),
    role: options.role,
  }));
}

export function chromeLauncherElement(
  state: ChromeLauncherState,
  options: ChromeElementOptions = Object.freeze({}),
): ShellElement {
  return shellComponent(CHROME_LAUNCHER_COMPONENT_ID, shellElementOptions({
    children: options.children,
    className: options.className,
    key: options.key,
    placement: options.placement,
    props: launcherProps(state),
    role: options.role,
  }));
}

export function chromeNotificationCenterElement(
  state: ChromeNotificationState,
  options: ChromeElementOptions = Object.freeze({}),
): ShellElement {
  return shellComponent(CHROME_NOTIFICATIONS_COMPONENT_ID, shellElementOptions({
    children: options.children,
    className: options.className,
    key: options.key,
    placement: options.placement,
    props: notificationProps(state),
    role: options.role,
  }));
}

export function filterLauncherApps(
  apps: readonly ChromeLauncherApp[],
  query = "",
): readonly ChromeLauncherApp[] {
  const normalizedQuery = normalizeSearch(query);
  const results: ChromeLauncherApp[] = [];

  for (let index = 0; index < apps.length; index += 1) {
    const app = apps[index];

    if (app === undefined) {
      continue;
    }

    const frozen = freezeLauncherApp(app);

    if (normalizedQuery.length === 0 || appMatchesQuery(frozen, normalizedQuery)) {
      results.push(frozen);
    }
  }

  return Object.freeze(results);
}

export function createLaunchAppIntent(appId: string): ChromeLaunchAppIntent {
  return Object.freeze({
    appId,
    type: "launchApp",
  });
}

export function createPanelFocusIntent(windowId: WindowId | null): ChromeFocusWindowIntent {
  return Object.freeze({
    type: "setFocus",
    windowId,
  });
}

export function emitChromeIntent(port: ChromeShellIntentPort, intent: ChromeShellIntent): void {
  port.emitIntent(intent);
}

export function emitChromeIntents(port: ChromeShellIntentPort, intents: readonly ChromeShellIntent[]): void {
  for (let index = 0; index < intents.length; index += 1) {
    const intent = intents[index];

    if (intent !== undefined) {
      emitChromeIntent(port, intent);
    }
  }
}

export function launchChromeApp(
  port: ChromeShellIntentPort,
  apps: readonly ChromeLauncherApp[],
  appId: string,
): ChromeLaunchAppIntent | null {
  const app = findLauncherApp(apps, appId);

  if (app === undefined) {
    return null;
  }

  const intent = createLaunchAppIntent(app.id);
  emitChromeIntent(port, intent);
  return intent;
}

export const emitLauncherLaunchIntent = launchChromeApp;

export function focusChromeWindow(
  port: ChromeShellIntentPort,
  windowId: WindowId | null,
): ChromeFocusWindowIntent {
  const intent = createPanelFocusIntent(windowId);
  emitChromeIntent(port, intent);
  return intent;
}

export const emitPanelFocusIntent = focusChromeWindow;

export function createChromeNotificationState(
  notifications: readonly ChromeNotification[] = EMPTY_NOTIFICATIONS,
): ChromeNotificationState {
  return freezeNotificationState(Object.freeze({
    notifications,
  }));
}

export function reduceChromeNotifications(
  state: ChromeNotificationState,
  event: ChromeNotificationEvent,
  clock: ChromeNotificationClock,
): ChromeNotificationState {
  switch (event.type) {
    case "add":
      return addNotification(state, event.notification, clock);
    case "dismiss":
      return dismissNotification(state, event.notificationId);
    case "expire":
      return expireNotifications(state, clock);
  }
}

export const reduceNotificationCenter = reduceChromeNotifications;

function addNotification(
  state: ChromeNotificationState,
  input: ChromeNotificationInput,
  clock: ChromeNotificationClock,
): ChromeNotificationState {
  const notificationInput: {
    id: string;
    title: string;
    severity: ChromeNotificationSeverity;
    createdAtMs: number;
    body?: string;
    source?: string;
    expiresAtMs?: number;
  } = {
    createdAtMs: normalizeTimestamp(clock.nowMs),
    id: input.id,
    severity: input.severity ?? "info",
    title: input.title,
  };
  const expiresAtMs = notificationExpiresAt(input, clock);

  if (input.body !== undefined) notificationInput.body = input.body;
  if (input.source !== undefined) notificationInput.source = input.source;
  if (expiresAtMs !== undefined) notificationInput.expiresAtMs = expiresAtMs;

  const notification = freezeNotification(notificationInput);
  const next: ChromeNotification[] = [];

  next.push(notification);

  for (let index = 0; index < state.notifications.length; index += 1) {
    const existing = state.notifications[index];

    if (existing !== undefined && existing.id !== notification.id) {
      next.push(existing);
    }
  }

  next.sort(compareNotifications);
  return freezeNotificationState(Object.freeze({
    notifications: Object.freeze(next),
  }));
}

function dismissNotification(
  state: ChromeNotificationState,
  notificationId: string,
): ChromeNotificationState {
  const next: ChromeNotification[] = [];

  for (let index = 0; index < state.notifications.length; index += 1) {
    const notification = state.notifications[index];

    if (notification !== undefined && notification.id !== notificationId) {
      next.push(notification);
    }
  }

  return freezeNotificationState(Object.freeze({
    notifications: Object.freeze(next),
  }));
}

function expireNotifications(
  state: ChromeNotificationState,
  clock: ChromeNotificationClock,
): ChromeNotificationState {
  const nowMs = normalizeTimestamp(clock.nowMs);
  const next: ChromeNotification[] = [];

  for (let index = 0; index < state.notifications.length; index += 1) {
    const notification = state.notifications[index];

    if (notification !== undefined && !isExpired(notification, nowMs)) {
      next.push(notification);
    }
  }

  return freezeNotificationState(Object.freeze({
    notifications: Object.freeze(next),
  }));
}

function panelPayloadFromProps(props: PlainJsonObject): PlainJsonObject {
  const edge = readEdge(props["edge"]);
  const focusedWindow = readFocusedWindow(props["focusedWindow"]);
  const notificationCount = normalizeCount(props["notificationCount"]);
  const payload: Record<string, PlainJson> = {
    clock: readString(props["clockLabel"]),
    edge,
    focusIntent: focusedWindow === null ? null : focusIntentPayload(focusedWindow.id),
    focusedWindow: focusedWindow === null ? null : focusedWindowPayload(focusedWindow),
    kind: "chrome.panel",
    notificationCount,
    tray: readTrayItems(props["trayItems"]),
  };

  return Object.freeze(payload);
}

function launcherPayloadFromProps(props: PlainJsonObject): PlainJsonObject {
  const apps = readLauncherApps(props["apps"]);
  const query = readString(props["query"]);
  const results = filterLauncherApps(apps, query);
  const selectedAppId = readOptionalString(props["selectedAppId"]);
  const selectedApp = selectedAppId === undefined ? undefined : findLauncherApp(results, selectedAppId);
  const payload: Record<string, PlainJson> = {
    kind: "chrome.launcher",
    launchIntent: selectedApp === undefined ? null : launchIntentPayload(selectedApp.id),
    open: props["open"] === true,
    query,
    results: launcherAppsPayload(results),
  };

  if (selectedAppId !== undefined) {
    payload["selectedAppId"] = selectedAppId;
  }

  return Object.freeze(payload);
}

function notificationPayloadFromProps(props: PlainJsonObject): PlainJsonObject {
  const notifications = readNotifications(props["notifications"]);
  const payload: Record<string, PlainJson> = {
    count: notifications.length,
    criticalCount: countCriticalNotifications(notifications),
    kind: "chrome.notifications",
    notifications: notificationListPayload(notifications),
  };

  return Object.freeze(payload);
}

function panelProps(state: ChromePanelState): PlainJsonObject {
  const edge = state.edge ?? DEFAULT_PANEL_EDGE;
  const focusedWindow = state.focusedWindow;
  const props: Record<string, PlainJson> = {
    clockLabel: state.clockLabel,
    edge,
    notificationCount: normalizeCount(state.notificationCount),
    trayItems: trayItemsPayload(state.trayItems ?? EMPTY_TRAY_ITEMS),
  };

  if (focusedWindow !== undefined) {
    props["focusedWindow"] = focusedWindowPayload(focusedWindow);
  }

  return Object.freeze(props);
}

function launcherProps(state: ChromeLauncherState): PlainJsonObject {
  const props: Record<string, PlainJson> = {
    apps: launcherAppsPayload(state.apps),
    open: state.open ?? true,
    query: state.query ?? "",
  };

  if (state.selectedAppId !== undefined) {
    props["selectedAppId"] = state.selectedAppId;
  }

  return Object.freeze(props);
}

function notificationProps(state: ChromeNotificationState): PlainJsonObject {
  return Object.freeze({
    notifications: notificationListPayload(state.notifications),
  });
}

function shellElementOptions(input: {
  readonly props: PlainJsonObject;
  readonly key?: string | undefined;
  readonly role?: string | undefined;
  readonly className?: string | undefined;
  readonly placement?: ShellPlacementInput | undefined;
  readonly children?: readonly ShellElement[] | undefined;
}): ShellElementOptions {
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

function panelPlacement(edge: ChromePanelEdge): ShellPlacementInput {
  return Object.freeze({
    layer: "panel",
    order: 0,
    zone: edge,
  });
}

function notificationExpiresAt(
  input: ChromeNotificationInput,
  clock: ChromeNotificationClock,
): number | undefined {
  if (input.expiresAtMs !== undefined) {
    return normalizeTimestamp(input.expiresAtMs);
  }

  if (input.ttlMs === undefined) {
    return undefined;
  }

  const ttlMs = normalizePositiveDuration(input.ttlMs);

  if (ttlMs === undefined) {
    return undefined;
  }

  return normalizeTimestamp(clock.nowMs) + ttlMs;
}

function freezeNotificationState(state: ChromeNotificationState): ChromeNotificationState {
  const notifications = [...state.notifications]
    .map(freezeNotification)
    .sort(compareNotifications);

  return Object.freeze({
    notifications: Object.freeze(notifications),
  });
}

function freezeNotification(notification: ChromeNotification): ChromeNotification {
  const output: {
    id: string;
    title: string;
    severity: ChromeNotificationSeverity;
    createdAtMs: number;
    body?: string;
    source?: string;
    expiresAtMs?: number;
  } = {
    createdAtMs: normalizeTimestamp(notification.createdAtMs),
    id: notification.id,
    severity: notification.severity,
    title: notification.title,
  };

  if (notification.body !== undefined) output.body = notification.body;
  if (notification.source !== undefined) output.source = notification.source;
  if (notification.expiresAtMs !== undefined) output.expiresAtMs = normalizeTimestamp(notification.expiresAtMs);

  return Object.freeze(output);
}

function isExpired(notification: ChromeNotification, nowMs: number): boolean {
  return notification.expiresAtMs !== undefined && notification.expiresAtMs <= nowMs;
}

function compareNotifications(left: ChromeNotification, right: ChromeNotification): number {
  const created = right.createdAtMs - left.createdAtMs;

  if (created !== 0) {
    return created;
  }

  return compareStrings(left.id, right.id);
}

function freezeLauncherApp(app: ChromeLauncherApp): ChromeLauncherApp {
  const output: {
    id: string;
    name: string;
    subtitle?: string;
    keywords?: readonly string[];
    icon?: string;
  } = {
    id: app.id,
    name: app.name,
  };

  if (app.subtitle !== undefined) output.subtitle = app.subtitle;
  if (app.keywords !== undefined) output.keywords = Object.freeze([...app.keywords]);
  if (app.icon !== undefined) output.icon = app.icon;

  return Object.freeze(output);
}

function findLauncherApp(
  apps: readonly ChromeLauncherApp[],
  appId: string,
): ChromeLauncherApp | undefined {
  for (let index = 0; index < apps.length; index += 1) {
    const app = apps[index];

    if (app !== undefined && app.id === appId) {
      return app;
    }
  }

  return undefined;
}

function appMatchesQuery(app: ChromeLauncherApp, query: string): boolean {
  if (normalizeSearch(app.id).includes(query) || normalizeSearch(app.name).includes(query)) {
    return true;
  }

  if (app.subtitle !== undefined && normalizeSearch(app.subtitle).includes(query)) {
    return true;
  }

  if (app.keywords !== undefined) {
    for (let index = 0; index < app.keywords.length; index += 1) {
      const keyword = app.keywords[index];

      if (keyword !== undefined && normalizeSearch(keyword).includes(query)) {
        return true;
      }
    }
  }

  return false;
}

function trayItemsPayload(items: readonly ChromeTrayItem[]): readonly PlainJson[] {
  const output: PlainJson[] = [];

  for (let index = 0; index < items.length; index += 1) {
    const item = items[index];

    if (item !== undefined) {
      output.push(trayItemPayload(item));
    }
  }

  return Object.freeze(output);
}

function trayItemPayload(item: ChromeTrayItem): PlainJsonObject {
  const output: Record<string, PlainJson> = {
    id: item.id,
    label: item.label,
  };

  if (item.status !== undefined) {
    output["status"] = item.status;
  }

  return Object.freeze(output);
}

function launcherAppsPayload(apps: readonly ChromeLauncherApp[]): readonly PlainJson[] {
  const output: PlainJson[] = [];

  for (let index = 0; index < apps.length; index += 1) {
    const app = apps[index];

    if (app !== undefined) {
      output.push(launcherAppPayload(app));
    }
  }

  return Object.freeze(output);
}

function launcherAppPayload(app: ChromeLauncherApp): PlainJsonObject {
  const output: Record<string, PlainJson> = {
    id: app.id,
    name: app.name,
  };

  if (app.subtitle !== undefined) output["subtitle"] = app.subtitle;
  if (app.icon !== undefined) output["icon"] = app.icon;
  if (app.keywords !== undefined) output["keywords"] = Object.freeze([...app.keywords]);

  return Object.freeze(output);
}

function notificationListPayload(notifications: readonly ChromeNotification[]): readonly PlainJson[] {
  const output: PlainJson[] = [];

  for (let index = 0; index < notifications.length; index += 1) {
    const notification = notifications[index];

    if (notification !== undefined) {
      output.push(notificationPayload(notification));
    }
  }

  return Object.freeze(output);
}

function notificationPayload(notification: ChromeNotification): PlainJsonObject {
  const output: Record<string, PlainJson> = {
    createdAtMs: normalizeTimestamp(notification.createdAtMs),
    id: notification.id,
    severity: notification.severity,
    title: notification.title,
  };

  if (notification.body !== undefined) output["body"] = notification.body;
  if (notification.source !== undefined) output["source"] = notification.source;
  if (notification.expiresAtMs !== undefined) output["expiresAtMs"] = normalizeTimestamp(notification.expiresAtMs);

  return Object.freeze(output);
}

function focusedWindowPayload(window: ChromeFocusedWindow): PlainJsonObject {
  return Object.freeze({
    id: window.id,
    title: window.title,
  });
}

function focusIntentPayload(windowId: WindowId): PlainJsonObject {
  return Object.freeze({
    type: "setFocus",
    windowId,
  });
}

function launchIntentPayload(appId: string): PlainJsonObject {
  return Object.freeze({
    appId,
    type: "launchApp",
  });
}

function readFocusedWindow(value: PlainJson | undefined): ChromeFocusedWindow | null {
  if (!isPlainJsonObject(value)) {
    return null;
  }

  const id = readString(value["id"]);
  const title = readString(value["title"]);

  if (id.length === 0) {
    return null;
  }

  return Object.freeze({
    id,
    title,
  });
}

function isPlainJsonObject(value: PlainJson | undefined): value is PlainJsonObject {
  return value !== undefined && value !== null && typeof value === "object" && !Array.isArray(value);
}

function readTrayItems(value: PlainJson | undefined): readonly PlainJson[] {
  if (!Array.isArray(value)) {
    return Object.freeze([]);
  }

  const output: PlainJson[] = [];

  for (let index = 0; index < value.length; index += 1) {
    const item = value[index];

    if (item === undefined || item === null || typeof item !== "object" || Array.isArray(item)) {
      continue;
    }

    const id = readString(item["id"]);
    const label = readString(item["label"]);

    if (id.length === 0) {
      continue;
    }

    const outputItem: Record<string, PlainJson> = {
      id,
      label,
    };
    const status = readTrayStatus(item["status"]);

    if (status !== undefined) {
      outputItem["status"] = status;
    }

    output.push(Object.freeze(outputItem));
  }

  return Object.freeze(output);
}

function readLauncherApps(value: PlainJson | undefined): readonly ChromeLauncherApp[] {
  if (!Array.isArray(value)) {
    return EMPTY_APPS;
  }

  const output: ChromeLauncherApp[] = [];

  for (let index = 0; index < value.length; index += 1) {
    const item = value[index];

    if (item === undefined || item === null || typeof item !== "object" || Array.isArray(item)) {
      continue;
    }

    const id = readString(item["id"]);
    const name = readString(item["name"]);

    if (id.length === 0 || name.length === 0) {
      continue;
    }

    const app: {
      id: string;
      name: string;
      subtitle?: string;
      keywords?: readonly string[];
      icon?: string;
    } = {
      id,
      name,
    };
    const subtitle = readOptionalString(item["subtitle"]);
    const icon = readOptionalString(item["icon"]);
    const keywords = readStringList(item["keywords"]);

    if (subtitle !== undefined) app.subtitle = subtitle;
    if (icon !== undefined) app.icon = icon;
    if (keywords.length > 0) app.keywords = keywords;
    output.push(Object.freeze(app));
  }

  return Object.freeze(output);
}

function readNotifications(value: PlainJson | undefined): readonly ChromeNotification[] {
  if (!Array.isArray(value)) {
    return EMPTY_NOTIFICATIONS;
  }

  const output: ChromeNotification[] = [];

  for (let index = 0; index < value.length; index += 1) {
    const item = value[index];

    if (item === undefined || item === null || typeof item !== "object" || Array.isArray(item)) {
      continue;
    }

    const id = readString(item["id"]);
    const title = readString(item["title"]);

    if (id.length === 0 || title.length === 0) {
      continue;
    }

    const notification: {
      id: string;
      title: string;
      severity: ChromeNotificationSeverity;
      createdAtMs: number;
      body?: string;
      source?: string;
      expiresAtMs?: number;
    } = {
      createdAtMs: normalizeTimestamp(item["createdAtMs"]),
      id,
      severity: readSeverity(item["severity"]),
      title,
    };
    const body = readOptionalString(item["body"]);
    const source = readOptionalString(item["source"]);
    const expiresAtMs = readOptionalNumber(item["expiresAtMs"]);

    if (body !== undefined) notification.body = body;
    if (source !== undefined) notification.source = source;
    if (expiresAtMs !== undefined) notification.expiresAtMs = normalizeTimestamp(expiresAtMs);
    output.push(freezeNotification(notification));
  }

  output.sort(compareNotifications);
  return Object.freeze(output);
}

function countCriticalNotifications(notifications: readonly ChromeNotification[]): number {
  let count = 0;

  for (let index = 0; index < notifications.length; index += 1) {
    if (notifications[index]?.severity === "critical") {
      count += 1;
    }
  }

  return count;
}

function readStringList(value: PlainJson | undefined): readonly string[] {
  if (!Array.isArray(value)) {
    return Object.freeze([]);
  }

  const output: string[] = [];

  for (let index = 0; index < value.length; index += 1) {
    const item = value[index];

    if (typeof item === "string") {
      output.push(item);
    }
  }

  return Object.freeze(output);
}

function readEdge(value: PlainJson | undefined): ChromePanelEdge {
  return value === "bottom" ? "bottom" : "top";
}

function readTrayStatus(value: PlainJson | undefined): ChromeTrayStatus | undefined {
  if (value === "ok" || value === "warning" || value === "critical" || value === "offline") {
    return value;
  }

  return undefined;
}

function readSeverity(value: PlainJson | undefined): ChromeNotificationSeverity {
  if (value === "success" || value === "warning" || value === "critical") {
    return value;
  }

  return "info";
}

function readString(value: PlainJson | undefined): string {
  return typeof value === "string" ? value : "";
}

function readOptionalString(value: PlainJson | undefined): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function readOptionalNumber(value: PlainJson | undefined): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function normalizeCount(value: PlainJson | number | undefined): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(0, Math.trunc(value))
    : 0;
}

function normalizeTimestamp(value: PlainJson | number | undefined): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.trunc(value)
    : 0;
}

function normalizePositiveDuration(value: number): number | undefined {
  if (!Number.isFinite(value)) {
    return undefined;
  }

  const duration = Math.trunc(value);
  return duration > 0 ? duration : undefined;
}

function normalizeSearch(value: string): string {
  return value.trim().toLocaleLowerCase("en-US");
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
