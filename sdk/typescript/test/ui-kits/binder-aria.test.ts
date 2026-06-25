import assert from "node:assert/strict";
import { test } from "node:test";

import {
  applyBindSinks,
  captureBindTargets,
  createBinder,
} from "../../../../ui_kits/desktop/runtime/binder.ts";
import type {
  VitaElement,
  VitaElementList,
  VitaEventListener,
} from "../../../../ui_kits/desktop/runtime/binder.ts";

interface AriaSnapshot {
  readonly checked: boolean | "mixed" | null;
  readonly current: "date" | "false" | "page" | "time" | null;
  readonly disabled: boolean;
  readonly hidden: boolean;
  readonly open: boolean | null;
  readonly pressed: boolean;
  readonly selected: boolean;
}

test("aria sinks capture root and descendants and render boolean and token states", () => {
  const root = element({
    "data-vita-bind-aria-expanded": "open",
  });
  const selected = element({
    "data-vita-bind-aria-selected": "selected",
  });
  const checked = element({
    "data-vita-bind-aria-checked": "checked",
  });
  const current = element({
    "data-vita-bind-aria-current": "current",
  });
  const disabled = element({
    "data-vita-bind-aria-disabled": "disabled",
  });
  const pressed = element({
    "data-vita-bind-aria-pressed": "pressed",
  });
  const hidden = element({
    "data-vita-bind-aria-hidden": "hidden",
  });

  root.appendChild(selected);
  root.appendChild(checked);
  root.appendChild(current);
  root.appendChild(disabled);
  root.appendChild(pressed);
  root.appendChild(hidden);

  const binder = createBinder(root, {
    binds: new Map<string, (snapshot: AriaSnapshot) => boolean | string | null>([
      ["checked", (snapshot) => snapshot.checked],
      ["current", (snapshot) => snapshot.current],
      ["disabled", (snapshot) => snapshot.disabled],
      ["hidden", (snapshot) => snapshot.hidden],
      ["pressed", (snapshot) => snapshot.pressed],
      ["selected", (snapshot) => snapshot.selected],
    ]),
  });

  assert.equal(binder.targets.aria.length, 7);

  binder.render(snapshot({
    checked: "mixed",
    current: "page",
    disabled: false,
    hidden: false,
    open: true,
    pressed: true,
    selected: true,
  }));

  assert.equal(root.attribute("aria-expanded"), "true");
  assert.equal(selected.attribute("aria-selected"), "true");
  assert.equal(checked.attribute("aria-checked"), "mixed");
  assert.equal(current.attribute("aria-current"), "page");
  assert.equal(disabled.attribute("aria-disabled"), "false");
  assert.equal(pressed.attribute("aria-pressed"), "true");
  assert.equal(hidden.attribute("aria-hidden"), "false");

  binder.render(snapshot({
    checked: false,
    current: "time",
    disabled: true,
    hidden: true,
    open: false,
    pressed: false,
    selected: false,
  }));

  assert.equal(root.attribute("aria-expanded"), "false");
  assert.equal(selected.attribute("aria-selected"), "false");
  assert.equal(checked.attribute("aria-checked"), "false");
  assert.equal(current.attribute("aria-current"), "time");
  assert.equal(disabled.attribute("aria-disabled"), "true");
  assert.equal(pressed.attribute("aria-pressed"), "false");
  assert.equal(hidden.attribute("aria-hidden"), "true");
});

test("aria sinks are write-if-changed and remove nullable resolved values", () => {
  const root = element({
    "aria-expanded": "true",
    "data-vita-bind-aria-expanded": "open",
  });
  const targets = captureBindTargets(root);

  root.resetCounts();

  applyBindSinks(targets, snapshot({
    checked: null,
    current: null,
    disabled: false,
    hidden: false,
    open: true,
    pressed: false,
    selected: false,
  }), Object.freeze({}));

  assert.equal(root.attributeWrites("aria-expanded"), 0);
  assert.equal(root.attribute("aria-expanded"), "true");

  applyBindSinks(targets, snapshot({
    checked: null,
    current: null,
    disabled: false,
    hidden: false,
    open: false,
    pressed: false,
    selected: false,
  }), Object.freeze({}));
  applyBindSinks(targets, snapshot({
    checked: null,
    current: null,
    disabled: false,
    hidden: false,
    open: false,
    pressed: false,
    selected: false,
  }), Object.freeze({}));

  assert.equal(root.attributeWrites("aria-expanded"), 1);
  assert.equal(root.attribute("aria-expanded"), "false");

  applyBindSinks(targets, snapshot({
    checked: null,
    current: null,
    disabled: false,
    hidden: false,
    open: null,
    pressed: false,
    selected: false,
  }), Object.freeze({}));
  applyBindSinks(targets, snapshot({
    checked: null,
    current: null,
    disabled: false,
    hidden: false,
    open: null,
    pressed: false,
    selected: false,
  }), Object.freeze({}));

  assert.equal(root.attributeRemovals("aria-expanded"), 1);
  assert.equal(root.attribute("aria-expanded"), undefined);
});

test("aria sinks leave unbound and malformed targets untouched and swallow failing ports", () => {
  const root = element();
  const unbound = element();
  const emptySpec = element({
    "data-vita-bind-aria-hidden": "",
  });
  const invalidToken = element({
    "data-vita-bind-aria-current": "current",
  });
  const missing = element({
    "data-vita-bind-aria-selected": "missing",
  });
  const throwingResolver = element({
    "data-vita-bind-aria-pressed": "boom",
  });
  const throwingSet = element({
    "data-vita-bind-aria-disabled": "disabled",
  });

  throwingSet.throwOnSet.add("aria-disabled");
  root.appendChild(unbound);
  root.appendChild(emptySpec);
  root.appendChild(invalidToken);
  root.appendChild(missing);
  root.appendChild(throwingResolver);
  root.appendChild(throwingSet);

  const targets = captureBindTargets(root);

  assert.equal(targets.aria.length, 4);
  assert.doesNotThrow(() => {
    applyBindSinks(targets, Object.freeze({
      current: "later",
      disabled: true,
    }), new Map([
      ["boom", () => {
        throw new Error("resolver failed");
      }],
    ]));
  });

  assert.equal(unbound.attribute("aria-hidden"), undefined);
  assert.equal(emptySpec.attribute("aria-hidden"), undefined);
  assert.equal(invalidToken.attribute("aria-current"), undefined);
  assert.equal(missing.attribute("aria-selected"), undefined);
  assert.equal(throwingResolver.attribute("aria-pressed"), undefined);
  assert.equal(throwingSet.attribute("aria-disabled"), undefined);
});

class StubElement implements VitaElement {
  readonly dataset: Record<string, string | undefined> = Object.create(null) as Record<string, string | undefined>;
  readonly children: StubElement[] = [];
  readonly classList = Object.freeze({
    toggle: (_token: string, force?: boolean): boolean => force ?? true,
  });
  readonly throwOnSet = new Set<string>();

  readonly #attributes = new Map<string, string>();
  readonly #listeners = new Map<string, VitaEventListener[]>();
  readonly #removeCounts = new Map<string, number>();
  readonly #writeCounts = new Map<string, number>();
  #parent: StubElement | null = null;
  #text = "";

  constructor(attrs: Readonly<Record<string, string>> = Object.freeze({}), text = "") {
    this.#text = text;

    const keys = Object.keys(attrs);

    for (let index = 0; index < keys.length; index += 1) {
      const key = keys[index];
      const value = key === undefined ? undefined : attrs[key];

      if (key !== undefined && value !== undefined) this.setAttribute(key, value);
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

    this.#collectMatches(selector, output);
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
    const listeners = this.#listeners.get(type) ?? [];

    listeners.push(listener);
    this.#listeners.set(type, listeners);
  }

  removeEventListener(type: string, listener: VitaEventListener): void {
    const listeners = this.#listeners.get(type);

    if (listeners === undefined) return;

    const index = listeners.indexOf(listener);

    if (index >= 0) listeners.splice(index, 1);
  }

  getAttribute(name: string): string | null {
    return this.#attributes.get(name) ?? null;
  }

  setAttribute(name: string, value: string): void {
    if (this.throwOnSet.has(name)) throw new Error(`set ${name} failed`);

    this.#attributes.set(name, value);
    this.#writeCounts.set(name, (this.#writeCounts.get(name) ?? 0) + 1);

    if (name.startsWith("data-")) {
      this.dataset[datasetKey(name)] = value;
    }
  }

  removeAttribute(name: string): void {
    this.#attributes.delete(name);
    this.#removeCounts.set(name, (this.#removeCounts.get(name) ?? 0) + 1);

    if (name.startsWith("data-")) {
      delete this.dataset[datasetKey(name)];
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

        if (child !== undefined) clone.appendChild(child.cloneNode(true));
      }
    }

    return clone;
  }

  appendChild(child: VitaElement): VitaElement {
    if (!(child instanceof StubElement)) throw new TypeError("stub child expected");

    if (child.#parent !== null) child.#parent.removeChild(child);
    child.#parent = this;
    this.children.push(child);
    return child;
  }

  removeChild(child: VitaElement): VitaElement {
    if (!(child instanceof StubElement)) throw new TypeError("stub child expected");

    const index = this.children.indexOf(child);

    if (index < 0) throw new Error("child not found");

    this.children.splice(index, 1);
    child.#parent = null;
    return child;
  }

  attribute(name: string): string | undefined {
    return this.#attributes.get(name);
  }

  attributeWrites(name: string): number {
    return this.#writeCounts.get(name) ?? 0;
  }

  attributeRemovals(name: string): number {
    return this.#removeCounts.get(name) ?? 0;
  }

  resetCounts(): void {
    this.#writeCounts.clear();
    this.#removeCounts.clear();
  }

  #collectMatches(selector: string, output: StubElement[]): void {
    for (let index = 0; index < this.children.length; index += 1) {
      const child = this.children[index];

      if (child === undefined) continue;
      if (matchesSelector(child, selector)) output.push(child);

      child.#collectMatches(selector, output);
    }
  }
}

function element(attrs: Readonly<Record<string, string>> = Object.freeze({}), text = ""): StubElement {
  return new StubElement(attrs, text);
}

function snapshot(input: AriaSnapshot): AriaSnapshot {
  return Object.freeze({
    checked: input.checked,
    current: input.current,
    disabled: input.disabled,
    hidden: input.hidden,
    open: input.open,
    pressed: input.pressed,
    selected: input.selected,
  });
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
