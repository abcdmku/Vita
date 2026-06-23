import assert from "node:assert/strict";
import { test } from "node:test";

import { explainTransactionPlanChange } from "../src/transaction-plan-explain.ts";
import type { TransactionPlanChange } from "../src/transaction-plan-diff.ts";

const CHANGE_CORPUS: readonly { name: string; change: TransactionPlanChange; expected: readonly string[] }[] =
  Object.freeze([
    Object.freeze({
      name: "mixed add remove change",
      change: Object.freeze({
        added: Object.freeze(["network.policy", "backup.schedule"]),
        removed: Object.freeze(["time.sync", "identity.owner"]),
        changed: Object.freeze(["node.config", "hostname.set"]),
      }),
      expected: Object.freeze([
        "+ adds capability backup.schedule",
        "+ adds capability network.policy",
        "- removes capability identity.owner",
        "- removes capability time.sync",
        "~ changes capability hostname.set",
        "~ changes capability node.config",
      ]),
    }),
    Object.freeze({
      name: "add only",
      change: Object.freeze({
        added: Object.freeze(["zeta", "alpha"]),
        removed: Object.freeze([]),
        changed: Object.freeze([]),
      }),
      expected: Object.freeze([
        "+ adds capability alpha",
        "+ adds capability zeta",
      ]),
    }),
    Object.freeze({
      name: "remove and change only",
      change: Object.freeze({
        added: Object.freeze([]),
        removed: Object.freeze(["remove.b", "remove.a"]),
        changed: Object.freeze(["change.b", "change.a"]),
      }),
      expected: Object.freeze([
        "- removes capability remove.a",
        "- removes capability remove.b",
        "~ changes capability change.a",
        "~ changes capability change.b",
      ]),
    }),
  ]);

test("known changes render exact sorted lines in add/remove/change order", () => {
  for (let index = 0; index < CHANGE_CORPUS.length; index += 1) {
    const item = CHANGE_CORPUS[index];

    if (item === undefined) {
      continue;
    }

    assert.deepEqual(explainTransactionPlanChange(item.change), item.expected, item.name);
  }
});

test("determinism: same change yields identical lines across repeats", () => {
  const change = CHANGE_CORPUS[0]?.change;

  if (change === undefined) {
    assert.fail("missing corpus entry");
  }

  const first = explainTransactionPlanChange(change);

  for (let repeat = 0; repeat < 5; repeat += 1) {
    const again = explainTransactionPlanChange(change);
    assert.deepEqual(again, first);
    assert.equal(JSON.stringify(again), JSON.stringify(first));
  }
});

test("empty change renders a single no changes line", () => {
  assert.deepEqual(
    explainTransactionPlanChange({
      added: [],
      removed: [],
      changed: [],
    }),
    ["no changes"],
  );
});

test("frozen edge TransactionPlanChange renders without throwing", () => {
  const change = Object.freeze({
    added: Object.freeze(["__proto__", "constructor", ""]),
    removed: Object.freeze(["same.cap"]),
    changed: Object.freeze(["same.cap"]),
  });

  let lines: readonly string[] = [];

  assert.doesNotThrow(() => {
    lines = explainTransactionPlanChange(change);
  });

  assert.deepEqual(lines, [
    "+ adds capability ",
    "+ adds capability __proto__",
    "+ adds capability constructor",
    "- removes capability same.cap",
    "~ changes capability same.cap",
  ]);
});
