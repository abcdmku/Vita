import assert from "node:assert/strict";
import { test } from "node:test";

import {
  createShortcutCheatsheet,
  formatChordGlyph,
  fromShortcutsState,
} from "../../../../ui_kits/desktop/viewmodels/shortcut-cheatsheet.ts";
import type {
  CheatsheetCommandInput,
  CheatsheetGroup,
  CheatsheetRow,
  ShortcutKeymap,
} from "../../../../ui_kits/desktop/viewmodels/shortcut-cheatsheet.ts";
import {
  createShortcutsViewModel,
  normalizeShortcutChord,
} from "../../../../ui_kits/desktop/viewmodels/shortcuts.ts";
import type {
  ShortcutBinding,
  ShortcutCommandPort,
} from "../../../../ui_kits/desktop/viewmodels/shortcuts.ts";
import type {
  DesktopUiPackageManifest,
} from "../../src/desktop-sdk/index.ts";

test("glyph formatting renders mac symbols and pc labels for the same canonical chord", () => {
  assert.equal(formatChordGlyph("Meta+Comma", "mac"), "⌘,");
  assert.equal(formatChordGlyph("Meta+Comma", "win"), "Super+,");
  assert.equal(formatChordGlyph("Meta+Comma", "linux"), "Super+,");

  assert.equal(formatChordGlyph("Control+Shift+D", "mac"), "⌃⇧D");
  assert.equal(formatChordGlyph("Control+Shift+D", "win"), "Ctrl+Shift+D");

  assert.equal(formatChordGlyph("Control+Space", "mac"), "⌃Space");
  assert.equal(formatChordGlyph("Escape", "win"), "Esc");
  assert.equal(formatChordGlyph("Alt+ArrowLeft", "mac"), "⌥←");
});

test("glyph formatting respects normalization-equivalence", () => {
  // `Cmd+,` and `Meta+Comma` normalize identically, so they must format identically.
  assert.equal(formatChordGlyph("Cmd+,", "mac"), formatChordGlyph("Meta+Comma", "mac"));
  assert.equal(formatChordGlyph("cmd+,", "win"), "Super+,");
  assert.equal(formatChordGlyph("super+slash", "win"), "Super+/");
  // A malformed chord yields an empty glyph, fail-closed.
  assert.equal(formatChordGlyph("Control+", "mac"), "");
});

test("rows group by category with stable cross-call ordering and per-platform glyphs", () => {
  const sheet = createShortcutCheatsheet({
    bindings: [
      binding("Control+Space", "launcher.open", "default"),
      binding("Control+Comma", "settings.open", "default"),
      binding("Control+Shift+D", "theme.toggle", "user"),
    ],
    commands: [
      command("theme.toggle", "Toggle Dark Mode", "Appearance"),
      command("launcher.open", "Open Launcher", "Navigation"),
      command("settings.open", "Open Settings", "Appearance"),
      command("help.open", "Open Help"),
    ],
    keymap: "mac",
  });

  const snapshot = sheet.snapshot();

  // Categories sorted alphabetically; "General" is the fallback for help.open.
  assert.deepEqual(snapshot.groups.map((group) => group.category), [
    "Appearance",
    "General",
    "Navigation",
  ]);

  const appearance = groupNamed(snapshot.groups, "Appearance");
  // Within-category rows sorted by title: "Open Settings" < "Toggle Dark Mode".
  assert.deepEqual(appearance.rows.map((row) => [row.commandId, row.glyph]), [
    ["settings.open", "⌃,"],
    ["theme.toggle", "⌃⇧D"],
  ]);

  const general = groupNamed(snapshot.groups, "General");
  assert.deepEqual(general.rows.map((row) => [row.commandId, row.unbound, row.glyph]), [
    ["help.open", true, ""],
  ]);

  // Snapshot is deeply frozen and identity-stable across reads.
  assert.equal(sheet.snapshot(), snapshot);
  assert.equal(Object.isFrozen(snapshot), true);
  assert.equal(Object.isFrozen(snapshot.groups), true);
  assert.equal(Object.isFrozen(appearance.rows), true);
  assert.equal(Object.isFrozen(appearance.rows[0]), true);
});

test("unbound and conflict flags are computed from the effective bindings", () => {
  const sheet = createShortcutCheatsheet({
    bindings: [
      binding("Control+K", "a.cmd", "default"),
      binding("Control+K", "b.cmd", "user"),
      binding("Control+P", "c.cmd", "default"),
    ],
    commands: [
      command("a.cmd", "Alpha"),
      command("b.cmd", "Bravo"),
      command("c.cmd", "Charlie"),
      command("d.cmd", "Delta"),
    ],
    keymap: "win",
  });

  const rows = allRows(sheet.snapshot().groups);
  const byId = new Map(rows.map((row) => [row.commandId, row]));

  assert.equal(byId.get("a.cmd")?.conflict, true);
  assert.equal(byId.get("b.cmd")?.conflict, true);
  assert.equal(byId.get("c.cmd")?.conflict, false);
  assert.equal(byId.get("c.cmd")?.unbound, false);
  assert.equal(byId.get("d.cmd")?.unbound, true);
  assert.equal(byId.get("d.cmd")?.conflict, false);
  assert.equal(byId.get("d.cmd")?.glyph, "");
});

test("setQuery filters case-insensitively over title and glyph without mutating bindings", () => {
  const sheet = createShortcutCheatsheet({
    bindings: [
      binding("Control+Space", "launcher.open", "default"),
      binding("Control+Comma", "settings.open", "default"),
      binding("Control+Shift+D", "theme.toggle", "user"),
    ],
    commands: [
      command("launcher.open", "Open Launcher", "Navigation"),
      command("settings.open", "Open Settings", "Appearance"),
      command("theme.toggle", "Toggle Dark Mode", "Appearance"),
    ],
    keymap: "win",
  });

  const base = sheet.snapshot();

  // Match by title (case-insensitive).
  const byTitle = sheet.setQuery("DARK");
  assert.deepEqual(commandIds(byTitle.snapshot()), ["theme.toggle"]);
  assert.equal(byTitle.snapshot().query, "DARK");

  // Match by glyph: "Ctrl+," appears only for settings.open on win.
  const byGlyph = sheet.setQuery("ctrl+,");
  assert.deepEqual(commandIds(byGlyph.snapshot()), ["settings.open"]);

  // No match yields no groups.
  assert.deepEqual(byTitle === sheet, false);
  assert.deepEqual(sheet.setQuery("zzz").snapshot().groups, []);

  // setQuery is non-mutating: the original snapshot is untouched.
  assert.equal(sheet.snapshot(), base);
  assert.deepEqual(commandIds(base), ["settings.open", "theme.toggle", "launcher.open"]);

  // Empty / whitespace query returns the full set; identical query returns same instance.
  assert.deepEqual(commandIds(sheet.setQuery("   ").snapshot()), commandIds(base));
  assert.equal(sheet.setQuery(""), sheet);
});

test("query construction filters at build time identically to setQuery", () => {
  const commands: readonly CheatsheetCommandInput[] = [
    command("a.cmd", "Apple", "Fruit"),
    command("b.cmd", "Banana", "Fruit"),
  ];
  const bindings = [
    binding("Control+A", "a.cmd", "default"),
    binding("Control+B", "b.cmd", "default"),
  ];

  const built = createShortcutCheatsheet({ bindings, commands, keymap: "win", query: "apple" });
  const queried = createShortcutCheatsheet({ bindings, commands, keymap: "win" }).setQuery("apple");

  assert.deepEqual(commandIds(built.snapshot()), ["a.cmd"]);
  assert.deepEqual(commandIds(built.snapshot()), commandIds(queried.snapshot()));
});

test("fromShortcutsState adapts the shortcuts view-model snapshot", () => {
  const vm = createShortcutsViewModel(fakePorts());
  const sheet = fromShortcutsState(vm.snapshot(), "mac");
  const rows = allRows(sheet.snapshot().groups);
  const byId = new Map(rows.map((row) => [row.commandId, row]));

  // Default commands have no category, so they land in "General".
  assert.deepEqual(sheet.snapshot().groups.map((group) => group.category), ["General"]);
  assert.equal(byId.get("desktop.launcher.open")?.glyph, "⌃Space");
  assert.equal(byId.get("desktop.theme.toggle")?.glyph, "⌃⇧D");
  assert.equal(byId.get("desktop.launcher.close")?.glyph, "Esc");
  assert.equal(rows.every((row) => row.unbound === false), true);
});

function groupNamed(groups: readonly CheatsheetGroup[], category: string): CheatsheetGroup {
  const found = groups.find((group) => group.category === category);

  assert.notEqual(found, undefined);
  if (found === undefined) {
    assert.fail(`expected group ${category}`);
  }

  return found;
}

function allRows(groups: readonly CheatsheetGroup[]): readonly CheatsheetRow[] {
  const output: CheatsheetRow[] = [];

  for (const group of groups) {
    for (const row of group.rows) {
      output.push(row);
    }
  }

  return output;
}

function commandIds(snapshot: { readonly groups: readonly CheatsheetGroup[] }): readonly string[] {
  return allRows(snapshot.groups).map((row) => row.commandId);
}

function command(id: string, title: string, category?: string): CheatsheetCommandInput {
  if (category === undefined) {
    return Object.freeze({ id, title });
  }

  return Object.freeze({ category, id, title });
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

function fakePorts(): ShortcutCommandPort {
  return Object.freeze({
    package: manifest(),
  });
}

function manifest(): DesktopUiPackageManifest {
  return Object.freeze({
    capabilityGrants: Object.freeze([]),
    entry: "./shortcut-cheatsheet.test.ts",
    id: "ui.shortcut.cheatsheet.test",
    sdkVersion: "1.0.0",
    version: "1.0.0",
  });
}

type _KeymapCheck = ShortcutKeymap;
