import {
  SDK_VERSION,
  defineAppPackage,
} from "../../sdk/typescript/src/desktop-sdk/index.ts";
import type {
  AppPackage,
} from "../../sdk/typescript/src/desktop-sdk/index.ts";

export const MAIL_APP_ID = "vita.app.mail";
export const MAIL_APP_ENTRY = "index.html";
export const MAIL_APP_PARTITION = "vita-app-mail";

export const mailAppPackage: AppPackage = defineAppPackage(Object.freeze({
  descriptor: Object.freeze({
    defaultWindow: Object.freeze({
      mode: "floating",
      rect: Object.freeze({
        height: 680,
        width: 1040,
        x: 96,
        y: 72,
      }),
    }),
    id: MAIL_APP_ID,
    runtime: Object.freeze({
      partition: MAIL_APP_PARTITION,
      url: MAIL_APP_ENTRY,
    }),
    surfaceKind: "web",
    title: "Mail",
  }),
  manifest: Object.freeze({
    capabilityGrants: Object.freeze([]),
    entry: MAIL_APP_ENTRY,
    id: MAIL_APP_ID,
    sdkVersion: SDK_VERSION,
    version: "1.0.0",
  }),
}));

export default mailAppPackage;
