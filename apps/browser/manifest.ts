import {
  SDK_VERSION,
  defineAppPackage,
} from "../../sdk/typescript/src/desktop-sdk/index.ts";
import type { AppPackage } from "../../sdk/typescript/src/desktop-sdk/index.ts";

export const BROWSER_APP_ID = "vita.app.browser";
export const BROWSER_APP_VERSION = "1.0.0";
export const BROWSER_APP_ENTRY = "index.html";
export const BROWSER_APP_PARTITION = "vita-app-browser";

export const browserAppPackage: AppPackage = defineAppPackage(Object.freeze({
  descriptor: Object.freeze({
    defaultWindow: Object.freeze({
      mode: "floating",
      rect: Object.freeze({
        height: 640,
        width: 960,
        x: 96,
        y: 72,
      }),
    }),
    id: BROWSER_APP_ID,
    runtime: Object.freeze({
      partition: BROWSER_APP_PARTITION,
      url: BROWSER_APP_ENTRY,
    }),
    surfaceKind: "web",
    title: "Browser",
  }),
  manifest: Object.freeze({
    capabilityGrants: Object.freeze([]),
    entry: BROWSER_APP_ENTRY,
    id: BROWSER_APP_ID,
    sdkVersion: SDK_VERSION,
    version: BROWSER_APP_VERSION,
  }),
}));

export default browserAppPackage;
