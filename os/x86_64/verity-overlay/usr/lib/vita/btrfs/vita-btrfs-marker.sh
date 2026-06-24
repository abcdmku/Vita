#!/bin/bash
# Measured VITA-BTRFS marker.
#
# Rollback is a real, byte-measured ROUND-TRIP driven through agentd's
# storage.snapshot apply path against the top-level @data subvolume entry:
#   write sentinel A (node.config prior) -> agentd snapshots @data BEFORE the
#   apply (the keystone read-only rollback target) -> node.config apply mutates
#   @data (sentinel B) -> agentd rollback swaps @data to the keystone (A restored,
#   B gone) -> we MEASURE that the restored @data byte-matches the prior state.
#
# The booted /var is mounted on the @data subvolume by inode, not by name, so a
# bare RENAME_EXCHANGE of the top-level @data entry would leave the live /var
# pinned to the post-apply subvolume while @data points at the rolled-back one —
# a DIVERGED /var. To avoid that, after measuring the rollback we RECONCILE: the
# top-level @data entry is swapped back to the very subvolume /var is pinned to
# (so @data and /var reference the SAME subvolume again) and the node.config
# bytes are restored to their pre-marker value. All swaps act on the top-level
# btrfs mount at $TOP — the live /var mount handle is NEVER unmounted or
# remounted, so the boot is left consistent for every later unit. (A production
# rollback that must persist takes effect on the next boot, when /var re-resolves
# @data; the marker proves the mechanism without tearing the running /var.)
set -euo pipefail

TOP="${VITA_BTRFS_TOP:-/run/vita-btrfs-marker}"
WORKDIR="/var/lib/vita/btrfs-marker"
AGENTD_SOCKET="${VITA_AGENTD_SOCKET:-/run/vita-agent/agentd.sock}"
NODE_CONFIG="/var/lib/vita-agent/node-config.env"

fail_marker() {
  local step="$1"
  local rc="$2"
  echo "VITA-BTRFS-ERROR: reason=${step}:${rc} status=FAILSAFE"
  exit 1
}

run_step() {
  local step="$1"
  shift
  "$@" || fail_marker "$step" "$?"
}

write_agent_apply_helper() {
  cat >"$WORKDIR/agent-apply.mjs" <<'DENO'
const socketPath = Deno.args[0] ?? "";
const body = Deno.args[1] ?? "";
const encoder = new TextEncoder();
const decoder = new TextDecoder();

async function writeAll(conn, data) {
  let offset = 0;
  while (offset < data.length) {
    const written = await conn.write(data.subarray(offset));
    if (written <= 0) throw new Error("socket write made no progress");
    offset += written;
  }
}

function concat(chunks, total) {
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

function decodeChunked(bodyText) {
  let rest = bodyText;
  let decoded = "";
  while (true) {
    const lineEnd = rest.indexOf("\r\n");
    if (lineEnd < 0) throw new Error("chunked response missing chunk header");
    const size = Number.parseInt(rest.slice(0, lineEnd).split(";", 1)[0] ?? "", 16);
    if (!Number.isFinite(size) || size < 0) throw new Error("chunked response has invalid size");
    if (size === 0) return decoded;
    const start = lineEnd + 2;
    const end = start + size;
    if (rest.length < end + 2 || rest.slice(end, end + 2) !== "\r\n") {
      throw new Error("chunked response has incomplete chunk");
    }
    decoded += rest.slice(start, end);
    rest = rest.slice(end + 2);
  }
}

function parseResponse(raw) {
  const headerEnd = raw.indexOf("\r\n\r\n");
  if (headerEnd < 0) throw new Error("agentd response missing headers");
  const headerLines = raw.slice(0, headerEnd).split("\r\n");
  const statusMatch = /^HTTP\/1\.[01] ([0-9]{3})(?:\s|$)/.exec(headerLines[0] ?? "");
  if (statusMatch === null) throw new Error("agentd response has invalid status");
  const headers = new Map();
  for (const line of headerLines.slice(1)) {
    const sep = line.indexOf(":");
    if (sep > 0) headers.set(line.slice(0, sep).trim().toLowerCase(), line.slice(sep + 1).trim().toLowerCase());
  }
  let responseBody = raw.slice(headerEnd + 4);
  if ((headers.get("transfer-encoding") ?? "").split(",").map((v) => v.trim()).includes("chunked")) {
    responseBody = decodeChunked(responseBody);
  }
  return { body: responseBody, status: Number.parseInt(statusMatch[1], 10) };
}

try {
  if (socketPath === "") throw new Error("agentd socket path is required");
  if (body === "") throw new Error("apply body is required");
  const conn = await Deno.connect({ transport: "unix", path: socketPath });
  try {
    const bodyBytes = encoder.encode(body);
    const header = encoder.encode([
      "POST /apply HTTP/1.1",
      "Host: agentd",
      "Connection: close",
      "Content-Type: application/json",
      `Content-Length: ${bodyBytes.length}`,
      "",
      "",
    ].join("\r\n"));
    await writeAll(conn, header);
    await writeAll(conn, bodyBytes);

    const chunks = [];
    const buffer = new Uint8Array(4096);
    let total = 0;
    while (true) {
      const read = await conn.read(buffer);
      if (read === null) break;
      total += read;
      if (total > 1048576) throw new Error("agentd response exceeded marker limit");
      chunks.push(buffer.slice(0, read));
    }
    const parsed = parseResponse(decoder.decode(concat(chunks, total)));
    if (parsed.status !== 200) {
      console.error(parsed.body);
      Deno.exit(2);
    }
    await Deno.stdout.write(encoder.encode(parsed.body));
  } finally {
    conn.close();
  }
} catch (cause) {
  console.error(cause instanceof Error ? cause.message : String(cause));
  Deno.exit(1);
}
DENO
}

agent_apply() {
  local payload="$1"
  local output="$2"
  env DENO_DIR=/run/vita-btrfs-marker-deno DENO_NO_UPDATE_CHECK=1 NO_COLOR=1 \
    /usr/lib/vita/deno run --no-remote --cached-only --no-config --quiet \
    --allow-read="$AGENTD_SOCKET" --allow-write="$AGENTD_SOCKET" \
    "$WORKDIR/agent-apply.mjs" "$AGENTD_SOCKET" "$payload" >"$output"
}

# The quota exercise runs against a DEDICATED throwaway subvolume the marker
# creates and destroys (never the live @data/S0 data plane), so the live /var
# quota state is left exactly as found. QUOTA_TEST_SUBVOL is set once that
# subvolume exists so cleanup can tear it down on EVERY exit path (success,
# fail_marker, or an unexpected set -e abort).
QUOTA_TEST_SUBVOL=""

cleanup() {
  set +e
  if [ -n "$QUOTA_TEST_SUBVOL" ] && [ -d "$QUOTA_TEST_SUBVOL" ]; then
    # Clear the limit defensively, then delete the throwaway subvolume. Neither
    # call touches @data — the qgroup limit was only ever set on this test
    # subvolume, so the live /var quota is left exactly as the marker found it.
    btrfs qgroup limit none "$QUOTA_TEST_SUBVOL" >/dev/null 2>&1
    btrfs subvolume delete "$QUOTA_TEST_SUBVOL" >/dev/null 2>&1
  fi
  mountpoint -q "$TOP" && umount "$TOP" >/dev/null 2>&1
}
trap cleanup EXIT

mountpoint -q /var || fail_marker "var_mountpoint" "$?"

fstype="$(findmnt -n -o FSTYPE --target /var)" || fail_marker "findmnt_fstype" "$?"
source="$(findmnt -n -o SOURCE --target /var)" || fail_marker "findmnt_source" "$?"
options="$(findmnt -n -o OPTIONS --target /var)" || fail_marker "findmnt_options" "$?"

[ "$fstype" = "btrfs" ] || fail_marker "var_not_btrfs" 1
case ",$options," in
  *,subvol=/@data,*|*,subvol=@data,*) ;;
  *) fail_marker "var_not_atdata" 1 ;;
esac

run_step "top_mkdir" mkdir -p "$TOP"
if ! mountpoint -q "$TOP"; then
  run_step "top_mount" mount -t btrfs -o subvolid=5,compress=zstd:1 "$source" "$TOP"
fi

[ -d "$TOP/@data" ] || fail_marker "data_subvolume_missing" 1
[ -d "$TOP/@snapshots" ] || fail_marker "snapshots_subvolume_missing" 1
run_step "workdir_mkdir" mkdir -p "$WORKDIR"
run_step "deno_dir_mkdir" mkdir -p /run/vita-btrfs-marker-deno
run_step "agent_apply_helper" write_agent_apply_helper
run_step "agentd_socket" test -S "$AGENTD_SOCKET"

stamp="$(date -u +%Y%m%dT%H%M%SZ)-$$"
snap="marker-$stamp"

run_step "snapshot_create" btrfs subvolume snapshot -r "$TOP/@data" "$TOP/@snapshots/$snap"
ro="$(btrfs property get -ts "$TOP/@snapshots/$snap" ro 2>/dev/null)" || fail_marker "snapshot_ro_probe" "$?"
printf '%s\n' "$ro" | grep -Fq "ro=true" || fail_marker "snapshot_not_readonly" 1

# MEASURE quota enforcement against a DEDICATED throwaway subvolume, never the
# live @data/S0 data plane. A qgroup limit set on @data would (a) permanently
# cap the real /var, and (b) EDQUOT-failsafe on any non-fresh /var already over
# the cap. Instead create a fresh sibling subvolume on the SAME btrfs filesystem
# (so qgroups behave identically), set the limit there, prove an under-limit
# write succeeds and an over-limit write fails (EDQUOT/ENOSPC), then clear the
# limit and destroy the subvolume. The cleanup trap also tears it down on any
# early exit, so the live /var quota is left EXACTLY as found on every path.
quota_test="$TOP/@quota-test-$stamp"
run_step "quota_test_subvol_create" btrfs subvolume create "$quota_test"
QUOTA_TEST_SUBVOL="$quota_test"
run_step "quota_limit" btrfs qgroup limit 32M "$quota_test"
run_step "quota_under_write" dd if=/dev/zero of="$quota_test/quota-under.bin" bs=1M count=1 conv=fsync status=none
if dd if=/dev/zero of="$quota_test/quota-over.bin" bs=1M count=64 conv=fsync status=none >/dev/null 2>&1; then
  fail_marker "quota_not_enforced" 1
fi
run_step "quota_under_cleanup" rm -f "$quota_test/quota-under.bin" "$quota_test/quota-over.bin"
# Clear the limit and destroy the throwaway subvolume now (cleanup trap is the
# belt-and-suspenders for early exits); leave nothing behind on the data plane.
run_step "quota_limit_clear" btrfs qgroup limit none "$quota_test"
run_step "quota_test_subvol_delete" btrfs subvolume delete "$quota_test"
QUOTA_TEST_SUBVOL=""

prior_node="$WORKDIR/node-config.before"
prior_exists=0
if [ -f "$NODE_CONFIG" ]; then
  run_step "node_config_prior_copy" cp "$NODE_CONFIG" "$prior_node"
  prior_exists=1
fi

desired_mode="maintenance"
desired_remote="enabled"
if [ -f "$NODE_CONFIG" ] && grep -Fxq "mode=maintenance" "$NODE_CONFIG"; then
  desired_mode="normal"
  desired_remote="disabled"
fi

touch "$WORKDIR/preapply-start.stamp" || fail_marker "preapply_stamp" "$?"
apply_payload='{"operations":[{"capability":"node.config","request":{"desired":{"mode":"'"$desired_mode"'","remoteAccess":"'"$desired_remote"'"}}}]}'
apply_output="$WORKDIR/node-config-apply.response.json"
set +e
agent_apply "$apply_payload" "$apply_output"
rc="$?"
set -e
[ "$rc" -eq 0 ] || fail_marker "agent_apply_node_config" "$rc"
grep -Fq '"outcome":"committed"' "$apply_output" || fail_marker "agent_apply_not_committed" 1
grep -Fxq "mode=$desired_mode" "$NODE_CONFIG" || fail_marker "node_config_mode_not_applied" 1
grep -Fxq "remote_access=$desired_remote" "$NODE_CONFIG" || fail_marker "node_config_remote_not_applied" 1

preapply_snap=""
for candidate in "$TOP"/@snapshots/vita-*-apply; do
  [ -d "$candidate" ] || continue
  [ "$candidate" -nt "$WORKDIR/preapply-start.stamp" ] || continue
  preapply_snap="$(basename -- "$candidate")"
done
[ -n "$preapply_snap" ] || fail_marker "preapply_snapshot_missing" 1
ro="$(btrfs property get -ts "$TOP/@snapshots/$preapply_snap" ro 2>/dev/null)" || fail_marker "preapply_snapshot_ro_probe" "$?"
printf '%s\n' "$ro" | grep -Fq "ro=true" || fail_marker "preapply_snapshot_not_readonly" 1

# Record the subvolume /var is pinned to BEFORE the rollback swap. /var is mounted
# on the @data subvolume by inode; this id lets us prove afterwards that @data was
# reconciled back to the very subvolume /var still references (no diverged /var).
var_subvol_id="$(btrfs inspect-internal rootid /var 2>/dev/null)" || fail_marker "var_rootid_probe" "$?"
[ -n "$var_subvol_id" ] || fail_marker "var_rootid_empty" 1

rollback_payload='{"operations":[{"capability":"storage.snapshot","request":{"desired":{"op":"rollback","name":"'"$preapply_snap"'"}}}]}'
rollback_output="$WORKDIR/rollback-apply.response.json"
set +e
agent_apply "$rollback_payload" "$rollback_output"
rc="$?"
set -e
[ "$rc" -eq 0 ] || fail_marker "agent_apply_rollback" "$rc"
grep -Fq '"outcome":"committed"' "$rollback_output" || fail_marker "agent_rollback_not_committed" 1

# MEASURE the rollback restored the prior bytes on the top-level @data entry (the
# subvolume @data now points at after agentd's RENAME_EXCHANGE). This is the real
# rollback round-trip: A was snapshotted, B was applied, the swap restored A.
restored_node="$TOP/@data/lib/vita-agent/node-config.env"
if [ "$prior_exists" -eq 1 ]; then
  cmp -s "$prior_node" "$restored_node" || fail_marker "rollback_mismatch" 1
else
  [ ! -e "$restored_node" ] || fail_marker "rollback_left_node_config" 1
fi

# RECONCILE so the boot is left consistent (no diverged /var). After agentd's
# swap, the top-level @data entry points at the restored (pre-apply) subvolume,
# but /var is still pinned to the post-apply subvolume — which agentd's swap moved
# under @snapshots/<...-rollback-restore>. Swap @data back to that subvolume so
# @data and /var reference the SAME subvolume again. This acts only on the
# top-level mount at $TOP; the live /var mount is never unmounted/remounted.
restore_snap=""
for candidate in "$TOP"/@snapshots/vita-*-rollback-restore; do
  [ -d "$candidate" ] || continue
  [ "$candidate" -nt "$WORKDIR/preapply-start.stamp" ] || continue
  restore_snap="$(basename -- "$candidate")"
done
[ -n "$restore_snap" ] || fail_marker "reconcile_restore_snapshot_missing" 1
run_step "reconcile_swap_back" mv --exchange "$TOP/@data" "$TOP/@snapshots/$restore_snap"

# Prove the reconciliation: the top-level @data entry must now reference the exact
# subvolume /var is pinned to (same rootid) — i.e. /var and @data are no longer
# diverged. A unique sentinel written through the live /var mount must therefore
# appear under $TOP/@data, and disappear from both when removed.
data_subvol_id="$(btrfs inspect-internal rootid "$TOP/@data" 2>/dev/null)" || fail_marker "data_rootid_probe" "$?"
[ "$data_subvol_id" = "$var_subvol_id" ] || fail_marker "var_data_diverged" 1
sentinel="$WORKDIR/.reconcile-sentinel-$stamp"
recon_token="reconciled-$stamp"
run_step "reconcile_sentinel_write" sh -c 'printf "%s\n" "$2" > "$1"' _ "$sentinel" "$recon_token"
sentinel_in_data="$TOP/@data/lib/vita/btrfs-marker/$(basename -- "$sentinel")"
grep -Fxq "$recon_token" "$sentinel_in_data" || fail_marker "var_data_not_same_subvolume" 1
rm -f "$sentinel"
[ ! -e "$sentinel_in_data" ] || fail_marker "var_data_sentinel_residue" 1

# Restore node.config to its true pre-marker bytes so the live system is left
# exactly as the marker found it (the marker's node.config mutation is undone).
if [ "$prior_exists" -eq 1 ]; then
  run_step "node_config_restore" cp "$prior_node" "$NODE_CONFIG"
else
  rm -f "$NODE_CONFIG"
fi

echo "VITA-BTRFS: subvol=@data snapshot=OK rollback=restored quota=enforced status=OK"
