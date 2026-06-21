import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
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
const MANIFEST_PATH = resolve(REPO_ROOT, "schema", "capabilities", "identity.json");
const CORPUS_PATH = resolve(
  REPO_ROOT,
  "schema",
  "capabilities",
  "conformance",
  "identity.json",
);
const FORMAT_CORPUS_PATH = resolve(
  REPO_ROOT,
  "schema",
  "capabilities",
  "formats",
  "identity-formats-conformance.json",
);
const IDENTITY_MANIFEST = readIdentityManifest();
const validateIdentity = compileCapabilityValidator(IDENTITY_MANIFEST);
const IDENTITY_STRING_FORMATS = Object.freeze([
  "didPlcOrWeb",
  "atprotoHandle",
  "keyReference",
] satisfies readonly IdentityStringFieldFormat[]);

type Expectation = "accept" | "reject";
type IdentityStringFieldFormat = Extract<
  StringFieldFormat,
  "didPlcOrWeb" | "atprotoHandle" | "keyReference"
>;
type IdentityFormatCorpusKey = IdentityStringFieldFormat | "identitySecretMaterial";

interface ConformanceVector {
  readonly name: string;
  readonly request: unknown;
  readonly expect: Expectation;
  readonly rejectCode?: string;
}

interface FormatVector {
  readonly name: string;
  readonly value: string;
  readonly expect: Expectation;
}

type IdentityFormatCorpus = Readonly<Record<IdentityFormatCorpusKey, readonly FormatVector[]>>;

test("identity conformance corpus matches the TS validator", () => {
  const vectors = readConformanceCorpus();

  assert.ok(vectors.length >= 28, "identity conformance corpus must have at least 28 vectors");

  for (let index = 0; index < vectors.length; index += 1) {
    const vector = vectors[index];

    if (vector === undefined) {
      assert.fail("expected conformance vector");
    }

    const result = validateIdentity(vector.request);

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

test("identity formats match the TS validator", () => {
  const corpus = readIdentityFormatCorpus();

  for (let index = 0; index < IDENTITY_STRING_FORMATS.length; index += 1) {
    const format = IDENTITY_STRING_FORMATS[index];

    if (format === undefined) {
      assert.fail("expected identity string format");
    }

    const validate = compileCapabilityValidator(singleValueFormatManifest(format));
    const vectors = corpus[format];

    assert.ok(vectors.length >= 10, `${format} corpus must have at least 10 vectors`);

    for (let vectorIndex = 0; vectorIndex < vectors.length; vectorIndex += 1) {
      const vector = vectors[vectorIndex];

      if (vector === undefined) {
        assert.fail(`expected ${format} vector`);
      }

      assertFormatDecision(format, vector, validate({ value: vector.value }));
    }
  }

  const materialVectors = corpus.identitySecretMaterial;
  const validateMaterial = compileCapabilityValidator(identityMaterialManifest());

  assert.ok(materialVectors.length >= 10, "identitySecretMaterial corpus must have at least 10 vectors");

  for (let index = 0; index < materialVectors.length; index += 1) {
    const vector = materialVectors[index];

    if (vector === undefined) {
      assert.fail("expected identitySecretMaterial vector");
    }

    assertFormatDecision("identitySecretMaterial", vector, validateMaterial({ value: vector.value }));
  }
});

test("identity formats load from manifest JSON", () => {
  for (let index = 0; index < IDENTITY_STRING_FORMATS.length; index += 1) {
    const format = IDENTITY_STRING_FORMATS[index];

    if (format === undefined) {
      assert.fail("expected identity string format");
    }

    const loaded = loadCapabilityManifest({
      capability: `test.${format}`,
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

    if (!loaded.ok) {
      assert.fail(`${format} manifest failed to load: ${loaded.reason}`);
    }
  }

  const loaded = loadCapabilityManifest({
    capability: "test.identity-material",
    version: 1,
    fields: {
      value: {
        noInlineIdentityMaterial: true,
        required: true,
        type: "string",
      },
    },
    crossFieldRules: [],
  });

  if (!loaded.ok) {
    assert.fail(`identity material manifest failed to load: ${loaded.reason}`);
  }
});

test("keyReference scheme lowercasing matches Go strings.ToLower over BMP", () => {
  const goAccepted = readGoAcceptedOneRuneSchemes();
  const validate = compileCapabilityValidator(singleValueFormatManifest("keyReference"));

  for (let codePoint = 0; codePoint <= 0xffff; codePoint += 1) {
    if (codePoint >= 0xd800 && codePoint <= 0xdfff) {
      continue;
    }

    const value = `${String.fromCodePoint(codePoint)}://ref`;
    const result = validate({ value });
    const expected = goAccepted.has(codePoint);

    assert.equal(
      result.ok,
      expected,
      `U+${codePoint.toString(16).toUpperCase().padStart(4, "0")} scheme decision differed`,
    );
  }
});

function readIdentityManifest(): CapabilityManifest {
  const raw = JSON.parse(readFileSync(MANIFEST_PATH, "utf8")) as unknown;
  const loaded = loadCapabilityManifest(raw);

  if (!loaded.ok) {
    assert.fail(`identity manifest failed to load: ${loaded.reason}`);
  }

  return loaded.manifest;
}

function readConformanceCorpus(): readonly ConformanceVector[] {
  const raw = JSON.parse(readFileSync(CORPUS_PATH, "utf8")) as unknown;

  if (!Array.isArray(raw)) {
    assert.fail("identity conformance corpus must be an array");
  }

  const vectors: ConformanceVector[] = [];

  for (let index = 0; index < raw.length; index += 1) {
    const item = raw[index];

    if (!isRecord(item)) {
      assert.fail(`identity conformance vector ${index} must be an object`);
    }

    assertAllowedKeys(item, ["expect", "name", "rejectCode", "request"], `vector ${index}`);

    const rejectCode = readOptionalString(item, "rejectCode", `vector ${index}.rejectCode`);

    vectors.push({
      expect: readExpectation(item, "expect", `vector ${index}.expect`),
      name: readRequiredString(item, "name", `vector ${index}.name`),
      request: readRequiredProperty(item, "request", `vector ${index}.request`),
      ...(rejectCode === undefined ? {} : { rejectCode }),
    });
  }

  return Object.freeze(vectors);
}

function readIdentityFormatCorpus(): IdentityFormatCorpus {
  const raw = JSON.parse(readFileSync(FORMAT_CORPUS_PATH, "utf8")) as unknown;

  if (!isRecord(raw)) {
    assert.fail("identity format conformance corpus must be an object");
  }

  assertAllowedKeys(
    raw,
    ["atprotoHandle", "didPlcOrWeb", "identitySecretMaterial", "keyReference"],
    "format corpus",
  );

  return Object.freeze({
    atprotoHandle: readFormatVectors(raw, "atprotoHandle"),
    didPlcOrWeb: readFormatVectors(raw, "didPlcOrWeb"),
    identitySecretMaterial: readFormatVectors(raw, "identitySecretMaterial"),
    keyReference: readFormatVectors(raw, "keyReference"),
  });
}

function readFormatVectors(
  raw: Readonly<Record<string, unknown>>,
  key: IdentityFormatCorpusKey,
): readonly FormatVector[] {
  const vectorsValue = readRequiredProperty(raw, key, `format corpus.${key}`);

  if (!Array.isArray(vectorsValue)) {
    assert.fail(`format corpus.${key} must be an array`);
  }

  const vectors: FormatVector[] = [];

  for (let index = 0; index < vectorsValue.length; index += 1) {
    const item = vectorsValue[index];
    const path = `format corpus.${key}.${index}`;

    if (!isRecord(item)) {
      assert.fail(`${path} must be an object`);
    }

    assertAllowedKeys(item, ["expect", "name", "value"], path);
    vectors.push({
      expect: readExpectation(item, "expect", `${path}.expect`),
      name: readRequiredString(item, "name", `${path}.name`),
      value: readRequiredString(item, "value", `${path}.value`),
    });
  }

  return Object.freeze(vectors);
}

function singleValueFormatManifest(format: IdentityStringFieldFormat): CapabilityManifest {
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

function identityMaterialManifest(): CapabilityManifest {
  return Object.freeze({
    capability: "test.identity-material",
    fields: Object.freeze({
      value: Object.freeze({
        noInlineIdentityMaterial: true,
        required: true,
        type: "string",
      }),
    }),
    crossFieldRules: Object.freeze([]),
  });
}

function assertFormatDecision(
  format: IdentityFormatCorpusKey,
  vector: FormatVector,
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

function readGoAcceptedOneRuneSchemes(): ReadonlySet<number> {
  const directory = mkdtempSync(join(tmpdir(), "vita-identity-go-lower-"));
  const sourcePath = join(directory, "main.go");

  writeFileSync(
    sourcePath,
    `package main

import (
	"encoding/json"
	"os"
	"regexp"
	"strings"
	"unicode/utf8"
)

func main() {
	pattern := regexp.MustCompile("^[a-z][a-z0-9+.-]*$")
	values := []int{}
	for codePoint := 0; codePoint <= 0xffff; codePoint++ {
		r := rune(codePoint)
		if !utf8.ValidRune(r) {
			continue
		}
		if pattern.MatchString(strings.ToLower(string(r))) {
			values = append(values, codePoint)
		}
	}
	if err := json.NewEncoder(os.Stdout).Encode(values); err != nil {
		panic(err)
	}
}
`,
    "utf8",
  );

  try {
    const output = execFileSync("go", ["run", sourcePath], {
      encoding: "utf8",
      env: {
        ...process.env,
        GOCACHE: join(directory, "gocache"),
      },
    });
    const parsed = JSON.parse(output) as unknown;

    if (!Array.isArray(parsed)) {
      assert.fail("Go scheme-lowercase corpus must be an array");
    }

    const values = new Set<number>();

    for (let index = 0; index < parsed.length; index += 1) {
      const item = parsed[index];

      if (!Number.isInteger(item) || item < 0 || item > 0xffff) {
        assert.fail(`Go scheme-lowercase item ${index} must be a BMP code point`);
      }

      values.add(item);
    }

    return values;
  } finally {
    rmSync(directory, { force: true, recursive: true });
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
      assert.fail(`${path}.${key} is not a supported identity conformance field`);
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
