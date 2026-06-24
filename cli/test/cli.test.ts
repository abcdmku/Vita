import assert from "node:assert/strict";
import { test } from "node:test";

import { createAgentClient } from "../../controller/agent-client/src/agent-client.ts";
import type {
  AgentTransport,
  AgentTransportInit,
  AgentTransportResponse,
} from "../../controller/agent-client/src/agent-client.ts";
import type {
  ApplyNodeApplyResult,
  ApplyNodeTransport,
  ApplyNodeTransportResponse,
} from "../../controller/apply-node/src/apply-node-config.ts";
import { parseArgs } from "../src/args.ts";
import { runApplyCommand } from "../src/commands/apply.ts";
import {
  runCapsuleInstallCommand,
  runCapsuleListCommand,
  runCapsulePreviewCommand,
} from "../src/commands/capsule.ts";
import { runEvaluateCommand } from "../src/commands/evaluate.ts";
import { runPreviewCommand } from "../src/commands/preview.ts";
import { runStateCommand } from "../src/commands/state.ts";
import {
  formatApplyResult,
  formatEvaluationRejections,
  formatPlanSummary,
  formatTransactionDiff,
} from "../src/format.ts";
import type { CapsuleIntegrity } from "../../sdk/typescript/src/capsule-registry-model.ts";
import type { EvaluationRejection, TransactionPlan } from "../../runtime/evaluator/src/evaluate.ts";

test("evaluate produces a stable plan summary and canonical JSON", () => {
  const first = runEvaluateCommand(validNodeConfig());
  const second = runEvaluateCommand(validNodeConfig());
  const json = runEvaluateCommand(validNodeConfig(), { json: true });

  assert.equal(first.exitCode, 0);
  assert.equal(first.stderr, "");
  assert.equal(first.stdout, [
    "TransactionPlan: operations=1",
    "- node.config",
  ].join("\n"));
  assert.deepEqual(second, first);
  assert.equal(
    json.stdout,
    `{"operations":[{"capability":"node.config","request":{"desired":{"mode":"normal","remoteAccess":"disabled"}}}]}`,
  );
});

test("evaluate rejects unknown, bad, empty, and non-object configs without a plan", () => {
  const cases = [
    {
      input: {
        unknown: {},
      },
      code: "UNKNOWN_CAPABILITY",
    },
    {
      input: {
        "node.config": {
          desired: {
            mode: "normal",
          },
        },
      },
      code: "INVALID_CAPABILITY_REQUEST",
    },
    {
      input: {},
      code: "EMPTY_CONFIG",
    },
    {
      input: null,
      code: "INVALID_CONFIG",
    },
  ] as const;

  for (let index = 0; index < cases.length; index += 1) {
    const item = cases[index];
    if (item === undefined) continue;

    const result = runEvaluateCommand(item.input);

    assert.equal(result.exitCode, 1);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, new RegExp(item.code, "u"));
  }
});

test("preview evaluates desired config, diffs mocked state, and never posts apply", async () => {
  const mock = mockAgentTransport({
    "/operations": {
      operations: ["services.config", "node.config"],
    },
    "/read/node.config": {
      exists: true,
      config: {
        mode: "normal",
        remoteAccess: "disabled",
      },
      raw: "node-config",
    },
    "/read/services.config": {
      exists: true,
      config: {
        services: [],
      },
      raw: "services",
    },
  });
  const client = createAgentClient({ baseUrl: "http://agentd", transport: mock.transport });

  const result = await runPreviewCommand(
    {
      "hostname.set": {
        desired: "vita-node-7",
      },
      "node.config": {
        desired: {
          mode: "maintenance",
          remoteAccess: "disabled",
        },
      },
    },
    { client },
  );

  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout, [
    "Preview: added=1 removed=1 changed=1",
    "+ adds capability hostname.set",
    "- removes capability services.config",
    "~ changes capability node.config",
  ].join("\n"));
  assert.equal(mock.calls.filter((call) => call.init.method === "POST").length, 0);
});

test("apply without commit dry-runs and makes no apply POST", async () => {
  const mock = mockAgentTransport({
    "/operations": {
      operations: ["node.config"],
    },
    "/read/node.config": {
      exists: true,
      config: {
        mode: "normal",
        remoteAccess: "disabled",
      },
      raw: "node-config",
    },
  });
  const client = createAgentClient({ baseUrl: "http://agentd", transport: mock.transport });
  let applyCalls = 0;

  const result = await runApplyCommand(
    {
      "node.config": {
        desired: {
          mode: "maintenance",
          remoteAccess: "disabled",
        },
      },
    },
    {
      client,
      commit: false,
      transport: async () => {
        applyCalls += 1;
        return {
          body: committedResult(),
          status: 200,
        };
      },
    },
  );

  assert.equal(result.exitCode, 0);
  assert.match(result.stdout, /dry-run \(pass --commit to apply\)/u);
  assert.match(result.stdout, /Preview: added=0 removed=0 changed=1/u);
  assert.equal(applyCalls, 0);
  assert.equal(mock.calls.filter((call) => call.init.method === "POST").length, 0);
});

test("apply with commit posts once and fails closed on rejected or malformed results", async () => {
  const rejectedCalls: ApplyCall[] = [];
  const rejected = await runApplyCommand(validNodeConfig(), {
    client: unusedClient(),
    commit: true,
    transport: fakeApplyTransport(
      {
        body: rejectedResult(),
        status: 200,
      },
      rejectedCalls,
    ),
  });

  assert.equal(rejected.exitCode, 1);
  assert.match(rejected.stderr, /Apply outcome was rejected/u);
  assert.match(rejected.stderr, /error=invalid_request: transaction rejected/u);
  assert.deepEqual(rejectedCalls.map((call) => ({ method: call.method, path: call.path })), [
    {
      method: "POST",
      path: "/apply",
    },
  ]);

  const malformed = await runApplyCommand(validNodeConfig(), {
    client: unusedClient(),
    commit: true,
    transport: fakeApplyTransport({
      body: "not an apply result",
      status: 200,
    }),
  });

  assert.equal(malformed.exitCode, 1);
  assert.match(malformed.stderr, /Apply result body is malformed/u);

  const transport = await runApplyCommand(validNodeConfig(), {
    client: unusedClient(),
    commit: true,
    transport: async () => {
      throw new Error("socket unavailable");
    },
  });

  assert.equal(transport.exitCode, 1);
  assert.match(transport.stderr, /transport/u);
});

test("capsule list, preview, and dry-run install read registry without apply", async () => {
  const current = [
    capsule("com.vita.notes", "1.0.0", sri256(0), "installed"),
    capsule("com.vita.remove", "1.0.0", sri256(1), "disabled"),
  ];
  const desired = [
    capsule("com.vita.notes", "2.0.0", sri256(0), "installed"),
    capsule("com.vita.install", "1.0.0", sri256(2), "installed"),
  ];
  const mock = mockAgentTransport({
    "/read/capsule.registry": {
      exists: true,
      raw: "registry",
      registry: {
        capsules: current,
      },
    },
  });
  const client = createAgentClient({ baseUrl: "http://agentd", transport: mock.transport });
  let applyCalls = 0;

  const list = await runCapsuleListCommand({ client });
  assert.equal(list.exitCode, 0);
  assert.equal(list.stdout, [
    "Capsules: count=2",
    `- com.vita.notes version=1.0.0 state=installed integrity=${sri256(0)}`,
    `- com.vita.remove version=1.0.0 state=disabled integrity=${sri256(1)}`,
  ].join("\n"));

  const preview = await runCapsulePreviewCommand(desired, { client });
  assert.equal(preview.exitCode, 0);
  assert.equal(
    preview.stdout,
    "Capsule preview: installed=1 removed=1 upgraded=1 downgraded=0 stateChanged=0 integrityChanged=false",
  );

  const installDryRun = await runCapsuleInstallCommand(desired, {
    client,
    commit: false,
    transport: async () => {
      applyCalls += 1;
      return {
        body: committedResult(),
        status: 200,
      };
    },
  });
  assert.equal(installDryRun.exitCode, 0);
  assert.match(installDryRun.stdout, /dry-run \(pass --commit to apply\)/u);
  assert.equal(applyCalls, 0);
  assert.equal(mock.calls.filter((call) => call.init.method === "POST").length, 0);
});

test("state lists health and returns one capability state", async () => {
  const mock = mockAgentTransport({
    "/healthz": {
      version: "test-version",
      startedAt: "2026-06-20T12:00:00Z",
      uptimeSeconds: 90,
      capabilities: ["node.config"],
      healthy: true,
    },
    "/operations": {
      operations: ["node.config", "time.sync"],
    },
    "/read/node.config": {
      exists: true,
      config: {
        mode: "normal",
        remoteAccess: "disabled",
      },
      raw: "node-config",
    },
  });
  const client = createAgentClient({ baseUrl: "http://agentd", transport: mock.transport });

  const overview = await runStateCommand({ client });
  assert.equal(overview.exitCode, 0);
  assert.equal(overview.stdout, [
    "Agent health: healthy=true version=test-version uptimeSeconds=90",
    "Capabilities: count=2",
    "- node.config",
    "- time.sync",
  ].join("\n"));

  const state = await runStateCommand({ capability: "node.config", client });
  assert.equal(state.exitCode, 0);
  assert.equal(
    state.stdout,
    `State: node.config\n{"config":{"mode":"normal","remoteAccess":"disabled"},"exists":true,"raw":"node-config"}`,
  );
});

test("format output snapshots are stable", () => {
  const plan: TransactionPlan = {
    operations: [
      {
        capability: "node.config",
        request: {
          desired: {
            mode: "normal",
            remoteAccess: "disabled",
          },
        },
      },
    ],
  };
  const rejections: readonly EvaluationRejection[] = [
    {
      code: "UNKNOWN_CAPABILITY",
      capability: "unknown",
      message: "Capability is not in the manifest registry.",
      path: "unknown",
    },
  ];

  assert.equal(formatPlanSummary(plan), [
    "TransactionPlan: operations=1",
    "- node.config",
  ].join("\n"));
  assert.equal(formatEvaluationRejections(rejections), [
    "Evaluation rejected:",
    "- UNKNOWN_CAPABILITY path=unknown capability=unknown: Capability is not in the manifest registry.",
  ].join("\n"));
  assert.equal(formatTransactionDiff({
    added: ["hostname.set"],
    changed: ["node.config"],
    removed: ["services.config"],
  }), [
    "Preview: added=1 removed=1 changed=1",
    "+ adds capability hostname.set",
    "- removes capability services.config",
    "~ changes capability node.config",
  ].join("\n"));
  assert.equal(formatApplyResult(committedResult(true)), [
    "Apply outcome: committed",
    "applied=1 rolledBack=0 rollbackErrors=0",
    "auditUnrecorded=true",
  ].join("\n"));
});

test("args fail closed on unknown flags and missing required values", () => {
  const unknown = parseArgs(["evaluate", "config.json", "--socket", "/tmp/agent.sock"]);
  const missing = parseArgs(["capsule", "preview"]);

  assert.equal(unknown.ok, false);
  if (!unknown.ok) {
    assert.match(unknown.message, /unknown flag --socket/u);
  }
  assert.equal(missing.ok, false);
  if (!missing.ok) {
    assert.match(missing.message, /requires exactly one capsule registry path/u);
  }
});

interface RecordedCall {
  readonly url: string;
  readonly init: AgentTransportInit;
}

interface ApplyCall {
  readonly method: Parameters<ApplyNodeTransport>[0];
  readonly path: Parameters<ApplyNodeTransport>[1];
  readonly body: Parameters<ApplyNodeTransport>[2];
}

class MockResponse implements AgentTransportResponse {
  readonly status: number;
  readonly #body: string;

  constructor(status: number, body: string) {
    this.status = status;
    this.#body = body;
  }

  get ok(): boolean {
    return this.status >= 200 && this.status < 300;
  }

  async text(): Promise<string> {
    return this.#body;
  }
}

function mockAgentTransport(routes: Readonly<Record<string, unknown>>): {
  readonly calls: readonly RecordedCall[];
  readonly transport: AgentTransport;
} {
  const calls: RecordedCall[] = [];
  const transport: AgentTransport = async (url, init) => {
    calls[calls.length] = { init, url };

    const body = routes[new URL(url).pathname];
    if (body === undefined) {
      return new MockResponse(
        404,
        JSON.stringify({
          error: {
            code: "not_found",
            message: "not found",
          },
        }),
      );
    }

    return new MockResponse(200, JSON.stringify(body));
  };

  return {
    calls,
    transport,
  };
}

function fakeApplyTransport(
  response: ApplyNodeTransportResponse,
  calls: ApplyCall[] = [],
): ApplyNodeTransport {
  return async (method, path, body) => {
    calls[calls.length] = { body, method, path };

    return response;
  };
}

function unusedClient(): {
  readonly getOperations: () => Promise<readonly string[]>;
  readonly getState: () => Promise<never>;
} {
  return {
    async getOperations(): Promise<readonly string[]> {
      return [];
    },
    async getState(): Promise<never> {
      throw new Error("unused client");
    },
  };
}

function validNodeConfig(): unknown {
  return {
    "node.config": {
      desired: {
        mode: "normal",
        remoteAccess: "disabled",
      },
    },
  };
}

function committedResult(auditUnrecorded?: boolean): ApplyNodeApplyResult {
  const base = {
    applied: [
      {
        capability: "node.config",
        index: 0,
      },
    ],
    outcome: "committed",
    rollbackErrors: [],
    rolledBack: [],
  } satisfies ApplyNodeApplyResult;

  if (auditUnrecorded === undefined) {
    return base;
  }

  return {
    ...base,
    auditUnrecorded,
  };
}

function rejectedResult(): ApplyNodeApplyResult {
  return {
    applied: [],
    error: {
      code: "invalid_request",
      message: "transaction rejected",
    },
    outcome: "rejected",
    rollbackErrors: [],
    rolledBack: [],
  };
}

function capsule(
  id: string,
  version: string,
  integrity: CapsuleIntegrity,
  state: "installed" | "disabled",
): {
  readonly id: string;
  readonly version: string;
  readonly integrity: CapsuleIntegrity;
  readonly state: "installed" | "disabled";
} {
  return {
    id,
    integrity,
    state,
    version,
  };
}

function sri256(byte: number): CapsuleIntegrity {
  return `sha256-${Buffer.alloc(32, byte).toString("base64")}`;
}
