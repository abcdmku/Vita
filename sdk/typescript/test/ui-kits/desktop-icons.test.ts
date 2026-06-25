import assert from "node:assert/strict";
import { test } from "node:test";

import {
  createDesktopIconGrid,
  createDesktopIconsViewModel,
  gridCellToPixel,
  pixelToGridCell,
} from "../../../../ui_kits/desktop/viewmodels/desktop-icons.ts";
import type {
  DesktopIcon,
  DesktopIconGridCell,
  DesktopIconInput,
  DesktopIconSortKey,
  DesktopIconsViewState,
} from "../../../../ui_kits/desktop/viewmodels/desktop-icons.ts";
import type {
  FilesCapabilityPort,
  FilesErrorResponse,
  FilesRequest,
  FilesResponse,
  ShellCapabilityPort,
  ShellCapabilityRequest,
} from "../../src/desktop-sdk/index.ts";

const GRID = createDesktopIconGrid({
  cell: {
    height: 32,
    width: 32,
  },
  columns: 2,
  gutter: {
    x: 8,
    y: 8,
  },
  origin: {
    x: 0,
    y: 0,
  },
});

test("marquee selects icons whose boxes overlap the rubber-band rect and only those icons", () => {
  const model = createDesktopIconsViewModel({
    grid: GRID,
    icons: [
      icon("a", "Alpha", "doc", {
        col: 0,
        row: 0,
      }),
      icon("b", "Beta", "doc", {
        col: 1,
        row: 0,
      }),
      icon("c", "Gamma", "doc", {
        col: 0,
        row: 1,
      }),
      icon("d", "Delta", "doc", {
        col: 3,
        row: 0,
      }),
    ],
  });

  model.beginMarquee({
    x: 30,
    y: 10,
  });
  const selected = model.updateMarquee({
    x: 75,
    y: 35,
  });

  assert.deepEqual(selected.marquee, {
    height: 25,
    width: 45,
    x: 30,
    y: 10,
  });
  assert.deepEqual(selected.selectedIds, ["a", "b"]);

  const ended = model.endMarquee();

  assert.equal(ended.marquee, null);
  assert.deepEqual(ended.selectedIds, ["a", "b"]);
});

test("single, ctrl-style toggle, and shift-style range selection are deterministic", () => {
  const model = createDesktopIconsViewModel({
    grid: GRID,
    icons: defaultIcons(),
  });

  assert.deepEqual(model.select("b").selectedIds, ["b"]);
  assert.deepEqual(model.toggle("d").selectedIds, ["b", "d"]);
  assert.deepEqual(model.toggle("b").selectedIds, ["d"]);
  assert.deepEqual(model.select("a").selectedIds, ["a"]);
  assert.deepEqual(model.extendTo("c").selectedIds, ["a", "b", "c"]);
});

test("drag move snaps to grid and resolves collisions without duplicate cells", () => {
  const model = createDesktopIconsViewModel({
    grid: GRID,
    icons: [
      icon("a", "Alpha", "doc", {
        col: 0,
        row: 0,
      }),
      icon("b", "Beta", "doc", {
        col: 1,
        row: 0,
      }),
      icon("c", "Gamma", "doc", {
        col: 3,
        row: 0,
      }),
    ],
  });

  model.select("b");
  model.beginDrag("b");
  let moved = model.moveBy(40, 0);

  assert.deepEqual(cellById(moved, "b"), {
    col: 2,
    row: 0,
  });
  assertUniqueCells(moved);

  model.endDrag();
  model.beginDrag("b");
  moved = model.moveBy(-80, 0);

  assert.deepEqual(cellById(moved, "b"), {
    col: 1,
    row: 0,
  });
  assertUniqueCells(moved);
});

test("auto-arrange and all sort keys produce stable byte-identical grid layouts", () => {
  const icons = sortFixtureIcons();
  const arrangedA = createDesktopIconsViewModel({
    grid: GRID,
    icons,
  }).autoArrange();
  const arrangedB = createDesktopIconsViewModel({
    grid: GRID,
    icons,
  }).autoArrange();

  assert.equal(layoutBytes(arrangedA), layoutBytes(arrangedB));
  assert.deepEqual(projectLayout(arrangedA), [
    ["gamma", 0, 0],
    ["alpha", 1, 0],
    ["beta", 0, 1],
    ["delta", 1, 1],
  ]);

  const expectations = new Map<DesktopIconSortKey, readonly string[]>([
    ["name", ["alpha", "beta", "delta", "gamma"]],
    ["kind", ["alpha", "delta", "gamma", "beta"]],
    ["date", ["alpha", "beta", "gamma", "delta"]],
    ["size", ["beta", "alpha", "delta", "gamma"]],
  ]);
  const keys: readonly DesktopIconSortKey[] = Object.freeze(["name", "kind", "date", "size"]);

  for (let index = 0; index < keys.length; index += 1) {
    const key = keys[index];

    if (key === undefined) continue;

    const first = createDesktopIconsViewModel({
      grid: GRID,
      icons,
    }).sortBy(key);
    const second = createDesktopIconsViewModel({
      grid: GRID,
      icons,
    }).sortBy(key);

    assert.equal(layoutBytes(first), layoutBytes(second));
    assert.deepEqual(first.icons.map((item) => item.id), expectations.get(key));
    assert.deepEqual(projectLayout(first), expectedGridOrder(expectations.get(key) ?? Object.freeze([])));
  }
});

test("commitRename rejects blank and duplicate labels and accepts a unique label", () => {
  const model = createDesktopIconsViewModel({
    grid: GRID,
    icons: defaultIcons(),
  });

  model.beginRename("a");

  const blank = model.commitRename("   ");

  assert.equal(blank.ok, false);
  if (blank.ok) {
    assert.fail("expected blank rename to fail");
  }
  assert.equal(blank.error.code, "INVALID_RENAME_LABEL");
  assert.deepEqual(blank.state.renameDraft, {
    id: "a",
    label: "Alpha",
  });

  const duplicate = model.commitRename("Beta");

  assert.equal(duplicate.ok, false);
  if (duplicate.ok) {
    assert.fail("expected duplicate rename to fail");
  }
  assert.equal(duplicate.error.code, "DUPLICATE_RENAME_LABEL");

  const renamed = model.commitRename("  Project Plan  ");

  assert.equal(renamed.ok, true);
  if (!renamed.ok) {
    assert.fail("expected unique rename to succeed");
  }
  assert.equal(iconById(renamed.state.icons, "a").label, "Project Plan");
  assert.equal(renamed.state.renameDraft, null);
  assert.equal(renamed.state.error, null);
});

test("geometry and selection actions do not trigger injected SDK ports", () => {
  const calls: string[] = [];
  const model = createDesktopIconsViewModel({
    grid: GRID,
    icons: defaultIcons(),
    ports: {
      files: fakeFilesPort(calls),
      shell: fakeShellPort(calls),
    },
  });

  model.select("a");
  model.toggle("b");
  model.extendTo("d");
  model.beginMarquee({
    x: 0,
    y: 0,
  });
  model.updateMarquee({
    x: 90,
    y: 90,
  });
  model.endMarquee();
  model.beginDrag("a");
  model.moveBy(40, 40);
  model.endDrag();
  model.beginRename("a");

  const renamed = model.commitRename("Unique");

  assert.equal(renamed.ok, true);
  model.autoArrange();
  model.sortBy("name");
  model.setMode("free");
  model.setMode("grid");
  model.setIcons(defaultIcons());

  assert.deepEqual(calls, []);
});

function defaultIcons(): readonly DesktopIconInput[] {
  return Object.freeze([
    icon("a", "Alpha", "doc", {
      col: 0,
      row: 0,
    }),
    icon("b", "Beta", "doc", {
      col: 1,
      row: 0,
    }),
    icon("c", "Gamma", "app", {
      col: 0,
      row: 1,
    }),
    icon("d", "Delta", "app", {
      col: 1,
      row: 1,
    }),
  ]);
}

function sortFixtureIcons(): readonly DesktopIconInput[] {
  return Object.freeze([
    icon("gamma", "Gamma", "doc", {
      col: 3,
      row: 2,
    }, "2026-03-01T00:00:00Z", 30),
    icon("alpha", "Alpha", "app", {
      col: 2,
      row: 2,
    }, "2026-01-01T00:00:00Z", 20),
    icon("beta", "Beta", "doc", {
      col: 1,
      row: 2,
    }, "2026-02-01T00:00:00Z", 10),
    icon("delta", "Delta", "app", {
      col: 0,
      row: 2,
    }, "2026-04-01T00:00:00Z", 20),
  ]);
}

function icon(
  id: string,
  label: string,
  kind: string,
  cell: DesktopIconGridCell,
  date?: string,
  size?: number,
): DesktopIconInput {
  const output: {
    date?: string;
    iconRef: string;
    id: string;
    kind: string;
    label: string;
    position: ReturnType<typeof gridCellToPixel>;
    size?: number;
  } = {
    iconRef: `${kind}:${id}`,
    id,
    kind,
    label,
    position: gridCellToPixel(cell, GRID),
  };

  if (date !== undefined) output.date = date;
  if (size !== undefined) output.size = size;

  return Object.freeze(output);
}

function iconById(icons: readonly DesktopIcon[], id: string): DesktopIcon {
  for (let index = 0; index < icons.length; index += 1) {
    const iconValue = icons[index];

    if (iconValue !== undefined && iconValue.id === id) return iconValue;
  }

  assert.fail(`missing icon '${id}'`);
}

function cellById(state: DesktopIconsViewState, id: string): DesktopIconGridCell {
  return pixelToGridCell(iconById(state.icons, id).position, GRID);
}

function assertUniqueCells(state: DesktopIconsViewState): void {
  const seen = new Set<string>();

  for (let index = 0; index < state.icons.length; index += 1) {
    const iconValue = state.icons[index];

    if (iconValue === undefined) continue;

    const cell = pixelToGridCell(iconValue.position, GRID);
    const key = `${cell.row}:${cell.col}`;

    assert.equal(seen.has(key), false, `duplicate cell ${key}`);
    seen.add(key);
  }
}

function projectLayout(state: DesktopIconsViewState): readonly (readonly [string, number, number])[] {
  return Object.freeze(state.icons.map((iconValue) => {
    const cell = pixelToGridCell(iconValue.position, GRID);

    return Object.freeze([iconValue.id, cell.col, cell.row] as const);
  }));
}

function expectedGridOrder(ids: readonly string[]): readonly (readonly [string, number, number])[] {
  return Object.freeze(ids.map((id, index) => Object.freeze([
    id,
    index % GRID.columns,
    Math.floor(index / GRID.columns),
  ] as const)));
}

function layoutBytes(state: DesktopIconsViewState): string {
  return JSON.stringify(projectLayout(state));
}

function fakeFilesPort(calls: string[]): FilesCapabilityPort {
  return {
    request(request: FilesRequest): FilesResponse | FilesErrorResponse {
      calls.push(`files:${request.op}`);
      return Object.freeze({
        error: Object.freeze({
          code: "UnexpectedPortCall",
          message: "desktop icon tests must not call files ports",
        }),
      });
    },
  };
}

function fakeShellPort(calls: string[]): ShellCapabilityPort {
  return {
    hasGrant(request: ShellCapabilityRequest): boolean {
      calls.push(`shell:${request.capability}:${request.resourceId}`);
      return false;
    },
  };
}
