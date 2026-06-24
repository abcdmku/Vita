#!/bin/bash
# Vita LUKS TEST keystore generator - THROWAWAY, per-host, NEVER shipped.
#
# Creates two raw keyfiles under os/x86_64/.luks/:
#   data.key  - enrolled TEST unlock key for VITA_LUKS=1 images
#   rogue.key - non-enrolled wrong key for fail-closed negative tests
#
# The directory is gitignored as a whole. The random key material is excluded from
# reproducibility claims: an image is reproducible given a fixed TEST key, but this
# throwaway key is not reproducible and must not be used as production material.
set -euo pipefail

if [ -n "${VITA_REPO:-}" ]; then
  REPO="$VITA_REPO"
elif REPO_REL="$(git rev-parse --path-format=relative --show-toplevel 2>/dev/null)" && [ -n "$REPO_REL" ]; then
  REPO="${REPO_REL%/}"
  [ -n "$REPO" ] || REPO="."
else
  SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
  REPO="$(cd -- "$SCRIPT_DIR/.." && pwd -P)"
fi

DIR="$REPO/os/x86_64/.luks"
NOTE="$DIR/README.DO-NOT-SHIP.txt"

mkdir -p "$DIR"
case "$(uname -s)" in
  MINGW*|MSYS*|CYGWIN*)
    if [ -z "${XDG_CONFIG_HOME:-}" ]; then
      export XDG_CONFIG_HOME="$DIR/git-xdg"
      mkdir -p "$XDG_CONFIG_HOME"
    fi
    ;;
esac
umask 077

gen_key() {
  local name="$1"
  local path="$DIR/$name"
  if [ -f "$path" ]; then
    echo "skip $name (exists): $path"
    chmod 400 "$path"
    return 0
  fi
  dd if=/dev/urandom of="$path" bs=4096 count=1 status=none
  chmod 400 "$path"
  echo "gen  $name: $path"
}

gen_key data.key
gen_key rogue.key

if [ -f "$NOTE" ]; then
  echo "skip README.DO-NOT-SHIP.txt (exists): $NOTE"
else
  cat >"$NOTE" <<'EOF'
DO-NOT-SHIP: Vita LUKS TEST keystore.

This directory contains throwaway, per-host TEST keyfiles generated for the
VITA_LUKS=1 boot/storage mechanism test. It contains no production TPM-sealed
secret and no owner recovery material. Delete the directory to regenerate it.
EOF
  chmod 400 "$NOTE"
  echo "gen  README.DO-NOT-SHIP.txt: $NOTE"
fi

# Defense-in-depth: prove git ignores the whole keystore. If a future refactor
# drops the dir rule, fail loudly before any `git add` can stage a key.
cd "$REPO"
for f in os/x86_64/.luks/data.key os/x86_64/.luks/rogue.key os/x86_64/.luks/README.DO-NOT-SHIP.txt; do
  if ! git check-ignore -q "$f"; then
    echo "FAIL: $f is NOT gitignored - refusing to leave trackable LUKS TEST key material"
    exit 3
  fi
done

echo "OK: os/x86_64/.luks/ TEST keystore present and git-ignored (data + rogue)"
