import assert from "node:assert/strict";
import { test } from "node:test";

import {
  createDesktopIconGrid,
  gridCellToPixel,
  pixelToGridCell,
} from "../../../../ui_kits/desktop/viewmodels/desktop-icons.ts";
import type {
  DesktopIcon,
  DesktopIconGridCell,
  DesktopIconInput,
} from "../../../../ui_kits/desktop/viewmodels/desktop-icons.ts";
import {
  createMultiMonitorSurfaceModel,
} from "../../../../ui_kits/desktop/viewmodels/multi-monitor.ts";
import type {
  MultiMonitorDisplayInput,
  MultiMonitorSurfaceModelOptions,
  MultiMonitorSurfaceState,
} from "../../../../ui_kits/desktop/viewmodels/multi-monitor.ts";
import {
  widgetInstancesOverlap,
} from "../../../../ui_kits/desktop/viewmodels/widget-host.ts";
import type {
  WidgetInstance,
} from "../../../../ui_kits/desktop/viewmodels/widget-host.ts";
import type {
  Rect,
  WindowModel,
  WindowState,
} from "../../src/desktop-sdk/index.ts";

const GRID = createDesktopIconGrid({
  cell: {
    height: 32,
    width: 32,
  },
  columns: 4,
  gutter: {
    x: 8,
    y: 8,
  },
  origin: {
    x: 0,
    y: 0,
  },
});

test("displayForPoint and displayForWindow choose containment, max overlap, and deterministic ties", () => {
  const model = createMultiMonitorSurfaceModel({
    displays: [
      display("right", 100, 0, 100, 100, false),
      display("primary", 0, 0, 100, 100, true),
    ],
  });

  assert.deepEqual(model.state.displays.map((item) => item.id), ["primary", "right"]);
  assert.equal(model.displayForPoint({
    x: 10,
    y: 10,
  })?.id, "primary");
  assert.equal(model.displayForPoint({
    x: 125,
    y: 10,
  })?.id, "right");
  assert.equal(model.displayForPoint({
    x: 250,
    y: 10,
  }), null);

  assert.equal(model.displayForWindow(rect(90, 10, 80, 20))?.id, "right");
  assert.equal(model.displayForWindow(rect(80, 10, 40, 20))?.id, "primary");

  const tieModel = createMultiMonitorSurfaceModel({
    displays: [
      display("primary", -200, 0, 100, 100, true),
      display("b", 0, 0, 100, 100, false),
      display("a", 0, 0, 100, 100, false),
    ],
  });

  assert.equal(tieModel.displayForWindow(rect(10, 10, 20, 20))?.id, "a");
});

test("WM window rects and WindowModel entries map to the owning display", () => {
  const model = createMultiMonitorSurfaceModel({
    displays: defaultDisplays(),
  });
  const windowValue: WindowState = Object.freeze({
    id: "window-1",
    maximized: false,
    minimized: false,
    mode: "floating",
    order: 0,
    rect: rect(130, 20, 40, 30),
    textureId: "texture-1",
    workspaceId: "workspace-1",
  });
  const windowModel: WindowModel = Object.freeze({
    activeWorkspaceId: "workspace-1",
    focusStack: Object.freeze(["window-1"]),
    windows: Object.freeze([windowValue]),
    workspaces: Object.freeze([
      Object.freeze({
        id: "workspace-1",
        layout: "floating",
      }),
    ]),
  });

  assert.equal(model.displayForWindow(windowValue)?.id, "secondary");
  assert.equal(model.displayForWindowModel(windowModel, "window-1")?.id, "secondary");
});

test("display removal migrates icons and widgets to primary with collision-free deterministic reflow", () => {
  const first = reflowFixture();
  const second = reflowFixture();

  const firstRemoved = first.setDisplays([
    display("primary", 0, 0, 100, 100, true),
  ]);
  const secondRemoved = second.setDisplays([
    display("primary", 0, 0, 100, 100, true),
  ]);
  const repeated = first.setDisplays([
    display("primary", 0, 0, 100, 100, true),
  ]);

  assert.deepEqual(iconDisplays(firstRemoved), [
    ["primary-a", "primary"],
    ["secondary-b", "primary"],
    ["secondary-c", "primary"],
  ]);
  assert.deepEqual(widgetDisplays(firstRemoved), [
    ["widget-primary", "primary"],
    ["widget-secondary", "primary"],
  ]);
  assertUniqueIconCells(firstRemoved, "primary");
  assertNoWidgetOverlaps(firstRemoved);
  assert.equal(reflowBytes(firstRemoved), reflowBytes(secondRemoved));
  assert.equal(reflowBytes(firstRemoved), reflowBytes(repeated));
});

test("re-adding a display restores remembered icon and widget ownership", () => {
  const model = reflowFixture();

  model.setDisplays([
    display("primary", 0, 0, 100, 100, true),
  ]);
  const restored = model.setDisplays(defaultDisplays());

  assert.deepEqual(iconDisplays(restored), [
    ["primary-a", "primary"],
    ["secondary-b", "secondary"],
    ["secondary-c", "secondary"],
  ]);
  assert.deepEqual(widgetDisplays(restored), [
    ["widget-primary", "primary"],
    ["widget-secondary", "secondary"],
  ]);
  assertUniqueIconCells(restored, "secondary");
  assertNoWidgetOverlaps(restored);
});

test("per-display wallpaper refs are independent", () => {
  const model = createMultiMonitorSurfaceModel({
    displays: defaultDisplays(),
  });

  model.setWallpaper("primary", "wallpaper:primary");
  model.setWallpaper("secondary", "wallpaper:secondary");
  const changed = model.setWallpaper("primary", "wallpaper:primary-next");

  assert.equal(wallpaperRef(changed, "primary"), "wallpaper:primary-next");
  assert.equal(wallpaperRef(changed, "secondary"), "wallpaper:secondary");
});

test("mapping and assignment actions do not touch injected ports", () => {
  let portReads = 0;
  const options: MultiMonitorSurfaceModelOptions = {
    displays: defaultDisplays(),
    get ports(): never {
      portReads += 1;
      throw new Error("multi-monitor tests must not read ports");
    },
    iconAssignments: [
      ownership("primary-a", "primary"),
      ownership("secondary-b", "secondary"),
    ],
    icons: [
      icon("primary-a", "Primary A", cell(0, 0)),
      icon("secondary-b", "Secondary B", cell(0, 0)),
    ],
    widgetAssignments: [
      ownership("widget-primary", "primary"),
      ownership("widget-secondary", "secondary"),
    ],
    widgets: [
      widget("widget-primary", "primary", 0, 0),
      widget("widget-secondary", "secondary", 0, 0),
    ],
  };
  const model = createMultiMonitorSurfaceModel(options);

  model.displayForPoint({
    x: 10,
    y: 10,
  });
  model.displayForWindow(rect(130, 10, 10, 10));
  model.assignIcon("primary-a", "secondary");
  model.assignWidget("widget-primary", "secondary");

  assert.equal(portReads, 0);
});

function reflowFixture() {
  return createMultiMonitorSurfaceModel({
    displays: defaultDisplays(),
    iconAssignments: [
      ownership("primary-a", "primary"),
      ownership("secondary-b", "secondary"),
      ownership("secondary-c", "secondary"),
    ],
    iconGrid: GRID,
    icons: [
      icon("primary-a", "Primary A", cell(0, 0)),
      icon("secondary-b", "Secondary B", cell(0, 0)),
      icon("secondary-c", "Secondary C", cell(1, 0)),
    ],
    widgetAssignments: [
      ownership("widget-primary", "primary"),
      ownership("widget-secondary", "secondary"),
    ],
    widgets: [
      widget("widget-primary", "primary", 0, 0),
      widget("widget-secondary", "secondary", 0, 0),
    ],
  });
}

function defaultDisplays(): readonly MultiMonitorDisplayInput[] {
  return Object.freeze([
    display("secondary", 100, 0, 100, 100, false),
    display("primary", 0, 0, 100, 100, true),
  ]);
}

function display(
  id: string,
  x: number,
  y: number,
  w: number,
  h: number,
  primary: boolean,
): MultiMonitorDisplayInput {
  return Object.freeze({
    bounds: Object.freeze({
      h,
      w,
      x,
      y,
    }),
    id,
    primary,
    scale: 1,
  });
}

function ownership(id: string, displayId: string) {
  return Object.freeze({
    displayId,
    id,
  });
}

function rect(x: number, y: number, width: number, height: number): Rect {
  return Object.freeze({
    height,
    width,
    x,
    y,
  });
}

function cell(col: number, row: number): DesktopIconGridCell {
  return Object.freeze({
    col,
    row,
  });
}

function icon(
  id: string,
  label: string,
  iconCell: DesktopIconGridCell,
): DesktopIconInput {
  return Object.freeze({
    iconRef: `doc:${id}`,
    id,
    kind: "doc",
    label,
    position: gridCellToPixel(iconCell, GRID),
  });
}

function widget(
  id: string,
  zone: string,
  column: number,
  row: number,
): WidgetInstance {
  return Object.freeze({
    enabled: true,
    id,
    kind: "clock",
    paused: false,
    placement: Object.freeze({
      column,
      row,
      zone,
    }),
    refreshIntervalMs: 60_000,
    sizeClass: "S",
  });
}

function iconDisplays(state: MultiMonitorSurfaceState): readonly (readonly [string, string])[] {
  return Object.freeze(state.icons.map((entry) => Object.freeze([entry.iconId, entry.displayId] as const)));
}

function widgetDisplays(state: MultiMonitorSurfaceState): readonly (readonly [string, string])[] {
  return Object.freeze(state.widgets.map((entry) => Object.freeze([entry.widgetId, entry.displayId] as const)));
}

function wallpaperRef(state: MultiMonitorSurfaceState, displayId: string): string | null {
  for (let index = 0; index < state.wallpapers.length; index += 1) {
    const wallpaper = state.wallpapers[index];

    if (wallpaper !== undefined && wallpaper.displayId === displayId) return wallpaper.ref;
  }

  assert.fail(`missing wallpaper for ${displayId}`);
}

function assertUniqueIconCells(state: MultiMonitorSurfaceState, displayId: string): void {
  const seen = new Set<string>();

  for (let index = 0; index < state.icons.length; index += 1) {
    const entry = state.icons[index];

    if (entry === undefined || entry.displayId !== displayId) continue;

    const iconCell = pixelToGridCell(entry.icon.position, GRID);
    const key = `${iconCell.col}:${iconCell.row}`;

    assert.equal(seen.has(key), false, `duplicate icon cell ${key}`);
    seen.add(key);
  }
}

function assertNoWidgetOverlaps(state: MultiMonitorSurfaceState): void {
  for (let leftIndex = 0; leftIndex < state.widgetState.instances.length; leftIndex += 1) {
    const left = state.widgetState.instances[leftIndex];

    if (left === undefined) continue;

    for (let rightIndex = leftIndex + 1; rightIndex < state.widgetState.instances.length; rightIndex += 1) {
      const right = state.widgetState.instances[rightIndex];

      if (right !== undefined) {
        assert.equal(widgetInstancesOverlap(left, right), false, `${left.id} overlaps ${right.id}`);
      }
    }
  }
}

function reflowBytes(state: MultiMonitorSurfaceState): string {
  return JSON.stringify({
    icons: state.icons.map((entry) => {
      const iconCell = pixelToGridCell(entry.icon.position, GRID);

      return [entry.iconId, entry.displayId, iconCell.col, iconCell.row];
    }),
    widgets: state.widgets.map((entry) => [
      entry.widgetId,
      entry.displayId,
      entry.widget.placement.zone,
      entry.widget.placement.column,
      entry.widget.placement.row,
    ]),
  });
}
