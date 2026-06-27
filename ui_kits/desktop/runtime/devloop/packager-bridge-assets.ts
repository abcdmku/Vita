// Vita dev-loop — PACKAGER BRIDGE assets: the served-file builders for each generated kind.
//
// Authoring helpers for the packager bridge. Each builder returns the ScaffoldFile[] for a served app
// directory (manifest + index.html + supporting files) that runs against the new platform's api_origin.
// Kept separate from packager-bridge.ts (orchestration) so each file stays focused. Pure, portable.

import type { ScaffoldFile } from "./scaffold.ts";

export type ServedKindArgs =
  | { readonly kind?: never; readonly appDir: string; readonly title: string; readonly icon: string; readonly command: string; readonly backendWired: boolean }
  | { readonly appDir: string; readonly title: string; readonly icon: string; readonly html: string; readonly webRel: string }
  | { readonly appDir: string; readonly title: string; readonly icon: string; readonly moduleSource: string };

interface CmdArgs { readonly appDir: string; readonly title: string; readonly icon: string; readonly command: string; readonly backendWired: boolean }
interface WebArgs { readonly appDir: string; readonly title: string; readonly icon: string; readonly html: string; readonly webRel: string }
interface MountArgs { readonly appDir: string; readonly title: string; readonly icon: string; readonly moduleSource: string }

// Dispatch by kind. Typed loosely at the boundary; each branch narrows.
export function scaffoldFilesIcon(kind: "cmd" | "web" | "mount", args: CmdArgs | WebArgs | MountArgs): readonly ScaffoldFile[] {
  if (kind === "cmd") return cmdFiles(args as CmdArgs);
  if (kind === "web") return webFiles(args as WebArgs);

  return mountFiles(args as MountArgs);
}

function joinPath(dir: string, name: string): string {
  const base = dir.replace(/\/+$/, "");

  return base === "" ? `/${name}` : `${base}/${name}`;
}

function manifestFile(appDir: string, title: string, icon: string, kind: string): ScaffoldFile {
  const manifest = {
    entry: "index.html",
    generatedBy: "vita-packager-bridge",
    icon,
    kind,
    sdk: { apiOriginParam: "puter.api_origin", puter: "v2" },
    surfaceKind: "web",
    title,
  };

  return { content: JSON.stringify(manifest, null, 2) + "\n", path: joinPath(appDir, "manifest.json") };
}

// ---- cmd: a served terminal-style page scoped to the package's command. ----
function cmdFiles(a: CmdArgs): readonly ScaffoldFile[] {
  const html = `<!doctype html>
<!-- ${escapeHtml(a.title)} — packaged CMD app (Vita-generated). Apache-2.0 SDK only. -->
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(a.title)}</title>
  <link rel="stylesheet" href="./app.css" />
  <script>window.PUTER_API_ORIGIN = window.location.origin + "/api"; window.puter_gui_enabled = false;</script>
  <script src="/_vendor/puter/v2.js"></script>
  <script src="/session.js"></script>
</head>
<body>
  <main class="term">
    <header class="bar"><span class="ic">${escapeHtml(a.icon)}</span> ${escapeHtml(a.title)}
      <span class="badge">${a.backendWired ? "shell" : "no exec backend"}</span></header>
    <div id="scroll" class="scroll"></div>
    <div class="prompt"><span class="ps">${escapeHtml(a.command)} $</span>
      <input id="in" autocomplete="off" autocapitalize="off" spellcheck="false" aria-label="Command input" /></div>
  </main>
  <script type="module" src="./app.js"></script>
</body>
</html>
`;

  const js = `// ${a.title} — packaged cmd surface (Vita-generated). HONEST: with no capsule exec transport wired,
// it echoes args locally (the same posture the WM packager's cmd surface takes). Real out-of-process
// execution lands with the capsule exec transport.
const COMMAND = ${JSON.stringify(a.command)};
const BACKEND = ${JSON.stringify(a.backendWired)};
const scroll = document.getElementById("scroll");
const input = document.getElementById("in");
function line(text, kind) { const d = document.createElement("div"); if (kind) d.className = kind; d.textContent = text; scroll.appendChild(d); scroll.scrollTop = scroll.scrollHeight; }
line("Vita packaged command: " + COMMAND, "out");
line(BACKEND ? "Connected to the host exec port (sync bridge pending)." : "No exec backend is wired yet — type args; output is a local echo (try: help).", "out");
input.addEventListener("keydown", (e) => {
  if (e.key !== "Enter") return;
  const typed = input.value.trim(); input.value = "";
  line(COMMAND + " $ " + typed, "in");
  if (typed === "") return;
  if (typed === "clear") { scroll.innerHTML = ""; return; }
  if (typed === "help") { line(COMMAND + " <args> — runs the packaged command. Built-ins: clear, help.", "out"); return; }
  if (BACKEND) { line("exec backend present but not yet sync-bridged: " + COMMAND + " " + typed, "err"); return; }
  line(COMMAND + ": " + typed, "out");
  line("(no exec backend wired — output is a local echo; real execution lands with the capsule exec transport.)", "out");
});
input.focus();
window.__appReady = true;
`;

  const css = `:root{--bg:#0e1116;--surface:#161b22;--hairline:#2a313c;--text:#e6edf3;--muted:#9aa7b4;--accent:#42d18a;--err:#f87171}
*{box-sizing:border-box}html,body{margin:0;height:100%}body{background:var(--bg);color:var(--text);font:13px/1.55 ui-monospace,Consolas,monospace}
.term{display:flex;flex-direction:column;height:100%}
.bar{align-items:center;background:var(--surface);border-bottom:1px solid var(--hairline);display:flex;gap:8px;font-weight:650;padding:10px 14px}
.ic{font-size:16px}.badge{background:#1c232c;border:1px solid var(--hairline);border-radius:10px;color:var(--muted);font-size:11px;margin-left:auto;padding:2px 8px}
.scroll{flex:1;overflow:auto;padding:12px 14px;white-space:pre-wrap;word-break:break-word}
.scroll .in{color:var(--accent)}.scroll .err{color:var(--err)}.scroll .out{color:var(--muted)}
.prompt{align-items:center;background:var(--surface);border-top:1px solid var(--hairline);display:flex;gap:8px;padding:8px 14px}
.ps{color:var(--accent);user-select:none}
#in{background:transparent;border:0;caret-color:var(--accent);color:var(--text);flex:1;font:inherit;outline:0}
`;

  return Object.freeze([
    manifestFile(a.appDir, a.title, a.icon, "cmd"),
    { content: html, path: joinPath(a.appDir, "index.html") },
    { content: js, path: joinPath(a.appDir, "app.js") },
    { content: css, path: joinPath(a.appDir, "app.css") },
  ]);
}

// ---- web: serve the package's OWN html entry as index.html (sibling assets copied by the bridge). ----
function webFiles(a: WebArgs): readonly ScaffoldFile[] {
  // Inject the SDK boot wiring into the package HTML's <head> if it does not already wire puter.js, so a
  // plain web package still reaches Vita's api_origin. If it already references /_vendor/puter, leave it.
  const html = wireSdkIntoHtml(a.html);

  return Object.freeze([
    manifestFile(a.appDir, a.title, a.icon, "desktop"),
    { content: html, path: joinPath(a.appDir, "index.html") },
  ]);
}

// ---- mount: a served host page that imports the package's module + calls its mount(root, host). ----
function mountFiles(a: MountArgs): readonly ScaffoldFile[] {
  const html = `<!doctype html>
<!-- ${escapeHtml(a.title)} — packaged UI app (Vita-generated host for a mount(root) module). -->
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(a.title)}</title>
  <link rel="stylesheet" href="./app.css" />
  <script>window.PUTER_API_ORIGIN = window.location.origin + "/api"; window.puter_gui_enabled = false;</script>
  <script src="/_vendor/puter/v2.js"></script>
  <script src="/session.js"></script>
</head>
<body>
  <div id="root" class="root"></div>
  <script type="module" src="./host.js"></script>
</body>
</html>
`;

  // The host imports the package module + calls its default/mount with the root element. The package
  // source is written verbatim as package.mjs (the offline-installed module, unchanged).
  const host = `// Vita-generated host: load the packaged UI module and mount it into #root, wired to the api_origin.
import * as mod from "./package.mjs";
const root = document.getElementById("root");
const mount = (typeof mod.default === "function" && !(mod.default && mod.default.manifest)) ? mod.default
            : (typeof mod.mount === "function" ? mod.mount : null);
const host = { capabilities: ${JSON.stringify([])}, title: ${JSON.stringify(a.title)} };
try {
  if (mount) { mount(root, host); }
  else if (mod.default && mod.default.manifest && typeof mod.default.mount === "function") {
    // A full VitaApp default export — adapt its AppContext minimally (surface.root only) for the web host.
    mod.default.mount({ surface: { root }, window: { setTitle(){}, setBadge(){}, requestClose(){} }, on(){ return () => {}; } });
  } else { root.textContent = "Packaged module exposed no mount(root) or VitaApp default export."; }
  window.__appReady = true;
} catch (err) { root.textContent = "Packaged UI failed: " + (err && err.message ? err.message : String(err)); }
`;

  const css = `:root{--bg:#0e1116;--surface:#161b22;--text:#e6edf3;--text-secondary:#9aa7b4;--text-faint:#6b7682;--hairline:#2a313c;--accent:#5b8cff;--font-mono:ui-monospace,Consolas,monospace}
*{box-sizing:border-box}html,body{margin:0;height:100%}body{background:var(--bg);color:var(--text);font-family:Inter,system-ui,-apple-system,"Segoe UI",sans-serif}
.root{height:100%}
`;

  return Object.freeze([
    manifestFile(a.appDir, a.title, a.icon, "desktop"),
    { content: html, path: joinPath(a.appDir, "index.html") },
    { content: host, path: joinPath(a.appDir, "host.js") },
    { content: a.moduleSource, path: joinPath(a.appDir, "package.mjs") },
    { content: css, path: joinPath(a.appDir, "app.css") },
  ]);
}

// Wire the puter.js SDK boot into a plain web package's HTML head if absent.
function wireSdkIntoHtml(html: string): string {
  if (/_vendor\/puter\/v2\.js/.test(html)) return html;

  const inject =
    `\n  <script>window.PUTER_API_ORIGIN = window.location.origin + "/api"; window.puter_gui_enabled = false;</script>` +
    `\n  <script src="/_vendor/puter/v2.js"></script>` +
    `\n  <script src="/session.js"></script>`;

  if (/<head[^>]*>/i.test(html)) return html.replace(/<head[^>]*>/i, (m) => m + inject);
  if (/<html[^>]*>/i.test(html)) return html.replace(/<html[^>]*>/i, (m) => m + "<head>" + inject + "</head>");

  return `<head>${inject}</head>` + html;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}
