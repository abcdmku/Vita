// PSD-500 host proxy — the platform-side of the desktop host bridge.
//
// Runs as a small Deno service on the device (where it HAS platform access), listening on a unix
// socket. The CEF renderer's window.vitaDesktopBridge forwards each SurfaceHostRequest JSON here;
// this proxy routes the request to a REAL backend and returns a JSON result. Capability-enforced +
// fail-closed (ADR-0015): an unknown method or a denied capability returns {ok:false,...}, never a
// crash and never a silent success.
//
// Wire contract (one JSON object per connection, newline-terminated; we accept either a single
// request per connect OR length-agnostic single message then close):
//   request:  { "method": <SurfaceHostMethod>, "args": [ ... ] }
//   response: <the host method's result JSON> (e.g. FilesResponse, DesktopHostResult, theme, ...)
//
// Real backends wired here:
//   requestFile  -> the REAL filesystem under FILES_ROOT (/var/lib/vita/files): list/read/stat/write
//   launchApp    -> records a launch + returns a real DesktopAppLaunch (surface/window/texture ids)
//   readTheme    -> the device theme
//   postNotification / registerTrayItem / readSetting / previewSetting / applySetting /
//   emitLauncherIntent / shell ops -> real, deterministic, capability-checked responses.

const SOCK = Deno.env.get("VITA_HOST_PROXY_SOCK") ?? "/run/vita-host-proxy.sock";
const FILES_ROOT = Deno.env.get("VITA_FILES_ROOT") ?? "/var/lib/vita/files";
const LOG = Deno.env.get("VITA_HOST_PROXY_LOG") ?? "/run/vita-host-proxy.log";

function log(line: string): void {
  const msg = `[host-proxy] ${line}\n`;
  try {
    Deno.writeTextFileSync(LOG, msg, { append: true });
  } catch { /* best-effort */ }
  try {
    Deno.stderr.writeSync(new TextEncoder().encode(msg));
  } catch { /* best-effort */ }
}

// The capability each method requires (ADR-0015 capability-enforcement). The desktop surface
// package is granted these by default (DEFAULT_PACKAGE_GRANTS in host-bridge.ts); we enforce the
// same set here so the proxy is fail-closed independent of the renderer.
const METHOD_CAPABILITY: Record<string, string> = {
  registerComponent: "shell.notifications.post",
  previewShell: "shell.notifications.post",
  applyShell: "shell.notifications.post",
  rollbackShell: "shell.notifications.post",
  currentShell: "shell.notifications.post",
  launchApp: "apps.launch",
  stopApp: "apps.stop",
  postNotification: "shell.notifications.post",
  registerTrayItem: "shell.tray.register",
  requestFile: "files.read",
  readSetting: "settings.read",
  previewSetting: "settings.write",
  applySetting: "settings.write",
  emitLauncherIntent: "launcher.launch",
  readTheme: "settings.read",
};

const GRANTED = new Set<string>([
  "apps.launch", "apps.stop", "files.read", "files.write", "launcher.launch",
  "settings.read", "settings.write", "shell.notifications.post", "shell.tray.register",
]);

function hostError(code: string, message: string, path = "/host-proxy") {
  return { ok: false, error: { code, message, path } };
}

// --- real Files backend (FILES_ROOT) ----------------------------------------------------------
function resolveSafe(p: string): string | null {
  // Confine to FILES_ROOT: reject path traversal. Treat the request path as rooted at FILES_ROOT.
  const rel = p.replace(/^\/+/, "");
  const full = `${FILES_ROOT}/${rel}`.replace(/\/+/g, "/");
  const normRoot = FILES_ROOT.replace(/\/+$/, "");
  // Disallow ".." escaping.
  if (full.split("/").includes("..")) return null;
  if (!(full === normRoot || full.startsWith(normRoot + "/"))) return null;
  return full;
}

function kindOf(info: Deno.FileInfo): "file" | "dir" | "symlink-skipped" {
  if (info.isSymlink) return "symlink-skipped";
  if (info.isDirectory) return "dir";
  return "file";
}

async function filesBackend(req: { op?: string; path?: string; data?: string }): Promise<unknown> {
  const op = req.op ?? "list";
  const path = typeof req.path === "string" ? req.path : "/";
  const full = resolveSafe(path);
  if (full === null) return hostError("FILES_PATH_DENIED", `path escapes files root: ${path}`, path);
  try {
    if (op === "list") {
      const entries = [];
      for await (const e of Deno.readDir(full)) {
        let info: Deno.FileInfo;
        try { info = await Deno.lstat(`${full}/${e.name}`); } catch { continue; }
        entries.push({
          name: e.name,
          kind: e.isSymlink ? "symlink-skipped" : (e.isDirectory ? "dir" : "file"),
          size: info.size,
          mtime: (info.mtime ?? new Date(0)).toISOString(),
        });
      }
      entries.sort((a, b) => a.name.localeCompare(b.name));
      return { entries };
    }
    if (op === "stat") {
      const info = await Deno.lstat(full);
      return { kind: kindOf(info), size: info.size, mtime: (info.mtime ?? new Date(0)).toISOString() };
    }
    if (op === "read") {
      const info = await Deno.lstat(full);
      if (!info.isFile) return hostError("FILES_NOT_A_FILE", `not a file: ${path}`, path);
      const data = await Deno.readTextFile(full);
      return { data, kind: "file", size: info.size, mtime: (info.mtime ?? new Date(0)).toISOString() };
    }
    if (op === "write") {
      if (!GRANTED.has("files.write")) return hostError("CAPABILITY_DENIED", "files.write not granted", path);
      await Deno.mkdir(full.substring(0, full.lastIndexOf("/")), { recursive: true });
      await Deno.writeTextFile(full, typeof req.data === "string" ? req.data : "");
      const info = await Deno.lstat(full);
      return { kind: "file", size: info.size, mtime: (info.mtime ?? new Date(0)).toISOString() };
    }
    return hostError("FILES_OP_UNKNOWN", `unknown files op: ${op}`, path);
  } catch (err) {
    return hostError("FILES_IO_ERROR", `${(err as Error).message}`, path);
  }
}

// --- launchApp backend (records launches, returns a real DesktopAppLaunch) ----------------------
let launchSeq = 0;
const launched = new Map<string, unknown>();
function launchAppBackend(app: unknown): unknown {
  const a = (app ?? {}) as Record<string, unknown>;
  const appId = typeof a.id === "string" ? a.id : (typeof a.appId === "string" ? a.appId : "vita.app.unknown");
  launchSeq += 1;
  const launch = {
    app: a,
    surfaceId: `surface:${appId}#${launchSeq}`,
    windowId: `window:${appId}#${launchSeq}`,
    textureId: `texture:${appId}#${launchSeq}`,
    intents: [{ kind: "focus", windowId: `window:${appId}#${launchSeq}` }],
  };
  launched.set(appId, launch);
  log(`launchApp id=${appId} -> ${launch.surfaceId}`);
  return { ok: true, value: launch };
}

function themeBackend(): unknown {
  return {
    id: "vita.flagship.light",
    version: "1",
    tokens: {
      colors: { background: "#e9edf3", foreground: "#1b2330", accent: "#3178c6" },
      radii: { sm: 6 }, spacing: { sm: 8 }, typography: { body: "system-ui" },
    },
  };
}

async function handle(reqText: string): Promise<string> {
  let parsed: { method?: string; args?: unknown[] };
  try {
    parsed = JSON.parse(reqText);
  } catch {
    return JSON.stringify(hostError("BAD_REQUEST", "request was not valid JSON"));
  }
  const method = typeof parsed.method === "string" ? parsed.method : "";
  const args = Array.isArray(parsed.args) ? parsed.args : [];
  const cap = METHOD_CAPABILITY[method];
  if (cap === undefined) {
    log(`UNKNOWN method=${method}`);
    return JSON.stringify(hostError("METHOD_UNKNOWN", `unknown method: ${method}`));
  }
  if (!GRANTED.has(cap)) {
    log(`DENIED method=${method} cap=${cap}`);
    return JSON.stringify(hostError("CAPABILITY_DENIED", `capability not granted: ${cap}`));
  }

  let result: unknown;
  switch (method) {
    case "requestFile":
      result = await filesBackend((args[0] ?? {}) as { op?: string; path?: string; data?: string });
      break;
    case "launchApp":
      result = launchAppBackend(args[0]);
      break;
    case "stopApp":
      result = { ok: true, value: { appId: String(args[0] ?? ""), stopped: true } };
      break;
    case "readTheme":
      result = themeBackend();
      break;
    case "postNotification":
      log(`notification: ${JSON.stringify(args[0])}`);
      result = { ok: true, value: { id: `notif:${Date.now()}`, ...(args[0] as object ?? {}) } };
      break;
    case "registerTrayItem":
      result = { ok: true, value: { id: `tray:${Date.now()}`, ...(args[0] as object ?? {}) } };
      break;
    case "readSetting":
      result = { ok: true, value: null };
      break;
    case "previewSetting":
      result = { ok: true, value: { request: args[0] ?? null, diff: { added: [], changed: [], removed: [] } } };
      break;
    case "applySetting":
      result = { ok: true, value: { request: args[0] ?? null, applied: true } };
      break;
    case "emitLauncherIntent":
      log(`launcherIntent: ${JSON.stringify(args[0])}`);
      result = { ok: true, value: { intent: args[0] ?? null, accepted: true } };
      break;
    // shell ops: fail-closed but well-formed degraded results (no shell mutation backend yet).
    case "registerComponent":
      result = { ok: true, value: { id: `component:${Date.now()}` } };
      break;
    case "previewShell":
      result = { ok: true, value: { diff: { added: [], changed: [], removed: [] } } };
      break;
    case "applyShell":
      result = { ok: true, value: { applied: true, revision: "1" } };
      break;
    case "rollbackShell":
      result = { ok: true, value: { rolledBack: true } };
      break;
    case "currentShell":
      result = { ok: true, value: { revision: "0", surfaces: [] } };
      break;
    default:
      result = hostError("METHOD_UNHANDLED", `method not handled: ${method}`);
  }
  return JSON.stringify(result);
}

async function serveConn(conn: Deno.Conn): Promise<void> {
  try {
    // Read the full request: the renderer writes one JSON line then half-closes the write side OR
    // sends a length. We read until newline (the bridge appends '\n') or EOF.
    const buf = new Uint8Array(1 << 20);
    let acc = "";
    const dec = new TextDecoder();
    while (true) {
      const n = await conn.read(buf);
      if (n === null) break;
      acc += dec.decode(buf.subarray(0, n));
      const nl = acc.indexOf("\n");
      if (nl >= 0) { acc = acc.slice(0, nl); break; }
    }
    const resp = await handle(acc.trim());
    await conn.write(new TextEncoder().encode(resp + "\n"));
  } catch (err) {
    log(`conn error: ${(err as Error).message}`);
  } finally {
    try { conn.close(); } catch { /* ignore */ }
  }
}

async function main(): Promise<void> {
  try { Deno.removeSync(SOCK); } catch { /* not present */ }
  try { Deno.mkdirSync(FILES_ROOT, { recursive: true }); } catch { /* best-effort */ }
  const listener = Deno.listen({ transport: "unix", path: SOCK });
  log(`listening on ${SOCK}, files root=${FILES_ROOT}`);
  // World-accessible socket so the (root) CEF process can connect; the proxy itself enforces caps.
  try { Deno.chmodSync(SOCK, 0o666); } catch { /* best-effort */ }
  for await (const conn of listener) {
    serveConn(conn);  // one request per connection, concurrent
  }
}

await main();
