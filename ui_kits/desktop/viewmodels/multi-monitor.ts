import type {
  DesktopHost,
  FilesCapabilityPort,
  Rect,
  SettingsControlPlanePort,
  ShellCapabilityPort,
  WindowModel,
  WindowState,
} from "../../../sdk/typescript/src/desktop-sdk/index.ts";
import {
  createDesktopIconGrid,
  snapIconsToGrid,
} from "./desktop-icons.ts";
import type {
  DesktopIcon,
  DesktopIconGridConfig,
  DesktopIconGridConfigInput,
  DesktopIconInput,
  DesktopIconPoint,
} from "./desktop-icons.ts";
import {
  WIDGET_KINDS,
  WIDGET_SIZE_CLASSES,
  createWidgetHostState,
  widgetSizeSpan,
} from "./widget-host.ts";
import type {
  WidgetDescriptor,
  WidgetGridSpan,
  WidgetHostModelOptions,
  WidgetHostState,
  WidgetHostZone,
  WidgetInstance,
  WidgetKind,
  WidgetPlacement,
  WidgetSizeClass,
} from "./widget-host.ts";
import type {
  WallpaperSourceRef,
} from "./wallpaper.ts";

export interface MultiMonitorDisplayBounds {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

export interface MultiMonitorDisplayInput {
  readonly id: string;
  readonly bounds: MultiMonitorDisplayBounds;
  readonly scale: number;
  readonly primary: boolean;
}

export interface MultiMonitorDisplay {
  readonly id: string;
  readonly bounds: MultiMonitorDisplayBounds;
  readonly scale: number;
  readonly primary: boolean;
}

export interface MultiMonitorPoint {
  readonly x: number;
  readonly y: number;
}

export interface MultiMonitorWallpaperInput {
  readonly displayId: string;
  readonly ref: WallpaperSourceRef | null;
}

export interface MultiMonitorOwnershipInput {
  readonly id: string;
  readonly displayId: string;
}

export interface MultiMonitorWidgetZoneInput {
  readonly displayId: string;
  readonly columns: number;
  readonly rows: number;
}

export interface MultiMonitorSurfacePorts {
  readonly files?: FilesCapabilityPort;
  readonly host?: DesktopHost;
  readonly settings?: SettingsControlPlanePort;
  readonly shell?: ShellCapabilityPort;
}

export interface MultiMonitorSurfaceModelOptions {
  readonly displays?: readonly MultiMonitorDisplayInput[];
  readonly icons?: readonly DesktopIconInput[];
  readonly iconAssignments?: readonly MultiMonitorOwnershipInput[];
  readonly iconGrid?: DesktopIconGridConfigInput;
  readonly ports?: MultiMonitorSurfacePorts;
  readonly wallpapers?: readonly MultiMonitorWallpaperInput[];
  readonly widgetAssignments?: readonly MultiMonitorOwnershipInput[];
  readonly widgetDescriptors?: readonly WidgetDescriptor[];
  readonly widgets?: readonly WidgetInstance[];
  readonly widgetZones?: readonly MultiMonitorWidgetZoneInput[];
}

export interface MultiMonitorIconOwnership {
  readonly displayId: string;
  readonly homeDisplayId: string;
  readonly icon: DesktopIcon;
  readonly iconId: string;
}

export interface MultiMonitorWidgetOwnership {
  readonly displayId: string;
  readonly homeDisplayId: string;
  readonly widget: WidgetInstance;
  readonly widgetId: string;
}

export interface MultiMonitorDisplayWallpaper {
  readonly displayId: string;
  readonly ref: WallpaperSourceRef | null;
}

export interface MultiMonitorDisplaySurface {
  readonly display: MultiMonitorDisplay;
  readonly icons: readonly DesktopIcon[];
  readonly wallpaper: WallpaperSourceRef | null;
  readonly widgets: readonly WidgetInstance[];
  readonly widgetZone: WidgetHostZone;
}

export type MultiMonitorSurfaceErrorCode =
  | "DUPLICATE_DISPLAY_ID"
  | "DUPLICATE_HOME"
  | "DUPLICATE_WALLPAPER"
  | "DUPLICATE_WIDGET_ZONE"
  | "INVALID_DISPLAY"
  | "INVALID_DISPLAY_SET"
  | "INVALID_ID"
  | "INVALID_ICON"
  | "INVALID_POINT"
  | "INVALID_RECT"
  | "INVALID_WALLPAPER"
  | "INVALID_WIDGET"
  | "INVALID_WIDGET_ZONE"
  | "UNKNOWN_DISPLAY"
  | "UNKNOWN_ICON"
  | "UNKNOWN_WIDGET";

export interface MultiMonitorSurfaceError {
  readonly code: MultiMonitorSurfaceErrorCode;
  readonly message: string;
  readonly path: string;
}

export interface MultiMonitorSurfaceState {
  readonly displays: readonly MultiMonitorDisplay[];
  readonly error: MultiMonitorSurfaceError | null;
  readonly iconGrid: DesktopIconGridConfig;
  readonly icons: readonly MultiMonitorIconOwnership[];
  readonly primaryDisplayId: string;
  readonly surfaces: readonly MultiMonitorDisplaySurface[];
  readonly wallpapers: readonly MultiMonitorDisplayWallpaper[];
  readonly widgets: readonly MultiMonitorWidgetOwnership[];
  readonly widgetState: WidgetHostState;
}

type NormalizeResult<T> =
  | {
      readonly ok: true;
      readonly value: T;
    }
  | {
      readonly error: MultiMonitorSurfaceError;
      readonly ok: false;
    };

interface IconLayoutEntry {
  readonly icon: DesktopIcon;
  readonly index: number;
  readonly nextDisplayId: string;
  readonly previousDisplayId: string;
}

interface WidgetLayoutEntry {
  readonly index: number;
  readonly nextDisplayId: string;
  readonly previousDisplayId: string;
  readonly widget: WidgetInstance;
}

const DEFAULT_DISPLAYS = Object.freeze([
  Object.freeze({
    bounds: Object.freeze({
      h: 1080,
      w: 1920,
      x: 0,
      y: 0,
    }),
    id: "primary",
    primary: true,
    scale: 1,
  }),
] satisfies readonly MultiMonitorDisplayInput[]);

const DEFAULT_WIDGET_ZONE_COLUMNS = 6;
const DEFAULT_WIDGET_ZONE_ROWS = 4;

const BOUNDS_FIELDS = Object.freeze(["h", "w", "x", "y"]);
const DISPLAY_FIELDS = Object.freeze(["bounds", "id", "primary", "scale"]);
const ICON_FIELDS = Object.freeze(["date", "iconRef", "id", "kind", "label", "position", "size"]);
const POINT_FIELDS = Object.freeze(["x", "y"]);
const RECT_FIELDS = Object.freeze(["height", "width", "x", "y"]);
const WIDGET_FIELDS = Object.freeze([
  "enabled",
  "id",
  "kind",
  "paused",
  "placement",
  "refreshIntervalMs",
  "sizeClass",
]);
const WIDGET_PLACEMENT_FIELDS = Object.freeze(["column", "row", "zone"]);
const WINDOW_MODEL_FIELDS = Object.freeze(["activeWorkspaceId", "focusStack", "windows", "workspaces"]);
const WINDOW_STATE_FIELDS = Object.freeze([
  "id",
  "maximized",
  "minimized",
  "mode",
  "order",
  "rect",
  "textureId",
  "workspaceId",
]);

export class MultiMonitorSurfaceModel {
  readonly #iconGrid: DesktopIconGridConfig;
  readonly #widgetDescriptors: readonly WidgetDescriptor[] | undefined;
  #displays: readonly MultiMonitorDisplay[];
  #error: MultiMonitorSurfaceError | null = null;
  #iconHomes = new Map<string, string>();
  #icons: readonly DesktopIcon[] = Object.freeze([]);
  #wallpapers = new Map<string, WallpaperSourceRef | null>();
  #widgetHomes = new Map<string, string>();
  #widgets: readonly WidgetInstance[] = Object.freeze([]);
  #widgetZones = new Map<string, WidgetHostZone>();

  constructor(options: MultiMonitorSurfaceModelOptions = Object.freeze({})) {
    this.#iconGrid = createDesktopIconGrid(options.iconGrid);
    this.#widgetDescriptors = options.widgetDescriptors;

    const displays = normalizeDisplaySet(options.displays ?? DEFAULT_DISPLAYS, "/displays");

    if (displays.ok) {
      this.#displays = displays.value;
    } else {
      const fallbackDisplays = normalizeDisplaySet(DEFAULT_DISPLAYS, "/displays");

      this.#displays = fallbackDisplays.ok ? fallbackDisplays.value : Object.freeze([]);
      this.#error = displays.error;
    }

    this.#widgetZones = normalizeWidgetZones(options.widgetZones ?? Object.freeze([]), this.#displays);
    this.#icons = normalizeInitialIcons(options.icons ?? Object.freeze([]));
    this.#iconHomes = normalizeHomes(
      this.#icons.map((iconValue) => iconValue.id),
      options.iconAssignments ?? Object.freeze([]),
      primaryDisplayId(this.#displays),
      displayIdSet(this.#displays),
      "iconAssignments",
    );
    this.#icons = this.#reflowIcons(actualDisplayMap(this.#icons, this.#iconHomes, this.#displays));
    this.#widgets = normalizeInitialWidgets(
      options.widgets ?? Object.freeze([]),
      options.widgetAssignments ?? Object.freeze([]),
      this.#displays,
      this.#widgetDescriptors,
      this.#widgetZones,
    );
    this.#widgetHomes = normalizeHomes(
      this.#widgets.map((widgetValue) => widgetValue.id),
      options.widgetAssignments ?? Object.freeze([]),
      primaryDisplayId(this.#displays),
      displayIdSet(this.#displays),
      "widgetAssignments",
    );
    this.#widgets = this.#reflowWidgets(actualWidgetDisplayMap(this.#widgets, this.#widgetHomes, this.#displays));
    this.#wallpapers = normalizeWallpapers(
      options.wallpapers ?? Object.freeze([]),
      displayIdSet(this.#displays),
    );
  }

  get state(): MultiMonitorSurfaceState {
    return this.snapshot();
  }

  snapshot(): MultiMonitorSurfaceState {
    const widgetState = this.#widgetState();
    const iconOwnership = this.#iconOwnership();
    const widgetOwnership = this.#widgetOwnership(widgetState);

    return freezeState({
      displays: this.#displays,
      error: this.#error,
      iconGrid: this.#iconGrid,
      icons: iconOwnership,
      primaryDisplayId: primaryDisplayId(this.#displays),
      surfaces: surfacesFor(
        this.#displays,
        iconOwnership,
        widgetOwnership,
        this.#wallpapers,
        this.#widgetZones,
      ),
      wallpapers: wallpapersFor(this.#displays, this.#wallpapers),
      widgets: widgetOwnership,
      widgetState,
    });
  }

  setDisplays(displays: unknown): MultiMonitorSurfaceState {
    const normalized = normalizeDisplaySet(displays, "/displays");

    if (!normalized.ok) {
      this.#error = normalized.error;
      return this.snapshot();
    }

    const previousIconDisplays = actualDisplayMap(this.#icons, this.#iconHomes, this.#displays);
    const previousWidgetDisplays = actualWidgetDisplayMap(this.#widgets, this.#widgetHomes, this.#displays);

    this.#displays = normalized.value;
    this.#widgetZones = normalizeWidgetZones(zonesToInputs(this.#widgetZones), this.#displays);
    this.#icons = this.#reflowIcons(previousIconDisplays);
    this.#widgets = this.#reflowWidgets(previousWidgetDisplays);
    this.#error = null;

    return this.snapshot();
  }

  setWallpaper(displayId: unknown, ref: unknown): MultiMonitorSurfaceState {
    const normalizedDisplayId = normalizeRequiredString(displayId, "/setWallpaper/displayId", "INVALID_ID");

    if (!normalizedDisplayId.ok) {
      this.#error = normalizedDisplayId.error;
      return this.snapshot();
    }
    if (!hasDisplay(this.#displays, normalizedDisplayId.value)) {
      this.#error = error("UNKNOWN_DISPLAY", "wallpaper target display is not present.", "/setWallpaper/displayId");
      return this.snapshot();
    }

    const normalizedRef = normalizeWallpaperRef(ref, "/setWallpaper/ref");

    if (!normalizedRef.ok) {
      this.#error = normalizedRef.error;
      return this.snapshot();
    }

    this.#wallpapers.set(normalizedDisplayId.value, normalizedRef.value);
    this.#error = null;

    return this.snapshot();
  }

  assignIcon(iconId: unknown, displayId: unknown): MultiMonitorSurfaceState {
    const normalizedIconId = normalizeRequiredString(iconId, "/assignIcon/iconId", "INVALID_ID");
    const normalizedDisplayId = normalizeRequiredString(displayId, "/assignIcon/displayId", "INVALID_ID");

    if (!normalizedIconId.ok) {
      this.#error = normalizedIconId.error;
      return this.snapshot();
    }
    if (!normalizedDisplayId.ok) {
      this.#error = normalizedDisplayId.error;
      return this.snapshot();
    }
    if (!hasIcon(this.#icons, normalizedIconId.value)) {
      this.#error = error("UNKNOWN_ICON", "icon id is not present.", "/assignIcon/iconId");
      return this.snapshot();
    }
    if (!hasDisplay(this.#displays, normalizedDisplayId.value)) {
      this.#error = error("UNKNOWN_DISPLAY", "icon target display is not present.", "/assignIcon/displayId");
      return this.snapshot();
    }

    const previousDisplays = actualDisplayMap(this.#icons, this.#iconHomes, this.#displays);

    this.#iconHomes.set(normalizedIconId.value, normalizedDisplayId.value);
    this.#icons = this.#reflowIcons(previousDisplays);
    this.#error = null;

    return this.snapshot();
  }

  assignWidget(widgetId: unknown, displayId: unknown): MultiMonitorSurfaceState {
    const normalizedWidgetId = normalizeRequiredString(widgetId, "/assignWidget/widgetId", "INVALID_ID");
    const normalizedDisplayId = normalizeRequiredString(displayId, "/assignWidget/displayId", "INVALID_ID");

    if (!normalizedWidgetId.ok) {
      this.#error = normalizedWidgetId.error;
      return this.snapshot();
    }
    if (!normalizedDisplayId.ok) {
      this.#error = normalizedDisplayId.error;
      return this.snapshot();
    }
    if (!hasWidget(this.#widgets, normalizedWidgetId.value)) {
      this.#error = error("UNKNOWN_WIDGET", "widget id is not present.", "/assignWidget/widgetId");
      return this.snapshot();
    }
    if (!hasDisplay(this.#displays, normalizedDisplayId.value)) {
      this.#error = error("UNKNOWN_DISPLAY", "widget target display is not present.", "/assignWidget/displayId");
      return this.snapshot();
    }

    const previousDisplays = actualWidgetDisplayMap(this.#widgets, this.#widgetHomes, this.#displays);

    this.#widgetHomes.set(normalizedWidgetId.value, normalizedDisplayId.value);
    this.#widgets = this.#reflowWidgets(previousDisplays);
    this.#error = null;

    return this.snapshot();
  }

  displayForPoint(point: unknown): MultiMonitorDisplay | null {
    const normalized = normalizePoint(point, "/point");

    if (!normalized.ok) return null;

    let selected: MultiMonitorDisplay | null = null;

    for (let index = 0; index < this.#displays.length; index += 1) {
      const display = this.#displays[index];

      if (display === undefined || !pointInsideBounds(normalized.value, display.bounds)) {
        continue;
      }

      selected = betterDisplayTie(selected, display);
    }

    return selected;
  }

  displayForWindow(input: unknown): MultiMonitorDisplay | null {
    const rect = normalizeWindowRect(input, "/window");

    if (!rect.ok) return null;

    return displayForRect(rect.value, this.#displays);
  }

  displayForWindowModel(model: unknown, windowId: unknown): MultiMonitorDisplay | null {
    const normalizedWindowId = normalizeRequiredString(windowId, "/windowId", "INVALID_ID");
    const normalizedModel = normalizeWindowModel(model, "/model");

    if (!normalizedWindowId.ok || !normalizedModel.ok) return null;

    for (let index = 0; index < normalizedModel.value.windows.length; index += 1) {
      const windowValue = normalizedModel.value.windows[index];

      if (windowValue !== undefined && windowValue.id === normalizedWindowId.value) {
        return displayForRect(windowValue.rect, this.#displays);
      }
    }

    return null;
  }

  #iconOwnership(): readonly MultiMonitorIconOwnership[] {
    const output: MultiMonitorIconOwnership[] = [];

    for (let index = 0; index < this.#icons.length; index += 1) {
      const icon = this.#icons[index];

      if (icon === undefined) continue;

      const homeDisplayId = this.#iconHomes.get(icon.id) ?? primaryDisplayId(this.#displays);
      const displayId = actualDisplayId(homeDisplayId, displayIdSet(this.#displays), primaryDisplayId(this.#displays));

      output.push(Object.freeze({
        displayId,
        homeDisplayId,
        icon,
        iconId: icon.id,
      }));
    }

    return Object.freeze(output);
  }

  #widgetOwnership(widgetState: WidgetHostState): readonly MultiMonitorWidgetOwnership[] {
    const output: MultiMonitorWidgetOwnership[] = [];

    for (let index = 0; index < widgetState.instances.length; index += 1) {
      const widget = widgetState.instances[index];

      if (widget === undefined) continue;

      const homeDisplayId = this.#widgetHomes.get(widget.id) ?? primaryDisplayId(this.#displays);
      const displayId = actualDisplayId(homeDisplayId, displayIdSet(this.#displays), primaryDisplayId(this.#displays));

      output.push(Object.freeze({
        displayId,
        homeDisplayId,
        widget,
        widgetId: widget.id,
      }));
    }

    return Object.freeze(output);
  }

  #reflowIcons(previousDisplays: ReadonlyMap<string, string>): readonly DesktopIcon[] {
    const displayIds = displayIdSet(this.#displays);
    const primaryId = primaryDisplayId(this.#displays);
    const entries: IconLayoutEntry[] = [];

    for (let index = 0; index < this.#icons.length; index += 1) {
      const icon = this.#icons[index];

      if (icon === undefined) continue;

      entries.push(Object.freeze({
        icon,
        index,
        nextDisplayId: actualDisplayId(this.#iconHomes.get(icon.id), displayIds, primaryId),
        previousDisplayId: previousDisplays.get(icon.id) ?? primaryId,
      }));
    }

    const output: DesktopIcon[] = [];

    for (let displayIndex = 0; displayIndex < this.#displays.length; displayIndex += 1) {
      const display = this.#displays[displayIndex];

      if (display === undefined) continue;

      const group = iconGroupFor(entries, display.id);
      const snapped = snapIconsToGrid(group.map((entry) => entry.icon), this.#iconGrid);

      for (let iconIndex = 0; iconIndex < snapped.length; iconIndex += 1) {
        const icon = snapped[iconIndex];

        if (icon !== undefined) output.push(icon);
      }
    }

    return Object.freeze(output);
  }

  #reflowWidgets(previousDisplays: ReadonlyMap<string, string>): readonly WidgetInstance[] {
    const displayIds = displayIdSet(this.#displays);
    const primaryId = primaryDisplayId(this.#displays);
    const entries: WidgetLayoutEntry[] = [];

    for (let index = 0; index < this.#widgets.length; index += 1) {
      const widget = this.#widgets[index];

      if (widget === undefined) continue;

      entries.push(Object.freeze({
        index,
        nextDisplayId: actualDisplayId(this.#widgetHomes.get(widget.id), displayIds, primaryId),
        previousDisplayId: previousDisplays.get(widget.id) ?? primaryId,
        widget,
      }));
    }

    const output: WidgetInstance[] = [];

    for (let displayIndex = 0; displayIndex < this.#displays.length; displayIndex += 1) {
      const display = this.#displays[displayIndex];

      if (display === undefined) continue;

      const group = widgetGroupFor(entries, display.id);
      const placed = placeWidgetGroup(group, zoneForDisplay(this.#widgetZones, display.id));

      for (let widgetIndex = 0; widgetIndex < placed.length; widgetIndex += 1) {
        const widget = placed[widgetIndex];

        if (widget !== undefined) output.push(widget);
      }
    }

    const state = this.#widgetStateFor(output);

    return state.instances;
  }

  #widgetState(): WidgetHostState {
    return this.#widgetStateFor(this.#widgets);
  }

  #widgetStateFor(instances: readonly WidgetInstance[]): WidgetHostState {
    return createWidgetHostState(widgetHostOptions(
      instances,
      zonesForDisplays(this.#displays, this.#widgetZones),
      this.#widgetDescriptors,
    ));
  }
}

export function createMultiMonitorSurfaceModel(
  options: MultiMonitorSurfaceModelOptions = Object.freeze({}),
): MultiMonitorSurfaceModel {
  return new MultiMonitorSurfaceModel(options);
}

export function createMultiMonitorSurfaceViewModel(
  options: MultiMonitorSurfaceModelOptions = Object.freeze({}),
): MultiMonitorSurfaceModel {
  return createMultiMonitorSurfaceModel(options);
}

function normalizeDisplaySet(input: unknown, path: string): NormalizeResult<readonly MultiMonitorDisplay[]> {
  if (!Array.isArray(input)) {
    return reject(error("INVALID_DISPLAY_SET", "display set must be an array.", path));
  }
  if (input.length === 0) {
    return reject(error("INVALID_DISPLAY_SET", "display set must contain at least one display.", path));
  }

  const ids = new Set<string>();
  const output: MultiMonitorDisplay[] = [];
  let primaryCount = 0;

  for (let index = 0; index < input.length; index += 1) {
    let raw: unknown;

    try {
      raw = input[index];
    } catch {
      return reject(error("INVALID_DISPLAY_SET", "display set must be stable.", `${path}/${index}`));
    }

    const normalized = normalizeDisplay(raw, `${path}/${index}`);

    if (!normalized.ok) return normalized;
    if (ids.has(normalized.value.id)) {
      return reject(error("DUPLICATE_DISPLAY_ID", "display ids must be unique.", `${path}/${index}/id`));
    }

    ids.add(normalized.value.id);
    if (normalized.value.primary) primaryCount += 1;
    output.push(normalized.value);
  }

  if (primaryCount !== 1) {
    return reject(error("INVALID_DISPLAY_SET", "display set must contain exactly one primary display.", path));
  }

  output.sort(compareDisplays);

  return accept(Object.freeze(output));
}

function normalizeDisplay(input: unknown, path: string): NormalizeResult<MultiMonitorDisplay> {
  const object = snapshotObject(input, DISPLAY_FIELDS, path, "INVALID_DISPLAY");

  if (!object.ok) return object;

  const id = normalizeRequiredString(object.value.get("id"), `${path}/id`, "INVALID_DISPLAY");
  const bounds = normalizeBounds(object.value.get("bounds"), `${path}/bounds`);
  const scale = finiteNumber(object.value.get("scale"));
  const primary = object.value.get("primary");

  if (!id.ok) return id;
  if (!bounds.ok) return bounds;
  if (scale === null || scale <= 0) {
    return reject(error("INVALID_DISPLAY", "display scale must be positive and finite.", `${path}/scale`));
  }
  if (typeof primary !== "boolean") {
    return reject(error("INVALID_DISPLAY", "display primary must be a boolean.", `${path}/primary`));
  }

  return accept(Object.freeze({
    bounds: bounds.value,
    id: id.value,
    primary,
    scale,
  }));
}

function normalizeBounds(input: unknown, path: string): NormalizeResult<MultiMonitorDisplayBounds> {
  const object = snapshotObject(input, BOUNDS_FIELDS, path, "INVALID_DISPLAY");

  if (!object.ok) return object;

  const x = finiteNumber(object.value.get("x"));
  const y = finiteNumber(object.value.get("y"));
  const w = finiteNumber(object.value.get("w"));
  const h = finiteNumber(object.value.get("h"));

  if (x === null) return reject(error("INVALID_DISPLAY", "display bounds x must be finite.", `${path}/x`));
  if (y === null) return reject(error("INVALID_DISPLAY", "display bounds y must be finite.", `${path}/y`));
  if (w === null || w <= 0) return reject(error("INVALID_DISPLAY", "display bounds w must be positive.", `${path}/w`));
  if (h === null || h <= 0) return reject(error("INVALID_DISPLAY", "display bounds h must be positive.", `${path}/h`));

  return accept(Object.freeze({
    h: Math.trunc(h),
    w: Math.trunc(w),
    x: Math.trunc(x),
    y: Math.trunc(y),
  }));
}

function normalizePoint(input: unknown, path: string): NormalizeResult<MultiMonitorPoint> {
  const object = snapshotObject(input, POINT_FIELDS, path, "INVALID_POINT");

  if (!object.ok) return object;

  const x = finiteNumber(object.value.get("x"));
  const y = finiteNumber(object.value.get("y"));

  if (x === null) return reject(error("INVALID_POINT", "point x must be finite.", `${path}/x`));
  if (y === null) return reject(error("INVALID_POINT", "point y must be finite.", `${path}/y`));

  return accept(Object.freeze({
    x: Math.trunc(x),
    y: Math.trunc(y),
  }));
}

function normalizeWindowRect(input: unknown, path: string): NormalizeResult<Rect> {
  const rect = normalizeRect(input, path);

  if (rect.ok) return rect;

  const windowValue = normalizeWindowState(input, path);

  if (windowValue.ok) return accept(windowValue.value.rect);

  return rect;
}

function normalizeRect(input: unknown, path: string): NormalizeResult<Rect> {
  const object = snapshotObject(input, RECT_FIELDS, path, "INVALID_RECT");

  if (!object.ok) return object;

  const x = finiteNumber(object.value.get("x"));
  const y = finiteNumber(object.value.get("y"));
  const width = finiteNumber(object.value.get("width"));
  const height = finiteNumber(object.value.get("height"));

  if (x === null) return reject(error("INVALID_RECT", "rect x must be finite.", `${path}/x`));
  if (y === null) return reject(error("INVALID_RECT", "rect y must be finite.", `${path}/y`));
  if (width === null || width < 0) return reject(error("INVALID_RECT", "rect width must be non-negative.", `${path}/width`));
  if (height === null || height < 0) return reject(error("INVALID_RECT", "rect height must be non-negative.", `${path}/height`));

  return accept(Object.freeze({
    height: Math.trunc(height),
    width: Math.trunc(width),
    x: Math.trunc(x),
    y: Math.trunc(y),
  }));
}

function normalizeWindowState(input: unknown, path: string): NormalizeResult<WindowState> {
  const object = snapshotObject(input, WINDOW_STATE_FIELDS, path, "INVALID_RECT");

  if (!object.ok) return object;

  const id = object.value.get("id");
  const textureId = object.value.get("textureId");
  const workspaceId = object.value.get("workspaceId");
  const mode = object.value.get("mode");
  const minimized = object.value.get("minimized");
  const maximized = object.value.get("maximized");
  const order = object.value.get("order");
  const rect = normalizeRect(object.value.get("rect"), `${path}/rect`);

  if (typeof id !== "string" || id.length === 0) {
    return reject(error("INVALID_RECT", "window id must be a non-empty string.", `${path}/id`));
  }
  if (typeof textureId !== "string" || textureId.length === 0) {
    return reject(error("INVALID_RECT", "window textureId must be a non-empty string.", `${path}/textureId`));
  }
  if (typeof workspaceId !== "string" || workspaceId.length === 0) {
    return reject(error("INVALID_RECT", "window workspaceId must be a non-empty string.", `${path}/workspaceId`));
  }
  if (mode !== "floating" && mode !== "tiled") {
    return reject(error("INVALID_RECT", "window mode is unsupported.", `${path}/mode`));
  }
  if (typeof minimized !== "boolean") {
    return reject(error("INVALID_RECT", "window minimized must be a boolean.", `${path}/minimized`));
  }
  if (typeof maximized !== "boolean") {
    return reject(error("INVALID_RECT", "window maximized must be a boolean.", `${path}/maximized`));
  }
  if (!isNonNegativeInteger(order)) {
    return reject(error("INVALID_RECT", "window order must be a non-negative integer.", `${path}/order`));
  }
  if (!rect.ok) return rect;

  return accept(Object.freeze({
    id,
    maximized,
    minimized,
    mode,
    order,
    rect: rect.value,
    textureId,
    workspaceId,
  }));
}

function normalizeWindowModel(input: unknown, path: string): NormalizeResult<WindowModel> {
  const object = snapshotObject(input, WINDOW_MODEL_FIELDS, path, "INVALID_RECT");

  if (!object.ok) return object;

  const windows = object.value.get("windows");
  const workspaces = object.value.get("workspaces");
  const activeWorkspaceId = object.value.get("activeWorkspaceId");
  const focusStack = object.value.get("focusStack");

  if (!Array.isArray(windows)) {
    return reject(error("INVALID_RECT", "window model windows must be an array.", `${path}/windows`));
  }
  if (!Array.isArray(workspaces)) {
    return reject(error("INVALID_RECT", "window model workspaces must be an array.", `${path}/workspaces`));
  }
  if (!Array.isArray(focusStack)) {
    return reject(error("INVALID_RECT", "window model focusStack must be an array.", `${path}/focusStack`));
  }
  if (typeof activeWorkspaceId !== "string" || activeWorkspaceId.length === 0) {
    return reject(error("INVALID_RECT", "window model activeWorkspaceId must be a non-empty string.", `${path}/activeWorkspaceId`));
  }

  const normalizedWindows: WindowState[] = [];

  for (let index = 0; index < windows.length; index += 1) {
    const normalizedWindow = normalizeWindowState(windows[index], `${path}/windows/${index}`);

    if (!normalizedWindow.ok) return normalizedWindow;
    normalizedWindows.push(normalizedWindow.value);
  }

  return accept(Object.freeze({
    activeWorkspaceId,
    focusStack: Object.freeze([]),
    windows: Object.freeze(normalizedWindows),
    workspaces: Object.freeze([]),
  }));
}

function normalizeRequiredString(
  input: unknown,
  path: string,
  code: MultiMonitorSurfaceErrorCode,
): NormalizeResult<string> {
  if (typeof input !== "string" || input.length === 0) {
    return reject(error(code, "value must be a non-empty string.", path));
  }

  return accept(input);
}

function normalizeWallpaperRef(input: unknown, path: string): NormalizeResult<WallpaperSourceRef | null> {
  if (input === null) return accept(null);
  if (typeof input !== "string" || input.length === 0) {
    return reject(error("INVALID_WALLPAPER", "wallpaper ref must be a non-empty string or null.", path));
  }

  return accept(input);
}

function normalizeInitialIcons(input: readonly DesktopIconInput[]): readonly DesktopIcon[] {
  const byId = new Set<string>();
  const output: DesktopIcon[] = [];

  if (!Array.isArray(input)) return Object.freeze([]);

  for (let index = 0; index < input.length; index += 1) {
    let raw: unknown;

    try {
      raw = input[index];
    } catch {
      return Object.freeze([]);
    }

    const icon = normalizeIcon(raw, `/icons/${index}`);

    if (!icon.ok || byId.has(icon.value.id)) return Object.freeze([]);
    byId.add(icon.value.id);
    output.push(icon.value);
  }

  return Object.freeze(output);
}

function normalizeIcon(input: unknown, path: string): NormalizeResult<DesktopIcon> {
  const object = snapshotObject(input, ICON_FIELDS, path, "INVALID_ICON");

  if (!object.ok) return object;

  const id = normalizeRequiredString(object.value.get("id"), `${path}/id`, "INVALID_ICON");
  const label = normalizeRequiredString(object.value.get("label"), `${path}/label`, "INVALID_ICON");
  const kind = normalizeRequiredString(object.value.get("kind"), `${path}/kind`, "INVALID_ICON");
  const iconRef = normalizeRequiredString(object.value.get("iconRef"), `${path}/iconRef`, "INVALID_ICON");
  const position = normalizePoint(object.value.get("position"), `${path}/position`);
  const date = normalizeOptionalIconDate(object.value.get("date"), `${path}/date`);
  const size = normalizeOptionalIconSize(object.value.get("size"), `${path}/size`);

  if (!id.ok) return id;
  if (!label.ok) return label;
  if (!kind.ok) return kind;
  if (!iconRef.ok) return iconRef;
  if (!position.ok) return position;
  if (!date.ok) return date;
  if (!size.ok) return size;

  const output: {
    date?: number | string;
    iconRef: string;
    id: string;
    kind: string;
    label: string;
    position: DesktopIconPoint;
    size?: number;
  } = {
    iconRef: iconRef.value,
    id: id.value,
    kind: kind.value,
    label: label.value,
    position: position.value,
  };

  if (date.value !== undefined) output.date = date.value;
  if (size.value !== undefined) output.size = size.value;

  return accept(freezeIcon(output));
}

function normalizeOptionalIconDate(
  input: unknown,
  path: string,
): NormalizeResult<number | string | undefined> {
  if (input === undefined) return accept(undefined);
  if (typeof input === "string") return accept(input);

  const value = finiteNumber(input);

  if (value === null) return reject(error("INVALID_ICON", "icon date must be a string or finite number.", path));

  return accept(Math.trunc(value));
}

function normalizeOptionalIconSize(input: unknown, path: string): NormalizeResult<number | undefined> {
  if (input === undefined) return accept(undefined);

  const value = finiteNumber(input);

  if (value === null || value < 0) {
    return reject(error("INVALID_ICON", "icon size must be a non-negative finite number.", path));
  }

  return accept(Math.trunc(value));
}

function normalizeInitialWidgets(
  widgets: readonly WidgetInstance[],
  assignments: readonly MultiMonitorOwnershipInput[],
  displays: readonly MultiMonitorDisplay[],
  descriptors: readonly WidgetDescriptor[] | undefined,
  zones: ReadonlyMap<string, WidgetHostZone>,
): readonly WidgetInstance[] {
  if (!Array.isArray(widgets)) return Object.freeze([]);

  const ids = new Set<string>();
  const normalized: WidgetInstance[] = [];

  for (let index = 0; index < widgets.length; index += 1) {
    let raw: unknown;

    try {
      raw = widgets[index];
    } catch {
      return Object.freeze([]);
    }

    const widget = normalizeWidget(raw, `/widgets/${index}`);

    if (!widget.ok || ids.has(widget.value.id)) return Object.freeze([]);
    ids.add(widget.value.id);
    normalized.push(widget.value);
  }

  const homes = normalizeHomes(
    normalized.map((widgetValue) => widgetValue.id),
    assignments,
    primaryDisplayId(displays),
    displayIdSet(displays),
    "widgetAssignments",
  );
  const displayIds = displayIdSet(displays);
  const primaryId = primaryDisplayId(displays);
  const zoned: WidgetInstance[] = [];

  for (let index = 0; index < normalized.length; index += 1) {
    const widget = normalized[index];

    if (widget === undefined) continue;
    const displayId = actualDisplayId(homes.get(widget.id), displayIds, primaryId);

    zoned.push(freezeWidget({
      enabled: widget.enabled,
      id: widget.id,
      kind: widget.kind,
      paused: widget.paused,
      placement: Object.freeze({
        column: widget.placement.column,
        row: widget.placement.row,
        zone: displayId,
      }),
      refreshIntervalMs: widget.refreshIntervalMs,
      sizeClass: widget.sizeClass,
    }));
  }

  const placed = placeWidgetEntriesForDisplays(zoned, homes, displays, zones);

  return createWidgetHostState(widgetHostOptions(
    placed,
    zonesForDisplays(displays, zones),
    descriptors,
  )).instances;
}

function normalizeWidget(input: unknown, path: string): NormalizeResult<WidgetInstance> {
  const object = snapshotObject(input, WIDGET_FIELDS, path, "INVALID_WIDGET");

  if (!object.ok) return object;

  const id = normalizeRequiredString(object.value.get("id"), `${path}/id`, "INVALID_WIDGET");
  const kind = normalizeWidgetKind(object.value.get("kind"), `${path}/kind`);
  const sizeClass = normalizeWidgetSizeClass(object.value.get("sizeClass"), `${path}/sizeClass`);
  const placement = normalizeWidgetPlacement(object.value.get("placement"), `${path}/placement`);
  const refreshIntervalMs = object.value.get("refreshIntervalMs");
  const enabled = object.value.get("enabled");
  const paused = object.value.get("paused");

  if (!id.ok) return id;
  if (!kind.ok) return kind;
  if (!sizeClass.ok) return sizeClass;
  if (!placement.ok) return placement;
  if (!isPositiveInteger(refreshIntervalMs)) {
    return reject(error("INVALID_WIDGET", "widget refreshIntervalMs must be a positive integer.", `${path}/refreshIntervalMs`));
  }
  if (typeof enabled !== "boolean") {
    return reject(error("INVALID_WIDGET", "widget enabled must be a boolean.", `${path}/enabled`));
  }
  if (typeof paused !== "boolean") {
    return reject(error("INVALID_WIDGET", "widget paused must be a boolean.", `${path}/paused`));
  }

  return accept(freezeWidget({
    enabled,
    id: id.value,
    kind: kind.value,
    paused,
    placement: placement.value,
    refreshIntervalMs,
    sizeClass: sizeClass.value,
  }));
}

function normalizeWidgetKind(input: unknown, path: string): NormalizeResult<WidgetKind> {
  if (typeof input !== "string") {
    return reject(error("INVALID_WIDGET", "widget kind must be a supported string.", path));
  }

  for (let index = 0; index < WIDGET_KINDS.length; index += 1) {
    const kind = WIDGET_KINDS[index];

    if (kind !== undefined && input === kind) return accept(kind);
  }

  return reject(error("INVALID_WIDGET", "widget kind must be supported.", path));
}

function normalizeWidgetSizeClass(input: unknown, path: string): NormalizeResult<WidgetSizeClass> {
  if (typeof input !== "string") {
    return reject(error("INVALID_WIDGET", "widget sizeClass must be a supported string.", path));
  }

  for (let index = 0; index < WIDGET_SIZE_CLASSES.length; index += 1) {
    const sizeClass = WIDGET_SIZE_CLASSES[index];

    if (sizeClass !== undefined && input === sizeClass) return accept(sizeClass);
  }

  return reject(error("INVALID_WIDGET", "widget sizeClass must be supported.", path));
}

function normalizeWidgetPlacement(input: unknown, path: string): NormalizeResult<WidgetPlacement> {
  const object = snapshotObject(input, WIDGET_PLACEMENT_FIELDS, path, "INVALID_WIDGET");

  if (!object.ok) return object;

  const zone = object.value.get("zone");
  const column = object.value.get("column");
  const row = object.value.get("row");

  if (typeof zone !== "string" || zone.length === 0) {
    return reject(error("INVALID_WIDGET", "widget placement zone must be a non-empty string.", `${path}/zone`));
  }
  if (!isNonNegativeInteger(column)) {
    return reject(error("INVALID_WIDGET", "widget placement column must be a non-negative integer.", `${path}/column`));
  }
  if (!isNonNegativeInteger(row)) {
    return reject(error("INVALID_WIDGET", "widget placement row must be a non-negative integer.", `${path}/row`));
  }

  return accept(freezePlacement({
    column,
    row,
    zone,
  }));
}

function normalizeHomes(
  ids: readonly string[],
  assignments: readonly MultiMonitorOwnershipInput[],
  primaryId: string,
  displayIds: ReadonlySet<string>,
  path: string,
): Map<string, string> {
  const output = new Map<string, string>();
  const idSet = new Set<string>(ids);

  for (let index = 0; index < ids.length; index += 1) {
    const id = ids[index];

    if (id !== undefined) output.set(id, primaryId);
  }

  if (!Array.isArray(assignments)) return output;

  const assignedIds = new Set<string>();

  for (let index = 0; index < assignments.length; index += 1) {
    const assignment = assignments[index];

    if (assignment === undefined) continue;
    if (assignedIds.has(assignment.id)) continue;
    if (!idSet.has(assignment.id) || !displayIds.has(assignment.displayId)) continue;

    assignedIds.add(assignment.id);
    output.set(assignment.id, assignment.displayId);
  }

  void path;

  return output;
}

function widgetHostOptions(
  initialInstances: readonly WidgetInstance[],
  zones: readonly WidgetHostZone[],
  descriptors: readonly WidgetDescriptor[] | undefined,
): WidgetHostModelOptions {
  if (descriptors === undefined) {
    return Object.freeze({
      initialInstances,
      zones,
    });
  }

  return Object.freeze({
    descriptors,
    initialInstances,
    zones,
  });
}

function normalizeWallpapers(
  wallpapers: readonly MultiMonitorWallpaperInput[],
  displayIds: ReadonlySet<string>,
): Map<string, WallpaperSourceRef | null> {
  const output = new Map<string, WallpaperSourceRef | null>();

  if (!Array.isArray(wallpapers)) return output;

  for (let index = 0; index < wallpapers.length; index += 1) {
    const wallpaper = wallpapers[index];

    if (wallpaper === undefined || output.has(wallpaper.displayId) || !displayIds.has(wallpaper.displayId)) {
      continue;
    }
    if (wallpaper.ref !== null && (typeof wallpaper.ref !== "string" || wallpaper.ref.length === 0)) {
      continue;
    }

    output.set(wallpaper.displayId, wallpaper.ref);
  }

  return output;
}

function normalizeWidgetZones(
  input: readonly MultiMonitorWidgetZoneInput[],
  displays: readonly MultiMonitorDisplay[],
): Map<string, WidgetHostZone> {
  const output = new Map<string, WidgetHostZone>();
  const displayIds = displayIdSet(displays);

  if (Array.isArray(input)) {
    for (let index = 0; index < input.length; index += 1) {
      const zone = input[index];

      if (zone === undefined || output.has(zone.displayId) || !displayIds.has(zone.displayId)) {
        continue;
      }
      if (!isPositiveInteger(zone.columns) || !isPositiveInteger(zone.rows)) {
        continue;
      }

      output.set(zone.displayId, Object.freeze({
        columns: zone.columns,
        id: zone.displayId,
        rows: zone.rows,
      }));
    }
  }

  for (let index = 0; index < displays.length; index += 1) {
    const display = displays[index];

    if (display === undefined || output.has(display.id)) continue;

    output.set(display.id, Object.freeze({
      columns: DEFAULT_WIDGET_ZONE_COLUMNS,
      id: display.id,
      rows: DEFAULT_WIDGET_ZONE_ROWS,
    }));
  }

  return output;
}

function zonesToInputs(zones: ReadonlyMap<string, WidgetHostZone>): readonly MultiMonitorWidgetZoneInput[] {
  const output: MultiMonitorWidgetZoneInput[] = [];

  zones.forEach((zone) => {
    output.push(Object.freeze({
      columns: zone.columns,
      displayId: zone.id,
      rows: zone.rows,
    }));
  });

  return Object.freeze(output);
}

function zonesForDisplays(
  displays: readonly MultiMonitorDisplay[],
  zones: ReadonlyMap<string, WidgetHostZone>,
): readonly WidgetHostZone[] {
  const output: WidgetHostZone[] = [];

  for (let index = 0; index < displays.length; index += 1) {
    const display = displays[index];

    if (display === undefined) continue;
    output.push(zoneForDisplay(zones, display.id));
  }

  return Object.freeze(output);
}

function zoneForDisplay(zones: ReadonlyMap<string, WidgetHostZone>, displayId: string): WidgetHostZone {
  return zones.get(displayId) ?? Object.freeze({
    columns: DEFAULT_WIDGET_ZONE_COLUMNS,
    id: displayId,
    rows: DEFAULT_WIDGET_ZONE_ROWS,
  });
}

function iconGroupFor(entries: readonly IconLayoutEntry[], displayId: string): readonly IconLayoutEntry[] {
  const output: IconLayoutEntry[] = [];

  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];

    if (entry !== undefined && entry.nextDisplayId === displayId) {
      output.push(entry);
    }
  }

  output.sort(compareIconLayoutEntries);

  return Object.freeze(output);
}

function widgetGroupFor(entries: readonly WidgetLayoutEntry[], displayId: string): readonly WidgetLayoutEntry[] {
  const output: WidgetLayoutEntry[] = [];

  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];

    if (entry !== undefined && entry.nextDisplayId === displayId) {
      output.push(entry);
    }
  }

  output.sort(compareWidgetLayoutEntries);

  return Object.freeze(output);
}

function compareIconLayoutEntries(left: IconLayoutEntry, right: IconLayoutEntry): number {
  const leftResident = left.previousDisplayId === left.nextDisplayId ? 0 : 1;
  const rightResident = right.previousDisplayId === right.nextDisplayId ? 0 : 1;

  if (leftResident !== rightResident) return leftResident - rightResident;
  return left.index - right.index;
}

function compareWidgetLayoutEntries(left: WidgetLayoutEntry, right: WidgetLayoutEntry): number {
  const leftResident = left.previousDisplayId === left.nextDisplayId ? 0 : 1;
  const rightResident = right.previousDisplayId === right.nextDisplayId ? 0 : 1;

  if (leftResident !== rightResident) return leftResident - rightResident;
  return left.index - right.index;
}

function placeWidgetEntriesForDisplays(
  widgets: readonly WidgetInstance[],
  homes: ReadonlyMap<string, string>,
  displays: readonly MultiMonitorDisplay[],
  zones: ReadonlyMap<string, WidgetHostZone>,
): readonly WidgetInstance[] {
  const displayIds = displayIdSet(displays);
  const primaryId = primaryDisplayId(displays);
  const entries: WidgetLayoutEntry[] = [];

  for (let index = 0; index < widgets.length; index += 1) {
    const widget = widgets[index];

    if (widget === undefined) continue;

    const displayId = actualDisplayId(homes.get(widget.id), displayIds, primaryId);

    entries.push(Object.freeze({
      index,
      nextDisplayId: displayId,
      previousDisplayId: displayId,
      widget,
    }));
  }

  const output: WidgetInstance[] = [];

  for (let displayIndex = 0; displayIndex < displays.length; displayIndex += 1) {
    const display = displays[displayIndex];

    if (display === undefined) continue;

    const placed = placeWidgetGroup(widgetGroupFor(entries, display.id), zoneForDisplay(zones, display.id));

    for (let index = 0; index < placed.length; index += 1) {
      const widget = placed[index];

      if (widget !== undefined) output.push(widget);
    }
  }

  return Object.freeze(output);
}

function placeWidgetGroup(
  group: readonly WidgetLayoutEntry[],
  zone: WidgetHostZone,
): readonly WidgetInstance[] {
  const output: WidgetInstance[] = [];

  for (let index = 0; index < group.length; index += 1) {
    const entry = group[index];

    if (entry === undefined) continue;

    const span = widgetSizeSpan(entry.widget.sizeClass);
    const preferred = freezePlacement({
      column: entry.widget.placement.column,
      row: entry.widget.placement.row,
      zone: zone.id,
    });
    const placement = widgetPlacementAvailable(output, preferred, span, zone)
      ? preferred
      : firstAvailableWidgetPlacement(output, span, zone);

    output.push(freezeWidget({
      enabled: entry.widget.enabled,
      id: entry.widget.id,
      kind: entry.widget.kind,
      paused: entry.widget.paused,
      placement,
      refreshIntervalMs: entry.widget.refreshIntervalMs,
      sizeClass: entry.widget.sizeClass,
    }));
  }

  return Object.freeze(output);
}

function firstAvailableWidgetPlacement(
  placed: readonly WidgetInstance[],
  span: WidgetGridSpan,
  zone: WidgetHostZone,
): WidgetPlacement {
  for (let row = 0; row < zone.rows; row += 1) {
    for (let column = 0; column < zone.columns; column += 1) {
      const candidate = freezePlacement({
        column,
        row,
        zone: zone.id,
      });

      if (widgetPlacementAvailable(placed, candidate, span, zone)) {
        return candidate;
      }
    }
  }

  return freezePlacement({
    column: 0,
    row: Math.max(0, zone.rows - 1),
    zone: zone.id,
  });
}

function widgetPlacementAvailable(
  placed: readonly WidgetInstance[],
  placement: WidgetPlacement,
  span: WidgetGridSpan,
  zone: WidgetHostZone,
): boolean {
  if (
    placement.zone !== zone.id ||
    placement.column < 0 ||
    placement.row < 0 ||
    placement.column + span.columns > zone.columns ||
    placement.row + span.rows > zone.rows
  ) {
    return false;
  }

  for (let index = 0; index < placed.length; index += 1) {
    const current = placed[index];

    if (current === undefined) continue;
    if (widgetPlacementsOverlap(placement, span, current.placement, widgetSizeSpan(current.sizeClass))) {
      return false;
    }
  }

  return true;
}

function widgetPlacementsOverlap(
  leftPlacement: WidgetPlacement,
  leftSpan: WidgetGridSpan,
  rightPlacement: WidgetPlacement,
  rightSpan: WidgetGridSpan,
): boolean {
  if (leftPlacement.zone !== rightPlacement.zone) return false;

  return leftPlacement.column < rightPlacement.column + rightSpan.columns &&
    leftPlacement.column + leftSpan.columns > rightPlacement.column &&
    leftPlacement.row < rightPlacement.row + rightSpan.rows &&
    leftPlacement.row + leftSpan.rows > rightPlacement.row;
}

function displayForRect(rect: Rect, displays: readonly MultiMonitorDisplay[]): MultiMonitorDisplay | null {
  let selected: MultiMonitorDisplay | null = null;
  let selectedArea = -1;

  for (let index = 0; index < displays.length; index += 1) {
    const display = displays[index];

    if (display === undefined) continue;

    const area = rectDisplayOverlapArea(rect, display);

    if (
      area > selectedArea ||
      (area === selectedArea && selected !== null && compareDisplayTie(display, selected) < 0) ||
      (area === selectedArea && selected === null)
    ) {
      selected = display;
      selectedArea = area;
    }
  }

  return selected;
}

function rectDisplayOverlapArea(rect: Rect, display: MultiMonitorDisplay): number {
  const left = Math.max(rect.x, display.bounds.x);
  const top = Math.max(rect.y, display.bounds.y);
  const right = Math.min(rect.x + rect.width, display.bounds.x + display.bounds.w);
  const bottom = Math.min(rect.y + rect.height, display.bounds.y + display.bounds.h);
  const width = Math.max(0, right - left);
  const height = Math.max(0, bottom - top);

  return width * height;
}

function pointInsideBounds(point: MultiMonitorPoint, bounds: MultiMonitorDisplayBounds): boolean {
  return point.x >= bounds.x &&
    point.x < bounds.x + bounds.w &&
    point.y >= bounds.y &&
    point.y < bounds.y + bounds.h;
}

function betterDisplayTie(
  current: MultiMonitorDisplay | null,
  candidate: MultiMonitorDisplay,
): MultiMonitorDisplay {
  if (current === null) return candidate;
  return compareDisplayTie(candidate, current) < 0 ? candidate : current;
}

function compareDisplayTie(left: MultiMonitorDisplay, right: MultiMonitorDisplay): number {
  if (left.primary !== right.primary) return left.primary ? -1 : 1;
  return compareStrings(left.id, right.id);
}

function actualDisplayMap(
  icons: readonly DesktopIcon[],
  homes: ReadonlyMap<string, string>,
  displays: readonly MultiMonitorDisplay[],
): ReadonlyMap<string, string> {
  const output = new Map<string, string>();
  const displayIds = displayIdSet(displays);
  const primaryId = primaryDisplayId(displays);

  for (let index = 0; index < icons.length; index += 1) {
    const icon = icons[index];

    if (icon !== undefined) {
      output.set(icon.id, actualDisplayId(homes.get(icon.id), displayIds, primaryId));
    }
  }

  return output;
}

function actualWidgetDisplayMap(
  widgets: readonly WidgetInstance[],
  homes: ReadonlyMap<string, string>,
  displays: readonly MultiMonitorDisplay[],
): ReadonlyMap<string, string> {
  const output = new Map<string, string>();
  const displayIds = displayIdSet(displays);
  const primaryId = primaryDisplayId(displays);

  for (let index = 0; index < widgets.length; index += 1) {
    const widget = widgets[index];

    if (widget !== undefined) {
      output.set(widget.id, actualDisplayId(homes.get(widget.id), displayIds, primaryId));
    }
  }

  return output;
}

function actualDisplayId(
  homeDisplayId: string | undefined,
  displayIds: ReadonlySet<string>,
  primaryId: string,
): string {
  if (homeDisplayId !== undefined && displayIds.has(homeDisplayId)) return homeDisplayId;

  return primaryId;
}

function displayIdSet(displays: readonly MultiMonitorDisplay[]): ReadonlySet<string> {
  const output = new Set<string>();

  for (let index = 0; index < displays.length; index += 1) {
    const display = displays[index];

    if (display !== undefined) output.add(display.id);
  }

  return output;
}

function primaryDisplayId(displays: readonly MultiMonitorDisplay[]): string {
  for (let index = 0; index < displays.length; index += 1) {
    const display = displays[index];

    if (display !== undefined && display.primary) return display.id;
  }

  return displays[0]?.id ?? "";
}

function hasDisplay(displays: readonly MultiMonitorDisplay[], displayId: string): boolean {
  for (let index = 0; index < displays.length; index += 1) {
    const display = displays[index];

    if (display !== undefined && display.id === displayId) return true;
  }

  return false;
}

function hasIcon(icons: readonly DesktopIcon[], iconId: string): boolean {
  for (let index = 0; index < icons.length; index += 1) {
    const icon = icons[index];

    if (icon !== undefined && icon.id === iconId) return true;
  }

  return false;
}

function hasWidget(widgets: readonly WidgetInstance[], widgetId: string): boolean {
  for (let index = 0; index < widgets.length; index += 1) {
    const widget = widgets[index];

    if (widget !== undefined && widget.id === widgetId) return true;
  }

  return false;
}

function surfacesFor(
  displays: readonly MultiMonitorDisplay[],
  icons: readonly MultiMonitorIconOwnership[],
  widgets: readonly MultiMonitorWidgetOwnership[],
  wallpapers: ReadonlyMap<string, WallpaperSourceRef | null>,
  zones: ReadonlyMap<string, WidgetHostZone>,
): readonly MultiMonitorDisplaySurface[] {
  const output: MultiMonitorDisplaySurface[] = [];

  for (let displayIndex = 0; displayIndex < displays.length; displayIndex += 1) {
    const display = displays[displayIndex];

    if (display === undefined) continue;

    output.push(Object.freeze({
      display,
      icons: iconsForDisplay(icons, display.id),
      wallpaper: wallpapers.get(display.id) ?? null,
      widgets: widgetsForDisplay(widgets, display.id),
      widgetZone: zoneForDisplay(zones, display.id),
    }));
  }

  return Object.freeze(output);
}

function iconsForDisplay(
  icons: readonly MultiMonitorIconOwnership[],
  displayId: string,
): readonly DesktopIcon[] {
  const output: DesktopIcon[] = [];

  for (let index = 0; index < icons.length; index += 1) {
    const entry = icons[index];

    if (entry !== undefined && entry.displayId === displayId) output.push(entry.icon);
  }

  return Object.freeze(output);
}

function widgetsForDisplay(
  widgets: readonly MultiMonitorWidgetOwnership[],
  displayId: string,
): readonly WidgetInstance[] {
  const output: WidgetInstance[] = [];

  for (let index = 0; index < widgets.length; index += 1) {
    const entry = widgets[index];

    if (entry !== undefined && entry.displayId === displayId) output.push(entry.widget);
  }

  return Object.freeze(output);
}

function wallpapersFor(
  displays: readonly MultiMonitorDisplay[],
  wallpapers: ReadonlyMap<string, WallpaperSourceRef | null>,
): readonly MultiMonitorDisplayWallpaper[] {
  const output: MultiMonitorDisplayWallpaper[] = [];

  for (let index = 0; index < displays.length; index += 1) {
    const display = displays[index];

    if (display === undefined) continue;

    output.push(Object.freeze({
      displayId: display.id,
      ref: wallpapers.get(display.id) ?? null,
    }));
  }

  return Object.freeze(output);
}

function freezeState(input: MultiMonitorSurfaceState): MultiMonitorSurfaceState {
  return Object.freeze({
    displays: Object.freeze(input.displays.map(freezeDisplay)),
    error: input.error,
    iconGrid: input.iconGrid,
    icons: Object.freeze(input.icons.map(freezeIconOwnership)),
    primaryDisplayId: input.primaryDisplayId,
    surfaces: Object.freeze(input.surfaces.map(freezeSurface)),
    wallpapers: Object.freeze(input.wallpapers.map((wallpaper) => Object.freeze({
      displayId: wallpaper.displayId,
      ref: wallpaper.ref,
    }))),
    widgets: Object.freeze(input.widgets.map(freezeWidgetOwnership)),
    widgetState: input.widgetState,
  });
}

function freezeDisplay(display: MultiMonitorDisplay): MultiMonitorDisplay {
  return Object.freeze({
    bounds: Object.freeze({
      h: display.bounds.h,
      w: display.bounds.w,
      x: display.bounds.x,
      y: display.bounds.y,
    }),
    id: display.id,
    primary: display.primary,
    scale: display.scale,
  });
}

function freezeIconOwnership(entry: MultiMonitorIconOwnership): MultiMonitorIconOwnership {
  return Object.freeze({
    displayId: entry.displayId,
    homeDisplayId: entry.homeDisplayId,
    icon: freezeIcon(entry.icon),
    iconId: entry.iconId,
  });
}

function freezeWidgetOwnership(entry: MultiMonitorWidgetOwnership): MultiMonitorWidgetOwnership {
  return Object.freeze({
    displayId: entry.displayId,
    homeDisplayId: entry.homeDisplayId,
    widget: freezeWidget(entry.widget),
    widgetId: entry.widgetId,
  });
}

function freezeSurface(surface: MultiMonitorDisplaySurface): MultiMonitorDisplaySurface {
  return Object.freeze({
    display: freezeDisplay(surface.display),
    icons: Object.freeze(surface.icons.map(freezeIcon)),
    wallpaper: surface.wallpaper,
    widgets: Object.freeze(surface.widgets.map(freezeWidget)),
    widgetZone: Object.freeze({
      columns: surface.widgetZone.columns,
      id: surface.widgetZone.id,
      rows: surface.widgetZone.rows,
    }),
  });
}

function freezeIcon(input: DesktopIconInput): DesktopIcon {
  const output: {
    date?: number | string;
    iconRef: string;
    id: string;
    kind: string;
    label: string;
    position: DesktopIconPoint;
    size?: number;
  } = {
    iconRef: input.iconRef,
    id: input.id,
    kind: input.kind,
    label: input.label,
    position: Object.freeze({
      x: Math.trunc(input.position.x),
      y: Math.trunc(input.position.y),
    }),
  };

  if (input.date !== undefined) output.date = input.date;
  if (input.size !== undefined) output.size = input.size;

  return Object.freeze(output);
}

function freezeWidget(widget: WidgetInstance): WidgetInstance {
  return Object.freeze({
    enabled: widget.enabled,
    id: widget.id,
    kind: widget.kind,
    paused: widget.paused,
    placement: freezePlacement(widget.placement),
    refreshIntervalMs: widget.refreshIntervalMs,
    sizeClass: widget.sizeClass,
  });
}

function freezePlacement(placement: WidgetPlacement): WidgetPlacement {
  return Object.freeze({
    column: Math.max(0, Math.trunc(placement.column)),
    row: Math.max(0, Math.trunc(placement.row)),
    zone: placement.zone,
  });
}

function compareDisplays(left: MultiMonitorDisplay, right: MultiMonitorDisplay): number {
  if (left.primary !== right.primary) return left.primary ? -1 : 1;
  if (left.bounds.x !== right.bounds.x) return left.bounds.x - right.bounds.x;
  if (left.bounds.y !== right.bounds.y) return left.bounds.y - right.bounds.y;
  return compareStrings(left.id, right.id);
}

function snapshotObject(
  input: unknown,
  allowedKeys: readonly string[],
  path: string,
  code: MultiMonitorSurfaceErrorCode,
): NormalizeResult<ReadonlyMap<string, unknown>> {
  try {
    if (input === null || typeof input !== "object" || Array.isArray(input)) {
      return reject(error(code, "value must be a plain object.", path));
    }

    const prototype = Object.getPrototypeOf(input);

    if (prototype !== Object.prototype && prototype !== null) {
      return reject(error(code, "value must be a plain object.", path));
    }

    const keys = Reflect.ownKeys(input);
    const output = new Map<string, unknown>();

    for (let index = 0; index < keys.length; index += 1) {
      const key = keys[index];

      if (key === undefined || typeof key === "symbol" || !containsString(allowedKeys, key)) {
        return reject(error(code, "object contains an unsupported field.", path));
      }

      const descriptor = Object.getOwnPropertyDescriptor(input, key);

      if (descriptor === undefined || !isDataDescriptor(descriptor) || descriptor.enumerable !== true) {
        return reject(error(code, "object must contain only enumerable data fields.", path));
      }

      output.set(key, descriptor.value);
    }

    return accept(output);
  } catch {
    return reject(error(code, "value must be a stable plain object.", path));
  }
}

function isPointShape(input: unknown): input is DesktopIconPoint {
  return input !== null &&
    typeof input === "object" &&
    !Array.isArray(input) &&
    typeof Reflect.get(input, "x") === "number" &&
    Number.isFinite(Reflect.get(input, "x")) &&
    typeof Reflect.get(input, "y") === "number" &&
    Number.isFinite(Reflect.get(input, "y"));
}

function finiteNumber(input: unknown): number | null {
  return typeof input === "number" && Number.isFinite(input) ? input : null;
}

function isPositiveInteger(input: unknown): input is number {
  return typeof input === "number" && Number.isSafeInteger(input) && input > 0;
}

function isNonNegativeInteger(input: unknown): input is number {
  return typeof input === "number" && Number.isSafeInteger(input) && input >= 0;
}

function containsString(values: readonly string[], value: string): boolean {
  for (let index = 0; index < values.length; index += 1) {
    if (values[index] === value) return true;
  }

  return false;
}

function isDataDescriptor(descriptor: PropertyDescriptor): descriptor is PropertyDescriptor & {
  readonly value: unknown;
} {
  return Object.prototype.hasOwnProperty.call(descriptor, "value");
}

function compareStrings(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;

  return 0;
}

function error(
  code: MultiMonitorSurfaceErrorCode,
  message: string,
  path: string,
): MultiMonitorSurfaceError {
  return Object.freeze({
    code,
    message,
    path,
  });
}

function accept<T>(value: T): NormalizeResult<T> {
  return Object.freeze({
    ok: true,
    value,
  });
}

function reject<T>(errorValue: MultiMonitorSurfaceError): NormalizeResult<T> {
  return Object.freeze({
    error: errorValue,
    ok: false,
  });
}
