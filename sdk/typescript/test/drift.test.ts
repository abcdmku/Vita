import assert from "node:assert/strict";
import { test } from "node:test";

import {
  computeDrift,
  DriftError,
} from "../src/drift.ts";
import { diffTransactionPlans } from "../src/transaction-plan-diff.ts";
import type {
  ObservedState,
} from "../src/drift.ts";
import type { TransactionPlan } from "../src/transaction-plan-diff.ts";

function plan(
  operations: readonly { capability: string; request: unknown }[],
): TransactionPlan {
  return {
    operations: operations.map((operation) => ({
      capability: operation.capability,
      request: operation.request as never,
    })),
  };
}

const DECLARED_HOSTNAME = plan([
  { capability: "hostname.set", request: { desired: "vita-node-7" } },
]);

test("no drift when observed hostname projects back to the declared request", () => {
  const result = computeDrift(DECLARED_HOSTNAME, {
    "hostname.set": { current: "vita-node-7" },
  });

  assert.deepEqual(result, {
    drifted: false,
    added: [],
    removed: [],
    changed: [],
  });
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result.added), true);
  assert.equal(Object.isFrozen(result.removed), true);
  assert.equal(Object.isFrozen(result.changed), true);
});

test("drift is changed when observed hostname differs from declared", () => {
  const result = computeDrift(DECLARED_HOSTNAME, {
    "hostname.set": { current: "vita-node-8" },
  });

  assert.equal(result.drifted, true);
  assert.deepEqual(result.added, []);
  assert.deepEqual(result.removed, []);
  assert.deepEqual(result.changed, ["hostname.set"]);
});

test("drift is removed when a declared capability has no observed entry", () => {
  const result = computeDrift(DECLARED_HOSTNAME, {});

  assert.equal(result.drifted, true);
  assert.deepEqual(result.added, []);
  assert.deepEqual(result.removed, ["hostname.set"]);
  assert.deepEqual(result.changed, []);
});

test("drift is added when a projected observed capability was not declared", () => {
  const result = computeDrift({ operations: [] }, {
    "hostname.set": { current: "vita-node-7" },
  });

  assert.equal(result.drifted, true);
  assert.deepEqual(result.added, ["hostname.set"]);
  assert.deepEqual(result.removed, []);
  assert.deepEqual(result.changed, []);
});

test("determinism: same inputs yield byte-identical sorted results across repeats", () => {
  const declared = plan([
    { capability: "z.cap", request: { desired: true } },
    { capability: "hostname.set", request: { desired: "vita-node-7" } },
    { capability: "a.cap", request: { desired: true } },
  ]);
  const observed = {
    "hostname.set": { current: "vita-node-7" },
  } satisfies ObservedState;
  const first = computeDrift(declared, observed);

  assert.deepEqual(first.removed, ["a.cap", "z.cap"]);

  for (let repeat = 0; repeat < 5; repeat += 1) {
    const again = computeDrift(declared, observed);
    assert.deepEqual(again, first);
    assert.equal(JSON.stringify(again), JSON.stringify(first));
  }
});

test("fail-closed: malformed observed values throw DriftError", () => {
  const lyingProxy = new Proxy(
    { current: "vita-node-7" },
    {
      get(target, key): unknown {
        if (key === "current") {
          return "vita-node-7";
        }

        return Reflect.get(target, key);
      },
    },
  );

  const accessorState: Record<string, unknown> = {};
  let getterReads = 0;
  Object.defineProperty(accessorState, "current", {
    configurable: true,
    enumerable: true,
    get() {
      getterReads += 1;
      return "vita-node-7";
    },
  });

  const cyclicState: Record<string, unknown> = { current: "vita-node-7" };
  cyclicState.self = cyclicState;

  const topLevelAccessor: Record<string, unknown> = {};
  Object.defineProperty(topLevelAccessor, "hostname.set", {
    configurable: true,
    enumerable: true,
    get() {
      return { current: "vita-node-7" };
    },
  });

  const malformed: readonly ObservedState[] = [
    { "hostname.set": lyingProxy as never },
    { "hostname.set": accessorState as never },
    { "hostname.set": "vita-node-7" as never },
    { "hostname.set": cyclicState as never },
    topLevelAccessor as never,
  ];

  for (let index = 0; index < malformed.length; index += 1) {
    const observed = malformed[index];

    if (observed === undefined) {
      continue;
    }

    assert.throws(() => computeDrift(DECLARED_HOSTNAME, observed), DriftError);
  }

  assert.equal(getterReads, 0);
});

test("diff reuse: drift result matches diffTransactionPlans over the projected observed plan", () => {
  const observedPlan = plan([
    { capability: "hostname.set", request: { desired: "vita-node-7" } },
  ]);
  const drift = computeDrift(DECLARED_HOSTNAME, {
    "hostname.set": { current: "vita-node-7" },
  });
  const diff = diffTransactionPlans(DECLARED_HOSTNAME, observedPlan);

  assert.deepEqual(
    {
      added: drift.added,
      removed: drift.removed,
      changed: drift.changed,
    },
    diff,
  );
  assert.equal(drift.drifted, false);
});
