import assert from "node:assert/strict";
import { test } from "node:test";

import {
  BACKUP_ARCHIVE_CAPABILITY,
  formatBackupArchiveMarker,
  runBackupArchiveRoundTrip,
} from "./vita/backup.ts";
import type {
  AgentApplyPlan,
  AgentApplyResult,
  AgentCapabilityState,
  AgentClient,
} from "./vita/agent-client.ts";

const BACKUP_ID = `sha256:${"B".repeat(43)}`;

test("backup archive round-trip restore relies on manifest-backed agent verification", async () => {
  const plans: AgentApplyPlan[] = [];
  const states: AgentCapabilityState[] = [
    backupState({
      backupId: BACKUP_ID,
      created: true,
      files: 2,
      op: "create",
      restored: false,
      verified: false,
    }),
    backupState({
      backupId: BACKUP_ID,
      created: false,
      files: 2,
      op: "verify",
      restored: false,
      verified: true,
    }),
    backupState({
      backupId: BACKUP_ID,
      created: false,
      files: 2,
      op: "restore",
      restored: true,
      verified: true,
    }),
  ];
  const client: Pick<AgentClient, "apply" | "getState"> = {
    apply: async (plan) => {
      plans.push(plan);
      return committedResult();
    },
    getState: async (capability) => {
      assert.equal(capability, BACKUP_ARCHIVE_CAPABILITY);
      const state = states.shift();
      if (state === undefined) {
        assert.fail("unexpected backup state read");
      }
      return state;
    },
  };

  const result = await runBackupArchiveRoundTrip(client);

  assert.deepEqual(result, {
    backupId: BACKUP_ID,
    files: 2,
    ok: true,
  });
  assert.equal(
    formatBackupArchiveMarker(result),
    "VITA-BACKUP: created=OK restored=OK verified=OK id=sha256_BBBBBBBBBBB files=2 status=OK",
  );
  assert.equal(plans.length, 3);
  const restore = onlyOperation(plans[2]);
  assert.deepEqual(restore, {
    capability: BACKUP_ARCHIVE_CAPABILITY,
    request: {
      op: "restore",
      restore: {
        backupId: BACKUP_ID,
        destinationRoot: "/var/lib/vita-backup-restore/sha256_BBBBBBBBBBB",
        targetPath: "/var/lib/vita-backups",
      },
    },
  });
});

function backupState(last: {
  readonly backupId: string;
  readonly created: boolean;
  readonly files: number;
  readonly op: "create" | "verify" | "restore";
  readonly restored: boolean;
  readonly verified: boolean;
}): AgentCapabilityState {
  return {
    last: {
      ...last,
      status: "OK",
    },
  };
}

function committedResult(): AgentApplyResult {
  return {
    applied: [
      {
        capability: BACKUP_ARCHIVE_CAPABILITY,
        index: 0,
      },
    ],
    outcome: "committed",
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
