import assert from "node:assert/strict";
import { test } from "node:test";

import {
  handleControllerShellRequest as handleSharedControllerShellRequest,
} from "../../../sdk/typescript/src/controller-shell.ts";
import {
  createControllerShellHandler,
  handleControllerShellRequest,
} from "../src/controller-shell.ts";
import type {
  ControllerShellPorts,
  ControllerShellResponse,
} from "../src/controller-shell.ts";
import type { AgentCapabilityState, AgentHealth } from "../../agent-client/src/agent-client.ts";
import type { ApplyNodeTransport } from "../../apply-node/src/apply-node-config.ts";
import type { TransactionPlan } from "../../../runtime/evaluator/src/evaluate.ts";
import type { PlainJsonObject } from "../../../sdk/typescript/src/safe-normalize.ts";

test("controller shell wrapper is behavior-equivalent to shared core on the same ports", async () => {
  const ports = parityPorts();
  const request = {
    body: {
      "hostname.set": {
        desired: "vita-node-7",
      },
    },
    method: "POST",
    path: "/api/apply",
  };

  const shared = await handleSharedControllerShellRequest(ports, request);
  const wrapped = await handleControllerShellRequest(ports, request);

  assert.deepEqual(wrapped, shared);
});

test("controller shell handler wires a real evaluator, diff, and apply transport", async () => {
  const calls: TransactionPlan[] = [];
  const handler = createControllerShellHandler({
    apply: fakeApply(calls),
    client: {
      async getHealth(): Promise<AgentHealth> {
        return health();
      },
      async getOperations(): Promise<readonly string[]> {
        return ["hostname.set"];
      },
      async getState(): Promise<AgentCapabilityState> {
        return {
          current: "vita-node-7",
        };
      },
      async getNodeState(): Promise<unknown> {
        return {
          capabilities: {
            "hostname.set": {
              current: "vita-node-7",
            },
          },
          capsuleWorkloads: [],
        };
      },
    },
  });

  const status = parseJsonObject(await handler({
    method: "GET",
    path: "/api/status",
  }));
  assert.equal(status["hostname"], "vita-node-7");
  assert.equal(status["caps"], 1);

  const preview = parseJsonObject(await handler({
    body: {
      "hostname.set": {
        desired: "vita-node-8",
      },
    },
    method: "POST",
    path: "/api/preview",
  }));
  assert.equal(preview["ok"], true);
  assert.deepEqual(preview["changed"], ["hostname.set"]);

  const apply = parseJsonObject(await handler({
    body: {
      "hostname.set": {
        desired: "vita-node-7",
      },
    },
    method: "POST",
    path: "/api/apply",
  }));
  assert.equal(apply["ok"], true);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], {
    operations: [
      {
        capability: "hostname.set",
        request: {
          desired: "vita-node-7",
        },
      },
    ],
  });
});

function parityPorts(): ControllerShellPorts {
  return {
    agent: {
      async getHealth(): Promise<unknown> {
        return health();
      },
      async getOperations(): Promise<unknown> {
        return ["hostname.set"];
      },
      async getState(): Promise<unknown> {
        return {
          current: "vita-node-7",
        };
      },
      async getNodeState(): Promise<unknown> {
        return {
          capabilities: {
            "hostname.set": {
              current: "vita-node-7",
            },
          },
          capsuleWorkloads: [],
        };
      },
    },
    apply: async () => ({
      body: committedApplyBody(),
      status: 200,
    }),
    diff: () => ({
      added: [],
      changed: [],
      removed: [],
    }),
    evaluate: () => ({
      ok: true,
      plan: {
        operations: [
          {
            capability: "hostname.set",
            request: {
              desired: "vita-node-7",
            },
          },
        ],
      },
    }),
  };
}

function fakeApply(calls: TransactionPlan[]): ApplyNodeTransport {
  return async (_method, _path, body) => {
    calls[calls.length] = body;

    return {
      body: committedApplyBody(),
      status: 200,
    };
  };
}

function health(): AgentHealth {
  return {
    capabilities: ["hostname.set"],
    healthy: true,
    startedAt: "2026-06-24T12:00:00.000Z",
    uptimeSeconds: 10,
    version: "test-agent",
  };
}

function committedApplyBody(): PlainJsonObject {
  return {
    applied: [
      {
        capability: "hostname.set",
        index: 0,
      },
    ],
    outcome: "committed",
    rollbackErrors: [],
    rolledBack: [],
  };
}

function parseJsonObject(response: ControllerShellResponse): PlainJsonObject {
  const parsed: unknown = JSON.parse(response.body);

  assert.equal(parsed !== null && typeof parsed === "object" && !Array.isArray(parsed), true);
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    assert.fail("expected JSON object response");
  }

  return parsed as PlainJsonObject;
}
