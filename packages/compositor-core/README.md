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

## OS image integration

The x86_64 mkosi image includes the VMware GPU stack (`vmwgfx` DRM/KMS module,
Mesa GBM/EGL/GLES with the Gallium driver, `libdrm`, and `libinput`) so
`/dev/dri/card0`, a render node, and the input event devices are available in
the 3D-accelerated VMware VM.
