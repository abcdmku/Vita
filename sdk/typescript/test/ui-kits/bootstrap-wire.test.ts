import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import {
  bootstrapDesktop,
  bootstrapDesktopFromGlobal,
} from "../../../../ui_kits/desktop/runtime/bootstrap.ts";
import type {
  VitaElement,
  VitaElementList,
  VitaEventLike,
  VitaEventListener,
} from "../../../../ui_kits/desktop/runtime/binder.ts";

const BOOTSTRAP_SCRIPT = '<script type="module" src="runtime/bootstrap.js"></script>';
const INLINE_LUCIDE_CALL = "<script>lucide.createIcons();</script>";

const SCREEN_HTML = Object.freeze([
  Object.freeze({
    file: "index.html",
    id: "desktop",
  }),
  Object.freeze({
    file: "Settings.html",
    id: "desktop/settings",
  }),
  Object.freeze({
    file: "Files.html",
    id: "desktop/files",
  }),
  Object.freeze({
    file: "Shell.html",
    id: "desktop/shell",
  }),
  Object.freeze({
    file: "Activity.html",
    id: "desktop/activity",
  }),
  Object.freeze({
    file: "Notifications.html",
    id: "desktop/notifications",
  }),
  Object.freeze({
    file: "Lock.html",
    id: "desktop/lock",
  }),
  Object.freeze({
    file: "Tiling.html",
    id: "desktop/tiling",
  }),
]);

test("desktop screen HTML delegates bootstrap and leaves lucide creation to hydration", () => {
  for (let index = 0; index < SCREEN_HTML.length; index += 1) {
    const screen = SCREEN_HTML[index];

    if (screen === undefined) continue;

    const html = readDesktopHtml(screen.file);

    assert.equal(html.includes(INLINE_LUCIDE_CALL), false, screen.file);
    assert.equal(countOccurrences(html, BOOTSTRAP_SCRIPT), 1, screen.file);
  }
});

test("bootstrap keeps every static desktop screen inert when no bridge or host is present", async () => {
  for (let index = 0; index < SCREEN_HTML.length; index += 1) {
    const screen = SCREEN_HTML[index];

    if (screen === undefined) continue;

    const dom = screenDom(screen.id);
    const runtime = await bootstrapDesktop({
      document: new StubDocument(Object.freeze([dom.root])),
    });

    assert.equal(runtime.screens.length, 0, screen.id);
    assert.equal(dom.root.totalListenerCount(), 0, screen.id);
    assert.equal(dom.label.textContent, "static", screen.id);
  }
});

test("global bootstrap wires the matching screen when a bridge is present", async () => {
  const dom = screenDom("desktop/tiling");
  let lucideCalls = 0;
  let bridgeCalls = 0;
  const bridge = Object.freeze({
    request(): unknown {
      bridgeCalls += 1;

      return Object.freeze({
        error: Object.freeze({
          code: "UNEXPECTED_TEST_BRIDGE_CALL",
          message: "tiling smoke test should not call the bridge.",
          path: "/test",
        }),
        ok: false,
      });
    },
  });
  const lucide = Object.freeze({
    createIcons(): void {
      lucideCalls += 1;
    },
  });

  await withGlobalData(Object.freeze([
    Object.freeze({
      key: "document",
      value: new StubDocument(Object.freeze([dom.root])),
    }),
    Object.freeze({
      key: "vitaDesktopBridge",
      value: bridge,
    }),
    Object.freeze({
      key: "lucide",
      value: lucide,
    }),
  ]), async () => {
    const runtime = await bootstrapDesktopFromGlobal();

    assert.equal(runtime.screens.length, 1);
    assert.equal(runtime.screens[0]?.ok, true);
    assert.equal(dom.root.listenerCount("click"), 1);
    assert.equal(dom.label.textContent, "tile");
    assert.equal(lucideCalls, 1);

    dom.root.dispatch("click", dom.action);

    assert.equal(dom.label.textContent, "columns");
    assert.equal(lucideCalls, 2);
    assert.equal(bridgeCalls, 0);

    runtime.dispose();
    assert.equal(dom.root.listenerCount("click"), 0);
  });
});

interface ScreenDom {
  readonly root: StubElement;
  readonly action: StubElement;
  readonly label: StubElement;
}

interface GlobalProperty {
  readonly key: string;
  readonly value: unknown;
}

function screenDom(screenId: string): ScreenDom {
  const root = element({
    "data-vita-screen": screenId,
  });
  const action = element({
    "data-vita-action": "tiling.cycleLayout",
  });
  const label = element({
    "data-vita-bind-text": "tiling.layout",
  }, "static");

  root.appendChild(action);
  root.appendChild(label);

  return Object.freeze({
    action,
    label,
    root,
  });
}

async function withGlobalData<T>(
  properties: readonly GlobalProperty[],
  run: () => Promise<T>,
): Promise<T> {
  const previous: {
    readonly descriptor: PropertyDescriptor | undefined;
    readonly key: string;
  }[] = [];

  for (let index = 0; index < properties.length; index += 1) {
    const property = properties[index];

    if (property === undefined) continue;

    previous.push(Object.freeze({
      descriptor: Object.getOwnPropertyDescriptor(globalThis, property.key),
      key: property.key,
    }));
    Object.defineProperty(globalThis, property.key, {
      configurable: true,
      enumerable: true,
      value: property.value,
      writable: true,
    });
  }

  try {
    return await run();
  } finally {
    for (let index = previous.length - 1; index >= 0; index -= 1) {
      const item = previous[index];

      if (item === undefined) continue;

      if (item.descriptor === undefined) {
        Reflect.deleteProperty(globalThis, item.key);
      } else {
        Object.defineProperty(globalThis, item.key, item.descriptor);
      }
    }
  }
}

function readDesktopHtml(file: string): string {
  return readFileSync(new URL(`../../../../ui_kits/desktop/${file}`, import.meta.url), "utf8");
}

function countOccurrences(source: string, needle: string): number {
  let count = 0;
  let offset = 0;

  while (offset < source.length) {
    const index = source.indexOf(needle, offset);

    if (index < 0) break;
    count += 1;
    offset = index + needle.length;
  }

  return count;
}

class StubDocument {
  readonly body: StubElement | null;
  readonly #roots: readonly StubElement[];

  constructor(roots: readonly StubElement[]) {
    this.#roots = Object.freeze([...roots]);
    this.body = this.#roots[0] ?? null;
  }

  querySelectorAll(selector: string): VitaElementList {
    const output: StubElement[] = [];
    const selectors = parseSelectors(selector);

    for (let index = 0; index < this.#roots.length; index += 1) {
      const root = this.#roots[index];

      if (root === undefined) continue;
      if (matchesAnySelector(root, selectors)) output.push(root);
      root.collectMatches(selectors, output);
    }

    return output;
  }
}

class StubElement implements VitaElement {
  readonly dataset: Record<string, string | undefined> = Object.create(null) as Record<string, string | undefined>;
  readonly children: StubElement[] = [];
  readonly classList = Object.freeze({
    toggle: (token: string, force?: boolean): boolean => {
      const enabled = force ?? !this.#classes.has(token);

      if (enabled) {
        this.#classes.add(token);
      } else {
        this.#classes.delete(token);
      }

      return enabled;
    },
  });

  readonly #attributes = new Map<string, string>();
  readonly #classes = new Set<string>();
  readonly #listeners = new Map<string, VitaEventListener[]>();
  #parent: StubElement | null = null;
  #text = "";

  constructor(attrs: Readonly<Record<string, string>> = Object.freeze({}), text = "") {
    this.#text = text;

    const keys = Object.keys(attrs);

    for (let index = 0; index < keys.length; index += 1) {
      const key = keys[index];
      const value = key === undefined ? undefined : attrs[key];

      if (key !== undefined && value !== undefined) {
        this.setAttribute(key, value);
      }
    }
  }

  get textContent(): string {
    return this.#text;
  }

  set textContent(value: string | null) {
    this.#text = value ?? "";
  }

  querySelectorAll(selector: string): VitaElementList {
    const output: StubElement[] = [];

    this.collectMatches(parseSelectors(selector), output);
    return output;
  }

  closest(selector: string): VitaElement | null {
    const selectors = parseSelectors(selector);
    let current: StubElement | null = this;

    while (current !== null) {
      if (matchesAnySelector(current, selectors)) return current;
      current = current.#parent;
    }

    return null;
  }

  addEventListener(type: string, listener: VitaEventListener): void {
    let listeners = this.#listeners.get(type);

    if (listeners === undefined) {
      listeners = [];
      this.#listeners.set(type, listeners);
    }

    listeners.push(listener);
  }

  removeEventListener(type: string, listener: VitaEventListener): void {
    const listeners = this.#listeners.get(type);

    if (listeners === undefined) return;

    const index = listeners.indexOf(listener);

    if (index >= 0) listeners.splice(index, 1);
  }

  setAttribute(name: string, value: string): void {
    this.#attributes.set(name, value);

    if (name.startsWith("data-")) {
      this.dataset[datasetKey(name)] = value;
    }
  }

  cloneNode(deep = false): VitaElement {
    const clone = new StubElement();

    for (const [name, value] of this.#attributes) {
      clone.setAttribute(name, value);
    }

    clone.#text = this.#text;

    if (deep) {
      for (let index = 0; index < this.children.length; index += 1) {
        const child = this.children[index];

        if (child !== undefined) {
          clone.appendChild(child.cloneNode(true));
        }
      }
    }

    return clone;
  }

  appendChild(child: VitaElement): VitaElement {
    if (!(child instanceof StubElement)) {
      throw new TypeError("stub only accepts stub children");
    }

    if (child.#parent !== null) {
      child.#parent.removeChild(child);
    }

    child.#parent = this;
    this.children.push(child);
    return child;
  }

  removeChild(child: VitaElement): VitaElement {
    if (!(child instanceof StubElement)) {
      throw new TypeError("stub only removes stub children");
    }

    const index = this.children.indexOf(child);

    if (index < 0) throw new Error("child not found");

    this.children.splice(index, 1);
    child.#parent = null;
    return child;
  }

  dispatch(type: string, target: StubElement): void {
    const listeners = this.#listeners.get(type) ?? [];
    const event: VitaEventLike = Object.freeze({
      target,
      type,
    });
    const pending = [...listeners];

    for (let index = 0; index < pending.length; index += 1) {
      pending[index]?.(event);
    }
  }

  listenerCount(type: string): number {
    return this.#listeners.get(type)?.length ?? 0;
  }

  totalListenerCount(): number {
    let count = 0;

    for (const listeners of this.#listeners.values()) {
      count += listeners.length;
    }

    return count;
  }

  attribute(name: string): string | undefined {
    return this.#attributes.get(name);
  }

  collectMatches(selectors: readonly string[], output: StubElement[]): void {
    for (let index = 0; index < this.children.length; index += 1) {
      const child = this.children[index];

      if (child === undefined) continue;

      if (matchesAnySelector(child, selectors)) output.push(child);
      child.collectMatches(selectors, output);
    }
  }
}

function element(attrs: Readonly<Record<string, string>> = Object.freeze({}), text = ""): StubElement {
  return new StubElement(attrs, text);
}

function parseSelectors(selector: string): readonly string[] {
  return Object.freeze(selector.split(",").map((part) => part.trim()).filter((part) => part.length > 0));
}

function matchesAnySelector(elementValue: StubElement, selectors: readonly string[]): boolean {
  for (let index = 0; index < selectors.length; index += 1) {
    const selector = selectors[index];

    if (selector !== undefined && matchesSelector(elementValue, selector)) return true;
  }

  return false;
}

function matchesSelector(elementValue: StubElement, selector: string): boolean {
  if (!selector.startsWith("[") || !selector.endsWith("]")) return false;

  const attrName = selector.slice(1, -1);

  return elementValue.attribute(attrName) !== undefined;
}

function datasetKey(name: string): string {
  const raw = name.slice("data-".length).toLowerCase();
  let output = "";

  for (let index = 0; index < raw.length; index += 1) {
    const char = raw[index];
    const next = raw[index + 1];

    if (char === "-" && next !== undefined && next >= "a" && next <= "z") {
      output += next.toUpperCase();
      index += 1;
    } else {
      output += char ?? "";
    }
  }

  return output;
}
