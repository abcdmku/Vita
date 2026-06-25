import assert from "node:assert/strict";
import { test } from "node:test";

import {
  closeWindow,
  collectWindowManagerIntents,
  createWindowModel,
  emitWindowManagerIntents,
  focusedWindowId,
  focusNextWindow,
  focusPreviousWindow,
  focusWindow,
  layout,
  maximizeWindow,
  minimizeWindow,
  moveWindowToWorkspace,
  openWindow,
  requestMoveResize,
  reduceWindowModel,
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
  assert.deepEqual(
    projectPlacements(layout(setWorkspaceLayout(model, "main", "master-stack"), {
      bounds: SCREEN,
      gap: 10,
    })),
    projectPlacements(first),
  );
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

test("columns layout splits tiled windows across deterministic columns", () => {
  let model = createWindowModel({
    activeWorkspaceId: "main",
    workspaces: [
      {
        id: "main",
        layout: "columns",
      },
    ],
  });
  model = open(model, "a");
  model = open(model, "b");
  model = open(model, "c");

  assert.deepEqual(projectPlacements(layout(model, {
    bounds: SCREEN,
    gap: 10,
    minWidth: 300,
  })), [
    {
      focused: false,
      rect: {
        height: 580,
        width: 320,
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
        height: 580,
        width: 320,
        x: 340,
        y: 10,
      },
      textureId: "texture-b",
      windowId: "b",
      zIndex: 1,
    },
    {
      focused: true,
      rect: {
        height: 580,
        width: 320,
        x: 670,
        y: 10,
      },
      textureId: "texture-c",
      windowId: "c",
      zIndex: 2,
    },
  ]);
});

test("grid layout fills a stable row-major grid", () => {
  let model = createWindowModel({
    activeWorkspaceId: "main",
    workspaces: [
      {
        id: "main",
        layout: "grid",
      },
    ],
  });

  for (const id of ["a", "b", "c", "d", "e"]) {
    model = open(model, id);
  }

  assert.deepEqual(projectPlacements(layout(model, {
    bounds: SCREEN,
    gap: 10,
    minHeight: 100,
    minWidth: 100,
  })), [
    {
      focused: false,
      rect: {
        height: 285,
        width: 320,
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
        width: 320,
        x: 340,
        y: 10,
      },
      textureId: "texture-b",
      windowId: "b",
      zIndex: 1,
    },
    {
      focused: false,
      rect: {
        height: 285,
        width: 320,
        x: 670,
        y: 10,
      },
      textureId: "texture-c",
      windowId: "c",
      zIndex: 2,
    },
    {
      focused: false,
      rect: {
        height: 285,
        width: 320,
        x: 10,
        y: 305,
      },
      textureId: "texture-d",
      windowId: "d",
      zIndex: 3,
    },
    {
      focused: true,
      rect: {
        height: 285,
        width: 320,
        x: 340,
        y: 305,
      },
      textureId: "texture-e",
      windowId: "e",
      zIndex: 4,
    },
  ]);
});

test("tiling layouts shrink inner gaps before violating satisfiable min sizes", () => {
  let model = createWindowModel({
    activeWorkspaceId: "main",
    workspaces: [
      {
        id: "main",
        layout: "columns",
      },
    ],
  });
  model = open(model, "a");
  model = open(model, "b");
  model = open(model, "c");

  assert.deepEqual(projectPlacements(layout(model, {
    bounds: {
      height: 100,
      width: 220,
      x: 0,
      y: 0,
    },
    gap: 20,
    minWidth: 50,
  })).map((placement) => placement.rect), [
    {
      height: 60,
      width: 50,
      x: 20,
      y: 20,
    },
    {
      height: 60,
      width: 50,
      x: 85,
      y: 20,
    },
    {
      height: 60,
      width: 50,
      x: 150,
      y: 20,
    },
  ]);

  let single = createWindowModel({
    activeWorkspaceId: "main",
    workspaces: [
      {
        id: "main",
        layout: "master-stack",
      },
    ],
  });
  single = open(single, "a");

  assert.deepEqual(projectPlacements(layout(single, {
    bounds: {
      height: 100,
      width: 100,
      x: 0,
      y: 0,
    },
    gap: 20,
    minHeight: 70,
    minWidth: 80,
  })).map((placement) => placement.rect), [
    {
      height: 70,
      width: 80,
      x: 10,
      y: 15,
    },
  ]);
});

test("floating workspace layout preserves clamped window rects", () => {
  let model = createWindowModel({
    activeWorkspaceId: "main",
    workspaces: [
      {
        id: "main",
        layout: "floating",
      },
    ],
  });
  model = openWindow(model, {
    id: "a",
    rect: {
      height: 20,
      width: 30,
      x: -20,
      y: 20,
    },
    textureId: "texture-a",
  });
  model = openWindow(model, {
    id: "b",
    rect: {
      height: 300,
      width: 200,
      x: 950,
      y: 500,
    },
    textureId: "texture-b",
  });

  assert.deepEqual(projectPlacements(layout(model, {
    bounds: SCREEN,
    minHeight: 80,
    minWidth: 100,
  })).map((placement) => placement.rect), [
    {
      height: 80,
      width: 100,
      x: 0,
      y: 20,
    },
    {
      height: 300,
      width: 200,
      x: 800,
      y: 300,
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

test("focus next and previous cycle the workspace ring and raise on focus intent", () => {
  let model = createWindowModel({ activeWorkspaceId: "main" });
  model = open(model, "a");
  model = open(model, "b");
  model = open(model, "c");

  const focusedA = focusNextWindow(model);
  assert.equal(focusedWindowId(focusedA), "a");
  assert.deepEqual(collectWindowManagerIntents(model, focusedA, { bounds: SCREEN }), [
    {
      type: "setFocus",
      windowId: "a",
    },
  ]);
  assert.equal(projectPlacements(layout(focusedA, { bounds: SCREEN })).at(-1)?.windowId, "a");

  const focusedC = focusPreviousWindow(focusedA);
  assert.equal(focusedWindowId(focusedC), "c");

  const reduced = reduceWindowModel(focusedC, {
    type: "focus-next",
  });
  assert.equal(focusedWindowId(reduced), "a");
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
