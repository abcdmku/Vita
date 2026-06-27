// Vita multi-window shell — the APP REGISTRY (the single source of truth the launcher + dock read,
// and the service mints per-app sessions from).
//
// The shell turns the single full-screen Vita Desk into a real multi-window desktop: every app —
// Vita's own (Vita Desk, the deploy console) AND real third-party Puter apps (serverless-todo,
// notepad) — is an entry here. The launcher renders one tile per entry; clicking it opens (or
// focuses) a managed WM window hosting the app's sandboxed iframe; the dock/taskbar lists open
// windows. The SERVICE side reads the SAME registry to pre-mint a capability session per app and
// expose the {appId → token/instance} map to the shell via /shell-session.js.
//
// Pure data + tiny helpers, no DOM / no node. Shared by the browser shell bundle AND the node
// service, so it carries neither a DOM nor a node dependency. House style: structural, frozen,
// strict.

import type { PuterCapability } from "../capability.ts";

// How an app is hosted in a shell window.
//   - "webapp": a sandboxed <iframe> loading `entry` with the puter.* launch params + a minted token.
//     This covers BOTH Vita's own iframe apps (Vita Desk, deploy console) and third-party Puter apps.
//   - "builtin": reserved for a future in-process native surface (not an iframe). Unused today; kept
//     so the union is honest about the design space without pretending a second path exists yet.
export type ShellAppKind = "webapp" | "builtin";

// Whether an app is Vita's own code or an unmodified third party (drives the launcher badge + the
// licensing note). NOT a trust boundary — the capability grants below are the trust boundary.
export type ShellAppOrigin = "vita" | "third-party";

export interface ShellAppEntry {
  // Stable id — the WM registry key (one window per id) AND the appId the capability session is
  // minted for. Reverse-DNS-ish, matches the on-device app id convention.
  readonly id: string;
  readonly title: string;
  // A single emoji/glyph used as the launcher + window-chrome icon (the WM renders it inline).
  readonly icon: string;
  // One-line description shown in the launcher tile.
  readonly description: string;
  readonly kind: ShellAppKind;
  readonly origin: ShellAppOrigin;
  // The iframe entry URL (relative to the shell origin). For webapp kind only.
  readonly entry: string;
  // The capabilities this app's session is granted. The launcher does NOT widen these; the service
  // mints EXACTLY this set (default-deny on anything absent). `control` is held only by the console.
  readonly grants: readonly PuterCapability[];
  // Open this app automatically when the shell boots. Default OFF for every app — the shell boots to
  // a clean desktop and the user launches apps from the dock. Kept in the type so an embedder can opt
  // a kiosk-style single-app build back in, but no default app sets it.
  readonly autostart?: boolean;
  // Initial window size hint (px). The WM falls back to its default rect when absent.
  readonly window?: { readonly width: number; readonly height: number };
  // SPDX-ish license label + attribution shown in the launcher for third-party apps (provenance).
  readonly license?: string;
}

// The full surface a typical Puter/Vita app needs against the local api_origin.
const FULL_GRANTS: readonly PuterCapability[] = Object.freeze([
  "fs.read",
  "fs.write",
  "kv.read",
  "kv.write",
  "ui",
  "auth",
]);

// The deploy console additionally holds `control` (the only app that does — default-deny elsewhere).
const CONSOLE_GRANTS: readonly PuterCapability[] = Object.freeze([...FULL_GRANTS, "control"]);

// The Package Manager additionally holds `meta` (the ONLY app that does — the control plane for
// permissions; default-deny elsewhere). It reads/edits package source + alters per-package grants.
const PKGMGR_GRANTS: readonly PuterCapability[] = Object.freeze([...FULL_GRANTS, "meta"]);

// The Terminal additionally holds `exec` (the ONLY app that does — opens the /pty websocket to run a
// real command in a hardened capsule; the MOST privileged compat capability; default-deny elsewhere).
const TERMINAL_GRANTS: readonly PuterCapability[] = Object.freeze([...FULL_GRANTS, "exec"]);

// The default shell catalog. Two Vita apps (Vita Desk + deploy console) and two real, unmodified
// third-party Puter apps (serverless-todo, notepad). Ordering = launcher order.
export const DEFAULT_SHELL_APPS: readonly ShellAppEntry[] = Object.freeze([
  Object.freeze({
    // No autostart: the shell boots to a CLEAN desktop (wallpaper + system bar + dock). The user
    // launches Vita Desk (and everything else) from the dock launcher. Auto-opening an app made the
    // desktop read as "a random app is open with no system bar/taskbar" (see feat/vita-shell-polish).
    description: "Files, notes, and KV-backed settings — Vita's own desk.",
    entry: "/kiosk-entry.html",
    grants: FULL_GRANTS,
    icon: "🗂️",
    id: "vita.desk",
    kind: "webapp",
    origin: "vita",
    title: "Vita Desk",
    window: { height: 560, width: 760 },
  }),
  Object.freeze({
    description: "List, start, stop, and tail capsules on this node (control plane).",
    entry: "/console/index.html",
    grants: CONSOLE_GRANTS,
    icon: "🛰️",
    id: "vita.app.deploy-console",
    kind: "webapp",
    origin: "vita",
    title: "Deploy Console",
    window: { height: 520, width: 720 },
  }),
  Object.freeze({
    description: "A real third-party Puter app — cloud-synced todos over puter.kv.",
    entry: "/apps/serverless-todo/index.html",
    grants: FULL_GRANTS,
    icon: "✅",
    id: "com.puter-apps.serverless-todo",
    kind: "webapp",
    license: "MIT — © Puter Technologies Inc. (Puter-Apps/serverless-todo)",
    origin: "third-party",
    title: "Serverless Todo",
    window: { height: 600, width: 540 },
  }),
  Object.freeze({
    description: "A real third-party Puter app — text editor using puter.ui + puter.fs.",
    entry: "/apps/notepad/index.html",
    grants: FULL_GRANTS,
    icon: "📝",
    id: "com.puter-apps.notepad",
    kind: "webapp",
    license: "MIT — © Puter Technologies Inc. (Puter-Apps/notepad)",
    origin: "third-party",
    title: "Notepad",
    window: { height: 480, width: 640 },
  }),
  Object.freeze({
    description: "A real terminal on the node — runs commands in a hardened capsule over /pty (exec).",
    entry: "/apps/terminal/index.html",
    grants: TERMINAL_GRANTS,
    icon: "⌨️",
    id: "vita.app.terminal",
    kind: "webapp",
    origin: "vita",
    title: "Terminal",
    window: { height: 480, width: 720 },
  }),
  Object.freeze({
    description: "Inspect + edit installed package source and alter per-package permissions (meta).",
    entry: "/pkgmgr-app/index.html",
    grants: PKGMGR_GRANTS,
    icon: "📦",
    id: "vita.app.package-manager",
    kind: "webapp",
    origin: "vita",
    title: "Package Manager",
    window: { height: 560, width: 820 },
  }),
  Object.freeze({
    description: "Vita Code — open, edit, and save files through puter.fs (the dev-loop editor).",
    entry: "/editor/index.html",
    grants: FULL_GRANTS,
    icon: "✏️",
    id: "vita.app.editor",
    kind: "webapp",
    origin: "vita",
    title: "Vita Code",
    window: { height: 600, width: 860 },
  }),
]);

// Look an entry up by id. Pure.
export function findShellApp(apps: readonly ShellAppEntry[], id: string): ShellAppEntry | undefined {
  return apps.find((a) => a.id === id);
}

// The minted-session record the service hands the shell per app (so the iframe authenticates to the
// api_origin). Mirrors what /session.js does for the single kiosk app, but keyed by appId.
export interface ShellAppSession {
  readonly appId: string;
  readonly instanceId: string;
  readonly token: string;
}

// The payload /shell-session.js publishes to the browser: the api prefix + the per-app sessions.
// The shell reads `window.__vitaShell` and, for each registry app, uses its session token/instance.
export interface ShellSessionPayload {
  readonly apiOrigin: string;
  readonly sessions: Readonly<Record<string, ShellAppSession>>;
}
