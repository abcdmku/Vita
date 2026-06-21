import {
  compileCapabilityValidator,
} from "../../../sdk/typescript/src/capability-manifest.ts";
import { safeNormalize } from "../../../sdk/typescript/src/safe-normalize.ts";
import type {
  CapabilityManifest,
  CapabilityRecord,
} from "../../../sdk/typescript/src/capability-manifest.ts";
import type {
  PlainJson,
  PlainJsonObject,
} from "../../../sdk/typescript/src/safe-normalize.ts";

export type CapabilityManifestRegistry = ReadonlyMap<string, CapabilityManifest>;

export interface PlanOperation {
  readonly capability: string;
  readonly request: CapabilityRecord;
}

export interface TransactionPlan {
  readonly operations: readonly PlanOperation[];
}

export type EvaluationRejectionCode =
  | "INVALID_CONFIG"
  | "EMPTY_CONFIG"
  | "UNKNOWN_CAPABILITY"
  | "INVALID_CAPABILITY_REQUEST";

export interface EvaluationRejection {
  readonly code: EvaluationRejectionCode;
  readonly path: string;
  readonly message: string;
  readonly capability?: string;
}

export type EvaluationResult =
  | {
      readonly ok: true;
      readonly plan: TransactionPlan;
    }
  | {
      readonly ok: false;
      readonly rejections: readonly EvaluationRejection[];
    };

export function evaluateNodeConfig(
  config: unknown,
  registry: CapabilityManifestRegistry,
): EvaluationResult {
  try {
    const normalized = safeNormalize(config);

    if (!normalized.ok) {
      return reject([
        configRejection(
          "INVALID_CONFIG",
          "",
          `Invalid untrusted config: ${normalized.reason}`,
        ),
      ]);
    }

    if (!isConfigRecord(normalized.value)) {
      return reject([
        configRejection("INVALID_CONFIG", "", "Expected node config object."),
      ]);
    }

    const capabilityNames = Object.keys(normalized.value).sort(compareStrings);

    if (capabilityNames.length === 0) {
      return reject([
        configRejection("EMPTY_CONFIG", "", "Node config must include at least one capability."),
      ]);
    }

    const operations: PlanOperation[] = [];
    const rejections: EvaluationRejection[] = [];

    for (let index = 0; index < capabilityNames.length; index += 1) {
      const capability = capabilityNames[index];

      if (capability === undefined) {
        continue;
      }

      const manifest = registry.get(capability);

      if (manifest === undefined) {
        rejections.push(
          capabilityRejection(
            "UNKNOWN_CAPABILITY",
            capability,
            escapePathToken(capability),
            "Capability is not in the manifest registry.",
          ),
        );
        continue;
      }

      const validator = compileCapabilityValidator(manifest);
      const validation = validator(normalized.value[capability]);

      if (!validation.ok) {
        for (let rejectionIndex = 0; rejectionIndex < validation.rejections.length; rejectionIndex += 1) {
          const item = validation.rejections[rejectionIndex];

          if (item === undefined) {
            continue;
          }

          rejections.push(
            capabilityRejection(
              "INVALID_CAPABILITY_REQUEST",
              capability,
              joinCapabilityPath(capability, item.path),
              item.message,
            ),
          );
        }
        continue;
      }

      operations.push({
        capability,
        request: validation.value,
      });
    }

    if (rejections.length > 0) {
      return reject(Object.freeze(rejections));
    }

    return {
      ok: true,
      plan: Object.freeze({
        operations: Object.freeze(operations),
      }),
    };
  } catch {
    return reject([
      configRejection("INVALID_CONFIG", "", "Config evaluation failed closed."),
    ]);
  }
}

function isConfigRecord(value: PlainJson): value is PlainJsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function reject(rejections: readonly EvaluationRejection[]): Extract<EvaluationResult, { readonly ok: false }> {
  return {
    ok: false,
    rejections,
  };
}

function configRejection(
  code: "INVALID_CONFIG" | "EMPTY_CONFIG",
  path: string,
  message: string,
): EvaluationRejection {
  return {
    code,
    message,
    path,
  };
}

function capabilityRejection(
  code: "UNKNOWN_CAPABILITY" | "INVALID_CAPABILITY_REQUEST",
  capability: string,
  path: string,
  message: string,
): EvaluationRejection {
  return {
    capability,
    code,
    message,
    path,
  };
}

function joinCapabilityPath(capability: string, path: string): string {
  const capabilityPath = escapePathToken(capability);

  if (path.length === 0) {
    return capabilityPath;
  }

  return `${capabilityPath}/${path}`;
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
