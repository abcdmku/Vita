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
] satisfies readonly StructuredStringFieldFormat[]);

type StructuredStringFieldFormat = Extract<
  StringFieldFormat,
  "posixUsername" | "groupName" | "systemdUnitName" | "absolutePath"
>;
type Expectation = "accept" | "reject";

interface StructuredFormatVector {
  readonly name: string;
  readonly value: string;
  readonly expect: Expectation;
}

type StructuredFormatCorpus = Readonly<Record<StructuredStringFieldFormat, readonly StructuredFormatVector[]>>;

test("structured format conformance corpus matches the TS validator", () => {
  const corpus = readStructuredFormatCorpus();

  for (let index = 0; index < STRUCTURED_FORMATS.length; index += 1) {
    const format = STRUCTURED_FORMATS[index];

    if (format === undefined) {
      assert.fail("expected structured string format");
    }

    const vectors = corpus[format];
    const validate = compileCapabilityValidator(singleValueManifest(format));

    assert.ok(vectors.length >= 10, `${format} conformance corpus must have at least 10 vectors`);

    for (let vectorIndex = 0; vectorIndex < vectors.length; vectorIndex += 1) {
      const vector = vectors[vectorIndex];

      if (vector === undefined) {
        assert.fail(`expected ${format} conformance vector`);
      }

      assertFormatDecision(format, vector, validate({ value: vector.value }));
    }
  }
});

test("structured formats load from manifest JSON", () => {
  for (let index = 0; index < STRUCTURED_FORMATS.length; index += 1) {
    const format = STRUCTURED_FORMATS[index];

    if (format === undefined) {
      assert.fail("expected structured string format");
    }

    const result = loadCapabilityManifest({
      capability: `test.${format}.json`,
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
      assert.fail(`${format} manifest failed to load: ${result.reason}`);
    }

    const field = result.manifest.fields.value;

    if (field === undefined || field.type !== "string") {
      assert.fail(`${format} manifest value field was not a string field`);
    }

    assert.equal(field.format, format);
  }
});

test("structured formats compose with maxLength and noInlineSecrets", () => {
  const validateMaxLength = compileCapabilityValidator({
    capability: "test.absolute-path-max-length",
    fields: Object.freeze({
      value: Object.freeze({
        format: "absolutePath",
        maxLength: 5,
        required: true,
        type: "string",
      }),
    }),
    crossFieldRules: Object.freeze([]),
  } satisfies CapabilityManifest);

  assert.deepEqual(rejectedPaths(validateMaxLength({ value: "/data/ok" })), ["value"]);

  const validateNoInlineSecrets = compileCapabilityValidator({
    capability: "test.absolute-path-no-inline-secrets",
    fields: Object.freeze({
      value: Object.freeze({
        format: "absolutePath",
        noInlineSecrets: true,
        required: true,
        type: "string",
      }),
    }),
    crossFieldRules: Object.freeze([]),
  } satisfies CapabilityManifest);

  assert.deepEqual(
    rejectedPaths(validateNoInlineSecrets({ value: `/data/${"A".repeat(48)}` })),
    ["value"],
  );

  const validatePOSIXNoInlineSecrets = compileCapabilityValidator({
    capability: "test.posix-no-inline-secrets",
    fields: Object.freeze({
      value: Object.freeze({
        format: "posixUsername",
        noInlineSecrets: true,
        required: true,
        type: "string",
      }),
    }),
    crossFieldRules: Object.freeze([]),
  } satisfies CapabilityManifest);

  assert.deepEqual(rejectedPaths(validatePOSIXNoInlineSecrets({ value: "x-----begin" })), ["value"]);
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
  format: StructuredStringFieldFormat,
  vector: StructuredFormatVector,
  result: CapabilityValidationResult,
): void {
  if (vector.expect === "accept") {
    if (!result.ok) {
      assert.fail(`${format} ${vector.name}: expected accept, got ${formatRejections(result)}`);
    }

    assert.equal(result.value.value, vector.value, `${format} ${vector.name}: value changed`);
    return;
  }

  if (result.ok) {
    assert.fail(`${format} ${vector.name}: expected reject, got ${JSON.stringify(result.value)}`);
  }
}

function readStructuredFormatCorpus(): StructuredFormatCorpus {
  const raw = JSON.parse(readFileSync(CORPUS_PATH, "utf8")) as unknown;

  if (!isRecord(raw)) {
    assert.fail("structured format conformance corpus must be an object");
  }

  assertAllowedKeys(raw, STRUCTURED_FORMATS, "corpus");

  const corpus: Partial<Record<StructuredStringFieldFormat, readonly StructuredFormatVector[]>> = {};

  for (let index = 0; index < STRUCTURED_FORMATS.length; index += 1) {
    const format = STRUCTURED_FORMATS[index];

    if (format === undefined) {
      assert.fail("expected structured string format");
    }

    const vectorsValue = readRequiredProperty(raw, format, `corpus.${format}`);

    if (!Array.isArray(vectorsValue)) {
      assert.fail(`corpus.${format} must be an array`);
    }

    corpus[format] = Object.freeze(readStructuredFormatVectors(vectorsValue, `corpus.${format}`));
  }

  return Object.freeze({
    absolutePath: readRequiredVectorArray(corpus, "absolutePath"),
    groupName: readRequiredVectorArray(corpus, "groupName"),
    posixUsername: readRequiredVectorArray(corpus, "posixUsername"),
    systemdUnitName: readRequiredVectorArray(corpus, "systemdUnitName"),
  });
}

function readStructuredFormatVectors(
  raw: readonly unknown[],
  path: string,
): readonly StructuredFormatVector[] {
  const vectors: StructuredFormatVector[] = [];

  for (let index = 0; index < raw.length; index += 1) {
    const item = raw[index];
    const itemPath = `${path}.${index}`;

    if (!isRecord(item)) {
      assert.fail(`${itemPath} must be an object`);
    }

    assertAllowedKeys(item, ["expect", "name", "value"], itemPath);

    vectors.push({
      expect: readExpectation(item, "expect", `${itemPath}.expect`),
      name: readRequiredString(item, "name", `${itemPath}.name`),
      value: readRequiredString(item, "value", `${itemPath}.value`),
    });
  }

  return vectors;
}

function readRequiredVectorArray(
  corpus: Readonly<Partial<Record<StructuredStringFieldFormat, readonly StructuredFormatVector[]>>>,
  key: StructuredStringFieldFormat,
): readonly StructuredFormatVector[] {
  const value = corpus[key];

  if (value === undefined) {
    assert.fail(`corpus.${key} is required`);
  }

  return value;
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
      assert.fail(`${path}.${key} is not a supported structured conformance field`);
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
