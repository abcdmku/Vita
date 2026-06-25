import {
  SDK_VERSION,
  defineShellComponent,
  defineShellConfig,
  hasDesktopCapabilityGrant,
  shellSurface,
} from "../../sdk/typescript/src/desktop-sdk/index.ts";
import type {
  DesktopCapability,
  DesktopHost,
  DesktopHostError,
  DesktopHostResult,
  DesktopLaunchableApp,
  DesktopUiInstance,
  DesktopUiPackage,
  DesktopUiPackageManifest,
  ShellConfigRenderApi,
  ShellComponentDefinition,
  ShellElement,
  ShellPlacementInput,
} from "../../sdk/typescript/src/desktop-sdk/index.ts";

export const DESKTOP_UI_PACKAGE_ID = "vita.desktop.flagship";
export const DESKTOP_UI_PACKAGE_VERSION = "1.0.0";
export const DESKTOP_UI_ENTRY = "index.html";
export const DESKTOP_APP_ID = DESKTOP_UI_PACKAGE_ID;
export const DESKTOP_SHELL_CONFIG_ID = "desktop";
export const DESKTOP_NOTIFICATION_ID = "desktop.notifications";
export const DESKTOP_TRAY_ID = "desktop.status";

interface DesktopScreenSurface {
  readonly id: string;
  readonly title: string;
  readonly entry: string;
  readonly role: string;
  readonly placement: ShellPlacementInput;
}

type ShellLikeResult =
  | {
      readonly ok: true;
    }
  | {
      readonly ok: false;
      readonly error: DesktopHostError;
    };

const ROOT_PLACEMENT = Object.freeze({
  layer: "desktop",
  order: 0,
  zone: "root",
}) satisfies ShellPlacementInput;

const VIEW_PLACEMENT = Object.freeze({
  layer: "desktop",
  order: 10,
  zone: "view",
}) satisfies ShellPlacementInput;

const REQUIRED_CAPABILITIES = Object.freeze([
  "apps.launch",
  "apps.stop",
  "launcher.launch",
  "settings.read",
  "settings.write",
  "shell.notifications.post",
  "shell.tray.register",
]) satisfies readonly DesktopCapability[];

export const desktopScreenSurfaces = Object.freeze([
  Object.freeze({
    entry: DESKTOP_UI_ENTRY,
    id: "desktop",
    placement: ROOT_PLACEMENT,
    role: "desktop",
    title: "Desktop",
  }),
  Object.freeze({
    entry: "Settings.html",
    id: "desktop/settings",
    placement: VIEW_PLACEMENT,
    role: "settings",
    title: "Settings",
  }),
  Object.freeze({
    entry: "Files.html",
    id: "desktop/files",
    placement: VIEW_PLACEMENT,
    role: "files",
    title: "Files",
  }),
  Object.freeze({
    entry: "Shell.html",
    id: "desktop/shell",
    placement: VIEW_PLACEMENT,
    role: "shell",
    title: "Shell",
  }),
  Object.freeze({
    entry: "Activity.html",
    id: "desktop/activity",
    placement: VIEW_PLACEMENT,
    role: "activity",
    title: "Activity",
  }),
  Object.freeze({
    entry: "Notifications.html",
    id: "desktop/notifications",
    placement: VIEW_PLACEMENT,
    role: "notifications",
    title: "Notifications",
  }),
  Object.freeze({
    entry: "Lock.html",
    id: "desktop/lock",
    placement: VIEW_PLACEMENT,
    role: "lock",
    title: "Lock",
  }),
  Object.freeze({
    entry: "Tiling.html",
    id: "desktop/tiling",
    placement: VIEW_PLACEMENT,
    role: "tiling",
    title: "Tiling",
  }),
]) satisfies readonly DesktopScreenSurface[];

export const desktopUiPackageManifest: DesktopUiPackageManifest = Object.freeze({
  capabilityGrants: Object.freeze([
    Object.freeze({
      capability: "apps.launch",
    }),
    Object.freeze({
      capability: "apps.stop",
    }),
    Object.freeze({
      capability: "launcher.launch",
    }),
    Object.freeze({
      capability: "settings.read",
    }),
    Object.freeze({
      capability: "settings.write",
    }),
    Object.freeze({
      capability: "shell.notifications.post",
    }),
    Object.freeze({
      capability: "shell.tray.register",
    }),
  ]),
  entry: DESKTOP_UI_ENTRY,
  id: DESKTOP_UI_PACKAGE_ID,
  sdkVersion: SDK_VERSION,
  version: DESKTOP_UI_PACKAGE_VERSION,
});

export const desktopUiPackage: DesktopUiPackage = Object.freeze({
  manifest: desktopUiPackageManifest,
  async mount(host: DesktopHost): Promise<DesktopUiInstance> {
    let launchedAppId: string | null = null;

    try {
      registerDesktopScreens(host);
      applyDesktopShell(host);
      assertRequiredGrants(host);
      launchedAppId = await launchDesktop(host);
      postDesktopNotification(host);
      registerDesktopTrayItem(host);

      return desktopUiInstance(host, launchedAppId);
    } catch (error) {
      if (launchedAppId !== null) {
        await cleanupLaunchedDesktop(host, launchedAppId, error);
      }

      throw error;
    }
  },
});

export default desktopUiPackage;

function registerDesktopScreens(host: DesktopHost): void {
  for (let index = 0; index < desktopScreenSurfaces.length; index += 1) {
    const screen = desktopScreenSurfaces[index];

    if (screen === undefined) continue;

    const registered = host.registerComponent(screenComponent(screen));

    if (!registered.ok && registered.error.code !== "DUPLICATE_COMPONENT") {
      throw new Error(`Desktop screen registration failed: ${registered.error.message}`);
    }
  }
}

function screenComponent(screen: DesktopScreenSurface): ShellComponentDefinition {
  return defineShellComponent({
    defaultPlacement: screen.placement,
    id: screen.id,
    render: () => shellSurface({
      entry: screen.entry,
      packageId: DESKTOP_UI_PACKAGE_ID,
      runtime: "web",
      screenId: screen.id,
      title: screen.title,
    }, {
      className: `vita-desktop-screen ${screen.role}`,
    }),
    role: screen.role,
  });
}

function applyDesktopShell(host: DesktopHost): void {
  const config = defineShellConfig({
    id: DESKTOP_SHELL_CONFIG_ID,
    render: ({ component }) => component("desktop", {
      children: childScreenElements(component),
      key: "root",
      placement: ROOT_PLACEMENT,
      role: "desktop",
    }),
    revision: `${DESKTOP_UI_PACKAGE_VERSION}:${SDK_VERSION}`,
  });
  const preview = host.previewShell(config);

  expectShellOk(preview, "Desktop shell preview failed");

  const applied = host.applyShell(config);

  expectShellOk(applied, "Desktop shell apply failed");
}

function assertRequiredGrants(host: DesktopHost): void {
  for (let index = 0; index < REQUIRED_CAPABILITIES.length; index += 1) {
    const capability = REQUIRED_CAPABILITIES[index];

    if (capability !== undefined && !hasDesktopCapabilityGrant(host.package, capability)) {
      throw new Error(`Desktop capability grant missing: ${capability}`);
    }
  }
}

function childScreenElements(component: ShellConfigRenderApi["component"]): readonly ShellElement[] {
  const children: ShellElement[] = [];

  for (let index = 1; index < desktopScreenSurfaces.length; index += 1) {
    const screen = desktopScreenSurfaces[index];

    if (screen === undefined) continue;
    children.push(component(screen.id, {
      key: screen.role,
      placement: screen.placement,
      role: screen.role,
    }));
  }

  return Object.freeze(children);
}

async function launchDesktop(host: DesktopHost): Promise<string> {
  const launched = expectHostOk(await host.launchApp(desktopAppDescriptor()), "Desktop app launch failed");

  return launched.app.id;
}

function desktopAppDescriptor(): DesktopLaunchableApp {
  return Object.freeze({
    defaultWindow: Object.freeze({
      layer: "desktop",
      mode: "floating",
      order: 0,
      zone: "root",
    }),
    id: DESKTOP_APP_ID,
    runtime: Object.freeze({
      partition: "vita-desktop-flagship",
      url: DESKTOP_UI_ENTRY,
    }),
    surfaceKind: "web",
    title: "Vita Desktop",
  });
}

function postDesktopNotification(host: DesktopHost): void {
  const posted = host.postNotification({
    body: "Desktop shell ready.",
    id: DESKTOP_NOTIFICATION_ID,
    priority: "normal",
    title: "Vita Desktop",
  });

  expectShellOk(posted, "Desktop notification registration failed");
}

function registerDesktopTrayItem(host: DesktopHost): void {
  const registered = host.registerTrayItem({
    iconRef: "desktop",
    id: DESKTOP_TRAY_ID,
    menu: Object.freeze([
      Object.freeze({
        id: "settings",
        label: "Settings",
      }),
      Object.freeze({
        id: "notifications",
        label: "Notifications",
      }),
    ]),
    order: 0,
    status: "ok",
    tooltip: "Vita Desktop",
  });

  expectShellOk(registered, "Desktop tray registration failed");
}

function desktopUiInstance(host: DesktopHost, launchedAppId: string): DesktopUiInstance {
  let mounted = true;

  return Object.freeze({
    packageId: DESKTOP_UI_PACKAGE_ID,
    async unmount(): Promise<void> {
      if (!mounted) return;

      await stopDesktopApp(host, launchedAppId);
      const rolledBack = host.rollbackShell();

      expectShellOk(rolledBack, "Desktop shell rollback failed");
      mounted = false;
    },
  });
}

async function cleanupLaunchedDesktop(host: DesktopHost, launchedAppId: string, cause: unknown): Promise<never> {
  try {
    await stopDesktopApp(host, launchedAppId);
  } catch (cleanupError) {
    throw new Error(`${errorMessage(cause, "Desktop mount failed")}; cleanup failed: ${errorMessage(
      cleanupError,
      "desktop app stop failed",
    )}`);
  }

  throw cause;
}

async function stopDesktopApp(host: DesktopHost, appId: string): Promise<void> {
  const stopped = await host.stopApp(appId);

  expectHostOk(stopped, "Desktop app stop failed");
}

function expectHostOk<T>(result: DesktopHostResult<T>, message: string): T {
  if (!result.ok) {
    throw new Error(`${message}: ${result.error.message}`);
  }

  return result.value;
}

function expectShellOk(result: ShellLikeResult, message: string): void {
  if (!result.ok) {
    throw new Error(`${message}: ${result.error.message}`);
  }
}

function errorMessage(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message.length > 0) return error.message;

  return fallback;
}
