import assert from "node:assert/strict";
import { test } from "node:test";

import * as sdk from "../../src/desktop-sdk/index.ts";
import {
  DesktopUiPackageLoader,
  KNOWN_GOOD_DESKTOP_UI_PACKAGE_ID,
  SDK_VERSION,
  createDesktopHostForPackage,
  hasDesktopCapabilityGrant,
  isSdkVersionCompatible,
  loadUiPackage,
  validateDesktopUiPackageManifest,
} from "../../src/desktop-sdk/index.ts";
import type {
  DesktopAppLaunch,
  DesktopAppStop,
  DesktopCapabilityGrant,
  DesktopHost,
  DesktopHostResult,
  DesktopLaunchableApp,
  DesktopTheme,
  DesktopUiPackage,
  DesktopUiPackageManifest,
  NotificationPostInput,
  RegisteredShellComponent,
  ShellApplyResult,
  ShellComponentDefinition,
  ShellNotification,
  ShellPreviewResult,
  ShellResult,
  ShellRollbackResult,
  TrayItem,
  TrayItemInput,
} from "../../src/desktop-sdk/index.ts";
import {
  ManagedShellConfigController,
  ShellComponentRegistry,
  composeKnownGoodFallbackShell,
} from "../../src/shell/index.ts";

const EXPECTED_DESKTOP_SDK_EXPORTS = Object.freeze([
  "CompositorDriver",
  "DesktopUiPackageLoader",
  "KNOWN_GOOD_DESKTOP_UI_PACKAGE_ID",
  "NotificationCenter",
  "SDK_VERSION",
  "TrayModel",
  "appSurfaceId",
  "appWindowId",
  "applyWindowManagerEvent",
  "closeWindow",
  "collectWindowManagerIntents",
  "compositorWindowPlacement",
  "computeWindowManagerIntents",
  "createChromeNotificationState",
  "createDesktopHostForPackage",
  "createFileManagerState",
  "createLaunchAppIntent",
  "createPanelFocusIntent",
  "createSettingsAppState",
  "createStaticShellCapabilityPort",
  "createWindowModel",
  "defineShellComponent",
  "defineShellConfig",
  "diffShellLayouts",
  "emitSettingsControlPlaneIntent",
  "fileManagerAppProps",
  "fileManagerAppWindowRequest",
  "filterLauncherApps",
  "firstPartyAppWindowRequests",
  "focusNextWindow",
  "focusPrevWindow",
  "focusPreviousWindow",
  "focusWindow",
  "focusedWindowId",
  "hasDesktopCapabilityGrant",
  "isSdkVersionCompatible",
  "joinCapabilityPath",
  "knownGoodDesktopUiPackage",
  "layout",
  "loadFileManagerDirectory",
  "loadUiPackage",
  "maximizeWindow",
  "minimizeWindow",
  "moveResizeWindow",
  "moveWindow",
  "moveWindowToWorkspace",
  "navigateFileManager",
  "openWindow",
  "parentCapabilityPath",
  "readFileManagerFile",
  "reduceChromeNotifications",
  "reduceNotificationCenter",
  "reduceWindowManagerEvent",
  "reduceWindowModel",
  "renderFileManagerAppSurface",
  "renderSettingsAppSurface",
  "requestMoveResize",
  "requestSettingsApply",
  "requestSettingsPreview",
  "resizeWindow",
  "setWorkspaceLayout",
  "settingsAppProps",
  "settingsAppWindowRequest",
  "settleSettingsControlPlaneResult",
  "shellComponent",
  "shellSurface",
  "stackWorkspace",
  "switchWorkspace",
  "tileWorkspace",
  "validateDesktopUiPackageManifest",
]);

test("public desktop SDK surface exposes consumer API and hides platform internals", () => {
  assert.deepEqual(Object.keys(sdk).sort(), EXPECTED_DESKTOP_SDK_EXPORTS);
  assert.equal(SDK_VERSION, "1.0.0");
  assert.equal(typeof sdk.defineShellComponent, "function");
  assert.equal(typeof sdk.defineShellConfig, "function");
  assert.equal(typeof sdk.createWindowModel, "function");
  assert.equal(typeof sdk.collectWindowManagerIntents, "function");
  assert.equal(typeof sdk.CompositorDriver, "function");
  assert.equal(typeof sdk.NotificationCenter, "function");
  assert.equal(typeof sdk.TrayModel, "function");
  assert.equal(typeof sdk.loadUiPackage, "function");
  assert.equal(typeof sdk.DesktopUiPackageLoader, "function");

  for (const internalName of [
    "AppHost",
    "AppHostPorts",
    "CapsuleRuntimePort",
    "DesktopNativeCompositorSubstrate",
    "DESKTOP_SUBSTRATE_INTERFACE_ID",
    "NativeCompositorPort",
    "NativeCompositorPortError",
    "createNativeCompositorPort",
    "encodeNativeCompositorCommand",
  ]) {
    assert.equal(Object.hasOwn(sdk, internalName), false, `${internalName} must not be public`);
  }
});

test("manifest validation accepts compatible semver declarations and rejects incompatible packages", () => {
  const compatibleRange = validateDesktopUiPackageManifest(manifest("ui.compat", {
    sdkVersion: {
      max: "2.0.0",
      min: "1.0.0",
    },
  }));

  assert.equal(compatibleRange.ok, true);
  if (!compatibleRange.ok) {
    assert.fail("expected compatible range manifest");
  }
  assert.equal(compatibleRange.value.id, "ui.compat");
  assert.equal(hasDesktopCapabilityGrant(compatibleRange.value, "shell.notifications.post", "welcome"), true);
  assert.equal(hasDesktopCapabilityGrant(compatibleRange.value, "shell.tray.register", "missing"), false);

  const compatibleString = validateDesktopUiPackageManifest(manifest("ui.string", {
    sdkVersion: SDK_VERSION,
  }));
  assert.equal(compatibleString.ok, true);
  assert.equal(isSdkVersionCompatible(SDK_VERSION), true);
  assert.equal(isSdkVersionCompatible("2.0.0"), false);

  const incompatible = validateDesktopUiPackageManifest(manifest("ui.future", {
    sdkVersion: {
      max: "3.0.0",
      min: "2.0.0",
    },
  }));

  assert.equal(incompatible.ok, false);
  if (incompatible.ok) {
    assert.fail("expected incompatible SDK rejection");
  }
  assert.equal(incompatible.error.code, "SDK_VERSION_INCOMPATIBLE");
});

test("manifest validation fails closed on malformed and hostile inputs", () => {
  let getterReads = 0;
  const hostile: Record<string, unknown> = {};

  Object.defineProperty(hostile, "id", {
    enumerable: true,
    get() {
      getterReads += 1;
      return "ui.hostile";
    },
  });

  assert.doesNotThrow(() => {
    const result = validateDesktopUiPackageManifest(hostile);

    assert.equal(result.ok, false);
  });
  assert.equal(getterReads, 0);

  const cyclic: Record<string, unknown> = {
    ...manifest("ui.cyclic"),
  };
  cyclic["self"] = cyclic;

  assert.doesNotThrow(() => {
    const result = validateDesktopUiPackageManifest(cyclic);

    assert.equal(result.ok, false);
  });

  const shadowedCapabilityGrants: unknown[] = [
    {
      capability: "shell.notifications.post",
    },
  ];
  const shadowedGrants: Record<string, unknown> = {
    ...manifest("ui.shadowed"),
    capabilityGrants: shadowedCapabilityGrants,
  };
  Object.defineProperty(shadowedCapabilityGrants, "map", {
    enumerable: true,
    value: () => {
      throw new Error("must not call array methods from untrusted grants");
    },
  });

  const shadowed = validateDesktopUiPackageManifest(shadowedGrants);

  assert.equal(shadowed.ok, false);
});

test("loadUiPackage mounts a fake UI package against a scoped fake host", async () => {
  const events: string[] = [];
  const host = fakeHost(events);
  const result = await loadUiPackage(uiPackage("ui.loaded", events), host, {
    fallbackPackage: fallbackPackage(events),
  });

  assert.equal(result.ok, true);
  if (!result.ok) {
    assert.fail("expected package to load");
  }
  assert.equal(result.loaded.source, "requested");
  assert.equal(result.loaded.manifest.id, "ui.loaded");
  assert.deepEqual(events, [
    "mount:ui.loaded",
    "register:ui.loaded.component",
    "theme:vita.test.theme",
    "notify:welcome",
  ]);
});

test("scoped host denies stopApp without an app-scoped stop grant", async () => {
  const events: string[] = [];
  const host = fakeHost(events);
  const scoped = createDesktopHostForPackage(host, manifest("ui.no-stop", {
    capabilityGrants: Object.freeze([]),
  }));

  const denied = await scoped.stopApp("victim.app");

  assert.equal(denied.ok, false);
  if (denied.ok) {
    assert.fail("expected stopApp to fail closed without apps.stop");
  }
  assert.equal(denied.error.code, "MISSING_CAPABILITY");
  assert.deepEqual(events, []);

  const validatedStopGrant = validateDesktopUiPackageManifest(manifest("ui.stopper", {
    capabilityGrants: Object.freeze([
      Object.freeze({
        capability: "apps.stop",
        resourceId: "victim.app",
      }),
    ]),
  }));

  assert.equal(validatedStopGrant.ok, true);
  if (!validatedStopGrant.ok) {
    assert.fail("expected apps.stop grant to validate");
  }

  const allowed = createDesktopHostForPackage(host, validatedStopGrant.value);
  const stopped = await allowed.stopApp("victim.app");

  assert.equal(stopped.ok, true);
  assert.deepEqual(events, [
    "stop:victim.app",
  ]);
});

test("loader swap unmounts the current package before mounting the next package", async () => {
  const events: string[] = [];
  const loader = new DesktopUiPackageLoader(fakeHost(events), {
    fallbackPackage: fallbackPackage(events),
  });

  const first = await loader.load(uiPackage("ui.first", events));

  assert.equal(first.ok, true);
  const second = await loader.swap(uiPackage("ui.second", events));

  assert.equal(second.ok, true);
  if (!second.ok) {
    assert.fail("expected second package to load");
  }
  assert.equal(loader.current()?.manifest.id, "ui.second");
  assert.deepEqual(events, [
    "mount:ui.first",
    "register:ui.first.component",
    "theme:vita.test.theme",
    "notify:welcome",
    "unmount:ui.first",
    "mount:ui.second",
    "register:ui.second.component",
    "theme:vita.test.theme",
    "notify:welcome",
  ]);
});

test("broken package mount rolls back and falls back to known-good package", async () => {
  const events: string[] = [];
  const loader = new DesktopUiPackageLoader(fakeHost(events), {
    fallbackPackage: fallbackPackage(events),
  });

  assert.equal((await loader.load(uiPackage("ui.good", events))).ok, true);

  const recovered = await loader.swap(uiPackage("ui.broken", events, {
    failMount: true,
  }));

  assert.equal(recovered.ok, true);
  if (!recovered.ok) {
    assert.fail("expected fallback recovery");
  }
  assert.equal(recovered.loaded.source, "fallback");
  assert.equal(recovered.loaded.manifest.id, "ui.fallback");
  assert.equal(recovered.recoveredFrom?.code, "UI_PACKAGE_MOUNT_FAILED");
  assert.equal(loader.current()?.manifest.id, "ui.fallback");
  assert.deepEqual(events, [
    "mount:ui.good",
    "register:ui.good.component",
    "theme:vita.test.theme",
    "notify:welcome",
    "unmount:ui.good",
    "mount:ui.broken",
    "rollback",
    "mount:ui.fallback",
    "preview:ui.fallback.shell",
    "apply:ui.fallback.shell",
  ]);
});

test("incompatible package never mounts and recovers to built-in known-good fallback", async () => {
  const events: string[] = [];
  const incompatible = uiPackage("ui.future", events, {
    sdkVersion: {
      max: "3.0.0",
      min: "2.0.0",
    },
  });

  const recovered = await loadUiPackage(incompatible, realShellBackedHost(events));

  assert.equal(recovered.ok, true);
  if (!recovered.ok) {
    assert.fail("expected built-in fallback recovery");
  }
  assert.equal(recovered.loaded.source, "fallback");
  assert.equal(recovered.loaded.manifest.id, KNOWN_GOOD_DESKTOP_UI_PACKAGE_ID);
  assert.equal(recovered.recoveredFrom?.code, "SDK_VERSION_INCOMPATIBLE");
  assert.deepEqual(events, [
    "register:vita.shell.fallback",
    "preview:vita.shell.fallback",
    "apply:vita.shell.fallback",
  ]);
});

function manifest(
  id: string,
  overrides: {
    readonly sdkVersion?: DesktopUiPackageManifest["sdkVersion"];
    readonly capabilityGrants?: readonly DesktopCapabilityGrant[];
  } = {},
): DesktopUiPackageManifest {
  return Object.freeze({
    capabilityGrants: overrides.capabilityGrants ?? Object.freeze([
      Object.freeze({
        capability: "shell.notifications.post",
        resourceId: "welcome",
      }),
    ]),
    entry: `./${id}.ts`,
    id,
    sdkVersion: overrides.sdkVersion ?? Object.freeze({
      max: "2.0.0",
      min: "1.0.0",
    }),
    version: "1.0.0",
  });
}

function uiPackage(
  id: string,
  events: string[],
  options: {
    readonly failMount?: boolean;
    readonly sdkVersion?: DesktopUiPackageManifest["sdkVersion"];
  } = {},
): DesktopUiPackage {
  const overrides: {
    sdkVersion?: DesktopUiPackageManifest["sdkVersion"];
  } = {};

  if (options.sdkVersion !== undefined) {
    overrides.sdkVersion = options.sdkVersion;
  }

  return Object.freeze({
    manifest: manifest(id, overrides),
    mount(host: DesktopHost) {
      events.push(`mount:${id}`);
      if (options.failMount === true) {
        throw new Error("configured mount failure");
      }

      const component = host.registerComponent(sdk.defineShellComponent({
        defaultPlacement: {
          zone: "center",
        },
        id: `${id}.component`,
        render: () => sdk.shellSurface({
          title: id,
        }),
        role: "desktop",
      }));

      assert.equal(component.ok, true);
      events.push(`theme:${host.readTheme().id}`);

      const notification = host.postNotification({
        id: "welcome",
        title: "Welcome",
      });

      assert.equal(notification.ok, true);

      return Object.freeze({
        packageId: id,
        unmount() {
          events.push(`unmount:${id}`);
        },
      });
    },
  });
}

function fallbackPackage(events: string[]): DesktopUiPackage {
  return Object.freeze({
    manifest: manifest("ui.fallback", {
      capabilityGrants: Object.freeze([]),
    }),
    mount(host: DesktopHost) {
      events.push("mount:ui.fallback");
      const config = sdk.defineShellConfig({
        id: "ui.fallback.shell",
        render: ({ surface }) => surface({
          safeMode: true,
        }),
      });
      const preview = host.previewShell(config);

      assert.equal(preview.ok, true);
      const applied = host.applyShell(config);

      assert.equal(applied.ok, true);

      return Object.freeze({
        packageId: "ui.fallback",
        unmount() {
          events.push("unmount:ui.fallback");
        },
      });
    },
  });
}

function fakeHost(events: string[]): DesktopHost {
  return Object.freeze({
    applyShell(definition: Parameters<DesktopHost["applyShell"]>[0]) {
      events.push(`apply:${definition.id}`);

      return shellApply();
    },
    launchApp(app: DesktopLaunchableApp): DesktopHostResult<DesktopAppLaunch> {
      return {
        ok: true,
        value: Object.freeze({
          app,
          intents: Object.freeze([]),
          surfaceId: `surface:${app.id}`,
          textureId: `surface:${app.id}`,
          windowId: `window:${app.id}`,
        }),
      };
    },
    package: manifest("host"),
    postNotification(input: NotificationPostInput) {
      events.push(`notify:${input.id}`);

      return shellAccept(notification(input));
    },
    previewShell(definition: Parameters<DesktopHost["previewShell"]>[0]) {
      events.push(`preview:${definition.id}`);

      return shellPreview();
    },
    readTheme() {
      return theme();
    },
    registerComponent(definition: ShellComponentDefinition) {
      events.push(`register:${definition.id}`);

      return shellAccept(registeredComponent(definition));
    },
    registerTrayItem(input: TrayItemInput) {
      return shellAccept(trayItem(input));
    },
    rollbackShell() {
      events.push("rollback");

      return shellRollback();
    },
    stopApp(appId: string): DesktopHostResult<DesktopAppStop> {
      events.push(`stop:${appId}`);

      return {
        ok: true,
        value: Object.freeze({
          appId,
          intents: Object.freeze([]),
        }),
      };
    },
  });
}

function realShellBackedHost(events: string[]): DesktopHost {
  const registry = new ShellComponentRegistry();
  const controller = new ManagedShellConfigController(registry);
  const base = fakeHost(events);

  return Object.freeze({
    ...base,
    applyShell(definition: Parameters<DesktopHost["applyShell"]>[0]) {
      events.push(`apply:${definition.id}`);

      return controller.apply(definition);
    },
    currentShell() {
      return controller.current();
    },
    previewShell(definition: Parameters<DesktopHost["previewShell"]>[0]) {
      events.push(`preview:${definition.id}`);

      return controller.preview(definition);
    },
    registerComponent(definition: ShellComponentDefinition) {
      events.push(`register:${definition.id}`);

      return registry.register(definition);
    },
    rollbackShell() {
      events.push("rollback");

      return controller.rollback();
    },
  });
}

function shellPreview(): ShellPreviewResult {
  return Object.freeze({
    diff: emptyDiff(),
    layout: composeKnownGoodFallbackShell(),
    ok: true,
  });
}

function shellApply(): ShellApplyResult {
  return Object.freeze({
    diff: emptyDiff(),
    layout: composeKnownGoodFallbackShell(),
    ok: true,
    outcome: "committed",
  });
}

function shellRollback(): ShellRollbackResult {
  return Object.freeze({
    layout: composeKnownGoodFallbackShell(),
    ok: true,
    outcome: "rolledBack",
  });
}

function emptyDiff() {
  return Object.freeze({
    added: Object.freeze([]),
    changed: Object.freeze([]),
    removed: Object.freeze([]),
  });
}

function registeredComponent(definition: ShellComponentDefinition): RegisteredShellComponent {
  return Object.freeze({
    defaultPlacement: Object.freeze({
      layer: definition.defaultPlacement.layer ?? "desktop",
      order: definition.defaultPlacement.order ?? 0,
      zone: definition.defaultPlacement.zone ?? "center",
    }),
    id: definition.id,
    render: definition.render,
    role: definition.role,
  });
}

function notification(input: NotificationPostInput): ShellNotification {
  return Object.freeze({
    actions: Object.freeze([]),
    appId: "ui.loaded",
    createdAtMs: 1,
    id: input.id,
    priority: input.priority ?? "normal",
    title: input.title,
  });
}

function trayItem(input: TrayItemInput): TrayItem {
  return Object.freeze({
    appId: "ui.loaded",
    iconRef: input.iconRef,
    id: input.id,
    menu: Object.freeze([]),
    order: input.order ?? 0,
    tooltip: input.tooltip,
  });
}

function theme(): DesktopTheme {
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

function shellAccept<T>(value: T): ShellResult<T> {
  return {
    ok: true,
    value,
  };
}
