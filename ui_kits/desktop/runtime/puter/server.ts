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

  const onRequest = (req: IncomingMessage, res: ServerResponse): void => {
    handleRequest(req, res, deps.apiOrigin, apiPrefix, staticRoot, aliases, faceGate).catch((err: unknown) => {
      res.statusCode = 500;
      res.end(`internal error: ${err instanceof Error ? err.message : String(err)}`);
    });
  };

  // TLS network face → node:https; plain face → node:http. Same request handler either way.
  const scheme: "http" | "https" = deps.tls !== undefined ? "https" : "http";
  const server = deps.tls !== undefined
    ? createHttpsServer({ cert: deps.tls.cert, key: deps.tls.key }, onRequest)
    : createServer(onRequest);

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
): Promise<void> {
  const rawUrl = req.url ?? "/";
  const [pathOnly, queryString] = splitQuery(rawUrl);

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
