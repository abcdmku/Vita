// Real-browser verification of the POLISHED Vita desktop FRAME (system bar + dock + window chrome +
// wallpaper). Drives headless Chrome (puppeteer-core, local Chrome — no bundled download) against a
// running serve-shell instance at TWO resolutions (1920x1440 and 1366x768). It asserts the frame is
// visible + polished and that the dock's PINNED apps launch + window controls work, and captures
// clean-desktop + two-windows hero screenshots at each size.
//
// Usage:
//   1) node --experimental-strip-types shell/serve-shell.ts --port 7741        (in one shell)
//   2) CHROME_PATH=<chrome> node shell/verify-frame-polish.mjs http://127.0.0.1:7741 ./shots
// Exit 0 = all assertions passed.

import puppeteer from "puppeteer-core";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { inflateSync } from "node:zlib";

const BASE = (process.argv[2] ?? "http://127.0.0.1:7741").replace(/\/$/, "");
const SHOT_DIR = process.argv[3] ?? ".";
const CHROME = process.env.CHROME_PATH ?? "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";

mkdirSync(SHOT_DIR, { recursive: true });

const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok: !!ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function runAt(browser, vw, vh, tag) {
  const page = await browser.newPage();
  await page.setViewport({ width: vw, height: vh });
  const consoleErrors = [];
  const IGNORE = /socket\.io|websocket|realtime|favicon|net::ERR_|Failed to load resource/i;
  page.on("console", (m) => { if (m.type() === "error" && !IGNORE.test(m.text())) consoleErrors.push(m.text()); });
  page.on("pageerror", (e) => { if (!IGNORE.test(e.message)) consoleErrors.push("pageerror: " + e.message); });

  try {
    await page.goto(BASE + "/", { waitUntil: "networkidle2", timeout: 30000 });
    await page.waitForFunction(() => window.__vitaShellReady === true, { timeout: 20000 });
    check(`[${tag}] shell booted`, true);

    // ---- FRAME GEOMETRY: bar pinned top full-width + tall enough to read; dock pinned bottom ----
    const geo = await page.evaluate(() => {
      const r = (sel) => { const el = document.querySelector(sel); if (!el) return null; const b = el.getBoundingClientRect(); return { x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width), h: Math.round(b.height), bottom: Math.round(b.bottom) }; };
      return { vw: window.innerWidth, vh: window.innerHeight, bar: r(".v-menubar"), dock: r("[data-shell-dock]"), wall: r(".v-wallpaper-fx") };
    });
    check(`[${tag}] system bar pinned TOP, full-width, >=44px tall`,
      geo.bar && geo.bar.y === 0 && geo.bar.x === 0 && geo.bar.w === geo.vw && geo.bar.h >= 44,
      JSON.stringify(geo.bar));
    check(`[${tag}] dock pinned to the BOTTOM edge`,
      geo.dock && (geo.vh - geo.dock.bottom) <= 40 && geo.dock.y > geo.vh * 0.6,
      `bottom-gap=${geo.dock ? geo.vh - geo.dock.bottom : "n/a"}px`);
    check(`[${tag}] wallpaper layer present (desktop not flat black)`, geo.wall && geo.wall.w === geo.vw && geo.wall.h === geo.vh);

    // ---- SYSTEM BAR contents: brand logo, Connected pill, quick-settings, clock+date ----
    const bar = await page.evaluate(() => ({
      logo: !!document.querySelector(".v-menubar .v-logo"),
      brand: (document.querySelector(".v-menubar .v-brand")?.textContent || "").replace(/\s+/g, ""),
      net: (document.querySelector(".v-menubar [data-shell-net]")?.textContent || "").trim(),
      netGreen: !!document.querySelector(".v-menubar .v-net"),
      quick: !!document.querySelector(".v-menubar [data-shell-quicksettings] svg"),
      time: (document.querySelector(".v-menubar .clk-time")?.textContent || "").trim(),
      date: (document.querySelector(".v-menubar .clk-date")?.textContent || "").trim(),
    }));
    check(`[${tag}] brand mark + wordmark rendered`, bar.logo && /Vita\.ts/.test(bar.brand), bar.brand);
    check(`[${tag}] "Connected" status indicator present`, bar.netGreen && /Connected/i.test(bar.net), bar.net);
    check(`[${tag}] quick-settings affordance present`, bar.quick);
    check(`[${tag}] live clock shows time + date`, /^\d{2}:\d{2}$/.test(bar.time) && bar.date.length >= 5, `${bar.time} / ${bar.date}`);

    // ---- BAR vs WALLPAPER contrast (luminance from real pixels): bar must be brighter than below ----
    const luma = await measureBarContrast(page, geo.bar.h);
    check(`[${tag}] system bar reads brighter than wallpaper (contrast, not dark-on-dark)`,
      luma.bar - luma.below >= 6, `barLuma=${luma.bar.toFixed(1)} belowLuma=${luma.below.toFixed(1)} Δ=${(luma.bar - luma.below).toFixed(1)}`);

    // ---- DOCK: pinned apps ALWAYS visible (the taskbar fix) + launcher + tooltips ----
    const dock = await page.evaluate(() => {
      const pinned = Array.from(document.querySelectorAll("[data-shell-dock] [data-shell-pinned]"));
      return {
        launcher: !!document.querySelector("[data-shell-launcher-btn]"),
        pinnedCount: pinned.length,
        pinnedIds: pinned.map((e) => e.getAttribute("data-shell-pinned")),
        pinnedHaveSvg: pinned.every((e) => !!e.querySelector("svg") || !!e.querySelector(".v-demoji")),
        tips: pinned.every((e) => !!e.querySelector(".v-dtip")),
        runDots: pinned.every((e) => !!e.querySelector(".v-run-dot")),
      };
    });
    check(`[${tag}] dock launcher (all apps) present`, dock.launcher);
    check(`[${tag}] dock shows PINNED apps always-visible (>=5)`, dock.pinnedCount >= 5, `${dock.pinnedCount} pinned: ${dock.pinnedIds.join(",")}`);
    check(`[${tag}] every pinned tile has a real icon (svg/glyph, not faint text)`, dock.pinnedHaveSvg);
    check(`[${tag}] pinned tiles carry running-indicator + tooltip affordances`, dock.runDots && dock.tips);

    // The 5 the user named: Files(Vita Desk)/Terminal/Editor/Package Manager/Console.
    const wantPinned = ["vita.desk", "vita.app.terminal", "vita.app.editor", "vita.app.package-manager", "vita.app.deploy-console"];
    check(`[${tag}] the user's requested pinned set is present`,
      wantPinned.every((id) => dock.pinnedIds.includes(id)),
      wantPinned.filter((id) => !dock.pinnedIds.includes(id)).join(",") || "all present");

    // Clean-desktop screenshot.
    await page.screenshot({ path: join(SHOT_DIR, `${tag}-01-clean-desktop.png`) });

    // ---- CLICK a dock pinned icon → opens the app (the "taskbar opens apps" behavior) ----
    await page.click('[data-shell-dock] [data-shell-pinned="vita.app.terminal"]');
    await page.waitForSelector('[data-vita-window="vita.app.terminal"]', { timeout: 15000 });
    check(`[${tag}] clicking a dock pinned icon OPENS the app`, true, "vita.app.terminal");

    // The opened app's pinned tile should now show running + focused state.
    const runState = await page.evaluate(() => {
      const t = document.querySelector('[data-shell-dock] [data-shell-pinned="vita.app.terminal"]');
      return { running: t?.classList.contains("running"), focused: t?.classList.contains("focused"), dockTile: !!document.querySelector('[data-shell-dock-tile="vita.app.terminal"]') };
    });
    check(`[${tag}] running app's dock tile shows running+focused indicator`, runState.running && runState.focused && runState.dockTile);

    // ---- Open a SECOND app via the launcher overlay (polished all-apps grid) ----
    await page.click("[data-shell-launcher-btn]");
    await page.waitForFunction(() => { const el = document.querySelector("[data-shell-launcher]"); return el && getComputedStyle(el).display !== "none"; }, { timeout: 5000 });
    await page.click('[data-shell-app="vita.app.editor"]');
    await page.waitForSelector('[data-vita-window="vita.app.editor"]', { timeout: 15000 });
    const winCount = await page.$$eval('[data-vita-window]', (els) => els.length);
    check(`[${tag}] launcher opens a second app (2 windows)`, winCount >= 2, `${winCount} windows`);

    // ---- WINDOW CHROME: traffic lights present; CLOSE works ----
    const chrome = await page.evaluate(() => {
      const w = document.querySelector('[data-vita-window="vita.app.editor"]');
      return {
        close: !!w?.querySelector("[data-vita-window-close]"),
        min: !!w?.querySelector("[data-vita-window-min]"),
        zoom: !!w?.querySelector("[data-vita-window-zoom]"),
        title: (w?.querySelector("[data-vita-window-title]")?.textContent || "").trim(),
        resize: !!w?.querySelector("[data-vita-window-resize]"),
      };
    });
    check(`[${tag}] window has 3 traffic-light controls + title + resize grip`,
      chrome.close && chrome.min && chrome.zoom && chrome.resize && chrome.title.length > 0, JSON.stringify(chrome));

    // Two-window hero screenshot (before closing).
    await page.screenshot({ path: join(SHOT_DIR, `${tag}-02-two-windows.png`) });

    // Close the editor via its red dot and assert it's gone.
    await page.click('[data-vita-window="vita.app.editor"] [data-vita-window-close]');
    await sleep(220);
    const afterClose = await page.$$eval('[data-vita-window]', (els) => els.length);
    check(`[${tag}] window CLOSE (red traffic light) removes the window`, afterClose === winCount - 1, `${winCount} -> ${afterClose}`);

    // Maximize the terminal window via the green dot, then restore.
    const beforeMax = await page.$eval('[data-vita-window="vita.app.terminal"]', (e) => e.getBoundingClientRect().width);
    await page.click('[data-vita-window="vita.app.terminal"] [data-vita-window-zoom]');
    await sleep(180);
    const maxed = await page.$eval('[data-vita-window="vita.app.terminal"]', (e) => e.getBoundingClientRect().width);
    check(`[${tag}] window MAXIMIZE (green traffic light) enlarges the window`, maxed > beforeMax + 80, `${Math.round(beforeMax)} -> ${Math.round(maxed)}px`);

    check(`[${tag}] no uncaught console errors`, consoleErrors.length === 0, consoleErrors.slice(0, 3).join(" | "));
  } catch (err) {
    check(`[${tag}] driver completed without throwing`, false, err.message);
    try { await page.screenshot({ path: join(SHOT_DIR, `${tag}-99-failure.png`) }); } catch {}
  } finally {
    await page.close();
  }
}

// Screenshot a left-edge top band (away from the brand text), decode the PNG in Node, and compare the
// mean luminance of the bar row vs the wallpaper row ~40px below it. Pure pixel evidence that the bar
// reads brighter than the wallpaper (contrast/elevation, not dark-on-dark).
async function measureBarContrast(page, barH) {
  // Sample a narrow column near the right-of-brand area that is plain bar background (x≈360..420).
  const buf = await page.screenshot({ clip: { x: 360, y: 0, width: 60, height: barH + 60 }, type: "png" });
  const img = decodePng(buf);
  const barRow = Math.max(2, Math.floor(barH / 2));
  const belowRow = Math.min(img.height - 1, barH + 30);
  return { bar: rowLuma(img, barRow), below: rowLuma(img, belowRow) };
}

// Mean perceptual luminance (0..255) of one pixel row.
function rowLuma(img, y) {
  let sum = 0;
  for (let x = 0; x < img.width; x += 1) {
    const i = (y * img.width + x) * 4;
    sum += 0.2126 * img.data[i] + 0.7152 * img.data[i + 1] + 0.0722 * img.data[i + 2];
  }
  return sum / img.width;
}

// Minimal PNG decoder (8-bit, RGB/RGBA, no interlace) → { width, height, data: RGBA bytes }. Chrome's
// page.screenshot PNGs are non-interlaced truecolor, which this handles. Filters per PNG spec §6.
function decodePng(buf) {
  let pos = 8; // skip signature
  let width = 0, height = 0, colorType = 0;
  const idat = [];
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString("ascii", pos + 4, pos + 8);
    const start = pos + 8;
    if (type === "IHDR") {
      width = buf.readUInt32BE(start);
      height = buf.readUInt32BE(start + 4);
      colorType = buf[start + 9];
    } else if (type === "IDAT") {
      idat.push(buf.subarray(start, start + len));
    } else if (type === "IEND") {
      break;
    }
    pos = start + len + 4; // +CRC
  }
  const channels = colorType === 6 ? 4 : colorType === 2 ? 3 : 4;
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const out = Buffer.alloc(width * height * 4);
  const prev = Buffer.alloc(stride);
  const cur = Buffer.alloc(stride);
  let rp = 0;
  for (let y = 0; y < height; y += 1) {
    const filter = raw[rp]; rp += 1;
    raw.copy(cur, 0, rp, rp + stride); rp += stride;
    for (let x = 0; x < stride; x += 1) {
      const a = x >= channels ? cur[x - channels] : 0;
      const b = prev[x];
      const c = x >= channels ? prev[x - channels] : 0;
      let v = cur[x];
      if (filter === 1) v = (v + a) & 255;
      else if (filter === 2) v = (v + b) & 255;
      else if (filter === 3) v = (v + ((a + b) >> 1)) & 255;
      else if (filter === 4) { const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c); v = (v + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)) & 255; }
      cur[x] = v;
    }
    for (let x = 0; x < width; x += 1) {
      const si = x * channels, di = (y * width + x) * 4;
      out[di] = cur[si]; out[di + 1] = cur[si + 1]; out[di + 2] = cur[si + 2];
      out[di + 3] = channels === 4 ? cur[si + 3] : 255;
    }
    cur.copy(prev);
  }
  return { width, height, data: out };
}

async function main() {
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: "new",
    args: ["--no-sandbox", "--disable-dev-shm-usage", "--force-color-profile=srgb"],
  });

  try {
    await runAt(browser, 1920, 1440, "1920x1440");
    await runAt(browser, 1366, 768, "1366x768");
  } finally {
    await browser.close();
  }

  const passed = results.filter((r) => r.ok).length;
  writeFileSync(join(SHOT_DIR, "verify-frame-polish-results.json"), JSON.stringify({ passed, total: results.length, results }, null, 2));
  console.log(`\n=== ${passed}/${results.length} checks passed ===`);
  process.exit(passed === results.length ? 0 : 1);
}

main().catch((e) => { console.error("FATAL", e); process.exit(2); });
