import { types as nodeTypes } from "node:util";

import { validatePackageContract } from "../../../sdk/manifests/src/package-contract.ts";
import { coversRequiredProfiles } from "../../../simulation/profiles/src/profiles.ts";
import { validateCapsule } from "../../../storage/capsules/src/capsule.ts";
import { diffPlans } from "../../../sdk/typescript/src/diff.ts";
import { explainPlan } from "../../../sdk/typescript/src/explain.ts";
import { isCanonicalPlan, normalize } from "../../../sdk/typescript/src/plan.ts";
import { validatePlan } from "../../../sdk/typescript/src/validate.ts";
import { decideGrants } from "../../../runtime/permission-broker/src/decide.ts";
import type {
  DeviceArchitecture,
  DeviceSnapshot,
} from "../../../sdk/typescript/src/capabilities.ts";
import type {
  PackageContract,
  PackageContractValidationResult,
} from "../../../sdk/manifests/src/package-contract.ts";
import type { SimulationProfileKind } from "../../../simulation/profiles/src/profiles.ts";
import type {
  Capsule,
  CapsulePolicy,
  CapsuleValidationResult,
} from "../../../storage/capsules/src/capsule.ts";
import type { CanonicalPlan, DesiredState } from "../../../sdk/typescript/src/plan.ts";
import type {
  BrokerPolicy,
  CapabilityDenial,
  CapabilityGrant,
  RequestedCapability,
} from "../../../runtime/permission-broker/src/grants.ts";
import type {
  AppInstallPreviewRequest,
  AppInstallPreviewResponse,
  AppSummary,
  AppSummaryResponse,
  BackupProtectionState,
  BackupStatusResponse,
  CapsuleImportPreviewRequest,
  CapsuleImportPreviewResponse,
  ControllerApi,
  ControllerApiDispatchRequest,
  ControllerApiDispatchResult,
  ControllerApiError,
  EmptyParams,
  GetBackupStatusRequest,
  GetIdentitySummaryRequest,
  GetOverviewRequest,
  GetStorageOverviewRequest,
  HealthSummary,
  IdentitySummaryResponse,
  ListAppsRequest,
  NonBackupProtectionState,
  NodeCapabilitySummary,
  NodeHealthRequest,
  NodeHealthResponse,
  NodeHealthStatus,
  OverviewResponse,
  PlanPreviewRequest,
  PlanPreviewResponse,
  ProtectionSummary,
  StorageOverviewResponse,
} from "./contracts.ts";

type JsonRecord = Readonly<Record<string, unknown>>;
type Plain = null | boolean | number | string | Plain[] | { [key: string]: Plain };
type PlainObject = { [key: string]: Plain };
type SnapshotResult =
  | {
      readonly ok: true;
      readonly value: Plain;
    }
  | {
      readonly ok: false;
      readonly message: string;
      readonly path: string;
    };
type NodeProtectionState = "protected" | "warning" | "unprotected";

interface InMemoryNode {
  readonly nodeId: string;
  readonly status: NodeHealthStatus;
  readonly uptimeSeconds: number;
  readonly protection: NodeProtectionState;
  readonly publicServices: number;
  readonly privateServices: number;
  readonly blockedRequests24h: number;
  readonly device: DeviceSnapshot;
}

export interface InMemoryControllerOptions {
  readonly currentPlan?: CanonicalPlan;
  readonly deviceSnapshot?: DeviceSnapshot;
}

const EMPTY_PARAMS: EmptyParams = Object.freeze({});
const MAX_SNAPSHOT_DEPTH = 64;
const MAX_SNAPSHOT_ITEMS = 10_000;
const POLICY_SHAPE_PROBE_CAPABILITY: RequestedCapability = Object.freeze({
  kind: "unknown",
  name: "policy-shape-probe",
});
const CAPSULE_IMPORT_PARAM_FIELDS = new Set(["capsule", "targetArch", "policy"]);
const SHADOWABLE_ARRAY_METHODS = new Set([
  "some",
  "includes",
  "find",
  "forEach",
  "map",
  "filter",
  "every",
  "reduce",
]);

const SNAPSHOT_PROTECTION: NonBackupProtectionState = Object.freeze({
  level: "snapshot",
  protectionLevel: "snapshot",
  backupClass: "not-backup",
  isBackup: false,
  description: "Read-only local snapshots for file and version recovery.",
});

const MIRROR_PROTECTION: NonBackupProtectionState = Object.freeze({
  level: "mirror",
  protectionLevel: "mirror",
  backupClass: "not-backup",
  isBackup: false,
  description: "Live mirror for availability; not a backup.",
});

const LOCAL_BACKUP_PROTECTION: BackupProtectionState = Object.freeze({
  level: "local-backup",
  protectionLevel: "local-backup",
  backupClass: "backup",
  isBackup: true,
  description: "Independent attached-disk backup for node restore.",
});

const OFF_SITE_BACKUP_PROTECTION: BackupProtectionState = Object.freeze({
  level: "off-site-backup",
  protectionLevel: "off-site-backup",
  backupClass: "backup",
  isBackup: true,
  description: "Encrypted off-site backup for complete node loss.",
});

const DEFAULT_APPS: readonly AppSummary[] = [
  {
    id: "com.vita.notes",
    version: "1.2.3",
    status: "available",
  },
  {
    id: "atproto-pds",
    version: "1.0.0",
    status: "installed",
  },
];

const DEFAULT_DEVICE_SNAPSHOT: DeviceSnapshot = Object.freeze({
  memoryGB: 32,
  architecture: "x86_64",
  accelerators: Object.freeze([
    Object.freeze({
      kind: "intel.npu",
      generation: "core-ultra",
    }),
    Object.freeze({
      kind: "nvidia.cuda",
      memoryGB: 12,
      compute: "8.6",
    }),
  ]),
  tpm: Object.freeze({
    present: true,
    version: "2.0",
    sealedKeyUnlock: true,
  }),
  virtualization: Object.freeze({
    hardware: true,
    nested: false,
  }),
  storage: Object.freeze({
    bootGB: 128,
    dataGB: 2048,
  }),
  networking: Object.freeze({
    ethernet: true,
    wifi: true,
  }),
});

const DEFAULT_NODE_ID = "node-1";

export function createInMemoryControllerApi(
  options: InMemoryControllerOptions = {},
): ControllerApi {
  const deviceSnapshot = options.deviceSnapshot ?? DEFAULT_DEVICE_SNAPSHOT;
  const nodes = [defaultNode(deviceSnapshot)];
  const fallbackCurrentPlan = options.currentPlan ?? normalize({});

  return {
    getOverview: () => overviewFromNodes(nodes),
    getStorageOverview: () => storageOverview(),
    getBackupStatus: () => backupStatus(),
    getIdentitySummary: () => identitySummary(),
    getNodeHealth: (params) => nodeHealthFromNodes(params, nodes, deviceSnapshot),
    previewPlan: (params) => previewPlan(params, deviceSnapshot, fallbackCurrentPlan),
    listApps: () => listApps(),
    previewAppInstall: (params) => previewAppInstall(params),
    previewCapsuleImport: (params) => previewCapsuleImport(params),
  };
}

export function dispatchControllerRequest(
  api: ControllerApi,
  request: ControllerApiDispatchRequest,
): ControllerApiDispatchResult {
  try {
    switch (request.method) {
      case "getOverview":
        readOverviewParams(request.params);
        return {
          ok: true,
          method: "getOverview",
          response: api.getOverview(),
        };
      case "getStorageOverview":
        readStorageOverviewParams(request.params);
        return {
          ok: true,
          method: "getStorageOverview",
          response: api.getStorageOverview(),
        };
      case "getBackupStatus":
        readBackupStatusParams(request.params);
        return {
          ok: true,
          method: "getBackupStatus",
          response: api.getBackupStatus(),
        };
      case "getIdentitySummary":
        readIdentitySummaryParams(request.params);
        return {
          ok: true,
          method: "getIdentitySummary",
          response: api.getIdentitySummary(),
        };
      case "getNodeHealth":
        return {
          ok: true,
          method: "getNodeHealth",
          response: api.getNodeHealth(readNodeHealthParams(request.params)),
        };
      case "previewPlan":
        return {
          ok: true,
          method: "previewPlan",
          response: api.previewPlan(readPlanPreviewParams(request.params)),
        };
      case "listApps":
        readListAppsParams(request.params);
        return {
          ok: true,
          method: "listApps",
          response: api.listApps(),
        };
      case "previewAppInstall":
        return {
          ok: true,
          method: "previewAppInstall",
          response: api.previewAppInstall(readAppInstallPreviewParams(request.params)),
        };
      case "previewCapsuleImport":
        return {
          ok: true,
          method: "previewCapsuleImport",
          response: api.previewCapsuleImport(readCapsuleImportPreviewParams(request.params)),
        };
      default:
        return dispatchError("UNKNOWN_METHOD", `Unknown controller API method: ${request.method}`);
    }
  } catch (error) {
    return dispatchError(
      "INVALID_PARAMS",
      error instanceof Error ? error.message : "Invalid controller API request parameters.",
    );
  }
}

function listApps(): AppSummaryResponse {
  return {
    apps: DEFAULT_APPS,
  };
}

function storageOverview(): StorageOverviewResponse {
  const poolCapacity = Object.freeze({
    totalGiB: 2_048,
    usedGiB: 768,
    availableGiB: 1_280,
  });
  const dataCapacity = Object.freeze({
    totalGiB: 1_792,
    usedGiB: 704,
    availableGiB: 1_088,
  });
  const appCapacity = Object.freeze({
    totalGiB: 256,
    usedGiB: 64,
    availableGiB: 192,
  });

  return Object.freeze({
    summary: Object.freeze({
      health: "healthy",
      capacity: poolCapacity,
      encryptedVolumes: 2,
      snapshotProtectedVolumes: 2,
      mirrorProtectedVolumes: 1,
      backupProtectedVolumes: 2,
      unprotectedVolumes: 0,
    }),
    pools: Object.freeze([
      Object.freeze({
        id: "pool-primary",
        label: "Primary data pool",
        health: "healthy",
        capacity: poolCapacity,
        encryptionState: "encrypted",
        protectionStates: Object.freeze([
          SNAPSHOT_PROTECTION,
          MIRROR_PROTECTION,
          LOCAL_BACKUP_PROTECTION,
          OFF_SITE_BACKUP_PROTECTION,
        ]),
      }),
    ]),
    volumes: Object.freeze([
      Object.freeze({
        id: "volume-data",
        poolId: "pool-primary",
        label: "Authoritative data",
        mountPath: "/data",
        health: "healthy",
        capacity: dataCapacity,
        encryptionState: "encrypted",
        snapshotCadence: "hourly",
        protectionStates: Object.freeze([
          SNAPSHOT_PROTECTION,
          MIRROR_PROTECTION,
          LOCAL_BACKUP_PROTECTION,
          OFF_SITE_BACKUP_PROTECTION,
        ]),
      }),
      Object.freeze({
        id: "volume-app-state",
        poolId: "pool-primary",
        label: "Application state",
        mountPath: "/var/lib/vita/apps",
        health: "healthy",
        capacity: appCapacity,
        encryptionState: "encrypted",
        snapshotCadence: "daily",
        protectionStates: Object.freeze([
          SNAPSHOT_PROTECTION,
          LOCAL_BACKUP_PROTECTION,
          OFF_SITE_BACKUP_PROTECTION,
        ]),
      }),
    ]),
  });
}

function backupStatus(): BackupStatusResponse {
  return Object.freeze({
    summary: Object.freeze({
      backupTargetCount: 2,
      healthyTargets: 2,
      restoreTestsPassing: 2,
      lastSuccessfulBackupAt: "2026-06-20T04:15:00.000Z",
    }),
    targets: Object.freeze([
      Object.freeze({
        id: "backup-attached-disk",
        label: "Attached recovery disk",
        targetKind: "attached-disk",
        enabled: true,
        schedule: "daily",
        protectionState: LOCAL_BACKUP_PROTECTION,
        lastRun: Object.freeze({
          result: "succeeded",
          finishedAt: "2026-06-20T04:15:00.000Z",
        }),
        nextRunAt: "2026-06-21T04:15:00.000Z",
        lastRestoreTest: Object.freeze({
          result: "passed",
          testedAt: "2026-06-19T12:00:00.000Z",
        }),
      }),
      Object.freeze({
        id: "backup-remote-object",
        label: "Remote encrypted object target",
        targetKind: "remote-object",
        enabled: true,
        schedule: "daily",
        protectionState: OFF_SITE_BACKUP_PROTECTION,
        lastRun: Object.freeze({
          result: "succeeded",
          finishedAt: "2026-06-20T04:10:00.000Z",
        }),
        nextRunAt: "2026-06-21T04:10:00.000Z",
        lastRestoreTest: Object.freeze({
          result: "passed",
          testedAt: "2026-06-18T12:00:00.000Z",
        }),
      }),
    ]),
    nonBackupProtection: Object.freeze([
      Object.freeze({
        id: "snapshot-local",
        label: "Local snapshots",
        protectionState: SNAPSHOT_PROTECTION,
      }),
      Object.freeze({
        id: "mirror-primary",
        label: "Primary pool mirror",
        protectionState: MIRROR_PROTECTION,
      }),
    ]),
  });
}

function identitySummary(): IdentitySummaryResponse {
  return Object.freeze({
    roles: Object.freeze([
      Object.freeze({
        role: "owner",
        principalCount: 1,
      }),
      Object.freeze({
        role: "administrator",
        principalCount: 1,
      }),
      Object.freeze({
        role: "member",
        principalCount: 2,
      }),
      Object.freeze({
        role: "restricted-member",
        principalCount: 1,
      }),
      Object.freeze({
        role: "guest",
        principalCount: 0,
      }),
      Object.freeze({
        role: "service",
        principalCount: 3,
      }),
    ]),
    passkeys: Object.freeze({
      required: true,
      state: "partial",
      enrolledPrincipals: 4,
      unenrolledPrincipals: 1,
    }),
    auditLog: Object.freeze({
      available: true,
      retentionDays: 365,
      lastEventAt: "2026-06-20T10:00:00.000Z",
    }),
  });
}

function previewAppInstall(params: AppInstallPreviewRequest): AppInstallPreviewResponse {
  try {
    const validation = validatePackageContract(params.packageContract);

    if (!validation.ok) {
      return appPreviewError(
        validation,
        [],
        [],
        reasonsFromValidation(validation),
        "VALIDATION_FAILED",
        "Package contract failed validation.",
      );
    }

    const policyValidation = validatePolicyShape(validation.contract, params.policy);

    if (!policyValidation.ok) {
      return appPreviewError(
        validation,
        [],
        [],
        policyValidation.reasons,
        "INVALID_PARAMS",
        "Broker policy or package input is malformed.",
      );
    }

    const capabilities = capabilitiesFromPackageContract(validation.contract);
    const decision = decideGrants(
      {
        packageContract: validation.contract,
        capabilities,
      },
      params.policy,
    );
    const reasons = reasonsFromDenials(decision.denied);

    if (decision.denied.length > 0) {
      const malformedDenial = firstInputMalformedDenial(decision.denied);

      return appPreviewError(
        validation,
        decision.granted,
        decision.denied,
        reasons,
        malformedDenial === undefined ? "CAPABILITY_DENIED" : "INVALID_PARAMS",
        malformedDenial?.reason ?? "Package capabilities exceed broker policy.",
      );
    }

    return {
      ok: true,
      validation,
      grantedCapabilities: decision.granted,
      deniedCapabilities: [],
      reasons: [],
    };
  } catch {
    const validation = packageValidationFailure("Install preview failed closed.");

    return appPreviewError(
      validation,
      [],
      [],
      ["Install preview failed closed."],
      "INVALID_PARAMS",
      "Install preview failed closed.",
    );
  }
}

function previewCapsuleImport(params: CapsuleImportPreviewRequest): CapsuleImportPreviewResponse {
  try {
    const safeParams = readCapsuleImportPreviewParams(params);
    const validation = validateCapsule(safeParams.capsule);

    if (!validation.ok) {
      return capsulePreviewError(
        validation,
        safeParams.targetArch,
        false,
        reasonsFromCapsuleValidation(validation),
        [],
        [],
        [],
        [],
        "VALIDATION_FAILED",
        "Capsule failed validation.",
      );
    }

    const capsule = validation.capsule;
    const migration = migrationReadiness(capsule, safeParams.targetArch);
    const coverage = coversRequiredProfiles(
      capsule.simulation.requiredProfiles as readonly SimulationProfileKind[],
    );
    const profileReasons = reasonsFromMissingProfiles(coverage.missing);
    const policyValidation = validatePolicyShape(capsule.manifest.package, safeParams.policy);

    if (!policyValidation.ok) {
      return capsulePreviewError(
        validation,
        safeParams.targetArch,
        migration.migratable,
        [...migration.reasons, ...profileReasons, ...policyValidation.reasons],
        migration.reasons,
        coverage.missing,
        [],
        [],
        "INVALID_PARAMS",
        "Destination broker policy is malformed.",
      );
    }

    const decision = decideGrants(
      {
        packageContract: capsule.manifest.package,
        capabilities: capabilitiesFromCapsulePolicy(capsule.policy),
      },
      safeParams.policy,
    );
    const denialReasons = reasonsFromDenials(decision.denied);
    const reasons = [...migration.reasons, ...profileReasons, ...denialReasons];
    const malformedDenial = firstInputMalformedDenial(decision.denied);

    if (!migration.migratable || !coverage.ok || decision.denied.length > 0) {
      return capsulePreviewError(
        validation,
        safeParams.targetArch,
        migration.migratable,
        reasons,
        migration.reasons,
        coverage.missing,
        decision.granted,
        decision.denied,
        malformedDenial === undefined
          ? decision.denied.length > 0
            ? "CAPABILITY_DENIED"
            : "VALIDATION_FAILED"
          : "INVALID_PARAMS",
        malformedDenial?.reason ?? capsulePreviewFailureMessage(migration.migratable, coverage.ok),
      );
    }

    return {
      ok: true,
      validation,
      targetArch: safeParams.targetArch,
      migratable: true,
      migrationReasons: [],
      missingProfiles: [],
      grantedCapabilities: decision.granted,
      deniedCapabilities: [],
      reasons: [],
    };
  } catch {
    const validation = capsuleValidationFailure("Capsule import preview failed closed.");

    return capsulePreviewError(
      validation,
      undefined,
      false,
      ["Capsule import preview failed closed."],
      ["Capsule import preview failed closed."],
      [],
      [],
      [],
      "INVALID_PARAMS",
      "Capsule import preview failed closed.",
    );
  }
}

function previewPlan(
  params: PlanPreviewRequest,
  deviceSnapshot: DeviceSnapshot,
  fallbackCurrentPlan: CanonicalPlan,
): PlanPreviewResponse {
  const validation = validatePlan(params.desiredState, deviceSnapshot);

  if (!validation.ok) {
    return {
      ok: false,
      validation,
      error: {
        code: "VALIDATION_FAILED",
        message: "Desired state failed plan validation.",
      },
    };
  }

  try {
    const desiredPlan = normalize(params.desiredState);
    const currentPlan = params.currentPlan ?? fallbackCurrentPlan;
    const diff = diffPlans(currentPlan, desiredPlan);
    const explanation = explainPlan(desiredPlan);

    return {
      ok: true,
      validation,
      diff,
      explanation,
    };
  } catch (error) {
    return {
      ok: false,
      validation: {
        ok: false,
        errors: [
          {
            path: "",
            message: error instanceof Error ? error.message : "Plan preview failed.",
          },
        ],
      },
      error: {
        code: "VALIDATION_FAILED",
        message: "Plan preview failed.",
      },
    };
  }
}

function validatePolicyShape(
  packageContract: PackageContract,
  policy: BrokerPolicy,
):
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly reasons: readonly string[];
    } {
  const decision = decideGrants(
    {
      packageContract,
      capabilities: [POLICY_SHAPE_PROBE_CAPABILITY],
    },
    policy,
  );
  const malformedDenial = firstInputMalformedDenial(decision.denied);

  if (malformedDenial === undefined) {
    return { ok: true };
  }

  return {
    ok: false,
    reasons: [malformedDenial.reason],
  };
}

function migrationReadiness(
  capsule: Capsule,
  targetArch: DeviceArchitecture,
): {
  readonly migratable: boolean;
  readonly reasons: readonly string[];
} {
  const reasons: string[] = [];

  if (!architectureDeclared(capsule.manifest.package.architectures, targetArch)) {
    reasons[reasons.length] =
      `Package contract does not declare target architecture ${targetArch}.`;
  }

  if (!capsule.state.snapshot.architectureNeutral) {
    reasons[reasons.length] =
      "Capsule state snapshot is architecture-specific and cannot be migrated across architectures.";
  }

  if (!runtimeReadyForTarget(capsule, targetArch)) {
    reasons[reasons.length] = `Capsule runtime artifacts do not cover target architecture ${targetArch}.`;
  }

  return {
    migratable: reasons.length === 0,
    reasons,
  };
}

function architectureDeclared(
  architectures: readonly DeviceArchitecture[],
  targetArch: DeviceArchitecture,
): boolean {
  for (let index = 0; index < architectures.length; index += 1) {
    if (architectures[index] === targetArch) {
      return true;
    }
  }

  return false;
}

function runtimeReadyForTarget(capsule: Capsule, targetArch: DeviceArchitecture): boolean {
  switch (capsule.manifest.package.packageClass) {
    case "ts-service":
    case "ts-extension":
    case "ui-extension":
    case "wasm-component":
      return true;
    case "oci-service":
    case "microvm-service":
    case "native-extension":
      return ociRuntimeCoversTarget(capsule, targetArch);
  }

  return false;
}

function ociRuntimeCoversTarget(capsule: Capsule, targetArch: DeviceArchitecture): boolean {
  const indexes = capsule.runtime.ociImageIndexes;

  for (let index = 0; index < indexes.length; index += 1) {
    const imageIndex = indexes[index];

    if (imageIndex === undefined || imageIndex.platforms === undefined) {
      continue;
    }

    for (let platformIndex = 0; platformIndex < imageIndex.platforms.length; platformIndex += 1) {
      const platform = imageIndex.platforms[platformIndex];

      if (platform !== undefined && platform.os === "linux" && platform.architecture === targetArch) {
        return true;
      }
    }
  }

  return false;
}

function capabilitiesFromCapsulePolicy(policy: CapsulePolicy): readonly CapabilityGrant[] {
  const capabilities: CapabilityGrant[] = [];

  for (let index = 0; index < policy.dataGrants.length; index += 1) {
    const grant = policy.dataGrants[index];

    if (grant !== undefined) {
      capabilities[capabilities.length] = {
        kind: "data",
        class: grant.class,
        access: grant.access,
        scope: grant.scope,
      };
    }
  }

  for (let index = 0; index < policy.networkGrants.length; index += 1) {
    const grant = policy.networkGrants[index];

    if (grant === undefined) {
      continue;
    }

    for (let portIndex = 0; portIndex < grant.ports.length; portIndex += 1) {
      const port = grant.ports[portIndex];

      if (port === undefined) {
        continue;
      }

      if (grant.direction === "ingress") {
        capabilities[capabilities.length] = {
          kind: "network",
          direction: "ingress",
          protocol: grant.protocol,
          port,
          public: grant.public === true,
        };
      } else if (grant.destination !== undefined) {
        capabilities[capabilities.length] = {
          kind: "network",
          direction: "egress",
          protocol: grant.protocol,
          destination: grant.destination,
          port,
        };
      }
    }
  }

  return capabilities;
}

function capabilitiesFromPackageContract(contract: PackageContract): readonly CapabilityGrant[] {
  const capabilities: CapabilityGrant[] = [];

  const volumes = contract.data.volumes;
  for (let index = 0; index < volumes.length; index += 1) {
    const volume = volumes[index];

    if (volume !== undefined) {
      capabilities[capabilities.length] = {
        kind: "data",
        class: volume.class,
        access: volume.access,
        scope: volume.name,
      };
    }
  }

  const ingress = contract.network.ingress;
  for (let index = 0; index < ingress.length; index += 1) {
    const rule = ingress[index];

    if (rule !== undefined) {
      capabilities[capabilities.length] = {
        kind: "network",
        direction: "ingress",
        protocol: rule.protocol,
        port: rule.port,
        public: rule.public,
      };
    }
  }

  const egress = contract.network.egress;
  for (let ruleIndex = 0; ruleIndex < egress.length; ruleIndex += 1) {
    const rule = egress[ruleIndex];

    if (rule === undefined) {
      continue;
    }

    for (let destinationIndex = 0; destinationIndex < rule.destinations.length; destinationIndex += 1) {
      const destination = rule.destinations[destinationIndex];

      if (destination === undefined) {
        continue;
      }

      for (let portIndex = 0; portIndex < rule.ports.length; portIndex += 1) {
        const port = rule.ports[portIndex];

        if (port !== undefined) {
          capabilities[capabilities.length] = {
            kind: "network",
            direction: "egress",
            protocol: rule.protocol,
            destination,
            port,
          };
        }
      }
    }
  }

  return capabilities;
}

function firstInputMalformedDenial(
  denials: readonly CapabilityDenial[],
): CapabilityDenial | undefined {
  for (let index = 0; index < denials.length; index += 1) {
    const denial = denials[index];

    if (
      denial !== undefined &&
      (denial.code === "MALFORMED_POLICY" ||
        denial.code === "MALFORMED_REQUEST" ||
        denial.code === "INVALID_PACKAGE_CONTRACT")
    ) {
      return denial;
    }
  }

  return undefined;
}

function reasonsFromValidation(
  validation: Extract<PackageContractValidationResult, { readonly ok: false }>,
): readonly string[] {
  const reasons: string[] = [];

  for (let index = 0; index < validation.errors.length; index += 1) {
    const error = validation.errors[index];

    if (error !== undefined) {
      reasons[reasons.length] =
        error.path === "" ? error.message : `${error.path}: ${error.message}`;
    }
  }

  return reasons;
}

function reasonsFromCapsuleValidation(
  validation: Extract<CapsuleValidationResult, { readonly ok: false }>,
): readonly string[] {
  const reasons: string[] = [];

  for (let index = 0; index < validation.errors.length; index += 1) {
    const error = validation.errors[index];

    if (error !== undefined) {
      reasons[reasons.length] =
        error.path === "" ? error.message : `${error.path}: ${error.message}`;
    }
  }

  return reasons;
}

function reasonsFromDenials(denials: readonly CapabilityDenial[]): readonly string[] {
  const reasons: string[] = [];

  for (let index = 0; index < denials.length; index += 1) {
    const denial = denials[index];

    if (denial !== undefined) {
      reasons[reasons.length] = denial.reason;
    }
  }

  return reasons;
}

function reasonsFromMissingProfiles(
  missing: readonly SimulationProfileKind[],
): readonly string[] {
  const reasons: string[] = [];

  for (let index = 0; index < missing.length; index += 1) {
    const profile = missing[index];

    if (profile !== undefined) {
      reasons[reasons.length] = `Missing required simulation profile: ${profile}.`;
    }
  }

  return reasons;
}

function capsulePreviewFailureMessage(migratable: boolean, covered: boolean): string {
  if (!migratable) {
    return "Capsule is not migratable to the target architecture.";
  }

  if (!covered) {
    return "Capsule is missing required simulation coverage.";
  }

  return "Capsule capabilities exceed the destination broker policy.";
}

function packageValidationFailure(message: string): PackageContractValidationResult {
  return {
    ok: false,
    errors: [
      {
        path: "",
        message,
      },
    ],
  };
}

function capsuleValidationFailure(message: string): CapsuleValidationResult {
  return {
    ok: false,
    errors: [
      {
        path: "",
        message,
      },
    ],
  };
}

function appPreviewError(
  validation: PackageContractValidationResult,
  grantedCapabilities: readonly CapabilityGrant[],
  deniedCapabilities: readonly CapabilityDenial[],
  reasons: readonly string[],
  code: ControllerApiError["code"],
  message: string,
): AppInstallPreviewResponse {
  return {
    ok: false,
    validation,
    grantedCapabilities,
    deniedCapabilities,
    reasons,
    error: {
      code,
      message,
    },
  };
}

function capsulePreviewError(
  validation: CapsuleValidationResult,
  targetArch: DeviceArchitecture | undefined,
  migratable: boolean,
  reasons: readonly string[],
  migrationReasons: readonly string[],
  missingProfiles: readonly SimulationProfileKind[],
  grantedCapabilities: readonly CapabilityGrant[],
  deniedCapabilities: readonly CapabilityDenial[],
  code: ControllerApiError["code"],
  message: string,
): CapsuleImportPreviewResponse {
  return {
    ok: false,
    validation,
    ...(targetArch === undefined ? {} : { targetArch }),
    migratable,
    migrationReasons,
    missingProfiles,
    grantedCapabilities,
    deniedCapabilities,
    reasons,
    error: {
      code,
      message,
    },
  };
}

function overviewFromNodes(nodes: readonly InMemoryNode[]): OverviewResponse {
  return {
    nodeCount: nodes.length,
    health: summarizeHealth(nodes),
    protection: summarizeProtection(nodes),
    exposure: summarizeExposure(nodes),
  };
}

function nodeHealthFromNodes(
  params: NodeHealthRequest,
  nodes: readonly InMemoryNode[],
  fallbackDevice: DeviceSnapshot,
): NodeHealthResponse {
  const node = nodes.find((candidate) => candidate.nodeId === params.nodeId);

  if (node === undefined) {
    return {
      nodeId: params.nodeId,
      status: "offline",
      uptimeSeconds: 0,
      capabilities: capabilitySummary(fallbackDevice),
    };
  }

  return {
    nodeId: node.nodeId,
    status: node.status,
    uptimeSeconds: node.uptimeSeconds,
    capabilities: capabilitySummary(node.device),
  };
}

function summarizeHealth(nodes: readonly InMemoryNode[]): HealthSummary {
  const summary = { healthy: 0, degraded: 0, offline: 0 };

  for (const node of nodes) {
    summary[node.status] += 1;
  }

  return summary;
}

function summarizeProtection(nodes: readonly InMemoryNode[]): ProtectionSummary {
  const summary = { protected: 0, warnings: 0, unprotected: 0 };

  for (const node of nodes) {
    switch (node.protection) {
      case "protected":
        summary.protected += 1;
        break;
      case "warning":
        summary.warnings += 1;
        break;
      case "unprotected":
        summary.unprotected += 1;
        break;
    }
  }

  return summary;
}

function summarizeExposure(nodes: readonly InMemoryNode[]): OverviewResponse["exposure"] {
  const summary = { publicServices: 0, privateServices: 0, blockedRequests24h: 0 };

  for (const node of nodes) {
    summary.publicServices += node.publicServices;
    summary.privateServices += node.privateServices;
    summary.blockedRequests24h += node.blockedRequests24h;
  }

  return summary;
}

function capabilitySummary(device: DeviceSnapshot): NodeCapabilitySummary {
  return {
    memoryGB: device.memoryGB,
    architecture: device.architecture,
    accelerators: device.accelerators,
    tpm: optionalTpmSummary(device),
    virtualization: optionalVirtualizationSummary(device),
  };
}

function optionalTpmSummary(device: DeviceSnapshot): NodeCapabilitySummary["tpm"] {
  return {
    present: device.tpm.present,
    ...(device.tpm.version === undefined ? {} : { version: device.tpm.version }),
    ...(device.tpm.sealedKeyUnlock === undefined
      ? {}
      : { sealedKeyUnlock: device.tpm.sealedKeyUnlock }),
  };
}

function optionalVirtualizationSummary(
  device: DeviceSnapshot,
): NodeCapabilitySummary["virtualization"] {
  return {
    hardware: device.virtualization.hardware,
    ...(device.virtualization.nested === undefined ? {} : { nested: device.virtualization.nested }),
  };
}

function defaultNode(device: DeviceSnapshot): InMemoryNode {
  return {
    nodeId: DEFAULT_NODE_ID,
    status: "healthy",
    uptimeSeconds: 86_400,
    protection: "protected",
    publicServices: 1,
    privateServices: 3,
    blockedRequests24h: 12,
    device,
  };
}

function readOverviewParams(params: unknown): GetOverviewRequest {
  return readEmptyParams(params, "getOverview");
}

function readStorageOverviewParams(params: unknown): GetStorageOverviewRequest {
  return readEmptyParams(params, "getStorageOverview");
}

function readBackupStatusParams(params: unknown): GetBackupStatusRequest {
  return readEmptyParams(params, "getBackupStatus");
}

function readIdentitySummaryParams(params: unknown): GetIdentitySummaryRequest {
  return readEmptyParams(params, "getIdentitySummary");
}

function readListAppsParams(params: unknown): ListAppsRequest {
  return readEmptyParams(params, "listApps");
}

function readEmptyParams(params: unknown, method: string): EmptyParams {
  if (params === undefined) {
    return EMPTY_PARAMS;
  }

  if (!isRecord(params)) {
    throw new TypeError(`${method} params must be a plain object when provided.`);
  }

  rejectUnknownParams(params, new Set<string>(), method);
  return EMPTY_PARAMS;
}

function readNodeHealthParams(params: unknown): NodeHealthRequest {
  if (!isRecord(params)) {
    throw new TypeError("getNodeHealth params must be an object.");
  }

  rejectUnknownParams(params, new Set(["nodeId"]), "getNodeHealth");

  if (typeof params.nodeId !== "string" || params.nodeId === "") {
    throw new TypeError("getNodeHealth params.nodeId must be a non-empty string.");
  }

  return {
    nodeId: params.nodeId,
  };
}

function readPlanPreviewParams(params: unknown): PlanPreviewRequest {
  if (!isRecord(params)) {
    throw new TypeError("previewPlan params must be an object.");
  }

  rejectUnknownParams(params, new Set(["desiredState", "currentPlan"]), "previewPlan");

  if (!Object.prototype.hasOwnProperty.call(params, "desiredState")) {
    throw new TypeError("previewPlan params.desiredState is required.");
  }

  const desiredState = params.desiredState as DesiredState;
  const currentPlan = params.currentPlan;

  if (currentPlan === undefined) {
    return { desiredState };
  }

  if (!isCanonicalPlan(currentPlan)) {
    throw new TypeError("previewPlan params.currentPlan must be a canonical plan.");
  }

  return {
    desiredState,
    currentPlan,
  };
}

function readAppInstallPreviewParams(params: unknown): AppInstallPreviewRequest {
  if (!isRecord(params)) {
    throw new TypeError("previewAppInstall params must be an object.");
  }

  rejectUnknownParams(params, new Set(["packageContract", "policy"]), "previewAppInstall");

  if (!Object.prototype.hasOwnProperty.call(params, "packageContract")) {
    throw new TypeError("previewAppInstall params.packageContract is required.");
  }

  if (!Object.prototype.hasOwnProperty.call(params, "policy")) {
    throw new TypeError("previewAppInstall params.policy is required.");
  }

  return params as unknown as AppInstallPreviewRequest;
}

function readCapsuleImportPreviewParams(params: unknown): CapsuleImportPreviewRequest {
  const snapshot = snapshotPlain(params, [], new WeakSet<object>(), 0);

  if (!snapshot.ok) {
    throw new TypeError(
      snapshot.path === ""
        ? `previewCapsuleImport params are malformed: ${snapshot.message}`
        : `previewCapsuleImport params.${snapshot.path} is malformed: ${snapshot.message}`,
    );
  }

  if (!isPlainObject(snapshot.value)) {
    throw new TypeError("previewCapsuleImport params must be an object.");
  }

  rejectUnknownParams(snapshot.value, CAPSULE_IMPORT_PARAM_FIELDS, "previewCapsuleImport");

  if (!Object.hasOwn(snapshot.value, "capsule")) {
    throw new TypeError("previewCapsuleImport params.capsule is required.");
  }

  if (!Object.hasOwn(snapshot.value, "targetArch")) {
    throw new TypeError("previewCapsuleImport params.targetArch is required.");
  }

  if (!Object.hasOwn(snapshot.value, "policy")) {
    throw new TypeError("previewCapsuleImport params.policy is required.");
  }

  if (!isDeviceArchitecture(snapshot.value.targetArch)) {
    throw new TypeError("previewCapsuleImport params.targetArch must be x86_64 or arm64.");
  }

  return {
    capsule: snapshot.value.capsule as unknown as Capsule,
    targetArch: snapshot.value.targetArch,
    policy: snapshot.value.policy as unknown as BrokerPolicy,
  };
}

function rejectUnknownParams(
  params: JsonRecord,
  allowed: ReadonlySet<string>,
  method: string,
): void {
  for (const key of Object.keys(params)) {
    if (!allowed.has(key)) {
      throw new TypeError(`${method} params.${key} is not a known field.`);
    }
  }
}

function snapshotPlain(
  value: unknown,
  path: readonly string[],
  seen: WeakSet<object>,
  depth: number,
): SnapshotResult {
  if (depth > MAX_SNAPSHOT_DEPTH) {
    return snapshotFailure(path, "Maximum validation depth exceeded.");
  }

  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return { ok: true, value };
  }

  if (typeof value === "number") {
    return Number.isFinite(value)
      ? { ok: true, value }
      : snapshotFailure(path, "Expected finite number.");
  }

  if (typeof value !== "object") {
    return snapshotFailure(path, "Expected JSON-compatible value.");
  }

  if (nodeTypes.isProxy(value) || seen.has(value)) {
    return snapshotFailure(path, "Expected acyclic plain data.");
  }

  const isArray = Array.isArray(value);
  const prototype = stableSnapshotPrototype(value);

  if (
    prototype === undefined ||
    (isArray && prototype !== Array.prototype) ||
    (!isArray && prototype !== Object.prototype && prototype !== null)
  ) {
    return snapshotFailure(path, "Expected plain object or array.");
  }

  const keys = stableSnapshotKeys(value);

  if (keys === undefined) {
    return snapshotFailure(path, "Could not safely inspect value.");
  }

  if (keys.length > MAX_SNAPSHOT_ITEMS + 1) {
    return snapshotFailure(path, "Too many fields.");
  }

  seen.add(value);
  try {
    return isArray
      ? snapshotArray(value as readonly unknown[], keys, path, seen, depth)
      : snapshotObject(value, keys, path, seen, depth);
  } finally {
    seen.delete(value);
  }
}

function snapshotArray(
  value: readonly unknown[],
  keys: readonly PropertyKey[],
  path: readonly string[],
  seen: WeakSet<object>,
  depth: number,
): SnapshotResult {
  const length = stableSnapshotLength(value);

  if (length === undefined || length > MAX_SNAPSHOT_ITEMS) {
    return snapshotFailure(path, "Could not safely inspect array.");
  }

  for (let index = 0; index < keys.length; index += 1) {
    const key = keys[index];

    if (key === "length") {
      continue;
    }

    if (typeof key !== "string") {
      return snapshotFailure([...path, String(key)], "Symbol properties are not allowed.");
    }

    if (SHADOWABLE_ARRAY_METHODS.has(key)) {
      return snapshotFailure([...path, key], "Array method shadowing is not allowed.");
    }

    if (!arrayIndexKey(key)) {
      return snapshotFailure([...path, key], "Array extra properties are not allowed.");
    }
  }

  const clone: Plain[] = [];

  for (let index = 0; index < length; index += 1) {
    const key = String(index);

    if (stableSnapshotOwn(value, key) !== true) {
      return snapshotFailure([...path, key], "Sparse arrays are not allowed.");
    }

    const child = stableSnapshotData(value, key);

    if (!child.ok) {
      return snapshotFailure([...path, key], "Could not safely read value.");
    }

    const childSnapshot = snapshotPlain(child.value, [...path, key], seen, depth + 1);

    if (!childSnapshot.ok) {
      return childSnapshot;
    }

    clone[index] = childSnapshot.value;
  }

  return {
    ok: true,
    value: clone,
  };
}

function snapshotObject(
  value: object,
  keys: readonly PropertyKey[],
  path: readonly string[],
  seen: WeakSet<object>,
  depth: number,
): SnapshotResult {
  if (keys.length > MAX_SNAPSHOT_ITEMS) {
    return snapshotFailure(path, "Too many fields.");
  }

  const clone = Object.create(null) as PlainObject;

  for (let index = 0; index < keys.length; index += 1) {
    const key = keys[index];

    if (typeof key !== "string") {
      return snapshotFailure([...path, String(key)], "Symbol properties are not allowed.");
    }

    const child = stableSnapshotData(value, key);

    if (!child.ok) {
      return snapshotFailure([...path, key], "Could not safely read value.");
    }

    const childSnapshot = snapshotPlain(child.value, [...path, key], seen, depth + 1);

    if (!childSnapshot.ok) {
      return childSnapshot;
    }

    clone[key] = childSnapshot.value;
  }

  return {
    ok: true,
    value: clone,
  };
}

function stableSnapshotPrototype(value: object): object | null | undefined {
  try {
    const first = Object.getPrototypeOf(value);
    const second = Object.getPrototypeOf(value);

    return first === second ? first : undefined;
  } catch {
    return undefined;
  }
}

function stableSnapshotKeys(value: object): readonly PropertyKey[] | undefined {
  try {
    const first = Reflect.ownKeys(value);
    const second = Reflect.ownKeys(value);

    if (first.length !== second.length) {
      return undefined;
    }

    for (let index = 0; index < first.length; index += 1) {
      if (first[index] !== second[index]) {
        return undefined;
      }
    }

    return first;
  } catch {
    return undefined;
  }
}

function stableSnapshotLength(value: readonly unknown[]): number | undefined {
  try {
    const first = value.length;
    const second = value.length;

    return Number.isInteger(first) && first >= 0 && first === second ? first : undefined;
  } catch {
    return undefined;
  }
}

function stableSnapshotOwn(value: object, key: PropertyKey): boolean | undefined {
  try {
    const first = Object.hasOwn(value, key);
    const second = Object.hasOwn(value, key);

    return first === second ? first : undefined;
  } catch {
    return undefined;
  }
}

function stableSnapshotData(
  value: object,
  key: PropertyKey,
): { readonly ok: true; readonly value: unknown } | { readonly ok: false } {
  try {
    const first = Object.getOwnPropertyDescriptor(value, key);
    const second = Object.getOwnPropertyDescriptor(value, key);

    if (first === undefined || second === undefined || !("value" in first) || !("value" in second)) {
      return { ok: false };
    }

    const indexed = (value as Record<PropertyKey, unknown>)[key];
    const indexedAgain = (value as Record<PropertyKey, unknown>)[key];

    if (
      !Object.is(first.value, second.value) ||
      !Object.is(indexed, first.value) ||
      !Object.is(indexedAgain, first.value)
    ) {
      return { ok: false };
    }

    return {
      ok: true,
      value: first.value,
    };
  } catch {
    return { ok: false };
  }
}

function snapshotFailure(path: readonly string[], message: string): SnapshotResult {
  return {
    ok: false,
    path: formatPath(path),
    message,
  };
}

function formatPath(path: readonly string[]): string {
  const formatted: string[] = [];

  for (let index = 0; index < path.length; index += 1) {
    const token = path[index];

    if (token !== undefined) {
      formatted[formatted.length] = token.replaceAll("~", "~0").replaceAll("/", "~1");
    }
  }

  return formatted.join("/");
}

function arrayIndexKey(key: string): boolean {
  if (key.length === 0) {
    return false;
  }

  const parsed = Number(key);

  return Number.isInteger(parsed) && parsed >= 0 && parsed < 4_294_967_295 && String(parsed) === key;
}

function dispatchError(
  code: ControllerApiError["code"],
  message: string,
): ControllerApiDispatchResult {
  return {
    ok: false,
    error: {
      code,
      message,
    },
  };
}

function isPlainObject(value: Plain): value is PlainObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isDeviceArchitecture(value: Plain | undefined): value is DeviceArchitecture {
  return value === "x86_64" || value === "arm64";
}

function isRecord(value: unknown): value is JsonRecord {
  if (value === null || typeof value !== "object" || Array.isArray(value) || nodeTypes.isProxy(value)) {
    return false;
  }

  try {
    const prototype = Object.getPrototypeOf(value);

    return prototype === Object.prototype || prototype === null;
  } catch {
    return false;
  }
}
