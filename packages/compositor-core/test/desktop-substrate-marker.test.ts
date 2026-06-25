import assert from "node:assert/strict";
import { test } from "node:test";

import { formatDesktopCompositorMarker } from "../../../sdk/typescript/src/desktop-substrate.ts";

test("TS compositor marker formatter cannot emit native KMS OK marker", () => {
  const marker = formatDesktopCompositorMarker({
    composited: "OK",
    damage: "OK",
    gpu: "vmwgfx",
    marker: "VITA-COMPOSITOR",
    present: "kms",
    reposition: "no-repaint",
    status: "OK",
    surfaces: 2,
  });

  assert.equal(
    marker,
    "VITA-COMPOSITOR: gpu=vmwgfx surfaces=2 composited=FAIL " +
      "reposition=unverified present=kms damage=FAIL status=FAILSAFE " +
      "reason=native_kms_marker_only",
  );
  assert.equal(marker.includes("present=kms damage=OK status=OK"), false);
});
