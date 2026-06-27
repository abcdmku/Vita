#!/bin/bash
# Vita owner-token provisioning — MINT + PERSIST the network-face owner bearer secret on first boot.
#
# The network (remote) face of the platform server is authenticated by an opaque OWNER TOKEN (a bearer
# secret; see backend.ts::ownerTokenFaceGate). It MUST be:
#   • minted ONCE (a long random secret), then
#   • persisted on the /var data partition so it SURVIVES REBOOT (a remote owner logs in with the same
#     token across boots), and
#   • delivered to the unprivileged platform server WITHOUT putting the secret in the image or the unit
#     text. We persist it 0640 root:vita-agent under /var/lib/vita/owner/owner.token and the platform
#     DynamicUser reads it directly via VITA_OWNER_TOKEN_FILE (it is in SupplementaryGroups=vita-agent, so
#     the group-readable file is reachable). LoadCredential was dropped — the per-unit credentials mount
#     fails on this image's systemd/kernel — so the group-readable persisted file is the delivery path.
#
# MECHANISM CHOICE (documented per the task): a tiny oneshot ordered Before=vita-platform.service that
# mints-if-absent. Rationale:
#   • The token is data, not config — it cannot live in the read-only verity image (every node would
#     share one secret) and must be generated per node on first boot. A boot-time mint is the natural fit.
#   • /var/lib/vita is the agentd/host-proxy-owned persistent tree (var.mount), already created 0750 by
#     tmpfiles.d/vita-apps.conf, so the token rides the SAME persistent partition the apps store does —
#     one mount, one reboot-survival story.
#   • the 0640 root:vita-agent persisted file delivers the secret to the DynamicUser platform unit by
#     group membership, never as env text in `systemctl show`/the journal.
#   • agentd is the only privileged component, but minting a random file under /var needs no host
#     mutation authority, so a narrow root oneshot (write-once, no network, no exec of payload) is
#     sufficient and keeps agentd's surface unchanged.
#
# Idempotent (default / first-boot mode): if the token file already exists and is non-empty, this is a
# no-op (the persisted token is kept across reboots/updates). Fail-LOUD only if it cannot create the
# dir/file (the network face would otherwise come up with an ephemeral token the owner never sees).
#
# ROTATION (--rotate / --force): regenerate the token even when one is present, persisting the NEW token
# atomically over the old. The rotation FLOW (see vita-owner-token-rotate.service) is: this script writes
# the new token on /var, then the rotate unit `systemctl restart vita-platform.service` (NOT a reboot) so
# server-entry.ts re-reads VITA_OWNER_TOKEN_FILE and the network-face gate adopts the new secret in ~2s.
# The persisted apps store on /var is untouched, so only the network face's bearer changes — local kiosk
# sessions and on-disk data are unaffected. The previous token is invalid the moment the server restarts.
set -u

MARKER=VITA-OWNER-TOKEN
TTY=/dev/ttyS0
# VITA_OWNER_DIR overrides the persisted-token dir (the on-device default is /var/lib/vita/owner). The
# override exists ONLY for the offline harness (it drives this script against a temp root with no /var,
# no root, no systemd); on-device the unit never sets it, so the default path is authoritative.
OWNER_DIR="${VITA_OWNER_DIR:-/var/lib/vita/owner}"
TOKEN_FILE="${OWNER_DIR}/owner.token"

# Mode: default mint-if-absent, or --rotate/--force to regenerate over an existing token.
MODE=mint
case "${1:-}" in
  --rotate|--force|rotate) MODE=rotate ;;
  "") MODE=mint ;;
  *) MODE=mint ;;
esac

emit() {
  printf '%s\n' "$1"
  if [ -w "$TTY" ]; then printf '%s\n' "$1" > "$TTY" 2>/dev/null || true; fi
}

# Mint a 256-bit random token, hex-encoded (64 chars). Prefer the kernel CSPRNG; fall back to openssl.
mint_token() {
  local t=""
  if command -v od >/dev/null 2>&1 && [ -r /dev/urandom ]; then
    t=$(od -An -tx1 -N32 /dev/urandom 2>/dev/null | tr -d ' \n')
  fi
  if [ -z "$t" ] && command -v openssl >/dev/null 2>&1; then
    t=$(openssl rand -hex 32 2>/dev/null)
  fi
  printf '%s' "$t"
}

# /var/lib/vita is created by tmpfiles (0750 root:vita-agent) on the var.mount data partition. Ensure the
# owner subdir exists 0750 so the platform DynamicUser (group vita-agent) can read the 0640 token file.
if ! mkdir -p "$OWNER_DIR" 2>/dev/null; then
  emit "$MARKER: FATAL could not create ${OWNER_DIR} (is /var mounted?)"
  exit 1
fi
chmod 0750 "$OWNER_DIR" 2>/dev/null || true

if [ "$MODE" = "mint" ] && [ -s "$TOKEN_FILE" ]; then
  emit "$MARKER: existing owner token present (persisted) — keeping it"
  exit 0
fi

TOKEN=$(mint_token)
if [ -z "$TOKEN" ]; then
  emit "$MARKER: FATAL no CSPRNG source (/dev/urandom, openssl) to mint the owner token"
  exit 1
fi

# Write 0640 root:vita-agent so the platform DynamicUser (SupplementaryGroups=vita-agent) can read
# it directly via VITA_OWNER_TOKEN_FILE; persisted on /var (survives reboot). ATOMIC replace via a
# temp file + rename so a concurrent reader never sees a half-written token (matters for --rotate).
umask 0027
TMP_FILE="${TOKEN_FILE}.new.$$"
if ! printf '%s\n' "$TOKEN" > "$TMP_FILE"; then
  emit "$MARKER: FATAL could not write ${TMP_FILE}"
  rm -f "$TMP_FILE" 2>/dev/null || true
  exit 1
fi
chmod 0640 "$TMP_FILE" 2>/dev/null || true
chgrp vita-agent "$TMP_FILE" 2>/dev/null || true
if ! mv -f "$TMP_FILE" "$TOKEN_FILE"; then
  emit "$MARKER: FATAL could not install ${TOKEN_FILE}"
  rm -f "$TMP_FILE" 2>/dev/null || true
  exit 1
fi

if [ "$MODE" = "rotate" ]; then
  emit "$MARKER: ROTATED the owner token at ${TOKEN_FILE} (restart vita-platform.service to adopt it; read it out-of-band to re-log in)"
else
  emit "$MARKER: minted + persisted a new owner token at ${TOKEN_FILE} (read it out-of-band to log into the network face)"
fi
exit 0
