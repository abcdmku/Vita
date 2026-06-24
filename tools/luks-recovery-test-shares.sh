#!/bin/bash
# Vita LUKS TEST recovery-share generator - THROWAWAY, per-host, NEVER shipped.
#
# Creates an N-of-M TEST recovery set under os/x86_64/.luks/recovery/:
#   recovery.passphrase  - enrolled TEST recovery keyslot passphrase
#   share-*.env          - offline TEST shares used to reconstruct that passphrase
#
# This is not a Shamir implementation and makes no cryptographic threshold
# claim. The mechanism under test is the fail-closed quorum resolver: distinct
# enrolled share references must meet the threshold before the TEST passphrase
# is released to cryptsetup. Real recovery material is owner-held (spec section
# 16) and is not generated, escrowed, or committed here.
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

DIR="$REPO/os/x86_64/.luks/recovery"
PASSPHRASE="$DIR/recovery.passphrase"
NOTE="$DIR/README.DO-NOT-SHIP.txt"
THRESHOLD="${VITA_RECOVERY_TEST_THRESHOLD:-3}"
TOTAL="${VITA_RECOVERY_TEST_TOTAL:-5}"
KEYSTORE_REF="${VITA_RECOVERY_TEST_KEYSTORE_REF:-keystore:vita-test-recovery}"

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

case "$THRESHOLD" in
  ''|*[!0-9]*) fail "VITA_RECOVERY_TEST_THRESHOLD must be a positive integer" ;;
esac
case "$TOTAL" in
  ''|*[!0-9]*) fail "VITA_RECOVERY_TEST_TOTAL must be a positive integer" ;;
esac
[ "$THRESHOLD" -ge 1 ] || fail "VITA_RECOVERY_TEST_THRESHOLD must be positive"
[ "$TOTAL" -ge "$THRESHOLD" ] || fail "VITA_RECOVERY_TEST_TOTAL must be >= threshold"

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

gen_passphrase() {
  if [ -f "$PASSPHRASE" ]; then
    echo "skip recovery.passphrase (exists): $PASSPHRASE"
    chmod 400 "$PASSPHRASE"
    return 0
  fi
  dd if=/dev/urandom bs=32 count=1 status=none | base64 | tr -d '\n' >"$PASSPHRASE"
  chmod 400 "$PASSPHRASE"
  echo "gen  recovery.passphrase: $PASSPHRASE"
}

write_share() {
  local index="$1"
  local path="$DIR/share-$index.env"
  if [ -f "$path" ]; then
    echo "skip share-$index.env (exists): $path"
    chmod 400 "$path"
    return 0
  fi

  local passphrase
  passphrase="$(tr -d '\r\n' <"$PASSPHRASE")"
  {
    printf '# DO-NOT-SHIP: Vita TEST recovery share %s/%s.\n' "$index" "$TOTAL"
    printf 'VITA_RECOVERY_SHARE_VERSION=1\n'
    printf 'VITA_RECOVERY_TEST_MATERIAL=1\n'
    printf 'id=rk:test-share-%s\n' "$index"
    printf 'handle=rk_test_share_%s\n' "$index"
    printf 'keyStoreRef=%s\n' "$KEYSTORE_REF"
    printf 'threshold=%s\n' "$THRESHOLD"
    printf 'total=%s\n' "$TOTAL"
    printf 'passphraseBase64=%s\n' "$passphrase"
  } >"$path"
  chmod 400 "$path"
  echo "gen  share-$index.env: $path"
}

gen_passphrase
for i in $(seq 1 "$TOTAL"); do
  write_share "$i"
done

if [ -f "$NOTE" ]; then
  echo "skip README.DO-NOT-SHIP.txt (exists): $NOTE"
else
  {
    printf 'DO-NOT-SHIP: Vita LUKS TEST recovery shares.\n\n'
    printf 'This directory contains throwaway, per-host TEST recovery material for\n'
    printf 'the VITA_LUKS=1 TPM/recovery mechanism test. It contains no production\n'
    printf 'TPM or owner recovery secret. Delete the directory to regenerate it.\n'
  } >"$NOTE"
  chmod 400 "$NOTE"
  echo "gen  README.DO-NOT-SHIP.txt: $NOTE"
fi

cd "$REPO"
for f in os/x86_64/.luks/recovery/recovery.passphrase \
         os/x86_64/.luks/recovery/README.DO-NOT-SHIP.txt \
         os/x86_64/.luks/recovery/share-*.env; do
  if ! git check-ignore -q "$f"; then
    fail "$f is NOT gitignored - refusing to leave trackable recovery TEST material"
  fi
  if git ls-files --error-unmatch "$f" >/dev/null 2>&1; then
    fail "$f is tracked - recovery TEST material must never be committed"
  fi
done

echo "OK: os/x86_64/.luks/recovery TEST shares present and git-ignored (threshold=$THRESHOLD total=$TOTAL)"
