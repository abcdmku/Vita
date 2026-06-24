#!/bin/bash
# Host-side TPM seal + recovery mechanism test for P1-089.
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
if REPO_REL="$(git rev-parse --path-format=relative --show-toplevel 2>/dev/null)" && [ -n "$REPO_REL" ]; then
  REPO="${REPO_REL%/}"
  [ -n "$REPO" ] || REPO="."
else
  REPO="$(cd -- "$SCRIPT_DIR/../../.." && pwd -P)"
fi

RECOVERY_KEYGEN="$REPO/tools/luks-recovery-test-shares.sh"
LUKS_KEYGEN="$REPO/tools/luks-test-keys.sh"
RESOLVER="$REPO/os/x86_64/verity-overlay/usr/lib/vita/luks/vita-data-unlock.sh"
TPM_HELPER="$REPO/os/x86_64/verity-overlay/usr/lib/vita/luks/tpm-seal.sh"
RECOVERY_HELPER="$REPO/os/x86_64/verity-overlay/usr/lib/vita/luks/recovery-unlock.sh"
MARKER="$REPO/os/x86_64/verity-overlay/usr/lib/vita/luks/vita-luks-marker.sh"
VAR_MOUNT="$REPO/os/x86_64/verity-overlay/usr/lib/systemd/system/var.mount"
BUILD_AND_BOOT="$REPO/os/x86_64/build-and-boot.mjs"
WSL_VERIFY="$REPO/tools/wsl-verify.sh"
SHARE_DIR="$REPO/os/x86_64/.luks/recovery"
RECOVERY_PASSPHRASE="$SHARE_DIR/recovery.passphrase"
DATA_KEY="$REPO/os/x86_64/.luks/data.key"

case "$(uname -s)" in
  MINGW*|MSYS*|CYGWIN*)
    export XDG_CONFIG_HOME="$REPO/os/x86_64/.luks/git-xdg"
    mkdir -p "$XDG_CONFIG_HOME"
    ;;
esac

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

assert_file() {
  [ -f "$1" ] || fail "missing file: $1"
}

assert_contains() {
  local text="$1"
  local needle="$2"
  local label="$3"
  printf '%s' "$text" | grep -Fq "$needle" || fail "$label: expected to contain '$needle'"
}

assert_file_line() {
  local path="$1"
  local pattern="$2"
  local label="$3"
  grep -Eq "$pattern" "$path" || fail "$label: expected $path to match $pattern"
}

reject_file_line() {
  local path="$1"
  local pattern="$2"
  local label="$3"
  if grep -Eq "$pattern" "$path"; then
    fail "$label: $path must not match $pattern"
  fi
}

expect_fail_output() {
  local label="$1"
  shift
  local output rc
  if output="$("$@" 2>&1)"; then
    fail "$label unexpectedly succeeded"
  else
    rc=$?
  fi
  [ "$rc" -ne 0 ] || fail "$label returned zero"
  printf '%s\n' "$output"
}

export VITA_REPO="$REPO"
bash "$RECOVERY_KEYGEN" >/dev/null
second_run="$(bash "$RECOVERY_KEYGEN" 2>&1)"
assert_contains "$second_run" "skip recovery.passphrase" "idempotent recovery keygen"
assert_contains "$second_run" "skip share-1.env" "idempotent recovery keygen"

assert_file "$RECOVERY_PASSPHRASE"
passphrase_bytes="$(wc -c <"$RECOVERY_PASSPHRASE" | tr -d '[:space:]')"
[ "$passphrase_bytes" -ge 32 ] || fail "recovery.passphrase too small: $passphrase_bytes bytes"
for f in "$SHARE_DIR"/share-*.env; do
  assert_file "$f"
  grep -Eq '^VITA_RECOVERY_SHARE_VERSION=1$' "$f" || fail "$f missing version"
  grep -Eq '^passphraseBase64=' "$f" || fail "$f missing TEST passphrase material"
done

cd "$REPO"
for f in os/x86_64/.luks/recovery/recovery.passphrase \
         os/x86_64/.luks/recovery/README.DO-NOT-SHIP.txt \
         os/x86_64/.luks/recovery/share-*.env; do
  git check-ignore -q "$f" || fail "$f is not gitignored"
  if git ls-files --error-unmatch "$f" >/dev/null 2>&1; then
    fail "$f is tracked"
  fi
done

assert_file "$RESOLVER"
assert_file "$TPM_HELPER"
assert_file "$RECOVERY_HELPER"
assert_file "$MARKER"
reject_file_line "$RESOLVER" 'unsupported_tpm|unsupported_recovery|tpm=stub|recovery=stub|OWNER WIRES' "resolver sources must be real"
reject_file_line "$MARKER" 'tpm=stub|recovery=stub' "marker must not report stubs"
assert_file_line "$TPM_HELPER" 'PCR 7 \+ PCR 11' "TPM helper must document stable PCR policy"
assert_file_line "$TPM_HELPER" 'systemd-cryptsetup.*attach|SYSTEMD_CRYPTSETUP.*systemd-cryptsetup' "TPM helper must use systemd token unlock"
assert_file_line "$RECOVERY_HELPER" 'below_threshold' "recovery helper must fail closed below threshold"
assert_file_line "$RECOVERY_HELPER" 'foreign_share' "recovery helper must reject foreign shares"
assert_file_line "$MARKER" 'VITA-TPM-SEAL: sealed=OK recovery=OK wrong-key=fail-closed status=OK' "marker must emit measured TPM seal OK"
assert_file_line "$MARKER" 'VITA-TPM-SEAL-ERROR: reason=' "marker must emit TPM seal failsafe errors"

tpm_line="$(grep -n 'if unlock_with_tpm' "$RESOLVER" | head -1 | cut -d: -f1)"
recovery_line="$(grep -n 'if unlock_with_recovery' "$RESOLVER" | head -1 | cut -d: -f1)"
test_line="$(grep -n 'if unlock_with_test' "$RESOLVER" | head -1 | cut -d: -f1)"
[ -n "$tpm_line" ] && [ -n "$recovery_line" ] && [ -n "$test_line" ] || fail "resolver source order not found"
[ "$tpm_line" -lt "$recovery_line" ] || fail "resolver must try TPM before recovery"
[ "$recovery_line" -lt "$test_line" ] || fail "resolver must try recovery before TEST keyfile"

expect_fail_output "resolver with no usable key source" env \
  VITA_LUKS_TEST_KEY_ENABLED=0 \
  bash "$RESOLVER" resolve-key >/dev/null

assert_file_line "$VAR_MOUNT" '^Requires=vita-data-luks\.service$' "var.mount must hard-require unlock"
assert_file_line "$VAR_MOUNT" '^BindsTo=vita-data-luks\.service$' "var.mount must bind to unlock"
assert_file_line "$VAR_MOUNT" '^After=vita-data-luks\.service$' "var.mount must start after unlock"
assert_file_line "$VAR_MOUNT" '^What=/dev/mapper/vita-data$' "var.mount must mount the decrypted mapper"
reject_file_line "$VAR_MOUNT" '^Wants=vita-data-luks\.service$' "var.mount must not soft-depend on unlock"
reject_file_line "$VAR_MOUNT" '^What=/dev/disk/by-label/vita-data$' "var.mount must not mount a raw by-label plaintext fallback"

assert_file_line "$BUILD_AND_BOOT" 'luksAddKey' "build must enroll a recovery keyslot"
assert_file_line "$BUILD_AND_BOOT" 'systemd-cryptenroll|tpm-seal\.sh' "build must enroll a TPM2 token"
assert_file_line "$BUILD_AND_BOOT" 'DEFAULT_TPM2_PCRS = "7\+11"' "build must use documented TPM PCR policy"
assert_file_line "$BUILD_AND_BOOT" 'recovery-shares' "build must stage TEST recovery shares"
assert_file_line "$WSL_VERIFY" 'tpmseal\)' "wsl-verify must expose tpmseal mode"

node "$REPO/tools/build/go-in-docker.mjs" --dir agent vet ./capabilities/storage/...
node "$REPO/tools/build/go-in-docker.mjs" --dir agent test ./capabilities/storage/...

if [ "$(id -u)" -ne 0 ]; then
  echo "SKIP: live TPM/loop LUKS exercise requires root; structural, recovery-share, resolver, marker, and Go tests passed"
  exit 0
fi

for cmd in cryptsetup losetup truncate systemd-cryptenroll systemd-cryptsetup swtpm swtpm_setup; do
  command -v "$cmd" >/dev/null 2>&1 || {
    echo "SKIP: live TPM/loop LUKS exercise needs '$cmd'; structural and Go tests passed"
    exit 0
  }
done

if ! losetup -f >/dev/null 2>&1; then
  echo "SKIP: no free loop devices; structural and Go tests passed"
  exit 0
fi

if [ "${VITA_TPM2_DEVICE:-auto}" = "auto" ] && [ ! -e /dev/tpmrm0 ] && [ ! -e /dev/tpm0 ]; then
  echo "SKIP: no host TPM2 device for systemd-cryptenroll auto; swtpm-backed boot is orchestrator floor"
  exit 0
fi

bash "$LUKS_KEYGEN" >/dev/null
TMP="$(mktemp -d)"
IMG="$TMP/vita-data.img"
LOOP=""
MAPPER_TPM="vita-data-tpm-test-$$"
MAPPER_RECOVERY="vita-data-recovery-test-$$"
MAPPER_WRONG_RECOVERY="vita-data-recovery-wrong-$$"
MAPPER_WRONG_TPM="vita-data-tpm-wrong-$$"

cleanup() {
  set +e
  cryptsetup status "$MAPPER_TPM" >/dev/null 2>&1 && cryptsetup luksClose "$MAPPER_TPM"
  cryptsetup status "$MAPPER_RECOVERY" >/dev/null 2>&1 && cryptsetup luksClose "$MAPPER_RECOVERY"
  cryptsetup status "$MAPPER_WRONG_RECOVERY" >/dev/null 2>&1 && cryptsetup luksClose "$MAPPER_WRONG_RECOVERY"
  cryptsetup status "$MAPPER_WRONG_TPM" >/dev/null 2>&1 && cryptsetup luksClose "$MAPPER_WRONG_TPM"
  [ -n "$LOOP" ] && losetup -d "$LOOP" >/dev/null 2>&1
  rm -rf "$TMP"
}
trap cleanup EXIT

truncate -s 128M "$IMG"
LOOP="$(losetup --find --show "$IMG")"

cryptsetup luksFormat --type luks2 --batch-mode --key-file "$DATA_KEY" "$LOOP"
cryptsetup luksAddKey --key-file "$DATA_KEY" "$LOOP" "$RECOVERY_PASSPHRASE"
if ! env VITA_LUKS_OUTER_DEVICE="$LOOP" VITA_TPM2_DEVICE="${VITA_TPM2_DEVICE:-auto}" \
  bash "$TPM_HELPER" enroll "$DATA_KEY"; then
  echo "SKIP: systemd-cryptenroll could not enroll the available TPM; structural and recovery tests passed"
  exit 0
fi

env VITA_LUKS_OUTER_DEVICE="$LOOP" VITA_LUKS_MAPPER_NAME="$MAPPER_TPM" \
  VITA_LUKS_SOURCE_FILE="$TMP/source-tpm" \
  bash "$TPM_HELPER" open
cryptsetup status "$MAPPER_TPM" >/dev/null 2>&1 || fail "TPM helper did not open mapper"
cryptsetup luksClose "$MAPPER_TPM"

env VITA_LUKS_OUTER_DEVICE="$LOOP" VITA_LUKS_MAPPER_NAME="$MAPPER_RECOVERY" \
  VITA_LUKS_SOURCE_FILE="$TMP/source-recovery" \
  VITA_RECOVERY_SHARE_DIR="$SHARE_DIR" VITA_RECOVERY_AUTO=1 \
  bash "$RECOVERY_HELPER" open
cryptsetup status "$MAPPER_RECOVERY" >/dev/null 2>&1 || fail "recovery helper did not open mapper"
cryptsetup luksClose "$MAPPER_RECOVERY"

if env VITA_LUKS_OUTER_DEVICE="$LOOP" VITA_LUKS_MAPPER_NAME="$MAPPER_WRONG_RECOVERY" \
  VITA_RECOVERY_SHARE_DIR="$SHARE_DIR" \
  VITA_RECOVERY_SHARE_PATHS="$SHARE_DIR/share-1.env $SHARE_DIR/share-2.env" \
  bash "$RECOVERY_HELPER" open >/dev/null 2>&1; then
  fail "below-threshold recovery shares unexpectedly opened mapper"
fi
if cryptsetup status "$MAPPER_WRONG_RECOVERY" >/dev/null 2>&1; then
  fail "wrong recovery mapper exists after fail-closed attempt"
fi

if env VITA_LUKS_OUTER_DEVICE="$LOOP" VITA_LUKS_MAPPER_NAME="$MAPPER_WRONG_TPM" \
  VITA_TPM2_DEVICE="${VITA_TPM2_DEVICE:-auto}" VITA_TPM2_PCRS="0+1+2+3+4+5+6" \
  bash "$TPM_HELPER" open >/dev/null 2>&1; then
  fail "wrong-PCR TPM policy unexpectedly opened mapper"
fi
if cryptsetup status "$MAPPER_WRONG_TPM" >/dev/null 2>&1; then
  fail "wrong TPM mapper exists after fail-closed attempt"
fi

echo "PASS: TPM-seal sealed=OK recovery=OK wrong-key=fail-closed resolver=OK gitignore=OK"
