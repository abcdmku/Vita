#!/bin/bash
# Vita SMOKE/VM only - M4 of the CEF live-render arc (ADR-0014).
#
# Run CEF (windowless software OSR) rendering the LIVE flagship desktop and pipe its
# per-frame compositor command stream into the Vita native compositor on the REAL
# VMware GPU (KMS). The compositor composites each frame and, on stream EOF, reads
# back the latest presented frame to a PNG (the genuine GPU readback that proves the
# live desktop rendered on the GPU).
#
#   CEF (osr_host --compositor-out=- --frames=N)  >>pipe>>  vita-compositor --commands
#       register/updateBufferSurface + present per frame  -->  KMS scanout + glReadPixels
#       -->  /run/cef-live.png  (copied out of the guest by vmware-verify --guest-file)
#
# Emits VITA-CEF (this script) + VITA-COMPOSITOR (the compositor) to /dev/ttyS0.
set -u

MARKER=VITA-CEF
TTY=/dev/ttyS0
CEF_DIR=/usr/lib/vita/cef
OSR=$CEF_DIR/vita_cef_osr
COMPOSITOR=/usr/lib/vita/compositor/vita-compositor
# The WHOLE ui_kits/ tree is staged under /usr/lib/vita/ui_kits so every relative asset
# path in the flagship (../styles.css, ../_vendor/lucide.min.js + fonts, ./tokens/*,
# runtime/bootstrap.js) resolves exactly as in the source layout.
DESKTOP=/usr/lib/vita/ui_kits/desktop/index.html
URL=file://$DESKTOP
PNG=/run/cef-live.png
FRAMES=${VITA_CEF_FRAMES:-6}

emit_line() {
  printf '%s\n' "$1"
  if [ -w "$TTY" ]; then
    printf '%s\n' "$1" > "$TTY" 2>/dev/null || true
  fi
}

emit_failsafe() {
  emit_line "$MARKER: sink=buffer-surface present=unverified status=FAILSAFE reason=$1"
}

# --- preconditions -----------------------------------------------------------
if [ ! -x "$OSR" ]; then emit_failsafe "osr_host_missing"; exit 0; fi
if [ ! -x "$COMPOSITOR" ]; then emit_failsafe "compositor_missing"; exit 0; fi
if [ ! -e "$CEF_DIR/libcef.so" ]; then emit_failsafe "libcef_missing"; exit 0; fi
if [ ! -e "$DESKTOP" ]; then emit_failsafe "desktop_assets_missing"; exit 0; fi

# Wait for the DRM device (VMware vmwgfx) so the compositor takes the KMS path.
tries=15
while [ ! -e /dev/dri/card0 ] && [ "$tries" -gt 0 ]; do
  sleep 1
  tries=$((tries - 1))
done
if [ ! -e /dev/dri/card0 ]; then emit_failsafe "dri_card0_absent"; exit 0; fi

# CEF needs a WRITABLE cache + a HOME/XDG/TMPDIR or it can fail to init (process-singleton,
# read-only default cache) — the boot service runs with a minimal env and a read-only /usr.
# Point everything at writable /run (tmpfs, shared namespace). osr_host reads VITA_CEF_CACHE.
export VITA_CEF_CACHE=/run/vita-cef-cache
export HOME=/run/vita-cef-home
export XDG_CACHE_HOME=/run/vita-cef-cache
export XDG_CONFIG_HOME=/run/vita-cef-home/.config
export TMPDIR=/run
mkdir -p "$VITA_CEF_CACHE" "$HOME" "$XDG_CONFIG_HOME" 2>/dev/null

emit_line "$MARKER: stage=start frames=$FRAMES url=$URL card0=present cache=$VITA_CEF_CACHE"

# --- run the pipe ------------------------------------------------------------
# CEF needs libcef.so + its sibling runtime libs on the loader path; co-located in
# $CEF_DIR (osr_host also carries an rpath of '.'). Headless: no DISPLAY, no sandbox.
# The compositor reads CEF's stdout (the command stream), composites on the GPU and
# writes the readback PNG to the SHARED /run (the unit must NOT set PrivateTmp, or the
# PNG lands in a private namespace and vmtoolsd copy-out cannot see it).
rm -f "$PNG"
CEF_LOG=/run/vita-cef-osr.log
COMP_LOG=$(mktemp /run/vita-cef-comp.XXXXXX 2>/dev/null || mktemp /tmp/vita-cef-comp.XXXXXX)

cd "$CEF_DIR" || { emit_failsafe "cef_dir_cd"; exit 0; }
set -o pipefail
LD_LIBRARY_PATH="$CEF_DIR" \
  timeout 90s "$OSR" --url="$URL" --compositor-out=- --frames="$FRAMES" 2>"$CEF_LOG" \
  | LD_LIBRARY_PATH=/usr/lib/x86_64-linux-gnu \
    timeout 90s "$COMPOSITOR" --commands --hold-seconds 0 --screenshot "$PNG" > "$COMP_LOG" 2>&1
rc=$?
# Surface a one-line CEF diagnostic to serial (frames emitted, or the failure reason).
cef_tail=$(grep -aE "OnPaint #|emitted compositor|stream:|ERROR|CefInitialize|load error" "$CEF_LOG" 2>/dev/null | tail -3 | tr '\n' '|')
emit_line "$MARKER: cef_diag=${cef_tail:-none}"

# Surface the compositor's own marker line to serial (carries gpu=… present=kms/…).
while IFS= read -r line; do
  case "$line" in
    VITA-COMPOSITOR:*) emit_line "$line" ;;
  esac
done < "$COMP_LOG"

shot_bytes=$(stat -c%s "$PNG" 2>/dev/null || echo 0)
emit_line "$MARKER: readback=$PNG bytes=$shot_bytes"

# --- verdict -----------------------------------------------------------------
if grep -q "^VITA-COMPOSITOR: .* status=OK" "$COMP_LOG" && [ "$shot_bytes" -gt 0 ]; then
  # Report the compositor's present mode (kms on VMware GPU; recording on no-GPU fallback).
  present=$(grep -m1 "^VITA-COMPOSITOR:" "$COMP_LOG" | sed -n 's/.*present=\([^ ]*\).*/\1/p')
  emit_line "$MARKER: sink=buffer-surface present=${present:-unknown} status=OK"
  rm -f "$COMP_LOG"
  exit 0
fi

if [ "$rc" -eq 124 ]; then
  emit_failsafe "timeout"
elif [ "$shot_bytes" -eq 0 ]; then
  emit_failsafe "screenshot_missing"
else
  emit_failsafe "exit_$rc"
fi
rm -f "$COMP_LOG"
exit 0
