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
const CORPUS_PATH = resolve(
  REPO_ROOT,
  "schema",
  "capabilities",
  "formats",
  "datetime-conformance.json",
);
const FORMAT = "rfc3339Instant" satisfies StringFieldFormat;
const validateRFC3339Instant = compileCapabilityValidator(singleValueManifest(FORMAT));

type Expectation = "accept" | "reject";

interface DatetimeFormatVector {
  readonly name: string;
  readonly request: unknown;
  readonly expect: Expectation;
  readonly canonical?: string;
}

test("rfc3339Instant conformance corpus matches the TS validator", () => {
  const vectors = readDatetimeFormatCorpus();

  assert.ok(vectors.length >= 25, "rfc3339Instant conformance corpus must have at least 25 vectors");

  for (let index = 0; index < vectors.length; index += 1) {
    const vector = vectors[index];

    if (vector === undefined) {
      assert.fail("expected datetime conformance vector");
    }

    assertFormatDecision(vector, validateRFC3339Instant(vector.request));
  }
});

test("rfc3339Instant loads from manifest JSON", () => {
  const result = loadCapabilityManifest({
    capability: "test.rfc3339-instant",
    version: 1,
    fields: {
      value: {
        format: FORMAT,
        required: true,
        type: "string",
      },
    },
    crossFieldRules: [],
  });

  if (!result.ok) {
    assert.fail(`rfc3339Instant manifest failed to load: ${result.reason}`);
  }

  const field = result.manifest.fields.value;

  if (field === undefined || field.type !== "string") {
    assert.fail("rfc3339Instant manifest value field was not a string field");
  }

  assert.equal(field.format, FORMAT);
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

function assertFormatDecision(
  vector: DatetimeFormatVector,
  result: CapabilityValidationResult,
): void {
  if (vector.expect === "accept") {
    if (!result.ok) {
      assert.fail(`${vector.name}: expected accept, got ${formatRejections(result)}`);
    }

    assert.equal(result.value.value, vector.canonical, `${vector.name}: canonical output mismatch`);
    return;
  }

  if (result.ok) {
    assert.fail(`${vector.name}: expected reject, got ${JSON.stringify(result.value)}`);
  }
}

function readDatetimeFormatCorpus(): readonly DatetimeFormatVector[] {
  const raw = JSON.parse(readFileSync(CORPUS_PATH, "utf8")) as unknown;

  if (!Array.isArray(raw)) {
    assert.fail("datetime format conformance corpus must be an array");
  }

  const vectors: DatetimeFormatVector[] = [];

  for (let index = 0; index < raw.length; index += 1) {
    const item = raw[index];

    if (!isRecord(item)) {
      assert.fail(`datetime conformance vector ${index} must be an object`);
    }

    assertAllowedKeys(item, ["canonical", "expect", "name", "request"], `vector ${index}`);

    const expect = readExpectation(item, "expect", `vector ${index}.expect`);
    const canonical = readOptionalString(item, "canonical", `vector ${index}.canonical`);

    if (expect === "accept") {
      if (canonical === undefined) {
        assert.fail(`vector ${index}.canonical is required for accepted vectors`);
      }

      vectors.push({
        canonical,
        expect,
        name: readRequiredString(item, "name", `vector ${index}.name`),
        request: readRequiredProperty(item, "request", `vector ${index}.request`),
      });
      continue;
    }

    if (canonical !== undefined) {
      assert.fail(`vector ${index}.canonical is only supported for accepted vectors`);
    }

    vectors.push({
      expect,
      name: readRequiredString(item, "name", `vector ${index}.name`),
      request: readRequiredProperty(item, "request", `vector ${index}.request`),
    });
  }

  return Object.freeze(vectors);
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
      assert.fail(`${path}.${key} is not a supported datetime conformance field`);
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
