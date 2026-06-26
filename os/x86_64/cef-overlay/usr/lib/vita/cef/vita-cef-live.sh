#!/bin/bash
# Vita SMOKE/VM - M4 of the CEF live-render arc (ADR-0014), PERSISTENT mode (spike/cef-vm).
#
# Run CEF (windowless software OSR) rendering the LIVE flagship desktop and pipe its
# per-frame compositor command stream CONTINUOUSLY into the Vita native compositor on the
# REAL VMware GPU (KMS). The compositor presents EVERY frame and HOLDS the desktop on the
# screen INDEFINITELY — so when the VM is powered on the desktop stays visible (not a
# few-frame flash). The pipe is long-lived: CEF streams unbounded frames (--frames=0) and
# the compositor runs in --continuous mode (emits its OK marker after the first present,
# then keeps presenting until the upstream pipe closes).
#
#   CEF (osr_host --compositor-out=- --frames=0)  >>pipe>>  vita-compositor --commands --continuous
#       register/updateBufferSurface + present per frame  -->  KMS scanout (held live)
#
# Emits VITA-CEF (this script) + VITA-COMPOSITOR (the compositor) to /dev/ttyS0, then stays
# in the foreground for the life of the service. Fail-closed: any precondition miss emits a
# FAILSAFE marker and exits 0 (the boot proceeds; the desktop is simply absent).
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
# 0 = UNBOUNDED: stream frames forever so the compositor keeps the desktop live on screen.
FRAMES=${VITA_CEF_FRAMES:-0}
# Cadence between emitted frames (ms); the live clock + any hydrated content keep updating.
INTERVAL_MS=${VITA_CEF_INTERVAL_MS:-500}

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

emit_line "$MARKER: stage=start mode=persistent frames=$FRAMES interval=${INTERVAL_MS}ms url=$URL card0=present cache=$VITA_CEF_CACHE"

# --- run the long-lived pipe -------------------------------------------------
# CEF needs libcef.so + its sibling runtime libs on the loader path; co-located in
# $CEF_DIR (osr_host also carries an rpath of '.'). Headless: no DISPLAY, no sandbox.
# The compositor reads CEF's stdout (the command stream), composites on the GPU and keeps
# presenting every frame. Its OWN stdout (VITA-COMPOSITOR markers) is teed to a fifo we
# tail, so we can surface the first OK marker to serial WITHOUT terminating the pipe.
CEF_LOG=/run/vita-cef-osr.log
COMP_OUT=/run/vita-cef-comp.out
: > "$CEF_LOG"
: > "$COMP_OUT"

cd "$CEF_DIR" || { emit_failsafe "cef_dir_cd"; exit 0; }
set -o pipefail

# Start the live pipe in the background; capture the compositor's marker stream to COMP_OUT.
LD_LIBRARY_PATH="$CEF_DIR" \
  "$OSR" --url="$URL" --compositor-out=- --frames="$FRAMES" --frame-interval-ms="$INTERVAL_MS" 2>"$CEF_LOG" \
  | LD_LIBRARY_PATH=/usr/lib/x86_64-linux-gnu \
    "$COMPOSITOR" --commands --continuous > "$COMP_OUT" 2>&1 &
PIPE_PGID=$!

# Wait (bounded) for the compositor's first OK marker, surface it + the verdict to serial.
deadline=$((SECONDS + 90))
seen_ok=0
while [ "$SECONDS" -lt "$deadline" ]; do
  if ! kill -0 "$PIPE_PGID" 2>/dev/null; then break; fi
  if grep -aq "^VITA-COMPOSITOR: .* status=OK" "$COMP_OUT" 2>/dev/null; then
    seen_ok=1
    break
  fi
  sleep 1
done

# Surface the compositor's OK marker line(s) (they carry gpu=…/present=kms) to serial.
while IFS= read -r line; do
  case "$line" in
    VITA-COMPOSITOR:*) emit_line "$line" ;;
  esac
done < "$COMP_OUT"

if [ "$seen_ok" -eq 1 ]; then
  present=$(grep -m1 "^VITA-COMPOSITOR:" "$COMP_OUT" | sed -n 's/.*present=\([^ ]*\).*/\1/p')
  emit_line "$MARKER: sink=buffer-surface present=${present:-unknown} status=OK persistent=yes"
else
  # The pipe died before a frame presented, or timed out — surface a CEF diagnostic.
  cef_tail=$(grep -aE "OnPaint #|emitted compositor|stream:|ERROR|CefInitialize|load error" "$CEF_LOG" 2>/dev/null | tail -3 | tr '\n' '|')
  emit_line "$MARKER: cef_diag=${cef_tail:-none}"
  emit_failsafe "no_present_within_90s"
  # Reap whatever is left and exit fail-closed (Restart=on-failure re-attempts the pipe).
  kill "$PIPE_PGID" 2>/dev/null || true
  wait "$PIPE_PGID" 2>/dev/null || true
  exit 1
fi

# Desktop is LIVE. Hold the service in the foreground for the life of the pipe so the
# compositor keeps the KMS master and presents every frame. When the VM powers off (or the
# pipe breaks) the wait returns and we exit; Restart=on-failure re-establishes it.
wait "$PIPE_PGID"
rc=$?
emit_line "$MARKER: persistent pipe ended rc=$rc"
# A non-zero exit lets systemd Restart=on-failure rebuild the live desktop.
[ "$rc" -eq 0 ] && exit 0 || exit "$rc"
