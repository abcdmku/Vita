import assert from "node:assert/strict";
import { test } from "node:test";

import {
  AgentClientError,
  createAgentClient,
  isAgentClientError,
  serializeApplyPlan,
} from "../src/agent-client.ts";
import type {
  AgentApplyPlan,
  AgentClientErrorCode,
  AgentTransport,
  AgentTransportInit,
  AgentTransportResponse,
} from "../src/agent-client.ts";

test("getHealth calls GET /healthz and parses the agent status response", async () => {
  const calls: RecordedCall[] = [];
  const transport = mockTransport(
    200,
    JSON.stringify({
      version: "test-version",
      startedAt: "2026-06-20T12:00:00Z",
      uptimeSeconds: 90,
      capabilities: ["test.apply"],
      healthy: true,
    }),
    calls,
  );
  const client = createAgentClient({
    baseUrl: "http://127.0.0.1:8786",
    transport,
  });

  const health = await client.getHealth();

  assert.deepEqual(health, {
    version: "test-version",
    startedAt: "2026-06-20T12:00:00Z",
    uptimeSeconds: 90,
    capabilities: ["test.apply"],
    healthy: true,
  });

  const call = onlyCall(calls);
  assert.equal(call.url, "http://127.0.0.1:8786/healthz");
  assert.equal(call.init.method, "GET");
  assert.equal(Object.hasOwn(call.init, "body"), false);
});

test("getCapabilities calls GET /capabilities and parses hardware capabilities", async () => {
  const calls: RecordedCall[] = [];
  const response = {
    cpu: {
      arch: "x86_64",
      cores: 8,
      model: "fixture cpu",
    },
    memory: {
      totalMiB: 16_384,
    },
    storage: [
      {
        name: "nvme0n1",
        sizeMiB: 512_000,
        rotational: false,
        nvme: true,
      },
    ],
    networking: {
      interfaces: [
        {
          name: "lo",
          kind: "loopback",
        },
      ],
    },
    tpm: {
      present: true,
      version: "2.0",
    },
    virtualization: {
      hardware: true,
    },
    accelerators: [
      {
        kind: "cpu",
        architecture: "x86_64",
      },
    ],
    detectedDevices: [
      {
        class: "pci",
        vendorID: "8086",
        deviceID: "1234",
      },
    ],
  };
  const client = createAgentClient({
    baseUrl: "http://127.0.0.1:8786",
    transport: mockTransport(200, JSON.stringify(response), calls),
  });

  const capabilities = await client.getCapabilities();

  assert.deepEqual(capabilities, response);

  const call = onlyCall(calls);
  assert.equal(call.url, "http://127.0.0.1:8786/capabilities");
  assert.equal(call.init.method, "GET");
});

test("apply posts the exact agent wire shape and parses a committed result", async () => {
  const calls: RecordedCall[] = [];
  const plan: AgentApplyPlan = {
    operations: [
      {
        capability: "test.apply",
        request: {
          value: "one",
        },
      },
    ],
  };
  const committed = {
    outcome: "committed",
    applied: [
      {
        index: 0,
        capability: "test.apply",
      },
    ],
    rolledBack: [],
    rollbackErrors: [],
  };
  const client = createAgentClient({
    baseUrl: "http://127.0.0.1:8786",
    transport: mockTransport(200, JSON.stringify(committed), calls),
  });

  const result = await client.apply(plan);

  assert.deepEqual(result, committed);
  assert.equal(
    serializeApplyPlan(plan),
    `{"operations":[{"capability":"test.apply","request":{"value":"one"}}]}`,
  );

  const call = onlyCall(calls);
  assert.equal(call.url, "http://127.0.0.1:8786/apply");
  assert.equal(call.init.method, "POST");
  assert.equal(
    call.init.body,
    `{"operations":[{"capability":"test.apply","request":{"value":"one"}}]}`,
  );
  assert.equal(call.init.headers?.["Content-Type"], "application/json");
});

test("apply parses a rolled-back result with the typed result error", async () => {
  const calls: RecordedCall[] = [];
  const rolledBack = {
    outcome: "rolledBack",
    applied: [
      {
        index: 0,
        capability: "test.first",
      },
    ],
    rolledBack: [
      {
        index: 0,
        capability: "test.first",
      },
    ],
    error: {
      code: "apply_failed",
      message: `apply operation 1 capability "test.second": mock apply failed`,
      index: 1,
      capability: "test.second",
    },
    rollbackErrors: [],
  };
  const client = createAgentClient({
    transport: mockTransport(200, JSON.stringify(rolledBack), calls),
  });

  const result = await client.apply({
    operations: [
      {
        capability: "test.first",
        request: {
          value: "one",
        },
      },
      {
        capability: "test.second",
        request: {
          value: "two",
        },
      },
    ],
  });

  assert.deepEqual(result, rolledBack);
});

test("malformed, garbage, and partial agent responses fail closed with typed client errors", async () => {
  await assertAgentClientError(
    createAgentClient({
      transport: mockTransport(200, "not-json"),
    }).getHealth(),
    "MALFORMED_RESPONSE",
  );

  await assertAgentClientError(
    createAgentClient({
      transport: mockTransport(200, JSON.stringify("not an object")),
    }).getHealth(),
    "MALFORMED_RESPONSE",
  );

  await assertAgentClientError(
    createAgentClient({
      transport: mockTransport(
        200,
        JSON.stringify({
          version: "test-version",
        }),
      ),
    }).getHealth(),
    "MALFORMED_RESPONSE",
  );
});

test("non-2xx agent errors map to typed client errors", async () => {
  const client = createAgentClient({
    transport: mockTransport(
      400,
      JSON.stringify({
        error: {
          code: "invalid_plan",
          message: "operations is required",
        },
      }),
    ),
  });

  const error = await assertAgentClientError(client.getHealth(), "AGENT_ERROR", 400);

  assert.deepEqual(error.agentError, {
    code: "invalid_plan",
    message: "operations is required",
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
