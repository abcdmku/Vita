import assert from "node:assert/strict";
import { test } from "node:test";

import { diffTransactionPlans } from "../src/transaction-plan-diff.ts";
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

test("trust boundary: a shadowed forEach on the operations array does not break the diff", () => {
  // A hostile operations array that shadows `forEach`/`map`/iterator so that any
  // code relying on those methods would be subverted. The diff uses indexed reads
  // only, so it must still produce the correct result.
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
      throw new Error("forEach should never be called on untrusted ops");
    },
    writable: true,
  });
  Object.defineProperty(hostileOps, Symbol.iterator, {
    configurable: true,
    enumerable: false,
    value() {
      throw new Error("iterator should never be used on untrusted ops");
    },
    writable: true,
  });

  const current: TransactionPlan = { operations: hostileOps as never };
  const desired = plan([{ capability: "kept", request: { v: 1 } }]);

  const result = diffTransactionPlans(current, desired);

  assert.equal(forEachCalls, 0);
  assert.deepEqual(result.removed, ["gone"]);
  assert.deepEqual(result.added, []);
  assert.deepEqual(result.changed, []);
});

test("trust boundary: a throwing getter on a request does not throw; compares as changed (fail-closed)", () => {
  const hostileRequest: Record<string, unknown> = {};
  let getterReads = 0;
  Object.defineProperty(hostileRequest, "desired", {
    configurable: true,
    enumerable: true,
    get() {
      getterReads += 1;
      throw new Error("getter should never be invoked by the diff");
    },
  });

  const current: TransactionPlan = {
    operations: [{ capability: "evil", request: hostileRequest as never }],
  };
  const desired = plan([{ capability: "evil", request: { desired: "value" } }]);

  // Must not throw, must not invoke the getter, and must report the capability as
  // changed (it cannot be proven identical without invoking attacker code).
  let result: ReturnType<typeof diffTransactionPlans> | undefined;
  assert.doesNotThrow(() => {
    result = diffTransactionPlans(current, desired);
  });

  assert.equal(getterReads, 0);
  assert.deepEqual(result?.changed, ["evil"]);
  assert.deepEqual(result?.added, []);
  assert.deepEqual(result?.removed, []);
});

test("trust boundary: a throwing-getter `request` that is identical-by-getter still reports changed (never reads getter)", () => {
  // Both sides expose `desired` via an identical throwing getter. A naive diff
  // that read the property would throw; ours must skip the getter and, unable to
  // prove equality, report the capability as changed -- fail-closed, never throw.
  function hostile(): Record<string, unknown> {
    const obj: Record<string, unknown> = {};
    Object.defineProperty(obj, "desired", {
      configurable: true,
      enumerable: true,
      get() {
        throw new Error("no");
      },
    });
    return obj;
  }

  const current: TransactionPlan = {
    operations: [{ capability: "x", request: hostile() as never }],
  };
  const desired: TransactionPlan = {
    operations: [{ capability: "x", request: hostile() as never }],
  };

  let result: ReturnType<typeof diffTransactionPlans> | undefined;
  assert.doesNotThrow(() => {
    result = diffTransactionPlans(current, desired);
  });

  assert.deepEqual(result?.changed, ["x"]);
});

test("trust boundary: a non-array / malformed operations does not throw, yields empty index", () => {
  const malformed: TransactionPlan = { operations: "not-an-array" as never };
  const valid = plan([{ capability: "a", request: { v: 1 } }]);

  // malformed current -> "a" appears only in desired -> added; nothing else.
  const result = diffTransactionPlans(malformed, valid);
  assert.deepEqual(result, { added: ["a"], changed: [], removed: [] });

  // malformed on both sides -> empty diff, no throw.
  assert.deepEqual(diffTransactionPlans(malformed, { operations: 42 as never }), {
    added: [],
    changed: [],
    removed: [],
  });
});

test("trust boundary: an operation entry that is not a plain object is skipped", () => {
  const current: TransactionPlan = {
    operations: [
      { capability: "good", request: { v: 1 } },
      "garbage" as never,
      null as never,
      42 as never,
    ],
  };
  const desired = plan([{ capability: "good", request: { v: 1 } }]);

  assert.deepEqual(diffTransactionPlans(current, desired), {
    added: [],
    changed: [],
    removed: [],
  });
});

test("trust boundary: duplicate capabilities are last-wins deterministically", () => {
  const current = plan([
    { capability: "dup", request: { v: 1 } },
    { capability: "dup", request: { v: 2 } }, // last wins
  ]);
  const desired = plan([{ capability: "dup", request: { v: 2 } }]);

  // current.dup resolves to {v:2}, equals desired -> no change.
  assert.deepEqual(diffTransactionPlans(current, desired).changed, []);
});
