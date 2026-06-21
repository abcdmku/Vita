import assert from "node:assert/strict";
import { test } from "node:test";

import { previewNodeChangeSet } from "../src/changeset-preview.ts";
import type { NodeChangeSetPreview } from "../src/changeset-preview.ts";
import type { Account, AccountsConfig } from "../../../sdk/typescript/src/accounts-model.ts";
import type { BackupPolicy } from "../../../sdk/typescript/src/backup-model.ts";
import type {
  CapsuleEntry,
  CapsuleIntegrity,
} from "../../../sdk/typescript/src/capsule-registry-model.ts";
import type { NodeChangeSet } from "../../../sdk/typescript/src/node-changeset-model.ts";
import type { NodeConfig } from "../../../sdk/typescript/src/node-config-model.ts";
import type {
  InboundRule,
  NetworkConfig,
} from "../../../sdk/typescript/src/network-model.ts";

const SHA256_EMPTY = "sha256-47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU=";
const SHA256_ONES = sri256(1);

test("valid change-sets compose subsystem diffs and aggregate security summary", () => {
  const inboundRule: InboundRule = {
    port: 8443,
    protocol: "tcp",
    sourceCidr: "10.1.0.0/16",
  };
  const current: NodeChangeSet = {
    accounts: validAccountsConfig(),
    capsules: [capsule("com.vita.notes", "1.0.0", SHA256_EMPTY, "installed")],
    nodeConfig: validNodeConfig(),
    services: {
      services: [
        { enabled: false, name: "ssh.service" },
        { enabled: true, name: "old.service" },
      ],
    },
  };
  const desiredAccounts = validAccountsConfig();
  desiredAccounts.accounts[0] = {
    ...requireAccount(desiredAccounts, 0),
    enabled: true,
    groups: ["staff", "ops"],
    primaryGroup: "operators",
  };
  desiredAccounts.accounts[desiredAccounts.accounts.length] = account({
    enabled: true,
    groups: ["reports"],
    name: "reporter",
    primaryGroup: "reporter",
    shell: "/usr/sbin/nologin",
    uid: 1005,
  });
  const desired: NodeChangeSet = {
    accounts: desiredAccounts,
    capsules: [
      capsule("com.vita.notes", "1.1.0", SHA256_EMPTY, "disabled"),
      capsule("com.vita.calendar", "0.1.0", SHA256_ONES, "installed"),
    ],
    nodeConfig: validNodeConfig({
      backupRetentionDays: 7,
      networkAllow: [inboundRule],
    }),
    services: {
      services: [
        { enabled: true, name: "ssh.service" },
        { enabled: true, name: "web.service" },
      ],
    },
  };

  const preview = assertValid(previewNodeChangeSet(current, desired));

  assert.equal(preview.subsystems.nodeConfig?.kind, "changed");
  assert.equal(preview.subsystems.nodeConfig?.wideningInbound, true);
  assert.equal(preview.subsystems.nodeConfig?.weakensRetention, true);
  assert.equal(preview.subsystems.services?.kind, "changed");
  assert.deepEqual(Object.keys(preview.subsystems.services?.diff.enabled ?? {}), [
    "ssh.service",
    "web.service",
  ]);
  assert.deepEqual(Object.keys(preview.subsystems.services?.diff.removed ?? {}), [
    "old.service",
  ]);
  assert.equal(preview.subsystems.accounts?.kind, "changed");
  assert.deepEqual(Object.keys(preview.subsystems.accounts?.groupChanges ?? {}), [
    "alice",
  ]);
  assert.equal(preview.subsystems.capsules?.kind, "changed");
  assert.deepEqual(Object.keys(preview.subsystems.capsules?.diff.installed ?? {}), [
    "com.vita.calendar",
  ]);
  assert.deepEqual(Object.keys(preview.subsystems.capsules?.diff.upgraded ?? {}), [
    "com.vita.notes",
  ]);

  assert.deepEqual(preview.summary, {
    accountGroupChanges: preview.subsystems.accounts?.groupChanges,
    newlyEnabledAccounts: 2,
    newlyEnabledServices: 2,
    weakensRetention: true,
    wideningInbound: true,
  });
});

test("newly added services use the empty-valid services baseline", () => {
  const current: NodeChangeSet = {
    accounts: emptyAccountsConfig(),
  };
  const desired: NodeChangeSet = {
    accounts: emptyAccountsConfig(),
    services: {
      services: [
        { enabled: false, name: "backup.timer" },
        { enabled: true, name: "web.service" },
      ],
    },
  };

  const preview = assertValid(previewNodeChangeSet(current, desired));

  assert.equal(preview.subsystems.services?.kind, "added");
  assert.deepEqual(Object.keys(preview.subsystems.services?.diff.added ?? {}), [
    "backup.timer",
    "web.service",
  ]);
  assert.deepEqual(Object.keys(preview.subsystems.services?.diff.removed ?? {}), []);
  assert.equal(preview.summary.newlyEnabledServices, 1);
});

test("invalid newly added services fail closed before report creation", () => {
  const result = previewNodeChangeSet(
    {
      accounts: emptyAccountsConfig(),
    },
    {
      accounts: emptyAccountsConfig(),
      services: {
        services: [{ name: "web" }],
      },
    },
  );

  const rejected = assertInvalid(result);
  assert.equal(Object.hasOwn(rejected, "subsystems"), false);
  assert.ok(rejected.rejections.desired?.services?.length ?? 0 > 0);
});

test("removed capsule subsystem uses the empty-valid capsule baseline", () => {
  const current: NodeChangeSet = {
    capsules: [capsule("com.vita.notes", "1.0.0", SHA256_EMPTY, "installed")],
  };
  const desired: NodeChangeSet = {
    services: {
      services: [],
    },
  };

  const preview = assertValid(previewNodeChangeSet(current, desired));

  assert.equal(preview.subsystems.capsules?.kind, "removed");
  assert.deepEqual(Object.keys(preview.subsystems.capsules?.diff.removed ?? {}), [
    "com.vita.notes",
  ]);
  assert.equal(preview.subsystems.services?.kind, "added");
});

test("newly managed nodeConfig is added directly and computes inbound widening", () => {
  const current: NodeChangeSet = {
    services: {
      services: [],
    },
  };
  const desiredNodeConfig = validNodeConfig({
    networkAllow: [{ port: 443, protocol: "tcp", sourceCidr: "10.0.0.0/8" }],
  });
  const desired: NodeChangeSet = {
    nodeConfig: desiredNodeConfig,
    services: {
      services: [],
    },
  };

  const preview = assertValid(previewNodeChangeSet(current, desired));

  assert.equal(preview.subsystems.nodeConfig?.kind, "added");
  const nodeConfigSubsystem = preview.subsystems.nodeConfig;

  if (nodeConfigSubsystem?.kind !== "added") {
    assert.fail("expected added nodeConfig subsystem");
  }

  assert.deepEqual(nodeConfigSubsystem.after.network?.firewall.allow, [
    { port: 443, protocol: "tcp", sourceCidr: "10.0.0.0/8" },
  ]);
  assert.equal(nodeConfigSubsystem.after.backup?.id, desiredNodeConfig.backup?.id);
  assert.equal(nodeConfigSubsystem.weakensRetention, false);
  assert.equal(nodeConfigSubsystem.wideningInbound, true);
  assert.equal(preview.summary.wideningInbound, true);
  assert.equal(preview.summary.weakensRetention, false);
});

test("removed nodeConfig is removed directly and weakens retention when backup was managed", () => {
  const currentNodeConfig: NodeConfig = {
    backup: validBackupPolicy(),
  };
  const current: NodeChangeSet = {
    nodeConfig: currentNodeConfig,
    services: {
      services: [],
    },
  };
  const desired: NodeChangeSet = {
    services: {
      services: [],
    },
  };

  const preview = assertValid(previewNodeChangeSet(current, desired));

  assert.equal(preview.subsystems.nodeConfig?.kind, "removed");
  assert.deepEqual(preview.subsystems.nodeConfig, {
    before: currentNodeConfig,
    kind: "removed",
    weakensRetention: true,
    wideningInbound: false,
  });
  assert.equal(preview.summary.weakensRetention, true);
  assert.equal(preview.summary.wideningInbound, false);
});

test("invalid current or desired change-sets return typed rejections without throwing", () => {
  const invalidCurrent = {
    services: {
      services: [{ enabled: true, name: "not-a-unit" }],
    },
  };
  const invalidDesired = {
    accounts: {
      accounts: [
        {
          enabled: true,
          groups: ["staff"],
          name: "alice",
          primaryGroup: "alice",
          shell: "/bin/bash",
          uid: 999,
        },
      ],
    },
  };

  assert.doesNotThrow(() => previewNodeChangeSet(invalidCurrent, validChangeSet()));
  assert.doesNotThrow(() => previewNodeChangeSet(validChangeSet(), invalidDesired));

  const currentPreview = previewNodeChangeSet(invalidCurrent, validChangeSet());
  const desiredPreview = previewNodeChangeSet(validChangeSet(), invalidDesired);

  const rejectedCurrentPreview = assertInvalid(currentPreview);
  const rejectedDesiredPreview = assertInvalid(desiredPreview);
  assert.ok(rejectedCurrentPreview.rejections.current?.services?.length ?? 0 > 0);
  assert.ok(rejectedDesiredPreview.rejections.desired?.accounts?.length ?? 0 > 0);
});

test("hostile inputs fail closed without invoking external accessor probes", () => {
  const hostileCurrent: Record<string, unknown> = {
    services: {
      services: [],
    },
  };
  let getterReads = 0;
  Object.defineProperty(hostileCurrent, "accounts", {
    enumerable: true,
    get() {
      getterReads += 1;
      return emptyAccountsConfig();
    },
  });

  assert.doesNotThrow(() => previewNodeChangeSet(hostileCurrent, validChangeSet()));

  const preview = previewNodeChangeSet(hostileCurrent, validChangeSet());

  assert.equal(getterReads, 0);
  const rejected = assertInvalid(preview);
  assert.ok(rejected.rejections.current?.envelope?.length ?? 0 > 0);
});

function assertValid(
  preview: NodeChangeSetPreview,
): Extract<NodeChangeSetPreview, { readonly ok: true }> {
  if (!preview.ok) {
    assert.fail(`expected valid preview: ${JSON.stringify(preview.rejections)}`);
  }

  return preview;
}

function assertInvalid(
  preview: NodeChangeSetPreview,
): Extract<NodeChangeSetPreview, { readonly ok: false }> {
  assert.equal(preview.ok, false);

  if (preview.ok) {
    assert.fail("expected invalid preview");
  }

  return preview;
}

function validChangeSet(): NodeChangeSet {
  return {
    services: {
      services: [],
    },
  };
}

function validNodeConfig(
  overrides: {
    readonly backupRetentionDays?: number;
    readonly networkAllow?: readonly InboundRule[];
  } = {},
): NodeConfig {
  return {
    backup: validBackupPolicy({
      retentionDays: overrides.backupRetentionDays ?? 30,
    }),
    network: validNetworkConfig({
      allow: overrides.networkAllow ?? [],
    }),
  };
}

function validNetworkConfig(
  overrides: {
    readonly allow?: readonly InboundRule[];
  } = {},
): NetworkConfig {
  return {
    firewall: {
      allow: [...(overrides.allow ?? [])],
      unsafeWideOpen: false,
    },
    interfaces: [{ kind: "ethernet", name: "eth0" }],
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

function validAccountsConfig(): MutableAccountsConfig {
  return {
    accounts: [
      account({
        enabled: false,
        groups: ["staff"],
        name: "alice",
        primaryGroup: "alice",
        shell: "/bin/bash",
        uid: 1001,
      }),
    ],
  };
}

function emptyAccountsConfig(): AccountsConfig {
  return {
    accounts: [],
  };
}

function requireAccount(config: MutableAccountsConfig, index: number): MutableAccount {
  const item = config.accounts[index];

  if (item === undefined) {
    assert.fail(`expected account fixture at index ${index}`);
  }

  return item;
}

function account(value: MutableAccount): MutableAccount {
  return value;
}

function capsule(
  id: string,
  version: string,
  integrity: CapsuleIntegrity,
  state: CapsuleEntry["state"],
): CapsuleEntry {
  return {
    id,
    integrity,
    state,
    version,
  };
}

function sri256(byte: number): CapsuleIntegrity {
  return `sha256-${Buffer.alloc(32, byte).toString("base64")}`;
}

interface MutableAccount extends Account {
  groups: string[];
}

interface MutableAccountsConfig extends AccountsConfig {
  accounts: MutableAccount[];
}
