// Phase A2 — reusable desktop app context menu (right-click Properties / Close).
//
// Covers: the menu definition + visibility (Close hidden when the app has no open window); the DOM
// popup render + click-to-activate mapping a role → the matching handler (openProperties / closeApp);
// and escape/outside-click dismissal.

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  buildAppContextMenu,
  createAppContextMenu,
} from "../../../../ui_kits/desktop/runtime/app-context-menu.ts";
import {
  flattenContextMenu,
} from "../../../../ui_kits/desktop/viewmodels/context-menu.ts";
import type {
  AppMenuContext,
  AppMenuRole,
} from "../../../../ui_kits/desktop/runtime/app-context-menu.ts";
import type {
  WmDocument,
  WmElement,
} from "../../../../ui_kits/desktop/runtime/window-manager.ts";

const OPEN_CONTEXT: AppMenuContext = Object.freeze({ appId: "vita.app.activity", appTitle: "Activity", open: true });
const CLOSED_CONTEXT: AppMenuContext = Object.freeze({ appId: "vita.app.activity", appTitle: "Activity", open: false });

test("menu carries Properties always and Close only when a window is open", () => {
  const menu = buildAppContextMenu();

  const openRoles = flattenContextMenu(menu, OPEN_CONTEXT)
    .filter((entry) => entry.kind === "item")
    .map((entry) => (entry.kind === "item" ? entry.role : undefined));

  assert.ok(openRoles.includes("properties" as AppMenuRole));
  assert.ok(openRoles.includes("close" as AppMenuRole));

  const closedRoles = flattenContextMenu(menu, CLOSED_CONTEXT)
    .filter((entry) => entry.kind === "item")
    .map((entry) => (entry.kind === "item" ? entry.role : undefined));

  assert.ok(closedRoles.includes("properties" as AppMenuRole));
  assert.ok(!closedRoles.includes("close" as AppMenuRole)); // Close hidden when no window
});

test("popup renders item rows and the app title header", () => {
  const doc = fakeDocument();
  const controller = createAppContextMenu(doc.document, {
    closeApp: () => {},
    openProperties: () => {},
  });

  controller.openFor(OPEN_CONTEXT, 120, 80);

  const popup = doc.body.children.find((el) => el.id === "vita-app-context-menu");

  assert.ok(popup !== undefined, "expected a popup element");
  assert.match(popup!.innerHTML, /Activity/); // header
  assert.match(popup!.innerHTML, /data-vita-context-item="properties"/);
  assert.match(popup!.innerHTML, /data-vita-context-item="close"/);
  assert.match(popup!.style.cssText, /left:120px/);
  assert.match(popup!.style.cssText, /top:80px/);
});

test("clicking Properties invokes openProperties with the appId", () => {
  const doc = fakeDocument();
  const calls: string[] = [];
  const controller = createAppContextMenu(doc.document, {
    closeApp: (id) => calls.push(`close:${id}`),
    openProperties: (id) => calls.push(`properties:${id}`),
  });

  controller.openFor(OPEN_CONTEXT, 0, 0);
  const popup = doc.body.children.find((el) => el.id === "vita-app-context-menu")!;

  popup.fire("click", { target: itemTarget("properties") });

  assert.deepEqual(calls, ["properties:vita.app.activity"]);
  // Popup dismissed after activation.
  assert.equal(doc.body.children.some((el) => el.id === "vita-app-context-menu"), false);
});

test("clicking Close invokes closeApp; clicking a disabled header does nothing", () => {
  const doc = fakeDocument();
  const calls: string[] = [];
  const controller = createAppContextMenu(doc.document, {
    closeApp: (id) => calls.push(`close:${id}`),
    openProperties: (id) => calls.push(`properties:${id}`),
  });

  controller.openFor(OPEN_CONTEXT, 0, 0);
  let popup = doc.body.children.find((el) => el.id === "vita-app-context-menu")!;
  popup.fire("click", { target: itemTarget("header") }); // disabled label → no-op
  assert.deepEqual(calls, []);

  controller.openFor(OPEN_CONTEXT, 0, 0);
  popup = doc.body.children.find((el) => el.id === "vita-app-context-menu")!;
  popup.fire("click", { target: itemTarget("close") });
  assert.deepEqual(calls, ["close:vita.app.activity"]);
});

test("escape and outside pointerdown dismiss the popup", () => {
  const doc = fakeDocument();
  const controller = createAppContextMenu(doc.document, { closeApp: () => {}, openProperties: () => {} });

  controller.openFor(OPEN_CONTEXT, 0, 0);
  assert.equal(doc.body.children.some((el) => el.id === "vita-app-context-menu"), true);

  // Escape via the document keydown listener.
  doc.document.fire("keydown", { key: "Escape" });
  assert.equal(doc.body.children.some((el) => el.id === "vita-app-context-menu"), false);

  // Re-open, then dismiss via an outside pointerdown.
  controller.openFor(OPEN_CONTEXT, 0, 0);
  doc.document.fire("pointerdown", { target: outsideTarget() });
  assert.equal(doc.body.children.some((el) => el.id === "vita-app-context-menu"), false);
});

// ----- DOM stubs -----

function itemTarget(id: string): { closest(selector: string): unknown } {
  return {
    closest(selector: string): unknown {
      if (selector === "[data-vita-context-item]") {
        return { getAttribute: (n: string) => (n === "data-vita-context-item" ? id : null) };
      }
      return null;
    },
  };
}

function outsideTarget(): { closest(selector: string): unknown } {
  return { closest: () => null };
}

// A self-contained stub (deliberately NOT `extends WmElement` — the WM listener param is typed as a
// pointer event, which fights our generic listeners; we cast at the controller boundary instead).
interface FakeEl {
  id: string;
  innerHTML: string;
  textContent: string | null;
  readonly style: { cssText: string; setProperty(name: string, value: string): void };
  readonly classList: { add(): void; remove(): void; toggle(): boolean };
  children: FakeEl[];
  setAttribute(name: string, value: string): void;
  getAttribute(name: string): string | null;
  appendChild(child: WmElement): WmElement;
  remove(): void;
  addEventListener(type: string, listener: (event: unknown) => void): void;
  removeEventListener(type: string, listener: (event: unknown) => void): void;
  fire(type: string, event: unknown): void;
}

interface FakeDocCtx {
  document: WmDocument & { fire(type: string, event: unknown): void };
  body: FakeEl;
}

function fakeDocument(): FakeDocCtx {
  const docListeners = new Map<string, Set<(event: unknown) => void>>();
  const body = makeEl("");

  const document = {
    addEventListener(type: string, listener: (event: unknown) => void): void {
      const set = docListeners.get(type) ?? new Set();

      set.add(listener);
      docListeners.set(type, set);
    },
    get body(): FakeEl {
      return body;
    },
    createElement(_tag: string): FakeEl {
      return makeEl("");
    },
    fire(type: string, event: unknown): void {
      for (const listener of docListeners.get(type) ?? []) listener(event);
    },
    getElementById(): WmElement | null {
      return null;
    },
    removeEventListener(type: string, listener: (event: unknown) => void): void {
      docListeners.get(type)?.delete(listener);
    },
  };

  return { body, document: document as unknown as FakeDocCtx["document"] };
}

function makeEl(id: string): FakeEl {
  const listeners = new Map<string, Set<(event: unknown) => void>>();
  const attrs = new Map<string, string>();
  const style = { cssText: "", setProperty(_n: string, _v: string): void {} };
  const el: FakeEl = {
    addEventListener(type: string, listener: (event: unknown) => void): void {
      const set = listeners.get(type) ?? new Set();

      set.add(listener);
      listeners.set(type, set);
    },
    appendChild(child: WmElement): WmElement {
      (child as FakeEl & { __parent?: FakeEl }).__parent = el;
      el.children.push(child as FakeEl);
      return child;
    },
    children: [],
    classList: { add(): void {}, remove(): void {}, toggle(): boolean { return false; } },
    fire(type: string, event: unknown): void {
      for (const listener of listeners.get(type) ?? []) listener(event);
    },
    getAttribute(name: string): string | null {
      return attrs.get(name) ?? null;
    },
    id,
    innerHTML: "",
    remove(): void {
      const owner = (el as FakeEl & { __parent?: FakeEl }).__parent;

      if (owner === undefined) return;

      const idx = owner.children.indexOf(el);

      if (idx >= 0) owner.children.splice(idx, 1);
    },
    removeEventListener(type: string, listener: (event: unknown) => void): void {
      listeners.get(type)?.delete(listener);
    },
    setAttribute(name: string, value: string): void {
      attrs.set(name, value);
    },
    style,
    textContent: null,
  };

  return el;
}
