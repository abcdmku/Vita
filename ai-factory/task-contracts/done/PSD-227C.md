---
id: PSD-227C
title: Keyboard-operability audit harness for shell view-models
status: ready
phase: 6
pod: desktop
risk_class: R1
fr: []
depends_on: [PSD-021]
target_paths:
  - ui_kits/desktop/viewmodels
  - sdk/typescript/test/ui-kits
acceptance_command: "npm run typecheck && node --experimental-strip-types --test sdk/typescript/test/ui-kits/a11y-keyboard-audit*.test.ts"
allowed_network: false
budget_minutes: 90
---

## Objective
Deterministic, **test-only** keyboard-operability audit harness that drives each interactive shell
view-model — dock (`viewmodels/dock.ts`), command palette / search (`viewmodels/index.ts`,
`viewmodels/search.ts`), files (`viewmodels/files.ts`), tiling/window-management (`viewmodels/Tiling.ts`,
`viewmodels/window-snap.ts`), settings (`viewmodels/Settings.ts`), notifications (`viewmodels/Notifications.ts`) —
**purely via simulated key events**, asserting that every documented primary action is reachable
without any pointer input. This encodes "fully keyboard operable" as an executable invariant.
- The harness **consumes the existing view-models only** (their public methods/state) — it does NOT
  add features, DOM, rendering, or new SDK ports. It is a thin keyboard-driver + audit table: for each
  covered screen, a declared key sequence maps to each documented primary action, and the harness asserts
  the sequence reaches that action's state transition.
- A **pointer-only** action (one only reachable by a method that the keyboard map cannot trigger) must
  **fail** the audit — the negative case is part of the invariant, not an afterthought.
- Put the harness/driver code under `ui_kits/desktop/viewmodels/a11y-keyboard-audit.ts` and the test under
  `sdk/typescript/test/ui-kits/a11y-keyboard-audit.test.ts`.
- Import the SDK and view-models exactly as the existing view-models / tests do; use ONLY public exports.
  All view-model side effects go through their already-injected SDK ports (fake ports in tests), fail-closed
  if a grant is missing. Deterministic ordering and outcomes (same key sequence → byte-identical audit result).

## User value
Turns "is the desktop keyboard-operable?" from a manual claim into a regression-guarded, executable
invariant across the whole shell — every primary action is provably reachable without a mouse, and any
future view-model change that strands an action behind pointer-only access fails CI.

## Non-goals
- NO DOM/CSS/rendering/CEF, NO real key-event plumbing or focus DOM — simulate at the view-model API level.
- NO platform internals; NO new SDK ports or capabilities; do NOT re-implement or modify the audited
  view-models — consume them. NO new visual design (the HTML is the design of record).

## Acceptance
`acceptance_command` passes: for each covered screen (dock, palette/search, files, tiling, settings,
notifications) a declared key sequence deterministically reaches every documented primary action; a
deliberately pointer-only action fails the audit; the harness is pure and headless and runs against fake
SDK ports. Typecheck clean.

## Security/constraints
- Injected/fake ports only (no ambient I/O); capability-mediated, fail-closed; pure/deterministic.
- No remote imports; lockfile mandatory; no package lifecycle scripts; no FFI/native addons.

## Definition of done
- `ui_kits/desktop/viewmodels/a11y-keyboard-audit.ts` + `sdk/typescript/test/ui-kits/a11y-keyboard-audit.test.ts`,
  covering all six listed view-model surfaces, deterministic, pointer-only-fails-the-audit case included,
  typecheck clean. R1.
