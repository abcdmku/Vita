# Vita multi-window shell

Turns the single full-screen Vita Desk into a real **multi-window desktop** that hosts multiple apps —
Vita's own (Vita Desk, the deploy console) **and** real third-party Puter apps — each in a managed,
draggable / resizable / closable window, launched from a dock app launcher.

It is the missing *shell glue* on top of the already-verified Puter compat layer; it **reuses**
`window-manager.ts` (the WM), `ui-broker.ts` (the `puter.ui.*` postMessage parent), and
`web-app-window.ts` (mount a sandboxed Puter-app iframe into a managed window). The shell does not load
puter.js itself — only the app **iframes** do; the shell is the broker those iframes talk to.

## Pieces

| File | Role |
|---|---|
| `app-registry.ts` | The catalog the launcher reads + the per-app session map the service publishes. Vita Desk, the deploy console, and two real third-party apps are entries. Shared by the browser shell **and** the node service (no DOM / no node dep). |
| `shell-entry.ts` | The browser entry (bundled to `shell.js`). Wires WM + broker + web-app-host + **dock/taskbar + app launcher + menubar**. Mounts dialogs for `ui.alert`/`ui.prompt` and toasts for `ui.showNotification`. |
| `shell.html` | The page served at the kiosk URL — a dark `.v-screen` + `shell.js`. |
| `shell-session.ts` | Node side: mints one capability session **per registry app** and renders `/shell-session.js` (`window.__vitaShell = { apiOrigin, sessions }`), like `/session.js` but keyed by appId. |
| `serve-shell.ts` | Dev/verification harness — serves the shell, the apps, the vendored SDK, `/shell-session.js`, and the LOCAL api_origin (fs/kv/auth + apps/sites/shares/events + `/control/*`). |
| `build-shell.mjs` | `deno bundle` → offline-clean `shell.js`. |
| `verify-shell.mjs` | puppeteer-core driver: opens multiple windows, drives a real app's fs/kv, tests drag/focus/close, screenshots. |
| `../apps/serverless-todo`, `../apps/notepad` | Two **real, unmodified** third-party Puter apps (MIT, © Puter Technologies Inc.), each repointed only at the offline vendored SDK. |

## Windowing

The WM (`../../window-manager.ts`) already provides drag (title bar), resize (grip), close (red dot),
focus + z-order (pointerdown raises), and maximize/minimize. The shell adds:

- **Dock / taskbar** (`.v-dock`): a launcher button (`⊞`) + one tile per open window (click = focus/raise).
- **App launcher** overlay: one tile per registry app (click = `launchOrFocus` its window). Sits at a
  z-index **above** windows so an open window can't swallow a tile click.
- **Menubar**: brand + a live clock + an "N windows open" status.

> Fixed while building this: `WindowManager.windows` was a one-time empty snapshot taken at construction
> (so it was permanently `[]`); it is now a live getter. The dock depends on it.

## Per-app sessions

Each registry app gets its **own** capability session minted server-side (`mintShellSessions`) and
published to the page (`/shell-session.js`). When the shell opens a window it hands that app its own
token + instance id, so each iframe authenticates to the LOCAL api_origin independently — no app's token
is shared with another, and each app holds only the capabilities its registry entry declares
(`control` is held by the deploy console alone; default-deny elsewhere).

## api_origin breadth added for real apps

Beyond fs/kv/auth, real Puter apps reach apps/sites/sharing/realtime. `../api-origin.ts` +
`../app-registry-store.ts` add, all **store-backed** (persisted in the same KV under reserved
`__vita.*` keys, hidden from app-visible `kv.list`) and **capability-gated**:

- `puter.apps.*` → `/drivers/call` interface `puter-apps` (select/read/create/update/delete) + REST `/apps`.
- `puter.hosting.*` (sites/subdomains) → interface `puter-subdomains` + REST `/sites`.
- file sharing → REST `/share` (mint + list shares).
- realtime change feed → REST `/events?since=<seq>` (long-poll cursor; records `fs.write`, `kv.set`,
  `app.create`, `site.create`, `share.create`). The socket.io transport stays stubbed (offline kiosk).

## Run it

```sh
# 1. build the bundle
node ui_kits/desktop/runtime/puter/shell/build-shell.mjs
# 2. serve
node --experimental-strip-types ui_kits/desktop/runtime/puter/shell/serve-shell.ts --port 7700
# 3. open http://127.0.0.1:7700/  → click the dock ⊞ to launch apps
# 4. (optional) real-browser verification
CHROME_PATH="C:/Program Files/Google/Chrome/Application/chrome.exe" \
  node ui_kits/desktop/runtime/puter/shell/verify-shell.mjs http://127.0.0.1:7700 ./shots
```

## Licensing (AGPL-clean)

The shell (this dir, the WM, the broker, the api_origin) is Vita's own code. Third-party code is only:
the Apache-2.0 vendored `puter.js` SDK (`../../_vendor/puter/v2.js`) and the two MIT apps under
`../apps/*` (each retains its own `LICENSE`, vendored unmodified except repointing the SDK `<script>` to
the offline bundle). No AGPL Puter desktop is shipped or fetched.
