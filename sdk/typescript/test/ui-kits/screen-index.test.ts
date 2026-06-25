import assert from "node:assert/strict";
import { test } from "node:test";

import {
  hydrateScreen,
} from "../../../../ui_kits/desktop/runtime/hydrate.ts";
import {
  createSurfaceHost,
} from "../../../../ui_kits/desktop/runtime/host-bridge.ts";
import type {
  SurfaceHostRequest,
  SurfaceHostTransport,
} from "../../../../ui_kits/desktop/runtime/host-bridge.ts";
import type {
  VitaElement,
  VitaElementList,
  VitaEventLike,
  VitaEventListener,
} from "../../../../ui_kits/desktop/runtime/binder.ts";
import {
  indexScreenModule,
} from "../../../../ui_kits/desktop/screens/index.ts";
import {
  INDEX_DOCK_APP_IDS,
} from "../../../../ui_kits/desktop/viewmodels/dock.ts";
import {
  INDEX_PALETTE_APP_IDS,
} from "../../../../ui_kits/desktop/viewmodels/index.ts";
import type {
  DesktopCapability,
  DesktopCapabilityGrant,
  DesktopHost,
  DesktopUiPackageManifest,
} from "../../src/desktop-sdk/index.ts";

test("index screen hydrates palette query, nav, execute, and dock launch", async () => {
  const dom = indexDom();
  const events: string[] = [];
  const host = bridgeHost(events, [
    grant("apps.launch", INDEX_PALETTE_APP_IDS.files),
    grant("apps.launch", INDEX_DOCK_APP_IDS.terminal),
  ]);

  const screen = await hydrateScreen(dom.root, indexScreenModule, host);

  assert.equal(screen.ok, true);
  assert.equal(dom.root.listenerCount("click"), 1);
  assert.equal(dom.root.listenerCount("input"), 1);
  assert.deepEqual(resultTitles(dom.results).slice(0, 3), [
    "Run kernel.ts",
    "Open Files",
    "Toggle Dark Mode",
  ]);
  assert.equal(dom.results.attribute("data-vita-highlighted-index"), "0");

  dom.query.setAttribute("data-vita-query", "files");
  dom.root.dispatch("input", dom.query);

  assert.deepEqual(resultTitles(dom.results), ["Open Files"]);
  assert.equal(dom.results.attribute("data-vita-highlighted-index"), "0");

  dom.query.setAttribute("data-vita-query", "");
  dom.query.textContent = "";
  dom.root.dispatch("input", dom.query);
  dom.root.dispatch("click", dom.navNext);

  assert.equal(dom.results.attribute("data-vita-highlighted-index"), "1");
  assert.equal(dom.results.children[0]?.attribute("aria-selected"), "false");
  assert.equal(dom.results.children[1]?.attribute("aria-selected"), "true");

  const filesRow = dom.results.children[1];

  assert.notEqual(filesRow, undefined);
  dom.root.dispatch("click", filesRow ?? dom.results);
  await flushAsync();

  assert.deepEqual(events, [
    `launch:${INDEX_PALETTE_APP_IDS.files}`,
  ]);
  assert.equal(dom.error.textContent, "");

  dom.root.dispatch("click", dom.terminalDock);
  await flushAsync();

  assert.deepEqual(events, [
    `launch:${INDEX_PALETTE_APP_IDS.files}`,
    `launch:${INDEX_DOCK_APP_IDS.terminal}`,
  ]);
  assert.equal(dom.terminalDock.hasClass("on"), true);
  assert.equal(dom.terminalDock.attribute("aria-pressed"), "true");

  dom.root.dispatch("click", dom.terminalDock);
  await flushAsync();

  assert.deepEqual(events, [
    `launch:${INDEX_PALETTE_APP_IDS.files}`,
    `launch:${INDEX_DOCK_APP_IDS.terminal}`,
  ]);
});

test("index screen sends failed palette execution to the error sink without throwing", async () => {
  const dom = indexDom();
  const events: string[] = [];
  const host = bridgeHost(events, [
    grant("apps.launch", INDEX_PALETTE_APP_IDS.files),
  ], {
    rejectAppIds: new Set([INDEX_PALETTE_APP_IDS.files]),
  });

  const screen = await hydrateScreen(dom.root, indexScreenModule, host);

  assert.equal(screen.ok, true);

  dom.query.setAttribute("data-vita-query", "files");
  dom.root.dispatch("input", dom.query);

  const filesRow = dom.results.children[0];

  assert.notEqual(filesRow, undefined);
  assert.doesNotThrow(() => {
    dom.root.dispatch("click", filesRow ?? dom.results);
  });
  await flushAsync();

  assert.deepEqual(events, [
    `launch:${INDEX_PALETTE_APP_IDS.files}`,
  ]);
  assert.equal(dom.error.textContent, "launch rejected by fake bridge.");

  if (!screen.ok) {
    assert.fail("expected active index screen");
  }
  const snapshot = screen.snapshot();

  assert.equal(snapshot.scope, "index.screen");
  if (snapshot.scope !== "index.screen") {
    assert.fail("expected root index screen state");
  }
  assert.equal(snapshot.error?.code, "APP_REJECTED");
});

interface IndexDom {
  readonly root: StubElement;
  readonly query: StubElement;
  readonly navNext: StubElement;
  readonly results: StubElement;
  readonly error: StubElement;
  readonly terminalDock: StubElement;
}

function indexDom(): IndexDom {
  const root = element({
    "data-vita-screen": "desktop",
  });
  const query = element({
    "data-vita-action": "palette.query",
    "data-vita-event": "input",
  });
  const navNext = element({
    "data-vita-action": "palette.nav",
    "data-vita-delta": "1",
    "data-vita-event": "click",
  });
  const results = element({
    "data-vita-bind-attr-0": "data-vita-highlighted-index:highlightedIndex",
    "data-vita-bind-list": "results",
  });
  const template = resultTemplate();
  const error = element({
    "data-vita-bind-text": "error",
  });
  const terminalDock = element({
    "data-vita-action": "dock.launchOrFocus",
    "data-vita-bind-attr-0": `aria-pressed:dock.${INDEX_DOCK_APP_IDS.terminal}.active`,
    "data-vita-bind-class": `on:dock.${INDEX_DOCK_APP_IDS.terminal}.active`,
    "data-vita-dock-app-id": INDEX_DOCK_APP_IDS.terminal,
    "data-vita-event": "click",
  });

  results.appendChild(template);
  root.appendChild(query);
  root.appendChild(navNext);
  root.appendChild(results);
  root.appendChild(error);
  root.appendChild(terminalDock);

  return Object.freeze({
    error,
    navNext,
    query,
    results,
    root,
    terminalDock,
  });
}

function resultTemplate(): StubElement {
  const row = element({
    "data-vita-action": "palette.execute",
    "data-vita-event": "click",
    "data-vita-key": "template",
  });
  const title = element({
    "data-vita-bind-text": "result.title",
  });
  const subtitle = element({
    "data-vita-bind-text": "result.subtitle",
  });

  row.appendChild(title);
  row.appendChild(subtitle);
  return row;
}

function resultTitles(results: StubElement): readonly string[] {
  const output: string[] = [];

  for (let index = 0; index < results.children.length; index += 1) {
    const row = results.children[index];
    const title = row?.children[0]?.textContent;

    if (title !== undefined && title !== null) output.push(title);
  }

  return Object.freeze(output);
}

function bridgeHost(
  events: string[],
  grants: readonly DesktopCapabilityGrant[],
  options: {
    readonly rejectAppIds?: ReadonlySet<string>;
  } = Object.freeze({}),
): DesktopHost {
  const transport: SurfaceHostTransport = Object.freeze({
    package: manifest(grants),
    request(request: SurfaceHostRequest): unknown {
      if (request.method === "launchApp") {
        const appId = stringField(request.args[0], "id") ?? "unknown";

        events.push(`launch:${appId}`);

        if (options.rejectAppIds?.has(appId) === true) {
          return hostReject("APP_REJECTED", "launch rejected by fake bridge.", `/apps/${appId}`);
        }

        return Object.freeze({
          ok: true,
          value: Object.freeze({
            app: request.args[0],
            intents: Object.freeze([]),
            surfaceId: `surface:${appId}`,
            textureId: `texture:${appId}`,
            windowId: `window:${appId}`,
          }),
        });
      }

      if (request.method === "emitLauncherIntent") {
        const appId = stringField(request.args[0], "appId") ?? "";
        const query = stringField(request.args[0], "query") ?? "";
        const type = stringField(request.args[0], "type") ?? "";

        events.push(`launcher:${type}:${appId}:${query}`);

        return Object.freeze({
          ok: true,
          value: true,
        });
      }

      return hostReject("UNEXPECTED_BRIDGE_METHOD", `unexpected bridge method ${request.method}.`, `/${request.method}`);
    },
  });

  return createSurfaceHost(transport, {
    package: manifest(grants),
  });
}

function manifest(grants: readonly DesktopCapabilityGrant[]): DesktopUiPackageManifest {
  return Object.freeze({
    capabilityGrants: Object.freeze([...grants]),
    entry: "./screen-index.ts",
    id: "ui.screen-index.test",
    sdkVersion: "1.0.0",
    version: "1.0.0",
  });
}

function grant(
  capability: DesktopCapability,
  resourceId?: string,
): DesktopCapabilityGrant {
  const output: {
    capability: DesktopCapability;
    resourceId?: string;
  } = {
    capability,
  };

  if (resourceId !== undefined) output.resourceId = resourceId;

  return Object.freeze(output);
}

function hostReject(code: string, message: string, path: string): unknown {
  return Object.freeze({
    error: Object.freeze({
      code,
      message,
      path,
    }),
    ok: false,
  });
}

function stringField(value: unknown, key: string): string | undefined {
  if (value === undefined || value === null || typeof value !== "object" || Array.isArray(value)) return undefined;

  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);

    if (descriptor === undefined || !Object.prototype.hasOwnProperty.call(descriptor, "value")) {
      return undefined;
    }

    return typeof descriptor.value === "string" ? descriptor.value : undefined;
  } catch {
    return undefined;
  }
}

async function flushAsync(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  await new Promise<void>((resolve) => {
    setTimeout(resolve, 0);
  });
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

  dispatch(type: string, target: StubElement, extra: Readonly<Record<string, string>> = Object.freeze({})): void {
    const listeners = this.#listeners.get(type) ?? [];
    const event = Object.freeze({
      ...extra,
      target,
      type,
    }) satisfies VitaEventLike;
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
