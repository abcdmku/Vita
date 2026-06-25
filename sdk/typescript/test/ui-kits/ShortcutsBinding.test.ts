import assert from "node:assert/strict";
import { test } from "node:test";

import {
  SHORTCUTS_BINDING_EVENT,
  createShortcutsBinding,
} from "../../../../ui_kits/desktop/runtime/shortcuts-binding.ts";
import type {
  ShortcutsBindingErrorSink,
} from "../../../../ui_kits/desktop/runtime/shortcuts-binding.ts";
import type {
  ShortcutCommandPort,
} from "../../../../ui_kits/desktop/viewmodels/shortcuts.ts";
import type {
  VitaElement,
  VitaElementList,
  VitaEventListener,
} from "../../../../ui_kits/desktop/runtime/binder.ts";
import type {
  DesktopCapability,
  DesktopCapabilityGrant,
  DesktopHostResult,
  DesktopLauncherIntent,
  DesktopUiPackageManifest,
} from "../../src/desktop-sdk/index.ts";

const DEFAULTS = Object.freeze([
  { chord: "Control+Space", commandId: "command.launcher" },
  { chord: "Escape", commandId: "command.close" },
  { chord: "K", commandId: "command.k" },
]);

const COMMANDS = Object.freeze([
  launchCommand("command.launcher", "Launcher", "vita.command.launcher", "launcher"),
  launchCommand("command.close", "Close", "vita.command.close", "close"),
  launchCommand("command.k", "K Command", "vita.command.k", "k"),
]);

test("a matched chord keydown dispatches the bound action through the view-model", async () => {
  const events: string[] = [];
  const root = new StubElement({ "data-vita-screen": "desktop/shortcuts" });
  const binding = createShortcutsBinding(root, fakePorts(events, [
    grant("launcher.launch", "vita.command.launcher"),
  ]), {
    registry: { commands: COMMANDS, defaults: DEFAULTS },
  });

  assert.equal(root.listenerCount(SHORTCUTS_BINDING_EVENT), 1, "exactly one delegated keydown listener");

  const target = new StubElement({}, "div");
  const event = root.dispatchKey({ ctrlKey: true, key: " ", target });

  await binding.whenIdle();

  assert.deepEqual(events, [
    "launcher:launcher.launch:vita.command.launcher:launcher",
  ], "the resolved launcher intent reached the injected port");
  assert.equal(event.defaultPrevented, true, "preventDefault was called on the matched chord");

  binding.dispose();
  assert.equal(root.listenerCount(SHORTCUTS_BINDING_EVENT), 0, "dispose removes the single listener");
});

test("single-key chords are suppressed on editable targets while modified chords still resolve", async () => {
  const events: string[] = [];
  const errors: string[] = [];
  const root = new StubElement({ "data-vita-screen": "desktop/shortcuts" });
  const binding = createShortcutsBinding(root, fakePorts(events, [
    grant("launcher.launch", "vita.command.k"),
    grant("launcher.launch", "vita.command.launcher"),
  ]), {
    onError: collectError(errors),
    registry: { commands: COMMANDS, defaults: DEFAULTS },
  });

  // Bare "K" while typing in an <input> => suppressed (no resolve, no preventDefault).
  const input = new StubElement({}, "input");
  const inputEvent = root.dispatchKey({ key: "k", target: input });
  await binding.whenIdle();

  assert.deepEqual(events, [], "bare single-key chord suppressed inside an input");
  assert.equal(inputEvent.defaultPrevented, false, "no preventDefault while typing a bare key");

  // Bare "K" while typing in a <textarea> => suppressed.
  const textarea = new StubElement({}, "textarea");
  const textareaEvent = root.dispatchKey({ key: "k", target: textarea });
  await binding.whenIdle();
  assert.deepEqual(events, [], "bare single-key chord suppressed inside a textarea");
  assert.equal(textareaEvent.defaultPrevented, false);

  // Bare "K" while contenteditable => suppressed.
  const editable = new StubElement({ contenteditable: "true" }, "div");
  const editableEvent = root.dispatchKey({ key: "k", target: editable });
  await binding.whenIdle();
  assert.deepEqual(events, [], "bare single-key chord suppressed inside contenteditable");
  assert.equal(editableEvent.defaultPrevented, false);

  // contenteditable="false" is NOT editable => bare "K" resolves.
  const notEditable = new StubElement({ contenteditable: "false" }, "div");
  const notEditableEvent = root.dispatchKey({ key: "k", target: notEditable });
  await binding.whenIdle();
  assert.deepEqual(events, [
    "launcher:launcher.launch:vita.command.k:k",
  ], "bare key resolves when contenteditable is false");
  assert.equal(notEditableEvent.defaultPrevented, true);

  // A MODIFIED chord still resolves even inside an editable target.
  const modifiedEvent = root.dispatchKey({ ctrlKey: true, key: " ", target: input });
  await binding.whenIdle();
  assert.deepEqual(events, [
    "launcher:launcher.launch:vita.command.k:k",
    "launcher:launcher.launch:vita.command.launcher:launcher",
  ], "modified chord still resolves inside an editable target");
  assert.equal(modifiedEvent.defaultPrevented, true);
  assert.deepEqual(errors, [], "no errors on the granted dispatches");

  binding.dispose();
});

test("preventDefault is called only on a matched chord, never on unmatched keys", async () => {
  const events: string[] = [];
  const root = new StubElement({ "data-vita-screen": "desktop/shortcuts" });
  const binding = createShortcutsBinding(root, fakePorts(events, [
    grant("launcher.launch", "vita.command.launcher"),
  ]), {
    registry: { commands: COMMANDS, defaults: DEFAULTS },
  });

  const target = new StubElement({}, "div");

  // Unbound key: no preventDefault, passes through.
  const unbound = root.dispatchKey({ key: "z", target });
  await binding.whenIdle();
  assert.equal(unbound.defaultPrevented, false, "unbound key is not prevented");
  assert.deepEqual(events, [], "unbound key does not dispatch");

  // Unbound modified chord: still no preventDefault.
  const unboundModified = root.dispatchKey({ altKey: true, key: "z", target });
  await binding.whenIdle();
  assert.equal(unboundModified.defaultPrevented, false, "unbound modified chord is not prevented");

  // A non-key event (no key/code) resolves to nothing => not prevented.
  const emptyEvent = root.dispatchKey({ target });
  await binding.whenIdle();
  assert.equal(emptyEvent.defaultPrevented, false, "an event without a key is not prevented");

  // Bound chord IS prevented.
  const bound = root.dispatchKey({ ctrlKey: true, key: " ", target });
  await binding.whenIdle();
  assert.equal(bound.defaultPrevented, true, "the bound chord is prevented");
  assert.deepEqual(events, [
    "launcher:launcher.launch:vita.command.launcher:launcher",
  ]);

  binding.dispose();
});

test("a fail-closed view-model dispatch routes its error to the error sink", async () => {
  const events: string[] = [];
  const errors: { code: string; path: string }[] = [];
  const root = new StubElement({ "data-vita-screen": "desktop/shortcuts" });
  const onError: ShortcutsBindingErrorSink = (error) => {
    errors.push({ code: error.code, path: error.path });
  };
  // No launcher.launch grant for command.launcher => dispatch returns { ok: false }.
  const binding = createShortcutsBinding(root, fakePorts(events), {
    onError,
    registry: { commands: COMMANDS, defaults: DEFAULTS },
  });

  const target = new StubElement({}, "div");
  const event = root.dispatchKey({ ctrlKey: true, key: " ", target });
  await binding.whenIdle();

  assert.deepEqual(events, [], "no launcher intent emitted without the capability");
  assert.equal(errors.length, 1, "exactly one error routed to the sink");
  assert.equal(errors[0]?.code, "MISSING_CAPABILITY", "the fail-closed VM error reached the sink");
  // It still matched a bound chord, so preventDefault fired before dispatch.
  assert.equal(event.defaultPrevented, true, "a matched chord is prevented even if dispatch fails");

  binding.dispose();
});

// --- helpers -----------------------------------------------------------------

function collectError(sink: string[]): ShortcutsBindingErrorSink {
  return (error) => {
    sink.push(error.code);
  };
}

function launchCommand(id: string, title: string, appId: string, query: string) {
  return Object.freeze({
    id,
    intent: Object.freeze({
      appId,
      query,
      type: "launcher.launch" as const,
    }),
    title,
  });
}

function fakePorts(
  events: string[],
  grants: readonly DesktopCapabilityGrant[] = Object.freeze([]),
): ShortcutCommandPort {
  return Object.freeze({
    emitLauncherIntent(intent: DesktopLauncherIntent): DesktopHostResult<true> {
      events.push(`launcher:${intent.type}:${intent.appId ?? ""}:${intent.query ?? ""}`);
      return { ok: true, value: true };
    },
    package: manifest(grants),
  });
}

function manifest(grants: readonly DesktopCapabilityGrant[]): DesktopUiPackageManifest {
  return Object.freeze({
    capabilityGrants: Object.freeze([...grants]),
    entry: "./ShortcutsBinding.test.ts",
    id: "ui.shortcuts.binding.test",
    sdkVersion: "1.0.0",
    version: "1.0.0",
  });
}

function grant(capability: DesktopCapability, resourceId?: string): DesktopCapabilityGrant {
  const output: { capability: DesktopCapability; resourceId?: string } = { capability };

  if (resourceId !== undefined) output.resourceId = resourceId;

  return Object.freeze(output);
}

interface KeyDispatch {
  readonly altKey?: boolean;
  readonly code?: string;
  readonly ctrlKey?: boolean;
  readonly key?: string;
  readonly metaKey?: boolean;
  readonly shiftKey?: boolean;
  readonly target: StubElement;
}

interface DispatchedEvent {
  readonly defaultPrevented: boolean;
}

/**
 * Minimal DOM stub: only the surface the binding reads (addEventListener /
 * removeEventListener, dataset, getAttribute, tagName). No jsdom, no real DOM.
 */
class StubElement implements VitaElement {
  readonly dataset: Record<string, string | undefined> = Object.create(null) as Record<string, string | undefined>;
  readonly classList = Object.freeze({
    toggle(): boolean {
      return false;
    },
  });

  readonly tagName: string;
  readonly #attributes = new Map<string, string>();
  readonly #listeners = new Map<string, VitaEventListener[]>();

  constructor(attrs: Readonly<Record<string, string>> = Object.freeze({}), tagName = "div") {
    this.tagName = tagName;

    const keys = Object.keys(attrs);

    for (let index = 0; index < keys.length; index += 1) {
      const key = keys[index];
      const value = key === undefined ? undefined : attrs[key];

      if (key !== undefined && value !== undefined) this.setAttribute(key, value);
    }
  }

  get textContent(): string {
    return "";
  }

  set textContent(_value: string | null) {
    // unused by the binding
  }

  querySelectorAll(_selector: string): VitaElementList {
    return Object.freeze([]) as unknown as VitaElementList;
  }

  closest(_selector: string): VitaElement | null {
    return null;
  }

  addEventListener(type: string, listener: VitaEventListener): void {
    let listeners = this.#listeners.get(type);

    if (listeners === undefined) {
      listeners = [];
      this.#listeners.set(type, listeners);
    }

    listeners.push(listener);
  }

  removeEventListener(type: string, listener: VitaEventListener): void {
    const listeners = this.#listeners.get(type);

    if (listeners === undefined) return;

    const index = listeners.indexOf(listener);

    if (index >= 0) listeners.splice(index, 1);
  }

  getAttribute(name: string): string | null {
    return this.#attributes.get(name) ?? null;
  }

  setAttribute(name: string, value: string): void {
    this.#attributes.set(name, value);

    if (name.startsWith("data-")) {
      this.dataset[datasetKey(name)] = value;
    }
  }

  cloneNode(): VitaElement {
    return new StubElement();
  }

  appendChild(child: VitaElement): VitaElement {
    return child;
  }

  removeChild(child: VitaElement): VitaElement {
    return child;
  }

  listenerCount(type: string): number {
    return this.#listeners.get(type)?.length ?? 0;
  }

  dispatchKey(spec: KeyDispatch): DispatchedEvent {
    let prevented = false;
    const event = Object.freeze({
      altKey: spec.altKey ?? false,
      code: spec.code,
      ctrlKey: spec.ctrlKey ?? false,
      key: spec.key,
      metaKey: spec.metaKey ?? false,
      preventDefault(): void {
        prevented = true;
      },
      shiftKey: spec.shiftKey ?? false,
      target: spec.target,
      type: SHORTCUTS_BINDING_EVENT,
    });
    const listeners = [...(this.#listeners.get(SHORTCUTS_BINDING_EVENT) ?? [])];

    for (let index = 0; index < listeners.length; index += 1) {
      listeners[index]?.(event);
    }

    return {
      get defaultPrevented(): boolean {
        return prevented;
      },
    };
  }
}

function datasetKey(name: string): string {
  const raw = name.slice("data-".length).toLowerCase();
  let output = "";

  for (let index = 0; index < raw.length; index += 1) {
    const char = raw[index];
    const next = raw[index + 1];

    if (char === "-" && next !== undefined && next >= "a" && next <= "z") {
      output += next.toUpperCase();
      index += 1;
    } else {
      output += char ?? "";
    }
  }

  return output;
}
