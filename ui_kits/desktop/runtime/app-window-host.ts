// Desktop app-window host (PSD-501 native binder path, ADR-0013) — now WINDOW-MANAGER backed.
//
// When the user clicks a dock tile, the desktop's OWN binder fires `dock.launchOrFocus`, the index
// view-model calls `host.launchApp(app)` (the real host bridge), and on success the index screen
// asks THIS module to open a window for the launched app. This module:
//
//   1. Resolves the appId to a VitaApp (runtime/apps/*), and
//   2. Uses the WindowManager (window-manager.ts) to launchOrFocus a real MANAGED, DARK window, and
//   3. MOUNTS the VitaApp into that window's body surface (windowHandle.bodyElement as ctx.surface.root),
//      handing it a real AppContext (the same host bridge, a window controller backed by the
//      WindowHandle, and a lifecycle `on()`),
//   4. Calls the app's cleanup on window close.
//
// The old single reused fixed LIGHT div + inline light renderers are GONE: windows are real (drag /
// close / resize / focus / maximize) and dark-themed, and EVERY app is a VitaApp mounted into its
// own managed surface. The boot contract is preserved: the focused window carries id="vita-app-window"
// (ACTIVE_WINDOW_ID) so the boot self-test + live-input hit-test still discover an app window.

import type {
  DesktopAppLaunch,
  DesktopHost,
} from "../../../sdk/typescript/src/desktop-sdk/index.ts";
import {
  builtinAppRegistry,
} from "./apps/index.ts";
import type {
  AppConfigHandle,
  AppContext,
  AppEventDetail,
  AppEventListener,
  AppLifecycleEvent,
  AppWindowController,
  VitaApp,
} from "./app-sdk.ts";
import {
  createAppConfigHandle,
  readAppConfigBackend,
} from "./app-config.ts";
import {
  createAppContextMenu,
} from "./app-context-menu.ts";
import type {
  AppContextMenuController,
  AppMenuContext,
} from "./app-context-menu.ts";
import {
  renderSettingsWindow,
  wireSettingsForm,
} from "./settings-window.ts";
import type {
  SettingsFormWiring,
} from "./settings-window.ts";
import {
  createWindowManager,
} from "./window-manager.ts";
import type {
  WindowContent,
  WindowHandle,
  WindowManager,
  WmDocument,
  WmElement,
} from "./window-manager.ts";

export interface AppWindowHost {
  open(appId: string, launch: DesktopAppLaunch): Promise<void>;
  // Open the settings / Properties window for an app (right-click → Properties, or programmatic).
  openProperties(appId: string): void;
  // Open the reusable right-click context menu for an app, anchored at viewport (x, y). Returns true
  // if a menu was shown (a known app), else false.
  openContextMenu(appId: string, x: number, y: number): boolean;
  // Close an app's window (context-menu Close).
  closeApp(appId: string): void;
}

export interface AppWindowHostOptions {
  // Override the resolvable app set (tests). Defaults to the built-in first-party registry.
  readonly apps?: ReadonlyMap<string, VitaApp>;
  // Inject the window manager (tests). Defaults to a real WM over `doc`.
  readonly windowManager?: WindowManager;
}

// A mounted app instance — the live window handle, the app's cleanup, and its lifecycle listeners.
interface MountedApp {
  readonly handle: WindowHandle;
  readonly listeners: Map<AppLifecycleEvent, Set<AppEventListener>>;
  cleanup: (() => void) | undefined;
}

// Synthetic app-id prefix for a generated settings/Properties window so it lives in the WM registry
// without colliding with the real app it configures (the real app stays open behind it).
const SETTINGS_WINDOW_PREFIX = "vita.settings:";

// One-time guard flag so the title-bar contextmenu listener is added once per window (not on focus).
const CONTEXT_MENU_BRIDGE = Symbol.for("vita.appwindow.contextMenuBridge");

export function createAppWindowHost(
  host: DesktopHost,
  doc: WmDocument,
  options: AppWindowHostOptions = Object.freeze({}),
): AppWindowHost {
  const apps = options.apps ?? builtinAppRegistry();
  const wm = options.windowManager ?? createWindowManager(doc);
  const mounted = new Map<string, MountedApp>();
  const configBackend = readAppConfigBackend(host);
  // One config handle per app id, shared between the app's mount and its settings window so edits in
  // one are reflected in the other (onChange).
  const configHandles = new Map<string, AppConfigHandle>();
  // Live settings-window form wirings keyed by the synthetic settings app id (disposed on close).
  const settingsWirings = new Map<string, SettingsFormWiring>();

  function configFor(app: VitaApp): AppConfigHandle {
    const appId = app.manifest.id;
    const existing = configHandles.get(appId);

    if (existing !== undefined) return existing;

    const handle = createAppConfigHandle({
      appId,
      backend: configBackend,
      schema: app.manifest.config,
    });

    configHandles.set(appId, handle);
    return handle;
  }

  function dispatch(record: MountedApp, detail: AppEventDetail): void {
    const set = record.listeners.get(detail.type);

    if (set === undefined) return;

    for (const listener of [...set]) {
      try {
        listener(detail);
      } catch {
        // a misbehaving listener must not break window lifecycle.
      }
    }
  }

  function teardown(appId: string): void {
    const record = mounted.get(appId);

    if (record === undefined) return;

    mounted.delete(appId);

    // Notify the app it is closing, then run its cleanup.
    dispatch(record, Object.freeze({ type: "close" }));

    if (record.cleanup !== undefined) {
      try {
        record.cleanup();
      } catch {
        // ignore
      }
    }

    record.listeners.clear();
  }

  // The reusable right-click context menu (Properties / Close). Built lazily over the live doc.
  let contextMenu: AppContextMenuController | null = null;

  function ensureContextMenu(): AppContextMenuController {
    if (contextMenu === null) {
      contextMenu = createAppContextMenu(doc, {
        closeApp: (id) => closeAppWindow(id),
        openProperties: (id) => openPropertiesWindow(id),
      });
    }

    return contextMenu;
  }

  // Wire a `contextmenu` event on a window's title bar → the app context menu, preventing the native
  // browser menu. Registered once per window (a symbol flag on the handle guards against the
  // launch-or-FOCUS path re-adding the listener every click).
  function wireTitleBarContextMenu(appId: string, app: VitaApp | undefined, handle: WindowHandle): void {
    const flagged = handle as unknown as Record<symbol, boolean>;

    if (flagged[CONTEXT_MENU_BRIDGE] === true) return;

    const titlebar = safeQuery(handle.element, "[data-vita-window-titlebar]");

    if (titlebar === null) return;

    flagged[CONTEXT_MENU_BRIDGE] = true;

    const onContext = (event: unknown): void => {
      preventDefault(event);
      const { x, y } = pointerXY(event);

      ensureContextMenu().openFor(appMenuContext(appId, app), x, y);
    };

    try {
      titlebar.addEventListener("contextmenu", onContext as never);
    } catch {
      // ignore
    }
  }

  function appMenuContext(appId: string, app: VitaApp | undefined): AppMenuContext {
    return Object.freeze({
      appId,
      appTitle: app?.manifest.title ?? appId,
      open: wm.get(appId) !== undefined,
    });
  }

  function closeAppWindow(appId: string): void {
    const handle = wm.get(appId);

    if (handle !== undefined) handle.close();
  }

  // Open (or focus) a generated settings/Properties window for `appId`.
  function openPropertiesWindow(appId: string): void {
    const app = apps.get(appId);
    const settingsId = `${SETTINGS_WINDOW_PREFIX}${appId}`;
    const title = `${app?.manifest.title ?? appId} Properties`;
    const config = app === undefined ? undefined : configFor(app);

    const seed: WindowContent = Object.freeze({
      body: `<div style="padding:22px 16px;color:var(--text-faint)">Loading…</div>`,
      icon: app?.manifest.icon ?? "⚙",
      title,
    });

    const handle = wm.launchOrFocus(settingsId, seed);

    // Already open → focus only (launchOrFocus focused it above).
    if (settingsWirings.has(settingsId)) return;

    const surfaceRoot = handle.bodyElement;

    if (surfaceRoot === null) return;

    if (config === undefined) {
      surfaceRoot.innerHTML = unknownAppBody(appId);
      return;
    }

    const appTitle = app?.manifest.title ?? appId;
    const appIcon = app?.manifest.icon ?? "⚙";

    surfaceRoot.innerHTML = renderSettingsWindow({
      appIcon,
      appId,
      appTitle,
      schema: config.schema,
      snapshot: config.getAll(),
      tab: "form",
    });

    const wiring = wireSettingsForm({
      appIcon,
      appId,
      appTitle,
      config,
      root: surfaceRoot,
      setHtml: (html) => handle.setBody(html),
    });

    settingsWirings.set(settingsId, wiring);
    bridgeWindowClose(handle, () => {
      const live = settingsWirings.get(settingsId);

      if (live !== undefined) {
        settingsWirings.delete(settingsId);
        live.dispose();
      }
    });
  }

  return Object.freeze({
    closeApp(appId: string): void {
      closeAppWindow(appId);
    },
    openContextMenu(appId: string, x: number, y: number): boolean {
      const app = apps.get(appId);

      ensureContextMenu().openFor(appMenuContext(appId, app), x, y);
      return app !== undefined;
    },
    async open(appId: string, _launch: DesktopAppLaunch): Promise<void> {
      const app = apps.get(appId);

      // Unknown app: open a managed window with an honest empty state (still a discoverable window).
      const seed = seedFor(app, appId);
      const handle = wm.launchOrFocus(appId, seed);

      // Right-click on the title bar opens the app context menu (once per window).
      wireTitleBarContextMenu(appId, app, handle);

      // Already open → focus only (do not re-mount). launchOrFocus focused it above.
      if (mounted.has(appId)) return;

      const surfaceRoot = handle.bodyElement;

      if (surfaceRoot === null) return;

      if (app === undefined) {
        surfaceRoot.innerHTML = unknownAppBody(appId);
        return;
      }

      // WINDOW MODE — a real branch on the manifest field. "managed" applies the desktop's padded
      // inner chrome; "custom" hands the app a BARE surface (no desktop padding/background) so it can
      // paint edge-to-edge and own its inner chrome. Both still get the desktop's OUTER managed window.
      prepareSurfaceForMode(surfaceRoot, app.manifest.window ?? "managed");

      const listeners = new Map<AppLifecycleEvent, Set<AppEventListener>>();
      const record: MountedApp = { cleanup: undefined, handle, listeners };

      mounted.set(appId, record);

      // Wrap the handle's close so closing the window tears down the app. We override the WM's close
      // path by listening through the controller; the WM itself calls our teardown via the close
      // listener we register on the surface (below) — but the WM closes the DOM element on its own
      // red-dot path, so we also detect that by polling isOpen is overkill. Instead we rely on the
      // app calling requestClose, AND we hook the window's close by wrapping handle.close through the
      // controller. The simplest robust path: the controller.requestClose → handle.close → teardown.
      const ctx = buildContext(host, surfaceRoot, handle, record, () => teardown(appId), configFor(app));

      try {
        record.cleanup = normalizeCleanup(app.mount(ctx));
      } catch {
        // Mount failure must not break the dock lifecycle; show an honest empty state.
        surfaceRoot.innerHTML = unknownAppBody(appId);
        mounted.delete(appId);
      }

      // Bridge the WM's own close (red traffic-light dot) to app teardown: wrap handle.close once.
      bridgeWindowClose(handle, () => teardown(appId));
    },
    openProperties(appId: string): void {
      openPropertiesWindow(appId);
    },
  });
}

// WINDOW MODE branch. "custom" marks the surface bare (a data attr the app/desktop can key off and
// no desktop padding); "managed" leaves the default body styling. We never give an injected app a raw
// OS window — the desktop always owns the outer managed window — but the inner surface differs.
function prepareSurfaceForMode(surfaceRoot: WmElement, mode: "managed" | "custom"): void {
  try {
    if (mode === "custom") {
      surfaceRoot.setAttribute("data-vita-window-mode", "custom");
      // Bare surface: fill the body, no desktop padding/background; the app paints everything.
      surfaceRoot.style.setProperty("padding", "0");
      surfaceRoot.style.setProperty("background", "transparent");
    } else {
      surfaceRoot.setAttribute("data-vita-window-mode", "managed");
    }
  } catch {
    // ignore — surface styling is best-effort.
  }
}

// Build the AppContext the desktop hands to mount(). The window controller maps app REQUESTS onto
// the WindowHandle; lifecycle `on()` registers listeners the host dispatches.
function buildContext(
  host: DesktopHost,
  surfaceRoot: WmElement,
  handle: WindowHandle,
  record: MountedApp,
  requestTeardown: () => void,
  config: AppConfigHandle,
): AppContext {
  const controller: AppWindowController = Object.freeze({
    id: handle.id,
    requestClose(): void {
      handle.close();
    },
    requestFocus(): void {
      handle.focus();
    },
    requestMaximize(): void {
      // The WM owns maximize on the element; focus brings it forward (full maximize via the zoom dot).
      handle.focus();
    },
    requestRestore(): void {
      handle.focus();
    },
    setBadge(badge: string): void {
      setBadge(handle, badge);
    },
    setTitle(title: string): void {
      setTitle(handle, title);
    },
  });

  return Object.freeze({
    config,
    host,
    on(event: AppLifecycleEvent, callback: AppEventListener): () => void {
      let set = record.listeners.get(event);

      if (set === undefined) {
        set = new Set();
        record.listeners.set(event, set);
      }

      set.add(callback);

      return () => {
        record.listeners.get(event)?.delete(callback);
      };
    },
    surface: Object.freeze({ root: surfaceRoot }),
    window: controller,
  });
}

// Set the window title without re-rendering the whole frame: update the title caption + aria-label.
function setTitle(handle: WindowHandle, title: string): void {
  try {
    const el = handle.element.querySelector?.("[data-vita-window-title]");

    if (el !== null && el !== undefined) el.textContent = title;

    handle.element.setAttribute("aria-label", title);
  } catch {
    // ignore
  }
}

function setBadge(handle: WindowHandle, badge: string): void {
  try {
    const el = handle.element.querySelector?.("[data-vita-window-badge]");

    if (el !== null && el !== undefined) el.textContent = badge;
  } catch {
    // ignore
  }
}

// The WM's red-dot close calls handle.close() internally, which removes the element but does NOT
// know about app teardown. We wrap handle.close ONCE so any close path (app requestClose or the WM
// control) runs teardown. The wrapped flag lives on the handle object.
const CLOSE_BRIDGE = Symbol.for("vita.appwindow.closeBridge");

function bridgeWindowClose(handle: WindowHandle, onClose: () => void): void {
  const flagged = handle as unknown as Record<symbol, boolean>;

  if (flagged[CLOSE_BRIDGE] === true) return;

  flagged[CLOSE_BRIDGE] = true;

  const original = handle.close.bind(handle);
  const mutable = handle as unknown as { close: () => void };

  mutable.close = (): void => {
    onClose();
    original();
  };
}

function seedFor(app: VitaApp | undefined, appId: string): WindowContent {
  const title = app?.manifest.title ?? appId;
  const icon = app?.manifest.icon ?? "▢";

  return Object.freeze({
    body: `<div style="padding:22px 16px;color:var(--text-faint)">Loading…</div>`,
    icon,
    title,
  });
}

function unknownAppBody(appId: string): string {
  return (
    `<div style="padding:26px 16px;color:var(--text-faint);text-align:center">` +
    `<div style="font-size:13px;color:var(--text-muted);margin-bottom:6px">${escapeHtml(appId)} is empty</div>` +
    `<div style="font-size:12px">This app has no real backend yet.</div></div>`
  );
}

function normalizeCleanup(value: (() => void) | void): (() => void) | undefined {
  return typeof value === "function" ? value : undefined;
}

function safeQuery(root: WmElement, selector: string): WmElement | null {
  try {
    return root.querySelector?.(selector) ?? null;
  } catch {
    return null;
  }
}

// Stop the native browser context menu so our themed popup shows instead.
function preventDefault(event: unknown): void {
  try {
    const fn = (event as { preventDefault?: () => void }).preventDefault;

    if (typeof fn === "function") fn.call(event);
  } catch {
    // ignore
  }
}

// Read the viewport pointer coordinates off a contextmenu event (clientX/clientY), defaulting to 0.
function pointerXY(event: unknown): { x: number; y: number } {
  const e = event as { clientX?: unknown; clientY?: unknown };
  const x = typeof e.clientX === "number" && Number.isFinite(e.clientX) ? e.clientX : 0;
  const y = typeof e.clientY === "number" && Number.isFinite(e.clientY) ? e.clientY : 0;

  return { x, y };
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}
