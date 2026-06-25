#!/usr/bin/env bash
# M1 driver: prove CEF's rendered frame flows INTO the Vita native compositor.
#
#   CEF (osr_host --compositor-out) --> command stream --> vita-compositor --commands
#       --> glReadPixels readback --> /run/cef-m1.png (produced BY the compositor)
#
# CEF renders the flagship desktop off-screen (software OSR), emits the compositor
# command stream for the captured frame (registerBufferSurface + updatePlacement +
# present), and that stream is piped into the compositor binary, which composites the
# buffer surface and reads it back to a PNG. The COMPOSITOR produces the readback.
#
# Emits on success: VITA-CEF: sink=buffer-surface present=ok status=OK
set -euo pipefail

SPIKE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "${SPIKE_DIR}/../.." && pwd)"
REL="${SPIKE_DIR}/build/Release"
OUT="${SPIKE_DIR}/out"
STREAM="${OUT}/cef-m1.commands"
PNG="${1:-/run/cef-m1.png}"
WIN_DST="/mnt/c/Users/Borg/vita-vmware/cef-m1.png"
URL="${2:-file:///home/borg/Vita/ui_kits/desktop/index.html}"
COMPOSITOR="${REPO}/os/x86_64/smoke-overlay/usr/lib/vita/compositor/vita-compositor"

mkdir -p "${OUT}"

if [[ ! -x "${REL}/vita_cef_osr" ]]; then
  cp "${SPIKE_DIR}/build/vita_cef_osr" "${REL}/vita_cef_osr"
fi
if [[ ! -x "${COMPOSITOR}" ]]; then
  echo "ERROR: compositor binary not found at ${COMPOSITOR}" >&2
  echo "  build it: node tools/build/rust-in-docker.mjs --dir packages/compositor-core \\" >&2
  echo "    --out os/x86_64/smoke-overlay/usr/lib/vita/compositor/vita-compositor" >&2
  exit 1
fi

cd "${REL}"

# 1. CEF renders off-screen and emits the compositor command stream for the frame.
echo "[m1] CEF: render flagship off-screen -> compositor command stream ..." >&2
./vita_cef_osr --url="${URL}" --compositor-out="${STREAM}"
echo "[m1] stream: ${STREAM} ($(wc -c < "${STREAM}") bytes, $(wc -l < "${STREAM}") lines)" >&2

# 2. Feed the stream into the compositor; the COMPOSITOR does the readback PNG.
echo "[m1] compositor: ingest stream, composite, readback -> ${PNG} ..." >&2
COMP_MARKER="$("${COMPOSITOR}" --commands --hold-seconds 0 --screenshot "${PNG}" < "${STREAM}")"
echo "${COMP_MARKER}"

# 3. Mirror the readback to the Windows-visible path.
if [[ -f "${PNG}" && -d "$(dirname "${WIN_DST}")" ]]; then
  cp "${PNG}" "${WIN_DST}"
  echo "[m1] mirrored readback PNG -> ${WIN_DST}" >&2
fi

# 4. Gate on a real composited PNG produced by the compositor.
if [[ ! -s "${PNG}" ]]; then
  echo "[m1] ERROR: compositor produced no readback PNG at ${PNG}" >&2
  exit 1
fi
case "${COMP_MARKER}" in
  *status=OK*) printf 'VITA-CEF: sink=buffer-surface present=ok status=OK\n' ;;
  *)           echo "[m1] ERROR: compositor marker not OK: ${COMP_MARKER}" >&2; exit 1 ;;
esac
