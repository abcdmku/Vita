#!/bin/bash
# Vita platform self-test — the BAKED boot probe for the HEADLESS verification (task checks (a)-(f)).
#
# Ordered After=vita-platform.service (Type=notify, so the faces are listening before this runs). It
# emits grep-able VITA-SELFTEST markers to the serial console so a host boot-log capture proves the
# Puter platform is actually serving on a booted node:
#   (a) the generator picked multi-user.target + masked the kiosk (checked by the boot harness via the
#       default target + the masked unit, but we ALSO assert it here for a single evidence stream);
#   (b) vita-platform.service is active (sd_notify READY);
#   (c) LOCAL face: GET /api/whoami (with the minted kiosk app token) -> owner; /kiosk-entry.html served;
#   (d) NETWORK TLS face: GET /api/whoami WITHOUT owner token -> 401, WITH owner+app token -> 200;
#   (e) PERSISTENCE: set a kv witness via the api_origin (the script ALSO records the witness so the
#       post-reboot run can confirm it survived — see the GET branch keyed on a marker file).
#   (f) node-survival markers are emitted by the existing smoke overlay (sb-state / ts) units.
#
# It reads the minted local app token + owner token from /run/vita (published by server-entry.ts). It is
# READ-ONLY against the host (curl + a kv witness write through the gated api). Fail-soft: every check
# prints PASS/FAIL but the unit always exits 0 so it never blocks the boot (the markers are the verdict).
set -u

MARKER=VITA-SELFTEST
TTY=/dev/ttyS0
SESS=/run/vita/platform-session.json
OWNER_FILE=/run/vita/owner-token
LOCAL_PORT="${VITA_PLATFORM_PORT:-7681}"
NET_PORT="${VITA_NETWORK_PORT:-7443}"
WITNESS_KEY="reboot-witness"
WITNESS_VAL="vita-survives-$(cat /etc/machine-id 2>/dev/null | head -c 8)"
# A per-boot-count file on the PERSISTENT partition lets us tell first boot from post-reboot.
BOOTMARK=/var/lib/vita/apps/.selftest-bootcount

emit() {
  printf '%s\n' "$1"
  if [ -w "$TTY" ]; then printf '%s\n' "$1" > "$TTY" 2>/dev/null || true; fi
}

# --- read the published session facts ----------------------------------------
APPTOKEN=""
OWNER=""
if [ -r "$SESS" ]; then
  APPTOKEN=$(grep -o '"appToken"[ ]*:[ ]*"[^"]*"' "$SESS" 2>/dev/null | sed 's/.*"appToken"[ ]*:[ ]*"\([^"]*\)".*/\1/')
fi
if [ -r "$OWNER_FILE" ]; then
  OWNER=$(tr -d '\n' < "$OWNER_FILE")
fi
emit "$MARKER: session app_token_len=${#APPTOKEN} owner_token_len=${#OWNER} local_port=${LOCAL_PORT} net_port=${NET_PORT}"

have_curl=1
command -v curl >/dev/null 2>&1 || have_curl=0
if [ "$have_curl" = 0 ]; then
  emit "$MARKER: FAIL curl missing — cannot probe faces (package curl into the image)"
fi

# (a) generator picked multi-user + masked kiosk
DEF=$(systemctl get-default 2>/dev/null || echo unknown)
KIOSK_STATE=$(systemctl is-enabled vita-kiosk.service 2>/dev/null || echo unknown)
if [ "$DEF" = "multi-user.target" ]; then emit "$MARKER: PASS (a) default.target=multi-user.target"; else emit "$MARKER: FAIL (a) default.target=$DEF"; fi
# A masked unit reports "masked"; in headless the generator symlinks vita-kiosk.service -> /dev/null.
case "$KIOSK_STATE" in
  masked) emit "$MARKER: PASS (a) vita-kiosk.service masked (no display stack)";;
  *) emit "$MARKER: INFO (a) vita-kiosk.service is-enabled=$KIOSK_STATE (expected masked in headless)";;
esac

# (b) platform unit active
ACT=$(systemctl is-active vita-platform.service 2>/dev/null || echo unknown)
if [ "$ACT" = "active" ]; then emit "$MARKER: PASS (b) vita-platform.service active (sd_notify READY)"; else emit "$MARKER: FAIL (b) vita-platform.service is-active=$ACT"; fi

if [ "$have_curl" = 1 ]; then
  # (c) LOCAL face whoami -> owner
  C_CODE=$(curl -s -o /tmp/st_c.body -w '%{http_code}' -H "Authorization: Bearer ${APPTOKEN}" "http://127.0.0.1:${LOCAL_PORT}/api/whoami" 2>/dev/null || echo 000)
  if [ "$C_CODE" = "200" ] && grep -q '"username":"owner"' /tmp/st_c.body 2>/dev/null; then
    emit "$MARKER: PASS (c) local /api/whoami -> 200 owner"
  else
    emit "$MARKER: FAIL (c) local /api/whoami code=$C_CODE body=$(head -c 160 /tmp/st_c.body 2>/dev/null)"
  fi
  # (c) kiosk entry served
  K_CODE=$(curl -s -o /tmp/st_k.body -w '%{http_code}' "http://127.0.0.1:${LOCAL_PORT}/kiosk-entry.html" 2>/dev/null || echo 000)
  if [ "$K_CODE" = "200" ] && grep -q 'puter/v2.js' /tmp/st_k.body 2>/dev/null; then
    emit "$MARKER: PASS (c) /kiosk-entry.html served (HTTP 200, references vendored puter.js)"
  else
    emit "$MARKER: FAIL (c) /kiosk-entry.html code=$K_CODE"
  fi

  # (d) network TLS face WITHOUT owner token -> 401
  D1=$(curl -sk -o /dev/null -w '%{http_code}' -H "Authorization: Bearer ${APPTOKEN}" "https://127.0.0.1:${NET_PORT}/api/whoami" 2>/dev/null || echo 000)
  if [ "$D1" = "401" ]; then emit "$MARKER: PASS (d) network TLS no owner token -> 401"; else emit "$MARKER: FAIL (d) network no-owner code=$D1 (expected 401)"; fi
  # (d) network TLS face WITH owner + app token -> 200 owner
  D2=$(curl -sk -o /tmp/st_d2.body -w '%{http_code}' -H "Authorization: Bearer ${APPTOKEN}" -H "x-vita-owner: ${OWNER}" "https://127.0.0.1:${NET_PORT}/api/whoami" 2>/dev/null || echo 000)
  if [ "$D2" = "200" ] && grep -q '"username":"owner"' /tmp/st_d2.body 2>/dev/null; then
    emit "$MARKER: PASS (d) network TLS owner+app token -> 200 owner"
  else
    emit "$MARKER: FAIL (d) network owner+app code=$D2 body=$(head -c 160 /tmp/st_d2.body 2>/dev/null)"
  fi

  # (e) PERSISTENCE — set on first boot, verify after reboot. Use the kv store via /api/drivers/call.
  if [ -f "$BOOTMARK" ]; then
    # post-reboot: the witness must already be present from the previous boot.
    G=$(curl -s -H "Authorization: Bearer ${APPTOKEN}" -H 'content-type: application/json' \
      --data "{\"interface\":\"puter-kvstore\",\"method\":\"get\",\"args\":{\"key\":\"${WITNESS_KEY}\"}}" \
      "http://127.0.0.1:${LOCAL_PORT}/api/drivers/call" 2>/dev/null || echo '')
    if printf '%s' "$G" | grep -q 'vita-survives-'; then
      emit "$MARKER: PASS (e) persistence — kv witness SURVIVED REBOOT: $G"
    else
      emit "$MARKER: FAIL (e) persistence — witness missing after reboot: $G"
    fi
  else
    # first boot: write the witness + the boot marker (both on the persistent /var partition).
    S=$(curl -s -H "Authorization: Bearer ${APPTOKEN}" -H 'content-type: application/json' \
      --data "{\"interface\":\"puter-kvstore\",\"method\":\"set\",\"args\":{\"key\":\"${WITNESS_KEY}\",\"value\":\"${WITNESS_VAL}\"}}" \
      "http://127.0.0.1:${LOCAL_PORT}/api/drivers/call" 2>/dev/null || echo '')
    emit "$MARKER: INFO (e) first boot — wrote kv witness (${WITNESS_VAL}): $S"
    # Drop the boot marker so the NEXT boot takes the post-reboot branch above.
    printf 'booted\n' > "$BOOTMARK" 2>/dev/null && emit "$MARKER: INFO (e) bootmark written, REBOOT-NOW to prove survival" || emit "$MARKER: WARN (e) could not write bootmark $BOOTMARK"
    sync 2>/dev/null || true
  fi
fi

emit "$MARKER: DONE"
exit 0
