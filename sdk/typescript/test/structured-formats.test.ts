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
  "structured-formats-conformance.json",
);

const STRUCTURED_FORMATS = Object.freeze([
  "posixUsername",
  "groupName",
  "systemdUnitName",
  "absolutePath",
] as const satisfies readonly StringFieldFormat[]);

type StructuredStringFormat = (typeof STRUCTURED_FORMATS)[number];
type Expectation = "accept" | "reject";

interface RepeatValue {
  readonly prefix: string;
  readonly unit: string;
  readonly count: number;
  readonly suffix: string;
}

interface StructuredFormatVector {
  readonly name: string;
  readonly format: StructuredStringFormat;
  readonly value: string;
  readonly expect: Expectation;
  readonly canonical: string | undefined;
  readonly noInlineSecrets: boolean;
  readonly maxLength: number | undefined;
}

test("structured string formats conformance corpus matches the TS validator", () => {
  const vectors = readStructuredFormatCorpus();
  const counts = new Map<StructuredStringFormat, number>();

  for (const format of STRUCTURED_FORMATS) {
    counts.set(format, 0);
  }

  for (let index = 0; index < vectors.length; index += 1) {
    const vector = vectors[index];

    if (vector === undefined) {
      assert.fail("expected structured format vector");
    }

    counts.set(vector.format, (counts.get(vector.format) ?? 0) + 1);
    assertFormatDecision(vector, validateValue(vector));
  }

  for (const format of STRUCTURED_FORMATS) {
    assert.ok((counts.get(format) ?? 0) >= 10, `${format} must have at least 10 vectors`);
  }
});

test("structured string formats load from manifest JSON", () => {
  for (const format of STRUCTURED_FORMATS) {
    const result = loadCapabilityManifest({
      capability: `test.${format}.load`,
      version: 1,
      fields: {
        value: {
          format,
          required: true,
          type: "string",
        },
      },
      crossFieldRules: [],
    });

    if (!result.ok) {
      assert.fail(`${format} load rejected: ${result.reason}`);
    }

    const field = result.manifest.fields.value;

    if (field === undefined || field.type !== "string") {
      assert.fail(`${format} load returned missing or non-string value field`);
    }

    assert.equal(field.format, format);
  }
});

test("structured string formats compose with maxLength and noInlineSecrets", () => {
  const maxLengthCases: readonly {
    readonly format: StructuredStringFormat;
    readonly value: string;
    readonly maxLength: number;
  }[] = Object.freeze([
    { format: "posixUsername", value: "alice", maxLength: 3 },
    { format: "groupName", value: "users", maxLength: 4 },
    { format: "systemdUnitName", value: "ssh.service", maxLength: 4 },
    { format: "absolutePath", value: "/var/lib", maxLength: 4 },
  ]);

  for (const item of maxLengthCases) {
    assert.deepEqual(
      rejectedPaths(validateRaw(item.format, item.value, { maxLength: item.maxLength })),
      ["value"],
      `${item.format} should reject over maxLength`,
    );
  }

  const inlineSecretPath = "/backup/-----BEGIN PRIVATE KEY-----";

  assert.equal(validateRaw("absolutePath", inlineSecretPath, {}).ok, true);
  assert.deepEqual(
    rejectedPaths(validateRaw("absolutePath", inlineSecretPath, { noInlineSecrets: true })),
    ["value"],
  );
});

function validateValue(vector: StructuredFormatVector): CapabilityValidationResult {
  const options: {
    maxLength?: number;
    noInlineSecrets?: boolean;
  } = {};

  if (vector.maxLength !== undefined) {
    options.maxLength = vector.maxLength;
  }
  if (vector.noInlineSecrets) {
    options.noInlineSecrets = true;
  }

  return validateRaw(vector.format, vector.value, options);
}

function validateRaw(
  format: StructuredStringFormat,
  value: string,
  options: {
    readonly maxLength?: number;
    readonly noInlineSecrets?: boolean;
  },
): CapabilityValidationResult {
  const validate = compileCapabilityValidator(singleValueManifest(format, options));

  return validate({ value });
}

function singleValueManifest(
  format: StructuredStringFormat,
  options: {
    readonly maxLength?: number;
    readonly noInlineSecrets?: boolean;
  } = {},
): CapabilityManifest {
  return Object.freeze({
    capability: `test.${format}`,
    fields: Object.freeze({
      value: Object.freeze({
        ...(options.maxLength === undefined ? {} : { maxLength: options.maxLength }),
        ...(options.noInlineSecrets === undefined
          ? {}
          : { noInlineSecrets: options.noInlineSecrets }),
        format,
        required: true,
        type: "string",
      }),
    }),
    crossFieldRules: Object.freeze([]),
  });
}

function assertFormatDecision(
  vector: StructuredFormatVector,
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

function readStructuredFormatCorpus(): readonly StructuredFormatVector[] {
  const raw = JSON.parse(readFileSync(CORPUS_PATH, "utf8")) as unknown;

  if (!Array.isArray(raw)) {
    assert.fail("structured format conformance corpus must be an array");
  }

  const vectors: StructuredFormatVector[] = [];

  for (let index = 0; index < raw.length; index += 1) {
    const item = raw[index];
    const path = `vector ${index}`;

    if (!isRecord(item)) {
      assert.fail(`${path} must be an object`);
    }

    assertAllowedKeys(
      item,
      ["canonical", "expect", "format", "maxLength", "name", "noInlineSecrets", "repeatValue", "value"],
      path,
    );

    const name = readRequiredString(item, "name", `${path}.name`);
    const format = readStructuredFormat(item, "format", `${path}.format`);
    const value = readVectorValue(item, path);
    const expect = readExpectation(item, "expect", `${path}.expect`);
    const canonical = readOptionalString(item, "canonical", `${path}.canonical`);
    const noInlineSecrets = readOptionalBoolean(item, "noInlineSecrets", `${path}.noInlineSecrets`) ?? false;
    const maxLength = readOptionalSafeInteger(item, "maxLength", `${path}.maxLength`);

    if (expect === "accept" && canonical === undefined) {
      assert.fail(`${path}.canonical is required for accepted vectors`);
    }
    if (expect === "reject" && canonical !== undefined) {
      assert.fail(`${path}.canonical is only supported for accepted vectors`);
    }

    vectors.push({
      canonical,
      expect,
      format,
      maxLength,
      name,
      noInlineSecrets,
      value,
    });
  }

  return Object.freeze(vectors);
}

function readVectorValue(record: Readonly<Record<string, unknown>>, path: string): string {
  const hasValue = Object.hasOwn(record, "value");
  const hasRepeatValue = Object.hasOwn(record, "repeatValue");

  if (hasValue === hasRepeatValue) {
    assert.fail(`${path} must set exactly one of value or repeatValue`);
  }

  if (hasValue) {
    return readRequiredString(record, "value", `${path}.value`);
  }

  const repeat = readRepeatValue(record, "repeatValue", `${path}.repeatValue`);

  return `${repeat.prefix}${repeat.unit.repeat(repeat.count)}${repeat.suffix}`;
}

function readRepeatValue(
  record: Readonly<Record<string, unknown>>,
  key: string,
  path: string,
): RepeatValue {
  const value = readRequiredProperty(record, key, path);

  if (!isRecord(value)) {
    assert.fail(`${path} must be an object`);
  }

  assertAllowedKeys(value, ["count", "prefix", "suffix", "unit"], path);

  const prefix = readOptionalString(value, "prefix", `${path}.prefix`) ?? "";
  const unit = readRequiredString(value, "unit", `${path}.unit`);
  const count = readRequiredSafeInteger(value, "count", `${path}.count`);
  const suffix = readOptionalString(value, "suffix", `${path}.suffix`) ?? "";

  if (unit.length === 0) {
    assert.fail(`${path}.unit must be non-empty`);
  }
  if (count < 0 || count > 5000) {
    assert.fail(`${path}.count must be from 0 through 5000`);
  }

  return {
    count,
    prefix,
    suffix,
    unit,
  };
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

function readRequiredSafeInteger(
  record: Readonly<Record<string, unknown>>,
  key: string,
  path: string,
): number {
  const value = readRequiredProperty(record, key, path);

  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    assert.fail(`${path} must be a safe integer`);
  }

  return value;
}

function readOptionalSafeInteger(
  record: Readonly<Record<string, unknown>>,
  key: string,
  path: string,
): number | undefined {
  if (!Object.hasOwn(record, key)) {
    return undefined;
  }

  const value = record[key];

  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    assert.fail(`${path} must be a non-negative safe integer when present`);
  }

  return value;
}

function readStructuredFormat(
  record: Readonly<Record<string, unknown>>,
  key: string,
  path: string,
): StructuredStringFormat {
  const value = readRequiredString(record, key, path);

  for (const format of STRUCTURED_FORMATS) {
    if (value === format) {
      return format;
    }
  }

  assert.fail(`${path} must be a structured string format`);
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
