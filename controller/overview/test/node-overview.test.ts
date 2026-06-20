import assert from "node:assert/strict";
import { test } from "node:test";

import { buildNodeOverview } from "../src/node-overview.ts";
import type { NodeOverviewClient } from "../src/node-overview.ts";
import type {
  AgentCapabilities,
  AgentHealth,
} from "../../agent-client/src/agent-client.ts";

test("healthy agent builds a ready overview with health and capabilities", async () => {
  const calls = { capabilities: 0, health: 0 };
  const overview = await buildNodeOverview(mockClient(healthyHealth(), capabilities(), calls));

  assert.equal(calls.health, 1);
  assert.equal(calls.capabilities, 1);
  assert.equal(overview.status, "ready");
  assert.equal(overview.uptimeSeconds, 90);
  assert.equal(overview.healthy, true);
  assert.deepEqual(overview.capabilities, ["test.apply", "storage.discover"]);
  assert.equal(overview.hardwareCapabilities?.cpu.arch, "x86_64");
  assert.equal(overview.hardwareCapabilities?.memory.totalMiB, 16_384);
  assert.equal(overview.readiness.status, "ready");
  assert.equal(overview.readiness.ready, true);
  assert.deepEqual(overview.readiness.reasons, []);
  assert.equal(Object.hasOwn(overview, "error"), false);
});

test("unhealthy agent builds a degraded overview without hiding capabilities", async () => {
  const overview = await buildNodeOverview(
    mockClient(
      {
        ...healthyHealth(),
        healthy: false,
      },
      capabilities(),
    ),
  );
  const healthCheck = overview.readiness.checks[0];

  if (healthCheck === undefined) {
    assert.fail("expected a health readiness check");
  }

  assert.equal(overview.status, "degraded");
  assert.equal(overview.healthy, false);
  assert.deepEqual(overview.capabilities, ["test.apply", "storage.discover"]);
  assert.equal(overview.hardwareCapabilities?.virtualization.hardware, true);
  assert.equal(overview.readiness.ready, false);
  assert.equal(healthCheck.name, "agent-health");
  assert.equal(healthCheck.status, "fail");
  assert.equal(Object.hasOwn(overview, "error"), false);
});

test("client errors fail closed as unreachable without throwing", async () => {
  const client: NodeOverviewClient = {
    async getCapabilities() {
      return capabilities();
    },
    async getHealth() {
      throw new Error("loopback refused");
    },
  };

  const overview = await buildNodeOverview(client);

  assert.equal(overview.status, "unreachable");
  assert.equal(overview.uptimeSeconds, 0);
  assert.equal(overview.healthy, false);
  assert.deepEqual(overview.capabilities, []);
  assert.equal(overview.hardwareCapabilities, null);
  assert.equal(overview.error?.code, "AGENT_UNREACHABLE");
  assert.equal(overview.error?.source, "health");
  assert.equal(overview.readiness.status, "unreachable");
  assert.equal(overview.readiness.ready, false);
});

test("malformed client results fail closed as degraded typed errors", async () => {
  const malformedHealth = {
    version: "test-version",
  };
  const client = {
    async getCapabilities() {
      return capabilities();
    },
    async getHealth() {
      return malformedHealth;
    },
  } as unknown as NodeOverviewClient;

  const overview = await buildNodeOverview(client);

  assert.equal(overview.status, "degraded");
  assert.equal(overview.uptimeSeconds, 0);
  assert.equal(overview.healthy, false);
  assert.deepEqual(overview.capabilities, []);
  assert.equal(overview.hardwareCapabilities?.cpu.model, "fixture cpu");
  assert.equal(overview.error?.code, "MALFORMED_AGENT_RESULT");
  assert.equal(overview.error?.source, "health");
  assert.equal(overview.readiness.ready, false);
});

test("exotic malformed values are rejected without invoking attacker-controlled methods", async () => {
  const shadowedCapabilities: unknown[] = ["test.apply"];
  Object.defineProperty(shadowedCapabilities, "includes", {
    enumerable: true,
    value() {
      assert.fail("shadowed array methods must not be invoked");
    },
  });

  const cyclic: Record<string, unknown> = {};
  cyclic["self"] = cyclic;

  const healthWithShadowedArray = {
    ...healthyHealth(),
    capabilities: shadowedCapabilities,
  };
  const client = {
    async getCapabilities() {
      return cyclic;
    },
    async getHealth() {
      return healthWithShadowedArray;
    },
  } as unknown as NodeOverviewClient;

  const overview = await buildNodeOverview(client);

  assert.equal(overview.status, "degraded");
  assert.equal(overview.healthy, false);
  assert.equal(overview.hardwareCapabilities, null);
  assert.equal(overview.error?.code, "MALFORMED_AGENT_RESULT");
  assert.equal(overview.readiness.ready, false);
});

interface CallCounts {
  health: number;
  capabilities: number;
}

function mockClient(
  health: AgentHealth,
  hardwareCapabilities: AgentCapabilities,
  calls?: CallCounts,
): NodeOverviewClient {
  return {
    async getCapabilities() {
      if (calls !== undefined) {
        calls.capabilities += 1;
      }

      return hardwareCapabilities;
    },
    async getHealth() {
      if (calls !== undefined) {
        calls.health += 1;
      }

      return health;
    },
  };
}

function healthyHealth(): AgentHealth {
  return {
    capabilities: ["test.apply", "storage.discover"],
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
