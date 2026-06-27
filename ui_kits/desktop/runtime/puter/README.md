# Vita ⇄ puter.js app-platform compat layer (SPIKE)

Run **real Puter web apps** AND **native TS apps** against ONE local, capability-gated backend, inside
Vita's own shell. This is the foundation of Vita's "Run" pillar. See the design in
[`architecture/puter-compat-layer.md`](../../../../architecture/puter-compat-layer.md).

> Status: SPIKE — preview-verified end-to-end. Real, integratable runtime modules (not throwaway).
> The api_origin store is behind a small interface so it can later be served on-device by the
> host-proxy.

## The two planes (verified against the vendored puter.js, 2026-06-26)

A Puter app is a web page in a sandboxed iframe launched with `puter.*` URL params. It reaches Vita on
two planes:

```
[ managed Vita window ]                         web-app-window.ts builds the launch URL
  └─▶ [ iframe: Puter app + vendored puter.js ]
         │  puter.ui.*  ── postMessage ──▶ [ ui-broker.ts ] ─▶ WM title / notifications
         │  fs/kv/auth  ── HTTP ──────────▶ [ api-origin.ts ] ─▶ store.ts  (capability-gated)
         ▼                                          ▲
   native VitaApp ── in-process (native.ts) ────────┘  (SAME store, SAME capability gate)
```

- **Control plane (`puter.ui.*`)** → `postMessage` to the parent. Handshake `{msg:'READY', appInstanceID}`
  (parent marks attached, sends **no INIT**). Envelope `{msg, env:'app', appInstanceID, uuid, …}`;
  reply carries `original_msg_id == uuid`. → `ui-broker.ts`
- **Data plane (`fs`, `kv`, `auth`)** → direct HTTP to `puter.api_origin` (our local origin).
  → `api-origin.ts` + `store.ts`

## Modules (all strict-TS, no DOM-lib dependency in the core)

| file | role |
|---|---|
| [`store.ts`](store.ts) | the SHARED fs+kv backing (in-memory or node-fs). Behind a small interface for the on-device host-proxy. |
| [`capability.ts`](capability.ts) | the token→app→grants gate (fail-closed). `UNAUTHENTICATED` (401) vs `CAP_DENIED` (403). |
| [`api-origin.ts`](api-origin.ts) | the local REST surface (`/batch /read /readdir /stat /mkdir /delete /drivers/call /whoami /rao`), transport-agnostic. |
| [`ui-broker.ts`](ui-broker.ts) | the `puter.ui.*` postMessage parent (READY attach, validation, `original_msg_id` correlation). |
| [`web-app-window.ts`](web-app-window.ts) | mounts a Puter app (sandboxed iframe) into a managed WM window; mints the session + builds the launch URL. |
| [`launch-url.ts`](launch-url.ts) | builds/parses the `puter.*` launch params. |
| [`native.ts`](native.ts) | the `@vita/puter` in-process binding for native VitaApps (same store, same gate). **P2**. |
| [`server.ts`](server.ts) | node:http / node:https adapter (the face server; plain on the local face, TLS on the network face). |
| [`server/`](server/) | the CONSOLIDATED, WM-free **server spine**: [`service.ts`](server/service.ts) (the on-device dual-face service runner), [`tls.ts`](server/tls.ts) (in-process native TLS), [`index.ts`](server/index.ts) (the server barrel — excludes the WM-coupled `web-app-window.ts`). The launch contract is [`server/LAUNCH.md`](server/LAUNCH.md). |
| [`_vendor/puter/`](../../_vendor/puter/) | the vendored Apache-2.0 puter.js client SDK (offline, checksum-pinned). |

## Protocol notes baked into `api-origin.ts` (learned from the live SDK)

The genuine SDK is messier than the doc summary; the api_origin handles all of it:
- **Auth is presented THREE ways**: `Authorization: Bearer` header (`/batch`, `/mkdir`, `/delete`,
  `/whoami`, `GET /read`); an `auth_token` field IN THE BODY (`/readdir`, `/stat`, `/drivers/call` —
  those XHRs send no bearer); or an `auth_token` query param.
- **`fs.write` uses a multi-step "signed batch" first** (`POST /fs/startBatchWrite`). That's cloud-only;
  we return a non-array so the SDK falls back to the legacy multipart `POST /batch` we implement.
- **A write op is `{op:'write', path:<DIRECTORY>, name:<leaf>}`** — `path` is the parent dir, `name` the
  filename. (Not a full path.)
- **`fs.read` is `GET /read?file=<path>`** — path in the `file` query param.
- **`setWindowTitle` sends `{new_title}`** (not `title`).
- **`ui.alert` renders the SDK's own local `<puter-alert>`** — it does NOT broker to the parent (that's
  fine; the broker handles the messages that ARE posted: setWindowTitle, showNotification, launchApp, …).

## Preview-verify (owner: the live check)

1. **Build the preview bundle** (offline deno bundle of the real WM + web-app host + broker):
   ```
   node ui_kits/desktop/runtime/puter/spike/build-preview.mjs
   ```
2. **Start the harness** (serves the desktop preview + vendored puter.js + spike app + api_origin):
   ```
   node --experimental-strip-types ui_kits/desktop/runtime/puter/spike/serve-spike.ts --port 8188
   ```
3. **Open the desktop preview**:
   ```
   http://127.0.0.1:8188/spike/desktop.html
   ```
   A managed dark Vita window opens hosting the Puter app. Expected: the in-window log shows
   **6/6 checks passed** (fs.write+read, fs.readdir, kv.set+get, auth.whoami, ui.alert,
   ui.setWindowTitle), the broker-log panel shows `setWindowTitle: Vita Puter Spike OK`, and the
   **window title bar changes to "Vita Puter Spike OK"** (proof the ui broker reached the WM).

## Self-tests (CI)

```
# strict typecheck (core modules + harness)
node node_modules/typescript/lib/tsc.js --noEmit -p tsconfig.json
node node_modules/typescript/lib/tsc.js --noEmit -p ui_kits/desktop/runtime/puter/tsconfig.spike.json

# unit/integration tests (api_origin + ui-broker + store/native/launch-url + web-app host) — 42 tests
node --experimental-strip-types --test sdk/typescript/test/ui-kits/puter-*.test.ts

# headless end-to-end against the api_origin module over real HTTP (incl. P2 shared store) — 9 checks
node --experimental-strip-types ui_kits/desktop/runtime/puter/spike/headless-spike.ts
```

## On-device wave (DONE in this branch — the dual-face backend)

The spike's in-memory store + grant-all gate have been replaced with REAL persistence + REAL
enforcement, served on TWO reachability paths over ONE backend:

| concern | spike | now |
|---|---|---|
| store | in-memory / temp dir | [`fs-store.ts`](fs-store.ts) — file-backed under `<appsRoot>/<appId>` (default `/var/lib/vita/apps`), survives a process/service restart. |
| enforcement | grant-all session token, set-membership check | [`permission-model.ts`](permission-model.ts) — the capability gate DELEGATES to the platform `runtime/permission-broker` (`decideGrants`) against a per-app declared-grant policy. Ungranted → `CAP_DENIED` 403, fail-closed. |
| reachability | single loopback listener | [`backend.ts`](backend.ts) — `startDualFaceBackend` binds a LOCAL (kiosk, trust-on-host) face AND a NETWORK (remote, owner-token) face over ONE store + ONE gate. |
| local renderer | custom CEF/OSR compositor | a STOCK kiosk browser (`cage` + `chromium --kiosk`) — see [`KIOSK.md`](KIOSK.md) + [`kiosk-entry.html`](kiosk-entry.html). No custom compositor. |
| fs ops | write/read/readdir/stat/mkdir/delete | + `rename`/`move` (store + `/rename` `/move`), + `/df` (the SDK's pre-write quota check). |

Verify (no VM boot needed):
```
# the dual-face proof: persistence-across-restart, 403/grant enforcement, local+network on ONE store,
# breadth ops (write/read/readdir/stat/mkdir/delete/rename + kv get/set/del/list + whoami) — 17 checks
node --experimental-strip-types ui_kits/desktop/runtime/puter/spike/dual-face-harness.ts

# informational: load the GENUINE bundle headless + report what it demands (non-fatal probe)
node --experimental-strip-types ui_kits/desktop/runtime/puter/spike/real-sdk-harness.ts

# unit/integration for the new persistence + enforcement + dual-bind paths — 16 tests
node --experimental-strip-types --test sdk/typescript/test/ui-kits/puter-ondevice.test.ts
```

## The consolidated SERVER SPINE (`server/`)

The server side of the platform — everything needed to SERVE it (data plane + enforcement +
persistence + dual-face + TLS + the on-device service runner) — is consolidated under
[`server/`](server/) with **no compositor / CEF / window-manager dependency**:

- [`server/service.ts`](server/service.ts) — `startPuterPlatformService({ mode, appsRoot, ... })`: ONE
  service for all three Vita modes. Opens the REAL `/var/lib/vita/apps` store, wires the broker
  permission model into the **single shared registry** (the host mints owner + per-app tokens
  in-process; the same-process api_origin honors them — no cross-process token injection), binds the
  faces the mode calls for, and serves the kiosk entry + vendored SDK.
- [`server/tls.ts`](server/tls.ts) — in-process native TLS for the network face. **Decision:** native
  `node:https` (and `Deno.serveTls` on-device), NOT a reverse proxy (caddy) — leaner + more secure for
  a single self-hosted node (no extra vendored/signed binary in the verity image, no second hop, no
  ACME). Owner-provided cert+key wins; else a valid self-signed X.509 is generated from `node:crypto`.
- [`server/index.ts`](server/index.ts) — the server barrel. **Excludes** `web-app-window.ts` (it
  imports `../window-manager.ts` — the archived local-shell path). The `ui-broker` is a renderer-side
  concern and is re-exported from the parent `index.ts`, not the server spine.
- [`server/LAUNCH.md`](server/LAUNCH.md) — the launch contract for the image layer (binary, ports,
  env, served URLs, mode effects, systemd sketch).

Verify (no VM boot): the dual-face harness now also proves the **TLS network face** (owner token over a
genuine pinned-CA TLS handshake) — 24 checks; the on-device test suite adds TLS + service tests.

## Still on-device work (NOT done here — OS image / boot wave)

- Bind the backend's `appsRoot` to the REAL `/var/lib/vita/apps` mount under **agentd/host-proxy** on a
  booted node (provisioned by the OS image, not this branch).
- Package `cage`+`chromium` into the image + the kiosk systemd units (see `KIOSK.md`), and terminate
  **TLS** for the network face (the owner token is a bearer secret; plain HTTP is harness-only).
- **One shared registry**: in the dev preview the api_origin and the browser-side web-app host run in
  SEPARATE processes, so the host is handed the server's pre-minted token. On-device they share one
  process/registry (the host mints, the api_origin honors in-process).
- **Tighten the iframe sandbox + CORS** once the api_origin is cross-origin (drop `allow-same-origin`
  where possible; pin `Access-Control-Allow-Origin` to the app origin; enforce CSP).
