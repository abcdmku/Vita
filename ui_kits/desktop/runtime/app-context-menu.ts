// Reusable desktop context menu (Phase A2) — right-click on a dock icon or a window title bar.
//
// The MODEL is the existing pure context-menu view-model (viewmodels/context-menu.ts): we build a
// ContextMenu, open it for a context, and resolve activation through its role invoker. THIS module
// adds the small DOM layer the view-model deliberately omits: a floating dark popup anchored at the
// pointer, click/escape-to-dismiss, and click-to-activate that maps a role → a handler.
//
// Items: Properties (opens the app's settings window), Close (closes the app's window), plus a
// disabled header showing the app title. The host wires the `contextmenu` event on dock tiles and
// title bars and passes the resolved appId; this module renders + activates.

import type {
  WmDocument,
  WmElement,
} from "./window-manager.ts";
import {
  activateContextMenu,
  openContextMenu,
} from "../viewmodels/context-menu.ts";
import type {
  ContextMenu,
  ContextMenuRenderedItem,
} from "../viewmodels/context-menu.ts";

// The roles a desktop app context menu can carry.
export type AppMenuRole = "properties" | "close" | "header";

export interface AppMenuContext {
  readonly appId: string;
  readonly appTitle: string;
  // Whether the app currently has an open window (drives whether Close is enabled).
  readonly open: boolean;
}

export interface AppContextMenuHandlers {
  // Open the settings / Properties window for the app.
  openProperties(appId: string): void;
  // Close the app's window.
  closeApp(appId: string): void;
}

// Build the menu definition for a dock icon / title bar. `header` is a disabled label row.
export function buildAppContextMenu(): ContextMenu<AppMenuContext, AppMenuRole> {
  return Object.freeze({
    sections: Object.freeze([
      Object.freeze({
        id: "title",
        items: Object.freeze([
          Object.freeze({
            disabled: true,
            id: "header",
            label: "App",
            role: "header" as AppMenuRole,
          }),
          Object.freeze({ id: "header-sep", kind: "separator" as const }),
        ]),
      }),
      Object.freeze({
        id: "actions",
        items: Object.freeze([
          Object.freeze({
            icon: "⚙",
            id: "properties",
            label: "Properties…",
            role: "properties" as AppMenuRole,
          }),
          Object.freeze({
            // Close is disabled when the app has no open window.
            id: "close",
            label: "Close",
            role: "close" as AppMenuRole,
            visible: (context: AppMenuContext) => context.open,
          }),
        ]),
      }),
    ]),
  });
}

export interface AppContextMenuController {
  // Open the popup for an app, anchored at (x, y) viewport coordinates.
  openFor(context: AppMenuContext, x: number, y: number): void;
  // Close any open popup.
  close(): void;
  dispose(): void;
}

const POPUP_ID = "vita-app-context-menu";

// Create the DOM controller. `doc` is the live document; `handlers` map roles to side effects.
export function createAppContextMenu(
  doc: WmDocument,
  handlers: AppContextMenuHandlers,
): AppContextMenuController {
  const menu = buildAppContextMenu();
  let popup: WmElement | null = null;
  let outsideListener: ((event: unknown) => void) | null = null;
  let keyListener: ((event: unknown) => void) | null = null;

  function close(): void {
    if (popup !== null) {
      try {
        popup.remove?.();
      } catch {
        // ignore
      }
      popup = null;
    }

    detachGlobalDismiss();
  }

  function detachGlobalDismiss(): void {
    try {
      if (outsideListener !== null) doc.removeEventListener?.("pointerdown", outsideListener as never);
      if (keyListener !== null) doc.removeEventListener?.("keydown", keyListener as never);
    } catch {
      // ignore
    }
    outsideListener = null;
    keyListener = null;
  }

  function activate(itemId: string, context: AppMenuContext): void {
    // Resolve the role through the pure view-model, then run the matching side effect.
    let state = openContextMenu(menu, context);
    // Move the focused cursor to the chosen item, then activate it.
    const item = findItem(state, itemId);

    if (item === undefined || item.disabled) {
      close();
      return;
    }

    state = focusItem(state, item);
    const result = activateContextMenu(state, (role) => {
      runRole(role, context);
      return undefined;
    });

    // Whether or not activation reported ok, we dismiss the popup.
    void result;
    close();
  }

  function runRole(role: AppMenuRole, context: AppMenuContext): void {
    try {
      if (role === "properties") handlers.openProperties(context.appId);
      else if (role === "close") handlers.closeApp(context.appId);
      // "header" is a disabled label → no effect.
    } catch {
      // a handler failure must not break the desktop.
    }
  }

  function openFor(context: AppMenuContext, x: number, y: number): void {
    close();

    const state = openContextMenu(menu, context);
    const items = visibleItems(state, context);
    const el = doc.createElement("div");

    el.id = POPUP_ID;
    el.setAttribute("role", "menu");
    el.setAttribute("data-vita-context-menu", context.appId);
    el.style.cssText = popupStyle(x, y);
    el.innerHTML = renderItems(items, context.appTitle);

    const body = doc.body;

    if (body !== null) body.appendChild(el);
    popup = el;

    // Click on an item → activate.
    el.addEventListener("click", ((event: unknown) => {
      const id = itemIdFromEvent(event);

      if (id !== undefined) activate(id, context);
    }) as never);

    attachGlobalDismiss();
  }

  function attachGlobalDismiss(): void {
    outsideListener = (event: unknown): void => {
      // A pointerdown that isn't inside the popup dismisses it.
      if (!eventWithinPopup(event)) close();
    };
    keyListener = (event: unknown): void => {
      const key = (event as { key?: unknown }).key;

      if (key === "Escape") close();
    };

    try {
      doc.addEventListener?.("pointerdown", outsideListener as never);
      doc.addEventListener?.("keydown", keyListener as never);
    } catch {
      // ignore
    }
  }

  return Object.freeze({
    close,
    dispose(): void {
      close();
    },
    openFor,
  });
}

// ----- rendering -----

function renderItems(
  items: readonly ContextMenuRenderedItem<AppMenuRole>[],
  appTitle: string,
): string {
  let html = "";

  for (const item of items) {
    if (item.role === "header") {
      html +=
        `<div style="padding:6px 14px 8px;font-size:11px;color:var(--text-faint);` +
        `border-bottom:1px solid var(--hairline);margin-bottom:4px">${escapeHtml(appTitle)}</div>`;
      continue;
    }

    const disabled = item.disabled;
    const color = disabled ? "var(--text-faint)" : "var(--text)";
    const cursor = disabled ? "default" : "pointer";
    const icon = item.icon === undefined ? "" : `<span style="width:16px;display:inline-block">${item.icon}</span>`;

    html +=
      `<div data-vita-context-item="${escapeAttr(item.id)}" role="menuitem" ` +
      `aria-disabled="${disabled ? "true" : "false"}" ` +
      `style="display:flex;align-items:center;gap:8px;padding:7px 14px;font-size:12.5px;` +
      `color:${color};cursor:${cursor};border-radius:6px;margin:1px 4px"` +
      `${disabled ? "" : ` onmouseover="this.style.background='var(--surface-raised)'" onmouseout="this.style.background='transparent'"`}>` +
      `${icon}<span>${escapeHtml(item.label)}</span></div>`;
  }

  return html;
}

function popupStyle(x: number, y: number): string {
  return (
    `position:fixed;left:${Math.round(x)}px;top:${Math.round(y)}px;min-width:180px;` +
    `z-index:90;padding:5px 0;border-radius:10px;` +
    `background:var(--surface-raised,#23262e);border:1px solid var(--border,#3a3f4b);` +
    `box-shadow:0 12px 32px rgba(0,0,0,.45);color:var(--text);` +
    `font:13px var(--font-sans,system-ui);user-select:none`
  );
}

// ----- view-model bridge helpers -----

function visibleItems(
  state: ReturnType<typeof openContextMenu<AppMenuContext, AppMenuRole>>,
  _context: AppMenuContext,
): readonly ContextMenuRenderedItem<AppMenuRole>[] {
  const out: ContextMenuRenderedItem<AppMenuRole>[] = [];

  for (const entry of state.items) {
    if (entry.kind === "item") out.push(entry);
  }

  return out;
}

function findItem(
  state: ReturnType<typeof openContextMenu<AppMenuContext, AppMenuRole>>,
  id: string,
): ContextMenuRenderedItem<AppMenuRole> | undefined {
  for (const entry of state.items) {
    if (entry.kind === "item" && entry.id === id) return entry;
  }

  return undefined;
}

// Re-open the menu with the chosen item as the focused cursor so activateContextMenu acts on it.
function focusItem(
  state: ReturnType<typeof openContextMenu<AppMenuContext, AppMenuRole>>,
  item: ContextMenuRenderedItem<AppMenuRole>,
): typeof state {
  if (!state.open) return state;

  return Object.freeze({
    ...state,
    focusedCursor: Object.freeze({
      index: item.renderIndex,
      itemId: item.id,
      levelPath: item.levelPath,
      path: item.path,
    }),
  });
}

function itemIdFromEvent(event: unknown): string | undefined {
  const target = (event as { target?: unknown }).target;

  if (target === null || typeof target !== "object") return undefined;

  const closest = (target as { closest?: (s: string) => unknown }).closest;

  if (typeof closest !== "function") return undefined;

  try {
    const el = closest.call(target, "[data-vita-context-item]") as { getAttribute?: (n: string) => string | null } | null;

    if (el === null || typeof el?.getAttribute !== "function") return undefined;

    const value = el.getAttribute("data-vita-context-item");

    return typeof value === "string" && value.length > 0 ? value : undefined;
  } catch {
    return undefined;
  }
}

function eventWithinPopup(event: unknown): boolean {
  const target = (event as { target?: unknown }).target;

  if (target === null || typeof target !== "object") return false;

  const closest = (target as { closest?: (s: string) => unknown }).closest;

  if (typeof closest !== "function") return false;

  try {
    return closest.call(target, `#${POPUP_ID}`) !== null;
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

function escapeAttr(value: string): string {
  return escapeHtml(value).replaceAll("'", "&#39;");
}
