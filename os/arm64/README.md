# Vita Raspberry Pi 5 arm64 Image Scaffold

This directory defines the deterministic Raspberry Pi 5 arm64 rootfs scaffold for P1-091. It mirrors the x86_64 immutable Debian trixie profile, reuses the same pinned Debian snapshot, mkosi image digest, and `SOURCE_DATE_EPOCH`, and changes only the architecture-specific surface: Debian `Architecture=arm64`, `linux-image-arm64`, and `raspi-firmware`.

## Kernel Branch

The Raspberry Pi 5 image records the Pi kernel branch as **Raspberry Pi downstream 6.12.y**.

The generic ARM64 certification line is Linux 6.18.y LTS, but the Pi 5 profile intentionally tracks the Raspberry Pi downstream 6.12.y branch until real-hardware qualification says to move. This records the Phase 3 exit-gate requirement that the Pi kernel branch is explicit and separately certified.

## Build Scope

This slice is a deterministic build plan and structural verification floor:

- `mkosi.conf` builds an aarch64 Debian trixie rootfs from the shared `os/common/mkosi.conf` baseline.
- `build-root.mjs` plans the root build with `--pull=never`, `--network none`, fixed locale/timezone, fixed `SOURCE_DATE_EPOCH`, the arm64 package allowlist, and Vita TS plus agent overlay hooks.
- `agent-image.conf` plans a native Linux arm64 `vita-agentd` cross-build using `GOARCH=arm64`, `GOOS=linux`, `CGO_ENABLED=0`, `-trimpath`, `-buildvcs=false`, and `-ldflags=-s -w -buildid=`.

## Owner Boot-Verify Gate

No QEMU-aarch64 or real Raspberry Pi 5 boot verification is performed in this slice. Borg51 is an x86 build host, and the Pi firmware path plus the Raspberry Pi downstream kernel cannot be faithfully proven here.

FR-002 remains owner-gated on real Raspberry Pi 5 hardware:

1. Cross-build the arm64 rootfs and native arm64 `vita-agentd`.
2. Stage the Vita TS runtime overlay and the arm64 agent overlay.
3. Flash the image to the Pi 5 target media.
4. Boot to multi-user.
5. Assert the Vita TS marker is present and `vita-agentd` is active/running.

That hardware proof is the certification half of the Phase 3 Pi exit gate. This worker slice records the kernel branch and verifies the deterministic scaffold only.
