import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import {
  APP_SHELL_VIEW_IDS,
  APP_SHELL_VIEW_REGISTRY,
  AppShellRoutingError,
  createAppShell,
  createControllerShellReadPort,
  requireAppShellView,
  resolveAppShellView,
} from "../src/app-shell.ts";
import type {
  ControllerShellReadClient,
  ControllerShellReadPort,
} from "../src/app-shell.ts";
import type {
  AgentCapabilityState,
  AgentHealth,
} from "../../agent-client/src/agent-client.ts";

const EXPECTED_VIEW_IDS = Object.freeze([
  "dashboard",
  "node",
  "storage",
  "identity",
  "app",
  "backup",
  "ai",
] as const);

test("view registry exposes exactly the spec 17.2 controller shell views", () => {
  assert.deepEqual(APP_SHELL_VIEW_IDS, EXPECTED_VIEW_IDS);
  assert.deepEqual(Object.keys(APP_SHELL_VIEW_REGISTRY), EXPECTED_VIEW_IDS);

  for (let index = 0; index < EXPECTED_VIEW_IDS.length; index += 1) {
    const viewId = EXPECTED_VIEW_IDS[index];

    if (viewId === undefined) {
      assert.fail(`expected view id at index ${index}`);
    }

    assert.equal(APP_SHELL_VIEW_REGISTRY[viewId].id, viewId);
  }
});

test("router resolves every view id to a pure view-model factory", () => {
  const calls = emptyCalls();
  const data = countingReadPort(calls);
  const shell = createAppShell({ data });

  assert.equal(shell.data, data);
  assert.deepEqual(Object.keys(shell.views), EXPECTED_VIEW_IDS);

  for (let index = 0; index < APP_SHELL_VIEW_IDS.length; index += 1) {
    const viewId = APP_SHELL_VIEW_IDS[index];

    if (viewId === undefined) {
      assert.fail(`expected app shell view id at index ${index}`);
    }

    const route = shell.resolveView(viewId);

    if (!route.ok) {
      assert.fail(`expected ${viewId} to resolve: ${route.error.message}`);
    }

    const before = snapshotCalls(calls);
    const model = route.view.createViewModel({ data });

    assert.equal(model.id, viewId);
    assert.equal(model.data, data);
    assert.equal(Object.keys(model.headless).length > 0, true);
    assert.deepEqual(snapshotCalls(calls), before);
  }

  assert.deepEqual(snapshotCalls(calls), emptyCalls());
});

test("standalone router returns and throws typed failures for unknown view ids", () => {
  const missing = resolveAppShellView("settings");

  assert.equal(missing.ok, false);
  if (missing.ok) {
    assert.fail("expected unknown view id to fail closed");
  }
  assert.equal(missing.error.code, "UNKNOWN_VIEW_ID");
  assert.equal(missing.error.viewId, "settings");

  const proto = resolveAppShellView("__proto__");

  assert.equal(proto.ok, false);
  if (proto.ok) {
    assert.fail("expected __proto__ to fail closed");
  }
  assert.equal(proto.error.code, "UNKNOWN_VIEW_ID");

  assert.throws(
    () => requireAppShellView("settings"),
    (error: unknown): boolean =>
      error instanceof AppShellRoutingError &&
      error.code === "UNKNOWN_VIEW_ID" &&
      error.viewId === "settings",
  );
});

test("read-only data port is injected and delegates only the allowed AgentClient reads", async () => {
  const calls = emptyCalls();
  const client = countingReadClient(calls);
  const port = createControllerShellReadPort(client);

  assert.deepEqual(Object.keys(port).sort(compareStrings), [
    "getHealth",
    "getOperations",
    "getState",
  ]);
  assert.deepEqual(snapshotCalls(calls), emptyCalls());

  assert.deepEqual(await port.getHealth(), health());
  assert.deepEqual(await port.getOperations(), ["node.config", "backup.policy"]);
  assert.deepEqual(await port.getState("node.config"), stateFor("node.config"));
  assert.deepEqual(snapshotCalls(calls), {
    health: 1,
    operations: 1,
    states: ["node.config"],
  });
});

test("shell source does not import node:net or remote modules", () => {
  const source = readFileSync(new URL("../src/app-shell.ts", import.meta.url), "utf8");
  const importSpecifiers = parseImportSpecifiers(source);

  assert.equal(importSpecifiers.some((specifier) => specifier === "node:net"), false);
  assert.deepEqual(importSpecifiers.filter(isRemoteSpecifier), []);
});

interface PortCalls {
  readonly health: number;
  readonly operations: number;
  readonly states: readonly string[];
}

interface MutablePortCalls {
  health: number;
  operations: number;
  states: string[];
}

function emptyCalls(): MutablePortCalls {
  return {
    health: 0,
    operations: 0,
    states: [],
  };
}

function snapshotCalls(calls: MutablePortCalls): PortCalls {
  return {
    health: calls.health,
    operations: calls.operations,
    states: [...calls.states],
  };
}

function countingReadPort(calls: MutablePortCalls): ControllerShellReadPort {
  return countingReadClient(calls);
}

function countingReadClient(calls: MutablePortCalls): ControllerShellReadClient {
  return {
    async getHealth(): Promise<AgentHealth> {
      calls.health += 1;
      return health();
    },
    async getOperations(): Promise<readonly string[]> {
      calls.operations += 1;
      return ["node.config", "backup.policy"];
    },
    async getState(capability: string): Promise<AgentCapabilityState> {
      calls.states[calls.states.length] = capability;
      return stateFor(capability);
    },
  };
}

function health(): AgentHealth {
  return {
    capabilities: ["node.config", "backup.policy"],
    healthy: true,
    startedAt: "2026-06-24T12:00:00.000Z",
    uptimeSeconds: 42,
    version: "test-agent",
  };
}

function stateFor(capability: string): AgentCapabilityState {
  return {
    capability,
    current: "fixture",
  };
}

function parseImportSpecifiers(source: string): readonly string[] {
  const specifiers: string[] = [];
  const pattern = /\bfrom\s+["']([^"']+)["']|\bimport\s+["']([^"']+)["']/g;

  for (const match of source.matchAll(pattern)) {
    const specifier = match[1] ?? match[2];

    if (specifier !== undefined) {
      specifiers[specifiers.length] = specifier;
    }
  }

  return Object.freeze(specifiers);
}

function isRemoteSpecifier(specifier: string): boolean {
  return /^[a-z][a-z0-9+.-]*:\/\//iu.test(specifier);
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
