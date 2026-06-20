import assert from "node:assert/strict";
import { test } from "node:test";

import { app, defineSystem } from "../src/define-system.ts";
import { validatePlan } from "../src/validate.ts";
import type {
  AcceleratorCapability,
  AcceleratorSelectionResult,
  SystemSnapshotInput,
} from "../src/define-system.ts";

test("defineSystem authors receive a typed refusal when no accelerator satisfies a hard request", () => {
  let observed: AcceleratorSelectionResult | undefined;
  const system = defineSystem(({ device }) => {
    const selection = device.ai.bestAvailable({
      prefer: ["npu"],
      requireFallback: false,
    });
    observed = selection;

    return {
      apps: [app("local-search", { accelerator: selection })],
    };
  });

  const plan = system(deviceSnapshot([]));

  assert.equal(observed?.type, "accelerator-refusal");

  if (observed?.type !== "accelerator-refusal") {
    assert.fail("expected a typed accelerator refusal");
  }

  assert.equal(observed.code, "ACCELERATOR_UNAVAILABLE");
  assert.equal(observed.requireFallback, false);
  assert.deepEqual(observed.prefer, ["npu"]);
  const acceleratorConfig = plan.apps[0]?.config?.accelerator;
  assert.equal(
    acceleratorConfig !== null &&
      typeof acceleratorConfig === "object" &&
      !Array.isArray(acceleratorConfig)
      ? (acceleratorConfig as { readonly type?: unknown }).type
      : undefined,
    "accelerator-refusal",
  );
});

test("defineSystem authors receive the declared CPU fallback when fallback is required", () => {
  let observed: AcceleratorSelectionResult | undefined;
  const system = defineSystem(({ device }) => {
    const selection = device.ai.bestAvailable({
      prefer: ["npu", "gpu"],
      requireFallback: "cpu",
    });
    observed = selection;

    return {
      apps: [app("local-search", { accelerator: selection })],
    };
  });

  system(deviceSnapshot([]));

  assert.equal(observed?.type, "accelerator-selection");

  if (observed?.type !== "accelerator-selection") {
    assert.fail("expected a CPU fallback selection");
  }

  assert.equal(observed.selected.kind, "cpu");
  assert.equal(observed.selectedPreference, "cpu");
  assert.equal(observed.fallback, true);
});

test("explicitly preferred CPU selections are not marked as fallback", () => {
  let observed: AcceleratorSelectionResult | undefined;
  const system = defineSystem(({ device }) => {
    const selection = device.ai.bestAvailable({
      prefer: ["cpu", "gpu"],
      requireFallback: "cpu",
    });
    observed = selection;

    return {
      apps: [app("local-search", { accelerator: selection })],
    };
  });

  system(deviceSnapshot([{ kind: "cpu", architecture: "x86_64" }]));

  assert.equal(observed?.type, "accelerator-selection");

  if (observed?.type !== "accelerator-selection") {
    assert.fail("expected an explicitly preferred CPU selection");
  }

  assert.equal(observed.selected.kind, "cpu");
  assert.equal(observed.selectedPreference, "cpu");
  assert.equal(observed.fallback, false);
});

test("accelerator selection returns a frozen clone instead of a mutable snapshot reference", () => {
  const snapshot = deviceSnapshot([{ kind: "amd.rocm", memoryGB: 16 }]);
  let observed: AcceleratorSelectionResult | undefined;
  const system = defineSystem(({ device }) => {
    const selection = device.ai.bestAvailable({
      prefer: ["gpu"],
      requireFallback: false,
    });
    observed = selection;

    return { apps: [app("local-search")] };
  });

  system(snapshot);

  assert.equal(observed?.type, "accelerator-selection");

  if (observed?.type !== "accelerator-selection") {
    assert.fail("expected a GPU accelerator selection");
  }

  assert.notEqual(observed.selected, snapshot.device.accelerators[0]);
  assert.equal(Object.isFrozen(observed.selected), true);
  assert.throws(() => {
    (observed.selected as { memoryGB: number }).memoryGB = 4;
  }, TypeError);
  assert.equal(snapshot.device.accelerators[0]?.memoryGB, 16);
});

test("runtime validation rejects unknown accelerator capability fields", () => {
  const result = validatePlan(
    {
      apps: [app("local-search")],
    },
    deviceSnapshot([
      {
        kind: "cpu",
        architecture: "x86_64",
        extraField: true,
      } as unknown as AcceleratorCapability,
    ]).device,
  );

  assert.equal(result.ok, false);

  if (result.ok) {
    assert.fail("expected unknown accelerator fields to fail validation");
  }

  assert.deepEqual(
    result.errors.map((error) => `${error.path}: ${error.message}`),
    ["snapshot/accelerators/0/extraField: Unknown field."],
  );
});

function deviceSnapshot(accelerators: readonly AcceleratorCapability[]): SystemSnapshotInput {
  return {
    device: {
      memoryGB: 16,
      architecture: "x86_64",
      accelerators,
      tpm: {
        present: true,
        version: "2.0",
      },
      virtualization: {
        hardware: true,
      },
    },
    data: {
      files: {
        readOnly() {
          return {
            type: "data-access",
            scope: "files",
            mode: "read-only",
          };
        },
      },
    },
  };
}
