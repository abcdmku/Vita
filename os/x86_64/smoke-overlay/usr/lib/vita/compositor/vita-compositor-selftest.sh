#!/bin/bash
# Vita SMOKE VM only - render the TS driver-produced compositor layout once and always emit a marker.
set -u

MARKER=VITA-COMPOSITOR
BIN=/usr/lib/vita/compositor/vita-compositor
COMMANDS=/usr/lib/vita/compositor/vita-compositor-smoke.commands
TTY=/dev/ttyS0
TMP=
HOLD_SECONDS=30
SCREENSHOT=/run/vita-compositor-driver.png

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

if [ ! -s "$COMMANDS" ]; then
  emit_failsafe "commands_missing"
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

# DMABUF GBM round-trip self-test (PSD-020): emits VITA-DMABUF — the vmwgfx zero-copy de-risk measurement.
# Best-effort + before the demo; its own marker tells us if CEF accelerated-OSR (DMABUF->EGLImage) is viable on vmwgfx.
"$BIN" --dmabuf-self-test 2>&1 | while IFS= read -r dline; do emit_line "$dline"; done || true

TMP=$(mktemp /run/vita-compositor-selftest.XXXXXX 2>/dev/null || mktemp /tmp/vita-compositor-selftest.XXXXXX)
: > "$TMP"
rc=0
rm -f "$SCREENSHOT"
timeout 45s "$BIN" --commands --screenshot "$SCREENSHOT" --hold-seconds "$HOLD_SECONDS" < "$COMMANDS" 2>&1 | while IFS= read -r line; do
  printf '%s\n' "$line" >> "$TMP"
  emit_line "$line"
done
pipeline_status=("${PIPESTATUS[@]}")
rc=${pipeline_status[0]}

# Verification breadcrumb: report the readback screenshot size to serial so the orchestrator can
# confirm the PNG was written and is visible in the shared /run namespace for copy-out.
emit_line "VITA-COMPOSITOR-SHOT: path=$SCREENSHOT bytes=$(stat -c%s "$SCREENSHOT" 2>/dev/null || echo 0)"

if grep -q "^$MARKER: .* status=OK " "$TMP"; then
  if [ -s "$SCREENSHOT" ]; then
    exit 0
  fi
  emit_failsafe "screenshot_missing"
  exit 0
fi

if grep -q "^$MARKER:" "$TMP"; then
  exit 0
fi

if [ "$rc" -eq 124 ]; then
  emit_failsafe "timeout"
elif [ ! -s "$SCREENSHOT" ]; then
  emit_failsafe "screenshot_missing"
else
  emit_failsafe "exit_$rc"
fi
exit 0
