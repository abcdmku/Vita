# DEPRECATED — bespoke local-rendering stack (superseded by the kiosk-browser model)

**Status:** archived / superseded. **Date:** 2026-06-26. **Superseded by:**
`integ/vita-platform-main-ready` — the three-mode Vita Puter platform (cage + chromium kiosk renderer).

Vita's desktop renderer used to be a **bespoke local-rendering stack**: a custom Rust compositor, a
CEF/WPE embedded-web-engine off-screen-render (OSR) path, and a TypeScript window-manager / desktop-shell
driving them. That entire arc is **deprecated**. The platform now renders the local desktop with the
**standard kiosk-browser model** — `cage` (a minimal Wayland kiosk compositor) running
`chromium --kiosk` pointed at the local Puter-compatible platform server. This is shipped as ordinary
Debian packages and launched by `vita-kiosk.service` in **local-desktop** install mode only; in
`headless` and `network` modes no display stack is pulled in at all.

The deprecated source is **NOT deleted** — it stays in-repo so it is fully recoverable — but it is
**no longer built into or booted by the OS image**. `os/x86_64/build-and-boot.mjs` explicitly strips the
compositor self-test + binary from the smoke overlay and no longer stages the CEF overlay (see the
`ARCHIVED (feat/os-three-modes)` notes in that file).

## Why

- The bespoke compositor + CEF/OSR stack was a large, hard-to-maintain, GPU-fragile path (vmwgfx mode
  quirks, DMABUF zero-copy iteration, stale-OSR freezes, cursor-shape FIFO plumbing, input-absolute
  pointer bugs) — see the `vita-cef-*` / `vita-cef-vm-stale-osr` memory entries.
- `cage + chromium --kiosk` is a battle-tested, distro-packaged renderer that gives the same on-screen
  result (a full-screen local web desktop) with none of the custom GPU/engine maintenance burden, and it
  resolves its own runtime deps via `apt`.
- It aligns the local face with the **network face**: both serve the same Puter-compatible HTTP origin;
  the only difference is who renders it (a local kiosk browser vs. a remote browser).

## Archived branches (rendering stack — do not build/merge into the platform line)

These branches are **superseded** by the kiosk-browser model. Their tips are recorded below so the work
is recoverable; they should not be merged into `main` as part of the rendering path.

| Branch | Tip (short SHA) | What it held |
|---|---|---|
| `feat/desktop-window-manager` | `e8a5d9a` | TS window-manager + desktop-shell rendering path |
| `feat/cursor-shapes` | `65fdc57` | cursor-shape plumbing (compositor sprite ↔ CEF name) |
| `feat/desktop-resolution` | `ac0db34` | compositor/vmwgfx resolution-mode selection |
| `fix/perf-dirtyrects` | `79e83b8` | compositor dirty-rectangle perf work |
| `fix/perf-fps` | `0be5595` | compositor frame-rate perf work |
| `feat/desktop-apps-b` | `53b9f9b` | desktop "Phase B" apps on the bespoke shell |
| `feat/desktop-shell-c` | `6b8de8c` | desktop "Phase C" shell (menu bar / clean boot) |
| `spike/cef-osr` (a.k.a. `spike/cef-vm`) | `ca821fb` | CEF off-screen-render engine spike |
| `cef-vm-input` | `aa34670` | CEF render/input/bridge integration on VMware |

> Note: `feat/desktop-window-manager` (`e8a5d9a`) and the desktop A2/B/C/packager/polish history are
> *ancestors* of `feat/vita-platform-integ`, so the desktop-shell **source** rides along in-repo; the
> deprecation is about the **build/boot path**, not deletion.

## Archived in-repo source (recoverable, NOT in the build/boot path)

| Path | Disposition |
|---|---|
| `packages/compositor-core/` | Custom Rust compositor. Not compiled; not staged into any image. |
| `spikes/cef-osr/` | CEF/OSR engine spike (fetch-cef.sh, osr_host). Not built; not staged. |
| `os/x86_64/cef-overlay/` | CEF live-render overlay assets. `installCefOverlay()` is archived; not staged. |
| `os/x86_64/smoke-overlay/.../vita-compositor-selftest.service` + `usr/lib/vita/compositor/` | Compositor self-test unit + binary dir. **Stripped at build time** by `build-and-boot.mjs` (the smoke overlay is staged WITHOUT the bespoke renderer). |
| `ui_kits/desktop/runtime/window-manager.ts`, `settings-window.ts`, `apps/*`, `wm-demo.html` | TS WM/shell/app source. Retained as the in-process app model used by the Puter app platform; the bespoke *compositor-driving* rendering path is not booted. |

## What replaces it (the supported path)

- `os/x86_64/mode-overlay/usr/lib/systemd/system-generators/vita-mode-generator` — reads `vita.mode=`
  from the kernel cmdline (`headless` default | `desktop` | `network`), masks `vita-kiosk.service`
  outside `desktop`, and sets `default.target`.
- `os/x86_64/mode-overlay/.../vita-kiosk.service` + `usr/lib/vita/kiosk/vita-kiosk-launch.sh` —
  `cage` + `chromium --kiosk` against the local face (`http://127.0.0.1:7681`), `desktop` mode only.
- `os/x86_64/mode-overlay/.../vita-platform.service` — the Puter-compatible HTTP server (local face in
  every mode; TLS network face when the mode permits).
- See `os/x86_64/mode-overlay/usr/share/doc/vita/three-modes.md`.
