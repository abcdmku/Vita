# Vita OS — build & boot runbook (x86_64)

How to turn the in-repo build *plans* into a booting image on a **Linux host**. This environment (Windows,
unprivileged Docker, no QEMU, ghcr pull `denied`) can't run it; this is the turnkey guide for a host that can.

**One-script executor:** [`os/x86_64/build-and-boot.mjs`](x86_64/build-and-boot.mjs) runs the whole pipeline,
deriving its mkosi/ukify commands from the planners below. Try it first with `--dry-run` (prints every command,
needs nothing installed):
```sh
node os/x86_64/build-and-boot.mjs --dry-run --mode=full     # inspect the full chain
node os/x86_64/build-and-boot.mjs --mode=smoke              # on a Linux host: rootfs -> unsigned disk -> QEMU
VITA_SB_KEY=… VITA_SB_CERT=… node os/x86_64/build-and-boot.mjs --mode=full   # full trusted boot
```
The manual steps below explain each stage the script automates.

The repo files are deterministic **planners** (no-I/O, per spec §8.2): they emit the exact commands but don't
execute them. The script (and this runbook) is the executor.

- `os/x86_64/build-root.mjs` → the `docker run … mkosi …` rootfs build
- `os/x86_64/uki.mjs` → the `ukify` UKI build
- `os/x86_64/image-layout.mjs` → the GPT + RAUC A/B + ESP layout (systemd-repart)
- `os/common/mkosi.conf` / `os/x86_64/mkosi.conf` → Debian **trixie**, snapshot mirror `20260613T000000Z`,
  `Format=directory`, package allowlist (bash, systemd, `linux-image-amd64`, initramfs-tools, udev, …)

## 0. Prerequisites (the "what's needed" list, concretely)

| Need | Install / supply |
|---|---|
| Linux host (bare-metal/VM/WSL2) with **privileged** containers + loop devices | `apt install docker.io` (or podman); ability to `--privileged` |
| **mkosi image access** | the planned image is `ghcr.io/systemd/mkosi@sha256:8b3870c1…` — `docker login ghcr.io` then `docker pull` it (here the pull is `denied`). Or `pip install mkosi` and run host-native. |
| **Debian packages** | the snapshot mirror must be reachable for the package fetch. mkosi conf sets `WithNetwork=no`, and `build-root.mjs` runs `--network none`, so EITHER pre-populate the mkosi package cache (recommended, reproducible) **or** relax both for a first build. |
| `ukify`, `systemd-repart`, `veritysetup`, `sbsign`, `rauc` | `apt install systemd-ukify systemd-repart cryptsetup-bin sbsigntool rauc` |
| **QEMU + OVMF** (UEFI firmware) | `apt install qemu-system-x86 ovmf` |
| **Secure Boot signing keys + N-of-M recovery keys** | YOU supply these (spec §16 withholds them from dev agents). For a smoke test you can skip signing (see §A). |

## A. Minimal smoke path — see it boot FAST (unsigned, no verity)

Fastest way to confirm the rootfs boots, before wiring verity/signing:

```sh
# 1. Build the rootfs directory (resolve the exact docker args from the planner):
node -e 'import("./os/x86_64/build-root.mjs").then(m=>console.log(JSON.stringify(m.planBuildRoot?.() ?? m.default, null, 2)))'
#   → run the printed `docker run … mkosi … --output-dir os/x86_64/out` (drop `--network none` for the first
#     build so packages fetch; keep `--privileged` so mkosi can build). Produces os/x86_64/out/<rootfs dir>.

# 2. Pack the rootfs into a raw disk + ESP with a UKI, unsigned (smoke only):
mkosi --directory os/x86_64 --format disk --bootable=yes -f   # quick disk variant for smoke
#   (or systemd-repart per image-layout.mjs to build the GPT/A-B layout)

# 3. Boot it in QEMU with UEFI (OVMF), no Secure Boot:
qemu-system-x86_64 -machine q35 -m 2048 -enable-kvm \
  -drive if=pflash,format=raw,readonly=on,file=/usr/share/OVMF/OVMF_CODE.fd \
  -drive if=pflash,format=raw,file=OVMF_VARS.fd \
  -drive file=os/x86_64/out/vita.raw,format=raw,if=virtio \
  -serial mon:stdio -nographic
```
If it reaches a systemd console, the rootfs + kernel + UKI chain works. This is **not** the trusted boot — no
dm-verity, no signature — but it proves the image.

## B. Full trusted boot (production chain)

1. **Rootfs** — `build-root.mjs` plan → mkosi (`Format=directory`). Reproducible: keep `SOURCE_DATE_EPOCH`,
   the pinned snapshot, and the package allowlist (guarded by `os/x86_64/test/root-determinism.test.ts`).
2. **dm-verity** — ⚠️ **NOT yet implemented** ([P1-017](../ai-factory/task-contracts/blocked/P1-017.md), blocked
   pending a host to validate `veritysetup` args). Compute the per-slot hash tree over the read-only root,
   capture the **root hash**, and pass it on the kernel cmdline (`roothash=…`) so the kernel verifies every
   block. This is the integrity guarantee (spec §11) — a tampered root fails to boot.
3. **UKI** — `uki.mjs` plan → `ukify build` (kernel + initrd + the verity-bearing `cmdline` → one `.efi`).
4. **A/B layout** — `image-layout.mjs` → `systemd-repart` builds the GPT: ESP + A/B root slots + the
   RAUC/state partitions (see `os/x86_64/image-layout.mjs` partition table).
5. **Sign** — `sbsign --key <your SB key> --cert <cert>` the UKI; enroll the cert in OVMF/firmware for Secure
   Boot. Recovery-key escrow per spec §16 (N-of-M).
6. **RAUC bundle** — `rauc bundle` the signed slot image (`architecture/adr/0005-updates-rauc-ab.md`) for A/B
   updates.
7. **Boot** — QEMU as in §A but with `-global ICH9-LPC.disable_s3=1` + Secure Boot OVMF vars + the enrolled
   cert; confirm the verity root mounts read-only and the agent comes up.

## Where each gap is owned
- **Steps 1, 3, 4** — code-complete planners; just need a host to execute (items in §0).
- **Step 2 (dm-verity)** — needs implementation; I can land the deterministic scaffold from P1-017's design,
  but it can only be *validated* once it runs on a host with real `veritysetup`.
- **Step 5 (signing)** — needs YOUR keys.
- **Steps A.3 / B.7 (QEMU)** — needs QEMU+OVMF on the host.

Once a host exists, the orchestrator can execute the planners' commands, finish the dm-verity step, and
iterate to a verified boot.
