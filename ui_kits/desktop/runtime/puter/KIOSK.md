# Local kiosk face — STOCK browser as the local renderer (replaces the custom compositor)

The dual-face backend (`backend.ts`) serves the Puter app platform on TWO reachability paths over ONE
persisted, capability-gated store:

- **Local / kiosk face** — `http://127.0.0.1:<localPort>` — trust-on-host. Rendered by a **stock kiosk
  browser on the local display**. There is **no custom Vita compositor** in this path: a plain
  `cage` (a kiosk Wayland compositor for a single fullscreen client) running `chromium --kiosk`
  IS the local renderer. This is the owner's stated direction — replace the bespoke CEF/OSR
  compositor with a stock browser pointed at the local origin.
- **Network / remote face** — `http://<iface>:<networkPort>` — owner-token authenticated (see
  `backend.ts::ownerTokenFaceGate`). Behind TLS in production. Rendered by any remote browser.

This file documents the **local kiosk launch config**. It is config/doc only — no compositor code.

## Why a stock kiosk browser (not the custom compositor)

The Puter app platform is plain web (sandboxed iframes + the vendored puter.js talking to the local
`api_origin`). A stock browser in kiosk mode renders it natively, with the OS's own GPU stack, and
drops an entire bespoke accelerated-OSR compositor from the trusted surface. The capability model and
persistence live in the backend (`api-origin.ts` + the broker permission model + the file store), not
the renderer — so the renderer can be any conformant browser.

## Launch config (cage + chromium)

On a booted node, after the dual-face backend is up and the local face is listening on
`VITA_LOCAL_PORT` (default chosen by the backend; pin it for kiosk), launch:

```sh
# 1) The backend exposes its local-face port (pin it for the kiosk unit).
#    e.g. start with localPort=7681 (see backend.ts DualFaceDeps.localPort).
VITA_LOCAL_PORT=7681

# 2) cage runs a SINGLE fullscreen Wayland client — here, chromium in kiosk mode.
#    --kiosk        : fullscreen, no chrome, no exit affordances
#    --incognito    : no cross-session leakage (state lives in the backend, not the browser profile)
#    --app=URL      : open as an app window (no tab/omnibox)
#    The local face is trust-on-host: NO owner token needed on 127.0.0.1.
exec cage -- chromium \
  --kiosk \
  --incognito \
  --noerrdialogs \
  --disable-translate \
  --disable-pinch \
  --overscroll-history-navigation=0 \
  --autoplay-policy=no-user-gesture-required \
  --app="http://127.0.0.1:${VITA_LOCAL_PORT}/"
```

Substitute `chromium-browser` / `google-chrome` / any Chromium build, or a stock `firefox --kiosk`,
per the node's image. The only requirement is a conformant browser that can reach loopback.

### systemd unit sketch (on-device)

```ini
# /etc/systemd/system/vita-kiosk.service  (illustrative; provisioned by the image, not by this branch)
[Unit]
Description=Vita local kiosk renderer (stock browser, no custom compositor)
After=vita-puter-backend.service
Requires=vita-puter-backend.service

[Service]
Environment=VITA_LOCAL_PORT=7681
ExecStart=/usr/bin/cage -- /usr/bin/chromium --kiosk --incognito --noerrdialogs --app=http://127.0.0.1:7681/
Restart=always
# Runs as an unprivileged seat user; the backend owns /var/lib/vita/apps.

[Install]
WantedBy=graphical.target
```

## Served entry page

The local face serves a minimal entry page at `/` (see `kiosk-entry.html`, served via the backend's
`staticRoot`/`staticAliases`). It loads the desktop shell / the launcher that opens Puter apps in
sandboxed iframes pointed at the same-origin `/api`. The page itself is static; all data + capability
enforcement is in the backend.

## What is proven vs. still on-device work

- **Proven (this branch, harness):** ONE backend reachable at a loopback (kiosk) URL AND a network URL
  with owner-auth, both reading/writing ONE persisted store through the same capability gate
  (`dual-face-harness.ts`).
- **On-device wiring still needed (NOT done here):** packaging `cage`+`chromium` into the OS image,
  the systemd units above, binding `/var/lib/vita/apps` as the backend's `appsRoot` under
  agentd/host-proxy, and TLS termination for the network face. Those land in the OS image/boot wave,
  not in this app-platform branch.
