#!/bin/bash
# Measured VITA-LUKS marker. This intentionally emits the OK marker only after
# the second boot proves the /var sentinel persisted on the encrypted mapper.
set -euo pipefail

OUTER_DEVICE="${VITA_LUKS_OUTER_DEVICE:-/dev/disk/by-partlabel/vita-data}"
MAPPER_NAME="${VITA_LUKS_MAPPER_NAME:-vita-data}"
MAPPER_DEVICE="/dev/mapper/$MAPPER_NAME"
SENTINEL="${VITA_LUKS_SENTINEL:-/var/lib/vita/luks/persist.sentinel}"

fail_marker() {
  local step="$1"
  local rc="$2"
  echo "VITA-LUKS-ERROR: reason=${step}:${rc} status=FAILSAFE"
  exit 1
}

if cryptsetup isLuks --type luks2 "$OUTER_DEVICE" >/dev/null 2>&1; then
  :
else
  fail_marker "encrypted_is_luks2" "$?"
fi

if cryptsetup status "$MAPPER_NAME" >/dev/null 2>&1; then
  :
else
  fail_marker "mapper_status" "$?"
fi

if [ ! -e "$MAPPER_DEVICE" ]; then
  fail_marker "mapper_device_missing" 1
fi

if mountpoint -q /var; then
  :
else
  fail_marker "var_mountpoint" "$?"
fi

mount_source="$(findmnt -n -o SOURCE --target /var)" || fail_marker "findmnt_var" "$?"
if [ -z "$mount_source" ]; then
  fail_marker "findmnt_var_empty" 1
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

if [ -f "$SENTINEL" ]; then
  echo "VITA-LUKS: encrypted=OK unlocked=OK persists=OK tpm=stub recovery=stub status=OK"
  exit 0
fi

mkdir -p "$(dirname -- "$SENTINEL")" || fail_marker "sentinel_mkdir" "$?"
printf 'VITA-LUKS persistent sentinel\n' >"$SENTINEL" || fail_marker "sentinel_write" "$?"
sync
echo "VITA-LUKS-PENDING: encrypted=OK unlocked=OK persists=awaiting-second-boot tpm=stub recovery=stub status=PENDING"
