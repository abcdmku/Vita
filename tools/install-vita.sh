#!/bin/bash
# Vita installer — write the built Vita GPT disk image onto a REAL target block device (P1-032).
#
# Vita's bootable artifact (os/x86_64/build-and-boot.mjs) is a self-contained GPT raw disk:
#   smoke/verity:  ESP (vfat) + root (ext4, dm-verity data) + root-verity (hash)
#   full:          ESP + root-a + root-b + recovery + data        (the data partition grows to fill)
# This script writes that whole .raw byte-for-byte onto a target disk (/dev/sdX), repairs the GPT
# backup header (the .raw is sized to its content, so the backup header lands mid-disk), and — for
# images that carry a growable data partition — grows the LAST partition to fill the rest of the
# disk. The result boots on real hardware (after the one-time Secure Boot firmware enrollment that
# can only be done in the target's UEFI setup — see docs/install.md).
#
# THIS IS A DESTRUCTIVE OPERATION. It overwrites the entire target disk. Safety is the whole point:
#   • refuses to write to the disk the running system booted from (root/boot/swap backing device),
#   • requires the EXACT target path AND an explicit --yes,
#   • shows the target's model/size/partitions and (without --yes) makes you type the device to confirm,
#   • --dry-run prints every action and writes NOTHING,
#   • verifies the written partition table afterwards (sfdisk -l).
#
# USAGE:
#   tools/install-vita.sh /dev/sdX [--image PATH] [--yes] [--dry-run]
#                                  [--no-grow] [--grow-fs] [--keep-backup-gap]
#
#   /dev/sdX            target WHOLE disk (not a partition — /dev/sdb, NOT /dev/sdb1)
#   --image PATH        path to the .raw image (default: newest os/x86_64/out/*.raw)
#   --yes               actually write (skip the interactive type-the-device confirmation)
#   --dry-run           print every action, write nothing (implies a full plan walkthrough)
#   --no-grow           do NOT grow the last partition to fill the disk (leave repart to do it on first boot)
#   --grow-fs           after growing the partition, also grow its ext4 filesystem (resize2fs)
#   --keep-backup-gap   skip `sgdisk -e` (relocate GPT backup header) — almost never what you want
#
# EXIT CODES: 0 ok · 1 usage/safety refusal · 2 missing tool · 3 write/verify failure
#
# House style mirrors tools/wsl-verify.sh: set -euo pipefail, defensive quoting, =====/RESULT banners,
# no destructive default. Run as root (block-device writes need it). Tested via bash -n + a loopback
# image (truncate+losetup) so the write/repair/grow path is exercised without real hardware.
set -euo pipefail

# ── repo discovery (so --image default + relative paths resolve from anywhere) ──────────────────────
SELF="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$SELF/.." && pwd)"
OUT_DIR="$REPO/os/x86_64/out"

# ── argument parsing ────────────────────────────────────────────────────────────────────────────────
TARGET=""
IMAGE=""
ASSUME_YES=0
DRY_RUN=0
DO_GROW=1
DO_GROW_FS=0
RELOCATE_BACKUP=1

usage() {
  sed -n '2,33p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
  exit "${1:-1}"
}

while [ $# -gt 0 ]; do
  case "$1" in
    -h|--help)          usage 0 ;;
    --yes|-y)           ASSUME_YES=1 ;;
    --dry-run|-n)       DRY_RUN=1 ;;
    --no-grow)          DO_GROW=0 ;;
    --grow-fs)          DO_GROW_FS=1 ;;
    --keep-backup-gap)  RELOCATE_BACKUP=0 ;;
    --image)            shift; IMAGE="${1:-}" ;;
    --image=*)          IMAGE="${1#--image=}" ;;
    --*)                echo "✖ unknown option: $1" >&2; usage 1 ;;
    *)
      if [ -z "$TARGET" ]; then TARGET="$1"
      else echo "✖ unexpected extra argument: $1 (one target only)" >&2; usage 1; fi
      ;;
  esac
  shift
done

# ── tiny helpers ─────────────────────────────────────────────────────────────────────────────────────
die()  { echo "✖ $*" >&2; exit 1; }
warn() { echo "⚠ $*" >&2; }
info() { echo "  $*"; }
# Print a command and, unless --dry-run, run it. EVERY mutation of the target goes through this.
runcmd() {
  echo "    \$ $*"
  if [ "$DRY_RUN" = 1 ]; then return 0; fi
  "$@"
}
need() { command -v "$1" >/dev/null 2>&1 || die "missing required tool: $1 (install it; exit 2)"; }

# ── preconditions ────────────────────────────────────────────────────────────────────────────────────
[ -n "$TARGET" ] || { echo "✖ no target device given" >&2; usage 1; }

# Required tools. (resize2fs only needed for --grow-fs.)
for t in dd sgdisk sfdisk lsblk blockdev; do
  command -v "$t" >/dev/null 2>&1 || die "missing required tool: $t — install gdisk/util-linux (exit 2)"
done
[ "$DO_GROW_FS" = 1 ] && need resize2fs

# Must be root to write a block device (skip the hard check in dry-run so the plan is inspectable as a user).
if [ "$DRY_RUN" != 1 ] && [ "$(id -u)" != 0 ]; then
  die "must run as root to write a block device (re-run with sudo). Use --dry-run to preview as a normal user."
fi

# Resolve the default image: newest *.raw in os/x86_64/out (excludes OVMF_VARS*.fd etc).
if [ -z "$IMAGE" ]; then
  IMAGE="$(ls -t "$OUT_DIR"/*.raw 2>/dev/null | head -1 || true)"
  [ -n "$IMAGE" ] || die "no image given and none found in $OUT_DIR/*.raw — build first (node os/x86_64/build-and-boot.mjs ...) or pass --image PATH"
fi
[ -f "$IMAGE" ] || die "image not found: $IMAGE"
IMAGE="$(cd "$(dirname "$IMAGE")" && pwd)/$(basename "$IMAGE")"   # absolutize

# ── target validation: must be a WHOLE block device, not a partition ──────────────────────────────────
[ -b "$TARGET" ] || die "target is not a block device: $TARGET (pass a whole disk like /dev/sdb)"
# Canonicalize (resolve symlinks like /dev/disk/by-id/...). readlink -f is in coreutils.
TARGET="$(readlink -f "$TARGET")"
TGT_NAME="$(basename "$TARGET")"

# Reject partitions: a partition has a 'partition' devtype / a parent 'disk'. lsblk TYPE tells us.
TGT_TYPE="$(lsblk -ndo TYPE "$TARGET" 2>/dev/null | head -1 || true)"
if [ "$TGT_TYPE" != "disk" ] && [ "$TGT_TYPE" != "loop" ]; then
  die "target $TARGET is TYPE=$TGT_TYPE — pass the whole disk (e.g. /dev/sdb), not a partition or other node"
fi

# ── SAFETY: refuse to overwrite the running system's disk ─────────────────────────────────────────────
# Resolve the whole-disk device backing a given mount/path. lsblk PKNAME gives the parent disk of a
# partition; for a path we stat its source first. Returns "" if it cannot be resolved.
parent_disk_of_source() {
  # $1 = a /dev/... node (partition or disk)
  local node="$1" pk
  [ -b "$node" ] || return 0
  pk="$(lsblk -ndo PKNAME "$node" 2>/dev/null | head -1 || true)"
  if [ -n "$pk" ]; then echo "/dev/$pk"; else echo "$(readlink -f "$node")"; fi
}
disk_for_path() {
  # $1 = a filesystem path (e.g. /, /boot) → the whole disk that backs it, or "".
  local path="$1" src
  src="$(findmnt -no SOURCE --target "$path" 2>/dev/null | head -1 || true)"
  [ -n "$src" ] || return 0
  # SOURCE may be a /dev node, or a non-block source (overlay, tmpfs) → skip those.
  case "$src" in
    /dev/*) parent_disk_of_source "$src" ;;
    *) : ;;  # not a block-backed mount; nothing to protect here
  esac
}

PROTECTED_DISKS=""
# NB: must end with `return 0` — under `set -e`, a trailing `[ -n "" ] && …` would return 1 and abort.
add_protected() { if [ -n "$1" ]; then PROTECTED_DISKS="$PROTECTED_DISKS $1"; fi; return 0; }
if command -v findmnt >/dev/null 2>&1; then
  add_protected "$(disk_for_path /)"
  add_protected "$(disk_for_path /boot)"
  add_protected "$(disk_for_path /boot/efi)"
  add_protected "$(disk_for_path /etc)"      # catches systems where / is overlay but /etc is real
fi
# Active swap devices, too (overwriting them corrupts the running system).
if [ -r /proc/swaps ]; then
  while read -r dev _rest; do
    case "$dev" in /dev/*) add_protected "$(parent_disk_of_source "$dev")" ;; esac
  done < <(tail -n +2 /proc/swaps 2>/dev/null || true)
fi

for pd in $PROTECTED_DISKS; do
  if [ "$(readlink -f "$pd" 2>/dev/null || echo "$pd")" = "$TARGET" ]; then
    die "REFUSING: $TARGET backs the RUNNING system (root/boot/swap). Installing onto it would destroy this machine.
       Boot a live USB and target the OTHER disk, or pass an external disk."
  fi
done

# ── gather target facts for the confirmation prompt ───────────────────────────────────────────────────
TGT_SIZE_BYTES="$(blockdev --getsize64 "$TARGET" 2>/dev/null || echo 0)"
TGT_MODEL="$(lsblk -ndo MODEL "$TARGET" 2>/dev/null | sed 's/[[:space:]]*$//' || true)"
TGT_VENDOR="$(lsblk -ndo VENDOR "$TARGET" 2>/dev/null | sed 's/[[:space:]]*$//' || true)"
[ -n "$TGT_MODEL" ] || TGT_MODEL="(unknown model)"
human_size() {
  # bytes → human (no external `numfmt` dependency)
  local b="${1:-0}"
  awk -v b="$b" 'BEGIN{ split("B KiB MiB GiB TiB PiB",u," "); i=1; while(b>=1024 && i<6){b/=1024;i++} printf((b==int(b))?"%d %s":"%.1f %s", b, u[i]) }'
}
IMG_SIZE_BYTES="$(stat -c %s "$IMAGE" 2>/dev/null || wc -c < "$IMAGE")"

echo "===== Vita installer ====="
echo "  image    : $IMAGE"
echo "             size $(human_size "$IMG_SIZE_BYTES") ($IMG_SIZE_BYTES bytes)"
echo "  target   : $TARGET"
echo "             $TGT_VENDOR $TGT_MODEL — $(human_size "$TGT_SIZE_BYTES") ($TGT_SIZE_BYTES bytes)"
echo "  mode     : $([ "$DRY_RUN" = 1 ] && echo DRY-RUN' (no writes)' || echo WRITE) · grow=$([ "$DO_GROW" = 1 ] && echo last-partition || echo no) · grow-fs=$([ "$DO_GROW_FS" = 1 ] && echo yes || echo no) · relocate-backup-gpt=$([ "$RELOCATE_BACKUP" = 1 ] && echo yes || echo no)"
echo "  --- current partitions on target (these WILL be destroyed) ---"
lsblk -o NAME,SIZE,TYPE,FSTYPE,MOUNTPOINT,LABEL "$TARGET" 2>/dev/null | sed 's/^/  /' || true
echo

# Image must fit on the target.
if [ "$IMG_SIZE_BYTES" -gt "$TGT_SIZE_BYTES" ] 2>/dev/null && [ "$TGT_SIZE_BYTES" -gt 0 ]; then
  die "image ($(human_size "$IMG_SIZE_BYTES")) is LARGER than target ($(human_size "$TGT_SIZE_BYTES")) — it would not fit. Wrong target?"
fi

# ── confirmation ──────────────────────────────────────────────────────────────────────────────────────
if [ "$DRY_RUN" = 1 ]; then
  echo "[dry-run] no confirmation needed; printing the plan only."
elif [ "$ASSUME_YES" = 1 ]; then
  warn "--yes given: proceeding to OVERWRITE $TARGET without interactive confirmation."
else
  echo "This will ERASE ALL DATA on $TARGET ($TGT_MODEL, $(human_size "$TGT_SIZE_BYTES"))."
  echo "To proceed, type the target device path EXACTLY (or anything else to abort):"
  printf '  target> '
  read -r CONFIRM </dev/tty || die "no tty for confirmation — re-run with --yes if you are certain"
  [ "$CONFIRM" = "$TARGET" ] || die "confirmation '$CONFIRM' != '$TARGET' — aborted (nothing written)."
fi

# ── 1 · write the image ───────────────────────────────────────────────────────────────────────────────
echo "===== 1 · write image → target ====="
# Best-effort: unmount anything currently mounted from the target so the write isn't fighting the kernel.
if [ "$DRY_RUN" != 1 ]; then
  for part in $(lsblk -nlo NAME "$TARGET" 2>/dev/null | tail -n +2); do
    mp="$(lsblk -nlo MOUNTPOINT "/dev/$part" 2>/dev/null | head -1 || true)"
    if [ -n "$mp" ]; then info "unmounting /dev/$part ($mp)"; umount "/dev/$part" 2>/dev/null || warn "could not unmount /dev/$part"; fi
  done
fi
# dd: 4 MiB blocks, conv=fsync so the data is durable before we touch the GPT. status=progress for feedback.
runcmd dd if="$IMAGE" of="$TARGET" bs=4M conv=fsync oflag=direct status=progress
# Re-read the partition table the image carries.
runcmd blockdev --rereadpt "$TARGET" || warn "blockdev --rereadpt failed (kernel may already have it); continuing"
command -v partprobe >/dev/null 2>&1 && runcmd partprobe "$TARGET" || true

# ── 2 · repair the GPT backup header (it sits mid-disk because the .raw was content-sized) ─────────────
echo "===== 2 · repair GPT backup header ====="
if [ "$RELOCATE_BACKUP" = 1 ]; then
  # sgdisk -e moves the backup GPT to the very end of the (larger) target and fixes the header's
  # alternate-LBA pointers. Without this, firmware/tools see a 'GPT backup at wrong location' warning
  # and the trailing space is unusable.
  runcmd sgdisk --move-second-header "$TARGET"
else
  warn "--keep-backup-gap: leaving the backup GPT mid-disk (firmware may warn; trailing space unusable)."
fi

# ── 3 · grow the last partition to fill the disk (optional) ────────────────────────────────────────────
echo "===== 3 · grow last partition ====="
if [ "$DO_GROW" = 1 ]; then
  # The Vita layout's LAST partition is the persistent data partition (vita-data). Growing it here is the
  # simplest portable path; alternatively systemd-repart can grow it on first boot (--no-grow + a repart.d
  # GrowFileSystem=yes drop-in on the target — see docs/install.md). We grow the PARTITION; the filesystem
  # is grown only with --grow-fs (repart/first-boot usually handles the FS).
  # In dry-run nothing was written to the target, so read the partition table from the IMAGE instead (so the
  # plan still shows which partition WOULD grow); a real run reads it back from the freshly-written target.
  GROW_SRC="$TARGET"; [ "$DRY_RUN" = 1 ] && GROW_SRC="$IMAGE"
  LAST_PARTNUM="$(sgdisk -p "$GROW_SRC" 2>/dev/null | awk '/^[[:space:]]*[0-9]+/{n=$1} END{print n}')"
  if [ -z "${LAST_PARTNUM:-}" ]; then
    warn "could not determine the last partition number from sgdisk -p $GROW_SRC; skipping grow."
  else
    info "last partition = #$LAST_PARTNUM (expected: vita-data)"
    # delete+create does NOT preserve type/GUID/name, so capture them first and restore them on the new
    # (larger) partition. Parse a SINGLE `sgdisk -i` dump (its field labels are stable across sgdisk versions).
    # End at 0 = the largest possible last sector (sgdisk leaves room for the relocated backup GPT).
    P_INFO="$(sgdisk -i "$LAST_PARTNUM" "$GROW_SRC" 2>/dev/null || true)"
    P_TYPE="$(printf '%s\n' "$P_INFO" | sed -n 's/^Partition GUID code: \([0-9A-Fa-f-]*\).*/\1/p')"
    P_GUID="$(printf '%s\n' "$P_INFO" | sed -n 's/^Partition unique GUID: \([0-9A-Fa-f-]*\).*/\1/p')"
    P_START="$(printf '%s\n' "$P_INFO" | sed -n 's/^First sector: \([0-9]*\).*/\1/p')"
    P_NAME="$(printf '%s\n' "$P_INFO" | sed -n "s/^Partition name: '\(.*\)'.*/\1/p")"
    info "preserving type=${P_TYPE:-?} guid=${P_GUID:-?} name='${P_NAME:-}' start=${P_START:-?}"
    [ -n "$P_START" ] || { warn "could not read the last partition's start sector; skipping grow."; P_START=""; }
    if [ -n "$P_START" ]; then
      # Delete and recreate from the SAME start sector to the disk end (0 = max), restoring type/name/GUID.
      runcmd sgdisk \
        --delete="$LAST_PARTNUM" \
        --new="$LAST_PARTNUM:$P_START:0" \
        ${P_TYPE:+--typecode="$LAST_PARTNUM:$P_TYPE"} \
        ${P_GUID:+--partition-guid="$LAST_PARTNUM:$P_GUID"} \
        ${P_NAME:+--change-name="$LAST_PARTNUM:$P_NAME"} \
        "$TARGET"
    fi
    runcmd blockdev --rereadpt "$TARGET" || true
    command -v partprobe >/dev/null 2>&1 && runcmd partprobe "$TARGET" || true
    if [ "$DO_GROW_FS" = 1 ]; then
      # Partition device naming: /dev/sda3, but /dev/nvme0n1p3 and /dev/loop0p3 use a 'p' separator.
      case "$TGT_NAME" in
        *[0-9]) PART_DEV="${TARGET}p${LAST_PARTNUM}" ;;
        *)      PART_DEV="${TARGET}${LAST_PARTNUM}" ;;
      esac
      info "growing filesystem on $PART_DEV (ext4)"
      runcmd e2fsck -fy "$PART_DEV" || warn "e2fsck reported issues (continuing)"
      runcmd resize2fs "$PART_DEV"
    else
      info "(filesystem NOT grown; pass --grow-fs to resize2fs now, or let systemd-repart grow it on first boot)"
    fi
  fi
else
  info "--no-grow: leaving the last partition at its image size (systemd-repart can grow it on first boot)."
fi

# ── 4 · verify ────────────────────────────────────────────────────────────────────────────────────────
echo "===== 4 · verify ====="
if [ "$DRY_RUN" = 1 ]; then
  echo "    \$ sgdisk -v $TARGET   (would run; dry-run)"
  echo "    \$ sfdisk -l $TARGET   (would run; dry-run)"
  echo
  echo "RESULT: DRY-RUN OK (no writes performed; plan above is what a real run would do)"
  exit 0
fi
echo "  --- sgdisk -v (GPT integrity) ---"
sgdisk -v "$TARGET" | sed 's/^/  /' || warn "sgdisk -v reported problems"
echo "  --- sfdisk -l (final partition table) ---"
sfdisk -l "$TARGET" | sed 's/^/  /'
echo "  --- lsblk ---"
lsblk -o NAME,SIZE,TYPE,FSTYPE,PARTLABEL "$TARGET" 2>/dev/null | sed 's/^/  /' || true

# Acceptance: target must now have an ESP + at least one root partition (the Vita layout).
PARTS="$(sfdisk -l "$TARGET" 2>/dev/null | grep -cE "^$TARGET" || true)"
HAS_ESP="$(sfdisk -d "$TARGET" 2>/dev/null | grep -c 'C12A7328-F81F-11D2-BA4B-00A0C93EC93B' || true)"
if [ "${PARTS:-0}" -ge 2 ] && [ "${HAS_ESP:-0}" -ge 1 ]; then
  echo
  echo "RESULT: PASS ($PARTS partitions written incl. an EFI System Partition)"
  echo "  NEXT: move the disk to the target machine, then enroll the Vita Secure Boot key in its UEFI"
  echo "        firmware setup (manual, one-time). See docs/install.md."
  exit 0
else
  echo
  echo "RESULT: FAIL (expected ≥2 partitions incl. an ESP; got parts=$PARTS esp=$HAS_ESP) — image may be wrong"
  exit 3
fi
