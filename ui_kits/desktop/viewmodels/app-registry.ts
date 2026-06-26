import { defineAppPackage } from "../../../sdk/typescript/src/desktop-sdk/index.ts";
import type {
  AppPackage,
  AppWindowHints,
  DesktopAppLaunch,
  DesktopAppStop,
  DesktopHost,
  DesktopHostError,
  DesktopLaunchableApp,
  TsxComponentRef,
  WebviewRuntimeRef,
} from "../../../sdk/typescript/src/desktop-sdk/index.ts";

export interface AppRegistryAppView {
  readonly id: string;
  readonly title: string;
  readonly version: string;
  readonly entry: string;
  readonly running: boolean;
  readonly surfaceId?: string;
  readonly windowId?: string;
  readonly textureId?: string;
}

export interface AppRegistrySnapshot {
  readonly apps: readonly AppRegistryAppView[];
}

export interface AppRegistryError {
  readonly code: string;
  readonly message: string;
  readonly path: string;
}

export type AppRegistryResult<T> =
  | {
      readonly ok: true;
      readonly value: T;
    }
  | {
      readonly ok: false;
      readonly error: AppRegistryError;
    };

export interface AppRegistryViewModel {
  readonly apps: readonly AppPackage[];
  snapshot(): AppRegistrySnapshot;
  list(): AppRegistryResult<readonly AppRegistryAppView[]>;
  launch(appId: string): Promise<AppRegistryResult<DesktopAppLaunch>>;
  stop(appId: string): Promise<AppRegistryResult<DesktopAppStop>>;
}

export type AppRegistryPorts = Pick<DesktopHost, "emitLauncherIntent" | "launchApp" | "stopApp">;

export function createAppRegistryViewModel(
  host: AppRegistryPorts,
  installedApps: readonly AppPackage[],
): AppRegistryViewModel {
  return new AppRegistryModel(host, installedApps);
}

class AppRegistryModel implements AppRegistryViewModel {
  readonly #host: AppRegistryPorts;
  readonly #apps: readonly AppPackage[];
  readonly #appsById = new Map<string, AppPackage>();
  readonly #launches = new Map<string, DesktopAppLaunch>();
  #snapshot: AppRegistrySnapshot;

  constructor(host: AppRegistryPorts, installedApps: readonly AppPackage[]) {
    this.#host = host;
    this.#apps = freezeInstalledApps(installedApps);

    for (let index = 0; index < this.#apps.length; index += 1) {
      const app = this.#apps[index];

      if (app === undefined) continue;
      if (this.#appsById.has(app.manifest.id)) {
        throw new TypeError(`DUPLICATE_APP_PACKAGE: installed app '${app.manifest.id}' is duplicated (/apps)`);
      }

      this.#appsById.set(app.manifest.id, app);
    }

    this.#snapshot = snapshotFromApps(this.#apps, this.#launches);
  }

  get apps(): readonly AppPackage[] {
    return this.#apps;
  }

  snapshot(): AppRegistrySnapshot {
    return this.#snapshot;
  }

  list(): AppRegistryResult<readonly AppRegistryAppView[]> {
    return accept(this.#snapshot.apps);
  }

  async launch(appId: string): Promise<AppRegistryResult<DesktopAppLaunch>> {
    const app = this.#appsById.get(appId);

    if (app === undefined) {
      return reject("UNKNOWN_APP", `app '${appId}' is not installed.`, `/apps/${pathToken(appId)}`);
    }
    if (this.#launches.has(appId)) {
      return reject("APP_ALREADY_RUNNING", `app '${appId}' is already running.`, `/apps/${pathToken(appId)}`);
    }

    let result: Awaited<ReturnType<AppRegistryPorts["launchApp"]>>;

    try {
      result = await this.#host.launchApp(app.descriptor);
    } catch {
      return reject("APP_LAUNCH_PORT_FAILED", "app launch port failed closed.", `/apps/${pathToken(appId)}/launchApp`);
    }

    if (!result.ok) return rejectFromHost(result.error);
    if (result.value.app.id !== appId) {
      return reject(
        "APP_LAUNCH_MISMATCH",
        "app launch port returned a different app id.",
        `/apps/${pathToken(appId)}/launchApp/app/id`,
      );
    }

    const launch = freezeLaunch(result.value);

    this.#launches.set(appId, launch);
    this.#snapshot = snapshotFromApps(this.#apps, this.#launches);

    return accept(launch);
  }

  async stop(appId: string): Promise<AppRegistryResult<DesktopAppStop>> {
    if (!this.#launches.has(appId)) {
      return reject("APP_NOT_RUNNING", `app '${appId}' is not running.`, `/apps/${pathToken(appId)}`);
    }

    let result: Awaited<ReturnType<AppRegistryPorts["stopApp"]>>;

    try {
      result = await this.#host.stopApp(appId);
    } catch {
      return reject("APP_STOP_PORT_FAILED", "app stop port failed closed.", `/apps/${pathToken(appId)}/stopApp`);
    }

    if (!result.ok) return rejectFromHost(result.error);
    if (result.value.appId !== appId) {
      return reject(
        "APP_STOP_MISMATCH",
        "app stop port returned a different app id.",
        `/apps/${pathToken(appId)}/stopApp/appId`,
      );
    }

    const stopped = freezeStop(result.value);

    this.#launches.delete(appId);
    this.#snapshot = snapshotFromApps(this.#apps, this.#launches);

    return accept(stopped);
  }
}

function freezeInstalledApps(installedApps: readonly AppPackage[]): readonly AppPackage[] {
  const apps: AppPackage[] = [];

  for (let index = 0; index < installedApps.length; index += 1) {
    const app = installedApps[index];

    if (app !== undefined) {
      apps.push(defineAppPackage(app));
    }
  }

  apps.sort(compareAppPackages);

  return Object.freeze(apps);
}

function snapshotFromApps(
  apps: readonly AppPackage[],
  launches: ReadonlyMap<string, DesktopAppLaunch>,
): AppRegistrySnapshot {
  const views: AppRegistryAppView[] = [];

  for (let index = 0; index < apps.length; index += 1) {
    const app = apps[index];

    if (app === undefined) continue;
    views.push(freezeAppView(app, launches.get(app.manifest.id)));
  }

  return Object.freeze({
    apps: Object.freeze(views),
  });
}

function freezeAppView(
  app: AppPackage,
  launch: DesktopAppLaunch | undefined,
): AppRegistryAppView {
  const output: {
    id: string;
    title: string;
    version: string;
    entry: string;
    running: boolean;
    surfaceId?: string;
    windowId?: string;
    textureId?: string;
  } = {
    entry: app.manifest.entry,
    id: app.manifest.id,
    running: launch !== undefined,
    title: app.descriptor.title,
    version: app.manifest.version,
  };

  if (launch !== undefined) {
    output.surfaceId = launch.surfaceId;
    output.windowId = launch.windowId;
    output.textureId = launch.textureId;
  }

  return Object.freeze(output);
}

function freezeLaunch(launch: DesktopAppLaunch): DesktopAppLaunch {
  return Object.freeze({
    app: freezeLaunchableApp(launch.app),
    intents: Object.freeze([...launch.intents]),
    surfaceId: launch.surfaceId,
    textureId: launch.textureId,
    windowId: launch.windowId,
  });
}

function freezeStop(stop: DesktopAppStop): DesktopAppStop {
  const output: {
    appId: string;
    surfaceId?: string;
    windowId?: NonNullable<DesktopAppStop["windowId"]>;
    textureId?: string;
    intents: DesktopAppStop["intents"];
  } = {
    appId: stop.appId,
    intents: Object.freeze([...stop.intents]),
  };

  if (stop.surfaceId !== undefined) output.surfaceId = stop.surfaceId;
  if (stop.windowId !== undefined) output.windowId = stop.windowId;
  if (stop.textureId !== undefined) output.textureId = stop.textureId;

  return Object.freeze(output);
}

function freezeLaunchableApp(app: DesktopLaunchableApp): DesktopLaunchableApp {
  if (app.surfaceKind === "tsx") {
    const runtime: {
      componentId: string;
      props?: NonNullable<TsxComponentRef["props"]>;
    } = {
      componentId: app.runtime.componentId,
    };

    if (app.runtime.props !== undefined) runtime.props = app.runtime.props;

    const output: {
      id: string;
      title: string;
      surfaceKind: "tsx";
      runtime: TsxComponentRef;
      defaultWindow?: AppWindowHints;
    } = {
      id: app.id,
      runtime: Object.freeze(runtime),
      surfaceKind: "tsx",
      title: app.title,
    };

    if (app.defaultWindow !== undefined) output.defaultWindow = freezeWindowHints(app.defaultWindow);

    return Object.freeze(output);
  }

  const runtime: {
    url: string;
    partition?: string;
  } = {
    url: app.runtime.url,
  };

  if (app.runtime.partition !== undefined) runtime.partition = app.runtime.partition;

  const output: {
    id: string;
    title: string;
    surfaceKind: "web";
    runtime: WebviewRuntimeRef;
    defaultWindow?: AppWindowHints;
  } = {
    id: app.id,
    runtime: Object.freeze(runtime),
    surfaceKind: "web",
    title: app.title,
  };

  if (app.defaultWindow !== undefined) output.defaultWindow = freezeWindowHints(app.defaultWindow);

  return Object.freeze(output);
}

function freezeWindowHints(hints: AppWindowHints): AppWindowHints {
  const output: {
    workspaceId?: string;
    rect?: NonNullable<AppWindowHints["rect"]>;
    mode?: NonNullable<AppWindowHints["mode"]>;
    zone?: string;
    layer?: string;
    order?: number;
    anchor?: string;
    className?: string;
  } = {};

  if (hints.workspaceId !== undefined) output.workspaceId = hints.workspaceId;
  if (hints.rect !== undefined) {
    output.rect = Object.freeze({
      height: hints.rect.height,
      width: hints.rect.width,
      x: hints.rect.x,
      y: hints.rect.y,
    });
  }
  if (hints.mode !== undefined) output.mode = hints.mode;
  if (hints.zone !== undefined) output.zone = hints.zone;
  if (hints.layer !== undefined) output.layer = hints.layer;
  if (hints.order !== undefined) output.order = hints.order;
  if (hints.anchor !== undefined) output.anchor = hints.anchor;
  if (hints.className !== undefined) output.className = hints.className;

  return Object.freeze(output);
}

function compareAppPackages(left: AppPackage, right: AppPackage): number {
  if (left.manifest.id < right.manifest.id) return -1;
  if (left.manifest.id > right.manifest.id) return 1;

  return 0;
}

function accept<T>(value: T): AppRegistryResult<T> {
  return Object.freeze({
    ok: true,
    value,
  });
}

function reject<T>(code: string, message: string, path: string): AppRegistryResult<T> {
  return Object.freeze({
    error: Object.freeze({
      code,
      message,
      path,
    }),
    ok: false,
  });
}

function rejectFromHost<T>(error: DesktopHostError): AppRegistryResult<T> {
  return reject(error.code, error.message, error.path);
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
