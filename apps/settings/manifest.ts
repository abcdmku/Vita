import {
  SDK_VERSION,
  defineAppPackage,
} from "../../sdk/typescript/src/desktop-sdk/index.ts";
import type {
  AppPackage,
} from "../../sdk/typescript/src/desktop-sdk/index.ts";

export const SETTINGS_APP_PACKAGE_ID = "vita.app.settings";
export const SETTINGS_APP_PACKAGE_VERSION = "1.0.0";
export const SETTINGS_APP_ENTRY = "index.html";

export const settingsAppPackage: AppPackage = defineAppPackage({
  descriptor: {
    defaultWindow: {
      className: "vita-settings-app",
      layer: "desktop",
      mode: "floating",
      order: 20,
      rect: {
        height: 540,
        width: 720,
        x: 120,
        y: 72,
      },
      zone: "center",
    },
    id: SETTINGS_APP_PACKAGE_ID,
    runtime: {
      partition: "vita-app-settings",
      url: SETTINGS_APP_ENTRY,
    },
    surfaceKind: "web",
    title: "Settings",
  },
  manifest: {
    capabilityGrants: [
      {
        capability: "settings.read",
      },
      {
        capability: "settings.write",
      },
    ],
    entry: SETTINGS_APP_ENTRY,
    id: SETTINGS_APP_PACKAGE_ID,
    sdkVersion: SDK_VERSION,
    version: SETTINGS_APP_PACKAGE_VERSION,
  },
});

export const settingsAppPackageManifest = settingsAppPackage.manifest;
export const settingsAppDescriptor = settingsAppPackage.descriptor;

export default settingsAppPackage;
