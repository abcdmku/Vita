// Vita desktop app-host SDK (Phase A) — the contract apps build against.
//
// THE MODEL (owner architecture direction): the CORE DESKTOP PACKAGE provides everything an app
// needs — window management, input routing, dark-themed chrome, and this app-host SDK. An app is a
// SMALL, SEPARATE module that exports a `VitaApp` (a manifest + a `mount` function) and is INJECTED
// into a desktop-provided, already-themed window surface. The app author never touches window
// chrome, drag/resize/close, z-order, or theming — they render into `ctx.surface.root` and use
// `ctx.host` (the real platform host bridge) for data. They get a real managed window for free.
//
// Decoupling: this file is the stable seam between the desktop (window-manager.ts, app-window-host.ts)
// and apps (runtime/apps/*.ts). It deliberately carries NO heavy DOM-`lib` dependency — the only DOM
// touchpoint is the structural `WmElement` surface root re-used from window-manager.ts, matching the
// rest of the runtime's portable `*Like` style so `npm run typecheck` stays clean.

import type {
  DesktopHost,
} from "../../../sdk/typescript/src/desktop-sdk/index.ts";
import type {
  WmElement,
} from "./window-manager.ts";

// ---------------------------------------------------------------------------------------------
// Manifest.
// ---------------------------------------------------------------------------------------------

// Capabilities an app declares it needs. These are advisory at the SDK layer (the real grant
// enforcement lives in the host bridge / app-registry); they let the desktop reason about an app
// and surface honest "backend unavailable" states when a capability isn't wired.
export type AppCapability =
  | "files.read"
  | "files.write"
  | "settings.read"
  | "settings.write"
  | "metrics.read"
  | "web.local";

// How the app gets its window. "managed" (the default) = the desktop provides a managed window and
// mounts the app into its body surface; the app never touches window chrome. "custom" reserves the
// path where an app registers its own window/surface. Custom is a STUB for now — the desktop still
// gives it a managed window (so every app keeps working); full custom-window support lands later.
export type AppWindowMode = "managed" | "custom";

export interface AppManifest {
  readonly id: string;
  readonly title: string;
  readonly icon: string; // emoji or glyph shown in the dock/title bar
  readonly capabilities: readonly AppCapability[];
  // Defaults to "managed" when omitted — see AppWindowMode.
  readonly window?: AppWindowMode;
}

// ---------------------------------------------------------------------------------------------
// Surface + window handles passed to an app.
// ---------------------------------------------------------------------------------------------

// The desktop-owned, dark-themed element the app renders into. It lives INSIDE the managed window's
// body; the app fully owns its inner content but never the surrounding chrome.
export interface AppSurface {
  readonly root: WmElement;
}

// What an app may ASK of its window. The desktop owns the chrome and may decline/defer, but these
// are the supported requests. Mirrors the platform "app proposes, desktop disposes" posture.
export interface AppWindowController {
  setTitle(title: string): void;
  setBadge(badge: string): void;
  requestClose(): void;
  requestFocus(): void;
  requestMaximize(): void;
  requestRestore(): void;
  readonly id: string;
}

// ---------------------------------------------------------------------------------------------
// Lifecycle events.
// ---------------------------------------------------------------------------------------------

export type AppLifecycleEvent = "close" | "resize" | "focus" | "visibility";

export interface AppResizeDetail {
  readonly width: number;
  readonly height: number;
}

export interface AppVisibilityDetail {
  readonly visible: boolean;
}

export interface AppFocusDetail {
  readonly focused: boolean;
}

export type AppEventDetail =
  | { readonly type: "close" }
  | { readonly type: "resize"; readonly detail: AppResizeDetail }
  | { readonly type: "focus"; readonly detail: AppFocusDetail }
  | { readonly type: "visibility"; readonly detail: AppVisibilityDetail };

export type AppEventListener = (detail: AppEventDetail) => void;

// ---------------------------------------------------------------------------------------------
// App context (the desktop hands this to mount).
// ---------------------------------------------------------------------------------------------

export interface AppContext {
  // Where to render. Desktop-owned, themed, inside the managed window.
  readonly surface: AppSurface;
  // The REAL platform APIs / host bridge: files, settings, metrics, theme, etc.
  readonly host: DesktopHost;
  // Ask the desktop about the window; the desktop owns the chrome.
  readonly window: AppWindowController;
  // Lifecycle subscription. Returns an unsubscribe.
  on(event: AppLifecycleEvent, callback: AppEventListener): () => void;
}

// ---------------------------------------------------------------------------------------------
// VitaApp — what an app module exports.
// ---------------------------------------------------------------------------------------------

// `mount` renders the app into `ctx.surface.root`, wires any behavior (delegated listeners, polling,
// etc.), and returns an OPTIONAL cleanup function the desktop calls on window close. Keep it small —
// a real app is a manifest + a mount in ~30 lines (see runtime/apps/* for examples).
export type AppCleanup = () => void;

export interface VitaApp {
  readonly manifest: AppManifest;
  mount(ctx: AppContext): AppCleanup | void;
}

// Convenience: assert a value is a VitaApp at the seam (frozen, mount present). Apps that come from
// dynamic registration can be validated here before the desktop tries to mount them.
export function isVitaApp(value: unknown): value is VitaApp {
  if (value === null || typeof value !== "object") return false;

  const manifest = (value as { manifest?: unknown }).manifest;
  const mount = (value as { mount?: unknown }).mount;

  if (manifest === null || typeof manifest !== "object" || typeof mount !== "function") return false;

  const id = (manifest as { id?: unknown }).id;

  return typeof id === "string" && id.length > 0;
}

// A tiny helper so an app file reads declaratively: `export default defineApp({ manifest, mount })`.
export function defineApp(app: VitaApp): VitaApp {
  // Spreading {...app.manifest} preserves the optional `window` mode; default to "managed".
  return Object.freeze({
    manifest: Object.freeze({
      ...app.manifest,
      capabilities: Object.freeze([...app.manifest.capabilities]),
      window: app.manifest.window ?? "managed",
    }),
    mount: app.mount,
  });
}
