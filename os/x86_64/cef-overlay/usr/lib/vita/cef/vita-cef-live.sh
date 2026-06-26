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
# PSD-502 PRODUCTION ORIGIN: boot the desktop over the REAL secure custom scheme vita://desktop
# (registered by osr_host: STANDARD+SECURE+CORS+FETCH) instead of file://. Under a true secure
# origin the ES-module bundle loads same-origin and the native binder hydrates WITH web security
# ENABLED (no --disable-web-security). The scheme authorities are rooted at the ui_kits tree and
# the offline browser content; index lives at desktop/index.html under the desktop authority.
SCHEME_ROOT=/usr/lib/vita/ui_kits
BROWSER_ROOT=/usr/lib/vita/ui_kits/browser
URL=vita://desktop/desktop/index.html
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

# --- PSD-500: detect the REAL display resolution -----------------------------
# Read the primary DRM/KMS connector's PREFERRED mode (the VMware virtual display size, e.g.
# 1920x1080) so the desktop renders full-size instead of a hardcoded 1280x720 corner. The
# compositor independently reads the SAME connector mode (query_default_output_mode); we read it
# here too so the upstream CEF view + buffer surface match. Source: /sys/class/drm/<conn>/modes
# (first non-empty line = current/preferred mode). Fall back to 1280x720 if it cannot be read.
DISP_W=1280
DISP_H=720
for mp in /sys/class/drm/card0-*/modes; do
  [ -r "$mp" ] || continue
  # The connected connector's modes file is non-empty; its first line is the preferred mode.
  first=$(grep -aoE '^[0-9]{3,5}x[0-9]{3,5}' "$mp" 2>/dev/null | head -1)
  if [ -n "$first" ]; then
    w=${first%x*}; h=${first#*x}
    if [ "$w" -ge 320 ] && [ "$h" -ge 240 ] && [ "$w" -le 16384 ] && [ "$h" -le 16384 ]; then
      DISP_W=$w; DISP_H=$h
      break
    fi
  fi
done
# CEF view height: render the flagship at the real height so 1:1 vertical mapping (no upscaling).
# View width == output width (the vertical box-filter downscale preserves width). The historical
# build rendered a slightly TALLER CEF view (800 vs 720 output) for the dock strip; keep that ratio
# by rendering the view at the output height (the desktop CSS is responsive to the viewport).
VIEW_W=$DISP_W
VIEW_H=$DISP_H
emit_line "$MARKER: display-mode=${DISP_W}x${DISP_H} view=${VIEW_W}x${VIEW_H} source=drm-connector"

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
  # PSD-500: the committed loading surface is registered at 1280x720; STRETCH its placement to fill
  # the REAL output so the honest loading screen covers the whole display (the compositor scales the
  # texture to the placement rect). Last placement for a surface wins, so this overrides the baked
  # 0 0 1280 720 line. It is visible only until CEF's first full-size frame covers it.
  printf 'updatePlacement vita:loading 0 0 %s %s 0 true\n' "$DISP_W" "$DISP_H" >> "$PRELUDE"
fi
if [ -s "$CURSOR" ]; then
  cat "$CURSOR" >> "$PRELUDE"
  # PSD-500: re-center the 24x24 cursor on the REAL output (keeps it on-screen + seeds the
  # compositor's cursor_pos at the center). z=1000 keeps it top-most above the live desktop (z=10).
  printf 'updatePlacement cursor:pointer %s %s 24 24 1000 true\n' "$((DISP_W/2))" "$((DISP_H/2))" >> "$PRELUDE"
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
  # Seed a REAL file so the host-bridge self-test (and a Files click) shows real content. This is a
  # genuine on-disk file the proxy reads via the real filesystem — not a mock.
  [ -e /var/lib/vita/files/proof.txt ] || \
    printf 'VITA-REAL-FILE-PROOF: this file is on /var/lib/vita/files and was read live via the host bridge\n' \
      > /var/lib/vita/files/proof.txt 2>/dev/null || true
  # PSD-501: seed REAL on-disk content for Mail + Editor under the files root so the same proven
  # requestFile backend serves them as live windows (honest empty state if a user clears them).
  mkdir -p /var/lib/vita/files/mail /var/lib/vita/files/editor 2>/dev/null || true
  [ -e /var/lib/vita/files/mail/welcome.eml ] || \
    printf 'From: vita@localhost\nSubject: Welcome to Vita Mail\n\nThis mailbox is the REAL /var/lib/vita/files/mail directory, read live via the host bridge.\n' \
      > /var/lib/vita/files/mail/welcome.eml 2>/dev/null || true
  [ -e /var/lib/vita/files/editor/kernel.ts ] || \
    printf 'export async function main() {\n  const sys = await vita.boot("kernel.ts");\n  return sys; // REAL file from the editor VFS, read via the host bridge\n}\n' \
      > /var/lib/vita/files/editor/kernel.ts 2>/dev/null || true
  rm -f "$HOST_PROXY_SOCK" 2>/dev/null || true
  # Run with -A: the proxy is the TRUSTED platform-side component (it reads /proc for real Activity
  # stats, which Deno's read model gates behind all-access, and writes the persistent settings store).
  # Capability enforcement is done INSIDE the proxy (METHOD_CAPABILITY + GRANTED), not via Deno flags.
  setsid env VITA_HOST_PROXY_SOCK="$HOST_PROXY_SOCK" VITA_FILES_ROOT=/var/lib/vita/files \
    VITA_STATE_ROOT=/var/lib/vita VITA_HOST_PROXY_LOG=/run/vita-host-proxy.log \
    "$DENO" run -A "$HOST_PROXY" >/run/vita-host-proxy.boot 2>&1 &
  # Wait (bounded) for the socket so the first host call from CEF connects rather than failing.
  hp=0; while [ "$hp" -lt 50 ]; do [ -S "$HOST_PROXY_SOCK" ] && break; sleep 0.1; hp=$((hp+1)); done
  emit_line "$MARKER: host-proxy sock=$([ -S "$HOST_PROXY_SOCK" ] && echo up || echo down) files-root=/var/lib/vita/files settings=/var/lib/vita/settings.json"
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
  # PSD-500: pass the REAL output resolution so the injector's absolute device range maps 1:1 to
  # compositor-output pixels (moveto X Y is then in output space at any display size).
  setsid bash -c "/usr/lib/vita/deno run -A $CEF_DIR/uinput-inject.ts create $DISP_W $DISP_H < /run/vita-inj.cmd > /run/vita-inj.log 2>&1" &
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
  # PSD-500: render at the REAL display resolution (--view-* / --comp-* from the DRM connector mode)
  # so the live desktop fills the screen, and interleave cheap cursor-only presents
  # (--cursor-presents-per-frame) so the cursor tracks at ~60fps without a CEF repaint per move.
  LD_LIBRARY_PATH="$CEF_DIR" exec "$OSR" --url="$URL" --compositor-out=- \
    --scheme-root="$SCHEME_ROOT" --browser-root="$BROWSER_ROOT" \
    --frames="$FRAMES" --frame-interval-ms="$INTERVAL_MS" $PREARM --input-in="$INPUT_FIFO" \
    --host-proxy-sock="$HOST_PROXY_SOCK" \
    --view-width="$VIEW_W" --view-height="$VIEW_H" \
    --comp-width="$DISP_W" --comp-height="$DISP_H" \
    --cursor-presents-per-frame="${VITA_CEF_CURSOR_PRESENTS:-6}"
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

  # PSD-501 VERIFICATION DRIVER (input injection on the REAL GPU): click actual DOCK TILES so a
  # real injected pointer click drives the desktop's NATIVE binder -> host.launchApp -> the app
  # window renders REAL data via the host bridge. Coords come from osr_host's VITA-DOCK markers
  # (CEF view space, 1280x800); the injector uses compositor space (1280x720), so y is scaled by
  # 720/800. Scenario selects which tile(s) to click (so persistence can be proven across reboots).
  if [ -n "$INJ_FD" ]; then
    sleep 1
    # Scenario priority: env > persistent /var file (set by a prior boot) > kernel cmdline > default.
    VERIFY="${VITA_VERIFY:-}"
    if [ -z "$VERIFY" ] && [ -s /var/lib/vita/verify.scenario ]; then
      VERIFY="$(cat /var/lib/vita/verify.scenario 2>/dev/null)"
    fi
    if [ -z "$VERIFY" ]; then
      VERIFY="$(grep -aoE 'vita.verify=[a-z-]+' /proc/cmdline 2>/dev/null | head -1 | sed 's/.*=//')"
    fi
    [ -z "$VERIFY" ] && VERIFY="activity"
    emit_line "$MARKER: verify-scenario=$VERIFY persisted-settings=$(cat /var/lib/vita/settings.json 2>/dev/null | tr -d '\n' | head -c 200)"

    # tile_cxcy <app-id> -> echoes "CX CY_comp" (CY scaled from CEF VIEW height to OUTPUT height).
    # PSD-500: view==output now (both = the real display mode), so the ratio is normally 1; the
    # general form keeps it correct if the view height ever differs from the output height.
    tile_cxcy() {
      local id="$1" line cx cy
      line=$(grep -aE "VITA-DOCK tile $id " "$CEF_LOG" 2>/dev/null | tail -1)
      cx=$(printf '%s' "$line" | sed -n 's/.* cx=\([0-9]*\).*/\1/p')
      cy=$(printf '%s' "$line" | sed -n 's/.* cy=\([0-9]*\).*/\1/p')
      [ -z "$cx" ] && return 1
      cy=$(( cy * DISP_H / VIEW_H ))
      printf '%s %s' "$cx" "$cy"
    }
    move_click() {  # move in steps to <cx> <cy_comp>, then click (start from screen center)
      local tx="$1" ty="$2" sx=$(( DISP_W / 2 )) sy=$(( DISP_H / 2 ))
      for f in 25 50 75 100; do
        local mx=$(( sx + (tx - sx) * f / 100 )) my=$(( sy + (ty - sy) * f / 100 ))
        echo "moveto $mx $my" >&6 2>/dev/null; sleep 0.15
      done
      sleep 0.3; echo "click" >&6 2>/dev/null; sleep 0.6
    }

    case "$VERIFY" in
      settings-toggle)
        xy=$(tile_cxcy vita.app.settings) && move_click $xy && \
          emit_line "$MARKER: verify clicked Settings tile @ $xy"
        sleep 1.2
        # The Settings window's 'light' theme option sits near the top-left of the window
        # (window at left:140 top:96 in CEF view; the option row ~y=150, 'light' is the 2nd chip).
        # Click it to call the REAL applySetting (persist theme=light to /var).
        # Target the 'light' theme chip. Prefer the rect the window logged (VITA-CHIP, CEF view
        # space -> compositor y *720/800); fall back to the computed position.
        chip=$(grep -aE "VITA-CHIP light " "$CEF_LOG" 2>/dev/null | tail -1)
        olx=$(printf '%s' "$chip" | sed -n 's/.* cx=\([0-9]*\).*/\1/p')
        ocy=$(printf '%s' "$chip" | sed -n 's/.* cy=\([0-9]*\).*/\1/p')
        if [ -n "$olx" ] && [ -n "$ocy" ]; then oly=$(( ocy * DISP_H / VIEW_H )); else olx=180; oly=$(( 170 * DISP_H / VIEW_H )); fi
        move_click $olx $oly && emit_line "$MARKER: verify clicked theme option @ $olx $oly (applySetting light)"
        sleep 1.5
        mkdir -p /var/lib/vita 2>/dev/null || true
        echo settings-read > /var/lib/vita/verify.scenario 2>/dev/null || true
        ;;
      settings-read)
        xy=$(tile_cxcy vita.app.settings) && move_click $xy && \
          emit_line "$MARKER: verify clicked Settings tile @ $xy (read persisted)"
        sleep 1.5
        ;;
      browser)
        # FEATURE 1 verify: click the Browser dock tile -> the desktop binder launches the Browser
        # app, whose window renders a REAL local web surface (an <iframe> loading vita://browser/).
        xy=$(tile_cxcy vita.app.browser) && move_click $xy && \
          emit_line "$MARKER: verify clicked Browser tile @ $xy"
        sleep 2.0
        ;;
      browser-activity)
        # MERGE COMBINED VERIFY (vm-ux-merge): prove BOTH features in ONE boot. First click the
        # Browser dock tile -> the REAL local web surface over vita://browser, hold it on screen for an
        # external capture (marker: capture=browser-ready), then click the Activity dock tile -> the
        # REAL /proc stats window (with the settle-and-retry so it is never the empty state), and hold
        # again (marker: capture=activity-ready). The full-resolution desktop + smooth cursor are proven
        # by the move_click sweeps and the display-mode marker regardless of scenario.
        bxy=$(tile_cxcy vita.app.browser) && move_click $bxy && \
          emit_line "$MARKER: verify clicked Browser tile @ $bxy"
        sleep 1.5
        emit_line "$MARKER: capture=browser-ready (vita://browser web surface on screen)"
        sleep 4
        axy=$(tile_cxcy vita.app.activity) && move_click $axy && \
          emit_line "$MARKER: verify clicked Activity tile @ $axy"
        sleep 2.0
        emit_line "$MARKER: capture=activity-ready (live /proc stats on screen)"
        sleep 4
        ;;
      activity|*)
        xy=$(tile_cxcy vita.app.activity) && move_click $xy && \
          emit_line "$MARKER: verify clicked Activity tile @ $xy"
        sleep 1.5
        ;;
    esac

    # --- HONEST interactivity verdict (cef-selftest-false-verdicts) -----------------------------
    # The OLD verdict declared CONFIRMED on SendMouse>0 ALONE — a false POSITIVE that masked the
    # scrim bug (events reached CEF but no window opened because an inert scrim ate the DOM click).
    # The HONEST proof that a click drove the desktop is a NATIVE APP WINDOW that exists AFTER the
    # click. Require ALL of:
    #   (a) SendMouse>0            — injected events actually reached CEF (loop wired end-to-end), AND
    #   (b) app-window=present on a probe taken AFTER the action — either osr_host's recurring
    #       `VITA-NATIVE app-window=present probe=post-action` re-probe, OR the desktop's own
    #       `VITA-INDEX launchOrFocusDock <id> ... appWindow=true` launch signal, AND
    #   (c) the VMware GPU path (input=available). The surfaceless QEMU `-nographic` path reports
    #       input=unavailable and can NEVER prove interactivity — there we report UNVERIFIED, not
    #       CONFIRMED, so a headless boot cannot mint a false positive.
    sends=$(grep -acE "input: SendMouse" "$CEF_LOG" 2>/dev/null)
    clicks=$(grep -acE "input: SendMouseClick" "$CEF_LOG" 2>/dev/null)
    # POST-ACTION app-window probe: only probe=post-action lines count (the probe=on-load one-shot
    # fires ~1.8s after load, BEFORE the clicks, and must NOT satisfy the verdict). tail -1 = latest.
    appwin=$(grep -aE "VITA-NATIVE app-window=.* probe=post-action" "$CEF_LOG" 2>/dev/null | tail -1 | sed -n 's/.*app-window=\([a-z]*\).*/\1/p')
    # The desktop's OWN launch signal: a real dock click that reached launchOrFocusDock and had a
    # window host bound (appWindow=true). Independent corroboration of (b) from the renderer side.
    launchsig=$(grep -acE "VITA-INDEX launchOrFocusDock .* appWindow=true" "$CEF_LOG" 2>/dev/null)
    gpu_path=0
    [ "$input_state" = "input=available" ] && gpu_path=1
    win_after=0
    { [ "$appwin" = "present" ] || [ "${launchsig:-0}" -gt 0 ]; } && win_after=1

    if [ "$gpu_path" -ne 1 ]; then
      # Surfaceless/headless path: input is unavailable; we cannot honestly prove interactivity here.
      emit_line "$MARKER: interactive=UNVERIFIED ${input_state} (surfaceless path: cannot prove interactivity; SendMouse=$sends app-window=${appwin:-none} launch-signal=$launchsig)"
    elif [ "$sends" -gt 0 ] && [ "$win_after" -eq 1 ]; then
      emit_line "$MARKER: interactive=CONFIRMED app-window=present (probed AFTER action) SendMouse=$sends clicks=$clicks app-window-after=${appwin:-via-launch-signal} launch-signal=$launchsig path=vmware-gpu"
    elif [ "$sends" -gt 0 ]; then
      # Events reached CEF but NO native window opened after the click — this is exactly the scrim
      # regression the old SendMouse>0 check masked. Report FAILED, not CONFIRMED.
      emit_line "$MARKER: interactive=FAILED no-app-window-after-click SendMouse=$sends clicks=$clicks app-window-after=${appwin:-absent} launch-signal=$launchsig (click reached CEF but opened no window — possible inert scrim/hit-test regression)"
    else
      emit_line "$MARKER: interactive=FAILED input-selftest SendMouse=0 (events not reaching CEF)"
    fi
    # Keep the final state on screen long enough for an external screenshot.
    sleep 4
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
