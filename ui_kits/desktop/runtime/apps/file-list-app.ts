// A small generic VitaApp factory for the apps that, today, simply present a DARK live listing of a
// fixed host path (Mail → /mail, Editor → /editor, Terminal → workspace /). They route through the
// SAME window manager + host bridge as Files; they are honest about being thin until they get real
// backends. This keeps the dock fully functional and dark-themed without bespoke renderers.
//
// Each is a VitaApp (see app-sdk.ts): mount renders into ctx.surface.root via ctx.host.requestFile.
// Token-driven (var(--surface)/var(--text)/var(--hairline)/var(--text-faint)).

import type {
  DesktopHost,
  FilesResponse,
} from "../../../../sdk/typescript/src/desktop-sdk/index.ts";
import {
  defineApp,
} from "../app-sdk.ts";
import type {
  AppCapability,
  AppContext,
  VitaApp,
} from "../app-sdk.ts";

type FilesListResponse = FilesResponse & {
  readonly error?: { readonly code: string; readonly message: string };
  readonly entries?: readonly { readonly name: string; readonly kind: string; readonly size: number }[];
};

export interface FileListAppSpec {
  readonly id: string;
  readonly title: string;
  readonly icon: string;
  readonly path: string;
  readonly label: string;
  readonly capabilities?: readonly AppCapability[];
}

export function createFileListApp(spec: FileListAppSpec): VitaApp {
  return defineApp({
    manifest: Object.freeze({
      capabilities: Object.freeze([...(spec.capabilities ?? ["files.read"])]),
      icon: spec.icon,
      id: spec.id,
      title: spec.title,
      window: "managed",
    }),
    mount(ctx: AppContext) {
      const root = ctx.surface.root;
      let disposed = false;

      root.style.cssText = "display:block;height:100%;background:var(--surface);color:var(--text)";
      root.innerHTML = loadingBody();
      ctx.window.setBadge(spec.path);

      void (async () => {
        const body = await renderListing(ctx.host, spec.path, spec.label);

        if (!disposed) root.innerHTML = body;
      })();

      return ctx.on("close", () => {
        disposed = true;
      });
    },
  });
}

async function renderListing(host: DesktopHost, path: string, label: string): Promise<string> {
  const requestFile = host.requestFile;

  if (requestFile === undefined) return emptyState(label, "The files backend is unavailable.");

  let response: FilesListResponse;

  try {
    response = await requestFile(Object.freeze({ op: "list", path }) as never) as FilesListResponse;
  } catch {
    return emptyState(label, "The backend failed closed.");
  }

  if (response.error !== undefined) {
    return emptyState(label, `${response.error.code}: ${response.error.message}`);
  }

  const entries = response.entries ?? [];

  if (entries.length === 0) return emptyState(label, `No entries under ${path}.`);

  const rows = entries.map((entry) => {
    const glyph = entry.kind === "dir" ? "📁" : "📄";

    return (
      `<div style="padding:8px 16px;border-top:1px solid var(--hairline);display:flex;justify-content:space-between;color:var(--text)">` +
      `<span>${glyph} ${escapeHtml(entry.name)}</span>` +
      `<span style="color:var(--text-faint)">${entry.kind === "dir" ? "" : `${entry.size} B`}</span></div>`
    );
  }).join("");

  return (
    `<div style="padding:6px 0"><div style="padding:4px 16px;color:var(--text-faint);font-size:11px">` +
    `${escapeHtml(label)} · ${entries.length} item${entries.length === 1 ? "" : "s"} ` +
    `(live: /var/lib/vita/files${path === "/" ? "" : path})</div>${rows}</div>`
  );
}

function loadingBody(): string {
  return `<div style="padding:22px 16px;color:var(--text-faint)">Loading via the host bridge…</div>`;
}

function emptyState(label: string, detail: string): string {
  return (
    `<div style="padding:26px 16px;color:var(--text-faint);text-align:center">` +
    `<div style="font-size:13px;color:var(--text-muted);margin-bottom:6px">${escapeHtml(label)} is empty</div>` +
    `<div style="font-size:12px">${escapeHtml(detail)}</div></div>`
  );
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}
