import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { compileCapabilityValidator } from "../src/capability-manifest.ts";
import type {
  CapabilityManifest,
  CapabilityValidationResult,
  StringFieldFormat,
} from "../src/capability-manifest.ts";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const CORPUS_PATH = resolve(
  REPO_ROOT,
  "schema",
  "capabilities",
  "formats",
  "ip-conformance.json",
);

type Expectation = "accept" | "reject";

interface FormatExpectation {
  readonly expect: Expectation;
  readonly canonical?: string;
}

interface IPConformanceVector {
  readonly name: string;
  readonly value: string;
  readonly ipLiteral: FormatExpectation;
  readonly hostnameOrIp: FormatExpectation;
}

const validateIPLiteral = compileCapabilityValidator(singleValueManifest("ipLiteral"));
const validateHostnameOrIP = compileCapabilityValidator(singleValueManifest("hostnameOrIp"));

test("ipLiteral and hostnameOrIp conformance corpus matches the TS validator", () => {
  const vectors = readIPConformanceCorpus();

  assert.ok(vectors.length >= 40, "IP conformance corpus must have at least 40 vectors");

  for (let index = 0; index < vectors.length; index += 1) {
    const vector = vectors[index];

    if (vector === undefined) {
      assert.fail("expected conformance vector");
    }

    assertFormatDecision(
      vector,
      "ipLiteral",
      vector.ipLiteral,
      validateIPLiteral({ value: vector.value }),
    );
    assertFormatDecision(
      vector,
      "hostnameOrIp",
      vector.hostnameOrIp,
      validateHostnameOrIP({ value: vector.value }),
    );
  }
});

test("canonical IP output drives uniqueItems dedupe", () => {
  const validateIPArray = compileCapabilityValidator(arrayManifest("ipLiteral"));
  const validateHostnameOrIPArray = compileCapabilityValidator(arrayManifest("hostnameOrIp"));

  assert.deepEqual(
    rejectedPaths(validateIPArray({ values: ["2001:0db8::1", "2001:db8::1"] })),
    ["values/1"],
  );
  assert.deepEqual(
    rejectedPaths(validateHostnameOrIPArray({ values: ["::ffff:c000:201", "::ffff:192.0.2.1"] })),
    ["values/1"],
  );
});

test("hostnameOrIp composes with lowercase, maxLength, and noInlineSecrets", () => {
  const validateLowercase = compileCapabilityValidator({
    capability: "test.hostname-or-ip-lowercase",
    fields: Object.freeze({
      value: Object.freeze({
        format: "hostnameOrIp",
        lowercase: true,
        required: true,
        type: "string",
      }),
    }),
    crossFieldRules: Object.freeze([]),
  } satisfies CapabilityManifest);
  const lowered = validateLowercase({ value: "Example.COM" });

  if (!lowered.ok) {
    assert.fail(`expected hostname branch to validate: ${JSON.stringify(lowered.rejections)}`);
  }

  assert.equal(lowered.value.value, "example.com");

  const validateMaxLength = compileCapabilityValidator({
    capability: "test.ip-max-length",
    fields: Object.freeze({
      value: Object.freeze({
        format: "ipLiteral",
        maxLength: 8,
        required: true,
        type: "string",
      }),
    }),
    crossFieldRules: Object.freeze([]),
  } satisfies CapabilityManifest);

  assert.deepEqual(rejectedPaths(validateMaxLength({ value: "127.0.0.1" })), ["value"]);

  const validateNoInlineSecrets = compileCapabilityValidator({
    capability: "test.hostname-or-ip-no-inline-secrets",
    fields: Object.freeze({
      value: Object.freeze({
        format: "hostnameOrIp",
        noInlineSecrets: true,
        required: true,
        type: "string",
      }),
    }),
    crossFieldRules: Object.freeze([]),
  } satisfies CapabilityManifest);

  assert.deepEqual(
    rejectedPaths(validateNoInlineSecrets({ value: `pool.${"A".repeat(48)}.org` })),
    ["value"],
  );
});

function singleValueManifest(format: StringFieldFormat): CapabilityManifest {
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

function arrayManifest(format: StringFieldFormat): CapabilityManifest {
  return Object.freeze({
    capability: `test.${format}.array`,
    fields: Object.freeze({
      values: Object.freeze({
        items: Object.freeze({
          format,
          required: true,
          type: "string",
        }),
        required: true,
        type: "array",
        uniqueItems: true,
      }),
    }),
    crossFieldRules: Object.freeze([]),
  });
}

function assertFormatDecision(
  vector: IPConformanceVector,
  format: StringFieldFormat,
  expectation: FormatExpectation,
  result: CapabilityValidationResult,
): void {
  if (expectation.expect === "accept") {
    if (!result.ok) {
      assert.fail(`${vector.name} ${format}: expected accept, got ${formatRejections(result)}`);
    }

    assert.equal(
      result.value.value,
      expectation.canonical,
      `${vector.name} ${format}: canonical output mismatch`,
    );
    return;
  }

  if (result.ok) {
    assert.fail(`${vector.name} ${format}: expected reject, got ${JSON.stringify(result.value)}`);
  }
}

function readIPConformanceCorpus(): readonly IPConformanceVector[] {
  const raw = JSON.parse(readFileSync(CORPUS_PATH, "utf8")) as unknown;

  if (!Array.isArray(raw)) {
    assert.fail("IP conformance corpus must be an array");
  }

  const vectors: IPConformanceVector[] = [];

  for (let index = 0; index < raw.length; index += 1) {
    const item = raw[index];

    if (!isRecord(item)) {
      assert.fail(`IP conformance vector ${index} must be an object`);
    }

    assertAllowedKeys(item, ["hostnameOrIp", "ipLiteral", "name", "value"], `vector ${index}`);

    vectors.push({
      hostnameOrIp: readFormatExpectation(item, "hostnameOrIp", `vector ${index}.hostnameOrIp`),
      ipLiteral: readFormatExpectation(item, "ipLiteral", `vector ${index}.ipLiteral`),
      name: readRequiredString(item, "name", `vector ${index}.name`),
      value: readRequiredString(item, "value", `vector ${index}.value`),
    });
  }

  return Object.freeze(vectors);
}

function readFormatExpectation(
  record: Readonly<Record<string, unknown>>,
  key: string,
  path: string,
): FormatExpectation {
  const value = readRequiredProperty(record, key, path);

  if (!isRecord(value)) {
    assert.fail(`${path} must be an object`);
  }

  assertAllowedKeys(value, ["canonical", "expect"], path);

  const expect = readExpectation(value, "expect", `${path}.expect`);
  const canonical = readOptionalString(value, "canonical", `${path}.canonical`);

  if (expect === "accept") {
    if (canonical === undefined) {
      assert.fail(`${path}.canonical is required for accepted vectors`);
    }

    return {
      canonical,
      expect,
    };
  }

  if (canonical !== undefined) {
    assert.fail(`${path}.canonical is only supported for accepted vectors`);
  }

  return { expect };
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
      assert.fail(`${path}.${key} is not a supported conformance vector field`);
    }
  }
}

function rejectedPaths(result: CapabilityValidationResult): readonly string[] {
  if (result.ok) {
    assert.fail(`expected validation to fail: ${JSON.stringify(result.value)}`);
  }

  return result.rejections.map((rejection) => rejection.path).sort();
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
