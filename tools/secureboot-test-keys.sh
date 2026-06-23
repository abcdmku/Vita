#!/bin/bash
# Vita Secure Boot TEST keystore generator — THROWAWAY, per-host, NEVER shipped (spec §16).
#
# Creates a self-signed RSA-2048 db pair (used as PK=KEK=db for a collapsed TEST root of trust)
# plus a separate NON-enrolled "rogue" pair for the wrong-key negative test. Everything lands under
# os/x86_64/.secureboot/, which /.gitignore anchors so neither the key NOR the cert can be tracked.
#
#   - Idempotent: if db.key+db.crt already exist it skips db; same for rogue. Regenerate by deleting
#     the dir (the negative-test matrix re-derives trust from whatever pair is present).
#   - Long validity via -days (portable across openssl versions; -not_before/-not_after would require
#     openssl >= 3.2, which the build host may not have). The keystore is gen-once + gitignored +
#     explicitly EXCLUDED from any reproducibility claim (image bytes are reproducible GIVEN a fixed
#     key; the throwaway key/cert are not), so a wall-clock notBefore/notAfter is irrelevant here.
#   - CN carries a self-identifying DO-NOT-SHIP label so any leaked artifact is obvious.
#
# Invoked by path from the orchestrator's single-quoted `bash -lc` so the host quoting constraint
# (no inner double-quotes, no pipes, no $()) never touches an openssl arg.
set -euo pipefail

REPO="${VITA_REPO:-/home/borg/Vita}"
DIR="$REPO/os/x86_64/.secureboot"
DAYS=7305   # ~20 years; -days is portable across all openssl; keystore is throwaway/non-reproducible

mkdir -p "$DIR"

gen_pair() {
  # $1 = basename (db|rogue)   $2 = CN
  local base="$1" cn="$2"
  local key="$DIR/$base.key" crt="$DIR/$base.crt"
  if [ -f "$key" ] && [ -f "$crt" ]; then
    echo "skip $base (exists): $crt"
    return 0
  fi
  openssl req -newkey rsa:2048 -nodes -x509 -sha256 \
    -days "$DAYS" \
    -subj "/CN=$cn/" \
    -keyout "$key" -out "$crt"
  chmod 600 "$key"
  chmod 644 "$crt"
  echo "gen  $base: $crt"
}

gen_pair db    Vita-TEST-SecureBoot-db-DO-NOT-SHIP
gen_pair rogue Vita-TEST-ROGUE-unenrolled-DO-NOT-SHIP

# Defense-in-depth: prove git ignores the whole keystore. If a future refactor drops the dir rule,
# fail loudly BEFORE any `git add` can ever stage a key/cert.
cd "$REPO"
for f in .secureboot/db.key .secureboot/db.crt .secureboot/rogue.key .secureboot/rogue.crt; do
  p="os/x86_64/$f"
  if ! git check-ignore -q "$p"; then
    echo "FAIL: $p is NOT gitignored — refusing to leave a trackable Secure Boot key/cert"
    exit 3
  fi
done
echo "OK: os/x86_64/.secureboot/ keystore present and git-ignored (db + rogue)"
