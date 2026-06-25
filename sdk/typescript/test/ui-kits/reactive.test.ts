import assert from "node:assert/strict";
import { test } from "node:test";

import {
  store,
} from "../../../../ui_kits/desktop/runtime/reactive.ts";

interface Snapshot {
  readonly count: number;
}

test("store notifies subscribers synchronously when set receives a new snapshot reference", () => {
  const initial = snapshot(1);
  const next = snapshot(1);
  const state = store(initial);
  const deliveries: Snapshot[] = [];

  assert.notEqual(initial, next);

  state.subscribe((value) => {
    deliveries.push(value);
  });

  state.set(next);

  assert.equal(state.get(), next);
  assert.deepEqual(deliveries, [next]);
});

test("store does not notify subscribers when set receives the current snapshot reference", () => {
  const initial = snapshot(0);
  const state = store(initial);
  let deliveries = 0;

  state.subscribe(() => {
    deliveries += 1;
  });

  state.set(initial);

  assert.equal(state.get(), initial);
  assert.equal(deliveries, 0);
});

test("store delivers new snapshots to multiple subscribers in subscription order", () => {
  const state = store(snapshot(0));
  const next = snapshot(1);
  const events: string[] = [];

  state.subscribe((value) => {
    events.push(`first:${value.count}`);
  });
  state.subscribe((value) => {
    events.push(`second:${value.count}`);
  });

  state.set(next);

  assert.deepEqual(events, [
    "first:1",
    "second:1",
  ]);
});

test("store unsubscribe stops future deliveries", () => {
  const state = store(snapshot(0));
  const first = snapshot(1);
  const second = snapshot(2);
  const deliveries: Snapshot[] = [];
  const unsubscribe = state.subscribe((value) => {
    deliveries.push(value);
  });

  state.set(first);
  unsubscribe();
  state.set(second);

  assert.equal(state.get(), second);
  assert.deepEqual(deliveries, [first]);
});

function snapshot(count: number): Snapshot {
  return Object.freeze({ count });
}
