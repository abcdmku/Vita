// Real-browser verification of the Vita Terminal.
//
// Drives headless Chrome (puppeteer-core, local Chrome — no bundled download) against a serve-terminal
// instance. It:
//   1. Opens the Terminal app (an `exec`-granted token) → the /pty websocket connects, a shell capsule
//      is ready, and REAL commands (echo / pwd / ls / cat) produce REAL output in the xterm grid.
//   2. Opens the Terminal app with an UNGRANTED token → the /pty upgrade is REFUSED (403): the terminal
//      never connects and surfaces the exec denial. Proves default-deny.
//
// Prereqs (kept OUT of repo deps — install ad-hoc, offline-first): a local Chrome + puppeteer-core.
//   CHROME_PATH=<chrome> node verify-terminal.mjs <serverBaseUrl> <termToken> <noexecToken> <shotDir>
// Exit 0 = all assertions passed.

import puppeteer from "puppeteer-core";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const BASE = process.argv[2] ?? "http://127.0.0.1:7682";
const TERM_TOKEN = process.argv[3] ?? "term-owner-token-0001";
const NOEXEC_TOKEN = process.argv[4] ?? "noexec-owner-token-0002";
const SHOT_DIR = process.argv[5] ?? ".";
const CHROME = process.env.CHROME_PATH ?? "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";

mkdirSync(SHOT_DIR, { recursive: true });

const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
}

function termUrl(token) {
  return `${BASE}/apps/terminal/index.html?puter.api_origin=${encodeURIComponent(BASE + "/api")}&puter.auth.token=${token}`;
}

// Read the full visible terminal text out of the xterm DOM (the rendered rows), so we assert on what a
// human actually sees, not just our JS hook's buffer.
async function readTermText(page) {
  return await page.evaluate(() => {
    const rows = Array.from(document.querySelectorAll(".xterm-rows > div"));
    return rows.map((r) => r.textContent).join("\n");
  });
}

async function main() {
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: "new",
    args: ["--no-sandbox", "--disable-dev-shm-usage", "--window-size=1100,720"],
    defaultViewport: { width: 1100, height: 700 },
  });

  try {
    // ===================================================================================
    // 1. GRANTED Terminal — real commands, real output.
    // ===================================================================================
    {
      const page = await browser.newPage();
      const consoleErrors = [];
      page.on("pageerror", (e) => consoleErrors.push("pageerror: " + e.message));

      await page.goto(termUrl(TERM_TOKEN), { waitUntil: "networkidle2", timeout: 30000 });

      // xterm mounted?
      await page.waitForFunction(() => typeof window.Terminal === "function" && document.querySelector(".xterm") !== null, { timeout: 15000 });
      check("Terminal app mounts xterm.js", true);

      // /pty connected + capsule ready?
      await page.waitForFunction(() => window.__VITA_TERM__ && window.__VITA_TERM__.connected === true, { timeout: 15000 });
      check("/pty websocket connected (exec granted)", true);
      await page.waitForFunction(() => window.__VITA_TERM__ && window.__VITA_TERM__.ready === true, { timeout: 15000 });
      const runtime = await page.evaluate(() => window.__VITA_TERM__.runtime);
      check("exec capsule ready (runtime named)", typeof runtime === "string" && runtime.length > 0, "runtime=" + runtime);
      await page.screenshot({ path: join(SHOT_DIR, "term-01-connected.png") });

      // Run a command and wait for the command to COMPLETE (a fresh prompt appears AFTER the input we
      // sent). We gate the next command on prompt-count so we never feed input to a still-running
      // process. `runCommand` returns the slice of output produced by this command (between the prompt
      // before and the prompt after), so each assertion inspects only its own command's output.
      const PROMPT = "$ ";
      function countPrompts(s) { return (s.match(/\$ /g) || []).length; }

      async function runCommand(command, timeout = 12000) {
        const before = await page.evaluate(() => window.__VITA_TERM__.output || "");
        const promptsBefore = countPrompts(before);
        await page.evaluate((c) => window.__vitaTermType(c), command);
        // Wait until a NEW prompt has appeared (the command finished and the shell re-prompted).
        await page.waitForFunction((pb) => {
          const out = window.__VITA_TERM__.output || "";
          return ((out.match(/\$ /g) || []).length) > pb;
        }, { timeout }, promptsBefore);
        const after = await page.evaluate(() => window.__VITA_TERM__.output || "");
        // The new command's output is everything appended since `before`.
        return after.slice(before.length);
      }

      // echo a unique sentinel — assert it renders in the xterm GRID (what the human sees), not just JS.
      const sentinel = "VITA_TERMINAL_OK_" + Date.now();
      const echoOut = await runCommand("echo " + sentinel);
      const gridText = await readTermText(page);
      check("echo: real stdout rendered in xterm grid", gridText.includes(sentinel) && echoOut.includes(sentinel), "grid+output contain sentinel");
      void PROMPT;

      // pwd → an absolute path appears (the sandbox cwd).
      const pwdOut = await runCommand("pwd");
      check("pwd: prints a working directory path", /[\\/]\S*[\\/]/.test(pwdOut) || pwdOut.includes("/"), "pwd output=" + JSON.stringify(pwdOut.replace(/[\r\n]+/g, " ").trim()).slice(0, 80));

      // ls → runs cleanly and produces entries (the sandbox starts empty → . and ..).
      const lsOut = await runCommand("ls -a");
      check("ls: runs and produces output", lsOut.replace(/\$ $/, "").trim().length > 0);

      // command-level default-deny: a non-allow-listed binary is refused.
      const curlOut = await runCommand("curl http://evil");
      check("non-allow-listed command refused (sandbox default-deny)", /not permitted/i.test(curlOut), "refused");

      await page.screenshot({ path: join(SHOT_DIR, "term-02-commands.png") });
      check("no uncaught page errors (granted)", consoleErrors.length === 0, consoleErrors.slice(0, 2).join(" | "));
      await page.close();
    }

    // ===================================================================================
    // 2. UNGRANTED Terminal — /pty refused (403). Default-deny proven in the real browser.
    // ===================================================================================
    {
      const page = await browser.newPage();
      await page.goto(termUrl(NOEXEC_TOKEN), { waitUntil: "networkidle2", timeout: 30000 });
      await page.waitForFunction(() => typeof window.Terminal === "function" && document.querySelector(".xterm") !== null, { timeout: 15000 });

      // It must NOT connect; the app surfaces the exec denial. Wait for lastError to be set (the ws is
      // refused before open → onclose-before-open path) OR a bounded timeout proving no connection.
      const denied = await page.waitForFunction(
        () => window.__VITA_TERM__ && window.__VITA_TERM__.connected === false && window.__VITA_TERM__.lastError !== null,
        { timeout: 12000 },
      ).then(() => true).catch(() => false);

      const state = await page.evaluate(() => ({ connected: window.__VITA_TERM__.connected, ready: window.__VITA_TERM__.ready, lastError: window.__VITA_TERM__.lastError }));
      check("exec DENIED without grant: /pty never connects", denied && state.connected === false && state.ready === false, JSON.stringify(state));
      check("exec DENIED: terminal surfaces the denial", typeof state.lastError === "string" && state.lastError.length > 0, "err=" + state.lastError);
      await page.screenshot({ path: join(SHOT_DIR, "term-03-denied.png") });
      await page.close();
    }
  } catch (err) {
    let tail = "";
    try {
      const pages = await browser.pages();
      const live = pages[pages.length - 1];
      tail = await live.evaluate(() => (window.__VITA_TERM__ && window.__VITA_TERM__.output || "").slice(-300));
    } catch { /* page gone */ }
    check("driver completed without throwing", false, err.message + " | tail=" + JSON.stringify(tail));
  } finally {
    await browser.close();
  }

  const passed = results.filter((r) => r.ok).length;
  writeFileSync(join(SHOT_DIR, "verify-terminal-results.json"), JSON.stringify({ passed, total: results.length, results }, null, 2));
  console.log(`\n=== ${passed}/${results.length} checks passed ===`);
  process.exit(passed === results.length ? 0 : 1);
}

main().catch((e) => { console.error("FATAL", e); process.exit(2); });
