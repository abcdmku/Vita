import assert from "node:assert/strict";
import { test } from "node:test";

import { validateNodeChangeSet } from "../src/node-changeset-model.ts";
import type { AccountsConfig } from "../src/accounts-model.ts";
import type { CapsuleRegistry } from "../src/capsule-registry-model.ts";
import type {
  NodeChangeSet,
  NodeChangeSetRejections,
  NodeChangeSetValidationResult,
} from "../src/node-changeset-model.ts";
import type { NodeConfig } from "../src/node-config-model.ts";
import type { ServicesConfig } from "../src/services-model.ts";

const SHA256_EMPTY = "sha256-47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU=";

test("a change-set with several valid sections validates with sorted section names", () => {
  const changeSet: NodeChangeSet = {
    services: validServicesConfig(),
    nodeConfig: validNodeConfig(),
    capsules: validCapsuleRegistry(),
    accounts: validAccountsConfig(),
  };

  const result = validateNodeChangeSet(changeSet);

  if (!result.ok) {
    assert.fail(`expected node change-set to validate: ${JSON.stringify(result.rejections)}`);
  }

  assert.deepEqual(result.changeSet, {
    accounts: changeSet.accounts,
    capsules: changeSet.capsules,
    nodeConfig: changeSet.nodeConfig,
    services: changeSet.services,
  });
  assert.deepEqual(result.sectionsPresent, [
    "accounts",
    "capsules",
    "nodeConfig",
    "services",
  ]);
});

test("an empty change-set is rejected because at least one section is required", () => {
  const result = validateNodeChangeSet({});

  if (result.ok) {
    assert.fail(`expected empty node change-set to reject: ${JSON.stringify(result.changeSet)}`);
  }

  assert.deepEqual(envelopePaths(result), [""]);
  assert.equal(
    result.rejections.envelope?.some((error) => error.message.includes("at least one")),
    true,
  );
});

test("unknown top-level keys are rejected on the outer envelope", () => {
  const result = validateNodeChangeSet({
    services: validServicesConfig(),
    runtime: {
      evaluator: "not-yet",
    },
  });

  assert.deepEqual(envelopePaths(result), ["runtime"]);
});

test("one invalid section rejects the whole change-set with that section rejections preserved", () => {
  const result = validateNodeChangeSet({
    services: validServicesConfig(),
    accounts: {
      accounts: [
        {
          name: "alice",
          uid: 0,
          primaryGroup: "alice",
          groups: ["staff"],
          shell: "/bin/bash",
          enabled: true,
        },
      ],
    },
  });

  if (result.ok) {
    assert.fail(`expected invalid accounts section to reject: ${JSON.stringify(result.changeSet)}`);
  }

  assert.equal(Object.hasOwn(result, "changeSet"), false);
  assert.deepEqual(result.rejections.accounts?.map((error) => error.path), [
    "accounts/0/uid",
  ]);
  assert.equal(result.rejections.services, undefined);
});

test("accessor and symbol envelope properties fail closed without reading accessors", () => {
  const accessor = {
    services: validServicesConfig(),
  };
  let getterReads = 0;
  Object.defineProperty(accessor, "accounts", {
    enumerable: true,
    get() {
      getterReads += 1;
      throw new Error("getter should not be read");
    },
  });

  assertRejected(accessor);
  assert.equal(getterReads, 0);

  const withSymbol: Record<string, unknown> = {
    services: validServicesConfig(),
  };
  const symbolKey = Symbol("envelope");
  Object.defineProperty(withSymbol, symbolKey, {
    enumerable: true,
    value: true,
  });

  assertRejected(withSymbol);
});

test("hostile and partial inputs fail closed without throwing", () => {
  const cyclic: Record<string, unknown> = {
    services: validServicesConfig(),
  };
  cyclic.self = cyclic;

  const methodShadowed = {
    services: mutableServicesConfig(),
  };
  Object.defineProperty(methodShadowed.services.services, "map", {
    enumerable: true,
    value() {
      return [];
    },
  });

  const hostileIterator = {
    accounts: mutableAccountsConfig(),
  };
  let iteratorReads = 0;
  Object.defineProperty(hostileIterator.accounts.accounts, Symbol.iterator, {
    enumerable: true,
    get() {
      iteratorReads += 1;
      throw new Error("iterator should not be read");
    },
  });

  const inputs: readonly unknown[] = [
    undefined,
    null,
    "change-set",
    [],
    cyclic,
    new Date(),
    new Map(),
    new Proxy({}, {}),
    methodShadowed,
    hostileIterator,
    {
      services: {},
    },
    {
      accounts: {
        accounts: [
          {
            name: "alice",
            uid: 1001,
          },
        ],
      },
    },
  ];

  for (let index = 0; index < inputs.length; index += 1) {
    assertRejected(inputs[index]);
  }

  assert.equal(iteratorReads, 0);
});

function validNodeConfig(): NodeConfig {
  return {
    network: {
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
      firewall: {
        allow: [
          {
            port: 443,
            protocol: "tcp",
            sourceCidr: "10.0.0.0/8",
          },
        ],
        unsafeWideOpen: false,
      },
    },
  };
}

function validServicesConfig(): ServicesConfig {
  return {
    services: [
      {
        enabled: true,
        name: "ssh.service",
      },
      {
        enabled: false,
        name: "backup.timer",
      },
    ],
  };
}

function validAccountsConfig(): AccountsConfig {
  return {
    accounts: [
      {
        name: "alice",
        uid: 1001,
        primaryGroup: "alice",
        groups: ["staff", "developers"],
        shell: "/bin/bash",
        enabled: true,
      },
    ],
  };
}

function validCapsuleRegistry(): CapsuleRegistry {
  return [
    {
      id: "com.vita.notes",
      integrity: SHA256_EMPTY,
      state: "installed",
      version: "1.2.3",
    },
  ];
}

function mutableServicesConfig(): MutableServicesConfig {
  return {
    services: validServicesConfig().services.map((service) => ({
      enabled: service.enabled,
      name: service.name,
    })),
  };
}

function mutableAccountsConfig(): MutableAccountsConfig {
  return {
    accounts: validAccountsConfig().accounts.map((account) => ({
      name: account.name,
      uid: account.uid,
      primaryGroup: account.primaryGroup,
      groups: [...account.groups],
      shell: account.shell,
      enabled: account.enabled,
    })),
  };
}

function envelopePaths(result: NodeChangeSetValidationResult): readonly string[] {
  if (result.ok) {
    assert.fail(`expected validation to fail: ${JSON.stringify(result.changeSet)}`);
  }

  return (result.rejections.envelope ?? []).map((error) => error.path).sort();
}

function assertRejected(value: unknown): void {
  let rejections: NodeChangeSetRejections | undefined;

  assert.doesNotThrow(() => {
    const result = validateNodeChangeSet(value);

    if (result.ok) {
      assert.fail(`expected validation to fail: ${JSON.stringify(result.changeSet)}`);
    }

    rejections = result.rejections;
  });

  assert.notEqual(rejections, undefined);
}

interface MutableServicesConfig extends Record<string, unknown> {
  services: Array<{
    enabled: boolean;
    name: string;
  }>;
}

interface MutableAccountsConfig extends Record<string, unknown> {
  accounts: Array<{
    name: string;
    uid: number;
    primaryGroup: string;
    groups: string[];
    shell: string;
    enabled: boolean;
  }>;
}
