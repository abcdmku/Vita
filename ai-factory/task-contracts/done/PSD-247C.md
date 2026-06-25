---
id: PSD-247C
title: First-party widget view-models on existing ports — clock/calendar, recent-files, quick-settings, status/tray
status: ready
phase: 6
pod: desktop
risk_class: R1
fr: []
depends_on: [PSD-021]
target_paths:
  - ui_kits/desktop/viewmodels
  - sdk/typescript/test/ui-kits
acceptance_command: "npm run typecheck && node --experimental-strip-types --test sdk/typescript/test/ui-kits/widgets*.test.ts"
allowed_network: false
budget_minutes: 90
---

## Objective
Headless, deterministic **per-widget data view-models** for the flagship desktop's widget board — the concrete widgets that need **no new SDK port**, each feeding the widget host model (PSD-242C: `WidgetDescriptor`/`WidgetInstance`). Built ONLY on `@vita/desktop-sdk` public ports + a pure model — injected ports/clock, NO platform internals, NO DOM/rendering, NO real timers/I-O.
- **clock/calendar** — pure, derived from the **injected clock** only (no wall-clock read): current time fields + month-grid calendar (weeks, today marker). No port required.
- **recent-files** — recent directory entries via the SDK **files** port (`FilesCapabilityPort` / `loadFileManagerDirectory`, PSD-007). Deterministic ordering (folders first, then name); capped recent list.
- **quick-settings** — toggle a small set of managed settings via the **settings control-plane** port (`SettingsControlPlanePort` / `requestSettingsApply`); reflects the applied/managed snapshot.
- **status/tray** — mirrors the **tray + notification** snapshot (`TrayModel` / `NotificationCenter` snapshots): status items + unread/notification count.
- **Each widget is capability-gated and fail-closed:** when its port is absent or the grant is missing/denied, the view-model resolves to a frozen **placeholder** state (e.g. empty recent-files, neutral status, disabled quick-settings) — it never throws and never reads ambient I/O.
- Each VM produces the `WidgetInstance`-shaped data the host model (PSD-242C) places/refreshes; refresh is driven by an injected `clockMs`, never a real timer.
- Put the code under `ui_kits/desktop/viewmodels/widgets.ts` and tests under `sdk/typescript/test/ui-kits/widgets.test.ts`.
- Import the SDK exactly as `ui_kits/desktop/package.ts` does; use ONLY public exports from `@vita/desktop-sdk`.

## User value
Turns the static widget mockups (clock, calendar, recent files, quick settings, status/tray) into real, testable desktop behavior on the SDK — concrete data widgets that drop into the widget host board with no new platform surface, the logic the CEF-rendered HTML hydrates against.

## Non-goals
- NO new SDK port — these are the widgets that work on existing ports only (weather/system-stats/notes that need new ports are out of scope). NO DOM/CSS/rendering/CEF. NO platform internals. NO real timers or wall-clock reads (clock is injected). NO re-implementing the widget host model (PSD-242C owns placement/refresh-scheduling; these are data VMs that plug into it). NO new visual design (the HTML is the design of record). Don't re-implement SDK ports — consume them.

## Acceptance
`acceptance_command` passes. Deterministic unit tests under `sdk/typescript/test/ui-kits/widgets.test.ts` against fake/injected SDK ports cover: **clock/calendar** deterministic from the injected clock (same clock → byte-identical fields + month grid; today marker correct); **recent-files** lists entries via the files port with deterministic order AND **fails closed to empty** when the grant/port is absent; **quick-settings** toggles a managed setting via the settings control-plane write and reflects the applied snapshot (fails closed to disabled when the port is absent); **status/tray** mirrors the injected tray/notification snapshot (status items + unread count); every VM state is **frozen** (immutable) and **host-free** (no DOM/timers/ambient I-O). Typecheck clean. Pure, headless.

## Security/constraints
- Injected ports + injected clock only (no ambient I/O, no real timers); capability-mediated, fail-closed (placeholder state) when a port/grant is absent; pure/deterministic (same inputs → byte-identical state). No remote imports; lockfile mandatory; no package lifecycle scripts; no FFI/native addons.

## Definition of done
- `ui_kits/desktop/viewmodels/widgets.ts` + `sdk/typescript/test/ui-kits/widgets.test.ts`, deterministic, typecheck clean, frozen + host-free, each widget capability-gated and fail-closed, plugging into the PSD-242C widget host model. R1.
