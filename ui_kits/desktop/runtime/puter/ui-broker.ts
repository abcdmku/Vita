// Puter compat — the `ui` postMessage broker (the PARENT side of the control plane).
//
// A Puter app's `puter.ui.*` calls do NOT go over HTTP — they `postMessage` to the parent window (the
// Vita shell). This module is that parent: it listens for messages from app iframes, validates each
// (env==='app', a KNOWN appInstanceID, source IS the app's iframe), maps the ui message to the WM /
// notifications via injected sinks, and replies on the SAME channel with `original_msg_id == uuid`.
//
// Verified protocol (architecture/puter-compat-layer.md + the vendored bundle, 2026-06-26):
//   - Handshake: the app posts `{ msg:'READY', appInstanceID }`. The parent marks it attached and
//     sends NO INIT reply (the docs are wrong; source confirms).
//   - Envelope: `{ msg, env:'app', appInstanceID, uuid, ...args }`. The reply is
//     `{ msg:'<...>', original_msg_id: uuid, ... }` posted back to the app's window.
//   - Messages handled: READY, alert, prompt, setWindowTitle, showNotification, createWindow
//     (minimal), launchApp. Unknown messages get a benign error reply (never throw).
//
// Transport-agnostic: the broker takes a `BrokerWindow` (the parent's postMessage surface) + sinks for
// the WM / notifications / app-launch, so it is unit-testable with a fake window and wires to the real
// shell in web-app-window.ts. No DOM `lib` dependency — structural `*Like` types, house style.

import {
  type GateResult,
  type PuterCapabilityRegistry,
} from "./capability.ts";

// ---------------------------------------------------------------------------------------------
// Structural message-event + window surface (no DOM lib).
// ---------------------------------------------------------------------------------------------

export interface BrokerMessageEvent {
  readonly data: unknown;
  // The Window that sent the message (the iframe's contentWindow). We validate source identity.
  readonly source?: unknown;
  readonly origin?: string;
}

export type BrokerMessageListener = (event: BrokerMessageEvent) => void;

// The parent window surface the broker listens on + posts replies through. In the browser this is the
// real `window`; in tests a fake. `postToSource` posts a reply to a specific app window (event.source).
export interface BrokerWindow {
  addEventListener(type: "message", listener: BrokerMessageListener): void;
  removeEventListener(type: "message", listener: BrokerMessageListener): void;
}

// A handle to one attached app: its instance id and the window object replies are posted to.
export interface AttachedAppTarget {
  readonly appInstanceId: string;
  // Post a reply object to this app's window (the iframe contentWindow). Implemented by the wiring.
  post(message: unknown): void;
}

// ---------------------------------------------------------------------------------------------
// Sinks — what the broker maps ui messages onto (the WM / notifications / launcher). Injected so the
// broker is decoupled from the shell internals + testable.
// ---------------------------------------------------------------------------------------------

export interface BrokerSinks {
  setWindowTitle(appInstanceId: string, title: string): void;
  // Show a modal-ish alert; resolve with the chosen button (default "OK"). The web wiring can render a
  // themed dialog; the headless harness can auto-confirm.
  alert(appInstanceId: string, message: string, buttons?: readonly AlertButton[]): Promise<string>;
  prompt(appInstanceId: string, message: string, placeholder?: string): Promise<string | null>;
  showNotification(appInstanceId: string, input: BrokerNotificationInput): void;
  launchApp(appInstanceId: string, appName: string, args?: Record<string, unknown>): void;
  // createWindow(minimal): the app asks for a child window; map to a managed WM window (or no-op +
  // ack). Return an id the app can reference.
  createWindow(appInstanceId: string, options: BrokerCreateWindowOptions): string;
}

export interface AlertButton {
  readonly label: string;
  readonly value?: string;
  readonly type?: "primary" | "danger" | "default";
}

export interface BrokerNotificationInput {
  readonly title?: string;
  readonly message: string;
}

export interface BrokerCreateWindowOptions {
  readonly title?: string;
  readonly content?: string;
  readonly width?: number;
  readonly height?: number;
}

export interface UiBroker {
  // Begin listening on the parent window. Returns a disposer.
  start(): () => void;
  // Register an attached-app reply target (the iframe contentWindow + a `post`). Called when a web-app
  // window mounts so the broker can match `event.source` and post replies.
  registerTarget(target: AttachedAppTarget): void;
  unregisterTarget(appInstanceId: string): void;
  // True once the app has completed the READY handshake.
  isAttached(appInstanceId: string): boolean;
  readonly attached: readonly string[];
}

export interface UiBrokerDeps {
  readonly window: BrokerWindow;
  readonly capabilities: PuterCapabilityRegistry;
  readonly sinks: BrokerSinks;
  // Optional: validate the message origin. For the spike the iframe is same-origin/sandboxed; on-device
  // tighten to the app's exact origin.
  readonly expectedOrigin?: string;
}

// A puter ui envelope (the fields we read). Extra args ride alongside.
interface UiEnvelope {
  readonly msg: string;
  readonly env?: string;
  readonly appInstanceID?: string;
  readonly uuid?: string;
  readonly [key: string]: unknown;
}

export function createUiBroker(deps: UiBrokerDeps): UiBroker {
  const { capabilities, sinks, window: win } = deps;
  const targets = new Map<string, AttachedAppTarget>();
  // appInstanceId -> the source window object that READY arrived from (identity check for later msgs).
  const sourceByInstance = new Map<string, unknown>();
  const attached = new Set<string>();

  function reply(target: AttachedAppTarget | undefined, source: unknown, message: Record<string, unknown>): void {
    if (target !== undefined) {
      target.post(message);
      return;
    }

    // Fall back to posting through the source window if it exposes postMessage (browser path).
    const post = (source as { postMessage?: (m: unknown, o: string) => void } | undefined)?.postMessage;

    if (typeof post === "function") {
      try {
        post.call(source, message, "*");
      } catch {
        // ignore — best-effort reply.
      }
    }
  }

  // Validate an inbound envelope: shape, env, known instance, and (when a READY source is on record)
  // that the message came from the SAME window. Returns the resolved session or a typed rejection.
  function validate(env: UiEnvelope, source: unknown): { ok: true; session: import("./capability.ts").PuterAppSession } | { ok: false; code: string; message: string } {
    if (env.env !== "app") return { code: "bad_env", message: "env must be 'app'", ok: false };

    const instance = env.appInstanceID;
    const resolved: GateResult = capabilities.resolveInstance(instance);

    if (!resolved.ok) return { code: resolved.code, message: resolved.message, ok: false };

    // Source-identity check: once we've seen READY from a window for this instance, every later message
    // for the instance MUST come from that same window (prevents a different frame spoofing the id).
    const known = sourceByInstance.get(instance!);

    if (known !== undefined && source !== undefined && known !== source) {
      return { code: "source_mismatch", message: "message source does not match the attached app window", ok: false };
    }

    return { ok: true, session: resolved.session };
  }

  async function handle(event: BrokerMessageEvent): Promise<void> {
    const env = asEnvelope(event.data);

    if (env === undefined) return; // not a puter ui envelope — ignore silently.

    if (deps.expectedOrigin !== undefined && event.origin !== undefined && event.origin !== deps.expectedOrigin) {
      return; // wrong origin — drop.
    }

    // READY handshake: bind the source window to the instance, mark attached, send NO reply.
    if (env.msg === "READY") {
      const instance = env.appInstanceID;
      const resolved = capabilities.resolveInstance(instance);

      if (!resolved.ok) return; // unknown instance can't attach.

      sourceByInstance.set(instance!, event.source);
      attached.add(instance!);
      return; // critical: NO INIT reply.
    }

    const verdict = validate(env, event.source);
    const target = env.appInstanceID === undefined ? undefined : targets.get(env.appInstanceID);

    if (!verdict.ok) {
      // Reply with an error correlated to the request so the SDK's pending promise rejects cleanly.
      if (env.uuid !== undefined) {
        reply(target, event.source, { error: { code: verdict.code, message: verdict.message }, original_msg_id: env.uuid });
      }

      return;
    }

    const instance = verdict.session.appInstanceId;

    // Gate the ui capability for any non-handshake action.
    const uiGate = capabilities.authorize(verdict.session, "ui");

    if (!uiGate.ok && env.uuid !== undefined) {
      reply(target, event.source, { error: { code: uiGate.code, message: uiGate.message }, original_msg_id: env.uuid });
      return;
    }

    await route(env, instance, target, event.source);
  }

  async function route(env: UiEnvelope, instance: string, target: AttachedAppTarget | undefined, source: unknown): Promise<void> {
    const ack = (extra: Record<string, unknown> = {}): void => {
      if (env.uuid !== undefined) reply(target, source, { msg: env.msg, original_msg_id: env.uuid, ...extra });
    };

    switch (env.msg) {
      case "setWindowTitle": {
        // The SDK sends the title as `new_title` (verified against the bundle); accept `title` too.
        const title = typeof env["new_title"] === "string"
          ? env["new_title"]
          : (typeof env["title"] === "string" ? env["title"] : "");

        sinks.setWindowTitle(instance, title);
        ack({ success: true });
        return;
      }
      case "alert": {
        const message = typeof env["message"] === "string" ? env["message"] : String(env["message"] ?? "");
        const buttons = Array.isArray(env["buttons"]) ? (env["buttons"] as AlertButton[]) : undefined;
        const chosen = await sinks.alert(instance, message, buttons);

        ack({ value: chosen });
        return;
      }
      case "prompt": {
        const message = typeof env["message"] === "string" ? env["message"] : "";
        const placeholder = typeof env["placeholder"] === "string" ? env["placeholder"] : undefined;
        const value = await sinks.prompt(instance, message, placeholder);

        ack({ value });
        return;
      }
      case "showNotification":
      case "createNotification": {
        const message = typeof env["message"] === "string"
          ? env["message"]
          : (typeof env["text"] === "string" ? env["text"] : "");
        const title = typeof env["title"] === "string" ? env["title"] : undefined;

        sinks.showNotification(instance, title === undefined ? { message } : { message, title });
        ack({ success: true });
        return;
      }
      case "createWindow": {
        const options = readCreateWindowOptions(env);
        const id = sinks.createWindow(instance, options);

        ack({ id });
        return;
      }
      case "launchApp": {
        const appName = typeof env["app_name"] === "string"
          ? env["app_name"]
          : (typeof env["name"] === "string" ? env["name"] : "");
        const args = env["args"] !== null && typeof env["args"] === "object" ? (env["args"] as Record<string, unknown>) : undefined;

        sinks.launchApp(instance, appName, args);
        ack({ success: true });
        return;
      }
      default: {
        // Unknown ui message: ack benignly so the SDK promise resolves (never hang the app).
        ack({ success: true, unhandled: true });
        return;
      }
    }
  }

  let listening: BrokerMessageListener | null = null;

  return Object.freeze({
    get attached(): readonly string[] {
      return Object.freeze([...attached]);
    },
    isAttached(appInstanceId: string): boolean {
      return attached.has(appInstanceId);
    },
    registerTarget(target: AttachedAppTarget): void {
      targets.set(target.appInstanceId, target);
    },
    start(): () => void {
      if (listening !== null) return () => undefined;

      const listener: BrokerMessageListener = (event) => {
        void handle(event);
      };

      listening = listener;
      win.addEventListener("message", listener);

      return () => {
        if (listening !== null) {
          win.removeEventListener("message", listening);
          listening = null;
        }
      };
    },
    unregisterTarget(appInstanceId: string): void {
      targets.delete(appInstanceId);
      sourceByInstance.delete(appInstanceId);
      attached.delete(appInstanceId);
    },
  });
}

// ---------------------------------------------------------------------------------------------
// Pure helpers.
// ---------------------------------------------------------------------------------------------

// Coerce arbitrary postMessage data into a UiEnvelope iff it carries a string `msg`. Returns undefined
// for anything else so the broker ignores unrelated postMessages.
export function asEnvelope(data: unknown): UiEnvelope | undefined {
  if (data === null || typeof data !== "object") return undefined;

  const msg = (data as { msg?: unknown }).msg;

  if (typeof msg !== "string") return undefined;

  return data as UiEnvelope;
}

function readCreateWindowOptions(env: UiEnvelope): BrokerCreateWindowOptions {
  const opts = env["options"] !== null && typeof env["options"] === "object" ? (env["options"] as Record<string, unknown>) : env;
  const out: { title?: string; content?: string; width?: number; height?: number } = {};

  if (typeof opts["title"] === "string") out.title = opts["title"];
  if (typeof opts["content"] === "string") out.content = opts["content"];
  if (typeof opts["width"] === "number") out.width = opts["width"];
  if (typeof opts["height"] === "number") out.height = opts["height"];

  return Object.freeze(out);
}
