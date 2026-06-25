import type {
  DesktopHost,
} from "../../../sdk/typescript/src/desktop-sdk/index.ts";

export const WIDGET_KINDS = Object.freeze([
  "clock",
  "calendar",
  "weather",
  "system-stats",
  "notes",
  "recent-files",
] as const);

export const WIDGET_SIZE_CLASSES = Object.freeze([
  "S",
  "M",
  "L",
] as const);

export type WidgetKind = typeof WIDGET_KINDS[number];
export type WidgetSizeClass = typeof WIDGET_SIZE_CLASSES[number];
export type WidgetInstanceId = string;
export type WidgetZoneId = string;

export interface WidgetGridSpan {
  readonly columns: number;
  readonly rows: number;
}

export interface WidgetDescriptor {
  readonly kind: WidgetKind;
  readonly allowedSizeClasses: readonly WidgetSizeClass[];
  readonly defaultRefreshIntervalMs: number;
}

export interface WidgetHostZone {
  readonly id: WidgetZoneId;
  readonly columns: number;
  readonly rows: number;
}

export interface WidgetHostGrid {
  readonly zones: readonly WidgetHostZone[];
}

export interface WidgetPlacement {
  readonly zone: WidgetZoneId;
  readonly column: number;
  readonly row: number;
}

export interface WidgetInstance {
  readonly id: WidgetInstanceId;
  readonly kind: WidgetKind;
  readonly placement: WidgetPlacement;
  readonly sizeClass: WidgetSizeClass;
  readonly enabled: boolean;
  readonly paused: boolean;
  readonly refreshIntervalMs: number;
}

export interface WidgetRefreshSchedule {
  readonly id: WidgetInstanceId;
  readonly nextRefreshAtMs: number;
}

export interface WidgetHostState {
  readonly descriptors: readonly WidgetDescriptor[];
  readonly grid: WidgetHostGrid;
  readonly instances: readonly WidgetInstance[];
  readonly refreshSchedule: readonly WidgetRefreshSchedule[];
}

export type WidgetHostPorts = Pick<DesktopHost, "package">;

export interface WidgetHostModelOptions {
  readonly descriptors?: readonly WidgetDescriptor[];
  readonly initialInstances?: readonly WidgetInstance[];
  readonly ports?: WidgetHostPorts;
  readonly zones?: readonly WidgetHostZone[];
}

export type WidgetHostErrorCode =
  | "DUPLICATE_WIDGET_ID"
  | "INVALID_BOOL"
  | "INVALID_CLOCK"
  | "INVALID_GRID"
  | "INVALID_INDEX"
  | "INVALID_PLACEMENT"
  | "INVALID_REFRESH_INTERVAL"
  | "INVALID_WIDGET_ID"
  | "NO_PLACEMENT_AVAILABLE"
  | "PLACEMENT_OUT_OF_BOUNDS"
  | "PLACEMENT_OVERLAP"
  | "UNKNOWN_WIDGET"
  | "UNKNOWN_WIDGET_KIND"
  | "UNKNOWN_ZONE"
  | "UNSUPPORTED_WIDGET_SIZE";

export interface WidgetHostError {
  readonly code: WidgetHostErrorCode;
  readonly message: string;
  readonly path: string;
}

export type WidgetHostActionResult =
  | {
      readonly ok: true;
      readonly state: WidgetHostState;
    }
  | {
      readonly ok: false;
      readonly error: WidgetHostError;
      readonly state: WidgetHostState;
    };

export type WidgetHostAddResult =
  | {
      readonly ok: true;
      readonly instance: WidgetInstance;
      readonly state: WidgetHostState;
    }
  | {
      readonly ok: false;
      readonly error: WidgetHostError;
      readonly state: WidgetHostState;
    };

export type WidgetHostTickResult =
  | {
      readonly ok: true;
      readonly due: readonly WidgetInstanceId[];
      readonly state: WidgetHostState;
    }
  | {
      readonly ok: false;
      readonly due: readonly [];
      readonly error: WidgetHostError;
      readonly state: WidgetHostState;
    };

export interface WidgetHostModel {
  readonly descriptors: readonly WidgetDescriptor[];
  readonly grid: WidgetHostGrid;
  snapshot(): WidgetHostState;
  add(kind: unknown, at?: unknown): WidgetHostAddResult;
  remove(id: unknown): WidgetHostActionResult;
  move(id: unknown, at: unknown): WidgetHostActionResult;
  resize(id: unknown, sizeClass: unknown): WidgetHostActionResult;
  reorder(id: unknown, index: unknown): WidgetHostActionResult;
  setEnabled(id: unknown, enabled: unknown): WidgetHostActionResult;
  setPaused(id: unknown, paused: unknown): WidgetHostActionResult;
  tick(clockMs: unknown): WidgetHostTickResult;
}

export const WIDGET_SIZE_SPANS: Readonly<Record<WidgetSizeClass, WidgetGridSpan>> = Object.freeze({
  L: Object.freeze({
    columns: 2,
    rows: 2,
  }),
  M: Object.freeze({
    columns: 2,
    rows: 1,
  }),
  S: Object.freeze({
    columns: 1,
    rows: 1,
  }),
});

export const DEFAULT_WIDGET_HOST_ZONES = Object.freeze([
  Object.freeze({
    columns: 6,
    id: "desktop",
    rows: 4,
  }),
] satisfies readonly WidgetHostZone[]);

export const DEFAULT_WIDGET_DESCRIPTORS = Object.freeze([
  descriptor("clock", ["S", "M"], 60_000),
  descriptor("calendar", ["M", "L"], 300_000),
  descriptor("weather", ["M", "L"], 900_000),
  descriptor("system-stats", ["S", "M", "L"], 5_000),
  descriptor("notes", ["M", "L"], 120_000),
  descriptor("recent-files", ["M", "L"], 60_000),
] satisfies readonly WidgetDescriptor[]);

const EMPTY_TICK_DUE = Object.freeze([]) as readonly [];
const PLACEMENT_FIELDS = Object.freeze(["column", "row", "zone"]);

type NormalizeResult<T> =
  | {
      readonly ok: true;
      readonly value: T;
    }
  | {
      readonly ok: false;
      readonly error: WidgetHostError;
    };

export function createWidgetHostModel(
  options: WidgetHostModelOptions = Object.freeze({}),
): WidgetHostModel {
  return Object.freeze(new DesktopWidgetHostModel(options));
}

export function createWidgetHostState(
  options: WidgetHostModelOptions = Object.freeze({}),
): WidgetHostState {
  const descriptors = freezeDescriptors(options.descriptors ?? DEFAULT_WIDGET_DESCRIPTORS);
  const grid = freezeGrid(options.zones ?? DEFAULT_WIDGET_HOST_ZONES);
  const instances = normalizeInitialInstances(options.initialInstances ?? Object.freeze([]), descriptors, grid);

  return freezeState({
    descriptors,
    grid,
    instances,
    refreshSchedule: scheduleFromInstances(instances),
  });
}

export function widgetSizeSpan(sizeClass: WidgetSizeClass): WidgetGridSpan {
  return WIDGET_SIZE_SPANS[sizeClass];
}

export function widgetInstancesOverlap(left: WidgetInstance, right: WidgetInstance): boolean {
  return placementsOverlap(
    left.placement,
    widgetSizeSpan(left.sizeClass),
    right.placement,
    widgetSizeSpan(right.sizeClass),
  );
}

class DesktopWidgetHostModel implements WidgetHostModel {
  #nextSequence: number;
  #state: WidgetHostState;

  constructor(options: WidgetHostModelOptions) {
    this.#state = createWidgetHostState(options);
    this.#nextSequence = nextWidgetSequence(this.#state.instances);
  }

  get descriptors(): readonly WidgetDescriptor[] {
    return this.#state.descriptors;
  }

  get grid(): WidgetHostGrid {
    return this.#state.grid;
  }

  snapshot(): WidgetHostState {
    return this.#state;
  }

  add(kind: unknown, at?: unknown): WidgetHostAddResult {
    const normalizedKind = normalizeWidgetKind(kind, "/add/kind");

    if (!normalizedKind.ok) {
      return this.#rejectAdd(normalizedKind.error);
    }

    const descriptorValue = descriptorFor(this.#state.descriptors, normalizedKind.value);

    if (descriptorValue === null) {
      return this.#rejectAdd(error(
        "UNKNOWN_WIDGET_KIND",
        "widget kind is not registered.",
        "/add/kind",
      ));
    }

    const sizeClass = defaultWidgetSizeClass(descriptorValue);
    const span = widgetSizeSpan(sizeClass);
    const placement = at === undefined
      ? findAvailablePlacement(this.#state, span)
      : normalizePlacement(at, "/add/placement");

    if (!placement.ok) {
      return this.#rejectAdd(placement.error);
    }

    const available = validatePlacement(this.#state, placement.value, span, null, "/add/placement");

    if (!available.ok) {
      return this.#rejectAdd(available.error);
    }

    const id = this.#allocateId();
    const instance = freezeInstance({
      enabled: true,
      id,
      kind: normalizedKind.value,
      paused: false,
      placement: placement.value,
      refreshIntervalMs: descriptorValue.defaultRefreshIntervalMs,
      sizeClass,
    });
    const instances = appendInstance(this.#state.instances, instance);
    const refreshSchedule = appendSchedule(this.#state.refreshSchedule, schedule(id, 0));

    this.#state = freezeState({
      descriptors: this.#state.descriptors,
      grid: this.#state.grid,
      instances,
      refreshSchedule,
    });

    return Object.freeze({
      instance,
      ok: true,
      state: this.#state,
    });
  }

  remove(id: unknown): WidgetHostActionResult {
    const normalizedId = normalizeWidgetId(id, "/remove/id");

    if (!normalizedId.ok) {
      return this.#reject(normalizedId.error);
    }

    const index = findInstanceIndex(this.#state.instances, normalizedId.value);

    if (index < 0) {
      return this.#reject(unknownWidget("/remove/id"));
    }

    return this.#commit(
      removeInstanceAt(this.#state.instances, index),
      removeSchedule(this.#state.refreshSchedule, normalizedId.value),
    );
  }

  move(id: unknown, at: unknown): WidgetHostActionResult {
    const normalizedId = normalizeWidgetId(id, "/move/id");

    if (!normalizedId.ok) {
      return this.#reject(normalizedId.error);
    }

    const placement = normalizePlacement(at, "/move/placement");

    if (!placement.ok) {
      return this.#reject(placement.error);
    }

    const index = findInstanceIndex(this.#state.instances, normalizedId.value);

    if (index < 0) {
      return this.#reject(unknownWidget("/move/id"));
    }

    const instance = this.#state.instances[index];

    if (instance === undefined) {
      return this.#reject(unknownWidget("/move/id"));
    }

    const available = validatePlacement(
      this.#state,
      placement.value,
      widgetSizeSpan(instance.sizeClass),
      instance.id,
      "/move/placement",
    );

    if (!available.ok) {
      return this.#reject(available.error);
    }

    return this.#commit(
      replaceInstanceAt(this.#state.instances, index, freezeInstance({
        enabled: instance.enabled,
        id: instance.id,
        kind: instance.kind,
        paused: instance.paused,
        placement: placement.value,
        refreshIntervalMs: instance.refreshIntervalMs,
        sizeClass: instance.sizeClass,
      })),
      this.#state.refreshSchedule,
    );
  }

  resize(id: unknown, sizeClass: unknown): WidgetHostActionResult {
    const normalizedId = normalizeWidgetId(id, "/resize/id");

    if (!normalizedId.ok) {
      return this.#reject(normalizedId.error);
    }

    const normalizedSize = normalizeWidgetSizeClass(sizeClass, "/resize/sizeClass");

    if (!normalizedSize.ok) {
      return this.#reject(normalizedSize.error);
    }

    const index = findInstanceIndex(this.#state.instances, normalizedId.value);

    if (index < 0) {
      return this.#reject(unknownWidget("/resize/id"));
    }

    const instance = this.#state.instances[index];

    if (instance === undefined) {
      return this.#reject(unknownWidget("/resize/id"));
    }

    const descriptorValue = descriptorFor(this.#state.descriptors, instance.kind);

    if (descriptorValue === null || !containsSize(descriptorValue.allowedSizeClasses, normalizedSize.value)) {
      return this.#reject(error(
        "UNSUPPORTED_WIDGET_SIZE",
        "widget kind does not allow that size class.",
        "/resize/sizeClass",
      ));
    }

    const available = validatePlacement(
      this.#state,
      instance.placement,
      widgetSizeSpan(normalizedSize.value),
      instance.id,
      "/resize/placement",
    );

    if (!available.ok) {
      return this.#reject(available.error);
    }

    return this.#commit(
      replaceInstanceAt(this.#state.instances, index, freezeInstance({
        enabled: instance.enabled,
        id: instance.id,
        kind: instance.kind,
        paused: instance.paused,
        placement: instance.placement,
        refreshIntervalMs: instance.refreshIntervalMs,
        sizeClass: normalizedSize.value,
      })),
      this.#state.refreshSchedule,
    );
  }

  reorder(id: unknown, index: unknown): WidgetHostActionResult {
    const normalizedId = normalizeWidgetId(id, "/reorder/id");

    if (!normalizedId.ok) {
      return this.#reject(normalizedId.error);
    }

    const normalizedIndex = normalizeIndex(index, "/reorder/index");

    if (!normalizedIndex.ok) {
      return this.#reject(normalizedIndex.error);
    }

    const fromIndex = findInstanceIndex(this.#state.instances, normalizedId.value);

    if (fromIndex < 0) {
      return this.#reject(unknownWidget("/reorder/id"));
    }
    if (normalizedIndex.value >= this.#state.instances.length) {
      return this.#reject(error(
        "INVALID_INDEX",
        "reorder index must target an existing widget slot.",
        "/reorder/index",
      ));
    }

    return this.#commit(reorderInstances(this.#state.instances, fromIndex, normalizedIndex.value), this.#state.refreshSchedule);
  }

  setEnabled(id: unknown, enabled: unknown): WidgetHostActionResult {
    const normalizedId = normalizeWidgetId(id, "/setEnabled/id");

    if (!normalizedId.ok) {
      return this.#reject(normalizedId.error);
    }

    const normalizedBool = normalizeBool(enabled, "/setEnabled/enabled");

    if (!normalizedBool.ok) {
      return this.#reject(normalizedBool.error);
    }

    const index = findInstanceIndex(this.#state.instances, normalizedId.value);

    if (index < 0) {
      return this.#reject(unknownWidget("/setEnabled/id"));
    }

    const instance = this.#state.instances[index];

    if (instance === undefined) {
      return this.#reject(unknownWidget("/setEnabled/id"));
    }

    return this.#commit(
      replaceInstanceAt(this.#state.instances, index, freezeInstance({
        enabled: normalizedBool.value,
        id: instance.id,
        kind: instance.kind,
        paused: instance.paused,
        placement: instance.placement,
        refreshIntervalMs: instance.refreshIntervalMs,
        sizeClass: instance.sizeClass,
      })),
      this.#state.refreshSchedule,
    );
  }

  setPaused(id: unknown, paused: unknown): WidgetHostActionResult {
    const normalizedId = normalizeWidgetId(id, "/setPaused/id");

    if (!normalizedId.ok) {
      return this.#reject(normalizedId.error);
    }

    const normalizedBool = normalizeBool(paused, "/setPaused/paused");

    if (!normalizedBool.ok) {
      return this.#reject(normalizedBool.error);
    }

    const index = findInstanceIndex(this.#state.instances, normalizedId.value);

    if (index < 0) {
      return this.#reject(unknownWidget("/setPaused/id"));
    }

    const instance = this.#state.instances[index];

    if (instance === undefined) {
      return this.#reject(unknownWidget("/setPaused/id"));
    }

    return this.#commit(
      replaceInstanceAt(this.#state.instances, index, freezeInstance({
        enabled: instance.enabled,
        id: instance.id,
        kind: instance.kind,
        paused: normalizedBool.value,
        placement: instance.placement,
        refreshIntervalMs: instance.refreshIntervalMs,
        sizeClass: instance.sizeClass,
      })),
      this.#state.refreshSchedule,
    );
  }

  tick(clockMs: unknown): WidgetHostTickResult {
    const normalizedClock = normalizeClock(clockMs, "/tick/clockMs");

    if (!normalizedClock.ok) {
      return Object.freeze({
        due: EMPTY_TICK_DUE,
        error: normalizedClock.error,
        ok: false,
        state: this.#state,
      });
    }

    const due: WidgetInstanceId[] = [];
    const refreshSchedule: WidgetRefreshSchedule[] = [];

    for (let index = 0; index < this.#state.instances.length; index += 1) {
      const instance = this.#state.instances[index];

      if (instance === undefined) {
        continue;
      }

      const current = findSchedule(this.#state.refreshSchedule, instance.id) ?? schedule(instance.id, 0);
      let nextRefreshAtMs = current.nextRefreshAtMs;

      if (instance.enabled && !instance.paused && normalizedClock.value >= current.nextRefreshAtMs) {
        due.push(instance.id);
        nextRefreshAtMs = advanceRefreshSchedule(
          current.nextRefreshAtMs,
          instance.refreshIntervalMs,
          normalizedClock.value,
        );
      }

      refreshSchedule.push(schedule(instance.id, nextRefreshAtMs));
    }

    this.#state = freezeState({
      descriptors: this.#state.descriptors,
      grid: this.#state.grid,
      instances: this.#state.instances,
      refreshSchedule,
    });

    return Object.freeze({
      due: Object.freeze(due),
      ok: true,
      state: this.#state,
    });
  }

  #allocateId(): WidgetInstanceId {
    let id = `widget-${this.#nextSequence}`;

    while (hasInstance(this.#state.instances, id)) {
      this.#nextSequence += 1;
      id = `widget-${this.#nextSequence}`;
    }

    this.#nextSequence += 1;

    return id;
  }

  #commit(
    instances: readonly WidgetInstance[],
    refreshSchedule: readonly WidgetRefreshSchedule[],
  ): WidgetHostActionResult {
    this.#state = freezeState({
      descriptors: this.#state.descriptors,
      grid: this.#state.grid,
      instances,
      refreshSchedule,
    });

    return Object.freeze({
      ok: true,
      state: this.#state,
    });
  }

  #reject(errorValue: WidgetHostError): WidgetHostActionResult {
    return Object.freeze({
      error: errorValue,
      ok: false,
      state: this.#state,
    });
  }

  #rejectAdd(errorValue: WidgetHostError): WidgetHostAddResult {
    return Object.freeze({
      error: errorValue,
      ok: false,
      state: this.#state,
    });
  }
}

function descriptor(
  kind: WidgetKind,
  allowedSizeClasses: readonly WidgetSizeClass[],
  defaultRefreshIntervalMs: number,
): WidgetDescriptor {
  return Object.freeze({
    allowedSizeClasses: Object.freeze([...allowedSizeClasses]),
    defaultRefreshIntervalMs,
    kind,
  });
}

function freezeDescriptors(descriptors: readonly WidgetDescriptor[]): readonly WidgetDescriptor[] {
  const output: WidgetDescriptor[] = [];

  for (let index = 0; index < descriptors.length; index += 1) {
    const current = descriptors[index];

    if (current === undefined || descriptorFor(output, current.kind) !== null) {
      continue;
    }
    if (!isPositiveSafeInteger(current.defaultRefreshIntervalMs) || current.allowedSizeClasses.length === 0) {
      continue;
    }

    const allowedSizeClasses: WidgetSizeClass[] = [];

    for (let sizeIndex = 0; sizeIndex < current.allowedSizeClasses.length; sizeIndex += 1) {
      const sizeClass = current.allowedSizeClasses[sizeIndex];

      if (sizeClass !== undefined && containsSize(WIDGET_SIZE_CLASSES, sizeClass) && !containsSize(allowedSizeClasses, sizeClass)) {
        allowedSizeClasses.push(sizeClass);
      }
    }

    if (allowedSizeClasses.length === 0) {
      continue;
    }

    output.push(descriptor(current.kind, allowedSizeClasses, current.defaultRefreshIntervalMs));
  }

  return Object.freeze(output);
}

function freezeGrid(zones: readonly WidgetHostZone[]): WidgetHostGrid {
  const output: WidgetHostZone[] = [];

  for (let index = 0; index < zones.length; index += 1) {
    const zoneValue = zones[index];

    if (zoneValue === undefined || zoneFor(output, zoneValue.id) !== null) {
      continue;
    }
    if (zoneValue.id.length === 0 || !isPositiveSafeInteger(zoneValue.columns) || !isPositiveSafeInteger(zoneValue.rows)) {
      continue;
    }

    output.push(Object.freeze({
      columns: zoneValue.columns,
      id: zoneValue.id,
      rows: zoneValue.rows,
    }));
  }

  if (output.length === 0) {
    return Object.freeze({
      zones: DEFAULT_WIDGET_HOST_ZONES,
    });
  }

  return Object.freeze({
    zones: Object.freeze(output),
  });
}

function normalizeInitialInstances(
  instances: readonly WidgetInstance[],
  descriptors: readonly WidgetDescriptor[],
  grid: WidgetHostGrid,
): readonly WidgetInstance[] {
  const output: WidgetInstance[] = [];

  for (let index = 0; index < instances.length; index += 1) {
    const current = instances[index];

    if (current === undefined || hasInstance(output, current.id)) {
      return Object.freeze([]);
    }

    const descriptorValue = descriptorFor(descriptors, current.kind);

    if (
      current.id.length === 0 ||
      descriptorValue === null ||
      !containsSize(descriptorValue.allowedSizeClasses, current.sizeClass) ||
      !isPositiveSafeInteger(current.refreshIntervalMs) ||
      typeof current.enabled !== "boolean" ||
      typeof current.paused !== "boolean" ||
      !isSafePlacementShape(current.placement)
    ) {
      return Object.freeze([]);
    }

    const candidate = freezeInstance(current);
    const partialState = freezeState({
      descriptors,
      grid,
      instances: output,
      refreshSchedule: scheduleFromInstances(output),
    });
    const available = validatePlacement(
      partialState,
      candidate.placement,
      widgetSizeSpan(candidate.sizeClass),
      null,
      `/initialInstances/${index}/placement`,
    );

    if (!available.ok) {
      return Object.freeze([]);
    }

    output.push(candidate);
  }

  return Object.freeze(output);
}

function isSafePlacementShape(input: WidgetPlacement): boolean {
  return (
    typeof input.zone === "string" &&
    input.zone.length > 0 &&
    isNonNegativeSafeInteger(input.column) &&
    isNonNegativeSafeInteger(input.row)
  );
}

function freezeState(input: {
  readonly descriptors: readonly WidgetDescriptor[];
  readonly grid: WidgetHostGrid;
  readonly instances: readonly WidgetInstance[];
  readonly refreshSchedule: readonly WidgetRefreshSchedule[];
}): WidgetHostState {
  const instances = freezeInstances(input.instances);

  return Object.freeze({
    descriptors: input.descriptors,
    grid: input.grid,
    instances,
    refreshSchedule: alignRefreshSchedule(instances, input.refreshSchedule),
  });
}

function freezeInstances(instances: readonly WidgetInstance[]): readonly WidgetInstance[] {
  const output: WidgetInstance[] = [];

  for (let index = 0; index < instances.length; index += 1) {
    const instance = instances[index];

    if (instance !== undefined) {
      output.push(freezeInstance(instance));
    }
  }

  return Object.freeze(output);
}

function freezeInstance(instance: WidgetInstance): WidgetInstance {
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

function schedule(id: WidgetInstanceId, nextRefreshAtMs: number): WidgetRefreshSchedule {
  return Object.freeze({
    id,
    nextRefreshAtMs,
  });
}

function scheduleFromInstances(instances: readonly WidgetInstance[]): readonly WidgetRefreshSchedule[] {
  const output: WidgetRefreshSchedule[] = [];

  for (let index = 0; index < instances.length; index += 1) {
    const instance = instances[index];

    if (instance !== undefined) {
      output.push(schedule(instance.id, 0));
    }
  }

  return Object.freeze(output);
}

function alignRefreshSchedule(
  instances: readonly WidgetInstance[],
  refreshSchedule: readonly WidgetRefreshSchedule[],
): readonly WidgetRefreshSchedule[] {
  const output: WidgetRefreshSchedule[] = [];

  for (let index = 0; index < instances.length; index += 1) {
    const instance = instances[index];

    if (instance === undefined) {
      continue;
    }

    const current = findSchedule(refreshSchedule, instance.id);
    const nextRefreshAtMs = current?.nextRefreshAtMs ?? 0;

    output.push(schedule(instance.id, isNonNegativeSafeInteger(nextRefreshAtMs) ? nextRefreshAtMs : 0));
  }

  return Object.freeze(output);
}

function appendInstance(
  instances: readonly WidgetInstance[],
  instance: WidgetInstance,
): readonly WidgetInstance[] {
  const output: WidgetInstance[] = [];

  copyInstances(instances, output);
  output.push(instance);

  return Object.freeze(output);
}

function replaceInstanceAt(
  instances: readonly WidgetInstance[],
  index: number,
  instance: WidgetInstance,
): readonly WidgetInstance[] {
  const output: WidgetInstance[] = [];

  for (let currentIndex = 0; currentIndex < instances.length; currentIndex += 1) {
    const current = instances[currentIndex];

    if (current !== undefined) {
      output.push(currentIndex === index ? instance : current);
    }
  }

  return Object.freeze(output);
}

function removeInstanceAt(
  instances: readonly WidgetInstance[],
  index: number,
): readonly WidgetInstance[] {
  const output: WidgetInstance[] = [];

  for (let currentIndex = 0; currentIndex < instances.length; currentIndex += 1) {
    const current = instances[currentIndex];

    if (current !== undefined && currentIndex !== index) {
      output.push(current);
    }
  }

  return Object.freeze(output);
}

function reorderInstances(
  instances: readonly WidgetInstance[],
  fromIndex: number,
  toIndex: number,
): readonly WidgetInstance[] {
  const moved = instances[fromIndex];

  if (moved === undefined) {
    return instances;
  }

  const remaining: WidgetInstance[] = [];

  for (let index = 0; index < instances.length; index += 1) {
    const current = instances[index];

    if (current !== undefined && index !== fromIndex) {
      remaining.push(current);
    }
  }

  const output: WidgetInstance[] = [];
  const insertAt = Math.min(toIndex, remaining.length);

  for (let index = 0; index <= remaining.length; index += 1) {
    if (index === insertAt) {
      output.push(moved);
    }

    const current = remaining[index];

    if (current !== undefined) {
      output.push(current);
    }
  }

  return Object.freeze(output);
}

function copyInstances(source: readonly WidgetInstance[], target: WidgetInstance[]): void {
  for (let index = 0; index < source.length; index += 1) {
    const instance = source[index];

    if (instance !== undefined) {
      target.push(instance);
    }
  }
}

function appendSchedule(
  refreshSchedule: readonly WidgetRefreshSchedule[],
  next: WidgetRefreshSchedule,
): readonly WidgetRefreshSchedule[] {
  const output: WidgetRefreshSchedule[] = [];

  for (let index = 0; index < refreshSchedule.length; index += 1) {
    const current = refreshSchedule[index];

    if (current !== undefined) {
      output.push(current);
    }
  }

  output.push(next);

  return Object.freeze(output);
}

function removeSchedule(
  refreshSchedule: readonly WidgetRefreshSchedule[],
  id: WidgetInstanceId,
): readonly WidgetRefreshSchedule[] {
  const output: WidgetRefreshSchedule[] = [];

  for (let index = 0; index < refreshSchedule.length; index += 1) {
    const current = refreshSchedule[index];

    if (current !== undefined && current.id !== id) {
      output.push(current);
    }
  }

  return Object.freeze(output);
}

function descriptorFor(
  descriptors: readonly WidgetDescriptor[],
  kind: WidgetKind,
): WidgetDescriptor | null {
  for (let index = 0; index < descriptors.length; index += 1) {
    const current = descriptors[index];

    if (current !== undefined && current.kind === kind) {
      return current;
    }
  }

  return null;
}

function defaultWidgetSizeClass(descriptorValue: WidgetDescriptor): WidgetSizeClass {
  const first = descriptorValue.allowedSizeClasses[0];

  return first ?? "S";
}

function zoneFor(zones: readonly WidgetHostZone[], zoneId: WidgetZoneId): WidgetHostZone | null {
  for (let index = 0; index < zones.length; index += 1) {
    const current = zones[index];

    if (current !== undefined && current.id === zoneId) {
      return current;
    }
  }

  return null;
}

function hasInstance(instances: readonly WidgetInstance[], id: WidgetInstanceId): boolean {
  return findInstanceIndex(instances, id) >= 0;
}

function findInstanceIndex(instances: readonly WidgetInstance[], id: WidgetInstanceId): number {
  for (let index = 0; index < instances.length; index += 1) {
    const current = instances[index];

    if (current !== undefined && current.id === id) {
      return index;
    }
  }

  return -1;
}

function findSchedule(
  refreshSchedule: readonly WidgetRefreshSchedule[],
  id: WidgetInstanceId,
): WidgetRefreshSchedule | null {
  for (let index = 0; index < refreshSchedule.length; index += 1) {
    const current = refreshSchedule[index];

    if (current !== undefined && current.id === id) {
      return current;
    }
  }

  return null;
}

function findAvailablePlacement(
  state: WidgetHostState,
  span: WidgetGridSpan,
): NormalizeResult<WidgetPlacement> {
  for (let zoneIndex = 0; zoneIndex < state.grid.zones.length; zoneIndex += 1) {
    const zoneValue = state.grid.zones[zoneIndex];

    if (zoneValue === undefined) {
      continue;
    }

    for (let row = 0; row < zoneValue.rows; row += 1) {
      for (let column = 0; column < zoneValue.columns; column += 1) {
        const placement = freezePlacement({
          column,
          row,
          zone: zoneValue.id,
        });
        const available = validatePlacement(state, placement, span, null, "/add/placement");

        if (available.ok) {
          return accept(placement);
        }
      }
    }
  }

  return reject(error(
    "NO_PLACEMENT_AVAILABLE",
    "no non-overlapping widget placement is available.",
    "/add/placement",
  ));
}

function validatePlacement(
  state: WidgetHostState,
  placement: WidgetPlacement,
  span: WidgetGridSpan,
  ignoreId: WidgetInstanceId | null,
  path: string,
): NormalizeResult<true> {
  const zoneValue = zoneFor(state.grid.zones, placement.zone);

  if (zoneValue === null) {
    return reject(error("UNKNOWN_ZONE", "widget placement targets an unknown zone.", `${path}/zone`));
  }
  if (
    placement.column + span.columns > zoneValue.columns ||
    placement.row + span.rows > zoneValue.rows
  ) {
    return reject(error("PLACEMENT_OUT_OF_BOUNDS", "widget placement exceeds zone bounds.", path));
  }

  for (let index = 0; index < state.instances.length; index += 1) {
    const current = state.instances[index];

    if (current === undefined || current.id === ignoreId) {
      continue;
    }

    if (placementsOverlap(placement, span, current.placement, widgetSizeSpan(current.sizeClass))) {
      return reject(error("PLACEMENT_OVERLAP", "widget placement overlaps an existing widget.", path));
    }
  }

  return accept(true);
}

function placementsOverlap(
  leftPlacement: WidgetPlacement,
  leftSpan: WidgetGridSpan,
  rightPlacement: WidgetPlacement,
  rightSpan: WidgetGridSpan,
): boolean {
  if (leftPlacement.zone !== rightPlacement.zone) {
    return false;
  }

  return (
    leftPlacement.column < rightPlacement.column + rightSpan.columns &&
    leftPlacement.column + leftSpan.columns > rightPlacement.column &&
    leftPlacement.row < rightPlacement.row + rightSpan.rows &&
    leftPlacement.row + leftSpan.rows > rightPlacement.row
  );
}

function advanceRefreshSchedule(
  nextRefreshAtMs: number,
  refreshIntervalMs: number,
  clockMs: number,
): number {
  const elapsed = clockMs - nextRefreshAtMs;
  const steps = Math.floor(elapsed / refreshIntervalMs) + 1;

  return nextRefreshAtMs + steps * refreshIntervalMs;
}

function nextWidgetSequence(instances: readonly WidgetInstance[]): number {
  let next = 1;

  for (let index = 0; index < instances.length; index += 1) {
    const instance = instances[index];

    if (instance === undefined) {
      continue;
    }

    const prefix = "widget-";

    if (!instance.id.startsWith(prefix)) {
      continue;
    }

    const parsed = Number.parseInt(instance.id.slice(prefix.length), 10);

    if (Number.isSafeInteger(parsed) && parsed >= next) {
      next = parsed + 1;
    }
  }

  return next;
}

function normalizeWidgetKind(input: unknown, path: string): NormalizeResult<WidgetKind> {
  if (typeof input !== "string") {
    return reject(error("UNKNOWN_WIDGET_KIND", "widget kind is not supported.", path));
  }

  for (let index = 0; index < WIDGET_KINDS.length; index += 1) {
    const current = WIDGET_KINDS[index];

    if (current !== undefined && input === current) {
      return accept(current);
    }
  }

  return reject(error("UNKNOWN_WIDGET_KIND", "widget kind is not supported.", path));
}

function normalizeWidgetId(input: unknown, path: string): NormalizeResult<WidgetInstanceId> {
  if (typeof input !== "string" || input.length === 0) {
    return reject(error("INVALID_WIDGET_ID", "widget id must be a non-empty string.", path));
  }

  return accept(input);
}

function normalizeWidgetSizeClass(input: unknown, path: string): NormalizeResult<WidgetSizeClass> {
  if (typeof input !== "string") {
    return reject(error("UNSUPPORTED_WIDGET_SIZE", "widget size class is not supported.", path));
  }

  for (let index = 0; index < WIDGET_SIZE_CLASSES.length; index += 1) {
    const current = WIDGET_SIZE_CLASSES[index];

    if (current !== undefined && input === current) {
      return accept(current);
    }
  }

  return reject(error("UNSUPPORTED_WIDGET_SIZE", "widget size class is not supported.", path));
}

function normalizePlacement(input: unknown, path: string): NormalizeResult<WidgetPlacement> {
  const object = snapshotObject(input, PLACEMENT_FIELDS, path);

  if (!object.ok) {
    return reject(object.error);
  }

  const zoneValue = object.value.get("zone");
  const column = object.value.get("column");
  const row = object.value.get("row");

  if (typeof zoneValue !== "string" || zoneValue.length === 0) {
    return reject(error("INVALID_PLACEMENT", "widget placement zone must be a non-empty string.", `${path}/zone`));
  }
  if (!isNonNegativeSafeInteger(column)) {
    return reject(error("INVALID_PLACEMENT", "widget placement column must be a non-negative integer.", `${path}/column`));
  }
  if (!isNonNegativeSafeInteger(row)) {
    return reject(error("INVALID_PLACEMENT", "widget placement row must be a non-negative integer.", `${path}/row`));
  }

  return accept(freezePlacement({
    column,
    row,
    zone: zoneValue,
  }));
}

function normalizeBool(input: unknown, path: string): NormalizeResult<boolean> {
  if (typeof input !== "boolean") {
    return reject(error("INVALID_BOOL", "widget flag must be a boolean.", path));
  }

  return accept(input);
}

function normalizeClock(input: unknown, path: string): NormalizeResult<number> {
  if (!isNonNegativeSafeInteger(input)) {
    return reject(error("INVALID_CLOCK", "clockMs must be a non-negative integer.", path));
  }

  return accept(input);
}

function normalizeIndex(input: unknown, path: string): NormalizeResult<number> {
  if (!isNonNegativeSafeInteger(input)) {
    return reject(error("INVALID_INDEX", "index must be a non-negative integer.", path));
  }

  return accept(input);
}

function snapshotObject(
  input: unknown,
  allowedKeys: readonly string[],
  path: string,
): NormalizeResult<ReadonlyMap<string, unknown>> {
  try {
    if (input === null || typeof input !== "object" || Array.isArray(input)) {
      return reject(error("INVALID_PLACEMENT", "value must be a plain object.", path));
    }

    const prototype = Object.getPrototypeOf(input);

    if (prototype !== Object.prototype && prototype !== null) {
      return reject(error("INVALID_PLACEMENT", "value must be a plain object.", path));
    }

    const keys = Reflect.ownKeys(input);
    const output = new Map<string, unknown>();

    for (let index = 0; index < keys.length; index += 1) {
      const key = keys[index];

      if (key === undefined || typeof key === "symbol" || !containsString(allowedKeys, key)) {
        return reject(error("INVALID_PLACEMENT", "object contains an unsupported field.", path));
      }

      const descriptorValue = Object.getOwnPropertyDescriptor(input, key);

      if (
        descriptorValue === undefined ||
        !isDataDescriptor(descriptorValue) ||
        descriptorValue.enumerable !== true
      ) {
        return reject(error("INVALID_PLACEMENT", "object must contain only enumerable data fields.", path));
      }

      output.set(key, descriptorValue.value);
    }

    return accept(output);
  } catch {
    return reject(error("INVALID_PLACEMENT", "value must be a stable plain object.", path));
  }
}

function containsSize(values: readonly WidgetSizeClass[], value: WidgetSizeClass): boolean {
  for (let index = 0; index < values.length; index += 1) {
    if (values[index] === value) {
      return true;
    }
  }

  return false;
}

function containsString(values: readonly string[], value: string): boolean {
  for (let index = 0; index < values.length; index += 1) {
    if (values[index] === value) {
      return true;
    }
  }

  return false;
}

function isDataDescriptor(descriptorValue: PropertyDescriptor): descriptorValue is PropertyDescriptor & {
  readonly value: unknown;
} {
  return Object.prototype.hasOwnProperty.call(descriptorValue, "value");
}

function isPositiveSafeInteger(input: unknown): input is number {
  return typeof input === "number" && Number.isSafeInteger(input) && input > 0;
}

function isNonNegativeSafeInteger(input: unknown): input is number {
  return typeof input === "number" && Number.isSafeInteger(input) && input >= 0;
}

function unknownWidget(path: string): WidgetHostError {
  return error("UNKNOWN_WIDGET", "widget instance is not registered.", path);
}

function error(code: WidgetHostErrorCode, message: string, path: string): WidgetHostError {
  return Object.freeze({
    code,
    message,
    path,
  });
}

function accept<T>(value: T): NormalizeResult<T> {
  return {
    ok: true,
    value,
  };
}

function reject<T>(errorValue: WidgetHostError): NormalizeResult<T> {
  return {
    error: errorValue,
    ok: false,
  };
}
