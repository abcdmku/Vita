import assert from "node:assert/strict";
import { test } from "node:test";

import {
  closeWindow,
  collectWindowManagerIntents,
  createWindowModel,
  emitWindowManagerIntents,
  focusedWindowId,
  focusWindow,
  layout,
  maximizeWindow,
  minimizeWindow,
  moveWindowToWorkspace,
  openWindow,
  requestMoveResize,
  setWorkspaceLayout,
  switchWorkspace,
} from "../../src/wm/policy.ts";
import type {
  Rect,
  WindowManagerIntent,
  WindowManagerSubstratePort,
  WindowModel,
  WindowPlacement,
} from "../../src/wm/policy.ts";

const SCREEN = Object.freeze({
  height: 600,
  width: 1_000,
  x: 0,
  y: 0,
}) satisfies Rect;

test("tile layout is deterministic, stable, and focus annotated", () => {
  let model = createWindowModel({
    activeWorkspaceId: "main",
    workspaces: [
      {
        id: "main",
        layout: "tile",
      },
    ],
  });
  model = open(model, "a");
  model = open(model, "b");
  model = open(model, "c");

  const first = layout(model, {
    bounds: SCREEN,
    gap: 10,
  });
  const second = layout(model, {
    bounds: SCREEN,
    gap: 10,
  });

  assert.deepEqual(projectPlacements(second), projectPlacements(first));
  assert.deepEqual(projectPlacements(first), [
    {
      focused: false,
      rect: {
        height: 580,
        width: 485,
        x: 10,
        y: 10,
      },
      textureId: "texture-a",
      windowId: "a",
      zIndex: 0,
    },
    {
      focused: false,
      rect: {
        height: 285,
        width: 485,
        x: 505,
        y: 10,
      },
      textureId: "texture-b",
      windowId: "b",
      zIndex: 1,
    },
    {
      focused: true,
      rect: {
        height: 285,
        width: 485,
        x: 505,
        y: 305,
      },
      textureId: "texture-c",
      windowId: "c",
      zIndex: 2,
    },
  ]);
});

test("focus follows intent and close falls back through the focus stack", () => {
  let model = createWindowModel({ activeWorkspaceId: "main" });
  model = open(model, "a");
  model = open(model, "b");
  model = open(model, "c");

  model = focusWindow(model, "a");
  assert.equal(focusedWindowId(model), "a");

  model = closeWindow(model, "a");
  assert.equal(focusedWindowId(model), "c");
  assert.deepEqual(focusedPlacements(model), ["c"]);
});

test("workspace switch and move-to-workspace keep focus workspace-local", () => {
  let model = createWindowModel({
    activeWorkspaceId: "main",
    workspaces: [
      {
        id: "main",
        layout: "tile",
      },
      {
        id: "ops",
        layout: "tile",
      },
    ],
  });
  model = open(model, "a", "main");
  model = open(model, "b", "ops");

  assert.equal(model.activeWorkspaceId, "main");
  assert.equal(focusedWindowId(model), "a");

  model = switchWorkspace(model, "ops");
  assert.equal(focusedWindowId(model), "b");

  model = moveWindowToWorkspace(model, "b", "main");
  assert.equal(model.activeWorkspaceId, "ops");
  assert.equal(focusedWindowId(model), null);

  model = switchWorkspace(model, "main");
  assert.equal(focusedWindowId(model), "b");
  assert.deepEqual(layout(model, { bounds: SCREEN }).map((placement) => placement.windowId), ["a", "b"]);
});

test("stack layout, minimize, and maximize are pure reducer state", () => {
  let model = createWindowModel({ activeWorkspaceId: "main" });
  model = open(model, "a");
  model = open(model, "b");
  model = setWorkspaceLayout(model, "main", "stack");

  const stacked = projectPlacements(layout(model, {
    bounds: SCREEN,
    gap: 10,
  }));
  assert.deepEqual(stacked.map((placement) => placement.rect), [
    {
      height: 580,
      width: 980,
      x: 10,
      y: 10,
    },
    {
      height: 580,
      width: 980,
      x: 10,
      y: 10,
    },
  ]);
  assert.equal(focusedWindowId(model), "b");

  model = minimizeWindow(model, "b");
  assert.equal(focusedWindowId(model), "a");
  assert.deepEqual(layout(model, { bounds: SCREEN }).map((placement) => placement.windowId), ["a"]);

  model = maximizeWindow(model, "a");
  assert.deepEqual(projectPlacements(layout(model, { bounds: SCREEN })), [
    {
      focused: true,
      rect: SCREEN,
      textureId: "texture-a",
      windowId: "a",
      zIndex: 0,
    },
  ]);
});

test("move and resize emit reposition intents, never repaint intents", () => {
  let model = createWindowModel({ activeWorkspaceId: "main" });
  model = open(model, "a");
  const next = requestMoveResize(model, "a", {
    height: 200,
    width: 300,
    x: 40,
    y: 50,
  });

  const intents = collectWindowManagerIntents(model, next, { bounds: SCREEN });
  const intentTypes: readonly string[] = intents.map((intent) => intent.type);
  assert.deepEqual(intentTypes, ["repositionTexture"]);
  assert.equal(intentTypes.includes("repaintTexture"), false);

  const calls: PortCall[] = [];
  emitWindowManagerIntents(fakePort(calls), intents);

  assert.deepEqual(calls, [
    {
      rect: {
        height: 200,
        width: 300,
        x: 40,
        y: 50,
      },
      textureId: "texture-a",
      type: "repositionTexture",
      windowId: "a",
    },
  ]);
});

test("open and workspace switch intents target only the substrate port", () => {
  const empty = createWindowModel({ activeWorkspaceId: "main" });
  const opened = open(empty, "a");
  const openIntents = collectWindowManagerIntents(empty, opened, { bounds: SCREEN });
  const calls: PortCall[] = [];

  emitWindowManagerIntents(fakePort(calls), openIntents);
  assert.deepEqual(openIntents.map((intent) => intent.type), [
    "setTextureVisibility",
    "repositionTexture",
    "setFocus",
  ]);
  assert.deepEqual(calls.map((call) => call.type), [
    "setTextureVisibility",
    "repositionTexture",
    "setFocus",
  ]);

  let model = open(opened, "b", "ops");
  const switched = switchWorkspace(model, "ops");
  const switchIntents = collectWindowManagerIntents(model, switched, { bounds: SCREEN });

  model = switched;
  assert.equal(focusedWindowId(model), "b");
  assert.deepEqual(switchIntents.map((intent) => intent.type), [
    "setTextureVisibility",
    "setTextureVisibility",
    "repositionTexture",
    "setFocus",
  ]);
});

interface ProjectedPlacement {
  readonly windowId: string;
  readonly textureId: string;
  readonly rect: Rect;
  readonly focused: boolean;
  readonly zIndex: number;
}

type PortCall =
  | Extract<WindowManagerIntent, { readonly type: "repositionTexture" }>
  | Extract<WindowManagerIntent, { readonly type: "setFocus" }>
  | Extract<WindowManagerIntent, { readonly type: "setTextureVisibility" }>;

function open(model: WindowModel, id: string, workspaceId?: string): WindowModel {
  const request: {
    id: string;
    textureId: string;
    workspaceId?: string;
  } = {
    id,
    textureId: `texture-${id}`,
  };

  if (workspaceId !== undefined) {
    request.workspaceId = workspaceId;
  }

  return openWindow(model, request);
}

function projectPlacements(placements: readonly WindowPlacement[]): readonly ProjectedPlacement[] {
  return placements.map((placement) => ({
    focused: placement.focused,
    rect: placement.rect,
    textureId: placement.textureId,
    windowId: placement.windowId,
    zIndex: placement.zIndex,
  }));
}

function focusedPlacements(model: WindowModel): readonly string[] {
  return layout(model, { bounds: SCREEN })
    .filter((placement) => placement.focused)
    .map((placement) => placement.windowId);
}

function fakePort(calls: PortCall[]): WindowManagerSubstratePort {
  return {
    repositionTexture(textureId, rect, windowId): void {
      calls.push({
        rect,
        textureId,
        type: "repositionTexture",
        windowId,
      });
    },
    setFocus(windowId): void {
      calls.push({
        type: "setFocus",
        windowId,
      });
    },
    setTextureVisibility(textureId, visible, windowId): void {
      calls.push({
        textureId,
        type: "setTextureVisibility",
        visible,
        windowId,
      });
    },
  };
}
