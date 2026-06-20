import assert from "node:assert/strict";
import { test } from "node:test";

import { validateIdentityConfig } from "../src/identity-model.ts";
import type {
  IdentityConfig,
  Result,
  ValidationError,
} from "../src/identity-model.ts";

test("valid did:plc and did:web identity configs validate", () => {
  const plcConfig = validConfig();
  const plcResult = validateIdentityConfig(plcConfig);

  if (!plcResult.ok) {
    assert.fail(`expected did:plc identity config to validate: ${JSON.stringify(plcResult.errors)}`);
  }

  assert.deepEqual(plcResult.config, plcConfig);
  assert.equal(plcResult.value, plcResult.config);

  const webConfig = validConfig({
    did: "did:web:alice.example.com",
    handle: "alice.example.com",
    pds: {
      endpoint: "https://pds.example.com/",
    },
  });
  const webResult = validateIdentityConfig(webConfig);

  if (!webResult.ok) {
    assert.fail(`expected did:web identity config to validate: ${JSON.stringify(webResult.errors)}`);
  }

  assert.deepEqual(webResult.config, webConfig);
});

test("malformed DID and handle values are rejected with precise paths", () => {
  const input = mutableConfig();
  input.did = "did:key:z6mnot-supported";
  input.handle = "https://alice.example.com/profile";

  assert.deepEqual(rejectedPaths(validateIdentityConfig(input)), ["did", "handle"]);
});

test("PDS endpoint must be an HTTPS base endpoint", () => {
  const input = mutableConfig();
  input.pds.endpoint = "http://pds.example.com/xrpc";

  assert.deepEqual(rejectedPaths(validateIdentityConfig(input)), ["pds/endpoint"]);
});

test("embedded signing and rotation key material is rejected", () => {
  const topLevelSecret = {
    ...validConfig(),
    privateKey: "-----BEGIN PRIVATE KEY-----\nsecret\n-----END PRIVATE KEY-----",
  };

  assert.equal(rejectedPaths(validateIdentityConfig(topLevelSecret)).includes("privateKey"), true);

  const signingPem = mutableConfig();
  signingPem.signingKeyRef.id =
    "-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASC\n-----END PRIVATE KEY-----";

  assert.equal(
    rejectedPaths(validateIdentityConfig(signingPem)).includes("signingKeyRef/id"),
    true,
  );

  const rotationSeed = mutableConfig();
  const rotationKeyRef = rotationSeed.rotationKeyRefs[0];

  if (rotationKeyRef === undefined) {
    assert.fail("expected rotation key reference fixture");
  }

  rotationKeyRef.handle =
    "seed phrase abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";

  assert.equal(
    rejectedPaths(validateIdentityConfig(rotationSeed)).includes("rotationKeyRefs/0/handle"),
    true,
  );
});

test("partial key references are rejected fail-closed", () => {
  const input = mutableConfig();
  delete input.signingKeyRef.handle;
  input.rotationKeyRefs = [];

  assert.deepEqual(
    rejectedPaths(validateIdentityConfig(input)),
    ["rotationKeyRefs", "signingKeyRef/handle"],
  );
});

test("hostile untrusted input is rejected through safeNormalize without throwing", () => {
  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;

  const accessor: Record<string, unknown> = {};
  let getterReads = 0;
  Object.defineProperty(accessor, "did", {
    enumerable: true,
    get() {
      getterReads += 1;
      throw new Error("getter should not be read");
    },
  });

  const methodShadowed = mutableConfig();
  const shadowedRotationRefs = [...methodShadowed.rotationKeyRefs];
  Object.defineProperty(shadowedRotationRefs, "map", {
    enumerable: true,
    value() {
      return [];
    },
  });
  methodShadowed.rotationKeyRefs = shadowedRotationRefs;

  const hostileIterator = mutableConfig();
  const iteratorRotationRefs = [...hostileIterator.rotationKeyRefs];
  let iteratorReads = 0;
  Object.defineProperty(iteratorRotationRefs, Symbol.iterator, {
    enumerable: true,
    get() {
      iteratorReads += 1;
      throw new Error("iterator should not be read");
    },
  });
  hostileIterator.rotationKeyRefs = iteratorRotationRefs;

  const inputs: readonly unknown[] = [
    null,
    "identity",
    cyclic,
    accessor,
    new Date(),
    new Map(),
    new Proxy({}, {}),
    methodShadowed,
    hostileIterator,
  ];

  for (let index = 0; index < inputs.length; index += 1) {
    assertRejected(inputs[index]);
  }

  assert.equal(getterReads, 0);
  assert.equal(iteratorReads, 0);
});

function validConfig(overrides: Partial<IdentityConfig> = {}): IdentityConfig {
  return {
    did: "did:plc:ewvi7nxzyoun6zhxrhs64oiz",
    handle: "alice.example.com",
    pds: {
      endpoint: "https://pds.example.com",
    },
    rotationKeyRefs: [
      {
        handle: "identity-rotation-primary",
        id: "key:identity-rotation-primary",
      },
    ],
    signingKeyRef: {
      handle: "identity-signing-primary",
      id: "key:identity-signing-primary",
    },
    ...overrides,
  };
}

function mutableConfig(): MutableIdentityInput {
  const source = validConfig();

  return {
    did: source.did,
    handle: source.handle,
    pds: {
      endpoint: source.pds.endpoint,
    },
    rotationKeyRefs: source.rotationKeyRefs.map((keyRef) => ({
      handle: keyRef.handle,
      id: keyRef.id,
    })),
    signingKeyRef: {
      handle: source.signingKeyRef.handle,
      id: source.signingKeyRef.id,
    },
  };
}

function rejectedPaths(result: Result): readonly string[] {
  if (result.ok) {
    assert.fail(`expected validation to fail: ${JSON.stringify(result.value)}`);
  }

  return result.errors.map((error) => error.path).sort();
}

function assertRejected(value: unknown): void {
  let errors: readonly ValidationError[] | undefined;

  assert.doesNotThrow(() => {
    const result = validateIdentityConfig(value);

    if (result.ok) {
      assert.fail(`expected validation to fail: ${JSON.stringify(result.value)}`);
    }

    errors = result.errors;
  });

  assert.notEqual(errors, undefined);
}

interface MutableIdentityInput extends Record<string, unknown> {
  did: unknown;
  handle: unknown;
  pds: Record<string, unknown> & {
    endpoint?: unknown;
  };
  rotationKeyRefs: Array<Record<string, unknown> & {
    handle?: unknown;
    id?: unknown;
  }>;
  signingKeyRef: Record<string, unknown> & {
    handle?: unknown;
    id?: unknown;
  };
}
