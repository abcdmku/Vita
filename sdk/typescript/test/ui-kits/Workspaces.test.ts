import assert from "node:assert/strict";
import { test } from "node:test";

import {
  createWorkspacesViewModel,
} from "../../../../ui_kits/desktop/viewmodels/workspaces.ts";
import type {
  WorkspacesViewModelState,
  WorkspacesWindowManagerPort,
  WorkspacesWindowManagerPortResult,
} from "../../../../ui_kits/desktop/viewmodels/workspaces.ts";
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

const RECT = Object.freeze({
  height: 480,
  width: 640,
  x: 0,
  y: 0,
}) satisfies Rect;

test("snapshot exposes ordered workspaces, active id, names, and per-workspace window sets", () => {
  const port = new FakeWorkspacesWindowManagerPort(initialModel());
  const vm = createWorkspacesViewModel({
    wm: port,
  });

  const first = vm.snapshot();
  const second = vm.snapshot();

  assert.deepEqual(projectState(second), projectState(first));
  assert.deepEqual(projectState(first), {
    activeWorkspaceId: "workspace-1",
    activeWorkspaceIndex: 0,
    activeWorkspacePosition: 1,
    windowCount: 3,
    workspaceCount: 2,
    workspaces: [
      {
        active: true,
        id: "workspace-1",
        index: 0,
        layout: "tile",
        name: "Workspace 1",
        position: 1,
        windowCount: 2,
        windowIds: ["window:a", "window:c"],
      },
      {
        active: false,
        id: "workspace-2",
        index: 1,
        layout: "stack",
        name: "Workspace 2",
        position: 2,
        windowCount: 1,
        windowIds: ["window:b"],
      },
    ],
  });
  assert.deepEqual(port.events, [
    "read",
    "read",
    "read",
  ]);
});

test("create appends a deterministic active workspace through the WM port", () => {
  const port = new FakeWorkspacesWindowManagerPort(initialModel());
  const vm = createWorkspacesViewModel({
    wm: port,
  });

  const created = vm.create();

  assert.equal(created.ok, true);
  assert.equal(created.state.activeWorkspaceId, "workspace-3");
  assert.deepEqual(created.state.workspaces.map((workspace) => workspace.id), [
    "workspace-1",
    "workspace-2",
    "workspace-3",
  ]);
  assert.equal(created.state.workspaces[2]?.name, "Workspace 3");
  assert.deepEqual(port.model.workspaces.map((workspace) => workspace.id), [
    "workspace-1",
    "workspace-2",
    "workspace-3",
  ]);
  assert.deepEqual(port.events, [
    "read",
    "read",
    "apply:workspace-3:workspace-1,workspace-2,workspace-3",
  ]);
});

test("switch and rename validate known workspaces and read back current WM state", () => {
  const port = new FakeWorkspacesWindowManagerPort(initialModel());
  const vm = createWorkspacesViewModel({
    wm: port,
  });

  const renamed = vm.rename("workspace-2", "  Ops  ");

  assert.equal(renamed.ok, true);
  assert.equal(renamed.state.workspaces[1]?.name, "Ops");

  const switched = vm.switch("workspace-2");

  assert.equal(switched.ok, true);
  assert.equal(switched.state.activeWorkspaceId, "workspace-2");
  assert.equal(switched.state.activeWorkspaceIndex, 1);
  assert.equal(switched.state.workspaces[1]?.active, true);
  assert.equal(switched.state.workspaces[1]?.name, "Ops");
  assert.equal(port.model.activeWorkspaceId, "workspace-2");

  const rejected = vm.switch("workspace-404");

  assert.equal(rejected.ok, false);
  if (rejected.ok) {
    assert.fail("expected unknown workspace switch to fail closed");
  }
  assert.equal(rejected.error.code, "UNKNOWN_WORKSPACE");
  assert.equal(rejected.state.activeWorkspaceId, "workspace-2");
  assert.equal(port.model.activeWorkspaceId, "workspace-2");
});

test("moveWindowToWorkspace uses the SDK WM reducer and rejects unknown ids without applying", () => {
  const port = new FakeWorkspacesWindowManagerPort(initialModel());
  const vm = createWorkspacesViewModel({
    wm: port,
  });

  const moved = vm.moveWindowToWorkspace("window:a", "workspace-2");

  assert.equal(moved.ok, true);
  assert.deepEqual(moved.state.workspaces[0]?.windowIds, ["window:c"]);
  assert.deepEqual(moved.state.workspaces[1]?.windowIds, ["window:a", "window:b"]);

  const beforeEvents = [...port.events];
  const beforeState = projectState(vm.snapshot());
  const missingWindow = vm.moveWindowToWorkspace("window:missing", "workspace-2");

  assert.equal(missingWindow.ok, false);
  if (missingWindow.ok) {
    assert.fail("expected unknown window to fail closed");
  }
  assert.equal(missingWindow.error.code, "UNKNOWN_WINDOW");
  assert.deepEqual(projectState(missingWindow.state), beforeState);
  assert.deepEqual(port.events.slice(beforeEvents.length), [
    "read",
    "read",
  ]);

  const missingWorkspace = vm.moveWindowToWorkspace("window:a", "workspace-404");

  assert.equal(missingWorkspace.ok, false);
  if (missingWorkspace.ok) {
    assert.fail("expected unknown workspace to fail closed");
  }
  assert.equal(missingWorkspace.error.code, "UNKNOWN_WORKSPACE");
  assert.equal(lastApply(port.events), "apply:workspace-1:workspace-1,workspace-2");
});

test("remove keeps workspace order deterministic and moves orphaned windows to the fallback workspace", () => {
  const port = new FakeWorkspacesWindowManagerPort(initialModel());
  const vm = createWorkspacesViewModel({
    wm: port,
  });

  assert.equal(vm.rename("workspace-1", "Main").ok, true);

  const removed = vm.remove("workspace-1");

  assert.equal(removed.ok, true);
  assert.deepEqual(removed.state.workspaces.map((workspace) => workspace.id), [
    "workspace-2",
  ]);
  assert.equal(removed.state.activeWorkspaceId, "workspace-2");
  assert.deepEqual(removed.state.workspaces[0]?.windowIds, [
    "window:a",
    "window:b",
    "window:c",
  ]);
  assert.equal(removed.state.workspaces[0]?.name, "Workspace 2");

  const last = vm.remove("workspace-2");

  assert.equal(last.ok, false);
  if (last.ok) {
    assert.fail("expected removing the last workspace to fail closed");
  }
  assert.equal(last.error.code, "CANNOT_REMOVE_LAST_WORKSPACE");
  assert.deepEqual(last.state.workspaces.map((workspace) => workspace.id), [
    "workspace-2",
  ]);
});

test("invalid action inputs fail closed without committing to the WM port", () => {
  const port = new FakeWorkspacesWindowManagerPort(initialModel());
  const vm = createWorkspacesViewModel({
    wm: port,
  });
  const before = projectState(vm.snapshot());

  const invalidSwitch = vm.switch("");
  const invalidName = vm.rename("workspace-1", " ");
  const invalidWindow = vm.moveWindowToWorkspace("", "workspace-1");
  const invalidRemove = vm.remove(42);

  assert.equal(invalidSwitch.ok, false);
  assert.equal(invalidName.ok, false);
  assert.equal(invalidWindow.ok, false);
  assert.equal(invalidRemove.ok, false);
  assert.equal(invalidSwitch.ok ? "" : invalidSwitch.error.code, "INVALID_WORKSPACE_ID");
  assert.equal(invalidName.ok ? "" : invalidName.error.code, "INVALID_WORKSPACE_NAME");
  assert.equal(invalidWindow.ok ? "" : invalidWindow.error.code, "INVALID_WINDOW_ID");
  assert.equal(invalidRemove.ok ? "" : invalidRemove.error.code, "INVALID_WORKSPACE_ID");
  assert.deepEqual(projectState(vm.snapshot()), before);
  assert.equal(port.events.some((event) => event.startsWith("apply:")), false);
});

test("WM read and commit failures leave the view-model fail-closed", () => {
  const port = new FakeWorkspacesWindowManagerPort(initialModel());
  const vm = createWorkspacesViewModel({
    wm: port,
  });
  const before = projectState(vm.snapshot());

  port.failApply = true;
  const createFailed = vm.create();

  assert.equal(createFailed.ok, false);
  if (createFailed.ok) {
    assert.fail("expected failed apply to reject");
  }
  assert.equal(createFailed.error.code, "WM_COMMIT_FAILED");
  assert.deepEqual(projectState(createFailed.state), before);
  assert.deepEqual(projectState(vm.snapshot()), before);

  port.failApply = false;
  port.failRead = true;
  const switchFailed = vm.switch("workspace-2");

  assert.equal(switchFailed.ok, false);
  if (switchFailed.ok) {
    assert.fail("expected failed read to reject");
  }
  assert.equal(switchFailed.error.code, "WM_READ_FAILED");
  assert.deepEqual(projectState(switchFailed.state), before);
});

function initialModel(): WindowModel {
  return createWindowModel({
    activeWorkspaceId: "workspace-1",
    focusStack: Object.freeze(["window:c", "window:b", "window:a"]),
    windows: Object.freeze([
      windowState("window:a", "workspace-1", 0),
      windowState("window:b", "workspace-2", 1),
      windowState("window:c", "workspace-1", 2),
    ]),
    workspaces: Object.freeze([
      workspace("workspace-1", "tile"),
      workspace("workspace-2", "stack"),
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
    rect: RECT,
    textureId: `texture:${id}`,
    workspaceId,
  });
}

function projectState(state: WorkspacesViewModelState) {
  return {
    activeWorkspaceId: state.activeWorkspaceId,
    activeWorkspaceIndex: state.activeWorkspaceIndex,
    activeWorkspacePosition: state.activeWorkspacePosition,
    windowCount: state.windowCount,
    workspaceCount: state.workspaceCount,
    workspaces: state.workspaces.map((workspaceState) => ({
      active: workspaceState.active,
      id: workspaceState.id,
      index: workspaceState.index,
      layout: workspaceState.layout,
      name: workspaceState.name,
      position: workspaceState.position,
      windowCount: workspaceState.windowCount,
      windowIds: workspaceState.windowIds,
    })),
  };
}

function lastApply(events: readonly string[]): string | null {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];

    if (event !== undefined && event.startsWith("apply:")) {
      return event;
    }
  }

  return null;
}

class FakeWorkspacesWindowManagerPort implements WorkspacesWindowManagerPort {
  events: string[] = [];
  failApply = false;
  failRead = false;
  #model: WindowModel;

  constructor(model: WindowModel) {
    this.#model = model;
  }

  get model(): WindowModel {
    return this.#model;
  }

  readWindowModel(): WorkspacesWindowManagerPortResult<WindowModel> {
    this.events.push("read");

    if (this.failRead) {
      return rejectPort("READ_FAILED", "configured read failure", "/fake/read");
    }

    return acceptPort(this.#model);
  }

  applyWindowModel(model: WindowModel): WorkspacesWindowManagerPortResult<WindowModel> {
    this.events.push(`apply:${model.activeWorkspaceId}:${model.workspaces.map((workspaceState) => workspaceState.id).join(",")}`);

    if (this.failApply) {
      return rejectPort("APPLY_FAILED", "configured apply failure", "/fake/apply");
    }

    this.#model = model;

    return acceptPort(this.#model);
  }
}

function acceptPort<T>(value: T): WorkspacesWindowManagerPortResult<T> {
  return Object.freeze({
    ok: true,
    value,
  });
}

function rejectPort<T>(
  code: string,
  message: string,
  path: string,
): WorkspacesWindowManagerPortResult<T> {
  return Object.freeze({
    error: Object.freeze({
      code,
      message,
      path,
    }),
    ok: false,
  });
}
