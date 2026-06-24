#!/bin/bash
# Vita LUKS data unlock resolver.
#
# Source order on certified hardware is:
#   1. TPM-sealed slot    - STUBBED here; owner wires section 16 material later.
#   2. Recovery key       - STUBBED here; owner wires N-of-M offline recovery.
#   3. TEST keyfile       - BUILD-ONLY for VITA_LUKS=1 mechanism tests.
#
# The resolver is closed: unsupported or missing sources do not fall through to
# a plaintext data volume. Only a resolved keyfile can unlock the mapper.
set -euo pipefail

OUTER_DEVICE="${VITA_LUKS_OUTER_DEVICE:-/dev/disk/by-partlabel/vita-data}"
MAPPER_NAME="${VITA_LUKS_MAPPER_NAME:-vita-data}"
TEST_KEY="${VITA_LUKS_TEST_KEY:-/usr/lib/vita/luks/data.key}"
TEST_KEY_ENABLED="${VITA_LUKS_TEST_KEY_ENABLED:-1}"

unsupported_tpm() {
  # OWNER WIRES §16: replace this stub with a TPM2-sealed token/key path, for
  # example systemd-cryptenroll --tpm2-device=auto on the vita-data LUKS slot.
  echo "unsupported: tpm-sealed slot is a stub (# OWNER WIRES §16)" >&2
  return 2
}

unsupported_recovery() {
  # OWNER WIRES §16: replace this stub with the owner's N-of-M offline recovery
  # key flow. No recovery secret is generated, escrowed, or shipped here.
  echo "unsupported: recovery key source is a stub (# OWNER WIRES §16)" >&2
  return 2
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

resolve_key() {
  local key
  if key="$(unsupported_tpm)"; then
    printf '%s\n' "$key"
    return 0
  fi
  if key="$(unsupported_recovery)"; then
    printf '%s\n' "$key"
    return 0
  fi
  if key="$(test_key)"; then
    printf '%s\n' "$key"
    return 0
  fi
  return 1
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

unlock_data() {
  local key rc

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

  if ! key="$(resolve_key)"; then
    emit_error "resolve_key" 1
    return 1
  fi

  if cryptsetup luksOpen --key-file "$key" "$OUTER_DEVICE" "$MAPPER_NAME"; then
    :
  else
    rc=$?
    emit_error "luks_open" "$rc"
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
      tpm) unsupported_tpm ;;
      recovery) unsupported_recovery ;;
      test) test_key ;;
      *) echo "usage: $0 probe-source tpm|recovery|test" >&2; exit 64 ;;
    esac
    ;;
  *)
    echo "usage: $0 [unlock|resolve-key|probe-source]" >&2
    exit 64
    ;;
esac
