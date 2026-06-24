import assert from "node:assert/strict";
import { test } from "node:test";

import { validateStorageHealthState } from "../src/storage-health-model.ts";
import type {
  StorageHealthState,
  StorageHealthStateValidationResult,
  ValidationError,
} from "../src/storage-health-model.ts";

test("a valid storage health state validates", () => {
  const state = validState();
  const result = validateStorageHealthState(state);

  if (!result.ok) {
    assert.fail(`expected storage health state to validate: ${JSON.stringify(result.errors)}`);
  }

  assert.deepEqual(result.state, {
    hardwareInventory: state.hardwareInventory,
    storageHealth: state.storageHealth,
  });
  assert.equal(result.value, result.state);
});

test("unknown fields and wrong types are rejected", () => {
  assert.deepEqual(
    rejectedPaths(
      validateStorageHealthState({
        ...validState(),
        storageHealth: [
          {
            ...validMount(),
            mystery: true,
          },
        ],
      }),
    ),
    ["storageHealth/0/mystery"],
  );

  assert.deepEqual(
    rejectedPaths(
      validateStorageHealthState({
        ...validState(),
        hardwareInventory: {
          ...validState().hardwareInventory,
          cpuCores: "8",
        },
      }),
    ),
    ["hardwareInventory/cpuCores"],
  );
});

test("numeric bounds and impossible storage usage are rejected", () => {
  assert.deepEqual(
    rejectedPaths(
      validateStorageHealthState({
        ...validState(),
        storageHealth: [
          {
            ...validMount(),
            availableBytes: 0,
            usedBytes: 200,
            totalBytes: 100,
          },
        ],
      }),
    ),
    ["storageHealth/0/usedBytes"],
  );

  assert.deepEqual(
    rejectedPaths(
      validateStorageHealthState({
        ...validState(),
        storageHealth: [
          {
            ...validMount(),
            usedPercent: -1,
          },
        ],
      }),
    ),
    ["storageHealth/0/usedPercent"],
  );

  assert.deepEqual(
    rejectedPaths(
      validateStorageHealthState({
        ...validState(),
        hardwareInventory: {
          ...validState().hardwareInventory,
          memTotalBytes: Number.MAX_SAFE_INTEGER + 1,
        },
      }),
    ),
    ["hardwareInventory/memTotalBytes"],
  );
});

test("status is a closed set", () => {
  assert.deepEqual(
    rejectedPaths(
      validateStorageHealthState({
        ...validState(),
        storageHealth: [
          {
            ...validMount(),
            status: "healthy",
          },
        ],
      }),
    ),
    ["storageHealth/0/status"],
  );
});

test("inline key material is rejected from modeled strings", () => {
  assert.deepEqual(
    rejectedPaths(
      validateStorageHealthState({
        ...validState(),
        hardwareInventory: {
          ...validState().hardwareInventory,
          cpuModel: "password: correct-horse-battery-staple",
        },
      }),
    ),
    ["hardwareInventory/cpuModel"],
  );
});

test("hostile input fails closed without throwing", () => {
  const cyclic: Record<string, unknown> = {
    hardwareInventory: validState().hardwareInventory,
  };
  cyclic.storageHealth = cyclic;

  const accessor: Record<string, unknown> = {};
  let getterReads = 0;
  Object.defineProperty(accessor, "storageHealth", {
    enumerable: true,
    get() {
      getterReads += 1;
      throw new Error("getter should not be read");
    },
  });

  const protoPollution = mutableState();
  Object.defineProperty(protoPollution, "__proto__", {
    enumerable: true,
    value: {},
  });

  const methodShadowed = mutableState();
  const shadowedStorage = [...methodShadowed.storageHealth];
  Object.defineProperty(shadowedStorage, "map", {
    enumerable: true,
    value() {
      return [];
    },
  });
  methodShadowed.storageHealth = shadowedStorage;

  const hostileIterator = mutableState();
  const iteratorStorage = [...hostileIterator.storageHealth];
  let iteratorReads = 0;
  Object.defineProperty(iteratorStorage, Symbol.iterator, {
    enumerable: true,
    get() {
      iteratorReads += 1;
      throw new Error("iterator should not be read");
    },
  });
  hostileIterator.storageHealth = iteratorStorage;

  const inputs: readonly unknown[] = [
    null,
    "storage-health",
    [],
    cyclic,
    accessor,
    protoPollution,
    new Date(),
    new Map(),
    new Proxy({}, {}),
    methodShadowed,
    hostileIterator,
    {
      storageHealth: [],
    },
  ];

  for (let index = 0; index < inputs.length; index += 1) {
    assertRejected(inputs[index]);
  }

  assert.equal(getterReads, 0);
  assert.equal(iteratorReads, 0);
});

function validState(): StorageHealthState & {
  readonly capabilities: Record<string, never>;
  readonly capsuleWorkloads: readonly never[];
} {
  return {
    capabilities: {},
    capsuleWorkloads: [],
    hardwareInventory: {
      arch: "x86_64",
      cpuCores: 8,
      cpuModel: "fixture cpu",
      disks: [
        {
          name: "nvme0n1",
          nvme: true,
          rotational: false,
          sizeBytes: 4294967296,
        },
      ],
      memTotalBytes: 34359738368,
    },
    storageHealth: [
      {
        availableBytes: 2662400,
        device: "/dev/nvme0n1p2",
        fsType: "ext4",
        mountPoint: "/",
        nvme: true,
        readOnly: false,
        rotational: false,
        status: "ok",
        totalBytes: 4096000,
        usedBytes: 1228800,
        usedPercent: 30,
      },
    ],
  };
}

function mutableState(): MutableStorageHealthState {
  const state = validState();

  return {
    capabilities: {},
    capsuleWorkloads: [],
    hardwareInventory: {
      arch: state.hardwareInventory.arch,
      cpuCores: state.hardwareInventory.cpuCores,
      cpuModel: state.hardwareInventory.cpuModel,
      disks: state.hardwareInventory.disks.map((disk) => ({
        name: disk.name,
        nvme: disk.nvme,
        rotational: disk.rotational,
        sizeBytes: disk.sizeBytes,
      })),
      memTotalBytes: state.hardwareInventory.memTotalBytes,
    },
    storageHealth: state.storageHealth.map((mount) => ({
      availableBytes: mount.availableBytes,
      device: mount.device,
      fsType: mount.fsType,
      mountPoint: mount.mountPoint,
      nvme: mount.nvme,
      readOnly: mount.readOnly,
      rotational: mount.rotational,
      status: mount.status,
      totalBytes: mount.totalBytes,
      usedBytes: mount.usedBytes,
      usedPercent: mount.usedPercent,
    })),
  };
}

function validMount(): StorageHealthState["storageHealth"][number] {
  const mount = validState().storageHealth[0];

  if (mount === undefined) {
    assert.fail("expected storage health fixture");
  }

  return mount;
}

function rejectedPaths(result: StorageHealthStateValidationResult): readonly string[] {
  if (result.ok) {
    assert.fail(`expected validation to fail: ${JSON.stringify(result.value)}`);
  }

  return result.errors.map((error) => error.path).sort();
}

function assertRejected(value: unknown): void {
  let errors: readonly ValidationError[] | undefined;

  assert.doesNotThrow(() => {
    const result = validateStorageHealthState(value);

    if (result.ok) {
      assert.fail(`expected validation to fail: ${JSON.stringify(result.value)}`);
    }

    errors = result.errors;
  });

  assert.notEqual(errors, undefined);
}

interface MutableStorageHealthState extends Record<string, unknown> {
  capabilities: Record<string, never>;
  capsuleWorkloads: never[];
  hardwareInventory: {
    arch: string;
    cpuCores: number | string;
    cpuModel: string;
    disks: Array<{
      name: string;
      sizeBytes: number;
      rotational: boolean;
      nvme: boolean;
    }>;
    memTotalBytes: number;
  };
  storageHealth: Array<{
    device: string;
    mountPoint: string;
    fsType: string;
    totalBytes: number;
    usedBytes: number;
    availableBytes: number;
    usedPercent: number;
    rotational: boolean;
    nvme: boolean;
    readOnly: boolean;
    status: string;
  }>;
}
