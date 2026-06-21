import assert from "node:assert/strict";
import { test } from "node:test";

import { evaluateNodeConfig } from "../src/evaluate.ts";
import {
  defaultCapabilityRegistry,
} from "../../../sdk/typescript/src/capability-manifest.ts";
import type {
  CapabilityManifest,
} from "../../../sdk/typescript/src/capability-manifest.ts";
import type {
  CapabilityManifestRegistry,
  EvaluationResult,
} from "../src/evaluate.ts";

const REGISTRY = defaultCapabilityRegistry();

test("valid timesync config evaluates to one canonical operation", () => {
  const result = evaluateNodeConfig(
    {
      "time.sync": {
        enabled: true,
        servers: ["POOL.NTP.ORG"],
      },
    },
    REGISTRY,
  );

  if (!result.ok) {
    assert.fail(`expected evaluation to pass: ${JSON.stringify(result.rejections)}`);
  }

  assert.deepEqual(result.plan, {
    operations: [
      {
        capability: "time.sync",
        request: {
          enabled: true,
          servers: ["pool.ntp.org"],
        },
      },
    ],
  });
});

test("valid hostname config evaluates to one canonical operation", () => {
  const result = evaluateNodeConfig(
    {
      "hostname.set": {
        desired: "vita-node-7",
      },
    },
    REGISTRY,
  );

  if (!result.ok) {
    assert.fail(`expected evaluation to pass: ${JSON.stringify(result.rejections)}`);
  }

  assert.deepEqual(result.plan, {
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

test("unknown capability rejects at evaluation", () => {
  const result = evaluateNodeConfig(
    {
      unknown: {},
    },
    REGISTRY,
  );

  assertRejected(result, ["UNKNOWN_CAPABILITY"]);
  assert.equal(result.rejections[0]?.capability, "unknown");
  assert.equal(result.rejections[0]?.path, "unknown");
  assert.equal(Object.hasOwn(result, "plan"), false);
});

test("invalid timesync request rejects the whole evaluation without a partial plan", () => {
  const result = evaluateNodeConfig(
    {
      "time.sync": {
        enabled: true,
        servers: [],
      },
    },
    REGISTRY,
  );

  assertRejected(result, ["INVALID_CAPABILITY_REQUEST"]);
  assert.deepEqual(result.rejections.map((rejection) => rejection.path), ["time.sync/servers"]);
  assert.equal(Object.hasOwn(result, "plan"), false);
});

test("multi-capability configs emit sorted byte-identical plans", () => {
  const registry: CapabilityManifestRegistry = new Map<string, CapabilityManifest>([
    ...defaultCapabilityRegistry(),
    ["alpha", ALPHA_MANIFEST],
  ]);
  const input = {
    "time.sync": {
      enabled: true,
      servers: ["time.cloudflare.com"],
    },
    alpha: {
      enabled: false,
    },
  };

  const first = evaluateNodeConfig(input, registry);
  const second = evaluateNodeConfig(input, registry);

  if (!first.ok) {
    assert.fail(`expected first evaluation to pass: ${JSON.stringify(first.rejections)}`);
  }
  if (!second.ok) {
    assert.fail(`expected second evaluation to pass: ${JSON.stringify(second.rejections)}`);
  }

  assert.deepEqual(
    first.plan.operations.map((operation) => operation.capability),
    ["alpha", "time.sync"],
  );
  assert.equal(JSON.stringify(first.plan), JSON.stringify(second.plan));
});

test("empty config rejects", () => {
  const result = evaluateNodeConfig({}, REGISTRY);

  assertRejected(result, ["EMPTY_CONFIG"]);
  assert.equal(result.rejections[0]?.path, "");
  assert.equal(Object.hasOwn(result, "plan"), false);
});

test("hostile and non-object configs fail closed without invoking accessors", () => {
  const hostile: Record<string, unknown> = {};
  let getterReads = 0;

  Object.defineProperty(hostile, "time.sync", {
    enumerable: true,
    get() {
      getterReads += 1;
      throw new Error("getter should not be invoked");
    },
  });

  const cyclic: Record<string, unknown> = {
    "time.sync": {
      enabled: true,
      servers: ["pool.ntp.org"],
    },
  };
  cyclic.self = cyclic;

  const hostileServers = ["pool.ntp.org"];
  let iteratorReads = 0;
  Object.defineProperty(hostileServers, Symbol.iterator, {
    enumerable: true,
    get() {
      iteratorReads += 1;
      throw new Error("iterator should not be invoked");
    },
  });

  assert.doesNotThrow(() => {
    assertRejected(evaluateNodeConfig(hostile, REGISTRY), ["INVALID_CONFIG"]);
    assertRejected(evaluateNodeConfig([], REGISTRY), ["INVALID_CONFIG"]);
    assertRejected(evaluateNodeConfig(null, REGISTRY), ["INVALID_CONFIG"]);
    assertRejected(evaluateNodeConfig(cyclic, REGISTRY), ["INVALID_CONFIG"]);
    assertRejected(
      evaluateNodeConfig(
        {
          "time.sync": {
            enabled: true,
            servers: hostileServers,
          },
        },
        REGISTRY,
      ),
      ["INVALID_CONFIG"],
    );
  });
  assert.equal(getterReads, 0);
  assert.equal(iteratorReads, 0);
});

const ALPHA_MANIFEST = Object.freeze({
  capability: "demo.alpha",
  fields: Object.freeze({
    enabled: Object.freeze({
      required: true,
      type: "boolean",
    }),
  }),
  crossFieldRules: Object.freeze([]),
} satisfies CapabilityManifest);

function assertRejected(
  result: EvaluationResult,
  expectedCodes: readonly Extract<EvaluationResult, { readonly ok: false }>["rejections"][number]["code"][],
): asserts result is Extract<EvaluationResult, { readonly ok: false }> {
  if (result.ok) {
    assert.fail(`expected evaluation to reject: ${JSON.stringify(result.plan)}`);
  }

  assert.deepEqual(
    result.rejections.map((rejection) => rejection.code),
    expectedCodes,
  );
}
