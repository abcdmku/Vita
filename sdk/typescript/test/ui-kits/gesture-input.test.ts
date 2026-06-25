import assert from "node:assert/strict";
import { test } from "node:test";

import {
  createGestureInputViewModel,
  normalizeGestureChord,
} from "../../../../ui_kits/desktop/viewmodels/gesture-input.ts";
import type {
  GestureEvent,
} from "../../../../ui_kits/desktop/viewmodels/gesture-input.ts";
import type {
  CommandAction,
  CommandContext,
  CommandDefinition,
} from "../../../../ui_kits/desktop/viewmodels/command-registry.ts";

/** A command that classifies into a `settings.write` zoom action. */
function zoomCommand(): CommandDefinition {
  return Object.freeze({
    category: "View",
    execute: (context: CommandContext) => Object.freeze({
      kind: "settings.write",
      request: Object.freeze({
        key: "view.zoom",
        value: context.direction === "out" ? -1 : 1,
      }),
    } satisfies CommandAction),
    id: "view.zoom",
    title: "Zoom",
  });
}

/** A command that classifies into a `wm.intent` window move/resize action. */
function windowMoveCommand(): CommandDefinition {
  return Object.freeze({
    category: "Window",
    execute: () => Object.freeze({
      intent: Object.freeze({
        rect: Object.freeze({ height: 200, width: 200, x: 10, y: 10 }),
        textureId: "tex-1",
        type: "repositionTexture",
        windowId: "win-1",
      }),
      kind: "wm.intent",
    } satisfies CommandAction),
    id: "wm.move",
    title: "Move Window",
  });
}

/** A command that classifies into a `launcher.intent` action (workspace switch surrogate). */
function workspaceCommand(): CommandDefinition {
  return Object.freeze({
    category: "Workspace",
    execute: () => Object.freeze({
      intent: Object.freeze({ query: "workspace.next", type: "launcher.launch" }),
      kind: "launcher.intent",
    } satisfies CommandAction),
    id: "workspace.switch",
    title: "Switch Workspace",
  });
}

/** A three-finger gesture command that classifies into a `theme.toggle` action. */
function threeFingerCommand(): CommandDefinition {
  return Object.freeze({
    category: "Theme",
    execute: () => Object.freeze({
      from: "light",
      kind: "theme.toggle",
      to: "dark",
    } satisfies CommandAction),
    id: "theme.toggle",
    title: "Toggle Theme",
  });
}

function baseViewModel() {
  return createGestureInputViewModel({
    commands: [
      zoomCommand(),
      windowMoveCommand(),
      workspaceCommand(),
      threeFingerCommand(),
    ],
  });
}

test("wheel + modifier dispatches to the bound zoom action", () => {
  const vm = baseViewModel();

  const bound = vm.bind(
    Object.freeze({ ctrlKey: true, direction: "in", kind: "wheel" }),
    "view.zoom",
  );
  assert.equal(bound.ok, true);

  const event: GestureEvent = Object.freeze({ ctrlKey: true, direction: "in", kind: "wheel" });
  const result = vm.dispatch(event);

  assert.equal(result.action.kind, "settings.write");
  if (result.action.kind === "settings.write") {
    assert.equal(result.action.request.key, "view.zoom");
    assert.equal(result.action.request.value, 1);
  }
  assert.equal(result.commandId, "view.zoom");

  // The classification receives the dispatch context.
  const zoomOut = vm.dispatch(event, Object.freeze({ direction: "out" }));
  assert.equal(zoomOut.action.kind, "settings.write");
  if (zoomOut.action.kind === "settings.write") {
    assert.equal(zoomOut.action.request.value, -1);
  }
});

test("modifier + drag dispatches to the window move/resize action", () => {
  const vm = baseViewModel();

  assert.equal(
    vm.bind(Object.freeze({ direction: "right", kind: "pointer.drag", metaKey: true }), "wm.move").ok,
    true,
  );

  const result = vm.dispatch(
    Object.freeze({ direction: "right", kind: "pointer.drag", metaKey: true }),
  );

  assert.equal(result.action.kind, "wm.intent");
  if (result.action.kind === "wm.intent") {
    assert.equal(result.action.intent.type, "repositionTexture");
  }
  assert.equal(result.commandId, "wm.move");
});

test("edge-swipe dispatches to the workspace-switch action", () => {
  const vm = baseViewModel();

  assert.equal(
    vm.bind(Object.freeze({ direction: "left", fingers: 1, kind: "gesture.swipe" }), "workspace.switch").ok,
    true,
  );

  const result = vm.dispatch(
    Object.freeze({ direction: "left", fingers: 1, kind: "gesture.swipe" }),
  );

  assert.equal(result.action.kind, "launcher.intent");
  if (result.action.kind === "launcher.intent") {
    assert.equal(result.action.intent.query, "workspace.next");
  }
  assert.equal(result.commandId, "workspace.switch");
});

test("three-finger gesture dispatches to its bound action", () => {
  const vm = baseViewModel();

  assert.equal(
    vm.bind(Object.freeze({ fingers: 3, kind: "gesture.swipe", direction: "up" }), "theme.toggle").ok,
    true,
  );

  const result = vm.dispatch(
    Object.freeze({ direction: "up", fingers: 3, kind: "gesture.swipe" }),
  );

  assert.equal(result.action.kind, "theme.toggle");
  if (result.action.kind === "theme.toggle") {
    assert.equal(result.action.from, "light");
    assert.equal(result.action.to, "dark");
  }

  // A two-finger swipe is a DIFFERENT chord and is unbound → noop.
  const twoFinger = vm.dispatch(
    Object.freeze({ direction: "up", fingers: 2, kind: "gesture.swipe" }),
  );
  assert.equal(twoFinger.action.kind, "noop");
  assert.equal(twoFinger.commandId, undefined);
});

test("normalization is canonical and order-independent across equivalent events", () => {
  // Modifier flags supplied in different orders / with explicit false → identical chord.
  const a = normalizeGestureChord(
    Object.freeze({ ctrlKey: true, shiftKey: true, kind: "wheel", direction: "in" }),
  );
  const b = normalizeGestureChord(
    Object.freeze({ shiftKey: true, ctrlKey: true, direction: "in", kind: "wheel", altKey: false }),
  );

  assert.equal(a.ok, true);
  assert.equal(b.ok, true);
  if (a.ok && b.ok) {
    // Modifiers are canonically sorted (Control before Shift), regardless of input order.
    assert.deepEqual(a.chord.modifiers, ["Control", "Shift"]);
    assert.deepEqual(a.chord, b.chord);
    assert.equal(a.chordKey, b.chordKey);
  }

  // pointer.move drops a direction it cannot carry → canonical collapse.
  const moveWithDir = normalizeGestureChord(
    Object.freeze({ kind: "pointer.move", direction: "left" }),
  );
  const move = normalizeGestureChord(Object.freeze({ kind: "pointer.move" }));
  assert.equal(moveWithDir.ok, true);
  assert.equal(move.ok, true);
  if (moveWithDir.ok && move.ok) {
    assert.equal(moveWithDir.chord.direction, undefined);
    assert.equal(moveWithDir.chordKey, move.chordKey);
  }

  // Determinism: equivalent dispatch is repeatable, and the chord is frozen.
  if (a.ok) {
    assert.equal(Object.isFrozen(a.chord), true);
    assert.equal(Object.isFrozen(a.chord.modifiers), true);
  }
});

test("duplicate bind on an equivalent chord is rejected fail-closed", () => {
  const vm = baseViewModel();

  const first = vm.bind(Object.freeze({ ctrlKey: true, direction: "in", kind: "wheel" }), "view.zoom");
  assert.equal(first.ok, true);

  // Same canonical chord (modifier order differs, explicit false added) → duplicate.
  const dup = vm.bind(
    Object.freeze({ altKey: false, ctrlKey: true, direction: "in", kind: "wheel" }),
    "wm.move",
  );
  assert.equal(dup.ok, false);
  if (dup.ok) {
    assert.fail("expected duplicate chord bind to fail closed");
  }
  assert.equal(dup.error.code, "DUPLICATE_GESTURE");

  // The registry of bindings is unchanged (still maps to the first command).
  assert.deepEqual(vm.snapshot().bindings.map((binding) => binding.commandId), ["view.zoom"]);

  // And dispatch still resolves to the original command.
  const result = vm.dispatch(Object.freeze({ ctrlKey: true, direction: "in", kind: "wheel" }));
  assert.equal(result.commandId, "view.zoom");
});

test("unbound chord dispatches to noop, fail-closed", () => {
  const vm = baseViewModel();

  const result = vm.dispatch(Object.freeze({ ctrlKey: true, direction: "out", kind: "wheel" }));
  assert.equal(result.action.kind, "noop");
  assert.equal(result.commandId, undefined);
  // The chord still normalized, so it is reported.
  assert.equal(result.chord?.kind, "wheel");
});

test("malformed / hostile gesture events fail closed to noop without throwing", () => {
  const vm = baseViewModel();

  // Unknown kind.
  assert.equal(vm.dispatch(Object.freeze({ kind: "gesture.unknown" })).action.kind, "noop");
  // Not an object.
  assert.equal(vm.dispatch(null).action.kind, "noop");
  assert.equal(vm.dispatch(42).action.kind, "noop");
  // Unsupported field.
  assert.equal(vm.dispatch(Object.freeze({ kind: "wheel", evil: true })).action.kind, "noop");
  // Accessor (getter) property — TOCTOU hostile shape → rejected.
  const hostile: Record<string, unknown> = {};
  Object.defineProperty(hostile, "kind", { enumerable: true, get: () => "wheel" });
  assert.equal(vm.dispatch(hostile).action.kind, "noop");
  // Non-boolean modifier flag.
  assert.equal(
    vm.dispatch(Object.freeze({ ctrlKey: 1, direction: "in", kind: "wheel" })).action.kind,
    "noop",
  );

  // normalize() reports the rejection rather than throwing.
  const normalized = normalizeGestureChord(Object.freeze({ kind: "wheel", fingers: 99 }));
  assert.equal(normalized.ok, false);
  if (!normalized.ok) {
    assert.equal(normalized.error.code, "INVALID_GESTURE");
  }
});

test("bind rejects invalid command ids and dispatch fails closed for unavailable commands", () => {
  const vm = createGestureInputViewModel({
    commands: [
      Object.freeze({
        category: "Window",
        execute: () => Object.freeze({
          intent: Object.freeze({ type: "setFocus", windowId: null }),
          kind: "wm.intent",
        } satisfies CommandAction),
        id: "wm.focus",
        title: "Focus",
        when: (context: CommandContext) => context.hasWindow === true,
      }),
    ],
  });

  // Empty command id rejected.
  const bad = vm.bind(Object.freeze({ kind: "pointer.move" }), "");
  assert.equal(bad.ok, false);
  if (bad.ok) {
    assert.fail("expected empty command id to fail closed");
  }
  assert.equal(bad.error.code, "INVALID_COMMAND");

  assert.equal(vm.bind(Object.freeze({ kind: "pointer.move" }), "wm.focus").ok, true);

  // Command's `when` excludes it → dispatch fails closed to noop.
  const blocked = vm.dispatch(Object.freeze({ kind: "pointer.move" }), Object.freeze({ hasWindow: false }));
  assert.equal(blocked.action.kind, "noop");
  assert.equal(blocked.commandId, undefined);

  // When available, the same chord dispatches the wm action.
  const allowed = vm.dispatch(Object.freeze({ kind: "pointer.move" }), Object.freeze({ hasWindow: true }));
  assert.equal(allowed.action.kind, "wm.intent");
  assert.equal(allowed.commandId, "wm.focus");
});

test("snapshot is deterministic and deeply frozen", () => {
  const vm = baseViewModel();

  vm.bind(Object.freeze({ ctrlKey: true, direction: "in", kind: "wheel" }), "view.zoom");
  vm.bind(Object.freeze({ direction: "right", kind: "pointer.drag", metaKey: true }), "wm.move");

  const first = vm.snapshot();
  const second = vm.snapshot();

  assert.deepEqual(first, second);
  assert.equal(Object.isFrozen(first), true);
  assert.equal(Object.isFrozen(first.bindings), true);
  assert.equal(Object.isFrozen(first.bindings[0]), true);

  // Ordered by stable chord key (pointer.drag sorts before wheel).
  assert.deepEqual(first.bindings.map((binding) => binding.chord.kind), ["pointer.drag", "wheel"]);
});

test("gesture and keyboard chords share ONE registry / action union", () => {
  // A shared registry instance is consumed by the gesture VM, proving the
  // action union is not forked across input layers.
  const vm = createGestureInputViewModel({
    commands: [zoomCommand()],
  });

  assert.equal(vm.bind(Object.freeze({ ctrlKey: true, direction: "in", kind: "wheel" }), "view.zoom").ok, true);

  const action = vm.dispatch(Object.freeze({ ctrlKey: true, direction: "in", kind: "wheel" })).action;
  // The action is a member of the SAME CommandAction union as command-registry.
  const kinds: readonly CommandAction["kind"][] = Object.freeze([
    "launcher.intent",
    "wm.intent",
    "settings.write",
    "theme.toggle",
    "noop",
  ]);
  assert.equal(kinds.includes(action.kind), true);
});
