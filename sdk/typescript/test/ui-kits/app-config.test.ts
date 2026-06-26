// Phase A2 — per-app typed config handle (ctx.config).
//
// Covers: defaults from the manifest schema; set/update coercion + validation; the optional
// persistence backend (load on construct + write on change); onChange notifications; and fail-closed
// behaviour when the backend is absent or throws.

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  createAppConfigHandle,
  readAppConfigBackend,
} from "../../../../ui_kits/desktop/runtime/app-config.ts";
import type {
  AppConfigBackend,
} from "../../../../ui_kits/desktop/runtime/app-config.ts";
import {
  appConfigDefaults,
  coerceConfigValue,
} from "../../../../ui_kits/desktop/runtime/app-sdk.ts";
import type {
  AppConfigProperty,
  AppConfigSchema,
  AppConfigValue,
} from "../../../../ui_kits/desktop/runtime/app-sdk.ts";

const SCHEMA: AppConfigSchema = Object.freeze([
  Object.freeze({ default: 1.5, key: "refreshSeconds", label: "Refresh (s)", type: "number" }),
  Object.freeze({ default: true, key: "showProcesses", label: "Show processes", type: "boolean" }),
  Object.freeze({ default: "name", key: "sort", label: "Sort", type: "enum", options: Object.freeze([
    Object.freeze({ value: "name" }),
    Object.freeze({ value: "cpu", label: "CPU" }),
  ]) }),
  Object.freeze({ default: "Vita", key: "label", label: "Label", type: "string" }),
]) satisfies readonly AppConfigProperty[];

test("appConfigDefaults resolves every schema key to its default", () => {
  const defaults = appConfigDefaults(SCHEMA);

  assert.deepEqual({ ...defaults }, {
    label: "Vita",
    refreshSeconds: 1.5,
    showProcesses: true,
    sort: "name",
  });
  assert.equal(Object.isFrozen(defaults), true);
});

test("appConfigDefaults with no schema is an empty snapshot", () => {
  assert.deepEqual({ ...appConfigDefaults(undefined) }, {});
});

test("coerceConfigValue validates per type and falls back on bad input", () => {
  const num = SCHEMA[0]!;
  const bool = SCHEMA[1]!;
  const en = SCHEMA[2]!;

  assert.equal(coerceConfigValue(num, "3"), 3); // string → number
  assert.equal(coerceConfigValue(num, "nope"), 1.5); // invalid → default
  assert.equal(coerceConfigValue(bool, "false"), false); // string → boolean
  assert.equal(coerceConfigValue(en, "cpu"), "cpu"); // valid enum
  assert.equal(coerceConfigValue(en, "bogus"), "name"); // invalid enum → default
});

test("handle starts at defaults; get returns undefined for unknown keys", () => {
  const config = createAppConfigHandle({ appId: "app.x", schema: SCHEMA });

  assert.equal(config.get("refreshSeconds"), 1.5);
  assert.equal(config.get("showProcesses"), true);
  assert.equal(config.get("nope"), undefined);
  assert.equal(config.schema, SCHEMA);
});

test("set coerces against the schema and notifies onChange", () => {
  const config = createAppConfigHandle({ appId: "app.x", schema: SCHEMA });
  const seen: AppConfigValue[] = [];

  config.onChange((snapshot) => seen.push(snapshot["refreshSeconds"]!));

  // string "2" coerced to number 2
  const next = config.set("refreshSeconds", "2" as unknown as number);

  assert.equal(next["refreshSeconds"], 2);
  assert.equal(config.get("refreshSeconds"), 2);
  assert.deepEqual(seen, [2]);
});

test("set with an unchanged value does not notify", () => {
  const config = createAppConfigHandle({ appId: "app.x", schema: SCHEMA });
  let count = 0;

  config.onChange(() => { count += 1; });
  config.set("showProcesses", true); // already the default

  assert.equal(count, 0);
});

test("set ignores unknown keys (fail-closed to the schema)", () => {
  const config = createAppConfigHandle({ appId: "app.x", schema: SCHEMA });

  const snapshot = config.set("notInSchema", "x");

  assert.equal(Object.prototype.hasOwnProperty.call(snapshot, "notInSchema"), false);
});

test("update patches several keys at once", () => {
  const config = createAppConfigHandle({ appId: "app.x", schema: SCHEMA });

  const snapshot = config.update({ refreshSeconds: 5, sort: "cpu" });

  assert.equal(snapshot["refreshSeconds"], 5);
  assert.equal(snapshot["sort"], "cpu");
  assert.equal(snapshot["showProcesses"], true); // untouched
});

test("onChange unsubscribe stops further notifications", () => {
  const config = createAppConfigHandle({ appId: "app.x", schema: SCHEMA });
  let count = 0;
  const off = config.onChange(() => { count += 1; });

  config.set("refreshSeconds", 2);
  off();
  config.set("refreshSeconds", 3);

  assert.equal(count, 1);
});

test("persistence backend writes overrides on set", () => {
  const writes: { appId: string; overrides: Readonly<Record<string, AppConfigValue>> }[] = [];
  const backend: AppConfigBackend = {
    read: () => undefined,
    write: (appId, overrides) => { writes.push({ appId, overrides: { ...overrides } }); },
  };
  const config = createAppConfigHandle({ appId: "app.x", backend, schema: SCHEMA });

  config.set("refreshSeconds", 9);

  assert.equal(writes.length, 1);
  assert.equal(writes[0]!.appId, "app.x");
  assert.equal(writes[0]!.overrides["refreshSeconds"], 9);
});

test("persistence backend loads stored overrides and notifies (async)", async () => {
  const backend: AppConfigBackend = {
    read: () => ({ refreshSeconds: 4, showProcesses: false }),
    write: () => {},
  };
  const config = createAppConfigHandle({ appId: "app.x", backend, schema: SCHEMA });
  const seen: AppConfigValue[] = [];

  config.onChange((snapshot) => { seen.push(snapshot["refreshSeconds"]!); });

  // The async load merges + notifies on a microtask; await a tick.
  await Promise.resolve();
  await Promise.resolve();

  assert.equal(config.get("refreshSeconds"), 4);
  assert.equal(config.get("showProcesses"), false);
  assert.ok(seen.includes(4));
});

test("a throwing backend fails closed to defaults", async () => {
  const backend: AppConfigBackend = {
    read: () => { throw new Error("boom"); },
    write: () => { throw new Error("boom"); },
  };
  const config = createAppConfigHandle({ appId: "app.x", backend, schema: SCHEMA });

  await Promise.resolve();

  // Still on defaults; set still works in-memory despite the throwing write.
  assert.equal(config.get("refreshSeconds"), 1.5);
  assert.doesNotThrow(() => config.set("refreshSeconds", 7));
  assert.equal(config.get("refreshSeconds"), 7);
});

test("readAppConfigBackend probes an OWN appConfig data property only", () => {
  const backend: AppConfigBackend = { read: () => undefined, write: () => {} };

  assert.equal(readAppConfigBackend({ appConfig: backend }), backend);
  assert.equal(readAppConfigBackend({}), undefined);
  assert.equal(readAppConfigBackend(null), undefined);
  // A getter (accessor) is not an OWN data descriptor → ignored (fail-closed, no trap invocation).
  const trap = {};

  Object.defineProperty(trap, "appConfig", { get: () => backend });
  assert.equal(readAppConfigBackend(trap), undefined);
});
