---
id: PSD-241C
title: Desktop-icons model — grid/free layout, selection, marquee, rename, auto-arrange
status: ready
phase: 6
pod: desktop
risk_class: R1
fr: []
depends_on: [PSD-021]
target_paths:
  - ui_kits/desktop/viewmodels
  - sdk/typescript/test/ui-kits
acceptance_command: "npm run typecheck && node --experimental-strip-types --test sdk/typescript/test/ui-kits/desktop-icons*.test.ts"
allowed_network: false
budget_minutes: 90
---

## Objective
Headless, deterministic **view-model** for the icons that sit on the desktop background of the flagship shell,
built ONLY on `@vita/desktop-sdk` public ports + surface model (injected ports, NO platform internals, NO DOM/rendering).
This slice is **geometry + selection math only** — the icon *contents* (ids/labels/kinds backed by a real directory)
arrive from a separate ports-backed slice; here we model placement, selection, and editing of a given icon set.
- State: an icon set where each icon is `{ id, label, kind, iconRef, position: { x, y } }`; a placement mode of `grid` (snapped cells) vs `free` (arbitrary px); a selection set; an optional in-flight marquee rect; an optional inline-rename draft.
- Actions: `setIcons(icons)`, `setMode('grid'|'free')`, single/multi/range **selection** (`select(id)`, `toggle(id)` for ctrl, `extendTo(id)` for shift/range), **marquee** (`beginMarquee(pt)`/`updateMarquee(pt)`/`endMarquee()` selecting every icon whose cell/box overlaps the rubber-band rect), **drag-move** (`beginDrag`/`moveBy(dx,dy)`/`endDrag()` with grid snap that resolves collisions so no two icons share a grid cell), inline **rename** (`beginRename(id)`/`commitRename(label)` validated — reject empty/whitespace-only and duplicate labels — no I/O), and **auto-arrange** + **sortBy('name'|'kind'|'date'|'size')** producing a deterministic, stable left-to-right / top-to-bottom layout.
- Geometry: pure functions over a configurable grid (cell size, origin, gutter) — marquee hit-testing, grid-cell <-> pixel conversion, collision-free snapping. Same inputs → byte-identical layout.
- Put the code under `ui_kits/desktop/viewmodels/desktop-icons.ts` and tests under `sdk/typescript/test/ui-kits/desktop-icons.test.ts`.
- Import the SDK exactly as `ui_kits/desktop/viewmodels/files.ts` / `ui_kits/desktop/package.ts` do; use ONLY public exports (no platform internals).

## User value
Gives the flagship desktop real, testable icon behavior (select / marquee / drag-snap / rename / auto-arrange) as pure interaction logic the CEF-rendered background binds to later — without coupling to any directory source or the DOM.

## Non-goals
- NO DOM/CSS/rendering/CEF. NO platform internals or ambient I/O. NO directory reads — icon contents are supplied by the caller / a ports-backed slice (out of scope here). Don't re-implement SDK ports — consume them. No new visual design (the HTML is the design of record).

## Acceptance
`acceptance_command` passes. Deterministic unit tests against fake SDK ports / supplied icon sets cover: marquee selects icons overlapping the rect (and only those); shift extends a contiguous range and ctrl toggles individual icons; drag-move snaps to grid and never produces two icons in one cell; auto-arrange + each `sortBy` key yields a stable, repeatable layout (byte-identical across runs); `commitRename` rejects empty/whitespace-only and duplicate labels and accepts a valid unique label; and no host/port I/O is triggered by any geometry/selection action. Typecheck clean; pure, headless.

## Security/constraints
- Injected ports only (no ambient I/O); capability-mediated, fail-closed; pure/deterministic (same inputs → byte-identical layout). No remote imports; lockfile mandatory; no package lifecycle scripts; no FFI/native addons.

## Hardware profiles
- None (pure TS view-model; runs under `node --experimental-strip-types`, no device dependency).

## Allowed tools + network
- Local toolchain only (npm typecheck + node test runner). `allowed_network: false`.

## Compute/time budget
- `budget_minutes: 90`.

## Required artifacts
- `ui_kits/desktop/viewmodels/desktop-icons.ts` (the view-model + pure geometry helpers).
- `sdk/typescript/test/ui-kits/desktop-icons.test.ts` (deterministic tests covering the cases above).

## Rollback plan
- Revert the `task/PSD-241C` branch; both files are additive (new view-model + new test), so removal restores prior state with no other code depending on them.

## Definition of done
- `ui_kits/desktop/viewmodels/desktop-icons.ts` + `sdk/typescript/test/ui-kits/desktop-icons.test.ts` land, deterministic, typecheck clean, acceptance command green on Windows. Pure, headless, ports-injected. R1.
