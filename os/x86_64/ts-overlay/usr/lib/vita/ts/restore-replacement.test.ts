import assert from "node:assert/strict";
import { test } from "node:test";

import {
  formatRestoreReplacementMarker,
  formatRestoreReplacementRejectMarker,
  rejectTamperedRestoreReplacement,
  RESTORE_REPLACEMENT_CAPABILITY,
  runRestoreReplacement,
} from "./vita/restore-replacement.ts";
import type {
  AgentApplyPlan,
  AgentApplyResult,
  AgentCapabilityState,
  AgentClient,
} from "./vita/agent-client.ts";

const BACKUP_ID = `sha256:${"C".repeat(43)}`;

test("replacement restore marker is gated on committed restore and measured verified roots", async () => {
  const plans: AgentApplyPlan[] = [];
  const client: Pick<AgentClient, "apply" | "getState"> = {
    apply: async (plan) => {
      plans.push(plan);
      return committedResult();
    },
    getState: async (capability) => {
      assert.equal(capability, RESTORE_REPLACEMENT_CAPABILITY);
      return restoreState({
        backupId: BACKUP_ID,
        files: 4,
        from: "node-a.example",
        rootsVerified: true,
        to: "node-b.example",
        verified: true,
      });
    },
  };

  const result = await runRestoreReplacement(client, {
    backupSource: "/external/node-a-backup",
    expectFrom: "node-a.example",
  });

  assert.deepEqual(result, {
    backupId: BACKUP_ID,
    files: 4,
    from: "node-a.example",
    ok: true,
    to: "node-b.example",
  });
  assert.equal(
    formatRestoreReplacementMarker(result),
    "VITA-RESTORE-REPLACEMENT: from=node-a.example to=node-b.example restored=OK verified=OK files=4 id=sha256_CCCCCCCCCCC status=OK",
  );
  assert.equal(plans.length, 1);
  assert.deepEqual(onlyOperation(plans[0]), {
    capability: RESTORE_REPLACEMENT_CAPABILITY,
    request: {
      op: "replace",
      replace: {
        backupSource: "/external/node-a-backup",
        expectFrom: "node-a.example",
      },
    },
  });
});

test("replacement restore refuses to print success when root verification is not measured", async () => {
  const client: Pick<AgentClient, "apply" | "getState"> = {
    apply: async () => committedResult(),
    getState: async () =>
      restoreState({
        backupId: BACKUP_ID,
        files: 4,
        from: "node-a.example",
        rootsVerified: false,
        to: "node-b.example",
        verified: true,
      }),
  };

  const result = await runRestoreReplacement(client, { backupSource: "/external/node-a-backup" });

  assert.deepEqual(result, {
    ok: false,
    reason: "replace_not_measured",
  });
  assert.equal(
    formatRestoreReplacementMarker(result),
    "VITA-RESTORE-REPLACEMENT-ERROR: reason=replace_not_measured status=FAILSAFE",
  );
});

test("replacement restore tampered reject requires a measured digest mismatch", async () => {
  const plans: AgentApplyPlan[] = [];
  const client: Pick<AgentClient, "apply"> = {
    apply: async (plan) => {
      plans.push(plan);
      return rolledBackResult("verify_digest_mismatch");
    },
  };

  const result = await rejectTamperedRestoreReplacement(client, {
    tamperedBackupSource: "/external/node-a-backup-tampered",
  });

  assert.deepEqual(result, {
    ok: true,
    reason: "verify_digest_mismatch",
  });
  assert.equal(
    formatRestoreReplacementRejectMarker(result),
    "VITA-RESTORE-REPLACEMENT-REJECT: reason=verify_digest_mismatch status=OK",
  );
  assert.deepEqual(onlyOperation(plans[0]), {
    capability: RESTORE_REPLACEMENT_CAPABILITY,
    request: {
      op: "replace",
      replace: {
        backupSource: "/external/node-a-backup-tampered",
      },
    },
  });
});

test("replacement restore tampered reject does not accept an unrelated rejection", async () => {
  const client: Pick<AgentClient, "apply"> = {
    apply: async () => rolledBackResult("from_mismatch"),
  };

  const result = await rejectTamperedRestoreReplacement(client, {
    tamperedBackupSource: "/external/node-a-backup-tampered",
  });

  assert.deepEqual(result, {
    ok: false,
    reason: "tamper_not_measured_from_mismatch",
  });
  assert.equal(
    formatRestoreReplacementRejectMarker(result),
    "VITA-RESTORE-REPLACEMENT-ERROR: reason=tamper_not_measured_from_mismatch status=FAILSAFE",
  );
});

test("replacement restore transport failure reports failsafe error", async () => {
  const client: Pick<AgentClient, "apply" | "getState"> = {
    apply: async () => {
      throw new Error("socket unavailable");
    },
    getState: async () => {
      assert.fail("state must not be read after transport failure");
    },
  };

  const result = await runRestoreReplacement(client, { backupSource: "/external/node-a-backup" });

  assert.deepEqual(result, {
    ok: false,
    reason: "replace_transport_failed",
  });
  assert.equal(
    formatRestoreReplacementMarker(result),
    "VITA-RESTORE-REPLACEMENT-ERROR: reason=replace_transport_failed status=FAILSAFE",
  );
});

function restoreState(input: {
  readonly backupId: string;
  readonly files: number;
  readonly from: string;
  readonly rootsVerified: boolean;
  readonly to: string;
  readonly verified: boolean;
}): AgentCapabilityState {
  return {
    last: {
      backupId: input.backupId,
      files: input.files,
      from: input.from,
      op: "replace",
      restored: true,
      roots: [
        {
          backupRoot: "capsule-volumes",
          destinationRoot: "/var/lib/vita/runtime/volumes",
          files: 1,
          name: "capsule-volumes",
          restored: input.rootsVerified,
          verified: input.rootsVerified,
        },
        {
          backupRoot: "vita-agent",
          destinationRoot: "/var/lib/vita-agent",
          files: 3,
          name: "vita-agent",
          restored: input.rootsVerified,
          verified: input.rootsVerified,
        },
      ],
      status: "OK",
      to: input.to,
      verified: input.verified,
    },
  };
}

function committedResult(): AgentApplyResult {
  return {
    applied: [
      {
        capability: RESTORE_REPLACEMENT_CAPABILITY,
        index: 0,
      },
    ],
    outcome: "committed",
    rollbackErrors: [],
    rolledBack: [],
  };
}

function rolledBackResult(code: string): AgentApplyResult {
  return {
    applied: [],
    error: {
      capability: RESTORE_REPLACEMENT_CAPABILITY,
      code,
      index: 0,
      message: code,
    },
    outcome: "rolledBack",
    rollbackErrors: [],
    rolledBack: [],
  };
}

function onlyOperation(plan: AgentApplyPlan | undefined): AgentApplyPlan["operations"][number] {
  if (plan === undefined) {
    assert.fail("missing apply plan");
  }
  assert.equal(plan.operations.length, 1);
  const operation = plan.operations[0];
  if (operation === undefined) {
    assert.fail("missing apply operation");
  }
  return operation;
}
