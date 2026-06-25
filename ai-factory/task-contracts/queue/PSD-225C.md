---
id: PSD-225C
title: Captions/subtitle track SDK port + captions view-model
status: ready
phase: 6
pod: desktop
risk_class: R2
fr: []
depends_on: [PSD-224C]
target_paths:
  - sdk/typescript/src/desktop-sdk
  - ui_kits/desktop/viewmodels
  - sdk/typescript/test/desktop-sdk
  - sdk/typescript/test/ui-kits
acceptance_command: "test -f sdk/typescript/test/ui-kits/captions.test.ts && npm run typecheck && node --experimental-strip-types --test sdk/typescript/test/desktop-sdk/*.test.ts sdk/typescript/test/ui-kits/captions*.test.ts"
allowed_network: false
budget_minutes: 110
---

## Objective
Add an OPTIONAL **captions** capability to `@vita/desktop-sdk` + a `captions` view-model. Additive + fail-closed.
Build AFTER PSD-224C (shares the SDK-surface edit pattern; serialize the SDK change to avoid contention).
- **SDK port:** optional `listCaptionTracks()` / `requestCaptionTrack(id)` + an `accessibility.captions` capability;
  model timed cue tracks `{ id, lang, kind: "subtitles"|"captions"|"descriptions" }` + plain-JSON cue `{ startMs, endMs, text }`;
  loader normalization + grant-gating; add the new public types to the index allow-list.
- **captions view-model (ui_kits/desktop/viewmodels/captions.ts):** select the active cue(s) for a playback time (boundaries/
  overlaps/gaps deterministic), track/language switching + on/off, and caption-styling prefs (font scale, bg opacity, edge
  style) read via the settings port; fail-closed (captions OFF) when the port is absent.

## User value
Captions/subtitles + audio descriptions for media — accessibility for deaf/hard-of-hearing users.

## Non-goals
- NO real DOM/CEF/media decoding. NO platform internals. ADD the optional port additively; don't change existing behavior.

## Acceptance
`acceptance_command` passes: validate track/cue requests + grant-gate `accessibility.captions` fail-closed; active-cue
selection at boundaries/overlaps/gaps; track switch + off; styling prefs; absent port → off. Typecheck clean. R2 reviewer gate.

## Security/constraints
- Capability-mediated, fail-closed; snapshot/sanitize; plain-JSON only. No remote imports; lockfile; no lifecycle scripts.

## Definition of done
- The optional captions port + `accessibility.captions` capability (loader-gated, allow-listed) + `captions.ts` with
  deterministic tests in BOTH test dirs; typecheck clean. R2 (Codex reviewer gate before merge).
