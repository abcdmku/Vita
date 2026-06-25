import {
  hasDesktopCapabilityGrant,
} from "../../../sdk/typescript/src/desktop-sdk/index.ts";
import type {
  DesktopHost,
  DesktopHostError,
  DesktopHostResult,
  DesktopLauncherIntent,
} from "../../../sdk/typescript/src/desktop-sdk/index.ts";

export type ShortcutBindingSource = "default" | "user";
export type ShortcutChord = string;

export interface ShortcutKeyEvent {
  readonly altKey?: boolean;
  readonly code?: string;
  readonly ctrlKey?: boolean;
  readonly key?: string;
  readonly metaKey?: boolean;
  readonly shiftKey?: boolean;
}

export interface ShortcutCommand {
  readonly id: string;
  readonly title: string;
  readonly intent: DesktopLauncherIntent;
}

export interface ShortcutBindingInput {
  readonly chord: string;
  readonly commandId: string;
}

export interface ShortcutBinding {
  readonly chord: ShortcutChord;
  readonly commandId: string;
  readonly source: ShortcutBindingSource;
}

export interface ShortcutPersistenceBinding {
  readonly chord: ShortcutChord;
  readonly commandId: string;
}

export interface ShortcutConflict {
  readonly chord: ShortcutChord;
  readonly commandIds: readonly string[];
  readonly bindings: readonly ShortcutBinding[];
}

export interface ShortcutsState {
  readonly commands: readonly ShortcutCommand[];
  readonly defaults: readonly ShortcutBinding[];
  readonly userOverrides: readonly ShortcutBinding[];
  readonly bindings: readonly ShortcutBinding[];
  readonly conflicts: readonly ShortcutConflict[];
}

export interface ShortcutRegistryOptions {
  readonly commands?: readonly ShortcutCommand[];
  readonly defaults?: readonly ShortcutBindingInput[];
  readonly userOverrides?: readonly ShortcutBindingInput[];
}

export interface ShortcutError {
  readonly code: string;
  readonly message: string;
  readonly path: string;
}

export type ShortcutNormalizeResult =
  | {
      readonly ok: true;
      readonly chord: ShortcutChord;
    }
  | {
      readonly ok: false;
      readonly error: ShortcutError;
    };

export type ShortcutMutationResult =
  | {
      readonly ok: true;
      readonly binding: ShortcutBinding;
      readonly state: ShortcutsState;
    }
  | {
      readonly ok: false;
      readonly error: ShortcutError;
      readonly state: ShortcutsState;
      readonly conflict?: ShortcutConflict;
    };

export type ShortcutResetResult =
  | {
      readonly ok: true;
      readonly state: ShortcutsState;
    }
  | {
      readonly ok: false;
      readonly error: ShortcutError;
      readonly state: ShortcutsState;
      readonly conflict?: ShortcutConflict;
    };

export type ShortcutResolveResult =
  | {
      readonly ok: true;
      readonly binding: ShortcutBinding;
      readonly chord: ShortcutChord;
      readonly command: ShortcutCommand;
    }
  | {
      readonly ok: false;
      readonly binding?: ShortcutBinding;
      readonly chord?: ShortcutChord;
      readonly error: ShortcutError;
      readonly conflict?: ShortcutConflict;
    };

export type ShortcutDispatchResult =
  | {
      readonly ok: true;
      readonly binding: ShortcutBinding;
      readonly chord: ShortcutChord;
      readonly command: ShortcutCommand;
      readonly dispatch: "launcherIntent";
      readonly value: true;
    }
  | {
      readonly ok: false;
      readonly binding?: ShortcutBinding;
      readonly chord?: ShortcutChord;
      readonly command?: ShortcutCommand;
      readonly conflict?: ShortcutConflict;
      readonly error: ShortcutError;
    };

export type ShortcutCommandPort = Pick<DesktopHost, "emitLauncherIntent" | "package">;

export interface ShortcutsViewModel {
  snapshot(): ShortcutsState;
  list(): readonly ShortcutBinding[];
  serialize(): readonly ShortcutPersistenceBinding[];
  deserialize(userOverrides: unknown): ShortcutsViewModel;
  register(chord: unknown, commandId: unknown): ShortcutMutationResult;
  rebind(commandId: unknown, chord: unknown): ShortcutMutationResult;
  reset(commandId: unknown): ShortcutResetResult;
  resolve(input: unknown): ShortcutResolveResult;
  dispatch(input: unknown): Promise<ShortcutDispatchResult>;
  handleKeyEvent(input: unknown): Promise<ShortcutDispatchResult>;
}

type NormalizeResult<T> =
  | {
      readonly ok: true;
      readonly value: T;
    }
  | {
      readonly ok: false;
      readonly error: ShortcutError;
    };

const MODIFIER_ORDER = Object.freeze(["Control", "Alt", "Shift", "Meta"] as const);
const KEY_EVENT_FIELDS = Object.freeze(["altKey", "code", "ctrlKey", "key", "metaKey", "shiftKey"]);

export const SHORTCUT_COMMAND_IDS = Object.freeze({
  closeLauncher: "desktop.launcher.close",
  launchSettings: "desktop.settings.open",
  openLauncher: "desktop.launcher.open",
  toggleDarkMode: "desktop.theme.toggle",
});

export const DEFAULT_SHORTCUT_COMMANDS = Object.freeze([
  Object.freeze({
    id: SHORTCUT_COMMAND_IDS.openLauncher,
    intent: Object.freeze({
      type: "launcher.open",
    }),
    title: "Open Launcher",
  }),
  Object.freeze({
    id: SHORTCUT_COMMAND_IDS.closeLauncher,
    intent: Object.freeze({
      type: "launcher.close",
    }),
    title: "Close Launcher",
  }),
  Object.freeze({
    id: SHORTCUT_COMMAND_IDS.launchSettings,
    intent: Object.freeze({
      appId: "vita.app.settings",
      query: "settings",
      type: "launcher.launch",
    }),
    title: "Open Settings",
  }),
  Object.freeze({
    id: SHORTCUT_COMMAND_IDS.toggleDarkMode,
    intent: Object.freeze({
      appId: "vita.command.toggle-dark-mode",
      query: "theme.dark.toggle",
      type: "launcher.launch",
    }),
    title: "Toggle Dark Mode",
  }),
] satisfies readonly ShortcutCommand[]);

export const DEFAULT_SHORTCUT_BINDINGS = Object.freeze([
  Object.freeze({
    chord: "Control+Space",
    commandId: SHORTCUT_COMMAND_IDS.openLauncher,
  }),
  Object.freeze({
    chord: "Escape",
    commandId: SHORTCUT_COMMAND_IDS.closeLauncher,
  }),
  Object.freeze({
    chord: "Control+Comma",
    commandId: SHORTCUT_COMMAND_IDS.launchSettings,
  }),
  Object.freeze({
    chord: "Control+Shift+D",
    commandId: SHORTCUT_COMMAND_IDS.toggleDarkMode,
  }),
] satisfies readonly ShortcutBindingInput[]);

export function createShortcutsViewModel(
  ports: ShortcutCommandPort,
  options: ShortcutRegistryOptions = Object.freeze({}),
): ShortcutsViewModel {
  return new DesktopShortcutsViewModel(ports, options);
}

export function normalizeShortcutChord(input: unknown): ShortcutNormalizeResult {
  if (typeof input === "string") {
    return normalizeChordString(input, "/chord");
  }

  return normalizeKeyEvent(input);
}

export function detectShortcutConflicts(bindings: readonly ShortcutBinding[]): readonly ShortcutConflict[] {
  return conflictsForBindings(normalizeConflictBindings(bindings));
}

class DesktopShortcutsViewModel implements ShortcutsViewModel {
  readonly #commandById: ReadonlyMap<string, ShortcutCommand>;
  readonly #commands: readonly ShortcutCommand[];
  readonly #defaults: readonly ShortcutBinding[];
  readonly #ports: ShortcutCommandPort;
  #state: ShortcutsState;
  #userOverrides: readonly ShortcutBinding[];

  constructor(ports: ShortcutCommandPort, options: ShortcutRegistryOptions) {
    this.#ports = ports;
    this.#commands = freezeCommands(options.commands ?? DEFAULT_SHORTCUT_COMMANDS);
    this.#commandById = commandMap(this.#commands);
    this.#defaults = freezeBindingInputs(options.defaults ?? DEFAULT_SHORTCUT_BINDINGS, "default");
    this.#userOverrides = freezeBindingInputs(options.userOverrides ?? Object.freeze([]), "user");
    this.#state = stateFor(this.#commands, this.#defaults, this.#userOverrides);
  }

  snapshot(): ShortcutsState {
    return this.#state;
  }

  list(): readonly ShortcutBinding[] {
    return this.#state.bindings;
  }

  serialize(): readonly ShortcutPersistenceBinding[] {
    return serializeUserOverrides(this.#commands, this.#userOverrides);
  }

  deserialize(userOverrides: unknown): ShortcutsViewModel {
    const normalizedOverrides = deserializeUserOverrides(userOverrides, this.#commands, this.#defaults);

    return new DesktopShortcutsViewModel(this.#ports, {
      commands: this.#commands,
      defaults: this.#defaults,
      userOverrides: normalizedOverrides,
    });
  }

  register(chord: unknown, commandId: unknown): ShortcutMutationResult {
    if (typeof commandId !== "string" || commandId.length === 0) {
      return rejectMutation(error("UNKNOWN_COMMAND", "shortcut command is not registered.", "/commandId"), this.#state);
    }

    const command = this.#commandById.get(commandId);

    if (command === undefined) {
      return rejectMutation(error(
        "UNKNOWN_COMMAND",
        `shortcut command '${commandId}' is not registered.`,
        `/commands/${pathToken(commandId)}`,
      ), this.#state);
    }

    const normalized = normalizeShortcutChord(chord);

    if (!normalized.ok) {
      return rejectMutation(normalized.error, this.#state);
    }

    const binding = freezeBinding({
      chord: normalized.chord,
      commandId: command.id,
      source: "user",
    });
    const proposedOverrides = replaceUserOverride(this.#userOverrides, binding);
    const proposed = stateFor(this.#commands, this.#defaults, proposedOverrides);

    if (proposed.conflicts.length > 0) {
      return rejectMutation(conflictError(proposed.conflicts[0]), this.#state, proposed.conflicts[0]);
    }

    this.#userOverrides = proposedOverrides;
    this.#state = proposed;

    return Object.freeze({
      binding,
      ok: true,
      state: this.#state,
    });
  }

  rebind(commandId: unknown, chord: unknown): ShortcutMutationResult {
    return this.register(chord, commandId);
  }

  reset(commandId: unknown): ShortcutResetResult {
    if (typeof commandId !== "string" || commandId.length === 0 || !this.#commandById.has(commandId)) {
      return rejectReset(error("UNKNOWN_COMMAND", "shortcut command is not registered.", "/commandId"), this.#state);
    }

    const proposedOverrides = removeUserOverride(this.#userOverrides, commandId);
    const proposed = stateFor(this.#commands, this.#defaults, proposedOverrides);

    if (proposed.conflicts.length > 0) {
      return rejectReset(conflictError(proposed.conflicts[0]), this.#state, proposed.conflicts[0]);
    }

    this.#userOverrides = proposedOverrides;
    this.#state = proposed;

    return Object.freeze({
      ok: true,
      state: this.#state,
    });
  }

  resolve(input: unknown): ShortcutResolveResult {
    const normalized = normalizeShortcutChord(input);

    if (!normalized.ok) {
      return Object.freeze({
        error: normalized.error,
        ok: false,
      });
    }

    const matching = bindingsForChord(this.#state.bindings, normalized.chord);

    if (matching.length === 0) {
      return Object.freeze({
        chord: normalized.chord,
        error: error("UNBOUND_CHORD", "shortcut chord is not bound.", `/bindings/${pathToken(normalized.chord)}`),
        ok: false,
      });
    }

    const conflict = conflictForBindings(normalized.chord, matching);

    if (conflict !== null) {
      return Object.freeze({
        chord: normalized.chord,
        conflict,
        error: conflictError(conflict),
        ok: false,
      });
    }

    const binding = matching[0];

    if (binding === undefined) {
      return Object.freeze({
        chord: normalized.chord,
        error: error("UNBOUND_CHORD", "shortcut chord is not bound.", `/bindings/${pathToken(normalized.chord)}`),
        ok: false,
      });
    }

    const command = this.#commandById.get(binding.commandId);

    if (command === undefined) {
      return Object.freeze({
        binding,
        chord: normalized.chord,
        error: error(
          "UNKNOWN_COMMAND",
          `shortcut command '${binding.commandId}' is not registered.`,
          `/commands/${pathToken(binding.commandId)}`,
        ),
        ok: false,
      });
    }

    return Object.freeze({
      binding,
      chord: normalized.chord,
      command,
      ok: true,
    });
  }

  async dispatch(input: unknown): Promise<ShortcutDispatchResult> {
    const resolved = this.resolve(input);

    if (!resolved.ok) {
      return rejectDispatch(resolved.error, resolved);
    }

    if (!hasDesktopCapabilityGrant(this.#ports.package, "launcher.launch", resolved.command.intent.appId)) {
      return rejectDispatch(error(
        "MISSING_CAPABILITY",
        `shortcut command '${resolved.command.id}' requires launcher.launch.`,
        `/commands/${pathToken(resolved.command.id)}/capability`,
      ), resolved);
    }

    const emitLauncherIntent = this.#ports.emitLauncherIntent;

    if (emitLauncherIntent === undefined) {
      return rejectDispatch(error(
        "COMMAND_PORT_UNAVAILABLE",
        "launcher command port is unavailable.",
        "/launcher",
      ), resolved);
    }

    let result: DesktopHostResult<true>;

    try {
      result = await emitLauncherIntent(resolved.command.intent);
    } catch {
      return rejectDispatch(error(
        "COMMAND_PORT_FAILED",
        "launcher command port failed closed.",
        `/commands/${pathToken(resolved.command.id)}/launcher`,
      ), resolved);
    }

    if (!result.ok) {
      return rejectDispatch(hostError(result.error), resolved);
    }

    return Object.freeze({
      binding: resolved.binding,
      chord: resolved.chord,
      command: resolved.command,
      dispatch: "launcherIntent",
      ok: true,
      value: result.value,
    });
  }

  async handleKeyEvent(input: unknown): Promise<ShortcutDispatchResult> {
    return await this.dispatch(input);
  }
}

function normalizeChordString(input: string, path: string): ShortcutNormalizeResult {
  const trimmed = input.trim();

  if (trimmed.length === 0) {
    return rejectNormalize("INVALID_CHORD", "shortcut chord must not be empty.", path);
  }

  const parts = trimmed.split("+");
  const modifiers = new Set<string>();
  let key: string | null = null;

  for (let index = 0; index < parts.length; index += 1) {
    const raw = parts[index];

    if (raw === undefined) continue;

    const token = raw.trim();

    if (token.length === 0) {
      return rejectNormalize("INVALID_CHORD", "shortcut chord contains an empty token.", path);
    }

    const modifier = modifierToken(token);

    if (modifier !== null) {
      modifiers.add(modifier);
      continue;
    }

    const normalizedKey = normalizeKeyToken(token);

    if (normalizedKey === null) {
      return rejectNormalize("INVALID_CHORD", "shortcut chord requires a non-modifier key.", path);
    }

    if (key !== null) {
      return rejectNormalize("INVALID_CHORD", "shortcut chord must contain exactly one key.", path);
    }

    key = normalizedKey;
  }

  if (key === null) {
    return rejectNormalize("INVALID_CHORD", "shortcut chord requires a non-modifier key.", path);
  }

  return Object.freeze({
    chord: buildChord(modifiers, key),
    ok: true,
  });
}

function normalizeKeyEvent(input: unknown): ShortcutNormalizeResult {
  const event = snapshotObject(input, KEY_EVENT_FIELDS, "INVALID_KEY_EVENT", "/event");

  if (!event.ok) {
    return rejectNormalizeFromError(event.error);
  }

  const modifiers = new Set<string>();
  const ctrlKey = booleanField(event.value, "ctrlKey", "/event/ctrlKey");
  const altKey = booleanField(event.value, "altKey", "/event/altKey");
  const shiftKey = booleanField(event.value, "shiftKey", "/event/shiftKey");
  const metaKey = booleanField(event.value, "metaKey", "/event/metaKey");

  if (!ctrlKey.ok) return rejectNormalizeFromError(ctrlKey.error);
  if (!altKey.ok) return rejectNormalizeFromError(altKey.error);
  if (!shiftKey.ok) return rejectNormalizeFromError(shiftKey.error);
  if (!metaKey.ok) return rejectNormalizeFromError(metaKey.error);

  if (ctrlKey.value) modifiers.add("Control");
  if (altKey.value) modifiers.add("Alt");
  if (shiftKey.value) modifiers.add("Shift");
  if (metaKey.value) modifiers.add("Meta");

  const keyValue = event.value.get("key");
  const codeValue = event.value.get("code");
  let normalizedKey: string | null = null;

  if (keyValue !== undefined) {
    if (typeof keyValue !== "string") {
      return rejectNormalize("INVALID_KEY_EVENT", "shortcut key must be a string.", "/event/key");
    }

    normalizedKey = normalizeKeyToken(keyValue);
  }

  if (normalizedKey === null && codeValue !== undefined) {
    if (typeof codeValue !== "string") {
      return rejectNormalize("INVALID_KEY_EVENT", "shortcut code must be a string.", "/event/code");
    }

    normalizedKey = keyFromCode(codeValue);
  }

  if (normalizedKey === null) {
    return rejectNormalize("INVALID_KEY_EVENT", "shortcut key event requires a non-modifier key.", "/event/key");
  }

  return Object.freeze({
    chord: buildChord(modifiers, normalizedKey),
    ok: true,
  });
}

function buildChord(modifiers: ReadonlySet<string>, key: string): ShortcutChord {
  const parts: string[] = [];

  for (let index = 0; index < MODIFIER_ORDER.length; index += 1) {
    const modifier = MODIFIER_ORDER[index];

    if (modifier !== undefined && modifiers.has(modifier)) {
      parts.push(modifier);
    }
  }

  parts.push(key);

  return parts.join("+");
}

function modifierToken(token: string): string | null {
  switch (token.trim().toLocaleLowerCase("en-US")) {
    case "control":
    case "ctrl":
      return "Control";
    case "alt":
    case "option":
      return "Alt";
    case "shift":
      return "Shift";
    case "cmd":
    case "command":
    case "meta":
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

  if (functionKey !== null) {
    return functionKey;
  }

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

function freezeCommands(commands: readonly ShortcutCommand[]): readonly ShortcutCommand[] {
  const output: ShortcutCommand[] = [];
  const seen = new Set<string>();

  for (let index = 0; index < commands.length; index += 1) {
    const command = commands[index];

    if (command === undefined || !isValidCommand(command) || seen.has(command.id)) {
      continue;
    }

    seen.add(command.id);
    output.push(freezeCommand(command));
  }

  return Object.freeze(output);
}

function isValidCommand(command: ShortcutCommand): boolean {
  return (
    typeof command.id === "string" &&
    command.id.length > 0 &&
    typeof command.title === "string" &&
    command.title.length > 0 &&
    isLauncherIntent(command.intent)
  );
}

function isLauncherIntent(intent: DesktopLauncherIntent): boolean {
  if (intent === null || typeof intent !== "object") {
    return false;
  }

  if (
    intent.type !== "launcher.close" &&
    intent.type !== "launcher.launch" &&
    intent.type !== "launcher.open"
  ) {
    return false;
  }

  if (intent.appId !== undefined && typeof intent.appId !== "string") {
    return false;
  }

  return intent.query === undefined || typeof intent.query === "string";
}

function freezeCommand(command: ShortcutCommand): ShortcutCommand {
  return Object.freeze({
    id: command.id,
    intent: freezeLauncherIntent(command.intent),
    title: command.title,
  });
}

function freezeLauncherIntent(intent: DesktopLauncherIntent): DesktopLauncherIntent {
  const output: {
    type: DesktopLauncherIntent["type"];
    appId?: string;
    query?: string;
  } = {
    type: intent.type,
  };

  if (intent.appId !== undefined) output.appId = intent.appId;
  if (intent.query !== undefined) output.query = intent.query;

  return Object.freeze(output);
}

function commandMap(commands: readonly ShortcutCommand[]): ReadonlyMap<string, ShortcutCommand> {
  const output = new Map<string, ShortcutCommand>();

  for (let index = 0; index < commands.length; index += 1) {
    const command = commands[index];

    if (command !== undefined && !output.has(command.id)) {
      output.set(command.id, command);
    }
  }

  return output;
}

function freezeBindingInputs(
  bindings: readonly ShortcutBindingInput[],
  source: ShortcutBindingSource,
): readonly ShortcutBinding[] {
  const output: ShortcutBinding[] = [];

  for (let index = 0; index < bindings.length; index += 1) {
    const binding = bindings[index];

    if (binding === undefined || typeof binding.commandId !== "string" || binding.commandId.length === 0) {
      continue;
    }

    const normalized = normalizeShortcutChord(binding.chord);

    if (!normalized.ok) {
      continue;
    }

    output.push(freezeBinding({
      chord: normalized.chord,
      commandId: binding.commandId,
      source,
    }));
  }

  return Object.freeze(output);
}

function freezeBinding(binding: ShortcutBinding): ShortcutBinding {
  return Object.freeze({
    chord: binding.chord,
    commandId: binding.commandId,
    source: binding.source,
  });
}

function freezePersistenceBinding(binding: ShortcutPersistenceBinding): ShortcutPersistenceBinding {
  return Object.freeze({
    chord: binding.chord,
    commandId: binding.commandId,
  });
}

function serializeUserOverrides(
  commands: readonly ShortcutCommand[],
  userOverrides: readonly ShortcutBinding[],
): readonly ShortcutPersistenceBinding[] {
  const output: ShortcutPersistenceBinding[] = [];

  for (let commandIndex = 0; commandIndex < commands.length; commandIndex += 1) {
    const command = commands[commandIndex];

    if (command === undefined) {
      continue;
    }

    for (let overrideIndex = 0; overrideIndex < userOverrides.length; overrideIndex += 1) {
      const binding = userOverrides[overrideIndex];

      if (binding !== undefined && binding.commandId === command.id) {
        output.push(freezePersistenceBinding({
          chord: binding.chord,
          commandId: binding.commandId,
        }));
        break;
      }
    }
  }

  return Object.freeze(output);
}

function deserializeUserOverrides(
  input: unknown,
  commands: readonly ShortcutCommand[],
  defaults: readonly ShortcutBinding[],
): readonly ShortcutPersistenceBinding[] {
  const entries = snapshotArray(input);

  if (entries === null) {
    return Object.freeze([]);
  }

  const commandById = commandMap(commands);
  let accepted: readonly ShortcutBinding[] = Object.freeze([]);

  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    const normalized = normalizePersistenceEntry(entry, commandById);

    if (!normalized.ok || hasUserOverride(accepted, normalized.value.commandId)) {
      continue;
    }

    const binding = freezeBinding({
      chord: normalized.value.chord,
      commandId: normalized.value.commandId,
      source: "user",
    });
    const proposed = replaceUserOverride(accepted, binding);
    const proposedState = stateFor(commands, defaults, proposed);

    if (proposedState.conflicts.length === 0) {
      accepted = proposed;
    }
  }

  return serializeUserOverrides(commands, accepted);
}

function normalizePersistenceEntry(
  input: unknown,
  commandById: ReadonlyMap<string, ShortcutCommand>,
): NormalizeResult<ShortcutPersistenceBinding> {
  const entry = snapshotObject(input, Object.freeze(["chord", "commandId"]), "INVALID_SHORTCUT_OVERRIDE", "/overrides");

  if (!entry.ok) {
    return reject(entry.error);
  }

  const commandId = entry.value.get("commandId");

  if (typeof commandId !== "string" || commandId.length === 0 || !commandById.has(commandId)) {
    return reject(error("UNKNOWN_COMMAND", "shortcut command is not registered.", "/overrides/commandId"));
  }

  const chord = entry.value.get("chord");

  if (typeof chord !== "string") {
    return reject(error("INVALID_CHORD", "shortcut chord must be a string.", "/overrides/chord"));
  }

  const normalized = normalizeShortcutChord(chord);

  if (!normalized.ok) {
    return reject(normalized.error);
  }

  return accept(freezePersistenceBinding({
    chord: normalized.chord,
    commandId,
  }));
}

function stateFor(
  commands: readonly ShortcutCommand[],
  defaults: readonly ShortcutBinding[],
  userOverrides: readonly ShortcutBinding[],
): ShortcutsState {
  const active: ShortcutBinding[] = [];

  for (let index = 0; index < defaults.length; index += 1) {
    const binding = defaults[index];

    if (binding !== undefined && !hasUserOverride(userOverrides, binding.commandId)) {
      active.push(binding);
    }
  }

  for (let index = 0; index < userOverrides.length; index += 1) {
    const binding = userOverrides[index];

    if (binding !== undefined) {
      active.push(binding);
    }
  }

  return Object.freeze({
    bindings: Object.freeze(active),
    commands,
    conflicts: conflictsForBindings(active),
    defaults,
    userOverrides,
  });
}

function hasUserOverride(bindings: readonly ShortcutBinding[], commandId: string): boolean {
  for (let index = 0; index < bindings.length; index += 1) {
    if (bindings[index]?.commandId === commandId) {
      return true;
    }
  }

  return false;
}

function replaceUserOverride(
  bindings: readonly ShortcutBinding[],
  replacement: ShortcutBinding,
): readonly ShortcutBinding[] {
  const output: ShortcutBinding[] = [];
  let replaced = false;

  for (let index = 0; index < bindings.length; index += 1) {
    const binding = bindings[index];

    if (binding === undefined) {
      continue;
    }

    if (binding.commandId === replacement.commandId) {
      if (!replaced) {
        output.push(replacement);
        replaced = true;
      }
      continue;
    }

    output.push(binding);
  }

  if (!replaced) {
    output.push(replacement);
  }

  return Object.freeze(output);
}

function removeUserOverride(bindings: readonly ShortcutBinding[], commandId: string): readonly ShortcutBinding[] {
  const output: ShortcutBinding[] = [];

  for (let index = 0; index < bindings.length; index += 1) {
    const binding = bindings[index];

    if (binding !== undefined && binding.commandId !== commandId) {
      output.push(binding);
    }
  }

  return Object.freeze(output);
}

function bindingsForChord(bindings: readonly ShortcutBinding[], chord: ShortcutChord): readonly ShortcutBinding[] {
  const output: ShortcutBinding[] = [];

  for (let index = 0; index < bindings.length; index += 1) {
    const binding = bindings[index];

    if (binding !== undefined && binding.chord === chord) {
      output.push(binding);
    }
  }

  return Object.freeze(output);
}

function conflictsForBindings(bindings: readonly ShortcutBinding[]): readonly ShortcutConflict[] {
  const chords: string[] = [];
  const byChord = new Map<string, ShortcutBinding[]>();

  for (let index = 0; index < bindings.length; index += 1) {
    const binding = bindings[index];

    if (binding === undefined) {
      continue;
    }

    let grouped = byChord.get(binding.chord);

    if (grouped === undefined) {
      grouped = [];
      byChord.set(binding.chord, grouped);
      chords.push(binding.chord);
    }

    grouped.push(binding);
  }

  const conflicts: ShortcutConflict[] = [];

  for (let index = 0; index < chords.length; index += 1) {
    const chord = chords[index];

    if (chord === undefined) {
      continue;
    }

    const grouped = byChord.get(chord);

    if (grouped === undefined) {
      continue;
    }

    const conflict = conflictForBindings(chord, grouped);

    if (conflict !== null) {
      conflicts.push(conflict);
    }
  }

  return Object.freeze(conflicts);
}

function normalizeConflictBindings(bindings: readonly ShortcutBinding[]): readonly ShortcutBinding[] {
  const output: ShortcutBinding[] = [];

  for (let index = 0; index < bindings.length; index += 1) {
    const binding = bindings[index];

    if (binding === undefined) {
      continue;
    }

    const normalized = normalizeShortcutChord(binding.chord);

    if (normalized.ok) {
      output.push(freezeBinding({
        chord: normalized.chord,
        commandId: binding.commandId,
        source: binding.source,
      }));
    }
  }

  return Object.freeze(output);
}

function conflictForBindings(
  chord: ShortcutChord,
  bindings: readonly ShortcutBinding[],
): ShortcutConflict | null {
  const commandIds: string[] = [];

  for (let index = 0; index < bindings.length; index += 1) {
    const binding = bindings[index];

    if (binding === undefined || contains(commandIds, binding.commandId)) {
      continue;
    }

    commandIds.push(binding.commandId);
  }

  if (commandIds.length < 2) {
    return null;
  }

  return Object.freeze({
    bindings: Object.freeze([...bindings]),
    chord,
    commandIds: Object.freeze(commandIds),
  });
}

function snapshotObject(
  input: unknown,
  allowedKeys: readonly string[],
  code: string,
  path: string,
): NormalizeResult<ReadonlyMap<string, unknown>> {
  try {
    if (input === null || typeof input !== "object" || Array.isArray(input)) {
      return reject(error(code, "value must be a plain object.", path));
    }

    const prototype = Object.getPrototypeOf(input);

    if (prototype !== Object.prototype && prototype !== null) {
      return reject(error(code, "value must be a plain object.", path));
    }

    const keys = Reflect.ownKeys(input);
    const output = new Map<string, unknown>();

    for (let index = 0; index < keys.length; index += 1) {
      const key = keys[index];

      if (key === undefined || typeof key === "symbol" || !contains(allowedKeys, key)) {
        return reject(error(code, "object contains an unsupported field.", path));
      }

      const descriptor = Object.getOwnPropertyDescriptor(input, key);

      if (descriptor === undefined || !isDataDescriptor(descriptor) || descriptor.enumerable !== true) {
        return reject(error(code, "object must contain only enumerable data fields.", path));
      }

      output.set(key, descriptor.value);
    }

    return accept(output);
  } catch {
    return reject(error(code, "value must be a stable plain object.", path));
  }
}

function snapshotArray(input: unknown): readonly unknown[] | null {
  try {
    if (!Array.isArray(input)) {
      return null;
    }

    const keys = Reflect.ownKeys(input);
    const indexed: {
      readonly index: number;
      readonly value: unknown;
    }[] = [];

    for (let keyIndex = 0; keyIndex < keys.length; keyIndex += 1) {
      const key = keys[keyIndex];

      if (key === undefined || typeof key === "symbol") {
        return null;
      }

      if (key === "length") {
        continue;
      }

      const index = arrayIndex(key);

      if (index === null) {
        return null;
      }

      const descriptor = Object.getOwnPropertyDescriptor(input, key);

      if (descriptor === undefined || !isDataDescriptor(descriptor) || descriptor.enumerable !== true) {
        return null;
      }

      indexed.push(Object.freeze({
        index,
        value: descriptor.value,
      }));
    }

    indexed.sort((left, right) => left.index - right.index);

    const output: unknown[] = [];

    for (let index = 0; index < indexed.length; index += 1) {
      const entry = indexed[index];

      if (entry !== undefined) {
        output.push(entry.value);
      }
    }

    return Object.freeze(output);
  } catch {
    return null;
  }
}

function arrayIndex(key: string): number | null {
  if (key.length === 0) {
    return null;
  }

  if (key.length > 1 && key[0] === "0") {
    return null;
  }

  for (let index = 0; index < key.length; index += 1) {
    const code = key.charCodeAt(index);

    if (code < 48 || code > 57) {
      return null;
    }
  }

  const value = Number(key);

  if (!Number.isSafeInteger(value) || value < 0 || value >= 4294967295) {
    return null;
  }

  return value;
}

function booleanField(
  object: ReadonlyMap<string, unknown>,
  key: string,
  path: string,
): NormalizeResult<boolean> {
  const value = object.get(key);

  if (value === undefined) {
    return accept(false);
  }

  if (typeof value !== "boolean") {
    return reject(error("INVALID_KEY_EVENT", "shortcut modifier flag must be boolean.", path));
  }

  return accept(value);
}

function contains(values: readonly string[], value: string): boolean {
  for (let index = 0; index < values.length; index += 1) {
    if (values[index] === value) {
      return true;
    }
  }

  return false;
}

function isDataDescriptor(descriptor: PropertyDescriptor): descriptor is PropertyDescriptor & {
  readonly value: unknown;
} {
  return Object.prototype.hasOwnProperty.call(descriptor, "value");
}

function rejectNormalize(code: string, message: string, path: string): ShortcutNormalizeResult {
  return Object.freeze({
    error: error(code, message, path),
    ok: false,
  });
}

function rejectNormalizeFromError(errorValue: ShortcutError): ShortcutNormalizeResult {
  return Object.freeze({
    error: errorValue,
    ok: false,
  });
}

function rejectMutation(
  errorValue: ShortcutError,
  state: ShortcutsState,
  conflict?: ShortcutConflict,
): ShortcutMutationResult {
  const output: {
    ok: false;
    error: ShortcutError;
    state: ShortcutsState;
    conflict?: ShortcutConflict;
  } = {
    error: errorValue,
    ok: false,
    state,
  };

  if (conflict !== undefined) {
    output.conflict = conflict;
  }

  return Object.freeze(output);
}

function rejectReset(
  errorValue: ShortcutError,
  state: ShortcutsState,
  conflict?: ShortcutConflict,
): ShortcutResetResult {
  const output: {
    ok: false;
    error: ShortcutError;
    state: ShortcutsState;
    conflict?: ShortcutConflict;
  } = {
    error: errorValue,
    ok: false,
    state,
  };

  if (conflict !== undefined) {
    output.conflict = conflict;
  }

  return Object.freeze(output);
}

function rejectDispatch(
  errorValue: ShortcutError,
  resolved?: ShortcutResolveResult,
): ShortcutDispatchResult {
  const output: {
    ok: false;
    binding?: ShortcutBinding;
    chord?: ShortcutChord;
    command?: ShortcutCommand;
    conflict?: ShortcutConflict;
    error: ShortcutError;
  } = {
    error: errorValue,
    ok: false,
  };

  if (resolved !== undefined && "chord" in resolved && resolved.chord !== undefined) {
    output.chord = resolved.chord;
  }
  if (resolved !== undefined && "binding" in resolved && resolved.binding !== undefined) {
    output.binding = resolved.binding;
  }
  if (resolved !== undefined && "command" in resolved && resolved.command !== undefined) {
    output.command = resolved.command;
  }
  if (resolved !== undefined && "conflict" in resolved && resolved.conflict !== undefined) {
    output.conflict = resolved.conflict;
  }

  return Object.freeze(output);
}

function conflictError(conflict: ShortcutConflict | undefined): ShortcutError {
  if (conflict === undefined) {
    return error("SHORTCUT_CONFLICT", "shortcut chord conflicts with another command.", "/bindings");
  }

  return error(
    "SHORTCUT_CONFLICT",
    `shortcut chord '${conflict.chord}' is already bound.`,
    `/bindings/${pathToken(conflict.chord)}/conflict`,
  );
}

function hostError(errorValue: DesktopHostError): ShortcutError {
  return error(errorValue.code, errorValue.message, errorValue.path);
}

function error(code: string, message: string, path: string): ShortcutError {
  return Object.freeze({
    code,
    message,
    path,
  });
}

function accept<T>(value: T): NormalizeResult<T> {
  return Object.freeze({
    ok: true,
    value,
  });
}

function reject<T>(errorValue: ShortcutError): NormalizeResult<T> {
  return Object.freeze({
    error: errorValue,
    ok: false,
  });
}

function pathToken(value: string): string {
  let token = "";

  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];

    if (char === undefined) continue;

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
