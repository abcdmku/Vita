import type {
  DesktopHost,
  FilesCapabilityPort,
  Rect,
  ShellCapabilityPort,
} from "../../../sdk/typescript/src/desktop-sdk/index.ts";

export type DesktopIconPlacementMode = "grid" | "free";
export type DesktopIconSortKey = "name" | "kind" | "date" | "size";

export interface DesktopIconPoint {
  readonly x: number;
  readonly y: number;
}

export interface DesktopIconSize {
  readonly height: number;
  readonly width: number;
}

export interface DesktopIconGridCell {
  readonly col: number;
  readonly row: number;
}

export interface DesktopIconGridConfig {
  readonly cell: DesktopIconSize;
  readonly columns: number;
  readonly gutter: DesktopIconPoint;
  readonly origin: DesktopIconPoint;
}

export interface DesktopIconGridConfigInput {
  readonly cell?: {
    readonly height?: number;
    readonly width?: number;
  };
  readonly columns?: number;
  readonly gutter?: {
    readonly x?: number;
    readonly y?: number;
  };
  readonly origin?: {
    readonly x?: number;
    readonly y?: number;
  };
}

export interface DesktopIconInput {
  readonly date?: number | string;
  readonly iconRef: string;
  readonly id: string;
  readonly kind: string;
  readonly label: string;
  readonly position: DesktopIconPoint;
  readonly size?: number;
}

export interface DesktopIcon {
  readonly date?: number | string;
  readonly iconRef: string;
  readonly id: string;
  readonly kind: string;
  readonly label: string;
  readonly position: DesktopIconPoint;
  readonly size?: number;
}

export interface DesktopIconsPorts {
  readonly files?: FilesCapabilityPort;
  readonly host?: DesktopHost;
  readonly shell?: ShellCapabilityPort;
}

export interface DesktopIconsViewModelOptions {
  readonly grid?: DesktopIconGridConfigInput;
  readonly icons?: readonly DesktopIconInput[];
  readonly mode?: DesktopIconPlacementMode;
  readonly ports?: DesktopIconsPorts;
}

export interface DesktopIconRenameDraft {
  readonly id: string;
  readonly label: string;
}

export interface DesktopIconsViewModelError {
  readonly code:
    | "DUPLICATE_ICON_ID"
    | "DUPLICATE_RENAME_LABEL"
    | "INVALID_DELTA"
    | "INVALID_ICON"
    | "INVALID_ICON_SET"
    | "INVALID_MODE"
    | "INVALID_POINT"
    | "INVALID_RENAME_LABEL"
    | "INVALID_SORT_KEY"
    | "NO_ACTIVE_DRAG"
    | "NO_RENAME_DRAFT"
    | "UNKNOWN_ICON";
  readonly message: string;
  readonly path: string;
}

export interface DesktopIconsViewState {
  readonly error: DesktopIconsViewModelError | null;
  readonly grid: DesktopIconGridConfig;
  readonly icons: readonly DesktopIcon[];
  readonly marquee: Rect | null;
  readonly mode: DesktopIconPlacementMode;
  readonly renameDraft: DesktopIconRenameDraft | null;
  readonly selectedIds: readonly string[];
  readonly sortKey: DesktopIconSortKey | null;
}

export type DesktopIconsRenameResult =
  | {
      readonly ok: true;
      readonly state: DesktopIconsViewState;
    }
  | {
      readonly error: DesktopIconsViewModelError;
      readonly ok: false;
      readonly state: DesktopIconsViewState;
    };

type NormalizeResult<T> =
  | {
      readonly ok: true;
      readonly value: T;
    }
  | {
      readonly error: DesktopIconsViewModelError;
      readonly ok: false;
    };

interface DragBaseline {
  readonly id: string;
  readonly position: DesktopIconPoint;
}

interface DragState {
  readonly baseline: readonly DragBaseline[];
  readonly dx: number;
  readonly dy: number;
  readonly ids: readonly string[];
}

interface SortEntry {
  readonly icon: DesktopIcon;
  readonly index: number;
}

const DEFAULT_GRID = Object.freeze({
  cell: Object.freeze({
    height: 96,
    width: 80,
  }),
  columns: 8,
  gutter: Object.freeze({
    x: 16,
    y: 16,
  }),
  origin: Object.freeze({
    x: 24,
    y: 24,
  }),
}) satisfies DesktopIconGridConfig;

const POINT_FIELDS = Object.freeze(["x", "y"]);
const ICON_FIELDS = Object.freeze(["date", "iconRef", "id", "kind", "label", "position", "size"]);

export class DesktopIconsViewModel {
  readonly #grid: DesktopIconGridConfig;
  #drag: DragState | null = null;
  #error: DesktopIconsViewModelError | null = null;
  #icons: readonly DesktopIcon[] = Object.freeze([]);
  #marqueeAnchor: DesktopIconPoint | null = null;
  #marqueeRect: Rect | null = null;
  #mode: DesktopIconPlacementMode;
  #rangeAnchor: string | null = null;
  #renameDraft: DesktopIconRenameDraft | null = null;
  #selected = new Set<string>();
  #sortKey: DesktopIconSortKey | null = null;

  constructor(options: DesktopIconsViewModelOptions = Object.freeze({})) {
    this.#grid = createDesktopIconGrid(options.grid);
    this.#mode = options.mode === "free" ? "free" : "grid";

    if (options.icons !== undefined) {
      this.setIcons(options.icons);
    }
  }

  get state(): DesktopIconsViewState {
    return this.snapshot();
  }

  snapshot(): DesktopIconsViewState {
    return freezeState({
      error: this.#error,
      grid: this.#grid,
      icons: this.#icons,
      marquee: this.#marqueeRect,
      mode: this.#mode,
      renameDraft: this.#renameDraft,
      selectedIds: this.#selectedIds(),
      sortKey: this.#sortKey,
    });
  }

  setIcons(icons: readonly DesktopIconInput[]): DesktopIconsViewState {
    const normalized = normalizeIconSet(icons);

    if (!normalized.ok) {
      this.#error = normalized.error;
      return this.snapshot();
    }

    this.#icons = this.#mode === "grid"
      ? snapIconsToGrid(normalized.value, this.#grid)
      : normalized.value;
    this.#selected = retainExistingSelection(this.#selected, this.#icons);
    this.#rangeAnchor = hasIcon(this.#icons, this.#rangeAnchor) ? this.#rangeAnchor : null;
    this.#renameDraft = draftForExistingIcon(this.#renameDraft, this.#icons);
    this.#drag = null;
    this.#marqueeAnchor = null;
    this.#marqueeRect = null;
    this.#error = null;

    return this.snapshot();
  }

  setMode(mode: DesktopIconPlacementMode): DesktopIconsViewState {
    if (mode !== "grid" && mode !== "free") {
      this.#error = error("INVALID_MODE", "desktop icon placement mode is not supported.", "/mode");
      return this.snapshot();
    }

    this.#mode = mode;
    if (mode === "grid") {
      this.#icons = snapIconsToGrid(this.#icons, this.#grid);
    }
    this.#drag = null;
    this.#error = null;

    return this.snapshot();
  }

  select(id: string): DesktopIconsViewState {
    if (!this.#hasIconOrReject(id, "/selection/id")) return this.snapshot();

    this.#selected = new Set<string>([id]);
    this.#rangeAnchor = id;
    this.#error = null;

    return this.snapshot();
  }

  toggle(id: string): DesktopIconsViewState {
    if (!this.#hasIconOrReject(id, "/selection/id")) return this.snapshot();

    const selected = new Set<string>(this.#selected);

    if (selected.has(id)) {
      selected.delete(id);
    } else {
      selected.add(id);
    }

    this.#selected = selected;
    this.#rangeAnchor = id;
    this.#error = null;

    return this.snapshot();
  }

  extendTo(id: string): DesktopIconsViewState {
    if (!this.#hasIconOrReject(id, "/selection/id")) return this.snapshot();

    if (this.#rangeAnchor === null || !hasIcon(this.#icons, this.#rangeAnchor)) {
      return this.select(id);
    }

    const start = iconIndex(this.#icons, this.#rangeAnchor);
    const end = iconIndex(this.#icons, id);

    if (start < 0 || end < 0) {
      return this.select(id);
    }

    const from = Math.min(start, end);
    const to = Math.max(start, end);
    const selected = new Set<string>();

    for (let index = from; index <= to; index += 1) {
      const icon = this.#icons[index];

      if (icon !== undefined) selected.add(icon.id);
    }

    this.#selected = selected;
    this.#error = null;

    return this.snapshot();
  }

  beginMarquee(point: unknown): DesktopIconsViewState {
    const normalized = normalizePoint(point, "/marquee/start", "INVALID_POINT");

    if (!normalized.ok) {
      this.#error = normalized.error;
      return this.snapshot();
    }

    this.#marqueeAnchor = normalized.value;
    this.#marqueeRect = marqueeRect(normalized.value, normalized.value);
    this.#selected = new Set<string>();
    this.#error = null;

    return this.snapshot();
  }

  updateMarquee(point: unknown): DesktopIconsViewState {
    const normalized = normalizePoint(point, "/marquee/current", "INVALID_POINT");

    if (!normalized.ok) {
      this.#error = normalized.error;
      return this.snapshot();
    }

    if (this.#marqueeAnchor === null) {
      this.#marqueeAnchor = normalized.value;
    }

    this.#marqueeRect = marqueeRect(this.#marqueeAnchor, normalized.value);
    this.#selected = selectIconsOverlappingRect(this.#icons, this.#marqueeRect, this.#grid);
    this.#error = null;

    return this.snapshot();
  }

  endMarquee(): DesktopIconsViewState {
    this.#marqueeAnchor = null;
    this.#marqueeRect = null;
    this.#error = null;

    return this.snapshot();
  }

  beginDrag(id?: string): DesktopIconsViewState {
    if (id !== undefined) {
      if (!this.#hasIconOrReject(id, "/drag/id")) return this.snapshot();

      if (!this.#selected.has(id)) {
        this.#selected = new Set<string>([id]);
        this.#rangeAnchor = id;
      }
    }

    const selectedIds = this.#selectedIds();

    if (selectedIds.length === 0) {
      this.#error = error("NO_ACTIVE_DRAG", "drag requires at least one selected icon.", "/drag");
      return this.snapshot();
    }

    this.#drag = Object.freeze({
      baseline: dragBaseline(this.#icons, selectedIds),
      dx: 0,
      dy: 0,
      ids: selectedIds,
    });
    this.#error = null;

    return this.snapshot();
  }

  moveBy(dx: unknown, dy: unknown): DesktopIconsViewState {
    if (this.#drag === null) {
      this.#error = error("NO_ACTIVE_DRAG", "moveBy requires an active drag.", "/drag");
      return this.snapshot();
    }

    const deltaX = finiteNumber(dx);
    const deltaY = finiteNumber(dy);

    if (deltaX === null || deltaY === null) {
      this.#error = error("INVALID_DELTA", "drag delta must be finite.", "/drag/delta");
      return this.snapshot();
    }

    const nextDrag = Object.freeze({
      baseline: this.#drag.baseline,
      dx: this.#drag.dx + Math.trunc(deltaX),
      dy: this.#drag.dy + Math.trunc(deltaY),
      ids: this.#drag.ids,
    }) satisfies DragState;

    this.#drag = nextDrag;
    this.#icons = this.#mode === "grid"
      ? moveGridDrag(this.#icons, nextDrag, this.#grid)
      : moveFreeDrag(this.#icons, nextDrag);
    this.#error = null;

    return this.snapshot();
  }

  endDrag(): DesktopIconsViewState {
    this.#drag = null;
    this.#error = null;

    return this.snapshot();
  }

  beginRename(id: string): DesktopIconsViewState {
    const icon = findIcon(this.#icons, id);

    if (icon === undefined) {
      this.#error = error("UNKNOWN_ICON", "rename target icon is not present.", "/rename/id");
      return this.snapshot();
    }

    this.#renameDraft = Object.freeze({
      id,
      label: icon.label,
    });
    this.#selected = new Set<string>([id]);
    this.#rangeAnchor = id;
    this.#error = null;

    return this.snapshot();
  }

  commitRename(label: unknown): DesktopIconsRenameResult {
    if (this.#renameDraft === null) {
      const rejected = error("NO_RENAME_DRAFT", "commitRename requires an active rename draft.", "/rename");

      this.#error = rejected;
      return rejectRename(rejected, this.snapshot());
    }

    if (typeof label !== "string") {
      const rejected = error("INVALID_RENAME_LABEL", "desktop icon label must be a string.", "/rename/label");

      this.#error = rejected;
      return rejectRename(rejected, this.snapshot());
    }

    const trimmed = label.trim();

    if (trimmed.length === 0) {
      const rejected = error("INVALID_RENAME_LABEL", "desktop icon label must not be empty.", "/rename/label");

      this.#error = rejected;
      return rejectRename(rejected, this.snapshot());
    }

    const duplicate = findIconByLabel(this.#icons, trimmed, this.#renameDraft.id);

    if (duplicate !== undefined) {
      const rejected = error("DUPLICATE_RENAME_LABEL", "desktop icon label must be unique.", "/rename/label");

      this.#error = rejected;
      return rejectRename(rejected, this.snapshot());
    }

    this.#icons = renameIcon(this.#icons, this.#renameDraft.id, trimmed);
    this.#renameDraft = null;
    this.#error = null;

    return Object.freeze({
      ok: true,
      state: this.snapshot(),
    });
  }

  autoArrange(): DesktopIconsViewState {
    this.#icons = autoArrangeIcons(this.#icons, this.#grid);
    this.#mode = "grid";
    this.#drag = null;
    this.#marqueeAnchor = null;
    this.#marqueeRect = null;
    this.#error = null;

    return this.snapshot();
  }

  sortBy(key: DesktopIconSortKey): DesktopIconsViewState {
    if (!isSortKey(key)) {
      this.#error = error("INVALID_SORT_KEY", "desktop icon sort key is not supported.", "/sort/key");
      return this.snapshot();
    }

    this.#icons = autoArrangeIcons(sortDesktopIcons(this.#icons, key), this.#grid);
    this.#mode = "grid";
    this.#sortKey = key;
    this.#drag = null;
    this.#marqueeAnchor = null;
    this.#marqueeRect = null;
    this.#error = null;

    return this.snapshot();
  }

  #hasIconOrReject(id: string, path: string): boolean {
    if (hasIcon(this.#icons, id)) return true;

    this.#error = error("UNKNOWN_ICON", "desktop icon id is not present.", path);
    return false;
  }

  #selectedIds(): readonly string[] {
    const selected: string[] = [];

    for (let index = 0; index < this.#icons.length; index += 1) {
      const icon = this.#icons[index];

      if (icon !== undefined && this.#selected.has(icon.id)) {
        selected.push(icon.id);
      }
    }

    return Object.freeze(selected);
  }
}

export function createDesktopIconsViewModel(
  options: DesktopIconsViewModelOptions = Object.freeze({}),
): DesktopIconsViewModel {
  return new DesktopIconsViewModel(options);
}

export function createDesktopIconGrid(input: DesktopIconGridConfigInput = Object.freeze({})): DesktopIconGridConfig {
  return Object.freeze({
    cell: Object.freeze({
      height: normalizePositiveInteger(input.cell?.height, DEFAULT_GRID.cell.height),
      width: normalizePositiveInteger(input.cell?.width, DEFAULT_GRID.cell.width),
    }),
    columns: normalizePositiveInteger(input.columns, DEFAULT_GRID.columns),
    gutter: Object.freeze({
      x: normalizeNonNegativeInteger(input.gutter?.x, DEFAULT_GRID.gutter.x),
      y: normalizeNonNegativeInteger(input.gutter?.y, DEFAULT_GRID.gutter.y),
    }),
    origin: Object.freeze({
      x: normalizeInteger(input.origin?.x, DEFAULT_GRID.origin.x),
      y: normalizeInteger(input.origin?.y, DEFAULT_GRID.origin.y),
    }),
  });
}

export function gridCellToPixel(cell: DesktopIconGridCell, grid: DesktopIconGridConfig): DesktopIconPoint {
  const normalized = normalizeGridCell(cell);

  return Object.freeze({
    x: grid.origin.x + normalized.col * gridPitchX(grid),
    y: grid.origin.y + normalized.row * gridPitchY(grid),
  });
}

export function pixelToGridCell(point: DesktopIconPoint, grid: DesktopIconGridConfig): DesktopIconGridCell {
  return normalizeGridCell({
    col: Math.round((point.x - grid.origin.x) / gridPitchX(grid)),
    row: Math.round((point.y - grid.origin.y) / gridPitchY(grid)),
  });
}

export function desktopIconBox(icon: DesktopIcon, grid: DesktopIconGridConfig): Rect {
  return freezeRect({
    height: grid.cell.height,
    width: grid.cell.width,
    x: icon.position.x,
    y: icon.position.y,
  });
}

export function marqueeRect(anchor: DesktopIconPoint, current: DesktopIconPoint): Rect {
  const x = Math.min(Math.trunc(anchor.x), Math.trunc(current.x));
  const y = Math.min(Math.trunc(anchor.y), Math.trunc(current.y));

  return freezeRect({
    height: Math.abs(Math.trunc(current.y) - Math.trunc(anchor.y)),
    width: Math.abs(Math.trunc(current.x) - Math.trunc(anchor.x)),
    x,
    y,
  });
}

export function rectsOverlap(left: Rect, right: Rect): boolean {
  return left.x < right.x + right.width &&
    left.x + left.width > right.x &&
    left.y < right.y + right.height &&
    left.y + left.height > right.y;
}

export function snapIconsToGrid(
  icons: readonly DesktopIcon[],
  grid: DesktopIconGridConfig = DEFAULT_GRID,
): readonly DesktopIcon[] {
  const occupied = new Set<string>();
  const output: DesktopIcon[] = [];

  for (let index = 0; index < icons.length; index += 1) {
    const icon = icons[index];

    if (icon === undefined) continue;

    const preferred = pixelToGridCell(icon.position, grid);
    const resolved = firstFreeCell(preferred, occupied);

    occupied.add(gridCellKey(resolved));
    output.push(placeIcon(icon, gridCellToPixel(resolved, grid)));
  }

  return Object.freeze(output);
}

export function autoArrangeIcons(
  icons: readonly DesktopIcon[],
  grid: DesktopIconGridConfig = DEFAULT_GRID,
): readonly DesktopIcon[] {
  const output: DesktopIcon[] = [];

  for (let index = 0; index < icons.length; index += 1) {
    const icon = icons[index];

    if (icon === undefined) continue;
    output.push(placeIcon(icon, gridCellToPixel(cellForIndex(output.length, grid.columns), grid)));
  }

  return Object.freeze(output);
}

export function sortDesktopIcons(
  icons: readonly DesktopIcon[],
  key: DesktopIconSortKey,
): readonly DesktopIcon[] {
  const entries: SortEntry[] = [];

  for (let index = 0; index < icons.length; index += 1) {
    const icon = icons[index];

    if (icon !== undefined) {
      entries.push(Object.freeze({
        icon,
        index,
      }));
    }
  }

  entries.sort((left, right) => {
    const comparison = compareIconByKey(left.icon, right.icon, key);

    if (comparison !== 0) return comparison;
    return left.index - right.index;
  });

  return Object.freeze(entries.map((entry) => entry.icon));
}

function normalizeIconSet(input: readonly DesktopIconInput[]): NormalizeResult<readonly DesktopIcon[]> {
  if (!Array.isArray(input)) {
    return reject(error("INVALID_ICON_SET", "desktop icon set must be an array.", "/icons"));
  }

  const ids = new Set<string>();
  const output: DesktopIcon[] = [];

  for (let index = 0; index < input.length; index += 1) {
    let raw: unknown;

    try {
      raw = input[index];
    } catch {
      return reject(error("INVALID_ICON_SET", "desktop icon set must be stable.", `/icons/${index}`));
    }

    const normalized = normalizeIconInput(raw, `/icons/${index}`);

    if (!normalized.ok) return normalized;
    if (ids.has(normalized.value.id)) {
      return reject(error("DUPLICATE_ICON_ID", "desktop icon ids must be unique.", `/icons/${index}/id`));
    }

    ids.add(normalized.value.id);
    output.push(normalized.value);
  }

  return accept(Object.freeze(output));
}

function normalizeIconInput(input: unknown, path: string): NormalizeResult<DesktopIcon> {
  const object = snapshotObject(input, ICON_FIELDS, path, "INVALID_ICON");

  if (!object.ok) return object;

  const id = requiredString(object.value.get("id"), `${path}/id`);
  const label = requiredString(object.value.get("label"), `${path}/label`);
  const kind = requiredString(object.value.get("kind"), `${path}/kind`);
  const iconRef = requiredString(object.value.get("iconRef"), `${path}/iconRef`);
  const position = normalizePoint(object.value.get("position"), `${path}/position`, "INVALID_ICON");
  const date = optionalDate(object.value.get("date"), `${path}/date`);
  const size = optionalSize(object.value.get("size"), `${path}/size`);

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

  return accept(Object.freeze(output));
}

function normalizePoint(
  input: unknown,
  path: string,
  code: DesktopIconsViewModelError["code"],
): NormalizeResult<DesktopIconPoint> {
  const object = snapshotObject(input, POINT_FIELDS, path, code);

  if (!object.ok) return object;

  const x = finiteNumber(object.value.get("x"));
  const y = finiteNumber(object.value.get("y"));

  if (x === null) return reject(error(code, "point x must be finite.", `${path}/x`));
  if (y === null) return reject(error(code, "point y must be finite.", `${path}/y`));

  return accept(Object.freeze({
    x: Math.trunc(x),
    y: Math.trunc(y),
  }));
}

function snapshotObject(
  input: unknown,
  allowedKeys: readonly string[],
  path: string,
  code: DesktopIconsViewModelError["code"],
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

      if (key === undefined || typeof key === "symbol" || !contains(allowedKeys, key)) {
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

function requiredString(input: unknown, path: string): NormalizeResult<string> {
  if (typeof input !== "string" || input.length === 0) {
    return reject(error("INVALID_ICON", "field must be a non-empty string.", path));
  }

  return accept(input);
}

function optionalDate(input: unknown, path: string): NormalizeResult<number | string | undefined> {
  if (input === undefined) return accept(undefined);
  if (typeof input === "string") return accept(input);

  const date = finiteNumber(input);

  if (date !== null) return accept(Math.trunc(date));

  return reject(error("INVALID_ICON", "icon date must be a string or finite number.", path));
}

function optionalSize(input: unknown, path: string): NormalizeResult<number | undefined> {
  if (input === undefined) return accept(undefined);

  const size = finiteNumber(input);

  if (size === null || size < 0) {
    return reject(error("INVALID_ICON", "icon size must be a non-negative finite number.", path));
  }

  return accept(Math.trunc(size));
}

function selectIconsOverlappingRect(
  icons: readonly DesktopIcon[],
  rect: Rect,
  grid: DesktopIconGridConfig,
): Set<string> {
  const selected = new Set<string>();

  if (rect.width <= 0 || rect.height <= 0) return selected;

  for (let index = 0; index < icons.length; index += 1) {
    const icon = icons[index];

    if (icon !== undefined && rectsOverlap(rect, desktopIconBox(icon, grid))) {
      selected.add(icon.id);
    }
  }

  return selected;
}

function moveFreeDrag(icons: readonly DesktopIcon[], drag: DragState): readonly DesktopIcon[] {
  const output: DesktopIcon[] = [];

  for (let index = 0; index < icons.length; index += 1) {
    const icon = icons[index];

    if (icon === undefined) continue;

    const baseline = findDragBaseline(drag.baseline, icon.id);

    if (baseline === undefined) {
      output.push(icon);
      continue;
    }

    output.push(placeIcon(icon, {
      x: baseline.position.x + drag.dx,
      y: baseline.position.y + drag.dy,
    }));
  }

  return Object.freeze(output);
}

function moveGridDrag(
  icons: readonly DesktopIcon[],
  drag: DragState,
  grid: DesktopIconGridConfig,
): readonly DesktopIcon[] {
  const occupied = new Set<string>();

  for (let index = 0; index < icons.length; index += 1) {
    const icon = icons[index];

    if (icon !== undefined && !contains(drag.ids, icon.id)) {
      occupied.add(gridCellKey(pixelToGridCell(icon.position, grid)));
    }
  }

  const output: DesktopIcon[] = [];

  for (let index = 0; index < icons.length; index += 1) {
    const icon = icons[index];

    if (icon === undefined) continue;

    const baseline = findDragBaseline(drag.baseline, icon.id);

    if (baseline === undefined) {
      output.push(icon);
      continue;
    }

    const preferred = pixelToGridCell({
      x: baseline.position.x + drag.dx,
      y: baseline.position.y + drag.dy,
    }, grid);
    const resolved = firstFreeCell(preferred, occupied);

    occupied.add(gridCellKey(resolved));
    output.push(placeIcon(icon, gridCellToPixel(resolved, grid)));
  }

  return Object.freeze(output);
}

function dragBaseline(
  icons: readonly DesktopIcon[],
  ids: readonly string[],
): readonly DragBaseline[] {
  const output: DragBaseline[] = [];

  for (let index = 0; index < icons.length; index += 1) {
    const icon = icons[index];

    if (icon !== undefined && contains(ids, icon.id)) {
      output.push(Object.freeze({
        id: icon.id,
        position: icon.position,
      }));
    }
  }

  return Object.freeze(output);
}

function findDragBaseline(
  baseline: readonly DragBaseline[],
  id: string,
): DragBaseline | undefined {
  for (let index = 0; index < baseline.length; index += 1) {
    const entry = baseline[index];

    if (entry !== undefined && entry.id === id) return entry;
  }

  return undefined;
}

function firstFreeCell(
  preferred: DesktopIconGridCell,
  occupied: ReadonlySet<string>,
): DesktopIconGridCell {
  if (!occupied.has(gridCellKey(preferred))) return preferred;

  for (let distance = 1; distance < Number.MAX_SAFE_INTEGER; distance += 1) {
    const minRow = Math.max(0, preferred.row - distance);
    const maxRow = preferred.row + distance;
    const minCol = Math.max(0, preferred.col - distance);
    const maxCol = preferred.col + distance;

    for (let row = minRow; row <= maxRow; row += 1) {
      for (let col = minCol; col <= maxCol; col += 1) {
        if (Math.abs(row - preferred.row) + Math.abs(col - preferred.col) !== distance) continue;

        const candidate = Object.freeze({
          col,
          row,
        });

        if (!occupied.has(gridCellKey(candidate))) return candidate;
      }
    }
  }

  return preferred;
}

function cellForIndex(index: number, columns: number): DesktopIconGridCell {
  return Object.freeze({
    col: index % columns,
    row: Math.floor(index / columns),
  });
}

function compareIconByKey(left: DesktopIcon, right: DesktopIcon, key: DesktopIconSortKey): number {
  switch (key) {
    case "name":
      return compareStrings(canonicalSortText(left.label), canonicalSortText(right.label));
    case "kind":
      return compareStrings(canonicalSortText(left.kind), canonicalSortText(right.kind));
    case "date":
      return compareNumbers(dateRank(left.date), dateRank(right.date));
    case "size":
      return compareNumbers(sizeRank(left.size), sizeRank(right.size));
  }
}

function dateRank(value: number | string | undefined): number {
  if (value === undefined) return Number.POSITIVE_INFINITY;
  if (typeof value === "number") return value;

  const parsed = Date.parse(value);

  return Number.isFinite(parsed) ? parsed : Number.POSITIVE_INFINITY;
}

function sizeRank(value: number | undefined): number {
  return value ?? Number.POSITIVE_INFINITY;
}

function renameIcon(
  icons: readonly DesktopIcon[],
  id: string,
  label: string,
): readonly DesktopIcon[] {
  const output: DesktopIcon[] = [];

  for (let index = 0; index < icons.length; index += 1) {
    const icon = icons[index];

    if (icon === undefined) continue;
    output.push(icon.id === id ? copyIcon(icon, {
      label,
      position: icon.position,
    }) : icon);
  }

  return Object.freeze(output);
}

function retainExistingSelection(
  selected: ReadonlySet<string>,
  icons: readonly DesktopIcon[],
): Set<string> {
  const next = new Set<string>();

  for (let index = 0; index < icons.length; index += 1) {
    const icon = icons[index];

    if (icon !== undefined && selected.has(icon.id)) {
      next.add(icon.id);
    }
  }

  return next;
}

function draftForExistingIcon(
  draft: DesktopIconRenameDraft | null,
  icons: readonly DesktopIcon[],
): DesktopIconRenameDraft | null {
  if (draft === null || !hasIcon(icons, draft.id)) return null;

  return draft;
}

function freezeState(input: {
  readonly error: DesktopIconsViewModelError | null;
  readonly grid: DesktopIconGridConfig;
  readonly icons: readonly DesktopIcon[];
  readonly marquee: Rect | null;
  readonly mode: DesktopIconPlacementMode;
  readonly renameDraft: DesktopIconRenameDraft | null;
  readonly selectedIds: readonly string[];
  readonly sortKey: DesktopIconSortKey | null;
}): DesktopIconsViewState {
  return Object.freeze({
    error: input.error,
    grid: input.grid,
    icons: Object.freeze(input.icons.map(freezeIcon)),
    marquee: input.marquee === null ? null : freezeRect(input.marquee),
    mode: input.mode,
    renameDraft: input.renameDraft === null ? null : Object.freeze({
      id: input.renameDraft.id,
      label: input.renameDraft.label,
    }),
    selectedIds: Object.freeze([...input.selectedIds]),
    sortKey: input.sortKey,
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
    position: freezePoint(input.position),
  };

  if (input.date !== undefined) output.date = input.date;
  if (input.size !== undefined) output.size = input.size;

  return Object.freeze(output);
}

function placeIcon(icon: DesktopIcon, position: DesktopIconPoint): DesktopIcon {
  return copyIcon(icon, {
    label: icon.label,
    position,
  });
}

function copyIcon(
  icon: DesktopIcon,
  changes: {
    readonly label: string;
    readonly position: DesktopIconPoint;
  },
): DesktopIcon {
  const output: {
    date?: number | string;
    iconRef: string;
    id: string;
    kind: string;
    label: string;
    position: DesktopIconPoint;
    size?: number;
  } = {
    iconRef: icon.iconRef,
    id: icon.id,
    kind: icon.kind,
    label: changes.label,
    position: changes.position,
  };

  if (icon.date !== undefined) output.date = icon.date;
  if (icon.size !== undefined) output.size = icon.size;

  return freezeIcon(output);
}

function freezePoint(point: DesktopIconPoint): DesktopIconPoint {
  return Object.freeze({
    x: Math.trunc(point.x),
    y: Math.trunc(point.y),
  });
}

function freezeRect(rect: Rect): Rect {
  return Object.freeze({
    height: Math.max(0, Math.trunc(rect.height)),
    width: Math.max(0, Math.trunc(rect.width)),
    x: Math.trunc(rect.x),
    y: Math.trunc(rect.y),
  });
}

function normalizeGridCell(cell: DesktopIconGridCell): DesktopIconGridCell {
  return Object.freeze({
    col: Math.max(0, Math.trunc(cell.col)),
    row: Math.max(0, Math.trunc(cell.row)),
  });
}

function gridPitchX(grid: DesktopIconGridConfig): number {
  return Math.max(1, grid.cell.width + grid.gutter.x);
}

function gridPitchY(grid: DesktopIconGridConfig): number {
  return Math.max(1, grid.cell.height + grid.gutter.y);
}

function gridCellKey(cell: DesktopIconGridCell): string {
  return `${cell.row}:${cell.col}`;
}

function hasIcon(icons: readonly DesktopIcon[], id: string | null): boolean {
  return id !== null && findIcon(icons, id) !== undefined;
}

function findIcon(icons: readonly DesktopIcon[], id: string): DesktopIcon | undefined {
  for (let index = 0; index < icons.length; index += 1) {
    const icon = icons[index];

    if (icon !== undefined && icon.id === id) return icon;
  }

  return undefined;
}

function findIconByLabel(
  icons: readonly DesktopIcon[],
  label: string,
  exceptId: string,
): DesktopIcon | undefined {
  for (let index = 0; index < icons.length; index += 1) {
    const icon = icons[index];

    if (icon !== undefined && icon.id !== exceptId && icon.label === label) {
      return icon;
    }
  }

  return undefined;
}

function iconIndex(icons: readonly DesktopIcon[], id: string): number {
  for (let index = 0; index < icons.length; index += 1) {
    if (icons[index]?.id === id) return index;
  }

  return -1;
}

function isSortKey(input: unknown): input is DesktopIconSortKey {
  return input === "name" || input === "kind" || input === "date" || input === "size";
}

function normalizePositiveInteger(input: number | undefined, fallback: number): number {
  if (input === undefined || !Number.isFinite(input) || input <= 0) return fallback;

  return Math.trunc(input);
}

function normalizeNonNegativeInteger(input: number | undefined, fallback: number): number {
  if (input === undefined || !Number.isFinite(input) || input < 0) return fallback;

  return Math.trunc(input);
}

function normalizeInteger(input: number | undefined, fallback: number): number {
  if (input === undefined || !Number.isFinite(input)) return fallback;

  return Math.trunc(input);
}

function finiteNumber(input: unknown): number | null {
  return typeof input === "number" && Number.isFinite(input) ? input : null;
}

function canonicalSortText(value: string): string {
  return value.trim().toLowerCase();
}

function compareStrings(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;

  return 0;
}

function compareNumbers(left: number, right: number): number {
  if (left < right) return -1;
  if (left > right) return 1;

  return 0;
}

function contains(values: readonly string[], value: string): boolean {
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

function error(
  code: DesktopIconsViewModelError["code"],
  message: string,
  path: string,
): DesktopIconsViewModelError {
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

function reject<T>(errorValue: DesktopIconsViewModelError): NormalizeResult<T> {
  return Object.freeze({
    error: errorValue,
    ok: false,
  });
}

function rejectRename(
  errorValue: DesktopIconsViewModelError,
  state: DesktopIconsViewState,
): DesktopIconsRenameResult {
  return Object.freeze({
    error: errorValue,
    ok: false,
    state,
  });
}
