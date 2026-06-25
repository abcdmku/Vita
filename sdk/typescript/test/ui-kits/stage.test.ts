import assert from "node:assert/strict";
import { test } from "node:test";

import {
  applyStageWindowManagerIntents,
  createStageViewModel,
  diffStageRenderPlans,
} from "../../../../ui_kits/desktop/viewmodels/stage.ts";
import type {
  StageCellRect,
  StageCell,
  StageCompositorPort,
  StageCompositorTexture,
  StageRenderPlanEntry,
  StageViewModelState,
  StageWindowManagerIntent,
  StageWindowManagerPort,
  StageWindowManagerPortResult,
} from "../../../../ui_kits/desktop/viewmodels/stage.ts";
import {
  createWindowModel,
} from "../../src/desktop-sdk/index.ts";
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

const STAGE_BOUNDS = Object.freeze({
  h: 400,
  w: 320,
  x: 5,
  y: 7,
}) satisfies StageCellRect;

test("snapshot lays out all workspaces deterministically with non-overlapping cells", () => {
  const port = new FakeStageWindowManagerPort(initialModel());
  const vm = createStageViewModel({
    ...stageOptions(),
    wm: port,
  });

  const first = vm.snapshot();
  const second = vm.snapshot();

  assert.equal(Object.isFrozen(first), true);
  assert.equal(Object.isFrozen(first.workspaces), true);
  assert.equal(Object.isFrozen(first.workspaces[0]?.cells), true);
  assert.equal(Object.isFrozen(first.workspaces[0]?.cells[0]), true);
  assert.equal(Object.isFrozen(first.workspaces[0]?.cells[0]?.rect), true);
  assert.deepEqual(projectLayout(second), projectLayout(first));
  assert.equal(JSON.stringify(projectCellRects(second)), JSON.stringify(projectCellRects(first)));
  assert.deepEqual(first.workspaces.map((workspaceState) => workspaceState.workspaceId), [
    "workspace-1",
    "workspace-2",
    "workspace-3",
  ]);
  assert.deepEqual(first.workspaces[0]?.cells.map((cell) => cell.windowId), [
    "window:a",
    "window:b",
    "window:c",
  ]);
  assert.deepEqual(first.workspaces[1]?.cells.map((cell) => cell.windowId), [
    "window:d",
    "window:e",
  ]);
  assert.deepEqual(first.workspaces[2]?.cells, []);
  assert.deepEqual(first.focusedCell, {
    windowId: "window:a",
    workspaceId: "workspace-1",
  });
  assert.deepEqual(projectCellRects(first).slice(0, 5), [
    ["workspace-1", "window:a", { h: 60, w: 100, x: 5, y: 27 }],
    ["workspace-1", "window:b", { h: 60, w: 100, x: 115, y: 27 }],
    ["workspace-1", "window:c", { h: 60, w: 100, x: 5, y: 97 }],
    ["workspace-2", "window:d", { h: 60, w: 100, x: 5, y: 207 }],
    ["workspace-2", "window:e", { h: 60, w: 100, x: 115, y: 207 }],
  ]);
  assertGroupsDoNotOverlap(first);
});

test("keyboard navigation moves to geometric neighbors and clamps at edges", () => {
  const port = new FakeStageWindowManagerPort(initialModel());
  const vm = createStageViewModel({
    ...stageOptions(),
    wm: port,
  });

  assert.deepEqual(vm.snapshot().focusedCell, {
    windowId: "window:a",
    workspaceId: "workspace-1",
  });

  const right = vm.navigate("right");

  assert.equal(right.ok, true);
  assert.deepEqual(right.state.focusedCell, {
    windowId: "window:b",
    workspaceId: "workspace-1",
  });
  assert.deepEqual(right.intents, []);

  const clampedRight = vm.navigate("right");

  assert.equal(clampedRight.ok, true);
  assert.deepEqual(clampedRight.state.focusedCell, {
    windowId: "window:b",
    workspaceId: "workspace-1",
  });

  assert.equal(vm.navigate("left").state.focusedCell?.windowId, "window:a");
  assert.equal(vm.navigate("down").state.focusedCell?.windowId, "window:c");
  assert.equal(vm.navigate("down").state.focusedCell?.windowId, "window:d");
  assert.equal(vm.navigate("right").state.focusedCell?.windowId, "window:e");
  assert.equal(vm.navigate("right").state.focusedCell?.windowId, "window:e");
  assert.equal(vm.navigate("up").state.focusedCell?.windowId, "window:b");

  const invalid = vm.navigate("diagonal");

  assert.equal(invalid.ok, false);
  if (invalid.ok) {
    assert.fail("expected invalid direction to fail closed");
  }
  assert.equal(invalid.error.code, "INVALID_DIRECTION");
  assert.deepEqual(port.intents, []);
});

test("pick, closeWindow, and moveToWorkspace emit WM intents through the injected port", () => {
  const pickPort = new FakeStageWindowManagerPort(initialModel());
  const pickVm = createStageViewModel({
    ...stageOptions(),
    wm: pickPort,
  });

  const picked = pickVm.pick("workspace-1", "window:b");

  assert.equal(picked.ok, true);
  assert.equal(picked.state.overviewOpen, false);
  assert.deepEqual(picked.intents, [
    {
      type: "focus",
      windowId: "window:b",
    },
    {
      type: "activate",
      windowId: "window:b",
    },
  ]);
  assert.deepEqual(pickPort.intents, picked.intents);

  const closePort = new FakeStageWindowManagerPort(initialModel());
  const closeVm = createStageViewModel({
    ...stageOptions(),
    wm: closePort,
  });
  const closed = closeVm.closeWindow("workspace-1", "window:c");

  assert.equal(closed.ok, true);
  assert.deepEqual(closed.intents, [
    {
      type: "close",
      windowId: "window:c",
    },
  ]);
  assert.deepEqual(closePort.intents, closed.intents);
  assert.equal(findEntry(closed.state.renderPlan, "window:c"), undefined);

  const movePort = new FakeStageWindowManagerPort(initialModel());
  const moveVm = createStageViewModel({
    ...stageOptions(),
    wm: movePort,
  });
  const moved = moveVm.moveToWorkspace("window:a", "workspace-2");

  assert.equal(moved.ok, true);
  assert.deepEqual(moved.intents, [
    {
      type: "moveToWorkspace",
      windowId: "window:a",
      workspaceId: "workspace-2",
    },
  ]);
  assert.deepEqual(movePort.intents, moved.intents);
  assert.deepEqual(moved.state.focusedCell, {
    windowId: "window:a",
    workspaceId: "workspace-2",
  });
  assert.deepEqual(moved.state.workspaces[1]?.cells.map((cell) => cell.windowId), [
    "window:a",
    "window:d",
    "window:e",
  ]);
});

test("render plan binds each cell to the compositor texture and source size", () => {
  const port = new FakeStageWindowManagerPort(initialModel());
  const textures = textureMap([
    texture("window:a", 640, 480),
    texture("window:b", 320, 240),
    texture("window:c", 1024, 768),
    texture("window:d", 800, 600),
    texture("window:e", 400, 300),
  ]);
  const vm = createStageViewModel({
    ...stageOptions(),
    compositorPort: new FakeCompositorPort(textures),
    wm: port,
  });

  const state = vm.snapshot();
  const entry = findEntry(state.renderPlan, "window:b");
  const cell = state.workspaces[0]?.cells[1];

  assert.notEqual(entry, undefined);
  assert.notEqual(cell, undefined);
  assert.deepEqual(entry, {
    cellRect: cell?.rect,
    placeholder: false,
    sourceSize: {
      height: 240,
      width: 320,
    },
    textureId: "texture:window:b",
    windowId: "window:b",
  });
  assert.equal(entry?.cellRect, cell?.rect);
  assert.equal(Object.isFrozen(state.renderPlan), true);
  assert.equal(Object.isFrozen(entry), true);
});

test("open, close, and resize reconcile render-plan diffs without replacing unchanged entries", () => {
  const port = new FakeStageWindowManagerPort(initialModel());
  const textures = textureMap([
    texture("window:a", 640, 480),
    texture("window:b", 320, 240),
    texture("window:c", 1024, 768),
    texture("window:d", 800, 600),
    texture("window:e", 400, 300),
  ]);
  const compositor = new FakeCompositorPort(textures);
  const vm = createStageViewModel({
    ...stageOptions(),
    compositorPort: compositor,
    wm: port,
  });

  const first = vm.snapshot();
  const firstByWindow = entriesByWindow(first.renderPlan);

  port.setModel(addWindow(port.model, windowState("window:z", "workspace-2", 99)));
  compositor.set("window:z", texture("window:z", 500, 500));

  const opened = vm.snapshot();
  const openDiff = diffStageRenderPlans(first.renderPlan, opened.renderPlan);

  assert.deepEqual(openDiff.added.map((entry) => entry.windowId), ["window:z"]);
  assert.deepEqual(openDiff.removed, []);
  assert.deepEqual(openDiff.updated, []);
  assertSameEntries(firstByWindow, opened.renderPlan, ["window:a", "window:b", "window:c", "window:d", "window:e"]);

  const openedByWindow = entriesByWindow(opened.renderPlan);
  port.setModel(removeWindow(port.model, "window:z"));

  const closed = vm.snapshot();
  const closeDiff = diffStageRenderPlans(opened.renderPlan, closed.renderPlan);

  assert.deepEqual(closeDiff.added, []);
  assert.deepEqual(closeDiff.removed.map((entry) => entry.windowId), ["window:z"]);
  assert.deepEqual(closeDiff.updated, []);
  assertSameEntries(openedByWindow, closed.renderPlan, ["window:a", "window:b", "window:c", "window:d", "window:e"]);

  const closedByWindow = entriesByWindow(closed.renderPlan);
  compositor.set("window:b", texture("window:b", 360, 270));

  const resized = vm.snapshot();
  const resizeDiff = diffStageRenderPlans(closed.renderPlan, resized.renderPlan);

  assert.deepEqual(resizeDiff.added, []);
  assert.deepEqual(resizeDiff.removed, []);
  assert.deepEqual(resizeDiff.updated.map((update) => update.after.windowId), ["window:b"]);
  assert.deepEqual(findEntry(resized.renderPlan, "window:b")?.sourceSize, {
    height: 270,
    width: 360,
  });
  assert.notEqual(findEntry(resized.renderPlan, "window:b"), closedByWindow.get("window:b"));
  assertSameEntries(closedByWindow, resized.renderPlan, ["window:a", "window:c", "window:d", "window:e"]);
});

test("missing or throwing compositor textures produce placeholders without throwing", () => {
  const partialPort = new FakeStageWindowManagerPort(initialModel());
  const partial = createStageViewModel({
    ...stageOptions(),
    compositorPort: new FakeCompositorPort(textureMap([
      texture("window:a", 640, 480),
    ])),
    wm: partialPort,
  }).snapshot();
  const missing = findEntry(partial.renderPlan, "window:b");

  assert.equal(missing?.placeholder, true);
  assert.equal(missing?.textureId, null);
  assert.equal(missing?.sourceSize, null);
  assert.deepEqual(missing?.cellRect, partial.workspaces[0]?.cells[1]?.rect);

  const absentPort = new FakeStageWindowManagerPort(initialModel());
  const absent = createStageViewModel({
    ...stageOptions(),
    wm: absentPort,
  }).snapshot();

  assert.equal(absent.renderPlan.every((entry) => entry.placeholder), true);

  const throwingPort = new FakeStageWindowManagerPort(initialModel());
  const throwing = createStageViewModel({
    ...stageOptions(),
    compositorPort: {
      resolveWindowTexture(): StageCompositorTexture {
        throw new Error("configured compositor failure");
      },
    },
    wm: throwingPort,
  }).snapshot();

  assert.equal(throwing.renderPlan.every((entry) => entry.placeholder), true);
  assert.equal(throwing.renderPlan.every((entry) => entry.textureId === null), true);
});

function stageOptions() {
  return {
    bounds: STAGE_BOUNDS,
    cellGap: 10,
    cellHeight: 60,
    cellWidth: 100,
    columns: 2,
    describeWindow(window: WindowState) {
      return {
        appId: `app:${window.id.slice("window:".length)}`,
        title: `Title ${window.id.slice("window:".length).toUpperCase()}`,
      };
    },
    labelHeight: 20,
    workspaceGap: 30,
  };
}

function initialModel(): WindowModel {
  return createWindowModel({
    activeWorkspaceId: "workspace-1",
    focusStack: Object.freeze(["window:a", "window:e"]),
    windows: Object.freeze([
      windowState("window:c", "workspace-1", 20),
      windowState("window:a", "workspace-1", 30),
      windowState("window:e", "workspace-2", 40),
      windowState("window:b", "workspace-1", 10),
      windowState("window:d", "workspace-2", 50),
    ]),
    workspaces: Object.freeze([
      workspace("workspace-1", "tile"),
      workspace("workspace-2", "grid"),
      workspace("workspace-3", "stack"),
    ]),
  });
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
    textureId: `legacy-texture:${id}`,
    workspaceId,
  });
}

function addWindow(model: WindowModel, window: WindowState): WindowModel {
  return createWindowModel({
    activeWorkspaceId: model.activeWorkspaceId,
    focusStack: model.focusStack,
    windows: Object.freeze([...model.windows, window]),
    workspaces: model.workspaces,
  });
}

function removeWindow(model: WindowModel, windowId: string): WindowModel {
  const windows: WindowState[] = [];

  for (let index = 0; index < model.windows.length; index += 1) {
    const window = model.windows[index];

    if (window !== undefined && window.id !== windowId) {
      windows.push(window);
    }
  }

  return createWindowModel({
    activeWorkspaceId: model.activeWorkspaceId,
    focusStack: model.focusStack,
    windows: Object.freeze(windows),
    workspaces: model.workspaces,
  });
}

function texture(windowId: string, sourceW: number, sourceH: number): StageCompositorTexture {
  return Object.freeze({
    sourceH,
    sourceW,
    textureId: `texture:${windowId}`,
  });
}

function textureMap(textures: readonly StageCompositorTexture[]): Map<string, StageCompositorTexture> {
  const output = new Map<string, StageCompositorTexture>();

  for (let index = 0; index < textures.length; index += 1) {
    const entry = textures[index];

    if (entry !== undefined) {
      output.set(entry.textureId.slice("texture:".length), entry);
    }
  }

  return output;
}

function projectLayout(state: StageViewModelState) {
  return {
    focusedCell: state.focusedCell,
    overviewOpen: state.overviewOpen,
    renderPlan: state.renderPlan,
    workspaces: state.workspaces.map((workspaceState) => ({
      cells: workspaceState.cells.map((cell) => ({
        appId: cell.appId,
        rect: cell.rect,
        sourceRect: cell.sourceRect,
        title: cell.title,
        windowId: cell.windowId,
      })),
      label: workspaceState.label,
      workspaceId: workspaceState.workspaceId,
    })),
  };
}

function projectCellRects(state: StageViewModelState) {
  const output: Array<[string, string, StageCellRect]> = [];

  for (let workspaceIndex = 0; workspaceIndex < state.workspaces.length; workspaceIndex += 1) {
    const workspaceState = state.workspaces[workspaceIndex];

    if (workspaceState === undefined) {
      continue;
    }

    for (let cellIndex = 0; cellIndex < workspaceState.cells.length; cellIndex += 1) {
      const cell = workspaceState.cells[cellIndex];

      if (cell !== undefined) {
        output.push([workspaceState.workspaceId, cell.windowId, cell.rect]);
      }
    }
  }

  return output;
}

function assertGroupsDoNotOverlap(state: StageViewModelState): void {
  for (let workspaceIndex = 0; workspaceIndex < state.workspaces.length; workspaceIndex += 1) {
    const workspaceState = state.workspaces[workspaceIndex];

    if (workspaceState === undefined) {
      continue;
    }

    for (let leftIndex = 0; leftIndex < workspaceState.cells.length; leftIndex += 1) {
      const leftCell: StageCell | undefined = workspaceState.cells[leftIndex];

      if (leftCell === undefined) {
        continue;
      }

      for (let rightIndex = leftIndex + 1; rightIndex < workspaceState.cells.length; rightIndex += 1) {
        const rightCell: StageCell | undefined = workspaceState.cells[rightIndex];

        if (rightCell !== undefined) {
          assert.equal(
            overlaps(leftCell.rect, rightCell.rect),
            false,
            `${leftCell.windowId} overlaps ${rightCell.windowId}`,
          );
        }
      }
    }
  }
}

function overlaps(left: StageCellRect, right: StageCellRect): boolean {
  return left.x < right.x + right.w &&
    right.x < left.x + left.w &&
    left.y < right.y + right.h &&
    right.y < left.y + left.h;
}

function findEntry(
  entries: readonly StageRenderPlanEntry[],
  windowId: string,
): StageRenderPlanEntry | undefined {
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];

    if (entry !== undefined && entry.windowId === windowId) {
      return entry;
    }
  }

  return undefined;
}

function entriesByWindow(
  entries: readonly StageRenderPlanEntry[],
): ReadonlyMap<string, StageRenderPlanEntry> {
  const output = new Map<string, StageRenderPlanEntry>();

  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];

    if (entry !== undefined) {
      output.set(entry.windowId, entry);
    }
  }

  return output;
}

function assertSameEntries(
  previous: ReadonlyMap<string, StageRenderPlanEntry>,
  entries: readonly StageRenderPlanEntry[],
  windowIds: readonly string[],
): void {
  for (let index = 0; index < windowIds.length; index += 1) {
    const windowId = windowIds[index];

    if (windowId !== undefined) {
      assert.equal(findEntry(entries, windowId), previous.get(windowId), windowId);
    }
  }
}

class FakeCompositorPort implements StageCompositorPort {
  readonly #textures: Map<string, StageCompositorTexture>;

  constructor(textures: Map<string, StageCompositorTexture>) {
    this.#textures = new Map(textures);
  }

  resolveWindowTexture(windowId: string): StageCompositorTexture | null {
    return this.#textures.get(windowId) ?? null;
  }

  set(windowId: string, textureValue: StageCompositorTexture): void {
    this.#textures.set(windowId, textureValue);
  }
}

class FakeStageWindowManagerPort implements StageWindowManagerPort {
  intents: StageWindowManagerIntent[] = [];
  failApply = false;
  failRead = false;
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

  readWindowModel(): StageWindowManagerPortResult<WindowModel> {
    if (this.failRead) {
      return rejectPort("READ_FAILED", "configured read failure", "/fake/read");
    }

    return acceptPort(this.#model);
  }

  applyWindowManagerIntents(
    intents: readonly StageWindowManagerIntent[],
  ): StageWindowManagerPortResult<WindowModel> {
    this.intents.push(...intents);

    if (this.failApply) {
      return rejectPort("APPLY_FAILED", "configured apply failure", "/fake/apply");
    }

    this.#model = applyStageWindowManagerIntents(this.#model, intents);

    return acceptPort(this.#model);
  }
}

function acceptPort<T>(value: T): StageWindowManagerPortResult<T> {
  return Object.freeze({
    ok: true,
    value,
  });
}

function rejectPort<T>(
  code: string,
  message: string,
  path: string,
): StageWindowManagerPortResult<T> {
  return Object.freeze({
    error: Object.freeze({
      code,
      message,
      path,
    }),
    ok: false,
  });
}
