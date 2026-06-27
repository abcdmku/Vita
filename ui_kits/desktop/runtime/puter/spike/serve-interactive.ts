// serve-interactive — stand up the REAL platform service serving the INTERACTIVE Vita Desk app,
// exactly the way the on-device local-desktop mode does, for browser verification (puppeteer) or
// manual click-through. NO compositor, NO VM — just the dual-face platform server + a stock browser.
//
// It calls the SAME `startPuterPlatformService` the OS image launches, in "local-desktop" mode, mints
// the well-known kiosk app-session, publishes its token to /session.js, and prints the kiosk URL. The
// store is file-backed under --dir (default: a temp dir), so persistence is real and survives a reload.
//
// Run:
//   node --experimental-strip-types ui_kits/desktop/runtime/puter/spike/serve-interactive.ts \
//        [--port 7681] [--dir <persist-dir>]
// Then open  http://127.0.0.1:7681/kiosk-entry.html  (or /  → same page) in any browser.
//
// Emits a single JSON line `[serve-interactive] READY {...}` once listening so a driver script can
// parse the URL + data dir without scraping human text.

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { startPuterPlatformService, KIOSK_ENTRY_PATH } from "../server/index.ts";

// The well-known kiosk app identity (mirrors the on-device boot entry: it mints this app session and
// publishes its token to the local face's /session.js).
const KIOSK_APP_ID = "vita.kiosk";
const KIOSK_INSTANCE = "vita-kiosk-instance-0001";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);

  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<void> {
  const port = Number(arg("port") ?? "7681");
  const appsRoot = arg("dir") ?? mkdtempSync(join(tmpdir(), "vita-desk-"));

  const service = await startPuterPlatformService({
    appsRoot,
    faces: { localHost: "127.0.0.1", localPort: port },
    mode: "local-desktop",
    storeAppId: KIOSK_APP_ID,
    // The kiosk app gets the full owner-store surface (its own app store) + ui for the broker.
    appGrants: { [KIOSK_APP_ID]: ["fs.read", "fs.write", "kv.read", "kv.write", "ui", "auth"] },
  });

  // Mint the kiosk app session in-process and publish its token to the LOCAL face's /session.js, so the
  // in-browser puter.js authenticates to the api_origin (no 401) — exactly the on-device boot wiring.
  const handle = service.mintApp({
    appId: KIOSK_APP_ID,
    instanceId: KIOSK_INSTANCE,
    grants: ["fs.read", "fs.write", "kv.read", "kv.write", "ui", "auth"],
  });

  service.setLocalSessionToken(handle.token);

  const localUrl = service.localUrl ?? `http://127.0.0.1:${port}`;
  const kioskUrl = service.kioskUrl ?? `${localUrl}${KIOSK_ENTRY_PATH}`;

  // Human-readable banner.
  console.log("");
  console.log("  Vita Desk — interactive local face");
  console.log("  ──────────────────────────────────");
  console.log(`  kiosk URL  : ${kioskUrl}`);
  console.log(`  root URL   : ${localUrl}/   (serves the same interactive page)`);
  console.log(`  data dir   : ${appsRoot}`);
  console.log(`  token      : ${handle.token.slice(0, 10)}…`);
  console.log("");
  console.log("  Open the kiosk URL in any browser and click around. Ctrl-C to stop.");

  // Machine-readable line for a driver (puppeteer) to parse.
  console.log(`[serve-interactive] READY ${JSON.stringify({ kioskUrl, localUrl, appsRoot, port })}`);

  process.on("SIGINT", () => { void service.close().then(() => process.exit(0)); });
  process.on("SIGTERM", () => { void service.close().then(() => process.exit(0)); });
}

main().catch((err: unknown) => {
  console.error(`[serve-interactive] FATAL ${err instanceof Error ? err.stack : String(err)}`);
  process.exitCode = 1;
});
