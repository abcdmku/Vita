---
id: PSD-265C
title: Hydration binding — global key listener → shortcuts dispatch
status: ready
phase: 6
pod: desktop
risk_class: R1
fr: []
depends_on: [PSD-021]
target_paths:
  - ui_kits/desktop/runtime
  - ui_kits/desktop/viewmodels
  - sdk/typescript/test/ui-kits
acceptance_command: "npm run typecheck && node --experimental-strip-types --test sdk/typescript/test/ui-kits/ShortcutsBinding*.test.ts"
allowed_network: false
budget_minutes: 90
---

## Objective
Per-screen **ADR-0013 hydration binding** that wires a single delegated `keydown` listener on the
shortcuts screen root to the existing global-input shortcuts view-model
(`ui_kits/desktop/viewmodels/shortcuts.ts`, the VM tested by PSD-260C) — built ONLY on the DOM-stub
binder pattern in `ui_kits/desktop/runtime/binder.ts` and `@vita/desktop-sdk` public ports (injected;
NO platform internals, NO real browser DOM). This is the manifest + anchors layer that binds the
already-headless shortcuts logic to the rendered design.
- **Manifest + anchors**: declare an ADR-0013 per-screen binding manifest for the shortcuts screen that
  attaches one delegated `keydown` listener to the screen root anchor (event delegation — no
  per-element listeners) and reflects active-binding hints back through `bind` sinks.
- **Pipeline** on each `keydown`: `normalize` the event into a chord (key + modifier set) →
  `resolve` the chord against the VM's bound chords → `dispatch` the resolved action through the VM.
- **Editable-target suppression**: when the event target is editable (`<input>`, `<textarea>`,
  `contenteditable`), suppress **single-key** chords (no bare letter/key chords while the user is
  typing); modified chords still resolve. Determine editability from the stub target's tag/attrs only
  (no real DOM APIs).
- **preventDefault discipline**: call `preventDefault()` **only** when a chord matches a bound action;
  never on unmatched keystrokes (so unbound keys pass through to the app).
- **Error routing**: when the VM returns `{ ok: false }`, route the error to the binding's error sink;
  do NOT throw and do NOT swallow.
- Put the binding under `ui_kits/desktop/runtime/shortcuts-binding.ts` and tests under
  `sdk/typescript/test/ui-kits/ShortcutsBinding.test.ts`.
- Import the SDK / VM / binder exactly as the existing `ui_kits/desktop/runtime/binder.ts` and the
  shortcuts VM do; use ONLY public exports.

## User value
Turns the static shortcuts mockup into live keyboard behavior: a real, testable global key listener
that drives the shortcuts VM and respects typing context — the hydration layer the CEF-rendered HTML
binds against at runtime.

## Non-goals
- NO real browser DOM / CSS / CEF / rendering. NO platform internals. NO new visual design (the HTML
  is the design of record). Don't re-implement the shortcuts VM or the binder — consume them. NO new
  chord/keymap logic beyond normalize/resolve over what the VM already exposes.

## Acceptance
`acceptance_command` passes against the DOM stub: deterministic unit tests assert (1) a matched chord
`keydown` dispatches the bound action through the VM; (2) a single-key chord is suppressed when the
target is editable (`input`/`textarea`/`contenteditable`) while a modified chord still resolves;
(3) `preventDefault()` is called only when a chord matches and never on unmatched keys; (4) a VM
`{ ok: false }` result is routed to the error sink. Typecheck clean. Pure, headless.

## Security/constraints
- Injected ports + DOM-stub only (no ambient I/O, no real `window`/`document`); capability-mediated,
  fail-closed; pure/deterministic given the same event sequence. No remote imports; lockfile; no
  lifecycle scripts.

## Definition of done
- `ui_kits/desktop/runtime/shortcuts-binding.ts` + `sdk/typescript/test/ui-kits/ShortcutsBinding.test.ts`,
  deterministic, typecheck clean. R1.
