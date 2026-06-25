# ADR 0014: CEF Web-Engine Bring-Up — Render the Flagship Desktop Live in the Compositor

## Status
Proposed (2026-06-25). The deferred focused GPU arc; M1 is buildable on the merged compositor.

## Context — what the codebase already proves (cited)
- **The single content seam is the `RenderBackend` trait + `Compositor<B>`** (`packages/compositor-core/src/lib.rs:335-391`,
  `:401-683`). Every producer goes through it.
- **`TextureHandleKind::DrmPrimeFd`** (`lib.rs:98-103`) is declared but **never produced or consumed** — the whole zero-copy
  DMABUF path is reserved-but-unimplemented (grep matches only `lib.rs`).
- **PSD-011's RGBA buffer sink IS merged and is the working CPU-readback path**: `Compositor::register_buffer_surface` /
  `update_buffer_surface` (`lib.rs:461-519`) → `create_buffer_texture`/`update_texture_rgba` → `glTexImage2D` on the real
  backend (`linux.rs:594-658`). Command protocol: `registerBufferSurface`/`updateBufferSurface` (`main.rs:325-355`), bounded
  at `MAX_COMMAND_RGBA_BYTES = 16 MiB`. **This is the path CEF's software `OnPaint` feeds today.**
- Present path: `composite()` (`linux.rs:805-894`) → FBO quad → GBM scanout → `eglSwapBuffers` → KMS `add_fb2`+pageflip
  (`linux.rs:1327-1500`), `present=kms`. The `Egl` struct does NOT bind `eglCreateImageKHR`; `Gl` does NOT bind
  `glEGLImageTargetTexture2DOES` — those bindings are the first net-new code for zero-copy.
- **CEF spike (PSD-000)**: delivered a buildable harness + report evaluator, but **no CEF engine was ever actually run**
  (CEF/WPE SDK + VMware GPU unavailable on the build host; the decisive measured run is PENDING; the spike scaffold is not on
  the working branch). Engine choice ("CEF renders everything") is owner-declared but **empirically unvalidated**.
- **PSD-020 (DMABUF→EGLImage import)** specifies the exact work but is **NOT integrated** (review verdict: revise — `GBM_BO_USE_WRITE`
  bug + `DrmPrimeFd` must carry a real fd, not a GL texture name).
- Harness floors: `tools/build/rust-in-docker.mjs` (the ONLY linux-Rust compile floor — `npm run typecheck` does NOT catch
  Rust errors), `tools/wsl-verify.sh` (QEMU markers, no GPU), `tools/vmware-verify.mjs` (the GPU floor: 3D-accel vmx, serial
  markers, `--guest-file <guest>:<host>` PNG copy-out — how PSD-VIS1 proved `gpu-demo.png`). Boot-service model:
  `vita-compositor-selftest.service` (oneshot after open-vm-tools, `DeviceAllow=char-drm rw`, bakes a COMMITTED `.commands`,
  emits markers to ttyS0).
- The flagship (`ui_kits/desktop/index.html`) is static, offline, self-contained (vendored lucide + Geist), authored 1280×800
  (compositor demo output 1280×720 — a reconcile point).

## Decision — milestone ladder (fail-closed, each rung independently bootable + serial-marked)
- **M0** — CEF vendored + runs **software OSR** offscreen, no compositor. Loads the flagship `file://`, `OnPaint` → RGBA →
  PNG; marker `VITA-CEF: osr=software frame=1 status=OK`. De-risks vendoring + offline bundle + the windowless loop.
- **M1 (the guaranteed-works rung — makes "the flagship renders live" TRUE)** — CEF `OnPaint` → `register_buffer_surface`/
  `update_buffer_surface` (the MERGED PSD-011 sink) via the command protocol/bridge; compositor presents `present=kms`;
  `--guest-file` copies out a PNG of the live flagship desktop. **Depends on nothing new in the compositor.** Marker
  `VITA-CEF: sink=buffer-surface present=kms status=OK`.
- **M2** — CEF **accelerated** OSR (`OnAcceleratedPaint`, shared-texture) with a GL/EGL context shared with the compositor;
  frame stays on the GPU (no per-frame upload); proves the no-repaint invariant (`source_repaint_count` unchanged while a
  window drags). Marker `osr=accelerated handoff=shared-texture repaint=no-repaint`.
- **M3** — **zero-copy DMABUF** (`DrmPrimeFd`): land PSD-020 (bind EGLImage/DMABUF, add `import_dmabuf_surface`, extension-detect
  + failsafe, GBM round-trip self-test `VITA-DMABUF: import=OK …`), then CEF exports a PRIME fd + modifier/stride. **This is
  the gate — if vmwgfx rejects the modifier it fails closed to M2/M1.**
- **M4** — visible + interactive: input (`poll_input_events` → CEF `SendMouseMoveEvent`/`SendKeyEvent`), resize (`WasResized`
  ↔ surface re-register), damage (CEF dirty rects → compositor `DamageReport`). Screenshot shows the live desktop.

**Fallback ladder is explicit + runtime-selected:** M1 (CPU-readback) is the always-works floor (PSD-011 merged); M2/M3 are
progressive accelerations; a vmwgfx DMABUF rejection degrades gracefully, never bricks the boot.

## Integration points + hard parts
Integration: extend the `RenderBackend` trait with `import_dmabuf_surface` (no-op/failsafe default for recording/test
backends); add `register_dmabuf_surface` to `Compositor`; extend the command protocol with `registerDmabufSurface` (implies
fd passing → in-process CEF or SCM_RIGHTS over a unix socket, NOT the stdin text stream); extend the `Egl`/`Gl` dlopen structs
(`linux.rs:1712-1879`) with EGLImage/DMABUF bindings + extension probe; a `vita-cef-*.service` mirroring the selftest unit.
Hard parts (ranked): accelerated-OSR shared GL context with CEF's GPU process (highest unknown — DMABUF sidesteps it, an
argument for M3 over M2); DMABUF export+import on vmwgfx (the #1 stated risk; fix the 2 PSD-020 bugs first); fd lifetime /
cross-process handoff (M1 has none — another reason it ships first); lifecycle/resize/damage; resolution reconcile (1280×800↔720);
offline asset integrity (file:// only, network disabled, SRI'd capsule); the no-Rust-on-Windows compile trap (validate via
`rust-in-docker.mjs` + a VMware boot, never `typecheck` alone).

## Slice breakdown (PSD-050..056; R2 — compositor/privileged → Codex reviewer gate + GPU-boot verification; needs CEF SDK + linux GPU)
| id | title | depends_on | acceptance sketch |
|----|-------|-----------|-------------------|
| PSD-050 | CEF shared-engine vendoring + offline software OSR → frame PNG | — | vendored CEF builds offline (`--locked`, no net); loads flagship `file://`; software `OnPaint` → 1280×N RGBA → PNG; `VITA-CEF: osr=software status=OK`; lucide glyphs + dock visible |
| PSD-051 | CEF `OnPaint` → compositor RGBA buffer surface (M1) | PSD-050 | feeds `register/update_buffer_surface`; `present=kms`; `--guest-file` PNG of live flagship; `VITA-CEF: sink=buffer-surface present=kms status=OK`; rust-in-docker clean |
| PSD-052 | EGL/GL DMABUF-import bindings + extension detect (PSD-020 core, fixed) | PSD-002 | bind `eglCreateImageKHR`/`glEGLImageTargetTexture2DOES`; detect `EGL_EXT_image_dma_buf_import(_modifiers)`+`GL_OES_EGL_image`, failsafe; cargo tests; fix `GBM_BO_USE_WRITE` |
| PSD-053 | `import_dmabuf_surface` on trait + Compositor + GBM round-trip self-test (M3 gate) | PSD-052 | `DrmPrimeFd` carries a real PRIME fd; GBM round-trip composites+reads back; boots vmwgfx → `VITA-DMABUF: import=OK\|FAILSAFE reason=…` honestly |
| PSD-054 | CEF accelerated OSR + zero-copy handoff (M2/M3 consume) | PSD-051,053 | `OnAcceleratedPaint` → shared-texture/DMABUF; zero-copy when extensions present else M1 fallback; no-repaint while dragging |
| PSD-055 | Lifecycle: input + resize + damage (M4) | PSD-054 | input routes into CEF; resize re-registers surface; dirty rects → `DamageReport`; boots interactive on VMware |
| PSD-056 | CEF shared-engine boot service + offline overlay (separate-engine packaging) | PSD-051 | `vita-cef-*.service` (after open-vm-tools+card0, DeviceAllow drm/input, PrivateNetwork); engine + vendored `ui_kits/desktop` ship as an SRI'd offline capsule, NOT in the UI package |

Dispatch order: PSD-050→051 (visible via the merged sink — highest value/lowest risk) ‖ PSD-052→053 (the DMABUF gate); then
054→055→056. Every contract: validate Rust via `rust-in-docker.mjs` + VMware boot; every rung fails closed to the previous.
