// serve-console — the live preview / browser-verification harness for the Vita Deploy Console.
//
// Stands up ONE local server that serves:
//   - the vendored puter.js at /_vendor/puter/v2.js
//   - the console app at /app/index.html (this directory's index.html)
//   - the LOCAL api_origin at /api/* — fs/kv/auth (data plane) AND /control/* (control plane), the
//     latter backed by the in-memory STUB control plane (no agentd / no VM boot).
//
// This is what the headless-chromium verification drives, and what an owner can open to click around.
//
// Run:  node --experimental-strip-types apps/vita-deploy-console/serve-console.ts [--port 8190] [--dir <path>]
// Then open the URL printed as "Console app".

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { createApiOrigin } from "../../ui_kits/desktop/runtime/puter/api-origin.ts";
import { createCapabilityRegistry } from "../../ui_kits/desktop/runtime/puter/capability.ts";
import { createNodeFsStore } from "../../ui_kits/desktop/runtime/puter/store.ts";
import { nodeFsAdapter } from "../../ui_kits/desktop/runtime/puter/spike/node-fs-adapter.ts";
import { startHarnessServer } from "../../ui_kits/desktop/runtime/puter/server.ts";
import { createStubControlPlane } from "../../ui_kits/desktop/runtime/puter/control-plane.ts";
import { PUTER_API_ORIGIN_GRANTS } from "./manifest.ts";

const here = dirname(fileURLToPath(import.meta.url)); // apps/vita-deploy-console
const repoRoot = resolve(here, "../.."); // repo root (so /_vendor resolves)
const uiKitsDesktop = resolve(repoRoot, "ui_kits/desktop"); // for the _vendor dir

// A known token so the api_origin accepts the console's control-plane + data-plane calls. The console
// reads it from the launch URL (puter.auth.token) exactly as a launched app would.
export const CONSOLE_TOKEN = "console-owner-token-0001";
export const CONSOLE_APP_ID = "vita.app.deploy-console";
export const CONSOLE_INSTANCE = "console-instance-0001";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);

  return i >= 0 ? process.argv[i + 1] : undefined;
}

export interface ConsoleHarness {
  readonly url: string;
  readonly appUrl: string;
  close(): Promise<void>;
}

export async function startConsoleHarness(opts: { port?: number; dir?: string; controlPlane?: boolean } = {}): Promise<ConsoleHarness> {
  const port = opts.port ?? 0;
  const dataDir = opts.dir ?? mkdtempSync(join(tmpdir(), "vita-console-preview-"));
  // When `controlPlane` is false, the api_origin is mounted DATA-PLANE-ONLY (no /control/*). This models
  // a browser / dev / off-device context where the capability-gated bridge to agentd is absent — the
  // console must then show its clean "Control plane unavailable — running off-device" state (NOT an
  // infinite spinner). Defaults to true (the live, fully-exercisable stub node).
  const withControlPlane = opts.controlPlane ?? true;

  const store = createNodeFsStore({ fs: nodeFsAdapter, path: { join }, rootDir: dataDir });
  const capabilities = createCapabilityRegistry();

  // Mint the console's session with EXACTLY the grants the manifest declares it needs — including
  // `control`. No other app is minted `control` (default-deny).
  capabilities.mintAppSession({
    appId: CONSOLE_APP_ID,
    appInstanceId: CONSOLE_INSTANCE,
    grants: [...PUTER_API_ORIGIN_GRANTS],
    token: CONSOLE_TOKEN,
  });

  const apiOrigin = withControlPlane
    ? createApiOrigin({ capabilities, store, controlPlane: createStubControlPlane() })
    : createApiOrigin({ capabilities, store });

  const vendorDir = resolve(uiKitsDesktop, "_vendor"); // → /_vendor/puter/v2.js
  const server = await startHarnessServer({
    apiOrigin,
    apiPrefix: "/api",
    host: "127.0.0.1",
    port,
    staticAliases: {
      "/_vendor": vendorDir,
      "/app": here, // → /app/index.html serves this dir's console
    },
    staticRoot: repoRoot,
  });

  const appUrl = `${server.url}/app/index.html?` +
    `puter.app_instance_id=${CONSOLE_INSTANCE}&puter.api_origin=${encodeURIComponent(`${server.url}/api`)}` +
    `&puter.auth.token=${CONSOLE_TOKEN}&puter.auth.username=owner&puter.domain=localhost&puter.env=app`;

  return Object.freeze({ url: server.url, appUrl, close: () => server.close() });
}

function hasFlag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

async function main(): Promise<void> {
  const dir = arg("dir");
  // `--no-control-plane` mounts the api_origin without the control bridge (off-device context).
  const controlPlane = !hasFlag("no-control-plane");
  const harness = await startConsoleHarness({
    port: Number(arg("port") ?? "8190"),
    controlPlane,
    ...(dir !== undefined ? { dir } : {}),
  });

  console.log("");
  console.log("  Vita Deploy Console — preview harness");
  console.log("  ─────────────────────────────────────");
  console.log(`  server      : ${harness.url}`);
  console.log(`  Console app : ${harness.appUrl}`);
  console.log("");
  console.log("  Ctrl-C to stop.");

  process.on("SIGINT", () => {
    void harness.close().then(() => process.exit(0));
  });
}

// Run as a script (not when imported by the headless harness).
if (process.argv[1] !== undefined && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  main().catch((err: unknown) => {
    console.error(`[serve-console] FATAL ${err instanceof Error ? err.stack : String(err)}`);
    process.exitCode = 1;
  });
}
