#!/bin/bash
# Vita installer - write the built Vita GPT disk image onto a REAL target block device (P1-032).
#
# Vita's bootable artifact (os/x86_64/build-and-boot.mjs) is a self-contained GPT raw disk:
#   smoke/verity:  ESP (vfat) + root (ext4, dm-verity data) + root-verity (hash)
#   full:          ESP + root-a + root-b + recovery + data        (the data partition grows to fill)
# This script writes that whole .raw byte-for-byte onto a target disk (/dev/sdX), repairs the GPT
# backup header (the .raw is sized to its content, so the backup header lands mid-disk), and - for
# images that carry a growable data partition - grows the vita-data partition to fill the rest of
# the disk. The result boots on real hardware (after the one-time Secure Boot firmware enrollment
# that can only be done in the target's UEFI setup - see docs/install.md).
#
# THIS IS A DESTRUCTIVE OPERATION. It overwrites the entire target disk. Safety is the whole point:
#   - refuses to write to ANY physical disk backing the running system (root/boot/swap, through
#     dm-crypt/LVM/md stacks - the FULL parent chain is resolved, not just one hop),
#   - requires the EXACT target path AND an explicit --yes,
#   - shows the target's model/size/partitions and (without --yes) makes you type the device to confirm,
#   - --dry-run prints every action and writes NOTHING,
#   - ABORTS (fail-closed) if a target partition cannot be unmounted before the write,
#   - grows ONLY the partition labeled vita-data (never root / verity / a non-ext4 partition),
#   - verifies the written GPT afterwards (sgdisk -v is FATAL on failure; sfdisk -l for the report).
#
# USAGE:
#   tools/install-vita.sh /dev/sdX [--image PATH] [--yes] [--dry-run]
#                                  [--no-grow] [--grow-fs] [--keep-backup-gap]
#
#   /dev/sdX            target WHOLE disk (not a partition - /dev/sdb, NOT /dev/sdb1)
#   --image PATH        path to the .raw image (default: newest os/x86_64/out/*.raw)
#   --yes               actually write (skip the interactive type-the-device confirmation)
#   --dry-run           print every action, write nothing (implies a full plan walkthrough)
#   --no-grow           do NOT grow the vita-data partition (leave repart to do it on first boot)
#   --grow-fs           after growing the partition, also grow its ext4 filesystem (resize2fs)
#   --keep-backup-gap   skip GPT backup-header relocation - almost never what you want
#
# EXIT CODES: 0 ok | 1 usage/safety refusal | 2 missing tool | 3 write/verify failure
#
# House style mirrors tools/wsl-verify.sh: set -euo pipefail, defensive quoting, =====/RESULT banners,
# no destructive default, ASCII-only. Run as root (block-device writes need it). Tested via bash -n +
# loopback images (truncate+losetup) so the write/repair/grow path is exercised without real hardware.
set -euo pipefail

# -- repo discovery (so --image default + relative paths resolve from anywhere) ----------------------
SELF="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$SELF/.." && pwd)"
OUT_DIR="$REPO/os/x86_64/out"

# -- argument parsing --------------------------------------------------------------------------------
TARGET=""
IMAGE=""
ASSUME_YES=0
DRY_RUN=0
DO_GROW=1
DO_GROW_FS=0
RELOCATE_BACKUP=1

usage() {
  sed -n '2,35p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
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
    --*)                echo "ERROR: unknown option: $1" >&2; usage 1 ;;
    *)
      if [ -z "$TARGET" ]; then TARGET="$1"
      else echo "ERROR: unexpected extra argument: $1 (one target only)" >&2; usage 1; fi
      ;;
  esac
  shift
done

# -- tiny helpers ------------------------------------------------------------------------------------
die()      { echo "ERROR: $*" >&2; exit 1; }       # exit 1: usage / safety refusal
die_tool() { echo "ERROR: $*" >&2; exit 2; }       # exit 2: missing required tool
die_io()   { echo "ERROR: $*" >&2; exit 3; }       # exit 3: write / verify failure
warn()     { echo "WARN: $*" >&2; }
info()     { echo "  $*"; }
# Print a command and, unless --dry-run, run it. EVERY mutation of the target goes through this.
runcmd() {
  echo "    \$ $*"
  if [ "$DRY_RUN" = 1 ]; then return 0; fi
  "$@"
}
need() { command -v "$1" >/dev/null 2>&1 || die_tool "missing required tool: $1 (install it; exit 2)"; }

# -- preconditions -----------------------------------------------------------------------------------
[ -n "$TARGET" ] || { echo "ERROR: no target device given" >&2; usage 1; }

# Required tools. findmnt is part of the SAFETY boundary (it resolves the running system's disks so
# we can refuse them) - it MUST be present or we cannot fail-closed, so it is required, not optional.
# (resize2fs/e2fsck only needed for --grow-fs.)
for t in dd sgdisk sfdisk lsblk blockdev findmnt; do
  command -v "$t" >/dev/null 2>&1 || die_tool "missing required tool: $t - install gdisk/util-linux (exit 2)"
done
if [ "$DO_GROW_FS" = 1 ]; then need resize2fs; need e2fsck; need blkid; fi

# Must be root to write a block device (skip the hard check in dry-run so the plan is inspectable as a user).
if [ "$DRY_RUN" != 1 ] && [ "$(id -u)" != 0 ]; then
  die "must run as root to write a block device (re-run with sudo). Use --dry-run to preview as a normal user."
fi

# Resolve the default image: newest *.raw in os/x86_64/out (excludes OVMF_VARS*.fd etc).
if [ -z "$IMAGE" ]; then
  IMAGE="$(ls -t "$OUT_DIR"/*.raw 2>/dev/null | head -1 || true)"
  [ -n "$IMAGE" ] || die "no image given and none found in $OUT_DIR/*.raw - build first (node os/x86_64/build-and-boot.mjs ...) or pass --image PATH"
fi
[ -f "$IMAGE" ] || die "image not found: $IMAGE"
IMAGE="$(cd "$(dirname "$IMAGE")" && pwd)/$(basename "$IMAGE")"   # absolutize

# -- target validation: must be a WHOLE block device, not a partition --------------------------------
[ -b "$TARGET" ] || die "target is not a block device: $TARGET (pass a whole disk like /dev/sdb)"
# Canonicalize (resolve symlinks like /dev/disk/by-id/...). readlink -f is in coreutils.
TARGET="$(readlink -f "$TARGET")"
TGT_NAME="$(basename "$TARGET")"

# Reject partitions: a partition has a 'partition' devtype / a parent 'disk'. lsblk TYPE tells us.
TGT_TYPE="$(lsblk -ndo TYPE "$TARGET" 2>/dev/null | head -1 || true)"
if [ "$TGT_TYPE" != "disk" ] && [ "$TGT_TYPE" != "loop" ]; then
  die "target $TARGET is TYPE=$TGT_TYPE - pass the whole disk (e.g. /dev/sdb), not a partition or other node"
fi

# -- SAFETY: refuse to overwrite the running system's disk(s) ----------------------------------------
# A root/boot/swap device may sit on a STACK (partition -> dm-crypt -> LVM -> md -> ... -> physical
# disk). Resolving a single PKNAME hop is NOT enough: it would leave the real backing disk
# unprotected. Instead we walk the FULL dependency chain down to every physical (TYPE=disk/loop)
# ancestor.
#
# `lsblk -s` prints the inverse (parents) tree: starting at a leaf node, it lists the node and all
# of its ancestors. With `-no NAME,TYPE` we get every ancestor's name+type; we keep the terminal
# physical ones (TYPE=disk, and TYPE=loop since the installer also accepts loop devices as whole-disk
# targets). This catches dm-crypt/LVM/md/multipath stacks and plain partitions alike.
physical_disks_of_node() {
  # $1 = a /dev/... node (partition, dm-*, md*, disk, loop, ...). Prints zero or more "/dev/<disk>".
  local node="$1" name type
  [ -b "$node" ] || return 0
  # lsblk -s walks toward the parents (physical devices) from the given node.
  while read -r name type; do
    [ -n "$name" ] || continue
    if [ "$type" = "disk" ] || [ "$type" = "loop" ]; then
      # NAME may carry tree-drawing prefixes on some lsblk versions; -s -no should be clean, but
      # strip any leading non-name chars defensively.
      name="${name##*[!A-Za-z0-9_-]}"
      echo "/dev/$name"
    fi
  done < <(lsblk -s -no NAME,TYPE "$node" 2>/dev/null || true)
}
disks_for_path() {
  # $1 = a filesystem path (e.g. /, /boot) -> every physical disk backing it (zero or more lines).
  local path="$1" src
  src="$(findmnt -no SOURCE --target "$path" 2>/dev/null | head -1 || true)"
  [ -n "$src" ] || return 0
  # SOURCE may be a /dev node, or a non-block source (overlay, tmpfs) -> skip those.
  case "$src" in
    /dev/*) physical_disks_of_node "$src" ;;
    *) : ;;  # not a block-backed mount; nothing to protect here
  esac
}

PROTECTED_DISKS=""
# NB: each helper may print multiple lines; collect them all. Must end with `return 0` so the
# function never returns non-zero under `set -e`.
add_protected() {
  local d
  for d in $1; do
    [ -n "$d" ] && PROTECTED_DISKS="$PROTECTED_DISKS $d"
  done
  return 0
}
# findmnt is a REQUIRED tool (asserted above): if it were absent we would already have exited 2
# BEFORE any disk write. We therefore never fail open here - the running-system-disk set is always
# resolved before we touch the target.
add_protected "$(disks_for_path /)"
add_protected "$(disks_for_path /boot)"
add_protected "$(disks_for_path /boot/efi)"
add_protected "$(disks_for_path /etc)"      # catches systems where / is overlay but /etc is real
# Active swap devices, too (overwriting them corrupts the running system). Resolve the full stack.
if [ -r /proc/swaps ]; then
  while read -r dev _rest; do
    case "$dev" in /dev/*) add_protected "$(physical_disks_of_node "$dev")" ;; esac
  done < <(tail -n +2 /proc/swaps 2>/dev/null || true)
fi

for pd in $PROTECTED_DISKS; do
  if [ "$(readlink -f "$pd" 2>/dev/null || echo "$pd")" = "$TARGET" ]; then
    die "REFUSING: $TARGET is a physical disk backing the RUNNING system (root/boot/swap, possibly
       through an LVM/dm-crypt/md stack). Installing onto it would destroy this machine.
       Boot a live USB and target the OTHER disk, or pass an external disk."
  fi
done

# -- gather target facts for the confirmation prompt ------------------------------------------------
TGT_SIZE_BYTES="$(blockdev --getsize64 "$TARGET" 2>/dev/null || echo 0)"
TGT_MODEL="$(lsblk -ndo MODEL "$TARGET" 2>/dev/null | sed 's/[[:space:]]*$//' || true)"
TGT_VENDOR="$(lsblk -ndo VENDOR "$TARGET" 2>/dev/null | sed 's/[[:space:]]*$//' || true)"
[ -n "$TGT_MODEL" ] || TGT_MODEL="(unknown model)"
human_size() {
  # bytes -> human (no external `numfmt` dependency)
  local b="${1:-0}"
  awk -v b="$b" 'BEGIN{ split("B KiB MiB GiB TiB PiB",u," "); i=1; while(b>=1024 && i<6){b/=1024;i++} printf((b==int(b))?"%d %s":"%.1f %s", b, u[i]) }'
}
IMG_SIZE_BYTES="$(stat -c %s "$IMAGE" 2>/dev/null || wc -c < "$IMAGE")"

echo "===== Vita installer ====="
echo "  image    : $IMAGE"
echo "             size $(human_size "$IMG_SIZE_BYTES") ($IMG_SIZE_BYTES bytes)"
echo "  target   : $TARGET"
echo "             $TGT_VENDOR $TGT_MODEL - $(human_size "$TGT_SIZE_BYTES") ($TGT_SIZE_BYTES bytes)"
echo "  mode     : $([ "$DRY_RUN" = 1 ] && echo 'DRY-RUN (no writes)' || echo WRITE) | grow=$([ "$DO_GROW" = 1 ] && echo vita-data || echo no) | grow-fs=$([ "$DO_GROW_FS" = 1 ] && echo yes || echo no) | relocate-backup-gpt=$([ "$RELOCATE_BACKUP" = 1 ] && echo yes || echo no)"
echo "  --- current partitions on target (these WILL be destroyed) ---"
lsblk -o NAME,SIZE,TYPE,FSTYPE,MOUNTPOINT,LABEL "$TARGET" 2>/dev/null | sed 's/^/  /' || true
echo

# Image must fit on the target.
if [ "$IMG_SIZE_BYTES" -gt "$TGT_SIZE_BYTES" ] 2>/dev/null && [ "$TGT_SIZE_BYTES" -gt 0 ]; then
  die "image ($(human_size "$IMG_SIZE_BYTES")) is LARGER than target ($(human_size "$TGT_SIZE_BYTES")) - it would not fit. Wrong target?"
fi

# -- confirmation ------------------------------------------------------------------------------------
if [ "$DRY_RUN" = 1 ]; then
  echo "[dry-run] no confirmation needed; printing the plan only."
elif [ "$ASSUME_YES" = 1 ]; then
  warn "--yes given: proceeding to OVERWRITE $TARGET without interactive confirmation."
else
  echo "This will ERASE ALL DATA on $TARGET ($TGT_MODEL, $(human_size "$TGT_SIZE_BYTES"))."
  echo "To proceed, type the target device path EXACTLY (or anything else to abort):"
  printf '  target> '
  read -r CONFIRM </dev/tty || die "no tty for confirmation - re-run with --yes if you are certain"
  [ "$CONFIRM" = "$TARGET" ] || die "confirmation '$CONFIRM' != '$TARGET' - aborted (nothing written)."
fi

# -- 1 . write the image -----------------------------------------------------------------------------
echo "===== 1 . write image -> target ====="
# FAIL-CLOSED: unmount anything currently mounted from the target. If ANY target node cannot be
# unmounted, we ABORT rather than dd against a still-mounted/busy filesystem (which would corrupt it).
#
# We use a PLAIN `umount` (NEVER `umount -l`/lazy): a lazy unmount detaches the mountpoint from the
# namespace while processes may still hold the filesystem open and keep writing to it. The follow-up
# lsblk check would then see no mountpoint and FALSELY pass, letting dd run against a target that is
# still actively in use. So: plain umount; if it FAILS (busy/in-use), ABORT (exit 3).
#
# A whole-disk node can itself carry a mountpoint (e.g. a filesystem written directly to the disk
# with no partition table), so we iterate EVERY node lsblk reports for the target - the disk and all
# its partitions - not just the partitions.
target_mounted_nodes() {
  # Print every "name<TAB>mountpoint" pair under $TARGET that currently has a non-empty mountpoint.
  lsblk -nro NAME,MOUNTPOINT "$TARGET" 2>/dev/null | awk 'NF>=2 && $2!="" {print $1"\t"$2}'
}
if [ "$DRY_RUN" != 1 ]; then
  # 1) Unmount each mounted node with a PLAIN umount. Abort (exit 3) the moment one fails.
  while IFS="$(printf '\t')" read -r name mp; do
    [ -n "$name" ] || continue
    info "unmounting /dev/$name ($mp)"
    if ! umount "/dev/$name"; then
      die_io "could not unmount /dev/$name (mounted at $mp; target busy/in-use). ABORTING before write - refusing to dd against a mounted/busy target, and refusing a LAZY unmount that would detach it while still active. Close anything using it (lsof/fuser) and re-run."
    fi
  done < <(target_mounted_nodes)
  # 2) RE-VERIFY: after unmounting, confirm the whole disk AND every partition are GENUINELY not
  #    mounted (not merely lazy-detached). If anything still shows a mountpoint, fail closed.
  still="$(target_mounted_nodes || true)"
  if [ -n "$still" ]; then
    die_io "target still has mounted node(s) after unmount - refusing to write:
$(printf '%s\n' "$still" | sed 's/^/         /')
       ABORTING before write (fail-closed). Unmount/close them manually and re-run."
  fi
fi
# dd: 4 MiB blocks, conv=fsync so the data is durable before we touch the GPT. status=progress for feedback.
runcmd dd if="$IMAGE" of="$TARGET" bs=4M conv=fsync oflag=direct status=progress
# Re-read the partition table the image carries.
runcmd blockdev --rereadpt "$TARGET" || warn "blockdev --rereadpt failed (kernel may already have it); continuing"
command -v partprobe >/dev/null 2>&1 && runcmd partprobe "$TARGET" || true

# -- 2 . repair the GPT backup header (it sits mid-disk because the .raw was content-sized) ----------
echo "===== 2 . repair GPT backup header ====="
if [ "$RELOCATE_BACKUP" = 1 ]; then
  # sgdisk --move-second-header moves the backup GPT to the very end of the (larger) target and fixes
  # the header's alternate-LBA pointers. Without this, firmware/tools see a 'GPT backup at wrong
  # location' warning and the trailing space is unusable.
  runcmd sgdisk --move-second-header "$TARGET"
else
  warn "--keep-backup-gap: leaving the backup GPT mid-disk (firmware may warn; trailing space unusable)."
fi

# -- 3 . grow ONLY the vita-data partition to fill the disk (optional) -------------------------------
echo "===== 3 . grow vita-data partition ====="
# The growable persistent partition is vita-data (full-mode layout). On smoke/verity images the LAST
# partition is root-verity (the dm-verity HASH tree) - growing or resize2fs-ing THAT corrupts it, and
# the root partition must never be resized either. So we identify the data partition explicitly by its
# GPT PartitionLabel `vita-data` (preferred) or, failing that, an ext4 filesystem LABEL `vita-data`.
# If no vita-data partition exists, we SKIP growth entirely (never touch root/verity/any other part).
#
# Find the partition NUMBER whose PARTLABEL or LABEL == vita-data on a given device (image or target).
vita_data_partnum() {
  # $1 = device to inspect (the freshly-written target, or the image in dry-run). Prints "" if none.
  local dev="$1" num
  # 3a) Prefer the GPT partition label. sgdisk -i N reports 'Partition name'.
  num="$(sgdisk -p "$dev" 2>/dev/null | awk '/^[[:space:]]*[0-9]+/{print $1}' \
        | while read -r n; do
            nm="$(sgdisk -i "$n" "$dev" 2>/dev/null | sed -n "s/^Partition name: '\(.*\)'.*/\1/p")"
            if [ "$nm" = "vita-data" ]; then echo "$n"; break; fi
          done)"
  if [ -n "$num" ]; then echo "$num"; return 0; fi
  # 3b) Fall back to the ext4 filesystem LABEL on the actual partition device (target only; needs the
  #     partition nodes to exist). Map partition number -> device name suffix the same way as below.
  case "$dev" in
    *[0-9]) local sep="p" ;;
    *)      local sep="" ;;
  esac
  for n in $(sgdisk -p "$dev" 2>/dev/null | awk '/^[[:space:]]*[0-9]+/{print $1}'); do
    local pdev="${dev}${sep}${n}"
    [ -b "$pdev" ] || continue
    local lbl; lbl="$(lsblk -ndo LABEL "$pdev" 2>/dev/null | head -1 || true)"
    if [ "$lbl" = "vita-data" ]; then echo "$n"; return 0; fi
  done
  echo ""
}

if [ "$DO_GROW" = 1 ]; then
  # In dry-run nothing was written to the target, so inspect the IMAGE instead (so the plan shows what
  # WOULD grow); a real run reads it back from the freshly-written target. The image has no partition
  # nodes, so the ext4-LABEL fallback only applies on a real run against the target.
  GROW_SRC="$TARGET"; [ "$DRY_RUN" = 1 ] && GROW_SRC="$IMAGE"
  DATA_PARTNUM="$(vita_data_partnum "$GROW_SRC")"
  if [ -z "${DATA_PARTNUM:-}" ]; then
    warn "no partition labeled 'vita-data' found on $GROW_SRC - SKIPPING growth."
    warn "  (This is expected for smoke/verity images whose last partition is root-verity; the verity"
    warn "   HASH partition and the root partition are NEVER grown. Use a full-mode image, or rely on"
    warn "   systemd-repart first-boot growth.)"
  else
    info "vita-data partition = #$DATA_PARTNUM"
    # delete+create does NOT preserve type/GUID/name, so capture them first and restore them on the new
    # (larger) partition. Parse a SINGLE `sgdisk -i` dump (its field labels are stable across versions).
    # End at 0 = the largest possible last sector (sgdisk leaves room for the relocated backup GPT).
    P_INFO="$(sgdisk -i "$DATA_PARTNUM" "$GROW_SRC" 2>/dev/null || true)"
    P_TYPE="$(printf '%s\n' "$P_INFO" | sed -n 's/^Partition GUID code: \([0-9A-Fa-f-]*\).*/\1/p')"
    P_GUID="$(printf '%s\n' "$P_INFO" | sed -n 's/^Partition unique GUID: \([0-9A-Fa-f-]*\).*/\1/p')"
    P_START="$(printf '%s\n' "$P_INFO" | sed -n 's/^First sector: \([0-9]*\).*/\1/p')"
    P_NAME="$(printf '%s\n' "$P_INFO" | sed -n "s/^Partition name: '\(.*\)'.*/\1/p")"
    info "preserving type=${P_TYPE:-?} guid=${P_GUID:-?} name='${P_NAME:-}' start=${P_START:-?}"
    if [ -z "$P_START" ]; then
      warn "could not read the vita-data partition's start sector; skipping grow (nothing touched)."
    else
      # Delete and recreate from the SAME start sector to the disk end (0 = max), restoring type/name/GUID.
      runcmd sgdisk \
        --delete="$DATA_PARTNUM" \
        --new="$DATA_PARTNUM:$P_START:0" \
        ${P_TYPE:+--typecode="$DATA_PARTNUM:$P_TYPE"} \
        ${P_GUID:+--partition-guid="$DATA_PARTNUM:$P_GUID"} \
        ${P_NAME:+--change-name="$DATA_PARTNUM:$P_NAME"} \
        "$TARGET"
      runcmd blockdev --rereadpt "$TARGET" || true
      command -v partprobe >/dev/null 2>&1 && runcmd partprobe "$TARGET" || true
      # Let udev (re)populate the recreated partition node before we probe it. Without this, lsblk's
      # cached FSTYPE can read empty immediately after a delete/recreate (especially on hosts without
      # partprobe), which would falsely trip the ext4 guard below.
      command -v udevadm >/dev/null 2>&1 && runcmd udevadm settle || true
      if [ "$DO_GROW_FS" = 1 ]; then
        # Partition device naming: /dev/sda3, but /dev/nvme0n1p3 and /dev/loop0p3 use a 'p' separator.
        case "$TGT_NAME" in
          *[0-9]) PART_DEV="${TARGET}p${DATA_PARTNUM}" ;;
          *)      PART_DEV="${TARGET}${DATA_PARTNUM}" ;;
        esac
        # Defense in depth: only resize2fs an ext4 vita-data partition. Refuse anything else.
        # Probe the on-disk FS type directly with blkid (authoritative; reads the superblock) and fall
        # back to lsblk. Retry briefly: right after a partition recreate the node/cache can lag, and a
        # transient empty reading must NOT be mistaken for "not ext4". We only ever PROCEED on a
        # positive ext4 reading - a genuinely non-ext4 (or unreadable) partition still fails closed.
        probe_fstype() {
          # $1 = partition device. Echo the detected FSTYPE ("" if unknown), retrying a few times.
          local d="$1" fs="" i
          for i in 1 2 3 4 5; do
            fs="$(blkid -o value -s TYPE "$d" 2>/dev/null || true)"
            [ -n "$fs" ] || fs="$(lsblk -ndo FSTYPE "$d" 2>/dev/null | head -1 || true)"
            [ -n "$fs" ] && { echo "$fs"; return 0; }
            command -v udevadm >/dev/null 2>&1 && udevadm settle 2>/dev/null || true
            sleep 1
          done
          echo "$fs"
        }
        if [ "$DRY_RUN" != 1 ]; then
          PFS="$(probe_fstype "$PART_DEV")"
          PLB="$(blkid -o value -s LABEL "$PART_DEV" 2>/dev/null || true)"
          [ -n "$PLB" ] || PLB="$(lsblk -ndo LABEL "$PART_DEV" 2>/dev/null | head -1 || true)"
          if [ "$PFS" != "ext4" ]; then
            die_io "refusing to resize2fs $PART_DEV: FSTYPE='$PFS' is not ext4 (partition grown, FS left untouched)."
          fi
          info "growing filesystem on $PART_DEV (ext4, label='${PLB:-}')"
        else
          info "growing filesystem on $PART_DEV (ext4)"
        fi
        # e2fsck BEFORE resize2fs: never resize a corrupt filesystem. e2fsck's exit status is a
        # bitmask: 0 = clean; 1 = errors were CORRECTED; 2 = corrected + reboot advised; these are
        # benign (we may safely resize). But bit 2+ (rc >= 4) means errors were left UNCORRECTED, or
        # an operational/usage error / cancellation occurred - the filesystem is NOT known-good, so
        # treat it as FATAL and abort BEFORE resize2fs rather than resizing a corrupt FS.
        if [ "$DRY_RUN" = 1 ]; then
          runcmd e2fsck -fy "$PART_DEV"
        else
          echo "    \$ e2fsck -fy $PART_DEV"
          # `|| fsck_rc=$?` keeps set -e from aborting on a non-zero (expected: 1/2 mean "fixed").
          fsck_rc=0
          e2fsck -fy "$PART_DEV" || fsck_rc=$?
          if [ "$fsck_rc" -ge 4 ]; then
            die_io "e2fsck on $PART_DEV exited $fsck_rc (errors left UNCORRECTED or operational failure). ABORTING before resize2fs - refusing to resize a corrupt filesystem. Repair it manually and re-run (the partition is grown; the FS was left untouched)."
          fi
          [ "$fsck_rc" -eq 0 ] || warn "e2fsck corrected errors on $PART_DEV (rc=$fsck_rc); filesystem is now consistent - proceeding to resize2fs."
        fi
        runcmd resize2fs "$PART_DEV"
      else
        info "(filesystem NOT grown; pass --grow-fs to resize2fs now, or let systemd-repart grow it on first boot)"
      fi
    fi
  fi
else
  info "--no-grow: leaving vita-data at its image size (systemd-repart can grow it on first boot)."
fi

# -- 4 . verify --------------------------------------------------------------------------------------
echo "===== 4 . verify ====="
if [ "$DRY_RUN" = 1 ]; then
  echo "    \$ sgdisk -v $TARGET   (would run; dry-run; FATAL on failure)"
  echo "    \$ sfdisk -l $TARGET   (would run; dry-run)"
  echo
  echo "RESULT: DRY-RUN OK (no writes performed; plan above is what a real run would do)"
  exit 0
fi
# GPT integrity check is FATAL: if sgdisk -v reports problems we fail closed (do NOT print PASS).
echo "  --- sgdisk -v (GPT integrity; FATAL on failure) ---"
if ! sgdisk -v "$TARGET" 2>&1 | sed 's/^/  /'; then
  die_io "sgdisk -v reported GPT integrity problems on $TARGET - failing closed."
fi
# `sgdisk -v` prints findings but its exit status is the real signal; the pipe above masks it, so run
# it once more capturing the status explicitly to be certain.
if ! sgdisk -v "$TARGET" >/dev/null 2>&1; then
  die_io "sgdisk -v exited non-zero (GPT integrity problems) on $TARGET - failing closed."
fi
echo "  --- sfdisk -l (final partition table) ---"
sfdisk -l "$TARGET" | sed 's/^/  /'
echo "  --- lsblk ---"
lsblk -o NAME,SIZE,TYPE,FSTYPE,PARTLABEL "$TARGET" 2>/dev/null | sed 's/^/  /' || true

# Acceptance: target must now have an ESP + at least one root partition (the Vita layout) AND a clean
# GPT (verified fatally above).
PARTS="$(sfdisk -l "$TARGET" 2>/dev/null | grep -cE "^$TARGET" || true)"
HAS_ESP="$(sfdisk -d "$TARGET" 2>/dev/null | grep -c 'C12A7328-F81F-11D2-BA4B-00A0C93EC93B' || true)"
if [ "${PARTS:-0}" -ge 2 ] && [ "${HAS_ESP:-0}" -ge 1 ]; then
  echo
  echo "RESULT: PASS ($PARTS partitions written incl. an EFI System Partition; GPT integrity verified)"
  echo "  NEXT: move the disk to the target machine, then enroll the Vita Secure Boot key in its UEFI"
  echo "        firmware setup (manual, one-time). See docs/install.md."
  exit 0
else
  echo
  echo "RESULT: FAIL (expected >=2 partitions incl. an ESP; got parts=$PARTS esp=$HAS_ESP) - image may be wrong"
  exit 3
fi
