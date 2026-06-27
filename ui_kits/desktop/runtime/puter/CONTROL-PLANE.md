# Vita control-plane bridge (`/control/*`)

The deploy/management console (`apps/vita-deploy-console`) is a real Puter web app. The puter.js SDK
already gives it a **data plane** (fs / kv / auth) over direct HTTP to the `api_origin`. But managing
the node — listing capsules, starting/stopping them, reading status/health and logs — lives behind
**agentd**, which a sandboxed browser cannot reach (it speaks over a unix socket with peer-credential
auth, `/run/vita-agent/agentd.sock`, ADR-0008).

This bridge closes that gap: a thin, capability-gated set of `api_origin` endpoints under `/control/*`
that the console reaches with the SAME owner bearer token the SDK carries, and that the on-device host
forwards to agentd. Implemented in [`control-plane.ts`](./control-plane.ts); routed + gated in
[`api-origin.ts`](./api-origin.ts).

## Capability gate

Every `/control/*` call is gated on the **`control`** puter capability (added to `PuterCapability` in
[`capability.ts`](./capability.ts), mapped read-write/configuration in
[`permission-model.ts`](./permission-model.ts)). Only the management console's launch session is minted
`control` — default-deny for every other app. Fail-closed: no token → **401**; valid token without the
`control` grant → **403**.

## Endpoints (the console-facing contract)

All responses are JSON. All require `Authorization: Bearer <owner-token>`.

| Method | Path | Returns | Backed by (agentd) |
|---|---|---|---|
| `GET` | `/control/status` | `NodeStatus` — `{ ready, mode, installedCount, runningCount, evalSummary, observedAt }` | `GET /healthz` + `GET /state` (VITA-EVAL / STATE projection) |
| `GET` | `/control/apps` | `{ apps: ConsoleAppView[] }` | `GET /state` → `capabilities["capsule.registry"].capsules` joined with `capsule.execute` status |
| `GET` | `/control/apps/:id` | `ConsoleAppView` (404 if unknown) | as above, filtered |
| `POST` | `/control/apps/:id/start` | `LifecycleResult` — `{ outcome, app, reason? }` | `POST /apply` `[{ capability:"capsule.execute", request:{ desired:{ id, version, integrity } } }]` |
| `POST` | `/control/apps/:id/stop` | `LifecycleResult` | `POST /apply` `[{ capability:"capsule.lifecycle", request:{ desired:{ op:"stop", id } } }]` |
| `GET` | `/control/apps/:id/logs?limit=N` | `{ id, lines: LogLine[] }` (limit ≤ 1000, default 200) | per-capsule journald — **see "Logs endpoint" below** |

### `ConsoleAppView`
```
{ id, version, integrity, installState: "installed"|"disabled",
  running: boolean, health: "OK"|"unhealthy"|"unknown",
  runtime: string, unit: string, dynamicUid: string }
```
A browser-friendly fold of agentd's `CapsuleEntry` (installed registry) + `ExecuteStatus` (live transient
unit), so the UI renders one row per app without joining on the client.

## Two implementations

- **`createStubControlPlane()`** — an in-memory node (seeded with a running ts-service, an installed
  wasm-service, a disabled oci-service). It models the REAL lifecycle: start mints a transient unit +
  `DynamicUser` uid and flips `running`/`health`; stop tears it down; logs grow on each event with the
  real `VITA-CAPSULE-EXECUTED` / `VITA-CAPSULE-STOPPED` markers. This is what the browser verification
  drives — every UI action is a real state transition observed back through the same port. **No VM, no
  socket.**
- **`createAgentHttpControlPlane({ baseUrl, fetch })`** — the production wiring, written against the
  REAL agentd JSON shapes (`/state`, `/read/capsule.execute`, `/apply`, `/healthz`). The on-device
  `api_origin` host process injects the agentd base URL (the host-proxy that fronts the unix socket).

## What is wired to real control-plane data vs stubbed

- **Wired to the real shapes (production path):** the `createAgentHttpControlPlane` client maps directly
  onto agentd's existing endpoints — `GET /state` (capsule.registry + capsule.execute), `POST /apply`
  (capsule.execute / capsule.lifecycle), `GET /healthz`. These endpoints already exist on agentd
  (`agent/transport/server.go`, `agent/capabilities/capsule/*`). The only missing piece for full live
  operation is the host-proxy that exposes agentd's socket as an HTTP `baseUrl` and the logs read below.
- **Stubbed for the browser verification:** `createStubControlPlane` stands in for a live node so the
  console is fully exercisable headless. The console code is identical against either — it only ever
  talks to `/control/*`.

## Logs endpoint — the one new agentd surface needed

agentd does **not** yet expose per-capsule logs over its RPC; capsule logs are captured by journald per
transient unit (queryable on-device with `journalctl -u <unit>`). To back `GET /control/apps/:id/logs`
on a live node, agentd needs a small read capability:

```
GET /read/capsule.logs?id=<capsule-id>&limit=<n>
→ { "lines": [ { "ts": ISO8601, "level": "info"|"warn"|"error", "message": string }, ... ] }
```

implemented as a journald tail of the capsule's transient unit (bounded, owner-gated, same peer-cred
auth as the rest of agentd). Until it lands, `createAgentHttpControlPlane.logs()` degrades gracefully
(returns one explanatory line), and the stub synthesizes a realistic journal so the console's log view
is verifiable today.

## Exact platform endpoints the console needs (summary for the platform team)

1. **Already present on agentd** (just need a host-proxy `baseUrl` to expose them to the `api_origin`
   host process): `GET /healthz`, `GET /state`, `GET /read/capsule.execute`, `POST /apply`.
2. **New, small, to add to agentd:** `GET /read/capsule.logs?id=&limit=` (journald tail, owner-gated).
3. **In this PR (the `api_origin` side):** the `/control/*` routes + the `control` capability gate +
   the `AgentControlPlane` port with both impls.
