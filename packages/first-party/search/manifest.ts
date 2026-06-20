import type { CatalogEntry } from "../../catalog/src/catalog-entry.ts";
import type { PackageContract } from "../../../sdk/manifests/src/package-contract.ts";
import type { CapabilityGrant } from "../../../runtime/permission-broker/src/grants.ts";

export const searchPackageContract: PackageContract = {
  packageClass: "ts-service",
  identity: {
    id: "com.vita.search",
    name: "Vita Search",
    description: "First-party Deno local search service.",
  },
  signingPublisher: {
    id: "vita.first-party",
    signingKeyRef: "publisher-key://vita/first-party/stable",
  },
  version: "1.0.0",
  digest: {
    algorithm: "sha256",
    value: "4444444444444444444444444444444444444444444444444444444444444444",
  },
  architectures: ["x86_64", "arm64"],
  resources: {
    cpuCores: 0.5,
    ramMiB: 512,
    storageMiB: 1536,
  },
  accelerators: {
    required: [],
    optional: [],
    preference: ["cpu"],
  },
  network: {
    ingress: [{ name: "private-api", protocol: "https", port: 8444, public: false }],
    egress: [],
  },
  data: {
    classes: ["user-content", "cache"],
    volumes: [
      {
        name: "user-content-source",
        mountPath: "/mnt/vita/user-content",
        class: "user-content",
        access: "read-only",
        persistence: "persistent",
        backup: false,
        sizeMiB: 1,
      },
      {
        name: "index-cache",
        mountPath: "/var/cache/vita-search",
        class: "cache",
        access: "read-write",
        persistence: "ephemeral",
        backup: false,
        sizeMiB: 1024,
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
    requiresFreshBackup: false,
  },
  exportFormats: ["json"],
  endOfSupportDate: "2028-12-31",
  sbom: {
    format: "spdx-json",
    digest: {
      algorithm: "sha256",
      value: "5555555555555555555555555555555555555555555555555555555555555555",
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
  requiredSimulationProfiles: ["low-memory", "offline", "no-accelerator"],
};

export const searchRequestedCapabilities: readonly CapabilityGrant[] = [
  {
    kind: "data",
    class: "user-content",
    access: "read-only",
    scope: "user-content-source",
  },
  {
    kind: "data",
    class: "cache",
    access: "read-write",
    scope: "index-cache",
  },
  {
    kind: "network",
    direction: "ingress",
    protocol: "https",
    port: 8444,
    public: false,
  },
];

export const searchManifest: CatalogEntry = {
  package: searchPackageContract,
  signingPublisher: searchPackageContract.signingPublisher,
  signatures: [
    {
      ref: "signature://vita/first-party/search/1.0.0/sigstore",
      keyRef: "publisher-key://vita/first-party/stable",
      algorithm: "sigstore-bundle",
      digest: {
        algorithm: "sha256",
        value: "6666666666666666666666666666666666666666666666666666666666666666",
      },
      signedAt: "2026-06-20T00:20:00.000Z",
    },
  ],
  sbom: {
    format: "spdx-json",
    ref: "sbom://vita/first-party/search/1.0.0/spdx",
    digest: searchPackageContract.sbom.digest,
    generatedAt: searchPackageContract.sbom.generatedAt,
  },
  vulnerabilityStatus: searchPackageContract.vulnerabilityStatus,
  endOfSupport: searchPackageContract.endOfSupportDate,
  digest: searchPackageContract.digest,
  trustTier: "verified",
};

export const packageContract = searchPackageContract;
export const requestedCapabilities = searchRequestedCapabilities;
export const manifest = searchManifest;

export default searchManifest;
