import assert from "node:assert/strict";
import { test } from "node:test";

import {
  DEFAULT_KEYBOARD_COMMANDS,
  DEFAULT_KEYMAP_PROFILES,
  KEYBOARD_SETTINGS_CATEGORY,
  KEYBOARD_SETTINGS_KEYS,
  createKeyboardSettingsViewModel,
} from "../../../../ui_kits/desktop/viewmodels/keyboard-settings.ts";
import type {
  KeyboardCommandDescriptor,
  KeyboardSettingsControlPlanePort,
} from "../../../../ui_kits/desktop/viewmodels/keyboard-settings.ts";
import type {
  DesktopCapabilityGrant,
  DesktopUiPackageManifest,
  SettingsApplyIntent,
  SettingsControlPlaneIntent,
  SettingsControlPlaneResult,
  SettingsPreviewIntent,
} from "../../src/desktop-sdk/index.ts";

const COMMANDS: readonly KeyboardCommandDescriptor[] = Object.freeze([
  Object.freeze({ category: "window-management", commandId: "wm.tile", label: "Tile Window" }),
  Object.freeze({ category: "window-management", commandId: "wm.close", label: "Close Window" }),
  Object.freeze({ category: "navigation", commandId: "nav.next", label: "Next Workspace" }),
  Object.freeze({ category: "app", commandId: "app.settings", label: "Open Settings" }),
  Object.freeze({ category: "global", commandId: "global.search", label: "Global Search" }),
]);

const DEFAULTS = Object.freeze([
  Object.freeze({ chord: "Ctrl+T", commandId: "wm.tile" }),
  Object.freeze({ chord: "Ctrl+W", commandId: "wm.close" }),
  Object.freeze({ chord: "Ctrl+Tab", commandId: "nav.next" }),
  Object.freeze({ chord: "Ctrl+Comma", commandId: "app.settings" }),
  Object.freeze({ chord: "Ctrl+Shift+Space", commandId: "global.search" }),
]);

test("keyboard-settings groups bindings by category in deterministic order", () => {
  const port = recordingPort();
  const vm = createKeyboardSettingsViewModel({
    commands: COMMANDS,
    defaults: DEFAULTS,
    manifest: manifest([grant("settings.write")]),
    port: port.port,
  });
  const snapshot = vm.snapshot();

  assert.deepEqual(
    snapshot.groups.map((group) => [group.category, group.shortcuts.map((entry) => entry.commandId)]),
    [
      ["window-management", ["wm.close", "wm.tile"]],
      ["navigation", ["nav.next"]],
      ["app", ["app.settings"]],
      ["global", ["global.search"]],
    ],
  );
  assert.deepEqual(
    snapshot.shortcuts.map((entry) => [entry.commandId, entry.chord, entry.isUserOverride, entry.label, entry.category]),
    [
      ["wm.close", "Control+W", false, "Close Window", "window-management"],
      ["wm.tile", "Control+T", false, "Tile Window", "window-management"],
      ["nav.next", "Control+Tab", false, "Next Workspace", "navigation"],
      ["app.settings", "Control+Comma", false, "Open Settings", "app"],
      ["global.search", "Control+Shift+Space", false, "Global Search", "global"],
    ],
  );
  assert.deepEqual(snapshot.conflicts, []);
  assert.equal(snapshot.activeProfileId, "default");
  assert.deepEqual(snapshot.profiles, DEFAULT_KEYMAP_PROFILES);
  assert.equal(snapshot.editing.capturingCommandId, null);
  assert.equal(snapshot.editing.pendingPreview, false);
  assert.equal(Object.isFrozen(snapshot), true);
  assert.equal(Object.isFrozen(snapshot.groups), true);
  assert.equal(Object.isFrozen(snapshot.shortcuts), true);
  assert.deepEqual(port.events, []);
  assert.equal(DEFAULT_KEYBOARD_COMMANDS.length, 4);
});

test("search filters shortcuts by label, command id, chord, and category", () => {
  const vm = build();

  assert.deepEqual(vm.search("window").map((entry) => entry.commandId), ["wm.close", "wm.tile"]);
  assert.deepEqual(vm.search("nav.").map((entry) => entry.commandId), ["nav.next"]);
  assert.deepEqual(vm.search("control+comma").map((entry) => entry.commandId), ["app.settings"]);
  assert.deepEqual(vm.search("global").map((entry) => entry.commandId), ["global.search"]);
  assert.equal(vm.search("").length, vm.list().length);
  assert.deepEqual(vm.search("no-such-thing"), []);
});

test("beginCapture/cancelCapture transition the editing state and validate the command", () => {
  const vm = build();

  const begun = vm.beginCapture("wm.tile");

  assert.equal(begun.ok, true);
  if (!begun.ok) assert.fail("expected capture to begin");
  assert.equal(begun.state.editing.capturingCommandId, "wm.tile");
  assert.equal(begun.state.editing.pendingPreview, false);
  assert.equal(vm.snapshot().editing.capturingCommandId, "wm.tile");

  const cancelled = vm.cancelCapture();

  assert.equal(cancelled.ok, true);
  if (!cancelled.ok) assert.fail("expected capture to cancel");
  assert.equal(cancelled.state.editing.capturingCommandId, null);

  const unknown = vm.beginCapture("does.not.exist");

  assert.equal(unknown.ok, false);
  if (unknown.ok) assert.fail("expected unknown command to fail closed");
  assert.equal(unknown.error.code, "UNKNOWN_COMMAND");
  assert.equal(vm.snapshot().editing.capturingCommandId, null);
});

test("applyCapture round-trips capture -> preview -> apply and persists overrides via serialize()", async () => {
  const port = recordingPort();
  const vm = createKeyboardSettingsViewModel({
    commands: COMMANDS,
    defaults: DEFAULTS,
    manifest: manifest([grant("settings.write")]),
    port: port.port,
  });

  vm.beginCapture("wm.tile");
  const applied = await vm.applyCapture("Alt+Shift+T");

  assert.equal(applied.ok, true);
  if (!applied.ok) assert.fail("expected applyCapture to commit");

  const tile = applied.state.shortcuts.find((entry) => entry.commandId === "wm.tile");

  assert.equal(tile?.chord, "Alt+Shift+T");
  assert.equal(tile?.isUserOverride, true);
  assert.equal(applied.state.editing.capturingCommandId, null);
  assert.equal(applied.state.editing.pendingPreview, false);

  // preview THEN apply, in order, both for the overrides key, with the serialized blob as value.
  assert.deepEqual(port.events.map((event) => [event.type, event.settingId]), [
    ["control-plane.preview", KEYBOARD_SETTINGS_KEYS.overrides],
    ["control-plane.apply", KEYBOARD_SETTINGS_KEYS.overrides],
  ]);
  const applyEvent = port.events[1];

  assert.ok(applyEvent !== undefined);
  assert.equal(applyEvent.categoryId, KEYBOARD_SETTINGS_CATEGORY);
  assert.deepEqual(JSON.parse(applyEvent.value), [{ chord: "Alt+Shift+T", commandId: "wm.tile" }]);
});

test("applyCapture surfaces INVALID_CHORD and INVALID_KEY_EVENT without committing", async () => {
  const port = recordingPort();
  const vm = createKeyboardSettingsViewModel({
    commands: COMMANDS,
    defaults: DEFAULTS,
    manifest: manifest([grant("settings.write")]),
    port: port.port,
  });
  const before = vm.snapshot();

  vm.beginCapture("wm.tile");
  const invalidChord = await vm.applyCapture("Control+");

  assert.equal(invalidChord.ok, false);
  if (invalidChord.ok) assert.fail("expected invalid chord to fail closed");
  assert.equal(invalidChord.error.code, "INVALID_CHORD");

  let reads = 0;
  const hostile: Record<string, unknown> = { ctrlKey: true };
  Object.defineProperty(hostile, "key", {
    enumerable: true,
    get() {
      reads += 1;
      return "p";
    },
  });
  const invalidEvent = await vm.applyCapture(hostile);

  assert.equal(invalidEvent.ok, false);
  if (invalidEvent.ok) assert.fail("expected accessor key event to fail closed");
  assert.equal(invalidEvent.error.code, "INVALID_KEY_EVENT");
  assert.equal(reads, 0, "must not invoke hostile accessors");
  // chord unchanged, still capturing, no control-plane traffic.
  assert.equal(vm.snapshot().shortcuts.find((entry) => entry.commandId === "wm.tile")?.chord, "Control+T");
  assert.deepEqual(before.shortcuts, vm.snapshot().shortcuts);
  assert.deepEqual(port.events, []);
});

test("applyCapture rejects a conflicting chord and leaves state unchanged (no commit)", async () => {
  const port = recordingPort();
  const vm = createKeyboardSettingsViewModel({
    commands: COMMANDS,
    defaults: DEFAULTS,
    manifest: manifest([grant("settings.write")]),
    port: port.port,
  });

  vm.beginCapture("wm.tile");
  const conflicting = await vm.applyCapture("Ctrl+W"); // already bound to wm.close

  assert.equal(conflicting.ok, false);
  if (conflicting.ok) assert.fail("expected conflict to fail closed");
  assert.equal(conflicting.error.code, "SHORTCUT_CONFLICT");
  assert.equal(conflicting.conflict?.chord, "Control+W");
  assert.deepEqual(conflicting.conflict?.commandIds, ["wm.close", "wm.tile"]);
  assert.equal(vm.snapshot().shortcuts.find((entry) => entry.commandId === "wm.tile")?.chord, "Control+T");
  assert.deepEqual(port.events, []);
});

test("reset(commandId) and resetAll() restore defaults through preview/apply", async () => {
  const port = recordingPort();
  const vm = createKeyboardSettingsViewModel({
    commands: COMMANDS,
    defaults: DEFAULTS,
    manifest: manifest([grant("settings.write")]),
    port: port.port,
  });

  vm.beginCapture("wm.tile");
  await vm.applyCapture("Alt+Shift+T");
  vm.beginCapture("nav.next");
  await vm.applyCapture("Alt+N");
  port.events.length = 0;

  const reset = await vm.reset("wm.tile");

  assert.equal(reset.ok, true);
  if (!reset.ok) assert.fail("expected reset to restore default");
  const tile = reset.state.shortcuts.find((entry) => entry.commandId === "wm.tile");
  assert.equal(tile?.chord, "Control+T");
  assert.equal(tile?.isUserOverride, false);
  assert.deepEqual(port.events.map((event) => event.type), ["control-plane.preview", "control-plane.apply"]);
  const afterResetOne = port.events[1];
  assert.ok(afterResetOne !== undefined);
  assert.deepEqual(JSON.parse(afterResetOne.value), [{ chord: "Alt+N", commandId: "nav.next" }]);

  port.events.length = 0;
  const resetAll = await vm.resetAll();

  assert.equal(resetAll.ok, true);
  if (!resetAll.ok) assert.fail("expected resetAll to clear overrides");
  assert.equal(resetAll.state.shortcuts.every((entry) => entry.isUserOverride === false), true);
  assert.equal(resetAll.state.shortcuts.find((entry) => entry.commandId === "nav.next")?.chord, "Control+Tab");
  assert.deepEqual(port.events.map((event) => event.type), ["control-plane.preview", "control-plane.apply"]);
  const afterResetAll = port.events[1];
  assert.ok(afterResetAll !== undefined);
  assert.deepEqual(JSON.parse(afterResetAll.value), []);

  const unknownReset = await vm.reset("does.not.exist");
  assert.equal(unknownReset.ok, false);
  if (unknownReset.ok) assert.fail("expected unknown reset to fail closed");
  assert.equal(unknownReset.error.code, "UNKNOWN_COMMAND");
});

test("selectKeymapProfile persists the active profile through preview/apply", async () => {
  const port = recordingPort();
  const vm = createKeyboardSettingsViewModel({
    commands: COMMANDS,
    defaults: DEFAULTS,
    manifest: manifest([grant("settings.write")]),
    port: port.port,
  });

  const selected = await vm.selectKeymapProfile("vim");

  assert.equal(selected.ok, true);
  if (!selected.ok) assert.fail("expected profile selection to persist");
  assert.equal(selected.state.activeProfileId, "vim");
  assert.deepEqual(port.events.map((event) => [event.type, event.settingId, event.value]), [
    ["control-plane.preview", KEYBOARD_SETTINGS_KEYS.profile, "vim"],
    ["control-plane.apply", KEYBOARD_SETTINGS_KEYS.profile, "vim"],
  ]);

  const unknown = await vm.selectKeymapProfile("dvorak");

  assert.equal(unknown.ok, false);
  if (unknown.ok) assert.fail("expected unknown profile to fail closed");
  assert.equal(unknown.error.code, "UNKNOWN_KEYMAP_PROFILE");
  assert.equal(vm.snapshot().activeProfileId, "vim");
});

test("mutating actions fail closed without the settings.write grant and leave state unchanged", async () => {
  const port = recordingPort();
  const vm = createKeyboardSettingsViewModel({
    commands: COMMANDS,
    defaults: DEFAULTS,
    manifest: manifest([grant("settings.read")]),
    port: port.port,
  });
  const before = vm.snapshot();

  vm.beginCapture("wm.tile");
  const captured = await vm.applyCapture("Alt+Shift+T");
  const reset = await vm.reset("wm.tile");
  const resetAll = await vm.resetAll();
  const profile = await vm.selectKeymapProfile("vim");

  for (const result of [captured, reset, resetAll, profile]) {
    assert.equal(result.ok, false);
    if (result.ok) assert.fail("expected missing grant to fail closed");
    assert.equal(result.error.code, "MISSING_CAPABILITY");
  }
  assert.deepEqual(before.shortcuts, vm.snapshot().shortcuts);
  assert.equal(vm.snapshot().activeProfileId, "default");
  assert.deepEqual(port.events, []);
});

test("an absent settings control-plane port fails closed without committing", async () => {
  const vm = createKeyboardSettingsViewModel({
    commands: COMMANDS,
    defaults: DEFAULTS,
    manifest: manifest([grant("settings.write")]),
    port: absentPort(),
  });
  const before = vm.snapshot();

  vm.beginCapture("wm.tile");
  const captured = await vm.applyCapture("Alt+Shift+T");

  assert.equal(captured.ok, false);
  if (captured.ok) assert.fail("expected absent port to fail closed");
  assert.equal(captured.error.code, "CONTROL_PLANE_FAILED");
  assert.equal(captured.state.editing.pendingPreview, false);
  assert.equal(vm.snapshot().shortcuts.find((entry) => entry.commandId === "wm.tile")?.chord, "Control+T");
  assert.deepEqual(before.shortcuts, vm.snapshot().shortcuts);
});

test("a rejected preview never reaches apply (reversible, no partial commit)", async () => {
  const port = recordingPort({ rejectPreview: true });
  const vm = createKeyboardSettingsViewModel({
    commands: COMMANDS,
    defaults: DEFAULTS,
    manifest: manifest([grant("settings.write")]),
    port: port.port,
  });

  vm.beginCapture("wm.tile");
  const captured = await vm.applyCapture("Alt+Shift+T");

  assert.equal(captured.ok, false);
  if (captured.ok) assert.fail("expected preview rejection to fail closed");
  assert.equal(captured.error.code, "PREVIEW_REJECTED");
  assert.deepEqual(port.events.map((event) => event.type), ["control-plane.preview"]);
  assert.equal(vm.snapshot().shortcuts.find((entry) => entry.commandId === "wm.tile")?.chord, "Control+T");
  assert.equal(vm.snapshot().editing.pendingPreview, false);
});

interface PortEvent {
  readonly type: SettingsControlPlaneIntent["type"];
  readonly settingId: string;
  readonly categoryId: string;
  readonly value: string;
}

interface RecordingPort {
  readonly port: KeyboardSettingsControlPlanePort;
  readonly events: PortEvent[];
}

function recordingPort(options: { readonly rejectPreview?: boolean } = {}): RecordingPort {
  const events: PortEvent[] = [];
  const record = (intent: SettingsPreviewIntent | SettingsApplyIntent): void => {
    events.push(Object.freeze({
      categoryId: intent.edit.categoryId,
      settingId: intent.edit.settingId,
      type: intent.type,
      value: String(intent.edit.value),
    }));
  };
  const port: KeyboardSettingsControlPlanePort = Object.freeze({
    apply(intent: SettingsApplyIntent): SettingsControlPlaneResult {
      record(intent);

      return { ok: true, value: Object.freeze({ stage: "apply" }) };
    },
    preview(intent: SettingsPreviewIntent): SettingsControlPlaneResult {
      record(intent);

      if (options.rejectPreview === true) {
        return {
          error: { code: "PREVIEW_REJECTED", message: "preview rejected by fake port.", path: "/preview" },
          ok: false,
        };
      }

      return { ok: true, value: Object.freeze({ stage: "preview" }) };
    },
  });

  return { events, port };
}

function absentPort(): KeyboardSettingsControlPlanePort {
  return Object.freeze({
    apply(): SettingsControlPlaneResult {
      throw new Error("settings control-plane port is unavailable");
    },
    preview(): SettingsControlPlaneResult {
      throw new Error("settings control-plane port is unavailable");
    },
  });
}

function build(): ReturnType<typeof createKeyboardSettingsViewModel> {
  return createKeyboardSettingsViewModel({
    commands: COMMANDS,
    defaults: DEFAULTS,
    manifest: manifest([grant("settings.write")]),
    port: recordingPort().port,
  });
}

function manifest(grants: readonly DesktopCapabilityGrant[]): DesktopUiPackageManifest {
  return Object.freeze({
    capabilityGrants: Object.freeze([...grants]),
    entry: "./keyboard-settings.test.ts",
    id: "ui.keyboard-settings.test",
    sdkVersion: "1.0.0",
    version: "1.0.0",
  });
}

function grant(capability: DesktopCapabilityGrant["capability"], resourceId?: string): DesktopCapabilityGrant {
  const output: { capability: DesktopCapabilityGrant["capability"]; resourceId?: string } = {
    capability,
  };

  if (resourceId !== undefined) output.resourceId = resourceId;

  return Object.freeze(output);
}
