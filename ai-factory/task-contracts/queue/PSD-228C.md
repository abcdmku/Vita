---
id: PSD-228C
title: Accessibility hydration manifest — wire a11y view-models into the runtime
status: ready
phase: 6
pod: desktop
risk_class: R1
fr: []
depends_on: [PSD-021, PSD-220C, PSD-222C, PSD-223C, PSD-224C]
target_paths:
  - ui_kits/desktop
  - sdk/typescript/test/ui-kits
acceptance_command: "npm run typecheck && node --experimental-strip-types --test sdk/typescript/test/ui-kits/screens-a11y*.test.ts"
allowed_network: false
budget_minutes: 100
---

## Objective
Per **architecture/adr/0013-desktop-hydration.md**: a `ui_kits/desktop/screens/accessibility.ts` manifest + `data-vita-*`
anchors on Settings/Shell/Lock that wire the MERGED a11y view-models — a11y-prefs (PSD-220C), focus-ring/focus-trap/landmarks
(PSD-222C), aria sink + aria-model (PSD-223C), and the announcer (PSD-224C) — into the hydration runtime
(selectPorts/createViewModel/actions/binds), so key events drive a11y state and state reflects to ARIA / CSS-var / class
sinks. Imports ONLY `@vita/desktop-sdk` + the view-models; inert without a bridge; dispose idempotent.

## User value
Makes the accessibility layer LIVE in the desktop — keyboard navigation, focus management, ARIA, and announcements actually
driven by the rendered screens (not just headless logic).

## Non-goals
- NO new view-model logic (wire the existing ones). NO platform internals. NO real DOM (DOM-stub tests). Don't change the design visuals.

## Acceptance
`acceptance_command` passes (DOM stub): hydrate binds the a11y actions/sinks; key events drive focus-ring/trap; a pref
change reflects CSS vars + classes; an announce fires; inert-without-bridge; dispose idempotent. Typecheck clean. R1.

## Security/constraints
- `@vita/desktop-sdk` types only; fail-closed, per-screen isolation, inert-on-failure. No remote imports; lockfile; no lifecycle scripts.

## Definition of done
- `ui_kits/desktop/screens/accessibility.ts` + anchors + `sdk/typescript/test/ui-kits/screens-a11y.test.ts`; deterministic; typecheck clean. R1.
