import assert from "node:assert/strict";
import { test } from "node:test";

import {
  DEFAULT_SHORTCUT_BINDINGS,
  DEFAULT_SHORTCUT_BINDINGS_V2,
  DEFAULT_SHORTCUT_COMMANDS,
  DEFAULT_SHORTCUT_COMMANDS_V2,
  SHORTCUT_COMMAND_IDS,
  SHORTCUT_COMMAND_IDS_V2,
  SHORTCUT_POLICY_VERBS,
  detectShortcutConflicts,
  normalizeShortcutChord,
} from "../../../../ui_kits/desktop/viewmodels/shortcuts.ts";
import type {
  ShortcutBinding,
  ShortcutBindingInput,
  ShortcutCommandV2,
  ShortcutCrossDomainAction,
} from "../../../../ui_kits/desktop/viewmodels/shortcuts.ts";

const LAUNCHER_INTENT_TYPES = new Set(["launcher.open", "launcher.close", "launcher.launch"]);

test("V1 default sets are untouched by the cross-domain additions (PSD-260C pins)", () => {
  // The V2 layer is strictly additive: the V1 frozen sets keep their identity,
  // length, and contents so the existing Shortcuts/coverage suites stay green.
  assert.equal(Object.isFrozen(DEFAULT_SHORTCUT_COMMANDS), true);
  assert.equal(Object.isFrozen(DEFAULT_SHORTCUT_BINDINGS), true);
  assert.equal(DEFAULT_SHORTCUT_COMMANDS.length, 4);
  assert.equal(DEFAULT_SHORTCUT_BINDINGS.length, 4);
  assert.deepEqual(
    DEFAULT_SHORTCUT_BINDINGS.map((binding) => [binding.chord, binding.commandId]),
    [
      ["Control+Space", SHORTCUT_COMMAND_IDS.openLauncher],
      ["Escape", SHORTCUT_COMMAND_IDS.closeLauncher],
      ["Control+Comma", SHORTCUT_COMMAND_IDS.launchSettings],
      ["Control+Shift+D", SHORTCUT_COMMAND_IDS.toggleDarkMode],
    ],
  );
});

test("V2 cross-domain command set is frozen and covers the WM/workspace/theme verbs", () => {
  assert.equal(Object.isFrozen(DEFAULT_SHORTCUT_COMMANDS_V2), true);
  assert.equal(Object.isFrozen(DEFAULT_SHORTCUT_BINDINGS_V2), true);

  const kinds = new Set(DEFAULT_SHORTCUT_COMMANDS_V2.map((command) => command.action.kind));

  assert.equal(kinds.has("wm.snap"), true);
  assert.equal(kinds.has("wm.maximize"), true);
  assert.equal(kinds.has("wm.minimize"), true);
  assert.equal(kinds.has("wm.close"), true);
  assert.equal(kinds.has("workspace.switch"), true);
  assert.equal(kinds.has("workspace.move"), true);
  assert.equal(kinds.has("theme.toggle"), true);
  assert.equal(kinds.has("layout.toggle"), true);

  // Workspace switch 1..9 are all present and ordered.
  const switchIndexes = DEFAULT_SHORTCUT_COMMANDS_V2
    .filter((command) => command.action.kind === "workspace.switch")
    .map((command) => (command.action.kind === "workspace.switch" ? command.action.index : -1));

  assert.deepEqual(switchIndexes, [1, 2, 3, 4, 5, 6, 7, 8, 9]);
});

test("every V2 default command maps to a valid typed action targeting a real SDK target", () => {
  for (let index = 0; index < DEFAULT_SHORTCUT_COMMANDS_V2.length; index += 1) {
    const command = DEFAULT_SHORTCUT_COMMANDS_V2[index];

    assert.notEqual(command, undefined);
    if (command === undefined) {
      assert.fail("expected a command");
    }

    assert.equal(typeof command.id, "string");
    assert.equal(command.id.length > 0, true);
    assert.equal(typeof command.title, "string");
    assert.equal(command.title.length > 0, true);
    assert.equal(Object.isFrozen(command), true);
    assert.equal(Object.isFrozen(command.action), true);

    assertActionTargetsRealVerb(command.action);

    // The structurally-compatible launcher intent is always a real launcher intent.
    assert.equal(LAUNCHER_INTENT_TYPES.has(command.intent.type), true);
  }
});

test("policyVerb names resolve to real @vita/desktop-sdk policy functions", () => {
  const verbNames = Object.keys(SHORTCUT_POLICY_VERBS).sort();

  assert.deepEqual(verbNames, [
    "closeWindow",
    "maximizeWindow",
    "minimizeWindow",
    "moveWindowToWorkspace",
    "setWorkspaceLayout",
    "switchWorkspace",
  ]);

  for (const value of Object.values(SHORTCUT_POLICY_VERBS)) {
    assert.equal(typeof value, "function");
  }

  // Each cross-domain command that names a policyVerb names one of these.
  for (let index = 0; index < DEFAULT_SHORTCUT_COMMANDS_V2.length; index += 1) {
    const command = DEFAULT_SHORTCUT_COMMANDS_V2[index];

    if (command === undefined) {
      continue;
    }

    const verb = policyVerbOf(command.action);

    if (verb !== null) {
      assert.equal(
        Object.prototype.hasOwnProperty.call(SHORTCUT_POLICY_VERBS, verb),
        true,
        `command ${command.id} names unknown policy verb '${verb}'`,
      );
    }
  }
});

test("the expanded V2 keymap is conflict-free under detectShortcutConflicts", () => {
  const bindings = bindingsFrom(DEFAULT_SHORTCUT_BINDINGS_V2, "default");
  const conflicts = detectShortcutConflicts(bindings);

  assert.deepEqual(conflicts, []);

  // Every V2 chord normalizes and every binding references a real V2 command id
  // (or the shared toggleDarkMode V1 id).
  const knownIds = new Set<string>([
    SHORTCUT_COMMAND_IDS.toggleDarkMode,
    ...Object.values(SHORTCUT_COMMAND_IDS_V2),
  ]);

  for (let index = 0; index < DEFAULT_SHORTCUT_BINDINGS_V2.length; index += 1) {
    const binding = DEFAULT_SHORTCUT_BINDINGS_V2[index];

    if (binding === undefined) {
      continue;
    }

    const normalized = normalizeShortcutChord(binding.chord);

    assert.equal(normalized.ok, true, `chord ${binding.chord} should normalize`);
    assert.equal(knownIds.has(binding.commandId), true, `binding references unknown command ${binding.commandId}`);
  }
});

test("the canonical WM chords are bound as the contract specifies", () => {
  const byCommand = new Map<string, string>();

  for (const binding of DEFAULT_SHORTCUT_BINDINGS_V2) {
    const normalized = normalizeShortcutChord(binding.chord);

    if (normalized.ok) {
      byCommand.set(binding.commandId, normalized.chord);
    }
  }

  assert.equal(byCommand.get(SHORTCUT_COMMAND_IDS_V2.snapLeft), "Meta+ArrowLeft");
  assert.equal(byCommand.get(SHORTCUT_COMMAND_IDS_V2.snapRight), "Meta+ArrowRight");
  assert.equal(byCommand.get(SHORTCUT_COMMAND_IDS_V2.snapDown), "Meta+ArrowDown");
  assert.equal(byCommand.get(SHORTCUT_COMMAND_IDS_V2.maximizeWindow), "Meta+ArrowUp");
  assert.equal(byCommand.get(SHORTCUT_COMMAND_IDS_V2.minimizeWindow), "Meta+H");
  assert.equal(byCommand.get(SHORTCUT_COMMAND_IDS_V2.closeWindow), "Meta+W");
  assert.equal(byCommand.get(SHORTCUT_COMMAND_IDS_V2.switchWorkspace1), "Meta+1");
  assert.equal(byCommand.get(SHORTCUT_COMMAND_IDS_V2.switchWorkspace9), "Meta+9");
  // Canonical modifier order is Control, Alt, Shift, Meta (see MODIFIER_ORDER),
  // so Super+Shift+ArrowLeft normalizes with Shift before Meta.
  assert.equal(byCommand.get(SHORTCUT_COMMAND_IDS_V2.moveWorkspaceLeft), "Shift+Meta+ArrowLeft");
  assert.equal(byCommand.get(SHORTCUT_COMMAND_IDS_V2.moveWorkspaceRight), "Shift+Meta+ArrowRight");
});

test("merging V1 + V2 keymaps stays conflict-free (no shared chord collides)", () => {
  // V1 uses Control/Escape chords; V2 uses Super (Meta) chords — the union must
  // not introduce a conflict, proving the two layers compose.
  const merged = [
    ...bindingsFrom(DEFAULT_SHORTCUT_BINDINGS, "default"),
    ...bindingsFrom(DEFAULT_SHORTCUT_BINDINGS_V2, "default"),
  ];

  assert.deepEqual(detectShortcutConflicts(merged), []);
});

function assertActionTargetsRealVerb(action: ShortcutCrossDomainAction): void {
  switch (action.kind) {
    case "launcher.intent":
    case "theme.toggle":
      assert.equal(LAUNCHER_INTENT_TYPES.has(action.intent.type), true);
      return;
    case "wm.snap":
      assert.equal(["left", "right", "up", "down"].includes(action.direction), true);
      assert.equal(action.policyVerb, "maximizeWindow");
      return;
    case "wm.maximize":
      assert.equal(action.policyVerb, "maximizeWindow");
      return;
    case "wm.minimize":
      assert.equal(action.policyVerb, "minimizeWindow");
      return;
    case "wm.close":
      assert.equal(action.policyVerb, "closeWindow");
      return;
    case "workspace.switch":
      assert.equal(Number.isInteger(action.index), true);
      assert.equal(action.index >= 1 && action.index <= 9, true);
      assert.equal(action.policyVerb, "switchWorkspace");
      return;
    case "workspace.move":
      assert.equal(["left", "right"].includes(action.direction), true);
      assert.equal(action.policyVerb, "moveWindowToWorkspace");
      return;
    case "layout.toggle":
      assert.equal(action.policyVerb, "setWorkspaceLayout");
      return;
    default: {
      const exhaustive: never = action;

      assert.fail(`unexpected action ${JSON.stringify(exhaustive)}`);
    }
  }
}

function policyVerbOf(action: ShortcutCrossDomainAction): string | null {
  if (action.kind === "launcher.intent" || action.kind === "theme.toggle") {
    return null;
  }

  return action.policyVerb;
}

function bindingsFrom(
  inputs: readonly ShortcutBindingInput[],
  source: "default" | "user",
): readonly ShortcutBinding[] {
  const output: ShortcutBinding[] = [];

  for (const input of inputs) {
    const normalized = normalizeShortcutChord(input.chord);

    assert.equal(normalized.ok, true);
    if (!normalized.ok) {
      assert.fail("expected chord to normalize");
    }

    output.push(Object.freeze({
      chord: normalized.chord,
      commandId: input.commandId,
      source,
    }));
  }

  return Object.freeze(output);
}

// Compile-time guard: V2 commands satisfy the exported shape.
const _typeGuard: readonly ShortcutCommandV2[] = DEFAULT_SHORTCUT_COMMANDS_V2;
void _typeGuard;
