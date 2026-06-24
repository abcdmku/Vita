#!/bin/bash
# Host-side LUKS mechanism test for P1-068. The loop/mount portion requires
# root and loop devices; key generation, git-ignore checks, and resolver stub
# checks run regardless.
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
if REPO_REL="$(git rev-parse --path-format=relative --show-toplevel 2>/dev/null)" && [ -n "$REPO_REL" ]; then
  REPO="${REPO_REL%/}"
  [ -n "$REPO" ] || REPO="."
else
  REPO="$(cd -- "$SCRIPT_DIR/../../.." && pwd -P)"
fi
KEYGEN="$REPO/tools/luks-test-keys.sh"
RESOLVER="$REPO/os/x86_64/verity-overlay/usr/lib/vita/luks/vita-data-unlock.sh"
VAR_MOUNT="$REPO/os/x86_64/verity-overlay/usr/lib/systemd/system/var.mount"
BUILD_AND_BOOT="$REPO/os/x86_64/build-and-boot.mjs"
MKOSI_CONF="$REPO/os/x86_64/mkosi.conf"
BUILD_ROOT="$REPO/os/x86_64/build-root.mjs"
ROOT_DETERMINISM_TEST="$REPO/os/x86_64/test/root-determinism.test.ts"
DATA_KEY="$REPO/os/x86_64/.luks/data.key"
ROGUE_KEY="$REPO/os/x86_64/.luks/rogue.key"

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
bash "$KEYGEN" >/dev/null
second_run="$(bash "$KEYGEN" 2>&1)"
assert_contains "$second_run" "skip data.key" "idempotent keygen"
assert_contains "$second_run" "skip rogue.key" "idempotent keygen"

assert_file "$DATA_KEY"
assert_file "$ROGUE_KEY"
data_bytes="$(wc -c <"$DATA_KEY" | tr -d '[:space:]')"
rogue_bytes="$(wc -c <"$ROGUE_KEY" | tr -d '[:space:]')"
[ "$data_bytes" = "4096" ] || fail "data.key must be 4096 bytes, got $data_bytes"
[ "$rogue_bytes" = "4096" ] || fail "rogue.key must be 4096 bytes, got $rogue_bytes"
case "$(uname -s)" in
  MINGW*|MSYS*|CYGWIN*) ;;
  *)
    if data_mode="$(stat -c '%a' "$DATA_KEY" 2>/dev/null)"; then
      [ "$data_mode" = "400" ] || fail "data.key mode must be 0400, got $data_mode"
    fi
    if rogue_mode="$(stat -c '%a' "$ROGUE_KEY" 2>/dev/null)"; then
      [ "$rogue_mode" = "400" ] || fail "rogue.key mode must be 0400, got $rogue_mode"
    fi
    ;;
esac

cd "$REPO"
git check-ignore -q os/x86_64/.luks/data.key || fail "data.key is not gitignored"
git check-ignore -q os/x86_64/.luks/rogue.key || fail "rogue.key is not gitignored"
if git ls-files --error-unmatch os/x86_64/.luks/data.key >/dev/null 2>&1; then
  fail "data.key is tracked"
fi
if git ls-files --error-unmatch os/x86_64/.luks/rogue.key >/dev/null 2>&1; then
  fail "rogue.key is tracked"
fi

assert_file_line "$BUILD_AND_BOOT" '"PATH,PARTLABEL"' "build postprocess must locate loop partitions by device path"
assert_file_line "$VAR_MOUNT" '^Requires=vita-data-luks\.service$' "var.mount must hard-require unlock"
assert_file_line "$VAR_MOUNT" '^BindsTo=vita-data-luks\.service$' "var.mount must bind to unlock"
assert_file_line "$VAR_MOUNT" '^After=vita-data-luks\.service$' "var.mount must start after unlock"
assert_file_line "$VAR_MOUNT" '^What=/dev/mapper/vita-data$' "var.mount must mount the decrypted mapper"
assert_file_line "$VAR_MOUNT" '^ConditionPathExists=/usr/lib/vita/luks/enabled$' "var.mount must be LUKS-build gated"
reject_file_line "$VAR_MOUNT" '^Wants=vita-data-luks\.service$' "var.mount must not soft-depend on unlock"
reject_file_line "$VAR_MOUNT" '^What=/dev/disk/by-label/vita-data$' "var.mount must not mount a raw by-label plaintext fallback"
assert_file_line "$MKOSI_CONF" '^[[:space:]]+cryptsetup-bin$' "mkosi package set must include cryptsetup-bin"
assert_file_line "$BUILD_ROOT" '^[[:space:]]+"cryptsetup-bin",$' "planner package allowlist must include cryptsetup-bin"
assert_file_line "$ROOT_DETERMINISM_TEST" '^[[:space:]]+"cryptsetup-bin",$' "determinism test package allowlist must include cryptsetup-bin"

tpm_output="$(expect_fail_output "TPM stub" bash "$RESOLVER" probe-source tpm)"
assert_contains "$tpm_output" "unsupported: tpm-sealed slot is a stub" "TPM stub"
assert_contains "$tpm_output" "OWNER WIRES" "TPM stub"
recovery_output="$(expect_fail_output "recovery stub" bash "$RESOLVER" probe-source recovery)"
assert_contains "$recovery_output" "unsupported: recovery key source is a stub" "recovery stub"
assert_contains "$recovery_output" "OWNER WIRES" "recovery stub"

resolved_key="$(VITA_LUKS_TEST_KEY="$DATA_KEY" bash "$RESOLVER" resolve-key 2>/dev/null)"
[ "$resolved_key" = "$DATA_KEY" ] || fail "resolver returned '$resolved_key', expected '$DATA_KEY'"
expect_fail_output "resolver with no usable source" env \
  VITA_LUKS_TEST_KEY="$REPO/os/x86_64/.luks/missing.key" \
  bash "$RESOLVER" resolve-key >/dev/null

if [ "$(id -u)" -ne 0 ]; then
  echo "SKIP: root/loop LUKS exercise requires root; key, git-ignore, resolver, fail-closed unit, loop-path, and package checks passed"
  exit 0
fi

for cmd in cryptsetup losetup mkfs.ext4 mount umount mountpoint truncate; do
  command -v "$cmd" >/dev/null 2>&1 || {
    echo "SKIP: root/loop LUKS exercise needs '$cmd'; key, git-ignore, resolver, fail-closed unit, loop-path, and package checks passed"
    exit 0
  }
done

if ! losetup -f >/dev/null 2>&1; then
  echo "SKIP: no free loop devices; key, git-ignore, resolver, fail-closed unit, loop-path, and package checks passed"
  exit 0
fi

TMP="$(mktemp -d)"
IMG="$TMP/vita-data.img"
MNT="$TMP/mnt"
LOOP=""
MAPPER="vita-data-test-$$"
ROGUE_MAPPER="vita-data-rogue-$$"
NOSOURCE_MAPPER="vita-data-nosource-$$"
SENTINEL="vita-luks-sentinel.txt"

cleanup() {
  set +e
  mountpoint -q "$MNT" && umount "$MNT"
  cryptsetup status "$MAPPER" >/dev/null 2>&1 && cryptsetup luksClose "$MAPPER"
  cryptsetup status "$ROGUE_MAPPER" >/dev/null 2>&1 && cryptsetup luksClose "$ROGUE_MAPPER"
  cryptsetup status "$NOSOURCE_MAPPER" >/dev/null 2>&1 && cryptsetup luksClose "$NOSOURCE_MAPPER"
  [ -n "$LOOP" ] && losetup -d "$LOOP" >/dev/null 2>&1
  rm -rf "$TMP"
}
trap cleanup EXIT

mkdir -p "$MNT"
truncate -s 128M "$IMG"
LOOP="$(losetup --find --show "$IMG")"

cryptsetup luksFormat --type luks2 --batch-mode --key-file "$DATA_KEY" "$LOOP"
cryptsetup isLuks "$LOOP" || fail "formatted image is not LUKS"
cryptsetup luksDump "$LOOP" | grep -Eq '^Version:[[:space:]]+2$' || fail "formatted image is not LUKS2"

if cryptsetup luksOpen --key-file "$ROGUE_KEY" "$LOOP" "$ROGUE_MAPPER" >/dev/null 2>&1; then
  fail "rogue key unexpectedly opened the LUKS container"
fi
if cryptsetup status "$ROGUE_MAPPER" >/dev/null 2>&1; then
  fail "rogue mapper exists after wrong-key failure"
fi

if env VITA_LUKS_OUTER_DEVICE="$LOOP" VITA_LUKS_MAPPER_NAME="$NOSOURCE_MAPPER" \
  VITA_LUKS_TEST_KEY="$REPO/os/x86_64/.luks/missing.key" \
  bash "$RESOLVER" unlock >/dev/null 2>&1; then
  fail "unlock without a usable source unexpectedly succeeded"
fi
if cryptsetup status "$NOSOURCE_MAPPER" >/dev/null 2>&1; then
  fail "no-source mapper exists after fail-closed unlock"
fi

env VITA_LUKS_OUTER_DEVICE="$LOOP" VITA_LUKS_MAPPER_NAME="$MAPPER" VITA_LUKS_TEST_KEY="$DATA_KEY" \
  bash "$RESOLVER" unlock
mkfs.ext4 -F -L vita-data "/dev/mapper/$MAPPER" >/dev/null
mount "/dev/mapper/$MAPPER" "$MNT"
printf 'persisted through close/open\n' >"$MNT/$SENTINEL"
sync
umount "$MNT"
cryptsetup luksClose "$MAPPER"

env VITA_LUKS_OUTER_DEVICE="$LOOP" VITA_LUKS_MAPPER_NAME="$MAPPER" VITA_LUKS_TEST_KEY="$DATA_KEY" \
  bash "$RESOLVER" unlock
mount "/dev/mapper/$MAPPER" "$MNT"
[ -f "$MNT/$SENTINEL" ] || fail "sentinel did not persist across luksClose/luksOpen"
grep -Fq 'persisted through close/open' "$MNT/$SENTINEL" || fail "sentinel content changed"

echo "PASS: LUKS2 encrypted=OK unlocked=OK persists=OK wrong-key=fail-closed resolver=OK gitignore=OK"
