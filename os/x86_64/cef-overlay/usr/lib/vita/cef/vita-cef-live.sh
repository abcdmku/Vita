#!/bin/bash
# Vita SMOKE/VM - CEF live-render arc (ADR-0014), PERSISTENT + INSTANT + INTERACTIVE (cef-vm-input).
#
# Boot flow (one long-lived compositor process, on the real VMware GPU / KMS):
#   1. INSTANT: feed a BAKED first-frame snapshot of the flagship desktop (flagship-firstframe.commands)
#      + a visible cursor surface (cursor.commands) + present -> the REAL desktop is on screen within
#      ~2-5s of power-on (no blank wallpaper, no 60s wait, no demo blocks).
#   2. LIVE: CEF (windowless software OSR) warms in the BACKGROUND and streams the live flagship into
#      the SAME cef:desktop surface (updateBufferSurface, --surface-prearmed) -> seamless swap to the
#      interactive render. Unbounded (--frames=0) so it stays live for the life of the VM.
#   3. INTERACTIVE (PSD-055): the compositor reads libinput, routes (PSD-300), and writes routed
#      events (with absolute cursor coords) to a reverse-channel FIFO (--input-out); osr_host reads it
#      (--input-in) and injects CEF SendMouseMove/Click/Key. The compositor composites a visible
#      cursor surface that tracks the routed pointer.
#
#       ( cat snapshot+cursor ; osr_host --surface-prearmed --input-in=FIFO --frames=0 )
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
SNAPSHOT=$CEF_DIR/flagship-firstframe.commands
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

# --- instant-desktop prelude (baked snapshot + cursor) -----------------------
# Prepend the baked flagship first-frame + the cursor surface + a present so the compositor shows
# the REAL desktop immediately, BEFORE CEF finishes its cold start. The snapshot pre-registers
# cef:desktop, so osr_host runs with --surface-prearmed and seamlessly updates the same surface.
PRELUDE=/run/vita-cef-prelude.commands
: > "$PRELUDE"
have_snapshot=0
if [ -s "$SNAPSHOT" ]; then
  cat "$SNAPSHOT" >> "$PRELUDE"
  have_snapshot=1
fi
if [ -s "$CURSOR" ]; then
  cat "$CURSOR" >> "$PRELUDE"
fi
# One present to scan out the instant snapshot+cursor right away.
printf 'present\n' >> "$PRELUDE"

PREARM=""
[ "$have_snapshot" -eq 1 ] && PREARM="--surface-prearmed"

emit_line "$MARKER: stage=start mode=instant+persistent+interactive frames=$FRAMES interval=${INTERVAL_MS}ms snapshot=$have_snapshot url=$URL card0=present"

# --- run the long-lived pipe -------------------------------------------------
CEF_LOG=/run/vita-cef-osr.log
COMP_OUT=/run/vita-cef-comp.out
: > "$CEF_LOG"
: > "$COMP_OUT"

cd "$CEF_DIR" || { emit_failsafe "cef_dir_cd"; exit 0; }
set -o pipefail

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
  cat "$PRELUDE"
  LD_LIBRARY_PATH="$CEF_DIR" exec "$OSR" --url="$URL" --compositor-out=- \
    --frames="$FRAMES" --frame-interval-ms="$INTERVAL_MS" $PREARM --input-in="$INPUT_FIFO"
) 2>"$CEF_LOG" \
  | LD_LIBRARY_PATH=/usr/lib/x86_64-linux-gnu \
    "$COMPOSITOR" --commands --continuous --input-out="$INPUT_FIFO" > "$COMP_OUT" 2>&1 &
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
  emit_line "$MARKER: sink=buffer-surface present=${present:-unknown} ${input_state} status=OK persistent=yes instant=$have_snapshot interactive=yes"

  # OPTIONAL input self-test: inject a scripted gesture now that the desktop is live, then report
  # how many events CEF actually received (proof the loop works on the real GPU).
  if [ -n "$INJ_FD" ]; then
    sleep 2
    i=0; while [ "$i" -lt 110 ]; do echo "move 2 -3" >&6 2>/dev/null; i=$((i+1)); done
    sleep 1; echo "click" >&6 2>/dev/null; sleep 1; echo "move 0 0" >&6 2>/dev/null; sleep 2
    sends=$(grep -acE "input: SendMouse" "$CEF_LOG" 2>/dev/null)
    clicks=$(grep -acE "input: SendMouseClick" "$CEF_LOG" 2>/dev/null)
    lastmove=$(grep -aE "input: SendMouseMove" "$CEF_LOG" 2>/dev/null | tail -1 | sed 's/.*input:/input:/')
    emit_line "$MARKER: input-selftest SendMouse=$sends clicks=$clicks $lastmove"
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
