// Vita Code — the dev-loop EDITOR app logic (Vita's own code; AGPL-clean).
//
// A real Puter app: it opens/edits/saves files through the genuine vendored puter.js SDK (Apache-2.0)
// pointed at Vita's LOCAL api_origin. Open => puter.fs.read; Save => puter.fs.write (multipart upload).
// The code surface is CodeMirror 5 (MIT, vendored). No framework, no build step — one ES module.
//
// Boot: /session.js (in <head>) already pointed the SDK at our same-origin /api and injected the local
// app-session token; we await the SDK + token before any fs call (the genuine SDK pops a consent modal
// if a call runs with an empty token — env is treated as 'web' without one).

const $ = (sel) => document.querySelector(sel);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// The owner HOME namespace. The genuine puter.js SDK REFUSES to write a file whose parent is the root
// ("Can not upload to root directory."), so the editor operates under /home, never directly at "/".
const HOME = "/home";

const els = {
  app: $("#app"),
  boot: $("#boot"),
  bootMsg: $("#boot-msg"),
  bootErr: $("#boot-err"),
  path: $("#path"),
  lang: $("#lang"),
  dirty: $("#dirty"),
  status: $("#status"),
  cursor: $("#cursor"),
  btnOpen: $("#btn-open"),
  btnNew: $("#btn-new"),
  btnSave: $("#btn-save"),
  toasts: $("#toasts"),
};

let puter; // resolved in boot()
let cm; // the CodeMirror instance
let currentPath = null;
let dirty = false;

// ---- SDK handle (await SDK + injected token; see kiosk app.js for the rationale) ----
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
    if (Date.now() - start > timeoutMs) {
      if (window.puter && window.puter.fs) return window.puter;
      throw new Error("puter.js SDK did not initialize");
    }
    await sleep(40);
  }
}

// ---- tiny helpers ----
function toast(message, kind = "") {
  const el = document.createElement("div");
  el.className = "toast" + (kind ? " " + kind : "");
  el.textContent = message;
  els.toasts.appendChild(el);
  setTimeout(() => { el.style.transition = "opacity .25s"; el.style.opacity = "0"; setTimeout(() => el.remove(), 260); }, 2600);
}
function setStatus(text, kind = "") {
  els.status.textContent = text;
  els.status.setAttribute("data-kind", kind);
}
function setDirty(value) {
  dirty = value;
  els.dirty.textContent = value ? "Unsaved" : "Saved";
  els.dirty.setAttribute("data-dirty", String(value));
}
function basename(path) {
  const trimmed = String(path).replace(/\/+$/, "");
  const i = trimmed.lastIndexOf("/");
  return i < 0 ? trimmed : trimmed.slice(i + 1);
}
// Map a file extension to a CodeMirror mode + a friendly language label.
function modeForPath(path) {
  const name = basename(path).toLowerCase();
  const ext = name.includes(".") ? name.slice(name.lastIndexOf(".") + 1) : "";
  switch (ext) {
    case "js": case "mjs": case "cjs": return { mode: "javascript", label: "JavaScript" };
    case "ts": case "tsx": return { mode: { name: "javascript", typescript: true }, label: "TypeScript" };
    case "json": return { mode: { name: "javascript", json: true }, label: "JSON" };
    case "html": case "htm": return { mode: "htmlmixed", label: "HTML" };
    case "css": return { mode: "css", label: "CSS" };
    case "xml": case "svg": return { mode: "xml", label: "XML" };
    case "md": case "markdown": return { mode: "markdown", label: "Markdown" };
    default: return { mode: "text/plain", label: "Plain" };
  }
}
function applyMode(path) {
  const { mode, label } = modeForPath(path);
  cm.setOption("mode", mode);
  els.lang.textContent = label;
}

// fs.read returns a Blob-like (the SDK normalizes); read its text robustly.
async function readText(result) {
  if (result && typeof result.text === "function") return await result.text();
  if (result && result.result && typeof result.result.text === "function") return await result.result.text();
  if (typeof result === "string") return result;
  return String(result ?? "");
}

// ---- file ops ----
async function openPath(path) {
  if (!path) { toast("Enter a file path.", "error"); return; }
  setStatus("Opening " + path + "…");
  try {
    const res = await puter.fs.read(path);
    const text = await readText(res);
    cm.setValue(text);
    cm.clearHistory();
    currentPath = path;
    els.path.value = path;
    applyMode(path);
    setDirty(false);
    setStatus("Opened " + path, "ok");
    document.title = basename(path) + " — Vita Code";
  } catch (err) {
    const msg = err && err.message ? err.message : String(err);
    // A not-found is a normal "new file" case — offer an empty buffer rooted at the path.
    if (/not.?exist|no such|404|subject_does_not_exist/i.test(msg)) {
      cm.setValue("");
      cm.clearHistory();
      currentPath = path;
      els.path.value = path;
      applyMode(path);
      setDirty(true);
      setStatus("New file: " + path + " (not saved yet)", "");
      document.title = basename(path) + " — Vita Code";
    } else {
      setStatus("Open failed: " + msg, "error");
      toast("Open failed: " + msg, "error");
    }
  }
}

async function saveCurrent() {
  const path = (els.path.value || currentPath || "").trim();
  if (!path) { toast("Enter a file path to save.", "error"); return; }
  if (path === "/" || path.replace(/\/+$/, "") === "") { toast("Cannot save at the root.", "error"); return; }
  setStatus("Saving " + path + "…");
  els.btnSave.disabled = true;
  try {
    const content = cm.getValue();
    // puter.fs.write(path, content) — creates missing parent dirs + overwrites. dedupeName:false so we
    // overwrite the same path rather than getting a "file (1)" copy.
    await puter.fs.write(path, content, { overwrite: true, dedupeName: false, createMissingParents: true });
    currentPath = path;
    applyMode(path);
    setDirty(false);
    setStatus("Saved " + path, "ok");
    toast("Saved " + basename(path), "ok");
    document.title = basename(path) + " — Vita Code";
  } catch (err) {
    const msg = err && err.message ? err.message : String(err);
    setStatus("Save failed: " + msg, "error");
    toast("Save failed: " + msg, "error");
  } finally {
    els.btnSave.disabled = false;
  }
}

function newFile() {
  const stamp = Date.now();
  const path = HOME + "/untitled-" + stamp + ".txt";
  cm.setValue("");
  cm.clearHistory();
  currentPath = path;
  els.path.value = path;
  applyMode(path);
  setDirty(true);
  setStatus("New file: " + path + " (Save to persist)", "");
  cm.focus();
}

// ---- boot ----
async function boot() {
  // Paint Lucide chrome icons (idempotent; replaces any <i data-lucide> with inline SVGs).
  try { window.lucide && window.lucide.createIcons(); } catch (_) {}
  // CodeMirror surface.
  cm = window.CodeMirror.fromTextArea(els.code || document.getElementById("code"), {
    lineNumbers: true,
    lineWrapping: false,
    indentUnit: 2,
    tabSize: 2,
    mode: "text/plain",
    autofocus: true,
  });
  cm.setSize("100%", "100%");
  cm.on("change", () => { if (!dirty) setDirty(true); });
  cm.on("cursorActivity", () => {
    const c = cm.getCursor();
    els.cursor.textContent = "Ln " + (c.line + 1) + ", Col " + (c.ch + 1);
  });

  els.btnOpen.addEventListener("click", () => openPath(els.path.value.trim()));
  els.btnSave.addEventListener("click", () => saveCurrent());
  els.btnNew.addEventListener("click", () => newFile());
  els.path.addEventListener("keydown", (e) => { if (e.key === "Enter") openPath(els.path.value.trim()); });
  document.addEventListener("keydown", (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") { e.preventDefault(); saveCurrent(); }
  });

  els.bootMsg.textContent = "Connecting to api_origin…";
  try {
    puter = await getPuter();
    // Prove the gate clears (whoami). Non-fatal if it lags; fs ops surface their own errors.
    try { await puter.auth.getUser(); } catch (_) {}
    // Ensure HOME exists so first saves under it succeed.
    try { await puter.fs.mkdir(HOME, { createMissingParents: true }); } catch (_) {}
    els.app.setAttribute("data-state", "ready");
    setStatus("Ready", "ok");
    // Explicitly remove the boot overlay from layout once ready (belt-and-suspenders over the CSS fade) so
    // its spinner can never flash back or sit (invisible) atop the editor.
    try { const b = document.getElementById("boot"); if (b) { b.hidden = true; b.style.display = "none"; } } catch (_) {}
    // Expose a readiness flag + a thin handle for the verification harness.
    window.__vitaCodeReady = true;
    window.__vitaCode = {
      open: openPath,
      save: saveCurrent,
      setValue: (v) => cm.setValue(v),
      getValue: () => cm.getValue(),
      setPath: (p) => { els.path.value = p; },
    };
  } catch (err) {
    els.bootErr.hidden = false;
    els.bootErr.textContent = err && err.message ? err.message : String(err);
    setStatus("Boot failed", "error");
  }
}

boot();
