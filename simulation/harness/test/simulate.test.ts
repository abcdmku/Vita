import assert from "node:assert/strict";
import { test } from "node:test";

import { simulate } from "../src/simulate.ts";
import type {
  SimulatedOperation,
  SimulationRejectionCode,
  SimulationResult,
} from "../src/simulate.ts";
import type { StorageLayout } from "../../../sdk/typescript/src/storage-model.ts";

test("a feasible plan within profile limits reports all operations ok", () => {
  const result = simulate(validProfile(), {
    operations: [
      {
        id: "api",
        kind: "workload",
        resources: {
          cpuCores: 2,
          memoryMiB: 1_024,
          storageMiB: 100,
        },
        requires: {
          architecture: "x86_64",
          network: true,
        },
      },
      {
        id: "data-layout",
        kind: "storage",
        layout: validLayout(),
        requires: {
          storage: true,
        },
      },
    ],
  });

  assert.equal(result.ok, true);
  assert.equal(result.feasible, true);
  assert.equal(result.rejections.length, 0);
  assert.equal(result.operations.every((operation) => operation.ok), true);
  assert.deepEqual(result.resources.projected, {
    cpuCores: 2,
    memoryMiB: 1_024,
    storageMiB: 262_244,
  });
});

test("a resource overage makes the plan infeasible and flags the over-budget operation", () => {
  const result = simulate(profileWithMemory(1_024), {
    operations: [
      {
        id: "first",
        kind: "workload",
        resources: {
          cpuCores: 1,
          memoryMiB: 512,
          storageMiB: 0,
        },
      },
      {
        id: "second",
        kind: "workload",
        resources: {
          cpuCores: 1,
          memoryMiB: 600,
          storageMiB: 0,
        },
      },
    ],
  });

  assert.equal(result.ok, true);
  assert.equal(result.feasible, false);
  assert.equal(operationAt(result, 0).ok, true);
  assert.equal(hasRejection(operationAt(result, 1), "RESOURCE_LIMIT_EXCEEDED"), true);
  assert.deepEqual(result.resources.overBudget, [
    {
      excess: 88,
      limit: 1_024,
      operationIndex: 1,
      requested: 1_112,
      resource: "memoryMiB",
    },
  ]);
});

test("a missing capability makes the requiring operation infeasible", () => {
  const result = simulate(profileWithoutAccelerators(), {
    operations: [
      {
        id: "gpu-worker",
        kind: "workload",
        resources: {
          cpuCores: 1,
          memoryMiB: 512,
          storageMiB: 0,
        },
        requires: {
          accelerator: "gpu",
        },
      },
    ],
  });

  assert.equal(result.ok, true);
  assert.equal(result.feasible, false);
  assert.equal(hasRejection(operationAt(result, 0), "MISSING_CAPABILITY"), true);
});

test("simulation is deterministic for identical inputs", () => {
  const profile = validProfile();
  const plan = {
    operations: [
      {
        id: "api",
        kind: "workload",
        resources: {
          cpuCores: 1,
          memoryMiB: 256,
          storageMiB: 16,
        },
        requires: {
          architecture: "x86_64",
          network: true,
        },
      },
    ],
  };

  assert.equal(JSON.stringify(simulate(profile, plan)), JSON.stringify(simulate(profile, plan)));
});

test("malformed profile and plan inputs reject through safeNormalize without throwing", () => {
  const cyclicProfile: Record<string, unknown> = {};
  cyclicProfile["self"] = cyclicProfile;

  let profileResult: SimulationResult | undefined;
  assert.doesNotThrow(() => {
    profileResult = simulate(cyclicProfile, { operations: [] });
  });
  assert.equal(profileResult?.ok, false);
  assert.equal(profileResult?.rejections[0]?.code, "INVALID_PROFILE");

  const accessorPlan: Record<string, unknown> = {};
  let getterReads = 0;
  Object.defineProperty(accessorPlan, "operations", {
    enumerable: true,
    get() {
      getterReads += 1;
      throw new Error("getter should not be read");
    },
  });

  let planResult: SimulationResult | undefined;
  assert.doesNotThrow(() => {
    planResult = simulate(validProfile(), accessorPlan);
  });
  assert.equal(planResult?.ok, false);
  assert.equal(planResult?.rejections[0]?.code, "INVALID_PLAN");
  assert.equal(getterReads, 0);
});

test("storage operation rejects an unhealthy profile storage layout", () => {
  const result = simulate(profileWithStorageLayout(unhealthyProfileLayout()), {
    operations: [
      {
        id: "healthy-plan-layout",
        kind: "storage",
        layout: validLayout(),
        requires: {
          storage: true,
        },
      },
    ],
  });

  assert.equal(result.ok, true);
  assert.equal(result.feasible, false);
  assert.equal(hasRejection(operationAt(result, 0), "UNHEALTHY_STORAGE"), true);
  assert.equal(
    operationAt(result, 0).rejections.some((rejection) =>
      rejection.message.includes("Profile storage layout"),
    ),
    true,
  );
});

function operationAt(result: SimulationResult, index: number): SimulatedOperation {
  const operation = result.operations[index];

  if (operation === undefined) {
    assert.fail(`missing operation ${index}: ${JSON.stringify(result)}`);
  }

  return operation;
}

function hasRejection(
  operation: SimulatedOperation,
  code: SimulationRejectionCode,
): boolean {
  return operation.rejections.some((rejection) => rejection.code === code);
}

function validProfile(): Record<string, unknown> {
  return profileWithStorageLayout(validLayout());
}

function profileWithMemory(memoryMiB: number): Record<string, unknown> {
  return {
    ...validProfile(),
    resources: {
      cpuCores: 4,
      memoryMiB,
      storageMiB: 800_000,
    },
  };
}

function profileWithoutAccelerators(): Record<string, unknown> {
  return {
    ...validProfile(),
    capabilities: {
      architectures: ["x86_64"],
      accelerators: [],
      network: true,
      storage: true,
      tpm: true,
      virtualization: true,
    },
  };
}

function profileWithStorageLayout(storageLayout: StorageLayout): Record<string, unknown> {
  return {
    capabilities: {
      architectures: ["x86_64"],
      accelerators: ["gpu"],
      network: true,
      storage: true,
      tpm: true,
      virtualization: true,
    },
    profiles: [],
    resources: {
      cpuCores: 4,
      memoryMiB: 4_096,
      storageMiB: 800_000,
    },
    storageLayout,
  };
}

function unhealthyProfileLayout(): StorageLayout {
  const layout = validLayout();

  return {
    ...layout,
    diskHealth: {
      ...layout.diskHealth,
      status: "critical",
    },
  };
}

function validLayout(): StorageLayout {
  return {
    dataVolume: {
      encryption: "luks2",
      filesystem: "btrfs",
      recoveryKeyRequired: true,
      tpmUnlock: true,
    },
    diskHealth: {
      checksumErrors: 0,
      freeBytes: 824_633_720_832,
      smart: {
        powerOnHours: 100,
        reallocatedSectors: 0,
        status: "passed",
        temperatureC: 39,
      },
      status: "healthy",
      totalBytes: 1_099_511_627_776,
      usedBytes: 274_877_906_944,
    },
    snapshotPolicy: {
      cadence: "hourly",
      minFreeBytes: 10_737_418_240,
      readOnlySnapshots: true,
      retentionCount: 48,
    },
    subvolumes: [
      {
        id: "system-state",
        path: "/data/system-state",
        quotaGiB: 16,
        role: "system-state",
      },
      {
        id: "user-data",
        path: "/data/user-data",
        quotaGiB: 512,
        role: "user-data",
      },
      {
        appId: "local-search",
        id: "app-state.local-search",
        path: "/data/app-state/local-search",
        quotaGiB: 64,
        role: "app-state",
      },
      {
        id: "snapshots",
        path: "/data/snapshots",
        quotaGiB: 256,
        role: "snapshots",
      },
      {
        id: "local-backup-cache",
        path: "/data/local-backup-cache",
        quotaGiB: 256,
        role: "local-backup-cache",
      },
    ],
    version: 1,
  };
}
