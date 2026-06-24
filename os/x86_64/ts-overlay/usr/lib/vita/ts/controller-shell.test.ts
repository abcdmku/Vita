import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  handleControllerShellRequest as handleUpstream,
} from "../../../../../../../sdk/typescript/src/controller-shell.ts";
import {
  handleControllerShellRequest as handleControllerWrapper,
} from "../../../../../../../controller/shell/src/controller-shell.ts";
import {
  diffTransactionPlans,
} from "./vita/transaction-plan-diff.ts";
import { evaluateNodeConfig } from "./vita/evaluate.ts";
import { DEFAULT_CAPABILITY_MANIFESTS } from "./vita/generated/capability-manifests.generated.ts";
import {
  formatControllerShellErrorMarker,
  formatControllerShellRejectMarker,
  formatControllerShellStatusMarker,
  handleControllerShellRequest as handleVendored,
} from "./vita/controller-shell.ts";
import type { CapabilityManifest } from "./vita/capability-manifest.ts";
import type {
  ControllerShellAgent,
  ControllerShellApplyCaller,
  ControllerShellApplyTransportResponse,
  ControllerShellPorts,
  ControllerShellResponse,
  ControllerShellTransactionPlan,
} from "./vita/controller-shell.ts";
import type { PlainJson, PlainJsonObject } from "./vita/safe-normalize.ts";

const CAPABILITY_REGISTRY = new Map<string, CapabilityManifest>(
  Object.entries(DEFAULT_CAPABILITY_MANIFESTS),
);
const VENDORED_HEADER = "// Vendored from sdk/typescript/src/controller-shell.ts\n";

test("VITA-UI status, preview, and apply markers are measured from mock agent reads", async () => {
  const calls: ApplyCall[] = [];
  const ports = shellPorts({
    applyCalls: calls,
    hostname: "vita-node-7",
    operations: ["hostname.set", "node.config"],
  });

  const html = await handleVendored(ports, {
    method: "GET",
    path: "/",
  });
  assert.equal(html.status, 200);
  assert.match(html.body, /vita-node-7/u);
  assert.match(html.body, /<dt>Capabilities<\/dt><dd>2<\/dd>/u);

  const status = parseJsonObject(await handleVendored(ports, {
    method: "GET",
    path: "/api/status",
  }));
  assert.equal(status["hostname"], "vita-node-7");
  assert.equal(status["caps"], 2);

  const preview = parseJsonObject(await handleVendored(ports, {
    body: {
      "hostname.set": {
        desired: "vita-node-8",
      },
    },
    method: "POST",
    path: "/api/preview",
  }));
  assert.equal(preview["ok"], true);
  assert.deepEqual(preview["added"], []);
  assert.deepEqual(preview["removed"], ["node.config"]);
  assert.deepEqual(preview["changed"], ["hostname.set"]);

  const apply = parseJsonObject(await handleVendored(ports, {
    body: {
      "hostname.set": {
        desired: "vita-node-7",
      },
    },
    method: "POST",
    path: "/api/apply",
  }));
  assert.equal(apply["ok"], true);
  assert.deepEqual(calls, [
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
  assert.equal(
    formatControllerShellStatusMarker(
      assertStatus(status),
      assertPreview(preview),
      assertApply(apply),
    ),
    "VITA-UI: status=OK route=status hostname=vita-node-7 caps=2 preview=added=0,removed=1,changed=1 apply=committed status=OK",
  );
});

test("VITA-UI preview measures removed pds.repo-like current state", async () => {
  const ports = shellPorts({
    hostname: "vita-node-7",
    operations: ["hostname.set"],
    states: {
      "pds.repo": {
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
      },
    },
  });

  const preview = parseJsonObject(await handleVendored(ports, {
    body: {
      "hostname.set": {
        desired: "vita-node-7",
      },
    },
    method: "POST",
    path: "/api/preview",
  }));

  assert.equal(preview["ok"], true);
  assert.deepEqual(preview["added"], []);
  assert.deepEqual(preview["changed"], []);
  assert.deepEqual(preview["removed"], ["pds.repo"]);
});

test("forced invalid apply surfaces VITA-UI-REJECT and transport failure surfaces FAILSAFE", async () => {
  const rejected = parseJsonObject(await handleVendored(
    {
      ...shellPorts({
        applyResponse: {
          body: {
            applied: [],
            error: {
              code: "invalid request!",
              message: "agentd rejected unknown capability",
            },
            outcome: "rejected",
            rollbackErrors: [],
            rolledBack: [],
          },
          status: 200,
        },
      }),
      evaluate: () => ({
        ok: true,
        plan: {
          operations: [
            {
              capability: "vita.invalid.capability",
              request: {
                desired: true,
              },
            },
          ],
        },
      }),
    },
    {
      body: {
        "vita.invalid.capability": {
          desired: true,
        },
      },
      method: "POST",
      path: "/api/apply",
    },
  ));

  assert.equal(
    formatControllerShellRejectMarker(assertApply(rejected)),
    "VITA-UI-REJECT: route=apply reason=invalid_request_ status=OK",
  );

  const status = assertStatus(parseJsonObject(await handleVendored(shellPorts(), {
    method: "GET",
    path: "/api/status",
  })));
  const preview = assertPreview(parseJsonObject(await handleVendored(shellPorts(), {
    body: {
      "hostname.set": {
        desired: "vita-node-8",
      },
    },
    method: "POST",
    path: "/api/preview",
  })));
  const transport = assertApply(parseJsonObject(await handleVendored(shellPorts({
    transportError: true,
  }), {
    body: {
      "hostname.set": {
        desired: "vita-node-7",
      },
    },
    method: "POST",
    path: "/api/apply",
  })));

  assert.equal(
    formatControllerShellStatusMarker(status, preview, transport),
    "VITA-UI-ERROR: status=FAILSAFE",
  );
  assert.equal(formatControllerShellErrorMarker(), "VITA-UI-ERROR: status=FAILSAFE");
});

test("vendored controller shell source matches upstream except header", () => {
  const vendored = normalizeLineEndings(
    readFileSync(fileURLToPath(new URL("./vita/controller-shell.ts", import.meta.url)), "utf8"),
  );
  const upstream = normalizeLineEndings(
    readFileSync(
      fileURLToPath(
        new URL("../../../../../../../sdk/typescript/src/controller-shell.ts", import.meta.url),
      ),
      "utf8",
    ),
  );

  assert.equal(vendored.startsWith(VENDORED_HEADER), true);
  assert.equal(vendored.slice(VENDORED_HEADER.length), upstream);
});

test("vendored, shared, and controller wrapper behavior match on identical mock ports", async () => {
  const ports = shellPorts();
  const request = {
    body: {
      "hostname.set": {
        desired: "vita-node-7",
      },
    },
    method: "POST",
    path: "/api/apply",
  };

  const vendored = await handleVendored(ports, request);
  const upstream = await handleUpstream(ports, request);
  const wrapper = await handleControllerWrapper(ports, request);

  assert.deepEqual(vendored, upstream);
  assert.deepEqual(wrapper, upstream);
});

interface ShellPortsOptions {
  readonly hostname?: string;
  readonly operations?: readonly string[];
  readonly applyResponse?: ControllerShellApplyTransportResponse;
  readonly applyCalls?: ApplyCall[];
  readonly transportError?: boolean;
  readonly states?: Readonly<Record<string, PlainJson>>;
}

interface ApplyCall {
  readonly method: "POST";
  readonly path: "/apply";
  readonly body: ControllerShellTransactionPlan;
}

function shellPorts(options: ShellPortsOptions = {}): ControllerShellPorts {
  const hostname = options.hostname ?? "vita-node-7";
  const operations = options.operations ?? ["hostname.set"];
  const applyCalls = options.applyCalls ?? [];
  const agent: ControllerShellAgent = {
    async getHealth(): Promise<unknown> {
      return {
        capabilities: operations,
        healthy: true,
        startedAt: "2026-06-24T12:00:00.000Z",
        uptimeSeconds: 10,
        version: "agentd-test",
      };
    },
    async getOperations(): Promise<unknown> {
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
          mode: "normal",
          remoteAccess: "disabled",
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
      body: committedApplyBody(),
      status: 200,
    };
  };

  return {
    agent,
    apply,
    diff: (current, desired) => diffTransactionPlans(
      current as unknown as Parameters<typeof diffTransactionPlans>[0],
      desired as unknown as Parameters<typeof diffTransactionPlans>[1],
    ),
    evaluate: (config) => evaluateNodeConfig(config, CAPABILITY_REGISTRY),
  };
}

function nodeState(
  options: ShellPortsOptions,
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
      mode: "normal",
      remoteAccess: "disabled",
    },
  };
}

function committedApplyBody(): PlainJsonObject {
  return {
    applied: [
      {
        capability: "hostname.set",
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

  assert.equal(parsed !== null && typeof parsed === "object" && !Array.isArray(parsed), true);
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    assert.fail("expected JSON object");
  }

  return parsed as PlainJsonObject;
}

function assertStatus(value: PlainJsonObject): Parameters<typeof formatControllerShellStatusMarker>[0] {
  return value as unknown as Parameters<typeof formatControllerShellStatusMarker>[0];
}

function assertPreview(value: PlainJsonObject): Parameters<typeof formatControllerShellStatusMarker>[1] {
  return value as unknown as Parameters<typeof formatControllerShellStatusMarker>[1];
}

function assertApply(value: PlainJsonObject): Parameters<typeof formatControllerShellStatusMarker>[2] {
  return value as unknown as Parameters<typeof formatControllerShellStatusMarker>[2];
}

function normalizeLineEndings(source: string): string {
  return source.replaceAll("\r\n", "\n");
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
