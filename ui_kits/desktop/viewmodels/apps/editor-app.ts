import {
  hasAppCapabilityGrant,
} from "../../../../sdk/typescript/src/desktop-sdk/index.ts";
import type {
  AppPackageManifest,
  DesktopCapability,
  FilesCapabilityPort,
  FilesRequest,
  FilesResponse,
} from "../../../../sdk/typescript/src/desktop-sdk/index.ts";

export const DEFAULT_EDITOR_FILES_GRANT = "editor";

export type EditorLanguage =
  | "css"
  | "html"
  | "javascript"
  | "json"
  | "markdown"
  | "plaintext"
  | "typescript";

export type EditorAppAction = "edit" | "moveCursor" | "open" | "redo" | "save" | "undo";

export interface EditorDocument {
  readonly path: string;
  readonly content: string;
  readonly language: EditorLanguage;
}

export interface EditorCursorPosition {
  readonly line: number;
  readonly column: number;
}

export interface EditorSelection {
  readonly anchor: EditorCursorPosition;
  readonly focus: EditorCursorPosition;
}

export type EditorCursorMove = EditorCursorPosition | EditorSelection;

export interface EditorHistoryEntry {
  readonly content: string;
  readonly cursor: EditorCursorPosition;
  readonly selection: EditorSelection;
}

export interface EditorAppSnapshot {
  readonly document?: EditorDocument;
  readonly dirty: boolean;
  readonly cursor: EditorCursorPosition;
  readonly selection: EditorSelection;
  readonly undoStack: readonly EditorHistoryEntry[];
  readonly redoStack: readonly EditorHistoryEntry[];
}

export interface EditorAppError {
  readonly code: string;
  readonly message: string;
  readonly path: string;
}

export interface EditorAppSuccess<Action extends EditorAppAction, Value> {
  readonly ok: true;
  readonly action: Action;
  readonly value: Value;
  readonly state: EditorAppSnapshot;
}

export interface EditorAppFailure<Action extends EditorAppAction> {
  readonly ok: false;
  readonly action: Action;
  readonly error: EditorAppError;
  readonly state: EditorAppSnapshot;
}

export type EditorAppResult<Action extends EditorAppAction, Value> =
  | EditorAppSuccess<Action, Value>
  | EditorAppFailure<Action>;

export interface EditorAppViewModelInput {
  readonly package?: AppPackageManifest;
  readonly files?: FilesCapabilityPort;
  readonly grant?: string;
  readonly initialDocument?: EditorDocument;
}

export interface EditorAppViewModel {
  readonly state: EditorAppSnapshot;
  snapshot(): EditorAppSnapshot;
  open(path: string): Promise<EditorAppResult<"open", EditorDocument>>;
  edit(replacement: string): EditorAppResult<"edit", EditorDocument>;
  undo(): EditorAppResult<"undo", EditorDocument>;
  redo(): EditorAppResult<"redo", EditorDocument>;
  save(): Promise<EditorAppResult<"save", EditorDocument>>;
  moveCursor(position: EditorCursorMove): EditorAppResult<"moveCursor", EditorSelection>;
}

type EditorInternalResult<T> =
  | {
      readonly ok: true;
      readonly value: T;
    }
  | {
      readonly ok: false;
      readonly error: EditorAppError;
    };

const EMPTY_HISTORY = Object.freeze([]) satisfies readonly EditorHistoryEntry[];
const CURSOR_FIELDS = new Set<string>(["column", "line"]);
const MOVE_FIELDS = new Set<string>(["anchor", "column", "focus", "line"]);
const FILES_ERROR_FIELDS = new Set<string>(["code", "message"]);
const FILES_RESPONSE_FIELDS = new Set<string>(["data", "entries", "error", "kind", "mtime", "size"]);

export function createEditorAppViewModel(
  input: EditorAppViewModelInput = Object.freeze({}),
): EditorAppViewModel {
  return new EditorAppModel(input);
}

class EditorAppModel implements EditorAppViewModel {
  readonly #package: AppPackageManifest | undefined;
  readonly #files: FilesCapabilityPort | undefined;
  readonly #grant: string;
  #document: EditorDocument | undefined;
  #savedContent = "";
  #dirty = false;
  #cursor: EditorCursorPosition = cursor(1, 1);
  #selection: EditorSelection = collapsedSelection(this.#cursor);
  #undoStack: readonly EditorHistoryEntry[] = EMPTY_HISTORY;
  #redoStack: readonly EditorHistoryEntry[] = EMPTY_HISTORY;

  constructor(input: EditorAppViewModelInput) {
    this.#package = input.package;
    this.#files = input.files;
    this.#grant = input.grant ?? DEFAULT_EDITOR_FILES_GRANT;

    if (input.initialDocument !== undefined) {
      this.#document = freezeDocument(input.initialDocument);
      this.#savedContent = input.initialDocument.content;
      this.#dirty = false;
      this.#cursor = endCursorForContent(input.initialDocument.content);
      this.#selection = collapsedSelection(this.#cursor);
    }
  }

  get state(): EditorAppSnapshot {
    return this.snapshot();
  }

  snapshot(): EditorAppSnapshot {
    return freezeSnapshot({
      cursor: this.#cursor,
      dirty: this.#dirty,
      document: this.#document,
      redoStack: this.#redoStack,
      selection: this.#selection,
      undoStack: this.#undoStack,
    });
  }

  async open(path: string): Promise<EditorAppResult<"open", EditorDocument>> {
    if (typeof path !== "string" || path.length === 0) {
      return fail("open", error("INVALID_DOCUMENT_PATH", "open requires a non-empty path.", "/path"), this.snapshot());
    }

    const files = this.#requireFiles("files.read", "/capabilityGrants/files.read");

    if (!files.ok) return fail("open", files.error, this.snapshot());

    const normalizedPath = normalizeCapabilityPath(path);
    const request = freezeFilesRequest({
      grant: this.#grant,
      op: "read",
      path: normalizedPath,
    });
    const response = await callFilesPort(files.value, request, "/files/read");

    if (!response.ok) return fail("open", response.error, this.snapshot());
    if (typeof response.value.data !== "string") {
      return fail("open", error(
        "MALFORMED_FILES_RESPONSE",
        "read response did not include document data.",
        "/files/read/data",
      ), this.snapshot());
    }

    const document = freezeDocument({
      content: response.value.data,
      language: languageForPath(normalizedPath),
      path: normalizedPath,
    });

    this.#document = document;
    this.#savedContent = document.content;
    this.#dirty = false;
    this.#cursor = cursor(1, 1);
    this.#selection = collapsedSelection(this.#cursor);
    this.#undoStack = EMPTY_HISTORY;
    this.#redoStack = EMPTY_HISTORY;

    return succeed("open", document, this.snapshot());
  }

  edit(replacement: string): EditorAppResult<"edit", EditorDocument> {
    if (typeof replacement !== "string") {
      return fail("edit", error("INVALID_REPLACEMENT", "edit replacement must be a string.", "/replacement"), this.snapshot());
    }

    const current = this.#document;

    if (current === undefined) return fail("edit", missingDocument(), this.snapshot());

    this.#undoStack = appendHistory(this.#undoStack, historyEntry(current, this.#cursor, this.#selection));
    this.#redoStack = EMPTY_HISTORY;

    const nextCursor = endCursorForContent(replacement);
    const document = freezeDocument({
      content: replacement,
      language: current.language,
      path: current.path,
    });

    this.#document = document;
    this.#dirty = document.content !== this.#savedContent;
    this.#cursor = nextCursor;
    this.#selection = collapsedSelection(nextCursor);

    return succeed("edit", document, this.snapshot());
  }

  undo(): EditorAppResult<"undo", EditorDocument> {
    const current = this.#document;

    if (current === undefined) return fail("undo", missingDocument(), this.snapshot());

    const previous = lastHistoryEntry(this.#undoStack);

    if (previous === undefined) {
      return fail("undo", error("UNDO_UNAVAILABLE", "undo stack is empty.", "/undoStack"), this.snapshot());
    }

    this.#undoStack = dropLastHistoryEntry(this.#undoStack);
    this.#redoStack = appendHistory(this.#redoStack, historyEntry(current, this.#cursor, this.#selection));

    const document = freezeDocument({
      content: previous.content,
      language: current.language,
      path: current.path,
    });

    this.#document = document;
    this.#dirty = document.content !== this.#savedContent;
    this.#cursor = previous.cursor;
    this.#selection = previous.selection;

    return succeed("undo", document, this.snapshot());
  }

  redo(): EditorAppResult<"redo", EditorDocument> {
    const current = this.#document;

    if (current === undefined) return fail("redo", missingDocument(), this.snapshot());

    const next = lastHistoryEntry(this.#redoStack);

    if (next === undefined) {
      return fail("redo", error("REDO_UNAVAILABLE", "redo stack is empty.", "/redoStack"), this.snapshot());
    }

    this.#redoStack = dropLastHistoryEntry(this.#redoStack);
    this.#undoStack = appendHistory(this.#undoStack, historyEntry(current, this.#cursor, this.#selection));

    const document = freezeDocument({
      content: next.content,
      language: current.language,
      path: current.path,
    });

    this.#document = document;
    this.#dirty = document.content !== this.#savedContent;
    this.#cursor = next.cursor;
    this.#selection = next.selection;

    return succeed("redo", document, this.snapshot());
  }

  async save(): Promise<EditorAppResult<"save", EditorDocument>> {
    const current = this.#document;

    if (current === undefined) return fail("save", missingDocument(), this.snapshot());

    const files = this.#requireFiles("files.write", "/capabilityGrants/files.write");

    if (!files.ok) return fail("save", files.error, this.snapshot());

    const request = freezeFilesRequest({
      data: current.content,
      grant: this.#grant,
      op: "write",
      path: current.path,
    });
    const response = await callFilesPort(files.value, request, "/files/write");

    if (!response.ok) return fail("save", response.error, this.snapshot());

    this.#savedContent = current.content;
    this.#dirty = false;

    return succeed("save", current, this.snapshot());
  }

  moveCursor(position: EditorCursorMove): EditorAppResult<"moveCursor", EditorSelection> {
    const current = this.#document;

    if (current === undefined) return fail("moveCursor", missingDocument(), this.snapshot());

    const selection = normalizeCursorMove(position, current.content);

    if (!selection.ok) return fail("moveCursor", selection.error, this.snapshot());

    this.#selection = selection.value;
    this.#cursor = selection.value.focus;

    return succeed("moveCursor", selection.value, this.snapshot());
  }

  #requireFiles(
    capability: DesktopCapability,
    path: string,
  ): EditorInternalResult<FilesCapabilityPort> {
    if (this.#grant.length === 0) {
      return rejectInternal("MISSING_FILES_GRANT", "editor files grant is missing.", "/grant");
    }
    if (this.#package === undefined || !hasAppCapabilityGrant(this.#package, capability, this.#grant)) {
      return rejectInternal(
        "MISSING_CAPABILITY",
        `editor package requires ${capability}.`,
        path,
      );
    }
    if (this.#files === undefined) {
      return rejectInternal("MISSING_FILES_PORT", "editor requires an injected files capability port.", "/files");
    }

    return acceptInternal(this.#files);
  }
}

async function callFilesPort(
  port: FilesCapabilityPort,
  request: FilesRequest,
  path: string,
): Promise<EditorInternalResult<FilesResponse>> {
  let raw: unknown;

  try {
    raw = await port.request(request);
  } catch {
    return rejectInternal("FILES_PORT_FAILED", "files capability port failed closed.", path);
  }

  return normalizeFilesPortResponse(raw, path);
}

function normalizeFilesPortResponse(raw: unknown, path: string): EditorInternalResult<FilesResponse> {
  const response = safeRecord(raw, FILES_RESPONSE_FIELDS, path);

  if (!response.ok) return rejectInternal("MALFORMED_FILES_RESPONSE", response.error.message, path);

  const errorValue = field(response.value, "error");

  if (errorValue !== undefined) return normalizeFilesError(errorValue, `${path}/error`);

  const dataValue = field(response.value, "data");
  const output: {
    data?: string;
  } = {};

  if (dataValue !== undefined) {
    if (typeof dataValue !== "string") {
      return rejectInternal("MALFORMED_FILES_RESPONSE", "files data must be a string.", `${path}/data`);
    }

    output.data = dataValue;
  }

  return acceptInternal(Object.freeze(output));
}

function normalizeFilesError(raw: unknown, path: string): EditorInternalResult<FilesResponse> {
  const errorRecord = safeRecord(raw, FILES_ERROR_FIELDS, path);

  if (!errorRecord.ok) return rejectInternal("MALFORMED_FILES_RESPONSE", "files error must be an object.", path);

  const code = field(errorRecord.value, "code");
  const message = field(errorRecord.value, "message");

  if (typeof code !== "string" || code.length === 0 || typeof message !== "string") {
    return rejectInternal("MALFORMED_FILES_RESPONSE", "files error must include code and message.", path);
  }

  return rejectInternal(code, message, path);
}

function normalizeCursorMove(raw: unknown, content: string): EditorInternalResult<EditorSelection> {
  const move = safeRecord(raw, MOVE_FIELDS, "/cursor");

  if (!move.ok) return rejectInternal("INVALID_CURSOR", move.error.message, "/cursor");

  const anchorValue = field(move.value, "anchor");
  const focusValue = field(move.value, "focus");

  if (anchorValue !== undefined || focusValue !== undefined) {
    if (anchorValue === undefined || focusValue === undefined) {
      return rejectInternal("INVALID_CURSOR", "cursor selection requires anchor and focus.", "/cursor");
    }

    const anchor = normalizeCursorPosition(anchorValue, content, "/cursor/anchor");
    const focus = normalizeCursorPosition(focusValue, content, "/cursor/focus");

    if (!anchor.ok) return anchor;
    if (!focus.ok) return focus;

    return acceptInternal(freezeSelection({
      anchor: anchor.value,
      focus: focus.value,
    }));
  }

  const focus = normalizeCursorPositionFromRecord(move.value, content, "/cursor");

  if (!focus.ok) return focus;

  return acceptInternal(collapsedSelection(focus.value));
}

function normalizeCursorPosition(
  raw: unknown,
  content: string,
  path: string,
): EditorInternalResult<EditorCursorPosition> {
  const position = safeRecord(raw, CURSOR_FIELDS, path);

  if (!position.ok) return rejectInternal("INVALID_CURSOR", position.error.message, path);

  return normalizeCursorPositionFromRecord(position.value, content, path);
}

function normalizeCursorPositionFromRecord(
  position: Readonly<Record<string, unknown>>,
  content: string,
  path: string,
): EditorInternalResult<EditorCursorPosition> {
  const lineValue = field(position, "line");
  const columnValue = field(position, "column");

  if (
    typeof lineValue !== "number" ||
    typeof columnValue !== "number" ||
    !Number.isFinite(lineValue) ||
    !Number.isFinite(columnValue)
  ) {
    return rejectInternal("INVALID_CURSOR", "cursor line and column must be finite numbers.", path);
  }

  const lineLengths = documentLineLengths(content);
  const line = Math.max(1, Math.min(Math.trunc(lineValue), lineLengths.length));
  const lineLength = lineLengths[line - 1] ?? 0;
  const column = Math.max(1, Math.min(Math.trunc(columnValue), lineLength + 1));

  return acceptInternal(cursor(line, column));
}

function freezeSnapshot(input: {
  readonly document: EditorDocument | undefined;
  readonly dirty: boolean;
  readonly cursor: EditorCursorPosition;
  readonly selection: EditorSelection;
  readonly undoStack: readonly EditorHistoryEntry[];
  readonly redoStack: readonly EditorHistoryEntry[];
}): EditorAppSnapshot {
  const output: {
    document?: EditorDocument;
    dirty: boolean;
    cursor: EditorCursorPosition;
    selection: EditorSelection;
    undoStack: readonly EditorHistoryEntry[];
    redoStack: readonly EditorHistoryEntry[];
  } = {
    cursor: freezeCursor(input.cursor),
    dirty: input.dirty,
    redoStack: freezeHistory(input.redoStack),
    selection: freezeSelection(input.selection),
    undoStack: freezeHistory(input.undoStack),
  };

  if (input.document !== undefined) output.document = freezeDocument(input.document);

  return Object.freeze(output);
}

function freezeDocument(document: EditorDocument): EditorDocument {
  return Object.freeze({
    content: document.content,
    language: document.language,
    path: normalizeCapabilityPath(document.path),
  });
}

function historyEntry(
  document: EditorDocument,
  cursorValue: EditorCursorPosition,
  selection: EditorSelection,
): EditorHistoryEntry {
  return freezeHistoryEntry({
    content: document.content,
    cursor: cursorValue,
    selection,
  });
}

function freezeHistory(entries: readonly EditorHistoryEntry[]): readonly EditorHistoryEntry[] {
  const output: EditorHistoryEntry[] = [];

  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];

    if (entry !== undefined) output.push(freezeHistoryEntry(entry));
  }

  return Object.freeze(output);
}

function freezeHistoryEntry(entry: EditorHistoryEntry): EditorHistoryEntry {
  return Object.freeze({
    content: entry.content,
    cursor: freezeCursor(entry.cursor),
    selection: freezeSelection(entry.selection),
  });
}

function appendHistory(
  entries: readonly EditorHistoryEntry[],
  entry: EditorHistoryEntry,
): readonly EditorHistoryEntry[] {
  return Object.freeze([
    ...freezeHistory(entries),
    freezeHistoryEntry(entry),
  ]);
}

function lastHistoryEntry(entries: readonly EditorHistoryEntry[]): EditorHistoryEntry | undefined {
  const entry = entries[entries.length - 1];

  return entry === undefined ? undefined : freezeHistoryEntry(entry);
}

function dropLastHistoryEntry(entries: readonly EditorHistoryEntry[]): readonly EditorHistoryEntry[] {
  if (entries.length === 0) return EMPTY_HISTORY;

  return freezeHistory(entries.slice(0, -1));
}

function freezeSelection(selection: EditorSelection): EditorSelection {
  return Object.freeze({
    anchor: freezeCursor(selection.anchor),
    focus: freezeCursor(selection.focus),
  });
}

function collapsedSelection(position: EditorCursorPosition): EditorSelection {
  return freezeSelection({
    anchor: position,
    focus: position,
  });
}

function freezeCursor(position: EditorCursorPosition): EditorCursorPosition {
  return cursor(position.line, position.column);
}

function cursor(line: number, column: number): EditorCursorPosition {
  return Object.freeze({
    column,
    line,
  });
}

function endCursorForContent(content: string): EditorCursorPosition {
  let line = 1;
  let column = 1;

  for (let index = 0; index < content.length; index += 1) {
    if (content[index] === "\n") {
      line += 1;
      column = 1;
    } else {
      column += 1;
    }
  }

  return cursor(line, column);
}

function documentLineLengths(content: string): readonly number[] {
  const lengths: number[] = [0];

  for (let index = 0; index < content.length; index += 1) {
    if (content[index] === "\n") {
      lengths.push(0);
      continue;
    }

    const lineIndex = lengths.length - 1;
    lengths[lineIndex] = (lengths[lineIndex] ?? 0) + 1;
  }

  return Object.freeze(lengths);
}

function freezeFilesRequest(request: FilesRequest): FilesRequest {
  const output: {
    op: FilesRequest["op"];
    grant: string;
    path: string;
    data?: string;
  } = {
    grant: request.grant,
    op: request.op,
    path: normalizeCapabilityPath(request.path),
  };

  if (request.data !== undefined) output.data = request.data;

  return Object.freeze(output);
}

function languageForPath(path: string): EditorLanguage {
  const lower = path.toLocaleLowerCase("en-US");

  if (lower.endsWith(".ts") || lower.endsWith(".tsx")) return "typescript";
  if (lower.endsWith(".js") || lower.endsWith(".jsx") || lower.endsWith(".mjs")) return "javascript";
  if (lower.endsWith(".json")) return "json";
  if (lower.endsWith(".md") || lower.endsWith(".markdown")) return "markdown";
  if (lower.endsWith(".html") || lower.endsWith(".htm")) return "html";
  if (lower.endsWith(".css")) return "css";

  return "plaintext";
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

function safeRecord(
  value: unknown,
  allowedFields: ReadonlySet<string>,
  path: string,
): EditorInternalResult<Readonly<Record<string, unknown>>> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return rejectInternal("MALFORMED_OBJECT", "value must be a plain object.", path);
  }

  try {
    const prototype = Object.getPrototypeOf(value);

    if (prototype !== Object.prototype && prototype !== null) {
      return rejectInternal("MALFORMED_OBJECT", "value must be a plain object.", path);
    }

    const output = Object.create(null) as Record<string, unknown>;
    const keys = Reflect.ownKeys(value);

    for (let index = 0; index < keys.length; index += 1) {
      const key = keys[index];

      if (key === undefined || typeof key === "symbol" || !allowedFields.has(key)) {
        return rejectInternal("MALFORMED_OBJECT", "object contains an unsupported field.", path);
      }

      const descriptor = Object.getOwnPropertyDescriptor(value, key);

      if (descriptor === undefined || !Object.hasOwn(descriptor, "value")) {
        return rejectInternal("MALFORMED_OBJECT", "object fields must be data fields.", path);
      }

      Object.defineProperty(output, key, {
        configurable: false,
        enumerable: true,
        value: descriptor.value,
        writable: false,
      });
    }

    return acceptInternal(Object.freeze(output));
  } catch {
    return rejectInternal("MALFORMED_OBJECT", "value object could not be inspected.", path);
  }
}

function field(record: Readonly<Record<string, unknown>>, key: string): unknown {
  if (!Object.hasOwn(record, key)) return undefined;

  return record[key];
}

function missingDocument(): EditorAppError {
  return error("NO_OPEN_DOCUMENT", "editor has no open document.", "/document");
}

function error(code: string, message: string, path: string): EditorAppError {
  return Object.freeze({
    code,
    message,
    path,
  });
}

function succeed<Action extends EditorAppAction, Value>(
  action: Action,
  value: Value,
  state: EditorAppSnapshot,
): EditorAppSuccess<Action, Value> {
  return Object.freeze({
    action,
    ok: true,
    state,
    value,
  });
}

function fail<Action extends EditorAppAction>(
  action: Action,
  errorValue: EditorAppError,
  state: EditorAppSnapshot,
): EditorAppFailure<Action> {
  return Object.freeze({
    action,
    error: errorValue,
    ok: false,
    state,
  });
}

function acceptInternal<T>(value: T): EditorInternalResult<T> {
  return Object.freeze({
    ok: true,
    value,
  });
}

function rejectInternal<T>(code: string, message: string, path: string): EditorInternalResult<T> {
  return Object.freeze({
    error: error(code, message, path),
    ok: false,
  });
}
