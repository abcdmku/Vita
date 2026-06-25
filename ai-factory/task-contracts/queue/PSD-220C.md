---
id: PSD-220C
title: A11y preferences view-model (zoom/contrast/reduce-motion/text-scale on settings port)
status: ready
phase: 6
pod: desktop
risk_class: R1
fr: []
depends_on: [PSD-021]
target_paths:
  - ui_kits/desktop/viewmodels
  - sdk/typescript/test/ui-kits
acceptance_command: "npm run typecheck && node --experimental-strip-types --test sdk/typescript/test/ui-kits/a11y-prefs*.test.ts"
allowed_network: false
budget_minutes: 90
---

## Objective
Headless, deterministic **view-model** for the flagship desktop's accessibility preferences,
built ONLY on `@vita/desktop-sdk` public ports — the injected settings read/write port pair
(`DesktopHost["readSetting"]` / `DesktopHost["applySetting"]`), NO platform internals, NO DOM/rendering.
This mirrors the existing `ui_kits/desktop/viewmodels/theme.ts` pattern exactly (same port shape,
same fail-closed `readAppearanceSetting`/`writeAppearanceSetting` structure, same frozen-state +
result-discriminated-union conventions) — only the keys, value domain, and clamping differ. NO new port.
- State (frozen snapshot): `uiZoom` (number, 0.5–3.0, stepped to 0.05), `contrast` (`normal|high|higher`),
  `reduceMotion` (boolean), `reduceTransparency` (boolean), `textScale` (number, e.g. 0.8–2.0 stepped),
  `cursorSize` (number, clamped), `focusRingThickness` (number, clamped). All read on construction via
  `readSetting({ key })` under `accessibility.*` keys (e.g. `accessibility.uiZoom`,
  `accessibility.contrast`, `accessibility.reduceMotion`, `accessibility.reduceTransparency`,
  `accessibility.textScale`, `accessibility.cursorSize`, `accessibility.focusRingThickness`).
- Actions: `setUiZoom`, `setContrast`, `setReduceMotion`, `setReduceTransparency`, `setTextScale`,
  `setCursorSize`, `setFocusRingThickness`. Each validates/clamps the input (numeric prefs clamp to
  range + snap to step; enum prefs validate against the allowed set; booleans coerce only from real
  booleans), writes through `applySetting({ key, value })`, then re-freezes the snapshot. Out-of-range
  numbers, wrong types, or non-member enum values are rejected (fail-closed) and the prior snapshot is
  returned unchanged.
- **Fail-closed when the port is absent or denied** exactly like `theme.ts`: missing `readSetting` /
  `applySetting` → `SETTINGS_PORT_UNAVAILABLE`; thrown port → `SETTINGS_READ_FAILED` /
  `SETTINGS_WRITE_FAILED`; host `{ ok: false }` → reject from the host error. Construction fails closed
  if any required pref read is unsupported/out-of-domain.
- Put the code under `ui_kits/desktop/viewmodels/a11y-prefs.ts` and tests under
  `sdk/typescript/test/ui-kits/a11y-prefs.test.ts`. Import the SDK exactly as `theme.ts` /
  `ui_kits/desktop/package.ts` do; use ONLY public exports.
- This feeds later theming high-contrast / reduce-motion / zoom transforms — it is the headless
  source of truth those transforms read, so the snapshot must be a frozen, fully-typed value object.

## User value
Real, testable accessibility behavior on the SDK — zoom, contrast, reduce-motion, and text-scale
preferences that the CEF-rendered desktop and the theming layer hydrate against, with every value
clamped/validated and every settings access capability-mediated and fail-closed.

## Non-goals
- NO DOM/CSS/rendering/CEF. NO platform internals. NO new visual design. NO **new** SDK port (consume
  the existing settings read/write port pair). Do NOT re-implement SDK ports. Do NOT apply the
  high-contrast/reduce-motion CSS transforms here (that is a downstream theming slice) — only expose
  the validated preference snapshot.

## Acceptance
`acceptance_command` passes: deterministic unit tests against fake `readSetting`/`applySetting` ports
cover, for each preference: a clean read on construction; `setX` clamping numeric values to range and
snapping to step; `setX` validating enum/boolean values; out-of-range / non-string / non-member /
wrong-type inputs rejected with the prior snapshot returned unchanged; missing port, thrown port, and
host-denied results all fail closed with the documented codes; and that the returned snapshot is frozen
(`Object.isFrozen` true; mutation throws in strict mode). Typecheck clean. Pure, headless, deterministic.

## Security/constraints
- Injected ports only (no ambient I/O); capability-mediated, fail-closed; pure/deterministic (same
  inputs → identical snapshot). No remote imports; lockfile mandatory; no package lifecycle scripts;
  no FFI/native addons.

## Definition of done
- `ui_kits/desktop/viewmodels/a11y-prefs.ts` + `sdk/typescript/test/ui-kits/a11y-prefs.test.ts`,
  deterministic, mirrors the `theme.ts` port/fail-closed/frozen conventions, typecheck clean. R1.
