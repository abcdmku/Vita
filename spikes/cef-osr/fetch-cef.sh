#!/usr/bin/env bash
# Reproducibly (re)vendor the pinned CEF Linux64 minimal distribution into
# spikes/cef-osr/.vendor/. Offline-friendly: pinned version + sha1, no lockfile drift.
# The extracted ~1.5 GB tree is git-ignored; this script reconstructs it.
set -euo pipefail

VER="149.0.5+g6770623+chromium-149.0.7827.197"
FN="cef_binary_${VER}_linux64_minimal.tar.bz2"
SHA1="f1b9ce823e2849498f4597f8acd92c9a34a59640"
BASE="https://cef-builds.spotifycdn.com"

SPIKE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
VENDOR="${SPIKE_DIR}/.vendor"
DEST="${VENDOR}/cef_binary_${VER}_linux64_minimal"

if [[ -f "${DEST}/Release/libcef.so" ]]; then
  echo "CEF already vendored at ${DEST}"
  exit 0
fi

mkdir -p "${VENDOR}"
TARBALL="${VENDOR}/${FN}"
ENC="${FN//+/%2B}"   # URL-encode the only special char

if [[ ! -f "${TARBALL}" ]]; then
  echo "Downloading ${FN} (~296 MB) ..."
  curl -fSL --retry 3 -o "${TARBALL}" "${BASE}/${ENC}"
fi

echo "Verifying sha1 ..."
echo "${SHA1}  ${TARBALL}" | sha1sum -c -

echo "Extracting to ${VENDOR} ..."
tar -xjf "${TARBALL}" -C "${VENDOR}"

echo "Vendored: ${DEST}"
