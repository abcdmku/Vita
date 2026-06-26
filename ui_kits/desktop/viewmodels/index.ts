import { hasDesktopCapabilityGrant } from "../../../sdk/typescript/src/desktop-sdk/index.ts";
import type {
  AppWindowHints,
  DesktopAppLaunch,
  DesktopCapability,
  DesktopHost,
  DesktopHostError,
  DesktopHostResult,
  DesktopLaunchableApp,
  DesktopLauncherIntent,
  TsxComponentRef,
  WebviewRuntimeRef,
} from "../../../sdk/typescript/src/desktop-sdk/index.ts";

export type IndexPaletteCommandKind = "app" | "command";

export interface IndexPaletteLaunchAppAction {
  readonly type: "launchApp";
  readonly app: DesktopLaunchableApp;
}

export interface IndexPaletteLauncherIntentAction {
  readonly type: "launcherIntent";
  readonly intent: DesktopLauncherIntent;
}

export type IndexPaletteAction = IndexPaletteLaunchAppAction | IndexPaletteLauncherIntentAction;

export interface IndexPaletteCommand {
  readonly id: string;
  readonly title: string;
  readonly subtitle: string;
  readonly kind: IndexPaletteCommandKind;
  readonly action: IndexPaletteAction;
}

export interface IndexPaletteState {
  readonly query: string;
  readonly results: readonly IndexPaletteCommand[];
  readonly highlightedIndex: number;
}

export interface IndexPaletteError {
  readonly code: string;
  readonly message: string;
  readonly path: string;
}

export type IndexPaletteExecuteResult =
  | {
      readonly ok: true;
      readonly command: IndexPaletteCommand;
      readonly dispatch: "launchApp";
      readonly value: DesktopAppLaunch;
    }
  | {
      readonly ok: true;
      readonly command: IndexPaletteCommand;
      readonly dispatch: "launcherIntent";
      readonly value: true;
    }
  | {
      readonly ok: false;
      readonly error: IndexPaletteError;
      readonly command?: IndexPaletteCommand;
    };

export interface IndexPaletteViewModel {
  readonly registry: readonly IndexPaletteCommand[];
  snapshot(): IndexPaletteState;
  setQuery(query: string): IndexPaletteState;
  moveSelection(delta: number): IndexPaletteState;
  execute(index?: number): Promise<IndexPaletteExecuteResult>;
}

export type IndexPalettePorts = Pick<DesktopHost, "package" | "launchApp" | "emitLauncherIntent">;

interface RankedCommand {
  readonly command: IndexPaletteCommand;
  readonly index: number;
  readonly score: number;
}

interface CapabilityRequirement {
  readonly capability: DesktopCapability;
  readonly resourceId?: string;
}

export const INDEX_PALETTE_APP_IDS = Object.freeze({
  browser: "vita.app.browser",
  code: "vita.app.code",
  files: "vita.app.file-manager",
  mail: "vita.app.mail",
  settings: "vita.app.settings",
  terminal: "vita.app.terminal",
});

export const INDEX_PALETTE_COMMAND_IDS = Object.freeze({
  runKernel: "command.run-kernel",
  toggleDarkMode: "command.toggle-dark-mode",
});

export const DEFAULT_INDEX_PALETTE_COMMANDS: readonly IndexPaletteCommand[] = freezeRegistry([
  commandIntent(
    INDEX_PALETTE_COMMAND_IDS.runKernel,
    "Run kernel.ts",
    "TypeScript main()",
    {
      appId: "vita.command.run-kernel",
      query: "kernel.ts",
      type: "launcher.launch",
    },
  ),
  appCommand(
    "app.files",
    "Open Files",
    "Application",
    tsxApp(INDEX_PALETTE_APP_IDS.files, "Files"),
  ),
  commandIntent(
    INDEX_PALETTE_COMMAND_IDS.toggleDarkMode,
    "Toggle Dark Mode",
    "Command",
    {
      appId: "vita.command.toggle-dark-mode",
      query: "theme.dark.toggle",
      type: "launcher.launch",
    },
  ),
  appCommand(
    "app.terminal",
    "Terminal",
    "Application",
    tsxApp(INDEX_PALETTE_APP_IDS.terminal, "Terminal"),
  ),
  appCommand(
    "app.code",
    "Code",
    "Application",
    tsxApp(INDEX_PALETTE_APP_IDS.code, "Code"),
  ),
  appCommand(
    "app.mail",
    "Mail",
    "Application",
    tsxApp(INDEX_PALETTE_APP_IDS.mail, "Mail"),
  ),
  appCommand(
    "app.browser",
    "Browser",
    "Application",
    tsxApp(INDEX_PALETTE_APP_IDS.browser, "Browser"),
  ),
  appCommand(
    "app.settings",
    "Settings",
    "Application",
    tsxApp(INDEX_PALETTE_APP_IDS.settings, "Settings"),
  ),
]);

export function createDefaultIndexPaletteRegistry(): readonly IndexPaletteCommand[] {
  return DEFAULT_INDEX_PALETTE_COMMANDS;
}

export function createIndexPaletteViewModel(
  ports: IndexPalettePorts,
  registry: readonly IndexPaletteCommand[] = DEFAULT_INDEX_PALETTE_COMMANDS,
): IndexPaletteViewModel {
  return new IndexPaletteModel(ports, registry);
}

export function rankIndexPaletteCommands(
  query: string,
  registry: readonly IndexPaletteCommand[] = DEFAULT_INDEX_PALETTE_COMMANDS,
): readonly IndexPaletteCommand[] {
  const normalizedQuery = normalizeSearch(query);
  const ranked: RankedCommand[] = [];

  for (let index = 0; index < registry.length; index += 1) {
    const command = registry[index];

    if (command === undefined) continue;

    const score = normalizedQuery.length === 0
      ? 0
      : scoreCommand(command, normalizedQuery);

    if (score !== null) {
      ranked.push(Object.freeze({
        command,
        index,
        score,
      }));
    }
  }

  ranked.sort(compareRankedCommands);

  const results: IndexPaletteCommand[] = [];

  for (let index = 0; index < ranked.length; index += 1) {
    const item = ranked[index];

    if (item !== undefined) {
      results.push(item.command);
    }
  }

  return Object.freeze(results);
}

class IndexPaletteModel implements IndexPaletteViewModel {
  readonly #ports: IndexPalettePorts;
  readonly #registry: readonly IndexPaletteCommand[];
  #state: IndexPaletteState;

  constructor(
    ports: IndexPalettePorts,
    registry: readonly IndexPaletteCommand[],
  ) {
    this.#ports = ports;
    this.#registry = freezeRegistry(registry);
    this.#state = stateForQuery("", this.#registry);
  }

  get registry(): readonly IndexPaletteCommand[] {
    return this.#registry;
  }

  snapshot(): IndexPaletteState {
    return this.#state;
  }

  setQuery(query: string): IndexPaletteState {
    this.#state = stateForQuery(query, this.#registry);
    return this.#state;
  }

  moveSelection(delta: number): IndexPaletteState {
    const count = this.#state.results.length;

    if (count === 0) {
      this.#state = freezeState({
        highlightedIndex: -1,
        query: this.#state.query,
        results: this.#state.results,
      });
      return this.#state;
    }

    const steps = Number.isFinite(delta) ? Math.trunc(delta) : 0;
    const current = this.#state.highlightedIndex >= 0
      ? this.#state.highlightedIndex
      : steps < 0 ? count : -1;
    const highlightedIndex = positiveModulo(current + steps, count);

    this.#state = freezeState({
      highlightedIndex,
      query: this.#state.query,
      results: this.#state.results,
    });
    return this.#state;
  }

  async execute(index = this.#state.highlightedIndex): Promise<IndexPaletteExecuteResult> {
    if (!Number.isInteger(index) || index < 0 || index >= this.#state.results.length) {
      return rejectExecute(error(
        "INVALID_SELECTION",
        "command palette selection is not available.",
        "/selection",
      ));
    }

    const command = this.#state.results[index];

    if (command === undefined) {
      return rejectExecute(error(
        "INVALID_SELECTION",
        "command palette selection is not available.",
        `/results/${index}`,
      ));
    }

    const requirement = requiredCapability(command);

    if (!hasDesktopCapabilityGrant(this.#ports.package, requirement.capability, requirement.resourceId)) {
      return rejectExecute(error(
        "MISSING_CAPABILITY",
        `command '${command.id}' requires ${requirement.capability}.`,
        `/commands/${pathToken(command.id)}/capability`,
      ), command);
    }

    if (command.action.type === "launchApp") {
      return await this.#launchApp(command);
    }

    return await this.#emitLauncherIntent(command);
  }

  async #launchApp(command: IndexPaletteCommand): Promise<IndexPaletteExecuteResult> {
    if (command.action.type !== "launchApp") {
      return rejectExecute(error(
        "INVALID_ACTION",
        "command action is not an app launch.",
        `/commands/${pathToken(command.id)}/action`,
      ), command);
    }

    let result: DesktopHostResult<DesktopAppLaunch>;

    try {
      result = await this.#ports.launchApp(command.action.app);
    } catch {
      return rejectExecute(error(
        "APP_LAUNCH_PORT_FAILED",
        "app launch port failed closed.",
        `/commands/${pathToken(command.id)}/launchApp`,
      ), command);
    }

    if (!result.ok) {
      return rejectExecute(hostError(result.error), command);
    }

    return Object.freeze({
      command,
      dispatch: "launchApp",
      ok: true,
      value: result.value,
    });
  }

  async #emitLauncherIntent(command: IndexPaletteCommand): Promise<IndexPaletteExecuteResult> {
    if (command.action.type !== "launcherIntent") {
      return rejectExecute(error(
        "INVALID_ACTION",
        "command action is not a launcher intent.",
        `/commands/${pathToken(command.id)}/action`,
      ), command);
    }

    const emitLauncherIntent = this.#ports.emitLauncherIntent;

    if (emitLauncherIntent === undefined) {
      return rejectExecute(error(
        "LAUNCHER_PORT_UNAVAILABLE",
        "launcher intent port is unavailable.",
        "/launcher",
      ), command);
    }

    let result: DesktopHostResult<true>;

    try {
      result = await emitLauncherIntent(command.action.intent);
    } catch {
      return rejectExecute(error(
        "LAUNCHER_PORT_FAILED",
        "launcher intent port failed closed.",
        `/commands/${pathToken(command.id)}/launcher`,
      ), command);
    }

    if (!result.ok) {
      return rejectExecute(hostError(result.error), command);
    }

    return Object.freeze({
      command,
      dispatch: "launcherIntent",
      ok: true,
      value: result.value,
    });
  }
}

function stateForQuery(
  query: string,
  registry: readonly IndexPaletteCommand[],
): IndexPaletteState {
  const results = rankIndexPaletteCommands(query, registry);

  return freezeState({
    highlightedIndex: results.length === 0 ? -1 : 0,
    query,
    results,
  });
}

function freezeState(input: IndexPaletteState): IndexPaletteState {
  return Object.freeze({
    highlightedIndex: input.highlightedIndex,
    query: input.query,
    results: Object.freeze([...input.results]),
  });
}

function appCommand(
  id: string,
  title: string,
  subtitle: string,
  app: DesktopLaunchableApp,
): IndexPaletteCommand {
  return Object.freeze({
    action: Object.freeze({
      app,
      type: "launchApp",
    }),
    id,
    kind: "app",
    subtitle,
    title,
  });
}

function commandIntent(
  id: string,
  title: string,
  subtitle: string,
  intent: DesktopLauncherIntent,
): IndexPaletteCommand {
  return Object.freeze({
    action: Object.freeze({
      intent: freezeLauncherIntent(intent),
      type: "launcherIntent",
    }),
    id,
    kind: "command",
    subtitle,
    title,
  });
}

function tsxApp(id: string, title: string): DesktopLaunchableApp {
  return Object.freeze({
    id,
    runtime: Object.freeze({
      componentId: id,
    }),
    surfaceKind: "tsx",
    title,
  });
}

function freezeRegistry(commands: readonly IndexPaletteCommand[]): readonly IndexPaletteCommand[] {
  const frozen: IndexPaletteCommand[] = [];

  for (let index = 0; index < commands.length; index += 1) {
    const command = commands[index];

    if (command !== undefined) {
      frozen.push(freezeCommand(command));
    }
  }

  return Object.freeze(frozen);
}

function freezeCommand(command: IndexPaletteCommand): IndexPaletteCommand {
  return Object.freeze({
    action: freezeAction(command.action),
    id: command.id,
    kind: command.kind,
    subtitle: command.subtitle,
    title: command.title,
  });
}

function freezeAction(action: IndexPaletteAction): IndexPaletteAction {
  if (action.type === "launchApp") {
    return Object.freeze({
      app: freezeLaunchableApp(action.app),
      type: "launchApp",
    });
  }

  return Object.freeze({
    intent: freezeLauncherIntent(action.intent),
    type: "launcherIntent",
  });
}

function freezeLaunchableApp(app: DesktopLaunchableApp): DesktopLaunchableApp {
  if (app.surfaceKind === "tsx") {
    const runtime: {
      componentId: string;
      props?: NonNullable<TsxComponentRef["props"]>;
    } = {
      componentId: app.runtime.componentId,
    };

    if (app.runtime.props !== undefined) runtime.props = app.runtime.props;

    const output: {
      id: string;
      title: string;
      surfaceKind: "tsx";
      runtime: TsxComponentRef;
      defaultWindow?: AppWindowHints;
    } = {
      id: app.id,
      runtime: Object.freeze(runtime),
      surfaceKind: "tsx",
      title: app.title,
    };

    if (app.defaultWindow !== undefined) output.defaultWindow = freezeWindowHints(app.defaultWindow);

    return Object.freeze(output);
  }

  const runtime: {
    url: string;
    partition?: string;
  } = {
    url: app.runtime.url,
  };

  if (app.runtime.partition !== undefined) runtime.partition = app.runtime.partition;

  const output: {
    id: string;
    title: string;
    surfaceKind: "web";
    runtime: WebviewRuntimeRef;
    defaultWindow?: AppWindowHints;
  } = {
    id: app.id,
    runtime: Object.freeze(runtime),
    surfaceKind: "web",
    title: app.title,
  };

  if (app.defaultWindow !== undefined) output.defaultWindow = freezeWindowHints(app.defaultWindow);

  return Object.freeze(output);
}

function freezeWindowHints(hints: AppWindowHints): AppWindowHints {
  const output: {
    workspaceId?: string;
    rect?: NonNullable<AppWindowHints["rect"]>;
    mode?: NonNullable<AppWindowHints["mode"]>;
    zone?: string;
    layer?: string;
    order?: number;
    anchor?: string;
    className?: string;
  } = {};

  if (hints.workspaceId !== undefined) output.workspaceId = hints.workspaceId;
  if (hints.rect !== undefined) {
    output.rect = Object.freeze({
      height: hints.rect.height,
      width: hints.rect.width,
      x: hints.rect.x,
      y: hints.rect.y,
    });
  }
  if (hints.mode !== undefined) output.mode = hints.mode;
  if (hints.zone !== undefined) output.zone = hints.zone;
  if (hints.layer !== undefined) output.layer = hints.layer;
  if (hints.order !== undefined) output.order = hints.order;
  if (hints.anchor !== undefined) output.anchor = hints.anchor;
  if (hints.className !== undefined) output.className = hints.className;

  return Object.freeze(output);
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

function requiredCapability(command: IndexPaletteCommand): CapabilityRequirement {
  if (command.action.type === "launchApp") {
    return Object.freeze({
      capability: "apps.launch",
      resourceId: command.action.app.id,
    });
  }

  const output: {
    capability: DesktopCapability;
    resourceId?: string;
  } = {
    capability: "launcher.launch",
  };

  if (command.action.intent.appId !== undefined) output.resourceId = command.action.intent.appId;

  return Object.freeze(output);
}

function scoreCommand(command: IndexPaletteCommand, query: string): number | null {
  let best: number | null = null;
  best = maxScore(best, scoreText(command.title, query, 1_000));
  best = maxScore(best, scoreText(command.subtitle, query, 600));
  best = maxScore(best, scoreText(command.id, query, 350));

  if (command.action.type === "launchApp") {
    best = maxScore(best, scoreText(command.action.app.id, query, 250));
    best = maxScore(best, scoreText(command.action.app.title, query, 800));
  } else {
    best = maxScore(best, scoreText(command.action.intent.appId ?? "", query, 250));
    best = maxScore(best, scoreText(command.action.intent.query ?? "", query, 200));
  }

  return best;
}

function maxScore(left: number | null, right: number | null): number | null {
  if (right === null) return left;
  if (left === null || right > left) return right;

  return left;
}

function scoreText(text: string, query: string, weight: number): number | null {
  const haystack = normalizeSearch(text);

  if (haystack.length === 0) return null;

  const exactIndex = haystack.indexOf(query);

  if (exactIndex >= 0) {
    const startsAtBoundary = exactIndex === 0 || isSeparator(haystack.charCodeAt(exactIndex - 1));
    const exactBonus = startsAtBoundary ? 10_000 : 250;

    return weight + exactBonus - exactIndex * 5 - (haystack.length - query.length);
  }

  let haystackIndex = 0;
  let previousMatch = -1;
  let score = weight;

  for (let queryIndex = 0; queryIndex < query.length; queryIndex += 1) {
    const queryChar = query[queryIndex];

    if (queryChar === undefined) return null;

    let matchedAt = -1;

    for (; haystackIndex < haystack.length; haystackIndex += 1) {
      if (haystack[haystackIndex] === queryChar) {
        matchedAt = haystackIndex;
        haystackIndex += 1;
        break;
      }
    }

    if (matchedAt < 0) return null;

    score += 100;

    if (previousMatch < 0) {
      score -= matchedAt * 10;
    }

    if (matchedAt === previousMatch + 1) {
      score += 30;
    } else if (previousMatch >= 0) {
      score -= Math.min(40, matchedAt - previousMatch - 1);
    }

    if (matchedAt === 0 || isSeparator(haystack.charCodeAt(matchedAt - 1))) {
      score += 90;
    }

    previousMatch = matchedAt;
  }

  return score - haystack.length;
}

function compareRankedCommands(left: RankedCommand, right: RankedCommand): number {
  const score = right.score - left.score;

  if (score !== 0) return score;

  return left.index - right.index;
}

function normalizeSearch(value: string): string {
  return value.trim().toLocaleLowerCase("en-US");
}

function isSeparator(code: number): boolean {
  return (
    code === 32 ||
    code === 45 ||
    code === 46 ||
    code === 47 ||
    code === 58 ||
    code === 95
  );
}

function positiveModulo(value: number, modulus: number): number {
  return ((value % modulus) + modulus) % modulus;
}

function rejectExecute(
  errorValue: IndexPaletteError,
  command?: IndexPaletteCommand,
): IndexPaletteExecuteResult {
  const output: {
    ok: false;
    error: IndexPaletteError;
    command?: IndexPaletteCommand;
  } = {
    error: errorValue,
    ok: false,
  };

  if (command !== undefined) output.command = command;

  return Object.freeze(output);
}

function hostError(errorValue: DesktopHostError): IndexPaletteError {
  return error(errorValue.code, errorValue.message, errorValue.path);
}

function error(code: string, message: string, path: string): IndexPaletteError {
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

export {
  createAppHost,
} from "./app-host.ts";
export type {
  AppHost,
  AppHostActionResult,
  AppHostAppStatus,
  AppHostError,
  AppHostPorts,
  AppHostState,
  DesktopRegistryApp,
} from "./app-host.ts";
