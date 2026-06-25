---
id: PSD-267C
title: Pointer/gesture & modifier-chord input view-model
status: ready
phase: 6
pod: desktop
risk_class: R1
fr: []
depends_on: [PSD-261C]
target_paths:
  - ui_kits/desktop/viewmodels
  - sdk/typescript/test/ui-kits
acceptance_command: "npm run typecheck && node --experimental-strip-types --test sdk/typescript/test/ui-kits/gesture-input*.test.ts"
allowed_network: false
budget_minutes: 90
---

## Objective
Headless, deterministic **pointer/gesture input view-model** for the flagship desktop, built ONLY on `@vita/desktop-sdk` public ports — injected ports, NO platform internals, NO DOM/rendering. It extends the desktop input layer beyond keyboard chords to pointer/wheel/gesture bindings, resolving them against the SAME command model so gesture and keyboard chords coexist in one dispatcher.
- Normalize raw pointer/wheel/gesture events (`pointer.move`, `pointer.drag`, `wheel`, `gesture.swipe`, `gesture.pinch`, modifier mask) into a **canonical gesture chord** — a stable, order-independent descriptor `{ kind, modifiers, direction?, fingers? }` (modifiers sorted deterministically; equivalent events → byte-identical chord).
- Bindings (modifier+scroll → zoom, modifier+drag → window move/resize, edge-swipe → workspace switch, three-finger gesture → app/workspace action) resolve the canonical chord against **gesture commands in the registry** (PSD-261C command-registry view-model); `dispatch(event, ctx)` → the registry's **typed action union** (`launcher.intent | wm.intent | settings.write | theme.toggle | noop`), evaluating the command's `when`-context against `ctx`. Unbound chord → `noop` (no-op, fail-closed). No privileged I/O — pure normalization + classification.
- API: `bind(chord, commandId)` (duplicate chord → reject, fail-closed); `normalize(event)` → canonical gesture chord; `dispatch(event, ctx)` → typed action (or `noop`); `snapshot()` → deterministic list of bindings. Coexists with keyboard chords: both resolve through the one PSD-261C command model — do not fork the action union or registry shapes.
- Put the code under `ui_kits/desktop/viewmodels/gesture-input.ts` and tests under `sdk/typescript/test/ui-kits/gesture-input.test.ts`.
- Import the SDK exactly as the sibling view-models (`ui_kits/desktop/viewmodels/command-registry.ts` / `shortcuts.ts`) do; use ONLY public exports.

## User value
Turns the static desktop into real, testable pointer-driven behavior — modifier+scroll zoom, modifier+drag window move/resize, edge-swipe workspace switch, three-finger gestures — sharing one command model with keyboard shortcuts so all input drives the same typed actions on the SDK.

## Non-goals
- NO DOM/CSS/rendering/CEF. NO platform internals. NO raw OS input capture. NO privileged I/O inside `dispatch` (it returns a typed action; the dispatcher performs effects). NO new visual design. Don't re-implement SDK ports or the PSD-261C command registry / action union — consume/extend them.

## Acceptance
`acceptance_command` passes: deterministic unit tests cover wheel+modifier → zoom action; drag-with-modifier → window (move/resize) action; edge-swipe → workspace-switch action; three-finger gesture → its bound action; gesture normalization is canonical + deterministic (equivalent events → identical chord, modifier order-independent); duplicate-bind reject; unbound chord → `noop` fail-closed. Typecheck clean. Pure, headless.

## Security/constraints
- Injected ports only (no ambient I/O); capability-mediated, fail-closed; pure/deterministic (same inputs → same chord/action). No remote imports; lockfile; no lifecycle scripts.

## Definition of done
- `ui_kits/desktop/viewmodels/gesture-input.ts` + `sdk/typescript/test/ui-kits/gesture-input.test.ts`, deterministic, typecheck clean. R1.
