---
id: PSD-246C
title: Desktop-icons source binding (Desktop dir + pinned launchers)
status: ready
phase: 6
pod: desktop
risk_class: R1
fr: []
depends_on: [PSD-241C]
target_paths:
  - ui_kits/desktop/viewmodels
  - sdk/typescript/test/ui-kits
acceptance_command: "npm run typecheck && node --experimental-strip-types --test sdk/typescript/test/ui-kits/desktop-icons-source*.test.ts"
allowed_network: false
budget_minutes: 90
---

## Objective
Headless, deterministic **view-model** that fills the desktop-icons model (PSD-241C) from REAL sources,
built ONLY on `@vita/desktop-sdk` public ports + surface model (injected ports, NO platform internals, NO DOM/rendering).
This slice is the **source binding** layer: it turns a live Desktop directory listing plus pinned app launchers into
the `{ id, label, kind, iconRef }` icon descriptors the geometry/selection model consumes, and routes open/activate
back out to the correct port.
- State: a bound icon set derived from two sources — (1) the **Desktop directory** read through the SDK files port (the `FilesCapabilityPort` consumed exactly as `ui_kits/desktop/viewmodels/files.ts` does, via `loadFileManagerDirectory` / `readFileManagerFile`), each directory entry (`FilesEntry`: name/kind/size/modified) mapped to an icon descriptor with a **stable path-derived id**; and (2) **pinned app launchers** (the dock-style app set, e.g. `INDEX_DOCK_APP_IDS` in `ui_kits/desktop/viewmodels/dock.ts`) mapped to launcher icon descriptors. Folders sort before files (matching the PSD-024 files ordering), pinned launchers placed deterministically relative to the directory entries.
- Actions: `refresh()` (re-list the Desktop dir through the files port and rebuild the bound icon set), `activate(id)` routing — a **folder** entry → files-port navigate/open (into that path), a **file** entry → files-port open/read (`readFileManagerFile`), a **pinned app** → a launcher intent (`DesktopLauncherIntent` via the injected `DesktopHost`); and `reconcile()` that diffs the freshly-listed set against the current icons model by **stable path id** so unchanged icons keep their identity/position (no churn) while added/removed entries are applied.
- **Fail-closed:** when the `files.read` grant is missing (`hasDesktopCapabilityGrant` false / files port returns a denied/error response) the bound directory portion is **empty and inert** — `refresh()` yields an empty directory contribution and `activate` on a would-be entry returns a denied result and performs NO I/O and throws nothing. Likewise a missing launcher grant makes pinned launchers inert (no intent emitted, denied result returned). Deterministic: same listing + same grants → byte-identical icon set and id assignment.
- Put the code under `ui_kits/desktop/viewmodels/desktop-icons-source.ts` and tests under `sdk/typescript/test/ui-kits/desktop-icons-source.test.ts`.
- Import the SDK exactly as `ui_kits/desktop/viewmodels/files.ts` / `ui_kits/desktop/viewmodels/dock.ts` / `ui_kits/desktop/package.ts` do; use ONLY public exports (no platform internals). Consume the PSD-241C icons model — do not re-implement its geometry/selection.

## User value
Connects the flagship desktop's icon background to live data — files on the user's Desktop and the user's pinned apps — so the icons are real and clickable, not a static mock, while keeping every read capability-mediated and fail-closed.

## Non-goals
- NO DOM/CSS/rendering/CEF. NO platform internals or ambient I/O (every directory read goes through the injected files port; every launch through the injected host). NO geometry/selection/marquee/drag math — that is PSD-241C and is consumed here, not duplicated. Don't re-implement SDK ports — consume them. No new visual design (the HTML is the design of record).

## Acceptance
`acceptance_command` passes. Deterministic unit tests against fake SDK files + launcher/host ports cover: the bound icon set matches the Desktop listing (folders first, then files by name; pinned launchers included) with **stable path-derived ids**; `activate` on a folder routes to the files port (navigate/open into that path); `activate` on a file routes to the files port open/read (`readFileManagerFile`); `activate` on a pinned app emits exactly one launcher intent on the host; `refresh` + `reconcile` keep unchanged icons' ids stable and apply only added/removed entries; and when `files.read` is missing the directory contribution is empty, `activate` returns a denied result, performs no port I/O, and throws nothing (same for a missing launcher grant). Typecheck clean; pure, headless.

## Security/constraints
- Injected ports only (no ambient I/O); capability-mediated, **fail-closed** (missing `files.read` / launcher grant → empty/inert + denied result, never throw, never partial side effects); pure/deterministic (same listing + grants → byte-identical icon set + ids). No remote imports; lockfile mandatory; no package lifecycle scripts; no FFI/native addons.

## Hardware profiles
- None (pure TS view-model; runs under `node --experimental-strip-types`, no device dependency).

## Allowed tools + network
- Local toolchain only (npm typecheck + node test runner). `allowed_network: false`.

## Compute/time budget
- `budget_minutes: 90`.

## Required artifacts
- `ui_kits/desktop/viewmodels/desktop-icons-source.ts` (the source-binding view-model: directory→descriptor mapping, launcher merge, activate routing, refresh/reconcile, fail-closed guards).
- `sdk/typescript/test/ui-kits/desktop-icons-source.test.ts` (deterministic tests covering the cases above against fake files + launcher/host ports).

## Rollback plan
- Revert the `task/PSD-246C` branch; both files are additive (new view-model + new test), so removal restores prior state with no other code depending on them.

## Definition of done
- `ui_kits/desktop/viewmodels/desktop-icons-source.ts` + `sdk/typescript/test/ui-kits/desktop-icons-source.test.ts` land, deterministic, typecheck clean, acceptance command green on Windows. Pure, headless, ports-injected, fail-closed. Consumes PSD-241C icons model. R1.
