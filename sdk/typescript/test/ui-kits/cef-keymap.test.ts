import assert from "node:assert/strict";
import { test } from "node:test";

import {
  CEF_EVENT_FLAG,
  EVDEV_CEF_KEY_ENTRIES,
  applyEvdevKeyTransition,
  createCefKeyModifierState,
  lookupEvdevCefKeyEntry,
  mapEvdevToCefKeyEvent,
  updateCefKeyModifierState,
} from "../../src/ui-kits/cef-keymap.ts";
import type {
  CefKeyEvent,
  CefKeyModifierState,
  EvdevCefKeyEntry,
} from "../../src/ui-kits/cef-keymap.ts";

interface ExpectedEntry {
  readonly evdev_code: number;
  readonly windows_key_code: number;
  readonly key: string;
  readonly shifted_key: string;
  readonly code: string;
  readonly modifier_bit: number;
  readonly is_letter: boolean;
  readonly is_printable: boolean;
}

const expectedLetters: readonly ExpectedEntry[] = Object.freeze([
  expectedEntry(30, 0x41, "a", "A", "KeyA", true, true),
  expectedEntry(48, 0x42, "b", "B", "KeyB", true, true),
  expectedEntry(46, 0x43, "c", "C", "KeyC", true, true),
  expectedEntry(32, 0x44, "d", "D", "KeyD", true, true),
  expectedEntry(18, 0x45, "e", "E", "KeyE", true, true),
  expectedEntry(33, 0x46, "f", "F", "KeyF", true, true),
  expectedEntry(34, 0x47, "g", "G", "KeyG", true, true),
  expectedEntry(35, 0x48, "h", "H", "KeyH", true, true),
  expectedEntry(23, 0x49, "i", "I", "KeyI", true, true),
  expectedEntry(36, 0x4A, "j", "J", "KeyJ", true, true),
  expectedEntry(37, 0x4B, "k", "K", "KeyK", true, true),
  expectedEntry(38, 0x4C, "l", "L", "KeyL", true, true),
  expectedEntry(50, 0x4D, "m", "M", "KeyM", true, true),
  expectedEntry(49, 0x4E, "n", "N", "KeyN", true, true),
  expectedEntry(24, 0x4F, "o", "O", "KeyO", true, true),
  expectedEntry(25, 0x50, "p", "P", "KeyP", true, true),
  expectedEntry(16, 0x51, "q", "Q", "KeyQ", true, true),
  expectedEntry(19, 0x52, "r", "R", "KeyR", true, true),
  expectedEntry(31, 0x53, "s", "S", "KeyS", true, true),
  expectedEntry(20, 0x54, "t", "T", "KeyT", true, true),
  expectedEntry(22, 0x55, "u", "U", "KeyU", true, true),
  expectedEntry(47, 0x56, "v", "V", "KeyV", true, true),
  expectedEntry(17, 0x57, "w", "W", "KeyW", true, true),
  expectedEntry(45, 0x58, "x", "X", "KeyX", true, true),
  expectedEntry(21, 0x59, "y", "Y", "KeyY", true, true),
  expectedEntry(44, 0x5A, "z", "Z", "KeyZ", true, true),
]);

const expectedDigits: readonly ExpectedEntry[] = Object.freeze([
  expectedEntry(2, 0x31, "1", "!", "Digit1", false, true),
  expectedEntry(3, 0x32, "2", "@", "Digit2", false, true),
  expectedEntry(4, 0x33, "3", "#", "Digit3", false, true),
  expectedEntry(5, 0x34, "4", "$", "Digit4", false, true),
  expectedEntry(6, 0x35, "5", "%", "Digit5", false, true),
  expectedEntry(7, 0x36, "6", "^", "Digit6", false, true),
  expectedEntry(8, 0x37, "7", "&", "Digit7", false, true),
  expectedEntry(9, 0x38, "8", "*", "Digit8", false, true),
  expectedEntry(10, 0x39, "9", "(", "Digit9", false, true),
  expectedEntry(11, 0x30, "0", ")", "Digit0", false, true),
]);

const expectedControls: readonly ExpectedEntry[] = Object.freeze([
  expectedEntry(1, 0x1B, "Escape", "Escape", "Escape", false, false),
  expectedEntry(14, 0x08, "Backspace", "Backspace", "Backspace", false, false),
  expectedEntry(15, 0x09, "Tab", "Tab", "Tab", false, false),
  expectedEntry(28, 0x0D, "Enter", "Enter", "Enter", false, false),
  expectedEntry(57, 0x20, " ", " ", "Space", false, true),
  expectedEntry(103, 0x26, "ArrowUp", "ArrowUp", "ArrowUp", false, false),
  expectedEntry(108, 0x28, "ArrowDown", "ArrowDown", "ArrowDown", false, false),
  expectedEntry(105, 0x25, "ArrowLeft", "ArrowLeft", "ArrowLeft", false, false),
  expectedEntry(106, 0x27, "ArrowRight", "ArrowRight", "ArrowRight", false, false),
]);

const expectedModifiers: readonly ExpectedEntry[] = Object.freeze([
  expectedEntry(
    42,
    0xA0,
    "Shift",
    "Shift",
    "ShiftLeft",
    false,
    false,
    CEF_EVENT_FLAG.SHIFT_DOWN,
  ),
  expectedEntry(
    54,
    0xA1,
    "Shift",
    "Shift",
    "ShiftRight",
    false,
    false,
    CEF_EVENT_FLAG.SHIFT_DOWN,
  ),
  expectedEntry(
    29,
    0xA2,
    "Control",
    "Control",
    "ControlLeft",
    false,
    false,
    CEF_EVENT_FLAG.CONTROL_DOWN,
  ),
  expectedEntry(
    56,
    0xA4,
    "Alt",
    "Alt",
    "AltLeft",
    false,
    false,
    CEF_EVENT_FLAG.ALT_DOWN,
  ),
  expectedEntry(
    58,
    0x14,
    "CapsLock",
    "CapsLock",
    "CapsLock",
    false,
    false,
    CEF_EVENT_FLAG.CAPS_LOCK_ON,
  ),
]);

const allExpectedEntries = Object.freeze([
  ...expectedLetters,
  ...expectedDigits,
  ...expectedControls,
  ...expectedModifiers,
]);

test("evdev key matrix maps exact VK and DOM code entries", () => {
  assert.equal(EVDEV_CEF_KEY_ENTRIES.length, 50);
  assert.equal(allExpectedEntries.length, 50);

  for (const expected of allExpectedEntries) {
    const entry = lookupEvdevCefKeyEntry(expected.evdev_code);

    assert.notEqual(entry, null, `missing evdev ${expected.evdev_code}`);
    assertEntry(entry, expected);

    const event = mapEvdevToCefKeyEvent(expected.evdev_code);
    assert.notEqual(event, null, `missing event for evdev ${expected.evdev_code}`);
    assertEvent(event, {
      code: expected.code,
      key: expected.key,
      modifiers: CEF_EVENT_FLAG.NONE,
      windows_key_code: expected.windows_key_code,
    });
  }
});

test("printable DOM key composition follows US shift and caps rules", () => {
  const empty = createCefKeyModifierState();
  const shifted = updateCefKeyModifierState(empty, 42, "keydown");
  const caps = updateCefKeyModifierState(empty, 58, "keydown");
  const shiftedCaps = updateCefKeyModifierState(caps, 42, "keydown");

  assertEvent(mapKnown(30, empty), {
    code: "KeyA",
    key: "a",
    modifiers: CEF_EVENT_FLAG.NONE,
    windows_key_code: 0x41,
  });
  assertEvent(mapKnown(30, shifted), {
    code: "KeyA",
    key: "A",
    modifiers: CEF_EVENT_FLAG.SHIFT_DOWN,
    windows_key_code: 0x41,
  });
  assertEvent(mapKnown(30, caps), {
    code: "KeyA",
    key: "A",
    modifiers: CEF_EVENT_FLAG.CAPS_LOCK_ON,
    windows_key_code: 0x41,
  });
  assertEvent(mapKnown(30, shiftedCaps), {
    code: "KeyA",
    key: "a",
    modifiers: CEF_EVENT_FLAG.CAPS_LOCK_ON | CEF_EVENT_FLAG.SHIFT_DOWN,
    windows_key_code: 0x41,
  });
  assertEvent(mapKnown(2, shifted), {
    code: "Digit1",
    key: "!",
    modifiers: CEF_EVENT_FLAG.SHIFT_DOWN,
    windows_key_code: 0x31,
  });
  assertEvent(mapKnown(2, caps), {
    code: "Digit1",
    key: "1",
    modifiers: CEF_EVENT_FLAG.CAPS_LOCK_ON,
    windows_key_code: 0x31,
  });
});

test("modifier transitions compose bitmask and keep side-specific shift state", () => {
  const empty = createCefKeyModifierState();
  const leftShift = applyKnown(empty, 42, "keydown");
  assert.equal(leftShift.state.modifiers, CEF_EVENT_FLAG.SHIFT_DOWN);
  assertEvent(leftShift.event, {
    code: "ShiftLeft",
    key: "Shift",
    modifiers: CEF_EVENT_FLAG.SHIFT_DOWN,
    windows_key_code: 0xA0,
  });

  const bothShift = applyKnown(leftShift.state, 54, "keydown");
  assert.equal(bothShift.state.modifiers, CEF_EVENT_FLAG.SHIFT_DOWN);

  const rightShiftStillDown = applyKnown(bothShift.state, 42, "keyup");
  assert.deepEqual(projectState(rightShiftStillDown.state), {
    caps_lock_on: false,
    left_alt_down: false,
    left_ctrl_down: false,
    left_shift_down: false,
    modifiers: CEF_EVENT_FLAG.SHIFT_DOWN,
    right_shift_down: true,
  });

  const noShift = applyKnown(rightShiftStillDown.state, 54, "keyup");
  assert.equal(noShift.state.modifiers, CEF_EVENT_FLAG.NONE);

  const ctrl = applyKnown(noShift.state, 29, "keydown");
  const ctrlAlt = applyKnown(ctrl.state, 56, "keydown");
  assert.equal(
    ctrlAlt.state.modifiers,
    CEF_EVENT_FLAG.CONTROL_DOWN | CEF_EVENT_FLAG.ALT_DOWN,
  );

  const onlyAlt = applyKnown(ctrlAlt.state, 29, "keyup");
  assert.equal(onlyAlt.state.modifiers, CEF_EVENT_FLAG.ALT_DOWN);

  const noModifiers = applyKnown(onlyAlt.state, 56, "keyup");
  assert.equal(noModifiers.state.modifiers, CEF_EVENT_FLAG.NONE);
});

test("caps lock toggles on keydown and keyup leaves the toggle untouched", () => {
  const empty = createCefKeyModifierState();
  const capsOn = applyKnown(empty, 58, "keydown");
  assert.equal(capsOn.state.modifiers, CEF_EVENT_FLAG.CAPS_LOCK_ON);

  const capsStillOn = applyKnown(capsOn.state, 58, "keyup");
  assert.equal(capsStillOn.state.modifiers, CEF_EVENT_FLAG.CAPS_LOCK_ON);

  const capsOff = applyKnown(capsStillOn.state, 58, "keydown");
  assert.equal(capsOff.state.modifiers, CEF_EVENT_FLAG.NONE);
});

test("unknown and out-of-range evdev codes are dropped fail-closed", () => {
  const empty = createCefKeyModifierState();
  const shifted = updateCefKeyModifierState(empty, 42, "keydown");

  assert.equal(lookupEvdevCefKeyEntry(-1), null);
  assert.equal(lookupEvdevCefKeyEntry(0), null);
  assert.equal(lookupEvdevCefKeyEntry(9999), null);
  assert.equal(lookupEvdevCefKeyEntry(30.5), null);
  assert.equal(mapEvdevToCefKeyEvent(9999, shifted), null);

  const ignored = applyEvdevKeyTransition(shifted, 9999, "keydown");
  assert.equal(ignored.event, null);
  assert.equal(ignored.state, shifted);
});

test("same evdev code and modifier state produce byte-identical events", () => {
  const shifted = updateCefKeyModifierState(createCefKeyModifierState(), 42, "keydown");

  const first = mapKnown(2, shifted);
  const second = mapKnown(2, shifted);

  assert.deepEqual(first, second);
  assert.equal(JSON.stringify(first), JSON.stringify(second));
});

function expectedEntry(
  evdev_code: number,
  windows_key_code: number,
  key: string,
  shifted_key: string,
  code: string,
  is_letter: boolean,
  is_printable: boolean,
  modifier_bit: number = CEF_EVENT_FLAG.NONE,
): ExpectedEntry {
  return Object.freeze({
    code,
    evdev_code,
    is_letter,
    is_printable,
    key,
    modifier_bit,
    shifted_key,
    windows_key_code,
  });
}

function assertEntry(entry: EvdevCefKeyEntry | null, expected: ExpectedEntry): void {
  assert.notEqual(entry, null);
  assert.deepEqual(entry, expected);
}

function assertEvent(actual: CefKeyEvent | null, expected: CefKeyEvent): void {
  assert.notEqual(actual, null);
  assert.deepEqual(actual, expected);
}

function mapKnown(evdevCode: number, state: CefKeyModifierState): CefKeyEvent {
  const event = mapEvdevToCefKeyEvent(evdevCode, state);
  if (event === null) {
    assert.fail(`expected evdev ${evdevCode} to map`);
  }
  return event;
}

function applyKnown(
  state: CefKeyModifierState,
  evdevCode: number,
  transition: "keydown" | "keyup",
): { readonly state: CefKeyModifierState; readonly event: CefKeyEvent } {
  const result = applyEvdevKeyTransition(state, evdevCode, transition);
  if (result.event === null) {
    assert.fail(`expected evdev ${evdevCode} transition to emit an event`);
  }
  return {
    event: result.event,
    state: result.state,
  };
}

function projectState(state: CefKeyModifierState): CefKeyModifierState {
  return {
    caps_lock_on: state.caps_lock_on,
    left_alt_down: state.left_alt_down,
    left_ctrl_down: state.left_ctrl_down,
    left_shift_down: state.left_shift_down,
    modifiers: state.modifiers,
    right_shift_down: state.right_shift_down,
  };
}
