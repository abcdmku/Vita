import type { PackageContract } from "../src/package-contract.ts";

// Copy this starter and replace identity.id, identity.name, version, digest.value,
// and signingPublisher.signingKeyRef before publishing. This authoring manifest is
// re-validated by the node before any privileged action is applied.
export const staticSiteTemplate: PackageContract = {
  packageClass: "ui-extension",
  identity: {
    id: "dev.example.static-site-starter",
    name: "Static Site Starter",
    description: "Minimal private static front-end capsule.",
  },
  signingPublisher: {
    id: "vita.first-party.templates",
    signingKeyRef: "publisher-key://vita/first-party/templates/static-site",
  },
  version: "0.1.0",
  digest: {
    algorithm: "sha256",
    value: "0000000000000000000000000000000000000000000000000000000000000000",
  },
  architectures: ["x86_64", "arm64"],
  resources: {
    cpuCores: 1,
    ramMiB: 128,
    storageMiB: 128,
  },
  accelerators: {
    required: [],
    optional: [],
    preference: [],
  },
  network: {
    ingress: [{ name: "private-site", protocol: "https", port: 443, public: false }],
    egress: [],
  },
  data: {
    classes: ["cache"],
    volumes: [
      {
        name: "served-assets",
        mountPath: "/srv/www",
        class: "cache",
        access: "read-only",
        persistence: "ephemeral",
        backup: false,
        sizeMiB: 128,
      },
    ],
  },
  secrets: [],
  backup: {
    strategy: "none",
    includeVolumes: [],
    quiesceHooks: [],
    backupHooks: [],
  },
  restore: {
    requireCleanVerification: false,
    verificationHooks: [],
  },
  healthChecks: [
    {
      name: "lifecycle",
      type: "lifecycle",
      target: "ready",
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
    requiresFreshBackup: false,
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
