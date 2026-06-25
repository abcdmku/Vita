import assert from "node:assert/strict";
import { test } from "node:test";

import {
  activateContextMenu,
  closeContextMenu,
  closeContextMenuSubmenu,
  contextMenuActions,
  createContextMenuState,
  escapeContextMenu,
  findContextMenuCursor,
  flattenContextMenu,
  moveContextMenuCursorDown,
  moveContextMenuCursorUp,
  openContextMenu,
  openContextMenuSubmenu,
  reduceContextMenu,
} from "../../../../ui_kits/desktop/viewmodels/context-menu.ts";
import type {
  ContextMenu,
  ContextMenuRenderedEntry,
  ContextMenuState,
} from "../../../../ui_kits/desktop/viewmodels/context-menu.ts";

interface FixtureContext {
  readonly showAdvanced: boolean;
  readonly allowDanger: boolean;
}

type FixtureRole =
  | "open"
  | "disabled"
  | "advanced"
  | "new"
  | "new.folder"
  | "new.window"
  | "delete"
  | "pin";

test("context-menu flatten preserves sections, separators, submenu markers, flags, and visibility", () => {
  const flattened = flattenContextMenu(fixtureMenu(), visibleContext());

  assert.deepEqual(flattened.map(projectEntry), [
    ["item", "open", "primary", false, false, false, false],
    ["separator", "primary-separator", "primary", false, false, false, false],
    ["item", "disabled", "primary", true, false, false, false],
    ["item", "new", "primary", false, false, false, true],
    ["item", "delete", "danger", false, false, true, false],
    ["item", "pin", "danger", false, true, false, false],
  ]);
  assert.equal(flattened[0]?.kind, "item");
  if (flattened[0]?.kind !== "item") {
    assert.fail("expected first flattened entry to be an item");
  }
  assert.equal(flattened[0].label, "Open");
  assert.equal(flattened[0].icon, "lucide:file");
  assert.equal(flattened[0].role, "open");
  assert.deepEqual(flattened.map((entry) => entry.path), [
    ["open"],
    ["primary-separator"],
    ["disabled"],
    ["new"],
    ["delete"],
    ["pin"],
  ]);

  const hidden = flattenContextMenu(fixtureMenu(), {
    allowDanger: false,
    showAdvanced: true,
  });

  assert.deepEqual(hidden.map((entry) => entry.id), [
    "open",
    "primary-separator",
    "disabled",
    "advanced",
    "new",
    "pin",
  ]);
});

test("context-menu open and close are deterministic immutable state transitions", () => {
  const closed = createContextMenuState<FixtureContext, FixtureRole>();

  assert.equal(closed.open, false);
  assert.deepEqual(closed.items, []);

  const opened = openContextMenu(fixtureMenu(), visibleContext());

  assert.equal(opened.open, true);
  assert.deepEqual(opened.openSubmenuPath, []);
  assert.equal(opened.focusedCursor?.itemId, "open");
  assert.deepEqual(opened.items.map((entry) => entry.id), [
    "open",
    "primary-separator",
    "disabled",
    "new",
    "delete",
    "pin",
  ]);
  assert.equal(Object.isFrozen(opened), true);
  assert.equal(Object.isFrozen(opened.items), true);
  assert.equal(Object.isFrozen(opened.levels), true);

  const reopened = openContextMenu(fixtureMenu(), visibleContext());

  assert.deepEqual(JSON.stringify(projectState(opened)), JSON.stringify(projectState(reopened)));

  const closedAgain = closeContextMenu(opened);

  assert.equal(closedAgain.open, false);
  assert.equal(closedAgain.menu, null);
  assert.equal(closedAgain.focusedCursor, null);
  assert.deepEqual(closedAgain.items, []);
});

test("context-menu opens and closes nested submenus while preserving ordered levels", () => {
  const opened = openContextMenu(fixtureMenu(), visibleContext());
  const submenu = openContextMenuSubmenu(opened, "new");

  assert.equal(submenu.open, true);
  assert.deepEqual(submenu.openSubmenuPath, ["new"]);
  assert.equal(submenu.levels.length, 2);
  assert.deepEqual(submenu.items.map(projectEntry), [
    ["item", "new.folder", "create", false, true, false, false],
    ["separator", "submenu-separator", "create", false, false, false, false],
    ["item", "new.window", "create", false, false, false, false],
  ]);
  assert.equal(submenu.focusedCursor?.itemId, "new.folder");

  const closedSubmenu = closeContextMenuSubmenu(submenu);

  assert.equal(closedSubmenu.open, true);
  assert.deepEqual(closedSubmenu.openSubmenuPath, []);
  assert.equal(closedSubmenu.levels.length, 1);
  assert.equal(closedSubmenu.focusedCursor?.itemId, "new");

  const unchanged = openContextMenuSubmenu(opened, "disabled");

  assert.equal(unchanged, opened);
});

test("context-menu arrow traversal skips disabled items and separators with wraparound", () => {
  let state = openContextMenu(fixtureMenu(), visibleContext());

  assert.equal(state.focusedCursor?.itemId, "open");

  state = moveContextMenuCursorDown(state);
  assert.equal(state.focusedCursor?.itemId, "new");

  state = moveContextMenuCursorDown(state);
  assert.equal(state.focusedCursor?.itemId, "delete");

  state = moveContextMenuCursorDown(state);
  assert.equal(state.focusedCursor?.itemId, "pin");

  state = moveContextMenuCursorDown(state);
  assert.equal(state.focusedCursor?.itemId, "open");

  state = moveContextMenuCursorUp(state);
  assert.equal(state.focusedCursor?.itemId, "pin");
});

test("context-menu escape closes the deepest open level before closing the root menu", () => {
  const opened = openContextMenu(fixtureMenu(), visibleContext());
  const submenu = openContextMenuSubmenu(opened, "new");

  const escapedSubmenu = escapeContextMenu(submenu);

  assert.equal(escapedSubmenu.open, true);
  assert.deepEqual(escapedSubmenu.openSubmenuPath, []);
  assert.equal(escapedSubmenu.focusedCursor?.itemId, "new");

  const escapedRoot = escapeContextMenu(escapedSubmenu);

  assert.equal(escapedRoot.open, false);
  assert.deepEqual(escapedRoot.items, []);
});

test("context-menu activate invokes focused roles and disabled activate is a no-op", () => {
  const invoked: string[] = [];
  let state = openContextMenu(fixtureMenu(), visibleContext());

  state = moveContextMenuCursorDown(state);

  const activated = activateContextMenu(state, (role, item, context) => {
    invoked.push(`${role}:${item.id}:${context.allowDanger}`);
    return `value:${role}`;
  });

  assert.equal(activated.ok, true);
  assert.equal(activated.activated, true);
  if (!activated.activated) {
    assert.fail("expected enabled focused item to activate");
  }
  assert.equal(activated.role, "new");
  assert.equal(activated.value, "value:new");
  assert.deepEqual(invoked, ["new:new:true"]);

  const disabledCursor = findContextMenuCursor(state, "disabled");

  assert.notEqual(disabledCursor, null);
  if (disabledCursor === null || !state.open) {
    assert.fail("expected disabled item cursor to be available");
  }

  const disabledState: ContextMenuState<FixtureContext, FixtureRole> = Object.freeze({
    ...state,
    focusedCursor: disabledCursor,
  });
  const disabled = activateContextMenu(disabledState, (role) => {
    invoked.push(role);
  });

  assert.equal(disabled.ok, true);
  assert.equal(disabled.activated, false);
  if (disabled.activated) {
    assert.fail("expected disabled activation to be a no-op");
  }
  assert.equal(disabled.reason, "disabled");
  assert.deepEqual(invoked, ["new:new:true"]);
});

test("context-menu reducer accepts action objects and reports activation results", () => {
  const invoked: string[] = [];
  let transition = reduceContextMenu(
    createContextMenuState<FixtureContext, FixtureRole>(),
    contextMenuActions.open(fixtureMenu(), visibleContext()),
  );

  transition = reduceContextMenu(transition.state, contextMenuActions.moveDown());
  const activation = reduceContextMenu(transition.state, contextMenuActions.activate(), {
    invokeRole(role, item) {
      invoked.push(`${role}:${item.id}`);
      return true;
    },
  });

  assert.equal(activation.activation?.ok, true);
  assert.equal(activation.activation?.activated, true);
  assert.deepEqual(invoked, ["new:new"]);
});

function fixtureMenu(): ContextMenu<FixtureContext, FixtureRole> {
  return Object.freeze({
    sections: Object.freeze([
      Object.freeze({
        id: "primary",
        items: Object.freeze([
          item("open", "Open", "open", {
            icon: "lucide:file",
          }),
          separator("primary-separator"),
          item("disabled", "Disabled", "disabled", {
            disabled: true,
          }),
          item("advanced", "Advanced", "advanced", {
            visible: (context) => context.showAdvanced,
          }),
          item("throwing-hidden", "Throwing", "advanced", {
            visible: () => {
              throw new Error("hidden");
            },
          }),
          item("new", "New", "new", {
            submenu: Object.freeze({
              sections: Object.freeze([
                Object.freeze({
                  id: "create",
                  items: Object.freeze([
                    item("new.folder", "Folder", "new.folder", {
                      checked: true,
                    }),
                    separator("submenu-separator"),
                    item("hidden-submenu", "Hidden", "advanced", {
                      visible: (context) => context.showAdvanced,
                    }),
                    item("new.window", "Window", "new.window"),
                  ]),
                }),
              ]),
            }),
          }),
        ]),
      }),
      Object.freeze({
        id: "danger",
        items: Object.freeze([
          item("delete", "Delete", "delete", {
            destructive: true,
            visible: (context) => context.allowDanger,
          }),
          item("pin", "Pin", "pin", {
            checked: true,
          }),
        ]),
      }),
    ]),
  });
}

function visibleContext(): FixtureContext {
  return Object.freeze({
    allowDanger: true,
    showAdvanced: false,
  });
}

function item(
  id: string,
  label: string,
  role: FixtureRole,
  options: {
    readonly checked?: boolean;
    readonly destructive?: boolean;
    readonly disabled?: boolean;
    readonly icon?: string;
    readonly submenu?: ContextMenu<FixtureContext, FixtureRole>;
    readonly visible?: (context: FixtureContext) => boolean;
  } = Object.freeze({}),
): ContextMenu<FixtureContext, FixtureRole>["sections"][number]["items"][number] {
  const output: {
    kind: "item";
    id: string;
    label: string;
    role: FixtureRole;
    checked?: boolean;
    destructive?: boolean;
    disabled?: boolean;
    icon?: string;
    submenu?: ContextMenu<FixtureContext, FixtureRole>;
    visible?: (context: FixtureContext) => boolean;
  } = {
    id,
    kind: "item",
    label,
    role,
  };

  if (options.checked !== undefined) output.checked = options.checked;
  if (options.destructive !== undefined) output.destructive = options.destructive;
  if (options.disabled !== undefined) output.disabled = options.disabled;
  if (options.icon !== undefined) output.icon = options.icon;
  if (options.submenu !== undefined) output.submenu = options.submenu;
  if (options.visible !== undefined) output.visible = options.visible;
  return Object.freeze(output);
}

function separator(id: string): ContextMenu<FixtureContext, FixtureRole>["sections"][number]["items"][number] {
  return Object.freeze({
    id,
    kind: "separator",
  });
}

function projectEntry(entry: ContextMenuRenderedEntry<FixtureRole>): readonly [
  string,
  string,
  string | undefined,
  boolean,
  boolean,
  boolean,
  boolean,
] {
  if (entry.kind === "separator") {
    return [
      entry.kind,
      entry.id,
      entry.sectionId,
      false,
      false,
      false,
      false,
    ];
  }

  return [
    entry.kind,
    entry.id,
    entry.sectionId,
    entry.disabled,
    entry.checked,
    entry.destructive,
    entry.hasSubmenu,
  ];
}

function projectState(state: ContextMenuState<FixtureContext, FixtureRole>): unknown {
  return {
    focusedCursor: state.focusedCursor,
    items: state.items.map(projectEntry),
    open: state.open,
    openSubmenuPath: state.openSubmenuPath,
  };
}
