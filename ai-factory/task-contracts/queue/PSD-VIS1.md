---
id: PSD-VIS1
title: See the desktop — compositor demo layout + screenshot via open-vm-tools
status: ready
phase: 6
pod: desktop
risk_class: R1
fr: []
depends_on: [PSD-002]
target_paths:
  - packages/compositor-core
  - os/x86_64
acceptance_command: "npm run typecheck"
allowed_network: false
budget_minutes: 90
---

## Objective
Make the GPU compositor's output VISIBLE — produce a real PNG screenshot of a desktop-like layout rendered on the VMware
GPU, so the owner can SEE it. Build on the merged, GPU-verified compositor (PSD-002):
1. **Compositor demo layout + display hold:** add a `--demo` (or extend `--self-test`) mode to the compositor that
   composites a recognizable DESKTOP-LIKE layout on the real DRM/KMS scanout — e.g. a wallpaper fill, a top panel bar,
   and 2-3 window rectangles (distinct colors/positions, a titlebar strip), using the same GPU texture + present=kms
   path. After presenting, HOLD the display for a configurable duration (e.g. `--hold-seconds 8`, default a few seconds)
   so it can be captured, THEN exit cleanly. Keep the existing self-test marker behavior (still emit VITA-COMPOSITOR).
2. **open-vm-tools in the verification image:** add `open-vm-tools` to the x86_64 mkosi verification/smoke build so the
   VMware guest supports `vmrun captureScreen` (it currently fails: "Anonymous guest operations are not allowed").
   Minimal; don't regress the 22 markers; verification overlay only (not production).
3. **Self-test service runs the demo + holds** so the harness can screenshot during the hold window.

## User value
Turns "the compositor paints (per the marker)" into "here is a PNG of the desktop layout rendered on the GPU" — the
owner can finally SEE the GPU output, and we have a visual regression artifact to iterate the look against the mockup.

## Non-goals
- NOT the full shell/WM-driven desktop yet (that's the next slice — wiring the merged TS shell/WM to drive the
  compositor over the seam). This is a compositor-drawn demo layout to prove visible GPU output + the screenshot path.
- NO web content/engine.

## Acceptance
`npm run typecheck`; the compositor builds for linux (rust-in-docker). INDEPENDENT verification (orchestrator): build
the image, boot on the 3D-accel VMware VM, and `vmrun captureScreen` now SUCCEEDS during the display hold → a PNG
showing the composited desktop-like layout (panel + windows). The compositor still emits VITA-COMPOSITOR present=kms.
Report the screenshot path.

## Security/constraints
- Verification/demo only (smoke overlay), not the production OS. open-vm-tools in the verification image only. Fail-closed
  if DRM/KMS unavailable. No remote imports; lockfile; no lifecycle scripts.

## Definition of done
- Compositor `--demo`/hold mode draws a desktop-like layout on the GPU and holds the display; open-vm-tools in the
  verification image enables `vmrun captureScreen`; the orchestrator captures a PNG of the GPU-rendered layout on VMware;
  22 markers + VITA-COMPOSITOR present=kms intact. R1.
