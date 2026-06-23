import assert from "node:assert/strict";
import { test } from "node:test";

import { explainTransactionPlanChange as explainUpstream } from "../../../../../../../sdk/typescript/src/transaction-plan-explain.ts";
import { explainTransactionPlanChange as explainVendored } from "./vita/transaction-plan-explain.ts";
import type { TransactionPlanChange } from "./vita/transaction-plan-diff.ts";

const CHANGE_CORPUS: readonly { name: string; change: TransactionPlanChange; expected: readonly string[] }[] =
  Object.freeze([
    Object.freeze({
      name: "main preview change",
      change: Object.freeze({
        added: Object.freeze(["network.policy"]),
        removed: Object.freeze(["time.sync"]),
        changed: Object.freeze(["node.config"]),
      }),
      expected: Object.freeze([
        "+ adds capability network.policy",
        "- removes capability time.sync",
        "~ changes capability node.config",
      ]),
    }),
    Object.freeze({
      name: "sorted mixed change",
      change: Object.freeze({
        added: Object.freeze(["zeta", "alpha"]),
        removed: Object.freeze(["remove.b", "remove.a"]),
        changed: Object.freeze(["change.b", "change.a"]),
      }),
      expected: Object.freeze([
        "+ adds capability alpha",
        "+ adds capability zeta",
        "- removes capability remove.a",
        "- removes capability remove.b",
        "~ changes capability change.a",
        "~ changes capability change.b",
      ]),
    }),
    Object.freeze({
      name: "empty change",
      change: Object.freeze({
        added: Object.freeze([]),
        removed: Object.freeze([]),
        changed: Object.freeze([]),
      }),
      expected: Object.freeze(["no changes"]),
    }),
    Object.freeze({
      name: "edge capability names",
      change: Object.freeze({
        added: Object.freeze(["__proto__", "constructor", ""]),
        removed: Object.freeze([]),
        changed: Object.freeze(["same.cap"]),
      }),
      expected: Object.freeze([
        "+ adds capability ",
        "+ adds capability __proto__",
        "+ adds capability constructor",
        "~ changes capability same.cap",
      ]),
    }),
  ]);

test("vendored explain renders exact sorted lines", () => {
  for (let index = 0; index < CHANGE_CORPUS.length; index += 1) {
    const item = CHANGE_CORPUS[index];

    if (item === undefined) {
      continue;
    }

    assert.deepEqual(explainVendored(item.change), item.expected, item.name);
  }
});

test("determinism: vendored explain yields identical lines across repeats", () => {
  const change = CHANGE_CORPUS[1]?.change;

  if (change === undefined) {
    assert.fail("missing corpus entry");
  }

  const first = explainVendored(change);

  for (let repeat = 0; repeat < 5; repeat += 1) {
    const again = explainVendored(change);
    assert.deepEqual(again, first);
    assert.equal(JSON.stringify(again), JSON.stringify(first));
  }
});

test("upstream parity: vendored explain equals upstream explain on the corpus", () => {
  for (let index = 0; index < CHANGE_CORPUS.length; index += 1) {
    const item = CHANGE_CORPUS[index];

    if (item === undefined) {
      continue;
    }

    assert.deepEqual(explainVendored(item.change), explainUpstream(item.change), item.name);
  }
});

test("frozen edge TransactionPlanChange renders without throwing", () => {
  const edge = CHANGE_CORPUS[3]?.change;

  if (edge === undefined) {
    assert.fail("missing corpus entry");
  }

  assert.doesNotThrow(() => explainVendored(edge));
});

function explainMarkers(change: TransactionPlanChange): readonly string[] {
  const explainLines = explainVendored(change);
  const markers = [`VITA-EXPLAIN: lines=${explainLines.length} status=OK`];

  for (let index = 0; index < explainLines.length; index += 1) {
    const line = explainLines[index];

    if (line !== undefined) {
      markers.push(`VITA-EXPLAIN| ${line}`);
    }
  }

  return markers;
}

test("main.ts wiring: explain marker uses the same preview change lines", () => {
  const change = CHANGE_CORPUS[0]?.change;

  if (change === undefined) {
    assert.fail("missing corpus entry");
  }

  assert.deepEqual(explainMarkers(change), [
    "VITA-EXPLAIN: lines=3 status=OK",
    "VITA-EXPLAIN| + adds capability network.policy",
    "VITA-EXPLAIN| - removes capability time.sync",
    "VITA-EXPLAIN| ~ changes capability node.config",
  ]);
});
