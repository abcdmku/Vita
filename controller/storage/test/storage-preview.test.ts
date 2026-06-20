import assert from "node:assert/strict";
import { test } from "node:test";

import { previewStorageChange } from "../src/storage-preview.ts";
import type {
  StorageChangePreview,
  StorageChangeRejectionCode,
} from "../src/storage-preview.ts";
import type { StorageLayout } from "../../../sdk/typescript/src/storage-model.ts";

test("identical storage layouts produce an empty valid diff", () => {
  const layout = validLayout();
  const preview = previewStorageChange(layout, layout);

  if (!preview.valid) {
    assert.fail(`expected valid preview: ${JSON.stringify(preview.rejections)}`);
  }

  assert.equal(preview.valid, true);
  assert.deepEqual(preview.diff, {
    added: {},
    modified: {},
    removed: {},
  });
  assert.deepEqual(preview.rejections, []);
});

test("added, removed, and modified subvolumes are classified by role/path key", () => {
  const current = validLayout();
  current.subvolumes[current.subvolumes.length] = {
    appId: "legacy-dashboard",
    id: "app-state.legacy-dashboard",
    path: "/data/app-state/legacy-dashboard",
    quotaGiB: 24,
    role: "app-state",
  };

  const desired = validLayout({
    appQuotaGiB: 96,
    appPath: "/data/app-state/local-search-v2",
  });

  desired.subvolumes[desired.subvolumes.length] = {
    appId: "atproto-pds",
    id: "app-state.atproto-pds",
    path: "/data/app-state/atproto-pds",
    quotaGiB: 32,
    role: "app-state",
  };

  const preview = previewStorageChange(current, desired);

  if (!preview.valid) {
    assert.fail(`expected valid preview: ${JSON.stringify(preview.rejections)}`);
  }

  assert.equal(preview.valid, true);
  assert.deepEqual(Object.keys(preview.diff.added), ["app-state:/data/app-state/atproto-pds"]);
  assert.deepEqual(Object.keys(preview.diff.removed), ["app-state:/data/app-state/legacy-dashboard"]);
  assert.deepEqual(Object.keys(preview.diff.modified), ["app-state:/data/app-state/local-search"]);

  assert.deepEqual(preview.diff.added["app-state:/data/app-state/atproto-pds"], {
    after: {
      appId: "atproto-pds",
      id: "app-state.atproto-pds",
      path: "/data/app-state/atproto-pds",
      quotaGiB: 32,
      role: "app-state",
    },
    key: "app-state:/data/app-state/atproto-pds",
    kind: "added",
  });
  assert.deepEqual(preview.diff.removed["app-state:/data/app-state/legacy-dashboard"], {
    before: {
      appId: "legacy-dashboard",
      id: "app-state.legacy-dashboard",
      path: "/data/app-state/legacy-dashboard",
      quotaGiB: 24,
      role: "app-state",
    },
    key: "app-state:/data/app-state/legacy-dashboard",
    kind: "removed",
  });
  assert.deepEqual(preview.diff.modified["app-state:/data/app-state/local-search"], {
    after: {
      appId: "local-search",
      id: "app-state.local-search",
      path: "/data/app-state/local-search-v2",
      quotaGiB: 96,
      role: "app-state",
    },
    afterKey: "app-state:/data/app-state/local-search-v2",
    before: {
      appId: "local-search",
      id: "app-state.local-search",
      path: "/data/app-state/local-search",
      quotaGiB: 64,
      role: "app-state",
    },
    beforeKey: "app-state:/data/app-state/local-search",
    changes: [
      {
        after: "/data/app-state/local-search-v2",
        before: "/data/app-state/local-search",
        field: "path",
      },
      {
        after: 96,
        before: 64,
        field: "quotaGiB",
      },
    ],
    key: "app-state:/data/app-state/local-search",
    kind: "modified",
  });
  assert.deepEqual(preview.rejections, []);
});

test("invalid current or desired layouts return typed rejections without a diff", () => {
  const invalidCurrent = validLayout() as Record<string, unknown>;
  delete invalidCurrent["diskHealth"];

  const invalidDesired = validLayout() as unknown as MutableLayoutInput;
  invalidDesired.subvolumes = invalidDesired.subvolumes.filter(
    (subvolume) => subvolume["role"] !== "snapshots",
  );

  const currentPreview = previewStorageChange(invalidCurrent, validLayout());
  const desiredPreview = previewStorageChange(validLayout(), invalidDesired);

  assert.equal(currentPreview.valid, false);
  assert.equal(currentPreview.diff, null);
  assert.deepEqual(rejectionCodes(currentPreview), ["INVALID_CURRENT_LAYOUT"]);
  assert.equal(currentPreview.rejections[0]?.source, "current");
  assert.equal(currentPreview.rejections[0]?.path, "diskHealth");

  assert.equal(desiredPreview.valid, false);
  assert.equal(desiredPreview.diff, null);
  assert.deepEqual(rejectionCodes(desiredPreview), ["INVALID_DESIRED_LAYOUT"]);
  assert.equal(desiredPreview.rejections[0]?.source, "desired");
});

test("hostile storage inputs fail closed without throwing", () => {
  const hostileCurrent = {
    dataVolume: {
      encryption: "luks2",
      filesystem: "btrfs",
      recoveryKeyRequired: true,
      tpmUnlock: true,
    },
    diskHealth: validLayout().diskHealth,
    snapshotPolicy: validLayout().snapshotPolicy,
    version: 1,
  };
  Object.defineProperty(hostileCurrent, "subvolumes", {
    enumerable: true,
    get() {
      assert.fail("accessor properties must not be invoked");
    },
  });

  const methodShadowedDesired = validLayout() as unknown as MutableLayoutInput;
  Object.defineProperty(methodShadowedDesired.subvolumes, "some", {
    enumerable: true,
    value() {
      assert.fail("shadowed array methods must not be invoked");
    },
  });

  const cyclic: Record<string, unknown> = {};
  cyclic["self"] = cyclic;

  assert.doesNotThrow(() => previewStorageChange(hostileCurrent, validLayout()));
  assert.doesNotThrow(() => previewStorageChange(validLayout(), methodShadowedDesired));
  assert.doesNotThrow(() => previewStorageChange(cyclic, cyclic));

  const accessorPreview = previewStorageChange(hostileCurrent, validLayout());
  const shadowedPreview = previewStorageChange(validLayout(), methodShadowedDesired);
  const cyclicPreview = previewStorageChange(cyclic, cyclic);

  assert.equal(accessorPreview.valid, false);
  assert.equal(shadowedPreview.valid, false);
  assert.equal(cyclicPreview.valid, false);
  assert.equal(accessorPreview.diff, null);
  assert.equal(shadowedPreview.diff, null);
  assert.equal(cyclicPreview.diff, null);
  assert.deepEqual(rejectionCodes(accessorPreview), ["INVALID_CURRENT_LAYOUT"]);
  assert.deepEqual(rejectionCodes(shadowedPreview), ["INVALID_DESIRED_LAYOUT"]);
  assert.deepEqual(rejectionCodes(cyclicPreview), [
    "INVALID_CURRENT_LAYOUT",
    "INVALID_DESIRED_LAYOUT",
  ]);
});

function validLayout(
  overrides: {
    readonly appPath?: string;
    readonly appQuotaGiB?: number;
  } = {},
): MutableLayoutInput {
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
        path: overrides.appPath ?? "/data/app-state/local-search",
        quotaGiB: overrides.appQuotaGiB ?? 64,
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
  } as unknown as MutableLayoutInput;
}

function rejectionCodes(preview: StorageChangePreview): readonly StorageChangeRejectionCode[] {
  const output: StorageChangeRejectionCode[] = [];

  for (let index = 0; index < preview.rejections.length; index += 1) {
    const rejection = preview.rejections[index];

    if (rejection !== undefined) {
      output[output.length] = rejection.code;
    }
  }

  return output;
}

interface MutableLayoutInput extends Record<string, unknown> {
  subvolumes: Record<string, unknown>[];
  snapshotPolicy: StorageLayout["snapshotPolicy"];
  diskHealth: StorageLayout["diskHealth"];
}
