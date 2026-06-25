---
id: PSD-002V
title: Compositor VMware verification — build for linux, bake, run at boot, emit VITA-COMPOSITOR
status: ready
phase: 6
pod: desktop
risk_class: R2
fr: []
depends_on: [PSD-002]
target_paths:
  - tools/build
  - os/x86_64
acceptance_command: "npm run typecheck"
allowed_network: false
budget_minutes: 120
---

## Objective
Make the PSD-002 compositor RUNNABLE + VERIFIABLE on the VMware GPU boot, so the orchestrator can confirm whether it
actually presents on the `vmwgfx` virtual GPU. The compositor (`packages/compositor-core`) is a Rust binary that uses
runtime `dlopen` for libdrm/GBM/EGL/GLES/libinput. Wire its self-test into a bootable image:
1. **Rust-in-docker build helper** (`tools/build/rust-in-docker.mjs`, mirroring `tools/build/go-in-docker.mjs`):
   build `packages/compositor-core` for **linux x86_64** in a pinned `rust:*-bookworm` (or slim) container — Borg51 has
   docker, no native cargo. Deterministic flags; output a release binary to a known path. No network at runtime in the
   image; the build container may fetch crates from the vendored lockfile only (Cargo.lock present, `--locked`).
2. **Bake the binary + a self-test boot service into the x86_64 image** (smoke/test overlay — this is a VERIFICATION
   integration, NOT shipping the compositor in the production OS): install the built binary at e.g.
   `os/x86_64/smoke-overlay/usr/lib/vita/compositor/vita-compositor`, and add a systemd unit
   `os/x86_64/smoke-overlay/usr/lib/systemd/system/vita-compositor-selftest.service` that runs the compositor's
   self-test ONCE at boot — AFTER the GPU is up (`After=systemd-modules-load.service`, the vmwgfx module-load + `/dev/dri`
   present; gate on `/dev/dri/card0` or a `ConditionPathExists`) — with stdout/stderr to the console/serial so the
   `VITA-COMPOSITOR: ... present=kms ... status=OK` (or `status=FAILSAFE`) line lands in the serial log. Do NOT regress
   the existing 22 markers; the service is additive + must fail-closed (its failure prints FAILSAFE, never hangs boot).
3. Keep the build reproducible + the determinism test updated if the package set changes.

## User value
Turns the compositor from "builds + unit-tested" into "verifiable on a real (virtual) GPU" — the boot where we learn if
KMS modeset/GBM scanout/page-flip actually works on `vmwgfx`. The decisive GPU verification.

## Non-goals
- NOT shipping the compositor in the production OS (it's a desktop-package substrate); this is a verification-only bake
  in the smoke/test overlay.
- No shell/WM/content yet — just the compositor self-test presenting test surfaces.

## Acceptance
`acceptance_command` passes; `tools/build/rust-in-docker.mjs` builds the compositor for linux x86_64 in docker; the
smoke overlay carries the binary + the self-test service. INDEPENDENT verification (orchestrator): build the image,
boot it on the VMware 3D-accel target (`node tools/vmware-verify.mjs --image <img> --markers VITA-COMPOSITOR`), and read
the serial — a real `VITA-COMPOSITOR present=kms status=OK` means it paints; `status=FAILSAFE reason=...` tells us
exactly what's missing on vmwgfx (then iterate). State honestly which result occurred.

## Security/constraints
- Verification bake only (smoke/test overlay), not the production image. The service runs once, fail-closed, no privilege
  beyond DRM/input device access. No remote imports; `--locked` crates; no lifecycle scripts.

## Definition of done
- `rust-in-docker.mjs` builds the compositor for linux x86_64; the smoke overlay has the binary + a fail-closed boot
  self-test service emitting VITA-COMPOSITOR to serial; the 22 markers still pass; reproducible. R2 reviewer gate;
  orchestrator confirms the VMware boot result (paints vs FAILSAFE) honestly.
