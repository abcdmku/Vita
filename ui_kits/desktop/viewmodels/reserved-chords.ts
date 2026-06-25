import {
  normalizeShortcutChord,
} from "./shortcuts.ts";
import type {
  ShortcutBinding,
  ShortcutChord,
} from "./shortcuts.ts";

// Reserved-chord guard / rebind-validation policy for the flagship desktop.
//
// Pure, headless, deterministic, fail-closed: validateRebind never reads ambient
// I/O, never mutates the bindings it is given, and rejects on any doubt. Every
// comparison (reserved / conflict / shadow) is keyed on the canonical chord from
// `normalizeShortcutChord` so that normalization-equivalent inputs (e.g. `Cmd+,`
// and `Meta+Comma`, or `super+q` and `Meta+Q`) are treated identically.

export type ReservedChordCategory =
  | "security-attention"
  | "lock"
  | "force-quit"
  | "screenshot";

export interface ReservedChord {
  readonly chord: ShortcutChord;
  readonly category: ReservedChordCategory;
  readonly reason: string;
}

export interface ReservedChordInput {
  readonly chord: string;
  readonly category: ReservedChordCategory;
  readonly reason: string;
}

export interface MustHaveChordInput {
  readonly chord: string;
  readonly commandId: string;
}

export interface MustHaveChord {
  readonly chord: ShortcutChord;
  readonly commandId: string;
}

export interface RebindValidationInput {
  readonly bindings: readonly ShortcutBinding[];
  readonly reserved?: readonly ReservedChordInput[];
  readonly mustHave?: readonly MustHaveChordInput[];
}

export type RebindValidationResult =
  | {
      readonly ok: true;
      readonly commandId: string;
      readonly chord: ShortcutChord;
    }
  | {
      readonly ok: false;
      readonly reserved: true;
      readonly category: ReservedChordCategory;
      readonly reason: string;
      readonly chord: ShortcutChord;
    }
  | {
      readonly ok: false;
      readonly conflict: true;
      readonly commandIds: readonly string[];
      readonly chord: ShortcutChord;
    }
  | {
      readonly ok: false;
      readonly shadowingWarning: true;
      readonly commandIds: readonly string[];
      readonly chord: ShortcutChord;
    }
  | {
      readonly ok: false;
      readonly error: ReservedChordError;
    };

export interface ReservedChordError {
  readonly code: string;
  readonly message: string;
  readonly path: string;
}

// Default OS-reserved safety chords. Stable per-category `reason` strings.
// Stored as raw chord strings and normalized on read so the guard's source of
// record stays human-readable while comparisons remain canonical.
export const RESERVED_CHORD_REASONS = Object.freeze({
  "force-quit": "chord is reserved for force-quitting an unresponsive app.",
  lock: "chord is reserved for locking the session.",
  screenshot: "chord is reserved for capturing a screenshot.",
  "security-attention": "chord is reserved for the secure attention sequence.",
} satisfies Record<ReservedChordCategory, string>);

export const DEFAULT_RESERVED_CHORDS = Object.freeze([
  reservedInput("Control+Alt+Delete", "security-attention"),
  reservedInput("Meta+L", "lock"),
  reservedInput("Control+Alt+L", "lock"),
  reservedInput("Meta+Alt+Escape", "force-quit"),
  reservedInput("Meta+Shift+3", "screenshot"),
  reservedInput("Meta+Shift+4", "screenshot"),
] satisfies readonly ReservedChordInput[]);

export function defaultReservedChords(): readonly ReservedChord[] {
  return normalizeReserved(DEFAULT_RESERVED_CHORDS);
}

export function validateRebind(
  commandId: unknown,
  chord: unknown,
  input: RebindValidationInput,
): RebindValidationResult {
  if (typeof commandId !== "string" || commandId.length === 0) {
    return rejectError(error("UNKNOWN_COMMAND", "rebind requires a command id.", "/commandId"));
  }

  const normalized = normalizeShortcutChord(chord);

  if (!normalized.ok) {
    return rejectError(error(normalized.error.code, normalized.error.message, "/chord"));
  }

  const target = normalized.chord;
  const reserved = normalizeReserved(input.reserved ?? DEFAULT_RESERVED_CHORDS);
  const mustHave = normalizeMustHave(input.mustHave ?? Object.freeze([]));
  const bindings = normalizeBindings(input.bindings);

  // 1. Reserved chords are rejected first — fail-closed against OS safety chords.
  const reservedMatch = firstReservedMatch(reserved, target);

  if (reservedMatch !== null) {
    return Object.freeze({
      category: reservedMatch.category,
      chord: target,
      ok: false,
      reason: reservedMatch.reason,
      reserved: true,
    });
  }

  // 2. Hard conflict: the chord already binds a DIFFERENT command.
  const collidingCommandIds = bindingCommandIdsForChord(bindings, target, commandId);

  if (collidingCommandIds.length > 0) {
    return Object.freeze({
      chord: target,
      commandIds: Object.freeze([commandId, ...collidingCommandIds]),
      conflict: true,
      ok: false,
    });
  }

  // 3. Non-blocking shadow warning: collides with an app must-have chord.
  const shadowedCommandIds = mustHaveCommandIdsForChord(mustHave, target, commandId);

  if (shadowedCommandIds.length > 0) {
    return Object.freeze({
      chord: target,
      commandIds: Object.freeze(shadowedCommandIds),
      ok: false,
      shadowingWarning: true,
    });
  }

  return Object.freeze({
    chord: target,
    commandId,
    ok: true,
  });
}

function firstReservedMatch(reserved: readonly ReservedChord[], chord: ShortcutChord): ReservedChord | null {
  for (let index = 0; index < reserved.length; index += 1) {
    const entry = reserved[index];

    if (entry !== undefined && entry.chord === chord) {
      return entry;
    }
  }

  return null;
}

function bindingCommandIdsForChord(
  bindings: readonly MustHaveChord[],
  chord: ShortcutChord,
  commandId: string,
): readonly string[] {
  const output: string[] = [];

  for (let index = 0; index < bindings.length; index += 1) {
    const binding = bindings[index];

    if (binding === undefined || binding.chord !== chord || binding.commandId === commandId) {
      continue;
    }

    if (!contains(output, binding.commandId)) {
      output.push(binding.commandId);
    }
  }

  return Object.freeze(output);
}

function mustHaveCommandIdsForChord(
  mustHave: readonly MustHaveChord[],
  chord: ShortcutChord,
  commandId: string,
): readonly string[] {
  const output: string[] = [];

  for (let index = 0; index < mustHave.length; index += 1) {
    const entry = mustHave[index];

    if (entry === undefined || entry.chord !== chord || entry.commandId === commandId) {
      continue;
    }

    if (!contains(output, entry.commandId)) {
      output.push(entry.commandId);
    }
  }

  return Object.freeze(output);
}

function normalizeReserved(input: readonly ReservedChordInput[]): readonly ReservedChord[] {
  const output: ReservedChord[] = [];

  for (let index = 0; index < input.length; index += 1) {
    const entry = input[index];

    if (
      entry === undefined ||
      typeof entry.category !== "string" ||
      typeof entry.reason !== "string"
    ) {
      continue;
    }

    const normalized = normalizeShortcutChord(entry.chord);

    if (!normalized.ok) {
      continue;
    }

    output.push(Object.freeze({
      category: entry.category,
      chord: normalized.chord,
      reason: entry.reason,
    }));
  }

  return Object.freeze(output);
}

function normalizeMustHave(input: readonly MustHaveChordInput[]): readonly MustHaveChord[] {
  const output: MustHaveChord[] = [];

  for (let index = 0; index < input.length; index += 1) {
    const entry = input[index];

    if (entry === undefined || typeof entry.commandId !== "string" || entry.commandId.length === 0) {
      continue;
    }

    const normalized = normalizeShortcutChord(entry.chord);

    if (!normalized.ok) {
      continue;
    }

    output.push(Object.freeze({
      chord: normalized.chord,
      commandId: entry.commandId,
    }));
  }

  return Object.freeze(output);
}

function normalizeBindings(input: readonly ShortcutBinding[]): readonly MustHaveChord[] {
  const output: MustHaveChord[] = [];

  if (!Array.isArray(input)) {
    return Object.freeze(output);
  }

  for (let index = 0; index < input.length; index += 1) {
    const binding = input[index];

    if (binding === undefined || typeof binding.commandId !== "string" || binding.commandId.length === 0) {
      continue;
    }

    const normalized = normalizeShortcutChord(binding.chord);

    if (!normalized.ok) {
      continue;
    }

    output.push(Object.freeze({
      chord: normalized.chord,
      commandId: binding.commandId,
    }));
  }

  return Object.freeze(output);
}

function reservedInput(chord: string, category: ReservedChordCategory): ReservedChordInput {
  return Object.freeze({
    category,
    chord,
    reason: RESERVED_CHORD_REASONS[category],
  });
}

function contains(values: readonly string[], value: string): boolean {
  for (let index = 0; index < values.length; index += 1) {
    if (values[index] === value) {
      return true;
    }
  }

  return false;
}

function rejectError(errorValue: ReservedChordError): RebindValidationResult {
  return Object.freeze({
    error: errorValue,
    ok: false,
  });
}

function error(code: string, message: string, path: string): ReservedChordError {
  return Object.freeze({
    code,
    message,
    path,
  });
}
