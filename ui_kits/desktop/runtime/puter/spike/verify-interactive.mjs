// Real-browser verification of the Vita Desk interactive UI.
//
// Drives headless Chrome (puppeteer-core, local Chrome — no bundled download) against a running
// serve-interactive instance. It CLICKS through the actual app: create a file, edit + save a note,
// bump a KV counter, change the theme — then RELOADS and asserts everything persisted. This exercises
// the genuine browser-only fs.write multipart-upload path the earlier Node-VM shim could not reach.
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

const UNIQUE = "vita-verify-" + Date.now();
const NOTE_PATH = "/home/notes/welcome.txt";
const NOTE_TEXT = "Edited by the real-browser verification at " + new Date().toISOString();

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

    await page.screenshot({ path: join(SHOT_DIR, "01-booted.png") });

    // ---- 2. Create a NEW FILE via the modal (real fs.write multipart upload) ----
    // Stub the in-app prompt modal deterministically by typing into its input, since the modal is our
    // own DOM (no native dialog). We click "New file", then fill the modal + OK.
    await page.click("#btn-newfile");
    await page.waitForSelector("#modal:not([hidden])", { timeout: 5000 });
    await page.$eval("#modal-input", (el) => (el.value = ""));
    await page.type("#modal-input", UNIQUE + ".txt");
    await page.click("#modal-ok");
    // Creating a new file opens it in Notes; wait for the note view + status.
    await page.waitForFunction(
      () => document.querySelector(".view-notes").classList.contains("is-active"),
      { timeout: 8000 },
    );
    check("New file created + opened in Notes", true, UNIQUE + ".txt");

    // ---- 3. Edit the note + SAVE (real fs.write overwrite upload) ----
    await page.$eval("#note-path", (el) => (el.value = ""));
    await page.type("#note-path", NOTE_PATH);
    await page.click("#btn-open");
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
    await page.screenshot({ path: join(SHOT_DIR, "02-note-saved.png") });

    // ---- 4. KV: bump the counter twice + set theme ----
    await page.click('.tab[data-view="settings"]');
    await page.waitForSelector(".view-settings.is-active", { timeout: 5000 });
    const before = Number(await page.$eval("#count", (el) => el.textContent));
    await page.click("#btn-count");
    await page.click("#btn-count");
    await page.waitForFunction(
      (b) => Number(document.querySelector("#count").textContent) === b + 2,
      { timeout: 5000 }, before,
    );
    const afterCount = Number(await page.$eval("#count", (el) => el.textContent));
    check("KV counter incremented", afterCount === before + 2, `${before} -> ${afterCount}`);

    await page.select("#theme-select", "slate");
    await page.waitForFunction(
      () => document.documentElement.getAttribute("data-theme") === "slate",
      { timeout: 5000 },
    );
    check("Theme set (kv.set)", true, "slate");
    await page.screenshot({ path: join(SHOT_DIR, "03-settings.png") });

    // ---- 5. Go to Files, confirm the new file is listed ----
    await page.click('.tab[data-view="files"]');
    await page.waitForSelector(".view-files.is-active", { timeout: 5000 });
    await page.click("#btn-refresh");
    await page.waitForFunction(
      (n) => Array.from(document.querySelectorAll(".file .name")).some((e) => e.textContent === n),
      { timeout: 8000 }, UNIQUE + ".txt",
    );
    check("New file appears in file list", true);
    await page.screenshot({ path: join(SHOT_DIR, "04-files.png") });

    // ============================================================================================
    // RELOAD — the real persistence test. New page context, same store.
    // ============================================================================================
    await page.reload({ waitUntil: "networkidle2", timeout: 30000 });
    await page.waitForFunction(() => window.__vitaDeskReady === true, { timeout: 20000 });
    await dismissPuterConsent(page); // belt-and-braces: should never appear now (env=app)

    // 5a. file still listed
    const fileStillThere = await page.evaluate(
      (n) => Array.from(document.querySelectorAll(".file .name")).some((e) => e.textContent === n),
      UNIQUE + ".txt",
    );
    check("PERSIST: file survives reload", fileStillThere);

    // 5b. theme persisted (loaded from KV on boot)
    const themeAfter = await page.evaluate(() => document.documentElement.getAttribute("data-theme"));
    check("PERSIST: theme survives reload (KV)", themeAfter === "slate", "theme=" + themeAfter);

    // 5c. counter persisted
    await page.click('.tab[data-view="settings"]');
    await page.waitForSelector(".view-settings.is-active", { timeout: 5000 });
    const countAfter = Number(await page.$eval("#count", (el) => el.textContent));
    check("PERSIST: KV counter survives reload", countAfter === afterCount, `expected ${afterCount}, got ${countAfter}`);

    // 5d. note content persisted
    await page.click('.tab[data-view="notes"]');
    await page.waitForSelector(".view-notes.is-active", { timeout: 5000 });
    await page.$eval("#note-path", (el) => (el.value = ""));
    await page.type("#note-path", NOTE_PATH);
    await page.click("#btn-open");
    await page.waitForFunction(
      () => /opened/i.test(document.querySelector("#note-status").textContent),
      { timeout: 8000 },
    );
    const noteAfter = await page.$eval("#note-body", (el) => el.value);
    check("PERSIST: note content survives reload", noteAfter === NOTE_TEXT, `len=${noteAfter.length}`);
    await page.screenshot({ path: join(SHOT_DIR, "05-after-reload-note.png") });

    // Final hero screenshot: the interactive UI with a real app open (files view).
    await page.click('.tab[data-view="files"]');
    await page.waitForSelector(".view-files.is-active", { timeout: 5000 });
    await page.screenshot({ path: join(SHOT_DIR, "06-interactive-final.png") });

    check("no uncaught console errors", consoleErrors.length === 0, consoleErrors.slice(0, 3).join(" | "));
  } catch (err) {
    check("driver completed without throwing", false, err.message);
    try { await page.screenshot({ path: join(SHOT_DIR, "99-failure.png") }); } catch {}
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
