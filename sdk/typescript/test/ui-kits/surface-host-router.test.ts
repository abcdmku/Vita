import assert from "node:assert/strict";
import { test } from "node:test";

import {
  createSurfaceHost,
} from "../../../../ui_kits/desktop/runtime/host-bridge.ts";
import type {
  HostBridgeJson,
  HostBridgeJsonObject,
  SurfaceHostMethod,
  SurfaceHostRequest,
} from "../../../../ui_kits/desktop/runtime/host-bridge.ts";
import {
  createInMemorySurfaceBackend,
  createSurfaceHostRouter,
} from "../../src/desktop-sdk/index.ts";
import type {
  DesktopLaunchableApp,
  SurfaceHostBackend,
} from "../../src/desktop-sdk/index.ts";

test("surface host router routes every method to its backend port", async () => {
  const calls: SurfaceHostMethod[] = [];
  const backend = recordingBackend(calls);
  const router = createSurfaceHostRouter(backend);
  const cases = methodCases();

  for (let index = 0; index < cases.length; index += 1) {
    const current = cases[index];

    assert.notEqual(current, undefined);
    if (current === undefined) continue;

    const response = await router(request(current.method, current.args));

    current.assertResponse(response);
  }

  assert.deepEqual(calls, cases.map((current) => current.method));
});

test("surface host router fails closed for unknown method, wrong arity, and non-JSON args", async () => {
  const router = createSurfaceHostRouter(createInMemorySurfaceBackend());
  const cyclic: { self?: unknown } = {};
  const accessorRequest: {
    method?: unknown;
    args?: unknown;
  } = {};

  cyclic.self = cyclic;
  Object.defineProperty(accessorRequest, "method", {
    enumerable: true,
    get() {
      throw new Error("must not read accessor");
    },
  });
  Object.defineProperty(accessorRequest, "args", {
    enumerable: true,
    value: [],
  });

  const unknown = await router({
    args: [],
    method: "missingMethod",
  });
  const badArity = await router({
    args: [],
    method: "launchApp",
  });
  const nonJson = await router({
    args: [cyclic],
    method: "launchApp",
  });
  const accessor = await router(accessorRequest);

  assertHostFailure(unknown, "HOST_ROUTER_UNKNOWN_METHOD");
  assertHostFailure(badArity, "HOST_ROUTER_BAD_ARITY");
  assertHostFailure(nonJson, "HOST_ROUTER_NON_JSON");
  assertHostFailure(accessor, "HOST_ROUTER_NON_JSON");
});

test("surface host router round-trips through createSurfaceHost", async () => {
  const router = createSurfaceHostRouter(createInMemorySurfaceBackend());
  const host = createSurfaceHost((hostRequest) => router(hostRequest));
  const app = launchableApp("vita.app.files");

  const launched = await host.launchApp(app);

  if (!launched.ok) assert.fail(launched.error.message);
  assert.equal(launched.value.app.id, app.id);
  assert.equal(launched.value.surfaceId, "surface:vita.app.files");
  assert.equal(launched.value.windowId, "window:vita.app.files");
  assert.equal(launched.value.textureId, "texture:vita.app.files");

  const requestFile = host.requestFile;

  assert.notEqual(requestFile, undefined);
  if (requestFile === undefined) assert.fail("requestFile bridge port should be present");

  const file = await requestFile(Object.freeze({
    grant: "workspace",
    op: "read",
    path: "/workspace/README.md",
  }));

  assert.deepEqual(file, {
    data: "Vita in-memory file backend\n",
    kind: "file",
    mtime: "2026-06-25T00:00:00.000Z",
    size: 28,
  });

  assert.deepEqual(host.readTheme(), {
    id: "vita.in-memory.theme",
    tokens: {
      colors: {
        accent: "#3178c6",
        background: "#ffffff",
        foreground: "#101418",
      },
      radii: {
        md: 8,
        sm: 4,
      },
      spacing: {
        md: 16,
        sm: 8,
      },
      typography: {
        body: "system-ui",
        mono: "ui-monospace",
      },
    },
    version: "1.0.0",
  });
});

interface MethodCase {
  readonly method: SurfaceHostMethod;
  readonly args: readonly HostBridgeJson[];
  assertResponse(response: HostBridgeJson): void;
}

function methodCases(): readonly MethodCase[] {
  return Object.freeze([
    {
      args: [componentDefinition()],
      assertResponse(response) {
        assertHostSuccess(response, isRegisteredShellComponentWire);
      },
      method: "registerComponent",
    },
    {
      args: [shellConfigDefinition("preview")],
      assertResponse(response) {
        assert.equal(isShellPreviewResult(response), true);
      },
      method: "previewShell",
    },
    {
      args: [shellConfigDefinition("apply")],
      assertResponse(response) {
        assert.equal(isShellApplyResult(response), true);
      },
      method: "applyShell",
    },
    {
      args: [],
      assertResponse(response) {
        assert.equal(isShellRollbackResult(response), true);
      },
      method: "rollbackShell",
    },
    {
      args: [],
      assertResponse(response) {
        assert.equal(isShellManagedSnapshot(response), true);
      },
      method: "currentShell",
    },
    {
      args: [launchableApp("vita.app.direct") as unknown as HostBridgeJson],
      assertResponse(response) {
        assertHostSuccess(response, isDesktopAppLaunch);
      },
      method: "launchApp",
    },
    {
      args: ["vita.app.direct"],
      assertResponse(response) {
        assertHostSuccess(response, isDesktopAppStop);
      },
      method: "stopApp",
    },
    {
      args: [notificationInput()],
      assertResponse(response) {
        assertHostSuccess(response, isShellNotification);
      },
      method: "postNotification",
    },
    {
      args: [trayInput()],
      assertResponse(response) {
        assertHostSuccess(response, isTrayItem);
      },
      method: "registerTrayItem",
    },
    {
      args: [Object.freeze({
        grant: "workspace",
        op: "list",
        path: "/workspace",
      })],
      assertResponse(response) {
        assert.equal(isFilesResponse(response), true);
      },
      method: "requestFile",
    },
    {
      args: [Object.freeze({
        key: "appearance.theme",
      })],
      assertResponse(response) {
        assertHostSuccess(response, isJson);
      },
      method: "readSetting",
    },
    {
      args: [Object.freeze({
        key: "appearance.theme",
        value: "dark",
      })],
      assertResponse(response) {
        assertHostSuccess(response, isDesktopSettingsPreview);
      },
      method: "previewSetting",
    },
    {
      args: [Object.freeze({
        key: "appearance.theme",
        value: "dark",
      })],
      assertResponse(response) {
        assertHostSuccess(response, isDesktopSettingsApply);
      },
      method: "applySetting",
    },
    {
      args: [Object.freeze({
        appId: "vita.app.files",
        type: "launcher.launch",
      })],
      assertResponse(response) {
        assertHostSuccess(response, isTrue);
      },
      method: "emitLauncherIntent",
    },
    {
      args: [],
      assertResponse(response) {
        assert.equal(isDesktopTheme(response), true);
      },
      method: "readTheme",
    },
  ]);
}

function recordingBackend(calls: SurfaceHostMethod[]): SurfaceHostBackend {
  const backend = createInMemorySurfaceBackend();

  return Object.freeze({
    applySetting(request) {
      calls.push("applySetting");
      return backend.applySetting(request);
    },
    applyShell(definition) {
      calls.push("applyShell");
      return backend.applyShell(definition);
    },
    currentShell() {
      calls.push("currentShell");
      return backend.currentShell();
    },
    emitLauncherIntent(intent) {
      calls.push("emitLauncherIntent");
      return backend.emitLauncherIntent(intent);
    },
    launchApp(app) {
      calls.push("launchApp");
      return backend.launchApp(app);
    },
    package: backend.package,
    postNotification(input) {
      calls.push("postNotification");
      return backend.postNotification(input);
    },
    previewSetting(request) {
      calls.push("previewSetting");
      return backend.previewSetting(request);
    },
    previewShell(definition) {
      calls.push("previewShell");
      return backend.previewShell(definition);
    },
    readSetting(request) {
      calls.push("readSetting");
      return backend.readSetting(request);
    },
    readTheme() {
      calls.push("readTheme");
      return backend.readTheme();
    },
    registerComponent(definition) {
      calls.push("registerComponent");
      return backend.registerComponent(definition);
    },
    registerTrayItem(input) {
      calls.push("registerTrayItem");
      return backend.registerTrayItem(input);
    },
    requestFile(fileRequest) {
      calls.push("requestFile");
      return backend.requestFile(fileRequest);
    },
    rollbackShell() {
      calls.push("rollbackShell");
      return backend.rollbackShell();
    },
    stopApp(appId) {
      calls.push("stopApp");
      return backend.stopApp(appId);
    },
  }) satisfies SurfaceHostBackend;
}

function request(method: SurfaceHostMethod, args: readonly HostBridgeJson[]): SurfaceHostRequest {
  return Object.freeze({
    args: Object.freeze([...args]),
    method,
  });
}

function componentDefinition(): HostBridgeJson {
  return Object.freeze({
    defaultPlacement: Object.freeze({
      layer: "desktop",
      order: 2,
      zone: "root",
    }),
    id: "vita.test.component",
    role: "desktop",
  });
}

function shellConfigDefinition(id: string): HostBridgeJson {
  return Object.freeze({
    id: `vita.test.shell.${id}`,
    revision: `rev:${id}`,
  });
}

function launchableApp(id: string): DesktopLaunchableApp {
  return Object.freeze({
    id,
    runtime: Object.freeze({
      componentId: id,
      props: Object.freeze({
        source: "surface-host-router.test",
      }),
    }),
    surfaceKind: "tsx",
    title: id,
  });
}

function notificationInput(): HostBridgeJson {
  return Object.freeze({
    actions: Object.freeze([
      Object.freeze({
        id: "open",
        label: "Open",
        style: "primary",
      }),
    ]),
    body: "Body",
    id: "notification:direct",
    priority: "high",
    title: "Notification",
  });
}

function trayInput(): HostBridgeJson {
  return Object.freeze({
    iconRef: "memory://tray",
    id: "tray:direct",
    menu: Object.freeze([
      Object.freeze({
        enabled: true,
        id: "open",
        items: Object.freeze([]),
        label: "Open",
      }),
    ]),
    order: 1,
    status: "ok",
    tooltip: "Tray item",
  });
}

function assertHostSuccess(
  response: HostBridgeJson,
  valueGuard: (value: HostBridgeJson | undefined) => boolean,
): void {
  const result = jsonObject(response);

  assert.notEqual(result, undefined);
  assert.equal(result?.["ok"], true);
  assert.equal(valueGuard(result?.["value"]), true);
}

function assertHostFailure(response: HostBridgeJson, code: string): void {
  const result = jsonObject(response);
  const error = jsonObject(result?.["error"]);

  assert.equal(result?.["ok"], false);
  assert.equal(isHostError(result?.["error"]), true);
  assert.equal(error?.["code"], code);
}

function isDesktopAppLaunch(value: HostBridgeJson | undefined): boolean {
  const launch = jsonObject(value);

  return launch !== undefined &&
    isLaunchableApp(launch["app"]) &&
    typeof launch["surfaceId"] === "string" &&
    typeof launch["windowId"] === "string" &&
    typeof launch["textureId"] === "string" &&
    isWindowManagerIntentArray(launch["intents"]);
}

function isDesktopAppStop(value: HostBridgeJson | undefined): boolean {
  const stop = jsonObject(value);

  return stop !== undefined &&
    typeof stop["appId"] === "string" &&
    optionalString(stop["surfaceId"]) &&
    optionalString(stop["windowId"]) &&
    optionalString(stop["textureId"]) &&
    isWindowManagerIntentArray(stop["intents"]);
}

function isLaunchableApp(value: HostBridgeJson | undefined): boolean {
  const app = jsonObject(value);
  const runtime = jsonObject(app?.["runtime"]);

  return app !== undefined &&
    typeof app["id"] === "string" &&
    typeof app["title"] === "string" &&
    app["surfaceKind"] === "tsx" &&
    runtime !== undefined &&
    typeof runtime["componentId"] === "string";
}

function isFilesResponse(value: HostBridgeJson | undefined): boolean {
  const response = jsonObject(value);

  if (response === undefined) return false;
  if (response["error"] !== undefined) {
    const error = jsonObject(response["error"]);

    return error !== undefined &&
      typeof error["code"] === "string" &&
      typeof error["message"] === "string";
  }

  return (
    (response["entries"] === undefined || isFilesEntryArray(response["entries"])) &&
    optionalString(response["data"]) &&
    (response["kind"] === undefined || response["kind"] === "file" || response["kind"] === "dir" || response["kind"] === "symlink-skipped") &&
    (response["size"] === undefined || isFiniteNumber(response["size"])) &&
    optionalString(response["mtime"])
  );
}

function isFilesEntryArray(value: HostBridgeJson | undefined): boolean {
  if (!Array.isArray(value)) return false;

  for (let index = 0; index < value.length; index += 1) {
    const entry = jsonObject(value[index]);

    if (
      entry === undefined ||
      typeof entry["name"] !== "string" ||
      !(entry["kind"] === "file" || entry["kind"] === "dir" || entry["kind"] === "symlink-skipped") ||
      !isFiniteNumber(entry["size"]) ||
      typeof entry["mtime"] !== "string"
    ) {
      return false;
    }
  }

  return true;
}

function isShellNotification(value: HostBridgeJson | undefined): boolean {
  const notification = jsonObject(value);

  return notification !== undefined &&
    typeof notification["appId"] === "string" &&
    typeof notification["id"] === "string" &&
    typeof notification["title"] === "string" &&
    isNotificationPriority(notification["priority"]) &&
    isFiniteNumber(notification["createdAtMs"]) &&
    isNotificationActionArray(notification["actions"]) &&
    optionalString(notification["body"]) &&
    (notification["expiresAtMs"] === undefined || isFiniteNumber(notification["expiresAtMs"]));
}

function isNotificationActionArray(value: HostBridgeJson | undefined): boolean {
  if (!Array.isArray(value)) return false;

  for (let index = 0; index < value.length; index += 1) {
    const action = jsonObject(value[index]);

    if (
      action === undefined ||
      typeof action["id"] !== "string" ||
      typeof action["label"] !== "string" ||
      !isActionStyle(action["style"])
    ) {
      return false;
    }
  }

  return true;
}

function isTrayItem(value: HostBridgeJson | undefined): boolean {
  const item = jsonObject(value);

  return item !== undefined &&
    typeof item["appId"] === "string" &&
    typeof item["id"] === "string" &&
    typeof item["iconRef"] === "string" &&
    typeof item["tooltip"] === "string" &&
    isFiniteNumber(item["order"]) &&
    isTrayMenuItemArray(item["menu"]) &&
    (item["status"] === undefined || item["status"] === "ok" || item["status"] === "warning" || item["status"] === "critical" || item["status"] === "offline");
}

function isTrayMenuItemArray(value: HostBridgeJson | undefined): boolean {
  if (!Array.isArray(value)) return false;

  for (let index = 0; index < value.length; index += 1) {
    const item = jsonObject(value[index]);

    if (
      item === undefined ||
      typeof item["id"] !== "string" ||
      typeof item["label"] !== "string" ||
      typeof item["enabled"] !== "boolean" ||
      !isTrayMenuItemArray(item["items"]) ||
      (item["checked"] !== undefined && typeof item["checked"] !== "boolean")
    ) {
      return false;
    }
  }

  return true;
}

function isRegisteredShellComponentWire(value: HostBridgeJson | undefined): boolean {
  const component = jsonObject(value);

  return component !== undefined &&
    typeof component["id"] === "string" &&
    typeof component["role"] === "string" &&
    isPlacement(component["defaultPlacement"]);
}

function isShellPreviewResult(value: HostBridgeJson | undefined): boolean {
  const result = jsonObject(value);

  if (result === undefined) return false;
  if (result["ok"] === true) {
    return isShellLayout(result["layout"]) && isShellDiff(result["diff"]);
  }

  return result["ok"] === false &&
    isHostError(result["error"]) &&
    isShellLayout(result["fallbackLayout"]) &&
    isShellDiff(result["diff"]);
}

function isShellApplyResult(value: HostBridgeJson | undefined): boolean {
  const result = jsonObject(value);

  if (result === undefined) return false;
  if (result["ok"] === true) {
    return result["outcome"] === "committed" &&
      isShellLayout(result["layout"]) &&
      isShellDiff(result["diff"]);
  }

  return result["ok"] === false &&
    (result["outcome"] === "fallback" || result["outcome"] === "failsafe") &&
    isHostError(result["error"]) &&
    isShellLayout(result["layout"]) &&
    isShellLayout(result["fallbackLayout"]);
}

function isShellRollbackResult(value: HostBridgeJson | undefined): boolean {
  const result = jsonObject(value);

  if (result === undefined) return false;
  if (result["ok"] === true) {
    return (result["outcome"] === "rolledBack" || result["outcome"] === "fallback") &&
      isShellLayout(result["layout"]);
  }

  return result["ok"] === false &&
    (result["outcome"] === "fallback" || result["outcome"] === "failsafe") &&
    isHostError(result["error"]) &&
    isShellLayout(result["layout"]);
}

function isShellManagedSnapshot(value: HostBridgeJson | undefined): boolean {
  const snapshot = jsonObject(value);

  return snapshot !== undefined &&
    (snapshot["source"] === "configured" || snapshot["source"] === "fallback") &&
    isShellLayout(snapshot["layout"]) &&
    (snapshot["error"] === undefined || isHostError(snapshot["error"]));
}

function isShellLayout(value: HostBridgeJson | undefined): boolean {
  const layout = jsonObject(value);

  return layout !== undefined &&
    typeof layout["configId"] === "string" &&
    typeof layout["revision"] === "string" &&
    isShellStyleSheet(layout["css"]) &&
    isShellResolvedSurface(layout["root"]) &&
    isShellSurfaceArray(layout["surfaces"]);
}

function isShellStyleSheet(value: HostBridgeJson | undefined): boolean {
  const styleSheet = jsonObject(value);

  return styleSheet !== undefined &&
    typeof styleSheet["text"] === "string" &&
    Array.isArray(styleSheet["rules"]);
}

function isShellResolvedSurface(value: HostBridgeJson | undefined): boolean {
  const surface = jsonObject(value);

  return surface !== undefined &&
    typeof surface["id"] === "string" &&
    typeof surface["componentId"] === "string" &&
    typeof surface["role"] === "string" &&
    typeof surface["path"] === "string" &&
    isPlacement(surface["placement"]) &&
    jsonObject(surface["payload"]) !== undefined &&
    jsonObject(surface["substrate"]) !== undefined &&
    isShellSurfaceArray(surface["children"]);
}

function isShellSurfaceArray(value: HostBridgeJson | undefined): boolean {
  if (!Array.isArray(value)) return false;

  for (let index = 0; index < value.length; index += 1) {
    if (!isShellResolvedSurface(value[index])) return false;
  }

  return true;
}

function isShellDiff(value: HostBridgeJson | undefined): boolean {
  const diff = jsonObject(value);

  return diff !== undefined &&
    isStringArray(diff["added"]) &&
    isStringArray(diff["removed"]) &&
    isStringArray(diff["changed"]);
}

function isDesktopSettingsPreview(value: HostBridgeJson | undefined): boolean {
  const preview = jsonObject(value);

  return preview !== undefined &&
    typeof preview["revision"] === "string" &&
    jsonObject(preview["diff"]) !== undefined;
}

function isDesktopSettingsApply(value: HostBridgeJson | undefined): boolean {
  const apply = jsonObject(value);

  return apply !== undefined &&
    typeof apply["revision"] === "string" &&
    jsonObject(apply["applied"]) !== undefined;
}

function isDesktopTheme(value: HostBridgeJson | undefined): boolean {
  const theme = jsonObject(value);
  const tokens = jsonObject(theme?.["tokens"]);

  return theme !== undefined &&
    typeof theme["id"] === "string" &&
    typeof theme["version"] === "string" &&
    tokens !== undefined &&
    isStringRecord(tokens["colors"]) &&
    isNumberRecord(tokens["spacing"]) &&
    isNumberRecord(tokens["radii"]) &&
    isStringOrNumberRecord(tokens["typography"]);
}

function isHostError(value: HostBridgeJson | undefined): boolean {
  const error = jsonObject(value);

  return error !== undefined &&
    typeof error["code"] === "string" &&
    typeof error["message"] === "string" &&
    typeof error["path"] === "string";
}

function isPlacement(value: HostBridgeJson | undefined): boolean {
  const placement = jsonObject(value);

  return placement !== undefined &&
    typeof placement["zone"] === "string" &&
    typeof placement["layer"] === "string" &&
    isFiniteNumber(placement["order"]);
}

function isWindowManagerIntentArray(value: HostBridgeJson | undefined): boolean {
  if (!Array.isArray(value)) return false;

  for (let index = 0; index < value.length; index += 1) {
    const intent = jsonObject(value[index]);

    if (intent === undefined || typeof intent["type"] !== "string") return false;
  }

  return true;
}

function isStringArray(value: HostBridgeJson | undefined): boolean {
  if (!Array.isArray(value)) return false;

  for (let index = 0; index < value.length; index += 1) {
    if (typeof value[index] !== "string") return false;
  }

  return true;
}

function isStringRecord(value: HostBridgeJson | undefined): boolean {
  return recordValues(value, (item) => typeof item === "string");
}

function isNumberRecord(value: HostBridgeJson | undefined): boolean {
  return recordValues(value, isFiniteNumber);
}

function isStringOrNumberRecord(value: HostBridgeJson | undefined): boolean {
  return recordValues(value, (item) => typeof item === "string" || isFiniteNumber(item));
}

function recordValues(value: HostBridgeJson | undefined, guard: (value: HostBridgeJson | undefined) => boolean): boolean {
  const record = jsonObject(value);

  if (record === undefined) return false;

  const keys = Object.keys(record);

  for (let index = 0; index < keys.length; index += 1) {
    const key = keys[index];

    if (key === undefined || !guard(record[key])) return false;
  }

  return true;
}

function isNotificationPriority(value: HostBridgeJson | undefined): boolean {
  return value === "low" || value === "normal" || value === "high" || value === "urgent" || value === "critical";
}

function isActionStyle(value: HostBridgeJson | undefined): boolean {
  return value === "default" || value === "primary" || value === "destructive";
}

function isTrue(value: HostBridgeJson | undefined): boolean {
  return value === true;
}

function isJson(value: HostBridgeJson | undefined): boolean {
  return value !== undefined;
}

function jsonObject(value: HostBridgeJson | undefined): HostBridgeJsonObject | undefined {
  if (value === undefined || value === null || typeof value !== "object" || Array.isArray(value)) return undefined;

  return value as HostBridgeJsonObject;
}

function optionalString(value: HostBridgeJson | undefined): boolean {
  return value === undefined || typeof value === "string";
}

function isFiniteNumber(value: HostBridgeJson | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value);
}
