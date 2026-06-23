# Installing Vita on real hardware

This guide takes you from a freshly built Vita image to a machine that boots Vita from its own
disk. The flow is:

1. **Build** the bootable image on a Linux build host.
2. **Boot a live Linux** environment on (or next to) the target machine.
3. **Write** the image to the target disk with [`tools/install-vita.sh`](../tools/install-vita.sh).
4. **Enroll the Vita Secure Boot key** in the *target machine's* UEFI firmware (a manual,
   one-time firmware step — see [§4](#4-enroll-the-secure-boot-key-firmware-manual-one-time)).

> ⚠️ **Writing the image ERASES the entire target disk.** `install-vita.sh` is built to be hard to
> misfire (it refuses the running system's disk, demands an explicit `--yes`, and has a `--dry-run`),
> but you are still pointing a `dd` at a whole disk. Double-check the device path every single time.

---

## 0. What the image is

`os/x86_64/build-and-boot.mjs` produces a **self-contained GPT raw disk** under
`os/x86_64/out/*.raw`. It is a complete disk image — partition table, ESP, kernel, root — not a
filesystem tarball. Two shapes exist depending on build mode:

| Mode | Partitions (in order) | Notes |
|------|-----------------------|-------|
| `smoke` (+`VITA_VERITY=1`) | `vita-esp` (vfat) · `vita-root` (ext4) · `vita-root-verity` (hash) | Fast iterate/boot image. |
| `full` | `vita-esp` · `vita-root-a` · `vita-root-b` · `vita-recovery` · **`vita-data`** | A/B + recovery + a growable data partition. |

The `.raw` is **content-sized** — it is only as large as the data it carries, so its GPT *backup*
header lands in the middle of a larger target disk and the trailing space is unallocated. The
installer fixes both: it relocates the backup GPT to the end of the target and grows the **last**
partition (the persistent `vita-data` partition in `full` mode) to fill the disk.

---

## 1. Build the image (on a Linux build host)

You need a privileged Linux host with `mkosi` (and, for `full` mode, `cryptsetup`/`veritysetup`).
See [`tools/wsl-verify.sh`](../tools/wsl-verify.sh) for the exact host setup the project uses.

```bash
# Smoke image (fast; verity-protected root):
VITA_VERITY=1 node os/x86_64/build-and-boot.mjs --mode=smoke --no-boot

# Or a full A/B + data image:
node os/x86_64/build-and-boot.mjs --mode=full --no-sign   # (signing covered in §4)
```

The artifact lands at `os/x86_64/out/<name>.raw`. Copy that file onto a USB stick (or keep it on
the build host if the build host is also where you'll run the installer).

---

## 2. Boot a live Linux on the target

You write the image from *a running Linux that is NOT using the target disk*. Options:

- A **live Linux USB** (Ubuntu, Debian, Fedora, Arch — any will do) booted on the target machine,
  with a *second* USB/disk holding the `.raw`.
- Any **other Linux host** with the target disk attached externally (USB-SATA dock, etc.).

The installer needs these tools (all standard): `dd`, `sgdisk` (gdisk), `sfdisk`, `lsblk`,
`blockdev`. For `--grow-fs` it also needs `resize2fs` (e2fsprogs). On Debian/Ubuntu:

```bash
sudo apt-get install -y gdisk util-linux coreutils e2fsprogs
```

### Identify the target disk

```bash
lsblk -o NAME,SIZE,MODEL,TYPE,MOUNTPOINT
```

Pick the **whole disk** (e.g. `/dev/sdb`, `/dev/nvme0n1`), **not** a partition (`/dev/sdb1`). If
you are running off a live USB, the target is the machine's internal disk; if you are using an
external dock, it's the docked disk. The installer will refuse anything that backs the running
system, but identify it yourself anyway.

---

## 3. Write the image with `install-vita.sh`

### 3.1 Dry-run first (always)

`--dry-run` prints every action — the `dd`, the GPT backup relocation, the grow plan, the
verification — and **writes nothing**. Run it as a normal user to review the plan:

```bash
tools/install-vita.sh /dev/sdX --image os/x86_64/out/<name>.raw --dry-run --grow-fs
```

You should see the target's model/size, the partitions that will be destroyed, and the exact
commands. If the device or sizes look wrong, stop here.

### 3.2 The real write

```bash
sudo tools/install-vita.sh /dev/sdX --image os/x86_64/out/<name>.raw --yes --grow-fs
```

- If you **omit `--image`**, it uses the newest `os/x86_64/out/*.raw`.
- If you **omit `--yes`**, it shows the target and asks you to *type the exact device path* to
  confirm (an extra guard against fat-fingering the wrong disk).
- `--grow-fs` grows the `vita-data` ext4 filesystem to the new partition size immediately. Omit it
  and the partition is still grown, but the filesystem is left for first boot to expand (see below).

What it does, in order:

1. **Write** — `dd if=<image> of=/dev/sdX bs=4M conv=fsync` (byte-for-byte image → disk).
2. **Repair GPT** — `sgdisk --move-second-header` relocates the backup GPT to the disk end and fixes
   the alternate-LBA pointers (otherwise firmware warns and the trailing space is unusable).
3. **Grow** — recreates the **last** partition from its original start to the disk end, preserving
   its type GUID, unique GUID, and name (`vita-data`). With `--grow-fs`, also `resize2fs` the ext4.
4. **Verify** — `sgdisk -v` (GPT integrity) + `sfdisk -l` (final table), and asserts the target now
   has ≥2 partitions including an EFI System Partition. Prints `RESULT: PASS` or `FAIL`.

### 3.3 Options reference

| Flag | Effect |
|------|--------|
| `--image PATH` | Image to write (default: newest `os/x86_64/out/*.raw`). |
| `--yes` / `-y` | Skip the interactive "type the device" confirmation. |
| `--dry-run` / `-n` | Print every action, write nothing (safe to run as a normal user). |
| `--grow-fs` | After growing the partition, also grow its ext4 filesystem now. |
| `--no-grow` | Leave the last partition at its image size (let first-boot `systemd-repart` grow it). |
| `--keep-backup-gap` | Skip the GPT backup relocation (rarely wanted; firmware will warn). |

### 3.4 Grow now, or grow on first boot?

You have two equivalent ways to claim the rest of the disk for `vita-data`:

- **Grow at install time** (default; add `--grow-fs` to also size the filesystem). Simplest — the
  disk is fully provisioned before it ever boots.
- **Grow on first boot via `systemd-repart`.** Pass `--no-grow` to the installer and instead let
  the OS expand the data partition itself on first boot. For this the image must ship a `repart.d`
  drop-in for the data partition with `GrowFileSystem=yes` and no fixed size cap. The full-mode
  layout already routes through `systemd-repart` (`os/x86_64/build-and-boot.mjs` step 4), so this is
  the natural path once the data partition's repart definition lands; until then, prefer the
  install-time grow above.

### Safety guarantees (why this is hard to misfire)

- **Refuses the running system's disk.** It resolves the whole disk backing `/`, `/boot`,
  `/boot/efi`, `/etc`, and any active swap, and aborts if the target matches any of them.
- **Whole-disk only.** It rejects partition nodes (`/dev/sdb1`) and non-disk nodes.
- **Explicit intent required.** Either `--yes` or typing the exact device path.
- **Won't overflow.** Aborts if the image is larger than the target.
- **`--dry-run` writes nothing** and needs no root.

---

## 4. Enroll the Secure Boot key (firmware, manual, one-time)

Vita's boot artifacts are signed with the owner's Secure Boot key. For the target machine to trust
them, **its UEFI firmware must trust that key** — and enrolling a key into firmware is a manual step
you perform in the machine's UEFI setup. **There is no way around this from software on a fresh
machine**; Secure Boot's whole point is that the firmware owner decides what to trust.

> Honest expectations: this is the one step that *cannot* be fully automated by the installer. Every
> vendor's UEFI setup looks different, and some consumer firmwares hide or restrict custom-key
> enrollment. Budget a few minutes of poking around the firmware menus, and keep a fallback in mind
> (below).

### The certificate

The public certificate to enroll is the owner's Secure Boot **db** cert (referred to as
`vita-db.crt`). For the project's throwaway/test keystore this is generated by
[`tools/secureboot-test-keys.sh`](../tools/secureboot-test-keys.sh) at
`os/x86_64/.secureboot/db.crt` (gitignored — keys never ship). For a real deployment, use the
owner's production db certificate. The installer copies the whole image onto the disk, so you can
also place a copy of `vita-db.crt` onto the ESP (e.g. `/EFI/vita/vita-db.crt`) before/after writing
so the firmware's "enroll from file" browser can find it on the freshly installed disk.

### Steps (general — exact labels vary by vendor)

1. Boot the target into **UEFI/BIOS setup** (usually `Del`, `F2`, `F10`, or `Esc` at power-on).
2. Find the **Secure Boot** section (often under *Security* or *Boot*).
3. Put Secure Boot into **Setup Mode** / **Custom Mode** (this is what allows enrolling your own
   keys; some firmwares call it "Clear Secure Boot keys" → then "Custom").
4. Use **"Enroll key from file"** / **"Append/Add db"** (wording varies):
   - Browse to `vita-db.crt` on the ESP (e.g. `\EFI\vita\vita-db.crt`) or on a USB stick.
   - Enroll it into **db** (the allowed-signatures database). On firmwares that require it, also set
     **KEK** and **PK** — for a self-owned single-key setup the same cert can serve as PK/KEK/db.
5. **Save and exit** with Secure Boot **enabled**. The machine should now boot the Vita UKI.

This mirrors how the project enrolls the key for QEMU testing (offline, via `virt-fw-vars`, in
`os/x86_64/build-and-boot.mjs`) — on real hardware the equivalent enrollment happens in firmware.

### If you can't (or don't want to) enroll a custom key

- **Disable Secure Boot** in the firmware. Vita will boot unsigned. You lose the trusted-boot
  guarantee, but it's a valid path for testing or for machines whose firmware won't take custom keys.
- Some firmwares only ship Microsoft's keys and block custom enrollment entirely; on those, disabling
  Secure Boot is the only option.

---

## 5. First boot

Move the disk back into the target machine (if you wrote it via an external dock), set the firmware
to boot from it, and power on. On `full` images with a verity'd root, the root is read-only and a
writable overlay is provided; persistent state lives on the grown `vita-data` partition.

---

## Troubleshooting

| Symptom | Likely cause / fix |
|---------|--------------------|
| `RESULT: FAIL (expected ≥2 partitions incl. an ESP)` | Wrong/corrupt `--image`, or the write was interrupted. Re-run; check `sfdisk -l /dev/sdX`. |
| Installer refuses with "backs the RUNNING system" | You pointed it at the live environment's own disk. Use the *other* disk. |
| Firmware: "GPT backup at wrong location" | The backup-header relocation didn't run — don't use `--keep-backup-gap`; re-run the installer. |
| Machine boots to firmware, not Vita | Secure Boot key not enrolled (§4) **or** Secure Boot left on without the key. Enroll the key or disable Secure Boot. |
| Data partition is small / didn't grow | You used `--no-grow` and first-boot repart isn't configured yet. Re-run with the default grow (and `--grow-fs`). |

---

*Reference:* image build — [`os/x86_64/build-and-boot.mjs`](../os/x86_64/build-and-boot.mjs);
installer — [`tools/install-vita.sh`](../tools/install-vita.sh); SB test keystore —
[`tools/secureboot-test-keys.sh`](../tools/secureboot-test-keys.sh).
