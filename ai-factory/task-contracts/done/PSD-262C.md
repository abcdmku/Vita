---
id: PSD-262C
title: Keymap profiles + multi-stroke chord-sequence matcher
status: ready
phase: 6
pod: desktop
risk_class: R1
fr: []
depends_on: [PSD-260C]
target_paths:
  - ui_kits/desktop/viewmodels
  - sdk/typescript/test/ui-kits
acceptance_command: "npm run typecheck && node --experimental-strip-types --test sdk/typescript/test/ui-kits/keymap-profiles*.test.ts sdk/typescript/test/ui-kits/chord-sequence*.test.ts"
allowed_network: false
budget_minutes: 90
---

## Objective
Two merged, headless, deterministic global-input **view-models** for the flagship desktop, built ONLY on `@vita/desktop-sdk` public ports + the existing `ui_kits/desktop/viewmodels/shortcuts.ts` chord normalization (PSD-260C) — injected ports, NO platform internals, NO DOM/rendering/global key hooks (pure interaction logic the rendered design binds to later).
- **Keymap-profile VM** (`ui_kits/desktop/viewmodels/keymap-profiles.ts`): layers named presets (`Default` / `macOS` / `Emacs` / `Vim`) over the shortcut registry. State: available profiles, active profile id, effective merged bindings (profile layer < user layer — user overrides win), per-profile conflict report (same normalized chord bound to >1 commandId). Actions: `setActiveProfile(id)` recomputes effective bindings deterministically; pure `diff(fromProfile, toProfile)` returns added/removed/changed bindings with NO mutation. All chords normalized through `shortcuts.ts` (same key → same canonical form) so conflicts and merges are order-independent.
- **Chord-sequence matcher VM** (`ui_kits/desktop/viewmodels/chord-sequence.ts`): multi-stroke leader-key sequences (e.g. `Ctrl+K Ctrl+S`). `feed(chordEvent)` advances or resets a pending buffer and returns a frozen result: `{ kind: "partial", prefix, candidates }` (single/two-stroke prefix matched, ambiguous continuations listed), `{ kind: "matched", commandId }`, `{ kind: "none" }` (no sequence starts with the buffer → reset), or `{ kind: "timeout-expired" }` (injected clock exceeded the inter-stroke window → buffer reset). Clock is INJECTED (no `Date.now`); no ambient timers. Each stroke normalized via `shortcuts.ts`.
- Tests under `sdk/typescript/test/ui-kits/keymap-profiles.test.ts` + `sdk/typescript/test/ui-kits/chord-sequence.test.ts`.
- Import the SDK exactly as `ui_kits/desktop/package.ts` does; use ONLY public exports. Reuse `shortcuts.ts` normalization — do not re-implement it.

## User value
Power-user keyboard control for the desktop: switchable keymap presets (with the user's overrides always winning) plus VS-Code-style multi-stroke leader sequences — both as real, testable logic on the SDK that the CEF-rendered shell hydrates against.

## Non-goals
- NO DOM/CSS/rendering/CEF, NO real keyboard/global-hotkey capture, NO ambient clock/timers. NO new visual design. Don't re-implement SDK ports or `shortcuts.ts` normalization — consume them. NO persistence of the active profile (that is the settings VM's job).

## Acceptance
`acceptance_command` passes: deterministic unit tests cover — profile switch recomputes effective bindings; user overrides beat profile bindings; per-profile conflict report; pure `diff` with no mutation; single-stroke match; two-stroke match; ambiguous `partial` with multiple candidates; `none`/reset on unknown prefix; injected-clock `timeout-expired` reset. Typecheck clean. Pure, headless.

## Security/constraints
- Injected ports + injected clock only (no ambient I/O, no `Date.now`, no timers); pure/deterministic; same inputs → identical results. No remote imports; lockfile; no lifecycle scripts.

## Definition of done
- `ui_kits/desktop/viewmodels/keymap-profiles.ts` + `ui_kits/desktop/viewmodels/chord-sequence.ts` + `sdk/typescript/test/ui-kits/keymap-profiles.test.ts` + `sdk/typescript/test/ui-kits/chord-sequence.test.ts`, deterministic, typecheck clean, reusing `shortcuts.ts` normalization. R1.
