export const ACTIVITY_MONITOR_STATS_REQUEST_APP_ID = "vita.app.activity-monitor";

export type ActivityMonitorSortKey = "cpu" | "mem" | "name" | "kind" | "status" | "id";
export type ActivityMonitorSortDirection = "asc" | "desc";
export type ActivityMonitorAppStatus = "idle" | "ready" | "forbidden" | "error";
export type ActivityMonitorAction = "refresh" | "select" | "setSort";

export interface ActivityMonitorAppError {
  readonly code: string;
  readonly message: string;
  readonly path: string;
}

export interface ActivityMonitorTotals {
  readonly cpuPercent: number;
  readonly memBytes: number;
}

export interface ActivityMonitorStatsEntry {
  readonly id: string;
  readonly name: string;
  readonly kind: string;
  readonly cpuPercent: number;
  readonly memBytes: number;
  readonly status: string;
}

export interface ActivityMonitorEntry extends ActivityMonitorStatsEntry {
  readonly selected: boolean;
}

export interface ActivityMonitorStatsSnapshot {
  readonly totals: ActivityMonitorTotals;
  readonly entries: readonly ActivityMonitorStatsEntry[];
}

export interface ActivityMonitorStatsRequest {
  readonly appId: typeof ACTIVITY_MONITOR_STATS_REQUEST_APP_ID;
}

export type ActivityMonitorStatsResult =
  | {
      readonly ok: true;
      readonly value: ActivityMonitorStatsSnapshot;
    }
  | {
      readonly ok: false;
      readonly error: ActivityMonitorAppError;
    };

export interface ActivityMonitorStatsPort {
  readonly read: (request: ActivityMonitorStatsRequest) =>
    | ActivityMonitorStatsResult
    | Promise<ActivityMonitorStatsResult>;
}

export interface ActivityMonitorSortState {
  readonly key: ActivityMonitorSortKey;
  readonly direction: ActivityMonitorSortDirection;
}

export interface ActivityMonitorAppState {
  readonly status: ActivityMonitorAppStatus;
  readonly entries: readonly ActivityMonitorEntry[];
  readonly totals: ActivityMonitorTotals;
  readonly selectedId: string | null;
  readonly selectedEntry: ActivityMonitorEntry | null;
  readonly sort: ActivityMonitorSortState;
  readonly error?: ActivityMonitorAppError;
}

export type ActivityMonitorActionResult =
  | {
      readonly ok: true;
      readonly action: ActivityMonitorAction;
      readonly state: ActivityMonitorAppState;
    }
  | {
      readonly ok: false;
      readonly action: ActivityMonitorAction;
      readonly error: ActivityMonitorAppError;
      readonly state: ActivityMonitorAppState;
    };

export interface ActivityMonitorAppViewModelOptions {
  readonly stats?: ActivityMonitorStatsPort;
  readonly initialSort?: ActivityMonitorSortState;
}

export interface ActivityMonitorAppViewModel {
  readonly state: ActivityMonitorAppState;
  snapshot(): ActivityMonitorAppState;
  refresh(): Promise<ActivityMonitorActionResult>;
  setSort(key: unknown, direction: unknown): ActivityMonitorActionResult;
  select(id: unknown): ActivityMonitorActionResult;
}

type NormalizeResult<T> =
  | {
      readonly ok: true;
      readonly value: T;
    }
  | {
      readonly ok: false;
      readonly error: ActivityMonitorAppError;
    };

type NormalizedStatsResult =
  | {
      readonly ok: true;
      readonly value: unknown;
    }
  | {
      readonly ok: false;
      readonly error: ActivityMonitorAppError;
    };

interface UnknownActivityMonitorStatsPort {
  readonly read: (request: ActivityMonitorStatsRequest) => unknown;
}

interface NormalizedOptions {
  readonly stats?: UnknownActivityMonitorStatsPort;
  readonly initialSort?: ActivityMonitorSortState;
}

interface FreezeStateInput {
  readonly status: ActivityMonitorAppStatus;
  readonly entries: readonly ActivityMonitorStatsEntry[];
  readonly totals: ActivityMonitorTotals;
  readonly selectedId: string | null;
  readonly sort: ActivityMonitorSortState;
  readonly error?: ActivityMonitorAppError;
}

const DEFAULT_SORT = Object.freeze({
  direction: "desc",
  key: "cpu",
}) satisfies ActivityMonitorSortState;
const EMPTY_TOTALS = Object.freeze({
  cpuPercent: 0,
  memBytes: 0,
}) satisfies ActivityMonitorTotals;
const EMPTY_STATS_ENTRIES = Object.freeze([]) satisfies readonly ActivityMonitorStatsEntry[];
const EMPTY_ENTRIES = Object.freeze([]) satisfies readonly ActivityMonitorEntry[];

const OPTION_FIELDS = Object.freeze(["initialSort", "stats"]);
const STATS_PORT_FIELDS = Object.freeze(["read"]);
const SORT_FIELDS = Object.freeze(["direction", "key"]);
const RESULT_REQUIRED_FIELDS = Object.freeze(["ok"]);
const RESULT_OPTIONAL_FIELDS = Object.freeze(["error", "value"]);
const ERROR_FIELDS = Object.freeze(["code", "message", "path"]);
const SNAPSHOT_FIELDS = Object.freeze(["entries", "totals"]);
const TOTAL_FIELDS = Object.freeze(["cpuPercent", "memBytes"]);
const ENTRY_FIELDS = Object.freeze(["cpuPercent", "id", "kind", "memBytes", "name", "status"]);

export function createActivityMonitorAppViewModel(
  options: unknown = Object.freeze({}),
): ActivityMonitorAppViewModel {
  const normalized = normalizeOptions(options);

  return new ActivityMonitorAppModel(normalized.ok ? normalized.value : Object.freeze({}));
}

class ActivityMonitorAppModel implements ActivityMonitorAppViewModel {
  readonly #stats: UnknownActivityMonitorStatsPort | undefined;
  #entries: readonly ActivityMonitorStatsEntry[] = EMPTY_STATS_ENTRIES;
  #selectedId: string | null = null;
  #sort: ActivityMonitorSortState;
  #state: ActivityMonitorAppState;
  #totals: ActivityMonitorTotals = EMPTY_TOTALS;

  constructor(options: NormalizedOptions) {
    this.#stats = options.stats;
    this.#sort = options.initialSort ?? DEFAULT_SORT;
    this.#state = freezeState({
      entries: this.#entries,
      selectedId: this.#selectedId,
      sort: this.#sort,
      status: "idle",
      totals: this.#totals,
    });
  }

  get state(): ActivityMonitorAppState {
    return this.#state;
  }

  snapshot(): ActivityMonitorAppState {
    return this.#state;
  }

  async refresh(): Promise<ActivityMonitorActionResult> {
    const stats = this.#stats;

    if (stats === undefined) {
      return this.#failRefresh(error(
        "ACTIVITY_MONITOR_STATS_UNAVAILABLE",
        "Activity Monitor requires an injected stats port.",
        "/stats",
      ));
    }

    let rawResult: unknown;

    try {
      rawResult = await stats.read(Object.freeze({
        appId: ACTIVITY_MONITOR_STATS_REQUEST_APP_ID,
      }));
    } catch {
      return this.#failRefresh(error(
        "ACTIVITY_MONITOR_STATS_FAILED",
        "Activity Monitor stats port failed closed.",
        "/stats/read",
      ));
    }

    const result = normalizeStatsResult(rawResult);

    if (!result.ok) return this.#failRefresh(result.error);
    if (!result.value.ok) return this.#failRefresh(result.value.error);

    const snapshot = normalizeStatsSnapshot(result.value.value);

    if (!snapshot.ok) return this.#failRefresh(snapshot.error);

    const selectedId = hasEntryId(snapshot.value.entries, this.#selectedId)
      ? this.#selectedId
      : null;

    this.#entries = snapshot.value.entries;
    this.#totals = snapshot.value.totals;
    this.#selectedId = selectedId;
    this.#state = freezeState({
      entries: this.#entries,
      selectedId: this.#selectedId,
      sort: this.#sort,
      status: "ready",
      totals: this.#totals,
    });

    return acceptAction("refresh", this.#state);
  }

  setSort(key: unknown, direction: unknown): ActivityMonitorActionResult {
    const normalized = normalizeSortState(Object.freeze({
      direction,
      key,
    }), "/sort");

    if (!normalized.ok) return rejectAction("setSort", normalized.error, this.#state);

    this.#sort = normalized.value;
    const input: {
      status: ActivityMonitorAppStatus;
      entries: readonly ActivityMonitorStatsEntry[];
      totals: ActivityMonitorTotals;
      selectedId: string | null;
      sort: ActivityMonitorSortState;
      error?: ActivityMonitorAppError;
    } = {
      entries: this.#entries,
      selectedId: this.#selectedId,
      sort: this.#sort,
      status: this.#state.status,
      totals: this.#totals,
    };

    if (this.#state.error !== undefined) input.error = this.#state.error;

    this.#state = freezeState(input);

    return acceptAction("setSort", this.#state);
  }

  select(id: unknown): ActivityMonitorActionResult {
    const normalizedId = normalizeNonEmptyString(id, "ACTIVITY_MONITOR_INVALID_SELECTION", "/select/id");

    if (!normalizedId.ok) return rejectAction("select", normalizedId.error, this.#state);
    if (!hasEntryId(this.#entries, normalizedId.value)) {
      return rejectAction(
        "select",
        error(
          "ACTIVITY_MONITOR_ENTRY_NOT_FOUND",
          "Activity Monitor entry is not present in the current stats snapshot.",
          "/select/id",
        ),
        this.#state,
      );
    }

    this.#selectedId = normalizedId.value;
    this.#state = freezeState({
      entries: this.#entries,
      selectedId: this.#selectedId,
      sort: this.#sort,
      status: this.#state.status,
      totals: this.#totals,
    });

    return acceptAction("select", this.#state);
  }

  #failRefresh(errorValue: ActivityMonitorAppError): ActivityMonitorActionResult {
    this.#entries = EMPTY_STATS_ENTRIES;
    this.#totals = EMPTY_TOTALS;
    this.#selectedId = null;
    this.#state = freezeState({
      entries: this.#entries,
      error: errorValue,
      selectedId: this.#selectedId,
      sort: this.#sort,
      status: statusForError(errorValue),
      totals: this.#totals,
    });

    return rejectAction("refresh", errorValue, this.#state);
  }
}

function normalizeOptions(input: unknown): NormalizeResult<NormalizedOptions> {
  const object = snapshotObject(input, Object.freeze([]), OPTION_FIELDS, "ACTIVITY_MONITOR_OPTIONS_INVALID", "/options");

  if (!object.ok) return object;

  const output: {
    stats?: UnknownActivityMonitorStatsPort;
    initialSort?: ActivityMonitorSortState;
  } = {};
  const statsValue = object.value.get("stats");
  const initialSortValue = object.value.get("initialSort");

  if (statsValue !== undefined) {
    const stats = normalizeStatsPort(statsValue);

    if (!stats.ok) return stats;

    output.stats = stats.value;
  }
  if (initialSortValue !== undefined) {
    const sort = normalizeSortState(initialSortValue, "/options/initialSort");

    if (!sort.ok) return sort;

    output.initialSort = sort.value;
  }

  return accept(Object.freeze(output));
}

function normalizeStatsPort(input: unknown): NormalizeResult<UnknownActivityMonitorStatsPort> {
  const object = snapshotObject(input, STATS_PORT_FIELDS, Object.freeze([]), "ACTIVITY_MONITOR_OPTIONS_INVALID", "/options/stats");

  if (!object.ok) return object;

  const read = object.value.get("read");

  if (typeof read !== "function") {
    return reject(error(
      "ACTIVITY_MONITOR_OPTIONS_INVALID",
      "stats port read must be a function.",
      "/options/stats/read",
    ));
  }

  return accept(Object.freeze({
    read(request: ActivityMonitorStatsRequest) {
      return Reflect.apply(read, undefined, [request]);
    },
  }));
}

function normalizeSortState(input: unknown, path: string): NormalizeResult<ActivityMonitorSortState> {
  const object = snapshotObject(input, SORT_FIELDS, Object.freeze([]), "ACTIVITY_MONITOR_INVALID_SORT", path);

  if (!object.ok) return object;

  const key = normalizeSortKey(object.value.get("key"), `${path}/key`);
  const direction = normalizeSortDirection(object.value.get("direction"), `${path}/direction`);

  if (!key.ok) return key;
  if (!direction.ok) return direction;

  return accept(Object.freeze({
    direction: direction.value,
    key: key.value,
  }));
}

function normalizeSortKey(input: unknown, path: string): NormalizeResult<ActivityMonitorSortKey> {
  if (
    input === "cpu" ||
    input === "mem" ||
    input === "name" ||
    input === "kind" ||
    input === "status" ||
    input === "id"
  ) {
    return accept(input);
  }

  return reject(error("ACTIVITY_MONITOR_INVALID_SORT", "sort key is not supported.", path));
}

function normalizeSortDirection(input: unknown, path: string): NormalizeResult<ActivityMonitorSortDirection> {
  if (input === "asc" || input === "desc") return accept(input);

  return reject(error("ACTIVITY_MONITOR_INVALID_SORT", "sort direction must be asc or desc.", path));
}

function normalizeStatsResult(input: unknown): NormalizeResult<NormalizedStatsResult> {
  const object = snapshotObject(
    input,
    RESULT_REQUIRED_FIELDS,
    RESULT_OPTIONAL_FIELDS,
    "ACTIVITY_MONITOR_STATS_MALFORMED",
    "/stats/read",
  );

  if (!object.ok) return object;

  const ok = object.value.get("ok");
  const hasValue = object.value.has("value");
  const hasError = object.value.has("error");

  if (ok === true) {
    if (!hasValue || hasError) {
      return reject(error(
        "ACTIVITY_MONITOR_STATS_MALFORMED",
        "stats success result must contain ok and value.",
        "/stats/read",
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
        "ACTIVITY_MONITOR_STATS_MALFORMED",
        "stats failure result must contain ok and error.",
        "/stats/read",
      ));
    }

    const errorValue = normalizeError(object.value.get("error"), "/stats/read/error");

    if (!errorValue.ok) return errorValue;

    return accept(Object.freeze({
      error: errorValue.value,
      ok: false,
    }));
  }

  return reject(error(
    "ACTIVITY_MONITOR_STATS_MALFORMED",
    "stats result ok field must be a boolean.",
    "/stats/read/ok",
  ));
}

function normalizeStatsSnapshot(input: unknown): NormalizeResult<ActivityMonitorStatsSnapshot> {
  const object = snapshotObject(
    input,
    SNAPSHOT_FIELDS,
    Object.freeze([]),
    "ACTIVITY_MONITOR_STATS_MALFORMED",
    "/stats/read/value",
  );

  if (!object.ok) return object;

  const totals = normalizeTotals(object.value.get("totals"));
  const entries = normalizeEntries(object.value.get("entries"));

  if (!totals.ok) return totals;
  if (!entries.ok) return entries;

  return accept(Object.freeze({
    entries: entries.value,
    totals: totals.value,
  }));
}

function normalizeTotals(input: unknown): NormalizeResult<ActivityMonitorTotals> {
  const object = snapshotObject(
    input,
    TOTAL_FIELDS,
    Object.freeze([]),
    "ACTIVITY_MONITOR_STATS_MALFORMED",
    "/stats/read/value/totals",
  );

  if (!object.ok) return object;

  const cpuPercent = normalizeNonNegativeNumber(object.value.get("cpuPercent"), "/stats/read/value/totals/cpuPercent");
  const memBytes = normalizeNonNegativeNumber(object.value.get("memBytes"), "/stats/read/value/totals/memBytes");

  if (!cpuPercent.ok) return cpuPercent;
  if (!memBytes.ok) return memBytes;

  return accept(Object.freeze({
    cpuPercent: cpuPercent.value,
    memBytes: memBytes.value,
  }));
}

function normalizeEntries(input: unknown): NormalizeResult<readonly ActivityMonitorStatsEntry[]> {
  const array = snapshotArray(input, "ACTIVITY_MONITOR_STATS_MALFORMED", "/stats/read/value/entries");

  if (!array.ok) return array;

  const output: ActivityMonitorStatsEntry[] = [];
  const seenIds = new Set<string>();

  for (let index = 0; index < array.value.length; index += 1) {
    const entryValue = normalizeEntry(array.value[index], `/stats/read/value/entries/${index}`);

    if (!entryValue.ok) return entryValue;
    if (seenIds.has(entryValue.value.id)) {
      return reject(error(
        "ACTIVITY_MONITOR_STATS_MALFORMED",
        "entry ids must be unique within a stats snapshot.",
        `/stats/read/value/entries/${index}/id`,
      ));
    }

    seenIds.add(entryValue.value.id);
    output.push(entryValue.value);
  }

  return accept(Object.freeze(output));
}

function normalizeEntry(input: unknown, path: string): NormalizeResult<ActivityMonitorStatsEntry> {
  const object = snapshotObject(input, ENTRY_FIELDS, Object.freeze([]), "ACTIVITY_MONITOR_STATS_MALFORMED", path);

  if (!object.ok) return object;

  const id = normalizeNonEmptyString(object.value.get("id"), "ACTIVITY_MONITOR_STATS_MALFORMED", `${path}/id`);
  const name = normalizeNonEmptyString(object.value.get("name"), "ACTIVITY_MONITOR_STATS_MALFORMED", `${path}/name`);
  const kind = normalizeNonEmptyString(object.value.get("kind"), "ACTIVITY_MONITOR_STATS_MALFORMED", `${path}/kind`);
  const status = normalizeNonEmptyString(object.value.get("status"), "ACTIVITY_MONITOR_STATS_MALFORMED", `${path}/status`);
  const cpuPercent = normalizeNonNegativeNumber(object.value.get("cpuPercent"), `${path}/cpuPercent`);
  const memBytes = normalizeNonNegativeNumber(object.value.get("memBytes"), `${path}/memBytes`);

  if (!id.ok) return id;
  if (!name.ok) return name;
  if (!kind.ok) return kind;
  if (!status.ok) return status;
  if (!cpuPercent.ok) return cpuPercent;
  if (!memBytes.ok) return memBytes;

  return accept(Object.freeze({
    cpuPercent: cpuPercent.value,
    id: id.value,
    kind: kind.value,
    memBytes: memBytes.value,
    name: name.value,
    status: status.value,
  }));
}

function normalizeError(input: unknown, path: string): NormalizeResult<ActivityMonitorAppError> {
  const object = snapshotObject(input, ERROR_FIELDS, Object.freeze([]), "ACTIVITY_MONITOR_STATS_MALFORMED", path);

  if (!object.ok) return object;

  const code = normalizeNonEmptyString(object.value.get("code"), "ACTIVITY_MONITOR_STATS_MALFORMED", `${path}/code`);
  const message = normalizeNonEmptyString(object.value.get("message"), "ACTIVITY_MONITOR_STATS_MALFORMED", `${path}/message`);
  const errorPath = normalizeNonEmptyString(object.value.get("path"), "ACTIVITY_MONITOR_STATS_MALFORMED", `${path}/path`);

  if (!code.ok) return code;
  if (!message.ok) return message;
  if (!errorPath.ok) return errorPath;

  return accept(error(code.value, message.value, errorPath.value));
}

function normalizeNonEmptyString(input: unknown, code: string, path: string): NormalizeResult<string> {
  if (typeof input !== "string" || input.length === 0) {
    return reject(error(code, "value must be a non-empty string.", path));
  }

  return accept(input);
}

function normalizeNonNegativeNumber(input: unknown, path: string): NormalizeResult<number> {
  if (typeof input !== "number" || !Number.isFinite(input) || input < 0) {
    return reject(error(
      "ACTIVITY_MONITOR_STATS_MALFORMED",
      "value must be a finite non-negative number.",
      path,
    ));
  }

  return accept(roundMetric(input));
}

function freezeState(input: FreezeStateInput): ActivityMonitorAppState {
  const selectedId = hasEntryId(input.entries, input.selectedId) ? input.selectedId : null;
  const entries = freezeSortedEntries(input.entries, input.sort, selectedId);
  const selectedEntry = selectedId === null ? null : findEntry(entries, selectedId);
  const output: {
    status: ActivityMonitorAppStatus;
    entries: readonly ActivityMonitorEntry[];
    totals: ActivityMonitorTotals;
    selectedId: string | null;
    selectedEntry: ActivityMonitorEntry | null;
    sort: ActivityMonitorSortState;
    error?: ActivityMonitorAppError;
  } = {
    entries,
    selectedEntry,
    selectedId,
    sort: freezeSort(input.sort),
    status: input.status,
    totals: freezeTotals(input.totals),
  };

  if (input.error !== undefined) output.error = freezeError(input.error);

  return Object.freeze(output);
}

function freezeSortedEntries(
  entries: readonly ActivityMonitorStatsEntry[],
  sort: ActivityMonitorSortState,
  selectedId: string | null,
): readonly ActivityMonitorEntry[] {
  if (entries.length === 0) return EMPTY_ENTRIES;

  const output: ActivityMonitorEntry[] = [];

  for (let index = 0; index < entries.length; index += 1) {
    const entryValue = entries[index];

    if (entryValue !== undefined) {
      output.push(Object.freeze({
        cpuPercent: entryValue.cpuPercent,
        id: entryValue.id,
        kind: entryValue.kind,
        memBytes: entryValue.memBytes,
        name: entryValue.name,
        selected: selectedId === entryValue.id,
        status: entryValue.status,
      }));
    }
  }

  output.sort((left, right) => compareEntries(left, right, sort));

  return Object.freeze(output);
}

function compareEntries(
  left: ActivityMonitorStatsEntry,
  right: ActivityMonitorStatsEntry,
  sort: ActivityMonitorSortState,
): number {
  let compared = 0;

  switch (sort.key) {
    case "cpu":
      compared = left.cpuPercent - right.cpuPercent;
      break;
    case "mem":
      compared = left.memBytes - right.memBytes;
      break;
    case "name":
      compared = compareStringsFolded(left.name, right.name);
      break;
    case "kind":
      compared = compareStringsFolded(left.kind, right.kind);
      break;
    case "status":
      compared = compareStringsFolded(left.status, right.status);
      break;
    case "id":
      compared = compareStrings(left.id, right.id);
      break;
  }

  if (compared !== 0) return sort.direction === "asc" ? compared : -compared;

  return compareStrings(left.id, right.id);
}

function compareStringsFolded(left: string, right: string): number {
  const folded = compareStrings(left.toLocaleLowerCase("en-US"), right.toLocaleLowerCase("en-US"));

  if (folded !== 0) return folded;

  return compareStrings(left, right);
}

function compareStrings(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function freezeTotals(totals: ActivityMonitorTotals): ActivityMonitorTotals {
  return Object.freeze({
    cpuPercent: totals.cpuPercent,
    memBytes: totals.memBytes,
  });
}

function freezeSort(sort: ActivityMonitorSortState): ActivityMonitorSortState {
  return Object.freeze({
    direction: sort.direction,
    key: sort.key,
  });
}

function freezeError(errorValue: ActivityMonitorAppError): ActivityMonitorAppError {
  return error(errorValue.code, errorValue.message, errorValue.path);
}

function findEntry(
  entries: readonly ActivityMonitorEntry[],
  id: string,
): ActivityMonitorEntry | null {
  for (let index = 0; index < entries.length; index += 1) {
    const entryValue = entries[index];

    if (entryValue !== undefined && entryValue.id === id) return entryValue;
  }

  return null;
}

function hasEntryId(entries: readonly ActivityMonitorStatsEntry[], id: string | null): boolean {
  if (id === null) return false;

  for (let index = 0; index < entries.length; index += 1) {
    if (entries[index]?.id === id) return true;
  }

  return false;
}

function statusForError(errorValue: ActivityMonitorAppError): Exclude<ActivityMonitorAppStatus, "idle" | "ready"> {
  const code = errorValue.code.toUpperCase();

  if (code.includes("DENIED") || code.includes("FORBIDDEN") || code.includes("UNAVAILABLE")) {
    return "forbidden";
  }

  return "error";
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
    return reject(error(code, "value must be stable plain data.", path));
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
      if (key === undefined || typeof key === "symbol" || !isArrayIndexKey(key, input.length)) {
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

function isArrayIndexKey(key: string, length: number): boolean {
  if (key.length === 0) return false;

  const index = Number(key);

  return Number.isSafeInteger(index) && index >= 0 && index < length && String(index) === key;
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

function acceptAction(action: ActivityMonitorAction, state: ActivityMonitorAppState): ActivityMonitorActionResult {
  return Object.freeze({
    action,
    ok: true,
    state,
  });
}

function rejectAction(
  action: ActivityMonitorAction,
  errorValue: ActivityMonitorAppError,
  state: ActivityMonitorAppState,
): ActivityMonitorActionResult {
  return Object.freeze({
    action,
    error: freezeError(errorValue),
    ok: false,
    state,
  });
}

function accept<T>(value: T): NormalizeResult<T> {
  return Object.freeze({
    ok: true,
    value,
  });
}

function reject<T>(errorValue: ActivityMonitorAppError): NormalizeResult<T> {
  return Object.freeze({
    error: errorValue,
    ok: false,
  });
}

function error(code: string, message: string, path: string): ActivityMonitorAppError {
  return Object.freeze({
    code,
    message,
    path,
  });
}

function roundMetric(value: number): number {
  return Math.round(value * 100) / 100;
}

function pathToken(value: string): string {
  return value.replaceAll("~", "~0").replaceAll("/", "~1");
}
