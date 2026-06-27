# Vita dev loop — editor + scaffold + npm→app packager (on the Puter platform)

The **build pillar** of Vita (north star: a self-hosting dev OS): the loop for *building new apps* on the
new Puter-compatible platform. Everything here is Vita's own code (AGPL-clean); the only third-party
bytes are the vendored Apache-2.0 puter.js SDK (`/_vendor/puter`) and MIT CodeMirror
(`/_vendor/codemirror`), both offline (no runtime CDN).

A Vita/Puter app on this platform is a **directory of static files** served by the api_origin host and
loaded in a browser face. The boot contract every app uses: pin `window.PUTER_API_ORIGIN` before the
SDK loads → load `/_vendor/puter/v2.js` → load `/session.js` (injects the minted local app-session
token) → the app's own JS calls `puter.fs` / `puter.kv` / `puter.auth` over HTTP to the local api_origin,
which persists to `/var/lib/vita/apps`. Same model as the kiosk entry; no window manager / compositor.

## The three deliverables

1. **Editor** (`editor/`) — *Vita Code*. A real Puter app: open / edit / save files via `puter.fs`,
   rendered with CodeMirror 5. Save is a genuine `puter.fs.write`; content survives reload + reboot.
2. **New App scaffold** (`newapp/` UI + `scaffold.ts` generator) — type a name, and it generates a
   minimal **runnable** app (manifest + index.html with the SDK wired to the api_origin + app.js + css)
   and writes it into the owner space via `puter.fs`. `scaffold.ts` is pure + testable; the New App page
   imports the SAME module (type-stripped at serve time) so node/tests/browser share one generator.
3. **Packager bridge** (`packager-bridge.ts` + `-assets.ts`) — wires the EXISTING npm→app packager
   (`../packager/`: catalog/allowlist + generator) onto this platform. `add <allowed-pkg>` → offline
   **locked install** (an SRI-verified package dir on disk, no network, no lifecycle scripts) → the
   existing `generateApp` classifies cmd vs desktop/auto + reconciles capabilities → mapped onto a
   **served app directory** that runs against the api_origin:
   - `bin` package → a served terminal-style cmd app (honest: echoes args until the capsule exec
     transport is wired — same posture the WM packager's cmd surface takes);
   - UI `mount(root)` module → a served host page that imports the installed module + calls its mount;
   - `vita.web` HTML entry → served directly (SDK boot injected).

### How the packager maps onto the new platform (the seam)
The archived packager produces a `VitaApp` whose `mount(ctx)` paints into a window-manager DOM root.
This platform has no window manager — apps are served file dirs. The bridge keeps the packager's
**catalog gate + generator (classification/validation) + capability model unchanged** and replaces the
WM surface with served HTML/JS that talks to the api_origin. The `loader.ts` seam (v1 in-memory) is
replaced by `lockedDirModuleLoader` — the real offline-install hook reading SRI-verified bytes off disk.

## Run it

```sh
# Stand up the platform data plane + serve the dev loop (no VM, no compositor — a stock browser renders):
node --experimental-strip-types ui_kits/desktop/runtime/devloop/serve-devloop.ts --port 7700 [--dir <persist>]
# Open http://127.0.0.1:7700/  (launcher → editor + new app)
```

Routes: `/api/*` (platform fs/kv/auth) · `/_vendor/*` · `/session.js` · `/devloop/*` (static apps) ·
`/run?path=<entry>` (serve a scaffolded/packaged app's files from the store) ·
`POST /package?name=<pkg>` (run the bridge + write the app into the store).

## Verify (real headless browser)

```sh
# 1) start the harness (above) on a port
# 2) drive it with puppeteer-core + local Chrome (installed ad-hoc; kept out of repo deps):
CHROME_PATH=<chrome> node ui_kits/desktop/runtime/devloop/verify-devloop.mjs http://127.0.0.1:7700 ./shots
```
Asserts: editor edit+save persists across reload; scaffold create + run + KV-persist; package an allowed
npm fixture → run its served app. 13/13 checks green.

## Tests (strict TS, no browser)

`sdk/typescript/test/ui-kits/devloop-scaffold.test.ts` + `devloop-packager-bridge.test.ts` cover the pure
generators (8 + 6 tests). Strict typecheck: `tsconfig.devloop.json` (harness) + the repo lane (the tests
pull `scaffold.ts` / `packager-bridge*.ts` into `tsconfig.json`).

## What's wired vs stubbed
- **Wired (real):** editor open/save over `puter.fs`; scaffold writing real files; packager catalog
  gate + offline locked-install SRI verify + generator classification + served-app generation + run.
- **Honest stub (inherited from the packager v1):** out-of-process **exec** for cmd apps — the generated
  cmd surface echoes args and says so until the capsule exec transport lands.
