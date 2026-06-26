import {
  createFileManagerState,
  joinCapabilityPath,
  loadFileManagerDirectory,
  parentCapabilityPath,
} from "../../../../sdk/typescript/src/desktop-sdk/index.ts";
import type {
  AppError,
  FileManagerState,
  FilesCapabilityPort,
  FilesEntry,
} from "../../../../sdk/typescript/src/desktop-sdk/index.ts";

export type FilesAppStatus = "idle" | "ready" | "forbidden" | "error";

export interface FilesAppBreadcrumbSegment {
  readonly label: string;
  readonly path: string;
}

export interface FilesAppDirectoryEntry {
  readonly name: string;
  readonly kind: FilesEntry["kind"];
  readonly size: number;
  readonly modified: string;
}

export interface FilesAppState {
  readonly path: string;
  readonly breadcrumbs: readonly FilesAppBreadcrumbSegment[];
  readonly entries: readonly FilesAppDirectoryEntry[];
  readonly status: FilesAppStatus;
  readonly selected?: FilesAppDirectoryEntry;
  readonly error?: AppError;
}

export type FilesAppResult<T> =
  | {
      readonly ok: true;
      readonly value: T;
    }
  | {
      readonly ok: false;
      readonly error: AppError;
    };

export interface FilesAppViewModelInput {
  readonly files?: FilesCapabilityPort;
  readonly grant?: string;
  readonly initialPath?: string;
}

export interface FilesAppViewModel {
  readonly state: FilesAppState;
  snapshot(): FilesAppState;
  navigate(path: string): Promise<FilesAppResult<FilesAppState>>;
  up(): Promise<FilesAppResult<FilesAppState>>;
  select(entry: FilesAppDirectoryEntry | string): FilesAppResult<FilesAppState>;
  refresh(): Promise<FilesAppResult<FilesAppState>>;
}

const EMPTY_ENTRIES: readonly FilesAppDirectoryEntry[] = Object.freeze([]);

export function createFilesAppViewModel(
  input: FilesAppViewModelInput = Object.freeze({}),
): FilesAppViewModel {
  return new FilesAppModel(input);
}

class FilesAppModel implements FilesAppViewModel {
  readonly #files: FilesCapabilityPort | undefined;
  readonly #grant: string | undefined;
  #state: FilesAppState;

  constructor(input: FilesAppViewModelInput) {
    this.#files = input.files;
    this.#grant = input.grant;
    this.#state = freezeFilesAppState({
      entries: EMPTY_ENTRIES,
      path: normalizeCapabilityPath(input.initialPath ?? "/"),
      status: "idle",
    });
  }

  get state(): FilesAppState {
    return this.#state;
  }

  snapshot(): FilesAppState {
    return this.#state;
  }

  navigate(path: string): Promise<FilesAppResult<FilesAppState>> {
    return this.#readDirectory(resolveTargetPath(this.#state.path, path));
  }

  up(): Promise<FilesAppResult<FilesAppState>> {
    return this.#readDirectory(parentCapabilityPath(this.#state.path));
  }

  select(entry: FilesAppDirectoryEntry | string): FilesAppResult<FilesAppState> {
    const name = typeof entry === "string" ? entry : entry.name;
    const selected = findEntryByName(this.#state.entries, name);

    if (selected === undefined) {
      return reject("EntryNotFound", `directory entry '${name}' is not available.`, "/entries");
    }

    this.#state = freezeFilesAppState({
      entries: this.#state.entries,
      path: this.#state.path,
      selected,
      status: this.#state.status,
    });

    return accept(this.#state);
  }

  refresh(): Promise<FilesAppResult<FilesAppState>> {
    return this.#readDirectory(this.#state.path);
  }

  async #readDirectory(path: string): Promise<FilesAppResult<FilesAppState>> {
    const targetPath = normalizeCapabilityPath(path);
    const grant = this.#grant;

    if (grant === undefined || grant.length === 0) {
      return this.#failClosed(targetPath, {
        code: "MissingFilesGrant",
        message: "Files app requires an injected files grant.",
        path: "/grant",
      });
    }

    const files = this.#files;

    if (files === undefined) {
      return this.#failClosed(targetPath, {
        code: "MissingFilesPort",
        message: "Files app requires an injected files capability port.",
        path: "/files",
      });
    }

    const transition = await loadFileManagerDirectory(
      files,
      createFileManagerState({
        grant,
        path: this.#state.path,
      }),
      targetPath,
    );

    this.#state = fromFileManagerState(transition.state);

    if (this.#state.status === "ready") {
      return accept(this.#state);
    }

    return rejectFromState(this.#state, {
      code: "FilesReadFailed",
      message: "Files app directory read failed closed.",
      path: "/files/list",
    });
  }

  #failClosed(path: string, error: AppError): FilesAppResult<FilesAppState> {
    this.#state = freezeFilesAppState({
      entries: EMPTY_ENTRIES,
      error,
      path,
      status: statusForError(error),
    });

    return rejectFromState(this.#state, error);
  }
}

function fromFileManagerState(state: FileManagerState): FilesAppState {
  const status = state.status === "preview" ? "ready" : state.status;
  const input: {
    path: string;
    entries: readonly FilesAppDirectoryEntry[];
    status: FilesAppStatus;
    error?: AppError;
  } = {
    entries: state.entries.map(toDirectoryEntry),
    path: normalizeCapabilityPath(state.path),
    status,
  };

  if (state.error !== undefined) input.error = state.error;

  return freezeFilesAppState(input);
}

function freezeFilesAppState(input: {
  readonly path: string;
  readonly entries: readonly FilesAppDirectoryEntry[];
  readonly status: FilesAppStatus;
  readonly selected?: FilesAppDirectoryEntry;
  readonly error?: AppError;
}): FilesAppState {
  const path = normalizeCapabilityPath(input.path);
  const output: {
    path: string;
    breadcrumbs: readonly FilesAppBreadcrumbSegment[];
    entries: readonly FilesAppDirectoryEntry[];
    status: FilesAppStatus;
    selected?: FilesAppDirectoryEntry;
    error?: AppError;
  } = {
    breadcrumbs: breadcrumbSegments(path),
    entries: Object.freeze(input.entries.map(freezeDirectoryEntry)),
    path,
    status: input.status,
  };

  if (input.selected !== undefined) output.selected = freezeDirectoryEntry(input.selected);
  if (input.error !== undefined) output.error = freezeAppError(input.error);

  return Object.freeze(output);
}

function breadcrumbSegments(path: string): readonly FilesAppBreadcrumbSegment[] {
  const normalized = normalizeCapabilityPath(path);

  if (normalized === "/") {
    return Object.freeze([
      Object.freeze({
        label: "/",
        path: "/",
      }),
    ]);
  }

  const absolute = normalized.startsWith("/");
  const parts = normalized.split("/").filter((part) => part.length > 0);
  const output: FilesAppBreadcrumbSegment[] = [];

  if (absolute) {
    output.push(Object.freeze({
      label: "/",
      path: "/",
    }));
  }

  for (let index = 0; index < parts.length; index += 1) {
    const label = parts[index];

    if (label === undefined) continue;
    output.push(Object.freeze({
      label,
      path: absolute
        ? `/${parts.slice(0, index + 1).join("/")}`
        : parts.slice(0, index + 1).join("/"),
    }));
  }

  return Object.freeze(output);
}

function toDirectoryEntry(entry: FilesEntry): FilesAppDirectoryEntry {
  return freezeDirectoryEntry({
    kind: entry.kind,
    modified: entry.mtime,
    name: entry.name,
    size: entry.size,
  });
}

function freezeDirectoryEntry(entry: FilesAppDirectoryEntry): FilesAppDirectoryEntry {
  return Object.freeze({
    kind: entry.kind,
    modified: entry.modified,
    name: entry.name,
    size: entry.size,
  });
}

function freezeAppError(error: AppError): AppError {
  return Object.freeze({
    code: error.code,
    message: error.message,
    path: error.path,
  });
}

function findEntryByName(
  entries: readonly FilesAppDirectoryEntry[],
  name: string,
): FilesAppDirectoryEntry | undefined {
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];

    if (entry !== undefined && entry.name === name) return entry;
  }

  return undefined;
}

function resolveTargetPath(currentPath: string, path: string): string {
  if (path.length === 0) return currentPath;
  if (path.startsWith("/")) return path;

  return joinCapabilityPath(currentPath, path);
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

function statusForError(error: AppError): Exclude<FilesAppStatus, "idle" | "ready"> {
  if (error.code === "AccessForbidden" || error.code === "MissingFilesGrant") return "forbidden";

  return "error";
}

function rejectFromState<T>(state: FilesAppState, fallback: AppError): FilesAppResult<T> {
  return rejectError(state.error ?? fallback);
}

function accept<T>(value: T): FilesAppResult<T> {
  return Object.freeze({
    ok: true,
    value,
  });
}

function reject<T>(code: string, message: string, path: string): FilesAppResult<T> {
  return rejectError({
    code,
    message,
    path,
  });
}

function rejectError<T>(error: AppError): FilesAppResult<T> {
  return Object.freeze({
    error: freezeAppError(error),
    ok: false,
  });
}
