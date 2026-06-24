import { evaluateNodeConfig } from "../../../runtime/evaluator/src/evaluate.ts";
import { defaultCapabilityRegistry } from "../../../sdk/typescript/src/capability-manifest.ts";
import {
  diffTransactionPlans,
} from "../../../sdk/typescript/src/transaction-plan-diff.ts";
import {
  handleControllerShellRequest as handleSharedControllerShellRequest,
} from "../../../sdk/typescript/src/controller-shell.ts";
import type {
  CapabilityManifestRegistry,
  TransactionPlan,
} from "../../../runtime/evaluator/src/evaluate.ts";
import type { AgentClient } from "../../agent-client/src/agent-client.ts";
import type { ApplyNodeTransport } from "../../apply-node/src/apply-node-config.ts";
import type {
  ControllerShellPorts,
  ControllerShellRequest,
  ControllerShellResponse,
  ControllerShellTransactionPlan,
} from "../../../sdk/typescript/src/controller-shell.ts";

export type ControllerShellClient = Pick<AgentClient, "getHealth" | "getOperations" | "getState">;

export interface ControllerShellOptions {
  readonly client: ControllerShellClient;
  readonly apply: ApplyNodeTransport;
  readonly registry?: CapabilityManifestRegistry;
}

export function createControllerShellPorts(
  options: ControllerShellOptions,
): ControllerShellPorts {
  const registry = options.registry ?? defaultCapabilityRegistry();

  return {
    agent: options.client,
    apply: async (method, path, body) => options.apply(
      method,
      path,
      body as unknown as TransactionPlan,
    ),
    diff: (current, desired) => diffTransactionPlans(
      current as unknown as TransactionPlan,
      desired as unknown as TransactionPlan,
    ),
    evaluate: (config) => evaluateNodeConfig(config, registry),
  };
}

export function handleControllerShellRequest(
  ports: ControllerShellPorts,
  request: ControllerShellRequest | unknown,
): Promise<ControllerShellResponse> {
  return handleSharedControllerShellRequest(ports, request);
}

export function createControllerShellHandler(
  options: ControllerShellOptions,
): (request: ControllerShellRequest | unknown) => Promise<ControllerShellResponse> {
  const ports = createControllerShellPorts(options);

  return (request) => handleSharedControllerShellRequest(ports, request);
}

export type {
  ControllerShellPorts,
  ControllerShellRequest,
  ControllerShellResponse,
  ControllerShellTransactionPlan,
};
