import type { AgentClient } from "../../../controller/agent-client/src/agent-client.ts";
import { safeNormalize } from "../../../sdk/typescript/src/safe-normalize.ts";
import {
  commandFailure,
  commandSuccess,
  formatCapabilityState,
  formatCaughtError,
  formatStateOverview,
} from "../format.ts";
import type { PlainJsonObject } from "../../../sdk/typescript/src/safe-normalize.ts";
import type { CliCommandResult } from "../format.ts";

export interface StateCommandOptions {
  readonly client: Pick<AgentClient, "getHealth" | "getOperations" | "getState">;
  readonly capability?: string;
}

export async function runStateCommand(
  options: StateCommandOptions,
): Promise<CliCommandResult> {
  if (options.capability !== undefined) {
    return readCapabilityState(options.client, options.capability);
  }

  try {
    const [operations, health] = await Promise.all([
      options.client.getOperations(),
      options.client.getHealth(),
    ]);

    return commandSuccess(formatStateOverview(health, operations));
  } catch (error) {
    return commandFailure(formatCaughtError(error, "State overview read failed"));
  }
}

async function readCapabilityState(
  client: Pick<AgentClient, "getState">,
  capability: string,
): Promise<CliCommandResult> {
  try {
    const state = await client.getState(capability);
    const normalized = safeNormalize(state);

    if (!normalized.ok || !isPlainObject(normalized.value)) {
      const reason = normalized.ok ? "state must be an object" : normalized.reason;
      return commandFailure(`Capability state is malformed: ${reason}`);
    }

    return commandSuccess(formatCapabilityState(capability, normalized.value));
  } catch (error) {
    return commandFailure(formatCaughtError(error, `State read failed for ${capability}`));
  }
}

function isPlainObject(value: unknown): value is PlainJsonObject {
  return value !== undefined && value !== null && typeof value === "object" && !Array.isArray(value);
}
