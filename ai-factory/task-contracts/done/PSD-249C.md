---
id: PSD-249C
title: Multi-monitor surface model — per-display wallpaper/icons/widgets + deterministic reflow
status: ready
phase: 6
pod: desktop
risk_class: R1
fr: []
depends_on: [PSD-241C, PSD-242C, PSD-245C]
target_paths:
  - ui_kits/desktop/viewmodels
  - sdk/typescript/test/ui-kits
acceptance_command: "npm run typecheck && node --experimental-strip-types --test sdk/typescript/test/ui-kits/multi-monitor*.test.ts"
allowed_network: false
budget_minutes: 90
---

## Objective
Headless, deterministic **multi-monitor surface model** for the flagship desktop, built ONLY on `@vita/desktop-sdk` public ports + the existing surface models (injected ports, NO platform internals, NO DOM/rendering). Extends the single-surface model to a set of displays whose geometry is **injected from the host** — the model owns the cross-display bookkeeping, not the rendering.
- State: a deterministic **display set** where each display is `{ id, bounds: { x, y, w, h }, scale, primary }` (injected from host geometry, ordered deterministically — primary first, then by `bounds.x`/`bounds.y`/`id`); per-display **wallpaper** (independent ref per display); per-display **icon ownership** (each desktop icon, reusing the PSD-241C icons model, belongs to exactly one display); per-display **widget zones** (reusing the widgets model, PSD-245C); and a mapping from a point or a WM window rect to its **owning display**.
- Actions: `setDisplays(displays)` (apply a new host-injected display set), `setWallpaper(displayId, ref)`, `assignIcon(iconId, displayId)` / `assignWidget(widgetId, displayId)`, `displayForPoint(pt)` and `displayForWindow(rect)` (owning display by max-overlap, ties resolved deterministically toward the primary then lowest `id`). When the display set **changes**: on **removal**, migrate the removed display's icons and widgets to the **primary** display (deterministic reflow via the icons/widgets layout math — no two icons share a cell); on **re-add**, restore ownership to the re-added display **where deterministic** (icons whose remembered home id returns); same display set in → byte-identical ownership + layout out.
- Reuses existing models: consume the PSD-241C desktop-icons model + PSD-245C widgets model + PSD-242C wallpaper/surface models via their public surface; do NOT re-implement them. Window rects come from the SDK WM types (`Rect`/`WindowModel`).
- Put the code under `ui_kits/desktop/viewmodels/multi-monitor.ts` and tests under `sdk/typescript/test/ui-kits/multi-monitor.test.ts`.
- Import the SDK exactly as `ui_kits/desktop/viewmodels/files.ts` / `ui_kits/desktop/package.ts` do; use ONLY public exports (no platform internals).

## User value
Gives the flagship desktop real, testable multi-monitor behavior — per-display wallpaper, icon/widget ownership, window-to-display mapping, and deterministic reflow when monitors are plugged/unplugged — as pure interaction logic the CEF-rendered shell binds to later, without coupling to host geometry APIs or the DOM.

## Non-goals
- NO DOM/CSS/rendering/CEF. NO platform internals or ambient I/O. NO real display enumeration / hotplug detection — the display set is host-injected (out of scope here). Don't re-implement the icons/widgets/wallpaper models — consume them. No new visual design (the HTML is the design of record).

## Acceptance
`acceptance_command` passes. Deterministic unit tests against fake SDK ports + injected display sets cover: `displayForPoint`/`displayForWindow` return the correct owning display (including a window straddling two displays → max-overlap winner, tie → primary then lowest id); **removing** a display migrates its icons and widgets onto the **primary** display with a collision-free, byte-identical reflow; per-display **wallpaper** is independent (changing one display's wallpaper leaves others untouched); WM window rects map to the owning display; **re-adding** a previously-removed display restores ownership where deterministic; and no host/port I/O is triggered by any mapping/assignment action. Typecheck clean; pure, headless.

## Security/constraints
- Injected ports + injected display geometry only (no ambient I/O, no display enumeration); capability-mediated, fail-closed; pure/deterministic (same display set + inputs → byte-identical ownership + layout). No remote imports; lockfile mandatory; no package lifecycle scripts; no FFI/native addons.

## Hardware profiles
- None (pure TS view-model; runs under `node --experimental-strip-types`, no device dependency — display geometry is injected, not probed).

## Allowed tools + network
- Local toolchain only (npm typecheck + node test runner). `allowed_network: false`.

## Compute/time budget
- `budget_minutes: 90`.

## Required artifacts
- `ui_kits/desktop/viewmodels/multi-monitor.ts` (the multi-monitor surface model: display set, per-display wallpaper/icon/widget ownership, point/window→display mapping, deterministic reflow on display-set change).
- `sdk/typescript/test/ui-kits/multi-monitor.test.ts` (deterministic tests covering the cases above).

## Rollback plan
- Revert the `task/PSD-249C` branch; both files are additive (new view-model + new test) and consume existing models, so removal restores prior state with no other code depending on them.

## Definition of done
- `ui_kits/desktop/viewmodels/multi-monitor.ts` + `sdk/typescript/test/ui-kits/multi-monitor.test.ts` land, deterministic, typecheck clean, acceptance command green on Windows. Pure, headless, ports-injected, reuses the PSD-241C/PSD-242C/PSD-245C models. R1.
