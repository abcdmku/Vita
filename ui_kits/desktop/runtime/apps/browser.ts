// Browser — a real, OFFLINE-scoped local web surface mounted into a managed window's body.
//
// VitaApp (see app-sdk.ts): renders a slim local address bar + a live CEF web-view <iframe> that
// loads the bundled, offline start page over the sibling vita://browser origin (strict CSP, no
// network path). The chrome is themed dark via tokens; the iframe content is its own document.

import {
  defineApp,
} from "../app-sdk.ts";
import type {
  AppContext,
  VitaApp,
} from "../app-sdk.ts";

const BROWSER_START_URL = "vita://browser/index.html";

export const browserApp: VitaApp = defineApp({
  manifest: Object.freeze({
    capabilities: Object.freeze(["web.local"] as const),
    icon: "🌐",
    id: "vita.app.browser",
    title: "Browser",
    window: "managed",
  }),
  mount(ctx: AppContext) {
    const root = ctx.surface.root;

    root.style.cssText = "display:flex;flex-direction:column;height:100%;background:var(--surface)";
    root.innerHTML = renderBrowser(BROWSER_START_URL);
    ctx.window.setBadge(BROWSER_START_URL);
  },
});

export default browserApp;

function renderBrowser(url: string): string {
  return (
    `<div style="display:flex;align-items:center;gap:8px;padding:8px 12px;` +
    `border-bottom:1px solid var(--hairline);background:var(--surface-raised)">` +
    `<span style="color:var(--accent);font-size:12px" title="secure local origin">🔒</span>` +
    `<span style="flex:1;font:12px var(--font-mono,ui-monospace);color:var(--text-secondary);` +
    `white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${escapeHtml(url)}</span>` +
    `<span style="font-size:11px;color:var(--text-faint)">offline · local</span></div>` +
    `<iframe data-vita-browser-surface title="Vita local web surface" src="${escapeHtml(url)}" ` +
    `sandbox="allow-scripts allow-same-origin allow-forms" ` +
    `style="flex:1;width:100%;border:0;background:var(--surface)"></iframe>`
  );
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}
