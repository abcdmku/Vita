import assert from "node:assert/strict";
import { test } from "node:test";

import {
  DEFAULT_ZOOM_POLICY_INPUT,
  ZOOM_POLICY_LIMITS,
  deriveZoomPolicy,
} from "../../../../ui_kits/desktop/viewmodels/zoom-policy.ts";
import type {
  ZoomPolicy,
} from "../../../../ui_kits/desktop/viewmodels/zoom-policy.ts";

test("zoom policy returns exact frozen default output", () => {
  const policy = deriveZoomPolicy(DEFAULT_ZOOM_POLICY_INPUT);

  assert.deepEqual(policy, {
    controlMin: 44,
    density: "comfortable",
    rootScale: 1,
  });
  assertFrozenPolicy(policy);
  assert.equal(JSON.stringify(deriveZoomPolicy(DEFAULT_ZOOM_POLICY_INPUT)), JSON.stringify(policy));
});

test("zoom policy clamps uiZoom and textScale to configured bounds", () => {
  const high = deriveZoomPolicy({
    textScale: 10,
    uiZoom: 10,
  });
  const low = deriveZoomPolicy({
    textScale: 0,
    uiZoom: 0,
  });

  assert.deepEqual(high, {
    controlMin: 44,
    density: "comfortable",
    rootScale: ZOOM_POLICY_LIMITS.rootScale.max,
  });
  assert.deepEqual(low, {
    controlMin: 110,
    density: "compact",
    rootScale: ZOOM_POLICY_LIMITS.rootScale.min,
  });
});

test("zoom policy makes 200 percent text scale reachable", () => {
  const policy = deriveZoomPolicy({
    textScale: 2,
    uiZoom: 1,
  });

  assert.equal(policy.rootScale, 2);
  assert.equal(policy.controlMin, 44);
  assert.equal(policy.density, "comfortable");
});

test("zoom policy preserves the interactive control-size floor under zoom-out", () => {
  const policy = deriveZoomPolicy({
    textScale: 1,
    uiZoom: 0.5,
  });

  assert.equal(policy.rootScale, 0.5);
  assert.equal(policy.controlMin, 88);
  assert.equal(policy.controlMin * policy.rootScale, ZOOM_POLICY_LIMITS.controlFloor);
  assert.equal(policy.density, "compact");
});

test("zoom policy resolves NaN missing null and accessor inputs to safe defaults", () => {
  const accessorInput = Object.defineProperty({}, "textScale", {
    enumerable: true,
    get() {
      throw new Error("should not read accessor value");
    },
  });

  assert.deepEqual(deriveZoomPolicy({
    textScale: Number.NaN,
    uiZoom: Number.NaN,
  }), deriveZoomPolicy());
  assert.deepEqual(deriveZoomPolicy({
    uiZoom: 1.5,
  }), {
    controlMin: 44,
    density: "comfortable",
    rootScale: 1.5,
  });
  assert.deepEqual(deriveZoomPolicy(null), deriveZoomPolicy());
  assert.deepEqual(deriveZoomPolicy(accessorInput), deriveZoomPolicy());
});

test("zoom policy output is byte-stable across repeated calls", () => {
  const input = Object.freeze({
    textScale: 1.75,
    uiZoom: 1.25,
  });
  const first = deriveZoomPolicy(input);
  const second = deriveZoomPolicy(input);

  assert.notEqual(first, second);
  assert.equal(JSON.stringify(first), JSON.stringify(second));
  assert.deepEqual(first, {
    controlMin: 44,
    density: "comfortable",
    rootScale: 2.1875,
  });
});

function assertFrozenPolicy(policy: ZoomPolicy): void {
  assert.equal(Object.isFrozen(policy), true);
  assert.throws(() => {
    (policy as { rootScale: number }).rootScale = 2;
  }, TypeError);
}
