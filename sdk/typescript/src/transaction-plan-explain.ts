import type { TransactionPlanChange } from "./transaction-plan-diff.ts";

export function explainTransactionPlanChange(
  change: TransactionPlanChange,
): readonly string[] {
  const lines: string[] = [];

  appendCapabilityLines(lines, "+ adds capability", change.added);
  appendCapabilityLines(lines, "- removes capability", change.removed);
  appendCapabilityLines(lines, "~ changes capability", change.changed);

  if (lines.length === 0) {
    return Object.freeze(["no changes"]);
  }

  return Object.freeze(lines);
}

function appendCapabilityLines(
  lines: string[],
  prefix: string,
  capabilities: readonly string[],
): void {
  const sorted = [...capabilities].sort(compareStrings);

  for (let index = 0; index < sorted.length; index += 1) {
    const capability = sorted[index];

    if (capability !== undefined) {
      lines.push(`${prefix} ${capability}`);
    }
  }
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
