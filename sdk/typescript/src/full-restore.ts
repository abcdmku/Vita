export const FULL_RESTORE_OPERATION = "restore-all";

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
