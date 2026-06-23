#!/bin/bash
# Loopback validation harness for tools/install-vita.sh (P1-032).
# Runs INSIDE WSL Ubuntu as root. Exercises the write/repair/grow/grow-fs/verify path against
# loopback images (no real hardware) plus every safety guard. Prints "ASSERT n/N pass" and exits 0
# only if ALL assertions pass.
#
# Round-3 additions:
#   (a) findmnt absent  -> installer exits 2 (no write)
#   (b) busy target whose plain umount FAILS -> exits 3 (no dd, no lazy-detach)
#   (c) e2fsck serious failure -> abort BEFORE resize2fs
# Round-4 additions (the 3 BLOCKING fixes the reviewer asked for):
#   FIX 1 (fail-closed system-disk check):
#     - GROUP L2: Btrfs-subvol root '/dev/loopN[/@]' is STRIPPED and the backing disk refused.
#     - GROUP L3: overlay/live-media '/' that can't be resolved -> FAIL-CLOSED abort (not skipped).
#     - GROUP L4: overlay '/' + a critical mount ('/etc') on the target -> refused.
#   FIX 3 (real post-P1-029 verity layout):
#     - GROUP G:  ESP+root+verity+vita-data image -> vita-data GROWS; root + hash UNTOUCHED.
#     - GROUP G2: legacy ESP+root+verity (NO vita-data) image -> growth SKIPPED; nothing grown.
set -uo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
INSTALLER="$REPO/tools/install-vita.sh"
PASS=0; FAIL=0
WORK="$(mktemp -d /tmp/vita-inst.XXXXXX)"
LOOPS=()
cleanup() {
  set +e
  for d in "${LOOPS[@]:-}"; do
    [ -n "$d" ] || continue
    for p in "$d"p* "$d"; do mountpoint -q "$p" 2>/dev/null && umount "$p" 2>/dev/null; done
    # detach any mounts that reference this loop's partitions
    losetup -d "$d" 2>/dev/null
  done
  rm -rf "$WORK"
}
trap cleanup EXIT
cd "$WORK"

ok()   { PASS=$((PASS+1)); printf '  ok   %s\n' "$*"; }
bad()  { FAIL=$((FAIL+1)); printf '  FAIL %s\n' "$*"; }
note() { printf '== %s\n' "$*"; }
# assert_eq EXPECTED ACTUAL MSG
assert_eq() { if [ "$1" = "$2" ]; then ok "$3 (=$2)"; else bad "$3 (expected '$1' got '$2')"; fi; }
# assert_contains HAYSTACK NEEDLE MSG
assert_contains() { case "$1" in *"$2"*) ok "$3";; *) bad "$3 (missing '$2')";; esac; }
# assert_not_contains HAYSTACK NEEDLE MSG
assert_not_contains() { case "$1" in *"$2"*) bad "$3 (unexpectedly found '$2')";; *) ok "$3";; esac; }

mkloop() { # mkloop SIZE -> echoes loop dev
  local sz="$1" f; f="$(mktemp "$WORK/tgt.XXXXXX.img")"; truncate -s "$sz" "$f"
  local d; d="$(losetup --find --show --partscan "$f")"; LOOPS+=("$d"); echo "$d"
}

# Build a CONTENT-SIZED "Vita image": small GPT with ESP + ext4 vita-data (mimics full-mode tail).
# Returns path to the .raw. (~40 MiB; ESP 8M, data fills the rest.)
build_full_image() {
  local img="$WORK/vita-full.raw"; truncate -s 40M "$img"
  local d; d="$(losetup --find --show --partscan "$img")"; LOOPS+=("$d")
  sgdisk -o "$d" >/dev/null
  sgdisk -n 1:2048:+8M -t 1:EF00 -c 1:vita-esp  "$d" >/dev/null
  sgdisk -n 2:0:0      -t 2:8300 -c 2:vita-data "$d" >/dev/null
  partprobe "$d" 2>/dev/null || true; sleep 0.5
  mkfs.vfat "${d}p1" >/dev/null 2>&1
  mke2fs -F -t ext4 -L vita-data "${d}p2" >/dev/null 2>&1
  losetup -d "$d"; echo "$img"
}
# Build the REAL current verity layout (post-P1-029): ESP + ext4 root + root-verity HASH + a LAST
# ext4 vita-data partition (os/x86_64/repart-verity/{00-esp,10-root,20-root-verity,40-data}.conf).
# This is what `VITA_VERITY=1` builds NOW, so the installer MUST grow vita-data (the last partition)
# while leaving root + the verity hash untouched.
build_verity_image() {
  local img="$WORK/vita-verity.raw"; truncate -s 48M "$img"
  local d; d="$(losetup --find --show --partscan "$img")"; LOOPS+=("$d")
  sgdisk -o "$d" >/dev/null
  sgdisk -n 1:2048:+8M -t 1:EF00 -c 1:vita-esp         "$d" >/dev/null
  sgdisk -n 2:0:+12M   -t 2:8300 -c 2:vita-root        "$d" >/dev/null
  sgdisk -n 3:0:+4M    -t 3:8300 -c 3:vita-root-verity "$d" >/dev/null
  sgdisk -n 4:0:0      -t 4:8300 -c 4:vita-data        "$d" >/dev/null   # LAST partition (growable)
  partprobe "$d" 2>/dev/null || true; sleep 0.5
  mkfs.vfat "${d}p1" >/dev/null 2>&1
  mke2fs -F -t ext4 -L vita-root "${d}p2" >/dev/null 2>&1
  # p3 = the dm-verity HASH partition: deliberately NOT ext4, NOT vita-data (raw bytes).
  dd if=/dev/urandom of="${d}p3" bs=1M count=1 status=none 2>/dev/null || true
  # p4 = the persistent ext4 vita-data (FileSystemLabel=vita-data in the real 40-data.conf).
  mke2fs -F -t ext4 -L vita-data "${d}p4" >/dev/null 2>&1
  losetup -d "$d"; echo "$img"
}
# Build a NO-DATA image (legacy/older shape): ESP + ext4 root + raw root-verity hash, NO vita-data.
# The installer must SKIP growth on this one (never grow root or the verity hash).
build_nodata_image() {
  local img="$WORK/vita-nodata.raw"; truncate -s 40M "$img"
  local d; d="$(losetup --find --show --partscan "$img")"; LOOPS+=("$d")
  sgdisk -o "$d" >/dev/null
  sgdisk -n 1:2048:+8M -t 1:EF00 -c 1:vita-esp         "$d" >/dev/null
  sgdisk -n 2:0:+12M   -t 2:8300 -c 2:vita-root        "$d" >/dev/null
  sgdisk -n 3:0:0      -t 3:8300 -c 3:vita-root-verity "$d" >/dev/null   # LAST = the hash, NOT data
  partprobe "$d" 2>/dev/null || true; sleep 0.5
  mkfs.vfat "${d}p1" >/dev/null 2>&1
  mke2fs -F -t ext4 -L vita-root "${d}p2" >/dev/null 2>&1
  dd if=/dev/urandom of="${d}p3" bs=1M count=1 status=none 2>/dev/null || true
  losetup -d "$d"; echo "$img"
}

run() { # run <expected_exit> -- <cmd...>  ; sets RC and OUT
  local exp="$1"; shift; [ "$1" = "--" ] && shift
  OUT="$("$@" 2>&1)"; RC=$?
  if [ "$RC" = "$exp" ]; then ok "exit $RC (expected $exp): $*"; else bad "exit $RC (expected $exp): $* :: $OUT"; fi
}

note "Build synthetic images"
FULL_IMG="$(build_full_image)";   echo "  full image:    $FULL_IMG ($(stat -c%s "$FULL_IMG") bytes)"
VERITY_IMG="$(build_verity_image)"; echo "  verity image:  $VERITY_IMG ($(stat -c%s "$VERITY_IMG") bytes)  [ESP+root+verity+vita-data]"
NODATA_IMG="$(build_nodata_image)"; echo "  no-data image: $NODATA_IMG ($(stat -c%s "$NODATA_IMG") bytes)  [ESP+root+verity, NO vita-data]"

############################################################################################
note "GROUP A - argument / usage guards (no writes)"
OUT="$(bash "$INSTALLER" 2>&1)"; RC=$?
assert_eq 1 "$RC" "A1 no target -> exit 1"
assert_contains "$OUT" "no target" "A2 no-target message"
OUT="$(bash "$INSTALLER" /dev/sdX /dev/sdY --yes 2>&1)"; RC=$?
assert_eq 1 "$RC" "A3 two targets -> exit 1"
OUT="$(bash "$INSTALLER" --bogus /dev/sdX 2>&1)"; RC=$?
assert_eq 1 "$RC" "A4 unknown option -> exit 1"
assert_contains "$OUT" "unknown option" "A5 unknown-option message"
OUT="$(bash "$INSTALLER" /dev/does-not-exist --yes --image "$FULL_IMG" 2>&1)"; RC=$?
assert_eq 1 "$RC" "A6 non-block target -> exit 1"
assert_contains "$OUT" "not a block device" "A7 non-block message"

############################################################################################
note "GROUP B - missing required tool -> exit 2 (incl. NEW case a: findmnt absent)"
# Shim a PATH that hides ONE tool at a time, keeping the rest. We point PATH at a dir of symlinks.
SHIM="$WORK/shim"; mkdir -p "$SHIM"
for t in bash dd sgdisk sfdisk lsblk blockdev findmnt readlink id awk sed stat wc head tail grep cat env tr cut sort mountpoint losetup umount mke2fs e2fsck resize2fs mkfs.vfat truncate sleep dirname basename ls blkid udevadm touch printf chmod; do
  src="$(command -v "$t" 2>/dev/null)"; [ -n "$src" ] && ln -sf "$src" "$SHIM/$t"
done
# Sanity: with the full shim, a dry-run still works (exit 0) - proves the shim isn't the cause of later failures.
OUT="$(PATH="$SHIM" bash "$INSTALLER" "$(losetup -f)" --dry-run --image "$FULL_IMG" 2>&1)"; RC=$?
# (target may not be a real block dev here; we only care the tool-presence gate passed - i.e. not exit 2)
assert_not_contains "$OUT" "missing required tool" "B0 full shim: no missing-tool error"
# NEW case (a): remove findmnt from PATH -> MUST exit 2 BEFORE any write.
rm -f "$SHIM/findmnt"
TGT_B="$(mkloop 80M)"
OUT="$(PATH="$SHIM" bash "$INSTALLER" "$TGT_B" --yes --image "$FULL_IMG" 2>&1)"; RC=$?
assert_eq 2 "$RC" "B1 [NEW a] findmnt absent -> exit 2"
assert_contains "$OUT" "missing required tool: findmnt" "B2 [NEW a] names findmnt"
# Prove NO WRITE happened: the target loop image must still be all-zero (no GPT signature).
FIRST64="$(dd if="$TGT_B" bs=1 count=64 skip=512 status=none 2>/dev/null | tr -d '\0' | wc -c)"
assert_eq 0 "$FIRST64" "B3 [NEW a] no write occurred (GPT area still zero)"
# Also: hide sgdisk -> exit 2
ln -sf "$(command -v findmnt)" "$SHIM/findmnt"; rm -f "$SHIM/sgdisk"
OUT="$(PATH="$SHIM" bash "$INSTALLER" "$TGT_B" --yes --image "$FULL_IMG" 2>&1)"; RC=$?
assert_eq 2 "$RC" "B4 sgdisk absent -> exit 2"

############################################################################################
note "GROUP C - dry-run writes NOTHING"
TGT_C="$(mkloop 80M)"
BEFORE="$(md5sum "$(losetup -nO BACK-FILE "$TGT_C")" | cut -d' ' -f1)"
OUT="$(bash "$INSTALLER" "$TGT_C" --dry-run --grow-fs --image "$FULL_IMG" 2>&1)"; RC=$?
assert_eq 0 "$RC" "C1 dry-run -> exit 0"
assert_contains "$OUT" "DRY-RUN OK" "C2 dry-run RESULT banner"
assert_contains "$OUT" "dd if=" "C3 dry-run prints the dd plan"
AFTER="$(md5sum "$(losetup -nO BACK-FILE "$TGT_C")" | cut -d' ' -f1)"
assert_eq "$BEFORE" "$AFTER" "C4 dry-run did NOT modify the target"

############################################################################################
note "GROUP D - image larger than target -> refuse (exit 1)"
TGT_D="$(mkloop 16M)"   # smaller than the 40M image
OUT="$(bash "$INSTALLER" "$TGT_D" --yes --image "$FULL_IMG" 2>&1)"; RC=$?
assert_eq 1 "$RC" "D1 image>target -> exit 1"
assert_contains "$OUT" "LARGER than target" "D2 too-big message"

############################################################################################
note "GROUP E - confirmation guard (no --yes -> needs a tty/typed device)"
TGT_E="$(mkloop 80M)"
# Run detached from any controlling terminal (setsid) so the installer's `read </dev/tty` cannot
# block waiting for input - it must fail fast and `die` (exit 1) without writing. timeout is a
# belt-and-suspenders guard so a misbehaving build can't hang the harness.
OUT="$(setsid timeout 10 bash "$INSTALLER" "$TGT_E" --image "$FULL_IMG" </dev/null 2>&1)"; RC=$?
assert_eq 1 "$RC" "E1 no-confirm / no-tty -> exit 1 (no write)"
# Prove no write happened.
ZE="$(dd if="$TGT_E" bs=1 count=64 skip=512 status=none 2>/dev/null | tr -d '\0' | wc -c)"
assert_eq 0 "$ZE" "E2 no-confirm wrote nothing"

############################################################################################
note "GROUP F - REAL write+repair+grow+grow-fs on a full-mode loop target"
TGT_F="$(mkloop 200M)"
OUT="$(bash "$INSTALLER" "$TGT_F" --yes --grow-fs --image "$FULL_IMG" 2>&1)"; RC=$?
assert_eq 0 "$RC" "F1 full write+grow-fs -> exit 0"
assert_contains "$OUT" "RESULT: PASS" "F2 RESULT: PASS"
partprobe "$TGT_F" 2>/dev/null || true; sleep 0.5
# ESP present?
ESP="$(sfdisk -d "$TGT_F" 2>/dev/null | grep -c 'C12A7328-F81F-11D2-BA4B-00A0C93EC93B')"
assert_eq 1 "$ESP" "F3 ESP present after write"
# vita-data grew to (nearly) fill 200M target: its end sector should be well past the 40M image.
DATA_END="$(sgdisk -i 2 "$TGT_F" 2>/dev/null | sed -n 's/^Last sector: \([0-9]*\).*/\1/p')"
# 40M image data-part ended < 81920 sectors; 200M disk ~ 409600 sectors. Expect > 300000.
if [ "${DATA_END:-0}" -gt 300000 ]; then ok "F4 vita-data grew (last sector $DATA_END > 300000)"; else bad "F4 vita-data did NOT grow (last sector ${DATA_END:-?})"; fi
# Name/label preserved
NM="$(sgdisk -i 2 "$TGT_F" 2>/dev/null | sed -n "s/^Partition name: '\(.*\)'.*/\1/p")"
assert_eq "vita-data" "$NM" "F5 vita-data partition name preserved after grow"
# Filesystem resized (resize2fs ran): blocks of the ext4 should reflect the bigger partition.
FSB="$(dumpe2fs -h "${TGT_F}p2" 2>/dev/null | sed -n 's/^Block count:[[:space:]]*\([0-9]*\).*/\1/p')"
if [ "${FSB:-0}" -gt 20000 ]; then ok "F6 ext4 filesystem resized (block count $FSB)"; else bad "F6 ext4 NOT resized (block count ${FSB:-?})"; fi
# GPT integrity clean
if sgdisk -v "$TGT_F" >/dev/null 2>&1; then ok "F7 sgdisk -v clean after install"; else bad "F7 sgdisk -v reported problems"; fi

############################################################################################
note "GROUP G - REAL verity layout (ESP+root+verity+vita-data): vita-data GROWS, root+hash untouched"
# This is the post-P1-029 layout. The installer MUST grow the LAST partition (vita-data, #4) and
# leave the root (#2) and verity HASH (#3) partitions byte/extent identical.
TGT_G="$(mkloop 200M)"
# Capture the image's pre-install last-sectors for root(#2) and hash(#3) to prove they don't change.
IMGLD="$(losetup --find --show --partscan "$VERITY_IMG")"; LOOPS+=("$IMGLD"); partprobe "$IMGLD" 2>/dev/null || true; sleep 0.3
IMG_P2_LAST="$(sgdisk -i 2 "$IMGLD" 2>/dev/null | sed -n 's/^Last sector: \([0-9]*\).*/\1/p')"
IMG_P3_LAST="$(sgdisk -i 3 "$IMGLD" 2>/dev/null | sed -n 's/^Last sector: \([0-9]*\).*/\1/p')"
losetup -d "$IMGLD" 2>/dev/null || true
OUT="$(bash "$INSTALLER" "$TGT_G" --yes --grow-fs --image "$VERITY_IMG" 2>&1)"; RC=$?
assert_eq 0 "$RC" "G1 verity+data write+grow -> exit 0"
assert_contains "$OUT" "vita-data partition = #4" "G2 installer identified vita-data as partition #4"
assert_not_contains "$OUT" "no partition labeled 'vita-data'" "G3 growth NOT skipped (vita-data present)"
assert_contains "$OUT" "RESULT: PASS" "G4 RESULT: PASS"
partprobe "$TGT_G" 2>/dev/null || true; sleep 0.5
# vita-data (#4) GREW to (nearly) fill 200M: end sector should be well past the ~48M image.
DATA_END_G="$(sgdisk -i 4 "$TGT_G" 2>/dev/null | sed -n 's/^Last sector: \([0-9]*\).*/\1/p')"
if [ "${DATA_END_G:-0}" -gt 300000 ]; then ok "G5 vita-data grew on verity image (last sector $DATA_END_G > 300000)"; else bad "G5 vita-data did NOT grow on verity image (last sector ${DATA_END_G:-?})"; fi
# vita-data name preserved
NM_G="$(sgdisk -i 4 "$TGT_G" 2>/dev/null | sed -n "s/^Partition name: '\(.*\)'.*/\1/p")"
assert_eq "vita-data" "$NM_G" "G6 vita-data name preserved after grow"
# root (#2) and verity HASH (#3) must be UNTOUCHED (same last sector as the image).
TGT_P2_LAST="$(sgdisk -i 2 "$TGT_G" 2>/dev/null | sed -n 's/^Last sector: \([0-9]*\).*/\1/p')"
TGT_P3_LAST="$(sgdisk -i 3 "$TGT_G" 2>/dev/null | sed -n 's/^Last sector: \([0-9]*\).*/\1/p')"
assert_eq "$IMG_P2_LAST" "$TGT_P2_LAST" "G7 root partition NOT grown (same last sector)"
assert_eq "$IMG_P3_LAST" "$TGT_P3_LAST" "G8 verity HASH partition NOT grown (same last sector)"
# ext4 filesystem on vita-data was resized
FSB_G="$(dumpe2fs -h "${TGT_G}p4" 2>/dev/null | sed -n 's/^Block count:[[:space:]]*\([0-9]*\).*/\1/p')"
if [ "${FSB_G:-0}" -gt 20000 ]; then ok "G9 vita-data ext4 resized (block count $FSB_G)"; else bad "G9 vita-data ext4 NOT resized (block count ${FSB_G:-?})"; fi

############################################################################################
note "GROUP G2 - NO-DATA image (ESP+root+verity, no vita-data): growth SKIPPED, nothing grown"
TGT_GN="$(mkloop 200M)"
IMGLD2="$(losetup --find --show --partscan "$NODATA_IMG")"; LOOPS+=("$IMGLD2"); partprobe "$IMGLD2" 2>/dev/null || true; sleep 0.3
IMG_ND_P3_LAST="$(sgdisk -i 3 "$IMGLD2" 2>/dev/null | sed -n 's/^Last sector: \([0-9]*\).*/\1/p')"
losetup -d "$IMGLD2" 2>/dev/null || true
OUT="$(bash "$INSTALLER" "$TGT_GN" --yes --grow-fs --image "$NODATA_IMG" 2>&1)"; RC=$?
assert_eq 0 "$RC" "GN1 no-data write -> exit 0"
assert_contains "$OUT" "no partition labeled 'vita-data'" "GN2 growth SKIPPED (no vita-data partition)"
assert_contains "$OUT" "RESULT: PASS" "GN3 RESULT: PASS"
partprobe "$TGT_GN" 2>/dev/null || true; sleep 0.5
# The LAST partition (#3, the hash) must NOT have grown.
TGT_ND_P3_LAST="$(sgdisk -i 3 "$TGT_GN" 2>/dev/null | sed -n 's/^Last sector: \([0-9]*\).*/\1/p')"
assert_eq "$IMG_ND_P3_LAST" "$TGT_ND_P3_LAST" "GN4 last (hash) partition NOT grown when no vita-data"

############################################################################################
note "GROUP H - --no-grow leaves data at image size"
TGT_H="$(mkloop 200M)"
OUT="$(bash "$INSTALLER" "$TGT_H" --yes --no-grow --image "$FULL_IMG" 2>&1)"; RC=$?
assert_eq 0 "$RC" "H1 --no-grow -> exit 0"
assert_contains "$OUT" "--no-grow" "H2 --no-grow honored (message)"
partprobe "$TGT_H" 2>/dev/null || true; sleep 0.5
DATA_END_H="$(sgdisk -i 2 "$TGT_H" 2>/dev/null | sed -n 's/^Last sector: \([0-9]*\).*/\1/p')"
if [ "${DATA_END_H:-99999999}" -lt 90000 ]; then ok "H3 vita-data left small (last sector $DATA_END_H)"; else bad "H3 vita-data unexpectedly grew under --no-grow ($DATA_END_H)"; fi

############################################################################################
note "GROUP I - busy target: plain umount fails -> exit 3 (NEW case b)"
# Build a target that already carries a mounted, BUSY filesystem, then make umount fail.
TGT_I="$(mkloop 200M)"
sgdisk -o "$TGT_I" >/dev/null
sgdisk -n 1:2048:+50M -t 1:8300 -c 1:busy "$TGT_I" >/dev/null
partprobe "$TGT_I" 2>/dev/null || true; sleep 0.5
mke2fs -F -t ext4 "${TGT_I}p1" >/dev/null 2>&1
MNT="$WORK/busy.mnt"; mkdir -p "$MNT"
mount "${TGT_I}p1" "$MNT"
# Hold the filesystem busy: a background process with CWD inside it (makes plain umount EBUSY).
# Detach its fds so it never keeps our stdout pipe open (otherwise the harness output won't flush).
( cd "$MNT" && exec sleep 30 ) >/dev/null 2>&1 </dev/null &
BUSY_PID=$!
sleep 0.5
# Shim umount so a LAZY (-l) unmount is IMPOSSIBLE: our shim refuses any '-l' and forwards plain
# umount to the real binary (which will FAIL EBUSY because of the held CWD). This proves the
# installer (a) does not fall back to lazy and (b) fails closed when plain umount fails.
SHIM2="$WORK/shim2"; mkdir -p "$SHIM2"
for t in bash dd sgdisk sfdisk lsblk blockdev findmnt readlink id awk sed stat wc head tail grep cat env tr cut sort mountpoint losetup mke2fs e2fsck resize2fs mkfs.vfat truncate sleep dirname basename ls dumpe2fs partprobe md5sum blkid udevadm touch printf chmod; do
  src="$(command -v "$t" 2>/dev/null)"; [ -n "$src" ] && ln -sf "$src" "$SHIM2/$t"
done
cat > "$SHIM2/umount" <<'UM'
#!/bin/bash
for a in "$@"; do case "$a" in -l|--lazy) echo "LAZY-UNMOUNT-FORBIDDEN-BY-TEST" >&2; exit 99;; esac; done
exec /usr/bin/umount "$@"
UM
chmod +x "$SHIM2/umount"
REAL_UMOUNT="$(command -v umount)"; sed -i "s#/usr/bin/umount#$REAL_UMOUNT#" "$SHIM2/umount"
OUT="$(PATH="$SHIM2" bash "$INSTALLER" "$TGT_I" --yes --image "$FULL_IMG" 2>&1)"; RC=$?
assert_eq 3 "$RC" "I1 [NEW b] busy target, plain umount fails -> exit 3"
assert_contains "$OUT" "could not unmount" "I2 [NEW b] reports unmount failure"
assert_not_contains "$OUT" "LAZY-UNMOUNT-FORBIDDEN" "I3 [NEW b] installer never attempted a LAZY unmount"
# Prove the target was NOT dd'd over: the 'busy' partition's ext4 must still be intact & mountable.
# (The image's GPT would have replaced ours if dd had run.)
NM_I="$(sgdisk -i 1 "$TGT_I" 2>/dev/null | sed -n "s/^Partition name: '\(.*\)'.*/\1/p")"
assert_eq "busy" "$NM_I" "I4 [NEW b] target untouched (original 'busy' partition still present, no dd)"
# Cleanup the busy holder
kill "$BUSY_PID" 2>/dev/null; wait "$BUSY_PID" 2>/dev/null
umount "$MNT" 2>/dev/null || true

############################################################################################
note "GROUP J - busy target whose umount SUCCEEDS: installer unmounts then writes (exit 0)"
TGT_J="$(mkloop 200M)"
sgdisk -o "$TGT_J" >/dev/null
sgdisk -n 1:2048:+50M -t 1:8300 -c 1:old "$TGT_J" >/dev/null
partprobe "$TGT_J" 2>/dev/null || true; sleep 0.5
mke2fs -F -t ext4 "${TGT_J}p1" >/dev/null 2>&1
MNTJ="$WORK/jmnt"; mkdir -p "$MNTJ"; mount "${TGT_J}p1" "$MNTJ"
OUT="$(bash "$INSTALLER" "$TGT_J" --yes --image "$FULL_IMG" 2>&1)"; RC=$?
assert_eq 0 "$RC" "J1 mounted-but-freeable target -> unmounts, writes, exit 0"
assert_contains "$OUT" "unmounting" "J2 installer unmounted the busy node"
assert_contains "$OUT" "RESULT: PASS" "J3 RESULT: PASS after unmount+write"
umount "$MNTJ" 2>/dev/null || true

############################################################################################
note "GROUP K - e2fsck serious failure -> abort BEFORE resize2fs (NEW case c)"
TGT_K="$(mkloop 200M)"
OUT="$(bash "$INSTALLER" "$TGT_K" --yes --no-grow --image "$FULL_IMG" 2>&1)"; RC=$?
assert_eq 0 "$RC" "K0 setup: install (no-grow) ok"
partprobe "$TGT_K" 2>/dev/null || true; sleep 0.5
# Shim e2fsck to return a SERIOUS failure code (4 = errors left uncorrected). Forward everything
# else to the real tools. resize2fs is shimmed to a tripwire that records if it was EVER called.
SHIM3="$WORK/shim3"; mkdir -p "$SHIM3"
for t in bash dd sgdisk sfdisk lsblk blockdev findmnt readlink id awk sed stat wc head tail grep cat env tr cut sort mountpoint losetup umount mke2fs mkfs.vfat truncate sleep dirname basename ls dumpe2fs partprobe md5sum blkid udevadm touch printf chmod; do
  src="$(command -v "$t" 2>/dev/null)"; [ -n "$src" ] && ln -sf "$src" "$SHIM3/$t"
done
cat > "$SHIM3/e2fsck" <<'EF'
#!/bin/bash
echo "e2fsck(SHIM): simulating SERIOUS failure (errors left uncorrected)" >&2
exit 4
EF
chmod +x "$SHIM3/e2fsck"
TRIP="$WORK/resize2fs.called"; rm -f "$TRIP"
cat > "$SHIM3/resize2fs" <<EF
#!/bin/bash
touch "$TRIP"
echo "resize2fs(SHIM): SHOULD NOT HAVE BEEN CALLED" >&2
exit 0
EF
chmod +x "$SHIM3/resize2fs"
# Run with --grow-fs so e2fsck+resize2fs are on the path. vita-data exists, so it reaches the fsck.
OUT="$(PATH="$SHIM3" bash "$INSTALLER" "$TGT_K" --yes --grow-fs --image "$FULL_IMG" 2>&1)"; RC=$?
assert_eq 3 "$RC" "K1 [NEW c] e2fsck rc>=4 -> exit 3 (abort)"
assert_contains "$OUT" "ABORTING before resize2fs" "K2 [NEW c] aborts before resize2fs"
if [ -e "$TRIP" ]; then bad "K3 [NEW c] resize2fs WAS called on a corrupt FS"; else ok "K3 [NEW c] resize2fs was NOT called (aborted first)"; fi
# Control: e2fsck rc=1 (errors CORRECTED) should be benign -> proceed to resize2fs (exit 0).
cat > "$SHIM3/e2fsck" <<'EF'
#!/bin/bash
echo "e2fsck(SHIM): corrected errors (rc=1)" >&2
exit 1
EF
chmod +x "$SHIM3/e2fsck"
cat > "$SHIM3/resize2fs" <<EF
#!/bin/bash
touch "$TRIP"
exit 0
EF
chmod +x "$SHIM3/resize2fs"
rm -f "$TRIP"
TGT_K2="$(mkloop 200M)"
OUT="$(PATH="$SHIM3" bash "$INSTALLER" "$TGT_K2" --yes --grow-fs --image "$FULL_IMG" 2>&1)"; RC=$?
assert_eq 0 "$RC" "K4 [NEW c] e2fsck rc=1 (corrected) is benign -> exit 0"
if [ -e "$TRIP" ]; then ok "K5 [NEW c] resize2fs WAS called after a benign fsck"; else bad "K5 [NEW c] resize2fs not called after benign fsck"; fi

############################################################################################
# Helper: build a shim dir with all base tools symlinked, ready for a custom findmnt/lsblk override.
make_shim_dir() {
  local sd; sd="$(mktemp -d "$WORK/shim.XXXXXX")"
  for t in bash dd sgdisk sfdisk lsblk blockdev readlink id awk sed stat wc head tail grep cat env tr cut sort mountpoint losetup umount mke2fs e2fsck resize2fs mkfs.vfat truncate sleep dirname basename ls dumpe2fs partprobe md5sum blkid udevadm touch printf chmod realpath; do
    src="$(command -v "$t" 2>/dev/null)"; [ -n "$src" ] && ln -sf "$src" "$sd/$t"
  done
  echo "$sd"
}
# zero64 DEV -> echoes count of non-zero bytes in the GPT header area (proves no write when 0).
zero64() { dd if="$1" bs=1 count=64 skip=512 status=none 2>/dev/null | tr -d '\0' | wc -c; }

############################################################################################
note "GROUP L - system-disk refusal: plain /dev source (regression guard)"
# Fake findmnt so '/' is backed by our loop target. Honor BOTH `-o SOURCE` and `-o TARGET` queries.
TGT_L="$(mkloop 80M)"
SHIM4="$(make_shim_dir)"
cat > "$SHIM4/findmnt" <<EF
#!/bin/bash
# Parse: findmnt -no SOURCE|TARGET --target <path>. For path '/', SOURCE = the loop target.
col=SOURCE; path=""
while [ \$# -gt 0 ]; do
  case "\$1" in
    -no) col="\$2"; shift ;;
    -no*) col="\${1#-no}" ;;
    --target) path="\$2"; shift ;;
    -o) col="\$2"; shift ;;
  esac; shift
done
case "\$path" in
  /) [ "\$col" = SOURCE ] && echo "$TGT_L"; [ "\$col" = TARGET ] && echo "/"; exit 0 ;;
esac
exit 1   # any other path: not a mountpoint
EF
chmod +x "$SHIM4/findmnt"
OUT="$(PATH="$SHIM4" bash "$INSTALLER" "$TGT_L" --yes --image "$FULL_IMG" 2>&1)"; RC=$?
assert_eq 1 "$RC" "L1 system-disk (/) target -> exit 1 refusal"
assert_contains "$OUT" "RUNNING system" "L2 refusal message"
assert_eq 0 "$(zero64 "$TGT_L")" "L3 system-disk refusal wrote nothing"

############################################################################################
note "GROUP L2 [NEW] - Btrfs subvolume root '/dev/loopN[/@]' is STRIPPED + refused (FIX 1)"
# findmnt for a Btrfs subvol returns SOURCE like '/dev/loopN[/@]'. The installer must strip the
# trailing '[...]' and STILL resolve+refuse the backing disk (target). Pre-strip it would fail `[ -b ]`
# and protect nothing -> fail OPEN. This proves it now fails CLOSED.
TGT_L2="$(mkloop 80M)"
SHIM5="$(make_shim_dir)"
cat > "$SHIM5/findmnt" <<EF
#!/bin/bash
col=SOURCE; path=""
while [ \$# -gt 0 ]; do
  case "\$1" in
    -no) col="\$2"; shift ;; -no*) col="\${1#-no}" ;;
    --target) path="\$2"; shift ;; -o) col="\$2"; shift ;;
  esac; shift
done
case "\$path" in
  /) [ "\$col" = SOURCE ] && echo "${TGT_L2}[/@]"; [ "\$col" = TARGET ] && echo "/"; exit 0 ;;
esac
exit 1
EF
chmod +x "$SHIM5/findmnt"
OUT="$(PATH="$SHIM5" bash "$INSTALLER" "$TGT_L2" --yes --image "$FULL_IMG" 2>&1)"; RC=$?
assert_eq 1 "$RC" "L2a [NEW] btrfs-subvol '[/@]' source -> exit 1 refusal (stripped + resolved)"
assert_contains "$OUT" "RUNNING system" "L2b [NEW] refusal message"
assert_eq 0 "$(zero64 "$TGT_L2")" "L2c [NEW] btrfs-subvol refusal wrote nothing"

############################################################################################
note "GROUP L3 [NEW] - overlay/live-media root that can't be resolved -> FAIL-CLOSED abort (FIX 1)"
# Live media often mount '/' as an 'overlay'. The old code skipped non-/dev sources -> NO protected
# disk -> could wipe the running disk. Now: an overlay '/' whose lower/upper layers can't be resolved
# to a physical disk must ABORT (fail-closed), NOT silently skip. We provide an overlay source for '/'
# but no resolvable mountinfo lowerdir (so resolution yields nothing) -> must refuse to proceed.
TGT_L3="$(mkloop 80M)"
SHIM6="$(make_shim_dir)"
cat > "$SHIM6/findmnt" <<EF
#!/bin/bash
col=SOURCE; path=""
while [ \$# -gt 0 ]; do
  case "\$1" in
    -no) col="\$2"; shift ;; -no*) col="\${1#-no}" ;;
    --target) path="\$2"; shift ;; -o) col="\$2"; shift ;;
  esac; shift
done
case "\$path" in
  /) [ "\$col" = SOURCE ] && echo "overlay"; [ "\$col" = TARGET ] && echo "/"; exit 0 ;;
esac
exit 1   # /boot,/boot/efi,/etc not separate mounts; swap none
EF
chmod +x "$SHIM6/findmnt"
OUT="$(PATH="$SHIM6" bash "$INSTALLER" "$TGT_L3" --yes --image "$FULL_IMG" 2>&1)"; RC=$?
assert_eq 1 "$RC" "L3a [NEW] overlay '/' unresolvable -> exit 1 (fail-closed abort)"
assert_contains "$OUT" "could not resolve the physical disk" "L3b [NEW] fail-closed message"
assert_eq 0 "$(zero64 "$TGT_L3")" "L3c [NEW] fail-closed wrote nothing"

############################################################################################
note "GROUP L4 [NEW] - critical mount '/etc' on the target while '/' is a (bare) overlay -> refused"
# Here '/' is a bare overlay (the SOURCE alone is opaque) but the resolvable critical mount '/etc'
# lives on the target disk. The installer must REFUSE the target. Because the bare overlay '/' is
# itself unresolvable, the FAIL-CLOSED guard ('could not resolve...') may fire before the explicit
# 'RUNNING system' refusal - BOTH are valid hard refusals (exit 1, no write) that protect the system,
# so we accept either message. The load-bearing guarantees are: exit 1 AND nothing written.
TGT_L4="$(mkloop 80M)"
SHIM7="$(make_shim_dir)"
cat > "$SHIM7/findmnt" <<EF
#!/bin/bash
col=SOURCE; path=""
while [ \$# -gt 0 ]; do
  case "\$1" in
    -no) col="\$2"; shift ;; -no*) col="\${1#-no}" ;;
    --target) path="\$2"; shift ;; -o) col="\$2"; shift ;;
  esac; shift
done
case "\$path" in
  /)    [ "\$col" = SOURCE ] && echo "overlay"; [ "\$col" = TARGET ] && echo "/"; exit 0 ;;
  /etc) [ "\$col" = SOURCE ] && echo "$TGT_L4"; [ "\$col" = TARGET ] && echo "/etc"; exit 0 ;;
esac
exit 1
EF
chmod +x "$SHIM7/findmnt"
OUT="$(PATH="$SHIM7" bash "$INSTALLER" "$TGT_L4" --yes --image "$FULL_IMG" 2>&1)"; RC=$?
assert_eq 1 "$RC" "L4a [NEW] overlay '/' + '/etc' on target -> exit 1 refusal"
# Accept either hard-refusal message (system-disk OR fail-closed-unresolvable); both protect the system.
case "$OUT" in
  *"RUNNING system"*|*"could not resolve the physical disk"*) ok "L4b [NEW] hard refusal (system-disk or fail-closed)";;
  *) bad "L4b [NEW] expected a hard refusal message, got: $OUT";;
esac
assert_eq 0 "$(zero64 "$TGT_L4")" "L4c [NEW] refusal wrote nothing"

############################################################################################
note "GROUP L5 [NEW] - non-root critical mount ('/etc') on target, '/' elsewhere -> RUNNING-system refusal"
# Clean test of the 'a critical mount resolves to the target' path WITHOUT a fail-closed mask: '/'
# resolves to a DIFFERENT (benign) loop disk, but '/etc' resolves to the target. The installer must
# refuse with the explicit 'RUNNING system' message (RESOLVE_FAILED is empty here).
TGT_L5="$(mkloop 80M)"
OTHER_L5="$(mkloop 32M)"   # a benign disk that backs '/' (NOT the target)
SHIM8="$(make_shim_dir)"
cat > "$SHIM8/findmnt" <<EF
#!/bin/bash
col=SOURCE; path=""
while [ \$# -gt 0 ]; do
  case "\$1" in
    -no) col="\$2"; shift ;; -no*) col="\${1#-no}" ;;
    --target) path="\$2"; shift ;; -o) col="\$2"; shift ;;
  esac; shift
done
case "\$path" in
  /)    [ "\$col" = SOURCE ] && echo "$OTHER_L5"; [ "\$col" = TARGET ] && echo "/"; exit 0 ;;
  /etc) [ "\$col" = SOURCE ] && echo "$TGT_L5";  [ "\$col" = TARGET ] && echo "/etc"; exit 0 ;;
esac
exit 1
EF
chmod +x "$SHIM8/findmnt"
OUT="$(PATH="$SHIM8" bash "$INSTALLER" "$TGT_L5" --yes --image "$FULL_IMG" 2>&1)"; RC=$?
assert_eq 1 "$RC" "L5a [NEW] '/etc' on target -> exit 1 refusal"
assert_contains "$OUT" "RUNNING system" "L5b [NEW] explicit RUNNING-system refusal (no fail-closed mask)"
assert_eq 0 "$(zero64 "$TGT_L5")" "L5c [NEW] refusal wrote nothing"

############################################################################################
printf '\n===== ASSERT %d pass / %d fail (total %d) =====\n' "$PASS" "$FAIL" "$((PASS+FAIL))"
[ "$FAIL" = 0 ] && { echo "HARNESS: ALL PASS"; exit 0; } || { echo "HARNESS: FAILURES"; exit 1; }
