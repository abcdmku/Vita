import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import {
  bootstrapDesktop,
} from "../../../../ui_kits/desktop/runtime/bootstrap.ts";
import type {
  StatusbarClockScheduler,
} from "../../../../ui_kits/desktop/runtime/bootstrap.ts";
import type {
  VitaElement,
  VitaElementList,
  VitaEventLike,
  VitaEventListener,
} from "../../../../ui_kits/desktop/runtime/binder.ts";
import type {
  ScreenModule,
  ScreenViewModel,
} from "../../../../ui_kits/desktop/runtime/screen.ts";
import {
  formatLockClockDisplay,
} from "../../../../ui_kits/desktop/viewmodels/Lock.ts";
import {
  createStatusbarClockViewModel,
} from "../../../../ui_kits/desktop/viewmodels/statusbar-clock.ts";
import type {
  StatusbarClockDisplay,
  StatusbarClockTickResult,
} from "../../../../ui_kits/desktop/viewmodels/statusbar-clock.ts";

const STATUSBAR_HTML = '<span class="clk" data-vita-bind-text="statusbar.time">10:24</span>';
const FROZEN_SAMPLE_MS = Date.UTC(2024, 5, 25, 10, 24, 0);
const MENUBAR_FILES = Object.freeze([
  "index.html",
  "Activity.html",
  "Files.html",
  "Notifications.html",
  "Settings.html",
  "Shell.html",
] as const);

test("statusbar clock formats only injected instants and is not a frozen 10:24 constant", () => {
  const arbitraryInitial = Date.UTC(2026, 0, 1, 8, 15, 0);
  const later = Date.UTC(2026, 0, 1, 11, 5, 0);
  const model = createStatusbarClockViewModel({
    initialNow: arbitraryInitial,
  });

  assert.equal(model.snapshot().time, formatLockClockDisplay(arbitraryInitial).time);
  assert.notEqual(model.snapshot().time, "10:24");

  const sample = model.tick(FROZEN_SAMPLE_MS);

  assertTickDisplay(sample);
  assert.equal(sample.time, "10:24");
  assert.equal(model.snapshot().time, "10:24");

  const updated = model.tick(later);

  assertTickDisplay(updated);
  assert.equal(updated.time, formatLockClockDisplay(later).time);
  assert.notEqual(updated.time, sample.time);
  assert.notEqual(updated.time, "10:24");
});

test("statusbar clock snapshots are byte-identical to the lock clock formatter", () => {
  const initial = Date.UTC(2026, 2, 3, 4, 5, 6);
  const next = Date.UTC(2026, 10, 9, 21, 7, 30);
  const model = createStatusbarClockViewModel({
    initialNow: initial,
  });

  assert.equal(JSON.stringify(model.snapshot()), JSON.stringify(formatLockClockDisplay(initial)));
  assert.deepEqual(model.snapshot(), formatLockClockDisplay(initial));
  assert.equal(Object.isFrozen(model.snapshot()), true);

  const ticked = model.tick(new Date(next));

  assertTickDisplay(ticked);
  assert.equal(JSON.stringify(model.snapshot()), JSON.stringify(formatLockClockDisplay(next)));
  assert.deepEqual(model.snapshot(), formatLockClockDisplay(next));
  assert.equal(ticked.time, formatLockClockDisplay(next).time);
  assert.equal(ticked.date, formatLockClockDisplay(next).date);
});

test("statusbar clock invalid ticks fail closed without throwing or mutating", () => {
  const model = createStatusbarClockViewModel({
    initialNow: Date.UTC(2026, 5, 25, 14, 30, 0),
  });
  const before = model.snapshot();
  const invalids = Object.freeze([
    Number.POSITIVE_INFINITY,
    new Date(Number.NaN),
    Object.freeze({}),
  ]);

  for (let index = 0; index < invalids.length; index += 1) {
    const invalid = invalids[index];
    let result: StatusbarClockTickResult | undefined;

    assert.doesNotThrow(() => {
      result = model.tick(invalid);
    });
    assert.notEqual(result, undefined);

    if (result === undefined || !("ok" in result)) {
      assert.fail("expected invalid statusbar clock tick to fail closed");
    }

    assert.equal(result.error.code, "INVALID_TIME");
    assert.equal(result.display, before);
    assert.equal(model.snapshot(), before);
    assert.equal(Object.isFrozen(result), true);
    assert.equal(Object.isFrozen(result.error), true);
  }
});

test("statusbar clock snapshots are deterministic and frozen for identical instants", () => {
  const instant = Date.UTC(2026, 6, 4, 12, 34, 56);
  const first = createStatusbarClockViewModel({
    initialNow: instant,
  });
  const second = createStatusbarClockViewModel({
    initialNow: new Date(instant),
  });

  assert.equal(JSON.stringify(first.snapshot()), JSON.stringify(second.snapshot()));
  assert.equal(Object.isFrozen(first.snapshot()), true);
  assert.equal(Object.isFrozen(second.snapshot()), true);

  const firstTick = first.tick(instant);
  const secondTick = second.tick(new Date(instant));

  assertTickDisplay(firstTick);
  assertTickDisplay(secondTick);
  assert.equal(JSON.stringify(first.snapshot()), JSON.stringify(second.snapshot()));
  assert.equal(JSON.stringify(firstTick), JSON.stringify(secondTick));
  assert.equal(Object.isFrozen(firstTick), true);
  assert.equal(Object.isFrozen(secondTick), true);
});

test("bootstrap drives statusbar.time and statusbar.date through an injectable scheduler", async () => {
  const root = element({
    "data-vita-screen": "desktop/statusbar-test",
  });
  const clock = element({
    "data-vita-bind-text": "statusbar.time",
  }, "10:24");
  const date = element({
    "data-vita-bind-text": "statusbar.date",
  }, "stale");
  const scheduler = new ManualScheduler();
  const initial = Date.UTC(2026, 1, 2, 3, 4, 0);
  const ticks = Object.freeze([
    Date.UTC(2026, 1, 2, 3, 5, 0),
    Date.UTC(2026, 1, 2, 3, 6, 0),
  ]);
  let readIndex = 0;

  root.appendChild(clock);
  root.appendChild(date);

  const runtime = await bootstrapDesktop({
    document: new StubDocument(Object.freeze([root])),
    modules: Object.freeze([emptyScreenModule("desktop/statusbar-test")]),
    statusbarClock: {
      initialNow: initial,
      intervalMs: 250,
      now(): number {
        const value = ticks[readIndex];

        readIndex += 1;
        return value ?? ticks[ticks.length - 1] ?? initial;
      },
      scheduler,
    },
  });

  assert.equal(clock.textContent, formatLockClockDisplay(initial).time);
  assert.equal(date.textContent, formatLockClockDisplay(initial).date);
  assert.equal(scheduler.activeCount(), 1);
  assert.equal(scheduler.firstIntervalMs(), 250);

  scheduler.fireFirst();

  assert.equal(clock.textContent, formatLockClockDisplay(ticks[0] ?? initial).time);
  assert.equal(date.textContent, formatLockClockDisplay(ticks[0] ?? initial).date);

  scheduler.fireFirst();

  assert.equal(clock.textContent, formatLockClockDisplay(ticks[1] ?? initial).time);
  assert.equal(date.textContent, formatLockClockDisplay(ticks[1] ?? initial).date);

  runtime.dispose();
  assert.equal(scheduler.activeCount(), 0);
});

test("desktop menubar HTML binds only the six target status clocks", () => {
  for (let index = 0; index < MENUBAR_FILES.length; index += 1) {
    const file = MENUBAR_FILES[index];

    if (file === undefined) continue;

    const html = readDesktopHtml(file);

    assert.equal(countOccurrences(html, STATUSBAR_HTML), 1, file);
    assert.equal(html.includes('<span class="clk">10:24</span>'), false, file);
  }

  const lock = readDesktopHtml("Lock.html");
  const tiling = readDesktopHtml("Tiling.html");

  assert.equal(lock.includes('data-vita-bind-text="lock.time">10:24'), true);
  assert.equal(lock.includes('data-vita-bind-text="statusbar.time"'), false);
  assert.equal(tiling.includes('data-vita-bind-text="tiling.layout">10:24'), true);
  assert.equal(tiling.includes('data-vita-bind-text="statusbar.time"'), false);
});

interface EmptyState {
  readonly ready: true;
}

interface EmptyPorts {}

class EmptyViewModel implements ScreenViewModel<EmptyState> {
  snapshot(): EmptyState {
    return Object.freeze({
      ready: true,
    });
  }
}

function emptyScreenModule(id: string): ScreenModule<EmptyState, EmptyPorts, EmptyViewModel> {
  return Object.freeze({
    actions: new Map(),
    binds: new Map(),
    createViewModel(): EmptyViewModel {
      return new EmptyViewModel();
    },
    id,
    selectPorts(): EmptyPorts {
      return Object.freeze({});
    },
  });
}

interface ScheduledInterval {
  active: boolean;
  readonly callback: () => void;
  readonly handle: number;
  readonly intervalMs: number;
}

class ManualScheduler implements StatusbarClockScheduler {
  readonly #tasks: ScheduledInterval[] = [];
  #nextHandle = 1;

  setInterval(callback: () => void, intervalMs: number): unknown {
    const task: ScheduledInterval = {
      active: true,
      callback,
      handle: this.#nextHandle,
      intervalMs,
    };

    this.#nextHandle += 1;
    this.#tasks.push(task);
    return task.handle;
  }

  clearInterval(handle: unknown): void {
    if (typeof handle !== "number") return;

    for (let index = 0; index < this.#tasks.length; index += 1) {
      const task = this.#tasks[index];

      if (task !== undefined && task.handle === handle) {
        task.active = false;
      }
    }
  }

  fireFirst(): void {
    const task = this.#tasks[0];

    if (task !== undefined && task.active) {
      task.callback();
    }
  }

  activeCount(): number {
    let count = 0;

    for (let index = 0; index < this.#tasks.length; index += 1) {
      if (this.#tasks[index]?.active === true) count += 1;
    }

    return count;
  }

  firstIntervalMs(): number | undefined {
    return this.#tasks[0]?.intervalMs;
  }
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

  getAttribute(name: string): string | null {
    return this.#attributes.get(name) ?? null;
  }

  setAttribute(name: string, value: string): void {
    this.#attributes.set(name, value);

    if (name.startsWith("data-")) {
      this.dataset[datasetKey(name)] = value;
    }
  }

  removeAttribute(name: string): void {
    this.#attributes.delete(name);

    if (name.startsWith("data-")) {
      Reflect.deleteProperty(this.dataset, datasetKey(name));
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

function assertTickDisplay(result: StatusbarClockTickResult): asserts result is StatusbarClockDisplay {
  if ("ok" in result) {
    assert.fail("expected valid statusbar clock tick to return a display");
  }
}
