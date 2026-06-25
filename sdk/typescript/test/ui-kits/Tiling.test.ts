import assert from "node:assert/strict";
import { test } from "node:test";

import {
  TILING_LAYOUT_ORDER,
  TILING_PANES,
  createTilingViewModel,
} from "../../../../ui_kits/desktop/viewmodels/Tiling.ts";
import type {
  TilingWindowManagerPort,
} from "../../../../ui_kits/desktop/viewmodels/Tiling.ts";
import type {
  Rect,
  WindowManagerIntent,
} from "../../src/desktop-sdk/index.ts";

const EDITOR_RECT = Object.freeze({
  height: 702,
  width: 596,
  x: 64,
  y: 56,
}) satisfies Rect;

const EXPLORER_RECT = Object.freeze({
  height: 347,
  width: 596,
  x: 668,
  y: 56,
}) satisfies Rect;

const SYSTEM_RECT = Object.freeze({
  height: 347,
  width: 596,
  x: 668,
  y: 411,
}) satisfies Rect;

test("initial tiling state exposes deterministic panes, placements, workspace, and status bar", () => {
  const calls: WindowManagerIntent[] = [];
  const vm = createTilingViewModel({
    wm: fakeWm(calls),
  });

  const first = vm.snapshot();
  const second = vm.snapshot();

  assert.deepEqual(projectState(second), projectState(first));
  assert.deepEqual(first.panes.map((pane) => pane.id), ["editor", "explorer", "system"]);
  assert.equal(first.activePaneId, "editor");
  assert.equal(first.activeWorkspaceId, "workspace-1");
  assert.equal(first.layout, "tile");
  assert.equal(first.statusBar.branch, "main");
  assert.equal(first.statusBar.path, "~/vita/src/kernel.ts");
  assert.equal(first.statusBar.workspaceSummary, "ws 1/5");
  assert.equal(first.statusBar.intentCount, 0);
  assert.deepEqual(projectPaneRects(first), {
    editor: EDITOR_RECT,
    explorer: EXPLORER_RECT,
    system: SYSTEM_RECT,
  });
  assert.deepEqual(calls, []);
});

test("focusPane emits a WM focus intent and updates status fields", () => {
  const calls: WindowManagerIntent[] = [];
  const vm = createTilingViewModel({
    wm: fakeWm(calls),
  });

  const focused = vm.focusPane("explorer");

  assert.equal(focused.ok, true);
  assert.deepEqual(focused.intents, [
    {
      type: "setFocus",
      windowId: TILING_PANES[1]?.windowId,
    },
  ]);
  assert.deepEqual(calls, focused.intents);
  assert.equal(focused.state.activePaneId, "explorer");
  assert.equal(focused.state.statusBar.focusedPaneId, "explorer");
  assert.equal(focused.state.statusBar.path, "~/vita/src");
  assert.deepEqual(focused.state.statusBar.lastIntentTypes, ["setFocus"]);

  calls.length = 0;
  const before = projectState(vm.snapshot());
  const rejected = vm.focusPane("missing");

  assert.equal(rejected.ok, false);
  if (rejected.ok) {
    assert.fail("expected invalid pane to fail closed");
  }
  assert.equal(rejected.error.code, "INVALID_PANE");
  assert.deepEqual(calls, []);
  assert.deepEqual(projectState(rejected.state), before);
});

test("cycleLayout uses the public WM layout order and emits deterministic reposition intents", () => {
  const firstCalls: WindowManagerIntent[] = [];
  const firstVm = createTilingViewModel({
    wm: fakeWm(firstCalls),
  });
  const secondCalls: WindowManagerIntent[] = [];
  const secondVm = createTilingViewModel({
    wm: fakeWm(secondCalls),
  });

  const first = firstVm.cycleLayout();
  const second = secondVm.cycleLayout();

  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  assert.equal(first.state.layout, TILING_LAYOUT_ORDER[1]);
  assert.equal(first.state.statusBar.layout, "columns");
  assert.deepEqual(projectState(first.state), projectState(second.state));
  assert.deepEqual(first.intents, second.intents);
  assert.deepEqual(firstCalls, secondCalls);
  assert.deepEqual(first.intents.map((intent) => intent.type), [
    "repositionTexture",
    "repositionTexture",
    "repositionTexture",
  ]);

  assert.equal(firstVm.cycleLayout().state.layout, "grid");
  assert.equal(firstVm.cycleLayout().state.layout, "stack");
  assert.equal(firstVm.cycleLayout().state.layout, "tile");
});

test("splitFocus cycles focus through the tiling ring without repaint intents", () => {
  const calls: WindowManagerIntent[] = [];
  const vm = createTilingViewModel({
    wm: fakeWm(calls),
  });

  const right = vm.splitFocus("right");

  assert.equal(right.ok, true);
  assert.equal(right.state.activePaneId, "explorer");
  assert.deepEqual(right.intents, [
    {
      type: "setFocus",
      windowId: TILING_PANES[1]?.windowId,
    },
  ]);

  const left = vm.splitFocus("left");

  assert.equal(left.ok, true);
  assert.equal(left.state.activePaneId, "editor");
  assert.deepEqual(left.intents, [
    {
      type: "setFocus",
      windowId: TILING_PANES[0]?.windowId,
    },
  ]);
  assert.equal(calls.map((call): string => call.type).includes("repaintTexture"), false);
});

test("moveWindow repositions the focused pane through SDK WM intents and reads back layout", () => {
  const calls: WindowManagerIntent[] = [];
  const vm = createTilingViewModel({
    wm: fakeWm(calls),
  });
  const rect = Object.freeze({
    height: 240,
    width: 360,
    x: 120,
    y: 144,
  }) satisfies Rect;

  const moved = vm.moveWindow({
    rect,
    type: "move",
  });

  assert.equal(moved.ok, true);
  assert.equal(moved.state.activePaneId, "editor");
  assert.equal(moved.state.panes[0]?.mode, "floating");
  assert.deepEqual(moved.state.panes[0]?.rect, rect);
  assert.deepEqual(repositionFor(moved.intents, TILING_PANES[0]?.windowId ?? ""), {
    rect,
    textureId: TILING_PANES[0]?.textureId,
    type: "repositionTexture",
    windowId: TILING_PANES[0]?.windowId,
  });
  assert.deepEqual(calls, moved.intents);
  assert.equal(moved.state.statusBar.intentCount, moved.intents.length);
});

test("moveWindow can move an explicit pane to a known workspace and rejects unknown workspaces", () => {
  const calls: WindowManagerIntent[] = [];
  const vm = createTilingViewModel({
    wm: fakeWm(calls),
  });

  const moved = vm.moveWindow({
    paneId: "system",
    type: "moveToWorkspace",
    workspaceId: "workspace-2",
  });

  assert.equal(moved.ok, true);
  assert.equal(moved.state.panes[2]?.workspaceId, "workspace-2");
  assert.equal(moved.state.panes[2]?.visible, false);
  assert.deepEqual(moved.intents.map((intent) => intent.type), [
    "setTextureVisibility",
    "repositionTexture",
  ]);

  calls.length = 0;
  const before = projectState(vm.snapshot());
  const rejected = vm.moveWindow({
    paneId: "system",
    type: "moveToWorkspace",
    workspaceId: "workspace-404",
  });

  assert.equal(rejected.ok, false);
  if (rejected.ok) {
    assert.fail("expected unknown workspace to fail closed");
  }
  assert.equal(rejected.error.code, "UNKNOWN_WORKSPACE");
  assert.deepEqual(calls, []);
  assert.deepEqual(projectState(rejected.state), before);
});

test("invalid action inputs fail closed without reading accessors or mutating state", () => {
  const calls: WindowManagerIntent[] = [];
  const vm = createTilingViewModel({
    wm: fakeWm(calls),
  });
  const before = projectState(vm.snapshot());

  const badDirection = vm.splitFocus("diagonal");

  assert.equal(badDirection.ok, false);
  if (badDirection.ok) {
    assert.fail("expected invalid direction to fail closed");
  }
  assert.equal(badDirection.error.code, "INVALID_DIRECTION");

  const zeroRect = vm.moveWindow({
    rect: {
      height: 100,
      width: 0,
      x: 0,
      y: 0,
    },
    type: "move",
  });

  assert.equal(zeroRect.ok, false);
  if (zeroRect.ok) {
    assert.fail("expected invalid rect to fail closed");
  }
  assert.equal(zeroRect.error.code, "INVALID_MOVE_INTENT");

  let getterReads = 0;
  const hostile: Record<string, unknown> = {
    rect: {
      height: 100,
      width: 100,
      x: 0,
      y: 0,
    },
  };

  Object.defineProperty(hostile, "type", {
    enumerable: true,
    get() {
      getterReads += 1;
      return "move";
    },
  });

  const accessor = vm.moveWindow(hostile);

  assert.equal(accessor.ok, false);
  if (accessor.ok) {
    assert.fail("expected accessor intent to fail closed");
  }
  assert.equal(accessor.error.code, "INVALID_MOVE_INTENT");
  assert.equal(getterReads, 0);
  assert.deepEqual(calls, []);
  assert.deepEqual(projectState(vm.snapshot()), before);
});

test("WM port failures leave the view-model state unchanged", () => {
  const calls: WindowManagerIntent[] = [];
  const vm = createTilingViewModel({
    wm: throwingWm(calls),
  });
  const before = projectState(vm.snapshot());

  const focused = vm.focusPane("explorer");

  assert.equal(focused.ok, false);
  if (focused.ok) {
    assert.fail("expected WM failure to fail closed");
  }
  assert.equal(focused.error.code, "WM_INTENT_FAILED");
  assert.deepEqual(focused.intents, []);
  assert.deepEqual(projectState(focused.state), before);
  assert.deepEqual(projectState(vm.snapshot()), before);
  assert.deepEqual(calls, [
    {
      type: "setFocus",
      windowId: TILING_PANES[1]?.windowId,
    },
  ]);
});

function projectState(state: ReturnType<ReturnType<typeof createTilingViewModel>["snapshot"]>) {
  return {
    activePaneId: state.activePaneId,
    activeWorkspaceId: state.activeWorkspaceId,
    layout: state.layout,
    panes: state.panes.map((pane) => ({
      focused: pane.focused,
      id: pane.id,
      mode: pane.mode,
      rect: pane.rect,
      visible: pane.visible,
      workspaceId: pane.workspaceId,
      zIndex: pane.zIndex,
    })),
    statusBar: {
      activeWorkspaceIndex: state.statusBar.activeWorkspaceIndex,
      branch: state.statusBar.branch,
      focusedPaneId: state.statusBar.focusedPaneId,
      info: state.statusBar.info,
      intentCount: state.statusBar.intentCount,
      lastIntentTypes: state.statusBar.lastIntentTypes,
      layout: state.statusBar.layout,
      path: state.statusBar.path,
      workspaceSummary: state.statusBar.workspaceSummary,
    },
  };
}

function projectPaneRects(state: ReturnType<ReturnType<typeof createTilingViewModel>["snapshot"]>) {
  return {
    editor: state.panes[0]?.rect,
    explorer: state.panes[1]?.rect,
    system: state.panes[2]?.rect,
  };
}

function repositionFor(
  intents: readonly WindowManagerIntent[],
  windowId: string,
): Extract<WindowManagerIntent, { readonly type: "repositionTexture" }> | null {
  for (let index = 0; index < intents.length; index += 1) {
    const intent = intents[index];

    if (intent !== undefined && intent.type === "repositionTexture" && intent.windowId === windowId) {
      return intent;
    }
  }

  return null;
}

function fakeWm(calls: WindowManagerIntent[]): TilingWindowManagerPort {
  return {
    repositionTexture(textureId, rect, windowId): void {
      calls.push(Object.freeze({
        rect,
        textureId,
        type: "repositionTexture",
        windowId,
      }));
    },
    setFocus(windowId): void {
      calls.push(Object.freeze({
        type: "setFocus",
        windowId,
      }));
    },
    setTextureVisibility(textureId, visible, windowId): void {
      calls.push(Object.freeze({
        textureId,
        type: "setTextureVisibility",
        visible,
        windowId,
      }));
    },
  };
}

function throwingWm(calls: WindowManagerIntent[]): TilingWindowManagerPort {
  return {
    repositionTexture(textureId, rect, windowId): void {
      calls.push(Object.freeze({
        rect,
        textureId,
        type: "repositionTexture",
        windowId,
      }));
      throw new Error("configured WM failure");
    },
    setFocus(windowId): void {
      calls.push(Object.freeze({
        type: "setFocus",
        windowId,
      }));
      throw new Error("configured WM failure");
    },
    setTextureVisibility(textureId, visible, windowId): void {
      calls.push(Object.freeze({
        textureId,
        type: "setTextureVisibility",
        visible,
        windowId,
      }));
      throw new Error("configured WM failure");
    },
  };
}
