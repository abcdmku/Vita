import {
  createCommandRegistry,
} from "./command-registry.ts";
import type {
  CommandAction,
  CommandContext,
  CommandDefinition,
  CommandRegistryViewModel,
} from "./command-registry.ts";

/**
 * Pointer / gesture & modifier-chord input view-model (PSD-267C).
 *
 * Extends the desktop input layer beyond keyboard chords (shortcuts.ts) to
 * pointer / wheel / gesture bindings, resolving them against the SAME command
 * model as the keyboard layer — the PSD-261C command-registry view-model. A raw
 * pointer/wheel/gesture event is normalized into a canonical, order-independent
 * `GestureChord` descriptor `{ kind, modifiers, direction?, fingers? }`. Bindings
 * map a canonical chord to a registry command id; `dispatch(event, ctx)` resolves
 * the chord, then asks the registry to classify the command into the shared typed
 * action union (`launcher.intent | wm.intent | settings.write | theme.toggle |
 * noop`), evaluating the command's `when`-context against `ctx`.
 *
 * Pure / deterministic — no DOM, no rendering, no platform internals, no clocks,
 * no ambient I/O. Equivalent events normalize to a byte-identical chord. Unbound
 * chords, unknown commands, and any classification failure fail closed to `noop`.
 */

export type GestureModifier = "Control" | "Alt" | "Shift" | "Meta";

export type GestureDirection = "up" | "down" | "left" | "right" | "in" | "out";

/** Discriminator for a canonical gesture chord. */
export type GestureKind =
  | "pointer.move"
  | "pointer.drag"
  | "wheel"
  | "gesture.swipe"
  | "gesture.pinch";

/** Raw modifier mask carried by every gesture event. Absent ⇒ false. */
export interface GestureModifierMask {
  readonly ctrlKey?: boolean;
  readonly altKey?: boolean;
  readonly shiftKey?: boolean;
  readonly metaKey?: boolean;
}

export interface PointerMoveEvent extends GestureModifierMask {
  readonly kind: "pointer.move";
}

export interface PointerDragEvent extends GestureModifierMask {
  readonly kind: "pointer.drag";
  readonly direction?: GestureDirection;
}

export interface WheelGestureEvent extends GestureModifierMask {
  readonly kind: "wheel";
  readonly direction?: GestureDirection;
}

export interface SwipeGestureEvent extends GestureModifierMask {
  readonly kind: "gesture.swipe";
  readonly direction?: GestureDirection;
  readonly fingers?: number;
}

export interface PinchGestureEvent extends GestureModifierMask {
  readonly kind: "gesture.pinch";
  readonly direction?: GestureDirection;
  readonly fingers?: number;
}

export type GestureEvent =
  | PointerMoveEvent
  | PointerDragEvent
  | WheelGestureEvent
  | SwipeGestureEvent
  | PinchGestureEvent;

/** A canonical, order-independent gesture chord descriptor. */
export interface GestureChord {
  readonly kind: GestureKind;
  /** Deterministically sorted (Control, Alt, Shift, Meta order). */
  readonly modifiers: readonly GestureModifier[];
  readonly direction?: GestureDirection;
  readonly fingers?: number;
}

/** A registered gesture binding (normalized chord → registry command id). */
export interface GestureBinding {
  readonly chord: GestureChord;
  /** Stable string key for the chord (used for equality / map keying). */
  readonly chordKey: string;
  readonly commandId: string;
}

export interface GestureSnapshot {
  readonly bindings: readonly GestureBinding[];
}

export interface GestureError {
  readonly code: string;
  readonly message: string;
  readonly path: string;
}

export type GestureNormalizeResult =
  | {
      readonly ok: true;
      readonly chord: GestureChord;
      readonly chordKey: string;
    }
  | {
      readonly ok: false;
      readonly error: GestureError;
    };

export type GestureBindResult =
  | {
      readonly ok: true;
      readonly binding: GestureBinding;
    }
  | {
      readonly ok: false;
      readonly error: GestureError;
    };

/**
 * Result of dispatching a gesture event. An unbound chord (or any fail-closed
 * path) yields a successful result carrying the `noop` action, mirroring the
 * contract: "Unbound chord → noop (no-op, fail-closed)".
 */
export interface GestureDispatchResult {
  readonly action: CommandAction;
  /** The canonical chord the event normalized to, when normalization succeeded. */
  readonly chord?: GestureChord;
  /** The command id that resolved the chord, when one was bound + available. */
  readonly commandId?: string;
}

export interface GestureInputViewModel {
  bind(chord: unknown, commandId: unknown): GestureBindResult;
  normalize(event: unknown): GestureNormalizeResult;
  dispatch(event: unknown, context?: CommandContext): GestureDispatchResult;
  snapshot(): GestureSnapshot;
}

export interface GestureInputOptions {
  /**
   * The shared command model. Gesture and keyboard chords resolve through ONE
   * registry so they never fork the action union. When omitted, a registry is
   * created from `commands`.
   */
  readonly registry?: CommandRegistryViewModel;
  readonly commands?: readonly CommandDefinition[];
  readonly bindings?: readonly GestureBindingInput[];
}

export interface GestureBindingInput {
  readonly chord: GestureChord;
  readonly commandId: string;
}

const MODIFIER_ORDER = Object.freeze([
  "Control",
  "Alt",
  "Shift",
  "Meta",
] as const satisfies readonly GestureModifier[]);

const GESTURE_KINDS = Object.freeze([
  "pointer.move",
  "pointer.drag",
  "wheel",
  "gesture.swipe",
  "gesture.pinch",
] as const satisfies readonly GestureKind[]);

const DIRECTIONS = Object.freeze([
  "up",
  "down",
  "left",
  "right",
  "in",
  "out",
] as const satisfies readonly GestureDirection[]);

/** Kinds for which a `direction` field is meaningful. */
const DIRECTIONAL_KINDS = Object.freeze([
  "pointer.drag",
  "wheel",
  "gesture.swipe",
  "gesture.pinch",
] as const satisfies readonly GestureKind[]);

/** Kinds for which a `fingers` count is meaningful. */
const MULTITOUCH_KINDS = Object.freeze([
  "gesture.swipe",
  "gesture.pinch",
] as const satisfies readonly GestureKind[]);

const EVENT_FIELDS = Object.freeze([
  "kind",
  "ctrlKey",
  "altKey",
  "shiftKey",
  "metaKey",
  "direction",
  "fingers",
]);

const NOOP_ACTION: CommandAction = Object.freeze({ kind: "noop" });

const EMPTY_CONTEXT: CommandContext = Object.freeze({});

export function createGestureInputViewModel(
  options: GestureInputOptions = Object.freeze({}),
): GestureInputViewModel {
  return new DesktopGestureInputViewModel(options);
}

export function normalizeGestureChord(input: unknown): GestureNormalizeResult {
  return normalizeChordOrEvent(input);
}

class DesktopGestureInputViewModel implements GestureInputViewModel {
  readonly #registry: CommandRegistryViewModel;
  readonly #byChord: Map<string, GestureBinding>;
  readonly #order: string[];

  constructor(options: GestureInputOptions) {
    this.#registry = options.registry ?? createCommandRegistry(
      options.commands === undefined ? undefined : { commands: options.commands },
    );
    this.#byChord = new Map<string, GestureBinding>();
    this.#order = [];

    const seed = options.bindings ?? Object.freeze([]);

    for (let index = 0; index < seed.length; index += 1) {
      const entry = seed[index];

      if (entry === undefined) {
        continue;
      }

      // Seeded bindings silently skip on invalid/duplicate so one bad entry
      // cannot poison construction; explicit `bind` reports errors.
      const normalized = normalizeChordOrEvent(entry.chord);

      if (
        !normalized.ok ||
        typeof entry.commandId !== "string" ||
        entry.commandId.length === 0 ||
        this.#byChord.has(normalized.chordKey)
      ) {
        continue;
      }

      const binding = freezeBinding(normalized.chord, normalized.chordKey, entry.commandId);
      this.#byChord.set(binding.chordKey, binding);
      this.#order.push(binding.chordKey);
    }
  }

  bind(chord: unknown, commandId: unknown): GestureBindResult {
    if (typeof commandId !== "string" || commandId.length === 0) {
      return rejectBind(error(
        "INVALID_COMMAND",
        "gesture binding requires a non-empty command id.",
        "/commandId",
      ));
    }

    const normalized = normalizeChordOrEvent(chord);

    if (!normalized.ok) {
      return rejectBind(normalized.error);
    }

    if (this.#byChord.has(normalized.chordKey)) {
      return rejectBind(error(
        "DUPLICATE_GESTURE",
        `gesture chord '${normalized.chordKey}' is already bound.`,
        `/bindings/${pathToken(normalized.chordKey)}`,
      ));
    }

    const binding = freezeBinding(normalized.chord, normalized.chordKey, commandId);
    this.#byChord.set(binding.chordKey, binding);
    this.#order.push(binding.chordKey);

    return Object.freeze({
      binding,
      ok: true,
    });
  }

  normalize(event: unknown): GestureNormalizeResult {
    return normalizeChordOrEvent(event);
  }

  dispatch(event: unknown, context?: CommandContext): GestureDispatchResult {
    const normalized = normalizeChordOrEvent(event);

    if (!normalized.ok) {
      // A malformed gesture is a no-op (fail closed), never a throw.
      return Object.freeze({ action: NOOP_ACTION });
    }

    const binding = this.#byChord.get(normalized.chordKey);

    if (binding === undefined) {
      // Unbound chord → noop.
      return Object.freeze({
        action: NOOP_ACTION,
        chord: normalized.chord,
      });
    }

    const result = this.#registry.execute(binding.commandId, normalizeContext(context));

    if (!result.ok) {
      // Unavailable / unknown / classification failure → noop, fail closed.
      return Object.freeze({
        action: NOOP_ACTION,
        chord: normalized.chord,
      });
    }

    return Object.freeze({
      action: result.action,
      chord: normalized.chord,
      commandId: binding.commandId,
    });
  }

  snapshot(): GestureSnapshot {
    const bindings: GestureBinding[] = [];

    for (let index = 0; index < this.#order.length; index += 1) {
      const key = this.#order[index];

      if (key === undefined) {
        continue;
      }

      const binding = this.#byChord.get(key);

      if (binding !== undefined) {
        bindings.push(binding);
      }
    }

    bindings.sort((left, right) => compareStrings(left.chordKey, right.chordKey));

    return Object.freeze({
      bindings: Object.freeze(bindings),
    });
  }
}

function normalizeChordOrEvent(input: unknown): GestureNormalizeResult {
  try {
    const snapshot = snapshotObject(input);

    if (snapshot === null) {
      return rejectNormalize("INVALID_GESTURE", "gesture must be a plain object.", "/gesture");
    }

    const kind = snapshot.get("kind");

    if (typeof kind !== "string" || !contains(GESTURE_KINDS, kind)) {
      return rejectNormalize("INVALID_GESTURE", "gesture kind is not recognized.", "/gesture/kind");
    }

    const modifiers = readModifiers(snapshot);

    if (modifiers === null) {
      return rejectNormalize("INVALID_GESTURE", "gesture modifier flags must be boolean.", "/gesture/modifiers");
    }

    const directionResult = readDirection(snapshot, kind);

    if (!directionResult.ok) {
      return rejectNormalize(directionResult.error.code, directionResult.error.message, directionResult.error.path);
    }

    const fingersResult = readFingers(snapshot, kind);

    if (!fingersResult.ok) {
      return rejectNormalize(fingersResult.error.code, fingersResult.error.message, fingersResult.error.path);
    }

    const chord = buildChord(kind, modifiers, directionResult.value, fingersResult.value);

    return Object.freeze({
      chord,
      chordKey: chordKey(chord),
      ok: true,
    });
  } catch {
    // A trust-boundary guard NEVER throws (hostile getter / exotic shape).
    return rejectNormalize("INVALID_GESTURE", "gesture must be a stable plain object.", "/gesture");
  }
}

function readModifiers(
  snapshot: ReadonlyMap<string, unknown>,
): readonly GestureModifier[] | null {
  const present = new Set<GestureModifier>();
  const flags: readonly (readonly [string, GestureModifier])[] = Object.freeze([
    Object.freeze(["ctrlKey", "Control"] as const),
    Object.freeze(["altKey", "Alt"] as const),
    Object.freeze(["shiftKey", "Shift"] as const),
    Object.freeze(["metaKey", "Meta"] as const),
  ]);

  for (let index = 0; index < flags.length; index += 1) {
    const entry = flags[index];

    if (entry === undefined) {
      continue;
    }

    const value = snapshot.get(entry[0]);

    if (value === undefined) {
      continue;
    }

    if (typeof value !== "boolean") {
      return null;
    }

    if (value) {
      present.add(entry[1]);
    }
  }

  const output: GestureModifier[] = [];

  for (let index = 0; index < MODIFIER_ORDER.length; index += 1) {
    const modifier = MODIFIER_ORDER[index];

    if (modifier !== undefined && present.has(modifier)) {
      output.push(modifier);
    }
  }

  return Object.freeze(output);
}

type FieldResult<T> =
  | {
      readonly ok: true;
      readonly value: T;
    }
  | {
      readonly ok: false;
      readonly error: GestureError;
    };

function readDirection(
  snapshot: ReadonlyMap<string, unknown>,
  kind: GestureKind,
): FieldResult<GestureDirection | undefined> {
  const value = snapshot.get("direction");

  if (value === undefined) {
    return { ok: true, value: undefined };
  }

  if (typeof value !== "string" || !contains(DIRECTIONS, value)) {
    return {
      error: error("INVALID_GESTURE", "gesture direction is not recognized.", "/gesture/direction"),
      ok: false,
    };
  }

  // Non-directional kinds (pointer.move) drop direction so equivalent events
  // collapse to one canonical chord.
  if (!contains(DIRECTIONAL_KINDS, kind)) {
    return { ok: true, value: undefined };
  }

  return { ok: true, value };
}

function readFingers(
  snapshot: ReadonlyMap<string, unknown>,
  kind: GestureKind,
): FieldResult<number | undefined> {
  const value = snapshot.get("fingers");

  if (value === undefined) {
    return { ok: true, value: undefined };
  }

  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < 1 ||
    value > 10
  ) {
    return {
      error: error("INVALID_GESTURE", "gesture finger count must be an integer in [1, 10].", "/gesture/fingers"),
      ok: false,
    };
  }

  // Only multitouch gestures carry a finger count; others drop it.
  if (!contains(MULTITOUCH_KINDS, kind)) {
    return { ok: true, value: undefined };
  }

  return { ok: true, value };
}

function buildChord(
  kind: GestureKind,
  modifiers: readonly GestureModifier[],
  direction: GestureDirection | undefined,
  fingers: number | undefined,
): GestureChord {
  const output: {
    kind: GestureKind;
    modifiers: readonly GestureModifier[];
    direction?: GestureDirection;
    fingers?: number;
  } = {
    kind,
    modifiers: Object.freeze([...modifiers]),
  };

  if (direction !== undefined) {
    output.direction = direction;
  }

  if (fingers !== undefined) {
    output.fingers = fingers;
  }

  return Object.freeze(output);
}

/**
 * Stable, order-independent string key for a chord. Modifiers are already in
 * canonical order; the key is a byte-identical descriptor for equivalent events.
 */
function chordKey(chord: GestureChord): string {
  const modifiers = chord.modifiers.length > 0 ? chord.modifiers.join("+") : "-";
  const direction = chord.direction ?? "-";
  const fingers = chord.fingers ?? "-";

  return `${chord.kind}|${modifiers}|${direction}|${fingers}`;
}

function freezeBinding(
  chord: GestureChord,
  key: string,
  commandId: string,
): GestureBinding {
  return Object.freeze({
    chord,
    chordKey: key,
    commandId,
  });
}

function normalizeContext(context: CommandContext | undefined): CommandContext {
  if (context === undefined || context === null || typeof context !== "object") {
    return EMPTY_CONTEXT;
  }

  return context;
}

/**
 * Snapshot an untrusted gesture object to a trusted plain map ONCE: reject
 * exotic prototypes, symbol keys, unknown fields, and accessor (getter/setter)
 * properties so a TOCTOU getter cannot return different values across reads.
 */
function snapshotObject(input: unknown): ReadonlyMap<string, unknown> | null {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    return null;
  }

  const prototype = Object.getPrototypeOf(input);

  if (prototype !== Object.prototype && prototype !== null) {
    return null;
  }

  const keys = Reflect.ownKeys(input);
  const output = new Map<string, unknown>();

  for (let index = 0; index < keys.length; index += 1) {
    const key = keys[index];

    if (key === undefined || typeof key === "symbol" || !contains(EVENT_FIELDS, key)) {
      return null;
    }

    const descriptor = Object.getOwnPropertyDescriptor(input, key);

    if (
      descriptor === undefined ||
      !Object.prototype.hasOwnProperty.call(descriptor, "value") ||
      descriptor.enumerable !== true
    ) {
      return null;
    }

    output.set(key, descriptor.value);
  }

  return output;
}

function contains<T extends string>(values: readonly T[], value: string): value is T {
  for (let index = 0; index < values.length; index += 1) {
    if (values[index] === value) {
      return true;
    }
  }

  return false;
}

function compareStrings(left: string, right: string): number {
  if (left < right) {
    return -1;
  }

  if (left > right) {
    return 1;
  }

  return 0;
}

function rejectBind(errorValue: GestureError): GestureBindResult {
  return Object.freeze({
    error: errorValue,
    ok: false,
  });
}

function rejectNormalize(code: string, message: string, path: string): GestureNormalizeResult {
  return Object.freeze({
    error: error(code, message, path),
    ok: false,
  });
}

function error(code: string, message: string, path: string): GestureError {
  return Object.freeze({
    code,
    message,
    path,
  });
}

function pathToken(value: string): string {
  let token = "";

  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];

    if (char === undefined) {
      continue;
    }

    const code = char.charCodeAt(0);
    const alphaNumeric =
      (code >= 48 && code <= 57) ||
      (code >= 65 && code <= 90) ||
      (code >= 97 && code <= 122);

    token += alphaNumeric || code === 45 || code === 46
      ? char
      : `_${code.toString(16).padStart(4, "0")}`;
  }

  return token;
}
