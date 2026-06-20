import type {
  DeviceArchitecture,
  ReadonlyAcceleratorCapability,
} from "../../../sdk/typescript/src/capabilities.ts";
import type {
  PackageContract,
  PackageContractValidationResult,
} from "../../../sdk/manifests/src/package-contract.ts";
import type {
  Capsule,
  CapsuleValidationResult,
} from "../../../storage/capsules/src/capsule.ts";
import type { SimulationProfileKind } from "../../../simulation/profiles/src/profiles.ts";
import type { PlanDiff } from "../../../sdk/typescript/src/diff.ts";
import type {
  BackupSchedule,
  CanonicalPlan,
  DesiredState,
  SnapshotCadence,
} from "../../../sdk/typescript/src/plan.ts";
import type { ValidationResult } from "../../../sdk/typescript/src/validate.ts";
import type {
  BrokerPolicy,
  CapabilityDenial,
  CapabilityGrant,
} from "../../../runtime/permission-broker/src/grants.ts";

export type EmptyParams = Readonly<Record<string, never>>;

export type NodeHealthStatus = "healthy" | "degraded" | "offline";

export interface HealthSummary {
  readonly healthy: number;
  readonly degraded: number;
  readonly offline: number;
}

export interface ProtectionSummary {
  readonly protected: number;
  readonly warnings: number;
  readonly unprotected: number;
}

export interface ExposureSummary {
  readonly publicServices: number;
  readonly privateServices: number;
  readonly blockedRequests24h: number;
}

export interface OverviewResponse {
  readonly nodeCount: number;
  readonly health: HealthSummary;
  readonly protection: ProtectionSummary;
  readonly exposure: ExposureSummary;
}

export type GetOverviewRequest = EmptyParams;

export type StorageHealthStatus = "healthy" | "degraded" | "critical";
export type StorageEncryptionState = "encrypted" | "unencrypted" | "unknown";
export type ProtectionLevel = "snapshot" | "mirror" | "local-backup" | "off-site-backup";
export type ProtectionBackupClass = "not-backup" | "backup";

export type ProtectionState =
  | {
      readonly level: "snapshot";
      readonly protectionLevel: "snapshot";
      readonly backupClass: "not-backup";
      readonly isBackup: false;
      readonly description: string;
    }
  | {
      readonly level: "mirror";
      readonly protectionLevel: "mirror";
      readonly backupClass: "not-backup";
      readonly isBackup: false;
      readonly description: string;
    }
  | {
      readonly level: "local-backup";
      readonly protectionLevel: "local-backup";
      readonly backupClass: "backup";
      readonly isBackup: true;
      readonly description: string;
    }
  | {
      readonly level: "off-site-backup";
      readonly protectionLevel: "off-site-backup";
      readonly backupClass: "backup";
      readonly isBackup: true;
      readonly description: string;
    };

export type BackupProtectionState = Extract<
  ProtectionState,
  { readonly backupClass: "backup" }
>;
export type NonBackupProtectionState = Extract<
  ProtectionState,
  { readonly backupClass: "not-backup" }
>;

export interface CapacitySummary {
  readonly totalGiB: number;
  readonly usedGiB: number;
  readonly availableGiB: number;
}

export interface StorageOverviewSummary {
  readonly health: StorageHealthStatus;
  readonly capacity: CapacitySummary;
  readonly encryptedVolumes: number;
  readonly snapshotProtectedVolumes: number;
  readonly mirrorProtectedVolumes: number;
  readonly backupProtectedVolumes: number;
  readonly unprotectedVolumes: number;
}

export interface StoragePoolOverview {
  readonly id: string;
  readonly label: string;
  readonly health: StorageHealthStatus;
  readonly capacity: CapacitySummary;
  readonly encryptionState: StorageEncryptionState;
  readonly protectionStates: readonly ProtectionState[];
}

export interface StorageVolumeOverview {
  readonly id: string;
  readonly poolId: string;
  readonly label: string;
  readonly mountPath: string;
  readonly health: StorageHealthStatus;
  readonly capacity: CapacitySummary;
  readonly encryptionState: StorageEncryptionState;
  readonly snapshotCadence: SnapshotCadence;
  readonly protectionStates: readonly ProtectionState[];
}

export interface StorageOverviewResponse {
  readonly summary: StorageOverviewSummary;
  readonly pools: readonly StoragePoolOverview[];
  readonly volumes: readonly StorageVolumeOverview[];
}

export type GetStorageOverviewRequest = EmptyParams;

export type BackupTargetKind =
  | "attached-disk"
  | "peer-node"
  | "remote-object"
  | "remote-sftp"
  | "vendor-managed";

export type BackupRunResult = "succeeded" | "failed" | "never-run" | "unknown";
export type RestoreTestResult = "passed" | "failed" | "not-run" | "unknown";

export interface BackupRunSummary {
  readonly result: BackupRunResult;
  readonly finishedAt?: string;
}

export interface RestoreTestSummary {
  readonly result: RestoreTestResult;
  readonly testedAt?: string;
}

export interface BackupTargetStatus {
  readonly id: string;
  readonly label: string;
  readonly targetKind: BackupTargetKind;
  readonly enabled: boolean;
  readonly schedule: BackupSchedule;
  readonly protectionState: BackupProtectionState;
  readonly lastRun: BackupRunSummary;
  readonly nextRunAt?: string;
  readonly lastRestoreTest: RestoreTestSummary;
}

export interface NonBackupProtectionStatus {
  readonly id: string;
  readonly label: string;
  readonly protectionState: NonBackupProtectionState;
}

export interface BackupStatusSummary {
  readonly backupTargetCount: number;
  readonly healthyTargets: number;
  readonly restoreTestsPassing: number;
  readonly lastSuccessfulBackupAt?: string;
}

export interface BackupStatusResponse {
  readonly summary: BackupStatusSummary;
  readonly targets: readonly BackupTargetStatus[];
  readonly nonBackupProtection: readonly NonBackupProtectionStatus[];
}

export type GetBackupStatusRequest = EmptyParams;

export type IdentityRole =
  | "owner"
  | "administrator"
  | "member"
  | "restricted-member"
  | "guest"
  | "service";

export interface IdentityRoleSummary {
  readonly role: IdentityRole;
  readonly principalCount: number;
}

export type PasskeyEnrollmentState = "complete" | "partial" | "not-enrolled";

export interface PasskeyEnrollmentSummary {
  readonly required: boolean;
  readonly state: PasskeyEnrollmentState;
  readonly enrolledPrincipals: number;
  readonly unenrolledPrincipals: number;
}

export interface AuditLogSummary {
  readonly available: boolean;
  readonly retentionDays: number;
  readonly lastEventAt?: string;
}

export interface IdentitySummaryResponse {
  readonly roles: readonly IdentityRoleSummary[];
  readonly passkeys: PasskeyEnrollmentSummary;
  readonly auditLog: AuditLogSummary;
}

export type GetIdentitySummaryRequest = EmptyParams;

export interface NodeHealthRequest {
  readonly nodeId: string;
}

export interface NodeCapabilitySummary {
  readonly memoryGB: number;
  readonly architecture: DeviceArchitecture;
  readonly accelerators: readonly ReadonlyAcceleratorCapability[];
  readonly tpm: {
    readonly present: boolean;
    readonly version?: string;
    readonly sealedKeyUnlock?: boolean;
  };
  readonly virtualization: {
    readonly hardware: boolean;
    readonly nested?: boolean;
  };
}

export interface NodeHealthResponse {
  readonly nodeId: string;
  readonly status: NodeHealthStatus;
  readonly uptimeSeconds: number;
  readonly capabilities: NodeCapabilitySummary;
}

export interface PlanPreviewRequest {
  readonly desiredState: DesiredState;
  readonly currentPlan?: CanonicalPlan;
}

export type PlanValidationPass = Extract<ValidationResult, { readonly ok: true }>;
export type PlanValidationFailure = Extract<ValidationResult, { readonly ok: false }>;

export interface ControllerApiError {
  readonly code:
    | "UNKNOWN_METHOD"
    | "INVALID_PARAMS"
    | "VALIDATION_FAILED"
    | "CAPABILITY_DENIED";
  readonly message: string;
}

export type PlanPreviewResponse =
  | {
      readonly ok: true;
      readonly validation: PlanValidationPass;
      readonly diff: PlanDiff;
      readonly explanation: string;
    }
  | {
      readonly ok: false;
      readonly validation: PlanValidationFailure;
      readonly error: ControllerApiError;
    };

export type AppStatus = "installed" | "available";

export interface AppSummary {
  readonly id: string;
  readonly version: string;
  readonly status: AppStatus;
}

export type ListAppsRequest = EmptyParams;

export interface AppSummaryResponse {
  readonly apps: readonly AppSummary[];
}

export interface AppInstallPreviewRequest {
  readonly packageContract: PackageContract;
  readonly policy: BrokerPolicy;
}

export type PackageContractValidationPass = Extract<
  PackageContractValidationResult,
  { readonly ok: true }
>;
export type PackageContractValidationFailure = Extract<
  PackageContractValidationResult,
  { readonly ok: false }
>;

export type AppInstallPreviewResponse =
  | {
      readonly ok: true;
      readonly validation: PackageContractValidationPass;
      readonly grantedCapabilities: readonly CapabilityGrant[];
      readonly deniedCapabilities: readonly CapabilityDenial[];
      readonly reasons: readonly string[];
    }
  | {
      readonly ok: false;
      readonly validation: PackageContractValidationResult;
      readonly grantedCapabilities: readonly CapabilityGrant[];
      readonly deniedCapabilities: readonly CapabilityDenial[];
      readonly reasons: readonly string[];
      readonly error: ControllerApiError;
    };

export interface CapsuleImportPreviewRequest {
  readonly capsule: Capsule;
  readonly targetArch: DeviceArchitecture;
  readonly policy: BrokerPolicy;
}

export type CapsuleValidationPass = Extract<CapsuleValidationResult, { readonly ok: true }>;

export type CapsuleImportPreviewResponse =
  | {
      readonly ok: true;
      readonly validation: CapsuleValidationPass;
      readonly targetArch: DeviceArchitecture;
      readonly migratable: true;
      readonly migrationReasons: readonly string[];
      readonly missingProfiles: readonly SimulationProfileKind[];
      readonly grantedCapabilities: readonly CapabilityGrant[];
      readonly deniedCapabilities: readonly CapabilityDenial[];
      readonly reasons: readonly string[];
    }
  | {
      readonly ok: false;
      readonly validation: CapsuleValidationResult;
      readonly targetArch?: DeviceArchitecture;
      readonly migratable: boolean;
      readonly migrationReasons: readonly string[];
      readonly missingProfiles: readonly SimulationProfileKind[];
      readonly grantedCapabilities: readonly CapabilityGrant[];
      readonly deniedCapabilities: readonly CapabilityDenial[];
      readonly reasons: readonly string[];
      readonly error: ControllerApiError;
    };

export interface ControllerApi {
  getOverview(): OverviewResponse;
  getStorageOverview(): StorageOverviewResponse;
  getBackupStatus(): BackupStatusResponse;
  getIdentitySummary(): IdentitySummaryResponse;
  getNodeHealth(params: NodeHealthRequest): NodeHealthResponse;
  previewPlan(params: PlanPreviewRequest): PlanPreviewResponse;
  listApps(): AppSummaryResponse;
  previewAppInstall(params: AppInstallPreviewRequest): AppInstallPreviewResponse;
  previewCapsuleImport(params: CapsuleImportPreviewRequest): CapsuleImportPreviewResponse;
}

export type ControllerApiMethod =
  | "getOverview"
  | "getStorageOverview"
  | "getBackupStatus"
  | "getIdentitySummary"
  | "getNodeHealth"
  | "previewPlan"
  | "listApps"
  | "previewAppInstall"
  | "previewCapsuleImport";

export type ControllerApiRequest =
  | {
      readonly method: "getOverview";
      readonly params?: GetOverviewRequest;
    }
  | {
      readonly method: "getStorageOverview";
      readonly params?: GetStorageOverviewRequest;
    }
  | {
      readonly method: "getBackupStatus";
      readonly params?: GetBackupStatusRequest;
    }
  | {
      readonly method: "getIdentitySummary";
      readonly params?: GetIdentitySummaryRequest;
    }
  | {
      readonly method: "getNodeHealth";
      readonly params: NodeHealthRequest;
    }
  | {
      readonly method: "previewPlan";
      readonly params: PlanPreviewRequest;
    }
  | {
      readonly method: "listApps";
      readonly params?: ListAppsRequest;
    }
  | {
      readonly method: "previewAppInstall";
      readonly params: AppInstallPreviewRequest;
    }
  | {
      readonly method: "previewCapsuleImport";
      readonly params: CapsuleImportPreviewRequest;
    };

export interface ControllerApiDispatchRequest {
  readonly method: string;
  readonly params?: unknown;
}

export type ControllerApiDispatchResult =
  | {
      readonly ok: true;
      readonly method: "getOverview";
      readonly response: OverviewResponse;
    }
  | {
      readonly ok: true;
      readonly method: "getStorageOverview";
      readonly response: StorageOverviewResponse;
    }
  | {
      readonly ok: true;
      readonly method: "getBackupStatus";
      readonly response: BackupStatusResponse;
    }
  | {
      readonly ok: true;
      readonly method: "getIdentitySummary";
      readonly response: IdentitySummaryResponse;
    }
  | {
      readonly ok: true;
      readonly method: "getNodeHealth";
      readonly response: NodeHealthResponse;
    }
  | {
      readonly ok: true;
      readonly method: "previewPlan";
      readonly response: PlanPreviewResponse;
    }
  | {
      readonly ok: true;
      readonly method: "listApps";
      readonly response: AppSummaryResponse;
    }
  | {
      readonly ok: true;
      readonly method: "previewAppInstall";
      readonly response: AppInstallPreviewResponse;
    }
  | {
      readonly ok: true;
      readonly method: "previewCapsuleImport";
      readonly response: CapsuleImportPreviewResponse;
    }
  | {
      readonly ok: false;
      readonly error: ControllerApiError;
    };
