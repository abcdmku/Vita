import {
  createFileManagerState,
  createSettingsAppState,
  hasDesktopCapabilityGrant,
  joinCapabilityPath,
  loadFileManagerDirectory,
  requestSettingsApply,
  settleSettingsControlPlaneResult,
} from "../../../sdk/typescript/src/desktop-sdk/index.ts";
import type {
  AppError,
  DesktopCapability,
  DesktopUiPackageManifest,
  FilesCapabilityPort,
  FilesEntry,
  NotificationCenter,
  NotificationCenterSnapshot,
  SettingsControlPlanePort,
  SettingsManagedConfig,
  SettingsValue,
  SettingsWidget,
  ShellNotification,
  TrayItem,
  TrayModel,
  TraySnapshot,
  TrayStatus,
} from "../../../sdk/typescript/src/desktop-sdk/index.ts";
import type {
  WidgetInstance,
  WidgetKind,
  WidgetPlacement,
  WidgetSizeClass,
} from "./widget-host.ts";

export type FirstPartyWidgetKind = WidgetKind | "quick-settings" | "status-tray";
export type WidgetDataStatus = "ready" | "placeholder" | "forbidden" | "error";
export type ClockCalendarWidgetKind = "clock" | "calendar";

export interface WidgetDataInstance<K extends FirstPartyWidgetKind = FirstPartyWidgetKind> {
  readonly id: string;
  readonly kind: K;
  readonly placement: WidgetPlacement;
  readonly sizeClass: WidgetSizeClass;
  readonly enabled: boolean;
  readonly paused: boolean;
  readonly refreshIntervalMs: number;
}

export type WidgetDataState<K extends FirstPartyWidgetKind, Data> = WidgetDataInstance<K> & {
  readonly clockMs: number;
  readonly data: Data;
  readonly placeholder: boolean;
  readonly status: WidgetDataStatus;
};

export interface WidgetViewModelError {
  readonly code: string;
  readonly message: string;
  readonly path: string;
}

export interface ClockCalendarFields {
  readonly epochMs: number;
  readonly isoDateTime: string;
  readonly date: string;
  readonly time: string;
  readonly timeShort: string;
  readonly year: number;
  readonly month: number;
  readonly monthIndex: number;
  readonly monthLabel: string;
  readonly day: number;
  readonly weekdayIndex: number;
  readonly weekdayLabel: string;
  readonly hours24: number;
  readonly minutes: number;
  readonly seconds: number;
}

export interface CalendarCell {
  readonly date: string;
  readonly day: number;
  readonly inMonth: boolean;
  readonly month: number;
  readonly monthIndex: number;
  readonly today: boolean;
  readonly weekdayIndex: number;
  readonly year: number;
}

export interface CalendarWeek {
  readonly index: number;
  readonly cells: readonly CalendarCell[];
}

export interface CalendarMonthGrid {
  readonly year: number;
  readonly month: number;
  readonly monthIndex: number;
  readonly monthLabel: string;
  readonly firstWeekdayIndex: number;
  readonly weeks: readonly CalendarWeek[];
}

export interface ClockCalendarWidgetData {
  readonly clock: ClockCalendarFields;
  readonly calendar: CalendarMonthGrid;
}

export type ClockCalendarWidgetState = WidgetDataState<FirstPartyWidgetKind, ClockCalendarWidgetData>;

export interface ClockCalendarWidgetViewModel {
  readonly state: ClockCalendarWidgetState;
  refresh(clockMs: number): ClockCalendarWidgetState;
}

export interface ClockCalendarWidgetViewModelInput {
  readonly instance: WidgetDataInstance;
  readonly initialClockMs?: number;
}

export interface RecentFilesWidgetEntry {
  readonly kind: FilesEntry["kind"];
  readonly modified: string;
  readonly name: string;
  readonly path: string;
  readonly size: number;
}

export interface RecentFilesWidgetData {
  readonly entries: readonly RecentFilesWidgetEntry[];
  readonly limit: number;
  readonly path: string;
  readonly error?: WidgetViewModelError;
}

export type RecentFilesWidgetState = WidgetDataState<FirstPartyWidgetKind, RecentFilesWidgetData>;

export interface RecentFilesWidgetViewModel {
  readonly state: RecentFilesWidgetState;
  refresh(clockMs: number): Promise<RecentFilesWidgetState>;
}

export interface RecentFilesWidgetViewModelInput extends CapabilityGatedWidgetInput {
  readonly instance: WidgetDataInstance;
  readonly files?: FilesCapabilityPort;
  readonly filesGrant?: string;
  readonly limit?: number;
  readonly path?: string;
}

export interface QuickSettingDefinition {
  readonly categoryId: string;
  readonly settingId: string;
  readonly iconRef?: string;
  readonly id?: string;
  readonly label?: string;
}

export interface QuickSettingControlState {
  readonly available: boolean;
  readonly categoryId: string;
  readonly disabled: boolean;
  readonly enabled: boolean;
  readonly id: string;
  readonly label: string;
  readonly settingId: string;
  readonly value: boolean;
  readonly iconRef?: string;
}

export interface QuickSettingsWidgetData {
  readonly controls: readonly QuickSettingControlState[];
  readonly revision: string;
  readonly error?: WidgetViewModelError;
}

export type QuickSettingsWidgetState = WidgetDataState<FirstPartyWidgetKind, QuickSettingsWidgetData>;

export type QuickSettingsActionResult =
  | {
      readonly ok: true;
      readonly state: QuickSettingsWidgetState;
    }
  | {
      readonly ok: false;
      readonly error: WidgetViewModelError;
      readonly state: QuickSettingsWidgetState;
    };

export interface QuickSettingsWidgetViewModel {
  readonly state: QuickSettingsWidgetState;
  refresh(clockMs: number): QuickSettingsWidgetState;
  toggle(controlId: string, clockMs: number): Promise<QuickSettingsActionResult>;
}

export interface QuickSettingsWidgetViewModelInput extends CapabilityGatedWidgetInput {
  readonly config: SettingsManagedConfig;
  readonly instance: WidgetDataInstance;
  readonly controls?: readonly QuickSettingDefinition[];
  readonly limit?: number;
  readonly settings?: SettingsControlPlanePort;
}

export interface StatusTrayItemState {
  readonly appId: string;
  readonly iconRef: string;
  readonly id: string;
  readonly order: number;
  readonly tooltip: string;
  readonly status?: TrayStatus;
}

export interface StatusTrayNotificationState {
  readonly appId: string;
  readonly createdAtMs: number;
  readonly id: string;
  readonly priority: ShellNotification["priority"];
  readonly title: string;
}

export interface StatusTrayWidgetData {
  readonly notificationCount: number;
  readonly notifications: readonly StatusTrayNotificationState[];
  readonly overflowCount: number;
  readonly status: TrayStatus | "neutral";
  readonly statusItems: readonly StatusTrayItemState[];
  readonly trayCount: number;
  readonly unreadCount: number;
  readonly error?: WidgetViewModelError;
}

export type StatusTrayWidgetState = WidgetDataState<FirstPartyWidgetKind, StatusTrayWidgetData>;

export interface StatusTrayWidgetViewModel {
  readonly state: StatusTrayWidgetState;
  refresh(clockMs: number): StatusTrayWidgetState;
}

export type StatusTrayPort = Pick<TrayModel, "snapshot">;
export type StatusNotificationPort = Pick<NotificationCenter, "snapshot">;

export interface StatusTrayWidgetViewModelInput extends CapabilityGatedWidgetInput {
  readonly instance: WidgetDataInstance;
  readonly notificationCenter?: StatusNotificationPort;
  readonly notifications?: StatusNotificationPort;
  readonly tray?: StatusTrayPort;
  readonly trayModel?: StatusTrayPort;
}

interface CapabilityGatedWidgetInput {
  readonly initialClockMs?: number;
  readonly manifest?: DesktopUiPackageManifest;
  readonly package?: DesktopUiPackageManifest;
}

interface NormalizedQuickSettingDefinition {
  readonly categoryId: string;
  readonly id: string;
  readonly label: string;
  readonly settingId: string;
  readonly iconRef?: string;
}

type SnapshotResult<T> =
  | {
      readonly ok: true;
      readonly value: T;
    }
  | {
      readonly ok: false;
      readonly error: WidgetViewModelError;
    };

const DEFAULT_RECENT_FILES_PATH = "/recents";
const DEFAULT_RECENT_FILES_GRANT = "recents";
const DEFAULT_RECENT_FILES_LIMIT = 6;
const DEFAULT_QUICK_SETTINGS_LIMIT = 4;
const EMPTY_RECENT_FILES = Object.freeze([]) satisfies readonly RecentFilesWidgetEntry[];
const EMPTY_QUICK_SETTINGS = Object.freeze([]) satisfies readonly QuickSettingControlState[];
const EMPTY_STATUS_ITEMS = Object.freeze([]) satisfies readonly StatusTrayItemState[];
const EMPTY_STATUS_NOTIFICATIONS = Object.freeze([]) satisfies readonly StatusTrayNotificationState[];
const WEEKDAY_LABELS = Object.freeze(["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"] as const);
const MONTH_LABELS = Object.freeze([
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
] as const);

export function createClockCalendarWidgetViewModel(
  input: ClockCalendarWidgetViewModelInput,
): ClockCalendarWidgetViewModel {
  let state = createClockCalendarWidgetState(input.instance, input.initialClockMs ?? 0);

  return Object.freeze({
    get state() {
      return state;
    },
    refresh(clockMs: number): ClockCalendarWidgetState {
      state = createClockCalendarWidgetState(input.instance, clockMs);
      return state;
    },
  });
}

export const createClockWidgetViewModel = createClockCalendarWidgetViewModel;
export const createCalendarWidgetViewModel = createClockCalendarWidgetViewModel;

export function createClockCalendarWidgetState(
  instance: WidgetDataInstance,
  clockMs: number,
): ClockCalendarWidgetState {
  const normalizedClockMs = normalizeClockMs(clockMs);
  const data = clockCalendarData(normalizedClockMs);

  return freezeWidgetDataState(instance, normalizedClockMs, "ready", false, data);
}

export function createRecentFilesWidgetViewModel(
  input: RecentFilesWidgetViewModelInput,
): RecentFilesWidgetViewModel {
  let state = placeholderRecentFilesState(input, input.initialClockMs ?? 0, "placeholder", widgetError(
    "RECENT_FILES_NOT_REFRESHED",
    "recent files widget has not been refreshed.",
    "/recentFiles",
  ));

  return Object.freeze({
    get state() {
      return state;
    },
    async refresh(clockMs: number): Promise<RecentFilesWidgetState> {
      state = await refreshRecentFilesWidgetState(input, clockMs);
      return state;
    },
  });
}

export async function refreshRecentFilesWidgetState(
  input: RecentFilesWidgetViewModelInput,
  clockMs: number,
): Promise<RecentFilesWidgetState> {
  const normalizedClockMs = normalizeClockMs(clockMs);
  const files = input.files;
  const filesGrant = normalizeGrant(input.filesGrant ?? DEFAULT_RECENT_FILES_GRANT);
  const path = normalizeCapabilityPath(input.path ?? DEFAULT_RECENT_FILES_PATH);
  const limit = normalizeLimit(input.limit, DEFAULT_RECENT_FILES_LIMIT);
  const manifest = manifestFor(input);

  if (filesGrant.length === 0 || !hasCapability(manifest, "files.read", filesGrant)) {
    return recentFilesState(input.instance, normalizedClockMs, "forbidden", true, path, limit, EMPTY_RECENT_FILES, widgetError(
      "MISSING_CAPABILITY",
      "files.read grant is required to refresh recent files.",
      "/capabilityGrants/files.read",
    ));
  }

  if (files === undefined) {
    return recentFilesState(input.instance, normalizedClockMs, "placeholder", true, path, limit, EMPTY_RECENT_FILES, widgetError(
      "FILES_PORT_UNAVAILABLE",
      "files capability port is unavailable.",
      "/files",
    ));
  }

  const transition = await loadFileManagerDirectory(
    files,
    createFileManagerState({
      grant: filesGrant,
      path,
    }),
    path,
  );
  const status = transition.state.status === "ready" ? "ready" : fileStatusToWidgetStatus(transition.state.status);

  if (transition.state.status !== "ready") {
    return recentFilesState(
      input.instance,
      normalizedClockMs,
      status,
      true,
      path,
      limit,
      EMPTY_RECENT_FILES,
      transition.state.error === undefined ? undefined : fromAppError(transition.state.error),
    );
  }

  return recentFilesState(
    input.instance,
    normalizedClockMs,
    "ready",
    false,
    path,
    limit,
    recentFileEntries(path, transition.state.entries, limit),
  );
}

export const createRecentFilesWidgetState = refreshRecentFilesWidgetState;

export function createQuickSettingsWidgetViewModel(
  input: QuickSettingsWidgetViewModelInput,
): QuickSettingsWidgetViewModel {
  const definitions = normalizeQuickSettingDefinitions(
    input.config,
    input.controls,
    normalizeLimit(input.limit, DEFAULT_QUICK_SETTINGS_LIMIT),
  );
  let config = createSettingsAppState(input.config).config;
  let state = createQuickSettingsWidgetState({
    ...input,
    config,
    controls: definitions,
  }, input.initialClockMs ?? 0);

  return Object.freeze({
    get state() {
      return state;
    },
    refresh(clockMs: number): QuickSettingsWidgetState {
      state = createQuickSettingsWidgetState({
        ...input,
        config,
        controls: definitions,
      }, clockMs);
      return state;
    },
    async toggle(controlId: string, clockMs: number): Promise<QuickSettingsActionResult> {
      const control = findQuickSettingControl(state.data.controls, controlId);

      if (control === undefined) {
        const error = widgetError("UNKNOWN_QUICK_SETTING", "quick setting is not present.", "/quickSettings/controlId");

        state = quickSettingsStateWithError(state, error);
        return rejectQuickSettings(error, state);
      }

      const settings = input.settings;
      const manifest = manifestFor(input);

      if (settings === undefined) {
        const error = widgetError("SETTINGS_PORT_UNAVAILABLE", "settings control-plane port is unavailable.", "/settings");

        state = createQuickSettingsWidgetState({
          ...input,
          config,
          controls: definitions,
        }, clockMs, error);
        return rejectQuickSettings(error, state);
      }

      if (!hasCapability(manifest, "settings.write", control.settingId)) {
        const error = widgetError(
          "MISSING_CAPABILITY",
          "settings.write grant is required to toggle quick settings.",
          `/capabilityGrants/settings.write/${pathToken(control.settingId)}`,
        );

        state = createQuickSettingsWidgetState({
          ...input,
          config,
          controls: definitions,
        }, clockMs, error);
        return rejectQuickSettings(error, state);
      }

      const edit = Object.freeze({
        categoryId: control.categoryId,
        settingId: control.settingId,
        value: !control.value,
      });
      const apply = requestSettingsApply(createSettingsAppState(config, control.categoryId), edit);

      if (!apply.ok) {
        const error = fromAppError(apply.error);

        state = quickSettingsStateWithError(state, error);
        return rejectQuickSettings(error, state);
      }

      if (apply.value.intent.type !== "control-plane.apply") {
        const error = widgetError("INVALID_SETTINGS_INTENT", "settings apply produced an unexpected intent.", "/settings/apply");

        state = quickSettingsStateWithError(state, error);
        return rejectQuickSettings(error, state);
      }

      let result: Awaited<ReturnType<SettingsControlPlanePort["apply"]>>;

      try {
        result = await settings.apply(apply.value.intent);
      } catch {
        const error = widgetError("SETTINGS_APPLY_FAILED", "settings apply failed closed.", "/settings/apply");

        state = quickSettingsStateWithError(state, error);
        return rejectQuickSettings(error, state);
      }

      if (!result.ok) {
        const error = fromAppError(result.error);

        state = quickSettingsStateWithError(state, error);
        return rejectQuickSettings(error, state);
      }

      config = settleSettingsControlPlaneResult(apply.value.state, apply.value.intent, result).config;
      state = createQuickSettingsWidgetState({
        ...input,
        config,
        controls: definitions,
      }, clockMs);

      return Object.freeze({
        ok: true,
        state,
      });
    },
  });
}

export function createQuickSettingsWidgetState(
  input: QuickSettingsWidgetViewModelInput,
  clockMs: number,
  error?: WidgetViewModelError,
): QuickSettingsWidgetState {
  const normalizedClockMs = normalizeClockMs(clockMs);
  const definitions = isNormalizedQuickSettingDefinitions(input.controls)
    ? input.controls
    : normalizeQuickSettingDefinitions(
      input.config,
      input.controls,
      normalizeLimit(input.limit, DEFAULT_QUICK_SETTINGS_LIMIT),
    );
  const manifest = manifestFor(input);
  const settingsAvailable = input.settings !== undefined;
  const controls = quickSettingControls(input.config, definitions, settingsAvailable, manifest);
  const allUnavailable = controls.length > 0 && countAvailableQuickSettings(controls) === 0;
  const status: WidgetDataStatus = error !== undefined
    ? "error"
    : settingsAvailable && !allUnavailable
      ? "ready"
      : allUnavailable
        ? "forbidden"
        : "placeholder";
  const placeholder = status !== "ready";

  const dataInput: {
    controls: readonly QuickSettingControlState[];
    revision: string;
    error?: WidgetViewModelError;
  } = {
    controls,
    revision: input.config.revision,
  };

  if (error !== undefined) dataInput.error = error;

  return freezeWidgetDataState(input.instance, normalizedClockMs, status, placeholder, freezeQuickSettingsData(dataInput));
}

export function createStatusTrayWidgetViewModel(
  input: StatusTrayWidgetViewModelInput,
): StatusTrayWidgetViewModel {
  let state = createStatusTrayWidgetState(input, input.initialClockMs ?? 0);

  return Object.freeze({
    get state() {
      return state;
    },
    refresh(clockMs: number): StatusTrayWidgetState {
      state = createStatusTrayWidgetState(input, clockMs);
      return state;
    },
  });
}

export function createStatusTrayWidgetState(
  input: StatusTrayWidgetViewModelInput,
  clockMs: number,
): StatusTrayWidgetState {
  const normalizedClockMs = normalizeClockMs(clockMs);
  const manifest = manifestFor(input);

  if (!hasCapability(manifest, "shell.tray.register") || !hasCapability(manifest, "shell.notifications.post")) {
    return placeholderStatusTrayState(input.instance, normalizedClockMs, widgetError(
      "MISSING_CAPABILITY",
      "tray and notification grants are required to refresh status.",
      "/capabilityGrants",
    ), "forbidden");
  }

  const tray = input.trayModel ?? input.tray;
  const notifications = input.notificationCenter ?? input.notifications;

  if (tray === undefined || notifications === undefined) {
    return placeholderStatusTrayState(input.instance, normalizedClockMs, widgetError(
      "STATUS_PORT_UNAVAILABLE",
      "tray and notification snapshots are unavailable.",
      "/status",
    ), "placeholder");
  }

  const traySnapshot = callSnapshot(() => tray.snapshot(), "TRAY_SNAPSHOT_FAILED", "tray snapshot failed closed.", "/tray/snapshot");
  const notificationSnapshot = callSnapshot(
    () => notifications.snapshot(),
    "NOTIFICATION_SNAPSHOT_FAILED",
    "notification snapshot failed closed.",
    "/notifications/snapshot",
  );

  if (!traySnapshot.ok) {
    return placeholderStatusTrayState(input.instance, normalizedClockMs, traySnapshot.error, "error");
  }
  if (!notificationSnapshot.ok) {
    return placeholderStatusTrayState(input.instance, normalizedClockMs, notificationSnapshot.error, "error");
  }

  const statusItems = trayStatusItems(traySnapshot.value);
  const notificationItems = statusNotifications(notificationSnapshot.value);

  return freezeWidgetDataState(input.instance, normalizedClockMs, "ready", false, freezeStatusTrayData({
    notificationCount: notificationSnapshot.value.totalCount,
    notifications: notificationItems,
    overflowCount: notificationSnapshot.value.overflowCount,
    status: aggregateTrayStatus(statusItems),
    statusItems,
    trayCount: traySnapshot.value.totalCount,
    unreadCount: notificationSnapshot.value.totalCount,
  }));
}

function placeholderRecentFilesState(
  input: RecentFilesWidgetViewModelInput,
  clockMs: number,
  status: WidgetDataStatus,
  error: WidgetViewModelError,
): RecentFilesWidgetState {
  return recentFilesState(
    input.instance,
    normalizeClockMs(clockMs),
    status,
    true,
    normalizeCapabilityPath(input.path ?? DEFAULT_RECENT_FILES_PATH),
    normalizeLimit(input.limit, DEFAULT_RECENT_FILES_LIMIT),
    EMPTY_RECENT_FILES,
    error,
  );
}

function recentFilesState(
  instance: WidgetDataInstance,
  clockMs: number,
  status: WidgetDataStatus,
  placeholder: boolean,
  path: string,
  limit: number,
  entries: readonly RecentFilesWidgetEntry[],
  error?: WidgetViewModelError,
): RecentFilesWidgetState {
  const dataInput: {
    entries: readonly RecentFilesWidgetEntry[];
    limit: number;
    path: string;
    error?: WidgetViewModelError;
  } = {
    entries,
    limit,
    path,
  };

  if (error !== undefined) dataInput.error = error;

  return freezeWidgetDataState(instance, clockMs, status, placeholder, freezeRecentFilesData(dataInput));
}

function placeholderStatusTrayState(
  instance: WidgetDataInstance,
  clockMs: number,
  error: WidgetViewModelError,
  status: Exclude<WidgetDataStatus, "ready">,
): StatusTrayWidgetState {
  return freezeWidgetDataState(instance, clockMs, status, true, freezeStatusTrayData({
    error,
    notificationCount: 0,
    notifications: EMPTY_STATUS_NOTIFICATIONS,
    overflowCount: 0,
    status: "neutral",
    statusItems: EMPTY_STATUS_ITEMS,
    trayCount: 0,
    unreadCount: 0,
  }));
}

function clockCalendarData(clockMs: number): ClockCalendarWidgetData {
  const date = new Date(clockMs);
  const year = date.getUTCFullYear();
  const monthIndex = date.getUTCMonth();
  const day = date.getUTCDate();
  const hours24 = date.getUTCHours();
  const minutes = date.getUTCMinutes();
  const seconds = date.getUTCSeconds();
  const weekdayIndex = date.getUTCDay();
  const calendar = calendarMonthGrid(year, monthIndex, day);
  const clock = Object.freeze({
    date: formatDate(year, monthIndex, day),
    day,
    epochMs: clockMs,
    hours24,
    isoDateTime: date.toISOString(),
    minutes,
    month: monthIndex + 1,
    monthIndex,
    monthLabel: labelAt(MONTH_LABELS, monthIndex),
    seconds,
    time: `${pad2(hours24)}:${pad2(minutes)}:${pad2(seconds)}`,
    timeShort: `${pad2(hours24)}:${pad2(minutes)}`,
    weekdayIndex,
    weekdayLabel: labelAt(WEEKDAY_LABELS, weekdayIndex),
    year,
  }) satisfies ClockCalendarFields;

  return Object.freeze({
    calendar,
    clock,
  });
}

function calendarMonthGrid(year: number, monthIndex: number, todayDay: number): CalendarMonthGrid {
  const firstWeekdayIndex = new Date(Date.UTC(year, monthIndex, 1)).getUTCDay();
  const daysInMonth = new Date(Date.UTC(year, monthIndex + 1, 0)).getUTCDate();
  const cellCount = Math.ceil((firstWeekdayIndex + daysInMonth) / 7) * 7;
  const weeks: CalendarWeek[] = [];

  for (let weekIndex = 0; weekIndex < cellCount / 7; weekIndex += 1) {
    const cells: CalendarCell[] = [];

    for (let weekdayIndex = 0; weekdayIndex < 7; weekdayIndex += 1) {
      const offset = weekIndex * 7 + weekdayIndex - firstWeekdayIndex + 1;
      const cellDate = new Date(Date.UTC(year, monthIndex, offset));
      const cellYear = cellDate.getUTCFullYear();
      const cellMonthIndex = cellDate.getUTCMonth();
      const cellDay = cellDate.getUTCDate();
      const inMonth = cellYear === year && cellMonthIndex === monthIndex;

      cells.push(Object.freeze({
        date: formatDate(cellYear, cellMonthIndex, cellDay),
        day: cellDay,
        inMonth,
        month: cellMonthIndex + 1,
        monthIndex: cellMonthIndex,
        today: inMonth && cellDay === todayDay,
        weekdayIndex,
        year: cellYear,
      }));
    }

    weeks.push(Object.freeze({
      cells: Object.freeze(cells),
      index: weekIndex,
    }));
  }

  return Object.freeze({
    firstWeekdayIndex,
    month: monthIndex + 1,
    monthIndex,
    monthLabel: labelAt(MONTH_LABELS, monthIndex),
    weeks: Object.freeze(weeks),
    year,
  });
}

function recentFileEntries(
  directoryPath: string,
  entries: readonly FilesEntry[],
  limit: number,
): readonly RecentFilesWidgetEntry[] {
  if (entries.length === 0 || limit === 0) return EMPTY_RECENT_FILES;

  const output: RecentFilesWidgetEntry[] = [];

  for (let index = 0; index < entries.length && output.length < limit; index += 1) {
    const entry = entries[index];

    if (entry === undefined) continue;
    output.push(Object.freeze({
      kind: entry.kind,
      modified: entry.mtime,
      name: entry.name,
      path: joinCapabilityPath(directoryPath, entry.name),
      size: entry.size,
    }));
  }

  return Object.freeze(output);
}

function normalizeQuickSettingDefinitions(
  config: SettingsManagedConfig,
  definitions: readonly QuickSettingDefinition[] | readonly NormalizedQuickSettingDefinition[] | undefined,
  limit: number,
): readonly NormalizedQuickSettingDefinition[] {
  const output: NormalizedQuickSettingDefinition[] = [];
  const seen = new Set<string>();

  if (definitions !== undefined) {
    for (let index = 0; index < definitions.length && output.length < limit; index += 1) {
      const definition = definitions[index];

      if (definition === undefined) continue;
      const widget = findSettingsWidget(config, definition.categoryId, definition.settingId);
      const id = normalizeControlId(definition.id ?? definition.settingId);

      if (id.length === 0 || seen.has(id)) continue;
      seen.add(id);
      const normalized: {
        categoryId: string;
        id: string;
        label: string;
        settingId: string;
        iconRef?: string;
      } = {
        categoryId: definition.categoryId,
        id,
        label: definition.label ?? widget?.label ?? definition.settingId,
        settingId: definition.settingId,
      };

      if (definition.iconRef !== undefined) normalized.iconRef = definition.iconRef;
      output.push(freezeQuickSettingDefinition(normalized));
    }

    return Object.freeze(output);
  }

  for (let categoryIndex = 0; categoryIndex < config.categories.length && output.length < limit; categoryIndex += 1) {
    const category = config.categories[categoryIndex];

    if (category === undefined) continue;
    for (let settingIndex = 0; settingIndex < category.settings.length && output.length < limit; settingIndex += 1) {
      const setting = category.settings[settingIndex];

      if (setting === undefined || setting.kind !== "toggle" || seen.has(setting.id)) continue;
      seen.add(setting.id);
      output.push(freezeQuickSettingDefinition({
        categoryId: category.id,
        id: setting.id,
        label: setting.label,
        settingId: setting.id,
      }));
    }
  }

  return Object.freeze(output);
}

function quickSettingControls(
  config: SettingsManagedConfig,
  definitions: readonly NormalizedQuickSettingDefinition[],
  settingsAvailable: boolean,
  manifest: DesktopUiPackageManifest | undefined,
): readonly QuickSettingControlState[] {
  if (definitions.length === 0) return EMPTY_QUICK_SETTINGS;

  const output: QuickSettingControlState[] = [];

  for (let index = 0; index < definitions.length; index += 1) {
    const definition = definitions[index];

    if (definition === undefined) continue;
    const setting = findSettingsWidget(config, definition.categoryId, definition.settingId);
    const canToggle = settingsAvailable &&
      setting !== undefined &&
      setting.kind === "toggle" &&
      typeof setting.value === "boolean" &&
      hasCapability(manifest, "settings.write", definition.settingId);
    const value = canToggle ? setting.value === true : false;
    const control: {
      available: boolean;
      categoryId: string;
      disabled: boolean;
      enabled: boolean;
      id: string;
      label: string;
      settingId: string;
      value: boolean;
      iconRef?: string;
    } = {
      available: canToggle,
      categoryId: definition.categoryId,
      disabled: !canToggle,
      enabled: value,
      id: definition.id,
      label: definition.label,
      settingId: definition.settingId,
      value,
    };

    if (definition.iconRef !== undefined) control.iconRef = definition.iconRef;
    output.push(Object.freeze(control));
  }

  return Object.freeze(output);
}

function findQuickSettingControl(
  controls: readonly QuickSettingControlState[],
  controlId: string,
): QuickSettingControlState | undefined {
  for (let index = 0; index < controls.length; index += 1) {
    const control = controls[index];

    if (control !== undefined && (control.id === controlId || control.settingId === controlId)) return control;
  }

  return undefined;
}

function findSettingsWidget(
  config: SettingsManagedConfig,
  categoryId: string,
  settingId: string,
): SettingsWidget | undefined {
  for (let categoryIndex = 0; categoryIndex < config.categories.length; categoryIndex += 1) {
    const category = config.categories[categoryIndex];

    if (category === undefined || category.id !== categoryId) continue;

    for (let settingIndex = 0; settingIndex < category.settings.length; settingIndex += 1) {
      const setting = category.settings[settingIndex];

      if (setting !== undefined && setting.id === settingId) return setting;
    }
  }

  return undefined;
}

function countAvailableQuickSettings(controls: readonly QuickSettingControlState[]): number {
  let count = 0;

  for (let index = 0; index < controls.length; index += 1) {
    if (controls[index]?.available === true) count += 1;
  }

  return count;
}

function isNormalizedQuickSettingDefinitions(
  definitions: readonly QuickSettingDefinition[] | readonly NormalizedQuickSettingDefinition[] | undefined,
): definitions is readonly NormalizedQuickSettingDefinition[] {
  if (definitions === undefined) return false;

  for (let index = 0; index < definitions.length; index += 1) {
    const definition = definitions[index];

    if (definition === undefined) continue;
    if (definition.id === undefined || definition.label === undefined) return false;
  }

  return true;
}

function freezeQuickSettingDefinition(input: {
  readonly categoryId: string;
  readonly id: string;
  readonly label: string;
  readonly settingId: string;
  readonly iconRef?: string;
}): NormalizedQuickSettingDefinition {
  const output: {
    categoryId: string;
    id: string;
    label: string;
    settingId: string;
    iconRef?: string;
  } = {
    categoryId: input.categoryId,
    id: input.id,
    label: input.label,
    settingId: input.settingId,
  };

  if (input.iconRef !== undefined) output.iconRef = input.iconRef;

  return Object.freeze(output);
}

function trayStatusItems(snapshot: TraySnapshot): readonly StatusTrayItemState[] {
  if (snapshot.items.length === 0) return EMPTY_STATUS_ITEMS;

  const output: StatusTrayItemState[] = [];

  for (let index = 0; index < snapshot.items.length; index += 1) {
    const item = snapshot.items[index];

    if (item === undefined) continue;
    output.push(freezeStatusTrayItem(item));
  }

  output.sort(compareStatusTrayItems);
  return Object.freeze(output);
}

function statusNotifications(snapshot: NotificationCenterSnapshot): readonly StatusTrayNotificationState[] {
  if (snapshot.notifications.length === 0) return EMPTY_STATUS_NOTIFICATIONS;

  const output: StatusTrayNotificationState[] = [];

  for (let index = 0; index < snapshot.notifications.length; index += 1) {
    const notification = snapshot.notifications[index];

    if (notification === undefined) continue;
    output.push(Object.freeze({
      appId: notification.appId,
      createdAtMs: notification.createdAtMs,
      id: notification.id,
      priority: notification.priority,
      title: notification.title,
    }));
  }

  output.sort(compareStatusNotifications);
  return Object.freeze(output);
}

function aggregateTrayStatus(items: readonly StatusTrayItemState[]): TrayStatus | "neutral" {
  let current: TrayStatus | "neutral" = "neutral";

  for (let index = 0; index < items.length; index += 1) {
    const item = items[index];

    if (item?.status !== undefined && trayStatusSeverity(item.status) > trayStatusSeverity(current)) {
      current = item.status;
    }
  }

  return current;
}

function freezeStatusTrayItem(item: TrayItem): StatusTrayItemState {
  const output: {
    appId: string;
    iconRef: string;
    id: string;
    order: number;
    tooltip: string;
    status?: TrayStatus;
  } = {
    appId: item.appId,
    iconRef: item.iconRef,
    id: item.id,
    order: item.order,
    tooltip: item.tooltip,
  };

  if (item.status !== undefined) output.status = item.status;

  return Object.freeze(output);
}

function freezeRecentFilesData(input: {
  readonly entries: readonly RecentFilesWidgetEntry[];
  readonly limit: number;
  readonly path: string;
  readonly error?: WidgetViewModelError;
}): RecentFilesWidgetData {
  const output: {
    entries: readonly RecentFilesWidgetEntry[];
    limit: number;
    path: string;
    error?: WidgetViewModelError;
  } = {
    entries: input.entries,
    limit: input.limit,
    path: input.path,
  };

  if (input.error !== undefined) output.error = freezeWidgetError(input.error);
  return Object.freeze(output);
}

function freezeQuickSettingsData(input: {
  readonly controls: readonly QuickSettingControlState[];
  readonly revision: string;
  readonly error?: WidgetViewModelError;
}): QuickSettingsWidgetData {
  const output: {
    controls: readonly QuickSettingControlState[];
    revision: string;
    error?: WidgetViewModelError;
  } = {
    controls: input.controls,
    revision: input.revision,
  };

  if (input.error !== undefined) output.error = freezeWidgetError(input.error);
  return Object.freeze(output);
}

function freezeStatusTrayData(input: {
  readonly notificationCount: number;
  readonly notifications: readonly StatusTrayNotificationState[];
  readonly overflowCount: number;
  readonly status: TrayStatus | "neutral";
  readonly statusItems: readonly StatusTrayItemState[];
  readonly trayCount: number;
  readonly unreadCount: number;
  readonly error?: WidgetViewModelError;
}): StatusTrayWidgetData {
  const output: {
    notificationCount: number;
    notifications: readonly StatusTrayNotificationState[];
    overflowCount: number;
    status: TrayStatus | "neutral";
    statusItems: readonly StatusTrayItemState[];
    trayCount: number;
    unreadCount: number;
    error?: WidgetViewModelError;
  } = {
    notificationCount: input.notificationCount,
    notifications: input.notifications,
    overflowCount: input.overflowCount,
    status: input.status,
    statusItems: input.statusItems,
    trayCount: input.trayCount,
    unreadCount: input.unreadCount,
  };

  if (input.error !== undefined) output.error = freezeWidgetError(input.error);
  return Object.freeze(output);
}

function freezeWidgetDataState<K extends FirstPartyWidgetKind, Data>(
  instance: WidgetDataInstance<K>,
  clockMs: number,
  status: WidgetDataStatus,
  placeholder: boolean,
  data: Data,
): WidgetDataState<K, Data> {
  const frozenInstance = freezeWidgetInstance(instance);

  return Object.freeze({
    clockMs,
    data,
    enabled: frozenInstance.enabled,
    id: frozenInstance.id,
    kind: frozenInstance.kind,
    paused: frozenInstance.paused,
    placeholder,
    placement: frozenInstance.placement,
    refreshIntervalMs: frozenInstance.refreshIntervalMs,
    sizeClass: frozenInstance.sizeClass,
    status,
  });
}

function freezeWidgetInstance<K extends FirstPartyWidgetKind>(
  instance: WidgetDataInstance<K>,
): WidgetDataInstance<K> {
  return Object.freeze({
    enabled: instance.enabled,
    id: instance.id,
    kind: instance.kind,
    paused: instance.paused,
    placement: freezePlacement(instance.placement),
    refreshIntervalMs: instance.refreshIntervalMs,
    sizeClass: instance.sizeClass,
  });
}

function freezePlacement(placement: WidgetPlacement): WidgetPlacement {
  return Object.freeze({
    column: placement.column,
    row: placement.row,
    zone: placement.zone,
  });
}

function quickSettingsStateWithError(
  state: QuickSettingsWidgetState,
  error: WidgetViewModelError,
): QuickSettingsWidgetState {
  return freezeWidgetDataState(state, state.clockMs, "error", true, freezeQuickSettingsData({
    controls: state.data.controls,
    error,
    revision: state.data.revision,
  }));
}

function rejectQuickSettings(
  error: WidgetViewModelError,
  state: QuickSettingsWidgetState,
): QuickSettingsActionResult {
  return Object.freeze({
    error,
    ok: false,
    state,
  });
}

function callSnapshot<T>(
  read: () => T,
  code: string,
  message: string,
  path: string,
): SnapshotResult<T> {
  try {
    return Object.freeze({
      ok: true,
      value: read(),
    });
  } catch {
    return Object.freeze({
      error: widgetError(code, message, path),
      ok: false,
    });
  }
}

function manifestFor(input: CapabilityGatedWidgetInput): DesktopUiPackageManifest | undefined {
  return input.package ?? input.manifest;
}

function hasCapability(
  manifest: DesktopUiPackageManifest | undefined,
  capability: DesktopCapability,
  resourceId?: string,
): boolean {
  if (manifest === undefined) return false;

  return hasDesktopCapabilityGrant(manifest, capability, resourceId);
}

function fileStatusToWidgetStatus(status: string): WidgetDataStatus {
  if (status === "forbidden") return "forbidden";
  if (status === "error") return "error";

  return "placeholder";
}

function normalizeClockMs(clockMs: number): number {
  if (Number.isSafeInteger(clockMs) && clockMs >= 0) return clockMs;

  return 0;
}

function normalizeLimit(limit: number | undefined, fallback: number): number {
  if (limit !== undefined && Number.isSafeInteger(limit) && limit >= 0) return limit;

  return fallback;
}

function normalizeGrant(grant: string): string {
  return grant.trim();
}

function normalizeControlId(id: string): string {
  return id.trim();
}

function normalizeCapabilityPath(path: string): string {
  if (path.length === 0) return "/";

  const absolute = path.startsWith("/");
  const parts = path.split("/");
  const normalized: string[] = [];

  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index];

    if (part === undefined || part.length === 0 || part === ".") continue;
    if (part === "..") {
      normalized.pop();
      continue;
    }
    normalized.push(part);
  }

  if (absolute) {
    if (normalized.length === 0) return "/";

    return `/${normalized.join("/")}`;
  }

  if (normalized.length === 0) return ".";

  return normalized.join("/");
}

function fromAppError(error: AppError): WidgetViewModelError {
  return widgetError(error.code, error.message, error.path);
}

function widgetError(code: string, message: string, path: string): WidgetViewModelError {
  return Object.freeze({
    code,
    message,
    path,
  });
}

function freezeWidgetError(error: WidgetViewModelError): WidgetViewModelError {
  return widgetError(error.code, error.message, error.path);
}

function pathToken(value: string): string {
  return value.replaceAll("~", "~0").replaceAll("/", "~1");
}

function formatDate(year: number, monthIndex: number, day: number): string {
  return `${year}-${pad2(monthIndex + 1)}-${pad2(day)}`;
}

function pad2(value: number): string {
  return value < 10 ? `0${value}` : `${value}`;
}

function labelAt(labels: readonly string[], index: number): string {
  return labels[index] ?? "";
}

function trayStatusSeverity(status: TrayStatus | "neutral"): number {
  if (status === "critical") return 4;
  if (status === "warning") return 3;
  if (status === "offline") return 2;
  if (status === "ok") return 1;

  return 0;
}

function compareStatusTrayItems(left: StatusTrayItemState, right: StatusTrayItemState): number {
  const order = left.order - right.order;

  if (order !== 0) return order;

  const app = compareStrings(left.appId, right.appId);

  if (app !== 0) return app;

  return compareStrings(left.id, right.id);
}

function compareStatusNotifications(
  left: StatusTrayNotificationState,
  right: StatusTrayNotificationState,
): number {
  const created = right.createdAtMs - left.createdAtMs;

  if (created !== 0) return created;

  const app = compareStrings(left.appId, right.appId);

  if (app !== 0) return app;

  return compareStrings(left.id, right.id);
}

function compareStrings(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;

  return 0;
}
