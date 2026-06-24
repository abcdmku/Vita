import assert from "node:assert/strict";
import { test } from "node:test";

import {
  validatePdsCommitLogEntry,
  validatePdsQueryResponse,
  validateRecordRef,
  validateRepoCommit,
  validateSyncState,
} from "../src/pds-model.ts";
import type {
  PdsCommitLogEntryValidationResult,
  PdsModelValidationError,
  PdsQueryResponse,
  PdsQueryResponseValidationResult,
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
const DIGEST_A = "1111111111111111111111111111111111111111111111111111111111111111";
const DIGEST_B = "2222222222222222222222222222222222222222222222222222222222222222";

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

test("valid PDS query responses and delete commit log entries validate", () => {
  const response = validQueryResponse();
  const responseResult = validatePdsQueryResponse(response);

  if (!responseResult.ok) {
    assert.fail(`expected query response to validate: ${JSON.stringify(responseResult.errors)}`);
  }

  assert.deepEqual(responseResult.response, response);
  assert.equal(responseResult.value, responseResult.response);

  const deleteEntry = {
    collection: "app.bsky.feed.post",
    cursor: 43,
    op: "delete-record",
    rkey: "p1-067-post",
  };
  const entryResult = validatePdsCommitLogEntry(deleteEntry);

  if (!entryResult.ok) {
    assert.fail(`expected delete commit log entry to validate: ${JSON.stringify(entryResult.errors)}`);
  }

  assert.deepEqual(entryResult.entry, deleteEntry);
  assert.equal(entryResult.value, entryResult.entry);
});

test("PDS query response rejects malformed page shapes fail-closed", () => {
  assert.deepEqual(
    rejectedPaths(
      validatePdsQueryResponse({
        ...validQueryResponse(),
        privateKey: "ref-only",
        unexpected: true,
      }),
    ),
    ["privateKey", "unexpected"],
  );

  assert.deepEqual(
    rejectedPaths(
      validatePdsQueryResponse({
        ...validQueryResponse(),
        collection: "app..bsky/feed.post",
      }),
    ),
    ["collection"],
  );

  assert.deepEqual(
    rejectedPaths(
      validatePdsQueryResponse({
        ...validQueryResponse(),
        nextCursor: Number.MAX_SAFE_INTEGER + 1,
        total: -1,
      }),
    ),
    ["nextCursor", "total"],
  );

  const malformedRecord = mutableQueryResponse();
  malformedRecord.records[0] = {
    collection: "app.bsky.feed.post",
    rkey: "bad/key",
    valueDigest: "not-a-digest",
  };

  assert.deepEqual(
    rejectedPaths(validatePdsQueryResponse(malformedRecord)),
    ["records/0/rkey", "records/0/valueDigest"],
  );
});

test("PDS commit log entries reject unknown operations and malformed records", () => {
  assert.deepEqual(
    rejectedPaths(
      validatePdsCommitLogEntry({
        collection: "app.bsky.feed.post",
        cursor: 43,
        op: "update-record",
        rkey: "p1-067-post",
      }),
    ),
    ["op"],
  );

  assert.deepEqual(
    rejectedPaths(
      validatePdsCommitLogEntry({
        collection: "app..bsky/feed.post",
        cursor: Number.MAX_SAFE_INTEGER + 1,
        op: "delete-record",
        rkey: "bad/key",
      }),
    ),
    ["collection", "cursor", "rkey"],
  );
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
    [validatePdsQueryResponse, cyclic],
    [validatePdsCommitLogEntry, accessor],
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

function validQueryResponse(): PdsQueryResponse {
  return {
    collection: "app.bsky.feed.post",
    exists: true,
    nextCursor: 2,
    records: [
      {
        collection: "app.bsky.feed.post",
        rkey: "p1-067-post",
        valueDigest: DIGEST_A,
      },
      {
        collection: "app.bsky.feed.post",
        rkey: "p1-081-post",
        valueDigest: DIGEST_B,
      },
    ],
    total: 3,
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

function mutableQueryResponse(): MutableQueryResponseInput {
  const response = validQueryResponse();

  return {
    collection: response.collection,
    exists: response.exists,
    nextCursor: response.nextCursor,
    records: response.records.map((record) => ({ ...record })),
    total: response.total,
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
  | PdsCommitLogEntryValidationResult
  | PdsQueryResponseValidationResult
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

interface MutablePdsRepoRecordInput extends Record<string, unknown> {
  collection?: unknown;
  rkey?: unknown;
  valueDigest?: unknown;
}

interface MutableQueryResponseInput extends Record<string, unknown> {
  collection?: unknown;
  exists?: unknown;
  nextCursor?: unknown;
  records: MutablePdsRepoRecordInput[];
  total?: unknown;
}
