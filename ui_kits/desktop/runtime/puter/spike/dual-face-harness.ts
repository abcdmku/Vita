// Dual-face on-device backend harness — the PROOF for the on-device wave. No browser, no VM.
//
// Proves, end-to-end over REAL HTTP against the REAL api_origin + REAL persisted store + REAL broker
// enforcement:
//   (a) PERSISTENCE ACROSS RESTART — write through the backend, CLOSE the backend (drop all in-process
//       state), RE-OPEN a fresh backend on the SAME on-disk app root, read the value back.
//   (b) REAL ENFORCEMENT — a request lacking the required grant returns 403 (CAP_DENIED, decided by the
//       platform permission-broker), and a granted request passes. A bad bearer is 401.
//   (c) DUAL-FACE / ONE STORE — the SAME api_origin reached from a LOCALHOST (kiosk/trust-on-host) client
//       AND a NETWORK-BOUND (owner-token) client, both doing fs/kv against ONE store: a file written via
//       the local face is read via the network face, and vice-versa. The network face REJECTS a client
//       with no owner token (401) and ACCEPTS one with it.
//   (d) BREADTH — the wider op set the real SDK demands: fs write/read/readdir/stat/mkdir/delete/rename,
//       kv get/set/del/list, auth whoami — each driven with the SDK's exact request shape.
//   (e) TLS NETWORK FACE — the CONSOLIDATED on-device service (server/service.ts) with a REAL TLS
//       network face: the owner token is presented over a genuine TLS handshake (the self-signed cert
//       PINNED as the CA, strict verification ON), the kiosk entry + vendored SDK are served owner-gated
//       over TLS, and a no-owner-token request over TLS is rejected (401). Proves the bearer secret only
//       ever travels encrypted on the network face.
//
// Run: node --experimental-strip-types ui_kits/desktop/runtime/puter/spike/dual-face-harness.ts
//      [--apps-root <dir>]  (default: a fresh temp dir; the dir PERSISTS across the restart step)

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";

import { createCapabilityRegistry } from "../capability.ts";
import { createAppGrantRegistry, createBrokerPermissionModel } from "../permission-model.ts";
import { openAppStore } from "../fs-store.ts";
import { startDualFaceBackend, type DualFaceBackend } from "../backend.ts";
import { startPuterPlatformService } from "../server/service.ts";

const APP_ID = "spike.puter.testapp";
const APP_TOKEN = "app-session-token-cafef00d"; // the per-app session token the api_origin mints/honors
const INSTANCE = "dualface-instance-0001";
const OWNER_TOKEN = "owner-secret-token-0123456789abcdef"; // the network-face owner secret

const READONLY_APP_ID = "spike.puter.readonly";
const READONLY_TOKEN = "readonly-session-token-deadbeef";
const READONLY_INSTANCE = "dualface-readonly-0001";

interface Check {
  readonly name: string;
  readonly ok: boolean;
  readonly detail: string;
}

const checks: Check[] = [];
function record(name: string, ok: boolean, detail = ""): void {
  checks.push({ detail, name, ok });
  console.log(`[dual-face] ${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
}

// Build a backend bound to TWO faces over ONE store + ONE registry (broker-enforced), under `appsRoot`.
// The app-grant registry declares: APP_ID = full fs+kv+auth; READONLY_APP_ID = fs.read+kv.read+auth.
function buildBackend(appsRoot: string): Promise<DualFaceBackend> {
  const grants = createAppGrantRegistry({
    [APP_ID]: ["fs.read", "fs.write", "kv.read", "kv.write", "auth"],
    [READONLY_APP_ID]: ["fs.read", "kv.read", "auth"],
  });
  const capabilities = createCapabilityRegistry({ permissionModel: createBrokerPermissionModel({ grants }) });

  capabilities.mintAppSession({ appId: APP_ID, appInstanceId: INSTANCE, grants: ["fs.read", "fs.write", "kv.read", "kv.write", "auth"], token: APP_TOKEN });
  capabilities.mintAppSession({ appId: READONLY_APP_ID, appInstanceId: READONLY_INSTANCE, grants: ["fs.read", "kv.read", "auth"], token: READONLY_TOKEN });

  // The store is opened under <appsRoot>/<APP_ID> — the on-device convention. RE-opening the same root
  // re-reads the persisted subtree (that is the restart proof).
  const store = openAppStore({ appId: APP_ID, appsRoot });

  return startDualFaceBackend({
    capabilities,
    networkHost: "127.0.0.1", // harness: bind the "network" face on loopback (a different port) — test-safe
    ownerToken: OWNER_TOKEN,
    staticRoot: appsRoot,
    store,
  });
}

async function main(): Promise<void> {
  const appsRoot = arg("apps-root") ?? mkdtempSync(`${tmpdir()}/vita-puter-dualface-`);
  let cleanup = true;

  if (arg("apps-root") !== undefined) cleanup = false; // caller-provided: don't delete

  console.log(`[dual-face] apps root: ${appsRoot}`);

  // ============================ FACE 1 + FACE 2 + breadth + enforcement ============================
  let backend = await buildBackend(appsRoot);

  try {
    const localApi = `${backend.local.url}/api`;
    const netApi = `${backend.network.url}/api`;

    console.log(`[dual-face] local  face: ${backend.local.url} (trust-on-host)`);
    console.log(`[dual-face] network face: ${backend.network.url} (owner-token)`);

    // ---- (c) network face REJECTS missing owner token (401) ----
    {
      const res = await fetch(`${netApi}/whoami`, { headers: { authorization: `Bearer ${APP_TOKEN}` } });

      record("network face: no owner token → 401", res.status === 401, `status ${res.status}`);
    }

    // ---- (c) network face ACCEPTS owner token + valid app token ----
    {
      const res = await fetch(`${netApi}/whoami`, { headers: { authorization: `Bearer ${APP_TOKEN}`, "x-vita-owner": OWNER_TOKEN } });
      const me = (await res.json().catch(() => ({}))) as { username?: string };

      record("network face: owner token + app token → whoami owner", res.ok && me.username === "owner", `status ${res.status}, user ${JSON.stringify(me.username)}`);
    }

    // ---- (d) breadth: fs.write/read/readdir/stat/mkdir/delete/rename via the LOCAL face ----
    {
      const w = await batchWrite(localApi, APP_TOKEN, "/notes/a.txt", "alpha");

      record("breadth fs.write (/batch)", w.status === 200, `status ${w.status}`);
    }
    {
      const r = await fetch(`${localApi}/read?file=${encodeURIComponent("/notes/a.txt")}`, { headers: bearer(APP_TOKEN) });
      const text = await r.text();

      record("breadth fs.read (GET /read?file=)", r.ok && text === "alpha", `=> ${JSON.stringify(text)}`);
    }
    {
      const r = await postJson(`${localApi}/stat`, { auth_token: APP_TOKEN, path: "/notes/a.txt" });
      const entry = r.body as { name?: string; is_dir?: boolean };

      record("breadth fs.stat (/stat, body token)", r.ok && entry.name === "a.txt" && entry.is_dir === false, `name ${JSON.stringify(entry.name)}`);
    }
    {
      const r = await postJson(`${localApi}/mkdir`, null, bearer(APP_TOKEN), { parent: "/", path: "sub" });

      record("breadth fs.mkdir (/mkdir, bearer)", r.ok && (r.body as { is_dir?: boolean }).is_dir === true, `status ${r.status}`);
    }
    {
      const r = await postJson(`${localApi}/readdir`, { auth_token: APP_TOKEN, path: "/" });
      const names = (r.body as { name: string }[]).map((e) => e.name).sort();

      record("breadth fs.readdir (/readdir, body token)", r.ok && names.includes("notes") && names.includes("sub"), `entries => ${names.join(", ")}`);
    }
    {
      // rename a.txt → b.txt (same dir)
      const r = await postJson(`${localApi}/rename`, null, bearer(APP_TOKEN), { path: "/notes/a.txt", new_name: "b.txt" });
      const after = await postJson(`${localApi}/stat`, { auth_token: APP_TOKEN, path: "/notes/b.txt" });

      record("breadth fs.rename (/rename)", r.ok && after.ok && (after.body as { name?: string }).name === "b.txt", `status ${r.status}`);
    }
    {
      const r = await postJson(`${localApi}/delete`, null, bearer(APP_TOKEN), { path: "/sub", recursive: true });
      const gone = await postJson(`${localApi}/stat`, { auth_token: APP_TOKEN, path: "/sub" });

      record("breadth fs.delete (/delete)", r.ok && gone.status === 404, `delete ${r.status}, stat ${gone.status}`);
    }

    // ---- (d) breadth: kv get/set/del/list via the LOCAL face ----
    {
      await driversCall(localApi, APP_TOKEN, "set", { key: "k1", value: "v1" });
      await driversCall(localApi, APP_TOKEN, "set", { key: "k2", value: "v2" });
      const got = await driversCall(localApi, APP_TOKEN, "get", { key: "k1" });
      const del = await driversCall(localApi, APP_TOKEN, "del", { key: "k2" });
      const list = await driversCall(localApi, APP_TOKEN, "list", { as: "kv" });
      const keys = ((list.body as { result?: { key: string }[] }).result ?? []).map((e) => e.key).sort();

      record(
        "breadth kv get/set/del/list (/drivers/call)",
        (got.body as { result?: unknown }).result === "v1" && del.ok && keys.includes("k1") && !keys.includes("k2"),
        `keys => ${keys.join(", ")}`,
      );
    }

    // ---- (c) DUAL-FACE ONE STORE: write via LOCAL face, read via NETWORK face ----
    {
      await batchWrite(localApi, APP_TOKEN, "/shared/local-wrote.txt", "from-local-face");
      const r = await fetch(`${netApi}/read?file=${encodeURIComponent("/shared/local-wrote.txt")}`, { headers: { authorization: `Bearer ${APP_TOKEN}`, "x-vita-owner": OWNER_TOKEN } });
      const text = await r.text();

      record("dual-face: local-written file read via network face", r.ok && text === "from-local-face", `=> ${JSON.stringify(text)}`);
    }

    // ---- (c) DUAL-FACE ONE STORE: write via NETWORK face, read via LOCAL face ----
    {
      const netHeaders = { "x-vita-owner": OWNER_TOKEN };
      const w = await batchWrite(netApi, APP_TOKEN, "/shared/net-wrote.txt", "from-network-face", netHeaders);
      const r = await fetch(`${localApi}/read?file=${encodeURIComponent("/shared/net-wrote.txt")}`, { headers: bearer(APP_TOKEN) });
      const text = await r.text();

      record("dual-face: network-written file read via local face", w.status === 200 && r.ok && text === "from-network-face", `write ${w.status}, read => ${JSON.stringify(text)}`);
    }

    // ---- (b) REAL ENFORCEMENT: a grant the app DOES NOT hold → 403 (broker CAP_DENIED) ----
    {
      // READONLY app holds fs.read but NOT fs.write — a write must be DENIED 403 (decided by the broker).
      const w = await batchWrite(localApi, READONLY_TOKEN, "/blocked.txt", "should not persist");
      const body = w.body as { code?: string };

      record("enforcement: ungranted fs.write → 403 CAP_DENIED", w.status === 403 && body.code === "CAP_DENIED", `status ${w.status}, code ${JSON.stringify(body.code)}`);
    }
    {
      // The SAME app's granted fs.read passes.
      const r = await fetch(`${localApi}/read?file=${encodeURIComponent("/notes/b.txt")}`, { headers: bearer(READONLY_TOKEN) });

      record("enforcement: granted fs.read passes", r.ok, `status ${r.status}`);
    }
    {
      // Bad bearer → 401 (UNAUTHENTICATED, distinct from CAP_DENIED).
      const r = await postJson(`${localApi}/readdir`, { auth_token: "not-a-real-token", path: "/" });

      record("enforcement: bad token → 401 UNAUTHENTICATED", r.status === 401, `status ${r.status}`);
    }
  } finally {
    await backend.close();
  }

  // ============================ (a) PERSISTENCE ACROSS RESTART ============================
  // The first backend is fully CLOSED (all in-process state dropped). Re-open a FRESH backend on the
  // SAME on-disk appsRoot and read a value written before the restart.
  backend = await buildBackend(appsRoot);

  try {
    const localApi = `${backend.local.url}/api`;
    const r = await fetch(`${localApi}/read?file=${encodeURIComponent("/shared/local-wrote.txt")}`, { headers: bearer(APP_TOKEN) });
    const text = await r.text();

    record("persistence: value survives a full backend restart (re-read from disk)", r.ok && text === "from-local-face", `=> ${JSON.stringify(text)}`);

    // kv too
    const got = await driversCall(localApi, APP_TOKEN, "get", { key: "k1" });

    record("persistence: kv value survives restart", (got.body as { result?: unknown }).result === "v1", `k1 => ${JSON.stringify((got.body as { result?: unknown }).result)}`);
  } finally {
    await backend.close();
    if (cleanup) rmSync(appsRoot, { force: true, recursive: true });
  }

  // ============================ (e) TLS NETWORK FACE (consolidated service) ============================
  // Spin up the CONSOLIDATED on-device service (server/service.ts) in network-desktop mode with a REAL
  // TLS network face, and prove the owner token only travels over a genuine, verified TLS handshake.
  await proveTlsNetworkFace();

  const passed = checks.filter((c) => c.ok).length;

  console.log(`[dual-face] === ${passed}/${checks.length} checks passed ===`);
  console.log(`[dual-face] SUMMARY ${JSON.stringify({ passed, total: checks.length })}`);
  if (passed !== checks.length) process.exitCode = 1;
}

// ----------------------------- (e) TLS network-face proof -----------------------------

// Prove the consolidated service's TLS network face: a real TLS handshake (cert pinned as CA, strict
// verification ON), owner-gated kiosk-entry + vendored SDK over TLS, fs round-trip over TLS, and a
// no-owner-token request over TLS rejected (401). No global TLS-insecure flag — verification stays on.
async function proveTlsNetworkFace(): Promise<void> {
  const { connect } = await import("node:tls");
  const tlsAppsRoot = mkdtempSync(`${tmpdir()}/vita-puter-tls-`);
  const svc = await startPuterPlatformService({
    appsRoot: tlsAppsRoot,
    faces: { networkHost: "127.0.0.1" },
    mode: "network-desktop",
    storeAppId: "puter",
  });

  try {
    const netUrl = svc.networkUrl;
    const tls = svc.tls;

    record("tls: network face is https + self-signed cert minted", netUrl !== undefined && netUrl.startsWith("https://") && tls?.source === "self-signed", `url ${netUrl ?? "(none)"}, src ${tls?.source ?? "(none)"}`);

    if (netUrl === undefined || tls === undefined) return;

    const port = Number(new URL(netUrl).port);

    // --- a genuine TLS handshake with the server's OWN cert pinned as the trusted CA (strict) ---
    const authorized = await new Promise<boolean>((res) => {
      const sock = connect({ ca: tls.cert, host: "127.0.0.1", port, servername: "vita.local" }, () => {
        const ok = sock.authorized;

        sock.end();
        res(ok);
      });

      sock.on("error", () => res(false));
    });

    record("tls: strict TLS handshake authorized with pinned self-signed cert", authorized, `authorized=${authorized}`);

    // --- fetch over TLS with the cert pinned (verification ON via a per-request CA) ---
    // Node's global fetch can't take a per-call CA, so use node:https directly with the pinned CA.
    const app = svc.mintApp({ appId: "puter", grants: ["fs.read", "fs.write", "auth"], instanceId: "i-tls" });

    // owner-gated kiosk entry over TLS: 401 without owner, 200 with owner.
    const noOwner = await httpsGet(`${netUrl}/kiosk-entry.html`, tls.cert, {});

    record("tls: kiosk entry over TLS WITHOUT owner token → 401", noOwner.status === 401, `status ${noOwner.status}`);

    const withOwner = await httpsGet(`${netUrl}/kiosk-entry.html`, tls.cert, { "x-vita-owner": svc.ownerToken });

    record("tls: kiosk entry over TLS WITH owner token → 200 + serves puter.js", withOwner.status === 200 && withOwner.body.includes("/_vendor/puter/v2.js"), `status ${withOwner.status}`);

    const sdk = await httpsGet(`${netUrl}/_vendor/puter/v2.js`, tls.cert, { "x-vita-owner": svc.ownerToken });

    record("tls: vendored puter.js served owner-gated over TLS", sdk.status === 200 && sdk.body.length > 100000, `status ${sdk.status}, bytes ${sdk.body.length}`);

    // fs round-trip over the TLS network face with owner token + app token.
    const w = await httpsBatchWrite(`${netUrl}/api/batch`, tls.cert, app.token, svc.ownerToken, "/tls-note.txt", "over-tls");

    record("tls: fs.write over TLS network face (owner+app token) → 200", w.status === 200, `status ${w.status}`);

    const r = await httpsGet(`${netUrl}/api/read?file=${encodeURIComponent("/tls-note.txt")}`, tls.cert, { authorization: `Bearer ${app.token}`, "x-vita-owner": svc.ownerToken });

    record("tls: fs.read over TLS network face returns the value", r.status === 200 && r.body === "over-tls", `=> ${JSON.stringify(r.body)}`);
  } finally {
    await svc.close();
    rmSync(tlsAppsRoot, { force: true, recursive: true });
  }
}

// GET over TLS with the server cert PINNED as the CA (strict verification on, no global insecure flag).
async function httpsGet(url: string, ca: string, headers: Record<string, string>): Promise<{ status: number; body: string }> {
  const https = await import("node:https");
  const u = new URL(url);

  return new Promise((res, rej) => {
    const req = https.request(
      { ca, headers, host: u.hostname, method: "GET", path: u.pathname + u.search, port: u.port, servername: "vita.local" },
      (resp) => {
        const chunks: Buffer[] = [];

        resp.on("data", (c: Buffer) => chunks.push(c));
        resp.on("end", () => res({ body: Buffer.concat(chunks).toString("utf8"), status: resp.statusCode ?? 0 }));
      },
    );

    req.on("error", rej);
    req.end();
  });
}

// The SDK's multipart /batch write, over TLS with the pinned CA + owner token.
async function httpsBatchWrite(url: string, ca: string, appToken: string, ownerToken: string, path: string, content: string): Promise<{ status: number }> {
  const https = await import("node:https");
  const u = new URL(url);
  const name = path.split("/").pop() ?? path;
  const parent = path.slice(0, path.length - name.length).replace(/\/$/u, "") || "/";
  const boundary = `----vita-tls-${Date.now().toString(16)}`;
  const parts = [
    `--${boundary}\r\nContent-Disposition: form-data; name="operation"\r\n\r\n${JSON.stringify({ name, op: "write", operation_id: "0", overwrite: true, path: parent })}\r\n`,
    `--${boundary}\r\nContent-Disposition: form-data; name="fileinfo"\r\n\r\n${JSON.stringify({ name, size: content.length, type: "text/plain" })}\r\n`,
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${name}"\r\nContent-Type: text/plain\r\n\r\n${content}\r\n`,
    `--${boundary}--\r\n`,
  ];
  const body = Buffer.from(parts.join(""), "utf8");

  return new Promise((res, rej) => {
    const req = https.request(
      {
        ca,
        headers: { authorization: `Bearer ${appToken}`, "content-length": body.length, "content-type": `multipart/form-data; boundary=${boundary}`, "x-vita-owner": ownerToken },
        host: u.hostname,
        method: "POST",
        path: u.pathname + u.search,
        port: u.port,
        servername: "vita.local",
      },
      (resp) => {
        resp.on("data", () => undefined);
        resp.on("end", () => res({ status: resp.statusCode ?? 0 }));
      },
    );

    req.on("error", rej);
    req.write(body);
    req.end();
  });
}

// ----------------------------- request shape helpers (mirror the SDK) -----------------------------

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);

  return i >= 0 ? process.argv[i + 1] : undefined;
}

function bearer(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}` };
}

async function postJson(
  url: string,
  jsonBody: Record<string, unknown> | null,
  extraHeaders: Record<string, string> = {},
  bodyOverride?: Record<string, unknown>,
): Promise<{ ok: boolean; status: number; body: unknown }> {
  const body = bodyOverride ?? jsonBody ?? {};
  const res = await fetch(url, {
    body: JSON.stringify(body),
    headers: { "content-type": "application/json", ...extraHeaders },
    method: "POST",
  });
  const parsed = await res.json().catch(() => ({}));

  return { body: parsed, ok: res.ok, status: res.status };
}

// Build the SDK's /batch multipart write (path = parent dir, name = leaf) and POST it. `extraHeaders`
// lets the network face add the owner token.
async function batchWrite(base: string, token: string, path: string, content: string, extraHeaders: Record<string, string> = {}): Promise<{ status: number; body: unknown }> {
  const name = path.split("/").pop() ?? path;
  const parent = path.slice(0, path.length - name.length).replace(/\/$/u, "") || "/";
  const form = new FormData();

  form.append("operation", JSON.stringify({ name, op: "write", operation_id: "0", overwrite: true, path: parent }));
  form.append("fileinfo", JSON.stringify({ name, size: content.length, type: "text/plain" }));
  form.append("file", new Blob([content], { type: "text/plain" }), name);

  const res = await fetch(`${base}/batch`, { body: form, headers: { authorization: `Bearer ${token}`, ...extraHeaders }, method: "POST" });
  const body = await res.json().catch(() => ({}));

  return { body, status: res.status };
}

async function driversCall(base: string, token: string, method: string, args: Record<string, unknown>): Promise<{ ok: boolean; status: number; body: unknown }> {
  const res = await fetch(`${base}/drivers/call`, {
    body: JSON.stringify({ args, interface: "puter-kvstore", method }),
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    method: "POST",
  });
  const body = await res.json().catch(() => ({}));

  return { body, ok: res.ok, status: res.status };
}

main().catch((err: unknown) => {
  console.error(`[dual-face] FATAL ${err instanceof Error ? err.stack : String(err)}`);
  process.exitCode = 1;
});
