import assert from "node:assert/strict";
import { test } from "node:test";

import { validatePackageContract } from "../src/package-contract.ts";
import type { PackageContract } from "../src/package-contract.ts";

const validContract: PackageContract = {
  packageClass: "ts-service",
  identity: {
    id: "com.vita.notes",
    name: "Vita Notes",
    description: "First-party notes service.",
  },
  signingPublisher: {
    id: "vita.first-party",
    signingKeyRef: "publisher-key://vita/first-party/stable",
  },
  version: "1.2.3",
  digest: {
    algorithm: "sha256",
    value: "8c4f2d730f5f0f91f0a6373d9867a22f45e4b508ea258e321fdb61c09f771d25",
  },
  architectures: ["x86_64", "arm64"],
  resources: {
    cpuCores: 2,
    ramMiB: 512,
    storageMiB: 1024,
  },
  accelerators: {
    required: [{ kind: "intel.npu", generation: "core-ultra" }],
    optional: [{ kind: "nvidia.cuda", memoryGB: 8, compute: "8.6" }],
    preference: ["npu", "gpu", "cpu"],
  },
  network: {
    ingress: [{ name: "web", protocol: "https", port: 443, public: false }],
    egress: [
      {
        name: "updates",
        protocol: "https",
        destinations: ["updates.example.invalid"],
        ports: [443],
      },
    ],
  },
  data: {
    classes: ["user-content", "app-state"],
    volumes: [
      {
        name: "state",
        mountPath: "/var/lib/vita-notes",
        class: "app-state",
        access: "read-write",
        persistence: "persistent",
        backup: true,
        sizeMiB: 1024,
      },
    ],
  },
  secrets: [
    {
      name: "sync-token",
      ref: "secret://vita/notes/sync-token",
      purpose: "Authenticate outbound sync requests.",
      optional: false,
    },
  ],
  backup: {
    strategy: "application-consistent",
    includeVolumes: ["state"],
    quiesceHooks: [{ name: "flush", entrypoint: "hooks.flush", timeoutSeconds: 30 }],
    backupHooks: [{ name: "snapshot", entrypoint: "hooks.snapshot", timeoutSeconds: 60 }],
  },
  restore: {
    requireCleanVerification: true,
    verificationHooks: [{ name: "verify", entrypoint: "hooks.verify", timeoutSeconds: 45 }],
  },
  healthChecks: [
    {
      name: "http",
      type: "http",
      target: "/healthz",
      intervalSeconds: 30,
      timeoutSeconds: 5,
    },
  ],
  updates: {
    channel: "stable",
    strategy: "replace",
    schemaMigrations: [
      {
        id: "notes-1.2.0-to-1.2.3",
        fromVersion: "1.2.0",
        toVersion: "1.2.3",
        hook: { name: "migrate", entrypoint: "hooks.migrate", timeoutSeconds: 120 },
        reversible: true,
      },
    ],
  },
  rollback: {
    maxRollbackVersions: 2,
    maxRollbackAgeDays: 30,
    requiresFreshBackup: true,
  },
  exportFormats: ["vita-capsule", "json"],
  endOfSupportDate: "2028-12-31",
  sbom: {
    format: "spdx-json",
    digest: {
      algorithm: "sha256",
      value: "497f6eca5576b90883c4632f4a6012db0826829f6d95cb5fae40897a7f4d7c3e",
    },
    generatedAt: "2026-06-01T12:00:00.000Z",
  },
  vulnerabilityStatus: {
    status: "clean",
    scannedAt: "2026-06-01T12:10:00.000Z",
    critical: 0,
    high: 0,
    medium: 0,
    low: 0,
  },
  requiredSimulationProfiles: ["baseline-x86_64", "network-partition"],
};

test("valid complete package contract validates and yields PackageContract", () => {
  const result = validatePackageContract(validContract);

  assert.equal(result.ok, true);

  if (!result.ok) {
    assert.fail(result.errors.map((error) => `${error.path}: ${error.message}`).join("\n"));
  }

  const contract: PackageContract = result.contract;

  assert.equal(contract, validContract);
  assert.deepEqual(contract.architectures, ["x86_64", "arm64"]);
  assert.deepEqual(
    contract.accelerators.required.map((capability) => capability.kind),
    ["intel.npu"],
  );
});

test("missing required package fields are rejected with precise paths", () => {
  const contract = structuredClone(validContract) as Record<string, unknown>;

  delete contract.version;
  delete contract.digest;
  delete contract.architectures;

  const result = validatePackageContract(contract);

  assert.equal(result.ok, false);

  if (result.ok) {
    assert.fail("expected missing required fields to fail validation");
  }

  assert.deepEqual(
    result.errors.map((error) => error.path).sort(),
    ["architectures", "digest", "version"],
  );
});

test("inline embedded secrets and unknown package classes are rejected", () => {
  const contract = structuredClone(validContract) as Record<string, unknown>;

  contract.packageClass = "python-service";
  contract.secrets = [
    {
      name: "sync-token",
      value: "not-a-reference",
      purpose: "Authenticate outbound sync requests.",
    },
  ];

  const result = validatePackageContract(contract);

  assert.equal(result.ok, false);

  if (result.ok) {
    assert.fail("expected embedded secret and unknown class to fail validation");
  }

  assert.equal(
    result.errors.some(
      (error) =>
        error.path === "packageClass" &&
        error.message.includes("ts-service") &&
        error.message.includes("native-extension"),
    ),
    true,
  );
  assert.equal(
    result.errors.some(
      (error) =>
        error.path === "secrets/0/value" &&
        error.message === "Secret material must be referenced, not embedded.",
    ),
    true,
  );
  assert.equal(
    result.errors.some(
      (error) => error.path === "secrets/0/ref" && error.message === "Required field is missing.",
    ),
    true,
  );
});

test("malformed cyclic input is rejected instead of throwing", () => {
  const contract = structuredClone(validContract) as Record<string, unknown>;

  contract.identity = contract;

  assert.doesNotThrow(() => validatePackageContract(contract));

  const result = validatePackageContract(contract);

  assert.equal(result.ok, false);

  if (result.ok) {
    assert.fail("expected cyclic contract to fail validation");
  }

  assert.deepEqual(result.errors, [
    {
      path: "identity",
      message: "Cyclic object is not allowed.",
    },
  ]);
});
