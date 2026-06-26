import { hasDesktopCapabilityGrant } from "../../../sdk/typescript/src/desktop-sdk/index.ts";
import type {
  AppWindowHints,
  DesktopAppLaunch,
  DesktopAppStop,
  DesktopCapabilityGrant,
  DesktopHost,
  DesktopHostError,
  DesktopHostResult,
  DesktopLaunchableApp,
  DesktopLauncherIntent,
  TsxComponentRef,
  WebviewRuntimeRef,
} from "../../../sdk/typescript/src/desktop-sdk/index.ts";

export interface DesktopRegistryApp {
  readonly app: DesktopLaunchableApp;
  readonly title: string;
  readonly requiredGrants: readonly DesktopCapabilityGrant[];
}

export interface AppHostAppStatus {
  readonly appId: string;
  readonly title: string;
  readonly running: boolean;
  readonly focused: boolean;
  readonly launch?: DesktopAppLaunch;
}

export interface AppHostState {
  readonly apps: readonly AppHostAppStatus[];
  readonly focusedAppId: string | null;
}

export interface AppHostError {
  readonly code: string;
  readonly message: string;
  readonly path: string;
}

export type AppHostActionResult =
  | {
      readonly ok: true;
      readonly dispatch: "launchApp";
      readonly appId: string;
      readonly value: DesktopAppLaunch;
      readonly state: AppHostState;
    }
  | {
      readonly ok: true;
      readonly dispatch: "focus";
      readonly appId: string;
      readonly state: AppHostState;
    }
  | {
      readonly ok: true;
      readonly dispatch: "stop";
      readonly appId: string;
      readonly value: DesktopAppStop;
      readonly state: AppHostState;
    }
  | {
      readonly ok: false;
      readonly error: AppHostError;
      readonly state: AppHostState;
      readonly appId?: string;
    };

export interface AppHost {
  readonly apps: readonly DesktopRegistryApp[];
  readonly focusedAppId: string | null;
  snapshot(): AppHostState;
  launchOrFocus(appId: string): Promise<AppHostActionResult>;
  close(appId: string): Promise<AppHostActionResult>;
  applyLauncherIntent(intent: DesktopLauncherIntent): Promise<AppHostActionResult>;
  isRunning(appId: string): boolean;
}

export type AppHostPorts = Pick<DesktopHost, "package" | "launchApp" | "stopApp">;

export function createAppHost(
  ports: AppHostPorts,
  apps: readonly DesktopRegistryApp[],
): AppHost {
  return new AppHostModel(ports, apps);
}

class AppHostModel implements AppHost {
  readonly #ports: AppHostPorts;
  readonly #apps: readonly DesktopRegistryApp[];
  readonly #appsById = new Map<string, DesktopRegistryApp>();
  readonly #launches = new Map<string, DesktopAppLaunch>();
  #focusedAppId: string | null = null;
  #state: AppHostState;

  constructor(ports: AppHostPorts, apps: readonly DesktopRegistryApp[]) {
    this.#ports = ports;
    this.#apps = freezeRegistryApps(apps);

    for (let index = 0; index < this.#apps.length; index += 1) {
      const app = this.#apps[index];

      if (app === undefined) continue;
      if (this.#appsById.has(app.app.id)) {
        throw new TypeError(`DUPLICATE_APP: app '${app.app.id}' is duplicated (/apps)`);
      }

      this.#appsById.set(app.app.id, app);
    }

    this.#state = stateFromLifecycle(this.#apps, this.#launches, this.#focusedAppId);
  }

  get apps(): readonly DesktopRegistryApp[] {
    return this.#apps;
  }

  get focusedAppId(): string | null {
    return this.#focusedAppId;
  }

  snapshot(): AppHostState {
    return this.#state;
  }

  async launchOrFocus(appId: string): Promise<AppHostActionResult> {
    const app = this.#appsById.get(appId);

    if (app === undefined) {
      return actionReject(error(
        "UNKNOWN_APP",
        `app '${appId}' is not listed in the registry.`,
        `/apps/${pathToken(appId)}`,
      ), this.#state, appId);
    }

    if (this.#launches.has(appId)) {
      this.#focusedAppId = appId;
      this.#state = stateFromLifecycle(this.#apps, this.#launches, this.#focusedAppId);

      return Object.freeze({
        appId,
        dispatch: "focus",
        ok: true,
        state: this.#state,
      });
    }

    if (!hasDesktopCapabilityGrant(this.#ports.package, "apps.launch", app.app.id)) {
      return actionReject(error(
        "MISSING_CAPABILITY",
        `app '${appId}' requires apps.launch.`,
        `/apps/${pathToken(appId)}/capability`,
      ), this.#state, appId);
    }

    let result: DesktopHostResult<DesktopAppLaunch>;

    try {
      result = await this.#ports.launchApp(app.app);
    } catch {
      return actionReject(error(
        "APP_LAUNCH_PORT_FAILED",
        "app launch port failed closed.",
        `/apps/${pathToken(appId)}/launchApp`,
      ), this.#state, appId);
    }

    if (!result.ok) return actionReject(hostError(result.error), this.#state, appId);
    if (result.value.app.id !== appId) {
      return actionReject(error(
        "APP_LAUNCH_MISMATCH",
        "app launch port returned a different app id.",
        `/apps/${pathToken(appId)}/launchApp/app/id`,
      ), this.#state, appId);
    }

    const launch = freezeLaunch(result.value);

    this.#launches.set(appId, launch);
    this.#focusedAppId = appId;
    this.#state = stateFromLifecycle(this.#apps, this.#launches, this.#focusedAppId);

    return Object.freeze({
      appId,
      dispatch: "launchApp",
      ok: true,
      state: this.#state,
      value: launch,
    });
  }

  async close(appId: string): Promise<AppHostActionResult> {
    if (!this.#launches.has(appId)) {
      return actionReject(error(
        "APP_NOT_RUNNING",
        `app '${appId}' is not running.`,
        `/apps/${pathToken(appId)}`,
      ), this.#state, appId);
    }

    let result: DesktopHostResult<DesktopAppStop>;

    try {
      result = await this.#ports.stopApp(appId);
    } catch {
      return actionReject(error(
        "APP_STOP_PORT_FAILED",
        "app stop port failed closed.",
        `/apps/${pathToken(appId)}/stopApp`,
      ), this.#state, appId);
    }

    if (!result.ok) return actionReject(hostError(result.error), this.#state, appId);
    if (result.value.appId !== appId) {
      return actionReject(error(
        "APP_STOP_MISMATCH",
        "app stop port returned a different app id.",
        `/apps/${pathToken(appId)}/stopApp/appId`,
      ), this.#state, appId);
    }

    const stopped = freezeStop(result.value);

    this.#launches.delete(appId);
    if (this.#focusedAppId === appId) this.#focusedAppId = null;
    this.#state = stateFromLifecycle(this.#apps, this.#launches, this.#focusedAppId);

    return Object.freeze({
      appId,
      dispatch: "stop",
      ok: true,
      state: this.#state,
      value: stopped,
    });
  }

  async applyLauncherIntent(intent: DesktopLauncherIntent): Promise<AppHostActionResult> {
    if (intent.type === "launcher.launch" && intent.appId !== undefined && this.#appsById.has(intent.appId)) {
      return await this.launchOrFocus(intent.appId);
    }
    if (intent.type === "launcher.close" && intent.appId !== undefined && this.#appsById.has(intent.appId)) {
      return await this.close(intent.appId);
    }

    return actionReject(error(
      "UNKNOWN_LAUNCHER_INTENT",
      "launcher intent does not resolve to a listed app lifecycle action.",
      "/launcher",
    ), this.#state, intent.appId);
  }

  isRunning(appId: string): boolean {
    return this.#launches.has(appId);
  }
}

function stateFromLifecycle(
  apps: readonly DesktopRegistryApp[],
  launches: ReadonlyMap<string, DesktopAppLaunch>,
  focusedAppId: string | null,
): AppHostState {
  const focused = focusedAppId !== null && launches.has(focusedAppId) ? focusedAppId : null;
  const statuses: AppHostAppStatus[] = [];

  for (let index = 0; index < apps.length; index += 1) {
    const registryApp = apps[index];

    if (registryApp === undefined) continue;

    const appId = registryApp.app.id;
    const launch = launches.get(appId);
    const status: {
      appId: string;
      title: string;
      running: boolean;
      focused: boolean;
      launch?: DesktopAppLaunch;
    } = {
      appId,
      focused: launch !== undefined && focused === appId,
      running: launch !== undefined,
      title: registryApp.title,
    };

    if (launch !== undefined) status.launch = launch;
    statuses.push(Object.freeze(status));
  }

  return Object.freeze({
    apps: Object.freeze(statuses),
    focusedAppId: focused,
  });
}

function freezeRegistryApps(apps: readonly DesktopRegistryApp[]): readonly DesktopRegistryApp[] {
  const output: DesktopRegistryApp[] = [];

  for (let index = 0; index < apps.length; index += 1) {
    const app = apps[index];

    if (app !== undefined) output.push(freezeRegistryApp(app));
  }

  return Object.freeze(output);
}

function freezeRegistryApp(app: DesktopRegistryApp): DesktopRegistryApp {
  return Object.freeze({
    app: freezeLaunchableApp(app.app),
    requiredGrants: freezeCapabilityGrants(app.requiredGrants),
    title: app.title,
  });
}

function freezeCapabilityGrants(grants: readonly DesktopCapabilityGrant[]): readonly DesktopCapabilityGrant[] {
  const output: DesktopCapabilityGrant[] = [];

  for (let index = 0; index < grants.length; index += 1) {
    const grant = grants[index];

    if (grant === undefined) continue;

    const frozen: {
      capability: DesktopCapabilityGrant["capability"];
      resourceId?: string;
    } = {
      capability: grant.capability,
    };

    if (grant.resourceId !== undefined) frozen.resourceId = grant.resourceId;
    output.push(Object.freeze(frozen));
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

function actionReject(
  errorValue: AppHostError,
  state: AppHostState,
  appId?: string,
): AppHostActionResult {
  const output: {
    ok: false;
    error: AppHostError;
    state: AppHostState;
    appId?: string;
  } = {
    error: errorValue,
    ok: false,
    state,
  };

  if (appId !== undefined) output.appId = appId;

  return Object.freeze(output);
}

function hostError(errorValue: DesktopHostError): AppHostError {
  return error(errorValue.code, errorValue.message, errorValue.path);
}

function error(code: string, message: string, path: string): AppHostError {
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
