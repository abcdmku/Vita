---
id: PSD-260C
title: Shortcuts view-model test coverage + persistence-key contract
status: ready
phase: 6
pod: desktop
risk_class: R1
fr: []
depends_on: [PSD-021]
target_paths:
  - ui_kits/desktop/viewmodels/shortcuts.ts
  - sdk/typescript/test/ui-kits
acceptance_command: "npm run typecheck && node --experimental-strip-types --test sdk/typescript/test/ui-kits/shortcuts*.test.ts"
allowed_network: false
budget_minutes: 90
---

## Objective
Deterministic **test coverage** for the existing-but-thinly-tested global-input shortcuts view-model
(`ui_kits/desktop/viewmodels/shortcuts.ts`), plus a pure `serialize()` / `deserialize(userOverrides)`
**persistence-key contract** so user-rebound shortcuts can round-trip through a host store. Built ONLY
on `@vita/desktop-sdk` public ports (the launcher command port + surface model) — injected ports, NO
platform internals, NO DOM/rendering. **No dispatch behavior change**: the registry, chord
normalization, conflict detection, rebind/reset, and dispatch-via-`emitLauncherIntent` flows must
behave byte-identically; this slice only ADDS the persistence helpers and exhaustive tests.
- **Tests** (deterministic, fake SDK ports) cover EVERY result branch:
  - registry seeding (default commands/keymap, frozen snapshot), `list()`, `snapshot()` identity on no-op.
  - chord normalization edge cases: string vs key-event vs `code`, modifier folding/canonical order
    (`Control+Alt+Shift+Meta`), aliases (ctrl/option/cmd/super, comma/period/slash/space/escape),
    function keys, single-char upper-casing, and the fail-closed cases (`INVALID_CHORD` empty/empty-token/
    no-key/multi-key; `INVALID_KEY_EVENT` non-plain-object / unsupported field / accessor field / non-string
    key|code / non-boolean modifier).
  - `register`/`rebind` success + `reset` restoring the default; default-vs-user-override precedence;
    special command ids (e.g. `__proto__`) stay own registry entries.
  - conflict detect + reject WITHOUT mutating the active keymap (`SHORTCUT_CONFLICT`), and
    `detectShortcutConflicts(...)` standalone.
  - dispatch result branches incl. ALL fail-closed: `UNKNOWN_COMMAND`, `UNBOUND_CHORD`,
    `MISSING_CAPABILITY` (missing grant), `COMMAND_PORT_UNAVAILABLE` (port absent),
    `COMMAND_PORT_FAILED` (port throws), host `{ ok: false }` propagated as the host error,
    and success emitting exactly one `emitLauncherIntent`.
- **Persistence helper** (pure, in `shortcuts.ts`): `serialize()` returns the canonical user-override
  set (chord+commandId, stable order, JSON-safe, frozen); `deserialize(userOverrides)` rebuilds a
  view-model (or applies overrides) from that shape, **fail-closed** on malformed input (non-array,
  non-object entries, missing/empty `commandId`, un-normalizable `chord`, unknown command,
  conflicting overrides) — dropping/rejecting bad entries, never throwing. A `serialize()` →
  `deserialize()` round-trip of any valid override set is byte-stable.
- Put new tests under `sdk/typescript/test/ui-kits/shortcuts.test.ts` (lowercase; co-exists with the
  existing `Shortcuts.test.ts` — the acceptance glob `shortcuts*.test.ts` matches both on a
  case-insensitive filesystem; do NOT delete the existing suite). Import the SDK exactly as
  `ui_kits/desktop/package.ts` does; use ONLY public exports.

## User value
Locks the shortcut keymap's interaction logic behind exhaustive deterministic tests and gives the
desktop a stable on-disk contract for persisting user rebinds — the logic the CEF-rendered Settings
> Shortcuts surface hydrates against and the host store reads/writes.

## Non-goals
- NO DOM/CSS/rendering/CEF. NO platform internals. NO change to dispatch/normalize/conflict behavior.
  NO new visual design. Don't re-implement SDK ports — consume them. No actual disk/host I/O in the
  helper (serialize/deserialize are pure data transforms; persistence is the host's job).

## Acceptance
`acceptance_command` passes: `npm run typecheck` clean AND the node test runner reports the
`shortcuts*.test.ts` suite green, with assertions hitting every result branch listed above
(including all fail-closed paths) and a `serialize()`/`deserialize()` round-trip. Pure, headless,
deterministic (no timers, no network, no ambient I/O).

## Security/constraints
- Injected ports only (no ambient I/O); capability-mediated, fail-closed; pure/deterministic.
  Malformed persistence input must never throw or mutate global state; hostile/accessor-laden inputs
  fail closed without invoking accessors. No remote imports; lockfile; no lifecycle scripts.

## Hardware profiles
- Portable-first; no hardware dependency (pure TS view-model logic, runs under the node test runner).

## Allowed tools + network
- Read/write the target paths; run the acceptance command locally. `allowed_network: false` — no
  network access at build or test time.

## Compute/time budget
- `budget_minutes: 90`, single worker.

## Required artifacts
- `sdk/typescript/test/ui-kits/shortcuts.test.ts` (new deterministic suite).
- `ui_kits/desktop/viewmodels/shortcuts.ts` with the added pure `serialize()`/`deserialize(...)`
  persistence helpers (public exports), behavior of existing flows unchanged.

## Rollback plan
- Revert the task branch; the helper additions and new test file are isolated and additive, so
  reverting `task/PSD-260C` restores the prior state with no migration.

## Definition of done
- `ui_kits/desktop/viewmodels/shortcuts.ts` exports the pure persistence helpers (no dispatch
  behavior change) and `sdk/typescript/test/ui-kits/shortcuts.test.ts` exists; `acceptance_command`
  passes; every result branch incl. all fail-closed paths and the serialize/deserialize round-trip is
  asserted; typecheck clean. R1.
