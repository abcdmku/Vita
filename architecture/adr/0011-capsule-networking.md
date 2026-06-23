# ADR-0011 — Capsule networking: per-capsule netns + manifest-driven default-deny

Status: **ACCEPTED** — owner signed off 2026-06-23 ("do them all"): the capsule-networking attack surface (agentd
configures kernel nft/netns/DNAT; `public` ingress exposes a node port; widened RestrictAddressFamilies) is ACCEPTED
and ALL slices S1-S5 are greenlit to build. The S5 hostile-capsule enforcement proof on a real verity boot remains a
BLOCKING build-precondition before untrusted capsules receive network grants (it is a slice to BUILD+VERIFY, not a
decision to ask) — mirroring ADR-0010 slice 5 before untrusted OCI. Spec §21 Phase 4 "network grants" + FR-011 gate. Date 2026-06-23.

## Context
Waves 4-5 run capsules but they are network-mute: every capsule unit is launched `RestrictAddressFamilies=AF_UNIX`.
The manifest already carries fully-validated `NetworkPolicy{ingress[],egress[]}` / `CapsuleNetworkGrant{direction,
protocol,ports,destination,public}`, but NOTHING wires them to a kernel enforcer (`agent/capabilities/network/network.go`
writes a policy JSON and invokes no nft/veth/netns). FR-011 (Phase-4 exit) requires: an untrusted package gets its
DECLARED network and ONLY that. So a capsule that declares grants must get them, default-deny everything else.

## Decision
agentd composes a **per-capsule Linux network namespace** for any capsule with network grants, **default-deny**, with
explicit per-grant allows enforced by the **kernel**: nftables (`policy drop` + appended allows) for egress, agentd-managed
veth/forward + DNAT for ingress. The unprivileged runtime only PROPOSES (`{id,version,integrity}`); agentd derives the
ENTIRE network config from the re-validated on-disk manifest — never runtime text. Capsules with NO grants keep
`AF_UNIX` (fully network-mute — unchanged). DNS = fixed forward to the node resolver (no arbitrary outbound DNS). v1
egress destinations = **CIDR/IP only** (hostname egress deferred — TOCTOU/rebinding). Reuses the proven
`network.go` `normalizeCIDR`/`sourceCoversAll` wide-open guard/`validInterfaceName`/`PortAll` validators verbatim.
Same Vita patterns as ADR-0009/0010: manifest-only composition, unprivileged-proposes/privileged-validates, kernel as
enforcer, offline, immutable rootfs (per-capsule net state under ephemeral `/run/vita-agent/netns/<unit>/`), and
MEASURED host-verify markers (the P1-055 lesson: the marker reflects the WORKLOAD's measured reachability + an
independent host-side probe of denials, never a synthesized agentd claim).

## New attack surface — OWNER sign-off flags
First privileged path granting attacker-influenced workloads network reachability (vs the AF_UNIX backstop):
(a) agentd configures KERNEL networking (nft+netns+DNAT) — a single default-deny ruleset builder, allows only from
allowlisted/canonicalized fields. (b) `public:true` INGRESS exposes a node port on the real interface — the
highest-risk grant; must be explicit + composed against the owner's node `network.policy` (refused if the node forbids)
+ a declared interface. (c) Egress can exfiltrate → CIDR-only v1, default-deny. (d) DNS fixed-forward. (e) Widening
`RestrictAddressFamilies` to AF_INET/INET6/NETLINK for granted capsules removes a coarse backstop → containment rests
on netns + nft holding → MUST be re-verified against a HOSTILE capsule (S5) on a real verity boot.

## Slices (smallest-first; each QEMU-boot-verifiable; VITA-CAPSULE-NET-* markers, measured)
- **S1 (P1-057, SAFE, no behavior change):** add `Network` to `ExecutionManifest` + agentd allowlist validation
  (reuse `network.go` validators). No namespace. Absent network = today's behavior. `VITA-CAPSULE-NET-PARSE` + reject.
- **S2 (SAFE — isolation only):** per-capsule ephemeral netns + loopback-only, widen RestrictAddressFamilies, undo
  teardown. NO external reachability. `VITA-CAPSULE-NET-NS: … loopback=OK isolation=enforced`.
- **S3:** default-deny egress + explicit CIDR allow via nftables `policy drop` + veth/NAT + DNS forward.
  Hostile-probe capsule: reaches allowed dest:port, REFUSED on denied. `VITA-CAPSULE-NET-EGRESS: … default=deny`.
- **S4 (OWNER-GATED):** ingress/port DNAT; `public` composed against node policy + declared iface.
  `VITA-CAPSULE-NET-INGRESS`.
- **S5 (OWNER-GATED — the gate):** HOSTILE capsule on a real verity boot — every denial holds at the kernel.
  `VITA-CAPSULE-NET-LIMITS: egress=enforced ingress=enforced isolation=enforced`. Precondition for untrusted+network.
- **S6 (deferred):** controller network previews; hostname-egress (pin-at-apply); conntrack/rate DoS caps.

## Critical files
`agent/capabilities/capsule/execute.go` (ExecutionManifest.Network + conditional RestrictAddressFamilies + compose/undo;
+ oci.go shares the profile); `agent/capabilities/network/network.go` (reuse the proven validators + the node policy
`public` composes against); new `agent/capabilities/capsule/netns.go` (the netns lifecycle + the single default-deny
nft ruleset builder); `sdk/manifests/src/package-contract.ts` + `storage/capsules/src/capsule.ts` (schema round-trip,
ADR-0007 parity); `os/x86_64/mkosi.conf` (nftables) + the baked network + hostile-probe test capsules.
