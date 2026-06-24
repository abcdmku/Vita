import type { PackageContract } from "../src/package-contract.ts";

// Copy this starter and replace identity.id, identity.name, version, digest.value,
// and signingPublisher.signingKeyRef before publishing. This authoring manifest is
// re-validated by the node before any privileged action is applied.
export const dataAppTemplate: PackageContract = {
  packageClass: "ts-service",
  identity: {
    id: "dev.example.data-app-starter",
    name: "Data App Starter",
    description: "Minimal private TypeScript service capsule that owns user data.",
  },
  signingPublisher: {
    id: "vita.first-party.templates",
    signingKeyRef: "publisher-key://vita/first-party/templates/data-app",
  },
  version: "0.1.0",
  digest: {
    algorithm: "sha256",
    value: "0000000000000000000000000000000000000000000000000000000000000000",
  },
  architectures: ["x86_64", "arm64"],
  resources: {
    cpuCores: 1,
    ramMiB: 512,
    storageMiB: 2048,
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
    classes: ["user-content", "app-state"],
    volumes: [
      {
        name: "user-content",
        mountPath: "/var/lib/vita/user-content",
        class: "user-content",
        access: "read-write",
        persistence: "persistent",
        backup: true,
        sizeMiB: 1536,
      },
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
    strategy: "application-consistent",
    includeVolumes: ["user-content", "app-state"],
    quiesceHooks: [{ name: "quiesce", entrypoint: "hooks.quiesce", timeoutSeconds: 30 }],
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
    schemaMigrations: [],
  },
  rollback: {
    maxRollbackVersions: 2,
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
