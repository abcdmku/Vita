import { isAgentClientError } from "./agent-client.ts";
import { applyNodeConfig } from "./apply-node-config.ts";
import type {
  AgentApplyPlan,
  AgentApplyResult,
  AgentClient,
} from "./agent-client.ts";
import type {
  ApplyNodeApplyResult,
  ApplyNodeConfigResult,
  ApplyNodeTransport,
} from "./apply-node-config.ts";
import type { CapabilityManifestRegistry } from "./evaluate.ts";

export interface PdsSyncStateWriteDesired {
  readonly repo: string;
  readonly cursor: number;
  readonly repoHead: string;
}

export interface PdsSyncStateWriteConfig {
  readonly "pds.sync-state": {
    readonly desired: PdsSyncStateWriteDesired;
  };
}

export type PdsSyncStateWriteResult =
  | {
      readonly ok: true;
      readonly outcome: "committed";
      readonly repo: string;
      readonly cursor: number;
    }
  | {
      readonly ok: true;
      readonly outcome: "rejected";
      readonly reason: string;
    }
  | {
      readonly ok: false;
      readonly reason: string;
    };

export const PDS_SYNC_STATE_CAPABILITY = "pds.sync-state";
export const PDS_SYNC_STATE_WRITE_REPO = "did:plc:ewvi7nxzyoun6zhxrhs64oiz";
export const PDS_SYNC_STATE_WRITE_CURSOR = 42;
export const PDS_SYNC_STATE_WRITE_REPO_HEAD =
  "bafybeigdyrzt5sfp7udm7hu76ekfya5f45mcm6qzdv6woc4f3gj3sidfwy";

export const PDS_SYNC_STATE_WRITE_DESIRED = Object.freeze({
  cursor: PDS_SYNC_STATE_WRITE_CURSOR,
  repo: PDS_SYNC_STATE_WRITE_REPO,
  repoHead: PDS_SYNC_STATE_WRITE_REPO_HEAD,
}) satisfies PdsSyncStateWriteDesired;

export function buildPdsSyncStateWriteConfig(
  desired: PdsSyncStateWriteDesired = PDS_SYNC_STATE_WRITE_DESIRED,
): PdsSyncStateWriteConfig {
  return Object.freeze({
    "pds.sync-state": Object.freeze({
      desired: Object.freeze({
        cursor: desired.cursor,
        repo: desired.repo,
        repoHead: desired.repoHead,
      }),
    }),
  });
}

export function buildInvalidPdsSyncStateWritePlan(): AgentApplyPlan {
  const plan = Object.freeze({
    operations: Object.freeze([
      Object.freeze({
        capability: PDS_SYNC_STATE_CAPABILITY,
        request: Object.freeze({
          desired: Object.freeze({
            cursor: -1,
            repo: PDS_SYNC_STATE_WRITE_REPO,
            repoHead: PDS_SYNC_STATE_WRITE_REPO_HEAD,
          }),
        }),
      }),
    ]),
  }) satisfies AgentApplyPlan;

  return plan;
}

export async function applyPdsSyncStateWrite(
  registry: CapabilityManifestRegistry,
  transport: ApplyNodeTransport,
  desired: PdsSyncStateWriteDesired = PDS_SYNC_STATE_WRITE_DESIRED,
): Promise<PdsSyncStateWriteResult> {
  return pdsSyncStateWriteResultFromApplyNodeConfigResult(
    await applyNodeConfig(buildPdsSyncStateWriteConfig(desired), registry, transport),
    desired,
  );
}

export async function rejectInvalidPdsSyncStateWrite(
  client: Pick<AgentClient, "apply">,
): Promise<PdsSyncStateWriteResult> {
  try {
    const result = await client.apply(buildInvalidPdsSyncStateWritePlan());

    if (result.outcome === "rejected") {
      return rejectedWrite(agentApplyResultReason(result));
    }
  } catch (cause) {
    if (
      isAgentClientError(cause) &&
      cause.agentError !== undefined &&
      cause.status !== undefined &&
      cause.status >= 400 &&
      cause.status <= 499
    ) {
      return rejectedWrite(cause.agentError.code);
    }
  }

  return failedWrite("invalid PDS sync-state was not rejected by agentd");
}

export function pdsSyncStateWriteResultFromApplyNodeConfigResult(
  result: ApplyNodeConfigResult,
  desired: PdsSyncStateWriteDesired = PDS_SYNC_STATE_WRITE_DESIRED,
): PdsSyncStateWriteResult {
  if (result.ok) {
    return {
      cursor: desired.cursor,
      ok: true,
      outcome: "committed",
      repo: desired.repo,
    };
  }

  if (result.stage === "apply" && result.applyResult?.outcome === "rejected") {
    return rejectedWrite(applyResultReason(result.applyResult, result.reason));
  }

  return failedWrite(result.stage);
}

export function formatPdsSyncStateWriteMarker(result: PdsSyncStateWriteResult): string {
  if (!result.ok) {
    return "VITA-PDS-WRITE-ERROR: status=FAILSAFE";
  }

  if (result.outcome === "rejected") {
    return `VITA-PDS-WRITE: outcome=rejected reason=${result.reason} status=OK`;
  }

  return (
    "VITA-PDS-WRITE: " +
    `outcome=committed repo=${result.repo} cursor=${result.cursor} status=OK`
  );
}

function applyResultReason(result: ApplyNodeApplyResult, fallback: string): string {
  return markerToken(result.error?.code ?? fallback);
}

function agentApplyResultReason(result: AgentApplyResult): string {
  return markerToken(result.error?.code ?? "transaction_rejected");
}

function rejectedWrite(reason: string): PdsSyncStateWriteResult {
  return {
    ok: true,
    outcome: "rejected",
    reason: markerToken(reason),
  };
}

function failedWrite(reason: string): PdsSyncStateWriteResult {
  return {
    ok: false,
    reason,
  };
}

function markerToken(value: string): string {
  const token = value.replace(/[^A-Za-z0-9_.-]+/gu, "_");
  return token.length === 0 ? "unknown" : token;
}
