# ADR 0012: Hostile-Capsule Network Enforcement Gate (FR-011, Phase-4 exit, S5)

Status: **PROPOSED**

## Context
Per-capsule networking landed and was MEASURED in stages on the Go agent
(`agent/capabilities/capsule/`): **S1** grant validation, **S2** per-capsule network namespace
loopback-isolation (`netns_linux_test` proves a capsule sees only its own loopback), **S3**
default-deny egress (nft drop unless a grant permits), **S4** host-local ingress as DNAT into the
capsule veth scoped strictly to granted ports (`ingress.go`). The deterministic per-unit addressing
in `egress.go` (`capsuleEgressIPv4Pair` → `sha256(unitName)` → `169.254.{64+}.x/30` + `vh*/vc*/vita_*`
ids) gives every capsule a collision-resistant veth pair + nft table.

What is NOT yet proven is the **adversarial** property that FR-011 (the Phase-4 exit gate) requires: a
**deliberately hostile capsule** must be *provably contained* by the S2/S3/S4 mechanisms — not merely
that a well-behaved capsule stays in its lane. The exit gate is an attack, measured.

## Decision
Define the hostile-capsule enforcement gate as a **measured adversarial boot test**: launch a hostile
capsule **co-resident** with a benign victim capsule, have the hostile workload actively attempt to
escape, and assert via measured witnesses that every escape attempt is BLOCKED, the victim stays
healthy, and the node control plane is unperturbed.

### Threat vectors the hostile capsule MUST attempt (each measured)
1. **Undeclared egress** to a known-denied CIDR (e.g. `198.51.100.254`) over TCP/UDP — must be dropped
   by the S3 default-deny egress nft ruleset (the capsule declares NO egress grant).
2. **Undeclared inbound** — listen/connect outside its own netns; reaching anything beyond loopback
   must fail (S2 netns isolation).
3. **Lateral probe** to a co-resident victim's host-veth `169.254.x` address + port via normal connect
   AND via ARP / raw-socket — must not reach the victim's netns (S2 + the /30 per-unit isolation, with
   no host-side route bridging the two capsule veths).
4. **Host-loopback agentd reach** — connect to the host control plane on `127.0.0.1:8786` — must be
   unreachable from inside the capsule netns (S2; the agentd socket is host-namespace only).

### Measured negative witnesses (fail-closed)
Each adversarial action records its outcome to a netns-internal proof file (read back via
`readCapsuleNetnsProof`). The gate PASSES only when **all** of:
`{deniedEgress: BLOCKED, undeclaredInbound: BLOCKED, victimLateral: BLOCKED, agentdLoopback: BLOCKED}`
are measured BLOCKED, the victim capsule's health remains OK throughout, and the agentd control plane
answers normally after the hostile run. Any probe/dial that SUCCEEDS, any unread proof, or any missing
witness is an immediate FAIL (FAILSAFE) — the gate never passes on absence of evidence.

### Marker contract
On full containment the on-device runtime emits exactly:

```
VITA-CAPSULE-NET-HOSTILE: contained=OK survived=OK status=OK
```

`contained=OK` ⇒ all four escape vectors measured BLOCKED; `survived=OK` ⇒ victim + control plane
healthy after the run. A reject/failsafe path emits `status=FAILSAFE reason=…`. The QEMU/VMware
host-verify harness greps for this exact line as the FR-011 Phase-4-exit witness.

## Isolation mechanisms relied upon (already merged + measured)
- **S2 netns loopback-isolation** — `netns_linux_test` (the capsule sees only its own loopback).
- **S3 default-deny egress** — the per-capsule nft drop ruleset in `egress.go`.
- **S4 host-local ingress DNAT scoping** — `ingress.go` (only granted host ports DNAT into the veth;
  denied ports never present in host or netns tables).
- **Per-unit address determinism** — `capsuleEgressIPv4Pair`/`capsuleEgressNames` (non-overlapping
  `/30` blocks + unique table/veth ids for co-resident capsules).

## Slice breakdown (S5)
- **PSD-606** — hostile fixture workload (the four attempts, recording proof; declares NO grants).
- **PSD-607** — the agent-side gate evaluator + the `VITA-CAPSULE-NET-HOSTILE` marker.
- **PSD-602** — co-resident multi-capsule non-collision proof (no address aliasing under simultaneous launch).

## Consequences
Passing this gate is the Phase-4 exit: per-capsule networking is not just *configured* but *enforced
against an adversary*. It is fail-closed by construction (absence of a BLOCKED witness fails the gate),
and it composes with the existing S1–S4 markers without weakening any of them.
