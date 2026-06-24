import assert from "node:assert/strict";
import { test } from "node:test";

import {
  summarizeDashboard,
  summarizeProtection,
} from "./protection-dashboard-model.ts";
import type {
  ProtectionSummary,
  ProtectionSummaryResult,
} from "./protection-dashboard-model.ts";

test("snapshots distinguish active, configured-inactive, and absent from declared storage layout", () => {
  assert.equal(
    mustProtection({
      storageLayout: storageLayout({
        cadence: "daily",
        retentionCount: 7,
        snapshotsArea: true,
      }),
    }).snapshots.status,
    "active",
  );

  assert.equal(
    mustProtection({
      storageLayout: storageLayout({
        cadence: "disabled",
        retentionCount: 0,
        snapshotsArea: true,
      }),
    }).snapshots.status,
    "configured-inactive",
  );

  const absent = mustProtection({
    measuredSnapshotCount: 99,
  });
  assert.equal(absent.snapshots.status, "absent");
  assert.equal(absent.snapshots.evidence.measuredSnapshotCount, 99);

  assert.equal(
    mustProtection({
      storageLayout: storageLayout({
        cadence: "daily",
        retentionCount: 7,
        snapshotsArea: false,
      }),
    }).snapshots.status,
    "absent",
  );

  const currentReadShape = mustProtection({
    storageLayout: storageLayoutReadState({
      snapshotsArea: true,
    }),
  });
  assert.equal(currentReadShape.snapshots.status, "configured-inactive");
  assert.deepEqual(currentReadShape.snapshots.evidence, {
    snapshotAreaPresent: true,
  });

  assert.equal(
    mustProtection({
      storageLayout: storageLayoutReadState({
        snapshotsArea: false,
      }),
    }).snapshots.status,
    "absent",
  );
});

test("mirror is absent for a single data volume and active only with explicit mirror device evidence", () => {
  assert.equal(
    mustProtection({
      storageLayout: storageLayout({
        cadence: "daily",
        retentionCount: 7,
        snapshotsArea: true,
      }),
    }).mirror.status,
    "absent",
  );

  assert.equal(
    mustProtection({
      mirrorDevices: 2,
      storageLayout: storageLayout({
        cadence: "daily",
        retentionCount: 7,
        snapshotsArea: true,
      }),
    }).mirror.status,
    "active",
  );

  assertRejected(summarizeProtection({ mirrorDevices: "2" }), ["mirrorDevices"]);
});

test("local backup distinguishes verified, configured, and absent without exposing refs", () => {
  const verified = mustProtection({
    backupArchive: verifiedArchive(),
    backupPolicy: backupPolicy({
      deviceRef: "device:usb-backup",
      kind: "attached-disk",
    }),
  });
  assert.equal(verified.localBackup.status, "verified");
  assert.deepEqual(verified.localBackup.evidence.targetKinds, ["attached-disk"]);
  assert.equal(JSON.stringify(verified).includes("device:usb-backup"), false);

  assert.equal(
    mustProtection({
      backupArchive: { last: { ...verifiedArchive().last, verified: false } },
      backupPolicy: backupPolicy({
        deviceRef: "device:usb-backup",
        kind: "attached-disk",
      }),
    }).localBackup.status,
    "configured",
  );

  assert.equal(
    mustProtection({
      backupPolicy: backupPolicy({
        bucketRef: "bucket:vita-archive",
        credentialRef: "credential:s3-writer",
        kind: "remote-object",
      }),
    }).localBackup.status,
    "absent",
  );

  const actualReadPolicy = mustProtection({
    backupArchive: verifiedArchive(),
    backupPolicy: backupPolicyReadState(),
  });
  assert.equal(actualReadPolicy.localBackup.status, "verified");
  assert.deepEqual(actualReadPolicy.localBackup.evidence.targetKinds, ["local-snapshot"]);
  assert.equal(JSON.stringify(actualReadPolicy).includes("target:system-state"), false);
});

test("off-site backup is independent from local backup and is never verified", () => {
  const offSite = mustProtection({
    backupArchive: verifiedArchive(),
    backupPolicy: backupPolicy({
      bucketRef: "bucket:vita-archive",
      credentialRef: "credential:s3-writer",
      kind: "remote-object",
    }),
  });
  assert.equal(offSite.offSite.status, "configured");
  assert.equal(String(offSite.offSite.status), "configured");
  assert.equal(offSite.localBackup.status, "absent");

  const localOnly = mustProtection({
    backupPolicy: backupPolicy({
      kind: "local-snapshot",
    }),
  });
  assert.equal(localOnly.localBackup.status, "configured");
  assert.equal(localOnly.offSite.status, "absent");
});

test("overall counts non-absent tiers and a bare node has no protected tiers", () => {
  const bare = mustProtection({});
  assert.equal(bare.snapshots.status, "absent");
  assert.equal(bare.mirror.status, "absent");
  assert.equal(bare.localBackup.status, "absent");
  assert.equal(bare.offSite.status, "absent");
  assert.equal(bare.overall.protectedTiers, 0);

  const mixed = mustProtection({
    backupPolicy: backupPolicy({
      deviceRef: "device:usb-backup",
      kind: "attached-disk",
    }),
    mirrorDevices: 2,
    storageLayout: storageLayout({
      cadence: "disabled",
      retentionCount: 0,
      snapshotsArea: true,
    }),
  });
  assert.equal(mixed.overall.protectedTiers, 3);

  const absentReadStates = mustProtection({
    backupPolicy: {
      exists: false,
      policy: {},
      raw: null,
    },
    storageLayout: {
      exists: false,
      layout: {},
      raw: null,
    },
  });
  assert.equal(absentReadStates.localBackup.status, "absent");
  assert.equal(absentReadStates.snapshots.status, "absent");
});

test("protection model rejects malformed, cyclic, proxy, unknown, wrong-type, and unknown-enum input", () => {
  assertRejected(summarizeProtection("not an object"), [""]);

  const getterObject: Record<string, unknown> = {};
  let getterReads = 0;
  Object.defineProperty(getterObject, "storageLayout", {
    enumerable: true,
    get() {
      getterReads += 1;
      throw new Error("getter should not be invoked");
    },
  });
  assertRejected(summarizeProtection(getterObject), [""]);
  assert.equal(getterReads, 0);

  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;
  assertRejected(summarizeProtection(cyclic), [""]);

  const proxy = new Proxy({}, {
    get() {
      throw new Error("proxy getter must not run");
    },
  });
  assertRejected(summarizeProtection(proxy), [""]);

  assertRejected(
    summarizeProtection({
      extra: true,
    }),
    ["extra"],
  );

  assertRejected(
    summarizeProtection({
      storageLayout: storageLayout({
        cadence: "daily",
        retentionCount: 7,
        snapshotsArea: true,
      }),
      mirrorDevices: 1.5,
    }),
    ["mirrorDevices"],
  );

  assertRejected(
    summarizeProtection({
      storageLayout: storageLayout({
        cadence: "yearly",
        retentionCount: 7,
        snapshotsArea: true,
      }),
    }),
    ["storageLayout/snapshotPolicy/cadence"],
  );

  assertRejectedIncludes(
    summarizeProtection({
      storageLayout: storageLayoutWithOnlySnapshotsArea(),
    }),
    "storageLayout/subvolumes",
  );
});

test("missing capability state is absent, output is frozen, and repeated inputs are deterministic", () => {
  const input = {
    backupPolicy: backupPolicy({
      deviceRef: "device:usb-backup",
      kind: "attached-disk",
    }),
    storageLayout: storageLayout({
      cadence: "daily",
      retentionCount: 7,
      snapshotsArea: true,
    }),
  };
  const first = summarizeDashboard(input);
  const second = summarizeDashboard(input);

  if (!first.ok || !second.ok) {
    assert.fail("expected dashboard summary to pass");
  }

  assert.equal(JSON.stringify(first.value), JSON.stringify(second.value));
  assert.equal(Object.isFrozen(first.value), true);
  assert.equal(Object.isFrozen(first.value.protection.snapshots), true);
  assert.equal(first.value.exposure.host.wideOpen, false);
});

function mustProtection(input: unknown): ProtectionSummary {
  const result = summarizeProtection(input);

  if (!result.ok) {
    assert.fail(`expected protection summary to pass: ${JSON.stringify(result.errors)}`);
  }

  return result.protection;
}

function assertRejected(result: ProtectionSummaryResult, paths: readonly string[]): void {
  assert.doesNotThrow(() => {
    if (result.ok) {
      assert.fail(`expected rejection, got ${JSON.stringify(result.value)}`);
    }
  });

  if (result.ok) {
    assert.fail("expected rejection");
  }

  assert.deepEqual(result.errors.map((error) => error.path).sort(), [...paths].sort());
}

function assertRejectedIncludes(result: ProtectionSummaryResult, path: string): void {
  assert.doesNotThrow(() => {
    if (result.ok) {
      assert.fail(`expected rejection, got ${JSON.stringify(result.value)}`);
    }
  });

  if (result.ok) {
    assert.fail("expected rejection");
  }

  assert.equal(result.errors.some((error) => error.path === path), true);
}

function storageLayout(options: {
  readonly cadence: string;
  readonly retentionCount: number;
  readonly snapshotsArea: boolean;
}): unknown {
  const subvolumes = [
    {
      id: "system",
      path: "/vita/system",
      role: "system-state",
    },
    {
      id: "data",
      path: "/vita/data",
      role: "user-data",
    },
    {
      appId: "app.notes",
      id: "app-notes",
      path: "/vita/apps/notes",
      role: "app-state",
    },
    {
      id: "backup-cache",
      path: "/vita/backup-cache",
      role: "local-backup-cache",
    },
  ];

  if (options.snapshotsArea) {
    subvolumes.push({
      id: "snapshots",
      path: "/vita/snapshots",
      role: "snapshots",
    });
  }

  return {
    dataVolume: {
      encryption: "luks2",
      filesystem: "btrfs",
      recoveryKeyRequired: true,
      tpmUnlock: true,
    },
    diskHealth: {
      checksumErrors: 0,
      freeBytes: 500_000,
      smart: {
        reallocatedSectors: 0,
        status: "passed",
      },
      status: "healthy",
      totalBytes: 1_000_000,
      usedBytes: 400_000,
    },
    snapshotPolicy: {
      cadence: options.cadence,
      readOnlySnapshots: true,
      retentionCount: options.retentionCount,
    },
    subvolumes,
    version: 1,
  };
}

function storageLayoutReadState(options: {
  readonly snapshotsArea: boolean;
}): unknown {
  const subvolumes = [
    {
      path: "/data/system-state",
      role: "system-state",
    },
    {
      path: "/data/user-data",
      role: "user-data",
    },
    {
      appId: "local-search",
      path: "/data/app-state/local-search",
      role: "app-state",
    },
    {
      path: "/data/local-backup-cache",
      role: "local-backup-cache",
    },
  ];

  if (options.snapshotsArea) {
    subvolumes.push({
      path: "/data/snapshots",
      role: "snapshots",
    });
  }

  return {
    exists: true,
    layout: {
      subvolumes,
    },
    raw: "eyJzdWJ2b2x1bWVzIjpbXX0K",
  };
}

function storageLayoutWithOnlySnapshotsArea(): unknown {
  return {
    dataVolume: {
      encryption: "luks2",
      filesystem: "btrfs",
      recoveryKeyRequired: true,
      tpmUnlock: true,
    },
    diskHealth: {
      checksumErrors: 0,
      freeBytes: 500_000,
      smart: {
        reallocatedSectors: 0,
        status: "passed",
      },
      status: "healthy",
      totalBytes: 1_000_000,
      usedBytes: 400_000,
    },
    snapshotPolicy: {
      cadence: "daily",
      readOnlySnapshots: true,
      retentionCount: 7,
    },
    subvolumes: [
      {
        id: "snapshots",
        path: "/vita/snapshots",
        role: "snapshots",
      },
    ],
    version: 1,
  };
}

function backupPolicy(target: Readonly<Record<string, unknown>>): unknown {
  return {
    createdAt: "2026-06-20T10:15:30Z",
    id: "backup:daily-main",
    retentionDays: 30,
    schedule: {
      cadence: "daily",
      interval: 1,
      startAt: "2026-06-20T11:00:00Z",
    },
    target,
  };
}

function backupPolicyReadState(): unknown {
  return {
    exists: true,
    policy: {
      recoveryKeyRef: {
        handle: "rk_handle_owner_primary",
        id: "rk:owner-primary",
        keyStoreRef: "keystore:local-tpm",
      },
      retention: {
        count: 7,
        maxAgeDays: 30,
      },
      schedule: {
        cron: "0 2 * * *",
      },
      targets: [
        {
          id: "target:system-state",
        },
        {
          id: "target:user-data",
        },
      ],
    },
    raw: "eyJzY2hlZHVsZSI6eyJjcm9uIjoiMCAyICogKiAqIn19Cg==",
  };
}

function verifiedArchive(): {
  readonly last: {
    readonly op: "restore";
    readonly backupId: "sha256:abc";
    readonly files: 12;
    readonly created: true;
    readonly verified: true;
    readonly restored: true;
    readonly status: "OK";
  };
} {
  return {
    last: {
      backupId: "sha256:abc",
      created: true,
      files: 12,
      op: "restore",
      restored: true,
      status: "OK",
      verified: true,
    },
  };
}
