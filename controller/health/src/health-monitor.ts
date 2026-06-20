import { validateNodeHealth } from "../../../sdk/typescript/src/node-health-model.ts";
import { safeNormalize } from "../../../sdk/typescript/src/safe-normalize.ts";
import type {
  CapabilityHealthStatus,
  NodeHealth,
  ResourceMetric,
  ValidationError,
} from "../../../sdk/typescript/src/node-health-model.ts";
import type {
  PlainJson,
  PlainJsonObject,
} from "../../../sdk/typescript/src/safe-normalize.ts";

export type NodeHealthSummaryStatus = "ok" | "warning" | "critical";
export type NodeHealthResourceName = "cpu" | "memory" | "storage";
export type CapabilityIssueStatus = Extract<
  CapabilityHealthStatus,
  "degraded" | "failed"
>;

export interface ResourceUsageThresholds {
  readonly cpu: number;
  readonly memory: number;
  readonly storage: number;
}

export interface HealthCapabilityIssue {
  readonly name: string;
  readonly status: CapabilityIssueStatus;
  readonly message?: string;
}

export interface HealthResourceIssue {
  readonly resource: NodeHealthResourceName;
  readonly used: number;
  readonly total: number;
  readonly fraction: number;
  readonly threshold: number;
}

export interface HealthMonitorRejection {
  readonly path: string;
  readonly message: string;
}

export type NodeHealthSummaryResult =
  | {
      readonly ok: true;
      readonly status: NodeHealthSummaryStatus;
      readonly capabilityIssues: readonly HealthCapabilityIssue[];
      readonly resourceIssues: readonly HealthResourceIssue[];
    }
  | {
      readonly ok: false;
      readonly rejections: readonly HealthMonitorRejection[];
    };

type ThresholdValidationResult =
  | {
      readonly ok: true;
      readonly value: ResourceUsageThresholds;
    }
  | {
      readonly ok: false;
      readonly rejections: readonly HealthMonitorRejection[];
    };

const RESOURCE_NAMES = Object.freeze([
  "cpu",
  "memory",
  "storage",
] as const);
const RESOURCE_NAME_SET = new Set<string>(RESOURCE_NAMES);

export function summarizeNodeHealth(
  report: unknown,
  thresholds: unknown,
): NodeHealthSummaryResult {
  try {
    const rejections: HealthMonitorRejection[] = [];
    const reportResult = validateNodeHealth(report);
    const thresholdResult = validateThresholds(thresholds);

    if (!reportResult.ok) {
      appendValidationErrors(rejections, reportResult.errors);
    }

    if (!thresholdResult.ok) {
      appendRejections(rejections, thresholdResult.rejections);
    }

    if (!reportResult.ok || !thresholdResult.ok) {
      return reject(rejections);
    }

    return summarizeValidatedHealth(reportResult.value, thresholdResult.value);
  } catch {
    return reject([
      {
        message: "Node health summary failed.",
        path: "",
      },
    ]);
  }
}

function summarizeValidatedHealth(
  health: NodeHealth,
  thresholds: ResourceUsageThresholds,
): NodeHealthSummaryResult {
  const capabilityIssues = collectCapabilityIssues(health);
  const resourceIssues = collectResourceIssues(health, thresholds);
  const status = summarizeStatus(capabilityIssues, resourceIssues);

  return {
    capabilityIssues,
    ok: true,
    resourceIssues,
    status,
  };
}

function collectCapabilityIssues(
  health: NodeHealth,
): readonly HealthCapabilityIssue[] {
  const issues: HealthCapabilityIssue[] = [];

  for (const capability of health.capabilities) {
    if (capability.status !== "degraded" && capability.status !== "failed") {
      continue;
    }

    issues.push({
      ...(capability.message === undefined ? {} : { message: capability.message }),
      name: capability.name,
      status: capability.status,
    });
  }

  return Object.freeze(issues);
}

function collectResourceIssues(
  health: NodeHealth,
  thresholds: ResourceUsageThresholds,
): readonly HealthResourceIssue[] {
  const issues: HealthResourceIssue[] = [];

  for (const resource of RESOURCE_NAMES) {
    const metric = health[resource];
    const threshold = thresholds[resource];
    const fraction = usedFraction(metric);

    if (fraction > threshold) {
      issues.push({
        fraction,
        resource,
        threshold,
        total: metric.total,
        used: metric.used,
      });
    }
  }

  return Object.freeze(issues);
}

function summarizeStatus(
  capabilityIssues: readonly HealthCapabilityIssue[],
  resourceIssues: readonly HealthResourceIssue[],
): NodeHealthSummaryStatus {
  for (const issue of capabilityIssues) {
    if (issue.status === "failed") {
      return "critical";
    }
  }

  if (capabilityIssues.length > 0 || resourceIssues.length > 0) {
    return "warning";
  }

  return "ok";
}

function usedFraction(metric: ResourceMetric): number {
  if (metric.total === 0) {
    return 0;
  }

  return metric.used / metric.total;
}

function validateThresholds(input: unknown): ThresholdValidationResult {
  const normalized = safeNormalize(input);

  if (!normalized.ok) {
    return rejectThresholds([
      {
        message: `Invalid thresholds input: ${normalized.reason}`,
        path: "thresholds",
      },
    ]);
  }

  if (!isPlainObject(normalized.value)) {
    return rejectThresholds([
      {
        message: "Expected thresholds object.",
        path: "thresholds",
      },
    ]);
  }

  const rejections: HealthMonitorRejection[] = [];
  rejectUnknownThresholdFields(normalized.value, rejections);

  const cpu = readThreshold(normalized.value, "cpu", rejections);
  const memory = readThreshold(normalized.value, "memory", rejections);
  const storage = readThreshold(normalized.value, "storage", rejections);

  if (
    rejections.length > 0 ||
    cpu === undefined ||
    memory === undefined ||
    storage === undefined
  ) {
    return rejectThresholds(rejections);
  }

  return {
    ok: true,
    value: Object.freeze({
      cpu,
      memory,
      storage,
    }),
  };
}

function readThreshold(
  value: PlainJsonObject,
  resource: NodeHealthResourceName,
  rejections: HealthMonitorRejection[],
): number | undefined {
  if (!Object.hasOwn(value, resource)) {
    rejections.push({
      message: "Required threshold is missing.",
      path: thresholdPath(resource),
    });
    return undefined;
  }

  const threshold = value[resource];

  if (typeof threshold !== "number" || threshold <= 0 || threshold >= 1) {
    rejections.push({
      message: "Expected threshold fraction greater than 0 and less than 1.",
      path: thresholdPath(resource),
    });
    return undefined;
  }

  return threshold;
}

function rejectUnknownThresholdFields(
  value: PlainJsonObject,
  rejections: HealthMonitorRejection[],
): void {
  const keys = Object.keys(value).sort(compareStrings);

  for (const key of keys) {
    if (!RESOURCE_NAME_SET.has(key)) {
      rejections.push({
        message: "Unknown threshold field.",
        path: thresholdPath(key),
      });
    }
  }
}

function appendValidationErrors(
  rejections: HealthMonitorRejection[],
  errors: readonly ValidationError[],
): void {
  for (const error of errors) {
    rejections.push({
      message: error.message,
      path: error.path,
    });
  }
}

function appendRejections(
  rejections: HealthMonitorRejection[],
  additions: readonly HealthMonitorRejection[],
): void {
  for (const addition of additions) {
    rejections.push(addition);
  }
}

function isPlainObject(value: PlainJson): value is PlainJsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function reject(
  rejections: readonly HealthMonitorRejection[],
): Extract<NodeHealthSummaryResult, { readonly ok: false }> {
  return {
    ok: false,
    rejections,
  };
}

function rejectThresholds(
  rejections: readonly HealthMonitorRejection[],
): Extract<ThresholdValidationResult, { readonly ok: false }> {
  return {
    ok: false,
    rejections,
  };
}

function thresholdPath(key: string): string {
  return `thresholds/${escapePathToken(key)}`;
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
