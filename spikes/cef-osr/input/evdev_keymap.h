#pragma once

// Vendored CEF-free mirror of sdk/typescript/src/ui-kits/cef-keymap.ts.
// Build-time parse check: include this header from an empty C++17 translation
// unit. The authoritative automated parity check is the Node TS mirror test:
// sdk/typescript/test/ui-kits/cef-keymap.test.ts.

namespace vita::cef_osr::input {

enum CefEventFlag : unsigned int {
  kCefEventFlagNone = 0,
  kCefEventFlagCapsLockOn = 1u << 0,
  kCefEventFlagShiftDown = 1u << 1,
  kCefEventFlagControlDown = 1u << 2,
  kCefEventFlagAltDown = 1u << 3,
};

enum class EvdevKeyTransition {
  kKeyDown,
  kKeyUp,
};

struct EvdevCefKeyEntry {
  bool has_entry;
  int evdev_code;
  int windows_key_code;
  const char* key;
  const char* shifted_key;
  const char* code;
  unsigned int modifier_bit;
  bool is_letter;
  bool is_printable;
};

struct CefKeyModifierState {
  bool left_shift_down;
  bool right_shift_down;
  bool left_ctrl_down;
  bool left_alt_down;
  bool caps_lock_on;
};

struct CefKeyEvent {
  bool has_event;
  int windows_key_code;
  const char* key;
  const char* code;
  unsigned int modifiers;
};

struct CefKeyTransitionResult {
  CefKeyModifierState state;
  CefKeyEvent event;
};

constexpr unsigned int CurrentCefModifiers(CefKeyModifierState state) {
  unsigned int modifiers = kCefEventFlagNone;
  if (state.caps_lock_on) {
    modifiers |= kCefEventFlagCapsLockOn;
  }
  if (state.left_shift_down || state.right_shift_down) {
    modifiers |= kCefEventFlagShiftDown;
  }
  if (state.left_ctrl_down) {
    modifiers |= kCefEventFlagControlDown;
  }
  if (state.left_alt_down) {
    modifiers |= kCefEventFlagAltDown;
  }
  return modifiers;
}

constexpr CefKeyModifierState EmptyCefKeyModifierState() {
  return {false, false, false, false, false};
}

constexpr EvdevCefKeyEntry NoEvdevCefKeyEntry() {
  return {false, 0, 0, "", "", "", kCefEventFlagNone, false, false};
}

constexpr EvdevCefKeyEntry LookupEvdevCefKeyEntry(int evdev_code) {
  switch (evdev_code) {
    case 1:
      return {true, 1, 0x1B, "Escape", "Escape", "Escape",
              kCefEventFlagNone, false, false};
    case 2:
      return {true, 2, 0x31, "1", "!", "Digit1", kCefEventFlagNone,
              false, true};
    case 3:
      return {true, 3, 0x32, "2", "@", "Digit2", kCefEventFlagNone,
              false, true};
    case 4:
      return {true, 4, 0x33, "3", "#", "Digit3", kCefEventFlagNone,
              false, true};
    case 5:
      return {true, 5, 0x34, "4", "$", "Digit4", kCefEventFlagNone,
              false, true};
    case 6:
      return {true, 6, 0x35, "5", "%", "Digit5", kCefEventFlagNone,
              false, true};
    case 7:
      return {true, 7, 0x36, "6", "^", "Digit6", kCefEventFlagNone,
              false, true};
    case 8:
      return {true, 8, 0x37, "7", "&", "Digit7", kCefEventFlagNone,
              false, true};
    case 9:
      return {true, 9, 0x38, "8", "*", "Digit8", kCefEventFlagNone,
              false, true};
    case 10:
      return {true, 10, 0x39, "9", "(", "Digit9", kCefEventFlagNone,
              false, true};
    case 11:
      return {true, 11, 0x30, "0", ")", "Digit0", kCefEventFlagNone,
              false, true};
    case 14:
      return {true, 14, 0x08, "Backspace", "Backspace", "Backspace",
              kCefEventFlagNone, false, false};
    case 15:
      return {true, 15, 0x09, "Tab", "Tab", "Tab", kCefEventFlagNone,
              false, false};
    case 16:
      return {true, 16, 0x51, "q", "Q", "KeyQ", kCefEventFlagNone,
              true, true};
    case 17:
      return {true, 17, 0x57, "w", "W", "KeyW", kCefEventFlagNone,
              true, true};
    case 18:
      return {true, 18, 0x45, "e", "E", "KeyE", kCefEventFlagNone,
              true, true};
    case 19:
      return {true, 19, 0x52, "r", "R", "KeyR", kCefEventFlagNone,
              true, true};
    case 20:
      return {true, 20, 0x54, "t", "T", "KeyT", kCefEventFlagNone,
              true, true};
    case 21:
      return {true, 21, 0x59, "y", "Y", "KeyY", kCefEventFlagNone,
              true, true};
    case 22:
      return {true, 22, 0x55, "u", "U", "KeyU", kCefEventFlagNone,
              true, true};
    case 23:
      return {true, 23, 0x49, "i", "I", "KeyI", kCefEventFlagNone,
              true, true};
    case 24:
      return {true, 24, 0x4F, "o", "O", "KeyO", kCefEventFlagNone,
              true, true};
    case 25:
      return {true, 25, 0x50, "p", "P", "KeyP", kCefEventFlagNone,
              true, true};
    case 28:
      return {true, 28, 0x0D, "Enter", "Enter", "Enter",
              kCefEventFlagNone, false, false};
    case 29:
      return {true, 29, 0xA2, "Control", "Control", "ControlLeft",
              kCefEventFlagControlDown, false, false};
    case 30:
      return {true, 30, 0x41, "a", "A", "KeyA", kCefEventFlagNone,
              true, true};
    case 31:
      return {true, 31, 0x53, "s", "S", "KeyS", kCefEventFlagNone,
              true, true};
    case 32:
      return {true, 32, 0x44, "d", "D", "KeyD", kCefEventFlagNone,
              true, true};
    case 33:
      return {true, 33, 0x46, "f", "F", "KeyF", kCefEventFlagNone,
              true, true};
    case 34:
      return {true, 34, 0x47, "g", "G", "KeyG", kCefEventFlagNone,
              true, true};
    case 35:
      return {true, 35, 0x48, "h", "H", "KeyH", kCefEventFlagNone,
              true, true};
    case 36:
      return {true, 36, 0x4A, "j", "J", "KeyJ", kCefEventFlagNone,
              true, true};
    case 37:
      return {true, 37, 0x4B, "k", "K", "KeyK", kCefEventFlagNone,
              true, true};
    case 38:
      return {true, 38, 0x4C, "l", "L", "KeyL", kCefEventFlagNone,
              true, true};
    case 42:
      return {true, 42, 0xA0, "Shift", "Shift", "ShiftLeft",
              kCefEventFlagShiftDown, false, false};
    case 44:
      return {true, 44, 0x5A, "z", "Z", "KeyZ", kCefEventFlagNone,
              true, true};
    case 45:
      return {true, 45, 0x58, "x", "X", "KeyX", kCefEventFlagNone,
              true, true};
    case 46:
      return {true, 46, 0x43, "c", "C", "KeyC", kCefEventFlagNone,
              true, true};
    case 47:
      return {true, 47, 0x56, "v", "V", "KeyV", kCefEventFlagNone,
              true, true};
    case 48:
      return {true, 48, 0x42, "b", "B", "KeyB", kCefEventFlagNone,
              true, true};
    case 49:
      return {true, 49, 0x4E, "n", "N", "KeyN", kCefEventFlagNone,
              true, true};
    case 50:
      return {true, 50, 0x4D, "m", "M", "KeyM", kCefEventFlagNone,
              true, true};
    case 54:
      return {true, 54, 0xA1, "Shift", "Shift", "ShiftRight",
              kCefEventFlagShiftDown, false, false};
    case 56:
      return {true, 56, 0xA4, "Alt", "Alt", "AltLeft",
              kCefEventFlagAltDown, false, false};
    case 57:
      return {true, 57, 0x20, " ", " ", "Space", kCefEventFlagNone,
              false, true};
    case 58:
      return {true, 58, 0x14, "CapsLock", "CapsLock", "CapsLock",
              kCefEventFlagCapsLockOn, false, false};
    case 103:
      return {true, 103, 0x26, "ArrowUp", "ArrowUp", "ArrowUp",
              kCefEventFlagNone, false, false};
    case 105:
      return {true, 105, 0x25, "ArrowLeft", "ArrowLeft", "ArrowLeft",
              kCefEventFlagNone, false, false};
    case 106:
      return {true, 106, 0x27, "ArrowRight", "ArrowRight", "ArrowRight",
              kCefEventFlagNone, false, false};
    case 108:
      return {true, 108, 0x28, "ArrowDown", "ArrowDown", "ArrowDown",
              kCefEventFlagNone, false, false};
    default:
      return NoEvdevCefKeyEntry();
  }
}

constexpr const char* ResolveDomKey(EvdevCefKeyEntry entry,
                                    CefKeyModifierState state) {
  if (!entry.has_entry) {
    return "";
  }
  if (!entry.is_printable) {
    return entry.key;
  }

  const bool shift_down = state.left_shift_down || state.right_shift_down;
  if (entry.is_letter) {
    return shift_down != state.caps_lock_on ? entry.shifted_key : entry.key;
  }
  return shift_down ? entry.shifted_key : entry.key;
}

constexpr CefKeyEvent MapEvdevToCefKeyEvent(int evdev_code,
                                            CefKeyModifierState state) {
  const EvdevCefKeyEntry entry = LookupEvdevCefKeyEntry(evdev_code);
  if (!entry.has_entry) {
    return {false, 0, "", "", kCefEventFlagNone};
  }
  return {true, entry.windows_key_code, ResolveDomKey(entry, state), entry.code,
          CurrentCefModifiers(state)};
}

constexpr CefKeyModifierState UpdateCefKeyModifierState(
    CefKeyModifierState state,
    int evdev_code,
    EvdevKeyTransition transition) {
  switch (evdev_code) {
    case 42:
      state.left_shift_down = transition == EvdevKeyTransition::kKeyDown;
      return state;
    case 54:
      state.right_shift_down = transition == EvdevKeyTransition::kKeyDown;
      return state;
    case 29:
      state.left_ctrl_down = transition == EvdevKeyTransition::kKeyDown;
      return state;
    case 56:
      state.left_alt_down = transition == EvdevKeyTransition::kKeyDown;
      return state;
    case 58:
      if (transition == EvdevKeyTransition::kKeyDown) {
        state.caps_lock_on = !state.caps_lock_on;
      }
      return state;
    default:
      return state;
  }
}

constexpr CefKeyTransitionResult ApplyEvdevKeyTransition(
    CefKeyModifierState state,
    int evdev_code,
    EvdevKeyTransition transition) {
  const EvdevCefKeyEntry entry = LookupEvdevCefKeyEntry(evdev_code);
  if (!entry.has_entry) {
    return {state, {false, 0, "", "", kCefEventFlagNone}};
  }

  const CefKeyModifierState next_state =
      UpdateCefKeyModifierState(state, evdev_code, transition);
  return {next_state, MapEvdevToCefKeyEvent(evdev_code, next_state)};
}

}  // namespace vita::cef_osr::input
