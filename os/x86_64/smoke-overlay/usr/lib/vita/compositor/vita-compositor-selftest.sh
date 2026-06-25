#!/bin/bash
# Vita SMOKE VM only - run the compositor KMS self-test once and always emit a VITA-COMPOSITOR marker.
set -u

MARKER=VITA-COMPOSITOR
BIN=/usr/lib/vita/compositor/vita-compositor
TTY=/dev/ttyS0
TMP=

emit_line() {
  printf '%s\n' "$1"
  if [ -w "$TTY" ]; then
    printf '%s\n' "$1" > "$TTY" 2>/dev/null || true
  fi
}

emit_failsafe() {
  emit_line "$MARKER: gpu=unavailable surfaces=0 composited=FAIL reposition=unverified present=unverified damage=FAIL status=FAILSAFE reason=$1"
}

cleanup() {
  if [ -n "${TMP:-}" ]; then
    rm -f "$TMP"
  fi
}
trap cleanup EXIT

if [ ! -x "$BIN" ]; then
  emit_failsafe "binary_missing"
  exit 0
fi

tries=10
while [ ! -e /dev/dri/card0 ] && [ "$tries" -gt 0 ]; do
  sleep 1
  tries=$((tries - 1))
done

if [ ! -e /dev/dri/card0 ]; then
  emit_failsafe "dri_card0_absent"
  exit 0
fi

TMP=$(mktemp /run/vita-compositor-selftest.XXXXXX 2>/dev/null || mktemp /tmp/vita-compositor-selftest.XXXXXX)
rc=0
timeout 20s "$BIN" > "$TMP" 2>&1 || rc=$?

seen=0
while IFS= read -r line; do
  emit_line "$line"
  case "$line" in
    "$MARKER":*) seen=1 ;;
  esac
done < "$TMP"

if [ "$seen" -eq 1 ]; then
  exit 0
fi

if [ "$rc" -eq 124 ]; then
  emit_failsafe "timeout"
else
  emit_failsafe "exit_$rc"
fi
exit 0
