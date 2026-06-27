// Puter compat — the harness HTTP server (node:http adapter around the transport-agnostic api_origin).
//
// This is the ONLY node:http-coupled module in the compat layer, and it exists for the SPIKE HARNESS
// (and a future on-device adapter can mirror it). It:
//   1. Serves the desktop preview + vendored puter.js + the spike test app as static files, AND
//   2. Routes /api/* to the local api_origin handler (createApiOrigin), translating node req/res to the
//      normalized ApiRequest/ApiResponse.
//
// Keeping the protocol logic OUT of here (in api-origin.ts) is the point: the same handler runs in the
// browser-side preview path and will run on-device behind the host-proxy. This file is glue.
//
// Node-only. Imported by tools/harness scripts via dynamic import; never part of the browser bundle.

import { createHash } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { createReadStream, existsSync, statSync } from "node:fs";
import { extname, join, normalize, resolve, sep } from "node:path";

import {
  type ApiOrigin,
  type ApiRequest,
} from "./api-origin.ts";

// A per-request face gate, evaluated BEFORE the api_origin's per-app capability check. The network
// (remote-browser) face uses this to require an opaque OWNER token over the connection; the loopback
// (trust-on-host) face passes a gate that always allows. Returns undefined to allow, or an
// {status, body} to short-circuit (e.g. 401 when the owner token is missing/wrong).
export type FaceGate = (request: ApiRequest) => { readonly status: number; readonly body: string } | undefined;

export interface HarnessServerDeps {
  readonly apiOrigin: ApiOrigin;
  // Root directory static files are served from (the desktop ui_kits dir, etc.).
  readonly staticRoot: string;
  // The path prefix routed to the api_origin (default "/api"). Stripped before handing to the handler.
  readonly apiPrefix?: string;
  // URL-prefix → absolute-dir aliases. A request whose path starts with the prefix is served from the
  // aliased dir (longest prefix wins). Lets the spike app use stable paths (e.g. /_vendor/puter/v2.js)
  // regardless of staticRoot. Each value must be an absolute directory.
  readonly staticAliases?: Readonly<Record<string, string>>;
  readonly port?: number;
  readonly host?: string;
  // Optional face gate (owner-auth) applied to BOTH api + static requests on this listener. Default:
  // allow all (the loopback face). The network face supplies an owner-token gate.
  readonly faceGate?: FaceGate;
  // Optional TLS material (PEM cert+key). When present, the listener is HTTPS (node:https) instead of
  // plain HTTP — used for the NETWORK face (the owner token is a bearer secret, so TLS is mandatory
  // there). The local/kiosk face omits this (plain HTTP on loopback, trust-on-host). See server/tls.ts.
  readonly tls?: { readonly cert: string; readonly key: string };
  // LOCAL FACE ONLY: a provider for the minted local app-session token. When set, this listener serves a
  // same-origin `GET /session.js` that the kiosk page loads to authenticate the in-browser puter.js SDK
  // to the local api_origin (it calls puter.setAPIOrigin + puter.setAuthToken). The NETWORK face MUST NOT
  // set this — the local kiosk token is a trust-on-host secret and must never be served to a remote
  // client (the network face already gates on the separate owner token). Returns the current token, or
  // undefined before the session is minted (then /session.js answers a benign no-token stub).
  readonly localSessionToken?: () => string | undefined;
  // Extra dynamic GET routes (exact-path → handler returning {contentType, body}). Evaluated AFTER the
  // session/socket short-circuits and BEFORE static serving. Used by the shell harness to serve
  // /shell-session.js (the per-app token map) without a static file. Subject to the same face gate as
  // static requests (so the network face won't leak local-only routes). Returns undefined to fall
  // through to static serving.
  readonly extraRoutes?: Readonly<Record<string, () => { readonly contentType: string; readonly body: string }>>;
}

export interface HarnessServer {
  readonly url: string;
  readonly port: number;
  readonly host: string;
  // "http" (plain) or "https" (TLS). The network face is https; the local face is http.
  readonly scheme: "http" | "https";
  close(): Promise<void>;
}

const MIME: Readonly<Record<string, string>> = Object.freeze({
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".txt": "text/plain; charset=utf-8",
});

export async function startHarnessServer(deps: HarnessServerDeps): Promise<HarnessServer> {
  const apiPrefix = deps.apiPrefix ?? "/api";
  const staticRoot = resolve(deps.staticRoot);
  const host = deps.host ?? "127.0.0.1";

  // Normalize aliases to [prefix, absoluteDir] sorted longest-prefix-first.
  const aliases: [string, string][] = Object.entries(deps.staticAliases ?? {})
    .map(([prefix, dir]) => [prefix, resolve(dir)] as [string, string])
    .sort((a, b) => b[0].length - a[0].length);

  const faceGate = deps.faceGate;
  const localSessionToken = deps.localSessionToken;
  const extraRoutes = deps.extraRoutes;

  const onRequest = (req: IncomingMessage, res: ServerResponse): void => {
    handleRequest(req, res, deps.apiOrigin, apiPrefix, staticRoot, aliases, faceGate, localSessionToken, extraRoutes).catch((err: unknown) => {
      res.statusCode = 500;
      res.end(`internal error: ${err instanceof Error ? err.message : String(err)}`);
    });
  };

  // TLS network face → node:https; plain face → node:http. Same request handler either way.
  const scheme: "http" | "https" = deps.tls !== undefined ? "https" : "http";
  const server = deps.tls !== undefined
    ? createHttpsServer({ cert: deps.tls.cert, key: deps.tls.key }, onRequest)
    : createServer(onRequest);

  // Realtime websocket short-circuit. socket.io tries a `transport=websocket` upgrade in parallel with
  // polling regardless of the OPEN frame's `upgrades:[]`. If we leave the node 'upgrade' event
  // unhandled, the socket is destroyed → the browser logs a "WebSocket handshake failed (404)" error
  // and retries. Instead we COMPLETE the handshake (101) and immediately send an Engine.IO close, so
  // the client sees a clean, intentional close (no error, no infinite retry). Vita's offline kiosk has
  // no realtime backend; the app uses none. (Same posture as the polling stub above.)
  server.on("upgrade", (req: IncomingMessage, socket: import("node:net").Socket) => {
    const path = (req.url ?? "").split("?")[0] ?? "";

    if (!path.startsWith("/socket.io/")) { socket.destroy(); return; }

    closeRealtimeUpgrade(req, socket);
  });

  const port = await listen(server, deps.port ?? 0, host);
  const url = `${scheme}://${host}:${port}`;

  return Object.freeze({
    async close(): Promise<void> {
      await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
    },
    host,
    port,
    scheme,
    url,
  });
}

async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  apiOrigin: ApiOrigin,
  apiPrefix: string,
  staticRoot: string,
  aliases: readonly [string, string][],
  faceGate: FaceGate | undefined,
  localSessionToken: (() => string | undefined) | undefined,
  extraRoutes: Readonly<Record<string, () => { readonly contentType: string; readonly body: string }>> | undefined,
): Promise<void> {
  const rawUrl = req.url ?? "/";
  const [pathOnly, queryString] = splitQuery(rawUrl);

  // LOCAL-FACE session bootstrap. The minted local app-session token never reaches the page through the
  // static files (the page is identical on both faces); we hand it to the in-browser puter.js SDK with a
  // tiny same-origin script served ONLY on the face that has a token provider (the local/kiosk face). The
  // network face never sets localSessionToken, so /session.js there falls through to a 404 — the local
  // kiosk token is a trust-on-host secret and must not be served to a remote client. (The path is also
  // guarded by the network face gate above for static requests; the provider gate is the primary defence.)
  if (localSessionToken !== undefined && req.method !== undefined && req.method.toUpperCase() === "GET" && pathOnly === "/session.js") {
    serveSessionScript(res, apiPrefix, localSessionToken());
    return;
  }

  // Realtime socket short-circuit. The puter.js SDK opens a socket.io realtime channel against the
  // origin (for live fs/kv change events). Vita's single-owner offline kiosk has no realtime backend,
  // and an unanswered `/socket.io/` makes the SDK 404 + retry a websocket forever (console noise +
  // wasted reconnects on an offline node). Answer the Engine.IO polling handshake with a valid OPEN
  // packet that advertises NO upgrades and a long ping interval, so the client stays on a quiet
  // long-poll instead of hammering a websocket. (No real events are delivered — the app does not use
  // realtime; this purely keeps the SDK calm + the console clean.)
  if (pathOnly === "/socket.io/" || pathOnly.startsWith("/socket.io/")) {
    serveEngineIoStub(res, req.method ?? "GET");
    return;
  }

  // CORS preflight for the api surface (the SDK uses credentials + a bearer header).
  if (pathOnly.startsWith(apiPrefix)) {
    const apiPath = pathOnly.slice(apiPrefix.length) || "/";
    const body = await readBody(req);
    const request: ApiRequest = Object.freeze({
      body,
      headers: lowercaseHeaders(req.headers),
      method: req.method ?? "GET",
      path: apiPath,
      query: parseQuery(queryString),
    });

    // OWNER-AUTH FACE GATE (network face): evaluated before the per-app capability gate. Preflight
    // OPTIONS is exempt so CORS still works; everything else must clear the face gate.
    if (faceGate !== undefined && (req.method ?? "GET").toUpperCase() !== "OPTIONS") {
      const denied = faceGate(request);

      if (denied !== undefined) {
        res.statusCode = denied.status;
        res.setHeader("content-type", "application/json; charset=utf-8");
        res.setHeader("access-control-allow-origin", "*");
        res.end(denied.body);
        return;
      }
    }

    const response = await apiOrigin.handleAsync(request);

    res.statusCode = response.status;
    for (const [k, v] of Object.entries(response.headers)) res.setHeader(k, v);
    res.end(Buffer.from(response.body));
    return;
  }

  // Owner-auth face gate also covers static serving (the network face must not serve the entry page
  // or vendored SDK to an unauthenticated remote client).
  if (faceGate !== undefined) {
    const staticReq: ApiRequest = Object.freeze({
      body: new Uint8Array(0),
      headers: lowercaseHeaders(req.headers),
      method: req.method ?? "GET",
      path: pathOnly,
      query: parseQuery(queryString),
    });
    const denied = faceGate(staticReq);

    if (denied !== undefined) {
      res.statusCode = denied.status;
      res.setHeader("content-type", "application/json; charset=utf-8");
      res.end(denied.body);
      return;
    }
  }

  // Extra dynamic GET routes (e.g. /shell-session.js). Evaluated after the face gate, before static
  // serving. Exact-path match, GET only.
  if (extraRoutes !== undefined && (req.method ?? "GET").toUpperCase() === "GET") {
    const route = extraRoutes[pathOnly];

    if (route !== undefined) {
      const { contentType, body } = route();

      res.statusCode = 200;
      res.setHeader("content-type", contentType);
      res.setHeader("cache-control", "no-store");
      res.end(body);
      return;
    }
  }

  // Aliased static serving: a request under an alias prefix is served from the aliased dir.
  const decodedPath = decodeURIComponent(pathOnly);

  for (const [prefix, dir] of aliases) {
    if (decodedPath === prefix || decodedPath.startsWith(`${prefix}/`)) {
      const rest = decodedPath.slice(prefix.length).replace(/^\//u, "");

      serveFromRoot(rest === "" ? "/index.html" : `/${rest}`, res, dir);
      return;
    }
  }

  // Static file serving (desktop preview, vendored puter.js, spike app).
  serveFromRoot(decodedPath, res, staticRoot);
}

// Build + serve the same-origin session bootstrap script the kiosk page loads. It points the in-browser
// puter.js SDK at OUR local api_origin and hands it the minted app-session token, so the SDK's
// whoami/fs/kv calls carry `Authorization: Bearer <token>` and clear the always-on per-app capability gate
// (no 401). Served from the LOCAL face only (the network face has no token provider). The token is
// embedded as a JSON string literal so it can never break out of the string context.
export function buildSessionScript(apiPrefix: string, token: string | undefined): string {
  // The SDK reads its origin from `puter.APIOrigin` and the bearer from `puter.authToken`; the public
  // setters are setAPIOrigin()/setAuthToken() (verified against the vendored bundle). Same-origin: the
  // api_origin is `<this origin>${apiPrefix}` — we use a relative prefix so it works regardless of host.
  const prefixLiteral = JSON.stringify(apiPrefix);
  const tokenLiteral = JSON.stringify(token ?? "");

  return [
    "// Vita LOCAL-face session bootstrap — served only on the trust-on-host kiosk face (server.ts).",
    "(function () {",
    "  var apiOrigin = window.location.origin + " + prefixLiteral + ";",
    "  var token = " + tokenLiteral + ";",
    "  function apply() {",
    "    if (typeof window.puter !== 'object' || window.puter === null) return false;",
    "    try { if (typeof window.puter.setAPIOrigin === 'function') window.puter.setAPIOrigin(apiOrigin); } catch (e) {}",
    "    try { window.puter.APIOrigin = apiOrigin; } catch (e) {}",
    "    if (token) {",
    "      try { if (typeof window.puter.setAuthToken === 'function') window.puter.setAuthToken(token); } catch (e) {}",
    "      try { window.puter.authToken = token; } catch (e) {}",
    "    }",
    // Mark the SDK as an APP (not a generic 'web' site) so it treats the trust-on-host token as its
    // app session and NEVER pops its 'authenticate with Puter' consent modal (which is gated on
    // `'web' === puter.env`, verified against the vendored bundle). The kiosk IS running an app
    // against our local api_origin. Also silence the promotional console banner.
    "    try { window.puter.env = 'app'; } catch (e) {}",
    "    try { window.puter.quiet = true; } catch (e) {}",
    "    return true;",
    "  }",
    "  window.__vitaSession = { apiOrigin: apiOrigin, hasToken: !!token };",
    "  // puter.js initializes synchronously on load, so applying immediately works; retry briefly in case",
    "  // this script raced ahead of the SDK's own bootstrap.",
    "  if (!apply()) {",
    "    var tries = 0;",
    "    var iv = setInterval(function () { tries++; if (apply() || tries > 50) clearInterval(iv); }, 20);",
    "  }",
    "})();",
    "",
  ].join("\n");
}

function serveSessionScript(res: ServerResponse, apiPrefix: string, token: string | undefined): void {
  const body = buildSessionScript(apiPrefix, token);

  res.statusCode = 200;
  res.setHeader("content-type", "text/javascript; charset=utf-8");
  res.setHeader("cache-control", "no-store");
  res.end(body);
}

// A minimal Engine.IO v4 polling stub. The client's first request is `GET /socket.io/?EIO=4&
// transport=polling`; it expects an OPEN frame: the char '0' followed by a JSON handshake. We
// advertise NO upgrades (so it never tries the websocket) and a long ping interval (so it idles
// quietly). Subsequent polling requests just get an empty 200. We never push events — Vita's offline
// kiosk has no realtime backend; this exists only to keep the SDK from 404-looping a websocket.
export function buildEngineIoOpen(): string {
  const sid = "vita-" + Math.random().toString(36).slice(2, 14);
  const handshake = { sid, upgrades: [], pingInterval: 300000, pingTimeout: 600000, maxPayload: 1000000 };

  return "0" + JSON.stringify(handshake);
}

// Complete a websocket handshake (RFC 6455: 101 + Sec-WebSocket-Accept = base64(sha1(key + GUID)))
// then send a single Engine.IO "close" frame and end the socket. The browser sees an intentional close
// (no failed-handshake error, no retry storm). Best-effort; any error just destroys the socket.
function closeRealtimeUpgrade(req: IncomingMessage, socket: import("node:net").Socket): void {
  try {
    const key = req.headers["sec-websocket-key"];

    if (typeof key !== "string") { socket.destroy(); return; }

    const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
    const accept = createHash("sha1").update(key + GUID).digest("base64");
    const handshake =
      "HTTP/1.1 101 Switching Protocols\r\n" +
      "Upgrade: websocket\r\n" +
      "Connection: Upgrade\r\n" +
      `Sec-WebSocket-Accept: ${accept}\r\n\r\n`;

    socket.write(handshake);
    // A masked-free server text frame carrying the Engine.IO "noop/close" intent ('1' = CLOSE packet).
    // FIN=1, opcode=0x1 (text), payload length 1, payload '1'.
    socket.write(Buffer.from([0x81, 0x01, 0x31]));
    socket.end();
  } catch {
    socket.destroy();
  }
}

function serveEngineIoStub(res: ServerResponse, method: string): void {
  res.setHeader("access-control-allow-origin", "*");
  res.setHeader("cache-control", "no-store");

  if (method.toUpperCase() === "OPTIONS") {
    res.statusCode = 204;
    res.end();
    return;
  }

  // A GET (the handshake / a poll) gets an OPEN frame the first time and an empty 200 thereafter. We
  // can't cheaply tell handshake from poll here without state; always returning a valid OPEN frame is
  // harmless (the client treats it as a fresh session and idles on the long ping). A POST (the client
  // flushing its send buffer) gets a benign "ok".
  res.statusCode = 200;
  res.setHeader("content-type", "text/plain; charset=utf-8");
  res.end(method.toUpperCase() === "POST" ? "ok" : buildEngineIoOpen());
}

function serveFromRoot(decoded: string, res: ServerResponse, staticRoot: string): void {
  const rel = decoded === "/" ? "/index.html" : decoded;
  const candidate = normalize(join(staticRoot, rel));

  // Path-traversal guard: the resolved file must stay under staticRoot.
  if (!candidate.startsWith(staticRoot + sep) && candidate !== staticRoot) {
    res.statusCode = 403;
    res.end("forbidden");
    return;
  }

  let filePath = candidate;

  if (existsSync(filePath) && statSync(filePath).isDirectory()) {
    filePath = join(filePath, "index.html");
  }

  if (!existsSync(filePath) || !statSync(filePath).isFile()) {
    res.statusCode = 404;
    res.end("not found");
    return;
  }

  res.statusCode = 200;
  res.setHeader("content-type", MIME[extname(filePath).toLowerCase()] ?? "application/octet-stream");
  // Allow the iframe app to be framed by the same-origin preview.
  res.setHeader("cache-control", "no-cache");
  createReadStream(filePath).pipe(res);
}

function listen(server: Server, port: number, host: string): Promise<number> {
  return new Promise((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(port, host, () => {
      const addr = server.address();

      if (addr !== null && typeof addr === "object") resolveListen(addr.port);
      else rejectListen(new Error("failed to bind"));
    });
  });
}

function readBody(req: IncomingMessage): Promise<Uint8Array> {
  return new Promise((resolveBody, rejectBody) => {
    const chunks: Buffer[] = [];

    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => resolveBody(new Uint8Array(Buffer.concat(chunks))));
    req.on("error", rejectBody);
  });
}

function lowercaseHeaders(headers: IncomingMessage["headers"]): Record<string, string> {
  const out: Record<string, string> = {};

  for (const [k, v] of Object.entries(headers)) {
    if (v === undefined) continue;
    out[k.toLowerCase()] = Array.isArray(v) ? v.join(", ") : v;
  }

  return out;
}

function splitQuery(url: string): [string, string] {
  const q = url.indexOf("?");

  return q < 0 ? [url, ""] : [url.slice(0, q), url.slice(q + 1)];
}

function parseQuery(query: string): Record<string, string> {
  const out: Record<string, string> = {};

  if (query === "") return out;

  for (const pair of query.split("&")) {
    const eq = pair.indexOf("=");
    const key = decodeURIComponent(eq < 0 ? pair : pair.slice(0, eq));
    const value = eq < 0 ? "" : decodeURIComponent(pair.slice(eq + 1).replace(/\+/gu, " "));

    out[key] = value;
  }

  return out;
}
