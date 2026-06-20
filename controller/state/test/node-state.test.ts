import assert from "node:assert/strict";
import { test } from "node:test";

import {
  AgentClientError,
  createAgentClient,
  isAgentClientError,
} from "../../agent-client/src/agent-client.ts";
import type {
  AgentCapabilityState,
  AgentClientErrorCode,
  AgentTransport,
  AgentTransportInit,
  AgentTransportResponse,
} from "../../agent-client/src/agent-client.ts";
import { buildNodeState } from "../src/node-state.ts";
import type { NodeStateClient } from "../src/node-state.ts";

test("getState calls GET /read/{capability} and parses a capability state object", async () => {
  const calls: RecordedCall[] = [];
  const state = {
    exists: true,
    config: {
      mode: "normal",
      remoteAccess: "disabled",
    },
    raw: "bW9kZT1ub3JtYWwK",
  };
  const client = createAgentClient({
    baseUrl: "http://127.0.0.1:8786",
    transport: mockTransport(200, JSON.stringify(state), calls),
  });

  const result = await client.getState("node.config");

  assert.deepEqual(result, state);

  const call = onlyCall(calls);
  assert.equal(call.url, "http://127.0.0.1:8786/read/node.config");
  assert.equal(call.init.method, "GET");
  assert.equal(Object.hasOwn(call.init, "body"), false);
});

test("getState rejects garbage and malformed state responses with typed client errors", async () => {
  await assertAgentClientError(
    createAgentClient({
      transport: mockTransport(200, "not-json"),
    }).getState("node.config"),
    "MALFORMED_RESPONSE",
  );

  await assertAgentClientError(
    createAgentClient({
      transport: mockTransport(200, JSON.stringify(["not", "an", "object"])),
    }).getState("node.config"),
    "MALFORMED_RESPONSE",
  );
});

test("buildNodeState returns ok state entries and typed per-capability errors", async () => {
  const client = mockStateClient({
    "node.config": {
      ok: true,
      state: {
        exists: true,
        config: {
          mode: "maintenance",
          remoteAccess: "enabled",
        },
        raw: "mode=maintenance\nremote_access=enabled\n",
      },
    },
    "network.policy": {
      ok: false,
      error: new AgentClientError("AGENT_ERROR", "agent rejected read", {
        agentError: {
          code: "capability_read_failed",
          message: "network policy unavailable",
        },
        status: 500,
      }),
    },
    "storage.layout": {
      ok: true,
      state: {
        exists: false,
      },
    },
  });

  const result = await buildNodeState(client, [
    "node.config",
    "network.policy",
    "storage.layout",
  ]);

  assert.deepEqual(result.states["node.config"], {
    ok: true,
    state: {
      exists: true,
      config: {
        mode: "maintenance",
        remoteAccess: "enabled",
      },
      raw: "mode=maintenance\nremote_access=enabled\n",
    },
  });
  assert.deepEqual(result.states["storage.layout"], {
    ok: true,
    state: {
      exists: false,
    },
  });
  assert.deepEqual(result.states["network.policy"], {
    ok: false,
    error: {
      agentCode: "capability_read_failed",
      clientCode: "AGENT_ERROR",
      code: "STATE_READ_FAILED",
      message: 'Capability "network.policy" state read failed: agent rejected read',
      status: 500,
    },
  });
  assert.deepEqual(Object.keys(result.states), [
    "node.config",
    "network.policy",
    "storage.layout",
  ]);
});

test("buildNodeState records malformed injected-client state as a typed error entry", async () => {
  const client: NodeStateClient = {
    async getState(): Promise<unknown> {
      return ["not", "a", "state"];
    },
  };

  const result = await buildNodeState(client, ["node.config"]);

  assert.equal(result.states["node.config"]?.ok, false);
  assert.deepEqual(result.states["node.config"], {
    ok: false,
    error: {
      code: "MALFORMED_STATE",
      message: 'Capability "node.config" returned malformed state: state must be an object.',
    },
  });
});

test("buildNodeState records a throwing client as a typed error entry", async () => {
  const client: NodeStateClient = {
    async getState(): Promise<unknown> {
      throw new Error("transport unavailable");
    },
  };

  const result = await buildNodeState(client, ["backup.policy"]);

  assert.deepEqual(result.states["backup.policy"], {
    ok: false,
    error: {
      code: "STATE_READ_FAILED",
      message: 'Capability "backup.policy" state read failed: transport unavailable',
    },
  });
});

interface RecordedCall {
  readonly url: string;
  readonly init: AgentTransportInit;
}

class MockResponse implements AgentTransportResponse {
  readonly status: number;
  readonly #body: string;

  constructor(status: number, body: string) {
    this.status = status;
    this.#body = body;
  }

  get ok(): boolean {
    return this.status >= 200 && this.status < 300;
  }

  async text(): Promise<string> {
    return this.#body;
  }
}

type MockStateResult =
  | {
      readonly ok: true;
      readonly state: AgentCapabilityState;
    }
  | {
      readonly ok: false;
      readonly error: unknown;
    };

function mockTransport(
  status: number,
  body: string,
  calls: RecordedCall[] = [],
): AgentTransport {
  return async (url, init) => {
    calls[calls.length] = { init, url };

    return new MockResponse(status, body);
  };
}

function mockStateClient(
  results: Readonly<Record<string, MockStateResult>>,
): NodeStateClient {
  return {
    async getState(capability): Promise<AgentCapabilityState> {
      const result = results[capability];

      if (result === undefined) {
        throw new AgentClientError("AGENT_ERROR", "unexpected capability", {
          agentError: {
            code: "unknown_capability",
            message: "unknown capability",
          },
          status: 404,
        });
      }
      if (!result.ok) {
        throw result.error;
      }

      return result.state;
    },
  };
}

function onlyCall(calls: readonly RecordedCall[]): RecordedCall {
  assert.equal(calls.length, 1);

  const call = calls[0];

  if (call === undefined) {
    assert.fail("expected one transport call");
  }

  return call;
}

async function assertAgentClientError(
  promise: Promise<unknown>,
  code: AgentClientErrorCode,
  status?: number,
): Promise<AgentClientError> {
  try {
    await promise;
  } catch (error) {
    assert.equal(isAgentClientError(error), true);

    if (!isAgentClientError(error)) {
      assert.fail("expected an AgentClientError");
    }

    assert.equal(error.code, code);

    if (status !== undefined) {
      assert.equal(error.status, status);
    }

    return error;
  }

  assert.fail("expected promise to reject");
}
