#!/bin/bash
# Vita owner TLS cert DELIVERY — validate (do NOT generate) the owner-provided network-face cert.
#
# WHAT THIS IS (and is NOT): the platform server self-signs the network-face TLS cert in-process by
# default (server/tls.ts); the owner token, not the cert chain, is the trust anchor. An owner who holds
# a REAL cert (spec §16: the owner alone holds the private key) DELIVERS it as two PEM files on the
# persistent data partition:
#     /var/lib/vita/tls/net.crt   (the leaf cert / chain, PEM)
#     /var/lib/vita/tls/net.key   (the private key, PEM)
# The platform unit ALREADY points VITA_TLS_CERT/KEY at those paths, and server-entry.ts hands them to
# the service ONLY when BOTH exist (else it self-signs). This oneshot is the DELIVERY-SIDE confirmation:
# it runs Before=vita-platform.service and reports the disposition the server WILL take, and — when an
# owner cert IS present — validates it is a usable, matched PEM cert+key pair so a typo'd/mismatched
# cert FAILS LOUDLY here instead of silently dropping the network face to self-signed.
#
# THIS SCRIPT NEVER GENERATES OR HANDLES THE OWNER'S PRIVATE KEY beyond confirming the owner-PROVIDED
# file parses and matches the cert. It mutates nothing under /var/lib/vita/tls (it only reads + chmods
# the key to 0640 root:vita-agent if the owner left it group-unreadable, so the DynamicUser can read it;
# it never writes key material). Absence of either file is NOT an error — self-signed is the documented
# fallback. A PRESENT-but-BROKEN pair (only one file, unreadable, non-PEM, or cert/key mismatch) is a
# misconfiguration the owner intended to use TLS-with-a-real-cert, so we log it LOUD (the server will
# still self-sign — fail-safe, not fail-closed — but the owner sees the warning on the console).
set -u

MARKER=VITA-TLS-CERT
TTY=/dev/ttyS0
# VITA_TLS_DIR overrides the cert dir (on-device default /var/lib/vita/tls). For the offline harness
# only (drives this against a temp dir, no root/systemd); the unit never sets it on-device.
TLS_DIR="${VITA_TLS_DIR:-/var/lib/vita/tls}"
CERT_FILE="${TLS_DIR}/net.crt"
KEY_FILE="${TLS_DIR}/net.key"

emit() {
  printf '%s\n' "$1"
  if [ -w "$TTY" ]; then printf '%s\n' "$1" > "$TTY" 2>/dev/null || true; fi
}

# The tls/ dir is created 2750 root:vita-agent by tmpfiles. If it somehow is absent (older image), make
# it — the platform unit's RequiresMountsFor guarantees /var is mounted before we run.
if ! mkdir -p "$TLS_DIR" 2>/dev/null; then
  emit "$MARKER: WARN could not ensure ${TLS_DIR} — server will self-sign"
  exit 0
fi

cert_present=0
key_present=0
[ -s "$CERT_FILE" ] && cert_present=1
[ -s "$KEY_FILE" ] && key_present=1

# Neither delivered → the documented default. Self-signed, owner-token is the trust anchor.
if [ "$cert_present" -eq 0 ] && [ "$key_present" -eq 0 ]; then
  emit "$MARKER: no owner cert at ${CERT_FILE} — network face self-signs in-process (owner-token is the trust anchor)"
  exit 0
fi

# Exactly one of the pair → owner clearly INTENDED a real cert but the delivery is incomplete. Loud warn;
# the server still self-signs (fail-safe).
if [ "$cert_present" -eq 0 ] || [ "$key_present" -eq 0 ]; then
  emit "$MARKER: WARN incomplete owner TLS delivery (cert_present=${cert_present} key_present=${key_present}) — deliver BOTH ${CERT_FILE} and ${KEY_FILE}; server self-signs until then"
  exit 0
fi

# Both present → validate the pair is a usable, MATCHED PEM cert+key. openssl is vendored on the image
# (the owner-token mint already falls back to it). If openssl is absent we cannot validate; trust the
# presence and let server-entry.ts/resolveTlsMaterial fail-loud at start if the PEM is unreadable.
if ! command -v openssl >/dev/null 2>&1; then
  emit "$MARKER: owner cert+key present at ${TLS_DIR} (openssl absent — skipping match check; server validates at start)"
else
  cert_mod=$(openssl x509 -in "$CERT_FILE" -noout -modulus 2>/dev/null | openssl md5 2>/dev/null)
  key_mod=$(openssl rsa -in "$KEY_FILE" -noout -modulus 2>/dev/null | openssl md5 2>/dev/null)
  if [ -z "$cert_mod" ]; then
    emit "$MARKER: WARN ${CERT_FILE} is not a parseable PEM X.509 cert — server self-signs until fixed"
    exit 0
  fi
  if [ -z "$key_mod" ]; then
    # Could be a non-RSA key (EC). Try the generic pkey modulus path before warning.
    key_mod=$(openssl pkey -in "$KEY_FILE" -noout -pubout 2>/dev/null | openssl md5 2>/dev/null)
    cert_mod=$(openssl x509 -in "$CERT_FILE" -noout -pubkey 2>/dev/null | openssl md5 2>/dev/null)
  fi
  if [ -z "$key_mod" ]; then
    emit "$MARKER: WARN ${KEY_FILE} is not a parseable PEM private key — server self-signs until fixed"
    exit 0
  fi
  if [ "$cert_mod" != "$key_mod" ]; then
    emit "$MARKER: WARN owner cert+key DO NOT MATCH (${CERT_FILE} vs ${KEY_FILE}) — server self-signs until a matched pair is delivered"
    exit 0
  fi
  emit "$MARKER: owner-provided cert+key validated (matched pair) at ${TLS_DIR} — network face will serve the owner cert"
fi

# Make the key group-readable by vita-agent so the platform DynamicUser can read it (the owner may have
# delivered it 0600 root:root). We NEVER change its contents — only the group + mode, and only to 0640.
chgrp vita-agent "$KEY_FILE" 2>/dev/null || true
chmod 0640 "$KEY_FILE" 2>/dev/null || true
chgrp vita-agent "$CERT_FILE" 2>/dev/null || true
chmod 0644 "$CERT_FILE" 2>/dev/null || true
exit 0
