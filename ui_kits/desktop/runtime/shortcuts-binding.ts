import type {
  DesktopHost,
} from "../../../sdk/typescript/src/desktop-sdk/index.ts";
import type {
  VitaElement,
  VitaEventLike,
} from "./binder.ts";
import {
  createShortcutsViewModel,
} from "../viewmodels/shortcuts.ts";
import type {
  ShortcutCommandPort,
  ShortcutDispatchResult,
  ShortcutError,
  ShortcutKeyEvent,
  ShortcutRegistryOptions,
  ShortcutsViewModel,
} from "../viewmodels/shortcuts.ts";

/**
 * ADR-0013 per-screen hydration binding for global keyboard shortcuts.
 *
 * This is the *anchors* layer: it attaches a SINGLE delegated `keydown` listener
 * to the shortcuts screen root and drives the already-headless shortcuts
 * view-model (`viewmodels/shortcuts.ts`). It owns no chord/keymap logic of its
 * own — it normalizes the raw event into the VM's `ShortcutKeyEvent` shape,
 * asks the VM to `resolve` a bound action, and (only on a match) `dispatch`es
 * it through the VM. It is inert without a host bridge: with no granted launcher
 * capability the VM fails closed and the error is routed to the error sink.
 *
 * Pure / headless: it reads only the DOM-stub surface declared by
 * `VitaElement` + `VitaEventLike`; it never touches a real `window`/`document`.
 */

/** Port the binding consumes from the host to build the shortcuts view-model. */
export type ShortcutsBindingPort = ShortcutCommandPort;

/** Sink invoked when a resolved shortcut fails to dispatch through the VM. */
export type ShortcutsBindingErrorSink = (error: ShortcutError, result: ShortcutDispatchResult) => void;

/** Sink invoked with the active matched binding hint on a successful match. */
export type ShortcutsBindingActiveSink = (chord: string) => void;

export interface ShortcutsBindingOptions {
  /** Construction options forwarded to the shortcuts view-model. */
  readonly registry?: ShortcutRegistryOptions;
  /** Provide an already-built view-model instead of constructing one. */
  readonly viewModel?: ShortcutsViewModel;
  /** Routed a `{ ok: false }` dispatch result (never thrown, never swallowed). */
  readonly onError?: ShortcutsBindingErrorSink;
  /** Reflect the active matched-binding hint back through a `bind` sink. */
  readonly onActiveBinding?: ShortcutsBindingActiveSink;
  /** Override the delegated event type (defaults to `keydown`). */
  readonly eventType?: string;
}

export interface ShortcutsBinding {
  readonly viewModel: ShortcutsViewModel;
  /**
   * Resolves once every dispatch triggered so far has settled. Deterministic
   * await point for callers/tests (dispatch is async; the keydown handler is
   * sync). Resolves immediately when no dispatch is pending.
   */
  whenIdle(): Promise<void>;
  /** Tear down the single delegated listener. Idempotent. */
  dispose(): void;
}

export const SHORTCUTS_BINDING_EVENT = "keydown";

const KEY_EVENT_FIELDS = Object.freeze([
  "altKey",
  "code",
  "ctrlKey",
  "key",
  "metaKey",
  "shiftKey",
] as const);

const EDITABLE_TAGS = Object.freeze(["input", "textarea", "select"]);

/**
 * Attach the delegated `keydown` listener to `root` and wire it to a shortcuts
 * view-model. Exactly ONE listener is registered (event delegation; no
 * per-element listeners). Returns a handle that owns the view-model + disposal.
 */
export function createShortcutsBinding(
  root: VitaElement,
  port: ShortcutsBindingPort,
  options: ShortcutsBindingOptions = Object.freeze({}),
): ShortcutsBinding {
  const viewModel = options.viewModel ?? createShortcutsViewModel(port, options.registry ?? Object.freeze({}));
  const eventType = typeof options.eventType === "string" && options.eventType.length > 0
    ? options.eventType
    : SHORTCUTS_BINDING_EVENT;

  // Single delegated listener on the screen root (binder.ts delegation pattern:
  // one addEventListener on root, removeEventListener on dispose). A global key
  // listener must observe EVERY keydown — not only those landing on a
  // [data-vita-action] element — so it owns the handler directly rather than
  // routing through bindActions' action-element gate.
  let disposed = false;
  let pending: Promise<void> = Promise.resolve();

  const listener = (event: VitaEventLike): void => {
    if (disposed) return;

    const settled = handleKeyEvent(event, viewModel, options);

    if (settled !== null) {
      pending = pending.then(() => settled);
    }
  };

  try {
    root.addEventListener(eventType, listener);
  } catch {
    disposed = true;
  }

  return Object.freeze({
    viewModel,
    async whenIdle(): Promise<void> {
      await pending;
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;

      try {
        root.removeEventListener?.(eventType, listener);
      } catch {
        return;
      }
    },
  });
}

/**
 * Synchronous keydown handler. Returns the pending dispatch promise on a
 * matched chord (so the caller can await settlement) or `null` when the event
 * is ignored (no match, suppressed, or non-event).
 */
function handleKeyEvent(
  event: VitaEventLike,
  viewModel: ShortcutsViewModel,
  options: ShortcutsBindingOptions,
): Promise<void> | null {
  const keyEvent = snapshotKeyEvent(event);

  if (keyEvent === null) return null;

  // Editable-target suppression: while the user is typing in an editable
  // target, suppress BARE single-key chords (no modifier) so plain letters
  // pass through to the field. Modified chords still resolve.
  if (!hasModifier(keyEvent) && isEditableTarget(event.target)) return null;

  // normalize -> resolve: ask the VM whether this chord is bound. resolve()
  // normalizes the event into a canonical chord internally.
  const resolved = viewModel.resolve(keyEvent);

  if (!resolved.ok) return null;

  // preventDefault discipline: ONLY on a matched bound chord, never on
  // unmatched keystrokes.
  preventDefault(event);
  reflectActiveBinding(options.onActiveBinding, resolved.chord);

  // dispatch through the VM; route a fail-closed result to the error sink
  // without throwing or swallowing.
  return dispatchResolved(keyEvent, viewModel, options);
}

async function dispatchResolved(
  keyEvent: ShortcutKeyEvent,
  viewModel: ShortcutsViewModel,
  options: ShortcutsBindingOptions,
): Promise<void> {
  let result: ShortcutDispatchResult;

  try {
    result = await viewModel.dispatch(keyEvent);
  } catch {
    return;
  }

  if (result.ok) return;

  routeError(options.onError, result.error, result);
}

function reflectActiveBinding(sink: ShortcutsBindingActiveSink | undefined, chord: string): void {
  if (sink === undefined) return;

  try {
    sink(chord);
  } catch {
    return;
  }
}

function routeError(
  sink: ShortcutsBindingErrorSink | undefined,
  error: ShortcutError,
  result: ShortcutDispatchResult,
): void {
  if (sink === undefined) return;

  try {
    sink(error, result);
  } catch {
    return;
  }
}

function preventDefault(event: VitaEventLike): void {
  const preventer = readFunction(event, "preventDefault");

  if (preventer === undefined) return;

  try {
    preventer();
  } catch {
    return;
  }
}

/**
 * Snapshot the raw event into the VM's `ShortcutKeyEvent` shape using
 * intrinsic-safe reads. Returns `null` for non-object events. Reading happens
 * exactly once per field so a hostile accessor cannot lie across decisions.
 */
function snapshotKeyEvent(event: VitaEventLike): ShortcutKeyEvent | null {
  if (!isObjectLike(event)) return null;

  const output: {
    altKey?: boolean;
    code?: string;
    ctrlKey?: boolean;
    key?: string;
    metaKey?: boolean;
    shiftKey?: boolean;
  } = {};

  for (let index = 0; index < KEY_EVENT_FIELDS.length; index += 1) {
    const field = KEY_EVENT_FIELDS[index];

    if (field === undefined) continue;

    const value = readOwnData(event, field);

    if (field === "code" || field === "key") {
      if (typeof value === "string") output[field] = value;
    } else if (typeof value === "boolean") {
      output[field] = value;
    }
  }

  return Object.freeze(output);
}

function hasModifier(keyEvent: ShortcutKeyEvent): boolean {
  return keyEvent.ctrlKey === true ||
    keyEvent.altKey === true ||
    keyEvent.metaKey === true ||
    keyEvent.shiftKey === true;
}

/**
 * Editability is determined from the stub target's tag/attrs only — no real DOM
 * APIs. A target is editable when its tag is input/textarea/select, or it
 * declares `contenteditable` (truthy, not `"false"`).
 */
function isEditableTarget(target: unknown): boolean {
  if (!isObjectLike(target)) return false;

  const tag = readTagName(target);

  if (tag !== null && containsTag(EDITABLE_TAGS, tag)) return true;

  return isContentEditable(target);
}

function readTagName(target: object): string | null {
  const direct = readOwnData(target, "tagName");

  if (typeof direct === "string" && direct.length > 0) {
    return direct.toLocaleLowerCase("en-US");
  }

  const fromDataset = readDatasetString(target, "vitaTag");

  if (fromDataset !== null) return fromDataset.toLocaleLowerCase("en-US");

  return null;
}

function isContentEditable(target: object): boolean {
  const attr = readAttribute(target, "contenteditable");

  if (attr !== null) return attr !== "false";

  const dataset = readDatasetString(target, "vitaContentEditable");

  if (dataset !== null) return dataset !== "false";

  const direct = readOwnData(target, "contentEditable");

  if (typeof direct === "string") return direct !== "false" && direct.length > 0;
  if (typeof direct === "boolean") return direct;

  return false;
}

function readAttribute(target: object, name: string): string | null {
  const getter = readAttributeReader(target, "getAttribute") ?? readAttributeReader(target, "attribute");

  if (getter === undefined) return null;

  try {
    const value = getter(name);

    return typeof value === "string" ? value : null;
  } catch {
    return null;
  }
}

function readDatasetString(target: object, key: string): string | null {
  const dataset = readOwnData(target, "dataset");

  if (!isObjectLike(dataset)) return null;

  const value = readOwnData(dataset, key);

  return typeof value === "string" ? value : null;
}

type AttributeReader = (name: string) => unknown;

function readAttributeReader(source: object, key: string): AttributeReader | undefined {
  try {
    const value = Reflect.get(source, key);

    if (typeof value !== "function") return undefined;

    return (name: string): unknown => Reflect.apply(value, source, [name]);
  } catch {
    return undefined;
  }
}

function readFunction(source: unknown, key: string): (() => void) | undefined {
  if (!isObjectLike(source)) return undefined;

  try {
    const value = Reflect.get(source, key);

    if (typeof value !== "function") return undefined;

    return (): void => {
      Reflect.apply(value, source, []);
    };
  } catch {
    return undefined;
  }
}

function readOwnData(source: object, key: string): unknown {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(source, key);

    if (descriptor === undefined || !Object.prototype.hasOwnProperty.call(descriptor, "value")) {
      return undefined;
    }

    return descriptor.value;
  } catch {
    return undefined;
  }
}

function containsTag(tags: readonly string[], tag: string): boolean {
  for (let index = 0; index < tags.length; index += 1) {
    if (tags[index] === tag) return true;
  }

  return false;
}

function isObjectLike(value: unknown): value is object {
  return value !== null && typeof value === "object";
}
