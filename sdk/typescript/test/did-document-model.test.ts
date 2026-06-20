import assert from "node:assert/strict";
import { test } from "node:test";

import { validateDidDocument } from "../src/did-document-model.ts";
import type {
  DidDocument,
  Result,
  ValidationError,
} from "../src/did-document-model.ts";

const VALID_DID = "did:plc:ewvi7nxzyoun6zhxrhs64oiz";
const VALID_PUBLIC_KEY_MULTIBASE =
  "z123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

test("a valid DID document validates verification methods and services", () => {
  const document = validDocument();
  const result = validateDidDocument(document);

  if (!result.ok) {
    assert.fail(`expected DID document to validate: ${JSON.stringify(result.errors)}`);
  }

  assert.deepEqual(result.document, document);
  assert.equal(result.value, result.document);
});

test("malformed DID, handle, verification method id, and service endpoint are rejected with paths", () => {
  const input = mutableDocument();
  const method = input.verificationMethod[0];
  const service = input.service[0];

  if (method === undefined || service === undefined) {
    assert.fail("expected DID document fixtures");
  }

  input.id = "did:key:z6mnot-supported";
  input.alsoKnownAs[0] = "https://alice.example.com/profile";
  method.id = "did:plc:ewvi7nxzyoun6zhxrhs64oiz-atproto";
  service.serviceEndpoint = "http://pds.example.com";

  assert.deepEqual(
    rejectedPaths(validateDidDocument(input)),
    [
      "alsoKnownAs/0",
      "id",
      "service/0/serviceEndpoint",
      "verificationMethod/0/id",
    ],
  );
});

test("verification method type is a closed set", () => {
  const input = mutableDocument();
  const method = input.verificationMethod[0];

  if (method === undefined) {
    assert.fail("expected verification method fixture");
  }

  method.type = "Ed25519VerificationKey2020";

  assert.deepEqual(rejectedPaths(validateDidDocument(input)), ["verificationMethod/0/type"]);
});

test("inline private key material in publicKeyMultibase is rejected", () => {
  const input = mutableDocument();
  const method = input.verificationMethod[0];

  if (method === undefined) {
    assert.fail("expected verification method fixture");
  }

  method.publicKeyMultibase =
    "-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASC\n-----END PRIVATE KEY-----";

  assert.deepEqual(
    rejectedPaths(validateDidDocument(input)),
    ["verificationMethod/0/publicKeyMultibase"],
  );
});

test("duplicate verification method and service ids are rejected", () => {
  const input = mutableDocument();
  const method = input.verificationMethod[0];
  const service = input.service[0];

  if (method === undefined || service === undefined) {
    assert.fail("expected DID document fixtures");
  }

  input.verificationMethod.push({
    controller: VALID_DID,
    id: method.id,
    publicKeyMultibase: "z6MkiTBz6bhPwwYkZqdZDz1Vq5Pbk1xqp6LjmA52sBfT",
    type: "Multikey",
  });
  input.service.push({
    id: service.id,
    serviceEndpoint: "https://duplicate-pds.example.com",
    type: "AtprotoPersonalDataServer",
  });

  assert.deepEqual(
    rejectedPaths(validateDidDocument(input)),
    ["service/1/id", "verificationMethod/1/id"],
  );
});

test("missing required fields are rejected fail-closed", () => {
  const input = {
    id: VALID_DID,
    service: [
      {
        id: "#atproto_pds",
        type: "AtprotoPersonalDataServer",
      },
    ],
    verificationMethod: [
      {
        id: `${VALID_DID}#atproto`,
        publicKeyMultibase: VALID_PUBLIC_KEY_MULTIBASE,
        type: "Multikey",
      },
    ],
  };

  assert.deepEqual(
    rejectedPaths(validateDidDocument(input)),
    [
      "alsoKnownAs",
      "service/0/serviceEndpoint",
      "verificationMethod/0/controller",
    ],
  );
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

  const methodShadowed = mutableDocument();
  const shadowedMethods = [...methodShadowed.verificationMethod];
  Object.defineProperty(shadowedMethods, "some", {
    enumerable: true,
    value() {
      return false;
    },
  });
  methodShadowed.verificationMethod = shadowedMethods;

  const hostileIterator = mutableDocument();
  const iteratorServices = [...hostileIterator.service];
  let iteratorReads = 0;
  Object.defineProperty(iteratorServices, Symbol.iterator, {
    enumerable: true,
    get() {
      iteratorReads += 1;
      throw new Error("iterator should not be read");
    },
  });
  hostileIterator.service = iteratorServices;

  const partialMethod = {
    alsoKnownAs: ["alice.example.com"],
    id: VALID_DID,
    service: [
      {
        id: "#atproto_pds",
        serviceEndpoint: "https://pds.example.com",
        type: "AtprotoPersonalDataServer",
      },
    ],
    verificationMethod: [
      {
        id: `${VALID_DID}#atproto`,
      },
    ],
  };

  const inputs: readonly unknown[] = [
    null,
    "did-document",
    [],
    cyclic,
    accessor,
    new Date(),
    new Map(),
    new Proxy({}, {}),
    methodShadowed,
    hostileIterator,
    partialMethod,
  ];

  for (let index = 0; index < inputs.length; index += 1) {
    assertRejected(inputs[index]);
  }

  assert.equal(getterReads, 0);
  assert.equal(iteratorReads, 0);
});

function validDocument(overrides: Partial<DidDocument> = {}): DidDocument {
  return {
    alsoKnownAs: ["alice.example.com"],
    id: VALID_DID,
    service: [
      {
        id: "#atproto_pds",
        serviceEndpoint: "https://pds.example.com",
        type: "AtprotoPersonalDataServer",
      },
    ],
    verificationMethod: [
      {
        controller: VALID_DID,
        id: `${VALID_DID}#atproto`,
        publicKeyMultibase: VALID_PUBLIC_KEY_MULTIBASE,
        type: "Multikey",
      },
    ],
    ...overrides,
  };
}

function mutableDocument(): MutableDidDocumentInput {
  const source = validDocument();

  return {
    alsoKnownAs: [...source.alsoKnownAs],
    id: source.id,
    service: source.service.map((service) => ({
      id: service.id,
      serviceEndpoint: service.serviceEndpoint,
      type: service.type,
    })),
    verificationMethod: source.verificationMethod.map((method) => ({
      controller: method.controller,
      id: method.id,
      publicKeyMultibase: method.publicKeyMultibase,
      type: method.type,
    })),
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
    const result = validateDidDocument(value);

    if (result.ok) {
      assert.fail(`expected validation to fail: ${JSON.stringify(result.value)}`);
    }

    errors = result.errors;
  });

  assert.notEqual(errors, undefined);
}

interface MutableVerificationMethodInput extends Record<string, unknown> {
  controller?: unknown;
  id?: unknown;
  publicKeyMultibase?: unknown;
  type?: unknown;
}

interface MutableServiceInput extends Record<string, unknown> {
  id?: unknown;
  serviceEndpoint?: unknown;
  type?: unknown;
}

interface MutableDidDocumentInput extends Record<string, unknown> {
  alsoKnownAs: unknown[];
  id: unknown;
  service: MutableServiceInput[];
  verificationMethod: MutableVerificationMethodInput[];
}
