# Vendored: xterm.js (terminal emulator front-end) + addon-fit

- **Artifacts:** `xterm.js` (UMD bundle), `xterm.css` (theme/layout), `addon-fit.js` (fit addon).
- **License:** **MIT** (see `LICENSE`) — AGPL-clean; safe to ship in Vita.
- **Upstream:** https://github.com/xtermjs/xterm.js — packages `@xterm/xterm@5.5.0`,
  `@xterm/addon-fit@0.10.0` (served from npm).
- **Snapshot date:** 2026-06-27.
- **SHA-256:**
  - `xterm.js`     — `1f991ac3b4b283ebf96e60ae23a00a52765dd3a2e46fa6fdda9f1aab032f7495`
  - `xterm.css`    — `ba8e6985669488981ccf40c0cefe3aba80722cb6c92de7ad628b0bd717faf2b6`
  - `addon-fit.js` — `bdaefa370b1bfc42ee88d46fe6072400902a4d4b2d45cd93438dda9b23c97089`

## Why vendored, not a CDN
Vita is offline-first (CLAUDE.md §6 / spec §9.3): **no runtime CDN, locked deps, no lifecycle
scripts**. The Terminal app loads these locally from `/_vendor/xterm/*`.

## Why xterm.js
The Terminal app needs a real terminal emulator (cursor, ANSI/VT sequences, scrollback, resize) in the
browser. xterm.js is the de-facto standard (used by VS Code), MIT-licensed, and ships a self-contained
UMD bundle (`window.Terminal`) that runs offline with no build step — it drops straight into a Puter
app's iframe. The fit addon (`window.FitAddon`) keeps the grid sized to the window.

## How it's wired
The Terminal app (`ui_kits/desktop/runtime/puter/apps/terminal/index.html`) mounts an xterm `Terminal`,
opens a `/pty` websocket on the local api_origin (passing its `exec`-granted owner token), and pumps the
exec wire protocol (`exec-plane.ts`) between the two: keystrokes → `{t:"stdin"}` frames; `{t:"stdout"}`/
`{t:"stderr"}` frames → `term.write`. The websocket is gated on the `exec` capability (server.ts).

## Updating
Re-`npm pack` the two packages at the desired versions, copy `lib/xterm.js`, `css/xterm.css`,
`lib/addon-fit.js`, recompute the SHA-256s, and update this file. Do not edit the bundles by hand.
