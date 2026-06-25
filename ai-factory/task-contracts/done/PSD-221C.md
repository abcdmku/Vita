---
id: PSD-221C
title: A11y CSS-variable derivation + reduce-motion + zoom/text-scale policy
status: ready
phase: 6
pod: desktop
risk_class: R1
fr: []
depends_on: [PSD-220C]
target_paths:
  - ui_kits/desktop/viewmodels
  - sdk/typescript/test/ui-kits
acceptance_command: "npm run typecheck && node --experimental-strip-types --test sdk/typescript/test/ui-kits/a11y-tokens*.test.ts sdk/typescript/test/ui-kits/zoom-policy*.test.ts"
allowed_network: false
budget_minutes: 90
---

## Objective
Two **pure, headless** accessibility modules for the flagship desktop — no SDK port, no DOM/rendering, no platform internals (the pure functions the CEF-rendered HTML binds its root element + token sheet against). They consume the `a11y-prefs` produced by PSD-220C and the SDK theme tokens (`themeTokens`/`themeVar` from `@vita/desktop-sdk`) and emit deterministic, frozen outputs.

- **`ui_kits/desktop/viewmodels/a11y-tokens.ts`** — turn an `a11y-prefs` state into root CSS custom properties (`--ui-zoom`, `--text-scale`, `--focus-ring-width`, `--cursor-size`) plus a set of screen/root classes (`contrast-high`, `reduce-motion`, `reduce-transparency`), and a high-contrast token remap that rewrites the affected theme tokens to AA-safe values. Output: `{ cssVars: Readonly<Record<string,string>>, screenClasses: readonly string[], tokenOverrides: Readonly<Record<string,string>> }`, all frozen.
- **`ui_kits/desktop/viewmodels/zoom-policy.ts`** — convert `uiZoom` / `textScale` into a bounded `{ rootScale, controlMin, density }` that enforces WCAG 1.4.4 (text resizable to 200% without loss) and clamps each input to its allowed range. A control-size floor is preserved so interactive targets never collapse below the minimum.
- Both modules are pure and deterministic (no port, no ambient I/O, no clock/random). NaN / out-of-range / missing inputs resolve to documented safe defaults. Outputs are byte-stable for a given input. (Composes with the theming transforms in PSD-222B — do NOT duplicate that work here.)
- Import the SDK exactly as `ui_kits/desktop/package.ts` does; use ONLY public exports.
- Put tests under `sdk/typescript/test/ui-kits/a11y-tokens.test.ts` and `sdk/typescript/test/ui-kits/zoom-policy.test.ts`.

## User value
Gives the desktop real, testable accessibility behavior — high-contrast, reduced motion/transparency, and zoom/text-scaling that meets WCAG — as pure logic the rendered shell hydrates against, instead of static CSS guesses.

## Non-goals
- NO DOM/CSS application/CEF; NO platform internals; NO new visual design (the HTML/token CSS is the design of record). Don't re-implement the theming transforms (PSD-222B) or the prefs reducer (PSD-220C) — consume them. No new SDK ports.

## Acceptance
`acceptance_command` passes on Windows: deterministic unit tests cover, for `a11y-tokens`: each prefs state → exact frozen `{ cssVars, screenClasses, tokenOverrides }`; high-contrast mapping covers the full affected token set; `reduce-motion` zeroes motion durations; and for `zoom-policy`: `uiZoom`/`textScale` clamp to range, 200% text is reachable, the control-size floor holds, NaN → safe default, and output is byte-stable across repeated calls. Typecheck clean. Pure, headless.

## Security/constraints
- Pure/deterministic, no ambient I/O, no port; no remote imports; lockfile mandatory; no lifecycle scripts. Consume SDK only via public exports.

## Definition of done
- `ui_kits/desktop/viewmodels/a11y-tokens.ts` + `ui_kits/desktop/viewmodels/zoom-policy.ts`, with `sdk/typescript/test/ui-kits/a11y-tokens.test.ts` + `sdk/typescript/test/ui-kits/zoom-policy.test.ts`, deterministic, frozen outputs, typecheck clean. R1.
