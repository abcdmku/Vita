// Settings — a REAL dark settings panel mounted into a managed window's body.
//
// VitaApp (see app-sdk.ts): a sectioned settings app driven by the settings view-model
// (viewmodels/apps/settings-app.ts). The Appearance section exposes the REAL persisted controls —
// theme (light / dark / graphite), accent colour, and layout — each backed by the host's
// readSetting / applySetting ports (persisted to /var/lib/vita/settings.json, survives reboot). On
// mount we read the live values; clicking a control applies it through the host and re-renders.
//
// This is more complete than the old single chip row: a sidebar of sections, theme chips, accent
// swatches, and layout options, all token-driven dark. One delegated click listener drives section
// selection + control application; listeners removed on close.

import {
  createSettingsAppViewModel,
  SETTINGS_APP_LAYOUTS,
  SETTINGS_APP_SETTING_KEYS,
  SETTINGS_APP_THEMES,
} from "../../viewmodels/apps/settings-app.ts";
import type {
  SettingsAppState,
  SettingsAppViewModel,
} from "../../viewmodels/apps/settings-app.ts";
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

    root.style.cssText = "display:flex;height:100%;background:var(--surface);color:var(--text)";

    const created = createSettingsAppViewModel(ports(ctx.host));

    if (!created.ok) {
      root.innerHTML = emptyState(`Settings unavailable: ${created.error.message}`);
      return () => {};
    }

    const viewModel = created.value;
    const hasPorts = ctx.host.readSetting !== undefined && ctx.host.applySetting !== undefined;

    root.innerHTML = render(viewModel.snapshot(), hasPorts);

    function rerender(): void {
      if (!disposed) root.innerHTML = render(viewModel.snapshot(), hasPorts);
    }

    // Read the live persisted values for theme/accent/layout so the panel reflects real state.
    void (async () => {
      for (const key of [
        SETTINGS_APP_SETTING_KEYS.theme,
        SETTINGS_APP_SETTING_KEYS.accent,
        SETTINGS_APP_SETTING_KEYS.layout,
      ]) {
        await viewModel.readSetting(key);

        if (disposed) return;
      }

      rerender();
    })();

    // Delegated click: a section row selects a section; a control applies its setting then re-renders.
    const onClick = (event: unknown): void => {
      const section = attrValue(event, "data-vita-settings-section");

      if (section !== undefined) {
        viewModel.selectSection(section);
        rerender();
        return;
      }

      const key = attrValue(event, "data-vita-settings-key");
      const value = attrValue(event, "data-vita-settings-value");

      if (key !== undefined && value !== undefined) {
        void (async () => {
          await viewModel.applySetting(key, value);

          if (!disposed) rerender();
        })();
      }
    };

    root.addEventListener("click", onClick as never);

    const offClose = ctx.on("close", () => cleanup());

    function cleanup(): void {
      if (disposed) return;
      disposed = true;
      root.removeEventListener?.("click", onClick as never);
      offClose();
    }

    return cleanup;
  },
});

export default settingsApp;

function ports(host: DesktopHost): {
  readSetting?: NonNullable<DesktopHost["readSetting"]>;
  previewSetting?: NonNullable<DesktopHost["previewSetting"]>;
  applySetting?: NonNullable<DesktopHost["applySetting"]>;
} {
  const out: {
    readSetting?: NonNullable<DesktopHost["readSetting"]>;
    previewSetting?: NonNullable<DesktopHost["previewSetting"]>;
    applySetting?: NonNullable<DesktopHost["applySetting"]>;
  } = {};

  if (host.readSetting !== undefined) out.readSetting = host.readSetting.bind(host);
  if (host.previewSetting !== undefined) out.previewSetting = host.previewSetting.bind(host);
  if (host.applySetting !== undefined) out.applySetting = host.applySetting.bind(host);

  return out;
}

function render(state: SettingsAppState, hasPorts: boolean): string {
  return (
    `<div style="width:200px;border-right:1px solid var(--hairline);overflow:auto;background:var(--surface-sunken,var(--surface))">` +
    renderSidebar(state) +
    `</div>` +
    `<div style="flex:1;overflow:auto;padding:22px 26px">` +
    renderSection(state, hasPorts) +
    `</div>`
  );
}

function renderSidebar(state: SettingsAppState): string {
  const groups = new Map<string, string[]>();

  for (const section of state.sections) {
    const active = section.active;
    const row =
      `<div data-vita-settings-section="${escapeHtml(section.id)}" role="button" tabindex="0" ` +
      `style="cursor:pointer;padding:8px 16px;border-radius:8px;margin:1px 8px;` +
      `${active ? "background:var(--surface-raised);color:var(--text)" : "color:var(--text-secondary)"}">` +
      `${escapeHtml(section.label)}</div>`;
    const list = groups.get(section.group) ?? [];

    list.push(row);
    groups.set(section.group, list);
  }

  let out = `<div style="padding:14px 16px 8px;font-size:15px;font-weight:600;color:var(--text)">Settings</div>`;

  for (const [group, rows] of groups) {
    out += `<div style="padding:10px 16px 4px;font-size:10px;text-transform:uppercase;letter-spacing:0.05em;color:var(--text-faint)">${escapeHtml(group)}</div>`;
    out += rows.join("");
  }

  return out;
}

function renderSection(state: SettingsAppState, hasPorts: boolean): string {
  if (state.activeSection === "appearance") return renderAppearance(state, hasPorts);

  return (
    `<div style="font-size:18px;font-weight:600;color:var(--text);margin-bottom:8px">${escapeHtml(title(state.activeSection))}</div>` +
    `<div style="color:var(--text-faint);font-size:13px">This section has no live controls yet. ` +
    `Appearance has the real persisted theme, accent, and layout controls.</div>`
  );
}

function renderAppearance(state: SettingsAppState, hasPorts: boolean): string {
  const appearance = state.appearance;

  const themes = SETTINGS_APP_THEMES.map((theme) =>
    chip(SETTINGS_APP_SETTING_KEYS.theme, theme, capitalize(theme), theme === appearance.theme),
  ).join("");

  const accents = state.accentOptions.map((option) => {
    const active = option.active;

    return (
      `<span data-vita-settings-key="${SETTINGS_APP_SETTING_KEYS.accent}" data-vita-settings-value="${escapeHtml(option.id)}" ` +
      `role="button" tabindex="0" title="${escapeHtml(option.label)}" ` +
      `style="cursor:pointer;display:inline-flex;align-items:center;justify-content:center;` +
      `width:30px;height:30px;border-radius:50%;background:${escapeHtml(option.color)};` +
      `border:2px solid ${active ? "var(--text)" : "transparent"}">` +
      `${active ? '<span style="color:#fff;font-size:13px">✓</span>' : ""}</span>`
    );
  }).join("");

  const layouts = SETTINGS_APP_LAYOUTS.map((layout) =>
    chip(SETTINGS_APP_SETTING_KEYS.layout, layout, capitalize(layout), layout === appearance.layout),
  ).join("");

  const note = hasPorts
    ? `Persisted in /var/lib/vita/settings.json — survives reboot.`
    : `Settings backend is read-only here; controls reflect defaults.`;

  return (
    `<div style="font-size:18px;font-weight:600;color:var(--text);margin-bottom:4px">Appearance</div>` +
    `<div style="font-size:11px;color:var(--text-faint);margin-bottom:20px">${escapeHtml(note)}</div>` +
    group("Theme", `<div style="display:flex;gap:9px;flex-wrap:wrap">${themes}</div>`) +
    group("Accent", `<div style="display:flex;gap:12px;align-items:center">${accents}` +
      `<span style="font-size:12px;color:var(--text-muted);margin-left:6px">${escapeHtml(capitalize(appearance.accent))}</span></div>`) +
    group("Layout", `<div style="display:flex;gap:9px;flex-wrap:wrap">${layouts}</div>` +
      `<div style="margin-top:8px;font-size:12px;color:var(--text-muted)">Density: ${escapeHtml(appearance.density)}` +
      `${appearance.tiling ? " · tiling on" : ""}</div>`)
  );
}

function group(label: string, body: string): string {
  return (
    `<div style="margin-bottom:24px">` +
    `<div style="font-size:13px;font-weight:600;color:var(--text);margin-bottom:10px">${escapeHtml(label)}</div>` +
    body +
    `</div>`
  );
}

function chip(key: string, value: string, label: string, active: boolean): string {
  const style = active
    ? "background:var(--accent);color:#fff;border-color:var(--accent)"
    : "background:var(--surface-raised);color:var(--text);border-color:var(--border)";

  return (
    `<span data-vita-settings-key="${escapeHtml(key)}" data-vita-settings-value="${escapeHtml(value)}" ` +
    `role="button" tabindex="0" ` +
    `style="cursor:pointer;padding:7px 15px;border:1px solid;border-radius:9px;font-size:13px;${style}">` +
    `${escapeHtml(label)}</span>`
  );
}

function emptyState(detail: string): string {
  return (
    `<div style="flex:1;padding:26px 16px;color:var(--text-faint);text-align:center">` +
    `<div style="font-size:13px;color:var(--text-muted);margin-bottom:6px">Settings unavailable</div>` +
    `<div style="font-size:12px">${escapeHtml(detail)}</div></div>`
  );
}

function title(sectionId: string): string {
  return sectionId.length === 0 ? "Settings" : capitalize(sectionId);
}

function capitalize(value: string): string {
  return value.length === 0 ? value : `${value[0]?.toUpperCase() ?? ""}${value.slice(1)}`;
}

function attrValue(event: unknown, attr: string): string | undefined {
  try {
    const node = (event as { target?: unknown }).target;

    if (node === null || typeof node !== "object") return undefined;

    const closest = (node as { closest?: (s: string) => unknown }).closest;

    if (typeof closest !== "function") return undefined;

    const el = closest.call(node, `[${attr}]`) as { getAttribute?: (n: string) => string | null } | null;

    if (el === null || typeof el?.getAttribute !== "function") return undefined;

    const value = el.getAttribute(attr);

    return typeof value === "string" ? value : undefined;
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
