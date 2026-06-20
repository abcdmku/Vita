import assert from "node:assert/strict";
import { test } from "node:test";

import { bestAvailable } from "../src/capabilities.ts";
import { normalize } from "../src/plan.ts";
import { validatePlan } from "../src/validate.ts";
import type { DeviceSnapshot } from "../src/capabilities.ts";
import type { DesiredState } from "../src/plan.ts";
import type { ValidationResult } from "../src/validate.ts";

const x86Snapshot: DeviceSnapshot = {
  memoryGB: 32,
  architecture: "x86_64",
  accelerators: [
    {
      kind: "intel.npu",
      generation: "core-ultra",
    },
    {
      kind: "nvidia.cuda",
      memoryGB: 12,
      compute: "8.6",
    },
  ],
  tpm: {
    present: true,
    version: "2.0",
    sealedKeyUnlock: true,
  },
  virtualization: {
    hardware: true,
  },
};

const armNoAcceleratorSnapshot: DeviceSnapshot = {
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

test("a valid least-privilege state validates to its canonical plan", () => {
  const accelerator = bestAvailable(x86Snapshot, {
    prefer: ["npu", "gpu", "cpu"],
    requireFallback: "cpu",
  });

  assert.equal(accelerator.type, "accelerator-selection");

  const state: DesiredState = {
    identity: {
      owner: {
        id: "did:example:alice",
        displayName: "Alice",
      },
      passkeysRequired: true,
    },
    storage: {
      dataVolume: {
        encryption: "required",
        snapshots: "daily",
        quotaGiB: 256,
      },
    },
    apps: [
      {
        id: "local-search",
        config: {
          allowedCapabilities: ["data.files.read-only"],
          dataAccess: [
            {
              type: "data-access",
              scope: "files",
              mode: "read-only",
            },
          ],
          accelerator,
        },
      },
      {
        id: "atproto-pds",
        version: "1.0.0",
        config: {
          allowedCapabilities: ["network.public"],
          publicAccess: true,
          memory: "2GiB",
        },
      },
    ],
    backups: [
      {
        id: "usb-main",
        target: "usb",
        schedule: "daily",
        retentionDays: 30,
      },
    ],
  };

  const result = validatePlan(state, x86Snapshot);

  if (!result.ok) {
    assert.fail(`expected validation to pass: ${JSON.stringify(result.errors)}`);
  }

  assert.equal(result.ok, true);

  assert.deepEqual(result.plan, normalize(state));
});

test("schema-invalid states are rejected with precise paths", () => {
  const invalidState = {
    storage: {
      dataVolume: {
        encryption: "always",
      },
    },
    apps: [
      {
        enabled: true,
        unexpectedAppField: true,
      },
    ],
    backups: [
      {
        id: "usb-main",
        target: "cloud",
        unknownBackupField: true,
      },
    ],
  } as unknown as DesiredState;

  const paths = rejectedPaths(validatePlan(invalidState, x86Snapshot));

  assert.deepEqual(
    [
      "apps/0/id",
      "apps/0/unexpectedAppField",
      "backups/0/schedule",
      "backups/0/target",
      "backups/0/unknownBackupField",
      "storage/dataVolume/encryption",
    ].every((path) => paths.includes(path)),
    true,
  );
});

test("overprivileged states are rejected for undeclared access and unavailable accelerators", () => {
  const overprivilegedState: DesiredState = {
    apps: [
      {
        id: "local-search",
        config: {
          dataAccess: [
            {
              type: "data-access",
              scope: "files",
              mode: "read-only",
            },
          ],
        },
      },
      {
        id: "vision",
        config: {
          accelerator: {
            prefer: ["npu"],
            requireFallback: false,
          },
        },
      },
    ],
  };

  const paths = rejectedPaths(validatePlan(overprivilegedState, armNoAcceleratorSnapshot));

  assert.equal(paths.includes("apps/0/config/dataAccess/0"), true);
  assert.equal(paths.includes("apps/1/config/accelerator"), true);
});

test("tampered embedded accelerator selections are rejected", () => {
  const accelerator = bestAvailable(x86Snapshot, {
    prefer: ["gpu"],
    requireFallback: false,
  });

  assert.equal(accelerator.type, "accelerator-selection");

  if (accelerator.type !== "accelerator-selection") {
    assert.fail("expected a GPU accelerator selection");
  }

  const state: DesiredState = {
    apps: [
      {
        id: "vision",
        config: {
          accelerator: {
            ...accelerator,
            selected: {
              kind: "nvidia.cuda",
              memoryGB: 24,
              compute: "8.6",
            },
          },
        },
      },
    ],
  };

  const paths = rejectedPaths(validatePlan(state, x86Snapshot));

  assert.equal(paths.includes("apps/0/config/accelerator/selected"), true);
});

test("embedded accelerator refusals are rejected instead of accepted as requests", () => {
  const refusal = bestAvailable(armNoAcceleratorSnapshot, {
    prefer: ["npu"],
    requireFallback: false,
  });

  assert.equal(refusal.type, "accelerator-refusal");

  if (refusal.type !== "accelerator-refusal") {
    assert.fail("expected an accelerator refusal");
  }

  const state: DesiredState = {
    apps: [
      {
        id: "vision",
        config: {
          accelerator: refusal,
        },
      },
    ],
  };

  const paths = rejectedPaths(validatePlan(state, armNoAcceleratorSnapshot));

  assert.equal(paths.includes("apps/0/config/accelerator"), true);
});

test("fail-closed behavior rejects unknown requested capabilities", () => {
  const state: DesiredState = {
    apps: [
      {
        id: "dashboard",
        config: {
          allowedCapabilities: ["data.files.read-only"],
          capabilities: ["network.public"],
        },
      },
    ],
  };

  const paths = rejectedPaths(validatePlan(state, x86Snapshot));

  assert.deepEqual(paths, ["apps/0/config/capabilities/0"]);
});

function rejectedPaths(result: ValidationResult): readonly string[] {
  if (result.ok) {
    assert.fail(`expected validation to fail: ${JSON.stringify(result.plan)}`);
  }

  return result.errors.map((error) => error.path).sort();
}
