import {
  detectShortcutConflicts,
  normalizeShortcutChord,
} from "./shortcuts.ts";
import type {
  ShortcutBinding,
  ShortcutChord,
  ShortcutCommand,
  ShortcutsState,
} from "./shortcuts.ts";

// `?`-triggered shortcuts overlay view-model.
//
// Pure, headless, deterministic: groups the effective shortcut bindings by command
// category, formats a human chord glyph per platform/keymap, flags conflicts and
// unbound commands, and exposes a case-insensitive query filter that never mutates
// the underlying bindings. Glyph formatting and grouping are PURE functions of the
// normalized chord (re-using `normalizeShortcutChord`) so that normalization-
// equivalent chords (`Cmd+,` vs `Meta+Comma`) format identically.

export type ShortcutKeymap = "mac" | "win" | "linux";

export interface CheatsheetCommandInput {
  readonly id: string;
  readonly title: string;
  readonly category?: string;
}

export interface ShortcutCheatsheetInput {
  readonly bindings: readonly ShortcutBinding[];
  readonly commands: readonly ShortcutCommand[] | readonly CheatsheetCommandInput[];
  readonly keymap: ShortcutKeymap;
  readonly query?: string;
}

export interface CheatsheetRow {
  readonly commandId: string;
  readonly title: string;
  readonly category: string;
  readonly chord: ShortcutChord | null;
  readonly glyph: string;
  readonly conflict: boolean;
  readonly unbound: boolean;
}

export interface CheatsheetGroup {
  readonly category: string;
  readonly rows: readonly CheatsheetRow[];
}

export interface ShortcutCheatsheetSnapshot {
  readonly keymap: ShortcutKeymap;
  readonly query: string;
  readonly groups: readonly CheatsheetGroup[];
}

export interface ShortcutCheatsheetViewModel {
  snapshot(): ShortcutCheatsheetSnapshot;
  setQuery(text: unknown): ShortcutCheatsheetViewModel;
}

const UNCATEGORIZED = "General";

export function createShortcutCheatsheet(input: ShortcutCheatsheetInput): ShortcutCheatsheetViewModel {
  const keymap = normalizeKeymap(input.keymap);
  const commands = freezeCommands(input.commands);
  const rows = buildRows(commands, input.bindings, keymap);

  return new DesktopShortcutCheatsheet(keymap, rows, normalizeQuery(input.query));
}

export function fromShortcutsState(
  state: ShortcutsState,
  keymap: ShortcutKeymap,
  query?: string,
): ShortcutCheatsheetViewModel {
  const sheet = createShortcutCheatsheet({
    bindings: state.bindings,
    commands: state.commands,
    keymap,
  });

  return query === undefined ? sheet : sheet.setQuery(query);
}

// Exposed for tests + the renderer: pure glyph formatting per keymap.
export function formatChordGlyph(chord: unknown, keymap: ShortcutKeymap): string {
  const normalized = normalizeShortcutChord(chord);

  if (!normalized.ok) {
    return "";
  }

  return glyphForCanonicalChord(normalized.chord, normalizeKeymap(keymap));
}

class DesktopShortcutCheatsheet implements ShortcutCheatsheetViewModel {
  readonly #keymap: ShortcutKeymap;
  readonly #rows: readonly CheatsheetRow[];
  readonly #query: string;
  readonly #snapshot: ShortcutCheatsheetSnapshot;

  constructor(keymap: ShortcutKeymap, rows: readonly CheatsheetRow[], query: string) {
    this.#keymap = keymap;
    this.#rows = rows;
    this.#query = query;
    this.#snapshot = buildSnapshot(keymap, rows, query);
  }

  snapshot(): ShortcutCheatsheetSnapshot {
    return this.#snapshot;
  }

  setQuery(text: unknown): ShortcutCheatsheetViewModel {
    const next = normalizeQuery(text);

    if (next === this.#query) {
      return this;
    }

    return new DesktopShortcutCheatsheet(this.#keymap, this.#rows, next);
  }
}

interface FrozenCommand {
  readonly id: string;
  readonly title: string;
  readonly category: string;
}

function buildRows(
  commands: readonly FrozenCommand[],
  bindings: readonly ShortcutBinding[],
  keymap: ShortcutKeymap,
): readonly CheatsheetRow[] {
  const chordByCommand = chordsForCommands(bindings);
  const conflictChords = conflictChordSet(bindings);
  const output: CheatsheetRow[] = [];

  for (let index = 0; index < commands.length; index += 1) {
    const command = commands[index];

    if (command === undefined) {
      continue;
    }

    const chord = chordByCommand.get(command.id) ?? null;
    const unbound = chord === null;
    const conflict = chord !== null && conflictChords.has(chord);

    output.push(Object.freeze({
      category: command.category,
      chord,
      commandId: command.id,
      conflict,
      glyph: chord === null ? "" : glyphForCanonicalChord(chord, keymap),
      title: command.title,
      unbound,
    }));
  }

  return Object.freeze(output);
}

function chordsForCommands(bindings: readonly ShortcutBinding[]): ReadonlyMap<string, ShortcutChord> {
  const output = new Map<string, ShortcutChord>();

  if (!Array.isArray(bindings)) {
    return output;
  }

  for (let index = 0; index < bindings.length; index += 1) {
    const binding = bindings[index];

    if (binding === undefined || typeof binding.commandId !== "string") {
      continue;
    }

    const normalized = normalizeShortcutChord(binding.chord);

    if (!normalized.ok || output.has(binding.commandId)) {
      continue;
    }

    output.set(binding.commandId, normalized.chord);
  }

  return output;
}

function conflictChordSet(bindings: readonly ShortcutBinding[]): ReadonlySet<ShortcutChord> {
  const output = new Set<ShortcutChord>();

  if (!Array.isArray(bindings)) {
    return output;
  }

  const conflicts = detectShortcutConflicts(bindings);

  for (let index = 0; index < conflicts.length; index += 1) {
    const conflict = conflicts[index];

    if (conflict !== undefined) {
      output.add(conflict.chord);
    }
  }

  return output;
}

function buildSnapshot(
  keymap: ShortcutKeymap,
  rows: readonly CheatsheetRow[],
  query: string,
): ShortcutCheatsheetSnapshot {
  const filtered = filterRows(rows, query);
  const groups = groupRows(filtered);

  return Object.freeze({
    groups,
    keymap,
    query,
  });
}

function filterRows(rows: readonly CheatsheetRow[], query: string): readonly CheatsheetRow[] {
  if (query.length === 0) {
    return rows;
  }

  const needle = query.toLocaleLowerCase("en-US");
  const output: CheatsheetRow[] = [];

  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index];

    if (row === undefined) {
      continue;
    }

    const haystack = `${row.title}\n${row.glyph}`.toLocaleLowerCase("en-US");

    if (haystack.includes(needle)) {
      output.push(row);
    }
  }

  return Object.freeze(output);
}

function groupRows(rows: readonly CheatsheetRow[]): readonly CheatsheetGroup[] {
  const order: string[] = [];
  const byCategory = new Map<string, CheatsheetRow[]>();

  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index];

    if (row === undefined) {
      continue;
    }

    let grouped = byCategory.get(row.category);

    if (grouped === undefined) {
      grouped = [];
      byCategory.set(row.category, grouped);
      order.push(row.category);
    }

    grouped.push(row);
  }

  // Stable category ordering: alphabetical by category, deterministic regardless
  // of input row order.
  order.sort(compareStrings);

  const output: CheatsheetGroup[] = [];

  for (let index = 0; index < order.length; index += 1) {
    const category = order[index];

    if (category === undefined) {
      continue;
    }

    const grouped = byCategory.get(category);

    if (grouped === undefined) {
      continue;
    }

    output.push(Object.freeze({
      category,
      rows: Object.freeze(sortRows(grouped)),
    }));
  }

  return Object.freeze(output);
}

function sortRows(rows: readonly CheatsheetRow[]): CheatsheetRow[] {
  // Within-category ordering: by title, tie-broken by command id. Deterministic
  // and independent of insertion order.
  return [...rows].sort((left, right) => {
    const byTitle = compareStrings(left.title, right.title);

    if (byTitle !== 0) {
      return byTitle;
    }

    return compareStrings(left.commandId, right.commandId);
  });
}

function compareStrings(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

// ── glyph formatting ────────────────────────────────────────────────────────

const MAC_MODIFIER_GLYPHS = Object.freeze<Record<string, string>>({
  Alt: "⌥",
  Control: "⌃",
  Meta: "⌘",
  Shift: "⇧",
});

const PC_MODIFIER_LABELS = Object.freeze<Record<string, string>>({
  Alt: "Alt",
  Control: "Ctrl",
  Meta: "Super",
  Shift: "Shift",
});

const KEY_GLYPHS = Object.freeze<Record<string, string>>({
  ArrowDown: "↓",
  ArrowLeft: "←",
  ArrowRight: "→",
  ArrowUp: "↑",
  Backslash: "\\",
  Backspace: "⌫",
  BracketLeft: "[",
  BracketRight: "]",
  Comma: ",",
  Delete: "⌦",
  Enter: "↵",
  Equal: "=",
  Escape: "Esc",
  Minus: "-",
  Period: ".",
  Plus: "+",
  Quote: "'",
  Semicolon: ";",
  Slash: "/",
  Space: "Space",
  Tab: "⇥",
});

const MODIFIER_TOKENS = Object.freeze(["Control", "Alt", "Shift", "Meta"]);

// Format a canonical (already-normalized) chord into a display glyph for the
// keymap. mac uses symbol glyphs joined without a separator (`⌘,`); win/linux use
// labelled tokens joined with `+` (`Ctrl+,`).
function glyphForCanonicalChord(chord: ShortcutChord, keymap: ShortcutKeymap): string {
  const parts = chord.split("+");
  const modifiers: string[] = [];
  let key = "";

  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index];

    if (part === undefined || part.length === 0) {
      continue;
    }

    if (contains(MODIFIER_TOKENS, part)) {
      modifiers.push(part);
    } else {
      key = part;
    }
  }

  if (keymap === "mac") {
    let glyph = "";

    for (let index = 0; index < modifiers.length; index += 1) {
      const modifier = modifiers[index];

      if (modifier !== undefined) {
        glyph += MAC_MODIFIER_GLYPHS[modifier] ?? modifier;
      }
    }

    return `${glyph}${keyGlyph(key)}`;
  }

  const tokens: string[] = [];

  for (let index = 0; index < modifiers.length; index += 1) {
    const modifier = modifiers[index];

    if (modifier !== undefined) {
      tokens.push(PC_MODIFIER_LABELS[modifier] ?? modifier);
    }
  }

  if (key.length > 0) {
    tokens.push(keyGlyph(key));
  }

  return tokens.join("+");
}

function keyGlyph(key: string): string {
  if (key.length === 0) {
    return "";
  }

  return KEY_GLYPHS[key] ?? key;
}

function freezeCommands(
  commands: readonly ShortcutCommand[] | readonly CheatsheetCommandInput[],
): readonly FrozenCommand[] {
  const output: FrozenCommand[] = [];
  const seen = new Set<string>();

  if (!Array.isArray(commands)) {
    return Object.freeze(output);
  }

  for (let index = 0; index < commands.length; index += 1) {
    const command = commands[index] as CheatsheetCommandInput | undefined;

    if (
      command === undefined ||
      typeof command.id !== "string" ||
      command.id.length === 0 ||
      typeof command.title !== "string" ||
      command.title.length === 0 ||
      seen.has(command.id)
    ) {
      continue;
    }

    seen.add(command.id);
    output.push(Object.freeze({
      category: categoryFor(command.category),
      id: command.id,
      title: command.title,
    }));
  }

  return Object.freeze(output);
}

function categoryFor(category: unknown): string {
  if (typeof category === "string" && category.trim().length > 0) {
    return category.trim();
  }

  return UNCATEGORIZED;
}

function normalizeKeymap(keymap: unknown): ShortcutKeymap {
  if (keymap === "mac" || keymap === "win" || keymap === "linux") {
    return keymap;
  }

  // Fail-closed default: treat unknown keymaps as the PC layout (most users) so a
  // bad descriptor never leaks mac-only glyphs.
  return "win";
}

function normalizeQuery(query: unknown): string {
  if (typeof query !== "string") {
    return "";
  }

  return query.trim();
}

function contains(values: readonly string[], value: string): boolean {
  for (let index = 0; index < values.length; index += 1) {
    if (values[index] === value) {
      return true;
    }
  }

  return false;
}
