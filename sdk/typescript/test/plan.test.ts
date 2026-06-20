import assert from "node:assert/strict";
import { test } from "node:test";

import { isCanonicalPlan, normalize, planHash } from "../src/plan.ts";
import type { DesiredState } from "../src/plan.ts";

const representativeState: DesiredState = {
  identity: {
    owner: {
      id: "did:example:alice",
      displayName: "Alice",
    },
    passkeysRequired: true,
  },
  storage: {
    dataVolume: {
      encryption: "required",
      snapshots: "hourly",
      quotaGiB: 512,
    },
  },
  apps: [
    {
      id: "local-search",
      enabled: true,
      config: {
        memory: "1GiB",
        publicAccess: false,
        index: {
          paths: ["photos", "documents"],
          priority: 2,
        },
      },
    },
    {
      id: "atproto-pds",
      version: "1.0.0",
      config: {
        publicAccess: true,
        memory: "2GiB",
      },
    },
  ],
  backups: [
    {
      id: "usb-main",
      target: "usb",
      schedule: "daily",
      retentionDays: 30,
    },
  ],
};

test("normalizing the same desired state twice yields identical strings and hashes", () => {
  const first = normalize(representativeState);
  const second = normalize(representativeState);

  assert.equal(JSON.stringify(first), JSON.stringify(second));
  assert.equal(planHash(first), planHash(second));
});

test("object key insertion order does not affect the canonical plan", () => {
  const first: DesiredState = {
    identity: {
      owner: {
        id: "did:example:alice",
        displayName: "Alice",
      },
      passkeysRequired: true,
    },
    storage: {
      dataVolume: {
        encryption: "required",
        snapshots: "hourly",
      },
    },
    apps: [
      {
        id: "local-search",
        config: {
          memory: "1GiB",
          publicAccess: false,
          nested: {
            b: 2,
            a: 1,
          },
        },
      },
    ],
    backups: [
      {
        id: "usb-main",
        target: "usb",
        schedule: "daily",
      },
    ],
  };
  const second: DesiredState = {
    backups: [
      {
        schedule: "daily",
        target: "usb",
        id: "usb-main",
      },
    ],
    apps: [
      {
        config: {
          nested: {
            a: 1,
            b: 2,
          },
          publicAccess: false,
          memory: "1GiB",
        },
        id: "local-search",
      },
    ],
    storage: {
      dataVolume: {
        snapshots: "hourly",
        encryption: "required",
      },
    },
    identity: {
      passkeysRequired: true,
      owner: {
        displayName: "Alice",
        id: "did:example:alice",
      },
    },
  };

  const firstPlan = normalize(first);
  const secondPlan = normalize(second);

  assert.equal(JSON.stringify(firstPlan), JSON.stringify(secondPlan));
  assert.equal(planHash(firstPlan), planHash(secondPlan));
});

test("app and backup collections are sorted into a stable canonical order", () => {
  const first: DesiredState = {
    apps: [
      { id: "zeta", config: { b: 2, a: 1 } },
      { id: "alpha", config: { mode: "on" } },
    ],
    backups: [
      { id: "secondary", target: "network", schedule: "weekly" },
      { id: "primary", target: "usb", schedule: "daily" },
    ],
  };
  const second: DesiredState = {
    backups: [
      { schedule: "daily", target: "usb", id: "primary" },
      { schedule: "weekly", target: "network", id: "secondary" },
    ],
    apps: [
      { config: { mode: "on" }, id: "alpha" },
      { config: { a: 1, b: 2 }, id: "zeta" },
    ],
  };

  assert.equal(JSON.stringify(normalize(first)), JSON.stringify(normalize(second)));
});

test("representative state normalizes to the expected top-level plan shape", () => {
  const plan = normalize(representativeState);

  assert.deepEqual(Object.keys(plan), ["apps", "backups", "identity", "storage", "version"]);
  assert.equal(plan.version, 1);
  assert.equal(plan.identity.passkeysRequired, true);
  assert.equal(plan.storage.dataVolume?.encryption, "required");
  assert.equal(plan.apps.length, 2);
  assert.equal(plan.backups.length, 1);
});

test("isCanonicalPlan accepts normalized plans and rejects malformed shapes", () => {
  const plan = normalize(representativeState);

  assert.equal(isCanonicalPlan(plan), true);
  assert.equal(
    isCanonicalPlan({
      apps: plan.apps,
      backups: plan.backups,
      identity: plan.identity,
      storage: plan.storage,
    }),
    false,
  );
  assert.equal(
    isCanonicalPlan({
      ...plan,
      apps: {},
    }),
    false,
  );
  assert.equal(isCanonicalPlan("not a plan"), false);
});

test("isCanonicalPlan fails closed for cyclic or throwing inputs", () => {
  const cyclicConfig: Record<string, unknown> = {};
  cyclicConfig.self = cyclicConfig;
  const cyclicPlan = {
    ...normalize({}),
    apps: [
      {
        id: "cycle",
        config: cyclicConfig,
      },
    ],
  };

  const throwingConfig: Record<string, unknown> = {};
  Object.defineProperty(throwingConfig, "boom", {
    enumerable: true,
    get() {
      throw new Error("boom");
    },
  });
  const throwingPlan = {
    ...normalize({}),
    apps: [
      {
        id: "throws",
        config: throwingConfig,
      },
    ],
  };

  assertPlanGuardRejectsWithoutThrow(cyclicPlan);
  assertPlanGuardRejectsWithoutThrow(throwingPlan);
});

function assertPlanGuardRejectsWithoutThrow(value: unknown): void {
  let result: boolean | undefined;

  assert.doesNotThrow(() => {
    result = isCanonicalPlan(value);
  });
  assert.equal(result, false);
}
