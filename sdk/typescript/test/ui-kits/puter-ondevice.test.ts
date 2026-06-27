// On-device wave tests — REAL persistence (file store survives reopen), REAL enforcement (the gate
// delegates to the platform permission-broker; ungranted → CAP_DENIED), the new fs ops (move/rename),
// the SDK-demanded /df, and the DUAL-FACE backend (loopback trust-on-host + network owner-token over
// ONE store + ONE gate, surviving a full backend restart).
//
// Run: node --experimental-strip-types --test sdk/typescript/test/ui-kits/puter-ondevice.test.ts

import assert from "node:assert/strict";
import { X509Certificate } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { request as httpsRequest } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect as tlsConnect } from "node:tls";
import { test } from "node:test";

import {
  createMemoryStore,
  PuterStoreError,
} from "../../../../ui_kits/desktop/runtime/puter/store.ts";
import {
  appDirSegment,
  appStoreDir,
  DEFAULT_APPS_ROOT,
  openAppStore,
} from "../../../../ui_kits/desktop/runtime/puter/fs-store.ts";
import {
  createCapabilityRegistry,
} from "../../../../ui_kits/desktop/runtime/puter/capability.ts";
import {
  createAppGrantRegistry,
  createBrokerPermissionModel,
} from "../../../../ui_kits/desktop/runtime/puter/permission-model.ts";
import { createApiOrigin, type ApiRequest } from "../../../../ui_kits/desktop/runtime/puter/api-origin.ts";
import {
  ownerTokenFaceGate,
  startDualFaceBackend,
} from "../../../../ui_kits/desktop/runtime/puter/backend.ts";
import {
  generateSelfSigned,
  resolveTlsMaterial,
} from "../../../../ui_kits/desktop/runtime/puter/server/tls.ts";
import {
  KIOSK_ENTRY_PATH,
  startPuterPlatformService,
} from "../../../../ui_kits/desktop/runtime/puter/server/service.ts";

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);
const dec = (b: Uint8Array): string => new TextDecoder().decode(b);

function freshDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

// ===================================== store.move / rename =====================================

test("memory store move renames a file and the source is gone", () => {
  const store = createMemoryStore();

  store.fs.write("/a.txt", enc("hi"));
  const entry = store.fs.move("/a.txt", "/b.txt");

  assert.equal(entry.name, "b.txt");
  assert.equal(store.fs.read("/a.txt"), undefined);
  assert.equal(dec(store.fs.read("/b.txt")!.bytes), "hi");
});

test("memory store move relocates a directory subtree", () => {
  const store = createMemoryStore();

  store.fs.mkdir("/src");
  store.fs.write("/src/x.txt", enc("X"));
  store.fs.write("/src/y.txt", enc("Y"));
  store.fs.move("/src", "/dst");

  assert.equal(store.fs.stat("/src"), undefined);
  assert.deepEqual(store.fs.readdir("/dst").map((e) => e.name).sort(), ["x.txt", "y.txt"]);
  assert.equal(dec(store.fs.read("/dst/x.txt")!.bytes), "X");
});

test("memory store move onto an existing file requires overwrite", () => {
  const store = createMemoryStore();

  store.fs.write("/a.txt", enc("a"));
  store.fs.write("/b.txt", enc("b"));
  assert.throws(() => store.fs.move("/a.txt", "/b.txt"), (e) => e instanceof PuterStoreError && e.code === "item_with_same_name_exists");
  // overwrite:true succeeds.
  store.fs.move("/a.txt", "/b.txt", { overwrite: true });
  assert.equal(dec(store.fs.read("/b.txt")!.bytes), "a");
});

test("memory store move of a missing source throws subject_does_not_exist", () => {
  const store = createMemoryStore();

  assert.throws(() => store.fs.move("/nope", "/x"), (e) => e instanceof PuterStoreError && e.code === "subject_does_not_exist");
});

test("memory store move of a directory into itself is rejected", () => {
  const store = createMemoryStore();

  store.fs.mkdir("/d");
  assert.throws(() => store.fs.move("/d", "/d/inner"), (e) => e instanceof PuterStoreError && e.code === "forbidden");
});

// ===================================== fs-store: REAL persistence =====================================

test("fs-store: app dir is isolated per appId under the configured root", () => {
  assert.equal(appDirSegment("spike.puter.testapp"), "spike.puter.testapp");
  // A traversal-laden id is sanitized to a SINGLE safe segment: NO path separators (so it cannot
  // traverse) and no LEADING dots (so it is not a "." / ".." dir entry).
  const seg = appDirSegment("../escape/../x");

  assert.ok(!seg.includes("/") && !seg.includes("\\"));
  assert.ok(!seg.startsWith("."));
  assert.ok(!appDirSegment("a/b\\c").includes("/"));
  assert.ok(!appDirSegment("a/b\\c").includes("\\"));
  assert.ok(appStoreDir({ appId: "x", appsRoot: "/tmp/root" }).endsWith(join("root", "x")));
  assert.equal(DEFAULT_APPS_ROOT, "/var/lib/vita/apps");
});

test("fs-store: a value written survives REOPEN (a simulated process restart, read back from disk)", () => {
  const appsRoot = freshDir("vita-fsstore-");

  try {
    // Open #1 — write fs + kv, then DROP the handle (simulating process exit).
    const store1 = openAppStore({ appId: "persist.app", appsRoot });

    store1.fs.write("/notes/a.txt", enc("durable"));
    store1.kv.set("k", "v");

    // Open #2 — a brand-new handle on the SAME root re-reads the persisted subtree.
    const store2 = openAppStore({ appId: "persist.app", appsRoot });

    assert.equal(dec(store2.fs.read("/notes/a.txt")!.bytes), "durable");
    assert.equal(store2.kv.get("k"), "v");

    // Different appId gets a DIFFERENT, empty subtree (isolation).
    const otherApp = openAppStore({ appId: "other.app", appsRoot });

    assert.equal(otherApp.fs.read("/notes/a.txt"), undefined);
    assert.equal(otherApp.kv.get("k"), null);
  } finally {
    rmSync(appsRoot, { force: true, recursive: true });
  }
});

test("fs-store: move/rename persists across reopen", () => {
  const appsRoot = freshDir("vita-fsstore-mv-");

  try {
    const s1 = openAppStore({ appId: "mv.app", appsRoot });

    s1.fs.write("/old.txt", enc("data"));
    s1.fs.move("/old.txt", "/new.txt");

    const s2 = openAppStore({ appId: "mv.app", appsRoot });

    assert.equal(s2.fs.read("/old.txt"), undefined);
    assert.equal(dec(s2.fs.read("/new.txt")!.bytes), "data");
  } finally {
    rmSync(appsRoot, { force: true, recursive: true });
  }
});

// ===================================== REAL enforcement (broker delegation) =====================================

test("broker permission model: ALLOWS declared caps, DENIES undeclared + unknown app (via the real broker)", () => {
  const grants = createAppGrantRegistry({ "app.ro": ["fs.read", "kv.read", "auth"] });
  const model = createBrokerPermissionModel({ grants });
  const mk = (appId: string, capability: Parameters<typeof model.decide>[0]["capability"]) => ({ appId, appInstanceId: "i", capability, declaredGrants: new Set() as ReadonlySet<typeof capability> });

  assert.equal(model.decide(mk("app.ro", "fs.read")), true);
  assert.equal(model.decide(mk("app.ro", "kv.read")), true);
  assert.equal(model.decide(mk("app.ro", "auth")), true);
  // NOT granted → broker NOT_DECLARED → DENY.
  assert.equal(model.decide(mk("app.ro", "fs.write")), false);
  assert.equal(model.decide(mk("app.ro", "kv.write")), false);
  // Unknown app → no grants → DENY (fail-closed).
  assert.equal(model.decide(mk("app.unknown", "fs.read")), false);
});

test("capability registry DELEGATES authorize to the broker model: ungranted → CAP_DENIED 403, granted → ok", () => {
  const grants = createAppGrantRegistry({ "app.ro": ["fs.read", "auth"] });
  const registry = createCapabilityRegistry({ permissionModel: createBrokerPermissionModel({ grants }) });
  const session = registry.mintAppSession({ appId: "app.ro", appInstanceId: "i1", grants: ["fs.read", "auth"], token: "t1" });

  // granted
  const okRes = registry.authorize(session, "fs.read");

  assert.equal(okRes.ok, true);

  // ungranted → CAP_DENIED 403 (even though the SESSION's grant-set is irrelevant — the broker decides)
  const denied = registry.authorize(session, "fs.write");

  assert.equal(denied.ok, false);
  if (!denied.ok) {
    assert.equal(denied.code, "CAP_DENIED");
    assert.equal(denied.status, 403);
  }
});

test("capability registry: a session whose token grants a cap is STILL denied if the broker app-grant is absent", () => {
  // The session declares fs.write, but the app-grant registry does NOT — the broker is the authority.
  const grants = createAppGrantRegistry({ "app.x": ["fs.read"] });
  const registry = createCapabilityRegistry({ permissionModel: createBrokerPermissionModel({ grants }) });
  const session = registry.mintAppSession({ appId: "app.x", appInstanceId: "i", grants: ["fs.read", "fs.write"], token: "t" });

  const res = registry.authorize(session, "fs.write");

  assert.equal(res.ok, false);
  if (!res.ok) assert.equal(res.code, "CAP_DENIED");
});

// ===================================== api-origin: /rename, /move, /df =====================================

function req(method: string, path: string, body: unknown, headers: Record<string, string> = {}, query: Record<string, string> = {}): ApiRequest {
  const bytes = body === undefined ? new Uint8Array(0) : (body instanceof Uint8Array ? body : enc(JSON.stringify(body)));

  return Object.freeze({ body: bytes, headers, method, path, query });
}

test("api-origin: /df answers a quota (gated on fs.read) so the SDK's pre-write space check passes", () => {
  const grants = createAppGrantRegistry({ "app.full": ["fs.read", "fs.write", "auth"] });
  const capabilities = createCapabilityRegistry({ permissionModel: createBrokerPermissionModel({ grants }) });

  capabilities.mintAppSession({ appId: "app.full", appInstanceId: "i", grants: ["fs.read", "fs.write", "auth"], token: "tok" });
  const api = createApiOrigin({ capabilities, store: createMemoryStore() });

  const res = api.handle(req("POST", "/df", {}, { authorization: "Bearer tok" }));
  const parsed = JSON.parse(dec(res.body)) as { capacity?: number; used?: number };

  assert.equal(res.status, 200);
  assert.ok(typeof parsed.capacity === "number" && parsed.capacity > 0);
  assert.equal(parsed.used, 0);
});

test("api-origin: /rename moves a file in place; /move relocates to a new parent", () => {
  const grants = createAppGrantRegistry({ "app.full": ["fs.read", "fs.write", "auth"] });
  const capabilities = createCapabilityRegistry({ permissionModel: createBrokerPermissionModel({ grants }) });

  capabilities.mintAppSession({ appId: "app.full", appInstanceId: "i", grants: ["fs.read", "fs.write", "auth"], token: "tok" });
  const store = createMemoryStore();

  store.fs.write("/dir/a.txt", enc("payload"));
  const api = createApiOrigin({ capabilities, store });

  // rename a.txt -> b.txt (same dir)
  const rn = api.handle(req("POST", "/rename", { path: "/dir/a.txt", new_name: "b.txt" }, { authorization: "Bearer tok" }));

  assert.equal(rn.status, 200);
  assert.equal(store.fs.read("/dir/a.txt"), undefined);
  assert.equal(dec(store.fs.read("/dir/b.txt")!.bytes), "payload");

  // move /dir/b.txt -> /elsewhere (destination is the new PARENT dir)
  store.fs.mkdir("/elsewhere");
  const mv = api.handle(req("POST", "/move", { source: "/dir/b.txt", destination: "/elsewhere" }, { authorization: "Bearer tok" }));

  assert.equal(mv.status, 200);
  assert.equal(store.fs.read("/dir/b.txt"), undefined);
  assert.equal(dec(store.fs.read("/elsewhere/b.txt")!.bytes), "payload");
});

test("api-origin: /rename is DENIED 403 for an app without fs.write (broker-enforced)", () => {
  const grants = createAppGrantRegistry({ "app.ro": ["fs.read", "auth"] });
  const capabilities = createCapabilityRegistry({ permissionModel: createBrokerPermissionModel({ grants }) });

  capabilities.mintAppSession({ appId: "app.ro", appInstanceId: "i", grants: ["fs.read", "auth"], token: "rotok" });
  const store = createMemoryStore();

  store.fs.write("/a.txt", enc("x"));
  const api = createApiOrigin({ capabilities, store });

  const res = api.handle(req("POST", "/rename", { path: "/a.txt", new_name: "b.txt" }, { authorization: "Bearer rotok" }));
  const parsed = JSON.parse(dec(res.body)) as { code?: string };

  assert.equal(res.status, 403);
  assert.equal(parsed.code, "CAP_DENIED");
  // and the file was NOT moved
  assert.ok(store.fs.read("/a.txt") !== undefined);
  assert.equal(store.fs.read("/b.txt"), undefined);
});

// ===================================== owner-token face gate =====================================

test("ownerTokenFaceGate: allows the owner token (header/bearer/query), denies otherwise (401)", () => {
  const gate = ownerTokenFaceGate("OWNER-SECRET");
  const r = (headers: Record<string, string>, query: Record<string, string> = {}): ApiRequest => req("GET", "/whoami", undefined, headers, query);

  assert.equal(gate(r({ "x-vita-owner": "OWNER-SECRET" })), undefined); // header → allow
  assert.equal(gate(r({ authorization: "Bearer OWNER-SECRET" })), undefined); // bearer-equals-owner → allow
  assert.equal(gate(r({}, { vita_owner: "OWNER-SECRET" })), undefined); // query → allow

  assert.equal(gate(r({}))?.status, 401); // nothing → 401
  assert.equal(gate(r({ "x-vita-owner": "wrong" }))?.status, 401); // wrong → 401
  // a per-APP bearer that is not the owner token must NOT pass the owner gate.
  assert.equal(gate(r({ authorization: "Bearer some-app-token" }))?.status, 401);
});

// ===================================== DUAL-FACE integration (loopback + network, one store, restart) =====================================

test("dual-face backend: loopback + network share ONE store; network requires owner token; survives restart", async () => {
  const appsRoot = freshDir("vita-dualface-test-");
  const APP_TOKEN = "app-tok";
  const OWNER = "owner-secret-xyz";

  function build() {
    const grants = createAppGrantRegistry({ "app.full": ["fs.read", "fs.write", "kv.read", "kv.write", "auth"] });
    const capabilities = createCapabilityRegistry({ permissionModel: createBrokerPermissionModel({ grants }) });

    capabilities.mintAppSession({ appId: "app.full", appInstanceId: "i", grants: ["fs.read", "fs.write", "kv.read", "kv.write", "auth"], token: APP_TOKEN });
    const store = openAppStore({ appId: "app.full", appsRoot });

    return startDualFaceBackend({ capabilities, networkHost: "127.0.0.1", ownerToken: OWNER, staticRoot: appsRoot, store });
  }

  let backend = await build();

  try {
    const localApi = `${backend.local.url}/api`;
    const netApi = `${backend.network.url}/api`;

    // network face: no owner token → 401
    const noOwner = await fetch(`${netApi}/whoami`, { headers: { authorization: `Bearer ${APP_TOKEN}` } });

    assert.equal(noOwner.status, 401);

    // network face: with owner token → 200
    const withOwner = await fetch(`${netApi}/whoami`, { headers: { authorization: `Bearer ${APP_TOKEN}`, "x-vita-owner": OWNER } });

    assert.equal(withOwner.status, 200);

    // write via LOCAL face (multipart batch)
    const form = new FormData();

    form.append("operation", JSON.stringify({ name: "shared.txt", op: "write", operation_id: "0", overwrite: true, path: "/" }));
    form.append("fileinfo", JSON.stringify({ name: "shared.txt", size: 5, type: "text/plain" }));
    form.append("file", new Blob(["hello"], { type: "text/plain" }), "shared.txt");
    const w = await fetch(`${localApi}/batch`, { body: form, headers: { authorization: `Bearer ${APP_TOKEN}` }, method: "POST" });

    assert.equal(w.status, 200);

    // read via NETWORK face (ONE store) — owner token required
    const r = await fetch(`${netApi}/read?file=${encodeURIComponent("/shared.txt")}`, { headers: { authorization: `Bearer ${APP_TOKEN}`, "x-vita-owner": OWNER } });

    assert.equal(r.status, 200);
    assert.equal(await r.text(), "hello");
  } finally {
    await backend.close();
  }

  // RESTART: a fresh backend on the SAME on-disk root reads the value back.
  backend = await build();

  try {
    const localApi = `${backend.local.url}/api`;
    const r = await fetch(`${localApi}/read?file=${encodeURIComponent("/shared.txt")}`, { headers: { authorization: `Bearer ${APP_TOKEN}` } });

    assert.equal(r.status, 200);
    assert.equal(await r.text(), "hello");
  } finally {
    await backend.close();
    rmSync(appsRoot, { force: true, recursive: true });
  }
});

// ===================================== TLS (server/tls.ts) =====================================

test("tls: generateSelfSigned produces a valid, verifiable X.509 cert with the SAN host", () => {
  const m = generateSelfSigned("vita.local", 30);

  assert.equal(m.source, "self-signed");
  assert.ok(m.cert.includes("BEGIN CERTIFICATE"));
  assert.ok(m.key.includes("BEGIN PRIVATE KEY"));
  assert.ok(typeof m.fingerprintSha256 === "string" && m.fingerprintSha256.includes(":"));

  // The DER must parse as a real X.509 and carry the host as CN + SAN dNSName.
  const x = new X509Certificate(m.cert);

  assert.ok(x.subject.includes("vita.local"));
  assert.ok((x.subjectAltName ?? "").includes("vita.local"));
});

test("tls: resolveTlsMaterial prefers owner-provided cert+key, else self-signs", () => {
  // No paths → self-signed.
  assert.equal(resolveTlsMaterial({}).source, "self-signed");

  // Owner-provided paths that exist → owner-provided (write the self-signed material to disk first).
  const dir = freshDir("vita-tls-owner-");

  try {
    const gen = generateSelfSigned("owner.example", 30);
    const certPath = join(dir, "cert.pem");
    const keyPath = join(dir, "key.pem");

    writeFileSync(certPath, gen.cert);
    writeFileSync(keyPath, gen.key);

    const m = resolveTlsMaterial({ certPath, keyPath });

    assert.equal(m.source, "owner-provided");
    assert.equal(m.cert, gen.cert);
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

test("tls: resolveTlsMaterial throws (fail-loud) when an owner-provided cert path is missing", () => {
  assert.throws(() => resolveTlsMaterial({ certPath: "/no/such/cert.pem", keyPath: "/no/such/key.pem" }), /TLS cert not found/u);
});

// ===================================== consolidated service (server/service.ts) =====================================

test("service: mode → faces mapping (headless=network-only, local-desktop=local-only, network-desktop=both)", async () => {
  // headless: network face only (TLS), no local face.
  {
    const root = freshDir("vita-svc-hl-");
    const svc = await startPuterPlatformService({ appsRoot: root, faces: { networkHost: "127.0.0.1" }, mode: "headless" });

    try {
      assert.equal(svc.localUrl, undefined);
      assert.equal(svc.kioskUrl, undefined);
      assert.ok(svc.networkUrl?.startsWith("https://"));
      assert.equal(svc.tls?.source, "self-signed");
    } finally {
      await svc.close();
      rmSync(root, { force: true, recursive: true });
    }
  }

  // local-desktop: local face only (plain loopback), no network face.
  {
    const root = freshDir("vita-svc-ld-");
    const svc = await startPuterPlatformService({ appsRoot: root, faces: { localHost: "127.0.0.1" }, mode: "local-desktop" });

    try {
      assert.ok(svc.localUrl?.startsWith("http://"));
      assert.equal(svc.kioskUrl, `${svc.localUrl}${KIOSK_ENTRY_PATH}`);
      assert.equal(svc.networkUrl, undefined);
      assert.equal(svc.tls, undefined);
    } finally {
      await svc.close();
      rmSync(root, { force: true, recursive: true });
    }
  }
});

test("service: SINGLE SHARED registry mints app tokens in-process; the api_origin honors them; broker enforces", async () => {
  const root = freshDir("vita-svc-reg-");
  const svc = await startPuterPlatformService({
    appGrants: { "app.full": ["fs.read", "fs.write", "auth"], "app.ro": ["fs.read", "auth"] },
    appsRoot: root,
    faces: { localHost: "127.0.0.1" },
    mode: "local-desktop",
  });

  try {
    const full = svc.mintApp({ appId: "app.full", grants: ["fs.read", "fs.write", "auth"], instanceId: "i1" });
    const ro = svc.mintApp({ appId: "app.ro", grants: ["fs.read", "auth"], instanceId: "i2" });
    const localApi = `${svc.localUrl}/api`;

    // full app: write succeeds (the host-minted token is honored by the SAME-process api_origin).
    const form = new FormData();

    form.append("operation", JSON.stringify({ name: "a.txt", op: "write", operation_id: "0", overwrite: true, path: "/" }));
    form.append("fileinfo", JSON.stringify({ name: "a.txt", size: 2, type: "text/plain" }));
    form.append("file", new Blob(["hi"], { type: "text/plain" }), "a.txt");
    const w = await fetch(`${localApi}/batch`, { body: form, headers: { authorization: `Bearer ${full.token}` }, method: "POST" });

    assert.equal(w.status, 200);

    // read-only app: a write is DENIED 403 (broker CAP_DENIED) even though it is a validly minted token.
    const form2 = new FormData();

    form2.append("operation", JSON.stringify({ name: "blocked.txt", op: "write", operation_id: "0", overwrite: true, path: "/" }));
    form2.append("fileinfo", JSON.stringify({ name: "blocked.txt", size: 1, type: "text/plain" }));
    form2.append("file", new Blob(["x"], { type: "text/plain" }), "blocked.txt");
    const blocked = await fetch(`${localApi}/batch`, { body: form2, headers: { authorization: `Bearer ${ro.token}` }, method: "POST" });

    assert.equal(blocked.status, 403);
    assert.equal(((await blocked.json()) as { code?: string }).code, "CAP_DENIED");
  } finally {
    await svc.close();
    rmSync(root, { force: true, recursive: true });
  }
});

test("service: TLS network face — owner token over a genuine (pinned-CA) TLS handshake; no-owner → 401", async () => {
  const root = freshDir("vita-svc-tls-");
  const svc = await startPuterPlatformService({ appsRoot: root, faces: { networkHost: "127.0.0.1" }, mode: "network-desktop", storeAppId: "puter" });

  try {
    const netUrl = svc.networkUrl!;
    const cert = svc.tls!.cert;
    const port = Number(new URL(netUrl).port);

    // 1) genuine TLS handshake with the server cert PINNED as the CA (strict verification ON).
    const authorized = await new Promise<boolean>((res) => {
      const sock = tlsConnect({ ca: cert, host: "127.0.0.1", port, servername: "vita.local" }, () => {
        const ok = sock.authorized;

        sock.end();
        res(ok);
      });

      sock.on("error", () => res(false));
    });

    assert.equal(authorized, true);

    // 2) kiosk entry over TLS: 401 without owner token, 200 with it (verification stays ON via per-req CA).
    const get = (path: string, headers: Record<string, string>): Promise<{ status: number; body: string }> =>
      new Promise((res, rej) => {
        const u = new URL(`${netUrl}${path}`);
        const r = httpsRequest({ ca: cert, headers, host: u.hostname, method: "GET", path: u.pathname + u.search, port: u.port, servername: "vita.local" }, (resp) => {
          const chunks: Buffer[] = [];

          resp.on("data", (c: Buffer) => chunks.push(c));
          resp.on("end", () => res({ body: Buffer.concat(chunks).toString("utf8"), status: resp.statusCode ?? 0 }));
        });

        r.on("error", rej);
        r.end();
      });

    const noOwner = await get(KIOSK_ENTRY_PATH, {});

    assert.equal(noOwner.status, 401);

    const withOwner = await get(KIOSK_ENTRY_PATH, { "x-vita-owner": svc.ownerToken });

    assert.equal(withOwner.status, 200);
    assert.ok(withOwner.body.includes("/_vendor/puter/v2.js"));
  } finally {
    await svc.close();
    rmSync(root, { force: true, recursive: true });
  }
});

test("service: LOCAL face /session.js publishes the minted kiosk token and the SDK whoami clears the gate; NETWORK face 404s it (no leak)", async () => {
  const root = freshDir("vita-svc-session-");
  // network-desktop = BOTH faces, so we can assert the local face serves the token AND the network face hides it.
  const svc = await startPuterPlatformService({ appsRoot: root, faces: { localHost: "127.0.0.1", networkHost: "127.0.0.1" }, mode: "network-desktop", storeAppId: "vita.kiosk" });

  try {
    const localUrl = svc.localUrl!;

    // Before the kiosk session is published, /session.js serves a benign NO-token stub (still 200, no token).
    const before = await fetch(`${localUrl}/session.js`);

    assert.equal(before.status, 200);
    const beforeBody = await before.text();

    assert.ok(beforeBody.includes("var token = \"\";"), "pre-mint /session.js must carry an empty token");

    // The boot entry mints the well-known kiosk app session, then publishes it to the local face.
    const kiosk = svc.mintApp({ appId: "vita.kiosk", grants: ["fs.read", "fs.write", "kv.read", "kv.write", "auth"], instanceId: "boot-test" });

    svc.setLocalSessionToken(kiosk.token);

    // (1) LOCAL face: /session.js now embeds the minted token + points the SDK at /api.
    const sess = await fetch(`${localUrl}/session.js`);

    assert.equal(sess.status, 200);
    assert.equal(sess.headers.get("content-type"), "text/javascript; charset=utf-8");
    const body = await sess.text();

    assert.ok(body.includes(`var token = ${JSON.stringify(kiosk.token)};`), "/session.js must embed the minted token");
    assert.ok(body.includes('window.location.origin + "/api"'), "/session.js must point the SDK at the same-origin /api");
    assert.ok(body.includes("setAuthToken"), "/session.js must call setAuthToken");

    // (2) Using that token, the SDK's whoami path (GET /api/whoami with the bearer) returns 200 owner —
    //     the very call kiosk-entry.html makes after /session.js runs. This is the no-401 proof.
    const who = await fetch(`${localUrl}/api/whoami`, { headers: { authorization: `Bearer ${kiosk.token}` } });

    assert.equal(who.status, 200);
    assert.equal(((await who.json()) as { username?: string }).username, "owner");

    // A whoami WITHOUT the token is still 401 (the gate is genuinely on — the token is what clears it).
    const noTok = await fetch(`${localUrl}/api/whoami`);

    assert.equal(noTok.status, 401);

    // (3) NETWORK face: /session.js must NOT be served (no token provider there). With the owner token the
    //     request clears the face gate yet still 404s — proving the kiosk token is never reachable remotely.
    const netUrl = svc.networkUrl!;
    const cert = svc.tls!.cert;
    const u = new URL(`${netUrl}/session.js`);
    const netStatus = await new Promise<number>((res, rej) => {
      const r = httpsRequest({ ca: cert, headers: { "x-vita-owner": svc.ownerToken }, host: u.hostname, method: "GET", path: u.pathname, port: u.port, servername: "vita.local" }, (resp) => {
        resp.on("data", () => undefined);
        resp.on("end", () => res(resp.statusCode ?? 0));
      });

      r.on("error", rej);
      r.end();
    });

    assert.equal(netStatus, 404);
  } finally {
    await svc.close();
    rmSync(root, { force: true, recursive: true });
  }
});
