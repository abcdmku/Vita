// Puter compat — the DOM PickerUi (the actual picker WINDOWS in the multi-window shell).
//
// Renders the visible file/dir browser + font + color chooser windows that puter.ui.* pickers open,
// matching the shell's dark theme (kit.css vars). Each is a real overlay window in the WM parent (the
// `.v-screen`) so it sits above app iframes and the user can browse/select. Resolves a PickerChoice the
// picker-windows orchestrator turns into the SDK reply.
//
// Browser-only: structural DOM (house style, no DOM lib). The shell injects its `WmDocument`.

import type { PickerChoice, PickerFsEntry, PickerUi, PickerUiOpenRequest } from "./picker-windows.ts";
import type { WmDocument, WmElement } from "../window-manager.ts";

export interface PickerUiDomDeps {
  readonly doc: WmDocument & { getElementById?(id: string): WmElement | null; body?: WmElement };
}

const Z_PICKER = "9600"; // above the launcher (9000) + per-window modals; below alert/prompt (9500)? we sit above so a picker over an app is reachable.

export function createDomPickerUi(deps: PickerUiDomDeps): PickerUi {
  const { doc } = deps;

  function screen(): WmElement {
    return doc.querySelector?.(".v-screen") ?? (doc.body as WmElement);
  }

  function overlay(): { scrim: WmElement; card: WmElement; close: () => void } {
    const scrim = doc.createElement("div");

    scrim.setAttribute("data-shell-picker", "");
    scrim.style.cssText =
      `position:absolute;inset:0;z-index:${Z_PICKER};display:flex;align-items:center;justify-content:center;background:rgba(5,7,10,.5)`;

    const card = doc.createElement("div");

    card.style.cssText =
      "width:560px;max-width:90vw;max-height:78vh;display:flex;flex-direction:column;background:var(--surface-raised,#15171d);" +
      "border:1px solid var(--border,#262a33);border-radius:14px;box-shadow:var(--shadow-popover);color:var(--text,#e6e8ee);overflow:hidden";
    scrim.appendChild(card);
    screen().appendChild(scrim);

    return {
      card,
      close: () => {
        try {
          scrim.remove?.();
        } catch {
          // ignore
        }
      },
      scrim,
    };
  }

  return Object.freeze({
    async browse(request: PickerUiOpenRequest): Promise<PickerChoice> {
      return new Promise<PickerChoice>((resolve) => {
        const { card, scrim, close } = overlay();
        let currentDir = request.startDir;
        let selected: PickerFsEntry | null = null;

        card.innerHTML =
          `<div style="padding:14px 16px 10px;border-bottom:1px solid var(--border,#262a33);display:flex;align-items:center;justify-content:space-between">` +
          `<div style="font:600 14px system-ui" data-picker-title>${escapeHtml(request.title)}</div>` +
          `<div style="font:11px ui-monospace,monospace;color:var(--text-faint,#8b8f9c)" data-picker-path></div></div>` +
          `<div data-picker-list style="flex:1;overflow:auto;min-height:200px;padding:6px 8px"></div>` +
          (request.mode === "save"
            ? `<div style="padding:8px 16px;border-top:1px solid var(--border,#262a33)"><input data-picker-name placeholder="File name" style="width:100%;box-sizing:border-box;font:13px system-ui;padding:7px 10px;border-radius:8px;border:1px solid var(--border,#262a33);background:var(--surface,#0e0f13);color:var(--text,#e6e8ee)" /></div>`
            : "") +
          `<div style="padding:12px 16px;border-top:1px solid var(--border,#262a33);display:flex;gap:8px;justify-content:flex-end">` +
          `<button data-picker-cancel style="${btnCss(false)}">Cancel</button>` +
          `<button data-picker-ok style="${btnCss(true)}">${request.mode === "save" ? "Save" : request.mode === "directory" ? "Select Folder" : "Open"}</button></div>`;

        const list = q(card, "[data-picker-list]");
        const pathEl = q(card, "[data-picker-path]");
        const nameInput = q(card, "[data-picker-name]") as (WmElement & { value?: string }) | null;
        const okBtn = q(card, "[data-picker-ok]");
        const cancelBtn = q(card, "[data-picker-cancel]");

        if (nameInput !== null && request.suggestedName !== undefined) nameInput.value = request.suggestedName;

        const finish = (choice: PickerChoice): void => {
          close();
          resolve(choice);
        };

        async function render(dir: string): Promise<void> {
          currentDir = dir;
          selected = null;
          if (pathEl !== null) pathEl.textContent = dir;
          if (list === null) return;
          list.innerHTML = `<div style="padding:14px;color:var(--text-faint,#8b8f9c);font:12px system-ui">Loading…</div>`;

          let entries: readonly PickerFsEntry[] = [];

          try {
            entries = await request.listDir(dir);
          } catch {
            entries = [];
          }

          list.innerHTML = "";

          // "Up" row (disabled at the scope root — the window cannot climb above root).
          if (dir !== request.root && dir !== "/") {
            const up = row(doc, "⬆", "..", "var(--accent,#5b9dff)");

            up.addEventListener("click", (() => { void render(parentOf(dir)); }) as never);
            list.appendChild(up);
          }

          const dirs = entries.filter((e) => e.is_dir).sort(byName);
          const files = entries.filter((e) => !e.is_dir).sort(byName);

          for (const d of dirs) {
            const el = row(doc, "📁", d.name, "var(--text,#e6e8ee)");

            el.setAttribute("data-picker-entry", d.path);
            el.setAttribute("data-picker-dir", "1");
            el.addEventListener("click", (() => {
              if (request.mode === "directory") {
                selected = d;
                highlight(list, el);
              } else {
                void render(d.path);
              }
            }) as never);
            // Double-activate a dir always navigates into it.
            el.addEventListener("dblclick", (() => { void render(d.path); }) as never);
            list.appendChild(el);
          }

          if (request.mode !== "directory") {
            for (const f of files) {
              const el = row(doc, "📄", `${f.name}`, "var(--text-secondary,#c7cad3)");

              el.setAttribute("data-picker-entry", f.path);
              el.addEventListener("click", (() => {
                selected = f;
                highlight(list, el);
                if (nameInput !== null) nameInput.value = f.name;
              }) as never);
              el.addEventListener("dblclick", (() => {
                selected = f;
                confirmOpen();
              }) as never);
              list.appendChild(el);
            }
          }

          if (dirs.length === 0 && files.length === 0) {
            const empty = doc.createElement("div");

            empty.style.cssText = "padding:14px;color:var(--text-faint,#8b8f9c);font:12px system-ui";
            empty.textContent = "(empty folder)";
            list.appendChild(empty);
          }
        }

        function confirmOpen(): void {
          if (request.mode === "open") {
            if (selected === null || selected.is_dir) return;
            finish({ kind: "open", paths: [selected.path] });
            return;
          }

          if (request.mode === "directory") {
            const dir = selected !== null && selected.is_dir ? selected.path : currentDir;

            finish({ kind: "directory", paths: [dir] });
            return;
          }

          // save
          const name = (nameInput?.value ?? request.suggestedName ?? "Untitled.txt").trim();

          if (name === "") return;
          const dest = currentDir === "/" ? `/${name}` : `${currentDir}/${name}`;

          finish({ kind: "save", path: dest });
        }

        okBtn?.addEventListener("click", (() => confirmOpen()) as never);
        cancelBtn?.addEventListener("click", (() => finish({ kind: "cancel" })) as never);
        scrim.addEventListener("click", ((ev: { target?: unknown }) => {
          if (ev.target === scrim) finish({ kind: "cancel" });
        }) as never);

        void render(request.startDir);
      });
    },
    async pickColor(options): Promise<string | null> {
      return new Promise<string | null>((resolve) => {
        const { card, scrim, close } = overlay();
        const swatches = ["#e0524a", "#e08a2a", "#e6c84a", "#4caf72", "#5b9dff", "#7c5cff", "#c75cff", "#ffffff", "#9aa0ad", "#0e0f13"];

        card.style.setProperty("width", "340px");
        card.innerHTML =
          `<div style="padding:14px 16px;border-bottom:1px solid var(--border,#262a33);font:600 14px system-ui">Pick a Color</div>` +
          `<div style="padding:16px;display:flex;flex-wrap:wrap;gap:10px" data-color-grid></div>` +
          `<div style="padding:10px 16px 16px;display:flex;align-items:center;gap:10px">` +
          `<input data-color-input type="text" value="${escapeHtml(options.defaultColor)}" style="flex:1;font:13px ui-monospace,monospace;padding:7px 10px;border-radius:8px;border:1px solid var(--border,#262a33);background:var(--surface,#0e0f13);color:var(--text,#e6e8ee)" />` +
          `<button data-color-ok style="${btnCss(true)}">Choose</button></div>`;

        const grid = q(card, "[data-color-grid]");
        const input = q(card, "[data-color-input]") as (WmElement & { value?: string }) | null;
        const ok = q(card, "[data-color-ok]");

        const finish = (value: string | null): void => { close(); resolve(value); };

        for (const c of swatches) {
          const sw = doc.createElement("div");

          sw.setAttribute("data-color-swatch", c);
          sw.style.cssText = `width:34px;height:34px;border-radius:8px;cursor:pointer;border:2px solid var(--border,#262a33);background:${c}`;
          sw.addEventListener("click", (() => { if (input !== null) input.value = c; finish(c); }) as never);
          grid?.appendChild(sw);
        }

        ok?.addEventListener("click", (() => finish((input?.value ?? options.defaultColor).trim() || options.defaultColor)) as never);
        scrim.addEventListener("click", ((ev: { target?: unknown }) => { if (ev.target === scrim) finish(null); }) as never);
      });
    },
    async pickFont(options): Promise<string | null> {
      return new Promise<string | null>((resolve) => {
        const { card, scrim, close } = overlay();
        const fonts = ["System UI", "Arial", "Helvetica", "Georgia", "Times New Roman", "Courier New", "Verdana", "Trebuchet MS", "Comic Sans MS", "Monospace"];

        card.style.setProperty("width", "360px");
        card.innerHTML =
          `<div style="padding:14px 16px;border-bottom:1px solid var(--border,#262a33);font:600 14px system-ui">Pick a Font</div>` +
          `<div data-font-list style="max-height:300px;overflow:auto;padding:8px"></div>` +
          `<div style="padding:12px 16px;display:flex;gap:8px;justify-content:flex-end">` +
          `<button data-font-cancel style="${btnCss(false)}">Cancel</button></div>`;

        const fontList = q(card, "[data-font-list]");
        const cancel = q(card, "[data-font-cancel]");
        const finish = (value: string | null): void => { close(); resolve(value); };

        for (const f of fonts) {
          const el = doc.createElement("div");

          el.setAttribute("data-font-entry", f);
          el.style.cssText = `padding:9px 12px;border-radius:8px;cursor:pointer;font-family:'${f}';font-size:14px;color:var(--text,#e6e8ee)`;
          el.textContent = f;
          el.addEventListener("mouseenter", (() => el.style.setProperty("background", "var(--surface,#0e0f13)")) as never);
          el.addEventListener("mouseleave", (() => el.style.setProperty("background", "transparent")) as never);
          el.addEventListener("click", (() => finish(f)) as never);
          fontList?.appendChild(el);
        }

        cancel?.addEventListener("click", (() => finish(null)) as never);
        scrim.addEventListener("click", ((ev: { target?: unknown }) => { if (ev.target === scrim) finish(null); }) as never);
      });
    },
  });
}

// ----- small DOM helpers -----

function row(doc: WmDocument, glyph: string, label: string, color: string): WmElement {
  const el = doc.createElement("div");

  el.classList.add("v-picker-row");
  el.style.cssText =
    `display:flex;align-items:center;gap:10px;padding:8px 10px;border-radius:8px;cursor:pointer;font:13px system-ui;color:${color}`;
  el.innerHTML = `<span style="font-size:16px;width:20px;text-align:center">${glyph}</span><span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escapeHtml(label)}</span>`;
  el.addEventListener("mouseenter", (() => el.style.setProperty("background", "var(--surface,#0e0f13)")) as never);
  el.addEventListener("mouseleave", (() => { if (el.getAttribute?.("data-selected") !== "1") el.style.setProperty("background", "transparent"); }) as never);
  return el;
}

function highlight(list: WmElement | null, el: WmElement): void {
  if (list === null) return;

  const all = list.querySelectorAll?.("[data-picker-entry]");

  if (all !== undefined) {
    for (let i = 0; i < all.length; i += 1) {
      const item = all[i];

      item?.setAttribute("data-selected", "0");
      item?.style.setProperty("background", "transparent");
    }
  }

  el.setAttribute("data-selected", "1");
  el.style.setProperty("background", "var(--accent-soft,rgba(91,157,255,.18))");
}

function parentOf(path: string): string {
  const p = path.replace(/\/+$/u, "");
  const slash = p.lastIndexOf("/");

  return slash <= 0 ? "/" : p.slice(0, slash);
}

function byName(a: { name: string }, b: { name: string }): number {
  return a.name.localeCompare(b.name);
}

function btnCss(primary: boolean): string {
  return (
    "font:13px system-ui;padding:7px 14px;border-radius:8px;cursor:pointer;border:1px solid " +
    (primary ? "transparent" : "var(--border,#262a33)") + ";" +
    (primary ? "background:var(--accent,#5b9dff);color:#0a0c10" : "background:var(--surface,#0e0f13);color:var(--text,#e6e8ee)")
  );
}

function q(root: WmElement, selector: string): WmElement | null {
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
