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
  type PuterAppSession,
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
  // ----- puter.ui.* PICKERS -----
  //
  // The pickers render a REAL window in the multi-window shell that browses the api_origin fs, and
  // resolve with the user's selection. They are handed the requesting app's resolved SESSION so the
  // picker can authenticate fs browse calls AS that app (its own token) and confine navigation to the
  // app's granted fs scope — an app can never pick a path outside its grant (capability-gated).
  //
  // `showOpenFilePicker` resolves with the selected file path(s) (or undefined on cancel). Multi-select
  // returns an array. `showSaveFilePicker` resolves with the destination path the file was written to
  // (or undefined on cancel) — the broker writes the supplied content there first. `showDirectoryPicker`
  // resolves with the selected directory path (or undefined on cancel).
  showOpenFilePicker(session: PuterAppSession, options: OpenFilePickerOptions): Promise<readonly PickedFsEntry[] | null>;
  showSaveFilePicker(session: PuterAppSession, input: SaveFilePickerInput): Promise<PickedFsEntry | null>;
  showDirectoryPicker(session: PuterAppSession, options: DirectoryPickerOptions): Promise<readonly PickedFsEntry[] | null>;
  // `showFontPicker` resolves with the chosen font family string (or null on cancel). `showColorPicker`
  // resolves with the chosen color string (#rrggbb) (or null on cancel).
  showFontPicker(session: PuterAppSession, options: FontPickerOptions): Promise<string | null>;
  showColorPicker(session: PuterAppSession, options: ColorPickerOptions): Promise<string | null>;
}

// Picker option/result shapes. Kept small + structural; the wiring (shell-entry) renders the actual
// windows. `multiple` widens an open-file pick to a multi-select.
export interface OpenFilePickerOptions {
  readonly multiple?: boolean;
  // Optional accepted MIME/extension filter (advisory — the picker may use it to dim non-matches).
  readonly accept?: string;
}

export interface DirectoryPickerOptions {
  readonly multiple?: boolean;
}

export interface SaveFilePickerInput {
  // The bytes/text the app wants written to the chosen destination (the SDK sends `content`).
  readonly content: Uint8Array | string;
  // The suggested file name the save dialog pre-fills.
  readonly suggestedName?: string;
}

export interface FontPickerOptions {
  readonly defaultFont?: string;
}

export interface ColorPickerOptions {
  readonly defaultColor?: string;
}

// An fsentry the picker resolved to. It MUST carry the fields the genuine SDK's FSItem constructor
// reads so the returned handle's `.read()`/`.write()`/`.path`/`.name` work. The broker turns this into
// the exact `fileOpenPicked` / `fileSaved` / `directoryPicked` message item shapes the SDK expects.
export interface PickedFsEntry {
  readonly uid: string;
  readonly name: string;
  readonly path: string;
  readonly is_dir: boolean;
  readonly size: number;
  readonly modified: number;
  readonly created: number;
  // An absolute, parseable URL for the file's read/write surface. The SDK's FSItem constructor parses
  // `new URL(write_url ?? read_url)` for its signature/expires, so these MUST be valid absolute URLs.
  // (At runtime FSItem.read()/write() actually go by PATH via puter.fs, so the URL is only parsed.)
  readonly read_url: string;
  readonly write_url: string;
  readonly metadata_url?: string;
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
  // onLaunchedWithItems delivery to a RUNNING app: post an `itemsOpened` message so the SDK's
  // setWatchItemsCallback (#g) fires. For a launched-WITH-items app the items also ride the launch URL
  // (puter.item.*) which the SDK's onLaunchedWithItems reads on boot; this covers the live-delivery path
  // (e.g. an already-open app handed new items). The items are fsentries within the app's grant scope.
  pushLaunchItems(appInstanceId: string, items: readonly PickedFsEntry[]): void;
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

    const session = verdict.session;
    const instance = session.appInstanceId;

    // Gate the ui capability for any non-handshake action.
    const uiGate = capabilities.authorize(session, "ui");

    if (!uiGate.ok && env.uuid !== undefined) {
      reply(target, event.source, { error: { code: uiGate.code, message: uiGate.message }, original_msg_id: env.uuid });
      return;
    }

    await route(env, session, target, event.source);
  }

  // Gate an fs capability for a picker. Returns true to proceed; on denial it sends a correlated error
  // reply (so the SDK's pending promise rejects) and returns false. Fail-closed: an app lacking the
  // grant never gets a picker window — the pick is confined to apps that hold the fs capability.
  function gateFs(session: PuterAppSession, capability: "fs.read" | "fs.write", target: AttachedAppTarget | undefined, source: unknown, uuid: string | undefined): boolean {
    const gate = capabilities.authorize(session, capability);

    if (gate.ok) return true;

    if (uuid !== undefined) {
      reply(target, source, { error: { code: gate.code, message: gate.message }, original_msg_id: uuid });
    }

    return false;
  }

  async function route(env: UiEnvelope, session: PuterAppSession, target: AttachedAppTarget | undefined, source: unknown): Promise<void> {
    const instance = session.appInstanceId;
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
      // ----- PICKERS -----
      //
      // Each picker is additionally gated on the fs capability it implies (opening/saving a file is a
      // real fs action) so an app without the grant is denied here — the picker never shows. Replies use
      // the EXACT message names + item shapes the genuine SDK listens for (verified against the vendored
      // bundle): fileOpenPicked/fileOpenCancelled, fileSaved/fileSaveCancelled, directoryPicked,
      // fontPicked, colorPicked. We `reply(...)` directly (not `ack`) because the reply `msg` differs
      // from the request `msg`, and the SDK matches on `original_msg_id`.
      case "showOpenFilePicker": {
        if (!gateFs(session, "fs.read", target, source, env.uuid)) return;

        const options = readOpenFilePickerOptions(env);
        const picked = await sinks.showOpenFilePicker(session, options);

        if (env.uuid === undefined) return;
        if (picked === null || picked.length === 0) {
          reply(target, source, { msg: "fileOpenCancelled", original_msg_id: env.uuid });
          return;
        }

        reply(target, source, { items: picked.map(toPickerItem), msg: "fileOpenPicked", original_msg_id: env.uuid });
        return;
      }
      case "showSaveFilePicker": {
        if (!gateFs(session, "fs.write", target, source, env.uuid)) return;

        const input = readSaveFilePickerInput(env);
        const saved = await sinks.showSaveFilePicker(session, input);

        if (env.uuid === undefined) return;
        if (saved === null) {
          reply(target, source, { msg: "fileSaveCancelled", original_msg_id: env.uuid });
          return;
        }

        reply(target, source, { msg: "fileSaved", original_msg_id: env.uuid, saved_file: toPickerItem(saved) });
        return;
      }
      case "showDirectoryPicker": {
        if (!gateFs(session, "fs.read", target, source, env.uuid)) return;

        const options = readDirectoryPickerOptions(env);
        const picked = await sinks.showDirectoryPicker(session, options);

        if (env.uuid === undefined) return;
        if (picked === null || picked.length === 0) {
          // The SDK has no directory-cancel message; reply with an empty items array (no FSItem made).
          reply(target, source, { items: [], msg: "directoryPicked", original_msg_id: env.uuid });
          return;
        }

        reply(target, source, { items: picked.map(toDirectoryItem), msg: "directoryPicked", original_msg_id: env.uuid });
        return;
      }
      case "showFontPicker": {
        // A font pick needs no fs grant — it is a pure ui selection (already ui-gated above).
        const options = readFontPickerOptions(env);
        const font = await sinks.showFontPicker(session, options);
        const family = font ?? options.defaultFont ?? "System UI";

        if (env.uuid === undefined) return;
        // The SDK's fontPicked handler passes `e.data.font` straight to the app. The genuine Puter GUI
        // resolves with an OBJECT carrying `.fontFamily` (apps read `new_font.fontFamily`, e.g. Notepad),
        // so we send `font` as `{ fontFamily }` — NOT a bare string — to match the real SDK contract.
        reply(target, source, { font: { fontFamily: family }, msg: "fontPicked", original_msg_id: env.uuid });
        return;
      }
      case "showColorPicker": {
        const options = readColorPickerOptions(env);
        const color = await sinks.showColorPicker(session, options);

        if (env.uuid === undefined) return;
        // The SDK's colorPicked handler reads `e.data.color`.
        reply(target, source, { color: color ?? options.defaultColor ?? "", msg: "colorPicked", original_msg_id: env.uuid });
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
    pushLaunchItems(appInstanceId: string, items: readonly PickedFsEntry[]): void {
      const target = targets.get(appInstanceId);
      const source = sourceByInstance.get(appInstanceId);

      // The SDK's `itemsOpened` handler reads `e.data.items` and feeds the setWatchItemsCallback (#g).
      // It also POSTS an ack back (msg:true/false, original_msg_id:e.data.msg_id) — benign for us.
      reply(target, source, { items: items.map(toPickerItem), msg: "itemsOpened", msg_id: `items-${itemsSeq()}` });
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

// ---------------------------------------------------------------------------------------------
// Picker helpers (pure). Read the SDK's request options + build the exact response item shapes.
// ---------------------------------------------------------------------------------------------

// The SDK posts showOpenFilePicker as `{ msg, appInstanceID, uuid, options, env }` where `options` is
// the app's argument (e.g. `{ multiple:true, accept:'.txt' }`) — or omitted (`options:{}`). Read it.
function readOpenFilePickerOptions(env: UiEnvelope): OpenFilePickerOptions {
  const opts = optionsObject(env);
  const out: { multiple?: boolean; accept?: string } = {};

  if (opts["multiple"] === true) out.multiple = true;
  const accept = opts["accept"];

  if (typeof accept === "string" && accept !== "") out.accept = accept;
  return Object.freeze(out);
}

function readDirectoryPickerOptions(env: UiEnvelope): DirectoryPickerOptions {
  const opts = optionsObject(env);

  return Object.freeze(opts["multiple"] === true ? { multiple: true } : {});
}

// showSaveFilePicker posts `{ msg, content, suggestedName, save_type, ... }` (the content is at the
// TOP LEVEL of the envelope, not inside `options` — verified against the bundle). Read content +
// suggestedName. `content` may be a string, a Uint8Array, an ArrayBuffer, or a Blob-ish object.
function readSaveFilePickerInput(env: UiEnvelope): SaveFilePickerInput {
  const suggested = typeof env["suggestedName"] === "string" ? env["suggestedName"] : undefined;
  const content = coerceContent(env["content"]);

  return Object.freeze(suggested === undefined ? { content } : { content, suggestedName: suggested });
}

function readFontPickerOptions(env: UiEnvelope): FontPickerOptions {
  const opts = optionsObject(env);
  const def = opts["defaultFont"] ?? opts["default"] ?? env["defaultFont"];

  return Object.freeze(typeof def === "string" && def !== "" ? { defaultFont: def } : {});
}

function readColorPickerOptions(env: UiEnvelope): ColorPickerOptions {
  const opts = optionsObject(env);
  const def = opts["defaultColor"] ?? opts["default"] ?? env["defaultColor"] ?? (typeof env["options"] === "string" ? env["options"] : undefined);

  return Object.freeze(typeof def === "string" && def !== "" ? { defaultColor: def } : {});
}

function optionsObject(env: UiEnvelope): Record<string, unknown> {
  const o = env["options"];

  return o !== null && typeof o === "object" ? (o as Record<string, unknown>) : {};
}

// Coerce the save-picker content into bytes-or-string the broker hands the fs write. The SDK usually
// sends a string (editor text) but tolerate binary too.
function coerceContent(value: unknown): Uint8Array | string {
  if (typeof value === "string") return value;
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (value === null || value === undefined) return "";

  // Fallback: stringify anything else so the write still produces a file.
  try {
    return String(value);
  } catch {
    return "";
  }
}

// Build the `fileOpenPicked` / `fileSaved` item shape the SDK feeds to `new It(item)`. The constructor
// reads camelCase OR snake_case, so we provide snake_case fsentry fields + read_url/write_url (which it
// parses as a URL for its signature). We also include `signature`/`expires` so the constructor's URL
// parse is never the only source (defence in depth against a malformed url).
function toPickerItem(entry: PickedFsEntry): Record<string, unknown> {
  return {
    accessed: entry.modified,
    created: entry.created,
    expires: 0,
    fsentry_accessed: entry.modified,
    fsentry_created: entry.created,
    fsentry_is_dir: entry.is_dir,
    fsentry_modified: entry.modified,
    fsentry_name: entry.name,
    fsentry_size: entry.size,
    is_dir: entry.is_dir,
    metadata_url: entry.metadata_url ?? entry.read_url,
    modified: entry.modified,
    name: entry.name,
    path: entry.path,
    read_url: entry.read_url,
    signature: "",
    size: entry.size,
    uid: entry.uid,
    write_url: entry.write_url,
  };
}

// The `directoryPicked` handler reads a DIFFERENT (snake_case) field set than fileOpenPicked: it builds
// `new It({ uid, name:fsentry_name, path, readURL:read_url, ... isDirectory:true })`. Provide exactly
// those keys so the SDK's directory item is well-formed.
function toDirectoryItem(entry: PickedFsEntry): Record<string, unknown> {
  return {
    fsentry_accessed: entry.modified,
    fsentry_created: entry.created,
    fsentry_modified: entry.modified,
    fsentry_name: entry.name,
    fsentry_size: entry.size,
    metadata_url: entry.metadata_url ?? entry.read_url,
    path: entry.path,
    read_url: entry.read_url,
    uid: entry.uid,
    write_url: entry.write_url,
  };
}

let ITEMS_SEQ = 0;

function itemsSeq(): number {
  ITEMS_SEQ += 1;
  return ITEMS_SEQ;
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
