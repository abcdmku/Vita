#!/bin/bash
# Vita owner-token provisioning — MINT + PERSIST the network-face owner bearer secret on first boot.
#
# The network (remote) face of the platform server is authenticated by an opaque OWNER TOKEN (a bearer
# secret; see backend.ts::ownerTokenFaceGate). It MUST be:
#   • minted ONCE (a long random secret), then
#   • persisted on the /var data partition so it SURVIVES REBOOT (a remote owner logs in with the same
#     token across boots), and
#   • delivered to the unprivileged platform server WITHOUT putting the secret in the image or the unit
#     text. We persist it 0400 under /var/lib/vita/owner/owner.token and the platform unit reads it via
#     systemd LoadCredential= (which copies it into the unit's private $CREDENTIALS_DIRECTORY at 0400).
#
# MECHANISM CHOICE (documented per the task): a tiny oneshot ordered Before=vita-platform.service that
# mints-if-absent. Rationale:
#   • The token is data, not config — it cannot live in the read-only verity image (every node would
#     share one secret) and must be generated per node on first boot. A boot-time mint is the natural fit.
#   • /var/lib/vita is the agentd/host-proxy-owned persistent tree (var.mount), already created 0750 by
#     tmpfiles.d/vita-apps.conf, so the token rides the SAME persistent partition the apps store does —
#     one mount, one reboot-survival story.
#   • LoadCredential delivers the secret to the DynamicUser platform unit as a 0400 file, never as env
#     text in `systemctl show`/the journal — the secure systemd pattern for bearer secrets.
#   • agentd is the only privileged component, but minting a random file under /var needs no host
#     mutation authority, so a narrow root oneshot (write-once, no network, no exec of payload) is
#     sufficient and keeps agentd's surface unchanged.
#
# Idempotent: if the token file already exists and is non-empty, this is a no-op (the persisted token is
# kept across reboots/updates). Fail-LOUD only if it cannot create the dir/file (the network face would
# otherwise come up with an ephemeral token the owner never sees).
set -u

MARKER=VITA-OWNER-TOKEN
TTY=/dev/ttyS0
OWNER_DIR=/var/lib/vita/owner
TOKEN_FILE="${OWNER_DIR}/owner.token"

emit() {
  printf '%s\n' "$1"
  if [ -w "$TTY" ]; then printf '%s\n' "$1" > "$TTY" 2>/dev/null || true; fi
}

# /var/lib/vita is created by tmpfiles (0750 root:vita-agent). Ensure the owner subdir exists 0750 so the
# platform unit's LoadCredential (running as root at unit setup) can read the 0400 token file.
if ! mkdir -p "$OWNER_DIR" 2>/dev/null; then
  emit "$MARKER: FATAL could not create ${OWNER_DIR} (is /var mounted?)"
  exit 1
fi
chmod 0750 "$OWNER_DIR" 2>/dev/null || true

if [ -s "$TOKEN_FILE" ]; then
  emit "$MARKER: existing owner token present (persisted) — keeping it"
  exit 0
fi

# Mint a 256-bit random token, hex-encoded (64 chars). Prefer the kernel CSPRNG; fall back to openssl.
TOKEN=""
if [ -r /proc/sys/kernel/random/uuid ] && command -v od >/dev/null 2>&1 && [ -r /dev/urandom ]; then
  TOKEN=$(od -An -tx1 -N32 /dev/urandom 2>/dev/null | tr -d ' \n')
fi
if [ -z "$TOKEN" ] && command -v openssl >/dev/null 2>&1; then
  TOKEN=$(openssl rand -hex 32 2>/dev/null)
fi
if [ -z "$TOKEN" ]; then
  emit "$MARKER: FATAL no CSPRNG source (/dev/urandom, openssl) to mint the owner token"
  exit 1
fi

# Write 0400 so only root (LoadCredential at unit setup) reads it; persisted on /var.
umask 0077
if ! printf '%s\n' "$TOKEN" > "$TOKEN_FILE"; then
  emit "$MARKER: FATAL could not write ${TOKEN_FILE}"
  exit 1
fi
chmod 0400 "$TOKEN_FILE" 2>/dev/null || true

emit "$MARKER: minted + persisted a new owner token at ${TOKEN_FILE} (read it out-of-band to log into the network face)"
exit 0
