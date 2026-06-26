// App registry — the dock launch path resolves an appId to a VitaApp here. Every app routes through
// the window manager (a managed window) and the host bridge; none render hard-coded light anymore.

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
  filesApp,
} from "./files.ts";
import {
  settingsApp,
} from "./settings.ts";
import type {
  VitaApp,
} from "../app-sdk.ts";

// Thin generic apps (live listing of a fixed path) until they grow real backends.
const mailApp = createFileListApp({
  icon: "✉️",
  id: "vita.app.mail",
  label: "Mail",
  path: "/mail",
  title: "Mail",
});

const editorApp = createFileListApp({
  icon: "📝",
  id: "vita.app.code",
  label: "Editor",
  path: "/editor",
  title: "Editor",
});

const terminalApp = createFileListApp({
  icon: "⌨️",
  id: "vita.app.terminal",
  label: "Terminal — workspace",
  path: "/",
  title: "Terminal",
});

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
