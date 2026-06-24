import { evaluateNodeConfig } from "../../../runtime/evaluator/src/evaluate.ts";
import { DEFAULT_CAPABILITY_MANIFESTS } from "../../../sdk/typescript/src/generated/capability-manifests.generated.ts";
import {
  canonicalJson,
  commandFailure,
  commandSuccess,
  formatEvaluationRejections,
  formatPlanSummary,
} from "../format.ts";
import type { CapabilityManifest } from "../../../sdk/typescript/src/capability-manifest.ts";
import type {
  CapabilityManifestRegistry,
} from "../../../runtime/evaluator/src/evaluate.ts";
import type { CliCommandResult } from "../format.ts";

export interface EvaluateCommandOptions {
  readonly json?: boolean;
  readonly registry?: CapabilityManifestRegistry;
}

export function defaultCapabilityRegistry(): CapabilityManifestRegistry {
  return new Map<string, CapabilityManifest>(Object.entries(DEFAULT_CAPABILITY_MANIFESTS));
}

export function runEvaluateCommand(
  config: unknown,
  options: EvaluateCommandOptions = {},
): CliCommandResult {
  const result = evaluateNodeConfig(config, options.registry ?? defaultCapabilityRegistry());

  if (!result.ok) {
    return commandFailure(formatEvaluationRejections(result.rejections));
  }

  return commandSuccess(
    options.json === true ? canonicalJson(result.plan) : formatPlanSummary(result.plan),
  );
}
