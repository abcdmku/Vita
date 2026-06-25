import type {
  DesktopHostError,
  DesktopHostResult,
  DesktopMaybePromise,
} from "../../../sdk/typescript/src/desktop-sdk/index.ts";

export const ACTIVITY_METRICS_CAPABILITY = "metrics.read";
export const ACTIVITY_DEFAULT_SAMPLE_WINDOW_MS = 60_000;
export const ACTIVITY_DEFAULT_MAX_SAMPLES = 13;

export type ActivitySortColumn = "cpu" | "memory" | "name" | "pid";
export type ActivitySortDirection = "asc" | "desc";
export type ActivityViewStatus = "idle" | "ready" | "forbidden" | "error";
export type ActivityViewModelError = DesktopHostError;

export interface ActivityClock {
  nowMs(): number;
}

export interface ActivityMetricsRequest {
  readonly capability: typeof ACTIVITY_METRICS_CAPABILITY;
}

export interface ActivityMetricsMemorySample {
  readonly usedBytes: number;
  readonly totalBytes: number;
}

export interface ActivityMetricsProcessSample {
  readonly pid: number;
  readonly name: string;
  readonly cpuPercent: number;
  readonly memoryBytes: number;
}

export interface ActivityMetricsSample {
  readonly cpuPercent: number;
  readonly memory: ActivityMetricsMemorySample;
  readonly processes: readonly ActivityMetricsProcessSample[];
}

export interface ActivityMetricsPort {
  sample(request: ActivityMetricsRequest): DesktopMaybePromise<DesktopHostResult<ActivityMetricsSample>>;
}

export interface ActivitySortState {
  readonly column: ActivitySortColumn;
  readonly direction: ActivitySortDirection;
}

export interface ActivityMetricPoint {
  readonly sampledAtMs: number;
  readonly value: number;
}

export interface ActivityMemoryState {
  readonly usedBytes: number;
  readonly totalBytes: number;
  readonly percent: number;
  readonly averagePercent: number;
  readonly history: readonly ActivityMetricPoint[];
}

export interface ActivityProcessView {
  readonly pid: number;
  readonly name: string;
  readonly cpuPercent: number;
  readonly memoryBytes: number;
  readonly cpuAveragePercent: number;
  readonly memoryAverageBytes: number;
  readonly selected: boolean;
}

export interface ActivityViewState {
  readonly status: ActivityViewStatus;
  readonly sampledAtMs: number | null;
  readonly cpuPercent: number;
  readonly cpuAveragePercent: number;
  readonly cpuHistory: readonly ActivityMetricPoint[];
  readonly memory: ActivityMemoryState;
  readonly processes: readonly ActivityProcessView[];
  readonly processCount: number;
  readonly selectedPid: number | null;
  readonly sort: ActivitySortState;
  readonly sampleCount: number;
  readonly error?: ActivityViewModelError;
}

export type ActivityActionResult =
  | {
      readonly ok: true;
      readonly state: ActivityViewState;
    }
  | {
      readonly ok: false;
      readonly error: ActivityViewModelError;
      readonly state: ActivityViewState;
    };

export interface ActivityViewModelOptions {
  readonly clock: ActivityClock;
  readonly metrics?: ActivityMetricsPort;
  readonly initialSort?: ActivitySortState;
  readonly maxSamples?: number;
  readonly sampleWindowMs?: number;
}

interface TimedActivitySample extends ActivityMetricsSample {
  readonly sampledAtMs: number;
}

type NormalizeResult<T> =
  | {
      readonly ok: true;
      readonly value: T;
    }
  | {
      readonly ok: false;
      readonly error: ActivityViewModelError;
    };

type NormalizedMetricsResult =
  | {
      readonly ok: true;
      readonly value: unknown;
    }
  | {
      readonly ok: false;
      readonly error: ActivityViewModelError;
    };

const SAMPLE_FIELDS = Object.freeze(["cpuPercent", "memory", "processes"]);
const MEMORY_FIELDS = Object.freeze(["totalBytes", "usedBytes"]);
const PROCESS_FIELDS = Object.freeze(["cpuPercent", "memoryBytes", "name", "pid"]);
const RESULT_REQUIRED_FIELDS = Object.freeze(["ok"]);
const RESULT_OPTIONAL_FIELDS = Object.freeze(["error", "value"]);
const ERROR_FIELDS = Object.freeze(["code", "message", "path"]);
const EMPTY_POINTS = Object.freeze([]) satisfies readonly ActivityMetricPoint[];
const EMPTY_PROCESSES = Object.freeze([]) satisfies readonly ActivityProcessView[];
const DEFAULT_SORT = Object.freeze({
  column: "cpu",
  direction: "desc",
}) satisfies ActivitySortState;

export class ActivityViewModel {
  readonly #clock: ActivityClock;
  readonly #maxSamples: number;
  readonly #metrics: ActivityMetricsPort | undefined;
  readonly #sampleWindowMs: number;
  #samples: readonly TimedActivitySample[] = Object.freeze([]);
  #selectedPid: number | null = null;
  #sort: ActivitySortState;
  #state: ActivityViewState;

  constructor(options: ActivityViewModelOptions) {
    this.#clock = options.clock;
    this.#metrics = options.metrics;
    this.#maxSamples = normalizePositiveInteger(options.maxSamples, ACTIVITY_DEFAULT_MAX_SAMPLES);
    this.#sampleWindowMs = normalizePositiveNumber(options.sampleWindowMs, ACTIVITY_DEFAULT_SAMPLE_WINDOW_MS);
    this.#sort = freezeSortState(options.initialSort ?? DEFAULT_SORT);
    this.#state = emptyState("idle", this.#sort, null);
  }

  get state(): ActivityViewState {
    return this.#state;
  }

  snapshot(): ActivityViewState {
    return this.#state;
  }

  async refresh(): Promise<ActivityActionResult> {
    const metrics = this.#metrics;

    if (metrics === undefined) {
      return this.#replaceWithFailure(error(
        "MISSING_CAPABILITY",
        "activity view-model requires an injected metrics capability port.",
        "/metrics",
      ), "forbidden");
    }

    let rawResult: unknown;

    try {
      rawResult = await metrics.sample(Object.freeze({
        capability: ACTIVITY_METRICS_CAPABILITY,
      }));
    } catch (caught) {
      return this.#replaceWithFailure(error(
        "METRICS_PORT_FAILED",
        errorMessage(caught, "metrics port failed closed."),
        "/metrics/sample",
      ), "error");
    }

    const result = normalizeMetricsResult(rawResult);

    if (!result.ok) {
      return this.#replaceWithFailure(result.error, "error");
    }
    if (!result.value.ok) {
      return this.#replaceWithFailure(result.value.error, statusForError(result.value.error));
    }

    const sample = normalizeMetricsSample(result.value.value);

    if (!sample.ok) {
      return this.#replaceWithFailure(sample.error, "error");
    }

    const sampledAtMs = readClock(this.#clock);

    if (!sampledAtMs.ok) {
      return this.#replaceWithFailure(sampledAtMs.error, "error");
    }

    const timedSample = freezeTimedSample(sample.value, sampledAtMs.value);
    const samples = appendRollingSample(this.#samples, timedSample, this.#sampleWindowMs, this.#maxSamples);
    const selectedPid = hasProcess(timedSample.processes, this.#selectedPid) ? this.#selectedPid : null;

    this.#samples = samples;
    this.#selectedPid = selectedPid;
    this.#state = readyState(samples, this.#sort, selectedPid);

    return acceptAction(this.#state);
  }

  selectProcess(pid: unknown): ActivityActionResult {
    const normalized = normalizePid(pid, "/selectProcess/pid");

    if (!normalized.ok) return rejectAction(normalized.error, this.#state);

    if (!hasProcessView(this.#state.processes, normalized.value)) {
      return rejectAction(error(
        "UNKNOWN_PROCESS",
        "process is not present in the current activity sample.",
        "/selectProcess/pid",
      ), this.#state);
    }

    this.#selectedPid = normalized.value;
    this.#state = readyState(this.#samples, this.#sort, this.#selectedPid);

    return acceptAction(this.#state);
  }

  sortBy(column: unknown): ActivityActionResult {
    const normalized = normalizeSortColumn(column);

    if (!normalized.ok) return rejectAction(normalized.error, this.#state);

    this.#sort = nextSortState(this.#sort, normalized.value);
    this.#state = this.#samples.length === 0
      ? emptyState(this.#state.status, this.#sort, this.#state.error ?? null)
      : readyState(this.#samples, this.#sort, this.#selectedPid);

    return acceptAction(this.#state);
  }

  #replaceWithFailure(errorValue: ActivityViewModelError, status: Exclude<ActivityViewStatus, "idle" | "ready">): ActivityActionResult {
    this.#samples = Object.freeze([]);
    this.#selectedPid = null;
    this.#state = emptyState(status, this.#sort, errorValue);

    return rejectAction(errorValue, this.#state);
  }
}

export function createActivityViewModel(options: ActivityViewModelOptions): ActivityViewModel {
  return new ActivityViewModel(options);
}

function readyState(
  samples: readonly TimedActivitySample[],
  sort: ActivitySortState,
  selectedPid: number | null,
): ActivityViewState {
  const latest = samples[samples.length - 1];

  if (latest === undefined) return emptyState("idle", sort, null);

  const memoryPercent = memoryUsagePercent(latest.memory);
  const processRows = processViews(latest.processes, samples, selectedPid, sort);

  return Object.freeze({
    cpuAveragePercent: averageCpuPercent(samples),
    cpuHistory: metricHistory(samples, "cpu"),
    cpuPercent: latest.cpuPercent,
    memory: Object.freeze({
      averagePercent: averageMemoryPercent(samples),
      history: metricHistory(samples, "memory"),
      percent: memoryPercent,
      totalBytes: latest.memory.totalBytes,
      usedBytes: latest.memory.usedBytes,
    }),
    processCount: latest.processes.length,
    processes: processRows,
    sampleCount: samples.length,
    sampledAtMs: latest.sampledAtMs,
    selectedPid,
    sort,
    status: "ready",
  });
}

function emptyState(
  status: ActivityViewStatus,
  sort: ActivitySortState,
  errorValue: ActivityViewModelError | null,
): ActivityViewState {
  const output: {
    status: ActivityViewStatus;
    sampledAtMs: number | null;
    cpuPercent: number;
    cpuAveragePercent: number;
    cpuHistory: readonly ActivityMetricPoint[];
    memory: ActivityMemoryState;
    processes: readonly ActivityProcessView[];
    processCount: number;
    selectedPid: number | null;
    sort: ActivitySortState;
    sampleCount: number;
    error?: ActivityViewModelError;
  } = {
    cpuAveragePercent: 0,
    cpuHistory: EMPTY_POINTS,
    cpuPercent: 0,
    memory: Object.freeze({
      averagePercent: 0,
      history: EMPTY_POINTS,
      percent: 0,
      totalBytes: 0,
      usedBytes: 0,
    }),
    processCount: 0,
    processes: EMPTY_PROCESSES,
    sampleCount: 0,
    sampledAtMs: null,
    selectedPid: null,
    sort,
    status,
  };

  if (errorValue !== null) output.error = errorValue;

  return Object.freeze(output);
}

function appendRollingSample(
  samples: readonly TimedActivitySample[],
  sample: TimedActivitySample,
  sampleWindowMs: number,
  maxSamples: number,
): readonly TimedActivitySample[] {
  const windowStartMs = sample.sampledAtMs - sampleWindowMs;
  const output: TimedActivitySample[] = [];

  for (let index = 0; index < samples.length; index += 1) {
    const current = samples[index];

    if (current !== undefined && current.sampledAtMs >= windowStartMs) {
      output.push(current);
    }
  }

  output.push(sample);

  while (output.length > maxSamples) {
    output.shift();
  }

  return Object.freeze(output);
}

function metricHistory(
  samples: readonly TimedActivitySample[],
  field: "cpu" | "memory",
): readonly ActivityMetricPoint[] {
  if (samples.length === 0) return EMPTY_POINTS;

  const output: ActivityMetricPoint[] = [];

  for (let index = 0; index < samples.length; index += 1) {
    const sample = samples[index];

    if (sample === undefined) continue;
    output.push(Object.freeze({
      sampledAtMs: sample.sampledAtMs,
      value: field === "cpu" ? sample.cpuPercent : memoryUsagePercent(sample.memory),
    }));
  }

  return Object.freeze(output);
}

function processViews(
  processes: readonly ActivityMetricsProcessSample[],
  samples: readonly TimedActivitySample[],
  selectedPid: number | null,
  sort: ActivitySortState,
): readonly ActivityProcessView[] {
  if (processes.length === 0) return EMPTY_PROCESSES;

  const rows: ActivityProcessView[] = [];

  for (let index = 0; index < processes.length; index += 1) {
    const process = processes[index];

    if (process === undefined) continue;
    rows.push(Object.freeze({
      cpuAveragePercent: averageProcessCpuPercent(samples, process.pid),
      cpuPercent: process.cpuPercent,
      memoryAverageBytes: averageProcessMemoryBytes(samples, process.pid),
      memoryBytes: process.memoryBytes,
      name: process.name,
      pid: process.pid,
      selected: selectedPid === process.pid,
    }));
  }

  rows.sort((left, right) => compareProcessRows(left, right, sort));

  return Object.freeze(rows);
}

function averageCpuPercent(samples: readonly TimedActivitySample[]): number {
  if (samples.length === 0) return 0;

  let total = 0;
  let count = 0;

  for (let index = 0; index < samples.length; index += 1) {
    const sample = samples[index];

    if (sample === undefined) continue;
    total += sample.cpuPercent;
    count += 1;
  }

  return count === 0 ? 0 : roundMetric(total / count);
}

function averageMemoryPercent(samples: readonly TimedActivitySample[]): number {
  if (samples.length === 0) return 0;

  let total = 0;
  let count = 0;

  for (let index = 0; index < samples.length; index += 1) {
    const sample = samples[index];

    if (sample === undefined) continue;
    total += memoryUsagePercent(sample.memory);
    count += 1;
  }

  return count === 0 ? 0 : roundMetric(total / count);
}

function averageProcessCpuPercent(samples: readonly TimedActivitySample[], pid: number): number {
  let total = 0;
  let count = 0;

  for (let sampleIndex = 0; sampleIndex < samples.length; sampleIndex += 1) {
    const sample = samples[sampleIndex];

    if (sample === undefined) continue;

    for (let processIndex = 0; processIndex < sample.processes.length; processIndex += 1) {
      const process = sample.processes[processIndex];

      if (process !== undefined && process.pid === pid) {
        total += process.cpuPercent;
        count += 1;
      }
    }
  }

  return count === 0 ? 0 : roundMetric(total / count);
}

function averageProcessMemoryBytes(samples: readonly TimedActivitySample[], pid: number): number {
  let total = 0;
  let count = 0;

  for (let sampleIndex = 0; sampleIndex < samples.length; sampleIndex += 1) {
    const sample = samples[sampleIndex];

    if (sample === undefined) continue;

    for (let processIndex = 0; processIndex < sample.processes.length; processIndex += 1) {
      const process = sample.processes[processIndex];

      if (process !== undefined && process.pid === pid) {
        total += process.memoryBytes;
        count += 1;
      }
    }
  }

  return count === 0 ? 0 : roundMetric(total / count);
}

function compareProcessRows(
  left: ActivityProcessView,
  right: ActivityProcessView,
  sort: ActivitySortState,
): number {
  let compared = 0;

  switch (sort.column) {
    case "cpu":
      compared = left.cpuPercent - right.cpuPercent;
      break;
    case "memory":
      compared = left.memoryBytes - right.memoryBytes;
      break;
    case "name":
      compared = compareProcessNames(left.name, right.name);
      break;
    case "pid":
      compared = left.pid - right.pid;
      break;
  }

  if (compared !== 0) return sort.direction === "asc" ? compared : -compared;

  const name = compareProcessNames(left.name, right.name);

  if (name !== 0) return name;

  return left.pid - right.pid;
}

function compareProcessNames(left: string, right: string): number {
  const normalizedLeft = left.toLocaleLowerCase("en-US");
  const normalizedRight = right.toLocaleLowerCase("en-US");
  const normalized = compareStrings(normalizedLeft, normalizedRight);

  if (normalized !== 0) return normalized;

  return compareStrings(left, right);
}

function compareStrings(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function nextSortState(current: ActivitySortState, column: ActivitySortColumn): ActivitySortState {
  if (current.column === column) {
    return freezeSortState({
      column,
      direction: current.direction === "asc" ? "desc" : "asc",
    });
  }

  return freezeSortState({
    column,
    direction: defaultSortDirection(column),
  });
}

function defaultSortDirection(column: ActivitySortColumn): ActivitySortDirection {
  return column === "name" || column === "pid" ? "asc" : "desc";
}

function normalizeSortColumn(input: unknown): NormalizeResult<ActivitySortColumn> {
  if (input === "cpu" || input === "cpuPercent" || input === "% CPU" || input === "%cpu") {
    return accept("cpu");
  }
  if (input === "memory" || input === "mem" || input === "memoryBytes") {
    return accept("memory");
  }
  if (input === "name" || input === "process") {
    return accept("name");
  }
  if (input === "pid") {
    return accept("pid");
  }

  return reject(error(
    "INVALID_SORT_COLUMN",
    "activity sort column is not supported.",
    "/sortBy/column",
  ));
}

function freezeSortState(sort: ActivitySortState): ActivitySortState {
  const column = sort.column;
  const direction = sort.direction;

  if (
    (column === "cpu" || column === "memory" || column === "name" || column === "pid") &&
    (direction === "asc" || direction === "desc")
  ) {
    return Object.freeze({ column, direction });
  }

  return DEFAULT_SORT;
}

function normalizePid(input: unknown, path: string): NormalizeResult<number> {
  if (typeof input !== "number" || !Number.isSafeInteger(input) || input < 0) {
    return reject(error("INVALID_PROCESS", "process id must be a non-negative safe integer.", path));
  }

  return accept(input);
}

function hasProcess(processes: readonly ActivityMetricsProcessSample[], pid: number | null): boolean {
  if (pid === null) return false;

  for (let index = 0; index < processes.length; index += 1) {
    if (processes[index]?.pid === pid) return true;
  }

  return false;
}

function hasProcessView(processes: readonly ActivityProcessView[], pid: number): boolean {
  for (let index = 0; index < processes.length; index += 1) {
    if (processes[index]?.pid === pid) return true;
  }

  return false;
}

function normalizeMetricsResult(input: unknown): NormalizeResult<NormalizedMetricsResult> {
  const object = snapshotObject(
    input,
    RESULT_REQUIRED_FIELDS,
    RESULT_OPTIONAL_FIELDS,
    "METRICS_PORT_MALFORMED",
    "/metrics/sample",
  );

  if (!object.ok) return object;

  const ok = object.value.get("ok");
  const hasValue = object.value.has("value");
  const hasError = object.value.has("error");

  if (ok === true) {
    if (!hasValue || hasError) {
      return reject(error(
        "METRICS_PORT_MALFORMED",
        "metrics port success result must contain only ok and value.",
        "/metrics/sample",
      ));
    }

    return accept(Object.freeze({
      ok: true,
      value: object.value.get("value"),
    }));
  }

  if (ok === false) {
    if (!hasError || hasValue) {
      return reject(error(
        "METRICS_PORT_MALFORMED",
        "metrics port failure result must contain only ok and error.",
        "/metrics/sample",
      ));
    }

    const hostError = normalizeHostError(object.value.get("error"), "/metrics/sample/error");

    if (!hostError.ok) return hostError;

    return accept(Object.freeze({
      error: hostError.value,
      ok: false,
    }));
  }

  return reject(error(
    "METRICS_PORT_MALFORMED",
    "metrics port result ok field must be a boolean.",
    "/metrics/sample/ok",
  ));
}

function normalizeHostError(input: unknown, path: string): NormalizeResult<ActivityViewModelError> {
  const object = snapshotObject(input, ERROR_FIELDS, Object.freeze([]), "METRICS_PORT_MALFORMED", path);

  if (!object.ok) return object;

  const code = object.value.get("code");
  const message = object.value.get("message");
  const errorPath = object.value.get("path");

  if (typeof code !== "string" || code.length === 0) {
    return reject(error("METRICS_PORT_MALFORMED", "metrics error code must be a non-empty string.", `${path}/code`));
  }
  if (typeof message !== "string" || message.length === 0) {
    return reject(error("METRICS_PORT_MALFORMED", "metrics error message must be a non-empty string.", `${path}/message`));
  }
  if (typeof errorPath !== "string" || errorPath.length === 0) {
    return reject(error("METRICS_PORT_MALFORMED", "metrics error path must be a non-empty string.", `${path}/path`));
  }

  return accept(error(code, message, errorPath));
}

function normalizeMetricsSample(input: unknown): NormalizeResult<ActivityMetricsSample> {
  const object = snapshotObject(input, SAMPLE_FIELDS, Object.freeze([]), "MALFORMED_METRICS_SAMPLE", "/metrics/sample/value");

  if (!object.ok) return object;

  const cpuPercent = normalizePercent(object.value.get("cpuPercent"), "/metrics/sample/value/cpuPercent");
  const memory = normalizeMemorySample(object.value.get("memory"));
  const processes = normalizeProcessSamples(object.value.get("processes"));

  if (!cpuPercent.ok) return cpuPercent;
  if (!memory.ok) return memory;
  if (!processes.ok) return processes;

  return accept(Object.freeze({
    cpuPercent: cpuPercent.value,
    memory: memory.value,
    processes: processes.value,
  }));
}

function normalizeMemorySample(input: unknown): NormalizeResult<ActivityMetricsMemorySample> {
  const object = snapshotObject(
    input,
    MEMORY_FIELDS,
    Object.freeze([]),
    "MALFORMED_METRICS_SAMPLE",
    "/metrics/sample/value/memory",
  );

  if (!object.ok) return object;

  const usedBytes = normalizeNonNegativeNumber(object.value.get("usedBytes"), "/metrics/sample/value/memory/usedBytes");
  const totalBytes = normalizePositiveNumberResult(object.value.get("totalBytes"), "/metrics/sample/value/memory/totalBytes");

  if (!usedBytes.ok) return usedBytes;
  if (!totalBytes.ok) return totalBytes;
  if (usedBytes.value > totalBytes.value) {
    return reject(error(
      "MALFORMED_METRICS_SAMPLE",
      "memory usedBytes must not exceed totalBytes.",
      "/metrics/sample/value/memory/usedBytes",
    ));
  }

  return accept(Object.freeze({
    totalBytes: totalBytes.value,
    usedBytes: usedBytes.value,
  }));
}

function normalizeProcessSamples(input: unknown): NormalizeResult<readonly ActivityMetricsProcessSample[]> {
  const array = snapshotArray(input, "MALFORMED_METRICS_SAMPLE", "/metrics/sample/value/processes");

  if (!array.ok) return array;

  const output: ActivityMetricsProcessSample[] = [];
  const seen = new Set<number>();

  for (let index = 0; index < array.value.length; index += 1) {
    const item = normalizeProcessSample(array.value[index], `/metrics/sample/value/processes/${index}`);

    if (!item.ok) return item;
    if (seen.has(item.value.pid)) {
      return reject(error(
        "MALFORMED_METRICS_SAMPLE",
        "process pids must be unique within a metrics sample.",
        `/metrics/sample/value/processes/${index}/pid`,
      ));
    }

    seen.add(item.value.pid);
    output.push(item.value);
  }

  return accept(Object.freeze(output));
}

function normalizeProcessSample(input: unknown, path: string): NormalizeResult<ActivityMetricsProcessSample> {
  const object = snapshotObject(input, PROCESS_FIELDS, Object.freeze([]), "MALFORMED_METRICS_SAMPLE", path);

  if (!object.ok) return object;

  const pid = normalizePid(object.value.get("pid"), `${path}/pid`);
  const name = object.value.get("name");
  const cpuPercent = normalizeNonNegativeNumber(object.value.get("cpuPercent"), `${path}/cpuPercent`);
  const memoryBytes = normalizeNonNegativeNumber(object.value.get("memoryBytes"), `${path}/memoryBytes`);

  if (!pid.ok) {
    return reject(error("MALFORMED_METRICS_SAMPLE", pid.error.message, pid.error.path));
  }
  if (typeof name !== "string" || name.length === 0) {
    return reject(error("MALFORMED_METRICS_SAMPLE", "process name must be a non-empty string.", `${path}/name`));
  }
  if (!cpuPercent.ok) return cpuPercent;
  if (!memoryBytes.ok) return memoryBytes;

  return accept(Object.freeze({
    cpuPercent: cpuPercent.value,
    memoryBytes: memoryBytes.value,
    name,
    pid: pid.value,
  }));
}

function normalizePercent(input: unknown, path: string): NormalizeResult<number> {
  if (typeof input !== "number" || !Number.isFinite(input) || input < 0 || input > 100) {
    return reject(error("MALFORMED_METRICS_SAMPLE", "percent must be finite and between 0 and 100.", path));
  }

  return accept(roundMetric(input));
}

function normalizeNonNegativeNumber(input: unknown, path: string): NormalizeResult<number> {
  if (typeof input !== "number" || !Number.isFinite(input) || input < 0) {
    return reject(error("MALFORMED_METRICS_SAMPLE", "value must be finite and non-negative.", path));
  }

  return accept(roundMetric(input));
}

function normalizePositiveNumberResult(input: unknown, path: string): NormalizeResult<number> {
  if (typeof input !== "number" || !Number.isFinite(input) || input <= 0) {
    return reject(error("MALFORMED_METRICS_SAMPLE", "value must be finite and positive.", path));
  }

  return accept(roundMetric(input));
}

function readClock(clock: ActivityClock): NormalizeResult<number> {
  let nowMs: number;

  try {
    nowMs = clock.nowMs();
  } catch (caught) {
    return reject(error("CLOCK_FAILED", errorMessage(caught, "activity clock failed closed."), "/clock"));
  }

  if (!Number.isFinite(nowMs) || nowMs < 0) {
    return reject(error("CLOCK_FAILED", "activity clock must return a non-negative finite timestamp.", "/clock"));
  }

  return accept(roundMetric(nowMs));
}

function freezeTimedSample(sample: ActivityMetricsSample, sampledAtMs: number): TimedActivitySample {
  return Object.freeze({
    cpuPercent: sample.cpuPercent,
    memory: Object.freeze({
      totalBytes: sample.memory.totalBytes,
      usedBytes: sample.memory.usedBytes,
    }),
    processes: Object.freeze([...sample.processes]),
    sampledAtMs,
  });
}

function memoryUsagePercent(memory: ActivityMetricsMemorySample): number {
  return roundMetric((memory.usedBytes / memory.totalBytes) * 100);
}

function roundMetric(value: number): number {
  return Math.round(value * 100) / 100;
}

function normalizePositiveInteger(input: number | undefined, fallback: number): number {
  if (input === undefined || !Number.isSafeInteger(input) || input <= 0) return fallback;

  return input;
}

function normalizePositiveNumber(input: number | undefined, fallback: number): number {
  if (input === undefined || !Number.isFinite(input) || input <= 0) return fallback;

  return input;
}

function snapshotObject(
  input: unknown,
  requiredKeys: readonly string[],
  optionalKeys: readonly string[],
  code: string,
  path: string,
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

      if (
        key === undefined ||
        typeof key === "symbol" ||
        (!contains(requiredKeys, key) && !contains(optionalKeys, key))
      ) {
        return reject(error(code, "object contains an unsupported field.", path));
      }

      const descriptor = Object.getOwnPropertyDescriptor(input, key);

      if (descriptor === undefined || !isDataDescriptor(descriptor) || descriptor.enumerable !== true) {
        return reject(error(code, "object must contain only enumerable data fields.", path));
      }

      output.set(key, descriptor.value);
    }

    for (let index = 0; index < requiredKeys.length; index += 1) {
      const key = requiredKeys[index];

      if (key !== undefined && !output.has(key)) {
        return reject(error(code, "object is missing a required field.", `${path}/${pathToken(key)}`));
      }
    }

    return accept(output);
  } catch {
    return reject(error(code, "value must be a stable plain object.", path));
  }
}

function snapshotArray(input: unknown, code: string, path: string): NormalizeResult<readonly unknown[]> {
  try {
    if (!Array.isArray(input)) {
      return reject(error(code, "value must be an array.", path));
    }

    const keys = Reflect.ownKeys(input);

    for (let keyIndex = 0; keyIndex < keys.length; keyIndex += 1) {
      const key = keys[keyIndex];

      if (key === "length") continue;
      if (key === undefined || typeof key === "symbol" || !isDenseArrayIndexKey(key, input.length)) {
        return reject(error(code, "array contains an unsupported field.", path));
      }

      const descriptor = Object.getOwnPropertyDescriptor(input, key);

      if (descriptor === undefined || !isDataDescriptor(descriptor) || descriptor.enumerable !== true) {
        return reject(error(code, "array must contain only enumerable data items.", path));
      }
    }

    const output: unknown[] = [];

    for (let index = 0; index < input.length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(input, String(index));

      if (descriptor === undefined || !isDataDescriptor(descriptor) || descriptor.enumerable !== true) {
        return reject(error(code, "array must be dense and data-only.", `${path}/${index}`));
      }

      output.push(descriptor.value);
    }

    return accept(Object.freeze(output));
  } catch {
    return reject(error(code, "value must be a stable array.", path));
  }
}

function isDenseArrayIndexKey(key: string, length: number): boolean {
  if (key.length === 0) return false;

  const numeric = Number(key);

  return Number.isSafeInteger(numeric) && numeric >= 0 && numeric < length && String(numeric) === key;
}

function isDataDescriptor(descriptor: PropertyDescriptor): descriptor is PropertyDescriptor & {
  readonly value: unknown;
} {
  return Object.prototype.hasOwnProperty.call(descriptor, "value");
}

function contains(values: readonly string[], value: string): boolean {
  for (let index = 0; index < values.length; index += 1) {
    if (values[index] === value) return true;
  }

  return false;
}

function statusForError(errorValue: ActivityViewModelError): Exclude<ActivityViewStatus, "idle" | "ready"> {
  return errorValue.code === "MISSING_CAPABILITY" ? "forbidden" : "error";
}

function acceptAction(state: ActivityViewState): ActivityActionResult {
  return Object.freeze({
    ok: true,
    state,
  });
}

function rejectAction(errorValue: ActivityViewModelError, state: ActivityViewState): ActivityActionResult {
  return Object.freeze({
    error: errorValue,
    ok: false,
    state,
  });
}

function accept<T>(value: T): NormalizeResult<T> {
  return {
    ok: true,
    value,
  };
}

function reject<T>(errorValue: ActivityViewModelError): NormalizeResult<T> {
  return {
    error: errorValue,
    ok: false,
  };
}

function error(code: string, message: string, path: string): ActivityViewModelError {
  return Object.freeze({
    code,
    message,
    path,
  });
}

function errorMessage(caught: unknown, fallback: string): string {
  if (caught instanceof Error && caught.message.length > 0) return caught.message;

  return fallback;
}

function pathToken(value: string): string {
  return value.replaceAll("~", "~0").replaceAll("/", "~1");
}
