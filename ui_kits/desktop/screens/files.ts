import type {
  DesktopHost,
  DesktopMaybePromise,
  FilesErrorResponse,
  FilesRequest,
  FilesResponse,
} from "../../../sdk/typescript/src/desktop-sdk/index.ts";
import type {
  VitaActionContext,
  VitaListItem,
} from "../runtime/binder.ts";
import type {
  ScreenModule,
} from "../runtime/screen.ts";
import {
  createFilesOpsViewModel,
} from "../viewmodels/files-ops.ts";
import type {
  FilesOpsCapabilityPort,
  FilesOpsRequest,
  FilesOpsState,
  FilesOpsTarget,
  FilesOpsViewModel,
} from "../viewmodels/files-ops.ts";
import {
  createFilesViewModel,
} from "../viewmodels/files.ts";
import type {
  FilesBreadcrumbSegment,
  FilesFavorite,
  FilesViewEntry,
  FilesViewModel,
  FilesViewState,
} from "../viewmodels/files.ts";
import {
  datasetValue,
  firstCapabilityResource,
  formatBytes,
  optionalHostPort,
  textListItem,
} from "./shared.ts";

export interface FilesScreenPorts {
  readonly files?: FilesOpsCapabilityPort;
  readonly grant?: string;
}

export interface FilesScreenState {
  readonly view: FilesViewState;
  readonly ops: FilesOpsState;
}

class FilesScreenViewModel {
  readonly #ops: FilesOpsViewModel;
  readonly #view: FilesViewModel;

  constructor(ports: FilesScreenPorts) {
    const viewInput: {
      files?: FilesOpsCapabilityPort;
      grant?: string;
      initialPath: string;
    } = {
      initialPath: "/src",
    };
    const opsInput: {
      files?: FilesOpsCapabilityPort;
      grant?: string;
    } = {};

    if (ports.files !== undefined) {
      viewInput.files = ports.files;
      opsInput.files = ports.files;
    }
    if (ports.grant !== undefined) {
      viewInput.grant = ports.grant;
      opsInput.grant = ports.grant;
    }

    this.#view = createFilesViewModel(viewInput);
    this.#ops = createFilesOpsViewModel(opsInput);
  }

  snapshot(): FilesScreenState {
    return Object.freeze({
      ops: this.#ops.state,
      view: this.#view.state,
    });
  }

  async refresh(): Promise<void> {
    await this.#view.refresh();
  }

  async up(): Promise<void> {
    await this.#view.up();
  }

  async navigate(path: string): Promise<void> {
    await this.#view.navigate(path);
  }

  async openFavorite(id: string): Promise<void> {
    await this.#view.openFavorite(id);
  }

  select(name: string): void {
    this.#view.select(name);
  }

  copySelected(): void {
    const target = selectedTarget(this.#view.state);

    if (target !== null) this.#ops.copy(Object.freeze([target]));
  }

  cutSelected(): void {
    const target = selectedTarget(this.#view.state);

    if (target !== null) this.#ops.cut(Object.freeze([target]));
  }

  async pasteIntoCurrentDirectory(): Promise<void> {
    await this.#ops.paste(this.#view.state.path);
  }

  async trashSelected(): Promise<void> {
    const target = selectedTarget(this.#view.state);

    if (target !== null) await this.#ops.trash(Object.freeze([target]));
  }

  async newFolder(name: string): Promise<void> {
    await this.#ops.newFolder(this.#view.state.path, name);
  }

  clearClipboard(): void {
    this.#ops.clearClipboard();
  }
}

export const filesScreen = Object.freeze({
  actions: new Map<string, (viewModel: FilesScreenViewModel, context: VitaActionContext<FilesScreenState>) => DesktopMaybePromise<void>>([
    ["files.refresh", async (viewModel) => {
      await viewModel.refresh();
    }],
    ["files.up", async (viewModel) => {
      await viewModel.up();
    }],
    ["files.navigate", async (viewModel, context) => {
      const path = datasetValue(context.target, Object.freeze(["vitaPath"]));

      if (path !== undefined) await viewModel.navigate(path);
    }],
    ["files.favorite", async (viewModel, context) => {
      const id = datasetValue(context.target, Object.freeze(["vitaFavoriteId"]));

      if (id !== undefined) await viewModel.openFavorite(id);
    }],
    ["files.select", (viewModel, context) => {
      const name = datasetValue(context.target, Object.freeze(["vitaEntryName"]));

      if (name !== undefined) viewModel.select(name);
    }],
    ["files.open", async (viewModel, context) => {
      const path = datasetValue(context.target, Object.freeze(["vitaPath"]));
      const name = datasetValue(context.target, Object.freeze(["vitaEntryName"]));

      if (path !== undefined) {
        await viewModel.navigate(path);
      } else if (name !== undefined) {
        await viewModel.navigate(name);
      }
    }],
    ["files.copy", (viewModel) => {
      viewModel.copySelected();
    }],
    ["files.cut", (viewModel) => {
      viewModel.cutSelected();
    }],
    ["files.paste", async (viewModel) => {
      await viewModel.pasteIntoCurrentDirectory();
    }],
    ["files.trash", async (viewModel) => {
      await viewModel.trashSelected();
    }],
    ["files.newFolder", async (viewModel, context) => {
      await viewModel.newFolder(datasetValue(context.target, Object.freeze(["vitaName"])) ?? "New Folder");
    }],
    ["files.clearClipboard", (viewModel) => {
      viewModel.clearClipboard();
    }],
  ]),
  binds: new Map<string, (snapshot: FilesScreenState) => string | boolean | readonly VitaListItem[]>([
    ["files.path", (snapshot) => snapshot.view.path],
    ["files.status", (snapshot) => snapshot.view.status],
    ["files.selected", (snapshot) => snapshot.view.selected?.name ?? ""],
    ["files.error", (snapshot) => snapshot.view.error?.message ?? snapshot.ops.error?.message ?? ""],
    ["files.hasSelection", (snapshot) => snapshot.view.selected !== undefined],
    ["files.clipboard", (snapshot) => clipboardLabel(snapshot.ops)],
    ["files.opsStatus", (snapshot) => snapshot.ops.status],
    ["files.breadcrumbs", (snapshot) => snapshot.view.breadcrumbs.map(breadcrumbItem)],
    ["files.favorites", (snapshot) => snapshot.view.favorites.map(favoriteItem)],
    ["files.entries", (snapshot) => snapshot.view.entries.map((entry) => entryItem(snapshot.view, entry))],
  ]),
  createViewModel(ports: FilesScreenPorts): FilesScreenViewModel {
    return new FilesScreenViewModel(ports);
  },
  id: "desktop/files",
  selectPorts(host: DesktopHost): FilesScreenPorts {
    const files = filesPortFromHost(host);
    const grant = files === undefined
      ? undefined
      : firstCapabilityResource(host, Object.freeze(["files.write", "files.read"]), "desktop");
    const output: {
      files?: FilesOpsCapabilityPort;
      grant?: string;
    } = {};

    if (files !== undefined) output.files = files;
    if (grant !== undefined) output.grant = grant;

    return Object.freeze(output);
  },
}) satisfies ScreenModule<FilesScreenState, FilesScreenPorts, FilesScreenViewModel>;

export default filesScreen;

function filesPortFromHost(host: DesktopHost): FilesOpsCapabilityPort | undefined {
  const extension = optionalHostPort(host, "files", isFilesOpsCapabilityPort) ??
    optionalHostPort(host, "filesPort", isFilesOpsCapabilityPort);

  if (extension !== undefined) return extension;
  if (host.requestFile === undefined) return undefined;

  const requestFile = host.requestFile;

  return Object.freeze({
    async request(request: FilesOpsRequest): Promise<FilesResponse | FilesErrorResponse> {
      if (!isSdkFilesRequest(request)) {
        return Object.freeze({
          error: Object.freeze({
            code: "UnsupportedFilesOperation",
            message: "host files port does not expose mutation operations.",
          }),
        });
      }

      return await requestFile(request);
    },
  });
}

function isFilesOpsCapabilityPort(value: unknown): value is FilesOpsCapabilityPort {
  return value !== null &&
    typeof value === "object" &&
    typeof optionalRequest(value) === "function";
}

function optionalRequest(value: object): unknown {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, "request");

    if (descriptor === undefined || !Object.prototype.hasOwnProperty.call(descriptor, "value")) {
      return undefined;
    }

    return descriptor.value;
  } catch {
    return undefined;
  }
}

function isSdkFilesRequest(request: FilesOpsRequest): request is FilesRequest {
  return request.op === "list" || request.op === "read" || request.op === "write" || request.op === "stat";
}

function breadcrumbItem(segment: FilesBreadcrumbSegment): VitaListItem {
  return textListItem({
    action: "files.navigate",
    data: Object.freeze([
      Object.freeze({
        name: "data-vita-path",
        value: segment.path,
      }),
    ]),
    key: `breadcrumb:${segment.path}`,
    text: segment.label,
  });
}

function favoriteItem(favorite: FilesFavorite): VitaListItem {
  return textListItem({
    action: "files.favorite",
    classes: Object.freeze([
      Object.freeze({
        className: "on",
        enabled: favorite.selected,
      }),
    ]),
    data: Object.freeze([
      Object.freeze({
        name: "data-vita-favorite-id",
        value: favorite.id,
      }),
    ]),
    key: `favorite:${favorite.id}`,
    text: favorite.label,
  });
}

function entryItem(view: FilesViewState, entry: FilesViewEntry): VitaListItem {
  const selected = view.selected?.name === entry.name;

  return textListItem({
    action: entry.kind === "dir" ? "files.open" : "files.select",
    classes: Object.freeze([
      Object.freeze({
        className: "on",
        enabled: selected,
      }),
    ]),
    data: Object.freeze([
      Object.freeze({
        name: "data-vita-entry-name",
        value: entry.name,
      }),
      Object.freeze({
        name: "data-vita-path",
        value: entryPath(view.path, entry.name),
      }),
    ]),
    key: `entry:${entry.name}`,
    text: `${entry.name}  ${kindLabel(entry.kind)}  ${formatFileSize(entry)}  ${entry.modified}`,
  });
}

function clipboardLabel(state: FilesOpsState): string {
  if (state.clipboard.mode === null || state.clipboard.targets.length === 0) return "Clipboard empty";

  return `${state.clipboard.mode} ${state.clipboard.targets.length}`;
}

function selectedTarget(view: FilesViewState): FilesOpsTarget | null {
  const selected = view.selected;

  if (selected === undefined) return null;

  return Object.freeze({
    kind: selected.kind,
    path: entryPath(view.path, selected.name),
  });
}

function entryPath(path: string, name: string): string {
  if (path === "/") return `/${name}`;

  return `${path}/${name}`;
}

function kindLabel(kind: FilesViewEntry["kind"]): string {
  if (kind === "dir") return "Folder";
  if (kind === "symlink-skipped") return "Symlink";

  return "File";
}

function formatFileSize(entry: FilesViewEntry): string {
  return entry.kind === "dir" ? "-" : formatBytes(entry.size);
}
