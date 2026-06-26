import {
  SDK_VERSION,
  defineAppPackage,
} from "../../sdk/typescript/src/desktop-sdk/index.ts";
import type {
  AppPackage,
} from "../../sdk/typescript/src/desktop-sdk/index.ts";

export const TEXT_EDITOR_APP_ID = "vita.app.editor";
export const TEXT_EDITOR_APP_VERSION = "1.0.0";
export const TEXT_EDITOR_APP_ENTRY = "index.html";
export const TEXT_EDITOR_APP_PARTITION = "vita-app-editor";

export const textEditorAppPackage: AppPackage = defineAppPackage(Object.freeze({
  descriptor: Object.freeze({
    defaultWindow: Object.freeze({
      className: "vita-app-editor",
      mode: "floating",
      rect: Object.freeze({
        height: 640,
        width: 880,
        x: 160,
        y: 96,
      }),
    }),
    id: TEXT_EDITOR_APP_ID,
    runtime: Object.freeze({
      partition: TEXT_EDITOR_APP_PARTITION,
      url: TEXT_EDITOR_APP_ENTRY,
    }),
    surfaceKind: "web",
    title: "Text Editor",
  }),
  manifest: Object.freeze({
    capabilityGrants: Object.freeze([
      Object.freeze({
        capability: "files.read",
      }),
      Object.freeze({
        capability: "files.write",
      }),
    ]),
    entry: TEXT_EDITOR_APP_ENTRY,
    id: TEXT_EDITOR_APP_ID,
    sdkVersion: SDK_VERSION,
    version: TEXT_EDITOR_APP_VERSION,
  }),
}));

export default textEditorAppPackage;
