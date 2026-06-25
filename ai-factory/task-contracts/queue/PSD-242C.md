---
id: PSD-242C
title: Widget host model — placement, sizes, add/remove/reorder, refresh scheduling
status: ready
phase: 6
pod: desktop
risk_class: R1
fr: []
depends_on: [PSD-021]
target_paths:
  - ui_kits/desktop/viewmodels
  - sdk/typescript/test/ui-kits
acceptance_command: "npm run typecheck && node --experimental-strip-types --test sdk/typescript/test/ui-kits/widget-host*.test.ts"
allowed_network: false
budget_minutes: 90
---

## Objective
Headless, deterministic **widget host model** for the flagship desktop surface (the widget board the rendered design binds to later),
built ONLY on `@vita/desktop-sdk` public ports + a pure model — injected ports, NO platform internals, NO DOM/rendering, NO real timers/I-O.
- **Descriptor + instance contracts.** Define the `WidgetDescriptor` (kind: `clock`/`calendar`/`weather`/`system-stats`/`notes`/`recent-files`, allowed size classes, default refresh interval) and the `WidgetInstance` (id, kind, placement, size class `S`/`M`/`L`, `enabled`, `paused`, refresh interval). These are the contracts the per-widget data slices feed.
- **Placement.** A grid/zones model: instances occupy non-overlapping cells; `add(kind, at?)`, `remove(id)`, `move(id, at)`, `resize(id, sizeClass)`, `reorder(id, index)`. Placement is fail-closed: add/move/resize that would overlap or exceed bounds is rejected (returns an error result, state unchanged); reorder is stable.
- **Per-widget enabled/paused.** `setEnabled(id, bool)`, `setPaused(id, bool)`. A paused (or disabled) widget is excluded from the refresh due-set.
- **Deterministic refresh scheduler.** Per-widget interval; `tick(clockMs)` returns the set of instance ids whose next refresh is due at `clockMs` (no real timers — `clockMs` is injected by the caller). Determinism: same instances + same clock sequence → byte-identical due sets.
- Put the code under `ui_kits/desktop/viewmodels/widget-host.ts` and tests under `sdk/typescript/test/ui-kits/widget-host.test.ts`.
- Import the SDK exactly as `ui_kits/desktop/package.ts` does; use ONLY public exports from `@vita/desktop-sdk`.

## User value
Gives the static desktop widget board real, testable behavior — placement, sizing, add/remove/reorder, and a timer-free refresh scheduler — the logic the CEF-rendered HTML hydrates against and that the per-widget data slices plug into.

## Non-goals
- NO DOM/CSS/rendering/CEF. NO platform internals. NO real timers or wall-clock reads (clock is injected). NO actual widget data fetching (the per-widget slices own that; this is the host only). NO new visual design (the HTML is the design of record). Don't re-implement SDK ports — consume them.

## Acceptance
`acceptance_command` passes. Deterministic unit tests under `sdk/typescript/test/ui-kits/widget-host.test.ts` cover: add/move/resize/remove produce no overlap (overlapping/out-of-bounds ops are rejected, state unchanged); reorder is stable; `tick(clockMs)` returns the correct due set per interval across a clock sequence; paused and disabled widgets are excluded from the due set; the model is frozen (immutable transitions) and host-free (no DOM/timers/I-O). Typecheck clean. Pure, headless.

## Security/constraints
- Injected ports + injected clock only (no ambient I/O, no real timers); capability-mediated where ports are used; fail-closed on invalid placement; pure/deterministic. No remote imports; lockfile mandatory; no package lifecycle scripts.

## Definition of done
- `ui_kits/desktop/viewmodels/widget-host.ts` + `sdk/typescript/test/ui-kits/widget-host.test.ts`, deterministic, typecheck clean, frozen + host-free. R1.
