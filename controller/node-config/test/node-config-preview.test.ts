import assert from "node:assert/strict";
import { test } from "node:test";

import { validateNodeConfig } from "../../../sdk/typescript/src/node-config-model.ts";
import { previewNodeConfigChange } from "../src/node-config-preview.ts";
import type { NodeConfigChangePreview } from "../src/node-config-preview.ts";
import type { BackupPolicy } from "../../../sdk/typescript/src/backup-model.ts";
import type { IdentityConfig } from "../../../sdk/typescript/src/identity-model.ts";
import type {
  InboundRule,
  NetworkConfig,
} from "../../../sdk/typescript/src/network-model.ts";

test("valid node configs produce unified section diffs and security summary", () => {
  const addedRule = { port: 8443, protocol: "tcp", sourceCidr: "10.1.0.0/16" } as const;
  const current = validNodeConfig();
  const desired = validNodeConfig({
    backupRetentionDays: 14,
    identityHandle: "alice-updated.example.com",
    networkAllow: [addedRule],
    storageAppPath: "/data/app-state/local-search-v2",
    storageAppQuotaGiB: 96,
  });

  const preview = assertValid(previewNodeConfigChange(current, desired));

  assert.deepEqual(preview.summary, {
    added: [],
    changed: ["storage", "network", "backup", "identity"],
    removed: [],
    weakensRetention: true,
    wideningInbound: true,
  });

  assert.equal(preview.sections.storage?.kind, "changed");
  assert.deepEqual(Object.keys(preview.sections.storage?.diff.modified ?? {}), [
    "app-state:/data/app-state/local-search",
  ]);
  assert.equal(preview.sections.network?.kind, "changed");
  assert.deepEqual(preview.sections.network?.diff.firewall.added, [addedRule]);
  assert.equal(preview.sections.network?.wideningInbound, true);
  assert.equal(preview.sections.backup?.kind, "changed");
  assert.deepEqual(preview.sections.backup?.diff.retention, {
    count: null,
    maxAgeDays: {
      current: 30,
      desired: 14,
    },
  });
  assert.equal(preview.sections.backup?.weakensRetention, true);
  assert.equal(preview.sections.identity?.diff?.kind, "modified");
});

test("added and removed sections are summarized without synthetic resources", () => {
  const current = validNodeConfig() as MutableNodeConfigInput;
  const desired = validNodeConfig() as MutableNodeConfigInput;
  delete current.storage;
  delete desired.backup;

  const preview = assertValid(previewNodeConfigChange(current, desired));

  assert.deepEqual(preview.summary.added, ["storage"]);
  assert.deepEqual(preview.summary.removed, ["backup"]);
  assert.deepEqual(preview.summary.changed, []);
  assert.equal(preview.summary.weakensRetention, true);

  assert.equal(preview.sections.storage?.kind, "added");
  assert.deepEqual(Object.keys(preview.sections.storage?.diff.removed ?? {}), []);
  assert.deepEqual(Object.keys(preview.sections.storage?.diff.modified ?? {}), []);
  assert.ok(
    Object.hasOwn(
      preview.sections.storage?.diff.added ?? {},
      "system-state:/data/system-state",
    ),
  );

  assert.equal(preview.sections.backup?.kind, "removed");
  assert.deepEqual(preview.sections.backup?.diff.targets.added, []);
  assert.deepEqual(preview.sections.backup?.diff.targets.removed, [validBackupPolicy().target]);
  const removedBackupSchedule = preview.sections.backup?.diff.schedule;
  assert.ok(
    removedBackupSchedule !== undefined &&
      removedBackupSchedule !== null &&
      "kind" in removedBackupSchedule,
  );
  assert.equal(removedBackupSchedule.kind, "removed");
  assert.deepEqual(preview.sections.backup?.diff.retention, {
    before: 30,
    kind: "removed",
  });

  const previewText = JSON.stringify(preview);
  assert.equal(previewText.includes("/absent"), false);
  assert.equal(previewText.includes("\"lo\""), false);
});

test("added network with allow rules surfaces inbound widening", () => {
  const current = validNodeConfig() as MutableNodeConfigInput;
  delete current.network;

  const desired = validNodeConfig() as MutableNodeConfigInput;
  desired.network = validNetworkConfig({
    allow: [{ port: 443, protocol: "tcp", sourceCidr: "10.0.0.0/8" }],
    interfaces: [{ kind: "ethernet", name: "eth0" }],
  });

  const preview = assertValid(previewNodeConfigChange(current, desired));

  assert.deepEqual(preview.summary.added, ["network"]);
  assert.equal(preview.summary.wideningInbound, true);
  assert.equal(preview.sections.network?.kind, "added");
  assert.equal(preview.sections.network?.wideningInbound, true);
  assert.deepEqual(preview.sections.network?.diff.firewall.added, [
    { port: 443, protocol: "tcp", sourceCidr: "10.0.0.0/8" },
  ]);
  assert.deepEqual(preview.sections.network?.diff.interfaces.added, [
    { kind: "ethernet", name: "eth0" },
  ]);
  assert.equal(JSON.stringify(preview.sections.network).includes("\"lo\""), false);
});

test("removed network and removed backup compute boundary flags from the present side", () => {
  const current = validNodeConfig({
    backupRetentionDays: 1,
    networkAllow: [{ port: 443, protocol: "tcp", sourceCidr: "10.0.0.0/8" }],
    networkInterfaces: [{ kind: "ethernet", name: "eth0" }],
  }) as MutableNodeConfigInput;
  const desired = validNodeConfig() as MutableNodeConfigInput;
  delete desired.network;
  delete desired.backup;

  const preview = assertValid(previewNodeConfigChange(current, desired));

  assert.deepEqual(preview.summary.removed, ["network", "backup"]);
  assert.equal(preview.summary.wideningInbound, false);
  assert.equal(preview.summary.weakensRetention, true);
  assert.equal(preview.sections.network?.wideningInbound, false);
  assert.deepEqual(preview.sections.network?.diff.firewall.removed, [
    { port: 443, protocol: "tcp", sourceCidr: "10.0.0.0/8" },
  ]);
  assert.deepEqual(preview.sections.network?.diff.firewall.added, []);
  assert.deepEqual(preview.sections.backup?.diff.retention, {
    before: 1,
    kind: "removed",
  });
  assert.equal(preview.sections.backup?.weakensRetention, true);
});

test("added storage must pass storage preview validation, not only aggregate validation", () => {
  const current = validNodeConfig() as MutableNodeConfigInput;
  delete current.storage;

  const duplicateStorage = validStorageLayout() as MutableStorageLayoutInput;
  duplicateStorage.subvolumes[duplicateStorage.subvolumes.length] = {
    appId: "notes",
    id: "app-state.notes",
    path: "/data/app-state/local-search",
    quotaGiB: 8,
    role: "app-state",
  };

  const desired = validNodeConfig() as MutableNodeConfigInput;
  desired.storage = duplicateStorage;

  assert.equal(validateNodeConfig(desired).ok, true);

  const preview = previewNodeConfigChange(current, desired);

  assert.equal(preview.ok, false);

  if (preview.ok) {
    assert.fail("expected preview rejection");
  }

  assert.ok(
    preview.rejections.some(
      (rejection) =>
        rejection.code === "INVALID_DESIRED_SECTION" &&
        rejection.section === "storage" &&
        rejection.path === "storage/subvolumes/5",
    ),
  );
});

test("invalid current or desired config returns typed rejections without a diff", () => {
  const invalidCurrent = validNodeConfig() as MutableNodeConfigInput;
  const identity = invalidCurrent.identity;

  if (identity === undefined) {
    assert.fail("expected identity section");
  }

  const identityRecord: { handle?: string } = identity;
  delete identityRecord.handle;

  const invalidDesired = validNodeConfig() as MutableNodeConfigInput;
  const network = invalidDesired.network;

  if (network === undefined) {
    assert.fail("expected network section");
  }

  delete network.firewall.allow;

  const currentPreview = previewNodeConfigChange(invalidCurrent, validNodeConfig());
  const desiredPreview = previewNodeConfigChange(validNodeConfig(), invalidDesired);

  assertInvalid(currentPreview, "INVALID_CURRENT_CONFIG");
  assertInvalid(desiredPreview, "INVALID_DESIRED_CONFIG");
});

test("hostile node config input fails closed without invoking accessors", () => {
  let accessorReads = 0;
  let shadowedMethodCalls = 0;
  const hostileCurrent: Record<string, unknown> = {
    backup: validBackupPolicy(),
    identity: validIdentityConfig(),
    network: validNetworkConfig(),
  };

  Object.defineProperty(hostileCurrent, "storage", {
    enumerable: true,
    get() {
      accessorReads += 1;
      return validStorageLayout();
    },
  });

  const cyclic: Record<string, unknown> = {};
  cyclic["self"] = cyclic;

  const methodShadowedDesired = validNodeConfig();
  const desiredNetwork = methodShadowedDesired.network;

  if (desiredNetwork === undefined) {
    assert.fail("expected network section");
  }

  Object.defineProperty(desiredNetwork.interfaces, "forEach", {
    enumerable: true,
    value() {
      shadowedMethodCalls += 1;
      return [];
    },
  });

  assert.doesNotThrow(() => previewNodeConfigChange(hostileCurrent, validNodeConfig()));
  assert.doesNotThrow(() => previewNodeConfigChange(cyclic, validNodeConfig()));
  assert.doesNotThrow(() => previewNodeConfigChange(validNodeConfig(), methodShadowedDesired));

  const accessorPreview = previewNodeConfigChange(hostileCurrent, validNodeConfig());
  const cyclicPreview = previewNodeConfigChange(cyclic, validNodeConfig());
  const shadowedPreview = previewNodeConfigChange(validNodeConfig(), methodShadowedDesired);

  assert.equal(accessorReads, 0);
  assert.equal(shadowedMethodCalls, 0);
  assertInvalid(accessorPreview, "INVALID_CURRENT_CONFIG");
  assertInvalid(cyclicPreview, "INVALID_CURRENT_CONFIG");
  assertInvalid(shadowedPreview, "INVALID_DESIRED_CONFIG");
});

function assertValid(
  preview: NodeConfigChangePreview,
): Extract<NodeConfigChangePreview, { readonly ok: true }> {
  if (!preview.ok) {
    assert.fail(`expected valid preview: ${JSON.stringify(preview.rejections)}`);
  }

  return preview;
}

function assertInvalid(
  preview: NodeConfigChangePreview,
  code: Extract<NodeConfigChangePreview, { readonly ok: false }>["rejections"][number]["code"],
): void {
  assert.equal(preview.ok, false);

  if (preview.ok) {
    assert.fail("expected invalid preview");
  }

  assert.ok(preview.rejections.some((rejection) => rejection.code === code));
}

function validNodeConfig(
  overrides: {
    readonly backupRetentionDays?: number;
    readonly identityHandle?: string;
    readonly networkAllow?: readonly InboundRule[];
    readonly networkInterfaces?: readonly NetworkConfig["interfaces"][number][];
    readonly storageAppPath?: string;
    readonly storageAppQuotaGiB?: number;
  } = {},
): MutableNodeConfigInput {
  return {
    backup: validBackupPolicy({
      retentionDays: overrides.backupRetentionDays ?? 30,
    }),
    identity: validIdentityConfig({
      handle: overrides.identityHandle ?? "alice.example.com",
    }),
    network: validNetworkConfig({
      ...(overrides.networkAllow === undefined ? {} : { allow: overrides.networkAllow }),
      ...(overrides.networkInterfaces === undefined
        ? {}
        : { interfaces: overrides.networkInterfaces }),
    }),
    storage: validStorageLayout({
      ...(overrides.storageAppPath === undefined ? {} : { appPath: overrides.storageAppPath }),
      ...(overrides.storageAppQuotaGiB === undefined
        ? {}
        : { appQuotaGiB: overrides.storageAppQuotaGiB }),
    }),
  };
}

function validStorageLayout(
  overrides: {
    readonly appPath?: string;
    readonly appQuotaGiB?: number;
  } = {},
): MutableStorageLayoutInput {
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
  };
}

function validNetworkConfig(
  overrides: {
    readonly allow?: readonly InboundRule[];
    readonly interfaces?: readonly NetworkConfig["interfaces"][number][];
  } = {},
): MutableNetworkConfigInput {
  return {
    firewall: {
      allow: [...(overrides.allow ?? [])],
    },
    interfaces: [...(overrides.interfaces ?? [
      { kind: "ethernet", name: "eth0" },
    ])],
  };
}

function validBackupPolicy(overrides: Partial<BackupPolicy> = {}): BackupPolicy {
  return {
    createdAt: "2026-06-20T10:15:30Z",
    enabled: true,
    id: "backup:daily-main",
    recoveryKeyRef: {
      handle: "rk_handle_alice_primary",
      id: "rk:alice-primary",
      keyStoreRef: "keystore:local-tpm",
    },
    retentionDays: 30,
    schedule: {
      cadence: "daily",
      interval: 1,
      startAt: "2026-06-20T11:00:00Z",
    },
    target: {
      bucketRef: "bucket:node-backups",
      credentialRef: "credential:s3-backup-writer",
      kind: "remote-object",
    },
    ...overrides,
  };
}

function validIdentityConfig(overrides: Partial<IdentityConfig> = {}): MutableIdentityConfigInput {
  return {
    did: "did:plc:abcdefghijklmnopqrstuvwx",
    handle: "alice.example.com",
    pds: {
      endpoint: "https://pds.example.com/",
    },
    rotationKeyRefs: [
      {
        handle: "rk_handle_alice_rotation",
        id: "rk:alice-rotation",
      },
    ],
    signingKeyRef: {
      handle: "sk_handle_alice_signing",
      id: "sk:alice-signing",
    },
    ...overrides,
  };
}

interface MutableNodeConfigInput extends Record<string, unknown> {
  storage?: MutableStorageLayoutInput;
  network?: MutableNetworkConfigInput;
  backup?: BackupPolicy;
  identity?: MutableIdentityConfigInput;
}

interface MutableStorageLayoutInput extends Record<string, unknown> {
  subvolumes: Record<string, unknown>[];
}

interface MutableNetworkConfigInput extends Record<string, unknown> {
  firewall: {
    allow?: InboundRule[];
  };
  interfaces: NetworkConfig["interfaces"][number][];
}

interface MutableIdentityConfigInput extends IdentityConfig {
  handle: string;
}
