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
  ShortcutDispatchResult,
  ShortcutPersistenceBinding,
} from "../../../../ui_kits/desktop/viewmodels/shortcuts.ts";
import type {
  DesktopCapability,
  DesktopCapabilityGrant,
  DesktopHostError,
  DesktopHostResult,
  DesktopLauncherIntent,
  DesktopUiPackageManifest,
} from "../../src/desktop-sdk/index.ts";

test("shortcuts registry seeds frozen defaults and preserves snapshot identity on no-op", () => {
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
  assert.equal(vm.list(), snapshot.bindings);
  assert.equal(vm.snapshot(), snapshot);
  assert.equal(Object.isFrozen(snapshot), true);
  assert.equal(Object.isFrozen(snapshot.commands), true);
  assert.equal(Object.isFrozen(snapshot.defaults), true);
  assert.equal(Object.isFrozen(snapshot.bindings), true);
  assert.equal(DEFAULT_SHORTCUT_COMMANDS.length, 4);
  assert.equal(DEFAULT_SHORTCUT_BINDINGS.length, 4);

  const noOp = vm.register("Control+Space", "");

  assert.equal(noOp.ok, false);
  if (noOp.ok) {
    assert.fail("expected empty command id to be rejected");
  }
  assert.equal(noOp.error.code, "UNKNOWN_COMMAND");
  assert.equal(noOp.state, snapshot);
  assert.equal(vm.snapshot(), snapshot);
});

test("shortcut normalization canonicalizes strings, key events, codes, aliases, and function keys", () => {
  assertNormalized("ctrl + option + shift + cmd + k", "Control+Alt+Shift+Meta+K");
  assertNormalized("super+slash", "Meta+Slash");
  assertNormalized("command+period", "Meta+Period");
  assertNormalized("control+comma", "Control+Comma");
  assertNormalized("alt+space", "Alt+Space");
  assertNormalized("esc", "Escape");
  assertNormalized("f12", "F12");
  assertNormalized("F24", "F24");
  assertNormalized("a", "A");
  assertNormalized({
    altKey: true,
    ctrlKey: true,
    key: "x",
    metaKey: true,
    shiftKey: true,
  }, "Control+Alt+Shift+Meta+X");
  assertNormalized({
    code: "KeyZ",
  }, "Z");
  assertNormalized({
    code: "Digit7",
  }, "7");
  assertNormalized({
    code: "KeyQ",
    key: "p",
  }, "P");
});

test("shortcut normalization rejects invalid chords and malformed key events fail-closed", () => {
  for (const input of ["", "Control+", "Control+Alt", "A+B"]) {
    const normalized = normalizeShortcutChord(input);

    assert.equal(normalized.ok, false);
    if (normalized.ok) {
      assert.fail(`expected invalid chord ${input} to be rejected`);
    }
    assert.equal(normalized.error.code, "INVALID_CHORD");
  }

  for (const input of [
    null,
    Object.freeze([]),
    new Date(0),
    Object.freeze({ key: "k", repeat: false }),
    Object.freeze({ key: 1 }),
    Object.freeze({ code: 1 }),
    Object.freeze({ ctrlKey: "yes", key: "k" }),
    Object.freeze({ ctrlKey: true }),
  ]) {
    const normalized = normalizeShortcutChord(input);

    assert.equal(normalized.ok, false);
    if (normalized.ok) {
      assert.fail("expected malformed key event to be rejected");
    }
    assert.equal(normalized.error.code, "INVALID_KEY_EVENT");
  }

  let reads = 0;
  const accessorEvent: Record<string, unknown> = {
    ctrlKey: true,
  };

  Object.defineProperty(accessorEvent, "key", {
    enumerable: true,
    get() {
      reads += 1;
      return "p";
    },
  });

  const normalized = normalizeShortcutChord(accessorEvent);

  assert.equal(normalized.ok, false);
  if (normalized.ok) {
    assert.fail("expected accessor key event to be rejected");
  }
  assert.equal(normalized.error.code, "INVALID_KEY_EVENT");
  assert.equal(reads, 0);
});

test("register, rebind, reset, precedence, and special command ids remain deterministic", () => {
  const vm = createShortcutsViewModel(fakePorts([]), {
    commands: testCommands(),
    defaults: [
      { chord: "Ctrl+P", commandId: "command.palette" },
      { chord: "Ctrl+D", commandId: "command.dark" },
      { chord: "Ctrl+S", commandId: "__proto__" },
    ],
    userOverrides: [
      { chord: "Alt+P", commandId: "command.palette" },
    ],
  });

  assert.deepEqual(vm.list().map(projectBinding), [
    ["Control+D", "command.dark", "default"],
    ["Control+S", "__proto__", "default"],
    ["Alt+P", "command.palette", "user"],
  ]);

  const rebound = vm.rebind("command.dark", "cmd + /");

  assert.equal(rebound.ok, true);
  if (!rebound.ok) {
    assert.fail("expected rebind to succeed");
  }
  assert.deepEqual(vm.list().map(projectBinding), [
    ["Control+S", "__proto__", "default"],
    ["Alt+P", "command.palette", "user"],
    ["Meta+Slash", "command.dark", "user"],
  ]);

  const special = vm.register("Control+1", "__proto__");

  assert.equal(special.ok, true);
  if (!special.ok) {
    assert.fail("expected special command id to register");
  }
  const resolvedSpecial = vm.resolve("Control+1");

  assert.equal(resolvedSpecial.ok, true);
  if (!resolvedSpecial.ok) {
    assert.fail("expected special command id to resolve");
  }
  assert.equal(resolvedSpecial.command.id, "__proto__");
  assert.equal(Object.prototype.hasOwnProperty.call(Object.fromEntries([
    [resolvedSpecial.command.id, resolvedSpecial.command.title],
  ]), "__proto__"), true);

  const reset = vm.reset("command.palette");

  assert.equal(reset.ok, true);
  if (!reset.ok) {
    assert.fail("expected reset to restore the default");
  }
  assert.deepEqual(vm.list().map(projectBinding), [
    ["Control+P", "command.palette", "default"],
    ["Meta+Slash", "command.dark", "user"],
    ["Control+1", "__proto__", "user"],
  ]);
});

test("shortcut conflicts are detected and rejected without mutating the active keymap", () => {
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
  assert.equal(rejected.state, before);
  assert.equal(vm.snapshot(), before);
  assert.deepEqual(vm.list().map(projectBinding), [
    ["Control+P", "command.palette", "default"],
    ["Control+D", "command.dark", "default"],
  ]);

  const conflicts = detectShortcutConflicts([
    binding("Ctrl+K", "command.palette", "default"),
    binding("Control+K", "command.dark", "user"),
    binding("Alt+K", "command.palette", "user"),
  ]);

  assert.equal(conflicts.length, 1);
  assert.equal(conflicts[0]?.chord, "Control+K");
  assert.deepEqual(conflicts[0]?.commandIds, ["command.palette", "command.dark"]);
});

test("dispatch covers success and every fail-closed branch through injected launcher ports", async () => {
  const events: string[] = [];
  const success = createShortcutsViewModel(fakePorts(events, [
    grant("launcher.launch", "vita.command.palette"),
  ]), {
    commands: [launchCommand("command.palette", "Palette", "vita.command.palette", "palette")],
    defaults: [
      { chord: "Ctrl+P", commandId: "command.palette" },
    ],
  });

  const dispatched = await success.dispatch({ ctrlKey: true, key: "p" });

  assert.equal(dispatched.ok, true);
  if (!dispatched.ok) {
    assert.fail("expected successful dispatch");
  }
  assert.equal(dispatched.dispatch, "launcherIntent");
  assert.equal(dispatched.value, true);
  assert.equal(dispatched.command.id, "command.palette");
  assert.deepEqual(events, [
    "launcher:launcher.launch:vita.command.palette:palette",
  ]);

  await assertDispatchError("UNKNOWN_COMMAND", createShortcutsViewModel(fakePorts([]), {
    commands: [launchCommand("command.palette", "Palette", "vita.command.palette", "palette")],
    defaults: [
      { chord: "Ctrl+U", commandId: "command.missing" },
    ],
  }), "Ctrl+U");
  await assertDispatchError("UNBOUND_CHORD", success, "Ctrl+X");
  await assertDispatchError("MISSING_CAPABILITY", createShortcutsViewModel(fakePorts([]), {
    commands: [launchCommand("command.palette", "Palette", "vita.command.palette", "palette")],
    defaults: [
      { chord: "Ctrl+P", commandId: "command.palette" },
    ],
  }), "Ctrl+P");
  await assertDispatchError("COMMAND_PORT_UNAVAILABLE", createShortcutsViewModel(fakePorts([], [
    grant("launcher.launch", "vita.command.palette"),
  ], {
    launcherPort: false,
  }), {
    commands: [launchCommand("command.palette", "Palette", "vita.command.palette", "palette")],
    defaults: [
      { chord: "Ctrl+P", commandId: "command.palette" },
    ],
  }), "Ctrl+P");
  await assertDispatchError("COMMAND_PORT_FAILED", createShortcutsViewModel(fakePorts([], [
    grant("launcher.launch", "vita.command.palette"),
  ], {
    throwPort: true,
  }), {
    commands: [launchCommand("command.palette", "Palette", "vita.command.palette", "palette")],
    defaults: [
      { chord: "Ctrl+P", commandId: "command.palette" },
    ],
  }), "Ctrl+P");
  const hostRejected = await createShortcutsViewModel(fakePorts([], [
    grant("launcher.launch", "vita.command.palette"),
  ], {
    hostError: {
      code: "HOST_DENIED",
      message: "host refused launcher intent",
      path: "/launcher/test",
    },
  }), {
    commands: [launchCommand("command.palette", "Palette", "vita.command.palette", "palette")],
    defaults: [
      { chord: "Ctrl+P", commandId: "command.palette" },
    ],
  }).handleKeyEvent("Ctrl+P");

  assert.equal(hostRejected.ok, false);
  if (hostRejected.ok) {
    assert.fail("expected host rejection to propagate");
  }
  assert.equal(hostRejected.error.code, "HOST_DENIED");
  assert.equal(hostRejected.error.message, "host refused launcher intent");
  assert.equal(hostRejected.error.path, "/launcher/test");
});

test("shortcut persistence serializes canonical overrides and deserializes byte-stable view-models", () => {
  const vm = createShortcutsViewModel(fakePorts([]), {
    commands: testCommands(),
    defaults: [
      { chord: "Ctrl+P", commandId: "command.palette" },
      { chord: "Ctrl+D", commandId: "command.dark" },
      { chord: "Ctrl+S", commandId: "__proto__" },
    ],
  });

  assert.equal(vm.rebind("command.dark", "Alt+D").ok, true);
  assert.equal(vm.rebind("command.palette", "Alt+P").ok, true);

  const serialized = vm.serialize();

  assert.deepEqual(serialized.map(projectPersistence), [
    ["Alt+P", "command.palette"],
    ["Alt+D", "command.dark"],
  ]);
  assert.equal(Object.isFrozen(serialized), true);
  assert.equal(Object.isFrozen(serialized[0]), true);
  assert.equal(JSON.stringify(serialized), "[{\"chord\":\"Alt+P\",\"commandId\":\"command.palette\"},{\"chord\":\"Alt+D\",\"commandId\":\"command.dark\"}]");

  const hydrated = vm.deserialize(serialized);

  assert.notEqual(hydrated, vm);
  assert.deepEqual(hydrated.serialize().map(projectPersistence), serialized.map(projectPersistence));
  assert.equal(JSON.stringify(hydrated.serialize()), JSON.stringify(serialized));
  assert.deepEqual(hydrated.list().map(projectBinding), [
    ["Control+S", "__proto__", "default"],
    ["Alt+P", "command.palette", "user"],
    ["Alt+D", "command.dark", "user"],
  ]);
  assert.deepEqual(vm.serialize().map(projectPersistence), serialized.map(projectPersistence));
});

test("shortcut persistence drops malformed overrides without throwing or invoking accessors", () => {
  const vm = createShortcutsViewModel(fakePorts([]), {
    commands: testCommands(),
    defaults: [
      { chord: "Ctrl+P", commandId: "command.palette" },
      { chord: "Ctrl+D", commandId: "command.dark" },
      { chord: "Ctrl+S", commandId: "__proto__" },
    ],
  });
  const valid = Object.freeze({
    chord: "Alt+P",
    commandId: "command.palette",
  });
  const missingCommand = Object.freeze({
    chord: "Alt+M",
  });
  const emptyCommand = Object.freeze({
    chord: "Alt+E",
    commandId: "",
  });
  const invalidChord = Object.freeze({
    chord: "",
    commandId: "command.dark",
  });
  const unknownCommand = Object.freeze({
    chord: "Alt+U",
    commandId: "command.unknown",
  });
  const conflictingOverride = Object.freeze({
    chord: "Alt+P",
    commandId: "command.dark",
  });
  const conflictingDefault = Object.freeze({
    chord: "Ctrl+S",
    commandId: "command.dark",
  });
  let entryReads = 0;
  const accessorEntry: Record<string, unknown> = {
    chord: "Alt+A",
  };

  Object.defineProperty(accessorEntry, "commandId", {
    enumerable: true,
    get() {
      entryReads += 1;
      return "command.dark";
    },
  });

  const malformed = Object.freeze([
    1,
    missingCommand,
    emptyCommand,
    invalidChord,
    unknownCommand,
    valid,
    conflictingOverride,
    conflictingDefault,
    accessorEntry,
  ]);
  const hydrated = vm.deserialize(malformed);

  assert.deepEqual(hydrated.serialize().map(projectPersistence), [
    ["Alt+P", "command.palette"],
  ]);
  assert.equal(entryReads, 0);
  assert.deepEqual(vm.serialize(), []);
  assert.deepEqual(vm.deserialize(null).serialize(), []);
  assert.deepEqual(vm.deserialize(Object.freeze({ 0: valid })).serialize(), []);

  let arrayReads = 0;
  const accessorArray: unknown[] = [];

  Object.defineProperty(accessorArray, "0", {
    enumerable: true,
    get() {
      arrayReads += 1;
      return valid;
    },
  });

  assert.doesNotThrow(() => vm.deserialize(accessorArray));
  assert.deepEqual(vm.deserialize(accessorArray).serialize(), []);
  assert.equal(arrayReads, 0);

  const shadowedArray = [valid];

  Object.defineProperty(shadowedArray, "includes", {
    enumerable: true,
    value() {
      return true;
    },
  });

  assert.deepEqual(vm.deserialize(shadowedArray).serialize(), []);
});

function assertNormalized(input: unknown, expected: string): void {
  const normalized = normalizeShortcutChord(input);

  assert.equal(normalized.ok, true);
  if (!normalized.ok) {
    assert.fail(`expected ${String(input)} to normalize`);
  }
  assert.equal(normalized.chord, expected);
}

async function assertDispatchError(
  code: string,
  vm: {
    dispatch(input: unknown): Promise<ShortcutDispatchResult>;
  },
  input: unknown,
): Promise<void> {
  const result = await vm.dispatch(input);

  assert.equal(result.ok, false);
  if (result.ok) {
    assert.fail(`expected dispatch to reject with ${code}`);
  }
  assert.equal(result.error.code, code);
}

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

function projectPersistence(bindingValue: ShortcutPersistenceBinding): readonly [string, string] {
  return [bindingValue.chord, bindingValue.commandId];
}

function fakePorts(
  events: string[],
  grants: readonly DesktopCapabilityGrant[] = Object.freeze([]),
  options: {
    readonly hostError?: DesktopHostError;
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

      if (options.hostError !== undefined) {
        return {
          error: options.hostError,
          ok: false,
        };
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
    entry: "./shortcuts-coverage.test.ts",
    id: "ui.shortcuts.coverage.test",
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
