import assert from "node:assert/strict";
import { test } from "node:test";

import {
  createChordSequenceViewModel,
} from "../../../../ui_kits/desktop/viewmodels/chord-sequence.ts";
import type {
  ChordSequenceClock,
  ChordSequenceInput,
} from "../../../../ui_kits/desktop/viewmodels/chord-sequence.ts";

test("single-stroke sequence matches and resets the buffer", () => {
  const clock = manualClock(0);
  const vm = createChordSequenceViewModel(clock, {
    sequences: [{ chords: ["Ctrl+Shift+P"], commandId: "command.palette" }],
  });

  const result = vm.feed("control + shift + p");

  assert.equal(result.kind, "matched");
  if (result.kind !== "matched") {
    assert.fail("expected single stroke to match");
  }
  assert.equal(result.commandId, "command.palette");
  assert.deepEqual(result.prefix, ["Control+Shift+P"]);
  assert.equal(Object.isFrozen(result), true);
  // Buffer is reset after a match.
  assert.deepEqual(vm.snapshot().prefix, []);
});

test("two-stroke leader sequence matches on the second stroke", () => {
  const clock = manualClock(0);
  const vm = createChordSequenceViewModel(clock, {
    sequences: [{ chords: ["Ctrl+K", "Ctrl+S"], commandId: "files.saveAll" }],
  });

  // First stroke -> partial, single candidate.
  const first = vm.feed("Ctrl+K");

  assert.equal(first.kind, "partial");
  if (first.kind !== "partial") {
    assert.fail("expected first stroke to be partial");
  }
  assert.deepEqual(first.prefix, ["Control+K"]);
  assert.deepEqual(first.candidates.map((c) => [c.commandId, c.nextChord]), [
    ["files.saveAll", "Control+S"],
  ]);
  assert.deepEqual(vm.snapshot().prefix, ["Control+K"]);

  // Second stroke completes the sequence.
  const second = vm.feed("ctrl+s");

  assert.equal(second.kind, "matched");
  if (second.kind !== "matched") {
    assert.fail("expected second stroke to match");
  }
  assert.equal(second.commandId, "files.saveAll");
  assert.deepEqual(second.prefix, ["Control+K", "Control+S"]);
  assert.deepEqual(vm.snapshot().prefix, []);
});

test("ambiguous prefix yields a partial with multiple candidates", () => {
  const clock = manualClock(0);
  const vm = createChordSequenceViewModel(clock, {
    sequences: [
      { chords: ["Ctrl+K", "Ctrl+S"], commandId: "files.saveAll" },
      { chords: ["Ctrl+K", "Ctrl+W"], commandId: "files.closeAll" },
      { chords: ["Ctrl+K", "Ctrl+O"], commandId: "files.open" },
    ],
  });

  const result = vm.feed("Ctrl+K");

  assert.equal(result.kind, "partial");
  if (result.kind !== "partial") {
    assert.fail("expected ambiguous prefix to be partial");
  }
  assert.deepEqual(result.prefix, ["Control+K"]);
  assert.deepEqual(result.candidates.map((c) => [c.commandId, c.nextChord]), [
    ["files.saveAll", "Control+S"],
    ["files.closeAll", "Control+W"],
    ["files.open", "Control+O"],
  ]);
  // Disambiguate to one branch.
  const matched = vm.feed("Ctrl+W");

  assert.equal(matched.kind, "matched");
  if (matched.kind !== "matched") {
    assert.fail("expected disambiguation to match");
  }
  assert.equal(matched.commandId, "files.closeAll");
});

test("unknown prefix returns none and resets the buffer", () => {
  const clock = manualClock(0);
  const vm = createChordSequenceViewModel(clock, {
    sequences: [{ chords: ["Ctrl+K", "Ctrl+S"], commandId: "files.saveAll" }],
  });

  const result = vm.feed("Alt+Q");

  assert.equal(result.kind, "none");
  assert.deepEqual(vm.snapshot().prefix, []);

  // A bad second stroke after a valid leader also resets to none.
  const leader = vm.feed("Ctrl+K");

  assert.equal(leader.kind, "partial");
  const dead = vm.feed("Ctrl+Z");

  assert.equal(dead.kind, "none");
  assert.deepEqual(vm.snapshot().prefix, []);

  // After a none-reset the leader can start a fresh sequence again.
  assert.equal(vm.feed("Ctrl+K").kind, "partial");
});

test("injected clock past the inter-stroke window yields timeout-expired and resets", () => {
  const clock = manualClock(0);
  const vm = createChordSequenceViewModel(clock, {
    sequences: [{ chords: ["Ctrl+K", "Ctrl+S"], commandId: "files.saveAll" }],
    timeoutMs: 1000,
  });

  clock.set(0);
  const leader = vm.feed("Ctrl+K");

  assert.equal(leader.kind, "partial");
  assert.deepEqual(vm.snapshot().prefix, ["Control+K"]);

  // Advance the injected clock beyond the window before the second stroke.
  clock.set(1500);
  const expired = vm.feed("Ctrl+S");

  assert.equal(expired.kind, "timeout-expired");
  assert.deepEqual(vm.snapshot().prefix, []);

  // Within the window the same two strokes DO match (boundary is exclusive).
  clock.set(0);
  assert.equal(vm.feed("Ctrl+K").kind, "partial");
  clock.set(1000);
  const inWindow = vm.feed("Ctrl+S");

  assert.equal(inWindow.kind, "matched");
  if (inWindow.kind !== "matched") {
    assert.fail("expected in-window second stroke to match");
  }
  assert.equal(inWindow.commandId, "files.saveAll");
});

test("malformed stroke fails closed as invalid and resets the buffer", () => {
  const clock = manualClock(0);
  const vm = createChordSequenceViewModel(clock, {
    sequences: [{ chords: ["Ctrl+K", "Ctrl+S"], commandId: "files.saveAll" }],
  });

  vm.feed("Ctrl+K");
  assert.deepEqual(vm.snapshot().prefix, ["Control+K"]);

  const invalid = vm.feed("Control+");

  assert.equal(invalid.kind, "invalid");
  if (invalid.kind !== "invalid") {
    assert.fail("expected malformed stroke to be invalid");
  }
  assert.equal(invalid.error.code, "INVALID_CHORD");
  assert.deepEqual(vm.snapshot().prefix, []);
});

test("sequences with invalid chords are dropped at construction", () => {
  const clock = manualClock(0);
  const vm = createChordSequenceViewModel(clock, {
    sequences: [
      { chords: ["Ctrl+K", "Ctrl+S"], commandId: "files.saveAll" },
      { chords: ["Control+"], commandId: "bad.sequence" },
      { chords: [], commandId: "empty.sequence" },
    ] satisfies readonly ChordSequenceInput[],
  });

  assert.deepEqual(vm.sequences().map((sequence) => sequence.commandId), ["files.saveAll"]);
});

interface ManualClock extends ChordSequenceClock {
  set(value: number): void;
}

function manualClock(initial: number): ManualClock {
  let current = initial;

  return {
    now(): number {
      return current;
    },
    set(value: number): void {
      current = value;
    },
  };
}
