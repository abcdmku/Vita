import { hasDesktopCapabilityGrant } from "../../../sdk/typescript/src/desktop-sdk/index.ts";
import type {
  AppWindowHints,
  DesktopAppLaunch,
  DesktopHost,
  DesktopHostError,
  DesktopHostResult,
  DesktopLaunchableApp,
  TsxComponentRef,
  WebviewRuntimeRef,
} from "../../../sdk/typescript/src/desktop-sdk/index.ts";

export const INDEX_DOCK_APP_IDS = Object.freeze({
  browser: "vita.app.browser",
  code: "vita.app.code",
  files: "vita.app.file-manager",
  mail: "vita.app.mail",
  settings: "vita.app.settings",
  terminal: "vita.app.terminal",
});

export type IndexDockAppId = typeof INDEX_DOCK_APP_IDS[keyof typeof INDEX_DOCK_APP_IDS];
export type IndexDockIcon = "terminal" | "code" | "folder" | "mail" | "globe" | "settings";

export interface IndexDockAppDefinition {
  readonly appId: IndexDockAppId;
  readonly title: string;
  readonly icon: IndexDockIcon;
  readonly app: DesktopLaunchableApp;
}

export interface IndexDockItem {
  readonly appId: IndexDockAppId;
  readonly title: string;
  readonly icon: IndexDockIcon;
  readonly pinned: true;
  readonly running: boolean;
  readonly focused: boolean;
}

export interface IndexDockState {
  readonly items: readonly IndexDockItem[];
  readonly focusedAppId: IndexDockAppId | null;
}

export interface IndexDockError {
  readonly code: string;
  readonly message: string;
  readonly path: string;
}

export type IndexDockActionResult =
  | {
      readonly ok: true;
      readonly dispatch: "launchApp";
      readonly appId: IndexDockAppId;
      readonly value: DesktopAppLaunch;
      readonly state: IndexDockState;
    }
  | {
      readonly ok: true;
      readonly dispatch: "focus";
      readonly appId: IndexDockAppId;
      readonly state: IndexDockState;
    }
  | {
      readonly ok: false;
      readonly error: IndexDockError;
      readonly state: IndexDockState;
      readonly appId?: string;
    };

export interface IndexDockViewModel {
  readonly apps: readonly IndexDockAppDefinition[];
  snapshot(): IndexDockState;
  launchOrFocus(appId: string): Promise<IndexDockActionResult>;
  isRunning(appId: string): boolean;
}

export type IndexDockPorts = Pick<DesktopHost, "package" | "launchApp">;

export const DEFAULT_INDEX_DOCK_APPS: readonly IndexDockAppDefinition[] = freezeDefinitions([
  dockApp(INDEX_DOCK_APP_IDS.terminal, "Terminal", "terminal"),
  dockApp(INDEX_DOCK_APP_IDS.code, "Code", "code"),
  dockApp(INDEX_DOCK_APP_IDS.files, "Files", "folder"),
  dockApp(INDEX_DOCK_APP_IDS.mail, "Mail", "mail"),
  dockApp(INDEX_DOCK_APP_IDS.browser, "Browser", "globe"),
  dockApp(INDEX_DOCK_APP_IDS.settings, "Settings", "settings"),
]);

export function createDefaultIndexDockApps(): readonly IndexDockAppDefinition[] {
  return DEFAULT_INDEX_DOCK_APPS;
}

export function createIndexDockViewModel(
  ports: IndexDockPorts,
  apps: readonly IndexDockAppDefinition[] = DEFAULT_INDEX_DOCK_APPS,
): IndexDockViewModel {
  return new IndexDockModel(ports, apps);
}

class IndexDockModel implements IndexDockViewModel {
  readonly #ports: IndexDockPorts;
  readonly #apps: readonly IndexDockAppDefinition[];
  readonly #launches = new Map<IndexDockAppId, DesktopAppLaunch>();
  #focusedAppId: IndexDockAppId | null = null;
  #state: IndexDockState;

  constructor(ports: IndexDockPorts, apps: readonly IndexDockAppDefinition[]) {
    this.#ports = ports;
    this.#apps = freezeDefinitions(apps);
    this.#state = stateFromLifecycle(this.#apps, this.#launches, this.#focusedAppId);
  }

  get apps(): readonly IndexDockAppDefinition[] {
    return this.#apps;
  }

  snapshot(): IndexDockState {
    return this.#state;
  }

  async launchOrFocus(appId: string): Promise<IndexDockActionResult> {
    const definition = findDockApp(this.#apps, appId);

    if (definition === undefined) {
      return actionReject(error(
        "UNKNOWN_DOCK_APP",
        "dock app is not pinned on the index screen.",
        `/apps/${pathToken(appId)}`,
      ), this.#state, appId);
    }

    if (this.#launches.has(definition.appId)) {
      this.#focusedAppId = definition.appId;
      this.#state = stateFromLifecycle(this.#apps, this.#launches, this.#focusedAppId);

      return Object.freeze({
        appId: definition.appId,
        dispatch: "focus",
        ok: true,
        state: this.#state,
      });
    }

    if (!hasDesktopCapabilityGrant(this.#ports.package, "apps.launch", definition.app.id)) {
      return actionReject(error(
        "MISSING_CAPABILITY",
        `dock app '${definition.appId}' requires apps.launch.`,
        `/apps/${pathToken(definition.appId)}/capability`,
      ), this.#state, definition.appId);
    }

    let result: DesktopHostResult<DesktopAppLaunch>;

    try {
      result = await this.#ports.launchApp(definition.app);
    } catch {
      return actionReject(error(
        "APP_LAUNCH_PORT_FAILED",
        "app launch port failed closed.",
        `/apps/${pathToken(definition.appId)}/launchApp`,
      ), this.#state, definition.appId);
    }

    if (!result.ok) {
      return actionReject(hostError(result.error), this.#state, definition.appId);
    }

    if (result.value.app.id !== definition.appId) {
      return actionReject(error(
        "APP_LAUNCH_MISMATCH",
        "app launch port returned a different app id.",
        `/apps/${pathToken(definition.appId)}/launchApp/app/id`,
      ), this.#state, definition.appId);
    }

    this.#launches.set(definition.appId, result.value);
    this.#focusedAppId = definition.appId;
    this.#state = stateFromLifecycle(this.#apps, this.#launches, this.#focusedAppId);

    return Object.freeze({
      appId: definition.appId,
      dispatch: "launchApp",
      ok: true,
      state: this.#state,
      value: result.value,
    });
  }

  isRunning(appId: string): boolean {
    const definition = findDockApp(this.#apps, appId);

    return definition !== undefined && this.#launches.has(definition.appId);
  }
}

function stateFromLifecycle(
  apps: readonly IndexDockAppDefinition[],
  launches: ReadonlyMap<IndexDockAppId, DesktopAppLaunch>,
  focusedAppId: IndexDockAppId | null,
): IndexDockState {
  const items: IndexDockItem[] = [];

  for (let index = 0; index < apps.length; index += 1) {
    const app = apps[index];

    if (app === undefined) continue;

    const running = launches.has(app.appId);
    items.push(Object.freeze({
      appId: app.appId,
      focused: running && focusedAppId === app.appId,
      icon: app.icon,
      pinned: true,
      running,
      title: app.title,
    }));
  }

  return Object.freeze({
    focusedAppId,
    items: Object.freeze(items),
  });
}

function dockApp(
  appId: IndexDockAppId,
  title: string,
  icon: IndexDockIcon,
): IndexDockAppDefinition {
  return Object.freeze({
    app: tsxApp(appId, title),
    appId,
    icon,
    title,
  });
}

function tsxApp(id: IndexDockAppId, title: string): DesktopLaunchableApp {
  return Object.freeze({
    id,
    runtime: Object.freeze({
      componentId: id,
    }),
    surfaceKind: "tsx",
    title,
  });
}

function freezeDefinitions(apps: readonly IndexDockAppDefinition[]): readonly IndexDockAppDefinition[] {
  const output: IndexDockAppDefinition[] = [];

  for (let index = 0; index < apps.length; index += 1) {
    const app = apps[index];

    if (app !== undefined) {
      output.push(freezeDefinition(app));
    }
  }

  return Object.freeze(output);
}

function freezeDefinition(app: IndexDockAppDefinition): IndexDockAppDefinition {
  return Object.freeze({
    app: freezeLaunchableApp(app.app),
    appId: app.appId,
    icon: app.icon,
    title: app.title,
  });
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

function findDockApp(
  apps: readonly IndexDockAppDefinition[],
  appId: string,
): IndexDockAppDefinition | undefined {
  for (let index = 0; index < apps.length; index += 1) {
    const app = apps[index];

    if (app !== undefined && app.appId === appId) {
      return app;
    }
  }

  return undefined;
}

function actionReject(
  errorValue: IndexDockError,
  state: IndexDockState,
  appId?: string,
): IndexDockActionResult {
  const output: {
    ok: false;
    error: IndexDockError;
    state: IndexDockState;
    appId?: string;
  } = {
    error: errorValue,
    ok: false,
    state,
  };

  if (appId !== undefined) output.appId = appId;

  return Object.freeze(output);
}

function hostError(errorValue: DesktopHostError): IndexDockError {
  return error(errorValue.code, errorValue.message, errorValue.path);
}

function error(code: string, message: string, path: string): IndexDockError {
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

  return token;
}
