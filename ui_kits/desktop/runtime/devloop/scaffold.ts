// Vita dev-loop — the "NEW APP" SCAFFOLD generator (Vita's own code; AGPL-clean).
//
// Generates a MINIMAL RUNNABLE Vita/Puter app as a set of files: a manifest, an index.html with the
// puter.js SDK wired to the LOCAL api_origin (same boot wiring as the kiosk entry / editor), an app.js
// that proves it talks to puter.fs/kv, and an app.css. The flow writes these into the owner's space via
// `puter.fs` so the app is IMMEDIATELY runnable in the desktop (open its index.html in a browser face /
// launch it from the dock).
//
// PURE + transport-agnostic: this module returns a file map; it does NOT do I/O. The in-browser "New
// App" UI writes the map with `puter.fs.write`; the on-device launcher writes it with the native fs
// binding; a test writes it to a temp store. One generator, many writers.
//
// Strict TS, portable (no DOM lib): no `document`/`window`/`fetch` here.

// A scoped/unscoped npm-style id is NOT required — the app id is derived from the human name. The
// generated app lives under <appsDir>/<slug> (default appsDir = "/home/apps").

export interface ScaffoldInput {
  // The human app name (e.g. "Hello Vita"). Required.
  readonly name: string;
  // Optional one-line description shown in the app + manifest.
  readonly description?: string;
  // Where the app directory is created. Default "/home/apps". The app dir is `${appsDir}/${slug}`.
  readonly appsDir?: string;
  // Optional explicit slug (else derived from the name). Lowercased, non-alnum -> "-".
  readonly slug?: string;
  // Optional emoji/glyph icon. Default "✨".
  readonly icon?: string;
}

// One generated file: a path RELATIVE to the app directory and its UTF-8 text content.
export interface ScaffoldFile {
  readonly path: string; // relative, e.g. "index.html"
  readonly content: string;
}

export interface ScaffoldResult {
  // The slug + the absolute app directory the files live under.
  readonly slug: string;
  readonly appId: string; // e.g. "vita.app.hello-vita"
  readonly appDir: string; // e.g. "/home/apps/hello-vita"
  // The entry HTML's absolute path (the page a browser face opens to run the app).
  readonly entryPath: string; // e.g. "/home/apps/hello-vita/index.html"
  // The files to write, each with an ABSOLUTE path under appDir (ready for puter.fs.write).
  readonly files: readonly ScaffoldFile[];
  // The manifest object (also serialized into files as manifest.json).
  readonly manifest: ScaffoldManifest;
}

// The minimal Vita app manifest the scaffold emits. Mirrors the platform's app descriptor shape: an id,
// a title, an entry, declared capability grants (advisory at the SDK layer), and the surface kind.
export interface ScaffoldManifest {
  readonly id: string;
  readonly title: string;
  readonly description: string;
  readonly icon: string;
  readonly entry: string; // "index.html"
  readonly surfaceKind: "web";
  readonly capabilities: readonly string[];
  readonly sdk: { readonly puter: "v2"; readonly apiOriginParam: "puter.api_origin" };
}

const DEFAULT_APPS_DIR = "/home/apps";

// Derive a filesystem-safe slug from a human name.
export function slugify(name: string): string {
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

  return slug.length > 0 ? slug : "app";
}

// Join a dir + a name without double slashes (the app namespace never touches root "/").
function joinPath(dir: string, name: string): string {
  const base = dir.replace(/\/+$/, "");

  return base === "" ? `/${name}` : `${base}/${name}`;
}

// Generate the runnable app file set. Pure — returns the files; the caller writes them.
export function scaffoldApp(input: ScaffoldInput): ScaffoldResult {
  const name = (input.name ?? "").trim();

  if (name === "") throw new Error("scaffoldApp: a non-empty name is required");

  const slug = (input.slug && input.slug.length > 0) ? slugify(input.slug) : slugify(name);
  const appsDir = (input.appsDir && input.appsDir.length > 0) ? input.appsDir : DEFAULT_APPS_DIR;
  const appDir = joinPath(appsDir, slug);
  const appId = `vita.app.${slug}`;
  const icon = input.icon ?? "✨";
  const description = input.description ?? `${name} — a Vita app scaffolded by the dev loop.`;

  const manifest: ScaffoldManifest = Object.freeze({
    capabilities: Object.freeze(["files.read", "files.write"]),
    description,
    entry: "index.html",
    icon,
    id: appId,
    sdk: Object.freeze({ apiOriginParam: "puter.api_origin" as const, puter: "v2" as const }),
    surfaceKind: "web" as const,
    title: name,
  });

  const files: ScaffoldFile[] = [
    { content: manifestJson(manifest), path: joinPath(appDir, "manifest.json") },
    { content: indexHtml(name, description, icon), path: joinPath(appDir, "index.html") },
    { content: appJs(name), path: joinPath(appDir, "app.js") },
    { content: appCss(), path: joinPath(appDir, "app.css") },
    { content: readme(name, appId, appDir), path: joinPath(appDir, "README.md") },
  ];

  return Object.freeze({
    appDir,
    appId,
    entryPath: joinPath(appDir, "index.html"),
    files: Object.freeze(files),
    manifest,
    slug,
  });
}

function manifestJson(manifest: ScaffoldManifest): string {
  return JSON.stringify(manifest, null, 2) + "\n";
}

// The runnable entry page. SAME boot wiring as the kiosk entry: pin PUTER_API_ORIGIN, load the vendored
// Apache-2.0 puter.js SDK same-origin, load /session.js, then the app's own module. AGPL-clean.
function indexHtml(name: string, description: string, icon: string): string {
  const safeName = escapeHtml(name);
  const safeDesc = escapeHtml(description);
  const safeIcon = escapeHtml(icon);

  return `<!doctype html>
<!-- ${safeName} — scaffolded by the Vita dev loop. Vita app code (AGPL-clean); only the vendored
     puter.js SDK (/_vendor/puter/v2.js, Apache-2.0) is third-party. -->
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
  <title>${safeName}</title>
  <link rel="icon" href="data:," />
  <link rel="stylesheet" href="./app.css" />
  <!-- Pin the SDK at our same-origin /api BEFORE v2.js loads (no cloud race). -->
  <script>window.PUTER_API_ORIGIN = window.location.origin + "/api"; window.puter_gui_enabled = false;</script>
  <script src="/_vendor/puter/v2.js"></script>
  <script src="/session.js"></script>
</head>
<body>
  <main class="app">
    <h1><span class="icon">${safeIcon}</span> ${safeName}</h1>
    <p class="desc">${safeDesc}</p>
    <section class="card">
      <div class="row"><span>whoami</span><code id="who">…</code></div>
      <div class="row"><span>api_origin</span><code id="origin">…</code></div>
    </section>
    <section class="card">
      <h2>It runs. Prove it persists.</h2>
      <p class="muted">This counter is stored in <code>puter.kv</code> against Vita's api_origin. Reload to confirm it sticks.</p>
      <button id="bump" class="btn">Clicks: <span id="count">0</span></button>
    </section>
    <div id="boot" class="boot">Starting ${safeName}…</div>
  </main>
  <script type="module" src="./app.js"></script>
</body>
</html>
`;
}

// The app's own logic: await the SDK, prove whoami + a KV-persisted counter. Real puter.* calls.
function appJs(name: string): string {
  const kvKey = `scaffold.${slugify(name)}.clicks`;

  return `// ${name} — app logic (scaffolded). Real puter.* calls against Vita's local api_origin.
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getPuter(timeoutMs = 10000) {
  const start = Date.now();
  const wantToken = !window.__vitaSession || window.__vitaSession.hasToken !== false;
  for (;;) {
    const p = window.puter;
    if (p && p.kv && p.auth) {
      try { p.quiet = true; } catch (_) {}
      const tokenReady = !wantToken || (typeof p.authToken === "string" && p.authToken.length > 0);
      if (tokenReady) return p;
    }
    if (Date.now() - start > timeoutMs) { if (window.puter) return window.puter; throw new Error("SDK not ready"); }
    await sleep(40);
  }
}

const KV_KEY = ${JSON.stringify(kvKey)};

(async () => {
  const boot = document.getElementById("boot");
  try {
    const puter = await getPuter();
    document.getElementById("origin").textContent = puter.APIOrigin || (location.origin + "/api");
    try { const me = await puter.auth.getUser(); document.getElementById("who").textContent = (me && me.username) || "owner"; }
    catch (_) { document.getElementById("who").textContent = "owner"; }

    let count = Number(await puter.kv.get(KV_KEY)) || 0;
    const countEl = document.getElementById("count");
    countEl.textContent = String(count);
    document.getElementById("bump").addEventListener("click", async () => {
      count += 1; countEl.textContent = String(count);
      await puter.kv.set(KV_KEY, String(count));
    });

    boot.style.display = "none";
    window.__appReady = true;
  } catch (err) {
    boot.textContent = "Failed: " + (err && err.message ? err.message : String(err));
  }
})();
`;
}

function appCss(): string {
  return `:root { --bg:#0e1116; --surface:#161b22; --hairline:#2a313c; --text:#e6edf3; --muted:#9aa7b4; --accent:#5b8cff; }
* { box-sizing: border-box; }
html, body { margin: 0; height: 100%; }
body { background: var(--bg); color: var(--text); font-family: Inter, system-ui, -apple-system, "Segoe UI", sans-serif; }
.app { max-width: 560px; margin: 0 auto; padding: 32px 20px; }
h1 { font-size: 22px; display: flex; align-items: center; gap: 10px; }
.icon { font-size: 24px; }
.desc { color: var(--muted); }
.card { background: var(--surface); border: 1px solid var(--hairline); border-radius: 10px; padding: 16px; margin-top: 16px; }
.card h2 { font-size: 15px; margin: 0 0 6px; }
.muted { color: var(--muted); font-size: 13px; }
.row { display: flex; justify-content: space-between; gap: 12px; padding: 4px 0; font-size: 13px; }
code { font-family: ui-monospace, Consolas, monospace; color: var(--accent); word-break: break-all; }
.btn { background: var(--accent); border: 0; border-radius: 8px; color: #fff; cursor: pointer; font: 600 14px/1 inherit; margin-top: 10px; padding: 10px 16px; }
.boot { color: var(--muted); margin-top: 20px; font-size: 13px; }
`;
}

function readme(name: string, appId: string, appDir: string): string {
  return `# ${name}

A minimal runnable Vita app scaffolded by the dev loop.

- **App id:** \`${appId}\`
- **Location:** \`${appDir}\`
- **Entry:** \`index.html\` (loads the Apache-2.0 puter.js SDK, wired to Vita's local api_origin)

Open \`index.html\` in a Vita browser face (or launch the app from the dock) to run it. It proves it
talks to \`puter.auth\` (whoami) and persists a counter to \`puter.kv\`. Edit \`app.js\` to build your app.
`;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}
