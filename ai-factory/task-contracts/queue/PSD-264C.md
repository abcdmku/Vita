---
id: PSD-264C
title: Keyboard-settings view-model (shortcuts editor on the settings port)
status: ready
phase: 6
pod: desktop
risk_class: R1
fr: []
depends_on: [PSD-260C, PSD-021]
target_paths:
  - ui_kits/desktop/viewmodels/keyboard-settings.ts
  - sdk/typescript/test/ui-kits
acceptance_command: "npm run typecheck && node --experimental-strip-types --test sdk/typescript/test/ui-kits/keyboard-settings*.test.ts"
allowed_network: false
budget_minutes: 90
---

## Objective
Headless, deterministic **view-model** backing the flagship desktop's Keyboard / Shortcuts **Settings
section** — the shortcuts editor — built ONLY on `@vita/desktop-sdk` public ports (the settings
control-plane port: `requestSettingsPreview` / `requestSettingsApply` /
`emitSettingsControlPlaneIntent` / `settleSettingsControlPlaneResult` + `SettingsControlPlanePort`,
and the global-input shortcuts view-model from PSD-260C). Injected ports, NO platform internals,
NO DOM/rendering (the view-model is the pure interaction logic the rendered Settings surface binds
to later).
- **State**: bindings grouped by category (e.g. window-management, navigation, app, global), each
  binding = `{ commandId, label, category, chord, isUserOverride }` in deterministic order
  (category order then label/commandId); plus an **editing state** indicating which command (if any)
  is currently *capturing* a new chord, and a pending-preview marker when an edit is in flight on the
  control plane.
- **Actions**: `beginCapture(commandId)` / `cancelCapture()` (set/clear the capturing command);
  `applyCapture(keyEventOrChord)` → normalize via `shortcuts.ts` chord capture/normalization, then
  route the rebind through settings **preview → apply** (reversible control-plane edit) — surfacing
  `INVALID_CHORD` / `INVALID_KEY_EVENT` and `SHORTCUT_CONFLICT` fail-closed WITHOUT committing;
  `reset(commandId)` (restore one binding's default) and `resetAll()` (restore all defaults), each
  routed through preview → apply; `selectKeymapProfile(profileId)` (active-keymap-profile selection)
  persisted through the same preview/apply path. Persistence of user overrides + active profile uses
  the pure `serialize()` helper (PSD-260C) as the value written via the settings port — NO direct
  disk/host I/O here.
- **Fail-closed**: if the settings ports are absent (`COMMAND_PORT_UNAVAILABLE`-style) or the
  `settings.write` grant is missing (`MISSING_CAPABILITY`), every mutating action returns a typed
  error and leaves state unchanged; preview/apply results are settled via
  `settleSettingsControlPlaneResult` (rejection is reversible — no partial commit).
- Put the code under `ui_kits/desktop/viewmodels/keyboard-settings.ts` and tests under
  `sdk/typescript/test/ui-kits/keyboard-settings.test.ts`. Import the SDK exactly as
  `ui_kits/desktop/package.ts` does; use ONLY public exports (consume `shortcuts.ts` via its public
  view-model + `serialize()`).

## User value
Turns the static Keyboard/Shortcuts Settings mockup into real, testable desktop behavior — a
shortcuts editor that captures chords, rebinds/resets through the reversible control plane, and
switches keymap profiles — the logic the CEF-rendered Settings > Keyboard surface hydrates against.

## Non-goals
- NO DOM/CSS/rendering/CEF. NO platform internals. NO new visual design (the HTML is the design of
  record). Don't re-implement the SDK settings/shortcuts ports — consume them. No direct disk/host
  I/O (persistence is the host's job via the settings value); no change to `shortcuts.ts`
  normalize/conflict/dispatch behavior.

## Acceptance
`acceptance_command` passes: `npm run typecheck` clean AND the node test runner reports the
`keyboard-settings*.test.ts` suite green, with deterministic assertions (fake settings + shortcuts
ports) covering: grouped/ordered bindings snapshot; `beginCapture`/`cancelCapture` editing-state
transitions; an `applyCapture` **capture → preview → apply** round-trip through the fake settings
control plane (binding updated, override persisted via `serialize()`); `reset(commandId)` and
`resetAll()` restoring defaults through preview/apply; `selectKeymapProfile` persisted; and every
fail-closed branch — `INVALID_CHORD` / `INVALID_KEY_EVENT`, `SHORTCUT_CONFLICT` (no commit),
missing `settings.write` grant, and absent settings port — each leaving state unchanged. Pure,
headless, deterministic (no timers, no network, no ambient I/O).

## Security/constraints
- Injected ports only (no ambient I/O); capability-mediated, fail-closed; reversible control-plane
  edits (preview/apply, never a partial commit); pure/deterministic. Hostile/accessor-laden chord or
  key-event inputs fail closed without invoking accessors. No remote imports; lockfile; no lifecycle
  scripts.

## Hardware profiles
- Portable-first; no hardware dependency (pure TS view-model logic, runs under the node test runner).

## Allowed tools + network
- Read/write the target paths; run the acceptance command locally. `allowed_network: false` — no
  network access at build or test time.

## Compute/time budget
- `budget_minutes: 90`, single worker.

## Required artifacts
- `ui_kits/desktop/viewmodels/keyboard-settings.ts` (the keyboard-settings view-model, public
  exports, consuming the SDK settings control-plane port + the PSD-260C shortcuts view-model/
  `serialize()`).
- `sdk/typescript/test/ui-kits/keyboard-settings.test.ts` (new deterministic suite).

## Rollback plan
- Revert the task branch; the view-model + test file are new and additive (no migration), so
  reverting `task/PSD-264C` restores the prior state.

## Definition of done
- `ui_kits/desktop/viewmodels/keyboard-settings.ts` + `sdk/typescript/test/ui-kits/keyboard-settings.test.ts`
  exist; `acceptance_command` passes; capture→preview→apply round-trips, reset/reset-all, profile
  select persistence, and all fail-closed paths (invalid chord/key-event, conflict, missing
  `settings.write`, absent settings port) are asserted; deterministic; typecheck clean. R1.
