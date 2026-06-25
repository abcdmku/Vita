#!/usr/bin/env bash
# Run the CEF OSR host headless and produce out/cef-m0.png (+ mirror to the
# Windows-visible path). Expects `ninja -C build` to have produced the binary.
set -euo pipefail

SPIKE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REL="${SPIKE_DIR}/build/Release"
OUT="${SPIKE_DIR}/out"
PNG="${OUT}/cef-m0.png"
WIN_DST="/mnt/c/Users/Borg/vita-vmware/cef-m0.png"
URL="${1:-file:///home/borg/Vita/ui_kits/desktop/index.html}"

mkdir -p "${OUT}"

if [[ ! -x "${REL}/vita_cef_osr" ]]; then
  # cmake places the binary in build/; copy it next to the CEF runtime files.
  cp "${SPIKE_DIR}/build/vita_cef_osr" "${REL}/vita_cef_osr"
fi

cd "${REL}"
echo "Running OSR host (headless, software) ..."
./vita_cef_osr --url="${URL}" --out="${PNG}"

if [[ -d "$(dirname "${WIN_DST}")" ]]; then
  cp "${PNG}" "${WIN_DST}"
  echo "Mirrored PNG to ${WIN_DST}"
fi
echo "PNG: ${PNG}"
