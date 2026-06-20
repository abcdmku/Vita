import assert from "node:assert/strict";
import { test } from "node:test";

import { validateStorageLayout } from "../src/storage-model.ts";
import type { Result, StorageLayout } from "../src/storage-model.ts";

test("a valid Btrfs storage layout validates", () => {
  const layout = validLayout();
  const result = validateStorageLayout(layout);

  if (!result.ok) {
    assert.fail(`expected storage layout to validate: ${JSON.stringify(result.errors)}`);
  }

  assert.deepEqual(result.layout, layout);
});

test("missing and wrong-type fields are rejected with precise paths", () => {
  const layout = mutableInput();
  const userData = layout.subvolumes[1];

  if (userData === undefined) {
    assert.fail("expected user-data subvolume fixture");
  }

  delete userData["path"];
  layout.diskHealth["totalBytes"] = "1TiB";

  const paths = rejectedPaths(validateStorageLayout(layout));

  assert.deepEqual(
    ["diskHealth/totalBytes", "subvolumes/1/path"].every((path) => paths.includes(path)),
    true,
  );
});

test("hostile untrusted inputs reject through safe normalization", () => {
  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;

  const accessor: Record<string, unknown> = {};
  let getterReads = 0;
  Object.defineProperty(accessor, "version", {
    enumerable: true,
    get() {
      getterReads += 1;
      throw new Error("getter read");
    },
  });

  const methodShadowed = mutableInput();
  const shadowedSubvolumes = [...methodShadowed.subvolumes];
  Object.defineProperty(shadowedSubvolumes, "some", {
    enumerable: true,
    value() {
      return false;
    },
  });
  methodShadowed.subvolumes = shadowedSubvolumes;

  const hostileIterator = mutableInput();
  const iteratorSubvolumes = [...hostileIterator.subvolumes];
  let iteratorReads = 0;
  Object.defineProperty(iteratorSubvolumes, Symbol.iterator, {
    enumerable: true,
    get() {
      iteratorReads += 1;
      throw new Error("iterator read");
    },
  });
  hostileIterator.subvolumes = iteratorSubvolumes;

  const inputs: readonly unknown[] = [
    null,
    "garbage",
    cyclic,
    accessor,
    new Date(),
    new Map(),
    new Proxy({}, {}),
    methodShadowed,
    hostileIterator,
  ];

  for (let index = 0; index < inputs.length; index += 1) {
    assertRejected(inputs[index]);
  }

  assert.equal(getterReads, 0);
  assert.equal(iteratorReads, 0);
});

test("snapshot policy and disk health bounds are enforced", () => {
  const layout = mutableInput();
  layout.snapshotPolicy["retentionCount"] = 0;
  layout.snapshotPolicy["readOnlySnapshots"] = false;
  layout.diskHealth["usedBytes"] = 1_099_511_627_777;
  layout.diskHealth.smart["temperatureC"] = 200;

  const paths = rejectedPaths(validateStorageLayout(layout));

  assert.deepEqual(
    [
      "diskHealth/smart/temperatureC",
      "diskHealth/usedBytes",
      "snapshotPolicy/readOnlySnapshots",
      "snapshotPolicy/retentionCount",
    ].every((path) => paths.includes(path)),
    true,
  );
});

test("partial layouts missing a required storage area are rejected", () => {
  const layout = mutableInput();
  layout.subvolumes = layout.subvolumes.filter((subvolume) => subvolume["role"] !== "snapshots");

  const result = validateStorageLayout(layout);

  if (result.ok) {
    assert.fail("expected missing snapshots area to reject");
  }

  assert.equal(result.errors.some((error) => error.path === "subvolumes"), true);
  assert.equal(
    result.errors.some((error) => error.message.includes("Missing required snapshots storage area.")),
    true,
  );
});

test("app-state subvolumes must carry appId", () => {
  const layout = mutableInput();
  const appState = layout.subvolumes[2];

  if (appState === undefined) {
    assert.fail("expected app-state subvolume fixture");
  }

  delete appState["appId"];

  const paths = rejectedPaths(validateStorageLayout(layout));

  assert.equal(paths.includes("subvolumes/2/appId"), true);
});

test("non-app subvolumes must not carry appId", () => {
  const layout = mutableInput();
  const systemState = layout.subvolumes[0];

  if (systemState === undefined) {
    assert.fail("expected system-state subvolume fixture");
  }

  systemState["appId"] = "platform";

  const paths = rejectedPaths(validateStorageLayout(layout));

  assert.equal(paths.includes("subvolumes/0/appId"), true);
});

test("subvolume paths must be canonical absolute paths", () => {
  const layout = mutableInput();
  const userData = layout.subvolumes[1];

  if (userData === undefined) {
    assert.fail("expected user-data subvolume fixture");
  }

  userData["path"] = "/data/../user-data";

  const paths = rejectedPaths(validateStorageLayout(layout));

  assert.equal(paths.includes("subvolumes/1/path"), true);
});

function validLayout(): StorageLayout {
  return {
    version: 1,
    dataVolume: {
      encryption: "luks2",
      filesystem: "btrfs",
      tpmUnlock: true,
      recoveryKeyRequired: true,
    },
    subvolumes: [
      {
        id: "system-state",
        role: "system-state",
        path: "/data/system-state",
        quotaGiB: 16,
      },
      {
        id: "user-data",
        role: "user-data",
        path: "/data/user-data",
        quotaGiB: 512,
      },
      {
        id: "app-state.local-search",
        role: "app-state",
        appId: "local-search",
        path: "/data/app-state/local-search",
        quotaGiB: 64,
      },
      {
        id: "snapshots",
        role: "snapshots",
        path: "/data/snapshots",
        quotaGiB: 256,
      },
      {
        id: "local-backup-cache",
        role: "local-backup-cache",
        path: "/data/local-backup-cache",
        quotaGiB: 256,
      },
    ],
    snapshotPolicy: {
      cadence: "hourly",
      retentionCount: 48,
      readOnlySnapshots: true,
      minFreeBytes: 10_737_418_240,
    },
    diskHealth: {
      status: "healthy",
      totalBytes: 1_099_511_627_776,
      usedBytes: 274_877_906_944,
      freeBytes: 824_633_720_832,
      checksumErrors: 0,
      smart: {
        status: "passed",
        reallocatedSectors: 0,
        temperatureC: 39,
        powerOnHours: 100,
      },
    },
  };
}

function rejectedPaths(result: Result): readonly string[] {
  if (result.ok) {
    assert.fail(`expected validation to fail: ${JSON.stringify(result.layout)}`);
  }

  return result.errors.map((error) => error.path).sort();
}

function assertRejected(value: unknown): void {
  let result: Result | undefined;

  assert.doesNotThrow(() => {
    result = validateStorageLayout(value);
  });
  assert.equal(result?.ok, false);
}

function mutableInput(): MutableLayoutInput {
  return validLayout() as unknown as MutableLayoutInput;
}

interface MutableLayoutInput extends Record<string, unknown> {
  subvolumes: Record<string, unknown>[];
  snapshotPolicy: Record<string, unknown>;
  diskHealth: Record<string, unknown> & {
    smart: Record<string, unknown>;
  };
}
