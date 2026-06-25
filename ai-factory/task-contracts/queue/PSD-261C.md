---
id: PSD-261C
title: Command registry view-model — non-launcher desktop commands
status: ready
phase: 6
pod: desktop
risk_class: R1
fr: []
depends_on: [PSD-021]
target_paths:
  - ui_kits/desktop/viewmodels
  - sdk/typescript/test/ui-kits
acceptance_command: "npm run typecheck && node --experimental-strip-types --test sdk/typescript/test/ui-kits/command-registry.test.ts"
allowed_network: false
budget_minutes: 90
---

## Objective
Headless, deterministic **command-registry view-model** for the flagship desktop, built ONLY on `@vita/desktop-sdk` public ports — injected ports, NO platform internals, NO DOM/rendering. It decouples *commands* from the launcher so shortcuts and the command palette can target window-manager, workspace, theme, and settings actions (not just app launches).
- A command is `{ id, title, category, when }` plus an `execute` thunk **classified as a typed action**: the action union is `launcher.intent | wm.intent | settings.write | theme.toggle | noop`. Registering enables shortcuts/palette to dispatch the right typed action for each class.
- API: `register(command)` (duplicate `id` → reject, fail-closed); `snapshot()` → commands **grouped by category** (deterministic ordering: category then title); `execute(id, ctx)` → the **typed action union** for that command (no privileged I/O — pure classification/thunk evaluation), evaluating its `when`-context against `ctx`; unknown `id` → fail-closed (no action emitted).
- `when`-context filtering: `snapshot()` / availability honors each command's `when` predicate against the supplied context so palette/shortcuts only surface applicable commands.
- Put the code under `ui_kits/desktop/viewmodels/command-registry.ts` and tests under `sdk/typescript/test/ui-kits/command-registry.test.ts`.
- Import the SDK exactly as the sibling view-models (`ui_kits/desktop/viewmodels/shortcuts.ts`) do; use ONLY public exports. Coordinate with the menu/shortcuts command registry (PSD-201) — reuse its command/typed-action shapes where they already exist; do not fork them.

## User value
Lets keyboard shortcuts and the command palette drive WM/workspace/theme/settings actions — not just launching apps — turning the static desktop into real, testable, command-driven behavior on the SDK.

## Non-goals
- NO DOM/CSS/rendering/CEF. NO platform internals. NO privileged I/O inside `execute` (it returns a typed action; the dispatcher performs effects). NO new visual design. Don't re-implement SDK ports or the PSD-201 shortcut registry — consume/extend them.

## Acceptance
`acceptance_command` passes: deterministic unit tests cover register/duplicate-reject; category grouping (stable order); `when`-context filtering; `execute` → the correct typed action per class (`launcher.intent | wm.intent | settings.write | theme.toggle | noop`); unknown-id fail-closed. Typecheck clean. Pure, headless.

## Security/constraints
- Injected ports only (no ambient I/O); capability-mediated, fail-closed; pure/deterministic (same inputs → same snapshot/action). No remote imports; lockfile; no lifecycle scripts.

## Definition of done
- `ui_kits/desktop/viewmodels/command-registry.ts` + `sdk/typescript/test/ui-kits/command-registry.test.ts`, deterministic, typecheck clean. R1.

## REVISION 1 (prior run was an EMPTY vacuous pass — Codex usage limit — 2026-06-25)
The previous dispatch produced NO files yet 'passed' (a `*.test.ts` glob matched nothing -> 0 tests -> exit 0). You MUST create the impl + test file(s) named in this contract with REAL deterministic assertions. The acceptance now uses EXACT test paths (no glob) so a missing file fails the run. An empty branch is a FAILURE.
