import {
  hasDesktopCapabilityGrant,
} from "../../../sdk/typescript/src/desktop-sdk/index.ts";
import type {
  DesktopHost,
  DesktopHostError,
} from "../../../sdk/typescript/src/desktop-sdk/index.ts";

export const INPUT_ACCESSIBILITY_SETTING_KEY = "accessibility.inputPolicy";

export const INPUT_ACCESSIBILITY_SETTING_KEYS = Object.freeze({
  policy: INPUT_ACCESSIBILITY_SETTING_KEY,
});

export type InputAccessibilityModifier = "Control" | "Alt" | "Shift" | "Meta";
export type InputAccessibilityKeyEventType = "down" | "up";
export type InputAccessibilityChordSource = "physical" | "slow" | "repeat";

export interface InputAccessibilityKeyRepeatSettings {
  readonly enabled: boolean;
  readonly repeatDelayMs: number;
  readonly repeatRateMs: number;
}

export interface InputAccessibilityStickyKeysSettings {
  readonly enabled: boolean;
  readonly lockOnDoublePress: boolean;
}

export interface InputAccessibilitySlowKeysSettings {
  readonly enabled: boolean;
  readonly holdThresholdMs: number;
}

export interface InputAccessibilityBounceKeysSettings {
  readonly enabled: boolean;
  readonly debounceWindowMs: number;
}

export interface InputAccessibilitySettings {
  readonly keyRepeat: InputAccessibilityKeyRepeatSettings;
  readonly stickyKeys: InputAccessibilityStickyKeysSettings;
  readonly slowKeys: InputAccessibilitySlowKeysSettings;
  readonly bounceKeys: InputAccessibilityBounceKeysSettings;
}

export interface InputAccessibilityRawKeyEvent {
  readonly key: string;
  readonly code: string;
  readonly type: InputAccessibilityKeyEventType;
  readonly at: number;
}

export interface InputAccessibilityClockKeyEvent {
  readonly key: string;
  readonly code: string;
  readonly type: InputAccessibilityKeyEventType;
  readonly at?: number;
}

export interface InputAccessibilityChordEvent {
  readonly at: number;
  readonly chord: string;
  readonly code: string;
  readonly key: string;
  readonly modifiers: readonly InputAccessibilityModifier[];
  readonly repeat: boolean;
  readonly source: InputAccessibilityChordSource;
}

export interface InputAccessibilityHeldKeySnapshot {
  readonly code: string;
  readonly key: string;
  readonly acceptedAt?: number;
  readonly downAt: number;
  readonly modifier?: InputAccessibilityModifier;
  readonly suppressed: boolean;
}

export interface InputAccessibilityState {
  readonly activeModifiers: readonly InputAccessibilityModifier[];
  readonly chords: readonly InputAccessibilityChordEvent[];
  readonly cursorAt: number;
  readonly heldKeys: readonly InputAccessibilityHeldKeySnapshot[];
  readonly latchedModifiers: readonly InputAccessibilityModifier[];
  readonly lockedModifiers: readonly InputAccessibilityModifier[];
  readonly settings: InputAccessibilitySettings;
}

export interface InputAccessibilityError {
  readonly code: string;
  readonly message: string;
  readonly path: string;
}

export type InputAccessibilityResult<T> =
  | {
      readonly ok: true;
      readonly value: T;
    }
  | {
      readonly ok: false;
      readonly error: InputAccessibilityError;
    };

export type InputAccessibilityActionResult =
  | {
      readonly ok: true;
      readonly chords: readonly InputAccessibilityChordEvent[];
      readonly state: InputAccessibilityState;
    }
  | {
      readonly ok: false;
      readonly error: InputAccessibilityError;
      readonly state: InputAccessibilityState;
    };

export interface InputAccessibilityClock {
  now(): number;
}

export interface InputAccessibilityPorts {
  readonly package: DesktopHost["package"];
  readonly readSetting?: NonNullable<DesktopHost["readSetting"]>;
  readonly applySetting?: NonNullable<DesktopHost["applySetting"]>;
}

export interface InputAccessibilityViewModel {
  readonly state: InputAccessibilityState;
  snapshot(): InputAccessibilityState;
  process(events: unknown): InputAccessibilityActionResult;
  handleKeyEvent(event: unknown): InputAccessibilityActionResult;
  flush(): InputAccessibilityActionResult;
  setSettings(settings: unknown): Promise<InputAccessibilityActionResult>;
}

type SettingsWriteValue = Parameters<NonNullable<DesktopHost["applySetting"]>>[0]["value"];

type NormalizeResult<T> =
  | {
      readonly ok: true;
      readonly value: T;
    }
  | {
      readonly ok: false;
      readonly error: InputAccessibilityError;
    };

interface NormalizedKeyEvent {
  readonly at: number;
  readonly code: string;
  readonly key: string;
  readonly keyId: string;
  readonly modifier: InputAccessibilityModifier | null;
  readonly normalizedKey: string;
  readonly type: InputAccessibilityKeyEventType;
}

interface MutableHeldKey {
  readonly code: string;
  readonly downAt: number;
  readonly key: string;
  readonly keyId: string;
  readonly modifier: InputAccessibilityModifier | null;
  readonly normalizedKey: string;
  readonly sequence: number;
  acceptedAt: number | null;
  nextRepeatAt: number | null;
  stickyModifiers: readonly InputAccessibilityModifier[];
  suppressed: boolean;
  usedDuringHold: boolean;
}

interface DueCandidate {
  readonly at: number;
  readonly held: MutableHeldKey;
  readonly kind: "accept" | "repeat";
}

const MODIFIER_ORDER = Object.freeze(["Control", "Alt", "Shift", "Meta"] as const);
const EMPTY_MODIFIERS: readonly InputAccessibilityModifier[] = Object.freeze([]);
const SETTINGS_FIELDS = Object.freeze(["bounceKeys", "keyRepeat", "slowKeys", "stickyKeys"]);
const KEY_REPEAT_FIELDS = Object.freeze(["enabled", "repeatDelayMs", "repeatRateMs"]);
const STICKY_KEYS_FIELDS = Object.freeze(["enabled", "lockOnDoublePress"]);
const SLOW_KEYS_FIELDS = Object.freeze(["enabled", "holdThresholdMs"]);
const BOUNCE_KEYS_FIELDS = Object.freeze(["enabled", "debounceWindowMs"]);
const RAW_KEY_EVENT_FIELDS = Object.freeze(["at", "code", "key", "type"]);
const CLOCK_KEY_EVENT_FIELDS = Object.freeze(["at", "code", "key", "type"]);
const ARRAY_LENGTH_KEY = "length";

export const DEFAULT_INPUT_ACCESSIBILITY_SETTINGS: InputAccessibilitySettings = freezeSettings({
  bounceKeys: {
    debounceWindowMs: 80,
    enabled: false,
  },
  keyRepeat: {
    enabled: true,
    repeatDelayMs: 500,
    repeatRateMs: 50,
  },
  slowKeys: {
    enabled: false,
    holdThresholdMs: 500,
  },
  stickyKeys: {
    enabled: false,
    lockOnDoublePress: false,
  },
});

export async function createInputAccessibilityViewModel(
  ports: InputAccessibilityPorts,
  clock: InputAccessibilityClock,
): Promise<InputAccessibilityResult<InputAccessibilityViewModel>> {
  const settings = await readInputAccessibilitySettings(ports);

  if (!settings.ok) return settings;

  const initialNow = readClock(clock, "/clock");

  if (!initialNow.ok) return initialNow;

  return accept(new DesktopInputAccessibilityViewModel(ports, clock, settings.value, initialNow.value));
}

export function reduceInputAccessibilityEvents(
  settings: InputAccessibilitySettings,
  events: unknown,
  startAt = 0,
): InputAccessibilityActionResult {
  const vm = new DesktopInputAccessibilityViewModel(
    emptyPorts(),
    staticClock(startAt),
    freezeSettings(settings),
    startAt,
  );

  return vm.process(events);
}

class DesktopInputAccessibilityViewModel implements InputAccessibilityViewModel {
  readonly #clock: InputAccessibilityClock;
  readonly #ports: InputAccessibilityPorts;
  #chords: readonly InputAccessibilityChordEvent[] = Object.freeze([]);
  #cursorAt: number;
  #held = new Map<string, MutableHeldKey>();
  #lastAcceptedDownAt = new Map<string, number>();
  #latchedModifiers = new Set<InputAccessibilityModifier>();
  #lockedModifiers = new Set<InputAccessibilityModifier>();
  #sequence = 0;
  #settings: InputAccessibilitySettings;

  constructor(
    ports: InputAccessibilityPorts,
    clock: InputAccessibilityClock,
    settings: InputAccessibilitySettings,
    cursorAt: number,
  ) {
    this.#ports = ports;
    this.#clock = clock;
    this.#settings = freezeSettings(settings);
    this.#cursorAt = cursorAt;
  }

  get state(): InputAccessibilityState {
    return this.snapshot();
  }

  snapshot(): InputAccessibilityState {
    return freezeState({
      activeModifiers: this.#activeModifiers(),
      chords: this.#chords,
      cursorAt: this.#cursorAt,
      heldKeys: this.#heldSnapshots(),
      latchedModifiers: orderedModifiers(this.#latchedModifiers),
      lockedModifiers: orderedModifiers(this.#lockedModifiers),
      settings: this.#settings,
    });
  }

  process(events: unknown): InputAccessibilityActionResult {
    const normalized = normalizeRawKeyEvents(events, this.#cursorAt);

    if (!normalized.ok) return actionReject(normalized.error, this.snapshot());

    const emitted: InputAccessibilityChordEvent[] = [];

    for (let index = 0; index < normalized.value.length; index += 1) {
      const event = normalized.value[index];

      if (event === undefined) continue;

      this.#flushUntil(event.at, emitted);
      this.#processEvent(event, emitted);
      this.#cursorAt = event.at;
    }

    return this.#acceptAction(emitted);
  }

  handleKeyEvent(event: unknown): InputAccessibilityActionResult {
    const normalized = normalizeClockKeyEvent(event, this.#clock);

    if (!normalized.ok) return actionReject(normalized.error, this.snapshot());

    return this.process(Object.freeze([normalized.value]));
  }

  flush(): InputAccessibilityActionResult {
    const now = readClock(this.#clock, "/clock");

    if (!now.ok) return actionReject(now.error, this.snapshot());
    if (now.value < this.#cursorAt) {
      return actionReject(error("NON_MONOTONIC_CLOCK", "clock must not move backwards.", "/clock"), this.snapshot());
    }

    const emitted: InputAccessibilityChordEvent[] = [];
    this.#flushUntil(now.value, emitted);
    this.#cursorAt = now.value;

    return this.#acceptAction(emitted);
  }

  async setSettings(settings: unknown): Promise<InputAccessibilityActionResult> {
    const normalized = normalizeInputAccessibilitySettings(settings, "/settings");

    if (!normalized.ok) return actionReject(normalized.error, this.snapshot());

    const written = await writeInputAccessibilitySettings(this.#ports, normalized.value);

    if (!written.ok) return actionReject(written.error, this.snapshot());

    this.#settings = normalized.value;
    this.#held.clear();
    this.#latchedModifiers.clear();
    this.#lockedModifiers.clear();
    this.#lastAcceptedDownAt.clear();

    return actionAccept(Object.freeze([]), this.snapshot());
  }

  #processEvent(event: NormalizedKeyEvent, output: InputAccessibilityChordEvent[]): void {
    if (event.type === "down") {
      this.#handleDown(event, output);
      return;
    }

    this.#handleUp(event);
  }

  #handleDown(event: NormalizedKeyEvent, output: InputAccessibilityChordEvent[]): void {
    if (this.#held.has(event.keyId)) return;

    const suppressed = this.#isBounceSuppressed(event);
    const held = this.#heldKey(event, suppressed);
    this.#held.set(event.keyId, held);

    if (!suppressed && !this.#settings.slowKeys.enabled) {
      this.#acceptKey(held, event.at, "physical", output);
    }
  }

  #handleUp(event: NormalizedKeyEvent): void {
    const held = this.#held.get(event.keyId);

    if (held === undefined) return;

    if (
      held.modifier !== null &&
      held.acceptedAt !== null &&
      !held.suppressed &&
      !held.usedDuringHold &&
      this.#settings.stickyKeys.enabled
    ) {
      this.#applyStickyRelease(held.modifier);
    }

    this.#held.delete(event.keyId);
  }

  #heldKey(event: NormalizedKeyEvent, suppressed: boolean): MutableHeldKey {
    const held: MutableHeldKey = {
      acceptedAt: null,
      code: event.code,
      downAt: event.at,
      key: event.key,
      keyId: event.keyId,
      modifier: event.modifier,
      nextRepeatAt: null,
      normalizedKey: event.normalizedKey,
      sequence: this.#sequence,
      stickyModifiers: EMPTY_MODIFIERS,
      suppressed,
      usedDuringHold: false,
    };

    this.#sequence += 1;

    return held;
  }

  #isBounceSuppressed(event: NormalizedKeyEvent): boolean {
    if (!this.#settings.bounceKeys.enabled) return false;

    const lastAccepted = this.#lastAcceptedDownAt.get(event.keyId);

    return lastAccepted !== undefined && event.at - lastAccepted < this.#settings.bounceKeys.debounceWindowMs;
  }

  #flushUntil(untilAt: number, output: InputAccessibilityChordEvent[]): void {
    for (;;) {
      const next = this.#nextDue(untilAt);

      if (next === null) return;
      if (next.kind === "accept") {
        this.#acceptKey(next.held, next.at, this.#settings.slowKeys.enabled ? "slow" : "physical", output);
      } else {
        this.#emitRepeat(next.held, next.at, output);
      }
    }
  }

  #nextDue(untilAt: number): DueCandidate | null {
    let next: DueCandidate | null = null;

    for (const held of this.#held.values()) {
      if (held.suppressed) continue;

      const candidate = dueForHeldKey(held, this.#settings, untilAt);

      if (candidate === null) continue;
      if (next === null || compareDueCandidate(candidate, next) < 0) {
        next = candidate;
      }
    }

    return next;
  }

  #acceptKey(
    held: MutableHeldKey,
    at: number,
    source: Exclude<InputAccessibilityChordSource, "repeat">,
    output: InputAccessibilityChordEvent[],
  ): void {
    if (held.acceptedAt !== null) return;

    held.acceptedAt = at;
    this.#lastAcceptedDownAt.set(held.keyId, at);

    if (held.modifier !== null) return;

    held.stickyModifiers = this.#consumeLatchedModifiers();
    this.#emitChord(held, at, false, source, output);
    this.#scheduleRepeat(held, at);
  }

  #emitRepeat(held: MutableHeldKey, at: number, output: InputAccessibilityChordEvent[]): void {
    if (held.acceptedAt === null || held.nextRepeatAt === null || held.modifier !== null) return;

    this.#emitChord(held, at, true, "repeat", output);
    held.nextRepeatAt = at + this.#settings.keyRepeat.repeatRateMs;
  }

  #emitChord(
    held: MutableHeldKey,
    at: number,
    repeat: boolean,
    source: InputAccessibilityChordSource,
    output: InputAccessibilityChordEvent[],
  ): void {
    const modifiers = this.#effectiveModifiersFor(held);
    const chord = freezeChordEvent({
      at,
      chord: buildChord(modifiers, held.normalizedKey),
      code: held.code,
      key: held.normalizedKey,
      modifiers,
      repeat,
      source,
    });

    this.#markHeldModifiersUsed(modifiers);
    output.push(chord);
  }

  #scheduleRepeat(held: MutableHeldKey, acceptedAt: number): void {
    if (!this.#settings.keyRepeat.enabled || held.modifier !== null) return;

    held.nextRepeatAt = acceptedAt + this.#settings.keyRepeat.repeatDelayMs;
  }

  #consumeLatchedModifiers(): readonly InputAccessibilityModifier[] {
    if (!this.#settings.stickyKeys.enabled || this.#latchedModifiers.size === 0) {
      return EMPTY_MODIFIERS;
    }

    const consumed = orderedModifiers(this.#latchedModifiers);
    this.#latchedModifiers.clear();

    return consumed;
  }

  #applyStickyRelease(modifier: InputAccessibilityModifier): void {
    if (this.#settings.stickyKeys.lockOnDoublePress) {
      if (this.#lockedModifiers.has(modifier)) {
        this.#lockedModifiers.delete(modifier);
        this.#latchedModifiers.delete(modifier);
        return;
      }

      if (this.#latchedModifiers.has(modifier)) {
        this.#latchedModifiers.delete(modifier);
        this.#lockedModifiers.add(modifier);
        return;
      }
    }

    this.#latchedModifiers.add(modifier);
  }

  #effectiveModifiersFor(held: MutableHeldKey): readonly InputAccessibilityModifier[] {
    const modifiers = new Set<InputAccessibilityModifier>();

    addModifiers(modifiers, this.#lockedModifiers);

    for (const activeHeld of this.#held.values()) {
      if (activeHeld.modifier !== null && activeHeld.acceptedAt !== null && !activeHeld.suppressed) {
        modifiers.add(activeHeld.modifier);
      }
    }

    addModifiers(modifiers, held.stickyModifiers);

    return orderedModifiers(modifiers);
  }

  #activeModifiers(): readonly InputAccessibilityModifier[] {
    const modifiers = new Set<InputAccessibilityModifier>();

    addModifiers(modifiers, this.#lockedModifiers);
    addModifiers(modifiers, this.#latchedModifiers);

    for (const held of this.#held.values()) {
      if (held.modifier !== null && held.acceptedAt !== null && !held.suppressed) {
        modifiers.add(held.modifier);
      }
    }

    return orderedModifiers(modifiers);
  }

  #markHeldModifiersUsed(modifiers: readonly InputAccessibilityModifier[]): void {
    for (const held of this.#held.values()) {
      if (
        held.modifier !== null &&
        held.acceptedAt !== null &&
        containsModifier(modifiers, held.modifier)
      ) {
        held.usedDuringHold = true;
      }
    }
  }

  #heldSnapshots(): readonly InputAccessibilityHeldKeySnapshot[] {
    const output: InputAccessibilityHeldKeySnapshot[] = [];

    for (const held of this.#held.values()) {
      const snapshot: {
        code: string;
        key: string;
        downAt: number;
        suppressed: boolean;
        acceptedAt?: number;
        modifier?: InputAccessibilityModifier;
      } = {
        code: held.code,
        downAt: held.downAt,
        key: held.normalizedKey,
        suppressed: held.suppressed,
      };

      if (held.acceptedAt !== null) snapshot.acceptedAt = held.acceptedAt;
      if (held.modifier !== null) snapshot.modifier = held.modifier;

      output.push(Object.freeze(snapshot));
    }

    return Object.freeze(output);
  }

  #acceptAction(emitted: readonly InputAccessibilityChordEvent[]): InputAccessibilityActionResult {
    this.#chords = Object.freeze([...this.#chords, ...emitted]);

    return actionAccept(Object.freeze([...emitted]), this.snapshot());
  }
}

function dueForHeldKey(
  held: MutableHeldKey,
  settings: InputAccessibilitySettings,
  untilAt: number,
): DueCandidate | null {
  if (held.acceptedAt === null) {
    const acceptAt = settings.slowKeys.enabled
      ? held.downAt + settings.slowKeys.holdThresholdMs
      : held.downAt;

    if (acceptAt <= untilAt) {
      return Object.freeze({
        at: acceptAt,
        held,
        kind: "accept",
      });
    }

    return null;
  }

  if (
    held.modifier === null &&
    held.nextRepeatAt !== null &&
    held.nextRepeatAt <= untilAt
  ) {
    return Object.freeze({
      at: held.nextRepeatAt,
      held,
      kind: "repeat",
    });
  }

  return null;
}

function compareDueCandidate(left: DueCandidate, right: DueCandidate): number {
  const at = left.at - right.at;

  if (at !== 0) return at;

  const sequence = left.held.sequence - right.held.sequence;

  if (sequence !== 0) return sequence;
  if (left.kind === right.kind) return 0;

  return left.kind === "accept" ? -1 : 1;
}

async function readInputAccessibilitySettings(
  ports: InputAccessibilityPorts,
): Promise<InputAccessibilityResult<InputAccessibilitySettings>> {
  if (!hasDesktopCapabilityGrant(ports.package, "settings.read", INPUT_ACCESSIBILITY_SETTING_KEY)) {
    return reject("MISSING_CAPABILITY", "package cannot read input accessibility settings.", "/capabilityGrants/settings.read");
  }

  const readSetting = ports.readSetting;

  if (readSetting === undefined) {
    return reject("SETTINGS_PORT_UNAVAILABLE", "settings read port is unavailable.", "/settings");
  }

  let result: Awaited<ReturnType<NonNullable<DesktopHost["readSetting"]>>>;

  try {
    result = await readSetting(Object.freeze({ key: INPUT_ACCESSIBILITY_SETTING_KEY }));
  } catch {
    return reject("SETTINGS_READ_FAILED", "settings read failed closed.", "/settings");
  }

  if (!result.ok) return rejectFromHost(result.error);

  return normalizeInputAccessibilitySettings(result.value, "/settings");
}

async function writeInputAccessibilitySettings(
  ports: InputAccessibilityPorts,
  settings: InputAccessibilitySettings,
): Promise<InputAccessibilityResult<true>> {
  if (!hasDesktopCapabilityGrant(ports.package, "settings.write", INPUT_ACCESSIBILITY_SETTING_KEY)) {
    return reject("MISSING_CAPABILITY", "package cannot write input accessibility settings.", "/capabilityGrants/settings.write");
  }

  const applySetting = ports.applySetting;

  if (applySetting === undefined) {
    return reject("SETTINGS_PORT_UNAVAILABLE", "settings write port is unavailable.", "/settings");
  }

  let result: Awaited<ReturnType<NonNullable<DesktopHost["applySetting"]>>>;

  try {
    result = await applySetting(Object.freeze({
      key: INPUT_ACCESSIBILITY_SETTING_KEY,
      value: settingsToJson(settings),
    }));
  } catch {
    return reject("SETTINGS_WRITE_FAILED", "settings write failed closed.", "/settings");
  }

  if (!result.ok) return rejectFromHost(result.error);

  return accept(true);
}

function normalizeInputAccessibilitySettings(
  input: unknown,
  path: string,
): InputAccessibilityResult<InputAccessibilitySettings> {
  const object = snapshotObject(input, SETTINGS_FIELDS, SETTINGS_FIELDS, "INVALID_INPUT_ACCESSIBILITY_SETTINGS", path);

  if (!object.ok) return object;

  const keyRepeat = normalizeKeyRepeatSettings(object.value.get("keyRepeat"), `${path}/keyRepeat`);
  const stickyKeys = normalizeStickyKeysSettings(object.value.get("stickyKeys"), `${path}/stickyKeys`);
  const slowKeys = normalizeSlowKeysSettings(object.value.get("slowKeys"), `${path}/slowKeys`);
  const bounceKeys = normalizeBounceKeysSettings(object.value.get("bounceKeys"), `${path}/bounceKeys`);

  if (!keyRepeat.ok) return keyRepeat;
  if (!stickyKeys.ok) return stickyKeys;
  if (!slowKeys.ok) return slowKeys;
  if (!bounceKeys.ok) return bounceKeys;

  return accept(freezeSettings({
    bounceKeys: bounceKeys.value,
    keyRepeat: keyRepeat.value,
    slowKeys: slowKeys.value,
    stickyKeys: stickyKeys.value,
  }));
}

function normalizeKeyRepeatSettings(input: unknown, path: string): InputAccessibilityResult<InputAccessibilityKeyRepeatSettings> {
  const object = snapshotObject(input, KEY_REPEAT_FIELDS, KEY_REPEAT_FIELDS, "INVALID_KEY_REPEAT_SETTINGS", path);

  if (!object.ok) return object;

  const enabled = requiredBoolean(object.value, "enabled", `${path}/enabled`, "INVALID_KEY_REPEAT_SETTINGS");
  const repeatDelayMs = requiredMs(object.value, "repeatDelayMs", `${path}/repeatDelayMs`, 0, "INVALID_KEY_REPEAT_SETTINGS");
  const repeatRateMs = requiredMs(object.value, "repeatRateMs", `${path}/repeatRateMs`, 1, "INVALID_KEY_REPEAT_SETTINGS");

  if (!enabled.ok) return enabled;
  if (!repeatDelayMs.ok) return repeatDelayMs;
  if (!repeatRateMs.ok) return repeatRateMs;

  return accept(Object.freeze({
    enabled: enabled.value,
    repeatDelayMs: repeatDelayMs.value,
    repeatRateMs: repeatRateMs.value,
  }));
}

function normalizeStickyKeysSettings(input: unknown, path: string): InputAccessibilityResult<InputAccessibilityStickyKeysSettings> {
  const object = snapshotObject(input, STICKY_KEYS_FIELDS, STICKY_KEYS_FIELDS, "INVALID_STICKY_KEYS_SETTINGS", path);

  if (!object.ok) return object;

  const enabled = requiredBoolean(object.value, "enabled", `${path}/enabled`, "INVALID_STICKY_KEYS_SETTINGS");
  const lockOnDoublePress = requiredBoolean(
    object.value,
    "lockOnDoublePress",
    `${path}/lockOnDoublePress`,
    "INVALID_STICKY_KEYS_SETTINGS",
  );

  if (!enabled.ok) return enabled;
  if (!lockOnDoublePress.ok) return lockOnDoublePress;

  return accept(Object.freeze({
    enabled: enabled.value,
    lockOnDoublePress: lockOnDoublePress.value,
  }));
}

function normalizeSlowKeysSettings(input: unknown, path: string): InputAccessibilityResult<InputAccessibilitySlowKeysSettings> {
  const object = snapshotObject(input, SLOW_KEYS_FIELDS, SLOW_KEYS_FIELDS, "INVALID_SLOW_KEYS_SETTINGS", path);

  if (!object.ok) return object;

  const enabled = requiredBoolean(object.value, "enabled", `${path}/enabled`, "INVALID_SLOW_KEYS_SETTINGS");
  const holdThresholdMs = requiredMs(object.value, "holdThresholdMs", `${path}/holdThresholdMs`, 0, "INVALID_SLOW_KEYS_SETTINGS");

  if (!enabled.ok) return enabled;
  if (!holdThresholdMs.ok) return holdThresholdMs;

  return accept(Object.freeze({
    enabled: enabled.value,
    holdThresholdMs: holdThresholdMs.value,
  }));
}

function normalizeBounceKeysSettings(input: unknown, path: string): InputAccessibilityResult<InputAccessibilityBounceKeysSettings> {
  const object = snapshotObject(input, BOUNCE_KEYS_FIELDS, BOUNCE_KEYS_FIELDS, "INVALID_BOUNCE_KEYS_SETTINGS", path);

  if (!object.ok) return object;

  const enabled = requiredBoolean(object.value, "enabled", `${path}/enabled`, "INVALID_BOUNCE_KEYS_SETTINGS");
  const debounceWindowMs = requiredMs(
    object.value,
    "debounceWindowMs",
    `${path}/debounceWindowMs`,
    0,
    "INVALID_BOUNCE_KEYS_SETTINGS",
  );

  if (!enabled.ok) return enabled;
  if (!debounceWindowMs.ok) return debounceWindowMs;

  return accept(Object.freeze({
    debounceWindowMs: debounceWindowMs.value,
    enabled: enabled.value,
  }));
}

function normalizeRawKeyEvents(input: unknown, minAt: number): InputAccessibilityResult<readonly NormalizedKeyEvent[]> {
  const array = snapshotArray(input, "INVALID_KEY_EVENT_STREAM", "/events");

  if (!array.ok) return array;

  const output: NormalizedKeyEvent[] = [];
  let cursorAt = minAt;

  for (let index = 0; index < array.value.length; index += 1) {
    const value = array.value[index];
    const normalized = normalizeRawKeyEvent(value, cursorAt, `/events/${index}`);

    if (!normalized.ok) return normalized;

    output.push(normalized.value);
    cursorAt = normalized.value.at;
  }

  return accept(Object.freeze(output));
}

function normalizeRawKeyEvent(input: unknown, minAt: number, path: string): InputAccessibilityResult<NormalizedKeyEvent> {
  const object = snapshotObject(input, RAW_KEY_EVENT_FIELDS, RAW_KEY_EVENT_FIELDS, "INVALID_KEY_EVENT", path);

  if (!object.ok) return object;

  return normalizedKeyEventFromSnapshot(object.value, minAt, path);
}

function normalizeClockKeyEvent(
  input: unknown,
  clock: InputAccessibilityClock,
): InputAccessibilityResult<InputAccessibilityRawKeyEvent> {
  const object = snapshotObject(
    input,
    CLOCK_KEY_EVENT_FIELDS,
    Object.freeze(["code", "key", "type"]),
    "INVALID_KEY_EVENT",
    "/event",
  );

  if (!object.ok) return object;

  const atValue = object.value.get("at");
  const at = atValue === undefined
    ? readClock(clock, "/event/at")
    : normalizeTimestamp(atValue, 0, "/event/at");

  if (!at.ok) return at;

  const raw = rawKeyEventFromSnapshot(object.value, at.value, "/event");

  if (!raw.ok) return raw;

  return accept(raw.value);
}

function normalizedKeyEventFromSnapshot(
  object: ReadonlyMap<string, unknown>,
  minAt: number,
  path: string,
): InputAccessibilityResult<NormalizedKeyEvent> {
  const atValue = object.get("at");

  if (atValue === undefined) {
    return reject("INVALID_KEY_EVENT", "key event timestamp is required.", `${path}/at`);
  }

  const at = normalizeTimestamp(atValue, minAt, `${path}/at`);

  if (!at.ok) return at;

  const raw = rawKeyEventFromSnapshot(object, at.value, path);

  if (!raw.ok) return raw;

  const keyInfo = keyInfoFor(raw.value.key, raw.value.code);

  if (!keyInfo.ok) return keyInfo;

  return accept(Object.freeze({
    at: raw.value.at,
    code: raw.value.code,
    key: raw.value.key,
    keyId: keyInfo.value.keyId,
    modifier: keyInfo.value.modifier,
    normalizedKey: keyInfo.value.normalizedKey,
    type: raw.value.type,
  }));
}

function rawKeyEventFromSnapshot(
  object: ReadonlyMap<string, unknown>,
  at: number,
  path: string,
): InputAccessibilityResult<InputAccessibilityRawKeyEvent> {
  const key = requiredString(object, "key", `${path}/key`, "INVALID_KEY_EVENT");
  const code = requiredString(object, "code", `${path}/code`, "INVALID_KEY_EVENT");
  const type = requiredKeyEventType(object.get("type"), `${path}/type`);

  if (!key.ok) return key;
  if (!code.ok) return code;
  if (!type.ok) return type;

  return accept(Object.freeze({
    at,
    code: code.value,
    key: key.value,
    type: type.value,
  }));
}

function keyInfoFor(key: string, code: string): InputAccessibilityResult<{
  readonly keyId: string;
  readonly modifier: InputAccessibilityModifier | null;
  readonly normalizedKey: string;
}> {
  const modifier = modifierFromKeyOrCode(key, code);

  if (modifier !== null) {
    return accept(Object.freeze({
      keyId: modifier,
      modifier,
      normalizedKey: modifier,
    }));
  }

  const normalizedFromKey = normalizeKeyToken(key);
  const normalizedFromCode = keyFromCode(code);
  const normalizedKey = normalizedFromKey ?? normalizedFromCode;

  if (normalizedKey === null) {
    return reject("INVALID_KEY_EVENT", "key event requires a non-modifier key.", "/event/key");
  }

  return accept(Object.freeze({
    keyId: normalizedKey,
    modifier: null,
    normalizedKey,
  }));
}

function modifierFromKeyOrCode(key: string, code: string): InputAccessibilityModifier | null {
  const keyModifier = modifierToken(key);

  if (keyModifier !== null) return keyModifier;

  return modifierToken(code);
}

function modifierToken(token: string): InputAccessibilityModifier | null {
  const folded = token.trim().toLocaleLowerCase("en-US");

  switch (folded) {
    case "control":
    case "controlleft":
    case "controlright":
    case "ctrl":
      return "Control";
    case "alt":
    case "altleft":
    case "altright":
    case "option":
      return "Alt";
    case "shift":
    case "shiftleft":
    case "shiftright":
      return "Shift";
    case "cmd":
    case "command":
    case "meta":
    case "metaleft":
    case "metaright":
    case "os":
    case "super":
      return "Meta";
    default:
      return null;
  }
}

function normalizeKeyToken(token: string): string | null {
  if (token === " ") {
    return "Space";
  }

  const trimmed = token.trim();

  if (trimmed.length === 0 || modifierToken(trimmed) !== null) {
    return null;
  }

  const folded = trimmed.toLocaleLowerCase("en-US");

  switch (folded) {
    case " ":
    case "space":
    case "spacebar":
      return "Space";
    case "esc":
    case "escape":
      return "Escape";
    case "return":
    case "enter":
      return "Enter";
    case "tab":
      return "Tab";
    case "backspace":
      return "Backspace";
    case "del":
    case "delete":
      return "Delete";
    case "arrowdown":
    case "down":
      return "ArrowDown";
    case "arrowleft":
    case "left":
      return "ArrowLeft";
    case "arrowright":
    case "right":
      return "ArrowRight";
    case "arrowup":
    case "up":
      return "ArrowUp";
    case ",":
    case "comma":
      return "Comma";
    case ".":
    case "period":
      return "Period";
    case "/":
    case "slash":
      return "Slash";
    case "\\":
    case "backslash":
      return "Backslash";
    case "-":
    case "minus":
      return "Minus";
    case "=":
    case "equal":
      return "Equal";
    case "+":
    case "plus":
      return "Plus";
    case "`":
    case "backquote":
      return "Backquote";
    case ";":
    case "semicolon":
      return "Semicolon";
    case "'":
    case "quote":
      return "Quote";
    case "[":
    case "bracketleft":
      return "BracketLeft";
    case "]":
    case "bracketright":
      return "BracketRight";
    default:
      break;
  }

  if (trimmed.length === 1) {
    return trimmed.toLocaleUpperCase("en-US");
  }

  const functionKey = functionKeyName(folded);

  if (functionKey !== null) return functionKey;

  return `${trimmed.slice(0, 1).toLocaleUpperCase("en-US")}${trimmed.slice(1).toLocaleLowerCase("en-US")}`;
}

function keyFromCode(code: string): string | null {
  const trimmed = code.trim();

  if (trimmed.length === 4 && trimmed.startsWith("Key")) {
    return normalizeKeyToken(trimmed.slice(3));
  }

  if (trimmed.length === 6 && trimmed.startsWith("Digit")) {
    return normalizeKeyToken(trimmed.slice(5));
  }

  return normalizeKeyToken(trimmed);
}

function functionKeyName(folded: string): string | null {
  if (!folded.startsWith("f") || folded.length < 2 || folded.length > 3) {
    return null;
  }

  const number = Number(folded.slice(1));

  if (!Number.isInteger(number) || number < 1 || number > 24) {
    return null;
  }

  return `F${number}`;
}

function buildChord(modifiers: readonly InputAccessibilityModifier[], key: string): string {
  const parts: string[] = [];

  for (let index = 0; index < modifiers.length; index += 1) {
    const modifier = modifiers[index];

    if (modifier !== undefined) parts.push(modifier);
  }

  parts.push(key);

  return parts.join("+");
}

function orderedModifiers(modifiers: ReadonlySet<InputAccessibilityModifier> | readonly InputAccessibilityModifier[]):
  readonly InputAccessibilityModifier[] {
  const output: InputAccessibilityModifier[] = [];

  for (let index = 0; index < MODIFIER_ORDER.length; index += 1) {
    const modifier = MODIFIER_ORDER[index];

    if (modifier !== undefined && containsModifier(modifiers, modifier)) {
      output.push(modifier);
    }
  }

  return Object.freeze(output);
}

function addModifiers(
  target: Set<InputAccessibilityModifier>,
  source: ReadonlySet<InputAccessibilityModifier> | readonly InputAccessibilityModifier[],
): void {
  for (let index = 0; index < MODIFIER_ORDER.length; index += 1) {
    const modifier = MODIFIER_ORDER[index];

    if (modifier !== undefined && containsModifier(source, modifier)) {
      target.add(modifier);
    }
  }
}

function containsModifier(
  modifiers: ReadonlySet<InputAccessibilityModifier> | readonly InputAccessibilityModifier[],
  modifier: InputAccessibilityModifier,
): boolean {
  if (!isModifierArray(modifiers)) return modifiers.has(modifier);

  for (let index = 0; index < modifiers.length; index += 1) {
    if (modifiers[index] === modifier) return true;
  }

  return false;
}

function isModifierArray(
  modifiers: ReadonlySet<InputAccessibilityModifier> | readonly InputAccessibilityModifier[],
): modifiers is readonly InputAccessibilityModifier[] {
  return Array.isArray(modifiers);
}

function freezeState(input: InputAccessibilityState): InputAccessibilityState {
  return Object.freeze({
    activeModifiers: Object.freeze([...input.activeModifiers]),
    chords: Object.freeze(input.chords.map(freezeChordEvent)),
    cursorAt: input.cursorAt,
    heldKeys: Object.freeze(input.heldKeys.map(freezeHeldKeySnapshot)),
    latchedModifiers: Object.freeze([...input.latchedModifiers]),
    lockedModifiers: Object.freeze([...input.lockedModifiers]),
    settings: freezeSettings(input.settings),
  });
}

function freezeSettings(settings: InputAccessibilitySettings): InputAccessibilitySettings {
  return Object.freeze({
    bounceKeys: Object.freeze({
      debounceWindowMs: settings.bounceKeys.debounceWindowMs,
      enabled: settings.bounceKeys.enabled,
    }),
    keyRepeat: Object.freeze({
      enabled: settings.keyRepeat.enabled,
      repeatDelayMs: settings.keyRepeat.repeatDelayMs,
      repeatRateMs: settings.keyRepeat.repeatRateMs,
    }),
    slowKeys: Object.freeze({
      enabled: settings.slowKeys.enabled,
      holdThresholdMs: settings.slowKeys.holdThresholdMs,
    }),
    stickyKeys: Object.freeze({
      enabled: settings.stickyKeys.enabled,
      lockOnDoublePress: settings.stickyKeys.lockOnDoublePress,
    }),
  });
}

function freezeChordEvent(event: InputAccessibilityChordEvent): InputAccessibilityChordEvent {
  return Object.freeze({
    at: event.at,
    chord: event.chord,
    code: event.code,
    key: event.key,
    modifiers: Object.freeze([...event.modifiers]),
    repeat: event.repeat,
    source: event.source,
  });
}

function freezeHeldKeySnapshot(snapshot: InputAccessibilityHeldKeySnapshot): InputAccessibilityHeldKeySnapshot {
  const output: {
    code: string;
    key: string;
    downAt: number;
    suppressed: boolean;
    acceptedAt?: number;
    modifier?: InputAccessibilityModifier;
  } = {
    code: snapshot.code,
    downAt: snapshot.downAt,
    key: snapshot.key,
    suppressed: snapshot.suppressed,
  };

  if (snapshot.acceptedAt !== undefined) output.acceptedAt = snapshot.acceptedAt;
  if (snapshot.modifier !== undefined) output.modifier = snapshot.modifier;

  return Object.freeze(output);
}

function settingsToJson(settings: InputAccessibilitySettings): SettingsWriteValue {
  const value: SettingsWriteValue = Object.freeze({
    bounceKeys: Object.freeze({
      debounceWindowMs: settings.bounceKeys.debounceWindowMs,
      enabled: settings.bounceKeys.enabled,
    }),
    keyRepeat: Object.freeze({
      enabled: settings.keyRepeat.enabled,
      repeatDelayMs: settings.keyRepeat.repeatDelayMs,
      repeatRateMs: settings.keyRepeat.repeatRateMs,
    }),
    slowKeys: Object.freeze({
      enabled: settings.slowKeys.enabled,
      holdThresholdMs: settings.slowKeys.holdThresholdMs,
    }),
    stickyKeys: Object.freeze({
      enabled: settings.stickyKeys.enabled,
      lockOnDoublePress: settings.stickyKeys.lockOnDoublePress,
    }),
  });

  return value;
}

function snapshotObject(
  input: unknown,
  allowedKeys: readonly string[],
  requiredKeys: readonly string[],
  code: string,
  path: string,
): InputAccessibilityResult<ReadonlyMap<string, unknown>> {
  try {
    if (input === null || typeof input !== "object" || Array.isArray(input)) {
      return reject(code, "value must be a plain object.", path);
    }

    const prototype = Object.getPrototypeOf(input);

    if (prototype !== Object.prototype && prototype !== null) {
      return reject(code, "value must be a plain object.", path);
    }

    const keys = Reflect.ownKeys(input);
    const output = new Map<string, unknown>();

    for (let index = 0; index < keys.length; index += 1) {
      const key = keys[index];

      if (key === undefined || typeof key === "symbol" || !contains(allowedKeys, key)) {
        return reject(code, "object contains an unsupported field.", path);
      }

      const descriptor = Object.getOwnPropertyDescriptor(input, key);

      if (descriptor === undefined || !isDataDescriptor(descriptor) || descriptor.enumerable !== true) {
        return reject(code, "object must contain only enumerable data fields.", path);
      }

      output.set(key, descriptor.value);
    }

    for (let index = 0; index < requiredKeys.length; index += 1) {
      const key = requiredKeys[index];

      if (key !== undefined && !output.has(key)) {
        return reject(code, "object is missing a required field.", `${path}/${key}`);
      }
    }

    return accept(output);
  } catch {
    return reject(code, "value must be a stable plain object.", path);
  }
}

function snapshotArray(input: unknown, code: string, path: string): InputAccessibilityResult<readonly unknown[]> {
  try {
    if (!Array.isArray(input) || Object.getPrototypeOf(input) !== Array.prototype) {
      return reject(code, "value must be an array.", path);
    }

    const lengthDescriptor = Object.getOwnPropertyDescriptor(input, ARRAY_LENGTH_KEY);

    if (lengthDescriptor === undefined || !isDataDescriptor(lengthDescriptor)) {
      return reject(code, "array must contain only dense data entries.", path);
    }

    const length = lengthDescriptor.value;

    if (!Number.isSafeInteger(length) || length < 0) {
      return reject(code, "array must contain only dense data entries.", path);
    }

    const keys = Reflect.ownKeys(input);

    for (let index = 0; index < keys.length; index += 1) {
      const key = keys[index];

      if (key === undefined || !isAllowedArrayOwnKey(key, length)) {
        return reject(code, "array must contain only dense data entries.", path);
      }
    }

    const output: unknown[] = [];

    for (let index = 0; index < length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(input, String(index));

      if (descriptor === undefined || !isDataDescriptor(descriptor) || descriptor.enumerable !== true) {
        return reject(code, "array must contain only dense data entries.", `${path}/${index}`);
      }

      output.push(descriptor.value);
    }

    return accept(Object.freeze(output));
  } catch {
    return reject(code, "value must be a stable array.", path);
  }
}

function requiredBoolean(
  object: ReadonlyMap<string, unknown>,
  key: string,
  path: string,
  code: string,
): InputAccessibilityResult<boolean> {
  const value = object.get(key);

  if (typeof value !== "boolean") {
    return reject(code, "field must be boolean.", path);
  }

  return accept(value);
}

function requiredString(
  object: ReadonlyMap<string, unknown>,
  key: string,
  path: string,
  code: string,
): InputAccessibilityResult<string> {
  const value = object.get(key);

  if (typeof value !== "string" || value.length === 0) {
    return reject(code, "field must be a non-empty string.", path);
  }

  return accept(value);
}

function requiredMs(
  object: ReadonlyMap<string, unknown>,
  key: string,
  path: string,
  min: number,
  code: string,
): InputAccessibilityResult<number> {
  const value = object.get(key);

  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min) {
    return reject(code, "field must be a supported millisecond integer.", path);
  }

  return accept(value);
}

function requiredKeyEventType(input: unknown, path: string): InputAccessibilityResult<InputAccessibilityKeyEventType> {
  if (input === "down" || input === "up") {
    return accept(input);
  }

  return reject("INVALID_KEY_EVENT", "key event type must be 'down' or 'up'.", path);
}

function normalizeTimestamp(input: unknown, minAt: number, path: string): InputAccessibilityResult<number> {
  if (typeof input !== "number" || !Number.isSafeInteger(input) || input < 0) {
    return reject("INVALID_KEY_EVENT", "key event timestamp must be a non-negative safe integer.", path);
  }

  if (input < minAt) {
    return reject("NON_MONOTONIC_KEY_EVENT", "key event timestamps must be monotonic.", path);
  }

  return accept(input);
}

function readClock(clock: InputAccessibilityClock, path: string): InputAccessibilityResult<number> {
  try {
    const now = clock.now();

    if (!Number.isSafeInteger(now) || now < 0) {
      return reject("INVALID_CLOCK", "clock must return a non-negative safe integer.", path);
    }

    return accept(now);
  } catch {
    return reject("CLOCK_FAILED", "clock failed closed.", path);
  }
}

function isAllowedArrayOwnKey(key: string | symbol, length: number): boolean {
  if (typeof key === "symbol") return false;
  if (key === ARRAY_LENGTH_KEY) return true;

  const index = Number(key);

  return (
    Number.isInteger(index) &&
    index >= 0 &&
    index < length &&
    String(index) === key
  );
}

function isDataDescriptor(descriptor: PropertyDescriptor): descriptor is PropertyDescriptor & {
  readonly value: unknown;
} {
  return Object.prototype.hasOwnProperty.call(descriptor, "value");
}

function contains(values: readonly string[], value: string): boolean {
  for (let index = 0; index < values.length; index += 1) {
    if (values[index] === value) return true;
  }

  return false;
}

function actionAccept(
  chords: readonly InputAccessibilityChordEvent[],
  state: InputAccessibilityState,
): InputAccessibilityActionResult {
  return Object.freeze({
    chords,
    ok: true,
    state,
  });
}

function actionReject(
  errorValue: InputAccessibilityError,
  state: InputAccessibilityState,
): InputAccessibilityActionResult {
  return Object.freeze({
    error: errorValue,
    ok: false,
    state,
  });
}

function accept<T>(value: T): NormalizeResult<T> {
  return Object.freeze({
    ok: true,
    value,
  });
}

function reject<T>(code: string, message: string, path: string): InputAccessibilityResult<T> {
  return Object.freeze({
    error: error(code, message, path),
    ok: false,
  });
}

function rejectFromHost<T>(errorValue: DesktopHostError): InputAccessibilityResult<T> {
  return reject(errorValue.code, errorValue.message, errorValue.path);
}

function error(code: string, message: string, path: string): InputAccessibilityError {
  return Object.freeze({
    code,
    message,
    path,
  });
}

function emptyPorts(): InputAccessibilityPorts {
  return Object.freeze({
    package: Object.freeze({
      capabilityGrants: Object.freeze([]),
      entry: "./input-accessibility.ts",
      id: "ui.input-accessibility.pure",
      sdkVersion: "1.0.0",
      version: "1.0.0",
    }),
  });
}

function staticClock(now: number): InputAccessibilityClock {
  return Object.freeze({
    now() {
      return now;
    },
  });
}
