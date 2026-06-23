# Installing Vita on real hardware

This guide takes you from a freshly built Vita image to a machine that boots Vita from its own
disk. The flow is:

1. **Build** the bootable image on a Linux build host. *If you will enroll a Secure Boot key (step 4),
   build a SIGNED image* (`VITA_SECURE_BOOT=1`) so the signature matches the cert you enroll.
2. **Boot a live Linux** environment on (or next to) the target machine.
3. **Write** the image to the target disk with [`tools/install-vita.sh`](../tools/install-vita.sh).
4. **Enroll the Vita Secure Boot key** in the *target machine's* UEFI firmware (a manual,
   one-time firmware step - see [section 4](#4-enroll-the-secure-boot-key-firmware-manual-one-time)).
   The cert you enroll must be the one that signed the image in step 1, or boot unsigned with Secure
   Boot disabled.

> WARNING: **Writing the image ERASES the entire target disk.** `install-vita.sh` is built to be hard
> to misfire (it refuses any physical disk backing the running system, demands an explicit `--yes`,
> aborts if it cannot unmount the target, and has a `--dry-run`), but you are still pointing a `dd` at
> a whole disk. Double-check the device path every single time.

---

## 0. What the image is

`os/x86_64/build-and-boot.mjs` produces a **self-contained GPT raw disk** under
`os/x86_64/out/*.raw`. It is a complete disk image - partition table, ESP, kernel, root - not a
filesystem tarball. Two shapes exist depending on build mode:

| Mode | Partitions (in order) | Notes |
|------|-----------------------|-------|
| `smoke` (+`VITA_VERITY=1`) | `vita-esp` (vfat) / `vita-root` (ext4) / `vita-root-verity` (hash) / **`vita-data`** (ext4) | Fast iterate/boot image. Since P1-029 it ships a growable `vita-data` partition (mounted at `/var`); the installer grows it. |
| `full` | `vita-esp` / `vita-root-a` / `vita-root-b` / `vita-recovery` / **`vita-data`** | A/B + recovery + a growable data partition. |

> **`vita-data` is the LAST partition in both layouts.** The verity layout's data partition is
> defined by [`os/x86_64/repart-verity/40-data.conf`](../os/x86_64/repart-verity/40-data.conf)
> (`FileSystemLabel=vita-data`, mounted at `/var`); it lands *after* the root + root-verity-hash
> partitions, so growing it never disturbs the dm-verity tree.

The `.raw` is **content-sized** - it is only as large as the data it carries, so its GPT *backup*
header lands in the middle of a larger target disk and the trailing space is unallocated. The
installer fixes both: it relocates the backup GPT to the end of the target and grows the partition
**labeled `vita-data`** (present in **both** verity and full images) to fill the disk. It identifies
that partition explicitly by label and **never** grows or `resize2fs`-es the root or verity-hash
partitions. (Only a legacy image that ships *no* `vita-data` partition causes the installer to skip
growth entirely.)

---

## 1. Build the image (on a Linux build host)

You need a privileged Linux host with `mkosi` (and, for `full` mode, `cryptsetup`/`veritysetup`).
See [`tools/wsl-verify.sh`](../tools/wsl-verify.sh) for the exact host setup the project uses.

**If you intend to enroll a Secure Boot key (section 4), build a SIGNED image now** - an unsigned
image will *not* be trusted by the cert you enroll, so Secure Boot would refuse to boot it. The
signed build signs the UKI with the owner's **db** key (`db.key`/`db.crt`) - the **same** cert you
will enroll into firmware in section 4. Generate the throwaway test keystore first if you do not
have a production key (it is gitignored - keys never ship):

```bash
# 0) (test/dev) make the throwaway SB keystore at os/x86_64/.secureboot/{db.key,db.crt}:
bash tools/secureboot-test-keys.sh

# SIGNED verity image (the Secure Boot path - section 4 enrolls db.crt to match this signature):
VITA_SECURE_BOOT=1 VITA_VERITY=1 node os/x86_64/build-and-boot.mjs --mode=smoke --no-boot
#   uses os/x86_64/.secureboot/db.key + db.crt by default; override with
#   VITA_TEST_SECUREBOOT_KEY_PATH / VITA_TEST_SECUREBOOT_CERT_PATH (e.g. a production key/cert).

# Or a SIGNED full A/B + data image (per-slot UKIs signed via VITA_SB_KEY / VITA_SB_CERT):
VITA_SB_KEY=os/x86_64/.secureboot/db.key VITA_SB_CERT=os/x86_64/.secureboot/db.crt \
  node os/x86_64/build-and-boot.mjs --mode=full --no-boot
```

> **Unsigned / dev path (no Secure Boot).** If you are NOT going to enroll a key - you will boot
> with Secure Boot *disabled* (section 4, "If you can't enroll a custom key") - you can build
> unsigned instead: `VITA_VERITY=1 node os/x86_64/build-and-boot.mjs --mode=smoke --no-boot` or
> `node os/x86_64/build-and-boot.mjs --mode=full --no-sign`. Do **not** mix this with an enrolled
> key: an unsigned image plus an enrolled cert will fail Secure Boot. Match the build to the boot
> mode you intend.

The artifact lands at `os/x86_64/out/<name>.raw`. Copy that file onto a USB stick (or keep it on
the build host if the build host is also where you'll run the installer). Whichever image you build,
the disk-write steps below are identical; only the firmware step (section 4) differs by whether the
image is signed.

---

## 2. Boot a live Linux on the target

You write the image from *a running Linux that is NOT using the target disk*. Options:

- A **live Linux USB** (Ubuntu, Debian, Fedora, Arch - any will do) booted on the target machine,
  with a *second* USB/disk holding the `.raw`.
- Any **other Linux host** with the target disk attached externally (USB-SATA dock, etc.).

The installer needs these tools (all standard): `dd`, `sgdisk` (gdisk), `sfdisk`, `lsblk`,
`blockdev`, and **`findmnt`**. `findmnt` is part of the *safety boundary* - it is how the installer
resolves which physical disks back the running system so it can refuse them - so it is **required**,
not optional: if it is missing the installer exits **code 2 before writing anything** rather than
proceeding with a weakened system-disk check. For `--grow-fs` it also needs `resize2fs`, `e2fsck`,
and `blkid` (e2fsprogs + util-linux). A missing required tool makes the installer exit with **code
2**. On Debian/Ubuntu:

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
system (resolving the full LVM/dm-crypt/md stack), but identify it yourself anyway.

---

## 3. Write the image with `install-vita.sh`

### 3.1 Dry-run first (always)

`--dry-run` prints every action - the `dd`, the GPT backup relocation, the grow plan, the
verification - and **writes nothing**. Run it as a normal user to review the plan:

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
  `--grow-fs` only ever runs on an ext4 `vita-data` partition; it refuses to `resize2fs` anything
  else.

What it does, in order:

1. **Unmount + write** - unmounts any node (the whole disk and every partition) currently mounted
   from the target with a **plain `umount` (never a lazy `umount -l`)**, **aborting (exit 3) if any
   of them cannot be unmounted** - it will not `dd` against a busy disk, and it will not lazily
   detach a still-active filesystem and then write over it. After unmounting it **re-verifies** that
   no target node is still mounted before writing. Then `dd if=<image> of=/dev/sdX bs=4M conv=fsync`
   (byte-for-byte image -> disk).
2. **Repair GPT** - `sgdisk --move-second-header` relocates the backup GPT to the disk end and fixes
   the alternate-LBA pointers (otherwise firmware warns and the trailing space is unusable).
3. **Grow `vita-data`** - finds the partition whose GPT label (or ext4 filesystem label) is
   `vita-data` (present in **both** verity and full images), recreates it from its original start to
   the disk end, preserving its type GUID, unique GUID, and name. With `--grow-fs`, it first runs
   `e2fsck -fy` and then `resize2fs` the ext4. **A serious `e2fsck` failure (errors left uncorrected,
   or an operational error) is FATAL**: the installer aborts (exit 3) **before** `resize2fs` rather
   than resize a corrupt filesystem. The root and verity-hash partitions are **never** grown or
   resized. **Only a legacy image that ships no `vita-data` partition makes this step SKIP entirely.**
4. **Verify** - `sgdisk -v` (GPT integrity; **FATAL** - a failure here makes the run exit 3 and it
   will NOT print PASS) + `sfdisk -l` (final table), and asserts the target now has >=2 partitions
   including an EFI System Partition. Prints `RESULT: PASS` or `RESULT: FAIL`.

### 3.3 Options reference

| Flag | Effect |
|------|--------|
| `--image PATH` | Image to write (default: newest `os/x86_64/out/*.raw`). |
| `--yes` / `-y` | Skip the interactive "type the device" confirmation. |
| `--dry-run` / `-n` | Print every action, write nothing (safe to run as a normal user). |
| `--grow-fs` | After growing the `vita-data` partition, also grow its ext4 filesystem now. |
| `--no-grow` | Leave `vita-data` at its image size (let first-boot `systemd-repart` grow it). |
| `--keep-backup-gap` | Skip the GPT backup relocation (rarely wanted; firmware will warn). |

### 3.4 Exit codes

| Code | Meaning |
|------|---------|
| `0` | Success (or `--dry-run` plan printed). |
| `1` | Usage error or a safety refusal (bad args, system-disk target, image too big, no confirmation). |
| `2` | A required tool is missing. |
| `3` | Write/verify failure (unmount failed, GPT integrity check failed, or the final layout is wrong). |

### 3.5 Grow now, or grow on first boot?

You have two equivalent ways to claim the rest of the disk for `vita-data` (both verity and full
images ship this partition):

- **Grow at install time** (default; add `--grow-fs` to also size the filesystem). Simplest - the
  disk is fully provisioned before it ever boots.
- **Grow on first boot via `systemd-repart`.** Pass `--no-grow` to the installer and instead let
  the OS expand the data partition itself on first boot. For this the image's `repart.d` definition
  for `vita-data` must allow growth (no fixed size cap;
  [`os/x86_64/repart-verity/40-data.conf`](../os/x86_64/repart-verity/40-data.conf) uses
  `Weight=1000` and `SizeMinBytes` only, so repart expands it to fill the disk). Both layouts route
  through `systemd-repart` at build time (`os/x86_64/build-and-boot.mjs`), so first-boot growth is a
  natural path; the install-time grow above is simply the eager version of the same thing.

### Safety guarantees (why this is hard to misfire)

- **Refuses any physical disk backing the running system.** It resolves the whole *stack* (partition
  -> dm-crypt -> LVM -> md -> ... -> physical disk) for `/`, `/boot`, `/boot/efi`, `/etc`, and any
  active swap, and aborts if the target is any of those physical disks. It also handles the awkward
  roots: **Btrfs subvolumes** (whose `findmnt` source looks like `/dev/sda2[/@]` - the `[...]` suffix
  is stripped before resolving), and **live-media roots** mounted as `overlay` or a **squashfs on a
  loop device** (it follows the overlay's lower/upper layers and the loop's backing file back to the
  real disk). `findmnt` + `losetup` (which resolve those disks) are **required** tools: if either is
  absent the installer exits **before writing** rather than fall back to a weakened check.
- **Fail-closed when a system mount can't be resolved.** If `/`, `/boot`, `/boot/efi`, `/etc`, or an
  active swap is mounted but the installer cannot resolve it to a physical disk, it **aborts** rather
  than proceed with an incomplete protected-disk set (which could let it overwrite the running
  system's disk). It never "skips" an unresolvable critical mount.
- **Fail-closed on a busy target.** If a node on the target cannot be unmounted, it aborts before
  writing rather than `dd`-ing over a mounted filesystem. It uses a **plain `umount` (never a lazy
  `umount -l`)** so it cannot detach a still-active filesystem and write over it, and it re-verifies
  nothing is mounted before writing.
- **Grows only `vita-data`.** It never grows or `resize2fs`-es the root or verity-hash partition, and
  a serious `e2fsck` failure aborts the run **before** `resize2fs` (it never resizes a corrupt FS).
- **Whole-disk only.** It rejects partition nodes (`/dev/sdb1`) and non-disk nodes.
- **Explicit intent required.** Either `--yes` or typing the exact device path.
- **Won't overflow.** Aborts if the image is larger than the target.
- **Fatal GPT verification.** A failed `sgdisk -v` post-write check fails closed (exit 3, no PASS).
- **`--dry-run` writes nothing** and needs no root.

---

## 4. Enroll the Secure Boot key (firmware, manual, one-time)

Vita's boot artifacts are signed with the owner's Secure Boot key. For the target machine to trust
them, **its UEFI firmware must trust that key** - and enrolling a key into firmware is a manual step
you perform in the machine's UEFI setup. **There is no way around this from software on a fresh
machine**; Secure Boot's whole point is that the firmware owner decides what to trust.

> **This step only makes sense for a SIGNED image.** You must have built with `VITA_SECURE_BOOT=1`
> (verity) or `VITA_SB_KEY`/`VITA_SB_CERT` (full) in [section 1](#1-build-the-image-on-a-linux-build-host),
> signing with the **same** `db.key`/`db.crt` whose `db.crt` you enroll below. Enrolling a cert and
> then booting an *unsigned* image will fail Secure Boot (the firmware trusts the cert but the image
> carries no matching signature). If you built unsigned, either rebuild signed or use the
> "disable Secure Boot" fallback at the end of this section.

> Honest expectations: this is the one step that *cannot* be fully automated by the installer. Every
> vendor's UEFI setup looks different, and some consumer firmwares hide or restrict custom-key
> enrollment. Budget a few minutes of poking around the firmware menus, and keep a fallback in mind
> (below).

### The certificate

The public certificate to enroll is the owner's Secure Boot **db** cert (referred to as
`vita-db.crt`) - the **same cert that signed the image in [section 1](#1-build-the-image-on-a-linux-build-host)**.
For the project's throwaway/test keystore this is `os/x86_64/.secureboot/db.crt`, generated by
[`tools/secureboot-test-keys.sh`](../tools/secureboot-test-keys.sh) (gitignored - keys never ship)
and consumed by the signed build (`VITA_SECURE_BOOT=1`). For a real deployment, use the owner's
production db key/cert for both signing and enrollment. The installer copies the whole image onto the
disk, so you can also place a copy of `db.crt` onto the ESP (e.g. `/EFI/vita/vita-db.crt`)
before/after writing so the firmware's "enroll from file" browser can find it on the freshly
installed disk. **The signature on the image and the cert you enroll must come from the same
key-pair, or Secure Boot will reject the image.**

### Steps (general - exact labels vary by vendor)

1. Boot the target into **UEFI/BIOS setup** (usually `Del`, `F2`, `F10`, or `Esc` at power-on).
2. Find the **Secure Boot** section (often under *Security* or *Boot*).
3. Put Secure Boot into **Setup Mode** / **Custom Mode** (this is what allows enrolling your own
   keys; some firmwares call it "Clear Secure Boot keys" then "Custom").
4. Use **"Enroll key from file"** / **"Append/Add db"** (wording varies):
   - Browse to `vita-db.crt` on the ESP (e.g. `\EFI\vita\vita-db.crt`) or on a USB stick.
   - Enroll it into **db** (the allowed-signatures database). On firmwares that require it, also set
     **KEK** and **PK** - for a self-owned single-key setup the same cert can serve as PK/KEK/db.
5. **Save and exit** with Secure Boot **enabled**. The machine should now boot the Vita UKI.

This mirrors how the project enrolls the key for QEMU testing (offline, via `virt-fw-vars`, in
`os/x86_64/build-and-boot.mjs`) - on real hardware the equivalent enrollment happens in firmware.

### If you can't (or don't want to) enroll a custom key

- **Disable Secure Boot** in the firmware. Vita will boot unsigned. You lose the trusted-boot
  guarantee, but it's a valid path for testing or for machines whose firmware won't take custom keys.
- Some firmwares only ship Microsoft's keys and block custom enrollment entirely; on those, disabling
  Secure Boot is the only option.

---

## 5. First boot

Move the disk back into the target machine (if you wrote it via an external dock), set the firmware
to boot from it, and power on. On verity images the root is read-only (dm-verity), and persistent
state lives on the grown `vita-data` partition, mounted at `/var` (see
[`os/x86_64/repart-verity/40-data.conf`](../os/x86_64/repart-verity/40-data.conf)); full images add
A/B + recovery on top of the same data partition.

---

## Troubleshooting

| Symptom | Likely cause / fix |
|---------|--------------------|
| `RESULT: FAIL (expected >=2 partitions incl. an ESP)` | Wrong/corrupt `--image`, or the write was interrupted. Re-run; check `sfdisk -l /dev/sdX`. |
| `RESULT: FAIL` after "could not unmount" | A partition on the target is busy/mounted. Unmount it (`umount`), close any LVM/dm mapping, and re-run. The installer refuses to write a busy disk. |
| `sgdisk -v reported GPT integrity problems` (exit 3) | The post-write GPT check failed (fail-closed). Re-run the installer; if it persists the image or disk is bad. |
| Installer refuses with "physical disk backing the RUNNING system" | You pointed it at a disk the live environment is using (root/boot/swap, possibly through LVM/dm-crypt/overlay/squashfs). Use the *other* disk. |
| Installer aborts: "could not resolve the physical disk(s) backing the running system" | Fail-closed safety: a system mount (`/`, `/boot`, `/etc`, swap...) is mounted but couldn't be traced to a disk. Run on a live environment that isn't using the target, or inspect `findmnt` / `lsblk -s` for that mount. |
| `vita-data` skipped: "no partition labeled 'vita-data'" | Only happens on a legacy image with no data partition. Current verity *and* full images ship `vita-data`; rebuild a current image (`VITA_VERITY=1 ...` or `--mode=full`). |
| Firmware: "GPT backup at wrong location" | The backup-header relocation didn't run - don't use `--keep-backup-gap`; re-run the installer. |
| Machine boots to firmware, not Vita | Secure Boot key not enrolled (section 4) **or** Secure Boot left on without the key **or** you wrote an *unsigned* image while Secure Boot is enabled. Build a signed image (`VITA_SECURE_BOOT=1 VITA_VERITY=1 ...`) and enroll the matching `db.crt`, or disable Secure Boot. |
| Data partition is small / didn't grow | You used `--no-grow` and first-boot repart hasn't run, or it's a legacy image with no `vita-data`. Use a current image with the default grow (and `--grow-fs`). |

---

*Reference:* image build - [`os/x86_64/build-and-boot.mjs`](../os/x86_64/build-and-boot.mjs);
installer - [`tools/install-vita.sh`](../tools/install-vita.sh); SB test keystore -
[`tools/secureboot-test-keys.sh`](../tools/secureboot-test-keys.sh).
