import assert from "node:assert/strict";
import { test } from "node:test";

import {
  DESKTOP_APP_ID,
  DESKTOP_NOTIFICATION_ID,
  DESKTOP_SHELL_CONFIG_ID,
  DESKTOP_TRAY_ID,
  DESKTOP_UI_ENTRY,
  DESKTOP_UI_PACKAGE_ID,
  desktopScreenSurfaces,
  desktopUiPackage,
} from "../../../../ui_kits/desktop/package.ts";
import {
  DesktopUiPackageLoader,
  SDK_VERSION,
  defineShellComponent,
  defineShellConfig,
  hasDesktopCapabilityGrant,
  loadUiPackage,
  shellSurface,
  validateDesktopUiPackageManifest,
} from "../../src/desktop-sdk/index.ts";
import type {
  DesktopAppLaunch,
  DesktopAppStop,
  DesktopCapability,
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

const EXPECTED_SCREEN_IDS = Object.freeze([
  "desktop",
  "desktop/settings",
  "desktop/files",
  "desktop/shell",
  "desktop/activity",
  "desktop/notifications",
  "desktop/lock",
  "desktop/tiling",
]);

interface DesktopHostHarness {
  readonly host: DesktopHost;
  readonly events: string[];
  readonly launchedApps: Set<string>;
  readonly registeredComponentIds: string[];
  readonly duplicateComponentIds: string[];
  readonly notificationIds: string[];
  readonly trayItemIds: string[];
  readonly rollbackCount: () => number;
}

interface DesktopHostHarnessOptions {
  readonly realShell?: boolean;
  readonly throwOnTrayItemId?: string;
}

test("flagship desktop package manifest names the real desktop kit and SDK boundary", () => {
  const validated = validateDesktopUiPackageManifest(desktopUiPackage.manifest);

  assert.equal(validated.ok, true);
  if (!validated.ok) {
    assert.fail("expected flagship desktop manifest to validate");
  }

  assert.equal(validated.value.id, DESKTOP_UI_PACKAGE_ID);
  assert.equal(validated.value.entry, DESKTOP_UI_ENTRY);
  assert.equal(validated.value.sdkVersion, SDK_VERSION);
  assert.deepEqual(desktopScreenSurfaces.map((screen) => screen.id), EXPECTED_SCREEN_IDS);
  assert.equal(hasDesktopCapabilityGrant(validated.value, "apps.launch"), true);
  assert.equal(hasDesktopCapabilityGrant(validated.value, "apps.stop"), true);
  assert.equal(hasDesktopCapabilityGrant(validated.value, "launcher.launch"), true);
  assert.equal(hasDesktopCapabilityGrant(validated.value, "settings.read"), true);
  assert.equal(hasDesktopCapabilityGrant(validated.value, "settings.write"), true);
  assert.equal(hasDesktopCapabilityGrant(validated.value, "shell.notifications.post"), true);
  assert.equal(hasDesktopCapabilityGrant(validated.value, "shell.tray.register"), true);
});

test("flagship desktop package loads through the SDK loader and unmounts cleanly", async () => {
  const harness = desktopHostHarness();
  const loader = new DesktopUiPackageLoader(harness.host, {
    fallbackPackage: noOpFallbackPackage(),
  });
  const loaded = await loader.load(desktopUiPackage);

  assert.equal(loaded.ok, true);
  if (!loaded.ok) {
    assert.fail("expected flagship desktop package to load");
  }
  assert.equal(loaded.loaded.source, "requested");
  assert.equal(loaded.loaded.manifest.id, DESKTOP_UI_PACKAGE_ID);
  assert.deepEqual(harness.registeredComponentIds, EXPECTED_SCREEN_IDS);
  assert.deepEqual(harness.notificationIds, [DESKTOP_NOTIFICATION_ID]);
  assert.deepEqual(harness.trayItemIds, [DESKTOP_TRAY_ID]);
  assert.equal(harness.launchedApps.has(DESKTOP_APP_ID), true);
  assert.equal(harness.events.includes(`preview:${DESKTOP_SHELL_CONFIG_ID}`), true);
  assert.equal(harness.events.includes(`apply:${DESKTOP_SHELL_CONFIG_ID}`), true);

  const unmounted = await loader.unmount();

  assert.equal(unmounted.ok, true);
  assert.equal(harness.launchedApps.has(DESKTOP_APP_ID), false);
  assert.equal(harness.rollbackCount(), 1);
});

test("flagship desktop package is re-mountable on a host that keeps component registrations", async () => {
  const harness = desktopHostHarness();
  const loader = new DesktopUiPackageLoader(harness.host, {
    fallbackPackage: noOpFallbackPackage(),
  });

  assert.equal((await loader.load(desktopUiPackage)).ok, true);
  assert.equal((await loader.unmount()).ok, true);

  const reloaded = await loader.load(desktopUiPackage);

  assert.equal(reloaded.ok, true);
  assert.deepEqual(harness.duplicateComponentIds, EXPECTED_SCREEN_IDS);
  assert.equal(harness.launchedApps.has(DESKTOP_APP_ID), true);
});

test("missing required grants fail closed and do not leak the launched desktop app", async () => {
  const harness = desktopHostHarness();
  const missingNotificationGrant = packageWithoutCapability("shell.notifications.post");
  const result = await loadUiPackage(missingNotificationGrant, harness.host, {
    fallbackPackage: noOpFallbackPackage(),
  });

  assert.equal(result.ok, true);
  if (!result.ok) {
    assert.fail("expected fallback recovery after missing grant");
  }
  assert.equal(result.loaded.source, "fallback");
  assert.equal(result.recoveredFrom?.code, "UI_PACKAGE_MOUNT_FAILED");
  assert.equal(harness.launchedApps.has(DESKTOP_APP_ID), false);
  assert.equal(harness.notificationIds.length, 0);
  assert.equal(harness.rollbackCount(), 1);
  assert.deepEqual(eventsOf(harness, "launch", "stop", "rollback"), [
    "rollback",
  ]);
});

test("post-launch mount failures stop the launched desktop app before loader rollback", async () => {
  const harness = desktopHostHarness({
    throwOnTrayItemId: DESKTOP_TRAY_ID,
  });
  const result = await loadUiPackage(desktopUiPackage, harness.host, {
    fallbackPackage: noOpFallbackPackage(),
  });

  assert.equal(result.ok, true);
  if (!result.ok) {
    assert.fail("expected fallback recovery after tray registration failure");
  }
  assert.equal(result.loaded.source, "fallback");
  assert.equal(result.recoveredFrom?.code, "UI_PACKAGE_MOUNT_FAILED");
  assert.equal(harness.launchedApps.has(DESKTOP_APP_ID), false);
  assert.equal(harness.rollbackCount(), 1);
  assert.deepEqual(eventsOf(harness, "launch", "notify", "tray", "stop", "rollback"), [
    `launch:${DESKTOP_APP_ID}:index.html`,
    `notify:${DESKTOP_NOTIFICATION_ID}`,
    `tray:${DESKTOP_TRAY_ID}`,
    `stop:${DESKTOP_APP_ID}`,
    "rollback",
  ]);
});

test("post-launch mount failure relies on the loader for the single shell rollback", async () => {
  const harness = desktopHostHarness({
    realShell: true,
    throwOnTrayItemId: DESKTOP_TRAY_ID,
  });
  const loader = new DesktopUiPackageLoader(harness.host, {
    fallbackPackage: noOpFallbackPackage(),
  });
  const prior = await loader.load(priorGoodShellPackage());

  assert.equal(prior.ok, true);
  assert.equal(harness.host.currentShell?.().layout.configId, "prior.good");

  const rollbacksBeforeFailure = harness.rollbackCount();
  const recovered = await loader.swap(desktopUiPackage);

  assert.equal(recovered.ok, true);
  if (!recovered.ok) {
    assert.fail("expected fallback recovery after desktop tray failure");
  }
  assert.equal(recovered.loaded.source, "fallback");
  assert.equal(recovered.recoveredFrom?.code, "UI_PACKAGE_MOUNT_FAILED");
  assert.equal(harness.rollbackCount() - rollbacksBeforeFailure, 1);
  assert.equal(harness.host.currentShell?.().layout.configId, "prior.good");
  assert.equal(harness.launchedApps.has(DESKTOP_APP_ID), false);
});

function packageWithoutCapability(capability: DesktopCapability): DesktopUiPackage {
  const capabilityGrants: DesktopCapabilityGrant[] = [];

  for (let index = 0; index < desktopUiPackage.manifest.capabilityGrants.length; index += 1) {
    const grant = desktopUiPackage.manifest.capabilityGrants[index];

    if (grant !== undefined && grant.capability !== capability) {
      capabilityGrants.push(grant);
    }
  }

  return Object.freeze({
    manifest: Object.freeze({
      ...desktopUiPackage.manifest,
      capabilityGrants: Object.freeze(capabilityGrants),
    }),
    mount: desktopUiPackage.mount,
  });
}

function noOpFallbackPackage(): DesktopUiPackage {
  return Object.freeze({
    manifest: manifest("desktop.fallback"),
    mount() {
      return Object.freeze({
        packageId: "desktop.fallback",
        unmount() {},
      });
    },
  });
}

function priorGoodShellPackage(): DesktopUiPackage {
  return Object.freeze({
    manifest: manifest("prior.good"),
    mount(host: DesktopHost) {
      const registered = host.registerComponent(defineShellComponent({
        defaultPlacement: {
          layer: "desktop",
          order: 0,
          zone: "prior",
        },
        id: "prior/good",
        render: () => shellSurface({
          title: "Prior Good Shell",
        }),
        role: "desktop",
      }));

      assert.equal(registered.ok, true);

      const config = defineShellConfig({
        id: "prior.good",
        render: ({ component }) => component("prior/good", {
          key: "prior",
          placement: {
            layer: "desktop",
            order: 0,
            zone: "prior",
          },
        }),
      });
      const preview = host.previewShell(config);

      assert.equal(preview.ok, true);

      const applied = host.applyShell(config);

      assert.equal(applied.ok, true);

      return Object.freeze({
        packageId: "prior.good",
        unmount() {},
      });
    },
  });
}

function manifest(id: string): DesktopUiPackageManifest {
  return Object.freeze({
    capabilityGrants: Object.freeze([]),
    entry: `${id}.html`,
    id,
    sdkVersion: SDK_VERSION,
    version: "1.0.0",
  });
}

function desktopHostHarness(options: DesktopHostHarnessOptions = Object.freeze({})): DesktopHostHarness {
  const events: string[] = [];
  const launchedApps = new Set<string>();
  const registeredComponentIds: string[] = [];
  const duplicateComponentIds: string[] = [];
  const notificationIds: string[] = [];
  const trayItemIds: string[] = [];
  const fakeComponents = new Map<string, RegisteredShellComponent>();
  const registry = options.realShell === true ? new ShellComponentRegistry() : null;
  const controller = registry === null ? null : new ManagedShellConfigController(registry);
  let rollbackCount = 0;
  const hostBase = {
    applyShell(definition: Parameters<DesktopHost["applyShell"]>[0]) {
      events.push(`apply:${definition.id}`);

      if (controller !== null) {
        return controller.apply(definition);
      }

      return shellApply();
    },
    launchApp(app: DesktopLaunchableApp): DesktopHostResult<DesktopAppLaunch> {
      const entry = app.surfaceKind === "web" ? app.runtime.url : app.id;

      events.push(`launch:${app.id}:${entry}`);
      launchedApps.add(app.id);

      return {
        ok: true,
        value: Object.freeze({
          app,
          intents: Object.freeze([]),
          surfaceId: `surface:${app.id}`,
          textureId: `texture:${app.id}`,
          windowId: `window:${app.id}`,
        }),
      };
    },
    package: manifest("host"),
    postNotification(input: NotificationPostInput) {
      events.push(`notify:${input.id}`);
      notificationIds.push(input.id);

      return shellAccept(notification(input));
    },
    previewShell(definition: Parameters<DesktopHost["previewShell"]>[0]) {
      events.push(`preview:${definition.id}`);

      if (controller !== null) {
        return controller.preview(definition);
      }

      return shellPreview();
    },
    readTheme() {
      return theme();
    },
    registerComponent(definition: ShellComponentDefinition) {
      events.push(`register:${definition.id}`);

      if (controller !== null && registry !== null) {
        const registered = registry.register(definition);

        if (registered.ok) {
          registeredComponentIds.push(definition.id);
        } else if (registered.error.code === "DUPLICATE_COMPONENT") {
          duplicateComponentIds.push(definition.id);
        }

        return registered;
      }

      if (fakeComponents.has(definition.id)) {
        duplicateComponentIds.push(definition.id);

        return shellReject(
          "DUPLICATE_COMPONENT",
          `Shell component '${definition.id}' is already registered.`,
          "/id",
        );
      }

      const registered = registeredComponent(definition);

      fakeComponents.set(definition.id, registered);
      registeredComponentIds.push(definition.id);

      return shellAccept(registered);
    },
    registerTrayItem(input: TrayItemInput) {
      events.push(`tray:${input.id}`);

      if (options.throwOnTrayItemId === input.id) {
        throw new Error(`configured tray failure for ${input.id}`);
      }

      trayItemIds.push(input.id);

      return shellAccept(trayItem(input));
    },
    rollbackShell() {
      events.push("rollback");
      rollbackCount += 1;

      if (controller !== null) {
        return controller.rollback();
      }

      return shellRollback();
    },
    stopApp(appId: string): DesktopHostResult<DesktopAppStop> {
      events.push(`stop:${appId}`);
      launchedApps.delete(appId);

      return {
        ok: true,
        value: Object.freeze({
          appId,
          intents: Object.freeze([]),
        }),
      };
    },
  } satisfies Omit<DesktopHost, "currentShell">;
  const host: DesktopHost = controller === null
    ? hostBase
    : {
        ...hostBase,
        currentShell() {
          return controller.current();
        },
      };

  return {
    duplicateComponentIds,
    events,
    host: Object.freeze(host),
    launchedApps,
    notificationIds,
    registeredComponentIds,
    rollbackCount: () => rollbackCount,
    trayItemIds,
  };
}

function eventsOf(harness: DesktopHostHarness, ...prefixes: readonly string[]): string[] {
  const output: string[] = [];

  for (let eventIndex = 0; eventIndex < harness.events.length; eventIndex += 1) {
    const event = harness.events[eventIndex];

    if (event === undefined) continue;

    for (let prefixIndex = 0; prefixIndex < prefixes.length; prefixIndex += 1) {
      const prefix = prefixes[prefixIndex];

      if (prefix !== undefined && event.startsWith(prefix)) {
        output.push(event);
        break;
      }
    }
  }

  return output;
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
    appId: DESKTOP_UI_PACKAGE_ID,
    createdAtMs: 1,
    id: input.id,
    priority: input.priority ?? "normal",
    title: input.title,
  });
}

function trayItem(input: TrayItemInput): TrayItem {
  return Object.freeze({
    appId: DESKTOP_UI_PACKAGE_ID,
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

function shellReject<T>(code: string, message: string, path: string): ShellResult<T> {
  return {
    error: {
      code,
      message,
      path,
    },
    ok: false,
  };
}
