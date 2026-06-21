import assert from "node:assert/strict";
import { test } from "node:test";

import { validateAccountsConfig } from "../src/accounts-model.ts";
import type {
  Account,
  AccountsConfig,
  Result,
  ValidationError,
} from "../src/accounts-model.ts";

test("a valid regular-user accounts config validates", () => {
  const config = validConfig();
  const result = validateAccountsConfig(config);

  if (!result.ok) {
    assert.fail(`expected accounts config to validate: ${JSON.stringify(result.errors)}`);
  }

  assert.deepEqual(result.config, config);
  assert.equal(result.value, result.config);
});

test("an explicit empty accounts array validates", () => {
  const result = validateAccountsConfig({ accounts: [] });

  if (!result.ok) {
    assert.fail(`expected empty accounts array to validate: ${JSON.stringify(result.errors)}`);
  }

  assert.deepEqual(result.config.accounts, []);
});

test("an absent accounts field is rejected", () => {
  assert.deepEqual(rejectedPaths(validateAccountsConfig({})), ["accounts"]);
});

test("uid 0, system-reserved uids, and out-of-range uids are rejected", () => {
  for (const uid of [0, 1, 999, 60001, 1000.5, "1000"]) {
    const config = mutableConfig();
    const account = requireMutableAccount(config, 0);
    account.uid = uid;

    assert.deepEqual(
      rejectedPaths(validateAccountsConfig(config)),
      ["accounts/0/uid"],
      `${String(uid)} must reject`,
    );
  }
});

test("privileged group membership is rejected", () => {
  for (const group of ["sudo", "wheel", "root", "admin"]) {
    const config = mutableConfig();
    const account = requireMutableAccount(config, 0);
    account.groups = ["staff", group];

    assert.deepEqual(
      rejectedPaths(validateAccountsConfig(config)),
      ["accounts/0/groups/1"],
      `${group} supplemental membership must reject`,
    );
  }

  const primary = mutableConfig();
  requireMutableAccount(primary, 0).primaryGroup = "root";

  assert.deepEqual(rejectedPaths(validateAccountsConfig(primary)), ["accounts/0/primaryGroup"]);
});

test("groups are deduplicated in validation output", () => {
  const config = mutableConfig();
  requireMutableAccount(config, 0).groups = ["staff", "developers", "staff"];
  const result = validateAccountsConfig(config);

  if (!result.ok) {
    assert.fail(`expected duplicate supplemental groups to validate: ${JSON.stringify(result.errors)}`);
  }

  assert.deepEqual(result.config.accounts[0]?.groups, ["staff", "developers"]);
});

test("non-allowlisted shells are rejected", () => {
  for (const shell of ["/usr/local/bin/fish", "bash", "/bin/bash -c id", "/tmp/shell"]) {
    const config = mutableConfig();
    requireMutableAccount(config, 0).shell = shell;

    assert.deepEqual(
      rejectedPaths(validateAccountsConfig(config)),
      ["accounts/0/shell"],
      `${shell} must reject`,
    );
  }
});

test("malformed account and group names are rejected", () => {
  const malformedNames = [
    "Alice",
    "1alice",
    "alice!",
    "alice.name",
    "a".repeat(33),
    "",
  ];

  for (let index = 0; index < malformedNames.length; index += 1) {
    const name = malformedNames[index];

    if (name === undefined) {
      assert.fail("expected malformed name fixture");
    }

    const config = mutableConfig();
    requireMutableAccount(config, 0).name = name;

    assert.deepEqual(
      rejectedPaths(validateAccountsConfig(config)),
      ["accounts/0/name"],
      `${name} must reject`,
    );
  }

  const groupConfig = mutableConfig();
  requireMutableAccount(groupConfig, 0).groups = ["bad.group"];

  assert.deepEqual(rejectedPaths(validateAccountsConfig(groupConfig)), ["accounts/0/groups/0"]);
});

test("enabled must be present and boolean", () => {
  const absent = mutableConfig();
  const absentAccount: Record<string, unknown> = requireMutableAccount(absent, 0);
  delete absentAccount["enabled"];

  assert.deepEqual(rejectedPaths(validateAccountsConfig(absent)), ["accounts/0/enabled"]);

  for (const enabled of ["true", 1, null]) {
    const config = mutableConfig();
    requireMutableAccount(config, 0).enabled = enabled;

    assert.deepEqual(
      rejectedPaths(validateAccountsConfig(config)),
      ["accounts/0/enabled"],
    );
  }
});

test("duplicate account names and uids are rejected", () => {
  const duplicateName = mutableConfig();
  requireMutableAccount(duplicateName, 1).name = "alice";

  assert.deepEqual(rejectedPaths(validateAccountsConfig(duplicateName)), ["accounts/1/name"]);

  const duplicateUid = mutableConfig();
  requireMutableAccount(duplicateUid, 1).uid = 1001;

  assert.deepEqual(rejectedPaths(validateAccountsConfig(duplicateUid)), ["accounts/1/uid"]);
});

test("unknown envelope and entry keys are rejected", () => {
  assert.deepEqual(
    rejectedPaths(validateAccountsConfig({ accounts: [], extra: true })),
    ["extra"],
  );

  const config = mutableConfig();
  requireMutableAccount(config, 0)["password"] = "secret";

  assert.deepEqual(rejectedPaths(validateAccountsConfig(config)), ["accounts/0/password"]);
});

test("inline key material in string fields is rejected", () => {
  const cases: readonly {
    readonly path: string;
    readonly mutate: (config: MutableAccountsConfig) => void;
  }[] = [
    {
      path: "accounts/0/name",
      mutate(config) {
        requireMutableAccount(config, 0).name = "-----BEGIN";
      },
    },
    {
      path: "accounts/0/primaryGroup",
      mutate(config) {
        requireMutableAccount(config, 0).primaryGroup = "data:text";
      },
    },
    {
      path: "accounts/0/groups/0",
      mutate(config) {
        requireMutableAccount(config, 0).groups = ["ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuv"];
      },
    },
    {
      path: "accounts/0/shell",
      mutate(config) {
        requireMutableAccount(config, 0).shell = "data:text/plain;base64,AAAA";
      },
    },
  ];

  for (let index = 0; index < cases.length; index += 1) {
    const item = cases[index];

    if (item === undefined) {
      assert.fail("expected inline key fixture");
    }

    const config = mutableConfig();
    item.mutate(config);

    assert.deepEqual(rejectedPaths(validateAccountsConfig(config)), [item.path]);
  }
});

test("hostile and partial inputs fail closed through safeNormalize without throwing", () => {
  const cyclic: Record<string, unknown> = {
    accounts: [],
  };
  cyclic.self = cyclic;

  const accessor: Record<string, unknown> = {};
  let getterReads = 0;
  Object.defineProperty(accessor, "accounts", {
    enumerable: true,
    get() {
      getterReads += 1;
      throw new Error("getter should not be read");
    },
  });

  const methodShadowed = mutableConfig();
  const shadowedAccounts = [...methodShadowed.accounts];
  Object.defineProperty(shadowedAccounts, "map", {
    enumerable: true,
    value() {
      return [];
    },
  });
  methodShadowed.accounts = shadowedAccounts;

  const hostileIterator = mutableConfig();
  const iteratorAccounts = [...hostileIterator.accounts];
  let iteratorReads = 0;
  Object.defineProperty(iteratorAccounts, Symbol.iterator, {
    enumerable: true,
    get() {
      iteratorReads += 1;
      throw new Error("iterator should not be read");
    },
  });
  hostileIterator.accounts = iteratorAccounts;

  const inputs: readonly unknown[] = [
    undefined,
    null,
    "accounts",
    [],
    {},
    {
      accounts: [{}],
    },
    {
      accounts: [
        {
          name: "alice",
          uid: 1001,
        },
      ],
    },
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

function validConfig(): AccountsConfig {
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
      {
        name: "backup_user",
        uid: 1002,
        primaryGroup: "backup_user",
        groups: ["backup"],
        shell: "/usr/sbin/nologin",
        enabled: false,
      },
    ],
  };
}

function mutableConfig(): MutableAccountsConfig {
  return {
    accounts: validConfig().accounts.map((account) => ({
      name: account.name,
      uid: account.uid,
      primaryGroup: account.primaryGroup,
      groups: [...account.groups],
      shell: account.shell,
      enabled: account.enabled,
    })),
  };
}

function requireMutableAccount(config: MutableAccountsConfig, index: number): MutableAccount {
  const account = config.accounts[index];

  if (account === undefined) {
    assert.fail(`expected account fixture at index ${index}`);
  }

  return account;
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
    const result = validateAccountsConfig(value);

    if (result.ok) {
      assert.fail(`expected validation to fail: ${JSON.stringify(result.value)}`);
    }

    errors = result.errors;
  });

  assert.notEqual(errors, undefined);
}

interface MutableAccount extends Record<string, unknown> {
  name: unknown;
  uid: unknown;
  primaryGroup: unknown;
  groups: unknown;
  shell: unknown;
  enabled: unknown;
}

interface MutableAccountsConfig extends Record<string, unknown> {
  accounts: MutableAccount[];
}
