import {
  joinCapabilityPath,
  parentCapabilityPath,
} from "../../../sdk/typescript/src/desktop-sdk/index.ts";
import type {
  AppError,
  FilesEntry,
  FilesErrorResponse,
  FilesRequest,
  FilesResponse,
} from "../../../sdk/typescript/src/desktop-sdk/index.ts";

export type FilesOpsStatus = "idle" | "busy" | "ready" | "forbidden" | "error";
export type FilesClipboardMode = "copy" | "cut";
export type FilesOpsMutationOperation = "rename" | "move" | "copy" | "trash" | "restore" | "mkdir";
export type FilesOpsPendingKind =
  | "rename"
  | "move"
  | "paste"
  | "trash"
  | "restore"
  | "new-folder"
  | "duplicate";

export interface FilesOpsTarget {
  readonly path: string;
  readonly kind?: FilesEntry["kind"];
}

export interface FilesClipboard {
  readonly mode: FilesClipboardMode | null;
  readonly targets: readonly FilesOpsTarget[];
}

export interface FilesPendingOperation {
  readonly id: string;
  readonly kind: FilesOpsPendingKind;
  readonly sources: readonly string[];
  readonly destination?: string;
  readonly name?: string;
  readonly mode?: FilesClipboardMode;
}

export interface FilesTrashItem {
  readonly id: string;
  readonly originalPath: string;
  readonly trashPath: string;
  readonly name: string;
  readonly kind?: FilesEntry["kind"];
}

export type FilesOpsMutationRequest =
  | {
      readonly op: "rename";
      readonly grant: string;
      readonly path: string;
      readonly newPath: string;
    }
  | {
      readonly op: "move";
      readonly grant: string;
      readonly path: string;
      readonly newPath: string;
    }
  | {
      readonly op: "copy";
      readonly grant: string;
      readonly path: string;
      readonly newPath: string;
    }
  | {
      readonly op: "trash";
      readonly grant: string;
      readonly path: string;
      readonly newPath: string;
    }
  | {
      readonly op: "restore";
      readonly grant: string;
      readonly path: string;
      readonly newPath: string;
    }
  | {
      readonly op: "mkdir";
      readonly grant: string;
      readonly path: string;
    };

export type FilesOpsRequest = FilesRequest | FilesOpsMutationRequest;
export type FilesOpsResponse = FilesResponse;

export interface FilesOpsCapabilityPort {
  request(
    request: FilesOpsRequest,
  ): FilesOpsResponse | FilesErrorResponse | Promise<FilesOpsResponse | FilesErrorResponse>;
}

export interface FilesOpsState {
  readonly status: FilesOpsStatus;
  readonly clipboard: FilesClipboard;
  readonly pendingOps: readonly FilesPendingOperation[];
  readonly trash: readonly FilesTrashItem[];
  readonly error?: AppError;
}

export interface FilesOpsViewModelInput {
  readonly files?: FilesOpsCapabilityPort;
  readonly grant?: string;
  readonly trashPath?: string;
}

export interface FilesOpsViewModel {
  readonly state: FilesOpsState;
  copy(entries: readonly FilesOpsTarget[]): FilesOpsState;
  cut(entries: readonly FilesOpsTarget[]): FilesOpsState;
  paste(destination: string): Promise<FilesOpsState>;
  rename(entry: FilesOpsTarget, name: string): Promise<FilesOpsState>;
  move(entries: readonly FilesOpsTarget[], destination: string): Promise<FilesOpsState>;
  trash(entries: readonly FilesOpsTarget[]): Promise<FilesOpsState>;
  restoreFromTrash(ids: readonly string[]): Promise<FilesOpsState>;
  newFolder(destination: string, name: string): Promise<FilesOpsState>;
  duplicate(entry: FilesOpsTarget): Promise<FilesOpsState>;
  clearClipboard(): FilesOpsState;
}

const EMPTY_TARGETS: readonly FilesOpsTarget[] = Object.freeze([]);
const EMPTY_PENDING: readonly FilesPendingOperation[] = Object.freeze([]);
const EMPTY_TRASH: readonly FilesTrashItem[] = Object.freeze([]);
const DEFAULT_TRASH_PATH = "/.trash";
const ACCESSOR_FIELD = Symbol("accessor-field");

export function createFilesOpsViewModel(input: FilesOpsViewModelInput): FilesOpsViewModel {
  const files = input.files;
  const grant = input.grant;
  const trashRoot = normalizeCapabilityPath(input.trashPath ?? DEFAULT_TRASH_PATH);
  let pendingSequence = 0;
  let trashSequence = 0;
  let state = freezeFilesOpsState({
    clipboard: emptyClipboard(),
    pendingOps: EMPTY_PENDING,
    status: "idle",
    trash: EMPTY_TRASH,
  });

  function setFailure(error: AppError): FilesOpsState {
    state = freezeFilesOpsState({
      clipboard: state.clipboard,
      error,
      pendingOps: EMPTY_PENDING,
      status: statusForError(error),
      trash: state.trash,
    });
    return state;
  }

  function requireFiles(path: string): FilesOpsCapabilityPort | undefined {
    if (grant === undefined || grant.length === 0) {
      setFailure({
        code: "MissingFilesGrant",
        message: "files operations require an injected files grant.",
        path,
      });
      return undefined;
    }

    if (files === undefined) {
      setFailure({
        code: "MissingFilesPort",
        message: "files operations require an injected files capability port.",
        path,
      });
      return undefined;
    }

    return files;
  }

  async function listNames(port: FilesOpsCapabilityPort, path: string): Promise<FilesOpsResult<Set<string>>> {
    const response = await callFilesPort(port, freezeFilesRequest({
      grant: grant ?? "",
      op: "list",
      path,
    }), "/files/list");

    if (!response.ok) return response;

    const entries = response.value.entries;

    if (entries === undefined) {
      return reject("MALFORMED_FILES_RESPONSE", "list response did not include entries.", "/files/list/entries");
    }

    const names = new Set<string>();

    for (let index = 0; index < entries.length; index += 1) {
      const entry = entries[index];

      if (entry !== undefined) names.add(entry.name);
    }

    return accept(names);
  }

  async function runPending(
    inputPending: Omit<FilesPendingOperation, "id">,
    operation: (port: FilesOpsCapabilityPort) => Promise<FilesOpsState>,
  ): Promise<FilesOpsState> {
    const port = requireFiles("/files");

    if (port === undefined) return state;

    pendingSequence += 1;
    const pending = freezePendingOperation({
      ...inputPending,
      id: `pending:${pendingSequence}`,
    });

    state = freezeFilesOpsState({
      clipboard: state.clipboard,
      pendingOps: appendPending(state.pendingOps, pending),
      status: "busy",
      trash: state.trash,
    });

    return operation(port);
  }

  async function finishOperation(next: FilesOpsState): Promise<FilesOpsState> {
    const nextInput: {
      clipboard: FilesClipboard;
      pendingOps: readonly FilesPendingOperation[];
      status: FilesOpsStatus;
      trash: readonly FilesTrashItem[];
      error?: AppError;
    } = {
      clipboard: next.clipboard,
      pendingOps: EMPTY_PENDING,
      status: next.status,
      trash: next.trash,
    };

    if (next.error !== undefined) nextInput.error = next.error;

    state = freezeFilesOpsState(nextInput);
    return state;
  }

  async function mutate(port: FilesOpsCapabilityPort, request: FilesOpsMutationRequest): Promise<FilesOpsResult<true>> {
    const response = await callFilesPort(port, freezeFilesOpsRequest(request), `/files/${request.op}`);

    if (!response.ok) return response;

    return accept(true);
  }

  function applyClipboard(mode: FilesClipboardMode, entries: readonly FilesOpsTarget[]): FilesOpsState {
    if (requireFiles("/files") === undefined) return state;

    const targets = normalizeTargets(entries);

    if (!targets.ok) return setFailure(targets.error);

    state = freezeFilesOpsState({
      clipboard: {
        mode,
        targets: targets.value,
      },
      pendingOps: EMPTY_PENDING,
      status: "ready",
      trash: state.trash,
    });
    return state;
  }

  return Object.freeze({
    get state() {
      return state;
    },
    clearClipboard() {
      state = freezeFilesOpsState({
        clipboard: emptyClipboard(),
        pendingOps: state.pendingOps,
        status: state.status,
        trash: state.trash,
      });
      return state;
    },
    copy(entries: readonly FilesOpsTarget[]) {
      return applyClipboard("copy", entries);
    },
    cut(entries: readonly FilesOpsTarget[]) {
      return applyClipboard("cut", entries);
    },
    async duplicate(entry: FilesOpsTarget) {
      const target = normalizeTarget(entry);

      if (!target.ok) return setFailure(target.error);

      return runPending({
        kind: "duplicate",
        sources: Object.freeze([target.value.path]),
      }, async (port) => {
        const parent = parentCapabilityPath(target.value.path);
        const sourceName = basename(target.value.path);
        const listed = await listNames(port, parent);

        if (!listed.ok) return finishOperation(failureState(state, listed.error));

        const nextName = allocateCollisionName(sourceName, listed.value);
        const newPath = joinCapabilityPath(parent, nextName);
        const copied = await mutate(port, {
          grant: grant ?? "",
          newPath,
          op: "copy",
          path: target.value.path,
        });

        if (!copied.ok) return finishOperation(failureState(state, copied.error));

        return finishOperation(successState(state));
      });
    },
    async move(entries: readonly FilesOpsTarget[], destination: string) {
      const targets = normalizeTargets(entries);

      if (!targets.ok) return setFailure(targets.error);

      const dest = normalizeDestination(destination);

      if (!dest.ok) return setFailure(dest.error);

      return runPending({
        destination: dest.value,
        kind: "move",
        sources: targetPaths(targets.value),
      }, async (port) => {
        const moved = await moveTargets(port, targets.value, dest.value, "move", grant ?? "");

        if (!moved.ok) return finishOperation(failureState(state, moved.error));

        return finishOperation(successState(state));
      });
    },
    async newFolder(destination: string, name: string) {
      const dest = normalizeDestination(destination);

      if (!dest.ok) return setFailure(dest.error);

      const folderName = normalizeEntryName(name, "/name");

      if (!folderName.ok) return setFailure(folderName.error);

      return runPending({
        destination: dest.value,
        kind: "new-folder",
        name: folderName.value,
        sources: EMPTY_TARGETS.map((target) => target.path),
      }, async (port) => {
        const listed = await listNames(port, dest.value);

        if (!listed.ok) return finishOperation(failureState(state, listed.error));

        const nextName = allocateCollisionName(folderName.value, listed.value);
        const created = await mutate(port, {
          grant: grant ?? "",
          op: "mkdir",
          path: joinCapabilityPath(dest.value, nextName),
        });

        if (!created.ok) return finishOperation(failureState(state, created.error));

        return finishOperation(successState(state));
      });
    },
    async paste(destination: string) {
      const clipboard = state.clipboard;

      if (clipboard.mode === null || clipboard.targets.length === 0) {
        return setFailure({
          code: "EmptyClipboard",
          message: "files clipboard does not contain any targets.",
          path: "/clipboard",
        });
      }

      const dest = normalizeDestination(destination);

      if (!dest.ok) return setFailure(dest.error);

      return runPending({
        destination: dest.value,
        kind: "paste",
        mode: clipboard.mode,
        sources: targetPaths(clipboard.targets),
      }, async (port) => {
        const op = clipboard.mode === "cut" ? "move" : "copy";
        const moved = await moveTargets(port, clipboard.targets, dest.value, op, grant ?? "");

        if (!moved.ok) return finishOperation(failureState(state, moved.error));

        const nextState = clipboard.mode === "cut"
          ? successStateWithClipboard(state, emptyClipboard())
          : successState(state);

        return finishOperation(nextState);
      });
    },
    async rename(entry: FilesOpsTarget, name: string) {
      const target = normalizeTarget(entry);

      if (!target.ok) return setFailure(target.error);

      const entryName = normalizeEntryName(name, "/name");

      if (!entryName.ok) return setFailure(entryName.error);

      return runPending({
        kind: "rename",
        name: entryName.value,
        sources: Object.freeze([target.value.path]),
      }, async (port) => {
        const parent = parentCapabilityPath(target.value.path);
        const existing = await listNames(port, parent);

        if (!existing.ok) return finishOperation(failureState(state, existing.error));

        existing.value.delete(basename(target.value.path));
        const nextName = allocateCollisionName(entryName.value, existing.value);
        const newPath = joinCapabilityPath(parent, nextName);

        if (newPath === target.value.path) return finishOperation(successState(state));

        const renamed = await mutate(port, {
          grant: grant ?? "",
          newPath,
          op: "rename",
          path: target.value.path,
        });

        if (!renamed.ok) return finishOperation(failureState(state, renamed.error));

        return finishOperation(successState(state));
      });
    },
    async restoreFromTrash(ids: readonly string[]) {
      const selected = trashItemsForIds(state.trash, ids);

      if (!selected.ok) return setFailure(selected.error);

      return runPending({
        kind: "restore",
        sources: selected.value.map((item) => item.trashPath),
      }, async (port) => {
        const restoredIds = new Set<string>();

        for (let index = 0; index < selected.value.length; index += 1) {
          const item = selected.value[index];

          if (item === undefined) continue;

          const parent = parentCapabilityPath(item.originalPath);
          const listed = await listNames(port, parent);

          if (!listed.ok) return finishOperation(failureState(state, listed.error));

          const nextName = allocateCollisionName(basename(item.originalPath), listed.value);
          const restored = await mutate(port, {
            grant: grant ?? "",
            newPath: joinCapabilityPath(parent, nextName),
            op: "restore",
            path: item.trashPath,
          });

          if (!restored.ok) return finishOperation(failureState(state, restored.error));

          restoredIds.add(item.id);
        }

        return finishOperation(successStateWithTrash(state, removeTrashItems(state.trash, restoredIds)));
      });
    },
    async trash(entries: readonly FilesOpsTarget[]) {
      const targets = normalizeTargets(entries);

      if (!targets.ok) return setFailure(targets.error);

      return runPending({
        kind: "trash",
        sources: targetPaths(targets.value),
      }, async (port) => {
        const listed = await listNames(port, trashRoot);

        if (!listed.ok) return finishOperation(failureState(state, listed.error));

        for (let index = 0; index < state.trash.length; index += 1) {
          const item = state.trash[index];

          if (item !== undefined) listed.value.add(basename(item.trashPath));
        }

        const trashedItems: FilesTrashItem[] = [];

        for (let index = 0; index < targets.value.length; index += 1) {
          const target = targets.value[index];

          if (target === undefined) continue;

          const trashName = allocateCollisionName(basename(target.path), listed.value);
          const trashPath = joinCapabilityPath(trashRoot, trashName);
          const trashed = await mutate(port, {
            grant: grant ?? "",
            newPath: trashPath,
            op: "trash",
            path: target.path,
          });

          if (!trashed.ok) return finishOperation(failureState(state, trashed.error));

          listed.value.add(trashName);
          trashSequence += 1;
          const itemInput: {
            id: string;
            originalPath: string;
            trashPath: string;
            name: string;
            kind?: FilesEntry["kind"];
          } = {
            id: `trash:${trashSequence}`,
            name: basename(target.path),
            originalPath: target.path,
            trashPath,
          };

          if (target.kind !== undefined) itemInput.kind = target.kind;

          trashedItems.push(freezeTrashItem(itemInput));
        }

        return finishOperation(successStateWithTrash(state, appendTrashItems(state.trash, trashedItems)));
      });
    },
  });
}

type FilesOpsResult<T> =
  | {
      readonly ok: true;
      readonly value: T;
    }
  | {
      readonly ok: false;
      readonly error: AppError;
    };

function moveTargets(
  port: FilesOpsCapabilityPort,
  targets: readonly FilesOpsTarget[],
  destination: string,
  op: "copy" | "move",
  grant: string,
): Promise<FilesOpsResult<true>> {
  return moveTargetsOrdered(port, targets, destination, op, grant);
}

async function moveTargetsOrdered(
  port: FilesOpsCapabilityPort,
  targets: readonly FilesOpsTarget[],
  destination: string,
  op: "copy" | "move",
  grant: string,
): Promise<FilesOpsResult<true>> {
  const listed = await callListNamesForMove(port, destination, grant);

  if (!listed.ok) return listed;

  const reserved = listed.value;

  for (let index = 0; index < targets.length; index += 1) {
    const target = targets[index];

    if (target === undefined) continue;

    const sourceName = basename(target.path);

    if (op === "move" && parentCapabilityPath(target.path) === destination) {
      reserved.delete(sourceName);
    }

    const nextName = allocateCollisionName(sourceName, reserved);
    const newPath = joinCapabilityPath(destination, nextName);

    if (op === "move" && newPath === target.path) {
      reserved.add(nextName);
      continue;
    }

    const moved = await mutateWithRequest(port, {
      grant,
      newPath,
      op,
      path: target.path,
    });

    if (!moved.ok) return moved;

    reserved.add(nextName);
  }

  return accept(true);
}

async function callListNamesForMove(
  port: FilesOpsCapabilityPort,
  destination: string,
  grant: string,
): Promise<FilesOpsResult<Set<string>>> {
  const response = await callFilesPort(port, freezeFilesRequest({
    grant,
    op: "list",
    path: destination,
  }), "/files/list");

  if (!response.ok) return response;

  const entries = response.value.entries;

  if (entries === undefined) {
    return reject("MALFORMED_FILES_RESPONSE", "list response did not include entries.", "/files/list/entries");
  }

  const names = new Set<string>();

  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];

    if (entry !== undefined) names.add(entry.name);
  }

  return accept(names);
}

async function mutateWithRequest(
  port: FilesOpsCapabilityPort,
  request: FilesOpsMutationRequest,
): Promise<FilesOpsResult<true>> {
  const response = await callFilesPort(port, freezeFilesOpsRequest(request), `/files/${request.op}`);

  if (!response.ok) return response;

  return accept(true);
}

function normalizeTargets(entries: readonly FilesOpsTarget[]): FilesOpsResult<readonly FilesOpsTarget[]> {
  if (!Array.isArray(entries)) {
    return reject("InvalidFilesTarget", "files operation targets must be an array.", "/targets");
  }

  const output: FilesOpsTarget[] = [];
  const seen = new Set<string>();

  for (let index = 0; index < entries.length; index += 1) {
    const normalized = normalizeTarget(entries[index]);

    if (!normalized.ok) return normalized;
    if (seen.has(normalized.value.path)) continue;
    seen.add(normalized.value.path);
    output.push(normalized.value);
  }

  if (output.length === 0) {
    return reject("EmptyFilesTargets", "files operation requires at least one target.", "/targets");
  }

  return accept(Object.freeze(output));
}

function normalizeTarget(entry: FilesOpsTarget | undefined): FilesOpsResult<FilesOpsTarget> {
  if (entry === undefined || entry === null || typeof entry !== "object" || Array.isArray(entry)) {
    return reject("InvalidFilesTarget", "files operation target must be an object.", "/target");
  }

  const path = entry.path;

  if (typeof path !== "string" || path.length === 0) {
    return reject("InvalidFilesPath", "files operation target path must be a non-empty string.", "/target/path");
  }

  const kind = entry.kind;

  if (kind !== undefined && kind !== "dir" && kind !== "file" && kind !== "symlink-skipped") {
    return reject("InvalidFilesKind", "files operation target kind is not supported.", "/target/kind");
  }

  const targetInput: {
    path: string;
    kind?: FilesEntry["kind"];
  } = {
    path: normalizeCapabilityPath(path),
  };

  if (kind !== undefined) targetInput.kind = kind;

  return accept(freezeTarget(targetInput));
}

function normalizeDestination(destination: string): FilesOpsResult<string> {
  if (typeof destination !== "string" || destination.length === 0) {
    return reject("InvalidFilesPath", "files operation destination must be a non-empty string.", "/destination");
  }

  return accept(normalizeCapabilityPath(destination));
}

function normalizeEntryName(name: string, path: string): FilesOpsResult<string> {
  if (typeof name !== "string" || name.length === 0 || name === "." || name === "..") {
    return reject("InvalidFilesName", "files operation name must be a valid entry name.", path);
  }
  if (name.includes("/") || name.includes("\\")) {
    return reject("InvalidFilesName", "files operation name must not contain path separators.", path);
  }

  return accept(name);
}

function trashItemsForIds(
  trash: readonly FilesTrashItem[],
  ids: readonly string[],
): FilesOpsResult<readonly FilesTrashItem[]> {
  if (!Array.isArray(ids)) {
    return reject("InvalidTrashSelection", "trash restore ids must be an array.", "/trash/ids");
  }

  const selected: FilesTrashItem[] = [];
  const seen = new Set<string>();

  for (let idIndex = 0; idIndex < ids.length; idIndex += 1) {
    const id = ids[idIndex];

    if (typeof id !== "string" || id.length === 0) {
      return reject("InvalidTrashSelection", "trash restore id must be a non-empty string.", "/trash/ids");
    }
    if (seen.has(id)) continue;
    seen.add(id);

    const item = findTrashItem(trash, id);

    if (item === undefined) {
      return reject("UnknownTrashItem", `trash item '${id}' is not available.`, "/trash/ids");
    }

    selected.push(item);
  }

  if (selected.length === 0) {
    return reject("InvalidTrashSelection", "trash restore requires at least one id.", "/trash/ids");
  }

  return accept(Object.freeze(selected));
}

function findTrashItem(trash: readonly FilesTrashItem[], id: string): FilesTrashItem | undefined {
  for (let index = 0; index < trash.length; index += 1) {
    const item = trash[index];

    if (item !== undefined && item.id === id) return item;
  }

  return undefined;
}

function targetPaths(targets: readonly FilesOpsTarget[]): readonly string[] {
  const paths: string[] = [];

  for (let index = 0; index < targets.length; index += 1) {
    const target = targets[index];

    if (target !== undefined) paths.push(target.path);
  }

  return Object.freeze(paths);
}

function appendPending(
  pendingOps: readonly FilesPendingOperation[],
  pending: FilesPendingOperation,
): readonly FilesPendingOperation[] {
  return Object.freeze([
    ...pendingOps,
    pending,
  ]);
}

function appendTrashItems(
  trash: readonly FilesTrashItem[],
  items: readonly FilesTrashItem[],
): readonly FilesTrashItem[] {
  return Object.freeze([
    ...trash,
    ...items,
  ]);
}

function removeTrashItems(
  trash: readonly FilesTrashItem[],
  restoredIds: ReadonlySet<string>,
): readonly FilesTrashItem[] {
  const output: FilesTrashItem[] = [];

  for (let index = 0; index < trash.length; index += 1) {
    const item = trash[index];

    if (item !== undefined && !restoredIds.has(item.id)) output.push(item);
  }

  return Object.freeze(output);
}

function successState(state: FilesOpsState): FilesOpsState {
  return freezeFilesOpsState({
    clipboard: state.clipboard,
    pendingOps: EMPTY_PENDING,
    status: "ready",
    trash: state.trash,
  });
}

function successStateWithClipboard(state: FilesOpsState, clipboard: FilesClipboard): FilesOpsState {
  return freezeFilesOpsState({
    clipboard,
    pendingOps: EMPTY_PENDING,
    status: "ready",
    trash: state.trash,
  });
}

function successStateWithTrash(state: FilesOpsState, trash: readonly FilesTrashItem[]): FilesOpsState {
  return freezeFilesOpsState({
    clipboard: state.clipboard,
    pendingOps: EMPTY_PENDING,
    status: "ready",
    trash,
  });
}

function failureState(state: FilesOpsState, error: AppError): FilesOpsState {
  return freezeFilesOpsState({
    clipboard: state.clipboard,
    error,
    pendingOps: EMPTY_PENDING,
    status: statusForError(error),
    trash: state.trash,
  });
}

function statusForError(error: AppError): Exclude<FilesOpsStatus, "idle" | "busy" | "ready"> {
  if (error.code === "AccessForbidden" || error.code === "MissingFilesGrant") return "forbidden";

  return "error";
}

function emptyClipboard(): FilesClipboard {
  return Object.freeze({
    mode: null,
    targets: EMPTY_TARGETS,
  });
}

function freezeFilesOpsState(input: {
  readonly status: FilesOpsStatus;
  readonly clipboard: FilesClipboard;
  readonly pendingOps: readonly FilesPendingOperation[];
  readonly trash: readonly FilesTrashItem[];
  readonly error?: AppError;
}): FilesOpsState {
  const output: {
    status: FilesOpsStatus;
    clipboard: FilesClipboard;
    pendingOps: readonly FilesPendingOperation[];
    trash: readonly FilesTrashItem[];
    error?: AppError;
  } = {
    clipboard: freezeClipboard(input.clipboard),
    pendingOps: Object.freeze(input.pendingOps.map(freezePendingOperation)),
    status: input.status,
    trash: Object.freeze(input.trash.map(freezeTrashItem)),
  };

  if (input.error !== undefined) output.error = freezeAppError(input.error);

  return Object.freeze(output);
}

function freezeClipboard(input: FilesClipboard): FilesClipboard {
  return Object.freeze({
    mode: input.mode,
    targets: Object.freeze(input.targets.map(freezeTarget)),
  });
}

function freezeTarget(input: FilesOpsTarget): FilesOpsTarget {
  const output: {
    path: string;
    kind?: FilesEntry["kind"];
  } = {
    path: normalizeCapabilityPath(input.path),
  };

  if (input.kind !== undefined) output.kind = input.kind;

  return Object.freeze(output);
}

function freezePendingOperation(input: FilesPendingOperation): FilesPendingOperation {
  const output: {
    id: string;
    kind: FilesOpsPendingKind;
    sources: readonly string[];
    destination?: string;
    name?: string;
    mode?: FilesClipboardMode;
  } = {
    id: input.id,
    kind: input.kind,
    sources: Object.freeze(input.sources.map(normalizeCapabilityPath)),
  };

  if (input.destination !== undefined) output.destination = normalizeCapabilityPath(input.destination);
  if (input.name !== undefined) output.name = input.name;
  if (input.mode !== undefined) output.mode = input.mode;

  return Object.freeze(output);
}

function freezeTrashItem(input: FilesTrashItem): FilesTrashItem {
  const output: {
    id: string;
    originalPath: string;
    trashPath: string;
    name: string;
    kind?: FilesEntry["kind"];
  } = {
    id: input.id,
    name: input.name,
    originalPath: normalizeCapabilityPath(input.originalPath),
    trashPath: normalizeCapabilityPath(input.trashPath),
  };

  if (input.kind !== undefined) output.kind = input.kind;

  return Object.freeze(output);
}

function freezeAppError(error: AppError): AppError {
  return Object.freeze({
    code: error.code,
    message: error.message,
    path: error.path,
  });
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

function freezeFilesOpsRequest(request: FilesOpsMutationRequest): FilesOpsMutationRequest {
  if (request.op === "mkdir") {
    return Object.freeze({
      grant: request.grant,
      op: request.op,
      path: normalizeCapabilityPath(request.path),
    });
  }

  return Object.freeze({
    grant: request.grant,
    newPath: normalizeCapabilityPath(request.newPath),
    op: request.op,
    path: normalizeCapabilityPath(request.path),
  });
}

async function callFilesPort(
  port: FilesOpsCapabilityPort,
  request: FilesOpsRequest,
  path: string,
): Promise<FilesOpsResult<FilesOpsResponse>> {
  let raw: unknown;

  try {
    raw = await port.request(request);
  } catch {
    return reject("FILES_PORT_FAILED", "files capability port failed closed.", path);
  }

  return normalizeFilesPortResponse(raw, path);
}

function normalizeFilesPortResponse(raw: unknown, path: string): FilesOpsResult<FilesOpsResponse> {
  const response = safeRecord(raw);

  if (!response.ok) return reject("MALFORMED_FILES_RESPONSE", response.error.message, path);

  const error = safeField(response.value, "error");

  if (error === ACCESSOR_FIELD) {
    return reject("MALFORMED_FILES_RESPONSE", "files error must be a data field.", `${path}/error`);
  }
  if (error !== undefined) return normalizeFilesError(error, `${path}/error`);

  return normalizeFilesSuccess(response.value, path);
}

function normalizeFilesError(raw: unknown, path: string): FilesOpsResult<FilesOpsResponse> {
  const error = safeRecord(raw);

  if (!error.ok) return reject("MALFORMED_FILES_RESPONSE", "files error must be an object.", path);

  const code = safeField(error.value, "code");
  const message = safeField(error.value, "message");

  if (code === ACCESSOR_FIELD || message === ACCESSOR_FIELD) {
    return reject("MALFORMED_FILES_RESPONSE", "files error fields must be data fields.", path);
  }
  if (typeof code !== "string" || code.length === 0 || typeof message !== "string") {
    return reject("MALFORMED_FILES_RESPONSE", "files error must include code and message.", path);
  }

  return reject(code, message, path);
}

function normalizeFilesSuccess(response: Readonly<Record<string, unknown>>, path: string): FilesOpsResult<FilesResponse> {
  const entriesValue = safeField(response, "entries");
  const dataValue = safeField(response, "data");
  const kindValue = safeField(response, "kind");
  const sizeValue = safeField(response, "size");
  const mtimeValue = safeField(response, "mtime");
  const output: {
    entries?: readonly FilesEntry[];
    data?: string;
    kind?: FilesEntry["kind"];
    size?: number;
    mtime?: string;
  } = {};

  if (
    entriesValue === ACCESSOR_FIELD ||
    dataValue === ACCESSOR_FIELD ||
    kindValue === ACCESSOR_FIELD ||
    sizeValue === ACCESSOR_FIELD ||
    mtimeValue === ACCESSOR_FIELD
  ) {
    return reject("MALFORMED_FILES_RESPONSE", "files response fields must be data fields.", path);
  }

  if (entriesValue !== undefined) {
    const entries = normalizeFilesEntries(entriesValue, `${path}/entries`);

    if (!entries.ok) return entries;
    output.entries = entries.value;
  }
  if (dataValue !== undefined) {
    if (typeof dataValue !== "string") {
      return reject("MALFORMED_FILES_RESPONSE", "files data must be a string.", `${path}/data`);
    }
    output.data = dataValue;
  }
  if (kindValue !== undefined) {
    if (!isFilesEntryKind(kindValue)) {
      return reject("MALFORMED_FILES_RESPONSE", "files kind is not supported.", `${path}/kind`);
    }
    output.kind = kindValue;
  }
  if (sizeValue !== undefined) {
    if (!isNonNegativeInteger(sizeValue)) {
      return reject("MALFORMED_FILES_RESPONSE", "files size must be a non-negative integer.", `${path}/size`);
    }
    output.size = sizeValue;
  }
  if (mtimeValue !== undefined) {
    if (typeof mtimeValue !== "string") {
      return reject("MALFORMED_FILES_RESPONSE", "files mtime must be a string.", `${path}/mtime`);
    }
    output.mtime = mtimeValue;
  }

  return accept(Object.freeze(output));
}

function normalizeFilesEntries(value: unknown, path: string): FilesOpsResult<readonly FilesEntry[]> {
  if (!Array.isArray(value)) {
    return reject("MALFORMED_FILES_RESPONSE", "files entries must be an array.", path);
  }

  const entries: FilesEntry[] = [];

  for (let index = 0; index < value.length; index += 1) {
    const normalized = normalizeFilesEntry(value[index], `${path}/${index}`);

    if (!normalized.ok) return normalized;
    entries.push(normalized.value);
  }

  return accept(Object.freeze(entries));
}

function normalizeFilesEntry(value: unknown, path: string): FilesOpsResult<FilesEntry> {
  const entry = safeRecord(value);

  if (!entry.ok) {
    return reject("MALFORMED_FILES_RESPONSE", `files entry must be an object.`, path);
  }

  const name = safeField(entry.value, "name");
  const kind = safeField(entry.value, "kind");
  const size = safeField(entry.value, "size");
  const mtime = safeField(entry.value, "mtime");

  if (name === ACCESSOR_FIELD || kind === ACCESSOR_FIELD || size === ACCESSOR_FIELD || mtime === ACCESSOR_FIELD) {
    return reject("MALFORMED_FILES_RESPONSE", "files entry fields must be data fields.", path);
  }
  if (typeof name !== "string" || name.length === 0) {
    return reject("MALFORMED_FILES_RESPONSE", "files entry name must be a non-empty string.", `${path}/name`);
  }
  if (!isFilesEntryKind(kind)) {
    return reject("MALFORMED_FILES_RESPONSE", "files entry kind is not supported.", `${path}/kind`);
  }
  if (!isNonNegativeInteger(size)) {
    return reject("MALFORMED_FILES_RESPONSE", "files entry size must be a non-negative integer.", `${path}/size`);
  }
  if (typeof mtime !== "string") {
    return reject("MALFORMED_FILES_RESPONSE", "files entry mtime must be a string.", `${path}/mtime`);
  }

  return accept(Object.freeze({
    kind,
    mtime,
    name,
    size,
  }));
}

function safeRecord(value: unknown): FilesOpsResult<Readonly<Record<string, unknown>>> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return reject("MALFORMED_OBJECT", "value must be an object.", "/");
  }

  try {
    const prototype = Object.getPrototypeOf(value);

    if (prototype !== Object.prototype && prototype !== null) {
      return reject("MALFORMED_OBJECT", "value must be a plain object.", "/");
    }
  } catch {
    return reject("MALFORMED_OBJECT", "value object could not be inspected.", "/");
  }

  return accept(value as Readonly<Record<string, unknown>>);
}

function safeField(record: Readonly<Record<string, unknown>>, key: string): unknown | typeof ACCESSOR_FIELD {
  let descriptor: PropertyDescriptor | undefined;

  try {
    descriptor = Object.getOwnPropertyDescriptor(record, key);
  } catch {
    return ACCESSOR_FIELD;
  }

  if (descriptor === undefined) return undefined;
  if (!Object.hasOwn(descriptor, "value")) return ACCESSOR_FIELD;

  return descriptor.value;
}

function isFilesEntryKind(value: unknown): value is FilesEntry["kind"] {
  return value === "dir" || value === "file" || value === "symlink-skipped";
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function allocateCollisionName(baseName: string, reservedNames: Set<string>): string {
  if (!reservedNames.has(baseName)) return baseName;

  const extension = fileExtension(baseName);
  const stem = extension.length === 0 ? baseName : baseName.slice(0, baseName.length - extension.length);

  for (let suffix = 1; suffix < Number.MAX_SAFE_INTEGER; suffix += 1) {
    const candidate = `${stem} (${suffix})${extension}`;

    if (!reservedNames.has(candidate)) return candidate;
  }

  return `${baseName} copy`;
}

function fileExtension(name: string): string {
  const dot = name.lastIndexOf(".");

  if (dot <= 0 || dot === name.length - 1) return "";

  return name.slice(dot);
}

function basename(path: string): string {
  const normalized = normalizeCapabilityPath(path);

  if (normalized === "/") return "/";

  const trimmed = normalized.replace(/\/+$/u, "");
  const separator = trimmed.lastIndexOf("/");

  if (separator < 0) return trimmed;

  return trimmed.slice(separator + 1);
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

function accept<T>(value: T): FilesOpsResult<T> {
  return Object.freeze({
    ok: true,
    value,
  });
}

function reject<T>(code: string, message: string, path: string): FilesOpsResult<T> {
  return Object.freeze({
    error: Object.freeze({
      code,
      message,
      path,
    }),
    ok: false,
  });
}
