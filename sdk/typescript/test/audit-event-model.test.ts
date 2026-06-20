import assert from "node:assert/strict";
import { test } from "node:test";

import { isMonotonic, validateAuditEvent } from "../src/audit-event-model.ts";
import type {
  AuditEvent,
  AuditEventValidationResult,
  ValidationError,
} from "../src/audit-event-model.ts";

test("a valid audit event validates", () => {
  const event = validEvent();
  const result = validateAuditEvent(event);

  if (!result.ok) {
    assert.fail(`expected audit event to validate: ${JSON.stringify(result.errors)}`);
  }

  assert.deepEqual(result.event, event);
  assert.equal(result.value, result.event);
});

test("negative and non-integer sequence or timestamp are rejected", () => {
  const cases: readonly {
    readonly field: "sequence" | "timestampMillis";
    readonly value: number;
  }[] = [
    { field: "sequence", value: -1 },
    { field: "sequence", value: 1.5 },
    { field: "timestampMillis", value: -1 },
    { field: "timestampMillis", value: 1.5 },
  ];

  for (let index = 0; index < cases.length; index += 1) {
    const testCase = cases[index];

    if (testCase === undefined) {
      assert.fail("expected test case");
    }

    const event = mutableEvent();
    event[testCase.field] = testCase.value;

    assert.deepEqual(rejectedPaths(validateAuditEvent(event)), [testCase.field]);
  }

  const infiniteTimestamp = mutableEvent();
  infiniteTimestamp.timestampMillis = Number.POSITIVE_INFINITY;
  assertRejected(infiniteTimestamp);
});

test("invalid actor kind and empty actor id are rejected", () => {
  const invalidKind = mutableEvent();

  if (invalidKind.actor === undefined) {
    assert.fail("expected actor fixture");
  }

  invalidKind.actor.kind = "service";

  assert.deepEqual(rejectedPaths(validateAuditEvent(invalidKind)), ["actor/kind"]);

  const emptyId = mutableEvent();

  if (emptyId.actor === undefined) {
    assert.fail("expected actor fixture");
  }

  emptyId.actor.id = "";

  assert.deepEqual(rejectedPaths(validateAuditEvent(emptyId)), ["actor/id"]);
});

test("operation and outcome are closed sets", () => {
  const invalidOperation = mutableEvent();
  invalidOperation.operation = "delete";

  assert.deepEqual(rejectedPaths(validateAuditEvent(invalidOperation)), ["operation"]);

  const invalidOutcome = mutableEvent();
  invalidOutcome.outcome = "succeeded";

  assert.deepEqual(rejectedPaths(validateAuditEvent(invalidOutcome)), ["outcome"]);
});

test("missing required fields are rejected", () => {
  const requiredFields: readonly (keyof MutableAuditEvent)[] = [
    "actor",
    "capability",
    "operation",
    "outcome",
    "sequence",
    "timestampMillis",
  ];

  for (let index = 0; index < requiredFields.length; index += 1) {
    const field = requiredFields[index];

    if (field === undefined) {
      assert.fail("expected required field");
    }

    const event = mutableEvent();
    delete event[field];

    assert.deepEqual(rejectedPaths(validateAuditEvent(event)), [field]);
  }
});

test("fields carrying inline key material are rejected", () => {
  const dataUrlReason = mutableEvent();
  dataUrlReason.reason = "data:text/plain;base64,cmVkYWN0ZWQ=";

  assert.deepEqual(rejectedPaths(validateAuditEvent(dataUrlReason)), ["reason"]);

  const actorSecret = mutableEvent();

  if (actorSecret.actor === undefined) {
    assert.fail("expected actor fixture");
  }

  actorSecret.actor.id = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

  assert.deepEqual(rejectedPaths(validateAuditEvent(actorSecret)), ["actor/id"]);

  const pemReason = mutableEvent();
  pemReason.reason = "-----BEGIN PRIVATE KEY----- redacted -----END PRIVATE KEY-----";

  assert.deepEqual(rejectedPaths(validateAuditEvent(pemReason)), ["reason"]);
});

test("reason is optional but bounded when present", () => {
  const withoutReason = mutableEvent();
  delete withoutReason.reason;

  assert.equal(validateAuditEvent(withoutReason).ok, true);

  const longReason = mutableEvent();
  longReason.reason = "!".repeat(513);

  assert.deepEqual(rejectedPaths(validateAuditEvent(longReason)), ["reason"]);
});

test("isMonotonic returns true only for strictly increasing sequences", () => {
  assert.equal(
    isMonotonic([
      { ...validEvent(), sequence: 0 },
      { ...validEvent(), sequence: 1 },
      { ...validEvent(), sequence: 3 },
    ]),
    true,
  );

  assert.equal(
    isMonotonic([
      { ...validEvent(), sequence: 0 },
      { ...validEvent(), sequence: 1 },
      { ...validEvent(), sequence: 1 },
    ]),
    false,
  );

  assert.equal(
    isMonotonic([
      { ...validEvent(), sequence: 2 },
      { ...validEvent(), sequence: 1 },
    ]),
    false,
  );
});

test("hostile and partial inputs fail closed through safeNormalize without throwing", () => {
  const cyclic: Record<string, unknown> = mutableEvent();
  cyclic.self = cyclic;

  const accessor: Record<string, unknown> = {};
  let getterReads = 0;
  Object.defineProperty(accessor, "sequence", {
    enumerable: true,
    get() {
      getterReads += 1;
      throw new Error("getter should not be read");
    },
  });

  const hostileIterator: unknown[] = [];
  let iteratorReads = 0;
  Object.defineProperty(hostileIterator, Symbol.iterator, {
    enumerable: true,
    get() {
      iteratorReads += 1;
      throw new Error("iterator should not be read");
    },
  });

  const inputs: readonly unknown[] = [
    null,
    "audit-event",
    [],
    cyclic,
    accessor,
    hostileIterator,
    new Date(),
    new Map(),
    new Proxy({}, {}),
    {
      sequence: 1,
      timestampMillis: 1_717_171_717_000,
    },
  ];

  for (let index = 0; index < inputs.length; index += 1) {
    assertRejected(inputs[index]);
  }

  assert.equal(getterReads, 0);
  assert.equal(iteratorReads, 0);
});

function validEvent(): AuditEvent {
  return {
    actor: {
      id: "agent:planner",
      kind: "agent",
    },
    capability: "system.hostname",
    operation: "apply",
    outcome: "committed",
    reason: "hostname applied",
    sequence: 1,
    timestampMillis: 1_717_171_717_000,
  };
}

function mutableEvent(): MutableAuditEvent {
  const event = validEvent();

  return {
    actor: {
      id: event.actor.id,
      kind: event.actor.kind,
    },
    capability: event.capability,
    operation: event.operation,
    outcome: event.outcome,
    ...(event.reason === undefined ? {} : { reason: event.reason }),
    sequence: event.sequence,
    timestampMillis: event.timestampMillis,
  };
}

function rejectedPaths(result: AuditEventValidationResult): readonly string[] {
  if (result.ok) {
    assert.fail(`expected validation to fail: ${JSON.stringify(result.value)}`);
  }

  return result.errors.map((error) => error.path).sort();
}

function assertRejected(value: unknown): void {
  let errors: readonly ValidationError[] | undefined;

  assert.doesNotThrow(() => {
    const result = validateAuditEvent(value);

    if (result.ok) {
      assert.fail(`expected validation to fail: ${JSON.stringify(result.value)}`);
    }

    errors = result.errors;
  });

  assert.notEqual(errors, undefined);
}

interface MutableAuditActorRef extends Record<string, unknown> {
  id?: string;
  kind?: string;
}

interface MutableAuditEvent extends Record<string, unknown> {
  actor?: MutableAuditActorRef;
  capability?: string;
  operation?: string;
  outcome?: string;
  reason?: string;
  sequence?: number;
  timestampMillis?: number;
}
