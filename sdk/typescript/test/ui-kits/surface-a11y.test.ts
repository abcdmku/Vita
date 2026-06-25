import assert from "node:assert/strict";
import { test } from "node:test";

import {
  openContextMenu,
} from "../../../../ui_kits/desktop/viewmodels/context-menu.ts";
import type {
  ContextMenu,
} from "../../../../ui_kits/desktop/viewmodels/context-menu.ts";
import {
  createDesktopIconsViewModel,
} from "../../../../ui_kits/desktop/viewmodels/desktop-icons.ts";
import type {
  DesktopIconInput,
  DesktopIconsViewState,
} from "../../../../ui_kits/desktop/viewmodels/desktop-icons.ts";
import {
  createStageViewModel,
} from "../../../../ui_kits/desktop/viewmodels/stage.ts";
import type {
  StageViewModelState,
  StageWindowManagerIntent,
  StageWindowManagerPort,
  StageWindowManagerPortResult,
} from "../../../../ui_kits/desktop/viewmodels/stage.ts";
import {
  SURFACE_REDUCED_MOTION_SETTING_KEY,
  createSurfaceA11yProjection,
  createSurfaceFocusOrder,
  nextSurfaceFocus,
  readSurfaceMotionPreference,
  resolveSurfaceDragIntent,
  resolveSurfaceHotkey,
  surfaceFocusIdForIcon,
} from "../../../../ui_kits/desktop/viewmodels/surface-a11y.ts";
import type {
  SurfaceA11yInput,
  SurfaceActionIntent,
  SurfaceA11ySettingsPorts,
  SurfaceFocusOrder,
} from "../../../../ui_kits/desktop/viewmodels/surface-a11y.ts";
import {
  createWidgetHostModel,
} from "../../../../ui_kits/desktop/viewmodels/widget-host.ts";
import type {
  WidgetHostModel,
  WidgetHostState,
  WidgetPlacement,
} from "../../../../ui_kits/desktop/viewmodels/widget-host.ts";
import {
  createWindowModel,
} from "../../src/desktop-sdk/index.ts";
import type {
  DesktopCapabilityGrant,
  DesktopHostResult,
  DesktopSettingsReadRequest,
  DesktopUiPackageManifest,
  Rect,
  WindowModel,
  WindowState,
  WorkspaceState,
} from "../../src/desktop-sdk/index.ts";

interface MenuContext {
  readonly showDanger: boolean;
}

type MenuRole = "delete" | "disabled" | "open";

test("focus order is deterministic and Tab traversal is stable and reversible across surface regions", () => {
  const surface = surfaceFixture();
  const first = createSurfaceFocusOrder(surface);
  const second = createSurfaceFocusOrder(surface);

  assert.equal(JSON.stringify(projectFocus(first)), JSON.stringify(projectFocus(second)));
  assert.deepEqual(projectFocus(first), [
    ["wallpaper", "region", "Wallpaper"],
    ["icons", "region", "Desktop icons"],
    ["icons", "icon", "Archive"],
    ["icons", "icon", "Projects"],
    ["icons", "icon", "Alpha"],
    ["icons", "icon", "Zeta"],
    ["widgets", "region", "Widgets"],
    ["widgets", "widget", "Clock widget"],
    ["widgets", "widget", "Weather widget"],
    ["menu", "region", "Context menu"],
    ["menu", "menuitem", "Open"],
    ["menu", "menuitem", "Delete"],
    ["stage", "region", "Stage"],
    ["stage", "stage-window", "Window Alpha"],
    ["stage", "stage-window", "Window Beta"],
  ]);

  const firstId = first.nodes[0]?.id ?? null;
  const lastId = first.nodes[first.nodes.length - 1]?.id ?? null;

  assert.equal(nextSurfaceFocus(first, firstId, "backward")?.id, lastId);
  assert.equal(nextSurfaceFocus(first, lastId, "forward")?.id, firstId);

  for (let index = 0; index < first.nodes.length; index += 1) {
    const node = first.nodes[index];

    assert.notEqual(node, undefined);
    if (node === undefined) continue;

    const forward = nextSurfaceFocus(first, node.id, "forward");

    assert.notEqual(forward, null);
    if (forward === null) continue;
    assert.equal(nextSurfaceFocus(first, forward.id, "backward")?.id, node.id);
  }
});

test("ARIA projection reflects selected icon state and label changes while staying stable otherwise", () => {
  const icons = createIconsState();
  const surface = surfaceFixture({
    icons,
  });
  const firstTree = createSurfaceA11yProjection(surface).ariaTree;
  const secondTree = createSurfaceA11yProjection(surface).ariaTree;

  assert.equal(JSON.stringify(firstTree), JSON.stringify(secondTree));
  assert.deepEqual(projectIconAria(firstTree), [
    ["Archive", false],
    ["Projects", false],
    ["Alpha", true],
    ["Zeta", false],
  ]);

  const model = createDesktopIconsViewModel({
    icons: iconInputs(),
  });

  model.select("alpha");
  model.beginRename("alpha");
  const renamed = model.commitRename("Alpha Prime");

  assert.equal(renamed.ok, true);
  if (!renamed.ok) {
    assert.fail("expected rename to succeed");
  }

  const renamedTree = createSurfaceA11yProjection(surfaceFixture({
    icons: renamed.state,
  })).ariaTree;

  assert.notEqual(JSON.stringify(renamedTree), JSON.stringify(firstTree));
  assert.deepEqual(projectIconAria(renamedTree), [
    ["Archive", false],
    ["Projects", false],
    ["Alpha Prime", true],
    ["Zeta", false],
  ]);
});

test("hotkeys and Meta drag resolve to explicit surface intents without executing actions", () => {
  const surface = surfaceFixture({
    activeFocusId: surfaceFocusIdForIcon("alpha"),
  });

  const rename = resolveSurfaceHotkey(surface, {
    key: "F2",
  });
  const open = resolveSurfaceHotkey(surface, {
    key: "Enter",
  });
  const trash = resolveSurfaceHotkey(surface, {
    key: "Delete",
  });
  const right = resolveSurfaceHotkey(surface, {
    key: "ArrowRight",
  });
  const up = resolveSurfaceHotkey(surface, {
    key: "ArrowUp",
  });
  const copy = resolveSurfaceDragIntent(surface, {
    metaKey: true,
  });
  const plainDrag = resolveSurfaceDragIntent(surface, {
    metaKey: false,
  });

  assertIconIntent(rename, "rename", "alpha");
  assertIconIntent(open, "open", "alpha");
  assertIconIntent(trash, "trash", "alpha");

  assert.equal(right?.type, "focus");
  if (right?.type !== "focus") {
    assert.fail("expected ArrowRight to resolve to a focus intent");
  }
  assert.equal(right.direction, "right");
  assert.equal(right.fromId, surfaceFocusIdForIcon("alpha"));
  assert.equal(right.toId, surfaceFocusIdForIcon("zeta"));

  assert.equal(up?.type, "focus");
  if (up?.type !== "focus") {
    assert.fail("expected ArrowUp to resolve to a focus intent");
  }
  assert.equal(up.direction, "up");
  assert.equal(up.toId, surfaceFocusIdForIcon("projects"));

  assert.equal(copy?.type, "drag-copy");
  if (copy?.type !== "drag-copy") {
    assert.fail("expected Meta drag to resolve to a drag-copy intent");
  }
  assert.equal(copy.copy, true);
  assert.equal(copy.target?.kind, "icon");
  if (copy.target?.kind !== "icon") {
    assert.fail("expected drag-copy target to be the focused icon");
  }
  assert.equal(copy.target.id, "alpha");
  assert.equal(plainDrag, null);
});

test("reduced motion reflects granted settings and falls back to fail-closed motion-disabled default", async () => {
  const grantedFalse = fakeMotionPorts({
    grants: [grant("settings.read", SURFACE_REDUCED_MOTION_SETTING_KEY)],
    value: false,
  });
  const motionAllowed = await readSurfaceMotionPreference(grantedFalse.ports);

  assert.deepEqual(motionAllowed, {
    motionAllowed: true,
    reducedMotion: false,
    source: "settings",
  });
  assert.deepEqual(grantedFalse.events, [`read:${SURFACE_REDUCED_MOTION_SETTING_KEY}`]);

  const grantedTrue = fakeMotionPorts({
    grants: [grant("settings.read", SURFACE_REDUCED_MOTION_SETTING_KEY)],
    value: true,
  });
  const reduced = await readSurfaceMotionPreference(grantedTrue.ports);

  assert.deepEqual(reduced, {
    motionAllowed: false,
    reducedMotion: true,
    source: "settings",
  });

  const missingGrant = fakeMotionPorts({
    grants: [],
    value: false,
  });
  const fallback = await readSurfaceMotionPreference(missingGrant.ports);

  assert.deepEqual(fallback, {
    motionAllowed: false,
    reducedMotion: true,
    source: "default",
  });
  assert.deepEqual(missingGrant.events, []);
});

function surfaceFixture(
  overrides: {
    readonly activeFocusId?: string | null;
    readonly icons?: DesktopIconsViewState;
    readonly stage?: StageViewModelState;
    readonly widgets?: WidgetHostState;
  } = Object.freeze({}),
): SurfaceA11yInput<MenuContext, MenuRole> {
  const output: {
    icons: DesktopIconsViewState;
    menu: ReturnType<typeof openContextMenu<MenuContext, MenuRole>>;
    stage: StageViewModelState;
    widgets: WidgetHostState;
    activeFocusId?: string | null;
  } = {
    icons: overrides.icons ?? createIconsState(),
    menu: openContextMenu(menuFixture(), Object.freeze({
      showDanger: true,
    })),
    stage: overrides.stage ?? createStageState(),
    widgets: overrides.widgets ?? createWidgetsState(),
  };

  if (overrides.activeFocusId !== undefined) output.activeFocusId = overrides.activeFocusId;
  return Object.freeze(output);
}

function createIconsState(): DesktopIconsViewState {
  const model = createDesktopIconsViewModel({
    icons: iconInputs(),
  });

  return model.select("alpha");
}

function iconInputs(): readonly DesktopIconInput[] {
  return Object.freeze([
    iconInput("zeta", "Zeta", "file", 3, 0),
    iconInput("projects", "Projects", "folder", 2, 0),
    iconInput("alpha", "Alpha", "app", 1, 0),
    iconInput("archive", "Archive", "directory", 0, 0),
  ]);
}

function iconInput(id: string, label: string, kind: string, x: number, y: number): DesktopIconInput {
  return Object.freeze({
    iconRef: `${kind}:${id}`,
    id,
    kind,
    label,
    position: Object.freeze({
      x,
      y,
    }),
  });
}

function createWidgetsState(): WidgetHostState {
  const vm = createWidgetHostModel({
    zones: Object.freeze([
      Object.freeze({
        columns: 4,
        id: "desktop",
        rows: 2,
      }),
    ]),
  });

  mustAddWidget(vm, "clock", placement(0, 0));
  mustAddWidget(vm, "weather", placement(1, 0));

  return vm.snapshot();
}

function mustAddWidget(vm: WidgetHostModel, kind: "clock" | "weather", at: WidgetPlacement): void {
  const result = vm.add(kind, at);

  assert.equal(result.ok, true);
  if (!result.ok) {
    assert.fail(`expected ${kind} widget to be added`);
  }
}

function placement(column: number, row: number): WidgetPlacement {
  return Object.freeze({
    column,
    row,
    zone: "desktop",
  });
}

function menuFixture(): ContextMenu<MenuContext, MenuRole> {
  return Object.freeze({
    sections: Object.freeze([
      Object.freeze({
        items: Object.freeze([
          menuItem("open", "Open", "open"),
          menuItem("disabled", "Disabled", "disabled", true),
          menuItem("delete", "Delete", "delete", false, (context) => context.showDanger),
        ]),
      }),
    ]),
  });
}

function menuItem(
  id: string,
  label: string,
  role: MenuRole,
  disabled = false,
  visible?: (context: MenuContext) => boolean,
): ContextMenu<MenuContext, MenuRole>["sections"][number]["items"][number] {
  const output: {
    kind: "item";
    id: string;
    label: string;
    role: MenuRole;
    disabled?: boolean;
    visible?: (context: MenuContext) => boolean;
  } = {
    id,
    kind: "item",
    label,
    role,
  };

  if (disabled) output.disabled = disabled;
  if (visible !== undefined) output.visible = visible;
  return Object.freeze(output);
}

function createStageState(): StageViewModelState {
  const vm = createStageViewModel({
    describeWindow(window) {
      return Object.freeze({
        appId: `app:${window.id}`,
        title: window.id === "window:a" ? "Window Alpha" : "Window Beta",
      });
    },
    wm: new FakeStageWindowManagerPort(createStageModel()),
  });

  return vm.snapshot();
}

function createStageModel(): WindowModel {
  return createWindowModel({
    activeWorkspaceId: "workspace-1",
    focusStack: Object.freeze(["window:a"]),
    windows: Object.freeze([
      windowState("window:b", "workspace-1", 20),
      windowState("window:a", "workspace-1", 10),
    ]),
    workspaces: Object.freeze([
      workspace("workspace-1"),
    ]),
  });
}

function workspace(id: string): WorkspaceState {
  return Object.freeze({
    id,
    layout: "tile",
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

const SOURCE_RECT = Object.freeze({
  height: 480,
  width: 640,
  x: 0,
  y: 0,
}) satisfies Rect;

class FakeStageWindowManagerPort implements StageWindowManagerPort {
  readonly #model: WindowModel;

  constructor(model: WindowModel) {
    this.#model = model;
  }

  readWindowModel(): StageWindowManagerPortResult<WindowModel> {
    return Object.freeze({
      ok: true,
      value: this.#model,
    });
  }

  applyWindowManagerIntents(
    _intents: readonly StageWindowManagerIntent[],
  ): StageWindowManagerPortResult<WindowModel> {
    return Object.freeze({
      ok: true,
      value: this.#model,
    });
  }
}

function fakeMotionPorts(options: {
  readonly grants: readonly DesktopCapabilityGrant[];
  readonly value: boolean;
}): {
  readonly events: string[];
  readonly ports: SurfaceA11ySettingsPorts;
} {
  const events: string[] = [];

  return {
    events,
    ports: Object.freeze({
      package: manifest(options.grants),
      readSetting(request: DesktopSettingsReadRequest): DesktopHostResult<boolean> {
        events.push(`read:${request.key}`);
        return Object.freeze({
          ok: true,
          value: options.value,
        });
      },
    }),
  };
}

function grant(capability: "settings.read", resourceId: string): DesktopCapabilityGrant {
  return Object.freeze({
    capability,
    resourceId,
  });
}

function manifest(grants: readonly DesktopCapabilityGrant[]): DesktopUiPackageManifest {
  return Object.freeze({
    capabilityGrants: Object.freeze(grants.map((entry) => Object.freeze(entry))),
    entry: "./surface-a11y.test.ts",
    id: "surface-a11y-test",
    sdkVersion: "1.0.0",
    version: "1.0.0",
  });
}

function projectFocus(order: SurfaceFocusOrder): readonly (readonly [string, string, string])[] {
  return Object.freeze(order.nodes.map((node) => Object.freeze([
    node.region,
    node.kind,
    node.label,
  ] as const)));
}

function projectIconAria(tree: ReturnType<typeof createSurfaceA11yProjection>["ariaTree"]): readonly (readonly [string, boolean])[] {
  const icons = tree.root.children[1];

  assert.equal(icons?.id, "surface-a11y-icons");
  assert.notEqual(icons, undefined);
  if (icons === undefined) {
    return Object.freeze([]);
  }

  return Object.freeze(icons.children.map((child) => Object.freeze([
    child.label,
    child.selected === true,
  ] as const)));
}

function assertIconIntent(intent: SurfaceActionIntent | null, type: "open" | "rename" | "trash", iconId: string): void {
  assert.equal(intent?.type, type);
  if (intent?.type !== type) {
    assert.fail(`expected ${type} intent`);
  }
  assert.equal(intent.target?.kind, "icon");
  if (intent.target?.kind !== "icon") {
    assert.fail(`expected ${type} target to be an icon`);
  }
  assert.equal(intent.target.id, iconId);
}
