import {
  createFileManagerState,
  hasDesktopCapabilityGrant,
  joinCapabilityPath,
  loadFileManagerDirectory,
  readFileManagerFile,
} from "../../../sdk/typescript/src/desktop-sdk/index.ts";
import type {
  AppError,
  DesktopHost,
  DesktopHostError,
  DesktopHostResult,
  DesktopLauncherIntent,
  DesktopUiPackageManifest,
  FileManagerTransition,
  FilesCapabilityPort,
  FilesEntry,
} from "../../../sdk/typescript/src/desktop-sdk/index.ts";
import {
  DEFAULT_INDEX_DOCK_APPS,
} from "./dock.ts";
import type {
  IndexDockAppDefinition,
} from "./dock.ts";
import {
  createDesktopIconsViewModel,
  gridCellToPixel,
} from "./desktop-icons.ts";
import type {
  DesktopIcon,
  DesktopIconGridConfig,
  DesktopIconInput,
  DesktopIconsViewModel,
  DesktopIconsViewModelOptions,
  DesktopIconsViewState,
} from "./desktop-icons.ts";

export const DEFAULT_DESKTOP_DIRECTORY_PATH = "/Desktop";
export const DEFAULT_DESKTOP_FILES_GRANT = "desktop";

const DIRECTORY_ICON_ID_PREFIX = "desktop-entry:";
const LAUNCHER_ICON_ID_PREFIX = "desktop-launcher:";

export type DesktopIconsSourceStatus = "idle" | "ready" | "forbidden" | "error";
export type DesktopIconsSourceDispatch = "openDirectory" | "readFile" | "launcherIntent";

export type DesktopIconsSourceHost = Pick<DesktopHost, "package" | "emitLauncherIntent">;

export interface DesktopIconsSourceError {
  readonly code:
    | "FILES_ACTIVATION_DENIED"
    | "FILES_READ_DENIED"
    | "LAUNCHER_ACTIVATION_DENIED"
    | "LAUNCHER_PORT_FAILED"
    | "MISSING_FILES_GRANT"
    | "MISSING_FILES_PORT"
    | "MISSING_LAUNCHER_GRANT"
    | "MISSING_LAUNCHER_PORT"
    | "UNKNOWN_ICON"
    | "UNSUPPORTED_DIRECTORY_ENTRY";
  readonly message: string;
  readonly path: string;
}

export interface DesktopIconsSourceDirectoryIcon {
  readonly id: string;
  readonly iconRef: string;
  readonly kind: FilesEntry["kind"];
  readonly label: string;
  readonly modified: string;
  readonly path: string;
  readonly size: number;
}

export interface DesktopIconsSourceLauncherIcon {
  readonly appId: string;
  readonly iconRef: string;
  readonly id: string;
  readonly kind: "launcher";
  readonly label: string;
}

export interface DesktopIconsSourceDirectoryState {
  readonly entries: readonly DesktopIconsSourceDirectoryIcon[];
  readonly path: string;
  readonly status: DesktopIconsSourceStatus;
  readonly error?: DesktopIconsSourceError;
}

export interface DesktopIconsSourceLauncherState {
  readonly apps: readonly DesktopIconsSourceLauncherIcon[];
  readonly status: DesktopIconsSourceStatus;
  readonly error?: DesktopIconsSourceError;
}

export interface DesktopIconsSourceState {
  readonly directory: DesktopIconsSourceDirectoryState;
  readonly iconState: DesktopIconsViewState;
  readonly icons: readonly DesktopIcon[];
  readonly launchers: DesktopIconsSourceLauncherState;
}

export type DesktopIconsSourceActivateResult =
  | {
      readonly ok: true;
      readonly dispatch: "openDirectory";
      readonly id: string;
      readonly path: string;
      readonly state: DesktopIconsSourceState;
      readonly transition: FileManagerTransition;
    }
  | {
      readonly ok: true;
      readonly dispatch: "readFile";
      readonly id: string;
      readonly path: string;
      readonly state: DesktopIconsSourceState;
      readonly transition: FileManagerTransition;
    }
  | {
      readonly ok: true;
      readonly appId: string;
      readonly dispatch: "launcherIntent";
      readonly id: string;
      readonly intent: DesktopLauncherIntent;
      readonly state: DesktopIconsSourceState;
    }
  | {
      readonly ok: false;
      readonly error: DesktopIconsSourceError;
      readonly id?: string;
      readonly state: DesktopIconsSourceState;
    };

export interface DesktopIconsSourceViewModelInput {
  readonly apps?: readonly IndexDockAppDefinition[];
  readonly desktopPath?: string;
  readonly files?: FilesCapabilityPort;
  readonly grant?: string;
  readonly host?: DesktopIconsSourceHost;
  readonly iconModel?: DesktopIconsViewModel;
  readonly iconModelOptions?: DesktopIconsViewModelOptions;
  readonly manifest?: DesktopUiPackageManifest;
}

export interface DesktopIconsSourceViewModel {
  readonly iconModel: DesktopIconsViewModel;
  readonly state: DesktopIconsSourceState;
  snapshot(): DesktopIconsSourceState;
  refresh(): Promise<DesktopIconsSourceState>;
  reconcile(): Promise<DesktopIconsSourceState>;
  activate(id: string): Promise<DesktopIconsSourceActivateResult>;
}

interface DirectoryReadResult {
  readonly entries: readonly DesktopIconsSourceDirectoryIcon[];
  readonly error?: DesktopIconsSourceError;
  readonly status: DesktopIconsSourceStatus;
}

interface LauncherBuildResult {
  readonly apps: readonly DesktopIconsSourceLauncherIcon[];
  readonly error?: DesktopIconsSourceError;
  readonly status: DesktopIconsSourceStatus;
}

interface DirectoryActivationSource {
  readonly icon: DesktopIconsSourceDirectoryIcon;
  readonly entry: FilesEntry;
}

export function createDesktopIconsSourceViewModel(
  input: DesktopIconsSourceViewModelInput = Object.freeze({}),
): DesktopIconsSourceViewModel {
  return new DesktopIconsSourceModel(input);
}

export function desktopDirectoryEntryIconId(path: string): string {
  return `${DIRECTORY_ICON_ID_PREFIX}${normalizeCapabilityPath(path)}`;
}

export function desktopLauncherIconId(appId: string): string {
  return `${LAUNCHER_ICON_ID_PREFIX}${appId}`;
}

class DesktopIconsSourceModel implements DesktopIconsSourceViewModel {
  readonly #apps: readonly IndexDockAppDefinition[];
  readonly #desktopPath: string;
  readonly #files: FilesCapabilityPort | undefined;
  readonly #grant: string;
  readonly #host: DesktopIconsSourceHost | undefined;
  readonly #iconModel: DesktopIconsViewModel;
  readonly #manifest: DesktopUiPackageManifest | undefined;
  #directoryEntries: readonly DesktopIconsSourceDirectoryIcon[] = Object.freeze([]);
  #directoryError: DesktopIconsSourceError | undefined;
  #directoryStatus: DesktopIconsSourceStatus = "idle";
  #launcherApps: readonly DesktopIconsSourceLauncherIcon[] = Object.freeze([]);
  #launcherError: DesktopIconsSourceError | undefined;
  #launcherStatus: DesktopIconsSourceStatus = "idle";
  #state: DesktopIconsSourceState;

  constructor(input: DesktopIconsSourceViewModelInput) {
    this.#apps = input.apps ?? DEFAULT_INDEX_DOCK_APPS;
    this.#desktopPath = normalizeCapabilityPath(input.desktopPath ?? DEFAULT_DESKTOP_DIRECTORY_PATH);
    this.#files = input.files;
    this.#grant = input.grant ?? DEFAULT_DESKTOP_FILES_GRANT;
    this.#host = input.host;
    this.#iconModel = input.iconModel ?? createDesktopIconsViewModel(input.iconModelOptions);
    this.#manifest = input.manifest ?? input.host?.package;

    this.#applyLaunchers();
    this.#applyIcons();
    this.#state = this.#freezeState();
  }

  get iconModel(): DesktopIconsViewModel {
    return this.#iconModel;
  }

  get state(): DesktopIconsSourceState {
    return this.snapshot();
  }

  snapshot(): DesktopIconsSourceState {
    this.#state = this.#freezeState();
    return this.#state;
  }

  async refresh(): Promise<DesktopIconsSourceState> {
    return await this.#refreshAndApply();
  }

  async reconcile(): Promise<DesktopIconsSourceState> {
    return await this.#refreshAndApply();
  }

  async activate(id: string): Promise<DesktopIconsSourceActivateResult> {
    const directory = this.#findDirectorySource(id);

    if (directory !== undefined) {
      return await this.#activateDirectory(directory);
    }

    const launcher = findLauncher(this.#launcherApps, id);

    if (launcher !== undefined) {
      return await this.#activateLauncher(launcher);
    }

    if (isDirectoryIconId(id)) {
      return this.#rejectActivation(this.#directoryPrefixActivationError(), id);
    }

    if (isLauncherIconId(id)) {
      return this.#rejectActivation(this.#launcherPrefixActivationError(id), id);
    }

    return this.#rejectActivation(error(
      "UNKNOWN_ICON",
      "desktop icon id is not currently bound to a source.",
      "/icons/id",
    ), id);
  }

  async #refreshAndApply(): Promise<DesktopIconsSourceState> {
    const directory = await this.#readDirectory();

    this.#directoryEntries = directory.entries;
    this.#directoryStatus = directory.status;
    this.#directoryError = directory.error;
    this.#applyLaunchers();
    this.#applyIcons();
    this.#state = this.#freezeState();
    return this.#state;
  }

  async #readDirectory(): Promise<DirectoryReadResult> {
    const grantError = this.#filesReadinessError();

    if (grantError !== undefined) {
      return Object.freeze({
        entries: Object.freeze([]),
        error: grantError,
        status: grantError.code === "MISSING_FILES_GRANT" ? "forbidden" : "error",
      });
    }

    const files = this.#files;

    if (files === undefined) {
      return Object.freeze({
        entries: Object.freeze([]),
        error: error(
          "MISSING_FILES_PORT",
          "desktop icon source requires an injected files capability port.",
          "/files",
        ),
        status: "error",
      });
    }

    const listed = await loadFileManagerDirectory(
      files,
      createFileManagerState({
        grant: this.#grant,
        path: this.#desktopPath,
      }),
      this.#desktopPath,
    );

    if (listed.state.status !== "ready") {
      const listedError = listed.state.error ?? {
        code: "FILES_ACTIVATION_DENIED",
        message: "desktop directory listing failed closed.",
        path: "/files/list",
      };

      return Object.freeze({
        entries: Object.freeze([]),
        error: sourceError(listedError, "FILES_ACTIVATION_DENIED"),
        status: listed.state.status === "forbidden" ? "forbidden" : "error",
      });
    }

    return Object.freeze({
      entries: directoryIconsFromEntries(this.#desktopPath, listed.state.entries),
      status: "ready",
    });
  }

  #applyLaunchers(): void {
    const launchers = this.#buildLaunchers();

    this.#launcherApps = launchers.apps;
    this.#launcherStatus = launchers.status;
    this.#launcherError = launchers.error;
  }

  #buildLaunchers(): LauncherBuildResult {
    const port = this.#host?.emitLauncherIntent;

    if (port === undefined) {
      return Object.freeze({
        apps: Object.freeze([]),
        error: error(
          "MISSING_LAUNCHER_PORT",
          "desktop icon source requires an injected launcher intent port.",
          "/launcher",
        ),
        status: "error",
      });
    }

    const manifest = this.#manifest;

    if (manifest === undefined) {
      return Object.freeze({
        apps: Object.freeze([]),
        error: launcherDenied(),
        status: "forbidden",
      });
    }

    const output: DesktopIconsSourceLauncherIcon[] = [];

    for (let index = 0; index < this.#apps.length; index += 1) {
      const app = this.#apps[index];

      if (app === undefined) continue;
      if (!hasDesktopCapabilityGrant(manifest, "launcher.launch", app.appId)) continue;
      output.push(freezeLauncherIcon({
        appId: app.appId,
        iconRef: `dock:${app.icon}`,
        id: desktopLauncherIconId(app.appId),
        kind: "launcher",
        label: app.title,
      }));
    }

    if (output.length === 0) {
      return Object.freeze({
        apps: Object.freeze([]),
        error: launcherDenied(),
        status: "forbidden",
      });
    }

    return Object.freeze({
      apps: Object.freeze(output),
      status: "ready",
    });
  }

  #applyIcons(): void {
    this.#iconModel.setIcons(iconInputs(
      this.#directoryEntries,
      this.#launcherApps,
      this.#iconModel.snapshot().icons,
      this.#iconModel.snapshot().grid,
    ));
  }

  async #activateDirectory(
    source: DirectoryActivationSource,
  ): Promise<DesktopIconsSourceActivateResult> {
    if (source.entry.kind === "dir") {
      const readiness = this.#filesReadinessError();

      if (readiness !== undefined) return this.#rejectActivation(readiness, source.icon.id);

      const files = this.#files;

      if (files === undefined) {
        return this.#rejectActivation(error(
          "MISSING_FILES_PORT",
          "desktop icon source requires an injected files capability port.",
          "/files",
        ), source.icon.id);
      }

      const transition = await loadFileManagerDirectory(
        files,
        createFileManagerState({
          entries: entriesFromDirectoryIcons(this.#directoryEntries),
          grant: this.#grant,
          path: this.#desktopPath,
        }),
        source.icon.path,
      );

      if (transition.state.status !== "ready") {
        return this.#rejectActivation(activationError(transition.state.error), source.icon.id);
      }

      return Object.freeze({
        dispatch: "openDirectory",
        id: source.icon.id,
        ok: true,
        path: source.icon.path,
        state: this.snapshot(),
        transition,
      });
    }

    if (source.entry.kind === "file") {
      return await this.#activateFile(source);
    }

    return this.#rejectActivation(error(
      "UNSUPPORTED_DIRECTORY_ENTRY",
      "desktop icon source cannot activate skipped symlink entries.",
      `/icons/${pathToken(source.icon.id)}`,
    ), source.icon.id);
  }

  async #activateFile(
    source: DirectoryActivationSource,
  ): Promise<DesktopIconsSourceActivateResult> {
    const readiness = this.#filesReadinessError();

    if (readiness !== undefined) return this.#rejectActivation(readiness, source.icon.id);

    const files = this.#files;

    if (files === undefined) {
      return this.#rejectActivation(error(
        "MISSING_FILES_PORT",
        "desktop icon source requires an injected files capability port.",
        "/files",
      ), source.icon.id);
    }

    const transition = await readFileManagerFile(
      files,
      createFileManagerState({
        entries: entriesFromDirectoryIcons(this.#directoryEntries),
        grant: this.#grant,
        path: this.#desktopPath,
      }),
      source.icon.path,
      {
        kind: source.entry.kind,
        mtime: source.entry.mtime,
        size: source.entry.size,
      },
    );

    if (transition.state.status !== "preview") {
      return this.#rejectActivation(activationError(transition.state.error), source.icon.id);
    }

    return Object.freeze({
      dispatch: "readFile",
      id: source.icon.id,
      ok: true,
      path: source.icon.path,
      state: this.snapshot(),
      transition,
    });
  }

  async #activateLauncher(
    launcher: DesktopIconsSourceLauncherIcon,
  ): Promise<DesktopIconsSourceActivateResult> {
    const readiness = this.#launcherReadinessError(launcher.appId);

    if (readiness !== undefined) return this.#rejectActivation(readiness, launcher.id);

    const emit = this.#host?.emitLauncherIntent;

    if (emit === undefined) {
      return this.#rejectActivation(error(
        "MISSING_LAUNCHER_PORT",
        "desktop icon source requires an injected launcher intent port.",
        "/launcher",
      ), launcher.id);
    }

    const intent = Object.freeze({
      appId: launcher.appId,
      type: "launcher.launch",
    }) satisfies DesktopLauncherIntent;
    let result: DesktopHostResult<true>;

    try {
      result = await emit(intent);
    } catch {
      return this.#rejectActivation(error(
        "LAUNCHER_PORT_FAILED",
        "launcher intent port failed closed.",
        `/launcher/${pathToken(launcher.appId)}`,
      ), launcher.id);
    }

    if (!result.ok) {
      return this.#rejectActivation(hostError(result.error), launcher.id);
    }

    return Object.freeze({
      appId: launcher.appId,
      dispatch: "launcherIntent",
      id: launcher.id,
      intent,
      ok: true,
      state: this.snapshot(),
    });
  }

  #filesReadinessError(): DesktopIconsSourceError | undefined {
    const manifest = this.#manifest;

    if (this.#grant.length === 0 || manifest === undefined) return filesReadDenied(this.#grant);
    if (!hasDesktopCapabilityGrant(manifest, "files.read", this.#grant)) return filesReadDenied(this.#grant);

    return undefined;
  }

  #launcherReadinessError(appId: string): DesktopIconsSourceError | undefined {
    const manifest = this.#manifest;

    if (manifest === undefined) return launcherDenied();
    if (!hasDesktopCapabilityGrant(manifest, "launcher.launch", appId)) return launcherDenied();

    return undefined;
  }

  #directoryPrefixActivationError(): DesktopIconsSourceError {
    const readiness = this.#filesReadinessError();

    if (readiness !== undefined) return readiness;
    if (this.#directoryStatus !== "ready" && this.#directoryError !== undefined) return this.#directoryError;

    return error(
      "UNKNOWN_ICON",
      "desktop path icon id is not present in the current Desktop listing.",
      "/icons/id",
    );
  }

  #launcherPrefixActivationError(id: string): DesktopIconsSourceError {
    const appId = launcherAppIdFromIconId(id);

    if (findApp(this.#apps, appId) === undefined) {
      return error(
        "UNKNOWN_ICON",
        "launcher icon id is not present in the pinned app set.",
        "/icons/id",
      );
    }

    const readiness = this.#launcherReadinessError(appId);

    if (readiness !== undefined) return readiness;
    if (this.#launcherError !== undefined) return this.#launcherError;

    return error(
      "UNKNOWN_ICON",
      "launcher icon id is not currently bound to a source.",
      "/icons/id",
    );
  }

  #findDirectorySource(id: string): DirectoryActivationSource | undefined {
    for (let index = 0; index < this.#directoryEntries.length; index += 1) {
      const icon = this.#directoryEntries[index];

      if (icon === undefined || icon.id !== id) continue;

      return Object.freeze({
        entry: Object.freeze({
          kind: icon.kind,
          mtime: icon.modified,
          name: icon.label,
          size: icon.size,
        }),
        icon,
      });
    }

    return undefined;
  }

  #rejectActivation(errorValue: DesktopIconsSourceError, id: string): DesktopIconsSourceActivateResult {
    return Object.freeze({
      error: errorValue,
      id,
      ok: false,
      state: this.snapshot(),
    });
  }

  #freezeState(): DesktopIconsSourceState {
    const iconState = this.#iconModel.snapshot();
    const directoryInput: {
      entries: readonly DesktopIconsSourceDirectoryIcon[];
      path: string;
      status: DesktopIconsSourceStatus;
      error?: DesktopIconsSourceError;
    } = {
      entries: Object.freeze(this.#directoryEntries.map(freezeDirectoryIcon)),
      path: this.#desktopPath,
      status: this.#directoryStatus,
    };
    const launchersInput: {
      apps: readonly DesktopIconsSourceLauncherIcon[];
      status: DesktopIconsSourceStatus;
      error?: DesktopIconsSourceError;
    } = {
      apps: Object.freeze(this.#launcherApps.map(freezeLauncherIcon)),
      status: this.#launcherStatus,
    };

    if (this.#directoryError !== undefined) directoryInput.error = this.#directoryError;
    if (this.#launcherError !== undefined) launchersInput.error = this.#launcherError;

    return Object.freeze({
      directory: Object.freeze(directoryInput),
      icons: iconState.icons,
      iconState,
      launchers: Object.freeze(launchersInput),
    });
  }
}

function directoryIconsFromEntries(
  desktopPath: string,
  entries: readonly FilesEntry[],
): readonly DesktopIconsSourceDirectoryIcon[] {
  const output: DesktopIconsSourceDirectoryIcon[] = [];

  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];

    if (entry === undefined) continue;

    const path = joinCapabilityPath(desktopPath, entry.name);
    output.push(freezeDirectoryIcon({
      iconRef: directoryIconRef(entry.kind),
      id: desktopDirectoryEntryIconId(path),
      kind: entry.kind,
      label: entry.name,
      modified: entry.mtime,
      path,
      size: entry.size,
    }));
  }

  return Object.freeze(output);
}

function entriesFromDirectoryIcons(
  icons: readonly DesktopIconsSourceDirectoryIcon[],
): readonly FilesEntry[] {
  const output: FilesEntry[] = [];

  for (let index = 0; index < icons.length; index += 1) {
    const icon = icons[index];

    if (icon === undefined) continue;
    output.push(Object.freeze({
      kind: icon.kind,
      mtime: icon.modified,
      name: icon.label,
      size: icon.size,
    }));
  }

  return Object.freeze(output);
}

function iconInputs(
  directoryEntries: readonly DesktopIconsSourceDirectoryIcon[],
  launchers: readonly DesktopIconsSourceLauncherIcon[],
  currentIcons: readonly DesktopIcon[],
  grid: DesktopIconGridConfig,
): readonly DesktopIconInput[] {
  const descriptors: DesktopIconInput[] = [];

  for (let index = 0; index < directoryEntries.length; index += 1) {
    const entry = directoryEntries[index];

    if (entry === undefined) continue;
    descriptors.push(iconInputFromDirectory(entry, currentIcons, descriptors.length, grid));
  }

  for (let index = 0; index < launchers.length; index += 1) {
    const launcher = launchers[index];

    if (launcher === undefined) continue;
    descriptors.push(iconInputFromLauncher(launcher, currentIcons, descriptors.length, grid));
  }

  return Object.freeze(descriptors);
}

function iconInputFromDirectory(
  entry: DesktopIconsSourceDirectoryIcon,
  currentIcons: readonly DesktopIcon[],
  index: number,
  grid: DesktopIconGridConfig,
): DesktopIconInput {
  return freezeIconInput({
    date: entry.modified,
    iconRef: entry.iconRef,
    id: entry.id,
    kind: entry.kind,
    label: entry.label,
    position: existingPosition(currentIcons, entry.id) ?? gridCellToPixel({
      col: index % grid.columns,
      row: Math.floor(index / grid.columns),
    }, grid),
    size: entry.size,
  });
}

function iconInputFromLauncher(
  launcher: DesktopIconsSourceLauncherIcon,
  currentIcons: readonly DesktopIcon[],
  index: number,
  grid: DesktopIconGridConfig,
): DesktopIconInput {
  return freezeIconInput({
    iconRef: launcher.iconRef,
    id: launcher.id,
    kind: launcher.kind,
    label: launcher.label,
    position: existingPosition(currentIcons, launcher.id) ?? gridCellToPixel({
      col: index % grid.columns,
      row: Math.floor(index / grid.columns),
    }, grid),
  });
}

function existingPosition(
  icons: readonly DesktopIcon[],
  id: string,
): DesktopIcon["position"] | undefined {
  for (let index = 0; index < icons.length; index += 1) {
    const icon = icons[index];

    if (icon !== undefined && icon.id === id) return icon.position;
  }

  return undefined;
}

function findLauncher(
  launchers: readonly DesktopIconsSourceLauncherIcon[],
  id: string,
): DesktopIconsSourceLauncherIcon | undefined {
  for (let index = 0; index < launchers.length; index += 1) {
    const launcher = launchers[index];

    if (launcher !== undefined && launcher.id === id) return launcher;
  }

  return undefined;
}

function findApp(
  apps: readonly IndexDockAppDefinition[],
  appId: string,
): IndexDockAppDefinition | undefined {
  for (let index = 0; index < apps.length; index += 1) {
    const app = apps[index];

    if (app !== undefined && app.appId === appId) return app;
  }

  return undefined;
}

function freezeIconInput(input: DesktopIconInput): DesktopIconInput {
  const output: {
    date?: number | string;
    iconRef: string;
    id: string;
    kind: string;
    label: string;
    position: DesktopIconInput["position"];
    size?: number;
  } = {
    iconRef: input.iconRef,
    id: input.id,
    kind: input.kind,
    label: input.label,
    position: Object.freeze({
      x: Math.trunc(input.position.x),
      y: Math.trunc(input.position.y),
    }),
  };

  if (input.date !== undefined) output.date = input.date;
  if (input.size !== undefined) output.size = input.size;

  return Object.freeze(output);
}

function freezeDirectoryIcon(input: DesktopIconsSourceDirectoryIcon): DesktopIconsSourceDirectoryIcon {
  return Object.freeze({
    iconRef: input.iconRef,
    id: input.id,
    kind: input.kind,
    label: input.label,
    modified: input.modified,
    path: input.path,
    size: input.size,
  });
}

function freezeLauncherIcon(input: DesktopIconsSourceLauncherIcon): DesktopIconsSourceLauncherIcon {
  return Object.freeze({
    appId: input.appId,
    iconRef: input.iconRef,
    id: input.id,
    kind: "launcher",
    label: input.label,
  });
}

function directoryIconRef(kind: FilesEntry["kind"]): string {
  if (kind === "dir") return "desktop:folder";
  if (kind === "file") return "desktop:file";

  return "desktop:symlink-skipped";
}

function sourceError(
  input: AppError,
  fallbackCode: DesktopIconsSourceError["code"],
): DesktopIconsSourceError {
  if (input.code === "AccessForbidden") {
    return error("FILES_READ_DENIED", input.message, input.path);
  }

  return error(fallbackCode, input.message, input.path);
}

function activationError(input: AppError | undefined): DesktopIconsSourceError {
  if (input === undefined) {
    return error(
      "FILES_ACTIVATION_DENIED",
      "files activation failed closed.",
      "/files",
    );
  }

  return sourceError(input, "FILES_ACTIVATION_DENIED");
}

function hostError(input: DesktopHostError): DesktopIconsSourceError {
  return error("LAUNCHER_ACTIVATION_DENIED", input.message, input.path);
}

function filesReadDenied(grant: string): DesktopIconsSourceError {
  return error(
    "MISSING_FILES_GRANT",
    `desktop icon source requires files.read for grant '${grant}'.`,
    "/capabilityGrants/files.read",
  );
}

function launcherDenied(): DesktopIconsSourceError {
  return error(
    "MISSING_LAUNCHER_GRANT",
    "desktop icon source requires launcher.launch for pinned launchers.",
    "/capabilityGrants/launcher.launch",
  );
}

function error(
  code: DesktopIconsSourceError["code"],
  message: string,
  path: string,
): DesktopIconsSourceError {
  return Object.freeze({
    code,
    message,
    path,
  });
}

function isDirectoryIconId(id: string): boolean {
  return id.startsWith(DIRECTORY_ICON_ID_PREFIX);
}

function isLauncherIconId(id: string): boolean {
  return id.startsWith(LAUNCHER_ICON_ID_PREFIX);
}

function launcherAppIdFromIconId(id: string): string {
  return id.slice(LAUNCHER_ICON_ID_PREFIX.length);
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

  return token;
}
