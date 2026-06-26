// Source-of-record for the CEF OSR keyboard layout character matrix.
// Keep packages/compositor-core/src/input/layout_map.rs in lockstep with this data.

export type CefKeyboardLayout = "us" | "de";
export type CefDeadKey = "acute" | "circumflex" | "grave";

export interface CefDeadKeyState {
  readonly id: CefDeadKey;
  readonly spacing: string;
}

export type CefLayoutKeyOutput = string | CefDeadKeyState;

export interface CefLayoutKeyEntry {
  readonly code: string;
  readonly normal: CefLayoutKeyOutput;
  readonly shift: CefLayoutKeyOutput | null;
  readonly altgr: CefLayoutKeyOutput | null;
  readonly shift_altgr: CefLayoutKeyOutput | null;
  readonly is_letter: boolean;
}

export interface CefLayoutModifierState {
  readonly shift_down?: boolean;
  readonly shiftDown?: boolean;
  readonly left_shift_down?: boolean;
  readonly right_shift_down?: boolean;
  readonly altgr_down?: boolean;
  readonly altGrDown?: boolean;
  readonly alt_graph_down?: boolean;
  readonly right_alt_down?: boolean;
  readonly left_alt_down?: boolean;
  readonly left_ctrl_down?: boolean;
  readonly right_ctrl_down?: boolean;
  readonly caps_lock_on?: boolean;
  readonly capsLockOn?: boolean;
}

export interface CefLayoutComposeState {
  readonly pending_dead_key: CefDeadKeyState | null;
}

export interface CefLayoutKeyInput {
  readonly layout: string;
  readonly code: string;
  readonly modifiers?: CefLayoutModifierState | null;
}

export interface CefLayoutTranslationResult {
  readonly char: string | null;
  readonly state: CefLayoutComposeState;
}

interface NormalizedLayoutModifiers {
  readonly shift_down: boolean;
  readonly altgr_down: boolean;
  readonly caps_lock_on: boolean;
}

interface NormalizedKeyInput {
  readonly layout: CefKeyboardLayout;
  readonly code: string;
  readonly modifiers: NormalizedLayoutModifiers;
}

export interface CefDeadKeyComposeEntry {
  readonly dead_key: CefDeadKey;
  readonly base: string;
  readonly composed: string;
}

const DEAD_ACUTE = deadKey("acute", "´");
const DEAD_CIRCUMFLEX = deadKey("circumflex", "^");
const DEAD_GRAVE = deadKey("grave", "`");

export const CEF_KEYBOARD_LAYOUTS: readonly CefKeyboardLayout[] = Object.freeze([
  "us",
  "de",
]);

export const CEF_LAYOUT_KEYMAP_ENTRIES: Readonly<
  Record<CefKeyboardLayout, readonly CefLayoutKeyEntry[]>
> = Object.freeze({
  de: Object.freeze([
    letterEntry("KeyQ", "q", "Q"),
    letterEntry("KeyW", "w", "W"),
    letterEntry("KeyE", "e", "E"),
    letterEntry("KeyR", "r", "R"),
    letterEntry("KeyT", "t", "T"),
    letterEntry("KeyY", "z", "Z"),
    letterEntry("KeyU", "u", "U"),
    letterEntry("KeyI", "i", "I"),
    letterEntry("KeyO", "o", "O"),
    letterEntry("KeyP", "p", "P"),
    letterEntry("KeyA", "a", "A"),
    letterEntry("KeyS", "s", "S"),
    letterEntry("KeyD", "d", "D"),
    letterEntry("KeyF", "f", "F"),
    letterEntry("KeyG", "g", "G"),
    letterEntry("KeyH", "h", "H"),
    letterEntry("KeyJ", "j", "J"),
    letterEntry("KeyK", "k", "K"),
    letterEntry("KeyL", "l", "L"),
    letterEntry("KeyZ", "y", "Y"),
    letterEntry("KeyX", "x", "X"),
    letterEntry("KeyC", "c", "C"),
    letterEntry("KeyV", "v", "V"),
    letterEntry("KeyB", "b", "B"),
    letterEntry("KeyN", "n", "N"),
    letterEntry("KeyM", "m", "M"),
    keyEntry("Digit1", "1", "!", null, null, false),
    keyEntry("Digit2", "2", "\"", "²", null, false),
    keyEntry("Digit3", "3", "§", "³", null, false),
    keyEntry("Digit4", "4", "$", null, null, false),
    keyEntry("Digit5", "5", "%", null, null, false),
    keyEntry("Digit6", "6", "&", null, null, false),
    keyEntry("Digit7", "7", "/", "{", null, false),
    keyEntry("Digit8", "8", "(", "[", null, false),
    keyEntry("Digit9", "9", ")", "]", null, false),
    keyEntry("Digit0", "0", "=", "}", null, false),
    keyEntry("Minus", "ß", "?", "\\", null, false),
    keyEntry("Equal", DEAD_ACUTE, DEAD_GRAVE, null, null, false),
    keyEntry("BracketLeft", "ü", "Ü", null, null, true),
    keyEntry("BracketRight", "+", "*", "~", null, false),
    keyEntry("Backslash", "#", "'", null, null, false),
    keyEntry("Semicolon", "ö", "Ö", null, null, true),
    keyEntry("Quote", "ä", "Ä", null, null, true),
    keyEntry("Backquote", DEAD_CIRCUMFLEX, "°", null, null, false),
    keyEntry("Comma", ",", ";", null, null, false),
    keyEntry("Period", ".", ":", null, null, false),
    keyEntry("Slash", "-", "_", null, null, false),
    keyEntry("Space", " ", " ", null, null, false),
  ]),
  us: Object.freeze([
    letterEntry("KeyQ", "q", "Q"),
    letterEntry("KeyW", "w", "W"),
    letterEntry("KeyE", "e", "E"),
    letterEntry("KeyR", "r", "R"),
    letterEntry("KeyT", "t", "T"),
    letterEntry("KeyY", "y", "Y"),
    letterEntry("KeyU", "u", "U"),
    letterEntry("KeyI", "i", "I"),
    letterEntry("KeyO", "o", "O"),
    letterEntry("KeyP", "p", "P"),
    letterEntry("KeyA", "a", "A"),
    letterEntry("KeyS", "s", "S"),
    letterEntry("KeyD", "d", "D"),
    letterEntry("KeyF", "f", "F"),
    letterEntry("KeyG", "g", "G"),
    letterEntry("KeyH", "h", "H"),
    letterEntry("KeyJ", "j", "J"),
    letterEntry("KeyK", "k", "K"),
    letterEntry("KeyL", "l", "L"),
    letterEntry("KeyZ", "z", "Z"),
    letterEntry("KeyX", "x", "X"),
    letterEntry("KeyC", "c", "C"),
    letterEntry("KeyV", "v", "V"),
    letterEntry("KeyB", "b", "B"),
    letterEntry("KeyN", "n", "N"),
    letterEntry("KeyM", "m", "M"),
    keyEntry("Digit1", "1", "!", null, null, false),
    keyEntry("Digit2", "2", "@", null, null, false),
    keyEntry("Digit3", "3", "#", null, null, false),
    keyEntry("Digit4", "4", "$", null, null, false),
    keyEntry("Digit5", "5", "%", null, null, false),
    keyEntry("Digit6", "6", "^", null, null, false),
    keyEntry("Digit7", "7", "&", null, null, false),
    keyEntry("Digit8", "8", "*", null, null, false),
    keyEntry("Digit9", "9", "(", null, null, false),
    keyEntry("Digit0", "0", ")", null, null, false),
    keyEntry("Minus", "-", "_", null, null, false),
    keyEntry("Equal", "=", "+", null, null, false),
    keyEntry("BracketLeft", "[", "{", null, null, false),
    keyEntry("BracketRight", "]", "}", null, null, false),
    keyEntry("Backslash", "\\", "|", null, null, false),
    keyEntry("Semicolon", ";", ":", null, null, false),
    keyEntry("Quote", "'", "\"", null, null, false),
    keyEntry("Backquote", "`", "~", null, null, false),
    keyEntry("Comma", ",", "<", null, null, false),
    keyEntry("Period", ".", ">", null, null, false),
    keyEntry("Slash", "/", "?", null, null, false),
    keyEntry("Space", " ", " ", null, null, false),
  ]),
});

export const CEF_DEAD_KEY_COMPOSE_ENTRIES: readonly CefDeadKeyComposeEntry[] =
  Object.freeze([
    composeEntry("acute", "a", "á"),
    composeEntry("acute", "e", "é"),
    composeEntry("acute", "i", "í"),
    composeEntry("acute", "o", "ó"),
    composeEntry("acute", "u", "ú"),
    composeEntry("acute", "y", "ý"),
    composeEntry("acute", "A", "Á"),
    composeEntry("acute", "E", "É"),
    composeEntry("acute", "I", "Í"),
    composeEntry("acute", "O", "Ó"),
    composeEntry("acute", "U", "Ú"),
    composeEntry("acute", "Y", "Ý"),
    composeEntry("acute", " ", "´"),
    composeEntry("circumflex", "a", "â"),
    composeEntry("circumflex", "e", "ê"),
    composeEntry("circumflex", "i", "î"),
    composeEntry("circumflex", "o", "ô"),
    composeEntry("circumflex", "u", "û"),
    composeEntry("circumflex", "A", "Â"),
    composeEntry("circumflex", "E", "Ê"),
    composeEntry("circumflex", "I", "Î"),
    composeEntry("circumflex", "O", "Ô"),
    composeEntry("circumflex", "U", "Û"),
    composeEntry("circumflex", " ", "^"),
    composeEntry("grave", "a", "à"),
    composeEntry("grave", "e", "è"),
    composeEntry("grave", "i", "ì"),
    composeEntry("grave", "o", "ò"),
    composeEntry("grave", "u", "ù"),
    composeEntry("grave", "A", "À"),
    composeEntry("grave", "E", "È"),
    composeEntry("grave", "I", "Ì"),
    composeEntry("grave", "O", "Ò"),
    composeEntry("grave", "U", "Ù"),
    composeEntry("grave", " ", "`"),
  ]);

const EMPTY_CEF_LAYOUT_MODIFIERS: NormalizedLayoutModifiers = Object.freeze({
  altgr_down: false,
  caps_lock_on: false,
  shift_down: false,
});

const EMPTY_CEF_LAYOUT_COMPOSE_STATE: CefLayoutComposeState = Object.freeze({
  pending_dead_key: null,
});

const SHIFT_FLAG_NAMES: readonly (keyof CefLayoutModifierState)[] = Object.freeze([
  "shift_down",
  "shiftDown",
  "left_shift_down",
  "right_shift_down",
]);

const ALTGR_FLAG_NAMES: readonly (keyof CefLayoutModifierState)[] = Object.freeze([
  "altgr_down",
  "altGrDown",
  "alt_graph_down",
  "right_alt_down",
]);

const ALT_FLAG_NAMES: readonly (keyof CefLayoutModifierState)[] = Object.freeze([
  "left_alt_down",
  "right_alt_down",
]);

const CTRL_FLAG_NAMES: readonly (keyof CefLayoutModifierState)[] = Object.freeze([
  "left_ctrl_down",
  "right_ctrl_down",
]);

const CAPS_FLAG_NAMES: readonly (keyof CefLayoutModifierState)[] = Object.freeze([
  "caps_lock_on",
  "capsLockOn",
]);

function deadKey(id: CefDeadKey, spacing: string): CefDeadKeyState {
  return Object.freeze({ id, spacing });
}

function keyEntry(
  code: string,
  normal: CefLayoutKeyOutput,
  shift: CefLayoutKeyOutput | null,
  altgr: CefLayoutKeyOutput | null,
  shift_altgr: CefLayoutKeyOutput | null,
  is_letter: boolean,
): CefLayoutKeyEntry {
  return Object.freeze({
    altgr,
    code,
    is_letter,
    normal,
    shift,
    shift_altgr,
  });
}

function letterEntry(code: string, normal: string, shift: string): CefLayoutKeyEntry {
  return keyEntry(code, normal, shift, null, null, true);
}

function composeEntry(
  dead_key: CefDeadKey,
  base: string,
  composed: string,
): CefDeadKeyComposeEntry {
  return Object.freeze({ base, composed, dead_key });
}

export function createCefLayoutComposeState(): CefLayoutComposeState {
  return EMPTY_CEF_LAYOUT_COMPOSE_STATE;
}

export function isCefKeyboardLayout(layout: string): layout is CefKeyboardLayout {
  return layout === "us" || layout === "de";
}

export function lookupCefLayoutKeyEntry(
  layout: string,
  code: string,
): CefLayoutKeyEntry | null {
  if (!isCefKeyboardLayout(layout) || typeof code !== "string") {
    return null;
  }

  for (const entry of CEF_LAYOUT_KEYMAP_ENTRIES[layout]) {
    if (entry.code === code) {
      return entry;
    }
  }
  return null;
}

export function resolveCefLayoutChar(
  layout: string,
  code: string,
  modifiers: CefLayoutModifierState | null = null,
): string | null {
  return translateCefLayoutKey(
    { code, layout, modifiers },
    EMPTY_CEF_LAYOUT_COMPOSE_STATE,
  ).char;
}

export function translateCefLayoutChar(
  code: string,
  modifiers: CefLayoutModifierState | null = null,
  layout: string = "us",
): string | null {
  return resolveCefLayoutChar(layout, code, modifiers);
}

export function translateCefLayoutKey(
  input: CefLayoutKeyInput,
  state: CefLayoutComposeState = EMPTY_CEF_LAYOUT_COMPOSE_STATE,
): CefLayoutTranslationResult {
  const composeState = normalizeComposeState(state);
  const normalized = normalizeKeyInput(input);
  if (normalized === null) {
    return result(null, composeState);
  }

  const entry = lookupCefLayoutKeyEntry(normalized.layout, normalized.code);
  if (entry === null) {
    return result(null, composeState);
  }

  const output = selectKeyOutput(entry, normalized.modifiers);
  if (output === null) {
    return result(null, composeState);
  }

  return applyComposeOutput(output, composeState);
}

export function applyCefLayoutKey(
  input: CefLayoutKeyInput,
  state: CefLayoutComposeState = EMPTY_CEF_LAYOUT_COMPOSE_STATE,
): CefLayoutTranslationResult {
  return translateCefLayoutKey(input, state);
}

function normalizeKeyInput(input: unknown): NormalizedKeyInput | null {
  if (input === null || typeof input !== "object") {
    return null;
  }

  const layout = readStringField(input, "layout");
  const code = readStringField(input, "code");
  const modifiersValue = readOptionalField(input, "modifiers");
  if (layout === null || code === null || modifiersValue === INVALID_FIELD) {
    return null;
  }
  if (!isCefKeyboardLayout(layout)) {
    return null;
  }

  const modifiers = normalizeModifiers(modifiersValue);
  if (modifiers === null) {
    return null;
  }

  return Object.freeze({ code, layout, modifiers });
}

function normalizeModifiers(modifiers: unknown): NormalizedLayoutModifiers | null {
  if (modifiers === null || modifiers === undefined) {
    return EMPTY_CEF_LAYOUT_MODIFIERS;
  }
  if (typeof modifiers !== "object") {
    return null;
  }

  const shiftDown = anyBooleanFlag(modifiers, SHIFT_FLAG_NAMES);
  const altGrDown = anyBooleanFlag(modifiers, ALTGR_FLAG_NAMES);
  const altDown = anyBooleanFlag(modifiers, ALT_FLAG_NAMES);
  const ctrlDown = anyBooleanFlag(modifiers, CTRL_FLAG_NAMES);
  const capsLockOn = anyBooleanFlag(modifiers, CAPS_FLAG_NAMES);
  if (
    shiftDown === null ||
    altGrDown === null ||
    altDown === null ||
    ctrlDown === null ||
    capsLockOn === null
  ) {
    return null;
  }

  return Object.freeze({
    altgr_down: altGrDown || (altDown && ctrlDown),
    caps_lock_on: capsLockOn,
    shift_down: shiftDown,
  });
}

function normalizeComposeState(state: unknown): CefLayoutComposeState {
  if (state === null || state === undefined || typeof state !== "object") {
    return EMPTY_CEF_LAYOUT_COMPOSE_STATE;
  }

  const pending = readOptionalField(state, "pending_dead_key");
  if (pending === undefined || pending === null || pending === INVALID_FIELD) {
    return EMPTY_CEF_LAYOUT_COMPOSE_STATE;
  }
  if (typeof pending !== "object") {
    return EMPTY_CEF_LAYOUT_COMPOSE_STATE;
  }

  const id = readStringField(pending, "id");
  const spacing = readStringField(pending, "spacing");
  if (
    spacing === null ||
    (id !== "acute" && id !== "circumflex" && id !== "grave")
  ) {
    return EMPTY_CEF_LAYOUT_COMPOSE_STATE;
  }

  return composeState(deadKey(id, spacing));
}

function anyBooleanFlag(
  input: object,
  keys: readonly (keyof CefLayoutModifierState)[],
): boolean | null {
  let matched = false;
  for (const key of keys) {
    const value = readBooleanFlag(input, key);
    if (value === null) {
      return null;
    }
    matched = matched || value;
  }
  return matched;
}

function readBooleanFlag(input: object, key: keyof CefLayoutModifierState): boolean | null {
  const value = readOptionalField(input, key);
  if (value === INVALID_FIELD) {
    return null;
  }
  return value === true;
}

const INVALID_FIELD = Symbol("invalid-field");

function readStringField(input: object, key: string): string | null {
  const value = readOptionalField(input, key);
  return typeof value === "string" ? value : null;
}

function readOptionalField(
  input: object,
  key: string,
): unknown | typeof INVALID_FIELD {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(input, key);
    if (descriptor === undefined) {
      return undefined;
    }
    if (!("value" in descriptor)) {
      return INVALID_FIELD;
    }
    const value: unknown = descriptor.value;
    return value;
  } catch {
    return INVALID_FIELD;
  }
}

function selectKeyOutput(
  entry: CefLayoutKeyEntry,
  modifiers: NormalizedLayoutModifiers,
): CefLayoutKeyOutput | null {
  if (modifiers.altgr_down) {
    if (modifiers.shift_down && entry.shift_altgr !== null) {
      return entry.shift_altgr;
    }
    if (entry.altgr !== null) {
      return entry.altgr;
    }
  }

  if (entry.is_letter) {
    const upper = modifiers.shift_down !== modifiers.caps_lock_on;
    return upper && entry.shift !== null ? entry.shift : entry.normal;
  }

  return modifiers.shift_down && entry.shift !== null ? entry.shift : entry.normal;
}

function applyComposeOutput(
  output: CefLayoutKeyOutput,
  state: CefLayoutComposeState,
): CefLayoutTranslationResult {
  const pending = state.pending_dead_key;
  if (isDeadKeyOutput(output)) {
    if (pending === null) {
      return result(null, composeState(output));
    }
    if (pending.id === output.id) {
      return result(pending.spacing, EMPTY_CEF_LAYOUT_COMPOSE_STATE);
    }
    return result(pending.spacing + output.spacing, EMPTY_CEF_LAYOUT_COMPOSE_STATE);
  }

  if (pending === null) {
    return result(output, EMPTY_CEF_LAYOUT_COMPOSE_STATE);
  }

  const composed = composeDeadKey(pending.id, output);
  return result(
    composed === null ? pending.spacing + output : composed,
    EMPTY_CEF_LAYOUT_COMPOSE_STATE,
  );
}

function composeDeadKey(deadKeyId: CefDeadKey, base: string): string | null {
  for (const entry of CEF_DEAD_KEY_COMPOSE_ENTRIES) {
    if (entry.dead_key === deadKeyId && entry.base === base) {
      return entry.composed;
    }
  }
  return null;
}

function isDeadKeyOutput(output: CefLayoutKeyOutput): output is CefDeadKeyState {
  return typeof output === "object";
}

function composeState(pending_dead_key: CefDeadKeyState): CefLayoutComposeState {
  return Object.freeze({ pending_dead_key });
}

function result(
  char: string | null,
  state: CefLayoutComposeState,
): CefLayoutTranslationResult {
  return Object.freeze({ char, state });
}
