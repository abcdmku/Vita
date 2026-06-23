import assert from "node:assert/strict";
import { test } from "node:test";

import { createAgentClient } from "./vita/agent-client.ts";
import {
  formatPdsSyncStateReadMarker,
  parsePdsSyncStateReadResponse,
  readPdsSyncStateSummary,
} from "./vita/pds-read.ts";
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

const VALID_REPO = "did:plc:ewvi7nxzyoun6zhxrhs64oiz";
const VALID_HEAD = "bafybeigdyrzt5sfp7udm7hu76ekfya5f45mcm6qzdv6woc4f3gj3sidfwy";

test("pds read helper issues the pds.sync-state read and formats VITA-PDS fields", async () => {
  const mock = createMockTransport([
    [
      "/read/pds.sync-state",
      {
        body: JSON.stringify({
          exists: true,
          raw: "canonical-pds-sync-state",
          state: {
            cursor: 42,
            repo: VALID_REPO,
            repoHead: VALID_HEAD,
          },
        }),
      },
    ],
  ]);
  const client = createAgentClient({
    baseUrl: "http://agentd",
    transport: mock.transport,
  });

  const result = await readPdsSyncStateSummary(client);

  assert.equal(result.ok, true);
  if (!result.ok) {
    assert.fail("PDS read unexpectedly failed");
  }
  assert.deepEqual(result.state, {
    cursor: 42,
    head: VALID_HEAD,
    repo: VALID_REPO,
  });
  assert.equal(
    formatPdsSyncStateReadMarker(result),
    `VITA-PDS: repo=${VALID_REPO} cursor=42 head=${VALID_HEAD} status=OK`,
  );
  assert.deepEqual(mock.requests.map(snapshotRequest), [
    {
      body: null,
      headers: {
        Accept: "application/json",
      },
      method: "GET",
      url: "http://agentd/read/pds.sync-state",
    },
  ]);
});

test("pds read helper handles an uninitialized PDS as repo/head none", async () => {
  const mock = createMockTransport([
    [
      "/read/pds.sync-state",
      {
        body: JSON.stringify({
          exists: false,
          raw: null,
          state: {
            cursor: 0,
            repo: "",
            repoHead: "",
          },
        }),
      },
    ],
  ]);
  const client = createAgentClient({
    baseUrl: "http://agentd",
    transport: mock.transport,
  });

  const result = await readPdsSyncStateSummary(client);

  assert.equal(result.ok, true);
  if (!result.ok) {
    assert.fail("empty PDS read unexpectedly failed");
  }
  assert.deepEqual(result.state, {
    cursor: 0,
    head: null,
    repo: null,
  });
  assert.equal(
    formatPdsSyncStateReadMarker(result),
    "VITA-PDS: repo=none cursor=0 head=none status=OK",
  );
});

test("pds read helper fails closed on transport errors and malformed responses", async () => {
  const failingTransport: AgentTransport = async () => {
    throw new Error("socket unavailable");
  };
  const failingClient = createAgentClient({
    baseUrl: "http://agentd",
    transport: failingTransport,
  });

  const transportResult = await readPdsSyncStateSummary(failingClient);
  assert.equal(transportResult.ok, false);
  assert.equal(
    formatPdsSyncStateReadMarker(transportResult),
    "VITA-PDS-ERROR: status=FAILSAFE",
  );

  const malformedMock = createMockTransport([
    [
      "/read/pds.sync-state",
      {
        body: JSON.stringify({
          exists: true,
          raw: null,
          state: {
            cursor: 42,
            repo: VALID_REPO,
          },
        }),
      },
    ],
  ]);
  const malformedClient = createAgentClient({
    baseUrl: "http://agentd",
    transport: malformedMock.transport,
  });

  const malformedResult = await readPdsSyncStateSummary(malformedClient);
  assert.equal(malformedResult.ok, false);
  assert.equal(
    formatPdsSyncStateReadMarker(malformedResult),
    "VITA-PDS-ERROR: status=FAILSAFE",
  );
});

test("pds read parser rejects hostile shapes without throwing or invoking accessors", () => {
  let getterReads = 0;
  const accessorResponse = {};
  Object.defineProperty(accessorResponse, "exists", {
    enumerable: true,
    get() {
      getterReads += 1;
      return true;
    },
  });

  const accessorResult = parsePdsSyncStateReadResponse(accessorResponse);
  assert.equal(accessorResult.ok, false);
  assert.equal(getterReads, 0);

  const cyclicResponse: { exists: boolean; self?: unknown } = {
    exists: false,
  };
  cyclicResponse.self = cyclicResponse;

  const cyclicResult = parsePdsSyncStateReadResponse(cyclicResponse);
  assert.equal(cyclicResult.ok, false);
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
