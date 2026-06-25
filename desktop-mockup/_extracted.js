
/* =====================================================================================
   PSD desktop mockup runtime.
   The data shapes below mirror the merged source (see the header comment). The window
   manager logic mirrors sdk/typescript/src/wm/policy.ts; the chrome/launcher/notification
   logic mirrors sdk/typescript/src/shell/chrome/index.ts; the apps mirror
   sdk/typescript/src/apps/index.ts.
   ===================================================================================== */

/* ---------- Launcher app catalog (ChromeLauncherApp[]: id, name, subtitle, keywords) ---------- */
const APPS = [
  { id: "vita.app.settings",     name: "Settings",      subtitle: "System & control plane", glyph: "g-settings", icon: "⚙", keywords: ["preferences","config","control plane"], opens: "settings" },
  { id: "vita.app.file-manager", name: "Files",         subtitle: "Capability-scoped",       glyph: "g-files",    icon: "🗂", keywords: ["explorer","folder","fs"], opens: "files" },
  { id: "vita.shell.inspector",  name: "Shell config",  subtitle: "Composite TSX layout",    glyph: "g-shell",    icon: "❖", keywords: ["layout","components","registry","fallback"], opens: "shell" },
  { id: "vita.app.terminal",     name: "Terminal",      subtitle: "agentd console",          glyph: "g-terminal", icon: "›_", keywords: ["shell","console","tty"], opens: "placeholder" },
  { id: "vita.app.monitor",      name: "Node monitor",  subtitle: "Capsules & cgroups",      glyph: "g-monitor",  icon: "▤", keywords: ["system","resources","processes","health"], opens: "placeholder" },
  { id: "vita.app.web",          name: "Web",           subtitle: "CEF surface",             glyph: "g-web",      icon: "◍", keywords: ["browser","cef","chromium"], opens: "placeholder" },
  { id: "vita.app.text",         name: "Text editor",   subtitle: "TSX app",                 glyph: "g-text",     icon: "¶", keywords: ["edit","notes","code"], opens: "placeholder" },
  { id: "vita.app.network",      name: "Network",       subtitle: "Grants & egress",         glyph: "g-network",  icon: "⇄", keywords: ["wifi","mesh","firewall","netns"], opens: "placeholder" },
];

/* ---------- WM model (mirrors wm/policy.ts: windows/workspaces/focusStack) ---------- */
const WS = ["workspace-1", "workspace-2", "workspace-3"];
const state = {
  activeWorkspaceId: "workspace-1",
  workspaceLayout: { "workspace-1": "tile", "workspace-2": "tile", "workspace-3": "tile" }, // "tile" | "stack"
  windows: [],        // {id, appId, title, glyph, icon, workspaceId, rect, mode, minimized, maximized, order, render}
  focusStack: [],     // most-recent-first window ids
  order: 0,
};
const STAGE = () => document.getElementById("stage");
const stageBounds = () => { const r = STAGE().getBoundingClientRect(); return { x: 0, y: 0, width: r.width, height: r.height }; };

/* ---------- Settings managed config (apps/index.ts: categories -> widgets) ---------- */
const settingsConfig = {
  revision: "rev-7",
  categories: [
    { id: "appearance", title: "Appearance", icon: "◑", settings: [
      { id: "dark-mode",   label: "Dark mode",            sub: "Composite shell theme",        kind: "toggle", value: true },
      { id: "accent",      label: "Accent color",         sub: "CSS custom property",          kind: "text",   value: "teal" },
      { id: "panel-edge",  label: "Panel edge",           sub: "top | bottom (chrome panel)",  kind: "text",   value: "top" },
      { id: "anim-ms",     label: "Animation budget (ms)",sub: "WM reposition transition",     kind: "number", value: 160 },
    ]},
    { id: "display", title: "Display", icon: "▭", settings: [
      { id: "scale",       label: "Scale factor",         sub: "HiDPI",                        kind: "number", value: 1 },
      { id: "refresh",     label: "Refresh rate (Hz)",    sub: "Compositor frame budget",      kind: "number", value: 60 },
      { id: "vsync",       label: "VSync",                sub: "Tear-free compositing",        kind: "toggle", value: true },
    ]},
    { id: "windows", title: "Windows", icon: "◳", settings: [
      { id: "default-tile",label: "Tile by default",      sub: "New windows enter tiled mode", kind: "toggle", value: true },
      { id: "gap",         label: "Tiling gap (px)",      sub: "layout() inset",               kind: "number", value: 10 },
      { id: "focus-follow",label: "Focus follows mouse",  sub: "Pointer focus policy",         kind: "toggle", value: false },
    ]},
    { id: "network", title: "Network", icon: "⇄", settings: [
      { id: "mesh",        label: "Mesh networking",      sub: "Per-capsule netns",            kind: "toggle", value: true },
      { id: "egress",      label: "Default-deny egress",  sub: "Grants required",              kind: "toggle", value: true },
      { id: "hostname",    label: "Node name",            sub: "Identity",                     kind: "text",   value: "borg51" },
    ]},
    { id: "security", title: "Security & trust", icon: "🛡", settings: [
      { id: "secureboot",  label: "Secure Boot",          sub: "Enforced (read-only)",         kind: "toggle", value: true },
      { id: "verity",      label: "dm-verity rootfs",     sub: "Enforced (read-only)",         kind: "toggle", value: true },
      { id: "auto-update", label: "Automatic updates",    sub: "RAUC A/B",                     kind: "toggle", value: true },
    ]},
    { id: "about", title: "About", icon: "ⓘ", settings: [
      { id: "os",          label: "OS",                   sub: "",                             kind: "text",   value: "Vita node OS" },
      { id: "channel",     label: "Update channel",       sub: "",                             kind: "text",   value: "stable" },
      { id: "shell-rev",   label: "Shell revision",       sub: "ManagedShellConfigController",  kind: "text",   value: "configured" },
    ]},
  ],
};

/* ---------- File-manager fake filesystem (FilesEntry: name, kind, size, mtime) ---------- */
const FS = {
  "/": [
    { name: "home",        kind: "dir",  size: 0,     mtime: "2026-06-20 09:12" },
    { name: "etc",         kind: "dir",  size: 0,     mtime: "2026-06-18 22:40" },
    { name: "var",         kind: "dir",  size: 0,     mtime: "2026-06-24 04:01" },
    { name: "capsules",    kind: "dir",  size: 0,     mtime: "2026-06-23 17:55" },
    { name: "os-release",  kind: "file", size: 412,   mtime: "2026-06-15 00:00" },
    { name: "fstab.lock",  kind: "symlink-skipped", size: 0, mtime: "2026-06-15 00:00" },
  ],
  "/home": [
    { name: "..",          kind: "dir",  size: 0,     mtime: "" },
    { name: "lewis",       kind: "dir",  size: 0,     mtime: "2026-06-24 03:30" },
  ],
  "/home/lewis": [
    { name: "..",          kind: "dir",  size: 0,     mtime: "" },
    { name: "Documents",   kind: "dir",  size: 0,     mtime: "2026-06-22 14:08" },
    { name: "Pictures",    kind: "dir",  size: 0,     mtime: "2026-06-19 08:21" },
    { name: "notes.md",    kind: "file", size: 2048,  mtime: "2026-06-24 02:55" },
    { name: "shell.tsx",   kind: "file", size: 7711,  mtime: "2026-06-24 03:30" },
    { name: "id_secret",   kind: "symlink-skipped", size: 0, mtime: "2026-06-10 00:00" },
  ],
  "/capsules": [
    { name: "..",          kind: "dir",  size: 0,     mtime: "" },
    { name: "settings.ts.capsule",  kind: "file", size: 18432, mtime: "2026-06-21 11:00" },
    { name: "files.wasm.capsule",   kind: "file", size: 40960, mtime: "2026-06-21 11:00" },
    { name: "web.oci.capsule",      kind: "file", size: 1048576, mtime: "2026-06-21 11:00" },
  ],
};
function fsList(path) {
  if (FS[path]) return FS[path];
  // forbidden / unknown -> fail closed (mirrors fail-closed file manager)
  return null;
}

/* ===================================================================================== */
/* WINDOW MANAGER (mirrors wm/policy.ts)                                                  */
/* ===================================================================================== */

function focusFirst(windowId) {
  state.focusStack = [windowId, ...state.focusStack.filter(id => id !== windowId)];
}

function openWindow(appId) {
  const app = APPS.find(a => a.id === appId) || APPS.find(a => a.opens === appId);
  const def = app || { id: appId, name: appId, glyph: "g-terminal", icon: "□", opens: "placeholder" };
  const winId = "window:" + def.id;
  // de-dupe: focus existing
  const existing = state.windows.find(w => w.id === winId);
  if (existing) {
    existing.minimized = false;
    existing.workspaceId = state.activeWorkspaceId;
    focusFirst(winId);
    render();
    return;
  }
  const n = state.windows.length;
  const rect = {
    x: 60 + (n % 4) * 46, y: 40 + (n % 4) * 38,
    width: def.opens === "files" ? 560 : def.opens === "shell" ? 540 : 520,
    height: def.opens === "files" ? 420 : def.opens === "shell" ? 400 : 400,
  };
  const win = {
    id: winId, appId: def.id, title: titleFor(def), glyph: def.glyph, icon: def.icon,
    workspaceId: state.activeWorkspaceId,
    rect,
    mode: "tiled",                 // new windows enter tiled (default-tile)
    minimized: false, maximized: false,
    order: state.order++,
    kind: def.opens || "placeholder",
  };
  state.windows.push(win);
  focusFirst(winId);
  render();
}

function titleFor(def) {
  if (def.opens === "settings") return "Settings";
  if (def.opens === "files") return "Files — /home/lewis";
  if (def.opens === "shell") return "Shell config";
  return def.name;
}

function closeWindow(winId) {
  state.windows = state.windows.filter(w => w.id !== winId);
  state.focusStack = state.focusStack.filter(id => id !== winId);
  render();
}
function minimizeWindow(winId) {
  const w = state.windows.find(x => x.id === winId); if (!w) return;
  w.minimized = true;
  state.focusStack = state.focusStack.filter(id => id !== winId);
  render();
}
function maximizeWindow(winId) {
  const w = state.windows.find(x => x.id === winId); if (!w) return;
  w.maximized = !w.maximized; w.minimized = false;
  focusFirst(winId);
  render();
}
function setWorkspaceLayout(mode) {
  state.workspaceLayout[state.activeWorkspaceId] = mode;
  render();
}
function switchWorkspace(wsId) {
  state.activeWorkspaceId = wsId;
  render();
}

/* visible windows on the active workspace, sorted by open order (compareWindows) */
function visibleWindows() {
  return state.windows
    .filter(w => w.workspaceId === state.activeWorkspaceId && !w.minimized)
    .sort((a, b) => a.order - b.order);
}

/* focusedWindowId: first entry of focusStack visible on the active workspace */
function focusedWindowId() {
  for (const id of state.focusStack) {
    const w = state.windows.find(x => x.id === id);
    if (w && w.workspaceId === state.activeWorkspaceId && !w.minimized) return id;
  }
  const vis = visibleWindows();
  return vis.length ? vis[vis.length - 1].id : null;
}

/*
 * layout() — pure geometry, mirrors wm/policy.ts.
 * tile  => master pane (left half) + vertical stack of the rest (right half).
 * stack => every tiled window fills the content rect.
 * floating windows keep their own rect (fit into bounds); maximized fills bounds.
 */
function layoutRects() {
  const bounds = stageBounds();
  const gap = 10;
  const mode = state.workspaceLayout[state.activeWorkspaceId];
  const vis = visibleWindows();
  const rects = new Map();

  const maximized = vis.filter(w => w.maximized);
  const rest = vis.filter(w => !w.maximized);
  const tiled = rest.filter(w => w.mode === "tiled");
  const floating = rest.filter(w => w.mode === "floating");

  const content = { x: bounds.x + gap, y: bounds.y + gap, width: bounds.width - gap * 2, height: bounds.height - gap * 2 };

  if (mode === "stack") {
    for (const w of tiled) rects.set(w.id, { ...content });
  } else {
    if (tiled.length === 1) {
      rects.set(tiled[0].id, { ...content });
    } else if (tiled.length > 1) {
      const splitGap = gap;
      const masterW = Math.floor((content.width - splitGap) / 2);
      const stackW = content.width - splitGap - masterW;
      rects.set(tiled[0].id, { x: content.x, y: content.y, width: masterW, height: content.height });
      const stackWins = tiled.slice(1);
      const each = (content.height - splitGap * (stackWins.length - 1)) / stackWins.length;
      let y = content.y;
      stackWins.forEach(w => {
        rects.set(w.id, { x: content.x + masterW + splitGap, y: Math.round(y), width: stackW, height: Math.round(each) });
        y += each + splitGap;
      });
    }
  }
  // floating: keep own rect, clamped into bounds
  for (const w of floating) {
    const r = w.rect;
    const width = Math.min(r.width, bounds.width), height = Math.min(r.height, bounds.height);
    rects.set(w.id, {
      x: Math.max(0, Math.min(r.x, bounds.width - width)),
      y: Math.max(0, Math.min(r.y, bounds.height - height)),
      width, height,
    });
  }
  for (const w of maximized) rects.set(w.id, { ...bounds });
  return rects;
}

/* z-index from focusStack (focused on top), mirroring zIndexByWindowId */
function zIndexFor(winId, vis) {
  const ordered = [];
  for (const w of vis) if (!state.focusStack.includes(w.id)) ordered.push(w.id);
  for (let i = state.focusStack.length - 1; i >= 0; i--) {
    const id = state.focusStack[i];
    if (vis.find(w => w.id === id) && !ordered.includes(id)) ordered.push(id);
  }
  return ordered.indexOf(winId);
}

/* ===================================================================================== */
/* RENDER                                                                                 */
/* ===================================================================================== */

function render() {
  renderPanel();
  renderWindows();
  renderWorkspaces();
}

function renderWindows() {
  const stage = STAGE();
  const rects = layoutRects();
  const vis = visibleWindows();
  const focused = focusedWindowId();
  const mode = state.workspaceLayout[state.activeWorkspaceId];

  // remove gone windows
  [...stage.children].forEach(el => {
    const id = el.dataset.winId;
    if (!vis.find(w => w.id === id)) el.remove();
  });

  for (const w of vis) {
    const r = rects.get(w.id);
    if (!r) continue;
    let el = stage.querySelector(`[data-win-id="${cssEsc(w.id)}"]`);
    if (!el) { el = buildWindowEl(w); stage.appendChild(el); }
    // reposition the surface — this is the cheap path (texture reposition, NO repaint)
    el.style.left = r.x + "px"; el.style.top = r.y + "px";
    el.style.width = r.width + "px"; el.style.height = r.height + "px";
    el.style.zIndex = 100 + zIndexFor(w.id, vis);
    el.classList.toggle("focused", w.id === focused);
    el.classList.toggle("tiled", w.mode === "tiled" && !w.maximized && !el.classList.contains("dragging"));
    const modeEl = el.querySelector(".win-mode");
    if (modeEl) modeEl.textContent = w.maximized ? "max" : (w.mode === "tiled" ? mode : "float");
  }
}

function buildWindowEl(w) {
  const el = document.createElement("div");
  el.className = "window";
  el.dataset.winId = w.id;
  el.innerHTML = `
    <div class="titlebar">
      <span class="win-icon ${w.glyph}">${w.icon}</span>
      <span class="win-title">${esc(w.title)}</span>
      <span class="win-mode"></span>
      <div class="win-ctrls">
        <button class="win-ctrl min" title="Minimize">—</button>
        <button class="win-ctrl max" title="Maximize / tile">▢</button>
        <button class="win-ctrl close" title="Close">✕</button>
      </div>
    </div>
    <div class="win-body"></div>`;
  // focus on any pointer-down
  el.addEventListener("mousedown", () => { focusFirst(w.id); renderWindows(); });
  // titlebar drag => reposition (becomes floating)
  attachDrag(el, w);
  el.querySelector(".min").addEventListener("click", e => { e.stopPropagation(); minimizeWindow(w.id); });
  el.querySelector(".max").addEventListener("click", e => { e.stopPropagation(); maximizeWindow(w.id); });
  el.querySelector(".close").addEventListener("click", e => { e.stopPropagation(); closeWindow(w.id); });
  // double-click titlebar toggles maximize
  el.querySelector(".titlebar").addEventListener("dblclick", () => maximizeWindow(w.id));
  renderWindowBody(el.querySelector(".win-body"), w);
  return el;
}

/*
 * Drag-by-titlebar. In the real system (wm/policy.ts -> requestMoveResize) this flips the
 * window to "floating" and emits a { type: "repositionTexture", rect } intent. The native
 * compositor moves the already-rendered GPU texture to the new rect — the web content is
 * NOT repainted. Here we just translate the element; the body is never re-rendered.
 */
function attachDrag(el, w) {
  const bar = el.querySelector(".titlebar");
  bar.addEventListener("mousedown", (e) => {
    if (e.target.closest(".win-ctrl")) return;
    e.preventDefault();
    focusFirst(w.id); renderWindows();
    if (w.maximized) return;
    const startX = e.clientX, startY = e.clientY;
    const rect = el.getBoundingClientRect();
    const stageR = STAGE().getBoundingClientRect();
    const offX = startX - rect.left, offY = startY - rect.top;
    el.classList.add("dragging"); el.classList.remove("tiled");
    function move(ev) {
      // pure reposition — no body re-render (mirrors the no-repaint texture move)
      let nx = ev.clientX - stageR.left - offX;
      let ny = ev.clientY - stageR.top - offY;
      nx = Math.max(0, Math.min(nx, stageR.width - rect.width));
      ny = Math.max(0, Math.min(ny, stageR.height - rect.height));
      el.style.left = nx + "px"; el.style.top = ny + "px";
      w.rect = { x: nx, y: ny, width: rect.width, height: rect.height };
    }
    function up() {
      document.removeEventListener("mousemove", move);
      document.removeEventListener("mouseup", up);
      el.classList.remove("dragging");
      w.mode = "floating";  // requestMoveResize => mode becomes "floating"
      render();
    }
    document.addEventListener("mousemove", move);
    document.addEventListener("mouseup", up);
  });
}

/* ---------- App bodies ---------- */
function renderWindowBody(body, w) {
  if (w.kind === "settings") return renderSettings(body, w);
  if (w.kind === "files") return renderFiles(body, w);
  if (w.kind === "shell") return renderShellInspector(body, w);
  return renderPlaceholder(body, w);
}

/* SETTINGS (categories -> widgets, control-plane preview/apply) */
function renderSettings(body, w) {
  if (!w.ui) w.ui = { selectedCategoryId: "appearance", pending: null, config: clone(settingsConfig) };
  const ui = w.ui;
  const cfg = ui.config;
  const cat = cfg.categories.find(c => c.id === ui.selectedCategoryId) || cfg.categories[0];

  body.innerHTML = `
    <div class="settings">
      <div class="settings-side">
        ${cfg.categories.map(c => `
          <div class="cat ${c.id === ui.selectedCategoryId ? "selected" : ""}" data-cat="${c.id}">
            <span class="ci">${c.icon}</span>${esc(c.title)}
          </div>`).join("")}
      </div>
      <div class="settings-main">
        <h3 class="settings-h">${esc(cat.title)}</h3>
        <p class="settings-rev">config revision ${esc(cfg.revision)} · control-plane managed</p>
        ${cat.settings.map(s => widgetHtml(cat.id, s)).join("")}
        <div class="cp-bar ${ui.pending ? "" : "hidden"}" id="cp-bar">
          <div class="cp-text">
            <span class="cp-phase">${ui.pending ? ui.pending.phase : ""}</span>
            ${ui.pending ? `&nbsp;·&nbsp;${esc(ui.pending.label)} → <b>${esc(String(ui.pending.value))}</b>` : ""}
          </div>
          <button class="btn ghost" data-cp="rollback">Discard</button>
          <button class="btn primary" data-cp="apply">Apply</button>
        </div>
      </div>
    </div>`;

  body.querySelectorAll(".cat").forEach(c => c.addEventListener("click", () => {
    ui.selectedCategoryId = c.dataset.cat; renderSettings(body, w);
  }));
  // widget edits => create a "preview" pending edit (control-plane.preview)
  body.querySelectorAll("[data-toggle]").forEach(t => t.addEventListener("click", () => {
    const s = findSetting(cfg, cat.id, t.dataset.toggle);
    if (s.id === "secureboot" || s.id === "verity") return; // read-only, enforced
    stagePreview(ui, cat.id, s, !s.value, body, w);
  }));
  body.querySelectorAll("[data-num]").forEach(inp => inp.addEventListener("change", () => {
    const s = findSetting(cfg, cat.id, inp.dataset.num);
    stagePreview(ui, cat.id, s, Number(inp.value), body, w);
  }));
  body.querySelectorAll("[data-text]").forEach(inp => inp.addEventListener("change", () => {
    const s = findSetting(cfg, cat.id, inp.dataset.text);
    stagePreview(ui, cat.id, s, inp.value, body, w);
  }));
  const cpBar = body.querySelector("#cp-bar");
  if (cpBar) {
    cpBar.querySelector('[data-cp="apply"]').addEventListener("click", () => {
      // control-plane.apply: commit the desired value into config
      const p = ui.pending; if (!p) return;
      findSetting(cfg, p.categoryId, p.settingId).value = p.value;
      ui.pending = null;
      renderSettings(body, w);
      pushNotification({ id: "set-" + Date.now(), title: "Setting applied", severity: "success",
        body: `${p.label} committed via control plane.`, source: "settings", ttlMs: 5000 });
    });
    cpBar.querySelector('[data-cp="rollback"]').addEventListener("click", () => {
      ui.pending = null; renderSettings(body, w);   // rollback the preview
    });
  }
}
function widgetHtml(catId, s) {
  const ro = (s.id === "secureboot" || s.id === "verity");
  let control = "";
  if (s.kind === "toggle") control = `<button class="toggle ${s.value ? "on" : ""}" data-toggle="${s.id}" ${ro ? "disabled style='opacity:.6;cursor:default'" : ""} aria-label="${esc(s.label)}"></button>`;
  else if (s.kind === "number") control = `<input class="num-field" type="number" data-num="${s.id}" value="${esc(String(s.value))}" />`;
  else control = `<input class="text-field" type="text" data-text="${s.id}" value="${esc(String(s.value))}" />`;
  return `<div class="widget">
    <div><label>${esc(s.label)}</label>${s.sub ? `<div class="wsub">${esc(s.sub)}</div>` : ""}</div>
    ${control}
  </div>`;
}
function stagePreview(ui, categoryId, s, value, body, w) {
  ui.pending = { phase: "preview", categoryId, settingId: s.id, label: s.label, value };
  renderSettings(body, w);
}
function findSetting(cfg, catId, settingId) {
  return cfg.categories.find(c => c.id === catId).settings.find(s => s.id === settingId);
}

/* FILE MANAGER (path bar + entries, stat-before-read, fail-closed) */
function renderFiles(body, w) {
  if (!w.ui) w.ui = { grant: "grant:home", path: "/home/lewis", selected: null, status: "ready", error: null };
  const ui = w.ui;
  const entries = fsList(ui.path);
  if (entries === null) { ui.status = "forbidden"; ui.error = "AccessForbidden: no grant covers this path"; }

  const rows = (entries || []).map(e => {
    const glyph = e.kind === "dir" ? "▸" : e.kind === "file" ? "▤" : "⊘";
    const gclass = e.kind === "dir" ? "dir" : e.kind === "file" ? "file" : "skip";
    const sizeTxt = e.kind === "file" ? fmtSize(e.size) : (e.kind === "dir" ? "—" : "skip");
    const kindTxt = e.kind === "symlink-skipped" ? "symlink (skipped)" : e.kind;
    const sel = ui.selected === e.name ? "selected" : "";
    return `<div class="fm-row ${sel}" data-entry="${esc(e.name)}" data-kind="${e.kind}">
      <span class="fm-name"><span class="fm-glyph ${gclass}">${glyph}</span>${esc(e.name)}</span>
      <span class="fm-size">${sizeTxt}</span>
      <span class="fm-kind">${esc(kindTxt)}</span>
      <span class="fm-mtime">${esc(e.mtime || "")}</span>
    </div>`;
  }).join("");

  body.innerHTML = `
    <div class="fm">
      <div class="fm-pathbar">
        <button class="fm-up" title="Parent (..)" ${ui.path === "/" ? "disabled" : ""}>↑</button>
        <div class="fm-path">${esc(ui.path)}</div>
        <div class="fm-grant">grant <b>${esc(ui.grant)}</b></div>
      </div>
      <div class="fm-cols"><span>Name</span><span>Size</span><span>Type</span><span>Modified</span></div>
      <div class="fm-list">
        ${ui.status === "forbidden" ? `<div class="launcher-empty">⊘ Access forbidden — this path is outside the capability grant.</div>` : rows}
      </div>
      <div class="fm-status">
        <span>${(entries || []).length} entries · stat-before-read · fail-closed</span>
        <span class="${ui.error ? "err" : ""}">${ui.error ? esc(ui.error) : (ui.selected ? "selected: " + esc(ui.selected) : "status: " + ui.status)}</span>
      </div>
    </div>`;

  const up = body.querySelector(".fm-up");
  up.addEventListener("click", () => { navFiles(ui, "..", body, w); });
  body.querySelectorAll(".fm-row").forEach(row => {
    row.addEventListener("click", () => { ui.selected = row.dataset.entry; renderFiles(body, w); });
    row.addEventListener("dblclick", () => navFiles(ui, row.dataset.entry, body, w));
  });
}
function navFiles(ui, name, body, w) {
  // stat-before-read: resolve target, only descend into dirs
  let target;
  if (name === "..") target = parentPath(ui.path);
  else target = joinPath(ui.path, name);
  const at = fsList(ui.path) ? fsList(ui.path).find(e => e.name === name) : null;
  if (name !== ".." && at && at.kind !== "dir") {
    ui.selected = name; ui.status = "preview"; ui.error = null;
    w.title = "Files — " + ui.path; renderFiles(body, w); return;
  }
  ui.path = target; ui.selected = null; ui.status = "ready"; ui.error = null;
  w.title = "Files — " + ui.path;
  renderFiles(body, w);
  const t = w.id && document.querySelector(`[data-win-id="${cssEsc(w.id)}"] .win-title`);
  if (t) t.textContent = w.title;
  renderPanel();
}

/* SHELL INSPECTOR (composite layout tree + preview/apply/rollback/fallback) */
function renderShellInspector(body, w) {
  if (!w.ui) w.ui = { source: "configured" };
  const ui = w.ui;
  const tree = ui.source === "fallback" ? FALLBACK_TREE : SHELL_TREE;
  body.innerHTML = `
    <div class="shellview">
      <div class="sv-top">
        <p>The desktop is a composite TSX/CSS layout. Components register a <span style="color:var(--accent-2)">layer</span>
        and <span style="color:var(--info)">zone</span>; a shell config composes them into the surface tree below.
        Edits are managed: <b>preview → apply</b> with <b>rollback</b>, and a known-good <b>fallback shell</b> if an edit fails closed.</p>
        <div class="sv-actions">
          <button class="btn" data-sv="preview">Preview edit</button>
          <button class="btn primary" data-sv="apply">Apply</button>
          <button class="btn ghost" data-sv="rollback">Rollback</button>
          <button class="btn ghost" data-sv="fallback">Force fallback</button>
          <span class="sv-state ${ui.source}">source: ${ui.source}</span>
        </div>
      </div>
      <div class="sv-tree">${tree.map(n => shellNodeHtml(n)).join("")}</div>
    </div>`;
  body.querySelector('[data-sv="preview"]').addEventListener("click", () =>
    pushNotification({ id: "sh-prev", title: "Shell preview composed", severity: "info",
      body: "diff: +1 component (no surfaces removed). Apply to commit.", source: "shell", ttlMs: 6000 }));
  body.querySelector('[data-sv="apply"]').addEventListener("click", () => {
    ui.source = "configured"; renderShellInspector(body, w);
    pushNotification({ id: "sh-apply", title: "Shell applied", severity: "success",
      body: "ManagedShellConfigController committed the new layout.", source: "shell", ttlMs: 5000 });
  });
  body.querySelector('[data-sv="rollback"]').addEventListener("click", () => {
    ui.source = "configured"; renderShellInspector(body, w);
    pushNotification({ id: "sh-rb", title: "Shell rolled back", severity: "warning",
      body: "Restored the previous known-good layout.", source: "shell", ttlMs: 5000 });
  });
  body.querySelector('[data-sv="fallback"]').addEventListener("click", () => {
    ui.source = "fallback"; renderShellInspector(body, w);
    pushNotification({ id: "sh-fb", title: "Failed closed to fallback", severity: "critical",
      body: "Edit rejected — desktop is on vita.shell.fallback (owner not locked out).", source: "shell", ttlMs: 7000 });
  });
}
const SHELL_TREE = [
  { d: 0, comp: "vita.shell.chrome.panel",         layer: "panel",   zone: "top" },
  { d: 1, comp: "vita.shell.chrome.launcher",      layer: "overlay", zone: "left" },
  { d: 1, comp: "vita.shell.chrome.notifications", layer: "overlay", zone: "right" },
  { d: 0, comp: "vita.apps.desktop",               layer: "desktop", zone: "center" },
  { d: 1, comp: "vita.app.settings",               layer: "desktop", zone: "center" },
  { d: 1, comp: "vita.app.file-manager",           layer: "desktop", zone: "center" },
];
const FALLBACK_TREE = [
  { d: 0, comp: "vita.shell.fallback", layer: "overlay", zone: "center" },
];
function shellNodeHtml(n) {
  const indent = "  ".repeat(n.d);
  const branch = n.d > 0 ? "└─ " : "";
  return `<div class="sv-node">${indent}${branch}<span class="comp">${n.comp}</span>  ` +
    `<span class="layer">@${n.layer}</span>:<span class="zone">${n.zone}</span></div>`;
}

function renderPlaceholder(body, w) {
  body.innerHTML = `
    <div style="display:flex;flex-direction:column;align-items:center;justify-content:center;
                height:100%;gap:12px;color:var(--text-faint);text-align:center;padding:24px;">
      <div class="win-icon ${w.glyph}" style="width:48px;height:48px;font-size:22px;border-radius:12px;">${w.icon}</div>
      <div style="font-size:15px;color:var(--text);font-weight:500">${esc(w.title)}</div>
      <div style="font-size:12.5px;max-width:300px;line-height:1.5">
        Windowed surface placeholder. In the real PSD desktop this app is a TSX / web / WASM / OCI
        capsule rendered offscreen into a GPU texture and composited by the native core.
      </div>
    </div>`;
}

/* ===================================================================================== */
/* PANEL / CHROME                                                                         */
/* ===================================================================================== */

const tray = [
  { id: "power", label: "86%", status: "ok" },
  { id: "net", label: "Mesh", status: "ok" },
  { id: "trust", label: "Trusted boot", status: "ok" },
];

function renderPanel() {
  const focused = focusedWindowId();
  const fw = focused ? state.windows.find(w => w.id === focused) : null;
  const ft = document.getElementById("focused-title");
  ft.innerHTML = fw ? `<b>${esc(fw.title)}</b>` : `<span style="color:var(--text-faint)">Vita desktop</span>`;
  document.getElementById("layout-label").textContent =
    cap(state.workspaceLayout[state.activeWorkspaceId]);
  document.getElementById("layout-toggle").classList.toggle("active",
    state.workspaceLayout[state.activeWorkspaceId] === "stack");
}

function renderWorkspaces() {
  const pager = document.getElementById("ws-pager");
  pager.innerHTML = WS.map((ws, i) => {
    const count = state.windows.filter(w => w.workspaceId === ws && !w.minimized).length;
    const active = ws === state.activeWorkspaceId;
    return `<div class="ws-dot ${active ? "active" : ""}" data-ws="${ws}" title="${ws} (${count} windows)">${i + 1}</div>`;
  }).join("");
  pager.querySelectorAll(".ws-dot").forEach(d =>
    d.addEventListener("click", () => switchWorkspace(d.dataset.ws)));
}

/* clock — live (panel clockLabel) */
function tickClock() {
  const now = new Date();
  const t = now.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  const d = now.toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" });
  document.getElementById("clock-time").textContent = t;
  document.getElementById("clock-date").textContent = d;
}
setInterval(tickClock, 1000); tickClock();

/* ===================================================================================== */
/* LAUNCHER (searchable apps -> launchApp)                                                 */
/* ===================================================================================== */

let launcherSel = 0;
function openLauncher() {
  const l = document.getElementById("launcher");
  l.classList.add("open");
  document.getElementById("activities").classList.add("active");
  const inp = document.getElementById("launcher-input");
  inp.value = ""; launcherSel = 0;
  renderAppGrid("");
  setTimeout(() => inp.focus(), 0);
}
function closeLauncher() {
  document.getElementById("launcher").classList.remove("open");
  document.getElementById("activities").classList.remove("active");
}
function toggleLauncher() {
  document.getElementById("launcher").classList.contains("open") ? closeLauncher() : openLauncher();
}

/* filterLauncherApps: match id / name / subtitle / keywords */
function filterApps(query) {
  const q = query.trim().toLowerCase();
  if (!q) return APPS;
  return APPS.filter(a =>
    a.id.toLowerCase().includes(q) ||
    a.name.toLowerCase().includes(q) ||
    (a.subtitle && a.subtitle.toLowerCase().includes(q)) ||
    (a.keywords || []).some(k => k.toLowerCase().includes(q)));
}
function renderAppGrid(query) {
  const results = filterApps(query);
  const grid = document.getElementById("app-grid");
  const empty = document.getElementById("launcher-empty");
  if (launcherSel >= results.length) launcherSel = Math.max(0, results.length - 1);
  empty.style.display = results.length ? "none" : "block";
  grid.style.display = results.length ? "grid" : "none";
  grid.innerHTML = results.map((a, i) => `
    <div class="app-cell ${i === launcherSel ? "kbsel" : ""}" data-app="${a.id}">
      <div class="app-ico ${a.glyph}">${a.icon}</div>
      <div class="app-name">${esc(a.name)}</div>
      <div class="app-sub">${esc(a.subtitle || "")}</div>
    </div>`).join("");
  grid.querySelectorAll(".app-cell").forEach(c =>
    c.addEventListener("click", () => { launch(c.dataset.app); }));
}
function launch(appId) {
  closeLauncher();
  const app = APPS.find(a => a.id === appId);
  openWindow(app ? (app.opens || app.id) : appId);
}

/* ===================================================================================== */
/* NOTIFICATIONS (add / dismiss / expire)                                                 */
/* ===================================================================================== */

const notifications = [];  // {id, title, severity, body, source, expiresAt}
function pushNotification(n) {
  const now = Date.now();
  const item = {
    id: n.id || "n-" + now, title: n.title, severity: n.severity || "info",
    body: n.body || "", source: n.source || "", createdAt: now,
    expiresAt: n.ttlMs ? now + n.ttlMs : (n.expiresAtMs || undefined),
  };
  // de-dupe by id, newest first
  const idx = notifications.findIndex(x => x.id === item.id);
  if (idx >= 0) notifications.splice(idx, 1);
  notifications.unshift(item);
  renderNotifications();
}
function dismissNotification(id) {
  const i = notifications.findIndex(n => n.id === id);
  if (i >= 0) { notifications.splice(i, 1); renderNotifications(); }
}
function expireNotifications() {
  const now = Date.now();
  let changed = false;
  for (let i = notifications.length - 1; i >= 0; i--) {
    if (notifications[i].expiresAt && notifications[i].expiresAt <= now) { notifications.splice(i, 1); changed = true; }
  }
  if (changed) renderNotifications();
}
setInterval(expireNotifications, 700);

function renderNotifications() {
  const c = document.getElementById("notifs");
  c.innerHTML = notifications.map(n => `
    <div class="notif severity-${n.severity}" data-nid="${n.id}">
      <div class="notif-head">
        <span class="notif-title">${esc(n.title)}</span>
        ${n.source ? `<span class="notif-src">${esc(n.source)}</span>` : ""}
        <button class="notif-x" title="Dismiss">✕</button>
      </div>
      ${n.body ? `<div class="notif-body">${esc(n.body)}</div>` : ""}
    </div>`).join("");
  c.querySelectorAll(".notif-x").forEach(b =>
    b.addEventListener("click", () => dismissNotification(b.closest(".notif").dataset.nid)));
  const badge = document.getElementById("notif-badge");
  const crit = notifications.filter(n => n.severity === "critical").length;
  if (notifications.length) {
    badge.style.display = "flex"; badge.textContent = notifications.length;
    badge.style.background = crit ? "var(--critical)" : "var(--info)";
  } else badge.style.display = "none";
}

/* ===================================================================================== */
/* WIRING + helpers                                                                       */
/* ===================================================================================== */

document.getElementById("activities").addEventListener("click", toggleLauncher);
document.getElementById("layout-toggle").addEventListener("click", () =>
  setWorkspaceLayout(state.workspaceLayout[state.activeWorkspaceId] === "tile" ? "stack" : "tile"));
document.getElementById("notif-bell").addEventListener("click", () =>
  pushNotification({ id: "ping-" + Date.now(), title: "Notification center", severity: "info",
    body: "This is the chrome notification stack — add / dismiss / auto-expire.", source: "chrome", ttlMs: 5000 }));

const lInput = document.getElementById("launcher-input");
lInput.addEventListener("input", () => { launcherSel = 0; renderAppGrid(lInput.value); });
lInput.addEventListener("keydown", (e) => {
  const results = filterApps(lInput.value);
  if (e.key === "ArrowRight" || (e.key === "Tab" && !e.shiftKey)) { e.preventDefault(); launcherSel = Math.min(results.length - 1, launcherSel + 1); renderAppGrid(lInput.value); }
  else if (e.key === "ArrowLeft" || (e.key === "Tab" && e.shiftKey)) { e.preventDefault(); launcherSel = Math.max(0, launcherSel - 1); renderAppGrid(lInput.value); }
  else if (e.key === "ArrowDown") { e.preventDefault(); launcherSel = Math.min(results.length - 1, launcherSel + 4); renderAppGrid(lInput.value); }
  else if (e.key === "ArrowUp") { e.preventDefault(); launcherSel = Math.max(0, launcherSel - 4); renderAppGrid(lInput.value); }
  else if (e.key === "Enter") { e.preventDefault(); if (results[launcherSel]) launch(results[launcherSel].id); }
});

document.addEventListener("keydown", (e) => {
  // Super (Meta) or the "Activities" affordance toggles the launcher; Esc closes it.
  if (e.key === "Meta" || e.key === "OS" || (e.key === " " && e.target === document.body)) {
    e.preventDefault(); toggleLauncher();
  } else if (e.key === "Escape") {
    closeLauncher();
  } else if ((e.key === "l" || e.key === "L") && (e.metaKey || e.altKey)) {
    e.preventDefault();
    setWorkspaceLayout(state.workspaceLayout[state.activeWorkspaceId] === "tile" ? "stack" : "tile");
  }
});

/* helpers */
function esc(s) { return String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }
function cssEsc(s) { return String(s).replace(/["\\]/g, "\\$&"); }
function clone(o) { return JSON.parse(JSON.stringify(o)); }
function cap(s) { return s.charAt(0).toUpperCase() + s.slice(1); }
function fmtSize(b) { if (b < 1024) return b + " B"; if (b < 1048576) return (b / 1024).toFixed(1) + " KB"; return (b / 1048576).toFixed(1) + " MB"; }
function joinPath(base, name) { if (base === "/") return "/" + name; return base.replace(/\/+$/, "") + "/" + name; }
function parentPath(p) { const t = p.replace(/\/+$/, ""); if (!t || t === "/") return "/"; const i = t.lastIndexOf("/"); return i <= 0 ? "/" : t.slice(0, i); }

/* reflow on resize (re-tile) */
window.addEventListener("resize", () => renderWindows());

/* ---------- Seed the session ---------- */
openWindow("settings");
openWindow("files");
state.activeWorkspaceId = "workspace-2";
openWindow("shell");
state.activeWorkspaceId = "workspace-1";
render();

setTimeout(() => pushNotification({ id: "welcome", title: "Welcome to the PSD desktop", severity: "success",
  body: "Press Super (or click Activities) for the launcher. Drag a title bar to float a window.", source: "shell", ttlMs: 9000 }), 600);
setTimeout(() => pushNotification({ id: "update", title: "Update staged (RAUC A/B)", severity: "info",
  body: "vita-node 2026.06 verified on the inactive slot — reboot to activate.", source: "updater", ttlMs: 11000 }), 1600);
setTimeout(() => pushNotification({ id: "egress", title: "Egress grant requested", severity: "warning",
  body: "capsule web.oci wants outbound :443. Review in Network settings.", source: "netd", ttlMs: 13000 }), 2600);
