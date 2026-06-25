import assert from "node:assert/strict";
import { test } from "node:test";

import {
  createFocusRingViewModel,
} from "../../../../ui_kits/desktop/viewmodels/focus-ring.ts";
import type {
  FocusRingState,
} from "../../../../ui_kits/desktop/viewmodels/focus-ring.ts";

test("horizontal focus ring handles arrows, tab, home, end, pages, and wrap", () => {
  const vm = createFocusRingViewModel({
    ids: ["one", "two", "three"],
    orientation: "horizontal",
    wrap: true,
  });

  assert.equal(vm.snapshot().activeId, "one");
  assertTabInvariant(vm.snapshot());

  assert.equal(vm.onKey("ArrowRight").activeId, "two");
  assertTabInvariant(vm.snapshot());
  assert.equal(vm.onKey("Tab").activeId, "three");
  assertTabInvariant(vm.snapshot());
  assert.equal(vm.onKey("ArrowRight").activeId, "one");
  assertTabInvariant(vm.snapshot());
  assert.equal(vm.onKey("Shift+Tab").activeId, "three");
  assertTabInvariant(vm.snapshot());
  assert.equal(vm.onKey("Home").activeId, "one");
  assertTabInvariant(vm.snapshot());
  assert.equal(vm.onKey("End").activeId, "three");
  assertTabInvariant(vm.snapshot());
  assert.equal(vm.onKey("PageUp").activeId, "two");
  assertTabInvariant(vm.snapshot());
  assert.equal(vm.onKey("PageDown").activeId, "three");
  assertTabInvariant(vm.snapshot());

  assert.deepEqual(tabindexes(vm.snapshot()), [
    ["one", -1, false],
    ["two", -1, false],
    ["three", 0, false],
  ]);
});

test("vertical focus ring skips disabled items and can stop without wrap", () => {
  const vm = createFocusRingViewModel({
    disabledIds: ["beta", "gamma"],
    ids: ["alpha", "beta", "gamma", "delta"],
    orientation: "vertical",
    wrap: true,
  });

  assert.equal(vm.onKey("ArrowDown").activeId, "delta");
  assertTabInvariant(vm.snapshot());
  assert.equal(vm.onKey("ArrowDown").activeId, "alpha");
  assertTabInvariant(vm.snapshot());
  assert.equal(vm.onKey("ArrowUp").activeId, "delta");
  assertTabInvariant(vm.snapshot());
  assert.equal(vm.moveFirst().activeId, "alpha");
  assertTabInvariant(vm.snapshot());
  assert.equal(vm.moveLast().activeId, "delta");
  assertTabInvariant(vm.snapshot());

  vm.setItems(["alpha", "delta"], {
    orientation: "vertical",
    wrap: false,
  });

  assert.equal(vm.snapshot().activeId, "delta");
  assert.equal(vm.onKey("ArrowDown").activeId, "delta");
  assertTabInvariant(vm.snapshot());
  assert.equal(vm.movePrev().activeId, "alpha");
  assertTabInvariant(vm.snapshot());
  assert.equal(vm.onKey("ArrowUp").activeId, "alpha");
  assertTabInvariant(vm.snapshot());
});

test("grid focus ring moves by configured columns and skips disabled cells", () => {
  const vm = createFocusRingViewModel({
    activeId: "cell-2",
    columns: 3,
    disabledIds: ["cell-5"],
    ids: [
      "cell-1",
      "cell-2",
      "cell-3",
      "cell-4",
      "cell-5",
      "cell-6",
      "cell-7",
      "cell-8",
      "cell-9",
    ],
    orientation: "grid",
    wrap: true,
  });

  assert.equal(vm.onKey("ArrowDown").activeId, "cell-8");
  assertTabInvariant(vm.snapshot());
  assert.equal(vm.onKey("ArrowUp").activeId, "cell-2");
  assertTabInvariant(vm.snapshot());
  assert.equal(vm.onKey("ArrowLeft").activeId, "cell-1");
  assertTabInvariant(vm.snapshot());
  assert.equal(vm.onKey("ArrowLeft").activeId, "cell-9");
  assertTabInvariant(vm.snapshot());
  assert.equal(vm.onKey("ArrowRight").activeId, "cell-1");
  assertTabInvariant(vm.snapshot());
});

test("setItems preserves focus when possible and rejects unknown active ids without mutation", () => {
  const vm = createFocusRingViewModel({
    activeId: "two",
    ids: ["one", "two", "three"],
    orientation: "horizontal",
  });
  const before = project(vm.snapshot());

  vm.setItems(["one", "two", "three"], {
    activeId: "missing",
    orientation: "horizontal",
  });

  assert.deepEqual(project(vm.snapshot()), before);

  vm.setItems(["two", "four"], {
    orientation: "vertical",
    wrap: false,
  });

  assert.equal(vm.snapshot().activeId, "two");
  assert.deepEqual(tabindexes(vm.snapshot()), [
    ["two", 0, false],
    ["four", -1, false],
  ]);
  assertTabInvariant(vm.snapshot());
});

test("focus ring malformed and hostile input fails closed without throwing", () => {
  const badOrientation = createFocusRingViewModel({
    ids: ["one"],
    orientation: "diagonal",
  });
  const badColumns = createFocusRingViewModel({
    columns: 0,
    ids: ["one"],
    orientation: "grid",
  });
  const unknownActive = createFocusRingViewModel({
    activeId: "missing",
    ids: ["one"],
    orientation: "horizontal",
  });

  assert.deepEqual(badOrientation.snapshot().items, []);
  assert.deepEqual(badColumns.snapshot().items, []);
  assert.deepEqual(unknownActive.snapshot().items, []);

  const shadowedIds = ["one", "two"];

  Object.defineProperty(shadowedIds, "includes", {
    enumerable: true,
    value() {
      assert.fail("shadowed array method must not be called");
    },
  });

  assert.deepEqual(createFocusRingViewModel(shadowedIds).snapshot().items, []);

  const vm = createFocusRingViewModel({
    ids: ["one", "two"],
    orientation: "horizontal",
  });
  const before = project(vm.snapshot());
  let reads = 0;
  const hostileKey: Record<string, unknown> = {
    shiftKey: false,
  };

  Object.defineProperty(hostileKey, "key", {
    enumerable: true,
    get() {
      reads += 1;
      return "ArrowRight";
    },
  });

  assert.doesNotThrow(() => vm.onKey(hostileKey));
  assert.equal(reads, 0);
  assert.deepEqual(project(vm.snapshot()), before);
  assertTabInvariant(vm.snapshot());
});

function assertTabInvariant(state: FocusRingState): void {
  const enabled = state.items.filter((item) => !item.disabled);
  const zero = state.items.filter((item) => item.tabindex === 0);

  assert.equal(zero.length, enabled.length === 0 ? 0 : 1);

  if (enabled.length > 0) {
    assert.equal(zero[0]?.id, state.activeId);
  }

  for (let index = 0; index < state.items.length; index += 1) {
    const item = state.items[index];

    if (item === undefined) {
      continue;
    }

    assert.equal(item.tabindex, item.id === state.activeId && !item.disabled ? 0 : -1);
  }
}

function tabindexes(state: FocusRingState): readonly (readonly [string, number, boolean])[] {
  return state.items.map((item) => [item.id, item.tabindex, item.disabled] as const);
}

function project(state: FocusRingState): {
  readonly activeId: string | null;
  readonly columns: number;
  readonly items: readonly (readonly [string, number, boolean])[];
  readonly orientation: string;
  readonly wrap: boolean;
} {
  return {
    activeId: state.activeId,
    columns: state.columns,
    items: tabindexes(state),
    orientation: state.orientation,
    wrap: state.wrap,
  };
}
