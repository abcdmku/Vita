import { applyNodeConfig } from "../../../controller/apply-node/src/apply-node-config.ts";
import type { ApplyNodeTransport } from "../../../controller/apply-node/src/apply-node-config.ts";
import type { AgentClient } from "../../../controller/agent-client/src/agent-client.ts";
import {
  previewCapsuleChange,
} from "../../../controller/capsule/src/capsule-preview.ts";
import {
  validateCapsuleRegistry,
} from "../../../sdk/typescript/src/capsule-registry-model.ts";
import type { CapsuleRegistry } from "../../../sdk/typescript/src/capsule-registry-model.ts";
import { safeNormalize } from "../../../sdk/typescript/src/safe-normalize.ts";
import type { PlainJson, PlainJsonObject } from "../../../sdk/typescript/src/safe-normalize.ts";
import type { CapabilityManifestRegistry } from "../../../runtime/evaluator/src/evaluate.ts";
import {
  commandFailure,
  commandSuccess,
  formatApplyNodeResult,
  formatCapsuleList,
  formatCapsulePreview,
  formatCaughtError,
} from "../format.ts";
import { defaultCapabilityRegistry } from "./evaluate.ts";
import type { CliCommandResult } from "../format.ts";

export interface CapsuleReadOptions {
  readonly client: Pick<AgentClient, "getState">;
}

export interface CapsuleInstallOptions extends CapsuleReadOptions {
  readonly commit: boolean;
  readonly transport: ApplyNodeTransport;
  readonly registry?: CapabilityManifestRegistry;
}

const CAPSULE_REGISTRY_CAPABILITY = "capsule.registry";
const EMPTY_CAPSULE_REGISTRY = Object.freeze([]) satisfies CapsuleRegistry;

export async function runCapsuleListCommand(
  options: CapsuleReadOptions,
): Promise<CliCommandResult> {
  const current = await readCurrentCapsuleRegistry(options.client);

  if (!current.ok) {
    return commandFailure(current.reason);
  }

  return commandSuccess(formatCapsuleList(current.registry));
}

export async function runCapsulePreviewCommand(
  desiredInput: unknown,
  options: CapsuleReadOptions,
): Promise<CliCommandResult> {
  const current = await readCurrentCapsuleRegistry(options.client);

  if (!current.ok) {
    return commandFailure(current.reason);
  }

  const desired = normalizeDesiredRegistryInput(desiredInput);
  const preview = previewCapsuleChange(current.registry, desired);

  if (!preview.valid) {
    return commandFailure(formatCapsulePreview(preview));
  }

  return commandSuccess(formatCapsulePreview(preview));
}

export async function runCapsuleInstallCommand(
  desiredInput: unknown,
  options: CapsuleInstallOptions,
): Promise<CliCommandResult> {
  if (!options.commit) {
    const preview = await runCapsulePreviewCommand(desiredInput, options);

    if (preview.exitCode !== 0) {
      return preview;
    }

    return commandSuccess(`dry-run (pass --commit to apply)\n${preview.stdout}`);
  }

  const desired = validateCapsuleRegistry(normalizeDesiredRegistryInput(desiredInput));

  if (!desired.ok) {
    return commandFailure(formatCapsuleRegistryErrors("Capsule registry rejected", desired.errors));
  }

  const config = {
    "capsule.registry": {
      desired: {
        capsules: desired.registry,
      },
    },
  };
  const result = await applyNodeConfig(
    config,
    options.registry ?? defaultCapabilityRegistry(),
    options.transport,
  );
  const text = formatApplyNodeResult(result);

  if (!result.ok || result.applyResult.outcome !== "committed") {
    return commandFailure(text);
  }

  return commandSuccess(text);
}

async function readCurrentCapsuleRegistry(
  client: Pick<AgentClient, "getState">,
): Promise<
  | {
      readonly ok: true;
      readonly registry: CapsuleRegistry;
    }
  | {
      readonly ok: false;
      readonly reason: string;
    }
> {
  let state: unknown;

  try {
    state = await client.getState(CAPSULE_REGISTRY_CAPABILITY);
  } catch (error) {
    return {
      ok: false,
      reason: formatCaughtError(error, "Capsule registry read failed"),
    };
  }

  return parseCapsuleRegistryState(state);
}

function parseCapsuleRegistryState(
  state: unknown,
):
  | {
      readonly ok: true;
      readonly registry: CapsuleRegistry;
    }
  | {
      readonly ok: false;
      readonly reason: string;
    } {
  const normalized = safeNormalize(state);

  if (!normalized.ok) {
    return {
      ok: false,
      reason: `Capsule registry state is malformed: ${normalized.reason}`,
    };
  }
  if (!isPlainObject(normalized.value)) {
    return {
      ok: false,
      reason: "Capsule registry state must be an object.",
    };
  }

  const exists = readField(normalized.value, "exists");
  if (exists !== undefined) {
    if (typeof exists !== "boolean") {
      return {
        ok: false,
        reason: "Capsule registry state exists must be a boolean.",
      };
    }
    if (!exists) {
      return {
        ok: true,
        registry: EMPTY_CAPSULE_REGISTRY,
      };
    }
  }

  const registryValue = readField(normalized.value, "registry");
  if (!isPlainObject(registryValue)) {
    return {
      ok: false,
      reason: "Capsule registry state registry must be an object.",
    };
  }

  const capsules = readField(registryValue, "capsules");
  const result = validateCapsuleRegistry(capsules);

  if (!result.ok) {
    return {
      ok: false,
      reason: "Capsule registry state registry failed validation.",
    };
  }

  return {
    ok: true,
    registry: result.registry,
  };
}

function normalizeDesiredRegistryInput(input: unknown): unknown {
  const normalized = safeNormalize(input);

  if (!normalized.ok || !isPlainObject(normalized.value)) {
    return input;
  }

  const keys = Object.keys(normalized.value);
  if (keys.length !== 1 || keys[0] !== "capsules") {
    return input;
  }

  return readField(normalized.value, "capsules");
}

function formatCapsuleRegistryErrors(
  title: string,
  errors: readonly { readonly path: string; readonly message: string }[],
): string {
  const lines = [`${title}:`];

  for (let index = 0; index < errors.length; index += 1) {
    const error = errors[index];

    if (error !== undefined) {
      const path = error.path === "" ? "<root>" : error.path;
      lines.push(`- path=${path}: ${error.message}`);
    }
  }

  return lines.join("\n");
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
