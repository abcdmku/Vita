import assert from "node:assert/strict";
import { test } from "node:test";

import { assertDeterministic, isDeterministic } from "../src/repro.ts";
import { normalize, planHash } from "../src/plan.ts";
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
      snapshots: "daily",
      quotaGiB: 512,
    },
  },
  apps: [
    {
      id: "local-search",
      enabled: true,
      config: {
        publicAccess: false,
        memory: "1GiB",
        index: {
          priority: 2,
          paths: ["documents", "photos"],
        },
      },
    },
    {
      id: "atproto-pds",
      version: "1.0.0",
      config: {
        memory: "2GiB",
        publicAccess: true,
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

test("assertDeterministic passes for normalizing a representative desired state", () => {
  assert.doesNotThrow(() => {
    assertDeterministic(normalize, representativeState);
  });

  assert.doesNotThrow(() => {
    assertDeterministic((state: DesiredState) => planHash(normalize(state)), representativeState);
  });
});

test("assertDeterministic throws with a clear message when results differ", () => {
  let calls = 0;

  assert.throws(
    () => {
      assertDeterministic(
        (input: string) => ({
          input,
          sequence: calls += 1,
        }),
        "plan",
        { runs: 3 },
      );
    },
    /Function is not deterministic: run 2 differed from run 1\.\nExpected canonical result: .*"sequence":1.*\nReceived canonical result: .*"sequence":2/s,
  );
});

test("isDeterministic returns true for deterministic functions and false for differing output", () => {
  assert.equal(isDeterministic(normalize, representativeState), true);

  let calls = 0;

  assert.equal(
    isDeterministic(
      (input: string) => ({
        input,
        sequence: calls += 1,
      }),
      "plan",
      { runs: 3 },
    ),
    false,
  );
});
