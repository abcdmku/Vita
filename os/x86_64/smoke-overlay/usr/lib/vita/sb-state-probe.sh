#!/bin/bash
# Vita SMOKE VM only — independent Secure Boot enforcement witness.
#
# coreutils-only (od/printf/cat — no mokutil, no sbsigntool; the package allowlist in
# os/common/mkosi.conf is locked by os/x86_64/test/root-determinism.test.ts and CANNOT gain a
# package). Reads the UEFI global SecureBoot + SetupMode variables straight from efivarfs and prints
# ONE grep-able token to the serial console so wsl-verify's secboot matrix can gate PASS on the
# firmware's ACTUAL enforcement state — never on a bash prompt (the autologin getty prints
# `bash-5.x#` even on non-enforcing firmware, so that marker alone proves nothing).
#
# efivarfs layout: each var is GUID-suffixed; the first 4 bytes are EFI attributes, then the data.
# For SecureBoot/SetupMode the data is a single byte: SecureBoot==1 => SB on; SetupMode==0 => User
# Mode (PK enrolled, enforcing). Token grammar (single words, so wsl-verify greps with `-e WORD`):
#   VITA-SB-STATE=enabled    SecureBoot==1 AND SetupMode==0  (enforcing, our key is the root of trust)
#   VITA-SB-STATE=setupmode  SecureBoot==0/absent OR SetupMode==1 (NOT enforcing — auto-enroll didn't fire)
#   VITA-SB-STATE=unknown    efivarfs/variable unreadable
set -u
GUID=8be4df61-93ca-11d2-aa0d-00e098032b8c
EV=/sys/firmware/efi/efivars

# last data byte of an efivars file (5th byte; 4 attribute bytes precede the 1-byte value)
last_byte() {
  # od -An -tu1 emits space-separated decimal bytes; take the 5th. coreutils only.
  set -- $(od -An -tu1 "$1" 2>/dev/null)
  # $5 is the data byte (after 4 attribute bytes); empty if file absent/short
  printf '%s' "${5:-X}"
}

sb=$(last_byte "$EV/SecureBoot-$GUID")
sm=$(last_byte "$EV/SetupMode-$GUID")

printf 'VITA-SB-PROBE: SecureBoot=%s SetupMode=%s\n' "$sb" "$sm" > /dev/ttyS0 2>/dev/null
if [ "$sb" = "1" ] && [ "$sm" = "0" ]; then
  printf 'VITA-SB-STATE=enabled\n' > /dev/ttyS0 2>/dev/null
elif [ "$sb" = "X" ] || [ "$sm" = "X" ]; then
  printf 'VITA-SB-STATE=unknown\n' > /dev/ttyS0 2>/dev/null
else
  printf 'VITA-SB-STATE=setupmode\n' > /dev/ttyS0 2>/dev/null
fi
exit 0
