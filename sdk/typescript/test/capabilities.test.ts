import assert from "node:assert/strict";
import { test } from "node:test";

import { bestAvailable } from "../src/capabilities.ts";
import type { AcceleratorCapability, DeviceSnapshot } from "../src/capabilities.ts";

const x86Snapshot: DeviceSnapshot = {
  memoryGB: 32,
  architecture: "x86_64",
  accelerators: [
    {
      kind: "nvidia.cuda",
      memoryGB: 12,
      compute: "8.6",
    },
    {
      kind: "intel.npu",
      generation: "core-ultra",
    },
  ],
  tpm: {
    present: true,
    version: "2.0",
    sealedKeyUnlock: true,
  },
  virtualization: {
    hardware: true,
    nested: false,
  },
};

const armSnapshot: DeviceSnapshot = {
  memoryGB: 8,
  architecture: "arm64",
  accelerators: [],
  tpm: {
    present: false,
  },
  virtualization: {
    hardware: true,
  },
};

test("AcceleratorCapability models every spec 14.1 variant", () => {
  const capabilities: readonly AcceleratorCapability[] = [
    { kind: "nvidia.cuda", memoryGB: 24, compute: "9.0" },
    { kind: "intel.npu", generation: "core-ultra" },
    { kind: "amd.npu", generation: "ryzen-ai" },
    { kind: "amd.rocm", memoryGB: 16 },
    { kind: "intel.gpu", memoryModel: "shared" },
    { kind: "cpu", architecture: "x86_64" },
  ];

  assert.deepEqual(
    capabilities.map((capability) => capability.kind),
    ["nvidia.cuda", "intel.npu", "amd.npu", "amd.rocm", "intel.gpu", "cpu"],
  );
});

test("bestAvailable honors the requested npu before gpu before cpu order", () => {
  const result = bestAvailable(x86Snapshot, {
    prefer: ["npu", "gpu", "cpu"],
    requireFallback: "cpu",
  });

  assert.equal(result.type, "accelerator-selection");

  if (result.type !== "accelerator-selection") {
    assert.fail("expected an accelerator selection");
  }

  assert.equal(result.selected.kind, "intel.npu");
  assert.equal(result.selectedPreference, "npu");
  assert.equal(result.fallback, false);
});

test("bestAvailable returns the declared CPU fallback with no accelerators present", () => {
  const result = bestAvailable(armSnapshot, {
    prefer: ["npu", "gpu"],
    requireFallback: "cpu",
  });

  assert.equal(result.type, "accelerator-selection");

  if (result.type !== "accelerator-selection") {
    assert.fail("expected a CPU fallback selection");
  }

  assert.deepEqual(result.selected, {
    kind: "cpu",
    architecture: "arm64",
  });
  assert.equal(result.selectedPreference, "cpu");
  assert.equal(result.fallback, true);
});

test("bestAvailable returns a typed refusal when a hard requirement cannot be met", () => {
  const result = bestAvailable(x86Snapshot, {
    prefer: ["npu"],
    requireFallback: false,
  });

  assert.equal(result.type, "accelerator-selection");

  if (result.type !== "accelerator-selection") {
    assert.fail("expected the x86 NPU profile to satisfy the hard requirement");
  }

  const missingNpuResult = bestAvailable(
    {
      ...x86Snapshot,
      accelerators: [{ kind: "amd.rocm", memoryGB: 16 }],
    },
    {
      prefer: ["npu"],
      requireFallback: false,
    },
  );

  assert.equal(missingNpuResult.type, "accelerator-refusal");

  if (missingNpuResult.type !== "accelerator-refusal") {
    assert.fail("expected a typed refusal instead of an invalid selection");
  }

  assert.equal(missingNpuResult.code, "ACCELERATOR_UNAVAILABLE");
  assert.deepEqual(missingNpuResult.prefer, ["npu"]);
  assert.equal(missingNpuResult.requireFallback, false);
});
