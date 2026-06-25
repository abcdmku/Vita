import assert from "node:assert/strict";
import { test } from "node:test";

import {
  bootstrapDesktop,
} from "../../../../ui_kits/desktop/runtime/bootstrap.ts";
import {
  disposeScreen,
  hydrateScreen,
} from "../../../../ui_kits/desktop/runtime/hydrate.ts";
import {
  createSurfaceHost,
} from "../../../../ui_kits/desktop/runtime/host-bridge.ts";
import type {
  ScreenModule,
  ScreenViewModel,
} from "../../../../ui_kits/desktop/runtime/screen.ts";
import type {
  VitaElement,
  VitaElementList,
  VitaEventLike,
  VitaEventListener,
} from "../../../../ui_kits/desktop/runtime/binder.ts";
import type {
  DesktopMaybePromise,
} from "../../src/desktop-sdk/index.ts";

interface CounterState {
  readonly count: number;
  readonly active: boolean;
}

interface CounterPorts {
  readonly source: string;
}

class CounterViewModel implements ScreenViewModel<CounterState> {
  #count = 0;

  snapshot(): CounterState {
    return Object.freeze({
      active: this.#count % 2 === 1,
      count: this.#count,
    });
  }

  increment(): void {
    this.#count += 1;
  }
}

test("hydrateScreen wires delegated actions and reflects initial and updated state", async () => {
  const root = element();
  const button = element({
    "data-vita-action": "increment",
  });
  const label = element({
    "data-vita-bind-text": "label",
  }, "stale");
  const active = element({
    "data-vita-bind-class": "is-active:active",
  });
  root.appendChild(button);
  root.appendChild(label);
  root.appendChild(active);

  const screen = await resolveMaybe(hydrateScreen(root, counterModule("desktop/test"), createSurfaceHost(undefined)));

  assert.equal(screen.ok, true);
  assert.equal(root.listenerCount("click"), 1);
  assert.equal(label.textContent, "Count 0 from test");
  assert.equal(active.hasClass("is-active"), false);

  root.dispatch("click", button);

  assert.equal(label.textContent, "Count 1 from test");
  assert.equal(active.hasClass("is-active"), true);
  assert.deepEqual(screen.snapshot(), {
    active: true,
    count: 1,
  });
});

test("bootstrapDesktop keeps a throwing screen inert without bricking siblings", async () => {
  const goodRoot = element({
    "data-vita-screen": "desktop/good",
  });
  const goodButton = element({
    "data-vita-action": "increment",
  });
  const goodLabel = element({
    "data-vita-bind-text": "label",
  }, "pending");
  goodRoot.appendChild(goodButton);
  goodRoot.appendChild(goodLabel);

  const badRoot = element({
    "data-vita-screen": "desktop/bad",
  });
  const badLabel = element({
    "data-vita-bind-text": "label",
  }, "unchanged");
  badRoot.appendChild(badLabel);

  const runtime = await bootstrapDesktop({
    document: new StubDocument([badRoot, goodRoot]),
    host: createSurfaceHost(undefined),
    modules: Object.freeze([
      throwingModule("desktop/bad"),
      counterModule("desktop/good"),
    ]),
  });

  assert.equal(runtime.screens.length, 2);
  assert.equal(runtime.screens[0]?.ok, false);
  assert.equal(runtime.screens[1]?.ok, true);
  assert.equal(badRoot.listenerCount("click"), 0);
  assert.equal(badLabel.textContent, "unchanged");
  assert.equal(goodLabel.textContent, "Count 0 from test");

  goodRoot.dispatch("click", goodButton);

  assert.equal(goodLabel.textContent, "Count 1 from test");
});

test("disposeScreen and bootstrap runtime disposal are idempotent", async () => {
  const root = element();
  const button = element({
    "data-vita-action": "increment",
  });
  const label = element({
    "data-vita-bind-text": "label",
  }, "");
  root.appendChild(button);
  root.appendChild(label);

  const screen = await resolveMaybe(hydrateScreen(root, counterModule("desktop/dispose"), createSurfaceHost(undefined)));

  assert.equal(screen.ok, true);
  assert.equal(root.listenerCount("click"), 1);

  disposeScreen(screen);
  disposeScreen(screen);
  root.dispatch("click", button);

  assert.equal(root.listenerCount("click"), 0);
  assert.equal(label.textContent, "Count 0 from test");

  const bootRoot = element({
    "data-vita-screen": "desktop/runtime",
  });
  const bootButton = element({
    "data-vita-action": "increment",
  });
  bootRoot.appendChild(bootButton);

  const runtime = await bootstrapDesktop({
    document: new StubDocument([bootRoot]),
    host: createSurfaceHost(undefined),
    modules: Object.freeze([counterModule("desktop/runtime")]),
  });

  assert.equal(bootRoot.listenerCount("click"), 1);
  runtime.dispose();
  runtime.dispose();
  assert.equal(bootRoot.listenerCount("click"), 0);
});

function counterModule(id: string): ScreenModule<CounterState, CounterPorts, CounterViewModel> {
  return Object.freeze({
    actions: new Map([
      ["increment", (viewModel: CounterViewModel) => {
        viewModel.increment();
      }],
    ]),
    binds: new Map<string, (snapshot: CounterState) => string | boolean>([
      ["active", (snapshot: CounterState) => snapshot.active],
      ["label", (snapshot: CounterState) => `Count ${snapshot.count} from test`],
    ]),
    createViewModel() {
      return new CounterViewModel();
    },
    id,
    selectPorts() {
      return Object.freeze({
        source: "test",
      });
    },
  });
}

function throwingModule(id: string): ScreenModule<CounterState, CounterPorts, CounterViewModel> {
  return Object.freeze({
    actions: new Map(),
    binds: new Map([
      ["label", (snapshot: CounterState) => `Count ${snapshot.count} from test`],
    ]),
    createViewModel() {
      throw new Error("screen failed");
    },
    id,
    selectPorts() {
      return Object.freeze({
        source: "test",
      });
    },
  });
}

async function resolveMaybe<T>(value: DesktopMaybePromise<T>): Promise<T> {
  return await value;
}

class StubDocument {
  readonly body: StubElement | null = null;
  readonly #roots: readonly StubElement[];

  constructor(roots: readonly StubElement[]) {
    this.#roots = Object.freeze([...roots]);
  }

  querySelectorAll(selector: string): VitaElementList {
    const output: StubElement[] = [];

    for (let index = 0; index < this.#roots.length; index += 1) {
      const root = this.#roots[index];

      if (root === undefined) continue;
      if (matchesSelector(root, selector)) output.push(root);
      root.collectMatches(selector, output);
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

    this.collectMatches(selector, output);
    return output;
  }

  closest(selector: string): VitaElement | null {
    let current: StubElement | null = this;

    while (current !== null) {
      if (matchesSelector(current, selector)) return current;
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

  hasClass(token: string): boolean {
    return this.#classes.has(token);
  }

  attribute(name: string): string | undefined {
    return this.#attributes.get(name);
  }

  collectMatches(selector: string, output: StubElement[]): void {
    const selectors = selector.split(",").map((part) => part.trim()).filter((part) => part.length > 0);

    for (let index = 0; index < this.children.length; index += 1) {
      const child = this.children[index];

      if (child === undefined) continue;

      for (let selectorIndex = 0; selectorIndex < selectors.length; selectorIndex += 1) {
        const current = selectors[selectorIndex];

        if (current !== undefined && matchesSelector(child, current)) {
          output.push(child);
          break;
        }
      }

      child.collectMatches(selector, output);
    }
  }
}

function element(attrs: Readonly<Record<string, string>> = Object.freeze({}), text = ""): StubElement {
  return new StubElement(attrs, text);
}

function matchesSelector(element: StubElement, selector: string): boolean {
  if (!selector.startsWith("[") || !selector.endsWith("]")) return false;

  const attrName = selector.slice(1, -1);

  return element.attribute(attrName) !== undefined;
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
