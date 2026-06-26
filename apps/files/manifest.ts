import {
  SDK_VERSION,
  defineAppPackage,
} from "../../sdk/typescript/src/desktop-sdk/index.ts";
import type {
  AppPackage,
  DesktopCapabilityGrant,
} from "../../sdk/typescript/src/desktop-sdk/index.ts";

export const FILES_APP_ID = "vita.app.files";
export const FILES_APP_VERSION = "1.0.0";
export const FILES_APP_ENTRY = "index.html";
export const FILES_APP_PARTITION = "vita-app-files";

const FILES_APP_CAPABILITY_GRANTS = Object.freeze([
  Object.freeze({
    capability: "files.read",
  }),
  Object.freeze({
    capability: "files.write",
  }),
]) satisfies readonly DesktopCapabilityGrant[];

export const filesAppPackage: AppPackage = defineAppPackage(Object.freeze({
  descriptor: Object.freeze({
    defaultWindow: Object.freeze({
      className: "vita-files-app",
      layer: "desktop",
      mode: "floating",
      order: 20,
      rect: Object.freeze({
        height: 580,
        width: 860,
        x: 210,
        y: 84,
      }),
      zone: "center",
    }),
    id: FILES_APP_ID,
    runtime: Object.freeze({
      partition: FILES_APP_PARTITION,
      url: FILES_APP_ENTRY,
    }),
    surfaceKind: "web",
    title: "Files",
  }),
  manifest: Object.freeze({
    capabilityGrants: FILES_APP_CAPABILITY_GRANTS,
    entry: FILES_APP_ENTRY,
    id: FILES_APP_ID,
    sdkVersion: SDK_VERSION,
    version: FILES_APP_VERSION,
  }),
}));

export const filesAppManifest = filesAppPackage.manifest;
export const filesAppDescriptor = filesAppPackage.descriptor;

export default filesAppPackage;
