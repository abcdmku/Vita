// Real-browser verification of the Vita Desk interactive UI.
//
// Drives headless Chrome (puppeteer-core, local Chrome — no bundled download) against a running
// serve-interactive instance. It CLICKS through the actual app the way an owner would:
//   • Files  : create a folder, create a file (real fs.mkdir / fs.write multipart upload)
//   • Notes  : open + edit + save a note (real fs.write overwrite), confirm it lands in the note list
//   • Settings: change theme + accent + default view (real kv.set) — persisted prefs
// Then it RELOADS and asserts everything persisted (folder, file, note text, theme, accent, view).
// This exercises the genuine browser-only fs.write multipart-upload path the Node-VM shim can't reach.
//
// Prereqs (kept OUT of the repo deps — install ad-hoc so the repo stays dep-light + offline-first):
//   npm i -g puppeteer-core   (or install in a scratch dir and run from there)
// and a local Chromium-family browser. Point CHROME_PATH at it (default tries the Windows Chrome path):
//   Linux:   CHROME_PATH=/usr/bin/chromium     macOS: .../Google Chrome.app/.../Google Chrome
//
// Usage:
//   1) node --experimental-strip-types spike/serve-interactive.ts --port 7681   (in one shell)
//   2) CHROME_PATH=<chrome> node spike/verify-interactive.mjs http://127.0.0.1:7681/kiosk-entry.html ./shots
// Exit 0 = all assertions passed; non-zero otherwise. Captures screenshots along the way.

import puppeteer from "puppeteer-core";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const KIOSK_URL = process.argv[2] ?? "http://127.0.0.1:7681/kiosk-entry.html";
const SHOT_DIR = process.argv[3] ?? ".";
const CHROME = process.env.CHROME_PATH ?? "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";

mkdirSync(SHOT_DIR, { recursive: true });

const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
}

// Let the view-in CSS transition (~0.22s) settle so screenshots aren't caught mid-fade.
const settle = (page, ms = 420) => page.evaluate((m) => new Promise((r) => setTimeout(r, m)), ms);
async function shot(page, name) { await settle(page); await page.screenshot({ path: join(SHOT_DIR, name) }); }

const STAMP = Date.now();
const NEW_FOLDER = "verify-folder-" + STAMP;
const NEW_FILE = "verify-" + STAMP + ".txt";
const NOTE_PATH = "/home/notes/welcome.txt";
const NOTE_TEXT = "Edited by the real-browser verification at " + new Date().toISOString();

// Deterministically fill + confirm the app's own modal prompt (our DOM, not a native dialog).
async function fillModal(page, value) {
  await page.waitForSelector("#modal:not([hidden])", { timeout: 5000 });
  await page.$eval("#modal-input", (el) => (el.value = ""));
  await page.type("#modal-input", value);
  await page.click("#modal-ok");
  await page.waitForFunction(() => document.querySelector("#modal").hasAttribute("hidden"), { timeout: 5000 });
}

// If the genuine puter.js SDK pops its "authenticate with Puter" consent modal, click Continue. With
// env=app + a token this should not happen; this only guards against an env-detection edge.
async function dismissPuterConsent(page) {
  try {
    const clicked = await page.evaluate(() => {
      const btns = Array.from(document.querySelectorAll("button"));
      const cont = btns.find((b) => /^\s*continue\s*$/i.test(b.textContent || ""));
      if (cont && cont.offsetParent !== null) { cont.click(); return true; }
      return false;
    });
    if (clicked) { console.log("(dismissed a stray Puter consent modal)"); await new Promise((r) => setTimeout(r, 400)); }
    return clicked;
  } catch { return false; }
}

async function main() {
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: "new",
    args: ["--no-sandbox", "--disable-dev-shm-usage", "--window-size=1280,860"],
    defaultViewport: { width: 1280, height: 820 },
  });
  const page = await browser.newPage();
  const consoleErrors = [];
  // The puter.js SDK opens a realtime socket.io websocket we deliberately don't serve (no realtime in
  // the local single-owner face); its 404/closed-before-connect is benign noise, not an app error.
  const IGNORE = /socket\.io|websocket|realtime|favicon/i;
  page.on("console", (m) => { if (m.type() === "error" && !IGNORE.test(m.text())) consoleErrors.push(m.text()); });
  page.on("pageerror", (e) => { if (!IGNORE.test(e.message)) consoleErrors.push("pageerror: " + e.message); });

  try {
    // ---- 1. Load + boot ----
    await page.goto(KIOSK_URL, { waitUntil: "networkidle2", timeout: 30000 });
    await page.waitForFunction(() => window.__vitaDeskReady === true, { timeout: 20000 });
    check("app booted (window.__vitaDeskReady)", true);

    const conn = await page.$eval("#conn", (el) => el.textContent.trim());
    check("api_origin connected (whoami)", /connected/i.test(conn), "conn=" + conn);

    const who = await page.$eval("#who-name", (el) => el.textContent.trim());
    check("whoami rendered owner", who.length > 0 && who !== "…", "who=" + who);

    await shot(page, "01-files.png");

    // ---- 2. Create a NEW FOLDER (real fs.mkdir) ----
    await page.click("#btn-newfolder");
    await fillModal(page, NEW_FOLDER);
    await page.waitForFunction(
      (n) => Array.from(document.querySelectorAll(".file .name")).some((e) => e.textContent === n),
      { timeout: 8000 }, NEW_FOLDER,
    );
    check("New folder created (fs.mkdir)", true, NEW_FOLDER);

    // ---- 3. Create a NEW FILE (real fs.write multipart upload) — opens it in Notes ----
    await page.click("#btn-newfile");
    await fillModal(page, NEW_FILE);
    await page.waitForFunction(
      () => document.querySelector(".view-notes").classList.contains("is-active"),
      { timeout: 8000 },
    );
    check("New file created + opened in Notes", true, NEW_FILE);

    // ---- 4. Open the welcome note from the note list, edit + SAVE (real fs.write overwrite) ----
    await page.evaluate(() => {
      const li = Array.from(document.querySelectorAll(".note-item")).find((x) => x.dataset.path === "/home/notes/welcome.txt");
      if (li) li.click();
    });
    await page.waitForFunction(
      () => /opened|new file/i.test(document.querySelector("#note-status").textContent),
      { timeout: 8000 },
    );
    await page.$eval("#note-body", (el) => (el.value = ""));
    await page.type("#note-body", NOTE_TEXT);
    await page.click("#btn-save");
    await page.waitForFunction(
      () => /saved/i.test(document.querySelector("#note-status").textContent),
      { timeout: 8000 },
    );
    check("Note saved (fs.write overwrite)", true, NOTE_PATH);
    await shot(page, "02-notes.png");

    // ---- 5. Settings: theme + accent + default view (real kv.set) ----
    await page.click('.tab[data-view="settings"]');
    await page.waitForSelector(".view-settings.is-active", { timeout: 5000 });

    await page.click('#theme-picker .swatch[data-theme="slate"]');
    await page.waitForFunction(() => document.documentElement.getAttribute("data-theme") === "slate", { timeout: 5000 });
    check("Theme set (kv.set)", true, "slate");

    await page.click('#accent-picker .dot[data-accent="emerald"]');
    await page.waitForFunction(() => document.documentElement.getAttribute("data-accent") === "emerald", { timeout: 5000 });
    check("Accent set (kv.set)", true, "emerald");

    await page.click('#set-view-grid');
    await page.waitForFunction(() => document.querySelector("#app").getAttribute("data-fileview") === "grid", { timeout: 5000 });
    check("Default view set to grid (kv.set)", true);
    await shot(page, "03-settings.png");

    // ---- 6. Back to Files: confirm folder + file present, grid view applied ----
    await page.click('.tab[data-view="files"]');
    await page.waitForSelector(".view-files.is-active", { timeout: 5000 });
    await page.waitForFunction(
      (f) => Array.from(document.querySelectorAll(".file .name")).some((e) => e.textContent === f),
      { timeout: 8000 }, NEW_FILE,
    );
    check("New file appears in file list", true);
    await shot(page, "04-files-grid.png");

    // ============================================================================================
    // RELOAD — the real persistence test. New page context, same store.
    // ============================================================================================
    await page.reload({ waitUntil: "networkidle2", timeout: 30000 });
    await page.waitForFunction(() => window.__vitaDeskReady === true, { timeout: 20000 });
    await dismissPuterConsent(page);

    const folderStillThere = await page.evaluate(
      (n) => Array.from(document.querySelectorAll(".file .name")).some((e) => e.textContent === n), NEW_FOLDER);
    check("PERSIST: folder survives reload", folderStillThere);

    const fileStillThere = await page.evaluate(
      (n) => Array.from(document.querySelectorAll(".file .name")).some((e) => e.textContent === n), NEW_FILE);
    check("PERSIST: file survives reload", fileStillThere);

    const themeAfter = await page.evaluate(() => document.documentElement.getAttribute("data-theme"));
    check("PERSIST: theme survives reload (KV)", themeAfter === "slate", "theme=" + themeAfter);

    const accentAfter = await page.evaluate(() => document.documentElement.getAttribute("data-accent"));
    check("PERSIST: accent survives reload (KV)", accentAfter === "emerald", "accent=" + accentAfter);

    const viewAfter = await page.evaluate(() => document.querySelector("#app").getAttribute("data-fileview"));
    check("PERSIST: default view survives reload (KV)", viewAfter === "grid", "view=" + viewAfter);

    // note content persisted: open it from the note list
    await page.click('.tab[data-view="notes"]');
    await page.waitForSelector(".view-notes.is-active", { timeout: 5000 });
    await page.evaluate(() => {
      const li = Array.from(document.querySelectorAll(".note-item")).find((x) => x.dataset.path === "/home/notes/welcome.txt");
      if (li) li.click();
    });
    await page.waitForFunction(() => /opened/i.test(document.querySelector("#note-status").textContent), { timeout: 8000 });
    const noteAfter = await page.$eval("#note-body", (el) => el.value);
    check("PERSIST: note content survives reload", noteAfter === NOTE_TEXT, `len=${noteAfter.length}`);
    await shot(page, "05-after-reload-notes.png");

    // Final hero screenshot: the interactive UI back on Files.
    await page.click('.tab[data-view="files"]');
    await page.waitForSelector(".view-files.is-active", { timeout: 5000 });
    await shot(page, "06-interactive-final.png");

    check("no uncaught console errors", consoleErrors.length === 0, consoleErrors.slice(0, 3).join(" | "));
  } catch (err) {
    check("driver completed without throwing", false, err.message);
    try { await shot(page, "99-failure.png"); } catch {}
  } finally {
    await browser.close();
  }

  const passed = results.filter((r) => r.ok).length;
  const summary = { passed, total: results.length, results, consoleErrors };
  writeFileSync(join(SHOT_DIR, "verify-results.json"), JSON.stringify(summary, null, 2));
  console.log(`\n=== ${passed}/${results.length} checks passed ===`);
  process.exit(passed === results.length ? 0 : 1);
}

main().catch((e) => { console.error("FATAL", e); process.exit(2); });
