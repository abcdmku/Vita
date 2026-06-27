#!/bin/bash
# Vita owner-token ROTATION — regenerate the network-face owner bearer secret WITHOUT a full reboot.
#
# FLOW (no reboot, minimal session break):
#   1. mint a NEW token over the persisted /var copy (vita-owner-token.sh --rotate, atomic replace).
#   2. `systemctl restart vita-platform.service` — NOT a reboot. The platform unit re-execs server-entry.ts,
#      which re-reads VITA_OWNER_TOKEN_FILE and rebuilds the network-face owner gate with the NEW secret.
#      Restart is Type=notify with RestartSec=2s, so the faces are back in ~2s. The persistent apps store
#      on /var (and the LOCAL kiosk face's trust-on-host session) are untouched — only the network face's
#      bearer changes. The OLD token stops authenticating the instant the new process binds.
#   3. publish the new token to /run/vita/owner-token (the platform unit already does this on every start,
#      0640 for the owner/probe to read out-of-band) and echo the path so the owner can re-log in.
#
# WHY restart and not a live SIGHUP reload: the owner gate captures the token at face-construction time
# (backend.ts::ownerTokenFaceGate closes over the token). A clean restart is the simplest correct way to
# adopt a new secret with ZERO code in the hot path and no risk of a half-rotated gate. A full REBOOT is
# NOT needed (the rotate touches only /var data + one service), which is the task's "without a full
# reboot/session break where possible" — the only break is the ~2s network-face reconnect; local + data
# survive. (If even that 2s is unacceptable, a future SIGHUP live-swap can re-read the file in place; the
# token-on-/var mechanism here already supports that — the gate would just need a provider indirection.)
#
# Invoke on-device: `systemctl start vita-owner-token-rotate.service` (or run this script as root).
set -u

MARKER=VITA-OWNER-TOKEN-ROTATE
TTY=/dev/ttyS0
# VITA_MINT_SCRIPT/VITA_OWNER_DIR exist for the offline harness only (override the mint script path +
# the persisted-token dir); on-device the unit sets neither, so the defaults are authoritative.
MINT="${VITA_MINT_SCRIPT:-/usr/lib/vita/owner-token/vita-owner-token.sh}"
OWNER_DIR="${VITA_OWNER_DIR:-/var/lib/vita/owner}"
TOKEN_FILE="${OWNER_DIR}/owner.token"
PLATFORM_UNIT=vita-platform.service

emit() {
  printf '%s\n' "$1"
  if [ -w "$TTY" ]; then printf '%s\n' "$1" > "$TTY" 2>/dev/null || true; fi
}

# 1. regenerate the persisted token (force).
if ! "$MINT" --rotate; then
  emit "$MARKER: FATAL could not regenerate the owner token — leaving the current token in place"
  exit 1
fi

# 2. restart the platform unit so the new token takes effect (no reboot). Skip gracefully if systemctl
#    is unavailable (e.g. a non-systemd harness) — the new token is already on /var and the NEXT start
#    adopts it.
if command -v systemctl >/dev/null 2>&1; then
  if systemctl restart "$PLATFORM_UNIT"; then
    emit "$MARKER: restarted ${PLATFORM_UNIT} — the network face now requires the NEW owner token"
  else
    emit "$MARKER: WARN could not restart ${PLATFORM_UNIT}; the new token is persisted and will apply on the next start"
  fi
else
  emit "$MARKER: systemctl absent — new token persisted at ${TOKEN_FILE}; it applies on the next platform start"
fi

# 3. point the owner at the freshly-published token (the platform unit writes /run/vita/owner-token on
#    start; fall back to the durable /var copy if /run is not yet repopulated).
if [ -s /run/vita/owner-token ]; then
  emit "$MARKER: new owner token published at /run/vita/owner-token (read it out-of-band to re-log in)"
else
  emit "$MARKER: new owner token persisted at ${TOKEN_FILE} (read it out-of-band to re-log in)"
fi
exit 0
