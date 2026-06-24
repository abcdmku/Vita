import { handleControllerShellRequest } from "./os/x86_64/ts-overlay/usr/lib/vita/ts/vita/controller-shell.ts";
import { diffTransactionPlans } from "./os/x86_64/ts-overlay/usr/lib/vita/ts/vita/transaction-plan-diff.ts";
import { evaluateNodeConfig } from "./os/x86_64/ts-overlay/usr/lib/vita/ts/vita/evaluate.ts";
import { DEFAULT_CAPABILITY_MANIFESTS } from "./os/x86_64/ts-overlay/usr/lib/vita/ts/vita/generated/capability-manifests.generated.ts";

const REG = new Map(Object.entries(DEFAULT_CAPABILITY_MANIFESTS));

const nodeState = {
  capabilities: {
    "hostname.set": { current: "vita-node-7" },
    "files": { error: "unsupported_read_request" },
  },
  capsuleWorkloads: [],
  storageHealth: { devices: [], degraded: false },
  hardwareInventory: { disks: [] },
};

const ports = {
  agent: {
    getHealth: async () => ({ capabilities: ["hostname.set"], healthy: true, startedAt: "2026-06-24T12:00:00.000Z", uptimeSeconds: 10, version: "agentd-test" }),
    getOperations: async () => ["hostname.set"],
    getState: async (cap) => cap === "hostname.set" ? { current: "vita-node-7" } : { current: { mode: "normal" } },
    getNodeState: async () => nodeState,
  },
  apply: async (m, p, b) => ({ body: { applied: [{capability:"hostname.set",index:0}], outcome: "committed", rollbackErrors: [], rolledBack: [] }, status: 200 }),
  diff: (c, d) => diffTransactionPlans(c, d),
  evaluate: (cfg) => evaluateNodeConfig(cfg, REG),
};

const preview = await handleControllerShellRequest(ports, { body: { "hostname.set": { desired: "vita-node-8" } }, method: "POST", path: "/api/preview" });
console.log("PREVIEW:", preview.body);
