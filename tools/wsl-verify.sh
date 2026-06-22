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
  timeout 260 qemu-system-x86_64 -machine q35 -m 2048 -cpu host -enable-kvm \
    -drive if=pflash,format=raw,readonly=on,file="$code" \
    -drive if=pflash,format=raw,file="$REPO"/os/x86_64/out/OVMF_VARS.fd \
    -drive file="$disk",format=raw,if=virtio \
    -serial "file:$log" -display none -no-reboot >/dev/null 2>&1 &
  local qpid=$! ok=0 agent="" i
  # "fully up" = systemd reached the Multi-User target (or the login/root shell appeared).
  for i in $(seq 1 240); do
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
  echo "===== last 10 lines ====="
  sed -E 's/\x1b\[[0-9;]*m//g' "$log" | tail -10
}

case "$MODE" in
  tests) run_tests; echo "RESULT: $([ $? = 0 ] && echo PASS || echo FAIL)";;
  build) build_smoke && echo "RESULT: PASS (disk built)" || echo "RESULT: FAIL (build)";;
  boot)  boot_headless;;
  smoke) build_smoke && boot_headless || echo "RESULT: FAIL";;
  agent) agent_build;;
  diag)  diag;;
  full)  build_full;;
  *) echo "unknown mode: $MODE"; exit 2;;
esac
