export const FULL_RESTORE_OPERATION = "restore-all";
export const FULL_RESTORE_VERIFY_OPERATION = "verify-restored";

export interface RootMapping {
  readonly name: string;
  readonly path: string;
}

export interface FullRestoreRequest {
  readonly targetPath: string;
  readonly backupId: string;
  readonly rootMappings?: readonly RootMapping[];
}

export interface FullRestoreArchiveApplyRequest {
  readonly op: typeof FULL_RESTORE_OPERATION;
  readonly restoreAll: FullRestoreRequest;
}

// verify-restored re-reads each already-restored destination root on-device and
// proves its bytes hash-match the manifest before VITA-RESTORE-FULL is emitted.
// It is the MEASURED gate — the marker is never printed from a status field
// alone, only after this op confirms every root's restored content matches.
export interface FullRestoreVerifyRequest {
  readonly targetPath: string;
  readonly backupId: string;
  readonly rootMappings?: readonly RootMapping[];
}

export interface FullRestoreVerifyArchiveApplyRequest {
  readonly op: typeof FULL_RESTORE_VERIFY_OPERATION;
  readonly verifyRestored: FullRestoreVerifyRequest;
}

export interface FullRestoreResult {
  readonly backupId: string;
  readonly files: number;
  readonly volumes: number;
  readonly restored: boolean;
  readonly verified: boolean;
  readonly status: "OK";
}

export interface FullRestoreMarkerResult {
  readonly backupId: string;
  readonly files: number;
  readonly volumes: number;
}
