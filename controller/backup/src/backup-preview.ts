import { validateBackupPolicy } from "../../../sdk/typescript/src/backup-model.ts";
import type {
  BackupModelValidationError,
  BackupPolicy,
  BackupSchedule,
  BackupTarget,
} from "../../../sdk/typescript/src/backup-model.ts";

export type BackupPreviewSide = "current" | "desired" | "preview";

export interface BackupPreviewRejection {
  readonly side: BackupPreviewSide;
  readonly path: string;
  readonly message: string;
}

export interface BackupScheduleChange {
  readonly current: BackupSchedule;
  readonly desired: BackupSchedule;
}

export interface BackupRetentionValueChange {
  readonly current: number;
  readonly desired: number;
}

export interface BackupRetentionChange {
  readonly count: null;
  readonly maxAgeDays: BackupRetentionValueChange | null;
}

export interface BackupTargetDiff {
  readonly added: readonly BackupTarget[];
  readonly removed: readonly BackupTarget[];
}

export interface BackupChangeDiff {
  readonly schedule: BackupScheduleChange | null;
  readonly retention: BackupRetentionChange;
  readonly targets: BackupTargetDiff;
}

export type BackupChangePreview =
  | {
      readonly valid: true;
      readonly diff: BackupChangeDiff;
      readonly weakensRetention: boolean;
      readonly rejections: readonly [];
    }
  | {
      readonly valid: false;
      readonly diff: undefined;
      readonly weakensRetention: false;
      readonly rejections: readonly BackupPreviewRejection[];
    };

type SideValidation =
  | {
      readonly ok: true;
      readonly policy: BackupPolicy;
    }
  | {
      readonly ok: false;
      readonly rejections: readonly BackupPreviewRejection[];
    };

const NO_REJECTIONS: readonly [] = Object.freeze([]);
const VALIDATION_FAILED = "Backup policy validation failed.";

export function previewBackupChange(current: unknown, desired: unknown): BackupChangePreview {
  try {
    const currentValidation = validateSide("current", current);
    const desiredValidation = validateSide("desired", desired);

    if (!currentValidation.ok || !desiredValidation.ok) {
      return rejectedPreview(collectRejections(currentValidation, desiredValidation));
    }

    const diff = diffBackupPolicies(currentValidation.policy, desiredValidation.policy);

    return Object.freeze({
      diff,
      rejections: NO_REJECTIONS,
      valid: true,
      weakensRetention: retentionWeakens(currentValidation.policy, desiredValidation.policy),
    });
  } catch {
    return rejectedPreview([
      {
        message: "Backup change preview failed.",
        path: "",
        side: "preview",
      },
    ]);
  }
}

function validateSide(side: Exclude<BackupPreviewSide, "preview">, input: unknown): SideValidation {
  try {
    const result = validateBackupPolicy(input);

    if (result.ok) {
      return {
        ok: true,
        policy: result.policy,
      };
    }

    return {
      ok: false,
      rejections: validationErrorsToRejections(side, result.errors),
    };
  } catch {
    return {
      ok: false,
      rejections: Object.freeze([
        {
          message: VALIDATION_FAILED,
          path: "",
          side,
        },
      ]),
    };
  }
}

function validationErrorsToRejections(
  side: Exclude<BackupPreviewSide, "preview">,
  errors: readonly BackupModelValidationError[],
): readonly BackupPreviewRejection[] {
  const rejections: BackupPreviewRejection[] = [];

  for (let index = 0; index < errors.length; index += 1) {
    const error = errors[index];

    if (error === undefined) {
      continue;
    }

    rejections[rejections.length] = {
      message: error.message,
      path: error.path,
      side,
    };
  }

  if (rejections.length === 0) {
    rejections[0] = {
      message: VALIDATION_FAILED,
      path: "",
      side,
    };
  }

  return Object.freeze(rejections);
}

function collectRejections(
  currentValidation: SideValidation,
  desiredValidation: SideValidation,
): readonly BackupPreviewRejection[] {
  const rejections: BackupPreviewRejection[] = [];

  if (!currentValidation.ok) {
    appendRejections(rejections, currentValidation.rejections);
  }
  if (!desiredValidation.ok) {
    appendRejections(rejections, desiredValidation.rejections);
  }

  return Object.freeze(rejections);
}

function appendRejections(
  target: BackupPreviewRejection[],
  source: readonly BackupPreviewRejection[],
): void {
  for (let index = 0; index < source.length; index += 1) {
    const rejection = source[index];

    if (rejection !== undefined) {
      target[target.length] = rejection;
    }
  }
}

function rejectedPreview(rejections: readonly BackupPreviewRejection[]): BackupChangePreview {
  return Object.freeze({
    diff: undefined,
    rejections: Object.freeze([...rejections]),
    valid: false,
    weakensRetention: false,
  });
}

function diffBackupPolicies(current: BackupPolicy, desired: BackupPolicy): BackupChangeDiff {
  return Object.freeze({
    retention: diffRetention(current, desired),
    schedule: schedulesEqual(current.schedule, desired.schedule)
      ? null
      : Object.freeze({
          current: current.schedule,
          desired: desired.schedule,
        }),
    targets: diffTargets(current.target, desired.target),
  });
}

function diffRetention(current: BackupPolicy, desired: BackupPolicy): BackupRetentionChange {
  return Object.freeze({
    count: null,
    maxAgeDays: current.retentionDays === desired.retentionDays
      ? null
      : Object.freeze({
          current: current.retentionDays,
          desired: desired.retentionDays,
        }),
  });
}

function diffTargets(current: BackupTarget, desired: BackupTarget): BackupTargetDiff {
  if (targetKey(current) === targetKey(desired)) {
    return Object.freeze({
      added: Object.freeze([]),
      removed: Object.freeze([]),
    });
  }

  return Object.freeze({
    added: Object.freeze([desired]),
    removed: Object.freeze([current]),
  });
}

function retentionWeakens(current: BackupPolicy, desired: BackupPolicy): boolean {
  return desired.retentionDays < current.retentionDays;
}

function schedulesEqual(current: BackupSchedule, desired: BackupSchedule): boolean {
  return (
    current.cadence === desired.cadence &&
    current.interval === desired.interval &&
    current.startAt === desired.startAt
  );
}

function targetKey(target: BackupTarget): string {
  switch (target.kind) {
    case "attached-disk":
      return keyTuple("attached-disk", target.deviceRef);
    case "local-snapshot":
      return keyTuple("local-snapshot");
    case "peer-node":
      return keyTuple("peer-node", target.nodeRef);
    case "remote-object":
      return keyTuple("remote-object", target.bucketRef, target.credentialRef);
    case "sftp":
      return keyTuple("sftp", target.endpointRef, target.credentialRef);
    case "vendor-managed":
      return keyTuple("vendor-managed", target.serviceRef, target.accountRef);
  }
}

function keyTuple(...parts: readonly string[]): string {
  return JSON.stringify(parts);
}
