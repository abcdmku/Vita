# ADR 0007: Shared Language-Neutral Capability/Request Schema

## Status

**Accepted** (owner approved 2026-06-21). Implementation decisions for this rollout:
- **Shared artifact:** each capability manifest is a checked-in JSON file under `schema/capabilities/` (the
  P9-002 dialect, as data) — the single source of truth, embedded into both planes at build time (a trusted
  build input, not loaded from an untrusted source). It should be added to protected-policy (owner action —
  agents must not alter the authoritative schema without governance).
- **Derivation:** a SHARED runtime manifest-validator in each plane (the proven TS `compileCapabilityValidator`
  from P9-002 + a mirrored, audited Go validator) — one small, conformance-tested engine per plane replacing
  per-cap hand-written validators, rather than a Node→Go codegen toolchain. (Codegen remains a future option;
  the runtime validator is simpler and already proven.)
- **No raw regex — named FORMAT primitives.** Raw regex CANNOT be kept semantically equal across JS and Go
  RE2 (JS `$` matches before a trailing `\n` and Go's does not; `.`, `\s`, `\b`, Unicode, lookahead all
  differ). The dialect therefore has NO `pattern`; string structure is expressed via a CLOSED `format` enum
  (e.g. `hostnameRFC1123`) implemented identically as a STRUCTURED, non-regex check in both planes, plus the
  simple primitives (`maxLength`/`enum`/`lowercase`/`noInlineSecrets`). A new format is a governance decision
  to extend the closed set. (Discovered building P9-005 — the Go engine had to special-case a JS-lookahead
  hostname pattern; the fix was to drop regex.)
- **The parity bound:** every named format + the number handling (JS-`float64` semantics) is made SAFE by a
  **cross-language conformance corpus**: a shared vectors file both validators run, asserting agreement; drift
  fails CI. IP-literal canonicalizing formats are added per-cap behind that corpus.
- **Migration:** incremental + reversible, cap-by-cap behind the conformance gate; a cap's existing
  hand-written validators remain authoritative until its manifest passes conformance against them.

Sequenced contracts: P9-003 (promote the dialect to a shared JSON manifest + TS loader) → P9-005 (the Go
manifest-validator) → P9-006 (cross-language conformance gate for `timesync`) → P9-001 (the evaluator, now
unblocked, derives from the manifests) → per-cap migration.

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

### Empirical evidence (from the PoC, P9-002)

The additive PoC tried to *hand-write* a TS validator mirroring the agent's timesync rules. Its IP-literal
handling drifted from Go's `netip.ParseAddr` across THREE successive review rounds — first rejecting
IPv4-mapped IPv6 (`::ffff:192.0.2.1`), then failing to canonical-dedup zero-padded forms
(`2001:0db8::1` vs `2001:db8::1`), then mis-splitting compressed dotted-tail literals (`2001:db8::192.0.2.1`).
This is direct evidence for the decision: **format/canonicalization validators (IP addresses especially)
cannot be reliably kept in parity by hand across TS and Go — they MUST be generated from, or share, one
source.** The PoC therefore scopes its `timesync.servers` to RFC-1123 hostnames (fully expressible in the
declarative dialect, hand-conformant) and DEFERS IP-literal support to the generated/shared format primitive
this ADR mandates. The dialect itself (field schemas + bounded cross-field invariants + §13.1) is proven;
the format primitives are the part that needs codegen.

## Consequences

Unblocks the closed config→plan evaluator (P9-001) and whole-node apply: a single authoritative schema means
the controller can author + preview, the evaluator can produce a closed validated plan, and the agent
enforces the identical rules — *preview == evaluate == apply* with no drift. Costs: a new protected schema
dialect + codegen/validator to build and test; a one-time per-capability migration; and the discipline that
every future capability/field change goes through the manifest (a feature, not a tax — it is what keeps the
two planes honest). The restricted dialect is deliberately small to keep the conformant validator decidable
and auditable; if a capability ever needs a constraint the dialect can't express, that is a governance
decision to extend the dialect, not to bypass it.
