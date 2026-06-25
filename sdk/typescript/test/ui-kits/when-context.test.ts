import assert from "node:assert/strict";
import { test } from "node:test";

import {
  evaluateWhenContext,
  resolveScoped,
} from "../../../../ui_kits/desktop/viewmodels/shortcuts.ts";
import type {
  ScopedShortcutBinding,
  WhenContext,
} from "../../../../ui_kits/desktop/viewmodels/shortcuts.ts";

const FILES_CONTEXT: WhenContext = Object.freeze({
  editable: false,
  focusedApp: "vita.app.files",
  modal: false,
  surface: "files",
});

const EDITOR_MODAL_CONTEXT: WhenContext = Object.freeze({
  editable: true,
  focusedApp: "vita.app.editor",
  modal: true,
  surface: "editor",
});

function expectTrue(expression: string, context: WhenContext): void {
  const result = evaluateWhenContext(expression, context);

  assert.equal(result.ok, true, `expected '${expression}' to evaluate`);
  if (!result.ok) {
    assert.fail("evaluation failed");
  }
  assert.equal(result.value, true, `expected '${expression}' to be true`);
}

function expectFalse(expression: string, context: WhenContext): void {
  const result = evaluateWhenContext(expression, context);

  assert.equal(result.ok, true, `expected '${expression}' to evaluate`);
  if (!result.ok) {
    assert.fail("evaluation failed");
  }
  assert.equal(result.value, false, `expected '${expression}' to be false`);
}

function expectInvalidWhen(expression: unknown): void {
  const result = evaluateWhenContext(expression, FILES_CONTEXT);

  assert.equal(result.ok, false, `expected '${String(expression)}' to fail closed`);
  if (result.ok) {
    assert.fail("expected INVALID_WHEN");
  }
  assert.equal(result.error.code, "INVALID_WHEN");
}

test("equality on focusedApp and surface respects quoted and bare values", () => {
  expectTrue('focusedApp == "vita.app.files"', FILES_CONTEXT);
  expectFalse('focusedApp == "vita.app.editor"', FILES_CONTEXT);
  expectTrue("surface == files", FILES_CONTEXT);
  expectFalse("surface == editor", FILES_CONTEXT);
  expectTrue("surface == 'files'", FILES_CONTEXT);
});

test("boolean flags modal and editable read straight from the context snapshot", () => {
  expectFalse("modal", FILES_CONTEXT);
  expectFalse("editable", FILES_CONTEXT);
  expectTrue("modal", EDITOR_MODAL_CONTEXT);
  expectTrue("editable", EDITOR_MODAL_CONTEXT);
});

test("operator truth table — && / || / ! / parens", () => {
  // && : both sides
  expectTrue("surface == files && !modal", FILES_CONTEXT);
  expectFalse("surface == files && modal", FILES_CONTEXT);

  // || : either side
  expectTrue("surface == editor || surface == files", FILES_CONTEXT);
  expectFalse("surface == editor || modal", FILES_CONTEXT);

  // ! : negation
  expectTrue("!modal", FILES_CONTEXT);
  expectFalse("!editable", EDITOR_MODAL_CONTEXT);
  expectTrue("!!editable", EDITOR_MODAL_CONTEXT);

  // parens change precedence: && binds tighter than ||, parens override.
  // modal || (surface==files && editable) => false || (true && false) => false
  expectFalse("modal || surface == files && editable", FILES_CONTEXT);
  expectFalse("(modal || surface == files) && editable", FILES_CONTEXT);
  expectTrue("(modal || surface == files) && !editable", FILES_CONTEXT);
  expectTrue("editable && (modal || surface == editor)", EDITOR_MODAL_CONTEXT);
});

test("&& has higher precedence than || (un-parenthesized)", () => {
  // false || (true && false) => false
  expectFalse("modal || editable && modal", FILES_CONTEXT);
  // (false && true) || true  via precedence => false || true => true
  expectTrue("modal && editable || surface == files", FILES_CONTEXT);
});

test("absent string fields compare as the empty string; absent flags as false", () => {
  const sparse: WhenContext = Object.freeze({ focusedApp: "vita.app.files" });

  expectTrue('focusedApp == "vita.app.files"', sparse);
  expectTrue('surface == ""', sparse);
  expectFalse("modal", sparse);
  expectFalse("editable", sparse);
});

test("malformed when expressions fail closed with INVALID_WHEN and never throw", () => {
  expectInvalidWhen("surface ==");        // dangling operator
  expectInvalidWhen("surface = files");   // single '=' not allowed
  expectInvalidWhen("surface == files &&"); // trailing &&
  expectInvalidWhen("&& surface == files"); // leading &&
  expectInvalidWhen("(surface == files"); // unbalanced paren
  expectInvalidWhen("surface == files)"); // extra close paren
  expectInvalidWhen("surface == files |");  // single pipe
  expectInvalidWhen("");                    // empty expression
  expectInvalidWhen("   ");                 // whitespace-only
  expectInvalidWhen("modal modal");         // adjacent primaries
  expectInvalidWhen('focusedApp == "unterminated'); // unterminated string
  expectInvalidWhen(123);                   // non-string expression
  expectInvalidWhen(null);                  // non-string expression
});

test("unknown identifiers fail closed with INVALID_WHEN", () => {
  expectInvalidWhen("unknownFlag");
  expectInvalidWhen("focused == files");          // focused is not an identifier
  expectInvalidWhen('title == "x"');               // title not in grammar
  expectInvalidWhen("modal == true");              // modal is a flag, not an equality target
  expectInvalidWhen('modal == "true"');            // same — flags cannot be compared
});

test("non-plain-object context fails closed with INVALID_CONTEXT, never throws", () => {
  const cases: readonly unknown[] = [null, 42, "files", [], true, Object.create({ surface: "files" })];

  for (const badContext of cases) {
    const result = evaluateWhenContext("modal", badContext);

    assert.equal(result.ok, false);
    if (result.ok) {
      assert.fail("expected INVALID_CONTEXT");
    }
    assert.equal(result.error.code, "INVALID_CONTEXT");
  }
});

test("context with an unsupported / wrongly-typed field fails closed with INVALID_CONTEXT", () => {
  const unsupported = evaluateWhenContext("modal", { surface: "files", extra: 1 });
  const wrongType = evaluateWhenContext("modal", { modal: "yes" });

  assert.equal(unsupported.ok, false);
  if (unsupported.ok) {
    assert.fail("expected INVALID_CONTEXT for unsupported field");
  }
  assert.equal(unsupported.error.code, "INVALID_CONTEXT");

  assert.equal(wrongType.ok, false);
  if (wrongType.ok) {
    assert.fail("expected INVALID_CONTEXT for wrong-typed flag");
  }
  assert.equal(wrongType.error.code, "INVALID_CONTEXT");
});

test("the evaluator never invokes context accessors (hostile getter is never read)", () => {
  let reads = 0;
  const hostile: Record<string, unknown> = {};

  Object.defineProperty(hostile, "surface", {
    enumerable: true,
    get() {
      reads += 1;
      return "files";
    },
  });

  const result = evaluateWhenContext("surface == files", hostile);

  // snapshotObject rejects accessor-backed fields up front: fail closed, no read.
  assert.equal(result.ok, false);
  if (result.ok) {
    assert.fail("expected accessor context to fail closed");
  }
  assert.equal(result.error.code, "INVALID_CONTEXT");
  assert.equal(reads, 0);
});

// --- resolveScoped ---------------------------------------------------------

const SCOPED_BINDINGS: readonly ScopedShortcutBinding[] = Object.freeze([
  Object.freeze({ chord: "Control+K", commandId: "files.search", when: 'focusedApp == "vita.app.files"' }),
  Object.freeze({ chord: "Control+K", commandId: "editor.command", when: "surface == editor && editable" }),
  Object.freeze({ chord: "Control+K", commandId: "global.command-palette" }),
]);

test("a scoped binding beats the global binding only when its when matches", () => {
  const inFiles = resolveScoped("ctrl+k", FILES_CONTEXT, SCOPED_BINDINGS);

  assert.equal(inFiles.ok, true);
  if (!inFiles.ok) {
    assert.fail("expected files-scoped resolution");
  }
  assert.equal(inFiles.scope, "scoped");
  assert.equal(inFiles.binding.commandId, "files.search");
  assert.equal(inFiles.binding.chord, "Control+K");

  const inEditor = resolveScoped("ctrl+k", EDITOR_MODAL_CONTEXT, SCOPED_BINDINGS);

  assert.equal(inEditor.ok, true);
  if (!inEditor.ok) {
    assert.fail("expected editor-scoped resolution");
  }
  assert.equal(inEditor.scope, "scoped");
  assert.equal(inEditor.binding.commandId, "editor.command");
});

test("the global (un-when'd) binding wins when no scoped when matches", () => {
  const elsewhere = resolveScoped("ctrl+k", Object.freeze({ focusedApp: "vita.app.terminal", surface: "terminal" }), SCOPED_BINDINGS);

  assert.equal(elsewhere.ok, true);
  if (!elsewhere.ok) {
    assert.fail("expected global fallback");
  }
  assert.equal(elsewhere.scope, "global");
  assert.equal(elsewhere.binding.commandId, "global.command-palette");
  assert.equal(elsewhere.binding.when, undefined);
});

test("the most-specific (earliest) matching scoped binding wins on overlap", () => {
  const overlapping: readonly ScopedShortcutBinding[] = Object.freeze([
    Object.freeze({ chord: "Control+J", commandId: "specific", when: 'focusedApp == "vita.app.files" && surface == files' }),
    Object.freeze({ chord: "Control+J", commandId: "broad", when: "surface == files" }),
    Object.freeze({ chord: "Control+J", commandId: "fallback" }),
  ]);

  const resolved = resolveScoped("ctrl+j", FILES_CONTEXT, overlapping);

  assert.equal(resolved.ok, true);
  if (!resolved.ok) {
    assert.fail("expected resolution");
  }
  assert.equal(resolved.scope, "scoped");
  assert.equal(resolved.binding.commandId, "specific");
});

test("resolveScoped returns UNBOUND_CHORD when neither scoped nor global match", () => {
  const onlyScoped: readonly ScopedShortcutBinding[] = Object.freeze([
    Object.freeze({ chord: "Control+K", commandId: "files.search", when: "surface == files" }),
  ]);

  const result = resolveScoped("ctrl+k", Object.freeze({ surface: "editor" }), onlyScoped);

  assert.equal(result.ok, false);
  if (result.ok) {
    assert.fail("expected unbound chord");
  }
  assert.equal(result.error.code, "UNBOUND_CHORD");

  const noBinding = resolveScoped("ctrl+z", FILES_CONTEXT, SCOPED_BINDINGS);

  assert.equal(noBinding.ok, false);
  if (noBinding.ok) {
    assert.fail("expected unbound chord for unbound chord");
  }
  assert.equal(noBinding.error.code, "UNBOUND_CHORD");
});

test("a scoped binding whose when fails closed is never selected by accident", () => {
  const malformed: readonly ScopedShortcutBinding[] = Object.freeze([
    Object.freeze({ chord: "Control+K", commandId: "bad.scope", when: "surface ==" }),       // malformed
    Object.freeze({ chord: "Control+K", commandId: "unknown.scope", when: "mysteryFlag" }),   // unknown id
    Object.freeze({ chord: "Control+K", commandId: "global.command-palette" }),               // global fallback
  ]);

  const result = resolveScoped("ctrl+k", FILES_CONTEXT, malformed);

  assert.equal(result.ok, true);
  if (!result.ok) {
    assert.fail("expected to fall through to the global binding");
  }
  assert.equal(result.scope, "global");
  assert.equal(result.binding.commandId, "global.command-palette");
});

test("resolveScoped fails closed on a non-plain-object context (INVALID_CONTEXT) before matching", () => {
  const result = resolveScoped("ctrl+k", 5, SCOPED_BINDINGS);

  assert.equal(result.ok, false);
  if (result.ok) {
    assert.fail("expected INVALID_CONTEXT");
  }
  assert.equal(result.error.code, "INVALID_CONTEXT");
});

test("resolveScoped fails closed on an invalid chord (INVALID_CHORD)", () => {
  const result = resolveScoped("Control+", FILES_CONTEXT, SCOPED_BINDINGS);

  assert.equal(result.ok, false);
  if (result.ok) {
    assert.fail("expected INVALID_CHORD");
  }
  assert.equal(result.error.code, "INVALID_CHORD");
});

test("resolveScoped results and bindings are frozen", () => {
  const result = resolveScoped("ctrl+k", FILES_CONTEXT, SCOPED_BINDINGS);

  assert.equal(result.ok, true);
  if (!result.ok) {
    assert.fail("expected resolution");
  }
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result.binding), true);
});
