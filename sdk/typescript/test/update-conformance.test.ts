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
} from "../src/capability-manifest.ts";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const MANIFEST_PATH = resolve(REPO_ROOT, "schema", "capabilities", "update.json");
const CORPUS_PATH = resolve(
  REPO_ROOT,
  "schema",
  "capabilities",
  "conformance",
  "update.json",
);
const UPDATE_MANIFEST = readUpdateManifest();
const validateUpdate = compileCapabilityValidator(UPDATE_MANIFEST);

type Expectation = "accept" | "reject";

interface ConformanceVector {
  readonly name: string;
  readonly request: unknown;
  readonly expect: Expectation;
  readonly rejectCode?: string;
}

test("update conformance corpus matches the TS validator", () => {
  const vectors = readConformanceCorpus();

  assert.ok(vectors.length >= 22, "update conformance corpus must have at least 22 vectors");

  for (let index = 0; index < vectors.length; index += 1) {
    const vector = vectors[index];

    if (vector === undefined) {
      assert.fail("expected conformance vector");
    }

    const result = validateUpdate(vector.request);

    if (vector.expect === "accept") {
      if (!result.ok) {
        assert.fail(`${vector.name}: expected accept, got ${formatRejections(result)}`);
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

function readUpdateManifest(): CapabilityManifest {
  const raw = JSON.parse(readFileSync(MANIFEST_PATH, "utf8")) as unknown;
  const loaded = loadCapabilityManifest(raw);

  if (!loaded.ok) {
    assert.fail(`update manifest failed to load: ${loaded.reason}`);
  }

  return loaded.manifest;
}

function readConformanceCorpus(): readonly ConformanceVector[] {
  const raw = JSON.parse(readFileSync(CORPUS_PATH, "utf8")) as unknown;

  if (!Array.isArray(raw)) {
    assert.fail("update conformance corpus must be an array");
  }

  const vectors: ConformanceVector[] = [];

  for (let index = 0; index < raw.length; index += 1) {
    const item = raw[index];

    if (!isRecord(item)) {
      assert.fail(`update conformance vector ${index} must be an object`);
    }

    assertAllowedKeys(item, ["expect", "name", "rejectCode", "request"], `vector ${index}`);

    const name = readRequiredString(item, "name", `vector ${index}.name`);
    const request = readRequiredProperty(item, "request", `vector ${index}.request`);
    const expect = readExpectation(item, "expect", `vector ${index}.expect`);
    const rejectCode = readOptionalString(item, "rejectCode", `vector ${index}.rejectCode`);

    if (rejectCode === undefined) {
      vectors.push({
        expect,
        name,
        request,
      });
    } else {
      vectors.push({
        expect,
        name,
        rejectCode,
        request,
      });
    }
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
      assert.fail(`${path}.${key} is not a supported conformance vector field`);
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
