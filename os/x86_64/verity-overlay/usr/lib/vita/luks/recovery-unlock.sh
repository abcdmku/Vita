#!/bin/bash
# Vita LUKS recovery unlock helper.
#
# TEST shares are simple offline quorum material: any threshold distinct enrolled
# shares reconstruct the same TEST recovery passphrase. This helper re-validates
# refs and quorum metadata before passing a temp keyfile to cryptsetup. It never
# composes commands from runtime text; share text only supplies validated data.
set -euo pipefail

OUTER_DEVICE="${VITA_LUKS_OUTER_DEVICE:-/dev/disk/by-partlabel/vita-data}"
MAPPER_NAME="${VITA_LUKS_MAPPER_NAME:-vita-data}"
SHARE_DIR="${VITA_RECOVERY_SHARE_DIR:-/usr/lib/vita/luks/recovery-shares}"
SOURCE_FILE="${VITA_LUKS_SOURCE_FILE:-/run/vita-luks/source}"

fail() {
  echo "recovery-unlock: $*" >&2
  return 1
}

valid_ref() {
  local value="$1"
  [ -n "$value" ] || return 1
  [ "${#value}" -le 2048 ] || return 1
  case "$value" in
    *[[:space:]\<\>\{\}\`\"]*|*"'"*|*'-----BEGIN'*|*'-----begin'*|data:*|inline:*|literal:*) return 1 ;;
  esac
  [[ "$value" =~ ^[A-Za-z0-9][A-Za-z0-9._:@-]{2,159}$ ]] || [[ "$value" =~ ^[a-z][a-z0-9+.-]*://.+$ ]]
}

valid_passphrase() {
  local value="$1"
  [ -n "$value" ] || return 1
  [ "${#value}" -le 256 ] || return 1
  [[ "$value" =~ ^[A-Za-z0-9+/]+={0,2}$ ]]
}

load_share() {
  local path="$1"
  share_id=""
  share_handle=""
  share_keystore=""
  share_threshold=""
  share_total=""
  share_passphrase=""

  [ -r "$path" ] || fail "share_not_readable:$path" || return 1

  local line key value
  while IFS= read -r line || [ -n "$line" ]; do
    line="${line%$'\r'}"
    case "$line" in
      ''|'#'*) continue ;;
    esac
    key="${line%%=*}"
    value="${line#*=}"
    [ "$key" != "$line" ] || fail "share_malformed:$path" || return 1
    case "$key" in
      VITA_RECOVERY_SHARE_VERSION)
        [ "$value" = "1" ] || fail "share_bad_version:$path" || return 1
        ;;
      VITA_RECOVERY_TEST_MATERIAL)
        [ "$value" = "1" ] || fail "share_not_test_material:$path" || return 1
        ;;
      id) share_id="$value" ;;
      handle) share_handle="$value" ;;
      keyStoreRef) share_keystore="$value" ;;
      threshold) share_threshold="$value" ;;
      total) share_total="$value" ;;
      passphraseBase64) share_passphrase="$value" ;;
      *) fail "share_unknown_field:$path:$key" || return 1 ;;
    esac
  done <"$path"

  valid_ref "$share_id" || fail "share_bad_id:$path" || return 1
  valid_ref "$share_handle" || fail "share_bad_handle:$path" || return 1
  valid_ref "$share_keystore" || fail "share_bad_key_store_ref:$path" || return 1
  case "$share_threshold" in ''|*[!0-9]*) fail "share_bad_threshold:$path" || return 1 ;; esac
  case "$share_total" in ''|*[!0-9]*) fail "share_bad_total:$path" || return 1 ;; esac
  [ "$share_threshold" -ge 1 ] || fail "share_threshold_nonpositive:$path" || return 1
  [ "$share_total" -ge "$share_threshold" ] || fail "share_total_below_threshold:$path" || return 1
  valid_passphrase "$share_passphrase" || fail "share_bad_passphrase:$path" || return 1
}

ref_key() {
  printf '%s\t%s\t%s' "$1" "$2" "$3"
}

load_allowed_quorum() {
  declare -gA allowed_refs=()
  declare -gA allowed_paths=()
  quorum_threshold=""
  quorum_total=""

  shopt -s nullglob
  local files=("$SHARE_DIR"/share-*.env)
  shopt -u nullglob
  [ "${#files[@]}" -gt 0 ] || fail "no_enrolled_shares:$SHARE_DIR" || return 1

  local f key
  for f in "${files[@]}"; do
    load_share "$f" || return 1
    if [ -z "$quorum_threshold" ]; then
      quorum_threshold="$share_threshold"
      quorum_total="$share_total"
    else
      [ "$share_threshold" = "$quorum_threshold" ] || fail "mixed_threshold:$f" || return 1
      [ "$share_total" = "$quorum_total" ] || fail "mixed_total:$f" || return 1
    fi
    key="$(ref_key "$share_id" "$share_handle" "$share_keystore")"
    [ -z "${allowed_refs[$key]+x}" ] || fail "duplicate_enrolled_share:$f" || return 1
    allowed_refs[$key]=1
    allowed_paths[$f]=1
  done
  [ "${#allowed_refs[@]}" -ge "$quorum_threshold" ] || fail "enrolled_below_threshold" || return 1
}

presented_share_paths() {
  if [ -n "${VITA_RECOVERY_SHARE_PATHS:-}" ]; then
    # shellcheck disable=SC2206
    presented_files=($VITA_RECOVERY_SHARE_PATHS)
    return 0
  fi
  if [ "${VITA_RECOVERY_AUTO:-0}" = "1" ]; then
    shopt -s nullglob
    local all=("$SHARE_DIR"/share-*.env)
    shopt -u nullglob
    presented_files=("${all[@]:0:$quorum_threshold}")
    return 0
  fi
  fail "no_recovery_shares_presented"
}

combine_passphrase() {
  load_allowed_quorum || return 1
  local -a presented_files=()
  presented_share_paths || return 1
  [ "${#presented_files[@]}" -gt 0 ] || fail "no_recovery_shares_presented" || return 1

  declare -A seen=()
  local matching=0 expected_passphrase="" f key
  for f in "${presented_files[@]}"; do
    load_share "$f" || return 1
    key="$(ref_key "$share_id" "$share_handle" "$share_keystore")"
    [ -n "${allowed_refs[$key]+x}" ] || fail "foreign_share:$f" || return 1
    [ -z "${seen[$key]+x}" ] || fail "duplicate_presented_share:$f" || return 1
    seen[$key]=1
    if [ -z "$expected_passphrase" ]; then
      expected_passphrase="$share_passphrase"
    else
      [ "$share_passphrase" = "$expected_passphrase" ] || fail "share_material_mismatch:$f" || return 1
    fi
    matching=$((matching + 1))
  done

  [ "$matching" -ge "$quorum_threshold" ] || fail "below_threshold:$matching/$quorum_threshold" || return 1
  printf '%s' "$expected_passphrase"
}

write_source() {
  mkdir -p "$(dirname -- "$SOURCE_FILE")"
  printf 'recovery\n' >"$SOURCE_FILE"
}

open_with_recovery() {
  if cryptsetup status "$MAPPER_NAME" >/dev/null 2>&1; then
    write_source
    return 0
  fi

  local passphrase tmp rc
  if ! passphrase="$(combine_passphrase)"; then
    return 2
  fi
  tmp="$(mktemp "${TMPDIR:-/run}/vita-recovery-key.XXXXXX")" || return 1
  chmod 400 "$tmp"
  printf '%s' "$passphrase" >"$tmp"
  if cryptsetup luksOpen --key-file "$tmp" "$OUTER_DEVICE" "$MAPPER_NAME"; then
    rm -f "$tmp"
    write_source
    echo "VITA-LUKS-SOURCE: recovery opened $MAPPER_NAME" >&2
    return 0
  fi
  rc=$?
  rm -f "$tmp"
  return "$rc"
}

case "${1:-open}" in
  open)
    open_with_recovery
    ;;
  combine-passphrase)
    combine_passphrase
    ;;
  probe)
    load_allowed_quorum >/dev/null
    ;;
  *)
    echo "usage: $0 [open|combine-passphrase|probe]" >&2
    exit 64
    ;;
esac
