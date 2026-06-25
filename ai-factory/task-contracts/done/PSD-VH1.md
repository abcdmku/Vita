---
id: PSD-VH1
title: VMware-boot verification harness (GPU/display floor for Phase 6 desktop slices)
status: ready
phase: 6
pod: desktop
risk_class: R1
fr: []
depends_on: []
target_paths:
  - tools/vmware-verify.mjs
  - tools/vmware-verify.README.md
acceptance_command: "node tools/vmware-verify.mjs --self-check"
allowed_network: false
budget_minutes: 90
---

## Objective
Build a **VMware Workstation Pro boot-verification harness** — the GPU/display analog of `tools/wsl-verify.sh` — so the
Phase-6 GPU slices (PSD-000 spike, PSD-002 compositor, PSD-003 texture bridge) get a real measured-marker verification
floor on a virtual GPU with 3D acceleration. The OS marker pipeline today is headless QEMU on Borg51; this harness adds
a VMware target with a display + 3D accel.

`tools/vmware-verify.mjs` (Node ESM, runs on the Windows host) must, given a Vita raw disk image:
1. **Convert** the raw image to VMware `.vmdk` (use `qemu-img convert -O vmdk <raw> <vmdk>`; qemu-img is available in WSL
   at `wsl -d Ubuntu -u root -- qemu-img ...`, or document a Windows qemu-img path). Idempotent; skip if up to date.
2. **Generate a `.vmx`** for a UEFI VM with: `firmware = "efi"`, 2+ vCPU, 2048+ MB RAM, the vmdk as the boot disk, a
   serial port redirected to a host file (`serial0.fileType = "file"`, `serial0.fileName = "<serial.log>"`), 3D
   acceleration ENABLED (`mks.enable3d = "TRUE"`, `vmotion.checkpointFBSize`, an appropriate `svga` config), and
   headless-friendly options. Parameterize firmware/secure-boot (the smoke image may need secure boot OFF).
3. **Boot** the VM via `vmrun` (path: `C:\Program Files\VMware\VMware Workstation\vmrun.exe`) —
   `vmrun -T ws start <vmx> nogui` — with a timeout.
4. **Wait for markers** in the serial log (same grep approach as wsl-verify.sh boot_ts: poll the serial file for a
   userspace-up signal and the requested `VITA-*` markers), with a timeout.
5. **Capture a screenshot/frame** of the running VM (`vmrun captureScreen <vmx> <png>`) for GPU/visual checks
   (CPU-readback is allowed here — this is the test/screenshot path).
6. **Assert + clean up**: report PASS/FAIL on the requested markers; `vmrun stop <vmx>` (and `deleteVM` on a temp VM);
   print the serial tail on failure.

CLI: `node tools/vmware-verify.mjs --image <raw> --markers "VITA-COMPOSITOR,VITA-FOO" [--keep] [--secure-boot off]`,
and `--self-check` (used as the acceptance): validate that `vmrun` is found, qemu-img is reachable, the vmx template
renders, and the arg parsing/marker-grep logic works on a FIXTURE serial log — WITHOUT booting a real VM (the worker
cannot run VMware). The self-check must exercise the vmx generation + marker-detection logic against fixtures.

## User value
Unblocks measured GPU verification for the desktop compositor/spike slices — the render/composite split, accelerated
OSR, and frame correctness can be verified on a real virtual GPU instead of being unverifiable on headless QEMU.

## Non-goals
- Do NOT require a real VMware boot in the acceptance (the worker has no VMware); the orchestrator iterates the live
  boot. Make the logic correct + fixture-tested so the live bring-up is mostly config tuning.
- No changes to the OS image or the existing Borg51 wsl-verify flow.

## Acceptance
`node tools/vmware-verify.mjs --self-check` exits 0: vmrun/qemu-img presence reported, vmx template renders with the
3D-accel + serial-to-file + UEFI options, and the marker-detection works against a fixture serial log (a fixture with
the markers passes; one missing a marker fails). Documented in `tools/vmware-verify.README.md` (how the orchestrator
runs a real boot + the VMware VM requirements: 3D accel on, UEFI, secure-boot note).

## Security/constraints
- Host tooling only; no secrets; no network. Use TEST/smoke images only.
- Don't hard-code absolute machine paths beyond the standard vmrun location (make them overridable by flag/env).

## Definition of done
- `tools/vmware-verify.mjs` implements convert → vmx-gen → vmrun boot → serial-marker wait → screenshot → assert →
  cleanup, with `--self-check` (fixture-tested, no real VM) as the acceptance; README documents live bring-up. R1.
