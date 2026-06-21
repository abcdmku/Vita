import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  compileCapabilityValidator,
  loadCapabilityManifest,
} from "../src/capability-manifest.ts";
import type {
  CapabilityManifest,
  CapabilityValidationResult,
  StringFieldFormat,
} from "../src/capability-manifest.ts";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const MANIFEST_PATH = resolve(REPO_ROOT, "schema", "capabilities", "network.json");
const CORPUS_PATH = resolve(
  REPO_ROOT,
  "schema",
  "capabilities",
  "conformance",
  "network.json",
);
const FORMAT_CORPUS_PATH = resolve(
  REPO_ROOT,
  "schema",
  "capabilities",
  "formats",
  "network-formats-conformance.json",
);
const NETWORK_MANIFEST = readNetworkManifest();
const validateNetwork = compileCapabilityValidator(NETWORK_MANIFEST);

type Expectation = "accept" | "reject";
type NetworkFormat = Extract<StringFieldFormat, "cidrLiteral" | "networkInterfaceName">;

interface ConformanceVector {
  readonly name: string;
  readonly request: unknown;
  readonly expect: Expectation;
  readonly rejectCode?: string;
  readonly normalized?: unknown;
}

interface FormatVector {
  readonly name: string;
  readonly value: string;
  readonly expect: Expectation;
  readonly canonical?: string;
  readonly coversAll?: boolean;
}

interface NetworkFormatCorpus {
  readonly cidrLiteral: readonly FormatVector[];
  readonly networkInterfaceName: readonly FormatVector[];
}

test("network conformance corpus matches the TS validator", () => {
  const vectors = readConformanceCorpus();

  assert.ok(vectors.length >= 26, "network conformance corpus must have at least 26 vectors");

  for (let index = 0; index < vectors.length; index += 1) {
    const vector = vectors[index];

    if (vector === undefined) {
      assert.fail("expected conformance vector");
    }

    const result = validateNetwork(vector.request);

    if (vector.expect === "accept") {
      if (!result.ok) {
        assert.fail(`${vector.name}: expected accept, got ${formatRejections(result)}`);
      }
      if (vector.normalized !== undefined) {
        assert.deepEqual(result.value, vector.normalized, vector.name);
      }
      continue;
    }

    if (result.ok) {
      assert.fail(`${vector.name}: expected reject, got ${JSON.stringify(result.value)}`);
    }

    if (vector.rejectCode !== undefined) {
      assert.equal(
        result.rejections.some((rejection) => rejection.path === vector.rejectCode),
        true,
        `${vector.name}: expected rejection at ${vector.rejectCode}, got ${formatRejections(result)}`,
      );
    }
  }
});

test("network formats conformance corpus matches the TS validator", () => {
  const corpus = readFormatCorpus();
  const validateCIDR = compileCapabilityValidator(singleValueManifest("cidrLiteral"));
  const validateInterface = compileCapabilityValidator(singleValueManifest("networkInterfaceName"));
  const validateCoversAll = compileCapabilityValidator(CIDR_COVERS_ALL_MANIFEST);

  assert.ok(corpus.cidrLiteral.length >= 16, "cidrLiteral corpus must have at least 16 vectors");
  assert.ok(
    corpus.networkInterfaceName.length >= 10,
    "networkInterfaceName corpus must have at least 10 vectors",
  );

  for (let index = 0; index < corpus.cidrLiteral.length; index += 1) {
    const vector = corpus.cidrLiteral[index];

    if (vector === undefined) {
      assert.fail("expected cidrLiteral vector");
    }

    const result = validateCIDR({ value: vector.value });
    assertFormatDecision("cidrLiteral", vector, result);

    if (vector.expect === "accept") {
      if (vector.coversAll === undefined) {
        assert.fail(`cidrLiteral ${vector.name}: coversAll is required for accepted vectors`);
      }

      const guardResult = validateCoversAll({
        port: -1,
        sourceCidr: vector.value,
        unsafeWideOpen: false,
      });

      assert.equal(
        guardResult.ok,
        !vector.coversAll,
        `cidrLiteral ${vector.name}: coversAll guard mismatch`,
      );
    }
  }

  for (let index = 0; index < corpus.networkInterfaceName.length; index += 1) {
    const vector = corpus.networkInterfaceName[index];

    if (vector === undefined) {
      assert.fail("expected networkInterfaceName vector");
    }

    assertFormatDecision("networkInterfaceName", vector, validateInterface({ value: vector.value }));
  }
});

function readNetworkManifest(): CapabilityManifest {
  const raw = JSON.parse(readFileSync(MANIFEST_PATH, "utf8")) as unknown;
  const loaded = loadCapabilityManifest(raw);

  if (!loaded.ok) {
    assert.fail(`network manifest failed to load: ${loaded.reason}`);
  }

  assert.equal(loaded.manifest.capability, "network.policy");
  return loaded.manifest;
}

function readConformanceCorpus(): readonly ConformanceVector[] {
  const raw = JSON.parse(readFileSync(CORPUS_PATH, "utf8")) as unknown;

  if (!Array.isArray(raw)) {
    assert.fail("network conformance corpus must be an array");
  }

  const vectors: ConformanceVector[] = [];

  for (let index = 0; index < raw.length; index += 1) {
    const item = raw[index];

    if (!isRecord(item)) {
      assert.fail(`network conformance vector ${index} must be an object`);
    }

    assertAllowedKeys(item, ["expect", "name", "normalized", "rejectCode", "request"], `vector ${index}`);

    const name = readRequiredString(item, "name", `vector ${index}.name`);
    const request = readRequiredProperty(item, "request", `vector ${index}.request`);
    const expect = readExpectation(item, "expect", `vector ${index}.expect`);
    const rejectCode = readOptionalString(item, "rejectCode", `vector ${index}.rejectCode`);
    const normalized = readOptionalProperty(item, "normalized");

    vectors.push({
      expect,
      name,
      ...(rejectCode === undefined ? {} : { rejectCode }),
      request,
      ...(normalized === undefined ? {} : { normalized }),
    });
  }

  return Object.freeze(vectors);
}

function readFormatCorpus(): NetworkFormatCorpus {
  const raw = JSON.parse(readFileSync(FORMAT_CORPUS_PATH, "utf8")) as unknown;

  if (!isRecord(raw)) {
    assert.fail("network format corpus must be an object");
  }

  assertAllowedKeys(raw, ["cidrLiteral", "networkInterfaceName"], "format corpus");

  return Object.freeze({
    cidrLiteral: readFormatVectors(
      readRequiredProperty(raw, "cidrLiteral", "format corpus.cidrLiteral"),
      "format corpus.cidrLiteral",
      true,
    ),
    networkInterfaceName: readFormatVectors(
      readRequiredProperty(raw, "networkInterfaceName", "format corpus.networkInterfaceName"),
      "format corpus.networkInterfaceName",
      false,
    ),
  });
}

function readFormatVectors(raw: unknown, path: string, allowCoversAll: boolean): readonly FormatVector[] {
  if (!Array.isArray(raw)) {
    assert.fail(`${path} must be an array`);
  }

  const vectors: FormatVector[] = [];

  for (let index = 0; index < raw.length; index += 1) {
    const item = raw[index];
    const itemPath = `${path}.${index}`;

    if (!isRecord(item)) {
      assert.fail(`${itemPath} must be an object`);
    }

    assertAllowedKeys(
      item,
      allowCoversAll ? ["canonical", "coversAll", "expect", "name", "value"] : ["expect", "name", "value"],
      itemPath,
    );

    const expect = readExpectation(item, "expect", `${itemPath}.expect`);
    const canonical = readOptionalString(item, "canonical", `${itemPath}.canonical`);
    const coversAll = readOptionalBoolean(item, "coversAll", `${itemPath}.coversAll`);

    if (expect === "accept" && canonical === undefined && allowCoversAll) {
      assert.fail(`${itemPath}.canonical is required for accepted cidrLiteral vectors`);
    }
    if (expect === "reject" && canonical !== undefined) {
      assert.fail(`${itemPath}.canonical is only supported for accepted vectors`);
    }
    if (!allowCoversAll && coversAll !== undefined) {
      assert.fail(`${itemPath}.coversAll is only supported for cidrLiteral vectors`);
    }

    vectors.push({
      expect,
      name: readRequiredString(item, "name", `${itemPath}.name`),
      value: readRequiredString(item, "value", `${itemPath}.value`),
      ...(canonical === undefined ? {} : { canonical }),
      ...(coversAll === undefined ? {} : { coversAll }),
    });
  }

  return Object.freeze(vectors);
}

function singleValueManifest(format: NetworkFormat): CapabilityManifest {
  return Object.freeze({
    capability: `test.${format}`,
    fields: Object.freeze({
      value: Object.freeze({
        format,
        required: true,
        type: "string",
      }),
    }),
    crossFieldRules: Object.freeze([]),
  });
}

function assertFormatDecision(
  format: NetworkFormat,
  vector: FormatVector,
  result: CapabilityValidationResult,
): void {
  if (vector.expect === "accept") {
    if (!result.ok) {
      assert.fail(`${format} ${vector.name}: expected accept, got ${formatRejections(result)}`);
    }

    assert.equal(
      result.value.value,
      vector.canonical ?? vector.value,
      `${format} ${vector.name}: canonical output mismatch`,
    );
    return;
  }

  if (result.ok) {
    assert.fail(`${format} ${vector.name}: expected reject, got ${JSON.stringify(result.value)}`);
  }
}

function readRequiredProperty(
  record: Readonly<Record<string, unknown>>,
  key: string,
  path: string,
): unknown {
  if (!Object.hasOwn(record, key)) {
    assert.fail(`${path} is required`);
  }

  return record[key];
}

function readOptionalProperty(
  record: Readonly<Record<string, unknown>>,
  key: string,
): unknown {
  return Object.hasOwn(record, key) ? record[key] : undefined;
}

function readRequiredString(
  record: Readonly<Record<string, unknown>>,
  key: string,
  path: string,
): string {
  const value = readRequiredProperty(record, key, path);

  if (typeof value !== "string") {
    assert.fail(`${path} must be a string`);
  }

  return value;
}

function readOptionalString(
  record: Readonly<Record<string, unknown>>,
  key: string,
  path: string,
): string | undefined {
  if (!Object.hasOwn(record, key)) {
    return undefined;
  }

  const value = record[key];

  if (typeof value !== "string") {
    assert.fail(`${path} must be a string when present`);
  }

  return value;
}

function readOptionalBoolean(
  record: Readonly<Record<string, unknown>>,
  key: string,
  path: string,
): boolean | undefined {
  if (!Object.hasOwn(record, key)) {
    return undefined;
  }

  const value = record[key];

  if (typeof value !== "boolean") {
    assert.fail(`${path} must be a boolean when present`);
  }

  return value;
}

function readExpectation(
  record: Readonly<Record<string, unknown>>,
  key: string,
  path: string,
): Expectation {
  const value = readRequiredString(record, key, path);

  if (value !== "accept" && value !== "reject") {
    assert.fail(`${path} must be accept or reject`);
  }

  return value;
}

function assertAllowedKeys(
  record: Readonly<Record<string, unknown>>,
  allowed: readonly string[],
  path: string,
): void {
  const allowedSet = new Set(allowed);
  const keys = Object.keys(record);

  for (let index = 0; index < keys.length; index += 1) {
    const key = keys[index];

    if (key !== undefined && !allowedSet.has(key)) {
      assert.fail(`${path}.${key} is not a supported network conformance field`);
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function formatRejections(result: CapabilityValidationResult): string {
  if (result.ok) {
    return JSON.stringify(result.value);
  }

  return JSON.stringify(result.rejections);
}

const CIDR_COVERS_ALL_MANIFEST = Object.freeze({
  capability: "test.cidr-covers-all",
  fields: Object.freeze({
    port: Object.freeze({
      maximum: 65535,
      minimum: 1,
      required: true,
      sentinelValues: Object.freeze([-1]),
      type: "integer",
    }),
    sourceCidr: Object.freeze({
      format: "cidrLiteral",
      required: true,
      type: "string",
    }),
    unsafeWideOpen: Object.freeze({
      required: true,
      type: "boolean",
    }),
  }),
  crossFieldRules: Object.freeze([
    Object.freeze({
      control: "unsafeWideOpen",
      integer: "port",
      sentinel: -1,
      target: "sourceCidr",
      type: "forbidIntegerSentinelAndCidrCoversAllUnlessTrue",
    }),
  ]),
} satisfies CapabilityManifest);
