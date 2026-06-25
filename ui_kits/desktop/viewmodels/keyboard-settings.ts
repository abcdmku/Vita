import {
  createShortcutsViewModel,
  DEFAULT_SHORTCUT_BINDINGS,
  DEFAULT_SHORTCUT_COMMANDS,
} from "./shortcuts.ts";
import type {
  ShortcutBindingInput,
  ShortcutCommand,
  ShortcutCommandPort,
  ShortcutPersistenceBinding,
  ShortcutsViewModel,
} from "./shortcuts.ts";
import { hasDesktopCapabilityGrant } from "../../../sdk/typescript/src/desktop-sdk/index.ts";
import {
  emitSettingsControlPlaneIntent,
  requestSettingsApply,
  requestSettingsPreview,
  settleSettingsControlPlaneResult,
} from "../../../sdk/typescript/src/desktop-sdk/index.ts";
import type {
  DesktopUiPackageManifest,
} from "../../../sdk/typescript/src/desktop-sdk/index.ts";
import type {
  SettingsAppState,
  SettingsControlPlaneIntent,
  SettingsControlPlanePort,
  SettingsEdit,
  SettingsManagedConfig,
} from "../../../sdk/typescript/src/desktop-sdk/index.ts";

/**
 * Keyboard / Shortcuts settings view-model — the shortcuts editor that backs the flagship
 * desktop's Settings > Keyboard surface. Pure, headless, deterministic: it injects the SDK
 * settings control-plane port (preview -> apply, reversible) and the PSD-260C shortcuts
 * view-model (chord normalization + conflict detection + `serialize()`), and never performs
 * ambient I/O. Persistence of user overrides + the active keymap profile is the host's job:
 * this view-model only routes a serialized blob through the settings control plane.
 */

export type KeyboardShortcutCategory =
  | "window-management"
  | "navigation"
  | "app"
  | "global";

export const KEYBOARD_SETTINGS_KEYS = Object.freeze({
  overrides: "keyboard.shortcuts.overrides",
  profile: "keyboard.shortcuts.profile",
});

export const KEYBOARD_SETTINGS_CATEGORY = "keyboard";

const CATEGORY_ORDER = Object.freeze([
  "window-management",
  "navigation",
  "app",
  "global",
] as const);

export interface KeyboardKeymapProfile {
  readonly id: string;
  readonly label: string;
}

export interface KeyboardCommandDescriptor {
  readonly commandId: string;
  readonly label: string;
  readonly category: KeyboardShortcutCategory;
}

export interface KeyboardShortcutEntry {
  readonly commandId: string;
  readonly label: string;
  readonly category: KeyboardShortcutCategory;
  readonly chord: string;
  readonly isUserOverride: boolean;
}

export interface KeyboardShortcutGroup {
  readonly category: KeyboardShortcutCategory;
  readonly shortcuts: readonly KeyboardShortcutEntry[];
}

export interface KeyboardEditingState {
  readonly capturingCommandId: string | null;
  readonly pendingPreview: boolean;
}

export interface KeyboardSettingsState {
  readonly groups: readonly KeyboardShortcutGroup[];
  readonly shortcuts: readonly KeyboardShortcutEntry[];
  readonly conflicts: readonly KeyboardShortcutConflict[];
  readonly profiles: readonly KeyboardKeymapProfile[];
  readonly activeProfileId: string;
  readonly editing: KeyboardEditingState;
}

export interface KeyboardShortcutConflict {
  readonly chord: string;
  readonly commandIds: readonly string[];
}

export interface KeyboardSettingsError {
  readonly code: string;
  readonly message: string;
  readonly path: string;
}

export type KeyboardSettingsResult =
  | {
      readonly ok: true;
      readonly state: KeyboardSettingsState;
    }
  | {
      readonly ok: false;
      readonly error: KeyboardSettingsError;
      readonly state: KeyboardSettingsState;
      readonly conflict?: KeyboardShortcutConflict;
    };

export type KeyboardSettingsControlPlanePort = SettingsControlPlanePort;

export interface KeyboardSettingsViewModelOptions {
  readonly manifest: DesktopUiPackageManifest;
  readonly port: KeyboardSettingsControlPlanePort;
  readonly commands?: readonly KeyboardCommandDescriptor[];
  readonly defaults?: readonly ShortcutBindingInput[];
  readonly userOverrides?: readonly ShortcutBindingInput[];
  readonly profiles?: readonly KeyboardKeymapProfile[];
  readonly activeProfileId?: string;
}

export interface KeyboardSettingsViewModel {
  snapshot(): KeyboardSettingsState;
  list(): readonly KeyboardShortcutEntry[];
  search(query: string): readonly KeyboardShortcutEntry[];
  beginCapture(commandId: string): KeyboardSettingsResult;
  cancelCapture(): KeyboardSettingsResult;
  applyCapture(keyEventOrChord: unknown): Promise<KeyboardSettingsResult>;
  reset(commandId: string): Promise<KeyboardSettingsResult>;
  resetAll(): Promise<KeyboardSettingsResult>;
  selectKeymapProfile(profileId: string): Promise<KeyboardSettingsResult>;
}

export const DEFAULT_KEYBOARD_COMMANDS = Object.freeze([
  Object.freeze({
    category: "navigation",
    commandId: DEFAULT_SHORTCUT_COMMANDS[0]?.id ?? "desktop.launcher.open",
    label: "Open Launcher",
  }),
  Object.freeze({
    category: "navigation",
    commandId: DEFAULT_SHORTCUT_COMMANDS[1]?.id ?? "desktop.launcher.close",
    label: "Close Launcher",
  }),
  Object.freeze({
    category: "app",
    commandId: DEFAULT_SHORTCUT_COMMANDS[2]?.id ?? "desktop.settings.open",
    label: "Open Settings",
  }),
  Object.freeze({
    category: "global",
    commandId: DEFAULT_SHORTCUT_COMMANDS[3]?.id ?? "desktop.theme.toggle",
    label: "Toggle Dark Mode",
  }),
] satisfies readonly KeyboardCommandDescriptor[]);

export const DEFAULT_KEYMAP_PROFILES = Object.freeze([
  Object.freeze({ id: "default", label: "Default" }),
  Object.freeze({ id: "emacs", label: "Emacs" }),
  Object.freeze({ id: "vim", label: "Vim" }),
] satisfies readonly KeyboardKeymapProfile[]);

export function createKeyboardSettingsViewModel(
  options: KeyboardSettingsViewModelOptions,
): KeyboardSettingsViewModel {
  return new DesktopKeyboardSettingsViewModel(options);
}

class DesktopKeyboardSettingsViewModel implements KeyboardSettingsViewModel {
  readonly #manifest: DesktopUiPackageManifest;
  readonly #port: KeyboardSettingsControlPlanePort;
  readonly #descriptors: readonly KeyboardCommandDescriptor[];
  readonly #descriptorById: ReadonlyMap<string, KeyboardCommandDescriptor>;
  readonly #commands: readonly ShortcutCommand[];
  readonly #defaults: readonly ShortcutBindingInput[];
  readonly #profiles: readonly KeyboardKeymapProfile[];
  readonly #profileIds: ReadonlySet<string>;
  readonly #shortcutPort: ShortcutCommandPort;
  #shortcuts: ShortcutsViewModel;
  #activeProfileId: string;
  #capturingCommandId: string | null;
  #pendingPreview: boolean;
  #state: KeyboardSettingsState;

  constructor(options: KeyboardSettingsViewModelOptions) {
    this.#manifest = options.manifest;
    this.#port = options.port;
    this.#descriptors = freezeDescriptors(options.commands ?? DEFAULT_KEYBOARD_COMMANDS);
    this.#descriptorById = descriptorMap(this.#descriptors);
    this.#commands = commandsFromDescriptors(this.#descriptors);
    this.#defaults = freezeBindingInputs(options.defaults ?? DEFAULT_SHORTCUT_BINDINGS);
    this.#profiles = freezeProfiles(options.profiles ?? DEFAULT_KEYMAP_PROFILES);
    this.#profileIds = profileIdSet(this.#profiles);
    this.#shortcutPort = Object.freeze({ package: this.#manifest });
    this.#shortcuts = createShortcutsViewModel(this.#shortcutPort, {
      commands: this.#commands,
      defaults: this.#defaults,
      userOverrides: options.userOverrides ?? Object.freeze([]),
    });
    this.#activeProfileId = pickActiveProfile(options.activeProfileId, this.#profiles);
    this.#capturingCommandId = null;
    this.#pendingPreview = false;
    this.#state = this.#buildState();
  }

  snapshot(): KeyboardSettingsState {
    return this.#state;
  }

  list(): readonly KeyboardShortcutEntry[] {
    return this.#state.shortcuts;
  }

  search(query: string): readonly KeyboardShortcutEntry[] {
    if (typeof query !== "string") {
      return Object.freeze([]);
    }

    const needle = query.trim().toLocaleLowerCase("en-US");

    if (needle.length === 0) {
      return this.#state.shortcuts;
    }

    const output: KeyboardShortcutEntry[] = [];

    for (let index = 0; index < this.#state.shortcuts.length; index += 1) {
      const entry = this.#state.shortcuts[index];

      if (entry === undefined) continue;
      if (matchesQuery(entry, needle)) {
        output.push(entry);
      }
    }

    return Object.freeze(output);
  }

  beginCapture(commandId: string): KeyboardSettingsResult {
    if (typeof commandId !== "string" || !this.#descriptorById.has(commandId)) {
      return this.#reject(error("UNKNOWN_COMMAND", "keyboard command is not registered.", "/commandId"));
    }

    this.#capturingCommandId = commandId;
    this.#pendingPreview = false;
    this.#state = this.#buildState();

    return this.#accept();
  }

  cancelCapture(): KeyboardSettingsResult {
    this.#capturingCommandId = null;
    this.#pendingPreview = false;
    this.#state = this.#buildState();

    return this.#accept();
  }

  async applyCapture(keyEventOrChord: unknown): Promise<KeyboardSettingsResult> {
    const commandId = this.#capturingCommandId;

    if (commandId === null) {
      return this.#reject(error("NOT_CAPTURING", "no keyboard command is capturing a chord.", "/editing"));
    }

    const guard = this.#requireWriteGrant("/commands/" + pathToken(commandId) + "/capability");

    if (guard !== null) {
      return guard;
    }

    // Probe on a throwaway clone so INVALID_CHORD / INVALID_KEY_EVENT / SHORTCUT_CONFLICT fail
    // closed WITHOUT mutating the live shortcuts model — the rebind is only committed locally
    // after the reversible control-plane apply succeeds (no partial commit).
    const probe = this.#cloneShortcuts().rebind(commandId, keyEventOrChord);

    if (!probe.ok) {
      return this.#rejectFromShortcut(probe.error, probe.conflict);
    }

    const nextOverrides = probe.state.userOverrides.map(toBindingInput);
    const value = serializeOverrides(this.#shortcutsWith(nextOverrides));
    const persisted = await this.#persist(KEYBOARD_SETTINGS_KEYS.overrides, value);

    if (!persisted.ok) {
      return persisted.result;
    }

    this.#shortcuts = this.#shortcutsWith(nextOverrides);
    this.#capturingCommandId = null;
    this.#pendingPreview = false;
    this.#state = this.#buildState();

    return this.#accept();
  }

  async reset(commandId: string): Promise<KeyboardSettingsResult> {
    if (typeof commandId !== "string" || !this.#descriptorById.has(commandId)) {
      return this.#reject(error("UNKNOWN_COMMAND", "keyboard command is not registered.", "/commandId"));
    }

    const guard = this.#requireWriteGrant("/commands/" + pathToken(commandId) + "/capability");

    if (guard !== null) {
      return guard;
    }

    const probe = this.#cloneShortcuts().reset(commandId);

    if (!probe.ok) {
      return this.#rejectFromShortcut(probe.error, probe.conflict);
    }

    const nextOverrides = probe.state.userOverrides.map(toBindingInput);
    const value = serializeOverrides(this.#shortcutsWith(nextOverrides));
    const persisted = await this.#persist(KEYBOARD_SETTINGS_KEYS.overrides, value);

    if (!persisted.ok) {
      return persisted.result;
    }

    this.#shortcuts = this.#shortcutsWith(nextOverrides);
    this.#capturingCommandId = null;
    this.#pendingPreview = false;
    this.#state = this.#buildState();

    return this.#accept();
  }

  async resetAll(): Promise<KeyboardSettingsResult> {
    const guard = this.#requireWriteGrant("/commands/capability");

    if (guard !== null) {
      return guard;
    }

    const cleared = this.#shortcutsWith(Object.freeze([]));
    const value = serializeOverrides(cleared);
    const persisted = await this.#persist(KEYBOARD_SETTINGS_KEYS.overrides, value);

    if (!persisted.ok) {
      return persisted.result;
    }

    this.#shortcuts = cleared;
    this.#capturingCommandId = null;
    this.#pendingPreview = false;
    this.#state = this.#buildState();

    return this.#accept();
  }

  async selectKeymapProfile(profileId: string): Promise<KeyboardSettingsResult> {
    if (typeof profileId !== "string" || !this.#profileIds.has(profileId)) {
      return this.#reject(error("UNKNOWN_KEYMAP_PROFILE", "keymap profile is not available.", "/profile"));
    }

    const guard = this.#requireWriteGrant("/profile/capability");

    if (guard !== null) {
      return guard;
    }

    const persisted = await this.#persist(KEYBOARD_SETTINGS_KEYS.profile, profileId);

    if (!persisted.ok) {
      return persisted.result;
    }

    this.#activeProfileId = profileId;
    this.#capturingCommandId = null;
    this.#pendingPreview = false;
    this.#state = this.#buildState();

    return this.#accept();
  }

  #shortcutsWith(userOverrides: readonly ShortcutBindingInput[]): ShortcutsViewModel {
    return createShortcutsViewModel(this.#shortcutPort, {
      commands: this.#commands,
      defaults: this.#defaults,
      userOverrides,
    });
  }

  #cloneShortcuts(): ShortcutsViewModel {
    return this.#shortcutsWith(this.#shortcuts.snapshot().userOverrides.map(toBindingInput));
  }

  #requireWriteGrant(path: string): KeyboardSettingsResult | null {
    if (!hasDesktopCapabilityGrant(this.#manifest, "settings.write")) {
      return this.#reject(error("MISSING_CAPABILITY", "keyboard settings require the settings.write grant.", path));
    }

    return null;
  }

  /**
   * Route a value through the reversible settings control plane: preview -> apply. A rejected
   * preview never proceeds to apply (no partial commit), and the in-flight preview marker is
   * surfaced while the round-trip is pending. Returns a discriminated result so callers can
   * commit local state only on a clean apply.
   */
  async #persist(
    settingId: string,
    value: string,
  ): Promise<{ readonly ok: true } | { readonly ok: false; readonly result: KeyboardSettingsResult }> {
    const edit: SettingsEdit = Object.freeze({
      categoryId: KEYBOARD_SETTINGS_CATEGORY,
      settingId,
      value,
    });
    const baseState = this.#controlPlaneState();

    this.#pendingPreview = true;
    this.#state = this.#buildState();

    const preview = requestSettingsPreview(baseState, edit);

    if (!preview.ok) {
      this.#pendingPreview = false;
      this.#state = this.#buildState();

      return failPersist(this.#reject(error(preview.error.code, preview.error.message, preview.error.path)));
    }

    const previewResult = await emitSettingsControlPlaneIntent(this.#port, preview.value.intent);

    if (!previewResult.ok) {
      this.#pendingPreview = false;
      this.#state = this.#buildState();

      return failPersist(
        this.#reject(error(previewResult.error.code, previewResult.error.message, previewResult.error.path)),
      );
    }

    const previewSettled = settleSettingsControlPlaneResult(baseState, preview.value.intent, previewResult);
    const apply = requestSettingsApply(previewSettled, edit);

    if (!apply.ok) {
      this.#pendingPreview = false;
      this.#state = this.#buildState();

      return failPersist(this.#reject(error(apply.error.code, apply.error.message, apply.error.path)));
    }

    const applyResult = await emitSettingsControlPlaneIntent(this.#port, apply.value.intent);

    this.#pendingPreview = false;

    if (!applyResult.ok) {
      this.#state = this.#buildState();

      return failPersist(
        this.#reject(error(applyResult.error.code, applyResult.error.message, applyResult.error.path)),
      );
    }

    // Settle the reversible edit; the committed config is the host's record. Local view-model
    // state is rebuilt by the caller after this returns ok.
    settleSettingsControlPlaneResult(previewSettled, apply.value.intent, applyResult);

    return { ok: true };
  }

  #controlPlaneState(): SettingsAppState {
    const overridesValue = serializeOverrides(this.#shortcuts);

    return Object.freeze({
      config: this.#controlPlaneConfig(overridesValue, this.#activeProfileId),
      selectedCategoryId: KEYBOARD_SETTINGS_CATEGORY,
    });
  }

  #controlPlaneConfig(overridesValue: string, profileValue: string): SettingsManagedConfig {
    return Object.freeze({
      categories: Object.freeze([
        Object.freeze({
          id: KEYBOARD_SETTINGS_CATEGORY,
          settings: Object.freeze([
            Object.freeze({
              id: KEYBOARD_SETTINGS_KEYS.overrides,
              kind: "text",
              label: "Shortcut overrides",
              value: overridesValue,
            }),
            Object.freeze({
              id: KEYBOARD_SETTINGS_KEYS.profile,
              kind: "text",
              label: "Active keymap profile",
              value: profileValue,
            }),
          ]),
          title: "Keyboard",
        }),
      ]),
      revision: "keyboard:1",
    });
  }

  #buildState(): KeyboardSettingsState {
    const snapshot = this.#shortcuts.snapshot();
    const overrideIds = new Set<string>();

    for (let index = 0; index < snapshot.userOverrides.length; index += 1) {
      const binding = snapshot.userOverrides[index];

      if (binding !== undefined) {
        overrideIds.add(binding.commandId);
      }
    }

    const chordByCommand = new Map<string, string>();

    for (let index = 0; index < snapshot.bindings.length; index += 1) {
      const binding = snapshot.bindings[index];

      if (binding !== undefined && !chordByCommand.has(binding.commandId)) {
        chordByCommand.set(binding.commandId, binding.chord);
      }
    }

    const entries: KeyboardShortcutEntry[] = [];

    for (let categoryIndex = 0; categoryIndex < CATEGORY_ORDER.length; categoryIndex += 1) {
      const category = CATEGORY_ORDER[categoryIndex];

      if (category === undefined) continue;

      const inCategory = this.#descriptorsForCategory(category);

      for (let index = 0; index < inCategory.length; index += 1) {
        const descriptor = inCategory[index];

        if (descriptor === undefined) continue;
        entries.push(Object.freeze({
          category: descriptor.category,
          chord: chordByCommand.get(descriptor.commandId) ?? "",
          commandId: descriptor.commandId,
          isUserOverride: overrideIds.has(descriptor.commandId),
          label: descriptor.label,
        }));
      }
    }

    return Object.freeze({
      activeProfileId: this.#activeProfileId,
      conflicts: freezeConflicts(snapshot.conflicts),
      editing: Object.freeze({
        capturingCommandId: this.#capturingCommandId,
        pendingPreview: this.#pendingPreview,
      }),
      groups: groupEntries(entries),
      profiles: this.#profiles,
      shortcuts: Object.freeze(entries),
    });
  }

  #descriptorsForCategory(category: KeyboardShortcutCategory): readonly KeyboardCommandDescriptor[] {
    const output: KeyboardCommandDescriptor[] = [];

    for (let index = 0; index < this.#descriptors.length; index += 1) {
      const descriptor = this.#descriptors[index];

      if (descriptor !== undefined && descriptor.category === category) {
        output.push(descriptor);
      }
    }

    output.sort(compareDescriptors);

    return Object.freeze(output);
  }

  #accept(): KeyboardSettingsResult {
    return Object.freeze({
      ok: true,
      state: this.#state,
    });
  }

  #reject(errorValue: KeyboardSettingsError): KeyboardSettingsResult {
    return Object.freeze({
      error: errorValue,
      ok: false,
      state: this.#state,
    });
  }

  #rejectFromShortcut(
    errorValue: { readonly code: string; readonly message: string; readonly path: string },
    conflict?: { readonly chord: string; readonly commandIds: readonly string[] },
  ): KeyboardSettingsResult {
    const output: {
      ok: false;
      error: KeyboardSettingsError;
      state: KeyboardSettingsState;
      conflict?: KeyboardShortcutConflict;
    } = {
      error: error(errorValue.code, errorValue.message, errorValue.path),
      ok: false,
      state: this.#state,
    };

    if (conflict !== undefined) {
      output.conflict = Object.freeze({
        chord: conflict.chord,
        commandIds: Object.freeze([...conflict.commandIds]),
      });
    }

    return Object.freeze(output);
  }
}

function failPersist(result: KeyboardSettingsResult): { readonly ok: false; readonly result: KeyboardSettingsResult } {
  return { ok: false, result };
}

function serializeOverrides(shortcuts: ShortcutsViewModel): string {
  const overrides = shortcuts.serialize();
  const normalized: { readonly chord: string; readonly commandId: string }[] = [];

  for (let index = 0; index < overrides.length; index += 1) {
    const entry = overrides[index];

    if (entry !== undefined) {
      normalized.push({ chord: entry.chord, commandId: entry.commandId });
    }
  }

  return JSON.stringify(normalized);
}

function toBindingInput(binding: { readonly chord: string; readonly commandId: string }): ShortcutBindingInput {
  return Object.freeze({
    chord: binding.chord,
    commandId: binding.commandId,
  });
}

function descriptorMap(
  descriptors: readonly KeyboardCommandDescriptor[],
): ReadonlyMap<string, KeyboardCommandDescriptor> {
  const output = new Map<string, KeyboardCommandDescriptor>();

  for (let index = 0; index < descriptors.length; index += 1) {
    const descriptor = descriptors[index];

    if (descriptor !== undefined && !output.has(descriptor.commandId)) {
      output.set(descriptor.commandId, descriptor);
    }
  }

  return output;
}

function commandsFromDescriptors(descriptors: readonly KeyboardCommandDescriptor[]): readonly ShortcutCommand[] {
  const output: ShortcutCommand[] = [];
  const seen = new Set<string>();

  for (let index = 0; index < descriptors.length; index += 1) {
    const descriptor = descriptors[index];

    if (descriptor === undefined || seen.has(descriptor.commandId)) continue;
    seen.add(descriptor.commandId);
    output.push(Object.freeze({
      id: descriptor.commandId,
      intent: Object.freeze({
        appId: "vita.command." + pathToken(descriptor.commandId),
        query: descriptor.commandId,
        type: "launcher.launch",
      }),
      title: descriptor.label,
    }));
  }

  return Object.freeze(output);
}

function freezeDescriptors(descriptors: readonly KeyboardCommandDescriptor[]): readonly KeyboardCommandDescriptor[] {
  const output: KeyboardCommandDescriptor[] = [];
  const seen = new Set<string>();

  for (let index = 0; index < descriptors.length; index += 1) {
    const descriptor = descriptors[index];

    if (
      descriptor === undefined ||
      typeof descriptor.commandId !== "string" ||
      descriptor.commandId.length === 0 ||
      typeof descriptor.label !== "string" ||
      !isCategory(descriptor.category) ||
      seen.has(descriptor.commandId)
    ) {
      continue;
    }

    seen.add(descriptor.commandId);
    output.push(Object.freeze({
      category: descriptor.category,
      commandId: descriptor.commandId,
      label: descriptor.label,
    }));
  }

  return Object.freeze(output);
}

function freezeBindingInputs(bindings: readonly ShortcutBindingInput[]): readonly ShortcutBindingInput[] {
  const output: ShortcutBindingInput[] = [];

  for (let index = 0; index < bindings.length; index += 1) {
    const binding = bindings[index];

    if (binding !== undefined) {
      output.push(Object.freeze({
        chord: binding.chord,
        commandId: binding.commandId,
      }));
    }
  }

  return Object.freeze(output);
}

function freezeProfiles(profiles: readonly KeyboardKeymapProfile[]): readonly KeyboardKeymapProfile[] {
  const output: KeyboardKeymapProfile[] = [];
  const seen = new Set<string>();

  for (let index = 0; index < profiles.length; index += 1) {
    const profile = profiles[index];

    if (
      profile === undefined ||
      typeof profile.id !== "string" ||
      profile.id.length === 0 ||
      typeof profile.label !== "string" ||
      seen.has(profile.id)
    ) {
      continue;
    }

    seen.add(profile.id);
    output.push(Object.freeze({ id: profile.id, label: profile.label }));
  }

  return Object.freeze(output);
}

function profileIdSet(profiles: readonly KeyboardKeymapProfile[]): ReadonlySet<string> {
  const output = new Set<string>();

  for (let index = 0; index < profiles.length; index += 1) {
    const profile = profiles[index];

    if (profile !== undefined) {
      output.add(profile.id);
    }
  }

  return output;
}

function pickActiveProfile(
  requested: string | undefined,
  profiles: readonly KeyboardKeymapProfile[],
): string {
  if (requested !== undefined) {
    for (let index = 0; index < profiles.length; index += 1) {
      if (profiles[index]?.id === requested) {
        return requested;
      }
    }
  }

  return profiles[0]?.id ?? "default";
}

function groupEntries(entries: readonly KeyboardShortcutEntry[]): readonly KeyboardShortcutGroup[] {
  const groups: KeyboardShortcutGroup[] = [];

  for (let categoryIndex = 0; categoryIndex < CATEGORY_ORDER.length; categoryIndex += 1) {
    const category = CATEGORY_ORDER[categoryIndex];

    if (category === undefined) continue;

    const shortcuts: KeyboardShortcutEntry[] = [];

    for (let index = 0; index < entries.length; index += 1) {
      const entry = entries[index];

      if (entry !== undefined && entry.category === category) {
        shortcuts.push(entry);
      }
    }

    if (shortcuts.length > 0) {
      groups.push(Object.freeze({
        category,
        shortcuts: Object.freeze(shortcuts),
      }));
    }
  }

  return Object.freeze(groups);
}

function freezeConflicts(
  conflicts: readonly { readonly chord: string; readonly commandIds: readonly string[] }[],
): readonly KeyboardShortcutConflict[] {
  const output: KeyboardShortcutConflict[] = [];

  for (let index = 0; index < conflicts.length; index += 1) {
    const conflict = conflicts[index];

    if (conflict !== undefined) {
      output.push(Object.freeze({
        chord: conflict.chord,
        commandIds: Object.freeze([...conflict.commandIds]),
      }));
    }
  }

  return Object.freeze(output);
}

function matchesQuery(entry: KeyboardShortcutEntry, needle: string): boolean {
  return (
    entry.label.toLocaleLowerCase("en-US").includes(needle) ||
    entry.commandId.toLocaleLowerCase("en-US").includes(needle) ||
    entry.chord.toLocaleLowerCase("en-US").includes(needle) ||
    entry.category.toLocaleLowerCase("en-US").includes(needle)
  );
}

function isCategory(value: unknown): value is KeyboardShortcutCategory {
  for (let index = 0; index < CATEGORY_ORDER.length; index += 1) {
    if (CATEGORY_ORDER[index] === value) {
      return true;
    }
  }

  return false;
}

function compareDescriptors(left: KeyboardCommandDescriptor, right: KeyboardCommandDescriptor): number {
  if (left.label < right.label) return -1;
  if (left.label > right.label) return 1;
  if (left.commandId < right.commandId) return -1;
  if (left.commandId > right.commandId) return 1;

  return 0;
}

function error(code: string, message: string, path: string): KeyboardSettingsError {
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
      : "_" + code.toString(16).padStart(4, "0");
  }

  return token;
}
