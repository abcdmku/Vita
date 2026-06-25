---
id: PSD-248C
title: Surface drag-and-drop coordinator model
status: ready
phase: 6
pod: desktop
risk_class: R1
fr: []
depends_on: [PSD-241C]
target_paths:
  - ui_kits/desktop/viewmodels
  - sdk/typescript/test/ui-kits
acceptance_command: "npm run typecheck && node --experimental-strip-types --test sdk/typescript/test/ui-kits/surface-dnd*.test.ts"
allowed_network: false
budget_minutes: 90
---

## Objective
Headless, deterministic **drag-and-drop coordinator view-model** for the whole flagship desktop surface,
built ONLY on `@vita/desktop-sdk` public ports + surface model (injected ports, NO platform internals, NO DOM/rendering).
This is the pure resolution logic that decides, for a drag in progress, what a drop *means* — the rendered shell binds to it later.
- State: an in-flight drag carrying a **drag source descriptor** — a discriminated union of `{ kind: 'file' | 'icon' | 'app' | 'widget' | 'text', ... }` (file/icon carry capability paths + entry kind; app carries an app id; widget carries a widget id; text carries a string payload); a set of hit-tested **drop targets** — `{ kind: 'desktop-background' | 'icon' | 'folder-icon' | 'dock' | 'widget-zone' | 'window', ... }` (folder-icon/window/icon carry the path/id they represent); the modifier state (e.g. ctrl) for the current pointer.
- Actions: `beginDrag(source)`, `hover(target, modifiers)` (resolve the candidate effect for the currently-hovered target), `drop()` (commit), `cancelDrag()`. Each target carries an **accept/validate predicate** that decides whether the source may land there.
- Resolution: a **pure, deterministic** `resolveEffect(source, target, modifiers, ports)` that returns one of `move | copy | link | launch | reject` plus a **follow-up intent** describing what the host must then do (files move/copy of source path(s) into the target folder; launch of an app/widget). Rules (deterministic): file-icon onto a different folder-icon → `move` + a files-move intent; the **same** folder (drop where it already lives) → `reject` (no-op); ctrl held over a folder → `copy` + a files-copy intent; app onto desktop-background or dock → `launch`/pin intent; any source onto a target whose validate predicate rejects → `reject`.
- **Fail-closed**: if the capability port (files) or the grant needed to satisfy a follow-up files intent is absent, resolution MUST return `reject` and emit **no** intent — never assume the move/copy will succeed. (This coordinator composes with the cross-surface DnD slice PSD-273; here we model the single-surface case only.)
- Put the code under `ui_kits/desktop/viewmodels/surface-dnd.ts` and tests under `sdk/typescript/test/ui-kits/surface-dnd.test.ts`.
- Import the SDK exactly as `ui_kits/desktop/viewmodels/files.ts` / `ui_kits/desktop/viewmodels/files-ops.ts` do; use ONLY public exports (no platform internals).

## User value
Gives the flagship desktop one coherent, testable drag-and-drop brain — drop a file on a folder to move it, ctrl-drag to copy, drag an app to the dock to pin, reject invalid drops — as pure interaction logic the CEF-rendered surface hydrates against, without coupling to the DOM or any pointer backend.

## Non-goals
- NO DOM/CSS/rendering/CEF, no pointer-event plumbing. NO platform internals or ambient I/O. NO re-implementation of SDK ports — consume them. NO actual execution of moves/copies/launches — the coordinator only resolves the effect + emits the follow-up intent; the host executes it. NO cross-surface (multi-monitor / surface-to-surface) handoff — that is PSD-273. No new visual design (the HTML is the design of record).

## Acceptance
`acceptance_command` passes. Deterministic unit tests against fake SDK ports cover: a file-icon dragged onto a *different* folder-icon resolves `move` and emits a files-move intent for the source path into the target folder; dropping onto the folder it already lives in resolves `reject` (no-op, no intent); an `app` source dropped on desktop-background (or dock) resolves `launch`/pin with the matching intent; ctrl held over a folder resolves `copy` and emits a files-copy intent; a source over a target whose validate predicate rejects resolves `reject` with no intent; and when the files capability port / `files.write` grant is absent every otherwise-mutating drop fails closed to `reject` with no intent. Same inputs → byte-identical resolved effect + intent. Typecheck clean; pure, headless.

## Security/constraints
- Injected ports only (no ambient I/O); capability-mediated, **fail-closed** (missing port/grant → `reject`, no intent); pure/deterministic (same inputs → byte-identical effect + intent). No remote imports; lockfile mandatory; no package lifecycle scripts; no FFI/native addons.

## Hardware profiles
- None (pure TS view-model; runs under `node --experimental-strip-types`, no device dependency).

## Allowed tools + network
- Local toolchain only (npm typecheck + node test runner). `allowed_network: false`.

## Compute/time budget
- `budget_minutes: 90`.

## Required artifacts
- `ui_kits/desktop/viewmodels/surface-dnd.ts` (the coordinator view-model + pure `resolveEffect` and target/source types).
- `sdk/typescript/test/ui-kits/surface-dnd.test.ts` (deterministic tests covering the cases above, including the fail-closed paths).

## Rollback plan
- Revert the `task/PSD-248C` branch; both files are additive (new view-model + new test), so removal restores prior state with no other code depending on them.

## Definition of done
- `ui_kits/desktop/viewmodels/surface-dnd.ts` + `sdk/typescript/test/ui-kits/surface-dnd.test.ts` land, deterministic, typecheck clean, acceptance command green on Windows. Pure, headless, ports-injected, fail-closed. R1.
