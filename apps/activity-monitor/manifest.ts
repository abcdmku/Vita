import {
  SDK_VERSION,
  defineAppPackage,
} from "../../sdk/typescript/src/desktop-sdk/index.ts";
import type { AppPackage } from "../../sdk/typescript/src/desktop-sdk/index.ts";

export const ACTIVITY_MONITOR_APP_ID = "vita.app.activity-monitor";
export const ACTIVITY_MONITOR_APP_VERSION = "1.0.0";
export const ACTIVITY_MONITOR_APP_ENTRY = "index.html";
export const ACTIVITY_MONITOR_APP_PARTITION = "vita-app-activity-monitor";

export const activityMonitorAppPackage: AppPackage = defineAppPackage(Object.freeze({
  descriptor: Object.freeze({
    defaultWindow: Object.freeze({
      className: "vita-activity-monitor-window",
      mode: "floating",
      rect: Object.freeze({
        height: 600,
        width: 880,
        x: 200,
        y: 84,
      }),
      zone: "center",
    }),
    id: ACTIVITY_MONITOR_APP_ID,
    runtime: Object.freeze({
      partition: ACTIVITY_MONITOR_APP_PARTITION,
      url: ACTIVITY_MONITOR_APP_ENTRY,
    }),
    surfaceKind: "web",
    title: "Activity Monitor",
  }),
  manifest: Object.freeze({
    capabilityGrants: Object.freeze([]),
    entry: ACTIVITY_MONITOR_APP_ENTRY,
    id: ACTIVITY_MONITOR_APP_ID,
    sdkVersion: SDK_VERSION,
    version: ACTIVITY_MONITOR_APP_VERSION,
  }),
}));

export default activityMonitorAppPackage;
