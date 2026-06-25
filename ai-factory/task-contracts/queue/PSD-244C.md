---
id: PSD-244C
title: Desktop-surface context-menu actions — wire surface menu verbs to host
status: ready
phase: 6
pod: desktop
risk_class: R1
fr: []
depends_on: [PSD-021]
target_paths:
  - ui_kits/desktop/viewmodels
  - sdk/typescript/test/ui-kits
acceptance_command: "npm run typecheck && node --experimental-strip-types --test sdk/typescript/test/ui-kits/SurfaceMenu*.test.ts"
allowed_network: false
budget_minutes: 90
---

## Objective
Headless, deterministic **view-model** that produces the flagship desktop's **background right-click
context menu** and resolves each menu verb against `@vita/desktop-sdk` public host ports — built on
the existing context-menu model plus the files / settings / launcher ports. Injected ports only, NO
platform internals, NO DOM/rendering (pure interaction logic the rendered design binds to later).
- **Menu shape:** produce the desktop surface menu items via the context-menu model — `New Folder`,
  `Paste`, `Change Wallpaper…`, `Sort by`, `Show desktop icons`, `Display Settings`, `Refresh`.
- **Verb resolution (against injected ports):**
  - `New Folder` + `Paste` → **files port** (`FilesRequest`/`FilesResponse`): create / paste at the
    desktop path (e.g. `mkdir`, clipboard paste); `Paste` is present only when a clipboard payload exists.
  - `Change Wallpaper…` + `Sort by` + `Show desktop icons` → **settings port**
    (`requestSettingsPreview` / `requestSettingsApply`) — preview then apply the wallpaper / sort /
    icon-visibility config edits.
  - `Display Settings` → **launcher intent** (`DesktopLauncherIntent`) — emit the intent to open the
    display-settings surface; do not mutate config directly.
  - `Refresh` → **local** — re-emit current surface state; no host call.
- **Capability gating + fail-closed:** each item is capability-gated; when the backing grant/port is
  **missing or `undefined`** the item is **absent or disabled** (never silently no-ops) and any
  attempted resolve returns a **frozen denied result** (e.g. `{ ok: false, reason: "forbidden" }`,
  `Object.freeze`d) rather than calling an absent port. All emitted intents/results are **frozen**.
- Put the code under `ui_kits/desktop/viewmodels/SurfaceMenu.ts` and tests under
  `sdk/typescript/test/ui-kits/SurfaceMenu.test.ts`.
- Import the SDK exactly as the sibling view-models do
  (`../../../sdk/typescript/src/desktop-sdk/index.ts`, public exports only); use ONLY public exports.

## User value
Turns the static desktop background into a real, testable right-click menu wired to host capabilities
(files, settings, launcher) — the logic the CEF-rendered desktop surface hydrates against, with
capability gating that fails closed.

## Non-goals
- NO DOM/CSS/rendering/CEF. NO platform internals. NO new visual design (the HTML is the design of
  record). Don't re-implement the SDK ports or the context-menu model — consume them. No icon
  layout/positioning engine; no actual wallpaper image I/O (settings preview/apply only).

## Acceptance
`acceptance_command` passes against fake injected SDK ports: deterministic unit tests cover the
menu-build + verb-resolution + fail-closed paths described above; typecheck clean. Pure, headless.

## Security/constraints
- Injected ports only (no ambient I/O); capability-mediated, **fail-closed** (item absent/disabled +
  frozen denied result when grant/port missing); all emitted intents/results `Object.freeze`d;
  pure/deterministic (same inputs → same menu + same intents). No remote imports; lockfile; no
  package lifecycle scripts.

## Hardware profiles
- Portable-first; pure TS view-model, no hardware-specific paths.

## Allowed tools + network
- Standard repo TS toolchain (tsc, node --test). `allowed_network: false`.

## Compute/time budget
- `budget_minutes: 90`.

## Required artifacts
- `ui_kits/desktop/viewmodels/SurfaceMenu.ts`
- `sdk/typescript/test/ui-kits/SurfaceMenu.test.ts`

## Rollback plan
- Single task branch `task/PSD-244C`; revert the merge commit. No schema/state migrations; additive
  view-model only.

## Definition of done
- `ui_kits/desktop/viewmodels/SurfaceMenu.ts` + `sdk/typescript/test/ui-kits/SurfaceMenu.test.ts`:
  tests assert (1) items whose grant is absent are hidden/disabled; (2) `New Folder` → files create
  at the desktop path; (3) `Change Wallpaper…`/`Sort by`/`Show desktop icons` → settings
  preview/apply edits; (4) `Display Settings` → launcher intent; (5) resolving with an `undefined`
  port returns a frozen denied result; (6) `Refresh` is local. Deterministic, frozen intents,
  typecheck clean. R1.
