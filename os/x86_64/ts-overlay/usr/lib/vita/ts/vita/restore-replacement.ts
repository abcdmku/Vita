import { isAgentClientError } from "./agent-client.ts";
import type {
  AgentApplyPlan,
  AgentApplyResult,
  AgentCapabilityState,
  AgentClient,
} from "./agent-client.ts";
import type { PlainJson } from "./safe-normalize.ts";

export const RESTORE_REPLACEMENT_CAPABILITY = "restore.replacement";

const RESTORE_REPLACEMENT_BACKUP_SOURCE = "/var/lib/vita-backups";
const RESTORE_REPLACEMENT_TAMPERED_SOURCE = "/var/lib/vita-backups-tampered";

export type RestoreReplacementResult =
  | {
      readonly ok: true;
      readonly backupId: string;
      readonly files: number;
      readonly from: string;
      readonly to: string;
    }
  | {
      readonly ok: false;
      readonly reason: string;
    };

export type RestoreReplacementRejectResult =
  | {
      readonly ok: true;
      readonly reason: string;
    }
  | {
      readonly ok: false;
      readonly reason: string;
    };

export interface RestoreReplacementOptions {
  readonly backupSource?: string;
  readonly tamperedBackupSource?: string;
  readonly expectFrom?: string;
}

interface RestoreReplacementStatus {
  readonly op: "replace";
  readonly backupId: string;
  readonly files: number;
  readonly from: string;
  readonly to: string;
  readonly roots: readonly RestoreReplacementRootStatus[];
  readonly restored: boolean;
  readonly verified: boolean;
  readonly status: string;
}

interface RestoreReplacementRootStatus {
  readonly name: string;
  readonly backupRoot: string;
  readonly destinationRoot: string;
  readonly files: number;
  readonly restored: boolean;
  readonly verified: boolean;
}

type StatusReadResult =
  | {
      readonly ok: true;
      readonly status: RestoreReplacementStatus;
    }
  | {
      readonly ok: false;
      readonly reason: string;
    };

export async function runRestoreReplacement(
  client: Pick<AgentClient, "apply" | "getState">,
  options: RestoreReplacementOptions = {},
): Promise<RestoreReplacementResult> {
  const restore = await applyRestorePlan(
    client,
    buildReplacePlan(options.backupSource ?? RESTORE_REPLACEMENT_BACKUP_SOURCE, options.expectFrom),
    "replace",
  );
  if (!restore.ok) return restore;

  const restored = await readRestoreStatus(client);
  if (!restored.ok) return failedRestore(`replace_${restored.reason}`);
  if (
    restored.status.op !== "replace" ||
    !restored.status.restored ||
    !restored.status.verified ||
    restored.status.backupId.length === 0 ||
    restored.status.files < 0 ||
    restored.status.from.length === 0 ||
    restored.status.to.length === 0 ||
    restored.status.roots.length === 0 ||
    !restored.status.roots.every((root) => root.restored && root.verified)
  ) {
    return failedRestore("replace_not_measured");
  }

  return {
    backupId: restored.status.backupId,
    files: restored.status.files,
    from: restored.status.from,
    ok: true,
    to: restored.status.to,
  };
}

export async function rejectTamperedRestoreReplacement(
  client: Pick<AgentClient, "apply">,
  options: RestoreReplacementOptions = {},
): Promise<RestoreReplacementRejectResult> {
  try {
    const result = await client.apply(
      buildReplacePlan(options.tamperedBackupSource ?? RESTORE_REPLACEMENT_TAMPERED_SOURCE, options.expectFrom),
    );

    if (result.outcome !== "committed") {
      const reason = markerToken(agentApplyResultReason(result));
      if (reason === "verify_digest_mismatch") {
        return {
          ok: true,
          reason,
        };
      }
      return {
        ok: false,
        reason: markerToken(`tamper_not_measured_${reason}`),
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
      const reason = markerToken(agentClientErrorReason(cause));
      if (reason === "verify_digest_mismatch") {
        return {
          ok: true,
          reason,
        };
      }
      return {
        ok: false,
        reason: markerToken(`tamper_not_measured_${reason}`),
      };
    }

    return {
      ok: false,
      reason: "tamper_transport_failed",
    };
  }

  return {
    ok: false,
    reason: "tampered_restore_committed",
  };
}

export function formatRestoreReplacementMarker(result: RestoreReplacementResult): string {
  if (!result.ok) {
    return `VITA-RESTORE-REPLACEMENT-ERROR: reason=${markerToken(result.reason)} status=FAILSAFE`;
  }

  return (
    "VITA-RESTORE-REPLACEMENT: " +
    `from=${markerToken(result.from)} ` +
    `to=${markerToken(result.to)} ` +
    "restored=OK " +
    "verified=OK " +
    `files=${result.files} ` +
    `id=${manifestDigestPrefix(result.backupId)} ` +
    "status=OK"
  );
}

export function formatRestoreReplacementRejectMarker(
  result: RestoreReplacementRejectResult,
): string {
  if (!result.ok) {
    return `VITA-RESTORE-REPLACEMENT-ERROR: reason=${markerToken(result.reason)} status=FAILSAFE`;
  }

  return `VITA-RESTORE-REPLACEMENT-REJECT: reason=${markerToken(result.reason)} status=OK`;
}

function buildReplacePlan(backupSource: string, expectFrom?: string): AgentApplyPlan {
  const replace: {
    readonly backupSource: string;
    readonly expectFrom?: string;
  } = expectFrom === undefined
    ? Object.freeze({ backupSource })
    : Object.freeze({ backupSource, expectFrom });

  return Object.freeze({
    operations: Object.freeze([
      Object.freeze({
        capability: RESTORE_REPLACEMENT_CAPABILITY,
        request: Object.freeze({
          op: "replace",
          replace,
        }),
      }),
    ]),
  }) satisfies AgentApplyPlan;
}

async function applyRestorePlan(
  client: Pick<AgentClient, "apply">,
  plan: AgentApplyPlan,
  step: string,
): Promise<RestoreReplacementResult> {
  try {
    const result = await client.apply(plan);

    if (result.outcome !== "committed") {
      return failedRestore(scopedRestoreReason(step, agentApplyResultReason(result)));
    }

    return {
      backupId: "",
      files: 0,
      from: "",
      ok: true,
      to: "",
    };
  } catch (cause) {
    if (
      isAgentClientError(cause) &&
      cause.agentError !== undefined &&
      cause.status !== undefined &&
      cause.status >= 400 &&
      cause.status <= 499
    ) {
      return failedRestore(scopedRestoreReason(step, agentClientErrorReason(cause)));
    }

    return failedRestore(`${step}_transport_failed`);
  }
}

async function readRestoreStatus(
  client: Pick<AgentClient, "getState">,
): Promise<StatusReadResult> {
  let state: AgentCapabilityState;

  try {
    state = await client.getState(RESTORE_REPLACEMENT_CAPABILITY);
  } catch {
    return rejectStatus("state_unreadable");
  }

  return parseRestoreStatus(state);
}

function parseRestoreStatus(state: AgentCapabilityState): StatusReadResult {
  const last = state["last"];
  if (!isRecord(last)) return rejectStatus("last_missing");

  const op = field(last, "op");
  const backupId = field(last, "backupId");
  const files = field(last, "files");
  const from = field(last, "from");
  const to = field(last, "to");
  const roots = field(last, "roots");
  const restored = field(last, "restored");
  const verified = field(last, "verified");
  const status = field(last, "status");

  if (op !== "replace") return rejectStatus("op_invalid");
  if (typeof backupId !== "string" || backupId.length === 0) {
    return rejectStatus("backup_id_invalid");
  }
  if (!isNonNegativeSafeInteger(files)) return rejectStatus("files_invalid");
  if (typeof from !== "string" || from.length === 0) return rejectStatus("from_invalid");
  if (typeof to !== "string" || to.length === 0) return rejectStatus("to_invalid");
  if (!Array.isArray(roots)) return rejectStatus("roots_invalid");
  if (typeof restored !== "boolean") return rejectStatus("restored_invalid");
  if (typeof verified !== "boolean") return rejectStatus("verified_invalid");
  if (typeof status !== "string" || status !== "OK") return rejectStatus("status_invalid");

  const parsedRoots: RestoreReplacementRootStatus[] = [];
  for (let index = 0; index < roots.length; index += 1) {
    const parsed = parseRootStatus(roots[index]);
    if (!parsed.ok) return rejectStatus(`root_${parsed.reason}`);
    parsedRoots.push(parsed.root);
  }

  return {
    ok: true,
    status: {
      backupId,
      files,
      from,
      op,
      restored,
      roots: Object.freeze(parsedRoots),
      status,
      to,
      verified,
    },
  };
}

function parseRootStatus(value: PlainJson): (
  | {
      readonly ok: true;
      readonly root: RestoreReplacementRootStatus;
    }
  | {
      readonly ok: false;
      readonly reason: string;
    }
) {
  if (!isRecord(value)) return { ok: false, reason: "invalid" };
  const name = field(value, "name");
  const backupRoot = field(value, "backupRoot");
  const destinationRoot = field(value, "destinationRoot");
  const files = field(value, "files");
  const restored = field(value, "restored");
  const verified = field(value, "verified");
  if (typeof name !== "string" || name.length === 0) return { ok: false, reason: "name" };
  if (typeof backupRoot !== "string" || backupRoot.length === 0) {
    return { ok: false, reason: "backup_root" };
  }
  if (typeof destinationRoot !== "string" || destinationRoot.length === 0) {
    return { ok: false, reason: "destination" };
  }
  if (!isNonNegativeSafeInteger(files)) return { ok: false, reason: "files" };
  if (typeof restored !== "boolean") return { ok: false, reason: "restored" };
  if (typeof verified !== "boolean") return { ok: false, reason: "verified" };

  return {
    ok: true,
    root: {
      backupRoot,
      destinationRoot,
      files,
      name,
      restored,
      verified,
    },
  };
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

function scopedRestoreReason(step: string, reason: string): string {
  const token = markerToken(reason);
  if (token === step || token.startsWith(`${step}_`) || token.startsWith(`${step}:`)) {
    return token;
  }

  return `${step}_${token}`;
}

function failedRestore(reason: string): RestoreReplacementResult {
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

function isNonNegativeSafeInteger(value: PlainJson | undefined): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function markerToken(value: string): string {
  const token = value.replace(/[^A-Za-z0-9_.-]+/gu, "_");
  return token.length === 0 ? "unknown" : token;
}
