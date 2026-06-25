import {
  createFileManagerState,
  hasDesktopCapabilityGrant,
  joinCapabilityPath,
  loadFileManagerDirectory,
  parentCapabilityPath,
  readFileManagerFile,
} from "../../../sdk/typescript/src/desktop-sdk/index.ts";
import type {
  AppWindowHints,
  DesktopAppLaunch,
  DesktopCapability,
  DesktopHost,
  DesktopHostError,
  DesktopHostResult,
  DesktopLaunchableApp,
  DesktopLauncherIntent,
  DesktopUiPackageManifest,
  FileManagerStatus,
  FilesCapabilityPort,
  FilesEntry,
  TsxComponentRef,
  WebviewRuntimeRef,
} from "../../../sdk/typescript/src/desktop-sdk/index.ts";
import {
  DEFAULT_INDEX_PALETTE_COMMANDS,
  INDEX_PALETTE_APP_IDS,
} from "./index.ts";
import type {
  IndexPaletteCommand,
} from "./index.ts";
import {
  SETTINGS_SECTIONS,
} from "./Settings.ts";

export type SearchSource = "app" | "file" | "command" | "setting";
export type SearchSourceStatusKind = "idle" | "ready" | "forbidden" | "unavailable" | "error";

export interface SearchViewModelError {
  readonly code: string;
  readonly message: string;
  readonly path: string;
}

export interface SearchSourceStatus {
  readonly source: SearchSource;
  readonly label: string;
  readonly status: SearchSourceStatusKind;
  readonly error?: SearchViewModelError;
}

export interface SearchResultBase {
  readonly id: string;
  readonly source: SearchSource;
  readonly title: string;
  readonly subtitle: string;
  readonly score: number;
}

export interface SearchAppResult extends SearchResultBase {
  readonly source: "app";
  readonly app: DesktopLaunchableApp;
}

export interface SearchCommandResult extends SearchResultBase {
  readonly source: "command";
  readonly intent: DesktopLauncherIntent;
}

export interface SearchFileResult extends SearchResultBase {
  readonly source: "file";
  readonly grant: string;
  readonly path: string;
  readonly kind: FilesEntry["kind"];
  readonly size: number;
  readonly modified: string;
}

export interface SearchSettingResult extends SearchResultBase {
  readonly source: "setting";
  readonly sectionId: string;
  readonly intent: DesktopLauncherIntent;
}

export type SearchResult =
  | SearchAppResult
  | SearchCommandResult
  | SearchFileResult
  | SearchSettingResult;

export interface SearchResultGroup {
  readonly source: SearchSource;
  readonly label: string;
  readonly results: readonly SearchResult[];
}

export interface SearchViewState {
  readonly query: string;
  readonly results: readonly SearchResult[];
  readonly groups: readonly SearchResultGroup[];
  readonly selectedIndex: number;
  readonly sources: readonly SearchSourceStatus[];
  readonly selected?: SearchResult;
}

export interface SearchAppInput {
  readonly id: string;
  readonly title: string;
  readonly subtitle?: string;
  readonly app: DesktopLaunchableApp;
  readonly keywords?: readonly string[];
}

export interface SearchCommandInput {
  readonly id: string;
  readonly title: string;
  readonly subtitle?: string;
  readonly intent: DesktopLauncherIntent;
  readonly keywords?: readonly string[];
}

export interface SearchFileScope {
  readonly grant: string;
  readonly path: string;
  readonly label?: string;
  readonly maxDepth?: number;
}

export interface SearchSettingInput {
  readonly id: string;
  readonly title: string;
  readonly subtitle?: string;
  readonly sectionId: string;
  readonly appId?: string;
  readonly keywords?: readonly string[];
}

export interface SearchViewModelPorts {
  readonly package: DesktopUiPackageManifest;
  readonly launchApp?: DesktopHost["launchApp"];
  readonly emitLauncherIntent?: DesktopHost["emitLauncherIntent"];
  readonly files?: FilesCapabilityPort;
}

export interface SearchViewModelOptions {
  readonly ports: SearchViewModelPorts;
  readonly apps?: readonly SearchAppInput[];
  readonly commands?: readonly SearchCommandInput[];
  readonly fileScopes?: readonly SearchFileScope[];
  readonly settings?: readonly SearchSettingInput[];
  readonly fileSearchMaxEntries?: number;
}

export interface SearchFileOpen {
  readonly grant: string;
  readonly path: string;
  readonly kind: FilesEntry["kind"];
  readonly status: FileManagerStatus;
  readonly entries?: readonly FilesEntry[];
  readonly data?: string;
  readonly size?: number;
  readonly modified?: string;
}

export type SearchExecuteResult =
  | {
      readonly ok: true;
      readonly dispatch: "launchApp";
      readonly result: SearchAppResult;
      readonly value: DesktopAppLaunch;
    }
  | {
      readonly ok: true;
      readonly dispatch: "launcherIntent";
      readonly result: SearchCommandResult;
      readonly value: true;
    }
  | {
      readonly ok: true;
      readonly dispatch: "openFile";
      readonly result: SearchFileResult;
      readonly value: SearchFileOpen;
    }
  | {
      readonly ok: true;
      readonly dispatch: "openSetting";
      readonly result: SearchSettingResult;
      readonly value: true;
    }
  | {
      readonly ok: false;
      readonly error: SearchViewModelError;
      readonly result?: SearchResult;
    };

export interface SearchViewModel {
  readonly state: SearchViewState;
  snapshot(): SearchViewState;
  setQuery(query: string): Promise<SearchViewState>;
  moveSelection(delta: number): SearchViewState;
  execute(result?: SearchResult | number): Promise<SearchExecuteResult>;
}

interface WeightedText {
  readonly text: string;
  readonly weight: number;
}

interface SearchCandidate {
  readonly result: SearchResult;
  readonly sourceOrder: number;
  readonly itemOrder: number;
  readonly terms: readonly WeightedText[];
}

interface RankedCandidate {
  readonly candidate: SearchCandidate;
  readonly score: number;
}

interface CandidateCollection {
  readonly candidates: readonly SearchCandidate[];
  readonly status: SearchSourceStatus;
}

interface FileCollection {
  readonly candidates: readonly SearchCandidate[];
  readonly status: SearchSourceStatus;
}

type LauncherEmitResult =
  | {
      readonly ok: true;
    }
  | {
      readonly ok: false;
      readonly error: SearchViewModelError;
      readonly result: SearchCommandResult | SearchSettingResult;
    };

const SOURCE_ORDER = Object.freeze(["app", "file", "command", "setting"] as const);
const SOURCE_LABELS = Object.freeze({
  app: "Apps",
  command: "Commands",
  file: "Files",
  setting: "Settings",
}) satisfies Readonly<Record<SearchSource, string>>;
const EMPTY_RESULTS = Object.freeze([]) satisfies readonly SearchResult[];
const EMPTY_CANDIDATES = Object.freeze([]) satisfies readonly SearchCandidate[];
const EMPTY_FILE_SCOPES = Object.freeze([]) satisfies readonly SearchFileScope[];
const DEFAULT_FILE_MAX_DEPTH = 1;
const MAX_FILE_MAX_DEPTH = 3;
const DEFAULT_FILE_MAX_ENTRIES = 200;
const SETTINGS_APP_ID = INDEX_PALETTE_APP_IDS.settings;

export const DEFAULT_SEARCH_APPS: readonly SearchAppInput[] = createDefaultSearchApps();
export const DEFAULT_SEARCH_COMMANDS: readonly SearchCommandInput[] = createDefaultSearchCommands();
export const DEFAULT_SEARCH_SETTINGS: readonly SearchSettingInput[] = createDefaultSearchSettings();

export function createSearchViewModel(options: SearchViewModelOptions): SearchViewModel {
  return new DesktopSearchViewModel(options);
}

function rankSearchResults(
  query: string,
  candidates: readonly SearchCandidate[],
): readonly SearchResult[] {
  const normalizedQuery = normalizeSearch(query);
  const ranked: RankedCandidate[] = [];

  for (let index = 0; index < candidates.length; index += 1) {
    const candidate = candidates[index];

    if (candidate === undefined) continue;

    const score = normalizedQuery.length === 0 ? 0 : scoreCandidate(candidate, normalizedQuery);

    if (score !== null) {
      ranked.push(Object.freeze({
        candidate,
        score,
      }));
    }
  }

  ranked.sort(compareRankedCandidates);

  const results: SearchResult[] = [];

  for (let index = 0; index < ranked.length; index += 1) {
    const item = ranked[index];

    if (item !== undefined) results.push(freezeResultWithScore(item.candidate.result, item.score));
  }

  return Object.freeze(results);
}

class DesktopSearchViewModel implements SearchViewModel {
  readonly #ports: SearchViewModelPorts;
  readonly #apps: readonly SearchAppInput[];
  readonly #commands: readonly SearchCommandInput[];
  readonly #fileScopes: readonly SearchFileScope[];
  readonly #settings: readonly SearchSettingInput[];
  readonly #fileSearchMaxEntries: number;
  #queryVersion = 0;
  #state: SearchViewState;

  constructor(options: SearchViewModelOptions) {
    this.#ports = options.ports;
    this.#apps = freezeAppInputs(options.apps ?? DEFAULT_SEARCH_APPS);
    this.#commands = freezeCommandInputs(options.commands ?? DEFAULT_SEARCH_COMMANDS);
    this.#fileScopes = freezeFileScopes(options.fileScopes ?? EMPTY_FILE_SCOPES);
    this.#settings = freezeSettingInputs(options.settings ?? DEFAULT_SEARCH_SETTINGS);
    this.#fileSearchMaxEntries = normalizePositiveInteger(options.fileSearchMaxEntries, DEFAULT_FILE_MAX_ENTRIES);
    this.#state = this.#buildStateSync("");
  }

  get state(): SearchViewState {
    return this.#state;
  }

  snapshot(): SearchViewState {
    return this.#state;
  }

  async setQuery(query: string): Promise<SearchViewState> {
    const version = this.#queryVersion + 1;

    this.#queryVersion = version;

    const state = await this.#buildState(query);

    if (version === this.#queryVersion) {
      this.#state = state;
    }

    return this.#state;
  }

  moveSelection(delta: number): SearchViewState {
    const count = this.#state.results.length;

    if (count === 0) {
      this.#state = freezeState({
        query: this.#state.query,
        results: this.#state.results,
        selectedIndex: -1,
        sources: this.#state.sources,
      });
      return this.#state;
    }

    const steps = Number.isFinite(delta) ? Math.trunc(delta) : 0;
    const current = this.#state.selectedIndex >= 0
      ? this.#state.selectedIndex
      : steps < 0 ? count : -1;
    const selectedIndex = positiveModulo(current + steps, count);

    this.#state = freezeState({
      query: this.#state.query,
      results: this.#state.results,
      selectedIndex,
      sources: this.#state.sources,
    });

    return this.#state;
  }

  async execute(selection?: SearchResult | number): Promise<SearchExecuteResult> {
    const result = this.#resolveSelection(selection);

    if (result === undefined) {
      return rejectExecute(error(
        "INVALID_SELECTION",
        "search selection is not available.",
        "/selection",
      ));
    }

    switch (result.source) {
      case "app":
        return await this.#executeApp(result);
      case "command":
        return await this.#executeCommand(result);
      case "file":
        return await this.#executeFile(result);
      case "setting":
        return await this.#executeSetting(result);
    }
  }

  #buildStateSync(query: string): SearchViewState {
    const appCollection = collectAppCandidates(this.#ports, this.#apps);
    const commandCollection = collectCommandCandidates(this.#ports, this.#commands);
    const settingCollection = collectSettingCandidates(this.#ports, this.#settings);
    const candidates = [
      ...appCollection.candidates,
      ...commandCollection.candidates,
      ...settingCollection.candidates,
    ];
    const results = rankSearchResults(query, candidates);

    return freezeState({
      query,
      results,
      selectedIndex: results.length === 0 ? -1 : 0,
      sources: Object.freeze([
        appCollection.status,
        idleSourceStatus("file"),
        commandCollection.status,
        settingCollection.status,
      ]),
    });
  }

  async #buildState(query: string): Promise<SearchViewState> {
    const appCollection = collectAppCandidates(this.#ports, this.#apps);
    const commandCollection = collectCommandCandidates(this.#ports, this.#commands);
    const settingCollection = collectSettingCandidates(this.#ports, this.#settings);
    const fileCollection = await collectFileCandidates(
      this.#ports,
      this.#fileScopes,
      query,
      this.#fileSearchMaxEntries,
    );
    const candidates = [
      ...appCollection.candidates,
      ...fileCollection.candidates,
      ...commandCollection.candidates,
      ...settingCollection.candidates,
    ];
    const results = rankSearchResults(query, candidates);

    return freezeState({
      query,
      results,
      selectedIndex: results.length === 0 ? -1 : 0,
      sources: Object.freeze([
        appCollection.status,
        fileCollection.status,
        commandCollection.status,
        settingCollection.status,
      ]),
    });
  }

  #resolveSelection(selection: SearchResult | number | undefined): SearchResult | undefined {
    if (selection === undefined) return this.#state.selected;

    if (typeof selection === "number") {
      if (!Number.isInteger(selection) || selection < 0 || selection >= this.#state.results.length) {
        return undefined;
      }

      return this.#state.results[selection];
    }

    return selection;
  }

  async #executeApp(result: SearchAppResult): Promise<SearchExecuteResult> {
    const launchApp = this.#ports.launchApp;

    if (!hasDesktopCapabilityGrant(this.#ports.package, "apps.launch", result.app.id)) {
      return rejectExecute(missingCapability("apps.launch", result.app.id, result.id), result);
    }
    if (launchApp === undefined) {
      return rejectExecute(error(
        "APP_LAUNCH_PORT_UNAVAILABLE",
        "app launch port is unavailable.",
        "/apps/launch",
      ), result);
    }

    let launched: DesktopHostResult<DesktopAppLaunch>;

    try {
      launched = await launchApp(result.app);
    } catch {
      return rejectExecute(error(
        "APP_LAUNCH_PORT_FAILED",
        "app launch port failed closed.",
        `/results/${pathToken(result.id)}/launchApp`,
      ), result);
    }

    if (!launched.ok) return rejectExecute(hostError(launched.error), result);

    return Object.freeze({
      dispatch: "launchApp",
      ok: true,
      result,
      value: launched.value,
    });
  }

  async #executeCommand(result: SearchCommandResult): Promise<SearchExecuteResult> {
    const emitted = await this.#emitLauncherIntent(result.intent, result.id, result);

    if (!emitted.ok) return emitted;

    return Object.freeze({
      dispatch: "launcherIntent",
      ok: true,
      result,
      value: true,
    });
  }

  async #executeSetting(result: SearchSettingResult): Promise<SearchExecuteResult> {
    const emitted = await this.#emitLauncherIntent(result.intent, result.id, result);

    if (!emitted.ok) return emitted;

    return Object.freeze({
      dispatch: "openSetting",
      ok: true,
      result,
      value: true,
    });
  }

  async #emitLauncherIntent(
    intent: DesktopLauncherIntent,
    resultId: string,
    result: SearchCommandResult | SearchSettingResult,
  ): Promise<LauncherEmitResult> {
    const emitLauncherIntent = this.#ports.emitLauncherIntent;

    if (!hasDesktopCapabilityGrant(this.#ports.package, "launcher.launch", intent.appId)) {
      return rejectLauncherEmit(missingCapability("launcher.launch", intent.appId, resultId), result);
    }
    if (emitLauncherIntent === undefined) {
      return rejectLauncherEmit(error(
        "LAUNCHER_PORT_UNAVAILABLE",
        "launcher intent port is unavailable.",
        "/launcher",
      ), result);
    }

    let emitted: DesktopHostResult<true>;

    try {
      emitted = await emitLauncherIntent(intent);
    } catch {
      return rejectLauncherEmit(error(
        "LAUNCHER_PORT_FAILED",
        "launcher intent port failed closed.",
        `/results/${pathToken(resultId)}/launcher`,
      ), result);
    }

    if (!emitted.ok) return rejectLauncherEmit(hostError(emitted.error), result);

    return Object.freeze({
      ok: true,
    });
  }

  async #executeFile(result: SearchFileResult): Promise<SearchExecuteResult> {
    const files = this.#ports.files;

    if (!hasDesktopCapabilityGrant(this.#ports.package, "files.read", result.grant)) {
      return rejectExecute(missingCapability("files.read", result.grant, result.id), result);
    }
    if (files === undefined) {
      return rejectExecute(error(
        "FILES_PORT_UNAVAILABLE",
        "files capability port is unavailable.",
        "/files",
      ), result);
    }
    if (result.kind === "symlink-skipped") {
      return rejectExecute(error(
        "UNOPENABLE_FILE_RESULT",
        "symlink-skipped file results cannot be opened.",
        `/results/${pathToken(result.id)}/file`,
      ), result);
    }

    const baseState = createFileManagerState({
      grant: result.grant,
      path: parentCapabilityPath(result.path),
    });
    const transition = result.kind === "dir"
      ? await loadFileManagerDirectory(files, baseState, result.path)
      : await readFileManagerFile(files, baseState, result.path, fileResultStat(result));

    if (transition.state.error !== undefined) {
      return rejectExecute(transition.state.error, result);
    }

    return Object.freeze({
      dispatch: "openFile",
      ok: true,
      result,
      value: fileOpenValue(result, transition.state.status, transition.state.entries, transition.state.selected),
    });
  }
}

function collectAppCandidates(
  ports: SearchViewModelPorts,
  apps: readonly SearchAppInput[],
): CandidateCollection {
  if (apps.length === 0) {
    return Object.freeze({
      candidates: EMPTY_CANDIDATES,
      status: readySourceStatus("app"),
    });
  }
  if (ports.launchApp === undefined) {
    return Object.freeze({
      candidates: EMPTY_CANDIDATES,
      status: unavailableSourceStatus("app", "APP_LAUNCH_PORT_UNAVAILABLE", "app launch port is unavailable.", "/apps/launch"),
    });
  }

  const candidates: SearchCandidate[] = [];
  let denied = 0;

  for (let index = 0; index < apps.length; index += 1) {
    const app = apps[index];

    if (app === undefined) continue;
    if (!hasDesktopCapabilityGrant(ports.package, "apps.launch", app.app.id)) {
      denied += 1;
      continue;
    }

    candidates.push(appCandidate(app, index));
  }

  return Object.freeze({
    candidates: Object.freeze(candidates),
    status: statusForCandidateCount("app", candidates.length, denied),
  });
}

function collectCommandCandidates(
  ports: SearchViewModelPorts,
  commands: readonly SearchCommandInput[],
): CandidateCollection {
  if (commands.length === 0) {
    return Object.freeze({
      candidates: EMPTY_CANDIDATES,
      status: readySourceStatus("command"),
    });
  }
  if (ports.emitLauncherIntent === undefined) {
    return Object.freeze({
      candidates: EMPTY_CANDIDATES,
      status: unavailableSourceStatus("command", "LAUNCHER_PORT_UNAVAILABLE", "launcher intent port is unavailable.", "/launcher"),
    });
  }

  const candidates: SearchCandidate[] = [];
  let denied = 0;

  for (let index = 0; index < commands.length; index += 1) {
    const command = commands[index];

    if (command === undefined) continue;
    if (!hasDesktopCapabilityGrant(ports.package, "launcher.launch", command.intent.appId)) {
      denied += 1;
      continue;
    }

    candidates.push(commandCandidate(command, index));
  }

  return Object.freeze({
    candidates: Object.freeze(candidates),
    status: statusForCandidateCount("command", candidates.length, denied),
  });
}

function collectSettingCandidates(
  ports: SearchViewModelPorts,
  settings: readonly SearchSettingInput[],
): CandidateCollection {
  if (settings.length === 0) {
    return Object.freeze({
      candidates: EMPTY_CANDIDATES,
      status: readySourceStatus("setting"),
    });
  }
  if (ports.emitLauncherIntent === undefined) {
    return Object.freeze({
      candidates: EMPTY_CANDIDATES,
      status: unavailableSourceStatus("setting", "LAUNCHER_PORT_UNAVAILABLE", "launcher intent port is unavailable.", "/launcher"),
    });
  }

  const candidates: SearchCandidate[] = [];
  let denied = 0;

  for (let index = 0; index < settings.length; index += 1) {
    const setting = settings[index];

    if (setting === undefined) continue;

    const appId = setting.appId ?? SETTINGS_APP_ID;

    if (!hasDesktopCapabilityGrant(ports.package, "launcher.launch", appId)) {
      denied += 1;
      continue;
    }

    candidates.push(settingCandidate(setting, index));
  }

  return Object.freeze({
    candidates: Object.freeze(candidates),
    status: statusForCandidateCount("setting", candidates.length, denied),
  });
}

async function collectFileCandidates(
  ports: SearchViewModelPorts,
  scopes: readonly SearchFileScope[],
  query: string,
  maxEntries: number,
): Promise<FileCollection> {
  if (normalizeSearch(query).length === 0 || scopes.length === 0) {
    return Object.freeze({
      candidates: EMPTY_CANDIDATES,
      status: idleSourceStatus("file"),
    });
  }
  if (ports.files === undefined) {
    return Object.freeze({
      candidates: EMPTY_CANDIDATES,
      status: unavailableSourceStatus("file", "FILES_PORT_UNAVAILABLE", "files capability port is unavailable.", "/files"),
    });
  }

  const candidates: SearchCandidate[] = [];
  const seen = new Set<string>();
  let denied = 0;
  let failed: SearchViewModelError | undefined;

  for (let scopeIndex = 0; scopeIndex < scopes.length; scopeIndex += 1) {
    const scope = scopes[scopeIndex];

    if (scope === undefined) continue;
    if (!hasDesktopCapabilityGrant(ports.package, "files.read", scope.grant)) {
      denied += 1;
      continue;
    }

    const state = createFileManagerState({
      grant: scope.grant,
      path: scope.path,
    });
    const listed = await loadFileManagerDirectory(ports.files, state, scope.path);

    if (listed.state.error !== undefined) {
      failed = listed.state.error;
      continue;
    }

    await collectFileEntries(
      ports.files,
      scope,
      scope.path,
      listed.state.entries,
      0,
      maxDepthForScope(scope),
      maxEntries,
      seen,
      candidates,
      scopeIndex,
    );

    if (candidates.length >= maxEntries) break;
  }

  return Object.freeze({
    candidates: Object.freeze(candidates),
    status: fileSourceStatus(candidates.length, denied, failed),
  });
}

async function collectFileEntries(
  files: FilesCapabilityPort,
  scope: SearchFileScope,
  directoryPath: string,
  entries: readonly FilesEntry[],
  depth: number,
  maxDepth: number,
  maxEntries: number,
  seen: Set<string>,
  candidates: SearchCandidate[],
  scopeIndex: number,
): Promise<void> {
  for (let entryIndex = 0; entryIndex < entries.length; entryIndex += 1) {
    if (candidates.length >= maxEntries) return;

    const entry = entries[entryIndex];

    if (entry === undefined) continue;

    const path = joinCapabilityPath(directoryPath, entry.name);
    const key = `${scope.grant}\u0000${path}`;

    if (seen.has(key)) continue;

    seen.add(key);
    candidates.push(fileCandidate(scope, path, entry, scopeIndex, candidates.length));

    if (entry.kind !== "dir" || depth >= maxDepth || candidates.length >= maxEntries) continue;

    const state = createFileManagerState({
      grant: scope.grant,
      path,
    });
    const listed = await loadFileManagerDirectory(files, state, path);

    if (listed.state.error !== undefined) continue;

    await collectFileEntries(
      files,
      scope,
      path,
      listed.state.entries,
      depth + 1,
      maxDepth,
      maxEntries,
      seen,
      candidates,
      scopeIndex,
    );
  }
}

function appCandidate(input: SearchAppInput, index: number): SearchCandidate {
  const subtitle = input.subtitle ?? "Application";
  const result: SearchAppResult = Object.freeze({
    app: freezeLaunchableApp(input.app),
    id: input.id,
    score: 0,
    source: "app",
    subtitle,
    title: input.title,
  });

  return Object.freeze({
    itemOrder: index,
    result,
    sourceOrder: sourceOrder("app"),
    terms: weightedTerms([
      term(input.title, 1_000),
      term(subtitle, 650),
      term(input.id, 350),
      term(input.app.id, 500),
      term(input.app.title, 850),
      ...keywordTerms(input.keywords, 450),
    ]),
  });
}

function commandCandidate(input: SearchCommandInput, index: number): SearchCandidate {
  const subtitle = input.subtitle ?? "Command";
  const result: SearchCommandResult = Object.freeze({
    id: input.id,
    intent: freezeLauncherIntent(input.intent),
    score: 0,
    source: "command",
    subtitle,
    title: input.title,
  });

  return Object.freeze({
    itemOrder: index,
    result,
    sourceOrder: sourceOrder("command"),
    terms: weightedTerms([
      term(input.title, 1_000),
      term(subtitle, 650),
      term(input.id, 350),
      term(input.intent.appId ?? "", 500),
      term(input.intent.query ?? "", 450),
      ...keywordTerms(input.keywords, 450),
    ]),
  });
}

function fileCandidate(
  scope: SearchFileScope,
  path: string,
  entry: FilesEntry,
  scopeIndex: number,
  itemIndex: number,
): SearchCandidate {
  const scopeLabel = scope.label ?? scope.grant;
  const subtitle = `${entry.kind} \u00b7 ${path}`;
  const result: SearchFileResult = Object.freeze({
    grant: scope.grant,
    id: `file:${scope.grant}:${path}`,
    kind: entry.kind,
    modified: entry.mtime,
    path,
    score: 0,
    size: entry.size,
    source: "file",
    subtitle,
    title: entry.name,
  });

  return Object.freeze({
    itemOrder: scopeIndex * 10_000 + itemIndex,
    result,
    sourceOrder: sourceOrder("file"),
    terms: weightedTerms([
      term(entry.name, 1_100),
      term(path, 850),
      term(scopeLabel, 450),
      term(entry.kind, 250),
    ]),
  });
}

function settingCandidate(input: SearchSettingInput, index: number): SearchCandidate {
  const subtitle = input.subtitle ?? "Settings";
  const appId = input.appId ?? SETTINGS_APP_ID;
  const intent = freezeLauncherIntent({
    appId,
    query: input.sectionId,
    type: "launcher.launch",
  });
  const result: SearchSettingResult = Object.freeze({
    id: input.id,
    intent,
    score: 0,
    sectionId: input.sectionId,
    source: "setting",
    subtitle,
    title: input.title,
  });

  return Object.freeze({
    itemOrder: index,
    result,
    sourceOrder: sourceOrder("setting"),
    terms: weightedTerms([
      term(input.title, 1_000),
      term(subtitle, 650),
      term(input.id, 350),
      term(input.sectionId, 550),
      term(appId, 300),
      ...keywordTerms(input.keywords, 450),
    ]),
  });
}

function scoreCandidate(candidate: SearchCandidate, query: string): number | null {
  let best: number | null = null;

  for (let index = 0; index < candidate.terms.length; index += 1) {
    const text = candidate.terms[index];

    if (text === undefined) continue;

    best = maxScore(best, scoreText(text.text, query, text.weight));
  }

  return best;
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

function compareRankedCandidates(left: RankedCandidate, right: RankedCandidate): number {
  const score = right.score - left.score;

  if (score !== 0) return score;

  const source = left.candidate.sourceOrder - right.candidate.sourceOrder;

  if (source !== 0) return source;

  const order = left.candidate.itemOrder - right.candidate.itemOrder;

  if (order !== 0) return order;

  return compareStrings(left.candidate.result.id, right.candidate.result.id);
}

function createDefaultSearchApps(): readonly SearchAppInput[] {
  const apps: SearchAppInput[] = [];

  for (let index = 0; index < DEFAULT_INDEX_PALETTE_COMMANDS.length; index += 1) {
    const command = DEFAULT_INDEX_PALETTE_COMMANDS[index];

    if (command === undefined || command.kind !== "app" || command.action.type !== "launchApp") continue;
    apps.push(freezeAppInput({
      app: command.action.app,
      id: command.id,
      keywords: Object.freeze([command.action.app.id]),
      subtitle: command.subtitle,
      title: command.title,
    }));
  }

  return Object.freeze(apps);
}

function createDefaultSearchCommands(): readonly SearchCommandInput[] {
  const commands: SearchCommandInput[] = [];

  for (let index = 0; index < DEFAULT_INDEX_PALETTE_COMMANDS.length; index += 1) {
    const command = DEFAULT_INDEX_PALETTE_COMMANDS[index];

    if (command === undefined || command.kind !== "command" || command.action.type !== "launcherIntent") continue;
    commands.push(freezeCommandInput({
      id: command.id,
      intent: command.action.intent,
      keywords: defaultCommandKeywords(command),
      subtitle: command.subtitle,
      title: command.title,
    }));
  }

  return Object.freeze(commands);
}

function createDefaultSearchSettings(): readonly SearchSettingInput[] {
  const settings: SearchSettingInput[] = [];

  for (let index = 0; index < SETTINGS_SECTIONS.length; index += 1) {
    const section = SETTINGS_SECTIONS[index];

    if (section === undefined) continue;
    settings.push(freezeSettingInput({
      appId: SETTINGS_APP_ID,
      id: `setting.${section.id}`,
      keywords: Object.freeze([section.group, section.icon, section.id, "settings"]),
      sectionId: section.id,
      subtitle: `${section.group} settings`,
      title: section.label,
    }));
  }

  return Object.freeze(settings);
}

function defaultCommandKeywords(command: IndexPaletteCommand): readonly string[] {
  if (command.action.type !== "launcherIntent") return Object.freeze([]);

  const output: string[] = [];

  if (command.action.intent.appId !== undefined) output.push(command.action.intent.appId);
  if (command.action.intent.query !== undefined) output.push(command.action.intent.query);

  return Object.freeze(output);
}

function freezeState(input: {
  readonly query: string;
  readonly results: readonly SearchResult[];
  readonly selectedIndex: number;
  readonly sources: readonly SearchSourceStatus[];
}): SearchViewState {
  const results = Object.freeze(input.results.map(freezeResult));
  const selected = input.selectedIndex >= 0 ? results[input.selectedIndex] : undefined;
  const output: {
    query: string;
    results: readonly SearchResult[];
    groups: readonly SearchResultGroup[];
    selectedIndex: number;
    sources: readonly SearchSourceStatus[];
    selected?: SearchResult;
  } = {
    groups: groupResults(results),
    query: input.query,
    results,
    selectedIndex: selected === undefined ? -1 : input.selectedIndex,
    sources: Object.freeze(input.sources.map(freezeSourceStatus)),
  };

  if (selected !== undefined) output.selected = selected;

  return Object.freeze(output);
}

function groupResults(results: readonly SearchResult[]): readonly SearchResultGroup[] {
  if (results.length === 0) return Object.freeze([]);

  const groups: SearchResultGroup[] = [];

  for (let sourceIndex = 0; sourceIndex < SOURCE_ORDER.length; sourceIndex += 1) {
    const source = SOURCE_ORDER[sourceIndex];

    if (source === undefined) continue;

    const groupResultsForSource: SearchResult[] = [];

    for (let resultIndex = 0; resultIndex < results.length; resultIndex += 1) {
      const result = results[resultIndex];

      if (result !== undefined && result.source === source) groupResultsForSource.push(result);
    }

    if (groupResultsForSource.length === 0) continue;
    groups.push(Object.freeze({
      label: SOURCE_LABELS[source],
      results: Object.freeze(groupResultsForSource),
      source,
    }));
  }

  return Object.freeze(groups);
}

function freezeAppInputs(inputs: readonly SearchAppInput[]): readonly SearchAppInput[] {
  const output: SearchAppInput[] = [];

  for (let index = 0; index < inputs.length; index += 1) {
    const input = inputs[index];

    if (input !== undefined) output.push(freezeAppInput(input));
  }

  return Object.freeze(output);
}

function freezeCommandInputs(inputs: readonly SearchCommandInput[]): readonly SearchCommandInput[] {
  const output: SearchCommandInput[] = [];

  for (let index = 0; index < inputs.length; index += 1) {
    const input = inputs[index];

    if (input !== undefined) output.push(freezeCommandInput(input));
  }

  return Object.freeze(output);
}

function freezeFileScopes(inputs: readonly SearchFileScope[]): readonly SearchFileScope[] {
  const output: SearchFileScope[] = [];

  for (let index = 0; index < inputs.length; index += 1) {
    const input = inputs[index];

    if (input === undefined || input.grant.length === 0 || input.path.length === 0) continue;

    const scope: {
      grant: string;
      path: string;
      label?: string;
      maxDepth?: number;
    } = {
      grant: input.grant,
      path: input.path,
    };

    if (input.label !== undefined) scope.label = input.label;
    if (input.maxDepth !== undefined) scope.maxDepth = input.maxDepth;
    output.push(Object.freeze(scope));
  }

  return Object.freeze(output);
}

function freezeSettingInputs(inputs: readonly SearchSettingInput[]): readonly SearchSettingInput[] {
  const output: SearchSettingInput[] = [];

  for (let index = 0; index < inputs.length; index += 1) {
    const input = inputs[index];

    if (input !== undefined) output.push(freezeSettingInput(input));
  }

  return Object.freeze(output);
}

function freezeAppInput(input: SearchAppInput): SearchAppInput {
  const output: {
    id: string;
    title: string;
    app: DesktopLaunchableApp;
    subtitle?: string;
    keywords?: readonly string[];
  } = {
    app: freezeLaunchableApp(input.app),
    id: input.id,
    title: input.title,
  };

  if (input.subtitle !== undefined) output.subtitle = input.subtitle;
  if (input.keywords !== undefined) output.keywords = freezeStringArray(input.keywords);

  return Object.freeze(output);
}

function freezeCommandInput(input: SearchCommandInput): SearchCommandInput {
  const output: {
    id: string;
    title: string;
    intent: DesktopLauncherIntent;
    subtitle?: string;
    keywords?: readonly string[];
  } = {
    id: input.id,
    intent: freezeLauncherIntent(input.intent),
    title: input.title,
  };

  if (input.subtitle !== undefined) output.subtitle = input.subtitle;
  if (input.keywords !== undefined) output.keywords = freezeStringArray(input.keywords);

  return Object.freeze(output);
}

function freezeSettingInput(input: SearchSettingInput): SearchSettingInput {
  const output: {
    id: string;
    title: string;
    sectionId: string;
    subtitle?: string;
    appId?: string;
    keywords?: readonly string[];
  } = {
    id: input.id,
    sectionId: input.sectionId,
    title: input.title,
  };

  if (input.subtitle !== undefined) output.subtitle = input.subtitle;
  if (input.appId !== undefined) output.appId = input.appId;
  if (input.keywords !== undefined) output.keywords = freezeStringArray(input.keywords);

  return Object.freeze(output);
}

function freezeResultWithScore(result: SearchResult, score: number): SearchResult {
  switch (result.source) {
    case "app":
      return Object.freeze({
        app: freezeLaunchableApp(result.app),
        id: result.id,
        score,
        source: "app",
        subtitle: result.subtitle,
        title: result.title,
      });
    case "command":
      return Object.freeze({
        id: result.id,
        intent: freezeLauncherIntent(result.intent),
        score,
        source: "command",
        subtitle: result.subtitle,
        title: result.title,
      });
    case "file":
      return Object.freeze({
        grant: result.grant,
        id: result.id,
        kind: result.kind,
        modified: result.modified,
        path: result.path,
        score,
        size: result.size,
        source: "file",
        subtitle: result.subtitle,
        title: result.title,
      });
    case "setting":
      return Object.freeze({
        id: result.id,
        intent: freezeLauncherIntent(result.intent),
        score,
        sectionId: result.sectionId,
        source: "setting",
        subtitle: result.subtitle,
        title: result.title,
      });
  }
}

function freezeResult(result: SearchResult): SearchResult {
  return freezeResultWithScore(result, result.score);
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

function freezeStringArray(input: readonly string[]): readonly string[] {
  const output: string[] = [];

  for (let index = 0; index < input.length; index += 1) {
    const value = input[index];

    if (value !== undefined) output.push(value);
  }

  return Object.freeze(output);
}

function fileOpenValue(
  result: SearchFileResult,
  status: FileManagerStatus,
  entries: readonly FilesEntry[],
  selected: {
    readonly data?: string;
    readonly size?: number;
    readonly mtime?: string;
  } | undefined,
): SearchFileOpen {
  const output: {
    grant: string;
    path: string;
    kind: FilesEntry["kind"];
    status: FileManagerStatus;
    entries?: readonly FilesEntry[];
    data?: string;
    size?: number;
    modified?: string;
  } = {
    grant: result.grant,
    kind: result.kind,
    path: result.path,
    status,
  };

  if (result.kind === "dir") output.entries = Object.freeze(entries.map(freezeFilesEntry));
  if (selected?.data !== undefined) output.data = selected.data;
  if (selected?.size !== undefined) output.size = selected.size;
  if (selected?.mtime !== undefined) output.modified = selected.mtime;

  return Object.freeze(output);
}

function freezeFilesEntry(entry: FilesEntry): FilesEntry {
  return Object.freeze({
    kind: entry.kind,
    mtime: entry.mtime,
    name: entry.name,
    size: entry.size,
  });
}

function fileResultStat(result: SearchFileResult): {
  readonly kind: "file";
  readonly size: number;
  readonly mtime: string;
} {
  return Object.freeze({
    kind: "file",
    mtime: result.modified,
    size: result.size,
  });
}

function weightedTerms(input: readonly WeightedText[]): readonly WeightedText[] {
  const output: WeightedText[] = [];

  for (let index = 0; index < input.length; index += 1) {
    const item = input[index];

    if (item !== undefined && item.text.length > 0) output.push(item);
  }

  return Object.freeze(output);
}

function keywordTerms(keywords: readonly string[] | undefined, weight: number): readonly WeightedText[] {
  if (keywords === undefined) return Object.freeze([]);

  const output: WeightedText[] = [];

  for (let index = 0; index < keywords.length; index += 1) {
    const keyword = keywords[index];

    if (keyword !== undefined && keyword.length > 0) output.push(term(keyword, weight));
  }

  return Object.freeze(output);
}

function term(textValue: string, weight: number): WeightedText {
  return Object.freeze({
    text: textValue,
    weight,
  });
}

function maxScore(left: number | null, right: number | null): number | null {
  if (right === null) return left;
  if (left === null || right > left) return right;

  return left;
}

function fileSourceStatus(
  candidateCount: number,
  denied: number,
  failed: SearchViewModelError | undefined,
): SearchSourceStatus {
  if (candidateCount > 0) return readySourceStatus("file");
  if (failed !== undefined) {
    return Object.freeze({
      error: failed,
      label: SOURCE_LABELS.file,
      source: "file",
      status: failed.code === "AccessForbidden" ? "forbidden" : "error",
    });
  }
  if (denied > 0) return forbiddenSourceStatus("file", "files.read");

  return readySourceStatus("file");
}

function statusForCandidateCount(source: SearchSource, candidateCount: number, denied: number): SearchSourceStatus {
  if (candidateCount > 0 || denied === 0) return readySourceStatus(source);

  const capability = source === "app" ? "apps.launch" : "launcher.launch";

  return forbiddenSourceStatus(source, capability);
}

function readySourceStatus(source: SearchSource): SearchSourceStatus {
  return Object.freeze({
    label: SOURCE_LABELS[source],
    source,
    status: "ready",
  });
}

function idleSourceStatus(source: SearchSource): SearchSourceStatus {
  return Object.freeze({
    label: SOURCE_LABELS[source],
    source,
    status: "idle",
  });
}

function forbiddenSourceStatus(source: SearchSource, capability: DesktopCapability): SearchSourceStatus {
  return Object.freeze({
    error: error(
      "MISSING_CAPABILITY",
      `${SOURCE_LABELS[source]} source requires ${capability}.`,
      `/sources/${source}/capability`,
    ),
    label: SOURCE_LABELS[source],
    source,
    status: "forbidden",
  });
}

function unavailableSourceStatus(
  source: SearchSource,
  code: string,
  message: string,
  path: string,
): SearchSourceStatus {
  return Object.freeze({
    error: error(code, message, path),
    label: SOURCE_LABELS[source],
    source,
    status: "unavailable",
  });
}

function freezeSourceStatus(status: SearchSourceStatus): SearchSourceStatus {
  const output: {
    source: SearchSource;
    label: string;
    status: SearchSourceStatusKind;
    error?: SearchViewModelError;
  } = {
    label: status.label,
    source: status.source,
    status: status.status,
  };

  if (status.error !== undefined) output.error = status.error;

  return Object.freeze(output);
}

function missingCapability(
  capability: DesktopCapability,
  resourceId: string | undefined,
  resultId: string,
): SearchViewModelError {
  return error(
    "MISSING_CAPABILITY",
    resourceId === undefined
      ? `search result '${resultId}' requires ${capability}.`
      : `search result '${resultId}' requires ${capability}:${resourceId}.`,
    `/results/${pathToken(resultId)}/capability`,
  );
}

function hostError(errorValue: DesktopHostError): SearchViewModelError {
  return error(errorValue.code, errorValue.message, errorValue.path);
}

function error(code: string, message: string, path: string): SearchViewModelError {
  return Object.freeze({
    code,
    message,
    path,
  });
}

function rejectExecute(
  errorValue: SearchViewModelError,
  result?: SearchResult,
): SearchExecuteResult {
  const output: {
    ok: false;
    error: SearchViewModelError;
    result?: SearchResult;
  } = {
    error: errorValue,
    ok: false,
  };

  if (result !== undefined) output.result = result;

  return Object.freeze(output);
}

function rejectLauncherEmit(
  errorValue: SearchViewModelError,
  result: SearchCommandResult | SearchSettingResult,
): LauncherEmitResult {
  return Object.freeze({
    error: errorValue,
    ok: false,
    result,
  });
}

function normalizeSearch(value: string): string {
  return value.trim().toLocaleLowerCase("en-US");
}

function sourceOrder(source: SearchSource): number {
  for (let index = 0; index < SOURCE_ORDER.length; index += 1) {
    if (SOURCE_ORDER[index] === source) return index;
  }

  return SOURCE_ORDER.length;
}

function maxDepthForScope(scope: SearchFileScope): number {
  if (scope.maxDepth === undefined) return DEFAULT_FILE_MAX_DEPTH;
  if (!Number.isFinite(scope.maxDepth)) return DEFAULT_FILE_MAX_DEPTH;

  return Math.max(0, Math.min(MAX_FILE_MAX_DEPTH, Math.trunc(scope.maxDepth)));
}

function normalizePositiveInteger(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isSafeInteger(value) || value <= 0) return fallback;

  return value;
}

function positiveModulo(value: number, modulus: number): number {
  return ((value % modulus) + modulus) % modulus;
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

function compareStrings(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;

  return 0;
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

  return token.length === 0 ? "_" : token;
}
