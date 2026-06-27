# Vita Terminal — the EXEC/PROCESS plane

The Terminal gives Vita the "real machine access" the product vision wants: a real terminal in the
browser, wired to a shell on the node, gated by a new capability and isolated in a hardened capsule.
This is the security + wiring reference. Code: `exec-plane.ts`, the `/pty` websocket in `server.ts`,
the `exec` capability in `capability.ts` / `permission-model.ts`, and the Terminal app at
`apps/terminal/index.html` (xterm.js, vendored under `_vendor/xterm/`).

## The two planes (recap)
The data plane (fs/kv/auth) is direct-HTTP (`api-origin.ts`); the control plane (list/start/stop
capsules) is `/control/*`. The **exec plane** is a third surface: a **`/pty` websocket** that streams a
process's stdin/stdout/stderr. It is the most privileged compat surface — it spawns a process on the
node — so it has its own capability and its own default-deny gate.

## Security model

### The grant — `exec`
A new `PuterCapability`: `exec`. It is **default-deny**: an app holds it only if it was *explicitly*
granted `exec` at launch (the Terminal app). No ordinary Puter app — and not the local kiosk session —
carries `exec` unless the owner opts it in. In the broker model (`permission-model.ts`) `exec` is a
**read-write configuration-class** capability, scoped + gated exactly like `control`.

### The gate (fail-closed, before any process starts)
`server.ts` handles the `/pty` websocket **upgrade**:
1. If no exec backend / capability registry is wired, `/pty` is **not mounted** → upgrade refused (404).
2. The network face's owner-auth gate runs first (remote face must present the owner token).
3. The token is resolved (query `auth_token`, since a browser WebSocket can't set headers; a bearer
   header is also accepted for non-browser clients). Unknown/missing → **401, no 101**.
4. The token's app must hold `exec` → otherwise **403, no 101**.
Only after all four does the handshake complete (101) and a session open. An ungranted app's WebSocket
sees the connection refused **before `open`** (the browser surfaces a 1006 close) — proven in the
browser verification.

### Capsule isolation — what a command can / can't reach
On-device (`createAgentExecBackend`), a `/pty` session runs inside a **hardened, cgroup-gated capsule**
launched through agentd — the SAME ts/OCI/WASM runtimes the rest of the OS uses
(`agent/capabilities/capsule/execute.go`). That sandbox is, per `memory vita-boot-chain-blocked`:
- **DynamicUser** (ephemeral uid/gid per launch; no static account), **NoNewPrivileges**, empty
  **CapabilityBoundingSet**.
- **ProtectSystem=strict**, **ProtectHome**, **PrivateTmp**, **PrivateDevices**, **RestrictNamespaces**.
- **SystemCallFilter=@system-service**, **RestrictAddressFamilies=AF_UNIX** (no network unless granted).
- cgroup v2 gates: **MemoryMax**, **CPUQuota**, **TasksMax** — a runaway command is throttled, not the
  host.
- A **read-only rootfs**; writes only to the capsule's own scratch. The command **cannot** read the
  owner's files, other capsules, secrets/keys (spec §16), or the host filesystem; **cannot** escalate
  privilege; **cannot** open the network unless the capsule was granted egress.

The dev-host backend (`createDevExecBackend`, used in the preview/verification) is **not** that boundary
— it is a convenience sandbox so the terminal is exercisable without a VM: it runs an **allow-listed**,
read-only command set (`ls echo cat pwd env whoami date head wc uname hostname`) with **no shell**, a
**scrubbed env** (only PATH/HOME/PWD/TERM), a **private throwaway cwd**, and **wall-clock + output
caps**. Anything off the allow-list is refused (command-level default-deny). The capability gate is
identical on both backends.

## Wire protocol (`exec-plane.ts`)
```
client → server : {t:"stdin",data} | {t:"resize",cols,rows} | {t:"signal",signal}
server → client : {t:"ready",runtime,capsule,cwd} | {t:"stdout",data} | {t:"stderr",data}
                  {t:"exit",code,signal?} | {t:"error",message}
```
`decodeClientMessage` validates every inbound frame fail-closed (unknown type / wrong shape → dropped).

## What is wired vs what needs a boot
**Wired + verified now (no VM):**
- The `exec` capability + default-deny gate (`capability.ts`, `permission-model.ts`).
- The `/pty` websocket: handshake, capability gate (401/403), RFC-6455 frame codec, session bridge
  (`server.ts`).
- The exec wire protocol + the dev-sandbox backend running **real** processes (`exec-plane.ts`).
- The Terminal app (xterm.js) connecting `/pty`, running `echo`/`pwd`/`ls`/`cat`/`date`, rendering real
  output, and showing the denial when ungranted.
- Verifications: `spike/headless-exec.ts` (Node WS, 9/9) and `spike/verify-terminal.mjs` (real headless
  Chrome, 10/10 — granted runs commands; ungranted is refused).

**Wired now (the production path — see CAPSULE-EXEC.md):**
- The agentd **`capsule.exec`** capability EXISTS (`agent/capabilities/capsule/exec.go`): it runs an
  arbitrary interactive command WITH A PTY inside a one-shot hardened transient unit (the SAME hardening
  `capsule.execute` composes), grant/peer-cred gated, NO network. The streaming **`/pty`** endpoint on
  agentd's unix socket (`agent/transport/pty.go`) carries the duplex frames.
- `createAgentExecBackend` is WIRED: it forwards each `/pty` websocket session to agentd's streaming
  `/pty` over the host-proxy (`server/agentd-host-proxy.ts createAgentdPtyStream`), bridging the JSON
  protocol to the binary frames. **The on-device service now uses this backend, NOT the dev sandbox**
  (`server/server-entry.ts`). The dev sandbox is a build-host-only spike harness.

**Needs the batched Borg51 boot (flagged):**
- The end-to-end RUN of a real command in a real hardened PTY capsule on the node (PTY allocation +
  seccomp + DynamicUser only exist on a live linux+systemd node), and the on-device assertion of the
  `VITA-NODE-FIREWALL` marker now routed to the serial console. The host build proves the wiring +
  isolation composition + the frame contract (Go + TS tests); the boot proves it runs + survives.
