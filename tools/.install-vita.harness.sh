#!/bin/bash
# Loopback validation harness for tools/install-vita.sh (P1-032).
# Runs INSIDE WSL Ubuntu as root. Exercises the write/repair/grow/grow-fs/verify path against
# loopback images (no real hardware) plus every safety guard. Prints "ASSERT n/N pass" and exits 0
# only if ALL assertions pass.
#
# Round-3 additions (the 3 new cases the reviewer asked for):
#   (a) findmnt absent  -> installer exits 2 (no write)
#   (b) busy target whose plain umount FAILS -> exits 3 (no dd, no lazy-detach)
#   (c) e2fsck serious failure -> abort BEFORE resize2fs
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
# Build a verity-style image: ESP + ext4 root + a LAST partition that is NOT vita-data (the hash).
build_verity_image() {
  local img="$WORK/vita-verity.raw"; truncate -s 40M "$img"
  local d; d="$(losetup --find --show --partscan "$img")"; LOOPS+=("$d")
  sgdisk -o "$d" >/dev/null
  sgdisk -n 1:2048:+8M -t 1:EF00 -c 1:vita-esp        "$d" >/dev/null
  sgdisk -n 2:0:+12M   -t 2:8300 -c 2:vita-root       "$d" >/dev/null
  sgdisk -n 3:0:0      -t 3:8300 -c 3:vita-root-verity "$d" >/dev/null
  partprobe "$d" 2>/dev/null || true; sleep 0.5
  mkfs.vfat "${d}p1" >/dev/null 2>&1
  mke2fs -F -t ext4 -L vita-root "${d}p2" >/dev/null 2>&1
  # leave p3 as raw (the "hash" partition) - deliberately NOT ext4, NOT vita-data
  dd if=/dev/urandom of="${d}p3" bs=1M count=1 status=none 2>/dev/null || true
  losetup -d "$d"; echo "$img"
}

run() { # run <expected_exit> -- <cmd...>  ; sets RC and OUT
  local exp="$1"; shift; [ "$1" = "--" ] && shift
  OUT="$("$@" 2>&1)"; RC=$?
  if [ "$RC" = "$exp" ]; then ok "exit $RC (expected $exp): $*"; else bad "exit $RC (expected $exp): $* :: $OUT"; fi
}

note "Build synthetic images"
FULL_IMG="$(build_full_image)";  echo "  full image:   $FULL_IMG ($(stat -c%s "$FULL_IMG") bytes)"
VERITY_IMG="$(build_verity_image)"; echo "  verity image: $VERITY_IMG ($(stat -c%s "$VERITY_IMG") bytes)"

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
note "GROUP G - verity image: growth SKIPPED, hash partition untouched"
TGT_G="$(mkloop 200M)"
# capture the verity image's last partition (hash) bytes to prove it is byte-identical after install
OUT="$(bash "$INSTALLER" "$TGT_G" --yes --grow-fs --image "$VERITY_IMG" 2>&1)"; RC=$?
assert_eq 0 "$RC" "G1 verity write -> exit 0"
assert_contains "$OUT" "no partition labeled 'vita-data'" "G2 growth SKIPPED (no vita-data)"
assert_contains "$OUT" "RESULT: PASS" "G3 RESULT: PASS"
partprobe "$TGT_G" 2>/dev/null || true; sleep 0.5
# The hash partition (#3) must NOT have been grown: compare its sector count to the image's.
IMGLD="$(losetup --find --show --partscan "$VERITY_IMG")"; LOOPS+=("$IMGLD"); partprobe "$IMGLD" 2>/dev/null || true; sleep 0.3
IMG_P3_LAST="$(sgdisk -i 3 "$IMGLD" 2>/dev/null | sed -n 's/^Last sector: \([0-9]*\).*/\1/p')"
TGT_P3_LAST="$(sgdisk -i 3 "$TGT_G" 2>/dev/null | sed -n 's/^Last sector: \([0-9]*\).*/\1/p')"
losetup -d "$IMGLD" 2>/dev/null || true
assert_eq "$IMG_P3_LAST" "$TGT_P3_LAST" "G4 verity HASH partition NOT grown (same last sector)"

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
note "GROUP L - system-disk refusal (stacked) still fires (regression guard for FIX 1's sibling)"
# We cannot safely point at the live root here, but we CAN prove the refusal logic by faking
# findmnt to claim '/' is backed by our loop target. Shim findmnt -> emit the loop dev for --target /.
TGT_L="$(mkloop 80M)"
SHIM4="$WORK/shim4"; mkdir -p "$SHIM4"
for t in bash dd sgdisk sfdisk lsblk blockdev readlink id awk sed stat wc head tail grep cat env tr cut sort mountpoint losetup umount mke2fs e2fsck resize2fs mkfs.vfat truncate sleep dirname basename ls dumpe2fs partprobe md5sum blkid udevadm touch printf chmod; do
  src="$(command -v "$t" 2>/dev/null)"; [ -n "$src" ] && ln -sf "$src" "$SHIM4/$t"
done
cat > "$SHIM4/findmnt" <<EF
#!/bin/bash
# Pretend / is backed by the loop target (so the installer must REFUSE it).
for a in "\$@"; do case "\$a" in /) echo "$TGT_L";; esac; done
exit 0
EF
chmod +x "$SHIM4/findmnt"
OUT="$(PATH="$SHIM4" bash "$INSTALLER" "$TGT_L" --yes --image "$FULL_IMG" 2>&1)"; RC=$?
assert_eq 1 "$RC" "L1 system-disk (/) target -> exit 1 refusal"
assert_contains "$OUT" "RUNNING system" "L2 refusal message"
# Prove no write: GPT area still zero.
Z="$(dd if="$TGT_L" bs=1 count=64 skip=512 status=none 2>/dev/null | tr -d '\0' | wc -c)"
assert_eq 0 "$Z" "L3 system-disk refusal wrote nothing"

############################################################################################
printf '\n===== ASSERT %d pass / %d fail (total %d) =====\n' "$PASS" "$FAIL" "$((PASS+FAIL))"
[ "$FAIL" = 0 ] && { echo "HARNESS: ALL PASS"; exit 0; } || { echo "HARNESS: FAILURES"; exit 1; }
