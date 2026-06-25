import assert from "node:assert/strict";
import { test } from "node:test";

import {
  createCommandRegistry,
} from "../../../../ui_kits/desktop/viewmodels/command-registry.ts";
import type {
  CommandAction,
  CommandContext,
  CommandDefinition,
} from "../../../../ui_kits/desktop/viewmodels/command-registry.ts";

function launcherCommand(
  id: string,
  title: string,
  category: string,
): CommandDefinition {
  return Object.freeze({
    category,
    execute: () => Object.freeze({
      intent: Object.freeze({
        appId: "vita.app.settings",
        query: "settings",
        type: "launcher.launch",
      }),
      kind: "launcher.intent",
    } satisfies CommandAction),
    id,
    title,
  });
}

test("register accepts commands and rejects duplicate ids fail-closed", () => {
  const registry = createCommandRegistry();

  const first = registry.register(launcherCommand("cmd.open", "Open Settings", "App"));

  assert.equal(first.ok, true);
  if (!first.ok) {
    assert.fail("expected first registration to succeed");
  }
  assert.deepEqual(first.command, {
    category: "App",
    id: "cmd.open",
    title: "Open Settings",
  });

  const duplicate = registry.register(launcherCommand("cmd.open", "Open Again", "App"));

  assert.equal(duplicate.ok, false);
  if (duplicate.ok) {
    assert.fail("expected duplicate id to fail closed");
  }
  assert.equal(duplicate.error.code, "DUPLICATE_COMMAND");

  // The duplicate must not have mutated the registry.
  assert.deepEqual(registry.snapshot().commands.map((command) => command.id), ["cmd.open"]);
});

test("register fails closed for structurally invalid definitions", () => {
  const registry = createCommandRegistry();

  const missingExecute = registry.register({
    category: "App",
    id: "cmd.bad",
    title: "Bad",
  } as unknown as CommandDefinition);

  assert.equal(missingExecute.ok, false);
  if (missingExecute.ok) {
    assert.fail("expected missing execute thunk to be rejected");
  }
  assert.equal(missingExecute.error.code, "INVALID_COMMAND");

  const emptyId = registry.register({
    category: "App",
    execute: () => Object.freeze({ kind: "noop" }),
    id: "",
    title: "Empty",
  });

  assert.equal(emptyId.ok, false);
  if (emptyId.ok) {
    assert.fail("expected empty id to be rejected");
  }
  assert.equal(emptyId.error.code, "INVALID_COMMAND");
  assert.deepEqual(registry.snapshot().commands, []);
});

test("snapshot groups commands by category with deterministic category-then-title order", () => {
  const registry = createCommandRegistry({
    commands: [
      launcherCommand("cmd.b", "Beta", "Window"),
      launcherCommand("cmd.a", "Alpha", "Window"),
      launcherCommand("cmd.s", "Save", "App"),
      launcherCommand("cmd.o", "Open", "App"),
      launcherCommand("cmd.t", "Toggle Theme", "Theme"),
    ],
  });

  const snapshot = registry.snapshot();

  assert.deepEqual(
    snapshot.groups.map((group) => [group.category, group.commands.map((command) => command.title)]),
    [
      ["App", ["Open", "Save"]],
      ["Theme", ["Toggle Theme"]],
      ["Window", ["Alpha", "Beta"]],
    ],
  );

  // Flat command list is also sorted category-then-title.
  assert.deepEqual(snapshot.commands.map((command) => command.id), [
    "cmd.o",
    "cmd.s",
    "cmd.t",
    "cmd.a",
    "cmd.b",
  ]);

  // Deterministic: a second snapshot is structurally identical.
  assert.deepEqual(registry.snapshot(), snapshot);

  // Snapshot is deeply frozen.
  assert.equal(Object.isFrozen(snapshot), true);
  assert.equal(Object.isFrozen(snapshot.groups), true);
  assert.equal(Object.isFrozen(snapshot.commands), true);
  assert.equal(Object.isFrozen(snapshot.groups[0]), true);
  assert.equal(Object.isFrozen(snapshot.groups[0]?.commands), true);
  assert.equal(Object.isFrozen(snapshot.commands[0]), true);
});

test("when-context filtering hides inapplicable commands from snapshot and availability", () => {
  const registry = createCommandRegistry({
    commands: [
      Object.freeze({
        category: "Window",
        execute: () => Object.freeze({
          intent: Object.freeze({ type: "setFocus", windowId: null }),
          kind: "wm.intent",
        } satisfies CommandAction),
        id: "cmd.focus",
        title: "Focus",
        when: (context: CommandContext) => context.hasWindow === true,
      }),
      launcherCommand("cmd.always", "Always", "App"),
    ],
  });

  const without = registry.snapshot(Object.freeze({ hasWindow: false }));

  assert.deepEqual(without.commands.map((command) => command.id), ["cmd.always"]);
  assert.equal(registry.isAvailable("cmd.focus", Object.freeze({ hasWindow: false })), false);
  assert.deepEqual(
    registry.available(Object.freeze({ hasWindow: false })).map((command) => command.id),
    ["cmd.always"],
  );

  const with_ = registry.snapshot(Object.freeze({ hasWindow: true }));

  assert.deepEqual(with_.commands.map((command) => command.id).sort(), ["cmd.always", "cmd.focus"]);
  assert.equal(registry.isAvailable("cmd.focus", Object.freeze({ hasWindow: true })), true);

  // No context => empty context => predicate sees an empty record.
  assert.equal(registry.isAvailable("cmd.focus"), false);
});

test("execute classifies each command into the correct typed action union member", () => {
  const registry = createCommandRegistry({
    commands: [
      launcherCommand("cmd.launcher", "Launch", "App"),
      Object.freeze({
        category: "Window",
        execute: () => Object.freeze({
          intent: Object.freeze({
            rect: Object.freeze({ height: 100, width: 100, x: 0, y: 0 }),
            textureId: "tex-1",
            type: "repositionTexture",
            windowId: "win-1",
          }),
          kind: "wm.intent",
        } satisfies CommandAction),
        id: "cmd.wm",
        title: "Reposition",
      }),
      Object.freeze({
        category: "Settings",
        execute: () => Object.freeze({
          kind: "settings.write",
          request: Object.freeze({ key: "appearance.theme", value: "dark" }),
        } satisfies CommandAction),
        id: "cmd.settings",
        title: "Write Setting",
      }),
      Object.freeze({
        category: "Theme",
        execute: (context: CommandContext) => Object.freeze({
          from: context.theme === "dark" ? "dark" : "light",
          kind: "theme.toggle",
          to: context.theme === "dark" ? "light" : "dark",
        } satisfies CommandAction),
        id: "cmd.theme",
        title: "Toggle Theme",
      }),
      Object.freeze({
        category: "Misc",
        execute: () => Object.freeze({ kind: "noop" } satisfies CommandAction),
        id: "cmd.noop",
        title: "No Operation",
      }),
    ],
  });

  const launcher = registry.execute("cmd.launcher");
  assert.equal(launcher.ok, true);
  if (!launcher.ok) {
    assert.fail("expected launcher command to execute");
  }
  assert.equal(launcher.action.kind, "launcher.intent");
  if (launcher.action.kind === "launcher.intent") {
    assert.equal(launcher.action.intent.type, "launcher.launch");
  }
  assert.equal(Object.isFrozen(launcher.action), true);

  const wm = registry.execute("cmd.wm");
  assert.equal(wm.ok, true);
  if (!wm.ok) {
    assert.fail("expected wm command to execute");
  }
  assert.equal(wm.action.kind, "wm.intent");
  if (wm.action.kind === "wm.intent") {
    assert.equal(wm.action.intent.type, "repositionTexture");
  }

  const settings = registry.execute("cmd.settings");
  assert.equal(settings.ok, true);
  if (!settings.ok) {
    assert.fail("expected settings command to execute");
  }
  assert.equal(settings.action.kind, "settings.write");
  if (settings.action.kind === "settings.write") {
    assert.equal(settings.action.request.key, "appearance.theme");
    assert.equal(settings.action.request.value, "dark");
  }

  const themeDark = registry.execute("cmd.theme", Object.freeze({ theme: "dark" }));
  assert.equal(themeDark.ok, true);
  if (!themeDark.ok) {
    assert.fail("expected theme command to execute");
  }
  assert.equal(themeDark.action.kind, "theme.toggle");
  if (themeDark.action.kind === "theme.toggle") {
    assert.equal(themeDark.action.from, "dark");
    assert.equal(themeDark.action.to, "light");
  }

  // Deterministic: same context => same toggle direction.
  const themeLight = registry.execute("cmd.theme", Object.freeze({ theme: "light" }));
  assert.equal(themeLight.ok, true);
  if (themeLight.ok && themeLight.action.kind === "theme.toggle") {
    assert.equal(themeLight.action.from, "light");
    assert.equal(themeLight.action.to, "dark");
  }

  const noop = registry.execute("cmd.noop");
  assert.equal(noop.ok, true);
  if (!noop.ok) {
    assert.fail("expected noop command to execute");
  }
  assert.equal(noop.action.kind, "noop");
});

test("execute fails closed for unknown ids and non-string ids", () => {
  const registry = createCommandRegistry({
    commands: [launcherCommand("cmd.open", "Open", "App")],
  });

  const unknown = registry.execute("cmd.missing");
  assert.equal(unknown.ok, false);
  if (unknown.ok) {
    assert.fail("expected unknown id to fail closed");
  }
  assert.equal(unknown.error.code, "UNKNOWN_COMMAND");

  const empty = registry.execute("");
  assert.equal(empty.ok, false);
  if (empty.ok) {
    assert.fail("expected empty id to fail closed");
  }
  assert.equal(empty.error.code, "UNKNOWN_COMMAND");

  const nonString = registry.execute(42);
  assert.equal(nonString.ok, false);
  if (nonString.ok) {
    assert.fail("expected non-string id to fail closed");
  }
  assert.equal(nonString.error.code, "UNKNOWN_COMMAND");
});

test("execute fails closed when when-predicate excludes the command", () => {
  const registry = createCommandRegistry({
    commands: [
      Object.freeze({
        category: "Window",
        execute: () => Object.freeze({
          intent: Object.freeze({ type: "setFocus", windowId: null }),
          kind: "wm.intent",
        } satisfies CommandAction),
        id: "cmd.focus",
        title: "Focus",
        when: (context: CommandContext) => context.hasWindow === true,
      }),
    ],
  });

  const blocked = registry.execute("cmd.focus", Object.freeze({ hasWindow: false }));
  assert.equal(blocked.ok, false);
  if (blocked.ok) {
    assert.fail("expected when-excluded command to fail closed");
  }
  assert.equal(blocked.error.code, "COMMAND_UNAVAILABLE");

  const allowed = registry.execute("cmd.focus", Object.freeze({ hasWindow: true }));
  assert.equal(allowed.ok, true);
});

test("execute fails closed when a thunk throws or a predicate throws", () => {
  const registry = createCommandRegistry({
    commands: [
      Object.freeze({
        category: "App",
        execute: () => {
          throw new Error("boom");
        },
        id: "cmd.throws",
        title: "Throws",
      }),
      Object.freeze({
        category: "App",
        execute: () => Object.freeze({ kind: "noop" } satisfies CommandAction),
        id: "cmd.badwhen",
        title: "Bad When",
        when: () => {
          throw new Error("predicate boom");
        },
      }),
    ],
  });

  const threw = registry.execute("cmd.throws");
  assert.equal(threw.ok, false);
  if (threw.ok) {
    assert.fail("expected throwing thunk to fail closed");
  }
  assert.equal(threw.error.code, "COMMAND_FAILED");

  // A throwing predicate makes the command unavailable, not a crash.
  assert.equal(registry.isAvailable("cmd.badwhen"), false);
  const badWhen = registry.execute("cmd.badwhen");
  assert.equal(badWhen.ok, false);
  if (badWhen.ok) {
    assert.fail("expected throwing predicate to fail closed");
  }
  assert.equal(badWhen.error.code, "COMMAND_UNAVAILABLE");
});

test("execute rejects actions outside the typed union fail-closed", () => {
  const registry = createCommandRegistry();

  registry.register({
    category: "App",
    execute: () => ({ kind: "filesystem.delete" }) as unknown as CommandAction,
    id: "cmd.rogue",
    title: "Rogue",
  });

  const rogue = registry.execute("cmd.rogue");
  assert.equal(rogue.ok, false);
  if (rogue.ok) {
    assert.fail("expected out-of-union action to fail closed");
  }
  assert.equal(rogue.error.code, "INVALID_ACTION");
});
