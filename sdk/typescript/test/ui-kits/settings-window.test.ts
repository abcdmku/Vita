// Phase A2 — generated settings / Properties window.
//
// Covers: the form generated from a schema (one control per type, current values rendered); the raw
// TS config-file view; the "no schema" empty state; and the live form wiring (a control change writes
// through config.set and re-renders).

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  renderConfigFileText,
  renderField,
  renderSettingsWindow,
  wireSettingsForm,
} from "../../../../ui_kits/desktop/runtime/settings-window.ts";
import {
  createAppConfigHandle,
} from "../../../../ui_kits/desktop/runtime/app-config.ts";
import type {
  AppConfigSchema,
} from "../../../../ui_kits/desktop/runtime/app-sdk.ts";
import type {
  WmElement,
} from "../../../../ui_kits/desktop/runtime/window-manager.ts";

const SCHEMA: AppConfigSchema = Object.freeze([
  Object.freeze({ default: 1.5, key: "refreshSeconds", label: "Refresh (s)", type: "number" }),
  Object.freeze({ default: true, key: "showProcesses", label: "Show processes", type: "boolean" }),
  Object.freeze({ default: "name", key: "sort", label: "Sort", type: "enum", options: Object.freeze([
    Object.freeze({ value: "name", label: "By name" }),
    Object.freeze({ value: "cpu", label: "By CPU" }),
  ]) }),
  Object.freeze({ default: "Vita", key: "label", label: "Label", type: "string" }),
]);

const SNAPSHOT = Object.freeze({
  label: "Vita",
  refreshSeconds: 1.5,
  showProcesses: true,
  sort: "name",
});

test("settings form renders one control per property type", () => {
  const html = renderSettingsWindow({
    appIcon: "📊",
    appId: "vita.app.activity",
    appTitle: "Activity",
    schema: SCHEMA,
    snapshot: SNAPSHOT,
  });

  // Header + tab strip.
  assert.match(html, /Activity — Properties/);
  assert.match(html, /vita\.app\.activity/);
  assert.match(html, /data-vita-settings-tab="form"/);
  assert.match(html, /data-vita-settings-tab="raw"/);

  // number → number input; boolean → checkbox; enum → select; string → text input.
  assert.match(html, /<input type="number"[^>]*data-vita-config-key="refreshSeconds"[^>]*value="1.5"/);
  assert.match(html, /<input type="checkbox"[^>]*data-vita-config-key="showProcesses"[^>]* checked/);
  assert.match(html, /<select[^>]*data-vita-config-key="sort"/);
  assert.match(html, /<option value="cpu">By CPU<\/option>/);
  assert.match(html, /<option value="name" selected>By name<\/option>/);
  assert.match(html, /<input type="text"[^>]*data-vita-config-key="label"[^>]*value="Vita"/);
});

test("renderField marks the enum's current value as selected", () => {
  const enumProp = SCHEMA[2]!;
  const html = renderField(enumProp, "cpu");

  assert.match(html, /<option value="cpu" selected>By CPU<\/option>/);
  assert.match(html, /<option value="name">By name<\/option>/);
});

test("settings form shows an empty state when the app has no schema", () => {
  const html = renderSettingsWindow({
    appIcon: "🧮",
    appId: "vita.app.noconfig",
    appTitle: "NoConfig",
    schema: Object.freeze([]),
    snapshot: Object.freeze({}),
  });

  assert.match(html, /No configurable settings/);
  assert.match(html, /does not declare a config schema/);
});

test("raw tab renders the typed TS config-file text", () => {
  const html = renderSettingsWindow({
    appIcon: "📊",
    appId: "vita.app.activity",
    appTitle: "Activity",
    schema: SCHEMA,
    snapshot: SNAPSHOT,
    tab: "raw",
  });

  assert.match(html, /\/var\/lib\/vita\/apps\/vita\.app\.activity\/config\.ts/);
  assert.match(html, /export const config/);
  assert.match(html, /refreshSeconds: 1\.5/);
  assert.match(html, /showProcesses: true/);
  assert.match(html, /sort: &quot;name&quot;/); // string value, html-escaped inside <pre>
});

test("renderConfigFileText produces typed TS with quoted string keys when needed", () => {
  const schema: AppConfigSchema = Object.freeze([
    Object.freeze({ default: "x", key: "weird-key", label: "Weird", type: "string" }),
  ]);
  const text = renderConfigFileText("app.x", schema, Object.freeze({ "weird-key": "x" }));

  assert.match(text, /"weird-key": "x"/);
  assert.match(text, /export default config;/);
});

// ----- live wiring -----

test("wireSettingsForm writes a control change through config.set and re-renders", () => {
  const config = createAppConfigHandle({ appId: "vita.app.activity", schema: SCHEMA });
  const root = fakeElement();
  let lastHtml = "";

  const wiring = wireSettingsForm({
    appIcon: "📊",
    appId: "vita.app.activity",
    appTitle: "Activity",
    config,
    root: root as unknown as WmElement,
    setHtml: (html) => { lastHtml = html; },
  });

  // Simulate a `change` on the number control with a new value.
  root.fire("change", {
    target: fakeControl({ "data-vita-config-key": "refreshSeconds", "data-vita-config-type": "number" }, "8"),
  });

  assert.equal(config.get("refreshSeconds"), 8);
  assert.match(lastHtml, /value="8"/);

  // Simulate a checkbox toggle (boolean reads .checked).
  root.fire("change", {
    target: fakeControl({ "data-vita-config-key": "showProcesses", "data-vita-config-type": "boolean" }, undefined, false),
  });

  assert.equal(config.get("showProcesses"), false);

  // A tab click switches the active view.
  root.fire("click", { target: fakeControl({ "data-vita-settings-tab": "raw" }, undefined) });
  assert.match(lastHtml, /export const config/);

  wiring.dispose();
});

// ----- minimal DOM stubs -----

interface FakeControl {
  getAttribute(name: string): string | null;
  value?: string;
  checked?: boolean;
  closest(selector: string): FakeControl | null;
}

function fakeControl(
  attrs: Readonly<Record<string, string>>,
  value: string | undefined,
  checked?: boolean,
): FakeControl {
  const self: FakeControl = {
    closest(selector: string): FakeControl | null {
      // The selectors used are [data-vita-config-key] and [data-vita-settings-tab]; match by presence.
      const attr = selector.replace(/^\[/, "").replace(/\]$/, "");

      return attrs[attr] !== undefined ? self : null;
    },
    getAttribute(name: string): string | null {
      return attrs[name] ?? null;
    },
  };

  if (value !== undefined) self.value = value;
  if (checked !== undefined) self.checked = checked;

  return self;
}

interface FakeElement {
  addEventListener(type: string, listener: (event: unknown) => void): void;
  removeEventListener(type: string, listener: (event: unknown) => void): void;
  fire(type: string, event: unknown): void;
}

function fakeElement(): FakeElement {
  const listeners = new Map<string, Set<(event: unknown) => void>>();

  return {
    addEventListener(type, listener): void {
      const set = listeners.get(type) ?? new Set();

      set.add(listener);
      listeners.set(type, set);
    },
    fire(type, event): void {
      for (const listener of listeners.get(type) ?? []) listener(event);
    },
    removeEventListener(type, listener): void {
      listeners.get(type)?.delete(listener);
    },
  };
}
