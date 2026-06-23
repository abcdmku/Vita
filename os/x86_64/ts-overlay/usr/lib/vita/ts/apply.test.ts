import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  defaultCapabilityRegistry,
} from "../../../../../../../sdk/typescript/src/capability-manifest.ts";
import { applyNodeConfig as applyUpstream } from "../../../../../../../controller/apply-node/src/apply-node-config.ts";
import { applyNodeConfig as applyVendored } from "./vita/apply-node-config.ts";
import { DEFAULT_CAPABILITY_MANIFESTS } from "./vita/generated/capability-manifests.generated.ts";
import {
  createDenoUnixSocketAgentTransport,
  createDenoUnixSocketApplyAgentTransport,
} from "./vita/unix-socket-transport.ts";
import type {
  ApplyNodeApplyResult,
  ApplyNodeConfigResult,
  ApplyNodeTransport,
  ApplyNodeTransportResponse,
} from "./vita/apply-node-config.ts";
import type { CapabilityManifest } from "./vita/capability-manifest.ts";

const UPSTREAM_REGISTRY = defaultCapabilityRegistry();
const VENDORED_REGISTRY = new Map<string, CapabilityManifest>(
  Object.entries(DEFAULT_CAPABILITY_MANIFESTS),
);
const VENDORED_HEADER = "// Vendored from controller/apply-node/src/apply-node-config.ts\n";

test("valid hostname config posts the evaluated plan and formats committed VITA-APPLY fields", async () => {
  const calls: TransportCall[] = [];
  const applyResult = committedResult();

  const result = await applyVendored(
    hostnameConfig("vita-node-7"),
    VENDORED_REGISTRY,
    fakeTransport({ body: applyResult, status: 200 }, calls),
  );

  if (!result.ok) {
    assert.fail(`expected apply to succeed: ${JSON.stringify(result)}`);
  }

  const expectedPlan = {
    operations: [
      {
        capability: "hostname.set",
        request: {
          desired: "vita-node-7",
        },
      },
    ],
  };

  assert.deepEqual(result.plan, expectedPlan);
  assert.deepEqual(result.applyResult, applyResult);
  assert.deepEqual(calls, [
    {
      body: expectedPlan,
      method: "POST",
      path: "/apply",
    },
  ]);
  assert.equal(
    formatApplyMarker(result),
    "VITA-APPLY: outcome=committed applied=1 rolledBack=0 audit=recorded status=OK",
  );
});

test("vendored apply-node-config matches upstream behavior on the same mock apply transport", async () => {
  const upstreamCalls: TransportCall[] = [];
  const vendoredCalls: TransportCall[] = [];

  const upstream = await applyUpstream(
    nodeConfig(),
    UPSTREAM_REGISTRY,
    fakeTransport({ body: committedNodeConfigResult(), status: 200 }, upstreamCalls),
  );
  const vendored = await applyVendored(
    nodeConfig(),
    VENDORED_REGISTRY,
    fakeTransport({ body: committedNodeConfigResult(), status: 200 }, vendoredCalls),
  );

  assert.deepEqual(vendored, upstream);
  assert.deepEqual(vendoredCalls, upstreamCalls);
});

test("vendored apply-node-config body is upstream-identical except header and import paths", () => {
  const vendored = normalizeLineEndings(
    readFileSync(fileURLToPath(new URL("./vita/apply-node-config.ts", import.meta.url)), "utf8"),
  );
  const upstream = normalizeLineEndings(
    readFileSync(
      fileURLToPath(
        new URL("../../../../../../../controller/apply-node/src/apply-node-config.ts", import.meta.url),
      ),
      "utf8",
    ),
  );

  assert.equal(vendored.startsWith(VENDORED_HEADER), true);
  assert.equal(rewriteVendoredImports(vendored.slice(VENDORED_HEADER.length)), upstream);
});

test("agent-side rejected apply outcome is surfaced as fail-closed VITA-APPLY, not thrown", async () => {
  const result = await applyVendored(
    hostnameConfig("vita-node-7"),
    VENDORED_REGISTRY,
    fakeTransport({ body: rejectedResult(), status: 200 }),
  );

  assertApplyFailure(result);
  assert.equal(result.applyResult?.outcome, "rejected");
  assert.equal(result.applyResult?.error?.code, "invalid_request");
  assert.equal(
    formatApplyMarker(result),
    "VITA-APPLY: outcome=rejected reason=invalid_request status=OK",
  );
});

test("transport errors become a VITA-APPLY-ERROR failsafe result", async () => {
  let calls = 0;
  const result = await applyVendored(hostnameConfig("vita-node-7"), VENDORED_REGISTRY, async () => {
    calls += 1;
    throw new Error("socket unavailable");
  });

  assertTransportFailure(result);
  assert.equal(calls, 1);
  assert.equal(formatApplyMarker(result), "VITA-APPLY-ERROR: status=FAILSAFE");
});

test("unix socket apply transport allows only GETs plus exact POST /apply", async () => {
  await withFakeDeno("HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\n{}", async (requests) => {
    const transport = createDenoUnixSocketApplyAgentTransport({
      socketPath: "/tmp/vita-agent.sock",
    });

    const health = await transport("http://agentd/healthz", {
      method: "GET",
    });
    const apply = await transport("http://agentd/apply", {
      body: "{}",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      method: "POST",
    });

    assert.equal(health.status, 200);
    assert.equal(apply.status, 200);
    assert.match(requests[0] ?? "", /^GET \/healthz HTTP\/1\.1/u);
    assert.match(requests[1] ?? "", /^POST \/apply HTTP\/1\.1/u);
  });

  const applyTransport = createDenoUnixSocketApplyAgentTransport({
    socketPath: "/tmp/vita-agent.sock",
  });
  await assert.rejects(
    () =>
      applyTransport("http://agentd/healthz", {
        body: "{}",
        method: "POST",
      }),
    /only allows GET plus POST \/apply/u,
  );
  await assert.rejects(
    () =>
      applyTransport("http://agentd/apply?debug=1", {
        body: "{}",
        method: "POST",
      }),
    /only allows GET plus POST \/apply/u,
  );

  const readOnlyTransport = createDenoUnixSocketAgentTransport({
    socketPath: "/tmp/vita-agent.sock",
  });
  await assert.rejects(
    () =>
      readOnlyTransport("http://agentd/apply", {
        body: "{}",
        method: "POST",
      }),
    /read-only/u,
  );
});

interface TransportCall {
  readonly method: Parameters<ApplyNodeTransport>[0];
  readonly path: Parameters<ApplyNodeTransport>[1];
  readonly body: Parameters<ApplyNodeTransport>[2];
}

interface TestDenoConn {
  write(data: Uint8Array): Promise<number>;
  read(buffer: Uint8Array): Promise<number | null>;
  close(): void;
}

interface TestDeno {
  connect(options: { readonly transport: "unix"; readonly path: string }): Promise<TestDenoConn>;
}

interface TestGlobal {
  Deno?: TestDeno;
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

function hostnameConfig(hostname: string): unknown {
  return {
    "hostname.set": {
      desired: hostname,
    },
  };
}

function nodeConfig(): unknown {
  return {
    "node.config": {
      desired: {
        mode: "normal",
        remoteAccess: "disabled",
      },
    },
  };
}

function committedResult(): ApplyNodeApplyResult {
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

function committedNodeConfigResult(): ApplyNodeApplyResult {
  return {
    applied: [
      {
        capability: "node.config",
        index: 0,
      },
    ],
    outcome: "committed",
    rollbackErrors: [],
    rolledBack: [],
  };
}

function rejectedResult(): ApplyNodeApplyResult {
  return {
    applied: [],
    error: {
      code: "invalid_request",
      message: "agentd rejected the untrusted plan",
    },
    outcome: "rejected",
    rollbackErrors: [],
    rolledBack: [],
  };
}

function formatApplyMarker(result: ApplyNodeConfigResult): string {
  if (result.ok) {
    return (
      "VITA-APPLY: " +
      `outcome=${result.applyResult.outcome} ` +
      `applied=${result.applyResult.applied.length} ` +
      `rolledBack=${result.applyResult.rolledBack.length} ` +
      `audit=${result.applyResult.auditUnrecorded === true ? "unrecorded" : "recorded"} ` +
      "status=OK"
    );
  }

  if (result.stage === "apply" && result.applyResult?.outcome === "rejected") {
    return (
      "VITA-APPLY: " +
      `outcome=rejected reason=${markerToken(result.applyResult.error?.code ?? result.reason)} ` +
      "status=OK"
    );
  }

  return "VITA-APPLY-ERROR: status=FAILSAFE";
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

async function withFakeDeno(
  responseText: string,
  run: (requests: readonly string[]) => Promise<void>,
): Promise<void> {
  const global = globalThis as TestGlobal;
  const original = global.Deno;
  const requests: string[] = [];

  global.Deno = {
    connect: async () => createFakeConn(responseText, requests),
  };

  try {
    await run(requests);
  } finally {
    if (original === undefined) {
      delete global.Deno;
    } else {
      global.Deno = original;
    }
  }
}

function createFakeConn(responseText: string, requests: string[]): TestDenoConn {
  const response = new TextEncoder().encode(responseText);
  const decoder = new TextDecoder();
  let request = "";
  let readOffset = 0;
  let recorded = false;

  return {
    close() {},
    read: async (buffer) => {
      if (readOffset >= response.length) {
        if (!recorded) {
          requests[requests.length] = request;
          recorded = true;
        }

        return null;
      }

      const nextOffset = Math.min(readOffset + buffer.length, response.length);
      const chunk = response.subarray(readOffset, nextOffset);
      buffer.set(chunk);
      readOffset = nextOffset;
      return chunk.length;
    },
    write: async (data) => {
      request += decoder.decode(data, { stream: true });
      return data.length;
    },
  };
}

function normalizeLineEndings(source: string): string {
  return source.replaceAll("\r\n", "\n");
}

function rewriteVendoredImports(source: string): string {
  return source
    .replace(
      'import { evaluateNodeConfig } from "./evaluate.ts";',
      'import { evaluateNodeConfig } from "../../../runtime/evaluator/src/evaluate.ts";',
    )
    .replace(
      'import { safeNormalize } from "./safe-normalize.ts";',
      'import { safeNormalize } from "../../../sdk/typescript/src/safe-normalize.ts";',
    )
    .replace(
      '} from "./evaluate.ts";',
      '} from "../../../runtime/evaluator/src/evaluate.ts";',
    )
    .replace(
      '} from "./safe-normalize.ts";',
      '} from "../../../sdk/typescript/src/safe-normalize.ts";',
    );
}

function markerToken(value: string): string {
  const token = value.replace(/[^A-Za-z0-9_.-]+/gu, "_");
  return token.length === 0 ? "unknown" : token;
}
