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
| [`server.ts`](server.ts) | node:http adapter for the harness (the ONLY node:http-coupled file). |
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

## On-device wiring later (NOT done here — spike scope)

- Move the api_origin behind the **host-proxy** on-device: re-back `store.ts` with
  `/var/lib/vita/apps/<id>` + the real KV, and delegate `capability.ts` to the
  `runtime/permission-broker`. The api_origin handler itself is transport-agnostic and ports as-is.
- **One shared registry**: in the dev preview the api_origin (serve-spike.ts) and the browser-side
  web-app host run in SEPARATE processes, so the host is handed the server's pre-minted token
  (`desktop.html` injects `__VITA_SPIKE_SESSION__`). On-device they share one process/registry and no
  token injection is needed (the host mints and the api_origin honors in-process).
- **Tighten the iframe sandbox + CORS** once the api_origin is cross-origin (drop `allow-same-origin`
  where possible; pin `Access-Control-Allow-Origin` to the app origin; enforce CSP).
