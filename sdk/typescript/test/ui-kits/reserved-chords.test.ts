import assert from "node:assert/strict";
import { test } from "node:test";

import {
  DEFAULT_RESERVED_CHORDS,
  RESERVED_CHORD_REASONS,
  defaultReservedChords,
  validateRebind,
} from "../../../../ui_kits/desktop/viewmodels/reserved-chords.ts";
import type {
  RebindValidationInput,
} from "../../../../ui_kits/desktop/viewmodels/reserved-chords.ts";
import {
  normalizeShortcutChord,
} from "../../../../ui_kits/desktop/viewmodels/shortcuts.ts";
import type {
  ShortcutBinding,
} from "../../../../ui_kits/desktop/viewmodels/shortcuts.ts";

test("default reserved set covers each safety category with a stable normalized reason", () => {
  const reserved = defaultReservedChords();
  const categories = new Set(reserved.map((entry) => entry.category));

  assert.equal(categories.has("security-attention"), true);
  assert.equal(categories.has("lock"), true);
  assert.equal(categories.has("force-quit"), true);
  assert.equal(categories.has("screenshot"), true);

  for (const entry of reserved) {
    assert.equal(entry.reason, RESERVED_CHORD_REASONS[entry.category]);
    assert.equal(Object.isFrozen(entry), true);
    // Stored chords are canonical (normalization-equivalent to themselves).
    const normalized = normalizeShortcutChord(entry.chord);
    assert.equal(normalized.ok, true);
    if (!normalized.ok) {
      assert.fail("expected reserved chord to be canonical");
    }
    assert.equal(normalized.chord, entry.chord);
  }

  assert.equal(Object.isFrozen(reserved), true);
  assert.equal(Object.isFrozen(DEFAULT_RESERVED_CHORDS), true);
});

test("rebind onto a clean chord is accepted and returns the canonical chord", () => {
  const result = validateRebind("command.palette", "ctrl + p", input([]));

  assert.equal(result.ok, true);
  if (!result.ok) {
    assert.fail("expected clean rebind to be accepted");
  }
  assert.equal(result.commandId, "command.palette");
  assert.equal(result.chord, "Control+P");
});

test("reserved chords are rejected fail-closed with the right category and reason", () => {
  const lock = validateRebind("command.palette", "Meta+L", input([]));

  assert.equal(lock.ok, false);
  if (lock.ok || !("reserved" in lock)) {
    assert.fail("expected lock chord to be reserved");
  }
  assert.equal(lock.reserved, true);
  assert.equal(lock.category, "lock");
  assert.equal(lock.reason, RESERVED_CHORD_REASONS.lock);
  assert.equal(lock.chord, "Meta+L");

  const sas = validateRebind("command.palette", "control+alt+delete", input([]));

  assert.equal(sas.ok, false);
  if (sas.ok || !("reserved" in sas)) {
    assert.fail("expected secure-attention chord to be reserved");
  }
  assert.equal(sas.category, "security-attention");
  assert.equal(sas.reason, RESERVED_CHORD_REASONS["security-attention"]);

  const shot = validateRebind("command.palette", "Meta+Shift+4", input([]));

  assert.equal(shot.ok, false);
  if (shot.ok || !("reserved" in shot)) {
    assert.fail("expected screenshot chord to be reserved");
  }
  assert.equal(shot.category, "screenshot");
});

test("reserved detection respects normalization-equivalence across alias spellings", () => {
  // `cmd+l` and `super+l` both normalize to the reserved `Meta+L`.
  for (const spelling of ["cmd+l", "super + l", "Meta+L"]) {
    const result = validateRebind("command.palette", spelling, input([]));

    assert.equal(result.ok, false);
    if (result.ok || !("reserved" in result)) {
      assert.fail(`expected ${spelling} to be reserved`);
    }
    assert.equal(result.category, "lock");
    assert.equal(result.chord, "Meta+L");
  }
});

test("a custom reserved set replaces the default and carries its own reason", () => {
  const custom: RebindValidationInput = {
    bindings: [],
    reserved: [
      { category: "lock", chord: "Ctrl+Alt+K", reason: "custom lock chord." },
    ],
  };

  // Default lock chord is no longer reserved when a custom set is supplied.
  const defaultLock = validateRebind("command.palette", "Meta+L", custom);
  assert.equal(defaultLock.ok, true);

  const customLock = validateRebind("command.palette", "ctrl+alt+k", custom);
  assert.equal(customLock.ok, false);
  if (customLock.ok || !("reserved" in customLock)) {
    assert.fail("expected custom reserved chord to be rejected");
  }
  assert.equal(customLock.reason, "custom lock chord.");
  assert.equal(customLock.chord, "Control+Alt+K");
});

test("a hard conflict reports the colliding command ids including the rebinding command", () => {
  const result = validateRebind("command.palette", "ctrl+k", input([
    binding("Control+K", "command.search", "user"),
  ]));

  assert.equal(result.ok, false);
  if (result.ok || !("conflict" in result)) {
    assert.fail("expected a hard conflict");
  }
  assert.equal(result.conflict, true);
  assert.deepEqual(result.commandIds, ["command.palette", "command.search"]);
  assert.equal(result.chord, "Control+K");
});

test("conflict detection respects normalization-equivalence and ignores self-binding", () => {
  // `cmd+,` normalizes to `Meta+Comma`, colliding with the existing binding.
  const collide = validateRebind("command.palette", "cmd+,", input([
    binding("Meta+Comma", "command.settings", "default"),
  ]));

  assert.equal(collide.ok, false);
  if (collide.ok || !("conflict" in collide)) {
    assert.fail("expected normalization-equivalent conflict");
  }
  assert.deepEqual(collide.commandIds, ["command.palette", "command.settings"]);

  // Rebinding a command onto its own existing chord is NOT a conflict.
  const self = validateRebind("command.settings", "Meta+Comma", input([
    binding("Meta+Comma", "command.settings", "default"),
  ]));

  assert.equal(self.ok, true);
});

test("app must-have collisions warn without blocking and are non-reserved/non-conflict", () => {
  const result = validateRebind("command.palette", "control+c", {
    bindings: [],
    mustHave: [
      { chord: "Ctrl+C", commandId: "editor.copy" },
    ],
  });

  assert.equal(result.ok, false);
  if (result.ok || !("shadowingWarning" in result)) {
    assert.fail("expected a non-blocking shadow warning");
  }
  assert.equal(result.shadowingWarning, true);
  assert.deepEqual(result.commandIds, ["editor.copy"]);
  assert.equal(result.chord, "Control+C");
});

test("reserved precedence beats conflict and shadow; conflict beats shadow", () => {
  const reservedWins = validateRebind("command.palette", "Meta+L", {
    bindings: [binding("Meta+L", "command.other", "user")],
    mustHave: [{ chord: "Meta+L", commandId: "app.lock" }],
  });

  assert.equal(reservedWins.ok, false);
  if (reservedWins.ok || !("reserved" in reservedWins)) {
    assert.fail("expected reserved to win over conflict/shadow");
  }

  const conflictWins = validateRebind("command.palette", "Ctrl+J", {
    bindings: [binding("Control+J", "command.other", "user")],
    mustHave: [{ chord: "Control+J", commandId: "app.join" }],
  });

  assert.equal(conflictWins.ok, false);
  if (conflictWins.ok || !("conflict" in conflictWins)) {
    assert.fail("expected conflict to win over shadow");
  }
  assert.deepEqual(conflictWins.commandIds, ["command.palette", "command.other"]);
});

test("malformed inputs fail closed without throwing", () => {
  const noCommand = validateRebind("", "Ctrl+P", input([]));
  assert.equal(noCommand.ok, false);
  if (noCommand.ok || !("error" in noCommand)) {
    assert.fail("expected empty command id to fail closed");
  }
  assert.equal(noCommand.error.code, "UNKNOWN_COMMAND");

  const badChord = validateRebind("command.palette", "Control+", input([]));
  assert.equal(badChord.ok, false);
  if (badChord.ok || !("error" in badChord)) {
    assert.fail("expected invalid chord to fail closed");
  }
  assert.equal(badChord.error.code, "INVALID_CHORD");

  // A malformed reserved entry is dropped, not crashed on.
  const tolerated = validateRebind("command.palette", "Ctrl+P", {
    bindings: [],
    reserved: [{ category: "lock", chord: "not a chord", reason: "x" }],
  });
  assert.equal(tolerated.ok, true);
});

function input(bindings: readonly ShortcutBinding[]): RebindValidationInput {
  return {
    bindings,
  };
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
