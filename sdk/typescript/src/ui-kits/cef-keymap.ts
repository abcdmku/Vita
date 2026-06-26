// TypeScript mirror of spikes/cef-osr/input/evdev_keymap.h.
// Keep the table entries and CEF event flag values in lockstep with that header.

export const CEF_EVENT_FLAG = Object.freeze({
  NONE: 0,
  CAPS_LOCK_ON: 1 << 0,
  SHIFT_DOWN: 1 << 1,
  CONTROL_DOWN: 1 << 2,
  ALT_DOWN: 1 << 3,
});

export type CefKeyTransition = "keydown" | "keyup";

export interface EvdevCefKeyEntry {
  readonly evdev_code: number;
  readonly windows_key_code: number;
  readonly key: string;
  readonly shifted_key: string;
  readonly code: string;
  readonly modifier_bit: number;
  readonly is_letter: boolean;
  readonly is_printable: boolean;
}

export interface CefKeyModifierState {
  readonly left_shift_down: boolean;
  readonly right_shift_down: boolean;
  readonly left_ctrl_down: boolean;
  readonly left_alt_down: boolean;
  readonly caps_lock_on: boolean;
  readonly modifiers: number;
}

export interface CefKeyEvent {
  readonly windows_key_code: number;
  readonly key: string;
  readonly code: string;
  readonly modifiers: number;
}

export interface CefKeyTransitionResult {
  readonly state: CefKeyModifierState;
  readonly event: CefKeyEvent | null;
}

function freezeEntry(entry: EvdevCefKeyEntry): EvdevCefKeyEntry {
  return Object.freeze(entry);
}

export const EVDEV_CEF_KEY_ENTRIES: readonly EvdevCefKeyEntry[] = Object.freeze([
  freezeEntry({
    code: "Escape",
    evdev_code: 1,
    is_letter: false,
    is_printable: false,
    key: "Escape",
    modifier_bit: CEF_EVENT_FLAG.NONE,
    shifted_key: "Escape",
    windows_key_code: 0x1B,
  }),
  freezeEntry({
    code: "Digit1",
    evdev_code: 2,
    is_letter: false,
    is_printable: true,
    key: "1",
    modifier_bit: CEF_EVENT_FLAG.NONE,
    shifted_key: "!",
    windows_key_code: 0x31,
  }),
  freezeEntry({
    code: "Digit2",
    evdev_code: 3,
    is_letter: false,
    is_printable: true,
    key: "2",
    modifier_bit: CEF_EVENT_FLAG.NONE,
    shifted_key: "@",
    windows_key_code: 0x32,
  }),
  freezeEntry({
    code: "Digit3",
    evdev_code: 4,
    is_letter: false,
    is_printable: true,
    key: "3",
    modifier_bit: CEF_EVENT_FLAG.NONE,
    shifted_key: "#",
    windows_key_code: 0x33,
  }),
  freezeEntry({
    code: "Digit4",
    evdev_code: 5,
    is_letter: false,
    is_printable: true,
    key: "4",
    modifier_bit: CEF_EVENT_FLAG.NONE,
    shifted_key: "$",
    windows_key_code: 0x34,
  }),
  freezeEntry({
    code: "Digit5",
    evdev_code: 6,
    is_letter: false,
    is_printable: true,
    key: "5",
    modifier_bit: CEF_EVENT_FLAG.NONE,
    shifted_key: "%",
    windows_key_code: 0x35,
  }),
  freezeEntry({
    code: "Digit6",
    evdev_code: 7,
    is_letter: false,
    is_printable: true,
    key: "6",
    modifier_bit: CEF_EVENT_FLAG.NONE,
    shifted_key: "^",
    windows_key_code: 0x36,
  }),
  freezeEntry({
    code: "Digit7",
    evdev_code: 8,
    is_letter: false,
    is_printable: true,
    key: "7",
    modifier_bit: CEF_EVENT_FLAG.NONE,
    shifted_key: "&",
    windows_key_code: 0x37,
  }),
  freezeEntry({
    code: "Digit8",
    evdev_code: 9,
    is_letter: false,
    is_printable: true,
    key: "8",
    modifier_bit: CEF_EVENT_FLAG.NONE,
    shifted_key: "*",
    windows_key_code: 0x38,
  }),
  freezeEntry({
    code: "Digit9",
    evdev_code: 10,
    is_letter: false,
    is_printable: true,
    key: "9",
    modifier_bit: CEF_EVENT_FLAG.NONE,
    shifted_key: "(",
    windows_key_code: 0x39,
  }),
  freezeEntry({
    code: "Digit0",
    evdev_code: 11,
    is_letter: false,
    is_printable: true,
    key: "0",
    modifier_bit: CEF_EVENT_FLAG.NONE,
    shifted_key: ")",
    windows_key_code: 0x30,
  }),
  freezeEntry({
    code: "Backspace",
    evdev_code: 14,
    is_letter: false,
    is_printable: false,
    key: "Backspace",
    modifier_bit: CEF_EVENT_FLAG.NONE,
    shifted_key: "Backspace",
    windows_key_code: 0x08,
  }),
  freezeEntry({
    code: "Tab",
    evdev_code: 15,
    is_letter: false,
    is_printable: false,
    key: "Tab",
    modifier_bit: CEF_EVENT_FLAG.NONE,
    shifted_key: "Tab",
    windows_key_code: 0x09,
  }),
  freezeEntry({
    code: "KeyQ",
    evdev_code: 16,
    is_letter: true,
    is_printable: true,
    key: "q",
    modifier_bit: CEF_EVENT_FLAG.NONE,
    shifted_key: "Q",
    windows_key_code: 0x51,
  }),
  freezeEntry({
    code: "KeyW",
    evdev_code: 17,
    is_letter: true,
    is_printable: true,
    key: "w",
    modifier_bit: CEF_EVENT_FLAG.NONE,
    shifted_key: "W",
    windows_key_code: 0x57,
  }),
  freezeEntry({
    code: "KeyE",
    evdev_code: 18,
    is_letter: true,
    is_printable: true,
    key: "e",
    modifier_bit: CEF_EVENT_FLAG.NONE,
    shifted_key: "E",
    windows_key_code: 0x45,
  }),
  freezeEntry({
    code: "KeyR",
    evdev_code: 19,
    is_letter: true,
    is_printable: true,
    key: "r",
    modifier_bit: CEF_EVENT_FLAG.NONE,
    shifted_key: "R",
    windows_key_code: 0x52,
  }),
  freezeEntry({
    code: "KeyT",
    evdev_code: 20,
    is_letter: true,
    is_printable: true,
    key: "t",
    modifier_bit: CEF_EVENT_FLAG.NONE,
    shifted_key: "T",
    windows_key_code: 0x54,
  }),
  freezeEntry({
    code: "KeyY",
    evdev_code: 21,
    is_letter: true,
    is_printable: true,
    key: "y",
    modifier_bit: CEF_EVENT_FLAG.NONE,
    shifted_key: "Y",
    windows_key_code: 0x59,
  }),
  freezeEntry({
    code: "KeyU",
    evdev_code: 22,
    is_letter: true,
    is_printable: true,
    key: "u",
    modifier_bit: CEF_EVENT_FLAG.NONE,
    shifted_key: "U",
    windows_key_code: 0x55,
  }),
  freezeEntry({
    code: "KeyI",
    evdev_code: 23,
    is_letter: true,
    is_printable: true,
    key: "i",
    modifier_bit: CEF_EVENT_FLAG.NONE,
    shifted_key: "I",
    windows_key_code: 0x49,
  }),
  freezeEntry({
    code: "KeyO",
    evdev_code: 24,
    is_letter: true,
    is_printable: true,
    key: "o",
    modifier_bit: CEF_EVENT_FLAG.NONE,
    shifted_key: "O",
    windows_key_code: 0x4F,
  }),
  freezeEntry({
    code: "KeyP",
    evdev_code: 25,
    is_letter: true,
    is_printable: true,
    key: "p",
    modifier_bit: CEF_EVENT_FLAG.NONE,
    shifted_key: "P",
    windows_key_code: 0x50,
  }),
  freezeEntry({
    code: "Enter",
    evdev_code: 28,
    is_letter: false,
    is_printable: false,
    key: "Enter",
    modifier_bit: CEF_EVENT_FLAG.NONE,
    shifted_key: "Enter",
    windows_key_code: 0x0D,
  }),
  freezeEntry({
    code: "ControlLeft",
    evdev_code: 29,
    is_letter: false,
    is_printable: false,
    key: "Control",
    modifier_bit: CEF_EVENT_FLAG.CONTROL_DOWN,
    shifted_key: "Control",
    windows_key_code: 0xA2,
  }),
  freezeEntry({
    code: "KeyA",
    evdev_code: 30,
    is_letter: true,
    is_printable: true,
    key: "a",
    modifier_bit: CEF_EVENT_FLAG.NONE,
    shifted_key: "A",
    windows_key_code: 0x41,
  }),
  freezeEntry({
    code: "KeyS",
    evdev_code: 31,
    is_letter: true,
    is_printable: true,
    key: "s",
    modifier_bit: CEF_EVENT_FLAG.NONE,
    shifted_key: "S",
    windows_key_code: 0x53,
  }),
  freezeEntry({
    code: "KeyD",
    evdev_code: 32,
    is_letter: true,
    is_printable: true,
    key: "d",
    modifier_bit: CEF_EVENT_FLAG.NONE,
    shifted_key: "D",
    windows_key_code: 0x44,
  }),
  freezeEntry({
    code: "KeyF",
    evdev_code: 33,
    is_letter: true,
    is_printable: true,
    key: "f",
    modifier_bit: CEF_EVENT_FLAG.NONE,
    shifted_key: "F",
    windows_key_code: 0x46,
  }),
  freezeEntry({
    code: "KeyG",
    evdev_code: 34,
    is_letter: true,
    is_printable: true,
    key: "g",
    modifier_bit: CEF_EVENT_FLAG.NONE,
    shifted_key: "G",
    windows_key_code: 0x47,
  }),
  freezeEntry({
    code: "KeyH",
    evdev_code: 35,
    is_letter: true,
    is_printable: true,
    key: "h",
    modifier_bit: CEF_EVENT_FLAG.NONE,
    shifted_key: "H",
    windows_key_code: 0x48,
  }),
  freezeEntry({
    code: "KeyJ",
    evdev_code: 36,
    is_letter: true,
    is_printable: true,
    key: "j",
    modifier_bit: CEF_EVENT_FLAG.NONE,
    shifted_key: "J",
    windows_key_code: 0x4A,
  }),
  freezeEntry({
    code: "KeyK",
    evdev_code: 37,
    is_letter: true,
    is_printable: true,
    key: "k",
    modifier_bit: CEF_EVENT_FLAG.NONE,
    shifted_key: "K",
    windows_key_code: 0x4B,
  }),
  freezeEntry({
    code: "KeyL",
    evdev_code: 38,
    is_letter: true,
    is_printable: true,
    key: "l",
    modifier_bit: CEF_EVENT_FLAG.NONE,
    shifted_key: "L",
    windows_key_code: 0x4C,
  }),
  freezeEntry({
    code: "ShiftLeft",
    evdev_code: 42,
    is_letter: false,
    is_printable: false,
    key: "Shift",
    modifier_bit: CEF_EVENT_FLAG.SHIFT_DOWN,
    shifted_key: "Shift",
    windows_key_code: 0xA0,
  }),
  freezeEntry({
    code: "KeyZ",
    evdev_code: 44,
    is_letter: true,
    is_printable: true,
    key: "z",
    modifier_bit: CEF_EVENT_FLAG.NONE,
    shifted_key: "Z",
    windows_key_code: 0x5A,
  }),
  freezeEntry({
    code: "KeyX",
    evdev_code: 45,
    is_letter: true,
    is_printable: true,
    key: "x",
    modifier_bit: CEF_EVENT_FLAG.NONE,
    shifted_key: "X",
    windows_key_code: 0x58,
  }),
  freezeEntry({
    code: "KeyC",
    evdev_code: 46,
    is_letter: true,
    is_printable: true,
    key: "c",
    modifier_bit: CEF_EVENT_FLAG.NONE,
    shifted_key: "C",
    windows_key_code: 0x43,
  }),
  freezeEntry({
    code: "KeyV",
    evdev_code: 47,
    is_letter: true,
    is_printable: true,
    key: "v",
    modifier_bit: CEF_EVENT_FLAG.NONE,
    shifted_key: "V",
    windows_key_code: 0x56,
  }),
  freezeEntry({
    code: "KeyB",
    evdev_code: 48,
    is_letter: true,
    is_printable: true,
    key: "b",
    modifier_bit: CEF_EVENT_FLAG.NONE,
    shifted_key: "B",
    windows_key_code: 0x42,
  }),
  freezeEntry({
    code: "KeyN",
    evdev_code: 49,
    is_letter: true,
    is_printable: true,
    key: "n",
    modifier_bit: CEF_EVENT_FLAG.NONE,
    shifted_key: "N",
    windows_key_code: 0x4E,
  }),
  freezeEntry({
    code: "KeyM",
    evdev_code: 50,
    is_letter: true,
    is_printable: true,
    key: "m",
    modifier_bit: CEF_EVENT_FLAG.NONE,
    shifted_key: "M",
    windows_key_code: 0x4D,
  }),
  freezeEntry({
    code: "ShiftRight",
    evdev_code: 54,
    is_letter: false,
    is_printable: false,
    key: "Shift",
    modifier_bit: CEF_EVENT_FLAG.SHIFT_DOWN,
    shifted_key: "Shift",
    windows_key_code: 0xA1,
  }),
  freezeEntry({
    code: "AltLeft",
    evdev_code: 56,
    is_letter: false,
    is_printable: false,
    key: "Alt",
    modifier_bit: CEF_EVENT_FLAG.ALT_DOWN,
    shifted_key: "Alt",
    windows_key_code: 0xA4,
  }),
  freezeEntry({
    code: "Space",
    evdev_code: 57,
    is_letter: false,
    is_printable: true,
    key: " ",
    modifier_bit: CEF_EVENT_FLAG.NONE,
    shifted_key: " ",
    windows_key_code: 0x20,
  }),
  freezeEntry({
    code: "CapsLock",
    evdev_code: 58,
    is_letter: false,
    is_printable: false,
    key: "CapsLock",
    modifier_bit: CEF_EVENT_FLAG.CAPS_LOCK_ON,
    shifted_key: "CapsLock",
    windows_key_code: 0x14,
  }),
  freezeEntry({
    code: "ArrowUp",
    evdev_code: 103,
    is_letter: false,
    is_printable: false,
    key: "ArrowUp",
    modifier_bit: CEF_EVENT_FLAG.NONE,
    shifted_key: "ArrowUp",
    windows_key_code: 0x26,
  }),
  freezeEntry({
    code: "ArrowLeft",
    evdev_code: 105,
    is_letter: false,
    is_printable: false,
    key: "ArrowLeft",
    modifier_bit: CEF_EVENT_FLAG.NONE,
    shifted_key: "ArrowLeft",
    windows_key_code: 0x25,
  }),
  freezeEntry({
    code: "ArrowRight",
    evdev_code: 106,
    is_letter: false,
    is_printable: false,
    key: "ArrowRight",
    modifier_bit: CEF_EVENT_FLAG.NONE,
    shifted_key: "ArrowRight",
    windows_key_code: 0x27,
  }),
  freezeEntry({
    code: "ArrowDown",
    evdev_code: 108,
    is_letter: false,
    is_printable: false,
    key: "ArrowDown",
    modifier_bit: CEF_EVENT_FLAG.NONE,
    shifted_key: "ArrowDown",
    windows_key_code: 0x28,
  }),
]);

function makeCefKeyModifierState(
  left_shift_down: boolean,
  right_shift_down: boolean,
  left_ctrl_down: boolean,
  left_alt_down: boolean,
  caps_lock_on: boolean,
): CefKeyModifierState {
  const modifiers = currentCefModifiers({
    caps_lock_on,
    left_alt_down,
    left_ctrl_down,
    left_shift_down,
    right_shift_down,
  });

  return Object.freeze({
    caps_lock_on,
    left_alt_down,
    left_ctrl_down,
    left_shift_down,
    modifiers,
    right_shift_down,
  });
}

type CefKeyModifierBits = Omit<CefKeyModifierState, "modifiers">;

export function currentCefModifiers(state: CefKeyModifierBits): number {
  let modifiers = CEF_EVENT_FLAG.NONE;
  if (state.caps_lock_on) {
    modifiers |= CEF_EVENT_FLAG.CAPS_LOCK_ON;
  }
  if (state.left_shift_down || state.right_shift_down) {
    modifiers |= CEF_EVENT_FLAG.SHIFT_DOWN;
  }
  if (state.left_ctrl_down) {
    modifiers |= CEF_EVENT_FLAG.CONTROL_DOWN;
  }
  if (state.left_alt_down) {
    modifiers |= CEF_EVENT_FLAG.ALT_DOWN;
  }
  return modifiers;
}

const EMPTY_CEF_KEY_MODIFIER_STATE = makeCefKeyModifierState(
  false,
  false,
  false,
  false,
  false,
);

export function createCefKeyModifierState(): CefKeyModifierState {
  return EMPTY_CEF_KEY_MODIFIER_STATE;
}

export function lookupEvdevCefKeyEntry(evdevCode: number): EvdevCefKeyEntry | null {
  if (!Number.isInteger(evdevCode)) {
    return null;
  }

  for (const entry of EVDEV_CEF_KEY_ENTRIES) {
    if (entry.evdev_code === evdevCode) {
      return entry;
    }
  }
  return null;
}

export function resolveDomKey(
  entry: EvdevCefKeyEntry,
  state: CefKeyModifierState,
): string {
  if (!entry.is_printable) {
    return entry.key;
  }

  const shiftDown = state.left_shift_down || state.right_shift_down;
  if (entry.is_letter) {
    return shiftDown !== state.caps_lock_on ? entry.shifted_key : entry.key;
  }
  return shiftDown ? entry.shifted_key : entry.key;
}

function eventFromEntry(entry: EvdevCefKeyEntry, state: CefKeyModifierState): CefKeyEvent {
  return Object.freeze({
    code: entry.code,
    key: resolveDomKey(entry, state),
    modifiers: currentCefModifiers(state),
    windows_key_code: entry.windows_key_code,
  });
}

export function mapEvdevToCefKeyEvent(
  evdevCode: number,
  state: CefKeyModifierState = EMPTY_CEF_KEY_MODIFIER_STATE,
): CefKeyEvent | null {
  const entry = lookupEvdevCefKeyEntry(evdevCode);
  if (entry === null) {
    return null;
  }
  return eventFromEntry(entry, state);
}

function isKeyTransition(transition: string): transition is CefKeyTransition {
  return transition === "keydown" || transition === "keyup";
}

export function updateCefKeyModifierState(
  state: CefKeyModifierState,
  evdevCode: number,
  transition: CefKeyTransition,
): CefKeyModifierState {
  if (!isKeyTransition(transition)) {
    return state;
  }

  switch (evdevCode) {
    case 42:
      return makeCefKeyModifierState(
        transition === "keydown",
        state.right_shift_down,
        state.left_ctrl_down,
        state.left_alt_down,
        state.caps_lock_on,
      );
    case 54:
      return makeCefKeyModifierState(
        state.left_shift_down,
        transition === "keydown",
        state.left_ctrl_down,
        state.left_alt_down,
        state.caps_lock_on,
      );
    case 29:
      return makeCefKeyModifierState(
        state.left_shift_down,
        state.right_shift_down,
        transition === "keydown",
        state.left_alt_down,
        state.caps_lock_on,
      );
    case 56:
      return makeCefKeyModifierState(
        state.left_shift_down,
        state.right_shift_down,
        state.left_ctrl_down,
        transition === "keydown",
        state.caps_lock_on,
      );
    case 58:
      return makeCefKeyModifierState(
        state.left_shift_down,
        state.right_shift_down,
        state.left_ctrl_down,
        state.left_alt_down,
        transition === "keydown" ? !state.caps_lock_on : state.caps_lock_on,
      );
    default:
      return state;
  }
}

export function applyEvdevKeyTransition(
  state: CefKeyModifierState,
  evdevCode: number,
  transition: CefKeyTransition,
): CefKeyTransitionResult {
  const entry = lookupEvdevCefKeyEntry(evdevCode);
  if (entry === null || !isKeyTransition(transition)) {
    return Object.freeze({ event: null, state });
  }

  const nextState = updateCefKeyModifierState(state, evdevCode, transition);
  return Object.freeze({
    event: eventFromEntry(entry, nextState),
    state: nextState,
  });
}
