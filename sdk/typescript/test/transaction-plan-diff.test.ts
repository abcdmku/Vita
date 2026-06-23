import assert from "node:assert/strict";
import { test } from "node:test";

import {
  diffTransactionPlans,
  TransactionPlanDiffError,
} from "../src/transaction-plan-diff.ts";
import type { TransactionPlan } from "../src/transaction-plan-diff.ts";

function plan(
  operations: readonly { capability: string; request: unknown }[],
): TransactionPlan {
  return {
    operations: operations.map((operation) => ({
      capability: operation.capability,
      // Cast at the test boundary: the diff treats `request` as untrusted data.
      request: operation.request as never,
    })),
  };
}

test("identical plans yield an all-empty diff", () => {
  const current = plan([
    { capability: "hostname.set", request: { desired: "vita-node-7" } },
    { capability: "time.sync", request: { desired: { enabled: true } } },
  ]);
  const desired = plan([
    { capability: "hostname.set", request: { desired: "vita-node-7" } },
    { capability: "time.sync", request: { desired: { enabled: true } } },
  ]);

  assert.deepEqual(diffTransactionPlans(current, desired), {
    added: [],
    changed: [],
    removed: [],
  });
});

test("known add / remove / changed produce exact, sorted lists", () => {
  const current = plan([
    // present in both, unchanged
    { capability: "hostname.set", request: { desired: "vita-node-7" } },
    // present in both, request changes
    { capability: "node.config", request: { desired: { mode: "normal" } } },
    // present only in current -> removed
    { capability: "time.sync", request: { desired: { enabled: true } } },
  ]);
  const desired = plan([
    { capability: "hostname.set", request: { desired: "vita-node-7" } },
    { capability: "node.config", request: { desired: { mode: "maintenance" } } },
    // present only in desired -> added
    { capability: "network.policy", request: { desired: { allow: [] } } },
  ]);

  assert.deepEqual(diffTransactionPlans(current, desired), {
    added: ["network.policy"],
    changed: ["node.config"],
    removed: ["time.sync"],
  });
});

test("multiple adds/removes/changes are each sorted", () => {
  const current = plan([
    { capability: "zeta", request: { v: 1 } },
    { capability: "mid", request: { v: 1 } },
    { capability: "keep.b", request: { v: 1 } },
    { capability: "keep.a", request: { v: 1 } },
  ]);
  const desired = plan([
    { capability: "alpha", request: { v: 1 } }, // added
    { capability: "beta", request: { v: 1 } }, // added
    { capability: "keep.a", request: { v: 2 } }, // changed
    { capability: "keep.b", request: { v: 2 } }, // changed
    // "zeta" and "mid" removed
  ]);

  const result = diffTransactionPlans(current, desired);

  assert.deepEqual(result.added, ["alpha", "beta"]);
  assert.deepEqual(result.changed, ["keep.a", "keep.b"]);
  assert.deepEqual(result.removed, ["mid", "zeta"]);
});

test("deep structural compare detects nested array and value differences", () => {
  const current = plan([
    {
      capability: "time.sync",
      request: { desired: { servers: ["a.example", "b.example"], enabled: true } },
    },
  ]);
  const desiredSame = plan([
    {
      // key order differs; values identical -> not changed
      capability: "time.sync",
      request: { desired: { enabled: true, servers: ["a.example", "b.example"] } },
    },
  ]);
  const desiredDiff = plan([
    {
      capability: "time.sync",
      request: { desired: { servers: ["a.example", "c.example"], enabled: true } },
    },
  ]);

  assert.deepEqual(diffTransactionPlans(current, desiredSame).changed, []);
  assert.deepEqual(diffTransactionPlans(current, desiredDiff).changed, ["time.sync"]);
});

test("determinism: same inputs yield identical, sorted results across repeats", () => {
  const current = plan([
    { capability: "c", request: { v: 1 } },
    { capability: "a", request: { v: 1 } },
    { capability: "b", request: { v: 1 } },
  ]);
  const desired = plan([
    { capability: "a", request: { v: 9 } }, // changed
    { capability: "d", request: { v: 1 } }, // added
    { capability: "b", request: { v: 1 } }, // unchanged
    // "c" removed
  ]);

  const first = diffTransactionPlans(current, desired);

  for (let repeat = 0; repeat < 5; repeat += 1) {
    assert.deepEqual(diffTransactionPlans(current, desired), first);
    assert.equal(JSON.stringify(diffTransactionPlans(current, desired)), JSON.stringify(first));
  }
});

test("empty plans diff to empty", () => {
  assert.deepEqual(diffTransactionPlans({ operations: [] }, { operations: [] }), {
    added: [],
    changed: [],
    removed: [],
  });
});

test("capability named __proto__ is treated as a real key (no prototype pollution)", () => {
  const current = plan([{ capability: "__proto__", request: { v: 1 } }]);
  const desired = plan([{ capability: "__proto__", request: { v: 2 } }]);

  const result = diffTransactionPlans(current, desired);

  assert.deepEqual(result.changed, ["__proto__"]);
  assert.deepEqual(result.added, []);
  assert.deepEqual(result.removed, []);
  // The prototype must NOT have been mutated.
  assert.equal(({} as Record<string, unknown>).v, undefined);
});

// ---------------------------------------------------------------------------
// Fail-CLOSED-by-throwing: the diff REFUSES on malformed/exotic input. It must
// NOT return a benign empty/unchanged result (that would be fail-OPEN, silently
// claiming "no changes" when it could not compute the diff).
// ---------------------------------------------------------------------------

test("fail-closed: a Proxy operations array (throwing index trap) throws, not empty", () => {
  // A Proxy whose get/getOwnPropertyDescriptor traps throw. A fail-OPEN diff with
  // a top-level catch would swallow this to an empty diff; we must surface a throw.
  const trap = (): never => {
    throw new Error("hostile proxy trap");
  };
  const hostileOps = new Proxy([{ capability: "x", request: { v: 1 } }] as unknown[], {
    get: trap,
    getOwnPropertyDescriptor: trap,
    ownKeys: trap,
    has: trap,
  });

  const current: TransactionPlan = { operations: hostileOps as never };
  const desired = plan([{ capability: "x", request: { v: 1 } }]);

  // The envelope `safeNormalize` recurses into `operations` and rejects the Proxy
  // (`util.types.isProxy`) before any length/index is trusted -> typed throw.
  assert.throws(
    () => diffTransactionPlans(current, desired),
    TransactionPlanDiffError,
  );
});

test("fail-closed: a LYING (non-throwing) Proxy operations array faking length=0 throws, not empty", () => {
  // The round-3 bypass: a Proxy over a REAL operations array that does NOT throw
  // but lies — `Array.isArray` passes (target is an array) and `length` reports a
  // fake 0, hiding the real operations. A per-operation iterate-then-validate loop
  // would see length 0, iterate ZERO operations, never reach `safeNormalize`, and
  // return a benign empty/no-change diff (fail-OPEN). The single envelope gate
  // rejects the Proxy itself (`util.types.isProxy`) BEFORE any length/index of the
  // raw input is read -> typed throw, never an empty diff.
  const realOps = [{ capability: "secret.cap", request: { v: 1 } }] as unknown[];
  const lyingOps = new Proxy(realOps, {
    get(target, key): unknown {
      return key === "length" ? 0 : Reflect.get(target, key);
    },
  });

  const current: TransactionPlan = { operations: lyingOps as never };
  // A genuinely empty desired plan: a fail-OPEN diff would say "secret.cap removed"
  // or "no changes" instead of refusing. We assert it REFUSES.
  const desired: TransactionPlan = { operations: [] };

  assert.throws(
    () => diffTransactionPlans(current, desired),
    TransactionPlanDiffError,
  );

  // And it must NOT silently return any diff (empty or otherwise).
  let returnedWithoutThrowing = false;
  try {
    diffTransactionPlans(current, desired);
    returnedWithoutThrowing = true;
  } catch {
    returnedWithoutThrowing = false;
  }
  assert.equal(returnedWithoutThrowing, false);
});

test("fail-closed: an accessor `request` on BOTH sides throws (never compares 'unchanged')", () => {
  function accessorRequest(): Record<string, unknown> {
    const obj: Record<string, unknown> = {};
    Object.defineProperty(obj, "desired", {
      configurable: true,
      enumerable: true,
      get() {
        return "value";
      },
    });
    return obj;
  }

  const current: TransactionPlan = {
    operations: [{ capability: "x", request: accessorRequest() as never }],
  };
  const desired: TransactionPlan = {
    operations: [{ capability: "x", request: accessorRequest() as never }],
  };

  // safeNormalize rejects accessor properties -> the operation is malformed ->
  // THROW. It must NOT collapse the accessor to `undefined` and compare equal.
  assert.throws(
    () => diffTransactionPlans(current, desired),
    TransactionPlanDiffError,
  );
});

test("fail-closed: a Date/Map/exotic-prototype `request` throws (never compares EQUAL)", () => {
  // Exotic-prototype objects have no enumerable string keys, so a structural diff
  // that walked own keys would see them as EQUAL and hide a real change. They must
  // throw (safeNormalize: "Only plain objects are accepted.").
  const dateReq = new Date(0) as unknown as Record<string, unknown>;
  const mapReq = new Map<string, unknown>() as unknown as Record<string, unknown>;

  const currentDate: TransactionPlan = {
    operations: [{ capability: "x", request: dateReq as never }],
  };
  const desiredPlain = plan([{ capability: "x", request: { desired: "v" } }]);

  assert.throws(
    () => diffTransactionPlans(currentDate, desiredPlain),
    TransactionPlanDiffError,
  );

  // Both sides exotic must also throw (would otherwise compare equal -> hidden).
  const currentMap: TransactionPlan = {
    operations: [{ capability: "x", request: mapReq as never }],
  };
  const desiredDate: TransactionPlan = {
    operations: [{ capability: "x", request: dateReq as never }],
  };

  assert.throws(
    () => diffTransactionPlans(currentMap, desiredDate),
    TransactionPlanDiffError,
  );
});

test("fail-closed: a throwing getter on a request throws as TransactionPlanDiffError (never silently)", () => {
  const hostileRequest: Record<string, unknown> = {};
  Object.defineProperty(hostileRequest, "desired", {
    configurable: true,
    enumerable: true,
    get() {
      throw new Error("getter should never be invoked benignly");
    },
  });

  const current: TransactionPlan = {
    operations: [{ capability: "evil", request: hostileRequest as never }],
  };
  const desired = plan([{ capability: "evil", request: { desired: "value" } }]);

  // safeNormalize rejects the accessor property (it never invokes the getter), so
  // the plan is malformed and the diff throws -- not a benign "changed".
  assert.throws(
    () => diffTransactionPlans(current, desired),
    TransactionPlanDiffError,
  );
});

test("fail-closed: non-array operations throws (not an empty index)", () => {
  const malformed: TransactionPlan = { operations: "not-an-array" as never };
  const valid = plan([{ capability: "a", request: { v: 1 } }]);

  assert.throws(
    () => diffTransactionPlans(malformed, valid),
    TransactionPlanDiffError,
  );
});

test("fail-closed: an operation entry that is not a plain object throws", () => {
  const current: TransactionPlan = {
    operations: [
      { capability: "good", request: { v: 1 } },
      "garbage" as never,
    ],
  };
  const desired = plan([{ capability: "good", request: { v: 1 } }]);

  assert.throws(
    () => diffTransactionPlans(current, desired),
    TransactionPlanDiffError,
  );
});

test("fail-closed: a non-object (primitive) request throws", () => {
  const current: TransactionPlan = {
    operations: [{ capability: "x", request: "not-an-object" as never }],
  };
  const desired = plan([{ capability: "x", request: { v: 1 } }]);

  assert.throws(
    () => diffTransactionPlans(current, desired),
    TransactionPlanDiffError,
  );
});

test("duplicate capabilities are last-wins deterministically", () => {
  const current = plan([
    { capability: "dup", request: { v: 1 } },
    { capability: "dup", request: { v: 2 } }, // last wins
  ]);
  const desired = plan([{ capability: "dup", request: { v: 2 } }]);

  // current.dup resolves to {v:2}, equals desired -> no change.
  assert.deepEqual(diffTransactionPlans(current, desired).changed, []);
});
