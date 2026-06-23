import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { createAgentClient as createUpstreamAgentClient } from "../../../../../../../controller/agent-client/src/agent-client.ts";
import { createAgentClient as createVendoredAgentClient } from "./vita/agent-client.ts";
import { formatAgentStateMarker, readAgentStateSummary } from "./vita/agent-state.ts";
import type {
  AgentTransport,
  AgentTransportInit,
  AgentTransportResponse,
} from "./vita/agent-client.ts";

interface MockRoute {
  readonly body: string;
  readonly status?: number;
}

interface RecordedRequest {
  readonly url: string;
  readonly init: AgentTransportInit;
}

interface MockAgentTransport {
  readonly requests: readonly RecordedRequest[];
  readonly transport: AgentTransport;
}

const VENDORED_HEADER = "// Vendored from controller/agent-client/src/agent-client.ts\n";
const ROUTES = [
  [
    "/operations",
    {
      body: JSON.stringify({
        operations: ["hostname.set", "node.config", "time.sync"],
      }),
    },
  ],
  [
    "/read/hostname.set",
    {
      body: JSON.stringify({
        current: "vita-node-7",
      }),
    },
  ],
] as const satisfies readonly (readonly [string, MockRoute])[];

test("vendored agent client builds read requests and parses VITA-STATE fields", async () => {
  const mock = createMockTransport(ROUTES);
  const client = createVendoredAgentClient({
    baseUrl: "http://agentd",
    transport: mock.transport,
  });

  const result = await readAgentStateSummary(client);

  assert.equal(result.ok, true);
  if (!result.ok) {
    assert.fail("state summary unexpectedly failed");
  }

  assert.deepEqual(result.state, {
    caps: 3,
    hostname: "vita-node-7",
  });
  assert.equal(
    formatAgentStateMarker(result.state),
    "VITA-STATE: caps=3 hostname=vita-node-7 status=OK",
  );
  assert.deepEqual(mock.requests.map(snapshotRequest), [
    {
      body: null,
      headers: {
        Accept: "application/json",
      },
      method: "GET",
      url: "http://agentd/operations",
    },
    {
      body: null,
      headers: {
        Accept: "application/json",
      },
      method: "GET",
      url: "http://agentd/read/hostname.set",
    },
  ]);
});

test("vendored agent client matches upstream client on the same mock transport", async () => {
  const upstreamMock = createMockTransport(ROUTES);
  const vendoredMock = createMockTransport(ROUTES);
  const upstream = createUpstreamAgentClient({
    baseUrl: "http://agentd",
    transport: upstreamMock.transport,
  });
  const vendored = createVendoredAgentClient({
    baseUrl: "http://agentd",
    transport: vendoredMock.transport,
  });

  assert.deepEqual(await vendored.getOperations(), await upstream.getOperations());
  assert.deepEqual(
    await vendored.getState("hostname.set"),
    await upstream.getState("hostname.set"),
  );
  assert.deepEqual(
    vendoredMock.requests.map(snapshotRequest),
    upstreamMock.requests.map(snapshotRequest),
  );
});

test("state summary fails closed on transport errors and malformed responses", async () => {
  const failingTransport: AgentTransport = async () => {
    throw new Error("socket unavailable");
  };
  const failingClient = createVendoredAgentClient({
    baseUrl: "http://agentd",
    transport: failingTransport,
  });

  const transportResult = await readAgentStateSummary(failingClient);
  assert.equal(transportResult.ok, false);
  if (transportResult.ok) {
    assert.fail("transport failure unexpectedly produced state");
  }
  assert.match(transportResult.reason, /Agent transport request failed/u);

  const malformedMock = createMockTransport([
    [
      "/operations",
      {
        body: JSON.stringify({
          operations: [42],
        }),
      },
    ],
  ]);
  const malformedClient = createVendoredAgentClient({
    baseUrl: "http://agentd",
    transport: malformedMock.transport,
  });

  const malformedResult = await readAgentStateSummary(malformedClient);
  assert.equal(malformedResult.ok, false);
  if (malformedResult.ok) {
    assert.fail("malformed response unexpectedly produced state");
  }
  assert.match(malformedResult.reason, /expected wire shape/u);
});

test("vendored agent client body is upstream-identical except header and import paths", () => {
  const vendored = normalizeLineEndings(
    readFileSync(
      fileURLToPath(new URL("./vita/agent-client.ts", import.meta.url)),
      "utf8",
    ),
  );
  const upstream = normalizeLineEndings(
    readFileSync(
      fileURLToPath(
        new URL("../../../../../../../controller/agent-client/src/agent-client.ts", import.meta.url),
      ),
      "utf8",
    ),
  );

  assert.equal(vendored.startsWith(VENDORED_HEADER), true);
  assert.equal(rewriteVendoredImports(vendored.slice(VENDORED_HEADER.length)), upstream);
});

function createMockTransport(routes: readonly (readonly [string, MockRoute])[]): MockAgentTransport {
  const routeMap = new Map<string, MockRoute>(routes);
  const requests: RecordedRequest[] = [];
  const transport: AgentTransport = async (url, init) => {
    requests.push({ init, url });

    const route = routeMap.get(new URL(url).pathname);
    if (route === undefined) {
      return jsonResponse(
        404,
        JSON.stringify({
          error: {
            code: "not_found",
            message: "not found",
          },
        }),
      );
    }

    return jsonResponse(route.status ?? 200, route.body);
  };

  return {
    requests,
    transport,
  };
}

function jsonResponse(status: number, body: string): AgentTransportResponse {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => body,
  };
}

function snapshotRequest(request: RecordedRequest): {
  readonly body: string | null;
  readonly headers: Readonly<Record<string, string>> | null;
  readonly method: "GET" | "POST";
  readonly url: string;
} {
  return {
    body: request.init.body ?? null,
    headers: request.init.headers ?? null,
    method: request.init.method,
    url: request.url,
  };
}

function normalizeLineEndings(source: string): string {
  return source.replaceAll("\r\n", "\n");
}

function rewriteVendoredImports(source: string): string {
  return source
    .replace(
      'import { safeNormalize } from "./safe-normalize.ts";',
      'import { safeNormalize } from "../../../sdk/typescript/src/safe-normalize.ts";',
    )
    .replace(
      'import type {\n  PlainJson,\n  PlainJsonObject,\n} from "./safe-normalize.ts";',
      'import type {\n  PlainJson,\n  PlainJsonObject,\n} from "../../../sdk/typescript/src/safe-normalize.ts";',
    )
    .replace(
      'import type { CanonicalJsonObject } from "./plan.ts";',
      'import type { CanonicalJsonObject } from "../../../sdk/typescript/src/plan.ts";',
    );
}
