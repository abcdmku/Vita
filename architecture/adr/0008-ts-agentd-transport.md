# ADR-0008 — TS runtime ↔ agentd transport: unix domain socket

- Status: ACCEPTED (2026-06-23)
- Deciders: orchestrator (architecture); recorded in `ai-factory/STATE.md`
- Risk: R2 (design decision for the unprivileged↔privileged channel; no privileged code merged by this ADR)
- Related: [[vita-boot-chain-blocked]]; spec §3.10/§9 (privilege split), §16 (keys withheld); the wave-2/3 frontier map.

## Context
The on-device TypeScript runtime (P1-030/033/034) runs **unprivileged** under a hardened systemd sandbox —
`os/x86_64/ts-overlay/usr/lib/systemd/system/vita-ts.service` sets `RestrictAddressFamilies=AF_UNIX`. To read host
state and **apply** config it must talk to **agentd**, the narrow **privileged** executor (the only component allowed
to mutate the host, per the spec/ADR split). But agentd today binds **TCP only** — `agent/cmd/agentd/main.go:30`
`listenAddr = "127.0.0.1:8786"`. TCP loopback requires `AF_INET`, which the runtime's `AF_UNIX`-only sandbox **kills
at the syscall layer**. So the channel does not exist yet, and a transport must be chosen. Two options:

1. **Unix domain socket** — agentd exposes a loopback unix socket; the runtime connects via `AF_UNIX` (already
   allowed in its sandbox).
2. **Re-allow `AF_INET`** — add `AF_INET` + `--allow-net=127.0.0.1:8786` to the runtime unit and keep agentd's TCP.

## Decision
**Unix domain socket** at `/run/vita-agent/agentd.sock`, owned by root, permissioned so ONLY the TS runtime's
identity can reach it (the agentd `RuntimeDirectory=vita-agent` at mode 0710 + a shared group, or 0660 socket with a
group the DynamicUser is in — S1 picks the exact mechanism). agentd gains a unix listener serving the SAME HTTP API
it already serves over TCP. The runtime connects with Deno's unix transport and `--allow-read`/`--allow-write`
**scoped to the exact socket path** (NOT `--allow-net`). `RestrictAddressFamilies=AF_UNIX` is KEPT.

## Rationale
- **Keeps the hardened sandbox intact.** No `AF_INET` is re-opened in the unprivileged runtime — its network reach
  stays zero. The whole point of the sandbox is preserved.
- **Filesystem-permissioned access control.** A unix socket is reachable only by processes with FS access to the
  path; a TCP loopback port is reachable by *any* local process. The socket is the tighter boundary for an
  **unauthenticated** channel (see Unknowns).
- **agentd stays loopback-pure** for local control — no network listener required for the on-device path.
- **Spike-confirmed (2026-06-23):** the pinned on-device Deno (`/usr/lib/vita/deno`) supports `Deno.connect({
  transport:"unix"})` and `Deno.listen` unix UNDER `--no-remote` with `--allow-read`/`--allow-write` scoped to the
  exact socket path — `DENO-UNIX-SPIKE: echo=PING support=YES` (also passes scoped to the parent dir). So the
  tightest Deno permission (the exact socket path) is viable.

## Consequences
- **S1 (R3):** agentd adds a unix listener at `/run/vita-agent/agentd.sock` alongside (or, for local, instead of)
  the TCP listener; the agent-overlay unit gets `RuntimeDirectory=vita-agent` with the right mode/group; the TS unit
  adds `--allow-read=/run/vita-agent/agentd.sock --allow-write=/run/vita-agent/agentd.sock` and keeps every hardening
  knob. Proof marker `VITA-CONNECT: transport=unix peer=agentd healthz=OK status=OK`.
- The TCP listener may remain for dev/off-device tooling but SHOULD be off-by-default / gated for the on-device image
  (S1 decides; prefer unix-only on-device).
- S2 (read `/state`) → S3 (apply) ride this socket.

## Honest unknowns / out-of-scope (filed, not in wave 2/3)
- **No authentication yet** (`main.go:72` "no auth wired"). On-device, the ONLY control is the socket's FS perms +
  loopback. Acceptable for the current single-tenant on-device posture, BUT a future hardening slice MUST add
  peer-credential auth (`SO_PEERCRED` on the unix socket) so only the intended runtime UID can issue mutations. This
  ADR explicitly notes that the mutating capabilities (S3 apply, later writes) ride an unauthenticated channel
  guarded only by transport perms until then.
- **Daemon mode** (runtime reacts to config changes live) is a different unit shape — the runtime stays
  `Type=oneshot` (apply-at-boot) for this wave.
