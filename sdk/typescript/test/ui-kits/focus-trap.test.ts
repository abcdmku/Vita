import assert from "node:assert/strict";
import { test } from "node:test";

import {
  createFocusTrapViewModel,
} from "../../../../ui_kits/desktop/viewmodels/focus-trap.ts";

test("focus trap activates on the configured initial id and cycles Tab forward", () => {
  const vm = createFocusTrapViewModel({
    ids: ["first", "second", "third"],
    initialId: "second",
  });

  const activated = vm.activate({
    restoreId: "launcher-button",
  });

  assert.equal(activated.active, true);
  assert.equal(activated.focusedId, "second");
  assert.equal(activated.restoreId, "launcher-button");

  assert.equal(vm.onKey("Tab").focusedId, "third");
  assert.equal(vm.onKey("Tab").focusedId, "first");
  assert.equal(vm.onKey({
    key: "Tab",
  }).focusedId, "second");
});

test("focus trap cycles Shift+Tab backward and wraps at the start", () => {
  const vm = createFocusTrapViewModel(["first", "second", "third"]);

  assert.equal(vm.activate({
    currentFocusId: "before-dialog",
  }).focusedId, "first");
  assert.equal(vm.onKey("Shift+Tab").focusedId, "third");
  assert.equal(vm.onKey({
    key: "Tab",
    shiftKey: true,
  }).focusedId, "second");
  assert.equal(vm.onKey("Shift+Tab").focusedId, "first");

  const restoreId = vm.deactivate();

  assert.equal(restoreId, "before-dialog");
  assert.deepEqual(vm.snapshot(), {
    active: false,
    focusedId: null,
    ids: ["first", "second", "third"],
    restoreId: null,
  });
});

test("deactivate returns null when no restore target was captured", () => {
  const vm = createFocusTrapViewModel({
    ids: ["only"],
  });

  assert.equal(vm.activate().focusedId, "only");
  assert.equal(vm.deactivate(), null);
  assert.equal(vm.deactivate(), null);
});

test("focus trap malformed and hostile input fails closed without mutation", () => {
  const empty = createFocusTrapViewModel({
    ids: [],
  });
  const badInitial = createFocusTrapViewModel({
    ids: ["one"],
    initialId: "missing",
  });

  assert.equal(empty.activate().active, false);
  assert.deepEqual(empty.snapshot().ids, []);
  assert.deepEqual(badInitial.snapshot().ids, []);

  const shadowedIds = ["one", "two"];

  Object.defineProperty(shadowedIds, "some", {
    enumerable: true,
    value() {
      assert.fail("shadowed array method must not be called");
    },
  });

  assert.deepEqual(createFocusTrapViewModel(shadowedIds).snapshot().ids, []);

  const vm = createFocusTrapViewModel({
    ids: ["one", "two"],
  });
  const activated = vm.activate({
    restoreId: "restore",
  });
  const before = project(activated);
  let optionReads = 0;
  const hostileOptions: Record<string, unknown> = {};

  Object.defineProperty(hostileOptions, "initialId", {
    enumerable: true,
    get() {
      optionReads += 1;
      return "two";
    },
  });

  assert.doesNotThrow(() => vm.activate(hostileOptions));
  assert.equal(optionReads, 0);
  assert.deepEqual(project(vm.snapshot()), before);

  let keyReads = 0;
  const hostileKey: Record<string, unknown> = {
    shiftKey: false,
  };

  Object.defineProperty(hostileKey, "key", {
    enumerable: true,
    get() {
      keyReads += 1;
      return "Tab";
    },
  });

  assert.doesNotThrow(() => vm.onKey(hostileKey));
  assert.equal(keyReads, 0);
  assert.deepEqual(project(vm.snapshot()), before);
});

function project(state: ReturnType<ReturnType<typeof createFocusTrapViewModel>["snapshot"]>): {
  readonly active: boolean;
  readonly focusedId: string | null;
  readonly ids: readonly string[];
  readonly restoreId: string | null;
} {
  return {
    active: state.active,
    focusedId: state.focusedId,
    ids: state.ids,
    restoreId: state.restoreId,
  };
}
