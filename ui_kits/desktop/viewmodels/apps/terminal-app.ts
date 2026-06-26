export type TerminalScrollbackLineKind = "input" | "output" | "error";
export type TerminalResolvedLineKind = "output" | "error";

export interface TerminalScrollbackLine {
  readonly kind: TerminalScrollbackLineKind;
  readonly text: string;
}

export interface TerminalResolvedLine {
  readonly kind: TerminalResolvedLineKind;
  readonly text: string;
}

export interface TerminalAppState {
  readonly scrollback: readonly TerminalScrollbackLine[];
  readonly inputBuffer: string;
  readonly history: readonly string[];
  readonly historyCursor: number | null;
  readonly promptLabel: string;
}

export interface TerminalCommandRequest {
  readonly rawInput: string;
  readonly commandName: string;
  readonly argumentText: string;
  readonly args: readonly string[];
  readonly promptLabel: string;
}

export interface TerminalCommandOutput {
  readonly ok: true;
  readonly kind: "output";
  readonly lines: readonly TerminalResolvedLine[];
  readonly promptLabel?: string;
}

export interface TerminalCommandClear {
  readonly ok: true;
  readonly kind: "clear";
  readonly promptLabel?: string;
}

export interface TerminalCommandDenied {
  readonly ok: false;
  readonly error: TerminalAppError;
  readonly lines: readonly TerminalResolvedLine[];
}

export type TerminalCommandResult =
  | TerminalCommandOutput
  | TerminalCommandClear
  | TerminalCommandDenied;

export interface TerminalCommandResolver {
  resolve(request: TerminalCommandRequest): unknown;
}

export interface TerminalAppError {
  readonly code: string;
  readonly message: string;
  readonly path: string;
}

export type TerminalActionResult =
  | {
      readonly ok: true;
      readonly state: TerminalAppState;
    }
  | {
      readonly ok: false;
      readonly error: TerminalAppError;
      readonly state: TerminalAppState;
    };

export interface TerminalAppOptions {
  readonly resolver?: TerminalCommandResolver;
  readonly initialInput?: string;
  readonly initialScrollback?: readonly TerminalScrollbackLine[];
  readonly initialHistory?: readonly string[];
  readonly promptLabel?: string;
}

export interface TerminalAppViewModel {
  readonly state: TerminalAppState;
  snapshot(): TerminalAppState;
  type(text: string): TerminalActionResult;
  submit(): TerminalActionResult;
  historyPrev(): TerminalActionResult;
  historyNext(): TerminalActionResult;
  clear(): TerminalActionResult;
}

type NormalizeResult<T> =
  | {
      readonly ok: true;
      readonly value: T;
    }
  | {
      readonly ok: false;
      readonly error: TerminalAppError;
    };

const DEFAULT_PROMPT_LABEL = "vita:~$";
const BUILT_IN_HELP = "Available commands: clear, echo, help";
const RESULT_FIELDS = Object.freeze(["error", "kind", "lines", "ok", "promptLabel"]);
const ERROR_FIELDS = Object.freeze(["code", "message", "path"]);
const LINE_FIELDS = Object.freeze(["kind", "text"]);

export function createTerminalAppViewModel(options: TerminalAppOptions = Object.freeze({})): TerminalAppViewModel {
  return new TerminalAppModel(options);
}

export function createTerminalBuiltInResolver(): TerminalCommandResolver {
  return Object.freeze({
    resolve(request: TerminalCommandRequest): TerminalCommandResult {
      switch (request.commandName) {
        case "":
          return output(Object.freeze([]));
        case "help":
          return output(Object.freeze([
            line("output", BUILT_IN_HELP),
          ]));
        case "echo":
          return output(Object.freeze([
            line("output", request.argumentText),
          ]));
        case "clear":
          return Object.freeze({
            kind: "clear",
            ok: true,
          });
        default: {
          const commandName = request.commandName;
          return Object.freeze({
            error: error(
              "UNKNOWN_COMMAND",
              `unknown command: ${commandName}`,
              `/commands/${pathToken(commandName)}`,
            ),
            lines: Object.freeze([
              line("error", `unknown command: ${commandName}`),
            ]),
            ok: false,
          });
        }
      }
    },
  });
}

class TerminalAppModel implements TerminalAppViewModel {
  readonly #resolver: TerminalCommandResolver | undefined;
  #state: TerminalAppState;

  constructor(options: TerminalAppOptions) {
    this.#resolver = options.resolver;
    this.#state = freezeState({
      history: freezeStringArray(options.initialHistory ?? Object.freeze([])),
      historyCursor: null,
      inputBuffer: options.initialInput ?? "",
      promptLabel: options.promptLabel ?? DEFAULT_PROMPT_LABEL,
      scrollback: freezeScrollback(options.initialScrollback ?? Object.freeze([])),
    });
  }

  get state(): TerminalAppState {
    return this.#state;
  }

  snapshot(): TerminalAppState {
    return this.#state;
  }

  type(text: string): TerminalActionResult {
    if (text.length === 0) return acceptAction(this.#state);

    this.#state = freezeState({
      ...this.#state,
      historyCursor: null,
      inputBuffer: `${this.#state.inputBuffer}${text}`,
    });

    return acceptAction(this.#state);
  }

  submit(): TerminalActionResult {
    const resolver = this.#resolver;

    if (resolver === undefined) {
      return rejectAction(error(
        "TERMINAL_RESOLVER_UNAVAILABLE",
        "terminal command resolver is unavailable.",
        "/resolver",
      ), this.#state);
    }

    const before = this.#state;
    const request = parseCommand(before.inputBuffer, before.promptLabel);
    let rawResult: unknown;

    try {
      rawResult = resolver.resolve(request);
    } catch {
      return rejectAction(error(
        "TERMINAL_RESOLVER_FAILED",
        "terminal command resolver failed closed.",
        "/resolver",
      ), before);
    }

    const normalized = normalizeCommandResult(rawResult);

    if (!normalized.ok) return rejectAction(normalized.error, before);

    this.#state = applyCommandResult(before, request.rawInput, normalized.value);

    if (!normalized.value.ok) {
      return rejectAction(normalized.value.error, this.#state);
    }

    return acceptAction(this.#state);
  }

  historyPrev(): TerminalActionResult {
    if (this.#state.history.length === 0) return acceptAction(this.#state);

    const historyCursor = this.#state.historyCursor === null
      ? this.#state.history.length - 1
      : Math.max(0, this.#state.historyCursor - 1);
    const inputBuffer = this.#state.history[historyCursor] ?? this.#state.inputBuffer;

    this.#state = freezeState({
      ...this.#state,
      historyCursor,
      inputBuffer,
    });

    return acceptAction(this.#state);
  }

  historyNext(): TerminalActionResult {
    const current = this.#state.historyCursor;

    if (this.#state.history.length === 0 || current === null) {
      return acceptAction(this.#state);
    }

    const nextCursor = current + 1;
    const historyCursor = nextCursor >= this.#state.history.length ? null : nextCursor;
    const inputBuffer = historyCursor === null ? "" : this.#state.history[historyCursor] ?? "";

    this.#state = freezeState({
      ...this.#state,
      historyCursor,
      inputBuffer,
    });

    return acceptAction(this.#state);
  }

  clear(): TerminalActionResult {
    this.#state = freezeState({
      ...this.#state,
      scrollback: Object.freeze([]),
    });

    return acceptAction(this.#state);
  }
}

function applyCommandResult(
  state: TerminalAppState,
  rawInput: string,
  result: TerminalCommandResult,
): TerminalAppState {
  const history = rawInput.trim().length === 0
    ? state.history
    : Object.freeze([...state.history, rawInput]);
  const promptLabel = result.ok && result.promptLabel !== undefined
    ? result.promptLabel
    : state.promptLabel;

  if (result.ok && result.kind === "clear") {
    return freezeState({
      history,
      historyCursor: null,
      inputBuffer: "",
      promptLabel,
      scrollback: Object.freeze([]),
    });
  }

  const resolvedLines = result.ok
    ? result.lines
    : result.lines.length > 0 ? result.lines : Object.freeze([
        line("error", result.error.message),
      ]);
  const nextLines: TerminalScrollbackLine[] = [
    freezeScrollbackLine({
      kind: "input",
      text: rawInput,
    }),
  ];

  for (let index = 0; index < resolvedLines.length; index += 1) {
    const resolvedLine = resolvedLines[index];

    if (resolvedLine !== undefined) {
      nextLines.push(freezeScrollbackLine(resolvedLine));
    }
  }

  return freezeState({
    history,
    historyCursor: null,
    inputBuffer: "",
    promptLabel,
    scrollback: freezeScrollback([...state.scrollback, ...nextLines]),
  });
}

function parseCommand(rawInput: string, promptLabel: string): TerminalCommandRequest {
  const trimmed = rawInput.trim();

  if (trimmed.length === 0) {
    return Object.freeze({
      args: Object.freeze([]),
      argumentText: "",
      commandName: "",
      promptLabel,
      rawInput,
    });
  }

  const commandEnd = firstWhitespaceIndex(trimmed);
  const commandName = commandEnd < 0 ? trimmed : trimmed.slice(0, commandEnd);
  const argumentText = commandEnd < 0 ? "" : trimmed.slice(commandEnd).trimStart();
  const args: readonly string[] = argumentText.length === 0
    ? Object.freeze([])
    : Object.freeze(argumentText.split(/\s+/u));

  return Object.freeze({
    args,
    argumentText,
    commandName,
    promptLabel,
    rawInput,
  });
}

function firstWhitespaceIndex(value: string): number {
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];

    if (char !== undefined && /\s/u.test(char)) return index;
  }

  return -1;
}

function normalizeCommandResult(input: unknown): NormalizeResult<TerminalCommandResult> {
  const object = snapshotObject(input, RESULT_FIELDS, "/resolver/result");

  if (!object.ok) return object;

  const ok = object.value.get("ok");
  const kind = object.value.get("kind");

  if (ok === true) {
    const promptLabel = optionalPromptLabel(object.value, "/resolver/result/promptLabel");

    if (!promptLabel.ok) return promptLabel;
    if (kind === "clear") {
      if (object.value.has("error") || object.value.has("lines")) {
        return reject(error("TERMINAL_RESOLVER_MALFORMED", "clear result must not include output fields.", "/resolver/result"));
      }

      const outputValue: {
        ok: true;
        kind: "clear";
        promptLabel?: string;
      } = {
        kind: "clear",
        ok: true,
      };

      if (promptLabel.value !== undefined) outputValue.promptLabel = promptLabel.value;

      return accept(Object.freeze(outputValue));
    }
    if (kind === "output") {
      if (object.value.has("error") || !object.value.has("lines")) {
        return reject(error("TERMINAL_RESOLVER_MALFORMED", "output result must include lines only.", "/resolver/result"));
      }

      const lines = snapshotResolvedLines(object.value.get("lines"), "/resolver/result/lines");

      if (!lines.ok) return lines;

      const outputValue: {
        ok: true;
        kind: "output";
        lines: readonly TerminalResolvedLine[];
        promptLabel?: string;
      } = {
        kind: "output",
        lines: lines.value,
        ok: true,
      };

      if (promptLabel.value !== undefined) outputValue.promptLabel = promptLabel.value;

      return accept(Object.freeze(outputValue));
    }

    return reject(error("TERMINAL_RESOLVER_MALFORMED", "accepted result kind is not supported.", "/resolver/result/kind"));
  }

  if (ok === false) {
    if (kind !== undefined || !object.value.has("error") || !object.value.has("lines")) {
      return reject(error("TERMINAL_RESOLVER_MALFORMED", "denied result must include error and lines.", "/resolver/result"));
    }

    const errorValue = snapshotError(object.value.get("error"), "/resolver/result/error");
    const lines = snapshotResolvedLines(object.value.get("lines"), "/resolver/result/lines");

    if (!errorValue.ok) return errorValue;
    if (!lines.ok) return lines;

    return accept(Object.freeze({
      error: errorValue.value,
      lines: lines.value,
      ok: false,
    }));
  }

  return reject(error("TERMINAL_RESOLVER_MALFORMED", "resolver result must include ok.", "/resolver/result/ok"));
}

function optionalPromptLabel(
  object: ReadonlyMap<string, unknown>,
  path: string,
): NormalizeResult<string | undefined> {
  if (!object.has("promptLabel")) return accept(undefined);

  const promptLabel = object.get("promptLabel");

  if (typeof promptLabel !== "string") {
    return reject(error("TERMINAL_RESOLVER_MALFORMED", "promptLabel must be a string when present.", path));
  }

  return accept(promptLabel);
}

function snapshotError(input: unknown, path: string): NormalizeResult<TerminalAppError> {
  const object = snapshotObject(input, ERROR_FIELDS, path);

  if (!object.ok) return object;

  const code = object.value.get("code");
  const message = object.value.get("message");
  const errorPath = object.value.get("path");

  if (typeof code !== "string" || code.length === 0) {
    return reject(error("TERMINAL_RESOLVER_MALFORMED", "error code must be a non-empty string.", `${path}/code`));
  }
  if (typeof message !== "string" || message.length === 0) {
    return reject(error("TERMINAL_RESOLVER_MALFORMED", "error message must be a non-empty string.", `${path}/message`));
  }
  if (typeof errorPath !== "string" || errorPath.length === 0) {
    return reject(error("TERMINAL_RESOLVER_MALFORMED", "error path must be a non-empty string.", `${path}/path`));
  }

  return accept(error(code, message, errorPath));
}

function snapshotResolvedLines(input: unknown, path: string): NormalizeResult<readonly TerminalResolvedLine[]> {
  try {
    if (!Array.isArray(input) || Object.getPrototypeOf(input) !== Array.prototype) {
      return reject(error("TERMINAL_RESOLVER_MALFORMED", "lines must be a plain array.", path));
    }

    const keys = Reflect.ownKeys(input);

    for (let index = 0; index < keys.length; index += 1) {
      const key = keys[index];

      if (key === undefined || key === "length") continue;
      if (typeof key === "symbol" || !isArrayIndexKey(key, input.length)) {
        return reject(error("TERMINAL_RESOLVER_MALFORMED", "lines contains an unsupported field.", path));
      }

      const descriptor = Object.getOwnPropertyDescriptor(input, key);

      if (descriptor === undefined || !isDataDescriptor(descriptor) || descriptor.enumerable !== true) {
        return reject(error("TERMINAL_RESOLVER_MALFORMED", "lines must contain only enumerable data fields.", path));
      }
    }

    const output: TerminalResolvedLine[] = [];

    for (let index = 0; index < input.length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(input, `${index}`);

      if (descriptor === undefined || !isDataDescriptor(descriptor)) {
        return reject(error("TERMINAL_RESOLVER_MALFORMED", "line entry is missing.", `${path}/${index}`));
      }

      const resolved = snapshotResolvedLine(descriptor.value, `${path}/${index}`);

      if (!resolved.ok) return resolved;

      output.push(resolved.value);
    }

    return accept(Object.freeze(output));
  } catch {
    return reject(error("TERMINAL_RESOLVER_MALFORMED", "lines must be stable plain data.", path));
  }
}

function snapshotResolvedLine(input: unknown, path: string): NormalizeResult<TerminalResolvedLine> {
  const object = snapshotObject(input, LINE_FIELDS, path);

  if (!object.ok) return object;

  const kind = object.value.get("kind");
  const text = object.value.get("text");

  if (kind !== "output" && kind !== "error") {
    return reject(error("TERMINAL_RESOLVER_MALFORMED", "line kind must be output or error.", `${path}/kind`));
  }
  if (typeof text !== "string") {
    return reject(error("TERMINAL_RESOLVER_MALFORMED", "line text must be a string.", `${path}/text`));
  }

  return accept(line(kind, text));
}

function snapshotObject(
  input: unknown,
  allowedKeys: readonly string[],
  path: string,
): NormalizeResult<ReadonlyMap<string, unknown>> {
  try {
    if (input === null || typeof input !== "object" || Array.isArray(input)) {
      return reject(error("TERMINAL_RESOLVER_MALFORMED", "value must be a plain object.", path));
    }

    const prototype = Object.getPrototypeOf(input);

    if (prototype !== Object.prototype && prototype !== null) {
      return reject(error("TERMINAL_RESOLVER_MALFORMED", "value must be a plain object.", path));
    }

    const keys = Reflect.ownKeys(input);
    const outputMap = new Map<string, unknown>();

    for (let index = 0; index < keys.length; index += 1) {
      const key = keys[index];

      if (key === undefined || typeof key === "symbol" || !contains(allowedKeys, key)) {
        return reject(error("TERMINAL_RESOLVER_MALFORMED", "object contains an unsupported field.", path));
      }

      const descriptor = Object.getOwnPropertyDescriptor(input, key);

      if (descriptor === undefined || !isDataDescriptor(descriptor) || descriptor.enumerable !== true) {
        return reject(error("TERMINAL_RESOLVER_MALFORMED", "object must contain only enumerable data fields.", path));
      }

      outputMap.set(key, descriptor.value);
    }

    return accept(outputMap);
  } catch {
    return reject(error("TERMINAL_RESOLVER_MALFORMED", "value must be stable plain data.", path));
  }
}

function freezeState(input: TerminalAppState): TerminalAppState {
  return Object.freeze({
    history: freezeStringArray(input.history),
    historyCursor: input.historyCursor,
    inputBuffer: input.inputBuffer,
    promptLabel: input.promptLabel,
    scrollback: freezeScrollback(input.scrollback),
  });
}

function freezeScrollback(lines: readonly TerminalScrollbackLine[]): readonly TerminalScrollbackLine[] {
  const outputLines: TerminalScrollbackLine[] = [];

  for (let index = 0; index < lines.length; index += 1) {
    const current = lines[index];

    if (current !== undefined) outputLines.push(freezeScrollbackLine(current));
  }

  return Object.freeze(outputLines);
}

function freezeScrollbackLine(lineValue: TerminalScrollbackLine): TerminalScrollbackLine {
  return Object.freeze({
    kind: lineValue.kind,
    text: lineValue.text,
  });
}

function freezeStringArray(values: readonly string[]): readonly string[] {
  const outputValues: string[] = [];

  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];

    if (value !== undefined) outputValues.push(value);
  }

  return Object.freeze(outputValues);
}

function output(lines: readonly TerminalResolvedLine[]): TerminalCommandOutput {
  return Object.freeze({
    kind: "output",
    lines: Object.freeze([...lines]),
    ok: true,
  });
}

function line(kind: TerminalResolvedLineKind, text: string): TerminalResolvedLine {
  return Object.freeze({
    kind,
    text,
  });
}

function acceptAction(state: TerminalAppState): TerminalActionResult {
  return Object.freeze({
    ok: true,
    state,
  });
}

function rejectAction(errorValue: TerminalAppError, state: TerminalAppState): TerminalActionResult {
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

function reject<T>(errorValue: TerminalAppError): NormalizeResult<T> {
  return Object.freeze({
    error: errorValue,
    ok: false,
  });
}

function error(code: string, message: string, path: string): TerminalAppError {
  return Object.freeze({
    code,
    message,
    path,
  });
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
