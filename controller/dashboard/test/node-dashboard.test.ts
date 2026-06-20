import assert from "node:assert/strict";
import { test } from "node:test";

import { AgentClientError } from "../../agent-client/src/agent-client.ts";
import type {
  AgentCapabilities,
  AgentCapabilityState,
  AgentHealth,
} from "../../agent-client/src/agent-client.ts";
import { buildNodeDashboard } from "../src/node-dashboard.ts";
import type { NodeDashboardClient } from "../src/node-dashboard.ts";

test("healthy agent builds a complete reachable node dashboard", async () => {
  const calls = {
    capabilities: 0,
    health: 0,
    operations: 0,
    states: [] as string[],
  };
  const dashboard = await buildNodeDashboard(healthyClient(calls), [
    "node.config",
    "storage.layout",
  ]);

  assert.equal(calls.health, 1);
  assert.equal(calls.capabilities, 1);
  assert.equal(calls.operations, 1);
  assert.deepEqual(calls.states, ["node.config", "storage.layout"]);
  assert.equal(dashboard.reachable, true);
  assert.equal(dashboard.overview.status, "ready");
  assert.equal(dashboard.operations.status, "ready");
  assert.deepEqual(dashboard.operations.operations, [
    "hostname.set",
    "nodeconfig.apply",
  ]);
  assert.equal(dashboard.states.status, "ready");
  assert.deepEqual(dashboard.states.states["node.config"], {
    ok: true,
    state: stateFor("node.config"),
  });
  assert.deepEqual(dashboard.states.states["storage.layout"], {
    ok: true,
    state: stateFor("storage.layout"),
  });
});

test("overview failure degrades only overview while operations and states populate", async () => {
  const client: NodeDashboardClient = {
    async getCapabilities(): Promise<AgentCapabilities> {
      return capabilities();
    },
    async getHealth(): Promise<AgentHealth> {
      throw new Error("health refused");
    },
    async getOperations(): Promise<readonly string[]> {
      return ["hostname.set"];
    },
    async getState(capability): Promise<AgentCapabilityState> {
      return stateFor(capability);
    },
  };

  const dashboard = await buildNodeDashboard(client, ["node.config"]);

  assert.equal(dashboard.overview.status, "unreachable");
  assert.equal(dashboard.overview.error?.code, "AGENT_UNREACHABLE");
  assert.equal(dashboard.operations.status, "ready");
  assert.deepEqual(dashboard.operations.operations, ["hostname.set"]);
  assert.equal(dashboard.states.status, "ready");
  assert.equal(dashboard.states.states["node.config"]?.ok, true);
  assert.equal(dashboard.reachable, true);
});

test("fully unreachable agent returns a typed dashboard without throwing", async () => {
  const dashboard = await buildNodeDashboard(
    unreachableClient(new AgentClientError("TRANSPORT_ERROR", "loopback refused")),
    ["node.config"],
  );

  assert.equal(dashboard.overview.status, "unreachable");
  assert.equal(dashboard.operations.status, "unreachable");
  assert.equal(dashboard.operations.error?.code, "AGENT_UNREACHABLE");
  assert.equal(dashboard.states.status, "unreachable");
  assert.equal(dashboard.states.states["node.config"]?.ok, false);
  assert.equal(dashboard.reachable, false);
});

test("fully unreachable agent with no state capabilities is still unreachable", async () => {
  const calls = {
    states: 0,
  };
  const dashboard = await buildNodeDashboard(
    unreachableClient(
      new AgentClientError("TRANSPORT_ERROR", "loopback refused"),
      calls,
    ),
    [],
  );

  assert.equal(calls.states, 0);
  assert.equal(dashboard.overview.status, "unreachable");
  assert.equal(dashboard.operations.status, "unreachable");
  assert.equal(dashboard.states.status, "ready");
  assert.deepEqual(dashboard.states.states, {});
  assert.equal(dashboard.reachable, false);
});

test("malformed operation and state responses degrade per section", async () => {
  const client = {
    async getCapabilities(): Promise<AgentCapabilities> {
      return capabilities();
    },
    async getHealth(): Promise<AgentHealth> {
      return healthyHealth();
    },
    async getOperations(): Promise<unknown> {
      return ["hostname.set", 7];
    },
    async getState(): Promise<unknown> {
      return ["not", "a", "state"];
    },
  } as unknown as NodeDashboardClient;

  const dashboard = await buildNodeDashboard(client, ["node.config"]);

  assert.equal(dashboard.overview.status, "ready");
  assert.equal(dashboard.operations.status, "degraded");
  assert.equal(dashboard.operations.error?.code, "MALFORMED_AGENT_RESULT");
  assert.deepEqual(dashboard.operations.operations, []);
  assert.equal(dashboard.states.status, "degraded");
  assert.deepEqual(dashboard.states.states["node.config"], {
    ok: false,
    error: {
      code: "MALFORMED_STATE",
      message: 'Capability "node.config" returned malformed state: state must be an object.',
    },
  });
  assert.equal(dashboard.reachable, true);
});

test("hostile nested client-error details cannot throw during dashboard degradation", async () => {
  for (const error of [revokedProxyAgentError(), throwingAccessorAgentError()]) {
    const client: NodeDashboardClient = {
      async getCapabilities(): Promise<AgentCapabilities> {
        return capabilities();
      },
      async getHealth(): Promise<AgentHealth> {
        return healthyHealth();
      },
      async getOperations(): Promise<readonly string[]> {
        throw error;
      },
      async getState(capability): Promise<AgentCapabilityState> {
        return stateFor(capability);
      },
    };

    const dashboard = await buildNodeDashboard(client, ["node.config"]);

    assert.equal(dashboard.overview.status, "ready");
    assert.equal(dashboard.operations.status, "degraded");
    assert.equal(dashboard.operations.error?.clientCode, "AGENT_ERROR");
    assert.equal(dashboard.states.status, "ready");
    assert.equal(dashboard.reachable, true);
  }
});

interface CallCounts {
  capabilities: number;
  health: number;
  operations: number;
  states: string[];
}

function healthyClient(calls?: CallCounts): NodeDashboardClient {
  return {
    async getCapabilities(): Promise<AgentCapabilities> {
      if (calls !== undefined) {
        calls.capabilities += 1;
      }

      return capabilities();
    },
    async getHealth(): Promise<AgentHealth> {
      if (calls !== undefined) {
        calls.health += 1;
      }

      return healthyHealth();
    },
    async getOperations(): Promise<readonly string[]> {
      if (calls !== undefined) {
        calls.operations += 1;
      }

      return ["hostname.set", "nodeconfig.apply"];
    },
    async getState(capability): Promise<AgentCapabilityState> {
      if (calls !== undefined) {
        calls.states[calls.states.length] = capability;
      }

      return stateFor(capability);
    },
  };
}

function unreachableClient(
  error: unknown,
  calls?: {
    states: number;
  },
): NodeDashboardClient {
  return {
    async getCapabilities(): Promise<AgentCapabilities> {
      throw error;
    },
    async getHealth(): Promise<AgentHealth> {
      throw error;
    },
    async getOperations(): Promise<readonly string[]> {
      throw error;
    },
    async getState(): Promise<AgentCapabilityState> {
      if (calls !== undefined) {
        calls.states += 1;
      }

      throw error;
    },
  };
}

function revokedProxyAgentError(): AgentClientError {
  const error = new AgentClientError("AGENT_ERROR", "operation rejected", {
    status: 500,
  });
  const revoked = Proxy.revocable(
    {
      code: "operation_failed",
      message: "operation failed",
    },
    {},
  );

  revoked.revoke();
  Object.defineProperty(error, "agentError", {
    configurable: true,
    enumerable: true,
    value: revoked.proxy,
  });

  return error;
}

function throwingAccessorAgentError(): AgentClientError {
  const error = new AgentClientError("AGENT_ERROR", "operation rejected", {
    status: 500,
  });

  Object.defineProperty(error, "agentError", {
    configurable: true,
    enumerable: true,
    get(): never {
      throw new Error("agentError getter must not run");
    },
  });

  return error;
}

function healthyHealth(): AgentHealth {
  return {
    capabilities: ["hostname.set", "nodeconfig.apply"],
    healthy: true,
    startedAt: "2026-06-20T12:00:00.000Z",
    uptimeSeconds: 90,
    version: "test-version",
  };
}

function capabilities(): AgentCapabilities {
  return {
    accelerators: [
      {
        architecture: "x86_64",
        kind: "cpu",
      },
    ],
    cpu: {
      arch: "x86_64",
      cores: 8,
      model: "fixture cpu",
    },
    memory: {
      totalMiB: 16_384,
    },
    networking: {
      interfaces: [
        {
          kind: "loopback",
          name: "lo",
        },
      ],
    },
    storage: [
      {
        name: "nvme0n1",
        nvme: true,
        rotational: false,
        sizeMiB: 512_000,
      },
    ],
    tpm: {
      present: true,
      version: "2.0",
    },
    virtualization: {
      hardware: true,
    },
  };
}

function stateFor(capability: string): AgentCapabilityState {
  return {
    capability,
    exists: true,
  };
}
