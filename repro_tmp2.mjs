import { handleControllerShellRequest } from "./os/x86_64/ts-overlay/usr/lib/vita/ts/vita/controller-shell.ts";
import { diffTransactionPlans } from "./os/x86_64/ts-overlay/usr/lib/vita/ts/vita/transaction-plan-diff.ts";
import { evaluateNodeConfig } from "./os/x86_64/ts-overlay/usr/lib/vita/ts/vita/evaluate.ts";
import { DEFAULT_CAPABILITY_MANIFESTS } from "./os/x86_64/ts-overlay/usr/lib/vita/ts/vita/generated/capability-manifests.generated.ts";

const REG = new Map(Object.entries(DEFAULT_CAPABILITY_MANIFESTS));

function makePorts(nodeState) {
  return {
    agent: {
      getHealth: async () => ({ capabilities: ["hostname.set"], healthy: true, startedAt: "2026-06-24T12:00:00.000Z", uptimeSeconds: 10, version: "agentd-test" }),
      getOperations: async () => ["hostname.set"],
      getState: async (cap) => cap === "hostname.set" ? { current: "vita-node-7" } : { current: { mode: "normal" } },
      getNodeState: async () => nodeState,
    },
    apply: async () => ({ body: { applied: [{capability:"hostname.set",index:0}], outcome: "committed", rollbackErrors: [], rolledBack: [] }, status: 200 }),
    diff: (c, d) => diffTransactionPlans(c, d),
    evaluate: (cfg) => evaluateNodeConfig(cfg, REG),
  };
}

// Case A: only storageHealth removed -> should pass
const A = makePorts({ capabilities: { "hostname.set": { current: "vita-node-7" }, "files": { error: "unsupported_read_request" } }, capsuleWorkloads: [] });
console.log("A (no new fields):", (await handleControllerShellRequest(A, { body: { "hostname.set": { desired: "vita-node-8" } }, method: "POST", path: "/api/preview" })).body);

// Case B: files capability state with a real grant shape including export grant (e.g. config w/ grants array)
const B = makePorts({ capabilities: { "hostname.set": { current: "vita-node-7" }, "files": { current: { grants: [{ name: "runtime-files", root: "owner", access: "rw" }, { name: "export", root: "export", access: "rw" }] } } }, capsuleWorkloads: [] });
console.log("B (files w/ export grant, no new envelope fields):", (await handleControllerShellRequest(B, { body: { "hostname.set": { desired: "vita-node-8" } }, method: "POST", path: "/api/preview" })).body);
