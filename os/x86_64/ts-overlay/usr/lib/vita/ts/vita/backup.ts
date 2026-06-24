import { isAgentClientError } from "./agent-client.ts";
import type {
  AgentApplyPlan,
  AgentApplyResult,
  AgentCapabilityState,
  AgentClient,
} from "./agent-client.ts";
import type { PlainJson } from "./safe-normalize.ts";

export const BACKUP_ARCHIVE_CAPABILITY = "backup.archive";

const BACKUP_TARGET_PATH = "/var/lib/vita-backups";
const BACKUP_RESTORE_BASE = "/var/lib/vita-backup-restore";
const BAD_BACKUP_ID = "sha256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

const BACKUP_SOURCE_ROOTS = Object.freeze([
  Object.freeze({
    name: "capsule-volumes",
    path: "/var/lib/vita/runtime/volumes",
  }),
  Object.freeze({
    name: "vita-agent",
    path: "/var/lib/vita-agent",
  }),
]);

export type BackupArchiveRoundTripResult =
  | {
      readonly ok: true;
      readonly backupId: string;
      readonly files: number;
    }
  | {
      readonly ok: false;
      readonly reason: string;
    };

export type BackupArchiveRejectResult =
  | {
      readonly ok: true;
      readonly reason: string;
    }
  | {
      readonly ok: false;
      readonly reason: string;
    };

interface BackupArchiveStatus {
  readonly op: "create" | "verify" | "restore";
  readonly backupId?: string;
  readonly files: number;
  readonly created: boolean;
  readonly verified: boolean;
  readonly restored: boolean;
  readonly status: string;
}

type StatusReadResult =
  | {
      readonly ok: true;
      readonly status: BackupArchiveStatus;
    }
  | {
      readonly ok: false;
      readonly reason: string;
    };

export async function runBackupArchiveRoundTrip(
  client: Pick<AgentClient, "apply" | "getState">,
): Promise<BackupArchiveRoundTripResult> {
  const create = await applyArchivePlan(client, buildCreatePlan(), "create");
  if (!create.ok) return create;

  const created = await readArchiveStatus(client);
  if (!created.ok) return failedArchive(`create_${created.reason}`);
  if (
    created.status.op !== "create" ||
    !created.status.created ||
    created.status.backupId === undefined
  ) {
    return failedArchive("create_not_measured");
  }

  const backupId = created.status.backupId;
  const verify = await applyArchivePlan(client, buildVerifyPlan(backupId), "verify");
  if (!verify.ok) return verify;

  const verified = await readArchiveStatus(client);
  if (!verified.ok) return failedArchive(`verify_${verified.reason}`);
  if (
    verified.status.op !== "verify" ||
    !verified.status.verified ||
    verified.status.backupId !== backupId
  ) {
    return failedArchive("verify_not_measured");
  }

  const restore = await applyArchivePlan(
    client,
    buildRestorePlan(backupId, restoreDestination(backupId)),
    "restore",
  );
  if (!restore.ok) return restore;

  const restored = await readArchiveStatus(client);
  if (!restored.ok) return failedArchive(`restore_${restored.reason}`);
  if (
    restored.status.op !== "restore" ||
    !restored.status.verified ||
    !restored.status.restored ||
    restored.status.backupId !== backupId ||
    restored.status.files !== created.status.files
  ) {
    return failedArchive("restore_not_measured");
  }

  return {
    backupId,
    files: created.status.files,
    ok: true,
  };
}

export async function rejectTamperedBackupArchive(
  client: Pick<AgentClient, "apply">,
): Promise<BackupArchiveRejectResult> {
  try {
    const result = await client.apply(buildTamperedRestorePlan());

    if (result.outcome !== "committed") {
      return {
        ok: true,
        reason: markerToken(`restore_${agentApplyResultReason(result)}`),
      };
    }
  } catch (cause) {
    if (
      isAgentClientError(cause) &&
      cause.agentError !== undefined &&
      cause.status !== undefined &&
      cause.status >= 400 &&
      cause.status <= 499
    ) {
      return {
        ok: true,
        reason: markerToken(`restore_${agentClientErrorReason(cause)}`),
      };
    }

    return {
      ok: false,
      reason: "restore_transport_failed",
    };
  }

  return {
    ok: false,
    reason: "tampered_restore_committed",
  };
}

export function formatBackupArchiveMarker(result: BackupArchiveRoundTripResult): string {
  if (!result.ok) {
    return `VITA-BACKUP-ERROR: reason=${markerToken(result.reason)} status=FAILSAFE`;
  }

  return (
    "VITA-BACKUP: " +
    "created=OK " +
    "restored=OK " +
    "verified=OK " +
    `id=${manifestDigestPrefix(result.backupId)} ` +
    `files=${result.files} ` +
    "status=OK"
  );
}

export function formatBackupArchiveRejectMarker(result: BackupArchiveRejectResult): string {
  if (!result.ok) {
    return `VITA-BACKUP-ERROR: reason=${markerToken(result.reason)} status=FAILSAFE`;
  }

  return `VITA-BACKUP-REJECT: reason=${markerToken(result.reason)} status=OK`;
}

function buildCreatePlan(): AgentApplyPlan {
  return Object.freeze({
    operations: Object.freeze([
      Object.freeze({
        capability: BACKUP_ARCHIVE_CAPABILITY,
        request: Object.freeze({
          create: Object.freeze({
            sourceRoots: BACKUP_SOURCE_ROOTS,
            targetPath: BACKUP_TARGET_PATH,
          }),
          op: "create",
        }),
      }),
    ]),
  }) satisfies AgentApplyPlan;
}

function buildVerifyPlan(backupId: string): AgentApplyPlan {
  return Object.freeze({
    operations: Object.freeze([
      Object.freeze({
        capability: BACKUP_ARCHIVE_CAPABILITY,
        request: Object.freeze({
          op: "verify",
          verify: Object.freeze({
            backupId,
            targetPath: BACKUP_TARGET_PATH,
          }),
        }),
      }),
    ]),
  }) satisfies AgentApplyPlan;
}

function buildRestorePlan(backupId: string, destinationRoot: string): AgentApplyPlan {
  return Object.freeze({
    operations: Object.freeze([
      Object.freeze({
        capability: BACKUP_ARCHIVE_CAPABILITY,
        request: Object.freeze({
          op: "restore",
          restore: Object.freeze({
            backupId,
            destinationRoot,
            targetPath: BACKUP_TARGET_PATH,
          }),
        }),
      }),
    ]),
  }) satisfies AgentApplyPlan;
}

function buildTamperedRestorePlan(): AgentApplyPlan {
  return Object.freeze({
    operations: Object.freeze([
      Object.freeze({
        capability: BACKUP_ARCHIVE_CAPABILITY,
        request: Object.freeze({
          op: "restore",
          restore: Object.freeze({
            backupId: BAD_BACKUP_ID,
            destinationRoot: `${BACKUP_RESTORE_BASE}/forced-invalid`,
            targetPath: BACKUP_TARGET_PATH,
          }),
        }),
      }),
    ]),
  }) satisfies AgentApplyPlan;
}

async function applyArchivePlan(
  client: Pick<AgentClient, "apply">,
  plan: AgentApplyPlan,
  step: string,
): Promise<BackupArchiveRoundTripResult> {
  try {
    const result = await client.apply(plan);

    if (result.outcome !== "committed") {
      return failedArchive(scopedArchiveReason(step, agentApplyResultReason(result)));
    }

    return {
      backupId: "",
      files: 0,
      ok: true,
    };
  } catch (cause) {
    if (
      isAgentClientError(cause) &&
      cause.agentError !== undefined &&
      cause.status !== undefined &&
      cause.status >= 400 &&
      cause.status <= 499
    ) {
      return failedArchive(scopedArchiveReason(step, agentClientErrorReason(cause)));
    }

    return failedArchive(`${step}_transport_failed`);
  }
}

async function readArchiveStatus(
  client: Pick<AgentClient, "getState">,
): Promise<StatusReadResult> {
  let state: AgentCapabilityState;

  try {
    state = await client.getState(BACKUP_ARCHIVE_CAPABILITY);
  } catch {
    return rejectStatus("state_unreadable");
  }

  return parseArchiveStatus(state);
}

function parseArchiveStatus(state: AgentCapabilityState): StatusReadResult {
  const last = state["last"];

  if (!isRecord(last)) return rejectStatus("last_missing");

  const op = field(last, "op");
  const backupId = optionalField(last, "backupId");
  const files = field(last, "files");
  const created = field(last, "created");
  const verified = field(last, "verified");
  const restored = field(last, "restored");
  const status = field(last, "status");

  if (op !== "create" && op !== "verify" && op !== "restore") {
    return rejectStatus("op_invalid");
  }
  if (backupId !== undefined && typeof backupId !== "string") {
    return rejectStatus("backup_id_invalid");
  }
  if (!isNonNegativeSafeInteger(files)) return rejectStatus("files_invalid");
  if (typeof created !== "boolean") return rejectStatus("created_invalid");
  if (typeof verified !== "boolean") return rejectStatus("verified_invalid");
  if (typeof restored !== "boolean") return rejectStatus("restored_invalid");
  if (typeof status !== "string" || status !== "OK") return rejectStatus("status_invalid");

  const parsed: {
    op: "create" | "verify" | "restore";
    files: number;
    created: boolean;
    verified: boolean;
    restored: boolean;
    status: string;
    backupId?: string;
  } = {
    created,
    files,
    op,
    restored,
    status,
    verified,
  };

  if (backupId !== undefined) {
    parsed.backupId = backupId;
  }

  return {
    ok: true,
    status: parsed,
  };
}

function restoreDestination(backupId: string): string {
  return `${BACKUP_RESTORE_BASE}/${manifestDigestPrefix(backupId)}`;
}

function manifestDigestPrefix(backupId: string): string {
  return markerToken(backupId).slice(0, 18);
}

function agentApplyResultReason(result: AgentApplyResult): string {
  return markerToken(result.error?.code ?? "transaction_rejected");
}

function agentClientErrorReason(cause: unknown): string {
  if (isAgentClientError(cause)) {
    if (cause.agentError !== undefined) {
      return markerToken(cause.agentError.code);
    }
    return markerToken(cause.code.toLowerCase());
  }

  return "transport_failed";
}

function scopedArchiveReason(step: string, reason: string): string {
  const token = markerToken(reason);
  if (token === step || token.startsWith(`${step}_`) || token.startsWith(`${step}:`)) {
    return token;
  }

  return `${step}_${token}`;
}

function failedArchive(reason: string): BackupArchiveRoundTripResult {
  return {
    ok: false,
    reason: markerToken(reason),
  };
}

function rejectStatus(reason: string): StatusReadResult {
  return {
    ok: false,
    reason,
  };
}

function isRecord(value: PlainJson | undefined): value is Readonly<Record<string, PlainJson>> {
  return value !== undefined && value !== null && typeof value === "object" && !Array.isArray(value);
}

function field(value: Readonly<Record<string, PlainJson>>, key: string): PlainJson | undefined {
  if (!Object.hasOwn(value, key)) return undefined;

  return value[key];
}

function optionalField(
  value: Readonly<Record<string, PlainJson>>,
  key: string,
): PlainJson | undefined {
  return field(value, key);
}

function isNonNegativeSafeInteger(value: PlainJson | undefined): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function markerToken(value: string): string {
  const token = value.replace(/[^A-Za-z0-9_.-]+/gu, "_");
  return token.length === 0 ? "unknown" : token;
}
