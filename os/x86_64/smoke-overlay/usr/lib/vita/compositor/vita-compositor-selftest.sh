#!/bin/bash
# Vita SMOKE VM only - render the TS driver-produced compositor layout once and always emit a marker.
set -u

MARKER=VITA-COMPOSITOR
BIN=/usr/lib/vita/compositor/vita-compositor
COMMANDS=/usr/lib/vita/compositor/vita-compositor-smoke.commands
TTY=/dev/ttyS0
TMP=
WALLPAPER_CMDS=
HOLD_SECONDS=30
SCREENSHOT=/run/vita-compositor-driver.png

# CEF live-desktop boot (spike/cef-vm): when the CEF overlay is present, the persistent
# vita-cef-live service renders the REAL flagship desktop right after this self-test releases
# the GPU. In that mode the user must NEVER see the self-test's demo geometry (3 colored
# rectangles + a bar) on screen. So instead of the committed demo layout we present a single
# clean full-screen WALLPAPER surface (one solid color, matching the flagship light wallpaper
# ~#e9edf3) and hold IT until CEF takes over. The self-test verification still holds:
# surfaces=1 composited=OK present=kms status=OK. (The drift-guarded committed .commands file
# is untouched; we only choose a different on-screen layout at runtime for CEF boots.)
CEF_LAUNCH=/usr/lib/vita/cef/vita-cef-live.sh
WALLPAPER_RGBA=e9edf3ff
WALLPAPER_W=1280
WALLPAPER_H=720

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
  if [ -n "${WALLPAPER_CMDS:-}" ]; then
    rm -f "$WALLPAPER_CMDS"
  fi
}
trap cleanup EXIT

# Fast boot (cef-vm-input): when the CEF live-desktop overlay is present, the persistent CEF
# service owns the GPU and provides the on-screen desktop (an INSTANT baked snapshot, then the
# live interactive render) plus its own VITA-COMPOSITOR markers. This self-test must then NOT
# take /dev/dri/card0 at all — running it first (and holding a frame for 30s) was the dominant
# boot bottleneck AND would contend for the exclusive KMS master. Yield immediately so CEF starts
# right away. Emit a marker so the boot log still shows the self-test ran (status=OK, skipped).
if [ -e "$CEF_LAUNCH" ]; then
  emit_line "$MARKER: cef-mode=yes selftest=skipped (CEF service owns the GPU; fast boot) status=OK"
  exit 0
fi

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

TMP=$(mktemp /run/vita-compositor-selftest.XXXXXX 2>/dev/null || mktemp /tmp/vita-compositor-selftest.XXXXXX)
: > "$TMP"
rc=0
rm -f "$SCREENSHOT"

# Choose the on-screen layout: clean wallpaper for CEF boots, the demo otherwise.
FEED=$COMMANDS
if [ -e "$CEF_LAUNCH" ]; then
  WALLPAPER_CMDS=$(mktemp /run/vita-compositor-wall.XXXXXX 2>/dev/null || mktemp /tmp/vita-compositor-wall.XXXXXX)
  {
    printf 'registerSurface vita:wallpaper %s %s %s\n' "$WALLPAPER_W" "$WALLPAPER_H" "$WALLPAPER_RGBA"
    printf 'updatePlacement vita:wallpaper 0 0 %s %s 0 true\n' "$WALLPAPER_W" "$WALLPAPER_H"
    printf 'present\n'
  } > "$WALLPAPER_CMDS"
  FEED=$WALLPAPER_CMDS
  emit_line "$MARKER: cef-mode=yes layout=wallpaper (suppressing demo geometry until CEF paints)"
fi

timeout 45s "$BIN" --commands --screenshot "$SCREENSHOT" --hold-seconds "$HOLD_SECONDS" < "$FEED" 2>&1 | while IFS= read -r line; do
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
