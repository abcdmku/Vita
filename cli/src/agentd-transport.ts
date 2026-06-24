import { connect } from "node:net";
import type { Socket } from "node:net";

import type {
  AgentTransport,
  AgentTransportInit,
  AgentTransportResponse,
} from "../../controller/agent-client/src/agent-client.ts";
import type {
  ApplyNodeTransport,
} from "../../controller/apply-node/src/apply-node-config.ts";

export interface NodeUnixSocketTransportOptions {
  readonly socketPath?: string;
  readonly host?: string;
  readonly maxResponseBytes?: number;
}

interface HttpResponse {
  readonly statusCode: number;
  readonly body: string;
}

export const DEFAULT_AGENTD_SOCKET_PATH = "/run/vita-agent/agentd.sock";
export const DEFAULT_AGENTD_BASE_URL = "http://agentd";
export const DEFAULT_MAX_RESPONSE_BYTES = 64 * 1024;

const DEFAULT_HOST = "agentd";
const APPLY_JSON_HEADERS = Object.freeze({
  Accept: "application/json",
  "Content-Type": "application/json",
});

export function createAgentdTransport(
  options: NodeUnixSocketTransportOptions = {},
): AgentTransport {
  const socketPath = options.socketPath ?? DEFAULT_AGENTD_SOCKET_PATH;
  const host = options.host ?? DEFAULT_HOST;
  const maxResponseBytes = options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;

  return async (url, init) => {
    if (init.method !== "GET") {
      throw new Error("agentd transport is read-only");
    }

    return requestOverUnixSocket(socketPath, host, maxResponseBytes, url, init);
  };
}

export function createApplyTransport(
  options: NodeUnixSocketTransportOptions = {},
): AgentTransport {
  const socketPath = options.socketPath ?? DEFAULT_AGENTD_SOCKET_PATH;
  const host = options.host ?? DEFAULT_HOST;
  const maxResponseBytes = options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;

  return async (url, init) => {
    if (init.method !== "GET" && !isApplyPost(url, init)) {
      throw new Error("agentd apply transport only allows GET plus POST /apply");
    }

    return requestOverUnixSocket(socketPath, host, maxResponseBytes, url, init);
  };
}

export function createApplyNodeTransport(
  transport: AgentTransport,
  baseUrl: string | URL = DEFAULT_AGENTD_BASE_URL,
): ApplyNodeTransport {
  return async (method, path, body) => {
    const response = await transport(new URL(path, baseUrl).toString(), {
      body: JSON.stringify(body),
      headers: APPLY_JSON_HEADERS,
      method,
    });
    const text = await response.text();

    return {
      body: parseJsonOrText(text),
      status: response.status,
    };
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
  const raw = await requestRaw(socketPath, encodeHttpRequest(host, urlText, init), maxResponseBytes);
  const response = parseHttpResponse(raw);

  return {
    ok: response.statusCode >= 200 && response.statusCode < 300,
    status: response.statusCode,
    text: async () => response.body,
  };
}

function requestRaw(
  socketPath: string,
  request: Buffer,
  maxResponseBytes: number,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let settled = false;
    const socket = connect({ path: socketPath });

    socket.on("connect", () => {
      socket.end(request);
    });

    socket.on("data", (chunk: Buffer) => {
      total += chunk.length;
      if (total > maxResponseBytes) {
        settleReject(socket, reject, new Error("agentd response exceeded size limit"));
        return;
      }

      chunks[chunks.length] = chunk;
    });

    socket.on("error", (error) => {
      settleReject(socket, reject, error);
    });

    socket.on("end", () => {
      if (settled) {
        return;
      }
      settled = true;
      resolve(Buffer.concat(chunks, total));
    });

    socket.on("close", () => {
      if (settled) {
        return;
      }
      settled = true;
      resolve(Buffer.concat(chunks, total));
    });

    function settleReject(
      activeSocket: Socket,
      rejectPromise: (reason?: unknown) => void,
      error: Error,
    ): void {
      if (settled) {
        return;
      }
      settled = true;
      activeSocket.destroy();
      rejectPromise(error);
    }
  });
}

function encodeHttpRequest(host: string, urlText: string, init: AgentTransportInit): Buffer {
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
    lines.push(`Content-Length: ${Buffer.byteLength(body, "utf8")}`);
  }

  return Buffer.from(`${lines.join("\r\n")}\r\n\r\n${body}`, "utf8");
}

function parseHttpResponse(raw: Buffer): HttpResponse {
  const headerEnd = raw.indexOf("\r\n\r\n", 0, "latin1");
  if (headerEnd < 0) {
    throw new Error("agentd response missing HTTP headers");
  }

  const headerText = raw.subarray(0, headerEnd).toString("latin1");
  const headerLines = headerText.split("\r\n");
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

  let body = raw.subarray(headerEnd + 4);
  const transferEncoding = headers.get("transfer-encoding") ?? "";
  const encodings = transferEncoding.split(",");
  for (let index = 0; index < encodings.length; index += 1) {
    if (encodings[index]?.trim() === "chunked") {
      body = decodeChunkedBody(body);
      break;
    }
  }

  return {
    body: body.toString("utf8"),
    statusCode: Number.parseInt(statusCodeText, 10),
  };
}

function decodeChunkedBody(body: Buffer): Buffer {
  const chunks: Buffer[] = [];
  let offset = 0;
  let total = 0;

  while (true) {
    const lineEnd = body.indexOf("\r\n", offset, "latin1");
    if (lineEnd < 0) {
      throw new Error("chunked agentd response is missing a chunk header");
    }

    const sizeText = body.subarray(offset, lineEnd).toString("latin1").split(";", 1)[0];
    if (sizeText === undefined) {
      throw new Error("chunked agentd response has an invalid chunk size");
    }

    const size = Number.parseInt(sizeText, 16);
    if (!Number.isFinite(size) || size < 0) {
      throw new Error("chunked agentd response has an invalid chunk size");
    }

    if (size === 0) {
      return Buffer.concat(chunks, total);
    }

    const chunkStart = lineEnd + 2;
    const chunkEnd = chunkStart + size;
    if (
      body.length < chunkEnd + 2 ||
      body[chunkEnd] !== 13 ||
      body[chunkEnd + 1] !== 10
    ) {
      throw new Error("chunked agentd response has an incomplete chunk");
    }

    const chunk = body.subarray(chunkStart, chunkEnd);
    chunks[chunks.length] = chunk;
    total += chunk.length;
    offset = chunkEnd + 2;
  }
}

function parseJsonOrText(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

function compareStrings(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}
