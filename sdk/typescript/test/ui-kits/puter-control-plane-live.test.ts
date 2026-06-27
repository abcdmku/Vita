// control-plane LIVE-wiring tests — exercise the production path the deploy console uses on a real node:
//   1. createAgentHttpControlPlane against agentd's REAL JSON shapes (GET /state, GET
//      /read/capsule.execute, POST /apply, GET /healthz, GET /read/capsule.logs). A fetch stub stands
//      in for agentd, returning the exact shapes agentd's transport emits, so this locks the bridge
//      contract — including the NEW capsule.logs endpoint — without a node boot.
//   2. createAgentdUnixFetch — the host-proxy fetch that dials agentd's unix socket. A fake Deno
//      connection captures the HTTP/1.1 request bytes and replays a canned response, so the wire
//      encoding (request line, Host, Content-Length, body) + response parsing (status, chunked) are
//      verified without a real socket.
//
// Run: node --experimental-strip-types --test sdk/typescript/test/ui-kits/puter-control-plane-live.test.ts

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  type AgentControlPlane,
  type LogLine,
  createAgentHttpControlPlane,
} from "../../../../ui_kits/desktop/runtime/puter/control-plane.ts";
import { createAgentdUnixFetch } from "../../../../ui_kits/desktop/runtime/puter/server/agentd-host-proxy.ts";

// ---- agentd shape fixtures (what the Go transport emits) ----

const CAPSULE_ID = "dev.vita.notes";
const INTEGRITY = "sha256:0000000000000000000000000000000000000000000000000000000000000000";

// GET /state → { capabilities: { "capsule.registry": {...}, "capsule.execute": {...}, ... } }. The
// bridge folds capsule.registry.capsules with capsule.execute.last (see control-plane.ts mapping).
function stateBody(running: boolean): string {
  return JSON.stringify({
    capabilities: {
      "capsule.registry": {
        capsules: [{ id: CAPSULE_ID, version: "1.0.0", integrity: INTEGRITY, state: "installed" }],
      },
      "capsule.execute": {
        last: running
          ? { id: CAPSULE_ID, version: "1.0.0", unit: "vita-capsule-dev-vita-notes-abcd1234.service", dynamicUid: "61999", health: "OK", status: "OK" }
          : { id: CAPSULE_ID, unit: "", dynamicUid: "", health: "unknown", status: "" },
      },
    },
  });
}

// A fetch stub over a routing table keyed by "METHOD path". Returns a real Response so the bridge's
// .ok/.status/.json() reads are exact.
function fetchStub(routes: Record<string, () => { status?: number; body: unknown }>): typeof fetch {
  const handler = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const urlText = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const url = new URL(urlText);
    const method = (init?.method ?? "GET").toUpperCase();
    const key = `${method} ${url.pathname}${url.search}`;
    const exact = routes[key];
    const byPath = routes[`${method} ${url.pathname}`];
    const route = exact ?? byPath;

    if (route === undefined) return new Response("not found", { status: 404 });

    const { status, body } = route();

    return new Response(JSON.stringify(body), { status: status ?? 200 });
  };

  return handler as typeof fetch;
}

function liveClient(routes: Record<string, () => { status?: number; body: unknown }>): AgentControlPlane {
  return createAgentHttpControlPlane({ baseUrl: "http://agentd", fetch: fetchStub(routes) });
}

test("live: status folds /healthz + /state into the node header summary", async () => {
  const cp = liveClient({
    "GET /healthz": () => ({ body: { status: "ok" } }),
    "GET /state": () => ({ body: JSON.parse(stateBody(true)) }),
  });

  const status = await cp.status();
  assert.equal(status.ready, true);
  assert.equal(status.installedCount, 1);
  assert.equal(status.runningCount, 1);
});

test("live: listApps folds capsule.registry + capsule.execute into one row", async () => {
  const cp = liveClient({ "GET /state": () => ({ body: JSON.parse(stateBody(true)) }) });

  const apps = await cp.listApps();
  assert.equal(apps.length, 1);
  assert.equal(apps[0]?.id, CAPSULE_ID);
  assert.equal(apps[0]?.running, true);
  assert.equal(apps[0]?.health, "OK");
  assert.equal(apps[0]?.installState, "installed");
});

test("live: start posts capsule.execute apply with the installed integrity", async () => {
  let applied: unknown;
  const cp = liveClient({
    "GET /state": () => ({ body: JSON.parse(stateBody(false)) }),
    "GET /read/capsule.execute": () => ({ body: { last: { id: CAPSULE_ID, unit: "u.service", dynamicUid: "1", health: "OK", status: "OK" } } }),
    "POST /apply": () => ({ body: { outcome: "committed" } }),
  });

  // Re-wrap the apply route to capture the posted plan.
  const capturingFetch: typeof fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const urlText = typeof input === "string" ? input : input instanceof URL ? input.href : (input as Request).url;
    if (new URL(urlText).pathname === "/apply") {
      applied = JSON.parse(typeof init?.body === "string" ? init.body : "{}");
      return new Response(JSON.stringify({ outcome: "committed" }), { status: 200 });
    }
    if (new URL(urlText).pathname === "/state") return new Response(stateBody(false), { status: 200 });
    if (new URL(urlText).pathname === "/read/capsule.execute") {
      return new Response(JSON.stringify({ last: { id: CAPSULE_ID, unit: "u.service", dynamicUid: "1", health: "OK", status: "OK" } }), { status: 200 });
    }
    return new Response("{}", { status: 200 });
  }) as typeof fetch;

  const direct = createAgentHttpControlPlane({ baseUrl: "http://agentd", fetch: capturingFetch });
  const result = await direct.start(CAPSULE_ID);
  assert.equal(result.outcome, "committed");

  const ops = (applied as { operations?: Array<{ capability: string; request: { desired: { id: string; integrity: string } } }> }).operations ?? [];
  assert.equal(ops[0]?.capability, "capsule.execute");
  assert.equal(ops[0]?.request.desired.id, CAPSULE_ID);
  assert.equal(ops[0]?.request.desired.integrity, INTEGRITY);
  // keep the unused liveClient binding meaningful
  assert.ok(cp);
});

test("live: stop posts capsule.lifecycle stop apply", async () => {
  let applied: unknown;
  const capturingFetch: typeof fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const urlText = typeof input === "string" ? input : input instanceof URL ? input.href : (input as Request).url;
    const pathname = new URL(urlText).pathname;
    if (pathname === "/apply") {
      applied = JSON.parse(typeof init?.body === "string" ? init.body : "{}");
      return new Response(JSON.stringify({ outcome: "committed" }), { status: 200 });
    }
    if (pathname === "/state") return new Response(stateBody(false), { status: 200 });
    return new Response("{}", { status: 200 });
  }) as typeof fetch;

  const cp = createAgentHttpControlPlane({ baseUrl: "http://agentd", fetch: capturingFetch });
  await cp.stop(CAPSULE_ID);

  const ops = (applied as { operations?: Array<{ capability: string; request: { desired: { op: string; id: string } } }> }).operations ?? [];
  assert.equal(ops[0]?.capability, "capsule.lifecycle");
  assert.equal(ops[0]?.request.desired.op, "stop");
  assert.equal(ops[0]?.request.desired.id, CAPSULE_ID);
});

test("live: logs reads the NEW GET /read/capsule.logs endpoint and returns its lines", async () => {
  const lines: LogLine[] = [
    { ts: "2024-06-10T06:13:20Z", level: "info", message: "capsule started" },
    { ts: "2024-06-10T06:13:21Z", level: "error", message: "boom" },
  ];
  let requestedPath = "";
  const capturingFetch: typeof fetch = (async (input: string | URL | Request) => {
    const urlText = typeof input === "string" ? input : input instanceof URL ? input.href : (input as Request).url;
    const url = new URL(urlText);
    if (url.pathname === "/read/capsule.logs") {
      requestedPath = `${url.pathname}${url.search}`;
      return new Response(JSON.stringify({ lines }), { status: 200 });
    }
    return new Response("{}", { status: 404 });
  }) as typeof fetch;

  const cp = createAgentHttpControlPlane({ baseUrl: "http://agentd", fetch: capturingFetch });
  const got = await cp.logs(CAPSULE_ID, 100);

  assert.equal(got.length, 2);
  assert.equal(got[0]?.message, "capsule started");
  assert.equal(got[1]?.level, "error");
  assert.match(requestedPath, /^\/read\/capsule\.logs\?id=dev\.vita\.notes&limit=100$/u);
});

test("live: logs degrades gracefully when capsule.logs is absent (older agentd)", async () => {
  const cp = createAgentHttpControlPlane({
    baseUrl: "http://agentd",
    fetch: (async () => new Response("not found", { status: 404 })) as typeof fetch,
  });

  const got = await cp.logs(CAPSULE_ID, 10);
  assert.equal(got.length, 1);
  assert.equal(got[0]?.level, "warn");
  assert.match(got[0]?.message ?? "", /not available/u);
});

// ---- host-proxy unix fetch (the wire) ----

// A fake Deno connection: captures all written bytes, replays a canned response, then signals EOF.
function fakeDeno(responseText: string): { deno: { connect: () => Promise<unknown> }; written: () => string } {
  let writtenBytes = "";
  const connect = async () => {
    const encoded = new TextEncoder().encode(responseText);
    let cursor = 0;

    return {
      async write(p: Uint8Array): Promise<number> {
        writtenBytes += new TextDecoder().decode(p);
        return p.length;
      },
      async read(p: Uint8Array): Promise<number | null> {
        if (cursor >= encoded.length) return null;
        const slice = encoded.subarray(cursor, cursor + p.length);
        p.set(slice);
        cursor += slice.length;
        return slice.length;
      },
      close(): void {},
    };
  };

  return { deno: { connect }, written: () => writtenBytes };
}

test("host-proxy: GET encodes a valid HTTP/1.1 request line + Host and parses the JSON response", async () => {
  const responseText = "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nConnection: close\r\n\r\n{\"status\":\"ok\"}";
  const { deno, written } = fakeDeno(responseText);
  const unixFetch = createAgentdUnixFetch({ socketPath: "/run/vita-agent/agentd.sock", deno: deno as never });

  const res = await unixFetch("http://agentd/read/capsule.logs?id=x&limit=5", { method: "GET" });
  assert.equal(res.status, 200);
  assert.equal(res.ok, true);
  assert.deepEqual(await res.json(), { status: "ok" });

  const wire = written();
  assert.match(wire, /^GET \/read\/capsule\.logs\?id=x&limit=5 HTTP\/1\.1\r\n/u);
  assert.match(wire, /\r\nHost: agentd\r\n/u);
});

test("host-proxy: POST sends a Content-Length and the JSON body", async () => {
  const responseText = "HTTP/1.1 200 OK\r\nConnection: close\r\n\r\n{\"outcome\":\"committed\"}";
  const { deno, written } = fakeDeno(responseText);
  const unixFetch = createAgentdUnixFetch({ deno: deno as never });

  const body = JSON.stringify({ operations: [{ capability: "capsule.lifecycle", request: { desired: { op: "stop", id: "x" } } }] });
  const res = await unixFetch("http://agentd/apply", { method: "POST", headers: { "content-type": "application/json" }, body });
  assert.deepEqual(await res.json(), { outcome: "committed" });

  const wire = written();
  assert.match(wire, /^POST \/apply HTTP\/1\.1\r\n/u);
  assert.match(wire, new RegExp(`\\r\\nContent-Length: ${new TextEncoder().encode(body).length}\\r\\n`, "u"));
  assert.ok(wire.endsWith(body), "request body is appended after the headers");
});

test("host-proxy: parses a chunked transfer-encoded response", async () => {
  // "{\"a\":1}" split into two chunks.
  const responseText =
    "HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n" +
    "3\r\n{\"a\r\n4\r\n\":1}\r\n0\r\n\r\n";
  const { deno } = fakeDeno(responseText);
  const unixFetch = createAgentdUnixFetch({ deno: deno as never });

  const res = await unixFetch("http://agentd/state", { method: "GET" });
  assert.deepEqual(await res.json(), { a: 1 });
});
