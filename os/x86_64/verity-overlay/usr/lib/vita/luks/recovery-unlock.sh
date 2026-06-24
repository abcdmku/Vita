#!/bin/bash
# Vita LUKS recovery unlock helper.
#
# Recovery shares are owner/test-presented at unlock time. They are not baked
# into the rootfs. This helper delegates quorum validation and passphrase
# reconstruction to the Go recovery combiner staged from the agent package.
set -euo pipefail

OUTER_DEVICE="${VITA_LUKS_OUTER_DEVICE:-/dev/disk/by-partlabel/vita-data}"
MAPPER_NAME="${VITA_LUKS_MAPPER_NAME:-vita-data}"
SHARE_DIR="${VITA_RECOVERY_SHARE_DIR:-/run/vita-recovery-shares}"
SHARE_9P_TAG="${VITA_RECOVERY_SHARE_9P_TAG:-vita-recovery-shares}"
COMBINER="${VITA_RECOVERY_COMBINER:-/usr/lib/vita/recovery-combine}"
SOURCE_FILE="${VITA_LUKS_SOURCE_FILE:-/run/vita-luks/source}"

fail() {
  echo "recovery-unlock: $*" >&2
  return 1
}

has_share_files() {
  shopt -s nullglob
  local files=("$SHARE_DIR"/share-*.env)
  shopt -u nullglob
  [ "${#files[@]}" -gt 0 ]
}

ensure_recovery_shares() {
  if has_share_files; then
    return 0
  fi

  mkdir -p "$SHARE_DIR" || return 1
  if [ -n "$SHARE_9P_TAG" ] && command -v mount >/dev/null 2>&1 && ! mountpoint -q "$SHARE_DIR"; then
    mount -t 9p -o trans=virtio,version=9p2000.L,ro "$SHARE_9P_TAG" "$SHARE_DIR" >/dev/null 2>&1 || true
  fi

  has_share_files || fail "no_recovery_shares_presented:$SHARE_DIR"
}

combine_passphrase() {
  [ -x "$COMBINER" ] || fail "combiner_not_executable:$COMBINER" || return 1
  ensure_recovery_shares || return 1

  local -a args=("$COMBINER" combine --share-dir "$SHARE_DIR")
  if [ "${VITA_RECOVERY_AUTO:-0}" = "1" ]; then
    args+=(--auto)
  elif [ -n "${VITA_RECOVERY_SHARE_PATHS:-}" ]; then
    local -a presented_files=()
    # shellcheck disable=SC2206
    presented_files=($VITA_RECOVERY_SHARE_PATHS)
    args+=(-- "${presented_files[@]}")
  else
    fail "no_recovery_shares_presented"
    return 1
  fi

  "${args[@]}"
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
    ensure_recovery_shares >/dev/null
    ;;
  *)
    echo "usage: $0 [open|combine-passphrase|probe]" >&2
    exit 64
    ;;
esac
