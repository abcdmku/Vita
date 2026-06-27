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
import { createPickerSinks } from "../picker-windows.ts";
import { createHttpPickerFsClient } from "../picker-fs-http.ts";
import { createDomPickerUi } from "../picker-ui-dom.ts";
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
  // The capability registry the broker + pickers gate against (exposed for the verification driver to
  // assert capability gating — e.g. that an app without fs.read is denied a file picker).
  readonly capabilities: PuterCapabilityRegistry;
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

  // The puter.ui.* PICKERS: real browse/save/font/color windows. The fs browse goes over the SAME
  // api_origin the apps use, with the requesting app's OWN token (so the picker inherits that app's fs
  // grants — it can never read beyond what the app may). The DOM ui renders the windows in `.v-screen`.
  const pickerSinks = createPickerSinks({
    apiOrigin,
    fs: createHttpPickerFsClient({ apiOrigin }),
    ui: createDomPickerUi({ doc }),
  });

  const sinks: BrokerSinks = {
    ...pickerSinks,
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
    // The currently FOCUSED window's appId (the WM tags it with the discoverable active id), so the
    // dock can draw the focused-app indicator. Read structurally to stay DOM-lib-free.
    focusedAppId: () => readFocusedAppId(doc),
    titleFor: (appId) => findShellApp(apps, appId)?.title ?? appId,
    iconFor: (appId) => findShellApp(apps, appId)?.icon ?? "🪟",
  });

  function refreshDock(): void {
    chrome.refresh();
  }

  // ----- boot: render the dock, start the clock, autostart any opt-in apps -----
  // By default NO app is autostart (see app-registry.ts), so the shell boots to a CLEAN desktop —
  // wallpaper + the system bar (top) + the dock (bottom). The user launches apps from the dock
  // launcher. The loop is retained so a kiosk-style embedder can opt one app back in.

  for (const app of apps) {
    if (app.autostart === true) launch(app.id);
  }

  refreshDock();
  chrome.startClock();

  const controller: ShellController = Object.freeze({
    apps,
    capabilities,
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
  // appId of the currently focused window, or undefined when none is focused.
  focusedAppId(): string | undefined;
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

  // ----- SYSTEM BAR (brand + active context left; status cluster right) -----
  const menubar = doc.createElement("div");

  menubar.classList.add("v-menubar");
  // Handoff MenuBar: the clean Vita.ts wordmark + File/Edit/View/Go/Window/Help, and a right status
  // cluster of Lucide wifi/battery + a monospace clock. Sentence-case copy; no gradient logo square.
  const menuTitles = ["File", "Edit", "View", "Go", "Window", "Help"];
  menubar.innerHTML =
    `<div class="v-bar-left">` +
    `<span class="v-brand">Vita<i>.ts</i></span>` +
    `<div class="v-menus">` +
    menuTitles.map((m) => `<span>${m}</span>`).join("") +
    `<span data-shell-status>Desktop</span>` +
    `</div>` +
    `</div>` +
    `<div class="v-status">` +
    `<span class="ico" data-shell-net style="width:15px;height:15px" title="Connected to this node">${ICON_WIFI}</span>` +
    `<span class="ico" style="width:19px;height:19px" title="Battery">${ICON_BATTERY}</span>` +
    `<span class="clk" data-shell-clock><span class="clk-time">--:--</span><span class="clk-date">———</span></span>` +
    `</div>`;
  screen?.appendChild(menubar);

  const status = safeQuery(menubar, "[data-shell-status]");
  const clockTime = safeQuery(menubar, "[data-shell-clock] .clk-time");
  const clockDate = safeQuery(menubar, "[data-shell-clock] .clk-date");

  // ----- launcher overlay (one tile per registry app) -----
  const scrim = doc.createElement("div");

  scrim.setAttribute("data-shell-launcher", "");
  // z-index must sit ABOVE managed windows (which climb from Z_BASE=70 as they're focused), or an open
  // window would overlay the launcher and swallow tile clicks. 9000 keeps it under modals (90 is the
  // per-window modal scrim, but those are scoped; the launcher is a top-level overlay).
  scrim.style.cssText =
    "position:absolute;inset:0;z-index:9000;display:none;background:rgba(5,7,10,.55);" +
    "backdrop-filter:blur(3px);-webkit-backdrop-filter:blur(3px);align-items:center;justify-content:center";

  const palette = doc.createElement("div");

  palette.style.cssText =
    "width:600px;max-width:88vw;background:var(--surface-overlay,#15171d);border:1px solid var(--border,#262a33);" +
    "border-radius:18px;box-shadow:0 30px 80px rgba(0,0,0,.6),inset 0 1px 0 rgba(255,255,255,.06);padding:20px 20px 24px;color:var(--text,#e6e8ee)";
  palette.innerHTML =
    `<div style="display:flex;align-items:center;justify-content:space-between;margin:0 4px 16px">` +
    `<span style="font:650 15px system-ui">Applications</span>` +
    `<span style="font:11.5px system-ui;color:var(--text-faint,#8b8f9c)">Click an app to open it</span></div>` +
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
      "display:flex;flex-direction:column;gap:8px;padding:14px 13px;border-radius:13px;cursor:pointer;" +
      "background:var(--surface,#0e0f13);border:1px solid var(--border,#262a33);transition:border-color .12s ease,background .12s ease";
    const badge = app.origin === "third-party"
      ? `<span style="font:10px ui-monospace,monospace;color:var(--accent,#5b9dff)">3rd-party</span>`
      : `<span style="font:10px ui-monospace,monospace;color:var(--text-faint,#8b8f9c)">vita</span>`;

    tile.innerHTML =
      `<div style="display:flex;align-items:center;justify-content:space-between">` +
      `<span style="width:34px;height:34px;border-radius:var(--radius-control,8px);display:inline-flex;align-items:center;justify-content:center;` +
      `background:var(--accent-subtle);color:var(--accent)">` +
      `${appIconMarkup(app, 20)}</span>${badge}</div>` +
      `<div style="font:600 13.5px system-ui">${escapeHtml(app.title)}</div>` +
      `<div style="font:11.5px system-ui;color:var(--text-faint,#8b8f9c);line-height:1.4">${escapeHtml(app.description)}</div>` +
      (app.license === undefined ? "" : `<div style="font:10px ui-monospace,monospace;color:var(--text-faint,#6c707b);margin-top:2px">${escapeHtml(app.license)}</div>`);
    tile.addEventListener("click", (() => {
      cb.onLaunch(app.id);
      toggleLauncher(false);
    }) as never);
    tile.addEventListener("pointerenter", (() => {
      tile.style.setProperty("border-color", "var(--accent,#4f9dff)");
      tile.style.setProperty("background", "var(--surface-raised,#181c22)");
    }) as never);
    tile.addEventListener("pointerleave", (() => {
      tile.style.setProperty("border-color", "var(--border,#262a33)");
      tile.style.setProperty("background", "var(--surface,#0e0f13)");
    }) as never);
    grid?.appendChild(tile);
  }

  // ----- dock (launcher + ALWAYS-VISIBLE pinned apps + any extra running windows) -----
  const dock = doc.createElement("div");

  dock.classList.add("v-dock");
  dock.setAttribute("data-shell-dock", "");
  screen?.appendChild(dock);

  let launcherOpen = false;

  function toggleLauncher(force?: boolean): void {
    launcherOpen = force ?? !launcherOpen;
    scrim.style.setProperty("display", launcherOpen ? "flex" : "none");
  }

  // Build one dock tile element. `running`/`focused` drive the indicator + ring; the click action is
  // launch-or-focus (the shell's `launch` focuses an already-open window). Open windows additionally
  // carry `data-shell-dock-tile` so the verifier (and "list open windows" callers) can find them.
  function makeDockTile(app: ShellAppEntry, running: boolean, focused: boolean): WmElement {
    const tile = doc.createElement("div");

    tile.classList.add("v-dtile");
    tile.setAttribute("data-shell-pinned", app.id);

    if (running) {
      tile.classList.add("running");
      tile.setAttribute("data-shell-dock-tile", app.id);
    }
    if (focused) tile.classList.add("focused");

    // Handoff Dock: the icon sits DIRECTLY on the neutral tile in currentColor — no colored tint chip.
    // The tile color (var(--text-secondary), → accent when running/focused) flows into the SVG stroke.
    tile.innerHTML =
      `<span style="width:25px;height:25px;display:flex;align-items:center;justify-content:center;color:currentColor">${appIconMarkup(app, 25)}</span>` +
      `<span class="v-run-dot"></span>` +
      `<span class="v-dtip">${escapeHtml(app.title)}${running ? " · running" : ""}</span>`;
    tile.addEventListener("click", (() => {
      cb.onLaunch(app.id); // launch if closed; focuses if already open
      cb.focus(app.id);
    }) as never);
    return tile;
  }

  function refresh(): void {
    dock.innerHTML = "";

    const open = cb.openWindowIds();
    const openSet = new Set(open);
    const focused = cb.focusedAppId();

    // Launcher tile (always first) — opens the all-apps overlay.
    const launcherBtn = doc.createElement("div");

    launcherBtn.classList.add("v-dtile", "v-launcher");
    launcherBtn.setAttribute("data-shell-launcher-btn", "");
    launcherBtn.setAttribute("title", "Applications");
    launcherBtn.innerHTML = `${ICON_GRID}<span class="v-dtip">All apps</span>`;
    launcherBtn.addEventListener("click", (() => toggleLauncher()) as never);
    dock.appendChild(launcherBtn);

    dock.appendChild(makeSep(doc));

    // PINNED apps — always visible, in catalog order. Running ones light their indicator; the focused
    // one shows the elongated bar.
    const pinnedIds = pinnedAppIds(apps);

    for (const appId of pinnedIds) {
      const app = findShellApp(apps, appId);

      if (app === undefined) continue;

      dock.appendChild(makeDockTile(app, openSet.has(appId), focused === appId));
    }

    // Any OPEN window that isn't a pinned app (e.g. child windows, future apps) gets a trailing tile
    // after a separator — so every open window is still reachable + counted (verifier contract).
    const extras = open.filter((id) => !pinnedIds.includes(id));

    if (extras.length > 0) {
      dock.appendChild(makeSep(doc));

      for (const appId of extras) {
        const app = findShellApp(apps, appId);
        const entry: ShellAppEntry = app ?? {
          description: "",
          entry: "",
          grants: [],
          icon: cb.iconFor(appId),
          id: appId,
          kind: "webapp",
          origin: "vita",
          title: cb.titleFor(appId),
        };

        dock.appendChild(makeDockTile(entry, true, focused === appId));
      }
    }

    if (status !== null) status.textContent = open.length === 0 ? "Desktop" : `${open.length} window${open.length === 1 ? "" : "s"} open`;
  }

  function startClock(): void {
    const tick = (): void => {
      const now = new Date();
      const hh = now.getHours().toString().padStart(2, "0");
      const mm = now.getMinutes().toString().padStart(2, "0");

      if (clockTime !== null) clockTime.textContent = `${hh}:${mm}`;
      if (clockDate !== null) clockDate.textContent = formatDate(now);
    };

    tick();
    const g = globalThis as { setInterval?: (fn: () => void, ms: number) => unknown };

    g.setInterval?.(tick, 30000);
  }

  return Object.freeze({ refresh, startClock });
}

// Separator element for the dock.
function makeSep(doc: ShellGlobals["document"]): WmElement {
  const sep = doc.createElement("div");

  sep.classList.add("v-dsep");
  return sep;
}

// Short weekday + day-month, e.g. "Fri 27 Jun". Locale-light (no Intl reliance) so it renders the
// same in the headless harness as on-device.
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const;

function formatDate(now: Date): string {
  const wd = WEEKDAYS[now.getDay()] ?? "";
  const mo = MONTHS[now.getMonth()] ?? "";

  return `${wd} ${now.getDate()} ${mo}`;
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

// ---------------------------------------------------------------------------------------------
// Dock / system-bar iconography. Real, recognizable line icons (inline SVG, currentColor-stroked)
// rather than faint emoji glyphs. Keyed by registry app id; apps without a bespoke icon fall back to
// their registry emoji so the catalog stays the single source of truth. Each line icon is a tiny,
// self-contained SVG string (no external sprite, offline-clean).
// ---------------------------------------------------------------------------------------------

function svg(body: string): string {
  return (
    `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" ` +
    `stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`
  );
}

// System-bar glyphs (Lucide-matched: wifi, battery-full, grid for the launcher).
const ICON_WIFI = svg(`<path d="M5 12.55a11 11 0 0 1 14.08 0"/><path d="M1.42 9a16 16 0 0 1 21.16 0"/><path d="M8.53 16.11a6 6 0 0 1 6.95 0"/><line x1="12" y1="20" x2="12.01" y2="20"/>`);
const ICON_BATTERY = svg(`<rect x="1" y="6" width="18" height="12" rx="2" ry="2"/><line x1="23" y1="13" x2="23" y2="11"/><rect x="3" y="8" width="12" height="8" rx="1" fill="currentColor" stroke="none"/>`);
const ICON_GRID = svg(`<rect x="3.5" y="3.5" width="7" height="7" rx="1.6"/><rect x="13.5" y="3.5" width="7" height="7" rx="1.6"/><rect x="3.5" y="13.5" width="7" height="7" rx="1.6"/><rect x="13.5" y="13.5" width="7" height="7" rx="1.6"/>`);

// App icons (Files / Console / Todo / Notepad / Terminal / Package Manager / Editor).
const APP_ICONS: Readonly<Record<string, string>> = Object.freeze({
  "com.puter-apps.notepad": svg(`<path d="M5 3.5h9l5 5V20a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V4.5a1 1 0 0 1 1-1Z"/><path d="M14 3.5V9h5"/><line x1="8" y1="13" x2="16" y2="13"/><line x1="8" y1="16.5" x2="13" y2="16.5"/>`),
  "com.puter-apps.serverless-todo": svg(`<rect x="4" y="4" width="16" height="16" rx="2.4"/><path d="M8.5 12.2l2.3 2.3 4.7-5"/>`),
  "vita.app.deploy-console": svg(`<rect x="3" y="4.5" width="18" height="15" rx="2.2"/><path d="M7 9.5l3 2.6-3 2.6"/><line x1="12.5" y1="15" x2="17" y2="15"/>`),
  "vita.app.editor": svg(`<path d="M14.5 4.5l5 5L8 21l-5 .5.5-5Z"/><line x1="12.5" y1="6.5" x2="17.5" y2="11.5"/>`),
  "vita.app.package-manager": svg(`<path d="M12 3l8 4.5v9L12 21l-8-4.5v-9Z"/><path d="M4 7.5l8 4.5 8-4.5"/><line x1="12" y1="12" x2="12" y2="21"/>`),
  "vita.app.terminal": svg(`<rect x="3" y="4.5" width="18" height="15" rx="2.2"/><path d="M7 9.5l3 2.6-3 2.6"/><line x1="12.5" y1="15" x2="17" y2="15"/>`),
  "vita.desk": svg(`<path d="M3.5 7a2 2 0 0 1 2-2h4l2 2.2h7a2 2 0 0 1 2 2V18a2 2 0 0 1-2 2H5.5a2 2 0 0 1-2-2Z"/>`),
});

// The bespoke line icon for an app, or its registry emoji as a fallback. `size` sets the box. The
// icon inherits currentColor (handoff: Lucide icons recolor via currentColor) so it takes the tile's
// neutral/accent ink rather than a baked-in white.
function appIconMarkup(app: ShellAppEntry, size: number): string {
  const icon = APP_ICONS[app.id];

  if (icon !== undefined) {
    return `<span style="width:${size}px;height:${size}px;display:inline-flex;color:currentColor">${icon}</span>`;
  }

  return `<span class="v-demoji" style="font-size:${Math.round(size * 1.05)}px">${app.icon}</span>`;
}

// The apps PINNED to the dock (always visible), in display order. The "I want a taskbar" set: Files
// (Vita Desk), Terminal, Editor, Package Manager, Console — every default registry app that exists.
// Filtered against the live catalog so a trimmed catalog never yields a dead tile.
const PINNED_ORDER: readonly string[] = Object.freeze([
  "vita.desk",
  "vita.app.terminal",
  "vita.app.editor",
  "vita.app.package-manager",
  "vita.app.deploy-console",
  "com.puter-apps.serverless-todo",
  "com.puter-apps.notepad",
]);

function pinnedAppIds(apps: readonly ShellAppEntry[]): readonly string[] {
  const present = PINNED_ORDER.filter((id) => findShellApp(apps, id) !== undefined);

  // If the catalog has apps we didn't enumerate (custom builds), pin them too so nothing is hidden.
  const extra = apps.map((a) => a.id).filter((id) => !present.includes(id));

  return [...present, ...extra];
}

// The appId of the currently focused window. The WM tags exactly one window element with the
// discoverable active id (ACTIVE_WINDOW_ID = "vita-app-window"); its data-vita-window is the appId.
// Read structurally (no DOM lib) so this stays portable.
function readFocusedAppId(doc: ShellGlobals["document"]): string | undefined {
  try {
    const el = doc.getElementById("vita-app-window");

    if (el === null) return undefined;

    const id = el.getAttribute?.("data-vita-window");

    return id === null || id === undefined ? undefined : id;
  } catch {
    return undefined;
  }
}

// Boot when the bundle loads in the page (the harness/kiosk includes shell.js as a module).
const SHELL_G = globalThis as unknown as ShellGlobals & { document?: unknown };

if (SHELL_G.document !== undefined && SHELL_G.document !== null) {
  bootShell({ g: SHELL_G });
}
