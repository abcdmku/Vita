import assert from "node:assert/strict";
import { test } from "node:test";

import {
  AGENTD_HEALTH_CAPABILITY,
  DEFAULT_AGENTD_HOST_SOCKET_PATH,
  createAgentdHostClient,
} from "../../src/desktop-sdk/index.ts";
import type {
  AgentdHostClient,
  AgentdHostClientErrorCode,
  AgentdHostErrorCode,
  AgentdHostTimeout,
  AgentdHostTransport,
  AgentdHostTransportInit,
  AgentdHostTransportResponse,
} from "../../src/desktop-sdk/index.ts";
import type {
  PlainJson,
  PlainJsonObject,
} from "../../src/safe-normalize.ts";

test("agentd host client maps health calls to GET /healthz and returns JSON values", async () => {
  const health = Object.freeze({
    capabilities: Object.freeze(["nodeconfig"]),
    healthy: true,
    startedAt: "2026-06-25T00:00:00Z",
    uptimeSeconds: 42,
    version: "test",
  });
  const stub = createStubTransport(() => jsonResponse(200, health));
  const client = createTestClient(stub.transport);

  const result = await client.call(AGENTD_HEALTH_CAPABILITY, Object.freeze({}));
  const value = assertSuccess(result);

  assert.deepEqual(value, health);
  assert.equal(stub.calls.length, 1);
  assert.equal(stub.calls[0]?.url, "http://agentd/healthz");
  assert.equal(stub.calls[0]?.init.method, "GET");
  assert.deepEqual(stub.calls[0]?.init.headers, {
    Accept: "application/json",
  });
  assert.equal(stub.calls[0]?.init.body, undefined);
});

test("agentd host client maps absent request to GET /read/<capability>", async () => {
  const state = Object.freeze({
    hostname: "vita-test",
  });
  const stub = createStubTransport(() => jsonResponse(200, state));
  const client = createTestClient(stub.transport);

  const result = await client.call("nodeconfig");
  const value = assertSuccess(result);

  assert.deepEqual(value, state);
  assert.equal(stub.calls.length, 1);
  assert.equal(stub.calls[0]?.url, "http://agentd/read/nodeconfig");
  assert.equal(stub.calls[0]?.init.method, "GET");
  assert.equal(stub.calls[0]?.init.body, undefined);
});

test("agentd host client rejects forbidden socket paths before transport", async () => {
  let invoked = 0;
  const transport: AgentdHostTransport = async () => {
    invoked += 1;
    return jsonResponse(200, Object.freeze({ ok: true }));
  };
  const client = createAgentdHostClient({
    allowedSocketPaths: Object.freeze([DEFAULT_AGENTD_HOST_SOCKET_PATH]),
    socketPath: "/tmp/not-agentd.sock",
    transport,
  });

  const result = await client.call("nodeconfig", Object.freeze({
    desired: Object.freeze({}),
  }));

  assertFailure(result, "socket_path_forbidden");
  assert.equal(invoked, 0);
});

test("agentd host client rejects malformed apply requests before transport", async () => {
  const cyclic: MutablePlainJsonObject = {};
  let invoked = 0;
  const transport: AgentdHostTransport = async () => {
    invoked += 1;
    return jsonResponse(200, Object.freeze({ ok: true }));
  };
  const client = createTestClient(transport);

  cyclic["self"] = cyclic;

  const result = await client.call("nodeconfig", cyclic);

  assertFailure(result, "invalid_request");
  assert.equal(invoked, 0);
});

test("agentd host client fails closed with stable sanitized codes", async () => {
  const cases: readonly FailClosedCase[] = Object.freeze([
    Object.freeze({
      expectedCode: "transport_failed",
      name: "transport throw",
      transport: async () => {
        throw new Error("connect ECONNREFUSED /run/vita-agent/agentd.sock");
      },
    }),
    Object.freeze({
      expectedCode: "malformed_response",
      name: "malformed body",
      transport: async () => textResponse(200, "not-json"),
    }),
    Object.freeze({
      expectedCode: "unknown_capability",
      name: "non-2xx agentd error",
      transport: async () => jsonResponse(404, Object.freeze({
        error: Object.freeze({
          code: "unknown_capability",
          message: "unknown capability",
        }),
      })),
    }),
    Object.freeze({
      expectedCode: "timeout",
      name: "timeout",
      timeout: async () => {},
      timeoutMs: 1,
      transport: async () => new Promise<AgentdHostTransportResponse>(() => {}),
    }),
    Object.freeze({
      expectedCode: "peer_closed",
      name: "peer-closed empty response",
      transport: async () => textResponse(200, ""),
    }),
    Object.freeze({
      expectedCode: "response_too_large",
      maxResponseBytes: 8,
      name: "oversize response",
      transport: async () => jsonResponse(200, Object.freeze({
        value: "larger than limit",
      })),
    }),
  ]);

  for (let index = 0; index < cases.length; index += 1) {
    const current = cases[index];

    assert.notEqual(current, undefined);
    if (current === undefined) continue;

    const client = createTestClient(current.transport, current);
    const result = await client.call("nodeconfig");

    assertFailure(result, current.expectedCode, current.name);
  }
});

test("agentd host client emits POST /apply operations envelope for apply calls", async () => {
  const applyResult = Object.freeze({
    applied: Object.freeze([
      Object.freeze({
        capability: "nodeconfig",
        index: 0,
      }),
    ]),
    outcome: "committed",
    rollbackErrors: Object.freeze([]),
    rolledBack: Object.freeze([]),
  });
  const request = Object.freeze({
    desired: Object.freeze({
      hostname: "vita-test",
    }),
  });
  const stub = createStubTransport(() => jsonResponse(200, applyResult));
  const client = createTestClient(stub.transport);

  const result = await client.call("nodeconfig", request);
  const value = assertSuccess(result);

  assert.deepEqual(value, applyResult);
  assert.equal(stub.calls.length, 1);

  const call = stub.calls[0];

  assert.notEqual(call, undefined);
  if (call === undefined) assert.fail("transport should have been invoked");
  assert.equal(call.url, "http://agentd/apply");
  assert.equal(call.init.method, "POST");
  assert.deepEqual(call.init.headers, {
    Accept: "application/json",
    "Content-Type": "application/json",
  });
  assert.deepEqual(parseBody(call.init), {
    operations: [
      {
        capability: "nodeconfig",
        request: {
          desired: {
            hostname: "vita-test",
          },
        },
      },
    ],
  });
});

interface TransportCall {
  readonly url: string;
  readonly init: AgentdHostTransportInit;
}

interface StubTransport {
  readonly calls: readonly TransportCall[];
  readonly transport: AgentdHostTransport;
}

interface TestClientOptions {
  readonly maxResponseBytes?: number;
  readonly timeout?: AgentdHostTimeout;
  readonly timeoutMs?: number;
}

interface FailClosedCase extends TestClientOptions {
  readonly expectedCode: AgentdHostErrorCode;
  readonly name: string;
  readonly transport: AgentdHostTransport;
}

interface MutablePlainJsonObject {
  [key: string]: PlainJson;
}

function createTestClient(
  transport: AgentdHostTransport,
  options: TestClientOptions = Object.freeze({}),
): AgentdHostClient {
  return createAgentdHostClient({
    allowedSocketPaths: Object.freeze([DEFAULT_AGENTD_HOST_SOCKET_PATH]),
    socketPath: DEFAULT_AGENTD_HOST_SOCKET_PATH,
    transport,
    ...(options.maxResponseBytes === undefined ? {} : { maxResponseBytes: options.maxResponseBytes }),
    ...(options.timeout === undefined ? {} : { timeout: options.timeout }),
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
  });
}

function createStubTransport(
  handler: (url: string, init: AgentdHostTransportInit) => AgentdHostTransportResponse | Promise<AgentdHostTransportResponse>,
): StubTransport {
  const calls: TransportCall[] = [];
  const transport: AgentdHostTransport = async (url, init) => {
    calls.push(Object.freeze({
      init,
      url,
    }));

    return handler(url, init);
  };

  return Object.freeze({
    calls,
    transport,
  });
}

function jsonResponse(status: number, body: PlainJsonObject): AgentdHostTransportResponse {
  return textResponse(status, JSON.stringify(body));
}

function textResponse(status: number, body: string): AgentdHostTransportResponse {
  return Object.freeze({
    ok: status >= 200 && status < 300,
    status,
    text: async () => body,
  });
}

function parseBody(init: AgentdHostTransportInit): unknown {
  const body = init.body;

  assert.equal(typeof body, "string");
  if (typeof body !== "string") assert.fail("request body should be JSON text");

  return JSON.parse(body);
}

function assertSuccess(result: Awaited<ReturnType<AgentdHostClient["call"]>>): PlainJsonObject {
  if (!result.ok) assert.fail(result.error.message);

  return result.value;
}

function assertFailure(
  result: Awaited<ReturnType<AgentdHostClient["call"]>>,
  code: AgentdHostClientErrorCode | AgentdHostErrorCode,
  message?: string,
): void {
  const assertionMessage = message ?? code;

  if (result.ok) assert.fail("agentd call should have failed closed");
  assert.equal(result.error.code, code, assertionMessage);
}
