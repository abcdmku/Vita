---
id: PSD-224C
title: Screen-reader announce SDK port + live-region announcer view-model
status: ready
phase: 6
pod: desktop
risk_class: R2
fr: []
depends_on: [PSD-021]
target_paths:
  - sdk/typescript/src/desktop-sdk
  - ui_kits/desktop/viewmodels
  - sdk/typescript/test/desktop-sdk
  - sdk/typescript/test/ui-kits
acceptance_command: "npm run typecheck && node --experimental-strip-types --test sdk/typescript/test/desktop-sdk/*.test.ts sdk/typescript/test/ui-kits/announcer*.test.ts"
allowed_network: false
budget_minutes: 110
---

## Objective
Add an OPTIONAL screen-reader **announce** capability to `@vita/desktop-sdk` (the SDK trust boundary) + an `announcer`
view-model. Additive + fail-closed; do NOT change existing behavior.
- **SDK port (sdk/typescript/src/desktop-sdk):** a new OPTIONAL `DesktopHost.announce(request)` where
  `request = { message: string, politeness: "polite"|"assertive", interrupt?: boolean }` (plain JSON only), a new
  `accessibility.announce` capability in the `DesktopCapability` union, loader normalization + GRANT-gating in the scoped
  host (mirror the existing optional ports — snapshot/sanitize the request, reject accessors/exotic shapes fail-closed),
  and the new public types added to the index ALLOW-LIST (PSD-021's surface test).
- **Announcer view-model (ui_kits/desktop/viewmodels/announcer.ts):** turns shell events (notification posted, app
  launched, view changed, error-sink message) into DEDUPLICATED, rate-aware `announce()` calls with the right politeness;
  when the port is absent/denied, fall back to a DOM live-region SNAPSHOT (a plain-data description, no real DOM) — never throw.

## User value
Screen-reader users hear notifications, launches, and view changes — the accessibility backbone the a11y hydration (PSD-228C) wires up.

## Non-goals
- NO real DOM/CEF. NO platform internals. Don't change existing SDK ports/behavior — ADD the optional port additively.

## Acceptance
`acceptance_command` passes: the scoped host normalizes + GRANT-gates `announce` fail-closed (grantless → denied); index
re-exports the new types (allow-list updated); the announcer maps events→announce calls with correct politeness, coalesces
duplicates, and falls back to the live-region snapshot when the port is degraded. Deterministic; typecheck clean. R2 reviewer gate.

## Security/constraints
- Capability-mediated, fail-closed; snapshot/sanitize the request (TOCTOU-safe); plain-JSON only. No remote imports; lockfile; no lifecycle scripts.

## Definition of done
- The optional `announce` port + `accessibility.announce` capability (loader-gated, allow-listed) + `announcer.ts` with
  deterministic tests in BOTH test dirs; typecheck clean. R2 (Codex reviewer gate before merge).
