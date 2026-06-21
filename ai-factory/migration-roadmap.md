# ADR-0007 capability-migration roadmap (the §8.2 evaluator's closed vocabulary)

> Derived from an exhaustive map of all 9 unmigrated cap validators (workflow `map-cap-dialect-needs`,
> 2026-06-21). Goal: every cap's `/apply` request validated by a language-neutral MANIFEST that is
> byte-identical to the Go agent validator (manifest≡agent), so the config→plan evaluator + whole-node
> apply cover all 13 caps. The dialect (`capmanifest.go` + `capability-manifest.ts`) is a HARD serialization
> point — early waves are sequential; the fan-out is WAVE 3-4.

## Status of caps
- **Migrated + registered:** hostname.set, node.config, time.sync. (services.set in flight — P9-013.)
- **Unmigrated (9):** time.set, update.plan, capsule.registry, accounts.config, identity.attestation,
  backup.policy, storage, network.policy, pds.sync-state.

## KEY PARITY TRAPS (the quality floor — enforce on EVERY contract; see [AGENTS.md](../AGENTS.md))
1. **NEVER reuse the existing weak `noInlineSecrets`** — it (data:/`-----BEGIN`/48-base64 only) is LOOSER
   than the agent's service-grade `containsInlineServiceMaterial` (PEM, key/secret token-assignment with a
   `scheme://` carve-out, 12–24-word seed runs, hex≥32, std+url base64≥48). Build `noInlineMaterial-strong`
   as the canonical reference (WAVE 1) and use it.
2. **NEVER use whole-object `uniqueItems` where `uniqueBy:[field]` is meant** — uniqueItems hashes the whole
   object ⇒ LOOSER (P9-013: services dedups by name only). 
3. **`groups[]` dedups (keep-first), it does NOT reject** ⇒ `uniqueItems` would be STRICTER → use `dedupItems`.
4. **All length caps are Go BYTE length (UTF-8), not UTF-16** `.length`.
5. **`TrimSpace` is Go `unicode.IsSpace`**, not ASCII-only.
6. **Keep runtime/stateful rules OUT of the manifest** (network's ±2h clock skew, pdssync cursor
   non-regression) — they'd make the manifest STRICTER than a single-request validation.
7. All **hard-parity** custom formats (no Go-stdlib oracle) require a FROZEN golden corpus generated from
   the Go validator — the corpus IS the parity contract.

## NEW dialect primitives (build ONCE, each WITH a consuming cap, conformance-validated)
HIGH (shared widely): `stringScreenBundle` (trim-eq / noControlChars / maxBytes / minLength),
`noInlineMaterial-strong`, `uniqueBy:[field]` (P9-013), `forbiddenSchemePrefix`, `rawPattern` (anchored RE2),
`requiredByPresence` (null===absent===required). MEDIUM: `anyOfFormats`, `notInEnum`, multi-key uniqueBy,
`dedupItems`, `exactlyOneOf` (XOR-on-presence), integer sentinel-or-range, item-level forbid-unless
(consumes a format's canonical output), enum-keyed conditional presence (both directions), per-enum
singleton-subset + required-enum-coverage, filtered/scoped uniqueBy. LOW: exclusiveMinimum int64,
`secretKeyNameDenylist` (screens KEY names), embedded-bytes field-name trap (outcome-parity already holds).

## NEW formats
- **Parity-safe (Go-stdlib oracle — build first, proven template):** `rfc3339Instant` (any-offset, via
  `time.Parse(time.RFC3339)` — NOT Z-only), `cidrLiteral` (`net/netip.ParsePrefix`, canonical=Masked()),
  `sriIntegrity` (`encoding/base64`, per-algo 32/48/64 bytes), `shellAllowlistPath` (plain enum).
- **Hard-parity (frozen corpus):** posixAccountName/GroupName (`^[a-z_][a-z0-9_-]{0,31}$`),
  networkInterfaceName, canonicalAbsolutePath, opaqueRef, cron5OrMacro, capsuleId, capsuleVersion,
  bundleRefString, bundleVersionString (≈capsuleVersion — share a template), didPlcOrWeb + atprotoHandle
  (shared identity∥pdssync — build ONCE), keyReference, cidV1Multibase (heaviest decoder).

## WAVE SEQUENCE (minimizes dialect-serialized rounds; ∥ = parallelizable)
- **WAVE 0 — parity-safe formats (sequential, lowest risk, establishes the corpus harness):**
  (a) `rfc3339Instant` + migrate **time.set** (simplest cap — finishes it). (b) `cidrLiteral` (format-only;
  defer network's cross-field). (c) `sriIntegrity` + migrate **capsule** or **update** integrity.
- **WAVE 1 — shared string substrate (sequential, gates nearly everything):** `stringScreenBundle` +
  `noInlineMaterial-strong` (replace the weak one) + `forbiddenSchemePrefix` + `rawPattern`; land with
  **update.plan** (bundleRef/Version) → update FINISHES.
- **WAVE 2 — uniqueBy family:** base `uniqueBy:[field]` (P9-013) landed with **capsule.registry**
  (capsuleId/Version from WAVE 1, sri from WAVE 0) → capsule FINISHES; then multi-key + filtered variants.
- **WAVE 3 — FAN OUT (∥):** **accounts.config** (notInEnum + dedupItems + multi-key uniqueBy +
  posixAccount/GroupName + shellAllowlistPath) ∥ **identity.attestation** (anyOfFormats + keyReference +
  didPlcOrWeb + atprotoHandle). Disjoint → concurrent.
- **WAVE 4 — bespoke primitives WITH hard caps (∥):** **backup.policy** (requiredByPresence + exactlyOneOf
  + opaqueRef + cron5OrMacro) ∥ **storage** (enum-keyed conditional presence + singleton-subset +
  required-coverage + filtered uniqueBy + exclusiveMinimum + canonicalAbsolutePath) ∥ **network.policy**
  (integer-sentinel + item-level forbid-unless-coversAll + networkInterfaceName) ∥ **pds.sync-state**
  (secretKeyNameDenylist + anyOfFormats + cidV1Multibase + shared didPlcOrWeb/atprotoHandle).
  **Hardest, scheduled last:** storage, pds.sync-state, network.policy, backup.policy, identity.attestation.

## Dispatch discipline
Only ONE dialect-touching contract in flight at a time (WAVE 0-2 + the dialect-ext part of 3-4). The
parallel lane opens at WAVE 3 once the shared base exists. Each format/primitive lands WITH its simplest
consumer so the conformance corpus validates it on arrival. Re-dispatch (not hand-merge) to rebase a staler
branch onto newly-merged dialect.
