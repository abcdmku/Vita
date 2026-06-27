# Puter platform server — LAUNCH CONTRACT (for the OS image layer)

This is the exact contract the OS image / boot wave needs to start the consolidated Puter platform
server (`server/service.ts`) on a booted node. It covers: the binary + command, the ports, the env,
the served URLs, and how the Vita **mode** changes what is exposed. The server has **no dependency on
the compositor / CEF / window-manager**; it is a plain TCP(+TLS) service.

> What runs here: ONE in-process service that serves the Puter app platform (fs/kv/auth + capability
> enforcement + persistence) on up to two faces — a LOCAL loopback face (trust-on-host, for the local
> kiosk browser) and a NETWORK face (owner-token + TLS, for a remote browser).

---

## 1. Entry point

`startPuterPlatformService(options)` from
[`ui_kits/desktop/runtime/puter/server/service.ts`](service.ts) (also re-exported from
[`server/index.ts`](index.ts)). The image stages a tiny entry that calls it and keeps the process
alive. Two equivalent runtimes:

- **On-device (Deno, the Vita TS runtime):** invoke the pinned, vendored Deno binary at
  `/usr/lib/vita/deno`. Because the service binds TCP + TLS, this unit (unlike the AF_UNIX-only
  `vita-ts.service`) needs `--allow-net` scoped to the bind addresses and `--allow-read` of the
  served static dir + the TLS cert/key. On-device the network face uses **`Deno.serveTls({ cert, key })`**
  — the native equivalent of the Node `node:https` path the harness exercises. (The current
  `service.ts` is the Node/harness implementation; the Deno entry mirrors it with `Deno.serve`/
  `Deno.serveTls`. Same posture, same config, no extra binary.)
- **Node (dev / a Node-hosted node):** `node --experimental-strip-types <entry>.ts`, where the entry
  imports and calls `startPuterPlatformService`.

There is **no separate proxy binary** (no caddy). TLS is in-process (see [`tls.ts`](tls.ts) for the
decision). This keeps the read-only verity image free of a second vendored+signed Go binary and a
second hop.

---

## 2. Ports

| Face | Bind (default) | Scheme | Auth | Who reaches it |
|---|---|---|---|---|
| **local / kiosk** | `127.0.0.1:7681` (pin `VITA_LOCAL_PORT`) | `http` | none (trust-on-host) | the local kiosk browser on the device display |
| **network / remote** | `0.0.0.0:7443` (pin `VITA_NETWORK_PORT`) | `https` | owner token (bearer) **+ TLS** | a remote browser, owner-authenticated |

- The local face is plain HTTP **only on loopback** — it never leaves the device, and the device is
  the trust boundary. Do not bind the local face to a non-loopback address.
- The network face is **always TLS** in production (the owner token is a bearer secret). A plaintext
  network face requires the explicit `insecureNetworkPlaintext: true` opt-out (harness only).
- Pin the ports for the systemd units (the service defaults to ephemeral `:0` when a port is `0`).

---

## 3. Environment

| Env var | Meaning | Default |
|---|---|---|
| `APPS_ROOT` | the persistent apps mount the store is backed by (`<APPS_ROOT>/<appId>`) | `/var/lib/vita/apps` |
| `VITA_LOCAL_HOST` / `VITA_LOCAL_PORT` | local/kiosk face bind | `127.0.0.1` / `7681` |
| `VITA_NETWORK_HOST` / `VITA_NETWORK_PORT` | network face bind | `0.0.0.0` / `7443` |
| `VITA_OWNER_TOKEN` | the network-face owner bearer secret (mint once, persist on the data partition) | minted random if unset |
| `VITA_TLS_CERT` / `VITA_TLS_KEY` | owner-provided PEM cert + key paths for the network face | none → self-signed in-process |
| `VITA_MODE` | `headless` \| `local-desktop` \| `network-desktop` | `network-desktop` |

The entry maps these env vars onto `ServiceOptions` (`appsRoot`, `faces`, `ownerToken`,
`tls.certPath`/`tls.keyPath`, `mode`). The image must:

1. Bind `APPS_ROOT=/var/lib/vita/apps` to the **real persistent partition** (provisioned under
   agentd/host-proxy — same `/var/lib/vita` mount the host-proxy already owns; see
   `os/x86_64/cef-overlay/usr/lib/vita/cef/vita-host-proxy.ts` `STATE_ROOT`).
2. Mint `VITA_OWNER_TOKEN` once and persist it on `/var/lib/vita` (survives reboot). The owner reads
   it out-of-band to log into the network face.
3. Provide `VITA_TLS_CERT`/`VITA_TLS_KEY` if the owner holds a real cert (spec §16: the owner holds the
   private key); otherwise the service self-signs and prints the cert SHA-256 fingerprint to pin.

---

## 4. The served URLs

Both faces serve the same files from the runtime static root, with `/_vendor` aliased to the vendored
Apache-2.0 puter.js:

- **Kiosk entry:** `KIOSK_ENTRY_PATH` = `/kiosk-entry.html` — the page the kiosk browser opens. Loads
  `/_vendor/puter/v2.js` (same-origin) and is the mount point for the launcher.
- **Vendored SDK:** `/_vendor/puter/v2.js` (checksum-pinned; see `_vendor/puter/VENDOR.md`).
- **api_origin:** `/api/*` (`/api/batch`, `/api/read`, `/api/readdir`, `/api/stat`, `/api/mkdir`,
  `/api/delete`, `/api/rename`, `/api/move`, `/api/drivers/call`, `/api/whoami`, `/api/rao`, `/api/df`).

The service handle exposes `localUrl`, `networkUrl`, and `kioskUrl` (= `localUrl + /kiosk-entry.html`).
The **local kiosk browser opens `kioskUrl`**. On the network face the owner token is required before
ANY of these (static + api) is served.

---

## 5. How mode affects the launch

| `VITA_MODE` | local face | network face | local kiosk browser | typical use |
|---|---|---|---|---|
| `headless` | — | ✅ (TLS + owner) | — | a server node with no display; reach it remotely |
| `local-desktop` | ✅ (loopback) | — | ✅ opens `kioskUrl` | a single-user device, no remote access |
| `network-desktop` | ✅ (loopback) | ✅ (TLS + owner) | ✅ opens `kioskUrl` | a device usable locally AND remotely |

- In `headless`, do **not** start the kiosk browser unit (`kioskUrl` is `undefined`).
- In `local-desktop` / `network-desktop`, start the kiosk browser after the service is up, pointed at
  `kioskUrl` (see [`KIOSK.md`](../KIOSK.md) for the `cage` + `chromium --kiosk` unit).

---

## 6. systemd sketch (illustrative; provisioned by the image, not this branch)

```ini
# /etc/systemd/system/vita-puter-server.service
[Unit]
Description=Vita Puter platform server (dual-face: local kiosk + network owner-token+TLS)
After=vita-agentd.service local-fs.target
Requires=vita-agentd.service

[Service]
# Runs UNPRIVILEGED (only agentd is privileged). Reads APPS_ROOT (the persistent mount) + the TLS
# material; binds TCP on the two ports. Unlike vita-ts.service this unit DOES bind AF_INET, so its
# RestrictAddressFamilies must allow AF_INET/AF_INET6 (and AF_UNIX for the agentd probe).
Environment=APPS_ROOT=/var/lib/vita/apps
Environment=VITA_MODE=network-desktop
Environment=VITA_LOCAL_HOST=127.0.0.1 VITA_LOCAL_PORT=7681
Environment=VITA_NETWORK_HOST=0.0.0.0 VITA_NETWORK_PORT=7443
Environment=VITA_OWNER_TOKEN=%I              # mint+persist once; do NOT hardcode in the image
Environment=VITA_TLS_CERT=/var/lib/vita/tls/net.crt VITA_TLS_KEY=/var/lib/vita/tls/net.key
ExecStart=/usr/lib/vita/deno run --no-remote --cached-only --quiet \
  --allow-read=/usr/lib/vita/puter,/var/lib/vita/apps,/var/lib/vita/tls \
  --allow-write=/var/lib/vita/apps \
  --allow-net=127.0.0.1:7681,0.0.0.0:7443 \
  /usr/lib/vita/puter/server-entry.ts
DynamicUser=yes
SupplementaryGroups=vita-agent
StateDirectory=vita/apps
NoNewPrivileges=yes
CapabilityBoundingSet=
AmbientCapabilities=
ProtectSystem=strict
RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6
Restart=always

[Install]
WantedBy=multi-user.target
```

The kiosk renderer unit (`vita-kiosk.service`, KIOSK.md) is ordered `After=vita-puter-server.service`
and opens `http://127.0.0.1:7681/kiosk-entry.html`.

---

## 7. What is proven vs. still on-device work

- **Proven (this branch, harness — no VM boot):** the consolidated service starts in all three modes;
  the network face is real TLS (self-signed cert is a valid, pinnable X.509); the owner token travels
  only over a verified TLS handshake; the local and network faces share ONE persisted store and ONE
  capability gate; the single shared registry mints app tokens in-process and the same-process
  api_origin honors them (no cross-process injection); the broker enforces per-app grants (ungranted →
  403 CAP_DENIED); persistence survives a full service restart. See `spike/dual-face-harness.ts` and
  `sdk/typescript/test/ui-kits/puter-ondevice.test.ts`.
- **Still on-device work (NOT in this branch):**
  - Stage the Deno `server-entry.ts` that maps the env vars onto `ServiceOptions` and stays alive
    (the service factory is done; the boot entry + `Deno.serveTls` mirror of `service.ts` is the
    remaining glue).
  - Provision `/var/lib/vita/apps` as a real persistent mount under agentd/host-proxy and wire the
    owner-token mint+persist + (optional) owner TLS cert delivery.
  - Package the kiosk browser (`cage` + `chromium`) + the two systemd units into the image (KIOSK.md).
  - One boot to confirm the markers + node-survival (the single serial QEMU boot gate).
