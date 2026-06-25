import type {
  DesktopHostError,
  DesktopHostResult,
  DesktopMaybePromise,
} from "../../../sdk/typescript/src/desktop-sdk/index.ts";

export interface ShellCommandRequest {
  readonly tabId: string;
  readonly cwd: string;
  readonly input: string;
}

export interface ShellCommandOutput {
  readonly lines: readonly string[];
  readonly exitCode: number;
  readonly cwd?: string;
}

export type ShellCommandResult = DesktopHostResult<ShellCommandOutput>;

export interface ShellSessionPort {
  runCommand(request: ShellCommandRequest): DesktopMaybePromise<ShellCommandResult>;
}

export type ShellOutputLineKind = "input" | "output";

export interface ShellOutputLine {
  readonly kind: ShellOutputLineKind;
  readonly text: string;
}

export interface ShellTabState {
  readonly id: string;
  readonly title: string;
  readonly cwd: string;
  readonly history: readonly string[];
  readonly historyIndex: number | null;
  readonly draftInput: string;
  readonly outputBuffer: readonly ShellOutputLine[];
  readonly running: boolean;
  readonly lastExitCode: number | null;
}

export interface ShellViewModelState {
  readonly activeTabId: string;
  readonly activeTab: ShellTabState;
  readonly tabs: readonly ShellTabState[];
}

export interface ShellTabInput {
  readonly id?: string;
  readonly title?: string;
  readonly cwd?: string;
  readonly history?: readonly string[];
  readonly outputBuffer?: readonly ShellOutputLine[];
  readonly lastExitCode?: number | null;
}

export interface ShellViewModelOptions {
  readonly session?: ShellSessionPort;
  readonly initialCwd?: string;
  readonly initialTabs?: readonly ShellTabInput[];
  readonly outputLimit?: number;
}

export type ShellViewModelError = DesktopHostError;

export type ShellViewModelActionResult =
  | {
      readonly ok: true;
      readonly state: ShellViewModelState;
    }
  | {
      readonly ok: false;
      readonly error: ShellViewModelError;
      readonly state: ShellViewModelState;
    };

export interface ShellViewModel {
  readonly state: ShellViewModelState;
  snapshot(): ShellViewModelState;
  newTab(): ShellViewModelActionResult;
  closeTab(id: string): ShellViewModelActionResult;
  submit(input: string): Promise<ShellViewModelActionResult>;
  historyPrev(): ShellViewModelActionResult;
  historyNext(): ShellViewModelActionResult;
  clear(): ShellViewModelActionResult;
}

type NormalizeResult<T> =
  | {
      readonly ok: true;
      readonly value: T;
    }
  | {
      readonly ok: false;
      readonly error: ShellViewModelError;
    };

const DEFAULT_CWD = "~/vita";
const DEFAULT_OUTPUT_LIMIT = 200;
const DEFAULT_TABS: readonly ShellTabInput[] = Object.freeze([
  Object.freeze({
    cwd: DEFAULT_CWD,
    id: "kernel",
    title: "kernel",
  }),
  Object.freeze({
    cwd: DEFAULT_CWD,
    id: "build",
    title: "build",
  }),
]);

export function createShellViewModel(options: ShellViewModelOptions): ShellViewModel {
  return new DesktopShellViewModel(options);
}

class DesktopShellViewModel implements ShellViewModel {
  readonly #session: ShellSessionPort | undefined;
  readonly #outputLimit: number;
  #nextTabNumber: number;
  #state: ShellViewModelState;

  constructor(options: ShellViewModelOptions) {
    const tabs = createInitialTabs(options);

    this.#session = options.session;
    this.#outputLimit = normalizeOutputLimit(options.outputLimit);
    this.#nextTabNumber = nextTabNumber(tabs);
    this.#state = freezeState(tabs, tabs[0]?.id ?? "kernel");
  }

  get state(): ShellViewModelState {
    return this.#state;
  }

  snapshot(): ShellViewModelState {
    return this.#state;
  }

  newTab(): ShellViewModelActionResult {
    const id = this.#allocateTabId();
    const active = this.#state.activeTab;
    const tab = freezeTab({
      cwd: active.cwd,
      draftInput: "",
      history: Object.freeze([]),
      historyIndex: null,
      id,
      lastExitCode: null,
      outputBuffer: Object.freeze([]),
      running: false,
      title: id,
    });

    this.#state = freezeState([...this.#state.tabs, tab], id);

    return acceptAction(this.#state);
  }

  closeTab(id: string): ShellViewModelActionResult {
    const index = tabIndex(this.#state.tabs, id);

    if (index < 0) {
      return this.#reject(error("UNKNOWN_TAB", "shell tab is not available.", `/tabs/${pathToken(id)}`));
    }
    if (this.#state.tabs.length <= 1) {
      return this.#reject(error("LAST_TAB", "shell requires at least one tab.", "/tabs"));
    }

    const closing = this.#state.tabs[index];

    if (closing?.running === true) {
      return this.#reject(error("TAB_RUNNING", "running shell tabs cannot be closed.", `/tabs/${pathToken(id)}`));
    }

    const tabs: ShellTabState[] = [];

    for (let currentIndex = 0; currentIndex < this.#state.tabs.length; currentIndex += 1) {
      const tab = this.#state.tabs[currentIndex];

      if (tab !== undefined && tab.id !== id) {
        tabs.push(tab);
      }
    }

    const nextActiveId = this.#state.activeTabId === id
      ? tabs[Math.min(index, tabs.length - 1)]?.id ?? tabs[0]?.id ?? id
      : this.#state.activeTabId;

    this.#state = freezeState(tabs, nextActiveId);

    return acceptAction(this.#state);
  }

  async submit(input: string): Promise<ShellViewModelActionResult> {
    const session = this.#session;

    if (session === undefined) {
      return this.#reject(error(
        "SHELL_SESSION_PORT_UNAVAILABLE",
        "shell session port is unavailable.",
        "/session",
      ));
    }

    const before = this.#state;
    const active = before.activeTab;

    if (active.running) {
      return this.#reject(error(
        "SESSION_RUNNING",
        "shell session is already running a command.",
        `/tabs/${pathToken(active.id)}/running`,
      ));
    }

    const request = Object.freeze({
      cwd: active.cwd,
      input,
      tabId: active.id,
    }) satisfies ShellCommandRequest;

    this.#state = freezeState(replaceTab(before.tabs, freezeTab({
      ...active,
      running: true,
    })), before.activeTabId);

    let rawResult: unknown;

    try {
      rawResult = await session.runCommand(request);
    } catch {
      this.#state = before;
      return rejectAction(error(
        "SHELL_SESSION_PORT_FAILED",
        "shell session port failed closed.",
        `/tabs/${pathToken(active.id)}/command`,
      ), this.#state);
    }

    const result = normalizeCommandResult(rawResult);

    if (!result.ok) {
      this.#state = before;
      return rejectAction(result.error, this.#state);
    }

    const updated = commandCompletedTab(active, input, result.value, this.#outputLimit);

    this.#state = freezeState(replaceTab(before.tabs, updated), before.activeTabId);

    return acceptAction(this.#state);
  }

  historyPrev(): ShellViewModelActionResult {
    const active = this.#state.activeTab;

    if (active.history.length === 0) {
      return acceptAction(this.#state);
    }

    const nextIndex = active.historyIndex === null
      ? active.history.length - 1
      : Math.max(0, active.historyIndex - 1);
    const nextInput = active.history[nextIndex] ?? active.draftInput;

    this.#state = freezeState(replaceTab(this.#state.tabs, freezeTab({
      ...active,
      draftInput: nextInput,
      historyIndex: nextIndex,
    })), this.#state.activeTabId);

    return acceptAction(this.#state);
  }

  historyNext(): ShellViewModelActionResult {
    const active = this.#state.activeTab;

    if (active.history.length === 0 || active.historyIndex === null) {
      return acceptAction(this.#state);
    }

    const nextIndex = active.historyIndex + 1;
    const draftInput = nextIndex >= active.history.length
      ? ""
      : active.history[nextIndex] ?? active.draftInput;
    const historyIndex = nextIndex >= active.history.length ? null : nextIndex;

    this.#state = freezeState(replaceTab(this.#state.tabs, freezeTab({
      ...active,
      draftInput,
      historyIndex,
    })), this.#state.activeTabId);

    return acceptAction(this.#state);
  }

  clear(): ShellViewModelActionResult {
    const active = this.#state.activeTab;

    this.#state = freezeState(replaceTab(this.#state.tabs, freezeTab({
      ...active,
      lastExitCode: null,
      outputBuffer: Object.freeze([]),
    })), this.#state.activeTabId);

    return acceptAction(this.#state);
  }

  #allocateTabId(): string {
    let id = `shell-${this.#nextTabNumber}`;

    while (hasTab(this.#state.tabs, id)) {
      this.#nextTabNumber += 1;
      id = `shell-${this.#nextTabNumber}`;
    }

    this.#nextTabNumber += 1;

    return id;
  }

  #reject(errorValue: ShellViewModelError): ShellViewModelActionResult {
    return rejectAction(errorValue, this.#state);
  }
}

function createInitialTabs(options: ShellViewModelOptions): readonly ShellTabState[] {
  const inputs = options.initialTabs !== undefined && options.initialTabs.length > 0
    ? options.initialTabs
    : DEFAULT_TABS;
  const output: ShellTabState[] = [];
  const fallbackCwd = normalizeCwd(options.initialCwd ?? DEFAULT_CWD);

  for (let index = 0; index < inputs.length; index += 1) {
    const input = inputs[index];

    if (input === undefined) continue;

    const fallbackId = `shell-${index + 1}`;
    const id = normalizeTabId(input.id, fallbackId);
    const cwd = normalizeCwd(input.cwd ?? fallbackCwd);

    if (hasTab(output, id)) continue;

    output.push(freezeTab({
      cwd,
      draftInput: "",
      history: freezeStringArray(input.history ?? Object.freeze([])),
      historyIndex: null,
      id,
      lastExitCode: input.lastExitCode ?? null,
      outputBuffer: freezeOutputBuffer(input.outputBuffer ?? Object.freeze([]), DEFAULT_OUTPUT_LIMIT),
      running: false,
      title: normalizeTitle(input.title, id),
    }));
  }

  if (output.length > 0) {
    return Object.freeze(output);
  }

  return Object.freeze([
    freezeTab({
      cwd: fallbackCwd,
      draftInput: "",
      history: Object.freeze([]),
      historyIndex: null,
      id: "kernel",
      lastExitCode: null,
      outputBuffer: Object.freeze([]),
      running: false,
      title: "kernel",
    }),
  ]);
}

function commandCompletedTab(
  tab: ShellTabState,
  input: string,
  output: ShellCommandOutput,
  outputLimit: number,
): ShellTabState {
  const lines: ShellOutputLine[] = [
    Object.freeze({
      kind: "input",
      text: input,
    }),
  ];

  for (let index = 0; index < output.lines.length; index += 1) {
    const line = output.lines[index];

    if (line !== undefined) {
      lines.push(Object.freeze({
        kind: "output",
        text: line,
      }));
    }
  }

  const history = input.length === 0
    ? tab.history
    : Object.freeze([...tab.history, input]);

  return freezeTab({
    cwd: output.cwd ?? tab.cwd,
    draftInput: "",
    history,
    historyIndex: null,
    id: tab.id,
    lastExitCode: output.exitCode,
    outputBuffer: freezeOutputBuffer([...tab.outputBuffer, ...lines], outputLimit),
    running: false,
    title: tab.title,
  });
}

function freezeState(tabs: readonly ShellTabState[], activeTabId: string): ShellViewModelState {
  const frozenTabs = Object.freeze([...tabs]);
  const activeTab = findTab(frozenTabs, activeTabId) ?? frozenTabs[0];

  if (activeTab === undefined) {
    const fallback = freezeTab({
      cwd: DEFAULT_CWD,
      draftInput: "",
      history: Object.freeze([]),
      historyIndex: null,
      id: "kernel",
      lastExitCode: null,
      outputBuffer: Object.freeze([]),
      running: false,
      title: "kernel",
    });

    return Object.freeze({
      activeTab: fallback,
      activeTabId: fallback.id,
      tabs: Object.freeze([fallback]),
    });
  }

  return Object.freeze({
    activeTab,
    activeTabId: activeTab.id,
    tabs: frozenTabs,
  });
}

function freezeTab(input: ShellTabState): ShellTabState {
  return Object.freeze({
    cwd: input.cwd,
    draftInput: input.draftInput,
    history: Object.freeze([...input.history]),
    historyIndex: input.historyIndex,
    id: input.id,
    lastExitCode: input.lastExitCode,
    outputBuffer: Object.freeze(input.outputBuffer.map(freezeOutputLine)),
    running: input.running,
    title: input.title,
  });
}

function freezeOutputLine(line: ShellOutputLine): ShellOutputLine {
  return Object.freeze({
    kind: line.kind,
    text: line.text,
  });
}

function freezeOutputBuffer(
  lines: readonly ShellOutputLine[],
  limit: number,
): readonly ShellOutputLine[] {
  const output: ShellOutputLine[] = [];
  const start = Math.max(0, lines.length - limit);

  for (let index = start; index < lines.length; index += 1) {
    const line = lines[index];

    if (line !== undefined) output.push(freezeOutputLine(line));
  }

  return Object.freeze(output);
}

function freezeStringArray(values: readonly string[]): readonly string[] {
  const output: string[] = [];

  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];

    if (value !== undefined) output.push(value);
  }

  return Object.freeze(output);
}

function replaceTab(tabs: readonly ShellTabState[], tab: ShellTabState): readonly ShellTabState[] {
  const output: ShellTabState[] = [];

  for (let index = 0; index < tabs.length; index += 1) {
    const current = tabs[index];

    if (current !== undefined) {
      output.push(current.id === tab.id ? tab : current);
    }
  }

  return Object.freeze(output);
}

function normalizeCommandResult(input: unknown): NormalizeResult<ShellCommandOutput> {
  const object = snapshotObject(input, Object.freeze(["error", "ok", "value"]), "/session/result");

  if (!object.ok) return object;

  const ok = object.value.get("ok");

  if (ok === true) {
    if (!object.value.has("value") || object.value.has("error")) {
      return reject(error("SHELL_SESSION_MALFORMED", "shell session accepted with malformed output.", "/session/result"));
    }

    return normalizeCommandOutput(object.value.get("value"));
  }

  if (ok === false) {
    if (!object.value.has("error") || object.value.has("value")) {
      return reject(error("SHELL_SESSION_MALFORMED", "shell session denied with malformed error.", "/session/result"));
    }

    return normalizeHostError(object.value.get("error"));
  }

  return reject(error("SHELL_SESSION_MALFORMED", "shell session result must include ok.", "/session/result/ok"));
}

function normalizeCommandOutput(input: unknown): NormalizeResult<ShellCommandOutput> {
  const object = snapshotObject(input, Object.freeze(["cwd", "exitCode", "lines"]), "/session/output");

  if (!object.ok) return object;

  const lines = snapshotStringArray(object.value.get("lines"), "/session/output/lines");

  if (!lines.ok) return lines;

  const exitCode = object.value.get("exitCode");

  if (!Number.isInteger(exitCode) || typeof exitCode !== "number" || exitCode < 0) {
    return reject(error("SHELL_SESSION_MALFORMED", "shell session exit code must be a non-negative integer.", "/session/output/exitCode"));
  }

  const cwdValue = object.value.get("cwd");
  const output: {
    lines: readonly string[];
    exitCode: number;
    cwd?: string;
  } = {
    exitCode,
    lines: lines.value,
  };

  if (object.value.has("cwd")) {
    if (typeof cwdValue !== "string" || cwdValue.length === 0) {
      return reject(error("SHELL_SESSION_MALFORMED", "shell session cwd must be a non-empty string.", "/session/output/cwd"));
    }

    output.cwd = cwdValue;
  }

  return accept(Object.freeze(output));
}

function normalizeHostError(input: unknown): NormalizeResult<ShellCommandOutput> {
  const object = snapshotObject(input, Object.freeze(["code", "message", "path"]), "/session/error");

  if (!object.ok) return object;

  const code = object.value.get("code");
  const message = object.value.get("message");
  const path = object.value.get("path");

  if (typeof code !== "string" || code.length === 0) {
    return reject(error("SHELL_SESSION_MALFORMED", "shell session error code must be a non-empty string.", "/session/error/code"));
  }
  if (typeof message !== "string" || message.length === 0) {
    return reject(error("SHELL_SESSION_MALFORMED", "shell session error message must be a non-empty string.", "/session/error/message"));
  }
  if (typeof path !== "string" || path.length === 0) {
    return reject(error("SHELL_SESSION_MALFORMED", "shell session error path must be a non-empty string.", "/session/error/path"));
  }

  return reject(Object.freeze({
    code,
    message,
    path,
  }));
}

function snapshotObject(
  input: unknown,
  allowedKeys: readonly string[],
  path: string,
): NormalizeResult<ReadonlyMap<string, unknown>> {
  try {
    if (input === null || typeof input !== "object" || Array.isArray(input)) {
      return reject(error("SHELL_SESSION_MALFORMED", "value must be a plain object.", path));
    }

    const prototype = Object.getPrototypeOf(input);

    if (prototype !== Object.prototype && prototype !== null) {
      return reject(error("SHELL_SESSION_MALFORMED", "value must be a plain object.", path));
    }

    const keys = Reflect.ownKeys(input);
    const output = new Map<string, unknown>();

    for (let index = 0; index < keys.length; index += 1) {
      const key = keys[index];

      if (key === undefined || typeof key === "symbol" || !contains(allowedKeys, key)) {
        return reject(error("SHELL_SESSION_MALFORMED", "object contains an unsupported field.", path));
      }

      const descriptor = Object.getOwnPropertyDescriptor(input, key);

      if (descriptor === undefined || !isDataDescriptor(descriptor) || descriptor.enumerable !== true) {
        return reject(error("SHELL_SESSION_MALFORMED", "object must contain only enumerable data fields.", path));
      }

      output.set(key, descriptor.value);
    }

    return accept(output);
  } catch {
    return reject(error("SHELL_SESSION_MALFORMED", "value must be a stable plain object.", path));
  }
}

function snapshotStringArray(input: unknown, path: string): NormalizeResult<readonly string[]> {
  try {
    if (!Array.isArray(input) || Object.getPrototypeOf(input) !== Array.prototype) {
      return reject(error("SHELL_SESSION_MALFORMED", "value must be a plain string array.", path));
    }

    const keys = Reflect.ownKeys(input);

    for (let index = 0; index < keys.length; index += 1) {
      const key = keys[index];

      if (key === undefined) continue;
      if (key === "length") continue;
      if (typeof key === "symbol" || !isArrayIndexKey(key, input.length)) {
        return reject(error("SHELL_SESSION_MALFORMED", "array contains an unsupported field.", path));
      }

      const descriptor = Object.getOwnPropertyDescriptor(input, key);

      if (descriptor === undefined || !isDataDescriptor(descriptor) || descriptor.enumerable !== true) {
        return reject(error("SHELL_SESSION_MALFORMED", "array must contain only enumerable data fields.", path));
      }
    }

    const output: string[] = [];

    for (let index = 0; index < input.length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(input, `${index}`);

      if (descriptor === undefined || !isDataDescriptor(descriptor) || typeof descriptor.value !== "string") {
        return reject(error("SHELL_SESSION_MALFORMED", "array entries must be strings.", `${path}/${index}`));
      }

      output.push(descriptor.value);
    }

    return accept(Object.freeze(output));
  } catch {
    return reject(error("SHELL_SESSION_MALFORMED", "value must be a stable string array.", path));
  }
}

function normalizeOutputLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit) || limit < 1) {
    return DEFAULT_OUTPUT_LIMIT;
  }

  return Math.trunc(limit);
}

function normalizeTabId(id: string | undefined, fallback: string): string {
  if (id === undefined || id.length === 0) return fallback;

  return id;
}

function normalizeTitle(title: string | undefined, fallback: string): string {
  if (title === undefined || title.length === 0) return fallback;

  return title;
}

function normalizeCwd(cwd: string): string {
  if (cwd.length === 0) return DEFAULT_CWD;

  return cwd;
}

function nextTabNumber(tabs: readonly ShellTabState[]): number {
  let next = 1;
  const pattern = /^shell-(\d+)$/u;

  for (let index = 0; index < tabs.length; index += 1) {
    const tab = tabs[index];

    if (tab === undefined) continue;

    const matched = pattern.exec(tab.id);

    if (matched === null) continue;

    const value = matched[1];

    if (value === undefined) continue;

    const parsed = Number.parseInt(value, 10);

    if (Number.isInteger(parsed) && parsed >= next) {
      next = parsed + 1;
    }
  }

  return next;
}

function tabIndex(tabs: readonly ShellTabState[], id: string): number {
  for (let index = 0; index < tabs.length; index += 1) {
    if (tabs[index]?.id === id) return index;
  }

  return -1;
}

function findTab(tabs: readonly ShellTabState[], id: string): ShellTabState | undefined {
  const index = tabIndex(tabs, id);

  return index < 0 ? undefined : tabs[index];
}

function hasTab(tabs: readonly ShellTabState[], id: string): boolean {
  return tabIndex(tabs, id) >= 0;
}

function isArrayIndexKey(key: string, length: number): boolean {
  if (key.length === 0) return false;

  const index = Number.parseInt(key, 10);

  return Number.isInteger(index) && index >= 0 && index < length && `${index}` === key;
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

function acceptAction(state: ShellViewModelState): ShellViewModelActionResult {
  return Object.freeze({
    ok: true,
    state,
  });
}

function rejectAction(errorValue: ShellViewModelError, state: ShellViewModelState): ShellViewModelActionResult {
  return Object.freeze({
    error: errorValue,
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

function reject<T>(errorValue: ShellViewModelError): NormalizeResult<T> {
  return Object.freeze({
    error: errorValue,
    ok: false,
  });
}

function error(code: string, message: string, path: string): ShellViewModelError {
  return Object.freeze({
    code,
    message,
    path,
  });
}

function pathToken(value: string): string {
  let token = "";

  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];

    if (char === undefined) continue;

    const code = char.charCodeAt(0);
    const alphaNumeric =
      (code >= 48 && code <= 57) ||
      (code >= 65 && code <= 90) ||
      (code >= 97 && code <= 122);

    token += alphaNumeric || code === 45 || code === 46
      ? char
      : `_${code.toString(16).padStart(4, "0")}`;
  }

  return token.length === 0 ? "_" : token;
}
