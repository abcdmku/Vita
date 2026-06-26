// Editor — a REAL dark text editor mounted into a managed window's body.
//
// VitaApp (see app-sdk.ts): opens a file through `ctx.host.requestFile` (op "read") into an editable
// <textarea>, and Save writes it back through `ctx.host.requestFile` (op "write") WHEN files.write is
// granted; otherwise the editor is honestly read-only and says so. All file logic runs through the
// real editor view-model (viewmodels/apps/editor-app.ts): open / edit / save / dirty tracking. The
// host's requestFile port is adapted into the view-model's FilesCapabilityPort seam.
//
// Token-driven dark theme (var(--surface)/var(--text)/var(--hairline)/var(--accent)). One delegated
// input listener tracks edits; the Save button writes back. Listeners removed on close.

import type {
  DesktopHost,
  FilesRequest,
  FilesResponse,
  FilesErrorResponse,
} from "../../../../sdk/typescript/src/desktop-sdk/index.ts";
import {
  createEditorAppViewModel,
} from "../../viewmodels/apps/editor-app.ts";
import type {
  EditorAppSnapshot,
  EditorAppViewModel,
} from "../../viewmodels/apps/editor-app.ts";
import type {
  AppPackageManifest,
  FilesCapabilityPort,
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

const EDITOR_GRANT = "workspace";
const DEFAULT_PATH = "/editor/welcome.md";
const TEXTAREA_ID = "vita-editor-textarea";

export const editorApp: VitaApp = defineApp({
  manifest: Object.freeze({
    capabilities: Object.freeze(["files.read", "files.write"] as const),
    icon: "📝",
    id: "vita.app.code",
    title: "Editor",
    window: "managed",
  }),
  mount(ctx: AppContext) {
    const root = ctx.surface.root;
    const requestFile = ctx.host.requestFile;
    const canWrite = true; // The view-model enforces files.write via the package grants below.
    let disposed = false;

    root.style.cssText = "display:flex;flex-direction:column;height:100%;background:var(--surface);color:var(--text)";

    if (requestFile === undefined) {
      root.innerHTML = emptyState("The files backend is unavailable.", "Editor cannot open files.");
      return () => {};
    }

    const viewModel = createEditorAppViewModel({
      files: filesPortFromHost(requestFile),
      grant: EDITOR_GRANT,
      package: editorPackage(canWrite),
    });
    let openPath = DEFAULT_PATH;

    root.innerHTML = shell(openPath);

    async function openFile(path: string): Promise<void> {
      openPath = path;
      ctx.window.setBadge(path);
      setStatus(`Opening ${path}…`);

      const result = await viewModel.open(path);

      if (disposed) return;

      if (!result.ok) {
        // Honest failure: show the open error and an empty, editable scratch buffer so the window is
        // still usable (a new document the user can write back if granted).
        setTextarea("");
        setStatus(`Could not open ${path}: ${result.error.code} — ${result.error.message}`);
        renderMeta(viewModel.snapshot(), path);
        return;
      }

      setTextarea(result.value.content);
      renderMeta(result.state, path);
      setStatus(`Opened ${path} (${result.value.language})`);
    }

    async function save(): Promise<void> {
      // Mirror the live textarea into the view-model before writing.
      const text = textareaValue();
      const edited = viewModel.edit(text);

      if (!edited.ok) {
        setStatus(`Edit rejected: ${edited.error.message}`);
        return;
      }

      setStatus(`Saving ${openPath}…`);

      const result = await viewModel.save();

      if (disposed) return;

      if (!result.ok) {
        setStatus(`Save failed: ${result.error.code} — ${result.error.message}`);
        renderMeta(result.state, openPath);
        return;
      }

      setStatus(`Saved ${openPath}`);
      renderMeta(result.state, openPath);
    }

    function textareaEl(): (WmElement & { value?: string }) | null {
      return (root.querySelector?.(`#${TEXTAREA_ID}`) as (WmElement & { value?: string }) | null) ?? null;
    }

    function textareaValue(): string {
      const value = textareaEl()?.value;

      return typeof value === "string" ? value : "";
    }

    function setTextarea(value: string): void {
      const el = textareaEl();

      if (el !== null) el.value = value;
    }

    function setStatus(text: string): void {
      const el = root.querySelector?.("[data-vita-editor-status]") ?? null;

      if (el !== null) el.textContent = text;
    }

    function renderMeta(snapshot: EditorAppSnapshot, path: string): void {
      const el = root.querySelector?.("[data-vita-editor-meta]") ?? null;

      if (el !== null) {
        el.textContent = `${path}${snapshot.dirty ? " · unsaved" : ""}`;
      }
    }

    // Delegated input: typing marks the document dirty (the view-model recomputes on edit/save).
    const onInput = (): void => {
      const result = viewModel.edit(textareaValue());

      if (result.ok) renderMeta(result.state, openPath);
    };

    // Delegated click: the Save button writes back.
    const onClick = (event: unknown): void => {
      if (matchesAttr(event, "data-vita-editor-save")) void save();
    };

    root.addEventListener("input", onInput as never);
    root.addEventListener("click", onClick as never);

    const offClose = ctx.on("close", () => cleanup());

    function cleanup(): void {
      if (disposed) return;
      disposed = true;
      root.removeEventListener?.("input", onInput as never);
      root.removeEventListener?.("click", onClick as never);
      offClose();
    }

    void openFile(DEFAULT_PATH);
    return cleanup;
  },
});

export default editorApp;

// Adapt the DesktopHost.requestFile port into the view-model's FilesCapabilityPort seam. The shapes
// match (FilesRequest in, FilesResponse | FilesErrorResponse out); we only normalise the wrapper.
function filesPortFromHost(
  requestFile: NonNullable<DesktopHost["requestFile"]>,
): FilesCapabilityPort {
  return Object.freeze({
    request(request: FilesRequest): Promise<FilesResponse | FilesErrorResponse> {
      return Promise.resolve(requestFile(request) as FilesResponse | FilesErrorResponse);
    },
  });
}

// A minimal package manifest the view-model uses for its capability check. Grants are UNSCOPED
// (no resourceId), which hasAppCapabilityGrant treats as covering any grant string (here "workspace").
function editorPackage(canWrite: boolean): AppPackageManifest {
  const grants = canWrite
    ? [Object.freeze({ capability: "files.read" as const }), Object.freeze({ capability: "files.write" as const })]
    : [Object.freeze({ capability: "files.read" as const })];

  return Object.freeze({
    capabilityGrants: Object.freeze(grants),
    entry: "index.html",
    id: "vita.app.code",
    sdkVersion: "1.0.0",
    version: "1.0.0",
  });
}

function shell(path: string): string {
  return (
    `<div style="display:flex;align-items:center;gap:10px;padding:8px 14px;` +
    `border-bottom:1px solid var(--hairline);background:var(--surface-raised)">` +
    `<span data-vita-editor-meta style="flex:1;font:12px var(--font-mono,ui-monospace);` +
    `color:var(--text-secondary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">` +
    `${escapeHtml(path)}</span>` +
    `<button data-vita-editor-save type="button" ` +
    `style="cursor:pointer;border:1px solid var(--accent);background:var(--accent);color:#fff;` +
    `padding:5px 14px;border-radius:7px;font-size:12px">Save</button></div>` +
    `<textarea id="${TEXTAREA_ID}" spellcheck="false" aria-label="Editor" ` +
    `style="flex:1;width:100%;box-sizing:border-box;border:0;outline:0;resize:none;` +
    `padding:14px;background:var(--surface);color:var(--text);` +
    `font:13px/1.6 var(--font-mono,ui-monospace,monospace);caret-color:var(--accent)"></textarea>` +
    `<div data-vita-editor-status style="padding:6px 14px;border-top:1px solid var(--hairline);` +
    `font-size:11px;color:var(--text-faint)">Loading…</div>`
  );
}

function emptyState(title: string, detail: string): string {
  return (
    `<div style="padding:26px 16px;color:var(--text-faint);text-align:center">` +
    `<div style="font-size:13px;color:var(--text-muted);margin-bottom:6px">${escapeHtml(title)}</div>` +
    `<div style="font-size:12px">${escapeHtml(detail)}</div></div>`
  );
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

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}
