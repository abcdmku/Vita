---
id: PSD-226C
title: Key-repeat & sticky/slow/bounce-keys accessibility input policy
status: ready
phase: 6
pod: desktop
risk_class: R1
fr: []
depends_on: [PSD-021]
target_paths:
  - ui_kits/desktop/viewmodels
  - sdk/typescript/test/ui-kits
acceptance_command: "npm run typecheck && node --experimental-strip-types --test sdk/typescript/test/ui-kits/input-accessibility*.test.ts"
allowed_network: false
budget_minutes: 90
---

## Objective
Headless, deterministic **accessibility input-policy view-model** that computes the effective key
handling for the flagship desktop from a11y settings, built ONLY on `@vita/desktop-sdk` public ports
(settings/persistence port + surface model) — injected ports, an injected **monotonic clock**, NO
platform internals, NO DOM/rendering, NO real timers. It is the pure interaction logic that filters
and synthesizes the chord stream the shortcuts/IME pipeline (PSD shortcuts view-model) consumes.
- Input: an ordered stream of raw key events (`{ key, code, type: "down" | "up", at }`) where `at` is
  a monotonic timestamp supplied by the injected clock — the VM never reads ambient time.
- Policy, all driven by persisted a11y settings, applied as a pure fold over the event stream:
  - **key-repeat** — after `repeatDelayMs` of a key held down, synthesize repeat `down` events every
    `repeatRateMs`; cancel on `up`.
  - **sticky keys** — latch modifiers (Ctrl/Alt/Shift/Meta) across *separate* strokes so a modifier
    pressed and released still applies to the next non-modifier key; one-shot latch clears after use
    (lock-on-double-press optional, deterministic).
  - **slow keys** — a key only registers after being held continuously for `holdThresholdMs`
    (measured via the injected clock); keys released early are dropped.
  - **bounce keys** — debounce a repeated *same* key within `debounceWindowMs`; the second press is
    suppressed.
- Output: the filtered/synthesized **chord stream** (effective key-down chords with active modifiers)
  feeding the shortcuts/IME pipeline. Settings load/save go through the SDK settings port
  (fail-closed if the grant is missing). Fully deterministic — same events + same clock → identical
  output.
- Put the code under `ui_kits/desktop/viewmodels/input-accessibility.ts` and tests under
  `sdk/typescript/test/ui-kits/input-accessibility.test.ts`.
- Import the SDK exactly as `ui_kits/desktop/viewmodels/files.ts` / `package.ts` does; use ONLY public exports.

## User value
Makes the desktop usable for people who need sticky/slow/bounce keys and tunable key-repeat, as real
testable behavior on the SDK — the logic the CEF-rendered shell binds its input pipeline against.

## Non-goals
- NO DOM/CSS/rendering/CEF. NO real timers or ambient clock (clock is injected). NO platform internals.
  NO new visual design. Don't re-implement SDK ports or the shortcuts/IME pipeline — feed and consume them.

## Acceptance
`acceptance_command` passes: deterministic unit tests against fake SDK ports + an injected monotonic
clock cover — sticky-key latch across separate strokes; slow-key hold threshold (registers at/after
threshold, drops early release) via the clock; bounce-key debounce within window; key-repeat
synthesis (delay then rate); and end-to-end determinism (same stream + clock → byte-identical chord
output). Fail-closed when the settings grant is absent. Typecheck clean. Pure, headless.

## Security/constraints
- Injected ports + injected clock only (no ambient I/O, no real time); capability-mediated,
  fail-closed; pure/deterministic. No remote imports; lockfile; no lifecycle scripts.

## Definition of done
- `ui_kits/desktop/viewmodels/input-accessibility.ts` + `sdk/typescript/test/ui-kits/input-accessibility.test.ts`,
  deterministic, typecheck clean. R1.
