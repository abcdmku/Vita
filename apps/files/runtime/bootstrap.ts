import type {
  DesktopCapability,
  DesktopHost,
  DesktopMaybePromise,
  FilesErrorResponse,
  FilesRequest,
  FilesResponse,
} from "../../../sdk/typescript/src/desktop-sdk/index.ts";
import type {
  FilesCapabilityPort,
} from "../../../sdk/typescript/src/desktop-sdk/index.ts";
import {
  createBinder,
} from "../../../ui_kits/desktop/runtime/binder.ts";
import type {
  VitaActionHandler,
  VitaBindMap,
  VitaBindValue,
  VitaElement,
  VitaElementList,
  VitaListItem,
} from "../../../ui_kits/desktop/runtime/binder.ts";
import {
  createSurfaceHost,
} from "../../../ui_kits/desktop/runtime/host-bridge.ts";
import type {
  SurfaceHostTransportLike,
} from "../../../ui_kits/desktop/runtime/host-bridge.ts";
import {
  createFilesAppViewModel,
} from "../../../ui_kits/desktop/viewmodels/apps/files-app.ts";
import type {
  FilesAppDirectoryEntry,
  FilesAppResult,
  FilesAppState,
  FilesAppViewModel,
} from "../../../ui_kits/desktop/viewmodels/apps/files-app.ts";

export interface FilesAppBootstrapDocument {
  readonly body?: VitaElement | null;
  querySelectorAll(selector: string): VitaElementList;
}

export type FilesAppBootstrapGlobal = object;

export interface FilesAppBootstrapOptions {
  readonly document?: FilesAppBootstrapDocument;
  readonly global?: FilesAppBootstrapGlobal;
  readonly host?: DesktopHost;
  readonly initialPath?: string;
  readonly root?: VitaElement;
  readonly transport?: SurfaceHostTransportLike;
}

export interface FilesAppPorts {
  readonly files?: FilesCapabilityPort;
  readonly grant?: string;
}

export interface FilesAppRuntime {
  readonly ok: true;
  readonly root: VitaElement;
  dispose(): void;
  refresh(): Promise<FilesAppResult<FilesAppState>>;
  snapshot(): FilesAppState;
}

export interface FilesAppInertRuntime {
  readonly ok: false;
  readonly error: FilesAppBootstrapError;
  dispose(): void;
  snapshot(): undefined;
}

export interface FilesAppBootstrapError {
  readonly code: "FILES_APP_BOOTSTRAP_FAILED";
  readonly message: string;
  readonly path: string;
}

export type FilesAppBootstrapRuntime = FilesAppRuntime | FilesAppInertRuntime;

type FilesEntryAction = "files.open" | "files.select";
type FilesAppSurfaceSnapshot = FilesAppState | FilesEntryRowSnapshot;

interface FilesEntryRowSnapshot {
  readonly action: FilesEntryAction;
  readonly icon: string;
  readonly key: string;
  readonly kind: string;
  readonly modified: string;
  readonly name: string;
  readonly path: string;
  readonly selected: boolean;
  readonly size: string;
}

const APP_ID = "vita.app.files";
const APP_SELECTOR = "[data-vita-app]";
const TRANSPORT_GLOBALS = Object.freeze([
  "vitaDesktopBridge",
  "vitaHostBridge",
  "vitaBridge",
  "__vitaDesktopBridge",
] as const);
const FILES_CAPABILITIES = Object.freeze([
  "files.write",
  "files.read",
] as const) satisfies readonly DesktopCapability[];
const DEFAULT_FILES_GRANT = "desktop";
const HOST_BRIDGE_DEFAULT_PACKAGE_ID = "vita.desktop.surface";
const FILES_APP_BINDS: VitaBindMap<FilesAppSurfaceSnapshot> = new Map<string, (snapshot: FilesAppSurfaceSnapshot) => VitaBindValue>([
  ["files.path", (snapshot) => isFilesAppState(snapshot) ? snapshot.path : ""],
  ["files.status", (snapshot) => isFilesAppState(snapshot) ? snapshot.status : ""],
  ["files.errorCode", (snapshot) => isFilesAppState(snapshot) ? snapshot.error?.code ?? "" : ""],
  ["files.notice", (snapshot) => isFilesAppState(snapshot) ? noticeText(snapshot) : ""],
  ["files.entries", (snapshot) => isFilesAppState(snapshot) ? filesEntryItems(snapshot) : Object.freeze([])],
  ["files.entry.action", (snapshot) => isFilesEntryRowSnapshot(snapshot) ? snapshot.action : "files.select"],
  ["files.entry.icon", (snapshot) => isFilesEntryRowSnapshot(snapshot) ? snapshot.icon : ""],
  ["files.entry.name", (snapshot) => isFilesEntryRowSnapshot(snapshot) ? snapshot.name : ""],
  ["files.entry.kind", (snapshot) => isFilesEntryRowSnapshot(snapshot) ? snapshot.kind : ""],
  ["files.entry.size", (snapshot) => isFilesEntryRowSnapshot(snapshot) ? snapshot.size : ""],
  ["files.entry.modified", (snapshot) => isFilesEntryRowSnapshot(snapshot) ? snapshot.modified : ""],
  ["files.entry.path", (snapshot) => isFilesEntryRowSnapshot(snapshot) ? snapshot.path : ""],
  ["files.entry.selected", (snapshot) => isFilesEntryRowSnapshot(snapshot) ? snapshot.selected : false],
]);

export async function bootstrapFilesApp(
  options: FilesAppBootstrapOptions = Object.freeze({}),
): Promise<FilesAppBootstrapRuntime> {
  const root = selectRoot(options);

  if (root === undefined) {
    return inertRuntime("Files app root was not found.", "/root");
  }

  try {
    const transport = resolveTransport(options);
    const host = options.host ?? createSurfaceHost(transport);
    const ports = selectFilesAppPorts(host);
    const viewModelInput: {
      files?: FilesCapabilityPort;
      grant?: string;
      initialPath?: string;
    } = {};
    const initialPath = options.initialPath ?? datasetValue(root, Object.freeze(["vitaInitialPath"]));

    if (ports.files !== undefined) viewModelInput.files = ports.files;
    if (ports.grant !== undefined) viewModelInput.grant = ports.grant;
    if (initialPath !== undefined) viewModelInput.initialPath = initialPath;

    const viewModel = createFilesAppViewModel(viewModelInput);
    let disposed = false;
    let renderCurrent = (): void => {};
    const binding = createBinder<FilesAppSurfaceSnapshot>(root, {
      actions: filesAppActions(viewModel, () => {
        renderCurrent();
      }),
      binds: FILES_APP_BINDS,
      snapshot: () => viewModel.snapshot(),
    });

    renderCurrent = (): void => {
      if (!disposed) binding.render(viewModel.snapshot());
    };

    const refresh = async (): Promise<FilesAppResult<FilesAppState>> => {
      const result = await viewModel.refresh();

      renderCurrent();
      return result;
    };

    await refresh();

    return Object.freeze({
      ok: true,
      root,
      dispose(): void {
        if (disposed) return;
        disposed = true;
        binding.dispose();
      },
      refresh,
      snapshot(): FilesAppState {
        return viewModel.snapshot();
      },
    });
  } catch (error) {
    return inertRuntime(errorMessage(error, "Files app bootstrap failed closed."), "/bootstrap");
  }
}

export async function bootstrapFilesAppFromGlobal(): Promise<FilesAppBootstrapRuntime> {
  return await bootstrapFilesApp({
    global: defaultGlobal(),
  });
}

export function selectFilesAppPorts(host: DesktopHost): FilesAppPorts {
  const files = filesPortFromHost(host);
  const grant = firstCapabilityResource(host, FILES_CAPABILITIES, DEFAULT_FILES_GRANT);
  const output: {
    files?: FilesCapabilityPort;
    grant?: string;
  } = {};

  if (files !== undefined) output.files = files;
  if (grant !== undefined) output.grant = grant;

  return Object.freeze(output);
}

void bootstrapFilesAppFromGlobal().catch(() => {});

function filesAppActions(
  viewModel: FilesAppViewModel,
  renderCurrent: () => void,
): ReadonlyMap<string, VitaActionHandler<FilesAppSurfaceSnapshot>> {
  return new Map<string, VitaActionHandler<FilesAppSurfaceSnapshot>>([
    ["files.refresh", async () => {
      await viewModel.refresh();
      renderCurrent();
    }],
    ["files.up", async () => {
      await viewModel.up();
      renderCurrent();
    }],
    ["files.navigate", async (context) => {
      const path = datasetValue(context.target, Object.freeze(["vitaPath"]));

      if (path !== undefined) await viewModel.navigate(path);
      renderCurrent();
    }],
    ["files.select", (context) => {
      const name = datasetValue(context.target, Object.freeze(["vitaEntryName"]));

      if (name !== undefined) viewModel.select(name);
      renderCurrent();
    }],
    ["files.open", async (context) => {
      const path = datasetValue(context.target, Object.freeze(["vitaPath"]));
      const name = datasetValue(context.target, Object.freeze(["vitaEntryName"]));

      if (path !== undefined) {
        await viewModel.navigate(path);
      } else if (name !== undefined) {
        await viewModel.navigate(name);
      }
      renderCurrent();
    }],
  ]);
}

function filesPortFromHost(host: DesktopHost): FilesCapabilityPort | undefined {
  const extension = optionalHostPort(host, "files", isFilesCapabilityPort) ??
    optionalHostPort(host, "filesPort", isFilesCapabilityPort);

  if (extension !== undefined) return extension;

  const requestFile = readOwnData(host, "requestFile");

  if (!isHostRequestFile(requestFile)) return undefined;

  return Object.freeze({
    request(request: FilesRequest): DesktopMaybePromise<FilesResponse | FilesErrorResponse> {
      return requestFile(request);
    },
  });
}

function optionalHostPort<T>(
  host: DesktopHost,
  key: string,
  guard: (value: unknown) => value is T,
): T | undefined {
  const value = readOwnData(host, key);

  return guard(value) ? value : undefined;
}

function isFilesCapabilityPort(value: unknown): value is FilesCapabilityPort {
  if (!isObjectRecord(value)) return false;

  return typeof readOwnData(value, "request") === "function";
}

function isHostRequestFile(value: unknown): value is (request: FilesRequest) => DesktopMaybePromise<FilesResponse | FilesErrorResponse> {
  return typeof value === "function";
}

function firstCapabilityResource(
  host: DesktopHost,
  capabilities: readonly DesktopCapability[],
  fallback: string,
): string | undefined {
  try {
    const grants = host.package.capabilityGrants;
    const allowUnscoped = host.package.id !== HOST_BRIDGE_DEFAULT_PACKAGE_ID;

    for (let capabilityIndex = 0; capabilityIndex < capabilities.length; capabilityIndex += 1) {
      const capability = capabilities[capabilityIndex];

      if (capability === undefined) continue;

      for (let grantIndex = 0; grantIndex < grants.length; grantIndex += 1) {
        const grant = grants[grantIndex];

        if (grant !== undefined && grant.capability === capability) {
          const resourceId = grant.resourceId;

          if (typeof resourceId === "string" && resourceId.length > 0) return resourceId;
          if (allowUnscoped) return fallback;
        }
      }
    }
  } catch {
    return undefined;
  }

  return undefined;
}

function filesEntryItems(state: FilesAppState): readonly VitaListItem[] {
  const output: VitaListItem[] = [];

  for (let index = 0; index < state.entries.length; index += 1) {
    const entry = state.entries[index];

    if (entry !== undefined) output.push(filesEntryItem(state, entry));
  }

  return Object.freeze(output);
}

function filesEntryItem(state: FilesAppState, entry: FilesAppDirectoryEntry): VitaListItem {
  const selected = state.selected?.name === entry.name;
  const path = entryPath(state.path, entry.name);
  const action = entry.kind === "dir" ? "files.open" : "files.select";
  const row = freezeEntryRow({
    action,
    icon: entryIcon(entry.kind),
    key: `entry:${entry.name}`,
    kind: kindLabel(entry.kind),
    modified: entry.modified,
    name: entry.name,
    path,
    selected,
    size: entrySize(entry),
  });

  return Object.freeze({
    attrs: Object.freeze([
      Object.freeze({
        name: "data-vita-action",
        value: row.action,
      }),
      Object.freeze({
        name: "data-vita-entry-name",
        value: row.name,
      }),
      Object.freeze({
        name: "data-vita-path",
        value: row.path,
      }),
      Object.freeze({
        name: "data-vita-selected",
        value: row.selected,
      }),
    ]),
    key: row.key,
    snapshot: row,
  });
}

function freezeEntryRow(input: FilesEntryRowSnapshot): FilesEntryRowSnapshot {
  return Object.freeze({
    action: input.action,
    icon: input.icon,
    key: input.key,
    kind: input.kind,
    modified: input.modified,
    name: input.name,
    path: input.path,
    selected: input.selected,
    size: input.size,
  });
}

function kindLabel(kind: FilesAppDirectoryEntry["kind"]): string {
  if (kind === "dir") return "Folder";
  if (kind === "symlink-skipped") return "Symlink";

  return "File";
}

function entryIcon(kind: FilesAppDirectoryEntry["kind"]): string {
  return kind === "dir" ? "▣" : "□";
}

function entrySize(entry: FilesAppDirectoryEntry): string {
  return entry.kind === "dir" ? "-" : formatBytes(entry.size);
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  if (bytes >= 1_073_741_824) return `${roundOne(bytes / 1_073_741_824)} GB`;
  if (bytes >= 1_048_576) return `${roundOne(bytes / 1_048_576)} MB`;
  if (bytes >= 1024) return `${roundOne(bytes / 1024)} KB`;

  return `${Math.round(bytes)} B`;
}

function roundOne(value: number): string {
  const rounded = Math.round(value * 10) / 10;

  return Number.isInteger(rounded) ? `${rounded}` : rounded.toFixed(1);
}

function entryPath(path: string, name: string): string {
  if (path === "/") return `/${name}`;

  return `${path}/${name}`;
}

function noticeText(state: FilesAppState): string {
  const error = state.error;

  if (error === undefined) return "";

  return `${error.code}: ${error.message}`;
}

function datasetValue(element: VitaElement, keys: readonly string[]): string | undefined {
  try {
    for (let index = 0; index < keys.length; index += 1) {
      const key = keys[index];
      const value = key === undefined ? undefined : element.dataset[key];

      if (typeof value === "string" && value.length > 0) return value;
    }
  } catch {
    return undefined;
  }

  return undefined;
}

function selectRoot(options: FilesAppBootstrapOptions): VitaElement | undefined {
  if (options.root !== undefined) return options.root;

  const document = options.document ?? documentFromGlobal(options.global ?? defaultGlobal());

  if (document === undefined) return undefined;

  const roots = elementsFromDocument(document, APP_SELECTOR);

  for (let index = 0; index < roots.length; index += 1) {
    const root = roots[index];

    if (root !== undefined && appIdForRoot(root) === APP_ID) return root;
  }

  const body = document.body;

  if (body !== undefined && body !== null && appIdForRoot(body) === APP_ID) return body;

  return undefined;
}

function appIdForRoot(root: VitaElement): string | undefined {
  try {
    const id = root.dataset.vitaApp;

    return typeof id === "string" && id.length > 0 ? id : undefined;
  } catch {
    return undefined;
  }
}

function elementsFromDocument(
  document: FilesAppBootstrapDocument,
  selector: string,
): readonly VitaElement[] {
  try {
    const list = document.querySelectorAll(selector);
    const output: VitaElement[] = [];

    for (let index = 0; index < list.length; index += 1) {
      const element = list[index];

      if (element !== undefined) output.push(element);
    }

    return Object.freeze(output);
  } catch {
    return Object.freeze([]);
  }
}

function resolveTransport(
  options: FilesAppBootstrapOptions,
): Exclude<SurfaceHostTransportLike, null | undefined> | undefined {
  if (options.transport !== undefined && isTransportLike(options.transport)) return options.transport;

  const globalObject = options.global ?? defaultGlobal();

  for (let index = 0; index < TRANSPORT_GLOBALS.length; index += 1) {
    const key = TRANSPORT_GLOBALS[index];
    const value = key === undefined ? undefined : readOwnData(globalObject, key);

    if (value !== undefined && isTransportLike(value)) return value;
  }

  return undefined;
}

function documentFromGlobal(globalObject: FilesAppBootstrapGlobal): FilesAppBootstrapDocument | undefined {
  const document = readOwnAny(globalObject, "document");

  return isBootstrapDocument(document) ? document : undefined;
}

function defaultGlobal(): FilesAppBootstrapGlobal {
  const value: unknown = globalThis;

  return isObjectRecord(value) ? value : Object.freeze({});
}

function isBootstrapDocument(value: unknown): value is FilesAppBootstrapDocument {
  if (!isObjectRecord(value)) return false;

  try {
    return typeof Reflect.get(value, "querySelectorAll") === "function";
  } catch {
    return false;
  }
}

function isTransportLike(value: unknown): value is Exclude<SurfaceHostTransportLike, null | undefined> {
  if (typeof value === "function") return true;
  if (!isObjectRecord(value)) return false;

  return typeof readOwnData(value, "request") === "function";
}

function readOwnData(source: object, key: string): unknown {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(source, key);

    if (descriptor === undefined || !Object.prototype.hasOwnProperty.call(descriptor, "value")) {
      return undefined;
    }

    return descriptor.value;
  } catch {
    return undefined;
  }
}

function readOwnAny(source: object, key: string): unknown {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(source, key);

    if (descriptor === undefined) return undefined;
    if (Object.prototype.hasOwnProperty.call(descriptor, "value")) return descriptor.value;

    const getter = descriptor.get;

    return typeof getter === "function" ? Reflect.apply(getter, source, []) : undefined;
  } catch {
    return undefined;
  }
}

function inertRuntime(message: string, path: string): FilesAppInertRuntime {
  const error = Object.freeze({
    code: "FILES_APP_BOOTSTRAP_FAILED",
    message,
    path,
  }) satisfies FilesAppBootstrapError;
  let disposed = false;

  return Object.freeze({
    error,
    ok: false,
    dispose(): void {
      disposed = true;
    },
    snapshot(): undefined {
      if (disposed) return undefined;

      return undefined;
    },
  });
}

function isFilesAppState(snapshot: FilesAppSurfaceSnapshot): snapshot is FilesAppState {
  return "entries" in snapshot && "status" in snapshot;
}

function isFilesEntryRowSnapshot(snapshot: FilesAppSurfaceSnapshot): snapshot is FilesEntryRowSnapshot {
  return "action" in snapshot && "key" in snapshot && "selected" in snapshot;
}

function isObjectRecord(value: unknown): value is object {
  return value !== null && typeof value === "object";
}

function errorMessage(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message.length > 0) return error.message;

  return fallback;
}
