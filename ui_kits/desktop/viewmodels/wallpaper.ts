import {
  hasDesktopCapabilityGrant,
  requestSettingsApply,
  requestSettingsPreview,
  settleSettingsControlPlaneResult,
} from "../../../sdk/typescript/src/desktop-sdk/index.ts";
import type {
  DesktopUiPackageManifest,
  SettingsAppState,
  SettingsControlPlaneIntent,
  SettingsControlPlanePort,
  SettingsControlPlaneResult,
  SettingsEdit,
  SettingsManagedConfig,
  SettingsValue,
} from "../../../sdk/typescript/src/desktop-sdk/index.ts";

export const WALLPAPER_SETTINGS_CATEGORY_ID = "appearance";

export const WALLPAPER_SETTING_KEYS = Object.freeze({
  fit: "appearance.wallpaper.fit",
  slideshowIntervalMs: "appearance.wallpaper.slideshow.intervalMs",
  slideshowSources: "appearance.wallpaper.slideshow.sources",
  solidColor: "appearance.wallpaper.solidColor",
  sourceRef: "appearance.wallpaper.sourceRef",
  workspaceOverrides: "appearance.wallpaper.workspaceOverrides",
});

export const WALLPAPER_FIT_MODES = Object.freeze([
  "fill",
  "fit",
  "stretch",
  "center",
  "tile",
] as const);

export type WallpaperFit = typeof WALLPAPER_FIT_MODES[number];
export type WallpaperSourceRef = string;
export type WallpaperResolvedKind = "source" | "solidColor";

export interface WallpaperWorkspaceOverride {
  readonly workspaceId: string;
  readonly sourceRef: WallpaperSourceRef;
  readonly fit: WallpaperFit;
}

export interface WallpaperSlideshowState {
  readonly sources: readonly WallpaperSourceRef[];
  readonly intervalMs: number;
  readonly index: number;
  readonly sourceRef: WallpaperSourceRef | null;
}

export interface WallpaperResolvedState {
  readonly kind: WallpaperResolvedKind;
  readonly workspaceId: string;
  readonly sourceRef: WallpaperSourceRef | null;
  readonly fit: WallpaperFit;
  readonly solidColor: string;
}

export interface WallpaperViewModelState {
  readonly sourceRef: WallpaperSourceRef | null;
  readonly fit: WallpaperFit;
  readonly solidColor: string;
  readonly activeWorkspaceId: string;
  readonly workspaceOverrides: readonly WallpaperWorkspaceOverride[];
  readonly slideshow: WallpaperSlideshowState;
  readonly resolved: WallpaperResolvedState;
  readonly canWrite: boolean;
}

export interface WallpaperViewModelError {
  readonly code: string;
  readonly message: string;
  readonly path: string;
}

export type WallpaperViewModelResult<T> =
  | {
      readonly ok: true;
      readonly value: T;
    }
  | {
      readonly ok: false;
      readonly error: WallpaperViewModelError;
    };

export type WallpaperViewModelActionResult =
  | {
      readonly ok: true;
      readonly state: WallpaperViewModelState;
    }
  | {
      readonly ok: false;
      readonly error: WallpaperViewModelError;
      readonly state: WallpaperViewModelState;
    };

export interface WallpaperClock {
  nowMs(): number;
}

export interface WallpaperViewModelOptions {
  readonly package: DesktopUiPackageManifest;
  readonly settings: SettingsControlPlanePort;
  readonly settingsState: SettingsAppState;
  readonly activeWorkspaceId?: string;
}

export interface WallpaperViewModel {
  readonly state: WallpaperViewModelState;
  snapshot(): WallpaperViewModelState;
  setWallpaper(ref: unknown): Promise<WallpaperViewModelActionResult>;
  setFit(mode: unknown): Promise<WallpaperViewModelActionResult>;
  setForWorkspace(workspaceId: unknown, sourceRef: unknown, fit?: unknown): Promise<WallpaperViewModelActionResult>;
  advance(clock: WallpaperClock): Promise<WallpaperViewModelActionResult>;
}

type NormalizeResult<T> =
  | {
      readonly ok: true;
      readonly value: T;
    }
  | {
      readonly ok: false;
      readonly error: WallpaperViewModelError;
    };

const DEFAULT_ACTIVE_WORKSPACE_ID = "workspace-1";
const EMPTY_OVERRIDES: readonly WallpaperWorkspaceOverride[] = Object.freeze([]);
const EMPTY_SOURCES: readonly WallpaperSourceRef[] = Object.freeze([]);

export function createWallpaperViewModel(
  options: WallpaperViewModelOptions,
): WallpaperViewModelResult<WallpaperViewModel> {
  const activeWorkspaceId = normalizeWorkspaceId(
    options.activeWorkspaceId ?? DEFAULT_ACTIVE_WORKSPACE_ID,
    "/activeWorkspaceId",
  );

  if (!activeWorkspaceId.ok) return rejectFromError(activeWorkspaceId.error);

  const state = stateFromSettings(options.settingsState, options.package, activeWorkspaceId.value);

  if (!state.ok) return rejectFromError(state.error);

  return accept(new DesktopWallpaperViewModel(options, activeWorkspaceId.value, state.value));
}

class DesktopWallpaperViewModel implements WallpaperViewModel {
  readonly #manifest: DesktopUiPackageManifest;
  readonly #settings: SettingsControlPlanePort;
  readonly #activeWorkspaceId: string;
  #settingsState: SettingsAppState;
  #state: WallpaperViewModelState;

  constructor(
    options: WallpaperViewModelOptions,
    activeWorkspaceId: string,
    state: WallpaperViewModelState,
  ) {
    this.#manifest = options.package;
    this.#settings = options.settings;
    this.#settingsState = options.settingsState;
    this.#activeWorkspaceId = activeWorkspaceId;
    this.#state = state;
  }

  get state(): WallpaperViewModelState {
    return this.#state;
  }

  snapshot(): WallpaperViewModelState {
    return this.#state;
  }

  async setWallpaper(ref: unknown): Promise<WallpaperViewModelActionResult> {
    const sourceRef = normalizeOptionalSourceRef(ref, "/sourceRef");

    if (!sourceRef.ok) return actionReject(sourceRef.error, this.#state);

    return await this.#commitSetting(
      WALLPAPER_SETTING_KEYS.sourceRef,
      encodeOptionalSourceRef(sourceRef.value),
      "/sourceRef",
    );
  }

  async setFit(mode: unknown): Promise<WallpaperViewModelActionResult> {
    const fit = normalizeFit(mode, "/fit");

    if (!fit.ok) return actionReject(fit.error, this.#state);

    return await this.#commitSetting(WALLPAPER_SETTING_KEYS.fit, fit.value, "/fit");
  }

  async setForWorkspace(
    workspaceIdInput: unknown,
    sourceRefInput: unknown,
    fitInput?: unknown,
  ): Promise<WallpaperViewModelActionResult> {
    const workspaceId = normalizeWorkspaceId(workspaceIdInput, "/workspaceId");

    if (!workspaceId.ok) return actionReject(workspaceId.error, this.#state);

    const override = normalizeWorkspaceOverrideInput(workspaceId.value, sourceRefInput, fitInput);

    if (!override.ok) return actionReject(override.error, this.#state);

    const nextOverrides = upsertWorkspaceOverride(this.#state.workspaceOverrides, override.value);

    return await this.#commitSetting(
      WALLPAPER_SETTING_KEYS.workspaceOverrides,
      encodeWorkspaceOverrides(nextOverrides),
      "/workspaceOverrides",
    );
  }

  async advance(clock: WallpaperClock): Promise<WallpaperViewModelActionResult> {
    const nowMs = readClock(clock);

    if (!nowMs.ok) return actionReject(nowMs.error, this.#state);

    const next = slideshowSourceAt(this.#state.slideshow.sources, this.#state.slideshow.intervalMs, nowMs.value);

    if (!next.ok) return actionReject(next.error, this.#state);

    return await this.#commitSetting(WALLPAPER_SETTING_KEYS.sourceRef, next.value.sourceRef, "/slideshow/sourceRef");
  }

  async #commitSetting(
    settingId: string,
    value: SettingsValue,
    path: string,
  ): Promise<WallpaperViewModelActionResult> {
    if (!hasDesktopCapabilityGrant(this.#manifest, "settings.write", settingId)) {
      return actionReject(error(
        "MISSING_CAPABILITY",
        "settings.write grant is required to update wallpaper settings.",
        `/capabilityGrants/settings.write/${pathToken(settingId)}`,
      ), this.#state);
    }

    const edit = freezeEdit(settingId, value);
    const preview = requestSettingsPreview(this.#settingsState, edit);

    if (!preview.ok) return actionReject(appError(preview.error), this.#state);

    const previewResult = await emitControlPlaneIntent(this.#settings, preview.value.intent);
    const previewAccepted = acceptedStage(previewResult, "preview", "/controlPlane/preview");

    if (!previewAccepted.ok) return actionReject(previewAccepted.error, this.#state);

    const previewState = settleSettingsControlPlaneResult(
      preview.value.state,
      preview.value.intent,
      previewResult,
    );
    const apply = requestSettingsApply(previewState, edit);

    if (!apply.ok) return actionReject(appError(apply.error), this.#state);

    const applyResult = await emitControlPlaneIntent(this.#settings, apply.value.intent);
    const applyAccepted = acceptedStage(applyResult, "apply", "/controlPlane/apply");

    if (!applyAccepted.ok) return actionReject(applyAccepted.error, this.#state);

    const committed = settleSettingsControlPlaneResult(apply.value.state, apply.value.intent, applyResult);
    const state = stateFromSettings(committed, this.#manifest, this.#activeWorkspaceId);

    if (!state.ok) return actionReject(state.error, this.#state);

    this.#settingsState = committed;
    this.#state = state.value;

    return actionAccept(this.#state);
  }
}

function stateFromSettings(
  state: SettingsAppState,
  manifest: DesktopUiPackageManifest,
  activeWorkspaceId: string,
): NormalizeResult<WallpaperViewModelState> {
  const sourceRef = readOptionalSourceSetting(state.config, WALLPAPER_SETTING_KEYS.sourceRef, "/sourceRef");

  if (!sourceRef.ok) return sourceRef;

  const fit = readFitSetting(state.config, WALLPAPER_SETTING_KEYS.fit, "/fit");

  if (!fit.ok) return fit;

  const solidColor = readTextSetting(state.config, WALLPAPER_SETTING_KEYS.solidColor, "/solidColor");

  if (!solidColor.ok) return solidColor;

  const workspaceOverrides = readWorkspaceOverrides(state.config);

  if (!workspaceOverrides.ok) return workspaceOverrides;

  const slideshowSources = readSlideshowSources(state.config);

  if (!slideshowSources.ok) return slideshowSources;

  const slideshowIntervalMs = readSlideshowIntervalMs(state.config);

  if (!slideshowIntervalMs.ok) return slideshowIntervalMs;

  return acceptNormalize(freezeWallpaperState({
    activeWorkspaceId,
    canWrite: canWriteWallpaperSettings(manifest),
    fit: fit.value,
    slideshowIntervalMs: slideshowIntervalMs.value,
    slideshowSources: slideshowSources.value,
    solidColor: solidColor.value,
    sourceRef: sourceRef.value,
    workspaceOverrides: workspaceOverrides.value,
  }));
}

function freezeWallpaperState(input: {
  readonly sourceRef: WallpaperSourceRef | null;
  readonly fit: WallpaperFit;
  readonly solidColor: string;
  readonly activeWorkspaceId: string;
  readonly workspaceOverrides: readonly WallpaperWorkspaceOverride[];
  readonly slideshowSources: readonly WallpaperSourceRef[];
  readonly slideshowIntervalMs: number;
  readonly canWrite: boolean;
}): WallpaperViewModelState {
  const overrides = freezeWorkspaceOverrides(input.workspaceOverrides);
  const override = workspaceOverrideFor(overrides, input.activeWorkspaceId);
  const resolvedSourceRef = override?.sourceRef ?? input.sourceRef;
  const resolvedFit = override?.fit ?? input.fit;
  const slideshowIndex = slideshowIndexForSource(input.slideshowSources, input.sourceRef);
  const slideshowSourceRef = slideshowIndex < 0 ? null : input.slideshowSources[slideshowIndex] ?? null;
  const slideshow = Object.freeze({
    index: slideshowIndex,
    intervalMs: input.slideshowIntervalMs,
    sourceRef: slideshowSourceRef,
    sources: Object.freeze([...input.slideshowSources]),
  });

  return Object.freeze({
    activeWorkspaceId: input.activeWorkspaceId,
    canWrite: input.canWrite,
    fit: input.fit,
    resolved: Object.freeze({
      fit: resolvedFit,
      kind: resolvedSourceRef === null ? "solidColor" : "source",
      solidColor: input.solidColor,
      sourceRef: resolvedSourceRef,
      workspaceId: input.activeWorkspaceId,
    }),
    slideshow,
    solidColor: input.solidColor,
    sourceRef: input.sourceRef,
    workspaceOverrides: overrides,
  });
}

function readOptionalSourceSetting(
  config: SettingsManagedConfig,
  settingId: string,
  path: string,
): NormalizeResult<WallpaperSourceRef | null> {
  const value = readSettingValue(config, settingId, path);

  if (!value.ok) return value;

  return normalizeOptionalSourceRef(value.value, path);
}

function readFitSetting(
  config: SettingsManagedConfig,
  settingId: string,
  path: string,
): NormalizeResult<WallpaperFit> {
  const value = readSettingValue(config, settingId, path);

  if (!value.ok) return value;

  return normalizeFit(value.value, path);
}

function readTextSetting(
  config: SettingsManagedConfig,
  settingId: string,
  path: string,
): NormalizeResult<string> {
  const value = readSettingValue(config, settingId, path);

  if (!value.ok) return value;
  if (typeof value.value !== "string" || value.value.length === 0) {
    return rejectNormalize(error("MALFORMED_SETTING", "wallpaper setting must be a non-empty string.", path));
  }

  return acceptNormalize(value.value);
}

function readWorkspaceOverrides(config: SettingsManagedConfig): NormalizeResult<readonly WallpaperWorkspaceOverride[]> {
  const value = readSettingValue(config, WALLPAPER_SETTING_KEYS.workspaceOverrides, "/workspaceOverrides");

  if (!value.ok) return value;
  if (typeof value.value !== "string") {
    return rejectNormalize(error("MALFORMED_SETTING", "workspace overrides must be encoded as text.", "/workspaceOverrides"));
  }

  return parseWorkspaceOverrides(value.value);
}

function readSlideshowSources(config: SettingsManagedConfig): NormalizeResult<readonly WallpaperSourceRef[]> {
  const value = readSettingValue(config, WALLPAPER_SETTING_KEYS.slideshowSources, "/slideshow/sources");

  if (!value.ok) return value;
  if (typeof value.value !== "string") {
    return rejectNormalize(error("MALFORMED_SETTING", "slideshow sources must be encoded as text.", "/slideshow/sources"));
  }

  return parseSlideshowSources(value.value);
}

function readSlideshowIntervalMs(config: SettingsManagedConfig): NormalizeResult<number> {
  const value = readSettingValue(config, WALLPAPER_SETTING_KEYS.slideshowIntervalMs, "/slideshow/intervalMs");

  if (!value.ok) return value;
  if (
    typeof value.value !== "number" ||
    !Number.isSafeInteger(value.value) ||
    value.value <= 0
  ) {
    return rejectNormalize(error(
      "MALFORMED_SETTING",
      "slideshow interval must be a positive safe integer.",
      "/slideshow/intervalMs",
    ));
  }

  return acceptNormalize(value.value);
}

function readSettingValue(
  config: SettingsManagedConfig,
  settingId: string,
  path: string,
): NormalizeResult<SettingsValue> {
  const category = settingsCategory(config, WALLPAPER_SETTINGS_CATEGORY_ID);

  if (category === null) {
    return rejectNormalize(error(
      "UNKNOWN_SETTING_CATEGORY",
      "wallpaper appearance settings category is unavailable.",
      "/settings/appearance",
    ));
  }

  for (let index = 0; index < category.settings.length; index += 1) {
    const setting = category.settings[index];

    if (setting !== undefined && setting.id === settingId) {
      return acceptNormalize(setting.value);
    }
  }

  return rejectNormalize(error("UNKNOWN_SETTING", "wallpaper setting is unavailable.", path));
}

function settingsCategory(
  config: SettingsManagedConfig,
  categoryId: string,
): SettingsManagedConfig["categories"][number] | null {
  for (let index = 0; index < config.categories.length; index += 1) {
    const category = config.categories[index];

    if (category !== undefined && category.id === categoryId) return category;
  }

  return null;
}

function normalizeOptionalSourceRef(input: unknown, path: string): NormalizeResult<WallpaperSourceRef | null> {
  if (input === null || input === undefined) return acceptNormalize(null);
  if (typeof input !== "string") {
    return rejectNormalize(error("INVALID_WALLPAPER_REF", "wallpaper source ref must be text.", path));
  }
  if (input.length === 0) return acceptNormalize(null);

  return acceptNormalize(input);
}

function normalizeRequiredSourceRef(input: unknown, path: string): NormalizeResult<WallpaperSourceRef> {
  if (typeof input !== "string" || input.length === 0) {
    return rejectNormalize(error("INVALID_WALLPAPER_REF", "wallpaper source ref must be non-empty text.", path));
  }

  return acceptNormalize(input);
}

function normalizeFit(input: unknown, path: string): NormalizeResult<WallpaperFit> {
  if (typeof input !== "string" || !isWallpaperFit(input)) {
    return rejectNormalize(error("UNKNOWN_WALLPAPER_FIT", "wallpaper fit mode is not supported.", path));
  }

  return acceptNormalize(input);
}

function normalizeWorkspaceId(input: unknown, path: string): NormalizeResult<string> {
  if (typeof input !== "string" || input.length === 0) {
    return rejectNormalize(error("INVALID_WORKSPACE_ID", "workspace id must be non-empty text.", path));
  }

  return acceptNormalize(input);
}

function normalizeWorkspaceOverrideInput(
  workspaceId: string,
  sourceRefInput: unknown,
  fitInput: unknown,
): NormalizeResult<WallpaperWorkspaceOverride> {
  if (fitInput === undefined && isPlainDataObject(sourceRefInput)) {
    if (!hasOnlyStringKeys(sourceRefInput, ["fit", "sourceRef"])) {
      return rejectNormalize(error(
        "INVALID_WORKSPACE_OVERRIDE",
        "workspace wallpaper override must contain only sourceRef and fit.",
        "/workspaceOverride",
      ));
    }

    const sourceRef = normalizeRequiredSourceRef(dataField(sourceRefInput, "sourceRef"), "/workspaceOverride/sourceRef");

    if (!sourceRef.ok) return sourceRef;

    const fit = normalizeFit(dataField(sourceRefInput, "fit"), "/workspaceOverride/fit");

    if (!fit.ok) return fit;

    return acceptNormalize(freezeWorkspaceOverride({
      fit: fit.value,
      sourceRef: sourceRef.value,
      workspaceId,
    }));
  }

  const sourceRef = normalizeRequiredSourceRef(sourceRefInput, "/workspaceOverride/sourceRef");

  if (!sourceRef.ok) return sourceRef;

  const fit = normalizeFit(fitInput, "/workspaceOverride/fit");

  if (!fit.ok) return fit;

  return acceptNormalize(freezeWorkspaceOverride({
    fit: fit.value,
    sourceRef: sourceRef.value,
    workspaceId,
  }));
}

function parseWorkspaceOverrides(encoded: string): NormalizeResult<readonly WallpaperWorkspaceOverride[]> {
  const parsed = parseJsonArray(encoded, "/workspaceOverrides");

  if (!parsed.ok) return parsed;

  const overrides: WallpaperWorkspaceOverride[] = [];

  for (let index = 0; index < parsed.value.length; index += 1) {
    const item = parsed.value[index];
    const override = normalizeStoredWorkspaceOverride(item, `/workspaceOverrides/${index}`);

    if (!override.ok) return override;
    if (workspaceOverrideFor(overrides, override.value.workspaceId) === null) {
      overrides.push(override.value);
    }
  }

  return acceptNormalize(Object.freeze(overrides));
}

function normalizeStoredWorkspaceOverride(input: unknown, path: string): NormalizeResult<WallpaperWorkspaceOverride> {
  if (!isPlainDataObject(input) || !hasOnlyStringKeys(input, ["fit", "sourceRef", "workspaceId"])) {
    return rejectNormalize(error(
      "MALFORMED_SETTING",
      "workspace override must contain workspaceId, sourceRef, and fit.",
      path,
    ));
  }

  const workspaceId = normalizeWorkspaceId(dataField(input, "workspaceId"), `${path}/workspaceId`);

  if (!workspaceId.ok) return workspaceId;

  const sourceRef = normalizeRequiredSourceRef(dataField(input, "sourceRef"), `${path}/sourceRef`);

  if (!sourceRef.ok) return sourceRef;

  const fit = normalizeFit(dataField(input, "fit"), `${path}/fit`);

  if (!fit.ok) return fit;

  return acceptNormalize(freezeWorkspaceOverride({
    fit: fit.value,
    sourceRef: sourceRef.value,
    workspaceId: workspaceId.value,
  }));
}

function parseSlideshowSources(encoded: string): NormalizeResult<readonly WallpaperSourceRef[]> {
  const parsed = parseJsonArray(encoded, "/slideshow/sources");

  if (!parsed.ok) return parsed;

  if (parsed.value.length === 0) return acceptNormalize(EMPTY_SOURCES);

  const sources: WallpaperSourceRef[] = [];

  for (let index = 0; index < parsed.value.length; index += 1) {
    const source = normalizeRequiredSourceRef(parsed.value[index], `/slideshow/sources/${index}`);

    if (!source.ok) return source;
    sources.push(source.value);
  }

  return acceptNormalize(Object.freeze(sources));
}

function parseJsonArray(encoded: string, path: string): NormalizeResult<readonly unknown[]> {
  if (encoded.trim().length === 0) return acceptNormalize(Object.freeze([]));

  let parsed: unknown;

  try {
    parsed = JSON.parse(encoded);
  } catch {
    return rejectNormalize(error("MALFORMED_SETTING", "setting must contain deterministic JSON.", path));
  }

  if (!Array.isArray(parsed)) {
    return rejectNormalize(error("MALFORMED_SETTING", "setting JSON must be an array.", path));
  }

  return acceptNormalize(parsed);
}

function upsertWorkspaceOverride(
  overrides: readonly WallpaperWorkspaceOverride[],
  override: WallpaperWorkspaceOverride,
): readonly WallpaperWorkspaceOverride[] {
  const next: WallpaperWorkspaceOverride[] = [];
  let replaced = false;

  for (let index = 0; index < overrides.length; index += 1) {
    const current = overrides[index];

    if (current === undefined) continue;
    if (current.workspaceId === override.workspaceId) {
      next.push(override);
      replaced = true;
    } else {
      next.push(current);
    }
  }

  if (!replaced) next.push(override);

  return Object.freeze(next);
}

function encodeWorkspaceOverrides(overrides: readonly WallpaperWorkspaceOverride[]): string {
  const output: Array<{
    readonly workspaceId: string;
    readonly sourceRef: string;
    readonly fit: WallpaperFit;
  }> = [];

  for (let index = 0; index < overrides.length; index += 1) {
    const override = overrides[index];

    if (override !== undefined) {
      output.push(Object.freeze({
        fit: override.fit,
        sourceRef: override.sourceRef,
        workspaceId: override.workspaceId,
      }));
    }
  }

  return JSON.stringify(output);
}

function encodeOptionalSourceRef(ref: WallpaperSourceRef | null): string {
  return ref ?? "";
}

function freezeWorkspaceOverrides(
  overrides: readonly WallpaperWorkspaceOverride[],
): readonly WallpaperWorkspaceOverride[] {
  if (overrides.length === 0) return EMPTY_OVERRIDES;

  const output: WallpaperWorkspaceOverride[] = [];

  for (let index = 0; index < overrides.length; index += 1) {
    const override = overrides[index];

    if (override !== undefined) output.push(freezeWorkspaceOverride(override));
  }

  return Object.freeze(output);
}

function freezeWorkspaceOverride(input: WallpaperWorkspaceOverride): WallpaperWorkspaceOverride {
  return Object.freeze({
    fit: input.fit,
    sourceRef: input.sourceRef,
    workspaceId: input.workspaceId,
  });
}

function workspaceOverrideFor(
  overrides: readonly WallpaperWorkspaceOverride[],
  workspaceId: string,
): WallpaperWorkspaceOverride | null {
  for (let index = 0; index < overrides.length; index += 1) {
    const override = overrides[index];

    if (override !== undefined && override.workspaceId === workspaceId) return override;
  }

  return null;
}

function slideshowIndexForSource(
  sources: readonly WallpaperSourceRef[],
  sourceRef: WallpaperSourceRef | null,
): number {
  if (sourceRef === null) return -1;

  for (let index = 0; index < sources.length; index += 1) {
    if (sources[index] === sourceRef) return index;
  }

  return -1;
}

function slideshowSourceAt(
  sources: readonly WallpaperSourceRef[],
  intervalMs: number,
  nowMs: number,
): NormalizeResult<{
  readonly index: number;
  readonly sourceRef: WallpaperSourceRef;
}> {
  if (sources.length === 0) {
    return rejectNormalize(error("EMPTY_SLIDESHOW", "slideshow has no wallpaper sources.", "/slideshow/sources"));
  }

  const tick = Math.floor(Math.trunc(nowMs) / intervalMs);
  const index = positiveModulo(tick, sources.length);
  const sourceRef = sources[index];

  if (sourceRef === undefined) {
    return rejectNormalize(error("EMPTY_SLIDESHOW", "slideshow source is unavailable.", "/slideshow/sources"));
  }

  return acceptNormalize(Object.freeze({
    index,
    sourceRef,
  }));
}

function readClock(clock: WallpaperClock): NormalizeResult<number> {
  let nowMs: number;

  try {
    nowMs = clock.nowMs();
  } catch {
    return rejectNormalize(error("CLOCK_FAILED", "wallpaper clock failed closed.", "/clock"));
  }

  if (!Number.isFinite(nowMs) || nowMs < 0) {
    return rejectNormalize(error("CLOCK_FAILED", "wallpaper clock must return a non-negative finite timestamp.", "/clock"));
  }

  return acceptNormalize(nowMs);
}

function canWriteWallpaperSettings(manifest: DesktopUiPackageManifest): boolean {
  return (
    hasDesktopCapabilityGrant(manifest, "settings.write", WALLPAPER_SETTING_KEYS.fit) &&
    hasDesktopCapabilityGrant(manifest, "settings.write", WALLPAPER_SETTING_KEYS.sourceRef) &&
    hasDesktopCapabilityGrant(manifest, "settings.write", WALLPAPER_SETTING_KEYS.workspaceOverrides)
  );
}

async function emitControlPlaneIntent(
  port: SettingsControlPlanePort,
  intent: SettingsControlPlaneIntent,
): Promise<SettingsControlPlaneResult> {
  try {
    if (intent.type === "control-plane.preview") return await port.preview(intent);

    return await port.apply(intent);
  } catch {
    return {
      error: error("CONTROL_PLANE_FAILED", "settings control-plane failed closed.", "/controlPlane"),
      ok: false,
    };
  }
}

function acceptedStage(
  result: SettingsControlPlaneResult,
  stage: "preview" | "apply",
  path: string,
): NormalizeResult<true> {
  if (!result.ok) return rejectNormalize(appError(result.error));
  if (result.value.stage !== stage) {
    return rejectNormalize(error(
      "CONTROL_PLANE_STAGE_MISMATCH",
      "settings control-plane accepted the wrong stage.",
      path,
    ));
  }

  return acceptNormalize(true);
}

function freezeEdit(settingId: string, value: SettingsValue): SettingsEdit {
  return Object.freeze({
    categoryId: WALLPAPER_SETTINGS_CATEGORY_ID,
    settingId,
    value,
  });
}

function isWallpaperFit(value: string): value is WallpaperFit {
  for (let index = 0; index < WALLPAPER_FIT_MODES.length; index += 1) {
    if (WALLPAPER_FIT_MODES[index] === value) return true;
  }

  return false;
}

function isPlainDataObject(value: unknown): value is object {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;

  let prototype: object | null;

  try {
    prototype = Object.getPrototypeOf(value);
  } catch {
    return false;
  }

  return prototype === Object.prototype || prototype === null;
}

function hasOnlyStringKeys(value: object, expected: readonly string[]): boolean {
  let keys: readonly PropertyKey[];

  try {
    keys = Reflect.ownKeys(value);
  } catch {
    return false;
  }

  if (keys.length !== expected.length) return false;

  for (let keyIndex = 0; keyIndex < keys.length; keyIndex += 1) {
    const key = keys[keyIndex];

    if (typeof key !== "string" || !containsString(expected, key)) return false;

    let descriptor: PropertyDescriptor | undefined;

    try {
      descriptor = Object.getOwnPropertyDescriptor(value, key);
    } catch {
      return false;
    }

    if (descriptor === undefined || !("value" in descriptor)) return false;
  }

  return true;
}

function dataField(value: object, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);

  return descriptor !== undefined && "value" in descriptor ? descriptor.value : undefined;
}

function containsString(values: readonly string[], value: string): boolean {
  for (let index = 0; index < values.length; index += 1) {
    if (values[index] === value) return true;
  }

  return false;
}

function positiveModulo(value: number, modulus: number): number {
  return ((value % modulus) + modulus) % modulus;
}

function actionAccept(state: WallpaperViewModelState): WallpaperViewModelActionResult {
  return Object.freeze({
    ok: true,
    state,
  });
}

function actionReject(
  errorValue: WallpaperViewModelError,
  state: WallpaperViewModelState,
): WallpaperViewModelActionResult {
  return Object.freeze({
    error: errorValue,
    ok: false,
    state,
  });
}

function accept<T>(value: T): WallpaperViewModelResult<T> {
  return Object.freeze({
    ok: true,
    value,
  });
}

function rejectFromError<T>(errorValue: WallpaperViewModelError): WallpaperViewModelResult<T> {
  return Object.freeze({
    error: errorValue,
    ok: false,
  });
}

function acceptNormalize<T>(value: T): NormalizeResult<T> {
  return {
    ok: true,
    value,
  };
}

function rejectNormalize<T>(errorValue: WallpaperViewModelError): NormalizeResult<T> {
  return {
    error: errorValue,
    ok: false,
  };
}

function appError(errorValue: WallpaperViewModelError): WallpaperViewModelError {
  return error(errorValue.code, errorValue.message, errorValue.path);
}

function error(code: string, message: string, path: string): WallpaperViewModelError {
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
