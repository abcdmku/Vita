import { summarizeAuditLog } from "../../audit/src/audit-viewer.ts";
import type {
  AuditLogSummaryRejection,
  AuditLogSummaryResult,
} from "../../audit/src/audit-viewer.ts";
import { summarizeNodeHealth } from "../../health/src/health-monitor.ts";
import type {
  HealthMonitorRejection,
  NodeHealthSummaryResult,
} from "../../health/src/health-monitor.ts";
import { safeNormalize } from "../../../sdk/typescript/src/safe-normalize.ts";
import type {
  PlainJson,
  PlainJsonObject,
} from "../../../sdk/typescript/src/safe-normalize.ts";

export type NodeOperationsVerdict = "ok" | "attention" | "critical";
export type NodeOperationsSectionName = "health" | "audit";

export type NodeOperationsSectionErrorCode =
  | "INVALID_OPERATIONS_INPUT"
  | "INVALID_HEALTH_INPUT"
  | "INVALID_AUDIT_INPUT"
  | "HEALTH_SUMMARY_REJECTED"
  | "AUDIT_SUMMARY_REJECTED"
  | "SUMMARY_FAILED";

export interface NodeOperationsSectionRejection {
  readonly path: string;
  readonly message: string;
  readonly code?: string;
}

export interface NodeOperationsSectionError {
  readonly section: NodeOperationsSectionName;
  readonly code: NodeOperationsSectionErrorCode;
  readonly message: string;
  readonly rejections?: readonly NodeOperationsSectionRejection[];
}

export type NodeOperationsHealthSection =
  | {
      readonly ok: true;
      readonly summary: Extract<NodeHealthSummaryResult, { readonly ok: true }>;
    }
  | {
      readonly ok: false;
      readonly error: NodeOperationsSectionError;
    };

export type NodeOperationsAuditSection =
  | {
      readonly ok: true;
      readonly summary: Extract<AuditLogSummaryResult, { readonly ok: true }>;
    }
  | {
      readonly ok: false;
      readonly error: NodeOperationsSectionError;
    };

export interface NodeOperationsReport {
  readonly verdict: NodeOperationsVerdict;
  readonly health: NodeOperationsHealthSection;
  readonly audit: NodeOperationsAuditSection;
  readonly issues: readonly string[];
}

type EnvelopeResult =
  | {
      readonly ok: true;
      readonly value: PlainJsonObject;
    }
  | {
      readonly ok: false;
      readonly message: string;
      readonly rejections: readonly NodeOperationsSectionRejection[];
    };

type HealthInputResult =
  | {
      readonly ok: true;
      readonly report: PlainJson;
      readonly thresholds: PlainJson;
    }
  | {
      readonly ok: false;
      readonly error: NodeOperationsSectionError;
    };

type AuditInputResult =
  | {
      readonly ok: true;
      readonly events: PlainJson;
    }
  | {
      readonly ok: false;
      readonly error: NodeOperationsSectionError;
    };

const TOP_LEVEL_FIELDS = new Set(["audit", "health"]);
const HEALTH_FIELDS = new Set(["report", "thresholds"]);
const AUDIT_FIELDS = new Set(["events"]);

export function buildNodeOperationsReport(input: unknown): NodeOperationsReport {
  try {
    const envelope = normalizeEnvelope(input);

    if (!envelope.ok) {
      return failedEnvelopeReport(envelope.message, envelope.rejections);
    }

    const health = buildHealthSection(envelope.value);
    const audit = buildAuditSection(envelope.value);
    const issues = collectIssues(health, audit);
    const verdict = decideVerdict(health, audit);

    return Object.freeze({
      audit,
      health,
      issues,
      verdict,
    });
  } catch {
    return failedEnvelopeReport("Operations report summary failed.", [
      {
        message: "Operations report summary failed.",
        path: "",
      },
    ]);
  }
}

function normalizeEnvelope(input: unknown): EnvelopeResult {
  const normalized = safeNormalize(input);

  if (!normalized.ok) {
    return rejectEnvelope(
      `Invalid operations report input: ${normalized.reason}`,
      [
        {
          message: normalized.reason,
          path: "",
        },
      ],
    );
  }

  if (!isPlainObject(normalized.value)) {
    return rejectEnvelope("Expected operations report input object.", [
      {
        message: "Expected operations report input object.",
        path: "",
      },
    ]);
  }

  const unknowns = unknownFields(normalized.value, TOP_LEVEL_FIELDS);

  if (unknowns.length > 0) {
    return rejectEnvelope(
      `Unknown operations report input field: ${unknowns.join(", ")}.`,
      unknowns.map((fieldName) => ({
        message: "Unknown operations report input field.",
        path: escapePathToken(fieldName),
      })),
    );
  }

  return {
    ok: true,
    value: normalized.value,
  };
}

function buildHealthSection(
  envelope: PlainJsonObject,
): NodeOperationsHealthSection {
  const input = readHealthInput(envelope);

  if (!input.ok) {
    return {
      error: input.error,
      ok: false,
    };
  }

  try {
    const summary = summarizeNodeHealth(input.report, input.thresholds);

    if (!summary.ok) {
      return {
        error: sectionError(
          "health",
          "HEALTH_SUMMARY_REJECTED",
          "Health summary failed to validate.",
          healthRejections(summary.rejections),
        ),
        ok: false,
      };
    }

    return {
      ok: true,
      summary,
    };
  } catch {
    return {
      error: sectionError(
        "health",
        "SUMMARY_FAILED",
        "Health summary failed.",
      ),
      ok: false,
    };
  }
}

function buildAuditSection(
  envelope: PlainJsonObject,
): NodeOperationsAuditSection {
  const input = readAuditInput(envelope);

  if (!input.ok) {
    return {
      error: input.error,
      ok: false,
    };
  }

  try {
    const summary = summarizeAuditLog(input.events);

    if (!summary.ok) {
      return {
        error: sectionError(
          "audit",
          "AUDIT_SUMMARY_REJECTED",
          "Audit summary failed to validate.",
          auditRejections(summary.rejections),
        ),
        ok: false,
      };
    }

    return {
      ok: true,
      summary,
    };
  } catch {
    return {
      error: sectionError(
        "audit",
        "SUMMARY_FAILED",
        "Audit summary failed.",
      ),
      ok: false,
    };
  }
}

function readHealthInput(envelope: PlainJsonObject): HealthInputResult {
  const section = readRequiredObject(envelope, "health");

  if (!section.ok) {
    return rejectHealthInput([section.rejection]);
  }

  const rejections = sectionRejections(section.value, HEALTH_FIELDS, "health");
  const report = readRequiredField(section.value, "report", "health/report", rejections);
  const thresholds = readRequiredField(
    section.value,
    "thresholds",
    "health/thresholds",
    rejections,
  );

  if (rejections.length > 0 || report === undefined || thresholds === undefined) {
    return rejectHealthInput(rejections);
  }

  return {
    ok: true,
    report,
    thresholds,
  };
}

function readAuditInput(envelope: PlainJsonObject): AuditInputResult {
  const section = readRequiredObject(envelope, "audit");

  if (!section.ok) {
    return rejectAuditInput([section.rejection]);
  }

  const rejections = sectionRejections(section.value, AUDIT_FIELDS, "audit");
  const events = readRequiredField(section.value, "events", "audit/events", rejections);

  if (rejections.length > 0 || events === undefined) {
    return rejectAuditInput(rejections);
  }

  return {
    events,
    ok: true,
  };
}

function readRequiredObject(
  value: PlainJsonObject,
  key: "audit" | "health",
):
  | {
      readonly ok: true;
      readonly value: PlainJsonObject;
    }
  | {
      readonly ok: false;
      readonly rejection: NodeOperationsSectionRejection;
    } {
  const child = readField(value, key);

  if (child === undefined) {
    return {
      ok: false,
      rejection: {
        message: "Required section is missing.",
        path: key,
      },
    };
  }

  if (!isPlainObject(child)) {
    return {
      ok: false,
      rejection: {
        message: "Expected section object.",
        path: key,
      },
    };
  }

  return {
    ok: true,
    value: child,
  };
}

function sectionRejections(
  value: PlainJsonObject,
  allowed: ReadonlySet<string>,
  prefix: string,
): NodeOperationsSectionRejection[] {
  const rejections: NodeOperationsSectionRejection[] = [];
  const unknowns = unknownFields(value, allowed);

  for (let index = 0; index < unknowns.length; index += 1) {
    const fieldName = unknowns[index];

    if (fieldName !== undefined) {
      rejections[rejections.length] = {
        message: "Unknown section field.",
        path: `${prefix}/${escapePathToken(fieldName)}`,
      };
    }
  }

  return rejections;
}

function readRequiredField(
  value: PlainJsonObject,
  key: string,
  path: string,
  rejections: NodeOperationsSectionRejection[],
): PlainJson | undefined {
  const child = readField(value, key);

  if (child === undefined) {
    rejections[rejections.length] = {
      message: "Required field is missing.",
      path,
    };
  }

  return child;
}

function collectIssues(
  health: NodeOperationsHealthSection,
  audit: NodeOperationsAuditSection,
): readonly string[] {
  const issues: string[] = [];

  appendHealthIssues(issues, health);
  appendAuditIssues(issues, audit);

  return Object.freeze(issues);
}

function appendHealthIssues(
  issues: string[],
  health: NodeOperationsHealthSection,
): void {
  if (!health.ok) {
    issues[issues.length] = health.error.message;
    appendRejectionIssues(issues, health.error.rejections);
    return;
  }

  for (const issue of health.summary.capabilityIssues) {
    issues[issues.length] = capabilityIssueMessage(issue);
  }

  for (const issue of health.summary.resourceIssues) {
    issues[issues.length] =
      `Resource ${issue.resource} is over threshold: ${formatPercent(issue.fraction)} used ` +
      `(threshold ${formatPercent(issue.threshold)}).`;
  }
}

function appendAuditIssues(
  issues: string[],
  audit: NodeOperationsAuditSection,
): void {
  if (!audit.ok) {
    issues[issues.length] = audit.error.message;
    appendRejectionIssues(issues, audit.error.rejections);
    return;
  }

  if (!audit.summary.monotonic) {
    issues[issues.length] =
      "Audit log sequence is non-monotonic; history may be tampered or replayed.";
  }

  for (const failure of audit.summary.recentFailures) {
    const base =
      `Recent audit failure at sequence ${failure.sequence}: ` +
      `${failure.capability} ${failure.operation} ${failure.outcome}`;

    issues[issues.length] =
      failure.reason === undefined ? `${base}.` : `${base} (${failure.reason}).`;
  }
}

function appendRejectionIssues(
  issues: string[],
  rejections: readonly NodeOperationsSectionRejection[] | undefined,
): void {
  if (rejections === undefined) {
    return;
  }

  for (const rejection of rejections) {
    const path = rejection.path === "" ? "input" : rejection.path;

    issues[issues.length] = `${path}: ${rejection.message}`;
  }
}

function decideVerdict(
  health: NodeOperationsHealthSection,
  audit: NodeOperationsAuditSection,
): NodeOperationsVerdict {
  if (!health.ok || !audit.ok) {
    return "critical";
  }

  if (health.summary.status === "critical" || !audit.summary.monotonic) {
    return "critical";
  }

  if (health.summary.status === "warning" || audit.summary.recentFailures.length > 0) {
    return "attention";
  }

  return "ok";
}

function failedEnvelopeReport(
  message: string,
  rejections: readonly NodeOperationsSectionRejection[],
): NodeOperationsReport {
  const health: NodeOperationsHealthSection = {
    error: sectionError(
      "health",
      "INVALID_OPERATIONS_INPUT",
      message,
      rejections,
    ),
    ok: false,
  };
  const audit: NodeOperationsAuditSection = {
    error: sectionError(
      "audit",
      "INVALID_OPERATIONS_INPUT",
      message,
      rejections,
    ),
    ok: false,
  };
  const issues = envelopeIssues(message, rejections);

  return Object.freeze({
    audit,
    health,
    issues,
    verdict: "critical",
  });
}

function envelopeIssues(
  message: string,
  rejections: readonly NodeOperationsSectionRejection[],
): readonly string[] {
  const issues = [message];

  appendRejectionIssues(issues, rejections);

  return Object.freeze(issues);
}

function rejectEnvelope(
  message: string,
  rejections: readonly NodeOperationsSectionRejection[],
): Extract<EnvelopeResult, { readonly ok: false }> {
  return {
    message,
    ok: false,
    rejections: Object.freeze([...rejections]),
  };
}

function rejectHealthInput(
  rejections: readonly NodeOperationsSectionRejection[],
): Extract<HealthInputResult, { readonly ok: false }> {
  return {
    error: sectionError(
      "health",
      "INVALID_HEALTH_INPUT",
      "Health report section is invalid.",
      rejections,
    ),
    ok: false,
  };
}

function rejectAuditInput(
  rejections: readonly NodeOperationsSectionRejection[],
): Extract<AuditInputResult, { readonly ok: false }> {
  return {
    error: sectionError(
      "audit",
      "INVALID_AUDIT_INPUT",
      "Audit report section is invalid.",
      rejections,
    ),
    ok: false,
  };
}

function sectionError(
  section: NodeOperationsSectionName,
  code: NodeOperationsSectionErrorCode,
  message: string,
  rejections: readonly NodeOperationsSectionRejection[] = [],
): NodeOperationsSectionError {
  const base = {
    code,
    message,
    section,
  };

  if (rejections.length === 0) {
    return base;
  }

  return {
    ...base,
    rejections: Object.freeze([...rejections]),
  };
}

function healthRejections(
  rejections: readonly HealthMonitorRejection[],
): readonly NodeOperationsSectionRejection[] {
  return Object.freeze(
    rejections.map((rejection) => ({
      message: rejection.message,
      path: prefixedPath("health", rejection.path),
    })),
  );
}

function auditRejections(
  rejections: readonly AuditLogSummaryRejection[],
): readonly NodeOperationsSectionRejection[] {
  return Object.freeze(
    rejections.map((rejection) => ({
      code: rejection.code,
      message: rejection.message,
      path: prefixedPath("audit", rejection.path),
    })),
  );
}

function capabilityIssueMessage(
  issue: Extract<
    Extract<NodeHealthSummaryResult, { readonly ok: true }>["capabilityIssues"][number],
    { readonly status: "degraded" | "failed" }
  >,
): string {
  const base = `Capability ${issue.name} is ${issue.status}`;

  return issue.message === undefined ? `${base}.` : `${base}: ${issue.message}.`;
}

function prefixedPath(prefix: string, path: string): string {
  return path === "" ? prefix : `${prefix}/${path}`;
}

function unknownFields(
  value: PlainJsonObject,
  allowed: ReadonlySet<string>,
): readonly string[] {
  const keys = Object.keys(value).sort(compareStrings);
  const unknowns: string[] = [];

  for (let index = 0; index < keys.length; index += 1) {
    const key = keys[index];

    if (key !== undefined && !allowed.has(key)) {
      unknowns[unknowns.length] = key;
    }
  }

  return Object.freeze(unknowns);
}

function readField(value: PlainJsonObject, key: string): PlainJson | undefined {
  if (!Object.hasOwn(value, key)) {
    return undefined;
  }

  return value[key];
}

function isPlainObject(value: PlainJson | undefined): value is PlainJsonObject {
  return value !== undefined && value !== null && typeof value === "object" && !Array.isArray(value);
}

function formatPercent(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

function escapePathToken(token: string): string {
  return token.replaceAll("~", "~0").replaceAll("/", "~1");
}

function compareStrings(left: string, right: string): number {
  if (left < right) {
    return -1;
  }

  if (left > right) {
    return 1;
  }

  return 0;
}
