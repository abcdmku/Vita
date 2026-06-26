import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  createAppRegistryViewModel,
} from "../../../../ui_kits/desktop/viewmodels/app-registry.ts";
import type {
  AppRegistryAppView,
  AppRegistryPorts,
  AppRegistrySnapshot,
} from "../../../../ui_kits/desktop/viewmodels/app-registry.ts";
import {
  SDK_VERSION,
  createAppRegistry,
  defineAppPackage,
  hasAppCapabilityGrant,
  hasDesktopCapabilityGrant,
} from "../../src/desktop-sdk/index.ts";
import type {
  AppPackage,
  DesktopAppLaunch,
  DesktopAppStop,
  DesktopCapability,
  DesktopCapabilityGrant,
  DesktopFirstPartyRegistrySeed,
  DesktopHostResult,
  DesktopLaunchableApp,
  DesktopLauncherIntent,
  DesktopRegistryApp,
  DesktopUiPackageManifest,
} from "../../src/desktop-sdk/index.ts";

test("registry lists first-party and capsule apps by id with declared grants", () => {
  const firstParty = registryApp("vita.app.settings", "tsx", [
    grant("settings.read", "appearance.theme"),
  ]);
  const capsule = registryApp("vita.app.files", "web", [
    grant("files.read", "/home"),
  ]);
  const registry = createAppRegistry({
    firstParty: Object.freeze([firstPartySeed(firstParty)]),
    installedCapsules: Object.freeze([capsule]),
  });
  const listed = registry.list();

  assert.deepEqual(listed.map((descriptor) => descriptor.app.id), [
    "vita.app.files",
    "vita.app.settings",
  ]);
  assert.deepEqual(listed.map((descriptor) => descriptor.requiredGrants), [
    [grant("files.read", "/home")],
    [grant("settings.read", "appearance.theme")],
  ]);
  assert.equal(listed[0]?.title, "Files");
  assert.equal(listed[1]?.title, "Settings");
  assert.equal(Object.isFrozen(listed), true);
  assert.equal(Object.isFrozen(listed[0]), true);
  assert.equal(Object.isFrozen(listed[0]?.app), true);
  assert.equal(Object.isFrozen(listed[0]?.requiredGrants), true);
});

test("validateLaunch authorizes listed apps and fails closed", () => {
  const descriptor = registryApp("vita.app.files", "web");
  const registry = createAppRegistry({
    firstParty: Object.freeze([firstPartySeed(descriptor)]),
  });
  const authorizedManifest = manifest("vita.ui.authorized", [
    grant("apps.launch", "vita.app.files"),
  ]);
  const deniedManifest = manifest("vita.ui.denied", [
    grant("files.read", "/home"),
  ]);

  assert.equal(hasDesktopCapabilityGrant(authorizedManifest, "apps.launch", "vita.app.files"), true);

  const authorized = registry.validateLaunch(authorizedManifest, "vita.app.files");

  assert.equal(authorized.ok, true);
  if (!authorized.ok) assert.fail("expected launch validation to pass");
  assert.equal(authorized.value.app.id, "vita.app.files");

  const unknown = registry.validateLaunch(authorizedManifest, "vita.app.unknown");

  assert.equal(unknown.ok, false);
  if (unknown.ok) assert.fail("expected unknown app rejection");
  assert.equal(unknown.error.code, "UNKNOWN_APP");

  const denied = registry.validateLaunch(deniedManifest, "vita.app.files");

  assert.equal(denied.ok, false);
  if (denied.ok) assert.fail("expected capability denial");
  assert.equal(denied.error.code, "CAP_DENIED");
});

test("seeded descriptors satisfy the DesktopLaunchableApp union shape", () => {
  const registry = createAppRegistry({
    firstParty: Object.freeze([firstPartySeed(registryApp("vita.app.terminal", "tsx"))]),
    installedCapsules: Object.freeze([registryApp("vita.app.browser", "web")]),
  });

  for (const descriptor of registry.list()) {
    assertLaunchableDescriptor(descriptor.app);
  }
});

test("launcher launch intents resolve listed apps only", () => {
  const descriptor = registryApp("vita.app.terminal", "tsx");
  const registry = createAppRegistry({
    firstParty: Object.freeze([firstPartySeed(descriptor)]),
  });

  assert.equal(
    registry.resolveLauncherIntent(launcherIntent("launcher.launch", "vita.app.terminal"))?.app.id,
    "vita.app.terminal",
  );
  assert.equal(registry.resolveLauncherIntent(launcherIntent("launcher.launch", "vita.app.missing")), undefined);
  assert.equal(registry.resolveLauncherIntent({ type: "launcher.launch" }), undefined);
  assert.equal(registry.resolveLauncherIntent({ type: "launcher.open", query: "term" }), undefined);
});

test("first-party SRI failures are dropped fail-closed", () => {
  const valid = registryApp("vita.app.valid", "tsx");
  const malformed = registryApp("vita.app.malformed", "tsx");
  const mismatched = registryApp("vita.app.mismatched", "web");
  const registry = createAppRegistry({
    firstParty: Object.freeze([
      firstPartySeed(valid),
      Object.freeze({
        descriptor: malformed,
        integrity: "sha256-not-base64",
      }),
      Object.freeze({
        descriptor: mismatched,
        integrity: sriForDescriptor(registryApp("vita.app.other", "web")),
      }),
    ]),
  });

  assert.equal(registry.has("vita.app.valid"), true);
  assert.equal(registry.resolve("vita.app.valid")?.app.id, "vita.app.valid");
  assert.equal(registry.has("vita.app.malformed"), false);
  assert.equal(registry.resolve("vita.app.malformed"), undefined);
  assert.equal(registry.has("vita.app.mismatched"), false);
  assert.deepEqual(registry.list().map((descriptor) => descriptor.app.id), ["vita.app.valid"]);
});

test("defineAppPackage accepts and freezes a valid web app package", () => {
  const app = appPackage("vita.app.files", {
    grants: Object.freeze([
      grant("files.read", "/home"),
      grant("settings.read"),
    ]),
    partition: "persist:vita.app.files",
  });

  assert.equal(app.manifest.id, "vita.app.files");
  assert.equal(app.manifest.entry, "apps/vita.app.files/index.html");
  assert.equal(app.descriptor.surfaceKind, "web");
  assert.equal(app.descriptor.runtime.url, app.manifest.entry);
  assert.equal(app.descriptor.runtime.partition, "persist:vita.app.files");
  assert.equal(Object.isFrozen(app), true);
  assert.equal(Object.isFrozen(app.manifest), true);
  assert.equal(Object.isFrozen(app.manifest.capabilityGrants), true);
  assert.equal(Object.isFrozen(app.manifest.capabilityGrants[0]), true);
  assert.equal(Object.isFrozen(app.descriptor), true);
  assert.equal(Object.isFrozen(app.descriptor.runtime), true);
});

test("defineAppPackage fails closed on malformed app manifests and descriptors", () => {
  assertInvalidPackage(rawPackage("vita.app.empty", {
    id: "",
  }), /INVALID_STRING/);

  assertInvalidPackage({
    descriptor: rawDescriptor("vita.app.missing-entry", "apps/vita.app.missing-entry/index.html"),
    manifest: rawManifest("vita.app.missing-entry", {
      omitEntry: true,
    }),
  }, /MISSING_FIELD/);

  assertInvalidPackage(rawPackage("vita.app.unknown-capability", {
    grants: Object.freeze([
      Object.freeze({
        capability: "capsule.execute",
      }),
    ]),
  }), /INVALID_CAPABILITY_GRANT/);

  assertInvalidPackage(rawPackage("vita.app.duplicate-capability", {
    grants: Object.freeze([
      grant("files.read", "/home"),
      grant("files.read", "/home"),
    ]),
  }), /INVALID_CAPABILITY_GRANT/);

  assertInvalidPackage(rawPackage("vita.app.url-mismatch", {
    descriptorEntry: "apps/vita.app.url-mismatch/other.html",
  }), /INVALID_APP_DESCRIPTOR/);
});

test("defineAppPackage rejects hostile and cyclic definitions without invoking accessors", () => {
  let reads = 0;
  const hostileManifest: Record<string, unknown> = {};

  Object.defineProperty(hostileManifest, "id", {
    enumerable: true,
    get() {
      reads += 1;
      return "vita.app.hostile";
    },
  });

  assertInvalidPackage({
    descriptor: rawDescriptor("vita.app.hostile", "apps/vita.app.hostile/index.html"),
    manifest: hostileManifest,
  }, /INVALID_APP_PACKAGE/);
  assert.equal(reads, 0);

  const cyclicManifest = rawManifest("vita.app.cyclic");

  cyclicManifest["self"] = cyclicManifest;
  assertInvalidPackage({
    descriptor: rawDescriptor("vita.app.cyclic", "apps/vita.app.cyclic/index.html"),
    manifest: cyclicManifest,
  }, /INVALID_APP_PACKAGE/);
});

test("hasAppCapabilityGrant mirrors desktop capability resource matching", () => {
  const app = appPackage("vita.app.capabilities", {
    grants: Object.freeze([
      grant("files.read", "/home"),
      grant("settings.read"),
    ]),
  });

  assert.equal(hasAppCapabilityGrant(app.manifest, "files.read", "/home"), true);
  assert.equal(hasAppCapabilityGrant(app.manifest, "files.read", "/tmp"), false);
  assert.equal(hasAppCapabilityGrant(app.manifest, "settings.read", "appearance.theme"), true);
  assert.equal(hasAppCapabilityGrant(app.manifest, "settings.write"), false);
});

test("app registry lists installed apps deterministically and frozen", () => {
  const registry = createAppRegistryViewModel(fakePorts([]), Object.freeze([
    appPackage("vita.app.terminal"),
    appPackage("vita.app.files"),
    appPackage("vita.app.settings"),
  ]));

  const listed = registry.list();
  const snapshot = registry.snapshot();

  assert.equal(listed.ok, true);
  if (!listed.ok) {
    assert.fail("expected app registry list");
  }
  assert.deepEqual(listed.value.map((app) => [
    app.id,
    app.title,
    app.entry,
    app.running,
  ]), [
    ["vita.app.files", "Files", "apps/vita.app.files/index.html", false],
    ["vita.app.settings", "Settings", "apps/vita.app.settings/index.html", false],
    ["vita.app.terminal", "Terminal", "apps/vita.app.terminal/index.html", false],
  ]);
  assert.equal(snapshot.apps, listed.value);
  assert.equal(Object.isFrozen(registry.apps), true);
  assert.equal(Object.isFrozen(listed), true);
  assert.equal(Object.isFrozen(listed.value), true);
  assert.equal(Object.isFrozen(listed.value[0]), true);
  assert.equal(Object.isFrozen(snapshot), true);
});

test("app registry launches and stops installed apps through injected ports", async () => {
  const events: string[] = [];
  const registry = createAppRegistryViewModel(fakePorts(events), Object.freeze([
    appPackage("vita.app.files"),
    appPackage("vita.app.settings"),
  ]));

  const launched = await registry.launch("vita.app.settings");

  assert.equal(launched.ok, true);
  if (!launched.ok) {
    assert.fail("expected app launch");
  }
  assert.equal(launched.value.app.id, "vita.app.settings");
  assert.equal(launched.value.surfaceId, "surface:vita.app.settings");
  assert.equal(Object.isFrozen(launched), true);
  assert.equal(Object.isFrozen(launched.value), true);
  assert.deepEqual(events, [
    "launch:vita.app.settings:apps/vita.app.settings/index.html",
  ]);
  assert.deepEqual(projectView(registry.snapshot(), "vita.app.settings"), {
    running: true,
    surfaceId: "surface:vita.app.settings",
    textureId: "texture:vita.app.settings",
    windowId: "window:vita.app.settings",
  });

  const stopped = await registry.stop("vita.app.settings");

  assert.equal(stopped.ok, true);
  if (!stopped.ok) {
    assert.fail("expected app stop");
  }
  assert.equal(stopped.value.appId, "vita.app.settings");
  assert.equal(Object.isFrozen(stopped), true);
  assert.equal(Object.isFrozen(stopped.value), true);
  assert.deepEqual(events, [
    "launch:vita.app.settings:apps/vita.app.settings/index.html",
    "stop:vita.app.settings",
  ]);
  assert.deepEqual(projectView(registry.snapshot(), "vita.app.settings"), {
    running: false,
    surfaceId: undefined,
    textureId: undefined,
    windowId: undefined,
  });
});

test("app registry fails closed on unknown app, double launch, missing running app, and denying ports", async () => {
  const unknownEvents: string[] = [];
  const unknownRegistry = createAppRegistryViewModel(fakePorts(unknownEvents), Object.freeze([
    appPackage("vita.app.files"),
  ]));
  const beforeUnknown = unknownRegistry.snapshot();
  const unknown = await unknownRegistry.launch("vita.app.missing");

  assert.equal(unknown.ok, false);
  if (unknown.ok) {
    assert.fail("expected unknown app rejection");
  }
  assert.equal(unknown.error.code, "UNKNOWN_APP");
  assert.equal(unknownRegistry.snapshot(), beforeUnknown);
  assert.deepEqual(unknownEvents, []);

  const doubleEvents: string[] = [];
  const doubleRegistry = createAppRegistryViewModel(fakePorts(doubleEvents), Object.freeze([
    appPackage("vita.app.files"),
  ]));
  const firstLaunch = await doubleRegistry.launch("vita.app.files");

  assert.equal(firstLaunch.ok, true);
  const beforeDouble = doubleRegistry.snapshot();
  doubleEvents.length = 0;

  const double = await doubleRegistry.launch("vita.app.files");

  assert.equal(double.ok, false);
  if (double.ok) {
    assert.fail("expected double launch rejection");
  }
  assert.equal(double.error.code, "APP_ALREADY_RUNNING");
  assert.equal(doubleRegistry.snapshot(), beforeDouble);
  assert.deepEqual(doubleEvents, []);

  const stoppedMissing = await doubleRegistry.stop("vita.app.settings");

  assert.equal(stoppedMissing.ok, false);
  if (stoppedMissing.ok) {
    assert.fail("expected not-running rejection");
  }
  assert.equal(stoppedMissing.error.code, "APP_NOT_RUNNING");

  const denyLaunchEvents: string[] = [];
  const denyLaunchRegistry = createAppRegistryViewModel(fakePorts(denyLaunchEvents, {
    denyLaunchIds: new Set(["vita.app.files"]),
  }), Object.freeze([
    appPackage("vita.app.files"),
  ]));
  const beforeDeniedLaunch = denyLaunchRegistry.snapshot();
  const deniedLaunch = await denyLaunchRegistry.launch("vita.app.files");

  assert.equal(deniedLaunch.ok, false);
  if (deniedLaunch.ok) {
    assert.fail("expected launch denial");
  }
  assert.equal(deniedLaunch.error.code, "APP_LAUNCH_DENIED");
  assert.equal(denyLaunchRegistry.snapshot(), beforeDeniedLaunch);
  assert.deepEqual(denyLaunchEvents, [
    "launch:vita.app.files:apps/vita.app.files/index.html",
  ]);

  const denyStopEvents: string[] = [];
  const denyStopRegistry = createAppRegistryViewModel(fakePorts(denyStopEvents, {
    denyStopIds: new Set(["vita.app.files"]),
  }), Object.freeze([
    appPackage("vita.app.files"),
  ]));

  assert.equal((await denyStopRegistry.launch("vita.app.files")).ok, true);
  const beforeDeniedStop = denyStopRegistry.snapshot();
  denyStopEvents.length = 0;

  const deniedStop = await denyStopRegistry.stop("vita.app.files");

  assert.equal(deniedStop.ok, false);
  if (deniedStop.ok) {
    assert.fail("expected stop denial");
  }
  assert.equal(deniedStop.error.code, "APP_STOP_DENIED");
  assert.equal(denyStopRegistry.snapshot(), beforeDeniedStop);
  assert.deepEqual(denyStopEvents, [
    "stop:vita.app.files",
  ]);
});

interface RawPackageOptions {
  readonly id?: string;
  readonly entry?: string;
  readonly descriptorEntry?: string;
  readonly grants?: readonly unknown[];
  readonly omitEntry?: boolean;
  readonly partition?: string;
}

interface FakePortOptions {
  readonly denyLaunchIds?: ReadonlySet<string>;
  readonly denyStopIds?: ReadonlySet<string>;
}

interface ProjectedAppView {
  readonly running: boolean;
  readonly surfaceId: string | undefined;
  readonly textureId: string | undefined;
  readonly windowId: string | undefined;
}

function registryApp(
  id: string,
  surfaceKind: "tsx" | "web",
  requiredGrants: readonly DesktopCapabilityGrant[] = Object.freeze([]),
): DesktopRegistryApp {
  const title = titleFromId(id);

  return Object.freeze({
    app: surfaceKind === "tsx" ? tsxApp(id, title) : webApp(id, title),
    title,
    requiredGrants: Object.freeze([...requiredGrants]),
  });
}

function tsxApp(id: string, title: string): DesktopLaunchableApp {
  return Object.freeze({
    id,
    runtime: Object.freeze({
      componentId: id,
    }),
    surfaceKind: "tsx",
    title,
  });
}

function webApp(id: string, title: string): DesktopLaunchableApp {
  return Object.freeze({
    defaultWindow: Object.freeze({
      mode: "floating",
      rect: Object.freeze({
        height: 480,
        width: 720,
        x: 64,
        y: 72,
      }),
    }),
    id,
    runtime: Object.freeze({
      partition: `persist:${id}`,
      url: `apps/${id}/index.html`,
    }),
    surfaceKind: "web",
    title,
  });
}

function firstPartySeed(descriptor: DesktopRegistryApp): DesktopFirstPartyRegistrySeed {
  return Object.freeze({
    descriptor,
    integrity: sriForDescriptor(descriptor),
  });
}

function sriForDescriptor(descriptor: DesktopRegistryApp): string {
  return `sha256-${createHash("sha256")
    .update(JSON.stringify(descriptor), "utf8")
    .digest("base64")}`;
}

function manifest(
  id: string,
  capabilityGrants: readonly DesktopCapabilityGrant[],
): DesktopUiPackageManifest {
  return Object.freeze({
    capabilityGrants,
    entry: "index.ts",
    id,
    sdkVersion: "0.0.0",
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

function launcherIntent(
  type: DesktopLauncherIntent["type"],
  appId: string,
): DesktopLauncherIntent {
  return Object.freeze({
    appId,
    type,
  });
}

function assertLaunchableDescriptor(app: DesktopLaunchableApp): void {
  assert.equal(app.surfaceKind === "tsx" || app.surfaceKind === "web", true);

  if (app.surfaceKind === "tsx") {
    assert.equal(typeof app.runtime.componentId, "string");
    assert.equal(app.runtime.componentId.length > 0, true);
    return;
  }

  assert.equal(typeof app.runtime.url, "string");
  assert.equal(app.runtime.url.length > 0, true);
}

function titleFromId(id: string): string {
  const lastSegment = id.split(".").at(-1) ?? id;

  return lastSegment.slice(0, 1).toLocaleUpperCase("en-US") + lastSegment.slice(1);
}

function appPackage(id: string, options: RawPackageOptions = Object.freeze({})): AppPackage {
  return defineAppPackage(rawPackage(id, options));
}

function rawPackage(id: string, options: RawPackageOptions = Object.freeze({})): Record<string, unknown> {
  const manifestValue = rawManifest(id, options);
  const manifestEntry = typeof manifestValue["entry"] === "string"
    ? manifestValue["entry"]
    : `apps/${id}/index.html`;

  return {
    descriptor: rawDescriptor(options.id ?? id, options.descriptorEntry ?? manifestEntry, options.partition),
    manifest: manifestValue,
  };
}

function rawManifest(id: string, options: RawPackageOptions = Object.freeze({})): Record<string, unknown> {
  const output: Record<string, unknown> = {
    capabilityGrants: options.grants ?? Object.freeze([]),
    id: options.id ?? id,
    sdkVersion: SDK_VERSION,
    version: "1.0.0",
  };

  if (options.omitEntry !== true) {
    output["entry"] = options.entry ?? `apps/${id}/index.html`;
  }

  return output;
}

function rawDescriptor(
  id: string,
  entry: string,
  partition?: string,
): Record<string, unknown> {
  const runtime: Record<string, unknown> = {
    url: entry,
  };

  if (partition !== undefined) runtime["partition"] = partition;

  return {
    id,
    runtime,
    surfaceKind: "web",
    title: titleFromId(id),
  };
}

function assertInvalidPackage(input: unknown, expected: RegExp): void {
  assert.throws(() => {
    defineAppPackage(input);
  }, expected);
}

function projectView(
  snapshot: AppRegistrySnapshot,
  appId: string,
): ProjectedAppView {
  const view = findView(snapshot, appId);

  return {
    running: view.running,
    surfaceId: view.surfaceId,
    textureId: view.textureId,
    windowId: view.windowId,
  };
}

function findView(snapshot: AppRegistrySnapshot, appId: string): AppRegistryAppView {
  for (let index = 0; index < snapshot.apps.length; index += 1) {
    const view = snapshot.apps[index];

    if (view !== undefined && view.id === appId) return view;
  }

  assert.fail(`missing app view ${appId}`);
}

function fakePorts(
  events: string[],
  options: FakePortOptions = Object.freeze({}),
): AppRegistryPorts {
  return Object.freeze({
    launchApp(app: DesktopLaunchableApp): DesktopHostResult<DesktopAppLaunch> {
      const entry = app.surfaceKind === "web" ? app.runtime.url : app.id;

      events.push(`launch:${app.id}:${entry}`);
      if (options.denyLaunchIds?.has(app.id) === true) {
        return hostReject("APP_LAUNCH_DENIED", "launch denied by fake host.", `/apps/${app.id}`);
      }

      return hostAccept(Object.freeze({
        app,
        intents: Object.freeze([]),
        surfaceId: `surface:${app.id}`,
        textureId: `texture:${app.id}`,
        windowId: `window:${app.id}`,
      }));
    },
    stopApp(appId: string): DesktopHostResult<DesktopAppStop> {
      events.push(`stop:${appId}`);
      if (options.denyStopIds?.has(appId) === true) {
        return hostReject("APP_STOP_DENIED", "stop denied by fake host.", `/apps/${appId}`);
      }

      return hostAccept(Object.freeze({
        appId,
        intents: Object.freeze([]),
        surfaceId: `surface:${appId}`,
        textureId: `texture:${appId}`,
        windowId: `window:${appId}`,
      }));
    },
  });
}

function hostAccept<T>(value: T): DesktopHostResult<T> {
  return {
    ok: true,
    value,
  };
}

function hostReject<T>(code: string, message: string, path: string): DesktopHostResult<T> {
  return {
    error: {
      code,
      message,
      path,
    },
    ok: false,
  };
}
