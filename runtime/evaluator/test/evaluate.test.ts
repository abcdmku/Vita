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

test("valid node.config request evaluates to one operation", () => {
  const result = evaluateNodeConfig(
    {
      "node.config": {
        desired: {
          mode: "normal",
          remoteAccess: "disabled",
        },
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
        capability: "node.config",
        request: {
          desired: {
            mode: "normal",
            remoteAccess: "disabled",
          },
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

test("valid time.sync request evaluates to one canonical operation", () => {
  const result = evaluateNodeConfig(
    {
      "time.sync": {
        desired: {
          enabled: true,
          servers: ["Pool.NTP.Org", "2001:0db8::1"],
        },
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
          desired: {
            enabled: true,
            servers: ["pool.ntp.org", "2001:db8::1"],
          },
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

test("invalid node.config request rejects the whole evaluation without a partial plan", () => {
  const result = evaluateNodeConfig(
    {
      "node.config": {
        desired: {
          mode: "normal",
        },
      },
    },
    REGISTRY,
  );

  assertRejected(result, ["INVALID_CAPABILITY_REQUEST"]);
  assert.deepEqual(result.rejections.map((rejection) => rejection.path), [
    "node.config/desired/remoteAccess",
  ]);
  assert.equal(Object.hasOwn(result, "plan"), false);
});

test("multi-capability configs emit sorted byte-identical plans", () => {
  const registry: CapabilityManifestRegistry = new Map<string, CapabilityManifest>([
    ...defaultCapabilityRegistry(),
    ["alpha", ALPHA_MANIFEST],
  ]);
  const input = {
    "node.config": {
      desired: {
        mode: "maintenance",
        remoteAccess: "enabled",
      },
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
    ["alpha", "node.config"],
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

  Object.defineProperty(hostile, "node.config", {
    enumerable: true,
    get() {
      getterReads += 1;
      throw new Error("getter should not be invoked");
    },
  });

  const cyclic: Record<string, unknown> = {
    "node.config": {
      desired: {
        mode: "normal",
        remoteAccess: "disabled",
      },
    },
  };
  cyclic.self = cyclic;

  const hostileDesired: Record<string, unknown> = {
    mode: "normal",
    remoteAccess: "disabled",
  };
  let getterReadsNested = 0;
  Object.defineProperty(hostileDesired, "extra", {
    enumerable: true,
    get() {
      getterReadsNested += 1;
      throw new Error("nested getter should not be invoked");
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
          "node.config": {
            desired: hostileDesired,
          },
        },
        REGISTRY,
      ),
      ["INVALID_CONFIG"],
    );
  });
  assert.equal(getterReads, 0);
  assert.equal(getterReadsNested, 0);
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
