---
id: PSD-266C
title: Shortcut cheat-sheet + reserved-chord guard + keyboard-operability view-models
status: ready
phase: 6
pod: desktop
risk_class: R1
fr: []
depends_on: [PSD-021]
target_paths:
  - ui_kits/desktop/viewmodels/shortcut-cheatsheet.ts
  - ui_kits/desktop/viewmodels/reserved-chords.ts
  - sdk/typescript/test/ui-kits
acceptance_command: "npm run typecheck && node --experimental-strip-types --test sdk/typescript/test/ui-kits/shortcut-cheatsheet*.test.ts sdk/typescript/test/ui-kits/reserved-chords*.test.ts"
allowed_network: false
budget_minutes: 90
---

## Objective
Two merged, buildable-now, headless **view-models** for global keyboard input on the flagship desktop, built ONLY on
the public exports of `@vita/desktop-sdk` and the existing shortcuts view-model
(`ui_kits/desktop/viewmodels/shortcuts.ts` — `ShortcutBinding`, `ShortcutChord`, `ShortcutCommand`, `ShortcutConflict`,
`normalizeShortcutChord`, `detectShortcutConflicts`). Injected ports/data only, NO platform internals, NO DOM/rendering —
pure interaction logic the rendered design binds to later. Two files:

1. `ui_kits/desktop/viewmodels/shortcut-cheatsheet.ts` — a `?`-triggered shortcuts overlay view-model.
   - Input: the effective `ShortcutsState` bindings + commands (from the shortcuts VM), a platform/keymap descriptor
     (e.g. `"mac" | "win" | "linux"`), and an optional query string. State: effective bindings grouped by command
     category (deterministic, stable category + within-category ordering), each row carrying a human **chord glyph**
     string rendered per platform/keymap (e.g. `Meta+Comma` → `⌘ ,` on mac, `Ctrl+,` on win/linux), and `conflict` /
     `unbound` flags per command. Actions: `setQuery(text)` filters rows (case-insensitive over command title + chord
     glyph) without mutating bindings; `snapshot()` returns the grouped, filtered, frozen state. Glyph formatting and
     grouping are PURE functions of the normalized chord (re-use `normalizeShortcutChord` so display respects
     normalization-equivalence: `Cmd+,` and `Meta+Comma` format identically).

2. `ui_kits/desktop/viewmodels/reserved-chords.ts` — a reserved-chord guard / rebind-validation policy.
   - A pure `validateRebind(commandId, chord, { bindings, reserved?, mustHave? })` →
     `{ ok }` | `{ reserved: true, reason }` | `{ conflict: true, commandIds }` | `{ shadowingWarning: true, commandIds }`.
     Reject (fail-closed) any rebind whose normalized chord shadows a protected / OS-reserved chord — the default
     reserved set covers security/attention, lock, force-quit, and screenshot chords (carry a stable `reason` per
     category). Report a hard `conflict` when the normalized chord already binds a different command. Emit a
     non-blocking `shadowingWarning` when the rebind collides with an app "must-have" chord. All comparisons go through
     `normalizeShortcutChord` so reserved/conflict/shadow detection respects normalization-equivalence.
- Import the SDK exactly as `ui_kits/desktop/viewmodels/shortcuts.ts` does; use ONLY public exports. Tests under
  `sdk/typescript/test/ui-kits/shortcut-cheatsheet.test.ts` and `sdk/typescript/test/ui-kits/reserved-chords.test.ts`.

## User value
Makes the desktop fully keyboard-operable and discoverable: a real, testable `?` cheat-sheet the CEF-rendered overlay
hydrates against, plus a guard that stops users from rebinding away OS-reserved safety chords (lock, force-quit,
security/attention, screenshot) — the logic behind the static shortcuts design.

## Non-goals
- NO DOM/CSS/rendering/CEF. NO platform internals. NO new visual design (the HTML is the design of record). Do NOT
  re-implement the shortcuts registry or SDK ports — consume them. No persistence/serialization (PSD-260C owns that).

## Acceptance
`acceptance_command` passes: deterministic unit tests cover — glyph formatting per keymap (mac vs win/linux),
category grouping + stable ordering, case-insensitive query filter (matches title and glyph, non-mutating),
conflict/unbound flags; reserved chords rejected with the right `reason`, hard `conflict` reported with the colliding
`commandIds`, app must-have collisions warned (non-blocking), and normalization-equivalence respected across glyphs,
reserved detection, and conflict detection. Pure, headless, against in-memory data + fake ports. Typecheck clean.

## Security/constraints
- Injected ports/data only (no ambient I/O); capability-mediated, fail-closed (reserved guard rejects on any doubt);
  pure/deterministic (same inputs → byte-identical output). No remote imports; lockfile; no lifecycle scripts.

## Rollback plan
New files only; no edits to existing modules. Revert by deleting the two view-models + their two test files.

## Definition of done
- `ui_kits/desktop/viewmodels/shortcut-cheatsheet.ts` + `ui_kits/desktop/viewmodels/reserved-chords.ts` +
  `sdk/typescript/test/ui-kits/shortcut-cheatsheet.test.ts` + `sdk/typescript/test/ui-kits/reserved-chords.test.ts`,
  deterministic, typecheck clean, `acceptance_command` green. R1.
