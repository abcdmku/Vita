import assert from "node:assert/strict";
import { test } from "node:test";

import { AgentClientError } from "./vita/agent-client.ts";
import { DEFAULT_CAPABILITY_MANIFESTS } from "./vita/generated/capability-manifests.generated.ts";
import {
  applyAndReadPdsRepoCreate,
  buildInvalidPdsRepoDeletePlan,
  buildInvalidPdsRepoCreatePlan,
  buildPdsRepoDeletePlan,
  buildPdsRepoCreateConfig,
  buildPdsRepoQueryRequest,
  deleteAndReadBackPdsRepoRecord,
  formatPdsRepoMarker,
  formatPdsRepoDeleteMarker,
  formatPdsRepoQueryMarkers,
  PDS_REPO_CAPABILITY,
  PDS_REPO_COMMIT_CURSOR,
  PDS_REPO_CREATE_DESIRED,
  PDS_REPO_DELETE_CURSOR,
  PDS_REPO_DELETE_DESIRED,
  PDS_REPO_DELETE_RECORD,
  PDS_REPO_QUERY_COLLECTION,
  PDS_REPO_QUERY_LIMIT,
  PDS_REPO_RECORDS,
  PDS_REPO_TEST_REPO,
  queryPdsRepoCollection,
  rejectInvalidPdsRepoDelete,
  rejectInvalidPdsRepoCreate,
} from "./vita/pds-repo.ts";
import type {
  AgentApplyPlan,
  AgentApplyResult,
  AgentClient,
} from "./vita/agent-client.ts";
import type {
  ApplyNodeApplyResult,
  ApplyNodeTransport,
  ApplyNodeTransportResponse,
} from "./vita/apply-node-config.ts";
import type { CapabilityManifest } from "./vita/capability-manifest.ts";
import type { PdsRepoReadTransport } from "./vita/pds-repo.ts";

const VENDORED_REGISTRY = new Map<string, CapabilityManifest>(
  Object.entries(DEFAULT_CAPABILITY_MANIFESTS),
);

test("pds repo helper builds pds.repo config, posts /apply, reads back measured state, and formats committed marker", async () => {
  const calls: TransportCall[] = [];
  const readCapabilities: string[] = [];
  const client: Pick<AgentClient, "getState"> = {
    getState: async (capability) => {
      readCapabilities[readCapabilities.length] = capability;
      return {
        commitCursor: 99,
        exists: true,
        log: [
          {
            collection: "app.bsky.actor.profile",
            cursor: 99,
            op: "create-record",
            rkey: "self",
          },
          {
            collection: "app.bsky.feed.post",
            cursor: 99,
            op: "create-record",
            rkey: "p1-067-post",
          },
          {
            collection: "app.bsky.feed.post",
            cursor: 99,
            op: "create-record",
            rkey: "readback-extra",
          },
        ],
        records: [
          {
            collection: "app.bsky.actor.profile",
            rkey: "self",
            valueDigest: "2222222222222222222222222222222222222222222222222222222222222222",
          },
          {
            collection: "app.bsky.feed.post",
            rkey: "p1-067-post",
            valueDigest: "1111111111111111111111111111111111111111111111111111111111111111",
          },
          {
            collection: "app.bsky.feed.post",
            rkey: "readback-extra",
            valueDigest: "3333333333333333333333333333333333333333333333333333333333333333",
          },
        ],
        repo: PDS_REPO_TEST_REPO,
      };
    },
  };

  const result = await applyAndReadPdsRepoCreate(
    VENDORED_REGISTRY,
    fakeTransport({ body: committedResult(), status: 200 }, calls),
    client,
  );

  assert.deepEqual(buildPdsRepoCreateConfig(), {
    "pds.repo": {
      desired: PDS_REPO_CREATE_DESIRED,
    },
  });
  assert.deepEqual(calls, [
    {
      body: {
        operations: [
          {
            capability: PDS_REPO_CAPABILITY,
            request: {
              desired: {
                commit: {
                  cursor: PDS_REPO_COMMIT_CURSOR,
                },
                records: PDS_REPO_RECORDS,
                repo: PDS_REPO_TEST_REPO,
              },
            },
          },
        ],
      },
      method: "POST",
      path: "/apply",
    },
  ]);
  assert.deepEqual(readCapabilities, [PDS_REPO_CAPABILITY]);
  assert.equal(
    formatPdsRepoMarker(result),
    "VITA-PDS-REPO: records=3 committed cursor=99 status=OK",
  );
});

test("pds repo query helper sends exact read body and formats measured page markers", async () => {
  const calls: ReadCall[] = [];
  const result = await queryPdsRepoCollection(
    fakeReadTransport([
      {
        body: {
          collection: PDS_REPO_QUERY_COLLECTION,
          exists: true,
          nextCursor: 2,
          records: [
            {
              collection: PDS_REPO_QUERY_COLLECTION,
              rkey: "aaa",
              valueDigest: "1111111111111111111111111111111111111111111111111111111111111111",
            },
            {
              collection: PDS_REPO_QUERY_COLLECTION,
              rkey: "bbb",
              valueDigest: "2222222222222222222222222222222222222222222222222222222222222222",
            },
          ],
          total: 3,
        },
        status: 200,
      },
      {
        body: {
          collection: PDS_REPO_QUERY_COLLECTION,
          exists: true,
          nextCursor: null,
          records: [
            {
              collection: PDS_REPO_QUERY_COLLECTION,
              rkey: "ccc",
              valueDigest: "3333333333333333333333333333333333333333333333333333333333333333",
            },
          ],
          total: 3,
        },
        status: 200,
      },
    ], calls),
  );

  assert.deepEqual(buildPdsRepoQueryRequest(), {
    capability: PDS_REPO_CAPABILITY,
    request: {
      query: {
        collection: PDS_REPO_QUERY_COLLECTION,
        limit: PDS_REPO_QUERY_LIMIT,
      },
    },
  });
  assert.deepEqual(calls, [
    {
      body: {
        capability: PDS_REPO_CAPABILITY,
        request: {
          query: {
            collection: PDS_REPO_QUERY_COLLECTION,
            limit: PDS_REPO_QUERY_LIMIT,
          },
        },
      },
      method: "GET",
      path: "/state",
    },
    {
      body: {
        capability: PDS_REPO_CAPABILITY,
        request: {
          query: {
            collection: PDS_REPO_QUERY_COLLECTION,
            cursor: 2,
            limit: PDS_REPO_QUERY_LIMIT,
          },
        },
      },
      method: "GET",
      path: "/state",
    },
  ]);
  assert.deepEqual(formatPdsRepoQueryMarkers(result), [
    `VITA-PDS-QUERY: collection=${PDS_REPO_QUERY_COLLECTION} page=1 records=2 status=OK`,
    `VITA-PDS-QUERY: collection=${PDS_REPO_QUERY_COLLECTION} page=2 records=1 status=OK`,
  ]);
});

test("pds repo delete helper sends exact apply body and proves removal via read-back", async () => {
  const plans: AgentApplyPlan[] = [];
  const client: Pick<AgentClient, "apply" | "getState"> = {
    apply: async (plan) => {
      plans[plans.length] = plan;
      return committedAgentResult();
    },
    getState: async (capability) => {
      assert.equal(capability, PDS_REPO_CAPABILITY);
      return {
        commitCursor: PDS_REPO_DELETE_CURSOR,
        exists: true,
        log: [
          {
            collection: "app.bsky.actor.profile",
            cursor: PDS_REPO_COMMIT_CURSOR,
            op: "create-record",
            rkey: "self",
          },
          {
            collection: PDS_REPO_QUERY_COLLECTION,
            cursor: PDS_REPO_COMMIT_CURSOR,
            op: "create-record",
            rkey: PDS_REPO_DELETE_RECORD.rkey,
          },
          {
            collection: PDS_REPO_QUERY_COLLECTION,
            cursor: PDS_REPO_DELETE_CURSOR,
            op: "delete-record",
            rkey: PDS_REPO_DELETE_RECORD.rkey,
          },
        ],
        records: [
          {
            collection: "app.bsky.actor.profile",
            rkey: "self",
            valueDigest: "2222222222222222222222222222222222222222222222222222222222222222",
          },
        ],
        repo: PDS_REPO_TEST_REPO,
      };
    },
  };

  const result = await deleteAndReadBackPdsRepoRecord(client);

  assert.deepEqual(buildPdsRepoDeletePlan(), {
    operations: [
      {
        capability: PDS_REPO_CAPABILITY,
        request: {
          desired: PDS_REPO_DELETE_DESIRED,
        },
      },
    ],
  });
  assert.deepEqual(plans, [buildPdsRepoDeletePlan()]);
  assert.equal(
    formatPdsRepoDeleteMarker(result),
    `VITA-PDS-DELETE: removed=${PDS_REPO_DELETE_RECORD.rkey} tombstone cursor=${PDS_REPO_DELETE_CURSOR} status=OK`,
  );
});

test("forced invalid pds.repo is sent to agentd and formats fail-closed rejection", async () => {
  const plans: AgentApplyPlan[] = [];
  const client: Pick<AgentClient, "apply"> = {
    apply: async (plan) => {
      plans[plans.length] = plan;
      return {
        applied: [],
        error: {
          capability: PDS_REPO_CAPABILITY,
          code: "invalid_request",
          index: 0,
          message: "commit cursor must not regress",
        },
        outcome: "rolledBack",
        rollbackErrors: [],
        rolledBack: [],
      } satisfies AgentApplyResult;
    },
  };

  const result = await rejectInvalidPdsRepoCreate(client);

  assert.deepEqual(plans, [buildInvalidPdsRepoCreatePlan()]);
  assert.deepEqual(plans[0], {
    operations: [
      {
        capability: PDS_REPO_CAPABILITY,
        request: {
          desired: {
            commit: {
              cursor: PDS_REPO_COMMIT_CURSOR - 1,
            },
            records: PDS_REPO_RECORDS,
            repo: PDS_REPO_TEST_REPO,
          },
        },
      },
    ],
  });
  assert.equal(
    formatPdsRepoMarker(result),
    "VITA-PDS-REPO: outcome=rejected reason=invalid_request status=OK",
  );
});

test("forced invalid pds.repo delete is sent to agentd and formats fail-closed rejection", async () => {
  const plans: AgentApplyPlan[] = [];
  const client: Pick<AgentClient, "apply"> = {
    apply: async (plan) => {
      plans[plans.length] = plan;
      return {
        applied: [],
        error: {
          capability: PDS_REPO_CAPABILITY,
          code: "invalid_request",
          index: 0,
          message: "cannot delete a non-existent record",
        },
        outcome: "rolledBack",
        rollbackErrors: [],
        rolledBack: [],
      } satisfies AgentApplyResult;
    },
  };

  const result = await rejectInvalidPdsRepoDelete(client);

  assert.deepEqual(plans, [buildInvalidPdsRepoDeletePlan()]);
  assert.deepEqual(plans[0], {
    operations: [
      {
        capability: PDS_REPO_CAPABILITY,
        request: {
          desired: {
            commit: {
              cursor: PDS_REPO_DELETE_CURSOR + 1,
            },
            deletes: [
              {
                collection: PDS_REPO_QUERY_COLLECTION,
                rkey: "missing-p1-081-delete",
              },
            ],
            records: [],
            repo: PDS_REPO_TEST_REPO,
          },
        },
      },
    ],
  });
  assert.equal(
    formatPdsRepoDeleteMarker(result),
    "VITA-PDS-DELETE: outcome=rejected reason=invalid_request status=OK",
  );
});

test("forced invalid pds.repo formats a 4xx agent rejection with sanitized reason token", async () => {
  const client: Pick<AgentClient, "apply"> = {
    apply: async () => {
      throw new AgentClientError("AGENT_ERROR", "Agent rejected invalid PDS repo.", {
        agentError: {
          code: "invalid request",
          message: "bad repo request",
        },
        status: 400,
      });
    },
  };

  const result = await rejectInvalidPdsRepoCreate(client);

  assert.equal(
    formatPdsRepoMarker(result),
    "VITA-PDS-REPO: outcome=rejected reason=invalid_request status=OK",
  );
});

test("pds repo helpers emit failsafe markers on transport and read errors", async () => {
  const client: Pick<AgentClient, "getState"> = {
    getState: async () => {
      throw new Error("read should not be attempted after apply transport failure");
    },
  };
  const transportResult = await applyAndReadPdsRepoCreate(VENDORED_REGISTRY, async () => {
    throw new Error("socket unavailable");
  }, client);

  assert.equal(
    formatPdsRepoMarker(transportResult),
    "VITA-PDS-REPO-ERROR: status=FAILSAFE",
  );

  const readFailureClient: Pick<AgentClient, "getState"> = {
    getState: async () => {
      throw new Error("read unavailable");
    },
  };
  const readResult = await applyAndReadPdsRepoCreate(
    VENDORED_REGISTRY,
    fakeTransport({ body: committedResult(), status: 200 }),
    readFailureClient,
  );

  assert.equal(
    formatPdsRepoMarker(readResult),
    "VITA-PDS-REPO-ERROR: status=FAILSAFE",
  );

  const queryResult = await queryPdsRepoCollection(async () => {
    throw new Error("read unavailable");
  });
  assert.deepEqual(
    formatPdsRepoQueryMarkers(queryResult),
    ["VITA-PDS-QUERY-ERROR: status=FAILSAFE"],
  );

  const deleteApplyFailureClient: Pick<AgentClient, "apply" | "getState"> = {
    apply: async () => {
      throw new Error("apply unavailable");
    },
    getState: async () => {
      throw new Error("read should not be attempted after delete apply failure");
    },
  };
  assert.equal(
    formatPdsRepoDeleteMarker(await deleteAndReadBackPdsRepoRecord(deleteApplyFailureClient)),
    "VITA-PDS-DELETE-ERROR: status=FAILSAFE",
  );

  const deleteReadFailureClient: Pick<AgentClient, "apply" | "getState"> = {
    apply: async () => committedAgentResult(),
    getState: async () => {
      throw new Error("read unavailable");
    },
  };
  assert.equal(
    formatPdsRepoDeleteMarker(await deleteAndReadBackPdsRepoRecord(deleteReadFailureClient)),
    "VITA-PDS-DELETE-ERROR: status=FAILSAFE",
  );
});

interface TransportCall {
  readonly method: Parameters<ApplyNodeTransport>[0];
  readonly path: Parameters<ApplyNodeTransport>[1];
  readonly body: Parameters<ApplyNodeTransport>[2];
}

interface ReadCall {
  readonly method: Parameters<PdsRepoReadTransport>[0];
  readonly path: Parameters<PdsRepoReadTransport>[1];
  readonly body: Parameters<PdsRepoReadTransport>[2];
}

function fakeTransport(
  response: ApplyNodeTransportResponse,
  calls: TransportCall[] = [],
): ApplyNodeTransport {
  return async (method, path, body) => {
    calls[calls.length] = {
      body,
      method,
      path,
    };

    return response;
  };
}

function fakeReadTransport(
  responses: readonly ApplyNodeTransportResponse[],
  calls: ReadCall[] = [],
): PdsRepoReadTransport {
  let index = 0;

  return async (method, path, body) => {
    calls[calls.length] = {
      body,
      method,
      path,
    };

    const response = responses[index];
    index += 1;

    if (response === undefined) {
      throw new Error("unexpected extra PDS repo read");
    }

    return response;
  };
}

function committedResult(): ApplyNodeApplyResult {
  return {
    applied: [
      {
        capability: PDS_REPO_CAPABILITY,
        index: 0,
      },
    ],
    outcome: "committed",
    rollbackErrors: [],
    rolledBack: [],
  };
}

function committedAgentResult(): AgentApplyResult {
  return {
    applied: [
      {
        capability: PDS_REPO_CAPABILITY,
        index: 0,
      },
    ],
    outcome: "committed",
    rollbackErrors: [],
    rolledBack: [],
  };
}
