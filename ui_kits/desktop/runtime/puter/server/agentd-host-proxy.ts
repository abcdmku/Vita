// On-device HOST-PROXY: exposes agentd's unix socket to the api_origin's /control/* bridge.
//
// The deploy/management console reaches the node's control plane through the api_origin (/control/*),
// which is backed by an AgentControlPlane. On-device that plane is createAgentHttpControlPlane({baseUrl,
// fetch}) — it speaks agentd's REAL HTTP shapes (GET /state, GET /read/capsule.execute, GET
// /read/capsule.logs, POST /apply, GET /healthz). But agentd does NOT listen on TCP in production: it
// serves that handler over a unix socket with SO_PEERCRED auth (/run/vita-agent/agentd.sock, ADR-0008),
// and a sandboxed browser — and `fetch` — cannot dial a unix socket.
//
// This module is the host-proxy that closes that gap: a `fetch`-shaped adapter that, per request, dials
// agentd's unix socket, writes the HTTP/1.1 request, and parses the response. agentd authenticates the
// connection by the platform process's peer credentials (it is in the vita-agent group, exactly like the
// ts runtime — see vita-ts.service), so no token crosses this hop; the api_origin's own `control`
// capability gate is the per-app authorization layer in front of it.
//
// Deno-only (Deno.connect unix transport). Imported by the boot entry (server-entry.ts); never part of
// the browser bundle. The HTTP/1.1 encode/parse mirrors the proven on-device agent transport
// (ts-overlay/.../vita/unix-socket-transport.ts) but stays self-contained to the puter runtime tree.

import { createAgentHttpControlPlane, type AgentControlPlane } from "../control-plane.ts";

// The default on-device agentd unix socket (ADR-0008). Overridable for a dev harness.
export const DEFAULT_AGENTD_SOCKET = "/run/vita-agent/agentd.sock";

// A synthetic origin for the requests: agentd ignores the authority (it routes on the path only), but
// the URL parser needs a well-formed origin, and HTTP/1.1 needs a Host header.
const AGENTD_ORIGIN = "http://agentd";
const DEFAULT_MAX_RESPONSE_BYTES = 256 * 1024;

// The minimal Deno surface this module needs. Declared structurally so the file type-checks under both
// `deno run` (real Deno global) and the dev harness's node strip-types pass (no Deno types installed).
interface DenoConn {
  read(p: Uint8Array): Promise<number | null>;
  write(p: Uint8Array): Promise<number>;
  close(): void;
}
interface DenoLike {
  connect(options: { readonly transport: "unix"; readonly path: string }): Promise<DenoConn>;
}

function denoGlobal(): DenoLike {
  const d = (globalThis as { Deno?: DenoLike }).Deno;

  if (d === undefined) {
    throw new Error("agentd host-proxy requires the Deno runtime (Deno.connect unix transport)");
  }

  return d;
}

export interface AgentdHostProxyOptions {
  // The agentd unix socket path. Default /run/vita-agent/agentd.sock.
  readonly socketPath?: string;
  // Cap on a single agentd response (bytes). A bounded read so a runaway journal cannot exhaust memory.
  readonly maxResponseBytes?: number;
  // Injected Deno-like (tests). Default: the real Deno global.
  readonly deno?: DenoLike;
}

// Build a `fetch`-compatible function that forwards each request to agentd over its unix socket. Only the
// subset createAgentHttpControlPlane uses is honored: method, headers, body; the result exposes ok,
// status, and json(). This is the host-proxy `fetch` the control-plane client is constructed with.
export function createAgentdUnixFetch(options: AgentdHostProxyOptions = {}): typeof fetch {
  const socketPath = options.socketPath ?? DEFAULT_AGENTD_SOCKET;
  const maxResponseBytes = options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
  const deno = options.deno ?? denoGlobal();

  const unixFetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const urlText = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
    const headers = normalizeHeaders(init?.headers as HeaderInput);
    const body = typeof init?.body === "string" ? init.body : "";

    const { status, body: responseBody } = await requestOverUnixSocket(deno, socketPath, maxResponseBytes, urlText, method, headers, body);

    // A minimal Response: createAgentHttpControlPlane only reads .ok, .status, and .json(). Construct a
    // real Response so those are exact (status text, ok derivation, json parsing).
    return new Response(responseBody, { status });
  };

  return unixFetch as typeof fetch;
}

// Build the on-device control plane: createAgentHttpControlPlane over the unix-socket host-proxy fetch.
// This is what the boot entry passes to startPuterPlatformService({ controlPlane }), so /control/* reads
// and acts on REAL capsules (list/start/stop/status/logs) via agentd's real shapes.
export function createOnDeviceControlPlane(options: AgentdHostProxyOptions = {}): AgentControlPlane {
  return createAgentHttpControlPlane({
    baseUrl: AGENTD_ORIGIN,
    fetch: createAgentdUnixFetch(options),
  });
}

// The control-plane client only ever passes a plain Record header bag (see control-plane.ts), but accept
// the full RequestInit.headers union defensively. Typed inline so this module needs no DOM lib type
// (HeadersInit) it can't resolve under the project's tsconfig.
type HeaderInput = Headers | readonly (readonly [string, string])[] | Record<string, string> | undefined;

function normalizeHeaders(headers: HeaderInput): Record<string, string> {
  const out: Record<string, string> = {};

  if (headers === undefined) return out;

  if (typeof Headers !== "undefined" && headers instanceof Headers) {
    headers.forEach((value, key) => { out[key] = value; });
    return out;
  }

  if (Array.isArray(headers)) {
    for (const [key, value] of headers as readonly (readonly [string, string])[]) out[key] = value;
    return out;
  }

  for (const [key, value] of Object.entries(headers as Record<string, string>)) out[key] = String(value);

  return out;
}

async function requestOverUnixSocket(
  deno: DenoLike,
  socketPath: string,
  maxResponseBytes: number,
  urlText: string,
  method: string,
  headers: Record<string, string>,
  body: string,
): Promise<{ status: number; body: string }> {
  let conn: DenoConn | undefined;

  try {
    conn = await deno.connect({ transport: "unix", path: socketPath });
    await writeAll(conn, encodeHttpRequest(urlText, method, headers, body));

    return parseHttpResponse(await readAllText(conn, maxResponseBytes));
  } finally {
    conn?.close();
  }
}

function encodeHttpRequest(urlText: string, method: string, headers: Record<string, string>, body: string): Uint8Array {
  const url = new URL(urlText, AGENTD_ORIGIN);
  const target = `${url.pathname}${url.search}`;
  const lines = [
    `${method} ${target} HTTP/1.1`,
    "Host: agentd",
    "Connection: close",
  ];

  // Stable, lowercase header order (agentd does not depend on order; sorting keeps the wire
  // deterministic + test-stable). Content-Length is appended from the actual body byte length.
  for (const key of Object.keys(headers).sort()) {
    lines.push(`${key}: ${headers[key] ?? ""}`);
  }

  const bodyBytes = new TextEncoder().encode(body);
  if (bodyBytes.length > 0) {
    lines.push(`Content-Length: ${bodyBytes.length}`);
  }

  return new TextEncoder().encode(`${lines.join("\r\n")}\r\n\r\n${body}`);
}

async function writeAll(conn: DenoConn, data: Uint8Array): Promise<void> {
  let offset = 0;

  while (offset < data.length) {
    const written = await conn.write(data.subarray(offset));

    if (written <= 0) throw new Error("agentd socket write made no progress");

    offset += written;
  }
}

async function readAllText(conn: DenoConn, maxResponseBytes: number): Promise<string> {
  const chunks: Uint8Array[] = [];
  const buffer = new Uint8Array(4096);
  let total = 0;

  while (true) {
    const read = await conn.read(buffer);

    if (read === null) break;

    total += read;
    if (total > maxResponseBytes) throw new Error("agentd response exceeded size limit");

    chunks.push(buffer.slice(0, read));
  }

  return new TextDecoder().decode(concatChunks(chunks, total));
}

function concatChunks(chunks: readonly Uint8Array[], total: number): Uint8Array {
  const out = new Uint8Array(total);
  let offset = 0;

  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }

  return out;
}

function parseHttpResponse(raw: string): { status: number; body: string } {
  const headerEnd = raw.indexOf("\r\n\r\n");
  if (headerEnd < 0) throw new Error("agentd response missing HTTP headers");

  const headerLines = raw.slice(0, headerEnd).split("\r\n");
  const statusLine = headerLines[0];
  if (statusLine === undefined) throw new Error("agentd response missing HTTP status");

  const statusMatch = /^HTTP\/1\.[01] ([0-9]{3})(?:\s|$)/u.exec(statusLine);
  const statusCodeText = statusMatch?.[1];
  if (statusCodeText === undefined) throw new Error("agentd response has invalid HTTP status");

  const headers = new Map<string, string>();
  for (let index = 1; index < headerLines.length; index += 1) {
    const line = headerLines[index];

    if (line === undefined || line.length === 0) continue;

    const separator = line.indexOf(":");
    if (separator <= 0) throw new Error("agentd response has invalid HTTP header");

    headers.set(line.slice(0, separator).trim().toLowerCase(), line.slice(separator + 1).trim());
  }

  let body = raw.slice(headerEnd + 4);
  const transferEncoding = (headers.get("transfer-encoding") ?? "").toLowerCase();
  if (transferEncoding.split(",").some((e) => e.trim() === "chunked")) {
    body = decodeChunkedBody(body);
  }

  return { body, status: Number.parseInt(statusCodeText, 10) };
}

function decodeChunkedBody(body: string): string {
  let rest = body;
  let decoded = "";

  while (true) {
    const lineEnd = rest.indexOf("\r\n");
    if (lineEnd < 0) throw new Error("chunked agentd response is missing a chunk header");

    const sizeText = rest.slice(0, lineEnd).split(";", 1)[0];
    if (sizeText === undefined) throw new Error("chunked agentd response has an invalid chunk size");

    const size = Number.parseInt(sizeText, 16);
    if (!Number.isFinite(size) || size < 0) throw new Error("chunked agentd response has an invalid chunk size");
    if (size === 0) return decoded;

    const chunkStart = lineEnd + 2;
    const chunkEnd = chunkStart + size;
    if (rest.length < chunkEnd + 2 || rest.slice(chunkEnd, chunkEnd + 2) !== "\r\n") {
      throw new Error("chunked agentd response has an incomplete chunk");
    }

    decoded += rest.slice(chunkStart, chunkEnd);
    rest = rest.slice(chunkEnd + 2);
  }
}
