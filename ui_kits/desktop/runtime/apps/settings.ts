// Settings — a DARK, interactive appearance panel mounted into a managed window's body surface.
//
// VitaApp (see app-sdk.ts): reads the live theme via `ctx.host.readSetting`, renders clickable theme
// chips, and on click calls the REAL `ctx.host.applySetting` (persisted to /var/lib/vita) then
// re-renders. One delegated click listener on the surface root; removed on window close.
// Token-driven (dark) — chips use var(--accent)/var(--surface)/var(--border).

import type {
  DesktopHost,
} from "../../../../sdk/typescript/src/desktop-sdk/index.ts";
import {
  defineApp,
} from "../app-sdk.ts";
import type {
  AppContext,
  VitaApp,
} from "../app-sdk.ts";

const THEME_OPTIONS = ["light", "dark", "graphite"] as const;
const EXTRA_KEYS = ["appearance.accent", "appearance.layout"] as const;

export const settingsApp: VitaApp = defineApp({
  manifest: Object.freeze({
    capabilities: Object.freeze(["settings.read", "settings.write"] as const),
    icon: "⚙️",
    id: "vita.app.settings",
    title: "Settings",
    window: "managed",
  }),
  mount(ctx: AppContext) {
    const root = ctx.surface.root;
    let disposed = false;

    root.style.cssText = "display:block;height:100%;background:var(--surface);color:var(--text)";

    async function rerender(): Promise<void> {
      const body = await renderSettings(ctx.host);

      if (!disposed) root.innerHTML = body;
    }

    // Delegated click: a [data-vita-setting-key] chip applies the setting then re-renders.
    const onClick = (event: unknown): void => {
      const target = readSettingTarget(event);

      if (target === undefined) return;

      const applySetting = ctx.host.applySetting;

      if (applySetting === undefined) return;

      void (async () => {
        try {
          await applySetting(Object.freeze({ key: target.key, value: target.value }));
        } catch {
          return;
        }

        await rerender();
      })();
    };

    root.addEventListener("click", onClick as never);

    const offClose = ctx.on("close", () => cleanup());

    function cleanup(): void {
      if (disposed) return;
      disposed = true;
      root.removeEventListener?.("click", onClick as never);
      offClose();
    }

    root.innerHTML = renderLoading();
    void rerender();
    return cleanup;
  },
});

export default settingsApp;

interface SettingTarget {
  readonly key: string;
  readonly value: string;
}

async function renderSettings(host: DesktopHost): Promise<string> {
  const readSetting = host.readSetting;

  if (readSetting === undefined) return emptyState("The settings backend is unavailable.");

  const themeResult = await readSetting(Object.freeze({ key: "appearance.theme" }));
  const currentTheme = themeResult.ok ? String(themeResult.value) : "dark";

  const options = THEME_OPTIONS.map((option) => {
    const active = option === currentTheme;
    const style = active
      ? "background:var(--accent);color:#fff;border-color:var(--accent)"
      : "background:var(--surface-raised);color:var(--text);border-color:var(--border)";

    return (
      `<span data-vita-setting-key="appearance.theme" data-vita-setting-value="${option}" ` +
      `role="button" tabindex="0" ` +
      `style="cursor:pointer;padding:8px 16px;border:1px solid;border-radius:9px;font-size:13px;${style}">` +
      `${escapeHtml(option)}</span>`
    );
  }).join("");

  const extraRows: string[] = [];

  for (const key of EXTRA_KEYS) {
    const result = await readSetting(Object.freeze({ key }));
    const value = result.ok ? String(result.value) : `(${result.error.code})`;

    extraRows.push(
      `<div style="padding:9px 16px;border-top:1px solid var(--hairline);display:flex;justify-content:space-between;color:var(--text)">` +
      `<span>${escapeHtml(key)}</span><span style="font-weight:600">${escapeHtml(value)}</span></div>`,
    );
  }

  return (
    `<div style="padding:14px 16px;border-bottom:1px solid var(--hairline)">` +
    `<div style="font-size:11px;color:var(--text-faint);margin-bottom:8px">Appearance · Theme ` +
    `(persisted in /var/lib/vita/settings.json — survives reboot)</div>` +
    `<div style="display:flex;gap:9px">${options}</div>` +
    `<div style="margin-top:10px;font-size:12px;color:var(--text-muted)">Current theme: ` +
    `<b data-vita-current-theme style="color:var(--text)">${escapeHtml(currentTheme)}</b></div></div>` +
    `${extraRows.join("")}`
  );
}

function renderLoading(): string {
  return `<div style="padding:22px 16px;color:var(--text-faint)">Loading via the host bridge…</div>`;
}

function emptyState(detail: string): string {
  return (
    `<div style="padding:26px 16px;color:var(--text-faint);text-align:center">` +
    `<div style="font-size:13px;color:var(--text-muted);margin-bottom:6px">Settings unavailable</div>` +
    `<div style="font-size:12px">${escapeHtml(detail)}</div></div>`
  );
}

function readSettingTarget(event: unknown): SettingTarget | undefined {
  try {
    const node = (event as { target?: unknown }).target;

    if (node === null || typeof node !== "object") return undefined;

    const closest = (node as { closest?: (s: string) => unknown }).closest;

    if (typeof closest !== "function") return undefined;

    const el = closest.call(node, "[data-vita-setting-key]") as {
      getAttribute?: (n: string) => string | null;
    } | null;

    if (el === null || typeof el?.getAttribute !== "function") return undefined;

    const key = el.getAttribute("data-vita-setting-key");
    const value = el.getAttribute("data-vita-setting-value");

    if (typeof key !== "string" || typeof value !== "string" || key.length === 0) return undefined;

    return Object.freeze({ key, value });
  } catch {
    return undefined;
  }
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}
