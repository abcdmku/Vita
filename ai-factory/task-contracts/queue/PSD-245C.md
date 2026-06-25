---
id: PSD-245C
title: Desktop wallpaper view-model on the settings control-plane port
status: ready
phase: 6
pod: desktop
risk_class: R1
fr: []
depends_on: [PSD-021]
target_paths:
  - ui_kits/desktop/viewmodels
  - sdk/typescript/test/ui-kits
acceptance_command: "npm run typecheck && node --experimental-strip-types --test sdk/typescript/test/ui-kits/wallpaper*.test.ts"
allowed_network: false
budget_minutes: 90
---

## Objective
Headless, deterministic **view-model** for the flagship desktop's wallpaper/appearance surface,
built ONLY on `@vita/desktop-sdk` public ports — the settings control-plane port
(`SettingsControlPlanePort` + `requestSettingsPreview`/`requestSettingsApply`/`settleSettingsControlPlaneResult`,
`SettingsValue`) — injected ports, NO platform internals, NO DOM/rendering (the view-model is the
pure interaction logic the rendered design binds to later).
- State (all read from / written through the settings control-plane, never ambient I/O): current
  wallpaper source ref, fit mode (`fill` | `fit` | `stretch` | `center` | `tile`), solid-color
  fallback, a per-workspace override map (workspaceId → wallpaper ref/fit), and a deterministic
  slideshow (ordered source list + interval; `advance(clock)` is **pure given an injected clock** —
  same list+interval+now → byte-identical next index/source).
- Resolution: the active workspace's override wins over the global wallpaper; with no source and no
  override the solid-color fallback resolves. Ordering of the override map and slideshow list is
  deterministic (insertion/explicit order, stable across reads).
- Actions: `setWallpaper(ref)`, `setFit(mode)`, `setForWorkspace(workspaceId, ref/fit)` — each is
  **preview-then-apply** via the control-plane (emit a preview intent, then an apply intent;
  reconcile the result before committing local state). `advance()` rotates the slideshow source.
- **Fail-closed:** without the `settings.write` grant, every mutating action is a no-op that leaves
  state byte-identical (reads still work; the design later reflects a disabled/locked control).
- Put the code under `ui_kits/desktop/viewmodels/wallpaper.ts` and tests under
  `sdk/typescript/test/ui-kits/wallpaper.test.ts`.
- Import the SDK exactly as `ui_kits/desktop/package.ts` does; use ONLY public exports.
- Reconcile with the theming wallpaper VM (PSD-229B) and per-workspace appearance (PSD-142): share
  the wallpaper-ref/fit shape and per-workspace override semantics rather than redefining them —
  this slice owns the settings-port read/write + slideshow; do not duplicate theming logic.

## User value
Turns the static wallpaper/appearance design into real, testable desktop behavior on the SDK — the
preview-then-apply logic and deterministic slideshow the CEF-rendered HTML hydrates against, with
correct fail-closed behavior when the settings write grant is absent.

## Non-goals
- NO DOM/CSS/rendering/CEF. NO platform internals. NO new visual design (the HTML is the design of
  record). NO real image decoding/file reads — wallpaper sources are opaque refs. Don't re-implement
  the settings control-plane or theming ports — consume them.

## Acceptance
`acceptance_command` passes: deterministic unit tests cover, against fake SDK settings-control-plane
ports — read seeds current source + fit; `setFit` emits preview then apply and only then updates
state; `setForWorkspace` stores an override resolved by the active workspace (override wins over
global); `advance()` rotates the slideshow deterministically given an injected clock; and a missing
`settings.write` grant leaves state byte-identical (fail-closed). Typecheck clean. Pure, headless.

## Security/constraints
- Injected ports only (no ambient I/O); capability-mediated, fail-closed on missing `settings.write`;
  pure/deterministic (slideshow advance is pure given the injected clock). No remote imports;
  lockfile; no lifecycle scripts.

## Definition of done
- `ui_kits/desktop/viewmodels/wallpaper.ts` + `sdk/typescript/test/ui-kits/wallpaper.test.ts`,
  deterministic, typecheck clean, fail-closed verified. R1.
