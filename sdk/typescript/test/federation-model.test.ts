import assert from "node:assert/strict";
import { test } from "node:test";

import { validateFederationConfig } from "../src/federation-model.ts";
import type {
  FederationConfig,
  Result,
  ValidationError,
} from "../src/federation-model.ts";

test("a valid federation config validates relays and explicit peer trust", () => {
  const config = validConfig();
  const result = validateFederationConfig(config);

  if (!result.ok) {
    assert.fail(`expected federation config to validate: ${JSON.stringify(result.errors)}`);
  }

  assert.deepEqual(result.config, config);
  assert.equal(result.value, result.config);

  const denyAll = validConfig({
    peers: [],
    relays: [
      {
        endpoint: "https://relay.example.com/",
        subscribePolicy: "disabled",
      },
    ],
  });
  const denyAllResult = validateFederationConfig(denyAll);

  if (!denyAllResult.ok) {
    assert.fail(`expected deny-all federation config to validate: ${JSON.stringify(denyAllResult.errors)}`);
  }

  assert.equal(denyAllResult.config.peers.length, 0);
});

test("malformed relay and peer fields are rejected with precise paths", () => {
  const input = mutableConfig();
  const relay = input.relays[0];
  const peer = input.peers[0];

  if (relay === undefined || peer === undefined) {
    assert.fail("expected federation config fixtures");
  }

  relay.endpoint = "http://relay.example.com/xrpc";
  relay.subscribePolicy = "all";
  peer.did = "did:key:z6mnot-supported";
  peer.handle = "https://alice.example.com/profile";
  peer.endpoint = "https://pds.example.com/xrpc";
  peer.trust = "maybe";

  assert.deepEqual(
    rejectedPaths(validateFederationConfig(input)),
    [
      "peers/0/did",
      "peers/0/endpoint",
      "peers/0/handle",
      "peers/0/trust",
      "relays/0/endpoint",
      "relays/0/subscribePolicy",
    ],
  );

  const nullIdentityFields = mutableConfig();
  const nullPeer = nullIdentityFields.peers[0];

  if (nullPeer === undefined) {
    assert.fail("expected federation peer fixture");
  }

  nullPeer.did = null;
  nullPeer.handle = null;
  nullPeer.endpoint = null;

  assert.deepEqual(
    rejectedPaths(validateFederationConfig(nullIdentityFields)),
    ["peers/0/did", "peers/0/endpoint", "peers/0/handle"],
  );
});

test("duplicate peer DIDs are rejected", () => {
  const input = mutableConfig();
  const peer = input.peers[0];

  if (peer === undefined) {
    assert.fail("expected federation peer fixture");
  }

  input.peers.push({
    did: peer.did,
    endpoint: "https://duplicate-pds.example.com",
    handle: "duplicate.example.com",
    trust: "block",
  });

  assert.deepEqual(rejectedPaths(validateFederationConfig(input)), ["peers/2/did"]);
});

test("missing required fields are rejected fail-closed", () => {
  const missingTopLevel = {
    relays: [
      {
        endpoint: "https://relay.example.com",
      },
    ],
  };

  assert.deepEqual(
    rejectedPaths(validateFederationConfig(missingTopLevel)),
    ["peers", "relays/0/subscribePolicy"],
  );

  const missingPeerField = mutableConfig();
  const peer = missingPeerField.peers[0];

  if (peer === undefined) {
    assert.fail("expected federation peer fixture");
  }

  delete peer.trust;

  assert.deepEqual(rejectedPaths(validateFederationConfig(missingPeerField)), ["peers/0/trust"]);
});

test("embedded key material fields are rejected", () => {
  const topLevelSecret = {
    ...validConfig(),
    privateKey: "-----BEGIN PRIVATE KEY-----\nsecret\n-----END PRIVATE KEY-----",
  };

  assert.deepEqual(rejectedPaths(validateFederationConfig(topLevelSecret)), ["privateKey"]);

  const nestedSecret = mutableConfig();
  const relay = nestedSecret.relays[0];
  const peer = nestedSecret.peers[0];

  if (relay === undefined || peer === undefined) {
    assert.fail("expected federation config fixtures");
  }

  relay.apiKey = "inline-secret";
  peer.keyMaterial = "-----BEGIN PRIVATE KEY-----\nsecret\n-----END PRIVATE KEY-----";

  assert.deepEqual(
    rejectedPaths(validateFederationConfig(nestedSecret)),
    ["peers/0/keyMaterial", "relays/0/apiKey"],
  );
});

test("hostile and partial input fails closed through safeNormalize without throwing", () => {
  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;

  const accessor: Record<string, unknown> = {};
  let getterReads = 0;
  Object.defineProperty(accessor, "relays", {
    enumerable: true,
    get() {
      getterReads += 1;
      throw new Error("getter should not be read");
    },
  });

  const methodShadowed = mutableConfig();
  const shadowedPeers = [...methodShadowed.peers];
  Object.defineProperty(shadowedPeers, "some", {
    enumerable: true,
    value() {
      return false;
    },
  });
  methodShadowed.peers = shadowedPeers;

  const hostileIterator = mutableConfig();
  const iteratorRelays = [...hostileIterator.relays];
  let iteratorReads = 0;
  Object.defineProperty(iteratorRelays, Symbol.iterator, {
    enumerable: true,
    get() {
      iteratorReads += 1;
      throw new Error("iterator should not be read");
    },
  });
  hostileIterator.relays = iteratorRelays;

  const partialPeer = mutableConfig();
  partialPeer.peers = [
    {
      did: "did:plc:ewvi7nxzyoun6zhxrhs64oiz",
    },
  ];

  const inputs: readonly unknown[] = [
    null,
    "federation",
    [],
    cyclic,
    accessor,
    new Date(),
    new Map(),
    new Proxy({}, {}),
    methodShadowed,
    hostileIterator,
    partialPeer,
  ];

  for (let index = 0; index < inputs.length; index += 1) {
    assertRejected(inputs[index]);
  }

  assert.equal(getterReads, 0);
  assert.equal(iteratorReads, 0);
});

function validConfig(overrides: Partial<FederationConfig> = {}): FederationConfig {
  return {
    relays: [
      {
        endpoint: "https://relay.example.com",
        subscribePolicy: "allowed-peers",
      },
    ],
    peers: [
      {
        did: "did:plc:ewvi7nxzyoun6zhxrhs64oiz",
        endpoint: "https://pds.example.com",
        handle: "alice.example.com",
        trust: "allow",
      },
      {
        did: "did:web:bob.example.com",
        endpoint: "https://bob-pds.example.com",
        handle: "bob.example.com",
        trust: "block",
      },
    ],
    ...overrides,
  };
}

function mutableConfig(): MutableFederationInput {
  const source = validConfig();

  return {
    relays: source.relays.map((relay) => ({
      endpoint: relay.endpoint,
      subscribePolicy: relay.subscribePolicy,
    })),
    peers: source.peers.map((peer) => ({
      did: peer.did,
      endpoint: peer.endpoint,
      handle: peer.handle,
      trust: peer.trust,
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
    const result = validateFederationConfig(value);

    if (result.ok) {
      assert.fail(`expected validation to fail: ${JSON.stringify(result.value)}`);
    }

    errors = result.errors;
  });

  assert.notEqual(errors, undefined);
}

interface MutableRelayInput extends Record<string, unknown> {
  endpoint?: unknown;
  subscribePolicy?: unknown;
}

interface MutablePeerInput extends Record<string, unknown> {
  did?: unknown;
  endpoint?: unknown;
  handle?: unknown;
  trust?: unknown;
}

interface MutableFederationInput extends Record<string, unknown> {
  relays: MutableRelayInput[];
  peers: MutablePeerInput[];
}
