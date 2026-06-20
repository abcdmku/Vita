import assert from "node:assert/strict";
import { test } from "node:test";

import { previewUpdate } from "../src/update-preview.ts";
import type {
  UpdatePreview,
  UpdatePreviewRejectionCode,
} from "../src/update-preview.ts";

function validConfig(): unknown {
  return {
    slots: [
      { id: "a", active: true, bootable: true, version: "1.2.0" },
      { id: "b", active: false, bootable: true, version: "1.1.0" },
    ],
    policy: { automaticRollback: true, maxFailedBoots: 3 },
  };
}

function validPlan(targetSlot: "a" | "b" = "b"): unknown {
  return {
    targetSlot,
    bundle: {
      ref: "vita-os@1.3.0",
      integrity: "sha256-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
      version: "1.3.0",
    },
  };
}

test("previewUpdate returns a safe preview for an inactive target slot", () => {
  const preview = previewUpdate(validConfig(), validPlan());

  assert.equal(preview.safe, true);
  assert.equal(preview.activeSlot, "a");
  assert.equal(preview.targetSlot, "b");
  assert.deepEqual(preview.bundle, {
    ref: "vita-os@1.3.0",
    integrity: "sha256-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
    version: "1.3.0",
  });
  assert.deepEqual(preview.rejections, []);
});

test("previewUpdate rejects a plan targeting the active slot without throwing", () => {
  const preview = previewUpdate(validConfig(), validPlan("a"));

  assert.equal(preview.safe, false);
  assert.equal(preview.activeSlot, "a");
  assert.equal(preview.targetSlot, "a");
  assert.deepEqual(preview.bundle, {
    ref: "vita-os@1.3.0",
    integrity: "sha256-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
    version: "1.3.0",
  });
  assert.deepEqual(rejectionCodes(preview), ["UNSAFE_ACTIVE_SLOT"]);
  assert.equal(preview.rejections[0]?.path, "targetSlot");
});

test("previewUpdate converts malformed config and plan into validator rejections", () => {
  const malformedConfig = validConfig() as Record<string, unknown>;
  delete malformedConfig["policy"];

  const malformedPlan = validPlan() as {
    bundle: {
      integrity: string;
    };
  };
  malformedPlan.bundle.integrity = "not-an-sri";

  const preview = previewUpdate(malformedConfig, malformedPlan);

  assert.equal(preview.safe, false);
  assert.equal(preview.activeSlot, null);
  assert.equal(preview.targetSlot, null);
  assert.equal(preview.bundle, null);
  assert.deepEqual(rejectionCodes(preview), ["INVALID_CONFIG", "INVALID_PLAN"]);
  assert.equal(preview.rejections[0]?.source, "config");
  assert.equal(preview.rejections[1]?.source, "plan");
});

test("previewUpdate fails closed on hostile input without throwing", () => {
  const hostileConfig = {
    policy: { automaticRollback: true, maxFailedBoots: 3 },
  };
  Object.defineProperty(hostileConfig, "slots", {
    enumerable: true,
    get() {
      assert.fail("accessor properties must not be invoked");
    },
  });

  const hostileSlots: unknown[] = [
    { id: "a", active: true, bootable: true, version: "1.2.0" },
    { id: "b", active: false, bootable: true, version: "1.1.0" },
  ];
  Object.defineProperty(hostileSlots, "find", {
    enumerable: true,
    value() {
      assert.fail("shadowed array methods must not be invoked");
    },
  });

  const cyclic: Record<string, unknown> = {};
  cyclic["self"] = cyclic;

  assert.doesNotThrow(() => previewUpdate(hostileConfig, validPlan()));
  assert.doesNotThrow(() => previewUpdate({ ...validConfigRecord(), slots: hostileSlots }, validPlan()));
  assert.doesNotThrow(() => previewUpdate(cyclic, cyclic));

  const preview = previewUpdate(hostileConfig, validPlan());
  const shadowedPreview = previewUpdate({ ...validConfigRecord(), slots: hostileSlots }, validPlan());
  const cyclicPreview = previewUpdate(cyclic, cyclic);

  assert.equal(preview.safe, false);
  assert.equal(shadowedPreview.safe, false);
  assert.equal(cyclicPreview.safe, false);
  assert.deepEqual(rejectionCodes(preview), ["INVALID_CONFIG"]);
  assert.deepEqual(rejectionCodes(shadowedPreview), ["INVALID_CONFIG"]);
  assert.deepEqual(rejectionCodes(cyclicPreview), ["INVALID_CONFIG", "INVALID_PLAN"]);
});

function validConfigRecord(): Record<string, unknown> {
  return validConfig() as Record<string, unknown>;
}

function rejectionCodes(preview: UpdatePreview): readonly UpdatePreviewRejectionCode[] {
  const output: UpdatePreviewRejectionCode[] = [];

  for (let index = 0; index < preview.rejections.length; index += 1) {
    const rejection = preview.rejections[index];

    if (rejection !== undefined) {
      output[output.length] = rejection.code;
    }
  }

  return output;
}
