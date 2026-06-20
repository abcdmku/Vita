import assert from "node:assert/strict";
import { test } from "node:test";

import { validateNodeConfig } from "../src/node-config-model.ts";
import type { NodeConfig, Result, ValidationError } from "../src/node-config-model.ts";

test("a node config with several valid sections validates", () => {
  const config = validConfig();
  const result = validateNodeConfig(config);

  if (!result.ok) {
    assert.fail(`expected node config to validate: ${JSON.stringify(result.errors)}`);
  }

  assert.deepEqual(result.config, config);
  assert.equal(result.value, result.config);
});

test("unknown top-level sections are rejected fail-closed", () => {
  const result = validateNodeConfig({
    network: validNetworkConfig(),
    runtime: {
      evaluator: "not-yet",
    },
  });

  assert.deepEqual(rejectedPaths(result), ["runtime"]);
});

test("invalid present sections are rejected with section-scoped paths", () => {
  const result = validateNodeConfig({
    identity: {
      ...validIdentityConfig(),
      pds: {
        endpoint: "http://pds.example.com/xrpc",
      },
    },
    network: {
      interfaces: [
        {
          kind: "ethernet",
          name: "eth0",
        },
      ],
      firewall: {},
    },
  });

  assert.deepEqual(rejectedPaths(result), ["identity/pds/endpoint", "network/firewall/allow"]);
});

test("empty node configs are rejected", () => {
  const result = validateNodeConfig({});

  if (result.ok) {
    assert.fail(`expected empty node config to reject: ${JSON.stringify(result.value)}`);
  }

  assert.deepEqual(result.errors.map((error) => error.path), [""]);
  assert.equal(
    result.errors.some((error) => error.message.includes("at least one config section")),
    true,
  );
});

test("hostile and partial inputs fail closed without throwing", () => {
  const cyclic: Record<string, unknown> = {
    network: validNetworkConfig(),
  };
  cyclic.self = cyclic;

  const accessor: Record<string, unknown> = {};
  let getterReads = 0;
  Object.defineProperty(accessor, "network", {
    enumerable: true,
    get() {
      getterReads += 1;
      throw new Error("getter should not be read");
    },
  });

  const methodShadowed = {
    network: mutableNetworkConfig(),
  };
  const shadowedInterfaces = [...methodShadowed.network.interfaces];
  Object.defineProperty(shadowedInterfaces, "map", {
    enumerable: true,
    value() {
      return [];
    },
  });
  methodShadowed.network.interfaces = shadowedInterfaces;

  const hostileIterator = {
    identity: mutableIdentityConfig(),
  };
  const iteratorRotationRefs = [...hostileIterator.identity.rotationKeyRefs];
  let iteratorReads = 0;
  Object.defineProperty(iteratorRotationRefs, Symbol.iterator, {
    enumerable: true,
    get() {
      iteratorReads += 1;
      throw new Error("iterator should not be read");
    },
  });
  hostileIterator.identity.rotationKeyRefs = iteratorRotationRefs;

  const inputs: readonly unknown[] = [
    null,
    "node-config",
    [],
    cyclic,
    accessor,
    new Date(),
    new Map(),
    new Proxy({}, {}),
    methodShadowed,
    hostileIterator,
    {
      identity: {
        did: "did:web:alice.example.com",
      },
    },
  ];

  for (let index = 0; index < inputs.length; index += 1) {
    assertRejected(inputs[index]);
  }

  assert.equal(getterReads, 0);
  assert.equal(iteratorReads, 0);
});

function validConfig(): NodeConfig {
  return {
    backup: validBackupPolicy(),
    identity: validIdentityConfig(),
    network: validNetworkConfig(),
    storage: validStorageLayout(),
  };
}

function validStorageLayout(): NonNullable<NodeConfig["storage"]> {
  return {
    version: 1,
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
  };
}

function validNetworkConfig(): NonNullable<NodeConfig["network"]> {
  return {
    firewall: {
      allow: [
        {
          port: 443,
          protocol: "tcp",
          sourceCidr: "10.0.0.0/8",
        },
        {
          port: 53,
          protocol: "udp",
          sourceCidr: "192.168.1.0/24",
        },
      ],
      unsafeWideOpen: false,
    },
    interfaces: [
      {
        kind: "ethernet",
        name: "eth0",
      },
      {
        kind: "loopback",
        name: "lo",
      },
    ],
  };
}

function validBackupPolicy(): NonNullable<NodeConfig["backup"]> {
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
  };
}

function validIdentityConfig(): NonNullable<NodeConfig["identity"]> {
  return {
    did: "did:plc:ewvi7nxzyoun6zhxrhs64oiz",
    handle: "alice.example.com",
    pds: {
      endpoint: "https://pds.example.com",
    },
    rotationKeyRefs: [
      {
        handle: "identity-rotation-primary",
        id: "key:identity-rotation-primary",
      },
    ],
    signingKeyRef: {
      handle: "identity-signing-primary",
      id: "key:identity-signing-primary",
    },
  };
}

function mutableNetworkConfig(): MutableNetworkConfig {
  return {
    firewall: {
      allow: validNetworkConfig().firewall.allow.map((rule) => ({
        port: rule.port,
        protocol: rule.protocol,
        sourceCidr: rule.sourceCidr,
      })),
      unsafeWideOpen: false,
    },
    interfaces: validNetworkConfig().interfaces.map((networkInterface) => ({
      kind: networkInterface.kind,
      name: networkInterface.name,
    })),
  };
}

function mutableIdentityConfig(): MutableIdentityConfig {
  const config = validIdentityConfig();

  return {
    did: config.did,
    handle: config.handle,
    pds: {
      endpoint: config.pds.endpoint,
    },
    rotationKeyRefs: config.rotationKeyRefs.map((keyRef) => ({
      handle: keyRef.handle,
      id: keyRef.id,
    })),
    signingKeyRef: {
      handle: config.signingKeyRef.handle,
      id: config.signingKeyRef.id,
    },
  };
}

function rejectedPaths(result: Result): readonly string[] {
  if (result.ok) {
    assert.fail(`expected validation to fail: ${JSON.stringify(result.value)}`);
  }

  return result.errors.map((error) => error.path).sort();
}

function assertRejected(value: unknown): void {
  let errors: readonly ValidationError[] | undefined;

  assert.doesNotThrow(() => {
    const result = validateNodeConfig(value);

    if (result.ok) {
      assert.fail(`expected validation to fail: ${JSON.stringify(result.value)}`);
    }

    errors = result.errors;
  });

  assert.notEqual(errors, undefined);
}

interface MutableNetworkConfig {
  interfaces: Array<{
    kind: string;
    name: string;
  }>;
  firewall: {
    allow: Array<{
      port: number;
      protocol: string;
      sourceCidr: string;
    }>;
    unsafeWideOpen: boolean;
  };
}

interface MutableIdentityConfig {
  did: string;
  handle: string;
  pds: {
    endpoint: string;
  };
  rotationKeyRefs: Array<{
    handle: string;
    id: string;
  }>;
  signingKeyRef: {
    handle: string;
    id: string;
  };
}
