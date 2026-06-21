import { fetchAuditTrail } from "../../audit/src/audit-client.ts";
import type { FetchAuditTrailResult } from "../../audit/src/audit-client.ts";
import { summarizeAuditLog } from "../../audit/src/audit-viewer.ts";
import type { AuditLogSummaryResult } from "../../audit/src/audit-viewer.ts";
import { previewNodeChangeSet } from "../../changeset/src/changeset-preview.ts";
import type { NodeChangeSetPreview } from "../../changeset/src/changeset-preview.ts";
import { summarizeNodeHealth } from "../../health/src/health-monitor.ts";
import type { ResourceUsageThresholds } from "../../health/src/health-monitor.ts";
import { buildNodeOperationsReport } from "../../report/src/operations-report.ts";
import type { NodeOperationsReport } from "../../report/src/operations-report.ts";
import { fetchNodeSnapshot } from "../../state/src/snapshot-client.ts";
import type { FetchNodeSnapshotResult } from "../../state/src/snapshot-client.ts";

export type OperatorSessionTransport = (
  path: string,
) => Promise<OperatorSessionTransportResponse>;

export interface OperatorSessionTransportResponse {
  readonly status: number;
  readonly body: unknown;
}

export type OperatorSessionStage =
  | "snapshot"
  | "audit"
  | "auditSummary"
  | "health"
  | "operationsReport"
  | "preview";

export type OperatorSessionFailureReason =
  | SnapshotFailureReason
  | AuditFailureReason
  | HealthFetchFailureReason
  | "audit_summary_rejected"
  | "health_summary_rejected"
  | "operations_report_rejected"
  | "preview_rejected"
  | "stage_failed";

export type OperatorSessionResult =
  | {
      readonly ok: true;
      readonly snapshot: NodeSnapshot;
      readonly auditSummary: AuditSummary;
      readonly operationsReport: NodeOperationsReport;
      readonly changePreview: ChangePreview;
    }
  | {
      readonly ok: false;
      readonly stage: OperatorSessionStage;
      readonly reason: OperatorSessionFailureReason;
    };

type NodeSnapshot = Extract<FetchNodeSnapshotResult, { readonly ok: true }>;
type SnapshotFailureReason = Extract<
  FetchNodeSnapshotResult,
  { readonly ok: false }
>["reason"];
type AuditTrail = Extract<FetchAuditTrailResult, { readonly ok: true }>;
type AuditFailureReason = Extract<
  FetchAuditTrailResult,
  { readonly ok: false }
>["reason"];
type AuditSummary = Extract<AuditLogSummaryResult, { readonly ok: true }>;
type ChangePreview = Extract<NodeChangeSetPreview, { readonly ok: true }>;

type HealthFetchFailureReason =
  | "health_unavailable"
  | "transport_error"
  | "unexpected_status"
  | "invalid_response";

type HealthFetchResult =
  | {
      readonly ok: true;
      readonly report: unknown;
      readonly thresholds: ResourceUsageThresholds;
    }
  | {
      readonly ok: false;
      readonly reason: HealthFetchFailureReason;
    };

const HEALTH_PATH = "/health";
const DEFAULT_HEALTH_THRESHOLDS: ResourceUsageThresholds = Object.freeze({
  cpu: 0.8,
  memory: 0.8,
  storage: 0.8,
});

export async function runOperatorSession(
  transport: OperatorSessionTransport,
  currentChangeSet: unknown,
  desiredChangeSet: unknown,
): Promise<OperatorSessionResult> {
  let stage: OperatorSessionStage = "snapshot";

  try {
    const snapshot = await fetchNodeSnapshot(transport);

    if (!snapshot.ok) {
      return fail(stage, snapshot.reason);
    }

    stage = "audit";
    const auditTrail = await fetchAuditTrail(transport);

    if (!auditTrail.ok) {
      return fail(stage, auditTrail.reason);
    }

    stage = "auditSummary";
    const auditSummary = summarizeAuditLog(auditTrail.events);

    if (!auditSummary.ok) {
      return fail(stage, "audit_summary_rejected");
    }

    stage = "health";
    const healthInput = await fetchNodeHealthInput(transport);

    if (!healthInput.ok) {
      return fail(stage, healthInput.reason);
    }

    const healthSummary = summarizeNodeHealth(
      healthInput.report,
      healthInput.thresholds,
    );

    if (!healthSummary.ok) {
      return fail(stage, "health_summary_rejected");
    }

    stage = "operationsReport";
    const operationsReport = buildOperationsReport(
      healthInput.report,
      healthInput.thresholds,
      auditTrail,
    );

    if (!operationsReport.health.ok || !operationsReport.audit.ok) {
      return fail(stage, "operations_report_rejected");
    }

    stage = "preview";
    const changePreview = previewNodeChangeSet(currentChangeSet, desiredChangeSet);

    if (!changePreview.ok) {
      return fail(stage, "preview_rejected");
    }

    return {
      auditSummary,
      changePreview,
      ok: true,
      operationsReport,
      snapshot,
    };
  } catch {
    return fail(stage, "stage_failed");
  }
}

async function fetchNodeHealthInput(
  transport: OperatorSessionTransport,
): Promise<HealthFetchResult> {
  let response: OperatorSessionTransportResponse;

  try {
    response = await transport(HEALTH_PATH);
  } catch {
    return rejectHealth("transport_error");
  }

  try {
    const status = readStatus(response);

    if (status === undefined) {
      return rejectHealth("invalid_response");
    }

    if (status === 503) {
      return rejectHealth("health_unavailable");
    }

    if (status !== 200) {
      return rejectHealth("unexpected_status");
    }

    return {
      ok: true,
      report: response.body,
      thresholds: DEFAULT_HEALTH_THRESHOLDS,
    };
  } catch {
    return rejectHealth("invalid_response");
  }
}

function buildOperationsReport(
  healthReport: unknown,
  thresholds: ResourceUsageThresholds,
  auditTrail: AuditTrail,
): NodeOperationsReport {
  return buildNodeOperationsReport({
    audit: {
      events: auditTrail.events,
    },
    health: {
      report: healthReport,
      thresholds,
    },
  });
}

function readStatus(
  response: OperatorSessionTransportResponse,
): number | undefined {
  const status = response.status;

  if (typeof status !== "number" || !Number.isSafeInteger(status)) {
    return undefined;
  }

  return status;
}

function rejectHealth(reason: HealthFetchFailureReason): HealthFetchResult {
  return {
    ok: false,
    reason,
  };
}

function fail(
  stage: OperatorSessionStage,
  reason: OperatorSessionFailureReason,
): Extract<OperatorSessionResult, { readonly ok: false }> {
  return {
    ok: false,
    reason,
    stage,
  };
}
