#!/bin/bash
# Host-side power-cut harness for P1-088. This uses a loopback ext4 image and
# kill -9 + remount/drop-caches to approximate a hard reset; the QEMU boot loop
# remains the decisive orchestrator floor.
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
if REPO_REL="$(git rev-parse --path-format=relative --show-toplevel 2>/dev/null)" && [ -n "$REPO_REL" ]; then
  REPO="${REPO_REL%/}"
  [ -n "$REPO" ] || REPO="."
else
  REPO="$(cd -- "$SCRIPT_DIR/../../.." && pwd -P)"
fi

CYCLES="${VITA_POWERCUT_CYCLES:-20}"
OUT="$REPO/os/x86_64/out/powercut"
AGENTD="$OUT/agentd"

fail() {
  echo "VITA-POWERCUT-ERROR: cycle=${1:-0} reason=${2:-unknown} status=FAILSAFE" >&2
  exit 1
}

skip() {
  echo "SKIP: $*"
  exit 0
}

if [ "$(id -u)" -ne 0 ]; then
  skip "root/loop power-cut exercise requires root; QEMU hard-reset floor runs separately"
fi

for cmd in node losetup mkfs.ext4 mount umount mountpoint truncate sync; do
  command -v "$cmd" >/dev/null 2>&1 || skip "root/loop power-cut exercise needs '$cmd'"
done

if ! losetup -f >/dev/null 2>&1; then
  skip "no free loop devices"
fi

mkdir -p "$OUT"
node "$REPO/tools/build/go-in-docker.mjs" --dir agent build -trimpath -buildvcs=false -o /work/os/x86_64/out/powercut/agentd ./cmd/agentd
[ -x "$AGENTD" ] || fail 0 "agentd_build_missing"

TMP="$(mktemp -d)"
IMG="$TMP/vita-data.img"
MNT="$TMP/mnt"
LOOP=""

cleanup() {
  set +e
  if [ -n "${writer_pid:-}" ]; then
    kill -9 "$writer_pid" >/dev/null 2>&1
    wait "$writer_pid" >/dev/null 2>&1
  fi
  mountpoint -q "$MNT" && umount "$MNT"
  [ -n "$LOOP" ] && losetup -d "$LOOP" >/dev/null 2>&1
  rm -rf "$TMP"
}
trap cleanup EXIT

mkdir -p "$MNT"
truncate -s 128M "$IMG"
LOOP="$(losetup --find --show "$IMG")"
mkfs.ext4 -F -L vita-data "$LOOP" >/dev/null
mount "$LOOP" "$MNT"

drop_volatile_cache() {
  sync
  if [ -w /proc/sys/vm/drop_caches ]; then
    echo 3 >/proc/sys/vm/drop_caches || true
  fi
}

state_root() {
  printf '%s\n' "$MNT/var/lib/vita-agent"
}

wait_for_first_commit() {
  local root="$1"
  local i
  for i in $(seq 1 200); do
    [ -s "$root/powercut-marker.json" ] && return 0
    sleep 0.02
  done
  return 1
}

intact=0
for cycle in $(seq 1 "$CYCLES"); do
  STATE="$(state_root)"
  mkdir -p "$STATE"

  VITA_POWERCUT_STATE_ROOT="$STATE" "$AGENTD" powercut-writer >"$TMP/writer-$cycle.log" 2>&1 &
  writer_pid=$!
  wait_for_first_commit "$STATE" || fail "$cycle" "writer_no_committed_state"
  sleep 0.05
  kill -9 "$writer_pid" >/dev/null 2>&1 || true
  wait "$writer_pid" >/dev/null 2>&1 || true
  unset writer_pid

  drop_volatile_cache
  umount "$MNT" || fail "$cycle" "umount_after_cut"
  blockdev --flushbufs "$LOOP" >/dev/null 2>&1 || true
  mount "$LOOP" "$MNT" || fail "$cycle" "remount_after_cut"

  STATE="$(state_root)"
  output="$(VITA_POWERCUT_STATE_ROOT="$STATE" "$AGENTD" powercut-marker 2>&1)" || {
    printf '%s\n' "$output" >&2
    fail "$cycle" "marker_recovery"
  }
  case "$output" in
    *"VITA-POWERCUT: "*" intact=OK status=OK"*)
      intact=$((intact + 1))
      ;;
    *)
      printf '%s\n' "$output" >&2
      fail "$cycle" "marker_not_ok"
      ;;
  esac
done

STATE="$(state_root)"
cp "$STATE/powercut-marker.json" "$TMP/good-marker.json"
cp "$STATE/audit-log.json" "$TMP/good-audit.json"
cp "$STATE/pds-repo.json" "$TMP/good-pds-repo.json"
printf '[' >"$STATE/audit-log.json"
if VITA_POWERCUT_STATE_ROOT="$STATE" "$AGENTD" powercut-marker >"$TMP/corrupt-audit.out" 2>&1; then
  cat "$TMP/corrupt-audit.out" >&2
  fail "$CYCLES" "corrupt_audit_accepted"
fi
cp "$TMP/good-audit.json" "$STATE/audit-log.json"
cp "$TMP/good-marker.json" "$STATE/powercut-marker.json"
printf 'partial temp\n' >"$STATE/.powercut-marker-planted.tmp"
: >"$STATE/powercut-marker.json"
if VITA_POWERCUT_STATE_ROOT="$STATE" "$AGENTD" powercut-marker >"$TMP/corrupt-marker.out" 2>&1; then
  cat "$TMP/corrupt-marker.out" >&2
  fail "$CYCLES" "corrupt_marker_accepted"
fi
# NEGATIVE: a torn/partial pds-repo.json (the SECOND authoritative writer) must
# be rejected fail-closed on reload, never silently accepted as committed state.
cp "$TMP/good-marker.json" "$STATE/powercut-marker.json"
cp "$TMP/good-audit.json" "$STATE/audit-log.json"
printf 'partial temp\n' >"$STATE/.pds-repo-planted.tmp"
printf '{"repo":"did:plc:aaaaaaaaaaaaaaaaaaaaaaaa","records":[{"collection":"vita.power' >"$STATE/pds-repo.json"
if VITA_POWERCUT_STATE_ROOT="$STATE" "$AGENTD" powercut-marker >"$TMP/corrupt-pds.out" 2>&1; then
  cat "$TMP/corrupt-pds.out" >&2
  fail "$CYCLES" "corrupt_pds_repo_accepted"
fi
cp "$TMP/good-pds-repo.json" "$STATE/pds-repo.json"

if [ "$intact" -ne "$CYCLES" ]; then
  fail "$CYCLES" "intact_count_${intact}_of_${CYCLES}"
fi

echo "VITA-POWERCUT: cycles=${intact} intact=OK status=OK"
