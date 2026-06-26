import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";

import { validateSbomScan } from "../src/sbom-scan.ts";
import type {
  SbomScanValidationError,
  SbomScanValidationResult,
} from "../src/sbom-scan.ts";

type MutableJsonObject = { [key: string]: unknown };

const NOW = "2026-06-10T00:00:00.000Z";
const MAX_STALENESS_MS = 14 * 24 * 60 * 60 * 1_000;

test("valid spdx-json report parses and verifies digest linkage", () => {
  const bytes = jsonBytes(validSpdxDocument());
  const result = validateSbomScan(validInput("spdx-json", bytes, "sbom://vita/notes/1.2.3/spdx"));

  assertOk(result);
  assert.equal(result.value.sbom.format, "spdx-json");
  assert.equal(result.value.sbom.digest.value, sha256(bytes));
  assert.equal(result.value.vulnerabilityStatus.status, "clean");
});

test("valid cyclonedx-json report parses and verifies digest linkage", () => {
  const bytes = jsonBytes(validCycloneDxDocument());
  const result = validateSbomScan(
    validInput("cyclonedx-json", bytes, "sbom://vita/notes/1.2.3/cyclonedx"),
  );

  assertOk(result);
  assert.equal(result.value.sbom.format, "cyclonedx-json");
  assert.equal(result.value.sbom.digest.value, sha256(bytes));
});

test("digest mismatch is rejected", () => {
  const input = validInput("spdx-json", jsonBytes(validSpdxDocument()), "sbom://vita/notes/1.2.3/spdx");
  objectAt(objectAt(input, "sbom"), "digest").value = "0".repeat(64);

  const errors = reject(input, "digest mismatch");

  assert.equal(paths(errors).includes("sbom/digest"), true, formatErrors(errors));
});

test("unknown and unbindable vulnerability statuses are rejected", () => {
  for (const status of ["unknown", "scan-pending", "scan-unavailable"]) {
    const input = validInput("spdx-json", jsonBytes(validSpdxDocument()), "sbom://vita/notes/1.2.3/spdx");
    objectAt(input, "vulnerabilityStatus").status = status;

    const errors = reject(input, `status ${status}`);

    assert.equal(paths(errors).includes("vulnerabilityStatus/status"), true, formatErrors(errors));
  }
});

test("stale generatedAt and scannedAt timestamps are rejected", () => {
  const staleScan = validInput(
    "spdx-json",
    jsonBytes(validSpdxDocument()),
    "sbom://vita/notes/1.2.3/spdx",
  );
  objectAt(staleScan, "vulnerabilityStatus").scannedAt = "2026-05-01T00:00:00.000Z";

  assert.equal(
    paths(reject(staleScan, "stale scan")).includes("vulnerabilityStatus/scannedAt"),
    true,
  );

  const staleSbom = validInput(
    "spdx-json",
    jsonBytes(validSpdxDocument()),
    "sbom://vita/notes/1.2.3/spdx",
  );
  objectAt(staleSbom, "sbom").generatedAt = "2026-05-01T00:00:00.000Z";

  assert.equal(paths(reject(staleSbom, "stale sbom")).includes("sbom/generatedAt"), true);
});

test("clean status with non-zero vulnerability counts is rejected", () => {
  const input = validInput("spdx-json", jsonBytes(validSpdxDocument()), "sbom://vita/notes/1.2.3/spdx");
  objectAt(input, "vulnerabilityStatus").high = 1;

  const errors = reject(input, "clean with high finding");

  assert.equal(paths(errors).includes("vulnerabilityStatus/status"), true, formatErrors(errors));
});

test("hostile inputs reject via result type and never throw", () => {
  const cases: readonly {
    readonly label: string;
    readonly input: unknown;
    readonly path?: string;
  }[] = [
    { input: null, label: "null top-level" },
    { input: "bad", label: "string top-level" },
    { input: 42, label: "number top-level" },
    { input: new Date(), label: "exotic top-level" },
    {
      input: mutatedInput((input) => {
        input.sbom = "bad";
      }),
      label: "wrong sbom type",
      path: "sbom",
    },
    {
      input: mutatedInput((input) => {
        input.sbomBytes = {};
      }),
      label: "wrong bytes type",
      path: "sbomBytes",
    },
    {
      input: mutatedInput((input) => {
        input.extra = true;
      }),
      label: "extra top-level field",
      path: "extra",
    },
    {
      input: mutatedInput((input) => {
        objectAt(input, "sbom").extra = true;
      }),
      label: "extra sbom field",
      path: "sbom/extra",
    },
    {
      input: mutatedInput((input) => {
        objectAt(input, "vulnerabilityStatus").extra = true;
      }),
      label: "extra vulnerability field",
      path: "vulnerabilityStatus/extra",
    },
    {
      input: mutatedInput((input) => {
        objectAt(input, "vulnerabilityStatus").critical = Number.NaN;
      }),
      label: "NaN count",
      path: "vulnerabilityStatus",
    },
    {
      input: mutatedInput((input) => {
        input.maxStalenessMs = Number.POSITIVE_INFINITY;
      }),
      label: "infinite max staleness",
      path: "maxStalenessMs",
    },
    {
      input: mutatedInput((input) => {
        objectAt(input, "sbom").generatedAt = "x".repeat(129);
      }),
      label: "oversized string",
      path: "sbom/generatedAt",
    },
    {
      input: withDangerousKey("__proto__"),
      label: "__proto__ key",
      path: "__proto__",
    },
    {
      input: withDangerousKey("constructor"),
      label: "constructor key",
      path: "constructor",
    },
  ];

  for (let index = 0; index < cases.length; index += 1) {
    const item = cases[index];

    if (item === undefined) {
      assert.fail("expected hostile input case");
    }

    const errors = reject(item.input, item.label);

    if (item.path !== undefined) {
      assert.equal(paths(errors).includes(item.path), true, `${item.label}\n${formatErrors(errors)}`);
    }
  }
});

test("accessors, symbol keys, and method-shadowed arrays reject without throwing", () => {
  const accessor = validInput("spdx-json", jsonBytes(validSpdxDocument()), "sbom://vita/notes/1.2.3/spdx");
  Object.defineProperty(accessor, "now", {
    enumerable: true,
    get() {
      throw new Error("getter should not escape");
    },
  });

  assert.equal(paths(reject(accessor, "accessor")).includes("now"), true);

  const symbolKey = validInput("spdx-json", jsonBytes(validSpdxDocument()), "sbom://vita/notes/1.2.3/spdx");
  Object.defineProperty(symbolKey, Symbol("extra"), {
    enumerable: true,
    value: true,
  });

  assert.equal(paths(reject(symbolKey, "symbol key")).includes("Symbol(extra)"), true);

  const shadowedArray = validInput(
    "spdx-json",
    jsonBytes(validSpdxDocument()),
    "sbom://vita/notes/1.2.3/spdx",
  );
  const sbomArray: unknown[] = [];
  Object.defineProperty(sbomArray, "includes", {
    enumerable: true,
    value: () => true,
  });
  shadowedArray.sbom = sbomArray;

  assert.equal(validateSbomScan(shadowedArray).ok, false);
});

function assertOk(
  result: SbomScanValidationResult,
): asserts result is Extract<SbomScanValidationResult, { readonly ok: true }> {
  if (!result.ok) {
    assert.fail(formatErrors(result.errors));
  }
}

function reject(value: unknown, label: string): readonly SbomScanValidationError[] {
  let result: SbomScanValidationResult | undefined;

  assert.doesNotThrow(() => {
    result = validateSbomScan(value);
  }, label);

  if (result === undefined) {
    assert.fail(`validator did not return: ${label}`);
  }

  assert.equal(result.ok, false, label);

  if (result.ok) {
    assert.fail(`expected SBOM scan validation to reject: ${label}`);
  }

  return result.errors;
}

function mutatedInput(mutate: (input: MutableJsonObject) => void): MutableJsonObject {
  const input = validInput("spdx-json", jsonBytes(validSpdxDocument()), "sbom://vita/notes/1.2.3/spdx");

  mutate(input);

  return input;
}

function withDangerousKey(key: "__proto__" | "constructor"): MutableJsonObject {
  const input = validInput("spdx-json", jsonBytes(validSpdxDocument()), "sbom://vita/notes/1.2.3/spdx");

  Object.defineProperty(input, key, {
    configurable: true,
    enumerable: true,
    value: true,
    writable: true,
  });

  return input;
}

function validInput(
  format: "spdx-json" | "cyclonedx-json",
  bytes: Uint8Array,
  ref: string,
): MutableJsonObject {
  return {
    maxStalenessMs: MAX_STALENESS_MS,
    now: NOW,
    sbom: {
      digest: {
        algorithm: "sha256",
        value: sha256(bytes),
      },
      format,
      generatedAt: "2026-06-09T00:00:00.000Z",
      ref,
    },
    sbomBytes: bytes,
    vulnerabilityStatus: {
      critical: 0,
      high: 0,
      low: 0,
      medium: 0,
      scannedAt: "2026-06-09T00:15:00.000Z",
      status: "clean",
    },
  };
}

function validSpdxDocument(): MutableJsonObject {
  return {
    SPDXID: "SPDXRef-DOCUMENT",
    creationInfo: {
      created: "2026-06-09T00:00:00Z",
      creators: ["Tool: vita-catalog-test"],
    },
    dataLicense: "CC0-1.0",
    name: "vita-notes",
    packages: [],
    spdxVersion: "SPDX-2.3",
  };
}

function validCycloneDxDocument(): MutableJsonObject {
  return {
    bomFormat: "CycloneDX",
    components: [],
    metadata: {
      timestamp: "2026-06-09T00:00:00Z",
      tools: [{ name: "vita-catalog-test" }],
    },
    specVersion: "1.5",
    version: 1,
  };
}

function jsonBytes(value: unknown): Uint8Array {
  return Buffer.from(JSON.stringify(value), "utf8");
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function objectAt(value: MutableJsonObject, key: string): MutableJsonObject {
  const child = value[key];

  if (!mutableJsonObject(child)) {
    assert.fail(`expected object at ${key}`);
  }

  return child;
}

function mutableJsonObject(value: unknown): value is MutableJsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function paths(errors: readonly SbomScanValidationError[]): string[] {
  return errors.map((error) => error.path).sort(compareStrings);
}

function formatErrors(errors: readonly SbomScanValidationError[]): string {
  return errors.map((error) => `${error.path}: ${error.message}`).join("\n");
}

function compareStrings(left: string, right: string): number {
  if (left < right) {
    return -1;
  }

  if (left > right) {
    return 1;
  }

  return 0;
}
