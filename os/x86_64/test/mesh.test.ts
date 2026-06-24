import assert from "node:assert/strict";
import test from "node:test";

import {
  formatMeshMarker,
  formatMeshRejectMarker,
  parseMeshState,
} from "../ts-overlay/usr/lib/vita/ts/vita/mesh-marker.ts";

const measuredMeshState = Object.freeze({
  applied: true,
  status: Object.freeze({
    denied: "undeclared:2223",
    drop: "enforced",
    handshake: "OK",
    peers: 1,
    reach: "OK",
    status: "OK",
  }),
});

test("VITA-MESH marker fires only for measured handshake reach deny drop", () => {
  assert.equal(
    formatMeshMarker(parseMeshState(measuredMeshState)),
    "VITA-MESH: peers=1 handshake=OK reach=OK denied=undeclared_2223 drop=enforced status=OK",
  );

  for (const field of ["handshake", "reach", "denied", "drop"] as const) {
    const status: Record<string, unknown> = { ...measuredMeshState.status };
    delete status[field];

    assert.equal(
      formatMeshMarker(parseMeshState({ applied: true, status })),
      "VITA-MESH-ERROR: reason=mesh_unverified status=FAILSAFE",
      `missing ${field} must fail closed`,
    );
  }
});

test("VITA-MESH parser rejects absent or malformed mesh state", () => {
  assert.deepEqual(parseMeshState({ applied: false }), { ok: false });
  assert.deepEqual(parseMeshState({ applied: true, status: { peers: 0, status: "FAIL" } }), { ok: false });
  assert.deepEqual(parseMeshState({ applied: true, status: { peers: 1.5, status: "OK" } }), { ok: false });
});

test("VITA-MESH-REJECT marker sanitizes specific rejection reasons", () => {
  assert.equal(
    formatMeshRejectMarker("invalid allowedIps[0]: source covers all traffic"),
    "VITA-MESH-REJECT: reason=invalid_allowedIps_0_source_covers_all_traffic status=OK",
  );
});
