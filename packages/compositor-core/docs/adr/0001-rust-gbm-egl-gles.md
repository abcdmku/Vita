# ADR 0001: Rust core with DRM/GBM/EGL/GLES runtime bindings

## Status

Accepted for PSD-002.

## Context

PSD-002 needs a thin native compositor mechanism: open the DRM/KMS GPU device,
hold GPU textures keyed by surface id, composite by placement with damage
tracking, read libinput events, and keep CPU readback limited to tests and
screenshots. Network access is not allowed for this slice, and there were no
pre-vendored native dependencies in the repo.

## Decision

Use Rust for the compositor core and bind the Linux GPU stack explicitly at
runtime:

- `/dev/dri/card0` is opened directly as the DRM device.
- `libdrm`, `libgbm`, `libEGL`, `libGLESv2`, and `libinput` are loaded with
  `dlopen`, avoiding generated bindings, headers, or remote crates.
- EGL is initialized over the GBM device and renders to a GBM window surface;
  the resulting front buffer is converted to a DRM framebuffer and presented
  through KMS modeset/page flip on the selected connector/CRTC.
- GLES textures are the surface registry values. Placement updates only change
  draw coordinates and damage; they do not call the texture creation/upload path.
- Test-only `glReadPixels` readback attaches a source texture to an FBO and
  proves byte identity across a move.
- `libinput` is runtime-detected and represented as the input stream seam for
  this skeleton; event translation remains narrow and fail-closed.

## Alternatives Considered

- **Rust + wgpu**: better long-term abstraction, but not chosen here because
  adding `wgpu` would require vendored crates or network access. Neither is
  available in this contract.
- **C++ + EGL/GLES**: viable, but the host has no CMake and the repo has no
  existing native C++ build convention. Rust gives a small, deterministic
  `cargo build` path and safer ownership around the texture registry.
- **CPU/offscreen buffers**: rejected by Revision 1. The production backend
  stores GLES texture objects and composites them on the GPU. Recording logic is
  restricted to Rust unit tests and is not used by the runtime backend.

## Consequences

The first implementation is intentionally narrow: it targets Linux x86_64 with
Mesa GBM/EGL/GLES and fails closed when `/dev/dri/card0`, KMS master, or the GPU
libraries are missing. The VMware boot proof remains the acceptance floor for
`status=OK`; local host tests can prove core damage/no-repaint logic but cannot
claim GPU verification.
