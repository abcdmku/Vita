// Real-browser verification of the puter.ui.* PICKERS in the multi-window shell.
//
// Drives headless Chrome (puppeteer-core + local Chrome — no bundled download) against a live
// serve-shell instance, exercising the GENUINE vendored puter.js SDK inside Notepad's sandboxed iframe:
//   1. seeds a real file in the api_origin fs (so Open has something to pick)
//   2. loads the shell, opens Notepad (a real third-party Puter app)
//   3. OPEN: clicks Notepad's Open → a REAL picker window browses the fs → selects the seeded file →
//      asserts Notepad's editor loads that file's content (open_file.read() round-tripped via puter.fs)
//   4. SAVE: types new content → Save As → picker → names the file → Save → asserts the file was
//      WRITTEN to the api_origin fs (read back over the API)
//   5. FONT: Font picker → pick a font → asserts the editor's fontFamily changed (object {fontFamily})
//   6. COLOR: Background-color picker → pick a color → asserts the editor's background changed
//   7. GATING: asserts an app WITHOUT fs.read is denied a file picker (CAP_DENIED), proving the pick is
//      confined to an app's granted scope (capability gating, fail-closed)
//
// Usage:  CHROME_PATH=<chrome> NODE_PATH=<scratch>/node_modules \
//           node --experimental-strip-types ui_kits/desktop/runtime/puter/shell/verify-pickers.mjs [./shots]
// Exit 0 = all assertions passed. Self-manages the serve-shell harness (no separate server needed).

import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { startShellHarness } from "./serve-shell.ts";

// puppeteer-core is a verification-only dep (NOT a product dependency). Resolve it from PUPPETEER_PATH
// when set (an out-of-tree install), else the normal module graph. Keeps it out of the repo lockfile.
const puppeteer = (await import(
  process.env.PUPPETEER_PATH ? pathToFileURL(process.env.PUPPETEER_PATH).href : "puppeteer-core"
)).default;

const SHOT_DIR = process.argv[2] ?? "./shots-pickers";
const CHROME = process.env.CHROME_PATH ?? "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const PORT = 7733;

mkdirSync(SHOT_DIR, { recursive: true });

const results = [];
function check(name, ok, detail = "") {
  results.push({ detail, name, ok: !!ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const SEED_NAME = "readme-" + Date.now() + ".txt";
const SEED_BODY = "Hello from a REAL seeded file — " + Date.now();
const SAVE_NAME = "saved-" + Date.now() + ".txt";
const SAVE_BODY = "Notepad wrote this via showSaveFilePicker " + Date.now();

async function main() {
  const dataDir = mkdtempSync(join(tmpdir(), "vita-pickers-"));

  // Seed a real file into the shared api_origin fs store (under <dataDir>/files), so the Open picker has
  // a genuine file to browse + select. The store maps "/<name>" → "<dataDir>/files/<name>".
  mkdirSync(join(dataDir, "files"), { recursive: true });
  writeFileSync(join(dataDir, "files", SEED_NAME), SEED_BODY, "utf8");

  const harness = await startShellHarness({ dir: dataDir, port: PORT });
  const BASE = harness.url.replace(/\/$/, "");
  console.log(`[verify-pickers] shell at ${BASE}  data ${dataDir}`);

  const browser = await puppeteer.launch({
    args: ["--no-sandbox", "--disable-dev-shm-usage", "--window-size=1440,960"],
    defaultViewport: { height: 960, width: 1440 },
    executablePath: CHROME,
    headless: "new",
  });
  const page = await browser.newPage();
  const consoleErrors = [];
  const IGNORE = /socket\.io|websocket|realtime|favicon|net::ERR_|Failed to load resource|txt2speech|puter\.ai/i;
  page.on("console", (m) => { if (m.type() === "error" && !IGNORE.test(m.text())) consoleErrors.push(m.text()); });
  page.on("pageerror", (e) => { if (!IGNORE.test(e.message)) consoleErrors.push("pageerror: " + e.message); });

  try {
    // ---- load shell + open Notepad ----
    await page.goto(BASE + "/", { timeout: 30000, waitUntil: "networkidle2" });
    await page.waitForFunction(() => window.__vitaShellReady === true, { timeout: 20000 });
    check("shell booted", true);

    await page.click("[data-shell-launcher-btn]");
    await page.waitForFunction(() => { const el = document.querySelector("[data-shell-launcher]"); return el && getComputedStyle(el).display !== "none"; }, { timeout: 5000 });
    await page.click('[data-shell-app="com.puter-apps.notepad"]');
    await page.waitForSelector('[data-vita-window="com.puter-apps.notepad"]', { timeout: 15000 });

    const npFrameH = await page.waitForSelector('iframe[data-puter-webapp="com.puter-apps.notepad"]', { timeout: 15000 });
    const np = await npFrameH.contentFrame();
    await np.waitForFunction(() => typeof puter === "object" && document.getElementById("editor") !== null, { timeout: 20000 });
    check("Notepad booted puter.js in its sandbox", true);
    await page.screenshot({ path: join(SHOT_DIR, "01-notepad.png") });

    // ===== OPEN =====
    await np.click("#open-button");
    await page.waitForSelector("[data-shell-picker]", { timeout: 8000 });
    check("Open picker window rendered", true);
    // Wait for the seeded file row to appear in the browse list.
    await page.waitForFunction(
      (name) => Array.from(document.querySelectorAll("[data-shell-picker] [data-picker-entry]")).some((e) => e.textContent.includes(name)),
      { timeout: 8000 }, SEED_NAME,
    );
    await page.screenshot({ path: join(SHOT_DIR, "02-open-picker.png") });

    // Select the seeded file then click Open.
    await page.evaluate((name) => {
      const row = Array.from(document.querySelectorAll("[data-shell-picker] [data-picker-entry]")).find((e) => e.textContent.includes(name));
      row.click();
    }, SEED_NAME);
    await page.click("[data-shell-picker] [data-picker-ok]");
    await page.waitForFunction(() => document.querySelector("[data-shell-picker]") === null, { timeout: 5000 });

    // Notepad loads the content via open_file.read() → puter.fs.read(path) → .text().
    await np.waitForFunction((body) => document.getElementById("editor").value.includes(body), { timeout: 10000 }, SEED_BODY);
    const openedValue = await np.$eval("#editor", (el) => el.value);
    check("Open: Notepad loaded the selected file's REAL content", openedValue.includes(SEED_BODY), JSON.stringify(openedValue.slice(0, 48)));
    await page.screenshot({ path: join(SHOT_DIR, "03-opened.png") });

    // ===== SAVE (Save As) =====
    await np.evaluate((text) => { const e = document.getElementById("editor"); e.value = text; e.dispatchEvent(new Event("input")); }, SAVE_BODY);
    await np.click("#save-as-button");
    await page.waitForSelector("[data-shell-picker]", { timeout: 8000 });
    // Type the destination name in the save dialog's name field.
    await page.evaluate((name) => { const i = document.querySelector("[data-shell-picker] [data-picker-name]"); i.value = name; }, SAVE_NAME);
    await page.screenshot({ path: join(SHOT_DIR, "04-save-picker.png") });
    await page.click("[data-shell-picker] [data-picker-ok]");
    await page.waitForFunction(() => document.querySelector("[data-shell-picker]") === null, { timeout: 5000 });
    await sleep(400); // let the write round-trip

    // Read the saved file back over the api with Notepad's own token (published to the shell page).
    const savedBack = await page.evaluate(async (args) => {
      const tok = window.__vitaShell.sessions["com.puter-apps.notepad"].token;
      const res = await fetch(`/api/read?file=${encodeURIComponent("/" + args.name)}`, { headers: { Authorization: "Bearer " + tok } });
      if (!res.ok) return { ok: false, status: res.status };
      const text = await res.text();
      return { ok: true, text };
    }, { name: SAVE_NAME });
    check("Save: showSaveFilePicker WROTE the file to the api_origin fs", savedBack.ok && savedBack.text === SAVE_BODY, savedBack.ok ? JSON.stringify(savedBack.text.slice(0, 48)) : "HTTP " + savedBack.status);

    // ===== FONT =====
    await np.click("#font-button");
    await page.waitForSelector("[data-font-entry]", { timeout: 8000 });
    await page.click('[data-font-entry="Georgia"]');
    await page.waitForFunction(() => document.querySelector("[data-font-entry]") === null, { timeout: 5000 });
    await sleep(200);
    const fontFamily = await np.$eval("#editor", (el) => el.style.fontFamily);
    check("Font: showFontPicker applied the chosen font (new_font.fontFamily)", /georgia/i.test(fontFamily), fontFamily);

    // ===== COLOR =====
    await np.click("#background-color-button");
    await page.waitForSelector("[data-color-swatch]", { timeout: 8000 });
    await page.click('[data-color-swatch="#4caf72"]');
    await page.waitForFunction(() => document.querySelector("[data-color-swatch]") === null, { timeout: 5000 });
    await sleep(200);
    const bg = await np.$eval("#editor", (el) => el.style.backgroundColor);
    check("Color: showColorPicker applied the chosen color", bg.replace(/\s/g, "") === "rgb(76,175,114)" || bg === "#4caf72", bg);
    await page.screenshot({ path: join(SHOT_DIR, "05-font-color-applied.png") });

    // ===== CAPABILITY GATING =====
    // Register a REAL session that holds `ui` but NOT `fs.read`, then send it a showOpenFilePicker. The
    // broker must deny it CAP_DENIED — the file picker is confined to apps that hold the fs grant, so an
    // app cannot pick a file (let alone one outside its scope) without the capability. Fail-closed.
    const gated = await page.evaluate(async () => {
      const ctrl = window.__vitaShellController;
      const caps = ctrl.capabilities;
      const instance = "gate-ui-only-" + Date.now();
      // Mint a session with ONLY the `ui` grant — no fs.read.
      caps.mintAppSession({ appId: "gate.test.app", appInstanceId: instance, grants: ["ui"] });
      // Complete the broker handshake so the instance is "attached" (READY), then request a file picker.
      return await new Promise((resolve) => {
        const uuid = "gate-probe-" + Date.now();
        function onMsg(e) {
          if (e.data && e.data.original_msg_id === uuid) {
            window.removeEventListener("message", onMsg);
            resolve(e.data);
          }
        }
        window.addEventListener("message", onMsg);
        // READY first (binds this window as the source), then the gated picker request.
        window.postMessage({ appInstanceID: instance, msg: "READY" }, "*");
        setTimeout(() => window.postMessage({ appInstanceID: instance, env: "app", msg: "showOpenFilePicker", options: {}, uuid }, "*"), 30);
        setTimeout(() => { window.removeEventListener("message", onMsg); resolve({ timeout: true }); }, 3000);
      });
    });
    check("Gating: an app WITHOUT fs.read is denied a file picker (CAP_DENIED, fail-closed)", gated && gated.error && gated.error.code === "CAP_DENIED", JSON.stringify(gated));

    check("no uncaught console errors", consoleErrors.length === 0, consoleErrors.slice(0, 3).join(" | "));
  } catch (err) {
    check("driver completed without throwing", false, err.message);
    try { await page.screenshot({ path: join(SHOT_DIR, "99-failure.png") }); } catch {}
  } finally {
    await browser.close();
    await harness.close();
  }

  const passed = results.filter((r) => r.ok).length;
  writeFileSync(join(SHOT_DIR, "verify-pickers-results.json"), JSON.stringify({ consoleErrors, passed, results, total: results.length }, null, 2));
  console.log(`\n=== ${passed}/${results.length} checks passed ===`);
  process.exit(passed === results.length ? 0 : 1);
}

main().catch((e) => { console.error("FATAL", e); process.exit(2); });
