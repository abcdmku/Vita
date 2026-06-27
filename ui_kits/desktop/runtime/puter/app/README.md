# Vita Desk — the interactive local-face app

This is the **real, clickable** desktop the kiosk (local face) serves at `/kiosk-entry.html` (and `/`),
replacing the old static connectivity-proof page. It is Vita's own code, written against the
Apache-2.0 **puter.js SDK** (`/_vendor/puter/v2.js`) and pointed at Vita's **local api_origin**.

## What it is (and is NOT)

- **IS:** a self-contained rich app (file manager + notes editor + KV-backed settings) that runs on
  the vendored puter.js client SDK. You can open it in any browser and **click + do things** — create
  folders/files, rename, delete, open + edit + save a note, change theme, bump a persisted counter.
  Everything persists to `/var/lib/vita/apps` through the capability-gated api_origin and **survives a
  reload / reboot**.
- **IS NOT:** the AGPL-3.0 Puter desktop GUI. That is never shipped or fetched. The **only**
  third-party artifact is the Apache-2.0 `puter.js` SDK (already vendored at `_vendor/puter/v2.js`).
  This `app/` directory + `kiosk-entry.html` + `proof.html` + `spike/serve-interactive.ts` are all
  Vita's own (AGPL-clean).

## Files

| File | Role |
|---|---|
| `app/index.html` | standalone app shell (also usable directly at `/app/`) |
| `app/app.css` | styles (theme-able via `[data-theme]`) |
| `app/app.js` | app logic — drives `puter.fs` / `puter.kv` / `puter.auth` over HTTP |
| `../kiosk-entry.html` | the kiosk entry — same app, served at `/kiosk-entry.html` (and `/`) |
| `../proof.html` | minimal connectivity-proof page kept for boot diagnostics (`/proof.html`) |
| `../spike/serve-interactive.ts` | dev harness: stands up the real platform service + the app |

## How it talks to the backend

1. `kiosk-entry.html` sets `window.PUTER_API_ORIGIN = location.origin + "/api"` **before** loading the
   SDK, so puter.js targets our same-origin api_origin from its first call (never the cloud
   `api.puter.com`).
2. `/session.js` (served only on the trust-on-host local face) sets the SDK's auth token to the minted
   `vita.kiosk` app-session token and `puter.env = "app"` (so the SDK treats the local token as its app
   session and never pops its own "authenticate with Puter" consent modal).
3. Every action is a real `puter.fs.*` / `puter.kv.*` / `puter.auth.*` call → `POST /api/...` → the
   capability-gated api_origin → the file-backed store.

> **App namespace:** the app operates inside `/home` (never the root `/`). The genuine puter.js SDK
> refuses to write a file whose parent is the root ("Can not upload to root directory." — surfaced by
> the real-browser verification), so all files/notes live under `/home`.

## Run it locally (no VM)

```sh
node --experimental-strip-types \
  ui_kits/desktop/runtime/puter/spike/serve-interactive.ts --port 7681 [--dir <persist-dir>]
# then open http://127.0.0.1:7681/kiosk-entry.html in any browser
```

On-device, the existing kiosk launcher (`os/.../vita-kiosk-launch.sh`) already opens
`http://127.0.0.1:<port>/kiosk-entry.html` — so this app is served with **no launcher change**.

## Verify in a real browser (headless Chrome, no VM)

`spike/verify-interactive.mjs` (in the repo's verification harness) drives headless Chrome
(puppeteer-core, local Chrome — no bundled download): it loads the kiosk URL, creates a file, edits +
saves a note, bumps the KV counter, sets the theme, then **reloads** and asserts all of it persisted,
capturing screenshots. This exercises the genuine browser-only `fs.write` multipart-upload path the
earlier Node-VM shim could not reach.
