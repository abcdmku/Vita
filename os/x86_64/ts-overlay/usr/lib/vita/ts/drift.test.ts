import assert from "node:assert/strict";
import { test } from "node:test";

import {
  computeDrift as computeUpstream,
  DRIFT_OBSERVED_CAPABILITIES as UPSTREAM_DRIFT_OBSERVED_CAPABILITIES,
  DriftError as UpstreamDriftError,
} from "../../../../../../../sdk/typescript/src/drift.ts";
import {
  diffTransactionPlans as diffUpstream,
} from "../../../../../../../sdk/typescript/src/transaction-plan-diff.ts";
import {
  computeDrift as computeVendored,
  DRIFT_OBSERVED_CAPABILITIES as VENDORED_DRIFT_OBSERVED_CAPABILITIES,
  DriftError as VendoredDriftError,
} from "./vita/drift.ts";
import { diffTransactionPlans as diffVendored } from "./vita/transaction-plan-diff.ts";
import type { ObservedState } from "./vita/drift.ts";
import type { TransactionPlan } from "./vita/transaction-plan-diff.ts";

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

test("projection table parity: vendored capabilities match upstream", () => {
  assert.deepEqual(
    VENDORED_DRIFT_OBSERVED_CAPABILITIES,
    UPSTREAM_DRIFT_OBSERVED_CAPABILITIES,
  );
});

test("no drift when observed hostname projects back to the declared request", () => {
  const result = computeVendored(DECLARED_HOSTNAME, {
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
  const result = computeVendored(DECLARED_HOSTNAME, {
    "hostname.set": { current: "vita-node-8" },
  });

  assert.equal(result.drifted, true);
  assert.deepEqual(result.added, []);
  assert.deepEqual(result.removed, []);
  assert.deepEqual(result.changed, ["hostname.set"]);
});

test("drift is removed when a declared capability has no observed entry", () => {
  const result = computeVendored(DECLARED_HOSTNAME, {});

  assert.equal(result.drifted, true);
  assert.deepEqual(result.added, []);
  assert.deepEqual(result.removed, ["hostname.set"]);
  assert.deepEqual(result.changed, []);
});

test("drift is added when a projected observed capability was not declared", () => {
  const result = computeVendored({ operations: [] }, {
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
  const first = computeVendored(declared, observed);

  assert.deepEqual(first.removed, ["a.cap", "z.cap"]);

  for (let repeat = 0; repeat < 5; repeat += 1) {
    const again = computeVendored(declared, observed);
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

    assert.throws(() => computeVendored(DECLARED_HOSTNAME, observed), VendoredDriftError);
  }

  assert.equal(getterReads, 0);
});

test("diff reuse: drift result matches diffTransactionPlans over the projected observed plan", () => {
  const observedPlan = plan([
    { capability: "hostname.set", request: { desired: "vita-node-7" } },
  ]);
  const drift = computeVendored(DECLARED_HOSTNAME, {
    "hostname.set": { current: "vita-node-7" },
  });
  const vendoredDiff = diffVendored(DECLARED_HOSTNAME, observedPlan);
  const upstreamDiff = diffUpstream(DECLARED_HOSTNAME, observedPlan);

  assert.deepEqual(vendoredDiff, upstreamDiff);
  assert.deepEqual(
    {
      added: drift.added,
      removed: drift.removed,
      changed: drift.changed,
    },
    vendoredDiff,
  );
  assert.equal(drift.drifted, false);
});

test("upstream parity: vendored drift equals SDK drift on the clean corpus", () => {
  const corpus: readonly { readonly name: string; readonly declared: TransactionPlan; readonly observed: ObservedState }[] =
    Object.freeze([
      Object.freeze({
        name: "no drift",
        declared: DECLARED_HOSTNAME,
        observed: Object.freeze({
          "hostname.set": Object.freeze({ current: "vita-node-7" }),
        }),
      }),
      Object.freeze({
        name: "changed",
        declared: DECLARED_HOSTNAME,
        observed: Object.freeze({
          "hostname.set": Object.freeze({ current: "vita-node-8" }),
        }),
      }),
      Object.freeze({
        name: "removed",
        declared: DECLARED_HOSTNAME,
        observed: Object.freeze({}),
      }),
      Object.freeze({
        name: "added",
        declared: Object.freeze({ operations: Object.freeze([]) }),
        observed: Object.freeze({
          "hostname.set": Object.freeze({ current: "vita-node-7" }),
        }),
      }),
    ]);

  for (let index = 0; index < corpus.length; index += 1) {
    const item = corpus[index];

    if (item === undefined) {
      continue;
    }

    assert.deepEqual(
      computeVendored(item.declared, item.observed),
      computeUpstream(item.declared, item.observed),
      item.name,
    );
  }
});

test("upstream parity: malformed observed values fail closed in both copies", () => {
  const accessorState: Record<string, unknown> = {};
  Object.defineProperty(accessorState, "current", {
    configurable: true,
    enumerable: true,
    get() {
      return "vita-node-7";
    },
  });

  const observed = {
    "hostname.set": accessorState as never,
  };

  assert.throws(() => computeVendored(DECLARED_HOSTNAME, observed), VendoredDriftError);
  assert.throws(() => computeUpstream(DECLARED_HOSTNAME, observed), UpstreamDriftError);
});
