import {
  createFileManagerState,
  joinCapabilityPath,
  loadFileManagerDirectory,
  parentCapabilityPath,
} from "../../../sdk/typescript/src/desktop-sdk/index.ts";
import type {
  AppError,
  FilesCapabilityPort,
  FilesEntry,
} from "../../../sdk/typescript/src/desktop-sdk/index.ts";

export type FilesViewStatus = "idle" | "ready" | "forbidden" | "error";

export interface FilesBreadcrumbSegment {
  readonly label: string;
  readonly path: string;
}

export interface FilesFavoriteInput {
  readonly id: string;
  readonly label: string;
  readonly path: string;
}

export interface FilesFavorite {
  readonly id: string;
  readonly label: string;
  readonly path: string;
  readonly selected: boolean;
}

export interface FilesViewEntry {
  readonly name: string;
  readonly kind: FilesEntry["kind"];
  readonly size: number;
  readonly modified: string;
}

export interface FilesViewState {
  readonly path: string;
  readonly breadcrumbs: readonly FilesBreadcrumbSegment[];
  readonly favorites: readonly FilesFavorite[];
  readonly entries: readonly FilesViewEntry[];
  readonly status: FilesViewStatus;
  readonly selected?: FilesViewEntry;
  readonly error?: AppError;
}

export interface FilesViewModelInput {
  readonly files?: FilesCapabilityPort;
  readonly grant?: string;
  readonly initialPath?: string;
  readonly favorites?: readonly FilesFavoriteInput[];
}

export interface FilesViewModel {
  readonly state: FilesViewState;
  navigate(path: string): Promise<FilesViewState>;
  up(): Promise<FilesViewState>;
  openFavorite(id: string): Promise<FilesViewState>;
  select(entry: FilesViewEntry | string): FilesViewState;
  refresh(): Promise<FilesViewState>;
}

export const DEFAULT_FILES_FAVORITES: readonly FilesFavoriteInput[] = Object.freeze([
  Object.freeze({
    id: "home",
    label: "Home",
    path: "/",
  }),
  Object.freeze({
    id: "src",
    label: "src",
    path: "/src",
  }),
  Object.freeze({
    id: "apps",
    label: "apps",
    path: "/apps",
  }),
  Object.freeze({
    id: "recents",
    label: "Recents",
    path: "/recents",
  }),
]);

const EMPTY_ENTRIES: readonly FilesViewEntry[] = Object.freeze([]);

export function createFilesViewModel(input: FilesViewModelInput): FilesViewModel {
  const favorites = freezeFavoriteInputs(input.favorites ?? DEFAULT_FILES_FAVORITES);
  const files = input.files;
  const grant = input.grant;
  let state = freezeFilesViewState({
    entries: EMPTY_ENTRIES,
    favorites,
    path: normalizeCapabilityPath(input.initialPath ?? "/"),
    status: "idle",
  });

  async function readDirectory(path: string): Promise<FilesViewState> {
    const targetPath = normalizeCapabilityPath(path);

    if (grant === undefined || grant.length === 0) {
      state = failClosedState(favorites, targetPath, {
        code: "MissingFilesGrant",
        message: "files view-model requires an injected files grant.",
        path: "/grant",
      }, "forbidden");
      return state;
    }

    if (files === undefined) {
      state = failClosedState(favorites, targetPath, {
        code: "MissingFilesPort",
        message: "files view-model requires an injected files capability port.",
        path: "/files",
      }, "error");
      return state;
    }

    const listed = await loadFileManagerDirectory(
      files,
      createFileManagerState({
        grant,
        path: state.path,
      }),
      targetPath,
    );

    state = fromSdkFileManagerState(listed.state, favorites);
    return state;
  }

  return Object.freeze({
    get state() {
      return state;
    },
    navigate(path: string) {
      return readDirectory(resolveTargetPath(state.path, path));
    },
    openFavorite(id: string) {
      const favorite = findFavorite(favorites, id);

      if (favorite === undefined) {
        const nextState: {
          entries: readonly FilesViewEntry[];
          error: AppError;
          favorites: readonly FilesFavoriteInput[];
          path: string;
          selected?: FilesViewEntry;
          status: "error";
        } = {
          entries: state.entries,
          error: {
            code: "UnknownFavorite",
            message: `favorite '${id}' is not available.`,
            path: "/favorites",
          },
          favorites,
          path: state.path,
          status: "error",
        };

        if (state.selected !== undefined) nextState.selected = state.selected;

        state = freezeFilesViewState(nextState);
        return Promise.resolve(state);
      }

      return readDirectory(favorite.path);
    },
    refresh() {
      return readDirectory(state.path);
    },
    select(entry: FilesViewEntry | string) {
      const selected = typeof entry === "string"
        ? findEntryByName(state.entries, entry)
        : findEntryByName(state.entries, entry.name);

      if (selected === undefined) return state;

      state = freezeFilesViewState({
        entries: state.entries,
        favorites,
        path: state.path,
        selected,
        status: state.status,
      });
      return state;
    },
    up() {
      return readDirectory(normalizeCapabilityPath(parentCapabilityPath(state.path)));
    },
  });
}

function fromSdkFileManagerState(
  sdkState: ReturnType<typeof createFileManagerState>,
  favorites: readonly FilesFavoriteInput[],
): FilesViewState {
  const status = sdkState.status === "preview" ? "ready" : sdkState.status;
  const input: {
    readonly path: string;
    readonly favorites: readonly FilesFavoriteInput[];
    readonly entries: readonly FilesViewEntry[];
    readonly status: FilesViewStatus;
    readonly error?: AppError;
  } = {
    entries: sdkState.entries.map(toViewEntry),
    favorites,
    path: normalizeCapabilityPath(sdkState.path),
    status,
  };

  if (sdkState.error !== undefined) {
    return freezeFilesViewState({
      ...input,
      error: sdkState.error,
    });
  }

  return freezeFilesViewState(input);
}

function failClosedState(
  favorites: readonly FilesFavoriteInput[],
  path: string,
  error: AppError,
  status: Exclude<FilesViewStatus, "idle" | "ready">,
): FilesViewState {
  return freezeFilesViewState({
    entries: EMPTY_ENTRIES,
    error,
    favorites,
    path,
    status,
  });
}

function freezeFilesViewState(input: {
  readonly path: string;
  readonly favorites: readonly FilesFavoriteInput[];
  readonly entries: readonly FilesViewEntry[];
  readonly status: FilesViewStatus;
  readonly selected?: FilesViewEntry;
  readonly error?: AppError;
}): FilesViewState {
  const path = normalizeCapabilityPath(input.path);
  const output: {
    path: string;
    breadcrumbs: readonly FilesBreadcrumbSegment[];
    favorites: readonly FilesFavorite[];
    entries: readonly FilesViewEntry[];
    status: FilesViewStatus;
    selected?: FilesViewEntry;
    error?: AppError;
  } = {
    breadcrumbs: breadcrumbSegments(path),
    entries: Object.freeze(input.entries.map(freezeViewEntry)),
    favorites: favoriteViews(input.favorites, path),
    path,
    status: input.status,
  };

  if (input.selected !== undefined) output.selected = freezeViewEntry(input.selected);
  if (input.error !== undefined) output.error = freezeAppError(input.error);

  return Object.freeze(output);
}

function freezeFavoriteInputs(favorites: readonly FilesFavoriteInput[]): readonly FilesFavoriteInput[] {
  const output: FilesFavoriteInput[] = [];

  for (let index = 0; index < favorites.length; index += 1) {
    const favorite = favorites[index];

    if (favorite === undefined) continue;
    output.push(Object.freeze({
      id: favorite.id,
      label: favorite.label,
      path: normalizeCapabilityPath(favorite.path),
    }));
  }

  return Object.freeze(output);
}

function favoriteViews(
  favorites: readonly FilesFavoriteInput[],
  currentPath: string,
): readonly FilesFavorite[] {
  const output: FilesFavorite[] = [];

  for (let index = 0; index < favorites.length; index += 1) {
    const favorite = favorites[index];

    if (favorite === undefined) continue;
    output.push(Object.freeze({
      id: favorite.id,
      label: favorite.label,
      path: favorite.path,
      selected: favorite.path === currentPath,
    }));
  }

  return Object.freeze(output);
}

function breadcrumbSegments(path: string): readonly FilesBreadcrumbSegment[] {
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
  const output: FilesBreadcrumbSegment[] = [];

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

function toViewEntry(entry: FilesEntry): FilesViewEntry {
  return freezeViewEntry({
    kind: entry.kind,
    modified: entry.mtime,
    name: entry.name,
    size: entry.size,
  });
}

function freezeViewEntry(entry: FilesViewEntry): FilesViewEntry {
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

function findFavorite(
  favorites: readonly FilesFavoriteInput[],
  id: string,
): FilesFavoriteInput | undefined {
  for (let index = 0; index < favorites.length; index += 1) {
    const favorite = favorites[index];

    if (favorite !== undefined && favorite.id === id) return favorite;
  }

  return undefined;
}

function findEntryByName(
  entries: readonly FilesViewEntry[],
  name: string,
): FilesViewEntry | undefined {
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
