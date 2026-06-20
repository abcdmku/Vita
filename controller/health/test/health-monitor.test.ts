import assert from "node:assert/strict";
import { test } from "node:test";

import { summarizeNodeHealth } from "../src/health-monitor.ts";
import type {
  HealthMonitorRejection,
  NodeHealthSummaryResult,
  ResourceUsageThresholds,
} from "../src/health-monitor.ts";
import type {
  CapabilityHealthStatus,
  NodeHealth,
} from "../../../sdk/typescript/src/node-health-model.ts";

const DEFAULT_THRESHOLDS: ResourceUsageThresholds = Object.freeze({
  cpu: 0.8,
  memory: 0.8,
  storage: 0.8,
});

test("healthy report under thresholds summarizes as ok", () => {
  const result = assertSummary(healthyReport(), DEFAULT_THRESHOLDS);

  assert.equal(result.status, "ok");
  assert.deepEqual(result.capabilityIssues, []);
  assert.deepEqual(result.resourceIssues, []);
});

test("degraded capabilities summarize as warning issues", () => {
  const report = withCapabilityStatus(
    healthyReport(),
    "updates",
    "degraded",
    "queue latency above target",
  );
  const result = assertSummary(report, DEFAULT_THRESHOLDS);

  assert.equal(result.status, "warning");
  assert.deepEqual(result.capabilityIssues, [
    {
      message: "queue latency above target",
      name: "updates",
      status: "degraded",
    },
  ]);
  assert.deepEqual(result.resourceIssues, []);
});

test("failed capabilities make the summary critical", () => {
  const report = withCapabilityStatus(healthyReport(), "storage.disk", "failed");
  const result = assertSummary(report, DEFAULT_THRESHOLDS);

  assert.equal(result.status, "critical");
  assert.deepEqual(result.capabilityIssues, [
    {
      name: "storage.disk",
      status: "failed",
    },
  ]);
  assert.deepEqual(result.resourceIssues, []);
});

test("resources over threshold summarize as warning resource issues", () => {
  const report = {
    ...healthyReport(),
    memory: {
      total: 100,
      used: 91,
    },
  };
  const result = assertSummary(report, DEFAULT_THRESHOLDS);

  assert.equal(result.status, "warning");
  assert.deepEqual(result.capabilityIssues, []);
  assert.deepEqual(result.resourceIssues, [
    {
      fraction: 0.91,
      resource: "memory",
      threshold: 0.8,
      total: 100,
      used: 91,
    },
  ]);
});

test("invalid reports return typed rejections without throwing", () => {
  assert.doesNotThrow(() => {
    const report: Partial<NodeHealth> = {
      healthy: true,
      uptimeSeconds: 12,
    };
    const result = summarizeNodeHealth(report, DEFAULT_THRESHOLDS);

    assertRejectionPaths(result, ["capabilities", "cpu", "memory", "storage"]);
  });
});

test("thresholds must be present fractions in the open interval", () => {
  const result = summarizeNodeHealth(healthyReport(), {
    cpu: 0,
    memory: 1,
    storage: -0.1,
  });

  assertRejectionPaths(result, [
    "thresholds/cpu",
    "thresholds/memory",
    "thresholds/storage",
  ]);
});

test("hostile inputs fail closed without invoking attacker-controlled behavior", () => {
  const shadowedReport = mutableReport();
  const shadowedCapabilities = [...shadowedReport.capabilities];
  Object.defineProperty(shadowedCapabilities, "map", {
    enumerable: true,
    value() {
      assert.fail("shadowed array method must not be invoked");
    },
  });
  shadowedReport.capabilities = shadowedCapabilities;

  const accessorThresholds: Record<string, unknown> = {
    memory: 0.8,
    storage: 0.8,
  };
  let getterReads = 0;
  Object.defineProperty(accessorThresholds, "cpu", {
    enumerable: true,
    get() {
      getterReads += 1;
      throw new Error("getter must not be read");
    },
  });

  assert.doesNotThrow(() => {
    const result = summarizeNodeHealth(shadowedReport, accessorThresholds);

    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.rejections.length > 0, true);
    }
  });
  assert.equal(getterReads, 0);
});

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

function mutableReport(): MutableNodeHealth {
  const report = healthyReport();

  return {
    capabilities: report.capabilities.map((capability) => ({
      ...(capability.message === undefined ? {} : { message: capability.message }),
      name: capability.name,
      status: capability.status,
    })),
    cpu: {
      total: report.cpu.total,
      used: report.cpu.used,
    },
    healthy: report.healthy,
    memory: {
      total: report.memory.total,
      used: report.memory.used,
    },
    storage: {
      total: report.storage.total,
      used: report.storage.used,
    },
    uptimeSeconds: report.uptimeSeconds,
  };
}

function assertSummary(
  report: unknown,
  thresholds: unknown,
): Extract<NodeHealthSummaryResult, { readonly ok: true }> {
  const result = summarizeNodeHealth(report, thresholds);

  if (!result.ok) {
    assert.fail(`expected health summary: ${JSON.stringify(result.rejections)}`);
  }

  return result;
}

function assertRejectionPaths(
  result: NodeHealthSummaryResult,
  expectedPaths: readonly string[],
): void {
  if (result.ok) {
    assert.fail(`expected health summary rejection: ${JSON.stringify(result)}`);
  }

  assert.deepEqual(rejectionPaths(result.rejections), expectedPaths);
}

function rejectionPaths(rejections: readonly HealthMonitorRejection[]): readonly string[] {
  return rejections.map((rejection) => rejection.path).sort();
}

interface MutableNodeHealth extends Record<string, unknown> {
  capabilities: Array<{
    name: string;
    status: CapabilityHealthStatus;
    message?: string;
  }>;
  cpu: {
    total: number;
    used: number;
  };
  healthy: boolean;
  memory: {
    total: number;
    used: number;
  };
  storage: {
    total: number;
    used: number;
  };
  uptimeSeconds: number;
}
