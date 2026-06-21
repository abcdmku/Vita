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
const MANIFEST_PATH = resolve(REPO_ROOT, "schema", "capabilities", "backup.json");
const CORPUS_PATH = resolve(REPO_ROOT, "schema", "capabilities", "conformance", "backup.json");

const BACKUP_MANIFEST = readBackupManifest();
const validateBackup = compileCapabilityValidator(BACKUP_MANIFEST);

type Expectation = "accept" | "reject";

interface ConformanceVector {
  readonly name: string;
  readonly request: unknown;
  readonly expect: Expectation;
  readonly rejectCode?: string;
}

// The Go conformance test proves the corpus matches the REAL agent entrypoint
// (DecodeJSONRequest[backup.ApplyRequest] + Validate). This test proves the TypeScript manifest
// validator makes the byte-identical accept/reject decision on the same corpus, so TS ≡ Go ≡ agent.
test("backup conformance corpus matches the TS validator", () => {
  const vectors = readConformanceCorpus();

  assert.ok(vectors.length >= 28, "backup conformance corpus must have at least 28 vectors");

  for (let index = 0; index < vectors.length; index += 1) {
    const vector = vectors[index];

    if (vector === undefined) {
      assert.fail("expected conformance vector");
    }

    const result = validateBackup(vector.request);

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

function readBackupManifest(): CapabilityManifest {
  const raw = JSON.parse(readFileSync(MANIFEST_PATH, "utf8")) as unknown;
  const loaded = loadCapabilityManifest(raw);

  if (!loaded.ok) {
    assert.fail(`backup manifest failed to load: ${loaded.reason}`);
  }

  assert.equal(loaded.manifest.capability, "backup.policy");
  return loaded.manifest;
}

function readConformanceCorpus(): readonly ConformanceVector[] {
  const raw = JSON.parse(readFileSync(CORPUS_PATH, "utf8")) as unknown;

  if (!Array.isArray(raw)) {
    assert.fail("backup conformance corpus must be an array");
  }

  const vectors: ConformanceVector[] = [];

  for (let index = 0; index < raw.length; index += 1) {
    const item = raw[index];

    if (!isRecord(item)) {
      assert.fail(`backup conformance vector ${index} must be an object`);
    }

    assertAllowedKeys(item, ["expect", "name", "rejectCode", "request"], `vector ${index}`);

    const name = readRequiredString(item, "name", `vector ${index}.name`);
    const request = readRequiredProperty(item, "request", `vector ${index}.request`);
    const expect = readExpectation(item, "expect", `vector ${index}.expect`);
    const rejectCode = readOptionalString(item, "rejectCode", `vector ${index}.rejectCode`);

    vectors.push({
      expect,
      name,
      ...(rejectCode === undefined ? {} : { rejectCode }),
      request,
    });
  }

  return Object.freeze(vectors);
}

function formatRejections(result: Extract<CapabilityValidationResult, { readonly ok: false }>): string {
  return result.rejections.map((rejection) => `${rejection.path}: ${rejection.message}`).join("; ");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertAllowedKeys(item: Record<string, unknown>, allowed: readonly string[], label: string): void {
  const keys = Object.keys(item);

  for (let index = 0; index < keys.length; index += 1) {
    const key = keys[index];

    if (key !== undefined && !allowed.includes(key)) {
      assert.fail(`${label} has unexpected key ${key}`);
    }
  }
}

function readRequiredProperty(item: Record<string, unknown>, key: string, label: string): unknown {
  if (!Object.hasOwn(item, key)) {
    assert.fail(`${label} is required`);
  }

  return item[key];
}

function readRequiredString(item: Record<string, unknown>, key: string, label: string): string {
  const value = readRequiredProperty(item, key, label);

  if (typeof value !== "string" || value.length === 0) {
    assert.fail(`${label} must be a non-empty string`);
  }

  return value;
}

function readOptionalString(item: Record<string, unknown>, key: string, label: string): string | undefined {
  if (!Object.hasOwn(item, key)) {
    return undefined;
  }

  const value = item[key];

  if (typeof value !== "string") {
    assert.fail(`${label} must be a string`);
  }

  return value;
}

function readExpectation(item: Record<string, unknown>, key: string, label: string): Expectation {
  const value = readRequiredString(item, key, label);

  if (value !== "accept" && value !== "reject") {
    assert.fail(`${label} must be accept or reject`);
  }

  return value;
}
