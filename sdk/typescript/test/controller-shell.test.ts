import assert from "node:assert/strict";
import { test } from "node:test";

import {
  handleControllerShellRequest,
} from "../src/controller-shell.ts";
import type {
  ControllerShellAgent,
  ControllerShellApplyCaller,
  ControllerShellApplyTransportResponse,
  ControllerShellEvaluationResult,
  ControllerShellPlanDiff,
  ControllerShellPorts,
  ControllerShellResponse,
  ControllerShellTransactionPlan,
} from "../src/controller-shell.ts";
import type { PlainJson, PlainJsonObject } from "../src/safe-normalize.ts";

test("GET / renders escaped measured status HTML", async () => {
  const ports = mockPorts({
    hostname: 'vita<script>"&',
    operations: ["hostname.set", "node.config"],
  });

  const response = await handleControllerShellRequest(ports, {
    method: "GET",
    path: "/",
  });

  assert.equal(response.status, 200);
  assert.equal(response.contentType, "text/html; charset=utf-8");
  assert.match(response.body, /Vita Controller/u);
  assert.match(response.body, /vita&lt;script&gt;&quot;&amp;/u);
  assert.doesNotMatch(response.body, /vita<script>"&/u);
  assert.match(response.body, /<dt>Capabilities<\/dt><dd>2<\/dd>/u);
});

test("GET /api/status returns the same measured status as JSON", async () => {
  const ports = mockPorts({
    hostname: "vita-node-7",
    operations: ["hostname.set", "node.config", "time.sync"],
  });

  const response = await handleControllerShellRequest(ports, {
    method: "GET",
    path: "/api/status",
  });
  const body = parseJsonObject(response);

  assert.equal(response.status, 200);
  assert.equal(body["ok"], true);
  assert.equal(body["reachable"], true);
  assert.equal(body["healthy"], true);
  assert.equal(body["hostname"], "vita-node-7");
  assert.equal(body["caps"], 3);
  assert.deepEqual(body["operations"], ["hostname.set", "node.config", "time.sync"]);
});

test("POST /api/preview returns diff counts and evaluator rejections without mutating", async () => {
  const applyCalls: ApplyCall[] = [];
  const ports = mockPorts({
    applyCalls,
    diff: () => ({
      added: ["hostname.set"],
      changed: ["node.config"],
      removed: ["time.sync"],
    }),
  });

  const response = await handleControllerShellRequest(ports, {
    body: {
      "hostname.set": {
        desired: "vita-node-8",
      },
    },
    method: "POST",
    path: "/api/preview",
  });
  const body = parseJsonObject(response);

  assert.equal(response.status, 200);
  assert.equal(body["ok"], true);
  assert.deepEqual(body["added"], ["hostname.set"]);
  assert.deepEqual(body["removed"], ["time.sync"]);
  assert.deepEqual(body["changed"], ["node.config"]);
  assert.deepEqual(body["rejections"], []);
  assert.deepEqual(applyCalls, []);

  const rejected = await handleControllerShellRequest(ports, {
    body: {
      "reject.capability": {
        desired: true,
      },
    },
    method: "POST",
    path: "/api/preview",
  });
  const rejectedBody = parseJsonObject(rejected);

  assert.equal(rejected.status, 200);
  assert.equal(rejectedBody["ok"], false);
  assert.deepEqual(rejectedBody["rejections"], [
    {
      code: "INVALID_CAPABILITY_REQUEST",
      message: "mock evaluator rejected config",
      path: "/reject.capability",
    },
  ]);
  assert.deepEqual(applyCalls, []);
});

test("POST /api/preview reports a currently configured capability omitted by proposal as removed", async () => {
  const ports = mockPorts({
    hostname: "vita-node-7",
    operations: ["hostname.set"],
    states: {
      "node.config": {
        config: {
          mode: "normal",
          remoteAccess: "disabled",
        },
        exists: true,
      },
    },
  });

  const response = await handleControllerShellRequest(ports, {
    body: {
      "hostname.set": {
        desired: "vita-node-7",
      },
    },
    method: "POST",
    path: "/api/preview",
  });
  const body = parseJsonObject(response);

  assert.equal(response.status, 200);
  assert.equal(body["ok"], true);
  assert.deepEqual(body["added"], []);
  assert.deepEqual(body["changed"], []);
  assert.deepEqual(body["removed"], ["node.config"]);
});

test("POST /api/preview reads current applied plan from node state, not operations", async () => {
  const ports = mockPorts({
    failOperationsRead: true,
    operations: ["hostname.set"],
    states: {
      "node.config": {
        config: {
          mode: "normal",
          remoteAccess: "disabled",
        },
        exists: true,
      },
    },
  });

  const response = await handleControllerShellRequest(ports, {
    body: {
      "hostname.set": {
        desired: "vita-node-7",
      },
    },
    method: "POST",
    path: "/api/preview",
  });
  const body = parseJsonObject(response);

  assert.equal(response.status, 200);
  assert.equal(body["ok"], true);
  assert.deepEqual(body["removed"], ["node.config"]);
});

test("POST /api/preview diffs pds.repo-like current state without payload-key allow-list", async () => {
  const pdsRepoState = {
    commitCursor: 43,
    exists: true,
    log: [],
    records: [
      {
        collection: "app.bsky.actor.profile",
        rkey: "self",
        valueDigest: "2222222222222222222222222222222222222222222222222222222222222222",
      },
    ],
    repo: "did:plc:ewvi7nxzyoun6zhxrhs64oiz",
  };
  const pdsRepoDesired = {
    commitCursor: 43,
    log: [],
    records: [
      {
        collection: "app.bsky.actor.profile",
        rkey: "self",
        valueDigest: "2222222222222222222222222222222222222222222222222222222222222222",
      },
    ],
    repo: "did:plc:ewvi7nxzyoun6zhxrhs64oiz",
  };
  const ports = mockPorts({
    operations: ["hostname.set", "pds.repo"],
    states: {
      "pds.repo": pdsRepoState,
    },
  });

  const unchanged = parseJsonObject(await handleControllerShellRequest(ports, {
    body: {
      "hostname.set": {
        desired: "vita-node-7",
      },
      "pds.repo": {
        desired: pdsRepoDesired,
      },
    },
    method: "POST",
    path: "/api/preview",
  }));
  assert.equal(unchanged["ok"], true);
  assert.deepEqual(unchanged["added"], []);
  assert.deepEqual(unchanged["changed"], []);
  assert.deepEqual(unchanged["removed"], []);

  const removed = parseJsonObject(await handleControllerShellRequest(ports, {
    body: {
      "hostname.set": {
        desired: "vita-node-7",
      },
    },
    method: "POST",
    path: "/api/preview",
  }));
  assert.equal(removed["ok"], true);
  assert.deepEqual(removed["added"], []);
  assert.deepEqual(removed["changed"], []);
  assert.deepEqual(removed["removed"], ["pds.repo"]);
});

test("POST /api/preview fails closed on duplicate-key, accessor, and cyclic bodies", async () => {
  const ports = mockPorts();
  const duplicate = await handleControllerShellRequest(ports, {
    body: '{"hostname.set":{"desired":"a"},"hostname.set":{"desired":"b"}}',
    method: "POST",
    path: "/api/preview",
  });
  const duplicateBody = parseJsonObject(duplicate);

  assert.equal(duplicate.status, 200);
  assert.equal(duplicateBody["ok"], false);
  assert.equal(readErrorCode(duplicateBody), "MALFORMED_BODY");

  const accessorBody: Record<string, unknown> = {};
  let getterReads = 0;
  Object.defineProperty(accessorBody, "hostname.set", {
    enumerable: true,
    get(): never {
      getterReads += 1;
      throw new Error("getter must not run");
    },
  });

  const accessor = await handleControllerShellRequest(ports, {
    body: accessorBody,
    method: "POST",
    path: "/api/preview",
  });
  assert.equal(accessor.status, 400);
  assert.equal(readErrorCode(parseJsonObject(accessor)), "MALFORMED_REQUEST");
  assert.equal(getterReads, 0);

  const cyclic: Record<string, unknown> = {};
  cyclic["self"] = cyclic;

  const cycle = await handleControllerShellRequest(ports, {
    body: cyclic,
    method: "POST",
    path: "/api/preview",
  });
  assert.equal(cycle.status, 400);
  assert.equal(readErrorCode(parseJsonObject(cycle)), "MALFORMED_REQUEST");
});

test("POST /api/apply relays exactly POST /apply and surfaces committed", async () => {
  const applyCalls: ApplyCall[] = [];
  const ports = mockPorts({
    applyCalls,
    applyResponse: {
      body: committedApplyBody("hostname.set"),
      status: 200,
    },
  });

  const response = await handleControllerShellRequest(ports, {
    body: {
      "hostname.set": {
        desired: "vita-node-7",
      },
    },
    method: "POST",
    path: "/api/apply",
  });
  const body = parseJsonObject(response);

  assert.equal(response.status, 200);
  assert.equal(body["ok"], true);
  assert.equal(body["outcome"], "committed");
  assert.deepEqual(applyCalls, [
    {
      body: {
        operations: [
          {
            capability: "hostname.set",
            request: {
              desired: "vita-node-7",
            },
          },
        ],
      },
      method: "POST",
      path: "/apply",
    },
  ]);
});

test("POST /api/apply surfaces rejected and transport outcomes without throwing", async () => {
  const rejected = await handleControllerShellRequest(
    mockPorts({
      applyResponse: {
        body: {
          applied: [],
          error: {
            code: "invalid_request",
            message: "agentd rejected plan",
          },
          outcome: "rejected",
          rollbackErrors: [],
          rolledBack: [],
        },
        status: 200,
      },
    }),
    {
      body: {
        "hostname.set": {
          desired: "vita-node-7",
        },
      },
      method: "POST",
      path: "/api/apply",
    },
  );
  const rejectedBody = parseJsonObject(rejected);

  assert.equal(rejected.status, 200);
  assert.equal(rejectedBody["ok"], false);
  assert.equal(rejectedBody["stage"], "apply");
  assert.equal(rejectedBody["outcome"], "rejected");
  assert.equal(rejectedBody["reason"], "Apply outcome was rejected.");

  const transport = await handleControllerShellRequest(
    mockPorts({
      transportError: true,
    }),
    {
      body: {
        "hostname.set": {
          desired: "vita-node-7",
        },
      },
      method: "POST",
      path: "/api/apply",
    },
  );
  const transportBody = parseJsonObject(transport);

  assert.equal(transport.status, 200);
  assert.equal(transportBody["ok"], false);
  assert.equal(transportBody["stage"], "transport");
});

test("router is default-deny and wrong methods never apply", async () => {
  const applyCalls: ApplyCall[] = [];
  const ports = mockPorts({ applyCalls });

  const unknown = await handleControllerShellRequest(ports, {
    method: "GET",
    path: "/unknown",
  });
  assert.equal(unknown.status, 404);

  for (const request of [
    { method: "DELETE", path: "/" },
    { method: "GET", path: "/api/apply" },
    { method: "POST", path: "/" },
  ]) {
    const response = await handleControllerShellRequest(ports, request);
    assert.equal(response.status, 405);
  }

  assert.deepEqual(applyCalls, []);
});

test("same inputs render byte-identical output", async () => {
  const ports = mockPorts();
  const request = {
    method: "GET",
    path: "/",
  };

  const first = await handleControllerShellRequest(ports, request);
  const second = await handleControllerShellRequest(ports, request);

  assert.equal(second.body, first.body);
});

interface MockPortsOptions {
  readonly hostname?: string;
  readonly operations?: readonly string[];
  readonly diff?: (current: ControllerShellTransactionPlan, desired: ControllerShellTransactionPlan) => ControllerShellPlanDiff;
  readonly applyResponse?: ControllerShellApplyTransportResponse;
  readonly applyCalls?: ApplyCall[];
  readonly transportError?: boolean;
  readonly states?: Readonly<Record<string, PlainJson>>;
  readonly failOperationsRead?: boolean;
}

interface ApplyCall {
  readonly method: "POST";
  readonly path: "/apply";
  readonly body: ControllerShellTransactionPlan;
}

function mockPorts(options: MockPortsOptions = {}): ControllerShellPorts {
  const hostname = options.hostname ?? "vita-node-7";
  const operations = options.operations ?? ["hostname.set", "node.config"];
  const applyCalls = options.applyCalls ?? [];
  const agent: ControllerShellAgent = {
    async getHealth(): Promise<unknown> {
      return {
        capabilities: operations,
        healthy: true,
        startedAt: "2026-06-24T12:00:00.000Z",
        uptimeSeconds: 10,
        version: "test-agent",
      };
    },
    async getOperations(): Promise<unknown> {
      if (options.failOperationsRead === true) {
        throw new Error("operations registry must not be read");
      }

      return operations;
    },
    async getState(capability): Promise<unknown> {
      if (options.states !== undefined && Object.hasOwn(options.states, capability)) {
        return options.states[capability];
      }
      if (capability === "hostname.set") {
        return {
          current: hostname,
        };
      }

      return {
        current: {
          enabled: true,
        },
      };
    },
    async getNodeState(): Promise<unknown> {
      return nodeState(options, operations, hostname);
    },
  };
  const apply: ControllerShellApplyCaller = async (method, path, body) => {
    applyCalls[applyCalls.length] = {
      body,
      method,
      path,
    };

    if (options.transportError === true) {
      throw new Error("socket unavailable");
    }

    return options.applyResponse ?? {
      body: committedApplyBody("hostname.set"),
      status: 200,
    };
  };

  return {
    agent,
    apply,
    diff: options.diff ?? diffByCapability,
    evaluate: mockEvaluate,
  };
}

function nodeState(
  options: MockPortsOptions,
  operations: readonly string[],
  hostname: string,
): PlainJsonObject {
  const capabilities: Record<string, PlainJson> = Object.create(null) as Record<string, PlainJson>;

  defineCapabilityState(capabilities, "hostname.set", {
    current: hostname,
  });

  for (let index = 0; index < operations.length; index += 1) {
    const capability = operations[index];

    if (capability !== undefined && !Object.hasOwn(capabilities, capability)) {
      defineCapabilityState(capabilities, capability, defaultState(capability));
    }
  }

  if (options.states !== undefined) {
    const names = Object.keys(options.states).sort(compareStrings);

    for (let index = 0; index < names.length; index += 1) {
      const capability = names[index];

      if (capability !== undefined) {
        defineCapabilityState(capabilities, capability, options.states[capability] ?? null);
      }
    }
  }

  return {
    capabilities,
    capsuleWorkloads: [],
  };
}

function defineCapabilityState(
  capabilities: Record<string, PlainJson>,
  capability: string,
  state: PlainJson,
): void {
  Object.defineProperty(capabilities, capability, {
    configurable: true,
    enumerable: true,
    value: state,
    writable: true,
  });
}

function defaultState(capability: string): PlainJsonObject {
  if (capability === "hostname.set") {
    return {
      current: "vita-node-7",
    };
  }

  return {
    current: {
      enabled: true,
    },
  };
}

function mockEvaluate(config: unknown): ControllerShellEvaluationResult {
  if (!isPlainObject(config)) {
    return rejectEvaluation("INVALID_CONFIG", "", "config must be an object");
  }

  const capabilityNames = Object.keys(config).sort(compareStrings);
  const operations: ControllerShellTransactionPlan["operations"][number][] = [];

  for (let index = 0; index < capabilityNames.length; index += 1) {
    const capability = capabilityNames[index];

    if (capability === undefined) {
      continue;
    }
    if (capability === "reject.capability") {
      return rejectEvaluation(
        "INVALID_CAPABILITY_REQUEST",
        "/reject.capability",
        "mock evaluator rejected config",
      );
    }

    const request = config[capability];
    if (!isPlainObject(request)) {
      return rejectEvaluation("INVALID_CAPABILITY_REQUEST", `/${capability}`, "request must be an object");
    }

    operations.push({
      capability,
      request,
    });
  }

  return {
    ok: true,
    plan: {
      operations,
    },
  };
}

function rejectEvaluation(
  code: string,
  path: string,
  message: string,
): ControllerShellEvaluationResult {
  return {
    ok: false,
    rejections: [
      {
        code,
        message,
        path,
      },
    ],
  };
}

function diffByCapability(
  current: ControllerShellTransactionPlan,
  desired: ControllerShellTransactionPlan,
): ControllerShellPlanDiff {
  const currentByCapability = indexPlan(current);
  const desiredByCapability = indexPlan(desired);
  const added: string[] = [];
  const removed: string[] = [];
  const changed: string[] = [];
  const currentNames = Object.keys(currentByCapability);
  const desiredNames = Object.keys(desiredByCapability);

  for (let index = 0; index < currentNames.length; index += 1) {
    const capability = currentNames[index];

    if (capability === undefined) {
      continue;
    }
    if (!Object.hasOwn(desiredByCapability, capability)) {
      removed.push(capability);
      continue;
    }
    if (currentByCapability[capability] !== desiredByCapability[capability]) {
      changed.push(capability);
    }
  }

  for (let index = 0; index < desiredNames.length; index += 1) {
    const capability = desiredNames[index];

    if (capability !== undefined && !Object.hasOwn(currentByCapability, capability)) {
      added.push(capability);
    }
  }

  return {
    added: added.sort(compareStrings),
    changed: changed.sort(compareStrings),
    removed: removed.sort(compareStrings),
  };
}

function indexPlan(plan: ControllerShellTransactionPlan): Record<string, string> {
  const output: Record<string, string> = Object.create(null) as Record<string, string>;

  for (let index = 0; index < plan.operations.length; index += 1) {
    const operation = plan.operations[index];

    if (operation !== undefined) {
      Object.defineProperty(output, operation.capability, {
        configurable: true,
        enumerable: true,
        value: JSON.stringify(operation.request),
        writable: true,
      });
    }
  }

  return output;
}

function committedApplyBody(capability: string): PlainJsonObject {
  return {
    applied: [
      {
        capability,
        index: 0,
      },
    ],
    outcome: "committed",
    rollbackErrors: [],
    rolledBack: [],
  };
}

function parseJsonObject(response: ControllerShellResponse): PlainJsonObject {
  assert.equal(response.contentType, "application/json; charset=utf-8");
  const parsed: unknown = JSON.parse(response.body);

  assert.equal(isPlainObject(parsed), true);
  if (!isPlainObject(parsed)) {
    assert.fail("expected JSON object response");
  }

  return parsed;
}

function readErrorCode(body: PlainJsonObject): string {
  const error = body["error"];

  assert.equal(isPlainObject(error), true);
  if (!isPlainObject(error)) {
    assert.fail("expected error object");
  }

  const code = error["code"];
  if (typeof code !== "string") {
    assert.fail("expected error.code string");
  }

  return code;
}

function isPlainObject(value: unknown): value is PlainJsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
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
