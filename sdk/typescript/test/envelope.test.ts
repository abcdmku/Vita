import assert from "node:assert/strict";
import { test } from "node:test";

import { encodeEnvelope, sealEnvelope, verifyEnvelope } from "../src/envelope.ts";
import { normalize } from "../src/plan.ts";
import type { DesiredState, CanonicalPlan } from "../src/plan.ts";

const desiredState: DesiredState = {
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
      quotaGiB: 256,
    },
  },
  apps: [
    {
      id: "local-search",
      enabled: true,
      version: "1.0.0",
      config: {
        memory: "1GiB",
        publicAccess: false,
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

const createdAtRef = "source:plan-request:001";

test("sealEnvelope then verifyEnvelope round-trips true", () => {
  const envelope = sealEnvelope(normalize(desiredState), { createdAtRef });

  assert.equal(envelope.createdAtRef, createdAtRef);
  assert.equal(verifyEnvelope(envelope), true);
});

test("altering the plan without updating planHash fails verification", () => {
  const envelope = sealEnvelope(normalize(desiredState), { createdAtRef });
  const tamperedPlan: CanonicalPlan = normalize({
    ...desiredState,
    storage: {
      dataVolume: {
        encryption: "optional",
        snapshots: "daily",
        quotaGiB: 256,
      },
    },
  });

  assert.equal(
    verifyEnvelope({
      ...envelope,
      plan: tamperedPlan,
    }),
    false,
  );
});

test("a malformed plan with a matching planHash fails verification", () => {
  const plan = normalize(desiredState);
  const malformedPlan = {
    apps: plan.apps,
    backups: plan.backups,
    identity: plan.identity,
    storage: plan.storage,
  } as unknown as CanonicalPlan;
  const envelope = sealEnvelope(malformedPlan, { createdAtRef });

  assert.equal(verifyEnvelope(envelope), false);
});

test("altering createdAtRef or schemaVersion without updating planHash fails verification", () => {
  const envelope = sealEnvelope(normalize(desiredState), { createdAtRef });

  assert.equal(
    verifyEnvelope({
      ...envelope,
      createdAtRef: "source:plan-request:002",
    }),
    false,
  );
  assert.equal(
    verifyEnvelope({
      ...envelope,
      schemaVersion: envelope.schemaVersion + 1,
    }),
    false,
  );
});

test("encodeEnvelope is deterministic for the same envelope", () => {
  const envelope = sealEnvelope(normalize(desiredState), { createdAtRef });

  assert.equal(encodeEnvelope(envelope), encodeEnvelope(envelope));
});
