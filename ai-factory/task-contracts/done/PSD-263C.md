---
id: PSD-263C
title: Cross-domain shortcut commands + per-app keymap scoping (when-context)
status: ready
phase: 6
pod: desktop
risk_class: R1
fr: []
depends_on: [PSD-021]
target_paths:
  - ui_kits/desktop/viewmodels/shortcuts.ts
  - sdk/typescript/test/ui-kits
acceptance_command: "npm run typecheck && node --experimental-strip-types --test sdk/typescript/test/ui-kits/default-commands.test.ts sdk/typescript/test/ui-kits/when-context.test.ts"
allowed_network: false
budget_minutes: 90
---

## Objective
Two merged additions to the global-input shortcuts view-model (`ui_kits/desktop/viewmodels/shortcuts.ts`),
built ONLY on `@vita/desktop-sdk` public ports (the launcher command port + WM/workspace policy intents +
surface model) — injected ports, NO platform internals, NO DOM/rendering. **No change to the existing
register/rebind/reset/normalize/conflict/dispatch flows**: this slice only ADDS the broader default keymap
and the when-context resolver alongside them.
- **Cross-domain default commands + bindings.** Expand `DEFAULT_SHORTCUT_COMMANDS` /
  `DEFAULT_SHORTCUT_BINDINGS` (new frozen `*_V2` exports — do NOT mutate the existing frozen V1 sets that
  PSD-260C tests pin) to cover WM/workspace/theme/snap verbs, each yielding a typed action that targets an
  EXISTING SDK view-model / launcher intent:
  - window-snap left/right/up/down (`Super+ArrowLeft|Right|Up|Down`), maximize/minimize/close
    (`Super+Up`/`Super+H`/`Super+W`),
  - workspace switch 1..9 (`Super+1`..`Super+9`) and move-window-to-workspace
    (`Super+Shift+ArrowLeft|Right`),
  - theme toggle + layout (tiling/stacking) toggle.
  Every default command's typed `action` must resolve to a real target: a `launcher.*`
  `DesktopLauncherIntent` (dispatched via the existing `emitLauncherIntent` port, capability-gated by
  `hasDesktopCapabilityGrant`) OR a typed WM/workspace/theme action descriptor (e.g.
  `{ kind: "wm.snap", direction }`, `{ kind: "workspace.switch", index }`, `{ kind: "theme.toggle" }`)
  that names an existing SDK policy verb (`switchWorkspace`/`moveWindowToWorkspace`/`maximizeWindow`/
  `minimizeWindow`/`closeWindow`/`setWorkspaceLayout` from `@vita/desktop-sdk`). The expanded keymap must
  be conflict-free under the existing `detectShortcutConflicts(...)`.
- **When-context resolver.** Add a pure `WhenContext` snapshot type and a boolean context-expression
  evaluator so the SAME chord can resolve to different commands depending on focus, with a global fallback.
  - A scoped binding carries an optional `when` expression string over a small, fixed grammar:
    equality on `focusedApp` / `surface` (e.g. `focusedApp == "vita.app.files"`, `surface == files`) and
    boolean flags `modal`, `editable`, combined with `&&`, `||`, `!`, and parentheses.
  - `resolveScoped(chord, context)` evaluates each candidate binding's `when` against a **frozen**
    `WhenContext` snapshot (`{ focusedApp, surface, modal, editable }`); the most-specific matching scoped
    binding wins; if none match, fall back to the global (un-`when`'d) binding for that chord; if neither
    exists → `UNBOUND_CHORD`.
  - The evaluator is **fail-closed**: a malformed/unparseable `when` expression, an unknown identifier, or
    a context snapshot that is not a plain object yields a typed error (`INVALID_WHEN` /
    `INVALID_CONTEXT`) and the binding is treated as non-matching — it NEVER throws and NEVER falls through
    to a different command by accident.
- Reuse the existing `ShortcutError`/result-envelope style (`{ ok, error: { code, message, path } }`,
  all returns `Object.freeze`d). Import the SDK exactly as `ui_kits/desktop/package.ts` does; use ONLY
  public exports. Put tests under `sdk/typescript/test/ui-kits/default-commands.test.ts` and
  `sdk/typescript/test/ui-kits/when-context.test.ts`.

## User value
Gives the desktop a real, conflict-checked global keymap spanning window management, workspaces, snapping,
and theming, and lets the same chord do the right thing per focus (e.g. a chord that means one thing in
Files and another globally) — the interaction logic the CEF-rendered shell + Settings > Shortcuts surface
hydrate against.

## Non-goals
- NO DOM/CSS/rendering/CEF. NO platform internals. NO change to the existing
  register/rebind/reset/normalize/conflict/dispatch behavior or the V1 default sets. NO new visual design.
  Don't re-implement SDK WM/workspace/launcher ports — consume them. No actual WM mutation here (the
  resolver returns typed actions; applying them is the host's job).

## Acceptance
`acceptance_command` passes: `npm run typecheck` clean AND the node test runner reports both
`default-commands*.test.ts` and `when-context*.test.ts` suites green, asserting:
- every expanded default command maps to a valid typed action targeting an existing vm/launcher intent or
  named SDK policy verb, and the full default keymap is conflict-free (`detectShortcutConflicts` empty);
- a context-expression truth table (each operator `&&`/`||`/`!`/parens, equality on `focusedApp`/`surface`,
  the `modal`/`editable` flags) over representative `WhenContext` snapshots;
- a scoped binding beats the global binding ONLY when its `when` matches the context, and the global
  fallback wins when no scoped `when` matches;
- malformed `when` expression, unknown identifier, and non-plain-object context all fail closed
  (`INVALID_WHEN`/`INVALID_CONTEXT`) without throwing and without selecting a wrong command.
Pure, headless, deterministic (no timers, no network, no ambient I/O).

## Security/constraints
- Injected ports only (no ambient I/O); capability-mediated, fail-closed; pure/deterministic. Malformed
  `when`/context input must never throw, never invoke accessors, and never mis-resolve to another command.
  No remote imports; lockfile; no lifecycle scripts.

## Hardware profiles
- Portable-first; no hardware dependency (pure TS view-model logic, runs under the node test runner).

## Allowed tools + network
- Read/write the target paths; run the acceptance command locally. `allowed_network: false` — no network
  access at build or test time.

## Compute/time budget
- `budget_minutes: 90`, single worker.

## Required artifacts
- `ui_kits/desktop/viewmodels/shortcuts.ts` with the added `*_V2` cross-domain default command/binding
  sets, the `WhenContext` type + context-expression evaluator, and `resolveScoped(...)` (public exports;
  existing flows unchanged).
- `sdk/typescript/test/ui-kits/default-commands.test.ts` and
  `sdk/typescript/test/ui-kits/when-context.test.ts` (new deterministic suites).

## Rollback plan
- Revert the task branch; the additions are isolated and additive (new exports + new test files, V1 sets
  untouched), so reverting `task/PSD-263C` restores the prior state with no migration.

## Definition of done
- `ui_kits/desktop/viewmodels/shortcuts.ts` exports the expanded cross-domain default keymap (conflict-free,
  every command → valid typed action) and the fail-closed when-context resolver, with the existing
  register/rebind/reset/normalize/conflict/dispatch behavior unchanged; both new test suites exist and the
  `acceptance_command` passes with every branch above (incl. all fail-closed paths) asserted; typecheck
  clean. R1.

## REVISION 1 (prior run was an EMPTY vacuous pass — Codex usage limit — 2026-06-25)
The previous dispatch produced NO files yet 'passed' (a `*.test.ts` glob matched nothing -> 0 tests -> exit 0). You MUST create the impl + test file(s) named in this contract with REAL deterministic assertions. The acceptance now uses EXACT test paths (no glob) so a missing file fails the run. An empty branch is a FAILURE.
