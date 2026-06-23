import assert from "node:assert/strict";
import { test } from "node:test";

import { AgentClientError } from "./vita/agent-client.ts";
import { DEFAULT_CAPABILITY_MANIFESTS } from "./vita/generated/capability-manifests.generated.ts";
import {
  applyPdsSyncStateWrite,
  buildInvalidPdsSyncStateWritePlan,
  buildPdsSyncStateWriteConfig,
  formatPdsSyncStateWriteMarker,
  PDS_SYNC_STATE_CAPABILITY,
  PDS_SYNC_STATE_WRITE_CURSOR,
  PDS_SYNC_STATE_WRITE_DESIRED,
  PDS_SYNC_STATE_WRITE_REPO,
  PDS_SYNC_STATE_WRITE_REPO_HEAD,
  rejectInvalidPdsSyncStateWrite,
} from "./vita/pds-write.ts";
import type {
  AgentApplyPlan,
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

test("pds write helper builds pds.sync-state config, posts /apply, and formats committed marker fields", async () => {
  const calls: TransportCall[] = [];

  const result = await applyPdsSyncStateWrite(
    VENDORED_REGISTRY,
    fakeTransport({ body: committedResult(), status: 200 }, calls),
  );

  assert.deepEqual(buildPdsSyncStateWriteConfig(), {
    "pds.sync-state": {
      desired: PDS_SYNC_STATE_WRITE_DESIRED,
    },
  });
  assert.deepEqual(calls, [
    {
      body: {
        operations: [
          {
            capability: PDS_SYNC_STATE_CAPABILITY,
            request: {
              desired: {
                cursor: PDS_SYNC_STATE_WRITE_CURSOR,
                repo: PDS_SYNC_STATE_WRITE_REPO,
                repoHead: PDS_SYNC_STATE_WRITE_REPO_HEAD,
              },
            },
          },
        ],
      },
      method: "POST",
      path: "/apply",
    },
  ]);
  assert.equal(
    formatPdsSyncStateWriteMarker(result),
    `VITA-PDS-WRITE: outcome=committed repo=${PDS_SYNC_STATE_WRITE_REPO} cursor=${PDS_SYNC_STATE_WRITE_CURSOR} status=OK`,
  );
});

test("pds write helper formats an agent-side rejected apply outcome as fail-closed VITA-PDS-WRITE", async () => {
  const result = await applyPdsSyncStateWrite(
    VENDORED_REGISTRY,
    fakeTransport({ body: rejectedResult(), status: 200 }),
  );

  assert.equal(
    formatPdsSyncStateWriteMarker(result),
    "VITA-PDS-WRITE: outcome=rejected reason=invalid_request status=OK",
  );
});

test("forced invalid pds.sync-state is sent to agentd and formats a 4xx agent rejection", async () => {
  const plans: AgentApplyPlan[] = [];
  const client: Pick<AgentClient, "apply"> = {
    apply: async (plan) => {
      plans.push(plan);
      throw new AgentClientError("AGENT_ERROR", "Agent rejected invalid PDS sync-state.", {
        agentError: {
          code: "invalid_request",
          message: "cursor must be non-negative",
        },
        status: 400,
      });
    },
  };

  const result = await rejectInvalidPdsSyncStateWrite(client);

  assert.deepEqual(plans, [buildInvalidPdsSyncStateWritePlan()]);
  assert.deepEqual(plans[0], {
    operations: [
      {
        capability: PDS_SYNC_STATE_CAPABILITY,
        request: {
          desired: {
            cursor: -1,
            repo: PDS_SYNC_STATE_WRITE_REPO,
            repoHead: PDS_SYNC_STATE_WRITE_REPO_HEAD,
          },
        },
      },
    ],
  });
  assert.equal(
    formatPdsSyncStateWriteMarker(result),
    "VITA-PDS-WRITE: outcome=rejected reason=invalid_request status=OK",
  );
});

test("pds write helper emits failsafe marker on transport errors", async () => {
  let calls = 0;
  const result = await applyPdsSyncStateWrite(VENDORED_REGISTRY, async () => {
    calls += 1;
    throw new Error("socket unavailable");
  });

  assert.equal(calls, 1);
  assert.equal(
    formatPdsSyncStateWriteMarker(result),
    "VITA-PDS-WRITE-ERROR: status=FAILSAFE",
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
        capability: PDS_SYNC_STATE_CAPABILITY,
        index: 0,
      },
    ],
    outcome: "committed",
    rollbackErrors: [],
    rolledBack: [],
  };
}

function rejectedResult(): ApplyNodeApplyResult {
  return {
    applied: [],
    error: {
      capability: PDS_SYNC_STATE_CAPABILITY,
      code: "invalid_request",
      index: 0,
      message: "agentd rejected the invalid PDS sync-state",
    },
    outcome: "rejected",
    rollbackErrors: [],
    rolledBack: [],
  };
}
