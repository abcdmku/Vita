#!/bin/bash
# Vita SMOKE VM only - run the DMABUF/EGLImage import self-test and always emit VITA-DMABUF.
set -u

MARKER=VITA-DMABUF
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
  emit_line "$MARKER: import=FAIL fourcc=AR24 modifier=0x00ffffffffffffff status=FAILSAFE reason=$1 gpu=unavailable"
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

TMP=$(mktemp /run/vita-compositor-dmabuf-selftest.XXXXXX 2>/dev/null || mktemp /tmp/vita-compositor-dmabuf-selftest.XXXXXX)
: > "$TMP"
rc=0
timeout 45s "$BIN" --dmabuf-self-test 2>&1 | while IFS= read -r line; do
  printf '%s\n' "$line" >> "$TMP"
  emit_line "$line"
done
pipeline_status=("${PIPESTATUS[@]}")
rc=${pipeline_status[0]}

if grep -q "^$MARKER:" "$TMP"; then
  exit 0
fi

if [ "$rc" -eq 124 ]; then
  emit_failsafe "timeout"
else
  emit_failsafe "exit_$rc"
fi
exit 0
