import assert from "node:assert/strict";
import { test } from "node:test";

import {
  applyBindSinks,
  bindActions,
  captureBindTargets,
  createBinder,
} from "../../../../ui_kits/desktop/runtime/binder.ts";
import type {
  VitaElement,
  VitaElementList,
  VitaEventLike,
  VitaEventListener,
} from "../../../../ui_kits/desktop/runtime/binder.ts";

interface BinderSnapshot {
  readonly title: string;
  readonly selected: boolean;
  readonly label: string;
  readonly rows: readonly RowSnapshot[];
}

interface RowSnapshot {
  readonly key: string;
  readonly label: string;
}

test("bindActions installs one delegated listener per event type and resolves nearest action", () => {
  const root = element();
  const action = element({
    "data-vita-action": "open",
  });
  const nested = element();
  root.appendChild(action);
  action.appendChild(nested);

  const events: string[] = [];
  const binding = bindActions(root, new Map([
    ["open", (context) => {
      events.push(`${context.event.type}:${context.action}:${context.target === action}`);
    }],
  ]), {
    eventTypes: Object.freeze(["click", "click", "change"]),
  });

  assert.equal(root.listenerCount("click"), 1);
  assert.equal(root.listenerCount("change"), 1);

  root.dispatch("click", nested);
  root.dispatch("change", nested);
  binding.dispose();
  root.dispatch("click", nested);

  assert.deepEqual(events, [
    "click:open:true",
    "change:open:true",
  ]);
});

test("applyBindSinks writes text only when changed and reflects class and attr sinks", () => {
  const root = element();
  const title = element({
    "data-vita-bind-text": "title",
  }, "old");
  const selected = element({
    "data-vita-bind-class": "is-selected:selected",
  });
  const labelled = element({
    "data-vita-bind-attr-0": "aria-label:label",
  });
  root.appendChild(title);
  root.appendChild(selected);
  root.appendChild(labelled);

  const targets = captureBindTargets(root);
  const binds = new Map<string, (snapshot: BinderSnapshot) => string | boolean>([
    ["title", (snapshot) => snapshot.title],
    ["selected", (snapshot) => snapshot.selected],
    ["label", (snapshot) => snapshot.label],
  ]);
  const first = snapshot({
    label: "Open settings",
    rows: Object.freeze([]),
    selected: true,
    title: "Settings",
  });

  applyBindSinks(targets, first, binds);
  applyBindSinks(targets, first, binds);

  assert.equal(title.textContent, "Settings");
  assert.equal(title.textWrites, 1);
  assert.equal(selected.hasClass("is-selected"), true);
  assert.equal(labelled.attribute("aria-label"), "Open settings");

  applyBindSinks(targets, snapshot({
    label: "Open files",
    rows: Object.freeze([]),
    selected: false,
    title: "Files",
  }), binds);

  assert.equal(title.textContent, "Files");
  assert.equal(title.textWrites, 2);
  assert.equal(selected.hasClass("is-selected"), false);
  assert.equal(labelled.attribute("aria-label"), "Open files");
});

test("applyBindSinks reconciles flat keyed lists by reusing, appending, patching, and removing nodes", () => {
  const root = element();
  const list = element({
    "data-vita-bind-list": "rows",
  });
  const template = element({
    "data-vita-bind-text": "label",
    "data-vita-key": "template",
  }, "template");
  root.appendChild(list);
  list.appendChild(template);

  const targets = captureBindTargets(root);
  const binds = new Map<string, (snapshot: BinderSnapshot | RowSnapshot) => readonly RowSnapshot[] | string>([
    ["rows", (state) => isBinderSnapshot(state) ? state.rows : Object.freeze([])],
    ["label", (state) => isRowSnapshot(state) ? state.label : ""],
  ]);

  applyBindSinks(targets, snapshot({
    label: "",
    rows: Object.freeze([
      row("a", "Alpha"),
      row("b", "Beta"),
    ]),
    selected: false,
    title: "",
  }), binds);

  const firstA = list.children[0];
  const firstB = list.children[1];

  assert.notEqual(firstA, undefined);
  assert.notEqual(firstB, undefined);
  assert.equal(list.children.length, 2);
  assert.equal(firstA?.dataset.vitaKey, "a");
  assert.equal(firstA?.textContent, "Alpha");
  assert.equal(firstB?.dataset.vitaKey, "b");
  assert.equal(firstB?.textContent, "Beta");
  assert.equal(firstA === template, false);

  applyBindSinks(targets, snapshot({
    label: "",
    rows: Object.freeze([
      row("b", "Beta patched"),
      row("c", "Gamma"),
    ]),
    selected: false,
    title: "",
  }), binds);

  assert.equal(list.children.length, 2);
  assert.equal(list.children[0], firstB);
  assert.equal(list.children[0]?.dataset.vitaKey, "b");
  assert.equal(list.children[0]?.textContent, "Beta patched");
  assert.equal(list.children[1]?.dataset.vitaKey, "c");
  assert.equal(list.children[1]?.textContent, "Gamma");
});

test("createBinder fails inertly after dispose and skips throwing bind resolvers", () => {
  const root = element();
  const button = element({
    "data-vita-action": "increment",
  });
  const text = element({
    "data-vita-bind-text": "title",
  }, "stable");
  root.appendChild(button);
  root.appendChild(text);

  let actions = 0;
  const binder = createBinder(root, {
    actions: new Map([
      ["increment", () => {
        actions += 1;
      }],
    ]),
    binds: new Map([
      ["title", () => {
        throw new Error("resolver failed");
      }],
    ]),
  });

  binder.render(snapshot({
    label: "",
    rows: Object.freeze([]),
    selected: false,
    title: "ignored",
  }));
  root.dispatch("click", button);
  binder.dispose();
  root.dispatch("click", button);
  binder.render(snapshot({
    label: "",
    rows: Object.freeze([]),
    selected: false,
    title: "still ignored",
  }));

  assert.equal(actions, 1);
  assert.equal(text.textContent, "stable");
});

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

  textWrites = 0;

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
    this.textWrites += 1;
  }

  querySelectorAll(selector: string): VitaElementList {
    const selectors = selector.split(",").map((part) => part.trim()).filter((part) => part.length > 0);
    const output: StubElement[] = [];

    this.#collectMatches(selectors, output);
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
          clone.appendChild(child.cloneNode(true) as StubElement);
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

  #collectMatches(selectors: readonly string[], output: StubElement[]): void {
    for (let index = 0; index < this.children.length; index += 1) {
      const child = this.children[index];

      if (child === undefined) continue;

      for (let selectorIndex = 0; selectorIndex < selectors.length; selectorIndex += 1) {
        const selector = selectors[selectorIndex];

        if (selector !== undefined && matchesSelector(child, selector)) {
          output.push(child);
          break;
        }
      }

      child.#collectMatches(selectors, output);
    }
  }
}

function element(attrs: Readonly<Record<string, string>> = Object.freeze({}), text = ""): StubElement {
  return new StubElement(attrs, text);
}

function snapshot(input: BinderSnapshot): BinderSnapshot {
  return Object.freeze({
    label: input.label,
    rows: Object.freeze([...input.rows]),
    selected: input.selected,
    title: input.title,
  });
}

function row(key: string, label: string): RowSnapshot {
  return Object.freeze({
    key,
    label,
  });
}

function isBinderSnapshot(value: BinderSnapshot | RowSnapshot): value is BinderSnapshot {
  return "rows" in value;
}

function isRowSnapshot(value: BinderSnapshot | RowSnapshot): value is RowSnapshot {
  return "label" in value && "key" in value;
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
