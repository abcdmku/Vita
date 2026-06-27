// Puter compat — build the app-launch URL with the `puter.*` params the SDK reads.
//
// A Puter app is a web page loaded in a sandboxed iframe whose URL carries ~30 `puter.*` params. The
// SDK (vendored v2.js) reads these on boot to detect env==='app', set its APIOrigin to OUR local
// api_origin, and adopt the owner token + instance id. We only need the minimal load-bearing set
// (verified against the bundle, 2026-06-26):
//   puter.app_instance_id, puter.api_origin, puter.auth.token, puter.auth.username, puter.domain,
//   puter.env=app, puter.origin (the gui origin the SDK posts ui messages back to).
//
// Pure + no DOM — returns a string; web-app-window.ts assigns it to the iframe src. Testable.

export interface LaunchUrlParams {
  // The app's entry URL (the page to load in the iframe), e.g. "/spike/app/index.html".
  readonly appUrl: string;
  readonly appInstanceId: string;
  // The LOCAL api_origin the SDK points fs/kv/auth at (no trailing slash), e.g. "http://localhost:8137/api".
  readonly apiOrigin: string;
  readonly authToken: string;
  readonly username?: string;
  readonly domain?: string;
  // The parent (gui) origin the SDK should post ui messages to, e.g. "http://localhost:8137".
  readonly guiOrigin?: string;
  readonly appId?: string;
  // A launch ITEM the app should receive via `puter.ui.onLaunchedWithItems` on boot. The SDK reads
  // `puter.item.name` / `puter.item.uid` / `puter.item.read_url` (+ path/write_url/size/…) from the
  // launch URL query and feeds them to the registered callback. Provide these to open an app WITH a
  // file selected. (For an already-running app, use broker.pushLaunchItems instead.)
  readonly launchItem?: LaunchItem;
  // Extra params (rarely needed) merged in last.
  readonly extra?: Readonly<Record<string, string>>;
}

export interface LaunchItem {
  readonly name: string;
  readonly uid: string;
  readonly path: string;
  readonly readUrl: string;
  readonly writeUrl?: string;
  readonly metadataUrl?: string;
  readonly size?: number;
}

// Build the full iframe URL. The appUrl may be absolute or relative; params are appended to its query.
// We keep the existing query of appUrl and add ours, so an app entry with its own params still works.
export function buildLaunchUrl(params: LaunchUrlParams): string {
  const search = buildLaunchSearch(params);
  const [path, existing] = splitQuery(params.appUrl);
  const merged = existing === "" ? search : `${existing}&${search}`;

  return `${path}?${merged}`;
}

// Just the query string (no leading "?"). Exposed for tests + callers that build their own URL.
export function buildLaunchSearch(params: LaunchUrlParams): string {
  const entries: [string, string][] = [
    ["puter.app_instance_id", params.appInstanceId],
    ["puter.api_origin", params.apiOrigin],
    ["puter.auth.token", params.authToken],
    ["puter.auth.username", params.username ?? "owner"],
    ["puter.domain", params.domain ?? "localhost"],
    ["puter.env", "app"],
  ];

  if (params.guiOrigin !== undefined) entries.push(["puter.origin", params.guiOrigin]);
  if (params.appId !== undefined) entries.push(["puter.app.name", params.appId]);

  // The launch item the SDK's onLaunchedWithItems reads on boot. It GATES on name+uid+read_url all
  // being present, so emit those three (and the rest) only when a launch item is supplied.
  const item = params.launchItem;

  if (item !== undefined) {
    entries.push(["puter.item.name", item.name]);
    entries.push(["puter.item.uid", item.uid]);
    entries.push(["puter.item.path", item.path]);
    entries.push(["puter.item.read_url", item.readUrl]);
    if (item.writeUrl !== undefined) entries.push(["puter.item.write_url", item.writeUrl]);
    if (item.metadataUrl !== undefined) entries.push(["puter.item.metadata_url", item.metadataUrl]);
    if (item.size !== undefined) entries.push(["puter.item.size", String(item.size)]);
  }

  for (const [k, v] of Object.entries(params.extra ?? {})) entries.push([k, v]);

  return entries
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join("&");
}

// Parse the `puter.*` params back out of a URL/search (the SDK does the equivalent). Used by tests to
// assert round-trip fidelity and by the headless harness if it needs to read them.
export function parseLaunchParams(url: string): Record<string, string> {
  const [, query] = splitQuery(url);
  const out: Record<string, string> = {};

  if (query === "") return out;

  for (const pair of query.split("&")) {
    const eq = pair.indexOf("=");
    const key = decodeURIComponent(eq < 0 ? pair : pair.slice(0, eq));
    const value = eq < 0 ? "" : decodeURIComponent(pair.slice(eq + 1));

    if (key.startsWith("puter.")) out[key] = value;
  }

  return out;
}

function splitQuery(url: string): [string, string] {
  const q = url.indexOf("?");

  return q < 0 ? [url, ""] : [url.slice(0, q), url.slice(q + 1)];
}
