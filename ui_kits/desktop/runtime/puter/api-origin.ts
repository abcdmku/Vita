// Puter compat — the LOCAL api_origin (the data plane the puter.js SDK talks to over HTTP).
//
// The puter.js SDK reaches fs/kv/auth by DIRECT HTTP to `puter.api_origin` (the launch-URL param we
// set to our local origin). This module implements that REST surface — transport-agnostic: it takes a
// normalized `ApiRequest` (method, path, headers, body bytes) and returns a normalized `ApiResponse`
// (status, headers, body bytes). The harness wraps it in a tiny node:http server (server.ts); the
// on-device host-proxy will wrap the SAME handler over its own transport. No node:http here.
//
// Endpoints (verified against the vendored bundle, 2026-06-26 — see _vendor/puter/VENDOR.md):
//   POST /batch         fs.write   (multipart: operation JSON + fileinfo JSON + file blob)
//   POST /read          fs.read    (returns raw bytes; query/body carries the path)
//   POST /readdir       fs.readdir (text/plain;actually=json body { path })
//   POST /stat          fs.stat
//   POST /mkdir         fs.mkdir
//   POST /delete        fs.delete
//   POST /drivers/call  kv.*       (interface "puter-kvstore"; methods get/set/del/list)
//   GET  /whoami        auth.whoami
//   GET|POST /rao       auth — app read access (returns a benign allow for the owner)
//
// Every fs/kv call is gated through the capability registry (token → app → grants). auth answers a
// static owner identity (trust-on-host). Errors map to puter's envelope `{ error|message, code }`.

import {
  type AppSiteRegistry,
  createAppSiteRegistry,
} from "./app-registry-store.ts";
import {
  type PuterCapability,
  type PuterCapabilityRegistry,
  parseBearer,
} from "./capability.ts";
import type { AgentControlPlane } from "./control-plane.ts";
import {
  type FsEntry,
  type PuterStore,
  PuterStoreError,
  basename,
  dirname,
  normalizePath,
} from "./store.ts";

// The SHA-256 of the vendored puter.js bundle this api_origin's protocol was verified against. The
// api-origin test asserts the on-disk bundle matches, so a swapped/upgraded bundle is caught and the
// protocol re-verified. (Informational at runtime; the test is the enforcement point.)
export const VERIFIED_PUTER_BUNDLE_SHA256 =
  "30397f1379bb347df04d66c71b1f4eb4d842e638f3c3d4c3acbbc7d706df4207";

// ---------------------------------------------------------------------------------------------
// Normalized transport types.
// ---------------------------------------------------------------------------------------------

export interface ApiRequest {
  readonly method: string;
  // Path WITHOUT the origin (e.g. "/batch"). Query string included as `query`.
  readonly path: string;
  readonly query: Readonly<Record<string, string>>;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: Uint8Array;
}

export interface ApiResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: Uint8Array;
}

export interface ApiOrigin {
  // The SYNCHRONOUS data-plane surface (fs / kv / auth — pure, file-backed). Unchanged contract: every
  // existing caller + the SDK protocol tests use this. Control-plane paths (/control/*) return a 404
  // here (they are async — use `handleAsync`).
  handle(request: ApiRequest): ApiResponse;
  // The FULL surface including the async control plane (/control/*). Awaits agentd / the stub for
  // /control/*, and delegates everything else to the synchronous `handle`. The node:http server adapter
  // calls this so both planes are served on one origin.
  handleAsync(request: ApiRequest): Promise<ApiResponse>;
}

export interface ApiOriginDeps {
  readonly store: PuterStore;
  readonly capabilities: PuterCapabilityRegistry;
  // Allowed cross-origin for the iframe's app origin (the SDK sends requests with credentials). For the
  // spike the harness is same-origin, but the SDK sets Origin: https://puter.work on app requests, so
  // we reflect a permissive ACAO + allow the bearer header. Tighten on-device.
  readonly allowOrigin?: string;
  // The CONTROL-PLANE bridge the deploy/management console talks to (/control/*). Optional: when absent
  // the api_origin is data-plane-only (the original spike surface) and /control/* answers 404. When
  // present, /control/* is mounted and gated on the `control` capability. See control-plane.ts.
  readonly controlPlane?: AgentControlPlane;
  // The base URL the origin is reachable at (e.g. "http://127.0.0.1:7681") — used to build absolute
  // site/share URLs for the apps/sites surface. Defaults to a relative "" (URLs become path-only).
  readonly originBase?: string;
}

const TEXT = (s: string): Uint8Array => new TextEncoder().encode(s);
const JSON_CT = "application/json";

export function createApiOrigin(deps: ApiOriginDeps): ApiOrigin {
  const { capabilities, store } = deps;
  const controlPlane = deps.controlPlane;
  const allowOrigin = deps.allowOrigin ?? "*";
  const originBase = deps.originBase ?? "";
  // The apps/sites/shares/events registry — store-backed over the SAME KV (reserved key prefixes).
  const registry: AppSiteRegistry = createAppSiteRegistry(store.kv);

  function baseHeaders(contentType: string): Record<string, string> {
    return {
      "access-control-allow-headers": "authorization,content-type",
      "access-control-allow-methods": "GET,POST,OPTIONS",
      "access-control-allow-origin": allowOrigin,
      "content-type": contentType,
    };
  }

  function json(status: number, value: unknown): ApiResponse {
    return Object.freeze({ body: TEXT(JSON.stringify(value)), headers: Object.freeze(baseHeaders(JSON_CT)), status });
  }

  function raw(status: number, bytes: Uint8Array, contentType: string): ApiResponse {
    return Object.freeze({ body: bytes, headers: Object.freeze(baseHeaders(contentType)), status });
  }

  function errorResponse(status: number, code: string, message: string): ApiResponse {
    // puter's fs ops read `error.code`/`error.message`; some read top-level `message`. Provide both.
    return json(status, { code, error: { code, message }, message, success: false });
  }

  // Gate a data-plane request: resolve the token, then authorize the capability. Returns the session
  // or an error response to short-circuit with.
  function gate(req: ApiRequest, capability: PuterCapability): { ok: true; session: import("./capability.ts").PuterAppSession } | { ok: false; response: ApiResponse } {
    const token = extractToken(req);
    const resolved = capabilities.resolveToken(token);

    if (!resolved.ok) return { ok: false, response: errorResponse(resolved.status, resolved.code, resolved.message) };

    const authorized = capabilities.authorize(resolved.session, capability);

    if (!authorized.ok) return { ok: false, response: errorResponse(authorized.status, authorized.code, authorized.message) };

    return { ok: true, session: resolved.session };
  }

  // The SDK presents the owner token in THREE ways depending on the call path (verified against the
  // vendored bundle): (1) `Authorization: Bearer <t>` header on /batch, /mkdir, /delete, /whoami;
  // (2) an `auth_token` field IN THE JSON BODY on /readdir, /stat, /drivers/call (those XHR requests
  // send no bearer header — they rely on cookies on puter.com); (3) an `auth_token` query param as a
  // last resort. We accept all three so every data-plane call authenticates against our local origin.
  function extractToken(req: ApiRequest): string | undefined {
    const bearer = parseBearer(req.headers["authorization"]);

    if (bearer !== undefined) return bearer;

    const fromBody = parseJsonBody(req.body)["auth_token"];

    if (typeof fromBody === "string" && fromBody.length > 0) return fromBody;

    const fromQuery = req.query["auth_token"];

    return typeof fromQuery === "string" && fromQuery.length > 0 ? fromQuery : undefined;
  }

  function mapStoreError(err: unknown): ApiResponse {
    if (err instanceof PuterStoreError) return errorResponse(err.status, err.code, err.message);

    const message = err instanceof Error ? err.message : "internal error";

    return errorResponse(500, "internal_error", message);
  }

  // ----- fs handlers -----

  function handleBatch(req: ApiRequest): ApiResponse {
    const gated = gate(req, "fs.write");

    if (!gated.ok) return gated.response;

    let parsed: BatchUpload;

    try {
      parsed = parseMultipartBatch(req.body, req.headers["content-type"] ?? "");
    } catch (err) {
      return mapStoreError(err);
    }

    const results: FsEntry[] = [];

    try {
      for (const op of parsed.operations) {
        if (op.op === "write" || op.op === "shortcut") {
          const path = resolveWritePath(op);
          const file = parsed.files.get(op.operation_id ?? "") ?? parsed.files.get(String(results.length)) ?? new Uint8Array(0);

          results.push(store.fs.write(path, file, { overwrite: op.overwrite ?? true, type: op.type ?? null }));
        } else if (op.op === "mkdir") {
          const path = joinParent(op.parent, op.path);

          results.push(store.fs.mkdir(path, { createMissingAncestors: op.create_missing_ancestors ?? true }));
        } else if (op.op === "delete") {
          store.fs.delete(normalizePath(op.path), { recursive: op.recursive ?? true });
        }
      }
    } catch (err) {
      return mapStoreError(err);
    }

    // Emit a realtime event per written entry so subscribers see fs activity.
    for (const entry of results) {
      registry.recordEvent({ app: gated.session.appId, kind: "fs.write", path: entry.path });
    }

    // The SDK accepts either a single fsentry or an array (it normalizes). Return the array of results.
    return json(200, { results });
  }

  function handleRead(req: ApiRequest): ApiResponse {
    const gated = gate(req, "fs.read");

    if (!gated.ok) return gated.response;

    const path = readPathFromRequest(req);

    if (path === undefined) return errorResponse(400, "field_missing", "path is required");

    try {
      const result = store.fs.read(path);

      if (result === undefined) return errorResponse(404, "subject_does_not_exist", `no such file: ${path}`);

      return raw(200, result.bytes, result.entry.type ?? "application/octet-stream");
    } catch (err) {
      return mapStoreError(err);
    }
  }

  function handleReaddir(req: ApiRequest): ApiResponse {
    const gated = gate(req, "fs.read");

    if (!gated.ok) return gated.response;

    const path = readPathFromRequest(req);

    if (path === undefined) return errorResponse(400, "field_missing", "path is required");

    try {
      return json(200, store.fs.readdir(path));
    } catch (err) {
      return mapStoreError(err);
    }
  }

  function handleStat(req: ApiRequest): ApiResponse {
    const gated = gate(req, "fs.read");

    if (!gated.ok) return gated.response;

    const path = readPathFromRequest(req);

    if (path === undefined) return errorResponse(400, "field_missing", "path is required");

    try {
      const entry = store.fs.stat(path);

      if (entry === undefined) return errorResponse(404, "subject_does_not_exist", `no such path: ${path}`);

      return json(200, entry);
    } catch (err) {
      return mapStoreError(err);
    }
  }

  function handleMkdir(req: ApiRequest): ApiResponse {
    const gated = gate(req, "fs.write");

    if (!gated.ok) return gated.response;

    const obj = parseJsonBody(req.body);
    const parent = typeof obj["parent"] === "string" ? obj["parent"] : "/";
    const name = typeof obj["path"] === "string" ? obj["path"] : (typeof obj["name"] === "string" ? obj["name"] : undefined);

    if (name === undefined) return errorResponse(400, "field_missing", "path is required");

    try {
      const entry = store.fs.mkdir(joinParent(parent, name), { createMissingAncestors: obj["create_missing_ancestors"] !== false });

      return json(200, entry);
    } catch (err) {
      return mapStoreError(err);
    }
  }

  // The SDK's `fs.delete` sends `POST /delete { paths: [<path>,…], recursive, descendants_only }` — a
  // `paths` ARRAY, not a single `path` (verified against the vendored bundle: `r.send(JSON.stringify(
  // {paths:n,descendants_only:…,recursive:…}))`). Accept the array (delete each), and still accept the
  // legacy single `path` (query/body) for the native/test callers. `descendants_only` deletes the
  // directory's contents but keeps the dir itself.
  function handleDelete(req: ApiRequest): ApiResponse {
    const gated = gate(req, "fs.write");

    if (!gated.ok) return gated.response;

    const obj = parseJsonBody(req.body);
    const recursive = obj["recursive"] !== false;
    const descendantsOnly = obj["descendants_only"] === true || obj["descendantsOnly"] === true;
    const targets = collectDeletePaths(req, obj);

    if (targets.length === 0) return errorResponse(400, "field_missing", "path is required");

    try {
      for (const target of targets) {
        if (descendantsOnly) {
          for (const child of store.fs.readdir(target)) store.fs.delete(child.path, { recursive });
        } else {
          store.fs.delete(target, { recursive });
        }
      }

      return json(200, { success: true });
    } catch (err) {
      return mapStoreError(err);
    }
  }

  // The SDK's `rename` sends `POST /rename { path, new_name }` (same parent, new leaf). `move` sends
  // `POST /move { source, destination, overwrite, new_name }` where `destination` is the new PARENT dir
  // and `new_name` (optional) the new leaf. Both land on the store's `move(from, to)`.
  function handleRename(req: ApiRequest): ApiResponse {
    const gated = gate(req, "fs.write");

    if (!gated.ok) return gated.response;

    const obj = parseJsonBody(req.body);
    const from = readPathFromRequest(req);
    const newName = typeof obj["new_name"] === "string" ? obj["new_name"] : (typeof obj["newName"] === "string" ? obj["newName"] : undefined);

    if (from === undefined) return errorResponse(400, "field_missing", "path is required");
    if (newName === undefined || newName === "") return errorResponse(400, "field_missing", "new_name is required");

    const to = joinParent(dirOf(from), newName);

    try {
      return json(200, store.fs.move(from, to, { overwrite: obj["overwrite"] === true }));
    } catch (err) {
      return mapStoreError(err);
    }
  }

  function handleMove(req: ApiRequest): ApiResponse {
    const gated = gate(req, "fs.write");

    if (!gated.ok) return gated.response;

    const obj = parseJsonBody(req.body);
    const source = typeof obj["source"] === "string" ? obj["source"] : undefined;
    const destination = typeof obj["destination"] === "string" ? obj["destination"] : undefined;
    const newName = typeof obj["new_name"] === "string" ? obj["new_name"] : undefined;

    if (source === undefined) return errorResponse(400, "field_missing", "source is required");
    if (destination === undefined) return errorResponse(400, "field_missing", "destination is required");

    // destination is the new PARENT dir; the leaf is new_name or the source's basename.
    const leaf = newName !== undefined && newName !== "" ? newName : baseOf(source);
    const to = joinParent(destination, leaf);

    try {
      return json(200, store.fs.move(source, to, { overwrite: obj["overwrite"] === true }));
    } catch (err) {
      return mapStoreError(err);
    }
  }

  // ----- kv handler (/drivers/call, interface puter-kvstore) -----

  function handleDriversCall(req: ApiRequest): ApiResponse {
    const obj = parseJsonBody(req.body);
    const iface = typeof obj["interface"] === "string" ? obj["interface"] : "";

    // The SDK reaches apps/sites through the SAME /drivers/call endpoint with a different interface
    // name (`puter.apps.*` → "puter-apps", `puter.hosting.*` → "puter-subdomains"). Route those to the
    // store-backed registry. Everything else falls through to the kvstore handler below.
    if (iface === "puter-apps" || iface === "puter-subdomains") {
      return handleEntityDriverCall(req, obj, iface);
    }

    if (iface !== "puter-kvstore") {
      return errorResponse(400, "interface_not_found", `unsupported interface: ${iface || "(none)"}`);
    }

    const method = typeof obj["method"] === "string" ? obj["method"] : "";
    const isWrite = method === "set" || method === "del" || method === "incr" || method === "decr" || method === "flush";
    const gated = gate(req, isWrite ? "kv.write" : "kv.read");

    if (!gated.ok) return gated.response;

    const args = (obj["args"] !== null && typeof obj["args"] === "object" ? obj["args"] : {}) as Record<string, unknown>;

    try {
      switch (method) {
        case "get": {
          const key = String(args["key"] ?? "");

          return json(200, { result: store.kv.get(key), success: true });
        }
        case "set": {
          const key = String(args["key"] ?? "");
          const value = args["value"];

          store.kv.set(key, typeof value === "string" ? value : JSON.stringify(value ?? null));
          // Don't echo the registry's own reserved keys as events (avoids a feedback loop).
          if (!key.startsWith("__vita.")) registry.recordEvent({ app: gated.session.appId, detail: key, kind: "kv.set" });
          return json(200, { result: true, success: true });
        }
        case "del": {
          const key = String(args["key"] ?? "");

          store.kv.del(key);
          return json(200, { result: true, success: true });
        }
        case "list": {
          const asKeys = args["as"] === "keys";
          // Hide the registry's reserved keys (apps/sites/shares/events) from app-visible kv.list().
          const entries = store.kv.list().filter((e) => !e.key.startsWith("__vita."));
          const result = asKeys ? entries.map((e) => e.key) : entries.map((e) => ({ key: e.key, value: e.value }));

          return json(200, { result, success: true });
        }
        case "flush": {
          // Flush only app-visible keys; never wipe the registry's reserved keys.
          for (const e of store.kv.list()) {
            if (!e.key.startsWith("__vita.")) store.kv.del(e.key);
          }
          return json(200, { result: true, success: true });
        }
        default:
          return errorResponse(400, "method_not_found", `unsupported kvstore method: ${method || "(none)"}`);
      }
    } catch (err) {
      return mapStoreError(err);
    }
  }

  // ----- apps / sites entity-driver handler (/drivers/call, interfaces puter-apps / puter-subdomains) -----
  //
  // The SDK's entity-storage drivers send `{ interface, method, args }` where method ∈
  // {select, read, create, update, delete} and args carries `{object}` (create/update), `{id}` or a
  // uid (read/delete), or `{predicate}` (select). We map those onto the store-backed registry and
  // return `{ success, result }` with the entity (or array). Gated: apps/sites read = fs.read,
  // create/update/delete = fs.write (registering an app or publishing a site is an authoring action).
  function handleEntityDriverCall(req: ApiRequest, obj: Record<string, unknown>, iface: string): ApiResponse {
    const method = typeof obj["method"] === "string" ? obj["method"] : "";
    const isWrite = method === "create" || method === "update" || method === "delete";
    const gated = gate(req, isWrite ? "fs.write" : "fs.read");

    if (!gated.ok) return gated.response;

    const args = (obj["args"] !== null && typeof obj["args"] === "object" ? obj["args"] : {}) as Record<string, unknown>;
    const ownerApp = gated.session.appId;

    try {
      if (iface === "puter-apps") {
        switch (method) {
          case "select":
            return json(200, { result: registry.listApps(), success: true });
          case "read": {
            const name = readEntityName(args);
            const found = name === undefined ? undefined : registry.getApp(name);

            return found === undefined
              ? errorResponse(404, "entity_not_found", `no such app: ${name ?? "(none)"}`)
              : json(200, { result: found, success: true });
          }
          case "create":
          case "update": {
            const object = (args["object"] !== null && typeof args["object"] === "object" ? args["object"] : args) as Record<string, unknown>;

            return json(200, { result: registry.createApp(readAppInput(object), ownerApp), success: true });
          }
          case "delete": {
            const name = readEntityName(args);

            return json(200, { result: name !== undefined && registry.deleteApp(name), success: true });
          }
          default:
            return errorResponse(400, "method_not_found", `unsupported puter-apps method: ${method || "(none)"}`);
        }
      }

      // puter-subdomains (sites / hosting)
      switch (method) {
        case "select":
          return json(200, { result: registry.listSites(), success: true });
        case "read": {
          const subdomain = readEntityName(args, "subdomain");
          const found = subdomain === undefined ? undefined : registry.getSite(subdomain);

          return found === undefined
            ? errorResponse(404, "entity_not_found", `no such subdomain: ${subdomain ?? "(none)"}`)
            : json(200, { result: found, success: true });
        }
        case "create":
        case "update": {
          const object = (args["object"] !== null && typeof args["object"] === "object" ? args["object"] : args) as Record<string, unknown>;

          return json(200, { result: registry.createSite(readSiteInput(object), ownerApp, originBase), success: true });
        }
        case "delete": {
          const subdomain = readEntityName(args, "subdomain");

          return json(200, { result: subdomain !== undefined && registry.deleteSite(subdomain), success: true });
        }
        default:
          return errorResponse(400, "method_not_found", `unsupported puter-subdomains method: ${method || "(none)"}`);
      }
    } catch (err) {
      return mapStoreError(err);
    }
  }

  // ----- REST handlers for apps / sites / shares / realtime events -----
  //
  // A browser-friendly REST face for the same registry (used by Vita's own apps + a convenience for any
  // app that prefers REST over the driver-call shape). Each is capability-gated like fs/kv.

  function handleApps(req: ApiRequest, method: string): ApiResponse {
    if (method === "GET") {
      const gated = gate(req, "fs.read");

      if (!gated.ok) return gated.response;

      return json(200, { apps: registry.listApps() });
    }

    const gated = gate(req, "fs.write");

    if (!gated.ok) return gated.response;

    return json(200, { app: registry.createApp(readAppInput(parseJsonBody(req.body)), gated.session.appId) });
  }

  function handleSites(req: ApiRequest, method: string): ApiResponse {
    if (method === "GET") {
      const gated = gate(req, "fs.read");

      if (!gated.ok) return gated.response;

      return json(200, { sites: registry.listSites() });
    }

    const gated = gate(req, "fs.write");

    if (!gated.ok) return gated.response;

    return json(200, { site: registry.createSite(readSiteInput(parseJsonBody(req.body)), gated.session.appId, originBase) });
  }

  function handleShare(req: ApiRequest, method: string): ApiResponse {
    if (method === "GET") {
      const gated = gate(req, "fs.read");

      if (!gated.ok) return gated.response;

      return json(200, { shares: registry.listShares() });
    }

    const gated = gate(req, "fs.write");

    if (!gated.ok) return gated.response;

    const obj = parseJsonBody(req.body);
    const path = typeof obj["path"] === "string" ? obj["path"] : "/";
    const mode = obj["mode"] === "write" ? "write" : "read";

    return json(200, { share: registry.createShare({ mode, path }, gated.session.appId, originBase) });
  }

  // Realtime change feed (long-poll). The SDK's socket.io is stubbed (server.ts); this is the REAL
  // event surface Vita's own apps poll: `GET /events?since=<seq>` returns events newer than the cursor.
  function handleEvents(req: ApiRequest): ApiResponse {
    const gated = gate(req, "fs.read");

    if (!gated.ok) return gated.response;

    const since = Number(req.query["since"] ?? "0");
    const limit = Number(req.query["limit"] ?? "100");
    const out = registry.events(Number.isFinite(since) ? since : 0, Number.isFinite(limit) ? limit : 100);

    return json(200, { cursor: out.cursor, events: out.events });
  }

  // ----- auth handlers -----

  function handleWhoami(req: ApiRequest): ApiResponse {
    const gated = gate(req, "auth");

    if (!gated.ok) return gated.response;

    const { owner, appId } = gated.session;

    // The shape puter's whoami returns (the SDK reads username/uuid/email_confirmed). Static owner.
    return json(200, {
      app_uid: appId,
      email_confirmed: owner.emailConfirmed,
      is_temp: false,
      username: owner.username,
      uuid: owner.uuid,
    });
  }

  function handleRao(req: ApiRequest): ApiResponse {
    // /rao = "request app (read) access". Owner trust-on-host: grant. Requires a valid token.
    const gated = gate(req, "auth");

    if (!gated.ok) return gated.response;

    return json(200, { granted: true, success: true });
  }

  // /df = "disk free" / quota. The SDK calls this BEFORE an fs.write to check `capacity - used >= size`
  // (verified against the bundle: `k=await this.space(); if(k.capacity-k.used<f)…`). A 404 here makes the
  // SDK's write throw `Cannot read properties of undefined (reading 'capacity')`. We answer a generous,
  // static quota for the single owner (trust-on-host). Gated on fs.read (a space query is a read).
  function handleDf(req: ApiRequest): ApiResponse {
    const gated = gate(req, "fs.read");

    if (!gated.ok) return gated.response;

    const capacity = 10 * 1024 * 1024 * 1024; // 10 GiB headroom for the owner's app store

    return json(200, { capacity, used: 0, free: capacity });
  }

  // The newer SDK first tries a CLOUD "signed batch" upload (S3-style multipart via signed URLs):
  // POST /fs/startBatchWrite → upload to signed URLs → /fs/completeBatchWrite. That path is cloud-only
  // and not something a local single-owner api_origin implements. The SDK is designed to FALL BACK to
  // the legacy multipart POST /batch when startBatchWrite returns a NON-ARRAY (it throws
  // `signedBatchUnavailable` → disables signed batch → retries on /batch). So we intentionally return a
  // non-array here to steer the SDK onto the local /batch path this api_origin DOES implement. (Verified
  // against the vendored bundle's `en()` fallback detector + the startBatchWrite array check.)
  function handleSignedBatchUnavailable(req: ApiRequest): ApiResponse {
    const gated = gate(req, "fs.write");

    if (!gated.ok) return gated.response;

    return json(200, { signedBatchUnavailable: true });
  }

  // ----- control-plane handlers (/control/*) — the deploy/management console surface -----
  //
  // Every call is gated on the `control` capability (only the console app is granted it). The bridge
  // (control-plane.ts) projects agentd's capsule registry + execute status + lifecycle + logs into a
  // browser-friendly shape. These are async (the real agentd client awaits the socket/host-proxy).

  // Match /control/apps/:id/(status|start|stop|logs). Returns the id + leaf, or undefined.
  function matchAppRoute(path: string): { id: string; leaf: string } | undefined {
    const m = /^\/control\/apps\/([^/]+)(?:\/([^/]+))?$/u.exec(path);

    if (m === null) return undefined;

    return { id: decodeURIComponent(m[1] ?? ""), leaf: m[2] ?? "" };
  }

  async function handleControl(req: ApiRequest, method: string, path: string): Promise<ApiResponse> {
    if (controlPlane === undefined) {
      return errorResponse(404, "control_plane_unavailable", "this api_origin has no control plane mounted");
    }

    const gated = gate(req, "control");

    if (!gated.ok) return gated.response;

    try {
      // GET /control/status — node STATE / VITA-EVAL projection (header summary).
      if (method === "GET" && path === "/control/status") {
        return json(200, await controlPlane.status());
      }

      // GET /control/apps — list installed/running capsules.
      if (method === "GET" && path === "/control/apps") {
        return json(200, { apps: await controlPlane.listApps() });
      }

      const route = matchAppRoute(path);

      if (route !== undefined) {
        // GET /control/apps/:id — one app's view.
        if (method === "GET" && route.leaf === "") {
          const app = await controlPlane.getApp(route.id);

          if (app === undefined) return errorResponse(404, "no_such_app", `no such app: ${route.id}`);

          return json(200, app);
        }

        // GET /control/apps/:id/logs?limit=N — capsule journal tail.
        if (method === "GET" && route.leaf === "logs") {
          const limit = clampLimit(req.query["limit"]);

          return json(200, { id: route.id, lines: await controlPlane.logs(route.id, limit) });
        }

        // POST /control/apps/:id/start — start the capsule (capsule.execute apply).
        if (method === "POST" && route.leaf === "start") {
          return json(200, await controlPlane.start(route.id));
        }

        // POST /control/apps/:id/stop — stop the capsule (capsule.lifecycle stop apply).
        if (method === "POST" && route.leaf === "stop") {
          return json(200, await controlPlane.stop(route.id));
        }
      }

      return errorResponse(404, "endpoint_not_found", `no such control endpoint: ${method} ${path}`);
    } catch (err) {
      return errorResponse(502, "control_plane_error", err instanceof Error ? err.message : "control plane error");
    }
  }

  function isControlPath(path: string): boolean {
    return path === "/control/status" || path === "/control/apps" || path.startsWith("/control/apps/");
  }

  function handleSync(request: ApiRequest): ApiResponse {
    const method = request.method.toUpperCase();

    if (method === "OPTIONS") return raw(204, new Uint8Array(0), "text/plain");

    const path = request.path.split("?")[0] ?? request.path;

    try {
      if (method === "POST" && path === "/batch") return handleBatch(request);
      if ((method === "POST" || method === "GET") && path === "/read") return handleRead(request);
      if (method === "POST" && path === "/readdir") return handleReaddir(request);
      if (method === "POST" && path === "/stat") return handleStat(request);
      if (method === "POST" && path === "/mkdir") return handleMkdir(request);
      if (method === "POST" && path === "/delete") return handleDelete(request);
      if (method === "POST" && path === "/rename") return handleRename(request);
      if (method === "POST" && path === "/move") return handleMove(request);
      if (method === "POST" && path === "/drivers/call") return handleDriversCall(request);
      // apps / sites / shares / realtime-events REST surface (capability-gated, store-backed).
      if ((method === "GET" || method === "POST") && path === "/apps") return handleApps(request, method);
      if ((method === "GET" || method === "POST") && path === "/sites") return handleSites(request, method);
      if ((method === "GET" || method === "POST") && path === "/share") return handleShare(request, method);
      if (method === "GET" && path === "/events") return handleEvents(request);
      // Steer the SDK's cloud "signed batch" upload onto the local /batch fallback (see the handler).
      if (method === "POST" && path === "/fs/startBatchWrite") return handleSignedBatchUnavailable(request);
      if (path === "/df") return handleDf(request);
      if (path === "/whoami") return handleWhoami(request);
      if (path === "/rao") return handleRao(request);

      return errorResponse(404, "endpoint_not_found", `no such endpoint: ${method} ${path}`);
    } catch (err) {
      return mapStoreError(err);
    }
  }

  return Object.freeze({
    handle: handleSync,
    async handleAsync(request: ApiRequest): Promise<ApiResponse> {
      const method = request.method.toUpperCase();
      const path = request.path.split("?")[0] ?? request.path;

      // Control plane is async; everything else delegates to the synchronous data-plane dispatch.
      if (method !== "OPTIONS" && isControlPath(path)) return handleControl(request, method, path);

      return handleSync(request);
    },
  });
}

// Clamp a `limit` query param to a sane log-tail size (default 200, max 1000).
function clampLimit(raw: string | undefined): number {
  const n = Number(raw);

  if (!Number.isFinite(n) || n <= 0) return 200;

  return Math.min(1000, Math.floor(n));
}

// ---------------------------------------------------------------------------------------------
// Request-body parsing helpers (pure). The SDK sends fs paths in a few shapes; we accept all.
// ---------------------------------------------------------------------------------------------

interface BatchOperation {
  readonly op: string;
  readonly path: string;
  readonly parent?: string;
  readonly name?: string;
  readonly overwrite?: boolean;
  readonly recursive?: boolean;
  readonly create_missing_ancestors?: boolean;
  readonly operation_id?: string;
  readonly type?: string | null;
}

interface BatchUpload {
  readonly operations: readonly BatchOperation[];
  // file parts keyed by operation_id (and also by positional index "0","1",… as a fallback).
  readonly files: ReadonlyMap<string, Uint8Array>;
}

export function parseJsonBody(body: Uint8Array): Record<string, unknown> {
  if (body.byteLength === 0) return {};

  try {
    const parsed: unknown = JSON.parse(new TextDecoder().decode(body));

    return parsed !== null && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

// Read an app-create input from a driver `object` / REST body. Pure.
function readAppInput(obj: Record<string, unknown>): { name?: string; title?: string; index_url?: string; icon?: string; description?: string } {
  const out: { name?: string; title?: string; index_url?: string; icon?: string; description?: string } = {};

  if (typeof obj["name"] === "string") out.name = obj["name"];
  if (typeof obj["title"] === "string") out.title = obj["title"];
  const indexUrl = obj["index_url"] ?? obj["indexURL"] ?? obj["index"];

  if (typeof indexUrl === "string") out.index_url = indexUrl;
  if (typeof obj["icon"] === "string") out.icon = obj["icon"];
  if (typeof obj["description"] === "string") out.description = obj["description"];
  return out;
}

// Read a site-create input from a driver `object` / REST body. Pure.
function readSiteInput(obj: Record<string, unknown>): { subdomain?: string; root_dir?: string | null } {
  const out: { subdomain?: string; root_dir?: string | null } = {};

  if (typeof obj["subdomain"] === "string") out.subdomain = obj["subdomain"];
  const rootDir = obj["root_dir"] ?? obj["root"] ?? obj["dir_path"] ?? obj["dirPath"];

  if (typeof rootDir === "string") out.root_dir = rootDir;
  else if (rootDir === null) out.root_dir = null;
  return out;
}

// Read an entity NAME from a driver `args` (the SDK sends `{id:{name|subdomain}}` or a bare uid). Pure.
function readEntityName(args: Record<string, unknown>, key = "name"): string | undefined {
  const id = args["id"];

  if (id !== null && typeof id === "object") {
    const fromId = (id as Record<string, unknown>)[key] ?? (id as Record<string, unknown>)["name"];

    if (typeof fromId === "string") return fromId;
  }

  for (const k of [key, "name", "uid", "subdomain"]) {
    const v = args[k];

    if (typeof v === "string" && v.length > 0) return v;
  }

  return undefined;
}

// Resolve a path from a request. The SDK addresses a file differently per op (verified against the
// bundle): `fs.read` sends `GET /read?file=<path>`; readdir/stat send the path in the JSON BODY as
// `path`. We accept, in order: query `path`, query `file`, query `uid`, body `path`, body `file`. Pure.
function readPathFromRequest(req: ApiRequest): string | undefined {
  for (const key of ["path", "file", "uid"]) {
    const v = req.query[key];

    if (typeof v === "string" && v.length > 0) return v;
  }

  const obj = parseJsonBody(req.body);

  for (const key of ["path", "file", "uid"]) {
    const v = obj[key];

    if (typeof v === "string" && v.length > 0) return v;
  }

  return undefined;
}

// Collect the delete targets from a /delete request. The SDK sends `{ paths: [<path>,…] }`; legacy
// callers may send a single `path` (query or body). Returns a normalized, de-duplicated list. Pure.
function collectDeletePaths(req: ApiRequest, obj: Record<string, unknown>): string[] {
  const out: string[] = [];
  const raw = obj["paths"];

  if (Array.isArray(raw)) {
    for (const p of raw) {
      if (typeof p === "string" && p.length > 0) out.push(normalizePath(p));
    }
  }

  const single = readPathFromRequest(req);

  if (single !== undefined) out.push(normalizePath(single));

  return [...new Set(out)];
}

function resolveWritePath(op: BatchOperation): string {
  // The SDK's write op carries `path` = the DESTINATION DIRECTORY and `name` = the leaf filename
  // (verified against the bundle: e.g. `{op:"write", path:"~", name:"spike.txt"}`). So when `name` is
  // present, JOIN path-as-parent + name. Fall back to: explicit parent+name; or a `path` that already
  // includes the filename (no `name`).
  if (op.name !== undefined && op.name !== "") {
    const parent = op.path !== undefined && op.path !== "" ? op.path : (op.parent ?? "/");

    return joinParent(parent, op.name);
  }

  if (op.path !== undefined && op.path !== "") {
    if (op.parent !== undefined && !op.path.startsWith("/") && !op.path.startsWith("~")) {
      return joinParent(op.parent, op.path);
    }

    return normalizePath(op.path);
  }

  if (op.parent !== undefined && op.parent !== "") return normalizePath(op.parent);

  throw new PuterStoreError("field_missing", "write op missing path", 400);
}

function joinParent(parent: string | undefined, name: string): string {
  const base = parent === undefined || parent === "" ? "/" : normalizePath(parent);
  const leaf = name.replace(/^\/+/u, "");

  return normalizePath(base === "/" ? `/${leaf}` : `${base}/${leaf}`);
}

function dirOf(path: string): string {
  return dirname(path);
}

function baseOf(path: string): string {
  return basename(path);
}

// Parse a multipart/form-data body into operations + file parts. The SDK's /batch sends repeated
// `operation` parts (JSON), `fileinfo` parts (JSON), and `file` parts (the bytes). We pair file[i]
// with operation[i] positionally AND key files by operation_id where present.
export function parseMultipartBatch(body: Uint8Array, contentType: string): BatchUpload {
  const boundary = /boundary=([^;]+)/iu.exec(contentType)?.[1]?.trim().replace(/^"|"$/gu, "");

  if (boundary === undefined) {
    // Some callers (and our native path) may send a JSON batch: { operations: [...] } with inline data.
    const obj = parseJsonBody(body);
    const ops = Array.isArray(obj["operations"]) ? (obj["operations"] as BatchOperation[]) : [];
    const files = new Map<string, Uint8Array>();

    return { files, operations: ops };
  }

  const parts = splitMultipart(body, boundary);
  const operations: BatchOperation[] = [];
  const files = new Map<string, Uint8Array>();
  let fileIndex = 0;

  for (const part of parts) {
    const name = part.name;
    // A file part: anything carrying a filename, OR the conventional "file" field name. (The SDK sets
    // the form-field name to "file" with a filename; some paths key the field name by operation_id.)
    const isFilePart = part.filename !== undefined || name === "file";

    if (name === "operation" && !isFilePart) {
      try {
        operations.push(JSON.parse(new TextDecoder().decode(part.content)) as BatchOperation);
      } catch {
        // skip malformed op
      }
    } else if (name === "fileinfo" && !isFilePart) {
      // fileinfo is metadata only; the content bytes come from the file part. Ignore for write.
      continue;
    } else if (isFilePart) {
      files.set(String(fileIndex), part.content);
      // Capture by filename + the (possibly operation_id) field name so handleBatch can find it.
      if (part.filename !== undefined) files.set(part.filename, part.content);
      if (name !== "" && name !== "file") files.set(name, part.content);
      fileIndex += 1;
    }
  }

  // Re-key positional files by their operation's operation_id so handleBatch can find them.
  operations.forEach((op, i) => {
    const f = files.get(String(i));

    if (op.operation_id !== undefined && f !== undefined) files.set(op.operation_id, f);
  });

  return { files, operations };
}

interface MultipartPart {
  readonly name: string;
  readonly filename?: string;
  readonly content: Uint8Array;
}

// Minimal multipart/form-data splitter. Pure, byte-accurate. Handles CRLF headers + the trailing
// "--boundary--". Adequate for the SDK's batch shape; not a general RFC 7578 parser.
export function splitMultipart(body: Uint8Array, boundary: string): readonly MultipartPart[] {
  const delim = TEXT(`--${boundary}`);
  const parts: MultipartPart[] = [];
  const segments = splitOnDelimiter(body, delim);

  for (const seg of segments) {
    // Each segment begins with CRLF then headers, then CRLFCRLF, then content (then trailing CRLF).
    const headerEnd = indexOfSub(seg, TEXT("\r\n\r\n"));

    if (headerEnd < 0) continue;

    const headerText = new TextDecoder().decode(seg.slice(0, headerEnd)).trim();

    if (headerText === "" || headerText === "--") continue;

    // Extract `filename` FIRST, then `name` from a disposition with the filename token removed — so the
    // `name="..."` match never accidentally captures the `name="..."` substring inside `filename="..."`.
    const dispositionLine = /content-disposition:[^\n]*/iu.exec(headerText)?.[0];

    if (dispositionLine === undefined) continue;

    const filenameMatch = /filename="([^"]*)"/iu.exec(dispositionLine);
    const withoutFilename = dispositionLine.replace(/filename="[^"]*"/iu, "");
    const nameMatch = /(?:^|[;\s])name="([^"]*)"/iu.exec(withoutFilename);

    if (nameMatch === null && filenameMatch === null) continue;

    const fieldName = nameMatch?.[1] ?? "";
    const filename = filenameMatch?.[1];

    let content = seg.slice(headerEnd + 4);

    // Trim a single trailing CRLF that precedes the next boundary.
    if (content.byteLength >= 2 && content[content.byteLength - 2] === 0x0d && content[content.byteLength - 1] === 0x0a) {
      content = content.slice(0, content.byteLength - 2);
    }

    const part: MultipartPart = filename === undefined
      ? { content, name: fieldName }
      : { content, filename, name: fieldName };

    parts.push(part);
  }

  return parts;
}

function splitOnDelimiter(body: Uint8Array, delim: Uint8Array): Uint8Array[] {
  const out: Uint8Array[] = [];
  let start = 0;
  let idx = indexOfSub(body, delim, start);

  while (idx >= 0) {
    if (idx > start) out.push(body.slice(start, idx));
    start = idx + delim.byteLength;
    idx = indexOfSub(body, delim, start);
  }

  return out;
}

function indexOfSub(haystack: Uint8Array, needle: Uint8Array, from = 0): number {
  if (needle.byteLength === 0) return -1;

  outer: for (let i = from; i <= haystack.byteLength - needle.byteLength; i += 1) {
    for (let j = 0; j < needle.byteLength; j += 1) {
      if (haystack[i + j] !== needle[j]) continue outer;
    }

    return i;
  }

  return -1;
}
