#!/bin/bash
# Measured VITA-BTRFS marker. The service is build-gated by VITA_BTRFS=1 and
# this script asserts that /var is btrfs on the decrypted LUKS mapper.
set -euo pipefail

OUTER_DEVICE="${VITA_LUKS_OUTER_DEVICE:-/dev/disk/by-partlabel/vita-data}"
MAPPER_NAME="${VITA_LUKS_MAPPER_NAME:-vita-data}"
MAPPER_DEVICE="/dev/mapper/$MAPPER_NAME"

fail_marker() {
  local step="$1"
  local rc="$2"
  echo "VITA-BTRFS-ERROR: reason=${step}:${rc} status=FAILSAFE"
  exit 1
}

if [ ! -e "$MAPPER_DEVICE" ]; then
  fail_marker "mapper_device_missing" 1
fi

if mountpoint -q /var; then
  :
else
  fail_marker "var_mountpoint" "$?"
fi

fstype="$(findmnt -n -o FSTYPE --target /var)" || fail_marker "findmnt_fstype" "$?"
if [ "$fstype" != "btrfs" ]; then
  fail_marker "fstype_not_btrfs" 1
fi

mount_source="$(findmnt -n -o SOURCE --target /var)" || fail_marker "findmnt_source" "$?"
if [ -z "$mount_source" ]; then
  fail_marker "findmnt_source_empty" 1
fi

mapper_real="$(readlink -f "$MAPPER_DEVICE")" || fail_marker "mapper_realpath" "$?"
source_real="$(readlink -f "$mount_source")" || fail_marker "source_realpath" "$?"
outer_real="$(readlink -f "$OUTER_DEVICE")" || fail_marker "outer_realpath" "$?"

if [ "$source_real" != "$mapper_real" ]; then
  fail_marker "var_not_on_mapper" 1
fi
if [ "$source_real" = "$outer_real" ]; then
  fail_marker "var_on_outer_plaintext" 1
fi

echo "VITA-BTRFS: fstype=btrfs onMapper=OK status=OK"
