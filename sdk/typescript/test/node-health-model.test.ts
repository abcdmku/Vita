import assert from "node:assert/strict";
import { test } from "node:test";

import { validateNodeHealth } from "../src/node-health-model.ts";
import type {
  NodeHealth,
  NodeHealthValidationResult,
  ValidationError,
} from "../src/node-health-model.ts";

test("a valid node health report validates", () => {
  const health = validHealth();
  const result = validateNodeHealth(health);

  if (!result.ok) {
    assert.fail(`expected node health to validate: ${JSON.stringify(result.errors)}`);
  }

  assert.deepEqual(result.health, health);
  assert.equal(result.value, result.health);
});

test("impossible and negative resource metrics are rejected", () => {
  assert.deepEqual(
    rejectedPaths(
      validateNodeHealth({
        ...validHealth(),
        memory: {
          total: 100,
          used: 101,
        },
      }),
    ),
    ["memory/used"],
  );

  assert.deepEqual(
    rejectedPaths(
      validateNodeHealth({
        ...validHealth(),
        storage: {
          total: 2048,
          used: -1,
        },
      }),
    ),
    ["storage/used"],
  );
});

test("capability status is a closed set", () => {
  const health = mutableHealth();
  const capability = health.capabilities[0];

  if (capability === undefined) {
    assert.fail("expected capability fixture");
  }

  capability.status = "unknown";

  assert.deepEqual(rejectedPaths(validateNodeHealth(health)), ["capabilities/0/status"]);
});

test("duplicate capability names are rejected", () => {
  const health = mutableHealth();
  health.capabilities.push({
    name: "storage.disk",
    status: "failed",
  });

  assert.deepEqual(rejectedPaths(validateNodeHealth(health)), ["capabilities/2/name"]);
});

test("negative uptime is rejected", () => {
  assert.deepEqual(
    rejectedPaths(
      validateNodeHealth({
        ...validHealth(),
        uptimeSeconds: -1,
      }),
    ),
    ["uptimeSeconds"],
  );
});

test("missing required fields are rejected", () => {
  const health = mutableHealth();
  delete health.cpu;

  assert.deepEqual(rejectedPaths(validateNodeHealth(health)), ["cpu"]);
});

test("fields carrying inline key material are rejected", () => {
  assert.equal(
    rejectedPaths(
      validateNodeHealth({
        ...validHealth(),
        privateKey: "-----BEGIN PRIVATE KEY-----\nsecret\n-----END PRIVATE KEY-----",
      }),
    ).includes("privateKey"),
    true,
  );

  const health = mutableHealth();
  const capability = health.capabilities[0];

  if (capability === undefined) {
    assert.fail("expected capability fixture");
  }

  capability.message = "password: correct-horse-battery-staple";

  assert.deepEqual(rejectedPaths(validateNodeHealth(health)), ["capabilities/0/message"]);
});

test("hostile and partial inputs fail closed through safeNormalize without throwing", () => {
  const cyclic: Record<string, unknown> = {
    healthy: true,
  };
  cyclic.self = cyclic;

  const accessor: Record<string, unknown> = {};
  let getterReads = 0;
  Object.defineProperty(accessor, "healthy", {
    enumerable: true,
    get() {
      getterReads += 1;
      throw new Error("getter should not be read");
    },
  });

  const methodShadowed = mutableHealth();
  const shadowedCapabilities = [...methodShadowed.capabilities];
  Object.defineProperty(shadowedCapabilities, "map", {
    enumerable: true,
    value() {
      return [];
    },
  });
  methodShadowed.capabilities = shadowedCapabilities;

  const hostileIterator = mutableHealth();
  const iteratorCapabilities = [...hostileIterator.capabilities];
  let iteratorReads = 0;
  Object.defineProperty(iteratorCapabilities, Symbol.iterator, {
    enumerable: true,
    get() {
      iteratorReads += 1;
      throw new Error("iterator should not be read");
    },
  });
  hostileIterator.capabilities = iteratorCapabilities;

  const inputs: readonly unknown[] = [
    null,
    "node-health",
    [],
    cyclic,
    accessor,
    new Date(),
    new Map(),
    new Proxy({}, {}),
    methodShadowed,
    hostileIterator,
    {
      healthy: true,
      uptimeSeconds: 12,
    },
  ];

  for (let index = 0; index < inputs.length; index += 1) {
    assertRejected(inputs[index]);
  }

  assert.equal(getterReads, 0);
  assert.equal(iteratorReads, 0);
});

function validHealth(): NodeHealth {
  return {
    capabilities: [
      {
        name: "storage.disk",
        status: "healthy",
      },
      {
        message: "queue latency above target",
        name: "updates",
        status: "degraded",
      },
    ],
    cpu: {
      total: 100,
      used: 37,
    },
    healthy: true,
    memory: {
      total: 32_768,
      used: 12_288,
    },
    storage: {
      total: 1_099_511_627_776,
      used: 274_877_906_944,
    },
    uptimeSeconds: 86_400,
  };
}

function mutableHealth(): MutableNodeHealth {
  return {
    capabilities: validHealth().capabilities.map((capability) => ({
      ...(capability.message === undefined ? {} : { message: capability.message }),
      name: capability.name,
      status: capability.status,
    })),
    cpu: {
      total: validHealth().cpu.total,
      used: validHealth().cpu.used,
    },
    healthy: validHealth().healthy,
    memory: {
      total: validHealth().memory.total,
      used: validHealth().memory.used,
    },
    storage: {
      total: validHealth().storage.total,
      used: validHealth().storage.used,
    },
    uptimeSeconds: validHealth().uptimeSeconds,
  };
}

function rejectedPaths(result: NodeHealthValidationResult): readonly string[] {
  if (result.ok) {
    assert.fail(`expected validation to fail: ${JSON.stringify(result.value)}`);
  }

  return result.errors.map((error) => error.path).sort();
}

function assertRejected(value: unknown): void {
  let errors: readonly ValidationError[] | undefined;

  assert.doesNotThrow(() => {
    const result = validateNodeHealth(value);

    if (result.ok) {
      assert.fail(`expected validation to fail: ${JSON.stringify(result.value)}`);
    }

    errors = result.errors;
  });

  assert.notEqual(errors, undefined);
}

interface MutableNodeHealth extends Record<string, unknown> {
  capabilities: Array<{
    name: string;
    status: string;
    message?: string;
  }>;
  cpu?: {
    total: number;
    used: number;
  };
  healthy: boolean;
  memory: {
    total: number;
    used: number;
  };
  storage: {
    total: number;
    used: number;
  };
  uptimeSeconds: number;
}
