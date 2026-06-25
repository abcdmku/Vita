# CEF OSR spike — RESULTS (M0 software OSR + M1 CEF → compositor pipe + M4 live-on-GPU boot)

**Status: M0 PASS + M1 PASS + M4 PASS (the live flagship desktop renders on the VMware GPU during an OS boot).**
- **M0** — CEF renders the live Vita flagship desktop HTML off-screen on the Borg51 build
  host and produces a 1280x800 PNG (the gating proof that CEF works on this host).
- **M1** — CEF's rendered frame flows INTO the Vita native compositor: CEF emits the
  compositor command stream for the captured frame; the compositor ingests it, composites
  the buffer surface through real GL, and the **compositor** does the glReadPixels readback
  → `cef-m1.png`. The readback shows the CEF-rendered desktop produced BY the compositor.

Markers emitted on success:

```
M0: VITA-CEF: osr=software frame=1 w=1280 h=800 status=OK
M1: VITA-CEF: sink=buffer-surface present=ok status=OK
    (compositor side: VITA-COMPOSITOR: gpu=surfaceless-llvmpipe surfaces=1 composited=OK
     reposition=no-repaint present=recording damage=OK status=OK input=unavailable)
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

## M1 — how CEF feeds the compositor (the wiring)

The pipe is the compositor's **stdin command stream** (`packages/compositor-core/src/main.rs`,
`run_command_stream`), feeding the MERGED PSD-011 buffer-surface sink. The data path:

```
CEF (software OSR, OnPaint BGRA 1280x800)
  -> BGRA->RGBA  + vertical box-downscale 800->720 (DownscaleVerticalRgba in osr_host.cc)
  -> hex-encode  -> emit the compositor command stream:
       registerBufferSurface cef:desktop 1280 720 <hex>     (3,686,400 bytes -> 7,372,800 hex)
       updatePlacement cef:desktop 0 0 1280 720 0 true
       present
  -> piped on stdin into:
     vita-compositor --commands --hold-seconds 0 --screenshot /run/cef-m1.png
  -> compositor: register_buffer_surface -> glTexImage2D -> composite() (real GL) -> output FBO
  -> compositor: read_output_rgba (glReadPixels) -> PNG   <-- the COMPOSITOR produces the readback
```

`osr_host.cc` adds `--compositor-out=<file|->` (and `--surface-id=`): in that mode the host emits
the stream instead of a PNG. `run-m1.sh` runs CEF in that mode and pipes the stream into the
compositor. Surface id `cef:desktop` satisfies `SurfaceId::new`. `MAX_COMMAND_RGBA_BYTES = 16 MiB`;
a 1280x720 RGBA frame is 3.5 MiB (fits). Resolution reconcile: CEF view is 1280x800, compositor
output is 1280x720 — the host downscales 800->720 so the surface fills the output exactly (no clip,
no letterbox). For software OSR a per-frame full upload is fine; the no-CPU-readback path is M2+.

**RGBA orientation: NO flip needed.** CEF `OnPaint` delivers row 0 = top; the compositor's
buffer-surface upload + readback also treat row 0 = top (`read_output_rgba` applies a single
`flip_rgba_rows` to undo GL's bottom-up readback). The `cef-m1.png` readback renders the desktop
**upright** (menu bar at top, dock at bottom), matching `cef-m0.png`. Confirmed visually.

### The no-GPU readback enabler (compositor change)

The merged compositor's only backend was KMS/GBM/EGL, which needs a real `/dev/dri/card0` + a
connected CRTC — absent on the WSL build host (Microsoft kernel ships no DRM device and no loadable
`vkms`). So a `--commands --screenshot` run failsafed (`gpu=unavailable … card0 … No such file`).
The compositor's **readback is already FBO-based** (`composite()` renders into `output_fbo`;
`read_output_rgba` does `glReadPixels` from the FBO texture) — only the *present-to-display* step
needs scanout. M1 therefore adds a **surfaceless software fallback** to
`packages/compositor-core/src/platform/linux.rs`:

- `PlatformGpuBackend::open_surfaceless` — EGL `EGL_MESA_platform_surfaceless` display +
  `EGL_KHR_surfaceless_context` (`eglMakeCurrent` with `EGL_NO_SURFACE`), backed by Mesa
  **llvmpipe**. No GBM/DRM/KMS/libinput. `gpu=surfaceless-llvmpipe`, `present=recording`.
- `open_for_self_test` (the `--commands` path) tries KMS first, falls back to surfaceless when no
  GPU is present. The real boot path (`open`, input-required) is unchanged — still KMS-only.
- `composite()` gates the scanout swap/page-flip behind a `scanout` flag (false for surfaceless);
  KMS hardware fields became `Option` so the same struct serves both paths.
- Host runtime dep: `libgles2` (Mesa `libGLESv2.so.2`) — install once: `apt-get install -y libgles2`.

This exercises the **real** PSD-011 buffer-surface sink + real GL compositing + real `glReadPixels`
readback, swapping only the GL substrate (surfaceless llvmpipe vs KMS scanout). All 23 cargo tests
still pass; `rust-in-docker.mjs` builds clean.

## Build & run (M1)

```bash
# compositor binary (smoke overlay path), if not current:
node tools/build/rust-in-docker.mjs --dir packages/compositor-core \
  --out os/x86_64/smoke-overlay/usr/lib/vita/compositor/vita-compositor
# CEF host (rebuild after osr_host.cc changes):
cd spikes/cef-osr && ninja -C build && cp build/vita_cef_osr build/Release/vita_cef_osr
# the pipe (host without a GPU): force Mesa software
LIBGL_ALWAYS_SOFTWARE=1 GALLIUM_DRIVER=llvmpipe spikes/cef-osr/run-m1.sh
# -> /run/cef-m1.png (compositor readback) mirrored to /mnt/c/Users/Borg/vita-vmware/cef-m1.png
# -> VITA-CEF: sink=buffer-surface present=ok status=OK
```

## Handoff to M4 (CEF + compositor as a boot service, on the GPU, in VMware)

M1 proves the pipe with software readback on WSL. To run it for real in the OS boot:
1. **Service unit** — mirror `vita-compositor-selftest.service` with a `vita-cef-*.service`
   (after `open-vm-tools` + `card0`, `DeviceAllow=char-drm rw` + input devices, `PrivateNetwork`,
   `file://`-only). On VMware the compositor takes the **KMS** path (`/dev/dri/card0` present, 3D
   accel `svga.present=TRUE`), so `present=kms` (the surfaceless fallback is a no-GPU dev aid only).
2. **Process model** — for M1-on-device, run CEF as a child that writes the command stream to the
   compositor's stdin (a pipe), exactly as `run-m1.sh` does, but long-lived: `registerBufferSurface`
   once, then `updateBufferSurface cef:desktop <hex>` per `OnPaint` (the incremental path the
   protocol already supports). The single hard serial bottleneck remains the one Borg51 QEMU/VMware
   boot.
3. **Verify** — `tools/vmware-verify.mjs` with `--guest-file /run/cef-m1.png:<host>` copies the
   readback out; assert the desktop is present + node survives. This is the GPU floor.
4. **Then M2/M3** — replace the per-frame CPU upload with `OnAcceleratedPaint` shared-texture (M2)
   and zero-copy DMABUF import (M3, PSD-052/053) so the frame never leaves the GPU; M1 stays the
   always-works fallback when vmwgfx rejects the modifier.

## M4 — CEF live-render BOOTS on the VMware GPU (PASS)

The handoff above is now realized end-to-end: the live flagship desktop renders on the VMware
GPU during a real Vita OS boot, and a `glReadPixels` readback copied out of the guest proves it.

**Markers from the VMware boot (3D accel, `mks.enable3d=TRUE`, vmwgfx):**

```
VITA-COMPOSITOR: gpu=vmwgfx surfaces=5 composited=OK ... present=kms ... status=OK   (selftest, first)
VITA-CEF: stage=start frames=6 url=file:///usr/lib/vita/ui_kits/desktop/index.html card0=present cache=/run/vita-cef-cache
VITA-CEF: cef_diag=... emitted compositor frame (7372841 bytes, surface=cef:desktop 1280x720, incremental) -> - | stream: emitted 6 frames — closing
VITA-CEF: readback=/run/cef-live.png bytes=3687468
VITA-CEF: sink=buffer-surface present=kms status=OK
VITA-COMPOSITOR: gpu=vmwgfx surfaces=1 composited=OK reposition=no-repaint present=kms damage=OK status=OK
```

`cef-live.png` (1280×720 RGBA, copied out via `--guest-file /run/cef-live.png:<host>` / vmtoolsd)
is a genuine VMware GPU readback showing the live desktop: menu bar (Vita.ts + File/Edit/View/Go/
Window/Help + wifi/battery + 10:24), the ⌘K command palette (Run kernel.ts highlighted, Open Files,
Toggle Dark Mode, lucide icons), the shell window with syntax-highlighted TS, and the dock.

### What M4 added (on branch `spike/cef-m4`)
- **`osr_host.cc` `--frames=N` live-streaming mode** — register the buffer surface once, then
  `updateBufferSurface cef:desktop <hex>` + `present` per `OnPaint`, then close stdout (EOF) so the
  downstream `vita-compositor --commands` reads back the latest presented frame. `frames=1` is the
  unchanged M1 one-shot. (Exercises the incremental protocol path the spec already supported.)
- **`--ozone-platform=headless` + `root_cache_path`** — the on-device service runs CEF in a minimal
  systemd env (no `$DISPLAY`, no `$HOME`, read-only `/usr`). Without headless Ozone, CEF defaulted to
  X11 and aborted (`Missing X server or $DISPLAY` → platform init failed → exit in 0.3s, no frame →
  the compositor saw EOF before any present). Headless Ozone + a writable cache (`$VITA_CEF_CACHE`)
  fix it. **This was the decisive M4 bug.**
- **`os/x86_64/cef-overlay/`** — `vita-cef-live.service` (oneshot, `After=open-vm-tools` + card0 +
  `vita-compositor-selftest` to serialize the exclusive KMS master, `DeviceAllow=char-drm rw` +
  `char-input r`, `PrivateNetwork`, NOT `PrivateTmp` so `/run/cef-live.png` is copy-out-able),
  enabled via a committed `multi-user.target.wants` entry; `vita-cef-live.sh` (waits for card0,
  exports HOME/XDG/TMPDIR/`VITA_CEF_CACHE` → `/run`, runs `osr_host --compositor-out=- --frames=6 |
  vita-compositor --commands --screenshot /run/cef-live.png`, surfaces VITA-COMPOSITOR + emits
  VITA-CEF, fails closed with a FAILSAFE marker — never hangs the boot).
- **`build-and-boot.mjs installCefOverlay()` (gated by `VITA_CEF=1`)** — stages the vendored CEF
  runtime (libcef.so + sibling libs + paks + 220 locales, ~1.5 GB), the built `vita_cef_osr`, and the
  whole `ui_kits/` tree (so every relative asset path resolves) into `cef-overlay`, ships it via
  `--extra-tree`, and adds CEF's DT_NEEDED runtime libs to the smoke package set (Debian trixie t64
  names: `libx11-6 libxcomposite1 … libnss3 libnspr4 libglib2.0-0t64 libatk1.0-0t64 …`). The heavy
  CEF runtime + staged `ui_kits` copy are gitignored (reproducible from `fetch-cef.sh` + `ninja`).

### Build & run (M4)
```bash
# 1. vendored CEF present + osr_host built (M0/M1 steps), compositor binary staged.
# 2. build the OS image with the CEF overlay (~3.7 GB raw, ~1.5 GB is the CEF runtime):
VITA_CEF=1 node os/x86_64/build-and-boot.mjs --mode=smoke --no-boot
# 3. copy the .raw to a Windows path, then boot in VMware FROM WINDOWS (vmrun.exe is Windows-side):
#    cp os/x86_64/out/vita-debian-trixie-x86_64-root.raw /mnt/c/Users/Borg/vita-vmware/cef-os.raw
node tools/vmware-verify.mjs --image C:/Users/Borg/vita-vmware/cef-os.raw \
  --markers "VITA-CEF: sink=buffer-surface,VITA-COMPOSITOR" \
  --guest-file /run/cef-live.png:C:/Users/Borg/vita-vmware/cef-live.png --timeout 240
# NOTE: wait on the CEF COMPLETION marker ("VITA-CEF: sink=buffer-surface"), not the stage=start
# line — CEF starts ~35 s in and needs ~5 s to init+render 6 frames; matching stage=start tears the
# VM down mid-render before /run/cef-live.png exists.
```

### Remaining gaps (future milestones, not M4)
- **M2/M3 are still pending**: CEF here is **software OSR** (the compositor does the GPU work + the
  readback is a real GPU `glReadPixels`, but CEF's own paint is CPU). `OnAcceleratedPaint` shared-
  texture (M2) and zero-copy DMABUF (M3, PSD-052/053) keep the frame on the GPU end-to-end.
- **Interactivity (the ADR's own "M4")**: input/resize/damage routing into CEF is not wired — this
  rung is a *visible* live render, not yet interactive (PSD-055).
- **Hardening**: the boot service is the verification-only overlay (executable/world-writable unit
  perms warn at boot; `PrivateTmp` is off for copy-out). The production CEF capsule (PSD-056) is a
  separate SRI'd offline capsule, hardened, NOT this smoke overlay.
- The single serial bottleneck remains the one VMware boot at a time.

