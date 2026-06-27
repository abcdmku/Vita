// Desktop window manager (Phase A) — real, multi-window, dark-themed surfaces.
//
// app-window-host.ts used to render ONE reused fixed-position div: clicking a second app replaced
// the first's content, and the window could not move, close, or resize. This module replaces that
// with a genuine window manager: a registry of independent windows, each draggable by its title
// bar, closable via the red traffic-light dot, resizable from a bottom-right grip, raisable on
// pointerdown, and maximizable/restorable via a title-bar dot. It owns ONLY window chrome +
// geometry + lifecycle; the *content* of each window is supplied by app-window-host.ts (which keeps
// the real host-bridge data path). The two are decoupled through the WindowManager API below.
//
// Portability: the rest of the runtime (binder.ts/hydrate.ts) avoids the DOM `lib` and models the
// DOM with structural `*Like` interfaces so `npm run typecheck` stays clean with `lib:["ES2023"]`.
// We follow that house style here — every DOM touchpoint this module needs is declared structurally
// below (WmDocument / WmElement / WmPointerEvent). At runtime these are satisfied by the real
// browser document/elements (the window host only installs against a live DOM); in tests they can be
// satisfied by a stub.
//
// Theming: windows are built from the kit.css dark classes (.v-win, .v-tt, .v-dots) and the design
// tokens (var(--surface) / var(--surface-raised) / var(--border) / var(--text) …) — never hard-coded
// light values. The shell is .theme-dark, so windows inherit the dark palette.

// ---------------------------------------------------------------------------------------------
// Structural DOM surface (no DOM `lib` dependency).
// ---------------------------------------------------------------------------------------------

export interface WmRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface WmStyleLike {
  cssText: string;
  setProperty(name: string, value: string): void;
}

export interface WmClassListLike {
  add(...tokens: string[]): void;
  remove(...tokens: string[]): void;
  toggle(token: string, force?: boolean): boolean;
}

export interface WmPointerEvent {
  readonly clientX: number;
  readonly clientY: number;
  readonly pointerId?: number;
  readonly button?: number;
  readonly target?: unknown;
  preventDefault?(): void;
  stopPropagation?(): void;
}

export type WmListener = (event: WmPointerEvent) => void;

export interface WmElement {
  id: string;
  innerHTML: string;
  textContent: string | null;
  readonly style: WmStyleLike;
  readonly classList: WmClassListLike;
  setAttribute(name: string, value: string): void;
  getAttribute?(name: string): string | null;
  appendChild(child: WmElement): WmElement;
  removeChild?(child: WmElement): WmElement;
  remove?(): void;
  querySelector?(selector: string): WmElement | null;
  querySelectorAll?(selector: string): ArrayLike<WmElement>;
  closest?(selector: string): WmElement | null;
  addEventListener(type: string, listener: WmListener, options?: unknown): void;
  removeEventListener?(type: string, listener: WmListener, options?: unknown): void;
  setPointerCapture?(pointerId: number): void;
  releasePointerCapture?(pointerId: number): void;
  getBoundingClientRect?(): { left: number; top: number; width: number; height: number };
}

export interface WmDocument {
  createElement(tag: string): WmElement;
  getElementById(id: string): WmElement | null;
  querySelector?(selector: string): WmElement | null;
  readonly body: WmElement | null;
  addEventListener?(type: string, listener: WmListener, options?: unknown): void;
  removeEventListener?(type: string, listener: WmListener, options?: unknown): void;
}

// ---------------------------------------------------------------------------------------------
// Public API.
// ---------------------------------------------------------------------------------------------

// The boot self-test discovers an app window via `document.getElementById('vita-app-window')` and
// the live-input hit-test checks `closest('#vita-app-window')`. We keep that contract by tagging the
// CURRENTLY FOCUSED window with this id (and only one element ever carries it).
export const ACTIVE_WINDOW_ID = "vita-app-window";

// Per-app window content. app-window-host renders the chrome row + body string; the WM frames it.
export interface WindowContent {
  readonly title: string;
  readonly icon: string;
  readonly badge?: string; // small mono caption shown in the title bar (e.g. the surface id)
  readonly body: string; // inner HTML for the window body
}

export interface WindowHandle {
  readonly id: string;
  readonly appId: string;
  // Replace the body HTML (used for loading -> ready transitions and settings re-render).
  setBody(body: string): void;
  // Replace title-bar caption + body in one shot.
  setContent(content: WindowContent): void;
  // The body element apps attach delegated listeners to (settings click handler, etc.).
  readonly bodyElement: WmElement | null;
  // The whole window element (focus delegation target).
  readonly element: WmElement;
  focus(): void;
  close(): void;
  readonly isOpen: boolean;
}

export interface WindowManager {
  // Open `appId` if not already open (cascaded position), else focus the existing window. Returns
  // the handle either way. `seed` provides the initial chrome (title/icon/badge/body).
  launchOrFocus(appId: string, seed: WindowContent): WindowHandle;
  get(appId: string): WindowHandle | undefined;
  readonly windows: readonly WindowHandle[];
  closeAll(): void;
  dispose(): void;
}

// ---------------------------------------------------------------------------------------------
// Geometry constants.
// ---------------------------------------------------------------------------------------------

const DEFAULT_RECT: Readonly<WmRect> = Object.freeze({ left: 150, top: 92, width: 560, height: 420 });
const CASCADE_STEP = 28;
const MIN_WIDTH = 320;
const MIN_HEIGHT = 200;
const TITLEBAR_H = 36;
// Keep at least this much of the title bar reachable on every edge when dragging.
const CLAMP_MARGIN = 24;
const MENUBAR_H = 32; // windows never cover the top menu bar
const Z_BASE = 70; // matches the prior single-window z-index; dock/menubar are 40, palette 50

interface WmHostEnv {
  innerWidth: number;
  innerHeight: number;
}

// ---------------------------------------------------------------------------------------------
// Factory.
// ---------------------------------------------------------------------------------------------

export function createWindowManager(doc: WmDocument, env?: Partial<WmHostEnv>): WindowManager {
  const registry = new Map<string, ManagedWindow>();
  let zCounter = Z_BASE;
  let cascadeIndex = 0;
  let focusedId: string | null = null;

  function viewport(): WmHostEnv {
    // Prefer an injected env (tests); else read the live window if present; else a sane default.
    const live = readViewport();
    return {
      innerHeight: env?.innerHeight ?? live.innerHeight,
      innerWidth: env?.innerWidth ?? live.innerWidth,
    };
  }

  function nextZ(): number {
    zCounter += 1;
    return zCounter;
  }

  function focus(target: ManagedWindow): void {
    if (focusedId === target.appId && target.element.style.cssText.includes(`z-index:${zCounter}`)) {
      // already on top; still ensure focus styling
    }

    for (const win of registry.values()) {
      const isTarget = win === target;
      win.setActive(isTarget);

      if (isTarget) {
        // Only the focused window carries the discoverable boot id.
        win.element.id = ACTIVE_WINDOW_ID;
        win.element.style.setProperty("z-index", String(nextZ()));
      } else if (win.element.id === ACTIVE_WINDOW_ID) {
        win.element.id = win.domId;
      }
    }

    focusedId = target.appId;
  }

  function remove(target: ManagedWindow): void {
    registry.delete(target.appId);
    target.teardown();

    if (focusedId === target.appId) {
      focusedId = null;
      // Promote the highest remaining window so the desktop keeps a discoverable active surface.
      const next = topMost(registry);

      if (next !== undefined) focus(next);
    }
  }

  function open(appId: string, seed: WindowContent): ManagedWindow {
    const rect = cascadedRect(DEFAULT_RECT, cascadeIndex, viewport());
    cascadeIndex += 1;

    const win = new ManagedWindow(doc, appId, seed, rect, {
      onClose: (w) => remove(w),
      onFocus: (w) => focus(w),
      viewport,
    });

    registry.set(appId, win);
    win.mount();
    focus(win);
    return win;
  }

  return Object.freeze({
    // LIVE read-through view: a fresh frozen snapshot of the open windows on each access. (Was a
    // one-time empty snapshot taken at construction — a bug: `wm.windows` was permanently []. The
    // dock/taskbar + any "list open windows" caller depend on this reflecting the registry now.)
    get windows(): readonly WindowHandle[] {
      return Object.freeze([...registry.values()]);
    },
    closeAll(): void {
      for (const win of [...registry.values()]) remove(win);
    },
    dispose(): void {
      for (const win of [...registry.values()]) {
        registry.delete(win.appId);
        win.teardown();
      }
      focusedId = null;
    },
    get(appId: string): WindowHandle | undefined {
      return registry.get(appId);
    },
    launchOrFocus(appId: string, seed: WindowContent): WindowHandle {
      const existing = registry.get(appId);

      if (existing !== undefined) {
        focus(existing);
        return existing;
      }

      return open(appId, seed);
    },
  });
}

function topMost(registry: ReadonlyMap<string, ManagedWindow>): ManagedWindow | undefined {
  let best: ManagedWindow | undefined;
  let bestZ = -1;

  for (const win of registry.values()) {
    const z = win.zIndex();

    if (z > bestZ) {
      bestZ = z;
      best = win;
    }
  }

  return best;
}

// ---------------------------------------------------------------------------------------------
// Managed window.
// ---------------------------------------------------------------------------------------------

interface ManagedWindowCallbacks {
  onClose(win: ManagedWindow): void;
  onFocus(win: ManagedWindow): void;
  viewport(): WmHostEnv;
}

let WINDOW_SEQ = 0;

class ManagedWindow implements WindowHandle {
  readonly appId: string;
  readonly id: string;
  readonly domId: string;
  readonly element: WmElement;

  #doc: WmDocument;
  #cb: ManagedWindowCallbacks;
  #title: WmElement | null = null;
  #titleName: WmElement | null = null;
  #titleBadge: WmElement | null = null;
  #closeDot: WmElement | null = null;
  #zoomDot: WmElement | null = null;
  #minDot: WmElement | null = null;
  #body: WmElement | null = null;
  #resize: WmElement | null = null;

  #rect: WmRect;
  #restoreRect: WmRect | null = null;
  #maximized = false;
  #open = true;
  #content: WindowContent;
  #disposers: (() => void)[] = [];

  constructor(
    doc: WmDocument,
    appId: string,
    seed: WindowContent,
    rect: WmRect,
    cb: ManagedWindowCallbacks,
  ) {
    WINDOW_SEQ += 1;
    this.appId = appId;
    this.id = `vita-win-${WINDOW_SEQ}`;
    this.domId = this.id;
    this.#doc = doc;
    this.#cb = cb;
    this.#rect = { ...rect };
    this.#content = seed;
    this.element = doc.createElement("div");
  }

  get isOpen(): boolean {
    return this.#open;
  }

  get bodyElement(): WmElement | null {
    return this.#body;
  }

  zIndex(): number {
    return readZIndex(this.element);
  }

  // ----- mount -----

  mount(): void {
    const el = this.element;
    el.id = this.domId;
    el.classList.add("v-win");
    el.setAttribute("data-vita-window", this.appId);
    el.setAttribute("role", "dialog");
    el.setAttribute("aria-label", this.#content.title);
    this.applyRectStyle();

    el.innerHTML = this.frame(this.#content);
    this.captureRefs();
    this.wire();

    // Mount INSIDE the dark desktop scope, not document.body. The design tokens
    // (var(--surface) / var(--text) / var(--border) …) are scoped to the `.v-screen.theme-dark`
    // element; a window appended to document.body lives OUTSIDE that scope and resolves the tokens
    // to their :root LIGHT defaults — rendering the whole window (chrome + app body) light. The
    // `.v-screen` is `position:relative` and fills the viewport, so absolute children anchor to it
    // exactly as they did to the body. Fall back to body only if no screen host is present (stub).
    const host = this.#screenHost();

    if (host !== null) host.appendChild(el);
  }

  // Resolve the dark desktop host the window should mount into: the live `.v-screen` (which carries
  // theme-dark + data-vita-screen="desktop"). Falls back to document.body when no screen exists.
  #screenHost(): WmElement | null {
    const doc = this.#doc;

    try {
      const screen = doc.querySelector?.(".v-screen") ?? null;

      if (screen !== null) return screen;
    } catch {
      // ignore — fall through to body.
    }

    return doc.body;
  }

  // Force a global cursor for the duration of a drag/resize gesture. While dragging, the pointer
  // frequently leaves the tiny title bar / resize grip (it moves faster than the window follows), so
  // a cursor declared only on the grip/title bar reverts to the default arrow mid-gesture. Pinning
  // the cursor on the screen host (and document.body, which actually owns the pointer during capture)
  // keeps the resize/move cursor showing for the whole gesture; `endGestureCursor` restores it.
  // (NOTE: on the real device the on-screen cursor is a FIXED compositor sprite that ignores CSS —
  // see the compositor follow-up — but this is correct for the preview/browser and any future CEF
  // OnCursorChange propagation.)
  beginGestureCursor(cursor: string): void {
    this.setHostCursor(cursor);
  }

  endGestureCursor(): void {
    this.setHostCursor("");
  }

  setHostCursor(cursor: string): void {
    const targets = [this.#screenHost(), this.#doc.body];

    for (const target of targets) {
      try {
        target?.style.setProperty("cursor", cursor);
      } catch {
        // ignore — best-effort cursor hint.
      }
    }
  }

  applyRectStyle(): void {
    const r = this.#rect;
    // .v-win supplies background/border/radius/shadow from kit.css (dark tokens). We only own
    // geometry + z-index here. Position is absolute within the .v-screen.
    this.element.style.cssText =
      `position:absolute;left:${r.left}px;top:${r.top}px;width:${r.width}px;height:${r.height}px;` +
      `min-width:${MIN_WIDTH}px;min-height:${MIN_HEIGHT}px;z-index:${Z_BASE};` +
      `font:13px var(--font-sans,system-ui);color:var(--text)`;
  }

  // Build the dark window chrome: title bar (.v-tt) with traffic-light dots (.v-dots) + caption,
  // a scrollable body, and a bottom-right resize grip. Everything is token-driven (dark).
  frame(content: WindowContent): string {
    const badge = content.badge === undefined ? "" : content.badge;

    return (
      `<div class="v-tt" data-vita-window-titlebar style="cursor:move;user-select:none">` +
      `<div class="v-dots" data-vita-window-controls>` +
      // Close (red) — hover reveals an ✕. Title color via CSS var; the dot fill is set inline so
      // it reads as a real traffic light against the dark title bar.
      `<span data-vita-window-close title="Close" role="button" aria-label="Close window" ` +
      `style="background:#f0584f;cursor:pointer;position:relative;display:flex;align-items:center;justify-content:center">` +
      `<span data-vita-window-glyph style="font-size:8px;line-height:1;color:rgba(0,0,0,.55);opacity:0">✕</span></span>` +
      // Minimize (amber) — hide for now.
      `<span data-vita-window-min title="Minimize" role="button" aria-label="Minimize window" ` +
      `style="background:#f0b429;cursor:pointer"></span>` +
      // Maximize / restore (green).
      `<span data-vita-window-zoom title="Zoom" role="button" aria-label="Maximize or restore window" ` +
      `style="background:#23c65a;cursor:pointer"></span>` +
      `</div>` +
      `<span style="display:flex;align-items:center;gap:8px;margin-left:4px">` +
      `<span data-vita-window-icon style="font-size:13px">${content.icon}</span>` +
      `<span class="v-tname" data-vita-window-title style="color:var(--text-secondary)">${escapeHtml(content.title)}</span>` +
      `</span>` +
      `<span class="v-tname" data-vita-window-badge ` +
      `style="margin-left:auto;color:var(--text-faint);font-size:10.5px">${escapeHtml(badge)}</span>` +
      `</div>` +
      `<div data-vita-app-window-body data-vita-window-body ` +
      `style="flex:1;min-height:0;overflow:auto;background:var(--surface)">${content.body}</div>` +
      // Bottom-right resize grip — token-styled, subtle dark affordance.
      `<div data-vita-window-resize title="Resize" ` +
      `style="position:absolute;right:0;bottom:0;width:16px;height:16px;cursor:nwse-resize;` +
      `background:linear-gradient(135deg,transparent 50%,var(--border-strong) 50%,var(--border-strong) 60%,transparent 60%,transparent 72%,var(--border-strong) 72%,var(--border-strong) 82%,transparent 82%)"></div>`
    );
  }

  captureRefs(): void {
    const q = (sel: string): WmElement | null => safeQuery(this.element, sel);

    this.#title = q("[data-vita-window-titlebar]");
    this.#titleName = q("[data-vita-window-title]");
    this.#titleBadge = q("[data-vita-window-badge]");
    this.#closeDot = q("[data-vita-window-close]");
    this.#zoomDot = q("[data-vita-window-zoom]");
    this.#minDot = q("[data-vita-window-min]");
    this.#body = q("[data-vita-window-body]");
    this.#resize = q("[data-vita-window-resize]");
  }

  // ----- wiring -----

  wire(): void {
    this.wireFocus();
    this.wireDrag();
    this.wireControls();
    this.wireResize();
  }

  // pointerdown ANYWHERE on the window raises it.
  wireFocus(): void {
    const onDown: WmListener = () => {
      if (this.#open) this.#cb.onFocus(this);
    };

    this.addListener(this.element, "pointerdown", onDown);
  }

  // Drag by the title bar — but NOT when the pointer starts on a control dot or the resize grip.
  wireDrag(): void {
    const titlebar = this.#title;

    if (titlebar === null) return;

    let dragging = false;
    let startX = 0;
    let startY = 0;
    let originLeft = 0;
    let originTop = 0;
    let pointerId: number | undefined;

    const onMove: WmListener = (event) => {
      if (!dragging) return;

      event.preventDefault?.();
      const dx = event.clientX - startX;
      const dy = event.clientY - startY;
      const vp = this.#cb.viewport();
      const next = clampTitleOnScreen(
        { ...this.#rect, left: originLeft + dx, top: originTop + dy },
        vp,
      );

      this.#rect.left = next.left;
      this.#rect.top = next.top;
      this.element.style.setProperty("left", `${next.left}px`);
      this.element.style.setProperty("top", `${next.top}px`);
    };

    const onUp: WmListener = (event) => {
      if (!dragging) return;
      dragging = false;

      this.endGestureCursor();

      if (pointerId !== undefined) this.element.releasePointerCapture?.(pointerId);
      this.removeWindowMoveListeners(onMove, onUp);
    };

    const onDown: WmListener = (event) => {
      // Ignore drags that begin on a control / resize affordance.
      if (eventTargetWithin(event, "[data-vita-window-controls]") ||
        eventTargetWithin(event, "[data-vita-window-resize]")) {
        return;
      }
      if (event.button !== undefined && event.button !== 0) return;
      // A maximized window is un-draggable until restored (matches platform behavior); a drag
      // gesture on a maximized title bar first restores, then moves.
      if (this.#maximized) this.restore();

      dragging = true;
      startX = event.clientX;
      startY = event.clientY;
      originLeft = this.#rect.left;
      originTop = this.#rect.top;
      pointerId = event.pointerId;
      this.#cb.onFocus(this);
      // Pin the "grabbing" cursor for the whole move so it doesn't revert when the pointer leaves
      // the title bar mid-drag.
      this.beginGestureCursor("grabbing");

      if (pointerId !== undefined) this.element.setPointerCapture?.(pointerId);
      this.addWindowMoveListeners(onMove, onUp);
      event.preventDefault?.();
    };

    this.addListener(titlebar, "pointerdown", onDown);
  }

  wireControls(): void {
    if (this.#closeDot !== null) {
      const glyph = safeQuery(this.#closeDot, "[data-vita-window-glyph]");
      const onEnter: WmListener = () => glyph?.style.setProperty("opacity", "1");
      const onLeave: WmListener = () => glyph?.style.setProperty("opacity", "0");
      const onClick: WmListener = (event) => {
        event.stopPropagation?.();
        this.close();
      };

      this.addListener(this.#closeDot, "pointerenter", onEnter);
      this.addListener(this.#closeDot, "pointerleave", onLeave);
      // Close on pointerup (so the focus pointerdown doesn't swallow it) AND click for robustness.
      this.addListener(this.#closeDot, "click", onClick);
    }

    if (this.#zoomDot !== null) {
      const onZoom: WmListener = (event) => {
        event.stopPropagation?.();
        this.toggleMaximize();
      };

      this.addListener(this.#zoomDot, "click", onZoom);
    }

    if (this.#minDot !== null) {
      const onMin: WmListener = (event) => {
        event.stopPropagation?.();
        this.minimize();
      };

      this.addListener(this.#minDot, "click", onMin);
    }
  }

  // Bottom-right resize grip: pointerdrag updates width/height with a min clamp.
  wireResize(): void {
    const grip = this.#resize;

    if (grip === null) return;

    let resizing = false;
    let startX = 0;
    let startY = 0;
    let originW = 0;
    let originH = 0;
    let pointerId: number | undefined;

    const onMove: WmListener = (event) => {
      if (!resizing) return;

      event.preventDefault?.();
      const vp = this.#cb.viewport();
      const maxW = Math.max(MIN_WIDTH, vp.innerWidth - this.#rect.left - 8);
      const maxH = Math.max(MIN_HEIGHT, vp.innerHeight - this.#rect.top - 8);
      const width = clamp(originW + (event.clientX - startX), MIN_WIDTH, maxW);
      const height = clamp(originH + (event.clientY - startY), MIN_HEIGHT, maxH);

      this.#rect.width = width;
      this.#rect.height = height;
      this.element.style.setProperty("width", `${width}px`);
      this.element.style.setProperty("height", `${height}px`);
    };

    const onUp: WmListener = () => {
      if (!resizing) return;
      resizing = false;

      this.endGestureCursor();

      if (pointerId !== undefined) this.element.releasePointerCapture?.(pointerId);
      this.removeWindowMoveListeners(onMove, onUp);
    };

    const onDown: WmListener = (event) => {
      if (event.button !== undefined && event.button !== 0) return;
      if (this.#maximized) this.restore();

      resizing = true;
      startX = event.clientX;
      startY = event.clientY;
      originW = this.#rect.width;
      originH = this.#rect.height;
      pointerId = event.pointerId;
      this.#cb.onFocus(this);
      // Pin the resize cursor for the whole gesture so it persists once the pointer leaves the
      // 16x16 grip (which happens immediately on any real drag).
      this.beginGestureCursor("nwse-resize");

      if (pointerId !== undefined) this.element.setPointerCapture?.(pointerId);
      this.addWindowMoveListeners(onMove, onUp);
      event.preventDefault?.();
      event.stopPropagation?.();
    };

    this.addListener(grip, "pointerdown", onDown);
  }

  // ----- maximize / minimize / restore -----

  toggleMaximize(): void {
    if (this.#maximized) {
      this.restore();
    } else {
      this.maximize();
    }
  }

  maximize(): void {
    if (this.#maximized) return;

    this.#restoreRect = { ...this.#rect };
    const vp = this.#cb.viewport();
    const margin = 8;
    const next: WmRect = {
      height: Math.max(MIN_HEIGHT, vp.innerHeight - MENUBAR_H - margin * 2 - 56),
      left: margin,
      top: MENUBAR_H + margin,
      width: Math.max(MIN_WIDTH, vp.innerWidth - margin * 2),
    };

    this.#rect = next;
    this.#maximized = true;
    this.element.classList.add("is-maximized");
    this.applyGeometry();
  }

  restore(): void {
    if (!this.#maximized) return;

    if (this.#restoreRect !== null) this.#rect = { ...this.#restoreRect };
    this.#restoreRect = null;
    this.#maximized = false;
    this.element.classList.remove("is-maximized");
    this.applyGeometry();
  }

  // MINIMIZE to the dock is "hide for now" — keep the window + registry entry, just hide the element
  // and drop the discoverable id. A subsequent launchOrFocus re-shows + raises it.
  minimize(): void {
    this.element.style.setProperty("display", "none");

    if (this.element.id === ACTIVE_WINDOW_ID) this.element.id = this.domId;
  }

  applyGeometry(): void {
    const r = this.#rect;
    this.element.style.setProperty("left", `${r.left}px`);
    this.element.style.setProperty("top", `${r.top}px`);
    this.element.style.setProperty("width", `${r.width}px`);
    this.element.style.setProperty("height", `${r.height}px`);
  }

  // ----- focus styling -----

  setActive(active: boolean): void {
    this.element.classList.toggle("is-focused", active);
    // Active title bar reads brighter; inactive recedes. Token-driven so it stays dark-correct.
    this.#title?.style.setProperty("background", active ? "var(--surface-raised)" : "var(--surface-sunken)");
    this.#titleName?.style.setProperty("color", active ? "var(--text)" : "var(--text-muted)");
    this.element.style.setProperty("border-color", active ? "var(--border-strong)" : "var(--border)");
  }

  // ----- content updates -----

  setBody(body: string): void {
    this.#content = { ...this.#content, body };

    if (this.#body !== null) this.#body.innerHTML = body;
  }

  setContent(content: WindowContent): void {
    this.#content = content;

    if (this.#titleName !== null) this.#titleName.textContent = content.title;
    if (this.#titleBadge !== null) this.#titleBadge.textContent = content.badge ?? "";
    if (this.#body !== null) this.#body.innerHTML = content.body;
    this.element.setAttribute("aria-label", content.title);
  }

  // ----- lifecycle -----

  focus(): void {
    // Un-minimize on focus.
    this.element.style.setProperty("display", "flex");
    this.#cb.onFocus(this);
  }

  close(): void {
    if (!this.#open) return;
    this.#open = false;
    this.#cb.onClose(this);
  }

  teardown(): void {
    this.#open = false;
    // Defensive: clear any cursor pinned by an in-flight drag/resize if the window is torn down
    // mid-gesture (e.g. closed via keyboard) so the desktop isn't left with a stuck cursor.
    this.endGestureCursor();

    for (const dispose of this.#disposers.splice(0)) {
      try {
        dispose();
      } catch {
        // ignore
      }
    }

    try {
      if (this.element.remove !== undefined) {
        this.element.remove();
      } else {
        const host = this.#screenHost();

        if (host?.removeChild !== undefined) host.removeChild(this.element);
      }
    } catch {
      // ignore
    }
  }

  // ----- listener helpers -----

  addListener(target: WmElement, type: string, listener: WmListener): void {
    try {
      target.addEventListener(type, listener);
      this.#disposers.push(() => target.removeEventListener?.(type, listener));
    } catch {
      // ignore
    }
  }

  addWindowMoveListeners(onMove: WmListener, onUp: WmListener): void {
    const doc = this.#doc;

    if (doc.addEventListener === undefined) {
      // Fall back to the window element if the document can't host listeners (stub).
      this.element.addEventListener("pointermove", onMove);
      this.element.addEventListener("pointerup", onUp);
      return;
    }

    doc.addEventListener("pointermove", onMove);
    doc.addEventListener("pointerup", onUp);
  }

  removeWindowMoveListeners(onMove: WmListener, onUp: WmListener): void {
    const doc = this.#doc;

    if (doc.removeEventListener === undefined) {
      this.element.removeEventListener?.("pointermove", onMove);
      this.element.removeEventListener?.("pointerup", onUp);
      return;
    }

    doc.removeEventListener("pointermove", onMove);
    doc.removeEventListener("pointerup", onUp);
  }
}

// ---------------------------------------------------------------------------------------------
// Pure geometry helpers (no I/O — easy to reason about / test).
// ---------------------------------------------------------------------------------------------

export function clamp(value: number, min: number, max: number): number {
  if (max < min) return min;
  if (value < min) return min;
  if (value > max) return max;
  return value;
}

// Cascade each new window +28,+28 from the default, wrapping before it runs off the workspace.
export function cascadedRect(base: Readonly<WmRect>, index: number, vp: WmHostEnv): WmRect {
  const span = 6; // wrap after 6 steps
  const step = index % span;
  const left = base.left + step * CASCADE_STEP;
  const top = base.top + step * CASCADE_STEP;
  const rect: WmRect = {
    height: base.height,
    left,
    top,
    width: base.width,
  };

  return clampTitleOnScreen(rect, vp);
}

// Clamp so at least CLAMP_MARGIN px of the title bar stays reachable on every edge, and the window
// never rides up over the menu bar.
export function clampTitleOnScreen(rect: WmRect, vp: WmHostEnv): WmRect {
  const maxLeft = vp.innerWidth - CLAMP_MARGIN;
  const minLeft = CLAMP_MARGIN - rect.width;
  const maxTop = vp.innerHeight - CLAMP_MARGIN;
  const minTop = MENUBAR_H;

  return {
    height: rect.height,
    left: clamp(rect.left, minLeft, Math.max(minLeft, maxLeft)),
    top: clamp(rect.top, minTop, Math.max(minTop, maxTop)),
    width: rect.width,
  };
}

// ---------------------------------------------------------------------------------------------
// Internal utilities.
// ---------------------------------------------------------------------------------------------

function readViewport(): WmHostEnv {
  try {
    const g = globalThis as Record<string, unknown>;
    const w = typeof g["innerWidth"] === "number" ? (g["innerWidth"] as number) : undefined;
    const h = typeof g["innerHeight"] === "number" ? (g["innerHeight"] as number) : undefined;

    if (w !== undefined && h !== undefined && w > 0 && h > 0) {
      return { innerHeight: h, innerWidth: w };
    }
  } catch {
    // ignore
  }

  // Default to the design viewport (matches .v-screen 1280x800, scaled for CEF 1920x1440 at boot).
  return { innerHeight: 800, innerWidth: 1280 };
}

function readZIndex(el: WmElement): number {
  const match = /z-index:\s*(\d+)/u.exec(el.style.cssText);

  return match?.[1] !== undefined ? Number(match[1]) : Z_BASE;
}

function safeQuery(root: WmElement, selector: string): WmElement | null {
  try {
    return root.querySelector?.(selector) ?? null;
  } catch {
    return null;
  }
}

function eventTargetWithin(event: WmPointerEvent, selector: string): boolean {
  const target = event.target;

  if (target === null || typeof target !== "object") return false;

  const closest = (target as { closest?: (s: string) => unknown }).closest;

  if (typeof closest !== "function") return false;

  try {
    return closest.call(target, selector) !== null;
  } catch {
    return false;
  }
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}
