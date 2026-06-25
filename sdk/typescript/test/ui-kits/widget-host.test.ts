import assert from "node:assert/strict";
import { test } from "node:test";

import {
  createWidgetHostModel,
  widgetInstancesOverlap,
} from "../../../../ui_kits/desktop/viewmodels/widget-host.ts";
import type {
  WidgetHostModel,
  WidgetHostPorts,
  WidgetHostState,
  WidgetHostZone,
  WidgetInstance,
  WidgetPlacement,
} from "../../../../ui_kits/desktop/viewmodels/widget-host.ts";

test("widget host rejects overlapping and out-of-bounds add, move, and resize without changing state", () => {
  const vm = createWidgetHostModel({
    zones: zones(4, 3),
  });
  const clock = mustAdd(vm, "clock", placement(0, 0));
  const weather = mustAdd(vm, "weather", placement(1, 0));

  assertNoOverlaps(vm.snapshot());

  const beforeOverlapAdd = vm.snapshot();
  const overlapAdd = vm.add("clock", placement(0, 0));

  assert.equal(overlapAdd.ok, false);
  if (overlapAdd.ok) {
    assert.fail("expected overlapping add to fail closed");
  }
  assert.equal(overlapAdd.error.code, "PLACEMENT_OVERLAP");
  assert.equal(overlapAdd.state, beforeOverlapAdd);
  assert.equal(vm.snapshot(), beforeOverlapAdd);

  const beforeOutOfBoundsAdd = vm.snapshot();
  const outOfBoundsAdd = vm.add("weather", placement(3, 0));

  assert.equal(outOfBoundsAdd.ok, false);
  if (outOfBoundsAdd.ok) {
    assert.fail("expected out-of-bounds add to fail closed");
  }
  assert.equal(outOfBoundsAdd.error.code, "PLACEMENT_OUT_OF_BOUNDS");
  assert.equal(outOfBoundsAdd.state, beforeOutOfBoundsAdd);

  const beforeMove = vm.snapshot();
  const overlapMove = vm.move(weather.id, placement(0, 0));

  assert.equal(overlapMove.ok, false);
  if (overlapMove.ok) {
    assert.fail("expected overlapping move to fail closed");
  }
  assert.equal(overlapMove.error.code, "PLACEMENT_OVERLAP");
  assert.equal(overlapMove.state, beforeMove);
  assert.equal(vm.snapshot(), beforeMove);

  const beforeOutOfBoundsMove = vm.snapshot();
  const outOfBoundsMove = vm.move(clock.id, placement(4, 0));

  assert.equal(outOfBoundsMove.ok, false);
  if (outOfBoundsMove.ok) {
    assert.fail("expected out-of-bounds move to fail closed");
  }
  assert.equal(outOfBoundsMove.error.code, "PLACEMENT_OUT_OF_BOUNDS");
  assert.equal(outOfBoundsMove.state, beforeOutOfBoundsMove);

  const beforeResize = vm.snapshot();
  const overlapResize = vm.resize(clock.id, "M");

  assert.equal(overlapResize.ok, false);
  if (overlapResize.ok) {
    assert.fail("expected overlapping resize to fail closed");
  }
  assert.equal(overlapResize.error.code, "PLACEMENT_OVERLAP");
  assert.equal(overlapResize.state, beforeResize);

  const removed = vm.remove(clock.id);

  assert.equal(removed.ok, true);
  assertNoOverlaps(removed.state);

  const resized = vm.resize(weather.id, "L");

  assert.equal(resized.ok, true);
  assertNoOverlaps(resized.state);

  const beforeLargeMove = vm.snapshot();
  const largeOutOfBoundsMove = vm.move(weather.id, placement(3, 0));

  assert.equal(largeOutOfBoundsMove.ok, false);
  if (largeOutOfBoundsMove.ok) {
    assert.fail("expected large out-of-bounds move to fail closed");
  }
  assert.equal(largeOutOfBoundsMove.error.code, "PLACEMENT_OUT_OF_BOUNDS");
  assert.equal(largeOutOfBoundsMove.state, beforeLargeMove);
});

test("widget reorder moves one instance while preserving the relative order of the others", () => {
  const vm = createWidgetHostModel({
    zones: zones(6, 3),
  });
  const clock = mustAdd(vm, "clock", placement(0, 0));
  const stats = mustAdd(vm, "system-stats", placement(1, 0));
  const weather = mustAdd(vm, "weather", placement(0, 1));
  const notes = mustAdd(vm, "notes", placement(2, 1));

  assert.deepEqual(instanceIds(vm.snapshot()), [clock.id, stats.id, weather.id, notes.id]);

  const reordered = vm.reorder(weather.id, 1);

  assert.equal(reordered.ok, true);
  assert.deepEqual(instanceIds(reordered.state), [clock.id, weather.id, stats.id, notes.id]);

  const movedToEnd = vm.reorder(clock.id, 3);

  assert.equal(movedToEnd.ok, true);
  assert.deepEqual(instanceIds(movedToEnd.state), [weather.id, stats.id, notes.id, clock.id]);

  const beforeInvalid = vm.snapshot();
  const invalid = vm.reorder(notes.id, 4);

  assert.equal(invalid.ok, false);
  if (invalid.ok) {
    assert.fail("expected out-of-range reorder to fail closed");
  }
  assert.equal(invalid.error.code, "INVALID_INDEX");
  assert.equal(invalid.state, beforeInvalid);
});

test("widget refresh scheduler returns deterministic due sets across an injected clock sequence", () => {
  const first = schedulerFixture();
  const second = schedulerFixture();
  const times = Object.freeze([0, 4_999, 5_000, 60_000, 900_000]);
  const firstDue = tickSequence(first.vm, times);
  const secondDue = tickSequence(second.vm, times);

  assert.deepEqual(secondDue, firstDue);
  assert.deepEqual(firstDue, [
    [first.clock.id, first.stats.id, first.weather.id],
    [],
    [first.stats.id],
    [first.clock.id, first.stats.id],
    [first.clock.id, first.stats.id, first.weather.id],
  ]);
});

test("paused and disabled widgets are excluded from the refresh due set", () => {
  const vm = createWidgetHostModel({
    zones: zones(4, 2),
  });
  const clock = mustAdd(vm, "clock", placement(0, 0));
  const stats = mustAdd(vm, "system-stats", placement(1, 0));
  const initial = vm.tick(0);

  assert.equal(initial.ok, true);
  assert.deepEqual(initial.due, [clock.id, stats.id]);

  const paused = vm.setPaused(stats.id, true);
  const disabled = vm.setEnabled(clock.id, false);

  assert.equal(paused.ok, true);
  assert.equal(disabled.ok, true);

  const excluded = vm.tick(60_000);

  assert.equal(excluded.ok, true);
  assert.deepEqual(excluded.due, []);

  const reenabled = vm.setEnabled(clock.id, true);

  assert.equal(reenabled.ok, true);

  const clockDue = vm.tick(60_000);

  assert.equal(clockDue.ok, true);
  assert.deepEqual(clockDue.due, [clock.id]);

  const resumed = vm.setPaused(stats.id, false);

  assert.equal(resumed.ok, true);

  const statsDue = vm.tick(60_000);

  assert.equal(statsDue.ok, true);
  assert.deepEqual(statsDue.due, [stats.id]);
});

test("widget host state is frozen and transitions are host-free", () => {
  const originalDateNow = Date.now;
  let ambientClockReads = 0;
  const ports: WidgetHostPorts = Object.freeze({
    get package(): never {
      throw new Error("host port should not be read by the widget host model");
    },
  });

  Date.now = () => {
    ambientClockReads += 1;
    throw new Error("ambient clock should not be read");
  };

  try {
    const vm = createWidgetHostModel({
      ports,
      zones: zones(4, 2),
    });
    const added = vm.add("clock");

    assert.equal(Object.isFrozen(vm), true);
    assert.equal(added.ok, true);
    if (!added.ok) {
      assert.fail("expected add to succeed");
    }

    assertFrozenState(added.state);

    const firstState = added.state;
    const firstPlacement = firstState.instances[0]?.placement;

    assert.deepEqual(firstPlacement, placement(0, 0));

    const moved = vm.move(added.instance.id, placement(2, 0));

    assert.equal(moved.ok, true);
    assert.notEqual(moved.state, firstState);
    assert.deepEqual(firstState.instances[0]?.placement, firstPlacement);
    assert.deepEqual(moved.state.instances[0]?.placement, placement(2, 0));
    assertFrozenState(moved.state);

    const ticked = vm.tick(0);

    assert.equal(ticked.ok, true);
    assert.deepEqual(ticked.due, [added.instance.id]);
    assert.equal(ambientClockReads, 0);
  } finally {
    Date.now = originalDateNow;
  }
});

test("invalid placement objects reject without invoking accessors", () => {
  const vm = createWidgetHostModel({
    zones: zones(4, 2),
  });
  const clock = mustAdd(vm, "clock", placement(0, 0));
  const before = vm.snapshot();
  let getterReads = 0;
  const hostile: Record<string, unknown> = {
    column: 1,
    row: 0,
  };

  Object.defineProperty(hostile, "zone", {
    enumerable: true,
    get() {
      getterReads += 1;
      return "desktop";
    },
  });

  const moved = vm.move(clock.id, hostile);

  assert.equal(moved.ok, false);
  if (moved.ok) {
    assert.fail("expected accessor placement to fail closed");
  }
  assert.equal(moved.error.code, "INVALID_PLACEMENT");
  assert.equal(getterReads, 0);
  assert.equal(moved.state, before);
  assert.equal(vm.snapshot(), before);
});

function zones(columns: number, rows: number): readonly WidgetHostZone[] {
  return Object.freeze([
    Object.freeze({
      columns,
      id: "desktop",
      rows,
    }),
  ]);
}

function placement(column: number, row: number): WidgetPlacement {
  return Object.freeze({
    column,
    row,
    zone: "desktop",
  });
}

function mustAdd(vm: WidgetHostModel, kind: string, at: WidgetPlacement): WidgetInstance {
  const added = vm.add(kind, at);

  if (!added.ok) {
    assert.fail(`expected ${kind} add to succeed: ${added.error.message}`);
  }
  assert.equal(added.ok, true);

  return added.instance;
}

function assertNoOverlaps(state: WidgetHostState): void {
  for (let leftIndex = 0; leftIndex < state.instances.length; leftIndex += 1) {
    const left = state.instances[leftIndex];

    if (left === undefined) {
      continue;
    }

    for (let rightIndex = leftIndex + 1; rightIndex < state.instances.length; rightIndex += 1) {
      const right = state.instances[rightIndex];

      if (right !== undefined) {
        assert.equal(widgetInstancesOverlap(left, right), false, `${left.id} overlaps ${right.id}`);
      }
    }
  }
}

function instanceIds(state: WidgetHostState): readonly string[] {
  return Object.freeze(state.instances.map((instance) => instance.id));
}

interface SchedulerFixture {
  readonly clock: WidgetInstance;
  readonly stats: WidgetInstance;
  readonly vm: WidgetHostModel;
  readonly weather: WidgetInstance;
}

function schedulerFixture(): SchedulerFixture {
  const vm = createWidgetHostModel({
    zones: zones(6, 3),
  });

  return Object.freeze({
    clock: mustAdd(vm, "clock", placement(0, 0)),
    stats: mustAdd(vm, "system-stats", placement(1, 0)),
    vm,
    weather: mustAdd(vm, "weather", placement(2, 0)),
  });
}

function tickSequence(vm: WidgetHostModel, times: readonly number[]): readonly (readonly string[])[] {
  const output: (readonly string[])[] = [];

  for (let index = 0; index < times.length; index += 1) {
    const time = times[index];

    if (time === undefined) {
      continue;
    }

    const ticked = vm.tick(time);

    assert.equal(ticked.ok, true);
    if (!ticked.ok) {
      assert.fail(`expected tick(${time}) to succeed`);
    }

    output.push(ticked.due);
  }

  return Object.freeze(output);
}

function assertFrozenState(state: WidgetHostState): void {
  assert.equal(Object.isFrozen(state), true);
  assert.equal(Object.isFrozen(state.descriptors), true);
  assert.equal(Object.isFrozen(state.descriptors[0]), true);
  assert.equal(Object.isFrozen(state.descriptors[0]?.allowedSizeClasses), true);
  assert.equal(Object.isFrozen(state.grid), true);
  assert.equal(Object.isFrozen(state.grid.zones), true);
  assert.equal(Object.isFrozen(state.grid.zones[0]), true);
  assert.equal(Object.isFrozen(state.instances), true);
  assert.equal(Object.isFrozen(state.instances[0]), true);
  assert.equal(Object.isFrozen(state.instances[0]?.placement), true);
  assert.equal(Object.isFrozen(state.refreshSchedule), true);
  assert.equal(Object.isFrozen(state.refreshSchedule[0]), true);
}
