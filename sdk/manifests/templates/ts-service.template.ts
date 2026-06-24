import type { PackageContract } from "../src/package-contract.ts";

// Copy this starter and replace identity.id, identity.name, version, digest.value,
// and signingPublisher.signingKeyRef before publishing. This authoring manifest is
// re-validated by the node before any privileged action is applied.
export const tsServiceTemplate: PackageContract = {
  packageClass: "ts-service",
  identity: {
    id: "dev.example.ts-service-starter",
    name: "TypeScript Service Starter",
    description: "Minimal private HTTP TypeScript service capsule.",
  },
  signingPublisher: {
    id: "vita.first-party.templates",
    signingKeyRef: "publisher-key://vita/first-party/templates/ts-service",
  },
  version: "0.1.0",
  digest: {
    algorithm: "sha256",
    value: "0000000000000000000000000000000000000000000000000000000000000000",
  },
  architectures: ["x86_64", "arm64"],
  resources: {
    cpuCores: 1,
    ramMiB: 256,
    storageMiB: 512,
  },
  accelerators: {
    required: [],
    optional: [],
    preference: [],
  },
  network: {
    ingress: [{ name: "private-http", protocol: "http", port: 8080, public: false }],
    egress: [],
  },
  data: {
    classes: ["app-state"],
    volumes: [
      {
        name: "app-state",
        mountPath: "/var/lib/vita/app-state",
        class: "app-state",
        access: "read-write",
        persistence: "persistent",
        backup: true,
        sizeMiB: 512,
      },
    ],
  },
  secrets: [],
  backup: {
    strategy: "filesystem-snapshot",
    includeVolumes: ["app-state"],
    quiesceHooks: [],
    backupHooks: [],
  },
  restore: {
    requireCleanVerification: true,
    verificationHooks: [],
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
    schemaMigrations: [],
  },
  rollback: {
    maxRollbackVersions: 1,
    maxRollbackAgeDays: 30,
    requiresFreshBackup: true,
  },
  exportFormats: ["vita-capsule"],
  endOfSupportDate: "2099-12-31",
  sbom: {
    format: "spdx-json",
    digest: {
      algorithm: "sha256",
      value: "0000000000000000000000000000000000000000000000000000000000000000",
    },
    generatedAt: "2026-06-01T00:00:00.000Z",
  },
  vulnerabilityStatus: {
    status: "scan-pending",
    critical: 0,
    high: 0,
    medium: 0,
    low: 0,
  },
  requiredSimulationProfiles: ["baseline-x86_64", "baseline-arm64"],
};
