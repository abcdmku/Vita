#!/bin/bash
# Measured VITA-LUKS and VITA-TPM-SEAL markers.
set -euo pipefail

OUTER_DEVICE="${VITA_LUKS_OUTER_DEVICE:-/dev/disk/by-partlabel/vita-data}"
MAPPER_NAME="${VITA_LUKS_MAPPER_NAME:-vita-data}"
MAPPER_DEVICE="/dev/mapper/$MAPPER_NAME"
SENTINEL="${VITA_LUKS_SENTINEL:-/var/lib/vita/luks/persist.sentinel}"
SOURCE_FILE="${VITA_LUKS_SOURCE_FILE:-/run/vita-luks/source}"
RECOVERY_HELPER="${VITA_LUKS_RECOVERY_HELPER:-/usr/lib/vita/luks/recovery-unlock.sh}"
TPM_HELPER="${VITA_LUKS_TPM_HELPER:-/usr/lib/vita/luks/tpm-seal.sh}"
SHARE_DIR="${VITA_RECOVERY_SHARE_DIR:-/usr/lib/vita/luks/recovery-shares}"

fail_marker() {
  local step="$1"
  local rc="$2"
  echo "VITA-LUKS-ERROR: reason=${step}:${rc} status=FAILSAFE"
  exit 1
}

fail_tpm_seal() {
  local step="$1"
  local rc="$2"
  echo "VITA-TPM-SEAL-ERROR: reason=${step}:${rc} status=FAILSAFE"
  exit 1
}

cleanup_mapper() {
  local name="$1"
  cryptsetup status "$name" >/dev/null 2>&1 && cryptsetup luksClose "$name" >/dev/null 2>&1 || true
}

join_paths() {
  local sep="" out="" p
  for p in "$@"; do
    out="${out}${sep}${p}"
    sep=" "
  done
  printf '%s' "$out"
}

recovery_threshold() {
  local first="$1" line
  while IFS= read -r line || [ -n "$line" ]; do
    line="${line%$'\r'}"
    case "$line" in
      threshold=*) printf '%s' "${line#threshold=}"; return 0 ;;
    esac
  done <"$first"
  return 1
}

measure_recovery_open() {
  local mapper="vita-data-recovery-marker-$$"
  cleanup_mapper "$mapper"
  if env VITA_LUKS_OUTER_DEVICE="$OUTER_DEVICE" \
    VITA_LUKS_MAPPER_NAME="$mapper" \
    VITA_LUKS_SOURCE_FILE="/run/vita-luks/recovery-marker-source" \
    VITA_RECOVERY_SHARE_DIR="$SHARE_DIR" \
    VITA_RECOVERY_AUTO=1 \
    /bin/bash "$RECOVERY_HELPER" open >/dev/null 2>&1; then
    if cryptsetup status "$mapper" >/dev/null 2>&1; then
      cleanup_mapper "$mapper"
      return 0
    fi
    return 1
  fi
  return "$?"
}

measure_wrong_recovery_fails() {
  shopt -s nullglob
  local shares=("$SHARE_DIR"/share-*.env)
  shopt -u nullglob
  [ "${#shares[@]}" -gt 0 ] || return 1
  local threshold
  threshold="$(recovery_threshold "${shares[0]}")" || return 1
  local below_count=$((threshold - 1))
  local -a below=()
  if [ "$below_count" -gt 0 ]; then
    below=("${shares[@]:0:$below_count}")
  fi

  local mapper="vita-data-recovery-wrong-marker-$$"
  cleanup_mapper "$mapper"
  if env VITA_LUKS_OUTER_DEVICE="$OUTER_DEVICE" \
    VITA_LUKS_MAPPER_NAME="$mapper" \
    VITA_LUKS_SOURCE_FILE="/run/vita-luks/recovery-wrong-marker-source" \
    VITA_RECOVERY_SHARE_DIR="$SHARE_DIR" \
    VITA_RECOVERY_SHARE_PATHS="$(join_paths "${below[@]}")" \
    /bin/bash "$RECOVERY_HELPER" open >/dev/null 2>&1; then
    cleanup_mapper "$mapper"
    return 1
  fi
  if cryptsetup status "$mapper" >/dev/null 2>&1; then
    cleanup_mapper "$mapper"
    return 1
  fi
  return 0
}

measure_wrong_tpm_policy_fails() {
  local mapper="vita-data-tpm-wrong-marker-$$"
  cleanup_mapper "$mapper"
  if env VITA_LUKS_OUTER_DEVICE="$OUTER_DEVICE" \
    VITA_LUKS_MAPPER_NAME="$mapper" \
    VITA_LUKS_SOURCE_FILE="/run/vita-luks/tpm-wrong-marker-source" \
    VITA_TPM2_PCRS="${VITA_TPM2_WRONG_PCRS:-0+1+2+3+4+5+6}" \
    /bin/bash "$TPM_HELPER" open >/dev/null 2>&1; then
    cleanup_mapper "$mapper"
    return 1
  fi
  if cryptsetup status "$mapper" >/dev/null 2>&1; then
    cleanup_mapper "$mapper"
    return 1
  fi
  return 0
}

if cryptsetup isLuks --type luks2 "$OUTER_DEVICE" >/dev/null 2>&1; then
  :
else
  fail_marker "encrypted_is_luks2" "$?"
fi

if cryptsetup status "$MAPPER_NAME" >/dev/null 2>&1; then
  :
else
  fail_marker "mapper_status" "$?"
fi

if [ ! -e "$MAPPER_DEVICE" ]; then
  fail_marker "mapper_device_missing" 1
fi

if mountpoint -q /var; then
  :
else
  fail_marker "var_mountpoint" "$?"
fi

mount_source="$(findmnt -n -o SOURCE --target /var)" || fail_marker "findmnt_var" "$?"
if [ -z "$mount_source" ]; then
  fail_marker "findmnt_var_empty" 1
fi

mapper_real="$(readlink -f "$MAPPER_DEVICE")" || fail_marker "mapper_realpath" "$?"
source_real="$(readlink -f "$mount_source")" || fail_marker "source_realpath" "$?"
outer_real="$(readlink -f "$OUTER_DEVICE")" || fail_marker "outer_realpath" "$?"

if [ "$source_real" != "$mapper_real" ]; then
  fail_marker "var_not_on_mapper" 1
fi
if [ "$source_real" = "$outer_real" ]; then
  fail_marker "var_on_outer_plaintext" 1
fi

source_name=""
if [ -r "$SOURCE_FILE" ]; then
  source_name="$(tr -d '[:space:]' <"$SOURCE_FILE")"
fi
if [ "$source_name" != "tpm2" ]; then
  fail_tpm_seal "sealed_source_${source_name:-missing}" 1
fi

if measure_recovery_open; then
  :
else
  rc=$?
  fail_tpm_seal "recovery_open" "$rc"
fi
if measure_wrong_recovery_fails; then
  :
else
  rc=$?
  fail_tpm_seal "wrong_recovery_opened" "$rc"
fi
if measure_wrong_tpm_policy_fails; then
  :
else
  rc=$?
  fail_tpm_seal "wrong_tpm_policy_opened" "$rc"
fi

echo "VITA-TPM-SEAL: sealed=OK recovery=OK wrong-key=fail-closed status=OK"

if [ -f "$SENTINEL" ]; then
  echo "VITA-LUKS: encrypted=OK unlocked=OK persists=OK tpm=OK recovery=OK status=OK"
  exit 0
fi

mkdir -p "$(dirname -- "$SENTINEL")" || fail_marker "sentinel_mkdir" "$?"
printf 'VITA-LUKS persistent sentinel\n' >"$SENTINEL" || fail_marker "sentinel_write" "$?"
sync
echo "VITA-LUKS-PENDING: encrypted=OK unlocked=OK persists=awaiting-second-boot tpm=OK recovery=OK status=PENDING"
