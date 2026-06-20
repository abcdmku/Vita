import assert from "node:assert/strict";
import { test } from "node:test";

import {
  validateRecordRef,
  validateRepoCommit,
  validateSyncState,
} from "../src/pds-model.ts";
import type {
  PdsModelValidationError,
  RecordRef,
  RecordRefValidationResult,
  RepoCommit,
  RepoCommitValidationResult,
  SyncState,
  SyncStateValidationResult,
} from "../src/pds-model.ts";

const DID = "did:plc:ewvi7nxzyoun6zhxrhs64oiz";
const CID_A = "bafkreigh2akiscaildcvwcuzjdfu7kdc32gndn2r2hkoqefj7yppz364gu";
const CID_B = "bafybeigdyrzt5sfp7udm7hu76ekfya5f45mcm6qzdv6woc4f3gj3sidfwy";
const REV_A = "3jui7kd54zh2y";
const REV_B = "3jui7kabcde2y";

test("valid record refs, repo commits, and sync states validate", () => {
  const recordRef = validRecordRef();
  const recordResult = validateRecordRef(recordRef);

  if (!recordResult.ok) {
    assert.fail(`expected record ref to validate: ${JSON.stringify(recordResult.errors)}`);
  }

  assert.deepEqual(recordResult.recordRef, recordRef);
  assert.equal(recordResult.value, recordResult.recordRef);

  const commit = validRepoCommit();
  const commitResult = validateRepoCommit(commit);

  if (!commitResult.ok) {
    assert.fail(`expected repo commit to validate: ${JSON.stringify(commitResult.errors)}`);
  }

  assert.deepEqual(commitResult.commit, commit);
  assert.equal(commitResult.value, commitResult.commit);

  const state = validSyncState();
  const stateResult = validateSyncState(state);

  if (!stateResult.ok) {
    assert.fail(`expected sync state to validate: ${JSON.stringify(stateResult.errors)}`);
  }

  assert.deepEqual(stateResult.state, state);
  assert.equal(stateResult.value, stateResult.state);
});

test("malformed record collection, rkey, and CID reject with precise paths", () => {
  assert.deepEqual(
    rejectedPaths(
      validateRecordRef({
        ...validRecordRef(),
        cid: "QmYwAPJzv5CZsnAzt8auVZRnPbR4E5zE7nZyZkJQF6x1vM",
        collection: "app..bsky/feed.post",
        rkey: "bad/key",
      }),
    ),
    ["cid", "collection", "rkey"],
  );
});

test("repo commits require TID revs and CIDv1 commit links", () => {
  assert.deepEqual(
    rejectedPaths(
      validateRepoCommit({
        ...validRepoCommit(),
        cid: "not-a-cid",
        prev: "QmYwAPJzv5CZsnAzt8auVZRnPbR4E5zE7nZyZkJQF6x1vM",
        rev: "not-a-tid",
      }),
    ),
    ["cid", "prev", "rev"],
  );
});

test("sync state rejects malformed repo DIDs and non-monotonic cursors", () => {
  const invalidDid = mutableSyncState();
  invalidDid.repo = "did:key:z6mnot-supported";

  assert.deepEqual(rejectedPaths(validateSyncState(invalidDid)), ["repo"]);

  const negativeCursor = mutableSyncState();
  negativeCursor.cursor = -1;

  assert.deepEqual(rejectedPaths(validateSyncState(negativeCursor)), ["cursor"]);

  const malformedCursor = mutableSyncState();
  malformedCursor.cursor = "42";

  assert.deepEqual(rejectedPaths(validateSyncState(malformedCursor)), ["cursor"]);
});

test("embedded key material fields are rejected", () => {
  assert.deepEqual(
    rejectedPaths(
      validateRecordRef({
        ...validRecordRef(),
        privateKey: "-----BEGIN PRIVATE KEY-----\nsecret\n-----END PRIVATE KEY-----",
      }),
    ),
    ["privateKey"],
  );

  const state = mutableSyncState();
  state.repoHead.keyMaterial = "-----BEGIN PRIVATE KEY-----\nsecret\n-----END PRIVATE KEY-----";

  assert.deepEqual(rejectedPaths(validateSyncState(state)), ["repoHead/keyMaterial"]);
});

test("partial shapes are rejected fail-closed", () => {
  const partialRecord = mutableRecordRef();
  delete partialRecord.rkey;

  assert.deepEqual(rejectedPaths(validateRecordRef(partialRecord)), ["rkey"]);

  const partialCommit = mutableRepoCommit();
  delete partialCommit.prev;

  assert.deepEqual(rejectedPaths(validateRepoCommit(partialCommit)), ["prev"]);

  const partialState = mutableSyncState();
  delete partialState.repoHead.rev;

  assert.deepEqual(rejectedPaths(validateSyncState(partialState)), ["repoHead/rev"]);
});

test("hostile untrusted input is rejected through safeNormalize without throwing", () => {
  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;

  const accessor: Record<string, unknown> = {};
  let getterReads = 0;
  Object.defineProperty(accessor, "collection", {
    enumerable: true,
    get() {
      getterReads += 1;
      throw new Error("getter should not be read");
    },
  });

  const methodShadowed = mutableRecordRef();
  Object.defineProperty(methodShadowed, "hasOwnProperty", {
    enumerable: true,
    value: "shadowed",
  });

  const hostileIterator = mutableSyncState();
  let iteratorReads = 0;
  Object.defineProperty(hostileIterator, Symbol.iterator, {
    enumerable: true,
    get() {
      iteratorReads += 1;
      throw new Error("iterator should not be read");
    },
  });

  const inputs: readonly [
    (value: unknown) => PdsValidationResult,
    unknown,
  ][] = [
    [validateRecordRef, null],
    [validateRecordRef, "record"],
    [validateRecordRef, cyclic],
    [validateRecordRef, accessor],
    [validateRecordRef, new Date()],
    [validateRepoCommit, new Map()],
    [validateSyncState, new Proxy({}, {})],
    [validateRecordRef, methodShadowed],
    [validateSyncState, hostileIterator],
  ];

  for (let index = 0; index < inputs.length; index += 1) {
    const item = inputs[index];

    if (item === undefined) {
      assert.fail("expected hostile-input fixture");
    }

    const [validate, value] = item;
    assertRejected(validate, value);
  }

  assert.equal(getterReads, 0);
  assert.equal(iteratorReads, 0);
});

function validRecordRef(): RecordRef {
  return {
    cid: CID_A,
    collection: "app.bsky.feed.post",
    rkey: REV_A,
  };
}

function validRepoCommit(): RepoCommit {
  return {
    cid: CID_B,
    prev: CID_A,
    rev: REV_B,
  };
}

function validSyncState(): SyncState {
  return {
    cursor: 42,
    repo: DID,
    repoHead: validRepoCommit(),
  };
}

function mutableRecordRef(): MutableRecordRefInput {
  return { ...validRecordRef() };
}

function mutableRepoCommit(): MutableRepoCommitInput {
  return { ...validRepoCommit() };
}

function mutableSyncState(): MutableSyncStateInput {
  const state = validSyncState();

  return {
    cursor: state.cursor,
    repo: state.repo,
    repoHead: {
      cid: state.repoHead.cid,
      prev: state.repoHead.prev,
      rev: state.repoHead.rev,
    },
  };
}

function rejectedPaths(result: PdsValidationResult): readonly string[] {
  if (result.ok) {
    assert.fail(`expected validation to fail: ${JSON.stringify(result.value)}`);
  }

  return result.errors.map((error) => error.path).sort();
}

function assertRejected(
  validate: (value: unknown) => PdsValidationResult,
  value: unknown,
): void {
  let errors: readonly PdsModelValidationError[] | undefined;

  assert.doesNotThrow(() => {
    const result = validate(value);

    if (result.ok) {
      assert.fail(`expected validation to fail: ${JSON.stringify(result.value)}`);
    }

    errors = result.errors;
  });

  assert.notEqual(errors, undefined);
}

type PdsValidationResult =
  | RecordRefValidationResult
  | RepoCommitValidationResult
  | SyncStateValidationResult;

interface MutableRecordRefInput extends Record<string, unknown> {
  cid?: unknown;
  collection?: unknown;
  rkey?: unknown;
}

interface MutableRepoCommitInput extends Record<string, unknown> {
  cid?: unknown;
  prev?: unknown;
  rev?: unknown;
}

interface MutableSyncStateInput extends Record<string, unknown> {
  cursor?: unknown;
  repo?: unknown;
  repoHead: MutableRepoCommitInput;
}
