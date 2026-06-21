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
  StringFieldSchema,
} from "../src/capability-manifest.ts";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const CORPUS_PATH = resolve(
  REPO_ROOT,
  "schema",
  "capabilities",
  "formats",
  "string-substrate-conformance.json",
);

type Expectation = "accept" | "reject";

interface StringSubstrateVector {
  readonly name: string;
  readonly value: string;
  readonly expect: Expectation;
  readonly noInlineMaterial?: boolean;
  readonly noInlineSecrets?: boolean;
  readonly noControlChars?: boolean;
  readonly trimmed?: boolean;
  readonly maxBytes?: number;
  readonly minLength?: number;
  readonly nonEmpty?: boolean;
}

test("string substrate conformance corpus matches the TS validator", () => {
  const vectors = readStringSubstrateCorpus();

  assert.equal(vectors.length >= 30, true, "string substrate corpus must have at least 30 vectors");

  for (let index = 0; index < vectors.length; index += 1) {
    const vector = vectors[index];

    if (vector === undefined) {
      assert.fail(`vector ${index} is missing`);
    }

    const validate = compileCapabilityValidator(stringSubstrateManifest(vector));
    const result = validate({ value: vector.value });

    if (vector.expect === "accept") {
      if (!result.ok) {
        assert.fail(`${vector.name} rejected: ${JSON.stringify(result.rejections)}`);
      }

      assert.deepEqual(result.value, { value: vector.value }, vector.name);
    } else {
      assert.deepEqual(rejectedPaths(result), ["value"], vector.name);
    }
  }
});

test("string substrate options load from manifest JSON", () => {
  const loaded = loadCapabilityManifest({
    capability: "test.string-substrate",
    version: 1,
    fields: {
      value: {
        maxBytes: 16,
        minLength: 1,
        noControlChars: true,
        noInlineMaterial: true,
        nonEmpty: true,
        required: true,
        trimmed: true,
        type: "string",
      },
      legacy: {
        noInlineSecrets: true,
        required: true,
        type: "string",
      },
    },
    crossFieldRules: [],
  });

  if (!loaded.ok) {
    assert.fail(`expected string substrate manifest to load: ${loaded.reason}`);
  }

  const value = loaded.manifest.fields.value;
  assert.equal(value?.type, "string");
  assert.equal((value as StringFieldSchema | undefined)?.noInlineMaterial, true);
  assert.equal((value as StringFieldSchema | undefined)?.noControlChars, true);
  assert.equal((value as StringFieldSchema | undefined)?.trimmed, true);
  assert.equal((value as StringFieldSchema | undefined)?.maxBytes, 16);
  assert.equal((value as StringFieldSchema | undefined)?.minLength, 1);
  assert.equal((value as StringFieldSchema | undefined)?.nonEmpty, true);

  const validate = compileCapabilityValidator(loaded.manifest);
  assert.deepEqual(rejectedPaths(validate({ value: "service-ok", legacy: "api key=x" })), ["legacy"]);
});

function stringSubstrateManifest(vector: StringSubstrateVector): CapabilityManifest {
  const field: {
    type: "string";
    required: boolean;
    maxBytes?: number;
    minLength?: number;
    noControlChars?: boolean;
    noInlineMaterial?: boolean;
    noInlineSecrets?: boolean;
    nonEmpty?: boolean;
    trimmed?: boolean;
  } = {
    required: true,
    type: "string",
  };

  if (vector.maxBytes !== undefined) {
    field.maxBytes = vector.maxBytes;
  }
  if (vector.minLength !== undefined) {
    field.minLength = vector.minLength;
  }
  if (vector.noControlChars !== undefined) {
    field.noControlChars = vector.noControlChars;
  }
  if (vector.noInlineMaterial !== undefined) {
    field.noInlineMaterial = vector.noInlineMaterial;
  }
  if (vector.noInlineSecrets !== undefined) {
    field.noInlineSecrets = vector.noInlineSecrets;
  }
  if (vector.nonEmpty !== undefined) {
    field.nonEmpty = vector.nonEmpty;
  }
  if (vector.trimmed !== undefined) {
    field.trimmed = vector.trimmed;
  }

  return {
    capability: "test.string-substrate",
    fields: {
      value: Object.freeze(field) satisfies StringFieldSchema,
    },
    crossFieldRules: [],
  };
}

function readStringSubstrateCorpus(): readonly StringSubstrateVector[] {
  const raw = JSON.parse(readFileSync(CORPUS_PATH, "utf8")) as unknown;

  if (!Array.isArray(raw)) {
    assert.fail("string substrate corpus must be an array");
  }

  const vectors: StringSubstrateVector[] = [];

  for (let index = 0; index < raw.length; index += 1) {
    const item = raw[index];
    const path = `vector ${index}`;

    if (!isRecord(item)) {
      assert.fail(`${path} must be an object`);
    }

    assertAllowedKeys(
      item,
      [
        "expect",
        "maxBytes",
        "minLength",
        "name",
        "noControlChars",
        "noInlineMaterial",
        "noInlineSecrets",
        "nonEmpty",
        "trimmed",
        "value",
      ],
      path,
    );

    const vector: {
      name: string;
      value: string;
      expect: Expectation;
      maxBytes?: number;
      minLength?: number;
      noControlChars?: boolean;
      noInlineMaterial?: boolean;
      noInlineSecrets?: boolean;
      nonEmpty?: boolean;
      trimmed?: boolean;
    } = {
      expect: readExpectation(item, "expect", `${path}.expect`),
      name: readRequiredString(item, "name", `${path}.name`),
      value: readRequiredString(item, "value", `${path}.value`),
    };
    const maxBytes = readOptionalSafeInteger(item, "maxBytes", `${path}.maxBytes`);
    const minLength = readOptionalSafeInteger(item, "minLength", `${path}.minLength`);
    const noControlChars = readOptionalBoolean(item, "noControlChars", `${path}.noControlChars`);
    const noInlineMaterial = readOptionalBoolean(item, "noInlineMaterial", `${path}.noInlineMaterial`);
    const noInlineSecrets = readOptionalBoolean(item, "noInlineSecrets", `${path}.noInlineSecrets`);
    const nonEmpty = readOptionalBoolean(item, "nonEmpty", `${path}.nonEmpty`);
    const trimmed = readOptionalBoolean(item, "trimmed", `${path}.trimmed`);

    if (maxBytes !== undefined) {
      vector.maxBytes = maxBytes;
    }
    if (minLength !== undefined) {
      vector.minLength = minLength;
    }
    if (noControlChars !== undefined) {
      vector.noControlChars = noControlChars;
    }
    if (noInlineMaterial !== undefined) {
      vector.noInlineMaterial = noInlineMaterial;
    }
    if (noInlineSecrets !== undefined) {
      vector.noInlineSecrets = noInlineSecrets;
    }
    if (nonEmpty !== undefined) {
      vector.nonEmpty = nonEmpty;
    }
    if (trimmed !== undefined) {
      vector.trimmed = trimmed;
    }

    vectors.push(Object.freeze(vector) satisfies StringSubstrateVector);
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

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
