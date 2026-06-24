import assert from "node:assert/strict";
import { test } from "node:test";

import { AgentClientError } from "./vita/agent-client.ts";
import { DEFAULT_CAPABILITY_MANIFESTS } from "./vita/generated/capability-manifests.generated.ts";
import {
  applyAndReadPdsRepoCreate,
  buildInvalidPdsRepoCreatePlan,
  buildPdsRepoCreateConfig,
  formatPdsRepoMarker,
  PDS_REPO_CAPABILITY,
  PDS_REPO_COMMIT_CURSOR,
  PDS_REPO_CREATE_DESIRED,
  PDS_REPO_RECORDS,
  PDS_REPO_TEST_REPO,
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

test("pds repo helper emits failsafe marker on transport and read errors", async () => {
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
});

interface TransportCall {
  readonly method: Parameters<ApplyNodeTransport>[0];
  readonly path: Parameters<ApplyNodeTransport>[1];
  readonly body: Parameters<ApplyNodeTransport>[2];
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
