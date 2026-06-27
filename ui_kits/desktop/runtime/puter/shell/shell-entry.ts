// Vita multi-window shell — the BROWSER ENTRY (served at the kiosk URL).
//
// This turns the single full-screen Vita Desk into a real multi-window desktop. It composes the
// EXISTING, verified compat pieces and adds the missing shell glue:
//   - createWindowManager()      → real managed windows (drag/resize/close/focus/z-order/min/max)
//   - createUiBroker()           → the puter.ui.* postMessage parent (alert/setWindowTitle/launchApp…)
//   - createWebAppWindowHost()   → mount an app's sandboxed iframe (with launch params + token) into a
//                                  managed window, and round-trip the broker to THAT window
//   - app-registry.ts            → the catalog the launcher renders + the per-app sessions to use
// plus, NEW here:
//   - a DOCK / TASKBAR           → one tile per OPEN window (click = focus/restore) + a launcher button
//   - an APP LAUNCHER overlay     → one tile per REGISTRY app (click = launchOrFocus its window)
//   - a MENUBAR                  → brand + live clock + "open N windows" status
//
// Sessions: the service pre-mints a capability session per registry app and publishes them to the
// page as `window.__vitaShell = { apiOrigin, sessions }` (via /shell-session.js, like /session.js but
// keyed by appId). The shell hands each app its own token+instance when it opens the window, so each
// iframe authenticates to the LOCAL api_origin independently. No app's token is shared with another.
//
// Browser-only (loaded as a module by shell.html, deno-bundled to shell.js). No node imports. DOM is
// modelled structurally (house style) so the file typechecks under the spike tsconfig and stays
// portable; at runtime the real document/window satisfy the interfaces.

import { createCapabilityRegistry } from "../capability.ts";
import type { PuterCapabilityRegistry } from "../capability.ts";
import { createUiBroker } from "../ui-broker.ts";
import type { BrokerNotificationInput, BrokerSinks, BrokerWindow } from "../ui-broker.ts";
import { createWebAppWindowHost, setWebAppWindowTitle } from "../web-app-window.ts";
import type { WebAppWindowHost } from "../web-app-window.ts";
import { createWindowManager } from "../../window-manager.ts";
import type { WindowManager, WmDocument, WmElement } from "../../window-manager.ts";
import {
  DEFAULT_SHELL_APPS,
  findShellApp,
  type ShellAppEntry,
  type ShellAppSession,
  type ShellSessionPayload,
} from "./app-registry.ts";

// ---------------------------------------------------------------------------------------------
// Structural browser globals (no DOM lib reliance for the bits the WM/broker don't already model).
// ---------------------------------------------------------------------------------------------

interface ShellGlobals {
  readonly document: WmDocument & {
    getElementById(id: string): WmElement | null;
    createElement(tag: string): WmElement;
  };
  readonly location: { readonly origin: string };
  readonly __vitaShell?: Partial<ShellSessionPayload>;
}

// ---------------------------------------------------------------------------------------------
// Shell controller.
// ---------------------------------------------------------------------------------------------

export interface ShellController {
  readonly wm: WindowManager;
  readonly host: WebAppWindowHost;
  readonly apps: readonly ShellAppEntry[];
  // Open (or focus) a registry app's window. Returns the appId, or undefined if unknown.
  launch(appId: string): string | undefined;
  // Re-render the dock/taskbar (open-window tiles + active highlight). Called on every WM change.
  refreshDock(): void;
}

export interface ShellDeps {
  readonly g: ShellGlobals;
  // Override the registry (tests); defaults to DEFAULT_SHELL_APPS.
  readonly apps?: readonly ShellAppEntry[];
  // Override the api origin (defaults to the published session payload or `${origin}/api`).
  readonly apiOrigin?: string;
}

// Mount the whole shell into the live page. Idempotent-ish: call once on boot. Returns the controller
// (handy for tests / the verification driver to introspect open windows).
export function bootShell(deps: ShellDeps): ShellController {
  const { g } = deps;
  const doc = g.document;
  const origin = g.location.origin;
  const published = g.__vitaShell ?? {};
  const apiOrigin = deps.apiOrigin ?? published.apiOrigin ?? `${origin}/api`;
  const apps = deps.apps ?? DEFAULT_SHELL_APPS;
  const sessions: Readonly<Record<string, ShellAppSession>> = published.sessions ?? {};

  const wm = createWindowManager(doc);
  const capabilities: PuterCapabilityRegistry = createCapabilityRegistry();
  // instance id → WM appId, so ui.setWindowTitle / notifications target the right window.
  const instanceToAppId = new Map<string, string>();

  const sinks: BrokerSinks = {
    async alert(instanceId, message, buttons): Promise<string> {
      return showAlert(doc, instanceToAppId.get(instanceId) ?? instanceId, message, buttons);
    },
    createWindow(instanceId, options): string {
      // Minimal createWindow: open a generic child window in the WM seeded with the app's content.
      const childId = `child.${instanceId}.${childSeq()}`;
      const seed = {
        body: options.content ?? "<div style=\"padding:16px;color:var(--text-faint)\">(child window)</div>",
        icon: "🪟",
        title: options.title ?? "Window",
      };

      wm.launchOrFocus(childId, seed);
      refreshDock();
      return childId;
    },
    launchApp(_instanceId, appName, _args): void {
      // An app asked to launch another app by name. Map the puter app name to a registry id if we can.
      const target = resolveLaunchTarget(apps, appName);

      if (target !== undefined) launch(target);
      else notify(doc, { appId: appName, message: `launchApp: ${appName} (not in shell catalog)` });
    },
    async prompt(instanceId, message, placeholder): Promise<string | null> {
      return showPrompt(doc, instanceToAppId.get(instanceId) ?? instanceId, message, placeholder);
    },
    setWindowTitle(instanceId, title): void {
      setWebAppWindowTitle(wm, instanceToAppId.get(instanceId), title);
      refreshDock();
    },
    showNotification(instanceId, input: BrokerNotificationInput): void {
      notify(doc, { appId: instanceToAppId.get(instanceId) ?? instanceId, message: input.message, ...(input.title === undefined ? {} : { title: input.title }) });
    },
  };

  const broker = createUiBroker({ capabilities, sinks, window: g as unknown as BrokerWindow });

  broker.start();

  const host = createWebAppWindowHost({
    apiOrigin,
    broker,
    capabilities,
    doc,
    guiOrigin: origin,
    wm,
  });

  function launch(appId: string): string | undefined {
    const app = findShellApp(apps, appId);

    if (app === undefined) return undefined;

    const session = sessions[appId];
    const handle = host.open({
      appId: app.id,
      appUrl: app.entry,
      icon: app.icon,
      title: app.title,
      grants: app.grants,
      ...(session?.token === undefined ? {} : { token: session.token }),
      ...(session?.instanceId === undefined ? {} : { appInstanceId: session.instanceId }),
    });

    instanceToAppId.set(handle.appInstanceId, handle.appId);
    applyWindowSize(wm, app);
    refreshDock();
    return app.id;
  }

  // ----- dock / taskbar + launcher chrome -----

  const chrome = mountChrome(doc, apps, {
    onLaunch: launch,
    openWindowIds: () => wm.windows.filter((w) => w.isOpen).map((w) => w.appId),
    focus: (appId) => {
      wm.get(appId)?.focus();
      refreshDock();
    },
    titleFor: (appId) => findShellApp(apps, appId)?.title ?? appId,
    iconFor: (appId) => findShellApp(apps, appId)?.icon ?? "🪟",
  });

  function refreshDock(): void {
    chrome.refresh();
  }

  // ----- boot: autostart apps, render dock, start the clock -----

  for (const app of apps) {
    if (app.autostart === true) launch(app.id);
  }

  refreshDock();
  chrome.startClock();

  const controller: ShellController = Object.freeze({
    apps,
    host,
    launch,
    refreshDock,
    wm,
  });

  // Expose for the verification driver + manual debugging.
  (g as unknown as { __vitaShellController?: ShellController }).__vitaShellController = controller;
  (g as unknown as { __vitaShellReady?: boolean }).__vitaShellReady = true;

  return controller;
}

// ---------------------------------------------------------------------------------------------
// Dock / taskbar + launcher overlay. Reuses kit.css classes (.v-dock/.v-dtile/.v-palette) so it
// inherits the dark theme. Built with structural DOM ops.
// ---------------------------------------------------------------------------------------------

interface ChromeCallbacks {
  onLaunch(appId: string): string | undefined;
  openWindowIds(): readonly string[];
  focus(appId: string): void;
  titleFor(appId: string): string;
  iconFor(appId: string): string;
}

interface ShellChrome {
  refresh(): void;
  startClock(): void;
}

function mountChrome(
  doc: ShellGlobals["document"],
  apps: readonly ShellAppEntry[],
  cb: ChromeCallbacks,
): ShellChrome {
  const screen = doc.querySelector?.(".v-screen") ?? doc.body;

  // ----- menubar (brand + status + clock) -----
  const menubar = doc.createElement("div");

  menubar.classList.add("v-menubar");
  menubar.innerHTML =
    `<div style="display:flex;align-items:center;gap:18px">` +
    `<span class="v-brand">Vita<i>.ts</i></span>` +
    `<div class="v-menus"><span data-shell-status>Desktop</span></div></div>` +
    `<div class="v-status"><span class="clk" data-shell-clock>--:--</span></div>`;
  screen?.appendChild(menubar);

  const status = safeQuery(menubar, "[data-shell-status]");
  const clock = safeQuery(menubar, "[data-shell-clock]");

  // ----- launcher overlay (one tile per registry app) -----
  const scrim = doc.createElement("div");

  scrim.setAttribute("data-shell-launcher", "");
  // z-index must sit ABOVE managed windows (which climb from Z_BASE=70 as they're focused), or an open
  // window would overlay the launcher and swallow tile clicks. 9000 keeps it under modals (90 is the
  // per-window modal scrim, but those are scoped; the launcher is a top-level overlay).
  scrim.style.cssText =
    "position:absolute;inset:0;z-index:9000;display:none;background:rgba(5,7,10,.46);" +
    "align-items:center;justify-content:center";

  const palette = doc.createElement("div");

  palette.style.cssText =
    "width:560px;max-width:88vw;background:var(--surface-overlay,#15171d);border:1px solid var(--border,#262a33);" +
    "border-radius:16px;box-shadow:var(--shadow-popover);padding:18px 18px 22px;color:var(--text,#e6e8ee)";
  palette.innerHTML = `<div style="font:600 14px system-ui;margin:2px 4px 14px">Applications</div>` +
    `<div data-shell-grid style="display:grid;grid-template-columns:repeat(3,1fr);gap:12px"></div>`;
  scrim.appendChild(palette);
  screen?.appendChild(scrim);

  const grid = safeQuery(palette, "[data-shell-grid]");

  // Close the launcher on a scrim (background) click.
  scrim.addEventListener("click", ((event: { target?: unknown }) => {
    if (event.target === scrim) toggleLauncher(false);
  }) as never);

  for (const app of apps) {
    const tile = doc.createElement("div");

    tile.setAttribute("data-shell-app", app.id);
    tile.style.cssText =
      "display:flex;flex-direction:column;gap:7px;padding:13px 12px;border-radius:12px;cursor:pointer;" +
      "background:var(--surface,#0e0f13);border:1px solid var(--border,#262a33)";
    const badge = app.origin === "third-party"
      ? `<span style="font:10px ui-monospace,monospace;color:var(--accent,#5b9dff)">3rd-party</span>`
      : `<span style="font:10px ui-monospace,monospace;color:var(--text-faint,#8b8f9c)">vita</span>`;

    tile.innerHTML =
      `<div style="display:flex;align-items:center;justify-content:space-between">` +
      `<span style="font-size:24px">${app.icon}</span>${badge}</div>` +
      `<div style="font:600 13px system-ui">${escapeHtml(app.title)}</div>` +
      `<div style="font:11.5px system-ui;color:var(--text-faint,#8b8f9c);line-height:1.4">${escapeHtml(app.description)}</div>` +
      (app.license === undefined ? "" : `<div style="font:10px ui-monospace,monospace;color:var(--text-faint,#6c707b);margin-top:2px">${escapeHtml(app.license)}</div>`);
    tile.addEventListener("click", (() => {
      cb.onLaunch(app.id);
      toggleLauncher(false);
    }) as never);
    grid?.appendChild(tile);
  }

  // ----- dock (launcher button + one tile per OPEN window) -----
  const dock = doc.createElement("div");

  dock.classList.add("v-dock");
  dock.setAttribute("data-shell-dock", "");
  screen?.appendChild(dock);

  let launcherOpen = false;

  function toggleLauncher(force?: boolean): void {
    launcherOpen = force ?? !launcherOpen;
    scrim.style.setProperty("display", launcherOpen ? "flex" : "none");
  }

  function refresh(): void {
    dock.innerHTML = "";

    // Launcher button (always first).
    const launcherBtn = doc.createElement("div");

    launcherBtn.classList.add("v-dtile");
    launcherBtn.setAttribute("data-shell-launcher-btn", "");
    launcherBtn.setAttribute("title", "Applications");
    launcherBtn.style.setProperty("font-size", "22px");
    launcherBtn.textContent = "⊞";
    launcherBtn.addEventListener("click", (() => toggleLauncher()) as never);
    dock.appendChild(launcherBtn);

    // Separator.
    const sep = doc.createElement("div");

    sep.style.cssText = "width:1px;height:30px;background:var(--border,#262a33);margin:0 2px;align-self:center";
    dock.appendChild(sep);

    // One tile per open window.
    const open = cb.openWindowIds();

    for (const appId of open) {
      const tile = doc.createElement("div");

      tile.classList.add("v-dtile", "on");
      tile.setAttribute("data-shell-dock-tile", appId);
      tile.setAttribute("title", cb.titleFor(appId));
      tile.style.setProperty("font-size", "22px");
      tile.textContent = cb.iconFor(appId);
      tile.addEventListener("click", (() => cb.focus(appId)) as never);
      dock.appendChild(tile);
    }

    if (status !== null) status.textContent = open.length === 0 ? "Desktop" : `${open.length} window${open.length === 1 ? "" : "s"} open`;
  }

  function startClock(): void {
    const tick = (): void => {
      if (clock === null) return;
      const now = new Date();
      const hh = now.getHours().toString().padStart(2, "0");
      const mm = now.getMinutes().toString().padStart(2, "0");

      clock.textContent = `${hh}:${mm}`;
    };

    tick();
    const g = globalThis as { setInterval?: (fn: () => void, ms: number) => unknown };

    g.setInterval?.(tick, 30000);
  }

  return Object.freeze({ refresh, startClock });
}

// ---------------------------------------------------------------------------------------------
// In-page dialogs (ui.alert / ui.prompt) + notifications. Themed, structural DOM. The broker awaits
// these so the SDK's pending promise resolves with the chosen value.
// ---------------------------------------------------------------------------------------------

function showAlert(
  doc: ShellGlobals["document"],
  appLabel: string,
  message: string,
  buttons: readonly { readonly label: string; readonly value?: string; readonly type?: string }[] | undefined,
): Promise<string> {
  const choices = buttons !== undefined && buttons.length > 0
    ? buttons
    : [{ label: "OK", value: "OK", type: "primary" }];

  return new Promise<string>((resolve) => {
    const { scrim, close } = openModal(doc);
    const card = doc.createElement("div");

    card.style.cssText = modalCardCss();
    card.innerHTML =
      `<div style="font:600 12px ui-monospace,monospace;color:var(--text-faint,#8b8f9c);margin-bottom:6px">${escapeHtml(appLabel)}</div>` +
      `<div style="font:13.5px system-ui;line-height:1.5;margin-bottom:16px">${escapeHtml(message)}</div>` +
      `<div data-modal-actions style="display:flex;gap:8px;justify-content:flex-end"></div>`;
    const actions = safeQuery(card, "[data-modal-actions]");

    for (const b of choices) {
      const btn = doc.createElement("button");
      const accent = b.type === "primary" || b.type === "danger";

      btn.style.cssText =
        "font:13px system-ui;padding:7px 14px;border-radius:8px;cursor:pointer;border:1px solid " +
        (accent ? "transparent" : "var(--border,#262a33)") + ";" +
        (b.type === "danger" ? "background:#e0524a;color:#fff" : accent ? "background:var(--accent,#5b9dff);color:#0a0c10" : "background:var(--surface,#0e0f13);color:var(--text,#e6e8ee)");
      btn.textContent = b.label;
      btn.addEventListener("click", (() => {
        close();
        resolve(b.value ?? b.label);
      }) as never);
      actions?.appendChild(btn);
    }

    scrim.appendChild(card);
  });
}

function showPrompt(
  doc: ShellGlobals["document"],
  appLabel: string,
  message: string,
  placeholder: string | undefined,
): Promise<string | null> {
  return new Promise<string | null>((resolve) => {
    const { scrim, close } = openModal(doc);
    const card = doc.createElement("div");

    card.style.cssText = modalCardCss();
    card.innerHTML =
      `<div style="font:600 12px ui-monospace,monospace;color:var(--text-faint,#8b8f9c);margin-bottom:6px">${escapeHtml(appLabel)}</div>` +
      `<div style="font:13.5px system-ui;line-height:1.5;margin-bottom:10px">${escapeHtml(message)}</div>` +
      `<input data-modal-input placeholder="${escapeHtml(placeholder ?? "")}" style="width:100%;box-sizing:border-box;font:13px system-ui;padding:8px 10px;border-radius:8px;border:1px solid var(--border,#262a33);background:var(--surface,#0e0f13);color:var(--text,#e6e8ee);margin-bottom:14px" />` +
      `<div style="display:flex;gap:8px;justify-content:flex-end">` +
      `<button data-modal-cancel style="font:13px system-ui;padding:7px 14px;border-radius:8px;cursor:pointer;border:1px solid var(--border,#262a33);background:var(--surface,#0e0f13);color:var(--text,#e6e8ee)">Cancel</button>` +
      `<button data-modal-ok style="font:13px system-ui;padding:7px 14px;border-radius:8px;cursor:pointer;border:1px solid transparent;background:var(--accent,#5b9dff);color:#0a0c10">OK</button></div>`;
    const input = safeQuery(card, "[data-modal-input]") as (WmElement & { value?: string }) | null;
    const ok = safeQuery(card, "[data-modal-ok]");
    const cancel = safeQuery(card, "[data-modal-cancel]");

    ok?.addEventListener("click", (() => {
      const value = input?.value ?? "";

      close();
      resolve(value);
    }) as never);
    cancel?.addEventListener("click", (() => {
      close();
      resolve(null);
    }) as never);
    scrim.appendChild(card);
  });
}

function openModal(doc: ShellGlobals["document"]): { scrim: WmElement; close: () => void } {
  const screen = doc.querySelector?.(".v-screen") ?? doc.body;
  const scrim = doc.createElement("div");

  scrim.style.cssText =
    "position:absolute;inset:0;z-index:9500;display:flex;align-items:center;justify-content:center;background:rgba(5,7,10,.5)";
  screen?.appendChild(scrim);

  return {
    scrim,
    close: () => {
      try {
        scrim.remove?.();
      } catch {
        // ignore
      }
    },
  };
}

function modalCardCss(): string {
  return "width:380px;max-width:86vw;background:var(--surface-raised,#15171d);border:1px solid var(--border,#262a33);border-radius:14px;box-shadow:var(--shadow-popover);padding:18px 18px 16px";
}

let NOTIF_SEQ = 0;

function notify(doc: ShellGlobals["document"], input: { appId: string; title?: string; message: string }): void {
  const screen = doc.querySelector?.(".v-screen") ?? doc.body;
  let stack = doc.getElementById("vita-shell-toasts");

  if (stack === null) {
    stack = doc.createElement("div");
    stack.id = "vita-shell-toasts";
    stack.style.cssText = "position:absolute;top:44px;right:16px;z-index:9400;display:flex;flex-direction:column;gap:8px;width:280px";
    screen?.appendChild(stack);
  }

  const toast = doc.createElement("div");

  NOTIF_SEQ += 1;
  toast.setAttribute("data-shell-toast", String(NOTIF_SEQ));
  toast.style.cssText = "background:var(--surface-overlay,#15171d);border:1px solid var(--border,#262a33);border-radius:10px;padding:10px 12px;box-shadow:var(--shadow-2);color:var(--text,#e6e8ee)";
  toast.innerHTML =
    (input.title === undefined ? "" : `<div style="font:600 12.5px system-ui;margin-bottom:2px">${escapeHtml(input.title)}</div>`) +
    `<div style="font:12px system-ui;color:var(--text-secondary,#c7cad3);line-height:1.4">${escapeHtml(input.message)}</div>`;
  stack.appendChild(toast);

  const g = globalThis as { setTimeout?: (fn: () => void, ms: number) => unknown };

  g.setTimeout?.(() => {
    try {
      toast.remove?.();
    } catch {
      // ignore
    }
  }, 4200);
}

// ---------------------------------------------------------------------------------------------
// Helpers.
// ---------------------------------------------------------------------------------------------

function applyWindowSize(wm: WindowManager, app: ShellAppEntry): void {
  if (app.window === undefined) return;

  const handle = wm.get(app.id);

  if (handle === undefined) return;

  try {
    handle.element.style.setProperty("width", `${app.window.width}px`);
    handle.element.style.setProperty("height", `${app.window.height}px`);
  } catch {
    // ignore — best-effort size hint.
  }
}

// Map a puter launchApp name to a registry id (exact id, or a title/suffix match). Pure.
function resolveLaunchTarget(apps: readonly ShellAppEntry[], appName: string): string | undefined {
  const exact = findShellApp(apps, appName);

  if (exact !== undefined) return exact.id;

  const lower = appName.toLowerCase();
  const byTitle = apps.find((a) => a.title.toLowerCase() === lower || a.id.endsWith(`.${lower}`));

  return byTitle?.id;
}

let CHILD_SEQ = 0;

function childSeq(): number {
  CHILD_SEQ += 1;
  return CHILD_SEQ;
}

function safeQuery(root: WmElement, selector: string): WmElement | null {
  try {
    return root.querySelector?.(selector) ?? null;
  } catch {
    return null;
  }
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

// Boot when the bundle loads in the page (the harness/kiosk includes shell.js as a module).
const SHELL_G = globalThis as unknown as ShellGlobals & { document?: unknown };

if (SHELL_G.document !== undefined && SHELL_G.document !== null) {
  bootShell({ g: SHELL_G });
}
