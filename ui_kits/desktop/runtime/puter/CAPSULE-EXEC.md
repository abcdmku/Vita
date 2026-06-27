# `capsule.exec` — the on-device hardened terminal backend

This is the PRODUCTION wiring for the Terminal's exec/process plane (EXEC-PLANE.md). It replaces the
build-host dev sandbox (`createDevExecBackend`) with a REAL, hardened, cgroup-gated capsule launched
through agentd. The dev sandbox stays a build-host-only spike harness; it is no longer wired in the
on-device service.

Files:
- Go: `agent/capabilities/capsule/exec.go` (the `capsule.exec` capability + the PTY-backed hardened
  transient unit), `agent/transport/pty.go` (the streaming `/pty` endpoint over agentd's unix socket).
- TS: `exec-plane.ts` `createAgentExecBackend` (now wired), `server/agentd-host-proxy.ts`
  `createAgentdPtyStream` (the duplex unix-socket forwarder), `server/server-entry.ts` (production now
  builds the agentd backend, not the dev sandbox).

## Why a new surface (not `capsule.execute`)

`capsule.execute` launches a FIXED-entrypoint installed capsule (ts/oci/wasm service) and returns once;
it is a request/response transaction. A terminal needs (a) an ARBITRARY interactive command, (b) a TTY,
(c) DUPLEX byte streaming (keystrokes in, output out, window-resize) for the life of the session. That
does not fit the one-shot `/apply` transaction model, so `capsule.exec` is its own capability with its
own streaming transport endpoint. It REUSES the same hardening primitives as `capsule.execute`
(`hardenedTransientUnitProperties` + the cgroup gates), so the isolation guarantees are identical.

## Security / isolation model (what a command can and cannot reach)

Every `capsule.exec` session runs the command inside a one-shot systemd transient unit composed from the
SAME hardened property set the rest of the OS uses (`hardenedTransientUnitProperties`):

- **DynamicUser=yes** — an ephemeral uid/gid per launch; no static account, nothing owned on disk.
- **NoNewPrivileges=yes**, **CapabilityBoundingSet=** (empty), **AmbientCapabilities=** (empty),
  **RestrictSUIDSGID=yes** — cannot gain privilege; setuid binaries cannot escalate.
- **ProtectSystem=strict** + **ProtectHome=yes** — the entire filesystem is READ-ONLY to the command,
  and the owner's home is invisible. The command cannot read the owner's files, other capsules' state,
  or any secret/key (spec §16). Writes are refused everywhere except the unit's own private scratch.
- **PrivateTmp=yes**, **PrivateDevices=yes**, **ProtectProc=invisible**, **ProtectControlGroups**,
  **ProtectKernel{Tunables,Modules,Logs}=yes**, **ProtectClock/Hostname=yes**,
  **RestrictNamespaces=yes**, **RestrictRealtime=yes**, **LockPersonality=yes** — no other process tree,
  no host devices, no kernel-surface tampering.
- **RestrictAddressFamilies=AF_UNIX** by default (NO network). The exec capsule is launched with NO
  network grant, so it cannot open AF_INET/AF_INET6 sockets — it cannot reach the network. (A future
  network-granted terminal would thread a per-capsule netns exactly as `capsule.execute` does; this
  slice ships the no-network default, which is the strict floor.)
- **SystemCallFilter=@system-service** minus `@privileged @resources @mount @swap @reboot @raw-io
  @cpu-emulation @obsolete` — seccomp default-deny of the dangerous syscall classes.
- cgroup v2 resource gates: **MemoryMax**, **CPUQuota**, **TasksMax** — a runaway/fork-bombing command
  is throttled/killed by the cgroup, never the host. The exec capsule pins conservative defaults
  (256 MiB / 50% of one core / 64 tasks).
- The shell run is a fixed, vetted argv (`/bin/sh -i` under the PTY); the USER's keystrokes are written
  to the PTY master as stdin — they are never interpolated into the launch command line, so there is no
  command-injection surface in the launcher itself.

What a command therefore CANNOT do: read owner files / other capsules / secrets / host fs; write
anywhere but its private scratch; open the network; escalate privilege; mount; tamper with the kernel;
exhaust host memory/CPU/PIDs; or see/signal any process outside its own unit.

### Gating (fail-closed, owner-only)

Two independent gates, both fail-closed:
1. **Transport peer-cred gate** — the `/pty` endpoint is served ONLY on agentd's unix socket, which is
   SO_PEERCRED-authenticated to the `vita-agent` group (the platform process). A peer not in that group
   never reaches the handler (the same auth as every other agentd surface). There is no TCP `/pty`.
2. **Platform `exec` capability gate** — the api_origin's `/pty` websocket already requires the `exec`
   capability (default-deny; only the Terminal app holds it). The platform forwards to agentd's `/pty`
   ONLY after that gate passes. So the chain is: owner token → app holds `exec` → platform → agentd
   peer-cred → hardened capsule. A request that fails ANY hop never starts a process.

## Streaming transport

agentd's normal surface is buffered request/response. `/pty` is the one streaming endpoint: the platform
opens a unix-socket connection, sends `GET /pty?...` with an `Upgrade: vita-pty` header, agentd replies
`101` and the connection becomes a raw duplex byte stream carrying length-prefixed frames:

```
frame = uint8 type | uint32be length | length bytes payload
  type 0x01 STDIN   (client→agentd)  raw bytes written to the PTY master
  type 0x02 RESIZE  (client→agentd)  payload = uint16be cols | uint16be rows
  type 0x03 STDOUT  (agentd→client)  raw PTY output bytes
  type 0x04 EXIT    (agentd→client)  payload = int32be exit code
  type 0x05 ERROR   (agentd→client)  payload = utf-8 message (could not start)
  type 0x06 READY   (agentd→client)  payload = utf-8 runtime label (capsule unit name)
```

The TS `createAgentExecBackend` bridges the api_origin's JSON `/pty` websocket protocol
(`{t:"stdin"|"resize"|"signal"}` ⇄ `{t:"stdout"|"exit"|"ready"|"error"}`) to these frames over the
unix-socket stream. The dev-sandbox line-runner protocol is unchanged; only the backend differs.

## What is wired vs what still needs a boot

WIRED + verified off-VM:
- The `capsule.exec` capability + the hardened-unit composition (Go unit tests assert the property set,
  the no-network default, the cgroup gates, grant-gating, and fail-closed start errors).
- The streaming `/pty` frame codec on both sides (Go + TS unit/contract tests round-trip the frames).
- `createAgentExecBackend` ⇄ host-proxy forwarding (TS contract test against a fake agentd `/pty` that
  echoes frames; the production service builds the agentd backend, NOT the dev sandbox).
- The `VITA-NODE-FIREWALL` serial marker routing (`StandardOutput=journal+console` on the unit).

NEEDS the batched Borg51 QEMU boot (flagged):
- The end-to-end run of a REAL command in a REAL hardened capsule with a live PTY on the node, and the
  on-device assertion of the firewall marker on the serial console. Building/seccomp/PTY allocation
  only exist on a real systemd+linux node; the host build proves the wiring + isolation composition, the
  boot proves it runs.
