import type {
  DesktopLauncherIntent,
  DesktopSettingsWriteRequest,
  WindowManagerIntent,
} from "../../../sdk/typescript/src/desktop-sdk/index.ts";

/**
 * Command-registry view-model — non-launcher desktop commands.
 *
 * Decouples *commands* from the launcher so keyboard shortcuts and the command
 * palette can target window-manager, workspace, theme, and settings actions —
 * not just app launches. A command is `{ id, title, category, when }` plus an
 * `execute` thunk classified as a typed action. The registry never performs
 * effects: `execute(id, ctx)` returns the typed action (the dispatcher applies
 * it). Pure / deterministic — no ambient I/O, no clocks. Fail-closed.
 */

export type CommandContextValue = string | number | boolean | null;

export type CommandContext = Readonly<Record<string, CommandContextValue>>;

export type CommandPredicate = (context: CommandContext) => boolean;

/** Theme variants targetable by a `theme.toggle` action. */
export type CommandThemeVariant = string;

export type CommandAction =
  | {
      readonly kind: "launcher.intent";
      readonly intent: DesktopLauncherIntent;
    }
  | {
      readonly kind: "wm.intent";
      readonly intent: WindowManagerIntent;
    }
  | {
      readonly kind: "settings.write";
      readonly request: DesktopSettingsWriteRequest;
    }
  | {
      readonly kind: "theme.toggle";
      readonly from: CommandThemeVariant;
      readonly to: CommandThemeVariant;
    }
  | {
      readonly kind: "noop";
    };

export type CommandActionKind = CommandAction["kind"];

/**
 * A command definition. `execute` is a pure thunk that classifies the command
 * into a typed action given the evaluation context. It must not perform I/O.
 */
export interface CommandDefinition {
  readonly id: string;
  readonly title: string;
  readonly category: string;
  readonly when?: CommandPredicate;
  readonly execute: (context: CommandContext) => CommandAction;
}

/** A registered command, normalized and frozen. */
export interface RegisteredCommand {
  readonly id: string;
  readonly title: string;
  readonly category: string;
}

export interface CommandGroup {
  readonly category: string;
  readonly commands: readonly RegisteredCommand[];
}

export interface CommandRegistrySnapshot {
  readonly commands: readonly RegisteredCommand[];
  readonly groups: readonly CommandGroup[];
}

export interface CommandRegistryError {
  readonly code: string;
  readonly message: string;
  readonly path: string;
}

export type CommandRegisterResult =
  | {
      readonly ok: true;
      readonly command: RegisteredCommand;
    }
  | {
      readonly ok: false;
      readonly error: CommandRegistryError;
    };

export type CommandExecuteResult =
  | {
      readonly ok: true;
      readonly command: RegisteredCommand;
      readonly action: CommandAction;
    }
  | {
      readonly ok: false;
      readonly error: CommandRegistryError;
    };

export interface CommandRegistryViewModel {
  register(command: CommandDefinition): CommandRegisterResult;
  snapshot(context?: CommandContext): CommandRegistrySnapshot;
  available(context?: CommandContext): readonly RegisteredCommand[];
  isAvailable(id: unknown, context?: CommandContext): boolean;
  execute(id: unknown, context?: CommandContext): CommandExecuteResult;
}

export interface CommandRegistryOptions {
  readonly commands?: readonly CommandDefinition[];
}

const ACTION_KINDS = Object.freeze([
  "launcher.intent",
  "wm.intent",
  "settings.write",
  "theme.toggle",
  "noop",
] as const);

const EMPTY_CONTEXT: CommandContext = Object.freeze({});

export function createCommandRegistry(
  options: CommandRegistryOptions = Object.freeze({}),
): CommandRegistryViewModel {
  return new DesktopCommandRegistry(options);
}

interface InternalCommand {
  readonly id: string;
  readonly title: string;
  readonly category: string;
  readonly when: CommandPredicate | null;
  readonly execute: (context: CommandContext) => CommandAction;
  readonly registered: RegisteredCommand;
}

class DesktopCommandRegistry implements CommandRegistryViewModel {
  readonly #byId: Map<string, InternalCommand>;
  readonly #order: string[];

  constructor(options: CommandRegistryOptions) {
    this.#byId = new Map<string, InternalCommand>();
    this.#order = [];

    const seed = options.commands ?? Object.freeze([]);

    for (let index = 0; index < seed.length; index += 1) {
      const definition = seed[index];

      if (definition === undefined) {
        continue;
      }

      // Seeded commands silently skip on invalid/duplicate so a single bad
      // entry cannot poison construction; explicit `register` reports errors.
      const normalized = normalizeDefinition(definition);

      if (normalized === null || this.#byId.has(normalized.id)) {
        continue;
      }

      this.#byId.set(normalized.id, normalized);
      this.#order.push(normalized.id);
    }
  }

  register(command: CommandDefinition): CommandRegisterResult {
    const normalized = normalizeDefinition(command);

    if (normalized === null) {
      return rejectRegister(error(
        "INVALID_COMMAND",
        "command must have a string id, title, category, and execute thunk.",
        "/command",
      ));
    }

    if (this.#byId.has(normalized.id)) {
      return rejectRegister(error(
        "DUPLICATE_COMMAND",
        `command '${normalized.id}' is already registered.`,
        `/commands/${pathToken(normalized.id)}`,
      ));
    }

    this.#byId.set(normalized.id, normalized);
    this.#order.push(normalized.id);

    return Object.freeze({
      command: normalized.registered,
      ok: true,
    });
  }

  snapshot(context?: CommandContext): CommandRegistrySnapshot {
    const safeContext = normalizeContext(context);
    const visible = this.#visibleCommands(safeContext);

    return Object.freeze({
      commands: freezeRegisteredList(visible),
      groups: groupByCategory(visible),
    });
  }

  available(context?: CommandContext): readonly RegisteredCommand[] {
    return freezeRegisteredList(this.#visibleCommands(normalizeContext(context)));
  }

  isAvailable(id: unknown, context?: CommandContext): boolean {
    if (typeof id !== "string") {
      return false;
    }

    const command = this.#byId.get(id);

    if (command === undefined) {
      return false;
    }

    return matchesWhen(command, normalizeContext(context));
  }

  execute(id: unknown, context?: CommandContext): CommandExecuteResult {
    if (typeof id !== "string" || id.length === 0) {
      return rejectExecute(error("UNKNOWN_COMMAND", "command id must be a non-empty string.", "/id"));
    }

    const command = this.#byId.get(id);

    if (command === undefined) {
      return rejectExecute(error(
        "UNKNOWN_COMMAND",
        `command '${id}' is not registered.`,
        `/commands/${pathToken(id)}`,
      ));
    }

    const safeContext = normalizeContext(context);

    if (!matchesWhen(command, safeContext)) {
      return rejectExecute(error(
        "COMMAND_UNAVAILABLE",
        `command '${id}' is not available in this context.`,
        `/commands/${pathToken(id)}/when`,
      ));
    }

    let action: CommandAction;

    try {
      action = command.execute(safeContext);
    } catch {
      return rejectExecute(error(
        "COMMAND_FAILED",
        `command '${id}' failed closed while classifying its action.`,
        `/commands/${pathToken(id)}/execute`,
      ));
    }

    const frozen = freezeAction(action);

    if (frozen === null) {
      return rejectExecute(error(
        "INVALID_ACTION",
        `command '${id}' produced an action outside the typed union.`,
        `/commands/${pathToken(id)}/action`,
      ));
    }

    return Object.freeze({
      action: frozen,
      command: command.registered,
      ok: true,
    });
  }

  #visibleCommands(context: CommandContext): readonly InternalCommand[] {
    const output: InternalCommand[] = [];

    for (let index = 0; index < this.#order.length; index += 1) {
      const id = this.#order[index];

      if (id === undefined) {
        continue;
      }

      const command = this.#byId.get(id);

      if (command !== undefined && matchesWhen(command, context)) {
        output.push(command);
      }
    }

    return output;
  }
}

function normalizeDefinition(definition: CommandDefinition): InternalCommand | null {
  if (definition === null || typeof definition !== "object") {
    return null;
  }

  const id = definition.id;
  const title = definition.title;
  const category = definition.category;
  const execute = definition.execute;
  const when = definition.when;

  if (
    typeof id !== "string" ||
    id.length === 0 ||
    typeof title !== "string" ||
    title.length === 0 ||
    typeof category !== "string" ||
    category.length === 0 ||
    typeof execute !== "function"
  ) {
    return null;
  }

  if (when !== undefined && typeof when !== "function") {
    return null;
  }

  return Object.freeze({
    category,
    execute,
    id,
    registered: Object.freeze({
      category,
      id,
      title,
    }),
    title,
    when: when ?? null,
  });
}

function matchesWhen(command: InternalCommand, context: CommandContext): boolean {
  if (command.when === null) {
    return true;
  }

  try {
    return command.when(context) === true;
  } catch {
    // A throwing predicate fails closed: the command is treated as unavailable.
    return false;
  }
}

interface MutableCommandGroup {
  readonly category: string;
  readonly commands: RegisteredCommand[];
}

function groupByCategory(commands: readonly InternalCommand[]): readonly CommandGroup[] {
  const sorted = sortCommands(commands);
  const groups: MutableCommandGroup[] = [];
  const indexByCategory = new Map<string, number>();

  for (let index = 0; index < sorted.length; index += 1) {
    const command = sorted[index];

    if (command === undefined) {
      continue;
    }

    const existing = indexByCategory.get(command.category);

    if (existing === undefined) {
      indexByCategory.set(command.category, groups.length);
      groups.push({
        category: command.category,
        commands: [command.registered],
      });
      continue;
    }

    const group = groups[existing];

    if (group !== undefined) {
      group.commands.push(command.registered);
    }
  }

  const output: CommandGroup[] = [];

  for (let index = 0; index < groups.length; index += 1) {
    const group = groups[index];

    if (group !== undefined) {
      output.push(Object.freeze({
        category: group.category,
        commands: Object.freeze([...group.commands]),
      }));
    }
  }

  return Object.freeze(output);
}

function sortCommands(commands: readonly InternalCommand[]): readonly InternalCommand[] {
  const output = [...commands];

  output.sort((left, right) => {
    if (left.category !== right.category) {
      return compareStrings(left.category, right.category);
    }

    if (left.title !== right.title) {
      return compareStrings(left.title, right.title);
    }

    return compareStrings(left.id, right.id);
  });

  return output;
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

function freezeRegisteredList(commands: readonly InternalCommand[]): readonly RegisteredCommand[] {
  const sorted = sortCommands(commands);
  const output: RegisteredCommand[] = [];

  for (let index = 0; index < sorted.length; index += 1) {
    const command = sorted[index];

    if (command !== undefined) {
      output.push(command.registered);
    }
  }

  return Object.freeze(output);
}

function normalizeContext(context: CommandContext | undefined): CommandContext {
  if (context === undefined || context === null || typeof context !== "object") {
    return EMPTY_CONTEXT;
  }

  return context;
}

function freezeAction(action: CommandAction): CommandAction | null {
  if (action === null || typeof action !== "object") {
    return null;
  }

  if (!contains(ACTION_KINDS, action.kind)) {
    return null;
  }

  switch (action.kind) {
    case "launcher.intent":
      return Object.freeze({
        intent: Object.freeze({ ...action.intent }),
        kind: "launcher.intent",
      });
    case "wm.intent":
      return Object.freeze({
        intent: Object.freeze({ ...action.intent }),
        kind: "wm.intent",
      });
    case "settings.write":
      return Object.freeze({
        kind: "settings.write",
        request: Object.freeze({ ...action.request }),
      });
    case "theme.toggle":
      return Object.freeze({
        from: action.from,
        kind: "theme.toggle",
        to: action.to,
      });
    case "noop":
      return Object.freeze({ kind: "noop" });
    default:
      return null;
  }
}

function contains<T extends string>(values: readonly T[], value: string): value is T {
  for (let index = 0; index < values.length; index += 1) {
    if (values[index] === value) {
      return true;
    }
  }

  return false;
}

function rejectRegister(errorValue: CommandRegistryError): CommandRegisterResult {
  return Object.freeze({
    error: errorValue,
    ok: false,
  });
}

function rejectExecute(errorValue: CommandRegistryError): CommandExecuteResult {
  return Object.freeze({
    error: errorValue,
    ok: false,
  });
}

function error(code: string, message: string, path: string): CommandRegistryError {
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
