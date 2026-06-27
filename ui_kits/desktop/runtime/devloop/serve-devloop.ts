// Vita dev-loop — SERVE HARNESS. Stands up the REAL platform data plane (api_origin + capability gate +
// file-backed store) and serves the dev-loop surfaces over one node:http listener, the same way the
// on-device local-desktop face does — NO compositor, NO VM, a stock browser is the renderer.
//
// Routes:
//   /api/*                          → the platform api_origin (fs/kv/auth), gated by the minted session
//   /_vendor/*                      → vendored Apache-2.0 puter.js + MIT CodeMirror (offline)
//   /session.js                     → injects the minted local app-session token into puter.js
//   /devloop/scaffold.browser.js    → scaffold.ts, type-stripped, so the New App page + node share ONE generator
//   /devloop/*                      → the dev-loop static apps (editor, newapp)
//   /run?path=<entry>               → APP RUNNER: serve a SCAFFOLDED/PACKAGED app's files from the STORE
//                                     (apps the user generated live in /var/lib/vita/apps, not on the
//                                     static FS — this is how they become runnable in a browser face)
//   /                               → the dev-loop launcher (links to the editor + new app)
//
// It calls the SAME createApiOrigin + capability registry + file-backed store the platform service uses.
// The store is shared between /api (what puter.fs writes) and /run (what the runner reads back) — so a
// freshly scaffolded app is immediately runnable.
//
// Run:
//   node --experimental-strip-types ui_kits/desktop/runtime/devloop/serve-devloop.ts [--port 7700] [--dir <persist>]
// Emits `[serve-devloop] READY {json}` once listening.

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createReadStream, existsSync, mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { extname, join, resolve } from "node:path";

import { createApiOrigin, type ApiOrigin, type ApiRequest } from "../puter/api-origin.ts";
import { createCapabilityRegistry, parseBearer } from "../puter/capability.ts";
import { createAppGrantRegistry, createBrokerPermissionModel } from "../puter/permission-model.ts";
import { openAppStore } from "../puter/fs-store.ts";
import { buildSessionScript } from "../puter/server.ts";
import { stripTypesToJs } from "./strip-types.ts";
import { addPackagedApp, createPackagerCatalog, hashInstalledDir, type LockedInstall } from "./packager-bridge.ts";
import type { PackagerCatalogEntry } from "./packager-bridge.ts";

const KIOSK_APP_ID = "vita.kiosk";
const KIOSK_INSTANCE = "vita-devloop-instance-0001";
const API_PREFIX = "/api";

const DEVLOOP_DIR = resolve(import.meta.dirname);
const VENDOR_DIR = resolve(DEVLOOP_DIR, "../../_vendor");

const CT_JS = "text/javascript; charset=utf-8";
const CT_HTML = "text/html; charset=utf-8";
const MIME: Record<string, string> = {
  ".css": "text/css; charset=utf-8",
  ".html": CT_HTML,
  ".js": CT_JS,
  ".json": "application/json; charset=utf-8",
  ".mjs": CT_JS,
  ".md": "text/markdown; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".txt": "text/plain; charset=utf-8",
};

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);

  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<void> {
  const port = Number(arg("port") ?? "7700");
  const host = arg("host") ?? "127.0.0.1";
  const appsRoot = arg("dir") ?? mkdtempSync(join(tmpdir(), "vita-devloop-"));

  // ── the REAL platform data plane (shared store + capability gate) ──
  const grants = createAppGrantRegistry({ [KIOSK_APP_ID]: ["fs.read", "fs.write", "kv.read", "kv.write", "auth"] });
  const capabilities = createCapabilityRegistry({ permissionModel: createBrokerPermissionModel({ grants }) });
  const store = openAppStore({ appId: KIOSK_APP_ID, appsRoot });
  const apiOrigin: ApiOrigin = createApiOrigin({ capabilities, store });

  // Mint the local session token the in-browser puter.js authenticates with (random token by default).
  const session = capabilities.mintAppSession({ appId: KIOSK_APP_ID, appInstanceId: KIOSK_INSTANCE, grants: ["fs.read", "fs.write", "kv.read", "kv.write", "auth"] });
  const sessionToken = session.token;

  // Pre-strip the scaffold module to browser JS once (single source of truth with node/tests).
  const scaffoldJs = stripTypesToJs(readFileSync(join(DEVLOOP_DIR, "scaffold.ts"), "utf8"));

  // ── the packager allowlist over the in-repo fixture packages (the OS-allows gate). The catalog pins
  // each fixture's installed-dir content hash, so `add <pkg>` only generates a runnable app for an
  // allowlisted package whose offline-locked install matches. The "install" is the unpacked dir on disk
  // (no network, no lifecycle scripts) — production swaps the fixtures dir for the real install root. ──
  const FIXTURES = resolve(DEVLOOP_DIR, "fixtures/packages");
  const installs: Record<string, LockedInstall> = {
    "@vita/echo-cli": { dir: join(FIXTURES, "echo-cli"), name: "@vita/echo-cli", version: "2.1.0" },
    "@vita/greeter": { dir: join(FIXTURES, "greeter"), name: "@vita/greeter", version: "1.0.0" },
  };
  const catalogEntries: PackagerCatalogEntry[] = Object.values(installs).map((inst) => Object.freeze({
    capabilities: Object.freeze(["files.read", "files.write"]) as never,
    integrity: hashInstalledDir(inst.dir),
    kind: "auto" as const,
    name: inst.name,
    version: inst.version,
  }));
  const catalog = createPackagerCatalog(catalogEntries);

  const server = createServer((req, res) => {
    handle(req, res).catch((err) => { res.statusCode = 500; res.end(`internal error: ${err instanceof Error ? err.message : String(err)}`); });
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const rawUrl = req.url ?? "/";
    const qi = rawUrl.indexOf("?");
    const pathOnly = decodeURIComponent(qi < 0 ? rawUrl : rawUrl.slice(0, qi));
    const query = parseQuery(qi < 0 ? "" : rawUrl.slice(qi + 1));
    const method = (req.method ?? "GET").toUpperCase();

    // favicon — answer 204 so store-served pages without an explicit icon don't log a 404.
    if (method === "GET" && pathOnly === "/favicon.ico") {
      res.statusCode = 204;
      res.end();
      return;
    }

    // /session.js — inject the minted token (local face: trust-on-host).
    if (method === "GET" && pathOnly === "/session.js") {
      res.statusCode = 200;
      res.setHeader("content-type", CT_JS);
      res.end(buildSessionScript(API_PREFIX, sessionToken));
      return;
    }

    // /api/* — the platform data plane.
    if (pathOnly.startsWith(API_PREFIX)) {
      const apiPath = pathOnly.slice(API_PREFIX.length) || "/";
      const body = await readBody(req);
      const request: ApiRequest = Object.freeze({ body, headers: lowercase(req.headers), method, path: apiPath, query });
      const response = await apiOrigin.handleAsync(request);

      res.statusCode = response.status;
      for (const [k, v] of Object.entries(response.headers)) res.setHeader(k, v);
      res.end(Buffer.from(response.body));
      return;
    }

    // The scaffold generator, type-stripped, shared with node/tests. Served both at the devloop root and
    // next to the New App page (which imports it as "./scaffold.browser.js").
    if (method === "GET" && (pathOnly === "/devloop/scaffold.browser.js" || pathOnly === "/devloop/newapp/scaffold.browser.js")) {
      res.statusCode = 200;
      res.setHeader("content-type", CT_JS);
      res.end(scaffoldJs);
      return;
    }

    // /run?path=<store-entry> — serve a scaffolded/packaged app's files FROM THE STORE.
    if (pathOnly === "/run") {
      serveFromStore(res, query["path"] ?? "", query["asset"]);
      return;
    }

    // /package?name=<pkg> — run the PACKAGER BRIDGE: catalog gate → offline locked install → generate a
    // served app → WRITE its files into the store (so /run can serve it). Returns the entry path as JSON.
    // This is the on-device `add <pkg>` flow surfaced over HTTP for the browser verification harness.
    if (method === "POST" && pathOnly === "/package") {
      await packageApp(res, query["name"] ?? "");
      return;
    }

    // /_vendor/* — offline third-party (puter.js + CodeMirror).
    if (pathOnly === "/_vendor" || pathOnly.startsWith("/_vendor/")) {
      serveFile(res, join(VENDOR_DIR, pathOnly.slice("/_vendor".length).replace(/^\//, "")));
      return;
    }

    // /devloop/* — the dev-loop static apps.
    if (pathOnly.startsWith("/devloop/")) {
      const rel = pathOnly.slice("/devloop/".length);

      serveFile(res, join(DEVLOOP_DIR, rel === "" ? "index.html" : rel));
      return;
    }

    // / — the launcher.
    if (pathOnly === "/" || pathOnly === "/index.html") {
      res.statusCode = 200;
      res.setHeader("content-type", CT_HTML);
      res.end(launcherHtml());
      return;
    }

    res.statusCode = 404;
    res.end("not found");
  }

  // Run the packager bridge for `name` and write the generated served app into the store under
  // /home/apps/<slug>, so it becomes runnable via /run. Returns JSON { ok, entryPath, appId, files }.
  async function packageApp(res: ServerResponse, name: string): Promise<void> {
    const install = installs[name];

    if (install === undefined) {
      res.statusCode = 404;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ error: { code: "NOT_ALLOWED", message: `"${name}" is not an installed fixture package` }, ok: false }));
      return;
    }

    const result = await addPackagedApp(catalog, name, install, { appsDir: "/home/apps" });

    if (!result.ok) {
      res.statusCode = 400;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(result));
      return;
    }

    // Write the served files into the SAME file-backed store the api_origin uses, so /run serves them.
    const app = result.value;
    try { store.fs.mkdir(app.appDir, { createMissingAncestors: true }); } catch { /* exists */ }

    for (const file of app.files) {
      store.fs.write(file.path, new TextEncoder().encode(file.content), { overwrite: true });
    }

    res.statusCode = 200;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ appId: app.appId, entryPath: app.entryPath, files: app.files.map((f) => f.path), kind: app.kind, ok: true }));
  }

  // Serve an app entry/asset stored under the file-backed store (apps the user scaffolded/packaged). For
  // the entry HTML, also rewrite RELATIVE asset refs (./app.js) to /run?path=<dir>/<asset> so the page's
  // own scripts/styles load from the store too. Absolute refs (/_vendor, /session.js, /api) are untouched.
  function serveFromStore(res: ServerResponse, entryPath: string, asset: string | undefined): void {
    const target = asset !== undefined && asset !== "" ? asset : entryPath;

    if (target === "") { res.statusCode = 400; res.end("missing path"); return; }

    const result = store.fs.read(target);

    if (result === undefined) { res.statusCode = 404; res.end(`no such file in store: ${target}`); return; }

    let body = Buffer.from(result.bytes);
    const ext = extname(target).toLowerCase();
    const dir = target.slice(0, target.lastIndexOf("/"));

    if (ext === ".html") {
      body = Buffer.from(rewriteHtmlRefs(body.toString("utf8"), dir), "utf8");
    } else if (ext === ".js" || ext === ".mjs") {
      // Rewrite relative ES-module specifiers so `import ... from "./package.mjs"` resolves through the
      // store-runner (the served JS lives at /run, not at the app dir, so a bare relative specifier
      // would resolve against /run). The /run?...&asset=... URL is a valid module specifier.
      body = Buffer.from(rewriteJsImports(body.toString("utf8"), dir), "utf8");
    }

    res.statusCode = 200;
    res.setHeader("content-type", MIME[ext] ?? "application/octet-stream");
    res.end(body);
  }

  // The store-runner URL for an asset at absolute store path `abs`.
  function runAssetUrl(abs: string): string {
    const clean = abs.replace(/\/+/g, "/");
    const appDir = clean.slice(0, clean.lastIndexOf("/"));

    return `/run?path=${encodeURIComponent(appDir + "/index.html")}&asset=${encodeURIComponent(clean)}`;
  }

  // Rewrite ./foo and foo.js relative refs in served HTML to the store-runner URL so the app's own files
  // load from the store. Leaves absolute (/...), protocol (http..), and data: refs alone.
  function rewriteHtmlRefs(html: string, dir: string): string {
    return html.replace(/\b(src|href)=("|')(\.\/)?([^"':/][^"']*?)\2/g, (whole, attr: string, q: string, _dot: string, rel: string) => {
      if (/^(https?:|data:|\/|#|mailto:)/i.test(rel)) return whole;

      return `${attr}=${q}${runAssetUrl(`${dir}/${rel}`)}${q}`;
    });
  }

  // Rewrite relative `import ... from "./x"` / `import("./x")` / `export ... from "./x"` specifiers in
  // served JS to the store-runner URL. Only `./` and `../` specifiers are rewritten; bare + absolute
  // specifiers are left alone.
  function rewriteJsImports(js: string, dir: string): string {
    return js.replace(/(\bfrom\s*|\bimport\s*\(\s*)("|')(\.\.?\/[^"']*?)\2/g, (whole, lead: string, q: string, rel: string) => {
      const abs = resolveRel(dir, rel);

      return `${lead}${q}${runAssetUrl(abs)}${q}`;
    });
  }

  // Resolve a ./ or ../ specifier against a store dir into an absolute store path.
  function resolveRel(dir: string, rel: string): string {
    const parts = (dir + "/" + rel).split("/");
    const out: string[] = [];

    for (const part of parts) {
      if (part === "" || part === ".") continue;
      if (part === "..") { out.pop(); continue; }
      out.push(part);
    }

    return "/" + out.join("/");
  }

  await new Promise<void>((r) => server.listen(port, host, () => r()));

  const localUrl = `http://${host}:${port}`;

  console.log("");
  console.log("  Vita dev loop — editor + scaffold + packager");
  console.log("  ────────────────────────────────────────────");
  console.log(`  launcher  : ${localUrl}/`);
  console.log(`  editor    : ${localUrl}/devloop/editor/index.html`);
  console.log(`  new app   : ${localUrl}/devloop/newapp/index.html`);
  console.log(`  data dir  : ${appsRoot}`);
  console.log(`  token     : ${sessionToken.slice(0, 10)}…`);
  console.log("");
  console.log(`[serve-devloop] READY ${JSON.stringify({ localUrl, appsRoot, port })}`);

  const close = (): void => { server.close(() => process.exit(0)); };

  process.on("SIGINT", close);
  process.on("SIGTERM", close);
}

function launcherHtml(): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" /><title>Vita Dev Loop</title>
<style>body{background:#0e1116;color:#e6edf3;font-family:Inter,system-ui,sans-serif;margin:0;display:grid;place-items:center;height:100vh}
.wrap{max-width:520px;padding:24px}h1{font-size:22px}a{display:block;background:#161b22;border:1px solid #2a313c;border-radius:10px;color:#e6edf3;text-decoration:none;padding:16px;margin-top:12px}
a:hover{border-color:#5b8cff}a b{display:block}a span{color:#9aa7b4;font-size:13px}</style></head>
<body><div class="wrap"><h1>Vita Dev Loop</h1>
<a href="/devloop/editor/index.html"><b>Vita Code →</b><span>Open, edit, and save files via puter.fs (CodeMirror).</span></a>
<a href="/devloop/newapp/index.html"><b>New App →</b><span>Scaffold a minimal runnable Vita/Puter app into your space.</span></a>
</div></body></html>`;
}

function serveFile(res: ServerResponse, filePath: string): void {
  const full = resolve(filePath);

  if (!existsSync(full) || !statSync(full).isFile()) { res.statusCode = 404; res.end("not found"); return; }

  res.statusCode = 200;
  res.setHeader("content-type", MIME[extname(full).toLowerCase()] ?? "application/octet-stream");
  createReadStream(full).pipe(res);
}

function parseQuery(qs: string): Record<string, string> {
  const out: Record<string, string> = {};

  if (qs === "") return out;

  for (const pair of qs.split("&")) {
    const eq = pair.indexOf("=");
    const k = decodeURIComponent(eq < 0 ? pair : pair.slice(0, eq));
    const v = eq < 0 ? "" : decodeURIComponent(pair.slice(eq + 1).replace(/\+/g, " "));

    out[k] = v;
  }

  return out;
}

function lowercase(headers: NodeJS.Dict<string | string[]>): Record<string, string> {
  const out: Record<string, string> = {};

  for (const [k, v] of Object.entries(headers)) out[k.toLowerCase()] = Array.isArray(v) ? v.join(",") : String(v ?? "");

  return out;
}

async function readBody(req: IncomingMessage): Promise<Uint8Array> {
  const chunks: Buffer[] = [];

  for await (const chunk of req) chunks.push(chunk as Buffer);

  return new Uint8Array(Buffer.concat(chunks));
}

void parseBearer; // re-exported availability check (the api_origin parses bearers itself)

main().catch((err: unknown) => {
  console.error(`[serve-devloop] FATAL ${err instanceof Error ? err.stack : String(err)}`);
  process.exitCode = 1;
});
