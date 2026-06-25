import assert from "node:assert/strict";
import { test } from "node:test";

import {
  DEFAULT_KEYMAP_PROFILES,
  KEYMAP_COMMAND_IDS,
  createKeymapProfilesViewModel,
} from "../../../../ui_kits/desktop/viewmodels/keymap-profiles.ts";
import type {
  KeymapBinding,
  KeymapProfilesPort,
} from "../../../../ui_kits/desktop/viewmodels/keymap-profiles.ts";
import type { DesktopUiPackageManifest } from "../../src/desktop-sdk/index.ts";

test("keymap view-model seeds the four named presets with a frozen default snapshot", () => {
  const vm = createKeymapProfilesViewModel(fakePort());
  const snapshot = vm.snapshot();

  assert.deepEqual(snapshot.profiles.map((profile) => [profile.id, profile.title]), [
    ["Default", "Default"],
    ["macOS", "macOS"],
    ["Emacs", "Emacs"],
    ["Vim", "Vim"],
  ]);
  assert.equal(snapshot.activeProfileId, "Default");
  assert.equal(vm.activeProfileId(), "Default");
  assert.deepEqual(snapshot.conflicts, []);
  assert.equal(Object.isFrozen(snapshot), true);
  assert.equal(Object.isFrozen(snapshot.bindings), true);
  assert.equal(DEFAULT_KEYMAP_PROFILES.length, 4);

  // Default preset uses Control-based chords, all canonicalized through shortcuts.ts.
  assert.deepEqual(snapshot.bindings.map(project), [
    ["Control+Space", KEYMAP_COMMAND_IDS.openLauncher, "profile"],
    ["Escape", KEYMAP_COMMAND_IDS.closeLauncher, "profile"],
    ["Control+Comma", KEYMAP_COMMAND_IDS.launchSettings, "profile"],
    ["Control+Shift+D", KEYMAP_COMMAND_IDS.toggleDarkMode, "profile"],
    ["Control+Shift+P", KEYMAP_COMMAND_IDS.commandPalette, "profile"],
    ["Control+Tab", KEYMAP_COMMAND_IDS.nextWindow, "profile"],
    ["Control+Shift+Tab", KEYMAP_COMMAND_IDS.prevWindow, "profile"],
  ]);
});

test("setActiveProfile recomputes effective bindings deterministically", () => {
  const vm = createKeymapProfilesViewModel(fakePort());
  const before = vm.snapshot();

  const switched = vm.setActiveProfile("macOS");

  assert.equal(switched.ok, true);
  if (!switched.ok) {
    assert.fail("expected profile switch to succeed");
  }
  assert.equal(vm.activeProfileId(), "macOS");
  // macOS preset swaps Control -> Meta for the launcher/settings/theme commands.
  assert.equal(chordFor(vm.list(), KEYMAP_COMMAND_IDS.openLauncher), "Meta+Space");
  assert.equal(chordFor(vm.list(), KEYMAP_COMMAND_IDS.launchSettings), "Meta+Comma");
  // Canonical modifier order from shortcuts.ts is Control, Alt, Shift, Meta — so
  // a "Meta+Shift+D" preset chord normalizes to "Shift+Meta+D".
  assert.equal(chordFor(vm.list(), KEYMAP_COMMAND_IDS.toggleDarkMode), "Shift+Meta+D");
  // Escape (close launcher) is shared across presets and stays canonical.
  assert.equal(chordFor(vm.list(), KEYMAP_COMMAND_IDS.closeLauncher), "Escape");

  // Switching is a pure recompute: the prior snapshot object is untouched.
  assert.equal(before.activeProfileId, "Default");
  assert.equal(chordFor(before.bindings, KEYMAP_COMMAND_IDS.openLauncher), "Control+Space");

  // Determinism: switching back yields byte-identical effective bindings.
  const again = createKeymapProfilesViewModel(fakePort());

  again.setActiveProfile("macOS");
  assert.deepEqual(again.list().map(project), vm.list().map(project));
});

test("setActiveProfile fails closed for an unknown profile id without mutating state", () => {
  const vm = createKeymapProfilesViewModel(fakePort());
  const before = vm.snapshot();

  const rejected = vm.setActiveProfile("Dvorak");

  assert.equal(rejected.ok, false);
  if (rejected.ok) {
    assert.fail("expected unknown profile to fail closed");
  }
  assert.equal(rejected.error.code, "UNKNOWN_PROFILE");
  assert.equal(vm.snapshot(), before);
  assert.equal(vm.activeProfileId(), "Default");

  const rejectedNonString = vm.setActiveProfile(42);

  assert.equal(rejectedNonString.ok, false);
  if (rejectedNonString.ok) {
    assert.fail("expected non-string profile id to fail closed");
  }
  assert.equal(rejectedNonString.error.code, "UNKNOWN_PROFILE");
});

test("user overrides beat profile bindings in the effective merge", () => {
  const vm = createKeymapProfilesViewModel(fakePort(), {
    activeProfileId: "Default",
    userOverrides: [
      // chord spelled loosely + normalized; the user's binding wins for the command.
      { chord: "alt + space", commandId: KEYMAP_COMMAND_IDS.openLauncher },
      // a user-only command not present in any profile is appended.
      { chord: "Ctrl+Shift+K", commandId: "user.only.command" },
    ],
  });
  const bindings = vm.list();

  assert.equal(chordFor(bindings, KEYMAP_COMMAND_IDS.openLauncher), "Alt+Space");
  assert.equal(sourceFor(bindings, KEYMAP_COMMAND_IDS.openLauncher), "user");
  // Non-overridden command keeps the profile binding.
  assert.equal(chordFor(bindings, KEYMAP_COMMAND_IDS.launchSettings), "Control+Comma");
  assert.equal(sourceFor(bindings, KEYMAP_COMMAND_IDS.launchSettings), "profile");
  // The user-only command is present, exactly once, as a user binding.
  assert.equal(chordFor(bindings, "user.only.command"), "Control+Shift+K");
  assert.equal(sourceFor(bindings, "user.only.command"), "user");
  assert.equal(bindings.filter((b) => b.commandId === KEYMAP_COMMAND_IDS.openLauncher).length, 1);

  // The override survives a profile switch (user layer is independent of preset).
  vm.setActiveProfile("Vim");
  assert.equal(chordFor(vm.list(), KEYMAP_COMMAND_IDS.openLauncher), "Alt+Space");
  assert.equal(sourceFor(vm.list(), KEYMAP_COMMAND_IDS.openLauncher), "user");
});

test("per-profile conflict report flags one normalized chord bound to >1 command", () => {
  // A user override collides with a profile binding on the same normalized chord.
  const vm = createKeymapProfilesViewModel(fakePort(), {
    profiles: [
      {
        bindings: [
          { chord: "Ctrl+K", commandId: "command.a" },
          { chord: "Ctrl+J", commandId: "command.b" },
        ],
        id: "Conflicting",
        title: "Conflicting",
      },
    ],
    userOverrides: [
      // loose spelling normalizes to the SAME canonical chord as command.a -> conflict.
      { chord: "control + k", commandId: "command.b" },
    ],
  });
  const snapshot = vm.snapshot();

  assert.equal(snapshot.conflicts.length, 1);
  assert.equal(snapshot.conflicts[0]?.chord, "Control+K");
  assert.deepEqual(snapshot.conflicts[0]?.commandIds, ["command.a", "command.b"]);

  // No accidental conflict when chords differ.
  const clean = createKeymapProfilesViewModel(fakePort());

  assert.deepEqual(clean.snapshot().conflicts, []);
});

test("diff(from, to) is pure: returns added/removed/changed with no mutation", () => {
  const vm = createKeymapProfilesViewModel(fakePort(), {
    profiles: [
      {
        bindings: [
          { chord: "Ctrl+A", commandId: "shared.kept" },
          { chord: "Ctrl+B", commandId: "shared.changed" },
          { chord: "Ctrl+C", commandId: "only.in.from" },
        ],
        id: "From",
        title: "From",
      },
      {
        bindings: [
          { chord: "Ctrl+A", commandId: "shared.kept" },
          { chord: "Ctrl+Z", commandId: "shared.changed" },
          { chord: "Ctrl+D", commandId: "only.in.to" },
        ],
        id: "To",
        title: "To",
      },
    ],
  });
  const activeBefore = vm.activeProfileId();
  const snapshotBefore = vm.snapshot();

  const result = vm.diff("From", "To");

  assert.equal(result.ok, true);
  if (!result.ok) {
    assert.fail("expected diff to succeed");
  }
  const { diff } = result;

  assert.equal(diff.fromProfileId, "From");
  assert.equal(diff.toProfileId, "To");
  assert.deepEqual(diff.added.map((ref) => [ref.commandId, ref.chord]), [
    ["only.in.to", "Control+D"],
  ]);
  assert.deepEqual(diff.removed.map((ref) => [ref.commandId, ref.chord]), [
    ["only.in.from", "Control+C"],
  ]);
  assert.deepEqual(diff.changed.map((change) => [change.commandId, change.from, change.to]), [
    ["shared.changed", "Control+B", "Control+Z"],
  ]);
  assert.equal(Object.isFrozen(diff), true);
  assert.equal(Object.isFrozen(diff.added), true);

  // Purity: diff did not change active profile or the live snapshot identity.
  assert.equal(vm.activeProfileId(), activeBefore);
  assert.equal(vm.snapshot(), snapshotBefore);

  // Reverse diff swaps added/removed and inverts the change direction.
  const reverse = vm.diff("To", "From");

  assert.equal(reverse.ok, true);
  if (!reverse.ok) {
    assert.fail("expected reverse diff to succeed");
  }
  assert.deepEqual(reverse.diff.added.map((ref) => ref.commandId), ["only.in.from"]);
  assert.deepEqual(reverse.diff.removed.map((ref) => ref.commandId), ["only.in.to"]);
  assert.deepEqual(reverse.diff.changed.map((change) => [change.from, change.to]), [
    ["Control+Z", "Control+B"],
  ]);
});

test("diff fails closed when a profile id is unknown", () => {
  const vm = createKeymapProfilesViewModel(fakePort());

  const badFrom = vm.diff("Nope", "macOS");
  const badTo = vm.diff("Default", "Nope");

  assert.equal(badFrom.ok, false);
  if (badFrom.ok) {
    assert.fail("expected unknown source profile to fail closed");
  }
  assert.equal(badFrom.error.code, "UNKNOWN_PROFILE");
  assert.equal(badTo.ok, false);
  if (badTo.ok) {
    assert.fail("expected unknown target profile to fail closed");
  }
  assert.equal(badTo.error.code, "UNKNOWN_PROFILE");
});

function project(binding: KeymapBinding): readonly [string, string, string] {
  return [binding.chord, binding.commandId, binding.source];
}

function chordFor(bindings: readonly KeymapBinding[], commandId: string): string | undefined {
  return bindings.find((binding) => binding.commandId === commandId)?.chord;
}

function sourceFor(bindings: readonly KeymapBinding[], commandId: string): string | undefined {
  return bindings.find((binding) => binding.commandId === commandId)?.source;
}

function fakePort(): KeymapProfilesPort {
  return Object.freeze({
    package: manifest(),
  });
}

function manifest(): DesktopUiPackageManifest {
  return Object.freeze({
    capabilityGrants: Object.freeze([]),
    entry: "./keymap-profiles.test.ts",
    id: "ui.keymap.test",
    sdkVersion: "1.0.0",
    version: "1.0.0",
  });
}
