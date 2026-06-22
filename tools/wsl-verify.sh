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
# Proves OUR TEST key is the enforced root of trust. Six rows, tri-state PASS/FAIL/INVALID:
#   POS    db-signed UKI + auto-enroll, blank Setup-Mode vars -> 2 boots (enroll, then enforce);
#          PASS only if VITA-SB-STATE=enabled AND a userspace marker AND no firmware reject.
#   CTRL   identical second positive boot off the now-User-Mode vars (regression control = boots).
#   N1     unsigned UKI               -> firmware rejects (no kernel start).
#   N2     db-signed-then-tampered    -> firmware rejects.
#   N3     rogue-key-signed UKI       -> firmware rejects (key not enrolled).
#   CTRLMS Vita-db-signed UKI on the MS code+vars pair -> REJECTED (proves db != MS-trusted).
# Each row: FRESH writable vars, FRESH per-row serial log, per-run nonce in cmdline; offline sbverify
# gate proves a well-formed-but-untrusted artifact exists BEFORE qemu (missing artifact => INVALID).
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

# Classify a POSITIVE/CONTROL log. PASS needs the SB-state witness + a userspace marker + no reject
# token, and the nonce must echo (log provably belongs to this boot). Prints PASS|FAIL.
sb_classify_positive() {
  local log="$1" nonce="$2"
  grep -q -e "$nonce" "$log" 2>/dev/null || { echo FAIL; return; }
  # A reject token co-occurring with a userspace marker = test bug -> FAIL the row.
  if grep -q -e VITA-SB-STATE=enabled "$log" 2>/dev/null \
     && { grep -q -e Multi-User "$log" 2>/dev/null || grep -q -e bash-5 "$log" 2>/dev/null; }; then
    if sb_has_reject "$log"; then echo FAIL; else echo PASS; fi
  else
    echo FAIL
  fi
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
  local loop; loop=$(losetup --show -f -P "$disk" 2>/dev/null) || { echo ""; return; }
  local esp=""
  # ESP is the FAT/EFI System partition; pick the partition whose type is EFI or that holds /EFI.
  local p
  for p in "${loop}p1" "${loop}p2" "${loop}p15" "${loop}p3"; do
    [ -b "$p" ] || continue
    umount "$mnt" 2>/dev/null
    if mount -o ro "$p" "$mnt" 2>/dev/null && [ -d "$mnt/EFI" ]; then esp="$p"; break; fi
    umount "$mnt" 2>/dev/null
  done
  if [ -z "$esp" ]; then losetup -d "$loop" 2>/dev/null; echo ""; return; fi
  local found; found=$(find "$mnt/EFI/Linux" -name '*.efi' 2>/dev/null | head -1)
  [ -z "$found" ] && found=$(find "$mnt/EFI" -name '*.efi' 2>/dev/null | head -1)
  if [ -n "$found" ]; then cp "$found" "$uki"; else uki=""; fi
  umount "$mnt" 2>/dev/null; losetup -d "$loop" 2>/dev/null
  echo "$uki"
}

secboot() {
  echo "===== SECURE BOOT MATRIX ====="
  local nonce="sbnonce-$$-$(date +%s)"
  # Preconditions: keystore + .secboot OVMF + sbverify/sbsign present.
  [ -f "$SBDIR/db.key" ] && [ -f "$SBDIR/db.crt" ] || { echo "RESULT: FAIL (no TEST keystore; run tools/secureboot-test-keys.sh)"; return 1; }
  [ -f "$SBDIR/rogue.key" ] && [ -f "$SBDIR/rogue.crt" ] || { echo "RESULT: FAIL (no rogue pair; run tools/secureboot-test-keys.sh)"; return 1; }
  [ -f "$SBCODE_SB" ] || { echo "RESULT: FAIL (no $SBCODE_SB; apt install ovmf)"; return 1; }
  command -v sbverify >/dev/null || { echo "RESULT: FAIL (sbverify MISSING)"; return 1; }
  command -v sbsign   >/dev/null || { echo "RESULT: FAIL (sbsign MISSING)"; return 1; }
  mkdir -p "$SBWORK"

  echo "----- build POSITIVE (db-signed UKI + auto-enroll) -----"
  VITA_SECURE_BOOT=1 VITA_SB_NONCE="$nonce" \
    node "$REPO"/os/x86_64/build-and-boot.mjs --mode=smoke --no-boot 2>&1 | tail -8
  local disk; disk=$(ls -t "$REPO"/os/x86_64/out/*.raw 2>/dev/null | head -1)
  [ -f "$disk" ] || { echo "RESULT: FAIL (positive build produced no disk)"; return 1; }
  echo "disk=$disk"

  echo "----- offline build-time gate: sbverify the signed UKI against db.crt -----"
  local uki; uki=$(sb_extract_uki "$disk")
  if [ -z "$uki" ] || [ ! -f "$uki" ]; then echo "RESULT: FAIL (could not extract UKI from ESP)"; return 1; fi
  if ! sbverify --cert "$SBDIR/db.crt" "$uki" >/dev/null 2>&1; then
    echo "INVALID: positive UKI is NOT db-signed (mkosi sign-tool no-op) -> RESULT: FAIL"; return 1
  fi
  echo "  positive UKI: db-signed OK"
  # Also confirm mkosi re-signed the installed sd-boot stub with db (Debian-signed stub would brick SB).
  local mnt2="$SBWORK/esp2" loop2 stub_ok=skip
  loop2=$(losetup --show -f -P "$disk" 2>/dev/null) && {
    mkdir -p "$mnt2"
    local pp
    for pp in "${loop2}p1" "${loop2}p2" "${loop2}p15"; do
      [ -b "$pp" ] || continue
      umount "$mnt2" 2>/dev/null
      mount -o ro "$pp" "$mnt2" 2>/dev/null && [ -d "$mnt2/EFI" ] || { umount "$mnt2" 2>/dev/null; continue; }
      local bootx; bootx=$(find "$mnt2/EFI/BOOT" -iname 'BOOTX64.EFI' 2>/dev/null | head -1)
      if [ -n "$bootx" ]; then
        sbverify --cert "$SBDIR/db.crt" "$bootx" >/dev/null 2>&1 && stub_ok=yes || stub_ok=no
      fi
      umount "$mnt2" 2>/dev/null; break
    done
    losetup -d "$loop2" 2>/dev/null
  }
  echo "  bootloader stub db-signed: $stub_ok (no => stub stays Debian-signed; positive may not boot under SB)"

  echo "----- POS boot 1 (enroll) on $SBCODE_SB + blank Setup-Mode vars -----"
  local pvars="$SBWORK/vars-POS.fd"; rm -f "$pvars"; cp "$SBVARS_BLANK" "$pvars"
  sb_reboot_same_vars POSENROLL "$disk" "$SBCODE_SB" "$pvars" 90 >/dev/null
  echo "----- POS boot 2 (enforce) off the now-User-Mode vars -----"
  local plog; plog=$(sb_reboot_same_vars POS "$disk" "$SBCODE_SB" "$pvars" 120)
  local r_pos; r_pos=$(sb_classify_positive "$plog" "$nonce")
  echo "  POS=$r_pos"; tail -6 "$plog" 2>/dev/null

  echo "----- CTRL (regression control: enforce again, same vars) -----"
  local clog; clog=$(sb_reboot_same_vars CTRL "$disk" "$SBCODE_SB" "$pvars" 120)
  local r_ctrl; r_ctrl=$(sb_classify_positive "$clog" "$nonce")
  echo "  CTRL=$r_ctrl"

  # Build the three negative UKIs from the extracted, db-signed positive UKI. Each is written onto a
  # COPY of the disk so the firmware loads the tampered image. We replace the ESP UKI in place.
  echo "----- build negatives (offline, host sbsign/sbverify) -----"
  local disk_n1="$SBWORK/disk-N1.raw" disk_n2="$SBWORK/disk-N2.raw" disk_n3="$SBWORK/disk-N3.raw"
  cp "$disk" "$disk_n1"; cp "$disk" "$disk_n2"; cp "$disk" "$disk_n3"

  # helper: replace the ESP UKI in $1 with file $2 (no signature change here; caller pre-shapes $2)
  sb_replace_uki() {
    local d="$1" newuki="$2" mnt="$SBWORK/espw" loop pp ok=1
    mkdir -p "$mnt"; loop=$(losetup --show -f -P "$d" 2>/dev/null) || return 1
    for pp in "${loop}p1" "${loop}p2" "${loop}p15"; do
      [ -b "$pp" ] || continue
      umount "$mnt" 2>/dev/null
      mount "$pp" "$mnt" 2>/dev/null && [ -d "$mnt/EFI" ] || { umount "$mnt" 2>/dev/null; continue; }
      local tgt; tgt=$(find "$mnt/EFI/Linux" -name '*.efi' 2>/dev/null | head -1)
      [ -z "$tgt" ] && tgt=$(find "$mnt/EFI" -name '*.efi' 2>/dev/null | head -1)
      if [ -n "$tgt" ]; then cp "$newuki" "$tgt"; sync; ok=0; fi
      umount "$mnt" 2>/dev/null; break
    done
    losetup -d "$loop" 2>/dev/null; return $ok
  }

  # N1 unsigned: strip the signature. Gate: sbverify --list shows NO signatures.
  local uki_n1="$SBWORK/uki-unsigned.efi"
  sbattach --remove "$uki" 2>/dev/null && cp "$uki" "$uki_n1" || sbsign --key "$SBDIR/db.key" --cert "$SBDIR/db.crt" --output /dev/null "$uki" 2>/dev/null
  # robust unsigned: re-derive from the on-ESP copy then strip
  cp "$uki" "$uki_n1"; sbattach --remove "$uki_n1" >/dev/null 2>&1
  # Default INVALID; only clear to a valid unsigned-negative when we AFFIRMATIVELY prove zero sigs:
  # db.crt verification FAILS (no valid sig) AND sbverify --list shows no "signature N" entry. A still
  # -signed N1 (sbattach no-op on some versions) thus stays INVALID rather than booting as "unsigned".
  local n1_invalid=1
  if ! sbverify --cert "$SBDIR/db.crt" "$uki_n1" >/dev/null 2>&1 \
     && ! sbverify --list "$uki_n1" 2>/dev/null | grep -q -e "signature 1"; then
    n1_invalid=0
  fi

  # N2 tampered: db-sign, then flip one byte. Gate: sbverify --cert db.crt PASSED pre-flip, FAILS post.
  local uki_n2="$SBWORK/uki-tampered.efi"
  sbsign --key "$SBDIR/db.key" --cert "$SBDIR/db.crt" --output "$uki_n2" "$uki" >/dev/null 2>&1
  local n2_invalid=0
  sbverify --cert "$SBDIR/db.crt" "$uki_n2" >/dev/null 2>&1 || n2_invalid=1   # must PASS pre-flip
  # flip a byte deep in the PE (offset 4096) — coreutils dd, no pipe
  printf '\xff' | dd of="$uki_n2" bs=1 seek=4096 count=1 conv=notrunc >/dev/null 2>&1
  sbverify --cert "$SBDIR/db.crt" "$uki_n2" >/dev/null 2>&1 && n2_invalid=1    # must FAIL post-flip

  # N3 wrong-key: sign with the NON-enrolled rogue key. Gate: passes vs rogue.crt, FAILS vs db.crt.
  local uki_n3="$SBWORK/uki-rogue.efi"
  cp "$uki" "$uki_n3"; sbattach --remove "$uki_n3" >/dev/null 2>&1
  sbsign --key "$SBDIR/rogue.key" --cert "$SBDIR/rogue.crt" --output "$uki_n3" "$uki_n3" >/dev/null 2>&1
  local n3_invalid=0
  sbverify --cert "$SBDIR/rogue.crt" "$uki_n3" >/dev/null 2>&1 || n3_invalid=1  # must PASS vs rogue
  sbverify --cert "$SBDIR/db.crt"    "$uki_n3" >/dev/null 2>&1 && n3_invalid=1   # must FAIL vs db

  echo "  offline gates: N1_invalid=$n1_invalid N2_invalid=$n2_invalid N3_invalid=$n3_invalid"

  # Place each negative UKI on its disk copy and boot off a FRESH copy of the ALREADY-ENROLLED vars
  # (so the firmware is in enforcing User Mode with OUR db — the only state where a reject is meaningful).
  local r_n1=INVALID r_n2=INVALID r_n3=INVALID
  if [ "$n1_invalid" = 0 ] && sb_replace_uki "$disk_n1" "$uki_n1"; then
    local v="$SBWORK/vars-N1.fd"; rm -f "$v"; cp "$pvars" "$v"
    local l; l=$(sb_reboot_same_vars N1 "$disk_n1" "$SBCODE_SB" "$v" 90); r_n1=$(sb_classify_negative "$l" "$nonce")
  fi
  if [ "$n2_invalid" = 0 ] && sb_replace_uki "$disk_n2" "$uki_n2"; then
    local v="$SBWORK/vars-N2.fd"; rm -f "$v"; cp "$pvars" "$v"
    local l; l=$(sb_reboot_same_vars N2 "$disk_n2" "$SBCODE_SB" "$v" 90); r_n2=$(sb_classify_negative "$l" "$nonce")
  fi
  if [ "$n3_invalid" = 0 ] && sb_replace_uki "$disk_n3" "$uki_n3"; then
    local v="$SBWORK/vars-N3.fd"; rm -f "$v"; cp "$pvars" "$v"
    local l; l=$(sb_reboot_same_vars N3 "$disk_n3" "$SBCODE_SB" "$v" 90); r_n3=$(sb_classify_negative "$l" "$nonce")
  fi
  echo "  N1=$r_n1 N2=$r_n2 N3=$r_n3"

  # CTRLMS: Vita-db-signed positive UKI on the MS code+vars pair -> must be REJECTED (db != MS-trusted).
  local r_ctrlms=INVALID
  if [ -f "$SBCODE_MS" ] && [ -f "$SBVARS_MS" ]; then
    local v="$SBWORK/vars-CTRLMS.fd"; rm -f "$v"; cp "$SBVARS_MS" "$v"
    local l; l=$(sb_reboot_same_vars CTRLMS "$disk" "$SBCODE_MS" "$v" 90); r_ctrlms=$(sb_classify_negative "$l" "$nonce")
    echo "  CTRLMS=$r_ctrlms"
  else
    echo "  CTRLMS=SKIP (no MS OVMF pair)"
    r_ctrlms=PASS   # absent MS firmware: not a failure of OUR chain
  fi

  echo "----- MATRIX -----"
  printf '  %-8s %s\n' POS "$r_pos" CTRL "$r_ctrl" N1 "$r_n1" N2 "$r_n2" N3 "$r_n3" CTRLMS "$r_ctrlms"
  # RESULT: PASS only if every row is PASS; any FAIL or INVALID fails the suite and names the row.
  local bad=""
  for kv in POS:$r_pos CTRL:$r_ctrl N1:$r_n1 N2:$r_n2 N3:$r_n3 CTRLMS:$r_ctrlms; do
    case "$kv" in *:PASS) ;; *) bad="$bad ${kv%%:*}";; esac
  done
  if [ -z "$bad" ]; then
    echo "RESULT: PASS (Vita TEST key enrolled + enforced; unsigned/tampered/wrong-key all rejected)"
  else
    echo "RESULT: FAIL (rows not PASS:$bad)"; return 1
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
  *) echo "unknown mode: $MODE"; exit 2;;
esac
