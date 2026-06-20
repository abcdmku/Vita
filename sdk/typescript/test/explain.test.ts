import assert from "node:assert/strict";
import { test } from "node:test";

import { explainPlan } from "../src/explain.ts";
import { normalize } from "../src/plan.ts";
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
      enabled: true,
      retentionDays: 30,
    },
  ],
};

test("representative plans produce a stable non-empty explanation", () => {
  const explanation = explainPlan(normalize(representativeState));

  assert.notEqual(explanation, "");
  assert.equal(
    explanation,
    [
      "Canonical plan v1",
      "",
      "Identity",
      "  Owner: Alice (did:example:alice)",
      "  Passkeys required: yes",
      "",
      "Storage",
      "  Data volume:",
      "    Encryption: required",
      "    Snapshots: hourly",
      "    Quota: 512 GiB",
      "",
      "Apps (2)",
      "  - atproto-pds",
      "    Enabled: not specified",
      "    Version: 1.0.0",
      "    Config:",
      "      memory: 2GiB",
      "      publicAccess: true",
      "  - local-search",
      "    Enabled: yes",
      "    Version: not specified",
      "    Config:",
      "      index:",
      "        paths:",
      "          - photos",
      "          - documents",
      "        priority: 2",
      "      memory: 1GiB",
      "      publicAccess: false",
      "",
      "Backups (1)",
      "  - usb-main",
      "    Enabled: yes",
      "    Target: usb",
      "    Schedule: daily",
      "    Retention: 30 days",
    ].join("\n"),
  );
  assert.match(explanation, /Apps \(2\)/);
  assert.match(explanation, /local-search/);
  assert.match(explanation, /Storage/);
  assert.match(explanation, /Backups \(1\)/);
});

test("explanations are deterministic for the same plan", () => {
  const plan = normalize(representativeState);

  assert.equal(explainPlan(plan), explainPlan(plan));
});

test("minimal plans explain without throwing", () => {
  let explanation = "";

  assert.doesNotThrow(() => {
    explanation = explainPlan(normalize({}));
  });

  assert.equal(
    explanation,
    [
      "Canonical plan v1",
      "",
      "Identity",
      "  Owner: not declared",
      "  Passkeys required: not specified",
      "",
      "Storage",
      "  Data volume: not declared",
      "",
      "Apps (0)",
      "  None",
      "",
      "Backups (0)",
      "  None",
    ].join("\n"),
  );
});
