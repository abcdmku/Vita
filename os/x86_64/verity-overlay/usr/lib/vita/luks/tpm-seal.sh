#!/bin/bash
# Vita LUKS TPM2 sealed unlock helper.
#
# PCR policy: PCR 7 + PCR 11.
#   PCR 7  measures Secure Boot policy state and enrolled keys.
#   PCR 11 is measured by the systemd UKI stub and changes with the UKI,
#          including kernel/initrd/cmdline content.
# This stays stable across ordinary reboots of the same image, but a changed
# trusted-boot state or changed UKI no longer satisfies the sealed-token policy.
set -euo pipefail

OUTER_DEVICE="${VITA_LUKS_OUTER_DEVICE:-/dev/disk/by-partlabel/vita-data}"
MAPPER_NAME="${VITA_LUKS_MAPPER_NAME:-vita-data}"
SOURCE_FILE="${VITA_LUKS_SOURCE_FILE:-/run/vita-luks/source}"
TPM2_DEVICE="${VITA_TPM2_DEVICE:-auto}"
TPM2_PCRS="${VITA_TPM2_PCRS:-7+11}"
SYSTEMD_CRYPTSETUP="${VITA_SYSTEMD_CRYPTSETUP:-systemd-cryptsetup}"
SYSTEMD_CRYPTENROLL="${VITA_SYSTEMD_CRYPTENROLL:-systemd-cryptenroll}"

write_source() {
  mkdir -p "$(dirname -- "$SOURCE_FILE")"
  printf 'tpm2\n' >"$SOURCE_FILE"
}

probe_tpm() {
  [ "${VITA_TPM_DISABLE:-0}" != "1" ] || return 2
  command -v "$SYSTEMD_CRYPTSETUP" >/dev/null 2>&1 || return 2
  [ -e "$OUTER_DEVICE" ] || return 2
}

open_with_tpm() {
  probe_tpm || return 2
  if cryptsetup status "$MAPPER_NAME" >/dev/null 2>&1; then
    write_source
    return 0
  fi

  local options rc
  options="tpm2-device=${TPM2_DEVICE},tpm2-pcrs=${TPM2_PCRS}"
  if "$SYSTEMD_CRYPTSETUP" attach "$MAPPER_NAME" "$OUTER_DEVICE" - "$options"; then
    write_source
    echo "VITA-LUKS-SOURCE: tpm2 opened $MAPPER_NAME pcrs=$TPM2_PCRS" >&2
    return 0
  fi
  rc=$?
  return "$rc"
}

enroll_tpm() {
  local unlock_key="${1:-}"
  [ -n "$unlock_key" ] || { echo "usage: $0 enroll <unlock-key-file>" >&2; return 64; }
  command -v "$SYSTEMD_CRYPTENROLL" >/dev/null 2>&1 || return 127
  "$SYSTEMD_CRYPTENROLL" "$OUTER_DEVICE" \
    --unlock-key-file="$unlock_key" \
    --tpm2-device="$TPM2_DEVICE" \
    --tpm2-pcrs="$TPM2_PCRS"
}

case "${1:-open}" in
  open)
    open_with_tpm
    ;;
  enroll)
    enroll_tpm "${2:-}"
    ;;
  probe)
    probe_tpm
    ;;
  *)
    echo "usage: $0 [open|probe|enroll <unlock-key-file>]" >&2
    exit 64
    ;;
esac
