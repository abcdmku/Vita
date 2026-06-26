import assert from "node:assert/strict";
import { test } from "node:test";

import {
  createDesktopHostForPackage,
  hasDesktopCapabilityGrant,
} from "../../src/desktop-sdk/index.ts";
import type {
  DesktopAppLaunch,
  DesktopCapability,
  DesktopCapabilityGrant,
  DesktopHost,
  DesktopHostResult,
  DesktopLaunchableApp,
  DesktopSettingsApply,
  DesktopSettingsWriteRequest,
  DesktopTheme,
  DesktopUiPackageManifest,
} from "../../src/desktop-sdk/index.ts";

const CAP_DENIED = "CAP_DENIED";

interface HostSpies {
  readonly host: DesktopHost;
  readonly applySettingRequests: DesktopSettingsWriteRequest[];
  readonly launchAppRequests: DesktopLaunchableApp[];
}

test("denied capability calls fail closed before touching the backend", async () => {
  const spies = hostSpies();
  const scoped = createDesktopHostForPackage(spies.host, manifest("ui.denied", []));

  const settingsDenied = await callApplySetting(scoped, settingsWriteRequest());
  const launchDenied = await scoped.launchApp(launchableApp("vita.app.denied"));

  assertCapDenied(settingsDenied);
  assertCapDenied(launchDenied);
  assert.equal(spies.applySettingRequests.length, 0);
  assert.equal(spies.launchAppRequests.length, 0);
});

test("granted capability calls reach the backend with the normalized request", async () => {
  const spies = hostSpies();
  const scoped = createDesktopHostForPackage(spies.host, manifest("ui.settings", [
    Object.freeze({
      capability: "settings.write",
      resourceId: "appearance.theme",
    }),
  ]));
  const request = settingsWriteRequest();

  const applied = await callApplySetting(scoped, request);

  assert.equal(applied.ok, true);
  if (!applied.ok) assert.fail("expected settings apply to reach backend");
  assert.deepEqual(applied.value, {
    applied: {
      key: "appearance.theme",
      value: "dark",
    },
    revision: "apply:appearance.theme",
  });
  assert.equal(spies.applySettingRequests.length, 1);

  const forwarded = spies.applySettingRequests[0];

  assert.notEqual(forwarded, undefined);
  if (forwarded === undefined) assert.fail("expected backend request");
  assert.notEqual(forwarded, request);
  assert.deepEqual(forwarded, request);
});

test("grant decisions use the mount-time snapshot, not later manifest mutations", async () => {
  const spies = hostSpies();
  const grants: DesktopCapabilityGrant[] = [];
  const mutableManifest = manifest("ui.toctou", grants);
  const scoped = createDesktopHostForPackage(spies.host, mutableManifest);

  grants.push(Object.freeze({
    capability: "settings.write",
    resourceId: "appearance.theme",
  }));

  assert.equal(hasDesktopCapabilityGrant(mutableManifest, "settings.write", "appearance.theme"), true);
  assert.equal(hasDesktopCapabilityGrant(scoped.package, "settings.write", "appearance.theme"), false);

  const denied = await callApplySetting(scoped, settingsWriteRequest());

  assertCapDenied(denied);
  assert.equal(spies.applySettingRequests.length, 0);
});

test("unknown capability grants do not satisfy routed host capabilities", async () => {
  const spies = hostSpies();
  const scoped = createDesktopHostForPackage(spies.host, manifest("ui.unknown-capability", [
    Object.freeze({
      capability: "settings.write.reserved" as DesktopCapability,
    }),
  ]));

  assert.equal(hasDesktopCapabilityGrant(scoped.package, "settings.write", "appearance.theme"), false);

  const denied = await callApplySetting(scoped, settingsWriteRequest());

  assertCapDenied(denied);
  assert.equal(spies.applySettingRequests.length, 0);
});

async function callApplySetting(
  host: DesktopHost,
  request: DesktopSettingsWriteRequest,
): Promise<DesktopHostResult<DesktopSettingsApply>> {
  const applySetting = host.applySetting;

  if (applySetting === undefined) assert.fail("expected applySetting port");

  return await applySetting(request);
}

function hostSpies(): HostSpies {
  const applySettingRequests: DesktopSettingsWriteRequest[] = [];
  const launchAppRequests: DesktopLaunchableApp[] = [];
  const host: DesktopHost = Object.freeze({
    applySetting(request: DesktopSettingsWriteRequest) {
      applySettingRequests.push(request);

      return hostAccept(Object.freeze({
        applied: Object.freeze({
          key: request.key,
          value: request.value,
        }),
        revision: `apply:${request.key}`,
      }));
    },
    applyShell(): never {
      throw new Error("applyShell backend should not be used by this test");
    },
    launchApp(app: DesktopLaunchableApp) {
      launchAppRequests.push(app);

      return hostAccept(launchResult(app));
    },
    package: manifest("host", []),
    postNotification(): never {
      throw new Error("postNotification backend should not be used by this test");
    },
    previewShell(): never {
      throw new Error("previewShell backend should not be used by this test");
    },
    readTheme() {
      return desktopTheme();
    },
    registerComponent(): never {
      throw new Error("registerComponent backend should not be used by this test");
    },
    registerTrayItem(): never {
      throw new Error("registerTrayItem backend should not be used by this test");
    },
    rollbackShell(): never {
      throw new Error("rollbackShell backend should not be used by this test");
    },
    stopApp(): never {
      throw new Error("stopApp backend should not be used by this test");
    },
  });

  return {
    applySettingRequests,
    host,
    launchAppRequests,
  };
}

function manifest(id: string, capabilityGrants: readonly DesktopCapabilityGrant[]): DesktopUiPackageManifest {
  return {
    capabilityGrants,
    entry: "index.html",
    id,
    sdkVersion: "0.0.0",
    version: "1.0.0",
  };
}

function settingsWriteRequest(): DesktopSettingsWriteRequest {
  return {
    key: "appearance.theme",
    value: "dark",
  };
}

function launchableApp(id: string): DesktopLaunchableApp {
  return Object.freeze({
    id,
    runtime: Object.freeze({
      componentId: id,
      props: Object.freeze({
        source: "capability-enforcement-gate.test",
      }),
    }),
    surfaceKind: "tsx",
    title: id,
  });
}

function launchResult(app: DesktopLaunchableApp): DesktopAppLaunch {
  return Object.freeze({
    app,
    intents: Object.freeze([]),
    surfaceId: `surface:${app.id}`,
    textureId: `texture:${app.id}`,
    windowId: `window:${app.id}`,
  });
}

function desktopTheme(): DesktopTheme {
  return Object.freeze({
    id: "vita.test.theme",
    tokens: Object.freeze({
      colors: Object.freeze({
        background: "#101418",
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

function hostAccept<T>(value: T): DesktopHostResult<T> {
  return {
    ok: true,
    value,
  };
}

function assertCapDenied<T>(result: DesktopHostResult<T>): void {
  assert.equal(result.ok, false);
  if (result.ok) assert.fail("expected host call to fail closed");
  assert.equal(result.error.code, CAP_DENIED);
  assert.equal(typeof result.error.message, "string");
  assert.equal(result.error.message.length > 0, true);
  assert.equal(typeof result.error.path, "string");
}
