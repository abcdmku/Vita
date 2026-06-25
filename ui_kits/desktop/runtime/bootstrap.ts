import type {
  DesktopHost,
} from "../../../sdk/typescript/src/desktop-sdk/index.ts";
import activityScreen from "../screens/activity.ts";
import filesScreen from "../screens/files.ts";
import indexScreen from "../screens/index.ts";
import lockScreen from "../screens/lock.ts";
import notificationsScreen from "../screens/notifications.ts";
import settingsScreen from "../screens/settings.ts";
import shellScreen from "../screens/shell.ts";
import tilingScreen from "../screens/tiling.ts";
import {
  createSurfaceHost,
} from "./host-bridge.ts";
import type {
  SurfaceHostTransportLike,
} from "./host-bridge.ts";
import {
  disposeScreen,
  hydrateScreen,
} from "./hydrate.ts";
import type {
  HydratedScreen,
} from "./hydrate.ts";
import type {
  VitaElement,
  VitaElementList,
} from "./binder.ts";
import type {
  ScreenModule,
} from "./screen.ts";

export interface BootstrapDocument {
  readonly body?: VitaElement | null;
  querySelectorAll(selector: string): VitaElementList;
}

export interface BootstrapGlobal {
  readonly [key: string]: unknown;
}

export interface BootstrapOptions {
  readonly document?: BootstrapDocument;
  readonly global?: BootstrapGlobal;
  readonly host?: DesktopHost;
  readonly modules?: readonly ScreenModule[];
  readonly root?: VitaElement;
  readonly transport?: SurfaceHostTransportLike;
}

export interface DesktopHydrationRuntime {
  readonly screens: readonly HydratedScreen[];
  dispose(): void;
}

const SCREEN_SELECTOR = "[data-vita-screen]";
const DEFAULT_SCREEN_MODULES = Object.freeze([
  indexScreen,
  settingsScreen,
  filesScreen,
  shellScreen,
  activityScreen,
  notificationsScreen,
  lockScreen,
  tilingScreen,
]) satisfies readonly ScreenModule[];
const TRANSPORT_GLOBALS = Object.freeze([
  "vitaDesktopBridge",
  "vitaHostBridge",
  "vitaBridge",
  "__vitaDesktopBridge",
] as const);

export async function bootstrapDesktop(
  options: BootstrapOptions = Object.freeze({}),
): Promise<DesktopHydrationRuntime> {
  const modules = options.modules ?? DEFAULT_SCREEN_MODULES;
  const transport = options.host === undefined ? resolveTransport(options) : undefined;

  if (options.host === undefined && transport === undefined) return runtime(Object.freeze([]));

  const host = options.host ?? createSurfaceHost(transport);
  const roots = selectScreenRoots(options);
  const screens: HydratedScreen[] = [];

  for (let index = 0; index < roots.length; index += 1) {
    const root = roots[index];

    if (root === undefined) continue;

    const screenId = screenIdForRoot(root);
    const module = screenId === undefined ? undefined : findScreenModule(modules, screenId);

    if (screenId === undefined || module === undefined) continue;

    try {
      screens.push(await hydrateScreen(root, module, host));
    } catch {
      continue;
    }
  }

  return runtime(screens);
}

export async function bootstrapDesktopFromGlobal(
  modules: readonly ScreenModule[] = DEFAULT_SCREEN_MODULES,
): Promise<DesktopHydrationRuntime> {
  return await bootstrapDesktop({
    global: defaultGlobal(),
    modules,
  });
}

void bootstrapDesktopFromGlobal().catch(() => {});

function runtime(screens: readonly HydratedScreen[]): DesktopHydrationRuntime {
  const frozenScreens = Object.freeze([...screens]);
  let disposed = false;

  return Object.freeze({
    screens: frozenScreens,
    dispose(): void {
      if (disposed) return;
      disposed = true;

      for (let index = 0; index < frozenScreens.length; index += 1) {
        disposeScreen(frozenScreens[index]);
      }
    },
  });
}

function resolveTransport(options: BootstrapOptions): Exclude<SurfaceHostTransportLike, null | undefined> | undefined {
  if (options.transport !== undefined && isTransportLike(options.transport)) return options.transport;

  const globalObject = options.global ?? defaultGlobal();

  for (let index = 0; index < TRANSPORT_GLOBALS.length; index += 1) {
    const key = TRANSPORT_GLOBALS[index];
    const value = key === undefined ? undefined : readOwnData(globalObject, key);

    if (value !== undefined && isTransportLike(value)) return value;
  }

  return undefined;
}

function selectScreenRoots(options: BootstrapOptions): readonly VitaElement[] {
  if (options.root !== undefined) return Object.freeze([options.root]);

  const document = options.document ?? documentFromGlobal(options.global ?? defaultGlobal());

  if (document === undefined) return Object.freeze([]);

  const roots = elementsFromDocument(document, SCREEN_SELECTOR);

  if (roots.length > 0) return roots;

  const body = document.body;

  if (body !== undefined && body !== null && screenIdForRoot(body) !== undefined) {
    return Object.freeze([body]);
  }

  return Object.freeze([]);
}

function elementsFromDocument(document: BootstrapDocument, selector: string): readonly VitaElement[] {
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

function screenIdForRoot(root: VitaElement): string | undefined {
  try {
    const id = root.dataset.vitaScreen ?? root.dataset.vitaScreenId;

    return typeof id === "string" && id.length > 0 ? id : undefined;
  } catch {
    return undefined;
  }
}

function findScreenModule(
  modules: readonly ScreenModule[],
  id: string,
): ScreenModule | undefined {
  for (let index = 0; index < modules.length; index += 1) {
    const module = modules[index];

    try {
      if (module !== undefined && module.id === id) return module;
    } catch {
      continue;
    }
  }

  return undefined;
}

function documentFromGlobal(globalObject: BootstrapGlobal): BootstrapDocument | undefined {
  const document = readOwnData(globalObject, "document");

  return isBootstrapDocument(document) ? document : undefined;
}

function defaultGlobal(): BootstrapGlobal {
  const value: unknown = globalThis;

  return isObjectRecord(value) ? value : Object.freeze({});
}

function isBootstrapDocument(value: unknown): value is BootstrapDocument {
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

function isObjectRecord(value: unknown): value is BootstrapGlobal {
  return value !== null && typeof value === "object";
}
