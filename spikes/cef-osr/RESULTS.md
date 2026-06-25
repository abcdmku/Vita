# CEF OSR spike — M0 RESULTS (software off-screen render of the flagship desktop)

**Status: M0 PASS.** CEF renders the live Vita flagship desktop HTML off-screen on the
Borg51 build host and produces a 1280x800 PNG. This is the gating proof that CEF works on
this host; the accelerated-OSR → shared-texture → compositor path (M1+) builds on it.

Marker emitted on success:

```
VITA-CEF: osr=software frame=1 w=1280 h=800 status=OK
```

## What was proven

- A minimal **windowless / off-screen-rendering (OSR)** CEF host (`osr_host.cc`) inits CEF
  with `windowless_rendering_enabled=on`, `multi_threaded_message_loop=off`, software GPU
  (`--disable-gpu --in-process-gpu`, ANGLE swiftshader), loads
  `file:///home/borg/Vita/ui_kits/desktop/index.html`, pumps the message loop, captures the
  full-view **BGRA** buffer in `CefRenderHandler::OnPaint`, converts BGRA→RGBA and writes a PNG.
- The captured PNG (`out/cef-m0.png`, copied to `/mnt/c/Users/Borg/vita-vmware/cef-m0.png`)
  shows the real flagship desktop:
  - **Menu bar**: `Vita.ts` brand + File/Edit/View/Go/Window/Help, status cluster (wifi +
    battery-full lucide icons) and the `10:24` clock.
  - **⌘K command palette** (centered): search input with magnifier icon, three results —
    Run kernel.ts (terminal icon, highlighted), Open Files (folder), Toggle Dark Mode
    (sun-moon) — with the return (corner-down-left) glyph on the active row.
  - **Shell window**: `shell — ~/vita` titlebar + traffic-light dots + syntax-highlighted
    TypeScript boot/process-list content.
  - **Dock**: six lucide-iconed tiles (terminal active, code, folder, mail, globe, settings).
- **Page JS executes**: lucide is a UMD bundle (`window.lucide.createIcons`) that does NOT
  auto-run; the page relies on the (currently missing) `runtime/bootstrap.js` to call it.
  The host injects `lucide.createIcons()` via `CefFrame::ExecuteJavaScript` after load, which
  both completes the icon render and proves CEF runs the page's JavaScript (relevant to M1).

## Vendored CEF

- **Version**: `149.0.5+g6770623+chromium-149.0.7827.197` (latest STABLE Linux64 at vendor time).
- **Distribution**: `..._linux64_minimal.tar.bz2` (296.5 MB, sha1
  `f1b9ce823e2849498f4597f8acd92c9a34a59640`, sha verified OK against the CEF builds index).
- **Source**: https://cef-builds.spotifycdn.com/ (Spotify CEF builds CDN).
- **Vendored path** (extracted, ~1.5 GB, git-ignored — re-fetch via `fetch-cef.sh`):
  `spikes/cef-osr/.vendor/cef_binary_149.0.5+g6770623+chromium-149.0.7827.197_linux64_minimal/`
  Contains `Release/libcef.so` + swiftshader/EGL/GLESv2/vulkan, `Resources/` (paks, icudtl.dat,
  locales), `include/` headers, `libcef_dll/` wrapper sources, and `cmake/` macros.

## Host

- Borg51 / WSL Ubuntu 26.04, x86_64, glibc 2.43 (libcef needs only GLIBC_2.25 — compatible),
  g++ 15.2, cmake 4.2.3, ninja. libcef.so's 81 shared-lib deps all resolve on the host.
- Build deps installed: `cmake ninja-build pkg-config libx11-dev` (CEF links `-lX11` even in OSR).
- Runs **headless, no DISPLAY** (true OSR). The only runtime noise is a harmless
  `org.freedesktop.UPower` dbus error (no system bus in WSL; battery telemetry only).

## Build & run

```bash
# 1. (re)vendor CEF if .vendor is empty
spikes/cef-osr/fetch-cef.sh

# 2. configure + build (wrapper + host)
cd spikes/cef-osr && cmake -S . -B build -G Ninja -DCMAKE_BUILD_TYPE=Release && ninja -C build

# 3. run headless, produce the PNG
spikes/cef-osr/run.sh
# -> spikes/cef-osr/out/cef-m0.png  (+ copied to /mnt/c/Users/Borg/vita-vmware/cef-m0.png)
# -> VITA-CEF: osr=software frame=1 w=1280 h=800 status=OK
```

## Files

- `osr_host.cc` — the windowless OSR host (CefApp/CefClient/CefRenderHandler + PNG writer).
- `CMakeLists.txt` — standalone build over the vendored CEF (FindCEF + libcef_dll_wrapper).
- `stb_image_write.h` — vendored single-header PNG writer (public domain, stb v1.16).
- `fetch-cef.sh` — reproducible download + sha-verify + extract of the pinned CEF distribution.
- `run.sh` — runs the host headless and mirrors the PNG to the Windows-visible path.

## Handoff to M1 (feed OnPaint frames to the native compositor)

The compositor at `packages/compositor-core` already has a buffer-surface sink (PSD-011). Its
stdin command stream (`packages/compositor-core/src/main.rs`) accepts:

- `registerBufferSurface <id> <w> <h> <rgba>` — 5 fields; `<rgba>` is the full surface as **hex**
  (e.g. `0a141eff…`) **or base64**, in **RGBA byte order**, length must equal `w*h*4`.
- `updateBufferSurface <id> <rgba>` — re-upload the same-sized surface (incremental frames).
- `updatePlacement <id> col row w h z visible` — place/animate the surface.

M1 path: in `OnPaint`, take the BGRA buffer → swap to RGBA (the host already does this for PNG)
→ emit `registerBufferSurface cef:desktop 1280 800 <hex>` once, then `updateBufferSurface
cef:desktop <hex>` per subsequent paint. The id must match `SurfaceId::new` rules. Caveat:
`MAX_COMMAND_RGBA_BYTES = 16 MiB`; a 1280x800 RGBA frame is 4 MiB (fits). For software OSR a
per-frame full readback is fine; the accelerated/shared-texture path (no CPU readback) is M2+.
```
