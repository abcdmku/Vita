#!/bin/bash
# Vita platform server launcher — PLACEHOLDER (three-mode OS).
#
# TODO(integration): replace this whole script with the REAL platform server binary launch. This
# placeholder exists so the image, units, mode mechanism, and ordering can be built + validated
# BEFORE the server binary lands (it is built in parallel — see the task's SERVER INTERFACE and
# architecture/puter-compat-layer.md). The real launcher must honor the same env contract:
#   VITA_MODE           headless | desktop | network   (which faces to expose)
#   VITA_PLATFORM_PORT  local-face loopback port        (default 7681)
#   VITA_APPS_ROOT      persisted fs+kv store           (/var/lib/vita/apps)
# and serve the LOCAL face on http://127.0.0.1:${VITA_PLATFORM_PORT} (+ the TLS NETWORK face on the
# routable NIC when VITA_MODE is desktop or network). Until then this placeholder serves a trivial
# health endpoint on the loopback port so the kiosk readiness gate + mode wiring can be exercised.
set -u

MARKER=VITA-PLATFORM
TTY=/dev/ttyS0
PORT="${VITA_PLATFORM_PORT:-7681}"
MODE="${VITA_MODE:-headless}"
APPS_ROOT="${VITA_APPS_ROOT:-/var/lib/vita/apps}"

emit() {
  printf '%s\n' "$1"
  if [ -w "$TTY" ]; then printf '%s\n' "$1" > "$TTY" 2>/dev/null || true; fi
}

emit "$MARKER: PLACEHOLDER server starting mode=${MODE} local=http://127.0.0.1:${PORT} apps_root=${APPS_ROOT}"
emit "$MARKER: TODO wire the real Puter-compatible platform binary (network/TLS face served by it when mode permits)"

# Minimal loopback health responder so vita-kiosk's readiness probe (and a same-machine browser) get
# a real answer on the local face. Pure-bash TCP via /dev/tcp is NOT a listener, so use a tiny socat/
# nc loop when available; otherwise block so Restart= semantics are still exercised. The REAL server
# replaces all of this.
respond() {
  printf 'HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nConnection: close\r\n\r\nvita-platform placeholder mode=%s\r\n' "$MODE"
}

if command -v socat >/dev/null 2>&1; then
  emit "$MARKER: placeholder health face up on 127.0.0.1:${PORT} (socat)"
  exec socat TCP-LISTEN:"${PORT}",bind=127.0.0.1,reuseaddr,fork SYSTEM:"$0 --respond"
fi

if [ "${1:-}" = "--respond" ]; then respond; exit 0; fi

# No listener tool present: stay alive (foreground) so systemd treats the unit as running. The kiosk
# readiness probe will time out and fall through (logged), which is the honest placeholder behavior.
emit "$MARKER: no socat/nc — placeholder cannot bind a port; staying up so units/ordering can be reviewed"
exec sleep infinity
