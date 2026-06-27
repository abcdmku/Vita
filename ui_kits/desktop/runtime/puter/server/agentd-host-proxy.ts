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

// ---------------------------------------------------------------------------------------------
// STREAMING /pty host-proxy — the duplex byte stream that backs the on-device Terminal (capsule.exec).
//
// agentd's normal surface is buffered request/response (createAgentdUnixFetch above). The Terminal needs
// a full-duplex stream: an interactive shell's stdin/stdout/window-resize for the life of the session.
// This proxy dials agentd's unix socket, sends `GET /pty?cols=&rows=` with `Upgrade: vita-pty`, reads the
// 101, and then exposes the raw duplex stream as length-prefixed FRAMES (the SAME wire format the Go
// transport/pty.go + capsule/exec.go use):  uint8 type | uint32be length | payload.
//
// The exec backend (exec-plane.ts createAgentExecBackend) bridges the api_origin's JSON /pty websocket
// protocol to these frames over this stream. Deno-only (Deno.connect unix). Never in the browser bundle.
// ---------------------------------------------------------------------------------------------

// Frame types — MUST match agent/capabilities/capsule/exec.go ExecFrameType.
export const PTY_FRAME_STDIN = 0x01; // client→agentd: raw bytes → pty
export const PTY_FRAME_RESIZE = 0x02; // client→agentd: uint16be cols | uint16be rows
export const PTY_FRAME_STDOUT = 0x03; // agentd→client: raw pty output
export const PTY_FRAME_EXIT = 0x04; // agentd→client: int32be exit code
export const PTY_FRAME_ERROR = 0x05; // agentd→client: utf-8 message
export const PTY_FRAME_READY = 0x06; // agentd→client: utf-8 runtime label (unit name)

const PTY_FRAME_HEADER_BYTES = 5;
// Mirror the Go cap (capsule.ExecMaxFramePayloadBytes): reject an announced length above this.
const PTY_MAX_FRAME_PAYLOAD_BYTES = 1 << 20;

export interface PtyFrame {
  readonly type: number;
  readonly payload: Uint8Array;
}

// A live duplex frame stream to agentd's /pty. The exec backend reads frames (onFrame), sends frames
// (send), and closes it when the websocket drops.
export interface AgentdPtyStream {
  // Register the per-frame sink. Called for every agentd→client frame (READY/STDOUT/EXIT/ERROR).
  onFrame(cb: (frame: PtyFrame) => void): void;
  // Register the stream-closed sink (socket EOF / error / explicit close). Called exactly once.
  onClose(cb: () => void): void;
  // Send a client→agentd frame (STDIN/RESIZE). No-op after close.
  send(type: number, payload: Uint8Array): void;
  // Tear down: close the unix socket. Idempotent.
  close(): void;
}

export interface AgentdPtyOptions extends AgentdHostProxyOptions {
  // Initial terminal geometry (forwarded as the ?cols=&rows= query). Defaults 80x24.
  readonly cols?: number;
  readonly rows?: number;
}

export function encodePtyFrame(type: number, payload: Uint8Array): Uint8Array {
  const out = new Uint8Array(PTY_FRAME_HEADER_BYTES + payload.length);
  out[0] = type & 0xff;
  const len = payload.length;
  out[1] = (len >>> 24) & 0xff;
  out[2] = (len >>> 16) & 0xff;
  out[3] = (len >>> 8) & 0xff;
  out[4] = len & 0xff;
  out.set(payload, PTY_FRAME_HEADER_BYTES);
  return out;
}

export function encodeResizePayload(cols: number, rows: number): Uint8Array {
  const p = new Uint8Array(4);
  p[0] = (cols >>> 8) & 0xff;
  p[1] = cols & 0xff;
  p[2] = (rows >>> 8) & 0xff;
  p[3] = rows & 0xff;
  return p;
}

// Open the duplex /pty stream to agentd over the unix socket. Connects, performs the upgrade, then runs
// a read loop that reassembles frames and dispatches them. Fail-closed: a connect/upgrade failure invokes
// onClose (the backend surfaces it as an error to the terminal).
export async function createAgentdPtyStream(options: AgentdPtyOptions = {}): Promise<AgentdPtyStream> {
  const socketPath = options.socketPath ?? DEFAULT_AGENTD_SOCKET;
  const deno = options.deno ?? denoGlobal();
  const cols = options.cols ?? 80;
  const rows = options.rows ?? 24;

  const conn = await deno.connect({ transport: "unix", path: socketPath });

  // Send the upgrade request.
  const request =
    `GET /pty?cols=${cols}&rows=${rows} HTTP/1.1\r\n` +
    "Host: agentd\r\n" +
    "Upgrade: vita-pty\r\n" +
    "Connection: Upgrade\r\n\r\n";
  await writeAll(conn, new TextEncoder().encode(request));

  const frameSinks: ((frame: PtyFrame) => void)[] = [];
  const closeSinks: (() => void)[] = [];
  let closed = false;
  let inbound: Uint8Array<ArrayBufferLike> = new Uint8Array(0);
  let upgraded = false;

  const fireClose = (): void => {
    if (closed) return;
    closed = true;
    try { conn.close(); } catch { /* already closed */ }
    for (const cb of closeSinks) { try { cb(); } catch { /* ignore */ } }
  };

  const stream: AgentdPtyStream = {
    onFrame(cb) { frameSinks.push(cb); },
    onClose(cb) { closeSinks.push(cb); },
    send(type, payload) {
      if (closed) return;
      void writeAll(conn, encodePtyFrame(type, payload)).catch(() => fireClose());
    },
    close() { fireClose(); },
  };

  // The read loop: pull bytes, strip the 101 upgrade response (once), then reassemble + dispatch frames.
  void (async (): Promise<void> => {
    const buf = new Uint8Array(64 * 1024);
    try {
      for (;;) {
        const n = await conn.read(buf);
        if (n === null) break; // EOF
        inbound = concatChunks([inbound, buf.slice(0, n)], inbound.length + n);

        if (!upgraded) {
          const headerEnd = indexOfCRLFCRLF(inbound);
          if (headerEnd < 0) continue; // upgrade headers not complete yet
          const status = new TextDecoder().decode(inbound.slice(0, headerEnd));
          if (!/^HTTP\/1\.[01] 101/u.test(status)) {
            // agentd refused the upgrade (e.g. /pty not mounted → 404). Surface as a close.
            break;
          }
          upgraded = true;
          inbound = inbound.slice(headerEnd + 4);
        }

        // Drain complete frames.
        for (;;) {
          if (inbound.length < PTY_FRAME_HEADER_BYTES) break;
          const length =
            (inbound[1]! << 24) | (inbound[2]! << 16) | (inbound[3]! << 8) | inbound[4]!;
          if (length < 0 || length > PTY_MAX_FRAME_PAYLOAD_BYTES) {
            // A corrupt/oversized announced length → abort the stream rather than allocate.
            break;
          }
          const total = PTY_FRAME_HEADER_BYTES + length;
          if (inbound.length < total) break;
          const frame: PtyFrame = { type: inbound[0]!, payload: inbound.slice(PTY_FRAME_HEADER_BYTES, total) };
          inbound = inbound.slice(total);
          for (const cb of frameSinks) { try { cb(frame); } catch { /* ignore */ } }
        }
      }
    } catch { /* read error */ } finally {
      fireClose();
    }
  })();

  return stream;
}

function indexOfCRLFCRLF(buf: Uint8Array): number {
  for (let i = 0; i + 3 < buf.length; i += 1) {
    if (buf[i] === 0x0d && buf[i + 1] === 0x0a && buf[i + 2] === 0x0d && buf[i + 3] === 0x0a) {
      return i;
    }
  }
  return -1;
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
