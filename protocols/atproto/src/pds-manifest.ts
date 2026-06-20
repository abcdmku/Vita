import type { PackageContract } from "../../../sdk/manifests/src/package-contract.ts";

export interface PdsStorageVolumeConfig {
  readonly name: string;
  readonly sizeMiB: number;
  readonly mountPath?: string;
}

export interface PdsConfig {
  readonly handle: string;
  readonly domain: string;
  readonly publicAccess: boolean;
  readonly storageVolume: PdsStorageVolumeConfig;
}

const PDS_VERSION = "0.1.0";
const PDS_DIGEST =
  "6f8a95644c9f52f0b34fd8310c3df01b4d8e29e85d1b7a70d3db9f3f7c0f8a51";
const PDS_SBOM_DIGEST =
  "92c4f7e8a0657298f85ba8f5156ef0cb6dcbe22b2f96283af64d01b8a72f7f45";
const DEFAULT_STORAGE_MOUNT = "/pds";

export const defaultPdsConfig: PdsConfig = {
  handle: "owner.example.com",
  domain: "pds.example.com",
  publicAccess: true,
  storageVolume: {
    name: "pds-data",
    sizeMiB: 10240,
    mountPath: DEFAULT_STORAGE_MOUNT,
  },
};

export const pdsManifest: PackageContract = buildPdsManifest(defaultPdsConfig);

export function buildPdsManifest(config: PdsConfig): PackageContract {
  const storageVolume = config.storageVolume ?? ({} as PdsStorageVolumeConfig);

  return {
    packageClass: "oci-service",
    identity: {
      id: "org.atproto.pds",
      name: "AT Protocol PDS",
      description: `Personal Data Server for ${config.handle} at ${config.domain}.`,
    },
    signingPublisher: {
      id: "vita.first-party",
      signingKeyRef: "publisher-key://vita/first-party/stable",
    },
    version: PDS_VERSION,
    digest: {
      algorithm: "sha256",
      value: PDS_DIGEST,
    },
    architectures: ["x86_64", "arm64"],
    resources: {
      cpuCores: 2,
      ramMiB: 2048,
      storageMiB: storageVolume.sizeMiB,
    },
    accelerators: {
      required: [],
      optional: [],
      preference: ["cpu"],
    },
    network: {
      ingress: [
        {
          name: "pds-public-api",
          protocol: "https",
          port: 443,
          public: config.publicAccess,
        },
      ],
      egress: [
        {
          name: "atproto-federation",
          protocol: "https",
          destinations: ["*.atproto.com", "*.bsky.network"],
          ports: [443],
        },
      ],
    },
    data: {
      classes: ["user-content", "app-state", "configuration", "logs"],
      volumes: [
        {
          name: storageVolume.name,
          mountPath: storageVolume.mountPath ?? DEFAULT_STORAGE_MOUNT,
          class: "user-content",
          access: "read-write",
          persistence: "persistent",
          backup: true,
          sizeMiB: storageVolume.sizeMiB,
        },
      ],
    },
    secrets: [
      {
        name: "pds-jwt-secret",
        ref: "secret://atproto/pds/jwt-secret",
        purpose: "Signs AT Protocol PDS user sessions.",
      },
      {
        name: "pds-plc-rotation-key",
        ref: "secret://atproto/pds/plc-rotation-key",
        purpose: "References the DID PLC rotation key without embedding secret material.",
      },
    ],
    backup: {
      strategy: "application-consistent",
      includeVolumes: [storageVolume.name],
      quiesceHooks: [
        {
          name: "quiesce-repositories",
          entrypoint: "pds.hooks.quiesceRepositories",
          timeoutSeconds: 60,
        },
      ],
      backupHooks: [
        {
          name: "snapshot-repositories",
          entrypoint: "pds.hooks.snapshotRepositories",
          timeoutSeconds: 120,
        },
      ],
    },
    restore: {
      requireCleanVerification: true,
      verificationHooks: [
        {
          name: "verify-repository-indexes",
          entrypoint: "pds.hooks.verifyRepositoryIndexes",
          timeoutSeconds: 120,
        },
      ],
    },
    healthChecks: [
      {
        name: "pds-health",
        type: "http",
        target: "/_health",
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
    exportFormats: ["vita-capsule", "tar.zst", "json", "sqlite-dump"],
    endOfSupportDate: "2029-12-31",
    sbom: {
      format: "spdx-json",
      digest: {
        algorithm: "sha256",
        value: PDS_SBOM_DIGEST,
      },
      generatedAt: "2026-06-20T00:00:00.000Z",
    },
    vulnerabilityStatus: {
      status: "scan-pending",
      critical: 0,
      high: 0,
      medium: 0,
      low: 0,
    },
    requiredSimulationProfiles: [
      "baseline-x86_64",
      "baseline-arm64",
      "offline",
      "low-memory",
      "network-partition",
      "backup-restore",
      "x86_64-to-arm64-migration",
    ],
  };
}
