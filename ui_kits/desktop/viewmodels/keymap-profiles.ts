import {
  detectShortcutConflicts,
  normalizeShortcutChord,
} from "./shortcuts.ts";
import type {
  ShortcutBinding,
  ShortcutChord,
  ShortcutConflict,
} from "./shortcuts.ts";
import type { DesktopHost } from "../../../sdk/typescript/src/desktop-sdk/index.ts";

/**
 * Keymap-profile view-model (PSD-262C).
 *
 * Headless, deterministic interaction logic for the flagship desktop. Layers a
 * named keymap preset (`Default` / `macOS` / `Emacs` / `Vim`) under the user's
 * personal overrides and produces the effective merged binding set the rendered
 * shell binds to. Pure: same inputs always yield byte-identical, frozen output.
 *
 * Merge precedence (lowest first): profile layer < user layer. The user always
 * wins. Every chord is canonicalized through {@link normalizeShortcutChord} from
 * `shortcuts.ts` so that conflict detection and merges are order-independent and
 * "same key -> same canonical form" holds across layers.
 *
 * NO DOM, NO global key hooks, NO ambient I/O. Persistence of the active profile
 * is explicitly the settings VM's job and is out of scope here.
 */

export type KeymapBindingSource = "profile" | "user";

export interface KeymapBindingInput {
  readonly chord: string;
  readonly commandId: string;
}

export interface KeymapProfileInput {
  readonly id: string;
  readonly title: string;
  readonly bindings: readonly KeymapBindingInput[];
}

export interface KeymapBinding {
  readonly chord: ShortcutChord;
  readonly commandId: string;
  readonly source: KeymapBindingSource;
}

export interface KeymapProfileSummary {
  readonly id: string;
  readonly title: string;
}

export interface KeymapProfileState {
  readonly profiles: readonly KeymapProfileSummary[];
  readonly activeProfileId: string;
  readonly bindings: readonly KeymapBinding[];
  readonly conflicts: readonly ShortcutConflict[];
}

export interface KeymapError {
  readonly code: string;
  readonly message: string;
  readonly path: string;
}

export type KeymapSetProfileResult =
  | {
      readonly ok: true;
      readonly state: KeymapProfileState;
    }
  | {
      readonly ok: false;
      readonly error: KeymapError;
      readonly state: KeymapProfileState;
    };

export interface KeymapBindingChange {
  readonly commandId: string;
  readonly from: ShortcutChord;
  readonly to: ShortcutChord;
}

export interface KeymapBindingRef {
  readonly commandId: string;
  readonly chord: ShortcutChord;
}

export interface KeymapProfileDiff {
  readonly fromProfileId: string;
  readonly toProfileId: string;
  readonly added: readonly KeymapBindingRef[];
  readonly removed: readonly KeymapBindingRef[];
  readonly changed: readonly KeymapBindingChange[];
}

export type KeymapDiffResult =
  | {
      readonly ok: true;
      readonly diff: KeymapProfileDiff;
    }
  | {
      readonly ok: false;
      readonly error: KeymapError;
    };

export type KeymapProfilesPort = Pick<DesktopHost, "package">;

export interface KeymapProfilesOptions {
  readonly profiles?: readonly KeymapProfileInput[];
  readonly activeProfileId?: string;
  readonly userOverrides?: readonly KeymapBindingInput[];
}

export interface KeymapProfilesViewModel {
  snapshot(): KeymapProfileState;
  list(): readonly KeymapBinding[];
  activeProfileId(): string;
  setActiveProfile(id: unknown): KeymapSetProfileResult;
  diff(fromProfileId: unknown, toProfileId: unknown): KeymapDiffResult;
}

/**
 * Command ids shared with the shortcut registry / keymap presets. Stable string
 * constants keep the presets and tests in lock-step.
 */
export const KEYMAP_COMMAND_IDS = Object.freeze({
  closeLauncher: "desktop.launcher.close",
  commandPalette: "desktop.command.palette",
  launchSettings: "desktop.settings.open",
  nextWindow: "desktop.window.next",
  openLauncher: "desktop.launcher.open",
  prevWindow: "desktop.window.prev",
  toggleDarkMode: "desktop.theme.toggle",
});

export const DEFAULT_KEYMAP_PROFILES = Object.freeze([
  Object.freeze({
    bindings: Object.freeze([
      Object.freeze({ chord: "Control+Space", commandId: KEYMAP_COMMAND_IDS.openLauncher }),
      Object.freeze({ chord: "Escape", commandId: KEYMAP_COMMAND_IDS.closeLauncher }),
      Object.freeze({ chord: "Control+Comma", commandId: KEYMAP_COMMAND_IDS.launchSettings }),
      Object.freeze({ chord: "Control+Shift+D", commandId: KEYMAP_COMMAND_IDS.toggleDarkMode }),
      Object.freeze({ chord: "Control+Shift+P", commandId: KEYMAP_COMMAND_IDS.commandPalette }),
      Object.freeze({ chord: "Control+Tab", commandId: KEYMAP_COMMAND_IDS.nextWindow }),
      Object.freeze({ chord: "Control+Shift+Tab", commandId: KEYMAP_COMMAND_IDS.prevWindow }),
    ]),
    id: "Default",
    title: "Default",
  }),
  Object.freeze({
    bindings: Object.freeze([
      Object.freeze({ chord: "Meta+Space", commandId: KEYMAP_COMMAND_IDS.openLauncher }),
      Object.freeze({ chord: "Escape", commandId: KEYMAP_COMMAND_IDS.closeLauncher }),
      Object.freeze({ chord: "Meta+Comma", commandId: KEYMAP_COMMAND_IDS.launchSettings }),
      Object.freeze({ chord: "Meta+Shift+D", commandId: KEYMAP_COMMAND_IDS.toggleDarkMode }),
      Object.freeze({ chord: "Meta+Shift+P", commandId: KEYMAP_COMMAND_IDS.commandPalette }),
      Object.freeze({ chord: "Meta+Tab", commandId: KEYMAP_COMMAND_IDS.nextWindow }),
      Object.freeze({ chord: "Meta+Shift+Tab", commandId: KEYMAP_COMMAND_IDS.prevWindow }),
    ]),
    id: "macOS",
    title: "macOS",
  }),
  Object.freeze({
    bindings: Object.freeze([
      Object.freeze({ chord: "Alt+X", commandId: KEYMAP_COMMAND_IDS.openLauncher }),
      Object.freeze({ chord: "Control+G", commandId: KEYMAP_COMMAND_IDS.closeLauncher }),
      Object.freeze({ chord: "Control+C", commandId: KEYMAP_COMMAND_IDS.launchSettings }),
      Object.freeze({ chord: "Alt+T", commandId: KEYMAP_COMMAND_IDS.toggleDarkMode }),
      Object.freeze({ chord: "Alt+P", commandId: KEYMAP_COMMAND_IDS.commandPalette }),
      Object.freeze({ chord: "Control+X", commandId: KEYMAP_COMMAND_IDS.nextWindow }),
      Object.freeze({ chord: "Control+Shift+X", commandId: KEYMAP_COMMAND_IDS.prevWindow }),
    ]),
    id: "Emacs",
    title: "Emacs",
  }),
  Object.freeze({
    bindings: Object.freeze([
      Object.freeze({ chord: "Shift+Semicolon", commandId: KEYMAP_COMMAND_IDS.openLauncher }),
      Object.freeze({ chord: "Escape", commandId: KEYMAP_COMMAND_IDS.closeLauncher }),
      Object.freeze({ chord: "Control+W", commandId: KEYMAP_COMMAND_IDS.launchSettings }),
      Object.freeze({ chord: "Shift+T", commandId: KEYMAP_COMMAND_IDS.toggleDarkMode }),
      Object.freeze({ chord: "Control+P", commandId: KEYMAP_COMMAND_IDS.commandPalette }),
      Object.freeze({ chord: "Control+L", commandId: KEYMAP_COMMAND_IDS.nextWindow }),
      Object.freeze({ chord: "Control+H", commandId: KEYMAP_COMMAND_IDS.prevWindow }),
    ]),
    id: "Vim",
    title: "Vim",
  }),
] satisfies readonly KeymapProfileInput[]);

interface NormalizedProfile {
  readonly id: string;
  readonly title: string;
  readonly bindings: readonly KeymapBinding[];
}

export function createKeymapProfilesViewModel(
  ports: KeymapProfilesPort,
  options: KeymapProfilesOptions = Object.freeze({}),
): KeymapProfilesViewModel {
  return new DesktopKeymapProfilesViewModel(ports, options);
}

class DesktopKeymapProfilesViewModel implements KeymapProfilesViewModel {
  readonly #profiles: readonly NormalizedProfile[];
  readonly #profileById: ReadonlyMap<string, NormalizedProfile>;
  readonly #userOverrides: readonly KeymapBinding[];
  #state: KeymapProfileState;

  constructor(_ports: KeymapProfilesPort, options: KeymapProfilesOptions) {
    this.#profiles = normalizeProfiles(options.profiles ?? DEFAULT_KEYMAP_PROFILES);
    this.#profileById = profileMap(this.#profiles);
    this.#userOverrides = normalizeOverrides(options.userOverrides ?? Object.freeze([]));

    const requestedActive = typeof options.activeProfileId === "string" ? options.activeProfileId : undefined;
    const activeId =
      requestedActive !== undefined && this.#profileById.has(requestedActive)
        ? requestedActive
        : firstProfileId(this.#profiles);

    this.#state = stateFor(this.#profiles, this.#profileById, this.#userOverrides, activeId);
  }

  snapshot(): KeymapProfileState {
    return this.#state;
  }

  list(): readonly KeymapBinding[] {
    return this.#state.bindings;
  }

  activeProfileId(): string {
    return this.#state.activeProfileId;
  }

  setActiveProfile(id: unknown): KeymapSetProfileResult {
    if (typeof id !== "string" || id.length === 0 || !this.#profileById.has(id)) {
      return Object.freeze({
        error: error("UNKNOWN_PROFILE", "keymap profile is not registered.", "/activeProfileId"),
        ok: false,
        state: this.#state,
      });
    }

    this.#state = stateFor(this.#profiles, this.#profileById, this.#userOverrides, id);

    return Object.freeze({
      ok: true,
      state: this.#state,
    });
  }

  diff(fromProfileId: unknown, toProfileId: unknown): KeymapDiffResult {
    if (typeof fromProfileId !== "string" || !this.#profileById.has(fromProfileId)) {
      return Object.freeze({
        error: error("UNKNOWN_PROFILE", "keymap diff source profile is not registered.", "/fromProfile"),
        ok: false,
      });
    }

    if (typeof toProfileId !== "string" || !this.#profileById.has(toProfileId)) {
      return Object.freeze({
        error: error("UNKNOWN_PROFILE", "keymap diff target profile is not registered.", "/toProfile"),
        ok: false,
      });
    }

    const from = this.#profileById.get(fromProfileId);
    const to = this.#profileById.get(toProfileId);

    if (from === undefined || to === undefined) {
      return Object.freeze({
        error: error("UNKNOWN_PROFILE", "keymap diff profile is not registered.", "/profile"),
        ok: false,
      });
    }

    return Object.freeze({
      diff: profileDiff(from, to),
      ok: true,
    });
  }
}

function stateFor(
  profiles: readonly NormalizedProfile[],
  profileById: ReadonlyMap<string, NormalizedProfile>,
  userOverrides: readonly KeymapBinding[],
  activeProfileId: string,
): KeymapProfileState {
  const active = profileById.get(activeProfileId);
  const bindings = mergeBindings(active?.bindings ?? Object.freeze([]), userOverrides);

  return Object.freeze({
    activeProfileId,
    bindings,
    conflicts: detectShortcutConflicts(asShortcutBindings(bindings)),
    profiles: profileSummaries(profiles),
  });
}

/**
 * Merge a profile layer under the user layer. The user layer wins per command:
 * a user override for a command replaces the profile binding for that command;
 * user-only commands are appended. Output ordering is deterministic — profile
 * order first (with per-command user substitution in place), then user-only
 * commands in their declared order — so the merge is order-independent given
 * the same inputs.
 */
function mergeBindings(
  profileBindings: readonly KeymapBinding[],
  userOverrides: readonly KeymapBinding[],
): readonly KeymapBinding[] {
  const overrideByCommand = new Map<string, KeymapBinding>();

  for (let index = 0; index < userOverrides.length; index += 1) {
    const override = userOverrides[index];

    if (override !== undefined && !overrideByCommand.has(override.commandId)) {
      overrideByCommand.set(override.commandId, override);
    }
  }

  const output: KeymapBinding[] = [];
  const emitted = new Set<string>();

  for (let index = 0; index < profileBindings.length; index += 1) {
    const binding = profileBindings[index];

    if (binding === undefined || emitted.has(binding.commandId)) {
      continue;
    }

    const override = overrideByCommand.get(binding.commandId);

    output.push(override ?? binding);
    emitted.add(binding.commandId);
  }

  for (let index = 0; index < userOverrides.length; index += 1) {
    const override = userOverrides[index];

    if (override === undefined || emitted.has(override.commandId)) {
      continue;
    }

    output.push(override);
    emitted.add(override.commandId);
  }

  return Object.freeze(output);
}

/**
 * Pure structural diff between two profiles' raw (pre-user-layer) bindings,
 * keyed by commandId. NO mutation of view-model state. `added` = commands bound
 * only in `to`; `removed` = commands bound only in `from`; `changed` = commands
 * in both whose normalized chord differs.
 */
function profileDiff(from: NormalizedProfile, to: NormalizedProfile): KeymapProfileDiff {
  const fromByCommand = bindingByCommand(from.bindings);
  const toByCommand = bindingByCommand(to.bindings);

  const added: KeymapBindingRef[] = [];
  const removed: KeymapBindingRef[] = [];
  const changed: KeymapBindingChange[] = [];

  for (let index = 0; index < from.bindings.length; index += 1) {
    const binding = from.bindings[index];

    if (binding === undefined) continue;

    const counterpart = toByCommand.get(binding.commandId);

    if (counterpart === undefined) {
      removed.push(bindingRef(binding));
      continue;
    }

    if (counterpart.chord !== binding.chord) {
      changed.push(Object.freeze({
        commandId: binding.commandId,
        from: binding.chord,
        to: counterpart.chord,
      }));
    }
  }

  for (let index = 0; index < to.bindings.length; index += 1) {
    const binding = to.bindings[index];

    if (binding === undefined) continue;

    if (!fromByCommand.has(binding.commandId)) {
      added.push(bindingRef(binding));
    }
  }

  return Object.freeze({
    added: Object.freeze(added),
    changed: Object.freeze(changed),
    fromProfileId: from.id,
    removed: Object.freeze(removed),
    toProfileId: to.id,
  });
}

function bindingByCommand(bindings: readonly KeymapBinding[]): ReadonlyMap<string, KeymapBinding> {
  const output = new Map<string, KeymapBinding>();

  for (let index = 0; index < bindings.length; index += 1) {
    const binding = bindings[index];

    if (binding !== undefined && !output.has(binding.commandId)) {
      output.set(binding.commandId, binding);
    }
  }

  return output;
}

function bindingRef(binding: KeymapBinding): KeymapBindingRef {
  return Object.freeze({
    chord: binding.chord,
    commandId: binding.commandId,
  });
}

function normalizeProfiles(profiles: readonly KeymapProfileInput[]): readonly NormalizedProfile[] {
  const output: NormalizedProfile[] = [];
  const seen = new Set<string>();

  for (let index = 0; index < profiles.length; index += 1) {
    const profile = profiles[index];

    if (
      profile === undefined ||
      typeof profile.id !== "string" ||
      profile.id.length === 0 ||
      typeof profile.title !== "string" ||
      profile.title.length === 0 ||
      seen.has(profile.id)
    ) {
      continue;
    }

    seen.add(profile.id);
    output.push(Object.freeze({
      bindings: normalizeProfileBindings(profile.bindings, "profile"),
      id: profile.id,
      title: profile.title,
    }));
  }

  return Object.freeze(output);
}

function normalizeProfileBindings(
  bindings: readonly KeymapBindingInput[],
  source: KeymapBindingSource,
): readonly KeymapBinding[] {
  const output: KeymapBinding[] = [];
  const seen = new Set<string>();

  for (let index = 0; index < bindings.length; index += 1) {
    const binding = bindings[index];

    if (
      binding === undefined ||
      typeof binding.commandId !== "string" ||
      binding.commandId.length === 0 ||
      seen.has(binding.commandId)
    ) {
      continue;
    }

    const normalized = normalizeShortcutChord(binding.chord);

    if (!normalized.ok) {
      continue;
    }

    seen.add(binding.commandId);
    output.push(Object.freeze({
      chord: normalized.chord,
      commandId: binding.commandId,
      source,
    }));
  }

  return Object.freeze(output);
}

function normalizeOverrides(overrides: readonly KeymapBindingInput[]): readonly KeymapBinding[] {
  return normalizeProfileBindings(overrides, "user");
}

function profileMap(profiles: readonly NormalizedProfile[]): ReadonlyMap<string, NormalizedProfile> {
  const output = new Map<string, NormalizedProfile>();

  for (let index = 0; index < profiles.length; index += 1) {
    const profile = profiles[index];

    if (profile !== undefined && !output.has(profile.id)) {
      output.set(profile.id, profile);
    }
  }

  return output;
}

function profileSummaries(profiles: readonly NormalizedProfile[]): readonly KeymapProfileSummary[] {
  const output: KeymapProfileSummary[] = [];

  for (let index = 0; index < profiles.length; index += 1) {
    const profile = profiles[index];

    if (profile !== undefined) {
      output.push(Object.freeze({
        id: profile.id,
        title: profile.title,
      }));
    }
  }

  return Object.freeze(output);
}

function firstProfileId(profiles: readonly NormalizedProfile[]): string {
  const first = profiles[0];

  return first?.id ?? "Default";
}

function asShortcutBindings(bindings: readonly KeymapBinding[]): readonly ShortcutBinding[] {
  const output: ShortcutBinding[] = [];

  for (let index = 0; index < bindings.length; index += 1) {
    const binding = bindings[index];

    if (binding !== undefined) {
      output.push(Object.freeze({
        chord: binding.chord,
        commandId: binding.commandId,
        source: binding.source === "user" ? "user" : "default",
      }));
    }
  }

  return Object.freeze(output);
}

function error(code: string, message: string, path: string): KeymapError {
  return Object.freeze({
    code,
    message,
    path,
  });
}
