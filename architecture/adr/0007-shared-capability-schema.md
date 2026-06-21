# ADR 0007: Shared Language-Neutral Capability/Request Schema

## Status

Proposed (owner decision required — this unblocks the config→plan evaluator P9-001 and whole-node apply).

## Context

Each transactional capability's **authoritative request schema** currently lives in the Go agent — e.g.
`agent/capabilities/timesync` defines `Config{ Enabled *bool; Servers []string }` plus a `normalizeConfig`
that encodes the real constraints (presence rules, charset, ranges, dedup, §13.1). The TypeScript SDK
re-declares the same shapes as separate fail-closed models. There is no single source both planes derive
from.

This blocks the pure, deterministic **config→plan evaluator** (spec §8.2, contract P9-001), which was
deferred after three rounds against a feasibility contradiction:
- A *closed*, drift-free, `/apply`-ready evaluator needs the authoritative capability vocabulary + per-
  capability request schemas. Those live only in Go.
- Re-implementing the schemas in TS drifts from the agent (a round-2 attempt accepted `:::/0` CIDRs and a
  zero-value time the agent rejects).
- An open/structural evaluator is not closed ("a generic JSON sorter") and was rejected in round 3.

Both dead ends share one missing prerequisite: a shared schema source. The same gap will block whole-node
**apply** (turning an authored `NodeChangeSet` into a validated per-capability plan), even though the
preview path and per-capability `/apply` are complete.

## Decision

Introduce a single, version-pinned, language-neutral **capability manifest** as the source of truth for the
capability vocabulary and every per-capability request schema, and have BOTH planes derive from it.

1. **Manifest** (`schema/capabilities/*.json`, a new PROTECTED artifact): one declarative document per
   capability in a *restricted* JSON-Schema-like dialect supporting only what the caps need — field name,
   type (`string|integer|boolean|array|object`), `required` vs optional with explicit-presence semantics
   (so *absent ≠ zero*), and a closed set of constraints (`pattern`, `enum`, `minimum`/`maximum`,
   `minItems`/`maxItems`, `uniqueItems`, `items`, `noInlineSecrets`). No `$ref` cycles, no remote refs, no
   open extension — the dialect is itself closed so a conformant validator is decidable and fail-closed.
2. **Derivation, not duplication.** Prefer **build-time code generation** of both the Go validators and the
   TS validators from the manifest (deterministic; keeps no schema-interpreter in the TCB at runtime). A
   small shared runtime validator is the fallback where codegen is impractical. Either way, hand-written
   per-cap validation is replaced by generated/derived validation.
3. **The evaluator derives from the manifest.** P9-001 reads the closed capability set + per-cap schemas
   from the manifest, so it is genuinely closed (unknown capability/field ⇒ reject) with zero drift.
4. **Conformance gate.** A cross-check test asserts, for every capability, that the Go validator, the TS
   validator, and the manifest agree on a shared corpus of accept/reject vectors (including the historical
   gated bugs: `:::/0`, leading-zero versions, uid<1000, `__proto__` keys, duplicate JSON keys, inline
   secrets). Drift fails CI.
5. **Migration is incremental + reversible.** Adopt cap-by-cap behind the conformance gate; until a cap is
   migrated, its existing hand-written validators remain authoritative and the manifest entry is checked
   against them. The manifest and the codegen are protected-policy artifacts (governance-reviewed changes).

A proof-of-concept should land first: the manifest entry for `timesync` (+ `hostname`), the generated/derived
validators on both sides, and the conformance test — proving zero behavior change before any broad rollout.

## Consequences

Unblocks the closed config→plan evaluator (P9-001) and whole-node apply: a single authoritative schema means
the controller can author + preview, the evaluator can produce a closed validated plan, and the agent
enforces the identical rules — *preview == evaluate == apply* with no drift. Costs: a new protected schema
dialect + codegen/validator to build and test; a one-time per-capability migration; and the discipline that
every future capability/field change goes through the manifest (a feature, not a tax — it is what keeps the
two planes honest). The restricted dialect is deliberately small to keep the conformant validator decidable
and auditable; if a capability ever needs a constraint the dialect can't express, that is a governance
decision to extend the dialect, not to bypass it.
