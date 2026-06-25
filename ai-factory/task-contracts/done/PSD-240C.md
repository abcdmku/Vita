---
id: PSD-240C
title: Desktop-surface context-menu model (pure)
status: ready
phase: 6
pod: desktop
risk_class: R1
fr: []
depends_on: [PSD-021]
target_paths:
  - ui_kits/desktop/viewmodels/context-menu.ts
  - sdk/typescript/test/ui-kits
acceptance_command: "npm run typecheck && node --experimental-strip-types --test sdk/typescript/test/ui-kits/context-menu*.test.ts"
allowed_network: false
budget_minutes: 90
---

## Objective
Headless, deterministic **context-menu primitive** — the shared right-click model every desktop surface (the
desktop surface itself, per-icon menus, list rows) reuses. Pure data structure + reducer built ONLY on
`@vita/desktop-sdk` public ports / plain TS — NO platform internals, NO DOM/rendering, NO ambient I/O.
- **Model:** a menu is ordered **sections**; each section holds **items** (`id`/`label`/`icon`/`role`) and
  **separators**; items may have **nested submenus**, and `disabled` / `checked` / `destructive` states, plus a
  dynamic **visibility predicate** evaluated against caller-supplied context. Menu *contents* are supplied by the
  caller — this slice owns the structure + traversal, not the items.
- **State:** open/closed, the open submenu path, and a **focused cursor** (the highlighted item).
- **Actions / reducer:** `open(menu, ctx)`, `close()`, `openSubmenu(id)` / `closeSubmenu()`, cursor
  `moveUp()` / `moveDown()` (arrow traversal that **skips disabled items and separators**), `activate()`
  (invokes the focused item's role; **disabled activate is a no-op**), and `escape()` (Esc closes the deepest
  open level). A deterministic **flatten** produces the rendered, ordered item list from sections + visibility
  predicates (stable ordering, no I/O).
- Put the code under `ui_kits/desktop/viewmodels/context-menu.ts` and tests under
  `sdk/typescript/test/ui-kits/context-menu.test.ts`.
- Import the SDK exactly as `ui_kits/desktop/package.ts` / the sibling view-models do; use ONLY public exports.
- **Reconcile with** the menu-shortcuts menu tree (PSD-202) and context-menu (PSD-211): this is the shared
  primitive those reuse — do not fork a second menu model.

## User value
Gives every right-click surface in the flagship desktop one tested, deterministic interaction model (ordering,
submenu/keyboard traversal, disabled/checked/destructive semantics) that the CEF-rendered HTML hydrates
against — instead of ad-hoc per-surface menu logic.

## Non-goals
- NO DOM/CSS/rendering/CEF. NO platform internals. NO new visual design (the HTML is the design of record).
- Does NOT define menu *contents* (those come from callers). Does NOT re-implement SDK ports — consume them.
- No positioning/hit-testing geometry (that is render-layer, out of scope).

## Acceptance
`acceptance_command` passes. Deterministic unit tests cover, against an in-memory menu fixture:
sections/separators/nested submenu structure; `disabled` / `checked` / `destructive` flags; visibility
predicates (hidden items absent from flatten); deterministic flatten ordering (stable, sections in order);
`open`/`close`; `openSubmenu`/`closeSubmenu`; arrow traversal **skipping disabled items + separators**; `escape`
closing the deepest open level; and **disabled `activate` is a no-op** (no role invoked). Typecheck clean; pure
and headless.

## Security/constraints
- Pure/deterministic: same inputs → byte-identical flatten/state. No ambient I/O, no DOM, no platform internals.
- Injected ports only where any SDK surface is touched; capability-mediated, fail-closed. No remote imports;
  lockfile mandatory; no package lifecycle scripts; no FFI/native addons.

## Rollback plan
Self-contained new files; no shared types changed. Revert the task branch (delete
`ui_kits/desktop/viewmodels/context-menu.ts` + its test) — no integrators depend on it yet.

## Definition of done
- `ui_kits/desktop/viewmodels/context-menu.ts` + `sdk/typescript/test/ui-kits/context-menu.test.ts`,
  deterministic, typecheck clean, all acceptance cases passing. R1.
