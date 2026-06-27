// Browser — a REAL offline-scoped local web surface mounted into a managed window's body.
//
// VitaApp (see app-sdk.ts): a navigable offline browser driven by the browser view-model
// (viewmodels/apps/browser-app.ts). It has a working address bar, Back / Forward / Reload, and a
// content pane that renders allow-listed local vita:// and local:// pages resolved by the offline
// content resolver. Network URLs are blocked by construction (the resolver only knows local pages),
// and blocked navigations show an honest blocked state. The chrome is themed dark via tokens.

import {
  createBrowserAppViewModel,
  createBrowserLocalContentResolver,
  DEFAULT_BROWSER_LOCAL_PAGES,
} from "../../viewmodels/apps/browser-app.ts";
import type {
  BrowserAppSnapshot,
  BrowserAppViewModel,
} from "../../viewmodels/apps/browser-app.ts";
import {
  defineApp,
} from "../app-sdk.ts";
import type {
  AppContext,
  VitaApp,
} from "../app-sdk.ts";
import type {
  WmElement,
} from "../window-manager.ts";

const START_URL = "vita://browser/start";
const ADDRESS_ID = "vita-browser-address";

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
    const viewModel: BrowserAppViewModel = createBrowserAppViewModel({
      resolver: createBrowserLocalContentResolver(DEFAULT_BROWSER_LOCAL_PAGES),
    });
    let disposed = false;

    root.style.cssText = "display:flex;flex-direction:column;height:100%;background:var(--surface);color:var(--text)";
    root.innerHTML = chrome();
    navigate(START_URL);

    function addressEl(): (WmElement & { value?: string }) | null {
      return (root.querySelector?.(`#${ADDRESS_ID}`) as (WmElement & { value?: string }) | null) ?? null;
    }

    function addressValue(): string {
      const value = addressEl()?.value;

      return typeof value === "string" ? value : "";
    }

    function navigate(url: string): void {
      viewModel.navigate(url);
      render();
    }

    function render(): void {
      if (disposed) return;

      const snapshot = viewModel.snapshot();
      const address = addressEl();

      if (address !== null && snapshot.currentUrl !== null) address.value = snapshot.currentUrl;

      const content = root.querySelector?.("[data-vita-browser-content]") ?? null;

      if (content !== null) content.innerHTML = renderContent(snapshot);

      ctx.window.setBadge(snapshot.currentUrl ?? START_URL);
      updateNav(snapshot);
    }

    function updateNav(snapshot: BrowserAppSnapshot): void {
      setDisabled("[data-vita-browser-back]", !snapshot.canGoBack);
      setDisabled("[data-vita-browser-forward]", !snapshot.canGoForward);
    }

    function setDisabled(selector: string, disabled: boolean): void {
      const el = root.querySelector?.(selector) ?? null;

      if (el === null) return;

      el.style.setProperty("opacity", disabled ? "0.4" : "1");
      el.style.setProperty("cursor", disabled ? "default" : "pointer");
      el.setAttribute("aria-disabled", disabled ? "true" : "false");
    }

    // Delegated click: nav buttons + the Go button.
    const onClick = (event: unknown): void => {
      if (matchesAttr(event, "data-vita-browser-back")) {
        viewModel.back();
        render();
        return;
      }
      if (matchesAttr(event, "data-vita-browser-forward")) {
        viewModel.forward();
        render();
        return;
      }
      if (matchesAttr(event, "data-vita-browser-reload")) {
        viewModel.reload();
        render();
        return;
      }
      const linkUrl = attrValue(event, "data-vita-browser-link");

      if (linkUrl !== undefined) {
        navigate(linkUrl);
        return;
      }

      if (matchesAttr(event, "data-vita-browser-go")) {
        navigate(addressValue());
      }
    };

    // Enter in the address bar navigates.
    const onKeyDown = (event: unknown): void => {
      const key = (event as { key?: unknown }).key;

      if (key === "Enter" && targetHasId(event, ADDRESS_ID)) {
        preventDefault(event);
        navigate(addressValue());
      }
    };

    root.addEventListener("click", onClick as never);
    root.addEventListener("keydown", onKeyDown as never);

    const offClose = ctx.on("close", () => cleanup());

    function cleanup(): void {
      if (disposed) return;
      disposed = true;
      root.removeEventListener?.("click", onClick as never);
      root.removeEventListener?.("keydown", onKeyDown as never);
      offClose();
    }

    return cleanup;
  },
});

export default browserApp;

function chrome(): string {
  return (
    `<div style="display:flex;align-items:center;gap:6px;padding:8px 12px;` +
    `border-bottom:1px solid var(--hairline);background:var(--surface-raised)">` +
    navButton("data-vita-browser-back", "‹", "Back") +
    navButton("data-vita-browser-forward", "›", "Forward") +
    navButton("data-vita-browser-reload", "⟳", "Reload") +
    `<span style="color:var(--accent);font-size:12px" title="secure local origin">🔒</span>` +
    `<input id="${ADDRESS_ID}" type="text" autocomplete="off" spellcheck="false" aria-label="Address" ` +
    `style="flex:1;border:1px solid var(--border);border-radius:7px;padding:5px 10px;` +
    `background:var(--surface);color:var(--text);font:12px var(--font-mono,ui-monospace);outline:0" />` +
    `<button data-vita-browser-go type="button" ` +
    `style="cursor:pointer;border:1px solid var(--accent);background:var(--accent);color:#fff;` +
    `padding:5px 12px;border-radius:7px;font-size:12px">Go</button></div>` +
    `<div data-vita-browser-content style="flex:1;overflow:auto;background:var(--surface)"></div>` +
    `<div style="padding:5px 12px;border-top:1px solid var(--hairline);font-size:11px;color:var(--text-faint)">` +
    `offline · local pages only · network blocked by construction</div>`
  );
}

function navButton(attr: string, glyph: string, label: string): string {
  return (
    `<span ${attr} role="button" tabindex="0" aria-label="${label}" ` +
    `style="cursor:pointer;display:inline-flex;align-items:center;justify-content:center;` +
    `width:26px;height:26px;border-radius:6px;color:var(--text-secondary);font-size:15px;` +
    `user-select:none">${glyph}</span>`
  );
}

function renderContent(snapshot: BrowserAppSnapshot): string {
  if (snapshot.blocked !== null) {
    return (
      `<div style="padding:30px 24px;text-align:center;color:var(--text-faint)">` +
      `<div style="font-size:32px;margin-bottom:10px">🚫</div>` +
      `<div style="font-size:14px;color:var(--text-muted);margin-bottom:6px">Blocked</div>` +
      `<div style="font-size:12px">${escapeHtml(snapshot.blocked.error.message)}</div>` +
      `<div style="font-size:11px;margin-top:8px;color:var(--text-faint)">${escapeHtml(snapshot.blocked.url)}</div></div>`
    );
  }

  if (snapshot.currentUrl === null) {
    return `<div style="padding:30px 24px;color:var(--text-faint);text-align:center">Enter a vita:// address.</div>`;
  }

  return (
    `<div style="padding:24px 28px;max-width:760px;margin:0 auto">` +
    `<h1 style="font:600 22px var(--font-sans,system-ui);color:var(--text);margin:0 0 14px">${escapeHtml(snapshot.pageTitle)}</h1>` +
    `<div style="color:var(--text-secondary);line-height:1.7;font-size:14px;white-space:pre-wrap">${escapeHtml(snapshot.pageContent)}</div>` +
    `<div style="margin-top:22px;padding-top:14px;border-top:1px solid var(--hairline)">` +
    `<div style="font-size:11px;color:var(--text-faint);margin-bottom:8px">Local pages</div>` +
    DEFAULT_BROWSER_LOCAL_PAGES.map((page) =>
      `<div data-vita-browser-link="${escapeHtml(page.url)}" role="button" tabindex="0" ` +
      `style="cursor:pointer;color:var(--accent);font-size:12px;padding:3px 0;` +
      `font-family:var(--font-mono,ui-monospace)">${escapeHtml(page.url)}</div>`,
    ).join("") +
    `</div></div>`
  );
}

function targetHasId(event: unknown, id: string): boolean {
  try {
    const node = (event as { target?: unknown }).target as { id?: unknown } | null;

    return node !== null && typeof node === "object" && node.id === id;
  } catch {
    return false;
  }
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

function matchesAttr(event: unknown, attr: string): boolean {
  try {
    const node = (event as { target?: unknown }).target;

    if (node === null || typeof node !== "object") return false;

    const closest = (node as { closest?: (s: string) => unknown }).closest;

    if (typeof closest !== "function") return false;

    return closest.call(node, `[${attr}]`) !== null;
  } catch {
    return false;
  }
}

function preventDefault(event: unknown): void {
  try {
    (event as { preventDefault?: () => void }).preventDefault?.();
  } catch {
    // ignore
  }
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}
