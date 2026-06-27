// Real-browser verification of the Vita Package Manager UI.
//
// Drives headless Chrome (puppeteer-core, local Chrome — no bundled download) against a running
// serve-pkgmgr instance. It CLICKS through the actual app:
//   1. lists installed packages,
//   2. views a package's SOURCE and EDITS a file → shows the change took effect (re-reads it),
//   3. views a package's PERMISSIONS, REVOKES one, and confirms the package's own call is now denied 403,
//   4. sees the AUDIT log (the denial appears),
//   5. DISABLES a package.
//
// Prereqs (kept OUT of the repo deps): puppeteer-core + a local Chromium-family browser. Point
// CHROME_PATH at it (default tries the Windows Chrome path). The driver is launched with PPTR_DIR set to
// a node_modules dir containing puppeteer-core (so the repo stays dep-light).
//
// Usage:
//   1) node --experimental-strip-types pkgmgr/serve-pkgmgr.ts --port 7690            (one shell)
//   2) CHROME_PATH=<chrome> node pkgmgr/verify-pkgmgr.mjs <READY_JSON> ./shots       (the READY line's JSON)
// Exit 0 = all assertions passed.

import { createRequire } from "node:module";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const PPTR_DIR = process.env.PPTR_DIR;
const require = createRequire(PPTR_DIR ? join(PPTR_DIR, "noop.js") : import.meta.url);
const puppeteer = require("puppeteer-core");

const READY = JSON.parse(process.argv[2] ?? "{}");
const SHOT_DIR = process.argv[3] ?? ".";
const CHROME = process.env.CHROME_PATH ?? "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";

const PKGMGR_URL = READY.pkgmgrUrl;
const API_ORIGIN = READY.apiOrigin;
const TRACKER_TOKEN = (READY.sampleTokens || {})["com.acme.tracker"];

mkdirSync(SHOT_DIR, { recursive: true });

const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
}

// Ignore benign noise AND the INTENTIONAL 403 we trigger (the fail-closed proof: after revoking the
// tracker's fs.read, its own readdir is denied 403 — Chrome logs that as a "failed to load resource"
// console error, but it is exactly the behavior under test, not a product error).
const IGNORE = /socket\.io|websocket|realtime|favicon|status of 403|403 \(Forbidden\)/i;

async function main() {
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: "new",
    args: ["--no-sandbox", "--disable-dev-shm-usage", "--window-size=1320,900"],
    defaultViewport: { width: 1320, height: 860 },
  });
  const page = await browser.newPage();
  const consoleErrors = [];
  page.on("console", (m) => { if (m.type() === "error" && !IGNORE.test(m.text())) consoleErrors.push(m.text()); });
  page.on("pageerror", (e) => { if (!IGNORE.test(e.message)) consoleErrors.push("pageerror: " + e.message); });

  try {
    // ---- 1. Load + boot + LIST ----
    await page.goto(PKGMGR_URL, { waitUntil: "networkidle2", timeout: 30000 });
    await page.waitForFunction(() => window.__vitaPkgMgrReady === true, { timeout: 20000 });
    check("app booted (window.__vitaPkgMgrReady)", true);

    const conn = await page.$eval("#conn", (el) => el.textContent.trim());
    check("meta-api connected", /connected/i.test(conn), "conn=" + conn);

    await page.waitForFunction(() => document.querySelectorAll("#pkg-list .pkg").length >= 2, { timeout: 8000 });
    const pkgIds = await page.$$eval("#pkg-list .pkg", (els) => els.map((e) => e.dataset.id));
    check("LIST: installed packages listed", pkgIds.includes("com.vita.notes") && pkgIds.includes("com.acme.tracker"), pkgIds.join(", "));
    await page.screenshot({ path: join(SHOT_DIR, "01-list.png") });

    // ---- 2. SOURCE: select notes, open main.ts, EDIT + save, confirm it took effect ----
    await page.click('.pkg[data-id="com.vita.notes"]');
    await page.waitForFunction(() => !document.querySelector("#detail").hidden, { timeout: 8000 });
    // The source-dir banner proves open-source-on-device.
    const srcDir = await page.$eval("#d-source-dir", (el) => el.textContent.trim());
    check("SOURCE: source dir shown (open-source-on-device)", /source$/.test(srcDir), srcDir);

    await page.waitForFunction(() => Array.from(document.querySelectorAll("#tree .tnode-name")).some((e) => e.textContent === "main.ts"), { timeout: 8000 });
    // Click main.ts in the tree.
    await page.evaluate(() => {
      const n = Array.from(document.querySelectorAll("#tree .tnode")).find((e) => e.querySelector(".tnode-name")?.textContent === "main.ts");
      n?.click();
    });
    await page.waitForFunction(() => /main\.ts/.test(document.querySelector("#editor-path").textContent) && !document.querySelector("#editor").disabled, { timeout: 8000 });
    const original = await page.$eval("#editor", (el) => el.value);
    check("SOURCE: raw main.ts opened in editor", /greeting/.test(original));

    const MARKER = "EDITED-BY-VERIFY-" + Date.now();
    const edited = original.replace(/hello from com\.vita\.notes v1/, MARKER);
    await page.$eval("#editor", (el) => { el.value = ""; });
    await page.type("#editor", edited);
    await page.click("#btn-save");
    await page.waitForFunction(() => /saved/i.test(document.querySelector("#editor-status").textContent), { timeout: 8000 });
    check("EDIT: source saved + rebuilt", true);
    await page.screenshot({ path: join(SHOT_DIR, "02-source-edit.png") });

    // Re-open the file (reload from the meta-API) and confirm the edit is what's served back.
    await page.evaluate(() => { document.querySelector("#editor").value = "RELOADING"; });
    await page.evaluate(() => {
      const n = Array.from(document.querySelectorAll("#tree .tnode")).find((e) => e.querySelector(".tnode-name")?.textContent === "main.ts");
      n?.click();
    });
    await page.waitForFunction((m) => document.querySelector("#editor").value.includes(m), { timeout: 8000 }, MARKER);
    const reread = await page.$eval("#editor", (el) => el.value);
    check("EDIT TOOK EFFECT: re-read source contains the edit", reread.includes(MARKER), "marker present");

    // ---- 3. PERMISSIONS: select tracker, revoke fs.read, confirm the package's call is now denied 403 ----
    await page.click('.pkg[data-id="com.acme.tracker"]');
    await page.waitForFunction(() => document.querySelector("#d-name").textContent.includes("Activity Tracker"), { timeout: 8000 });
    await page.click('.tab[data-tab="perms"]');
    await page.waitForFunction(() => document.querySelector(".panel-perms").classList.contains("is-active"), { timeout: 5000 });
    await page.waitForFunction(() => Array.from(document.querySelectorAll("#perm-body tr")).some((r) => r.dataset.cap === "fs.read"), { timeout: 5000 });
    check("PERMISSIONS: requested vs granted shown", true);

    // Sanity: BEFORE revoke the tracker's own readdir succeeds (200), via its token directly.
    const before = await page.evaluate(async (api, tok) => {
      const r = await fetch(api + "/readdir", { method: "POST", headers: { authorization: "Bearer " + tok, "content-type": "application/json" }, body: JSON.stringify({ path: "/" }) });
      return r.status;
    }, API_ORIGIN, TRACKER_TOKEN);
    check("PRE-REVOKE: tracker readdir allowed (200)", before === 200, "status=" + before);

    // Click Revoke on the fs.read row.
    await page.evaluate(() => {
      const row = Array.from(document.querySelectorAll("#perm-body tr")).find((r) => r.dataset.cap === "fs.read");
      const btn = row?.querySelector("button");
      btn?.click();
    });
    await page.waitForFunction(() => /enforced/i.test(document.querySelector("#perm-status").textContent), { timeout: 8000 });
    check("REVOKE: fs.read revoked", true);
    await page.screenshot({ path: join(SHOT_DIR, "03-permissions-revoke.png") });

    // AFTER revoke the tracker's own readdir is DENIED 403 (fail-closed, enforced on the next call).
    const after = await page.evaluate(async (api, tok) => {
      const r = await fetch(api + "/readdir", { method: "POST", headers: { authorization: "Bearer " + tok, "content-type": "application/json" }, body: JSON.stringify({ path: "/" }) });
      const body = await r.json().catch(() => ({}));
      return { status: r.status, code: body.code };
    }, API_ORIGIN, TRACKER_TOKEN);
    check("FAIL-CLOSED: tracker readdir now DENIED 403 (CAP_DENIED)", after.status === 403 && after.code === "CAP_DENIED", `status=${after.status} code=${after.code}`);

    // ---- 4. AUDIT: the denial is visible in the activity log ----
    await page.click('.tab[data-tab="activity"]');
    await page.waitForFunction(() => document.querySelector(".panel-activity").classList.contains("is-active"), { timeout: 5000 });
    await page.click("#btn-reload-audit");
    await page.waitForFunction(() => Array.from(document.querySelectorAll("#audit .audit-row")).some((r) => r.classList.contains("audit-deny")), { timeout: 8000 });
    const denials = await page.$$eval("#audit .audit-deny", (els) => els.length);
    check("AUDIT: a denial is visible in the activity log", denials >= 1, denials + " denial rows");
    await page.screenshot({ path: join(SHOT_DIR, "04-audit.png") });

    // ---- 5. DISABLE a package ----
    await page.click("#btn-disable");
    await page.waitForFunction(() => !document.querySelector("#modal").hidden, { timeout: 5000 });
    await page.click("#modal-ok");
    await page.waitForFunction(() => document.querySelector("#d-state").textContent.trim() === "disabled", { timeout: 8000 });
    check("DISABLE: package killed (state=disabled)", true);
    await page.screenshot({ path: join(SHOT_DIR, "05-disabled.png") });

    check("no uncaught console errors", consoleErrors.length === 0, consoleErrors.slice(0, 3).join(" | "));
  } catch (err) {
    check("driver completed without throwing", false, err.message);
    try { await page.screenshot({ path: join(SHOT_DIR, "99-failure.png") }); } catch {}
  } finally {
    await browser.close();
  }

  const passed = results.filter((r) => r.ok).length;
  writeFileSync(join(SHOT_DIR, "verify-results.json"), JSON.stringify({ passed, total: results.length, results, consoleErrors }, null, 2));
  console.log(`\n=== ${passed}/${results.length} checks passed ===`);
  process.exit(passed === results.length ? 0 : 1);
}

main().catch((e) => { console.error("FATAL", e); process.exit(2); });
