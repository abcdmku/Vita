// Vendored keyboard layout data mirrored from sdk/typescript/src/ui-kits/cef-layout-map.ts.
// This leaf is CEF-free, dependency-free, and I/O-free; keep it in lockstep with the TS
// source-of-record when extending the matrix.

#[derive(Debug, Clone, Copy, Eq, PartialEq)]
pub enum KeyboardLayout {
    Us,
    De,
}

#[derive(Debug, Clone, Copy, Eq, PartialEq)]
pub enum DeadKey {
    Acute,
    Circumflex,
    Grave,
}

#[derive(Debug, Clone, Copy, Eq, PartialEq)]
pub enum KeyOutput {
    Char(&'static str),
    Dead { id: DeadKey, spacing: &'static str },
}

#[derive(Debug, Clone, Copy, Eq, PartialEq)]
pub struct LayoutKeyEntry {
    pub code: &'static str,
    pub normal: KeyOutput,
    pub shift: Option<KeyOutput>,
    pub altgr: Option<KeyOutput>,
    pub shift_altgr: Option<KeyOutput>,
    pub is_letter: bool,
}

#[derive(Debug, Clone, Copy, Eq, PartialEq)]
pub struct DeadKeyComposeEntry {
    pub dead_key: DeadKey,
    pub base: &'static str,
    pub composed: &'static str,
}

pub const SUPPORTED_KEYBOARD_LAYOUTS: &[KeyboardLayout] = &[KeyboardLayout::Us, KeyboardLayout::De];

pub const US_LAYOUT_KEYMAP: &[LayoutKeyEntry] = &[
    letter("KeyQ", "q", "Q"),
    letter("KeyW", "w", "W"),
    letter("KeyE", "e", "E"),
    letter("KeyR", "r", "R"),
    letter("KeyT", "t", "T"),
    letter("KeyY", "y", "Y"),
    letter("KeyU", "u", "U"),
    letter("KeyI", "i", "I"),
    letter("KeyO", "o", "O"),
    letter("KeyP", "p", "P"),
    letter("KeyA", "a", "A"),
    letter("KeyS", "s", "S"),
    letter("KeyD", "d", "D"),
    letter("KeyF", "f", "F"),
    letter("KeyG", "g", "G"),
    letter("KeyH", "h", "H"),
    letter("KeyJ", "j", "J"),
    letter("KeyK", "k", "K"),
    letter("KeyL", "l", "L"),
    letter("KeyZ", "z", "Z"),
    letter("KeyX", "x", "X"),
    letter("KeyC", "c", "C"),
    letter("KeyV", "v", "V"),
    letter("KeyB", "b", "B"),
    letter("KeyN", "n", "N"),
    letter("KeyM", "m", "M"),
    key("Digit1", char_out("1"), Some(char_out("!")), None, None, false),
    key("Digit2", char_out("2"), Some(char_out("@")), None, None, false),
    key("Digit3", char_out("3"), Some(char_out("#")), None, None, false),
    key("Digit4", char_out("4"), Some(char_out("$")), None, None, false),
    key("Digit5", char_out("5"), Some(char_out("%")), None, None, false),
    key("Digit6", char_out("6"), Some(char_out("^")), None, None, false),
    key("Digit7", char_out("7"), Some(char_out("&")), None, None, false),
    key("Digit8", char_out("8"), Some(char_out("*")), None, None, false),
    key("Digit9", char_out("9"), Some(char_out("(")), None, None, false),
    key("Digit0", char_out("0"), Some(char_out(")")), None, None, false),
    key("Minus", char_out("-"), Some(char_out("_")), None, None, false),
    key("Equal", char_out("="), Some(char_out("+")), None, None, false),
    key("BracketLeft", char_out("["), Some(char_out("{")), None, None, false),
    key("BracketRight", char_out("]"), Some(char_out("}")), None, None, false),
    key("Backslash", char_out("\\"), Some(char_out("|")), None, None, false),
    key("Semicolon", char_out(";"), Some(char_out(":")), None, None, false),
    key("Quote", char_out("'"), Some(char_out("\"")), None, None, false),
    key("Backquote", char_out("`"), Some(char_out("~")), None, None, false),
    key("Comma", char_out(","), Some(char_out("<")), None, None, false),
    key("Period", char_out("."), Some(char_out(">")), None, None, false),
    key("Slash", char_out("/"), Some(char_out("?")), None, None, false),
    key("Space", char_out(" "), Some(char_out(" ")), None, None, false),
];

pub const DE_LAYOUT_KEYMAP: &[LayoutKeyEntry] = &[
    letter("KeyQ", "q", "Q"),
    letter("KeyW", "w", "W"),
    letter("KeyE", "e", "E"),
    letter("KeyR", "r", "R"),
    letter("KeyT", "t", "T"),
    letter("KeyY", "z", "Z"),
    letter("KeyU", "u", "U"),
    letter("KeyI", "i", "I"),
    letter("KeyO", "o", "O"),
    letter("KeyP", "p", "P"),
    letter("KeyA", "a", "A"),
    letter("KeyS", "s", "S"),
    letter("KeyD", "d", "D"),
    letter("KeyF", "f", "F"),
    letter("KeyG", "g", "G"),
    letter("KeyH", "h", "H"),
    letter("KeyJ", "j", "J"),
    letter("KeyK", "k", "K"),
    letter("KeyL", "l", "L"),
    letter("KeyZ", "y", "Y"),
    letter("KeyX", "x", "X"),
    letter("KeyC", "c", "C"),
    letter("KeyV", "v", "V"),
    letter("KeyB", "b", "B"),
    letter("KeyN", "n", "N"),
    letter("KeyM", "m", "M"),
    key("Digit1", char_out("1"), Some(char_out("!")), None, None, false),
    key("Digit2", char_out("2"), Some(char_out("\"")), Some(char_out("²")), None, false),
    key("Digit3", char_out("3"), Some(char_out("§")), Some(char_out("³")), None, false),
    key("Digit4", char_out("4"), Some(char_out("$")), None, None, false),
    key("Digit5", char_out("5"), Some(char_out("%")), None, None, false),
    key("Digit6", char_out("6"), Some(char_out("&")), None, None, false),
    key("Digit7", char_out("7"), Some(char_out("/")), Some(char_out("{")), None, false),
    key("Digit8", char_out("8"), Some(char_out("(")), Some(char_out("[")), None, false),
    key("Digit9", char_out("9"), Some(char_out(")")), Some(char_out("]")), None, false),
    key("Digit0", char_out("0"), Some(char_out("=")), Some(char_out("}")), None, false),
    key("Minus", char_out("ß"), Some(char_out("?")), Some(char_out("\\")), None, false),
    key("Equal", dead(DeadKey::Acute, "´"), Some(dead(DeadKey::Grave, "`")), None, None, false),
    key("BracketLeft", char_out("ü"), Some(char_out("Ü")), None, None, true),
    key("BracketRight", char_out("+"), Some(char_out("*")), Some(char_out("~")), None, false),
    key("Backslash", char_out("#"), Some(char_out("'")), None, None, false),
    key("Semicolon", char_out("ö"), Some(char_out("Ö")), None, None, true),
    key("Quote", char_out("ä"), Some(char_out("Ä")), None, None, true),
    key("Backquote", dead(DeadKey::Circumflex, "^"), Some(char_out("°")), None, None, false),
    key("Comma", char_out(","), Some(char_out(";")), None, None, false),
    key("Period", char_out("."), Some(char_out(":")), None, None, false),
    key("Slash", char_out("-"), Some(char_out("_")), None, None, false),
    key("Space", char_out(" "), Some(char_out(" ")), None, None, false),
];

pub const DEAD_KEY_COMPOSE: &[DeadKeyComposeEntry] = &[
    compose(DeadKey::Acute, "a", "á"),
    compose(DeadKey::Acute, "e", "é"),
    compose(DeadKey::Acute, "i", "í"),
    compose(DeadKey::Acute, "o", "ó"),
    compose(DeadKey::Acute, "u", "ú"),
    compose(DeadKey::Acute, "y", "ý"),
    compose(DeadKey::Acute, "A", "Á"),
    compose(DeadKey::Acute, "E", "É"),
    compose(DeadKey::Acute, "I", "Í"),
    compose(DeadKey::Acute, "O", "Ó"),
    compose(DeadKey::Acute, "U", "Ú"),
    compose(DeadKey::Acute, "Y", "Ý"),
    compose(DeadKey::Acute, " ", "´"),
    compose(DeadKey::Circumflex, "a", "â"),
    compose(DeadKey::Circumflex, "e", "ê"),
    compose(DeadKey::Circumflex, "i", "î"),
    compose(DeadKey::Circumflex, "o", "ô"),
    compose(DeadKey::Circumflex, "u", "û"),
    compose(DeadKey::Circumflex, "A", "Â"),
    compose(DeadKey::Circumflex, "E", "Ê"),
    compose(DeadKey::Circumflex, "I", "Î"),
    compose(DeadKey::Circumflex, "O", "Ô"),
    compose(DeadKey::Circumflex, "U", "Û"),
    compose(DeadKey::Circumflex, " ", "^"),
    compose(DeadKey::Grave, "a", "à"),
    compose(DeadKey::Grave, "e", "è"),
    compose(DeadKey::Grave, "i", "ì"),
    compose(DeadKey::Grave, "o", "ò"),
    compose(DeadKey::Grave, "u", "ù"),
    compose(DeadKey::Grave, "A", "À"),
    compose(DeadKey::Grave, "E", "È"),
    compose(DeadKey::Grave, "I", "Ì"),
    compose(DeadKey::Grave, "O", "Ò"),
    compose(DeadKey::Grave, "U", "Ù"),
    compose(DeadKey::Grave, " ", "`"),
];

pub const fn layout_keymap(layout: KeyboardLayout) -> &'static [LayoutKeyEntry] {
    match layout {
        KeyboardLayout::Us => US_LAYOUT_KEYMAP,
        KeyboardLayout::De => DE_LAYOUT_KEYMAP,
    }
}

const fn letter(code: &'static str, normal: &'static str, shift: &'static str) -> LayoutKeyEntry {
    key(code, char_out(normal), Some(char_out(shift)), None, None, true)
}

const fn key(
    code: &'static str,
    normal: KeyOutput,
    shift: Option<KeyOutput>,
    altgr: Option<KeyOutput>,
    shift_altgr: Option<KeyOutput>,
    is_letter: bool,
) -> LayoutKeyEntry {
    LayoutKeyEntry {
        code,
        normal,
        shift,
        altgr,
        shift_altgr,
        is_letter,
    }
}

const fn char_out(value: &'static str) -> KeyOutput {
    KeyOutput::Char(value)
}

const fn dead(id: DeadKey, spacing: &'static str) -> KeyOutput {
    KeyOutput::Dead { id, spacing }
}

const fn compose(
    dead_key: DeadKey,
    base: &'static str,
    composed: &'static str,
) -> DeadKeyComposeEntry {
    DeadKeyComposeEntry {
        dead_key,
        base,
        composed,
    }
}
