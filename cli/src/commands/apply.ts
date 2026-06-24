import { applyNodeConfig } from "../../../controller/apply-node/src/apply-node-config.ts";
import type { ApplyNodeTransport } from "../../../controller/apply-node/src/apply-node-config.ts";
import {
  commandFailure,
  commandSuccess,
  formatApplyNodeResult,
} from "../format.ts";
import { computePreview } from "./preview.ts";
import { defaultCapabilityRegistry } from "./evaluate.ts";
import type { AgentClient } from "../../../controller/agent-client/src/agent-client.ts";
import type { CapabilityManifestRegistry } from "../../../runtime/evaluator/src/evaluate.ts";
import type { CliCommandResult } from "../format.ts";

export interface ApplyCommandOptions {
  readonly commit: boolean;
  readonly client: Pick<AgentClient, "getOperations" | "getState">;
  readonly transport: ApplyNodeTransport;
  readonly registry?: CapabilityManifestRegistry;
}

export async function runApplyCommand(
  config: unknown,
  options: ApplyCommandOptions,
): Promise<CliCommandResult> {
  const registry = options.registry ?? defaultCapabilityRegistry();

  if (!options.commit) {
    const preview = await computePreview(config, {
      client: options.client,
      registry,
    });

    if (!preview.ok) {
      return commandFailure(preview.message);
    }

    return commandSuccess(
      `dry-run (pass --commit to apply)\n` +
        `Preview: added=${preview.change.added.length} removed=${preview.change.removed.length} changed=${preview.change.changed.length}`,
    );
  }

  const result = await applyNodeConfig(config, registry, options.transport);
  const text = formatApplyNodeResult(result);

  if (!result.ok || result.applyResult.outcome !== "committed") {
    return commandFailure(text);
  }

  return commandSuccess(text);
}
