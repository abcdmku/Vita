#!/usr/bin/env node
// Headless-Chrome functional verification of the desktop bundle (ADR 0013).
// Launches Chrome with remote debugging, loads index.html over the static server,
// captures console errors + network 404s, asserts: bootstrap.js loaded, lucide icons
// rendered (data-lucide -> <svg>), the screen hydrated (delegated listeners attached
// + initial palette results reflected), and a LOCAL interaction re-ranks the palette.
// Saves a screenshot. Dependency-free (Node global WebSocket + spawn).

import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

const URL = process.env.VITA_VERIFY_URL ?? "http://localhost:8191/desktop/index.html";
const SHOT = process.env.VITA_VERIFY_SHOT ?? "C:/Users/Borg/vita-vmware/desktop-functional.png";
const CHROME = process.env.VITA_CHROME ?? "C:/Program Files/Google/Chrome/Application/chrome.exe";
const PORT = Number(process.env.VITA_CDP_PORT ?? 9333);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function httpJson(path) {
  const res = await fetch(`http://127.0.0.1:${PORT}${path}`);
  return await res.json();
}

function cdp(ws) {
  let id = 0;
  const pending = new Map();
  const events = [];
  const listeners = [];
  ws.addEventListener("message", (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id !== undefined && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
    } else if (msg.method) {
      events.push(msg);
      for (const l of listeners) l(msg);
    }
  });
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const mid = ++id;
      pending.set(mid, { resolve, reject });
      ws.send(JSON.stringify({ id: mid, method, params }));
    });
  return { send, events, on: (fn) => listeners.push(fn) };
}

async function main() {
  const tmpProfile = `${process.env.TEMP ?? "/tmp"}/vita-cdp-profile-${Date.now()}`;
  const child = spawn(CHROME, [
    "--headless=new",
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${tmpProfile}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-gpu",
    "--window-size=1280,800",
    "--hide-scrollbars",
    "about:blank",
  ], { stdio: "ignore" });

  const report = { url: URL, ok: false, checks: {}, consoleErrors: [], failedRequests: [] };
  try {
    // Wait for the debugging endpoint.
    let targets = null;
    for (let i = 0; i < 40; i++) {
      try { targets = await httpJson("/json"); if (targets?.length) break; } catch {}
      await sleep(250);
    }
    if (!targets?.length) throw new Error("Chrome remote-debugging endpoint never came up");
    const page = targets.find((t) => t.type === "page") ?? targets[0];
    const ws = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((res, rej) => { ws.addEventListener("open", res); ws.addEventListener("error", rej); });
    const c = cdp(ws);

    await c.send("Page.enable");
    await c.send("Runtime.enable");
    await c.send("Log.enable");
    await c.send("Network.enable");

    // Capture console + network problems.
    c.on((m) => {
      if (m.method === "Runtime.consoleAPICalled" && (m.params.type === "error")) {
        report.consoleErrors.push(m.params.args.map((a) => a.value ?? a.description ?? a.type).join(" "));
      }
      if (m.method === "Runtime.exceptionThrown") {
        report.consoleErrors.push("EXCEPTION: " + (m.params.exceptionDetails?.exception?.description ?? m.params.exceptionDetails?.text));
      }
      if (m.method === "Log.entryAdded" && m.params.entry.level === "error" &&
          !/favicon\.ico/.test(m.params.entry.text) &&
          !/favicon\.ico/.test(m.params.entry.url ?? "")) {
        report.consoleErrors.push("LOG: " + m.params.entry.text + " " + (m.params.entry.url ?? ""));
      }
      if (m.method === "Network.responseReceived" && m.params.response.status >= 400 &&
          !/\/favicon\.ico$/.test(m.params.response.url)) {
        report.failedRequests.push(`${m.params.response.status} ${m.params.response.url}`);
      }
      if (m.method === "Network.loadingFailed") {
        report.failedRequests.push(`FAILED ${m.params.errorText} ${m.params.requestId}`);
      }
    });

    const nav = await c.send("Page.navigate", { url: URL });
    await sleep(2500); // let module load + hydrate + lucide.createIcons run

    const evalExpr = (expression) =>
      c.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });

    // --- Assertions ---
    report.checks.bootstrapStatus = (await evalExpr(`
      (async () => { try { const r = await fetch('runtime/bootstrap.js', {method:'GET'}); return r.status; } catch(e){ return 'ERR:'+e.message; } })()
    `)).result.value;

    report.checks.lucideGlobal = (await evalExpr(`typeof window.lucide`)).result.value;

    report.checks.iconSvgCount = (await evalExpr(`document.querySelectorAll('svg.lucide, [data-lucide] svg, i[data-lucide] + svg, svg').length`)).result.value;
    report.checks.dataLucideRemaining = (await evalExpr(`document.querySelectorAll('i[data-lucide]:not(:has(svg))').length`)).result.value;
    report.checks.svgTotal = (await evalExpr(`document.querySelectorAll('svg').length`)).result.value;

    report.checks.screenRoot = (await evalExpr(`!!document.querySelector('[data-vita-screen]')`)).result.value;

    // Initial palette results count (reflected by hydration's first pass).
    report.checks.initialResults = (await evalExpr(`document.querySelectorAll('[data-vita-bind-list="results"] > *').length`)).result.value;

    // Drive a LOCAL interaction: type into the palette query, dispatch 'input', see re-rank.
    report.checks.interaction = (await evalExpr(`
      (() => {
        const q = document.querySelector('[data-vita-action="palette.query"]');
        if (!q) return { fired:false, reason:'no query element' };
        const titles = () => [...document.querySelectorAll('[data-vita-bind-list="results"] [data-vita-bind-text="result.title"]')].map(n=>n.textContent);
        const count = () => document.querySelectorAll('[data-vita-bind-list="results"] > *').length;
        const before = count();
        const beforeTitles = titles();
        // The query anchor is a <span>; the binder's query reader falls back to textContent.
        try { q.value = 'files'; } catch {}
        q.textContent = 'files';
        q.dispatchEvent(new Event('input', { bubbles:true }));
        return new Promise((resolve)=> setTimeout(()=>{
          const after = count();
          const afterTitles = titles();
          resolve({ fired:true, before, after, beforeTitles, afterTitles, query:'files',
                    changed: JSON.stringify(beforeTitles)!==JSON.stringify(afterTitles) || before!==after });
        }, 150));
      })()
    `)).result.value;

    // Screenshot.
    const shot = await c.send("Page.captureScreenshot", { format: "png" });
    mkdirSync(dirname(SHOT), { recursive: true });
    writeFileSync(SHOT, Buffer.from(shot.data, "base64"));
    report.screenshot = SHOT;

    report.ok =
      (report.checks.bootstrapStatus === 200) &&
      report.consoleErrors.length === 0 &&
      report.failedRequests.length === 0 &&
      report.checks.svgTotal > 0 &&
      report.checks.dataLucideRemaining === 0 &&
      report.checks.screenRoot === true &&
      report.checks.initialResults > 0 &&
      report.checks.interaction?.fired === true &&
      report.checks.interaction?.changed === true;

    ws.close();
  } finally {
    child.kill();
  }

  console.log(JSON.stringify(report, null, 2));
  process.exit(report.ok ? 0 : 3);
}

main().catch((e) => { console.error("verify error:", e); process.exit(1); });
