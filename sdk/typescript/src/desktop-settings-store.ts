import { types as nodeTypes } from "node:util";

import {
  hasDesktopCapabilityGrant,
} from "./desktop-sdk/index.ts";
import type {
  DesktopCapability,
  DesktopHost,
  DesktopHostError,
  DesktopHostResult,
  DesktopMaybePromise,
  DesktopSettingsApply,
  DesktopSettingsPreview,
  DesktopUiPackageManifest,
} from "./desktop-sdk/index.ts";
import {
  A11Y_CONTRASTS,
  A11Y_NUMERIC_PREFS,
  A11Y_PREFS_SETTING_KEYS,
} from "../../../ui_kits/desktop/viewmodels/a11y-prefs.ts";
import {
  DEFAULT_INPUT_ACCESSIBILITY_SETTINGS,
  INPUT_ACCESSIBILITY_SETTING_KEY,
} from "../../../ui_kits/desktop/viewmodels/input-accessibility.ts";
import {
  DEFAULT_KEYMAP_PROFILES,
  KEYBOARD_SETTINGS_KEYS,
} from "../../../ui_kits/desktop/viewmodels/keyboard-settings.ts";
import {
  SETTINGS_ACCENT_OPTIONS,
  SETTINGS_APPEARANCE_KEYS,
  SETTINGS_LAYOUTS,
  SETTINGS_SECTIONS,
  SETTINGS_THEMES,
} from "../../../ui_kits/desktop/viewmodels/Settings.ts";
import {
  WALLPAPER_FIT_MODES,
  WALLPAPER_SETTING_KEYS,
} from "../../../ui_kits/desktop/viewmodels/wallpaper.ts";

type ReadSettingPort = NonNullable<DesktopHost["readSetting"]>;
type PreviewSettingPort = NonNullable<DesktopHost["previewSetting"]>;
type ApplySettingPort = NonNullable<DesktopHost["applySetting"]>;
type SettingsWriteValue = Parameters<ApplySettingPort>[0]["value"];

type StoreJson =
  | null
  | boolean
  | number
  | string
  | readonly StoreJson[]
  | StoreJsonObject;

interface StoreJsonObject {
  readonly [key: string]: StoreJson;
}

type DesktopSettingKey = typeof DESKTOP_SETTING_KEYS[number];
type SettingsDocument = ReadonlyMap<DesktopSettingKey, StoreJson>;

type StoreResult<T> =
  | {
      readonly ok: true;
      readonly value: T;
    }
  | {
      readonly ok: false;
      readonly error: DesktopHostError;
    };

type NormalizeResult<T> = StoreResult<T>;

export const DESKTOP_SETTINGS_STORE_PATH = "/var/lib/vita/desktop/settings.json";

export interface DesktopSettingsTempFile {
  readonly path: string;
}

export interface DesktopSettingsFileSystemPort {
  readFile(path: string): DesktopMaybePromise<string | undefined>;
  writeTempFile(request: {
    readonly targetPath: string;
    readonly contents: string;
  }): DesktopMaybePromise<DesktopSettingsTempFile>;
  syncFile(path: string): DesktopMaybePromise<void>;
  rename(fromPath: string, toPath: string): DesktopMaybePromise<void>;
  removeFile?(path: string): DesktopMaybePromise<void>;
}

export interface DesktopSettingsGrantPort {
  hasGrant(capability: DesktopCapability, resourceId?: string): boolean;
}

export interface DesktopSettingsStoreOptions {
  readonly fs: DesktopSettingsFileSystemPort;
  readonly grants: DesktopSettingsGrantPort;
  readonly path?: string;
}

export interface DesktopSettingsStore {
  readonly readSetting: ReadSettingPort;
  readonly previewSetting: PreviewSettingPort;
  readonly applySetting: ApplySettingPort;
}

const DESKTOP_SETTING_KEYS = Object.freeze([
  SETTINGS_APPEARANCE_KEYS.accent,
  SETTINGS_APPEARANCE_KEYS.activeSection,
  SETTINGS_APPEARANCE_KEYS.layout,
  SETTINGS_APPEARANCE_KEYS.theme,
  A11Y_PREFS_SETTING_KEYS.contrast,
  A11Y_PREFS_SETTING_KEYS.cursorSize,
  A11Y_PREFS_SETTING_KEYS.focusRingThickness,
  A11Y_PREFS_SETTING_KEYS.reduceMotion,
  A11Y_PREFS_SETTING_KEYS.reduceTransparency,
  A11Y_PREFS_SETTING_KEYS.textScale,
  A11Y_PREFS_SETTING_KEYS.uiZoom,
  INPUT_ACCESSIBILITY_SETTING_KEY,
  WALLPAPER_SETTING_KEYS.fit,
  WALLPAPER_SETTING_KEYS.slideshowIntervalMs,
  WALLPAPER_SETTING_KEYS.slideshowSources,
  WALLPAPER_SETTING_KEYS.solidColor,
  WALLPAPER_SETTING_KEYS.sourceRef,
  WALLPAPER_SETTING_KEYS.workspaceOverrides,
  KEYBOARD_SETTINGS_KEYS.overrides,
  KEYBOARD_SETTINGS_KEYS.profile,
] as const);

const SORTED_DESKTOP_SETTING_KEYS = Object.freeze([...DESKTOP_SETTING_KEYS].sort());
const SETTINGS_STORE_FORMAT_VERSION = 1;
const FNV_OFFSET_BASIS_64 = 0xcbf29ce484222325n;
const FNV_PRIME_64 = 0x100000001b3n;
const FNV_64_MASK = 0xffffffffffffffffn;
const MAX_JSON_DEPTH = 64;

export function createDesktopSettingsManifestGrantPort(
  manifest: DesktopUiPackageManifest,
): DesktopSettingsGrantPort {
  return Object.freeze({
    hasGrant(capability: DesktopCapability, resourceId?: string) {
      return hasDesktopCapabilityGrant(manifest, capability, resourceId);
    },
  });
}

export function createDesktopSettingsStore(options: DesktopSettingsStoreOptions): DesktopSettingsStore {
  return Object.freeze(new DesktopSettingsStoreBackend(options));
}

class DesktopSettingsStoreBackend implements DesktopSettingsStore {
  readonly #fs: DesktopSettingsFileSystemPort;
  readonly #grants: DesktopSettingsGrantPort;
  readonly #path: string;
  #document: SettingsDocument | null = null;

  constructor(options: DesktopSettingsStoreOptions) {
    this.#fs = options.fs;
    this.#grants = options.grants;
    this.#path = options.path ?? DESKTOP_SETTINGS_STORE_PATH;
  }

  readSetting: ReadSettingPort = async (request) => {
    const normalized = normalizeReadRequest(request);

    if (!normalized.ok) return hostReject(normalized.error);
    if (!isDesktopSettingKey(normalized.value.key)) {
      return hostReject(error("UNKNOWN_SETTING", "desktop setting key is not supported.", "/readSetting/key"));
    }
    if (!this.#hasGrant("settings.read", normalized.value.key)) {
      return hostReject(error("MISSING_CAPABILITY", "settings.read grant is required.", "/capabilityGrants/settings.read"));
    }

    const loaded = await this.#load();

    if (!loaded.ok) return hostReject(loaded.error);

    const value = loaded.value.get(normalized.value.key);

    if (value === undefined) {
      return hostReject(error("SETTING_NOT_FOUND", "desktop setting is not present.", "/settings/" + pathToken(normalized.value.key)));
    }

    return hostAccept(cloneJson(value) as SettingsWriteValue);
  };

  previewSetting: PreviewSettingPort = async (request) => {
    const prepared = await this.#prepareWrite(request, "/previewSetting");

    if (!prepared.ok) return hostReject(prepared.error);

    const next = copyDocument(prepared.value.document);
    next.set(prepared.value.key, prepared.value.value);

    return hostAccept(Object.freeze({
      diff: settingDiff(prepared.value.key, prepared.value.before, prepared.value.value),
      revision: revisionFor(next),
    }) satisfies DesktopSettingsPreview);
  };

  applySetting: ApplySettingPort = async (request) => {
    const prepared = await this.#prepareWrite(request, "/applySetting");

    if (!prepared.ok) return hostReject(prepared.error);

    const next = copyDocument(prepared.value.document);
    next.set(prepared.value.key, prepared.value.value);

    const revision = revisionFor(next);
    const contents = serializeDocument(next);
    const persisted = await this.#persist(contents);

    if (!persisted.ok) return hostReject(persisted.error);

    this.#document = freezeDocument(next);

    return hostAccept(Object.freeze({
      applied: settingApplied(prepared.value.key, prepared.value.value),
      revision,
    }) satisfies DesktopSettingsApply);
  };

  async #prepareWrite(
    request: Parameters<ApplySettingPort>[0],
    path: string,
  ): Promise<StoreResult<{
    readonly before: StoreJson;
    readonly document: SettingsDocument;
    readonly key: DesktopSettingKey;
    readonly value: StoreJson;
  }>> {
    const normalized = normalizeWriteRequest(request, path);

    if (!normalized.ok) return normalized;
    if (!isDesktopSettingKey(normalized.value.key)) {
      return reject(error("UNKNOWN_SETTING", "desktop setting key is not supported.", `${path}/key`));
    }
    if (!this.#hasGrant("settings.write", normalized.value.key)) {
      return reject(error("MISSING_CAPABILITY", "settings.write grant is required.", "/capabilityGrants/settings.write"));
    }

    const settingValue = normalizeSettingValue(normalized.value.key, normalized.value.value, `${path}/value`);

    if (!settingValue.ok) return settingValue;

    const loaded = await this.#load();

    if (!loaded.ok) return loaded;

    const before = loaded.value.get(normalized.value.key);

    if (before === undefined) {
      return reject(error("SETTING_NOT_FOUND", "desktop setting is not present.", "/settings/" + pathToken(normalized.value.key)));
    }

    return accept(Object.freeze({
      before,
      document: loaded.value,
      key: normalized.value.key,
      value: settingValue.value,
    }));
  }

  async #load(): Promise<StoreResult<SettingsDocument>> {
    if (this.#document !== null) return accept(this.#document);

    let contents: string | undefined;

    try {
      contents = await this.#fs.readFile(this.#path);
    } catch {
      return reject(error("SETTINGS_STORE_READ_FAILED", "settings store read failed closed.", "/settings"));
    }

    if (contents === undefined) {
      this.#document = defaultDocument();

      return accept(this.#document);
    }

    const parsed = parsePersistedDocument(contents);

    if (!parsed.ok) return parsed;

    this.#document = parsed.value;

    return accept(parsed.value);
  }

  async #persist(contents: string): Promise<StoreResult<true>> {
    let tempPath: string | null = null;

    try {
      const temp = await this.#fs.writeTempFile(Object.freeze({
        contents,
        targetPath: this.#path,
      }));

      tempPath = temp.path;
      await this.#fs.syncFile(temp.path);
      await this.#fs.rename(temp.path, this.#path);

      return accept(true);
    } catch {
      if (tempPath !== null && this.#fs.removeFile !== undefined) {
        try {
          await this.#fs.removeFile(tempPath);
        } catch {
          // Best-effort temp cleanup; the committed document is unchanged before rename.
        }
      }

      return reject(error("SETTINGS_STORE_WRITE_FAILED", "settings store write failed closed.", "/settings"));
    }
  }

  #hasGrant(capability: DesktopCapability, resourceId: string): boolean {
    try {
      return this.#grants.hasGrant(capability, resourceId);
    } catch {
      return false;
    }
  }
}

function normalizeReadRequest(input: unknown): NormalizeResult<{ readonly key: string }> {
  const object = snapshotObject(input, Object.freeze(["key"]), Object.freeze(["key"]), "/readSetting");

  if (!object.ok) return object;

  const key = object.value.get("key");

  if (typeof key !== "string" || key.length === 0) {
    return reject(error("INVALID_SETTINGS_REQUEST", "settings key must be a non-empty string.", "/readSetting/key"));
  }

  return accept(Object.freeze({ key }));
}

function normalizeWriteRequest(
  input: unknown,
  path: string,
): NormalizeResult<{ readonly key: string; readonly value: StoreJson }> {
  const object = snapshotObject(input, Object.freeze(["key", "value"]), Object.freeze(["key", "value"]), path);

  if (!object.ok) return object;

  const key = object.value.get("key");

  if (typeof key !== "string" || key.length === 0) {
    return reject(error("INVALID_SETTINGS_REQUEST", "settings key must be a non-empty string.", `${path}/key`));
  }

  const value = object.value.get("value");

  if (value === undefined) {
    return reject(error("INVALID_SETTINGS_REQUEST", "settings value is required.", `${path}/value`));
  }

  const normalizedValue = snapshotJson(value, `${path}/value`);

  if (!normalizedValue.ok) return normalizedValue;

  return accept(Object.freeze({
    key,
    value: normalizedValue.value,
  }));
}

function snapshotObject(
  input: unknown,
  allowedKeys: readonly string[],
  requiredKeys: readonly string[],
  path: string,
): NormalizeResult<ReadonlyMap<string, unknown>> {
  try {
    if (input === null || typeof input !== "object" || nodeTypes.isProxy(input) || Array.isArray(input)) {
      return reject(error("INVALID_SETTINGS_REQUEST", "request must be a plain object.", path));
    }

    const prototype = Object.getPrototypeOf(input);

    if (prototype !== Object.prototype && prototype !== null) {
      return reject(error("INVALID_SETTINGS_REQUEST", "request must be a plain object.", path));
    }

    const keys = Reflect.ownKeys(input);
    const output = new Map<string, unknown>();

    for (let index = 0; index < keys.length; index += 1) {
      const key = keys[index];

      if (key === undefined || typeof key === "symbol" || !containsString(allowedKeys, key)) {
        return reject(error("INVALID_SETTINGS_REQUEST", "request contains an unsupported field.", path));
      }

      const descriptor = Object.getOwnPropertyDescriptor(input, key);

      if (descriptor === undefined || !isDataDescriptor(descriptor) || descriptor.enumerable !== true) {
        return reject(error("INVALID_SETTINGS_REQUEST", "request fields must be enumerable data fields.", `${path}/${pathToken(key)}`));
      }

      output.set(key, descriptor.value);
    }

    for (let index = 0; index < requiredKeys.length; index += 1) {
      const key = requiredKeys[index];

      if (key !== undefined && !output.has(key)) {
        return reject(error("INVALID_SETTINGS_REQUEST", "request is missing a required field.", `${path}/${pathToken(key)}`));
      }
    }

    return accept(output);
  } catch {
    return reject(error("INVALID_SETTINGS_REQUEST", "request must be stable plain data.", path));
  }
}

function snapshotJson(input: unknown, path: string): NormalizeResult<StoreJson> {
  return snapshotJsonValue(input, path, 0, new WeakSet<object>());
}

function snapshotJsonValue(
  input: unknown,
  path: string,
  depth: number,
  seen: WeakSet<object>,
): NormalizeResult<StoreJson> {
  if (depth > MAX_JSON_DEPTH) {
    return reject(error("INVALID_SETTINGS_VALUE", "settings value exceeds the JSON depth limit.", path));
  }

  if (input === null || typeof input === "string" || typeof input === "boolean") {
    return accept(input);
  }
  if (typeof input === "number") {
    return Number.isFinite(input)
      ? accept(input)
      : reject(error("INVALID_SETTINGS_VALUE", "settings number must be finite.", path));
  }
  if (typeof input !== "object") {
    return reject(error("INVALID_SETTINGS_VALUE", "settings value must be JSON.", path));
  }
  if (nodeTypes.isProxy(input)) {
    return reject(error("INVALID_SETTINGS_VALUE", "settings value must not be a Proxy.", path));
  }

  try {
    if (seen.has(input)) {
      return reject(error("INVALID_SETTINGS_VALUE", "settings value must not be cyclic.", path));
    }

    seen.add(input);

    if (Array.isArray(input)) {
      return snapshotJsonArray(input, path, depth, seen);
    }

    const prototype = Object.getPrototypeOf(input);

    if (prototype !== Object.prototype && prototype !== null) {
      return reject(error("INVALID_SETTINGS_VALUE", "settings object must be plain JSON.", path));
    }

    const keys = Reflect.ownKeys(input);
    const output = nullPrototypeObject();

    for (let index = 0; index < keys.length; index += 1) {
      const key = keys[index];

      if (key === undefined || typeof key === "symbol") {
        return reject(error("INVALID_SETTINGS_VALUE", "settings object keys must be strings.", path));
      }

      const descriptor = Object.getOwnPropertyDescriptor(input, key);

      if (descriptor === undefined || !isDataDescriptor(descriptor) || descriptor.enumerable !== true) {
        return reject(error("INVALID_SETTINGS_VALUE", "settings object fields must be enumerable data fields.", `${path}/${pathToken(key)}`));
      }

      const value = snapshotJsonValue(descriptor.value, `${path}/${pathToken(key)}`, depth + 1, seen);

      if (!value.ok) return value;
      defineJsonField(output, key, value.value);
    }

    return accept(Object.freeze(output));
  } catch {
    return reject(error("INVALID_SETTINGS_VALUE", "settings value must be stable JSON.", path));
  } finally {
    seen.delete(input);
  }
}

function snapshotJsonArray(
  input: readonly unknown[],
  path: string,
  depth: number,
  seen: WeakSet<object>,
): NormalizeResult<readonly StoreJson[]> {
  try {
    if (nodeTypes.isProxy(input)) {
      return reject(error("INVALID_SETTINGS_VALUE", "settings array must not be a Proxy.", path));
    }

    if (Object.getPrototypeOf(input) !== Array.prototype) {
      return reject(error("INVALID_SETTINGS_VALUE", "settings array must be plain JSON.", path));
    }

    const keys = Reflect.ownKeys(input);

    for (let index = 0; index < keys.length; index += 1) {
      const key = keys[index];

      if (key === "length") continue;
      if (key === undefined || typeof key === "symbol" || !isArrayIndexKey(key, input.length)) {
        return reject(error("INVALID_SETTINGS_VALUE", "settings array must be dense JSON.", path));
      }

      const descriptor = Object.getOwnPropertyDescriptor(input, key);

      if (descriptor === undefined || !isDataDescriptor(descriptor) || descriptor.enumerable !== true) {
        return reject(error("INVALID_SETTINGS_VALUE", "settings array entries must be enumerable data fields.", `${path}/${key}`));
      }
    }

    const output: StoreJson[] = [];

    for (let index = 0; index < input.length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(input, String(index));

      if (descriptor === undefined || !isDataDescriptor(descriptor) || descriptor.enumerable !== true) {
        return reject(error("INVALID_SETTINGS_VALUE", "settings array must be dense JSON.", `${path}/${index}`));
      }

      const value = snapshotJsonValue(descriptor.value, `${path}/${index}`, depth + 1, seen);

      if (!value.ok) return value;
      output.push(value.value);
    }

    return accept(Object.freeze(output));
  } catch {
    return reject(error("INVALID_SETTINGS_VALUE", "settings array must be stable JSON.", path));
  }
}

function parsePersistedDocument(contents: string): StoreResult<SettingsDocument> {
  let parsed: unknown;

  try {
    parsed = JSON.parse(contents);
  } catch {
    return reject(error("SETTINGS_STORE_MALFORMED", "settings store JSON is malformed.", "/settings"));
  }

  const normalized = snapshotJson(parsed, "/settings");

  if (!normalized.ok) {
    return reject(error("SETTINGS_STORE_MALFORMED", normalized.error.message, normalized.error.path));
  }

  const document = documentFromJson(normalized.value);

  if (!document.ok) return document;

  return accept(document.value);
}

function documentFromJson(value: StoreJson): StoreResult<SettingsDocument> {
  const object = jsonObject(value);

  if (object === undefined) {
    return reject(error("SETTINGS_STORE_MALFORMED", "settings store must be a document object.", "/settings"));
  }

  const keys = Object.keys(object);

  if (keys.length !== DESKTOP_SETTING_KEYS.length) {
    return reject(error("SETTINGS_STORE_MALFORMED", "settings store document is incomplete.", "/settings"));
  }

  const output = new Map<DesktopSettingKey, StoreJson>();

  for (let index = 0; index < keys.length; index += 1) {
    const key = keys[index];

    if (key === undefined || !isDesktopSettingKey(key)) {
      return reject(error("SETTINGS_STORE_MALFORMED", "settings store contains an unsupported key.", "/settings"));
    }

    const rawValue = object[key];

    if (rawValue === undefined) {
      return reject(error("SETTINGS_STORE_MALFORMED", "settings store key is missing a value.", "/settings/" + pathToken(key)));
    }

    const normalized = normalizeSettingValue(key, rawValue, "/settings/" + pathToken(key));

    if (!normalized.ok) return normalized;
    output.set(key, normalized.value);
  }

  for (let index = 0; index < DESKTOP_SETTING_KEYS.length; index += 1) {
    const key = DESKTOP_SETTING_KEYS[index];

    if (key !== undefined && !output.has(key)) {
      return reject(error("SETTINGS_STORE_MALFORMED", "settings store document is incomplete.", "/settings/" + pathToken(key)));
    }
  }

  return accept(freezeDocument(output));
}

function normalizeSettingValue(
  key: DesktopSettingKey,
  value: StoreJson,
  path: string,
): NormalizeResult<StoreJson> {
  switch (key) {
    case SETTINGS_APPEARANCE_KEYS.theme:
      return normalizeStringEnum(value, SETTINGS_THEMES, "INVALID_SETTINGS_VALUE", "appearance theme is not supported.", path);
    case SETTINGS_APPEARANCE_KEYS.accent:
      return normalizeStringEnum(value, accentIds(), "INVALID_SETTINGS_VALUE", "appearance accent is not supported.", path);
    case SETTINGS_APPEARANCE_KEYS.layout:
      return normalizeStringEnum(value, SETTINGS_LAYOUTS, "INVALID_SETTINGS_VALUE", "appearance layout is not supported.", path);
    case SETTINGS_APPEARANCE_KEYS.activeSection:
      return normalizeStringEnum(value, sectionIds(), "INVALID_SETTINGS_VALUE", "settings section is not supported.", path);
    case A11Y_PREFS_SETTING_KEYS.contrast:
      return normalizeStringEnum(value, A11Y_CONTRASTS, "INVALID_SETTINGS_VALUE", "accessibility contrast is not supported.", path);
    case A11Y_PREFS_SETTING_KEYS.reduceMotion:
    case A11Y_PREFS_SETTING_KEYS.reduceTransparency:
      return normalizeBoolean(value, path);
    case A11Y_PREFS_SETTING_KEYS.cursorSize:
      return normalizeNumberRange(value, A11Y_NUMERIC_PREFS.cursorSize.min, A11Y_NUMERIC_PREFS.cursorSize.max, path);
    case A11Y_PREFS_SETTING_KEYS.focusRingThickness:
      return normalizeNumberRange(value, A11Y_NUMERIC_PREFS.focusRingThickness.min, A11Y_NUMERIC_PREFS.focusRingThickness.max, path);
    case A11Y_PREFS_SETTING_KEYS.textScale:
      return normalizeNumberRange(value, A11Y_NUMERIC_PREFS.textScale.min, A11Y_NUMERIC_PREFS.textScale.max, path);
    case A11Y_PREFS_SETTING_KEYS.uiZoom:
      return normalizeNumberRange(value, A11Y_NUMERIC_PREFS.uiZoom.min, A11Y_NUMERIC_PREFS.uiZoom.max, path);
    case INPUT_ACCESSIBILITY_SETTING_KEY:
      return normalizeInputAccessibilityPolicy(value, path);
    case WALLPAPER_SETTING_KEYS.fit:
      return normalizeStringEnum(value, WALLPAPER_FIT_MODES, "INVALID_SETTINGS_VALUE", "wallpaper fit mode is not supported.", path);
    case WALLPAPER_SETTING_KEYS.sourceRef:
      return normalizeString(value, path, false);
    case WALLPAPER_SETTING_KEYS.solidColor:
      return normalizeString(value, path, true);
    case WALLPAPER_SETTING_KEYS.slideshowIntervalMs:
      return normalizePositiveSafeInteger(value, path);
    case WALLPAPER_SETTING_KEYS.slideshowSources:
      return normalizeEncodedStringArray(value, path);
    case WALLPAPER_SETTING_KEYS.workspaceOverrides:
      return normalizeEncodedWorkspaceOverrides(value, path);
    case KEYBOARD_SETTINGS_KEYS.overrides:
      return normalizeKeyboardOverrides(value, path);
    case KEYBOARD_SETTINGS_KEYS.profile:
      return normalizeStringEnum(value, keymapProfileIds(), "INVALID_SETTINGS_VALUE", "keyboard profile is not supported.", path);
    default:
      return reject(error("UNKNOWN_SETTING", "desktop setting key is not supported.", path));
  }
}

function normalizeInputAccessibilityPolicy(value: StoreJson, path: string): NormalizeResult<StoreJsonObject> {
  const object = jsonObject(value);

  if (object === undefined || !hasOnlyJsonKeys(object, Object.freeze(["bounceKeys", "keyRepeat", "slowKeys", "stickyKeys"]))) {
    return reject(error("INVALID_SETTINGS_VALUE", "input accessibility policy must contain the supported fields.", path));
  }

  const keyRepeat = normalizeKeyRepeatPolicy(object["keyRepeat"], `${path}/keyRepeat`);
  const stickyKeys = normalizeStickyKeysPolicy(object["stickyKeys"], `${path}/stickyKeys`);
  const slowKeys = normalizeSlowKeysPolicy(object["slowKeys"], `${path}/slowKeys`);
  const bounceKeys = normalizeBounceKeysPolicy(object["bounceKeys"], `${path}/bounceKeys`);

  if (!keyRepeat.ok) return keyRepeat;
  if (!stickyKeys.ok) return stickyKeys;
  if (!slowKeys.ok) return slowKeys;
  if (!bounceKeys.ok) return bounceKeys;

  return accept(freezeJsonObject(Object.freeze([
    Object.freeze(["bounceKeys", bounceKeys.value] as const),
    Object.freeze(["keyRepeat", keyRepeat.value] as const),
    Object.freeze(["slowKeys", slowKeys.value] as const),
    Object.freeze(["stickyKeys", stickyKeys.value] as const),
  ])));
}

function normalizeKeyRepeatPolicy(value: StoreJson | undefined, path: string): NormalizeResult<StoreJsonObject> {
  const object = jsonObject(value);

  if (object === undefined || !hasOnlyJsonKeys(object, Object.freeze(["enabled", "repeatDelayMs", "repeatRateMs"]))) {
    return reject(error("INVALID_SETTINGS_VALUE", "key repeat settings are malformed.", path));
  }

  const enabled = normalizeBoolean(object["enabled"], `${path}/enabled`);
  const repeatDelayMs = normalizeNonNegativeSafeInteger(object["repeatDelayMs"], `${path}/repeatDelayMs`);
  const repeatRateMs = normalizeSafeIntegerAtLeast(object["repeatRateMs"], 1, `${path}/repeatRateMs`);

  if (!enabled.ok) return enabled;
  if (!repeatDelayMs.ok) return repeatDelayMs;
  if (!repeatRateMs.ok) return repeatRateMs;

  return accept(freezeJsonObject(Object.freeze([
    Object.freeze(["enabled", enabled.value] as const),
    Object.freeze(["repeatDelayMs", repeatDelayMs.value] as const),
    Object.freeze(["repeatRateMs", repeatRateMs.value] as const),
  ])));
}

function normalizeStickyKeysPolicy(value: StoreJson | undefined, path: string): NormalizeResult<StoreJsonObject> {
  const object = jsonObject(value);

  if (object === undefined || !hasOnlyJsonKeys(object, Object.freeze(["enabled", "lockOnDoublePress"]))) {
    return reject(error("INVALID_SETTINGS_VALUE", "sticky keys settings are malformed.", path));
  }

  const enabled = normalizeBoolean(object["enabled"], `${path}/enabled`);
  const lockOnDoublePress = normalizeBoolean(object["lockOnDoublePress"], `${path}/lockOnDoublePress`);

  if (!enabled.ok) return enabled;
  if (!lockOnDoublePress.ok) return lockOnDoublePress;

  return accept(freezeJsonObject(Object.freeze([
    Object.freeze(["enabled", enabled.value] as const),
    Object.freeze(["lockOnDoublePress", lockOnDoublePress.value] as const),
  ])));
}

function normalizeSlowKeysPolicy(value: StoreJson | undefined, path: string): NormalizeResult<StoreJsonObject> {
  const object = jsonObject(value);

  if (object === undefined || !hasOnlyJsonKeys(object, Object.freeze(["enabled", "holdThresholdMs"]))) {
    return reject(error("INVALID_SETTINGS_VALUE", "slow keys settings are malformed.", path));
  }

  const enabled = normalizeBoolean(object["enabled"], `${path}/enabled`);
  const holdThresholdMs = normalizeNonNegativeSafeInteger(object["holdThresholdMs"], `${path}/holdThresholdMs`);

  if (!enabled.ok) return enabled;
  if (!holdThresholdMs.ok) return holdThresholdMs;

  return accept(freezeJsonObject(Object.freeze([
    Object.freeze(["enabled", enabled.value] as const),
    Object.freeze(["holdThresholdMs", holdThresholdMs.value] as const),
  ])));
}

function normalizeBounceKeysPolicy(value: StoreJson | undefined, path: string): NormalizeResult<StoreJsonObject> {
  const object = jsonObject(value);

  if (object === undefined || !hasOnlyJsonKeys(object, Object.freeze(["debounceWindowMs", "enabled"]))) {
    return reject(error("INVALID_SETTINGS_VALUE", "bounce keys settings are malformed.", path));
  }

  const debounceWindowMs = normalizeNonNegativeSafeInteger(object["debounceWindowMs"], `${path}/debounceWindowMs`);
  const enabled = normalizeBoolean(object["enabled"], `${path}/enabled`);

  if (!debounceWindowMs.ok) return debounceWindowMs;
  if (!enabled.ok) return enabled;

  return accept(freezeJsonObject(Object.freeze([
    Object.freeze(["debounceWindowMs", debounceWindowMs.value] as const),
    Object.freeze(["enabled", enabled.value] as const),
  ])));
}

function normalizeEncodedStringArray(value: StoreJson, path: string): NormalizeResult<string> {
  if (typeof value !== "string") {
    return reject(error("INVALID_SETTINGS_VALUE", "setting must be an encoded JSON string.", path));
  }

  const parsed = parseEncodedArray(value, path);

  if (!parsed.ok) return parsed;

  for (let index = 0; index < parsed.value.length; index += 1) {
    const item = parsed.value[index];

    if (typeof item !== "string" || item.length === 0) {
      return reject(error("INVALID_SETTINGS_VALUE", "encoded string array entries must be non-empty strings.", `${path}/${index}`));
    }
  }

  return accept(value);
}

function normalizeEncodedWorkspaceOverrides(value: StoreJson, path: string): NormalizeResult<string> {
  if (typeof value !== "string") {
    return reject(error("INVALID_SETTINGS_VALUE", "workspace overrides must be an encoded JSON string.", path));
  }

  const parsed = parseEncodedArray(value, path);

  if (!parsed.ok) return parsed;

  for (let index = 0; index < parsed.value.length; index += 1) {
    const item = jsonObject(parsed.value[index]);

    if (item === undefined || !hasOnlyJsonKeys(item, Object.freeze(["fit", "sourceRef", "workspaceId"]))) {
      return reject(error("INVALID_SETTINGS_VALUE", "workspace override entry is malformed.", `${path}/${index}`));
    }

    const workspaceId = normalizeString(item["workspaceId"] ?? null, `${path}/${index}/workspaceId`, true);
    const sourceRef = normalizeString(item["sourceRef"] ?? null, `${path}/${index}/sourceRef`, true);
    const fit = normalizeStringEnum(item["fit"] ?? null, WALLPAPER_FIT_MODES, "INVALID_SETTINGS_VALUE", "wallpaper fit mode is not supported.", `${path}/${index}/fit`);

    if (!workspaceId.ok) return workspaceId;
    if (!sourceRef.ok) return sourceRef;
    if (!fit.ok) return fit;
  }

  return accept(value);
}

function normalizeKeyboardOverrides(value: StoreJson, path: string): NormalizeResult<string> {
  if (typeof value !== "string") {
    return reject(error("INVALID_SETTINGS_VALUE", "keyboard overrides must be an encoded JSON string.", path));
  }

  const parsed = parseEncodedArray(value, path);

  if (!parsed.ok) return parsed;

  for (let index = 0; index < parsed.value.length; index += 1) {
    const item = jsonObject(parsed.value[index]);

    if (item === undefined || !hasOnlyJsonKeys(item, Object.freeze(["chord", "commandId"]))) {
      return reject(error("INVALID_SETTINGS_VALUE", "keyboard override entry is malformed.", `${path}/${index}`));
    }

    const chord = normalizeString(item["chord"] ?? null, `${path}/${index}/chord`, true);
    const commandId = normalizeString(item["commandId"] ?? null, `${path}/${index}/commandId`, true);

    if (!chord.ok) return chord;
    if (!commandId.ok) return commandId;
  }

  return accept(value);
}

function parseEncodedArray(value: string, path: string): NormalizeResult<readonly StoreJson[]> {
  if (value.trim().length === 0) return accept(Object.freeze([]));

  let parsed: unknown;

  try {
    parsed = JSON.parse(value);
  } catch {
    return reject(error("INVALID_SETTINGS_VALUE", "setting must contain deterministic JSON.", path));
  }

  const normalized = snapshotJson(parsed, path);

  if (!normalized.ok) return normalized;
  if (!Array.isArray(normalized.value)) {
    return reject(error("INVALID_SETTINGS_VALUE", "encoded setting JSON must be an array.", path));
  }

  return accept(normalized.value);
}

function normalizeStringEnum<T extends string>(
  value: StoreJson | undefined,
  options: readonly T[],
  code: string,
  message: string,
  path: string,
): NormalizeResult<T> {
  if (typeof value !== "string" || !containsString(options, value)) {
    return reject(error(code, message, path));
  }

  return accept(value);
}

function normalizeString(value: StoreJson | undefined, path: string, nonEmpty: boolean): NormalizeResult<string> {
  if (typeof value !== "string" || (nonEmpty && value.length === 0)) {
    return reject(error("INVALID_SETTINGS_VALUE", "setting must be a supported string.", path));
  }

  return accept(value);
}

function normalizeBoolean(value: StoreJson | undefined, path: string): NormalizeResult<boolean> {
  if (typeof value !== "boolean") {
    return reject(error("INVALID_SETTINGS_VALUE", "setting must be boolean.", path));
  }

  return accept(value);
}

function normalizeNumberRange(value: StoreJson | undefined, min: number, max: number, path: string): NormalizeResult<number> {
  if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max) {
    return reject(error("INVALID_SETTINGS_VALUE", "setting number is outside the supported range.", path));
  }

  return accept(value);
}

function normalizePositiveSafeInteger(value: StoreJson | undefined, path: string): NormalizeResult<number> {
  return normalizeSafeIntegerAtLeast(value, 1, path);
}

function normalizeNonNegativeSafeInteger(value: StoreJson | undefined, path: string): NormalizeResult<number> {
  return normalizeSafeIntegerAtLeast(value, 0, path);
}

function normalizeSafeIntegerAtLeast(value: StoreJson | undefined, min: number, path: string): NormalizeResult<number> {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min) {
    return reject(error("INVALID_SETTINGS_VALUE", "setting must be a supported millisecond integer.", path));
  }

  return accept(value);
}

function defaultDocument(): SettingsDocument {
  const output = new Map<DesktopSettingKey, StoreJson>();

  output.set(SETTINGS_APPEARANCE_KEYS.accent, "blue");
  output.set(SETTINGS_APPEARANCE_KEYS.activeSection, "appearance");
  output.set(SETTINGS_APPEARANCE_KEYS.layout, "comfortable");
  output.set(SETTINGS_APPEARANCE_KEYS.theme, "light");
  output.set(A11Y_PREFS_SETTING_KEYS.contrast, "normal");
  output.set(A11Y_PREFS_SETTING_KEYS.cursorSize, 1);
  output.set(A11Y_PREFS_SETTING_KEYS.focusRingThickness, 2);
  output.set(A11Y_PREFS_SETTING_KEYS.reduceMotion, false);
  output.set(A11Y_PREFS_SETTING_KEYS.reduceTransparency, false);
  output.set(A11Y_PREFS_SETTING_KEYS.textScale, 1);
  output.set(A11Y_PREFS_SETTING_KEYS.uiZoom, 1);
  output.set(INPUT_ACCESSIBILITY_SETTING_KEY, defaultInputAccessibilityPolicy());
  output.set(WALLPAPER_SETTING_KEYS.fit, "fill");
  output.set(WALLPAPER_SETTING_KEYS.slideshowIntervalMs, 60_000);
  output.set(WALLPAPER_SETTING_KEYS.slideshowSources, "[]");
  output.set(WALLPAPER_SETTING_KEYS.solidColor, "#0f172a");
  output.set(WALLPAPER_SETTING_KEYS.sourceRef, "wallpaper:default");
  output.set(WALLPAPER_SETTING_KEYS.workspaceOverrides, "[]");
  output.set(KEYBOARD_SETTINGS_KEYS.overrides, "[]");
  output.set(KEYBOARD_SETTINGS_KEYS.profile, DEFAULT_KEYMAP_PROFILES[0]?.id ?? "default");

  return freezeDocument(output);
}

function defaultInputAccessibilityPolicy(): StoreJsonObject {
  return freezeJsonObject(Object.freeze([
    Object.freeze(["bounceKeys", freezeJsonObject(Object.freeze([
      Object.freeze(["debounceWindowMs", DEFAULT_INPUT_ACCESSIBILITY_SETTINGS.bounceKeys.debounceWindowMs] as const),
      Object.freeze(["enabled", DEFAULT_INPUT_ACCESSIBILITY_SETTINGS.bounceKeys.enabled] as const),
    ]))] as const),
    Object.freeze(["keyRepeat", freezeJsonObject(Object.freeze([
      Object.freeze(["enabled", DEFAULT_INPUT_ACCESSIBILITY_SETTINGS.keyRepeat.enabled] as const),
      Object.freeze(["repeatDelayMs", DEFAULT_INPUT_ACCESSIBILITY_SETTINGS.keyRepeat.repeatDelayMs] as const),
      Object.freeze(["repeatRateMs", DEFAULT_INPUT_ACCESSIBILITY_SETTINGS.keyRepeat.repeatRateMs] as const),
    ]))] as const),
    Object.freeze(["slowKeys", freezeJsonObject(Object.freeze([
      Object.freeze(["enabled", DEFAULT_INPUT_ACCESSIBILITY_SETTINGS.slowKeys.enabled] as const),
      Object.freeze(["holdThresholdMs", DEFAULT_INPUT_ACCESSIBILITY_SETTINGS.slowKeys.holdThresholdMs] as const),
    ]))] as const),
    Object.freeze(["stickyKeys", freezeJsonObject(Object.freeze([
      Object.freeze(["enabled", DEFAULT_INPUT_ACCESSIBILITY_SETTINGS.stickyKeys.enabled] as const),
      Object.freeze(["lockOnDoublePress", DEFAULT_INPUT_ACCESSIBILITY_SETTINGS.stickyKeys.lockOnDoublePress] as const),
    ]))] as const),
  ]));
}

function copyDocument(document: SettingsDocument): Map<DesktopSettingKey, StoreJson> {
  const output = new Map<DesktopSettingKey, StoreJson>();

  for (let index = 0; index < DESKTOP_SETTING_KEYS.length; index += 1) {
    const key = DESKTOP_SETTING_KEYS[index];

    if (key === undefined) continue;
    const value = document.get(key);

    if (value !== undefined) output.set(key, cloneJson(value));
  }

  return output;
}

function freezeDocument(document: ReadonlyMap<DesktopSettingKey, StoreJson>): SettingsDocument {
  const output = new Map<DesktopSettingKey, StoreJson>();

  for (let index = 0; index < DESKTOP_SETTING_KEYS.length; index += 1) {
    const key = DESKTOP_SETTING_KEYS[index];

    if (key === undefined) continue;
    const value = document.get(key);

    if (value !== undefined) output.set(key, cloneJson(value));
  }

  return output;
}

function serializeDocument(document: SettingsDocument): string {
  return canonicalJson(documentToJson(document));
}

function documentToJson(document: SettingsDocument): StoreJsonObject {
  const output = nullPrototypeObject();

  for (let index = 0; index < SORTED_DESKTOP_SETTING_KEYS.length; index += 1) {
    const key = SORTED_DESKTOP_SETTING_KEYS[index];

    if (key === undefined) continue;
    const value = document.get(key);

    if (value !== undefined) defineJsonField(output, key, value);
  }

  return Object.freeze(output);
}

function revisionFor(document: SettingsDocument): string {
  return "settings:v" + String(SETTINGS_STORE_FORMAT_VERSION) + ":" + fnv1a64(serializeDocument(document));
}

function canonicalJson(value: StoreJson): string {
  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    const parts: string[] = [];

    for (let index = 0; index < value.length; index += 1) {
      const item = value[index];

      if (item !== undefined) parts.push(canonicalJson(item));
    }

    return "[" + parts.join(",") + "]";
  }

  const object = jsonObject(value);

  if (object === undefined) return "null";

  const keys = Object.keys(object).sort();
  const parts: string[] = [];

  for (let index = 0; index < keys.length; index += 1) {
    const key = keys[index];

    if (key === undefined) continue;
    const item = object[key];

    if (item !== undefined) parts.push(JSON.stringify(key) + ":" + canonicalJson(item));
  }

  return "{" + parts.join(",") + "}";
}

function fnv1a64(input: string): string {
  let hash = FNV_OFFSET_BASIS_64;

  for (let index = 0; index < input.length;) {
    const point = input.codePointAt(index);

    if (point === undefined) break;
    index += point > 0xffff ? 2 : 1;

    if (point <= 0x7f) {
      hash = fnvByte(hash, point);
    } else if (point <= 0x7ff) {
      hash = fnvByte(hash, 0xc0 | (point >> 6));
      hash = fnvByte(hash, 0x80 | (point & 0x3f));
    } else if (point <= 0xffff) {
      hash = fnvByte(hash, 0xe0 | (point >> 12));
      hash = fnvByte(hash, 0x80 | ((point >> 6) & 0x3f));
      hash = fnvByte(hash, 0x80 | (point & 0x3f));
    } else {
      hash = fnvByte(hash, 0xf0 | (point >> 18));
      hash = fnvByte(hash, 0x80 | ((point >> 12) & 0x3f));
      hash = fnvByte(hash, 0x80 | ((point >> 6) & 0x3f));
      hash = fnvByte(hash, 0x80 | (point & 0x3f));
    }
  }

  return hash.toString(16).padStart(16, "0");
}

function fnvByte(hash: bigint, byte: number): bigint {
  return ((hash ^ BigInt(byte)) * FNV_PRIME_64) & FNV_64_MASK;
}

function settingDiff(key: DesktopSettingKey, before: StoreJson, after: StoreJson): StoreJsonObject {
  return freezeJsonObject(Object.freeze([
    Object.freeze(["after", cloneJson(after)] as const),
    Object.freeze(["before", cloneJson(before)] as const),
    Object.freeze(["key", key] as const),
  ]));
}

function settingApplied(key: DesktopSettingKey, value: StoreJson): StoreJsonObject {
  return freezeJsonObject(Object.freeze([
    Object.freeze(["key", key] as const),
    Object.freeze(["value", cloneJson(value)] as const),
  ]));
}

function cloneJson(value: StoreJson): StoreJson {
  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  if (Array.isArray(value)) {
    const output: StoreJson[] = [];

    for (let index = 0; index < value.length; index += 1) {
      const item = value[index];

      if (item !== undefined) output.push(cloneJson(item));
    }

    return Object.freeze(output);
  }

  const object = jsonObject(value);

  if (object === undefined) return null;

  const output = nullPrototypeObject();
  const keys = Object.keys(object);

  for (let index = 0; index < keys.length; index += 1) {
    const key = keys[index];

    if (key === undefined) continue;
    const item = object[key];

    if (item !== undefined) defineJsonField(output, key, cloneJson(item));
  }

  return Object.freeze(output);
}

function freezeJsonObject(entries: readonly (readonly [string, StoreJson])[]): StoreJsonObject {
  const output = nullPrototypeObject();

  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];

    if (entry !== undefined) defineJsonField(output, entry[0], entry[1]);
  }

  return Object.freeze(output);
}

function nullPrototypeObject(): { [key: string]: StoreJson } {
  return Object.create(null) as { [key: string]: StoreJson };
}

function defineJsonField(target: { [key: string]: StoreJson }, key: string, value: StoreJson): void {
  Object.defineProperty(target, key, {
    configurable: false,
    enumerable: true,
    value,
    writable: false,
  });
}

function jsonObject(value: StoreJson | undefined): StoreJsonObject | undefined {
  if (value === undefined || value === null || typeof value !== "object" || Array.isArray(value)) return undefined;

  return value as StoreJsonObject;
}

function hasOnlyJsonKeys(value: StoreJsonObject, expected: readonly string[]): boolean {
  const keys = Object.keys(value);

  if (keys.length !== expected.length) return false;

  for (let index = 0; index < keys.length; index += 1) {
    const key = keys[index];

    if (key === undefined || !containsString(expected, key)) return false;
  }

  return true;
}

function isDesktopSettingKey(value: string): value is DesktopSettingKey {
  return containsString(DESKTOP_SETTING_KEYS, value);
}

function accentIds(): readonly string[] {
  const output: string[] = [];

  for (let index = 0; index < SETTINGS_ACCENT_OPTIONS.length; index += 1) {
    const option = SETTINGS_ACCENT_OPTIONS[index];

    if (option !== undefined) output.push(option.id);
  }

  return Object.freeze(output);
}

function sectionIds(): readonly string[] {
  const output: string[] = [];

  for (let index = 0; index < SETTINGS_SECTIONS.length; index += 1) {
    const section = SETTINGS_SECTIONS[index];

    if (section !== undefined) output.push(section.id);
  }

  return Object.freeze(output);
}

function keymapProfileIds(): readonly string[] {
  const output: string[] = [];

  for (let index = 0; index < DEFAULT_KEYMAP_PROFILES.length; index += 1) {
    const profile = DEFAULT_KEYMAP_PROFILES[index];

    if (profile !== undefined) output.push(profile.id);
  }

  return Object.freeze(output);
}

function containsString<T extends string>(values: readonly T[], value: string): value is T {
  for (let index = 0; index < values.length; index += 1) {
    if (values[index] === value) return true;
  }

  return false;
}

function isArrayIndexKey(key: string, length: number): boolean {
  const index = Number(key);

  return Number.isSafeInteger(index) && index >= 0 && index < length && String(index) === key;
}

function isDataDescriptor(descriptor: PropertyDescriptor): descriptor is PropertyDescriptor & {
  readonly value: unknown;
} {
  return Object.prototype.hasOwnProperty.call(descriptor, "value");
}

function hostAccept<T>(value: T): DesktopHostResult<T> {
  return Object.freeze({
    ok: true,
    value,
  });
}

function hostReject<T>(errorValue: DesktopHostError): DesktopHostResult<T> {
  return Object.freeze({
    error: errorValue,
    ok: false,
  });
}

function accept<T>(value: T): StoreResult<T> {
  return Object.freeze({
    ok: true,
    value,
  });
}

function reject<T>(errorValue: DesktopHostError): StoreResult<T> {
  return Object.freeze({
    error: errorValue,
    ok: false,
  });
}

function error(code: string, message: string, path: string): DesktopHostError {
  return Object.freeze({
    code,
    message,
    path,
  });
}

function pathToken(value: string): string {
  return value.replaceAll("~", "~0").replaceAll("/", "~1");
}
