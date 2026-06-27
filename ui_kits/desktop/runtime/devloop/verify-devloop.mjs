// Vita dev-loop — REAL-BROWSER verification (puppeteer-core + local Chrome). The authoritative proof.
//
// Drives headless Chrome against a running serve-devloop instance and exercises ALL THREE dev-loop
// deliverables end to end, each persisting to the REAL file-backed store via the genuine puter.js SDK:
//
//   1. EDITOR  — open the editor, type code, Save (puter.fs.write), then RELOAD and re-open the file:
//                the saved content is still there (real persistence, not in-memory).
//   2. SCAFFOLD — open New App, type a name, Create (writes the app's files via puter.fs), then OPEN the
//                generated app via /run: it boots and renders (proves the scaffolded app is runnable).
//   3. PACKAGER — POST /package?name=@vita/greeter (catalog gate → offline locked install → served app
//                written into the store), then OPEN it via /run: the packaged npm package's UI mounts
//                (proves the npm->app packager maps onto the new platform + produces a runnable artifact).
//
// Prereqs (kept OUT of repo deps; install ad-hoc): puppeteer-core + a local Chrome. Point CHROME_PATH +
// NODE_PATH (to the dir where puppeteer-core is installed) if not on the defaults.
//
// Usage:
//   1) node --experimental-strip-types ui_kits/desktop/runtime/devloop/serve-devloop.ts --port 7712
//   2) CHROME_PATH=<chrome> node ui_kits/desktop/runtime/devloop/verify-devloop.mjs http://127.0.0.1:7712 ./shots
// Exit 0 = all assertions passed.

import puppeteer from "puppeteer-core";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const BASE = (process.argv[2] ?? "http://127.0.0.1:7712").replace(/\/$/, "");
const SHOT_DIR = process.argv[3] ?? ".";
const CHROME = process.env.CHROME_PATH ?? "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";

mkdirSync(SHOT_DIR, { recursive: true });

const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
}

const STAMP = Date.now();
const EDIT_PATH = "/home/dev/hello-" + STAMP + ".js";
const EDIT_TEXT = "// edited by verify-devloop at " + new Date().toISOString() + "\nexport const answer = 42;\n";
const APP_NAME = "Verify App " + STAMP;

const IGNORE = /socket\.io|websocket|realtime|favicon/i;

async function newPage(browser) {
  const page = await browser.newPage();
  const errors = [];
  page.on("console", (m) => { if (m.type() === "error" && !IGNORE.test(m.text())) errors.push(m.text()); });
  page.on("pageerror", (e) => { if (!IGNORE.test(e.message)) errors.push("pageerror: " + e.message); });
  page.__errors = errors;
  return page;
}

async function main() {
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: "new",
    args: ["--no-sandbox", "--disable-dev-shm-usage", "--window-size=1320,900"],
    defaultViewport: { width: 1320, height: 860 },
  });

  try {
    await verifyEditor(browser);
    await verifyScaffold(browser);
    await verifyPackager(browser);
  } catch (err) {
    check("driver completed without throwing", false, err.message);
  } finally {
    await browser.close();
  }

  const passed = results.filter((r) => r.ok).length;
  writeFileSync(join(SHOT_DIR, "verify-devloop-results.json"), JSON.stringify({ passed, total: results.length, results }, null, 2));
  console.log(`\n=== ${passed}/${results.length} checks passed ===`);
  process.exit(passed === results.length ? 0 : 1);
}

// ---- 1. EDITOR: edit + save + persist across reload ----
async function verifyEditor(browser) {
  const page = await newPage(browser);
  const url = BASE + "/devloop/editor/index.html";

  await page.goto(url, { waitUntil: "networkidle2", timeout: 30000 });
  await page.waitForFunction(() => window.__vitaCodeReady === true, { timeout: 20000 });
  check("editor booted (window.__vitaCodeReady)", true);

  // Set the path + content via the exposed handle (deterministic), then Save through the UI button.
  await page.evaluate((p) => { window.__vitaCode.setPath(p); window.__vitaCode.setValue(""); }, EDIT_PATH);
  await page.evaluate((t) => window.__vitaCode.setValue(t), EDIT_TEXT);
  await page.click("#btn-save");
  await page.waitForFunction(() => /saved/i.test(document.querySelector("#status").textContent), { timeout: 10000 });
  check("editor saved a file (puter.fs.write)", true, EDIT_PATH);
  await page.screenshot({ path: join(SHOT_DIR, "editor-01-saved.png") });

  // RELOAD — new page context, same store. Re-open the path: the content must persist.
  await page.reload({ waitUntil: "networkidle2", timeout: 30000 });
  await page.waitForFunction(() => window.__vitaCodeReady === true, { timeout: 20000 });
  await page.evaluate((p) => { window.__vitaCode.setPath(p); }, EDIT_PATH);
  await page.click("#btn-open");
  await page.waitForFunction(() => /opened/i.test(document.querySelector("#status").textContent), { timeout: 10000 });
  const after = await page.evaluate(() => window.__vitaCode.getValue());
  check("PERSIST: saved file survives reload (re-read content matches)", after === EDIT_TEXT, `len=${after.length}`);
  await page.screenshot({ path: join(SHOT_DIR, "editor-02-reopened.png") });

  check("editor: no uncaught console errors", page.__errors.length === 0, page.__errors.slice(0, 2).join(" | "));
  await page.close();
}

// ---- 2. SCAFFOLD: create a new app + run it ----
async function verifyScaffold(browser) {
  const page = await newPage(browser);
  const url = BASE + "/devloop/newapp/index.html";

  await page.goto(url, { waitUntil: "networkidle2", timeout: 30000 });
  await page.waitForFunction(() => window.__newAppReady === true, { timeout: 20000 });
  check("new-app page booted (window.__newAppReady)", true);

  await page.$eval("#name", (el) => (el.value = ""));
  await page.type("#name", APP_NAME);
  await page.click("#create");
  await page.waitForFunction(() => window.__newAppLast !== undefined, { timeout: 15000 });
  const last = await page.evaluate(() => window.__newAppLast);
  check("scaffold wrote the app files (puter.fs.write)", Array.isArray(last.files) && last.files.length >= 5, `${last.files.length} files`);
  check("scaffold derived the app id from the name", last.appId.startsWith("vita.app."), last.appId);
  await page.screenshot({ path: join(SHOT_DIR, "scaffold-01-created.png") });

  // RUN the generated app via /run — it must boot (window.__appReady) + render its title.
  const runUrl = BASE + "/run?path=" + encodeURIComponent(last.entryPath);
  const runPage = await newPage(browser);
  await runPage.goto(runUrl, { waitUntil: "networkidle2", timeout: 30000 });
  await runPage.waitForFunction(() => window.__appReady === true, { timeout: 20000 });
  const heading = await runPage.$eval("h1", (el) => el.textContent.trim());
  check("scaffolded app RUNS (boots + renders title)", heading.includes(APP_NAME), "h1=" + heading);

  // It persists a KV counter: click bump, reload, confirm it stuck.
  await runPage.click("#bump");
  await runPage.waitForFunction(() => Number(document.querySelector("#count").textContent) >= 1, { timeout: 8000 });
  await runPage.reload({ waitUntil: "networkidle2", timeout: 30000 });
  await runPage.waitForFunction(() => window.__appReady === true, { timeout: 20000 });
  const count = await runPage.$eval("#count", (el) => Number(el.textContent));
  check("PERSIST: scaffolded app's KV counter survives reload", count >= 1, "count=" + count);
  await runPage.screenshot({ path: join(SHOT_DIR, "scaffold-02-running.png") });

  check("scaffold: no uncaught console errors", runPage.__errors.length === 0, runPage.__errors.slice(0, 2).join(" | "));
  await runPage.close();
  await page.close();
}

// ---- 3. PACKAGER: package an allowed npm package + run it ----
async function verifyPackager(browser) {
  const page = await newPage(browser);
  // Drive the packaging from the browser context so it's a genuine fetch against the running node.
  await page.goto(BASE + "/", { waitUntil: "domcontentloaded", timeout: 30000 });
  const pkg = await page.evaluate(async (base) => {
    const res = await fetch(base + "/package?name=@vita/greeter", { method: "POST" });
    return await res.json();
  }, BASE);
  check("packager: add @vita/greeter produced a runnable app", pkg.ok === true && pkg.kind === "desktop", JSON.stringify(pkg.error || pkg.appId));

  if (!pkg.ok) { await page.close(); return; }

  const runUrl = BASE + "/run?path=" + encodeURIComponent(pkg.entryPath);
  const runPage = await newPage(browser);
  await runPage.goto(runUrl, { waitUntil: "networkidle2", timeout: 30000 });
  await runPage.waitForFunction(() => window.__appReady === true, { timeout: 20000 });
  // The packaged @vita/greeter module mounts into #root and renders its greeting.
  const greeting = await runPage.evaluate(() => {
    const el = document.querySelector("[data-greeter-hello]");
    return el ? el.textContent.trim() : "";
  });
  check("packaged npm app RUNS (its mount() module rendered)", /Hello from @vita\/greeter/.test(greeting), greeting);
  await runPage.screenshot({ path: join(SHOT_DIR, "packager-01-running.png") });

  check("packager: no uncaught console errors", runPage.__errors.length === 0, runPage.__errors.slice(0, 2).join(" | "));
  await runPage.close();
  await page.close();
}

main().catch((e) => { console.error("FATAL", e); process.exit(2); });
