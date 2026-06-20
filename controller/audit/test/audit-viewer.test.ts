import assert from "node:assert/strict";
import { test } from "node:test";

import { summarizeAuditLog } from "../src/audit-viewer.ts";
import type {
  AuditLogSummaryRejection,
  AuditLogSummaryResult,
} from "../src/audit-viewer.ts";
import type { AuditEvent } from "../../../sdk/typescript/src/audit-event-model.ts";

test("valid monotonic log summarizes totals and integrity", () => {
  const events: readonly AuditEvent[] = [
    event({ actorKind: "human", outcome: "committed", sequence: 1 }),
    event({ actorKind: "agent", outcome: "rejected", sequence: 2 }),
    event({ actorKind: "system", outcome: "rolled_back", sequence: 3 }),
    event({ actorKind: "human", outcome: "failed", sequence: 4 }),
  ];
  const summary = assertSummary(summarizeAuditLog(events));

  assert.equal(summary.monotonic, true);
  assert.deepEqual(summary.totalsByOutcome, {
    committed: 1,
    failed: 1,
    rejected: 1,
    rolled_back: 1,
  });
  assert.deepEqual(summary.totalsByActor, {
    agent: 1,
    human: 2,
    system: 1,
  });
  assert.deepEqual(
    summary.recentFailures.map((failure) => failure.sequence),
    [4, 3],
  );
});

test("repeated or decreasing sequences report non-monotonic without reordering", () => {
  const events: readonly AuditEvent[] = [
    event({ outcome: "failed", sequence: 2 }),
    event({ outcome: "rolled_back", sequence: 1 }),
    event({ outcome: "committed", sequence: 1 }),
  ];
  const summary = assertSummary(summarizeAuditLog(events));

  assert.equal(summary.monotonic, false);
  assert.deepEqual(
    summary.recentFailures.map((failure) => failure.sequence),
    [1, 2],
  );
});

test("recent failures are failed or rolled_back events most-recent-first bounded to N", () => {
  const events: readonly AuditEvent[] = [
    event({ outcome: "failed", sequence: 1 }),
    event({ outcome: "committed", sequence: 2 }),
    event({ outcome: "rolled_back", sequence: 3 }),
    event({ outcome: "rejected", sequence: 4 }),
    event({ outcome: "failed", sequence: 5 }),
    event({ outcome: "rolled_back", sequence: 6 }),
  ];
  const summary = assertSummary(summarizeAuditLog(events, 2));

  assert.deepEqual(
    summary.recentFailures.map((failure) => failure.sequence),
    [6, 5],
  );
});

test("any invalid audit event returns typed rejections and no summary", () => {
  const invalidEvent = mutableEvent({ sequence: 2 });
  delete invalidEvent.actor;
  invalidEvent.outcome = "succeeded";

  let result: AuditLogSummaryResult | undefined;

  assert.doesNotThrow(() => {
    result = summarizeAuditLog([
      event({ sequence: 1 }),
      invalidEvent,
      event({ sequence: 3 }),
    ]);
  });

  if (result === undefined || result.ok) {
    assert.fail(`expected audit summary rejection: ${JSON.stringify(result)}`);
  }

  assert.deepEqual(rejectionCodes(result.rejections), ["INVALID_AUDIT_EVENT"]);
  assert.deepEqual(rejectionPaths(result.rejections), [
    "events/1/actor",
    "events/1/outcome",
  ]);
});

test("hostile audit log input fails closed without invoking attacker-controlled behavior", () => {
  const accessorEvents: unknown[] = [event({ sequence: 1 })];
  let getterReads = 0;

  Object.defineProperty(accessorEvents, "0", {
    enumerable: true,
    get() {
      getterReads += 1;
      assert.fail("array accessor must not be invoked");
    },
  });

  const methodShadowedEvents: unknown[] = [event({ sequence: 1 })];
  Object.defineProperty(methodShadowedEvents, "map", {
    enumerable: true,
    value() {
      assert.fail("shadowed array methods must not be invoked");
    },
  });

  const cyclic: Record<string, unknown> = {};
  cyclic["self"] = cyclic;

  assertRejected(summarizeAuditLog(accessorEvents), ["INVALID_AUDIT_EVENT"]);
  assertRejected(summarizeAuditLog(methodShadowedEvents), ["INVALID_AUDIT_LOG"]);
  assertRejected(summarizeAuditLog(cyclic), ["INVALID_AUDIT_LOG"]);
  assert.equal(getterReads, 0);
});

test("invalid recent failure limit is a typed rejection", () => {
  const result = summarizeAuditLog([event({ sequence: 1 })], {
    recentFailureLimit: -1,
  });

  assertRejected(result, ["INVALID_RECENT_FAILURE_LIMIT"]);
});

function event(
  overrides: {
    readonly actorKind?: AuditEvent["actor"]["kind"];
    readonly outcome?: AuditEvent["outcome"];
    readonly sequence?: number;
  } = {},
): AuditEvent {
  return {
    actor: {
      id: `${overrides.actorKind ?? "agent"}:fixture`,
      kind: overrides.actorKind ?? "agent",
    },
    capability: "system.hostname",
    operation: "apply",
    outcome: overrides.outcome ?? "committed",
    reason: "fixture event",
    sequence: overrides.sequence ?? 1,
    timestampMillis: 1_717_171_717_000 + (overrides.sequence ?? 1),
  };
}

function mutableEvent(
  overrides: {
    readonly actorKind?: AuditEvent["actor"]["kind"];
    readonly outcome?: AuditEvent["outcome"];
    readonly sequence?: number;
  } = {},
): MutableAuditEvent {
  const base = event(overrides);

  return {
    actor: {
      id: base.actor.id,
      kind: base.actor.kind,
    },
    capability: base.capability,
    operation: base.operation,
    outcome: base.outcome,
    ...(base.reason === undefined ? {} : { reason: base.reason }),
    sequence: base.sequence,
    timestampMillis: base.timestampMillis,
  };
}

function assertSummary(
  result: AuditLogSummaryResult,
): Extract<AuditLogSummaryResult, { readonly ok: true }> {
  if (!result.ok) {
    assert.fail(`expected audit summary: ${JSON.stringify(result.rejections)}`);
  }

  return result;
}

function assertRejected(
  result: AuditLogSummaryResult,
  expectedCodes: readonly AuditLogSummaryRejection["code"][],
): void {
  if (result.ok) {
    assert.fail(`expected audit summary rejection: ${JSON.stringify(result)}`);
  }

  assert.deepEqual(rejectionCodes(result.rejections), expectedCodes);
  assert.equal(result.rejections.length > 0, true);
}

function rejectionCodes(
  rejections: readonly AuditLogSummaryRejection[],
): readonly AuditLogSummaryRejection["code"][] {
  return Array.from(new Set(rejections.map((rejection) => rejection.code))).sort();
}

function rejectionPaths(
  rejections: readonly AuditLogSummaryRejection[],
): readonly string[] {
  return rejections.map((rejection) => rejection.path).sort();
}

interface MutableAuditActorRef extends Record<string, unknown> {
  id?: string;
  kind?: AuditEvent["actor"]["kind"];
}

interface MutableAuditEvent extends Record<string, unknown> {
  actor?: MutableAuditActorRef;
  capability?: string;
  operation?: AuditEvent["operation"];
  outcome?: AuditEvent["outcome"] | "succeeded";
  reason?: string;
  sequence?: number;
  timestampMillis?: number;
}
