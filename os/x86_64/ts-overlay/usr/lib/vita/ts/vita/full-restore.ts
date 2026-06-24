import { isAgentClientError } from "./agent-client.ts";
import type {
  AgentApplyPlan,
  AgentApplyResult,
  AgentCapabilityState,
  AgentClient,
} from "./agent-client.ts";
import { BACKUP_ARCHIVE_CAPABILITY } from "./backup.ts";
import type { PlainJson } from "./safe-normalize.ts";

const FULL_RESTORE_TARGET_PATH = "/var/lib/vita-restore-full-backups";
const FULL_RESTORE_DEST_BASE = "/var/lib/vita-restore-full";
const BAD_BACKUP_ID = "sha256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

const FULL_RESTORE_SOURCE_ROOTS = Object.freeze([
  Object.freeze({
    name: "capsule-volumes",
    path: "/var/lib/vita/runtime/volumes",
  }),
  Object.freeze({
    name: "vita-agent",
    path: "/var/lib/vita-agent",
  }),
]);

type FullRestoreRootMapping = {
  readonly name: string;
  readonly path: string;
};

export type FullRestoreRoundTripResult =
  | {
      readonly ok: true;
      readonly backupId: string;
      readonly files: number;
      readonly volumes: number;
    }
  | {
      readonly ok: false;
      readonly reason: string;
    };

export type FullRestoreRejectResult =
  | {
      readonly ok: true;
      readonly reason: string;
    }
  | {
      readonly ok: false;
      readonly reason: string;
    };

interface FullRestoreArchiveStatus {
  readonly op: "create" | "restore-all";
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
      readonly status: FullRestoreArchiveStatus;
    }
  | {
      readonly ok: false;
      readonly reason: string;
    };

export async function runFullRestoreRoundTrip(
  client: Pick<AgentClient, "apply" | "getState">,
): Promise<FullRestoreRoundTripResult> {
  const create = await applyArchivePlan(client, buildCreatePlan(), "create");
  if (!create.ok) return create;

  const created = await readArchiveStatus(client);
  if (!created.ok) return failedFullRestore(`create_${created.reason}`);
  if (
    created.status.op !== "create" ||
    !created.status.created ||
    created.status.backupId === undefined
  ) {
    return failedFullRestore("create_not_measured");
  }

  const backupId = created.status.backupId;
  const rootMappings = restoreAllRootMappings(backupId);
  const restore = await applyArchivePlan(
    client,
    buildRestoreAllPlan(backupId, rootMappings),
    "restore_all",
  );
  if (!restore.ok) return restore;

  const restored = await readArchiveStatus(client);
  if (!restored.ok) return failedFullRestore(`restore_all_${restored.reason}`);
  if (
    restored.status.op !== "restore-all" ||
    !restored.status.verified ||
    !restored.status.restored ||
    restored.status.backupId !== backupId ||
    restored.status.files !== created.status.files
  ) {
    return failedFullRestore("restore_all_not_measured");
  }

  return {
    backupId,
    files: created.status.files,
    ok: true,
    volumes: rootMappings.length,
  };
}

export async function rejectTamperedFullRestore(
  client: Pick<AgentClient, "apply">,
): Promise<FullRestoreRejectResult> {
  try {
    const result = await client.apply(buildTamperedRestoreAllPlan());

    if (result.outcome !== "committed") {
      return {
        ok: true,
        reason: markerToken(`restore_all_${agentApplyResultReason(result)}`),
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
        reason: markerToken(`restore_all_${agentClientErrorReason(cause)}`),
      };
    }

    return {
      ok: false,
      reason: "restore_all_transport_failed",
    };
  }

  return {
    ok: false,
    reason: "tampered_restore_all_committed",
  };
}

export function formatFullRestoreMarker(result: FullRestoreRoundTripResult): string {
  if (!result.ok) {
    return `VITA-RESTORE-FULL-ERROR: reason=${markerToken(result.reason)} status=FAILSAFE`;
  }

  return (
    "VITA-RESTORE-FULL: " +
    "restored=OK " +
    "verified=OK " +
    `volumes=${result.volumes} ` +
    `id=${manifestDigestPrefix(result.backupId)} ` +
    "status=OK"
  );
}

export function formatFullRestoreRejectMarker(result: FullRestoreRejectResult): string {
  if (!result.ok) {
    return `VITA-RESTORE-FULL-ERROR: reason=${markerToken(result.reason)} status=FAILSAFE`;
  }

  return `VITA-RESTORE-FULL-REJECT: reason=${markerToken(result.reason)} status=OK`;
}

function buildCreatePlan(): AgentApplyPlan {
  return Object.freeze({
    operations: Object.freeze([
      Object.freeze({
        capability: BACKUP_ARCHIVE_CAPABILITY,
        request: Object.freeze({
          create: Object.freeze({
            sourceRoots: FULL_RESTORE_SOURCE_ROOTS,
            targetPath: FULL_RESTORE_TARGET_PATH,
          }),
          op: "create",
        }),
      }),
    ]),
  }) satisfies AgentApplyPlan;
}

function buildRestoreAllPlan(
  backupId: string,
  rootMappings: readonly FullRestoreRootMapping[],
): AgentApplyPlan {
  return Object.freeze({
    operations: Object.freeze([
      Object.freeze({
        capability: BACKUP_ARCHIVE_CAPABILITY,
        request: Object.freeze({
          op: "restore-all",
          restoreAll: Object.freeze({
            backupId,
            rootMappings,
            targetPath: FULL_RESTORE_TARGET_PATH,
          }),
        }),
      }),
    ]),
  }) satisfies AgentApplyPlan;
}

function buildTamperedRestoreAllPlan(): AgentApplyPlan {
  return Object.freeze({
    operations: Object.freeze([
      Object.freeze({
        capability: BACKUP_ARCHIVE_CAPABILITY,
        request: Object.freeze({
          op: "restore-all",
          restoreAll: Object.freeze({
            backupId: BAD_BACKUP_ID,
            rootMappings: restoreAllRootMappings("forced-invalid"),
            targetPath: FULL_RESTORE_TARGET_PATH,
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
): Promise<FullRestoreRoundTripResult> {
  try {
    const result = await client.apply(plan);

    if (result.outcome !== "committed") {
      return failedFullRestore(scopedArchiveReason(step, agentApplyResultReason(result)));
    }

    return {
      backupId: "",
      files: 0,
      ok: true,
      volumes: 0,
    };
  } catch (cause) {
    if (
      isAgentClientError(cause) &&
      cause.agentError !== undefined &&
      cause.status !== undefined &&
      cause.status >= 400 &&
      cause.status <= 499
    ) {
      return failedFullRestore(scopedArchiveReason(step, agentClientErrorReason(cause)));
    }

    return failedFullRestore(`${step}_transport_failed`);
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

  if (op !== "create" && op !== "restore-all") return rejectStatus("op_invalid");
  if (backupId !== undefined && typeof backupId !== "string") {
    return rejectStatus("backup_id_invalid");
  }
  if (!isNonNegativeSafeInteger(files)) return rejectStatus("files_invalid");
  if (typeof created !== "boolean") return rejectStatus("created_invalid");
  if (typeof verified !== "boolean") return rejectStatus("verified_invalid");
  if (typeof restored !== "boolean") return rejectStatus("restored_invalid");
  if (typeof status !== "string" || status !== "OK") return rejectStatus("status_invalid");

  const parsed: {
    op: "create" | "restore-all";
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

function restoreAllRootMappings(backupId: string): readonly FullRestoreRootMapping[] {
  const prefix = manifestDigestPrefix(backupId);
  return Object.freeze([
    Object.freeze({
      name: "capsule-volumes",
      path: `${FULL_RESTORE_DEST_BASE}/${prefix}/volumes`,
    }),
    Object.freeze({
      name: "vita-agent",
      path: `${FULL_RESTORE_DEST_BASE}/${prefix}/vita-agent`,
    }),
  ]);
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

function failedFullRestore(reason: string): FullRestoreRoundTripResult {
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
