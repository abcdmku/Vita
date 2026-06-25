import assert from "node:assert/strict";
import { test } from "node:test";

import {
  DEFAULT_SHORTCUT_BINDINGS,
  DEFAULT_SHORTCUT_COMMANDS,
  SHORTCUT_COMMAND_IDS,
  createShortcutsViewModel,
  detectShortcutConflicts,
  normalizeShortcutChord,
} from "../../../../ui_kits/desktop/viewmodels/shortcuts.ts";
import type {
  ShortcutBinding,
  ShortcutCommand,
  ShortcutCommandPort,
} from "../../../../ui_kits/desktop/viewmodels/shortcuts.ts";
import type {
  DesktopCapability,
  DesktopCapabilityGrant,
  DesktopHostResult,
  DesktopLauncherIntent,
  DesktopUiPackageManifest,
} from "../../src/desktop-sdk/index.ts";

test("shortcuts view-model seeds deterministic default commands and keymap", () => {
  const vm = createShortcutsViewModel(fakePorts([]));
  const snapshot = vm.snapshot();

  assert.deepEqual(snapshot.commands.map((command) => [command.id, command.title]), [
    [SHORTCUT_COMMAND_IDS.openLauncher, "Open Launcher"],
    [SHORTCUT_COMMAND_IDS.closeLauncher, "Close Launcher"],
    [SHORTCUT_COMMAND_IDS.launchSettings, "Open Settings"],
    [SHORTCUT_COMMAND_IDS.toggleDarkMode, "Toggle Dark Mode"],
  ]);
  assert.deepEqual(snapshot.defaults.map(projectBinding), [
    ["Control+Space", SHORTCUT_COMMAND_IDS.openLauncher, "default"],
    ["Escape", SHORTCUT_COMMAND_IDS.closeLauncher, "default"],
    ["Control+Comma", SHORTCUT_COMMAND_IDS.launchSettings, "default"],
    ["Control+Shift+D", SHORTCUT_COMMAND_IDS.toggleDarkMode, "default"],
  ]);
  assert.deepEqual(snapshot.bindings.map(projectBinding), snapshot.defaults.map(projectBinding));
  assert.deepEqual(snapshot.userOverrides, []);
  assert.deepEqual(snapshot.conflicts, []);
  assert.equal(Object.isFrozen(snapshot), true);
  assert.equal(Object.isFrozen(snapshot.bindings), true);
  assert.equal(DEFAULT_SHORTCUT_COMMANDS.length, 4);
  assert.equal(DEFAULT_SHORTCUT_BINDINGS.length, 4);
});

test("shortcut chord normalization is canonical for strings and minimal key events", () => {
  const fromString = normalizeShortcutChord(" shift + ctrl + p ");
  const fromComma = normalizeShortcutChord("CTRL+,");
  const fromEvent = normalizeShortcutChord({
    ctrlKey: true,
    key: "p",
    shiftKey: true,
  });
  const fromCode = normalizeShortcutChord({
    altKey: true,
    code: "KeyK",
  });

  assert.equal(fromString.ok, true);
  assert.equal(fromComma.ok, true);
  assert.equal(fromEvent.ok, true);
  assert.equal(fromCode.ok, true);
  if (!fromString.ok || !fromComma.ok || !fromEvent.ok || !fromCode.ok) {
    assert.fail("expected chord normalization to succeed");
  }

  assert.equal(fromString.chord, "Control+Shift+P");
  assert.equal(fromComma.chord, "Control+Comma");
  assert.equal(fromEvent.chord, "Control+Shift+P");
  assert.equal(fromCode.chord, "Alt+K");
});

test("register, rebind, list, and reset preserve defaults versus user overrides", () => {
  const events: string[] = [];
  const vm = createShortcutsViewModel(fakePorts(events), {
    commands: testCommands(),
    defaults: [
      { chord: "Ctrl+P", commandId: "command.palette" },
      { chord: "Ctrl+D", commandId: "command.dark" },
    ],
  });

  const rebound = vm.rebind("command.palette", "alt + space");

  assert.equal(rebound.ok, true);
  if (!rebound.ok) {
    assert.fail("expected rebind to succeed");
  }
  assert.deepEqual(vm.list().map(projectBinding), [
    ["Control+D", "command.dark", "default"],
    ["Alt+Space", "command.palette", "user"],
  ]);
  assert.deepEqual(vm.snapshot().userOverrides.map(projectBinding), [
    ["Alt+Space", "command.palette", "user"],
  ]);

  const resolved = vm.resolve({
    altKey: true,
    key: " ",
  });

  assert.equal(resolved.ok, true);
  if (!resolved.ok) {
    assert.fail("expected shortcut resolution to succeed");
  }
  assert.equal(resolved.command.id, "command.palette");
  assert.equal(resolved.binding.source, "user");

  const registeredSpecial = vm.register("Control+1", "__proto__");

  assert.equal(registeredSpecial.ok, true);
  if (!registeredSpecial.ok) {
    assert.fail("expected special command id to remain an own registry entry");
  }
  assert.equal(vm.list().some((binding) => binding.commandId === "__proto__"), true);

  const reset = vm.reset("command.palette");

  assert.equal(reset.ok, true);
  if (!reset.ok) {
    assert.fail("expected reset to restore default binding");
  }
  assert.deepEqual(vm.list().map(projectBinding), [
    ["Control+P", "command.palette", "default"],
    ["Control+D", "command.dark", "default"],
    ["Control+1", "__proto__", "user"],
  ]);
  assert.deepEqual(events, []);
});

test("shortcut conflicts are reported and rejected without mutating the active keymap", () => {
  const vm = createShortcutsViewModel(fakePorts([]), {
    commands: testCommands(),
    defaults: [
      { chord: "Ctrl+P", commandId: "command.palette" },
      { chord: "Ctrl+D", commandId: "command.dark" },
    ],
  });
  const before = vm.snapshot();

  const rejected = vm.register("control+p", "command.dark");

  assert.equal(rejected.ok, false);
  if (rejected.ok) {
    assert.fail("expected conflicting registration to fail closed");
  }
  assert.equal(rejected.error.code, "SHORTCUT_CONFLICT");
  assert.deepEqual(rejected.conflict?.commandIds, ["command.palette", "command.dark"]);
  assert.equal(vm.snapshot(), before);
  assert.deepEqual(vm.list().map(projectBinding), [
    ["Control+P", "command.palette", "default"],
    ["Control+D", "command.dark", "default"],
  ]);

  const conflicts = detectShortcutConflicts([
    binding("Ctrl+K", "command.palette", "default"),
    binding("Control+K", "command.dark", "user"),
  ]);

  assert.equal(conflicts.length, 1);
  assert.equal(conflicts[0]?.chord, "Control+K");
  assert.deepEqual(conflicts[0]?.commandIds, ["command.palette", "command.dark"]);
});

test("dispatch sends resolved commands through the injected launcher command port", async () => {
  const events: string[] = [];
  const vm = createShortcutsViewModel(fakePorts(events, [
    grant("launcher.launch", "vita.command.palette"),
  ]), {
    commands: testCommands(),
    defaults: [
      { chord: "Ctrl+P", commandId: "command.palette" },
    ],
  });

  const dispatched = await vm.dispatch({
    ctrlKey: true,
    key: "p",
  });

  assert.equal(dispatched.ok, true);
  if (!dispatched.ok) {
    assert.fail("expected shortcut dispatch to succeed");
  }
  assert.equal(dispatched.dispatch, "launcherIntent");
  assert.equal(dispatched.command.id, "command.palette");
  assert.equal(dispatched.binding.chord, "Control+P");
  assert.deepEqual(events, [
    "launcher:launcher.launch:vita.command.palette:palette",
  ]);
});

test("dispatch fails closed for unknown, unbound, denied, unavailable, and failing command paths", async () => {
  const events: string[] = [];
  const unknown = createShortcutsViewModel(fakePorts(events), {
    commands: [launchCommand("command.palette", "Palette", "vita.command.palette", "palette")],
    defaults: [
      { chord: "Ctrl+U", commandId: "command.missing" },
    ],
  });

  const unknownResult = await unknown.dispatch("ctrl+u");

  assert.equal(unknownResult.ok, false);
  if (unknownResult.ok) {
    assert.fail("expected unknown command to fail closed");
  }
  assert.equal(unknownResult.error.code, "UNKNOWN_COMMAND");
  assert.deepEqual(events, []);

  const unboundResult = await unknown.dispatch("ctrl+x");

  assert.equal(unboundResult.ok, false);
  if (unboundResult.ok) {
    assert.fail("expected unbound chord to fail closed");
  }
  assert.equal(unboundResult.error.code, "UNBOUND_CHORD");

  const denied = createShortcutsViewModel(fakePorts(events), {
    commands: [launchCommand("command.palette", "Palette", "vita.command.palette", "palette")],
    defaults: [
      { chord: "Ctrl+P", commandId: "command.palette" },
    ],
  });
  const deniedResult = await denied.dispatch("ctrl+p");

  assert.equal(deniedResult.ok, false);
  if (deniedResult.ok) {
    assert.fail("expected missing capability to fail closed");
  }
  assert.equal(deniedResult.error.code, "MISSING_CAPABILITY");

  const unavailable = createShortcutsViewModel(fakePorts(events, [
    grant("launcher.launch", "vita.command.palette"),
  ], {
    launcherPort: false,
  }), {
    commands: [launchCommand("command.palette", "Palette", "vita.command.palette", "palette")],
    defaults: [
      { chord: "Ctrl+P", commandId: "command.palette" },
    ],
  });
  const unavailableResult = await unavailable.dispatch("ctrl+p");

  assert.equal(unavailableResult.ok, false);
  if (unavailableResult.ok) {
    assert.fail("expected unavailable command port to fail closed");
  }
  assert.equal(unavailableResult.error.code, "COMMAND_PORT_UNAVAILABLE");

  const throwing = createShortcutsViewModel(fakePorts(events, [
    grant("launcher.launch", "vita.command.palette"),
  ], {
    throwPort: true,
  }), {
    commands: [launchCommand("command.palette", "Palette", "vita.command.palette", "palette")],
    defaults: [
      { chord: "Ctrl+P", commandId: "command.palette" },
    ],
  });
  const throwingResult = await throwing.handleKeyEvent("ctrl+p");

  assert.equal(throwingResult.ok, false);
  if (throwingResult.ok) {
    assert.fail("expected throwing command port to fail closed");
  }
  assert.equal(throwingResult.error.code, "COMMAND_PORT_FAILED");
  assert.deepEqual(events, [
    "launcher:launcher.launch:vita.command.palette:palette",
  ]);
});

test("malformed key events and chords fail closed without reading accessors", async () => {
  const events: string[] = [];
  const vm = createShortcutsViewModel(fakePorts(events, [
    grant("launcher.launch", "vita.command.palette"),
  ]), {
    commands: [launchCommand("command.palette", "Palette", "vita.command.palette", "palette")],
    defaults: [
      { chord: "Ctrl+P", commandId: "command.palette" },
    ],
  });
  let reads = 0;
  const hostile: Record<string, unknown> = {
    ctrlKey: true,
  };

  Object.defineProperty(hostile, "key", {
    enumerable: true,
    get() {
      reads += 1;
      return "p";
    },
  });

  const normalized = normalizeShortcutChord(hostile);
  const dispatched = await vm.dispatch(hostile);
  const invalidChord = normalizeShortcutChord("Control+");

  assert.equal(normalized.ok, false);
  if (normalized.ok) {
    assert.fail("expected accessor key event to fail closed");
  }
  assert.equal(normalized.error.code, "INVALID_KEY_EVENT");
  assert.equal(reads, 0);
  assert.equal(dispatched.ok, false);
  if (dispatched.ok) {
    assert.fail("expected accessor dispatch to fail closed");
  }
  assert.equal(dispatched.error.code, "INVALID_KEY_EVENT");
  assert.deepEqual(events, []);
  assert.equal(invalidChord.ok, false);
  if (invalidChord.ok) {
    assert.fail("expected invalid chord to fail closed");
  }
  assert.equal(invalidChord.error.code, "INVALID_CHORD");
});

function testCommands(): readonly ShortcutCommand[] {
  return Object.freeze([
    launchCommand("command.palette", "Palette", "vita.command.palette", "palette"),
    launchCommand("command.dark", "Dark Mode", "vita.command.dark", "dark"),
    launchCommand("__proto__", "Special", "vita.command.special", "special"),
  ]);
}

function launchCommand(id: string, title: string, appId: string, query: string): ShortcutCommand {
  return Object.freeze({
    id,
    intent: Object.freeze({
      appId,
      query,
      type: "launcher.launch",
    }),
    title,
  });
}

function binding(chord: string, commandId: string, source: "default" | "user"): ShortcutBinding {
  const normalized = normalizeShortcutChord(chord);

  assert.equal(normalized.ok, true);
  if (!normalized.ok) {
    assert.fail("expected test binding chord to normalize");
  }

  return Object.freeze({
    chord: normalized.chord,
    commandId,
    source,
  });
}

function projectBinding(bindingValue: ShortcutBinding): readonly [string, string, string] {
  return [bindingValue.chord, bindingValue.commandId, bindingValue.source];
}

function fakePorts(
  events: string[],
  grants: readonly DesktopCapabilityGrant[] = Object.freeze([]),
  options: {
    readonly launcherPort?: boolean;
    readonly throwPort?: boolean;
  } = Object.freeze({}),
): ShortcutCommandPort {
  const ports: {
    package: DesktopUiPackageManifest;
    emitLauncherIntent?: (intent: DesktopLauncherIntent) => DesktopHostResult<true>;
  } = {
    package: manifest(grants),
  };

  if (options.launcherPort !== false) {
    ports.emitLauncherIntent = (intent) => {
      events.push(`launcher:${intent.type}:${intent.appId ?? ""}:${intent.query ?? ""}`);

      if (options.throwPort === true) {
        throw new Error("configured launcher failure");
      }

      return {
        ok: true,
        value: true,
      };
    };
  }

  return Object.freeze(ports);
}

function manifest(grants: readonly DesktopCapabilityGrant[]): DesktopUiPackageManifest {
  return Object.freeze({
    capabilityGrants: Object.freeze([...grants]),
    entry: "./Shortcuts.test.ts",
    id: "ui.shortcuts.test",
    sdkVersion: "1.0.0",
    version: "1.0.0",
  });
}

function grant(capability: DesktopCapability, resourceId?: string): DesktopCapabilityGrant {
  const output: {
    capability: DesktopCapability;
    resourceId?: string;
  } = {
    capability,
  };

  if (resourceId !== undefined) output.resourceId = resourceId;

  return Object.freeze(output);
}
