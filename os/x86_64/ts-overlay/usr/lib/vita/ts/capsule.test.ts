import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  buildCapsuleRegistryConfig as buildUpstreamCapsuleRegistryConfig,
  validateCapsuleRegistry as validateUpstreamCapsuleRegistry,
} from "../../../../../../../sdk/typescript/src/capsule-registry-model.ts";
import {
  applyNodeConfig,
} from "./vita/apply-node-config.ts";
import {
  buildCapsuleRegistryConfig,
  validateCapsuleRegistry,
  validateCapsuleRegistryApplyRequest,
} from "./vita/capsule-registry-model.ts";
import { DEFAULT_CAPABILITY_MANIFESTS } from "./vita/generated/capability-manifests.generated.ts";
import type {
  ApplyNodeApplyResult,
  ApplyNodeConfigResult,
  ApplyNodeTransport,
  ApplyNodeTransportResponse,
} from "./vita/apply-node-config.ts";
import type {
  CapsuleEntry,
  CapsuleRegistryValidationError,
  CapsuleRegistryValidationResult,
} from "./vita/capsule-registry-model.ts";
import type { CapabilityManifest } from "./vita/capability-manifest.ts";

const VENDORED_REGISTRY = new Map<string, CapabilityManifest>(
  Object.entries(DEFAULT_CAPABILITY_MANIFESTS),
);
const VENDORED_HEADER = "// Vendored from sdk/typescript/src/capsule-registry-model.ts\n";
const TEST_CAPSULE_ENTRY = Object.freeze({
  id: "local.test.capsule",
  integrity: "sha256-47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU=",
  state: "installed",
  version: "1.0.0",
}) satisfies CapsuleEntry;

test("capsule registry model validates and builds the agent apply request shape", () => {
  const registryResult = validateCapsuleRegistry(Object.freeze([TEST_CAPSULE_ENTRY]));
  const requestResult = validateCapsuleRegistryApplyRequest({
    desired: {
      capsules: [TEST_CAPSULE_ENTRY],
    },
  });
  const configResult = buildCapsuleRegistryConfig(Object.freeze([TEST_CAPSULE_ENTRY]));

  if (!registryResult.ok) {
    assert.fail(`expected registry to validate: ${JSON.stringify(registryResult.errors)}`);
  }
  if (!requestResult.ok) {
    assert.fail(`expected request to validate: ${JSON.stringify(requestResult.errors)}`);
  }
  if (!configResult.ok) {
    assert.fail(`expected config to build: ${JSON.stringify(configResult.errors)}`);
  }

  assert.deepEqual(registryResult.registry, [TEST_CAPSULE_ENTRY]);
  assert.deepEqual(requestResult.request, {
    desired: {
      capsules: [TEST_CAPSULE_ENTRY],
    },
  });
  assert.deepEqual(configResult.config, {
    "capsule.registry": requestResult.request,
  });
});

test("capsule registry model rejects bad SRI, embedded secret, and unknown field", () => {
  assert.deepEqual(
    rejectedPaths(
      validateCapsuleRegistry([
        {
          ...TEST_CAPSULE_ENTRY,
          integrity: "sha256-AAAA",
        },
      ]),
    ),
    ["0/integrity"],
  );
  assert.deepEqual(
    rejectedPaths(
      validateCapsuleRegistry([
        {
          ...TEST_CAPSULE_ENTRY,
          version: "private_key",
        },
      ]),
    ),
    ["0/version"],
  );
  assert.deepEqual(
    rejectedPaths(
      validateCapsuleRegistry([
        {
          ...TEST_CAPSULE_ENTRY,
          reload: true,
        },
      ]),
    ),
    ["0/reload"],
  );
});

test("capsule apply config posts the evaluated /apply body and formats committed fields", async () => {
  const config = buildCapsuleRegistryConfig(Object.freeze([TEST_CAPSULE_ENTRY]));
  const calls: TransportCall[] = [];
  const applyResult = committedCapsuleResult();

  if (!config.ok) {
    assert.fail(`expected config to build: ${JSON.stringify(config.errors)}`);
  }

  const result = await applyNodeConfig(
    config.config,
    VENDORED_REGISTRY,
    fakeTransport({ body: applyResult, status: 200 }, calls),
  );

  if (!result.ok) {
    assert.fail(`expected capsule apply to succeed: ${JSON.stringify(result)}`);
  }

  const expectedPlan = {
    operations: [
      {
        capability: "capsule.registry",
        request: {
          desired: {
            capsules: [TEST_CAPSULE_ENTRY],
          },
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
    formatCapsuleMarker(TEST_CAPSULE_ENTRY, result),
    "VITA-CAPSULE: id=local.test.capsule ver=1.0.0 state=installed outcome=committed status=OK",
  );
});

test("agent-side rejected capsule outcome is parsed into VITA-CAPSULE rejection fields", async () => {
  const config = buildCapsuleRegistryConfig(Object.freeze([TEST_CAPSULE_ENTRY]));

  if (!config.ok) {
    assert.fail(`expected config to build: ${JSON.stringify(config.errors)}`);
  }

  const result = await applyNodeConfig(
    config.config,
    VENDORED_REGISTRY,
    fakeTransport({ body: rejectedCapsuleResult(), status: 200 }),
  );

  assertApplyFailure(result);
  assert.equal(result.applyResult?.outcome, "rejected");
  assert.equal(result.applyResult?.error?.code, "invalid_request");
  assert.equal(
    formatCapsuleMarker(TEST_CAPSULE_ENTRY, result),
    "VITA-CAPSULE: outcome=rejected reason=invalid_request status=OK",
  );
});

test("capsule apply transport errors fail closed into VITA-CAPSULE-ERROR", async () => {
  const config = buildCapsuleRegistryConfig(Object.freeze([TEST_CAPSULE_ENTRY]));
  let calls = 0;

  if (!config.ok) {
    assert.fail(`expected config to build: ${JSON.stringify(config.errors)}`);
  }

  const result = await applyNodeConfig(config.config, VENDORED_REGISTRY, async () => {
    calls += 1;
    throw new Error("socket unavailable");
  });

  assertTransportFailure(result);
  assert.equal(calls, 1);
  assert.equal(formatCapsuleMarker(TEST_CAPSULE_ENTRY, result), "VITA-CAPSULE-ERROR: status=FAILSAFE");
});

test("main.ts wiring: NET-NS marker requires netns, loopback, and enforced isolation", () => {
  assert.equal(
    formatCapsuleNetnsMarker({
      id: TEST_CAPSULE_ENTRY.id,
      network: {
        egress: 1,
        ingress: 1,
        isolation: "enforced",
        loopback: "OK",
        netns: "vita-capsule-local.test",
      },
    }),
    "VITA-CAPSULE-NET-NS: id=local.test.capsule netns=vita-capsule-local.test loopback=OK isolation=enforced status=OK",
  );

  for (const status of [
    { id: TEST_CAPSULE_ENTRY.id },
    {
      id: TEST_CAPSULE_ENTRY.id,
      network: {
        egress: 1,
        ingress: 1,
        isolation: "enforced",
        netns: "vita-capsule-local.test",
      },
    },
    {
      id: TEST_CAPSULE_ENTRY.id,
      network: {
        egress: 1,
        ingress: 1,
        loopback: "OK",
        netns: "vita-capsule-local.test",
      },
    },
  ] satisfies readonly CapsuleNetnsMarkerStatus[]) {
    assert.equal(
      formatCapsuleNetnsMarker(status),
      "VITA-CAPSULE-NET-NS-ERROR: reason=netns_unverified status=FAILSAFE",
    );
  }
});

test("vendored capsule registry model matches upstream source and behavior", () => {
  const vendored = normalizeLineEndings(
    readFileSync(fileURLToPath(new URL("./vita/capsule-registry-model.ts", import.meta.url)), "utf8"),
  );
  const upstream = normalizeLineEndings(
    readFileSync(
      fileURLToPath(
        new URL("../../../../../../../sdk/typescript/src/capsule-registry-model.ts", import.meta.url),
      ),
      "utf8",
    ),
  );

  assert.equal(vendored.startsWith(VENDORED_HEADER), true);
  assert.equal(vendored.slice(VENDORED_HEADER.length), upstream);

  const sample = Object.freeze([TEST_CAPSULE_ENTRY]);
  assert.deepEqual(validateCapsuleRegistry(sample), validateUpstreamCapsuleRegistry(sample));
  assert.deepEqual(buildCapsuleRegistryConfig(sample), buildUpstreamCapsuleRegistryConfig(sample));
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

function committedCapsuleResult(): ApplyNodeApplyResult {
  return {
    applied: [
      {
        capability: "capsule.registry",
        index: 0,
      },
    ],
    outcome: "committed",
    rollbackErrors: [],
    rolledBack: [],
  };
}

function rejectedCapsuleResult(): ApplyNodeApplyResult {
  return {
    applied: [],
    error: {
      code: "invalid_request",
      message: "agentd rejected the untrusted capsule registry request",
    },
    outcome: "rejected",
    rollbackErrors: [],
    rolledBack: [],
  };
}

function formatCapsuleMarker(
  entry: CapsuleEntry,
  result: ApplyNodeConfigResult,
): string {
  if (result.ok) {
    return (
      "VITA-CAPSULE: " +
      `id=${entry.id} ` +
      `ver=${entry.version} ` +
      `state=${entry.state} ` +
      `outcome=${result.applyResult.outcome} ` +
      "status=OK"
    );
  }

  if (result.stage === "apply" && result.applyResult?.outcome === "rejected") {
    return (
      "VITA-CAPSULE: " +
      `outcome=rejected reason=${markerToken(result.applyResult.error?.code ?? result.reason)} ` +
      "status=OK"
    );
  }

  return "VITA-CAPSULE-ERROR: status=FAILSAFE";
}

interface CapsuleNetnsMarkerStatus {
  readonly id: string;
  readonly network?: {
    readonly egress: number;
    readonly ingress: number;
    readonly isolation?: "enforced";
    readonly loopback?: "OK";
    readonly netns?: string;
  };
}

function formatCapsuleNetnsMarker(status: CapsuleNetnsMarkerStatus): string {
  const network = status.network;
  if (
    network === undefined ||
    network.netns === undefined ||
    network.loopback !== "OK" ||
    network.isolation !== "enforced"
  ) {
    return "VITA-CAPSULE-NET-NS-ERROR: reason=netns_unverified status=FAILSAFE";
  }

  return (
    "VITA-CAPSULE-NET-NS: " +
    `id=${status.id} ` +
    `netns=${markerToken(network.netns)} ` +
    `loopback=${network.loopback} ` +
    `isolation=${network.isolation} ` +
    "status=OK"
  );
}

function rejectedPaths(
  result: CapsuleRegistryValidationResult,
): readonly string[] {
  if (result.ok) {
    assert.fail(`expected validation to fail: ${JSON.stringify(result.value)}`);
  }

  return [...new Set(result.errors.map((error) => error.path))].sort();
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

function markerToken(value: string): string {
  const token = value.replace(/[^A-Za-z0-9_.-]+/gu, "_");
  return token.length === 0 ? "unknown" : token;
}

function normalizeLineEndings(source: string): string {
  return source.replaceAll("\r\n", "\n");
}
