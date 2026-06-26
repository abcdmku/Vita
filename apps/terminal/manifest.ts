import {
  SDK_VERSION,
  defineAppPackage,
} from "../../sdk/typescript/src/desktop-sdk/index.ts";
import type { AppPackage } from "../../sdk/typescript/src/desktop-sdk/index.ts";

export const TERMINAL_APP_ID = "vita.app.terminal";
export const TERMINAL_APP_ENTRY = "index.html";
export const TERMINAL_APP_PARTITION = "vita-app-terminal";

export const terminalAppPackage: AppPackage = defineAppPackage({
  descriptor: {
    defaultWindow: {
      className: "vita-terminal-window",
      mode: "floating",
      rect: {
        height: 520,
        width: 760,
        x: 112,
        y: 84,
      },
      zone: "center",
    },
    id: TERMINAL_APP_ID,
    runtime: {
      partition: TERMINAL_APP_PARTITION,
      url: TERMINAL_APP_ENTRY,
    },
    surfaceKind: "web",
    title: "Terminal",
  },
  manifest: {
    capabilityGrants: Object.freeze([]),
    entry: TERMINAL_APP_ENTRY,
    id: TERMINAL_APP_ID,
    sdkVersion: SDK_VERSION,
    version: "1.0.0",
  },
});

export default terminalAppPackage;
