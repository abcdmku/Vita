#!/usr/bin/env node
// Headless-Chrome functional verification of the Vita Deploy Console (connection lifecycle + polish).
//
// Drives REAL headless Chrome (the local Chrome binary via the Chrome DevTools Protocol — dependency-free,
// no puppeteer install, AGPL-clean) against TWO contexts, both served by the console's own preview harness
// (serve-console.ts, in-process):
//
//   1. CONNECTED  — api_origin WITH the stub control plane. Asserts: leaves "connecting", reaches the
//                   "agentd ready" connected state, renders real stats + the capsule table, and a START
//                   then STOP round-trips through the control plane (the row/stats update). Screenshot.
//
//   2. OFFLINE    — api_origin WITHOUT a control plane (--no-control-plane equivalent: an off-device /
//                   browser/dev context). Asserts: leaves "connecting" within the probe timeout, shows the
//                   clean "Control plane unavailable — running off-device" takeover (NO infinite spinner,
//                   NO dangling "—" stat skeletons, NO "Loading apps…"). Screenshot.
//
// Run:  node apps/vita-deploy-console/verify-console.mjs
// Exits 0 iff BOTH contexts pass. Writes a JSON report + 2 PNGs.

import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { startConsoleHarness } from "./serve-console.ts";

const here = dirname(fileURLToPath(import.meta.url));
const CHROME = process.env.VITA_CHROME ?? "C:/Program Files/Google/Chrome/Application/chrome.exe";
const PORT = Number(process.env.VITA_CDP_PORT ?? 9357);
const SHOT_DIR = process.env.VITA_SHOT_DIR ?? `${here}/.verify-shots`;
// Keep the in-page probe short so the OFFLINE context fails fast in the test (the product default is 8s).
const PROBE_MS = 1500;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function httpJson(path) {
  const res = await fetch(`http://127.0.0.1:${PORT}${path}`);
  return res.json();
}

function cdp(ws) {
  let id = 0;
  const pending = new Map();
  const listeners = [];
  ws.addEventListener("message", (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id !== undefined && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
    } else if (msg.method) {
      for (const l of listeners) l(msg);
    }
  });
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const mid = ++id;
      pending.set(mid, { resolve, reject });
      ws.send(JSON.stringify({ id: mid, method, params }));
    });
  return { send, on: (fn) => listeners.push(fn) };
}

async function withPage(fn) {
  const tmpProfile = `${process.env.TEMP ?? "/tmp"}/vita-console-cdp-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const child = spawn(CHROME, [
    "--headless=new",
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${tmpProfile}`,
    "--no-first-run", "--no-default-browser-check",
    "--disable-gpu", "--window-size=1180,760", "--hide-scrollbars",
    "about:blank",
  ], { stdio: "ignore" });
  try {
    let targets = null;
    for (let i = 0; i < 60; i++) {
      try { targets = await httpJson("/json"); if (targets?.length) break; } catch { /* not up yet */ }
      await sleep(200);
    }
    if (!targets?.length) throw new Error("Chrome remote-debugging endpoint never came up");
    const page = targets.find((t) => t.type === "page") ?? targets[0];
    const ws = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((res, rej) => { ws.addEventListener("open", res); ws.addEventListener("error", rej); });
    const c = cdp(ws);
    const consoleErrors = [];
    c.on((m) => {
      if (m.method === "Runtime.exceptionThrown") {
        consoleErrors.push("EXCEPTION: " + (m.params.exceptionDetails?.exception?.description ?? m.params.exceptionDetails?.text));
      }
    });
    await c.send("Page.enable");
    await c.send("Runtime.enable");
    const result = await fn(c, consoleErrors);
    ws.close();
    return result;
  } finally {
    child.kill();
  }
}

async function navigate(c, url) {
  await c.send("Page.navigate", { url });
}
const evalExpr = (c, expression) =>
  c.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }).then((r) => r.result.value);

// Poll an in-page predicate (returns a value) until it satisfies `ok`, or time out.
async function waitFor(c, expr, ok, timeoutMs = 7000, every = 120) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    last = await evalExpr(c, expr);
    if (ok(last)) return last;
    await sleep(every);
  }
  return last;
}

async function screenshot(c, file) {
  const shot = await c.send("Page.captureScreenshot", { format: "png" });
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, Buffer.from(shot.data, "base64"));
  return file;
}

function appUrlWithProbe(base, ms) {
  return base + (base.includes("?") ? "&" : "?") + "vita.probe_timeout_ms=" + ms;
}

// ------------------------------- context 1: CONNECTED -------------------------------
async function verifyConnected(report) {
  const harness = await startConsoleHarness({ controlPlane: true });
  try {
    return await withPage(async (c, consoleErrors) => {
      await navigate(c, appUrlWithProbe(harness.appUrl, 6000));
      // Wait until the lifecycle settles to "connected".
      const conn = await waitFor(c, "window.__CONSOLE__ && window.__CONSOLE__.state.conn", (v) => v === "connected", 9000);
      const ready = await evalExpr(c, "window.__CONSOLE__ && window.__CONSOLE__.ready");
      const pill = await evalExpr(c, "document.getElementById('node-label').textContent");
      const rowCount = await evalExpr(c, "document.querySelectorAll('.app-row').length");
      const statInstalled = await evalExpr(c, "document.getElementById('stat-installed').textContent.trim()");
      const statRunning = await evalExpr(c, "document.getElementById('stat-running').textContent.trim()");
      const mode = await evalExpr(c, "document.getElementById('stat-mode').textContent.trim()");
      // No raw dangling skeletons / "Loading apps…" left.
      const noLoadingApps = await evalExpr(c, "!/Loading apps/.test(document.body.textContent)");
      const noSkeleton = await evalExpr(c, "document.querySelectorAll('.skel').length === 0");

      // Drive START on the stopped, installed capsule (metrics-collector) via the exposed API, then STOP.
      const beforeRunning = await evalExpr(c, "window.__CONSOLE__.state.status.runningCount");
      await evalExpr(c, "window.__CONSOLE__.api.doStart('metrics-collector')");
      await waitFor(c, "(window.__CONSOLE__.state.apps.find(a=>a.id==='metrics-collector')||{}).running", (v) => v === true, 5000);
      const afterStartRunning = await evalExpr(c, "window.__CONSOLE__.state.status.runningCount");
      const startedRunning = await evalExpr(c, "(window.__CONSOLE__.state.apps.find(a=>a.id==='metrics-collector')||{}).running");

      // Select it so its logs + detail render, then screenshot the populated, post-start UI.
      await evalExpr(c, "window.__CONSOLE__.api.selectApp('metrics-collector')");
      await waitFor(c, "document.querySelectorAll('#d-logs .l').length", (v) => v > 0, 4000);
      const logLines = await evalExpr(c, "document.querySelectorAll('#d-logs .l').length");
      const shot = await screenshot(c, `${SHOT_DIR}/console-connected.png`);

      // Now STOP it again to prove the full lifecycle round-trips.
      await evalExpr(c, "window.__CONSOLE__.api.doStop('metrics-collector')");
      await waitFor(c, "(window.__CONSOLE__.state.apps.find(a=>a.id==='metrics-collector')||{}).running", (v) => v === false, 5000);
      const stoppedRunning = await evalExpr(c, "(window.__CONSOLE__.state.apps.find(a=>a.id==='metrics-collector')||{}).running");
      const afterStopRunning = await evalExpr(c, "window.__CONSOLE__.state.status.runningCount");

      const checks = {
        conn, ready, pill, rowCount, statInstalled, statRunning, mode,
        noLoadingApps, noSkeleton,
        beforeRunning, startedRunning, afterStartRunning, stoppedRunning, afterStopRunning,
        logLines, consoleErrors,
      };
      const ok =
        conn === "connected" && ready === true &&
        /agentd ready/i.test(pill) &&
        rowCount === 3 &&
        /^2\b/.test(statInstalled) && /capsules/.test(statInstalled) &&
        mode === "local-desktop" &&
        noLoadingApps === true && noSkeleton === true &&
        startedRunning === true && afterStartRunning === beforeRunning + 1 &&
        stoppedRunning === false && afterStopRunning === beforeRunning &&
        logLines > 0 &&
        consoleErrors.length === 0;

      report.connected = { ok, shot, checks };
      return ok;
    });
  } finally {
    await harness.close();
  }
}

// ------------------------------- context 2: OFFLINE (no control plane) -------------------------------
async function verifyOffline(report) {
  const harness = await startConsoleHarness({ controlPlane: false });
  try {
    return await withPage(async (c, consoleErrors) => {
      await navigate(c, appUrlWithProbe(harness.appUrl, PROBE_MS));
      // Must LEAVE "connecting" (no infinite spin) and land on "offline".
      const conn = await waitFor(c, "window.__CONSOLE__ && window.__CONSOLE__.state.conn", (v) => v && v !== "connecting", 9000);
      const ready = await evalExpr(c, "window.__CONSOLE__ && window.__CONSOLE__.ready");
      const pill = await evalExpr(c, "document.getElementById('node-label').textContent");
      const hasPanel = await evalExpr(c, "!!document.querySelector('.state-panel.offline')");
      const panelTitle = await evalExpr(c, "(document.querySelector('.state-panel h2')||{}).textContent || ''");
      const panelText = await evalExpr(c, "(document.querySelector('.state-panel p')||{}).textContent || ''");
      // The broken states must be GONE: no infinite spinner pulsing, no "Loading apps…", no "connecting…".
      const noConnecting = await evalExpr(c, "!/Connecting/i.test(document.getElementById('node-label').textContent)");
      const noLoadingApps = await evalExpr(c, "!/Loading apps/.test(document.body.textContent)");
      const noSkeleton = await evalExpr(c, "document.querySelectorAll('.skel').length === 0");
      const hasRetry = await evalExpr(c, "!!document.getElementById('state-retry')");
      const shot = await screenshot(c, `${SHOT_DIR}/console-offline.png`);

      const checks = { conn, ready, pill, hasPanel, panelTitle, panelText, noConnecting, noLoadingApps, noSkeleton, hasRetry, consoleErrors };
      const ok =
        conn === "offline" && ready === true &&
        /off-device/i.test(pill) &&
        hasPanel === true &&
        /Control plane unavailable/i.test(panelTitle) &&
        /off-device/i.test(panelText) &&
        noConnecting === true && noLoadingApps === true && noSkeleton === true &&
        hasRetry === true &&
        consoleErrors.length === 0;

      report.offline = { ok, shot, checks };
      return ok;
    });
  } finally {
    await harness.close();
  }
}

async function main() {
  const report = {};
  const okC = await verifyConnected(report);
  const okO = await verifyOffline(report);
  report.ok = okC && okO;
  console.log(JSON.stringify(report, null, 2));
  process.exit(report.ok ? 0 : 3);
}

main().catch((e) => { console.error("verify error:", e?.stack ?? e); process.exit(1); });
