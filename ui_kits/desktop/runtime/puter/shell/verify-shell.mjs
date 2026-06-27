// Real-browser verification of the Vita MULTI-WINDOW SHELL.
//
// Drives headless Chrome (puppeteer-core, local Chrome — no bundled download) against a running
// serve-shell instance. It exercises the genuine multi-window desktop:
//   1. loads the shell at / and waits for the WM + dock to mount (window.__vitaShellReady)
//   2. confirms Vita Desk auto-started as a WINDOW (not full-screen)
//   3. opens the app launcher (dock ⊞) and launches a REAL third-party Puter app (serverless-todo)
//   4. waits for that app's sandboxed iframe to boot puter.js and load from the LOCAL api_origin
//   5. drives the REAL app: adds a todo → the app calls puter.kv.set → persists to Vita's store
//   6. launches a SECOND app (Notepad) so 2+ third-party windows are open at once
//   7. tests WINDOWING: focus by dock tile, DRAG a window by its title bar, CLOSE a window
//   8. asserts the real app's KV write actually landed in the api_origin store (via /events + /api)
//   9. captures a hero screenshot of the multi-window desktop with multiple apps open
//
// Usage:
//   1) node --experimental-strip-types shell/serve-shell.ts --port 7700        (in one shell)
//   2) CHROME_PATH=<chrome> node shell/verify-shell.mjs http://127.0.0.1:7700 ./shots
// Exit 0 = all assertions passed.

import puppeteer from "puppeteer-core";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const BASE = (process.argv[2] ?? "http://127.0.0.1:7700").replace(/\/$/, "");
const SHOT_DIR = process.argv[3] ?? ".";
const CHROME = process.env.CHROME_PATH ?? "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";

mkdirSync(SHOT_DIR, { recursive: true });

const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok: !!ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const TODO_TEXT = "Buy milk " + Date.now();

async function main() {
  // Verify at the ON-DEVICE resolution (1920x1440). The full-viewport layout bug only surfaces at
  // large sizes — a smaller viewport masked it because the shell happened to nearly fill it.
  const VW = Number(process.env.SHELL_VW ?? "1920");
  const VH = Number(process.env.SHELL_VH ?? "1440");
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: "new",
    args: ["--no-sandbox", "--disable-dev-shm-usage", `--window-size=${VW},${VH}`],
    defaultViewport: { width: VW, height: VH },
  });
  const page = await browser.newPage();
  const consoleErrors = [];
  const IGNORE = /socket\.io|websocket|realtime|favicon|net::ERR_|Failed to load resource/i;
  page.on("console", (m) => { if (m.type() === "error" && !IGNORE.test(m.text())) consoleErrors.push(m.text()); });
  page.on("pageerror", (e) => { if (!IGNORE.test(e.message)) consoleErrors.push("pageerror: " + e.message); });

  try {
    // ---- 1. Load shell + WM/dock mount ----
    await page.goto(BASE + "/", { waitUntil: "networkidle2", timeout: 30000 });
    await page.waitForFunction(() => window.__vitaShellReady === true, { timeout: 20000 });
    check("shell booted (window.__vitaShellReady)", true);

    const hasDock = await page.$("[data-shell-dock]") !== null;
    check("dock/taskbar mounted", hasDock);
    const hasLauncherBtn = await page.$("[data-shell-launcher-btn]") !== null;
    check("dock launcher button present", hasLauncherBtn);

    // ---- 2. FULL-VIEWPORT LAYOUT: shell fills the screen; system bar pinned TOP, dock pinned BOTTOM ----
    const layout = await page.evaluate(() => {
      const r = (sel) => { const el = document.querySelector(sel); if (!el) return null; const b = el.getBoundingClientRect(); return { x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width), h: Math.round(b.height), bottom: Math.round(b.bottom) }; };
      return { vw: window.innerWidth, vh: window.innerHeight, screen: r(".v-screen"), bar: r(".v-menubar"), dock: r("[data-shell-dock]") };
    });
    check("shell FILLS the viewport (no top-left clustering)",
      layout.screen && layout.screen.x === 0 && layout.screen.y === 0 && layout.screen.w === layout.vw && layout.screen.h === layout.vh,
      JSON.stringify(layout.screen));
    check("system bar pinned to the TOP edge (full width)",
      layout.bar && layout.bar.y === 0 && layout.bar.x === 0 && layout.bar.w === layout.vw && layout.bar.h >= 40,
      JSON.stringify(layout.bar));
    check("dock pinned to the BOTTOM edge (not floating mid-page)",
      layout.dock && (layout.vh - layout.dock.bottom) <= 40 && layout.dock.y > layout.vh * 0.7,
      `bottom-gap=${layout.dock ? layout.vh - layout.dock.bottom : "n/a"}px`);

    // ---- 2b. CLEAN desktop on boot — NO app auto-opened (the user launches from the dock) ----
    const bootWindows = await page.$$('[data-vita-window]');
    check("CLEAN desktop on boot — no app pre-opened", bootWindows.length === 0, `${bootWindows.length} window(s)`);
    await page.screenshot({ path: join(SHOT_DIR, "01-shell-booted.png") });

    // ---- 2c. Launch Vita Desk FROM THE DOCK (it no longer auto-starts) ----
    await page.click("[data-shell-launcher-btn]");
    await page.waitForFunction(
      () => { const el = document.querySelector("[data-shell-launcher]"); return el && getComputedStyle(el).display !== "none"; },
      { timeout: 5000 },
    );
    await page.click('[data-shell-app="vita.desk"]');
    await page.waitForSelector('[data-vita-window="vita.desk"]', { timeout: 15000 });
    const deskWindows = await page.$$('[data-vita-window]');
    check("Vita Desk opens as a managed window from the dock", deskWindows.length >= 1, `${deskWindows.length} window(s)`);

    // ---- 3. Open the launcher + launch a REAL third-party app (serverless-todo) ----
    await page.click("[data-shell-launcher-btn]");
    await page.waitForFunction(
      () => { const el = document.querySelector("[data-shell-launcher]"); return el && getComputedStyle(el).display !== "none"; },
      { timeout: 5000 },
    );
    check("app launcher overlay opened", true);
    await page.screenshot({ path: join(SHOT_DIR, "02-launcher.png") });

    await page.click('[data-shell-app="com.puter-apps.serverless-todo"]');
    await page.waitForSelector('[data-vita-window="com.puter-apps.serverless-todo"]', { timeout: 15000 });
    check("real third-party app (Serverless Todo) opened in a window", true);

    // ---- 4. Wait for the app's iframe puter.js to boot against the LOCAL api_origin ----
    const todoFrameHandle = await page.waitForSelector('iframe[data-puter-webapp="com.puter-apps.serverless-todo"]', { timeout: 15000 });
    const todoFrame = await todoFrameHandle.contentFrame();
    // The app constructs window.app (TodoApp) once DOM is ready + after the first KV load.
    await todoFrame.waitForFunction(() => typeof window.app === "object" && window.app !== null, { timeout: 20000 });
    check("Serverless Todo booted puter.js inside its sandbox", true);

    // ---- 5. Drive the REAL app: add a todo → puter.kv.set → persists to Vita's store ----
    await todoFrame.waitForSelector("#todoInput", { timeout: 8000 });
    await todoFrame.type("#todoInput", TODO_TEXT);
    await todoFrame.click("#addBtn");
    // The app re-renders the list after the KV round-trip; wait for the new item text to appear.
    await todoFrame.waitForFunction(
      (t) => Array.from(document.querySelectorAll(".todo-text")).some((e) => e.textContent === t),
      { timeout: 10000 }, TODO_TEXT,
    );
    check("real app fs/kv: added a todo (puter.kv.set round-tripped)", true, TODO_TEXT);
    await page.screenshot({ path: join(SHOT_DIR, "03-todo-added.png") });

    // ---- 6. Launch a SECOND real app (Notepad) so 2+ third-party windows are open ----
    await page.click("[data-shell-launcher-btn]");
    await page.waitForFunction(
      () => { const el = document.querySelector("[data-shell-launcher]"); return el && getComputedStyle(el).display !== "none"; },
      { timeout: 5000 },
    );
    await page.click('[data-shell-app="com.puter-apps.notepad"]');
    await page.waitForSelector('[data-vita-window="com.puter-apps.notepad"]', { timeout: 15000 });
    const openWindows = await page.$$('[data-vita-window]');
    check("multiple app windows open at once (2+)", openWindows.length >= 3, `${openWindows.length} windows (Desk + Todo + Notepad)`);

    // ---- 7. Windowing: dock tiles, DRAG, focus, CLOSE ----
    const dockTiles = await page.$$('[data-shell-dock-tile]');
    check("dock shows one tile per open window", dockTiles.length >= 3, `${dockTiles.length} dock tiles`);

    // Drag the Notepad window by its title bar and assert it moved.
    const beforeBox = await (await page.$('[data-vita-window="com.puter-apps.notepad"]')).boundingBox();
    const titlebar = await page.$('[data-vita-window="com.puter-apps.notepad"] [data-vita-window-titlebar]');
    const tb = await titlebar.boundingBox();
    await page.mouse.move(tb.x + tb.width / 2, tb.y + tb.height / 2);
    await page.mouse.down();
    await page.mouse.move(tb.x + tb.width / 2 - 160, tb.y + tb.height / 2 + 70, { steps: 12 });
    await page.mouse.up();
    await sleep(150);
    const afterBox = await (await page.$('[data-vita-window="com.puter-apps.notepad"]')).boundingBox();
    const moved = Math.abs(afterBox.x - beforeBox.x) > 40 || Math.abs(afterBox.y - beforeBox.y) > 30;
    check("window DRAG by title bar moves the window", moved, `Δx=${Math.round(afterBox.x - beforeBox.x)} Δy=${Math.round(afterBox.y - beforeBox.y)}`);

    // Focus the Todo window via its dock tile (z-order raise).
    await page.click('[data-shell-dock-tile="com.puter-apps.serverless-todo"]');
    await sleep(120);
    const focusedId = await page.evaluate(() => document.getElementById("vita-app-window")?.getAttribute("data-vita-window"));
    check("dock tile click focuses the window (z-order)", focusedId === "com.puter-apps.serverless-todo", "focused=" + focusedId);

    // Hero screenshot: the multi-window desktop with 2+ apps open.
    await page.screenshot({ path: join(SHOT_DIR, "04-multiwindow-desktop.png") });

    // Close the Notepad window via its red traffic-light dot.
    await page.click('[data-vita-window="com.puter-apps.notepad"] [data-vita-window-close]');
    await sleep(200);
    const afterClose = await page.$$('[data-vita-window]');
    check("window CLOSE (red dot) removes the window", afterClose.length === openWindows.length - 1, `${openWindows.length} -> ${afterClose.length}`);

    // ---- 8. Assert the real app's KV write actually landed in the api_origin store ----
    // Read it back via the shell's own session token (published to the page).
    const persisted = await page.evaluate(async (text) => {
      const shell = window.__vitaShell;
      const tok = shell.sessions["com.puter-apps.serverless-todo"].token;
      const res = await fetch("/api/drivers/call", {
        method: "POST",
        headers: { "Content-Type": "text/plain;actually=json" },
        body: JSON.stringify({ interface: "puter-kvstore", method: "get", args: { key: "todos" }, auth_token: tok }),
      });
      const j = await res.json();
      return typeof j.result === "string" && j.result.includes(text);
    }, TODO_TEXT);
    check("real app KV write landed in api_origin store (read-back)", persisted);

    // Confirm the realtime events feed recorded the kv.set.
    const sawEvent = await page.evaluate(async () => {
      const shell = window.__vitaShell;
      const tok = shell.sessions["vita.desk"].token;
      const res = await fetch("/api/events?since=0", { headers: { Authorization: "Bearer " + tok } });
      const j = await res.json();
      return Array.isArray(j.events) && j.events.some((e) => e.kind === "kv.set");
    });
    check("realtime events feed recorded the kv.set", sawEvent);

    check("no uncaught console errors", consoleErrors.length === 0, consoleErrors.slice(0, 3).join(" | "));
  } catch (err) {
    check("driver completed without throwing", false, err.message);
    try { await page.screenshot({ path: join(SHOT_DIR, "99-failure.png") }); } catch {}
  } finally {
    await browser.close();
  }

  const passed = results.filter((r) => r.ok).length;
  writeFileSync(join(SHOT_DIR, "verify-shell-results.json"), JSON.stringify({ passed, total: results.length, results, consoleErrors }, null, 2));
  console.log(`\n=== ${passed}/${results.length} checks passed ===`);
  process.exit(passed === results.length ? 0 : 1);
}

main().catch((e) => { console.error("FATAL", e); process.exit(2); });
