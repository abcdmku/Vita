# Vendored: @heyputer/puter.js (client SDK)

- **Artifact:** `v2.js`
- **License:** Apache-2.0 (see `LICENSE`) — the puter.js *client SDK* only.
- **Upstream:** https://github.com/HeyPuter/puter — `src/puter-js`, served at https://js.puter.com/v2/
- **Snapshot date:** 2026-06-26 (the bundle's own header says `Generated on 2026-06-26`).
- **SHA-256 (`v2.js`):** `30397f1379bb347df04d66c71b1f4eb4d842e638f3c3d4c3acbbc7d706df4207`

## Why vendored, not a CDN
Vita is offline-first (CLAUDE.md §6 / spec §9.3): **no runtime CDN, locked deps, no lifecycle
scripts**. We serve this file locally and the spike harness loads it from `/_vendor/puter/v2.js`.
The checksum above is asserted by the api-origin test so a swapped bundle is caught.

## Why the genuine bundle (not a hand-written shim)
Per `architecture/puter-compat-layer.md` (fork decision §"RESOLVED: (A)"): tracking the upstream
SDK verbatim beats mirroring its private API surface. The SDK's origins are overridable
(`puter.api_origin` URL param / `setAPIOrigin()`), so it runs fully offline against Vita's local
`api_origin`. We implement the *parent side* (`ui` broker) and the *local api_origin* ourselves;
we do NOT ship the AGPL Puter desktop GUI or backend.

## Protocol surface this bundle exercises (verified against this artifact, 2026-06-26)
- Reads `puter.api_origin` from the launch-URL params when `env==='app'` and sets `APIOrigin`.
- `puter.fs.write` → `POST {APIOrigin}/batch` (multipart: `operation` JSON + `fileinfo` JSON + `file` blob),
  `Authorization: Bearer <token>`.
- `puter.fs.read` → `POST {APIOrigin}/read` (returns raw bytes).
- `puter.fs.readdir` → `POST {APIOrigin}/readdir` (`Content-Type: text/plain;actually=json`).
- `puter.fs.stat`/`mkdir`/`delete` → `POST {APIOrigin}/stat` `/mkdir` `/delete`.
- `puter.kv.*` → `POST {APIOrigin}/drivers/call` (`interface: "puter-kvstore"`, methods get/set/del/list).
- `puter.auth.whoami` → `GET {APIOrigin}/whoami`; `/rao` for app-read-access.
- `puter.ui.*` → `postMessage` to `window.parent`; handshake `{msg:'READY', appInstanceID}`;
  envelope `{msg, env:'app', appInstanceID, uuid, ...}`; reply `{original_msg_id == uuid}`.

## Updating
Re-download `https://js.puter.com/v2/` → `v2.js`, recompute the SHA-256, update this file and the
checksum constant in `ui_kits/desktop/runtime/puter/api-origin.ts`. Do not edit `v2.js` by hand.
