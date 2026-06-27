// serve-spike — the preview harness. Stands up ONE local server that serves:
//   - the vendored puter.js at /_vendor/puter/v2.js
//   - the spike test app at /spike/app/index.html
//   - the spike desktop preview at /spike/desktop.html (mounts the web-app window host)
//   - the LOCAL api_origin at /api/* (fs/kv/auth over HTTP)
// against a file-backed store under a temp (or given) dir. This is what the owner opens for the live
// preview verification.
//
// Run:  node --experimental-strip-types ui_kits/desktop/runtime/puter/spike/serve-spike.ts [--port 8137] [--dir <path>]
// Then open:  http://127.0.0.1:8137/spike/desktop.html
//
// Static root is the desktop ui_kits dir so the preview can also reach kit.css / styles.css / the
// runtime bundle if needed. The api_origin store dir is separate (data), under --dir or a temp dir.

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { createApiOrigin } from "../api-origin.ts";
import { createCapabilityRegistry } from "../capability.ts";
import { createNodeFsStore } from "../store.ts";
import { nodeFsAdapter } from "./node-fs-adapter.ts";
import { startHarnessServer } from "../server.ts";

const here = dirname(fileURLToPath(import.meta.url)); // .../runtime/puter/spike
const uiKitsDesktop = resolve(here, "../../.."); // ui_kits/desktop
const repoRoot = resolve(uiKitsDesktop, "../.."); // repo root (so /_vendor and /ui_kits both resolve)

// This is the app session the preview's web-app window will use. For the live preview we pre-mint a
// known token so the api_origin accepts the iframe's requests. The desktop preview page reads it from
// the launch params we bake into the iframe URL (see desktop.html).
export const PREVIEW_TOKEN = "preview-owner-token-0001";
export const PREVIEW_APP_ID = "spike.puter.testapp";
export const PREVIEW_INSTANCE = "preview-instance-0001";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);

  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<void> {
  const port = Number(arg("port") ?? "8137");
  const dataDir = arg("dir") ?? mkdtempSync(join(tmpdir(), "vita-puter-preview-"));

  const store = createNodeFsStore({ fs: nodeFsAdapter, path: { join }, rootDir: dataDir });
  const capabilities = createCapabilityRegistry();

  capabilities.mintAppSession({
    appId: PREVIEW_APP_ID,
    appInstanceId: PREVIEW_INSTANCE,
    grants: ["fs.read", "fs.write", "kv.read", "kv.write", "ui", "auth"],
    token: PREVIEW_TOKEN,
  });

  const vendorDir = resolve(uiKitsDesktop, "_vendor"); // ui_kits/desktop/_vendor (→ /_vendor, /vendor)
  const spikeDir = here; // .../runtime/puter/spike (→ /spike)
  const apiOrigin = createApiOrigin({ capabilities, store });
  const server = await startHarnessServer({
    apiOrigin,
    apiPrefix: "/api",
    host: "127.0.0.1",
    port,
    staticAliases: {
      // The spike app's <script src="/_vendor/puter/v2.js"> + the architecture doc's /vendor/... both
      // resolve to the real vendored bundle; /spike/* gives clean preview URLs.
      "/_vendor": vendorDir,
      "/spike": spikeDir,
      "/vendor": vendorDir,
    },
    staticRoot: repoRoot,
  });

  const rawAppUrl = `${server.url}/spike/app/index.html?` +
    `puter.app_instance_id=${PREVIEW_INSTANCE}&puter.api_origin=${encodeURIComponent(`${server.url}/api`)}` +
    `&puter.auth.token=${PREVIEW_TOKEN}&puter.auth.username=owner&puter.domain=localhost&puter.env=app`;

  console.log("");
  console.log("  Vita ⇄ Puter spike harness");
  console.log("  ──────────────────────────");
  console.log(`  server     : ${server.url}`);
  console.log(`  data dir   : ${dataDir}`);
  console.log("");
  console.log(`  Desktop preview : ${server.url}/spike/desktop.html`);
  console.log(`  Spike app (raw) : ${rawAppUrl}`);
  console.log("");
  console.log("  Ctrl-C to stop.");

  process.on("SIGINT", () => {
    void server.close().then(() => process.exit(0));
  });
}

main().catch((err: unknown) => {
  console.error(`[serve-spike] FATAL ${err instanceof Error ? err.stack : String(err)}`);
  process.exitCode = 1;
});
