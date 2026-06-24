#!/bin/bash
# Measured VITA-BTRFS marker. Rollback is tested against the top-level @data
# subvolume path; a live /var mount may need a reboot/remount to observe the
# swapped subvolume, but the on-disk @data rollback target is measured here.
set -euo pipefail

TOP="${VITA_BTRFS_TOP:-/run/vita-btrfs-marker}"
WORKDIR="/var/lib/vita/btrfs-marker"

fail_marker() {
  local step="$1"
  local rc="$2"
  echo "VITA-BTRFS-ERROR: reason=${step}:${rc} status=FAILSAFE"
  exit 1
}

run_step() {
  local step="$1"
  shift
  "$@" || fail_marker "$step" "$?"
}

cleanup() {
  set +e
  mountpoint -q "$TOP" && umount "$TOP" >/dev/null 2>&1
}
trap cleanup EXIT

mountpoint -q /var || fail_marker "var_mountpoint" "$?"

fstype="$(findmnt -n -o FSTYPE --target /var)" || fail_marker "findmnt_fstype" "$?"
source="$(findmnt -n -o SOURCE --target /var)" || fail_marker "findmnt_source" "$?"
options="$(findmnt -n -o OPTIONS --target /var)" || fail_marker "findmnt_options" "$?"

[ "$fstype" = "btrfs" ] || fail_marker "var_not_btrfs" 1
case ",$options," in
  *,subvol=/@data,*|*,subvol=@data,*) ;;
  *) fail_marker "var_not_atdata" 1 ;;
esac

run_step "top_mkdir" mkdir -p "$TOP"
if ! mountpoint -q "$TOP"; then
  run_step "top_mount" mount -t btrfs -o subvolid=5,compress=zstd:1 "$source" "$TOP"
fi

[ -d "$TOP/@data" ] || fail_marker "data_subvolume_missing" 1
[ -d "$TOP/@snapshots" ] || fail_marker "snapshots_subvolume_missing" 1
run_step "workdir_mkdir" mkdir -p "$WORKDIR"

stamp="$(date -u +%Y%m%dT%H%M%SZ)-$$"
snap="marker-$stamp"
rollback_snap="rollback-$stamp"
restore=".rollback-restore-$stamp"

run_step "snapshot_create" btrfs subvolume snapshot -r "$TOP/@data" "$TOP/@snapshots/$snap"
ro="$(btrfs property get -ts "$TOP/@snapshots/$snap" ro 2>/dev/null)" || fail_marker "snapshot_ro_probe" "$?"
printf '%s\n' "$ro" | grep -Fq "ro=true" || fail_marker "snapshot_not_readonly" 1

run_step "quota_limit" btrfs qgroup limit 32M "$TOP/@data"
run_step "quota_under_write" dd if=/dev/zero of="$WORKDIR/quota-under.bin" bs=1M count=1 conv=fsync status=none
if dd if=/dev/zero of="$WORKDIR/quota-over.bin" bs=1M count=64 conv=fsync status=none >/dev/null 2>&1; then
  fail_marker "quota_not_enforced" 1
fi
rm -f "$WORKDIR/quota-under.bin" "$WORKDIR/quota-over.bin"

printf 'A\n' >"$WORKDIR/rollback-sentinel.txt" || fail_marker "rollback_write_A" "$?"
sync
run_step "rollback_snapshot_create" btrfs subvolume snapshot -r "$TOP/@data" "$TOP/@snapshots/$rollback_snap"
printf 'B\n' >"$WORKDIR/rollback-sentinel.txt" || fail_marker "rollback_write_B" "$?"
sync
run_step "rollback_restore_clone" btrfs subvolume snapshot "$TOP/@snapshots/$rollback_snap" "$TOP/@snapshots/$restore"
if mv --exchange "$TOP/@data" "$TOP/@snapshots/$restore" >/dev/null 2>&1; then
  :
else
  fail_marker "rollback_exchange" "$?"
fi

restored="$TOP/@data/lib/vita/btrfs-marker/rollback-sentinel.txt"
[ -f "$restored" ] || fail_marker "rollback_missing_A" 1
grep -Fxq "A" "$restored" || fail_marker "rollback_mismatch" 1
if grep -Fxq "B" "$restored" 2>/dev/null; then
  fail_marker "rollback_left_B" 1
fi

echo "VITA-BTRFS: subvol=@data snapshot=OK rollback=OK quota=enforced status=OK"
