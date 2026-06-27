// serve-pkgmgr — stand up the REAL platform service serving the PACKAGE MANAGER app, the way the
// on-device local-desktop mode would, for browser verification (puppeteer) or manual click-through.
// NO compositor, NO VM — the dual-face platform server + the /meta/* control plane + a stock browser.
//
// It calls the SAME `startPuterPlatformService` the OS image launches (local-desktop mode), then:
//   1. materializes the SAMPLE packages' raw source on disk (open-source-on-device),
//   2. builds the package registry + audit log + meta plane against the SHARED grant + capability
//      registry (so a grant change the meta plane writes is the grant store the broker reads — live),
//   3. mints the PACKAGE MANAGER app session (the ONLY app granted the `meta` capability) and publishes
//      its token to /session.js so the in-browser puter.js authenticates to /api,
//   4. serves the Package Manager web app at /pkgmgr/ (its own raw HTML/JS — Vita's code, AGPL-clean).
//
// The sample packages are ALSO minted as live app sessions, so their gated fs/kv calls are real and the
// permission/audit/fail-closed behavior is genuine (revoke fs.read → the package's next read is 403).
//
// Run:
//   node --experimental-strip-types ui_kits/desktop/runtime/puter/pkgmgr/serve-pkgmgr.ts [--port 7690] [--dir <dir>]
// Then open  http://127.0.0.1:7690/  (serves the Package Manager).
//
// Emits `[serve-pkgmgr] READY {...}` once listening so a driver script can parse the URL + data dir.

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { startPuterPlatformService } from "../server/service.ts";
import type { PuterCapability } from "../capability.ts";
import { createAuditLog } from "./audit-log.ts";
import { createMetaPlane } from "./meta-plane.ts";
import { createPackageRegistry } from "./package-registry.ts";
import { nodeSourceFs } from "./node-source-fs.ts";
import { materializeSamples } from "./samples.ts";

// The Package Manager app identity. It is the ONLY app granted the `meta` capability (the permission
// control plane). Default-deny: no other app id is declared with `meta`.
const PKGMGR_APP_ID = "vita.pkgmgr";
const PKGMGR_INSTANCE = "vita-pkgmgr-instance-0001";
const PKGMGR_GRANTS: readonly PuterCapability[] = Object.freeze(["meta", "ui", "auth"]);

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);

  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<void> {
  const port = Number(arg("port") ?? "7690");
  const appsRoot = arg("dir") ?? mkdtempSync(join(tmpdir(), "vita-pkgmgr-"));

  // 1) Materialize the sample packages' RAW SOURCE on disk + get their initial grant map.
  const samples = materializeSamples(appsRoot);

  // 2) The audit log is shared between the gate (records decisions) and the meta plane (reads them).
  const audit = createAuditLog();

  // 3) The package registry, backed by the real on-disk source trees (node:fs, confined per package).
  const registry = createPackageRegistry({ fs: nodeSourceFs, seed: samples.packages });

  // 4) Start the REAL platform service. appGrants seeds the broker's grant store with:
  //      - the Package Manager app's grants (meta + ui + auth) — ONLY this app gets `meta`,
  //      - each sample package's initial grants (notes: full; tracker: restricted read-only).
  //    The meta-plane factory is called with the SAME grant + capability registry the broker uses, so a
  //    revoke through /meta/* is enforced on the package's next gated call (fail-closed).
  const appGrants: Record<string, readonly PuterCapability[]> = {
    [PKGMGR_APP_ID]: PKGMGR_GRANTS,
    ...samples.grants,
  };

  const service = await startPuterPlatformService({
    appsRoot,
    audit,
    appGrants,
    faces: { localHost: "127.0.0.1", localPort: port },
    metaPlaneFactory: ({ capabilities, grants }) =>
      createMetaPlane({ audit, capabilities, grants, packages: registry }),
    mode: "local-desktop",
    storeAppId: PKGMGR_APP_ID,
  });

  // 5) Mint the PACKAGE MANAGER app session (the meta holder) + publish its token to /session.js.
  const pkgmgrHandle = service.mintApp({ appId: PKGMGR_APP_ID, grants: PKGMGR_GRANTS, instanceId: PKGMGR_INSTANCE });

  service.setLocalSessionToken(pkgmgrHandle.token);

  // 6) Mint each SAMPLE package as a live app session, so its gated fs/kv calls are real (the permission
  //    + audit + fail-closed behavior is genuine). The verification drives these tokens directly to prove
  //    a revoked capability is denied on the next call.
  const sampleTokens: Record<string, string> = {};

  for (const pkg of samples.packages) {
    const grants = samples.grants[pkg.id] ?? [];
    const handle = service.mintApp({ appId: pkg.id, grants, instanceId: `${pkg.id}-instance-0001` });

    sampleTokens[pkg.id] = handle.token;
  }

  const localUrl = service.localUrl ?? `http://127.0.0.1:${port}`;
  const pkgmgrUrl = `${localUrl}/pkgmgr-app/`;

  console.log("");
  console.log("  Vita Package Manager — interactive local face");
  console.log("  ─────────────────────────────────────────────");
  console.log(`  pkgmgr URL : ${pkgmgrUrl}`);
  console.log(`  root URL   : ${localUrl}/   (redirects to the Package Manager)`);
  console.log(`  data dir   : ${appsRoot}`);
  console.log(`  meta token : ${pkgmgrHandle.token.slice(0, 10)}…  (app=${PKGMGR_APP_ID}, grants=meta,ui,auth)`);
  console.log("");

  // Machine-readable line for the driver (puppeteer). Includes the sample tokens so the driver can drive
  // a package's OWN data-plane calls (proving a revoke denies the package's next call).
  console.log(`[serve-pkgmgr] READY ${JSON.stringify({
    pkgmgrUrl,
    localUrl,
    appsRoot,
    port,
    metaToken: pkgmgrHandle.token,
    sampleTokens,
    apiOrigin: `${localUrl}/api`,
  })}`);

  process.on("SIGINT", () => { void service.close().then(() => process.exit(0)); });
  process.on("SIGTERM", () => { void service.close().then(() => process.exit(0)); });
}

main().catch((err: unknown) => {
  console.error(`[serve-pkgmgr] FATAL ${err instanceof Error ? err.stack : String(err)}`);
  process.exitCode = 1;
});
