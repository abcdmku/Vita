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
  AppContext,
  AppEventDetail,
  AppEventListener,
  AppLifecycleEvent,
  AppWindowController,
  VitaApp,
} from "./app-sdk.ts";
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

export function createAppWindowHost(
  host: DesktopHost,
  doc: WmDocument,
  options: AppWindowHostOptions = Object.freeze({}),
): AppWindowHost {
  const apps = options.apps ?? builtinAppRegistry();
  const wm = options.windowManager ?? createWindowManager(doc);
  const mounted = new Map<string, MountedApp>();

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

  return Object.freeze({
    async open(appId: string, _launch: DesktopAppLaunch): Promise<void> {
      const app = apps.get(appId);

      // Unknown app: open a managed window with an honest empty state (still a discoverable window).
      const seed = seedFor(app, appId);
      const handle = wm.launchOrFocus(appId, seed);

      // Already open → focus only (do not re-mount). launchOrFocus focused it above.
      if (mounted.has(appId)) return;

      const surfaceRoot = handle.bodyElement;

      if (surfaceRoot === null) return;

      if (app === undefined) {
        surfaceRoot.innerHTML = unknownAppBody(appId);
        return;
      }

      const listeners = new Map<AppLifecycleEvent, Set<AppEventListener>>();
      const record: MountedApp = { cleanup: undefined, handle, listeners };

      mounted.set(appId, record);

      // Wrap the handle's close so closing the window tears down the app. We override the WM's close
      // path by listening through the controller; the WM itself calls our teardown via the close
      // listener we register on the surface (below) — but the WM closes the DOM element on its own
      // red-dot path, so we also detect that by polling isOpen is overkill. Instead we rely on the
      // app calling requestClose, AND we hook the window's close by wrapping handle.close through the
      // controller. The simplest robust path: the controller.requestClose → handle.close → teardown.
      const ctx = buildContext(host, surfaceRoot, handle, record, () => teardown(appId));

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
  });
}

// Build the AppContext the desktop hands to mount(). The window controller maps app REQUESTS onto
// the WindowHandle; lifecycle `on()` registers listeners the host dispatches.
function buildContext(
  host: DesktopHost,
  surfaceRoot: WmElement,
  handle: WindowHandle,
  record: MountedApp,
  requestTeardown: () => void,
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

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}
