#!/bin/bash
# Vita LUKS TEST recovery-share generator - THROWAWAY, per-host, NEVER shipped.
#
# Creates an N-of-M TEST recovery set under os/x86_64/.luks/recovery/:
#   recovery.passphrase  - host-local TEST recovery keyslot passphrase
#   share-*.env          - offline TEST share fragments used to reconstruct it
#
# This is TEST material for proving the fail-closed quorum resolver. It uses a
# small Shamir-style GF(256) splitter so a threshold set reconstructs the TEST
# passphrase, but makes no production cryptographic hardening claim. Real
# recovery material is owner-held (spec section 16) and is not generated,
# escrowed, shipped, or committed here.
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

  local fragment="${2:-}"
  [ -n "$fragment" ] || fail "missing generated fragment for share-$index.env"
  {
    printf '# DO-NOT-SHIP: Vita TEST recovery share %s/%s.\n' "$index" "$TOTAL"
    printf 'VITA_RECOVERY_SHARE_VERSION=1\n'
    printf 'VITA_RECOVERY_TEST_MATERIAL=1\n'
    printf 'id=rk:test-share-%s\n' "$index"
    printf 'handle=rk_test_share_%s\n' "$index"
    printf 'keyStoreRef=%s\n' "$KEYSTORE_REF"
    printf 'threshold=%s\n' "$THRESHOLD"
    printf 'total=%s\n' "$TOTAL"
    printf 'x=%s\n' "$index"
    printf 'fragmentBase64=%s\n' "$fragment"
  } >"$path"
  chmod 400 "$path"
  echo "gen  share-$index.env: $path"
}

gen_passphrase

needs_regen=0
for i in $(seq 1 "$TOTAL"); do
  [ -f "$DIR/share-$i.env" ] || needs_regen=1
done
if [ "$needs_regen" = "0" ]; then
  share_count=0
  for f in "$DIR"/share-*.env; do
    [ -e "$f" ] || continue
    share_count=$((share_count + 1))
    if grep -Eq '^(passphraseBase64=|x=|fragmentBase64=)' "$f"; then
      grep -Eq '^passphraseBase64=' "$f" && needs_regen=1
      grep -Eq '^x=' "$f" || needs_regen=1
      grep -Eq '^fragmentBase64=' "$f" || needs_regen=1
    else
      needs_regen=1
    fi
  done
  [ "$share_count" = "$TOTAL" ] || needs_regen=1
fi
if [ "$needs_regen" = "1" ]; then
  rm -f "$DIR"/share-*.env
  mapfile -t fragments < <(node - "$PASSPHRASE" "$THRESHOLD" "$TOTAL" <<'NODE'
const fs = require("node:fs");
const crypto = require("node:crypto");

const [passphrasePath, thresholdText, totalText] = process.argv.slice(2);
const threshold = Number(thresholdText);
const total = Number(totalText);
const secret = Buffer.from(fs.readFileSync(passphrasePath, "utf8").trim(), "utf8");

function gfMul(left, right) {
  let a = left;
  let b = right;
  let product = 0;
  while (b !== 0) {
    if ((b & 1) !== 0) product ^= a;
    const carry = a & 0x80;
    a = (a << 1) & 0xff;
    if (carry !== 0) a ^= 0x1b;
    b >>= 1;
  }
  return product;
}

const coefficients = Array.from({ length: secret.length }, () =>
  threshold <= 1 ? Buffer.alloc(0) : crypto.randomBytes(threshold - 1)
);

for (let x = 1; x <= total; x += 1) {
  const fragment = Buffer.alloc(secret.length);
  for (let byteIndex = 0; byteIndex < secret.length; byteIndex += 1) {
    let y = secret[byteIndex];
    let power = x;
    for (let degree = 1; degree < threshold; degree += 1) {
      y ^= gfMul(coefficients[byteIndex][degree - 1], power);
      power = gfMul(power, x);
    }
    fragment[byteIndex] = y;
  }
  process.stdout.write(`${x}=${fragment.toString("base64")}\n`);
}
NODE
  )
else
  fragments=()
fi
for i in $(seq 1 "$TOTAL"); do
  if [ "$needs_regen" = "1" ]; then
    fragment_line="${fragments[$((i - 1))]:-}"
    [ "${fragment_line%%=*}" = "$i" ] || fail "fragment generator returned unexpected share index for $i"
    write_share "$i" "${fragment_line#*=}"
  else
    write_share "$i" "skip"
  fi
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
