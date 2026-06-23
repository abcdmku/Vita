import type {
  AgentTransport,
  AgentTransportInit,
  AgentTransportResponse,
} from "./agent-client.ts";

export interface DenoUnixSocketTransportOptions {
  readonly socketPath: string;
  readonly host?: string;
  readonly maxResponseBytes?: number;
}

interface HttpResponse {
  readonly statusCode: number;
  readonly body: string;
}

const DEFAULT_HOST = "agentd";
const DEFAULT_MAX_RESPONSE_BYTES = 64 * 1024;

export function createDenoUnixSocketAgentTransport(
  options: DenoUnixSocketTransportOptions,
): AgentTransport {
  const host = options.host ?? DEFAULT_HOST;
  const maxResponseBytes = options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;

  return async (url, init) => {
    if (init.method !== "GET") {
      throw new Error("on-device agent transport is read-only");
    }

    return requestOverUnixSocket(
      options.socketPath,
      host,
      maxResponseBytes,
      url,
      init,
    );
  };
}

export function createDenoUnixSocketApplyAgentTransport(
  options: DenoUnixSocketTransportOptions,
): AgentTransport {
  const host = options.host ?? DEFAULT_HOST;
  const maxResponseBytes = options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;

  // This only widens the TS transport guard to POST /apply. agentd still treats
  // the plan as untrusted and re-validates it in server.go buildPlan before
  // transaction execution.
  return async (url, init) => {
    if (init.method !== "GET" && !isApplyPost(url, init)) {
      throw new Error("on-device agent transport only allows GET plus POST /apply");
    }

    return requestOverUnixSocket(
      options.socketPath,
      host,
      maxResponseBytes,
      url,
      init,
    );
  };
}

function isApplyPost(urlText: string, init: AgentTransportInit): boolean {
  if (init.method !== "POST") {
    return false;
  }

  const url = new URL(urlText);
  return url.pathname === "/apply" && url.search === "";
}

async function requestOverUnixSocket(
  socketPath: string,
  host: string,
  maxResponseBytes: number,
  urlText: string,
  init: AgentTransportInit,
): Promise<AgentTransportResponse> {
  let conn: Deno.Conn | undefined;

  try {
    conn = await Deno.connect({ transport: "unix", path: socketPath });
    await writeAll(conn, encodeHttpRequest(host, urlText, init));

    const response = parseHttpResponse(await readAllText(conn, maxResponseBytes));
    return {
      ok: response.statusCode >= 200 && response.statusCode < 300,
      status: response.statusCode,
      text: async () => response.body,
    };
  } finally {
    conn?.close();
  }
}

function encodeHttpRequest(host: string, urlText: string, init: AgentTransportInit): Uint8Array {
  const url = new URL(urlText);
  const target = `${url.pathname}${url.search}`;
  const body = init.body ?? "";
  const lines = [
    `${init.method} ${target} HTTP/1.1`,
    `Host: ${host}`,
    "Connection: close",
  ];
  const headers = init.headers ?? {};
  const headerKeys = Object.keys(headers).sort(compareStrings);

  for (let index = 0; index < headerKeys.length; index += 1) {
    const key = headerKeys[index];

    if (key !== undefined) {
      lines.push(`${key}: ${headers[key] ?? ""}`);
    }
  }

  if (body.length > 0) {
    lines.push(`Content-Length: ${new TextEncoder().encode(body).length}`);
  }

  return new TextEncoder().encode(`${lines.join("\r\n")}\r\n\r\n${body}`);
}

async function writeAll(conn: Deno.Conn, data: Uint8Array): Promise<void> {
  let offset = 0;

  while (offset < data.length) {
    const written = await conn.write(data.subarray(offset));

    if (written <= 0) {
      throw new Error("socket write made no progress");
    }

    offset += written;
  }
}

async function readAllText(conn: Deno.Conn, maxResponseBytes: number): Promise<string> {
  const chunks: Uint8Array[] = [];
  const buffer = new Uint8Array(4096);
  let total = 0;

  while (true) {
    const read = await conn.read(buffer);

    if (read === null) {
      break;
    }

    total += read;
    if (total > maxResponseBytes) {
      throw new Error("agentd response exceeded size limit");
    }

    chunks.push(buffer.slice(0, read));
  }

  return new TextDecoder().decode(concatChunks(chunks, total));
}

function concatChunks(chunks: readonly Uint8Array[], total: number): Uint8Array {
  const out = new Uint8Array(total);
  let offset = 0;

  for (let index = 0; index < chunks.length; index += 1) {
    const chunk = chunks[index];

    if (chunk !== undefined) {
      out.set(chunk, offset);
      offset += chunk.length;
    }
  }

  return out;
}

function parseHttpResponse(raw: string): HttpResponse {
  const headerEnd = raw.indexOf("\r\n\r\n");
  if (headerEnd < 0) {
    throw new Error("agentd response missing HTTP headers");
  }

  const headerLines = raw.slice(0, headerEnd).split("\r\n");
  const statusLine = headerLines[0];
  if (statusLine === undefined) {
    throw new Error("agentd response missing HTTP status");
  }

  const statusMatch = /^HTTP\/1\.[01] ([0-9]{3})(?:\s|$)/u.exec(statusLine);
  const statusCodeText = statusMatch?.[1];
  if (statusCodeText === undefined) {
    throw new Error("agentd response has invalid HTTP status");
  }

  const headers = new Map<string, string>();
  for (let index = 1; index < headerLines.length; index += 1) {
    const line = headerLines[index];

    if (line === undefined || line.length === 0) {
      continue;
    }

    const separator = line.indexOf(":");
    if (separator <= 0) {
      throw new Error("agentd response has invalid HTTP header");
    }

    headers.set(
      line.slice(0, separator).trim().toLowerCase(),
      line.slice(separator + 1).trim().toLowerCase(),
    );
  }

  let body = raw.slice(headerEnd + 4);
  const transferEncoding = headers.get("transfer-encoding") ?? "";
  const encodings = transferEncoding.split(",");
  for (let index = 0; index < encodings.length; index += 1) {
    if (encodings[index]?.trim() === "chunked") {
      body = decodeChunkedBody(body);
      break;
    }
  }

  return {
    body,
    statusCode: Number.parseInt(statusCodeText, 10),
  };
}

function decodeChunkedBody(body: string): string {
  let rest = body;
  let decoded = "";

  while (true) {
    const lineEnd = rest.indexOf("\r\n");
    if (lineEnd < 0) {
      throw new Error("chunked agentd response is missing a chunk header");
    }

    const sizeText = rest.slice(0, lineEnd).split(";", 1)[0];
    if (sizeText === undefined) {
      throw new Error("chunked agentd response has an invalid chunk size");
    }

    const size = Number.parseInt(sizeText, 16);
    if (!Number.isFinite(size) || size < 0) {
      throw new Error("chunked agentd response has an invalid chunk size");
    }
    if (size === 0) {
      return decoded;
    }

    const chunkStart = lineEnd + 2;
    const chunkEnd = chunkStart + size;
    if (rest.length < chunkEnd + 2 || rest.slice(chunkEnd, chunkEnd + 2) !== "\r\n") {
      throw new Error("chunked agentd response has an incomplete chunk");
    }

    decoded += rest.slice(chunkStart, chunkEnd);
    rest = rest.slice(chunkEnd + 2);
  }
}

function compareStrings(left: string, right: string): number {
  if (left < right) {
    return -1;
  }

  if (left > right) {
    return 1;
  }

  return 0;
}
