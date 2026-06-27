// api_origin integration tests — exercise the REST surface the puter.js SDK reaches over HTTP, against
// the in-memory store + capability gate, via the transport-agnostic handler (no node:http needed).
//
// Run: node --experimental-strip-types --test ui_kits/desktop/runtime/puter/test/api-origin.test.ts

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import {
  type ApiOrigin,
  type ApiRequest,
  VERIFIED_PUTER_BUNDLE_SHA256,
  createApiOrigin,
} from "../../../../ui_kits/desktop/runtime/puter/api-origin.ts";
import { createCapabilityRegistry, type PuterCapabilityRegistry } from "../../../../ui_kits/desktop/runtime/puter/capability.ts";
import { createMemoryStore } from "../../../../ui_kits/desktop/runtime/puter/store.ts";

const TOKEN = "test-owner-token";
const INSTANCE = "test-instance";
const APP_ID = "test.app";

function setup(grants: readonly import("../../../../ui_kits/desktop/runtime/puter/capability.ts").PuterCapability[] = ["fs.read", "fs.write", "kv.read", "kv.write", "ui", "auth"]): { api: ApiOrigin; caps: PuterCapabilityRegistry } {
  const store = createMemoryStore();
  const caps = createCapabilityRegistry();

  caps.mintAppSession({ appId: APP_ID, appInstanceId: INSTANCE, grants, token: TOKEN });
  return { api: createApiOrigin({ capabilities: caps, store }), caps };
}

function req(method: string, path: string, options: { token?: string; json?: unknown; bodyBytes?: Uint8Array; contentType?: string; query?: Record<string, string> } = {}): ApiRequest {
  const headers: Record<string, string> = {};

  if (options.token !== undefined) headers["authorization"] = `Bearer ${options.token}`;

  let body: Uint8Array = new Uint8Array(0);

  if (options.json !== undefined) {
    headers["content-type"] = options.contentType ?? "application/json";
    body = new TextEncoder().encode(JSON.stringify(options.json));
  } else if (options.bodyBytes !== undefined) {
    if (options.contentType !== undefined) headers["content-type"] = options.contentType;
    body = options.bodyBytes;
  }

  return { body, headers, method, path, query: options.query ?? {} };
}

function jsonBody(res: { body: Uint8Array }): unknown {
  return JSON.parse(new TextDecoder().decode(res.body));
}

// Build the SDK's /batch multipart body for a single write (node FormData → bytes). Mirrors the genuine
// SDK shape: `path` = destination DIRECTORY, `name` = leaf filename (verified against the bundle).
async function batchBody(path: string, content: string): Promise<{ bytes: Uint8Array; contentType: string }> {
  const name = path.split("/").pop() ?? path;
  const parent = path.slice(0, path.length - name.length).replace(/\/$/u, "") || "/";
  const form = new FormData();

  form.append("operation", JSON.stringify({ name, op: "write", operation_id: "0", overwrite: true, path: parent }));
  form.append("fileinfo", JSON.stringify({ name, size: content.length, type: "text/plain" }));
  form.append("file", new Blob([content], { type: "text/plain" }), name);

  const res = new Response(form);
  const contentType = res.headers.get("content-type") ?? "";
  const bytes = new Uint8Array(await res.arrayBuffer());

  return { bytes, contentType };
}

test("vendored puter.js bundle matches the verified checksum", () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const bundle = resolve(here, "../../../../ui_kits/desktop/_vendor/puter/v2.js");
  const sha = createHash("sha256").update(readFileSync(bundle)).digest("hex");

  assert.equal(sha, VERIFIED_PUTER_BUNDLE_SHA256, "vendored bundle changed — re-verify the protocol + update VERIFIED_PUTER_BUNDLE_SHA256");
});

test("fs round-trip: write (/batch) then read then readdir then stat", async () => {
  const { api } = setup();
  const { bytes, contentType } = await batchBody("/hello.txt", "hi vita");

  const wrote = api.handle(req("POST", "/batch", { bodyBytes: bytes, contentType, token: TOKEN }));

  assert.equal(wrote.status, 200);

  const read = api.handle(req("POST", "/read", { json: { path: "/hello.txt" }, token: TOKEN }));

  assert.equal(read.status, 200);
  assert.equal(new TextDecoder().decode(read.body), "hi vita");

  const list = api.handle(req("POST", "/readdir", { json: { path: "/" }, token: TOKEN }));
  const entries = jsonBody(list) as { name: string; is_dir: boolean }[];

  assert.equal(list.status, 200);
  assert.ok(entries.some((e) => e.name === "hello.txt" && e.is_dir === false));

  const stat = api.handle(req("POST", "/stat", { json: { path: "/hello.txt" }, token: TOKEN }));
  const entry = jsonBody(stat) as { name: string; size: number };

  assert.equal(stat.status, 200);
  assert.equal(entry.name, "hello.txt");
  assert.equal(entry.size, "hi vita".length);
});

test("fs mkdir + nested write + readdir of subdir", async () => {
  const { api } = setup();

  const mk = api.handle(req("POST", "/mkdir", { json: { parent: "/", path: "docs" }, token: TOKEN }));

  assert.equal(mk.status, 200);

  const { bytes, contentType } = await batchBody("/docs/note.txt", "nested");

  assert.equal(api.handle(req("POST", "/batch", { bodyBytes: bytes, contentType, token: TOKEN })).status, 200);

  const list = api.handle(req("POST", "/readdir", { json: { path: "/docs" }, token: TOKEN }));
  const entries = jsonBody(list) as { name: string }[];

  assert.ok(entries.some((e) => e.name === "note.txt"));
});

test("fs delete removes the file", async () => {
  const { api } = setup();
  const { bytes, contentType } = await batchBody("/gone.txt", "x");

  api.handle(req("POST", "/batch", { bodyBytes: bytes, contentType, token: TOKEN }));
  const del = api.handle(req("POST", "/delete", { json: { path: "/gone.txt" }, token: TOKEN }));

  assert.equal(del.status, 200);
  assert.equal(api.handle(req("POST", "/read", { json: { path: "/gone.txt" }, token: TOKEN })).status, 404);
});

// The GENUINE SDK's fs.delete sends `{ paths: [<path>,…] }` (verified against the vendored bundle +
// in a real browser: a single `path` returned "path is required" until this was added). Assert the
// array shape deletes every target.
test("fs delete accepts the SDK's `paths` ARRAY (real-browser shape)", async () => {
  const { api } = setup();
  const a = await batchBody("/d/one.txt", "1");
  const b = await batchBody("/d/two.txt", "2");

  api.handle(req("POST", "/batch", { bodyBytes: a.bytes, contentType: a.contentType, token: TOKEN }));
  api.handle(req("POST", "/batch", { bodyBytes: b.bytes, contentType: b.contentType, token: TOKEN }));

  const del = api.handle(req("POST", "/delete", { json: { paths: ["/d/one.txt", "/d/two.txt"], recursive: true }, token: TOKEN }));

  assert.equal(del.status, 200);
  assert.equal(api.handle(req("POST", "/read", { json: { path: "/d/one.txt" }, token: TOKEN })).status, 404);
  assert.equal(api.handle(req("POST", "/read", { json: { path: "/d/two.txt" }, token: TOKEN })).status, 404);
});

// `descendants_only` empties a directory but keeps the directory itself.
test("fs delete with descendants_only keeps the dir, removes its contents", async () => {
  const { api } = setup();
  const f = await batchBody("/keep/inside.txt", "x");

  api.handle(req("POST", "/batch", { bodyBytes: f.bytes, contentType: f.contentType, token: TOKEN }));
  const del = api.handle(req("POST", "/delete", { json: { paths: ["/keep"], descendants_only: true, recursive: true }, token: TOKEN }));

  assert.equal(del.status, 200);
  // the dir survives…
  assert.equal(api.handle(req("POST", "/stat", { json: { path: "/keep" }, token: TOKEN })).status, 200);
  // …but its contents are gone.
  assert.equal(api.handle(req("POST", "/read", { json: { path: "/keep/inside.txt" }, token: TOKEN })).status, 404);
});

test("kvstore: set / get / del / list via /drivers/call", () => {
  const { api } = setup();

  const set = api.handle(req("POST", "/drivers/call", { json: { args: { key: "k1", value: "v1" }, interface: "puter-kvstore", method: "set" }, token: TOKEN }));

  assert.equal(set.status, 200);

  const get = api.handle(req("POST", "/drivers/call", { json: { args: { key: "k1" }, interface: "puter-kvstore", method: "get" }, token: TOKEN }));

  assert.equal((jsonBody(get) as { result: unknown }).result, "v1");

  const list = api.handle(req("POST", "/drivers/call", { json: { args: { as: "keys" }, interface: "puter-kvstore", method: "list" }, token: TOKEN }));

  assert.deepEqual((jsonBody(list) as { result: string[] }).result, ["k1"]);

  const del = api.handle(req("POST", "/drivers/call", { json: { args: { key: "k1" }, interface: "puter-kvstore", method: "del" }, token: TOKEN }));

  assert.equal(del.status, 200);

  const after = api.handle(req("POST", "/drivers/call", { json: { args: { key: "k1" }, interface: "puter-kvstore", method: "get" }, token: TOKEN }));

  assert.equal((jsonBody(after) as { result: unknown }).result, null);
});

test("kvstore: unknown interface is rejected", () => {
  const { api } = setup();
  const res = api.handle(req("POST", "/drivers/call", { json: { args: {}, interface: "puter-ai", method: "get" }, token: TOKEN }));

  assert.equal(res.status, 400);
  assert.equal((jsonBody(res) as { code: string }).code, "interface_not_found");
});

test("whoami returns the static owner identity", () => {
  const { api } = setup();
  const res = api.handle(req("GET", "/whoami", { token: TOKEN }));
  const me = jsonBody(res) as { username: string; uuid: string };

  assert.equal(res.status, 200);
  assert.equal(me.username, "owner");
  assert.ok(typeof me.uuid === "string" && me.uuid.length > 0);
});

test("fs.read accepts the path via the `file` query param (the SDK's GET /read?file=...)", async () => {
  const { api } = setup();
  const { bytes, contentType } = await batchBody("/q.txt", "via query");

  api.handle(req("POST", "/batch", { bodyBytes: bytes, contentType, token: TOKEN }));

  const read = api.handle(req("GET", "/read", { query: { file: "/q.txt" }, token: TOKEN }));

  assert.equal(read.status, 200);
  assert.equal(new TextDecoder().decode(read.body), "via query");
});

test("auth token in the request BODY (auth_token) authenticates kv/readdir (no bearer header)", () => {
  const { api } = setup();
  // kv set with NO Authorization header, token only in the body — the SDK's /drivers/call shape.
  const set = api.handle(req("POST", "/drivers/call", { json: { args: { key: "bk", value: "bv" }, auth_token: TOKEN, interface: "puter-kvstore", method: "set" } }));

  assert.equal(set.status, 200);

  const get = api.handle(req("POST", "/drivers/call", { json: { args: { key: "bk" }, auth_token: TOKEN, interface: "puter-kvstore", method: "get" } }));

  assert.equal((jsonBody(get) as { result: unknown }).result, "bv");

  // readdir with token only in the body.
  const list = api.handle(req("POST", "/readdir", { json: { auth_token: TOKEN, path: "/" } }));

  assert.equal(list.status, 200);
});

test("write op with `path`=parent-dir + `name`=leaf (the genuine SDK shape) targets parent/name", async () => {
  const { api } = setup();
  // The SDK sends { op:'write', path:'~', name:'f.txt' } — path is the DIRECTORY, name is the file.
  const form = new FormData();

  form.append("operation", JSON.stringify({ name: "f.txt", op: "write", operation_id: "0", overwrite: true, path: "/sub" }));
  form.append("fileinfo", JSON.stringify({ name: "f.txt", size: 3, type: "text/plain" }));
  form.append("file", new Blob(["abc"], { type: "text/plain" }), "f.txt");
  const res = new Response(form);
  const contentType = res.headers.get("content-type") ?? "";
  const bytes = new Uint8Array(await res.arrayBuffer());

  const wrote = api.handle(req("POST", "/batch", { bodyBytes: bytes, contentType, token: TOKEN }));

  assert.equal(wrote.status, 200);

  const read = api.handle(req("GET", "/read", { query: { file: "/sub/f.txt" }, token: TOKEN }));

  assert.equal(new TextDecoder().decode(read.body), "abc");
});

test("the SDK's signed-batch probe (/fs/startBatchWrite) returns a non-array to steer to /batch", () => {
  const { api } = setup();
  const res = api.handle(req("POST", "/fs/startBatchWrite", { json: { operations: [] }, token: TOKEN }));

  assert.equal(res.status, 200);
  assert.equal((jsonBody(res) as { signedBatchUnavailable?: boolean }).signedBatchUnavailable, true);
});

test("capability gate: missing token → 401 (UNAUTHENTICATED)", () => {
  const { api } = setup();
  const res = api.handle(req("POST", "/readdir", { json: { path: "/" } }));

  assert.equal(res.status, 401);
  assert.equal((jsonBody(res) as { code: string }).code, "UNAUTHENTICATED");
});

test("capability gate: unknown token → 401", () => {
  const { api } = setup();
  const res = api.handle(req("POST", "/readdir", { json: { path: "/" }, token: "nope" }));

  assert.equal(res.status, 401);
});

test("capability gate: valid token but app lacks fs.write → 403 (CAP_DENIED)", async () => {
  const { api } = setup(["fs.read", "auth"]); // no fs.write
  const { bytes, contentType } = await batchBody("/x.txt", "x");
  const res = api.handle(req("POST", "/batch", { bodyBytes: bytes, contentType, token: TOKEN }));

  assert.equal(res.status, 403);
  assert.equal((jsonBody(res) as { code: string }).code, "CAP_DENIED");
});

test("capability gate: app lacks kv.write but can kv.read", () => {
  const { api } = setup(["kv.read", "auth"]); // no kv.write
  const setRes = api.handle(req("POST", "/drivers/call", { json: { args: { key: "k", value: "v" }, interface: "puter-kvstore", method: "set" }, token: TOKEN }));

  assert.equal(setRes.status, 403);

  const getRes = api.handle(req("POST", "/drivers/call", { json: { args: { key: "k" }, interface: "puter-kvstore", method: "get" }, token: TOKEN }));

  assert.equal(getRes.status, 200); // read allowed
});

test("path traversal is rejected (cannot escape root)", () => {
  const { api } = setup();
  const res = api.handle(req("POST", "/read", { json: { path: "/../../etc/passwd" }, token: TOKEN }));

  // normalizePath throws forbidden(403) → mapped through the handler.
  assert.equal(res.status, 403);
});

test("unknown endpoint → 404", () => {
  const { api } = setup();
  const res = api.handle(req("GET", "/nope", { token: TOKEN }));

  assert.equal(res.status, 404);
});

test("OPTIONS preflight → 204 with CORS headers", () => {
  const { api } = setup();
  const res = api.handle(req("OPTIONS", "/read"));

  assert.equal(res.status, 204);
  assert.ok(res.headers["access-control-allow-origin"]);
});
