// PSD-501 — Desktop app-window host (native binder path, ADR-0013).
//
// When the user clicks a dock tile, the desktop's OWN binder fires `dock.launchOrFocus`, the index
// view-model calls `host.launchApp(app)` (the real host bridge), and on success the index screen
// asks THIS module to open a window for the launched app. The window is then populated with REAL
// data fetched through the SAME host bridge (requestFile / readSetting / metrics.sample) — no fake
// rows, honest empty/loading state when a backend has nothing.
//
// This replaces the osr_host document-level click delegate that was only there to prove the
// keystone: clicks now route through the desktop's native binding path, and EVERY dock app opens a
// real surface backed by a real platform adapter.

import type {
  DesktopAppLaunch,
  DesktopHost,
  DesktopHostResult,
  FilesResponse,
} from "../../../sdk/typescript/src/desktop-sdk/index.ts";

export interface AppWindowHost {
  open(appId: string, launch: DesktopAppLaunch): Promise<void>;
}

interface DocumentLike {
  createElement(tag: string): ElementLike;
  getElementById(id: string): ElementLike | null;
  readonly body: ElementLike | null;
}

interface ElementLike {
  id: string;
  innerHTML: string;
  style: { cssText: string };
  appendChild(child: ElementLike): ElementLike;
  setAttribute(name: string, value: string): void;
  addEventListener?(type: string, listener: (event: unknown) => void): void;
  querySelectorAll?(selector: string): ArrayLike<ElementLike>;
  getAttribute?(name: string): string | null;
}

interface MetricsPortLike {
  sample(request: { capability: string }): Promise<DesktopHostResult<unknown>>;
}

const WINDOW_ID = "vita-app-window";

interface AppSpec {
  readonly title: string;
  readonly icon: string;
  readonly render: (host: DesktopHost, doc: DocumentLike) => Promise<string>;
}

// Per-app real-data renderers. Each calls the host bridge for live content.
const APP_SPECS: Readonly<Record<string, AppSpec>> = Object.freeze({
  "vita.app.file-manager": Object.freeze({
    icon: "📁",
    render: (host: DesktopHost) => renderFiles(host, "/", "Files"),
    title: "Files",
  }),
  "vita.app.mail": Object.freeze({
    icon: "✉️",
    render: (host: DesktopHost) => renderFiles(host, "/mail", "Mail"),
    title: "Mail",
  }),
  "vita.app.code": Object.freeze({
    icon: "📝",
    render: (host: DesktopHost) => renderFiles(host, "/editor", "Editor"),
    title: "Editor",
  }),
  "vita.app.settings": Object.freeze({
    icon: "⚙️",
    render: (host: DesktopHost) => renderSettings(host),
    title: "Settings",
  }),
  "vita.app.activity": Object.freeze({
    icon: "📊",
    render: (host: DesktopHost) => renderActivity(host),
    title: "Activity",
  }),
  "vita.app.terminal": Object.freeze({
    icon: "⌨️",
    render: (host: DesktopHost) => renderFiles(host, "/", "Terminal — workspace"),
    title: "Terminal",
  }),
  "vita.app.browser": Object.freeze({
    icon: "🌐",
    // FEATURE 1 — REAL LOCAL WEB SURFACE: render a genuine CEF web view (an <iframe>) that loads the
    // bundled, OFFLINE start page over the SAME production origin family (vita://browser/...). It is a
    // real, navigable web surface scoped to local/offline content (allowed_network:false, strict CSP);
    // it is NOT an honest-empty placeholder. Same-origin desktop/browser assets load; the open internet
    // does not. The window chrome shows the current local address.
    render: () => Promise.resolve(renderBrowser()),
    title: "Browser",
  }),
});

export function createAppWindowHost(host: DesktopHost, doc: DocumentLike): AppWindowHost {
  async function renderInto(win: ElementLike, appId: string, surfaceId: string): Promise<void> {
    const spec = APP_SPECS[appId];
    const title = spec?.title ?? appId;
    let body: string;

    try {
      body = spec === undefined
        ? emptyState(title, "This app has no real backend yet.")
        : await spec.render(host, doc);
    } catch {
      body = emptyState(title, "The backend failed closed.");
    }

    win.innerHTML = chrome(title, spec?.icon ?? "▢", surfaceId, body);
  }

  return Object.freeze({
    async open(appId: string, launch: DesktopAppLaunch): Promise<void> {
      const spec = APP_SPECS[appId];
      const title = spec?.title ?? appId;
      const win = ensureWindow(doc);

      if (win === null) return;

      // Honest loading state while the real backend round-trips.
      win.innerHTML = chrome(title, spec?.icon ?? "▢", launch.surfaceId, loadingBody());

      // Settings is interactive: a click on a theme option calls the REAL applySetting (persisted
      // to /var) then re-renders. One delegated listener, attached once per window element.
      if (appId === "vita.app.settings") {
        attachSettingsHandler(win, host, () => {
          void renderInto(win, appId, launch.surfaceId);
        });
      }

      await renderInto(win, appId, launch.surfaceId);

      // Diagnostic: log the settings chip centers so the boot verification can target the exact
      // 'light' chip (window is at a fixed position, but layout reflow can shift it a few px).
      if (appId === "vita.app.settings") logSettingChipRects(win);
    },
  });
}

function logSettingChipRects(win: ElementLike): void {
  try {
    const log = (globalThis as Record<string, unknown>)["__vitaLog"];

    if (typeof log !== "function" || win.querySelectorAll === undefined) return;

    const chips = win.querySelectorAll("[data-vita-setting-value]");

    for (let i = 0; i < chips.length; i += 1) {
      const chip = chips[i] as ElementLike & { getBoundingClientRect?: () => { left: number; top: number; width: number; height: number } };
      const value = chip.getAttribute?.("data-vita-setting-value") ?? "?";
      const r = chip.getBoundingClientRect?.();

      if (r !== undefined) {
        (log as (s: string) => void)(`VITA-CHIP ${value} cx=${Math.round(r.left + r.width / 2)} cy=${Math.round(r.top + r.height / 2)}`);
      }
    }
  } catch {
    // ignore
  }
}

const SETTINGS_HANDLER = Symbol.for("vita.settings.handler");

function attachSettingsHandler(win: ElementLike, host: DesktopHost, rerender: () => void): void {
  if (win.addEventListener === undefined) return;

  const flagged = win as unknown as Record<symbol, boolean>;

  if (flagged[SETTINGS_HANDLER] === true) return;

  flagged[SETTINGS_HANDLER] = true;
  win.addEventListener("click", (event) => {
    void handleSettingsClick(event, host, rerender);
  });
}

async function handleSettingsClick(event: unknown, host: DesktopHost, rerender: () => void): Promise<void> {
  const target = readEventActionTarget(event);

  if (target === undefined) return;

  const applySetting = host.applySetting;

  if (applySetting === undefined) return;

  try {
    await applySetting(Object.freeze({ key: target.key, value: target.value }));
  } catch {
    return;
  }

  rerender();
}

interface SettingTarget { readonly key: string; readonly value: string; }

function readEventActionTarget(event: unknown): SettingTarget | undefined {
  try {
    const node = (event as { target?: unknown }).target;

    if (node === null || typeof node !== "object") return undefined;

    const closest = (node as { closest?: (s: string) => unknown }).closest;

    if (typeof closest !== "function") return undefined;

    const el = closest.call(node, "[data-vita-setting-key]") as {
      getAttribute?: (n: string) => string | null;
    } | null;

    if (el === null || typeof el.getAttribute !== "function") return undefined;

    const key = el.getAttribute("data-vita-setting-key");
    const value = el.getAttribute("data-vita-setting-value");

    if (typeof key !== "string" || typeof value !== "string" || key.length === 0) return undefined;

    return Object.freeze({ key, value });
  } catch {
    return undefined;
  }
}

function ensureWindow(doc: DocumentLike): ElementLike | null {
  try {
    let win = doc.getElementById(WINDOW_ID);

    if (win === null) {
      win = doc.createElement("div");
      win.id = WINDOW_ID;
      win.style.cssText =
        "position:absolute;left:140px;top:96px;width:560px;min-height:280px;max-height:560px;overflow:auto;" +
        "background:#fff;border:1px solid #c7d0de;border-radius:14px;" +
        "box-shadow:0 24px 60px rgba(20,30,50,.28);z-index:70;font:13px system-ui;color:#1b2330";
      const body = doc.body;

      if (body === null) return null;

      body.appendChild(win);
    }

    return win;
  } catch {
    return null;
  }
}

function chrome(title: string, icon: string, surfaceId: string, body: string): string {
  return (
    `<div style="padding:10px 14px;background:#f3f6fb;border-bottom:1px solid #e3e9f2;` +
    `font-weight:600;display:flex;align-items:center;gap:8px">` +
    `<span>${icon}</span><span>${escapeHtml(title)}</span>` +
    `<span style="margin-left:auto;font:11px ui-monospace,monospace;color:#8a93a6">${escapeHtml(surfaceId)}</span>` +
    `</div><div data-vita-app-window-body>${body}</div>`
  );
}

function loadingBody(): string {
  return `<div style="padding:22px 16px;color:#8a93a6">Loading via the host bridge…</div>`;
}

function emptyState(title: string, detail: string): string {
  return (
    `<div style="padding:26px 16px;color:#8a93a6;text-align:center">` +
    `<div style="font-size:14px;color:#5b6577;margin-bottom:6px">${escapeHtml(title)} is empty</div>` +
    `<div style="font-size:12px">${escapeHtml(detail)}</div></div>`
  );
}

// FEATURE 1: the Browser app's window body — a real, offline-scoped web surface.
//
// The desktop renderer is itself loaded over the secure custom scheme (vita://desktop, see osr_host
// OnRegisterCustomSchemes), so it can embed an <iframe> that loads the bundled local start page from
// the sibling vita://browser origin. CEF renders that iframe as a genuine nested web document — a
// second web surface inside the desktop — wired through the SAME app-window-host pattern as every
// other app (no one-off path). It is OFFLINE by construction: the start page's CSP forbids every
// network origin (connect-src 'none'), so this is a working LOCAL browser, not an internet browser.
const BROWSER_START_URL = "vita://browser/index.html";

function renderBrowser(): string {
  const url = BROWSER_START_URL;
  // A slim local address bar (honest: it shows the bundled start origin) + the live web-view iframe.
  // sandbox allows scripts + same-origin so the local start page's navigation works, but the iframe
  // can never escape the vita://browser origin (no allow-top-navigation, and the scheme has no
  // network path). Height is sized to the app window's content area.
  return (
    `<div style="display:flex;flex-direction:column;height:430px;background:#fff">` +
    `<div style="display:flex;align-items:center;gap:8px;padding:8px 12px;` +
    `border-bottom:1px solid #e3e9f2;background:#f7f9fc">` +
    `<span style="color:#1a7f4b;font-size:12px" title="secure local origin">🔒</span>` +
    `<span style="flex:1;font:12px ui-monospace,monospace;color:#5b6577;` +
    `white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${escapeHtml(url)}</span>` +
    `<span style="font-size:11px;color:#8a93a6">offline · local</span></div>` +
    `<iframe data-vita-browser-surface title="Vita local web surface" src="${escapeHtml(url)}" ` +
    `sandbox="allow-scripts allow-same-origin allow-forms" ` +
    `style="flex:1;width:100%;border:0;background:#fff"></iframe>` +
    `</div>`
  );
}

async function renderFiles(host: DesktopHost, path: string, label: string): Promise<string> {
  const requestFile = host.requestFile;

  if (requestFile === undefined) return emptyState(label, "The files backend is unavailable.");

  const response = await requestFile(Object.freeze({ op: "list", path }) as never) as FilesResponse & {
    readonly error?: { readonly code: string; readonly message: string };
    readonly entries?: readonly { readonly name: string; readonly kind: string; readonly size: number }[];
  };

  if (response.error !== undefined) {
    return emptyState(label, `${response.error.code}: ${response.error.message}`);
  }

  const entries = response.entries ?? [];

  if (entries.length === 0) return emptyState(label, `No entries under ${path}.`);

  const rows = entries.map((entry) => {
    const glyph = entry.kind === "dir" ? "📁" : "📄";

    return (
      `<div style="padding:8px 16px;border-top:1px solid #eef1f6;display:flex;justify-content:space-between">` +
      `<span>${glyph} ${escapeHtml(entry.name)}</span>` +
      `<span style="color:#8a93a6">${entry.kind === "dir" ? "" : `${entry.size} B`}</span></div>`
    );
  }).join("");

  return `<div style="padding:6px 0"><div style="padding:4px 16px;color:#8a93a6;font-size:11px">` +
    `${escapeHtml(label)} · ${entries.length} item${entries.length === 1 ? "" : "s"} (live: /var/lib/vita/files${path === "/" ? "" : path})</div>${rows}</div>`;
}

const SETTINGS_THEME_OPTIONS = ["light", "dark", "graphite"] as const;

async function renderSettings(host: DesktopHost): Promise<string> {
  const readSetting = host.readSetting;

  if (readSetting === undefined) return emptyState("Settings", "The settings backend is unavailable.");

  const themeResult = await readSetting(Object.freeze({ key: "appearance.theme" }));
  const currentTheme = themeResult.ok ? String(themeResult.value) : "dark";

  // Clickable theme options. A click calls the REAL applySetting (persisted to /var/lib/vita) and
  // re-reads — so the chosen theme SURVIVES reboot. data-vita-setting-* drives the window handler.
  const options = SETTINGS_THEME_OPTIONS.map((option) => {
    const active = option === currentTheme;
    const style = active
      ? "background:#3178c6;color:#fff;border-color:#3178c6"
      : "background:#fff;color:#1b2330;border-color:#c7d0de";

    return (
      `<span data-vita-setting-key="appearance.theme" data-vita-setting-value="${option}" ` +
      `style="cursor:pointer;padding:8px 16px;border:1px solid;border-radius:9px;font-size:13px;${style}">` +
      `${escapeHtml(option)}</span>`
    );
  }).join("");

  const extras = ["appearance.accent", "appearance.layout"];
  const extraRows: string[] = [];

  for (const key of extras) {
    const result = await readSetting(Object.freeze({ key }));
    const value = result.ok ? String(result.value) : `(${result.error.code})`;

    extraRows.push(
      `<div style="padding:9px 16px;border-top:1px solid #eef1f6;display:flex;justify-content:space-between">` +
      `<span>${escapeHtml(key)}</span><span style="font-weight:600">${escapeHtml(value)}</span></div>`,
    );
  }

  return (
    `<div style="padding:14px 16px;border-bottom:1px solid #eef1f6">` +
    `<div style="font-size:11px;color:#8a93a6;margin-bottom:8px">Appearance · Theme ` +
    `(persisted in /var/lib/vita/settings.json — survives reboot)</div>` +
    `<div style="display:flex;gap:9px">${options}</div>` +
    `<div style="margin-top:10px;font-size:12px;color:#5b6577">Current theme: ` +
    `<b data-vita-current-theme>${escapeHtml(currentTheme)}</b></div></div>` +
    `${extraRows.join("")}`
  );
}

async function renderActivity(host: DesktopHost): Promise<string> {
  const metrics = readMetricsPort(host);

  if (metrics === undefined) return emptyState("Activity", "The metrics backend is unavailable.");

  const result = await metrics.sample(Object.freeze({ capability: "metrics.read" }));

  if (!result.ok) return emptyState("Activity", `${result.error.code}: ${result.error.message}`);

  const sample = result.value as {
    readonly cpuPercent?: number;
    readonly memory?: { readonly usedBytes?: number; readonly totalBytes?: number };
    readonly processes?: readonly { readonly pid: number; readonly name: string; readonly cpuPercent: number; readonly memoryBytes: number }[];
  };
  const cpu = typeof sample.cpuPercent === "number" ? sample.cpuPercent : 0;
  const used = sample.memory?.usedBytes ?? 0;
  const total = sample.memory?.totalBytes ?? 0;
  const procs = (sample.processes ?? []).slice(0, 12);

  const header =
    `<div style="display:flex;gap:14px;padding:12px 16px;border-bottom:1px solid #eef1f6">` +
    `<div style="flex:1"><div style="font-size:11px;color:#8a93a6">CPU Load</div>` +
    `<div style="font-size:22px;font-weight:600">${cpu.toFixed(1)}%</div></div>` +
    `<div style="flex:1"><div style="font-size:11px;color:#8a93a6">Memory</div>` +
    `<div style="font-size:22px;font-weight:600">${gib(used)} / ${gib(total)} GB</div></div></div>`;

  const rows = procs.map((proc) =>
    `<div style="padding:7px 16px;border-top:1px solid #f1f4f9;display:flex;gap:10px">` +
    `<span style="flex:1">${escapeHtml(proc.name)}</span>` +
    `<span style="width:48px;text-align:right;color:#5b6577">${proc.cpuPercent.toFixed(1)}%</span>` +
    `<span style="width:80px;text-align:right;color:#8a93a6">${mib(proc.memoryBytes)} MB</span>` +
    `<span style="width:54px;text-align:right;color:#b3bccd">pid ${proc.pid}</span></div>`,
  ).join("");

  return `${header}<div style="padding:4px 16px;color:#8a93a6;font-size:11px">` +
    `${procs.length} processes (live /proc on the running VM)</div>${rows}`;
}

function readMetricsPort(host: DesktopHost): MetricsPortLike | undefined {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(host, "metrics");
    const value = descriptor?.value;

    if (value !== null && typeof value === "object" && typeof (value as { sample?: unknown }).sample === "function") {
      return value as MetricsPortLike;
    }
  } catch {
    return undefined;
  }

  return undefined;
}

function gib(bytes: number): string {
  return (bytes / 1_073_741_824).toFixed(1);
}

function mib(bytes: number): string {
  return Math.round(bytes / 1_048_576).toString();
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}
