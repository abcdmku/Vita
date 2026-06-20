import type { CatalogEntry } from "../../catalog/src/catalog-entry.ts";
import type { PackageContract } from "../../../sdk/manifests/src/package-contract.ts";
import type { CapabilityGrant } from "../../../runtime/permission-broker/src/grants.ts";

export const notesPackageContract: PackageContract = {
  packageClass: "ts-service",
  identity: {
    id: "com.vita.notes",
    name: "Vita Notes",
    description: "First-party Deno notes service.",
  },
  signingPublisher: {
    id: "vita.first-party",
    signingKeyRef: "publisher-key://vita/first-party/stable",
  },
  version: "1.0.0",
  digest: {
    algorithm: "sha256",
    value: "1111111111111111111111111111111111111111111111111111111111111111",
  },
  architectures: ["x86_64", "arm64"],
  resources: {
    cpuCores: 0.25,
    ramMiB: 256,
    storageMiB: 768,
  },
  accelerators: {
    required: [],
    optional: [],
    preference: ["cpu"],
  },
  network: {
    ingress: [{ name: "private-api", protocol: "https", port: 8443, public: false }],
    egress: [],
  },
  data: {
    classes: ["user-content", "app-state"],
    volumes: [
      {
        name: "notes",
        mountPath: "/var/lib/vita/notes/content",
        class: "user-content",
        access: "read-write",
        persistence: "persistent",
        backup: true,
        sizeMiB: 512,
      },
      {
        name: "state",
        mountPath: "/var/lib/vita/notes/state",
        class: "app-state",
        access: "read-write",
        persistence: "persistent",
        backup: true,
        sizeMiB: 128,
      },
    ],
  },
  secrets: [],
  backup: {
    strategy: "filesystem-snapshot",
    includeVolumes: ["notes", "state"],
    quiesceHooks: [],
    backupHooks: [],
  },
  restore: {
    requireCleanVerification: true,
    verificationHooks: [],
  },
  healthChecks: [
    {
      name: "service-ready",
      type: "lifecycle",
      target: "service.ready",
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
  exportFormats: ["vita-capsule", "json"],
  endOfSupportDate: "2028-12-31",
  sbom: {
    format: "spdx-json",
    digest: {
      algorithm: "sha256",
      value: "2222222222222222222222222222222222222222222222222222222222222222",
    },
    generatedAt: "2026-06-20T00:00:00.000Z",
  },
  vulnerabilityStatus: {
    status: "clean",
    scannedAt: "2026-06-20T00:10:00.000Z",
    critical: 0,
    high: 0,
    medium: 0,
    low: 0,
  },
  requiredSimulationProfiles: ["low-memory", "offline", "power-loss"],
};

export const notesRequestedCapabilities: readonly CapabilityGrant[] = [
  {
    kind: "data",
    class: "user-content",
    access: "read-write",
    scope: "notes",
  },
  {
    kind: "data",
    class: "app-state",
    access: "read-write",
    scope: "state",
  },
  {
    kind: "network",
    direction: "ingress",
    protocol: "https",
    port: 8443,
    public: false,
  },
];

export const notesManifest: CatalogEntry = {
  package: notesPackageContract,
  signingPublisher: notesPackageContract.signingPublisher,
  signatures: [
    {
      ref: "signature://vita/first-party/notes/1.0.0/sigstore",
      keyRef: "publisher-key://vita/first-party/stable",
      algorithm: "sigstore-bundle",
      digest: {
        algorithm: "sha256",
        value: "3333333333333333333333333333333333333333333333333333333333333333",
      },
      signedAt: "2026-06-20T00:20:00.000Z",
    },
  ],
  sbom: {
    format: "spdx-json",
    ref: "sbom://vita/first-party/notes/1.0.0/spdx",
    digest: notesPackageContract.sbom.digest,
    generatedAt: notesPackageContract.sbom.generatedAt,
  },
  vulnerabilityStatus: notesPackageContract.vulnerabilityStatus,
  endOfSupport: notesPackageContract.endOfSupportDate,
  digest: notesPackageContract.digest,
  trustTier: "verified",
};

export const packageContract = notesPackageContract;
export const requestedCapabilities = notesRequestedCapabilities;
export const manifest = notesManifest;

export default notesManifest;
