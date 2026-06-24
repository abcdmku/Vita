#!/bin/bash
# Measured VITA-POWERCUT marker. The OK line is emitted only after a prior
# boot's counter is read back from persistent /var and parsed canonically.
set -euo pipefail

DATA_DEVICE="${VITA_POWERCUT_DATA_DEVICE:-/dev/disk/by-partlabel/vita-data}"
MAPPER_DEVICE="${VITA_POWERCUT_MAPPER_DEVICE:-/dev/mapper/vita-data}"
AGENTD="${VITA_POWERCUT_AGENTD:-/usr/lib/vita/agentd}"

fail_marker() {
  local step="$1"
  local rc="$2"
  echo "VITA-POWERCUT-ERROR: reason=${step}:${rc} status=FAILSAFE"
  exit 1
}

if [ ! -e "$DATA_DEVICE" ] && [ ! -e "$MAPPER_DEVICE" ]; then
  echo "VITA-POWERCUT-SKIP: reason=vita-data-absent status=SKIP"
  exit 0
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

source_real="$(readlink -f "$mount_source")" || fail_marker "source_realpath" "$?"
matched=0
if [ -e "$MAPPER_DEVICE" ]; then
  mapper_real="$(readlink -f "$MAPPER_DEVICE")" || fail_marker "mapper_realpath" "$?"
  [ "$source_real" = "$mapper_real" ] && matched=1
fi
if [ -e "$DATA_DEVICE" ]; then
  data_real="$(readlink -f "$DATA_DEVICE")" || fail_marker "data_realpath" "$?"
  [ "$source_real" = "$data_real" ] && matched=1
fi
if [ "$matched" -ne 1 ]; then
  fail_marker "var_not_on_vita_data" 1
fi

if [ ! -x "$AGENTD" ]; then
  fail_marker "agentd_missing" 1
fi

output="$("$AGENTD" powercut-marker 2>&1)" || {
  rc=$?
  printf '%s\n' "$output" >&2
  fail_marker "agentd_powercut_marker" "$rc"
}

case "$output" in
  *"VITA-POWERCUT: "*" status=OK"*|*"VITA-POWERCUT-PENDING: "*" status=PENDING"*)
    printf '%s\n' "$output"
    ;;
  *)
    printf '%s\n' "$output" >&2
    fail_marker "unexpected_marker_output" 1
    ;;
esac
