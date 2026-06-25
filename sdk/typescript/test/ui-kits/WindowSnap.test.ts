import assert from "node:assert/strict";
import { test } from "node:test";

import {
  WINDOW_SNAP_ZONES,
  createInitialWindowSnapModel,
  createWindowSnapViewModel,
} from "../../../../ui_kits/desktop/viewmodels/window-snap.ts";
import type {
  WindowSnapDisplayPort,
  WindowSnapWindowManagerPort,
} from "../../../../ui_kits/desktop/viewmodels/window-snap.ts";
import {
  createWindowModel,
} from "../../src/desktop-sdk/index.ts";
import type {
  Rect,
  WindowManagerIntent,
  WorkspaceState,
} from "../../src/desktop-sdk/index.ts";

const WINDOW_ID = "window:test:snap";
const TEXTURE_ID = "texture:test:snap";
const WORK_AREA = Object.freeze({
  height: 800,
  width: 1_200,
  x: 0,
  y: 0,
}) satisfies Rect;
const INITIAL_RECT = Object.freeze({
  height: 300,
  width: 500,
  x: 100,
  y: 120,
}) satisfies Rect;
const LEFT_HALF = Object.freeze({
  height: 800,
  width: 600,
  x: 0,
  y: 0,
}) satisfies Rect;
const TOP_LEFT = Object.freeze({
  height: 400,
  width: 600,
  x: 0,
  y: 0,
}) satisfies Rect;
const BOTTOM_HALF = Object.freeze({
  height: 400,
  width: 1_200,
  x: 0,
  y: 400,
}) satisfies Rect;
const BOTTOM_RIGHT = Object.freeze({
  height: 400,
  width: 600,
  x: 600,
  y: 400,
}) satisfies Rect;
const CENTERED = Object.freeze({
  height: 300,
  width: 500,
  x: 350,
  y: 250,
}) satisfies Rect;

test("initial snap state is deterministic and exposes edge and corner zones", () => {
  const calls: WindowManagerIntent[] = [];
  const vm = createVm(calls);

  const first = vm.snapshot();
  const second = vm.snapshot();

  assert.deepEqual(projectState(second), projectState(first));
  assert.equal(first.ready, true);
  assert.equal(first.activeWindowId, WINDOW_ID);
  assert.deepEqual(first.focusedPlacement?.rect, INITIAL_RECT);
  assert.deepEqual(first.workArea, WORK_AREA);
  assert.equal(first.restoreAvailable, false);
  assert.equal(first.intentCount, 0);
  assert.deepEqual(first.zones.map((zone) => zone.id), WINDOW_SNAP_ZONES);
  assert.deepEqual(zoneRect(first, "left-half"), LEFT_HALF);
  assert.deepEqual(zoneRect(first, "top-left"), TOP_LEFT);
  assert.deepEqual(calls, []);
});

test("snapToZone moves the focused window through WM intents and restore returns its prior placement", () => {
  const calls: WindowManagerIntent[] = [];
  const vm = createVm(calls);

  const snapped = vm.snapToZone("left-half");

  assert.equal(snapped.ok, true);
  if (!snapped.ok) {
    assert.fail("expected snapToZone to succeed");
  }
  assert.equal(snapped.command, "left-half");
  assert.deepEqual(snapped.placement?.rect, LEFT_HALF);
  assert.equal(snapped.state.restoreAvailable, true);
  assert.deepEqual(snapped.state.lastIntentTypes, ["repositionTexture"]);
  assert.deepEqual(snapped.intents, [
    {
      rect: LEFT_HALF,
      textureId: TEXTURE_ID,
      type: "repositionTexture",
      windowId: WINDOW_ID,
    },
  ]);
  assert.deepEqual(calls, snapped.intents);

  calls.length = 0;
  const restored = vm.restoreFocused();

  assert.equal(restored.ok, true);
  if (!restored.ok) {
    assert.fail("expected restore to succeed");
  }
  assert.equal(restored.command, "restore");
  assert.deepEqual(restored.placement?.rect, INITIAL_RECT);
  assert.equal(restored.state.restoreAvailable, false);
  assert.deepEqual(restored.intents, [
    {
      rect: INITIAL_RECT,
      textureId: TEXTURE_ID,
      type: "repositionTexture",
      windowId: WINDOW_ID,
    },
  ]);
  assert.deepEqual(calls, restored.intents);
});

test("snapAtPoint and keyboard chords cover corners, halves, maximize, center, and restore", () => {
  const calls: WindowManagerIntent[] = [];
  const vm = createVm(calls);

  const topLeftHit = vm.zoneAtPoint({
    x: 1,
    y: 1,
  });

  assert.equal(topLeftHit.ok, true);
  if (!topLeftHit.ok) {
    assert.fail("expected top-left hit to succeed");
  }
  assert.equal(topLeftHit.zone, "top-left");

  const pointerSnap = vm.snapAtPoint({
    x: 1_199,
    y: 799,
  });

  assert.equal(pointerSnap.ok, true);
  if (!pointerSnap.ok) {
    assert.fail("expected pointer snap to succeed");
  }
  assert.equal(pointerSnap.command, "bottom-right");
  assert.deepEqual(pointerSnap.placement?.rect, BOTTOM_RIGHT);

  const chordCorner = vm.handleKeyboardChord("super+ArrowLeft+ArrowUp");

  assert.equal(chordCorner.ok, true);
  if (!chordCorner.ok) {
    assert.fail("expected keyboard corner snap to succeed");
  }
  assert.equal(chordCorner.command, "top-left");
  assert.deepEqual(chordCorner.placement?.rect, TOP_LEFT);

  const chordHalf = vm.handleKeyboardChord("super+shift+ArrowDown");

  assert.equal(chordHalf.ok, true);
  if (!chordHalf.ok) {
    assert.fail("expected keyboard bottom-half snap to succeed");
  }
  assert.equal(chordHalf.command, "bottom-half");
  assert.deepEqual(chordHalf.placement?.rect, BOTTOM_HALF);

  const centered = vm.handleKeyboardChord("super+enter");

  assert.equal(centered.ok, true);
  if (!centered.ok) {
    assert.fail("expected keyboard center to succeed");
  }
  assert.equal(centered.command, "center");
  assert.deepEqual(centered.placement?.rect, {
    height: 400,
    width: 1_200,
    x: 0,
    y: 200,
  });

  const maximized = vm.handleKeyboardChord("super+ArrowUp");

  assert.equal(maximized.ok, true);
  if (!maximized.ok) {
    assert.fail("expected keyboard maximize to succeed");
  }
  assert.equal(maximized.command, "maximize");
  assert.deepEqual(maximized.placement?.rect, WORK_AREA);

  const restored = vm.handleKeyboardChord("super+ArrowDown");

  assert.equal(restored.ok, true);
  if (!restored.ok) {
    assert.fail("expected keyboard restore to succeed");
  }
  assert.equal(restored.command, "restore");
  assert.deepEqual(restored.placement?.rect, INITIAL_RECT);
  assert.equal(restored.state.restoreAvailable, false);
  assert.equal(calls.map((call): string => call.type).includes("setTextureVisibility"), false);
});

test("center and maximize use the active work area and preserve a restore target", () => {
  const calls: WindowManagerIntent[] = [];
  const vm = createVm(calls);

  const centered = vm.centerFocused();

  assert.equal(centered.ok, true);
  if (!centered.ok) {
    assert.fail("expected center to succeed");
  }
  assert.deepEqual(centered.placement?.rect, CENTERED);
  assert.equal(centered.state.restoreAvailable, true);

  const maximized = vm.maximizeFocused();

  assert.equal(maximized.ok, true);
  if (!maximized.ok) {
    assert.fail("expected maximize to succeed");
  }
  assert.deepEqual(maximized.placement?.rect, WORK_AREA);
  assert.equal(maximized.state.restoreAvailable, true);

  const restored = vm.restoreFocused();

  assert.equal(restored.ok, true);
  if (!restored.ok) {
    assert.fail("expected restore to succeed");
  }
  assert.deepEqual(restored.placement?.rect, INITIAL_RECT);
  assert.equal(restored.state.restoreAvailable, false);
});

test("invalid commands, chords, pointers, and missing focus fail closed without mutation", () => {
  const calls: WindowManagerIntent[] = [];
  const vm = createVm(calls);
  const before = projectState(vm.snapshot());

  const badCommand = vm.snapToZone("diagonal");

  assert.equal(badCommand.ok, false);
  if (badCommand.ok) {
    assert.fail("expected invalid snap command to fail closed");
  }
  assert.equal(badCommand.error.code, "INVALID_SNAP_COMMAND");

  const badChord = vm.handleKeyboardChord("ctrl+ArrowLeft");

  assert.equal(badChord.ok, false);
  if (badChord.ok) {
    assert.fail("expected invalid keyboard chord to fail closed");
  }
  assert.equal(badChord.error.code, "INVALID_KEYBOARD_CHORD");

  let getterReads = 0;
  const hostilePoint: Record<string, unknown> = {
    y: 1,
  };

  Object.defineProperty(hostilePoint, "x", {
    enumerable: true,
    get() {
      getterReads += 1;
      return 1;
    },
  });

  const badPointer = vm.snapAtPoint(hostilePoint);

  assert.equal(badPointer.ok, false);
  if (badPointer.ok) {
    assert.fail("expected accessor pointer to fail closed");
  }
  assert.equal(badPointer.error.code, "INVALID_POINTER");
  assert.equal(getterReads, 0);
  assert.deepEqual(calls, []);
  assert.deepEqual(projectState(vm.snapshot()), before);

  const noFocusVm = createWindowSnapViewModel({
    initialModel: createWindowModel({
      activeWorkspaceId: "workspace-1",
      windows: Object.freeze([]),
      workspaces: Object.freeze([
        Object.freeze({
          id: "workspace-1",
          layout: "floating",
        }) satisfies WorkspaceState,
      ]),
    }),
    wm: fakeWm(calls),
    workArea: WORK_AREA,
  });
  const noFocus = noFocusVm.snapToZone("left-half");

  assert.equal(noFocus.ok, false);
  if (noFocus.ok) {
    assert.fail("expected missing focus to fail closed");
  }
  assert.equal(noFocus.error.code, "NO_FOCUSED_WINDOW");
});

test("display and WM port failures fail closed and leave model state unchanged", () => {
  const displayCalls: WindowManagerIntent[] = [];
  const displayVm = createWindowSnapViewModel({
    display: {
      activeWorkArea(): Rect {
        return {
          height: 800,
          width: 0,
          x: 0,
          y: 0,
        };
      },
    },
    initialModel: initialModel(),
    wm: fakeWm(displayCalls),
  });
  const displayFailure = displayVm.snapToZone("left-half");

  assert.equal(displayFailure.ok, false);
  if (displayFailure.ok) {
    assert.fail("expected invalid display work area to fail closed");
  }
  assert.equal(displayFailure.error.code, "DISPLAY_UNAVAILABLE");
  assert.equal(displayFailure.state.ready, false);
  assert.deepEqual(displayCalls, []);

  const wmCalls: WindowManagerIntent[] = [];
  const wmVm = createVm(wmCalls, throwingWm(wmCalls));
  const before = projectState(wmVm.snapshot());
  const failed = wmVm.snapToZone("left-half");

  assert.equal(failed.ok, false);
  if (failed.ok) {
    assert.fail("expected WM failure to fail closed");
  }
  assert.equal(failed.error.code, "WM_INTENT_FAILED");
  assert.deepEqual(projectState(failed.state), before);
  assert.deepEqual(projectState(wmVm.snapshot()), before);
  assert.deepEqual(wmCalls, [
    {
      rect: LEFT_HALF,
      textureId: TEXTURE_ID,
      type: "repositionTexture",
      windowId: WINDOW_ID,
    },
  ]);
});

function createVm(
  calls: WindowManagerIntent[],
  wm: WindowSnapWindowManagerPort = fakeWm(calls),
) {
  return createWindowSnapViewModel({
    initialModel: initialModel(),
    wm,
    workArea: WORK_AREA,
  });
}

function initialModel() {
  return createInitialWindowSnapModel({
    rect: INITIAL_RECT,
    textureId: TEXTURE_ID,
    windowId: WINDOW_ID,
  });
}

function projectState(state: ReturnType<ReturnType<typeof createWindowSnapViewModel>["snapshot"]>) {
  return {
    activeWindowId: state.activeWindowId,
    errorCode: state.error?.code ?? null,
    focusedRect: state.focusedPlacement?.rect ?? null,
    intentCount: state.intentCount,
    lastCommand: state.lastCommand,
    lastIntentTypes: state.lastIntentTypes,
    ready: state.ready,
    restoreAvailable: state.restoreAvailable,
    workArea: state.workArea,
    zones: state.zones.map((zone) => ({
      id: zone.id,
      kind: zone.kind,
      rect: zone.rect,
      triggerRect: zone.triggerRect,
    })),
  };
}

function zoneRect(
  state: ReturnType<ReturnType<typeof createWindowSnapViewModel>["snapshot"]>,
  id: string,
): Rect | null {
  for (let index = 0; index < state.zones.length; index += 1) {
    const zone = state.zones[index];

    if (zone !== undefined && zone.id === id) {
      return zone.rect;
    }
  }

  return null;
}

function fakeWm(calls: WindowManagerIntent[]): WindowSnapWindowManagerPort {
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

function throwingWm(calls: WindowManagerIntent[]): WindowSnapWindowManagerPort {
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
