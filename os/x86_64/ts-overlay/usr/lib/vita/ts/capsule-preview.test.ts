import assert from "node:assert/strict";
import { test } from "node:test";

import {
  createAgentClient,
} from "./vita/agent-client.ts";
import {
  formatCapsuleRegistryPreviewMarker,
  ON_DEVICE_CAPSULE_REGISTRY,
  parseCapsuleRegistryReadResponse,
  previewCapsuleChange as previewVendoredCapsuleChange,
  readCapsuleRegistryPreview,
} from "./vita/capsule-preview.ts";
import {
  previewCapsuleChange as previewUpstreamCapsuleChange,
} from "../../../../../../../controller/capsule/src/capsule-preview.ts";
import type {
  CapsuleChangePreview,
  CapsuleRegistryPreviewResult,
} from "./vita/capsule-preview.ts";
import type {
  AgentTransport,
  AgentTransportInit,
  AgentTransportResponse,
} from "./vita/agent-client.ts";
import type {
  CapsuleEntry,
  CapsuleIntegrity,
  CapsuleRegistry,
} from "./vita/capsule-registry-model.ts";

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

type SuccessfulCapsulePreviewResult =
  Extract<CapsuleRegistryPreviewResult, { readonly ok: true }> & {
    readonly preview: Extract<CapsuleChangePreview, { readonly valid: true }>;
  };

const SHA256_EMPTY = "sha256-47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU=";
const SHA256_ONES = sri256(1);
const SHA256_TWOS = sri256(2);

test("capsule preview reads capsule.registry and reports install remove upgrade counts", async () => {
  const current: CapsuleRegistry = [
    capsule("local.test.capsule", "0.9.0", SHA256_EMPTY, "installed"),
    capsule("local.remove.capsule", "1.0.0", SHA256_TWOS, "disabled"),
  ];
  const desired: CapsuleRegistry = [
    capsule("local.test.capsule", "1.0.0", SHA256_EMPTY, "installed"),
    capsule("local.install.capsule", "2.0.0", SHA256_ONES, "installed"),
  ];
  const mock = createMockTransport([
    [
      "/read/capsule.registry",
      {
        body: JSON.stringify({
          exists: true,
          raw: "canonical-capsule-registry",
          registry: {
            capsules: current,
          },
        }),
      },
    ],
  ]);
  const client = createAgentClient({
    baseUrl: "http://agentd",
    transport: mock.transport,
  });

  const result = await readCapsuleRegistryPreview(client, desired);

  assertCapsulePreviewSuccess(result);

  assert.deepEqual(result.counts, {
    installed: 1,
    removed: 1,
    upgraded: 1,
  });
  assert.deepEqual(Object.keys(result.preview.diff.installed), ["local.install.capsule"]);
  assert.deepEqual(Object.keys(result.preview.diff.removed), ["local.remove.capsule"]);
  assert.deepEqual(Object.keys(result.preview.diff.upgraded), ["local.test.capsule"]);

  const marker = formatCapsuleRegistryPreviewMarker(result);
  assert.equal(
    marker,
    "VITA-CAPSULE-PREVIEW: installed=1 removed=1 upgraded=1 status=OK",
  );
  assert.deepEqual(parsePreviewMarker(marker), {
    installed: 1,
    removed: 1,
    status: "OK",
    upgraded: 1,
  });
  assert.deepEqual(mock.requests.map(snapshotRequest), [
    {
      body: null,
      headers: {
        Accept: "application/json",
      },
      method: "GET",
      url: "http://agentd/read/capsule.registry",
    },
  ]);
});

test("capsule preview reports all-zero counts when current equals desired", async () => {
  const mock = createMockTransport([
    [
      "/read/capsule.registry",
      {
        body: JSON.stringify({
          exists: true,
          raw: "canonical-capsule-registry",
          registry: {
            capsules: ON_DEVICE_CAPSULE_REGISTRY,
          },
        }),
      },
    ],
  ]);
  const client = createAgentClient({
    baseUrl: "http://agentd",
    transport: mock.transport,
  });

  const result = await readCapsuleRegistryPreview(client);

  assertCapsulePreviewSuccess(result);
  assert.deepEqual(result.counts, {
    installed: 0,
    removed: 0,
    upgraded: 0,
  });
  assert.equal(
    formatCapsuleRegistryPreviewMarker(result),
    "VITA-CAPSULE-PREVIEW: installed=0 removed=0 upgraded=0 status=OK",
  );
});

test("capsule preview treats a missing current registry as an empty registry", async () => {
  const mock = createMockTransport([
    [
      "/read/capsule.registry",
      {
        body: JSON.stringify({
          exists: false,
          raw: null,
          registry: {
            capsules: null,
          },
        }),
      },
    ],
  ]);
  const client = createAgentClient({
    baseUrl: "http://agentd",
    transport: mock.transport,
  });

  const result = await readCapsuleRegistryPreview(client);

  assertCapsulePreviewSuccess(result);
  assert.deepEqual(result.counts, {
    installed: 1,
    removed: 0,
    upgraded: 0,
  });
});

test("capsule preview fails closed on transport errors and malformed responses", async () => {
  const failingClient = createAgentClient({
    baseUrl: "http://agentd",
    transport: async () => {
      throw new Error("socket unavailable");
    },
  });

  const transportResult = await readCapsuleRegistryPreview(failingClient);
  assert.equal(transportResult.ok, false);
  assert.equal(
    formatCapsuleRegistryPreviewMarker(transportResult),
    "VITA-CAPSULE-PREVIEW-ERROR: status=FAILSAFE",
  );

  const malformedMock = createMockTransport([
    [
      "/read/capsule.registry",
      {
        body: JSON.stringify({
          exists: true,
          raw: null,
          registry: {
            capsules: [
              {
                id: "local.test.capsule",
                integrity: "sha256-AAAA",
                state: "installed",
                version: "1.0.0",
              },
            ],
          },
        }),
      },
    ],
  ]);
  const malformedClient = createAgentClient({
    baseUrl: "http://agentd",
    transport: malformedMock.transport,
  });

  const malformedResult = await readCapsuleRegistryPreview(malformedClient);
  assert.equal(malformedResult.ok, false);
  assert.equal(
    formatCapsuleRegistryPreviewMarker(malformedResult),
    "VITA-CAPSULE-PREVIEW-ERROR: status=FAILSAFE",
  );
});

test("capsule preview parser rejects hostile shapes without throwing or invoking accessors", () => {
  let getterReads = 0;
  const accessorResponse = {};
  Object.defineProperty(accessorResponse, "exists", {
    enumerable: true,
    get() {
      getterReads += 1;
      return true;
    },
  });

  const accessorResult = parseCapsuleRegistryReadResponse(accessorResponse);
  assert.equal(accessorResult.ok, false);
  assert.equal(getterReads, 0);

  const cyclicResponse: { exists: boolean; self?: unknown } = {
    exists: false,
  };
  cyclicResponse.self = cyclicResponse;

  const cyclicResult = parseCapsuleRegistryReadResponse(cyclicResponse);
  assert.equal(cyclicResult.ok, false);
});

test("vendored capsule diff behavior matches the controller capsule preview on valid inputs", () => {
  const current: CapsuleRegistry = [
    capsule("local.test.capsule", "0.9.0", SHA256_EMPTY, "installed"),
    capsule("local.remove.capsule", "1.0.0", SHA256_TWOS, "disabled"),
  ];
  const desired: CapsuleRegistry = [
    capsule("local.test.capsule", "1.0.0", SHA256_EMPTY, "installed"),
    capsule("local.install.capsule", "2.0.0", SHA256_ONES, "installed"),
  ];

  assert.deepEqual(
    toPlainJson(previewVendoredCapsuleChange(current, desired)),
    toPlainJson(previewUpstreamCapsuleChange(current, desired)),
  );
});

function createMockTransport(routes: readonly (readonly [string, MockRoute])[]): MockAgentTransport {
  const routeMap = new Map<string, MockRoute>(routes);
  const requests: RecordedRequest[] = [];
  const transport: AgentTransport = async (url, init) => {
    requests.push({ init, url });

    if (init.method !== "GET") {
      throw new Error("mock capsule preview transport is read-only");
    }

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

function parsePreviewMarker(marker: string): {
  readonly installed: number;
  readonly removed: number;
  readonly upgraded: number;
  readonly status: "OK";
} {
  const match =
    /^VITA-CAPSULE-PREVIEW: installed=([0-9]+) removed=([0-9]+) upgraded=([0-9]+) status=(OK)$/u
      .exec(marker);

  if (match === null) {
    assert.fail(`marker did not parse: ${marker}`);
  }

  const installed = match[1];
  const removed = match[2];
  const upgraded = match[3];
  const status = match[4];

  if (
    installed === undefined ||
    removed === undefined ||
    upgraded === undefined ||
    status !== "OK"
  ) {
    assert.fail(`marker fields were incomplete: ${marker}`);
  }

  return {
    installed: Number.parseInt(installed, 10),
    removed: Number.parseInt(removed, 10),
    status,
    upgraded: Number.parseInt(upgraded, 10),
  };
}

function assertCapsulePreviewSuccess(
  result: CapsuleRegistryPreviewResult,
): asserts result is SuccessfulCapsulePreviewResult {
  if (!result.ok) {
    assert.fail(`expected capsule preview to succeed: ${result.reason}`);
  }

  if (!result.preview.valid) {
    assert.fail("expected capsule preview diff to be valid");
  }
}

function capsule(
  id: string,
  version: string,
  integrity: CapsuleIntegrity,
  state: CapsuleEntry["state"],
): CapsuleEntry {
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

function toPlainJson(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value)) as unknown;
}
