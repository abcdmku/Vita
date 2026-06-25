import assert from "node:assert/strict";
import { test } from "node:test";

import {
  hydrateScreen,
} from "../../../../ui_kits/desktop/runtime/hydrate.ts";
import {
  createSurfaceHost,
} from "../../../../ui_kits/desktop/runtime/host-bridge.ts";
import type {
  HostBridgeJson,
  HostBridgeJsonObject,
  SurfaceHostRequest,
} from "../../../../ui_kits/desktop/runtime/host-bridge.ts";
import {
  settingsScreenModule,
} from "../../../../ui_kits/desktop/screens/settings.ts";
import {
  SETTINGS_APPEARANCE_KEYS,
} from "../../../../ui_kits/desktop/viewmodels/Settings.ts";
import type {
  VitaElement,
  VitaElementList,
  VitaEventLike,
  VitaEventListener,
} from "../../../../ui_kits/desktop/runtime/binder.ts";

test("settings screen hydrates appearance controls into root classes and accent CSS variable", async () => {
  const fixture = settingsDom();
  const settings = new Map<string, string>([
    [SETTINGS_APPEARANCE_KEYS.activeSection, "appearance"],
    [SETTINGS_APPEARANCE_KEYS.theme, "light"],
    [SETTINGS_APPEARANCE_KEYS.accent, "blue"],
    [SETTINGS_APPEARANCE_KEYS.layout, "comfortable"],
  ]);
  const host = createSurfaceHost(settingsTransport(settings));
  const screen = await hydrateScreen(fixture.root, settingsScreenModule, host);

  assert.equal(screen.ok, true);
  if (!screen.ok) {
    assert.fail("expected settings screen to hydrate");
  }

  assert.equal(fixture.root.hasClass("theme-dark"), false);
  assert.equal(fixture.root.hasClass("v-wall-light"), true);
  assert.equal(fixture.root.hasClass("v-wall-dark"), false);
  assert.equal(fixture.root.attribute("style"), "--accent: #3178c6;");
  assert.equal(fixture.light.hasClass("on"), true);
  assert.equal(fixture.dark.hasClass("on"), false);
  assert.equal(fixture.blue.hasClass("on"), true);
  assert.equal(fixture.teal.hasClass("on"), false);

  fixture.root.dispatch("click", fixture.dark);
  await flushAsyncActions();

  assert.equal(settings.get(SETTINGS_APPEARANCE_KEYS.theme), "dark");
  assert.equal(fixture.root.hasClass("theme-dark"), true);
  assert.equal(fixture.root.hasClass("v-wall-dark"), true);
  assert.equal(fixture.root.hasClass("v-wall-light"), false);
  assert.equal(fixture.dark.hasClass("on"), true);
  assert.equal(fixture.light.hasClass("on"), false);

  fixture.root.dispatch("click", fixture.teal);
  await flushAsyncActions();

  assert.equal(settings.get(SETTINGS_APPEARANCE_KEYS.accent), "teal");
  assert.equal(fixture.root.attribute("style"), "--accent: #14b8a6;");
  assert.equal(fixture.blue.hasClass("on"), false);
  assert.equal(fixture.teal.hasClass("on"), true);

  fixture.root.dispatch("click", fixture.tiling);
  await flushAsyncActions();

  assert.equal(settings.get(SETTINGS_APPEARANCE_KEYS.layout), "tiling");
  assert.equal(fixture.root.hasClass("mode-tiling"), true);
  assert.equal(fixture.floating.hasClass("on"), false);
  assert.equal(fixture.tiling.hasClass("on"), true);
});

interface SettingsDomFixture {
  readonly root: StubElement;
  readonly blue: StubElement;
  readonly dark: StubElement;
  readonly floating: StubElement;
  readonly light: StubElement;
  readonly teal: StubElement;
  readonly tiling: StubElement;
}

function settingsDom(): SettingsDomFixture {
  const root = element({
    "data-vita-bind-attr-0": "style:accentStyle",
    "data-vita-bind-class": "theme-dark:themeDark v-wall-dark:themeWallDark v-wall-light:themeWallLight mode-tiling:layoutTiling",
    "data-vita-screen": "desktop/settings",
  });
  const dark = element({
    "data-vita-action": "setTheme",
    "data-vita-bind-class": "on:themeDarkSelected",
    "data-vita-value": "dark",
  });
  const light = element({
    "data-vita-action": "setTheme",
    "data-vita-bind-class": "on:themeLightSelected",
    "data-vita-value": "light",
  });
  const blue = element({
    "data-vita-action": "setAccent",
    "data-vita-bind-class": "on:accentBlueSelected",
    "data-vita-value": "blue",
  });
  const teal = element({
    "data-vita-action": "setAccent",
    "data-vita-bind-class": "on:accentTealSelected",
    "data-vita-value": "teal",
  });
  const floating = element({
    "data-vita-action": "setLayout",
    "data-vita-bind-class": "on:layoutFloatingSelected",
    "data-vita-value": "floating",
  });
  const tiling = element({
    "data-vita-action": "setLayout",
    "data-vita-bind-class": "on:layoutTilingSelected",
    "data-vita-value": "tiling",
  });

  root.appendChild(dark);
  root.appendChild(light);
  root.appendChild(blue);
  root.appendChild(teal);
  root.appendChild(floating);
  root.appendChild(tiling);

  return {
    blue,
    dark,
    floating,
    light,
    root,
    teal,
    tiling,
  };
}

function settingsTransport(settings: Map<string, string>): (request: SurfaceHostRequest) => HostBridgeJson {
  return (request) => {
    if (request.method === "readTheme") return desktopTheme();
    if (request.method === "readSetting") {
      const key = settingKey(request);

      if (key === undefined) {
        return hostReject("MALFORMED_READ", "readSetting requires a key.", "/readSetting/key");
      }

      const value = settings.get(key);

      if (value === undefined) {
        return hostReject("SETTING_NOT_FOUND", "setting is not available.", `/settings/${key}`);
      }

      return Object.freeze({
        ok: true,
        value,
      });
    }
    if (request.method === "applySetting") {
      const write = settingWrite(request);

      if (write === undefined) {
        return hostReject("MALFORMED_WRITE", "applySetting requires a string value.", "/applySetting");
      }

      settings.set(write.key, write.value);

      return Object.freeze({
        ok: true,
        value: Object.freeze({
          applied: Object.freeze({
            key: write.key,
            value: write.value,
          }),
          revision: `rev:${write.key}:${write.value}`,
        }),
      });
    }

    return hostReject("UNUSED_METHOD", "method is unused by this test.", `/${request.method}`);
  };
}

function settingKey(request: SurfaceHostRequest): string | undefined {
  const input = jsonObject(request.args[0]);
  const key = input?.["key"];

  return typeof key === "string" ? key : undefined;
}

function settingWrite(request: SurfaceHostRequest): {
  readonly key: string;
  readonly value: string;
} | undefined {
  const input = jsonObject(request.args[0]);
  const key = input?.["key"];
  const value = input?.["value"];

  return typeof key === "string" && typeof value === "string"
    ? Object.freeze({ key, value })
    : undefined;
}

function desktopTheme(): HostBridgeJson {
  return Object.freeze({
    id: "vita.test.theme",
    tokens: Object.freeze({
      colors: Object.freeze({
        background: "#ffffff",
      }),
      radii: Object.freeze({
        sm: 4,
      }),
      spacing: Object.freeze({
        sm: 8,
      }),
      typography: Object.freeze({
        body: "system-ui",
      }),
    }),
    version: "1.0.0",
  });
}

function hostReject(code: string, message: string, path: string): HostBridgeJson {
  return Object.freeze({
    error: Object.freeze({
      code,
      message,
      path,
    }),
    ok: false,
  });
}

function jsonObject(value: HostBridgeJson | undefined): HostBridgeJsonObject | undefined {
  return isJsonObject(value) ? value : undefined;
}

function isJsonObject(value: HostBridgeJson | undefined): value is HostBridgeJsonObject {
  if (value === undefined || value === null || typeof value !== "object" || Array.isArray(value)) return false;

  return true;
}

async function flushAsyncActions(): Promise<void> {
  for (let index = 0; index < 8; index += 1) {
    await Promise.resolve();
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

    if (name === "class") {
      this.#classes.clear();
      const tokens = value.split(/\s+/u);

      for (let index = 0; index < tokens.length; index += 1) {
        const token = tokens[index];

        if (token !== undefined && token.length > 0) this.#classes.add(token);
      }
    }

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
