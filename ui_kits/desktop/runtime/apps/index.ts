// App registry — the dock launch path resolves an appId to a VitaApp here. Every app routes through
// the window manager (a managed window) and the host bridge; none render hard-coded light.
//
// Phase B: Terminal, Editor, Mail, Browser, and Settings are now REAL, dedicated dark VitaApps backed
// by the desktop app view-models (a terminal surface, a file editor with save, a two-pane mailbox, a
// navigable offline browser, and a sectioned settings panel). Files + Activity were already real. The
// generic createFileListApp factory is retained for any future thin path but is no longer the backing
// for the first-party set.

import {
  activityApp,
} from "./activity.ts";
import {
  browserApp,
} from "./browser.ts";
import {
  createFileListApp,
} from "./file-list-app.ts";
import {
  editorApp,
} from "./editor.ts";
import {
  filesApp,
} from "./files.ts";
import {
  mailApp,
} from "./mail.ts";
import {
  settingsApp,
} from "./settings.ts";
import {
  terminalApp,
} from "./terminal.ts";
import type {
  VitaApp,
} from "../app-sdk.ts";

// The full first-party app set keyed by the dock/launch appId (see viewmodels/dock.ts INDEX_DOCK_APP_IDS).
export const BUILTIN_APPS: readonly VitaApp[] = Object.freeze([
  filesApp,
  activityApp,
  settingsApp,
  browserApp,
  mailApp,
  editorApp,
  terminalApp,
]);

export function builtinAppRegistry(): ReadonlyMap<string, VitaApp> {
  const registry = new Map<string, VitaApp>();

  for (const app of BUILTIN_APPS) registry.set(app.manifest.id, app);

  return registry;
}

export {
  activityApp,
  browserApp,
  createFileListApp,
  editorApp,
  filesApp,
  mailApp,
  settingsApp,
  terminalApp,
};
