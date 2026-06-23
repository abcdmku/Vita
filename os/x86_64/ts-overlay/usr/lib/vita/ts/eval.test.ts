import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { evaluateNodeConfig as evaluateUpstream } from "../../../../../../../runtime/evaluator/src/evaluate.ts";
import {
  defaultCapabilityRegistry,
} from "../../../../../../../sdk/typescript/src/capability-manifest.ts";
import { safeNormalize as upstreamSafeNormalize } from "../../../../../../../sdk/typescript/src/safe-normalize.ts";
import { evaluateNodeConfig as evaluateVendored } from "./vita/evaluate.ts";
import { DEFAULT_CAPABILITY_MANIFESTS as VENDORED_DEFAULT_CAPABILITY_MANIFESTS } from "./vita/generated/capability-manifests.generated.ts";
import { safeNormalize as vendoredSafeNormalize } from "./vita/safe-normalize.ts";
import type { CapabilityManifest } from "./vita/capability-manifest.ts";
import type { EvaluationResult } from "./vita/evaluate.ts";

const UPSTREAM_REGISTRY = defaultCapabilityRegistry();
const VENDORED_REGISTRY = new Map<string, CapabilityManifest>(
  Object.entries(VENDORED_DEFAULT_CAPABILITY_MANIFESTS),
);

const VALID_REPRESENTATIVE_CONFIG = Object.freeze({
  "time.sync": Object.freeze({
    desired: Object.freeze({
      enabled: true,
      servers: Object.freeze(["Pool.NTP.Org", "2001:0db8::1"]),
    }),
  }),
  "node.config": Object.freeze({
    desired: Object.freeze({
      mode: "maintenance",
      remoteAccess: "enabled",
    }),
  }),
  "hostname.set": Object.freeze({
    desired: "vita-node-7",
  }),
});

const CONFIG_CORPUS: readonly ConfigCase[] = Object.freeze([
  Object.freeze({
    name: "valid representative multi-capability config",
    config: VALID_REPRESENTATIVE_CONFIG,
  }),
  Object.freeze({
    name: "valid network config with canonical cidr",
    config: Object.freeze({
      "network.policy": Object.freeze({
        desired: Object.freeze({
          allow: Object.freeze([
            Object.freeze({
              proto: "tcp",
              port: 443,
              sourceCidr: "10.0.0.5/24",
              interface: "eth0",
            }),
          ]),
        }),
      }),
    }),
  }),
  Object.freeze({
    name: "empty config rejects",
    config: Object.freeze({}),
  }),
  Object.freeze({
    name: "unknown capability rejects",
    config: Object.freeze({
      "unknown.capability": Object.freeze({
        desired: true,
      }),
    }),
  }),
  Object.freeze({
    name: "invalid node.config rejects",
    config: Object.freeze({
      "node.config": Object.freeze({
        desired: Object.freeze({
          mode: "normal",
        }),
      }),
    }),
  }),
  Object.freeze({
    name: "invalid time.sync rejects",
    config: Object.freeze({
      "time.sync": Object.freeze({
        desired: Object.freeze({
          enabled: true,
          servers: Object.freeze([]),
        }),
      }),
    }),
  }),
]);

test("vendored evaluator returns byte-identical plans across repeated calls", () => {
  const first = evaluateVendored(VALID_REPRESENTATIVE_CONFIG, VENDORED_REGISTRY);
  const second = evaluateVendored(VALID_REPRESENTATIVE_CONFIG, VENDORED_REGISTRY);

  if (!first.ok) {
    assert.fail(`expected first evaluation to pass: ${JSON.stringify(first.rejections)}`);
  }
  if (!second.ok) {
    assert.fail(`expected second evaluation to pass: ${JSON.stringify(second.rejections)}`);
  }

  assert.equal(JSON.stringify(first.plan), JSON.stringify(second.plan));
  assert.deepEqual(
    first.plan.operations.map((operation) => operation.capability),
    ["hostname.set", "node.config", "time.sync"],
  );
});

test("vendored evaluator matches upstream for valid and invalid configs", () => {
  for (let index = 0; index < CONFIG_CORPUS.length; index += 1) {
    const item = CONFIG_CORPUS[index];

    if (item === undefined) {
      continue;
    }

    assert.deepEqual(
      evaluateVendored(item.config, VENDORED_REGISTRY),
      evaluateUpstream(item.config, UPSTREAM_REGISTRY),
      item.name,
    );
  }
});

test("invalid and unknown-capability configs fail closed with upstream rejection codes", () => {
  const invalidCases = CONFIG_CORPUS.filter((item) => item.name.includes("rejects"));

  for (let index = 0; index < invalidCases.length; index += 1) {
    const item = invalidCases[index];

    if (item === undefined) {
      continue;
    }

    const vendored = evaluateVendored(item.config, VENDORED_REGISTRY);
    const upstream = evaluateUpstream(item.config, UPSTREAM_REGISTRY);

    assertRejected(vendored, item.name);
    assertRejected(upstream, item.name);
    assert.deepEqual(rejectionCodes(vendored), rejectionCodes(upstream), item.name);
    assert.equal(Object.hasOwn(vendored, "plan"), false, item.name);
  }
});

test("vendored safe-normalize has no static node import and matches upstream behavior", () => {
  const source = readFileSync(
    fileURLToPath(new URL("./vita/safe-normalize.ts", import.meta.url)),
    "utf8",
  );

  assert.doesNotMatch(source, /from\s+["']node:/u);

  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;

  const hostile: Record<string, unknown> = {};
  let getterReads = 0;
  Object.defineProperty(hostile, "value", {
    enumerable: true,
    get() {
      getterReads += 1;
      throw new Error("getter should not be invoked");
    },
  });

  const samples: readonly NormalizeCase[] = Object.freeze([
    Object.freeze({
      name: "plain object",
      value: Object.freeze({
        nested: Object.freeze(["value", 1, true]),
      }),
    }),
    Object.freeze({
      name: "typed array rejects",
      value: Object.freeze({
        bytes: new Uint8Array([1, 2, 3]),
      }),
    }),
    Object.freeze({
      name: "DataView rejects",
      value: Object.freeze({
        view: new DataView(new ArrayBuffer(4)),
      }),
    }),
    Object.freeze({
      name: "proxy rejects",
      value: new Proxy(Object.freeze({ ok: true }), {}),
    }),
    Object.freeze({
      name: "cycle rejects",
      value: cyclic,
    }),
    Object.freeze({
      name: "accessor rejects",
      value: hostile,
    }),
  ]);

  for (let index = 0; index < samples.length; index += 1) {
    const sample = samples[index];

    if (sample === undefined) {
      continue;
    }

    assert.deepEqual(
      vendoredSafeNormalize(sample.value),
      upstreamSafeNormalize(sample.value),
      sample.name,
    );
  }

  assert.equal(getterReads, 0);
});

interface ConfigCase {
  readonly name: string;
  readonly config: unknown;
}

interface NormalizeCase {
  readonly name: string;
  readonly value: unknown;
}

function assertRejected(
  result: EvaluationResult,
  label: string,
): asserts result is Extract<EvaluationResult, { readonly ok: false }> {
  if (result.ok) {
    assert.fail(`${label}: expected rejection, got ${JSON.stringify(result.plan)}`);
  }
}

function rejectionCodes(
  result: Extract<EvaluationResult, { readonly ok: false }>,
): readonly string[] {
  return result.rejections.map((rejection) => rejection.code);
}
