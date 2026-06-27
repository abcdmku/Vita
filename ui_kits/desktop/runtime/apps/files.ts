// Files — a DARK, navigable file browser mounted into a managed window's body surface.
//
// This is a VitaApp (see app-sdk.ts): the desktop frames + themes the window; this module only
// renders into `ctx.surface.root` and reads live data through `ctx.host.requestFile`. It is fully
// token-driven (var(--surface)/var(--text)/var(--hairline)/var(--accent)) — never hard-coded light.
//
// Navigation: clicking a directory row re-lists that path; a ".." row goes up. One delegated click
// listener on the surface root drives it; the listener is removed on window close via the returned
// cleanup (and `on("close")`).

import type {
  DesktopHost,
  FilesResponse,
} from "../../../../sdk/typescript/src/desktop-sdk/index.ts";
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

// The shape requestFile returns for a list (mirrors app-window-host's structural read).
type FilesListResponse = FilesResponse & {
  readonly error?: { readonly code: string; readonly message: string };
  readonly entries?: readonly { readonly name: string; readonly kind: string; readonly size: number }[];
};

const ROOT_PATH = "/";

export const filesApp: VitaApp = defineApp({
  manifest: Object.freeze({
    capabilities: Object.freeze(["files.read"] as const),
    icon: "📁",
    id: "vita.app.file-manager",
    title: "Files",
    window: "managed",
  }),
  mount(ctx: AppContext) {
    const root = ctx.surface.root;
    let path = ROOT_PATH;
    let disposed = false;

    root.style.cssText = "display:block;height:100%;background:var(--surface);color:var(--text)";

    async function navigate(next: string): Promise<void> {
      path = next;
      ctx.window.setBadge(path);
      root.innerHTML = renderShell(path, loadingRow());

      const body = await renderListing(ctx.host, path);

      if (!disposed) root.innerHTML = renderShell(path, body);
    }

    // Delegated click: a [data-vita-files-dir] row lists that path. Read-only navigation; files no-op.
    const onClick = (event: unknown): void => {
      const target = closestAttr(event, "data-vita-files-dir");

      if (target !== undefined) void navigate(target);
    };

    root.addEventListener("click", onClick as never);

    const offClose = ctx.on("close", () => cleanup());

    function cleanup(): void {
      if (disposed) return;
      disposed = true;
      root.removeEventListener?.("click", onClick as never);
      offClose();
    }

    void navigate(ROOT_PATH);
    return cleanup;
  },
});

export default filesApp;

async function renderListing(host: DesktopHost, path: string): Promise<string> {
  const requestFile = host.requestFile;

  if (requestFile === undefined) return emptyRow("The files backend is unavailable.");

  let response: FilesListResponse;

  try {
    response = await requestFile(Object.freeze({ op: "list", path }) as never) as FilesListResponse;
  } catch {
    return emptyRow("The files backend failed closed.");
  }

  if (response.error !== undefined) {
    return emptyRow(`${response.error.code}: ${response.error.message}`);
  }

  const entries = response.entries ?? [];
  const rows: string[] = [];

  if (path !== ROOT_PATH) rows.push(dirRow("..", parentPath(path), "↩"));

  for (const entry of entries) {
    const isDir = entry.kind === "dir";
    const child = joinPath(path, entry.name);

    rows.push(isDir ? dirRow(entry.name, child, "📁") : fileRow(entry.name, entry.size));
  }

  if (rows.length === 0) return emptyRow(`No entries under ${path}.`);

  return rows.join("");
}

function renderShell(path: string, body: string): string {
  return (
    `<div style="padding:6px 14px;color:var(--text-faint);font-family:var(--font-mono,ui-monospace);` +
    `font-size:11px;border-bottom:1px solid var(--hairline)">${escapeHtml(path)}</div>` +
    `<div>${body}</div>`
  );
}

function dirRow(label: string, path: string, glyph: string): string {
  return (
    `<div data-vita-files-dir="${escapeHtml(path)}" role="button" tabindex="0" ` +
    `style="padding:8px 16px;border-top:1px solid var(--hairline);display:flex;justify-content:space-between;` +
    `cursor:pointer;color:var(--text)">` +
    `<span>${glyph} ${escapeHtml(label)}</span>` +
    `<span style="color:var(--accent);font-size:11px">open ›</span></div>`
  );
}

function fileRow(name: string, size: number): string {
  return (
    `<div style="padding:8px 16px;border-top:1px solid var(--hairline);display:flex;justify-content:space-between;` +
    `color:var(--text)">` +
    `<span>📄 ${escapeHtml(name)}</span>` +
    `<span style="color:var(--text-faint)">${size} B</span></div>`
  );
}

function loadingRow(): string {
  return `<div style="padding:22px 16px;color:var(--text-faint)">Loading via the host bridge…</div>`;
}

function emptyRow(detail: string): string {
  return (
    `<div style="padding:26px 16px;color:var(--text-faint);text-align:center">` +
    `<div style="font-size:13px;color:var(--text-muted);margin-bottom:6px">Nothing here</div>` +
    `<div style="font-size:12px">${escapeHtml(detail)}</div></div>`
  );
}

function joinPath(base: string, name: string): string {
  if (base === ROOT_PATH) return `/${name}`;

  return `${base}/${name}`;
}

function parentPath(path: string): string {
  const trimmed = path.replace(/\/+$/u, "");
  const slash = trimmed.lastIndexOf("/");

  if (slash <= 0) return ROOT_PATH;

  return trimmed.slice(0, slash);
}

// Resolve a delegated event target's nearest ancestor carrying `attr`, returning the attr value.
function closestAttr(event: unknown, attr: string): string | undefined {
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

// re-export the WmElement type to keep apps self-describing without re-importing it everywhere.
export type { WmElement };
