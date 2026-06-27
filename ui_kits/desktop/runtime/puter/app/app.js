// Vita Desk — app logic. Vita's own code (AGPL-clean). Drives the Apache-2.0 puter.js SDK against
// Vita's LOCAL api_origin. Every action below is a REAL call to puter.fs / puter.kv / puter.auth that
// goes over HTTP to the api_origin and persists to Vita's file-backed store.
//
// Boot sequence:
//   1. /session.js (loaded in <head>) has already pointed puter.js at our same-origin /api and set the
//      injected vita.kiosk session token. We retry-await the SDK in case of a load race.
//   2. auth.whoami() proves the gate clears, then we render the Files view rooted at the owner home.
//
// No framework, no build step — a single ES module the kiosk browser loads directly.

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

const els = {
  app: $("#app"),
  boot: $("#boot"),
  bootMsg: $("#boot-msg"),
  bootErr: $("#boot-err"),
  whoName: $("#who-name"),
  conn: $("#conn"),
  // files
  filelist: $("#filelist"),
  filesEmpty: $("#files-empty"),
  cwd: $("#cwd"),
  btnUp: $("#btn-up"),
  btnNewFolder: $("#btn-newfolder"),
  btnNewFile: $("#btn-newfile"),
  btnRefresh: $("#btn-refresh"),
  // notes
  notePath: $("#note-path"),
  noteBody: $("#note-body"),
  noteStatus: $("#note-status"),
  btnOpen: $("#btn-open"),
  btnSave: $("#btn-save"),
  // settings
  themeSelect: $("#theme-select"),
  btnCount: $("#btn-count"),
  count: $("#count"),
  btnCountReset: $("#btn-count-reset"),
  dbgOrigin: $("#dbg-origin"),
  dbgWhoami: $("#dbg-whoami"),
  dbgToken: $("#dbg-token"),
  // modal
  modal: $("#modal"),
  modalTitle: $("#modal-title"),
  modalInput: $("#modal-input"),
  modalOk: $("#modal-ok"),
  modalCancel: $("#modal-cancel"),
  toasts: $("#toasts"),
};

// The owner's HOME dir. NOTE: the real puter.js SDK REFUSES to write a file whose parent is the root
// ("Can not upload to root directory." — verified in a real browser), so the app operates inside a
// home directory, never directly at "/". Files/notes live under HOME; the file manager is rooted here.
const HOME = "/home";
const NOTES_DIR = HOME + "/notes";
const state = { cwd: HOME };

// ---- the SDK handle ----
// Await the SDK AND its injected session token. /session.js (loaded in <head>) points the SDK at our
// same-origin /api and calls setAuthToken(); it exposes window.__vitaSession.hasToken. The genuine
// puter.js will pop its OWN "authenticate with Puter" consent modal if any fs/kv/auth call runs while
// `authToken` is empty (env is treated as 'web'/'app' without a token), so we must NOT make a call
// until the token is applied. We wait for it (when /session.js says one exists) before returning.
async function getPuter(timeoutMs = 10000) {
  const start = Date.now();
  const wantToken = !window.__vitaSession || window.__vitaSession.hasToken !== false;
  for (;;) {
    const p = window.puter;
    if (p && p.fs && p.kv && p.auth) {
      // Silence the SDK's promotional console banner + realtime chatter.
      try { p.quiet = true; } catch (_) {}
      const tokenReady = !wantToken || (typeof p.authToken === "string" && p.authToken.length > 0);
      if (tokenReady) return p;
    }
    if (Date.now() - start > timeoutMs) {
      if (window.puter && window.puter.fs) return window.puter; // proceed; surfaces an auth error instead of hanging
      throw new Error("puter.js SDK did not initialize");
    }
    await sleep(40);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- tiny UI helpers ----
function toast(message, kind = "") {
  const el = document.createElement("div");
  el.className = "toast" + (kind ? " " + kind : "");
  el.textContent = message;
  els.toasts.appendChild(el);
  setTimeout(() => {
    el.style.transition = "opacity .25s";
    el.style.opacity = "0";
    setTimeout(() => el.remove(), 260);
  }, 2600);
}

// A themed prompt (so we don't depend on puter.ui being brokered for input). Resolves to the string
// or null on cancel.
function promptModal(title, value = "") {
  return new Promise((resolve) => {
    els.modalTitle.textContent = title;
    els.modalInput.value = value;
    els.modal.hidden = false;
    els.modalInput.focus();
    els.modalInput.select();

    const done = (result) => {
      els.modal.hidden = true;
      els.modalOk.removeEventListener("click", onOk);
      els.modalCancel.removeEventListener("click", onCancel);
      els.modalInput.removeEventListener("keydown", onKey);
      resolve(result);
    };
    const onOk = () => done(els.modalInput.value.trim() || null);
    const onCancel = () => done(null);
    const onKey = (e) => {
      if (e.key === "Enter") onOk();
      else if (e.key === "Escape") onCancel();
    };
    els.modalOk.addEventListener("click", onOk);
    els.modalCancel.addEventListener("click", onCancel);
    els.modalInput.addEventListener("keydown", onKey);
  });
}

function fmtSize(n) {
  if (!n) return "—";
  if (n < 1024) return n + " B";
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + " KB";
  return (n / (1024 * 1024)).toFixed(1) + " MB";
}
function fmtTime(secs) {
  if (!secs) return "";
  const d = new Date(secs * 1000);
  return d.toLocaleString();
}
function joinPath(dir, name) {
  if (dir === "/") return "/" + name;
  return dir.replace(/\/$/, "") + "/" + name;
}
function parentOf(path) {
  if (path === "/" || path === "") return "/";
  const i = path.replace(/\/$/, "").lastIndexOf("/");
  const parent = i <= 0 ? "/" : path.slice(0, i);
  // Don't let the file manager climb above HOME (the app's namespace root).
  return parent === "/" && path !== "/" ? "/" : parent;
}
function navParentOf(path) {
  // Like parentOf but clamped to HOME for the file-manager "Up" button.
  const p = parentOf(path);
  return p === "/" ? HOME : p;
}

// =================================================================================================
// FILES
// =================================================================================================
let puter; // resolved in boot()

async function refreshFiles() {
  els.cwd.textContent = state.cwd;
  // Stay within HOME — the app namespace is rooted there (root writes are blocked by the SDK anyway).
  els.btnUp.disabled = state.cwd === HOME || state.cwd === "/";
  let entries;
  try {
    entries = await puter.fs.readdir(state.cwd);
  } catch (e) {
    toast("Could not read " + state.cwd + ": " + errText(e), "err");
    return;
  }
  // Normalize SDK shape: array of fsentries { name, is_dir, size, modified, path }.
  const list = (Array.isArray(entries) ? entries : []).map(normalizeEntry);
  list.sort((a, b) => (b.is_dir - a.is_dir) || a.name.localeCompare(b.name));

  els.filelist.innerHTML = "";
  els.filesEmpty.hidden = list.length > 0;

  for (const ent of list) {
    const li = document.createElement("li");
    li.className = "file";
    li.dataset.name = ent.name;
    li.dataset.dir = ent.is_dir ? "1" : "0";

    const icon = document.createElement("span");
    icon.className = "icon";
    icon.textContent = ent.is_dir ? "📁" : "📄";

    const name = document.createElement("span");
    name.className = "name" + (ent.is_dir ? " dir" : "");
    name.textContent = ent.name;
    name.title = ent.name;
    if (ent.is_dir) name.addEventListener("click", () => { state.cwd = joinPath(state.cwd, ent.name); refreshFiles(); });
    else name.addEventListener("click", () => openInNotes(joinPath(state.cwd, ent.name)));

    const meta = document.createElement("span");
    meta.className = "meta";
    meta.textContent = ent.is_dir ? "folder" : fmtSize(ent.size);

    const actions = document.createElement("span");
    actions.className = "row-actions";
    const rn = document.createElement("button");
    rn.className = "icon-btn"; rn.textContent = "Rename"; rn.title = "Rename";
    rn.addEventListener("click", () => renameEntry(ent));
    const del = document.createElement("button");
    del.className = "icon-btn danger"; del.textContent = "Delete"; del.title = "Delete";
    del.addEventListener("click", () => deleteEntry(ent));
    actions.append(rn, del);

    li.append(icon, name, meta, actions);
    els.filelist.appendChild(li);
  }
}

function normalizeEntry(e) {
  return {
    name: e.name ?? e.path?.split("/").pop() ?? "(unknown)",
    is_dir: !!(e.is_dir ?? e.isDirectory),
    size: e.size ?? 0,
    modified: e.modified ?? 0,
    path: e.path ?? joinPath(state.cwd, e.name ?? ""),
  };
}

async function newFolder() {
  const name = await promptModal("New folder name", "untitled-folder");
  if (!name) return;
  try {
    await puter.fs.mkdir(joinPath(state.cwd, name));
    toast("Folder created: " + name, "ok");
    refreshFiles();
  } catch (e) { toast("mkdir failed: " + errText(e), "err"); }
}

async function newFile() {
  const name = await promptModal("New file name", "untitled.txt");
  if (!name) return;
  const path = joinPath(state.cwd, name);
  try {
    // Real browser-only upload path: puter.fs.write(path, Blob/string).
    await puter.fs.write(path, new Blob([""], { type: "text/plain" }), { overwrite: false });
    toast("File created: " + name, "ok");
    refreshFiles();
    openInNotes(path);
  } catch (e) { toast("write failed: " + errText(e), "err"); }
}

async function renameEntry(ent) {
  const next = await promptModal("Rename “" + ent.name + "” to", ent.name);
  if (!next || next === ent.name) return;
  try {
    await puter.fs.rename(joinPath(state.cwd, ent.name), next);
    toast("Renamed to " + next, "ok");
    refreshFiles();
  } catch (e) { toast("rename failed: " + errText(e), "err"); }
}

async function deleteEntry(ent) {
  const ok = await promptModal("Type DELETE to remove “" + ent.name + "”", "");
  if (ok !== "DELETE") { if (ok !== null) toast("Delete cancelled (type DELETE to confirm)"); return; }
  try {
    await puter.fs.delete(joinPath(state.cwd, ent.name), { recursive: true });
    toast("Deleted " + ent.name, "ok");
    refreshFiles();
  } catch (e) { toast("delete failed: " + errText(e), "err"); }
}

// =================================================================================================
// NOTES
// =================================================================================================
function switchTo(view) {
  $$(".tab").forEach((t) => {
    const on = t.dataset.view === view;
    t.classList.toggle("is-active", on);
    t.setAttribute("aria-selected", on ? "true" : "false");
  });
  $$(".view").forEach((v) => v.classList.toggle("is-active", v.dataset.view === view));
  if (view === "files") refreshFiles();
}

function openInNotes(path) {
  els.notePath.value = path;
  switchTo("notes");
  openNote();
}

async function openNote() {
  const path = els.notePath.value.trim();
  if (!path) return;
  els.noteStatus.textContent = "opening…";
  els.noteStatus.className = "note-status";
  try {
    const blob = await puter.fs.read(path);
    const text = await blobText(blob);
    els.noteBody.value = text;
    els.noteStatus.textContent = "opened";
    els.noteStatus.className = "note-status";
  } catch (e) {
    // A not-found file is fine — start a blank buffer the user can Save to create it.
    els.noteBody.value = "";
    els.noteStatus.textContent = "new file (not saved yet)";
    els.noteStatus.className = "note-status";
  }
}

async function saveNote() {
  const path = els.notePath.value.trim();
  if (!path) { toast("Enter a path first", "err"); return; }
  els.noteStatus.textContent = "saving…";
  els.noteStatus.className = "note-status";
  try {
    // Ensure the parent dir exists (mkdir is idempotent here), then write.
    const dir = parentOf(path);
    if (dir !== "/") { try { await puter.fs.mkdir(dir); } catch (_) { /* exists */ } }
    await puter.fs.write(path, new Blob([els.noteBody.value], { type: "text/plain" }), { overwrite: true });
    els.noteStatus.textContent = "saved ✓";
    els.noteStatus.className = "note-status saved";
    toast("Saved " + path, "ok");
  } catch (e) {
    els.noteStatus.textContent = "save failed";
    els.noteStatus.className = "note-status err";
    toast("save failed: " + errText(e), "err");
  }
}

async function blobText(b) {
  if (b == null) return "";
  if (typeof b === "string") return b;
  if (typeof b.text === "function") return await b.text();
  if (b.result && typeof b.result.text === "function") return await b.result.text();
  if (b instanceof ArrayBuffer) return new TextDecoder().decode(b);
  if (b.arrayBuffer) return new TextDecoder().decode(await b.arrayBuffer());
  return String(b);
}

// =================================================================================================
// SETTINGS (KV-backed)
// =================================================================================================
const KV_THEME = "vita.desk.theme";
const KV_COUNT = "vita.desk.clicks";

async function loadSettings() {
  try {
    const theme = await puter.kv.get(KV_THEME);
    if (theme) { document.documentElement.dataset.theme = theme; els.themeSelect.value = theme; }
    const count = await puter.kv.get(KV_COUNT);
    els.count.textContent = String(Number(count) || 0);
  } catch (e) { /* first run: keys absent */ }
}

async function setTheme(theme) {
  document.documentElement.dataset.theme = theme;
  try { await puter.kv.set(KV_THEME, theme); toast("Theme saved", "ok"); }
  catch (e) { toast("kv.set failed: " + errText(e), "err"); }
}

async function bumpCount(delta) {
  const next = (Number(els.count.textContent) || 0) + delta;
  const val = delta === 0 ? 0 : next;
  els.count.textContent = String(val < 0 ? 0 : val);
  try { await puter.kv.set(KV_COUNT, String(val < 0 ? 0 : val)); }
  catch (e) { toast("kv.set failed: " + errText(e), "err"); }
}

// =================================================================================================
// BOOT
// =================================================================================================
function errText(e) {
  if (!e) return "error";
  if (typeof e === "string") return e;
  return e.message || e.error?.message || e.code || JSON.stringify(e);
}

function wireEvents() {
  $$(".tab").forEach((t) => t.addEventListener("click", () => switchTo(t.dataset.view)));
  els.btnUp.addEventListener("click", () => { state.cwd = navParentOf(state.cwd); refreshFiles(); });
  els.btnNewFolder.addEventListener("click", newFolder);
  els.btnNewFile.addEventListener("click", newFile);
  els.btnRefresh.addEventListener("click", refreshFiles);
  els.btnOpen.addEventListener("click", openNote);
  els.btnSave.addEventListener("click", saveNote);
  els.themeSelect.addEventListener("change", () => setTheme(els.themeSelect.value));
  els.btnCount.addEventListener("click", () => bumpCount(1));
  els.btnCountReset.addEventListener("click", () => bumpCount(0));
  // Ctrl/Cmd-S saves when in the notes view.
  document.addEventListener("keydown", (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
      if ($(".view-notes").classList.contains("is-active")) { e.preventDefault(); saveNote(); }
    }
  });
}

async function ensureSeedContent() {
  // On first run, seed a welcome note + a sample folder so the desktop is never empty (and the
  // verification has something to click). Idempotent: only writes if absent.
  try {
    // Ensure HOME exists (the app namespace root). mkdir is idempotent.
    await puter.fs.mkdir(HOME).catch(() => {});
    const root = await puter.fs.readdir(HOME).catch(() => []);
    const names = (Array.isArray(root) ? root : []).map((e) => e.name);
    if (!names.includes("notes")) await puter.fs.mkdir(NOTES_DIR).catch(() => {});
    const welcome = NOTES_DIR + "/welcome.txt";
    // Check existence via readdir (avoids a noisy 404 from stat on a missing path).
    const notesEntries = await puter.fs.readdir(NOTES_DIR).catch(() => []);
    const exists = (Array.isArray(notesEntries) ? notesEntries : []).some((e) => e.name === "welcome.txt");
    if (!exists) {
      const body = [
        "Welcome to Vita Desk.",
        "",
        "This is a real, interactive Puter app running on Vita's own api_origin.",
        "Try: create a file, rename it, edit this note and press Save, then reload —",
        "everything persists to /var/lib/vita/apps.",
      ].join("\n");
      await puter.fs.write(welcome, new Blob([body], { type: "text/plain" }), { overwrite: false }).catch(() => {});
    }
  } catch (_) { /* non-fatal */ }
}

async function boot() {
  wireEvents();
  els.bootMsg.textContent = "Loading puter.js SDK…";
  try {
    puter = await getPuter();
  } catch (e) {
    return bootFail("The puter.js SDK failed to load. " + errText(e));
  }

  const origin = (puter.APIOrigin || (window.__vitaSession && window.__vitaSession.apiOrigin) || (location.origin + "/api"));
  els.dbgOrigin.textContent = origin;
  els.dbgToken.textContent = puter.authToken ? (String(puter.authToken).slice(0, 8) + "…") : "(none)";

  els.bootMsg.textContent = "Authenticating with api_origin…";
  try {
    const me = await puter.auth.whoami();
    const name = me && (me.username || me.user?.username) || "owner";
    els.whoName.textContent = name;
    els.dbgWhoami.textContent = JSON.stringify(me);
    els.conn.textContent = "connected";
    els.conn.className = "conn ok";
  } catch (e) {
    els.conn.textContent = "auth failed";
    els.conn.className = "conn err";
    els.dbgWhoami.textContent = "FAILED: " + errText(e);
    // Not fatal for browsing if the gate is open on the local face, but surface it.
    toast("whoami failed: " + errText(e), "err");
  }

  await loadSettings();
  await ensureSeedContent();
  await refreshFiles();

  els.app.dataset.state = "ready";
  // Mark for the boot-log / screenshot verification.
  document.title = "Vita Desk — ready";
  window.__vitaDeskReady = true;
}

function bootFail(msg) {
  els.bootMsg.textContent = "Could not start.";
  els.bootErr.hidden = false;
  els.bootErr.textContent = msg;
  els.conn.textContent = "offline";
  els.conn.className = "conn err";
}

boot();
