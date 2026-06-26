import assert from "node:assert/strict";
import { test } from "node:test";

import {
  CEF_DEAD_KEY_COMPOSE_ENTRIES,
  CEF_LAYOUT_KEYMAP_ENTRIES,
  createCefLayoutComposeState,
  lookupCefLayoutKeyEntry,
  resolveCefLayoutChar,
  translateCefLayoutKey,
} from "../../src/ui-kits/cef-layout-map.ts";
import type {
  CefLayoutComposeState,
  CefLayoutModifierState,
  CefLayoutTranslationResult,
} from "../../src/ui-kits/cef-layout-map.ts";

const emptyModifiers: CefLayoutModifierState = Object.freeze({});
const shifted: CefLayoutModifierState = Object.freeze({ shift_down: true });
const caps: CefLayoutModifierState = Object.freeze({ caps_lock_on: true });
const altgr: CefLayoutModifierState = Object.freeze({ altgr_down: true });

test("layout matrix resolves concrete US and German printable characters", () => {
  assert.equal(CEF_LAYOUT_KEYMAP_ENTRIES.us.length, 48);
  assert.equal(CEF_LAYOUT_KEYMAP_ENTRIES.de.length, 48);

  assert.equal(resolveCefLayoutChar("us", "KeyZ", emptyModifiers), "z");
  assert.equal(resolveCefLayoutChar("us", "KeyZ", shifted), "Z");
  assert.equal(resolveCefLayoutChar("de", "KeyZ", emptyModifiers), "y");
  assert.equal(resolveCefLayoutChar("de", "KeyZ", shifted), "Y");
  assert.equal(resolveCefLayoutChar("de", "KeyY", emptyModifiers), "z");
  assert.equal(resolveCefLayoutChar("de", "KeyY", shifted), "Z");
  assert.equal(resolveCefLayoutChar("de", "Digit1", shifted), "!");
  assert.equal(resolveCefLayoutChar("de", "Digit7", altgr), "{");
});

test("caps lock affects letters only and leaves digits and symbols unchanged", () => {
  assert.equal(resolveCefLayoutChar("us", "KeyA", caps), "A");
  assert.equal(
    resolveCefLayoutChar(
      "us",
      "KeyA",
      Object.freeze({ caps_lock_on: true, shift_down: true }),
    ),
    "a",
  );
  assert.equal(resolveCefLayoutChar("us", "Digit1", caps), "1");
  assert.equal(resolveCefLayoutChar("de", "Digit1", caps), "1");
});

test("dead-key compose emits one composed character and clears state", () => {
  const pending = applyKnown("de", "Equal", emptyModifiers, createCefLayoutComposeState());
  assert.equal(pending.char, null);
  assert.deepEqual(pending.state, {
    pending_dead_key: { id: "acute", spacing: "´" },
  });

  const composed = applyKnown("de", "KeyE", emptyModifiers, pending.state);
  assert.equal(composed.char, "é");
  assert.equal(composed.state.pending_dead_key, null);
  assert.equal(composed.char?.length, 1);

  const shiftedPending = applyKnown("de", "Equal", emptyModifiers);
  const shiftedComposed = applyKnown("de", "KeyE", shifted, shiftedPending.state);
  assert.equal(shiftedComposed.char, "É");
});

test("dead-key fallback emits spacing form for non-composable and double-dead paths", () => {
  const pendingAcute = applyKnown("de", "Equal", emptyModifiers);
  const fallback = applyKnown("de", "KeyX", emptyModifiers, pendingAcute.state);
  assert.equal(fallback.char, "´x");
  assert.equal(fallback.state.pending_dead_key, null);

  const pendingAgain = applyKnown("de", "Equal", emptyModifiers);
  const doubleDead = applyKnown("de", "Equal", emptyModifiers, pendingAgain.state);
  assert.equal(doubleDead.char, "´");
  assert.equal(doubleDead.state.pending_dead_key, null);

  const pendingCircumflex = applyKnown("de", "Backquote", emptyModifiers);
  const circumflex = applyKnown("de", "KeyE", emptyModifiers, pendingCircumflex.state);
  assert.equal(circumflex.char, "ê");
});

test("unknown layout or unmapped code is dropped fail-closed", () => {
  const pendingAcute = applyKnown("de", "Equal", emptyModifiers);

  assert.equal(lookupCefLayoutKeyEntry("de", "F13"), null);
  assert.equal(lookupCefLayoutKeyEntry("fr", "KeyA"), null);
  assert.equal(resolveCefLayoutChar("de", "F13", shifted), null);
  assert.equal(resolveCefLayoutChar("fr", "KeyA", shifted), null);

  const dropped = translateCefLayoutKey(
    { code: "F13", layout: "de", modifiers: shifted },
    pendingAcute.state,
  );
  assert.equal(dropped.char, null);
  assert.deepEqual(dropped.state, pendingAcute.state);
});

test("switching keyboard.layout changes output for the same DOM code", () => {
  const code = "KeyZ";

  assert.equal(resolveCefLayoutChar("us", code, emptyModifiers), "z");
  assert.equal(resolveCefLayoutChar("de", code, emptyModifiers), "y");
  assert.notEqual(
    resolveCefLayoutChar("us", code, emptyModifiers),
    resolveCefLayoutChar("de", code, emptyModifiers),
  );
});

test("layout translation is pure and byte-identical for repeated inputs", () => {
  const first = translateCefLayoutKey({
    code: "Digit7",
    layout: "de",
    modifiers: altgr,
  });
  const second = translateCefLayoutKey({
    code: "Digit7",
    layout: "de",
    modifiers: altgr,
  });

  assert.deepEqual(first, second);
  assert.equal(JSON.stringify(first), JSON.stringify(second));
  assert.ok(CEF_DEAD_KEY_COMPOSE_ENTRIES.some((entry) => entry.composed === "é"));
});

function applyKnown(
  layout: "us" | "de",
  code: string,
  modifiers: CefLayoutModifierState,
  state: CefLayoutComposeState = createCefLayoutComposeState(),
): CefLayoutTranslationResult {
  return translateCefLayoutKey({ code, layout, modifiers }, state);
}
