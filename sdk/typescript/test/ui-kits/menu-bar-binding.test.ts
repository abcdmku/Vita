import assert from "node:assert/strict";
import { test } from "node:test";

import {
  buildMenuBarCommandContext,
  createMenuBarBindingViewModel,
} from "../../../../ui_kits/desktop/viewmodels/menu-bar-binding.ts";
import type {
  MenuBarBindingItem,
  MenuBarBindingMenu,
} from "../../../../ui_kits/desktop/viewmodels/menu-bar-binding.ts";
import {
  MENU_BAR_MENU_IDS,
} from "../../../../ui_kits/desktop/viewmodels/menu-bar.ts";
import type {
  CommandAction,
  CommandContext,
  CommandDefinition,
} from "../../../../ui_kits/desktop/viewmodels/command-registry.ts";
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

test("focused app context drives command enablement and re-derives when WM focus changes", () => {
  const modelA = windowModel(
    Object.freeze([
      windowState("window:vita.app.alpha:Alpha Doc", "workspace-1", 0),
      windowState("window:vita.app.beta:Beta Doc", "workspace-1", 1),
    ]),
    Object.freeze(["window:vita.app.alpha:Alpha Doc", "window:vita.app.beta:Beta Doc"]),
  );
  const vm = createMenuBarBindingViewModel({
    commands: bindingCommands(),
    windowModel: modelA,
  });

  const alpha = vm.snapshot();

  assert.equal(alpha.focusedWindowId, "window:vita.app.alpha:Alpha Doc");
  assert.equal(alpha.focusedAppId, "vita.app.alpha");
  assert.equal(alpha.context.focusedWindowId, "window:vita.app.alpha:Alpha Doc");
  assert.equal(alpha.context.focusedAppId, "vita.app.alpha");
  assert.deepEqual(alpha.registry.commands.map((command) => command.id), [
    "alpha.save",
    "shared.reload",
  ]);

  assert.equal(findItem(alpha.menus, "menubar.command.alpha.save")?.disabled, false);
  assert.equal(findItem(alpha.menus, "menubar.command.beta.save")?.disabled, true);
  assert.equal(findItem(alpha.menus, "menubar.command.shared.reload")?.disabled, false);
  assert.equal(findItem(alpha.menus, "menubar.command.beta.copy")?.disabled, true);

  const modelB = windowModel(
    modelA.windows,
    Object.freeze(["window:vita.app.beta:Beta Doc", "window:vita.app.alpha:Alpha Doc"]),
  );
  const beta = vm.setWindowModel(modelB);

  assert.equal(beta.focusedWindowId, "window:vita.app.beta:Beta Doc");
  assert.equal(beta.focusedAppId, "vita.app.beta");
  assert.deepEqual(beta.registry.commands.map((command) => command.id), [
    "beta.copy",
    "beta.save",
    "shared.reload",
  ]);
  assert.equal(findItem(beta.menus, "menubar.command.alpha.save")?.disabled, true);
  assert.equal(findItem(beta.menus, "menubar.command.beta.save")?.disabled, false);
  assert.equal(findItem(beta.menus, "menubar.command.beta.copy")?.disabled, false);
});

test("Window menu lists open windows focused-first and marks exactly the focused window", () => {
  const model = windowModel(
    Object.freeze([
      windowState("window:vita.app.gamma:Gamma", "workspace-1", 20),
      windowState("window:vita.app.alpha:Alpha", "workspace-1", 10),
      windowState("window:vita.app.beta:Beta", "workspace-2", 5),
      windowState("window:vita.app.delta:Delta", "workspace-1", 30),
    ]),
    Object.freeze([
      "window:vita.app.alpha:Alpha",
      "window:vita.app.beta:Beta",
      "window:vita.app.gamma:Gamma",
    ]),
  );
  const vm = createMenuBarBindingViewModel({
    commands: bindingCommands(),
    windowModel: model,
  });
  const snapshot = vm.openMenu(MENU_BAR_MENU_IDS.window);
  const windowEntries = snapshot.windowEntries;

  assert.equal(snapshot.openMenuId, "window");
  assert.deepEqual(windowEntries.map((entry) => entry.windowId), [
    "window:vita.app.alpha:Alpha",
    "window:vita.app.beta:Beta",
    "window:vita.app.gamma:Gamma",
    "window:vita.app.delta:Delta",
  ]);
  assert.deepEqual(windowEntries.map((entry) => entry.marked), [true, false, false, false]);
  assert.equal(Object.isFrozen(snapshot), true);
  assert.equal(Object.isFrozen(snapshot.windowEntries), true);
  assert.equal(Object.isFrozen(snapshot.windowEntries[0]), true);

  const windowMenu = snapshot.menus.find((menu) => menu.id === MENU_BAR_MENU_IDS.window);
  const windowItems = windowMenu?.items.filter((item) => item.windowId !== undefined) ?? [];

  assert.deepEqual(windowItems.map((item) => item.label), ["Alpha", "Beta", "Gamma", "Delta"]);
  assert.deepEqual(windowItems.map((item) => item.marked), [true, false, false, false]);
  assert.equal(windowItems[0]?.windowId, "window:vita.app.alpha:Alpha");
});

test("selecting a Window menu entry returns a typed setFocus intent without applying effects", () => {
  const model = windowModel(
    Object.freeze([
      windowState("window:vita.app.alpha:Alpha", "workspace-1", 0),
      windowState("window:vita.app.beta:Beta", "workspace-1", 1),
    ]),
    Object.freeze(["window:vita.app.alpha:Alpha", "window:vita.app.beta:Beta"]),
  );
  const vm = createMenuBarBindingViewModel({
    commands: bindingCommands(),
    windowModel: model,
  });
  const betaEntry = vm.snapshot().windowEntries.find((entry) => entry.windowId === "window:vita.app.beta:Beta");

  assert.notEqual(betaEntry, undefined);

  const selected = vm.select(betaEntry?.itemId);

  assert.equal(selected.ok, true);
  if (!selected.ok) {
    assert.fail("expected window selection to return an intent");
  }
  assert.equal(selected.selection, "window");
  assert.deepEqual(selected.intent, {
    type: "setFocus",
    windowId: "window:vita.app.beta:Beta",
  });
  assert.equal(selected.action.kind, "wm.intent");
  assert.deepEqual(selected.action.intent, selected.intent);

  assert.deepEqual(vm.snapshot().focusedWindowId, "window:vita.app.alpha:Alpha");
});

test("selecting commands routes through the registry with the active-window context", () => {
  const model = windowModel(
    Object.freeze([
      windowState("window:vita.app.beta:Beta", "workspace-1", 1),
    ]),
    Object.freeze(["window:vita.app.beta:Beta"]),
  );
  const vm = createMenuBarBindingViewModel({
    commands: bindingCommands(),
    windowModel: model,
  });

  const selected = vm.select("menubar.command.beta.copy");

  assert.equal(selected.ok, true);
  if (!selected.ok) {
    assert.fail("expected enabled command to execute");
  }
  assert.equal(selected.selection, "command");
  assert.equal(selected.commandId, "beta.copy");
  assert.equal(selected.action.kind, "settings.write");
  if (selected.action.kind === "settings.write") {
    assert.equal(selected.action.request.key, "copy.source");
    assert.equal(selected.action.request.value, "vita.app.beta");
  }

  const direct = vm.selectCommand("shared.reload");

  assert.equal(direct.ok, true);
  if (direct.ok) {
    assert.equal(direct.selection, "command");
    assert.equal(direct.commandId, "shared.reload");
  }
});

test("fail-closed selections for closed windows and unavailable commands return no intent", () => {
  const model = windowModel(
    Object.freeze([
      windowState("window:vita.app.alpha:Alpha", "workspace-1", 0),
    ]),
    Object.freeze(["window:vita.app.alpha:Alpha"]),
  );
  const vm = createMenuBarBindingViewModel({
    commands: bindingCommands(),
    windowModel: model,
  });

  const closed = vm.selectWindow("window:vita.app.closed:Closed");

  assert.equal(closed.ok, false);
  if (closed.ok) {
    assert.fail("expected closed window to fail closed");
  }
  assert.equal(closed.reason, "invalid");
  assert.equal(closed.error.code, "UNKNOWN_WINDOW");
  assert.equal("intent" in closed, false);

  const unavailableByItem = vm.select("menubar.command.beta.copy");

  assert.equal(unavailableByItem.ok, false);
  if (unavailableByItem.ok) {
    assert.fail("expected unavailable command item to fail closed");
  }
  assert.equal(unavailableByItem.reason, "forbidden");
  assert.equal(unavailableByItem.error.code, "COMMAND_UNAVAILABLE");
  assert.equal("intent" in unavailableByItem, false);

  const unavailableDirect = vm.selectCommand("beta.copy");

  assert.equal(unavailableDirect.ok, false);
  if (!unavailableDirect.ok) {
    assert.equal(unavailableDirect.error.code, "COMMAND_UNAVAILABLE");
  }
  assert.equal("intent" in unavailableDirect, false);

  assert.doesNotThrow(() => vm.select("menubar.window.focus.window_003avita.app.closed_003aClosed"));
});

test("command context and snapshots are byte-identical for identical inputs", () => {
  const model = windowModel(
    Object.freeze([
      windowState("window:vita.app.alpha:Alpha", "workspace-1", 0),
      windowState("window:vita.app.beta:Beta", "workspace-1", 1),
    ]),
    Object.freeze(["window:vita.app.alpha:Alpha", "window:vita.app.beta:Beta"]),
  );
  const context = buildMenuBarCommandContext(model);

  assert.deepEqual(context, {
    activeWorkspaceId: "workspace-1",
    focusedAppId: "vita.app.alpha",
    focusedTitle: "Alpha",
    focusedWindowId: "window:vita.app.alpha:Alpha",
    focusedWindowTitle: "Alpha",
    hasFocusedWindow: true,
    windowCount: 2,
  });
  assert.equal(Object.isFrozen(context), true);

  const first = createMenuBarBindingViewModel({
    commands: bindingCommands(),
    windowModel: model,
  });
  const second = createMenuBarBindingViewModel({
    commands: bindingCommands(),
    windowModel: model,
  });

  first.openMenu("window");
  second.openMenu("window");

  assert.deepEqual(first.snapshot(), second.snapshot());
  assert.equal(JSON.stringify(first.snapshot()), JSON.stringify(second.snapshot()));
});

function bindingCommands(): readonly CommandDefinition[] {
  return Object.freeze([
    appCommand("alpha.save", "Save Alpha", "File", "vita.app.alpha"),
    appCommand("beta.save", "Save Beta", "File", "vita.app.beta"),
    Object.freeze({
      category: "Edit",
      execute: (context: CommandContext) => Object.freeze({
        kind: "settings.write",
        request: Object.freeze({
          key: "copy.source",
          value: typeof context.focusedAppId === "string" ? context.focusedAppId : null,
        }),
      } satisfies CommandAction),
      id: "beta.copy",
      title: "Copy Beta",
      when: (context: CommandContext) => context.focusedAppId === "vita.app.beta",
    }),
    Object.freeze({
      category: "View",
      execute: () => Object.freeze({
        kind: "noop",
      } satisfies CommandAction),
      id: "shared.reload",
      title: "Reload",
      when: (context: CommandContext) => context.hasFocusedWindow === true,
    }),
  ]);
}

function appCommand(
  id: string,
  title: string,
  category: string,
  appId: string,
): CommandDefinition {
  return Object.freeze({
    category,
    execute: (context: CommandContext) => Object.freeze({
      intent: Object.freeze({
        appId,
        query: String(context.focusedWindowId),
        type: "launcher.launch",
      }),
      kind: "launcher.intent",
    } satisfies CommandAction),
    id,
    title,
    when: (context: CommandContext) => context.focusedAppId === appId,
  });
}

function windowModel(
  windows: readonly WindowState[],
  focusStack: readonly string[],
): WindowModel {
  return Object.freeze({
    activeWorkspaceId: "workspace-1",
    focusStack: Object.freeze([...focusStack]),
    windows,
    workspaces: Object.freeze([
      workspace("workspace-1", "tile"),
      workspace("workspace-2", "grid"),
    ]),
  }) satisfies WindowModel;
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
    textureId: `texture:${id}`,
    workspaceId,
  });
}

function findItem(menus: readonly MenuBarBindingMenu[], id: string): MenuBarBindingItem | undefined {
  for (let menuIndex = 0; menuIndex < menus.length; menuIndex += 1) {
    const menu = menus[menuIndex];

    if (menu === undefined) continue;

    const found = findItemIn(menu.items, id);

    if (found !== undefined) return found;
  }

  return undefined;
}

function findItemIn(items: readonly MenuBarBindingItem[], id: string): MenuBarBindingItem | undefined {
  for (let index = 0; index < items.length; index += 1) {
    const item = items[index];

    if (item === undefined) continue;
    if (item.id === id) return item;
    if (item.submenu !== undefined) {
      const nested = findItemIn(item.submenu, id);

      if (nested !== undefined) return nested;
    }
  }

  return undefined;
}
