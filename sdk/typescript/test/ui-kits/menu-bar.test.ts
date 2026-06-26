import assert from "node:assert/strict";
import { test } from "node:test";

import {
  MENU_BAR_MENU_IDS,
  createMenuBarViewModel,
} from "../../../../ui_kits/desktop/viewmodels/menu-bar.ts";
import type {
  MenuBarItem,
  MenuBarMenu,
  MenuBarTreeInput,
} from "../../../../ui_kits/desktop/viewmodels/menu-bar.ts";
import {
  createCommandRegistry,
} from "../../../../ui_kits/desktop/viewmodels/command-registry.ts";
import type {
  CommandAction,
  CommandContext,
  CommandDefinition,
  CommandRegistryViewModel,
} from "../../../../ui_kits/desktop/viewmodels/command-registry.ts";

const BASE_TREE: MenuBarTreeInput = Object.freeze({
  menus: Object.freeze([
    Object.freeze({
      id: MENU_BAR_MENU_IDS.file,
      items: Object.freeze([
        item("file.new", "New", "cmd.new", "Cmd+N"),
        item("file.disabled", "Disabled Export", "cmd.export", "Cmd+E", true),
        item("file.unknownCommand", "Unknown Command", "cmd.missing"),
      ]),
    }),
    Object.freeze({
      id: MENU_BAR_MENU_IDS.edit,
      items: Object.freeze([
        item("edit.copy", "Copy", "cmd.copy", "Cmd+C"),
        item("edit.submenu", "Transform", undefined, undefined, false, Object.freeze([
          item("edit.submenu.uppercase", "Uppercase", "cmd.uppercase"),
        ])),
      ]),
    }),
    Object.freeze({
      id: MENU_BAR_MENU_IDS.view,
      items: Object.freeze([
        item("view.zoomIn", "Zoom In", "cmd.zoomIn", "Cmd++"),
        item("view.unavailable", "Hidden Tool", "cmd.hidden"),
      ]),
    }),
    Object.freeze({
      id: MENU_BAR_MENU_IDS.go,
      items: Object.freeze([
        item("go.home", "Home", "cmd.home"),
      ]),
    }),
    Object.freeze({
      id: MENU_BAR_MENU_IDS.window,
      items: Object.freeze([
        item("window.minimize", "Minimize", "cmd.minimize", "Cmd+M"),
      ]),
    }),
    Object.freeze({
      id: MENU_BAR_MENU_IDS.help,
      items: Object.freeze([
        item("help.about", "About", "cmd.about"),
      ]),
    }),
  ]),
});

const APP_TREE: MenuBarTreeInput = Object.freeze({
  menus: Object.freeze([
    Object.freeze({
      id: MENU_BAR_MENU_IDS.file,
      items: Object.freeze([
        item("file.save", "Save", "cmd.save", "Cmd+S"),
      ]),
    }),
  ]),
});

test("open, highlight, and close produce frozen snapshots over the menu tree", () => {
  const vm = createMenuBarViewModel({
    baseTree: BASE_TREE,
    registry: seededRegistry(),
  });

  const opened = vm.openMenu("file");

  assert.equal(opened.openMenuId, "file");
  assert.equal(opened.highlightedItemId, null);
  assert.deepEqual(opened.menus.map((menu) => menu.label), ["File", "Edit", "View", "Go", "Window", "Help"]);
  assert.deepEqual(opened.menus[0]?.items.map((entry) => entry.label), ["New", "Disabled Export", "Unknown Command"]);
  assert.equal(Object.isFrozen(opened), true);
  assert.equal(Object.isFrozen(opened.menus), true);
  assert.equal(Object.isFrozen(opened.menus[0]), true);
  assert.equal(Object.isFrozen(opened.menus[0]?.items), true);
  assert.equal(Object.isFrozen(opened.menus[0]?.items[0]), true);

  const highlighted = vm.highlight("file.new");

  assert.equal(highlighted.openMenuId, "file");
  assert.equal(highlighted.highlightedItemId, "file.new");
  assert.equal(Object.isFrozen(highlighted), true);

  const closed = vm.closeMenu();

  assert.equal(closed.openMenuId, null);
  assert.equal(closed.highlightedItemId, null);
  assert.equal(Object.isFrozen(closed), true);
});

test("disabled items stay visible but are rejected as non-actionable", () => {
  const vm = createMenuBarViewModel({
    baseTree: BASE_TREE,
    registry: seededRegistry(),
  });
  const snapshot = vm.snapshot();
  const disabled = findItem(snapshot.menus, "file.disabled");

  assert.notEqual(disabled, undefined);
  assert.equal(disabled?.disabled, true);
  assert.equal(disabled?.accelerator, "Cmd+E");

  const result = vm.select("file.disabled");

  assert.equal(result.ok, false);
  if (result.ok) {
    assert.fail("expected disabled item to fail closed");
  }
  assert.equal(result.reason, "forbidden");
  assert.equal(result.error.code, "MENU_ITEM_DISABLED");
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result.error), true);
});

test("select routes enabled menu items through the command registry", () => {
  const vm = createMenuBarViewModel({
    baseTree: BASE_TREE,
    registry: seededRegistry(),
  });

  const launcher = vm.select("file.new");
  assert.equal(launcher.ok, true);
  if (!launcher.ok) {
    assert.fail("expected enabled item to dispatch");
  }
  assert.equal(launcher.itemId, "file.new");
  assert.equal(launcher.commandId, "cmd.new");
  assert.equal(launcher.action.kind, "launcher.intent");
  if (launcher.action.kind === "launcher.intent") {
    assert.equal(launcher.action.intent.appId, "vita.app.files");
  }
  assert.equal(Object.isFrozen(launcher), true);
  assert.equal(Object.isFrozen(launcher.action), true);

  const wm = vm.select("window.minimize");
  assert.equal(wm.ok, true);
  if (!wm.ok) {
    assert.fail("expected window item to dispatch");
  }
  assert.equal(wm.commandId, "cmd.minimize");
  assert.equal(wm.action.kind, "wm.intent");
  if (wm.action.kind === "wm.intent") {
    assert.equal(wm.action.intent.type, "setFocus");
  }

  const settings = vm.select("view.zoomIn");
  assert.equal(settings.ok, true);
  if (!settings.ok) {
    assert.fail("expected settings item to dispatch");
  }
  assert.equal(settings.action.kind, "settings.write");
  if (settings.action.kind === "settings.write") {
    assert.equal(settings.action.request.key, "view.zoom");
    assert.equal(settings.action.request.value, 1);
  }
});

test("unknown item ids and unknown or unavailable command ids reject with structured errors", () => {
  const vm = createMenuBarViewModel({
    baseTree: BASE_TREE,
    registry: seededRegistry(),
  });

  const unknownItem = vm.select("file.nope");
  assert.equal(unknownItem.ok, false);
  if (unknownItem.ok) {
    assert.fail("expected unknown item to fail closed");
  }
  assert.equal(unknownItem.reason, "invalid");
  assert.equal(unknownItem.error.code, "UNKNOWN_MENU_ITEM");
  assert.equal(unknownItem.error.path, "/items/file.nope");

  const unknownCommand = vm.select("file.unknownCommand");
  assert.equal(unknownCommand.ok, false);
  if (unknownCommand.ok) {
    assert.fail("expected unknown command to fail closed");
  }
  assert.equal(unknownCommand.reason, "invalid");
  assert.equal(unknownCommand.error.code, "UNKNOWN_COMMAND");

  const unavailable = vm.select("view.unavailable", Object.freeze({ hidden: false }));
  assert.equal(unavailable.ok, false);
  if (unavailable.ok) {
    assert.fail("expected unavailable command to fail closed");
  }
  assert.equal(unavailable.reason, "forbidden");
  assert.equal(unavailable.error.code, "COMMAND_UNAVAILABLE");

  const snapshot = vm.snapshot();
  assert.equal(findItem(snapshot.menus, "file.unknownCommand")?.disabled, true);
  assert.equal(findItem(snapshot.menus, "view.unavailable")?.disabled, true);
});

test("throwing injected registries fail closed without escaping", () => {
  const vm = createMenuBarViewModel({
    baseTree: Object.freeze({
      menus: Object.freeze([
        Object.freeze({
          id: MENU_BAR_MENU_IDS.file,
          items: Object.freeze([
            item("file.throwing", "Throwing", "cmd.throwing"),
          ]),
        }),
      ]),
    }),
    registry: throwingRegistry(),
  });

  assert.equal(findItem(vm.snapshot().menus, "file.throwing")?.disabled, true);

  const result = vm.select("file.throwing");
  assert.equal(result.ok, false);
  if (result.ok) {
    assert.fail("expected throwing registry to fail closed");
  }
  assert.equal(result.reason, "forbidden");
  assert.equal(result.error.code, "COMMAND_REGISTRY_FAILED");
});

test("submenus are exposed and non-command parents are rejected", () => {
  const vm = createMenuBarViewModel({
    baseTree: BASE_TREE,
    registry: seededRegistry(),
  });
  const parent = findItem(vm.snapshot().menus, "edit.submenu");

  assert.equal(parent?.disabled, false);
  assert.deepEqual(parent?.submenu?.map((entry) => entry.id), ["edit.submenu.uppercase"]);

  const result = vm.select("edit.submenu");
  assert.equal(result.ok, false);
  if (result.ok) {
    assert.fail("expected submenu parent to be non-actionable");
  }
  assert.equal(result.error.code, "MENU_ITEM_NOT_ACTIONABLE");
});

test("active app selects an app tree and falls back to the desktop tree", () => {
  const vm = createMenuBarViewModel({
    appTrees: Object.freeze([
      Object.freeze({
        appId: "vita.app.editor",
        tree: APP_TREE,
      }),
    ]),
    baseTree: BASE_TREE,
    registry: seededRegistry(),
  });

  const appSnapshot = vm.setActiveApp("vita.app.editor");
  assert.equal(appSnapshot.activeAppId, "vita.app.editor");
  assert.deepEqual(appSnapshot.menus[0]?.items.map((entry) => entry.id), ["file.save"]);

  const appResult = vm.select("file.save");
  assert.equal(appResult.ok, true);
  if (!appResult.ok) {
    assert.fail("expected app-specific item to dispatch");
  }
  assert.equal(appResult.commandId, "cmd.save");

  const fallback = vm.setActiveApp("vita.app.unknown");
  assert.equal(fallback.activeAppId, "vita.app.unknown");
  assert.deepEqual(fallback.menus[0]?.items.map((entry) => entry.id), [
    "file.new",
    "file.disabled",
    "file.unknownCommand",
  ]);
});

test("identical inputs produce byte-identical snapshots", () => {
  const first = createMenuBarViewModel({
    baseTree: BASE_TREE,
    registry: seededRegistry(),
  });
  const second = createMenuBarViewModel({
    baseTree: BASE_TREE,
    registry: seededRegistry(),
  });

  first.openMenu("edit");
  first.highlight("edit.submenu.uppercase");
  second.openMenu("edit");
  second.highlight("edit.submenu.uppercase");

  const firstSnapshot = first.snapshot();
  const secondSnapshot = second.snapshot();

  assert.deepEqual(firstSnapshot, secondSnapshot);
  assert.equal(JSON.stringify(firstSnapshot), JSON.stringify(secondSnapshot));
});

function item(
  id: string,
  label: string,
  commandId?: string,
  accelerator?: string,
  disabled = false,
  submenu?: readonly MenuBarItemInputForTest[],
): MenuBarItemInputForTest {
  const output: {
    id: string;
    label: string;
    commandId?: string;
    accelerator?: string;
    disabled?: boolean;
    submenu?: readonly MenuBarItemInputForTest[];
  } = {
    id,
    label,
  };

  if (commandId !== undefined) output.commandId = commandId;
  if (accelerator !== undefined) output.accelerator = accelerator;
  if (disabled) output.disabled = true;
  if (submenu !== undefined) output.submenu = submenu;

  return Object.freeze(output);
}

type MenuBarItemInputForTest = {
  readonly id: string;
  readonly label: string;
  readonly commandId?: string;
  readonly accelerator?: string;
  readonly disabled?: boolean;
  readonly submenu?: readonly MenuBarItemInputForTest[];
};

function seededRegistry() {
  return createCommandRegistry({
    commands: Object.freeze([
      launcherCommand("cmd.new", "New"),
      launcherCommand("cmd.copy", "Copy"),
      launcherCommand("cmd.home", "Home"),
      launcherCommand("cmd.about", "About"),
      launcherCommand("cmd.uppercase", "Uppercase"),
      launcherCommand("cmd.save", "Save"),
      Object.freeze({
        category: "Window",
        execute: () => Object.freeze({
          intent: Object.freeze({
            type: "setFocus",
            windowId: "win-1",
          }),
          kind: "wm.intent",
        } satisfies CommandAction),
        id: "cmd.minimize",
        title: "Minimize",
      }),
      Object.freeze({
        category: "View",
        execute: () => Object.freeze({
          kind: "settings.write",
          request: Object.freeze({
            key: "view.zoom",
            value: 1,
          }),
        } satisfies CommandAction),
        id: "cmd.zoomIn",
        title: "Zoom In",
      }),
      Object.freeze({
        category: "View",
        execute: () => Object.freeze({
          kind: "noop",
        } satisfies CommandAction),
        id: "cmd.hidden",
        title: "Hidden",
        when: (context: CommandContext) => context.hidden === true,
      }),
      Object.freeze({
        category: "File",
        execute: () => Object.freeze({
          kind: "noop",
        } satisfies CommandAction),
        id: "cmd.export",
        title: "Export",
      }),
    ]),
  });
}

function throwingRegistry(): CommandRegistryViewModel {
  return Object.freeze({
    available() {
      return Object.freeze([]);
    },
    execute() {
      throw new Error("registry execute boom");
    },
    isAvailable() {
      throw new Error("registry availability boom");
    },
    register() {
      return Object.freeze({
        error: Object.freeze({
          code: "DISABLED",
          message: "registry is disabled.",
          path: "/registry",
        }),
        ok: false,
      });
    },
    snapshot() {
      return Object.freeze({
        commands: Object.freeze([]),
        groups: Object.freeze([]),
      });
    },
  });
}

function launcherCommand(id: string, title: string): CommandDefinition {
  return Object.freeze({
    category: "File",
    execute: () => Object.freeze({
      intent: Object.freeze({
        appId: "vita.app.files",
        query: id,
        type: "launcher.launch",
      }),
      kind: "launcher.intent",
    } satisfies CommandAction),
    id,
    title,
  });
}

function findItem(menus: readonly MenuBarMenu[], id: string): MenuBarItem | undefined {
  for (let menuIndex = 0; menuIndex < menus.length; menuIndex += 1) {
    const menu = menus[menuIndex];

    if (menu === undefined) continue;

    const found = findItemIn(menu.items, id);

    if (found !== undefined) return found;
  }

  return undefined;
}

function findItemIn(items: readonly MenuBarItem[], id: string): MenuBarItem | undefined {
  for (let index = 0; index < items.length; index += 1) {
    const current = items[index];

    if (current === undefined) continue;
    if (current.id === id) return current;
    if (current.submenu !== undefined) {
      const nested = findItemIn(current.submenu, id);

      if (nested !== undefined) return nested;
    }
  }

  return undefined;
}
