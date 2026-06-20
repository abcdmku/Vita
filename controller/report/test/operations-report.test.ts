import assert from "node:assert/strict";
import { test } from "node:test";

import { buildNodeOperationsReport } from "../src/operations-report.ts";
import type {
  NodeOperationsReport,
  NodeOperationsSectionErrorCode,
  NodeOperationsSectionName,
} from "../src/operations-report.ts";
import type {
  CapabilityHealthStatus,
  NodeHealth,
} from "../../../sdk/typescript/src/node-health-model.ts";
import type { AuditEvent } from "../../../sdk/typescript/src/audit-event-model.ts";
import type { ResourceUsageThresholds } from "../../health/src/health-monitor.ts";

const DEFAULT_THRESHOLDS: ResourceUsageThresholds = Object.freeze({
  cpu: 0.8,
  memory: 0.8,
  storage: 0.8,
});

test("healthy node and intact monotonic log summarize as ok with no issues", () => {
  const report = buildNodeOperationsReport(validInput());

  assert.equal(report.verdict, "ok");
  assertHealthSummary(report, "ok");
  assertAuditSummary(report, true);
  assert.deepEqual(report.issues, []);
});

test("degraded capability requires attention and records the concrete issue", () => {
  const report = buildNodeOperationsReport(
    validInput({
      health: withCapabilityStatus(
        healthyReport(),
        "updates",
        "degraded",
        "queue latency above target",
      ),
    }),
  );

  assert.equal(report.verdict, "attention");
  assertHealthSummary(report, "warning");
  assertIssueIncludes(report, "updates", "degraded", "queue latency");
});

test("failed capability is critical", () => {
  const report = buildNodeOperationsReport(
    validInput({
      health: withCapabilityStatus(healthyReport(), "storage.disk", "failed"),
    }),
  );

  assert.equal(report.verdict, "critical");
  assertHealthSummary(report, "critical");
  assertIssueIncludes(report, "storage.disk", "failed");
});

test("non-monotonic audit log is critical while audit summary remains present", () => {
  const report = buildNodeOperationsReport(
    validInput({
      events: [
        event({ outcome: "committed", sequence: 2 }),
        event({ outcome: "failed", sequence: 1 }),
      ],
    }),
  );

  assert.equal(report.verdict, "critical");
  const audit = assertAuditSummary(report, false);
  assert.deepEqual(
    audit.recentFailures.map((failure) => failure.sequence),
    [1],
  );
  assertIssueIncludes(report, "non-monotonic");
});

test("health validation failure is critical and audit still renders", () => {
  const report = buildNodeOperationsReport(
    validInput({
      health: {
        cpu: {
          total: 100,
          used: 10,
        },
        healthy: true,
        memory: {
          total: 100,
          used: 10,
        },
        storage: {
          total: 100,
          used: 10,
        },
        uptimeSeconds: 10,
      },
    }),
  );

  assert.equal(report.verdict, "critical");
  assertSectionError(report, "health", "HEALTH_SUMMARY_REJECTED");
  assertAuditSummary(report, true);
});

test("audit validation failure is critical and health still renders", () => {
  const invalidEvent: Record<string, unknown> = {
    ...event({ sequence: 1 }),
    outcome: "succeeded",
  };
  const report = buildNodeOperationsReport(
    validInput({
      events: [invalidEvent],
    }),
  );

  assert.equal(report.verdict, "critical");
  assertHealthSummary(report, "ok");
  assertSectionError(report, "audit", "AUDIT_SUMMARY_REJECTED");
});

test("top-level accessor input fails closed without invoking the accessor", () => {
  const hostile: Record<string, unknown> = {
    audit: {
      events: [event({ sequence: 1 })],
    },
    health: {
      report: healthyReport(),
      thresholds: DEFAULT_THRESHOLDS,
    },
  };
  let getterReads = 0;
  let report: NodeOperationsReport | undefined;

  Object.defineProperty(hostile, "extra", {
    enumerable: true,
    get() {
      getterReads += 1;
      throw new Error("top-level accessor must not be invoked");
    },
  });

  assert.doesNotThrow(() => {
    report = buildNodeOperationsReport(hostile);
  });
  assert.equal(getterReads, 0);

  if (report === undefined) {
    assert.fail("expected operations report");
  }

  assert.equal(report.verdict, "critical");
  assertSectionError(report, "health", "INVALID_OPERATIONS_INPUT");
  assertSectionError(report, "audit", "INVALID_OPERATIONS_INPUT");
});

test("top-level unknown and symbol fields fail closed", () => {
  const unknownFieldReport = buildNodeOperationsReport({
    ...validInput(),
    extra: true,
  });
  const symbolInput: Record<PropertyKey, unknown> = {
    audit: {
      events: [event({ sequence: 1 })],
    },
    health: {
      report: healthyReport(),
      thresholds: DEFAULT_THRESHOLDS,
    },
  };

  symbolInput[Symbol("extra")] = true;

  const symbolReport = buildNodeOperationsReport(symbolInput);

  assert.equal(unknownFieldReport.verdict, "critical");
  assertSectionError(unknownFieldReport, "health", "INVALID_OPERATIONS_INPUT");
  assertIssueIncludes(unknownFieldReport, "Unknown operations report input field", "extra");
  assert.equal(symbolReport.verdict, "critical");
  assertSectionError(symbolReport, "audit", "INVALID_OPERATIONS_INPUT");
});

function validInput(
  overrides: {
    readonly health?: unknown;
    readonly thresholds?: unknown;
    readonly events?: readonly unknown[];
  } = {},
): {
  readonly health: {
    readonly report: unknown;
    readonly thresholds: unknown;
  };
  readonly audit: {
    readonly events: readonly unknown[];
  };
} {
  return {
    audit: {
      events: overrides.events ?? [
        event({ outcome: "committed", sequence: 1 }),
        event({ outcome: "rejected", sequence: 2 }),
      ],
    },
    health: {
      report: overrides.health ?? healthyReport(),
      thresholds: overrides.thresholds ?? DEFAULT_THRESHOLDS,
    },
  };
}

function healthyReport(): NodeHealth {
  return {
    capabilities: [
      {
        name: "storage.disk",
        status: "healthy",
      },
      {
        name: "updates",
        status: "healthy",
      },
    ],
    cpu: {
      total: 100,
      used: 37,
    },
    healthy: true,
    memory: {
      total: 32_768,
      used: 12_288,
    },
    storage: {
      total: 1_099_511_627_776,
      used: 274_877_906_944,
    },
    uptimeSeconds: 86_400,
  };
}

function withCapabilityStatus(
  report: NodeHealth,
  name: string,
  status: CapabilityHealthStatus,
  message?: string,
): NodeHealth {
  return {
    ...report,
    capabilities: report.capabilities.map((capability) => {
      if (capability.name !== name) {
        return capability;
      }

      return {
        ...(message === undefined ? {} : { message }),
        name,
        status,
      };
    }),
  };
}

function event(
  overrides: {
    readonly actorKind?: AuditEvent["actor"]["kind"];
    readonly outcome?: AuditEvent["outcome"];
    readonly sequence?: number;
  } = {},
): AuditEvent {
  return {
    actor: {
      id: `${overrides.actorKind ?? "agent"}:fixture`,
      kind: overrides.actorKind ?? "agent",
    },
    capability: "system.hostname",
    operation: "apply",
    outcome: overrides.outcome ?? "committed",
    reason: "fixture event",
    sequence: overrides.sequence ?? 1,
    timestampMillis: 1_717_171_717_000 + (overrides.sequence ?? 1),
  };
}

function assertHealthSummary(
  report: NodeOperationsReport,
  expectedStatus: "ok" | "warning" | "critical",
): void {
  if (!report.health.ok) {
    assert.fail(`expected health summary: ${JSON.stringify(report.health.error)}`);
  }

  assert.equal(report.health.summary.status, expectedStatus);
}

function assertAuditSummary(
  report: NodeOperationsReport,
  expectedMonotonic: boolean,
): Extract<NodeOperationsReport["audit"], { readonly ok: true }>["summary"] {
  if (!report.audit.ok) {
    assert.fail(`expected audit summary: ${JSON.stringify(report.audit.error)}`);
  }

  assert.equal(report.audit.summary.monotonic, expectedMonotonic);
  return report.audit.summary;
}

function assertSectionError(
  report: NodeOperationsReport,
  section: NodeOperationsSectionName,
  code: NodeOperationsSectionErrorCode,
): void {
  const result = report[section];

  if (result.ok) {
    assert.fail(`expected ${section} section error`);
  }

  assert.equal(result.error.section, section);
  assert.equal(result.error.code, code);
}

function assertIssueIncludes(
  report: NodeOperationsReport,
  ...tokens: readonly string[]
): void {
  const found = report.issues.some((issue) => (
    tokens.every((token) => issue.includes(token))
  ));

  assert.equal(
    found,
    true,
    `expected issue containing ${tokens.join(", ")} in ${JSON.stringify(report.issues)}`,
  );
}
