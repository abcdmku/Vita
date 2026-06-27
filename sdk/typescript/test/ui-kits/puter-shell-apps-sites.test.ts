// Shell + apps/sites/shares/events surface tests — exercise the NEW api_origin breadth the multi-window
// shell + real third-party apps depend on (the apps/sites/shares registry, the realtime events feed,
// the per-app shell-session minting, and the app registry catalog). Against the in-memory store + the
// capability gate, via the transport-agnostic handler (no node:http).
//
// Run: node --experimental-strip-types --test sdk/typescript/test/ui-kits/puter-shell-apps-sites.test.ts

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  type ApiOrigin,
  type ApiRequest,
  createApiOrigin,
} from "../../../../ui_kits/desktop/runtime/puter/api-origin.ts";
import {
  createCapabilityRegistry,
  type PuterCapability,
  type PuterCapabilityRegistry,
} from "../../../../ui_kits/desktop/runtime/puter/capability.ts";
import { createMemoryStore } from "../../../../ui_kits/desktop/runtime/puter/store.ts";
import { createAppSiteRegistry } from "../../../../ui_kits/desktop/runtime/puter/app-registry-store.ts";
import {
  DEFAULT_SHELL_APPS,
  findShellApp,
} from "../../../../ui_kits/desktop/runtime/puter/shell/app-registry.ts";
import {
  buildShellSessionScript,
  mintShellSessions,
} from "../../../../ui_kits/desktop/runtime/puter/shell/shell-session.ts";

const TOKEN = "test-owner-token";
const INSTANCE = "test-instance";
const APP_ID = "test.app";

function setup(grants: readonly PuterCapability[] = ["fs.read", "fs.write", "kv.read", "kv.write", "ui", "auth"]): { api: ApiOrigin; caps: PuterCapabilityRegistry } {
  const store = createMemoryStore();
  const caps = createCapabilityRegistry();

  caps.mintAppSession({ appId: APP_ID, appInstanceId: INSTANCE, grants, token: TOKEN });
  return { api: createApiOrigin({ capabilities: caps, store, originBase: "http://127.0.0.1:9999" }), caps };
}

function req(method: string, path: string, options: { token?: string; json?: unknown; query?: Record<string, string> } = {}): ApiRequest {
  const headers: Record<string, string> = {};

  if (options.token !== undefined) headers["authorization"] = `Bearer ${options.token}`;

  let body: Uint8Array = new Uint8Array(0);

  if (options.json !== undefined) {
    headers["content-type"] = "text/plain;actually=json";
    body = new TextEncoder().encode(JSON.stringify(options.json));
  }

  return { body, headers, method, path, query: options.query ?? {} };
}

function jsonBody(res: { body: Uint8Array }): Record<string, unknown> {
  return JSON.parse(new TextDecoder().decode(res.body)) as Record<string, unknown>;
}

// ---------------------------------------------------------------------------------------------
// apps surface (puter-apps driver + REST /apps).
// ---------------------------------------------------------------------------------------------

test("apps: create + select via the puter-apps driver interface", () => {
  const { api } = setup();

  const created = api.handle(req("POST", "/drivers/call", {
    json: { interface: "puter-apps", method: "create", args: { object: { name: "my-app", title: "My App", index_url: "https://x/" } }, auth_token: TOKEN },
  }));

  assert.equal(created.status, 200);
  const createdBody = jsonBody(created);

  assert.equal(createdBody["success"], true);
  assert.equal((createdBody["result"] as Record<string, unknown>)["name"], "my-app");

  const listed = api.handle(req("POST", "/drivers/call", { json: { interface: "puter-apps", method: "select", args: {}, auth_token: TOKEN } }));
  const result = jsonBody(listed)["result"] as Array<Record<string, unknown>>;

  assert.equal(result.length, 1);
  assert.equal(result[0]!["title"], "My App");
});

test("apps: REST GET/POST /apps round-trips", () => {
  const { api } = setup();

  const post = api.handle(req("POST", "/apps", { json: { name: "rest-app", title: "Rest App" }, token: TOKEN }));

  assert.equal(post.status, 200);

  const get = api.handle(req("GET", "/apps", { token: TOKEN }));
  const apps = jsonBody(get)["apps"] as Array<Record<string, unknown>>;

  assert.equal(apps.length, 1);
  assert.equal(apps[0]!["name"], "rest-app");
});

test("apps: write methods require fs.write (default-deny without the grant)", () => {
  const { api } = setup(["fs.read", "auth"]); // no fs.write

  const denied = api.handle(req("POST", "/drivers/call", { json: { interface: "puter-apps", method: "create", args: { object: { name: "x" } }, auth_token: TOKEN } }));

  assert.equal(denied.status, 403);
});

// ---------------------------------------------------------------------------------------------
// sites / hosting surface (puter-subdomains driver + REST /sites).
// ---------------------------------------------------------------------------------------------

test("sites: create via puter-subdomains builds an absolute URL from originBase", () => {
  const { api } = setup();

  const created = api.handle(req("POST", "/drivers/call", {
    json: { interface: "puter-subdomains", method: "create", args: { object: { subdomain: "mysite", root_dir: "/public" } }, auth_token: TOKEN },
  }));

  const result = jsonBody(created)["result"] as Record<string, unknown>;

  assert.equal(result["subdomain"], "mysite");
  assert.equal(result["url"], "http://127.0.0.1:9999/sites/mysite/");

  const rest = api.handle(req("GET", "/sites", { token: TOKEN }));
  const sites = jsonBody(rest)["sites"] as Array<unknown>;

  assert.equal(sites.length, 1);
});

// ---------------------------------------------------------------------------------------------
// shares surface (REST /share).
// ---------------------------------------------------------------------------------------------

test("shares: POST /share mints a share with an absolute URL + lists it", () => {
  const { api } = setup();

  const created = api.handle(req("POST", "/share", { json: { path: "/file.txt", mode: "read" }, token: TOKEN }));
  const share = jsonBody(created)["share"] as Record<string, unknown>;

  assert.equal(share["path"], "/file.txt");
  assert.equal(share["mode"], "read");
  assert.match(String(share["url"]), /^http:\/\/127\.0\.0\.1:9999\/shared\/shr-/u);

  const list = api.handle(req("GET", "/share", { token: TOKEN }));

  assert.equal((jsonBody(list)["shares"] as Array<unknown>).length, 1);
});

// ---------------------------------------------------------------------------------------------
// realtime events feed (/events) — records fs.write + kv.set + registry actions.
// ---------------------------------------------------------------------------------------------

test("events: kv.set + app.create + site.create are recorded and readable via /events", () => {
  const { api } = setup();

  api.handle(req("POST", "/drivers/call", { json: { interface: "puter-kvstore", method: "set", args: { key: "k", value: "v" }, auth_token: TOKEN } }));
  api.handle(req("POST", "/drivers/call", { json: { interface: "puter-apps", method: "create", args: { object: { name: "a" } }, auth_token: TOKEN } }));
  api.handle(req("POST", "/drivers/call", { json: { interface: "puter-subdomains", method: "create", args: { object: { subdomain: "s" } }, auth_token: TOKEN } }));

  const feed = jsonBody(api.handle(req("GET", "/events", { token: TOKEN, query: { since: "0" } })));
  const events = feed["events"] as Array<Record<string, unknown>>;
  const kinds = events.map((e) => e["kind"]);

  assert.ok(kinds.includes("kv.set"), "kv.set recorded");
  assert.ok(kinds.includes("app.create"), "app.create recorded");
  assert.ok(kinds.includes("site.create"), "site.create recorded");

  // The cursor lets a poller fetch only newer events.
  const cursor = Number(feed["cursor"]);
  const empty = jsonBody(api.handle(req("GET", "/events", { token: TOKEN, query: { since: String(cursor) } })));

  assert.equal((empty["events"] as Array<unknown>).length, 0);
});

test("events: reading the feed requires fs.read (gated)", () => {
  const { api } = setup(["auth"]); // no fs.read

  assert.equal(api.handle(req("GET", "/events", { token: TOKEN })).status, 403);
});

test("registry keys (__vita.*) are hidden from app-visible kv.list", () => {
  const { api } = setup();

  // Create a site (writes a reserved __vita.sites.* key) + a normal kv key.
  api.handle(req("POST", "/drivers/call", { json: { interface: "puter-subdomains", method: "create", args: { object: { subdomain: "s" } }, auth_token: TOKEN } }));
  api.handle(req("POST", "/drivers/call", { json: { interface: "puter-kvstore", method: "set", args: { key: "visible", value: "1" }, auth_token: TOKEN } }));

  const listed = jsonBody(api.handle(req("POST", "/drivers/call", { json: { interface: "puter-kvstore", method: "list", args: { as: "keys" }, auth_token: TOKEN } })));
  const keys = listed["result"] as string[];

  assert.ok(keys.includes("visible"), "app key visible");
  assert.ok(!keys.some((k) => k.startsWith("__vita.")), "reserved keys hidden");
});

// ---------------------------------------------------------------------------------------------
// app-registry-store direct unit (the store-backed registry logic).
// ---------------------------------------------------------------------------------------------

test("app-registry-store: events ring-buffer + provenance", () => {
  const store = createMemoryStore();
  const reg = createAppSiteRegistry(store.kv);

  const e1 = reg.recordEvent({ app: "a", kind: "fs.write", path: "/x" });
  const e2 = reg.recordEvent({ app: "b", kind: "kv.set", detail: "k" });

  assert.equal(e1.seq, 1);
  assert.equal(e2.seq, 2);
  assert.equal(reg.events(0, 10).events.length, 2);
  assert.equal(reg.events(1, 10).events.length, 1); // only e2 is newer than seq 1
});

// ---------------------------------------------------------------------------------------------
// shell app-registry catalog + per-app session minting.
// ---------------------------------------------------------------------------------------------

test("shell registry: catalog has Vita apps + two real third-party apps", () => {
  assert.ok(findShellApp(DEFAULT_SHELL_APPS, "vita.desk") !== undefined);
  assert.ok(findShellApp(DEFAULT_SHELL_APPS, "vita.app.deploy-console") !== undefined);

  const thirdParty = DEFAULT_SHELL_APPS.filter((a) => a.origin === "third-party");

  assert.equal(thirdParty.length, 2);
  assert.ok(thirdParty.every((a) => a.license !== undefined), "third-party apps carry a license label");

  // Only the console holds `control` (default-deny elsewhere).
  const withControl = DEFAULT_SHELL_APPS.filter((a) => a.grants.includes("control"));

  assert.deepEqual(withControl.map((a) => a.id), ["vita.app.deploy-console"]);
});

test("shell registry: no app autostarts — the shell boots to a clean desktop (launcher-only)", () => {
  // feat/vita-shell-polish removed Vita Desk's autostart: auto-opening an app over an empty chrome made
  // the desktop read as "a random app is open with no system bar/dock". The shell now boots to a CLEAN
  // desktop (wallpaper + system bar + pinned dock) and every app — Vita Desk included — is launched from
  // the dock. So NO entry carries autostart=true.
  const autos = DEFAULT_SHELL_APPS.filter((a) => a.autostart === true);

  assert.deepEqual(autos.map((a) => a.id), []);
});

test("mintShellSessions: one capability session per app, honored by the api_origin", () => {
  const store = createMemoryStore();
  const caps = createCapabilityRegistry();
  const sessions = mintShellSessions(caps, DEFAULT_SHELL_APPS);

  // Every registry app got a session with a distinct token + deterministic instance id.
  for (const app of DEFAULT_SHELL_APPS) {
    const s = sessions[app.id];

    assert.ok(s !== undefined, `session for ${app.id}`);
    assert.equal(s.instanceId, `${app.id}::shell`);
    assert.ok(s.token.length > 0);
  }

  const tokens = Object.values(sessions).map((s) => s.token);

  assert.equal(new Set(tokens).size, tokens.length, "tokens are distinct per app");

  // The api_origin honors a minted token (whoami clears the auth gate).
  const api = createApiOrigin({ capabilities: caps, store });
  const who = api.handle(req("GET", "/whoami", { token: sessions["vita.desk"]!.token }));

  assert.equal(who.status, 200);
  assert.equal(jsonBody(who)["app_uid"], "vita.desk");
});

test("buildShellSessionScript: emits a safe window.__vitaShell assignment", () => {
  const script = buildShellSessionScript({ apiOrigin: "/api", sessions: { "a.b": { appId: "a.b", instanceId: "a.b::shell", token: "tok" } } });

  assert.match(script, /window\.__vitaShell = /u);
  assert.match(script, /"a\.b"/u);
  // The payload is a JSON literal (no template-injection of raw tokens into JS).
  assert.ok(script.includes(JSON.stringify({ apiOrigin: "/api", sessions: { "a.b": { appId: "a.b", instanceId: "a.b::shell", token: "tok" } } })));
});
