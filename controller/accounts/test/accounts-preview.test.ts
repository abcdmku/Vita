import assert from "node:assert/strict";
import { test } from "node:test";

import { previewAccountsChange } from "../src/accounts-preview.ts";
import type { Account, AccountsConfig } from "../../../sdk/typescript/src/accounts-model.ts";

test("identical configs produce an empty diff without privilege deltas", () => {
  const preview = previewAccountsChange(validConfig(), validConfig());

  assert.equal(preview.valid, true);

  if (!preview.valid) {
    assert.fail("expected valid preview");
  }

  assert.equal(preview.newlyEnabledCount, 0);
  assert.deepEqual(preview.rejections, []);
  assert.deepEqual(Object.keys(preview.diff.added), []);
  assert.deepEqual(Object.keys(preview.diff.removed), []);
  assert.deepEqual(Object.keys(preview.diff.modified), []);
  assert.deepEqual(Object.keys(preview.groupChanges), []);
});

test("added, removed, and modified accounts are classified by name", () => {
  const current = mutableConfig();
  current.accounts[current.accounts.length] = mutableAccount({
    enabled: true,
    groups: ["legacy"],
    name: "oldsvc",
    primaryGroup: "oldsvc",
    shell: "/usr/sbin/nologin",
    uid: 1003,
  });

  const desired = mutableConfig();
  desired.accounts = desired.accounts.filter((item) => item.name !== "oldsvc");
  desired.accounts[0] = {
    ...requireAccount(desired, 0),
    shell: "/bin/sh",
    uid: 1101,
  };
  const added = mutableAccount({
    enabled: false,
    groups: ["analytics"],
    name: "carol",
    primaryGroup: "carol",
    shell: "/bin/bash",
    uid: 1004,
  });
  desired.accounts[desired.accounts.length] = added;

  const preview = previewAccountsChange(current, desired);

  assert.equal(preview.valid, true);

  if (!preview.valid) {
    assert.fail("expected valid preview");
  }

  assert.deepEqual(Object.keys(preview.diff.added), ["carol"]);
  assert.deepEqual(preview.diff.added["carol"], added);
  assert.deepEqual(Object.keys(preview.diff.removed), ["oldsvc"]);
  assert.equal(preview.diff.removed["oldsvc"]?.name, "oldsvc");
  assert.deepEqual(Object.keys(preview.diff.modified), ["alice"]);
  assert.deepEqual(preview.diff.modified["alice"]?.fields, ["uid", "shell"]);
  assert.equal(preview.newlyEnabledCount, 0);
  assert.deepEqual(Object.keys(preview.groupChanges), []);
});

test("newly enabled accounts count flips and added enabled accounts", () => {
  const desired = mutableConfig();
  desired.accounts[1] = {
    ...requireAccount(desired, 1),
    enabled: true,
  };
  desired.accounts[desired.accounts.length] = mutableAccount({
    enabled: true,
    groups: ["reports"],
    name: "reporter",
    primaryGroup: "reporter",
    shell: "/usr/sbin/nologin",
    uid: 1005,
  });

  const preview = previewAccountsChange(validConfig(), desired);

  assert.equal(preview.valid, true);

  if (!preview.valid) {
    assert.fail("expected valid preview");
  }

  assert.equal(preview.newlyEnabledCount, 2);
});

test("primary group and supplemental group changes are surfaced", () => {
  const desired = mutableConfig();
  desired.accounts[0] = {
    ...requireAccount(desired, 0),
    groups: ["staff", "qa"],
    primaryGroup: "operators",
  };

  const preview = previewAccountsChange(validConfig(), desired);

  assert.equal(preview.valid, true);

  if (!preview.valid) {
    assert.fail("expected valid preview");
  }

  assert.deepEqual(Object.keys(preview.groupChanges), ["alice"]);
  assert.deepEqual(preview.groupChanges["alice"]?.fields, ["primaryGroup", "groups"]);
  assert.deepEqual(preview.groupChanges["alice"]?.current, {
    groups: ["staff", "developers"],
    primaryGroup: "alice",
  });
  assert.deepEqual(preview.groupChanges["alice"]?.desired, {
    groups: ["staff", "qa"],
    primaryGroup: "operators",
  });
  assert.deepEqual(preview.diff.modified["alice"]?.fields, ["primaryGroup", "groups"]);
});

test("invalid current or desired configs return typed rejections with no diff", () => {
  const invalidCurrent = {
    accounts: [
      {
        enabled: true,
        groups: ["staff"],
        name: "bad",
        primaryGroup: "bad",
        shell: "/bin/bash",
        uid: 999,
      },
    ],
  };
  const invalidDesired = {
    accounts: [
      {
        enabled: true,
        groups: ["wheel"],
        name: "rootish",
        primaryGroup: "rootish",
        shell: "/bin/bash",
        uid: 1006,
      },
    ],
  };

  for (const [current, desired, side] of [
    [invalidCurrent, validConfig(), "current"],
    [validConfig(), invalidDesired, "desired"],
  ] as const) {
    const preview = previewAccountsChange(current, desired);

    assert.equal(preview.valid, false);

    if (preview.valid) {
      assert.fail("expected invalid preview");
    }

    assert.equal(preview.diff, undefined);
    assert.equal(preview.newlyEnabledCount, 0);
    assert.deepEqual(Object.keys(preview.groupChanges), []);
    assert.ok(preview.rejections.length > 0);
    assert.ok(preview.rejections.every((rejection) => rejection.side === side));
  }
});

test("hostile inputs fail closed without throwing or reading accessors", () => {
  const desired: Record<string, unknown> = {};
  let getterReads = 0;

  Object.defineProperty(desired, "accounts", {
    enumerable: true,
    get() {
      getterReads += 1;
      throw new Error("getter should not escape preview");
    },
  });

  assert.doesNotThrow(() => previewAccountsChange(validConfig(), desired));

  const preview = previewAccountsChange(validConfig(), desired);

  assert.equal(getterReads, 0);
  assert.equal(preview.valid, false);

  if (preview.valid) {
    assert.fail("expected invalid preview");
  }

  assert.equal(preview.diff, undefined);
  assert.equal(preview.newlyEnabledCount, 0);
  assert.ok(preview.rejections.some((rejection) => rejection.side === "desired"));
});

test("__proto__ and constructor account names remain enumerable diff keys", () => {
  const current: AccountsConfig = {
    accounts: [
      account({
        enabled: false,
        groups: ["staff"],
        name: "constructor",
        primaryGroup: "constructor",
        shell: "/usr/sbin/nologin",
        uid: 2001,
      }),
    ],
  };
  const protoAccount = account({
    enabled: true,
    groups: ["operators"],
    name: "__proto__",
    primaryGroup: "__proto__",
    shell: "/bin/bash",
    uid: 2002,
  });
  const constructorAccount = current.accounts[0];

  if (constructorAccount === undefined) {
    assert.fail("expected constructor fixture");
  }

  const desired: AccountsConfig = {
    accounts: [
      account({
        ...constructorAccount,
        enabled: true,
        groups: ["staff", "ops"],
      }),
      protoAccount,
    ],
  };

  const preview = previewAccountsChange(current, desired);

  assert.equal(preview.valid, true);

  if (!preview.valid) {
    assert.fail("expected valid preview");
  }

  assert.deepEqual(Object.keys(preview.diff.added), ["__proto__"]);
  assert.equal(Object.hasOwn(preview.diff.added, "__proto__"), true);
  assert.deepEqual(preview.diff.added["__proto__"], protoAccount);
  assert.equal(Object.getPrototypeOf(preview.diff.added), Object.prototype);
  assert.deepEqual(Object.keys(preview.diff.modified), ["constructor"]);
  assert.equal(Object.hasOwn(preview.diff.modified, "constructor"), true);
  assert.deepEqual(preview.diff.modified["constructor"]?.fields, ["groups", "enabled"]);
  assert.equal(preview.newlyEnabledCount, 2);
  assert.deepEqual(Object.keys(preview.groupChanges), ["constructor"]);
  assert.deepEqual(preview.groupChanges["constructor"]?.fields, ["groups"]);
  assert.notEqual(Object.getPrototypeOf(preview.diff.added), protoAccount);
  assert.equal(Object.hasOwn(Object.getPrototypeOf({}), "constructor"), true);
});

function validConfig(): AccountsConfig {
  return {
    accounts: [
      account({
        enabled: true,
        groups: ["staff", "developers"],
        name: "alice",
        primaryGroup: "alice",
        shell: "/bin/bash",
        uid: 1001,
      }),
      account({
        enabled: false,
        groups: ["backup"],
        name: "backup_user",
        primaryGroup: "backup_user",
        shell: "/usr/sbin/nologin",
        uid: 1002,
      }),
    ],
  };
}

function mutableConfig(): MutableAccountsConfig {
  return {
    accounts: validConfig().accounts.map((item) => ({ ...item, groups: [...item.groups] })),
  };
}

function requireAccount(config: MutableAccountsConfig, index: number): MutableAccount {
  const item = config.accounts[index];

  if (item === undefined) {
    assert.fail(`expected account fixture at index ${index}`);
  }

  return item;
}

function account(value: Account): Account {
  return value;
}

function mutableAccount(value: MutableAccount): MutableAccount {
  return value;
}

interface MutableAccount {
  name: string;
  uid: number;
  primaryGroup: string;
  groups: string[];
  shell: string;
  enabled: boolean;
}

interface MutableAccountsConfig {
  accounts: MutableAccount[];
}
