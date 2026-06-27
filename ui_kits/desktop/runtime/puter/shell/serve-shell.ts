// serve-shell — stand up the Vita MULTI-WINDOW SHELL for browser verification (puppeteer) or manual
// click-through. ONE local server serves:
//   - the shell page at /  and  /shell.html              (the window manager + dock + launcher)
//   - the shell bundle at /shell/shell.js                (deno-bundled shell-entry.ts; build first)
//   - per-app session tokens at /shell-session.js        (mints one capability session per registry app)
//   - Vita Desk at /kiosk-entry.html (+ /app/app.js,css) (Vita's own app, hosted as a WINDOW)
//   - the deploy console at /app/index.html              (Vita's own control-plane app, as a WINDOW)
//   - real third-party apps at /apps/<id>/index.html     (serverless-todo, notepad — MIT, vendored)
//   - the vendored Apache-2.0 puter.js at /_vendor/puter/v2.js
//   - the ui_kits CSS at /ui_kits/styles.css + /ui_kits/desktop/kit.css
//   - the LOCAL api_origin at /api/*  — fs/kv/auth + apps/sites/shares/events + /control/* (stub).
//
// Backed by a file-backed store under --dir (default a temp dir) so persistence is real across reloads.
//
// Build the bundle first:
//   node ui_kits/desktop/runtime/puter/shell/build-shell.mjs
// Run:
//   node --experimental-strip-types ui_kits/desktop/runtime/puter/shell/serve-shell.ts [--port 7700] [--dir <path>]
// Then open  http://127.0.0.1:7700/  in any browser.
//
// Emits a single JSON line `[serve-shell] READY {...}` once listening so a driver can parse the URL.

import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { createApiOrigin } from "../api-origin.ts";
import { createCapabilityRegistry } from "../capability.ts";
import { createStubControlPlane } from "../control-plane.ts";
import { type ChildProcessLike, createDevExecBackend } from "../exec-plane.ts";
import { createAppGrantRegistry } from "../permission-model.ts";
import { createNodeFsStore } from "../store.ts";
import { nodeFsAdapter } from "../spike/node-fs-adapter.ts";
import { startHarnessServer } from "../server.ts";
import { createAuditLog } from "../pkgmgr/audit-log.ts";
import { createMetaPlane } from "../pkgmgr/meta-plane.ts";
import { createPackageRegistry } from "../pkgmgr/package-registry.ts";
import { nodeSourceFs } from "../pkgmgr/node-source-fs.ts";
import { materializeSamples } from "../pkgmgr/samples.ts";
import { DEFAULT_SHELL_APPS } from "./app-registry.ts";
import { buildShellSessionScript, mintShellSessions } from "./shell-session.ts";

const here = dirname(fileURLToPath(import.meta.url)); // .../runtime/puter/shell
const puterDir = resolve(here, ".."); // .../runtime/puter
const uiKitsDesktop = resolve(puterDir, "../.."); // ui_kits/desktop
const repoRoot = resolve(uiKitsDesktop, "../.."); // repo root

// Adapt node:child_process.spawn to the dev exec backend's injected ChildProcessLike (same adapter the
// terminal harness uses — the backend stays runtime-agnostic + testable). Powers the Terminal's /pty.
const childProcess: ChildProcessLike = {
  spawn(command, args, options) {
    const child = spawn(command, [...args], { cwd: options.cwd, env: { ...options.env }, shell: false });

    return {
      stdout: { on: (_e, cb) => child.stdout.on("data", (c: Buffer) => cb(new Uint8Array(c))) },
      stderr: { on: (_e, cb) => child.stderr.on("data", (c: Buffer) => cb(new Uint8Array(c))) },
      stdin: { write: (d: string) => child.stdin.write(d), end: () => child.stdin.end() },
      on: (event, cb) => {
        if (event === "exit") child.on("exit", (code, signal) => (cb as (c: number | null, s: string | null) => void)(code, signal));
        else child.on("error", (err) => (cb as (e: Error) => void)(err));
      },
      kill: (signal?: string) => { child.kill((signal as NodeJS.Signals | undefined) ?? "SIGTERM"); },
    };
  },
};

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);

  return i >= 0 ? process.argv[i + 1] : undefined;
}

export interface ShellHarness {
  readonly url: string;
  readonly dataDir: string;
  close(): Promise<void>;
}

export async function startShellHarness(opts: { port?: number; dir?: string } = {}): Promise<ShellHarness> {
  const port = opts.port ?? 0;
  const dataDir = opts.dir ?? mkdtempSync(join(tmpdir(), "vita-shell-"));

  const store = createNodeFsStore({ fs: nodeFsAdapter, path: { join }, rootDir: dataDir });
  const capabilities = createCapabilityRegistry();

  // Mint one capability session per registry app (the shell hands each app its own token). This is what
  // /shell-session.js publishes; each app's iframe authenticates to /api with ITS token + grants — so the
  // Package Manager's `meta` calls and the Terminal's `exec` upgrade clear the gate (and no other app's
  // do, default-deny).
  const sessions = mintShellSessions(capabilities, DEFAULT_SHELL_APPS);

  const controlPlane = createStubControlPlane();

  // PACKAGE-MANAGER meta plane (/meta/*) — without this mounted, the Package Manager's GET /meta/packages
  // 404s and the app wedges. Materialize the sample packages' source on disk, seed the grant store, and
  // build the meta plane against the SAME capability + grant registries the gate enforces. Gated on the
  // `meta` capability (only the Package Manager app holds it — see app-registry.ts PKGMGR_GRANTS).
  const samples = materializeSamples(dataDir);
  const audit = createAuditLog();
  const packageRegistry = createPackageRegistry({ fs: nodeSourceFs, seed: samples.packages });
  const grants = createAppGrantRegistry(samples.grants);
  const metaPlane = createMetaPlane({ audit, capabilities, grants, packages: packageRegistry });

  // EXEC backend (/pty) — without this the Terminal's websocket upgrade 404s and it sits on "connecting…".
  // A dev sandbox that genuinely runs an allow-listed command set (server.ts gates the upgrade on `exec`,
  // which only the Terminal app holds).
  const execBackend = createDevExecBackend({
    childProcess,
    makeCwd: () => mkdtempSync(join(tmpdir(), "vita-shell-term-")),
    pathEnv: process.env["PATH"] ?? "",
    timeoutMs: 5000,
  });

  // Origin base for absolute site/share URLs. When a fixed port is given (the harness + verify always
  // pass one) we know it up front; for an ephemeral port (0) the site/share URLs fall back to relative.
  const originBase = port > 0 ? `http://127.0.0.1:${port}` : "";
  const apiOrigin = createApiOrigin({ capabilities, store, controlPlane, metaPlane, originBase });

  const vendorDir = resolve(uiKitsDesktop, "_vendor"); // → /_vendor/puter/v2.js + /_vendor/xterm + codemirror
  const consoleDir = resolve(repoRoot, "apps/vita-deploy-console"); // → /console/index.html
  const editorDir = resolve(uiKitsDesktop, "runtime/devloop/editor"); // → /editor/index.html (Vita Code)
  const deskRuntimeDir = puterDir; // kiosk-entry.html + app/app.js live under .../runtime/puter
  const appsDir = resolve(puterDir, "apps"); // → /apps/<id>/index.html (vendored third-party apps)
  const shellDir = here; // → /shell/shell.js + shell.html

  // /session.js for the SHELL: several Vita-own apps (Vita Desk, Package Manager, Vita Code) load
  // /session.js in <head>. In the single-kiosk server it injects ONE app's token. In the SHELL there is
  // no single app — each iframe gets its OWN token via the launch URL (puter.auth.token), and that token
  // is authoritative. So the shell's /session.js MUST NOT set/override the auth token (doing so would
  // clobber the per-app URL token with one app's — e.g. give the Package Manager the Vita Desk token and
  // get CAP_DENIED on /meta/*). It only pins the api + GUI origin (keeping the SDK same-origin / offline)
  // and leaves the URL-provided token intact. Serving it (instead of 404) also removes the console noise +
  // the SDK boot race the apps' getPuter() guards against.
  const shellSessionJs = [
    "// Vita SHELL /session.js — pins api + GUI origin same-origin; does NOT touch the auth token (each",
    "// app adopts its OWN token from the launch URL — overriding it here would cross app identities).",
    "(function () {",
    "  var apiOrigin = window.location.origin + \"/api\";",
    "  try { window.PUTER_ORIGIN = window.location.origin; } catch (e) {}",
    "  function apply() {",
    "    if (typeof window.puter !== 'object' || window.puter === null) return false;",
    "    try { if (typeof window.puter.setAPIOrigin === 'function') window.puter.setAPIOrigin(apiOrigin); } catch (e) {}",
    "    try { window.puter.APIOrigin = apiOrigin; } catch (e) {}",
    "    try { window.puter.env = 'app'; } catch (e) {}",
    "    try { window.puter.quiet = true; } catch (e) {}",
    "    return true;",
    "  }",
    "  // hasToken:true so the apps' getPuter() waits for the URL token to be applied by the SDK (not for us).",
    "  window.__vitaSession = { apiOrigin: apiOrigin, hasToken: true };",
    "  if (!apply()) { var n = 0; var iv = setInterval(function () { n++; if (apply() || n > 50) clearInterval(iv); }, 20); }",
    "})();",
    "",
  ].join("\n");

  const sessionScript = buildShellSessionScript({ apiOrigin: "/api", sessions });
  const shellHtml = readFileSync(resolve(shellDir, "shell.html"), "utf8");
  const htmlRoute = (): { contentType: string; body: string } => ({ body: shellHtml, contentType: "text/html; charset=utf-8" });

  const server = await startHarnessServer({
    apiOrigin,
    apiPrefix: "/api",
    capabilities, // gate the /pty exec upgrade against the same registry
    execBackend, // mount /pty (Terminal)
    host: "127.0.0.1",
    port,
    extraRoutes: {
      // The shell page is served at the kiosk root + an explicit path (the on-device kiosk opens "/").
      "/": htmlRoute,
      // Token-less session bootstrap for apps that load /session.js (pins origin, preserves URL token).
      "/session.js": () => ({ body: shellSessionJs, contentType: "text/javascript; charset=utf-8" }),
      "/shell-session.js": () => ({ body: sessionScript, contentType: "text/javascript; charset=utf-8" }),
      "/shell.html": htmlRoute,
    },
    staticAliases: {
      // App + asset aliases (longest-prefix wins; server.ts sorts). Vita Desk's kiosk-entry.html +
      // its /app/app.js,css resolve from staticRoot (the runtime dir), so the deploy console gets its
      // OWN /console prefix to avoid colliding with Vita Desk's /app assets.
      "/_vendor": vendorDir,
      "/apps": appsDir,
      "/console": consoleDir, // deploy console (its index.html is at /console/index.html)
      "/editor": editorDir, // Vita Code (devloop editor; its index.html + editor.js,css live here)
      "/shell": shellDir,
      "/ui_kits": resolve(repoRoot, "ui_kits"),
    },
    staticRoot: deskRuntimeDir, // kiosk-entry.html, app/app.js, app/app.css, pkgmgr-app/*, proof.html
  });

  return Object.freeze({ close: () => server.close(), dataDir, url: server.url });
}

async function main(): Promise<void> {
  const dir = arg("dir");
  const harness = await startShellHarness({
    port: Number(arg("port") ?? "7700"),
    ...(dir !== undefined ? { dir } : {}),
  });

  console.log("");
  console.log("  Vita Desktop — multi-window shell");
  console.log("  ─────────────────────────────────");
  console.log(`  shell URL  : ${harness.url}/`);
  console.log(`  data dir   : ${harness.dataDir}`);
  console.log("");
  console.log("  Open the shell URL, click the dock launcher (⊞) to open apps. Ctrl-C to stop.");
  console.log(`[serve-shell] READY ${JSON.stringify({ url: harness.url, dataDir: harness.dataDir })}`);

  process.on("SIGINT", () => { void harness.close().then(() => process.exit(0)); });
  process.on("SIGTERM", () => { void harness.close().then(() => process.exit(0)); });
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  main().catch((err: unknown) => {
    console.error(`[serve-shell] FATAL ${err instanceof Error ? err.stack : String(err)}`);
    process.exitCode = 1;
  });
}
