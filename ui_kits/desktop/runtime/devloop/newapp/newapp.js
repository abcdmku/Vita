// Vita New App — the scaffold flow logic (Vita's own code; AGPL-clean).
//
// Imports the SAME scaffold generator the node/tests use (scaffold.ts, served type-stripped at
// ./scaffold.browser.js by the dev-loop harness), so there is ONE source of truth for the generated app
// shape. On Create it generates the file set, then WRITES each file with puter.fs.write against the
// node's api_origin — making the new app immediately runnable.

import { scaffoldApp } from "./scaffold.browser.js";

const $ = (s) => document.querySelector(s);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getPuter(timeoutMs = 10000) {
  const start = Date.now();
  const wantToken = !window.__vitaSession || window.__vitaSession.hasToken !== false;
  for (;;) {
    const p = window.puter;
    if (p && p.fs && p.auth) {
      try { p.quiet = true; } catch (_) {}
      const tokenReady = !wantToken || (typeof p.authToken === "string" && p.authToken.length > 0);
      if (tokenReady) return p;
    }
    if (Date.now() - start > timeoutMs) { if (window.puter && window.puter.fs) return window.puter; throw new Error("SDK not ready"); }
    await sleep(40);
  }
}

let puter;

function setStatus(text, kind = "") { const el = $("#status"); el.textContent = text; el.setAttribute("data-kind", kind); }

async function create() {
  const name = $("#name").value.trim();
  if (!name) { setStatus("Enter an app name.", "error"); return; }
  const input = { name };
  const desc = $("#desc").value.trim(); if (desc) input.description = desc;
  const icon = $("#icon").value.trim(); if (icon) input.icon = icon;
  const appsDir = $("#appsdir").value.trim(); if (appsDir) input.appsDir = appsDir;

  let result;
  try { result = scaffoldApp(input); }
  catch (err) { setStatus("Scaffold failed: " + (err.message || err), "error"); return; }

  $("#create").disabled = true;
  setStatus("Writing " + result.files.length + " files…");
  try {
    // Ensure the app directory chain exists, then write each file.
    try { await puter.fs.mkdir(result.appDir, { createMissingParents: true }); } catch (_) {}
    for (const file of result.files) {
      await puter.fs.write(file.path, file.content, { overwrite: true, dedupeName: false, createMissingParents: true });
    }
    showResult(result);
    setStatus("Created " + result.appId, "ok");
    window.__newAppLast = { appId: result.appId, appDir: result.appDir, entryPath: result.entryPath, files: result.files.map((f) => f.path) };
  } catch (err) {
    setStatus("Write failed: " + (err.message || err), "error");
  } finally {
    $("#create").disabled = false;
  }
}

function showResult(result) {
  $("#r-id").textContent = result.appId;
  const ul = $("#r-files"); ul.innerHTML = "";
  for (const f of result.files) { const li = document.createElement("li"); li.textContent = f.path; ul.appendChild(li); }
  // "Open it" → serve the new app's entry from the file-backed store via the harness app-runner route.
  const runUrl = "/run?path=" + encodeURIComponent(result.entryPath);
  $("#r-open").href = runUrl;
  $("#r-edit").href = "/devloop/editor/index.html?open=" + encodeURIComponent(result.entryPath);
  $("#result").hidden = false;
}

(async () => {
  const boot = $("#boot");
  try {
    puter = await getPuter();
    try { const me = await puter.auth.getUser(); $("#who").textContent = (me && me.username) || "owner"; }
    catch (_) { $("#who").textContent = "owner"; }
    $("#create").addEventListener("click", create);
    boot.style.display = "none";
    window.__newAppReady = true;
  } catch (err) {
    boot.textContent = "Failed to start: " + (err.message || err);
  }
})();
