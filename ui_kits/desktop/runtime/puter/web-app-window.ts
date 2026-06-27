// Puter compat — the WEB-APP window host (mount an arbitrary web app into a managed WM window).
//
// Today only TS VitaApps mount into windows (app-window-host.ts). This is the keystone gap the spike
// closes: a NEW window kind that hosts an arbitrary web app in a sandboxed <iframe>, alongside VitaApp.
// It REUSES the WindowManager (launchOrFocus / drag / close / resize / focus / dark chrome) — the web
// app gets a real managed Vita window for free — and:
//   1. Mints a capability session for the app (token + instance id + grants),
//   2. Builds the launch URL with the puter.* params (api_origin → our local origin),
//   3. Creates a sandboxed iframe in the window body and points it at that URL,
//   4. Registers a broker reply target so `puter.ui.*` round-trips (READY → attach; replies carry
//      original_msg_id), and wires the broker sinks to THIS window's title / notifications.
//
// No DOM lib — structural `*Like` extensions of the WM's WmElement, house style. The iframe is sandboxed
// (allow-scripts allow-same-origin so the SDK can read same-origin params + reach the loopback origin;
// tighten on-device once the api_origin is cross-origin and CSP is enforced).

import {
  type AttachedAppTarget,
  type BrokerNotificationInput,
  type UiBroker,
} from "./ui-broker.ts";
import {
  type PuterCapability,
  type PuterCapabilityRegistry,
} from "./capability.ts";
import {
  buildLaunchUrl,
} from "./launch-url.ts";
import type {
  WindowContent,
  WindowManager,
  WmDocument,
  WmElement,
} from "../window-manager.ts";

// An iframe element surface (extends WmElement with the bits we set). Structural — the real browser
// HTMLIFrameElement satisfies it; a test stub can too.
export interface IframeLike extends WmElement {
  src: string;
  contentWindow?: unknown;
}

export interface WebAppWindowHost {
  // Open (or focus) a managed window hosting `spec.appUrl` as a Puter web app. Returns the instance id.
  open(spec: WebAppSpec): WebAppHandle;
  close(appId: string): void;
}

export interface WebAppSpec {
  // Stable app id (also the WM registry key). One window per appId (launchOrFocus).
  readonly appId: string;
  readonly title: string;
  readonly icon?: string;
  // The page to load in the iframe (relative to the harness/desktop origin).
  readonly appUrl: string;
  // Capabilities to grant this app's session. Default: the full compat surface.
  readonly grants?: readonly PuterCapability[];
  // Override the instance id (tests). Defaults to a generated uuid.
  readonly appInstanceId?: string;
  // Override the opaque token minted for this app's session. REQUIRED when the api_origin runs in a
  // SEPARATE process/registry (e.g. the dev preview server): pass the token that server pre-minted so
  // the iframe's HTTP requests authenticate. Omitted → a fresh random token (single-process / on-device
  // where the host + api_origin share one registry).
  readonly token?: string;
}

export interface WebAppHandle {
  readonly appId: string;
  readonly appInstanceId: string;
  readonly token: string;
  readonly launchUrl: string;
}

export interface WebAppWindowHostDeps {
  readonly doc: WmDocument;
  readonly wm: WindowManager;
  readonly capabilities: PuterCapabilityRegistry;
  readonly broker: UiBroker;
  // The LOCAL api_origin base the SDK points fs/kv/auth at.
  readonly apiOrigin: string;
  // The parent (gui) origin the SDK posts ui messages to.
  readonly guiOrigin?: string;
  // Notification sink (maps showNotification → the shell). Optional; defaults to console in headless.
  readonly notify?: (input: BrokerNotificationInput & { appId: string }) => void;
  // Generate an instance id. Defaults to a uuid-ish.
  readonly genInstanceId?: () => string;
  // The iframe sandbox attribute. Defaults to a safe set for the loopback spike.
  readonly sandbox?: string;
}

const DEFAULT_GRANTS: readonly PuterCapability[] = Object.freeze([
  "fs.read",
  "fs.write",
  "kv.read",
  "kv.write",
  "ui",
  "auth",
]);

export function createWebAppWindowHost(deps: WebAppWindowHostDeps): WebAppWindowHost {
  const { broker, capabilities, doc, wm } = deps;
  // appId -> the instance id we minted (so close() can revoke + unregister).
  const open = new Map<string, string>();

  function seedContent(spec: WebAppSpec): WindowContent {
    return Object.freeze({
      body: `<div data-puter-webapp-loading style="padding:22px 16px;color:var(--text-faint)">Loading ${escapeHtml(spec.title)}…</div>`,
      icon: spec.icon ?? "🌐",
      title: spec.title,
    });
  }

  return Object.freeze({
    close(appId: string): void {
      const instance = open.get(appId);

      if (instance !== undefined) {
        broker.unregisterTarget(instance);
        capabilities.revoke(instance);
        open.delete(appId);
      }

      wm.get(appId)?.close();
    },
    open(spec: WebAppSpec): WebAppHandle {
      const handle = wm.launchOrFocus(spec.appId, seedContent(spec));

      // Already open for this app → focus only; return the existing session.
      const existingInstance = open.get(spec.appId);

      if (existingInstance !== undefined) {
        const existing = capabilities.sessions.find((s) => s.appInstanceId === existingInstance);

        if (existing !== undefined) {
          return Object.freeze({
            appId: spec.appId,
            appInstanceId: existing.appInstanceId,
            launchUrl: "(already open)",
            token: existing.token,
          });
        }
      }

      const appInstanceId = spec.appInstanceId ?? (deps.genInstanceId ?? genInstanceId)();
      const session = capabilities.mintAppSession({
        appId: spec.appId,
        appInstanceId,
        grants: spec.grants ?? DEFAULT_GRANTS,
        ...(deps.guiOrigin === undefined ? {} : { domain: deps.guiOrigin }),
        ...(spec.token === undefined ? {} : { token: spec.token }),
      });

      const launchUrl = buildLaunchUrl({
        apiOrigin: deps.apiOrigin,
        appId: spec.appId,
        appInstanceId,
        appUrl: spec.appUrl,
        authToken: session.token,
        ...(deps.guiOrigin === undefined ? {} : { guiOrigin: deps.guiOrigin }),
      });

      const body = handle.bodyElement;

      if (body === null) {
        // No surface (stub) — still register the session + a no-op target so the protocol is testable.
        registerBrokerTarget(appInstanceId, undefined);
        open.set(spec.appId, appInstanceId);
        return Object.freeze({ appId: spec.appId, appInstanceId, launchUrl, token: session.token });
      }

      // Build the sandboxed iframe and mount it edge-to-edge in the window body.
      const iframe = doc.createElement("iframe") as IframeLike;

      iframe.setAttribute("data-puter-webapp", spec.appId);
      iframe.setAttribute("title", spec.title);
      iframe.setAttribute("sandbox", deps.sandbox ?? "allow-scripts allow-same-origin allow-forms allow-modals");
      iframe.style.setProperty("border", "0");
      iframe.style.setProperty("width", "100%");
      iframe.style.setProperty("height", "100%");
      iframe.style.setProperty("display", "block");
      iframe.style.setProperty("background", "var(--surface)");
      iframe.src = launchUrl;

      body.innerHTML = "";
      body.style.setProperty("padding", "0");
      body.appendChild(iframe);

      registerBrokerTarget(appInstanceId, iframe);
      open.set(spec.appId, appInstanceId);

      return Object.freeze({ appId: spec.appId, appInstanceId, launchUrl, token: session.token });
    },
  });

  function registerBrokerTarget(appInstanceId: string, iframe: IframeLike | undefined): void {
    const target: AttachedAppTarget = Object.freeze({
      appInstanceId,
      post(message: unknown): void {
        const cw = iframe?.contentWindow as { postMessage?: (m: unknown, o: string) => void } | undefined;
        const post = cw?.postMessage;

        if (typeof post === "function") {
          try {
            post.call(cw, message, "*");
          } catch {
            // ignore — reply best-effort.
          }
        }
      },
    });

    broker.registerTarget(target);
  }
}

// The broker sinks bound to THIS host's WM + notifications. Exposed so the wiring (and the harness) can
// hand the broker concrete behavior that targets the right window. Pure-ish (closes over the WM).
export interface WebAppSinkDeps {
  readonly wm: WindowManager;
  // Map instance id -> the WM appId so setWindowTitle targets the right window.
  readonly appIdForInstance: (instanceId: string) => string | undefined;
  readonly notify?: (input: BrokerNotificationInput & { instanceId: string }) => void;
  readonly confirm?: (message: string) => Promise<string>;
  readonly promptUser?: (message: string, placeholder?: string) => Promise<string | null>;
}

export function setWebAppWindowTitle(wm: WindowManager, appId: string | undefined, title: string): void {
  if (appId === undefined) return;

  const handle = wm.get(appId);

  if (handle === undefined) return;

  try {
    const el = handle.element.querySelector?.("[data-vita-window-title]");

    if (el !== null && el !== undefined) el.textContent = title;

    handle.element.setAttribute("aria-label", title);
  } catch {
    // ignore — best-effort.
  }
}

// A uuid-ish instance id (crypto when available; deterministic-enough fallback otherwise). Pure-ish.
export function genInstanceId(): string {
  const g = globalThis as { crypto?: { randomUUID?: () => string } };

  if (typeof g.crypto?.randomUUID === "function") return g.crypto.randomUUID();

  return `inst-${Date.now().toString(16)}-${Math.random().toString(16).slice(2, 10)}`;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}
