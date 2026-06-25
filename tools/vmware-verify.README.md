# VMware boot verification harness

`tools/vmware-verify.mjs` boots a Vita raw disk image under VMware Workstation Pro with UEFI, a VMware virtual display, 3D acceleration, serial logging, marker polling, and screenshot capture. It is the display/GPU counterpart to `tools/wsl-verify.sh`.

## Self-check

Run this before live bring-up:

```powershell
node tools/vmware-verify.mjs --self-check
```

The self-check does not boot a VM. It reports whether `vmrun` and `qemu-img` are visible on the host, renders the VMX template, and checks marker detection against passing and failing fixture serial logs. Missing host tools are reported because CI/workers may not have VMware installed; live verification still requires them.

## Live boot

Prerequisites:

- VMware Workstation Pro installed with `vmrun.exe` available. The default path is `C:\Program Files\VMware\VMware Workstation\vmrun.exe`; override with `--vmrun`, `VITA_VMRUN`, or `VMRUN`.
- `qemu-img` reachable either through WSL Ubuntu as `wsl -d Ubuntu -u root -- qemu-img` or as a native Windows executable passed with `--qemu-img`, `VITA_QEMU_IMG`, or `QEMU_IMG`.
- A Vita test/smoke raw disk image that prints userspace and `VITA-*` markers to the serial console.
- VMware 3D acceleration support enabled on the host GPU.

Example:

```powershell
node tools/vmware-verify.mjs `
  --image os\x86_64\out\vita-debian-trixie-x86_64.raw `
  --markers "VITA-COMPOSITOR,VITA-FOO" `
  --secure-boot off
```

The harness converts the raw image to an up-to-date `.vmdk`, generates a `.vmx`, starts it with:

```powershell
vmrun -T ws start <vmx> nogui
```

It waits for a userspace-up serial signal plus all requested markers, captures a frame with `vmrun captureScreen <vmx> <png>`, prints `RESULT: PASS` or `RESULT: FAIL`, stops the VM, and deletes the generated VM unless `--keep` is set.

## VM shape

The generated VMX uses:

- `firmware = "efi"` by default.
- `uefi.secureBoot.enabled = "FALSE"` by default; pass `--secure-boot on` only for images built for Secure Boot.
- 2 vCPU and 2048 MB RAM.
- AHCI SATA boot disk pointing at the generated VMDK.
- `serial0.fileType = "file"` and `serial0.fileName = "<out-dir>/serial.log"`.
- `mks.enable3d = "TRUE"`, SVGA memory settings, and `vmotion.checkpointFBSize` for the virtual GPU/display floor.
- Network, USB, sound, and shared-folder integration disabled for the verification VM.

By default outputs are written beside the raw image under `<image-stem>.vmware\`. Use `--out-dir` and `--screenshot` to choose explicit locations.
