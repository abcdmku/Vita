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
  createAppWindowHost,
} from "./app-window-host.ts";
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
import {
  createBinder,
} from "./binder.ts";
import type {
  VitaBinder,
  VitaElement,
  VitaElementList,
} from "./binder.ts";
import type {
  ScreenModule,
} from "./screen.ts";
import {
  createStatusbarClockViewModel,
} from "../viewmodels/statusbar-clock.ts";
import type {
  StatusbarClockDisplay,
  StatusbarClockTickResult,
  StatusbarClockViewModel,
} from "../viewmodels/statusbar-clock.ts";

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
  readonly statusbarClock?: StatusbarClockBootstrapOptions;
  readonly transport?: SurfaceHostTransportLike;
}

export interface DesktopHydrationRuntime {
  readonly screens: readonly HydratedScreen[];
  dispose(): void;
}

export interface StatusbarClockBootstrapOptions {
  readonly initialNow?: Date | number;
  readonly intervalMs?: number;
  readonly now?: () => Date | number;
  readonly scheduler?: StatusbarClockScheduler;
}

export interface StatusbarClockScheduler {
  setInterval(callback: () => void, intervalMs: number): unknown;
  clearInterval(handle: unknown): void;
}

const SCREEN_SELECTOR = "[data-vita-screen]";
const STATUSBAR_CLOCK_INTERVAL_MS = 1000;
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
const STATUSBAR_CLOCK_BINDS = new Map<string, (snapshot: StatusbarClockDisplay) => string>([
  ["statusbar.date", (snapshot) => snapshot.date],
  ["statusbar.time", (snapshot) => snapshot.time],
]);
const DEFAULT_STATUSBAR_CLOCK_SCHEDULER = Object.freeze({
  setInterval(callback: () => void, intervalMs: number): unknown {
    return globalThis.setInterval(callback, intervalMs);
  },
  clearInterval(handle: unknown): void {
    try {
      Reflect.apply(globalThis.clearInterval, globalThis, [handle]);
    } catch {
      return;
    }
  },
}) satisfies StatusbarClockScheduler;

export async function bootstrapDesktop(
  options: BootstrapOptions = Object.freeze({}),
): Promise<DesktopHydrationRuntime> {
  const modules = options.modules ?? DEFAULT_SCREEN_MODULES;
  const transport = options.host === undefined ? resolveTransport(options) : undefined;

  // ADR 0013 §3, lifecycle step (2): with no CEF<->host channel, run DEGRADED rather
  // than inert. `createSurfaceHost(undefined)` returns a fail-closed host (required
  // methods return {ok:false}; optional ports absent), so screens still hydrate and
  // LOCAL interactions (palette re-rank, selection, theme class toggles) + lucide icons
  // work in a plain browser while host actions fail closed. Previously this early-returned
  // an empty runtime, leaving the desktop inert with no signal — the silent-failure mode
  // the ADR explicitly warns against.
  const baseHost = options.host ?? createSurfaceHost(transport);

  // PSD-501: attach the app-window host so a NATIVE dock click opens a real surface populated via
  // the host bridge (Files/Mail/Editor/Settings/Activity). When a real document is present, the
  // index screen reads host.appWindow and opens windows on launch; otherwise the desktop hydrates
  // exactly as before (the field is simply absent). createSurfaceHost returns a frozen object, so
  // we extend a shallow copy rather than mutate it.
  const host = installAppWindowHost(baseHost, options);
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

  vitaDiag(`bootstrap: hydrated ${screens.length}/${roots.length} screens [${screens.map((s) => `${s.id}:${s.ok}`).join(",")}] appWindow=${"appWindow" in (host as object)}`);

  return runtime(screens, createStatusbarClockRuntime(roots, options.statusbarClock));
}

// Diagnostic: route a one-line status through the native __vitaLog (visible in CEF_LOG) so a real
// boot can confirm the desktop's NATIVE binder hydration ran. No-op outside CEF.
function vitaDiag(line: string): void {
  try {
    const log = (globalThis as Record<string, unknown>)["__vitaLog"];

    if (typeof log === "function") (log as (s: string) => void)(`VITA-HYDRATE ${line}`);
  } catch {
    // ignore
  }
}

export async function bootstrapDesktopFromGlobal(
  modules: readonly ScreenModule[] = DEFAULT_SCREEN_MODULES,
): Promise<DesktopHydrationRuntime> {
  return await bootstrapDesktop({
    global: defaultGlobal(),
    modules,
  });
}

void bootstrapDesktopFromGlobal().catch((error: unknown) => {
  vitaDiag(`bootstrap THREW: ${error instanceof Error ? error.message : String(error)}`);
});

function runtime(
  screens: readonly HydratedScreen[],
  statusbarClock: Pick<DesktopHydrationRuntime, "dispose">,
): DesktopHydrationRuntime {
  const frozenScreens = Object.freeze([...screens]);
  let disposed = false;

  return Object.freeze({
    screens: frozenScreens,
    dispose(): void {
      if (disposed) return;
      disposed = true;

      statusbarClock.dispose();
      for (let index = 0; index < frozenScreens.length; index += 1) {
        disposeScreen(frozenScreens[index]);
      }
    },
  });
}

function createStatusbarClockRuntime(
  roots: readonly VitaElement[],
  options: StatusbarClockBootstrapOptions | undefined,
): Pick<DesktopHydrationRuntime, "dispose"> {
  const binders = createStatusbarClockBinders(roots);

  if (binders.length === 0) return emptyDisposable();

  const viewModel = createStatusbarClockViewModel({
    initialNow: initialStatusbarNow(options),
  });
  renderStatusbarClock(binders, viewModel.snapshot());
  const handle = startStatusbarClockInterval(binders, viewModel, options);
  let disposed = false;

  return Object.freeze({
    dispose(): void {
      if (disposed) return;
      disposed = true;

      if (handle !== undefined) {
        const scheduler = options?.scheduler ?? DEFAULT_STATUSBAR_CLOCK_SCHEDULER;

        scheduler.clearInterval(handle);
      }

      for (let index = 0; index < binders.length; index += 1) {
        binders[index]?.dispose();
      }
    },
  });
}

function emptyDisposable(): Pick<DesktopHydrationRuntime, "dispose"> {
  return Object.freeze({
    dispose(): void {},
  });
}

function createStatusbarClockBinders(
  roots: readonly VitaElement[],
): readonly VitaBinder<StatusbarClockDisplay>[] {
  const output: VitaBinder<StatusbarClockDisplay>[] = [];

  for (let index = 0; index < roots.length; index += 1) {
    const root = roots[index];

    if (root === undefined) continue;

    try {
      const binder = createBinder(root, {
        binds: STATUSBAR_CLOCK_BINDS,
      });

      if (hasStatusbarClockTarget(binder)) {
        output.push(binder);
      } else {
        binder.dispose();
      }
    } catch {
      continue;
    }
  }

  return Object.freeze(output);
}

function hasStatusbarClockTarget(binder: VitaBinder<StatusbarClockDisplay>): boolean {
  for (let index = 0; index < binder.targets.text.length; index += 1) {
    const target = binder.targets.text[index];
    const bindId = target?.bindId;

    if (bindId === "statusbar.time" || bindId === "statusbar.date") return true;
  }

  return false;
}

function renderStatusbarClock(
  binders: readonly VitaBinder<StatusbarClockDisplay>[],
  snapshot: StatusbarClockDisplay,
): void {
  for (let index = 0; index < binders.length; index += 1) {
    binders[index]?.render(snapshot);
  }
}

function startStatusbarClockInterval(
  binders: readonly VitaBinder<StatusbarClockDisplay>[],
  viewModel: StatusbarClockViewModel,
  options: StatusbarClockBootstrapOptions | undefined,
): unknown | undefined {
  const scheduler = options?.scheduler ?? DEFAULT_STATUSBAR_CLOCK_SCHEDULER;
  const intervalMs = normalizeStatusbarIntervalMs(options?.intervalMs);

  try {
    return scheduler.setInterval(() => {
      const ticked = viewModel.tick(readStatusbarNow(options));

      if (isStatusbarClockTickDisplay(ticked)) {
        renderStatusbarClock(binders, ticked);
      }
    }, intervalMs);
  } catch {
    return undefined;
  }
}

function isStatusbarClockTickDisplay(
  result: StatusbarClockTickResult,
): result is StatusbarClockDisplay {
  return !("ok" in result);
}

function initialStatusbarNow(options: StatusbarClockBootstrapOptions | undefined): Date | number {
  return options?.initialNow ?? readStatusbarNow(options);
}

function readStatusbarNow(options: StatusbarClockBootstrapOptions | undefined): Date | number {
  const now = options?.now;

  if (now !== undefined) {
    try {
      return now();
    } catch {
      return Number.NaN;
    }
  }

  return Date.now();
}

function normalizeStatusbarIntervalMs(input: number | undefined): number {
  return input !== undefined && Number.isFinite(input) && input > 0
    ? input
    : STATUSBAR_CLOCK_INTERVAL_MS;
}

function installAppWindowHost(host: DesktopHost, options: BootstrapOptions): DesktopHost {
  // Only meaningful with a live DOM (the window host creates elements). In headless tests there is
  // no real document, so we return the host unchanged and the index screen omits the appWindow port.
  const globalObject = options.global ?? defaultGlobal();
  const documentValue = readOwnAny(globalObject, "document");

  if (!isLiveDocument(documentValue)) return host;

  try {
    const appWindow = createAppWindowHost(host, documentValue as never);

    return Object.freeze({ ...host, appWindow }) as DesktopHost;
  } catch {
    return host;
  }
}

function isLiveDocument(value: unknown): boolean {
  if (value === null || typeof value !== "object") return false;

  try {
    return typeof Reflect.get(value, "createElement") === "function" &&
      typeof Reflect.get(value, "getElementById") === "function";
  } catch {
    return false;
  }
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
  // Browsers expose `window.document` as an OWN accessor (getter), not a data
  // property, so read both shapes: prefer an own data value, else invoke an own
  // accessor's getter. We stay within OWN properties of the global (no prototype
  // walk) and validate the result structurally, preserving the fail-closed posture.
  const document = readOwnAny(globalObject, "document");

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

// Like readOwnData but also resolves an OWN accessor property by invoking its
// getter (browsers expose `window.document` this way). Still OWN-only — no
// prototype walk — so it cannot pick up inherited or injected-prototype traps.
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

function isObjectRecord(value: unknown): value is BootstrapGlobal {
  return value !== null && typeof value === "object";
}
