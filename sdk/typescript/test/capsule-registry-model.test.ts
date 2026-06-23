import assert from "node:assert/strict";
import { test } from "node:test";

import {
  buildCapsuleRegistryApplyRequest,
  buildCapsuleRegistryConfig,
  validateCapsuleRegistry,
  validateCapsuleRegistryApplyRequest,
} from "../src/capsule-registry-model.ts";
import type {
  CapsuleEntry,
  CapsuleRegistry,
  CapsuleRegistryValidationError,
  CapsuleRegistryValidationResult,
} from "../src/capsule-registry-model.ts";

const SHA256_EMPTY = "sha256-47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU=";
const SHA384_ZERO =
  "sha384-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

test("a valid installed-capsule registry validates", () => {
  const registry = validRegistry();
  const result = validateCapsuleRegistry(registry);

  if (!result.ok) {
    assert.fail(`expected capsule registry to validate: ${JSON.stringify(result.errors)}`);
  }

  assert.deepEqual(result.registry, registry);
  assert.equal(result.value, result.registry);
});

test("the builder emits the agent capsule.registry apply request shape", () => {
  const registry = validRegistry();
  const request = buildCapsuleRegistryApplyRequest(registry);
  const config = buildCapsuleRegistryConfig(registry);

  if (!request.ok) {
    assert.fail(`expected capsule apply request to build: ${JSON.stringify(request.errors)}`);
  }
  if (!config.ok) {
    assert.fail(`expected capsule config to build: ${JSON.stringify(config.errors)}`);
  }

  assert.deepEqual(request.request, {
    desired: {
      capsules: registry,
    },
  });
  assert.deepEqual(config.config, {
    "capsule.registry": request.request,
  });
  assert.equal(config.value, config.config);
});

test("malformed id, version, SRI, and state are rejected with precise paths", () => {
  const registry = mutableRegistry();
  const entry = registry[0];

  if (entry === undefined) {
    assert.fail("expected capsule registry fixture");
  }

  entry.id = "com.vita/app";
  entry.version = "";
  entry.integrity = "sha256-AAAA";
  entry.state = "enabled";

  assert.deepEqual(
    rejectedPaths(validateCapsuleRegistry(registry)),
    ["0/id", "0/integrity", "0/state", "0/version"],
  );
});

test("duplicate capsule ids are rejected", () => {
  const registry = mutableRegistry();
  const entry = registry[0];

  if (entry === undefined) {
    assert.fail("expected capsule registry fixture");
  }

  registry.push({
    id: entry.id,
    integrity: SHA256_EMPTY,
    state: "disabled",
    version: "1.2.4",
  });

  assert.deepEqual(rejectedPaths(validateCapsuleRegistry(registry)), ["2"]);
});

test("embedded secrets and embedded capsule bytes are rejected", () => {
  const secretRegistry = mutableRegistry();
  const secretEntry = secretRegistry[0];

  if (secretEntry === undefined) {
    assert.fail("expected capsule registry fixture");
  }

  secretEntry.version = "private_key";
  assert.deepEqual(rejectedPaths(validateCapsuleRegistry(secretRegistry)), ["0/version"]);

  const embeddedRegistry = mutableRegistry();
  const embeddedEntry = embeddedRegistry[0];

  if (embeddedEntry === undefined) {
    assert.fail("expected capsule registry fixture");
  }

  embeddedEntry.capsuleBytes = "data:application/vnd.vita.capsule;base64,AAAA";

  assert.deepEqual(rejectedPaths(validateCapsuleRegistry(embeddedRegistry)), ["0/capsuleBytes"]);
});

test("unknown fields are rejected at every request level", () => {
  assert.deepEqual(
    rejectedPaths(
      validateCapsuleRegistryApplyRequest({
        desired: {
          capsules: validRegistry(),
        },
        extra: true,
      }),
    ),
    ["extra"],
  );

  assert.deepEqual(
    rejectedPaths(
      validateCapsuleRegistryApplyRequest({
        desired: {
          capsules: validRegistry(),
          extra: true,
        },
      }),
    ),
    ["desired/extra"],
  );

  const registry = mutableRegistry();
  const entry = registry[0];

  if (entry === undefined) {
    assert.fail("expected capsule registry fixture");
  }

  entry.reload = true;

  assert.deepEqual(rejectedPaths(validateCapsuleRegistry(registry)), ["0/reload"]);
});

test("missing required fields are rejected fail-closed", () => {
  const registry = mutableRegistry();
  const entry = registry[0];

  if (entry === undefined) {
    assert.fail("expected capsule registry fixture");
  }

  delete entry.integrity;

  assert.deepEqual(rejectedPaths(validateCapsuleRegistry(registry)), ["0/integrity"]);
});

test("hostile and partial input fails closed through safeNormalize without throwing", () => {
  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;

  const accessor: Record<string, unknown> = {};
  let getterReads = 0;
  Object.defineProperty(accessor, "id", {
    enumerable: true,
    get() {
      getterReads += 1;
      throw new Error("getter should not be read");
    },
  });

  const methodShadowed = mutableRegistry();
  Object.defineProperty(methodShadowed, "map", {
    enumerable: true,
    value() {
      return [];
    },
  });

  const hostileIterator = mutableRegistry();
  let iteratorReads = 0;
  Object.defineProperty(hostileIterator, Symbol.iterator, {
    enumerable: true,
    get() {
      iteratorReads += 1;
      throw new Error("iterator should not be read");
    },
  });

  const partialEntry: readonly unknown[] = [
    {
      id: "com.vita.notes",
    },
  ];

  const inputs: readonly unknown[] = [
    null,
    "registry",
    {},
    cyclic,
    accessor,
    new Date(),
    new Map(),
    new Proxy({}, {}),
    methodShadowed,
    hostileIterator,
    partialEntry,
  ];

  for (let index = 0; index < inputs.length; index += 1) {
    assertRejected(inputs[index]);
  }

  assert.equal(getterReads, 0);
  assert.equal(iteratorReads, 0);
});

function validRegistry(): CapsuleRegistry {
  return [
    capsule("com.vita.notes", "1.2.3", SHA256_EMPTY, "installed"),
    capsule("capsule:local-search", "2026.06.20", SHA384_ZERO, "disabled"),
  ];
}

function mutableRegistry(): MutableCapsuleEntryInput[] {
  return validRegistry().map((entry) => ({
    id: entry.id,
    integrity: entry.integrity,
    state: entry.state,
    version: entry.version,
  }));
}

function capsule(
  id: string,
  version: string,
  integrity: CapsuleEntry["integrity"],
  state: CapsuleEntry["state"],
): CapsuleEntry {
  return {
    id,
    integrity,
    state,
    version,
  };
}

function rejectedPaths(
  result:
    | CapsuleRegistryValidationResult
    | ReturnType<typeof validateCapsuleRegistryApplyRequest>
    | ReturnType<typeof buildCapsuleRegistryConfig>,
): readonly string[] {
  if (result.ok) {
    assert.fail(`expected validation to fail: ${JSON.stringify(result.value)}`);
  }

  return [...new Set(result.errors.map((error) => error.path))].sort();
}

function assertRejected(value: unknown): void {
  let errors: readonly CapsuleRegistryValidationError[] | undefined;

  assert.doesNotThrow(() => {
    const result = validateCapsuleRegistry(value);

    if (result.ok) {
      assert.fail(`expected validation to fail: ${JSON.stringify(result.value)}`);
    }

    errors = result.errors;
  });

  assert.notEqual(errors, undefined);
}

interface MutableCapsuleEntryInput extends Record<string, unknown> {
  id?: unknown;
  version?: unknown;
  integrity?: unknown;
  state?: unknown;
}
