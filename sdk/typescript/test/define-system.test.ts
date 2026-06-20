import assert from "node:assert/strict";
import { test } from "node:test";

import exampleSystem, { exampleState } from "../../examples/system.ts";
import { bestAvailable } from "../src/capabilities.ts";
import { app, backup, defineSystem } from "../src/define-system.ts";
import { normalize, planHash } from "../src/plan.ts";
import { validatePlan } from "../src/validate.ts";
import type {
  DataAccessGrant,
  SystemSnapshot,
  SystemSnapshotInput,
} from "../src/define-system.ts";
import type { DesiredState } from "../src/plan.ts";

const fixedSnapshot: SystemSnapshotInput = {
  device: {
    memoryGB: 16,
    architecture: "x86_64",
    accelerators: [
      {
        kind: "intel.npu",
        generation: "core-ultra",
      },
    ],
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
      readOnly(): DataAccessGrant {
        return {
          type: "data-access",
          scope: "files",
          mode: "read-only",
        };
      },
    },
  },
};

test("defineSystem evaluates a fixed snapshot into a normalized plan", () => {
  const system = defineSystem(({ device, data }) => ({
    apps: [
      app("atproto-pds", {
        publicAccess: true,
        memory: device.memoryGB >= 16 ? "2GiB" : "1GiB",
      }),
      app("local-search", {
        accelerator: device.ai.bestAvailable({
          prefer: ["npu", "gpu", "cpu"],
          requireFallback: "cpu",
        }),
        dataAccess: [data.files.readOnly()],
      }),
    ],
    backups: [backup.usb({ schedule: "daily" })],
  }));

  const plan = system(fixedSnapshot);

  assert.deepEqual(Object.keys(plan), ["apps", "backups", "identity", "storage", "version"]);
  assert.equal(plan.version, 1);
  assert.equal(plan.apps.length, 2);
  assert.equal(plan.backups.length, 1);
});

test("defineSystem produces byte-identical normalized plans for the same snapshot", () => {
  const system = defineSystem(({ device }) => ({
    apps: [
      app("local-search", {
        memory: device.memoryGB >= 16 ? "2GiB" : "1GiB",
      }),
    ],
    backups: [backup.usb({ schedule: "daily" })],
  }));

  const first = system(fixedSnapshot);
  const second = system.evaluate(fixedSnapshot);

  assert.equal(JSON.stringify(first), JSON.stringify(second));
  assert.equal(planHash(first), planHash(second));
});

test("the spec-style example declares the expected apps and backup", () => {
  const plan = exampleSystem(fixedSnapshot);

  assert.deepEqual(
    plan.apps.map((declaredApp) => declaredApp.id).sort(),
    ["atproto-pds", "local-search"],
  );
  assert.equal(
    plan.apps.find((declaredApp) => declaredApp.id === "atproto-pds")?.config?.memory,
    "2GiB",
  );
  assert.deepEqual(plan.backups, [
    {
      id: "usb",
      schedule: "daily",
      target: "usb",
    },
  ]);
});

test("the spec-style example validates against its device snapshot", () => {
  const authorSnapshot: SystemSnapshot = {
    ...fixedSnapshot,
    device: {
      ...fixedSnapshot.device,
      ai: {
        bestAvailable: (request) => bestAvailable(fixedSnapshot.device, request),
      },
    },
  };
  const result = validatePlan(exampleState(authorSnapshot), fixedSnapshot.device);

  assert.equal(result.ok, true);

  if (!result.ok) {
    assert.fail(`expected example validation to pass: ${JSON.stringify(result.errors)}`);
  }
});

test("the snapshot passed to the author function is deeply immutable", () => {
  const snapshotWithNestedArray: SystemSnapshotInput = {
    device: {
      ...fixedSnapshot.device,
      accelerators: [
        {
          kind: "amd.rocm",
          memoryGB: 16,
        },
      ],
    },
    data: fixedSnapshot.data,
  };
  const system = defineSystem(({ device }) => {
    const accelerators = device.accelerators;

    assert.equal(Object.isFrozen(device), true);
    assert.equal(Object.isFrozen(device.ai), true);
    assert.equal(Object.isFrozen(accelerators), true);
    assert.equal(Object.isFrozen(accelerators[0]), true);
    assert.throws(() => {
      (device as { memoryGB: number }).memoryGB = 8;
    }, TypeError);
    assert.throws(() => {
      (accelerators as unknown[]).push({ kind: "cpu", architecture: "x86_64" });
    }, TypeError);

    return { apps: [app("local-search")] };
  });

  system(snapshotWithNestedArray);
});

test("app and backup builders return desired-state fragments accepted by normalize", () => {
  const desired: DesiredState = {
    apps: [
      app("atproto-pds", {
        publicAccess: true,
        memory: "2GiB",
      }),
    ],
    backups: [backup.usb({ schedule: "daily", retentionDays: 30 })],
  };

  const plan = normalize(desired);

  assert.equal(plan.apps[0]?.id, "atproto-pds");
  assert.equal(plan.apps[0]?.config?.publicAccess, true);
  assert.equal(plan.backups[0]?.retentionDays, 30);
});
