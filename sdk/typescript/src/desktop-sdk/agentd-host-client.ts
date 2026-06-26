import { safeNormalize } from "../safe-normalize.ts";
import type {
  PlainJson,
  PlainJsonObject,
} from "../safe-normalize.ts";

export interface AgentdHostTransportInit {
  readonly method: "GET" | "POST";
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: string;
}

export interface AgentdHostTransportResponse {
  readonly ok: boolean;
  readonly status: number;
  text(): Promise<string>;
}

export type AgentdHostTransport = (
  url: string,
  init: AgentdHostTransportInit,
) => Promise<AgentdHostTransportResponse>;

export type AgentdHostTimeout = (timeoutMs: number) => Promise<void>;

export interface AgentdHostClientOptions {
  readonly socketPath: string;
  readonly allowedSocketPaths: readonly string[];
  readonly transport: AgentdHostTransport;
  readonly baseUrl?: string | URL;
  readonly maxResponseBytes?: number;
  readonly timeoutMs?: number;
  readonly timeout?: AgentdHostTimeout;
}

export interface AgentdHostClient {
  call(capability: string, request?: PlainJsonObject): Promise<AgentdHostResult>;
}

export type AgentdHostResult<TValue = PlainJsonObject> =
  | {
      readonly ok: true;
      readonly value: TValue;
    }
  | {
      readonly ok: false;
      readonly error: AgentdHostError;
    };

export type AgentdHostClientErrorCode =
  | "agentd_error"
  | "invalid_request"
  | "malformed_response"
  | "peer_closed"
  | "response_too_large"
  | "socket_path_forbidden"
  | "timeout"
  | "transport_failed";

export type AgentdHostErrorCode = AgentdHostClientErrorCode | (string & {});

export interface AgentdHostError {
  readonly code: AgentdHostErrorCode;
  readonly message: string;
  readonly status?: number;
}

interface RequestExchange {
  readonly path: string;
  readonly init: AgentdHostTransportInit;
}

interface AgentdApplyEnvelope {
  readonly operations: readonly AgentdApplyOperation[];
}

interface AgentdApplyOperation {
  readonly capability: string;
  readonly request: PlainJsonObject;
}

const JSON_GET_HEADERS = Object.freeze({
  Accept: "application/json",
});
const JSON_POST_HEADERS = Object.freeze({
  Accept: "application/json",
  "Content-Type": "application/json",
});

export const DEFAULT_AGENTD_HOST_SOCKET_PATH = "/run/vita-agent/agentd.sock";
export const DEFAULT_AGENTD_HOST_BASE_URL = "http://agentd";
export const DEFAULT_AGENTD_HOST_MAX_RESPONSE_BYTES = 64 * 1024;
export const AGENTD_HEALTH_CAPABILITY = "healthz";

export function createAgentdHostClient(options: AgentdHostClientOptions): AgentdHostClient {
  return new ResultAgentdHostClient(options);
}

class ResultAgentdHostClient implements AgentdHostClient {
  readonly #allowedSocketPaths: ReadonlySet<string>;
  readonly #baseUrl: URL;
  readonly #maxResponseBytes: number;
  readonly #socketPath: string;
  readonly #timeout: AgentdHostTimeout | undefined;
  readonly #timeoutMs: number | undefined;
  readonly #transport: AgentdHostTransport;

  constructor(options: AgentdHostClientOptions) {
    this.#allowedSocketPaths = new Set(options.allowedSocketPaths);
    this.#baseUrl = new URL(options.baseUrl ?? DEFAULT_AGENTD_HOST_BASE_URL);
    this.#maxResponseBytes = normalizedMaxResponseBytes(options.maxResponseBytes);
    this.#socketPath = options.socketPath;
    this.#timeout = options.timeout;
    this.#timeoutMs = normalizedTimeoutMs(options.timeoutMs);
    this.#transport = options.transport;
  }

  call(capability: string, request?: PlainJsonObject): Promise<AgentdHostResult> {
    if (!this.#allowedSocketPaths.has(this.#socketPath)) {
      return Promise.resolve(fail(
        "socket_path_forbidden",
        "agentd socket path is not allowed for this host client.",
      ));
    }

    const exchange = this.#buildExchange(capability, request);

    if (!exchange.ok) {
      return Promise.resolve(exchange);
    }

    return this.#request(exchange.value);
  }

  #buildExchange(capability: string, request: PlainJsonObject | undefined): AgentdHostResult<RequestExchange> {
    if (typeof capability !== "string" || capability.length === 0) {
      return fail("invalid_request", "agentd capability is required.");
    }

    if (capability === AGENTD_HEALTH_CAPABILITY) {
      return accept({
        init: {
          headers: JSON_GET_HEADERS,
          method: "GET",
        },
        path: "/healthz",
      });
    }

    if (request === undefined) {
      return accept({
        init: {
          headers: JSON_GET_HEADERS,
          method: "GET",
        },
        path: `/read/${encodeURIComponent(capability)}`,
      });
    }

    const normalized = safeNormalize(request);

    if (!normalized.ok || !isPlainJsonObject(normalized.value)) {
      return fail("invalid_request", "agentd request must be a plain JSON object.");
    }

    const envelope: AgentdApplyEnvelope = Object.freeze({
      operations: Object.freeze([
        Object.freeze({
          capability,
          request: normalized.value,
        }),
      ]),
    });
    const body = stringifyJson(envelope);

    if (!body.ok) {
      return body;
    }

    return accept({
      init: {
        body: body.value,
        headers: JSON_POST_HEADERS,
        method: "POST",
      },
      path: "/apply",
    });
  }

  #request(exchange: RequestExchange): Promise<AgentdHostResult> {
    const response = this.#exchange(exchange);
    const timeoutMs = this.#timeoutMs;
    const timeout = this.#timeout;

    if (timeoutMs === undefined || timeout === undefined) {
      return response;
    }

    return Promise.race([response, waitForTimeout(timeout, timeoutMs)]);
  }

  async #exchange(exchange: RequestExchange): Promise<AgentdHostResult> {
    let response: AgentdHostTransportResponse;

    try {
      response = await this.#transport(
        new URL(exchange.path, this.#baseUrl).toString(),
        exchange.init,
      );
    } catch {
      return fail("transport_failed", "agentd transport failed closed.");
    }

    let text: string;

    try {
      text = await response.text();
    } catch {
      return fail("transport_failed", "agentd response body could not be read.", response.status);
    }

    if (text.length === 0) {
      return fail("peer_closed", "agentd peer closed without a response body.", response.status);
    }

    if (encodedByteLength(text) > this.#maxResponseBytes) {
      return fail("response_too_large", "agentd response exceeded the configured size limit.", response.status);
    }

    const parsed = parseResponseObject(text, response.status);

    if (!parsed.ok) {
      return parsed;
    }

    if (!response.ok || !isSuccessStatus(response.status)) {
      return agentErrorResult(parsed.value, response.status);
    }

    return parsed;
  }
}

function parseResponseObject(text: string, status: number): AgentdHostResult<PlainJsonObject> {
  let parsed: unknown;

  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    return fail("malformed_response", "agentd response body is not valid JSON.", status);
  }

  const normalized = safeNormalize(parsed);

  if (!normalized.ok || !isPlainJsonObject(normalized.value)) {
    return fail("malformed_response", "agentd response body must be a plain JSON object.", status);
  }

  return accept(normalized.value);
}

function agentErrorResult(body: PlainJsonObject, status: number): AgentdHostResult {
  const error = plainObjectField(body, "error");
  const code = stringField(error, "code");
  const message = stringField(error, "message");

  if (code === undefined || !isSanitizedAgentdCode(code)) {
    return fail("agentd_error", "agentd returned a non-success status.", status);
  }

  return fail(code, message ?? "agentd request failed.", status);
}

function stringifyJson(value: AgentdApplyEnvelope): AgentdHostResult<string> {
  try {
    return accept(JSON.stringify(value));
  } catch {
    return fail("invalid_request", "agentd request could not be serialized.");
  }
}

function plainObjectField(value: PlainJsonObject, key: string): PlainJsonObject | undefined {
  const field = value[key];

  return isPlainJsonObject(field) ? field : undefined;
}

function stringField(value: PlainJsonObject | undefined, key: string): string | undefined {
  if (value === undefined) return undefined;

  const field = value[key];

  return typeof field === "string" ? field : undefined;
}

function isPlainJsonObject(value: PlainJson | undefined): value is PlainJsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isSuccessStatus(status: number): boolean {
  return Number.isInteger(status) && status >= 200 && status < 300;
}

function isSanitizedAgentdCode(value: string): boolean {
  return /^[a-z][a-z0-9_]*$/u.test(value);
}

function normalizedMaxResponseBytes(value: number | undefined): number {
  if (value === undefined || !Number.isSafeInteger(value) || value <= 0) {
    return DEFAULT_AGENTD_HOST_MAX_RESPONSE_BYTES;
  }

  return value;
}

function normalizedTimeoutMs(value: number | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || value <= 0) return undefined;

  return value;
}

function waitForTimeout(timeout: AgentdHostTimeout, timeoutMs: number): Promise<AgentdHostResult> {
  try {
    return timeout(timeoutMs).then(
      () => fail("timeout", "agentd request timed out."),
      () => fail("timeout", "agentd request timed out."),
    );
  } catch {
    return Promise.resolve(fail("timeout", "agentd request timed out."));
  }
}

function encodedByteLength(value: string): number {
  return new TextEncoder().encode(value).length;
}

function accept<TValue>(value: TValue): Extract<AgentdHostResult<TValue>, { readonly ok: true }> {
  return {
    ok: true,
    value,
  };
}

function fail(code: AgentdHostErrorCode, message: string, status?: number): Extract<AgentdHostResult, { readonly ok: false }> {
  const error: {
    code: AgentdHostErrorCode;
    message: string;
    status?: number;
  } = {
    code,
    message,
  };

  if (status !== undefined && Number.isInteger(status)) {
    error.status = status;
  }

  return {
    error: Object.freeze(error),
    ok: false,
  };
}
