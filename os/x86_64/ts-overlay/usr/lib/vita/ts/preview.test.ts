import assert from "node:assert/strict";
import { test } from "node:test";

import { diffTransactionPlans as diffUpstream } from "../../../../../../../sdk/typescript/src/transaction-plan-diff.ts";
import { diffTransactionPlans as diffVendored } from "./vita/transaction-plan-diff.ts";
import { evaluateNodeConfig } from "./vita/evaluate.ts";
import { DEFAULT_CAPABILITY_MANIFESTS } from "./vita/generated/capability-manifests.generated.ts";
import type { CapabilityManifest } from "./vita/capability-manifest.ts";
import type { TransactionPlan } from "./vita/transaction-plan-diff.ts";

const CAPABILITY_REGISTRY = new Map<string, CapabilityManifest>(
  Object.entries(DEFAULT_CAPABILITY_MANIFESTS),
);

// Mirrors main.ts: CURRENT vs DESIRED differ by add + remove + change.
const CURRENT_CONFIG = Object.freeze({
  "hostname.set": Object.freeze({ desired: "vita-node-7" }),
  "node.config": Object.freeze({
    desired: Object.freeze({ mode: "normal", remoteAccess: "disabled" }),
  }),
  "time.sync": Object.freeze({
    desired: Object.freeze({
      enabled: true,
      servers: Object.freeze(["Pool.NTP.Org", "2001:0db8::1"]),
    }),
  }),
});

const DESIRED_CONFIG = Object.freeze({
  "hostname.set": Object.freeze({ desired: "vita-node-7" }),
  "node.config": Object.freeze({
    desired: Object.freeze({ mode: "maintenance", remoteAccess: "disabled" }),
  }),
  "network.policy": Object.freeze({
    desired: Object.freeze({
      allow: Object.freeze([
        Object.freeze({
          proto: "tcp",
          port: 443,
          sourceCidr: "10.0.0.5/24",
          interface: "eth0",
        }),
      ]),
    }),
  }),
});

function evaluatePlan(config: unknown): TransactionPlan {
  const result = evaluateNodeConfig(config, CAPABILITY_REGISTRY);

  if (!result.ok) {
    assert.fail(`expected config to evaluate ok: ${JSON.stringify(result.rejections)}`);
  }

  return result.plan;
}

function makePlan(
  operations: readonly { capability: string; request: unknown }[],
): TransactionPlan {
  return {
    operations: operations.map((operation) => ({
      capability: operation.capability,
      request: operation.request as never,
    })),
  };
}

test("evaluate -> diff yields the expected add/remove/change on the main.ts configs", () => {
  const current = evaluatePlan(CURRENT_CONFIG);
  const desired = evaluatePlan(DESIRED_CONFIG);

  const change = diffVendored(current, desired);

  assert.deepEqual(change.added, ["network.policy"]);
  assert.deepEqual(change.removed, ["time.sync"]);
  assert.deepEqual(change.changed, ["node.config"]);
});

test("current == desired yields an all-empty (no-op) diff", () => {
  const current = evaluatePlan(CURRENT_CONFIG);

  assert.deepEqual(diffVendored(current, current), {
    added: [],
    changed: [],
    removed: [],
  });
});

test("determinism: identical inputs yield identical, sorted diffs across repeats", () => {
  const current = evaluatePlan(CURRENT_CONFIG);
  const desired = evaluatePlan(DESIRED_CONFIG);

  const first = diffVendored(current, desired);

  for (let repeat = 0; repeat < 5; repeat += 1) {
    const again = diffVendored(current, desired);
    assert.deepEqual(again, first);
    assert.equal(JSON.stringify(again), JSON.stringify(first));
  }
});

// A corpus of plan pairs to prove zero vendoring drift between the vendored and
// upstream diff modules.
const PLAN_PAIR_CORPUS: readonly { name: string; current: TransactionPlan; desired: TransactionPlan }[] =
  Object.freeze([
    Object.freeze({
      name: "evaluator output: real change",
      current: evaluatePlan(CURRENT_CONFIG),
      desired: evaluatePlan(DESIRED_CONFIG),
    }),
    Object.freeze({
      name: "evaluator output: no-op",
      current: evaluatePlan(CURRENT_CONFIG),
      desired: evaluatePlan(CURRENT_CONFIG),
    }),
    Object.freeze({
      name: "empty vs empty",
      current: makePlan([]),
      desired: makePlan([]),
    }),
    Object.freeze({
      name: "add only",
      current: makePlan([{ capability: "a", request: { v: 1 } }]),
      desired: makePlan([
        { capability: "a", request: { v: 1 } },
        { capability: "b", request: { v: 1 } },
      ]),
    }),
    Object.freeze({
      name: "remove only",
      current: makePlan([
        { capability: "a", request: { v: 1 } },
        { capability: "b", request: { v: 1 } },
      ]),
      desired: makePlan([{ capability: "a", request: { v: 1 } }]),
    }),
    Object.freeze({
      name: "nested change",
      current: makePlan([
        { capability: "x", request: { desired: { servers: ["a", "b"], on: true } } },
      ]),
      desired: makePlan([
        { capability: "x", request: { desired: { servers: ["a", "c"], on: true } } },
      ]),
    }),
    Object.freeze({
      name: "many sorted",
      current: makePlan([
        { capability: "zeta", request: { v: 1 } },
        { capability: "keep", request: { v: 1 } },
        { capability: "mid", request: { v: 1 } },
      ]),
      desired: makePlan([
        { capability: "alpha", request: { v: 1 } },
        { capability: "keep", request: { v: 2 } },
        { capability: "beta", request: { v: 1 } },
      ]),
    }),
  ]);

test("upstream parity: vendored diff equals upstream diff on the corpus (zero drift)", () => {
  for (let index = 0; index < PLAN_PAIR_CORPUS.length; index += 1) {
    const item = PLAN_PAIR_CORPUS[index];

    if (item === undefined) {
      continue;
    }

    const vendored = diffVendored(item.current, item.desired);
    const upstream = diffUpstream(item.current, item.desired);

    assert.deepEqual(vendored, upstream, item.name);
  }
});

test("fail-closed: a throwing getter on a request does not throw and reports changed", () => {
  const hostileRequest: Record<string, unknown> = {};
  let getterReads = 0;
  Object.defineProperty(hostileRequest, "desired", {
    configurable: true,
    enumerable: true,
    get() {
      getterReads += 1;
      throw new Error("getter must not be invoked");
    },
  });

  const current: TransactionPlan = {
    operations: [{ capability: "evil", request: hostileRequest as never }],
  };
  const desired = makePlan([{ capability: "evil", request: { desired: "value" } }]);

  let vendored: ReturnType<typeof diffVendored> | undefined;
  let upstream: ReturnType<typeof diffUpstream> | undefined;
  assert.doesNotThrow(() => {
    vendored = diffVendored(current, desired);
    upstream = diffUpstream(current, desired);
  });

  assert.equal(getterReads, 0);
  assert.deepEqual(vendored, upstream);
  assert.deepEqual(vendored?.changed, ["evil"]);
});

test("fail-closed: a shadowed forEach on the operations array does not subvert the diff", () => {
  const hostileOps: unknown[] = [
    { capability: "kept", request: { v: 1 } },
    { capability: "gone", request: { v: 1 } },
  ];
  let forEachCalls = 0;
  Object.defineProperty(hostileOps, "forEach", {
    configurable: true,
    enumerable: false,
    value() {
      forEachCalls += 1;
      throw new Error("forEach must not be called on untrusted ops");
    },
    writable: true,
  });

  const current: TransactionPlan = { operations: hostileOps as never };
  const desired = makePlan([{ capability: "kept", request: { v: 1 } }]);

  const vendored = diffVendored(current, desired);
  const upstream = diffUpstream(current, desired);

  assert.equal(forEachCalls, 0);
  assert.deepEqual(vendored, upstream);
  assert.deepEqual(vendored.removed, ["gone"]);
});

test("fail-closed: __proto__ capability name does not pollute the prototype", () => {
  const current = makePlan([{ capability: "__proto__", request: { v: 1 } }]);
  const desired = makePlan([{ capability: "__proto__", request: { v: 2 } }]);

  const vendored = diffVendored(current, desired);
  const upstream = diffUpstream(current, desired);

  assert.deepEqual(vendored, upstream);
  assert.deepEqual(vendored.changed, ["__proto__"]);
  assert.equal(({} as Record<string, unknown>).v, undefined);
});

test("fail-closed: malformed (non-array) operations does not throw", () => {
  const malformed: TransactionPlan = { operations: "nope" as never };
  const valid = makePlan([{ capability: "a", request: { v: 1 } }]);

  const vendored = diffVendored(malformed, valid);
  const upstream = diffUpstream(malformed, valid);

  assert.deepEqual(vendored, upstream);
  assert.deepEqual(vendored, { added: ["a"], changed: [], removed: [] });
});
