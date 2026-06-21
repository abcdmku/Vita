import assert from "node:assert/strict";
import { test } from "node:test";

import {
  TIMESYNC_MANIFEST,
} from "../../../sdk/typescript/src/capability-manifest.ts";
import type {
  CapabilityManifest,
} from "../../../sdk/typescript/src/capability-manifest.ts";
import type {
  CapabilityManifestRegistry,
} from "../../../runtime/evaluator/src/evaluate.ts";
import { applyNodeConfig } from "../src/apply-node-config.ts";
import type {
  ApplyNodeApplyResult,
  ApplyNodeConfigResult,
  ApplyNodeTransport,
  ApplyNodeTransportResponse,
} from "../src/apply-node-config.ts";

const REGISTRY: CapabilityManifestRegistry = new Map<string, CapabilityManifest>([
  ["timesync", TIMESYNC_MANIFEST],
]);

test("valid timesync config evaluates, submits the plan, and surfaces a committed result", async () => {
  const applyResult = committedResult(true);
  const calls: TransportCall[] = [];

  const result = await applyNodeConfig(
    validTimesyncConfig(),
    REGISTRY,
    fakeTransport({ body: applyResult, status: 200 }, calls),
  );

  if (!result.ok) {
    assert.fail(`expected apply to succeed: ${JSON.stringify(result)}`);
  }

  const expectedPlan = {
    operations: [
      {
        capability: "timesync",
        request: {
          enabled: true,
          servers: ["pool.ntp.org"],
        },
      },
    ],
  };

  assert.deepEqual(result.plan, expectedPlan);
  assert.deepEqual(result.applyResult, applyResult);
  assert.equal(result.applyResult.auditUnrecorded, true);
  assert.deepEqual(calls, [
    {
      body: expectedPlan,
      method: "POST",
      path: "/apply",
    },
  ]);
});

test("evaluation failures return evaluate stage and never call transport", async () => {
  const calls: TransportCall[] = [];
  const unknown = await applyNodeConfig(
    {
      unknown: {},
    },
    REGISTRY,
    fakeTransport({ body: committedResult(), status: 200 }, calls),
  );

  assertEvaluateFailure(unknown);
  assert.deepEqual(
    unknown.rejections.map((rejection) => rejection.code),
    ["UNKNOWN_CAPABILITY"],
  );
  assert.deepEqual(calls, []);

  const invalid = await applyNodeConfig(
    {
      timesync: {
        enabled: true,
        servers: [],
      },
    },
    REGISTRY,
    fakeTransport({ body: committedResult(), status: 200 }, calls),
  );

  assertEvaluateFailure(invalid);
  assert.deepEqual(
    invalid.rejections.map((rejection) => rejection.code),
    ["INVALID_CAPABILITY_REQUEST"],
  );
  assert.deepEqual(calls, []);
});

test("non-2xx apply response returns apply stage failure", async () => {
  const result = await applyNodeConfig(
    validTimesyncConfig(),
    REGISTRY,
    fakeTransport({
      body: {
        error: {
          code: "invalid_request",
          message: "invalid apply plan",
        },
      },
      status: 400,
    }),
  );

  assertApplyFailure(result);
  assert.equal(result.status, 400);
  assert.equal(Object.hasOwn(result, "applyResult"), false);
});

test("rejected and rolledBack apply outcomes return apply stage failure", async () => {
  const rejected = await applyNodeConfig(
    validTimesyncConfig(),
    REGISTRY,
    fakeTransport({ body: rejectedResult(), status: 200 }),
  );

  assertApplyFailure(rejected);
  assert.equal(rejected.applyResult?.outcome, "rejected");

  const rolledBack = await applyNodeConfig(
    validTimesyncConfig(),
    REGISTRY,
    fakeTransport({ body: rolledBackResult(), status: 200 }),
  );

  assertApplyFailure(rolledBack);
  assert.equal(rolledBack.applyResult?.outcome, "rolledBack");
});

test("transport throw returns transport stage failure", async () => {
  let calls = 0;
  const result = await applyNodeConfig(validTimesyncConfig(), REGISTRY, async () => {
    calls += 1;
    throw new Error("socket unavailable");
  });

  assertTransportFailure(result);
  assert.equal(calls, 1);
});

test("hostile config fails closed without invoking accessors or calling transport", async () => {
  const hostile: Record<string, unknown> = {};
  let getterReads = 0;
  let transportCalls = 0;

  Object.defineProperty(hostile, "timesync", {
    enumerable: true,
    get() {
      getterReads += 1;
      throw new Error("getter should not be invoked");
    },
  });

  const result = await applyNodeConfig(hostile, REGISTRY, async () => {
    transportCalls += 1;

    return {
      body: committedResult(),
      status: 200,
    };
  });

  assertEvaluateFailure(result);
  assert.deepEqual(
    result.rejections.map((rejection) => rejection.code),
    ["INVALID_CONFIG"],
  );
  assert.equal(getterReads, 0);
  assert.equal(transportCalls, 0);
});

interface TransportCall {
  readonly method: Parameters<ApplyNodeTransport>[0];
  readonly path: Parameters<ApplyNodeTransport>[1];
  readonly body: Parameters<ApplyNodeTransport>[2];
}

function fakeTransport(
  response: ApplyNodeTransportResponse,
  calls: TransportCall[] = [],
): ApplyNodeTransport {
  return async (method, path, body) => {
    calls[calls.length] = {
      body,
      method,
      path,
    };

    return response;
  };
}

function validTimesyncConfig(): unknown {
  return {
    timesync: {
      enabled: true,
      servers: ["POOL.NTP.ORG"],
    },
  };
}

function committedResult(auditUnrecorded?: boolean): ApplyNodeApplyResult {
  const base = {
    applied: [
      {
        capability: "timesync",
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

function rolledBackResult(): ApplyNodeApplyResult {
  return {
    applied: [
      {
        capability: "timesync",
        index: 0,
      },
    ],
    error: {
      capability: "timesync",
      code: "apply_failed",
      index: 0,
      message: "timesync apply failed",
    },
    outcome: "rolledBack",
    rollbackErrors: [],
    rolledBack: [
      {
        capability: "timesync",
        index: 0,
      },
    ],
  };
}

function assertEvaluateFailure(
  result: ApplyNodeConfigResult,
): asserts result is Extract<ApplyNodeConfigResult, { readonly ok: false; readonly stage: "evaluate" }> {
  if (result.ok) {
    assert.fail(`expected evaluate failure, got success: ${JSON.stringify(result)}`);
  }

  if (result.stage !== "evaluate") {
    assert.fail(`expected evaluate failure, got ${result.stage}`);
  }
}

function assertApplyFailure(
  result: ApplyNodeConfigResult,
): asserts result is Extract<ApplyNodeConfigResult, { readonly ok: false; readonly stage: "apply" }> {
  if (result.ok) {
    assert.fail(`expected apply failure, got success: ${JSON.stringify(result)}`);
  }

  if (result.stage !== "apply") {
    assert.fail(`expected apply failure, got ${result.stage}`);
  }
}

function assertTransportFailure(
  result: ApplyNodeConfigResult,
): asserts result is Extract<ApplyNodeConfigResult, { readonly ok: false; readonly stage: "transport" }> {
  if (result.ok) {
    assert.fail(`expected transport failure, got success: ${JSON.stringify(result)}`);
  }

  if (result.stage !== "transport") {
    assert.fail(`expected transport failure, got ${result.stage}`);
  }
}
