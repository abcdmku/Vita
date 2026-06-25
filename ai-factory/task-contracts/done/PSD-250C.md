---
id: PSD-250C
title: Surface accessibility & input model — focus-order/ARIA projection/hotkeys (pure)
status: ready
phase: 6
pod: desktop
risk_class: R1
fr: []
depends_on: [PSD-241C, PSD-242C, PSD-240C]
target_paths:
  - ui_kits/desktop/viewmodels/surface-a11y.ts
  - sdk/typescript/test/ui-kits
acceptance_command: "npm run typecheck && node --experimental-strip-types --test sdk/typescript/test/ui-kits/surface-a11y*.test.ts"
allowed_network: false
budget_minutes: 90
---

## Objective
Headless, deterministic **accessibility & input layer** for the flagship desktop surface, built ONLY
on `@vita/desktop-sdk` public ports and the existing surface view-models (icons PSD-241C, widgets
PSD-242C, context-menu PSD-240C) — pure projection over the surface VMs, NO DOM/rendering.
- **Deterministic focus order**: a stable, ordered traversal across surface regions
  `wallpaper → icons → widgets → menu → stage`. Tab/Shift-Tab walk the order; order is total and
  byte-identical for identical inputs (folders-first / label-stable ordering of icons matches the
  icon VM).
- **ARIA/role+label tree projection**: a pure projection of current surface state into an
  exported role/label tree (region roles, icon items with their labels + selected state, widget
  groups, menu items) — reflects current selection + icon labels. No DOM nodes; a plain serializable
  tree the rendered design binds to later.
- **Keyboard hotkeys → surface actions**: map `F2`→rename, `Enter`→open, `Delete`→trash,
  `Arrow{Up,Down,Left,Right}`→move selection within focus order, `⌘/Meta+drag`→copy (drag-copy
  intent). Each binding resolves to an explicit surface action/intent (no side effects executed here).
- **Reduced-motion flag**: derived from settings (Appearance/theme controller); **safe default**
  (reduced-motion OFF / motion allowed only when explicitly granted — fail-closed to the documented
  safe default when the settings grant is absent).
- Put the code under `ui_kits/desktop/viewmodels/surface-a11y.ts` and tests under
  `sdk/typescript/test/ui-kits/surface-a11y.test.ts`.
- Import the SDK exactly as the other `ui_kits/desktop/viewmodels/*.ts` do (relative
  `../../../sdk/typescript/src/desktop-sdk/index.ts`); use ONLY public exports. Consume the surface
  VMs (icons/widgets/context-menu) as the source of state — do not re-derive their logic.

## User value
Makes the desktop surface keyboard-navigable and screen-reader-describable as pure, testable logic
on the SDK — the a11y/input contract the CEF-rendered HTML hydrates against, so accessibility is a
designed-in property of the surface rather than after-the-fact polish.

## Non-goals
- NO DOM/CSS/rendering/CEF; NO real ARIA attribute emission (only the serializable projection tree).
- NO platform internals; NO new visual design (the HTML is the design of record).
- Do NOT re-implement the icon/widget/context-menu VMs or any SDK port — consume them.
- Do NOT execute the resolved actions (rename/open/trash/copy) — only produce the intents.

## Acceptance
`acceptance_command` passes. Deterministic unit tests (node `--test`, `--experimental-strip-types`)
cover, against fake SDK ports + the surface VMs:
- Tab order is deterministic and total across all regions (`wallpaper → icons → widgets → menu →
  stage`); Tab/Shift-Tab traversal is stable and reversible.
- The role/label projection tree matches current selection + icon labels (changes when selection or
  labels change; stable otherwise).
- `F2`/`Enter`/`Delete`/`Arrow*` and `⌘/Meta+drag` each resolve to the expected surface action/intent.
- Reduced-motion reflects settings when the grant is present and falls back to the documented safe
  default when the grant is absent.
Typecheck clean. Pure, headless, no I/O.

## Security/constraints
- Injected ports only (no ambient I/O); capability-mediated, **fail-closed** (safe default when a
  grant is missing); pure/deterministic (same inputs → byte-identical projection + ordering).
- No remote imports; lockfile mandatory; no package lifecycle scripts; no DOM/FFI/native.

## Rollback plan
Single isolated module + test under `viewmodels/` and `test/ui-kits/`; revert by deleting
`ui_kits/desktop/viewmodels/surface-a11y.ts` and `sdk/typescript/test/ui-kits/surface-a11y.test.ts`
(no other files import it yet). No schema/migration impact.

## Definition of done
- `ui_kits/desktop/viewmodels/surface-a11y.ts` + `sdk/typescript/test/ui-kits/surface-a11y.test.ts`,
  deterministic, typecheck clean, pure/headless. R1.
