# Vita compositor core

`vita-compositor-core` is the thin native mechanism behind the PSD desktop substrate.
The core owns GPU texture registration, placement updates, focus, input event
streaming, KMS presentation, damage tracking, and a test-only readback proof
that moving a surface does not repaint its content.

## Build

```sh
cargo build --manifest-path packages/compositor-core/Cargo.toml --target x86_64-unknown-linux-gnu
```

The crate has no third-party Rust dependencies. On Linux it runtime-loads the
system GPU stack (`libdrm`, `libgbm`, `libEGL`, `libGLESv2`, `libinput`) and
opens `/dev/dri/card0`. Missing DRM, KMS master, or GPU libraries fail closed
and emit a `status=FAILSAFE` marker.

## Demo scanout

```sh
vita-compositor-core --demo --hold-seconds 30
```

The demo path composites a desktop-like wallpaper, top panel, and three window
rectangles through the same GPU texture + KMS present path, emits the
`VITA-COMPOSITOR` marker, then keeps the scanout visible for the requested hold
window so the VMware smoke harness can capture a PNG.

## VMware marker

On the VMware GPU target, the measured path must emit:

```text
VITA-COMPOSITOR: gpu=vmwgfx surfaces=2 composited=OK reposition=no-repaint present=kms damage=OK status=OK
```

That marker is produced only by the DRM/KMS + GBM/EGL/GLES backend after a
composited frame is swapped into a GBM scanout buffer and page-flipped on KMS.
GPU texture readback proves the moved surface texture is byte-identical before
and after the placement change. Non-Linux or missing-device paths emit
`status=FAILSAFE`.

## DMABUF import smoke test

```sh
vita-compositor-core --dmabuf-self-test
```

The DMABUF path allocates a GBM buffer object, exports it as a PRIME fd, imports
it through `EGL_EXT_image_dma_buf_import(_modifiers)` and `GL_OES_EGL_image`,
composites it, and verifies the readback pattern. It emits a `VITA-DMABUF`
marker with `status=OK` or a fail-safe reason such as a missing extension or
rejected modifier.

`smoke-overlay/` contains the package-owned verification unit and wrapper that
the x86_64 smoke image can mirror into its overlay to run this check at boot
after `/dev/dri/card0` appears.

## OS image integration

The x86_64 mkosi image includes the VMware GPU stack (`vmwgfx` DRM/KMS module,
Mesa GBM/EGL/GLES with the Gallium driver, `libdrm`, and `libinput`) so
`/dev/dri/card0`, a render node, and the input event devices are available in
the 3D-accelerated VMware VM.
