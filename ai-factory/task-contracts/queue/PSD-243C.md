---
id: PSD-243C
title: Stage / exposé model + live-thumbnail binding
status: ready
phase: 6
pod: desktop
risk_class: R1
fr: []
depends_on: [PSD-021]
target_paths:
  - ui_kits/desktop/viewmodels
  - sdk/typescript/test/ui-kits
acceptance_command: "npm run typecheck && node --experimental-strip-types --test sdk/typescript/test/ui-kits/stage*.test.ts"
allowed_network: false
budget_minutes: 90
---

## Objective
Headless, deterministic **view-model** for the flagship desktop's stage-manager / exposé overview,
built ONLY on `@vita/desktop-sdk` public ports (the WM intent surface + window/workspace model that
`ui_kits/desktop/viewmodels/Tiling.ts` and `workspaces.ts` already consume) — injected ports, NO
platform internals, NO DOM/rendering (the view-model is the pure interaction logic the rendered
exposé design binds to later). This is a **merge of two slices**, kept in one VM because the thumbnail
layout and its texture binding share the same cell geometry:

**Part A — stage / exposé overview VM.** Project all windows across all workspaces into a
**deterministic, non-overlapping** thumbnail layout, grouped by workspace.
- State (frozen snapshot): `workspaces` (ordered groups, each with `workspaceId`, `label`, and an
  ordered list of `cells`); each `cell` carries `windowId`, `title`, `appId`, the source window rect,
  and the computed thumbnail `rect` (`x`/`y`/`w`/`h`, integer, non-overlapping within its group);
  plus `focusedCell` (the `{ workspaceId, windowId }` of the focused cell, or null when empty).
- Layout is pure and deterministic: same window set → byte-identical cell rects; cells are packed into
  a stable grid (folders-first style ordering rule: by workspace order, then by a stable window key —
  e.g. `windowId`) with no two cells in a group overlapping. Empty workspaces yield an empty group.
- Actions: `focusCell(workspaceId, windowId)` (moves the focused cell); `navigate(direction)` for
  keyboard/arrow nav (`up|down|left|right`) which moves `focusedCell` to the geometrically-adjacent
  cell within the deterministic grid (clamped at edges, stable across the same layout);
  `pick(workspaceId, windowId)` which emits a **focus + activate** WM intent for that window (and
  closes the overview); `closeWindow(workspaceId, windowId)` which emits a close WM intent; and
  `moveToWorkspace(windowId, targetWorkspaceId)` which emits a move-to-workspace WM intent. Every
  action goes through the injected WM intent port — NO direct mutation of platform state — and
  re-freezes the snapshot.

**Part B — live-thumbnail binding.** Map each cell's `windowId` to its compositor texture / surface
snapshot and produce a deterministic **render plan** the renderer consumes.
- Given the layout above plus an injected `compositorPort` that resolves a `windowId` →
  `{ textureId, sourceW, sourceH }` (or absent), produce a `renderPlan`: an ordered list of
  `{ windowId, cellRect, textureId, sourceSize }` entries (cell rect → texture, preserving the cell's
  geometry; downstream scales `sourceSize` into `cellRect`).
- **Reconcile** as windows open/close/resize: re-deriving the plan after a window set / size change
  produces a **minimal diff** (`added`/`removed`/`updated` cell+texture bindings) — unchanged cells
  keep identical entries (referential/structural stability), so open/close/resize touches only the
  affected cells, not the whole plan.
- **Missing texture → placeholder.** When `compositorPort` returns no texture for a `windowId` (window
  not yet composited, or the port is denied), the plan entry carries an explicit `placeholder: true`
  with a null `textureId` instead of failing — the cell still occupies its rect. Fail-closed: a
  missing/throwing compositor port yields all-placeholder entries, never an exception.
- Put the code under `ui_kits/desktop/viewmodels/stage.ts` and tests under
  `sdk/typescript/test/ui-kits/stage.test.ts`. Import the SDK exactly as
  `ui_kits/desktop/viewmodels/Tiling.ts` / `ui_kits/desktop/package.ts` do; use ONLY public exports.
  (This overlaps the workspaces-exposé concept; it is the headless overview source-of-truth the
  CEF-rendered exposé hydrates against.)

## User value
Turns the static exposé / stage-manager mockup into real, testable desktop behavior on the SDK — a
deterministic non-overlapping thumbnail overview with keyboard navigation, pick/close/move WM intents,
and a live texture-bound render plan that reconciles minimally as windows change — the logic the
CEF-rendered HTML and the compositor hydrate against.

## Non-goals
- NO DOM/CSS/rendering/CEF. NO platform internals. NO actual compositor / GPU texture upload (consume
  the injected compositor port; do NOT readback or allocate textures here). NO new visual design (the
  HTML is the design of record). NO **new** SDK transport — consume the existing WM intent + window
  model ports. Do NOT re-implement SDK ports — consume them.

## Acceptance
`acceptance_command` passes: deterministic unit tests against fake WM-intent + compositor ports cover —
a **deterministic non-overlapping layout for N windows across 2 workspaces** (byte-identical rects on
repeat; no intra-group overlap; empty workspace → empty group); **arrow navigation** moving
`focusedCell` to the correct adjacent cell and clamping at edges; `pick` / `closeWindow` /
`moveToWorkspace` each emitting the correct WM intent through the injected port; each cell mapping to
the **correct texture + source size** in the render plan; **open / close / resize producing a minimal
diff** (only affected cells change; unchanged cells keep identical entries); and **missing texture →
placeholder** (placeholder entry with null `textureId`, cell rect preserved) including missing/throwing
compositor port → all-placeholder, no throw. Returned snapshots are frozen (`Object.isFrozen` true).
Typecheck clean. Pure, headless, deterministic.

## Security/constraints
- Injected ports only (no ambient I/O); capability-mediated, fail-closed; pure/deterministic (same
  inputs → identical snapshot + render plan). No remote imports; lockfile mandatory; no package
  lifecycle scripts; no FFI/native addons.

## Definition of done
- `ui_kits/desktop/viewmodels/stage.ts` + `sdk/typescript/test/ui-kits/stage.test.ts`, deterministic,
  non-overlapping layout + arrow nav + pick/close/move WM intents + live-thumbnail render plan with
  minimal reconcile diff and placeholder-on-missing-texture, mirrors the existing Tiling/workspaces
  port + frozen-snapshot conventions, typecheck clean. R1.
