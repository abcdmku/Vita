import assert from "node:assert/strict";
import { test } from "node:test";

import {
  applyAppSwitcherWindowManagerIntents,
  buildAppSwitcherMruWindowIds,
  createAppSwitcherViewModel,
} from "../../../../ui_kits/desktop/viewmodels/app-switcher.ts";
import type {
  AppSwitcherWindowManagerIntent,
  AppSwitcherWindowManagerPort,
  AppSwitcherWindowManagerPortResult,
} from "../../../../ui_kits/desktop/viewmodels/app-switcher.ts";
import type {
  Rect,
  WindowModel,
  WindowState,
  WorkspaceLayoutMode,
  WorkspaceState,
} from "../../src/desktop-sdk/index.ts";

const SOURCE_RECT = Object.freeze({
  height: 480,
  width: 640,
  x: 0,
  y: 0,
}) satisfies Rect;

test("MRU order is derived from focusStack first, then non-focused windows by stable id, and updates on WM focus changes", () => {
  const port = new FakeAppSwitcherWindowManagerPort(rawModel(
    ["window:d", "window:b", "window:c", "window:a"],
    ["window:c", "window:a"],
  ));
  const vm = createAppSwitcherViewModel({
    wm: port,
  });

  const first = vm.snapshot();

  assert.equal(Object.isFrozen(first), true);
  assert.equal(Object.isFrozen(first.entries), true);
  assert.equal(Object.isFrozen(first.entries[0]), true);
  assert.deepEqual(first.mruWindowIds, ["window:c", "window:a", "window:b", "window:d"]);
  assert.deepEqual(first.entries.map((entry) => entry.windowId), first.mruWindowIds);
  assert.equal(first.entries[0]?.focused, true);
  assert.equal(first.entries[0]?.highlighted, false);

  port.setModel(rawModel(
    ["window:d", "window:b", "window:c", "window:a"],
    ["window:d", "window:c", "window:a"],
  ));

  const updated = vm.snapshot();

  assert.deepEqual(updated.mruWindowIds, ["window:d", "window:c", "window:a", "window:b"]);
  assert.equal(updated.entries[0]?.focused, true);
  assert.equal(updated.entries[0]?.windowId, "window:d");
});

test("begin preselects the next MRU window and commit emits one focus intent through the WM port", () => {
  const port = new FakeAppSwitcherWindowManagerPort(rawModel(
    ["window:a", "window:b", "window:c"],
    ["window:a", "window:b", "window:c"],
  ));
  const vm = createAppSwitcherViewModel({
    wm: port,
  });

  const begun = vm.begin();

  assert.equal(begun.ok, true);
  assert.equal(begun.state.open, true);
  assert.equal(begun.state.originalWindowId, "window:a");
  assert.equal(begun.state.highlightedWindowId, "window:b");
  assert.equal(begun.state.highlightedIndex, 1);
  assert.deepEqual(begun.intents, []);

  const committed = vm.commit();

  assert.equal(committed.ok, true);
  assert.equal(committed.state.open, false);
  assert.deepEqual(committed.intents, [
    {
      type: "focus",
      windowId: "window:b",
    },
  ]);
  assert.deepEqual(port.intents, committed.intents);
  assert.equal(port.model.focusStack[0], "window:b");
  assert.deepEqual(committed.state.mruWindowIds.slice(0, 3), ["window:b", "window:a", "window:c"]);
});

test("cycleForward and cycleBack wrap the highlighted window deterministically", () => {
  const port = new FakeAppSwitcherWindowManagerPort(rawModel(
    ["window:a", "window:b", "window:c"],
    ["window:a", "window:b", "window:c"],
  ));
  const vm = createAppSwitcherViewModel({
    wm: port,
  });

  assert.equal(vm.begin().state.highlightedWindowId, "window:b");
  assert.equal(vm.cycleForward().state.highlightedWindowId, "window:c");
  assert.equal(vm.cycleForward().state.highlightedWindowId, "window:a");
  assert.equal(vm.cycleForward().state.highlightedWindowId, "window:b");
  assert.equal(vm.cycleBack().state.highlightedWindowId, "window:a");
  assert.equal(vm.cycleBack().state.highlightedWindowId, "window:c");
  assert.deepEqual(port.intents, []);
});

test("cancel closes the session without emitting a focus intent or changing WM focus", () => {
  const port = new FakeAppSwitcherWindowManagerPort(rawModel(
    ["window:a", "window:b", "window:c"],
    ["window:a", "window:b", "window:c"],
  ));
  const vm = createAppSwitcherViewModel({
    wm: port,
  });

  assert.equal(vm.begin().state.highlightedWindowId, "window:b");
  assert.equal(vm.cycleForward().state.highlightedWindowId, "window:c");

  const cancelled = vm.cancel();

  assert.equal(cancelled.ok, true);
  assert.equal(cancelled.state.open, false);
  assert.equal(cancelled.state.highlightedWindowId, null);
  assert.equal(cancelled.state.originalWindowId, null);
  assert.deepEqual(cancelled.intents, []);
  assert.deepEqual(port.intents, []);
  assert.equal(port.model.focusStack[0], "window:a");
});

test("zero-window, single-window, and no-session edge cases fail closed without spurious intents", () => {
  const emptyPort = new FakeAppSwitcherWindowManagerPort(rawModel([], []));
  const emptyVm = createAppSwitcherViewModel({
    wm: emptyPort,
  });
  const emptyBegin = emptyVm.begin();

  assert.equal(emptyBegin.ok, false);
  if (emptyBegin.ok) {
    assert.fail("expected empty begin to fail closed");
  }
  assert.equal(emptyBegin.error.code, "EMPTY_WINDOW_MODEL");
  assert.equal(emptyBegin.state.open, false);
  assert.deepEqual(emptyBegin.intents, []);
  assert.deepEqual(emptyPort.intents, []);

  const cycleWithoutSession = emptyVm.cycleForward();

  assert.equal(cycleWithoutSession.ok, false);
  if (cycleWithoutSession.ok) {
    assert.fail("expected cycle without session to fail closed");
  }
  assert.equal(cycleWithoutSession.error.code, "NO_ACTIVE_SESSION");

  const commitWithoutSession = emptyVm.commit();

  assert.equal(commitWithoutSession.ok, false);
  if (commitWithoutSession.ok) {
    assert.fail("expected commit without session to fail closed");
  }
  assert.equal(commitWithoutSession.error.code, "NO_ACTIVE_SESSION");

  const cancelWithoutSession = emptyVm.cancel();

  assert.equal(cancelWithoutSession.ok, false);
  if (cancelWithoutSession.ok) {
    assert.fail("expected cancel without session to fail closed");
  }
  assert.equal(cancelWithoutSession.error.code, "NO_ACTIVE_SESSION");

  const singlePort = new FakeAppSwitcherWindowManagerPort(rawModel(["window:solo"], ["window:solo"]));
  const singleVm = createAppSwitcherViewModel({
    wm: singlePort,
  });
  const singleBegin = singleVm.begin();

  assert.equal(singleBegin.ok, true);
  assert.equal(singleBegin.state.open, true);
  assert.equal(singleBegin.state.highlightedWindowId, "window:solo");

  const singleCommit = singleVm.commit();

  assert.equal(singleCommit.ok, true);
  assert.equal(singleCommit.state.open, false);
  assert.deepEqual(singleCommit.intents, []);
  assert.deepEqual(singlePort.intents, []);
  assert.equal(singlePort.model.focusStack[0], "window:solo");
});

test("WM read and apply failures are returned as ok:false errors without crashing", () => {
  const readPort = new FakeAppSwitcherWindowManagerPort(rawModel(
    ["window:a", "window:b"],
    ["window:a", "window:b"],
  ));
  const readVm = createAppSwitcherViewModel({
    wm: readPort,
  });

  readPort.failRead = true;

  const readFailed = readVm.begin();

  assert.equal(readFailed.ok, false);
  if (readFailed.ok) {
    assert.fail("expected read failure to fail closed");
  }
  assert.equal(readFailed.error.code, "WM_READ_FAILED");
  assert.equal(readFailed.state.open, false);

  const throwingReadPort = new FakeAppSwitcherWindowManagerPort(rawModel(
    ["window:a", "window:b"],
    ["window:a", "window:b"],
  ));
  const throwingReadVm = createAppSwitcherViewModel({
    initialModel: throwingReadPort.model,
    wm: throwingReadPort,
  });

  throwingReadPort.throwRead = true;

  const readThrown = throwingReadVm.begin();

  assert.equal(readThrown.ok, false);
  if (readThrown.ok) {
    assert.fail("expected thrown read to fail closed");
  }
  assert.equal(readThrown.error.code, "WM_READ_FAILED");
  assert.equal(readThrown.error.message, "configured read throw");

  const applyRejectPort = new FakeAppSwitcherWindowManagerPort(rawModel(
    ["window:a", "window:b"],
    ["window:a", "window:b"],
  ));
  const applyRejectVm = createAppSwitcherViewModel({
    wm: applyRejectPort,
  });

  assert.equal(applyRejectVm.begin().ok, true);
  applyRejectPort.failApply = true;

  const applyRejected = applyRejectVm.commit();

  assert.equal(applyRejected.ok, false);
  if (applyRejected.ok) {
    assert.fail("expected apply rejection to fail closed");
  }
  assert.equal(applyRejected.error.code, "WM_INTENT_FAILED");
  assert.equal(applyRejected.state.open, true);
  assert.deepEqual(applyRejected.intents, []);
  assert.deepEqual(applyRejectPort.intents, []);
  assert.equal(applyRejectPort.model.focusStack[0], "window:a");

  const applyThrowPort = new FakeAppSwitcherWindowManagerPort(rawModel(
    ["window:a", "window:b"],
    ["window:a", "window:b"],
  ));
  const applyThrowVm = createAppSwitcherViewModel({
    wm: applyThrowPort,
  });

  assert.equal(applyThrowVm.begin().ok, true);
  applyThrowPort.throwApply = true;

  const applyThrown = applyThrowVm.commit();

  assert.equal(applyThrown.ok, false);
  if (applyThrown.ok) {
    assert.fail("expected thrown apply to fail closed");
  }
  assert.equal(applyThrown.error.code, "WM_INTENT_FAILED");
  assert.equal(applyThrown.error.message, "configured apply throw");
  assert.equal(applyThrown.state.open, true);
  assert.deepEqual(applyThrowPort.intents, []);
  assert.equal(applyThrowPort.model.focusStack[0], "window:a");
});

test("pure MRU helper ignores stale focus ids and de-duplicates focusStack entries", () => {
  const model = rawModel(
    ["window:c", "window:a", "window:b"],
    ["window:missing", "window:b", "window:b"],
  );

  assert.deepEqual(buildAppSwitcherMruWindowIds(model), ["window:b", "window:a", "window:c"]);
});

function rawModel(
  windowIds: readonly string[],
  focusStack: readonly string[],
): WindowModel {
  const windows = windowIds.map((windowId, index) => windowState(
    windowId,
    index % 2 === 0 ? "workspace-1" : "workspace-2",
    index,
  ));

  return Object.freeze({
    activeWorkspaceId: "workspace-1",
    focusStack: Object.freeze([...focusStack]),
    windows: Object.freeze(windows),
    workspaces: Object.freeze([
      workspace("workspace-1", "tile"),
      workspace("workspace-2", "grid"),
    ]),
  }) satisfies WindowModel;
}

function workspace(id: string, layout: WorkspaceLayoutMode): WorkspaceState {
  return Object.freeze({
    id,
    layout,
  });
}

function windowState(id: string, workspaceId: string, order: number): WindowState {
  return Object.freeze({
    id,
    maximized: false,
    minimized: false,
    mode: "tiled",
    order,
    rect: SOURCE_RECT,
    textureId: `texture:${id}`,
    workspaceId,
  });
}

class FakeAppSwitcherWindowManagerPort implements AppSwitcherWindowManagerPort {
  failApply = false;
  failRead = false;
  intents: AppSwitcherWindowManagerIntent[] = [];
  throwApply = false;
  throwRead = false;
  #model: WindowModel;

  constructor(model: WindowModel) {
    this.#model = model;
  }

  get model(): WindowModel {
    return this.#model;
  }

  setModel(model: WindowModel): void {
    this.#model = model;
  }

  readWindowModel(): AppSwitcherWindowManagerPortResult<WindowModel> {
    if (this.throwRead) {
      throw new Error("configured read throw");
    }
    if (this.failRead) {
      return rejectPort("READ_FAILED", "configured read failure", "/fake/read");
    }

    return acceptPort(this.#model);
  }

  applyWindowManagerIntents(
    intents: readonly AppSwitcherWindowManagerIntent[],
  ): AppSwitcherWindowManagerPortResult<WindowModel> {
    if (this.throwApply) {
      throw new Error("configured apply throw");
    }
    if (this.failApply) {
      return rejectPort("APPLY_FAILED", "configured apply failure", "/fake/apply");
    }

    this.intents.push(...intents);
    this.#model = applyAppSwitcherWindowManagerIntents(this.#model, intents);

    return acceptPort(this.#model);
  }
}

function acceptPort<T>(value: T): AppSwitcherWindowManagerPortResult<T> {
  return Object.freeze({
    ok: true,
    value,
  });
}

function rejectPort<T>(
  code: string,
  message: string,
  path: string,
): AppSwitcherWindowManagerPortResult<T> {
  return Object.freeze({
    error: Object.freeze({
      code,
      message,
      path,
    }),
    ok: false,
  });
}
