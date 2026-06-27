// Vita Package Manager — client app (Vita's own code, AGPL-clean).
//
// Talks to the capability-gated META-API (/meta/*) on the local api_origin. The meta calls carry the
// vita.pkgmgr app-session bearer (injected by /session.js into puter.authToken), so the gate authorizes
// them on the `meta` capability — which ONLY this app holds. Every screen here is a thin view over a
// meta endpoint:
//   list      → GET  /meta/packages
//   detail    → GET  /meta/packages/:id
//   source    → GET  /meta/packages/:id/source         (browse tree)
//               GET  /meta/packages/:id/source/file     (read file)
//               POST /meta/packages/:id/source/file     (EDIT → rebuild)
//   perms     → GET  /meta/packages/:id/grants
//               POST /meta/packages/:id/grants          (grant|revoke|restrict)
//   activity  → GET  /meta/packages/:id/audit
//   disable   → POST /meta/packages/:id/disable | /enable

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

// Replace any freshly-inserted <i data-lucide> placeholders with their SVGs. Lucide's UMD bundle is
// vendored offline at /_vendor/lucide.min.js (window.lucide). Call after every dynamic render that
// injects icon markup; no-op if the bundle is somehow absent.
function icons() { if (window.lucide && typeof window.lucide.createIcons === "function") window.lucide.createIcons(); }

// The api_origin + bearer. /session.js sets window.puter.authToken + APIOrigin; mirror them here.
function apiOrigin() {
  return (window.__vitaSession && window.__vitaSession.apiOrigin) || (window.location.origin + "/api");
}
function authToken() {
  return (window.puter && window.puter.authToken) || "";
}

// A meta-API fetch. Carries the bearer so the gate authorizes on `meta`. Returns parsed JSON; throws an
// Error carrying the HTTP status + the server's error code on a non-2xx (so callers can show 403, etc.).
async function meta(path, init = {}) {
  // Bound every meta call so an unreachable/wedged meta plane can never hang the UI. On timeout/network
  // failure we throw a `disconnected`-tagged error the list/detail renderers turn into a clean state.
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 6000);
  let res;
  try {
    res = await fetch(apiOrigin() + path, {
      ...init,
      signal: ctrl.signal,
      headers: {
        authorization: "Bearer " + authToken(),
        ...(init.body ? { "content-type": "application/json" } : {}),
        ...(init.headers || {}),
      },
    });
  } catch (e) {
    const err = new Error(e && e.name === "AbortError" ? "meta plane timed out" : "meta plane unreachable");
    err.disconnected = true;
    throw err;
  } finally {
    clearTimeout(timer);
  }
  let data = null;
  try { data = await res.json(); } catch { /* non-json */ }
  if (!res.ok) {
    const code = (data && (data.code || (data.error && data.error.code))) || String(res.status);
    const msg = (data && (data.message || (data.error && data.error.message))) || res.statusText;
    const err = new Error(`${code}: ${msg}`);
    err.status = res.status;
    err.code = code;
    // A 404 means no meta plane is mounted on this api_origin (browser-only / no permission control plane
    // here). Treat it as "not connected" so the app shows a clean state, not a hard error.
    if (res.status === 404) err.disconnected = true;
    throw err;
  }
  return data;
}

const GRANTABLE = ["fs.read", "fs.write", "kv.read", "kv.write", "ui", "auth"];

const state = {
  packages: [],
  selectedId: null,
  selected: null,
  openFile: null,     // { path, content, digest }
  treePath: "/",
};

// ----------------------------------------------------------------------------------------------
// Boot.
// ----------------------------------------------------------------------------------------------
async function boot() {
  wireTabs();
  wireActions();
  icons(); // paint the static chrome icons (brand, refresh, tab labels, empty glyph) on first load.
  try {
    // whoami (proves the meta token authenticates). The data plane's /whoami is gated on `auth`, which
    // the pkgmgr app also holds — a cheap connectivity proof.
    const who = await fetchWhoami();
    $("#who-name").textContent = who && who.username ? who.username : "owner";
    $("#conn").textContent = "connected";
    $("#conn").classList.add("ok");
  } catch (e) {
    $("#conn").textContent = "offline";
    $("#conn").classList.add("err");
  }
  // Load the package list. NEVER let a failed load leave the app wedged in "booting": the meta plane may
  // be absent (no /meta/* mounted in this context) or unreachable, in which case loadPackages() renders a
  // clean "not connected" empty state with a Retry. Either way the app reaches a settled `ready` state —
  // no infinite spinner. (Before: a throw here left dataset.state === "booting" forever.)
  await loadPackages();
  $("#app").dataset.state = "ready";
  window.__vitaPkgMgrReady = true;
}

async function fetchWhoami() {
  const res = await fetch(apiOrigin() + "/whoami", { headers: { authorization: "Bearer " + authToken() } });
  return res.ok ? res.json() : null;
}

// ----------------------------------------------------------------------------------------------
// 1) LIST installed packages.
// ----------------------------------------------------------------------------------------------
async function loadPackages() {
  const ul = $("#pkg-list");
  try {
    const data = await meta("/meta/packages");
    state.packages = (data && data.packages) || [];
    if (state.packages.length === 0) {
      ul.innerHTML = '<li class="pkg-state"><div class="empty">No packages installed.</div></li>';
      return;
    }
    renderList();
  } catch (e) {
    // Unreachable / unmounted meta plane → a clean state with Retry, NOT a wedged spinner. A real error
    // the plane answered is shown inline too. Either way boot() continues to `ready`.
    state.packages = [];
    const reason = e && e.disconnected ? "Permission control plane not connected." : ("Could not load packages: " + e.message);
    ul.innerHTML =
      '<li class="pkg-state"><div class="empty">' +
        '<div style="margin-bottom:12px">' + esc(reason) + '</div>' +
        '<button class="btn" id="pkg-retry" type="button">Retry</button>' +
      '</div></li>';
    const rb = document.getElementById("pkg-retry");
    if (rb) rb.addEventListener("click", () => { ul.innerHTML = ""; loadPackages(); });
  }
}

function renderList() {
  const ul = $("#pkg-list");
  ul.innerHTML = "";
  for (const p of state.packages) {
    const li = document.createElement("li");
    li.className = "pkg" + (p.id === state.selectedId ? " is-selected" : "") + (p.state === "disabled" ? " is-disabled" : "");
    li.dataset.id = p.id;
    li.setAttribute("role", "option");
    const grantCount = (p.granted || []).length;
    const reqCount = (p.requested || []).length;
    li.innerHTML = `
      <div class="pkg-row">
        <span class="pkg-name">${esc(p.name)}</span>
        <span class="pkg-ver">v${esc(p.version)}</span>
      </div>
      <div class="pkg-meta">
        <code class="pkg-id">${esc(p.id)}</code>
      </div>
      <div class="pkg-badges">
        <span class="badge badge-src" title="raw source on device — not compiled">src</span>
        <span class="badge" title="granted / requested capabilities">${grantCount}/${reqCount} caps</span>
        ${p.denialCount > 0 ? `<span class="badge badge-deny" title="capability denials">${p.denialCount} denied</span>` : ""}
        ${p.state === "disabled" ? `<span class="badge badge-off">disabled</span>` : ""}
      </div>`;
    li.addEventListener("click", () => selectPackage(p.id));
    ul.appendChild(li);
  }
  icons();
}

async function selectPackage(id) {
  state.selectedId = id;
  state.openFile = null;
  state.treePath = "/";
  renderList();
  $("#detail-empty").hidden = true;
  $("#detail").hidden = false;
  const p = await meta("/meta/packages/" + encodeURIComponent(id));
  state.selected = p;
  renderDetail(p);
  await Promise.all([loadTree("/"), loadPerms(), loadAudit()]);
}

function renderDetail(p) {
  $("#d-name").textContent = p.name;
  $("#d-version").textContent = "v" + p.version;
  $("#d-desc").textContent = p.description || "";
  $("#d-source-dir").textContent = p.sourceDir;
  const st = $("#d-state");
  st.textContent = p.state;
  st.classList.toggle("pill-off", p.state === "disabled");
  $("#btn-disable").hidden = p.state === "disabled";
  $("#btn-enable").hidden = p.state !== "disabled";
  // Reset editor.
  $("#editor").value = "";
  $("#editor").disabled = true;
  $("#editor-path").textContent = "select a file";
  $("#editor-status").textContent = "";
  $("#btn-save").disabled = true;
  icons();
}

// ----------------------------------------------------------------------------------------------
// 2) SOURCE TRANSPARENCY + EDIT.
// ----------------------------------------------------------------------------------------------
async function loadTree(path) {
  state.treePath = path;
  const data = await meta("/meta/packages/" + encodeURIComponent(state.selectedId) + "/source?path=" + encodeURIComponent(path));
  $("#tree-path").textContent = path;
  const ul = $("#tree");
  ul.innerHTML = "";
  if (path !== "/") {
    const up = document.createElement("li");
    up.className = "tnode tnode-up";
    up.innerHTML = `<span class="tnode-icon"><i data-lucide="arrow-up"></i></span><span class="tnode-name">..</span>`;
    up.addEventListener("click", () => loadTree(parentOf(path)));
    ul.appendChild(up);
  }
  for (const node of (data.nodes || [])) {
    const li = document.createElement("li");
    li.className = "tnode tnode-" + node.kind;
    li.dataset.path = node.path;
    const icon = node.kind === "dir" ? "folder" : "file-code";
    li.innerHTML = `<span class="tnode-icon"><i data-lucide="${icon}"></i></span><span class="tnode-name">${esc(node.name)}</span>` +
      (node.kind === "file" ? `<span class="tnode-size">${node.size}B</span>` : "");
    li.addEventListener("click", () => node.kind === "dir" ? loadTree(node.path) : openFile(node.path));
    ul.appendChild(li);
  }
  icons();
}

async function openFile(path) {
  const data = await meta("/meta/packages/" + encodeURIComponent(state.selectedId) + "/source/file?path=" + encodeURIComponent(path));
  state.openFile = { path: data.path, content: data.content, digest: data.digest };
  $$(".tnode").forEach((n) => n.classList.toggle("is-open", n.dataset.path === path));
  const ed = $("#editor");
  ed.value = data.content;
  ed.disabled = state.selected && state.selected.state === "disabled";
  $("#editor-path").textContent = path;
  $("#editor-status").textContent = "digest " + data.digest;
  $("#btn-save").disabled = ed.disabled;
  icons();
}

async function saveFile() {
  if (!state.openFile) return;
  const content = $("#editor").value;
  $("#editor-status").textContent = "saving…";
  $("#btn-save").disabled = true;
  try {
    const res = await meta("/meta/packages/" + encodeURIComponent(state.selectedId) + "/source/file", {
      method: "POST",
      body: JSON.stringify({ path: state.openFile.path, content }),
    });
    state.openFile.digest = res.digest;
    $("#editor-status").textContent = `saved · ${res.bytes}B · digest ${res.digest} · ${res.rebuilt ? "rebuilt ✓" : "rebuild?"} (${esc(res.rebuildStatus || "")})`;
    $("#editor-status").classList.add("ok");
    setTimeout(() => $("#editor-status").classList.remove("ok"), 1500);
  } catch (e) {
    $("#editor-status").textContent = "save failed — " + e.message;
    $("#editor-status").classList.add("err");
  } finally {
    $("#btn-save").disabled = false;
  }
}

// ----------------------------------------------------------------------------------------------
// 3) PERMISSIONS.
// ----------------------------------------------------------------------------------------------
async function loadPerms() {
  const g = await meta("/meta/packages/" + encodeURIComponent(state.selectedId) + "/grants");
  const requested = new Set(g.requested || []);
  const granted = new Set(g.granted || []);
  const body = $("#perm-body");
  body.innerHTML = "";
  // Show every grantable capability the package requested OR currently holds.
  const rows = GRANTABLE.filter((c) => requested.has(c) || granted.has(c));
  for (const cap of rows) {
    const isReq = requested.has(cap);
    const isGr = granted.has(cap);
    const tr = document.createElement("tr");
    tr.dataset.cap = cap;
    tr.innerHTML = `
      <td><code>${cap}</code></td>
      <td>${isReq ? `<span class="perm-req-yes"><i data-lucide="check"></i></span>` : `<span class="perm-req-no">—</span>`}</td>
      <td class="cell-granted">${isGr ? `<span class="granted-yes"><i data-lucide="check"></i>granted</span>` : `<span class="granted-no">denied</span>`}</td>
      <td class="cell-action"></td>`;
    const action = tr.querySelector(".cell-action");
    if (isGr) {
      const b = mkBtn("Revoke", "btn-danger", () => changeGrant(cap, "revoke"));
      action.appendChild(b);
    } else if (isReq) {
      const b = mkBtn("Grant", "btn-ok", () => changeGrant(cap, "grant"));
      action.appendChild(b);
    } else {
      action.textContent = "—";
    }
    body.appendChild(tr);
  }
  icons();
}

async function changeGrant(capability, action) {
  $("#perm-status").textContent = `${action} ${capability}…`;
  try {
    await meta("/meta/packages/" + encodeURIComponent(state.selectedId) + "/grants", {
      method: "POST",
      body: JSON.stringify({ capability, action }),
    });
    $("#perm-status").textContent = `${action} ${capability} ✓ — enforced on the package's next call`;
    $("#perm-status").className = "perm-status ok";
    await loadPerms();
    await loadPackages(); // refresh the badge counts in the list
  } catch (e) {
    $("#perm-status").textContent = `failed: ${e.message}`;
    $("#perm-status").className = "perm-status err";
  }
}

// ----------------------------------------------------------------------------------------------
// 4) ACTIVITY / AUDIT.
// ----------------------------------------------------------------------------------------------
async function loadAudit() {
  const a = await meta("/meta/packages/" + encodeURIComponent(state.selectedId) + "/audit?limit=200");
  const badge = $("#denial-badge");
  if (a.denialCount > 0) { badge.hidden = false; badge.textContent = a.denialCount + " denials"; }
  else { badge.hidden = true; }
  const ul = $("#audit");
  ul.innerHTML = "";
  const entries = (a.entries || []).slice().reverse(); // newest first
  if (entries.length === 0) {
    const li = document.createElement("li");
    li.className = "audit-empty";
    li.textContent = "No capability activity recorded yet.";
    ul.appendChild(li);
    return;
  }
  for (const e of entries) {
    const li = document.createElement("li");
    li.className = "audit-row audit-" + e.outcome;
    const oIcon = e.outcome === "deny" ? "shield-alert" : "check";
    li.innerHTML = `
      <span class="a-time">${new Date(e.at).toLocaleTimeString()}</span>
      <span class="a-outcome a-${e.outcome}"><i data-lucide="${oIcon}"></i>${e.outcome === "deny" ? "DENIED" : "allow"}</span>
      <span class="a-cap"><code>${esc(e.capability)}</code></span>
      <span class="a-op">${esc(e.operation || "")}</span>
      ${e.code ? `<span class="a-code">${esc(e.code)}</span>` : ""}`;
    ul.appendChild(li);
  }
  icons();
}

// ----------------------------------------------------------------------------------------------
// disable / enable (kill control).
// ----------------------------------------------------------------------------------------------
async function setDisabled(disabled) {
  const leaf = disabled ? "disable" : "enable";
  await meta("/meta/packages/" + encodeURIComponent(state.selectedId) + "/" + leaf, { method: "POST" });
  const p = await meta("/meta/packages/" + encodeURIComponent(state.selectedId));
  state.selected = p;
  renderDetail(p);
  await loadPackages();
}

// ----------------------------------------------------------------------------------------------
// Wiring + helpers.
// ----------------------------------------------------------------------------------------------
function wireTabs() {
  $$(".tabs .tab").forEach((tab) => {
    tab.addEventListener("click", () => {
      $$(".tabs .tab").forEach((t) => t.classList.toggle("is-active", t === tab));
      const which = tab.dataset.tab;
      $$(".panel").forEach((p) => p.classList.toggle("is-active", p.dataset.tab === which));
      if (which === "activity") loadAudit();
      if (which === "perms") loadPerms();
    });
  });
}

function wireActions() {
  $("#btn-refresh").addEventListener("click", () => loadPackages());
  $("#btn-save").addEventListener("click", () => saveFile());
  $("#btn-reload-audit").addEventListener("click", () => loadAudit());
  $("#btn-disable").addEventListener("click", () => confirmModal("Disable package", "Stop this package? Its capabilities stay denied until re-enabled.", () => setDisabled(true)));
  $("#btn-enable").addEventListener("click", () => setDisabled(false));
}

function mkBtn(label, cls, onClick) {
  const b = document.createElement("button");
  b.className = "btn " + cls + " btn-sm";
  b.textContent = label;
  b.addEventListener("click", onClick);
  return b;
}

function confirmModal(title, msg, onOk) {
  $("#modal-title").textContent = title;
  $("#modal-msg").textContent = msg;
  $("#modal").hidden = false;
  const ok = $("#modal-ok"), cancel = $("#modal-cancel");
  const close = () => { $("#modal").hidden = true; ok.removeEventListener("click", okH); cancel.removeEventListener("click", close); };
  const okH = () => { close(); onOk(); };
  ok.addEventListener("click", okH);
  cancel.addEventListener("click", close);
}

function parentOf(path) {
  if (path === "/" || path === "") return "/";
  const i = path.lastIndexOf("/");
  return i <= 0 ? "/" : path.slice(0, i);
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// puter.js initializes synchronously; /session.js applies the token. Boot once the DOM is ready.
if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", () => { boot().catch((e) => console.error("boot failed", e)); });
else boot().catch((e) => console.error("boot failed", e));
