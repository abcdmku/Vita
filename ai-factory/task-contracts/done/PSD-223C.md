---
id: PSD-223C
title: Binder ARIA-state sink + ARIA role/name descriptor model
status: ready
phase: 6
pod: desktop
risk_class: R1
fr: []
depends_on: [PSD-021]
target_paths:
  - ui_kits/desktop/runtime/binder.ts
  - ui_kits/desktop/viewmodels
  - sdk/typescript/test/ui-kits
acceptance_command: "npm run typecheck && node --experimental-strip-types --test sdk/typescript/test/ui-kits/binder-aria*.test.ts sdk/typescript/test/ui-kits/aria-model*.test.ts"
allowed_network: false
budget_minutes: 90
---

## Objective
Two merged, headless, deterministic accessibility pieces on the existing ADR-0013 binder runtime (`ui_kits/desktop/runtime/binder.ts`) and the flagship desktop view-models — injected ports / DOM stubs only, NO platform internals, NO real DOM/rendering. This is the pure interaction logic the CEF-rendered design binds to later.

1. **ARIA-state sink family on the binder.** Extend the binder's bind-sink set with a `data-vita-bind-aria-<state>` family covering the WAI-ARIA states `aria-expanded`, `aria-selected`, `aria-checked`, `aria-current`, `aria-disabled`, `aria-pressed`, and `aria-hidden`. Each sink reads a bind id (resolved exactly like the existing text/class/attr sinks via the bind map / snapshot field), writes the corresponding `aria-*` attribute as a boolean (`"true"`/`"false"`) for the boolean-typed states or as the resolved enum token for token-typed states (`aria-current`, `aria-checked` mixed/tri-state), and is **write-if-changed** (no write when the attribute already equals the resolved value — mirror the existing `applyAttrTarget`/`applyTextTarget` discipline). Sinks **ignore unbound** elements (no dataset key → not captured) and **fail-closed** (malformed spec, missing resolver, or a throwing DOM op is swallowed, never a partial/garbage write). Capture these the same way `captureAttrTargets` works (root + `querySelectorAll`, frozen targets); reflect them in `applyBindSinks` so a single `render(snapshot)` drives them.
2. **Per-screen ARIA role/name descriptor model.** Add a pure `aria-model.ts` (one per flagship screen, under `ui_kits/desktop/viewmodels/`) that derives, from each screen's view-model state, the accessible role/name/relationship descriptors the sink applies: `role`, accessible name (`aria-label` or `aria-labelledby`), grouping/structure descriptors (`group`/`listbox`/`menu`), and `aria-activedescendant` for the active item in listbox/menu structures. Deterministic, pure functions `State -> AriaDescriptorSet`; no I/O, no DOM. The descriptor set is the contract the binder's aria sinks + attr sinks consume.

- Put the binder changes in `ui_kits/desktop/runtime/binder.ts`, the descriptor model in `ui_kits/desktop/viewmodels/aria-model.ts`, and tests under `sdk/typescript/test/ui-kits/binder-aria.test.ts` + `sdk/typescript/test/ui-kits/aria-model.test.ts`.
- Reuse the binder's existing `VitaElement` DOM-stub interface and bind-resolution helpers; import the SDK exactly as the other `ui_kits/desktop` modules do; use ONLY public exports.

## User value
Makes the flagship desktop screens screen-reader-correct by construction: ARIA state stays in lockstep with view-model state through the same declarative binder the visuals already use, and each screen's role/name/relationship structure is a tested pure derivation rather than hand-maintained markup.

## Non-goals
- NO real DOM/CSS/rendering/CEF. NO platform internals. NO new visual design (the HTML is the design of record). Do not re-implement SDK ports — consume them. No focus management / live-region timing (state reflection only).

## Acceptance
`acceptance_command` passes: deterministic unit tests against the `VitaElement` DOM stub prove each aria sink writes `true`/`false`/token and removes/leaves the attribute correctly; write-if-changed (no redundant write); unbound elements untouched; malformed specs fail-closed (no partial write); and, for the descriptor model, each screen's state maps to the expected role/name/`aria-activedescendant` set, including listbox/menu group relationships. Typecheck clean. Pure, headless.

## Security/constraints
- Injected ports / DOM stubs only (no ambient I/O); capability-mediated upstream, fail-closed; pure/deterministic (same snapshot → byte-identical attribute writes). No remote imports; lockfile; no lifecycle scripts.

## Definition of done
- `ui_kits/desktop/runtime/binder.ts` (aria-state sink family) + `ui_kits/desktop/viewmodels/aria-model.ts` + `sdk/typescript/test/ui-kits/binder-aria.test.ts` + `sdk/typescript/test/ui-kits/aria-model.test.ts`, deterministic, typecheck clean. R1.
