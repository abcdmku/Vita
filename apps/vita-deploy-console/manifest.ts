import {
  SDK_VERSION,
  defineAppPackage,
} from "../../sdk/typescript/src/desktop-sdk/index.ts";
import type { AppPackage } from "../../sdk/typescript/src/desktop-sdk/index.ts";

// The Vita Deploy / Management Console — the FIRST real app on the platform and the node's interactive
// admin UI. A real Puter web app (uses the vendored puter.js SDK) that manages the node's capsules via
// the capability-gated control-plane bridge (/control/*). It is the ONLY app granted the `control`
// capability (default-deny everywhere else).

export const DEPLOY_CONSOLE_APP_ID = "vita.app.deploy-console";
export const DEPLOY_CONSOLE_APP_VERSION = "1.0.0";
export const DEPLOY_CONSOLE_APP_ENTRY = "index.html";
export const DEPLOY_CONSOLE_APP_PARTITION = "vita-app-deploy-console";

export const deployConsoleAppPackage: AppPackage = defineAppPackage(Object.freeze({
  descriptor: Object.freeze({
    defaultWindow: Object.freeze({
      className: "vita-deploy-console-window",
      mode: "floating",
      rect: Object.freeze({
        height: 680,
        width: 980,
        x: 160,
        y: 72,
      }),
      zone: "center",
    }),
    id: DEPLOY_CONSOLE_APP_ID,
    runtime: Object.freeze({
      partition: DEPLOY_CONSOLE_APP_PARTITION,
      url: DEPLOY_CONSOLE_APP_ENTRY,
    }),
    surfaceKind: "web",
    title: "Vita Console",
  }),
  manifest: Object.freeze({
    // `capabilityGrants` here is the DESKTOP host-bridge capability set (apps.launch / files.* /
    // settings.* …) — a different namespace from the puter api_origin grants. The console uses NONE of
    // the desktop host-bridge caps, so this is empty (like the other web apps).
    //
    // The PUTER api_origin grants the console needs — `control` (list/start/stop/status/logs), `auth`
    // (owner identity), `kv.read`/`kv.write` (UI prefs) — are NOT declared here. They are minted into
    // the app's launch session by the launcher/host (`capabilities.mintAppSession({ grants: [...] })`,
    // see ui_kits/desktop/runtime/puter/capability.ts). The console is the ONLY app minted `control`.
    // See PUTER_API_ORIGIN_GRANTS below for the authoritative list.
    capabilityGrants: Object.freeze([]),
    entry: DEPLOY_CONSOLE_APP_ENTRY,
    id: DEPLOY_CONSOLE_APP_ID,
    sdkVersion: SDK_VERSION,
    version: DEPLOY_CONSOLE_APP_VERSION,
  }),
}));

// The puter api_origin grants the host mints into this app's launch session (see the manifest note
// above). Exported so the launcher / harness has a single authoritative source for what the console is
// allowed to do on the data + control planes.
export const PUTER_API_ORIGIN_GRANTS = Object.freeze([
  "control",
  "auth",
  "kv.read",
  "kv.write",
] as const);

export default deployConsoleAppPackage;
