import assert from "node:assert/strict";
import { test } from "node:test";

import {
  createSurfaceHost,
} from "../../../../ui_kits/desktop/runtime/host-bridge.ts";
import type {
  HostBridgeJson,
  HostBridgeJsonObject,
  SurfaceHostRequest,
} from "../../../../ui_kits/desktop/runtime/host-bridge.ts";
import {
  SETTINGS_APPEARANCE_KEYS,
} from "../../../../ui_kits/desktop/viewmodels/Settings.ts";
import {
  WALLPAPER_SETTING_KEYS,
} from "../../../../ui_kits/desktop/viewmodels/wallpaper.ts";
import {
  createDesktopSettingsManifestGrantPort,
  createDesktopSettingsStore,
} from "../../src/desktop-settings-store.ts";
import type {
  DesktopCapabilityGrant,
  DesktopHost,
  DesktopHostResult,
  DesktopSettingsApply,
  DesktopSettingsPreview,
  DesktopSettingsReadRequest,
  DesktopSettingsWriteRequest,
  DesktopUiPackageManifest,
} from "../../src/desktop-sdk/index.ts";

const STORE_PATH = "/var/lib/vita/desktop/settings.json";

test("readSetting returns known values and fails closed for unknown keys and missing read grants", async () => {
  const fixture = fixtureForGrants(grants("settings.read", "settings.write"));

  const read = await fixture.store.readSetting(Object.freeze({
    key: SETTINGS_APPEARANCE_KEYS.theme,
  }));

  assertHostOk(read);
  assert.equal(read.value, "light");

  const unknown = await fixture.store.readSetting(Object.freeze({
    key: "appearance.missing",
  }));

  assertHostError(unknown, "UNKNOWN_SETTING");

  const denied = await fixtureForGrants(grants("settings.write")).store.readSetting(Object.freeze({
    key: SETTINGS_APPEARANCE_KEYS.theme,
  }));

  assertHostError(denied, "MISSING_CAPABILITY");
});

test("previewSetting returns a bridge-safe diff without mutating persisted state", async () => {
  const fixture = fixtureForGrants(grants("settings.read", "settings.write"));
  const bridge = bridgeForStore(fixture.store);
  const previewSetting = bridge.previewSetting;

  assert.notEqual(previewSetting, undefined);
  if (previewSetting === undefined) assert.fail("previewSetting bridge port should exist");

  const preview = await previewSetting(Object.freeze({
    key: SETTINGS_APPEARANCE_KEYS.theme,
    value: "dark",
  }));

  assertHostOk(preview);
  assert.equal(isDesktopSettingsPreview(preview.value), true);
  assert.deepEqual(preview.value.diff, {
    after: "dark",
    before: "light",
    key: SETTINGS_APPEARANCE_KEYS.theme,
  });

  const read = await fixture.store.readSetting(Object.freeze({
    key: SETTINGS_APPEARANCE_KEYS.theme,
  }));

  assertHostOk(read);
  assert.equal(read.value, "light");
  assert.equal(fixture.fs.committedText(), undefined);
});

test("applySetting commits, returns bridge-safe applied data, and fails closed without write grants", async () => {
  const fixture = fixtureForGrants(grants("settings.read", "settings.write"));
  const bridge = bridgeForStore(fixture.store);
  const applySetting = bridge.applySetting;

  assert.notEqual(applySetting, undefined);
  if (applySetting === undefined) assert.fail("applySetting bridge port should exist");

  const applied = await applySetting(Object.freeze({
    key: SETTINGS_APPEARANCE_KEYS.layout,
    value: "tiling",
  }));

  assertHostOk(applied);
  assert.equal(isDesktopSettingsApply(applied.value), true);
  assert.deepEqual(applied.value.applied, {
    key: SETTINGS_APPEARANCE_KEYS.layout,
    value: "tiling",
  });

  const read = await fixture.store.readSetting(Object.freeze({
    key: SETTINGS_APPEARANCE_KEYS.layout,
  }));

  assertHostOk(read);
  assert.equal(read.value, "tiling");

  const denied = await fixtureForGrants(grants("settings.read")).store.applySetting(Object.freeze({
    key: SETTINGS_APPEARANCE_KEYS.layout,
    value: "compact",
  }));

  assertHostError(denied, "MISSING_CAPABILITY");
});

test("a fresh store reloads the atomically persisted document and never commits temp data", async () => {
  const fs = new MemoryAtomicSettingsFs();
  const first = createDesktopSettingsStore(Object.freeze({
    fs,
    grants: grantPort(grants("settings.read", "settings.write")),
    path: STORE_PATH,
  }));

  const applied = await first.applySetting(Object.freeze({
    key: SETTINGS_APPEARANCE_KEYS.accent,
    value: "teal",
  }));

  assertHostOk(applied);
  assert.equal(fs.directTargetWrites, 0);
  assert.deepEqual(fs.events, [
    `read:${STORE_PATH}`,
    `temp:${STORE_PATH}.tmp-1`,
    `sync:${STORE_PATH}.tmp-1`,
    `rename:${STORE_PATH}.tmp-1->${STORE_PATH}`,
  ]);
  assert.equal(fs.tempCommitted(), false);

  const second = createDesktopSettingsStore(Object.freeze({
    fs,
    grants: grantPort(grants("settings.read", "settings.write")),
    path: STORE_PATH,
  }));
  const read = await second.readSetting(Object.freeze({
    key: SETTINGS_APPEARANCE_KEYS.accent,
  }));

  assertHostOk(read);
  assert.equal(read.value, "teal");

  const failingFs = new MemoryAtomicSettingsFs();
  const unchanged = createDesktopSettingsStore(Object.freeze({
    fs: failingFs,
    grants: grantPort(grants("settings.read", "settings.write")),
    path: STORE_PATH,
  }));
  const beforeFailure = await unchanged.applySetting(Object.freeze({
    key: SETTINGS_APPEARANCE_KEYS.theme,
    value: "dark",
  }));

  assertHostOk(beforeFailure);
  const committedBeforeFailure = failingFs.committedText();

  failingFs.failNextSync = true;

  const failed = await unchanged.applySetting(Object.freeze({
    key: WALLPAPER_SETTING_KEYS.fit,
    value: "center",
  }));

  assertHostError(failed, "SETTINGS_STORE_WRITE_FAILED");
  assert.equal(failingFs.committedText(), committedBeforeFailure);
});

test("revision is deterministic for identical content and changes when content changes", async () => {
  const first = fixtureForGrants(grants("settings.read", "settings.write"));
  const second = fixtureForGrants(grants("settings.read", "settings.write"));

  const firstPreview = await first.store.previewSetting(Object.freeze({
    key: SETTINGS_APPEARANCE_KEYS.theme,
    value: "graphite",
  }));
  const secondPreview = await second.store.previewSetting(Object.freeze({
    key: SETTINGS_APPEARANCE_KEYS.theme,
    value: "graphite",
  }));

  assertHostOk(firstPreview);
  assertHostOk(secondPreview);
  assert.equal(firstPreview.value.revision, secondPreview.value.revision);

  const changed = await first.store.previewSetting(Object.freeze({
    key: SETTINGS_APPEARANCE_KEYS.theme,
    value: "dark",
  }));

  assertHostOk(changed);
  assert.notEqual(changed.value.revision, firstPreview.value.revision);
});

test("settings requests reject accessors without throwing", async () => {
  const fixture = fixtureForGrants(grants("settings.read", "settings.write"));
  const request: {
    key?: unknown;
    value?: unknown;
  } = {};
  let reads = 0;

  Object.defineProperty(request, "key", {
    enumerable: true,
    get() {
      reads += 1;
      return SETTINGS_APPEARANCE_KEYS.theme;
    },
  });
  Object.defineProperty(request, "value", {
    enumerable: true,
    value: "dark",
  });

  const result = await fixture.store.applySetting(request as DesktopSettingsWriteRequest);

  assertHostError(result, "INVALID_SETTINGS_REQUEST");
  assert.equal(reads, 0);
});

interface StoreFixture {
  readonly fs: MemoryAtomicSettingsFs;
  readonly store: ReturnType<typeof createDesktopSettingsStore>;
}

class MemoryAtomicSettingsFs {
  readonly events: string[] = [];
  directTargetWrites = 0;
  failNextSync = false;
  #counter = 0;
  #files = new Map<string, string>();
  #tempPaths = new Set<string>();

  readFile(path: string): string | undefined {
    this.events.push(`read:${path}`);

    return this.#files.get(path);
  }

  writeTempFile(request: { readonly targetPath: string; readonly contents: string }) {
    this.#counter += 1;

    const path = `${request.targetPath}.tmp-${this.#counter}`;

    this.events.push(`temp:${path}`);
    this.#tempPaths.add(path);
    this.#files.set(path, request.contents);

    return Object.freeze({ path });
  }

  syncFile(path: string): void {
    this.events.push(`sync:${path}`);
    if (this.failNextSync) {
      this.failNextSync = false;
      throw new Error("sync failed");
    }
    if (!this.#files.has(path)) throw new Error("missing temp");
  }

  rename(fromPath: string, toPath: string): void {
    this.events.push(`rename:${fromPath}->${toPath}`);

    const contents = this.#files.get(fromPath);

    if (contents === undefined) throw new Error("missing temp");
    if (fromPath === toPath) this.directTargetWrites += 1;

    this.#files.set(toPath, contents);
    this.#files.delete(fromPath);
    this.#tempPaths.delete(fromPath);
  }

  removeFile(path: string): void {
    this.events.push(`remove:${path}`);
    this.#files.delete(path);
    this.#tempPaths.delete(path);
  }

  committedText(): string | undefined {
    return this.#files.get(STORE_PATH);
  }

  tempCommitted(): boolean {
    const committed = this.committedText();

    if (committed === undefined) return false;

    for (const tempPath of this.#tempPaths) {
      if (this.#files.get(tempPath) === committed) return true;
    }

    return false;
  }
}

function fixtureForGrants(capabilityGrants: readonly DesktopCapabilityGrant[]): StoreFixture {
  const fs = new MemoryAtomicSettingsFs();

  return Object.freeze({
    fs,
    store: createDesktopSettingsStore(Object.freeze({
      fs,
      grants: grantPort(capabilityGrants),
      path: STORE_PATH,
    })),
  });
}

function grantPort(capabilityGrants: readonly DesktopCapabilityGrant[]) {
  return createDesktopSettingsManifestGrantPort(manifest(capabilityGrants));
}

function grants(...capabilities: readonly ("settings.read" | "settings.write")[]): readonly DesktopCapabilityGrant[] {
  return Object.freeze(capabilities.map((capability) => Object.freeze({ capability })));
}

function manifest(capabilityGrants: readonly DesktopCapabilityGrant[]): DesktopUiPackageManifest {
  return Object.freeze({
    capabilityGrants: Object.freeze([...capabilityGrants]),
    entry: "./desktop-settings-store.test.ts",
    id: "ui.desktop-settings-store.test",
    sdkVersion: "1.0.0",
    version: "1.0.0",
  });
}

function bridgeForStore(store: ReturnType<typeof createDesktopSettingsStore>): DesktopHost {
  return createSurfaceHost(async (request) => await routeBridgeRequest(store, request));
}

async function routeBridgeRequest(
  store: ReturnType<typeof createDesktopSettingsStore>,
  request: SurfaceHostRequest,
): Promise<unknown> {
  const arg = request.args[0];

  switch (request.method) {
    case "readSetting":
      return await store.readSetting(readRequest(arg));
    case "previewSetting":
      return await store.previewSetting(writeRequest(arg));
    case "applySetting":
      return await store.applySetting(writeRequest(arg));
    default:
      return {
        error: {
          code: "UNUSED_METHOD",
          message: "unused bridge method.",
          path: `/${request.method}`,
        },
        ok: false,
      };
  }
}

function readRequest(value: HostBridgeJson | undefined): DesktopSettingsReadRequest {
  const object = jsonObject(value);

  if (object === undefined || typeof object["key"] !== "string") throw new Error("bad read request");

  return Object.freeze({
    key: object["key"],
  });
}

function writeRequest(value: HostBridgeJson | undefined): DesktopSettingsWriteRequest {
  const object = jsonObject(value);
  const key = object?.["key"];
  const settingValue = object?.["value"];

  if (object === undefined || typeof key !== "string" || settingValue === undefined) {
    throw new Error("bad write request");
  }

  return Object.freeze({
    key,
    value: settingValue,
  });
}

function assertHostOk<T>(result: DesktopHostResult<T>): asserts result is { readonly ok: true; readonly value: T } {
  if (!result.ok) assert.fail(result.error.message);
}

function assertHostError<T>(result: DesktopHostResult<T>, code: string): void {
  assert.equal(result.ok, false);
  if (result.ok) assert.fail("expected host error");
  assert.equal(result.error.code, code);
}

function isDesktopSettingsPreview(value: DesktopSettingsPreview): boolean {
  return typeof value.revision === "string" && jsonObject(value.diff as HostBridgeJson) !== undefined;
}

function isDesktopSettingsApply(value: DesktopSettingsApply): boolean {
  return typeof value.revision === "string" && jsonObject(value.applied as HostBridgeJson) !== undefined;
}

function jsonObject(value: HostBridgeJson | undefined): HostBridgeJsonObject | undefined {
  if (value === undefined || value === null || typeof value !== "object" || Array.isArray(value)) return undefined;

  return value as HostBridgeJsonObject;
}
