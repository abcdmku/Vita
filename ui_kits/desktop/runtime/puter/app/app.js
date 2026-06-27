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
  whoAvatar: $("#who-avatar"),
  conn: $("#conn"),
  connLabel: $(".conn-label"),
  // files
  filelist: $("#filelist"),
  filesEmpty: $("#files-empty"),
  crumbs: $("#crumbs"),
  listhead: $("#listhead"),
  btnUp: $("#btn-up"),
  btnNewFolder: $("#btn-newfolder"),
  btnNewFile: $("#btn-newfile"),
  btnRefresh: $("#btn-refresh"),
  viewList: $("#view-list"),
  viewGrid: $("#view-grid"),
  statItems: $("#stat-items"),
  statFolders: $("#stat-folders"),
  statFiles: $("#stat-files"),
  sideHome: $("#side-home"),
  sideNotes: $("#side-notes"),
  // notes
  notelist: $("#notelist"),
  notesEmpty: $("#notes-empty"),
  noteTitle: $("#note-title"),
  notePath: $("#note-path"),
  noteDirty: $("#note-dirty"),
  noteBody: $("#note-body"),
  noteStatus: $("#note-status"),
  noteMeta: $("#note-meta"),
  btnSave: $("#btn-save"),
  btnNewNote: $("#btn-newnote"),
  // settings
  themePicker: $("#theme-picker"),
  accentPicker: $("#accent-picker"),
  setViewList: $("#set-view-list"),
  setViewGrid: $("#set-view-grid"),
  toggleFoldersFirst: $("#toggle-foldersfirst"),
  dbgStatus: $("#dbg-status"),
  dbgUser: $("#dbg-user"),
  dbgOrigin: $("#dbg-origin"),
  dbgToken: $("#dbg-token"),
  // modal
  modal: $("#modal"),
  modalTitle: $("#modal-title"),
  modalDesc: $("#modal-desc"),
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

const state = {
  cwd: HOME,
  fileView: "list",       // "list" | "grid"
  foldersFirst: true,
  selected: null,         // currently selected entry name in Files
  notes: [],              // [{name, path, size, modified}]
  noteCurrent: NOTES_DIR + "/welcome.txt",
  noteDirty: false,
  noteSavedText: "",
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

// =================================================================================================
// tiny UI helpers
// =================================================================================================
function toast(message, kind = "") {
  const el = document.createElement("div");
  el.className = "toast" + (kind ? " " + kind : "");
  el.textContent = message;
  els.toasts.appendChild(el);
  setTimeout(() => {
    el.classList.add("leaving");
    setTimeout(() => el.remove(), 280);
  }, 2600);
}

// A themed prompt (so we don't depend on puter.ui being brokered for input). Resolves to the string
// or null on cancel. `opts.okLabel` / `opts.desc` customize the dialog.
function promptModal(title, value = "", opts = {}) {
  return new Promise((resolve) => {
    els.modalTitle.textContent = title;
    if (opts.desc) { els.modalDesc.textContent = opts.desc; els.modalDesc.hidden = false; }
    else els.modalDesc.hidden = true;
    els.modalOk.textContent = opts.okLabel || "OK";
    els.modalOk.classList.toggle("btn-primary", !opts.danger);
    els.modalInput.value = value;
    els.modal.hidden = false;
    els.modalInput.focus();
    els.modalInput.select();

    const done = (result) => {
      els.modal.hidden = true;
      els.modalOk.textContent = "OK";
      els.modalOk.classList.add("btn-primary");
      els.modalOk.removeEventListener("click", onOk);
      els.modalCancel.removeEventListener("click", onCancel);
      els.modalInput.removeEventListener("keydown", onKey);
      resolve(result);
    };
    const onOk = () => done(els.modalInput.value.trim() || null);
    const onCancel = () => done(null);
    const onKey = (e) => {
      if (e.key === "Enter") { e.preventDefault(); onOk(); }
      else if (e.key === "Escape") { e.preventDefault(); onCancel(); }
    };
    els.modalOk.addEventListener("click", onOk);
    els.modalCancel.addEventListener("click", onCancel);
    els.modalInput.addEventListener("keydown", onKey);
  });
}

function fmtSize(n) {
  if (!n || n < 0) return "—";
  if (n < 1024) return n + " B";
  if (n < 1024 * 1024) return (n / 1024).toFixed(n < 10240 ? 1 : 0) + " KB";
  return (n / (1024 * 1024)).toFixed(1) + " MB";
}
function fmtWhen(secs) {
  if (!secs) return "";
  const d = new Date(secs * 1000);
  const now = Date.now();
  const diff = (now - d.getTime()) / 1000;
  if (diff < 60) return "just now";
  if (diff < 3600) return Math.floor(diff / 60) + "m ago";
  if (diff < 86400) return Math.floor(diff / 3600) + "h ago";
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}
function joinPath(dir, name) {
  if (dir === "/") return "/" + name;
  return dir.replace(/\/$/, "") + "/" + name;
}
function parentOf(path) {
  if (path === "/" || path === "") return "/";
  const i = path.replace(/\/$/, "").lastIndexOf("/");
  const parent = i <= 0 ? "/" : path.slice(0, i);
  return parent === "/" && path !== "/" ? "/" : parent;
}
function navParentOf(path) {
  const p = parentOf(path);
  return p === "/" ? HOME : p;
}
function baseName(path) {
  return path.replace(/\/+$/, "").split("/").pop() || path;
}

// Classify a filename into an icon family (class + inline svg). AGPL-clean inline glyphs (no emoji).
function fileKind(name, isDir) {
  if (isDir) return { cls: "ic-folder", label: "Folder", svg: SVG.folder };
  const ext = (name.split(".").pop() || "").toLowerCase();
  if (["md", "markdown"].includes(ext)) return { cls: "ic-note", label: "Markdown", svg: SVG.note };
  if (["txt", "rtf", "log"].includes(ext)) return { cls: "ic-text", label: "Text", svg: SVG.text };
  if (["js", "ts", "tsx", "jsx", "json", "html", "css", "sh", "py", "go", "rs", "c", "cpp", "java"].includes(ext))
    return { cls: "ic-code", label: ext.toUpperCase(), svg: SVG.code };
  if (["png", "jpg", "jpeg", "gif", "svg", "webp", "ico"].includes(ext)) return { cls: "ic-img", label: "Image", svg: SVG.img };
  if (["csv", "tsv", "yaml", "yml", "toml", "xml"].includes(ext)) return { cls: "ic-data", label: "Data", svg: SVG.data };
  if (["zip", "tar", "gz", "tgz", "7z", "rar"].includes(ext)) return { cls: "ic-archive", label: "Archive", svg: SVG.archive };
  return { cls: "ic-text", label: ext ? ext.toUpperCase() : "File", svg: SVG.text };
}

const SVG = {
  folder:  '<svg viewBox="0 0 24 24" fill="none"><path d="M3 7A1.5 1.5 0 0 1 4.5 5.5h4l2 2.2h7A1.5 1.5 0 0 1 19 9.2v8A1.5 1.5 0 0 1 17.5 18.7h-13A1.5 1.5 0 0 1 3 17.2z" fill="currentColor"/></svg>',
  text:    '<svg viewBox="0 0 24 24" fill="none"><path d="M7 3h7l4 4v13a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z" stroke="currentColor" stroke-width="1.5"/><path d="M14 3v4h4M9 12h6M9 15h6M9 9h2" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>',
  note:    '<svg viewBox="0 0 24 24" fill="none"><path d="M7 3h7l4 4v13a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z" stroke="currentColor" stroke-width="1.5"/><path d="M14 3v4h4M9 12l1.5 3 1.5-3 1.5 3 1.5-3" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/></svg>',
  code:    '<svg viewBox="0 0 24 24" fill="none"><path d="M7 3h7l4 4v13a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z" stroke="currentColor" stroke-width="1.5"/><path d="M14 3v4h4M10 11l-2 2 2 2M14 11l2 2-2 2" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  img:     '<svg viewBox="0 0 24 24" fill="none"><rect x="4" y="5" width="16" height="14" rx="2" stroke="currentColor" stroke-width="1.5"/><circle cx="9" cy="10" r="1.6" fill="currentColor"/><path d="M5 17l4-4 3 3 3-3 4 4" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/></svg>',
  data:    '<svg viewBox="0 0 24 24" fill="none"><ellipse cx="12" cy="6" rx="7" ry="2.6" stroke="currentColor" stroke-width="1.5"/><path d="M5 6v12c0 1.4 3.1 2.6 7 2.6s7-1.2 7-2.6V6M5 12c0 1.4 3.1 2.6 7 2.6s7-1.2 7-2.6" stroke="currentColor" stroke-width="1.5"/></svg>',
  archive: '<svg viewBox="0 0 24 24" fill="none"><rect x="4" y="4" width="16" height="16" rx="2" stroke="currentColor" stroke-width="1.5"/><path d="M12 4v3M12 9v2M12 13v2" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>',
};

let puter; // resolved in boot()

// =================================================================================================
// FILES
// =================================================================================================
function setFileView(view) {
  state.fileView = view === "grid" ? "grid" : "list";
  els.app.dataset.fileview = state.fileView;
  els.viewList.classList.toggle("is-active", state.fileView === "list");
  els.viewGrid.classList.toggle("is-active", state.fileView === "grid");
  if (els.setViewList) els.setViewList.classList.toggle("is-active", state.fileView === "list");
  if (els.setViewGrid) els.setViewGrid.classList.toggle("is-active", state.fileView === "grid");
}

function renderCrumbs() {
  els.crumbs.innerHTML = "";
  // Build segments from HOME down to cwd. HOME shows as "Home".
  const rel = state.cwd === HOME ? "" : state.cwd.slice(HOME.length).replace(/^\//, "");
  const parts = rel ? rel.split("/") : [];
  const mk = (label, path, isCurrent) => {
    const b = document.createElement("button");
    b.className = "crumb" + (isCurrent ? " is-current" : "");
    b.textContent = label;
    b.title = path;
    if (!isCurrent) b.addEventListener("click", () => { state.cwd = path; state.selected = null; refreshFiles(); });
    return b;
  };
  els.crumbs.appendChild(mk("Home", HOME, parts.length === 0));
  let acc = HOME;
  parts.forEach((seg, i) => {
    const sep = document.createElement("span");
    sep.className = "crumb-sep"; sep.textContent = "/";
    els.crumbs.appendChild(sep);
    acc = acc + "/" + seg;
    els.crumbs.appendChild(mk(seg, acc, i === parts.length - 1));
  });
}

function syncSidebar() {
  els.sideHome.classList.toggle("is-active", state.cwd === HOME);
  els.sideNotes.classList.toggle("is-active", state.cwd === NOTES_DIR);
}

async function refreshFiles() {
  renderCrumbs();
  syncSidebar();
  els.btnUp.disabled = state.cwd === HOME || state.cwd === "/";
  els.btnUp.style.opacity = els.btnUp.disabled ? ".4" : "";

  let entries;
  try {
    entries = await puter.fs.readdir(state.cwd);
  } catch (e) {
    toast("Could not read " + state.cwd + ": " + errText(e), "err");
    return;
  }
  const list = (Array.isArray(entries) ? entries : []).map(normalizeEntry);
  list.sort((a, b) => (state.foldersFirst ? (b.is_dir - a.is_dir) : 0) || a.name.localeCompare(b.name, undefined, { numeric: true }));

  const folders = list.filter((e) => e.is_dir).length;
  els.statItems.textContent = String(list.length);
  els.statFolders.textContent = String(folders);
  els.statFiles.textContent = String(list.length - folders);

  els.filelist.innerHTML = "";
  els.filesEmpty.hidden = list.length > 0;

  list.forEach((ent, idx) => {
    const li = document.createElement("li");
    li.className = "file" + (ent.is_dir ? " is-dir" : "") + (state.selected === ent.name ? " is-selected" : "");
    li.dataset.name = ent.name;
    li.dataset.dir = ent.is_dir ? "1" : "0";
    li.style.animationDelay = Math.min(idx * 12, 160) + "ms";

    const kind = fileKind(ent.name, ent.is_dir);

    const cell = document.createElement("div");
    cell.className = "cell-name";
    const icon = document.createElement("span");
    icon.className = "ficon " + kind.cls;
    icon.innerHTML = kind.svg;
    const name = document.createElement("span");
    name.className = "name" + (ent.is_dir ? " dir" : "");
    name.textContent = ent.name;
    name.title = ent.name;
    cell.append(icon, name);

    const kindCell = document.createElement("span");
    kindCell.className = "kind";
    kindCell.textContent = kind.label;

    const size = document.createElement("span");
    size.className = "size";
    size.textContent = ent.is_dir ? "—" : fmtSize(ent.size);

    const actions = document.createElement("span");
    actions.className = "row-actions";
    const rn = mkIconBtn(SVG_RENAME, "Rename", () => renameEntry(ent));
    const del = mkIconBtn(SVG_DELETE, "Delete", () => deleteEntry(ent), true);
    actions.append(rn, del);

    // selection + open behavior
    li.addEventListener("click", (e) => {
      if (e.target.closest(".row-actions")) return;
      selectFile(ent.name);
    });
    const open = () => {
      if (ent.is_dir) { state.cwd = joinPath(state.cwd, ent.name); state.selected = null; refreshFiles(); }
      else openInNotes(joinPath(state.cwd, ent.name));
    };
    li.addEventListener("dblclick", (e) => { if (!e.target.closest(".row-actions")) open(); });
    if (ent.is_dir) cell.addEventListener("click", (e) => { e.stopPropagation(); open(); });
    else cell.addEventListener("click", (e) => { e.stopPropagation(); open(); });

    li.append(cell, kindCell, size, actions);
    els.filelist.appendChild(li);
  });
}

function selectFile(name) {
  state.selected = name;
  $$(".file").forEach((li) => li.classList.toggle("is-selected", li.dataset.name === name));
}

const SVG_RENAME = '<svg viewBox="0 0 24 24" fill="none"><path d="M4 16.5V20h3.5L18 9.5 14.5 6zM13 7.5 16.5 11" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/></svg>';
const SVG_DELETE = '<svg viewBox="0 0 24 24" fill="none"><path d="M5 7h14M10 7V5h4v2M6 7l1 13h10l1-13M10 11v6M14 11v6" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>';

function mkIconBtn(svg, title, onClick, danger) {
  const b = document.createElement("button");
  b.className = "icon-btn" + (danger ? " danger" : "");
  b.innerHTML = svg;
  b.title = title;
  b.setAttribute("aria-label", title);
  b.addEventListener("click", (e) => { e.stopPropagation(); onClick(); });
  return b;
}

function normalizeEntry(e) {
  return {
    name: e.name ?? e.path?.split("/").pop() ?? "(unknown)",
    is_dir: !!(e.is_dir ?? e.isDirectory),
    size: e.size ?? 0,
    modified: e.modified ?? e.mtime ?? 0,
    path: e.path ?? joinPath(state.cwd, e.name ?? ""),
  };
}

async function newFolder() {
  const name = await promptModal("New folder", "untitled-folder", { desc: "Create a folder in " + state.cwd, okLabel: "Create" });
  if (!name) return;
  try {
    await puter.fs.mkdir(joinPath(state.cwd, name));
    toast("Folder created · " + name, "ok");
    state.selected = name;
    await refreshFiles();
  } catch (e) { toast("Couldn't create folder: " + errText(e), "err"); }
}

async function newFile() {
  const name = await promptModal("New file", "untitled.txt", { desc: "Create a file in " + state.cwd, okLabel: "Create" });
  if (!name) return;
  const path = joinPath(state.cwd, name);
  try {
    await puter.fs.write(path, new Blob([""], { type: "text/plain" }), { overwrite: false });
    toast("File created · " + name, "ok");
    state.selected = name;
    await refreshFiles();
    openInNotes(path);
  } catch (e) { toast("Couldn't create file: " + errText(e), "err"); }
}

async function renameEntry(ent) {
  const next = await promptModal("Rename", ent.name, { desc: "Rename “" + ent.name + "”", okLabel: "Rename" });
  if (!next || next === ent.name) return;
  try {
    await puter.fs.rename(joinPath(state.cwd, ent.name), next);
    toast("Renamed to " + next, "ok");
    state.selected = next;
    await refreshFiles();
  } catch (e) { toast("Rename failed: " + errText(e), "err"); }
}

async function deleteEntry(ent) {
  const ok = await promptModal("Delete “" + ent.name + "”?", "", {
    desc: "This permanently removes it from Vita's store. Type DELETE to confirm.",
    okLabel: "Delete", danger: true,
  });
  if (ok !== "DELETE") { if (ok !== null) toast("Delete cancelled — type DELETE to confirm"); return; }
  try {
    await puter.fs.delete(joinPath(state.cwd, ent.name), { recursive: true });
    toast("Deleted " + ent.name, "ok");
    if (state.selected === ent.name) state.selected = null;
    await refreshFiles();
    if (state.cwd === NOTES_DIR || joinPath(state.cwd, ent.name) === NOTES_DIR) refreshNoteList();
  } catch (e) { toast("Delete failed: " + errText(e), "err"); }
}

// =================================================================================================
// VIEW SWITCHING
// =================================================================================================
function switchTo(view) {
  els.app.dataset.view = view;
  $$(".tab").forEach((t) => {
    const on = t.dataset.view === view;
    t.classList.toggle("is-active", on);
    t.setAttribute("aria-selected", on ? "true" : "false");
  });
  $$(".view").forEach((v) => v.classList.toggle("is-active", v.dataset.view === view));
  if (view === "files") refreshFiles();
  if (view === "notes") { refreshNoteList(); if (els.noteBody) els.noteBody.focus(); }
}

// =================================================================================================
// NOTES — a real editor with a saved-notes list (everything under NOTES_DIR).
// =================================================================================================
async function refreshNoteList() {
  try { await puter.fs.mkdir(NOTES_DIR).catch(() => {}); } catch (_) {}
  let entries = [];
  try { entries = await puter.fs.readdir(NOTES_DIR); } catch (_) { entries = []; }
  state.notes = (Array.isArray(entries) ? entries : [])
    .map(normalizeEntry)
    .filter((e) => !e.is_dir)
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));

  els.notelist.innerHTML = "";
  els.notesEmpty.hidden = state.notes.length > 0;

  for (const n of state.notes) {
    const path = joinPath(NOTES_DIR, n.name);
    const li = document.createElement("li");
    li.className = "note-item" + (path === state.noteCurrent ? " is-active" : "");
    li.dataset.path = path;
    const name = document.createElement("div");
    name.className = "ni-name"; name.textContent = n.name; name.title = n.name;
    const meta = document.createElement("div");
    meta.className = "ni-meta";
    meta.textContent = fmtSize(n.size) + (n.modified ? " · " + fmtWhen(n.modified) : "");
    li.append(name, meta);
    li.addEventListener("click", () => openNote(path));
    els.notelist.appendChild(li);
  }
}

function markActiveNote() {
  $$(".note-item").forEach((li) => li.classList.toggle("is-active", li.dataset.path === state.noteCurrent));
}

function setNoteHeader(path) {
  els.noteTitle.textContent = baseName(path);
  els.noteTitle.title = baseName(path);
  els.notePath.textContent = path;
  els.notePath.title = path;
}

function setDirty(dirty) {
  state.noteDirty = dirty;
  els.noteDirty.hidden = !dirty;
  if (dirty) { els.noteStatus.textContent = "Unsaved"; els.noteStatus.className = "note-status"; }
}

function updateNoteMeta() {
  const t = els.noteBody.value;
  const words = t.trim() ? t.trim().split(/\s+/).length : 0;
  els.noteMeta.textContent = `${words} word${words === 1 ? "" : "s"} · ${t.length} char${t.length === 1 ? "" : "s"}`;
}

function openInNotes(path) {
  switchTo("notes");
  openNote(path);
}

async function openNote(path) {
  path = (path || state.noteCurrent || "").trim();
  if (!path) return;
  state.noteCurrent = path;
  setNoteHeader(path);
  markActiveNote();
  els.noteStatus.textContent = "Opening…";
  els.noteStatus.className = "note-status saving";
  try {
    const blob = await puter.fs.read(path);
    const text = await blobText(blob);
    els.noteBody.value = text;
    state.noteSavedText = text;
    els.noteStatus.textContent = "Opened";
    els.noteStatus.className = "note-status";
  } catch (e) {
    // A not-found file is fine — start a blank buffer the user can Save to create it.
    els.noteBody.value = "";
    state.noteSavedText = "";
    els.noteStatus.textContent = "New file";
    els.noteStatus.className = "note-status";
  }
  setDirty(false);
  updateNoteMeta();
}

async function newNote() {
  const name = await promptModal("New note", "note.txt", { desc: "Create a note in " + NOTES_DIR, okLabel: "Create" });
  if (!name) return;
  const path = joinPath(NOTES_DIR, name);
  els.noteBody.value = "";
  state.noteSavedText = "";
  state.noteCurrent = path;
  setNoteHeader(path);
  await saveNote(); // persist the empty file so it appears in the list immediately
  els.noteBody.focus();
}

async function saveNote() {
  const path = (state.noteCurrent || "").trim();
  if (!path) { toast("No note open", "err"); return; }
  els.noteStatus.textContent = "Saving…";
  els.noteStatus.className = "note-status saving";
  try {
    const dir = parentOf(path);
    if (dir !== "/") { try { await puter.fs.mkdir(dir); } catch (_) { /* exists */ } }
    await puter.fs.write(path, new Blob([els.noteBody.value], { type: "text/plain" }), { overwrite: true });
    state.noteSavedText = els.noteBody.value;
    els.noteStatus.textContent = "Saved";
    els.noteStatus.className = "note-status saved";
    setDirty(false);
    els.noteDirty.hidden = true;
    toast("Saved · " + baseName(path), "ok");
    await refreshNoteList();
  } catch (e) {
    els.noteStatus.textContent = "Save failed";
    els.noteStatus.className = "note-status err";
    toast("Save failed: " + errText(e), "err");
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
// SETTINGS (KV-backed) — theme, accent, default file view, folders-first
// =================================================================================================
const KV = {
  theme: "vita.desk.theme",
  accent: "vita.desk.accent",
  view: "vita.desk.fileview",
  foldersFirst: "vita.desk.foldersFirst",
};

async function loadSettings() {
  try {
    const [theme, accent, view, ff] = await Promise.all([
      puter.kv.get(KV.theme), puter.kv.get(KV.accent), puter.kv.get(KV.view), puter.kv.get(KV.foldersFirst),
    ]);
    applyTheme(theme || "dark", false);
    applyAccent(accent || "blue", false);
    setFileView(view === "grid" ? "grid" : "list");
    state.foldersFirst = ff == null ? true : ff === "true" || ff === true;
    els.toggleFoldersFirst.classList.toggle("is-on", state.foldersFirst);
    els.toggleFoldersFirst.setAttribute("aria-checked", String(state.foldersFirst));
  } catch (_) { /* first run: keys absent */ }
}

function applyTheme(theme, persist = true) {
  document.documentElement.dataset.theme = theme;
  $$("#theme-picker .swatch").forEach((s) => s.setAttribute("aria-checked", String(s.dataset.theme === theme)));
  if (persist) puter.kv.set(KV.theme, theme).then(() => toast("Theme · " + theme, "ok")).catch((e) => toast("Couldn't save theme: " + errText(e), "err"));
}
function applyAccent(accent, persist = true) {
  document.documentElement.dataset.accent = accent;
  $$("#accent-picker .dot").forEach((d) => d.setAttribute("aria-checked", String(d.dataset.accent === accent)));
  if (persist) puter.kv.set(KV.accent, accent).then(() => toast("Accent · " + accent, "ok")).catch((e) => toast("Couldn't save accent: " + errText(e), "err"));
}
function persistFileView(view) {
  setFileView(view);
  puter.kv.set(KV.view, view).catch((e) => toast("Couldn't save view: " + errText(e), "err"));
  refreshFiles();
}
function toggleFoldersFirst() {
  state.foldersFirst = !state.foldersFirst;
  els.toggleFoldersFirst.classList.toggle("is-on", state.foldersFirst);
  els.toggleFoldersFirst.setAttribute("aria-checked", String(state.foldersFirst));
  puter.kv.set(KV.foldersFirst, String(state.foldersFirst)).catch((e) => toast("Couldn't save: " + errText(e), "err"));
  refreshFiles();
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

  // files
  els.btnUp.addEventListener("click", () => { state.cwd = navParentOf(state.cwd); state.selected = null; refreshFiles(); });
  els.btnNewFolder.addEventListener("click", newFolder);
  els.btnNewFile.addEventListener("click", newFile);
  els.btnRefresh.addEventListener("click", () => { refreshFiles(); toast("Refreshed", "ok"); });
  els.viewList.addEventListener("click", () => persistFileView("list"));
  els.viewGrid.addEventListener("click", () => persistFileView("grid"));
  els.sideHome.addEventListener("click", () => { state.cwd = HOME; state.selected = null; refreshFiles(); });
  els.sideNotes.addEventListener("click", () => { state.cwd = NOTES_DIR; state.selected = null; refreshFiles(); });
  // empty-state shortcuts
  $$("#files-empty [data-act]").forEach((b) => b.addEventListener("click", () => (b.dataset.act === "newfolder" ? newFolder() : newFile())));

  // notes
  els.btnSave.addEventListener("click", saveNote);
  els.btnNewNote.addEventListener("click", newNote);
  els.noteBody.addEventListener("input", () => {
    updateNoteMeta();
    setDirty(els.noteBody.value !== state.noteSavedText);
  });

  // settings
  els.themePicker.addEventListener("click", (e) => { const s = e.target.closest(".swatch"); if (s) applyTheme(s.dataset.theme); });
  els.accentPicker.addEventListener("click", (e) => { const d = e.target.closest(".dot"); if (d) applyAccent(d.dataset.accent); });
  els.setViewList.addEventListener("click", () => persistFileView("list"));
  els.setViewGrid.addEventListener("click", () => persistFileView("grid"));
  els.toggleFoldersFirst.addEventListener("click", toggleFoldersFirst);

  // keyboard: Ctrl/Cmd-S saves in notes; Delete removes selection in files
  document.addEventListener("keydown", (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
      if (els.app.dataset.view === "notes") { e.preventDefault(); saveNote(); }
    }
  });
}

async function ensureSeedContent() {
  // On first run, seed a welcome note + the notes folder so the desktop is never empty (and the
  // verification has something to click). Idempotent: only writes if absent.
  try {
    await puter.fs.mkdir(HOME).catch(() => {});
    const root = await puter.fs.readdir(HOME).catch(() => []);
    const names = (Array.isArray(root) ? root : []).map((e) => e.name);
    if (!names.includes("notes")) await puter.fs.mkdir(NOTES_DIR).catch(() => {});
    const welcome = NOTES_DIR + "/welcome.txt";
    const notesEntries = await puter.fs.readdir(NOTES_DIR).catch(() => []);
    const exists = (Array.isArray(notesEntries) ? notesEntries : []).some((e) => e.name === "welcome.txt");
    if (!exists) {
      const body = [
        "Welcome to Vita Desk.",
        "",
        "This is a real, interactive app running on Vita's own api_origin.",
        "Try it out:",
        "  • Create a file or folder in Files",
        "  • Edit this note and press Ctrl/Cmd-S to save",
        "  • Pick a theme + accent in Settings",
        "",
        "Everything persists to /var/lib/vita/apps and survives a reload or reboot.",
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
  els.dbgToken.textContent = puter.authToken ? (String(puter.authToken).slice(0, 10) + "…") : "(none)";

  els.bootMsg.textContent = "Authenticating with api_origin…";
  try {
    const me = await puter.auth.whoami();
    const name = (me && (me.username || me.user?.username)) || "owner";
    els.whoName.textContent = name;
    els.whoAvatar.textContent = name.slice(0, 1) || "·";
    els.dbgUser.textContent = name;
    setConn("connected", "ok");
    els.dbgStatus.textContent = "Connected";
    els.dbgStatus.className = "badge ok";
  } catch (e) {
    setConn("auth failed", "err");
    els.dbgStatus.textContent = "Auth failed";
    els.dbgStatus.className = "badge err";
    els.dbgUser.textContent = "—";
    toast("whoami failed: " + errText(e), "err");
  }

  await loadSettings();
  await ensureSeedContent();
  await refreshFiles();
  await refreshNoteList();
  // Pre-open the welcome note so the editor is never blank on first paint.
  await openNote(state.noteCurrent).catch(() => {});

  els.app.dataset.state = "ready";
  document.title = "Vita Desk — ready";
  window.__vitaDeskReady = true;
}

function setConn(label, kind) {
  els.connLabel.textContent = label;
  els.conn.className = "conn" + (kind ? " " + kind : "");
}

function bootFail(msg) {
  els.bootMsg.textContent = "Could not start.";
  els.bootErr.hidden = false;
  els.bootErr.textContent = msg;
  setConn("offline", "err");
}

boot();
