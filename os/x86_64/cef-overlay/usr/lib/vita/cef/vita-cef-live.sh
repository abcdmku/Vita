#!/bin/bash
# Vita SMOKE/VM - CEF live-render arc (ADR-0014): LIVE + HONEST-LOADING + INTERACTIVE (cef-vm-input).
#
# NO fake/placeholder desktop: the moment the user sees something that looks like the desktop, it IS
# the live CEF render. Boot flow (one long-lived compositor process, on the real VMware GPU / KMS):
#   1. HONEST LOADING: present a wallpaper + a clear "starting" indicator (loading.commands) UNDER the
#      desktop (z=0) + a visible cursor (cursor.commands). This is NOT a snapshot of the flagship.
#   2. LIVE: CEF (windowless software OSR) cold-starts and streams the REAL flagship into cef:desktop
#      at z=10 -> its first opaque full-screen frame COVERS the loading screen. The first thing that
#      looks like the desktop IS the live render. Unbounded (--frames=0); persistent for the VM life.
#   3. INTERACTIVE (PSD-055): the compositor reads libinput (incl. ABSOLUTE motion from VMware's
#      EV_ABS pointer), routes (PSD-300), writes routed events to a reverse-channel FIFO (--input-out);
#      osr_host reads it (--input-in) and injects CEF SendMouseMove/Click/Key; a visible cursor surface
#      tracks the routed pointer.
#
#       ( cat loading+cursor ; osr_host --input-in=FIFO --frames=0 )
#            >>pipe(commands)>>  vita-compositor --commands --continuous --input-out=FIFO
#                                  presents every frame on KMS + moves the cursor + drains input
#
# Emits VITA-CEF + VITA-COMPOSITOR to /dev/ttyS0. Fail-closed: any precondition miss emits a
# FAILSAFE marker and exits (the boot proceeds; Restart=on-failure rebuilds the live desktop).
set -u

MARKER=VITA-CEF
TTY=/dev/ttyS0
CEF_DIR=/usr/lib/vita/cef
OSR=$CEF_DIR/vita_cef_osr
COMPOSITOR=/usr/lib/vita/compositor/vita-compositor
DESKTOP=/usr/lib/vita/ui_kits/desktop/index.html
URL=file://$DESKTOP
# HONEST loading screen (NOT a fake desktop): a wallpaper + a clear "starting" indicator, shown
# UNDER the live desktop until CEF paints. We do NOT bake a snapshot of the flagship — the moment
# the user sees something that looks like the desktop, it IS the live CEF render.
LOADING=$CEF_DIR/loading.commands
CURSOR=$CEF_DIR/cursor.commands
# 0 = UNBOUNDED. A tight interval keeps the cursor + live content responsive (compositor drains
# input + repositions the cursor every present, which is driven by this cadence).
FRAMES=${VITA_CEF_FRAMES:-0}
INTERVAL_MS=${VITA_CEF_INTERVAL_MS:-100}

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

# CEF needs a WRITABLE cache + HOME/XDG/TMPDIR (read-only /usr at boot). Point at /run (tmpfs).
export VITA_CEF_CACHE=/run/vita-cef-cache
export HOME=/run/vita-cef-home
export XDG_CACHE_HOME=/run/vita-cef-cache
export XDG_CONFIG_HOME=/run/vita-cef-home/.config
export TMPDIR=/run
mkdir -p "$VITA_CEF_CACHE" "$HOME" "$XDG_CONFIG_HOME" 2>/dev/null

# --- input reverse-channel FIFO (PSD-055) ------------------------------------
INPUT_FIFO=/run/vita-cef-input.fifo
rm -f "$INPUT_FIFO"
mkfifo "$INPUT_FIFO" 2>/dev/null || true
# Hold the FIFO open read-write from the script (fd 3) for the life of the service. The compositor
# opens --input-out for WRITE with O_NONBLOCK, which fails (ENXIO) and silently disables input if
# no reader is open yet — and the compositor opens it at startup, BEFORE osr_host execs (osr_host
# runs only after the ~7MB snapshot prelude is cat'd). Keeping a reader present (fd 3, never read,
# so it does not steal events from osr_host's reader) makes the write-open always succeed.
exec 3<>"$INPUT_FIFO" || true

# --- honest loading prelude (NO fake desktop) --------------------------------
# Show an HONEST loading screen (wallpaper + a clear "starting" indicator) UNDER the live desktop,
# at z=0, until CEF paints. CEF registers cef:desktop at a HIGHER z (10) and, being an opaque
# full-screen render, covers the loading screen the instant its first real frame arrives — so the
# first thing that LOOKS like the desktop IS the live desktop. No baked flagship snapshot.
PRELUDE=/run/vita-cef-prelude.commands
: > "$PRELUDE"
have_loading=0
if [ -s "$LOADING" ]; then
  cat "$LOADING" >> "$PRELUDE"
  have_loading=1
fi
if [ -s "$CURSOR" ]; then
  cat "$CURSOR" >> "$PRELUDE"
fi
# One present to scan out the honest loading screen + cursor right away.
printf 'present\n' >> "$PRELUDE"

# CEF registers cef:desktop itself (no pre-armed snapshot surface to update).
PREARM=""

emit_line "$MARKER: stage=start mode=live+honest-loading+interactive frames=$FRAMES interval=${INTERVAL_MS}ms loading=$have_loading url=$URL card0=present"

# --- run the long-lived pipe -------------------------------------------------
CEF_LOG=/run/vita-cef-osr.log
COMP_OUT=/run/vita-cef-comp.out
: > "$CEF_LOG"
: > "$COMP_OUT"

cd "$CEF_DIR" || { emit_failsafe "cef_dir_cd"; exit 0; }
set -o pipefail

# --- PSD-500 host proxy: the platform side of the desktop host bridge -------------------------
# A small Deno service on a unix socket; the CEF renderer's window.vitaDesktopBridge forwards each
# SurfaceHostRequest here, where it is routed to REAL backends (files under /var/lib/vita/files,
# launchApp, settings, notifications). Capability-enforced + fail-closed. Start it BEFORE CEF so the
# bridge connects on the first host call. If deno or the proxy is missing the desktop still boots —
# host actions just fail closed (HOST_BRIDGE_UNAVAILABLE), which the desktop guards already handle.
HOST_PROXY_SOCK=/run/vita-host-proxy.sock
DENO=/usr/lib/vita/deno
HOST_PROXY=$CEF_DIR/vita-host-proxy.ts
if [ -x "$DENO" ] && [ -e "$HOST_PROXY" ]; then
  mkdir -p /var/lib/vita/files 2>/dev/null || true
  rm -f "$HOST_PROXY_SOCK" 2>/dev/null || true
  setsid env VITA_HOST_PROXY_SOCK="$HOST_PROXY_SOCK" VITA_FILES_ROOT=/var/lib/vita/files \
    VITA_HOST_PROXY_LOG=/run/vita-host-proxy.log \
    "$DENO" run --allow-read --allow-write --allow-env "$HOST_PROXY" >/run/vita-host-proxy.boot 2>&1 &
  # Wait (bounded) for the socket so the first host call from CEF connects rather than failing.
  hp=0; while [ "$hp" -lt 50 ]; do [ -S "$HOST_PROXY_SOCK" ] && break; sleep 0.1; hp=$((hp+1)); done
  emit_line "$MARKER: host-proxy sock=$([ -S "$HOST_PROXY_SOCK" ] && echo up || echo down) files-root=/var/lib/vita/files"
else
  emit_line "$MARKER: host-proxy=absent (desktop boots; host actions fail-closed)"
fi

# --- OPTIONAL input self-test (verification only; VITA_CEF_INPUT_SELFTEST=1) ------------------
# Creates a virtual uinput pointer BEFORE the compositor starts (so libinput enumerates it on the
# real vmwgfx/KMS at boot — no GPU-master race), then injects a scripted motion+click AFTER the
# first present. Proves the full PSD-055 loop (libinput -> route -> reverse FIFO -> CEF SendEvent +
# visible cursor) end-to-end on the real GPU. OFF by default; not part of normal boot.
INJ_FD=""
# Gate: env var OR the kernel cmdline token vita.input_selftest=1 (set in the verification vmx).
selftest=0
[ "${VITA_CEF_INPUT_SELFTEST:-0}" = "1" ] && selftest=1
grep -qw "vita.input_selftest=1" /proc/cmdline 2>/dev/null && selftest=1
if [ "$selftest" = "1" ] && [ -x /usr/lib/vita/deno ] && [ -e "$CEF_DIR/uinput-inject.ts" ]; then
  before=$(ls /dev/input/event* 2>/dev/null | wc -l)
  rm -f /run/vita-inj.cmd; mkfifo /run/vita-inj.cmd 2>/dev/null || true
  setsid bash -c "/usr/lib/vita/deno run -A $CEF_DIR/uinput-inject.ts create < /run/vita-inj.cmd > /run/vita-inj.log 2>&1" &
  exec 6<>/run/vita-inj.cmd
  INJ_FD=6
  # CRITICAL: the compositor enumerates /dev/input/event* ONCE at startup (path-based, not udev-
  # monitored). The uinput device MUST exist BEFORE the compositor starts or its events are never
  # seen. Wait (bounded) for the new event node to appear before continuing to launch the pipe.
  st=0
  while [ "$st" -lt 100 ]; do
    now=$(ls /dev/input/event* 2>/dev/null | wc -l)
    [ "$now" -gt "$before" ] && break
    sleep 0.1; st=$((st+1))
  done
  emit_line "$MARKER: input-selftest uinput_ready=$(grep -c READY /run/vita-inj.log 2>/dev/null) nodes=${before}->$(ls /dev/input/event* 2>/dev/null | wc -l)"
fi

# The compositor side: --input-out opens the FIFO for WRITE (routed input -> osr_host).
# The producer side: emit the prelude FIRST (instant desktop), then exec osr_host live-streaming
# the flagship and reading the input FIFO (--input-in). exec replaces the subshell so the pipe
# stays a single long-lived producer.
(
  # Close the inherited FIFO-holder fd 3 so osr_host does NOT inherit it — osr_host must be the
  # SOLE reader of the input FIFO (via --input-in); inheriting the script's read-write holder gave
  # the process a second FIFO fd that interfered with its reader so routed events never reached CEF.
  exec 3>&-
  cat "$PRELUDE"
  LD_LIBRARY_PATH="$CEF_DIR" exec "$OSR" --url="$URL" --compositor-out=- \
    --frames="$FRAMES" --frame-interval-ms="$INTERVAL_MS" $PREARM --input-in="$INPUT_FIFO" \
    --host-proxy-sock="$HOST_PROXY_SOCK"
) 2>"$CEF_LOG" \
  | { exec 3>&-; LD_LIBRARY_PATH=/usr/lib/x86_64-linux-gnu \
      "$COMPOSITOR" --commands --continuous --input-out="$INPUT_FIFO" > "$COMP_OUT" 2>&1; } &
PIPE_PGID=$!

# Wait (bounded) for the compositor's FIRST OK marker. With the baked snapshot this is the INSTANT
# desktop present (seconds), not the CEF cold start — that is the whole point of the fast path.
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

while IFS= read -r line; do
  case "$line" in
    VITA-COMPOSITOR:*) emit_line "$line" ;;
  esac
done < "$COMP_OUT"

if [ "$seen_ok" -eq 1 ]; then
  present=$(grep -m1 "^VITA-COMPOSITOR:" "$COMP_OUT" | sed -n 's/.*present=\([^ ]*\).*/\1/p')
  input_state=$(grep -aoE "input=[a-z]+" "$COMP_OUT" | head -1)
  # HONEST marker: input=available means libinput opened the devices; the loop is WIRED. We do NOT
  # claim interactive until the self-test below confirms CEF actually received events.
  emit_line "$MARKER: sink=buffer-surface present=${present:-unknown} ${input_state} status=OK persistent=yes loading-screen=$have_loading input-wiring=on"

  # LIVE-SWAP PROOF: confirm CEF keeps feeding updateBufferSurface AFTER the snapshot (i.e. the
  # screen is the LIVE render, not the static baked frame). CEF cold-starts after the instant
  # snapshot, so wait for its first live frame, then confirm the count keeps RISING.
  f1=0
  w=0
  while [ "$w" -lt 30 ]; do
    f1=$(grep -ac "emitted compositor frame" "$CEF_LOG" 2>/dev/null)
    [ "$f1" -gt 0 ] && break
    sleep 1; w=$((w+1))
  done
  sleep 3
  f2=$(grep -ac "emitted compositor frame" "$CEF_LOG" 2>/dev/null)
  if [ "$f2" -gt "$f1" ] && [ "$f1" -gt 0 ]; then
    emit_line "$MARKER: live-swap=CONFIRMED cef-frames ${f1}->${f2} rising (LIVE render, not the static snapshot)"
  else
    emit_line "$MARKER: live-swap=UNCONFIRMED cef-frames ${f1}->${f2} (may be the static snapshot)"
  fi

  # OPTIONAL input self-test (verification only): inject an ABSOLUTE move to a known on-screen
  # target + a click, then report how many events CEF actually received. The self-test device is
  # an absolute pointer like the real VMware mouse, so it exercises the exact fixed code path.
  if [ -n "$INJ_FD" ]; then
    sleep 1
    # Target the command-palette "Run kernel.ts" row (~430,150 in 1280x720) so a click visibly opens
    # / activates it on the live desktop. Move in a few steps so the cursor visibly travels there.
    for xy in "200 360" "300 280" "380 200" "430 150"; do echo "moveto $xy" >&6 2>/dev/null; sleep 0.2; done
    sleep 0.5; echo "click" >&6 2>/dev/null; sleep 0.5
    echo "moveto 430 150" >&6 2>/dev/null; sleep 1.5
    sends=$(grep -acE "input: SendMouse" "$CEF_LOG" 2>/dev/null)
    clicks=$(grep -acE "input: SendMouseClick" "$CEF_LOG" 2>/dev/null)
    lastmove=$(grep -aE "input: SendMouse" "$CEF_LOG" 2>/dev/null | tail -1 | sed 's/.*input:/input:/')
    if [ "$sends" -gt 0 ]; then
      emit_line "$MARKER: interactive=CONFIRMED input-selftest SendMouse=$sends clicks=$clicks $lastmove"
    else
      emit_line "$MARKER: interactive=FAILED input-selftest SendMouse=0 (events not reaching CEF) $lastmove"
    fi
  fi
else
  cef_tail=$(grep -aE "OnPaint #|emitted compositor|stream:|ERROR|CefInitialize|load error|input:" "$CEF_LOG" 2>/dev/null | tail -3 | tr '\n' '|')
  emit_line "$MARKER: cef_diag=${cef_tail:-none}"
  emit_failsafe "no_present_within_90s"
  kill "$PIPE_PGID" 2>/dev/null || true
  wait "$PIPE_PGID" 2>/dev/null || true
  exit 1
fi

# Hold the service in the foreground for the life of the pipe (KMS master + per-frame present +
# input). On pipe break, exit non-zero so Restart=on-failure rebuilds the live desktop.
wait "$PIPE_PGID"
rc=$?
emit_line "$MARKER: persistent pipe ended rc=$rc"
[ "$rc" -eq 0 ] && exit 0 || exit "$rc"
