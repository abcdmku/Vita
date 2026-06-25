---
id: PSD-222C
title: Roving-focus / keyboard-nav + focus-trap + landmarks view-models
status: ready
phase: 6
pod: desktop
risk_class: R1
fr: []
depends_on: [PSD-021]
target_paths:
  - ui_kits/desktop/viewmodels
  - sdk/typescript/test/ui-kits
acceptance_command: "npm run typecheck && node --experimental-strip-types --test sdk/typescript/test/ui-kits/focus-ring*.test.ts sdk/typescript/test/ui-kits/focus-trap*.test.ts sdk/typescript/test/ui-kits/landmarks*.test.ts"
allowed_network: false
budget_minutes: 90
---

## Objective
Three headless, deterministic, pure **WAI-ARIA navigation view-models** for the flagship desktop, built with NO SDK port (pure interaction logic over injected plain data) — no DOM/rendering, no platform internals, no ambient I/O. These are the keyboard-accessibility primitives the CEF-rendered design binds to.
- **Roving-tabindex traversal** (`ui_kits/desktop/viewmodels/focus-ring.ts`): an ordered list of focusable ids + `orientation` (`horizontal` | `vertical` | `grid`). Key handling for Arrow keys, Tab, Home, End, PageUp/PageDown with `wrap` and disabled-item skipping; for `grid` orientation Arrow keys move across rows/columns by the configured column count. Invariant: **exactly one** item carries `tabindex=0` (the roving target) and all others `tabindex=-1` at all times. Actions: `moveNext()`, `movePrev()`, `moveFirst()`, `moveLast()`, `onKey(key)`, `setItems(ids, opts)`.
- **Focus-trap + restore** (`ui_kits/desktop/viewmodels/focus-trap.ts`): given an ordered set of focusable ids, Tab / Shift+Tab cycle **within** the trap (Tab past the last wraps to the first; Shift+Tab before the first wraps to the last). `activate()` sets initial focus (configured initial id or first focusable); `deactivate()` returns the stored restore target (the element focused at activation). Actions: `activate(opts)`, `deactivate()`, `onKey(key)`.
- **Skip-links / landmark navigation** (`ui_kits/desktop/viewmodels/landmarks.ts`): an ordered list of landmark regions (`banner` | `nav` | `main` | `complementary` | `contentinfo`), exposing the ordered landmark list for a skip-link menu plus `focusTarget(landmarkId)` returning the focus destination id for a chosen landmark.
- All three are pure reducers over injected plain data (ids/orientation/column-count/flags) — no SDK import is required; if any helper is needed import the SDK exactly as `ui_kits/desktop/package.ts` does and use ONLY public exports.

## User value
Gives the flagship desktop real, testable keyboard-accessibility behavior (roving focus, focus traps for dialogs/menus, and skip-link/landmark navigation) — the WAI-ARIA logic the rendered HTML hydrates against, decoupled from any renderer.

## Non-goals
- NO DOM/CSS/rendering/CEF; NO `document.activeElement` or real focus calls (the models compute the *intended* focus id only). NO platform internals, NO new visual design (the HTML is the design of record). NO new SDK port. Don't re-implement existing SDK ports — consume them if needed.

## Acceptance
`acceptance_command` passes. Deterministic unit tests cover, against plain injected data:
- **focus-ring**: traversal per orientation (`horizontal`/`vertical` Arrow + Tab/Home/End/PageUp/PageDown, and `grid` row/column movement by column count) including `wrap` at both ends and disabled-item skipping; the exactly-one-`tabindex=0` invariant holds after every transition.
- **focus-trap**: Tab cycles forward and wraps at the end; Shift+Tab cycles backward and wraps at the start; `activate()` lands on the configured initial (or first) focusable; `deactivate()` returns the restore target captured at activation.
- **landmarks**: the ordered landmark list and skip targets are correct; `focusTarget(landmarkId)` resolves the right destination.
- **fail-closed**: malformed or empty input (no items, unknown id, bad orientation, zero/negative column count, unknown landmark) fails closed (no focus change / defined empty result), never throws on hostile input.
Typecheck clean. Pure, headless, deterministic — same inputs produce byte-identical output.

## Security/constraints
- Pure/deterministic; injected plain data only (no ambient I/O, no DOM, no globals); fail-closed on malformed input. No remote imports; lockfile; no lifecycle scripts.

## Definition of done
- `ui_kits/desktop/viewmodels/focus-ring.ts`, `ui_kits/desktop/viewmodels/focus-trap.ts`, `ui_kits/desktop/viewmodels/landmarks.ts` + matching tests `sdk/typescript/test/ui-kits/focus-ring.test.ts`, `sdk/typescript/test/ui-kits/focus-trap.test.ts`, `sdk/typescript/test/ui-kits/landmarks.test.ts`, all deterministic and typecheck clean. R1.
