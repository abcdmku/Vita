import assert from "node:assert/strict";
import { test } from "node:test";

import { AgentClientError } from "../../agent-client/src/agent-client.ts";
import type {
  AgentApplyPlan,
  AgentApplyResult,
} from "../../agent-client/src/agent-client.ts";
import { applyConfig } from "../src/apply-flow.ts";
import type { ApplyFlowClient } from "../src/apply-flow.ts";

test("applyConfig previews known operations, submits, and surfaces a committed result", async () => {
  const plan = applyPlan("hostname.set");
  const applied = committedResult("hostname.set");
  const calls: AgentApplyPlan[] = [];
  const client = mockClient(["hostname.set"], applied, calls);

  const result = await applyConfig(client, plan);

  assert.deepEqual(result, {
    applied,
    previewed: true,
  });
  assert.deepEqual(calls, [plan]);
});

test("applyConfig rejects an unknown operation without submitting", async () => {
  const calls: AgentApplyPlan[] = [];
  const result = await applyConfig(
    mockClient(["hostname.set"], committedResult("hostname.set"), calls),
    applyPlan("unknown.apply"),
  );

  assert.equal(result.previewed, false);
  assert.deepEqual(calls, []);

  if (result.previewed) {
    assert.fail("expected preview rejection");
  }

  assert.deepEqual(result.rejections, [
    {
      capability: "unknown.apply",
      code: "UNKNOWN_OPERATION",
      index: 0,
      message: `operation 0 names unknown capability "unknown.apply"`,
    },
  ]);
  assert.equal(Object.hasOwn(result, "error"), false);
});

test("applyConfig converts preview client errors into typed flow errors without submitting", async () => {
  const calls: AgentApplyPlan[] = [];
  const result = await applyConfig(
    {
      async getOperations(): Promise<readonly string[]> {
        throw new AgentClientError("TRANSPORT_ERROR", "operation discovery failed", {
          status: 503,
        });
      },
      async apply(plan: AgentApplyPlan): Promise<AgentApplyResult> {
        calls[calls.length] = plan;
        return committedResult("hostname.set");
      },
    },
    applyPlan("hostname.set"),
  );

  assert.equal(result.previewed, false);
  assert.deepEqual(calls, []);

  if (result.previewed) {
    assert.fail("expected preview failure");
  }

  assert.deepEqual(result.rejections, []);
  assert.deepEqual(result.error, {
    clientCode: "TRANSPORT_ERROR",
    code: "OPERATION_DISCOVERY_FAILED",
    message: "Operation discovery failed.",
    stage: "preview",
    status: 503,
  });
});

test("applyConfig converts apply client errors into typed flow errors without throwing", async () => {
  const result = await applyConfig(
    {
      async getOperations(): Promise<readonly string[]> {
        return ["hostname.set"];
      },
      async apply(): Promise<AgentApplyResult> {
        throw new AgentClientError("AGENT_ERROR", "agent rejected apply", {
          status: 409,
        });
      },
    },
    applyPlan("hostname.set"),
  );

  assert.deepEqual(result, {
    error: {
      clientCode: "AGENT_ERROR",
      code: "APPLY_FAILED",
      message: "agent rejected apply",
      stage: "apply",
      status: 409,
    },
    previewed: true,
  });
});

test("applyConfig converts hostile apply errors into typed flow errors without throwing", async () => {
  const hostile = new Error("unused");
  Object.defineProperty(hostile, "message", {
    configurable: true,
    enumerable: false,
    get(): string {
      throw new Error("message accessor failed");
    },
  });

  const result = await applyConfig(
    {
      async getOperations(): Promise<readonly string[]> {
        return ["hostname.set"];
      },
      async apply(): Promise<AgentApplyResult> {
        throw hostile;
      },
    },
    applyPlan("hostname.set"),
  );

  assert.deepEqual(result, {
    error: {
      code: "APPLY_FAILED",
      message: "Apply failed.",
      stage: "apply",
    },
    previewed: true,
  });
});

test("applyConfig surfaces rolled-back agent results as typed applied results", async () => {
  const rolledBack: AgentApplyResult = {
    applied: [
      {
        capability: "hostname.set",
        index: 0,
      },
    ],
    error: {
      capability: "nodeconfig.apply",
      code: "apply_failed",
      index: 1,
      message: "nodeconfig apply failed",
    },
    outcome: "rolledBack",
    rollbackErrors: [],
    rolledBack: [
      {
        capability: "hostname.set",
        index: 0,
      },
    ],
  };

  const result = await applyConfig(
    mockClient(["hostname.set", "nodeconfig.apply"], rolledBack),
    {
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
    },
  );

  assert.deepEqual(result, {
    applied: rolledBack,
    previewed: true,
  });
});

test("applyConfig submits the same plan snapshot that it previewed", async () => {
  const mutablePlan: {
    operations: {
      capability: string;
      request: {
        hostname: string;
      };
    }[];
  } = {
    operations: [
      {
        capability: "hostname.set",
        request: {
          hostname: "before-preview",
        },
      },
    ],
  };
  const calls: AgentApplyPlan[] = [];
  const client: ApplyFlowClient = {
    async getOperations(): Promise<readonly string[]> {
      mutablePlan.operations[0] = {
        capability: "unknown.apply",
        request: {
          hostname: "after-preview",
        },
      };

      return ["hostname.set"];
    },
    async apply(plan: AgentApplyPlan): Promise<AgentApplyResult> {
      calls[calls.length] = plan;
      return committedResult("hostname.set");
    },
  };

  const result = await applyConfig(client, mutablePlan);

  assert.equal(result.previewed, true);
  assert.deepEqual(calls, [
    {
      operations: [
        {
          capability: "hostname.set",
          request: {
            hostname: "before-preview",
          },
        },
      ],
    },
  ]);
});

function mockClient(
  operations: readonly string[],
  result: AgentApplyResult,
  calls: AgentApplyPlan[] = [],
): ApplyFlowClient {
  return {
    async getOperations(): Promise<readonly string[]> {
      return operations;
    },
    async apply(plan: AgentApplyPlan): Promise<AgentApplyResult> {
      calls[calls.length] = plan;

      return result;
    },
  };
}

function applyPlan(capability: string): AgentApplyPlan {
  return {
    operations: [
      {
        capability,
        request: {
          hostname: "vita-node",
        },
      },
    ],
  };
}

function committedResult(capability: string): AgentApplyResult {
  return {
    applied: [
      {
        capability,
        index: 0,
      },
    ],
    outcome: "committed",
    rollbackErrors: [],
    rolledBack: [],
  };
}
