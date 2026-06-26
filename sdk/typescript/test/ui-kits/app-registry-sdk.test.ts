import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  createAppRegistry,
  hasDesktopCapabilityGrant,
} from "../../src/desktop-sdk/index.ts";
import type {
  DesktopCapability,
  DesktopCapabilityGrant,
  DesktopFirstPartyRegistrySeed,
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
