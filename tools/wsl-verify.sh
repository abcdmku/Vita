#!/bin/bash
# Vita WSL verification driver — automates the build/boot verification that previously needed manual host steps.
# Runs inside the WSL "Borg51" Ubuntu (which IS the build host) as root, driven from Windows via:
#   wsl -d Ubuntu -u root bash -c "sed -i 's/\r//' <thisfile>; bash <thisfile> <mode>"
# Modes: tests | build | boot | smoke | full
#   tests  — TS acceptance suites under os/x86_64/test
#   build  — smoke mkosi build only (--no-boot), assert a disk is produced
#   boot   — headless QEMU boot of the EXISTING smoke disk, assert it reaches userspace
#   smoke  — build then headless boot
#   full   — full-mode build through verity-format (conversion + veritysetup), assert root hashes captured
#   secboot— adversarial Secure Boot enforcement matrix (positive enrolls+enforces; negatives rejected)
set -uo pipefail
REPO=/home/borg/Vita
MODE="${1:-smoke}"
cd "$REPO" || { echo "FAIL: $REPO missing"; exit 2; }
git config --global --add safe.directory "$REPO" >/dev/null 2>&1

echo "===== ENV ====="
echo "host=$(uname -n) user=$(id -un) kvm=$([ -e /dev/kvm ] && echo yes || echo no)"
for t in node mkosi qemu-system-x86_64 mkfs.ext4 veritysetup; do
  printf '%s=%s\n' "$t" "$(command -v "$t" 2>/dev/null || echo MISSING)"
done

echo "===== SYNC ====="
git pull --ff-only 2>&1 | tail -3
echo "HEAD=$(git rev-parse --short HEAD)"

run_tests() {
  echo "===== TS ACCEPTANCE ====="
  local rc=0
  for f in os/x86_64/test/*.test.ts; do
    out=$(node --experimental-strip-types --test "$f" 2>&1 | grep -E '^# (tests|pass|fail)' | tr '\n' ' ')
    fails=$(echo "$out" | grep -oE 'fail [0-9]+' | grep -oE '[0-9]+')
    printf '  %-34s %s\n' "$(basename "$f")" "$out"
    [ "${fails:-0}" != "0" ] && rc=1
  done
  return $rc
}

build_smoke() {
  echo "===== BUILD smoke (mkosi, --no-boot) ====="
  node os/x86_64/build-and-boot.mjs --mode=smoke --no-boot 2>&1 | tail -12
  local rc=${PIPESTATUS[0]}
  disk=$(ls -t "$REPO"/os/x86_64/out/*.raw 2>/dev/null | head -1)
  echo "build_rc=$rc disk=$disk"
  [ "$rc" = 0 ] && [ -f "$disk" ]
}

boot_headless() {
  disk=$(ls -t "$REPO"/os/x86_64/out/*.raw 2>/dev/null | head -1)
  [ -f "$disk" ] || { echo "RESULT: FAIL (no disk to boot)"; return 1; }
  echo "===== HEADLESS BOOT ($disk) ====="
  local code=/usr/share/OVMF/OVMF_CODE_4M.fd vars=/usr/share/OVMF/OVMF_VARS_4M.fd
  [ -f "$code" ] || { code=/usr/share/OVMF/OVMF_CODE.fd; vars=/usr/share/OVMF/OVMF_VARS.fd; }
  cp "$vars" "$REPO"/os/x86_64/out/OVMF_VARS.fd
  local log="$REPO"/os/x86_64/out/serial.log
  : > "$log"
  timeout 120 qemu-system-x86_64 -machine q35 -m 2048 -cpu host -enable-kvm \
    -drive if=pflash,format=raw,readonly=on,file="$code" \
    -drive if=pflash,format=raw,file="$REPO"/os/x86_64/out/OVMF_VARS.fd \
    -drive file="$disk",format=raw,if=virtio \
    -serial "file:$log" -display none -no-reboot >/dev/null 2>&1 &
  local qpid=$! ok=0 agent="" i
  # "fully up" = systemd reached the Multi-User target (or the login/root shell appeared).
  for i in $(seq 1 90); do
    if grep -qE 'Reached target[^|]*Multi-User|Startup finished in|root@localhost|bash-5\.[0-9]+[#$]' "$log" 2>/dev/null; then
      ok=1; echo "userspace-up marker found at ~${i}s"; break
    fi
    kill -0 "$qpid" 2>/dev/null || { echo "qemu exited early at ~${i}s"; break; }
    sleep 1
  done
  # If the vita-agentd unit is in the image (post P1-026), note whether it started.
  grep -qE 'vita-agentd' "$log" 2>/dev/null && agent=" | vita-agentd: $(grep -oE 'vita-agentd[^|]*' "$log" | tail -1)"
  kill "$qpid" 2>/dev/null; pkill -f qemu-system-x86_64 >/dev/null 2>&1
  echo "----- serial.log tail -----"
  tail -18 "$log" 2>/dev/null
  [ "$ok" = 1 ] && echo "RESULT: PASS (smoke boots to Multi-User)$agent" || { echo "RESULT: FAIL (no Multi-User marker in ${i}s)"; return 1; }
}

# P1-030 durable host-verify: prove the on-device TypeScript runtime actually EXECUTES. The vita-ts.service
# oneshot runs /usr/lib/vita/ts/main.ts under the pinned, hardened Deno and prints "VITA-TS: ..." to the serial.
# It's ordered after multi-user (After=vita-agentd) so the marker lands ~90s in — boot_headless's 90s window can
# miss it, hence a dedicated longer-window check. Guards against regressions like the seccomp/pkey SIGSYS kill.
boot_ts() {
  disk=$(ls -t "$REPO"/os/x86_64/out/*.raw 2>/dev/null | head -1)
  [ -f "$disk" ] || { echo "RESULT: FAIL (no disk to boot)"; return 1; }
  echo "===== TS-RUNTIME BOOT ($disk) ====="
  local code=/usr/share/OVMF/OVMF_CODE_4M.fd vars=/usr/share/OVMF/OVMF_VARS_4M.fd
  [ -f "$code" ] || { code=/usr/share/OVMF/OVMF_CODE.fd; vars=/usr/share/OVMF/OVMF_VARS.fd; }
  cp "$vars" "$REPO"/os/x86_64/out/OVMF_VARS.fd
  local log="$REPO"/os/x86_64/out/serial.log; : > "$log"
  local cpu="-cpu host -enable-kvm"; [ -e /dev/kvm ] || cpu="-cpu max"
  timeout 150 qemu-system-x86_64 -machine q35 -m 2048 $cpu \
    -drive if=pflash,format=raw,readonly=on,file="$code" \
    -drive if=pflash,format=raw,file="$REPO"/os/x86_64/out/OVMF_VARS.fd \
    -drive file="$disk",format=raw,if=virtio \
    -serial "file:$log" -display none -no-reboot >/dev/null 2>&1 &
  local qpid=$! ok=0 i
  # Wait for a COMMITTED PDS WRITE (the LAST marker — main() order ...APPLY -> CAPSULE-PREVIEW -> CAPSULE -> PDS read
  # -> PDS WRITE). Its presence implies the WHOLE on-device control-plane ran: eval/preview/explain (P1-033/34/37) +
  # connect/state read (P1-035/38) + APPLY commit&reject (P1-039) + capsule preview (P1-043) + capsule apply commit&
  # reject (P1-041) + PDS read (P1-040) + PDS write (P1-042). A failed tail shows *-ERROR and times out -> FAIL.
  # Wait until the chain's LATE markers are ALL present (the wave-4 merge REORDERED the chain: capsule
  # FETCH+EXECUTE+VOLUME now run inside emitCapsuleMarkers BEFORE the PDS markers + the forced APPLY-reject). Polling
  # for the completion SET (VOLUME mounted + PDS-WRITE committed + forced APPLY-reject) is order-robust and implies the
  # WHOLE control plane ran: eval/preview/explain + connect/state + APPLY commit&reject + capsule preview/apply + FETCH
  # (SRI-verified, P1-045) + capsule.execute (hardened transient unit, W4-S1) + per-capsule VOLUME (P1-046) + PDS r/w.
  for i in $(seq 1 150); do
    if grep -qa 'VITA-CAPSULE-EXECUTED:' "$log" 2>/dev/null \
       && grep -qa 'VITA-PDS-WRITE: outcome=committed' "$log" 2>/dev/null \
       && grep -qa 'VITA-APPLY: outcome=rejected' "$log" 2>/dev/null; then
      ok=1; echo "full chain late-markers present at ~${i}s"; break
    fi
    kill -0 "$qpid" 2>/dev/null || { echo "qemu exited early at ~${i}s"; break; }
    sleep 1
  done
  sleep 1  # grace for any trailing marker flush
  kill "$qpid" 2>/dev/null; pkill -f qemu-system-x86_64 >/dev/null 2>&1
  local ts ev pv ex cn st ac ar cpv cc cr pds pw cx cxr fe hl vo
  ts=$(grep -a 'VITA-TS:' "$log" | tail -1); ev=$(grep -a 'VITA-EVAL:' "$log" | tail -1)
  pv=$(grep -a 'VITA-PREVIEW:' "$log" | tail -1); ex=$(grep -a 'VITA-EXPLAIN:' "$log" | tail -1)
  cn=$(grep -aE 'VITA-CONNECT(-ERROR)?:' "$log" | tail -1); st=$(grep -aE 'VITA-STATE(-ERROR)?:' "$log" | tail -1)
  ac=$(grep -a 'VITA-APPLY: outcome=committed' "$log" | tail -1); ar=$(grep -a 'VITA-APPLY: outcome=rejected' "$log" | tail -1)
  cpv=$(grep -a 'VITA-CAPSULE-PREVIEW:' "$log" | tail -1)
  cc=$(grep -aE 'VITA-CAPSULE:.*outcome=committed' "$log" | tail -1); cr=$(grep -aE 'VITA-CAPSULE:.*outcome=rejected' "$log" | tail -1)
  pds=$(grep -aE 'VITA-PDS: ' "$log" | tail -1); pw=$(grep -a 'VITA-PDS-WRITE: outcome=committed' "$log" | tail -1)
  cx=$(grep -a 'VITA-CAPSULE-EXECUTED:' "$log" | tail -1); cxr=$(grep -a 'VITA-CAPSULE-EXECUTE-REJECT:' "$log" | tail -1)
  fe=$(grep -aE 'VITA-CAPSULE-FETCH:.*verified=OK' "$log" | tail -1); hl=$(grep -aE 'VITA-CAPSULE-HEALTH:' "$log" | tail -1)
  vo=$(grep -aE 'VITA-CAPSULE-VOLUME:.*mounted=OK' "$log" | tail -1)
  echo "----- markers -----"; for m in "$ts" "$ev" "$pv" "$ex" "$cn" "$st" "$ac" "$ar" "$cpv" "$cc" "$cr" "$pds" "$pw" "$cx" "$cxr" "$fe" "$hl" "$vo"; do echo "  $m"; done
  # PASS = the FULL on-device control plane THROUGH RUNNING A CAPSULE: ...+ PDS read/write + capsule.execute (the node
  # spawns a hardened transient-unit workload, W4-S1) + its fail-closed reject + FETCH (SRI-verified, P1-045) + capsule
  # HEALTH supervised via /state (P1-047) + a per-capsule persistent VOLUME via StateDirectory (P1-046). Node proposes; agent validates+spawns.
  if [ "$ok" = 1 ] && [ -n "$ts" ] && [ -n "$ev" ] && [ -n "$pv" ] && [ -n "$ex" ] && [ -n "$st" ] && [ -n "$ac" ] && [ -n "$ar" ] && [ -n "$cpv" ] && [ -n "$cc" ] && [ -n "$cr" ] && [ -n "$pds" ] && [ -n "$pw" ] && [ -n "$cx" ] && [ -n "$cxr" ] && [ -n "$fe" ] && [ -n "$hl" ] && [ -n "$vo" ]; then
    echo "RESULT: PASS (full control-plane on-device: fetch(SRI)+capsule.execute(hardened)+health-supervised+persistent-volume — the node fetched, ran, supervised, and gave durable state to a capsule)"
  else
    echo "RESULT: FAIL (missing a marker above; failures show *-ERROR)"
    sed -E 's/\x1b\[[0-9;]*m//g' "$log" | grep -aiE 'vita-(ts|eval|preview|explain|connect|state|apply|capsule|pds)|agentd|deno' | tail -28
    return 1
  fi
}

build_full() {
  echo "===== FULL build (rootfs -> ext4 -> verity-format) ====="
  node os/x86_64/build-and-boot.mjs --mode=full --no-sign 2>&1 | tail -30
  echo "(expected: stops at the UKI-binding gap AFTER capturing root hashes)"
  ls -l "$REPO"/os/x86_64/out/converted/ "$REPO"/os/x86_64/out/verity/ 2>&1 | tail -12
}

agent_build() {
  echo "===== P1-026 agentd reproducible build (go-in-docker --env passthrough) ====="
  mkdir -p "$REPO"/os/x86_64/out/agent
  # The exact command planAgentImage() emits. A bash array keeps the -ldflags value as one quoted arg.
  local cmd=(node tools/build/go-in-docker.mjs --dir agent
    --env CGO_ENABLED=0 --env GOOS=linux --env GOARCH=amd64 --env SOURCE_DATE_EPOCH=1781308800
    build -trimpath -buildvcs=false -ldflags "-s -w -buildid=" -o /work/os/x86_64/out/agent/agentd ./cmd/agentd)
  "${cmd[@]}" || { echo "RESULT: FAIL (build error)"; return 1; }
  local bin="$REPO"/os/x86_64/out/agent/agentd
  echo "--- file ---"; file "$bin"
  local h1 h2
  h1=$(sha256sum "$bin" | cut -d' ' -f1)
  "${cmd[@]}" >/dev/null 2>&1   # rebuild to check byte-reproducibility
  h2=$(sha256sum "$bin" | cut -d' ' -f1)
  echo "sha256 run1=$h1 run2=$h2"
  if file "$bin" | grep -q "statically linked" && [ "$h1" = "$h2" ]; then
    echo "RESULT: PASS (agentd static + byte-reproducible)"
  else
    echo "RESULT: FAIL (not static and/or not reproducible)"; return 1
  fi
}

diag() {
  local log="$REPO"/os/x86_64/out/serial.log
  [ -f "$log" ] || { echo "no serial.log"; return 1; }
  echo "===== last targets reached ====="
  sed -E 's/\x1b\[[0-9;]*m//g' "$log" | grep -oE 'Reached target [^.]+' | tail -8
  echo "===== last 'Starting …' (a hang shows as Starting with no later Started/Finished) ====="
  sed -E 's/\x1b\[[0-9;]*m//g' "$log" | grep -E 'Starting ' | tail -8
  echo "===== A start job is running / jobs ====="
  sed -E 's/\x1b\[[0-9;]*m//g' "$log" | grep -iE 'start job|job .* running|dependency' | tail -8
  echo "===== most-repeated lines (a respawn loop floods these) ====="
  sed -E 's/\x1b\[[0-9;]*m//g' "$log" | sed -E 's/\[[0-9 .]+\]//' | sort | uniq -c | sort -rn | head -6
  echo "===== multi-user / startup-finished / emergency (any case) ====="
  sed -E 's/\x1b\[[0-9;]*m//g' "$log" | grep -iE 'multi-user|startup finished|emergency|rescue|cannot|refus' | tail -6
  echo "===== boot-stall signals (debug: cycles / unstartable / waits) ====="
  sed -E 's/\x1b\[[0-9;]*m//g' "$log" | grep -aiE 'ordering cycle|breaking ordering|deleting job|unable to|isolat|found ordering cycle|job .* finished.*(failed|dependency)|installed new job .*(multi-user|sysinit|basic)' | tail -14
  echo "===== device/mount activity ====="
  sed -E 's/\x1b\[[0-9;]*m//g' "$log" | grep -aiE 'waiting for|timed out|\.device|\.mount.*(job|Waiting)|dev-disk' | tail -10
  echo "===== last 12 lines ====="
  sed -E 's/\x1b\[[0-9;]*m//g' "$log" | tail -12
}

# Fast, fully-introspectable boot WITHOUT QEMU: build the rootfs as a directory (base config is Format=directory)
# with the smoke + agent overlays, boot it in a systemd-nspawn container (~seconds), then introspect from the host
# (systemctl list-jobs/status/--failed). Catches service/agent hangs + verifies the agent without an interactive
# console — so the loop can self-verify. (Container env differs from QEMU for hardware/mount units; QEMU smoke
# remains the full-chain check.)
probe() {
  echo "===== nspawn service probe (no QEMU) ====="
  systemctl start systemd-machined 2>/dev/null
  cd "$REPO" || return 1   # agentd build needs cwd=REPO: go-in-docker mounts cwd at /work, so --dir agent => /work/agent
  mkdir -p os/x86_64/out/agent os/x86_64/agent-overlay/usr/lib/vita
  echo "--- build agentd ---"
  node tools/build/go-in-docker.mjs --dir agent \
    --env CGO_ENABLED=0 --env GOOS=linux --env GOARCH=amd64 --env SOURCE_DATE_EPOCH=1781308800 \
    build -trimpath -buildvcs=false -ldflags "-s -w -buildid=" -o /work/os/x86_64/out/agent/agentd ./cmd/agentd \
    || { echo "RESULT: FAIL (agentd build)"; return 1; }
  cp os/x86_64/out/agent/agentd os/x86_64/agent-overlay/usr/lib/vita/agentd
  echo "--- build rootfs directory (incremental) + overlays ---"
  cd os/x86_64 || return 1
  mkosi --directory . --force --incremental=yes --cache-dir "$PWD"/.cache --output-dir out \
    --extra-tree "$PWD"/smoke-overlay --extra-tree "$PWD"/agent-overlay --root-password=vita \
    --mirror https://deb.debian.org 2>&1 | tail -4 || { echo "RESULT: FAIL (mkosi directory)"; return 1; }
  local root="$PWD"/out/vita-debian-trixie-x86_64-root M=vitaprobe
  [ -d "$root" ] || { echo "RESULT: FAIL (no rootfs dir $root)"; return 1; }
  machinectl terminate "$M" 2>/dev/null; sleep 1
  echo "--- boot $M (systemd-nspawn) ---"
  systemd-nspawn --quiet -b -D "$root" --machine="$M" </dev/null >/tmp/nspawn-$M.log 2>&1 &
  local i state=""
  for i in $(seq 1 45); do
    state=$(systemctl -M "$M" is-system-running 2>/dev/null || true)
    case "$state" in running|degraded) break;; esac
    sleep 1
  done
  echo "is-system-running: ${state:-<none>} (after ~${i}s)"
  echo "--- list-jobs (any still 'running'/'waiting' = the hang) ---"; systemctl -M "$M" list-jobs --no-pager 2>&1 | head
  echo "--- failed units ---"; systemctl -M "$M" list-units --state=failed --no-pager 2>&1 | head
  echo "--- vita-agentd ---"; systemctl -M "$M" status vita-agentd --no-pager 2>&1 | head -14
  machinectl poweroff "$M" 2>/dev/null; sleep 2; machinectl terminate "$M" 2>/dev/null
  case "$state" in
    running|degraded) echo "RESULT: PASS (system up; see vita-agentd above)";;
    *) echo "RESULT: FAIL (system never came up — list-jobs shows the stuck unit)";;
  esac
}

# ── Secure Boot adversarial matrix ──────────────────────────────────────────────────────────────────
# Proves OUR TEST key is the enforced root of trust. virt-fw-vars enrolls PK=KEK=db (db.crt) into a
# fresh OVMF varstore OFFLINE (User Mode = enforcing); every row then boots off a copy of that one store:
#   POS    db-signed UKI -> boots to userspace (serial anchor: the enrolled rig boots a GOOD image).
#   N1     unsigned UKI            -> firmware rejects (no kernel start + a firmware reject witness).
#   N2     db-signed-then-tampered -> firmware rejects.
#   N3     rogue-key-signed UKI    -> firmware rejects (key not enrolled).
#   CTRLMS Vita-db-signed UKI on the MS code+vars pair -> REJECTED (db != MS-trusted; REQUIRED row).
# Enforcement is proven by the POS-boots / negatives-rejected contrast on the SAME enrolled store (a
# non-enforcing store would let the negatives boot -> they'd FAIL). N1/N2/N3 + CTRLMS boot in PARALLEL.
# Each row: FRESH vars copy + FRESH per-row serial log; an offline sbverify tri-state gate proves a
# well-formed-but-untrusted artifact exists BEFORE qemu (missing artifact => INVALID, never PASS).
SBDIR="$REPO/os/x86_64/.secureboot"
SBWORK="$REPO/os/x86_64/out/sb"
SBCODE_SB=/usr/share/OVMF/OVMF_CODE_4M.secboot.fd
SBVARS_BLANK=/usr/share/OVMF/OVMF_VARS_4M.fd
SBCODE_MS=/usr/share/OVMF/OVMF_CODE_4M.ms.fd
SBVARS_MS=/usr/share/OVMF/OVMF_VARS_4M.ms.fd

sb_accel() { [ -e /dev/kvm ] && echo kvm || echo tcg; }

# Boot one row. $1=label $2=disk.raw $3=code $4=vars-template $5=nonce $6=secs
# Seeds a FRESH writable vars copy and a FRESH log named per label. Echoes the log path.
sb_boot() {
  local label="$1" disk="$2" code="$3" varstmpl="$4" nonce="$5" secs="${6:-90}"
  local vars="$SBWORK/vars-$label.fd" log="$SBWORK/serial-$label.log"
  mkdir -p "$SBWORK"
  rm -f "$vars"; cp "$varstmpl" "$vars"
  : > "$log"
  local accel; accel=$(sb_accel)
  local cpu=(-cpu max)
  [ "$accel" = kvm ] && cpu=(-cpu host -enable-kvm)
  timeout "$secs" qemu-system-x86_64 -machine q35 -m 2048 "${cpu[@]}" \
    -drive if=pflash,format=raw,readonly=on,file="$code" \
    -drive if=pflash,format=raw,file="$vars" \
    -drive file="$disk",format=raw,if=virtio \
    -serial "file:$log" -display none -no-reboot >/dev/null 2>&1
  echo "$log"
}

# Re-boot off an EXISTING (already-enrolled) writable vars file — for the enroll->enforce dance.
# $1=label $2=disk $3=code $4=existing-vars $5=secs
sb_reboot_same_vars() {
  local label="$1" disk="$2" code="$3" vars="$4" secs="${5:-90}"
  local log="$SBWORK/serial-$label.log"
  : > "$log"
  local accel; accel=$(sb_accel)
  local cpu=(-cpu max)
  [ "$accel" = kvm ] && cpu=(-cpu host -enable-kvm)
  timeout "$secs" qemu-system-x86_64 -machine q35 -m 2048 "${cpu[@]}" \
    -drive if=pflash,format=raw,readonly=on,file="$code" \
    -drive if=pflash,format=raw,file="$vars" \
    -drive file="$disk",format=raw,if=virtio \
    -serial "file:$log" -display none -no-reboot >/dev/null 2>&1
  echo "$log"
}

# Classify a POSITIVE/CONTROL log. PASS = nonce echoes (log is THIS boot) + a userspace marker + no
# firmware reject. The in-guest SB-state witness is NOT required here (see the function body). Prints PASS|FAIL.
sb_classify_positive() {
  # PASS = the legitimately-signed image booted on the ENROLLED+enforcing rig: the per-run nonce echoes
  # (kernel cmdline -> the log is provably THIS boot) AND a userspace marker AND no firmware reject. We do
  # NOT hard-require the in-guest VITA-SB-STATE witness — enforcement is proven by the NEGATIVE rows being
  # rejected on the SAME enrolled vars (a non-enforcing varstore would let the negatives boot -> they'd FAIL).
  local log="$1" nonce="$2"
  grep -q -e "$nonce" "$log" 2>/dev/null || { echo FAIL; return; }
  grep -q -e Multi-User "$log" 2>/dev/null || grep -q -e bash-5 "$log" 2>/dev/null || { echo FAIL; return; }
  if sb_has_reject "$log"; then echo FAIL; else echo PASS; fi
}

# Firmware/shim reject witness. Single-word patterns only (no pipe inside one pattern). Kept tight to
# firmware phrasing to avoid colliding with benign userspace "authenticated"/"verified" log lines.
sb_has_reject() {
  local log="$1"
  grep -q -e "Security Violation" "$log" 2>/dev/null && return 0
  grep -q -e "Access Denied" "$log" 2>/dev/null && return 0
  grep -q -e "Verification failed" "$log" 2>/dev/null && return 0
  grep -q -e "image authentication" "$log" 2>/dev/null && return 0
  grep -q -e "not authenticated" "$log" 2>/dev/null && return 0
  grep -q -e "could not be loaded" "$log" 2>/dev/null && return 0
  return 1
}

# A negative ROW PASSES iff the firmware REFUSED to launch the image. BOTH required:
#   (1) NO kernel-start markers and NO userspace markers (the kernel never ran), AND
#   (2) a firmware reject WITNESS (sb_has_reject) — the positive discriminator that separates
#       "firmware rejected" from a generic boot failure / timeout / wrong-ESP. The CTRL row proves
#       the SAME enrolled rig boots a GOOD image in the same window, so (1)+(2) here is attributable
#       to enforcement, not a broken rig.
# The per-run nonce is NOT used here: it lives ONLY in the rejected UKI's embedded kernel cmdline, so
# on a CORRECT rejection the kernel never prints it — gating on it scored every real rejection FAIL
# and made the matrix unwinnable. Freshness is structural: every row boots into its own
# `: > "$log"`-truncated per-row serial log (sb_boot/sb_reboot_same_vars). Prints PASS|FAIL.
sb_classify_negative() {
  local log="$1"
  if grep -q -e Multi-User "$log" 2>/dev/null || grep -q -e bash-5 "$log" 2>/dev/null \
     || grep -q -e VITA-SB-STATE=enabled "$log" 2>/dev/null \
     || grep -q -e "Linux version" "$log" 2>/dev/null || grep -q -e "Freeing unused" "$log" 2>/dev/null; then
    echo FAIL; return                                                # it booted the kernel -> NOT rejected
  fi
  # kernel never started: REQUIRE a firmware reject witness (absence alone could be timeout/abort/wrong-ESP).
  if sb_has_reject "$log"; then echo PASS; else echo FAIL; fi
}

# Find the signed UKI on the built disk's ESP (offline), copy it out for sbsign/sbverify. $1=disk.raw
# Echoes the extracted UKI path, or empty on failure. Uses a loop mount of the ESP partition.
sb_extract_uki() {
  local disk="$1" mnt="$SBWORK/esp" uki="$SBWORK/uki.efi"
  mkdir -p "$mnt"
  # detach any stale loop still backing this disk (mkosi/systemd-repart can leave one) so -f -P succeeds
  local stale; for stale in $(losetup -j "$disk" -O NAME --noheadings 2>/dev/null); do losetup -d "$stale" 2>/dev/null; done
  local loop; loop=$(losetup --show -f -P "$disk" 2>/dev/null) || { echo ""; return; }
  local esp="" p
  for p in "${loop}p1" "${loop}p2" "${loop}p15" "${loop}p3"; do
    [ -b "$p" ] || continue
    umount "$mnt" 2>/dev/null
    if mount -o ro "$p" "$mnt" 2>/dev/null && [ -d "$mnt/EFI" ]; then esp="$p"; break; fi
    umount "$mnt" 2>/dev/null
  done
  if [ -z "$esp" ]; then losetup -d "$loop" 2>/dev/null; echo ""; return; fi
  # The UKI under --bootloader=uki is /EFI/BOOT/BOOTX64.EFI — uppercase .EFI, so MUST use -iname (the old
  # -name '*.efi' silently missed it, which is why extraction failed). Try /EFI/Linux then the default path.
  local found; found=$(find "$mnt/EFI/Linux" -iname '*.efi' 2>/dev/null | head -1)
  [ -z "$found" ] && found=$(find "$mnt/EFI/BOOT" -iname '*.efi' 2>/dev/null | head -1)
  [ -z "$found" ] && found=$(find "$mnt/EFI" -iname '*.efi' 2>/dev/null | head -1)
  if [ -n "$found" ]; then cp "$found" "$uki"; else uki=""; fi
  umount "$mnt" 2>/dev/null; losetup -d "$loop" 2>/dev/null
  echo "$uki"
}

secboot() {
  echo "===== SECURE BOOT MATRIX (virt-fw-vars enroll; parallel boots) ====="
  local nonce="sbnonce-$$"
  # Preconditions: TEST keystore + .secboot OVMF + blank vars + sbverify/sbsign/sbattach/virt-fw-vars.
  [ -f "$SBDIR/db.key" ] && [ -f "$SBDIR/db.crt" ] || { echo "RESULT: FAIL (no TEST keystore; run tools/secureboot-test-keys.sh)"; return 1; }
  [ -f "$SBDIR/rogue.key" ] && [ -f "$SBDIR/rogue.crt" ] || { echo "RESULT: FAIL (no rogue pair; run tools/secureboot-test-keys.sh)"; return 1; }
  [ -f "$SBCODE_SB" ] || { echo "RESULT: FAIL (no $SBCODE_SB; apt install ovmf)"; return 1; }
  [ -f "$SBVARS_BLANK" ] || { echo "RESULT: FAIL (no blank OVMF vars $SBVARS_BLANK; apt install ovmf)"; return 1; }
  command -v sbverify >/dev/null || { echo "RESULT: FAIL (sbverify MISSING)"; return 1; }
  command -v sbsign   >/dev/null || { echo "RESULT: FAIL (sbsign MISSING)"; return 1; }
  command -v sbattach >/dev/null || { echo "RESULT: FAIL (sbattach MISSING; apt install sbsigntool)"; return 1; }
  command -v virt-fw-vars >/dev/null || { echo "RESULT: FAIL (virt-fw-vars MISSING; apt install python3-virt-firmware)"; return 1; }
  rm -rf "$SBWORK"; mkdir -p "$SBWORK"

  # launch a boot in the BACKGROUND off a FRESH copy of $4; child of THIS shell so `wait` tracks it.
  sb_launch() {   # $1=label $2=disk $3=code $4=vars-src $5=secs
    local label="$1" disk="$2" code="$3" varsrc="$4" secs="${5:-120}"
    local vars="$SBWORK/vars-$label.fd" log="$SBWORK/serial-$label.log"
    rm -f "$vars"; cp "$varsrc" "$vars"; : > "$log"
    local accel; accel=$(sb_accel); local cpu=(-cpu max); [ "$accel" = kvm ] && cpu=(-cpu host -enable-kvm)
    timeout "$secs" qemu-system-x86_64 -machine q35 -m 1024 "${cpu[@]}" \
      -drive if=pflash,format=raw,readonly=on,file="$code" \
      -drive if=pflash,format=raw,file="$vars" \
      -drive file="$disk",format=raw,if=virtio \
      -serial "file:$log" -display none -no-reboot >/dev/null 2>&1 &
  }
  # replace the ESP UKI in disk $1 with file $2 (-iname: the UKI is BOOTX64.EFI, uppercase). returns 0 ok.
  sb_replace_uki() {
    local d="$1" newuki="$2" mnt="$SBWORK/espw" loop pp ok=1 stale
    mkdir -p "$mnt"
    for stale in $(losetup -j "$d" -O NAME --noheadings 2>/dev/null); do losetup -d "$stale" 2>/dev/null; done
    loop=$(losetup --show -f -P "$d" 2>/dev/null) || return 1
    for pp in "${loop}p1" "${loop}p2" "${loop}p15"; do
      [ -b "$pp" ] || continue
      umount "$mnt" 2>/dev/null
      mount "$pp" "$mnt" 2>/dev/null && [ -d "$mnt/EFI" ] || { umount "$mnt" 2>/dev/null; continue; }
      local tgt; tgt=$(find "$mnt/EFI/Linux" -iname '*.efi' 2>/dev/null | head -1)
      [ -z "$tgt" ] && tgt=$(find "$mnt/EFI/BOOT" -iname '*.efi' 2>/dev/null | head -1)
      [ -z "$tgt" ] && tgt=$(find "$mnt/EFI" -iname '*.efi' 2>/dev/null | head -1)
      if [ -n "$tgt" ]; then cp "$newuki" "$tgt"; sync; ok=0; fi
      umount "$mnt" 2>/dev/null; break
    done
    losetup -d "$loop" 2>/dev/null; return $ok
  }

  echo "----- build POSITIVE (db-signed UKI, --bootloader=uki) -----"
  rm -f "$REPO"/os/x86_64/out/*.raw   # so a STALE disk from a prior run can't masquerade as this build's output
  VITA_SECURE_BOOT=1 VITA_SB_NONCE="$nonce" \
    node "$REPO"/os/x86_64/build-and-boot.mjs --mode=smoke --no-boot 2>&1 | tail -6
  [ "${PIPESTATUS[0]}" = 0 ] || { echo "RESULT: FAIL (positive SB build failed)"; return 1; }
  local disk; disk=$(ls -t "$REPO"/os/x86_64/out/*.raw 2>/dev/null | head -1)
  [ -f "$disk" ] || { echo "RESULT: FAIL (positive build produced no disk)"; return 1; }
  echo "disk=$disk"

  echo "----- extract + offline-gate the signed UKI -----"
  local uki; uki=$(sb_extract_uki "$disk")
  { [ -n "$uki" ] && [ -f "$uki" ]; } || { echo "RESULT: FAIL (could not extract UKI from ESP)"; return 1; }
  sbverify --cert "$SBDIR/db.crt" "$uki" >/dev/null 2>&1 || { echo "RESULT: FAIL (positive UKI NOT db-signed — mkosi sign no-op)"; return 1; }
  echo "  positive UKI db-signed OK: $uki"

  echo "----- enroll OUR db cert (PK=KEK=db) into a fresh OVMF varstore (offline, virt-fw-vars) -----"
  local GUID=11111111-1111-1111-1111-111111111111
  local VENROLL="$SBWORK/vars-enrolled.fd"
  virt-fw-vars -i "$SBVARS_BLANK" -o "$VENROLL" --set-pk "$GUID" "$SBDIR/db.crt" --add-kek "$GUID" "$SBDIR/db.crt" --add-db "$GUID" "$SBDIR/db.crt" --sb >/dev/null 2>&1
  [ -f "$VENROLL" ] || { echo "RESULT: FAIL (virt-fw-vars produced no enrolled varstore)"; return 1; }
  echo "  enrolled vars: $VENROLL"

  echo "----- build negatives (offline sbsign/sbverify, tri-state gates) -----"
  local uki_n1="$SBWORK/uki-unsigned.efi" uki_n2="$SBWORK/uki-tampered.efi" uki_n3="$SBWORK/uki-rogue.efi"
  # N1 unsigned: strip sig; require AFFIRMATIVE zero-sigs (db verify fails AND no "signature 1").
  cp "$uki" "$uki_n1"; sbattach --remove "$uki_n1" >/dev/null 2>&1
  local n1_invalid=1
  if ! sbverify --cert "$SBDIR/db.crt" "$uki_n1" >/dev/null 2>&1 \
     && ! sbverify --list "$uki_n1" 2>/dev/null | grep -q -e "signature 1"; then n1_invalid=0; fi
  # N2 tampered: db-sign, then flip a byte deep in the PE; require pass-pre-flip, fail-post-flip.
  sbsign --key "$SBDIR/db.key" --cert "$SBDIR/db.crt" --output "$uki_n2" "$uki" >/dev/null 2>&1
  local n2_invalid=0
  sbverify --cert "$SBDIR/db.crt" "$uki_n2" >/dev/null 2>&1 || n2_invalid=1
  printf '\xff' | dd of="$uki_n2" bs=1 seek=8192 count=1 conv=notrunc >/dev/null 2>&1
  sbverify --cert "$SBDIR/db.crt" "$uki_n2" >/dev/null 2>&1 && n2_invalid=1
  # N3 wrong-key: sign with the NON-enrolled rogue key; require pass-vs-rogue, fail-vs-db.
  cp "$uki" "$uki_n3"; sbattach --remove "$uki_n3" >/dev/null 2>&1
  sbsign --key "$SBDIR/rogue.key" --cert "$SBDIR/rogue.crt" --output "$uki_n3" "$uki_n3" >/dev/null 2>&1
  local n3_invalid=0
  sbverify --cert "$SBDIR/rogue.crt" "$uki_n3" >/dev/null 2>&1 || n3_invalid=1
  sbverify --cert "$SBDIR/db.crt"    "$uki_n3" >/dev/null 2>&1 && n3_invalid=1
  echo "  offline gates: N1_invalid=$n1_invalid N2_invalid=$n2_invalid N3_invalid=$n3_invalid"

  # place each negative UKI onto its own disk copy
  local disk_n1="$SBWORK/disk-N1.raw" disk_n2="$SBWORK/disk-N2.raw" disk_n3="$SBWORK/disk-N3.raw"
  cp "$disk" "$disk_n1"; cp "$disk" "$disk_n2"; cp "$disk" "$disk_n3"
  { [ "$n1_invalid" = 0 ] && sb_replace_uki "$disk_n1" "$uki_n1"; } || n1_invalid=1
  { [ "$n2_invalid" = 0 ] && sb_replace_uki "$disk_n2" "$uki_n2"; } || n2_invalid=1
  { [ "$n3_invalid" = 0 ] && sb_replace_uki "$disk_n3" "$uki_n3"; } || n3_invalid=1

  echo "----- boot POSITIVE (enrolled, enforcing; serial anchor) -----"
  local plog; plog=$(sb_boot POS "$disk" "$SBCODE_SB" "$VENROLL" "$nonce" 150)
  local r_pos; r_pos=$(sb_classify_positive "$plog" "$nonce")
  echo "  POS=$r_pos"; tail -4 "$plog" 2>/dev/null

  echo "----- boot NEGATIVES N1/N2/N3 (+CTRLMS) in PARALLEL off fresh enrolled-vars copies -----"
  local do_ctrlms=0
  [ "$n1_invalid" = 0 ] && sb_launch N1 "$disk_n1" "$SBCODE_SB" "$VENROLL" 120
  [ "$n2_invalid" = 0 ] && sb_launch N2 "$disk_n2" "$SBCODE_SB" "$VENROLL" 120
  [ "$n3_invalid" = 0 ] && sb_launch N3 "$disk_n3" "$SBCODE_SB" "$VENROLL" 120
  if [ -f "$SBCODE_MS" ] && [ -f "$SBVARS_MS" ]; then do_ctrlms=1; sb_launch CTRLMS "$disk" "$SBCODE_MS" "$SBVARS_MS" 120; fi
  wait
  local r_n1=INVALID r_n2=INVALID r_n3=INVALID r_ctrlms=INVALID
  [ "$n1_invalid" = 0 ] && r_n1=$(sb_classify_negative "$SBWORK/serial-N1.log")
  [ "$n2_invalid" = 0 ] && r_n2=$(sb_classify_negative "$SBWORK/serial-N2.log")
  [ "$n3_invalid" = 0 ] && r_n3=$(sb_classify_negative "$SBWORK/serial-N3.log")
  # CTRLMS is a REQUIRED cross-check (db must NOT be MS-trusted). A missing MS OVMF pair is a hard FAIL,
  # not a silent skip-pass — the acceptance host has it; a host without it cannot prove this row.
  if [ "$do_ctrlms" = 1 ]; then r_ctrlms=$(sb_classify_negative "$SBWORK/serial-CTRLMS.log")
  else r_ctrlms=FAIL; echo "  CTRLMS=FAIL (MS OVMF pair $SBCODE_MS / $SBVARS_MS absent — required cross-check cannot run)"; fi

  echo "----- MATRIX -----"
  printf '  %-8s %s\n' POS "$r_pos" N1 "$r_n1" N2 "$r_n2" N3 "$r_n3" CTRLMS "$r_ctrlms"
  # PASS only if every row is PASS; any FAIL/INVALID fails the suite. Enforcement is proven by the
  # POS-boots / negatives-rejected contrast on the SAME enrolled varstore.
  local bad=""
  for kv in POS:$r_pos N1:$r_n1 N2:$r_n2 N3:$r_n3 CTRLMS:$r_ctrlms; do
    case "$kv" in *:PASS) ;; *) bad="$bad ${kv%%:*}";; esac
  done
  if [ -z "$bad" ]; then
    echo "RESULT: PASS (Vita TEST key enrolled + enforced; unsigned/tampered/wrong-key all rejected)"
  else
    echo "RESULT: FAIL (rows not PASS:$bad)"; return 1
  fi
}

# ── Verity adversarial check (dm-verity root ENFORCEMENT) ─────────────────────────────────────────────
# POS  = the VITA_VERITY=1 image boots with the root mounted through /dev/mapper/root (dm-verity ACTIVE).
# VNEG = one byte flipped in the root DATA partition -> dm-verity detects the block doesn't match the hash
#        tree at mount -> the root does NOT reach userspace + a verity-corruption witness appears.
# Static gate first: the build must produce a root-verity partition (else --verity was a no-op). Enforcement
# is proven by POS-boots-verified / VNEG-rejected on the same image. Reuses sb_accel.
VWORK="$REPO/os/x86_64/out/verity-check"
verity_boot() {   # $1=label $2=disk $3=secs ; plain OVMF (verity needs no SB). Echoes the log path.
  local label="$1" d="$2" secs="${3:-90}"
  local log="$VWORK/serial-$label.log"
  mkdir -p "$VWORK"; cp /usr/share/OVMF/OVMF_VARS_4M.fd "$VWORK/vars-$label.fd"; : > "$log"
  local accel; accel=$(sb_accel); local cpu=(-cpu max); [ "$accel" = kvm ] && cpu=(-cpu host -enable-kvm)
  timeout "$secs" qemu-system-x86_64 -machine q35 -m 1024 "${cpu[@]}" \
    -drive if=pflash,format=raw,readonly=on,file=/usr/share/OVMF/OVMF_CODE_4M.fd \
    -drive if=pflash,format=raw,file="$VWORK/vars-$label.fd" \
    -drive file="$d",format=raw,if=virtio \
    -serial "file:$log" -display none -no-reboot >/dev/null 2>&1
  echo "$log"
}
run_verity() {
  echo "===== VERITY MATRIX (dm-verity root enforcement) ====="
  rm -rf "$VWORK"; mkdir -p "$VWORK"
  echo "----- build VITA_VERITY=1 -----"
  rm -f "$REPO"/os/x86_64/out/*.raw
  VITA_VERITY=1 node "$REPO"/os/x86_64/build-and-boot.mjs --mode=smoke --no-boot 2>&1 | tail -6
  [ "${PIPESTATUS[0]}" = 0 ] || { echo "RESULT: FAIL (verity build failed)"; return 1; }
  local disk; disk=$(ls -t "$REPO"/os/x86_64/out/*.raw 2>/dev/null | head -1)
  [ -f "$disk" ] || { echo "RESULT: FAIL (no disk)"; return 1; }
  echo "disk=$disk"

  echo "----- static gate: root-verity partition present -----"
  sfdisk -d "$disk" 2>/dev/null | grep -iq 2c7357ed || { echo "RESULT: FAIL (no root-verity partition — --verity was a no-op)"; return 1; }
  local rstart; rstart=$(sfdisk -d "$disk" 2>/dev/null | grep -i 4f68bce3 | sed -n 's/.*start=[ ]*\([0-9]*\).*/\1/p' | head -1)
  [ -n "$rstart" ] || { echo "RESULT: FAIL (root data partition not found)"; return 1; }
  local roff=$(( rstart * 512 ))
  echo "  root-verity partition OK; root data at sector $rstart"

  echo "----- POS: boot verity image (expect dm-verity active + userspace) -----"
  local plog; plog=$(verity_boot POS "$disk" 120)
  local r_pos=FAIL
  # PASS = userspace reached AND dm-verity active AND the root is actually the verity device /dev/mapper/root
  # (not just any verity volume) — so a non-verity boot cannot satisfy it.
  if { grep -qa Multi-User "$plog" || grep -qa bash-5 "$plog"; } \
     && grep -qa "device-mapper: verity" "$plog" && grep -qa "/dev/mapper/root" "$plog"; then r_pos=PASS; fi
  echo "  POS=$r_pos"; grep -a "device-mapper: verity" "$plog" 2>/dev/null | head -1

  echo "----- VNEG: tamper a byte in the root DATA partition (expect dm-verity reject) -----"
  local dneg="$VWORK/disk-VNEG.raw"; cp "$disk" "$dneg"
  printf '\xff' | dd of="$dneg" bs=1 seek=$(( roff + 1024 )) count=1 conv=notrunc >/dev/null 2>&1   # ext4 superblock area, read at mount
  local nlog; nlog=$(verity_boot VNEG "$dneg" 90)
  local r_neg=FAIL
  # PASS = root did NOT reach userspace AND a dm-verity corruption witness is present (not a generic failure).
  if ! grep -qa Multi-User "$nlog" && ! grep -qa bash-5 "$nlog" \
     && grep -qaiE 'verity:.*corrupt|is corrupted|verity:.*(invalid|metadata)' "$nlog"; then r_neg=PASS; fi
  echo "  VNEG=$r_neg"; grep -aiE 'verity:.*(corrupt|invalid)|is corrupted' "$nlog" 2>/dev/null | head -2

  echo "----- MATRIX -----"
  printf '  %-6s %s\n' POS "$r_pos" VNEG "$r_neg"
  if [ "$r_pos" = PASS ] && [ "$r_neg" = PASS ]; then
    echo "RESULT: PASS (verity root boots verified; tampered root rejected by dm-verity)"
  else
    echo "RESULT: FAIL (POS=$r_pos VNEG=$r_neg)"; return 1
  fi
}

case "$MODE" in
  tests) run_tests; echo "RESULT: $([ $? = 0 ] && echo PASS || echo FAIL)";;
  build) build_smoke && echo "RESULT: PASS (disk built)" || echo "RESULT: FAIL (build)";;
  boot)  boot_headless;;
  smoke) build_smoke && boot_headless || echo "RESULT: FAIL";;
  agent) agent_build;;
  probe) probe;;
  diag)  diag;;
  full)  build_full;;
  secboot) secboot;;
  verity) run_verity;;
  ts)    build_smoke && boot_ts || echo "RESULT: FAIL";;
  *) echo "unknown mode: $MODE"; exit 2;;
esac
