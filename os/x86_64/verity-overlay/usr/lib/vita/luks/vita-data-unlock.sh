#!/bin/bash
# Vita LUKS data unlock resolver.
#
# Source order on certified hardware is:
#   1. TPM2 sealed LUKS token - unattended trusted-boot unlock.
#   2. Recovery shares        - explicit N-of-M offline recovery presentation.
#   3. TEST keyfile           - BUILD-ONLY for VITA_LUKS=1 mechanism tests.
#
# The resolver is closed: missing or invalid sources do not fall through to a
# plaintext data volume. Only a source that opens the LUKS mapper succeeds.
set -euo pipefail

OUTER_DEVICE="${VITA_LUKS_OUTER_DEVICE:-/dev/disk/by-partlabel/vita-data}"
MAPPER_NAME="${VITA_LUKS_MAPPER_NAME:-vita-data}"
TEST_KEY="${VITA_LUKS_TEST_KEY:-/usr/lib/vita/luks/data.key}"
TEST_KEY_ENABLED="${VITA_LUKS_TEST_KEY_ENABLED:-1}"
SOURCE_FILE="${VITA_LUKS_SOURCE_FILE:-/run/vita-luks/source}"
TPM_HELPER="${VITA_LUKS_TPM_HELPER:-/usr/lib/vita/luks/tpm-seal.sh}"
RECOVERY_HELPER="${VITA_LUKS_RECOVERY_HELPER:-/usr/lib/vita/luks/recovery-unlock.sh}"

record_source() {
  local source="$1"
  mkdir -p "$(dirname -- "$SOURCE_FILE")"
  printf '%s\n' "$source" >"$SOURCE_FILE"
}

unlock_with_tpm() {
  [ -r "$TPM_HELPER" ] || return 2
  /bin/bash "$TPM_HELPER" open
}

unlock_with_recovery() {
  [ -r "$RECOVERY_HELPER" ] || return 2
  /bin/bash "$RECOVERY_HELPER" open
}

test_key() {
  if [ "$TEST_KEY_ENABLED" != "1" ]; then
    echo "unsupported: TEST key source disabled" >&2
    return 2
  fi
  if [ ! -r "$TEST_KEY" ]; then
    echo "unsupported: TEST key missing at $TEST_KEY" >&2
    return 2
  fi
  printf '%s\n' "$TEST_KEY"
}

unlock_with_test() {
  local key rc
  if ! key="$(test_key)"; then
    return 2
  fi
  if cryptsetup luksOpen --key-file "$key" "$OUTER_DEVICE" "$MAPPER_NAME"; then
    record_source "test-key"
    echo "VITA-LUKS-SOURCE: test-key opened $MAPPER_NAME" >&2
    return 0
  fi
  rc=$?
  return "$rc"
}

resolve_key() {
  test_key
}

emit_error() {
  local step="$1"
  local rc="$2"
  echo "VITA-LUKS-ERROR: reason=${step}:${rc} status=FAILSAFE" >&2
}

wait_for_outer_device() {
  local i
  for i in $(seq 1 50); do
    if [ -e "$OUTER_DEVICE" ]; then
      return 0
    fi
    sleep 0.1
  done
  return 1
}

unlock_sources() {
  local rc
  if unlock_with_tpm; then
    return 0
  fi
  rc=$?
  echo "VITA-LUKS-SOURCE-SKIP: tpm2 rc=$rc" >&2

  if unlock_with_recovery; then
    return 0
  fi
  rc=$?
  echo "VITA-LUKS-SOURCE-SKIP: recovery rc=$rc" >&2

  if unlock_with_test; then
    return 0
  fi
  rc=$?
  echo "VITA-LUKS-SOURCE-SKIP: test-key rc=$rc" >&2
  return 1
}

unlock_data() {
  local rc

  if cryptsetup status "$MAPPER_NAME" >/dev/null 2>&1; then
    return 0
  fi

  if ! wait_for_outer_device; then
    emit_error "outer_device_missing" 1
    return 1
  fi

  if cryptsetup isLuks --type luks2 "$OUTER_DEVICE" >/dev/null 2>&1; then
    :
  else
    rc=$?
    emit_error "is_luks2" "$rc"
    return 1
  fi

  if ! unlock_sources; then
    emit_error "unlock_sources" 1
    return 1
  fi

  if command -v udevadm >/dev/null 2>&1; then
    udevadm settle || true
  fi
}

case "${1:-unlock}" in
  unlock)
    unlock_data
    ;;
  resolve-key)
    resolve_key
    ;;
  probe-source)
    case "${2:-}" in
      tpm) [ -r "$TPM_HELPER" ] && /bin/bash "$TPM_HELPER" probe ;;
      recovery) [ -r "$RECOVERY_HELPER" ] && /bin/bash "$RECOVERY_HELPER" probe ;;
      test) test_key ;;
      *) echo "usage: $0 probe-source tpm|recovery|test" >&2; exit 64 ;;
    esac
    ;;
  *)
    echo "usage: $0 [unlock|resolve-key|probe-source]" >&2
    exit 64
    ;;
esac
