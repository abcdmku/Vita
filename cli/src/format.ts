import { explainTransactionPlanChange } from "../../sdk/typescript/src/transaction-plan-explain.ts";
import type { ApplyNodeApplyResult, ApplyNodeConfigResult } from "../../controller/apply-node/src/apply-node-config.ts";
import type { AgentHealth } from "../../controller/agent-client/src/agent-client.ts";
import type { CapsuleChangePreview } from "../../controller/capsule/src/capsule-preview.ts";
import type { CapsuleRegistry } from "../../sdk/typescript/src/capsule-registry-model.ts";
import type { EvaluationRejection, TransactionPlan } from "../../runtime/evaluator/src/evaluate.ts";
import type { TransactionPlanChange } from "../../sdk/typescript/src/transaction-plan-diff.ts";

export interface CliCommandResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

export function commandSuccess(stdout: string): CliCommandResult {
  return {
    exitCode: 0,
    stderr: "",
    stdout,
  };
}

export function commandFailure(stderr: string, stdout = ""): CliCommandResult {
  return {
    exitCode: 1,
    stderr,
    stdout,
  };
}

export function canonicalJson(value: unknown): string {
  return stableStringify(value);
}

export function formatPlanSummary(plan: TransactionPlan): string {
  const lines = [`TransactionPlan: operations=${plan.operations.length}`];

  for (let index = 0; index < plan.operations.length; index += 1) {
    const operation = plan.operations[index];

    if (operation !== undefined) {
      lines.push(`- ${operation.capability}`);
    }
  }

  return lines.join("\n");
}

export function formatEvaluationRejections(
  rejections: readonly EvaluationRejection[],
): string {
  const lines = ["Evaluation rejected:"];

  for (let index = 0; index < rejections.length; index += 1) {
    const rejection = rejections[index];

    if (rejection === undefined) {
      continue;
    }

    const path = rejection.path === "" ? "<root>" : rejection.path;
    const capability = rejection.capability === undefined ? "" : ` capability=${rejection.capability}`;
    lines.push(`- ${rejection.code} path=${path}${capability}: ${rejection.message}`);
  }

  return lines.join("\n");
}

export function formatTransactionDiff(change: TransactionPlanChange): string {
  const lines = [
    `Preview: added=${change.added.length} removed=${change.removed.length} changed=${change.changed.length}`,
    ...explainTransactionPlanChange(change),
  ];

  return lines.join("\n");
}

export function formatApplyNodeResult(result: ApplyNodeConfigResult): string {
  if (result.ok) {
    return formatApplyResult(result.applyResult);
  }

  if (result.stage === "evaluate") {
    return formatEvaluationRejections(result.rejections);
  }

  if (result.stage === "transport") {
    return "Apply failed at transport: agentd transport request failed.";
  }

  const lines = [`Apply failed: ${result.reason}`];
  if (result.status !== undefined) {
    lines.push(`status=${result.status}`);
  }
  if (result.applyResult !== undefined) {
    lines.push(formatApplyResult(result.applyResult));
  }

  return lines.join("\n");
}

export function formatApplyResult(result: ApplyNodeApplyResult): string {
  const lines = [
    `Apply outcome: ${result.outcome}`,
    `applied=${result.applied.length} rolledBack=${result.rolledBack.length} rollbackErrors=${result.rollbackErrors.length}`,
  ];

  if (result.error !== undefined) {
    lines.push(`error=${result.error.code}: ${result.error.message}`);
  }
  if (result.auditUnrecorded !== undefined) {
    lines.push(`auditUnrecorded=${result.auditUnrecorded ? "true" : "false"}`);
  }

  return lines.join("\n");
}

export function formatCapsulePreview(preview: CapsuleChangePreview): string {
  if (!preview.valid) {
    const lines = ["Capsule preview rejected:"];

    for (let index = 0; index < preview.rejections.length; index += 1) {
      const rejection = preview.rejections[index];

      if (rejection !== undefined) {
        const path = rejection.path === "" ? "<root>" : rejection.path;
        lines.push(
          `- ${rejection.source}:${rejection.code} path=${path}: ${rejection.message}`,
        );
      }
    }

    return lines.join("\n");
  }

  return (
    "Capsule preview: " +
    `installed=${Object.keys(preview.diff.installed).length} ` +
    `removed=${Object.keys(preview.diff.removed).length} ` +
    `upgraded=${Object.keys(preview.diff.upgraded).length} ` +
    `downgraded=${Object.keys(preview.diff.downgraded).length} ` +
    `stateChanged=${Object.keys(preview.diff.stateChanged).length} ` +
    `integrityChanged=${preview.integrityChanged ? "true" : "false"}`
  );
}

export function formatCapsuleList(registry: CapsuleRegistry): string {
  const sorted = [...registry].sort((left, right) => compareStrings(left.id, right.id));
  const lines = [`Capsules: count=${sorted.length}`];

  for (let index = 0; index < sorted.length; index += 1) {
    const entry = sorted[index];

    if (entry !== undefined) {
      lines.push(
        `- ${entry.id} version=${entry.version} state=${entry.state} integrity=${entry.integrity}`,
      );
    }
  }

  return lines.join("\n");
}

export function formatStateOverview(
  health: AgentHealth,
  operations: readonly string[],
): string {
  const lines = [
    `Agent health: healthy=${health.healthy ? "true" : "false"} version=${health.version} uptimeSeconds=${health.uptimeSeconds}`,
    `Capabilities: count=${operations.length}`,
  ];

  const sorted = [...operations].sort(compareStrings);
  for (let index = 0; index < sorted.length; index += 1) {
    const capability = sorted[index];

    if (capability !== undefined) {
      lines.push(`- ${capability}`);
    }
  }

  return lines.join("\n");
}

export function formatCapabilityState(capability: string, state: unknown): string {
  return `State: ${capability}\n${canonicalJson(state)}`;
}

export function formatCaughtError(error: unknown, fallback: string): string {
  const message = safeErrorMessage(error);

  return message === "" ? fallback : `${fallback}: ${message}`;
}

function safeErrorMessage(error: unknown): string {
  if (typeof error === "string") {
    return error;
  }

  if (error === null || (typeof error !== "object" && typeof error !== "function")) {
    return "";
  }

  try {
    const descriptor = Object.getOwnPropertyDescriptor(error, "message");

    if (descriptor !== undefined && Object.hasOwn(descriptor, "value") && typeof descriptor.value === "string") {
      return descriptor.value;
    }
  } catch {
    return "";
  }

  return "";
}

function stableStringify(value: unknown): string {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    const items: string[] = [];

    for (let index = 0; index < value.length; index += 1) {
      const item = value[index];
      items.push(item === undefined ? "null" : stableStringify(item));
    }

    return `[${items.join(",")}]`;
  }

  if (value === undefined || typeof value !== "object") {
    return JSON.stringify(null);
  }

  const record = value as Readonly<Record<string, unknown>>;
  const keys = Object.keys(record).sort(compareStrings);
  const entries: string[] = [];

  for (let index = 0; index < keys.length; index += 1) {
    const key = keys[index];

    if (key !== undefined) {
      const child = record[key];
      if (child !== undefined) {
        entries.push(`${JSON.stringify(key)}:${stableStringify(child)}`);
      }
    }
  }

  return `{${entries.join(",")}}`;
}

function compareStrings(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}
