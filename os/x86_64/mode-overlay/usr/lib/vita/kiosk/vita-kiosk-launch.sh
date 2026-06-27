#!/bin/bash
# Vita LOCAL DESKTOP kiosk launcher — cage (Wayland kiosk compositor) + chromium --kiosk.
#
# Standard packages only (no bespoke compositor): `cage` owns the KMS display and runs ONE client
# fullscreen; that client is `chromium --kiosk` pointed at the platform server's LOCAL face. cage
# exits when chromium exits, which surfaces a crash to systemd (Restart=on-failure rebuilds it).
#
# Readiness gate: poll the loopback local face until it answers (or a bounded timeout) BEFORE handing
# the URL to chromium, so the user never sees a connection-refused page while the server warms up.
set -u

MARKER=VITA-KIOSK
TTY=/dev/ttyS0
PORT="${VITA_PLATFORM_PORT:-7681}"
URL="${VITA_KIOSK_URL:-http://127.0.0.1:${PORT}/}"
RUNTIME="${XDG_RUNTIME_DIR:-/run/vita-kiosk}"

emit() {
  printf '%s\n' "$1"
  if [ -w "$TTY" ]; then printf '%s\n' "$1" > "$TTY" 2>/dev/null || true; fi
}

# --- preconditions -----------------------------------------------------------
command -v cage >/dev/null 2>&1     || { emit "$MARKER: FAILSAFE cage missing"; exit 1; }
command -v chromium >/dev/null 2>&1 || { emit "$MARKER: FAILSAFE chromium missing"; exit 1; }
mkdir -p "$RUNTIME" 2>/dev/null || true
chmod 0700 "$RUNTIME" 2>/dev/null || true

# --- readiness gate: wait for the local face -----------------------------------
# Bounded poll. Uses bash /dev/tcp (no extra tooling) to probe the loopback port. On timeout we still
# launch (chromium will retry / show its own error), but we log the miss so a boot review can see it.
ready=0
for _ in $(seq 1 60); do
  if (exec 3<>"/dev/tcp/127.0.0.1/${PORT}") 2>/dev/null; then exec 3>&- 3<&-; ready=1; break; fi
  sleep 0.5
done
if [ "$ready" = 1 ]; then
  emit "$MARKER: local face ready on 127.0.0.1:${PORT}, launching cage + chromium --kiosk"
else
  emit "$MARKER: local face not ready after timeout — launching anyway (chromium will retry) url=${URL}"
fi

# --- chromium flags ----------------------------------------------------------
# Kiosk + Wayland/Ozone (cage is a Wayland compositor). Stable, offline, single-profile flags.
CHROMIUM_FLAGS=(
  --kiosk
  --ozone-platform=wayland
  --no-first-run
  --disable-translate
  --disable-pinch
  --overscroll-history-navigation=0
  --noerrdialogs
  --disable-infobars
  --check-for-update-interval=31536000
  --user-data-dir="${RUNTIME}/chromium"
)
# chromium's setuid/userns sandbox often cannot initialize in a minimal VM/container kernel; fall back
# to --no-sandbox when the namespace setup is unavailable. The kiosk runs trusted local content only.
if [ ! -e /proc/sys/kernel/unprivileged_userns_clone ] && [ ! -u /usr/lib/chromium/chrome-sandbox ] 2>/dev/null; then
  CHROMIUM_FLAGS+=(--no-sandbox)
  emit "$MARKER: chromium sandbox unavailable in this kernel — using --no-sandbox (trusted local content)"
fi

emit "$MARKER: cage -d -- chromium ${URL}"
# cage: -d keeps it in the foreground (so systemd tracks it). It launches chromium fullscreen and
# exits when chromium exits. `exec` so signals/exit codes flow straight to systemd.
exec cage -d -- chromium "${CHROMIUM_FLAGS[@]}" "${URL}"
