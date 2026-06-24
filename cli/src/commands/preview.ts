import { createAgentClient } from "../../../controller/agent-client/src/agent-client.ts";
import type {
  AgentCapabilityState,
  AgentClient,
  AgentTransport,
} from "../../../controller/agent-client/src/agent-client.ts";
import { evaluateNodeConfig } from "../../../runtime/evaluator/src/evaluate.ts";
import type {
  CapabilityManifestRegistry,
  TransactionPlan,
} from "../../../runtime/evaluator/src/evaluate.ts";
import { safeNormalize } from "../../../sdk/typescript/src/safe-normalize.ts";
import type { PlainJson, PlainJsonObject } from "../../../sdk/typescript/src/safe-normalize.ts";
import {
  diffTransactionPlans,
  TransactionPlanDiffError,
} from "../../../sdk/typescript/src/transaction-plan-diff.ts";
import type { TransactionPlanChange } from "../../../sdk/typescript/src/transaction-plan-diff.ts";
import {
  commandFailure,
  commandSuccess,
  formatCaughtError,
  formatEvaluationRejections,
  formatTransactionDiff,
} from "../format.ts";
import { DEFAULT_AGENTD_BASE_URL } from "../agentd-transport.ts";
import { defaultCapabilityRegistry } from "./evaluate.ts";
import type { CliCommandResult } from "../format.ts";

export interface PreviewCommandOptions {
  readonly client: Pick<AgentClient, "getOperations" | "getState">;
  readonly registry?: CapabilityManifestRegistry;
}

export type PreviewComputationResult =
  | {
      readonly ok: true;
      readonly currentPlan: TransactionPlan;
      readonly desiredPlan: TransactionPlan;
      readonly change: TransactionPlanChange;
    }
  | {
      readonly ok: false;
      readonly message: string;
    };

const CURRENT_STATE_FIELDS: Readonly<Record<string, string>> = Object.freeze({
  "accounts.config": "config",
  "backup.policy": "policy",
  "capsule.registry": "registry",
  "hostname.set": "current",
  "identity.attestation": "attestation",
  "network.policy": "policy",
  "node.config": "config",
  "pds.sync-state": "state",
  "services.config": "config",
  "storage.layout": "layout",
  "time.set": "current",
  "time.sync": "config",
  "update.plan": "plan",
});

export function createAgentClientForTransport(
  transport: AgentTransport,
  baseUrl: string | URL = DEFAULT_AGENTD_BASE_URL,
): AgentClient {
  return createAgentClient({
    baseUrl,
    transport,
  });
}

export async function runPreviewCommand(
  config: unknown,
  options: PreviewCommandOptions,
): Promise<CliCommandResult> {
  const result = await computePreview(config, options);

  if (!result.ok) {
    return commandFailure(result.message);
  }

  return commandSuccess(formatTransactionDiff(result.change));
}

export async function computePreview(
  config: unknown,
  options: PreviewCommandOptions,
): Promise<PreviewComputationResult> {
  const registry = options.registry ?? defaultCapabilityRegistry();
  const desired = evaluateNodeConfig(config, registry);

  if (!desired.ok) {
    return {
      message: formatEvaluationRejections(desired.rejections),
      ok: false,
    };
  }

  const current = await readCurrentPlan(
    options.client,
    registry,
    desiredCapabilitySet(desired.plan),
  );

  if (!current.ok) {
    return current;
  }

  try {
    return {
      change: diffTransactionPlans(current.currentPlan, desired.plan),
      currentPlan: current.currentPlan,
      desiredPlan: desired.plan,
      ok: true,
    };
  } catch (error) {
    if (error instanceof TransactionPlanDiffError) {
      return {
        message: `Preview failed closed: ${error.message}`,
        ok: false,
      };
    }

    return {
      message: formatCaughtError(error, "Preview failed closed"),
      ok: false,
    };
  }
}

async function readCurrentPlan(
  client: Pick<AgentClient, "getOperations" | "getState">,
  registry: CapabilityManifestRegistry,
  desiredCapabilities: ReadonlySet<string>,
): Promise<
  | {
      readonly ok: true;
      readonly currentPlan: TransactionPlan;
    }
  | {
      readonly ok: false;
      readonly message: string;
    }
> {
  let operations: readonly string[];

  try {
    operations = await client.getOperations();
  } catch (error) {
    return {
      message: formatCaughtError(error, "Preview failed to read agent operations"),
      ok: false,
    };
  }

  const currentConfig: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  const sortedOperations = [...operations].sort(compareStrings);

  for (let index = 0; index < sortedOperations.length; index += 1) {
    const capability = sortedOperations[index];

    if (capability === undefined || !registry.has(capability)) {
      continue;
    }

    let state: AgentCapabilityState;

    try {
      state = await client.getState(capability);
    } catch (error) {
      return {
        message: formatCaughtError(error, `Preview failed to read ${capability}`),
        ok: false,
      };
    }

    const desired = extractCurrentDesired(
      capability,
      state,
      desiredCapabilities.has(capability),
    );

    if (!desired.ok) {
      return {
        message: `Preview failed to map ${capability} current state: ${desired.reason}`,
        ok: false,
      };
    }

    if (desired.value !== undefined) {
      Object.defineProperty(currentConfig, capability, {
        configurable: true,
        enumerable: true,
        value: {
          desired: desired.value,
        },
        writable: true,
      });
    }
  }

  if (Object.keys(currentConfig).length === 0) {
    return {
      currentPlan: Object.freeze({
        operations: Object.freeze([]),
      }),
      ok: true,
    };
  }

  const evaluated = evaluateNodeConfig(currentConfig, registry);

  if (!evaluated.ok) {
    return {
      message: `Preview current state failed validation:\n${formatEvaluationRejections(evaluated.rejections)}`,
      ok: false,
    };
  }

  return {
    currentPlan: evaluated.plan,
    ok: true,
  };
}

function extractCurrentDesired(
  capability: string,
  state: AgentCapabilityState,
  includeLiveOnlyCapability: boolean,
):
  | {
      readonly ok: true;
      readonly value: PlainJson | undefined;
    }
  | {
      readonly ok: false;
      readonly reason: string;
    } {
  const normalized = safeNormalize(state);

  if (!normalized.ok) {
    return {
      ok: false,
      reason: normalized.reason,
    };
  }
  if (!isPlainObject(normalized.value)) {
    return {
      ok: false,
      reason: "state must be an object",
    };
  }

  const exists = readField(normalized.value, "exists");
  if (exists !== undefined) {
    if (typeof exists !== "boolean") {
      return {
        ok: false,
        reason: "exists must be a boolean when present",
      };
    }
    if (!exists) {
      return {
        ok: true,
        value: undefined,
      };
    }
  } else if (!includeLiveOnlyCapability) {
    return {
      ok: true,
      value: undefined,
    };
  }

  const fieldName = CURRENT_STATE_FIELDS[capability];
  if (fieldName === undefined) {
    return {
      ok: false,
      reason: "capability has no current-state mapping",
    };
  }

  const value = readField(normalized.value, fieldName);
  if (value === undefined) {
    return {
      ok: false,
      reason: `missing ${fieldName} field`,
    };
  }

  return {
    ok: true,
    value,
  };
}

function desiredCapabilitySet(plan: TransactionPlan): ReadonlySet<string> {
  const capabilities = new Set<string>();

  for (let index = 0; index < plan.operations.length; index += 1) {
    const operation = plan.operations[index];

    if (operation !== undefined) {
      capabilities.add(operation.capability);
    }
  }

  return capabilities;
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

function compareStrings(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}
