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

import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { createApiOrigin } from "../api-origin.ts";
import { createCapabilityRegistry } from "../capability.ts";
import { createStubControlPlane } from "../control-plane.ts";
import { createNodeFsStore } from "../store.ts";
import { nodeFsAdapter } from "../spike/node-fs-adapter.ts";
import { startHarnessServer } from "../server.ts";
import { DEFAULT_SHELL_APPS } from "./app-registry.ts";
import { buildShellSessionScript, mintShellSessions } from "./shell-session.ts";

const here = dirname(fileURLToPath(import.meta.url)); // .../runtime/puter/shell
const puterDir = resolve(here, ".."); // .../runtime/puter
const uiKitsDesktop = resolve(puterDir, "../.."); // ui_kits/desktop
const repoRoot = resolve(uiKitsDesktop, "../.."); // repo root

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

  // Mint one capability session per registry app (the shell hands each app its own token).
  const sessions = mintShellSessions(capabilities, DEFAULT_SHELL_APPS);

  const controlPlane = createStubControlPlane();

  // Origin base for absolute site/share URLs. When a fixed port is given (the harness + verify always
  // pass one) we know it up front; for an ephemeral port (0) the site/share URLs fall back to relative.
  const originBase = port > 0 ? `http://127.0.0.1:${port}` : "";
  const apiOrigin = createApiOrigin({ capabilities, store, controlPlane, originBase });

  const vendorDir = resolve(uiKitsDesktop, "_vendor"); // → /_vendor/puter/v2.js
  const consoleDir = resolve(repoRoot, "apps/vita-deploy-console"); // → /app/index.html
  const deskRuntimeDir = puterDir; // kiosk-entry.html + app/app.js live under .../runtime/puter
  const appsDir = resolve(puterDir, "apps"); // → /apps/<id>/index.html (vendored third-party apps)
  const shellDir = here; // → /shell/shell.js + shell.html

  const sessionScript = buildShellSessionScript({ apiOrigin: "/api", sessions });
  const shellHtml = readFileSync(resolve(shellDir, "shell.html"), "utf8");
  const htmlRoute = (): { contentType: string; body: string } => ({ body: shellHtml, contentType: "text/html; charset=utf-8" });

  const server = await startHarnessServer({
    apiOrigin,
    apiPrefix: "/api",
    host: "127.0.0.1",
    port,
    extraRoutes: {
      // The shell page is served at the kiosk root + an explicit path (the on-device kiosk opens "/").
      "/": htmlRoute,
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
      "/shell": shellDir,
      "/ui_kits": resolve(repoRoot, "ui_kits"),
    },
    staticRoot: deskRuntimeDir, // kiosk-entry.html, app/app.js, app/app.css, proof.html resolve here
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
