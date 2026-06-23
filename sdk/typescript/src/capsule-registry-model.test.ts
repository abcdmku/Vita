import assert from "node:assert/strict";
import { test } from "node:test";

import {
  buildCapsuleRegistryConfig,
  validateCapsuleRegistry,
} from "./capsule-registry-model.ts";
import type {
  CapsuleEntry,
  CapsuleRegistryValidationResult,
} from "./capsule-registry-model.ts";

const TEST_CAPSULE_ENTRY = Object.freeze({
  id: "local.test.capsule",
  integrity: "sha256-47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU=",
  state: "installed",
  version: "1.0.0",
}) satisfies CapsuleEntry;

test("capsule registry config builder emits the agent apply request shape", () => {
  const result = buildCapsuleRegistryConfig(Object.freeze([TEST_CAPSULE_ENTRY]));

  if (!result.ok) {
    assert.fail(`expected capsule config to build: ${JSON.stringify(result.errors)}`);
  }

  assert.deepEqual(result.config, {
    "capsule.registry": {
      desired: {
        capsules: [TEST_CAPSULE_ENTRY],
      },
    },
  });
});

test("capsule registry rejects bad SRI, embedded secret, and unknown field", () => {
  assert.deepEqual(
    rejectedPaths(
      validateCapsuleRegistry([
        {
          ...TEST_CAPSULE_ENTRY,
          integrity: "sha256-AAAA",
        },
      ]),
    ),
    ["0/integrity"],
  );
  assert.deepEqual(
    rejectedPaths(
      validateCapsuleRegistry([
        {
          ...TEST_CAPSULE_ENTRY,
          version: "private_key",
        },
      ]),
    ),
    ["0/version"],
  );
  assert.deepEqual(
    rejectedPaths(
      validateCapsuleRegistry([
        {
          ...TEST_CAPSULE_ENTRY,
          reload: true,
        },
      ]),
    ),
    ["0/reload"],
  );
});

function rejectedPaths(result: CapsuleRegistryValidationResult): readonly string[] {
  if (result.ok) {
    assert.fail(`expected validation to fail: ${JSON.stringify(result.value)}`);
  }

  return [...new Set(result.errors.map((error) => error.path))].sort();
}
