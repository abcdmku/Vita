import assert from "node:assert/strict";
import { test } from "node:test";

import {
  AgentClientError,
  createAgentClient,
  isAgentClientError,
} from "../../agent-client/src/agent-client.ts";
import type {
  AgentApplyPlan,
  AgentClientErrorCode,
  AgentTransport,
  AgentTransportInit,
  AgentTransportResponse,
} from "../../agent-client/src/agent-client.ts";
import { previewPlan } from "../src/plan-preview.ts";
import type { OperationDiscoveryClient } from "../src/plan-preview.ts";

test("getOperations calls GET /operations and parses the agent operation list", async () => {
  const calls: RecordedCall[] = [];
  const client = createAgentClient({
    baseUrl: "http://127.0.0.1:8786",
    transport: mockTransport(
      200,
      JSON.stringify({
        operations: ["hostname.set", "nodeconfig.apply"],
      }),
      calls,
    ),
  });

  const operations = await client.getOperations();

  assert.deepEqual(operations, ["hostname.set", "nodeconfig.apply"]);

  const call = onlyCall(calls);
  assert.equal(call.url, "http://127.0.0.1:8786/operations");
  assert.equal(call.init.method, "GET");
  assert.equal(Object.hasOwn(call.init, "body"), false);
});

test("malformed and garbage operations responses fail closed with typed client errors", async () => {
  await assertAgentClientError(
    createAgentClient({
      transport: mockTransport(200, "not-json"),
    }).getOperations(),
    "MALFORMED_RESPONSE",
  );

  await assertAgentClientError(
    createAgentClient({
      transport: mockTransport(
        200,
        JSON.stringify({
          operations: ["hostname.set", 7],
        }),
      ),
    }).getOperations(),
    "MALFORMED_RESPONSE",
  );

  await assertAgentClientError(
    createAgentClient({
      transport: mockTransport(
        200,
        JSON.stringify({
          extra: "field",
          operations: ["hostname.set"],
        }),
      ),
    }).getOperations(),
    "MALFORMED_RESPONSE",
  );
});

test("previewPlan returns a valid preview when all operations were discovered", async () => {
  const plan: AgentApplyPlan = {
    operations: [
      {
        capability: "hostname.set",
        request: {
          hostname: "vita-node",
        },
      },
      {
        capability: "nodeconfig.apply",
        request: {
          profile: "default",
        },
      },
    ],
  };

  const preview = await previewPlan(
    operationClient(["hostname.set", "nodeconfig.apply"]),
    plan,
  );

  assert.equal(preview.ok, true);

  if (!preview.ok) {
    assert.fail("expected valid preview");
  }

  assert.deepEqual(preview.operations, [
    {
      capability: "hostname.set",
      index: 0,
      known: true,
    },
    {
      capability: "nodeconfig.apply",
      index: 1,
      known: true,
    },
  ]);
  assert.deepEqual(preview.rejections, []);
});

test("previewPlan rejects unknown operations before submit without throwing", async () => {
  const plan: AgentApplyPlan = {
    operations: [
      {
        capability: "hostname.set",
        request: {
          hostname: "vita-node",
        },
      },
      {
        capability: "unknown.apply",
        request: {
          value: "blocked",
        },
      },
    ],
  };

  const preview = await previewPlan(operationClient(["hostname.set"]), plan);

  assert.equal(preview.ok, false);

  if (preview.ok) {
    assert.fail("expected rejected preview");
  }

  assert.equal(preview.error.code, "UNKNOWN_OPERATION");
  assert.deepEqual(preview.operations, [
    {
      capability: "hostname.set",
      index: 0,
      known: true,
    },
    {
      capability: "unknown.apply",
      index: 1,
      known: false,
    },
  ]);
  assert.deepEqual(preview.rejections, [
    {
      capability: "unknown.apply",
      code: "UNKNOWN_OPERATION",
      index: 1,
      message: `operation 1 names unknown capability "unknown.apply"`,
    },
  ]);
});

test("previewPlan converts operation discovery client errors into typed preview errors", async () => {
  const plan: AgentApplyPlan = {
    operations: [
      {
        capability: "hostname.set",
        request: {
          hostname: "vita-node",
        },
      },
    ],
  };

  const preview = await previewPlan(
    rejectingOperationClient(
      new AgentClientError("TRANSPORT_ERROR", "Agent transport request failed."),
    ),
    plan,
  );

  assert.equal(preview.ok, false);

  if (preview.ok) {
    assert.fail("expected preview error");
  }

  assert.equal(preview.error.code, "OPERATION_DISCOVERY_FAILED");
  assert.equal(preview.error.clientCode, "TRANSPORT_ERROR");
  assert.deepEqual(preview.operations, []);
  assert.deepEqual(preview.rejections, []);
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

function operationClient(operations: readonly string[]): OperationDiscoveryClient {
  return {
    async getOperations(): Promise<readonly string[]> {
      return operations;
    },
  };
}

function rejectingOperationClient(error: unknown): OperationDiscoveryClient {
  return {
    async getOperations(): Promise<readonly string[]> {
      throw error;
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
): Promise<void> {
  try {
    await promise;
  } catch (error) {
    assert.equal(isAgentClientError(error), true);

    if (!isAgentClientError(error)) {
      assert.fail("expected an AgentClientError");
    }

    assert.equal(error.code, code);
    return;
  }

  assert.fail("expected promise to reject");
}
