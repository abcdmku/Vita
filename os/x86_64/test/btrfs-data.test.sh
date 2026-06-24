#!/bin/bash
# Host-side Btrfs data-plane mechanism test for P1-074. The loop/mount portion
# requires root, loop devices, and btrfs-progs; static gate checks run always.
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
if REPO_REL="$(git rev-parse --path-format=relative --show-toplevel 2>/dev/null)" && [ -n "$REPO_REL" ]; then
  REPO="${REPO_REL%/}"
  [ -n "$REPO" ] || REPO="."
else
  REPO="$(cd -- "$SCRIPT_DIR/../../.." && pwd -P)"
fi

BUILD_AND_BOOT="$REPO/os/x86_64/build-and-boot.mjs"
MKOSI_CONF="$REPO/os/x86_64/mkosi.conf"
BUILD_ROOT="$REPO/os/x86_64/build-root.mjs"
ROOT_DETERMINISM_TEST="$REPO/os/x86_64/test/root-determinism.test.ts"
MARKER_SERVICE="$REPO/os/x86_64/verity-overlay/usr/lib/systemd/system/vita-btrfs-marker.service"
MARKER_DROPIN="$REPO/os/x86_64/verity-overlay/usr/lib/systemd/system/multi-user.target.d/20-vita-btrfs-marker.conf"
MARKER_SCRIPT="$REPO/os/x86_64/verity-overlay/usr/lib/vita/btrfs/vita-btrfs-marker.sh"

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

assert_file() {
  [ -f "$1" ] || fail "missing file: $1"
}

assert_file_line() {
  local path="$1"
  local pattern="$2"
  local label="$3"
  grep -Eq "$pattern" "$path" || fail "$label: expected $path to match $pattern"
}

assert_file "$MARKER_SERVICE"
assert_file "$MARKER_DROPIN"
assert_file "$MARKER_SCRIPT"
assert_file_line "$BUILD_AND_BOOT" 'VITA_BTRFS' "build must expose VITA_BTRFS gate"
assert_file_line "$BUILD_AND_BOOT" 'mkfs\.btrfs' "build must format Btrfs under the gate"
assert_file_line "$BUILD_AND_BOOT" 'subvol=@data' "build must mount @data at /var"
assert_file_line "$MARKER_SERVICE" 'ConditionPathExists=/usr/lib/vita/btrfs/enabled' "marker service must be gate-gated"
assert_file_line "$MARKER_SERVICE" 'After=.*vita-agentd\.service.*vita-ts\.service' "marker service must run after agentd and the TS apply path"
assert_file_line "$MARKER_SCRIPT" 'capability":"node\.config"' "marker script must trigger a representative agentd apply"
assert_file_line "$MARKER_SCRIPT" 'capability":"storage\.snapshot"' "marker script must roll back through the storage.snapshot capability"
assert_file_line "$MARKER_SCRIPT" 'VITA-BTRFS: subvol=@data snapshot=OK rollback=restored quota=enforced status=OK' "marker script must emit measured OK"
assert_file_line "$MKOSI_CONF" '^[[:space:]]+btrfs-progs$' "mkosi package set must include btrfs-progs"
assert_file_line "$BUILD_ROOT" '^[[:space:]]+"btrfs-progs",$' "planner package allowlist must include btrfs-progs"
assert_file_line "$ROOT_DETERMINISM_TEST" '^[[:space:]]+"btrfs-progs",$' "determinism test package allowlist must include btrfs-progs"

if [ "$(id -u)" -ne 0 ]; then
  echo "SKIP: root/loop Btrfs exercise requires root; gate, marker, and package checks passed"
  exit 0
fi

for cmd in btrfs losetup mkfs.btrfs mount umount mountpoint fallocate truncate mv; do
  command -v "$cmd" >/dev/null 2>&1 || {
    echo "SKIP: root/loop Btrfs exercise needs '$cmd'; gate, marker, and package checks passed"
    exit 0
  }
done

if ! mv --help 2>&1 | grep -q -- '--exchange'; then
  echo "SKIP: root/loop Btrfs rollback needs 'mv --exchange'; gate, marker, and package checks passed"
  exit 0
fi

if ! losetup -f >/dev/null 2>&1; then
  echo "SKIP: no free loop devices; gate, marker, and package checks passed"
  exit 0
fi

TMP="$(mktemp -d)"
IMG="$TMP/vita-data.img"
MNT="$TMP/mnt"
LOOP=""

cleanup() {
  set +e
  mountpoint -q "$MNT" && umount "$MNT"
  [ -n "$LOOP" ] && losetup -d "$LOOP" >/dev/null 2>&1
  rm -rf "$TMP"
}
trap cleanup EXIT

mkdir -p "$MNT"
truncate -s 768M "$IMG"
LOOP="$(losetup --find --show "$IMG")"

mkfs.btrfs -f -L vita-data "$LOOP" >/dev/null
mount -t btrfs "$LOOP" "$MNT"
btrfs subvolume create "$MNT/@data" >/dev/null
btrfs subvolume create "$MNT/@snapshots" >/dev/null
btrfs quota enable "$MNT"

printf 'A\n' >"$MNT/@data/sentinel.txt"
btrfs subvolume snapshot -r "$MNT/@data" "$MNT/@snapshots/snap-a" >/dev/null
btrfs property get -ts "$MNT/@snapshots/snap-a" ro | grep -Fq 'ro=true' || fail "snapshot is not read-only"

btrfs qgroup limit 16M "$MNT/@data"
fallocate -l 1048576 "$MNT/@data/under.bin"
if fallocate -l 67108864 "$MNT/@data/over.bin" >/dev/null 2>&1; then
  fail "over-quota write unexpectedly succeeded"
fi
rm -f "$MNT/@data/under.bin" "$MNT/@data/over.bin"
btrfs qgroup limit none "$MNT/@data"

printf 'B\n' >"$MNT/@data/sentinel.txt"
btrfs subvolume snapshot "$MNT/@snapshots/snap-a" "$MNT/@snapshots/restore" >/dev/null
mv --exchange "$MNT/@data" "$MNT/@snapshots/restore"
grep -Fxq 'A' "$MNT/@data/sentinel.txt" || fail "rollback did not restore A"
if grep -Fxq 'B' "$MNT/@data/sentinel.txt" 2>/dev/null; then
  fail "rollback left B in @data"
fi

echo "PASS: Btrfs subvol=@data snapshot=OK rollback=restored quota=enforced"
