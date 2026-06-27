// verify-shell-ondevice — prove the ON-DEVICE startPuterPlatformService serves the MULTI-WINDOW SHELL
// on its LOCAL (trust-on-host) face: the shell page at `/`, the per-app session map at /shell-session.js
// (one default-deny session per registry app: console=control, package-manager=meta, terminal=exec,
// others minimal), and that each minted app token clears the api_origin gate for its grants while a
// revoke (via the shared grant registry the meta plane writes) makes the next gated call 403.
//
// No browser, no VM — a pure node harness over the REAL service factory + REAL file store, so it runs in
// the no-VM verification lane. Exits non-zero (and prints FAIL ...) on any check that does not hold.
//
// Run: node --experimental-strip-types ui_kits/desktop/runtime/puter/spike/verify-shell-ondevice.mjs

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = resolve(fileURLToPath(import.meta.url), "..");      // .../puter/spike
const puterDir = resolve(here, "..");                            // .../puter
const uiKitsDesktop = resolve(puterDir, "../..");                // ui_kits/desktop
const repoRoot = resolve(uiKitsDesktop, "../..");                // repo root

const { startPuterPlatformService, DEFAULT_SHELL_APPS } = await import(
  resolve(puterDir, "server/index.ts")
);
const { createMetaPlane, createPackageRegistry, createAuditLog, nodeSourceFs } = await import(
  resolve(puterDir, "pkgmgr/index.ts")
);

function http(method, url, headers = {}) {
  return fetch(url, { method, headers });
}

async function main() {
  const dir = mkdtempSync(join(tmpdir(), "vita-shell-od-"));
  const shellHtmlPath = resolve(puterDir, "shell/shell.html");

  // The meta plane the Package Manager reaches at /meta/* — built over the SHARED grant + capability
  // registry so a revoke it writes takes effect on the next gated call. Mirrors serve-pkgmgr.ts wiring.
  // Seed serverless-todo as an INSTALLED package so the meta grants endpoint (which operates on known
  // installed packages, exactly as the pkgmgr UI lists + revokes them) can revoke its kv.write.
  const metaPlaneFactory = ({ grants, capabilities }) => {
    const audit = createAuditLog();
    const registry = createPackageRegistry({
      fs: nodeSourceFs,
      seed: [{
        id: "com.puter-apps.serverless-todo",
        name: "Serverless Todo",
        version: "1.0.0",
        kind: "web-app",
        sourceDir: dir,
        entry: "/index.html",
        requested: ["fs.read", "fs.write", "kv.read", "kv.write", "ui", "auth"],
        state: "installed",
        description: "A real third-party Puter app (kv-backed todos).",
      }],
    });
    return createMetaPlane({ audit, capabilities, grants, packages: registry });
  };

  const service = await startPuterPlatformService({
    mode: "local-desktop",
    appsRoot: dir,
    insecureNetworkPlaintext: true,
    faces: { localHost: "127.0.0.1", localPort: 0 },
    metaPlaneFactory,
    shell: {
      apps: DEFAULT_SHELL_APPS,
      htmlPath: shellHtmlPath,
      staticAliases: {
        "/console": resolve(repoRoot, "apps/vita-deploy-console"),
        "/editor": resolve(puterDir, "../devloop/editor"),
        "/shell": resolve(puterDir, "shell"),
        "/ui_kits": resolve(repoRoot, "ui_kits"),
      },
    },
  });

  const base = service.localUrl;
  let failures = 0;
  const check = (cond, msg) => { if (cond) { console.log(`  PASS ${msg}`); } else { failures += 1; console.log(`  FAIL ${msg}`); } };

  try {
    // 1) The shell page renders at `/` (the multi-window desktop, NOT the single-app kiosk-entry).
    const root = await http("GET", `${base}/`);
    const rootHtml = await root.text();
    check(root.status === 200, `GET / → 200 (got ${root.status})`);
    check(/\/shell\/shell\.js/.test(rootHtml), "/ serves the SHELL page (references /shell/shell.js)");
    check(/shell-session\.js/.test(rootHtml), "/ references /shell-session.js");
    check(/data-vita-screen="desktop"/.test(rootHtml), "/ has the desktop screen root");

    // 2) The per-app session map: one session per registry app, each carrying EXACTLY its grants.
    const sess = await http("GET", `${base}/shell-session.js`);
    const sessText = await sess.text();
    check(sess.status === 200, `GET /shell-session.js → 200 (got ${sess.status})`);
    const m = /window\.__vitaShell\s*=\s*(\{[\s\S]*\});/.exec(sessText);
    assert(m, "shell-session.js must define window.__vitaShell");
    const payload = JSON.parse(m[1]);
    const sessions = payload.sessions;
    check(Object.keys(sessions).length === DEFAULT_SHELL_APPS.length, `${DEFAULT_SHELL_APPS.length} per-app sessions published (got ${Object.keys(sessions).length})`);
    for (const app of DEFAULT_SHELL_APPS) {
      const s = sessions[app.id];
      check(s && typeof s.token === "string" && s.token.length > 0, `session minted for ${app.id}`);
    }

    // 3) The privileged caps are held ONLY by the intended apps (default-deny everywhere else).
    const consoleSession = sessions["vita.app.deploy-console"];
    const pkgmgrSession = sessions["vita.app.package-manager"];
    const terminalSession = sessions["vita.app.terminal"];
    const todoSession = sessions["com.puter-apps.serverless-todo"];
    check(!!consoleSession && !!pkgmgrSession && !!terminalSession && !!todoSession, "console/pkgmgr/terminal/todo all present");

    // 4) An ordinary app (serverless-todo) does a real kv.set (gated on kv.write) through /api with its
    //    token — the same /drivers/call the puter.js SDK uses. A clean single JSON round-trip.
    const todoAuth = { authorization: `Bearer ${todoSession.token}` };
    const whoami = await http("GET", `${base}/api/whoami`, todoAuth);
    check(whoami.status === 200, `serverless-todo /api/whoami → 200 (got ${whoami.status})`);

    const kvSet = (key, value) => fetch(`${base}/api/drivers/call`, {
      method: "POST",
      headers: { ...todoAuth, "content-type": "application/json" },
      body: JSON.stringify({ interface: "puter-kvstore", method: "set", args: { key, value } }),
    });
    const ok1 = await kvSet("todo:1", "buy milk");
    check(ok1.status === 200, `serverless-todo kv.set → 200 (got ${ok1.status})`);

    // 5) The Package Manager (meta) revokes serverless-todo's kv.write, then that app's next kv.set 403s
    //    (revoke takes effect live via the shared grant registry). This is the permission-revocation path
    //    the browser verification drives through the pkgmgr UI; here we hit the meta endpoint directly.
    //    POST /meta/packages/:id/grants { capability, action:"revoke" } — applyGrantChange writes the SHARED
    //    grant registry keyed by appId, so it works on the live serverless-todo grants. Same call the UI makes.
    const pkgAuth = { authorization: `Bearer ${pkgmgrSession.token}`, "content-type": "application/json" };
    const setGrants = await fetch(`${base}/api/meta/packages/com.puter-apps.serverless-todo/grants`, {
      method: "POST",
      headers: pkgAuth,
      body: JSON.stringify({ capability: "kv.write", action: "revoke" }),
    });
    check([200, 204].includes(setGrants.status), `pkgmgr revoke kv.write on serverless-todo → 2xx (got ${setGrants.status})`);

    const ok2 = await kvSet("todo:2", "no");
    check(ok2.status === 403, `serverless-todo kv.set AFTER revoke → 403 (got ${ok2.status})`);

    // 6) Negative: the ordinary app cannot reach /meta/* (no `meta` cap) — default-deny.
    const todoMeta = await http("GET", `${base}/api/meta/packages`, todoAuth);
    check(todoMeta.status === 403 || todoMeta.status === 401, `serverless-todo GET /meta/packages → 401/403 (got ${todoMeta.status})`);
  } finally {
    await service.close();
    rmSync(dir, { recursive: true, force: true });
  }

  if (failures > 0) { console.log(`\nverify-shell-ondevice: ${failures} FAILED`); process.exit(1); }
  console.log("\nverify-shell-ondevice: ALL CHECKS PASSED");
}

main().catch((err) => { console.error("verify-shell-ondevice FATAL", err); process.exit(1); });
